using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using SchoolPortal.Domain.Academics;
using SchoolPortal.Domain.Students;
using SchoolPortal.Infrastructure.Identity;

namespace SchoolPortal.Infrastructure.Persistence.Configurations;

internal sealed class AcademicYearConfiguration
    : IEntityTypeConfiguration<AcademicYear>
{
    public void Configure(EntityTypeBuilder<AcademicYear> builder)
    {
        builder.ToTable("AcademicYears");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Name).HasMaxLength(20).IsRequired();
        builder.Property(x => x.Status).HasConversion<string>().HasMaxLength(20);
        builder.Property(x => x.Version).IsRowVersion();
        builder.HasIndex(x => x.Name).IsUnique();
        builder.HasIndex(x => x.IsCurrent)
            .IsUnique()
            .HasFilter("\"IsCurrent\" = TRUE");
    }
}

internal sealed class SchoolClassConfiguration
    : IEntityTypeConfiguration<SchoolClass>
{
    public void Configure(EntityTypeBuilder<SchoolClass> builder)
    {
        builder.ToTable("Classes");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Name).HasMaxLength(100).IsRequired();
        builder.Property(x => x.Stream).HasMaxLength(100);
        builder.Property(x => x.Version).IsRowVersion();
        builder.HasIndex(x => new { x.Name, x.Stream }).IsUnique();
    }
}

internal sealed class SectionConfiguration
    : IEntityTypeConfiguration<Section>
{
    public void Configure(EntityTypeBuilder<Section> builder)
    {
        builder.ToTable("Sections");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Name).HasMaxLength(50).IsRequired();
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
            .HasForeignKey(x => x.ClassTeacherUserId)
            .OnDelete(DeleteBehavior.SetNull);
    }
}

internal sealed class SubjectConfiguration
    : IEntityTypeConfiguration<Subject>
{
    public void Configure(EntityTypeBuilder<Subject> builder)
    {
        builder.ToTable("Subjects");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Name).HasMaxLength(150).IsRequired();
        builder.Property(x => x.Code).HasMaxLength(30).IsRequired();
        builder.Property(x => x.Kind).HasConversion<string>().HasMaxLength(20);
        builder.Property(x => x.Component).HasConversion<string>().HasMaxLength(20);
        builder.Property(x => x.MaximumMarks).HasPrecision(8, 2);
        builder.Property(x => x.Version).IsRowVersion();
        builder.HasIndex(x => new { x.ClassId, x.Code }).IsUnique();
        builder.HasOne(x => x.Class)
            .WithMany()
            .HasForeignKey(x => x.ClassId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

internal sealed class TeacherAssignmentConfiguration
    : IEntityTypeConfiguration<TeacherAssignment>
{
    public void Configure(EntityTypeBuilder<TeacherAssignment> builder)
    {
        builder.ToTable("TeacherAssignments");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Version).IsRowVersion();
        builder.HasIndex(x => new
        {
            x.AcademicYearId,
            x.SectionId,
            x.SubjectId,
        }).IsUnique();
        builder.HasOne(x => x.AcademicYear)
            .WithMany()
            .HasForeignKey(x => x.AcademicYearId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(x => x.Class)
            .WithMany()
            .HasForeignKey(x => x.ClassId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(x => x.Section)
            .WithMany()
            .HasForeignKey(x => x.SectionId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(x => x.Subject)
            .WithMany()
            .HasForeignKey(x => x.SubjectId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<ApplicationUser>()
            .WithMany()
            .HasForeignKey(x => x.TeacherUserId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

internal sealed class StudentConfiguration
    : IEntityTypeConfiguration<Student>
{
    public void Configure(EntityTypeBuilder<Student> builder)
    {
        builder.ToTable("Students");
        builder.HasKey(x => x.Id);
        builder.Ignore(x => x.FullName);
        builder.Property(x => x.AdmissionNumber).HasMaxLength(50).IsRequired();
        builder.Property(x => x.FirstName).HasMaxLength(100).IsRequired();
        builder.Property(x => x.MiddleName).HasMaxLength(100);
        builder.Property(x => x.LastName).HasMaxLength(100).IsRequired();
        builder.Property(x => x.Gender).HasMaxLength(30);
        builder.Property(x => x.BloodGroup).HasMaxLength(10);
        builder.Property(x => x.Category).HasMaxLength(50);
        builder.Property(x => x.Religion).HasMaxLength(80);
        builder.Property(x => x.MotherTongue).HasMaxLength(80);
        builder.Property(x => x.Nationality).HasMaxLength(80);
        builder.Property(x => x.AadhaarNumber).HasMaxLength(12);
        builder.Property(x => x.PreviousSchool).HasMaxLength(300);
        builder.Property(x => x.PermanentAddress).HasMaxLength(1000);
        builder.Property(x => x.CorrespondenceAddress).HasMaxLength(1000);
        builder.Property(x => x.City).HasMaxLength(100);
        builder.Property(x => x.State).HasMaxLength(100);
        builder.Property(x => x.PinCode).HasMaxLength(10);
        builder.Property(x => x.Remarks).HasMaxLength(2000);
        builder.Property(x => x.Status).HasConversion<string>().HasMaxLength(40);
        builder.Property(x => x.Version).IsRowVersion();
        builder.HasIndex(x => x.AdmissionNumber).IsUnique();
        builder.HasIndex(x => new { x.LastName, x.FirstName });
    }
}

internal sealed class GuardianConfiguration
    : IEntityTypeConfiguration<Guardian>
{
    public void Configure(EntityTypeBuilder<Guardian> builder)
    {
        builder.ToTable("Guardians");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Relation).HasMaxLength(50).IsRequired();
        builder.Property(x => x.Name).HasMaxLength(200).IsRequired();
        builder.Property(x => x.Phone).HasMaxLength(30).IsRequired();
        builder.Property(x => x.Email).HasMaxLength(254);
        builder.Property(x => x.Occupation).HasMaxLength(150);
        builder.Property(x => x.AnnualIncome).HasPrecision(14, 2);
        builder.HasIndex(x => x.Phone);
        builder.HasOne(x => x.Student)
            .WithMany(x => x.Guardians)
            .HasForeignKey(x => x.StudentId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}

internal sealed class StudentEnrollmentConfiguration
    : IEntityTypeConfiguration<StudentEnrollment>
{
    public void Configure(EntityTypeBuilder<StudentEnrollment> builder)
    {
        builder.ToTable("StudentEnrollments");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Status).HasConversion<string>().HasMaxLength(30);
        builder.Property(x => x.Version).IsRowVersion();
        builder.HasIndex(x => new
        {
            x.StudentId,
            x.AcademicYearId,
        }).IsUnique();
        builder.HasIndex(x => new
        {
            x.AcademicYearId,
            x.SectionId,
            x.RollNumber,
        }).IsUnique();
        builder.HasOne(x => x.Student)
            .WithMany(x => x.Enrollments)
            .HasForeignKey(x => x.StudentId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(x => x.AcademicYear)
            .WithMany()
            .HasForeignKey(x => x.AcademicYearId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(x => x.Class)
            .WithMany()
            .HasForeignKey(x => x.ClassId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(x => x.Section)
            .WithMany()
            .HasForeignKey(x => x.SectionId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}
