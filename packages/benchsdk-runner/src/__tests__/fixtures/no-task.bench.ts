import { defineBenchmarkConfig } from '../../bench-config.js';

// Intentionally exports no `task` — used to assert the CLI rejects it.
export const config = defineBenchmarkConfig({
  benchmarkSlug: 'no-task',
  benchmarkName: 'No task',
  iterations: 1,
  participants: [{ name: 'x', requiredEnvVars: ['CLI_TEST_MISSING_VAR'] }],
});
