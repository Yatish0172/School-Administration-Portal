using System.ComponentModel.DataAnnotations;
using System.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Academics;
using SchoolPortal.Domain.Students;
using SchoolPortal.Infrastructure.Persistence;
using SchoolPortal.Web.Administration;

namespace SchoolPortal.Web.Pages.Students;

[Authorize(
    Policy = PermissionCatalog.PolicyPrefix + PermissionCatalog.Students.Create)]
public sealed class CreateModel(
    SchoolPortalDbContext dbContext,
    AuditWriter auditWriter) : PageModel
{
    public IReadOnlyList<AcademicYear> AcademicYears { get; private set; } = [];

    public IReadOnlyList<SchoolClass> Classes { get; private set; } = [];

    public IReadOnlyList<Section> Sections { get; private set; } = [];

    [BindProperty]
    public StudentInput Input { get; set; } = new();

    [BindProperty]
    public List<GuardianInput> Guardians { get; set; } = [];

    [BindProperty]
    public EnrollmentInput Enrollment { get; set; } = new();

    public async Task<IActionResult> OnGetAsync()
    {
        var initialYear = await dbContext.Set<AcademicYear>()
            .AsNoTracking()
            .Where(x => x.Status == AcademicYearStatus.Open)
            .OrderByDescending(x => x.IsCurrent)
            .ThenByDescending(x => x.StartDate)
            .FirstOrDefaultAsync();
        if (initialYear is null)
        {
            TempData["StatusMessage"] =
                "Create an open academic year before admitting students.";
            return RedirectToPage("/Academics/Index");
        }

        Input.AdmissionDate = DateOnly.FromDateTime(DateTime.Today);
        Enrollment.AcademicYearId = initialYear.Id;
        Guardians =
        [
            new GuardianInput { Relation = "Father", IsPrimary = true },
            new GuardianInput { Relation = "Mother" },
        ];
        await LoadLookupsAsync();
        return Page();
    }

    public async Task<IActionResult> OnPostAsync()
    {
        NormalizeGuardians();
        ValidateGuardians();

        if (Input.DateOfBirth > DateOnly.FromDateTime(DateTime.Today))
        {
            ModelState.AddModelError(
                $"{nameof(Input)}.{nameof(Input.DateOfBirth)}",
                "Date of birth cannot be in the future.");
        }

        if (!ModelState.IsValid)
        {
            await LoadLookupsAsync();
            return Page();
        }

        var year = await dbContext.Set<AcademicYear>()
            .SingleOrDefaultAsync(x =>
                x.Id == Enrollment.AcademicYearId
                && x.Status == AcademicYearStatus.Open);
        var section = await dbContext.Set<Section>()
            .Include(x => x.Class)
            .SingleOrDefaultAsync(x =>
                x.Id == Enrollment.SectionId
                && x.AcademicYearId == Enrollment.AcademicYearId
                && x.ClassId == Enrollment.ClassId
                && x.IsActive);
        if (year is null || section is null)
        {
            ModelState.AddModelError(
                string.Empty,
                "Choose an open academic year and a matching active class and section.");
            await LoadLookupsAsync();
            return Page();
        }

        await using var transaction = await dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable);
        var lockKey = section.Id.ToString("N");
        await dbContext.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({lockKey}, 0))");

        var enrolledCount = await dbContext.Set<StudentEnrollment>()
            .CountAsync(x =>
                x.SectionId == section.Id
                && x.Status == EnrollmentStatus.Active);
        if (enrolledCount >= section.Capacity)
        {
            await transaction.RollbackAsync();
            ModelState.AddModelError(
                nameof(Enrollment.SectionId),
                $"{section.Class.Name} {section.Name} is already at its capacity of {section.Capacity}.");
            await LoadLookupsAsync();
            return Page();
        }

        var rollNumber = Enrollment.RollNumber
            ?? (await dbContext.Set<StudentEnrollment>()
                .Where(x => x.SectionId == section.Id)
                .MaxAsync(x => (int?)x.RollNumber) ?? 0) + 1;
        var admissionNumber = await ResolveAdmissionNumberAsync(year);

        var student = new Student
        {
            AdmissionNumber = admissionNumber,
            FirstName = Input.FirstName.Trim(),
            MiddleName = Normalize(Input.MiddleName),
            LastName = Input.LastName.Trim(),
            DateOfBirth = Input.DateOfBirth,
            Gender = Normalize(Input.Gender),
            BloodGroup = Normalize(Input.BloodGroup),
            Category = Normalize(Input.Category),
            Religion = Normalize(Input.Religion),
            MotherTongue = Normalize(Input.MotherTongue),
            Nationality = Normalize(Input.Nationality) ?? "Indian",
            AadhaarNumber = Normalize(Input.AadhaarNumber),
            AdmissionDate = Input.AdmissionDate,
            PreviousSchool = Normalize(Input.PreviousSchool),
            PermanentAddress = Normalize(Input.PermanentAddress),
            CorrespondenceAddress = Normalize(Input.CorrespondenceAddress),
            City = Normalize(Input.City),
            State = Normalize(Input.State),
            PinCode = Normalize(Input.PinCode),
            Remarks = Normalize(Input.Remarks),
        };

        foreach (var guardianInput in Guardians.Where(IsCompleteGuardian))
        {
            student.Guardians.Add(new Guardian
            {
                Relation = guardianInput.Relation.Trim(),
                Name = guardianInput.Name!.Trim(),
                Phone = guardianInput.Phone!.Trim(),
                Email = Normalize(guardianInput.Email),
                Occupation = Normalize(guardianInput.Occupation),
                AnnualIncome = guardianInput.AnnualIncome,
                IsPrimary = guardianInput.IsPrimary,
            });
        }

        student.Enrollments.Add(new StudentEnrollment
        {
            AcademicYearId = year.Id,
            ClassId = section.ClassId,
            SectionId = section.Id,
            RollNumber = rollNumber,
        });

        auditWriter.Add(
            "student.admitted",
            "Student",
            student.Id,
            before: null,
            after: new
            {
                student.AdmissionNumber,
                student.FirstName,
                student.LastName,
                AcademicYearId = year.Id,
                section.ClassId,
                SectionId = section.Id,
                RollNumber = rollNumber,
            });
        dbContext.Add(student);
        try
        {
            await dbContext.SaveChangesAsync();
            await transaction.CommitAsync();
        }
        catch (DbUpdateException)
        {
            await transaction.RollbackAsync();
            ModelState.AddModelError(
                string.Empty,
                "The admission number or roll number is already in use.");
            await LoadLookupsAsync();
            return Page();
        }

        TempData["StatusMessage"] = $"Student admitted as {student.AdmissionNumber}.";
        return RedirectToPage("/Students/Details", new { id = student.Id });
    }

    private async Task<string> ResolveAdmissionNumberAsync(AcademicYear year)
    {
        if (!string.IsNullOrWhiteSpace(Input.AdmissionNumber))
        {
            return Input.AdmissionNumber.Trim().ToUpperInvariant();
        }

        var nextValue = await dbContext.Database
            .SqlQueryRaw<long>(
                "SELECT nextval('portal.\"AdmissionNumberSequence\"') AS \"Value\"")
            .SingleAsync();
        var prefixYear = year.StartDate.Year;
        return $"ADM-{prefixYear}-{nextValue:00000}";
    }

    private void NormalizeGuardians()
    {
        if (Guardians.Count == 0)
        {
            Guardians.Add(new GuardianInput { Relation = "Guardian", IsPrimary = true });
        }

        if (Guardians.Any(IsCompleteGuardian) && !Guardians.Any(x => x.IsPrimary))
        {
            Guardians.First(IsCompleteGuardian).IsPrimary = true;
        }
    }

    private void ValidateGuardians()
    {
        var completeGuardians = Guardians.Where(IsCompleteGuardian).ToList();
        if (completeGuardians.Count == 0)
        {
            ModelState.AddModelError(
                nameof(Guardians),
                "Add at least one guardian with a name and phone number.");
        }

        for (var index = 0; index < Guardians.Count; index++)
        {
            var guardian = Guardians[index];
            var hasAnyValue = !string.IsNullOrWhiteSpace(guardian.Name)
                || !string.IsNullOrWhiteSpace(guardian.Phone);
            if (hasAnyValue && !IsCompleteGuardian(guardian))
            {
                ModelState.AddModelError(
                    $"{nameof(Guardians)}[{index}]",
                    "Each guardian needs both a name and phone number.");
            }
        }

        if (completeGuardians.Count(x => x.IsPrimary) > 1)
        {
            ModelState.AddModelError(
                nameof(Guardians),
                "Choose only one primary guardian.");
        }
    }

    private async Task LoadLookupsAsync()
    {
        AcademicYears = await dbContext.Set<AcademicYear>()
            .AsNoTracking()
            .Where(x => x.Status == AcademicYearStatus.Open)
            .OrderByDescending(x => x.StartDate)
            .ToListAsync();
        Classes = await dbContext.Set<SchoolClass>()
            .AsNoTracking()
            .Where(x => x.IsActive)
            .OrderBy(x => x.SortOrder)
            .ThenBy(x => x.Name)
            .ToListAsync();
        Sections = await dbContext.Set<Section>()
            .AsNoTracking()
            .Where(x => x.IsActive)
            .OrderBy(x => x.Name)
            .ToListAsync();
    }

    private static bool IsCompleteGuardian(GuardianInput input) =>
        !string.IsNullOrWhiteSpace(input.Name)
        && !string.IsNullOrWhiteSpace(input.Phone);

    private static string? Normalize(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    public sealed class StudentInput
    {
        [StringLength(50)]
        [Display(Name = "Admission number")]
        public string? AdmissionNumber { get; set; }

        [Required, StringLength(100)]
        [Display(Name = "First name")]
        public string FirstName { get; set; } = string.Empty;

        [StringLength(100)]
        [Display(Name = "Middle name")]
        public string? MiddleName { get; set; }

        [Required, StringLength(100)]
        [Display(Name = "Last name")]
        public string LastName { get; set; } = string.Empty;

        [DataType(DataType.Date)]
        [Display(Name = "Date of birth")]
        public DateOnly? DateOfBirth { get; set; }

        [StringLength(30)]
        public string? Gender { get; set; }

        [StringLength(10)]
        [Display(Name = "Blood group")]
        public string? BloodGroup { get; set; }

        [StringLength(50)]
        public string? Category { get; set; }

        [StringLength(80)]
        public string? Religion { get; set; }

        [StringLength(80)]
        [Display(Name = "Mother tongue")]
        public string? MotherTongue { get; set; }

        [StringLength(80)]
        public string? Nationality { get; set; } = "Indian";

        [RegularExpression(
            @"^$|^\d{12}$",
            ErrorMessage = "Aadhaar number must contain exactly 12 digits.")]
        [Display(Name = "Aadhaar number")]
        public string? AadhaarNumber { get; set; }

        [Required, DataType(DataType.Date)]
        [Display(Name = "Admission date")]
        public DateOnly AdmissionDate { get; set; }

        [StringLength(300)]
        [Display(Name = "Previous school")]
        public string? PreviousSchool { get; set; }

        [StringLength(1000)]
        [Display(Name = "Permanent address")]
        public string? PermanentAddress { get; set; }

        [StringLength(1000)]
        [Display(Name = "Correspondence address")]
        public string? CorrespondenceAddress { get; set; }

        [StringLength(100)]
        public string? City { get; set; }

        [StringLength(100)]
        public string? State { get; set; }

        [RegularExpression(@"^$|^\d{6}$", ErrorMessage = "PIN code must contain 6 digits.")]
        [Display(Name = "PIN code")]
        public string? PinCode { get; set; }

        [StringLength(2000)]
        public string? Remarks { get; set; }
    }

    public sealed class GuardianInput
    {
        [StringLength(50)]
        public string Relation { get; set; } = "Guardian";

        [StringLength(200)]
        public string? Name { get; set; }

        [StringLength(30)]
        public string? Phone { get; set; }

        [EmailAddress, StringLength(254)]
        public string? Email { get; set; }

        [StringLength(150)]
        public string? Occupation { get; set; }

        [Range(0, 1000000000)]
        [Display(Name = "Annual income")]
        public decimal? AnnualIncome { get; set; }

        [Display(Name = "Primary contact")]
        public bool IsPrimary { get; set; }
    }

    public sealed class EnrollmentInput
    {
        [Required]
        [Display(Name = "Academic year")]
        public Guid AcademicYearId { get; set; }

        [Required]
        [Display(Name = "Class")]
        public Guid ClassId { get; set; }

        [Required]
        [Display(Name = "Section")]
        public Guid SectionId { get; set; }

        [Range(1, 10000)]
        [Display(Name = "Roll number")]
        public int? RollNumber { get; set; }
    }
}
