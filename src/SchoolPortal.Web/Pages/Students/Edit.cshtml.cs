using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Students;
using SchoolPortal.Infrastructure.Persistence;
using SchoolPortal.Web.Administration;

namespace SchoolPortal.Web.Pages.Students;

[Authorize(
    Policy = PermissionCatalog.PolicyPrefix + PermissionCatalog.Students.Edit)]
public sealed class EditModel(
    SchoolPortalDbContext dbContext,
    AuditWriter auditWriter) : PageModel
{
    public Guid StudentId { get; private set; }

    public string StudentName { get; private set; } = string.Empty;

    [BindProperty]
    public CreateModel.StudentInput Input { get; set; } = new();

    [BindProperty]
    public List<CreateModel.GuardianInput> Guardians { get; set; } = [];

    [BindProperty]
    public uint Version { get; set; }

    public async Task<IActionResult> OnGetAsync(Guid id)
    {
        var student = await dbContext.Set<Student>()
            .AsNoTracking()
            .Include(x => x.Guardians)
            .SingleOrDefaultAsync(x => x.Id == id);
        if (student is null)
        {
            return NotFound();
        }

        MapStudent(student);
        return Page();
    }

    public async Task<IActionResult> OnPostAsync(Guid id)
    {
        ValidateGuardians();
        if (!ModelState.IsValid)
        {
            StudentId = id;
            StudentName = string.Join(
                ' ',
                new[] { Input.FirstName, Input.MiddleName, Input.LastName }
                    .Where(x => !string.IsNullOrWhiteSpace(x)));
            return Page();
        }

        var student = await dbContext.Set<Student>()
            .Include(x => x.Guardians)
            .SingleOrDefaultAsync(x => x.Id == id);
        if (student is null)
        {
            return NotFound();
        }

        dbContext.Entry(student).Property(x => x.Version).OriginalValue = Version;
        var before = new
        {
            student.AdmissionNumber,
            student.FirstName,
            student.MiddleName,
            student.LastName,
            student.Status,
        };
        student.AdmissionNumber = Input.AdmissionNumber?.Trim().ToUpperInvariant()
            ?? student.AdmissionNumber;
        student.FirstName = Input.FirstName.Trim();
        student.MiddleName = Normalize(Input.MiddleName);
        student.LastName = Input.LastName.Trim();
        student.DateOfBirth = Input.DateOfBirth;
        student.Gender = Normalize(Input.Gender);
        student.BloodGroup = Normalize(Input.BloodGroup);
        student.Category = Normalize(Input.Category);
        student.Religion = Normalize(Input.Religion);
        student.MotherTongue = Normalize(Input.MotherTongue);
        student.Nationality = Normalize(Input.Nationality) ?? "Indian";
        student.AadhaarNumber = Normalize(Input.AadhaarNumber);
        student.AdmissionDate = Input.AdmissionDate;
        student.PreviousSchool = Normalize(Input.PreviousSchool);
        student.PermanentAddress = Normalize(Input.PermanentAddress);
        student.CorrespondenceAddress = Normalize(Input.CorrespondenceAddress);
        student.City = Normalize(Input.City);
        student.State = Normalize(Input.State);
        student.PinCode = Normalize(Input.PinCode);
        student.Remarks = Normalize(Input.Remarks);
        student.UpdatedAtUtc = DateTimeOffset.UtcNow;

        dbContext.RemoveRange(student.Guardians);
        student.Guardians.Clear();
        foreach (var input in Guardians.Where(IsCompleteGuardian))
        {
            student.Guardians.Add(new Guardian
            {
                Relation = input.Relation.Trim(),
                Name = input.Name!.Trim(),
                Phone = input.Phone!.Trim(),
                Email = Normalize(input.Email),
                Occupation = Normalize(input.Occupation),
                AnnualIncome = input.AnnualIncome,
                IsPrimary = input.IsPrimary,
            });
        }

        auditWriter.Add(
            "student.profile-updated",
            "Student",
            student.Id,
            before,
            new
            {
                student.AdmissionNumber,
                student.FirstName,
                student.MiddleName,
                student.LastName,
                student.Status,
            });

        try
        {
            await dbContext.SaveChangesAsync();
            TempData["StatusMessage"] = "Student profile updated.";
            return RedirectToPage("/Students/Details", new { id });
        }
        catch (DbUpdateConcurrencyException)
        {
            ModelState.AddModelError(
                string.Empty,
                "This student was changed by another user. Reload and try again.");
            StudentId = id;
            StudentName = student.FullName;
            return Page();
        }
        catch (DbUpdateException)
        {
            ModelState.AddModelError(
                string.Empty,
                "The admission number conflicts with another student.");
            StudentId = id;
            StudentName = student.FullName;
            return Page();
        }
    }

    private void MapStudent(Student student)
    {
        StudentId = student.Id;
        StudentName = student.FullName;
        Version = student.Version;
        Input = new CreateModel.StudentInput
        {
            AdmissionNumber = student.AdmissionNumber,
            FirstName = student.FirstName,
            MiddleName = student.MiddleName,
            LastName = student.LastName,
            DateOfBirth = student.DateOfBirth,
            Gender = student.Gender,
            BloodGroup = student.BloodGroup,
            Category = student.Category,
            Religion = student.Religion,
            MotherTongue = student.MotherTongue,
            Nationality = student.Nationality,
            AadhaarNumber = student.AadhaarNumber,
            AdmissionDate = student.AdmissionDate,
            PreviousSchool = student.PreviousSchool,
            PermanentAddress = student.PermanentAddress,
            CorrespondenceAddress = student.CorrespondenceAddress,
            City = student.City,
            State = student.State,
            PinCode = student.PinCode,
            Remarks = student.Remarks,
        };
        Guardians = student.Guardians
            .OrderByDescending(x => x.IsPrimary)
            .Select(x => new CreateModel.GuardianInput
            {
                Relation = x.Relation,
                Name = x.Name,
                Phone = x.Phone,
                Email = x.Email,
                Occupation = x.Occupation,
                AnnualIncome = x.AnnualIncome,
                IsPrimary = x.IsPrimary,
            })
            .ToList();
        while (Guardians.Count < 2)
        {
            Guardians.Add(new CreateModel.GuardianInput());
        }
    }

    private void ValidateGuardians()
    {
        var complete = Guardians.Where(IsCompleteGuardian).ToList();
        if (complete.Count == 0)
        {
            ModelState.AddModelError(
                nameof(Guardians),
                "Add at least one guardian with a name and phone number.");
        }

        if (complete.Count(x => x.IsPrimary) > 1)
        {
            ModelState.AddModelError(
                nameof(Guardians),
                "Choose only one primary guardian.");
        }
        else if (complete.Count != 0 && !complete.Any(x => x.IsPrimary))
        {
            complete[0].IsPrimary = true;
        }
    }

    private static bool IsCompleteGuardian(CreateModel.GuardianInput input) =>
        !string.IsNullOrWhiteSpace(input.Name)
        && !string.IsNullOrWhiteSpace(input.Phone);

    private static string? Normalize(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
