#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

function scaffold(targetDir: string, projectName: string): void {
  fs.mkdirSync(targetDir, { recursive: true });

  const packageJson = {
    name: projectName,
    version: '0.0.0',
    private: true,
    type: 'module',
    scripts: {
      bench: 'tsx bench.ts',
      typecheck: 'tsc --noEmit',
    },
    dependencies: {
      '@benchsdk/client': '^0.2.0',
    },
    devDependencies: {
      tsx: '^4.22.4',
      typescript: '^5.0.0',
    },
  };

  fs.writeFileSync(
    path.join(targetDir, 'package.json'),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );

  const tsconfigJson = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      noEmit: true,
    },
    include: ['**/*.ts'],
  };

  fs.writeFileSync(
    path.join(targetDir, 'tsconfig.json'),
    `${JSON.stringify(tsconfigJson, null, 2)}\n`,
  );

  const benchTs = `import { defineStep, defineTask, defineWorker } from '@benchsdk/client';

const worker = defineWorker({
  benchmarkSlug: process.env.BENCHMARK_SLUG ?? 'scale',
  runId: process.env.BENCHMARK_RUN_ID!,
  participantSlug: process.env.BENCHMARK_PARTICIPANT_SLUG ?? 'local',
  processKind: 'container',
  processKey: process.env.HOSTNAME ?? 'local',
  concurrency: 1,
  task: defineTask('example.lifecycle', [
    defineStep('start', async ({ assignment }) => {
      console.log(\`Worker \${assignment.workerId} starting task \${assignment.taskRange.start}\`);
    }),
    defineStep('work', async () => {
      // Replace with your benchmark logic
      await new Promise((resolve) => setTimeout(resolve, 100));
    }),
    defineStep('done', async () => {
      console.log('Task complete');
    }),
  ]),
});

await worker.run();
`;

  fs.writeFileSync(path.join(targetDir, 'bench.ts'), benchTs);

  const envExample = `# Copy to .env and fill in your values
COMPUTESDK_ADMIN_API_KEY=
BENCHMARK_SLUG=scale
BENCHMARK_RUN_ID=
BENCHMARK_PARTICIPANT_SLUG=local
`;

  fs.writeFileSync(path.join(targetDir, '.env.example'), envExample);

  const readme = `# ${projectName}

This project was scaffolded by [\`create-bench\`](https://github.com/computesdk/benchmarks/tree/master/packages/create-bench).

## Getting started

1. Install dependencies:

   \`\`\`sh
   pnpm install
   \`\`\`

2. Copy \`.env.example\` to \`.env\` and fill in the required values.

3. Run the benchmark worker:

   \`\`\`sh
   pnpm bench
   \`\`\`
`;

  fs.writeFileSync(path.join(targetDir, 'README.md'), readme);
}

async function askProjectName(): Promise<string | undefined> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question('Project name: ');
    return answer.trim() || undefined;
  } finally {
    rl.close();
  }
}

export async function createBench(projectName?: string): Promise<void> {
  const resolvedName = projectName ?? (await askProjectName());

  if (!resolvedName) {
    throw new Error('A project name is required.');
  }

  const targetDir = path.isAbsolute(resolvedName)
    ? resolvedName
    : path.resolve(process.cwd(), resolvedName);
  const packageName = path.basename(targetDir);

  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    throw new Error(`Directory ${targetDir} is not empty.`);
  }

  scaffold(targetDir, packageName);

  console.log(`Created ${packageName} at ${targetDir}`);
  console.log('Next steps:');
  console.log(`  cd ${path.relative(process.cwd(), targetDir) || packageName}`);
  console.log('  pnpm install');
  console.log('  cp .env.example .env');
  console.log('  pnpm bench');
}

async function main(): Promise<void> {
  const projectName = process.argv[2];
  await createBench(projectName);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
