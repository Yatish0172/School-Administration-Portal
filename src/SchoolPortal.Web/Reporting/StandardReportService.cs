using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Attendance;
using SchoolPortal.Domain.Examinations;
using SchoolPortal.Domain.Fees;
using SchoolPortal.Domain.Library;
using SchoolPortal.Domain.Students;
using SchoolPortal.Infrastructure.Persistence;
using SchoolPortal.Web.Attendance;
using SchoolPortal.Web.Fees;

namespace SchoolPortal.Web.Reporting;

public sealed class StandardReportService(
    SchoolPortalDbContext dbContext,
    AttendanceAccessService attendanceAccessService,
    IOptions<ReportingOptions> options)
{
    private readonly int maxRows = Math.Max(1, options.Value.MaxSynchronousRows);

    public static IReadOnlyList<ReportDefinition> Catalogue { get; } =
    [
        new(
            "student-directory",
            "Student directory",
            "Students",
            "Admission register with current class, section, roll number, and status.",
            PermissionCatalog.Students.View,
            true,
            [
                new("admissionNumber", "Admission number"),
                new("studentName", "Student name"),
                new("class", "Class"),
                new("section", "Section"),
                new("rollNumber", "Roll number", ReportValueKind.WholeNumber),
                new("admissionDate", "Admission date", ReportValueKind.Date),
                new("status", "Status"),
            ]),
        new(
            "attendance-summary",
            "Attendance summary",
            "Attendance",
            "Student attendance totals and attendance percentage for an approved date range.",
            PermissionCatalog.Attendance.View,
            true,
            [
                new("admissionNumber", "Admission number"),
                new("studentName", "Student name"),
                new("classSection", "Class / section"),
                new("present", "Present", ReportValueKind.WholeNumber),
                new("absent", "Absent", ReportValueKind.WholeNumber),
                new("late", "Late", ReportValueKind.WholeNumber),
                new("leave", "Leave", ReportValueKind.WholeNumber),
                new("total", "Total", ReportValueKind.WholeNumber),
                new("percentage", "Attendance %", ReportValueKind.Percentage),
            ]),
        new(
            "examination-results",
            "Examination results",
            "Examinations",
            "Student totals, maximum marks, percentage, and result status.",
            PermissionCatalog.Exams.View,
            true,
            [
                new("exam", "Examination"),
                new("admissionNumber", "Admission number"),
                new("studentName", "Student name"),
                new("classSection", "Class / section"),
                new("marks", "Marks obtained", ReportValueKind.Number),
                new("maximum", "Maximum marks", ReportValueKind.Number),
                new("percentage", "Percentage", ReportValueKind.Percentage),
                new("result", "Result"),
            ]),
        new(
            "fee-dues",
            "Fee dues",
            "Fees",
            "Outstanding charges by student after concessions and valid allocations.",
            PermissionCatalog.Fees.Reports,
            true,
            [
                new("admissionNumber", "Admission number"),
                new("studentName", "Student name"),
                new("classSection", "Class / section"),
                new("charged", "Charged", ReportValueKind.Number),
                new("concession", "Concession", ReportValueKind.Number),
                new("paid", "Paid", ReportValueKind.Number),
                new("outstanding", "Outstanding", ReportValueKind.Number),
                new("oldestDueDate", "Oldest due date", ReportValueKind.Date),
            ]),
        new(
            "fee-collections",
            "Fee collections",
            "Fees",
            "Posted and reversed receipts for the selected date range.",
            PermissionCatalog.Fees.Reports,
            true,
            [
                new("receiptNumber", "Receipt"),
                new("paymentDate", "Payment date", ReportValueKind.Date),
                new("admissionNumber", "Admission number"),
                new("studentName", "Student name"),
                new("mode", "Mode"),
                new("reference", "Reference"),
                new("amount", "Amount", ReportValueKind.Number),
                new("status", "Status"),
            ]),
        new(
            "library-circulation",
            "Library circulation",
            "Library",
            "Issue, return, overdue, loss, renewal, and fine status by copy.",
            PermissionCatalog.Library.View,
            true,
            [
                new("accessionNumber", "Accession number"),
                new("title", "Title"),
                new("admissionNumber", "Admission number"),
                new("studentName", "Student name"),
                new("issuedDate", "Issued date", ReportValueKind.Date),
                new("dueDate", "Due date", ReportValueKind.Date),
                new("returnedDate", "Returned date", ReportValueKind.Date),
                new("renewals", "Renewals", ReportValueKind.WholeNumber),
                new("fine", "Fine", ReportValueKind.Number),
                new("status", "Status"),
            ]),
    ];

    public IReadOnlyList<ReportDefinition> GetAvailable(ClaimsPrincipal user) =>
        Catalogue.Where(definition => HasPermission(user, definition.RequiredPermission))
            .ToArray();

    public async Task<ReportData> BuildAsync(
        string key,
        ReportFilters filters,
        ClaimsPrincipal user,
        CancellationToken cancellationToken = default)
    {
        var definition = Catalogue.SingleOrDefault(x =>
            string.Equals(x.Key, key, StringComparison.OrdinalIgnoreCase));
        if (definition is null)
        {
            throw new KeyNotFoundException($"Unknown report '{key}'.");
        }

        if (!HasPermission(user, PermissionCatalog.Reports.View)
            || !HasPermission(user, definition.RequiredPermission))
        {
            throw new UnauthorizedAccessException(
                "The current user is not authorized for this report.");
        }

        var normalized = Normalize(filters);
        var scopedSectionIds = await GetScopedSectionIdsAsync(
            user,
            cancellationToken);
        if (normalized.SectionId.HasValue
            && scopedSectionIds is not null
            && !scopedSectionIds.Contains(normalized.SectionId.Value))
        {
            throw new UnauthorizedAccessException(
                "The selected section is outside the current user's record scope.");
        }

        var rows = key.ToLowerInvariant() switch
        {
            "student-directory" => await BuildStudentDirectoryAsync(
                normalized,
                scopedSectionIds,
                cancellationToken),
            "attendance-summary" => await BuildAttendanceSummaryAsync(
                normalized,
                scopedSectionIds,
                cancellationToken),
            "examination-results" => await BuildExaminationResultsAsync(
                normalized,
                scopedSectionIds,
                cancellationToken),
            "fee-dues" => await BuildFeeDuesAsync(normalized, cancellationToken),
            "fee-collections" => await BuildFeeCollectionsAsync(
                normalized,
                cancellationToken),
            "library-circulation" => await BuildLibraryCirculationAsync(
                normalized,
                scopedSectionIds,
                cancellationToken),
            _ => throw new KeyNotFoundException($"Unknown report '{key}'."),
        };

        if (rows.Count > maxRows)
        {
            throw new ReportRowLimitException(definition.Name, maxRows);
        }

        return new ReportData(
            definition,
            rows,
            normalized,
            DateTimeOffset.UtcNow,
            user.Identity?.Name ?? "Authenticated user");
    }

    private async Task<IReadOnlyList<IReadOnlyDictionary<string, object?>>> BuildStudentDirectoryAsync(
        ReportFilters filters,
        IReadOnlyCollection<Guid>? scopedSectionIds,
        CancellationToken cancellationToken)
    {
        var query = dbContext.Set<StudentEnrollment>()
            .AsNoTracking()
            .AsQueryable();
        if (filters.AcademicYearId.HasValue)
        {
            query = query.Where(x => x.AcademicYearId == filters.AcademicYearId);
        }

        if (filters.SectionId.HasValue)
        {
            query = query.Where(x => x.SectionId == filters.SectionId);
        }

        if (scopedSectionIds is not null)
        {
            query = query.Where(x => scopedSectionIds.Contains(x.SectionId));
        }

        var values = await query
            .OrderBy(x => x.Class.SortOrder)
            .ThenBy(x => x.Section.Name)
            .ThenBy(x => x.RollNumber)
            .Take(maxRows + 1)
            .Select(x => new
            {
                x.Student.AdmissionNumber,
                StudentName = x.Student.FirstName + " " + x.Student.LastName,
                Class = x.Class.Name,
                Section = x.Section.Name,
                x.RollNumber,
                x.Student.AdmissionDate,
                Status = x.Student.Status.ToString(),
            })
            .ToListAsync(cancellationToken);
        return values.Select(x => Row(
            ("admissionNumber", x.AdmissionNumber),
            ("studentName", x.StudentName),
            ("class", x.Class),
            ("section", x.Section),
            ("rollNumber", x.RollNumber),
            ("admissionDate", x.AdmissionDate),
            ("status", x.Status))).ToArray();
    }

    private async Task<IReadOnlyList<IReadOnlyDictionary<string, object?>>> BuildAttendanceSummaryAsync(
        ReportFilters filters,
        IReadOnlyCollection<Guid>? scopedSectionIds,
        CancellationToken cancellationToken)
    {
        var query = dbContext.Set<AttendanceEntry>()
            .AsNoTracking()
            .Where(x =>
                x.Session.Date >= filters.From
                && x.Session.Date <= filters.To);
        if (filters.AcademicYearId.HasValue)
        {
            query = query.Where(x =>
                x.Session.AcademicYearId == filters.AcademicYearId);
        }

        if (filters.SectionId.HasValue)
        {
            query = query.Where(x =>
                x.Session.SectionId == filters.SectionId);
        }

        if (scopedSectionIds is not null)
        {
            query = query.Where(x =>
                scopedSectionIds.Contains(x.Session.SectionId));
        }

        var values = await query
            .GroupBy(x => new
            {
                x.StudentEnrollment.Student.AdmissionNumber,
                x.StudentEnrollment.Student.FirstName,
                x.StudentEnrollment.Student.LastName,
                Class = x.StudentEnrollment.Class.Name,
                Section = x.StudentEnrollment.Section.Name,
            })
            .Select(group => new
            {
                group.Key.AdmissionNumber,
                StudentName = group.Key.FirstName + " " + group.Key.LastName,
                ClassSection = group.Key.Class + " " + group.Key.Section,
                Present = group.Count(x =>
                    x.Status == AttendanceStatus.Present
                    || x.Status == AttendanceStatus.Late),
                Absent = group.Count(x => x.Status == AttendanceStatus.Absent),
                Late = group.Count(x => x.Status == AttendanceStatus.Late),
                Leave = group.Count(x => x.Status == AttendanceStatus.Leave),
                Total = group.Count(),
            })
            .OrderBy(x => x.ClassSection)
            .ThenBy(x => x.AdmissionNumber)
            .Take(maxRows + 1)
            .ToListAsync(cancellationToken);
        return values.Select(x => Row(
            ("admissionNumber", x.AdmissionNumber),
            ("studentName", x.StudentName),
            ("classSection", x.ClassSection),
            ("present", x.Present),
            ("absent", x.Absent),
            ("late", x.Late),
            ("leave", x.Leave),
            ("total", x.Total),
            ("percentage", x.Total == 0 ? 0m : (decimal)x.Present / x.Total)))
            .ToArray();
    }

    private async Task<IReadOnlyList<IReadOnlyDictionary<string, object?>>> BuildExaminationResultsAsync(
        ReportFilters filters,
        IReadOnlyCollection<Guid>? scopedSectionIds,
        CancellationToken cancellationToken)
    {
        var query = dbContext.Set<StudentMark>()
            .AsNoTracking()
            .AsQueryable();
        if (filters.ExaminationId.HasValue)
        {
            query = query.Where(x =>
                x.ExaminationSubject.ExaminationId == filters.ExaminationId);
        }

        if (filters.AcademicYearId.HasValue)
        {
            query = query.Where(x =>
                x.ExaminationSubject.Examination.AcademicYearId
                == filters.AcademicYearId);
        }

        if (filters.SectionId.HasValue)
        {
            query = query.Where(x =>
                x.StudentEnrollment.SectionId == filters.SectionId);
        }

        if (scopedSectionIds is not null)
        {
            query = query.Where(x =>
                scopedSectionIds.Contains(x.StudentEnrollment.SectionId));
        }

        var marks = await query
            .Select(x => new
            {
                ExamId = x.ExaminationSubject.ExaminationId,
                Exam = x.ExaminationSubject.Examination.Name,
                EnrollmentId = x.StudentEnrollmentId,
                x.StudentEnrollment.Student.AdmissionNumber,
                StudentName = x.StudentEnrollment.Student.FirstName
                    + " "
                    + x.StudentEnrollment.Student.LastName,
                ClassSection = x.StudentEnrollment.Class.Name
                    + " "
                    + x.StudentEnrollment.Section.Name,
                Obtained = x.IsAbsent ? 0 : x.MarksObtained ?? 0,
                x.ExaminationSubject.MaximumMarks,
                x.ExaminationSubject.PassMarks,
                Passed = !x.IsAbsent
                    && x.MarksObtained.HasValue
                    && x.MarksObtained >= x.ExaminationSubject.PassMarks,
            })
            .ToListAsync(cancellationToken);
        var values = marks
            .GroupBy(x => new
            {
                x.ExamId,
                x.Exam,
                x.EnrollmentId,
                x.AdmissionNumber,
                x.StudentName,
                x.ClassSection,
            })
            .Select(group => new
            {
                group.Key.Exam,
                group.Key.AdmissionNumber,
                group.Key.StudentName,
                group.Key.ClassSection,
                Marks = group.Sum(x => x.Obtained),
                Maximum = group.Sum(x => x.MaximumMarks),
                Passed = group.All(x => x.Passed),
            })
            .OrderBy(x => x.Exam)
            .ThenBy(x => x.ClassSection)
            .ThenBy(x => x.AdmissionNumber)
            .Take(maxRows + 1)
            .ToArray();
        return values.Select(x => Row(
            ("exam", x.Exam),
            ("admissionNumber", x.AdmissionNumber),
            ("studentName", x.StudentName),
            ("classSection", x.ClassSection),
            ("marks", x.Marks),
            ("maximum", x.Maximum),
            ("percentage", x.Maximum == 0 ? 0m : x.Marks / x.Maximum),
            ("result", x.Passed ? "Pass" : "Needs attention"))).ToArray();
    }

    private async Task<IReadOnlyList<IReadOnlyDictionary<string, object?>>> BuildFeeDuesAsync(
        ReportFilters filters,
        CancellationToken cancellationToken)
    {
        var query = dbContext.Set<StudentCharge>()
            .AsNoTracking()
            .Where(x => x.Status == StudentChargeStatus.Active);
        if (filters.AcademicYearId.HasValue)
        {
            query = query.Where(x =>
                x.StudentEnrollment.AcademicYearId == filters.AcademicYearId);
        }

        if (filters.SectionId.HasValue)
        {
            query = query.Where(x =>
                x.StudentEnrollment.SectionId == filters.SectionId);
        }

        var charges = await query
            .Include(x => x.StudentEnrollment)
                .ThenInclude(x => x.Student)
            .Include(x => x.StudentEnrollment)
                .ThenInclude(x => x.Class)
            .Include(x => x.StudentEnrollment)
                .ThenInclude(x => x.Section)
            .Include(x => x.Concessions)
            .Include(x => x.PaymentAllocations)
                .ThenInclude(x => x.FeePayment)
            .ToListAsync(cancellationToken);
        var values = charges
            .GroupBy(x => x.StudentEnrollment)
            .Select(group => new
            {
                Enrollment = group.Key,
                Charged = group.Sum(x => x.Amount),
                Concession = group.Sum(x => x.Concessions.Sum(c => c.Amount)),
                Paid = group.Sum(x => x.PaymentAllocations
                    .Where(a => a.FeePayment.Status == FeePaymentStatus.Posted)
                    .Sum(a => a.Amount)),
                Outstanding = group.Sum(FeeBalanceCalculator.Outstanding),
                OldestDueDate = group.Min(x => x.DueDate),
            })
            .Where(x => x.Outstanding > 0)
            .OrderByDescending(x => x.Outstanding)
            .Take(maxRows + 1)
            .ToArray();
        return values.Select(x => Row(
            ("admissionNumber", x.Enrollment.Student.AdmissionNumber),
            ("studentName", x.Enrollment.Student.FullName),
            ("classSection", $"{x.Enrollment.Class.Name} {x.Enrollment.Section.Name}"),
            ("charged", x.Charged),
            ("concession", x.Concession),
            ("paid", x.Paid),
            ("outstanding", x.Outstanding),
            ("oldestDueDate", x.OldestDueDate))).ToArray();
    }

    private async Task<IReadOnlyList<IReadOnlyDictionary<string, object?>>> BuildFeeCollectionsAsync(
        ReportFilters filters,
        CancellationToken cancellationToken)
    {
        var query = dbContext.Set<FeePayment>()
            .AsNoTracking()
            .Where(x =>
                x.PaymentDate >= filters.From
                && x.PaymentDate <= filters.To);
        if (filters.AcademicYearId.HasValue)
        {
            query = query.Where(x =>
                x.StudentEnrollment.AcademicYearId == filters.AcademicYearId);
        }

        if (filters.SectionId.HasValue)
        {
            query = query.Where(x =>
                x.StudentEnrollment.SectionId == filters.SectionId);
        }

        var values = await query
            .OrderByDescending(x => x.PaymentDate)
            .ThenBy(x => x.Receipt.ReceiptNumber)
            .Take(maxRows + 1)
            .Select(x => new
            {
                x.Receipt.ReceiptNumber,
                x.PaymentDate,
                x.StudentEnrollment.Student.AdmissionNumber,
                StudentName = x.StudentEnrollment.Student.FirstName
                    + " "
                    + x.StudentEnrollment.Student.LastName,
                Mode = x.Mode.ToString(),
                x.Reference,
                x.Amount,
                Status = x.Status.ToString(),
            })
            .ToListAsync(cancellationToken);
        return values.Select(x => Row(
            ("receiptNumber", x.ReceiptNumber),
            ("paymentDate", x.PaymentDate),
            ("admissionNumber", x.AdmissionNumber),
            ("studentName", x.StudentName),
            ("mode", x.Mode),
            ("reference", x.Reference),
            ("amount", x.Amount),
            ("status", x.Status))).ToArray();
    }

    private async Task<IReadOnlyList<IReadOnlyDictionary<string, object?>>> BuildLibraryCirculationAsync(
        ReportFilters filters,
        IReadOnlyCollection<Guid>? scopedSectionIds,
        CancellationToken cancellationToken)
    {
        var query = dbContext.Set<BookIssue>()
            .AsNoTracking()
            .Where(x =>
                x.IssuedDate >= filters.From
                && x.IssuedDate <= filters.To);
        if (Enum.TryParse<BookIssueStatus>(filters.Status, true, out var status))
        {
            query = query.Where(x => x.Status == status);
        }

        if (scopedSectionIds is not null)
        {
            query = query.Where(x => x.Student.Enrollments.Any(enrollment =>
                enrollment.Status == EnrollmentStatus.Active
                && scopedSectionIds.Contains(enrollment.SectionId)));
        }

        var values = await query
            .OrderByDescending(x => x.IssuedDate)
            .ThenBy(x => x.LibraryCopy.AccessionNumber)
            .Take(maxRows + 1)
            .Select(x => new
            {
                x.LibraryCopy.AccessionNumber,
                x.LibraryCopy.LibraryTitle.Title,
                x.Student.AdmissionNumber,
                StudentName = x.Student.FirstName + " " + x.Student.LastName,
                x.IssuedDate,
                x.DueDate,
                x.ReturnedDate,
                Renewals = x.RenewalCount,
                Fine = x.Fine == null ? 0 : x.Fine.Amount,
                Status = x.Status.ToString(),
            })
            .ToListAsync(cancellationToken);
        return values.Select(x => Row(
            ("accessionNumber", x.AccessionNumber),
            ("title", x.Title),
            ("admissionNumber", x.AdmissionNumber),
            ("studentName", x.StudentName),
            ("issuedDate", x.IssuedDate),
            ("dueDate", x.DueDate),
            ("returnedDate", x.ReturnedDate),
            ("renewals", x.Renewals),
            ("fine", x.Fine),
            ("status", x.Status))).ToArray();
    }

    private async Task<IReadOnlyCollection<Guid>?> GetScopedSectionIdsAsync(
        ClaimsPrincipal user,
        CancellationToken cancellationToken)
    {
        if (!user.IsInRole(RoleCatalog.Teacher))
        {
            return null;
        }

        return await attendanceAccessService.GetAccessibleSectionIdsAsync(
            user,
            cancellationToken);
    }

    private static ReportFilters Normalize(ReportFilters filters)
    {
        var from = filters.From ?? DateOnly.FromDateTime(DateTime.Today.AddDays(-30));
        var to = filters.To ?? DateOnly.FromDateTime(DateTime.Today);
        if (from > to)
        {
            (from, to) = (to, from);
        }

        return filters with { From = from, To = to };
    }

    private static bool HasPermission(ClaimsPrincipal user, string permission) =>
        user.HasClaim(PermissionCatalog.ClaimType, permission);

    private static Dictionary<string, object?> Row(
        params (string Key, object? Value)[] values) =>
        values.ToDictionary(x => x.Key, x => x.Value, StringComparer.Ordinal);
}
