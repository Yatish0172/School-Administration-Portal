using System.Security.Claims;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Authorization;
using SchoolPortal.Domain.Licensing;
using SchoolPortal.Domain.Staff;
using SchoolPortal.Infrastructure.Identity;

namespace SchoolPortal.Infrastructure.Persistence;

public static class DatabaseInitializer
{
    public static async Task InitializeSchoolPortalDatabaseAsync(
        this IServiceProvider services,
        CancellationToken cancellationToken = default)
    {
        await using var scope = services.CreateAsyncScope();
        var scopedServices = scope.ServiceProvider;
        var dbContext = scopedServices.GetRequiredService<SchoolPortalDbContext>();
        var roleManager = scopedServices.GetRequiredService<RoleManager<IdentityRole<Guid>>>();
        var teacherAccountProvisioner = scopedServices
            .GetRequiredService<TeacherAccountProvisioner>();

        await dbContext.Database.MigrateAsync(cancellationToken);
        await using var seedTransaction = await dbContext.Database
            .BeginTransactionAsync(cancellationToken);
        await dbContext.Database.ExecuteSqlRawAsync(
            "SELECT pg_advisory_xact_lock(8172635400)",
            cancellationToken);

        foreach (var roleName in RoleCatalog.All)
        {
            if (!await roleManager.RoleExistsAsync(roleName))
            {
                var result = await roleManager.CreateAsync(new IdentityRole<Guid>(roleName));
                EnsureSucceeded(result, $"create role '{roleName}'");
            }
        }

        var permissionsByKey = await dbContext.Permissions
            .ToDictionaryAsync(x => x.Key, cancellationToken);

        foreach (var definition in PermissionCatalog.All)
        {
            if (permissionsByKey.TryGetValue(definition.Key, out var permission))
            {
                permission.Module = definition.Module;
                permission.Description = definition.Description;
                continue;
            }

            permission = new Permission
            {
                Key = definition.Key,
                Module = definition.Module,
                Description = definition.Description,
            };
            dbContext.Permissions.Add(permission);
            permissionsByKey.Add(permission.Key, permission);
        }

        await dbContext.SaveChangesAsync(cancellationToken);

        foreach (var (roleName, permissionKeys) in RoleCatalog.DefaultPermissions)
        {
            var role = await roleManager.FindByNameAsync(roleName)
                ?? throw new InvalidOperationException($"Role '{roleName}' was not found after seeding.");

            var existingClaims = await roleManager.GetClaimsAsync(role);
            var existingPermissionClaims = existingClaims
                .Where(x => x.Type == PermissionCatalog.ClaimType)
                .Select(x => x.Value)
                .ToHashSet(StringComparer.Ordinal);

            foreach (var permissionKey in permissionKeys)
            {
                if (!existingPermissionClaims.Contains(permissionKey))
                {
                    var result = await roleManager.AddClaimAsync(
                        role,
                        new Claim(PermissionCatalog.ClaimType, permissionKey));
                    EnsureSucceeded(result, $"grant '{permissionKey}' to '{roleName}'");
                }

                var permission = permissionsByKey[permissionKey];
                var mappingExists = await dbContext.RolePermissions.AnyAsync(
                    x => x.RoleId == role.Id && x.PermissionId == permission.Id,
                    cancellationToken);
                if (!mappingExists)
                {
                    dbContext.RolePermissions.Add(new RolePermission
                    {
                        RoleId = role.Id,
                        PermissionId = permission.Id,
                    });
                }
            }
        }

        if (!await dbContext.Set<TrialState>().AnyAsync(cancellationToken))
        {
            dbContext.Add(new TrialState { FirstRunAtUtc = DateTimeOffset.UtcNow });
        }

        await dbContext.SaveChangesAsync(cancellationToken);

        var unlinkedTeachers = await dbContext.Set<StaffMember>()
            .Where(staff => staff.IsActive && !staff.PortalUserId.HasValue)
            .ToListAsync(cancellationToken);
        foreach (var staff in unlinkedTeachers)
        {
            await teacherAccountProvisioner.EnsureLinkedAsync(staff);
        }

        await dbContext.SaveChangesAsync(cancellationToken);
        await seedTransaction.CommitAsync(cancellationToken);
    }

    private static void EnsureSucceeded(IdentityResult result, string action)
    {
        if (result.Succeeded)
        {
            return;
        }

        var errors = string.Join("; ", result.Errors.Select(x => x.Description));
        throw new InvalidOperationException($"Unable to {action}: {errors}");
    }
}
