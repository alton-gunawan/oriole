import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Dummy env sebelum modul apa pun di-import — mencegah flake env di
    // worker pertama (lihat src/test-setup.ts).
    setupFiles: ['src/test-setup.ts'],
    server: {
      deps: {
        // Workspace packages (TS source) harus di-transform oleh Vite.
        inline: [/@oriole\//],
      },
    },
  },
});
