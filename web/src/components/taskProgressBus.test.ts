// The bus exists to stop a progress card outliving the work it describes.
//
// The subtle bug it is written against: XHR fires a final `progress` event AFTER an abort,
// so a naive implementation resurrects a task that has already been ended and leaves a card
// on screen with nobody left to clear it. `update` after `done` must be a no-op.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { startTask, subscribeTasks, type TaskState } from './taskProgressBus';

function collect(): { latest: () => TaskState[]; stop: () => void } {
  let seen: TaskState[] = [];
  const stop = subscribeTasks((t) => {
    seen = t;
  });
  return { latest: () => seen, stop };
}

describe('taskProgressBus', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('publishes a running task and clears it on done', () => {
    const { latest, stop } = collect();
    const t = startTask('Uploading');
    expect(latest()).toHaveLength(1);
    expect(latest()[0]).toMatchObject({ label: 'Uploading', status: 'running' });

    t.done();
    expect(latest()).toHaveLength(0);
    stop();
  });

  it('ignores an update that arrives after the task ended', () => {
    const { latest, stop } = collect();
    const t = startTask('Uploading');
    t.done();

    t.update({ label: 'Uploading… 100%', percent: 100 });
    expect(latest()).toHaveLength(0);
    stop();
  });

  it('leaves percent undefined until a real number is supplied', () => {
    const { latest, stop } = collect();
    const t = startTask('Preparing');
    expect(latest()[0].percent).toBeUndefined();

    t.update({ percent: 40 });
    expect(latest()[0].percent).toBe(40);

    // An indeterminate phase after a determinate one must not silently keep the old number
    // on the label while the bar sweeps - but `update` merges, so the caller has to be able
    // to leave it alone. Passing only a label does exactly that.
    t.update({ label: 'Finishing' });
    expect(latest()[0]).toMatchObject({ label: 'Finishing', percent: 40 });
    t.done();
    stop();
  });

  it('holds a failure on screen briefly, then clears it', () => {
    const { latest, stop } = collect();
    const t = startTask('Uploading');
    t.fail('Upload failed - check your connection');

    expect(latest()[0]).toMatchObject({ status: 'error', label: 'Upload failed - check your connection' });
    // The percentage is dropped: a bar frozen at 70% next to an error reads as "still going".
    expect(latest()[0].percent).toBeUndefined();

    vi.advanceTimersByTime(4000);
    expect(latest()).toHaveLength(0);
    stop();
  });

  it('tracks concurrent tasks independently', () => {
    const { latest, stop } = collect();
    const a = startTask('Image A');
    const b = startTask('Image B');
    expect(latest()).toHaveLength(2);

    a.done();
    expect(latest()).toHaveLength(1);
    expect(latest()[0].label).toBe('Image B');
    b.done();
    stop();
  });
});
