'use strict';

const settings = require('../store/settings');
const audit = require('../store/audit');
const hours = require('./hours');

/**
 * Clock integrity (SPEC §3). The PC is offline so its clock drifts unnoticed, and
 * every hours decision depends on it.
 *
 * This is an operational check, not a security boundary — anyone with physical
 * access to the server PC can change the clock. That is stated plainly on the
 * Access screen.
 */

const BACKWARDS_TOLERANCE_MS = 60000; // ignore sub-minute jitter

let lastWarning = null;

async function check(ctx) {
  const now = new Date();
  const recorded = await settings.get('system.lastSeenClock', '');
  const result = {
    serverTime: now.toISOString(),
    localTime: hours.parts(now).time,
    localDate: hours.parts(now).date,
    timezone: hours.TIMEZONE,
    lastSeen: recorded || null,
    movedBackwards: false,
    driftMs: 0,
    message: null,
  };

  if (recorded) {
    const previous = Date.parse(recorded);
    if (Number.isFinite(previous)) {
      const drift = previous - now.getTime();
      if (drift > BACKWARDS_TOLERANCE_MS) {
        result.movedBackwards = true;
        result.driftMs = drift;
        const minutes = Math.round(drift / 60000);
        result.message =
          `The server clock has moved backwards by about ${describeDrift(minutes)}. ` +
          'School-hours access and receipt dates depend on this clock — check the date and time on the server PC.';
        lastWarning = result;
        await audit
          .log({
            action: audit.ACTIONS.CLOCK_WARNING,
            entityType: 'system',
            entityId: 'clock',
            before: { lastSeen: recorded },
            after: { now: result.serverTime },
            message: result.message,
            actor: ctx,
            flush: true,
          })
          .catch(() => {});
        console.warn(`[clock] ${result.message}`);
      }
    }
  }

  await settings.set('system.lastSeenClock', result.serverTime, ctx);
  return result;
}

function describeDrift(minutes) {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const h = Math.round(minutes / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  return `${Math.round(h / 24)} days`;
}

/** Keeps the recorded time fresh so a backwards jump is caught next start. */
function startHeartbeat(intervalMs = 300000) {
  const timer = setInterval(() => {
    settings
      .set('system.lastSeenClock', new Date().toISOString(), { userId: 'system' })
      .catch(() => {});
  }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

function lastWarningState() {
  return lastWarning;
}

module.exports = { check, startHeartbeat, lastWarningState };
