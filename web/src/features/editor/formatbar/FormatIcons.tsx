// Glyphs that only the formatting bar needs: alignment, indent, lists, line spacing.
//
// Deliberately NOT added to components/Icon.tsx. That set is shared app chrome and is
// being worked on in parallel; these seven are specific to a text-formatting toolbar and
// nothing else in Unote will ever ask for "increase indent". Keeping them here means the
// bar owns its own vocabulary and the shared icon set stays untouched.
//
// All drawn on the same 16x16 grid with the same 1.6 stroke as components/Icon.tsx, so
// they sit correctly beside the shared icons already used in this bar.

interface GlyphProps {
  size?: number;
}

function Svg({ size = 14, children }: GlyphProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function AlignLeft(p: GlyphProps) {
  return (
    <Svg {...p}>
      <path d="M2 3.5h12M2 6.8h7M2 10.1h12M2 13.4h7" />
    </Svg>
  );
}

export function AlignCenter(p: GlyphProps) {
  return (
    <Svg {...p}>
      <path d="M2 3.5h12M4.5 6.8h7M2 10.1h12M4.5 13.4h7" />
    </Svg>
  );
}

export function AlignRight(p: GlyphProps) {
  return (
    <Svg {...p}>
      <path d="M2 3.5h12M7 6.8h7M2 10.1h12M7 13.4h7" />
    </Svg>
  );
}

export function AlignJustify(p: GlyphProps) {
  return (
    <Svg {...p}>
      <path d="M2 3.5h12M2 6.8h12M2 10.1h12M2 13.4h12" />
    </Svg>
  );
}

export function BulletList(p: GlyphProps) {
  return (
    <Svg {...p}>
      <path d="M5.5 4h8.5M5.5 8h8.5M5.5 12h8.5" />
      <circle cx="2.5" cy="4" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="2.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="2.5" cy="12" r="0.9" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function OrderedList(p: GlyphProps) {
  return (
    <Svg {...p}>
      <path d="M6 4h8M6 8h8M6 12h8" />
      <path d="M1.4 2.6h1v2.8M1.2 5.4h2" strokeWidth="1.2" />
      <path d="M1.2 7.2h1.9L1.2 9.5h2" strokeWidth="1.2" />
      <path d="M1.3 10.9h1.8l-1 1.1 1 1.1H1.3" strokeWidth="1.2" />
    </Svg>
  );
}

export function TaskList(p: GlyphProps) {
  return (
    <Svg {...p}>
      <path d="M7.5 4h6.5M7.5 12h6.5" />
      <rect x="1.4" y="1.9" width="4.2" height="4.2" rx="1" />
      <rect x="1.4" y="9.9" width="4.2" height="4.2" rx="1" />
      <path d="M2.4 4l1 1 1.8-1.9" strokeWidth="1.3" />
    </Svg>
  );
}

export function IndentMore(p: GlyphProps) {
  return (
    <Svg {...p}>
      <path d="M6.5 3.5h7.5M6.5 8h7.5M6.5 12.5h7.5M2 3.5h1.5M2 12.5h1.5" />
      <path d="M1.8 6l2.4 2-2.4 2z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IndentLess(p: GlyphProps) {
  return (
    <Svg {...p}>
      <path d="M6.5 3.5h7.5M6.5 8h7.5M6.5 12.5h7.5M2 3.5h1.5M2 12.5h1.5" />
      <path d="M4.2 6L1.8 8l2.4 2z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function LineHeight(p: GlyphProps) {
  return (
    <Svg {...p}>
      <path d="M6.5 3.5h7.5M6.5 8h7.5M6.5 12.5h7.5" />
      <path d="M3 2.6v10.8M1.6 4l1.4-1.4L4.4 4M1.6 12l1.4 1.4L4.4 12" />
    </Svg>
  );
}

/** Paragraph mark. Not stroked - a pilcrow is a letterform, so it is drawn as text at the
 *  same optical size as the stroked glyphs beside it. */
export function Pilcrow({ size = 14 }: GlyphProps) {
  return (
    <span aria-hidden="true" style={{ fontSize: size + 2, lineHeight: 1, fontFamily: 'var(--font-display)' }}>
      &para;
    </span>
  );
}
