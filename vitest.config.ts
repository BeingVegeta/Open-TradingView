import { defineConfig } from 'vitest/config';

// Run every test in a non-Indian timezone so that any accidental use of the
// machine's local time (instead of explicit IST) shows up as a failure.
// Workers inherit this from the main process.
process.env.TZ = 'America/New_York';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          root: './packages/shared',
          environment: 'node',
        },
      },
      {
        test: {
          name: 'server',
          root: './apps/server',
          environment: 'node',
        },
      },
    ],
  },
});
