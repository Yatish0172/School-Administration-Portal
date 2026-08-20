using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Domain.Authorization;
using SchoolPortal.Domain.Licensing;
using SchoolPortal.Infrastructure.Identity;

namespace SchoolPortal.Infrastructure.Persistence;

public sealed class SchoolPortalDbContext(
    DbContextOptions<SchoolPortalDbContext> options)
    : IdentityDbContext<ApplicationUser, IdentityRole<Guid>, Guid>(options)
{
    public DbSet<Permission> Permissions => Set<Permission>();

    public DbSet<RolePermission> RolePermissions => Set<RolePermission>();

    public DbSet<TrialState> TrialStates => Set<TrialState>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);

        builder.HasDefaultSchema("portal");
        builder.HasSequence<long>("AdmissionNumberSequence", "portal")
            .StartsAt(1)
            .IncrementsBy(1);
        builder.HasSequence<long>("FeeReceiptNumberSequence", "portal")
            .StartsAt(1)
            .IncrementsBy(1);
        builder.HasSequence<long>("LibraryAccessionNumberSequence", "portal")
            .StartsAt(1)
            .IncrementsBy(1);
        builder.ApplyConfigurationsFromAssembly(typeof(SchoolPortalDbContext).Assembly);

        builder.Entity<ApplicationUser>(user =>
        {
            user.Property(x => x.DisplayName)
                .HasMaxLength(200)
                .IsRequired();
        });

        builder.Entity<Permission>(permission =>
        {
            permission.ToTable("Permissions");
            permission.HasKey(x => x.Id);
            permission.Property(x => x.Key).HasMaxLength(150).IsRequired();
            permission.Property(x => x.Module).HasMaxLength(100).IsRequired();
            permission.Property(x => x.Description).HasMaxLength(500).IsRequired();
            permission.HasIndex(x => x.Key).IsUnique();
        });

        builder.Entity<RolePermission>(rolePermission =>
        {
            rolePermission.ToTable("RolePermissions");
            rolePermission.HasKey(x => new
            {
                x.RoleId,
                x.PermissionId,
            });
            rolePermission
                .HasOne<IdentityRole<Guid>>()
                .WithMany()
                .HasForeignKey(x => x.RoleId)
                .OnDelete(DeleteBehavior.Cascade);
            rolePermission
                .HasOne(x => x.Permission)
                .WithMany()
                .HasForeignKey(x => x.PermissionId)
                .OnDelete(DeleteBehavior.Cascade);
        });
    }
}
