# Build Backlog

Ordered tasks. **One task per Claude Code session.** Verify, commit, then start the next in a
fresh session.

---

## How to run this

**Setup (once)**

```bash
mkdir school-admin-portal && cd school-admin-portal
git init
# copy CLAUDE.md, SPEC.md, TASKS.md into the folder
git add . && git commit -m "Project docs"
claude
```

**Each task**

1. Start a fresh session (`claude`, or `/clear` if already open).
2. Paste the task prompt.
3. Read what it says it will do **before** letting it write.
4. Run the app, verify manually using the check listed.
5. `git add -A && git commit -m "T03: login and sessions"`
6. `/clear` and move to the next task.

**Why fresh sessions:** a long session fills with irrelevant history and quality drops. One
task, one session.

**Useful mid-task prompts**
- `That's more than I asked for. Revert the extra files and do only the task.`
- `You imported exceljs outside server/store/. Fix that — see CLAUDE.md.`
- `Explain what this function does before we continue.`
- `Write a quick script to test this and run it.`

**If it goes wrong:** `git checkout .` and re-prompt with more detail. Don't argue with it
through five turns — resetting is faster.

---

# Phase 0 — Foundation

No visible features. Everything depends on it. Do not skip ahead.

### T01 — Project skeleton
> Set up the Electron + Express skeleton per CLAUDE.md. Create `main.js` (Electron entry,
> starts the server, opens the window), `server.js` (Express on 0.0.0.0:4700), `index.html`
> (SPA shell), `package.json`, `.gitignore` (exclude `Database/`, `node_modules/`,
> `license/private.key`). On first run, create `Database/data/`, `Database/documents/`,
> `Database/backups/`, `Database/journal/`. Add a `/api/health` route returning
> `{ ok: true, time }`. Nothing else yet.

*Verify:* `npm start` opens a window; visiting `localhost:4700/api/health` returns JSON.

### T02 — Tailwind and design system
> Set up Tailwind compiling to `css/app.css` with `build_bundle.js`. Vendor Fraunces, Inter and
> Material Symbols into `fonts/` with local `@font-face` rules. No CDN links anywhere. Build a
> basic app shell in `index.html`: sidebar, top bar showing server time, content area. Add a
> small vanilla-JS router in `js/router.js` with a placeholder Dashboard screen.

*Verify:* app renders styled with correct fonts; disconnect internet and confirm it's identical.

### T03 — Storage layer
> Build `server/store/` per CLAUDE.md persistence rules: `workbook.js` (load all workbooks into
> memory on start, atomic tmp→rename writes), `lock.js` (`withLock(name, fn)` per-workbook
> mutex), `journal.js` (snapshot/restore for multi-sheet writes), `schema.js` (sheet
> definitions with `id`, `_rev`, `createdBy`, `createdAt`, `updatedBy`, `updatedAt` on every
> data sheet), `counters.js` (Counters sheet in System.xlsx, increments under lock).
> Create `System.xlsx` and `Users.xlsx` on first run with correct headers.
> Include a `crud.js` helper giving generic `list/get/create/update` with `_rev` conflict
> checking that other repositories build on.

*Verify:* start the app, confirm workbooks appear in `Database/data/` with correct headers.
Ask Claude to write a throwaway script that does 50 concurrent writes and confirms no data loss.

### T04 — Users and authentication
> Build the Users repository and auth. `server/store/users.js` (CRUD, bcrypt cost 12, never log
> plaintext). `server/routes/auth.js` — POST /api/login, POST /api/logout, GET /api/me.
> Session tokens stored server-side in `Database/sessions.json`, 30-minute idle timeout,
> invalidated on logout. Lockout after 5 failures for 15 minutes. On first run, seed one Admin
> user with a random password printed to the Electron console and forced change on first login.
> Build the login screen in `js/auth.js`.

*Verify:* log in with the seeded admin; 6 wrong passwords triggers lockout; refreshing keeps
you logged in; logout works.

### T05 — Roles and permissions
> Implement the permission model from SPEC.md §4. Seed Roles, Permissions and RolePermissions
> in `Users.xlsx` with the full department matrix. Build `server/middleware/permission.js`
> checking **atomic permissions, never role names**, and returning 403 with a plain-English
> message. Add scope helpers so a class teacher is filtered server-side to their own sections.
> Wire the sidebar to render only permitted modules.

*Verify:* create a Teacher user; confirm the sidebar hides Fees; confirm calling the fees API
directly with that token returns 403.

### T06 — Audit log
> Add `server/store/audit.js` writing to `System.xlsx` → AuditEvents, insert-only. Log every
> event listed in SPEC.md §14. Add `server/middleware/audit.js` capturing user, role, device,
> action, entity, before/after and IP. Build a read-only audit viewer screen for Admin with
> date and user filters.

*Verify:* log in, change a setting, confirm both appear in the audit viewer with correct before
and after values.

### T07 — LAN access screen and QR
> Build the Access screen per SPEC.md §1. Detect LAN IP on startup, generate a QR with the
> bundled `js/vendor/qrcode.min.js`, display URL, QR, server time and connection status. Add
> mDNS advertising `school-portal.local` (bundle the dependency, no runtime network). Compare
> the LAN IP against the last run stored in Settings and show the "address changed" banner if
> different. Include printable firewall instructions on the screen.

*Verify:* open the URL from your phone on the same Wi-Fi and reach the login page.

### T08 — Device enrollment
> Implement SPEC.md §2. `server/store/devices.js`, `server/routes/devices.js`, and
> `server/middleware/deviceCheck.js` placed **after authenticate, before hoursCheck**. One-time
> enrollment codes valid 10 minutes, single-use. Long-lived `deviceId` cookie. Localhost always
> trusted. Cap 2 devices per user, configurable. Build the Settings → Devices screen with the
> device list and revoke button.

*Verify:* enroll your phone, log in; revoke it, confirm login is refused with the correct
message; confirm the app still works on the server PC itself.

### T09 — School-hours access control
> Implement SPEC.md §3 fully. Store schedule, holidays, special days and overrides in
> `System.xlsx`. Build `server/middleware/hoursCheck.js` — **server clock only, Asia/Kolkata
> hard-coded**, placed after deviceCheck and before permissionCheck. Read-only mode blocks
> POST/PUT/DELETE with 423 Locked and a displayable message; exports stay allowed.
> Admin and Principal are never restricted — hard-code this, do not make it configurable.
> Build the Settings → Access Hours screen with weekly grid, holiday calendar, special days,
> per-role windows, and the emergency override (reason mandatory, auto-expiring).
> Add the client-side closing sequence: banner at −15, modal at −5 and −1, grace period, then
> read-only. Add draft recovery keeping unsaved forms in browser storage.
> Add the startup clock check warning if time moved backwards.

*Verify:* set closing time to two minutes ahead. Confirm the warning appears, saving still
works during grace, then read-only kicks in, and a half-typed form survives. Confirm Admin is
never locked out. Change your phone's clock and confirm it makes no difference.

### T10 — Backup and restore
> Implement SPEC.md §16. Daily scheduled backup plus on-shutdown, acquiring all workbook locks
> before copying. Zip to `Database/backups/` with size and checksum recorded in System.xlsx →
> BackupRuns. Retention 30 daily / 12 monthly. Admin screen showing backup history, last
> success, manual "Backup now", and a **restore** flow requiring re-authentication with a clear
> confirmation warning.

*Verify:* run a backup, add a student, restore, confirm the student is gone. **Do this before
building anything else.**

### T11 — Licensing
> Port the Cure Max licensing model with a new Ed25519 key pair. 60-day trial, machine-locked
> product key, `tools/generate-key.js` vendor tool. Changes from Cure Max per SPEC.md §18:
> 14-day grace period with escalating warnings instead of a hard cliff, and **export routes
> always work regardless of license state**. Write-guard middleware. Exclude
> `license/private.key` from git and the electron-builder config.

*Verify:* generate a key, activate, confirm status shows. Force an expired state and confirm
export still works.

### T12 — Portable build
> Configure electron-builder for a portable Windows `.exe`. Confirm fonts, CSS, vendored JS and
> the QR library are bundled. Confirm `Database/`, `license/private.key` and `tools/` are
> excluded. Document the build command in `package.json` scripts.

*Verify:* build the `.exe`, copy it to a different folder, run it, confirm it creates a fresh
`Database/` and works offline.

> **Stop here and test everything for a full day before Phase 1.** Phase 0 is the foundation —
> bugs found now cost hours; found in month four they cost weeks.

---

# Phase 1 — Core

### T13 — Academic structure
> Build Academic Years, Classes, Sections, Subjects and Teacher Assignments per SPEC.md §8.
> Repository, routes, and Settings screens. Set-current-year and close-year actions.

### T14 — Students
> Students and Guardians per SPEC.md §6 — profile, photo, guardians, address, status. Auto
> admission number from Counters. Paginated search. **Status change, never delete.**

### T15 — Student enrollments
> StudentEnrollments linking student + academic year + class + section + roll number. **All
> academic data must hang off enrollment, not student** — enforce this in the schema now.

### T16 — Student documents
> Upload, allow-list, size cap, server-generated filenames, stored in `Database/documents/`,
> download only through an authorising route. Never expose file paths.

### T17 — Excel import
> Validate-then-commit import for students per SPEC.md §15. Versioned template download,
> row-level error report, nothing written until approved, journal rollback, ImportBatch record.

### T18 — Student attendance
> Daily per-section marking per SPEC.md §9. Optimise for speed — bulk mark-all-present then
> flag absentees. 24-hour lock, then corrections require permission and log a reason.
> One workbook per academic year, one sheet per month.

### T19 — Attendance reports
> Daily register, monthly percentage per student, defaulters below threshold, class comparison,
> absent list for parent calls. Excel and PDF export with generated-by/at stamps.

### T20 — Dashboard
> Role-aware dashboard per SPEC.md §5. Server time and closing time on every version.

### T21 — Notices
> Create, target by role/class/all, publish window, read tracking, print.

### T22 — Timetable
> Period grid per section, teacher-clash detection, substitutions, print per class and teacher.

> **Phase 1 is a usable, sellable system.** Consider deploying it to the school here and
> gathering feedback before Phase 2.

---

# Phase 2 — Academics

### T23 — Exam setup
Terms, subjects, max/pass marks, weightage, date sheet. SPEC.md §10.

### T24 — Marks entry
Grid per subject per section, keyboard-navigable, incremental save, validation, absent flag.

### T25 — Grade rules and publication lock
Configurable ranges → grades. Publication makes marks read-only; changes need permission + log.

### T26 — Report cards
**Get the school's current card scanned first.** Printable per student or section.

### T27 — Result analytics
Subject averages, pass %, toppers, failure list, term comparison.

---

# Phase 3 — Money

Build only when fluent in the codebase. Re-read `CLAUDE.md` §7–9 before starting.

### T28 — Fee heads and structures
Heads, per-class structures, frequencies, effective dating.

### T29 — Concessions
Sibling, staff ward, merit, RTE. Percentage or fixed. Approval required.

### T30 — Invoice generation
Bulk per class per period, preview before commit, journal rollback.

### T31 — Fee collection
Payment modes, part payment, allocation across heads. **Idempotency key mandatory.**

### T32 — Receipts
Sequential gap-free numbering from Counters under lock. Print, reprint marked DUPLICATE.

### T33 — Reversals
Cancellation via reversal row, both records stay visible, approval required, audited.

### T34 — Fee reports
Dues by student/class/head, ageing, defaulters, day book, collection summary, reconciliation.

---

# Phase 4 — Add-ons

### T35 — Library
### T36 — Transport
### T37 — Staff and HR
### T38 — Admissions and enquiries
### T39 — Payroll *(decide with the school whether this is in scope at all)*
### T40 — Parent contact CSV export for external bulk SMS
