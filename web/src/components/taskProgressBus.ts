// A place for work that takes long enough to need explaining.
//
// The app already has two ways to say something is happening, and neither fits a job
// that runs for seconds: a Spinner says "wait" without saying for what or for how long,
// and a toast fires once the work is already over. Anything with phases - shrink a photo,
// then upload it - needs to name the phase it is in and, where the number is real, how
// far through it is.
//
// A bus rather than context because the callers are not components. `imageUpload.ts` is a
// plain function reached from a ProseMirror paste handler, which has no React tree to
// read from; the same is true of the editor's drop handler and the slash menu.
//
// DETERMINATE ONLY WHERE THE NUMBER IS HONEST. `percent` is optional and stays undefined
// for phases that genuinely cannot be measured (a canvas re-encode reports nothing until
// it is finished). A bar that invents a number is worse than a bar that admits it is
// indeterminate, because the user calibrates on it and then it lies.

export interface TaskState {
  id: number;
  /** What is happening right now, in words the user did not have to be taught. */
  label: string;
  /** 0-100 when it can be measured; undefined means "show the indeterminate sweep". */
  percent?: number;
  status: 'running' | 'error';
}

export interface TaskHandle {
  update(next: { label?: string; percent?: number }): void;
  /** Clears the card. The caller is expected to toast on its own if there is news. */
  done(): void;
  /** Leaves the card up briefly in an error state, then clears it. */
  fail(message: string): void;
}

type Listener = (tasks: TaskState[]) => void;

const tasks = new Map<number, TaskState>();
const listeners = new Set<Listener>();
let nextId = 1;

function emit(): void {
  const snapshot = [...tasks.values()];
  for (const l of listeners) l(snapshot);
}

export function subscribeTasks(l: Listener): () => void {
  listeners.add(l);
  l([...tasks.values()]);
  return () => {
    listeners.delete(l);
  };
}

/** How long a failed task stays on screen. Long enough to read, short enough not to nag. */
const ERROR_LINGER_MS = 3600;

export function startTask(label: string): TaskHandle {
  const id = nextId++;
  tasks.set(id, { id, label, status: 'running' });
  emit();

  return {
    update(next) {
      const cur = tasks.get(id);
      // A task that has already been ended must not resurrect itself. Progress events
      // can arrive after an abort - XHR fires a final `progress` before `error` - and
      // without this guard the card comes back with no one left to clear it.
      if (!cur) return;
      tasks.set(id, {
        ...cur,
        label: next.label ?? cur.label,
        percent: next.percent ?? cur.percent,
      });
      emit();
    },
    done() {
      tasks.delete(id);
      emit();
    },
    fail(message) {
      const cur = tasks.get(id);
      if (!cur) return;
      tasks.set(id, { ...cur, label: message, status: 'error', percent: undefined });
      emit();
      setTimeout(() => {
        tasks.delete(id);
        emit();
      }, ERROR_LINGER_MS);
    },
  };
}
