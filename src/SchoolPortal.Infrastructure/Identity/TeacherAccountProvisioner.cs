using Microsoft.AspNetCore.Identity;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Staff;

namespace SchoolPortal.Infrastructure.Identity;

public sealed class TeacherAccountProvisioner(
    UserManager<ApplicationUser> userManager)
{
    public async Task<ApplicationUser?> EnsureLinkedAsync(StaffMember staff)
    {
        if (!staff.IsActive
            || !staff.Designation.Contains(
                "Teacher",
                StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        ApplicationUser? user = null;
        if (staff.PortalUserId.HasValue)
        {
            user = await userManager.FindByIdAsync(
                staff.PortalUserId.Value.ToString());
        }

        if (user is null)
        {
            user = new ApplicationUser
            {
                UserName = await CreateUniqueUserNameAsync(staff),
                DisplayName = staff.FullName,
                IsActive = true,
                MustChangePassword = true,
            };
            EnsureSucceeded(
                await userManager.CreateAsync(user),
                $"create a teacher account for {staff.FullName}");
        }
        else if (string.IsNullOrWhiteSpace(user.DisplayName))
        {
            user.DisplayName = staff.FullName;
            EnsureSucceeded(
                await userManager.UpdateAsync(user),
                $"update the teacher account for {staff.FullName}");
        }

        if (!await userManager.IsInRoleAsync(user, RoleCatalog.Teacher))
        {
            EnsureSucceeded(
                await userManager.AddToRoleAsync(user, RoleCatalog.Teacher),
                $"assign the Teacher role to {staff.FullName}");
        }

        staff.PortalUserId = user.Id;
        return user;
    }

    private async Task<string> CreateUniqueUserNameAsync(StaffMember staff)
    {
        var stem = new string(staff.StaffNumber
            .Where(char.IsAsciiLetterOrDigit)
            .Select(char.ToLowerInvariant)
            .Take(40)
            .ToArray());
        if (string.IsNullOrWhiteSpace(stem))
        {
            stem = staff.Id.ToString("N")[..12];
        }

        var baseName = $"teacher.{stem}";
        var candidate = baseName;
        var attempt = 0;
        while (await userManager.FindByNameAsync(candidate) is not null)
        {
            attempt++;
            candidate = $"{baseName}.{staff.Id:N}"[..Math.Min(
                baseName.Length + 9,
                60)];
            if (attempt > 1)
            {
                candidate = $"{candidate}.{attempt}";
            }
        }

        return candidate;
    }

    private static void EnsureSucceeded(IdentityResult result, string action)
    {
        if (result.Succeeded)
        {
            return;
        }

        var errors = string.Join(
            "; ",
            result.Errors.Select(error => error.Description));
        throw new InvalidOperationException($"Unable to {action}: {errors}");
    }
}
