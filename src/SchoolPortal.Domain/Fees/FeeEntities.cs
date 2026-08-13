using SchoolPortal.Domain.Academics;
using SchoolPortal.Domain.Students;

namespace SchoolPortal.Domain.Fees;

public enum FeePaymentMode
{
    Cash = 1,
    Cheque = 2,
    Upi = 3,
    BankTransfer = 4,
    Card = 5,
    DemandDraft = 6,
}

public enum StudentChargeStatus
{
    Active = 1,
    Cancelled = 2,
}

public enum FeePaymentStatus
{
    Posted = 1,
    Reversed = 2,
}

public sealed class FeeHead
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public string Code { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public string? Description { get; set; }

    public bool IsRefundable { get; set; }

    public bool IsActive { get; set; } = true;

    public int SortOrder { get; set; }

    public uint Version { get; set; }

    public ICollection<FeePlanItem> PlanItems { get; set; } = [];

    public ICollection<StudentCharge> Charges { get; set; } = [];
}

public sealed class FeePlan
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid AcademicYearId { get; set; }

    public AcademicYear AcademicYear { get; set; } = null!;

    public Guid ClassId { get; set; }

    public SchoolClass Class { get; set; } = null!;

    public string Name { get; set; } = string.Empty;

    public bool IsActive { get; set; } = true;

    public DateTimeOffset CreatedAtUtc { get; set; } = DateTimeOffset.UtcNow;

    public uint Version { get; set; }

    public ICollection<FeePlanItem> Items { get; set; } = [];
}

public sealed class FeePlanItem
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid FeePlanId { get; set; }

    public FeePlan FeePlan { get; set; } = null!;

    public Guid FeeHeadId { get; set; }

    public FeeHead FeeHead { get; set; } = null!;

    public string Period { get; set; } = string.Empty;

    public decimal Amount { get; set; }

    public DateOnly DueDate { get; set; }

    public uint Version { get; set; }

    public ICollection<StudentCharge> Charges { get; set; } = [];
}

public sealed class StudentCharge
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid StudentEnrollmentId { get; set; }

    public StudentEnrollment StudentEnrollment { get; set; } = null!;

    public Guid FeeHeadId { get; set; }

    public FeeHead FeeHead { get; set; } = null!;

    public Guid? FeePlanItemId { get; set; }

    public FeePlanItem? FeePlanItem { get; set; }

    public string Description { get; set; } = string.Empty;

    public string Period { get; set; } = string.Empty;

    public decimal Amount { get; set; }

    public DateOnly DueDate { get; set; }

    public StudentChargeStatus Status { get; set; } = StudentChargeStatus.Active;

    public Guid CreatedByUserId { get; set; }

    public DateTimeOffset CreatedAtUtc { get; set; } = DateTimeOffset.UtcNow;

    public uint Version { get; set; }

    public ICollection<FeeConcession> Concessions { get; set; } = [];

    public ICollection<FeePaymentAllocation> PaymentAllocations { get; set; } = [];
}

public sealed class FeeConcession
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid StudentChargeId { get; set; }

    public StudentCharge StudentCharge { get; set; } = null!;

    public decimal Amount { get; set; }

    public string Reason { get; set; } = string.Empty;

    public Guid ApprovedByUserId { get; set; }

    public DateTimeOffset ApprovedAtUtc { get; set; } = DateTimeOffset.UtcNow;
}

public sealed class FeePayment
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid StudentEnrollmentId { get; set; }

    public StudentEnrollment StudentEnrollment { get; set; } = null!;

    public DateOnly PaymentDate { get; set; }

    public FeePaymentMode Mode { get; set; }

    public string? Reference { get; set; }

    public string? BankName { get; set; }

    public string? Remarks { get; set; }

    public decimal Amount { get; set; }

    public FeePaymentStatus Status { get; set; } = FeePaymentStatus.Posted;

    public string IdempotencyKey { get; set; } = string.Empty;

    public Guid PostedByUserId { get; set; }

    public DateTimeOffset PostedAtUtc { get; set; } = DateTimeOffset.UtcNow;

    public uint Version { get; set; }

    public ICollection<FeePaymentAllocation> Allocations { get; set; } = [];

    public FeeReceipt Receipt { get; set; } = null!;

    public FeePaymentReversal? Reversal { get; set; }
}

public sealed class FeePaymentAllocation
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid FeePaymentId { get; set; }

    public FeePayment FeePayment { get; set; } = null!;

    public Guid StudentChargeId { get; set; }

    public StudentCharge StudentCharge { get; set; } = null!;

    public decimal Amount { get; set; }
}

public sealed class FeeReceipt
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid FeePaymentId { get; set; }

    public FeePayment FeePayment { get; set; } = null!;

    public string ReceiptNumber { get; set; } = string.Empty;

    public DateTimeOffset IssuedAtUtc { get; set; } = DateTimeOffset.UtcNow;

    public int PrintCount { get; set; }

    public DateTimeOffset? LastPrintedAtUtc { get; set; }
}

public sealed class FeePaymentReversal
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid FeePaymentId { get; set; }

    public FeePayment FeePayment { get; set; } = null!;

    public string Reason { get; set; } = string.Empty;

    public Guid ReversedByUserId { get; set; }

    public DateTimeOffset ReversedAtUtc { get; set; } = DateTimeOffset.UtcNow;
}
