using System.ComponentModel.DataAnnotations;
using System.Data;
using System.Globalization;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Academics;
using SchoolPortal.Domain.Attendance;
using SchoolPortal.Domain.Students;
using SchoolPortal.Infrastructure.Persistence;
using SchoolPortal.Web.Administration;

namespace SchoolPortal.Web.Pages.Attendance;

[Authorize(
    Policy = PermissionCatalog.PolicyPrefix + PermissionCatalog.Attendance.View)]
public sealed class IndexModel(
    SchoolPortalDbContext dbContext,
    SchoolPortal.Web.Attendance.AttendanceAccessService accessService,
    IOptions<SchoolPortal.Web.Attendance.AttendanceOptions> attendanceOptions,
    AuditWriter auditWriter) : PageModel
{
    [BindProperty(SupportsGet = true)]
    public Guid? SectionId { get; set; }

    [BindProperty(SupportsGet = true)]
    [DataType(DataType.Date)]
    public DateOnly Date { get; set; } = DateOnly.FromDateTime(DateTime.Today);

    [BindProperty(SupportsGet = true)]
    [Range(0, 12)]
    public int PeriodNumber { get; set; }

    [BindProperty]
    public List<AttendanceInput> Entries { get; set; } = [];

    [BindProperty]
    public CorrectionInput Correction { get; set; } = new();

    [TempData]
    public string? StatusMessage { get; set; }

    public IReadOnlyList<SectionOption> Sections { get; private set; } = [];

    public IReadOnlyList<RosterRow> Roster { get; private set; } = [];

    public IReadOnlyList<CorrectionRow> CorrectionHistory { get; private set; } = [];

    public string? SelectedSectionName { get; private set; }

    public bool IsLocked { get; private set; }

    public DateTimeOffset LockAt { get; private set; }

    public bool CanMark { get; private set; }

    public bool CanCorrect => User.HasClaim(
        PermissionCatalog.ClaimType,
        PermissionCatalog.Attendance.Correct);

    public async Task OnGetAsync(CancellationToken cancellationToken)
    {
        await LoadAsync(cancellationToken);
    }

    public async Task<IActionResult> OnPostSaveAsync(
        CancellationToken cancellationToken)
    {
        ModelState.Clear();
        TryValidateModel(Entries, nameof(Entries));

        if (PeriodNumber < 0 || PeriodNumber > 12)
        {
            ModelState.AddModelError(string.Empty, "Choose a valid period.");
            await LoadAsync(cancellationToken);
            return Page();
        }

        if (!SectionId.HasValue)
        {
            ModelState.AddModelError(string.Empty, "Choose a section.");
            await LoadAsync(cancellationToken);
            return Page();
        }

        if (!SchoolPortal.Web.Attendance.AttendanceAccessService.TryGetUserId(
            User,
            out var userId))
        {
            return Challenge();
        }

        if (!await accessService.CanMarkSectionAsync(
            User,
            SectionId.Value,
            cancellationToken))
        {
            return Forbid();
        }

        var section = await dbContext.Set<Section>()
            .Include(x => x.AcademicYear)
            .Include(x => x.Class)
            .SingleOrDefaultAsync(
                x => x.Id == SectionId.Value && x.IsActive,
                cancellationToken);
        if (section is null)
        {
            return NotFound();
        }

        if (!ValidateRegister(section))
        {
            await LoadAsync(cancellationToken);
            return Page();
        }

        var roster = await dbContext.Set<StudentEnrollment>()
            .Where(x =>
                x.SectionId == section.Id
                && x.AcademicYearId == section.AcademicYearId
                && x.Status == EnrollmentStatus.Active
                && x.Student.Status == StudentStatus.Active)
            .OrderBy(x => x.RollNumber)
            .Select(x => x.Id)
            .ToListAsync(cancellationToken);
        var submittedIds = Entries.Select(x => x.EnrollmentId).ToList();
        if (submittedIds.Count != submittedIds.Distinct().Count()
            || roster.Count != submittedIds.Count
            || roster.Except(submittedIds).Any())
        {
            ModelState.AddModelError(
                string.Empty,
                "The class roster changed. Reload the register and try again.");
            await LoadAsync(cancellationToken);
            return Page();
        }

        foreach (var entry in Entries)
        {
            if (!Enum.IsDefined(entry.Status))
            {
                ModelState.AddModelError(string.Empty, "Choose a valid status.");
            }

            if (entry.Status == AttendanceStatus.Leave
                && string.IsNullOrWhiteSpace(entry.Reason))
            {
                ModelState.AddModelError(
                    string.Empty,
                    "A reason is required for every student marked on leave.");
            }
        }

        if (!ModelState.IsValid)
        {
            await LoadAsync(cancellationToken);
            return Page();
        }

        await using var transaction = await dbContext.Database.BeginTransactionAsync(
            IsolationLevel.Serializable,
            cancellationToken);
        var lockKey = $"attendance:{section.Id:N}:{Date:yyyyMMdd}:{PeriodNumber}";
        await dbContext.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock(hashtext({lockKey}))",
            cancellationToken);

        var now = DateTimeOffset.UtcNow;
        var session = await dbContext.Set<AttendanceSession>()
            .Include(x => x.Entries)
            .SingleOrDefaultAsync(
                x => x.AcademicYearId == section.AcademicYearId
                    && x.SectionId == section.Id
                    && x.Date == Date
                    && x.PeriodNumber == PeriodNumber,
                cancellationToken);
        var isNew = session is null;
        session ??= new AttendanceSession
        {
            AcademicYearId = section.AcademicYearId,
            SectionId = section.Id,
            Date = Date,
            PeriodNumber = PeriodNumber,
            MarkedByUserId = userId,
            MarkedAtUtc = now,
        };

        if (isNew)
        {
            dbContext.Add(session);
        }

        session.UpdatedAtUtc = now;
        var existing = session.Entries.ToDictionary(x => x.StudentEnrollmentId);
        foreach (var input in Entries)
        {
            if (!existing.TryGetValue(input.EnrollmentId, out var entry))
            {
                entry = new AttendanceEntry
                {
                    StudentEnrollmentId = input.EnrollmentId,
                };
                session.Entries.Add(entry);
            }

            entry.Status = input.Status;
            entry.Reason = Normalize(input.Reason);
            entry.MarkedByUserId = userId;
            entry.MarkedAtUtc = now;
        }

        auditWriter.Add(
            isNew ? "attendance.register.created" : "attendance.register.updated",
            nameof(AttendanceSession),
            session.Id,
            null,
            new
            {
                section.Id,
                Date,
                PeriodNumber,
                Entries = Entries
                    .GroupBy(x => x.Status)
                    .ToDictionary(x => x.Key.ToString(), x => x.Count()),
            });
        await dbContext.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);

        StatusMessage = $"Attendance saved for {section.Class.Name} {section.Name}.";
        return RedirectToPage(new
        {
            SectionId,
            Date = Date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            PeriodNumber,
        });
    }

    public async Task<IActionResult> OnPostCorrectAsync(
        CancellationToken cancellationToken)
    {
        if (!User.HasClaim(
            PermissionCatalog.ClaimType,
            PermissionCatalog.Attendance.Correct))
        {
            return Forbid();
        }

        ModelState.Clear();
        if (!TryValidateModel(Correction, nameof(Correction)))
        {
            await LoadAsync(cancellationToken);
            return Page();
        }

        if (!SchoolPortal.Web.Attendance.AttendanceAccessService.TryGetUserId(
            User,
            out var userId))
        {
            return Challenge();
        }

        var entry = await dbContext.Set<AttendanceEntry>()
            .Include(x => x.Session)
                .ThenInclude(x => x.Section)
                    .ThenInclude(x => x.Class)
            .Include(x => x.Session)
                .ThenInclude(x => x.Section)
                    .ThenInclude(x => x.AcademicYear)
            .SingleOrDefaultAsync(
                x => x.Id == Correction.EntryId,
                cancellationToken);
        if (entry is null)
        {
            return NotFound();
        }

        SectionId = entry.Session.SectionId;
        Date = entry.Session.Date;
        PeriodNumber = entry.Session.PeriodNumber;

        if (!await accessService.CanMarkSectionAsync(
            User,
            entry.Session.SectionId,
            cancellationToken))
        {
            return Forbid();
        }

        if (entry.Session.Section.AcademicYear.Status == AcademicYearStatus.Closed)
        {
            ModelState.AddModelError(
                string.Empty,
                "Attendance cannot be changed for a closed academic year.");
            await LoadAsync(cancellationToken);
            return Page();
        }

        if (entry.Status == Correction.NewStatus)
        {
            ModelState.AddModelError(
                string.Empty,
                "Choose a status different from the current status.");
            await LoadAsync(cancellationToken);
            return Page();
        }

        var oldStatus = entry.Status;
        var now = DateTimeOffset.UtcNow;
        entry.Status = Correction.NewStatus;
        entry.Reason = Normalize(Correction.EntryReason);
        entry.MarkedByUserId = userId;
        entry.MarkedAtUtc = now;
        entry.Session.UpdatedAtUtc = now;
        dbContext.Add(new AttendanceCorrection
        {
            AttendanceEntryId = entry.Id,
            OldStatus = oldStatus,
            NewStatus = Correction.NewStatus,
            Reason = Correction.Reason.Trim(),
            CorrectedByUserId = userId,
            CorrectedAtUtc = now,
        });
        auditWriter.Add(
            "attendance.entry.corrected",
            nameof(AttendanceEntry),
            entry.Id,
            new { Status = oldStatus },
            new
            {
                Status = Correction.NewStatus,
                Correction.Reason,
                Correction.EntryReason,
            });
        await dbContext.SaveChangesAsync(cancellationToken);

        StatusMessage = "Attendance correction saved with an audit record.";
        return RedirectToPage(new
        {
            SectionId,
            Date = Date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            PeriodNumber,
        });
    }

    private bool ValidateRegister(Section section)
    {
        if (Date > DateOnly.FromDateTime(DateTime.Today))
        {
            ModelState.AddModelError(string.Empty, "Future attendance cannot be marked.");
        }

        if (Date < section.AcademicYear.StartDate
            || Date > section.AcademicYear.EndDate)
        {
            ModelState.AddModelError(
                string.Empty,
                "The date is outside the section's academic year.");
        }

        if (section.AcademicYear.Status == AcademicYearStatus.Closed)
        {
            ModelState.AddModelError(
                string.Empty,
                "Attendance cannot be changed for a closed academic year.");
        }

        if (CalculateLockAt(Date) <= DateTimeOffset.Now)
        {
            ModelState.AddModelError(
                string.Empty,
                "This register is locked. Use a correction with a reason.");
        }

        return ModelState.IsValid;
    }

    private async Task LoadAsync(CancellationToken cancellationToken)
    {
        var accessibleIds = await accessService.GetAccessibleSectionIdsAsync(
            User,
            cancellationToken);
        Sections = await dbContext.Set<Section>()
            .AsNoTracking()
            .Include(x => x.AcademicYear)
            .Include(x => x.Class)
            .Where(x => accessibleIds.Contains(x.Id))
            .OrderByDescending(x => x.AcademicYear.StartDate)
            .ThenBy(x => x.Class.SortOrder)
            .ThenBy(x => x.Name)
            .Select(x => new SectionOption(
                x.Id,
                $"{x.Class.Name} {x.Name} · {x.AcademicYear.Name}"))
            .ToListAsync(cancellationToken);

        if (!SectionId.HasValue && Sections.Count > 0)
        {
            SectionId = Sections[0].Id;
        }

        if (!SectionId.HasValue || !accessibleIds.Contains(SectionId.Value))
        {
            Roster = [];
            return;
        }

        var section = await dbContext.Set<Section>()
            .AsNoTracking()
            .Include(x => x.AcademicYear)
            .Include(x => x.Class)
            .SingleAsync(x => x.Id == SectionId.Value, cancellationToken);
        SelectedSectionName =
            $"{section.Class.Name} {section.Name} · {section.AcademicYear.Name}";
        CanMark = await accessService.CanMarkSectionAsync(
            User,
            section.Id,
            cancellationToken);
        LockAt = CalculateLockAt(Date);
        IsLocked = LockAt <= DateTimeOffset.Now;

        var session = await dbContext.Set<AttendanceSession>()
            .AsNoTracking()
            .Include(x => x.Entries)
            .SingleOrDefaultAsync(
                x => x.AcademicYearId == section.AcademicYearId
                    && x.SectionId == section.Id
                    && x.Date == Date
                    && x.PeriodNumber == PeriodNumber,
                cancellationToken);
        var attendanceByEnrollment = session?.Entries
            .ToDictionary(x => x.StudentEnrollmentId)
            ?? [];

        var enrollments = await dbContext.Set<StudentEnrollment>()
            .AsNoTracking()
            .Include(x => x.Student)
            .Where(x =>
                x.SectionId == section.Id
                && x.AcademicYearId == section.AcademicYearId
                && x.Status == EnrollmentStatus.Active
                && x.Student.Status == StudentStatus.Active)
            .OrderBy(x => x.RollNumber)
            .ToListAsync(cancellationToken);

        Roster = enrollments.Select(enrollment =>
        {
            attendanceByEnrollment.TryGetValue(enrollment.Id, out var attendance);
            return new RosterRow(
                enrollment.Id,
                attendance?.Id,
                enrollment.RollNumber,
                enrollment.Student.AdmissionNumber,
                enrollment.Student.FullName,
                attendance?.Status ?? AttendanceStatus.Present,
                attendance?.Reason,
                attendance?.MarkedAtUtc);
        }).ToList();
        Entries = Roster.Select(x => new AttendanceInput
        {
            EnrollmentId = x.EnrollmentId,
            Status = x.Status,
            Reason = x.Reason,
        }).ToList();

        if (session is not null)
        {
            CorrectionHistory = await dbContext.Set<AttendanceCorrection>()
                .AsNoTracking()
                .Where(x => x.AttendanceEntry.Session.Id == session.Id)
                .OrderByDescending(x => x.CorrectedAtUtc)
                .Select(x => new CorrectionRow(
                    x.AttendanceEntry.StudentEnrollment.Student.AdmissionNumber,
                    x.AttendanceEntry.StudentEnrollment.Student.FirstName
                        + " "
                        + x.AttendanceEntry.StudentEnrollment.Student.LastName,
                    x.OldStatus,
                    x.NewStatus,
                    x.Reason,
                    x.CorrectedAtUtc))
                .ToListAsync(cancellationToken);
        }
    }

    private DateTimeOffset CalculateLockAt(DateOnly date)
    {
        var endOfDay = date.ToDateTime(TimeOnly.MaxValue);
        var offset = TimeZoneInfo.Local.GetUtcOffset(endOfDay);
        return new DateTimeOffset(endOfDay, offset)
            .AddHours(Math.Max(0, attendanceOptions.Value.LockHours));
    }

    private static string? Normalize(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    public sealed class AttendanceInput
    {
        [Required]
        public Guid EnrollmentId { get; set; }

        public AttendanceStatus Status { get; set; } = AttendanceStatus.Present;

        [StringLength(500)]
        public string? Reason { get; set; }
    }

    public sealed class CorrectionInput
    {
        [Required]
        public Guid EntryId { get; set; }

        public AttendanceStatus NewStatus { get; set; }

        [StringLength(500)]
        public string? EntryReason { get; set; }

        [Required, StringLength(500, MinimumLength = 3)]
        public string Reason { get; set; } = string.Empty;
    }

    public sealed record SectionOption(Guid Id, string Name);

    public sealed record RosterRow(
        Guid EnrollmentId,
        Guid? EntryId,
        int RollNumber,
        string AdmissionNumber,
        string StudentName,
        AttendanceStatus Status,
        string? Reason,
        DateTimeOffset? MarkedAtUtc);

    public sealed record CorrectionRow(
        string AdmissionNumber,
        string StudentName,
        AttendanceStatus OldStatus,
        AttendanceStatus NewStatus,
        string Reason,
        DateTimeOffset CorrectedAtUtc);
}
