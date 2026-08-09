// Minimal hand-rolled icon set (stroke, currentColor) so UI chrome doesn't
// depend on an icon package that isn't in the workspace. Emoji are used
// elsewhere for content identity (notebook emoji, wordmark); these are for
// interactive chrome only.
import type { CSSProperties, ReactNode } from 'react';

export type IconName =
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'x'
  | 'check'
  | 'plus'
  | 'search'
  | 'menu'
  | 'more'
  | 'trash'
  | 'archive'
  | 'unarchive'
  | 'pencil'
  | 'sun'
  | 'moon'
  | 'home'
  | 'layers'
  | 'sparkles'
  | 'upload'
  | 'copy'
  | 'move'
  | 'refresh'
  | 'pin'
  | 'pin-filled'
  | 'alert-circle'
  | 'info'
  | 'folder-plus'
  | 'gem'
  | 'blocks'
  | 'cloud'
  | 'phone'
  | 'palette'
  | 'camera'
  | 'file-text'
  | 'download'
  | 'rotate-ccw'
  | 'link'
  | 'sparkles-off'
  | 'lock'
  | 'log-out'
  | 'smile'
  // canvas boards + stylus ink
  | 'canvas'
  | 'cursor'
  | 'hand'
  | 'sticky'
  | 'type'
  | 'image'
  | 'square'
  | 'circle'
  | 'arrow-right'
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'undo'
  | 'redo'
  | 'maximize'
  | 'bring-front'
  | 'send-back';

const paths: Record<IconName, ReactNode> = {
  'chevron-left': <polyline points="15 18 9 12 15 6" />,
  'chevron-right': <polyline points="9 18 15 12 9 6" />,
  'chevron-down': <polyline points="6 9 12 15 18 9" />,
  x: (
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>
  ),
  check: <polyline points="20 6 9 17 4 12" />,
  plus: (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>
  ),
  menu: (
    <>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  trash: (
    <>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
      <line x1="10" y1="13" x2="14" y2="13" />
    </>
  ),
  unarchive: (
    <>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
      <polyline points="9.5 14.5 12 12 14.5 14.5" />
      <line x1="12" y1="12" x2="12" y2="18" />
    </>
  ),
  pencil: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </>
  ),
  moon: <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />,
  home: (
    <>
      <path d="M3 9.5 12 3l9 6.5" />
      <path d="M5 10v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10" />
    </>
  ),
  layers: (
    <>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </>
  ),
  sparkles: (
    <path d="M12 2 13.4 9 20.5 12 13.4 15 12 22 10.6 15 3.5 12 10.6 9Z" />
  ),
  upload: (
    <>
      <path d="M12 16V4" />
      <polyline points="6 10 12 4 18 10" />
      <path d="M4 20h16" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </>
  ),
  move: (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <polyline points="9.5 12.5 12.5 15.5 15.5 12.5" />
      <line x1="12.5" y1="10" x2="12.5" y2="15.5" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <polyline points="21 3 21 9 15 9" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-7-6.3-7-11a7 7 0 1 1 14 0c0 4.7-7 11-7 11Z" />
      <circle cx="12" cy="10" r="2.4" />
    </>
  ),
  'pin-filled': (
    <path
      d="M12 21s-7-6.3-7-11a7 7 0 1 1 14 0c0 4.7-7 11-7 11Z"
      fill="currentColor"
      stroke="currentColor"
    />
  ),
  'alert-circle': (
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="8" x2="12" y2="12.5" />
      <circle cx="12" cy="16" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <circle cx="12" cy="8" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  camera: (
    <>
      <path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <circle cx="12" cy="12.5" r="3.2" />
    </>
  ),
  'file-text': (
    <>
      <path d="M6 2h7l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" />
      <polyline points="13 2 13 7 18 7" />
      <line x1="8.5" y1="12" x2="15" y2="12" />
      <line x1="8.5" y1="15.5" x2="15" y2="15.5" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11" />
      <polyline points="7 11 12 16 17 11" />
      <path d="M4 20h16" />
    </>
  ),
  'rotate-ccw': (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <polyline points="3 4 3 9 8 9" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </>
  ),
  'sparkles-off': (
    <>
      <path d="M12 2 13.4 9 20.5 12 13.4 15 12 22 10.6 15 3.5 12 10.6 9Z" />
      <line x1="4" y1="4" x2="20" y2="20" />
    </>
  ),
  'folder-plus': (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <line x1="12" y1="10" x2="12" y2="16" />
      <line x1="9" y1="13" x2="15" y2="13" />
    </>
  ),
  // Import-source glyphs. Generic shapes suggesting each tool's own idea of itself - a cut
  // gem, a grid of blocks, a cloud - rather than reproductions of their logos, which are
  // trademarks and would sit badly next to a hand-drawn stroke set anyway.
  gem: (
    <>
      <path d="M6 3h12l3 6-9 12-9-12Z" />
      <path d="M3 9h18" />
      <path d="M9.5 9 12 21 14.5 9 12 3Z" />
    </>
  ),
  blocks: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  cloud: <path d="M7 19a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 18 9.6 4 4 0 0 1 17.5 19Z" />,
  phone: (
    <>
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <line x1="11" y1="18" x2="13" y2="18" />
    </>
  ),
  palette: (
    <>
      <path d="M12 21a9 9 0 1 1 0-18c4 0 8 2 8 6.5 0 2-1.5 3.5-3.5 3.5H15a1.5 1.5 0 0 0-1 2.6c.4.4.6.9.6 1.4 0 1.1-1 2-2.1 2Z" />
      <circle cx="7.3" cy="10.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="9.5" cy="6.8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="6.8" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="10.5" width="16" height="10.5" rx="2" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    </>
  ),
  'log-out': (
    <>
      <path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3" />
      <polyline points="15.5 16.5 20 12 15.5 7.5" />
      <line x1="20" y1="12" x2="9.5" y2="12" />
    </>
  ),
  smile: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <line x1="9" y1="9" x2="9.01" y2="9" />
      <line x1="15" y1="9" x2="15.01" y2="9" />
    </>
  ),

  // --- canvas boards + stylus ink ---
  // A framed board with two connected nodes - reads as "board", and stays legible
  // at the 12-14px the sidebar and note cards render it at.
  canvas: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <rect x="6" y="7.5" width="5" height="4" rx="1" />
      <rect x="13" y="12.5" width="5" height="4" rx="1" />
      <path d="M11 9.5h1.2a1.8 1.8 0 0 1 1.8 1.8v1.2" />
    </>
  ),
  cursor: <path d="M5 3l6.5 16 2.2-6.3 6.3-2.2z" />,
  hand: (
    <>
      <path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M12 11V4.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M15 11.5V6.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-5.2-3l-2-3.4a1.5 1.5 0 0 1 2.4-1.8L9 15" />
    </>
  ),
  // Sticky note: a square with the classic peeled corner.
  sticky: <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5V14l-6 6H5.5A1.5 1.5 0 0 1 4 18.5zM20 14h-4.5A1.5 1.5 0 0 0 14 15.5V20" />,
  type: (
    <>
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="9" y1="20" x2="15" y2="20" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="M21 16l-5-5-5.5 5.5L8 14l-5 5" />
    </>
  ),
  square: <rect x="4" y="4" width="16" height="16" rx="2" />,
  circle: <ellipse cx="12" cy="12" rx="9" ry="7.5" />,
  'arrow-right': (
    <>
      <line x1="4" y1="12" x2="19" y2="12" />
      <polyline points="13 6 19 12 13 18" />
    </>
  ),
  pen: (
    <>
      <path d="M15.5 3.5l5 5L8 21l-5.5 1.5L4 17z" />
      <line x1="13" y1="6" x2="18" y2="11" />
    </>
  ),
  highlighter: (
    <>
      <path d="M13 3.5l7.5 7.5-7 7H8l-3.5-3.5z" />
      <line x1="3" y1="21.2" x2="21" y2="21.2" strokeWidth="2.4" />
    </>
  ),
  eraser: (
    <>
      <path d="M8.5 20H20" />
      <path d="M14.5 3.5l6 6a1.5 1.5 0 0 1 0 2.1l-7.2 7.2a1.5 1.5 0 0 1-2.1 0l-6-6a1.5 1.5 0 0 1 0-2.1l7.2-7.2a1.5 1.5 0 0 1 2.1 0z" />
      <line x1="8" y1="8" x2="16" y2="16" />
    </>
  ),
  undo: (
    <>
      <polyline points="3 8 3 14 9 14" />
      <path d="M3.5 14a8 8 0 1 1 2.2 5.3" />
    </>
  ),
  redo: (
    <>
      <polyline points="21 8 21 14 15 14" />
      <path d="M20.5 14a8 8 0 1 0-2.2 5.3" />
    </>
  ),
  // Zoom-to-fit: four corners pulling outward.
  maximize: <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />,
  'bring-front': (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" fill="currentColor" stroke="none" opacity="0.85" />
      <path d="M4 16V6a2 2 0 0 1 2-2h10" />
    </>
  ),
  'send-back': (
    <>
      <rect x="4" y="4" width="12" height="12" rx="2" fill="currentColor" stroke="none" opacity="0.85" />
      <path d="M20 8v10a2 2 0 0 1-2 2H8" />
    </>
  ),
};

/** Runtime membership test for the icon set - lets callers accept a string that is
 *  either an Icon name (rendered as a vector) or a plain text glyph. */
export function isIconName(value: string): value is IconName {
  return value in paths;
}

export default function Icon({
  name,
  size = 16,
  strokeWidth = 1.8,
  className,
  style,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
