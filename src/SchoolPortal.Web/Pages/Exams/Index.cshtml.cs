using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Academics;
using SchoolPortal.Domain.Examinations;
using SchoolPortal.Infrastructure.Persistence;
using SchoolPortal.Web.Administration;
using SchoolPortal.Web.Examinations;

namespace SchoolPortal.Web.Pages.Exams;

[Authorize(Policy = PermissionCatalog.PolicyPrefix + PermissionCatalog.Exams.View)]
public sealed class IndexModel(
    SchoolPortalDbContext dbContext,
    AuditWriter auditWriter) : PageModel
{
    [BindProperty(SupportsGet = true)]
    public Guid? SelectedExamId { get; set; }

    [BindProperty]
    public ExaminationInput NewExam { get; set; } = new();

    [BindProperty]
    public ExaminationSubjectInput NewSubject { get; set; } = new();

    [BindProperty]
    public GradeRuleInput NewGrade { get; set; } = new();

    [BindProperty]
    public EntryWindowInput EntryWindow { get; set; } = new();

    [TempData]
    public string? StatusMessage { get; set; }

    public IReadOnlyList<Examination> Examinations { get; private set; } = [];

    public IReadOnlyList<AcademicYear> AcademicYears { get; private set; } = [];

    public IReadOnlyList<SchoolClass> Classes { get; private set; } = [];

    public IReadOnlyList<Subject> Subjects { get; private set; } = [];

    public IReadOnlyList<GradeRule> GradeRules { get; private set; } = [];

    public Examination? SelectedExam { get; private set; }

    public bool CanConfigure => User.HasClaim(
        PermissionCatalog.ClaimType,
        PermissionCatalog.Exams.Configure);

    public async Task OnGetAsync(CancellationToken cancellationToken) =>
        await LoadAsync(cancellationToken);

    public async Task<IActionResult> OnPostCreateExamAsync(
        CancellationToken cancellationToken)
    {
        if (!CanConfigure)
        {
            return Forbid();
        }

        ModelState.Clear();
        if (!TryValidateModel(NewExam, nameof(NewExam)))
        {
            await LoadAsync(cancellationToken);
            return Page();
        }

        var year = await dbContext.Set<AcademicYear>()
            .SingleOrDefaultAsync(x => x.Id == NewExam.AcademicYearId, cancellationToken);
        var schoolClass = await dbContext.Set<SchoolClass>()
            .SingleOrDefaultAsync(
                x => x.Id == NewExam.ClassId && x.IsActive,
                cancellationToken);
        if (year is null || schoolClass is null)
        {
            ModelState.AddModelError(string.Empty, "Choose a valid year and class.");
        }
        else if (year.Status == AcademicYearStatus.Closed)
        {
            ModelState.AddModelError(string.Empty, "Exams cannot be added to a closed year.");
        }

        ValidateDatesAndWindow(
            NewExam.StartDate,
            NewExam.EndDate,
            NewExam.MarksEntryOpensAtUtc,
            NewExam.MarksEntryClosesAtUtc);
        if (!ModelState.IsValid)
        {
            await LoadAsync(cancellationToken);
            return Page();
        }

        var exam = new Examination
        {
            AcademicYearId = NewExam.AcademicYearId,
            ClassId = NewExam.ClassId,
            Name = NewExam.Name.Trim(),
            Term = string.IsNullOrWhiteSpace(NewExam.Term)
                ? NewExam.Name.Trim()
                : NewExam.Term.Trim(),
            StartDate = NewExam.StartDate,
            EndDate = NewExam.EndDate,
            Weightage = NewExam.Weightage,
            MarksEntryOpensAtUtc = NewExam.MarksEntryOpensAtUtc,
            MarksEntryClosesAtUtc = NewExam.MarksEntryClosesAtUtc,
        };
        dbContext.Add(exam);
        auditWriter.Add(
            "examination.created",
            nameof(Examination),
            exam.Id,
            null,
            new
            {
                exam.AcademicYearId,
                exam.ClassId,
                exam.Name,
                exam.Term,
                exam.StartDate,
                exam.EndDate,
                exam.MarksEntryOpensAtUtc,
                exam.MarksEntryClosesAtUtc,
            });

        return await SaveAndRedirectAsync(
            "Examination created. Add subjects and grade bands next.",
            exam.Id,
            cancellationToken);
    }

    public async Task<IActionResult> OnPostAddSubjectAsync(
        CancellationToken cancellationToken)
    {
        if (!CanConfigure)
        {
            return Forbid();
        }

        ModelState.Clear();
        if (!TryValidateModel(NewSubject, nameof(NewSubject)))
        {
            SelectedExamId = NewSubject.ExaminationId;
            await LoadAsync(cancellationToken);
            return Page();
        }

        var exam = await dbContext.Set<Examination>()
            .Include(x => x.AcademicYear)
            .SingleOrDefaultAsync(
                x => x.Id == NewSubject.ExaminationId,
                cancellationToken);
        var subject = await dbContext.Set<Subject>()
            .SingleOrDefaultAsync(
                x => x.Id == NewSubject.SubjectId && x.IsActive,
                cancellationToken);
        if (exam is null || subject is null || subject.ClassId != exam?.ClassId)
        {
            return NotFound();
        }

        if (exam.Status == ExaminationStatus.Published)
        {
            ModelState.AddModelError(
                string.Empty,
                "Published examination setup is locked.");
        }

        if (exam.AcademicYear.Status == AcademicYearStatus.Closed)
        {
            ModelState.AddModelError(
                string.Empty,
                "Examination setup cannot change in a closed year.");
        }

        if (NewSubject.PassMarks > NewSubject.MaximumMarks)
        {
            ModelState.AddModelError(
                string.Empty,
                "Pass marks cannot exceed maximum marks.");
        }

        if (NewSubject.StartsAt.HasValue
            && NewSubject.EndsAt.HasValue
            && NewSubject.EndsAt <= NewSubject.StartsAt)
        {
            ModelState.AddModelError(
                string.Empty,
                "The subject end time must be after its start time.");
        }

        if (!ModelState.IsValid)
        {
            SelectedExamId = exam.Id;
            await LoadAsync(cancellationToken);
            return Page();
        }

        var examSubject = new ExaminationSubject
        {
            ExaminationId = exam.Id,
            SubjectId = subject.Id,
            MaximumMarks = NewSubject.MaximumMarks,
            PassMarks = NewSubject.PassMarks,
            ExaminationDate = NewSubject.ExaminationDate,
            StartsAt = NewSubject.StartsAt,
            EndsAt = NewSubject.EndsAt,
            Weightage = NewSubject.Weightage,
        };
        dbContext.Add(examSubject);
        auditWriter.Add(
            "examination.subject.added",
            nameof(ExaminationSubject),
            examSubject.Id,
            null,
            new
            {
                examSubject.ExaminationId,
                examSubject.SubjectId,
                examSubject.MaximumMarks,
                examSubject.PassMarks,
                examSubject.ExaminationDate,
            });
        return await SaveAndRedirectAsync(
            $"{subject.Name} added to {exam.Name}.",
            exam.Id,
            cancellationToken);
    }

    public async Task<IActionResult> OnPostAddGradeAsync(
        CancellationToken cancellationToken)
    {
        if (!CanConfigure)
        {
            return Forbid();
        }

        ModelState.Clear();
        if (!TryValidateModel(NewGrade, nameof(NewGrade)))
        {
            await LoadAsync(cancellationToken);
            return Page();
        }

        var year = await dbContext.Set<AcademicYear>()
            .SingleOrDefaultAsync(
                x => x.Id == NewGrade.AcademicYearId,
                cancellationToken);
        var classExists = await dbContext.Set<SchoolClass>()
            .AnyAsync(
                x => x.Id == NewGrade.ClassId && x.IsActive,
                cancellationToken);
        if (year is null || !classExists)
        {
            return NotFound();
        }

        if (year.Status == AcademicYearStatus.Closed)
        {
            ModelState.AddModelError(
                string.Empty,
                "Grade bands cannot change in a closed year.");
        }

        if (await dbContext.Set<Examination>().AnyAsync(
            x => x.AcademicYearId == year.Id
                && x.ClassId == NewGrade.ClassId
                && x.Status == ExaminationStatus.Published,
            cancellationToken))
        {
            ModelState.AddModelError(
                string.Empty,
                "Grade bands are locked after results have been published.");
        }

        if (NewGrade.MinimumPercent > NewGrade.MaximumPercent)
        {
            ModelState.AddModelError(
                string.Empty,
                "The grade minimum cannot exceed its maximum.");
        }

        var overlaps = await dbContext.Set<GradeRule>().AnyAsync(
            x => x.AcademicYearId == NewGrade.AcademicYearId
                && x.ClassId == NewGrade.ClassId
                && NewGrade.MinimumPercent <= x.MaximumPercent
                && NewGrade.MaximumPercent >= x.MinimumPercent,
            cancellationToken);
        if (overlaps)
        {
            ModelState.AddModelError(
                string.Empty,
                "That percentage range overlaps an existing grade band.");
        }

        if (!ModelState.IsValid)
        {
            await LoadAsync(cancellationToken);
            return Page();
        }

        var rule = new GradeRule
        {
            AcademicYearId = NewGrade.AcademicYearId,
            ClassId = NewGrade.ClassId,
            Grade = NewGrade.Grade.Trim().ToUpperInvariant(),
            MinimumPercent = NewGrade.MinimumPercent,
            MaximumPercent = NewGrade.MaximumPercent,
            Points = NewGrade.Points,
            Description = Normalize(NewGrade.Description),
        };
        dbContext.Add(rule);
        auditWriter.Add(
            "grade-rule.created",
            nameof(GradeRule),
            rule.Id,
            null,
            new
            {
                rule.AcademicYearId,
                rule.ClassId,
                rule.Grade,
                rule.MinimumPercent,
                rule.MaximumPercent,
            });
        return await SaveAndRedirectAsync(
            $"Grade {rule.Grade} added.",
            SelectedExamId,
            cancellationToken);
    }

    public async Task<IActionResult> OnPostUpdateWindowAsync(
        CancellationToken cancellationToken)
    {
        if (!CanConfigure)
        {
            return Forbid();
        }

        ModelState.Clear();
        if (!TryValidateModel(EntryWindow, nameof(EntryWindow)))
        {
            SelectedExamId = EntryWindow.ExaminationId;
            await LoadAsync(cancellationToken);
            return Page();
        }

        var exam = await dbContext.Set<Examination>()
            .Include(x => x.AcademicYear)
            .SingleOrDefaultAsync(
                x => x.Id == EntryWindow.ExaminationId,
                cancellationToken);
        if (exam is null)
        {
            return NotFound();
        }

        if (exam.Status == ExaminationStatus.Published
            || exam.AcademicYear.Status == AcademicYearStatus.Closed)
        {
            ModelState.AddModelError(
                string.Empty,
                "The entry window is locked for this examination.");
        }

        ValidateDatesAndWindow(
            exam.StartDate,
            exam.EndDate,
            EntryWindow.OpensAtUtc,
            EntryWindow.ClosesAtUtc);
        if (!ModelState.IsValid)
        {
            SelectedExamId = exam.Id;
            await LoadAsync(cancellationToken);
            return Page();
        }

        var before = new
        {
            exam.MarksEntryOpensAtUtc,
            exam.MarksEntryClosesAtUtc,
        };
        exam.MarksEntryOpensAtUtc = EntryWindow.OpensAtUtc;
        exam.MarksEntryClosesAtUtc = EntryWindow.ClosesAtUtc;
        exam.UpdatedAtUtc = DateTimeOffset.UtcNow;
        auditWriter.Add(
            "examination.entry-window.updated",
            nameof(Examination),
            exam.Id,
            before,
            new
            {
                exam.MarksEntryOpensAtUtc,
                exam.MarksEntryClosesAtUtc,
            });
        return await SaveAndRedirectAsync(
            "Marks entry window updated.",
            exam.Id,
            cancellationToken);
    }

    public async Task<IActionResult> OnPostOpenMarksAsync(
        Guid id,
        CancellationToken cancellationToken)
    {
        if (!CanConfigure)
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

        if (exam.Status != ExaminationStatus.Setup)
        {
            ModelState.AddModelError(
                string.Empty,
                "Only an examination in setup can be opened for marks.");
        }

        if (exam.Subjects.Count == 0)
        {
            ModelState.AddModelError(
                string.Empty,
                "Add at least one subject before opening marks entry.");
        }

        if (!await dbContext.Set<GradeRule>().AnyAsync(
            x => x.AcademicYearId == exam.AcademicYearId
                && x.ClassId == exam.ClassId,
            cancellationToken))
        {
            ModelState.AddModelError(
                string.Empty,
                "Configure grade bands before opening marks entry.");
        }

        if (exam.AcademicYear.Status == AcademicYearStatus.Closed)
        {
            ModelState.AddModelError(
                string.Empty,
                "A closed academic year cannot accept marks.");
        }

        if (exam.MarksEntryClosesAtUtc.HasValue
            && exam.MarksEntryClosesAtUtc <= DateTimeOffset.UtcNow)
        {
            ModelState.AddModelError(
                string.Empty,
                "Set a future marks-entry closing time.");
        }

        if (!ModelState.IsValid)
        {
            SelectedExamId = exam.Id;
            await LoadAsync(cancellationToken);
            return Page();
        }

        if (!MarkAccessService.TryGetUserId(User, out var userId))
        {
            return Challenge();
        }

        exam.Status = ExaminationStatus.MarksEntry;
        exam.UpdatedAtUtc = DateTimeOffset.UtcNow;
        dbContext.Add(new ExaminationStatusChange
        {
            ExaminationId = exam.Id,
            OldStatus = ExaminationStatus.Setup,
            NewStatus = ExaminationStatus.MarksEntry,
            Reason = "Marks entry opened",
            ChangedByUserId = userId,
        });
        auditWriter.Add(
            "examination.marks-entry.opened",
            nameof(Examination),
            exam.Id,
            new { Status = ExaminationStatus.Setup },
            new { Status = ExaminationStatus.MarksEntry });
        return await SaveAndRedirectAsync(
            "Marks entry is now open.",
            exam.Id,
            cancellationToken);
    }

    private async Task<IActionResult> SaveAndRedirectAsync(
        string message,
        Guid? examId,
        CancellationToken cancellationToken)
    {
        try
        {
            await dbContext.SaveChangesAsync(cancellationToken);
            StatusMessage = message;
            return RedirectToPage(new { SelectedExamId = examId });
        }
        catch (DbUpdateException)
        {
            ModelState.AddModelError(
                string.Empty,
                "That examination record conflicts with an existing record.");
            SelectedExamId = examId;
            await LoadAsync(cancellationToken);
            return Page();
        }
    }

    private async Task LoadAsync(CancellationToken cancellationToken)
    {
        Examinations = await dbContext.Set<Examination>()
            .AsNoTracking()
            .Include(x => x.AcademicYear)
            .Include(x => x.Class)
            .Include(x => x.Subjects)
                .ThenInclude(x => x.Subject)
            .OrderByDescending(x => x.AcademicYear.StartDate)
            .ThenByDescending(x => x.StartDate)
            .ThenBy(x => x.Name)
            .ToListAsync(cancellationToken);
        if (!SelectedExamId.HasValue && Examinations.Count > 0)
        {
            SelectedExamId = Examinations[0].Id;
        }

        SelectedExam = Examinations.FirstOrDefault(x => x.Id == SelectedExamId);
        AcademicYears = await dbContext.Set<AcademicYear>()
            .AsNoTracking()
            .OrderByDescending(x => x.StartDate)
            .ToListAsync(cancellationToken);
        Classes = await dbContext.Set<SchoolClass>()
            .AsNoTracking()
            .Where(x => x.IsActive)
            .OrderBy(x => x.SortOrder)
            .ThenBy(x => x.Name)
            .ToListAsync(cancellationToken);
        Subjects = SelectedExam is null
            ? []
            : await dbContext.Set<Subject>()
                .AsNoTracking()
                .Where(x => x.IsActive && x.ClassId == SelectedExam.ClassId)
                .OrderBy(x => x.Name)
                .ToListAsync(cancellationToken);
        GradeRules = SelectedExam is null
            ? []
            : await dbContext.Set<GradeRule>()
                .AsNoTracking()
                .Where(x =>
                    x.AcademicYearId == SelectedExam.AcademicYearId
                    && x.ClassId == SelectedExam.ClassId)
                .OrderByDescending(x => x.MinimumPercent)
                .ToListAsync(cancellationToken);
    }

    private void ValidateDatesAndWindow(
        DateOnly? startDate,
        DateOnly? endDate,
        DateTimeOffset? opensAtUtc,
        DateTimeOffset? closesAtUtc)
    {
        if (startDate.HasValue
            && endDate.HasValue
            && endDate < startDate)
        {
            ModelState.AddModelError(
                string.Empty,
                "The examination end date cannot be before its start date.");
        }

        if (opensAtUtc.HasValue
            && closesAtUtc.HasValue
            && closesAtUtc <= opensAtUtc)
        {
            ModelState.AddModelError(
                string.Empty,
                "The marks-entry closing time must be after its opening time.");
        }
    }

    private static string? Normalize(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    public sealed class ExaminationInput
    {
        [Required]
        public Guid AcademicYearId { get; set; }

        [Required]
        public Guid ClassId { get; set; }

        [Required, StringLength(150)]
        public string Name { get; set; } = string.Empty;

        [StringLength(100)]
        public string? Term { get; set; }

        [DataType(DataType.Date)]
        public DateOnly? StartDate { get; set; }

        [DataType(DataType.Date)]
        public DateOnly? EndDate { get; set; }

        [Range(0, 100)]
        public decimal Weightage { get; set; } = 100;

        [DataType(DataType.DateTime)]
        public DateTimeOffset? MarksEntryOpensAtUtc { get; set; }

        [DataType(DataType.DateTime)]
        public DateTimeOffset? MarksEntryClosesAtUtc { get; set; }
    }

    public sealed class ExaminationSubjectInput
    {
        [Required]
        public Guid ExaminationId { get; set; }

        [Required]
        public Guid SubjectId { get; set; }

        [Range(0.01, 1000)]
        public decimal MaximumMarks { get; set; } = 100;

        [Range(0, 1000)]
        public decimal PassMarks { get; set; } = 33;

        [DataType(DataType.Date)]
        public DateOnly? ExaminationDate { get; set; }

        [DataType(DataType.Time)]
        public TimeOnly? StartsAt { get; set; }

        [DataType(DataType.Time)]
        public TimeOnly? EndsAt { get; set; }

        [Range(0, 100)]
        public decimal Weightage { get; set; } = 100;
    }

    public sealed class GradeRuleInput
    {
        [Required]
        public Guid AcademicYearId { get; set; }

        [Required]
        public Guid ClassId { get; set; }

        [Required, StringLength(10)]
        public string Grade { get; set; } = string.Empty;

        [Range(0, 100)]
        public decimal MinimumPercent { get; set; }

        [Range(0, 100)]
        public decimal MaximumPercent { get; set; } = 100;

        [Range(0, 100)]
        public decimal? Points { get; set; }

        [StringLength(300)]
        public string? Description { get; set; }
    }

    public sealed class EntryWindowInput
    {
        [Required]
        public Guid ExaminationId { get; set; }

        [DataType(DataType.DateTime)]
        public DateTimeOffset? OpensAtUtc { get; set; }

        [DataType(DataType.DateTime)]
        public DateTimeOffset? ClosesAtUtc { get; set; }
    }
}
