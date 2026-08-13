using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Academics;
using SchoolPortal.Domain.Attendance;
using SchoolPortal.Domain.Staff;
using SchoolPortal.Domain.Students;
using SchoolPortal.Infrastructure.Persistence;
using SchoolPortal.Infrastructure.Identity;

namespace SchoolPortal.Web.Pages.Academics;

[Authorize(
    Policy = PermissionCatalog.PolicyPrefix + PermissionCatalog.Academics.Manage)]
public sealed class IndexModel(
    SchoolPortalDbContext dbContext,
    UserManager<ApplicationUser> userManager) : PageModel
{
    public IReadOnlyList<AcademicYear> AcademicYears { get; private set; } = [];

    public AcademicYear? ActiveAcademicYear { get; private set; }

    public IReadOnlyList<SchoolClass> Classes { get; private set; } = [];

    public IReadOnlyList<Section> Sections { get; private set; } = [];

    public IReadOnlyList<Subject> Subjects { get; private set; } = [];

    public IReadOnlyList<AcademicBreakPeriod> BreakPeriods { get; private set; } = [];

    public static IReadOnlyList<PresetClassOption> PresetClasses { get; } =
    [
        new("nursery", "Nursery", 0, 0),
        new("lkg", "LKG", 1, 10),
        new("ukg", "UKG", 2, 20),
        .. Enumerable.Range(1, 12).Select(number => new PresetClassOption(
            $"class-{number}",
            $"Class {number}",
            number + 2,
            (number + 2) * 10)),
    ];

    public IReadOnlyList<ApplicationUser> Teachers { get; private set; } = [];

    public IReadOnlyList<SubjectTeacherSummary> SubjectTeacherAssignments { get; private set; } = [];

    public IReadOnlyDictionary<Guid, string> TeacherNames { get; private set; } =
        new Dictionary<Guid, string>();

    public IReadOnlyDictionary<Guid, string> StaffNamesByUserId { get; private set; } =
        new Dictionary<Guid, string>();

    public string YearMinimumIso => new DateOnly(DateTime.Today.Year, 1, 1)
        .ToString(
            "yyyy-MM-dd",
            System.Globalization.CultureInfo.InvariantCulture);

    [BindProperty]
    public AcademicYearInput NewAcademicYear { get; set; } = new();

    [BindProperty]
    public EditAcademicYearInput EditAcademicYear { get; set; } = new();

    [BindProperty]
    public SchoolClassInput ClassInput { get; set; } = new();

    [BindProperty]
    public SectionInput NewSection { get; set; } = new();

    [BindProperty]
    public SubjectTeacherAssignmentInput NewSubjectTeacherAssignment { get; set; } = new();

    [BindProperty]
    public SubjectInput NewSubject { get; set; } = new();

    [BindProperty]
    public TeacherAssignmentInput NewTeacherAssignment { get; set; } = new();

    [BindProperty]
    public BulkClassSetupInput BulkClassSetup { get; set; } = new();

    [BindProperty]
    public EditSectionInput EditSection { get; set; } = new();

    [BindProperty]
    public SectionCountInput SectionCount { get; set; } = new();

    [BindProperty]
    public BreakPeriodInput NewBreakPeriod { get; set; } = new();

    [BindProperty]
    public EditBreakPeriodInput EditBreakPeriod { get; set; } = new();

    [TempData]
    public string? StatusMessage { get; set; }

    public async Task OnGetAsync() => await LoadAsync();

    public async Task<IActionResult> OnPostCreateYearAsync()
    {
        ModelState.Clear();
        if (!TryValidateModel(NewAcademicYear, nameof(NewAcademicYear)))
        {
            await LoadAsync();
            return Page();
        }

        if (!ValidateAcademicYearDates(NewAcademicYear, nameof(NewAcademicYear)))
        {
            await LoadAsync();
            return Page();
        }

        var name = NewAcademicYear.Name.Trim();
        if (await dbContext.Set<AcademicYear>().AnyAsync(x => x.Name == name))
        {
            ModelState.AddModelError(
                string.Empty,
                $"Academic year {name} already exists. Use its pencil icon to edit the dates.");
            await LoadAsync();
            return Page();
        }

        await using var transaction = await dbContext.Database.BeginTransactionAsync();
        await CloseOtherAcademicYearsAsync();
        dbContext.Add(new AcademicYear
        {
            Name = name,
            StartDate = NewAcademicYear.StartDate,
            EndDate = NewAcademicYear.EndDate,
            IsCurrent = true,
            Status = AcademicYearStatus.Open,
        });

        try
        {
            await dbContext.SaveChangesAsync();
            await transaction.CommitAsync();
            StatusMessage = "Academic year created and set as active.";
            return RedirectToPage();
        }
        catch (DbUpdateException)
        {
            await transaction.RollbackAsync();
            ModelState.AddModelError(
                string.Empty,
                $"Academic year {name} already exists. Use its pencil icon to edit the dates.");
            await LoadAsync();
            return Page();
        }
    }

    public async Task<IActionResult> OnPostUpdateYearAsync()
    {
        ModelState.Clear();
        if (!TryValidateModel(EditAcademicYear, nameof(EditAcademicYear))
            || !ValidateAcademicYearDates(EditAcademicYear, nameof(EditAcademicYear)))
        {
            await LoadAsync();
            return Page();
        }

        var year = await dbContext.Set<AcademicYear>()
            .SingleOrDefaultAsync(x => x.Id == EditAcademicYear.Id);
        if (year is null)
        {
            return NotFound();
        }

        await using var transaction = await dbContext.Database.BeginTransactionAsync();
        dbContext.Entry(year).Property(x => x.Version).OriginalValue =
            EditAcademicYear.Version;
        year.StartDate = EditAcademicYear.StartDate;
        year.EndDate = EditAcademicYear.EndDate;
        if (year.EndDate < DateOnly.FromDateTime(DateTime.Today))
        {
            year.Status = AcademicYearStatus.Closed;
            year.IsCurrent = false;
        }
        else
        {
            await CloseOtherAcademicYearsAsync(year.Id);
            year.Status = AcademicYearStatus.Open;
            year.IsCurrent = true;
        }

        try
        {
            await dbContext.SaveChangesAsync();
            await transaction.CommitAsync();
            StatusMessage = "Academic year dates updated.";
            return RedirectToPage();
        }
        catch (DbUpdateConcurrencyException)
        {
            await transaction.RollbackAsync();
            ModelState.AddModelError(
                string.Empty,
                "This academic year changed in another window. Refresh and try again.");
            await LoadAsync();
            return Page();
        }
    }

    private bool ValidateAcademicYearDates(
        AcademicYearInput input,
        string prefix)
    {
        var yearMinimum = new DateOnly(DateTime.Today.Year, 1, 1);
        if (input.StartDate < yearMinimum)
        {
            ModelState.AddModelError(
                $"{prefix}.{nameof(input.StartDate)}",
                "The start date cannot be before 1 January of the current year.");
        }

        if (input.EndDate <= input.StartDate)
        {
            ModelState.AddModelError(
                $"{prefix}.{nameof(input.EndDate)}",
                "The end date must be after the start date.");
        }

        return ModelState.IsValid;
    }

    private async Task CloseOtherAcademicYearsAsync(Guid? exceptId = null)
    {
        var openYears = await dbContext.Set<AcademicYear>()
            .Where(x => x.Status == AcademicYearStatus.Open
                && (!exceptId.HasValue || x.Id != exceptId.Value))
            .ToListAsync();
        foreach (var openYear in openYears)
        {
            openYear.Status = AcademicYearStatus.Closed;
            openYear.IsCurrent = false;
        }
    }
    public async Task<IActionResult> OnPostCreateClassAsync()
    {
        ModelState.Clear();
        if (!TryValidateModel(ClassInput, nameof(ClassInput)))
        {
            await LoadAsync();
            return Page();
        }

        dbContext.Add(new SchoolClass
        {
            Name = ClassInput.Name.Trim(),
            Level = ClassInput.Level,
            Stream = Normalize(ClassInput.Stream),
            SortOrder = ClassInput.SortOrder,
        });

        return await SaveAndRedirectAsync("Class created.");
    }

    public async Task<IActionResult> OnPostCreateSectionAsync()
    {
        ModelState.Clear();
        if (!TryValidateModel(NewSection, nameof(NewSection)))
        {
            await LoadAsync();
            return Page();
        }

        var year = await GetActiveAcademicYearAsync();
        var schoolClass = await dbContext.Set<SchoolClass>()
            .SingleOrDefaultAsync(x => x.Id == NewSection.ClassId && x.IsActive);
        if (year is null || schoolClass is null)
        {
            ModelState.AddModelError(string.Empty, "Choose a valid year and active class.");
            await LoadAsync();
            return Page();
        }

        if (year.Status == AcademicYearStatus.Closed)
        {
            ModelState.AddModelError(string.Empty, "Sections cannot be added to a closed year.");
            await LoadAsync();
            return Page();
        }

        if (NewSection.ClassTeacherUserId.HasValue
            && !await IsActiveTeacherAsync(NewSection.ClassTeacherUserId.Value))
        {
            ModelState.AddModelError(
                $"{nameof(NewSection)}.{nameof(NewSection.ClassTeacherUserId)}",
                "Choose an active teacher.");
            await LoadAsync();
            return Page();
        }

        dbContext.Add(new Section
        {
            AcademicYearId = year.Id,
            ClassId = schoolClass.Id,
            Name = NewSection.Name.Trim(),
            Capacity = NewSection.Capacity,
            ClassTeacherUserId = NewSection.ClassTeacherUserId,
        });

        return await SaveAndRedirectAsync("Section created.");
    }

    public async Task<IActionResult> OnPostSaveSubjectTeacherAsync()
    {
        ModelState.Clear();
        if (!TryValidateModel(
                NewSubjectTeacherAssignment,
                nameof(NewSubjectTeacherAssignment)))
        {
            await LoadAsync();
            return Page();
        }

        var activeYear = await GetActiveAcademicYearAsync();
        var classIds = NewSubjectTeacherAssignment.ClassIds.Distinct().ToArray();
        var sectionIds = NewSubjectTeacherAssignment.SectionIds.Distinct().ToArray();
        var classes = await dbContext.Set<SchoolClass>()
            .Where(x => classIds.Contains(x.Id) && x.IsActive)
            .OrderBy(x => x.SortOrder)
            .ToListAsync();
        var sections = activeYear is null
            ? []
            : await dbContext.Set<Section>()
                .Where(x => sectionIds.Contains(x.Id)
                    && x.AcademicYearId == activeYear.Id
                    && x.IsActive)
                .ToListAsync();
        if (activeYear is null
            || classes.Count != classIds.Length
            || sections.Count != sectionIds.Length
            || classes.Any(schoolClass =>
                sections.All(section => section.ClassId != schoolClass.Id)))
        {
            ModelState.AddModelError(
                string.Empty,
                "Choose at least one active section for every selected class.");
            await LoadAsync();
            return Page();
        }

        if (!await IsActiveTeacherAsync(NewSubjectTeacherAssignment.TeacherUserId))
        {
            ModelState.AddModelError(
                $"{nameof(NewSubjectTeacherAssignment)}.{nameof(NewSubjectTeacherAssignment.TeacherUserId)}",
                "Choose an active teacher.");
            await LoadAsync();
            return Page();
        }

        await using var transaction = await dbContext.Database.BeginTransactionAsync();
        try
        {
            var subjectName = NewSubjectTeacherAssignment.SubjectName.Trim();
            var existingSubjects = await dbContext.Set<Subject>()
                .Where(x => classIds.Contains(x.ClassId))
                .ToListAsync();
            var subjectsByClass = new Dictionary<Guid, Subject>();
            foreach (var schoolClass in classes)
            {
                var subject = existingSubjects.FirstOrDefault(x =>
                    x.ClassId == schoolClass.Id
                    && string.Equals(
                        x.Name,
                        subjectName,
                        StringComparison.OrdinalIgnoreCase));
                if (subject is null)
                {
                    subject = new Subject
                    {
                        ClassId = schoolClass.Id,
                        Name = subjectName,
                        Code = await GenerateSubjectCodeAsync(
                            schoolClass.Id,
                            subjectName),
                        Kind = SubjectKind.Core,
                        Component = SubjectComponent.Theory,
                        MaximumMarks = 100,
                    };
                    dbContext.Add(subject);
                }
                else
                {
                    subject.IsActive = true;
                }

                subjectsByClass[schoolClass.Id] = subject;
            }

            var selectedSubjectIds = subjectsByClass.Values
                .Select(x => x.Id)
                .ToArray();
            var existingAssignments = await dbContext.Set<TeacherAssignment>()
                .Where(x => sectionIds.Contains(x.SectionId)
                    && selectedSubjectIds.Contains(x.SubjectId))
                .ToListAsync();
            foreach (var section in sections)
            {
                var subject = subjectsByClass[section.ClassId];
                var assignment = existingAssignments.FirstOrDefault(x =>
                    x.SectionId == section.Id && x.SubjectId == subject.Id);
                if (assignment is null)
                {
                    dbContext.Add(new TeacherAssignment
                    {
                        AcademicYearId = activeYear.Id,
                        ClassId = section.ClassId,
                        SectionId = section.Id,
                        SubjectId = subject.Id,
                        TeacherUserId = NewSubjectTeacherAssignment.TeacherUserId,
                    });
                }
                else
                {
                    assignment.TeacherUserId =
                        NewSubjectTeacherAssignment.TeacherUserId;
                }
            }

            await dbContext.SaveChangesAsync();
            await transaction.CommitAsync();
            StatusMessage = "Subject and teacher assignment saved.";
            return RedirectToPage();
        }
        catch (DbUpdateException)
        {
            await transaction.RollbackAsync();
            dbContext.ChangeTracker.Clear();
            ModelState.AddModelError(
                string.Empty,
                "The selected subject assignment conflicts with an existing record.");
            await LoadAsync();
            return Page();
        }
    }
    public async Task<IActionResult> OnPostCreateSubjectAsync()
    {
        ModelState.Clear();
        if (!TryValidateModel(NewSubject, nameof(NewSubject)))
        {
            await LoadAsync();
            return Page();
        }

        var classExists = await dbContext.Set<SchoolClass>()
            .AnyAsync(x => x.Id == NewSubject.ClassId && x.IsActive);
        if (!classExists)
        {
            ModelState.AddModelError(string.Empty, "Choose an active class.");
            await LoadAsync();
            return Page();
        }

        dbContext.Add(new Subject
        {
            ClassId = NewSubject.ClassId,
            Name = NewSubject.Name.Trim(),
            Code = await GenerateSubjectCodeAsync(NewSubject.ClassId, NewSubject.Name),
            Kind = SubjectKind.Core,
            Component = SubjectComponent.Theory,
            MaximumMarks = 100,
        });

        return await SaveAndRedirectAsync("Subject created.");
    }

    public async Task<IActionResult> OnPostAssignTeacherAsync()
    {
        ModelState.Clear();
        if (!TryValidateModel(
            NewTeacherAssignment,
            nameof(NewTeacherAssignment)))
        {
            await LoadAsync();
            return Page();
        }
        var activeYear = await GetActiveAcademicYearAsync();

        var section = await dbContext.Set<Section>()
            .Include(x => x.AcademicYear)
            .SingleOrDefaultAsync(x => x.Id == NewTeacherAssignment.SectionId);
        var subject = await dbContext.Set<Subject>()
            .SingleOrDefaultAsync(x => x.Id == NewTeacherAssignment.SubjectId);
        if (activeYear is null
            || section is null
            || subject is null
            || section.AcademicYearId != activeYear.Id
            || section.ClassId != subject.ClassId)
        {
            ModelState.AddModelError(
                string.Empty,
                "Choose a section and subject from the same class and academic year.");
            await LoadAsync();
            return Page();
        }

        if (section.AcademicYear.Status == AcademicYearStatus.Closed)
        {
            ModelState.AddModelError(
                string.Empty,
                "Teachers cannot be assigned in a closed academic year.");
            await LoadAsync();
            return Page();
        }

        if (!await IsActiveTeacherAsync(NewTeacherAssignment.TeacherUserId))
        {
            ModelState.AddModelError(
                $"{nameof(NewTeacherAssignment)}.{nameof(NewTeacherAssignment.TeacherUserId)}",
                "Choose an active teacher.");
            await LoadAsync();
            return Page();
        }

        dbContext.Add(new TeacherAssignment
        {
            AcademicYearId = section.AcademicYearId,
            ClassId = section.ClassId,
            SectionId = section.Id,
            SubjectId = subject.Id,
            TeacherUserId = NewTeacherAssignment.TeacherUserId,
        });
        return await SaveAndRedirectAsync("Subject teacher assigned.");
    }


    private async Task<string> GenerateSubjectCodeAsync(Guid classId, string name)
    {
        var compact = new string(name
            .Where(char.IsLetterOrDigit)
            .Select(char.ToUpperInvariant)
            .ToArray());
        var stem = string.IsNullOrWhiteSpace(compact) ? "SUBJECT" : compact;
        stem = stem[..Math.Min(stem.Length, 24)];
        var code = stem;
        var suffix = 2;
        while (await dbContext.Set<Subject>()
            .AnyAsync(x => x.ClassId == classId && x.Code == code))
        {
            var ending = $"-{suffix++}";
            code = $"{stem[..Math.Min(stem.Length, 30 - ending.Length)]}{ending}";
        }

        return code;
    }

    private async Task<AcademicYear?> GetActiveAcademicYearAsync()
    {
        var today = DateOnly.FromDateTime(DateTime.Today);
        var expired = await dbContext.Set<AcademicYear>()
            .Where(x => x.Status == AcademicYearStatus.Open && x.EndDate < today)
            .ToListAsync();
        foreach (var year in expired)
        {
            year.Status = AcademicYearStatus.Closed;
            year.IsCurrent = false;
        }

        if (expired.Count > 0)
        {
            await dbContext.SaveChangesAsync();
        }

        return await dbContext.Set<AcademicYear>()
            .Where(x => x.Status == AcademicYearStatus.Open && x.EndDate >= today)
            .OrderByDescending(x => x.IsCurrent)
            .ThenByDescending(x => x.StartDate)
            .FirstOrDefaultAsync();
    }
    private async Task<bool> IsActiveTeacherAsync(Guid userId)
    {
        var teacher = await userManager.FindByIdAsync(userId.ToString());
        return teacher is not null
            && teacher.IsActive
            && await userManager.IsInRoleAsync(teacher, RoleCatalog.Teacher);
    }

    public async Task<IActionResult> OnPostBulkSetupClassesAsync()
    {
        ModelState.Clear();
        if (!TryValidateModel(BulkClassSetup, nameof(BulkClassSetup)))
        {
            await LoadAsync();
            return Page();
        }

        var year = await GetActiveAcademicYearAsync();
        var fromIndex = PresetClasses.ToList().FindIndex(x =>
            x.Key == BulkClassSetup.FromClassKey);
        var toIndex = PresetClasses.ToList().FindIndex(x =>
            x.Key == BulkClassSetup.ToClassKey);
        if (year is null
            || year.Status == AcademicYearStatus.Closed
            || fromIndex < 0
            || toIndex < fromIndex)
        {
            ModelState.AddModelError(
                string.Empty,
                "Create an active academic year first, then choose a valid class range.");
            await LoadAsync();
            return Page();
        }

        await using var transaction = await dbContext.Database.BeginTransactionAsync();
        try
        {
            var existingClasses = await dbContext.Set<SchoolClass>()
                .Where(x => x.Stream == null)
                .ToListAsync();
            var selected = PresetClasses.Skip(fromIndex).Take(toIndex - fromIndex + 1);
            var configured = 0;
            foreach (var preset in selected)
            {
                var schoolClass = existingClasses.FirstOrDefault(x =>
                    x.Name == preset.Name);
                if (schoolClass is null)
                {
                    schoolClass = new SchoolClass
                    {
                        Name = preset.Name,
                        Level = preset.Level,
                        SortOrder = preset.SortOrder,
                    };
                    dbContext.Add(schoolClass);
                    existingClasses.Add(schoolClass);
                }
                else
                {
                    schoolClass.IsActive = true;
                    schoolClass.Level = preset.Level;
                    schoolClass.SortOrder = preset.SortOrder;
                }

                await dbContext.SaveChangesAsync();
                var existingSectionNames = await dbContext.Set<Section>()
                    .Where(x =>
                        x.AcademicYearId == year.Id
                        && x.ClassId == schoolClass.Id)
                    .Select(x => x.Name)
                    .ToListAsync();
                for (var index = 0; index < BulkClassSetup.SectionCount; index++)
                {
                    var sectionName = ((char)('A' + index)).ToString();
                    if (existingSectionNames.Contains(
                        sectionName,
                        StringComparer.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    dbContext.Add(new Section
                    {
                        AcademicYearId = year.Id,
                        ClassId = schoolClass.Id,
                        Name = sectionName,
                        Capacity = BulkClassSetup.SectionCapacity,
                    });
                    configured++;
                }
            }

            await dbContext.SaveChangesAsync();
            await transaction.CommitAsync();
            StatusMessage = $"Class range configured with {configured} new sections.";
            return RedirectToPage();
        }
        catch (DbUpdateException)
        {
            await transaction.RollbackAsync();
            ModelState.AddModelError(
                string.Empty,
                "The class range conflicts with existing academic records.");
            await LoadAsync();
            return Page();
        }
    }

    public async Task<IActionResult> OnPostSetSectionCountAsync()
    {
        ModelState.Clear();
        if (!TryValidateModel(SectionCount, nameof(SectionCount)))
        {
            await LoadAsync();
            return Page();
        }

        var year = await GetActiveAcademicYearAsync();
        var schoolClass = await dbContext.Set<SchoolClass>()
            .SingleOrDefaultAsync(x =>
                x.Id == SectionCount.ClassId
                && x.IsActive);
        if (year is null
            || year.Status == AcademicYearStatus.Closed
            || schoolClass is null)
        {
            ModelState.AddModelError(
                string.Empty,
                "Create an active academic year first and choose an active class.");
            await LoadAsync();
            return Page();
        }

        var sections = await dbContext.Set<Section>()
            .Where(x =>
                x.AcademicYearId == year.Id
                && x.ClassId == schoolClass.Id)
            .OrderBy(x => x.Name)
            .ToListAsync();
        for (var index = 0; index < SectionCount.DesiredCount; index++)
        {
            var name = ((char)('A' + index)).ToString();
            var section = sections.FirstOrDefault(x =>
                string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase));
            if (section is null)
            {
                dbContext.Add(new Section
                {
                    AcademicYearId = year.Id,
                    ClassId = schoolClass.Id,
                    Name = name,
                    Capacity = SectionCount.Capacity,
                });
            }
            else
            {
                section.IsActive = true;
                section.Capacity = SectionCount.Capacity;
            }
        }

        var retainedNames = Enumerable.Range(0, SectionCount.DesiredCount)
            .Select(index => ((char)('A' + index)).ToString())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var section in sections.Where(x => !retainedNames.Contains(x.Name)))
        {
            await RemoveSectionFromActiveSetupAsync(section);
        }

        return await SaveAndRedirectAsync(
            $"{schoolClass.Name} now has {SectionCount.DesiredCount} active sections.");
    }

    public async Task<IActionResult> OnPostRemoveClassAsync(Guid id)
    {
        var schoolClass = await dbContext.Set<SchoolClass>()
            .SingleOrDefaultAsync(x => x.Id == id && x.IsActive);
        if (schoolClass is null)
        {
            return NotFound();
        }

        var activeYear = await GetActiveAcademicYearAsync();
        if (activeYear is not null)
        {
            var sections = await dbContext.Set<Section>()
                .Where(x => x.AcademicYearId == activeYear.Id && x.ClassId == id)
                .ToListAsync();
            foreach (var section in sections)
            {
                await RemoveSectionFromActiveSetupAsync(section);
            }
        }

        schoolClass.IsActive = false;
        var subjects = await dbContext.Set<Subject>()
            .Where(x => x.ClassId == id && x.IsActive)
            .ToListAsync();
        foreach (var subject in subjects)
        {
            subject.IsActive = false;
        }

        return await SaveAndRedirectAsync(
            $"{schoolClass.Name} was removed from the active setup.");
    }

    private async Task RemoveSectionFromActiveSetupAsync(Section section)
    {
        var hasHistoricalRecords = await dbContext.Set<StudentEnrollment>()
                .AnyAsync(x => x.SectionId == section.Id)
            || await dbContext.Set<AttendanceSession>()
                .AnyAsync(x => x.SectionId == section.Id);

        var assignments = await dbContext.Set<TeacherAssignment>()
            .Where(x => x.SectionId == section.Id)
            .ToListAsync();
        dbContext.RemoveRange(assignments);
        if (hasHistoricalRecords)
        {
            section.IsActive = false;
        }
        else
        {
            dbContext.Remove(section);
        }
    }
    public async Task<IActionResult> OnPostUpdateSectionAsync()
    {
        ModelState.Clear();
        if (!TryValidateModel(EditSection, nameof(EditSection)))
        {
            await LoadAsync();
            return Page();
        }

        var section = await dbContext.Set<Section>()
            .Include(x => x.AcademicYear)
            .SingleOrDefaultAsync(x => x.Id == EditSection.Id);
        if (section is null)
        {
            return NotFound();
        }

        if (section.AcademicYear.Status == AcademicYearStatus.Closed)
        {
            ModelState.AddModelError(
                string.Empty,
                "Sections in a closed academic year cannot be edited.");
            await LoadAsync();
            return Page();
        }

        if (EditSection.ClassTeacherUserId.HasValue
            && !await IsActiveTeacherAsync(EditSection.ClassTeacherUserId.Value))
        {
            ModelState.AddModelError(
                string.Empty,
                "Choose an active teacher.");
            await LoadAsync();
            return Page();
        }

        dbContext.Entry(section).Property(x => x.Version).OriginalValue =
            EditSection.Version;
        section.Name = EditSection.Name.Trim().ToUpperInvariant();
        section.Capacity = EditSection.Capacity;
        section.ClassTeacherUserId = EditSection.ClassTeacherUserId;
        section.IsActive = EditSection.IsActive;
        return await SaveAndRedirectAsync("Section updated.");
    }

    public async Task<IActionResult> OnPostCreateBreakPeriodAsync()
    {
        ModelState.Clear();
        if (!TryValidateModel(NewBreakPeriod, nameof(NewBreakPeriod)))
        {
            await LoadAsync();
            return Page();
        }

        if (!await ValidateBreakPeriodAsync(NewBreakPeriod))
        {
            await LoadAsync();
            return Page();
        }

        dbContext.Add(new AcademicBreakPeriod
        {
            Name = NewBreakPeriod.Name.Trim(),
            Scope = NewBreakPeriod.Scope,
            FromClassId = NewBreakPeriod.Scope == AcademicBreakScope.ClassRange
                ? NewBreakPeriod.FromClassId
                : null,
            ToClassId = NewBreakPeriod.Scope == AcademicBreakScope.ClassRange
                ? NewBreakPeriod.ToClassId
                : null,
            StartsAt = NewBreakPeriod.StartsAt,
            EndsAt = NewBreakPeriod.EndsAt,
        });
        return await SaveAndRedirectAsync("Break period created.");
    }

    public async Task<IActionResult> OnPostUpdateBreakPeriodAsync()
    {
        ModelState.Clear();
        if (!TryValidateModel(EditBreakPeriod, nameof(EditBreakPeriod))
            || !await ValidateBreakPeriodAsync(EditBreakPeriod))
        {
            await LoadAsync();
            return Page();
        }

        var breakPeriod = await dbContext.Set<AcademicBreakPeriod>()
            .SingleOrDefaultAsync(x => x.Id == EditBreakPeriod.Id);
        if (breakPeriod is null)
        {
            return NotFound();
        }

        dbContext.Entry(breakPeriod).Property(x => x.Version).OriginalValue =
            EditBreakPeriod.Version;
        breakPeriod.Name = EditBreakPeriod.Name.Trim();
        breakPeriod.Scope = EditBreakPeriod.Scope;
        breakPeriod.FromClassId =
            EditBreakPeriod.Scope == AcademicBreakScope.ClassRange
                ? EditBreakPeriod.FromClassId
                : null;
        breakPeriod.ToClassId =
            EditBreakPeriod.Scope == AcademicBreakScope.ClassRange
                ? EditBreakPeriod.ToClassId
                : null;
        breakPeriod.StartsAt = EditBreakPeriod.StartsAt;
        breakPeriod.EndsAt = EditBreakPeriod.EndsAt;
        breakPeriod.IsActive = EditBreakPeriod.IsActive;
        return await SaveAndRedirectAsync("Break period updated.");
    }

    private async Task<bool> ValidateBreakPeriodAsync(BreakPeriodInput input)
    {
        if (input.EndsAt <= input.StartsAt)
        {
            ModelState.AddModelError(
                string.Empty,
                "The break end time must be after its start time.");
            return false;
        }

        if (input.Scope == AcademicBreakScope.AllClasses)
        {
            return true;
        }

        if (!input.FromClassId.HasValue || !input.ToClassId.HasValue)
        {
            ModelState.AddModelError(
                string.Empty,
                "Choose the first and last class for a class-range break.");
            return false;
        }

        var range = await dbContext.Set<SchoolClass>()
            .Where(x =>
                x.Id == input.FromClassId.Value
                || x.Id == input.ToClassId.Value)
            .Select(x => new { x.Id, x.SortOrder, x.IsActive })
            .ToListAsync();
        var from = range.SingleOrDefault(x => x.Id == input.FromClassId.Value);
        var to = range.SingleOrDefault(x => x.Id == input.ToClassId.Value);
        if (from is null || to is null || !from.IsActive || !to.IsActive
            || from.SortOrder > to.SortOrder)
        {
            ModelState.AddModelError(
                string.Empty,
                "Choose an active class range in display order.");
            return false;
        }

        return true;
    }

    private async Task<IActionResult> SaveAndRedirectAsync(string message)
    {
        try
        {
            await dbContext.SaveChangesAsync();
            StatusMessage = message;
            return RedirectToPage();
        }
        catch (DbUpdateException)
        {
            ModelState.AddModelError(
                string.Empty,
                "That record conflicts with an existing academic record.");
            await LoadAsync();
            return Page();
        }
    }

    private async Task LoadAsync()
    {
        ActiveAcademicYear = await GetActiveAcademicYearAsync();
        AcademicYears = await dbContext.Set<AcademicYear>()
            .AsNoTracking()
            .OrderByDescending(x => x.StartDate)
            .ToListAsync();
        Classes = await dbContext.Set<SchoolClass>()
            .AsNoTracking()
            .OrderBy(x => x.SortOrder)
            .ThenBy(x => x.Name)
            .ToListAsync();
        Sections = ActiveAcademicYear is null
            ? []
            : await dbContext.Set<Section>()
                .AsNoTracking()
                .Include(x => x.AcademicYear)
                .Include(x => x.Class)
                .Where(x => x.AcademicYearId == ActiveAcademicYear.Id)
                .OrderBy(x => x.Class.SortOrder)
                .ThenBy(x => x.Name)
                .ToListAsync();
        Subjects = await dbContext.Set<Subject>()
            .AsNoTracking()
            .Include(x => x.Class)
            .Where(x => x.IsActive && x.Class.IsActive)
            .OrderBy(x => x.Class.SortOrder)
            .ThenBy(x => x.Name)
            .ToListAsync();
        BreakPeriods = await dbContext.Set<AcademicBreakPeriod>()
            .AsNoTracking()
            .Include(x => x.FromClass)
            .Include(x => x.ToClass)
            .OrderBy(x => x.StartsAt)
            .ThenBy(x => x.Name)
            .ToListAsync();
        Teachers = (await userManager.GetUsersInRoleAsync(RoleCatalog.Teacher))
            .Where(x => x.IsActive)
            .OrderBy(x => x.DisplayName)
            .ThenBy(x => x.UserName)
            .ToArray();
        var linkedStaff = await dbContext.Set<StaffMember>()
            .AsNoTracking()
            .Where(x => x.IsActive && x.PortalUserId.HasValue)
            .ToListAsync();
        StaffNamesByUserId = linkedStaff.ToDictionary(
            x => x.PortalUserId!.Value,
            x => x.FullName);
        TeacherNames = Teachers.ToDictionary(
            x => x.Id,
            x => StaffNamesByUserId.GetValueOrDefault(
                x.Id,
                string.IsNullOrWhiteSpace(x.DisplayName)
                    ? x.UserName ?? "Teacher"
                    : x.DisplayName));
        var assignments = ActiveAcademicYear is null
            ? []
            : await dbContext.Set<TeacherAssignment>()
                .AsNoTracking()
                .Include(x => x.AcademicYear)
                .Include(x => x.Class)
                .Include(x => x.Section)
                .Include(x => x.Subject)
                .Where(x => x.AcademicYearId == ActiveAcademicYear.Id)
                .OrderBy(x => x.Class.SortOrder)
                .ThenBy(x => x.Section.Name)
                .ThenBy(x => x.Subject.Name)
                .ToListAsync();
        SubjectTeacherAssignments = assignments
            .GroupBy(x => new { x.TeacherUserId, Subject = x.Subject.Name })
            .Select(group => new SubjectTeacherSummary(
                group.Key.TeacherUserId,
                TeacherNames.GetValueOrDefault(
                    group.Key.TeacherUserId,
                    "Inactive teacher"),
                group.Key.Subject,
                string.Join(
                    ", ",
                    group.Select(x => new { x.Class.Name, x.Class.SortOrder })
                        .Distinct()
                        .OrderBy(x => x.SortOrder)
                        .ThenBy(x => x.Name)
                        .Select(x => x.Name))))
            .OrderBy(x => x.Teacher)
            .ThenBy(x => x.Subject)
            .ToArray();
    }
    private static string? Normalize(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    public sealed record PresetClassOption(
        string Key,
        string Name,
        int Level,
        int SortOrder);

    public sealed class BulkClassSetupInput
    {

        [Required]
        [Display(Name = "From class")]
        public string FromClassKey { get; set; } = "nursery";

        [Required]
        [Display(Name = "To class")]
        public string ToClassKey { get; set; } = "class-12";

        [Range(1, 26)]
        [Display(Name = "Sections per class")]
        public int SectionCount { get; set; } = 3;

        [Range(1, 500)]
        [Display(Name = "Capacity per section")]
        public int SectionCapacity { get; set; } = 40;
    }

    public sealed class SectionCountInput
    {

        [Required]
        public Guid ClassId { get; set; }

        [Range(1, 26)]
        [Display(Name = "Number of sections")]
        public int DesiredCount { get; set; } = 3;

        [Range(1, 500)]
        [Display(Name = "Capacity per section")]
        public int Capacity { get; set; } = 40;
    }

    public sealed class EditSectionInput
    {
        [Required]
        public Guid Id { get; set; }

        [Required, StringLength(50)]
        [Display(Name = "Section name")]
        public string Name { get; set; } = string.Empty;

        [Range(1, 500)]
        public int Capacity { get; set; }

        [Display(Name = "Class teacher")]
        public Guid? ClassTeacherUserId { get; set; }

        [Display(Name = "Active")]
        public bool IsActive { get; set; } = true;

        public uint Version { get; set; }
    }

    public class BreakPeriodInput
    {
        [Required, StringLength(100)]
        public string Name { get; set; } = string.Empty;

        public AcademicBreakScope Scope { get; set; } =
            AcademicBreakScope.AllClasses;

        [Display(Name = "From class")]
        public Guid? FromClassId { get; set; }

        [Display(Name = "To class")]
        public Guid? ToClassId { get; set; }

        [Required, DataType(DataType.Time)]
        [Display(Name = "Starts at")]
        public TimeOnly StartsAt { get; set; } = new(12, 0);

        [Required, DataType(DataType.Time)]
        [Display(Name = "Ends at")]
        public TimeOnly EndsAt { get; set; } = new(12, 30);
    }

    public sealed class EditBreakPeriodInput : BreakPeriodInput
    {
        [Required]
        public Guid Id { get; set; }

        public bool IsActive { get; set; } = true;

        public uint Version { get; set; }
    }

    public class AcademicYearInput
    {
        [Required]
        [RegularExpression(
            @"^\d{4}-\d{2}$",
            ErrorMessage = "Use the format 2026-27.")]
        public string Name { get; set; } = string.Empty;

        [Required, DataType(DataType.Date)]
        [Display(Name = "Start date")]
        public DateOnly StartDate { get; set; } =
            new(DateTime.Today.Year, 1, 1);

        [Required, DataType(DataType.Date)]
        [Display(Name = "End date")]
        public DateOnly EndDate { get; set; } =
            new(DateTime.Today.Year, 12, 31);
    }

    public sealed class EditAcademicYearInput : AcademicYearInput
    {
        [Required]
        public Guid Id { get; set; }

        public uint Version { get; set; }
    }

    public sealed class SchoolClassInput
    {
        [Required, StringLength(100)]
        public string Name { get; set; } = string.Empty;

        [Range(0, 20)]
        public int? Level { get; set; }

        [StringLength(100)]
        public string? Stream { get; set; }

        [Range(0, 1000)]
        [Display(Name = "Display order")]
        public int SortOrder { get; set; }
    }

    public sealed class SectionInput
    {

        [Required]
        [Display(Name = "Class")]
        public Guid ClassId { get; set; }

        [Required, StringLength(50)]
        public string Name { get; set; } = string.Empty;

        [Range(1, 500)]
        public int Capacity { get; set; } = 40;

        [Display(Name = "Class teacher")]
        public Guid? ClassTeacherUserId { get; set; }
    }

    public sealed class SubjectTeacherAssignmentInput
    {
        [Required, StringLength(150)]
        [Display(Name = "Subject")]
        public string SubjectName { get; set; } = string.Empty;

        [Required]
        [Display(Name = "Teacher")]
        public Guid TeacherUserId { get; set; }

        [MinLength(1, ErrorMessage = "Choose at least one class.")]
        public List<Guid> ClassIds { get; set; } = [];

        [MinLength(1, ErrorMessage = "Choose at least one section.")]
        public List<Guid> SectionIds { get; set; } = [];
    }

    public sealed record SubjectTeacherSummary(
        Guid TeacherUserId,
        string Teacher,
        string Subject,
        string Classes);
    public sealed class TeacherAssignmentInput
    {

        [Required]
        [Display(Name = "Section")]
        public Guid SectionId { get; set; }

        [Required]
        [Display(Name = "Subject")]
        public Guid SubjectId { get; set; }

        [Required]
        [Display(Name = "Teacher")]
        public Guid TeacherUserId { get; set; }
    }

    public sealed record TeacherAssignmentRow(
        Guid Id,
        string AcademicYear,
        string Class,
        string Section,
        string Subject,
        string Teacher);

    public sealed class SubjectInput
    {
        [Required]
        [Display(Name = "Class")]
        public Guid ClassId { get; set; }

        [Required, StringLength(150)]
        public string Name { get; set; } = string.Empty;
    }
}
