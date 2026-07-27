# CLAUDE.md — School Admin Portal

Read this before every task. These rules override any general preference you have.

---

## What this is

An **offline, on-premise school management system**. A portable Windows `.exe` runs on one
server PC in the school office. Staff connect from their own phones and laptops over the
school LAN using a link + QR code the app generates. No cloud, no internet, no CDN.

Ported from an existing clinic app ("Cure Max") that uses the same shell and patterns.

## Tech stack — do not substitute

| Layer | Choice |
|---|---|
| Desktop shell | Electron |
| Server | Node.js + Express, bound to `0.0.0.0:4700` |
| Storage | **Excel workbooks via `exceljs`** (see Persistence rules) |
| Frontend | Vanilla JS SPA — no React, Vue, or any framework |
| CSS | Tailwind, compiled locally to `css/app.css` |
| Fonts | Vendored locally (Fraunces, Inter, Material Symbols) |
| Auth | bcrypt password hashing, server-issued session tokens |
| QR | `js/vendor/qrcode.min.js`, bundled |
| Packaging | electron-builder, portable `.exe` |

**Never add a CDN link, Google Fonts import, or any runtime network call.** The school PC has
no internet. If a dependency needs network access at runtime, it is the wrong dependency.

Ask before adding any npm package that is not already in `package.json`.

---

## Persistence rules — the most important section

Excel is the chosen storage format. It is fragile under concurrent writes, so these rules are
mandatory, not suggestions.

### 1. All data access goes through `server/store/`

No route handler, no module, no script may `require('exceljs')` directly. Every read and write
goes through a repository function in `server/store/` (`students.js`, `fees.js`, etc.).

This is a hard architectural boundary. It exists so storage can be swapped later without
touching business logic. If you find yourself importing exceljs outside `server/store/`, stop
and put it behind a repository function instead.

### 2. In-memory cache, write-through to disk

Loading a workbook from disk on every request is far too slow. On server start, load all
workbooks into memory. Serve **all reads from memory**. On write: update memory, then persist
to disk under the workbook's lock.

### 3. One mutex per workbook

`server/store/lock.js` exposes `withLock(workbookName, async fn)`. Every write acquires the
lock for that workbook. Reads do not lock. Writes to the same workbook are serialised.

### 4. Atomic writes only

Write to `<file>.tmp`, `fsync`, then `rename` over the original. Never write in place. A power
cut mid-write must never corrupt a workbook.

### 5. Row versioning (optimistic concurrency)

Every data sheet has a `_rev` integer column. On update, the client sends the `_rev` it read.
If it no longer matches, reject with `409 Conflict` and the message
`"This record was changed by someone else. Reload and try again."`

Without this, two users editing the same student silently overwrite each other. This is the
single most likely data-loss bug in this system.

### 6. Cap file growth

- Attendance: one workbook per academic year — `Attendance_2026-27.xlsx`, one sheet per month.
- Never let a single sheet exceed ~50,000 rows. Split by year or month before it does.

### 7. Counters are never derived from row counts

Receipt numbers, admission numbers and invoice numbers come from a `Counters` sheet in
`System.xlsx`, incremented under the same lock as the write that uses them. Never
`rows.length + 1` — that produces duplicate receipt numbers the moment a row is deleted or two
writes interleave.

### 8. Fee payments require an idempotency key

The client generates a UUID per payment attempt and sends it. The server records used keys. A
repeated key returns the original receipt instead of creating a second one. A dropped Wi-Fi
connection plus a re-click must never charge a parent twice.

### 9. Multi-sheet operations need a rollback path

A fee payment touches Invoices, Payments and Receipts. Excel has no transactions. Before a
multi-sheet write, snapshot the affected workbook to `Database/journal/`. If any step throws,
restore the snapshot. Delete the snapshot on success.

---

## Security rules

- Passwords hashed with bcrypt cost 12. **Never store or log a plaintext password or PIN.**
- Permissions are checked **server-side on every route**. Hiding a menu item is not access
  control. Every protected route calls the permission middleware.
- Check **atomic permissions** (`fees.collect`), never role names (`if (role === 'admin')`).
  Role-name checks scattered through routes make new roles impossible.
- **Scope, not just permission.** A class teacher with `attendance.mark.assigned` must be
  filtered server-side to their own sections. Never trust a section ID from the client.
- Parameterised, validated input on every endpoint. Validate types, ranges and required fields
  server-side even if the UI already does.
- CSRF token on every state-changing request. `helmet` for headers. Rate limit on login.
- Uploads: extension allow-list, size cap, server-generated filenames, stored in
  `Database/documents/`, never served by static path — always through an authorising route.
- Never commit `license/private.key` or any secret. Both must be excluded from the build.

## Data safety rules

- **Never hard-delete anything.** Students, staff, users get a `status` change. Payments get a
  reversal row. The original record always stays visible.
- Every create and update stamps `createdBy` / `createdAt` / `updatedBy` / `updatedAt` with
  the authenticated user.
- Audit log (`System.xlsx` → `AuditEvents`) is **insert-only**. No code path updates or
  deletes it.

---

## Code conventions

- CommonJS (`require`), not ES modules. Matches the Cure Max codebase.
- Route files in `server/routes/`, one per module. Repositories in `server/store/`.
- Frontend modules in `js/`, one per screen, each exporting `render(container)`.
- Async/await. No callback style, no `.then()` chains.
- Every route returns `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.
  The `message` is shown to users, so write it in plain English, not developer jargon.
- Comment *why*, not *what*. Skip comments that restate the code.
- 2-space indent, single quotes, semicolons.

## Middleware order — do not reorder

```
authenticate → deviceCheck → hoursCheck → permissionCheck → handler
```

## Working style

- **One task at a time.** Finish the task in `TASKS.md`, stop, and let me verify before moving
  on. Do not proactively start the next task.
- Before writing code, state in two or three lines what you are about to change and which
  files. Then do it.
- Prefer editing existing files over creating new ones.
- No new markdown docs unless I ask.
- If a task is ambiguous or you are about to guess at a business rule, **ask instead of
  guessing.** A wrong assumption about fee calculation costs more than a question.
- After each task, tell me exactly how to verify it manually — which screen, which button,
  what I should see.

## Things that are out of scope

Do not build, suggest, or scaffold: cloud sync, online payment gateways, SMS/WhatsApp sending,
mobile native apps, Docker, microservices, or any framework migration.
