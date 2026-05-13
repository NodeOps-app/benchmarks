import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { PassThrough } from 'node:stream';
import type { SandboxResult, ProgressStats, FinalStats } from '../types.js';

export interface R2Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class R2Sink {
  private client: S3Client;
  private bucket: string;
  private prefix: string;
  private rawStream: PassThrough;
  private rawUploadDone: Promise<unknown>;

  constructor(config: R2Config, runId: string) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: 'auto',
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    this.bucket = config.bucket;
    this.prefix = `${runId}/`;

    // Multipart streaming upload of raw.jsonl. S3/R2 multipart minimum part
    // size is 5 MiB; lib-storage's Upload buffers internally until that
    // threshold and then uploads parts. Crash-loss window: at most one part
    // worth of records.
    this.rawStream = new PassThrough();
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: `${this.prefix}raw.jsonl`,
        Body: this.rawStream,
        ContentType: 'application/x-ndjson',
      },
      partSize: 5 * 1024 * 1024,
      queueSize: 4,
    });
    this.rawUploadDone = upload.done();
    this.rawUploadDone.catch(() => { /* awaited in close() */ });
  }

  writeResult(result: SandboxResult): void {
    this.rawStream.write(JSON.stringify(result) + '\n');
  }

  async writeHeartbeat(stats: ProgressStats & { ts: string }): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: `${this.prefix}heartbeat.json`,
      Body: JSON.stringify(stats),
      ContentType: 'application/json',
    }));
  }

  async writeMeta(meta: FinalStats & Record<string, unknown>): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: `${this.prefix}meta.json`,
      Body: JSON.stringify(meta, null, 2),
      ContentType: 'application/json',
    }));
  }

  async close(): Promise<void> {
    this.rawStream.end();
    await this.rawUploadDone;
  }
}
