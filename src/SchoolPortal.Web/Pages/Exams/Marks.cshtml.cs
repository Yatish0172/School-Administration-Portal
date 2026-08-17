using System.ComponentModel.DataAnnotations;
using System.Data;
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
public sealed class MarksModel(
    SchoolPortalDbContext dbContext,
    MarkAccessService accessService,
    AuditWriter auditWriter) : PageModel
{
    [BindProperty(SupportsGet = true)]
    public Guid? ExaminationId { get; set; }

    [BindProperty(SupportsGet = true)]
    public Guid? ExaminationSubjectId { get; set; }

    [BindProperty(SupportsGet = true)]
    public Guid? SectionId { get; set; }

    [BindProperty]
    public List<MarkInput> Entries { get; set; } = [];

    [TempData]
    public string? StatusMessage { get; set; }

    public IReadOnlyList<ExaminationOption> Examinations { get; private set; } = [];

    public IReadOnlyList<SubjectOption> Subjects { get; private set; } = [];

    public IReadOnlyList<SectionOption> Sections { get; private set; } = [];

    public IReadOnlyList<MarkRow> Roster { get; private set; } = [];

    public Examination? SelectedExamination { get; private set; }

    public ExaminationSubject? SelectedSubject { get; private set; }

    public bool CanEnter { get; private set; }

    public string? LockReason { get; private set; }

    public async Task OnGetAsync(CancellationToken cancellationToken) =>
        await LoadAsync(cancellationToken);

    public async Task<IActionResult> OnPostSaveAsync(
        CancellationToken cancellationToken)
    {
        ModelState.Clear();
        TryValidateModel(Entries, nameof(Entries));
        if (!ExaminationId.HasValue
            || !ExaminationSubjectId.HasValue
            || !SectionId.HasValue)
        {
            ModelState.AddModelError(
                string.Empty,
                "Choose an examination, subject, and section.");
            await LoadAsync(cancellationToken);
            return Page();
        }

        if (!MarkAccessService.TryGetUserId(User, out var userId))
        {
            return Challenge();
        }

        var examSubject = await dbContext.Set<ExaminationSubject>()
            .Include(x => x.Subject)
            .Include(x => x.Examination)
                .ThenInclude(x => x.AcademicYear)
            .SingleOrDefaultAsync(
                x => x.Id == ExaminationSubjectId.Value
                    && x.ExaminationId == ExaminationId.Value,
                cancellationToken);
        var section = await dbContext.Set<Section>()
            .Include(x => x.Class)
            .SingleOrDefaultAsync(
                x => x.Id == SectionId.Value && x.IsActive,
                cancellationToken);
        if (examSubject is null
            || section is null
            || section.ClassId != examSubject.Examination.ClassId
            || section.AcademicYearId != examSubject.Examination.AcademicYearId)
        {
            return NotFound();
        }

        if (!await accessService.CanEnterAsync(
            User,
            section.Id,
            examSubject.SubjectId,
            cancellationToken))
        {
            return Forbid();
        }

        ValidateEntryState(examSubject.Examination);
        var rosterIds = await dbContext.Set<StudentEnrollment>()
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
            || rosterIds.Count != submittedIds.Count
            || rosterIds.Except(submittedIds).Any())
        {
            ModelState.AddModelError(
                string.Empty,
                "The class roster changed. Reload and try again.");
        }

        foreach (var input in Entries)
        {
            if (!input.IsAbsent
                && input.MarksObtained.HasValue
                && input.MarksObtained > examSubject.MaximumMarks)
            {
                ModelState.AddModelError(
                    string.Empty,
                    $"Marks cannot exceed {examSubject.MaximumMarks}.");
            }
        }

        if (!ModelState.IsValid)
        {
            await LoadAsync(cancellationToken);
            return Page();
        }

        var gradeRules = await dbContext.Set<GradeRule>()
            .AsNoTracking()
            .Where(x =>
                x.AcademicYearId == examSubject.Examination.AcademicYearId
                && x.ClassId == examSubject.Examination.ClassId)
            .OrderByDescending(x => x.MinimumPercent)
            .ToListAsync(cancellationToken);

        await using var transaction = await dbContext.Database.BeginTransactionAsync(
            IsolationLevel.Serializable,
            cancellationToken);
        var lockKey =
            $"marks:{examSubject.Id:N}:{section.Id:N}";
        await dbContext.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock(hashtext({lockKey}))",
            cancellationToken);
        var existing = await dbContext.Set<StudentMark>()
            .Where(x =>
                x.ExaminationSubjectId == examSubject.Id
                && rosterIds.Contains(x.StudentEnrollmentId))
            .ToDictionaryAsync(x => x.StudentEnrollmentId, cancellationToken);
        var now = DateTimeOffset.UtcNow;
        var changed = 0;
        foreach (var input in Entries)
        {
            existing.TryGetValue(input.EnrollmentId, out var mark);
            if (!input.IsAbsent && !input.MarksObtained.HasValue)
            {
                if (mark is not null)
                {
                    dbContext.Remove(mark);
                    changed++;
                }

                continue;
            }

            var obtained = input.IsAbsent ? null : input.MarksObtained;
            var grade = obtained.HasValue
                ? GradeFor(
                    gradeRules,
                    obtained.Value / examSubject.MaximumMarks * 100)
                : null;
            if (mark is null)
            {
                mark = new StudentMark
                {
                    ExaminationSubjectId = examSubject.Id,
                    StudentEnrollmentId = input.EnrollmentId,
                    EnteredByUserId = userId,
                    EnteredAtUtc = now,
                };
                dbContext.Add(mark);
            }

            if (mark.MarksObtained != obtained
                || mark.IsAbsent != input.IsAbsent
                || mark.Remarks != Normalize(input.Remarks)
                || mark.Grade != grade)
            {
                changed++;
            }

            mark.MarksObtained = obtained;
            mark.IsAbsent = input.IsAbsent;
            mark.Grade = grade;
            mark.Remarks = Normalize(input.Remarks);
            mark.EnteredByUserId = userId;
            mark.UpdatedAtUtc = now;
        }

        auditWriter.Add(
            "marks.saved",
            nameof(ExaminationSubject),
            examSubject.Id,
            null,
            new
            {
                examSubject.ExaminationId,
                SectionId = section.Id,
                Changed = changed,
                TotalRows = Entries.Count,
            });
        await dbContext.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        StatusMessage = $"Marks saved for {examSubject.Subject.Name}, {section.Class.Name} {section.Name}.";
        return RedirectToPage(new
        {
            ExaminationId,
            ExaminationSubjectId,
            SectionId,
        });
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
        Examinations = exams
            .Select(x => new ExaminationOption(
                x.Id,
                $"{x.Class.Name} · {x.Name}",
                x.Status))
            .ToList();
        if (!ExaminationId.HasValue && exams.Count > 0)
        {
            ExaminationId = exams[0].Id;
        }

        SelectedExamination = exams.FirstOrDefault(x => x.Id == ExaminationId);
        if (SelectedExamination is null)
        {
            return;
        }

        var subjects = await dbContext.Set<ExaminationSubject>()
            .AsNoTracking()
            .Include(x => x.Subject)
            .Where(x => x.ExaminationId == SelectedExamination.Id)
            .OrderBy(x => x.ExaminationDate)
            .ThenBy(x => x.Subject.Name)
            .ToListAsync(cancellationToken);
        Subjects = subjects
            .Select(x => new SubjectOption(
                x.Id,
                x.SubjectId,
                $"{x.Subject.Name} · max {x.MaximumMarks}"))
            .ToList();
        if (!ExaminationSubjectId.HasValue && subjects.Count > 0)
        {
            ExaminationSubjectId = subjects[0].Id;
        }

        SelectedSubject = subjects.FirstOrDefault(x =>
            x.Id == ExaminationSubjectId);
        if (SelectedSubject is null)
        {
            return;
        }

        var sections = await dbContext.Set<Section>()
            .AsNoTracking()
            .Include(x => x.Class)
            .Where(x =>
                x.AcademicYearId == SelectedExamination.AcademicYearId
                && x.ClassId == SelectedExamination.ClassId
                && x.IsActive)
            .OrderBy(x => x.Name)
            .ToListAsync(cancellationToken);
        var accessible = new List<Section>();
        foreach (var item in sections)
        {
            if (await accessService.CanEnterAsync(
                User,
                item.Id,
                SelectedSubject.SubjectId,
                cancellationToken)
                || User.HasClaim(
                    PermissionCatalog.ClaimType,
                    PermissionCatalog.Marks.Review)
                || User.HasClaim(
                    PermissionCatalog.ClaimType,
                    PermissionCatalog.Marks.Publish))
            {
                accessible.Add(item);
            }
        }

        Sections = accessible
            .Select(x => new SectionOption(
                x.Id,
                $"{x.Class.Name} {x.Name}"))
            .ToList();
        if (!SectionId.HasValue && accessible.Count > 0)
        {
            SectionId = accessible[0].Id;
        }

        var selectedSection = accessible.FirstOrDefault(x => x.Id == SectionId);
        if (selectedSection is null)
        {
            return;
        }

        CanEnter = await accessService.CanEnterAsync(
            User,
            selectedSection.Id,
            SelectedSubject.SubjectId,
            cancellationToken);
        LockReason = EntryLockReason(SelectedExamination);
        CanEnter = CanEnter && LockReason is null;

        var marks = await dbContext.Set<StudentMark>()
            .AsNoTracking()
            .Where(x =>
                x.ExaminationSubjectId == SelectedSubject.Id
                && x.StudentEnrollment.SectionId == selectedSection.Id)
            .ToDictionaryAsync(x => x.StudentEnrollmentId, cancellationToken);
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
        Roster = enrollments.Select(enrollment =>
        {
            marks.TryGetValue(enrollment.Id, out var mark);
            return new MarkRow(
                enrollment.Id,
                enrollment.RollNumber,
                enrollment.Student.AdmissionNumber,
                enrollment.Student.FullName,
                mark?.MarksObtained,
                mark?.IsAbsent ?? false,
                mark?.Grade,
                mark?.Remarks);
        }).ToList();
        Entries = Roster.Select(x => new MarkInput
        {
            EnrollmentId = x.EnrollmentId,
            MarksObtained = x.MarksObtained,
            IsAbsent = x.IsAbsent,
            Remarks = x.Remarks,
        }).ToList();
    }

    private void ValidateEntryState(Examination exam)
    {
        var reason = EntryLockReason(exam);
        if (reason is not null)
        {
            ModelState.AddModelError(string.Empty, reason);
        }
    }

    private static string? EntryLockReason(Examination exam)
    {
        var now = DateTimeOffset.UtcNow;
        if (exam.AcademicYear.Status == AcademicYearStatus.Closed)
        {
            return "The academic year is closed.";
        }

        if (exam.Status == ExaminationStatus.Published)
        {
            return "Published marks are read-only. Reopen the results to make a correction.";
        }

        if (exam.Status != ExaminationStatus.MarksEntry)
        {
            return "Marks entry has not been opened.";
        }

        if (exam.MarksEntryOpensAtUtc.HasValue
            && now < exam.MarksEntryOpensAtUtc)
        {
            return "The marks-entry window has not opened yet.";
        }

        if (exam.MarksEntryClosesAtUtc.HasValue
            && now > exam.MarksEntryClosesAtUtc)
        {
            return "The marks-entry window is closed.";
        }

        return null;
    }

    private static string? GradeFor(
        IReadOnlyList<GradeRule> rules,
        decimal percentage) =>
        rules.FirstOrDefault(x =>
            percentage >= x.MinimumPercent
            && percentage <= x.MaximumPercent)?.Grade;

    private static string? Normalize(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    public sealed class MarkInput
    {
        [Required]
        public Guid EnrollmentId { get; set; }

        [Range(0, 1000)]
        public decimal? MarksObtained { get; set; }

        public bool IsAbsent { get; set; }

        [StringLength(500)]
        public string? Remarks { get; set; }
    }

    public sealed record ExaminationOption(
        Guid Id,
        string Name,
        ExaminationStatus Status);

    public sealed record SubjectOption(
        Guid Id,
        Guid SubjectId,
        string Name);

    public sealed record SectionOption(Guid Id, string Name);

    public sealed record MarkRow(
        Guid EnrollmentId,
        int RollNumber,
        string AdmissionNumber,
        string StudentName,
        decimal? MarksObtained,
        bool IsAbsent,
        string? Grade,
        string? Remarks);
}
