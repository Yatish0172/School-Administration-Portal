using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using SchoolPortal.Domain.Examinations;
using SchoolPortal.Infrastructure.Identity;

namespace SchoolPortal.Infrastructure.Persistence.Configurations;

internal sealed class ExaminationConfiguration
    : IEntityTypeConfiguration<Examination>
{
    public void Configure(EntityTypeBuilder<Examination> builder)
    {
        builder.ToTable("Examinations");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Name).HasMaxLength(150).IsRequired();
        builder.Property(x => x.Term).HasMaxLength(100).IsRequired();
        builder.Property(x => x.Weightage).HasPrecision(6, 2);
        builder.Property(x => x.Status).HasConversion<string>().HasMaxLength(30);
        builder.Property(x => x.Version).IsRowVersion();
        builder.HasIndex(x => new
        {
            x.AcademicYearId,
            x.ClassId,
            x.Name,
        }).IsUnique();
        builder.HasOne(x => x.AcademicYear)
            .WithMany()
            .HasForeignKey(x => x.AcademicYearId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(x => x.Class)
            .WithMany()
            .HasForeignKey(x => x.ClassId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<ApplicationUser>()
            .WithMany()
            .HasForeignKey(x => x.PublishedByUserId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

internal sealed class ExaminationSubjectConfiguration
    : IEntityTypeConfiguration<ExaminationSubject>
{
    public void Configure(EntityTypeBuilder<ExaminationSubject> builder)
    {
        builder.ToTable("ExaminationSubjects");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.MaximumMarks).HasPrecision(8, 2);
        builder.Property(x => x.PassMarks).HasPrecision(8, 2);
        builder.Property(x => x.Weightage).HasPrecision(6, 2);
        builder.Property(x => x.Version).IsRowVersion();
        builder.HasIndex(x => new { x.ExaminationId, x.SubjectId }).IsUnique();
        builder.HasOne(x => x.Examination)
            .WithMany(x => x.Subjects)
            .HasForeignKey(x => x.ExaminationId)
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne(x => x.Subject)
            .WithMany()
            .HasForeignKey(x => x.SubjectId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

internal sealed class GradeRuleConfiguration
    : IEntityTypeConfiguration<GradeRule>
{
    public void Configure(EntityTypeBuilder<GradeRule> builder)
    {
        builder.ToTable("GradeRules");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Grade).HasMaxLength(10).IsRequired();
        builder.Property(x => x.MinimumPercent).HasPrecision(6, 2);
        builder.Property(x => x.MaximumPercent).HasPrecision(6, 2);
        builder.Property(x => x.Points).HasPrecision(6, 2);
        builder.Property(x => x.Description).HasMaxLength(300);
        builder.Property(x => x.Version).IsRowVersion();
        builder.HasIndex(x => new
        {
            x.AcademicYearId,
            x.ClassId,
            x.Grade,
        }).IsUnique();
        builder.HasOne(x => x.AcademicYear)
            .WithMany()
            .HasForeignKey(x => x.AcademicYearId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(x => x.Class)
            .WithMany()
            .HasForeignKey(x => x.ClassId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

internal sealed class StudentMarkConfiguration
    : IEntityTypeConfiguration<StudentMark>
{
    public void Configure(EntityTypeBuilder<StudentMark> builder)
    {
        builder.ToTable("StudentMarks");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.MarksObtained).HasPrecision(8, 2);
        builder.Property(x => x.Grade).HasMaxLength(10);
        builder.Property(x => x.Remarks).HasMaxLength(500);
        builder.Property(x => x.Version).IsRowVersion();
        builder.HasIndex(x => new
        {
            x.ExaminationSubjectId,
            x.StudentEnrollmentId,
        }).IsUnique();
        builder.HasOne(x => x.ExaminationSubject)
            .WithMany(x => x.Marks)
            .HasForeignKey(x => x.ExaminationSubjectId)
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne(x => x.StudentEnrollment)
            .WithMany()
            .HasForeignKey(x => x.StudentEnrollmentId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<ApplicationUser>()
            .WithMany()
            .HasForeignKey(x => x.EnteredByUserId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

internal sealed class ExaminationStatusChangeConfiguration
    : IEntityTypeConfiguration<ExaminationStatusChange>
{
    public void Configure(EntityTypeBuilder<ExaminationStatusChange> builder)
    {
        builder.ToTable("ExaminationStatusChanges");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.OldStatus).HasConversion<string>().HasMaxLength(30);
        builder.Property(x => x.NewStatus).HasConversion<string>().HasMaxLength(30);
        builder.Property(x => x.Reason).HasMaxLength(500);
        builder.HasIndex(x => new { x.ExaminationId, x.ChangedAtUtc });
        builder.HasOne(x => x.Examination)
            .WithMany(x => x.StatusChanges)
            .HasForeignKey(x => x.ExaminationId)
            .OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<ApplicationUser>()
            .WithMany()
            .HasForeignKey(x => x.ChangedByUserId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}
