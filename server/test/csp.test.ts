// The CSP is defined once in src/lib/csp.ts but has to be served from two places: Express,
// for single-port local runs, and vercel.json, because the deployed SPA is a static file the
// CDN serves without ever entering Express. Duplication that a human has to remember to keep
// in sync is duplication that drifts, so these tests fail loudly instead.

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { CSP, THEME_SCRIPT_HASH } from '../src/lib/csp.js';
import { ROOT } from '../src/config.js';

const app = buildApp();

/**
 * The body of the one bare inline script in an HTML entry, newlines normalised to LF.
 *
 * The normalisation is the whole trick. On Windows, core.autocrlf checks the file out with
 * CRLF, so hashing the working copy verbatim produced a digest that could never match: the
 * hash that matters is the one the browser computes over the file Vercel builds from, and
 * Vercel checks out LF. Without this, the test failed on every Windows run regardless of the
 * file's contents - and a test that always fails locally is a test nobody reads, which is how
 * a genuine break slips through.
 *
 * The regex matches `<script>` with no attributes, so it skips the JSON-LD block and the
 * module tag in both files and finds only the theme bootstrap.
 */
function inlineThemeScript(entry: string): string {
  const html = fs.readFileSync(path.join(ROOT, 'web', entry), 'utf8').replace(/\r\n/g, '\n');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/);
  expect(inline, `web/${entry} no longer has an inline <script> to hash`).not.toBeNull();
  return inline![1];
}

describe('Content-Security-Policy', () => {
  it('matches the hash of the inline theme script actually shipped in web/index.html', () => {
    // The whole point of hashing that script is to keep 'unsafe-inline' out of script-src.
    // A hash is exact: editing the script, even by a space or a comment, silently stops the
    // browser running it and the app renders in the wrong theme until first paint. If this
    // fails, recompute the hash from the script body and update THEME_SCRIPT_HASH (and the
    // copy in vercel.json).
    const script = inlineThemeScript('index.html');
    const digest = createHash('sha256').update(script, 'utf8').digest('base64');
    expect(THEME_SCRIPT_HASH).toBe(`'sha256-${digest}'`);
  });

  it('ships that same script byte for byte in web/download.html, so one hash covers both entries', () => {
    // /download is a second Vite entry with its own head, and it needs the theme bootstrap for
    // the same reason index.html does - without it, a client-side navigation from /download to
    // /login paints in the wrong theme.
    //
    // It is a COPY, not a shared file: a static head cannot import anything, and the block has
    // to be inline to run before first paint. Identical bytes are what keeps one pinned hash
    // covering both, so this asserts identity rather than merely that each file has some
    // script. A future edit to one and not the other fails here, loudly, instead of shipping a
    // page the browser silently refuses to theme.
    const index = inlineThemeScript('index.html');
    const download = inlineThemeScript('download.html');
    expect(download, 'the two inline theme scripts have drifted apart').toBe(index);

    const digest = createHash('sha256').update(download, 'utf8').digest('base64');
    expect(THEME_SCRIPT_HASH).toBe(`'sha256-${digest}'`);
  });

  it('is served byte-identically from vercel.json, which is what covers the deployed SPA', () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    const rule = vercel.headers?.find((h: { source: string }) => h.source === '/(.*)');
    expect(rule, 'vercel.json lost its blanket header rule').toBeTruthy();

    const header = rule.headers.find((h: { key: string }) => h.key === 'Content-Security-Policy');
    expect(header?.value).toBe(CSP);
  });

  it('sets the header on responses, including the asset paths a worker loads from', async () => {
    // Not just the document: a dedicated worker takes its policy from its own script
    // response, so the transcription worker only gets 'wasm-unsafe-eval' and the
    // huggingface connect-src if this header is on /assets/* too.
    const res = await request(app).get('/api/health');
    expect(res.headers['content-security-policy']).toBe(CSP);
  });

  it('keeps the directives the app depends on, and keeps unsafe-inline out of script-src', () => {
    // Regression guards on the choices that are load-bearing rather than cosmetic.

    // img-src is what closes the exfiltration channel for prompt injection and pasted note
    // HTML: note bodies render <img> with an unrestricted src, so a remote host here would
    // let note content leak through a request URL with no interaction.
    expect(CSP).toContain("img-src 'self' data: blob:");

    // 'unsafe-inline' for styles is a deliberate concession (KaTeX and React style attrs).
    // 'unsafe-inline' for scripts would defeat most of the policy and must never appear.
    expect(CSP).toContain("style-src 'self' 'unsafe-inline'");
    const scriptSrc = CSP.split('; ').find((d) => d.startsWith('script-src '));
    expect(scriptSrc).toBeTruthy();
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'"); // 'wasm-unsafe-eval' is the narrow one
    expect(scriptSrc).toContain("'wasm-unsafe-eval'"); // onnxruntime compiles WebAssembly

    for (const directive of [
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'",
      "default-src 'self'",
    ]) {
      expect(CSP).toContain(directive);
    }

    // The Whisper worker fetches model weights and its wasm runtime cross-origin.
    expect(CSP).toContain('https://huggingface.co');
    expect(CSP).toContain('https://cdn.jsdelivr.net');
  });
});
