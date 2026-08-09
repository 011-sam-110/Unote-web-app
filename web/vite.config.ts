import { resolve } from 'node:path'
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
        //
        // That includes /download, which has its own HTML entry: once the worker is
        // installed, a navigation there is answered with index.html from the precache
        // rather than with download.html. LEAVE IT. React Router reads location.pathname
        // and renders the same page, so a visitor sees no difference, and the head only
        // matters to crawlers and link unfurlers - neither of which has a service worker,
        // so both get the real file. Adding /download to navigateFallbackDenylist to
        // "fix" it would trade an invisible non-problem for a route that stops working
        // offline, which is the one thing the worker is here for.
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
  build: {
    rollupOptions: {
      // Two HTML entries, because /download has to exist as a real file with its own head.
      // vercel.json rewrites every non-API path to /index.html, so a client-only /download
      // would serve the homepage's title, description, canonical and JSON-LD to every
      // crawler that runs no JavaScript - which is all the ones this project's static head
      // was written for. Vite builds multi-page apps natively; a prerender plugin would put
      // a headless browser in the build to generate one file.
      //
      // Naming an entry here REPLACES the default single index.html input, so index.html has
      // to be listed too. Dropping it produces a build with no homepage.
      input: {
        main: resolve(__dirname, 'index.html'),
        download: resolve(__dirname, 'download.html'),
      },
    },
  },
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
