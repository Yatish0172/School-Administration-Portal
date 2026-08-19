using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Academics;
using SchoolPortal.Domain.Staff;
using SchoolPortal.Infrastructure.Identity;
using SchoolPortal.Infrastructure.Persistence;

namespace SchoolPortal.Web.Pages.Staff;

[Authorize(
    Policy = PermissionCatalog.PolicyPrefix
        + PermissionCatalog.Administration.ManageUsers)]
public sealed class IndexModel(
    SchoolPortalDbContext dbContext,
    UserManager<ApplicationUser> userManager,
    TeacherAccountProvisioner teacherAccountProvisioner) : PageModel
{
    public IReadOnlyList<StaffMember> StaffMembers { get; private set; } = [];

    public IReadOnlyList<TeacherSummary> Teachers { get; private set; } = [];

    public IReadOnlyList<ApplicationUser> PortalUsers { get; private set; } = [];

    public IReadOnlyDictionary<Guid, string> PortalUserNames { get; private set; } =
        new Dictionary<Guid, string>();

    [BindProperty]
    public StaffInput NewStaff { get; set; } = new();

    [BindProperty]
    public EditStaffInput EditStaff { get; set; } = new();

    [TempData]
    public string? StatusMessage { get; set; }

    public async Task OnGetAsync() => await LoadAsync();

    public async Task<IActionResult> OnPostCreateAsync()
    {
        ModelState.Clear();
        if (!TryValidateModel(NewStaff, nameof(NewStaff))
            || !await ValidatePortalUserAsync(
                NewStaff.PortalUserId,
                nameof(NewStaff)))
        {
            await LoadAsync();
            return Page();
        }

        dbContext.Add(new StaffMember());
        var staff = dbContext.ChangeTracker
            .Entries<StaffMember>()
            .Single()
            .Entity;
        Apply(staff, NewStaff);
        return await SaveAsync("Staff member added.", staff);
    }

    public async Task<IActionResult> OnPostUpdateAsync()
    {
        ModelState.Clear();
        if (!TryValidateModel(EditStaff, nameof(EditStaff))
            || !await ValidatePortalUserAsync(
                EditStaff.PortalUserId,
                nameof(EditStaff),
                EditStaff.Id))
        {
            await LoadAsync();
            return Page();
        }

        var staff = await dbContext.Set<StaffMember>()
            .SingleOrDefaultAsync(x => x.Id == EditStaff.Id);
        if (staff is null)
        {
            return NotFound();
        }

        dbContext.Entry(staff).Property(x => x.Version).OriginalValue =
            EditStaff.Version;
        Apply(staff, EditStaff);
        staff.IsActive = EditStaff.IsActive;
        return await SaveAsync("Staff details updated.", staff);
    }

    private async Task<bool> ValidatePortalUserAsync(
        Guid? portalUserId,
        string prefix,
        Guid? currentStaffId = null)
    {
        if (!portalUserId.HasValue)
        {
            return true;
        }

        var user = await userManager.FindByIdAsync(portalUserId.Value.ToString());
        if (user is null || !user.IsActive)
        {
            ModelState.AddModelError(
                $"{prefix}.{nameof(StaffInput.PortalUserId)}",
                "Choose an active portal account.");
            return false;
        }

        var alreadyLinked = await dbContext.Set<StaffMember>().AnyAsync(x =>
            x.PortalUserId == portalUserId
            && (!currentStaffId.HasValue || x.Id != currentStaffId.Value));
        if (alreadyLinked)
        {
            ModelState.AddModelError(
                $"{prefix}.{nameof(StaffInput.PortalUserId)}",
                "That portal account is already linked to another staff member.");
            return false;
        }

        return true;
    }

    private async Task<IActionResult> SaveAsync(
        string message,
        StaffMember staff)
    {
        await using var transaction =
            await dbContext.Database.BeginTransactionAsync();
        try
        {
            await teacherAccountProvisioner.EnsureLinkedAsync(staff);
            await dbContext.SaveChangesAsync();
            await transaction.CommitAsync();
            StatusMessage = message;
            return RedirectToPage();
        }
        catch (DbUpdateConcurrencyException)
        {
            await transaction.RollbackAsync();
            dbContext.ChangeTracker.Clear();
            ModelState.AddModelError(
                string.Empty,
                "These staff details changed in another window. Refresh and try again.");
        }
        catch (DbUpdateException)
        {
            await transaction.RollbackAsync();
            dbContext.ChangeTracker.Clear();
            ModelState.AddModelError(
                string.Empty,
                "The staff number or linked portal account is already in use.");
        }
        catch (InvalidOperationException exception)
        {
            await transaction.RollbackAsync();
            dbContext.ChangeTracker.Clear();
            ModelState.AddModelError(string.Empty, exception.Message);
        }

        await LoadAsync();
        return Page();
    }

    private async Task LoadAsync()
    {
        StaffMembers = await dbContext.Set<StaffMember>()
            .AsNoTracking()
            .OrderByDescending(x => x.IsActive)
            .ThenBy(x => x.FirstName)
            .ThenBy(x => x.LastName)
            .ToListAsync();
        PortalUsers = await userManager.Users
            .Where(x => x.IsActive)
            .OrderBy(x => x.DisplayName)
            .ThenBy(x => x.UserName)
            .ToListAsync();
        PortalUserNames = PortalUsers.ToDictionary(
            x => x.Id,
            x => string.IsNullOrWhiteSpace(x.DisplayName)
                ? x.UserName ?? "Portal user"
                : x.DisplayName);
        var teacherUsers = (await userManager.GetUsersInRoleAsync(RoleCatalog.Teacher))
            .Where(x => x.IsActive)
            .ToArray();
        var teacherUserIds = teacherUsers.Select(x => x.Id).ToArray();
        var today = DateOnly.FromDateTime(DateTime.Today);
        var activeYear = await dbContext.Set<AcademicYear>()
            .AsNoTracking()
            .Where(x => x.Status == AcademicYearStatus.Open && x.EndDate >= today)
            .OrderByDescending(x => x.IsCurrent)
            .ThenByDescending(x => x.StartDate)
            .FirstOrDefaultAsync();
        var assignments = activeYear is null
            ? []
            : await dbContext.Set<TeacherAssignment>()
                .AsNoTracking()
                .Include(x => x.Class)
                .Include(x => x.Subject)
                .Where(x => x.AcademicYearId == activeYear.Id
                    && teacherUserIds.Contains(x.TeacherUserId))
                .ToListAsync();
        var classTeacherSections = activeYear is null
            ? []
            : await dbContext.Set<Section>()
                .AsNoTracking()
                .Include(x => x.Class)
                .Where(x => x.AcademicYearId == activeYear.Id
                    && x.IsActive
                    && x.ClassTeacherUserId.HasValue
                    && teacherUserIds.Contains(x.ClassTeacherUserId.Value))
                .ToListAsync();
        var staffByUserId = StaffMembers
            .Where(x => x.PortalUserId.HasValue)
            .ToDictionary(x => x.PortalUserId!.Value);
        var accountTeachers = teacherUsers.Select(user =>
        {
            staffByUserId.TryGetValue(user.Id, out var staff);
            var teacherAssignments = assignments
                .Where(x => x.TeacherUserId == user.Id)
                .ToArray();
            var classTeacherAssignments = classTeacherSections
                .Where(x => x.ClassTeacherUserId == user.Id)
                .OrderBy(x => x.Class.SortOrder)
                .ThenBy(x => x.Name)
                .ToArray();
            var name = staff?.FullName
                ?? (string.IsNullOrWhiteSpace(user.DisplayName)
                    ? user.UserName ?? "Teacher"
                    : user.DisplayName);
            return new TeacherSummary(
                user.Id,
                staff?.Id,
                name,
                classTeacherAssignments.Length > 0,
                JoinDistinct(teacherAssignments.Select(x => x.Subject.Name)),
                JoinDistinct(teacherAssignments
                    .OrderBy(x => x.Class.SortOrder)
                    .Select(x => x.Class.Name)),
                JoinDistinct(classTeacherAssignments.Select(x =>
                    $"{x.Class.Name} - Section {x.Name}")),
                staff?.StaffNumber,
                staff?.Designation,
                staff?.Department,
                staff?.EmploymentType,
                staff?.DateOfJoining,
                staff?.Phone,
                staff?.AlternatePhone,
                staff?.Email,
                staff is null
                    ? null
                    : $"{staff.Address}, {staff.City}, {staff.State} {staff.PostalCode}",
                staff?.EmergencyContactName,
                staff?.EmergencyContactPhone);
        });
        var directoryTeachers = StaffMembers
            .Where(staff => staff.IsActive
                && staff.Designation.Contains(
                    "Teacher",
                    StringComparison.OrdinalIgnoreCase)
                && (!staff.PortalUserId.HasValue
                    || !teacherUserIds.Contains(staff.PortalUserId.Value)))
            .Select(staff => new TeacherSummary(
                staff.PortalUserId,
                staff.Id,
                staff.FullName,
                false,
                "Not assigned",
                "Not assigned",
                "Not assigned",
                staff.StaffNumber,
                staff.Designation,
                staff.Department,
                staff.EmploymentType,
                staff.DateOfJoining,
                staff.Phone,
                staff.AlternatePhone,
                staff.Email,
                $"{staff.Address}, {staff.City}, {staff.State} {staff.PostalCode}",
                staff.EmergencyContactName,
                staff.EmergencyContactPhone));
        Teachers = accountTeachers
            .Concat(directoryTeachers)
            .OrderBy(x => x.Name)
            .ToArray();
    }
    private static string JoinDistinct(IEnumerable<string> values)
    {
        var result = values
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        return result.Length == 0 ? "Not assigned" : string.Join(", ", result);
    }

    public sealed record TeacherSummary(
        Guid? UserId,
        Guid? StaffId,
        string Name,
        bool IsClassTeacher,
        string Subjects,
        string Classes,
        string ClassTeacherOf,
        string? StaffNumber,
        string? Designation,
        string? Department,
        string? EmploymentType,
        DateOnly? DateOfJoining,
        string? Phone,
        string? AlternatePhone,
        string? Email,
        string? Address,
        string? EmergencyContactName,
        string? EmergencyContactPhone);
    private static void Apply(StaffMember staff, StaffInput input)
    {
        staff.StaffNumber = input.StaffNumber.Trim().ToUpperInvariant();
        staff.FirstName = input.FirstName.Trim();
        staff.MiddleName = Normalize(input.MiddleName);
        staff.LastName = input.LastName.Trim();
        staff.Designation = input.Designation.Trim();
        staff.Department = Normalize(input.Department);
        staff.EmploymentType = Normalize(input.EmploymentType);
        staff.DateOfJoining = input.DateOfJoining;
        staff.Phone = input.Phone.Trim();
        staff.AlternatePhone = Normalize(input.AlternatePhone);
        staff.Email = Normalize(input.Email)?.ToLowerInvariant();
        staff.Address = input.Address.Trim();
        staff.City = input.City.Trim();
        staff.State = input.State.Trim();
        staff.PostalCode = input.PostalCode.Trim();
        staff.EmergencyContactName = Normalize(input.EmergencyContactName);
        staff.EmergencyContactPhone = Normalize(input.EmergencyContactPhone);
        staff.PortalUserId = input.PortalUserId;
    }

    private static string? Normalize(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    public class StaffInput
    {
        [Required, StringLength(50)]
        [Display(Name = "Staff number")]
        public string StaffNumber { get; set; } = string.Empty;

        [Required, StringLength(100)]
        [Display(Name = "First name")]
        public string FirstName { get; set; } = string.Empty;

        [StringLength(100)]
        [Display(Name = "Middle name")]
        public string? MiddleName { get; set; }

        [Required, StringLength(100)]
        [Display(Name = "Last name")]
        public string LastName { get; set; } = string.Empty;

        [Required, StringLength(150)]
        public string Designation { get; set; } = string.Empty;

        [StringLength(150)]
        public string? Department { get; set; }

        [StringLength(80)]
        [Display(Name = "Employment type")]
        public string? EmploymentType { get; set; }

        [DataType(DataType.Date)]
        [Display(Name = "Date of joining")]
        public DateOnly? DateOfJoining { get; set; }

        [Required, Phone, StringLength(30)]
        public string Phone { get; set; } = string.Empty;

        [Phone, StringLength(30)]
        [Display(Name = "Alternate phone")]
        public string? AlternatePhone { get; set; }

        [EmailAddress, StringLength(254)]
        public string? Email { get; set; }

        [Required, StringLength(1000)]
        public string Address { get; set; } = string.Empty;

        [Required, StringLength(100)]
        public string City { get; set; } = string.Empty;

        [Required, StringLength(100)]
        public string State { get; set; } = string.Empty;

        [Required, StringLength(20)]
        [Display(Name = "Postal code")]
        public string PostalCode { get; set; } = string.Empty;

        [StringLength(200)]
        [Display(Name = "Emergency contact")]
        public string? EmergencyContactName { get; set; }

        [Phone, StringLength(30)]
        [Display(Name = "Emergency phone")]
        public string? EmergencyContactPhone { get; set; }

        [Display(Name = "Portal account")]
        public Guid? PortalUserId { get; set; }
    }

    public sealed class EditStaffInput : StaffInput
    {
        [Required]
        public Guid Id { get; set; }

        public bool IsActive { get; set; } = true;

        public uint Version { get; set; }
    }
}
