// Mounts the three onboarding surfaces and owns the decision of when the tutorial
// opens by itself.
//
// It auto-opens exactly once, for an account that has never answered the offer. Any
// other appearance is because the user asked for it - from the account menu, the
// command palette, or the "?" key. A tour that was left part-way through is NOT
// reopened automatically: pressing Escape said something, and re-ambushing the user
// with the same card on the next page load is precisely the behaviour the brief
// rules out. They get one dismissible toast with a Resume button instead.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '../../components/Toast';
import { useAuth } from '../auth/AuthContext';
import { useGuestHandoverPending } from '../guest/guestMode';
import TourOverlay from './TourOverlay';
import ShortcutsSheet from './ShortcutsSheet';
import HintHost, { suppressHintsThisSession } from './HintHost';
import { _subscribeOnboarding } from './onboardingBus';
import { bindUser, getOnboarding, restartTour, useOnboarding } from './onboardingStore';
import { ensureReadme } from '../readme/ensureReadme';

export default function OnboardingHost({
  shortcutsOpen,
  onShortcutsChange,
}: {
  /** Lifted so the App shell's "?" handler and the command palette can both drive it. */
  shortcutsOpen: boolean;
  onShortcutsChange: (open: boolean) => void;
}) {
  const { user } = useAuth();
  // Must run before the first `useOnboarding()` read, or the hook's lazy initial
  // state captures the previous (or empty) record. `bindUser` is idempotent, so a
  // re-render with an unchanged id costs nothing.
  useMemo(() => bindUser(user?.id ?? null), [user?.id]);
  const state = useOnboarding();
  const handoverPending = useGuestHandoverPending();

  const [tourOpen, setTourOpen] = useState(false);
  const [resumeAt, setResumeAt] = useState(-1);
  const offeredResume = useRef(false);
  const autoOpened = useRef(false);

  const openTour = useCallback((from: number) => {
    setResumeAt(from);
    setTourOpen(true);
  }, []);

  // Auto-open for a genuinely new account, once per page load - but never over the guest
  // handover. An account made from guest mode arrives with browser-local notes whose fate
  // is undecided, and "would you like the tutorial?" is not the question to put in front
  // of someone one click away from orphaning their own work. The tour opens by itself as
  // soon as that has been answered.
  useEffect(() => {
    if (!user || autoOpened.current) return;
    if (handoverPending) return;
    if (getOnboarding().status !== 'unseen') return;
    autoOpened.current = true;
    // Fire and forget: the tutorial must not wait on a network round-trip, and
    // ensureReadme swallows its own failures.
    void ensureReadme();
    openTour(-1);
  }, [user, openTour, handoverPending]);

  // A part-finished tour is offered back once, as a toast that can simply be ignored.
  useEffect(() => {
    if (!user || tourOpen || offeredResume.current) return;
    if (state.status !== 'paused') return;
    offeredResume.current = true;
    const step = getOnboarding().step;
    toast('Your tutorial is part-finished.', 'info', {
      durationMs: 9000,
      action: { label: 'Resume', onClick: () => openTour(step) },
    });
  }, [user, state.status, tourOpen, openTour]);

  useEffect(
    () =>
      _subscribeOnboarding((surface) => {
        if (surface === 'shortcuts') {
          onShortcutsChange(true);
          return;
        }
        // "Restart tutorial" means from the top, welcome card and all - including the
        // seed offer, which is harmless the second time because the store remembers
        // the ids of what it already created and will not create a second copy.
        restartTour();
        openTour(-1);
      }),
    [openTour, onShortcutsChange],
  );

  const handleExit = useCallback((status: 'skipped' | 'done' | 'paused') => {
    setTourOpen(false);
    // Nothing else should start talking at them in the same breath.
    suppressHintsThisSession();
    // Suppress the resume toast for the rest of this page load too - pausing and
    // then immediately being told you paused is noise.
    offeredResume.current = true;
    if (status === 'done') {
      toast('That is the tour. Press ? any time for the shortcut list.', 'ok');
    }
    // useDialogFocus restores focus to whatever was focused when the tour opened. On
    // a new account that element is usually gone, because the tour navigated away
    // from the page it opened on - which drops focus to <body> and strands keyboard
    // users at the top of the document. Catch that one case.
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) {
        document.getElementById('folio-main')?.focus();
      }
    });
  }, []);

  if (!user) return null;

  return (
    <>
      {tourOpen && <TourOverlay resumeAt={resumeAt} onExit={handleExit} />}
      <ShortcutsSheet open={shortcutsOpen} onClose={() => onShortcutsChange(false)} />
      <HintHost tourRunning={tourOpen} />
    </>
  );
}
