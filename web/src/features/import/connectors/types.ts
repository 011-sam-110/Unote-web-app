// The connector pattern. A source is added by writing one connector and registering it; the
// wizard, the extraction pipeline and the review screen do not change. Every connector
// normalises its input into RawDoc, which then flows through extract -> stage -> categorise
// -> review -> commit.
import type { IconName } from '../../../components/Icon';

export interface RawDoc {
  /** For dedupe / re-import later (Phase 3). */
  externalId?: string;
  title?: string;
  /** Category signal - e.g. ['databases'] from a dropped folder. */
  folderPath?: string[];
  /** Category signal - frontmatter / #hashtags / export properties. */
  sourceTags?: string[];
  /** The path as the user knows it, e.g. 'databases/indexing.md'. */
  sourcePath?: string;
  /** Exactly one of `text` (already extracted) or `file` (needs extraction) is expected. */
  text?: string;
  file?: File;
  createdAt?: string;
  updatedAt?: string;
  /**
   * Source-specific cleanup of the extracted text, applied by extract.ts once the file has
   * been read.
   *
   * It hangs off the doc rather than the connector because extraction runs per file and
   * never sees which connector produced it. The case it exists for is Notion, which writes
   * a page's properties as bare `Key: value` lines under the title with no frontmatter
   * fence - invisible to the generic parser, and the first thing the user sees in the note
   * if nothing strips it.
   */
  transformText?: (text: string) => { text: string; tags?: string[] };
}

export type SourceSetup = 'none' | 'oauth' | 'coming-soon';

export interface SourceConnector {
  id: string;
  label: string;
  /** One line under the tile - what this source is, in the student's words. */
  description: string;
  icon: IconName;
  /** file-input `accept`, when file-based. */
  accept?: string;
  /** Whether the picker offers "choose a folder" (webkitdirectory). */
  supportsFolder?: boolean;
  /** Which paths inside a dropped .zip are worth unpacking at all. Used to spend the
   *  archive's size budget on the files this source actually reads - see zipEntries.ts. */
  keepPath?: (path: string) => boolean;
  setup: SourceSetup;
  /** Turn picked files into RawDocs. Client-side and synchronous for the Phase-1 file
   *  connectors; extraction happens downstream in the pipeline, not here. */
  ingest(files: File[]): RawDoc[];
}
