import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// doc01 HUB-191: dev server must be HTTPS (camera access needs a secure context) and
// proxies /api + /socket.io to the Hub Server's deviceApp.
const HUB_ORIGIN = process.env.HUB_ORIGIN ?? 'https://localhost:8443';

export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    https: true,
    proxy: {
      '/api': { target: HUB_ORIGIN, changeOrigin: true, secure: false },
      '/socket.io': { target: HUB_ORIGIN, changeOrigin: true, secure: false, ws: true },
    },
  },
  build: {
    outDir: 'dist',
  },
});
