// The spell-check engine: Harper, in a worker, one instance for the whole app.
//
// Why one instance: since 44ab61c up to four editors are mounted at once and extensions are
// rebuilt per editor, so anything constructed inside an extension is constructed four times.
// Four Harper instances would mean four WASM compiles and four dictionaries resident.
// Follows the memoised-promise shape of createOcrRunner (features/import/connectors/extract.ts).
//
// Why lazy: the WASM artifact is 15.8 MB on disk and setup measured ~1.1 s. Loading it on the
// first lint request rather than at module load keeps it off first paint entirely - squiggles
// arrive about a second after the editor is usable, which is the right trade for a checker.
//
// Dialect is British and that is not a preference. Measured on a British corpus, the American
// dialect flags 8.9% of tokens - colour, centre, licence, organise, behaviour, travelled.
// Shipping the wrong dialect is the single fastest way to make this feature unusable here.
import type { LintFn, SpellIssue } from './types';

/** Harper reports grammar and style as well as spelling. v1 is a SPELL checker: showing
 *  style opinions under the same squiggle would change what the underline means, and the
 *  accuracy figures behind this decision were measured on spelling kinds only. */
const SPELLING_KINDS = new Set(['Spelling', 'Typo']);

const SETUP_TIMEOUT_MS = 60_000;
const LINT_TIMEOUT_MS = 10_000;

interface HarperLint {
  span(): { start: number; end: number };
  lint_kind(): string;
  message(): string;
  suggestions(): { get_replacement_text(): string }[];
}

interface HarperLinter {
  setup(): Promise<void>;
  lint(text: string): Promise<HarperLint[]>;
  importWords(words: string[]): Promise<void>;
}

let linterPromise: Promise<HarperLinter> | null = null;
let engineDead = false;
/** Words added before the engine finished loading still have to reach it. */
let pendingWords: string[] = [];

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

async function getLinter(): Promise<HarperLinter> {
  if (!linterPromise) {
    linterPromise = (async () => {
      const { WorkerLinter, Dialect } = await import('harper.js');
      const { binary } = await import('harper.js/binary');
      const linter = new WorkerLinter({ binary, dialect: Dialect.British }) as unknown as HarperLinter;
      await linter.setup();
      if (pendingWords.length) {
        await linter.importWords(pendingWords);
        pendingWords = [];
      }
      return linter;
    })();
    // A failed load must not be retried on every keystroke, and must not become an
    // unhandled rejection while nothing is awaiting it yet.
    linterPromise.catch(() => {
      engineDead = true;
    });
  }
  return linterPromise;
}

/** True once the engine has failed to load. The editor uses this to decide whether to hand
 *  spell checking back to the browser rather than leaving the user with nothing. */
export function engineFailed(): boolean {
  return engineDead;
}

/** Warm the engine without linting anything - call when an editor mounts, so the download
 *  overlaps with the user reading their note instead of with their first keystroke.
 *  Rejects if the engine cannot load, so the caller can hand spelling back to the browser. */
export function preloadLinter(): Promise<void> {
  return getLinter().then(() => undefined);
}

/** Add words the user has accepted. Safe before setup: they are replayed on load. */
export async function importWords(words: string[]): Promise<void> {
  if (!words.length) return;
  if (!linterPromise) {
    pendingWords = [...pendingWords, ...words];
    return;
  }
  try {
    const linter = await linterPromise;
    await linter.importWords(words);
  } catch {
    /* engine is dead; engineFailed() already reports it */
  }
}

export const lintText: LintFn = async (text: string): Promise<SpellIssue[]> => {
  if (engineDead || !text.trim()) return [];
  let linter: HarperLinter;
  try {
    linter = await withTimeout(getLinter(), SETUP_TIMEOUT_MS);
  } catch {
    engineDead = true;
    return [];
  }
  try {
    const lints = await withTimeout(linter.lint(text), LINT_TIMEOUT_MS);
    const out: SpellIssue[] = [];
    for (const lint of lints) {
      if (!SPELLING_KINDS.has(lint.lint_kind())) continue;
      const span = lint.span();
      out.push({
        start: span.start,
        end: span.end,
        message: lint.message(),
        suggestions: lint.suggestions().map((s) => s.get_replacement_text()),
      });
    }
    return out;
  } catch {
    // This paragraph only. A slow or failed lint must not kill the engine for the session.
    return [];
  }
};

/** Test seam: drop the memoised engine. */
export function __resetLinterForTests(): void {
  linterPromise = null;
  engineDead = false;
  pendingWords = [];
}
