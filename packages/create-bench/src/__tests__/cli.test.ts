import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBench } from '../index';

describe('create-bench CLI', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-bench-test-'));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('scaffolds the expected files', async () => {
    await createBench(tempDir);

    const expectedFiles = [
      'package.json',
      'bench.ts',
      'tsconfig.json',
      '.env.example',
      'README.md',
    ];

    for (const file of expectedFiles) {
      expect(fs.existsSync(path.join(tempDir, file))).toBe(true);
    }

    const pkg = JSON.parse(
      fs.readFileSync(path.join(tempDir, 'package.json'), 'utf8'),
    );

    expect(pkg.name).toBe(path.basename(tempDir));
    expect(pkg.dependencies['@benchsdk/client']).toBe('^0.2.0');
  });
});
