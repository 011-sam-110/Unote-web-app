// The on-screen half of taskProgressBus: a card naming the work that is in flight.
//
// Bottom-LEFT, because bottom-right is the toaster's and the two are not alternatives -
// an upload that finishes reports itself with a toast while the next one is still going,
// and stacking them in one column made the toast look like the upload's own status line.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import { subscribeTasks, type TaskState } from './taskProgressBus';
import './task-progress.css';

/**
 * How long a task must run before it is worth drawing.
 *
 * Downscaling a screenshot and posting the 80KB result takes well under this on a decent
 * connection, and a progress card that appears and vanishes inside 200ms reads as a glitch
 * rather than as feedback. The card is for the phone-photo case that genuinely takes seconds.
 */
const SHOW_AFTER_MS = 260;

export default function TaskProgress() {
  const [tasks, setTasks] = useState<TaskState[]>([]);
  const [visible, setVisible] = useState(false);

  useEffect(() => subscribeTasks(setTasks), []);

  useEffect(() => {
    if (tasks.length === 0) {
      setVisible(false);
      return;
    }
    // Re-armed on every transition into "has tasks", not on every task change: a second
    // upload starting while the card is already up must not restart the delay and blink it.
    if (visible) return;
    const t = setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    return () => clearTimeout(t);
  }, [tasks.length, visible]);

  if (!visible || tasks.length === 0) return null;

  return createPortal(
    <div className="tp-stack" role="status" aria-live="polite">
      {tasks.map((t) => (
        <div key={t.id} className={`tp-card${t.status === 'error' ? ' is-error' : ''}`}>
          <div className="tp-card__head">
            <span className="tp-card__icon" aria-hidden="true">
              {t.status === 'error' ? <Icon name="alert-circle" size={13} /> : <span className="tp-card__dot" />}
            </span>
            <span className="tp-card__label">{t.label}</span>
            {/* The number is only rendered when it is real. See taskProgressBus. */}
            {t.status === 'running' && t.percent !== undefined && (
              <span className="tp-card__pct">{t.percent}%</span>
            )}
          </div>
          {t.status === 'running' && (
            <div
              className="tp-card__track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              // Omitted entirely while indeterminate, which is what tells AT to announce it
              // as "busy" rather than as "0 percent".
              aria-valuenow={t.percent}
              aria-label={t.label}
            >
              <div
                className={`tp-card__bar${t.percent === undefined ? ' is-indeterminate' : ''}`}
                style={t.percent === undefined ? undefined : { width: `${t.percent}%` }}
              />
            </div>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}
