// The intake form for one source type.
//
// Every box here is generated from the type's own field list, fetched from
// GET /api/references/types. Nothing about the 27 types is hard-coded on this side, so
// adding a type is a server edit and this form grows a box without being touched.
//
// Empty means UNKNOWN, not blank: writeField deletes the key rather than storing '', so a
// field nobody filled in stays absent from the CSL object all the way to the bibliography.
import { useId } from 'react';
import type { Csl, SourceField, SourceType } from './types';
import { readField, writeField } from './csl';

function FieldInput({
  field,
  csl,
  onChange,
  idPrefix,
  autoFocus,
  reportedMissing,
}: {
  field: SourceField;
  csl: Csl;
  onChange: (next: Csl) => void;
  idPrefix: string;
  autoFocus?: boolean;
  /** The registry said, in as many words, that it does not have this. */
  reportedMissing?: boolean;
}) {
  const id = `${idPrefix}-${field.csl}`;
  const value = readField(csl, field);
  const set = (text: string) => onChange(writeField(csl, field, text));

  return (
    <div className="rf-field">
      <label className="field-label rf-field__label" htmlFor={id}>
        {field.label}
        {field.recommended && <span className="rf-field__rec">recommended</span>}
        {reportedMissing && !field.recommended && <span className="rf-field__rec rf-field__rec--muted">not supplied</span>}
      </label>
      {field.kind === 'contributors' ? (
        <>
          <textarea
            id={id}
            className="text-input rf-field__area"
            rows={2}
            value={value}
            autoFocus={autoFocus}
            spellCheck={false}
            placeholder="Watson, James D."
            onChange={(e) => set(e.target.value)}
          />
          <p className="rf-field__hint">
            One per line, surname first. Leave the comma out for an organisation.
          </p>
        </>
      ) : (
        <input
          id={id}
          className="text-input"
          type={field.kind === 'url' ? 'url' : 'text'}
          inputMode={field.kind === 'number' ? 'numeric' : undefined}
          value={value}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          placeholder={field.kind === 'date' ? '2013-07-25, 2013-07 or 2013' : undefined}
          onChange={(e) => set(e.target.value)}
        />
      )}
    </div>
  );
}

/** A flat form over every field of a type. Used for typing a source in from scratch and
 *  for correcting a saved one. The found/needed SPLIT is a different surface - see
 *  AddSourceDialog - because it is telling the student something this form is not. */
export default function SourceForm({
  type,
  csl,
  onChange,
  autoFocusFirst,
  reportedMissing,
}: {
  type: SourceType;
  csl: Csl;
  onChange: (next: Csl) => void;
  autoFocusFirst?: boolean;
  reportedMissing?: Set<string>;
}) {
  const idPrefix = useId();
  return (
    <div className="rf-form">
      {type.fields.map((field, i) => (
        <FieldInput
          key={field.csl}
          field={field}
          csl={csl}
          onChange={onChange}
          idPrefix={idPrefix}
          autoFocus={autoFocusFirst && i === 0}
          reportedMissing={reportedMissing?.has(field.csl)}
        />
      ))}
    </div>
  );
}

export { FieldInput };
