using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.RazorPages;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Infrastructure.Identity;

namespace SchoolPortal.Web.Pages;

[Authorize]
public sealed class IndexModel(
    UserManager<ApplicationUser> userManager) : PageModel
{
    public string DisplayName { get; private set; } = string.Empty;

    public string RoleSummary { get; private set; } = string.Empty;

    public IReadOnlyList<ModuleCard> Modules { get; private set; } = [];

    public async Task OnGetAsync()
    {
        var user = await userManager.GetUserAsync(User);
        DisplayName = user?.DisplayName ?? User.Identity?.Name ?? "Staff member";
        var roles = user is null ? [] : await userManager.GetRolesAsync(user);
        RoleSummary = roles.Count == 0 ? "No role assigned" : string.Join(" · ", roles);

        Modules =
        [
            BuildModule(
                "Students",
                "Admissions, profiles, guardians, documents, and status history.",
                PermissionCatalog.Students.View),
            BuildModule(
                "Academics",
                "Academic years, classes, sections, subjects, and assignments.",
                PermissionCatalog.Academics.Manage),
            BuildModule(
                "Attendance",
                "Daily attendance, corrections, and class summaries.",
                PermissionCatalog.Attendance.View),
            BuildModule(
                "Exams & marks",
                "Exam setup, mark entry, review, publishing, and report cards.",
                PermissionCatalog.Marks.Enter,
                PermissionCatalog.Marks.Review),
            BuildModule(
                "Fees",
                "Fee structures, concessions, payments, receipts, and dues.",
                PermissionCatalog.Fees.View),
            BuildModule(
                "Library",
                "Catalogue, copies, issue and return workflows, and fines.",
                PermissionCatalog.Library.View),
            BuildModule(
                "Reports",
                "Operational reports and permission-controlled exports.",
                PermissionCatalog.Reports.View),
            BuildModule(
                "Administration",
                "Users, roles, settings, audit, backups, and system health.",
                PermissionCatalog.Administration.ManageUsers,
                PermissionCatalog.System.ViewHealth),
        ];
    }

    private ModuleCard BuildModule(
        string name,
        string description,
        params string[] acceptedPermissions)
    {
        var isGranted = acceptedPermissions.Any(permission =>
            User.HasClaim(PermissionCatalog.ClaimType, permission));
        return new ModuleCard(name, description, isGranted);
    }

    public sealed record ModuleCard(
        string Name,
        string Description,
        bool IsGranted);
}