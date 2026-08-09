// What the app tells you about being offline.
//
// The framing matters more than the markup here. For this app offline is a NORMAL
// state, not a fault: the whole point of the local mirror is that losing the network
// changes nothing about whether your work is safe. So this says what is true of the
// user's data - "saved on this device" - rather than reporting a technical condition
// like "connection lost", which invites people to stop typing and go looking for
// Wi-Fi in the middle of a lecture.
//
// It also disappears entirely when there is nothing to say. A permanent green
// "Online / Synced" badge is noise that trains people to ignore the space where the
// real message will appear.
import { useEffect, useState } from 'react';
import Icon from './Icon';
import { isOnline, subscribeConnectivity } from '../lib/sync/connectivity';
import { pendingCount } from '../lib/local/outbox';
import { isGuest } from '../features/guest/guestMode';
import './connection-status.css';

/** How often to re-count while something is waiting to be sent. */
const PENDING_POLL_MS = 5000;

export default function ConnectionStatus() {
  const [online, setOnline] = useState(isOnline);
  const [pending, setPending] = useState(0);

  useEffect(() => subscribeConnectivity(() => setOnline(isOnline())), []);

  useEffect(() => {
    let cancelled = false;

    const count = async () => {
      try {
        const n = await pendingCount();
        if (!cancelled) setPending(n);
      } catch {
        // The store is unavailable - private browsing, or a blocked upgrade. Not
        // worth an error surface: the banner simply stays quiet.
      }
    };

    void count();
    // Poll only while there is something outstanding OR we are offline (when the
    // count can still grow). Otherwise there is nothing to watch and a timer would
    // just wake the tab forever.
    if (pending === 0 && online) return () => { cancelled = true; };

    const id = window.setInterval(count, PENDING_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [online, pending]);

  // Guest mode already carries its own permanent banner saying nothing is saved.
  // Adding "offline, your notes are safe on this device" underneath it would be
  // flatly contradictory.
  if (isGuest()) return null;

  if (online && pending === 0) return null;

  const changes = `${pending} ${pending === 1 ? 'change' : 'changes'}`;

  return (
    <div
      className={`conn-status ${online ? 'conn-status--syncing' : 'conn-status--offline'}`}
      role="status"
      aria-live="polite"
      data-testid="connection-status"
    >
      {/* Icon's union has no cloud/wifi glyph; 'refresh' and 'archive' are the
          closest existing names, and adding SVGs is out of scope for Stage 1. */}
      <Icon name={online ? 'refresh' : 'archive'} size={14} />
      <span className="conn-status__text">
        {online ? (
          <>Syncing {changes}…</>
        ) : (
          <>
            <strong>Offline.</strong> Your notes are saved on this device
            {pending > 0 ? <> — {changes} will sync when you reconnect.</> : '.'}
          </>
        )}
      </span>
    </div>
  );
}
