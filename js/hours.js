/**
 * Client half of the closing sequence (SPEC §3).
 *
 * This is presentation only. The server decides everything and returns 423 with a
 * message if a write is refused — nothing here is a security control. Its job is to
 * make sure nobody is surprised: warn at 15 minutes, remind at 5 and 1, then show
 * clearly that the portal has gone read-only.
 */

import { api } from './api.js';
import { setHours, state } from './state.js';
import { el, icon, modal, button, fmt } from './ui.js';
import { flushDrafts } from './drafts.js';

const POLL_MS = 60000;

let pollTimer = null;
let tickTimer = null;
let bannerHost = null;
let clockHost = null;
const shown = new Set();
let lastPhase = null;

export function start({ bannerContainer, clockContainer }) {
  bannerHost = bannerContainer;
  clockHost = clockContainer;
  paint();
  poll();
  pollTimer = setInterval(poll, POLL_MS);
  // The clock ticks locally between polls so the header time is never stale-looking.
  tickTimer = setInterval(tick, 1000);
}

export function stop() {
  clearInterval(pollTimer);
  clearInterval(tickTimer);
  pollTimer = null;
  tickTimer = null;
}

async function poll() {
  try {
    const hours = await api.get('/api/hours/state');
    const previous = state.hours;
    setHours(hours);

    // A new day, a new override or a reopened portal clears the "already shown"
    // memory so the reminders work again tomorrow.
    if (previous && previous.localDate !== hours.localDate) shown.clear();
    if (previous && !previous.override && hours.override) shown.clear();

    paint();
    reactToPhase(hours);
  } catch (err) {
    // A failed poll is not worth interrupting the user for; the next one will tell
    // us, and any actual write will surface its own error.
    console.warn('[hours] poll failed', err.message);
  }
}

let localOffsetMs = 0;

function tick() {
  if (!state.hours || !clockHost) return;
  const serverNow = new Date(Date.parse(state.hours.serverTime) + localOffsetMs);
  localOffsetMs += 1000;
  clockHost.textContent = fmt.time(serverNow.toISOString());
}

function paint() {
  if (!bannerHost) return;
  localOffsetMs = 0;
  const hours = state.hours;
  bannerHost.replaceChildren();
  if (!hours) return;

  if (clockHost) clockHost.textContent = fmt.time(hours.serverTime);

  const messages = [];

  if (hours.override) {
    messages.push({
      tone: 'info',
      text: `Hours extended until ${fmt.time(hours.override.expiresAt)} — ${hours.override.reason}`,
    });
  }

  if (hours.access === 'readOnly') {
    messages.push({
      tone: 'warn',
      text:
        hours.message ||
        'The portal is read-only. You can view, print and export, but not save changes.',
    });
  } else if (hours.phase === 'warning' && typeof hours.minutesToClose === 'number') {
    messages.push({
      tone: 'warn',
      text: `The portal closes at ${hours.closeTimeLabel} — ${hours.minutesToClose} minute${
        hours.minutesToClose === 1 ? '' : 's'
      } left. Finish and save what you are working on.`,
    });
  } else if (hours.phase === 'grace') {
    messages.push({
      tone: 'warn',
      text: `Closing time has passed. Saves are still accepted for a few more minutes, but do not start anything new.`,
    });
  } else if (hours.phase === 'closed' || hours.phase === 'beforeOpen') {
    messages.push({
      tone: 'info',
      text: hours.reason
        ? `${hours.reason}. ${describeNext(hours)}`
        : describeNext(hours),
    });
  }

  if (state.license && state.license.message) {
    messages.push({
      tone: state.license.severity === 'critical' ? 'bad' : state.license.severity === 'warning' ? 'warn' : 'info',
      text: state.license.message,
    });
  }

  for (const message of messages) {
    bannerHost.appendChild(bannerNode(message.text, message.tone));
  }
}

function describeNext(hours) {
  if (!hours.nextOpening) return 'The portal is closed.';
  const when =
    hours.nextOpening.offset === 0
      ? 'today'
      : hours.nextOpening.offset === 1
        ? 'tomorrow'
        : `on ${hours.nextOpening.dayName}`;
  return `The portal is closed. It opens ${when} at ${fmt.time(hours.nextOpening.open)}.`;
}

function bannerNode(text, tone) {
  const map = { info: 'banner-info', warn: 'banner-warn', bad: 'banner-bad' };
  return el('div', { class: `${map[tone] || map.info} no-print` }, [
    icon(tone === 'bad' ? 'error' : tone === 'warn' ? 'warning' : 'info'),
    el('span', { class: 'flex-1', text }),
  ]);
}

/**
 * Modals at 5 and 1 minutes, and once when read-only begins. Each fires once per
 * day so a user working through the evening is not nagged every minute.
 */
function reactToPhase(hours) {
  const minutes = hours.minutesToClose;

  if (hours.phase === 'warning' && typeof minutes === 'number') {
    if (minutes <= 5 && minutes > 1) showOnce('five', closingModal(hours, minutes));
    if (minutes <= 1) showOnce('one', closingModal(hours, minutes));
  }

  if (hours.access === 'readOnly' && lastPhase !== 'readonly') {
    showOnce('readonly', () =>
      modal({
        title: 'The portal is now read-only',
        size: 'sm',
        body: [
          el('p', {
            class: 'text-sm text-ink-700',
            text:
              hours.message ||
              'Closing time has passed. You can still look things up, print and export, but changes will not save.',
          }),
          el('p', {
            class: 'mt-2 text-xs text-ink-500',
            text: 'Anything you had half-typed has been kept on this device and will be offered back next time you sign in.',
          }),
        ],
        actions: (close) => [button('I understand', { variant: 'primary', onClick: close })],
      })
    );
    // Anything half-typed is stashed now, while the user is still on the page.
    flushDrafts();
  }

  lastPhase = hours.access === 'readOnly' ? 'readonly' : hours.phase;
}

function closingModal(hours, minutes) {
  return () =>
    modal({
      title: minutes <= 1 ? 'Closing in a minute' : `Closing in ${minutes} minutes`,
      size: 'sm',
      body: [
        el('p', {
          class: 'text-sm text-ink-700',
          text: `The portal closes at ${hours.closeTimeLabel}. Save what you are working on now.`,
        }),
        el('p', {
          class: 'mt-2 text-xs text-ink-500',
          text: 'Saves are accepted for a short grace period after closing. After that the portal becomes read-only until it reopens.',
        }),
      ],
      actions: (close) => [button('Dismiss', { variant: 'primary', onClick: close })],
    });
}

function showOnce(key, open) {
  if (shown.has(key)) return;
  shown.add(key);
  open();
}

/** Screens call this before offering a save button. */
export function blockedMessage() {
  if (state.hours?.access === 'readOnly') {
    return (
      state.hours.message ||
      'The portal is read-only right now, so this cannot be saved. You can still print and export.'
    );
  }
  if (state.license?.canWrite === false) return state.license.message;
  return null;
}

export function refresh() {
  return poll();
}
