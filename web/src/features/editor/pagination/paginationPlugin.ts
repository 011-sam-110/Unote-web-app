// The ProseMirror half of pagination: measure the document, decide where the breaks go,
// and insert the spacers that push blocks onto the next sheet.
//
// The document is NEVER split into one container per page. It stays a single
// contenteditable with widget decorations between blocks, because splitting it would break
// selection across a boundary, undo, find-and-replace, and every node view in the app.
// The paper itself is drawn behind the text by SheetLayer, which reads the plan this
// plugin publishes.

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { placeBreaks, type BreakPlan } from './placeBreaks';
import type { PageGeometry } from './geometry';

export interface PaginationState {
  plan: BreakPlan | null;
  geometry: PageGeometry | null;
  /** Decorations are rebuilt only when the plan changes, not on every transaction. */
  decorations: DecorationSet;
}

export const paginationKey = new PluginKey<PaginationState>('folioPagination');

interface SetPlanMeta {
  plan: BreakPlan | null;
  geometry: PageGeometry | null;
}

/**
 * How long to wait after the last change before re-measuring.
 *
 * One animation frame is not enough on its own: a burst of typing would measure on every
 * keystroke, and each measure forces a synchronous layout. A trailing idle collapses a
 * sentence's worth of keystrokes into one pass, and 120ms is short enough that the break
 * appears to move with the text rather than after it.
 */
const MEASURE_IDLE_MS = 120;

/**
 * Natural (un-spaced) heights of every top-level block.
 *
 * Measured as differences between consecutive offsetTops, so the number includes the
 * margin between two blocks - `offsetHeight` alone does not, and a document is mostly
 * margins. The spacers already in the DOM are subtracted back out, which is what stops
 * this being circular: inserting a spacer moves every offsetTop below it, so measuring
 * raw offsets would feed the previous plan back into the next one and the page count
 * would creep on every pass.
 */
function measureBlocks(view: EditorView, previous: BreakPlan | null): number[] {
  const count = view.state.doc.childCount;
  if (count === 0) return [];

  const offsets: number[] = [];
  const doms: Array<HTMLElement | null> = [];
  let spacerSoFar = 0;

  for (let i = 0, pos = 0; i < count; i++) {
    const node = view.state.doc.child(i);
    const dom = view.nodeDOM(pos) as HTMLElement | null;
    pos += node.nodeSize;
    doms.push(dom);

    if (previous) spacerSoFar += previous.spacers[i] ?? 0;
    // A node with no DOM yet (a node view still mounting) is NaN rather than 0, so the
    // block before it falls back to its own box instead of being measured as the whole
    // distance to the next real element. The mutation observer brings us back once it
    // has laid out.
    offsets.push(dom ? dom.offsetTop - spacerSoFar : Number.NaN);
  }

  const heights: number[] = [];
  for (let i = 0; i < count; i++) {
    const here = offsets[i];
    const next = i + 1 < count ? offsets[i + 1] : Number.NaN;
    if (Number.isNaN(here)) {
      heights.push(0);
    } else if (!Number.isNaN(next)) {
      heights.push(Math.max(0, next - here));
    } else {
      // Last block, or the one before a node view that has not mounted: its own box is the
      // best available answer. Misses the trailing margin, which is not worth a second
      // reflow to recover.
      heights.push(doms[i]?.offsetHeight ?? 0);
    }
  }

  return heights;
}

function samePlan(a: BreakPlan | null, b: BreakPlan | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.spacers.length !== b.spacers.length) return false;
  for (let i = 0; i < a.spacers.length; i++) {
    // Sub-pixel churn is not a plan change; without this the plugin dispatches a
    // transaction on every measure and the editor never settles.
    if (Math.abs(a.spacers[i] - b.spacers[i]) > 0.5) return false;
  }
  return a.pages.length === b.pages.length;
}

export interface PaginationOptions {
  /** Current geometry, or null to switch pagination off entirely (plain mode, phones,
   *  canvas notes). Read fresh on every measure so a page-size change takes effect. */
  getGeometry: () => PageGeometry | null;
  /** Called whenever the published plan changes, so React can redraw the sheets. */
  onPlan?: (plan: BreakPlan | null, geometry: PageGeometry | null) => void;
}

export function paginationPlugin(options: PaginationOptions): Plugin<PaginationState> {
  return new Plugin<PaginationState>({
    key: paginationKey,

    state: {
      init: () => ({ plan: null, geometry: null, decorations: DecorationSet.empty }),
      apply(tr, value, _old, newState) {
        const meta = tr.getMeta(paginationKey) as SetPlanMeta | undefined;
        if (meta) {
          return {
            plan: meta.plan,
            geometry: meta.geometry,
            decorations: meta.plan
              ? DecorationSet.create(
                  newState.doc,
                  buildWidgets(newState.doc, meta.plan),
                )
              : DecorationSet.empty,
          };
        }
        if (!tr.docChanged) return value;
        // The document moved but we have not re-measured yet. Map the existing spacers so
        // they stay attached to their blocks for the frame or two before the next measure,
        // rather than all collapsing and making the page visibly jump on every keystroke.
        return { ...value, decorations: value.decorations.map(tr.mapping, tr.doc) };
      },
    },

    props: {
      decorations(state) {
        return paginationKey.getState(state)?.decorations ?? DecorationSet.empty;
      },
    },

    view(view) {
      let timer: number | null = null;
      let frame: number | null = null;
      let disposed = false;

      const measureNow = () => {
        if (disposed) return;

        const geometry = options.getGeometry();
        const current = paginationKey.getState(view.state);

        if (!geometry) {
          if (current?.plan) publish(view, null, null, options.onPlan);
          return;
        }

        // A hidden tab pane reports every height as 0. Measuring one would compute a
        // document of thousands of empty pages and then thrash the moment it became
        // visible - several note panes stay mounted at once, so this is the normal case,
        // not an edge case. Bail and wait to be asked again.
        if ((view.dom as HTMLElement).offsetParent === null) return;

        const blocks = measureBlocks(view, current?.plan ?? null);
        const plan = placeBreaks({
          blocks,
          contentHeightPx: geometry.contentHeightPx,
          interPageSkipPx: geometry.interPageSkipPx,
        });

        if (samePlan(plan, current?.plan ?? null)) return;
        publish(view, plan, geometry, options.onPlan);
      };

      const schedule = () => {
        if (disposed) return;
        if (timer !== null) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          timer = null;
          if (frame !== null) cancelAnimationFrame(frame);
          // Measure inside a frame so it happens after the browser has laid the change out;
          // reading offsetTop before that returns the PREVIOUS layout.
          frame = requestAnimationFrame(() => {
            frame = null;
            measureNow();
          });
        }, MEASURE_IDLE_MS);
      };

      // Width changes reflow every block, so the plan is invalid even though the document
      // did not change. Also covers the pane becoming visible again, which is what gets us
      // back after the offsetParent bail above.
      const resizeObserver = new ResizeObserver(schedule);
      resizeObserver.observe(view.dom);

      // Images, 3D models, chemistry diagrams and sketches all get their height late. A
      // subtree mutation is the cheapest signal that one of them has finally laid out.
      const mutationObserver = new MutationObserver(schedule);
      mutationObserver.observe(view.dom, { subtree: true, childList: true, attributes: true });

      // A webfont swap changes the height of every line in the document at once.
      document.fonts?.ready.then(schedule).catch(() => {});
      const onLoad = (event: Event) => {
        if ((event.target as HTMLElement)?.tagName === 'IMG') schedule();
      };
      view.dom.addEventListener('load', onLoad, true);

      schedule();

      return {
        update: schedule,
        destroy() {
          disposed = true;
          if (timer !== null) window.clearTimeout(timer);
          if (frame !== null) cancelAnimationFrame(frame);
          resizeObserver.disconnect();
          mutationObserver.disconnect();
          view.dom.removeEventListener('load', onLoad, true);
        },
      };
    },
  });
}

/** One spacer widget per break in the plan, sitting between two top-level blocks. */
function buildWidgets(doc: import('@tiptap/pm/model').Node, plan: BreakPlan): Decoration[] {
  const decorations: Decoration[] = [];
  let index = 0;
  doc.forEach((_node, offset) => {
    const height = plan.spacers[index];
    index += 1;
    if (!height || height <= 0) return;
    decorations.push(
      Decoration.widget(
        offset,
        () => {
          const el = document.createElement('div');
          el.className = 'folio-page-spacer';
          el.style.height = `${height}px`;
          // Not part of the text: it must never be read out or selected.
          el.setAttribute('aria-hidden', 'true');
          el.contentEditable = 'false';
          return el;
        },
        // `side: -1` puts the spacer BEFORE the block at this position rather than after
        // the previous one, which keeps it outside the previous block's box.
        // `ignoreSelection` stops the caret landing inside a decoration with no text in
        // it - without it, arrowing down across a break parks the cursor in the gap and
        // the next keystroke goes nowhere visible.
        { side: -1, ignoreSelection: true, key: `spacer-${index}-${Math.round(height)}` },
      ),
    );
  });
  return decorations;
}

function publish(
  view: EditorView,
  plan: BreakPlan | null,
  geometry: PageGeometry | null,
  onPlan?: PaginationOptions['onPlan'],
) {
  const tr = view.state.tr.setMeta(paginationKey, { plan, geometry } satisfies SetPlanMeta);
  // Not an edit: without this the autosave fires on every repagination and the note's
  // updated_at moves every time a window is resized.
  tr.setMeta('addToHistory', false);
  view.dispatch(tr);
  onPlan?.(plan, geometry);
}
