using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Academics;
using SchoolPortal.Infrastructure.Persistence;

namespace SchoolPortal.Web.Attendance;

public sealed class AttendanceAccessService(
    SchoolPortalDbContext dbContext)
{
    public async Task<IReadOnlyList<Guid>> GetAccessibleSectionIdsAsync(
        ClaimsPrincipal user,
        CancellationToken cancellationToken = default)
    {
        if (user.HasClaim(
            PermissionCatalog.ClaimType,
            PermissionCatalog.Attendance.MarkAny))
        {
            return await dbContext.Set<Section>()
                .Where(x => x.IsActive)
                .Select(x => x.Id)
                .ToListAsync(cancellationToken);
        }

        if (!user.HasClaim(
            PermissionCatalog.ClaimType,
            PermissionCatalog.Attendance.MarkAssigned)
            || !TryGetUserId(user, out var userId))
        {
            return [];
        }

        return await dbContext.Set<Section>()
            .Where(section =>
                section.IsActive
                && (section.ClassTeacherUserId == userId
                    || dbContext.Set<TeacherAssignment>().Any(assignment =>
                        assignment.SectionId == section.Id
                        && assignment.TeacherUserId == userId)))
            .Select(x => x.Id)
            .Distinct()
            .ToListAsync(cancellationToken);
    }

    public async Task<bool> CanMarkSectionAsync(
        ClaimsPrincipal user,
        Guid sectionId,
        CancellationToken cancellationToken = default)
    {
        var sectionIds = await GetAccessibleSectionIdsAsync(user, cancellationToken);
        return sectionIds.Contains(sectionId);
    }

    public static bool TryGetUserId(
        ClaimsPrincipal user,
        out Guid userId) =>
        Guid.TryParse(
            user.FindFirstValue(ClaimTypes.NameIdentifier),
            out userId);
}
