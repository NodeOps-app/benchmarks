import { defineTask } from '../../bench-config.js';

// Intentionally exports no `config` — used to assert the CLI rejects it.
export const task = defineTask(async () => {});
