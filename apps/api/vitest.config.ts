import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    server: {
      deps: {
        // Workspace packages (TS source) harus di-transform oleh Vite.
        inline: [/@oriole\//],
      },
    },
  },
});
