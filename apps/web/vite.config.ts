import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, allowedHosts: ['.localhost', 'localhost'] },
  preview: { port: 4173, allowedHosts: ['.localhost', 'localhost'] },
  build: { sourcemap: true, chunkSizeWarningLimit: 1200 },
});
