// The public marketing page at "/". A signed-out visitor lands here; a signed-in one
// never sees it (see RootRoute in main.tsx), so nothing below assumes a session.
//
// Section order is the whole of this file's job. Each section owns its own markup and
// takes no props, so one can be reordered or dropped without touching the others.
import { useRef } from 'react';
import MarketingNav from './sections/MarketingNav';
import Hero from './sections/Hero';
import CapabilityStrip from './sections/CapabilityStrip';
import WeekSpine from './sections/WeekSpine';
import FeatureBento from './sections/FeatureBento';
import AiBand from './sections/AiBand';
import DesktopBand from './sections/DesktopBand';
import MakerNote from './sections/MakerNote';
import ClosingCta from './sections/ClosingCta';
import useReveals from './useReveals';
import './marketing.css';

export default function LandingPage() {
  const root = useRef<HTMLDivElement>(null);
  // Owns the page's scroll motion for every section at once. It arms itself only when
  // motion is allowed, so .is-armed is also the switch that lets the CSS hide anything.
  const armed = useReveals(root);

  return (
    // .mkt carries the page's own palette. The landing commits to the light,
    // paper-and-ink look in BOTH themes - see the token block in marketing.css.
    <div className={`mkt${armed ? ' is-armed' : ''}`} ref={root}>
      <MarketingNav />
      <main id="main">
        <Hero />
        <CapabilityStrip />
        {/* The strip claims Unote replaces six things; the spine is where that claim gets
            demonstrated rather than asserted, by walking one note through a week. It has to
            sit before the feature grid, because the grid is now the reference list for a
            loop the reader has already been shown. */}
        <WeekSpine />
        <FeatureBento />
        <AiBand />
        {/* After the product has argued for itself, before the maker note. Somebody who has not
            decided they want the notebook does not care which window it opens in. */}
        <DesktopBand />
        <MakerNote />
        <ClosingCta />
      </main>
    </div>
  );
}
