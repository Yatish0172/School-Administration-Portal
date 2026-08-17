using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Academics;
using SchoolPortal.Domain.Examinations;
using SchoolPortal.Domain.Students;
using SchoolPortal.Infrastructure.Persistence;
using SchoolPortal.Web.Administration;
using SchoolPortal.Web.Examinations;

namespace SchoolPortal.Web.Pages.Exams;

[Authorize(Policy = PermissionCatalog.PolicyPrefix + PermissionCatalog.Exams.View)]
public sealed class ResultsModel(
    SchoolPortalDbContext dbContext,
    AuditWriter auditWriter) : PageModel
{
    [BindProperty(SupportsGet = true)]
    public Guid? ExaminationId { get; set; }

    [BindProperty(SupportsGet = true)]
    public Guid? SectionId { get; set; }

    [BindProperty]
    public string? ReopenReason { get; set; }

    [TempData]
    public string? StatusMessage { get; set; }

    public IReadOnlyList<ExamOption> Examinations { get; private set; } = [];

    public IReadOnlyList<SectionOption> Sections { get; private set; } = [];

    public IReadOnlyList<ResultRow> Results { get; private set; } = [];

    public IReadOnlyList<StatusRow> StatusHistory { get; private set; } = [];

    public Examination? SelectedExamination { get; private set; }

    public int MissingMarks { get; private set; }

    public bool CanReview => User.HasClaim(
        PermissionCatalog.ClaimType,
        PermissionCatalog.Marks.Review);

    public bool CanPublish => User.HasClaim(
        PermissionCatalog.ClaimType,
        PermissionCatalog.Marks.Publish);

    public async Task OnGetAsync(CancellationToken cancellationToken) =>
        await LoadAsync(cancellationToken);

    public async Task<IActionResult> OnPostPublishAsync(
        Guid id,
        CancellationToken cancellationToken)
    {
        if (!CanPublish)
        {
            return Forbid();
        }

        var exam = await dbContext.Set<Examination>()
            .Include(x => x.AcademicYear)
            .Include(x => x.Subjects)
            .SingleOrDefaultAsync(x => x.Id == id, cancellationToken);
        if (exam is null)
        {
            return NotFound();
        }

        ExaminationId = exam.Id;
        if (exam.Status != ExaminationStatus.MarksEntry)
        {
            ModelState.AddModelError(
                string.Empty,
                "Only an examination in marks entry can be published.");
        }

        if (exam.AcademicYear.Status == AcademicYearStatus.Closed)
        {
            ModelState.AddModelError(
                string.Empty,
                "Results cannot be published after the academic year is closed.");
        }

        if (exam.Subjects.Count == 0)
        {
            ModelState.AddModelError(
                string.Empty,
                "The examination has no subjects.");
        }

        var gradeRules = await dbContext.Set<GradeRule>()
            .AsNoTracking()
            .Where(x =>
                x.AcademicYearId == exam.AcademicYearId
                && x.ClassId == exam.ClassId)
            .OrderByDescending(x => x.MinimumPercent)
            .ToListAsync(cancellationToken);
        if (gradeRules.Count == 0)
        {
            ModelState.AddModelError(
                string.Empty,
                "Configure grade bands before publishing.");
        }

        var enrollmentIds = await dbContext.Set<StudentEnrollment>()
            .Where(x =>
                x.AcademicYearId == exam.AcademicYearId
                && x.ClassId == exam.ClassId
                && x.Status == EnrollmentStatus.Active
                && x.Student.Status == StudentStatus.Active)
            .Select(x => x.Id)
            .ToListAsync(cancellationToken);
        var subjectIds = exam.Subjects.Select(x => x.Id).ToList();
        var completed = await dbContext.Set<StudentMark>()
            .CountAsync(
                x => subjectIds.Contains(x.ExaminationSubjectId)
                    && enrollmentIds.Contains(x.StudentEnrollmentId)
                    && (x.MarksObtained.HasValue || x.IsAbsent),
                cancellationToken);
        var expected = enrollmentIds.Count * subjectIds.Count;
        if (completed != expected)
        {
            ModelState.AddModelError(
                string.Empty,
                $"{expected - completed} marks are still blank across the class.");
        }

        if (!ModelState.IsValid)
        {
            await LoadAsync(cancellationToken);
            return Page();
        }

        if (!MarkAccessService.TryGetUserId(User, out var userId))
        {
            return Challenge();
        }

        await using var transaction = await dbContext.Database.BeginTransactionAsync(
            cancellationToken);
        var marks = await dbContext.Set<StudentMark>()
            .Include(x => x.ExaminationSubject)
            .Where(x => subjectIds.Contains(x.ExaminationSubjectId))
            .ToListAsync(cancellationToken);
        foreach (var mark in marks)
        {
            mark.Grade = mark.MarksObtained.HasValue
                ? GradeFor(
                    gradeRules,
                    mark.MarksObtained.Value
                        / mark.ExaminationSubject.MaximumMarks
                        * 100)
                : null;
            mark.UpdatedAtUtc = DateTimeOffset.UtcNow;
        }

        exam.Status = ExaminationStatus.Published;
        exam.PublishedByUserId = userId;
        exam.PublishedAtUtc = DateTimeOffset.UtcNow;
        exam.UpdatedAtUtc = DateTimeOffset.UtcNow;
        dbContext.Add(new ExaminationStatusChange
        {
            ExaminationId = exam.Id,
            OldStatus = ExaminationStatus.MarksEntry,
            NewStatus = ExaminationStatus.Published,
            Reason = "Results reviewed and published",
            ChangedByUserId = userId,
        });
        auditWriter.Add(
            "examination.results.published",
            nameof(Examination),
            exam.Id,
            new { Status = ExaminationStatus.MarksEntry },
            new
            {
                Status = ExaminationStatus.Published,
                exam.PublishedAtUtc,
                Students = enrollmentIds.Count,
                Subjects = subjectIds.Count,
            });
        await dbContext.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        StatusMessage = "Results published. Marks are now locked.";
        return RedirectToPage(new { ExaminationId = exam.Id, SectionId });
    }

    public async Task<IActionResult> OnPostReopenAsync(
        Guid id,
        CancellationToken cancellationToken)
    {
        if (!CanPublish)
        {
            return Forbid();
        }

        if (string.IsNullOrWhiteSpace(ReopenReason)
            || ReopenReason.Trim().Length < 5)
        {
            ModelState.AddModelError(
                string.Empty,
                "Give a reason of at least five characters for reopening results.");
            ExaminationId = id;
            await LoadAsync(cancellationToken);
            return Page();
        }

        var exam = await dbContext.Set<Examination>()
            .Include(x => x.AcademicYear)
            .SingleOrDefaultAsync(x => x.Id == id, cancellationToken);
        if (exam is null)
        {
            return NotFound();
        }

        if (exam.Status != ExaminationStatus.Published)
        {
            ModelState.AddModelError(
                string.Empty,
                "Only published results can be reopened.");
        }

        if (exam.AcademicYear.Status == AcademicYearStatus.Closed)
        {
            ModelState.AddModelError(
                string.Empty,
                "Published results cannot be reopened in a closed year.");
        }

        if (!ModelState.IsValid)
        {
            ExaminationId = exam.Id;
            await LoadAsync(cancellationToken);
            return Page();
        }

        if (!MarkAccessService.TryGetUserId(User, out var userId))
        {
            return Challenge();
        }

        var reason = ReopenReason.Trim();
        var publishedAt = exam.PublishedAtUtc;
        exam.Status = ExaminationStatus.MarksEntry;
        exam.PublishedAtUtc = null;
        exam.PublishedByUserId = null;
        exam.UpdatedAtUtc = DateTimeOffset.UtcNow;
        dbContext.Add(new ExaminationStatusChange
        {
            ExaminationId = exam.Id,
            OldStatus = ExaminationStatus.Published,
            NewStatus = ExaminationStatus.MarksEntry,
            Reason = reason,
            ChangedByUserId = userId,
        });
        auditWriter.Add(
            "examination.results.reopened",
            nameof(Examination),
            exam.Id,
            new
            {
                Status = ExaminationStatus.Published,
                PublishedAtUtc = publishedAt,
            },
            new
            {
                Status = ExaminationStatus.MarksEntry,
                Reason = reason,
            });
        await dbContext.SaveChangesAsync(cancellationToken);
        StatusMessage =
            "Results reopened. Confirm the marks-entry window before staff make corrections.";
        return RedirectToPage(new { ExaminationId = exam.Id, SectionId });
    }

    private async Task LoadAsync(CancellationToken cancellationToken)
    {
        var exams = await dbContext.Set<Examination>()
            .AsNoTracking()
            .Include(x => x.AcademicYear)
            .Include(x => x.Class)
            .Where(x => x.Status != ExaminationStatus.Setup)
            .OrderByDescending(x => x.AcademicYear.StartDate)
            .ThenByDescending(x => x.StartDate)
            .ToListAsync(cancellationToken);
        Examinations = exams.Select(x => new ExamOption(
            x.Id,
            $"{x.Class.Name} · {x.Name}",
            x.Status)).ToList();
        if (!ExaminationId.HasValue && exams.Count > 0)
        {
            ExaminationId = exams[0].Id;
        }

        SelectedExamination = exams.FirstOrDefault(x => x.Id == ExaminationId);
        if (SelectedExamination is null)
        {
            return;
        }

        var accessibleIds = await AccessibleSectionIdsAsync(cancellationToken);
        var sections = await dbContext.Set<Section>()
            .AsNoTracking()
            .Include(x => x.Class)
            .Where(x =>
                accessibleIds.Contains(x.Id)
                && x.AcademicYearId == SelectedExamination.AcademicYearId
                && x.ClassId == SelectedExamination.ClassId
                && x.IsActive)
            .OrderBy(x => x.Name)
            .ToListAsync(cancellationToken);
        Sections = sections.Select(x => new SectionOption(
            x.Id,
            $"{x.Class.Name} {x.Name}")).ToList();
        if (!SectionId.HasValue && sections.Count > 0)
        {
            SectionId = sections[0].Id;
        }

        var selectedSection = sections.FirstOrDefault(x => x.Id == SectionId);
        if (selectedSection is null)
        {
            return;
        }

        var subjects = await dbContext.Set<ExaminationSubject>()
            .AsNoTracking()
            .Include(x => x.Subject)
            .Where(x => x.ExaminationId == SelectedExamination.Id)
            .OrderBy(x => x.Subject.Name)
            .ToListAsync(cancellationToken);
        var enrollments = await dbContext.Set<StudentEnrollment>()
            .AsNoTracking()
            .Include(x => x.Student)
            .Where(x =>
                x.SectionId == selectedSection.Id
                && x.AcademicYearId == SelectedExamination.AcademicYearId
                && x.Status == EnrollmentStatus.Active
                && x.Student.Status == StudentStatus.Active)
            .OrderBy(x => x.RollNumber)
            .ToListAsync(cancellationToken);
        var enrollmentIds = enrollments.Select(x => x.Id).ToList();
        var subjectIds = subjects.Select(x => x.Id).ToList();
        var marks = await dbContext.Set<StudentMark>()
            .AsNoTracking()
            .Where(x =>
                subjectIds.Contains(x.ExaminationSubjectId)
                && enrollmentIds.Contains(x.StudentEnrollmentId))
            .ToListAsync(cancellationToken);
        var markLookup = marks.ToDictionary(x =>
            (x.StudentEnrollmentId, x.ExaminationSubjectId));
        var rules = await dbContext.Set<GradeRule>()
            .AsNoTracking()
            .Where(x =>
                x.AcademicYearId == SelectedExamination.AcademicYearId
                && x.ClassId == SelectedExamination.ClassId)
            .OrderByDescending(x => x.MinimumPercent)
            .ToListAsync(cancellationToken);

        var results = new List<ResultRow>();
        foreach (var enrollment in enrollments)
        {
            var lines = new List<ResultLine>();
            var missing = 0;
            decimal obtained = 0;
            decimal maximum = 0;
            foreach (var subject in subjects)
            {
                markLookup.TryGetValue((enrollment.Id, subject.Id), out var mark);
                if (mark is null
                    || (!mark.MarksObtained.HasValue && !mark.IsAbsent))
                {
                    missing++;
                }

                maximum += subject.MaximumMarks;
                obtained += mark?.MarksObtained ?? 0;
                lines.Add(new ResultLine(
                    subject.Subject.Name,
                    subject.MaximumMarks,
                    subject.PassMarks,
                    mark?.MarksObtained,
                    mark?.IsAbsent ?? false,
                    mark?.Grade,
                    mark?.Remarks));
            }

            var percentage = maximum == 0
                ? (decimal?)null
                : Math.Round(obtained / maximum * 100, 2);
            results.Add(new ResultRow(
                enrollment.RollNumber,
                enrollment.Student.AdmissionNumber,
                enrollment.Student.FullName,
                obtained,
                maximum,
                percentage,
                percentage.HasValue ? GradeFor(rules, percentage.Value) : null,
                missing,
                lines));
        }

        Results = results;
        MissingMarks = results.Sum(x => x.Missing);
        StatusHistory = await dbContext.Set<ExaminationStatusChange>()
            .AsNoTracking()
            .Where(x => x.ExaminationId == SelectedExamination.Id)
            .OrderByDescending(x => x.ChangedAtUtc)
            .Select(x => new StatusRow(
                x.OldStatus,
                x.NewStatus,
                x.Reason,
                x.ChangedAtUtc))
            .ToListAsync(cancellationToken);
    }

    private async Task<IReadOnlyList<Guid>> AccessibleSectionIdsAsync(
        CancellationToken cancellationToken)
    {
        if (CanReview || CanPublish)
        {
            return await dbContext.Set<Section>()
                .Where(x => x.IsActive)
                .Select(x => x.Id)
                .ToListAsync(cancellationToken);
        }

        if (!Guid.TryParse(
            User.FindFirstValue(ClaimTypes.NameIdentifier),
            out var userId))
        {
            return [];
        }

        return await dbContext.Set<Section>()
            .Where(x =>
                x.IsActive
                && (x.ClassTeacherUserId == userId
                    || dbContext.Set<TeacherAssignment>().Any(assignment =>
                        assignment.SectionId == x.Id
                        && assignment.TeacherUserId == userId)))
            .Select(x => x.Id)
            .Distinct()
            .ToListAsync(cancellationToken);
    }

    private static string? GradeFor(
        IReadOnlyList<GradeRule> rules,
        decimal percentage) =>
        rules.FirstOrDefault(x =>
            percentage >= x.MinimumPercent
            && percentage <= x.MaximumPercent)?.Grade;

    public sealed record ExamOption(
        Guid Id,
        string Name,
        ExaminationStatus Status);

    public sealed record SectionOption(Guid Id, string Name);

    public sealed record ResultRow(
        int RollNumber,
        string AdmissionNumber,
        string StudentName,
        decimal Obtained,
        decimal Maximum,
        decimal? Percentage,
        string? Grade,
        int Missing,
        IReadOnlyList<ResultLine> Lines);

    public sealed record ResultLine(
        string SubjectName,
        decimal Maximum,
        decimal Pass,
        decimal? Obtained,
        bool IsAbsent,
        string? Grade,
        string? Remarks);

    public sealed record StatusRow(
        ExaminationStatus OldStatus,
        ExaminationStatus NewStatus,
        string? Reason,
        DateTimeOffset ChangedAtUtc);
}
