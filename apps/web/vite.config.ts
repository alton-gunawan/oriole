import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Env dibaca dari root monorepo (satu .env, konsisten dengan loadRootEnv API).
  envDir: '../..',
  server: {
    port: 5173,
    proxy: {
      // Dev: kirim request API ke backend Hono tanpa CORS.
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
