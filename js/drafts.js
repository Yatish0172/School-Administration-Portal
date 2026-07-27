/**
 * Draft recovery (SPEC §3).
 *
 * In-progress forms are stashed in this device's localStorage, keyed to the user
 * and the form, and offered back on the next sign-in: "You have unsaved attendance
 * from yesterday."
 *
 * A teacher who was half-way through marking a class when the portal closed loses
 * nothing. Drafts never leave the device and are cleared the moment the real save
 * succeeds.
 */

import { state } from './state.js';
import { el, button, modal, fmt } from './ui.js';

const PREFIX = 'sap.draft.';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Registered live forms, so the closing sequence can stash them without asking. */
const live = new Map();

function keyFor(formId) {
  const userId = state.user?.id || 'anon';
  return `${PREFIX}${userId}.${formId}`;
}

function available() {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch (err) {
    return false;
  }
}

/**
 * @param {string} formId   stable id, e.g. `attendance.<sectionId>.<date>`
 * @param {object} payload  whatever the screen needs to restore itself
 * @param {object} meta     { label, route } shown in the recovery prompt
 */
export function save(formId, payload, meta = {}) {
  if (!available()) return false;
  try {
    window.localStorage.setItem(
      keyFor(formId),
      JSON.stringify({
        formId,
        payload,
        label: meta.label || formId,
        route: meta.route || window.location.hash,
        savedAt: new Date().toISOString(),
      })
    );
    return true;
  } catch (err) {
    // A full quota is not worth an error dialogue; the save button still works.
    console.warn('[drafts] could not store draft', err.message);
    return false;
  }
}

export function load(formId) {
  if (!available()) return null;
  try {
    const raw = window.localStorage.getItem(keyFor(formId));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (Date.parse(entry.savedAt) < Date.now() - MAX_AGE_MS) {
      clear(formId);
      return null;
    }
    return entry;
  } catch (err) {
    return null;
  }
}

export function clear(formId) {
  if (!available()) return;
  window.localStorage.removeItem(keyFor(formId));
  live.delete(formId);
}

export function list() {
  if (!available()) return [];
  const prefix = `${PREFIX}${state.user?.id || 'anon'}.`;
  const out = [];
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    try {
      const entry = JSON.parse(window.localStorage.getItem(key));
      if (Date.parse(entry.savedAt) < Date.now() - MAX_AGE_MS) {
        window.localStorage.removeItem(key);
        continue;
      }
      out.push(entry);
    } catch (err) {
      window.localStorage.removeItem(key);
    }
  }
  return out.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}

/**
 * Screens register a snapshot function; the closing sequence and the page-unload
 * handler call them all, so nothing is lost even if the user never pressed save.
 */
export function register(formId, snapshot, meta = {}) {
  live.set(formId, { snapshot, meta });
  return () => live.delete(formId);
}

export function flushDrafts() {
  for (const [formId, entry] of live) {
    try {
      const payload = entry.snapshot();
      if (payload && (!Array.isArray(payload) || payload.length)) {
        save(formId, payload, entry.meta);
      }
    } catch (err) {
      console.warn('[drafts] snapshot failed', err.message);
    }
  }
}

/** Offered once per sign-in, from app.js. */
export function offerRecovery(navigate) {
  const drafts = list();
  if (!drafts.length) return;

  modal({
    title: drafts.length === 1 ? 'You have unsaved work' : `You have ${drafts.length} pieces of unsaved work`,
    size: 'sm',
    body: [
      el('p', {
        class: 'text-sm text-ink-700',
        text: 'This was kept on this device when the portal closed or the page was left. Open it to carry on.',
      }),
      el(
        'ul',
        { class: 'mt-3 divide-y divide-ink-100' },
        drafts.map((draft) =>
          el('li', { class: 'flex items-center justify-between gap-3 py-2' }, [
            el('div', {}, [
              el('p', { class: 'text-sm font-medium text-ink-900', text: draft.label }),
              el('p', { class: 'text-xs text-ink-500', text: `Saved ${fmt.ago(draft.savedAt)}` }),
            ]),
            el('div', { class: 'flex gap-1' }, [
              button('Open', {
                size: 'sm',
                variant: 'primary',
                onClick: () => navigate(draft.route.replace(/^#/, '')),
              }),
              button('Discard', {
                size: 'sm',
                onClick: (event) => {
                  clear(draft.formId);
                  event.target.closest('li').remove();
                },
              }),
            ]),
          ])
        )
      ),
    ],
    actions: (close) => [button('Later', { onClick: close })],
  });
}

/** Last-ditch stash when the window is closing. */
export function installUnloadHandler() {
  window.addEventListener('pagehide', flushDrafts);
  window.addEventListener('beforeunload', flushDrafts);
}
