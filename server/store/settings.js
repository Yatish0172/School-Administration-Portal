'use strict';

const workbook = require('./workbook');
const crud = require('./crud');

/**
 * Typed key/value settings in System.xlsx. Values are stored as strings and cast
 * on read so a number setting never comes back as text and quietly breaks maths.
 */

const DEFINITIONS = {
  // School profile
  'school.name': { type: 'text', value: 'My School', category: 'School', label: 'School name' },
  'school.tagline': { type: 'text', value: '', category: 'School', label: 'Tagline' },
  'school.addressLine1': { type: 'text', value: '', category: 'School', label: 'Address line 1' },
  'school.addressLine2': { type: 'text', value: '', category: 'School', label: 'Address line 2' },
  'school.city': { type: 'text', value: '', category: 'School', label: 'City' },
  'school.state': { type: 'text', value: '', category: 'School', label: 'State' },
  'school.pincode': { type: 'text', value: '', category: 'School', label: 'PIN code' },
  'school.phone': { type: 'text', value: '', category: 'School', label: 'Phone' },
  'school.email': { type: 'text', value: '', category: 'School', label: 'Email' },
  'school.board': { type: 'text', value: 'CBSE', category: 'School', label: 'Board' },
  'school.affiliationNo': { type: 'text', value: '', category: 'School', label: 'Affiliation number' },
  'school.logoFile': { type: 'text', value: '', category: 'School', label: 'Logo file' },
  'school.principalName': { type: 'text', value: '', category: 'School', label: 'Principal name' },

  // Access hours (schedule rows live in AccessHours; these are the knobs)
  'hours.timezone': { type: 'text', value: 'Asia/Kolkata', category: 'Hours', label: 'Timezone', readOnly: true },
  'hours.graceMinutes': { type: 'num', value: 15, category: 'Hours', label: 'Closing grace (minutes)' },
  'hours.warningLeadMinutes': { type: 'num', value: 15, category: 'Hours', label: 'Warning lead (minutes)' },
  'hours.sessionEndMinutesAfterGrace': { type: 'num', value: 30, category: 'Hours', label: 'Session ends N minutes after grace' },
  'hours.enabled': { type: 'bool', value: true, category: 'Hours', label: 'Enforce school hours' },

  // Security
  'security.sessionIdleMinutes': { type: 'num', value: 30, category: 'Security', label: 'Idle timeout (minutes)' },
  'security.lockoutThreshold': { type: 'num', value: 5, category: 'Security', label: 'Failed attempts before lockout' },
  'security.lockoutMinutes': { type: 'num', value: 15, category: 'Security', label: 'Lockout duration (minutes)' },
  'security.minPasswordLength': { type: 'num', value: 8, category: 'Security', label: 'Minimum password length' },
  'security.pinLength': { type: 'num', value: 6, category: 'Security', label: 'PIN length' },

  // Devices
  //
  // Off by default: remote access hands out a fresh link every day, and a rotated
  // hostname drops the deviceId cookie with it — so enforcing enrollment would
  // de-register every remote user daily and hit the per-user device cap within
  // three days. Staff sign in with their username and password instead.
  //
  // The enrollment machinery is all still here. Turn this back on and it works as
  // before; pair that with `remote.rotateDaily` off, or a named tunnel on a fixed
  // hostname, so the cookie survives.
  'devices.enforce': { type: 'bool', value: false, category: 'Devices', label: 'Require enrolled devices' },
  'devices.capPerUser': { type: 'num', value: 2, category: 'Devices', label: 'Devices per user' },
  'devices.codeValidMinutes': { type: 'num', value: 10, category: 'Devices', label: 'Enrollment code validity (minutes)' },

  // Attendance
  'attendance.lockHours': { type: 'num', value: 24, category: 'Attendance', label: 'Lock attendance after (hours)' },
  'attendance.periodWise': { type: 'bool', value: false, category: 'Attendance', label: 'Period-wise attendance' },
  'attendance.defaulterThreshold': { type: 'num', value: 75, category: 'Attendance', label: 'Defaulter threshold (%)' },

  // Fees
  'fees.lateFeePerDay': { type: 'num', value: 0, category: 'Fees', label: 'Late fee per day' },
  'fees.lateFeeGraceDays': { type: 'num', value: 0, category: 'Fees', label: 'Late fee grace (days)' },
  'fees.reversalNeedsApproval': { type: 'bool', value: true, category: 'Fees', label: 'Reversals need approval' },
  'fees.receiptFooter': { type: 'text', value: 'This is a computer-generated receipt.', category: 'Fees', label: 'Receipt footer' },

  // Library
  'library.loanDays': { type: 'num', value: 14, category: 'Library', label: 'Loan period (days)' },
  'library.finePerDay': { type: 'num', value: 1, category: 'Library', label: 'Fine per day' },
  'library.maxRenewals': { type: 'num', value: 2, category: 'Library', label: 'Maximum renewals' },
  'library.maxBooksStudent': { type: 'num', value: 2, category: 'Library', label: 'Books per student' },

  // Uploads
  'uploads.maxSizeMb': { type: 'num', value: 5, category: 'Uploads', label: 'Maximum upload size (MB)' },

  // Backup
  'backup.dailyHour': { type: 'num', value: 20, category: 'Backup', label: 'Daily backup hour (0-23)' },
  'backup.retainDaily': { type: 'num', value: 30, category: 'Backup', label: 'Daily copies retained' },
  'backup.retainMonthly': { type: 'num', value: 12, category: 'Backup', label: 'Monthly copies retained' },
  'backup.secondaryPath': { type: 'text', value: '', category: 'Backup', label: 'Second drive / USB path' },

  // Remote access over a Cloudflare tunnel. This is the primary way staff reach the
  // portal, so it opens on startup. It needs `cloudflared` on the PC; if that is
  // missing the portal still comes up on the LAN and says how to install it.
  'remote.enabled': { type: 'bool', value: true, category: 'Remote access', label: 'Allow access from outside the school' },
  'remote.rotateDaily': { type: 'bool', value: true, category: 'Remote access', label: 'Issue a new link every day' },
  'remote.rotateHour': { type: 'num', value: 3, category: 'Remote access', label: 'Hour to issue the new link (0-23)' },
  'remote.cloudflaredPath': { type: 'text', value: '', category: 'Remote access', label: 'Path to cloudflared (leave blank to find it automatically)' },
  'remote.currentUrl': { type: 'text', value: '', category: 'Remote access', label: 'Current remote link', hidden: true },
  'remote.startedAt': { type: 'text', value: '', category: 'Remote access', label: 'Remote access opened at', hidden: true },
  'remote.rotatedAt': { type: 'text', value: '', category: 'Remote access', label: 'Link last rotated', hidden: true },

  // The school Wi-Fi is the optional second route in, kept on because it is the
  // only one that works when the internet is down. Switching it off binds the
  // server to this PC alone, so the Cloudflare link becomes the only way in —
  // including for staff sitting in the building.
  'network.lanEnabled': { type: 'bool', value: true, category: 'Network', label: 'Also allow direct access over the school Wi-Fi' },

  // Runtime state, not user-facing
  'system.lastLanIp': { type: 'text', value: '', category: 'System', label: 'Last known LAN IP', hidden: true },
  'system.lastSeenClock': { type: 'text', value: '', category: 'System', label: 'Last recorded server time', hidden: true },
  'system.currentAcademicYearId': { type: 'text', value: '', category: 'System', label: 'Current academic year', hidden: true },
  'system.lastBackupAt': { type: 'text', value: '', category: 'System', label: 'Last successful backup', hidden: true },
  'system.setupComplete': { type: 'bool', value: false, category: 'System', label: 'Setup complete', hidden: true },
};

function cast(value, type) {
  if (value === null || value === undefined) return null;
  if (type === 'num') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (type === 'bool') {
    return value === true || value === 'true' || value === 1 || value === '1';
  }
  if (type === 'json') {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch (err) {
      return null;
    }
  }
  return String(value);
}

function serialise(value, type) {
  if (value === null || value === undefined) return '';
  if (type === 'json') return JSON.stringify(value);
  if (type === 'bool') return value ? 'true' : 'false';
  return String(value);
}

async function all() {
  const rows = await workbook.read('System', 'Settings');
  const out = {};
  for (const [key, def] of Object.entries(DEFINITIONS)) {
    out[key] = def.value;
  }
  for (const row of rows) {
    if (!row.key) continue;
    const def = DEFINITIONS[row.key];
    const type = row.valueType || def?.type || 'text';
    out[row.key] = cast(row.value, type);
  }
  return out;
}

async function get(key, fallback) {
  const rows = await workbook.read('System', 'Settings');
  const row = rows.find((r) => r.key === key);
  const def = DEFINITIONS[key];
  if (!row) return fallback !== undefined ? fallback : def ? def.value : null;
  return cast(row.value, row.valueType || def?.type || 'text');
}

async function getMany(keys) {
  const snapshot = await all();
  const out = {};
  for (const key of keys) out[key] = snapshot[key];
  return out;
}

/** Applies in memory; caller holds the System lock. */
function setIn(api, key, value, ctx) {
  const def = DEFINITIONS[key] || { type: 'text', category: 'Custom', label: key };
  const rows = api.rows('Settings');
  const index = rows.findIndex((r) => r.key === key);
  const payload = {
    key,
    value: serialise(value, def.type),
    valueType: def.type,
    category: def.category,
    label: def.label,
  };
  if (index === -1) {
    return crud.insertInto(api, 'System', 'Settings', payload, ctx);
  }
  return crud.updateIn(api, 'System', 'Settings', rows[index].id, payload, ctx, {
    label: 'setting',
  });
}

async function set(key, value, ctx) {
  return workbook.mutate('System', (api) => setIn(api, key, value, ctx), {
    label: `set ${key}`,
  });
}

async function setMany(patch, ctx) {
  return workbook.mutate(
    'System',
    (api) => {
      const applied = {};
      for (const [key, value] of Object.entries(patch)) {
        if (DEFINITIONS[key] && DEFINITIONS[key].readOnly) continue;
        setIn(api, key, value, ctx);
        applied[key] = value;
      }
      return applied;
    },
    { label: 'setMany settings' }
  );
}

async function seedDefaults(ctx) {
  return workbook.mutate(
    'System',
    (api) => {
      const rows = api.rows('Settings');
      const created = [];
      for (const [key, def] of Object.entries(DEFINITIONS)) {
        if (rows.some((r) => r.key === key)) continue;
        created.push(setIn(api, key, def.value, ctx));
      }
      return created;
    },
    { label: 'seed settings' }
  );
}

/** Definitions minus hidden runtime keys — drives the Settings screen. */
function editableDefinitions() {
  return Object.entries(DEFINITIONS)
    .filter(([, def]) => !def.hidden)
    .map(([key, def]) => ({ key, ...def }));
}

module.exports = {
  DEFINITIONS,
  all,
  get,
  getMany,
  set,
  setIn,
  setMany,
  seedDefaults,
  editableDefinitions,
};
