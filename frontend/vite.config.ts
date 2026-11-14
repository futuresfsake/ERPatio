import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// In development the Vite server proxies /api to the Express API, so the browser only ever talks to
// one origin, exactly as in production (Express serves this build). That keeps the refresh cookie first-party.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:8000' } },
  build: { sourcemap: false, target: 'es2022' },
  test: { environment: 'node' },
});
