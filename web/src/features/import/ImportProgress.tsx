// Shared stepper UI for an in-flight import job - used by both ImportModal
// (desktop) and CapturePage (mobile, via `compact`).
//
// The bar is STAGE-based, not time-based. The server does not report a percentage and
// cannot honestly invent one - "Extracting text…" on a 60-slide deck and on a one-page
// PDF are the same step taking wildly different times. What it does report is which
// milestone it has reached, and those milestones are a fixed, ordered pipeline
// (server/src/routes/imports.ts), so "step 2 of 4" is a true statement about progress
// even though it says nothing about the seconds remaining.
//
// A step this file does not recognise falls back to the indeterminate sweep rather than
// being forced onto the scale. That matters because the pipeline is allowed to grow: a
// new step should read as "something is happening" and not silently land on 0%.
import type { ImportJob } from '../../lib/types';
import './ImportProgress.css';

const STATUS_LABEL: Record<ImportJob['status'], string> = {
  queued: 'Queued…',
  running: 'Processing…',
  done: 'Done',
  failed: 'Failed',
};

/**
 * The pipeline, in the order the server walks it.
 *
 * 'Saving figures…' only happens for .pptx, so a PDF import legitimately skips from 3 to
 * done. That makes the denominator a slight over-estimate on those runs, which is the
 * right direction to be wrong in: the bar never goes backwards and never stalls at 100%.
 */
const STEP_ORDER = ['Extracting text…', 'Improving with AI…', 'Saving note…', 'Saving figures…', 'Done'];

function stageOf(job: ImportJob | null): { index: number; total: number } | null {
  if (!job || !job.step) return null;
  const i = STEP_ORDER.indexOf(job.step);
  if (i < 0) return null;
  return { index: i + 1, total: STEP_ORDER.length };
}

export default function ImportProgress({ job, pageInfo, compact }: {
  job: ImportJob | null;
  pageInfo?: { index: number; total: number };
  compact?: boolean;
}) {
  const label = job ? (job.step ?? STATUS_LABEL[job.status]) : 'Starting…';
  const active = !job || job.status === 'queued' || job.status === 'running';
  const stage = stageOf(job);
  const percent = stage ? Math.round((stage.index / stage.total) * 100) : null;

  return (
    <div className={`im-progress${compact ? ' im-progress--compact' : ''}`} role="status" aria-live="polite">
      {pageInfo && pageInfo.total > 1 && (
        <div className="im-progress__page">Page {pageInfo.index + 1} of {pageInfo.total}</div>
      )}
      <div
        className="im-progress__track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        // Left off entirely while indeterminate, so AT says "busy" rather than "0 percent".
        aria-valuenow={percent ?? undefined}
        aria-label={label}
      >
        <div
          className={`im-progress__bar${active && percent === null ? ' is-active' : ''}`}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      <div className="im-progress__label">
        {active && <span className="im-progress__dot" aria-hidden="true" />}
        {label}
        {stage && active && <span className="im-progress__stage">Step {stage.index} of {stage.total}</span>}
      </div>
    </div>
  );
}
