using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using SchoolPortal.Domain.Fees;
using SchoolPortal.Infrastructure.Identity;

namespace SchoolPortal.Infrastructure.Persistence.Configurations;

internal sealed class FeeHeadConfiguration : IEntityTypeConfiguration<FeeHead>
{
    public void Configure(EntityTypeBuilder<FeeHead> builder)
    {
        builder.ToTable("FeeHeads");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Code).HasMaxLength(30).IsRequired();
        builder.Property(x => x.Name).HasMaxLength(150).IsRequired();
        builder.Property(x => x.Description).HasMaxLength(500);
        builder.Property(x => x.Version).IsRowVersion();
        builder.HasIndex(x => x.Code).IsUnique();
        builder.HasIndex(x => x.Name).IsUnique();
    }
}

internal sealed class FeePlanConfiguration : IEntityTypeConfiguration<FeePlan>
{
    public void Configure(EntityTypeBuilder<FeePlan> builder)
    {
        builder.ToTable("FeePlans");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Name).HasMaxLength(150).IsRequired();
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
    }
}

internal sealed class FeePlanItemConfiguration
    : IEntityTypeConfiguration<FeePlanItem>
{
    public void Configure(EntityTypeBuilder<FeePlanItem> builder)
    {
        builder.ToTable("FeePlanItems");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Period).HasMaxLength(100).IsRequired();
        builder.Property(x => x.Amount).HasPrecision(14, 2);
        builder.Property(x => x.Version).IsRowVersion();
        builder.HasIndex(x => new
        {
            x.FeePlanId,
            x.FeeHeadId,
            x.Period,
            x.DueDate,
        }).IsUnique();
        builder.HasOne(x => x.FeePlan)
            .WithMany(x => x.Items)
            .HasForeignKey(x => x.FeePlanId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(x => x.FeeHead)
            .WithMany(x => x.PlanItems)
            .HasForeignKey(x => x.FeeHeadId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

internal sealed class StudentChargeConfiguration
    : IEntityTypeConfiguration<StudentCharge>
{
    public void Configure(EntityTypeBuilder<StudentCharge> builder)
    {
        builder.ToTable("StudentCharges");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Description).HasMaxLength(250).IsRequired();
        builder.Property(x => x.Period).HasMaxLength(100).IsRequired();
        builder.Property(x => x.Amount).HasPrecision(14, 2);
        builder.Property(x => x.Status).HasConversion<string>().HasMaxLength(30);
        builder.Property(x => x.Version).IsRowVersion();
        builder.HasIndex(x => new
        {
            x.StudentEnrollmentId,
            x.FeePlanItemId,
        }).IsUnique();
        builder.HasIndex(x => new
        {
            x.StudentEnrollmentId,
            x.DueDate,
        });
        builder.HasOne(x => x.StudentEnrollment)
            .WithMany()
            .HasForeignKey(x => x.StudentEnrollmentId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(x => x.FeeHead)
            .WithMany(x => x.Charges)
            .HasForeignKey(x => x.FeeHeadId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(x => x.FeePlanItem)
            .WithMany(x => x.Charges)
            .HasForeignKey(x => x.FeePlanItemId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<ApplicationUser>()
            .WithMany()
            .HasForeignKey(x => x.CreatedByUserId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

internal sealed class FeeConcessionConfiguration
    : IEntityTypeConfiguration<FeeConcession>
{
    public void Configure(EntityTypeBuilder<FeeConcession> builder)
    {
        builder.ToTable("FeeConcessions");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Amount).HasPrecision(14, 2);
        builder.Property(x => x.Reason).HasMaxLength(500).IsRequired();
        builder.HasIndex(x => x.StudentChargeId);
        builder.HasOne(x => x.StudentCharge)
            .WithMany(x => x.Concessions)
            .HasForeignKey(x => x.StudentChargeId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<ApplicationUser>()
            .WithMany()
            .HasForeignKey(x => x.ApprovedByUserId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

internal sealed class FeePaymentConfiguration
    : IEntityTypeConfiguration<FeePayment>
{
    public void Configure(EntityTypeBuilder<FeePayment> builder)
    {
        builder.ToTable("FeePayments");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Mode).HasConversion<string>().HasMaxLength(30);
        builder.Property(x => x.Reference).HasMaxLength(150);
        builder.Property(x => x.BankName).HasMaxLength(150);
        builder.Property(x => x.Remarks).HasMaxLength(500);
        builder.Property(x => x.Amount).HasPrecision(14, 2);
        builder.Property(x => x.Status).HasConversion<string>().HasMaxLength(30);
        builder.Property(x => x.IdempotencyKey).HasMaxLength(100).IsRequired();
        builder.Property(x => x.Version).IsRowVersion();
        builder.HasIndex(x => x.IdempotencyKey).IsUnique();
        builder.HasIndex(x => new
        {
            x.StudentEnrollmentId,
            x.PaymentDate,
        });
        builder.HasOne(x => x.StudentEnrollment)
            .WithMany()
            .HasForeignKey(x => x.StudentEnrollmentId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<ApplicationUser>()
            .WithMany()
            .HasForeignKey(x => x.PostedByUserId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

internal sealed class FeePaymentAllocationConfiguration
    : IEntityTypeConfiguration<FeePaymentAllocation>
{
    public void Configure(EntityTypeBuilder<FeePaymentAllocation> builder)
    {
        builder.ToTable("FeePaymentAllocations");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Amount).HasPrecision(14, 2);
        builder.HasIndex(x => new
        {
            x.FeePaymentId,
            x.StudentChargeId,
        }).IsUnique();
        builder.HasOne(x => x.FeePayment)
            .WithMany(x => x.Allocations)
            .HasForeignKey(x => x.FeePaymentId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(x => x.StudentCharge)
            .WithMany(x => x.PaymentAllocations)
            .HasForeignKey(x => x.StudentChargeId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

internal sealed class FeeReceiptConfiguration
    : IEntityTypeConfiguration<FeeReceipt>
{
    public void Configure(EntityTypeBuilder<FeeReceipt> builder)
    {
        builder.ToTable("FeeReceipts");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.ReceiptNumber).HasMaxLength(40).IsRequired();
        builder.HasIndex(x => x.FeePaymentId).IsUnique();
        builder.HasIndex(x => x.ReceiptNumber).IsUnique();
        builder.HasOne(x => x.FeePayment)
            .WithOne(x => x.Receipt)
            .HasForeignKey<FeeReceipt>(x => x.FeePaymentId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

internal sealed class FeePaymentReversalConfiguration
    : IEntityTypeConfiguration<FeePaymentReversal>
{
    public void Configure(EntityTypeBuilder<FeePaymentReversal> builder)
    {
        builder.ToTable("FeePaymentReversals");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Reason).HasMaxLength(500).IsRequired();
        builder.HasIndex(x => x.FeePaymentId).IsUnique();
        builder.HasOne(x => x.FeePayment)
            .WithOne(x => x.Reversal)
            .HasForeignKey<FeePaymentReversal>(x => x.FeePaymentId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<ApplicationUser>()
            .WithMany()
            .HasForeignKey(x => x.ReversedByUserId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}
