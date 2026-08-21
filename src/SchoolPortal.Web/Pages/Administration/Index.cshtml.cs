using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Infrastructure.Identity;
using SchoolPortal.Infrastructure.Persistence;
using SchoolPortal.Web.Administration;

namespace SchoolPortal.Web.Pages.Administration;

[Authorize(
    Policy = PermissionCatalog.PolicyPrefix
        + PermissionCatalog.Administration.ManageUsers)]
public sealed class IndexModel(
    SchoolPortalDbContext dbContext,
    UserManager<ApplicationUser> userManager,
    AuditWriter auditWriter) : PageModel
{
    private static readonly Dictionary<string, string> RoleSummaries =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [RoleCatalog.SuperAdministrator] = "Full access, including backup restore",
            [RoleCatalog.Administrator] = "Day-to-day administration",
            [RoleCatalog.Principal] = "School oversight and approvals",
            [RoleCatalog.Teacher] = "Classes, attendance, and marks",
            [RoleCatalog.Accounts] = "Fees, collections, and reports",
            [RoleCatalog.Librarian] = "Catalogue, circulation, and fines",
        };

    [BindProperty(SupportsGet = true)]
    public string? Search { get; set; }

    [BindProperty(SupportsGet = true)]
    public string? Role { get; set; }

    [BindProperty(SupportsGet = true)]
    public string? Status { get; set; }

    [BindProperty]
    public NewUserInput NewUser { get; set; } = new();

    [BindProperty]
    public AccessInput EditAccess { get; set; } = new();

    [TempData]
    public string? StatusMessage { get; set; }

    public string? OpenModal { get; private set; }

    public IReadOnlyList<RoleOption> Roles { get; private set; } = [];

    public IReadOnlyList<UserRow> Users { get; private set; } = [];

    public int TotalUsers { get; private set; }

    public int ActiveUsers { get; private set; }

    public int DisabledUsers => TotalUsers - ActiveUsers;

    public int AdministratorUsers { get; private set; }

    public async Task OnGetAsync() => await LoadAsync();

    public async Task<IActionResult> OnPostCreateAsync()
    {
        ModelState.Clear();
        if (!TryValidateModel(NewUser, nameof(NewUser)))
        {
            OpenModal = "addUserModal";
            await LoadAsync();
            return Page();
        }

        if (!RoleCatalog.All.Contains(NewUser.Role, StringComparer.Ordinal))
        {
            ModelState.AddModelError(
                $"{nameof(NewUser)}.{nameof(NewUser.Role)}",
                "Choose a valid access level.");
            OpenModal = "addUserModal";
            await LoadAsync();
            return Page();
        }

        var user = new ApplicationUser
        {
            UserName = NewUser.Username.Trim(),
            DisplayName = NewUser.DisplayName.Trim(),
            Email = Normalize(NewUser.Email)?.ToLowerInvariant(),
            IsActive = true,
            MustChangePassword = true,
        };

        await using var transaction = await dbContext.Database.BeginTransactionAsync();
        var createResult = await userManager.CreateAsync(user, NewUser.Password);
        if (!createResult.Succeeded)
        {
            AddErrors(createResult);
            await transaction.RollbackAsync();
            OpenModal = "addUserModal";
            await LoadAsync();
            return Page();
        }

        var roleResult = await userManager.AddToRoleAsync(user, NewUser.Role);
        if (!roleResult.Succeeded)
        {
            AddErrors(roleResult);
            await transaction.RollbackAsync();
            OpenModal = "addUserModal";
            await LoadAsync();
            return Page();
        }

        auditWriter.Add(
            "user.created",
            "ApplicationUser",
            user.Id,
            before: null,
            after: new { user.DisplayName, user.UserName, Role = NewUser.Role, user.IsActive });
        await dbContext.SaveChangesAsync();
        await transaction.CommitAsync();

        StatusMessage = $"User {user.DisplayName} created with {NewUser.Role} access.";
        return RedirectToPage();
    }

    public async Task<IActionResult> OnPostUpdateAccessAsync()
    {
        ModelState.Clear();
        if (!TryValidateModel(EditAccess, nameof(EditAccess)))
        {
            OpenModal = "manageAccessModal";
            await LoadAsync();
            return Page();
        }

        if (!RoleCatalog.All.Contains(EditAccess.Role, StringComparer.Ordinal))
        {
            ModelState.AddModelError(
                $"{nameof(EditAccess)}.{nameof(EditAccess.Role)}",
                "Choose a valid access level.");
            OpenModal = "manageAccessModal";
            await LoadAsync();
            return Page();
        }

        var user = await userManager.FindByIdAsync(EditAccess.UserId.ToString());
        if (user is null)
        {
            return NotFound();
        }

        var currentRoles = await userManager.GetRolesAsync(user);
        var currentRole = currentRoles.FirstOrDefault() ?? string.Empty;

        var actor = await userManager.GetUserAsync(User);
        if (actor is not null && actor.Id == user.Id)
        {
            var changesOwnRole = !string.Equals(
                EditAccess.Role,
                currentRole,
                StringComparison.Ordinal);
            if (!EditAccess.IsActive || changesOwnRole)
            {
                ModelState.AddModelError(
                    string.Empty,
                    "You cannot change or disable your own account. Ask another administrator.");
                OpenModal = "manageAccessModal";
                await LoadAsync();
                return Page();
            }
        }

        var actorIsSuperAdministrator = actor is not null
            && await userManager.IsInRoleAsync(actor, RoleCatalog.SuperAdministrator);
        var touchesSuperAdministrator =
            string.Equals(EditAccess.Role, RoleCatalog.SuperAdministrator, StringComparison.Ordinal)
            || currentRoles.Contains(RoleCatalog.SuperAdministrator);
        if (touchesSuperAdministrator && !actorIsSuperAdministrator)
        {
            ModelState.AddModelError(
                string.Empty,
                "Only a Super Administrator can grant or change Super Administrator access.");
            OpenModal = "manageAccessModal";
            await LoadAsync();
            return Page();
        }

        var before = new { Role = currentRole, user.IsActive };

        await using var transaction = await dbContext.Database.BeginTransactionAsync(
            System.Data.IsolationLevel.Serializable);
        await dbContext.Database.ExecuteSqlRawAsync(
            "SELECT pg_advisory_xact_lock(8172635402)");

        if (user.IsActive
            && currentRoles.Contains(RoleCatalog.SuperAdministrator)
            && (!EditAccess.IsActive
                || !string.Equals(EditAccess.Role, RoleCatalog.SuperAdministrator, StringComparison.Ordinal))
            && await CountActiveSuperAdministratorsAsync() <= 1)
        {
            await transaction.RollbackAsync();
            ModelState.AddModelError(
                string.Empty,
                "This is the last active Super Administrator. Give another user that access before changing this account.");
            OpenModal = "manageAccessModal";
            await LoadAsync();
            return Page();
        }
        if (!currentRoles.SequenceEqual([EditAccess.Role], StringComparer.Ordinal))
        {
            if (currentRoles.Count > 0)
            {
                var removeResult = await userManager.RemoveFromRolesAsync(user, currentRoles);
                if (!removeResult.Succeeded)
                {
                    AddErrors(removeResult);
                    await transaction.RollbackAsync();
                    OpenModal = "manageAccessModal";
                    await LoadAsync();
                    return Page();
                }
            }

            var addResult = await userManager.AddToRoleAsync(user, EditAccess.Role);
            if (!addResult.Succeeded)
            {
                AddErrors(addResult);
                await transaction.RollbackAsync();
                OpenModal = "manageAccessModal";
                await LoadAsync();
                return Page();
            }
        }

        user.IsActive = EditAccess.IsActive;
        var updateResult = await userManager.UpdateAsync(user);
        if (!updateResult.Succeeded)
        {
            AddErrors(updateResult);
            await transaction.RollbackAsync();
            OpenModal = "manageAccessModal";
            await LoadAsync();
            return Page();
        }

        var stampResult = await userManager.UpdateSecurityStampAsync(user);
        if (!stampResult.Succeeded)
        {
            AddErrors(stampResult);
            await transaction.RollbackAsync();
            OpenModal = "manageAccessModal";
            await LoadAsync();
            return Page();
        }

        auditWriter.Add(
            "user.access-updated",
            "ApplicationUser",
            user.Id,
            before,
            after: new { Role = EditAccess.Role, user.IsActive });
        await dbContext.SaveChangesAsync();
        await transaction.CommitAsync();

        StatusMessage = $"Access updated for {user.DisplayName}.";
        return RedirectToPage();
    }

    private async Task LoadAsync()
    {
        Roles = RoleCatalog.All.Select(name => new RoleOption(name, RoleSummaries[name])).ToArray();

        var accounts = await userManager.Users
            .AsNoTracking()
            .OrderByDescending(x => x.IsActive)
            .ThenBy(x => x.DisplayName)
            .ThenBy(x => x.UserName)
            .ToListAsync();

        TotalUsers = accounts.Count;
        ActiveUsers = accounts.Count(x => x.IsActive);
        var rows = new List<UserRow>(accounts.Count);
        foreach (var account in accounts)
        {
            var roles = await userManager.GetRolesAsync(account);
            var role = roles.FirstOrDefault() ?? "No role assigned";
            rows.Add(new UserRow(
                account.Id,
                string.IsNullOrWhiteSpace(account.DisplayName) ? account.UserName ?? "Unnamed user" : account.DisplayName,
                account.UserName ?? string.Empty,
                role,
                RoleSummaries.GetValueOrDefault(role, "No portal permissions"),
                account.IsActive,
                account.LockoutEnd > DateTimeOffset.UtcNow,
                account.LastLoginAtUtc));
        }

        AdministratorUsers = rows.Count(x =>
            x.IsActive && (x.Role == RoleCatalog.SuperAdministrator || x.Role == RoleCatalog.Administrator));

        IEnumerable<UserRow> filtered = rows;
        if (!string.IsNullOrWhiteSpace(Search))
        {
            var term = Search.Trim();
            filtered = filtered.Where(x =>
                x.DisplayName.Contains(term, StringComparison.OrdinalIgnoreCase)
                || x.Username.Contains(term, StringComparison.OrdinalIgnoreCase));
        }

        if (!string.IsNullOrWhiteSpace(Role))
        {
            filtered = filtered.Where(x => string.Equals(x.Role, Role, StringComparison.Ordinal));
        }

        filtered = Status?.ToLowerInvariant() switch
        {
            "active" => filtered.Where(x => x.IsActive),
            "disabled" => filtered.Where(x => !x.IsActive),
            _ => filtered,
        };
        Users = filtered.ToArray();
    }

    private async Task<int> CountActiveSuperAdministratorsAsync()
    {
        var superAdministrators = await userManager.GetUsersInRoleAsync(RoleCatalog.SuperAdministrator);
        return superAdministrators.Count(x => x.IsActive);
    }

    private void AddErrors(IdentityResult result)
    {
        foreach (var error in result.Errors)
        {
            ModelState.AddModelError(string.Empty, error.Description);
        }
    }

    private static string? Normalize(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    public sealed class NewUserInput
    {
        [Required, StringLength(200)]
        [Display(Name = "Full name")]
        public string DisplayName { get; set; } = string.Empty;

        [Required, StringLength(100, MinimumLength = 3)]
        [RegularExpression("^[A-Za-z0-9._-]+$", ErrorMessage = "Use only letters, numbers, dot, underscore, or hyphen.")]
        public string Username { get; set; } = string.Empty;

        [EmailAddress, StringLength(254)]
        public string? Email { get; set; }

        [Required]
        [Display(Name = "Access level")]
        public string Role { get; set; } = RoleCatalog.Teacher;

        [Required, DataType(DataType.Password), MinLength(8)]
        public string Password { get; set; } = string.Empty;

        [Required, DataType(DataType.Password)]
        [Compare(nameof(Password), ErrorMessage = "Passwords do not match.")]
        [Display(Name = "Confirm temporary password")]
        public string ConfirmPassword { get; set; } = string.Empty;
    }

    public sealed class AccessInput
    {
        [Required]
        public Guid UserId { get; set; }

        [Required]
        public string Role { get; set; } = string.Empty;

        public bool IsActive { get; set; } = true;
    }

    public sealed record RoleOption(string Name, string Summary);

    public sealed record UserRow(
        Guid Id,
        string DisplayName,
        string Username,
        string Role,
        string RoleSummary,
        bool IsActive,
        bool IsLocked,
        DateTimeOffset? LastLoginAtUtc)
    {
        public string Initials
        {
            get
            {
                var parts = DisplayName.Split(
                    ' ',
                    StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                return string.Concat(parts.Take(2).Select(x => char.ToUpperInvariant(x[0])));
            }
        }
    }
}
