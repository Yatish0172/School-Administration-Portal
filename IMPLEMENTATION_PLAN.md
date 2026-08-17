# School Portal Implementation Plan

Status: Active
Source documents: Product Requirements Document v1.0 and Product Technical Design Document v1.0, dated 25 July 2026.

## 1. Delivery approach

The new portal is being built alongside the existing Node/Electron/Excel application. The legacy application remains available until the replacement passes migration reconciliation, authorization tests, restoration testing, and user acceptance.

The target is a browser-first ASP.NET Core modular monolith backed by PostgreSQL. Excel is limited to validated import and authorized export. Business modules share the same student, academic-year, enrolment, user, and audit identifiers.

Each work item must be completed, tested, and reviewed before the next item starts. No production data will be migrated during early development.

From 30 July 2026 onward, implementation proceeds one functional section at a time. A section remains the active focus until its screens, validation, permissions, automated tests, and local desktop verification pass; partially implemented work in later milestones does not change the active-section gate.

## 2. Agreed technical defaults

- Server platform: Windows
- Runtime: current supported .NET LTS
- UI: ASP.NET Core Razor Pages/MVC with responsive browser support
- Database: supported PostgreSQL release
- Persistence: Entity Framework Core with Npgsql and versioned migrations
- Authentication: ASP.NET Core Identity with individual accounts
- Authorization: atomic permissions plus record and assignment scopes
- Deployment: Windows Service, with browser clients on the LAN
- Remote access: provider-neutral application behind Cloudflare Tunnel initially
- Architecture: one application process and one PostgreSQL database with internal module boundaries
- Migration strategy: side-by-side replacement with reconciliation and rollback checkpoints

## 3. Non-negotiable engineering rules

- Server-side authorization protects every sensitive action and query.
- PostgreSQL is never exposed to the public internet.
- Financial operations, imports, book issues, and other multi-row changes are transactional.
- Important records are archived or reversed rather than silently deleted.
- Academic history is append-oriented and linked through StudentEnrollment.
- Sensitive changes and exports are attributable to an authenticated user.
- Secrets and uploaded documents are stored outside deployment binaries.
- Every schema change is delivered through a reviewed migration.
- Build, automated tests, and security checks must pass before a work item is complete.

## 4. Milestones

| Milestone | Outcome | Exit checkpoint |
|---|---|---|
| M0 - Foundation | Buildable solution, PostgreSQL connectivity, health endpoints, tests | Clean build; live and database readiness checks pass |
| M1 - Identity and administration | Login, users, roles, permissions, sessions, settings, audit | Allowed and denied role scenarios pass |
| M2 - Student and academic core | Students, guardians, documents, years, classes, sections, subjects, enrolments | One student is visible across authorized roles without duplication |
| M3 - Core operations | Attendance, exams, marks, fees, receipts, library | Transaction and authorization acceptance tests pass |
| M4 - Reporting and migration | Standard reports, Excel/PDF exports, validated imports | Invalid imports make no changes; reports reconcile to source data |
| M5 - Operations and remote access | Backups, restore, service startup, tunnel, monitoring, hardening | Restore, reboot, LAN-outage, and remote-access tests pass |
| M6 - Full-package validation | Installable release tested end to end on representative and clean machines | Package, upgrade, migration, security, recovery, and regression suites pass |
| M7 - Pilot and go-live | Training, approved migration, UAT, operational handover | PRD acceptance criteria AC-01 through AC-12 pass |

## 5. Ordered work breakdown

### M0 - Foundation

- [x] FND-01 Create a dedicated migration branch.
- [x] FND-02 Install and pin the current .NET LTS SDK.
- [x] FND-03 Create Domain, Application, Infrastructure, Web, and Tests projects.
- [x] FND-04 Add Entity Framework Core, Npgsql, Identity persistence, and health checks.
- [x] FND-05 Add live health endpoint and integration test.
- [x] FND-06 Install PostgreSQL and create a local development database and least-privileged role.
- [x] FND-07 Move the development connection secret to user secrets or environment configuration.
- [x] FND-08 Create and apply the initial Identity database migration.
- [x] FND-09 Add database readiness and migration-state tests.
- [x] FND-10 Add continuous build and test automation.
- [x] FND-11 Add an optional Electron desktop host for the new local ASP.NET/PostgreSQL application while preserving the legacy launcher.

### M1 - Identity, authorization, and administration

- [x] IAM-01 Define atomic permission catalogue and configurable role groupings.
- [x] IAM-02 Implement secure bootstrap of the first super administrator.
- [ ] IAM-03 Implement login, logout, idle timeout, lockout, reset, and forced password change.
- [ ] IAM-04 Implement permission policies and assignment-based scopes.
- [ ] IAM-05 Build Settings-based portal-account creation, disable, unlock, reset, role assignment, and access management.
- [ ] IAM-06 Implement insert-only audit events with correlation IDs and before/after values.
- [ ] IAM-07 Add security-event logging for login, denial, export, and permission changes.
- [ ] IAM-08 Build the role-aware navigation and administration screens.
- [ ] IAM-09 Add authorization tests for every protected endpoint.
- [x] IAM-10 Add explicitly configured automatic sign-in for the unpackaged local Electron build while keeping packaged and production login enforced.

### M2 - Student and academic core

#### Active section gate: Academics

- [x] ACAD-01 Default academic-year dates to the current calendar year and allow dates from 1 January of that year.
- [x] ACAD-02 Provide bulk Nursery-to-Class-12 setup with a configurable class range, section count, and capacity.
- [x] ACAD-03 Provide class-linked subjects shared by every section of the class.
- [x] ACAD-04 Combine classes and sections on one screen with per-class section counts, dependency-aware removal, class removal, and class-teacher display.
- [x] ACAD-05 Provide year/section/subject teacher assignment with active-teacher and class-consistency validation.
- [x] ACAD-06 Add focused date, bulk-class, section-count, subject, and teacher-assignment integration tests.
- [x] ACAD-07 Provide permanent all-class or class-range lunch/break periods with editable times.
- [x] ACAD-08 Replace clipped inline dropdown forms with scrollable modal dialogs and UI-contract tests.
- [ ] ACAD-09 Complete automatic academic-year closure, promotion, class/subject edit/archive, concurrency, and audit workflows.
- [ ] ACAD-10 Complete the Academics screen acceptance pass in the Electron desktop app before starting another section.
- [ ] ACAD-11 Add a read-only prior-year history screen (working name: Academic History) covering the complete academic structure and records from closed academic years; confirm the final name during design.
- [x] ACAD-12 Add class filtering to Subjects by Class, remove panel subheaders, and simplify lunch/break display.
- [x] ACAD-13 Combine subject creation and teacher assignment with multi-class and multi-section checklists, teacher-primary summaries, scroll preservation, and five-second feedback messages.

- [x] STAFF-01 Add reusable staff records with designation, employment, contact, address, emergency-contact, and active-status details.
- [x] STAFF-02 Link staff records to portal accounts so staff names can be reused for class and subject teacher assignments.
- [x] STAFF-03 Add Staff Details navigation, create/edit dialogs, persistence migration, and integration coverage.
- [x] STAFF-04 Add a Teachers summary with subjects, teaching classes, class-teacher responsibilities, CT markers, and a teacher-details popup.

- [x] CORE-01 Model academic years, classes, sections, subjects, and teacher assignments.
- [x] CORE-02 Model students, guardians, contacts, addresses, statuses, and unique admission numbers.
- [x] CORE-03 Model StudentEnrollment as the historical link to year, class, section, and roll number.
- [x] CORE-04 Implement paginated and scoped student search.
- [x] CORE-05 Implement admission workflow and duplicate detection.
- [ ] CORE-06 Implement validated document upload and authorized download.
- [ ] CORE-07 Implement academic-year close and student promotion without overwriting history.
- [ ] CORE-08 Add concurrency controls and audit tests for sensitive edits.

### M3 - Core operations

- [x] OPS-01 Implement attendance sessions, bulk entry, cutoff rules, corrections, and reports.
- [x] OPS-02 Implement examination setup, subjects, mark limits, grade rules, entry windows, and publication locks.
- [x] OPS-03 Implement fee heads, plans, concessions, charges, payments, allocations, receipts, and reversals.
- [x] OPS-04 Enforce idempotency and database transactions for payment posting.
- [x] OPS-05 Implement library catalogue, copies, issue, renewal, return, loss, and fines.
- [x] OPS-06 Add module-specific permission, concurrency, and transaction tests.
- [ ] OPS-07 Obtain approved report-card and receipt samples before final print layouts.

### M4 - Reporting, import, and export

- [ ] RPT-01 Implement the approved standard report catalogue.
- [ ] RPT-02 Apply the same permissions and record scopes to screens, reports, and exports.
- [ ] RPT-03 Generate authorized Excel and PDF output with requester and timestamp stamps.
- [ ] RPT-04 Audit sensitive exports and enforce row limits/background generation.
- [ ] MIG-01 Publish versioned import templates.
- [ ] MIG-02 Validate uploads without changing production data and return row-level errors.
- [ ] MIG-03 Commit approved batches transactionally and record reconciliation totals.
- [ ] MIG-04 Build legacy Excel-to-PostgreSQL migration and reconciliation tooling.

### M5 - Operations, deployment, and security

- [ ] OPSYS-01 Store documents, logs, backups, and secrets outside application binaries.
- [ ] OPSYS-02 Implement scheduled PostgreSQL and document backups with checksum and retention.
- [ ] OPSYS-03 Implement protected restore workflow and complete a clean test restoration.
- [ ] OPSYS-04 Add application, database, storage, backup, and disk-space health reporting.
- [ ] OPSYS-05 Package and register the portal as an automatically restarting Windows Service.
- [ ] OPSYS-06 Configure LAN hostname/firewall rules and verify local operation without internet.
- [ ] OPSYS-07 Configure Cloudflare Tunnel and optional access gateway without exposing PostgreSQL.
- [ ] OPSYS-08 Complete security headers, request validation, rate limiting, upload, and dependency checks.
- [ ] OPSYS-09 Produce restart, backup, restore, user-unlock, tunnel, and support runbooks.

### M6 - Full-package validation

- [ ] PKG-01 Produce a versioned release package from a clean build.
- [ ] PKG-02 Verify package contents, checksums, version metadata, licenses, and absence of source secrets or development-only files.
- [ ] PKG-03 Test fresh installation on a clean supported Windows machine with no developer tools installed.
- [ ] PKG-04 Test installation paths, protected configuration, data directories, firewall rules, service registration, and automatic startup.
- [ ] PKG-05 Run the complete automated unit, integration, authorization, migration, security, and regression suites against the packaged build.
- [ ] PKG-06 Run end-to-end tests for login, administration, admission, attendance, marks, fees, receipts, reversals, library, reports, imports, exports, audit, and backups.
- [ ] PKG-07 Verify every configured role has the correct navigation, allowed actions, denied actions, data scope, and export permissions.
- [ ] PKG-08 Test concurrent attendance entry, duplicate admission prevention, stale updates, duplicate payment retries, and transaction rollback.
- [ ] PKG-09 Test representative and maximum agreed data volumes for search, attendance, marks, fee reports, exports, and simultaneous users.
- [ ] PKG-10 Test valid and malicious file uploads, input validation, lockout, session expiry, direct URL access, rate limits, headers, and dependency vulnerabilities.
- [ ] PKG-11 Test validated legacy-data migration and reconcile row counts, identifiers, balances, attendance totals, marks, and library history.
- [ ] PKG-12 Test upgrade from the previous supported package with pre-upgrade backup, schema migration, preserved files/configuration, and recovery procedure.
- [ ] PKG-13 Test backup, checksum, retention, off-site copy, clean-server restore, and post-restore integrity checks.
- [ ] PKG-14 Test Windows Service stop/start, server reboot, application crash recovery, PostgreSQL interruption, tunnel interruption, internet outage, and LAN continuity.
- [ ] PKG-15 Test current agreed browsers and representative desktop, tablet, and phone screen sizes.
- [ ] PKG-16 Record defects and evidence, rerun the full regression suite after fixes, and approve a release candidate with no unresolved critical or high-severity defects.

### M7 - Pilot and go-live

- [ ] LIVE-01 Resolve all open product decisions and approve final permissions.
- [ ] LIVE-02 Run representative migration and reconcile student, financial, attendance, and library totals.
- [ ] LIVE-03 Complete browser, device-size, performance, concurrency, and security testing.
- [ ] LIVE-04 Complete backup restoration, server reboot, and local-internet-outage demonstrations.
- [ ] LIVE-05 Train nominated staff with individual accounts.
- [ ] LIVE-06 Execute PRD acceptance criteria AC-01 through AC-12.
- [ ] LIVE-07 Obtain written go-live approval and archive source and deployment artifacts.

## 6. Decisions required before affected work begins

These do not block the foundation, but each must be resolved before its related module is finalized:

1. Final role-permission matrix and sensitive field classification.
2. Student count, retained academic years, document volume, and concurrent users.
3. School board and approved report-card format.
4. Approved fee receipt, fee schedule, concession, late-fee, and reversal rules.
5. Backup retention, off-site destination, encryption, RPO, and RTO.
6. Local HTTPS and certificate-management policy.
7. Cloudflare Access identity method.
8. Data retention/deletion policy and privacy notice.
9. Final Release 1 modules and whether payroll remains excluded.
10. Named product owner, super administrator, and recovery contact.

## 7. Definition of done for every work item

A work item is complete only when:

- code builds with zero warnings;
- automated unit, integration, and authorization tests pass;
- database changes have a migration and rollback/recovery note;
- permissions are enforced server-side;
- audit and error handling are included where required;
- no secrets or personal test data are committed;
- the documented acceptance scenario is manually verified;
- the legacy portal remains unaffected unless an approved migration checkpoint says otherwise.

## 8. Immediate next step

Keep Academics as the only active section. Complete ACAD-09 through ACAD-11: automatic academic-year closure and promotion, remaining class/subject edit/archive behavior, prior-year history, concurrency and audit coverage, and desktop acceptance. Do not start the next functional section until the Academics gate is complete and approved. Reporting verification remains paused; OPS-07 still depends on approved report-card and receipt samples.
