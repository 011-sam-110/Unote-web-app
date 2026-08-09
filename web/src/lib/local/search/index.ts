// The offline search index: MiniSearch over the local mirror, serialised into the
// `meta` table and rehydrated on boot.
//
// HOW IT STAYS CURRENT. Not by every write path remembering to call an update hook.
// There are already six of those in localApi and the sync engine adds more, and the
// one that gets forgotten produces a search box that cannot find a note the user is
// looking straight at. Instead the index remembers the updatedAt of every row it has
// folded in, and before answering a query it compares that against the mirror. Rows
// that differ are re-indexed; rows that disappeared are discarded; everything else is
// untouched. So an unchanged mirror costs one pass and no rebuild, and a changed one
// costs only the notes that changed.
//
// The comparison is a KEY-ONLY scan of the `updatedAt` index - the row bodies are
// never read for it - which is what makes running it on every search affordable. The
// obvious cheaper idea, keeping a high-water mark and reading only what is newer, was
// tried first and is wrong: a sync pull applies a record whose updatedAt beats the
// LOCAL COPY'S, which is routinely older than the newest note on the device. Anything
// another machine edited last week would land underneath the mark and never be
// indexed. A search index that silently cannot see a note is the failure this whole
// module exists to avoid, so it pays for the full comparison.
import MiniSearch from 'minisearch';
import type { AsPlainObject, Options } from 'minisearch';
import { localDb, readMeta, writeMeta } from '../db';
import type { LocalNote, SyncMetaRow } from '../records';
import { indexTerm, tokenise } from './parse';

/**
 * Bump whenever the indexed fields, the tokeniser or the term processing change.
 * A stale index that silently answers by the old rules is worse than a rebuild: the
 * rebuild costs a moment on boot, the stale one costs the user a note.
 */
export const INDEX_VERSION = 1;

/** What the index holds per note. Title and body are separate so title can be boosted. */
interface IndexedNote {
  id: string;
  title: string;
  body: string;
}

/**
 * Part of the serialisation contract: MiniSearch.loadJS must be handed the same
 * options the index was built with, so a change here needs INDEX_VERSION bumped with
 * it or an old blob rehydrates under new rules.
 */
const OPTIONS: Options<IndexedNote> = {
  fields: ['title', 'body'],
  // Nothing is stored on the index. The note rows have to be read anyway for the
  // tag/notebook/phrase filters, so a second copy of the text here would only be a
  // second thing to keep current.
  storeFields: [],
  tokenize: (text) => tokenise(text),
  processTerm: (term) => indexTerm(term),
};

/**
 * Typed against the union in records.ts rather than a bare string, so renaming the key
 * there is a compile error here instead of a silently orphaned blob that rebuilds the
 * index from scratch on every boot and never says why.
 */
const META_INDEX: SyncMetaRow['key'] = 'searchIndex';

/** What gets written to `meta`. Without `seen` the first search after every boot would
 *  have nothing to compare the mirror against and would rebuild. */
interface Envelope {
  v: number;
  seen: Array<[string, string]>;
  mini: AsPlainObject;
}

interface IndexState {
  mini: MiniSearch<IndexedNote>;
  /**
   * id -> updatedAt for every note row this index has processed, tombstoned and
   * archived ones included. They are not IN the index, but they are in the mirror, and
   * forgetting them would mean reconsidering them on every single search.
   */
  seen: Map<string, string>;
  persistTimer: ReturnType<typeof setTimeout> | null;
}

let state: IndexState | null = null;
let loading: Promise<IndexState> | null = null;

/** How long to sit on a changed index before writing it out. */
const PERSIST_DEBOUNCE_MS = 1500;

/**
 * A note belongs in the index only if search could return it. GET /api/search filters
 * `archived = 0 AND deleted_at IS NULL`, so an archived or tombstoned note is discarded
 * rather than indexed and filtered later - which would still let it eat the limit.
 */
function isSearchable(n: LocalNote): boolean {
  return n.deletedAt === null && n.archived === 0;
}

function toDoc(n: LocalNote): IndexedNote {
  return { id: n.id, title: n.title ?? '', body: n.contentText ?? '' };
}

function applyNote(mini: MiniSearch<IndexedNote>, n: LocalNote): void {
  if (!isSearchable(n)) {
    if (mini.has(n.id)) mini.discard(n.id);
    return;
  }
  if (mini.has(n.id)) mini.replace(toDoc(n));
  else mini.add(toDoc(n));
}

/**
 * Every note's id and updatedAt, read from the index rather than from the rows.
 *
 * A note with no updatedAt would be absent from this - IndexedDB leaves a record out
 * of an index it has no key for - and so would never be searchable. Every write path
 * sets it from correctedNow(), and db.test.ts pins the row shape, so that is a
 * corruption case rather than a state this store can reach.
 */
async function mirrorVersions(): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  await localDb.notes.orderBy('updatedAt').eachKey((key, cursor) => {
    seen.set(cursor.primaryKey, String(key));
  });
  return seen;
}

async function buildFromMirror(): Promise<IndexState> {
  const mini = new MiniSearch<IndexedNote>(OPTIONS);
  const all = await localDb.notes.toArray();
  mini.addAll(all.filter(isSearchable).map(toDoc));
  return { mini, seen: new Map(all.map((n) => [n.id, n.updatedAt])), persistTimer: null };
}

async function hydrate(): Promise<IndexState> {
  const raw = await readMeta(META_INDEX);
  if (!raw) return buildFromMirror();
  try {
    const env = JSON.parse(raw) as Envelope;
    if (env.v !== INDEX_VERSION) return buildFromMirror();
    const mini = MiniSearch.loadJS<IndexedNote>(env.mini, OPTIONS);
    return { mini, seen: new Map(env.seen ?? []), persistTimer: null };
  } catch {
    // A blob from an older MiniSearch, a half-written string, anything: the mirror is
    // the source of truth and rebuilding from it always works.
    return buildFromMirror();
  }
}

/**
 * Fold in every difference between the index and the mirror. Returns true when the
 * index moved, which is the only time it is worth serialising again.
 */
async function reconcile(s: IndexState): Promise<boolean> {
  const current = await mirrorVersions();

  const changed: string[] = [];
  for (const [id, at] of current) if (s.seen.get(id) !== at) changed.push(id);
  const dropped: string[] = [];
  for (const id of s.seen.keys()) if (!current.has(id)) dropped.push(id);

  if (!changed.length && !dropped.length) return false;

  for (const id of dropped) if (s.mini.has(id)) s.mini.discard(id);
  const rows = await localDb.notes.bulkGet(changed);
  for (const row of rows) if (row) applyNote(s.mini, row);

  s.seen = current;
  return true;
}

function schedulePersist(s: IndexState): void {
  if (s.persistTimer !== null) return;
  s.persistTimer = setTimeout(() => {
    s.persistTimer = null;
    // Fire and forget. A failed write costs a rebuild next boot, never a wrong answer.
    void persistSearchIndex().catch(() => {});
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * The index, current as of this call.
 *
 * Every query comes through here rather than holding a cached handle, because "is the
 * mirror newer than the index" is exactly the question a search must not guess at.
 */
export async function ensureSearchIndex(): Promise<MiniSearch<IndexedNote>> {
  if (!state) {
    loading ??= hydrate();
    state = await loading;
    loading = null;
  }
  const s = state;
  if (await reconcile(s)) schedulePersist(s);
  return s.mini;
}

/**
 * Write the index out now, rather than on the debounce.
 *
 * Serialising is proportional to the library, so it is kept off the path the user
 * waits on; this is the escape hatch for a caller that knows the page is going away.
 */
export async function persistSearchIndex(): Promise<void> {
  const s = state;
  if (!s) return;
  if (s.persistTimer !== null) {
    clearTimeout(s.persistTimer);
    s.persistTimer = null;
  }
  const env: Envelope = { v: INDEX_VERSION, seen: [...s.seen], mini: s.mini.toJSON() };
  await writeMeta(META_INDEX, JSON.stringify(env));
}

/**
 * Drop the in-memory index.
 *
 * The stored blob is deliberately left alone. It carries the row versions it was built
 * against, so the next reconcile reads an emptied mirror as every row having
 * disappeared and empties the index to match - which makes this safe to call after
 * clearLocalStore() or a sign-out without reasoning about what is still on disk.
 */
export function resetSearchIndex(): void {
  if (state?.persistTimer != null) clearTimeout(state.persistTimer);
  state = null;
  loading = null;
}
