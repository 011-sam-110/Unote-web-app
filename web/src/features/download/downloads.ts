/**
 * Where the installers live, and which one to offer first.
 *
 * Extracted from DownloadPage so the landing page's desktop band can use the same URLs and
 * the same detection without importing a whole page component into the landing chunk. Two
 * places offering downloads is a product decision; two copies of the filenames would be a
 * bug waiting for the next rename.
 *
 * GitHub serves a permanent redirect at `/releases/latest/download/<asset>`, but only while
 * the asset name is stable from release to release - which is exactly why electron-builder.yml
 * drops `${version}` from `artifactName`. These strings are pinned to that config: rename an
 * artifact there without renaming it here and the buttons 404. The same URLs appear once more,
 * in the JSON-LD in web/download.html, because a static head cannot import a constant.
 *
 * THREE assets, not two. `Unote-${arch}.${ext}` puts the architecture in the macOS filename,
 * and the release workflow builds both: macos-latest is an Apple silicon runner, so left to
 * itself it would emit the arm64 build alone and every Intel Mac would download something that
 * cannot open. Which of the two a visitor needs is a question the browser cannot answer - the
 * user-agent string says "Intel Mac OS X" on both - so the page asks them rather than guessing.
 */
export const DOWNLOAD_URLS = {
  windows: 'https://github.com/011-sam-110/Folio/releases/latest/download/Unote-Setup.exe',
  macAppleSilicon: 'https://github.com/011-sam-110/Folio/releases/latest/download/Unote-arm64.dmg',
  macIntel: 'https://github.com/011-sam-110/Folio/releases/latest/download/Unote-x64.dmg',
} as const;

/** The two operating systems, which is the choice a visitor can actually be offered. */
export type PlatformId = 'windows' | 'mac';

export const PLATFORMS: Record<
  PlatformId,
  { name: string; url: string; file: string; detail: string }
> = {
  windows: {
    name: 'Windows',
    url: DOWNLOAD_URLS.windows,
    file: 'Unote-Setup.exe',
    detail: 'Windows 10 and later, 64-bit',
  },
  mac: {
    // The headline macOS button is the Apple silicon build, because that is what almost every
    // Mac sold since 2020 is. Intel is a labelled link beside it rather than a fourth button:
    // it is a smaller question than "which operating system", and it should read that way.
    name: 'macOS',
    url: DOWNLOAD_URLS.macAppleSilicon,
    file: 'Unote-arm64.dmg',
    detail: 'Apple silicon (M1 and later)',
  },
};

/**
 * Which installer to put first.
 *
 * A convenience and nothing more. Every download stays reachable whatever this returns, and
 * nothing is ever hidden behind it, because every user-agent guess is wrong for somebody - a Mac
 * told to pretend it is Windows, a Chromebook, a phone, a browser that froze its UA string years
 * ago. Getting it wrong should cost a reader one glance at the next button, not the download.
 *
 * Returns null when it genuinely cannot tell, and null renders both platforms as equals rather
 * than guessing on a coin toss.
 */
export function detectPlatform(): PlatformId | null {
  if (typeof navigator === 'undefined') return null;

  // userAgentData.platform is the modern signal and is not frozen the way the UA string is.
  // Safari and Firefox do not implement it, so the string stays as the fallback.
  const hint = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
    ?.platform;
  const source = `${hint ?? ''} ${navigator.userAgent}`.toLowerCase();

  if (source.includes('win')) return 'windows';
  if (source.includes('mac')) {
    // An iPad reports itself as a Macintosh and has done since iPadOS 13. It cannot run a .dmg,
    // so offering it one is worse than offering it nothing; maxTouchPoints is the only reliable
    // way to tell the two apart.
    if (navigator.maxTouchPoints > 1) return null;
    return 'mac';
  }
  return null;
}
