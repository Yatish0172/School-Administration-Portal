'use strict';

const workbook = require('./workbook');
const crud = require('./crud');

/**
 * Sequence numbers come from here and nowhere else (CLAUDE.md §7).
 * Never `rows.length + 1` — that hands two parents the same receipt number the
 * first time two writes interleave or a row is cancelled.
 */

const DEFAULTS = {
  admissionNo: { prefix: 'ADM', padding: 5, current: 0 },
  receiptNo: { prefix: 'RCP', padding: 6, current: 0 },
  invoiceNo: { prefix: 'INV', padding: 6, current: 0 },
  enquiryNo: { prefix: 'ENQ', padding: 5, current: 0 },
  staffCode: { prefix: 'STF', padding: 4, current: 0 },
  accessionNo: { prefix: 'ACC', padding: 6, current: 0 },
  tcNumber: { prefix: 'TC', padding: 4, current: 0 },
};

function format(prefix, padding, value) {
  const digits = String(value).padStart(Number(padding) || 0, '0');
  return `${prefix || ''}${digits}`;
}

/**
 * Increments the counter in memory. Caller must already hold the System lock —
 * the increment has to happen inside the same lock as the write that consumes it.
 */
function nextIn(systemApi, name, ctx) {
  const rows = systemApi.rows('Counters');
  let index = rows.findIndex((r) => r.name === name);
  if (index === -1) {
    const seed = DEFAULTS[name] || { prefix: '', padding: 0, current: 0 };
    crud.insertInto(systemApi, 'System', 'Counters', { name, ...seed, scope: 'global' }, ctx);
    index = rows.length - 1;
  }
  const row = rows[index];
  const nextValue = Number(row.current || 0) + 1;
  rows[index] = {
    ...row,
    current: nextValue,
    _rev: Number(row._rev || 1) + 1,
    updatedBy: crud.actorOf(ctx),
    updatedAt: crud.nowIso(),
  };
  return {
    value: nextValue,
    formatted: format(row.prefix, row.padding, nextValue),
  };
}

/** Standalone allocation for callers that are not already inside a System write. */
async function next(name, ctx) {
  return workbook.mutate('System', (api) => nextIn(api, name, ctx), {
    label: `counter ${name}`,
  });
}

async function peek(name) {
  const rows = await workbook.read('System', 'Counters');
  const row = rows.find((r) => r.name === name);
  if (!row) {
    const seed = DEFAULTS[name] || { prefix: '', padding: 0, current: 0 };
    return { name, ...seed, nextFormatted: format(seed.prefix, seed.padding, 1) };
  }
  return {
    name: row.name,
    prefix: row.prefix,
    padding: row.padding,
    current: row.current,
    nextFormatted: format(row.prefix, row.padding, Number(row.current || 0) + 1),
  };
}

async function listAll() {
  const rows = await workbook.read('System', 'Counters');
  return rows.map((r) => ({
    id: r.id,
    _rev: r._rev,
    name: r.name,
    prefix: r.prefix,
    padding: r.padding,
    current: r.current,
    nextFormatted: format(r.prefix, r.padding, Number(r.current || 0) + 1),
  }));
}

/**
 * Admins configure the prefix and padding (e.g. admission numbers as `2026/0001`).
 * `current` is deliberately not editable through the UI — moving it backwards
 * would reissue numbers that already exist on printed receipts.
 */
async function configure(name, { prefix, padding }, ctx) {
  return workbook.mutate(
    'System',
    (api) => {
      const rows = api.rows('Counters');
      const index = rows.findIndex((r) => r.name === name);
      const patch = {};
      if (prefix !== undefined) patch.prefix = prefix;
      if (padding !== undefined) patch.padding = Number(padding) || 0;
      if (index === -1) {
        const seed = DEFAULTS[name] || { prefix: '', padding: 0, current: 0 };
        return crud.insertInto(
          api,
          'System',
          'Counters',
          { name, ...seed, ...patch, scope: 'global' },
          ctx
        );
      }
      return crud.updateIn(api, 'System', 'Counters', rows[index].id, patch, ctx, {
        label: 'counter',
      });
    },
    { label: `configure counter ${name}` }
  );
}

async function seedDefaults(ctx) {
  return workbook.mutate(
    'System',
    (api) => {
      const rows = api.rows('Counters');
      const created = [];
      for (const [name, seed] of Object.entries(DEFAULTS)) {
        if (rows.some((r) => r.name === name)) continue;
        created.push(
          crud.insertInto(api, 'System', 'Counters', { name, ...seed, scope: 'global' }, ctx)
        );
      }
      return created;
    },
    { label: 'seed counters' }
  );
}

module.exports = { DEFAULTS, next, nextIn, peek, listAll, configure, seedDefaults, format };
