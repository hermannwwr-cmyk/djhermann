import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // each dev server can use its own dependency cache (VITE_CACHE_DIR) so parallel servers don't collide
  cacheDir: process.env.VITE_CACHE_DIR ?? 'node_modules/.vite',
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    // multiplayer API (HTTP + WebSocket) → the Worker under `npm run dev:worker`
    proxy: { '/api': { target: 'http://localhost:8787', ws: true } },
  },
  preview: { host: true, port: 4173 },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null, // registered from src/main.ts
      includeAssets: ['icons/*.png', 'icons/*.svg', 'worklets/*.js'],
      manifest: {
        name: 'DJ Hermann',
        short_name: 'DJ Hermann',
        description: 'A DJ turntable rhythm game. Mix the set, hit the pads, move the crowd.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#07060d',
        theme_color: '#07060d',
        categories: ['games', 'music'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2,png,svg,webmanifest}'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
