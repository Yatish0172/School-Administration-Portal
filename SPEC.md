# School Admin Portal — Feature Specification

Reference document. Claude Code reads sections from this as needed; it is not loaded every
session. Stack and engineering rules live in `CLAUDE.md`.

---

## 1. Access link — how staff connect

### Flow
1. Admin starts the app on the server PC.
2. Server binds `0.0.0.0:4700`, detects LAN IP.
3. **Access screen** shows the URL, a QR code, current server time, and connection status.
4. Staff scan the QR or type the URL on their own device.
5. Device check runs, then the login page appears.
6. Login issues a session token carrying `userId`, `role`, `department`.

### Keeping the address stable
The IP changes on reboot unless fixed. Two mitigations, show both on the Access screen:
- **DHCP reservation** on the router binding the server's MAC to a fixed IP (recommended).
- **mDNS** — advertise `school-portal.local` so the name works even if the IP moves.

On startup, if the LAN IP differs from last run, show: *"Address changed from X to Y — reprint
the QR code."*

### Security note
The QR only tells a device where the server is. Anyone on school Wi-Fi, including students,
can reach the login page. Device enrollment and authentication are what protect the data.

### Network
- One-time Windows Firewall inbound rule, TCP 4700, **Private profile only**.
- Server PC on wired Ethernet where possible.
- If the school has separate staff and student Wi-Fi, put the server on staff only.

---

## 2. Device enrollment

Stops an unregistered device logging in even with a correct password.

1. Admin opens **Settings → Devices → Enroll new device**.
2. App generates a one-time code + QR, **valid 10 minutes**.
3. Staff member opens the link, enters the code, logs in once.
4. Server issues a long-lived `deviceId` cookie and records the device.

**Device list** shows: device name (set by staff), assigned user, browser/OS, last seen,
status. Admin can revoke instantly; revocation kills active sessions on that device.

Rules: unenrolled devices get the login page but login is refused with *"This device is not
registered. Contact the office."* Localhost is always trusted. Codes are single-use and
expire. Default cap 2 devices per user. All enrollments and revocations audited.

---

## 3. School-hours access control

### Configuration — Settings → Access Hours

| Setting | Default |
|---|---|
| Mon–Fri | 07:30 – 17:00 |
| Saturday | 07:30 – 13:00 |
| Sunday | Closed |
| Timezone | Asia/Kolkata (fixed) |
| Closing grace | 15 min |
| Warning lead | 15 min |

**Holiday calendar** — named closed dates, single or ranges.
**Special days** — override hours for one date (PTM until 19:00, exam day from 06:30).

Precedence: special day > holiday > weekly schedule.

### Behaviour outside hours

**Admin and Principal always have access. Not configurable.** If hours are misconfigured at
9pm, someone must be able to fix it.

| Role | Outside hours |
|---|---|
| Admin | Full access, always |
| Principal | Full access, always |
| Accounts / Fees | Extended window (default to 19:00), then read-only |
| Examination Cell | Extended window (default to 20:00) |
| Class Teacher | Read-only |
| Front Office | Blocked |
| Attendance In-charge | Blocked |
| Library / Transport / HR | Blocked |

Blocked login shows: *"The portal is closed. Opens tomorrow at 7:30 AM."* — never a generic
error.

### Closing sequence — never hard-kill a session

| Time | Behaviour |
|---|---|
| Close − 15 min | Yellow banner: "Portal closes at 5:00 PM" |
| Close − 5 min | Dismissible modal, repeats at −1 min |
| Close | Saves still accepted for grace period. No new records started. |
| Close + grace | Read-only. Unsaved form data kept in browser storage. |
| Close + grace + 30 min | Session ends. |

Draft recovery: store in-progress forms client-side keyed to user + form, restore on next
login — *"You have unsaved attendance from yesterday."*

### Enforcement
- **Server-side only**, using the server clock. Client UI reflects state but enforces nothing.
- Read-only blocks `POST`/`PUT`/`DELETE`, returns `423 Locked` with a displayable message.
- Exports and printing stay allowed in read-only mode.

### Clock integrity
The PC is offline, so its clock drifts unnoticed. Check on startup; if time moved backwards,
log and warn Admin. Show server time on the Access screen. Add "verify server clock" to the
monthly maintenance checklist.

**Tell the school plainly:** this is an operational control, not a security boundary. Anyone
with physical access to the server PC can change the clock.

### Emergency override
Admin only. Extends today by 1/2/4 hours or until midnight. **Reason mandatory.** Auto-expires.
Banner shown to all users. Audited.

### Audit
Log every refused-for-hours attempt. Weekly count on the Admin dashboard.

---

## 4. Users, roles, permissions

### Account controls

| Control | Rule |
|---|---|
| Credential | Password (min 8 chars) for Admin, Principal, Accounts, Exam Cell. 6-digit PIN allowed for Teacher, Library, Transport, Attendance. |
| Hashing | bcrypt cost 12 |
| Lockout | 5 failures → locked 15 min, audited |
| Reset | Admin-initiated, one-time temp password, forced change on first login |
| Session | Idle timeout 30 min, explicit sign-out, token invalidated server-side |
| Disable | Instant on staff exit. Never delete — audit history must survive. |
| Shared accounts | Prohibited |

A 4-digit PIN is guessable in a few hundred tries; the lockout is what makes PINs acceptable
for low-privilege roles. Do not skip it.

### Permission model
Roles group permissions; permissions are atomic. Examples: `student.view`, `student.create`,
`student.edit`, `attendance.mark.assigned`, `attendance.mark.any`, `attendance.correct`,
`marks.enter`, `marks.publish`, `fees.collect`, `fees.reverse`, `fees.report`, `user.manage`,
`settings.edit`, `backup.run`, `license.manage`.

### Department matrix

| Department | Modules | Limits |
|---|---|---|
| Admin | Everything + Users, Devices, Hours, Licensing, Backup | No time restriction |
| Principal | Everything read + approvals, all reports | No user management by default |
| Front Office / Admissions | Students, Enquiries, ID cards, Notices | No fees, no marks |
| Accounts / Fees | Fee heads, collection, dues, receipts, finance reports | Reversals need Principal approval |
| Class Teacher | Own sections: attendance, marks, remarks, timetable | Cannot see other sections or fees |
| Examination Cell | Exam setup, marks, report cards, analytics | Cannot edit student profiles |
| Attendance In-charge | Student + staff attendance, corrections | Read-only on students |
| Library | Catalog, issue/return, fines | Student name + class lookup only |
| Transport | Routes, vehicles, assignments | Student name + address lookup only |
| HR / Staff | Staff records, staff attendance, payroll | No student data |

Confirm the real list with the school — most schools have one person doing three of these jobs.

---

## 5. Dashboard

Role-aware. Every version shows server time and portal closing time.

- **Admin/Principal:** enrolment count, today's attendance %, fees collected today and MTD,
  outstanding dues, last backup status, license status, users online.
- **Front Office:** new enquiries, pending admissions, today's birthdays, notices.
- **Accounts:** collected today, dues by class, receipts issued, defaulters.
- **Teacher:** today's periods, sections with attendance not yet marked, marks deadlines.
- **Library:** issued today, overdue, fines pending.

---

## 6. Students

Profile: admission number (unique, auto-generated, configurable prefix), name, DOB, gender,
blood group, category, photo, admission date, class/section, roll number, status
(Active / TC Issued / Left / Alumni).

Guardians: father, mother, local guardian — name, relation, phone, email, occupation,
primary-contact flag. Address: permanent and correspondence.

Documents: birth certificate, TC, Aadhaar, photos. Allow-listed types, size cap, stored in
`Database/documents/`, download authorised through the app.

Search by name, admission number, class, section, phone, guardian name. Paginated.

Also: Excel bulk import (§15), TC generation, bulk promotion at year rollover with exceptions,
ID card printing with photo and QR.

**Never hard-delete. Status change only.**

---

## 7. Admissions and enquiries

Enquiry capture (child name, class sought, parent contact, source, follow-up date), follow-up
log with next-action dates, conversion to admission with roll number allocation, waiting list
with per-section capacity, enquiry funnel report by source and month.

---

## 8. Academics

- **Academic years** — create, set current, close. Historical years stay readable forever.
- **Classes and sections** — capacity, class teacher assignment.
- **Subjects** — per class, core/elective, theory/practical, max marks.
- **Teacher assignments** — teacher × class × section × subject. Drives all scoping.
- **Timetable** — period grid per section, teacher-clash detection, substitutions, print per
  class and per teacher.

Everything academic hangs off **StudentEnrollment** (student + academic year + class +
section), never directly off Student. Getting this wrong forces a rewrite at year rollover.

---

## 9. Attendance

**Student:** daily per section, marked by class teacher. Optional period-wise for senior
classes. Statuses: Present, Absent, Late, Half Day, Leave (with reason). Bulk "mark all
present, then flag absentees" — this is the workflow teachers expect and it must be fast.

Locked after a configurable window (default 24h). Later corrections need `attendance.correct`
and log old value, new value, reason.

Absent list for the office to call parents. Reports: daily register, monthly percentage per
student, defaulters below threshold, class comparison.

**Staff:** daily in/out, leave types (CL/SL/EL), balances, monthly summary feeding payroll.

This module carries the heaviest load — 25 teachers submitting between 8:00 and 8:30. Optimise
this screen above all others.

---

## 10. Exams and report cards

Terms (Unit Test 1, Half Yearly, Unit Test 2, Annual — configurable). Per exam: subjects, max
marks, pass marks, weightage, date sheet.

Marks entry per subject per section: grid layout, keyboard-navigable, saves incrementally.
Validation — cannot exceed max, absent flag, blank distinct from zero.

**Publication lock** — once published, marks are read-only. Changes need Exam Cell permission
and are logged.

Grade rules: configurable mark ranges → grades, per class if needed.

Report cards: printable per student or whole section — school header, photo, subject marks,
grades, attendance %, remarks, signature blocks.

Analytics: subject averages, pass percentage, toppers, failure list, term comparison.

> **Get a scan of the school's current report card before building this.** Format is the most
> customised thing in any school ERP and differs by board (CBSE / ICSE / State).

---

## 11. Fees and accounts

Highest-risk module. Money errors destroy trust immediately.

- **Fee heads:** tuition, transport, exam, admission, lab, late fee.
- **Fee structure:** per class, per head, per frequency (monthly/term/annual). Effective-dated
  so mid-year revisions don't corrupt history.
- **Concessions:** sibling, staff ward, merit, RTE. Percentage or fixed. Approval required.
- **Invoices:** bulk generation per class per period, preview before commit.
- **Collection:** cash, cheque, UPI, bank transfer, with instrument number and date.
- **Receipts:** sequential, gap-free. Reprints marked DUPLICATE.
- **Part payment** with allocation across heads.
- **Reversal, never deletion.** Wrong receipt is cancelled by a reversal row; both stay
  visible. Requires approval.
- **Dues:** by student, class, head. Ageing buckets. Defaulter list.
- **Day book:** all transactions for a date, for tallying physical cash.
- Reports: collection summary, head-wise, mode-wise, concession register, reconciliation.

Engineering non-negotiables are in `CLAUDE.md` §7–9 (counters, idempotency, journal rollback).

---

## 12. Remaining modules

**Staff / HR** — directory, qualifications, joining date, documents, attendance, leave.
Payroll optional (salary structure, deductions, payslip); it is a product of its own — Phase 4
or drop.

**Library** — titles, authors, categories, copies with accession numbers, issue/return,
renewals, fine calculation, overdue list, catalogue search, stock report.

**Transport** — routes, stops, vehicles, drivers with licence expiry alerts, student
assignment to route and stop, fee linkage, route-wise lists.

**Notices** — create, target by role/class/all, publish window, read tracking, print. Optional
CSV export of parent numbers for external bulk SMS.

**Reports** — all modules' reports in one place, Excel and PDF export, date and class filters,
generated-by and generated-at stamped on every export.

**Admin / Settings** — school profile and logo, academic year, users, devices, access hours,
holiday calendar, fee and grade config, backup and restore, licensing, audit viewer, health.

---

## 13. Data model — Excel workbooks

`Database/data/`

| Workbook | Sheets |
|---|---|
| `System.xlsx` | Settings, Counters, AuditEvents, AccessHours, Holidays, SpecialDays, HoursOverrides, BackupRuns |
| `Users.xlsx` | Users, Roles, Permissions, RolePermissions, Sessions, Devices, EnrollmentCodes |
| `Students.xlsx` | Students, Guardians, StudentDocuments, Enquiries |
| `Academics.xlsx` | AcademicYears, Classes, Sections, Subjects, TeacherAssignments, StudentEnrollments, Timetable |
| `Attendance_<year>.xlsx` | One sheet per month + AttendanceCorrections |
| `StaffAttendance_<year>.xlsx` | One sheet per month + LeaveRequests |
| `Exams_<year>.xlsx` | Exams, ExamSubjects, Marks, GradeRules |
| `Fees_<year>.xlsx` | FeeHeads, FeeStructures, Concessions, StudentCharges, Payments, PaymentAllocations, Receipts, Reversals, IdempotencyKeys |
| `Staff.xlsx` | Staff, StaffDocuments, SalaryStructures |
| `Library.xlsx` | Titles, Copies, BookIssues, Fines |
| `Transport.xlsx` | Routes, Stops, Vehicles, RouteAssignments |
| `Notices.xlsx` | Notices, NoticeReads |
| `Imports.xlsx` | ImportBatches, ImportErrors |

Every data sheet carries: `id`, `_rev`, `createdBy`, `createdAt`, `updatedBy`, `updatedAt`.

Also in `Database/`: `documents/` (uploads), `backups/`, `journal/` (rollback snapshots),
`license.json`, `sessions.json`.

---

## 14. Audit log

Every entry: timestamp, user, role, device, action, entity type, entity ID, before, after, IP.

Always audited: login success/failure, lockout, user create/disable, permission change, PIN
reset, fee payment, fee reversal, concession approval, marks publish, attendance correction,
student status change, document download, backup, restore, license activation, hours override,
device enroll/revoke, out-of-hours attempt.

Insert-only. No code path updates or deletes it.

---

## 15. Excel import

1. User downloads a versioned template.
2. Upload stored in a temp folder.
3. **Validate:** headers, types, required fields, duplicate admission numbers, cross-references
   to existing classes and sections.
4. User sees row-level errors and a summary. **Nothing written yet.**
5. On approval, import runs with journal rollback, writes an `ImportBatch` record.
6. Temp file deleted.

Never import directly on upload. Schools hand you spreadsheets with merged cells, dates stored
as text, and three students sharing an admission number.

---

## 16. Backup and restore

| Item | Design |
|---|---|
| What | Whole `Database/data/` + `documents/` |
| Automatic | Daily at a quiet hour, plus on app shutdown |
| Method | Acquire all workbook locks, copy folder, zip |
| Local copy | Second drive or USB on the server PC |
| Off-site | Weekly copy to a rotated USB the Principal takes home |
| Retention | 30 daily, 12 monthly |
| Verification | Record size and checksum; dashboard shows last successful backup |
| Alerting | Red banner on Admin dashboard after failed or missed backup |
| Restore | Documented, tested, Admin-only, requires re-authentication |

Test the restore before go-live and once per term. An untested backup is not a backup.

---

## 17. Security and compliance

- HTTPS on the LAN with a self-signed cert, or at minimum enforce strong passwords and record
  the accepted risk in writing. Plain HTTP on a network students also use means anyone with
  Wireshark can read the accounts office password.
- `helmet`, CSRF tokens, login rate limiting.
- Uploads: allow-list, size cap, server-generated names, path-traversal protection, served only
  through an authorising route.
- License private key never committed, excluded from build.
- **DPDP Act 2023** — this stores minors' personal data. Needed: a stated retention policy (how
  long after a student leaves), a documented breach process, a parent-facing privacy notice,
  restricted access to sensitive documents.

---

## 18. Licensing

60-day trial, then machine-locked Ed25519 product key, ported from Cure Max with a new key
pair. Three changes for a school:

- **Grace period, not a cliff** — 14 days of full access with escalating warnings after expiry,
  then read-only.
- **Export always works regardless of license state.** They must always be able to get their
  data out.
- **Documented emergency key process** — how fast a replacement key can be issued if the server
  PC dies, and who to call.

---

## 19. Open items to confirm with the school

1. Product name and branding.
2. Real department list and who actually does what.
3. Scanned copies of their current **report card** and **fee receipt**.
4. Fee structure model: monthly / term / annual, late fee rules.
5. Board: CBSE / ICSE / State — drives grading and report card.
6. School hours, Saturday schedule, holiday calendar for the year.
7. Payroll: in or out of scope.
8. Phase 1 delivery date, agreed separately from "complete ERP".
9. Written approval of this architecture, which differs from the signed PTDD.
