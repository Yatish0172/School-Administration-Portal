'use strict';

/**
 * One mutex per workbook (CLAUDE.md §3). Reads never lock; every write does.
 * Implemented as a promise chain per key — the next waiter runs only after the
 * previous one settles, so writes to the same workbook are strictly serialised.
 */

const chains = new Map();
const held = new Map();

const DEFAULT_TIMEOUT_MS = 30000;

function withLock(name, fn, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const previous = chains.get(name) || Promise.resolve();

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  // The chain advances even if fn throws, otherwise one failed write would
  // deadlock the workbook for the rest of the process lifetime.
  chains.set(
    name,
    previous.then(
      () => gate,
      () => gate
    )
  );

  const run = previous.then(
    () => guarded(),
    () => guarded()
  );

  async function guarded() {
    held.set(name, { since: Date.now(), label: options.label || '' });
    const timer = setTimeout(() => {
      // Not an abort — Excel writes cannot be cancelled safely. Surface it so a
      // stuck write is visible in the console rather than silently hanging.
      console.warn(
        `[lock] "${name}" held for over ${timeoutMs}ms (${options.label || 'unlabelled'})`
      );
    }, timeoutMs);
    try {
      return await fn();
    } finally {
      clearTimeout(timer);
      held.delete(name);
      release();
    }
  }

  return run;
}

/** Acquire several workbook locks in a stable order. Sorting prevents deadlock. */
async function withLocks(names, fn, options = {}) {
  const ordered = [...new Set(names)].sort();
  if (ordered.length === 0) return fn();
  const [first, ...rest] = ordered;
  return withLock(first, () => withLocks(rest, fn, options), options);
}

function isLocked(name) {
  return held.has(name);
}

function heldLocks() {
  return [...held.entries()].map(([name, info]) => ({
    name,
    heldMs: Date.now() - info.since,
    label: info.label,
  }));
}

module.exports = { withLock, withLocks, isLocked, heldLocks };
