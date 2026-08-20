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
    Policy = PermissionCatalog.PolicyPrefix + PermissionCatalog.Students.View)]
public sealed class DetailsModel(
    SchoolPortalDbContext dbContext,
    IAuthorizationService authorizationService,
    AuditWriter auditWriter) : PageModel
{
    public Student Student { get; private set; } = null!;

    public bool CanEdit { get; private set; }

    public bool CanViewSensitive { get; private set; }

    [BindProperty]
    public StudentStatus NewStatus { get; set; }

    [BindProperty]
    public uint Version { get; set; }

    public async Task<IActionResult> OnGetAsync(Guid id)
    {
        var result = await LoadAsync(id);
        return result ?? Page();
    }

    public async Task<IActionResult> OnPostChangeStatusAsync(Guid id)
    {
        var authorization = await authorizationService.AuthorizeAsync(
            User,
            resource: null,
            PermissionCatalog.Policy(PermissionCatalog.Students.Edit));
        if (!authorization.Succeeded)
        {
            return Forbid();
        }

        if (!Enum.IsDefined(NewStatus))
        {
            ModelState.AddModelError(string.Empty, "Choose a valid student status.");
            var invalidResult = await LoadAsync(id);
            return invalidResult ?? Page();
        }

        var student = await dbContext.Set<Student>().SingleOrDefaultAsync(x => x.Id == id);
        if (student is null)
        {
            return NotFound();
        }

        dbContext.Entry(student).Property(x => x.Version).OriginalValue = Version;
        var previousStatus = student.Status;
        student.Status = NewStatus;
        auditWriter.Add(
            "student.status-changed",
            "Student",
            student.Id,
            new { Status = previousStatus },
            new { Status = NewStatus });
        student.UpdatedAtUtc = DateTimeOffset.UtcNow;
        try
        {
            await dbContext.SaveChangesAsync();
            TempData["StatusMessage"] = $"Student status changed to {NewStatus}.";
            return RedirectToPage(new { id });
        }
        catch (DbUpdateConcurrencyException)
        {
            ModelState.AddModelError(
                string.Empty,
                "This student was changed by another user. Reload and try again.");
            var result = await LoadAsync(id);
            return result ?? Page();
        }
    }

    private async Task<IActionResult?> LoadAsync(Guid id)
    {
        var student = await dbContext.Set<Student>()
            .AsNoTracking()
            .AsSplitQuery()
            .Include(x => x.Guardians)
            .Include(x => x.Enrollments)
                .ThenInclude(x => x.AcademicYear)
            .Include(x => x.Enrollments)
                .ThenInclude(x => x.Class)
            .Include(x => x.Enrollments)
                .ThenInclude(x => x.Section)
            .SingleOrDefaultAsync(x => x.Id == id);
        if (student is null)
        {
            return NotFound();
        }

        Student = student;
        Version = student.Version;
        NewStatus = student.Status;
        CanEdit = (await authorizationService.AuthorizeAsync(
            User,
            resource: null,
            PermissionCatalog.Policy(PermissionCatalog.Students.Edit))).Succeeded;
        CanViewSensitive = (await authorizationService.AuthorizeAsync(
            User,
            resource: null,
            PermissionCatalog.Policy(PermissionCatalog.Students.ViewSensitive))).Succeeded;
        return null;
    }
}
