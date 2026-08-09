import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const apiPort = process.env.FOLIO_PORT ?? '4780'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // 'prompt' rather than 'autoUpdate', and NOT because we prompt - registerSW.ts
      // never wires a refresh callback, so an update installs silently and takes
      // effect on the next launch.
      //
      // The reason is that 'autoUpdate' FORCES workbox.skipWaiting and clientsClaim
      // to true and ignores any attempt to set them false. That combination activates
      // a new worker immediately and claims already-open pages, while
      // cleanupOutdatedCaches deletes the previous precache - leaving a running page
      // holding the OLD build's code with its lazy chunks gone from both the cache and
      // the CDN. Unote lazy-loads a lot (Ketcher, three.js, transformers.js, pdfjs),
      // so the next 'Insert -> Chemistry' after a deploy would simply fail.
      registerType: 'prompt',
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
