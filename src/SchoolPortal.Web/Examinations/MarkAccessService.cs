using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Academics;
using SchoolPortal.Infrastructure.Persistence;

namespace SchoolPortal.Web.Examinations;

public sealed class MarkAccessService(
    SchoolPortalDbContext dbContext)
{
    public async Task<bool> CanEnterAsync(
        ClaimsPrincipal user,
        Guid sectionId,
        Guid subjectId,
        CancellationToken cancellationToken = default)
    {
        if (!user.HasClaim(
            PermissionCatalog.ClaimType,
            PermissionCatalog.Marks.Enter)
            || !TryGetUserId(user, out var userId))
        {
            return false;
        }

        if (user.HasClaim(
            PermissionCatalog.ClaimType,
            PermissionCatalog.Marks.Review)
            || user.HasClaim(
                PermissionCatalog.ClaimType,
                PermissionCatalog.Marks.Publish))
        {
            return true;
        }

        return await dbContext.Set<Section>().AnyAsync(
            section =>
                section.Id == sectionId
                && (section.ClassTeacherUserId == userId
                    || dbContext.Set<TeacherAssignment>().Any(assignment =>
                        assignment.SectionId == sectionId
                        && assignment.SubjectId == subjectId
                        && assignment.TeacherUserId == userId)),
            cancellationToken);
    }

    public static bool TryGetUserId(
        ClaimsPrincipal user,
        out Guid userId) =>
        Guid.TryParse(
            user.FindFirstValue(ClaimTypes.NameIdentifier),
            out userId);
}
