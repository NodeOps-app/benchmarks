import '../src/env.js';
import { parseArgs } from 'node:util';
import { providers } from './providers.js';
import { printDaxReport, runDaxBenchmark } from './dax-runner.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      provider: { type: 'string', default: 'createos' },
      iterations: { type: 'string', default: '1' },
    },
  });
  const provider = providers.find(provider => provider.name === values.provider);
  if (!provider) throw new Error(`Unknown provider: ${values.provider}`);
  const results = await runDaxBenchmark(provider, Number(values.iterations));
  printDaxReport(provider.name, results);
  if (results.some(result => result.error)) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
