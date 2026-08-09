// Service worker registration.
//
// This lives in its own module rather than inline in index.html on purpose: that
// file's inline <script> is allowed by a pinned sha256 hash (server/src/lib/csp.ts,
// vercel.json), so adding a character to it breaks the CSP in production with no
// symptom but a wrong-theme first paint.
//
// Registration is deliberately quiet. A failure here costs offline support, not
// the session, so it must never surface as an error to someone taking notes.
import { registerSW } from 'virtual:pwa-register';

export function registerServiceWorker(): void {
  if (import.meta.env.DEV) return; // the dev server has no built assets to cache
  try {
    registerSW({ immediate: true });
  } catch {
    // No offline support this session. Nothing else changes.
  }
}
