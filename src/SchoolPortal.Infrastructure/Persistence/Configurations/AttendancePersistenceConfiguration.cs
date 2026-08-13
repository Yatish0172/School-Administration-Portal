using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using SchoolPortal.Domain.Attendance;
using SchoolPortal.Infrastructure.Identity;

namespace SchoolPortal.Infrastructure.Persistence.Configurations;

internal sealed class AttendanceSessionConfiguration
    : IEntityTypeConfiguration<AttendanceSession>
{
    public void Configure(EntityTypeBuilder<AttendanceSession> builder)
    {
        builder.ToTable("AttendanceSessions");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Version).IsRowVersion();
        builder.HasIndex(x => new
        {
            x.AcademicYearId,
            x.SectionId,
            x.Date,
            x.PeriodNumber,
        }).IsUnique();
        builder.HasOne(x => x.AcademicYear)
            .WithMany()
            .HasForeignKey(x => x.AcademicYearId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(x => x.Section)
            .WithMany()
            .HasForeignKey(x => x.SectionId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<ApplicationUser>()
            .WithMany()
            .HasForeignKey(x => x.MarkedByUserId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

internal sealed class AttendanceEntryConfiguration
    : IEntityTypeConfiguration<AttendanceEntry>
{
    public void Configure(EntityTypeBuilder<AttendanceEntry> builder)
    {
        builder.ToTable("AttendanceEntries");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Status).HasConversion<string>().HasMaxLength(20);
        builder.Property(x => x.Reason).HasMaxLength(500);
        builder.Property(x => x.Version).IsRowVersion();
        builder.HasIndex(x => new
        {
            x.AttendanceSessionId,
            x.StudentEnrollmentId,
        }).IsUnique();
        builder.HasOne(x => x.Session)
            .WithMany(x => x.Entries)
            .HasForeignKey(x => x.AttendanceSessionId)
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne(x => x.StudentEnrollment)
            .WithMany()
            .HasForeignKey(x => x.StudentEnrollmentId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<ApplicationUser>()
            .WithMany()
            .HasForeignKey(x => x.MarkedByUserId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

internal sealed class AttendanceCorrectionConfiguration
    : IEntityTypeConfiguration<AttendanceCorrection>
{
    public void Configure(EntityTypeBuilder<AttendanceCorrection> builder)
    {
        builder.ToTable("AttendanceCorrections");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.OldStatus).HasConversion<string>().HasMaxLength(20);
        builder.Property(x => x.NewStatus).HasConversion<string>().HasMaxLength(20);
        builder.Property(x => x.Reason).HasMaxLength(500).IsRequired();
        builder.HasIndex(x => new
        {
            x.AttendanceEntryId,
            x.CorrectedAtUtc,
        });
        builder.HasOne(x => x.AttendanceEntry)
            .WithMany(x => x.Corrections)
            .HasForeignKey(x => x.AttendanceEntryId)
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<ApplicationUser>()
            .WithMany()
            .HasForeignKey(x => x.CorrectedByUserId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}
