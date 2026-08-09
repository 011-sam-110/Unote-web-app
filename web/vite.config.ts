import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const apiPort = process.env.FOLIO_PORT ?? '4780'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // autoUpdate: a new deploy installs in the background and activates on the
      // next launch. No update prompt - the desktop shell has its own, and two
      // competing update notices is one too many.
      registerType: 'autoUpdate',
      injectRegister: null, // registration is ours, in src/registerSW.ts
      workbox: {
        // The app shell only. Model weights and wasm are fetched from
        // huggingface.co / jsdelivr at runtime and must not be precached: they
        // are tens of megabytes and are already allowed by connect-src.
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        // tesseract ships its own worker + training data under /tesseract.
        globIgnores: ['**/tesseract/**', '**/*.wasm'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // SPA deep links resolve to index.html when offline, EXCEPT /api and
        // /uploads which must always hit the network (or fail honestly).
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/uploads\//],
        cleanupOutdatedCaches: true,
      },
      manifest: {
        name: 'Unote',
        short_name: 'Unote',
        description: 'A student notebook.',
        theme_color: '#1c1917',
        background_color: '#faf9f7',
        display: 'standalone',
        start_url: '/',
        icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
    }),
  ],
  server: {
    host: true,
    port: Number(process.env.FOLIO_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': `http://localhost:${apiPort}`,
      '/uploads': `http://localhost:${apiPort}`,
    },
  },
})
