using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Attendance;
using SchoolPortal.Infrastructure.Persistence;

namespace SchoolPortal.Web.Pages.Attendance;

[Authorize(
    Policy = PermissionCatalog.PolicyPrefix + PermissionCatalog.Attendance.View)]
public sealed class ReportsModel(
    SchoolPortalDbContext dbContext,
    SchoolPortal.Web.Attendance.AttendanceAccessService accessService,
    IOptions<SchoolPortal.Web.Attendance.AttendanceOptions> options) : PageModel
{
    [BindProperty(SupportsGet = true)]
    public Guid? SectionId { get; set; }

    [BindProperty(SupportsGet = true)]
    public DateOnly From { get; set; } =
        new(DateTime.Today.Year, DateTime.Today.Month, 1);

    [BindProperty(SupportsGet = true)]
    public DateOnly To { get; set; } = DateOnly.FromDateTime(DateTime.Today);

    [BindProperty(SupportsGet = true)]
    public DateOnly ReportDate { get; set; } =
        DateOnly.FromDateTime(DateTime.Today);

    [BindProperty(SupportsGet = true)]
    public decimal Threshold { get; set; }

    public IReadOnlyList<SectionOption> Sections { get; private set; } = [];

    public IReadOnlyList<StudentSummary> StudentSummaries { get; private set; } = [];

    public IReadOnlyList<AbsentStudent> AbsentStudents { get; private set; } = [];

    public IReadOnlyList<ClassSummary> ClassSummaries { get; private set; } = [];

    public int DailyPresent { get; private set; }

    public int DailyAbsent { get; private set; }

    public int DailyLate { get; private set; }

    public int DailyLeave { get; private set; }

    public async Task OnGetAsync(CancellationToken cancellationToken)
    {
        Threshold = Threshold is > 0 and <= 100
            ? Threshold
            : options.Value.DefaulterThreshold;
        if (From > To)
        {
            (From, To) = (To, From);
        }

        var accessibleIds = await accessService.GetAccessibleSectionIdsAsync(
            User,
            cancellationToken);
        Sections = await dbContext.Set<SchoolPortal.Domain.Academics.Section>()
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
            return;
        }

        var records = await dbContext.Set<AttendanceEntry>()
            .AsNoTracking()
            .Where(x =>
                x.Session.SectionId == SectionId.Value
                && x.Session.PeriodNumber == 0
                && x.Session.Date >= From
                && x.Session.Date <= To)
            .Select(x => new AttendanceRecord(
                x.StudentEnrollmentId,
                x.StudentEnrollment.RollNumber,
                x.StudentEnrollment.Student.AdmissionNumber,
                x.StudentEnrollment.Student.FirstName
                    + " "
                    + x.StudentEnrollment.Student.LastName,
                x.Session.Date,
                x.Status))
            .ToListAsync(cancellationToken);

        StudentSummaries = records
            .GroupBy(x => new
            {
                x.EnrollmentId,
                x.RollNumber,
                x.AdmissionNumber,
                x.StudentName,
            })
            .Select(group =>
            {
                var total = group.Count();
                var earned = group.Sum(x => Weight(x.Status));
                var percentage = total == 0
                    ? 0
                    : Math.Round(earned / total * 100, 2);
                return new StudentSummary(
                    group.Key.RollNumber,
                    group.Key.AdmissionNumber,
                    group.Key.StudentName,
                    total,
                    group.Count(x => x.Status == AttendanceStatus.Present),
                    group.Count(x => x.Status == AttendanceStatus.Absent),
                    group.Count(x => x.Status == AttendanceStatus.Late),
                    group.Count(x => x.Status == AttendanceStatus.HalfDay),
                    group.Count(x => x.Status == AttendanceStatus.Leave),
                    percentage,
                    percentage < Threshold);
            })
            .OrderBy(x => x.RollNumber)
            .ToList();

        var daily = await dbContext.Set<AttendanceEntry>()
            .AsNoTracking()
            .Where(x =>
                x.Session.SectionId == SectionId.Value
                && x.Session.PeriodNumber == 0
                && x.Session.Date == ReportDate)
            .Select(x => new
            {
                x.StudentEnrollment.RollNumber,
                x.StudentEnrollment.Student.AdmissionNumber,
                StudentName = x.StudentEnrollment.Student.FirstName
                    + " "
                    + x.StudentEnrollment.Student.LastName,
                x.Status,
                x.Reason,
                GuardianName = x.StudentEnrollment.Student.Guardians
                    .OrderByDescending(guardian => guardian.IsPrimary)
                    .Select(guardian => guardian.Name)
                    .FirstOrDefault(),
                GuardianPhone = x.StudentEnrollment.Student.Guardians
                    .OrderByDescending(guardian => guardian.IsPrimary)
                    .Select(guardian => guardian.Phone)
                    .FirstOrDefault(),
            })
            .ToListAsync(cancellationToken);
        DailyPresent = daily.Count(x => x.Status == AttendanceStatus.Present);
        DailyAbsent = daily.Count(x => x.Status == AttendanceStatus.Absent);
        DailyLate = daily.Count(x => x.Status == AttendanceStatus.Late);
        DailyLeave = daily.Count(x =>
            x.Status is AttendanceStatus.Leave or AttendanceStatus.HalfDay);
        AbsentStudents = daily
            .Where(x => x.Status == AttendanceStatus.Absent)
            .OrderBy(x => x.RollNumber)
            .Select(x => new AbsentStudent(
                x.RollNumber,
                x.AdmissionNumber,
                x.StudentName,
                x.Reason,
                x.GuardianName,
                x.GuardianPhone))
            .ToList();

        var classRecords = await dbContext.Set<AttendanceEntry>()
            .AsNoTracking()
            .Where(x =>
                accessibleIds.Contains(x.Session.SectionId)
                && x.Session.PeriodNumber == 0
                && x.Session.Date >= From
                && x.Session.Date <= To)
            .Select(x => new
            {
                SectionName = x.Session.Section.Class.Name
                    + " "
                    + x.Session.Section.Name,
                x.Status,
            })
            .ToListAsync(cancellationToken);
        ClassSummaries = classRecords
            .GroupBy(x => x.SectionName)
            .Select(group => new ClassSummary(
                group.Key,
                group.Count(),
                Math.Round(
                    group.Sum(x => Weight(x.Status)) / group.Count() * 100,
                    2)))
            .OrderByDescending(x => x.Percentage)
            .ThenBy(x => x.SectionName)
            .ToList();
    }

    private static decimal Weight(AttendanceStatus status) =>
        status switch
        {
            AttendanceStatus.Present => 1,
            AttendanceStatus.Late => 1,
            AttendanceStatus.HalfDay => 0.5m,
            _ => 0,
        };

    private sealed record AttendanceRecord(
        Guid EnrollmentId,
        int RollNumber,
        string AdmissionNumber,
        string StudentName,
        DateOnly Date,
        AttendanceStatus Status);

    public sealed record SectionOption(Guid Id, string Name);

    public sealed record StudentSummary(
        int RollNumber,
        string AdmissionNumber,
        string StudentName,
        int WorkingDays,
        int Present,
        int Absent,
        int Late,
        int HalfDays,
        int Leave,
        decimal Percentage,
        bool IsDefaulter);

    public sealed record AbsentStudent(
        int RollNumber,
        string AdmissionNumber,
        string StudentName,
        string? Reason,
        string? GuardianName,
        string? GuardianPhone);

    public sealed record ClassSummary(
        string SectionName,
        int Records,
        decimal Percentage);
}
