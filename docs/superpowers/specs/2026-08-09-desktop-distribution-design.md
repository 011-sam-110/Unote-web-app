# Desktop distribution and the /download page

**Date:** 2026-08-09
**Branch:** `feat/desktop-distribution`, cut from `feat/offline-desktop`
**Supersedes nothing.** Builds directly on `2026-08-09-offline-desktop-design.md`, which
specced the Electron shell this document ships.

## The problem

`feat/offline-desktop` built a real Electron shell - `desktop/main.ts`, a service worker, a
Dexie mirror and a sync engine - and then stopped one step short of anyone being able to use
it. Concretely:

- **No build has ever run.** There is no `release/` directory and no GitHub release. The
  desktop app exists only as source.
- **The update feed points at nothing.** `electron-builder.yml` uses
  `publish: generic, url: https://unote-six.vercel.app/desktop`. That path has never existed.
  The offline-desktop spec already recorded the consequence: on first launch the updater
  fetched `/desktop/latest.yml`, Vercel answered with the SPA's HTML, and the YAML parser
  threw.
- **The website does not mention the desktop app at all,** so even a working installer would
  be undiscoverable.
- **The desktop app opens onto the marketing page.** `desktop/main.ts` calls
  `loadURL('https://unote-six.vercel.app')`, and `RootRoute` in `web/src/main.tsx` renders
  `<LandingPage/>` for anyone without a session. A user who has already installed the app is
  therefore pitched the product inside the product - highlighter swipe, "Start writing, it's
  free", the lot.

## Decisions taken

Settled with the owner before design:

| Question | Decision |
|---|---|
| Where installers live | **GitHub Releases.** `011-sam-110/Folio` is public, so release assets are free public downloads and `electron-updater` has a first-class `github` provider. |
| Platforms | **Windows and macOS.** Both unsigned for now. |
| Desktop signed-out screen | **The existing `/login` page**, with the guest door kept as a secondary link. |
| Where the download lives on the site | **A dedicated `/download` route**, not a section on the landing page. |

## Part A - making a release exist

### A1. You cannot build a `.dmg` on Windows

electron-builder needs macOS to produce macOS targets, and Sam's machine is Windows. Shipping
both platforms therefore requires CI; it is not a local command. This is the load-bearing
consequence of the "Windows and macOS" decision and the reason Part A is a workflow rather
than a one-line script change.

`.github/workflows/desktop-release.yml`:

- Trigger: pushing a tag matching `v*`. Not `on: push` to a branch - a release should be a
  deliberate act with a version number attached, and the tag *is* that act.
- Matrix over `windows-latest` and `macos-latest`.
- Each job: checkout, `setup-node` with npm cache, `npm ci`, then
  `npm run desktop:build -- --publish always`.
- Auth: the workflow's built-in `GITHUB_TOKEN` exposed as `GH_TOKEN`, which is what
  electron-builder's GitHub provider reads. This also sidesteps the fact that Sam's local `gh`
  CLI has been returning 401 since his token expired on 2026-08-07 - CI never touches it.
- Permissions: `contents: write`, required to create the release and upload assets.

Both jobs publish into the same draft release, keyed by version. The release is published by
hand once both platforms have uploaded, so the website never links to a half-populated release.

### A2. `electron-builder.yml` changes

Replace the dead generic provider:

```yaml
publish:
  provider: github
  owner: 011-sam-110
  repo: Folio
```

Drop `${version}` from the artifact names:

```yaml
win:
  artifactName: Unote-Setup.${ext}          # was Unote-Setup-${version}.${ext}
mac:
  artifactName: Unote-${arch}.${ext}        # was Unote-${version}-${arch}.${ext}
```

**Why:** GitHub serves a permanent redirect at
`https://github.com/<owner>/<repo>/releases/latest/download/<asset-name>`, but only if the
asset name is stable across releases. A versioned filename would force the download page to
know the current version, which means either hardcoding a string that goes stale the moment a
release ships, or a runtime call to the GitHub API - a new `connect-src` entry in the CSP and a
network round trip before a button works. A stable name makes the download links pure static
hrefs.

**RESOLVED during implementation. The conclusion holds; the reasoning above it did not.**

An earlier draft of this spec said the updater was unaffected "because it reads `latest.yml`".
That is wrong. `latest.yml` decides *which file* to fetch and has nothing to do with the
differential path. `Provider.getBlockMapFiles` derives the PREVIOUS build's blockmap URL by
string-replacing the new version with the old one **inside the URL path** - so a filename with
no version in it is exactly the thing that should break it.

It survives because `GitHubProvider` builds the path as
`.../releases/download/${tag}/${fileName}`: the version still exists in the **tag segment**, so
the substitution has something to bite on. Verified by exercising the installed
electron-updater 6.8.9 against our real filenames - the old and new blockmap URLs come out
distinct and correctly tagged. `releases/latest/download/` was confirmed to resolve for a
`.dmg` as well as an `.exe` against a live public release (302 → 302 → 200).

**The trap this leaves behind:** static artifact names are safe *only* while the provider is
`github`. Switching back to a `generic` provider would make the old and new blockmap URLs
identical, silently degrading every differential update to a full download. There is a comment
in `electron-builder.yml` saying so.

### A2b. macOS produces TWO artifacts, and that is not optional

`macos-latest` is now an arm64 runner, and electron-builder defaults to the host architecture.
Left alone, the config would have published a single Apple-silicon build, and every Intel Mac
would have downloaded an app that cannot open. `electron-builder.yml` therefore declares
`arch: [x64, arm64]` explicitly, producing `Unote-arm64.dmg` and `Unote-x64.dmg`.

Both arches must come out of **one** electron-builder invocation - they share a single
`latest-mac.yml`, so splitting them across matrix jobs would have the second overwrite the
first. Keeping the literal `arm64` substring in the filename is also load-bearing:
`MacUpdater.filterFilesForArch` selects the update by testing the URL for it.

### A2c. The tag must match `package.json`

electron-builder's GitHub publisher derives the release tag from `package.json`, not from the
tag that triggered the run. Tagging `v0.2.0` while `package.json` says `0.1.0` would publish
green into a draft for `v0.1.0`. The workflow has a guard step that fails before building if
the two disagree. **`package.json` is currently `0.1.0`, so the first release tag must be
`v0.1.0` unless the version is bumped first.**

### A3. Both builds are unsigned, and the page must say so

- **Windows:** SmartScreen shows an "unrecognised app" prompt; the user has to click "More
  info" then "Run anyway". A code-signing certificate is roughly £200/yr.
- **macOS:** worse than this spec originally claimed, and worth escalating rather than burying.
  An earlier draft said "right-click the app and choose Open". That advice is correct for an app
  that is validly **signed but not notarised**. With no signing identity configured,
  electron-builder 25.x skips signing **entirely**, so the app is unsigned - and on Apple
  silicon an unsigned app reports "Unote is damaged and can't be opened", which right-click →
  Open does **not** clear. The user needs System Settings → Privacy & Security → Open Anyway, or
  `xattr -cr /Applications/Unote.app`. Notarisation requires a $99/yr Apple Developer account.
  `mac.identity: "-"` (ad-hoc signing) is not a safe shortcut: it is reported to break launch
  when combined with `hardenedRuntime: true`, which this config sets.

  **Unverified on hardware.** Nobody on this project owns a Mac. The above is read out of
  electron-builder's source and Apple's documented behaviour, not observed. It is the single
  biggest reason to consider shipping Windows first and holding macOS until someone can test a
  real build - a download that cannot be opened at all is materially worse than one that shows
  a warning.

The download page states both plainly, next to the button, before the click. A student who hits
an unexplained "Windows protected your PC" dialog concludes the software is malware and leaves;
one who was told to expect it does not. This is not a disclaimer to bury - it is the difference
between the download working and not working.

## Part B - the `/download` page

### B1. The problem a client-rendered route would create

The site is a Vite SPA. `vercel.json` rewrites every non-API path to `/index.html`. If
`/download` were just another React Router route, then every crawler that does not execute
JavaScript - which per this repo's own SEO notes is GPTBot, ClaudeBot and PerplexityBot, the
exact audience the static head was written for - would fetch `/download` and receive the
homepage's `<title>`, description, canonical and JSON-LD. The page would be indexed, if at all,
as a duplicate of `/`. Since the point of a dedicated route rather than a landing-page section
is discoverability, that failure mode would defeat the whole decision.

### B2. The fix: a second Vite entry, not a prerender toolchain

Vite builds multi-page apps natively. Add `web/download.html` as a second Rollup input:

```ts
build: {
  rollupOptions: {
    input: {
      main: resolve(__dirname, 'index.html'),
      download: resolve(__dirname, 'download.html'),
    },
  },
},
```

`download.html` carries its own real `<head>`: its own `<title>`, description,
`<link rel="canonical" href="https://unote-six.vercel.app/download">`, its own OG and Twitter
tags, and a `SoftwareApplication` JSON-LD block with `operatingSystem: "Windows, macOS, Web
browser"`, `downloadUrl`, and `softwareVersion`. It then loads the same `/src/main.tsx`, so the
React app mounts and renders the interactive page on top.

Chosen over the alternatives because:

- **vs. a prerender plugin** (puppeteer/`vite-plugin-prerender`): a whole headless-browser step
  in the build to generate two files, one of which barely changes.
- **vs. server-side head injection**: Vercel's CDN serves the static SPA without entering
  Express, so Express could not inject anything. It would need a rewrite to a function, which
  puts a serverless invocation in front of a static page.

`vercel.json` gains a rewrite, placed **before** the SPA catch-all so it wins:

```json
{ "source": "/download", "destination": "/download.html" }
```

### B3. Two traps this must not fall into

**The CSP hash.** `web/index.html` contains an inline theme-bootstrap script allowed by a
`sha256-` hash pinned in *both* `vercel.json` and `server/src/lib/csp.ts`. `download.html` needs
that same script - without it, a client-side navigation from `/download` to `/login` renders in
the wrong theme. Copy the block **byte for byte**. Identical bytes produce an identical digest,
so no hash changes and neither pinned copy is touched. `server/test/csp.test.ts` currently hashes
`web/index.html` only; extend it to assert both files contain the identical script, so a future
edit to one and not the other fails loudly rather than shipping a page the browser refuses to
theme.

**The service worker.** `vite.config.ts` sets `navigateFallback: '/index.html'`, so once the SW
is installed, a navigation to `/download` is served `index.html` from precache rather than
`download.html`. This is harmless in practice - React Router reads `location.pathname` and
renders the same page - and it does not affect crawlers or link unfurlers, which have no service
worker and get the real file. Worth a comment in `vite.config.ts` so the next person does not
"fix" it by adding a denylist entry and lose the offline fallback for that route.

### B4. What the page says

Three blocks. The whole job of the copy is to make "there is a desktop app" and "you do not need
it" sit together without either undercutting the other.

1. **Download.** OS-detected primary button, with the other platform as a quiet secondary link
   and both always reachable - detection is a convenience, never a gate. Beneath it, the
   unsigned-build note from A3, per platform.

   **On macOS there are two builds and the browser cannot choose between them.** The user-agent
   string reports "Intel Mac OS X" on Apple silicon too, so architecture detection is not
   possible and must not be attempted. A macOS visitor gets **Apple silicon (M1 and later)** as
   the primary button and **Intel** as a labelled secondary link beside it - named the way a
   person recognises their own machine, never by filename or arch string.
2. **What the app actually adds.** Honest, because the service worker on this branch means the
   *web* app works offline too. The desktop app is not "the offline one". What it genuinely adds:
   its own window and icon rather than a browser tab, launching without opening a browser first,
   and updating itself.
3. **The web version.** Stated as an equal option, not a fallback: no install, same account, same
   notes, both work offline. With a direct link into the app.

Reuses the marketing palette and `Wordmark`, and the existing `MarketingNav` so the page is
navigable back to `/`.

### B5. Entry points

`MarketingNav` gains a "Download" link, and `ClosingCta` a secondary line pointing at it. The
landing page keeps its hero exactly as it is.

## Part C - the desktop app stops showing the hero

One condition in `RootRoute` (`web/src/main.tsx`), before the landing branch:

```tsx
if (!user && !guest && pathname === '/') {
  return window.unoteDesktop?.isDesktop ? <LoginPage /> : <LandingPage />
}
```

`desktop/preload.ts` already exposes `unoteDesktop.isDesktop` over `contextBridge`, so this needs
no new bridge, no new IPC and no change to the Electron main process. The flag is a fact about
the host, which is exactly what that preload was written to carry.

The guest door stays as a secondary link on that screen. Removing it would leave a first-run
desktop user with no account facing a form and nothing else - the web landing's whole argument
is that you should be able to type before you register, and the desktop app is the surface where
someone has already committed *more*, not less.

Untouched: web `/` keeps the hero; signed-in routing is unchanged; logout already returns to `/`,
which under this change is the login screen in the desktop app and the landing page on the web.

A type declaration for `window.unoteDesktop` goes in `web/src/vite-env.d.ts` alongside the
existing ambient declarations.

## Part D - sitemap and robots

Delegated to two parallel agents on this branch. Scope:

- **`scripts/build-sitemap.mjs`** generating `web/public/sitemap.xml` from a declared route
  table, with `lastmod` derived from real git commit dates rather than invented. The existing
  hand-written file's own comment asks for exactly this once there is more than one URL, and
  `/download` is the second. Indexable set: `/` and `/download`.
- **`web/public/robots.txt`** kept allow-all - it already is; the only `Disallow` lines cover
  account and single-use surfaces and they stay. Refinement plus one real fix: **`/try` is a
  public route that creates a guest session and seeds a note as a side effect, and it is
  currently in neither robots.txt nor vercel.json's `X-Robots-Tag` rules.** Non-JS crawlers are
  harmless there, but Googlebot renders JavaScript.

The agents were briefed on robots.txt group-matching semantics, because the obvious way to
"explicitly allow AI crawlers" - adding named `User-agent: GPTBot` groups - would exempt those
bots from every `Disallow` above and open `/login`, `/try` and `/join/` to them.

## Verification

Nothing in this spec is considered done on a green exit code. Per this project's own history: a
capture harness once reported "78 screenshots captured, 0 failed" and all 78 were pictures of the
login form.

| What | How |
|---|---|
| CSP still intact | `npx vitest run test/csp.test.ts --root server` - expect 4 passing, plus the new both-files assertion |
| `/download` has a real static head | `curl -s https://<deploy>/download \| head -40` and read the title and canonical with your eyes. A JS-disabled browser must show the download links. |
| Desktop root is the login screen | New Playwright spec injecting `window.unoteDesktop = { isDesktop: true }` via `addInitScript`, asserting `/` renders the login form and not `.mkt-hero` |
| Web root is unchanged | `e2e/auth.spec.ts` and `e2e/landing-motion.spec.ts` both assert against the landing page and must still pass unmodified |
| The new page does not break the landing sweep | `node scripts/verify-landing.mjs` - it checks no horizontal overflow and no console errors at 1440x900 and 390x844 |
| The installers actually install | Manually, on both platforms. Download from the published release, run it, sign in, kill the network, confirm notes still open. |
| The updater resolves | Confirm `latest.yml` and `latest-mac.yml` are present as release assets and that a packaged build checks for updates without throwing |

## Risks and open items

- **`gh` is 401 locally** (token expired 2026-08-07). CI does not care, but tagging and
  publishing the release by hand will need `gh auth login` first.
- **Unsigned builds will suppress conversions** no matter how well the warning is worded. If the
  desktop app matters commercially, Windows signing is the cheaper of the two certificates.
- **This branch is 51 commits ahead of `main` and unmerged.** The `/download` page advertises a
  desktop app, so the website change must not deploy before a release exists - which is a
  reason to land Parts A-D together, not a reason to split them.
- **The macOS build is untested on real hardware.** Nobody here has a Mac. The CI job will prove
  it compiles and packages; it will not prove it launches.
