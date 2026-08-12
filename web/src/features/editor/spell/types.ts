/** One flagged range, in offsets into the text that was linted. */
export interface SpellIssue {
  start: number;
  end: number;
  /** Replacements, best first. May be empty - not every lint has a fix. */
  suggestions: string[];
  message: string;
}

/** The engine, reduced to the one thing the editor needs from it.
 *
 *  The plugin depends on this rather than on Harper directly, so its position mapping and
 *  decoration logic can be tested without instantiating 15.8 MB of WASM - and so the engine
 *  can be swapped without touching the editor. */
export type LintFn = (text: string) => Promise<SpellIssue[]>;
