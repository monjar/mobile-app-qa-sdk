import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'plugin/test/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
});
