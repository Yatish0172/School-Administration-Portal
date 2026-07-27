'use strict';

const errors = require('../errors');

/**
 * Login rate limiting (CLAUDE.md security rules). In-memory is the right scope —
 * there is one server process and no cluster.
 *
 * This sits in front of the per-account lockout: the lockout stops an attack on
 * one account, this stops a sweep across many accounts from one device.
 */
function rateLimit({ windowMs = 60000, max = 20, message } = {}) {
  const hits = new Map();

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, entry] of hits) {
      if (entry.start < cutoff) hits.delete(key);
    }
  }, windowMs);
  if (sweeper.unref) sweeper.unref();

  return (req, res, next) => {
    const key = req.clientIp || req.ip || 'unknown';
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      const waitSeconds = Math.ceil((entry.start + windowMs - now) / 1000);
      return next(
        errors.tooMany(
          message || `Too many attempts. Wait ${waitSeconds} seconds and try again.`
        )
      );
    }
    return next();
  };
}

module.exports = { rateLimit };
