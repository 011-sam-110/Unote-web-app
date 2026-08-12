// A source, written out in the style the student's department set.
//
// Shown WITH what it is short of. The formatter renders whatever it has, which is right - a
// partial reference is more use than none - but a tidy-looking line gives a student no way
// to tell that the publisher was never known. Naming the gaps next to the output is the
// same contract the intake flow keeps: what is known and what is missing, never merged.
import { useState } from 'react';
import Icon from '../../components/Icon';
import { toast } from '../../components/Toast';
import { formatInText, formatReference, missingFor, type StyleId } from './styles';
import type { Csl } from './types';

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`, 'ok');
  } catch {
    toast('Could not reach the clipboard. Select the text and copy it by hand.', 'error');
  }
}

export default function ReferenceText({
  csl,
  style,
  number,
}: {
  csl: Csl;
  style: StyleId;
  /** Position in the reference list. Only a numeric style uses it. */
  number?: number;
}) {
  const [showInText, setShowInText] = useState(false);
  const reference = formatReference(csl, style);
  const inText = formatInText(csl, style, number);
  const missing = missingFor(csl);

  return (
    <div className="rf-ref">
      <div className="rf-ref__row">
        {/* Selectable, because a student who cannot reach the clipboard API still has to
            be able to get the text out. */}
        <p className="rf-ref__text">{reference}</p>
        <button
          type="button"
          className="btn btn-ghost btn-sm rf-ref__copy"
          onClick={() => void copy(reference, 'Reference')}
        >
          <Icon name="copy" size={12} />
          Copy
        </button>
      </div>

      {missing.length > 0 && (
        <p className="rf-ref__missing">
          Still short of {missing.join(', ')} - the reference will read as incomplete until
          you add {missing.length === 1 ? 'it' : 'them'}.
        </p>
      )}

      <button type="button" className="rf-ref__toggle" onClick={() => setShowInText((v) => !v)}>
        <Icon name={showInText ? 'chevron-down' : 'chevron-right'} size={11} />
        In the sentence
      </button>
      {showInText && (
        <div className="rf-ref__row rf-ref__row--intext">
          <code className="rf-ref__intext">{inText}</code>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy(inText, 'Citation')}>
            <Icon name="copy" size={12} />
            Copy
          </button>
        </div>
      )}
    </div>
  );
}

export { copy as copyToClipboard };
