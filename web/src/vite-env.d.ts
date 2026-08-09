/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * What the Electron shell hands the page.
 *
 * desktop/preload.ts puts this on the window over contextBridge, and it is the only
 * thing that ever does. It carries facts about the host and nothing that acts, which is
 * why every member here is readonly - the page can look, and that is all.
 *
 * Declared in this file because it has no imports and no exports, which is what keeps it
 * an ambient global. Adding an import here would turn it into a module and the Window
 * augmentation below would quietly stop applying.
 */
interface UnoteDesktop {
  /**
   * Always true. The signal is the OBJECT being there, not this value: in a browser the
   * whole thing is absent, which is why `unoteDesktop` is optional on Window.
   */
  readonly isDesktop: true;
  /** The packaged app's version, or '0.0.0' when it was not built by electron-builder. */
  readonly version: string;
  /**
   * `process.platform` from the main process - 'win32', 'darwin', 'linux'. Typed as a
   * plain string rather than NodeJS.Platform because the web build has no Node types.
   */
  readonly platform: string;
}

interface Window {
  /**
   * Absent in a browser and present only inside the Electron shell, so every read has to
   * be guarded: `window.unoteDesktop?.isDesktop`.
   */
  unoteDesktop?: UnoteDesktop;
}
