# Cutting a desktop release

The order below is not arbitrary. **The release must exist before the website deploys**,
because `/download` links at `releases/latest/download/...` - ship the page first and every
download button 404s for however long the build takes.

## 0. Before the first release only

- **`gh auth login`.** The local token expired on 2026-08-07 and everything `gh` returns
  401. CI does not use it - the workflow uses its own `GITHUB_TOKEN` - but publishing the
  draft by hand does.
- **Decide macOS.** Both builds are unsigned. Windows shows a SmartScreen warning that
  users can click through. macOS is worse: with no signing identity electron-builder skips
  signing entirely, and an unsigned app on Apple silicon reports *"Unote is damaged and
  can't be opened"*, which right-click → Open does **not** clear - it needs System Settings
  → Privacy & Security → Open Anyway, or `xattr -cr`. That is read from electron-builder's
  source and Apple's documented behaviour, **not observed on hardware** - nobody on this
  project owns a Mac. If you would rather not ship a download that many people cannot open,
  drop `macos-latest` from the matrix in `.github/workflows/desktop-release.yml` and remove
  the macOS links from `web/src/features/download/DownloadPage.tsx`. It is a small change.

## 1. Check the version

electron-builder derives the release tag from `package.json`, **not** from the tag you
push. They must match or the workflow fails on purpose, before building.

```bash
node -p "require('./package.json').version"   # 0.1.0
```

So the first tag is `v0.1.0`. To release a different number, bump `package.json` and commit
that first.

## 2. Tag and push

```bash
git tag v0.1.0
git push origin v0.1.0
```

Nothing else triggers the workflow. Merging to main does not build installers.

## 3. Watch both jobs

```bash
gh run watch
```

`windows-latest` and `macos-latest` publish into the **same draft release**. That is safe
rather than a race - whichever job loses, electron-publish handles GitHub's `422
already_exists` and re-fetches the release the other created. `fail-fast` is off, so one
platform failing leaves the other's assets intact.

Expect these assets:

| File | What |
| --- | --- |
| `Unote-Setup.exe` | Windows installer |
| `Unote-arm64.dmg` | macOS, Apple silicon |
| `Unote-x64.dmg` | macOS, Intel |
| `Unote-arm64.zip`, `Unote-x64.zip` | required by electron-updater on macOS |
| `latest.yml`, `latest-mac.yml` | the update feeds |

If `latest.yml` is missing, the updater will not work and there is no point publishing.

## 4. Publishing is automatic

A third job, `publish`, does it. It `needs: build`, so it cannot run until **both**
platforms have succeeded - the guard the draft existed to provide. It then refuses to
publish unless `Unote-Setup.exe`, `latest.yml` and `latest-mac.yml` are all attached,
because installers without an update feed work once and then never update again, and
that is only discovered months later.

If one platform fails, `publish` does not run and you are left with a draft to inspect
rather than a half-populated public release. Fix the failing job, re-run it, and the
publish job follows.

To publish a stuck draft by hand you need a working `gh` login:

```bash
gh release edit v0.1.0 --draft=false
```

## 5. Prove the links resolve before shipping the page

```bash
for a in Unote-Setup.exe Unote-arm64.dmg Unote-x64.dmg; do
  echo -n "$a -> "
  curl -s -o /dev/null -w "%{http_code}\n" -IL \
    "https://github.com/011-sam-110/Folio/releases/latest/download/$a"
done
```

All three must end in `200`. These are the exact URLs the download page uses, pinned to
`artifactName` in `electron-builder.yml` - rename an artifact and you must change both.

## 6. Now deploy the website

Merge the branch to `main`. Only now does `/download` point at something real.

## 7. Afterwards

- Install on a real Windows machine, sign in, cut the network, confirm notes still open.
- Same on a Mac if you can borrow one - that path has never been executed.
- Subsequent releases: bump `package.json`, commit, tag, push. The updater takes it from
  there; users do not download a second installer.

## Rolling back

Deleting a release is enough to stop new downloads, but **clients that already installed
will keep checking `latest.yml`**. To pull a bad version back, publish a higher version
containing the previous good build rather than deleting - a deleted release makes the
updater 404 rather than downgrade.
