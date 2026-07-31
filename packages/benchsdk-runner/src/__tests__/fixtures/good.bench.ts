import { defineBenchmarkConfig, defineTask } from '../../bench-config.js';

// A valid declarative benchmark whose single participant requires an env var
// that is never set in tests, so running it env-gates to zero participants and
// raises NoAvailableParticipantsError before any network call.
export const config = defineBenchmarkConfig({
  benchmarkSlug: 'cli-good',
  benchmarkName: 'CLI good fixture',
  iterations: 1,
  participants: [{ name: 'x', requiredEnvVars: ['CLI_TEST_MISSING_VAR'] }],
});

export const task = defineTask(async () => {});
