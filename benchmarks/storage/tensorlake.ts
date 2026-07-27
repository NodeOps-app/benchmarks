import { createHash } from 'node:crypto';
import { posix as pathPosix } from 'node:path';
import {
  type Adapter,
  type BodyInput,
  bodyToBytes,
  checkSignal,
  defineAdapter,
  type ForkInfo,
  type ListOptions,
  type ListResult,
  type ReadOnlyAdapter,
  type SnapshotInfo,
  StorageError,
  type StorageErrorCode,
  type StorageItem,
  type StorageItemMeta,
} from '@storagesdk/core/adapter';
import {
  type FileEntry,
  FileNotFoundInFilesystemError,
  type Filesystem,
  FilesystemAPIError,
  FilesystemClient,
  FilesystemNotFoundError,
} from 'tensorlake';

export interface TensorlakeBenchmarkConfig {
  filesystem: string;
  apiKey: string;
  organizationId: string;
  projectId: string;
  apiUrl?: string;
}

interface ForkRecord {
  info: ForkInfo;
  filesystem: Filesystem;
}

const SNAPSHOT_MESSAGE_PREFIX = 'computesdk-benchmark:';

const forkFilesystemName = (parent: string, name: string): string =>
  `computesdk-fork-${createHash('sha256')
    .update(JSON.stringify([parent, name]))
    .digest('hex')
    .slice(0, 32)}`;

function storageErrorCode(status: number): StorageErrorCode {
  if (status === 401 || status === 403) return 'Unauthorized';
  if (status === 404) return 'NotFound';
  if (status === 409) return 'Conflict';
  if (status === 400 || status === 416 || status === 422) {
    return 'InvalidArgument';
  }
  return 'Provider';
}

function asStorageError(error: unknown, path?: string): StorageError {
  if (error instanceof StorageError) return error;

  const cause = error instanceof Error ? error : undefined;
  if (error instanceof FileNotFoundInFilesystemError) {
    return new StorageError({
      code: 'NotFound',
      message: `${error.path} not found`,
      cause,
    });
  }
  if (error instanceof FilesystemNotFoundError) {
    return new StorageError({
      code: 'NotFound',
      message: `filesystem ${error.filesystemName} not found`,
      cause,
    });
  }
  if (error instanceof FilesystemAPIError) {
    return new StorageError({
      code: storageErrorCode(error.statusCode),
      message: error.message,
      cause,
    });
  }
  if (
    error instanceof DOMException && error.name === 'AbortError' ||
    error instanceof Error && 'code' in error && error.code === 'ABORT_ERR'
  ) {
    return new StorageError({ code: 'Aborted', cause });
  }
  return new StorageError({
    code: 'Provider',
    message: cause?.message ?? (path ? `${path} failed` : 'Tensorlake error'),
    cause,
  });
}

function isRetryableVersionConflict(error: unknown): boolean {
  return error instanceof FilesystemAPIError &&
    error.statusCode === 409 &&
    (
      error.message.includes('native filesystem head changed before direct mutation preparation') ||
      error.message.includes('version_conflict') &&
      error.message.includes('"retryable":true')
    );
}

async function publishWithRetry<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const maxAttempts = 24;
  for (let attempt = 1; ; attempt++) {
    checkSignal(signal);
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableVersionConflict(error) || attempt >= maxAttempts) {
        throw error;
      }
      const backoffMs = Math.min(5 * 2 ** Math.min(attempt - 1, 4), 80);
      await new Promise((resolve) =>
        setTimeout(resolve, backoffMs + Math.random() * backoffMs),
      );
    }
  }
}

function dirOf(path: string): string | undefined {
  const dir = pathPosix.dirname(path);
  return dir === '.' ? undefined : dir;
}

function entryMeta(entry: FileEntry): StorageItemMeta {
  return {
    path: entry.path,
    size: entry.size ?? 0,
    contentType: 'application/octet-stream',
    etag: entry.contentId,
    lastModified: new Date(0),
  };
}

async function isUnborn(fs: Filesystem, error: unknown): Promise<boolean> {
  if (asStorageError(error).code !== 'InvalidArgument') return false;
  try {
    return (await fs.status()).versionId === null;
  } catch {
    return false;
  }
}

/**
 * Benchmark-local StorageSDK adapter backed by Tensorlake filesystems.
 *
 * The Tensorlake SDK hashes payloads locally, uploads missing bytes directly to
 * checksum-bound object-store URLs, then atomically publishes the filesystem
 * version. Copy, move, snapshot, and fork operations are metadata-only.
 */
export function tensorlakeBenchmarkAdapter(
  config: TensorlakeBenchmarkConfig,
): Adapter<FilesystemClient> {
  const client = new FilesystemClient({
    apiKey: config.apiKey,
    organizationId: config.organizationId,
    projectId: config.projectId,
    ...(config.apiUrl ? { apiUrl: config.apiUrl } : {}),
  });
  return defineAdapter(buildAdapter(client, config.filesystem));
}

function buildAdapter(
  client: FilesystemClient,
  filesystemName: string,
  version?: string,
  initialFilesystem?: Filesystem,
): Adapter<FilesystemClient> {
  const readOnly = version !== undefined;
  const snapshots = new Map<string, SnapshotInfo>();
  const forks = new Map<string, ForkRecord>();
  let retryTail = Promise.resolve();
  let filesystemPromise: Promise<Filesystem> | undefined = initialFilesystem
    ? Promise.resolve(initialFilesystem)
    : undefined;

  const filesystem = (): Promise<Filesystem> => {
    if (!filesystemPromise) {
      filesystemPromise = client.get(filesystemName).catch((error) => {
        filesystemPromise = undefined;
        throw asStorageError(error);
      });
    }
    return filesystemPromise;
  };

  const ensureWritable = (): void => {
    if (readOnly) {
      throw new StorageError({
        code: 'InvalidArgument',
        message: 'Cannot write through a snapshot reader',
      });
    }
  };

  const findEntry = async (path: string): Promise<FileEntry> => {
    const fs = await filesystem();
    try {
      const entries = await fs.listFiles(dirOf(path), version);
      const found = entries.find(
        (entry) => !entry.isDir && entry.path === path,
      );
      if (found) return found;
    } catch (error) {
      if (!(await isUnborn(fs, error))) throw asStorageError(error, path);
    }
    throw new StorageError({
      code: 'NotFound',
      message: `${path} not found`,
    });
  };

  const adapter: Adapter<FilesystemClient> = {
    name: 'tensorlake',
    raw: client,

    async upload(path, body: BodyInput, opts): Promise<StorageItemMeta> {
      checkSignal(opts?.signal);
      ensureWritable();
      const bytes = await bodyToBytes(body);
      try {
        const fs = await filesystem();
        const published = await publish(
          () => fs.writeFile(path, bytes),
          opts?.signal,
        );
        opts?.onProgress?.({ loaded: bytes.byteLength, total: bytes.byteLength });
        return {
          path,
          size: bytes.byteLength,
          contentType: opts?.contentType ?? 'application/octet-stream',
          etag: published.versionId,
          lastModified: new Date(),
        };
      } catch (error) {
        throw asStorageError(error, path);
      }
    },

    async download(path, opts): Promise<StorageItem> {
      checkSignal(opts?.signal);
      const fs = await filesystem();
      try {
        const read = await fs.readFileWithMetadata(path, {
          ...(version ? { version } : {}),
          ...(opts?.range ? { range: opts.range } : {}),
        });
        const body = new Uint8Array(read.data);
        return {
          path,
          size: body.byteLength,
          contentType: 'application/octet-stream',
          etag: read.contentId,
          lastModified: new Date(0),
          body,
        };
      } catch (error) {
        if (await isUnborn(fs, error)) {
          throw new StorageError({
            code: 'NotFound',
            message: `${path} not found`,
          });
        }
        throw asStorageError(error, path);
      }
    },

    async head(path, opts): Promise<StorageItemMeta> {
      checkSignal(opts?.signal);
      return entryMeta(await findEntry(path));
    },

    async list(opts?: ListOptions): Promise<ListResult> {
      checkSignal(opts?.signal);
      const fs = await filesystem();
      const prefix = opts?.prefix ?? '';
      const cursor = opts?.cursor ?? '';
      const limit = opts?.limit ?? 1000;
      const prefixDir = dirOf(prefix);
      let directories: Array<string | undefined> = [prefixDir];
      const items: StorageItemMeta[] = [];

      while (directories.length > 0) {
        const next: string[] = [];
        for (const dir of directories) {
          checkSignal(opts?.signal);
          let entries: FileEntry[];
          try {
            entries = await fs.listFiles(dir, version);
          } catch (error) {
            if (await isUnborn(fs, error)) continue;
            const mapped = asStorageError(error);
            if (mapped.code === 'NotFound') continue;
            throw mapped;
          }
          for (const entry of entries) {
            if (entry.isDir) next.push(entry.path);
            else items.push(entryMeta(entry));
          }
        }
        directories = next;
      }

      const matching = items
        .filter((item) => item.path.startsWith(prefix) && item.path > cursor)
        .sort((a, b) => a.path.localeCompare(b.path));
      const page = matching.slice(0, limit);
      const last = page.at(-1);
      return last && matching.length > limit
        ? { items: page, cursor: last.path }
        : { items: page };
    },

    async delete(path, opts): Promise<void> {
      checkSignal(opts?.signal);
      ensureWritable();
      try {
        const fs = await filesystem();
        await publish(() => fs.deleteFile(path), opts?.signal);
      } catch (error) {
        const mapped = asStorageError(error, path);
        if (mapped.code !== 'NotFound') throw mapped;
      }
    },

    async copy(from, to, opts): Promise<void> {
      checkSignal(opts?.signal);
      ensureWritable();
      try {
        const fs = await filesystem();
        await publish(() => fs.copyFile(from, to), opts?.signal);
      } catch (error) {
        throw asStorageError(error, from);
      }
    },

    async move(from, to, opts): Promise<void> {
      checkSignal(opts?.signal);
      ensureWritable();
      try {
        const fs = await filesystem();
        await publish(() => fs.moveFile(from, to), opts?.signal);
      } catch (error) {
        throw asStorageError(error, from);
      }
    },

    async url(path, opts): Promise<string> {
      checkSignal(opts?.signal);
      const encodedPath = path
        .split('/')
        .map(encodeURIComponent)
        .join('/');
      const query = version ? `?version=${encodeURIComponent(version)}` : '';
      return `tensorlake://${encodeURIComponent(filesystemName)}/${encodedPath}${query}`;
    },

    async uploadUrl(_path, opts) {
      checkSignal(opts?.signal);
      throw new StorageError({
        code: 'NotSupported',
        message: 'Tensorlake does not expose presigned upload URLs',
      });
    },

    snapshots: {
      async create(opts): Promise<SnapshotInfo> {
        checkSignal(opts?.signal);
        ensureWritable();
        try {
          const native = await (await filesystem()).snapshot(
            `${SNAPSHOT_MESSAGE_PREFIX}${opts?.name ?? ''}`,
          );
          const info: SnapshotInfo = {
            id: native.id,
            createdAt: new Date(),
            ...(opts?.name ? { name: opts.name } : {}),
          };
          snapshots.set(info.id, info);
          return info;
        } catch (error) {
          throw asStorageError(error);
        }
      },

      async list(): Promise<SnapshotInfo[]> {
        return [...snapshots.values()];
      },

      async head(id, opts): Promise<SnapshotInfo> {
        checkSignal(opts?.signal);
        const found = snapshots.get(id);
        if (found) return found;
        throw new StorageError({
          code: 'NotFound',
          message: `snapshot ${id} not found`,
        });
      },

      async delete(id, opts): Promise<void> {
        checkSignal(opts?.signal);
        ensureWritable();
        if (!snapshots.has(id)) {
          throw new StorageError({
            code: 'NotFound',
            message: `snapshot ${id} not found`,
          });
        }
        try {
          await (await filesystem()).deleteSnapshot(id);
          snapshots.delete(id);
        } catch (error) {
          throw asStorageError(error, id);
        }
      },

      get(id): ReadOnlyAdapter {
        const reader = buildAdapter(client, filesystemName, id);
        return {
          download: (path, opts) => reader.download(path, opts),
          head: (path, opts) => reader.head(path, opts),
          list: (opts) => reader.list(opts),
          url: (path, opts) => reader.url(path, opts),
        };
      },
    },

    forks: {
      async create(opts): Promise<ForkInfo> {
        checkSignal(opts.signal);
        ensureWritable();
        if (forks.has(opts.name)) {
          throw new StorageError({
            code: 'Conflict',
            message: `fork ${opts.name} already exists`,
          });
        }
        try {
          const fork = await client.fork(
            forkFilesystemName(filesystemName, opts.name),
            filesystemName,
            opts.fromSnapshot,
          );
          const info: ForkInfo = {
            name: opts.name,
            createdAt: new Date(),
            ...(opts.fromSnapshot
              ? { fromSnapshot: opts.fromSnapshot }
              : {}),
          };
          forks.set(opts.name, { info, filesystem: fork });
          return info;
        } catch (error) {
          throw asStorageError(error);
        }
      },

      async list(): Promise<ForkInfo[]> {
        return [...forks.values()].map(({ info }) => info);
      },

      async head(name, opts): Promise<ForkInfo> {
        checkSignal(opts?.signal);
        const found = forks.get(name);
        if (found) return found.info;
        throw new StorageError({
          code: 'NotFound',
          message: `fork ${name} not found`,
        });
      },

      async delete(name, opts): Promise<void> {
        checkSignal(opts?.signal);
        ensureWritable();
        const found = forks.get(name);
        if (!found) {
          throw new StorageError({
            code: 'NotFound',
            message: `fork ${name} not found`,
          });
        }
        try {
          await client.delete(forkFilesystemName(filesystemName, name));
          forks.delete(name);
        } catch (error) {
          throw asStorageError(error);
        }
      },

      get(name): Adapter<FilesystemClient> {
        const found = forks.get(name);
        if (!found) {
          throw new StorageError({
            code: 'NotFound',
            message: `fork ${name} not found`,
          });
        }
        return buildAdapter(
          client,
          forkFilesystemName(filesystemName, name),
          undefined,
          found.filesystem,
        );
      },
    },
  };

  return adapter;

  async function publish<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let firstAttempt = true;
    return publishWithRetry(async () => {
      if (firstAttempt) {
        firstAttempt = false;
        return operation();
      }

      const result = retryTail.then(operation, operation);
      retryTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }, signal);
  }
}
