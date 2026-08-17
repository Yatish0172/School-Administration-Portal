using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using SchoolPortal.Domain.Academics;

namespace SchoolPortal.Infrastructure.Persistence.Configurations;

internal sealed class AcademicBreakPeriodConfiguration
    : IEntityTypeConfiguration<AcademicBreakPeriod>
{
    public void Configure(EntityTypeBuilder<AcademicBreakPeriod> builder)
    {
        builder.ToTable("AcademicBreakPeriods");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Name).HasMaxLength(100).IsRequired();
        builder.Property(x => x.Scope).HasConversion<string>().HasMaxLength(30);
        builder.Property(x => x.Version).IsRowVersion();
        builder.HasIndex(x => new
        {
            x.Name,
            x.StartsAt,
            x.FromClassId,
            x.ToClassId,
        }).IsUnique();
        builder.HasOne(x => x.FromClass)
            .WithMany()
            .HasForeignKey(x => x.FromClassId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(x => x.ToClass)
            .WithMany()
            .HasForeignKey(x => x.ToClassId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}
