import { defineConfig } from 'vitest/config';

// Unit tests live in test/ as *.test.ts (run by vitest). The in-browser sync
// harness lives in tests/sync/ as *.spec.ts and is run by Playwright — keep
// vitest out of it so the two runners never pick up each other's files.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['tests/**', 'node_modules/**', 'dist/**'],
  },
});
