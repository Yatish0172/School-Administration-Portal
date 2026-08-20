using System.Globalization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Attendance;
using SchoolPortal.Domain.Fees;
using SchoolPortal.Domain.Staff;
using SchoolPortal.Domain.Students;
using SchoolPortal.Infrastructure.Identity;
using SchoolPortal.Infrastructure.Persistence;

namespace SchoolPortal.Web.Pages;

[Authorize]
public sealed class IndexModel(
    UserManager<ApplicationUser> userManager,
    SchoolPortalDbContext dbContext) : PageModel
{
    public string DisplayName { get; private set; } = string.Empty;

    public string RoleSummary { get; private set; } = string.Empty;

    public DateOnly Today { get; private set; }

    public IReadOnlyList<ModuleCard> Modules { get; private set; } = [];

    public IReadOnlyList<StatTile> Stats { get; private set; } = [];

    public async Task OnGetAsync(CancellationToken cancellationToken)
    {
        var user = await userManager.GetUserAsync(User);
        DisplayName = user?.DisplayName ?? User.Identity?.Name ?? "Staff member";
        var roles = user is null ? [] : await userManager.GetRolesAsync(user);
        RoleSummary = roles.Count == 0 ? "No role assigned" : string.Join(" · ", roles);
        Today = DateOnly.FromDateTime(DateTime.Today);

        var stats = new List<StatTile>();
        if (HasPermission(PermissionCatalog.Students.View))
        {
            var activeStudents = await dbContext.Set<Student>()
                .CountAsync(x => x.Status == StudentStatus.Active, cancellationToken);
            stats.Add(new StatTile(
                "Active students",
                activeStudents.ToString("N0", CultureInfo.CurrentCulture),
                "On the current rolls"));
        }

        if (HasPermission(PermissionCatalog.Attendance.View))
        {
            var presentToday = await dbContext.Set<AttendanceEntry>()
                .CountAsync(
                    x => x.Session.Date == Today
                        && x.Status == AttendanceStatus.Present,
                    cancellationToken);
            stats.Add(new StatTile(
                "Present today",
                presentToday.ToString("N0", CultureInfo.CurrentCulture),
                "Marked in today's registers"));
        }

        if (HasPermission(PermissionCatalog.Fees.View))
        {
            var collectedToday = await dbContext.Set<FeePayment>()
                .Where(x => x.PaymentDate == Today && x.Status == FeePaymentStatus.Posted)
                .SumAsync(x => (decimal?)x.Amount, cancellationToken) ?? 0m;
            stats.Add(new StatTile(
                "Collected today",
                "₹" + collectedToday.ToString("N2", CultureInfo.CurrentCulture),
                "Posted fee receipts"));
        }

        if (HasPermission(PermissionCatalog.Administration.ManageUsers))
        {
            var activeStaff = await dbContext.Set<StaffMember>()
                .CountAsync(x => x.IsActive, cancellationToken);
            stats.Add(new StatTile(
                "Staff on record",
                activeStaff.ToString("N0", CultureInfo.CurrentCulture),
                "Teachers and other staff"));
        }

        Stats = stats;

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

    private bool HasPermission(string permission) =>
        User.HasClaim(PermissionCatalog.ClaimType, permission);

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

    public sealed record StatTile(
        string Label,
        string Value,
        string Caption);
}
