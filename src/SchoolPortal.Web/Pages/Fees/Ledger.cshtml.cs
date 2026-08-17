using System.ComponentModel.DataAnnotations;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Fees;
using SchoolPortal.Domain.Students;
using SchoolPortal.Infrastructure.Persistence;
using SchoolPortal.Web.Administration;
using SchoolPortal.Web.Fees;

namespace SchoolPortal.Web.Pages.Fees;

[Authorize(Policy = PermissionCatalog.PolicyPrefix + PermissionCatalog.Fees.View)]
public sealed class LedgerModel(
    SchoolPortalDbContext dbContext,
    FeePostingService postingService,
    AuditWriter auditWriter) : PageModel
{
    [BindProperty(SupportsGet = true)]
    public Guid? EnrollmentId { get; set; }

    [BindProperty]
    public DirectChargeInput NewCharge { get; set; } = new();

    [BindProperty]
    public ConcessionInput NewConcession { get; set; } = new();

    [BindProperty]
    public PaymentInput Payment { get; set; } = new();

    [BindProperty]
    public string ReversalReason { get; set; } = string.Empty;

    [TempData]
    public string? StatusMessage { get; set; }

    public IReadOnlyList<StudentEnrollment> Enrollments { get; private set; } = [];

    public IReadOnlyList<FeeHead> Heads { get; private set; } = [];

    public StudentEnrollment? SelectedEnrollment { get; private set; }

    public IReadOnlyList<ChargeRow> Charges { get; private set; } = [];

    public IReadOnlyList<FeePayment> Payments { get; private set; } = [];

    public decimal TotalCharged => Charges.Sum(x => x.Amount);

    public decimal TotalConcessions => Charges.Sum(x => x.Concession);

    public decimal TotalPaid => Charges.Sum(x => x.Paid);

    public decimal TotalOutstanding => Charges.Sum(x => x.Outstanding);

    public bool CanConfigure => User.HasClaim(
        PermissionCatalog.ClaimType,
        PermissionCatalog.Fees.Configure);

    public bool CanPost => User.HasClaim(
        PermissionCatalog.ClaimType,
        PermissionCatalog.Fees.PostPayment);

    public bool CanReverse => User.HasClaim(
        PermissionCatalog.ClaimType,
        PermissionCatalog.Fees.ReversePayment);

    public async Task OnGetAsync(CancellationToken cancellationToken)
    {
        Payment.PaymentDate = DateOnly.FromDateTime(DateTime.Today);
        Payment.IdempotencyKey = Guid.NewGuid().ToString("N");
        await LoadAsync(cancellationToken);
    }

    public async Task<IActionResult> OnPostAddChargeAsync(
        CancellationToken cancellationToken)
    {
        if (!CanConfigure)
        {
            return Forbid();
        }

        EnrollmentId = NewCharge.StudentEnrollmentId;
        ModelState.Clear();
        if (!TryValidateModel(NewCharge, nameof(NewCharge)))
        {
            await LoadAsync(cancellationToken);
            return Page();
        }

        var enrollmentExists = await dbContext.Set<StudentEnrollment>()
            .AnyAsync(
                x => x.Id == NewCharge.StudentEnrollmentId
                    && x.Status == EnrollmentStatus.Active,
                cancellationToken);
        var headExists = await dbContext.Set<FeeHead>()
            .AnyAsync(
                x => x.Id == NewCharge.FeeHeadId && x.IsActive,
                cancellationToken);
        if (!enrollmentExists || !headExists)
        {
            return NotFound();
        }

        var charge = new StudentCharge
        {
            StudentEnrollmentId = NewCharge.StudentEnrollmentId,
            FeeHeadId = NewCharge.FeeHeadId,
            Description = NewCharge.Description.Trim(),
            Period = NewCharge.Period.Trim(),
            Amount = NewCharge.Amount,
            DueDate = NewCharge.DueDate,
            CreatedByUserId = CurrentUserId(),
        };
        dbContext.Add(charge);
        auditWriter.Add(
            "fee.charge.created",
            nameof(StudentCharge),
            charge.Id,
            null,
            new
            {
                charge.StudentEnrollmentId,
                charge.FeeHeadId,
                charge.Description,
                charge.Period,
                charge.Amount,
                charge.DueDate,
            });
        await dbContext.SaveChangesAsync(cancellationToken);
        StatusMessage = "Student charge added.";
        return RedirectToPage(new { EnrollmentId });
    }

    public async Task<IActionResult> OnPostAddConcessionAsync(
        CancellationToken cancellationToken)
    {
        if (!CanConfigure)
        {
            return Forbid();
        }

        EnrollmentId = NewConcession.StudentEnrollmentId;
        ModelState.Clear();
        if (!TryValidateModel(NewConcession, nameof(NewConcession)))
        {
            await LoadAsync(cancellationToken);
            return Page();
        }

        var charge = await dbContext.Set<StudentCharge>()
            .Include(x => x.Concessions)
            .Include(x => x.PaymentAllocations)
                .ThenInclude(x => x.FeePayment)
            .SingleOrDefaultAsync(
                x => x.Id == NewConcession.StudentChargeId
                    && x.StudentEnrollmentId == NewConcession.StudentEnrollmentId
                    && x.Status == StudentChargeStatus.Active,
                cancellationToken);
        if (charge is null)
        {
            return NotFound();
        }

        var outstanding = FeeBalanceCalculator.Outstanding(charge);
        if (NewConcession.Amount > outstanding)
        {
            ModelState.AddModelError(
                string.Empty,
                $"The concession cannot exceed the outstanding balance of {outstanding:N2}.");
            await LoadAsync(cancellationToken);
            return Page();
        }

        var concession = new FeeConcession
        {
            StudentChargeId = charge.Id,
            Amount = NewConcession.Amount,
            Reason = NewConcession.Reason.Trim(),
            ApprovedByUserId = CurrentUserId(),
        };
        dbContext.Add(concession);
        auditWriter.Add(
            "fee.concession.approved",
            nameof(FeeConcession),
            concession.Id,
            null,
            new
            {
                concession.StudentChargeId,
                concession.Amount,
                concession.Reason,
            });
        await dbContext.SaveChangesAsync(cancellationToken);
        StatusMessage = "Concession recorded with approval details.";
        return RedirectToPage(new { EnrollmentId });
    }

    public async Task<IActionResult> OnPostPaymentAsync(
        CancellationToken cancellationToken)
    {
        if (!CanPost)
        {
            return Forbid();
        }

        EnrollmentId = Payment.StudentEnrollmentId;
        ModelState.Clear();
        if (!TryValidateModel(Payment, nameof(Payment)))
        {
            await LoadAsync(cancellationToken);
            return Page();
        }

        try
        {
            var result = await postingService.PostAsync(
                new FeePaymentRequest(
                    Payment.StudentEnrollmentId,
                    Payment.PaymentDate,
                    Payment.Mode,
                    Payment.Reference,
                    Payment.BankName,
                    Payment.Remarks,
                    Payment.Amount,
                    Payment.IdempotencyKey),
                cancellationToken);
            StatusMessage = result.IsReplay
                ? $"Payment was already recorded as {result.ReceiptNumber}."
                : $"Payment posted. Receipt {result.ReceiptNumber} issued.";
            return RedirectToPage(
                "/Fees/Receipt",
                new { number = result.ReceiptNumber });
        }
        catch (InvalidOperationException exception)
        {
            ModelState.AddModelError(string.Empty, exception.Message);
            await LoadAsync(cancellationToken);
            return Page();
        }
    }

    public async Task<IActionResult> OnPostReverseAsync(
        Guid paymentId,
        Guid enrollmentId,
        CancellationToken cancellationToken)
    {
        if (!CanReverse)
        {
            return Forbid();
        }

        EnrollmentId = enrollmentId;
        try
        {
            await postingService.ReverseAsync(
                paymentId,
                ReversalReason,
                cancellationToken);
            StatusMessage = "Payment reversed. The original receipt and allocations remain on record.";
            return RedirectToPage(new { EnrollmentId });
        }
        catch (InvalidOperationException exception)
        {
            ModelState.AddModelError(string.Empty, exception.Message);
            await LoadAsync(cancellationToken);
            return Page();
        }
    }

    private async Task LoadAsync(CancellationToken cancellationToken)
    {
        Enrollments = await dbContext.Set<StudentEnrollment>()
            .AsNoTracking()
            .Where(x => x.Status == EnrollmentStatus.Active)
            .Include(x => x.Student)
            .Include(x => x.AcademicYear)
            .Include(x => x.Class)
            .Include(x => x.Section)
            .OrderByDescending(x => x.AcademicYear.IsCurrent)
            .ThenBy(x => x.Class.SortOrder)
            .ThenBy(x => x.Section.Name)
            .ThenBy(x => x.Student.AdmissionNumber)
            .Take(1000)
            .ToListAsync(cancellationToken);
        SelectedEnrollment = Enrollments.FirstOrDefault(x => x.Id == EnrollmentId);
        Heads = await dbContext.Set<FeeHead>()
            .AsNoTracking()
            .Where(x => x.IsActive)
            .OrderBy(x => x.SortOrder)
            .ThenBy(x => x.Name)
            .ToListAsync(cancellationToken);
        if (SelectedEnrollment is null)
        {
            Charges = [];
            Payments = [];
            return;
        }

        EnrollmentId = SelectedEnrollment.Id;
        var charges = await dbContext.Set<StudentCharge>()
            .AsNoTracking()
            .Where(x => x.StudentEnrollmentId == SelectedEnrollment.Id)
            .Include(x => x.FeeHead)
            .Include(x => x.Concessions)
            .Include(x => x.PaymentAllocations)
                .ThenInclude(x => x.FeePayment)
            .OrderBy(x => x.DueDate)
            .ThenBy(x => x.CreatedAtUtc)
            .ToListAsync(cancellationToken);
        Charges = charges.Select(x => new ChargeRow(
            x,
            FeeBalanceCalculator.ConcessionTotal(x),
            FeeBalanceCalculator.PaidTotal(x),
            FeeBalanceCalculator.Outstanding(x))).ToList();
        Payments = await dbContext.Set<FeePayment>()
            .AsNoTracking()
            .Where(x => x.StudentEnrollmentId == SelectedEnrollment.Id)
            .Include(x => x.Receipt)
            .Include(x => x.Reversal)
            .OrderByDescending(x => x.PostedAtUtc)
            .ToListAsync(cancellationToken);
        if (Payment.StudentEnrollmentId == Guid.Empty)
        {
            Payment.StudentEnrollmentId = SelectedEnrollment.Id;
        }

        if (string.IsNullOrWhiteSpace(Payment.IdempotencyKey))
        {
            Payment.IdempotencyKey = Guid.NewGuid().ToString("N");
        }

        if (Payment.PaymentDate == default)
        {
            Payment.PaymentDate = DateOnly.FromDateTime(DateTime.Today);
        }
    }

    private Guid CurrentUserId()
    {
        var value = User.FindFirstValue(ClaimTypes.NameIdentifier);
        return Guid.TryParse(value, out var userId)
            ? userId
            : throw new InvalidOperationException("A signed-in user is required.");
    }

    public sealed record ChargeRow(
        StudentCharge Charge,
        decimal Concession,
        decimal Paid,
        decimal Outstanding)
    {
        public decimal Amount => Charge.Amount;
    }

    public sealed class DirectChargeInput
    {
        [Required]
        public Guid StudentEnrollmentId { get; set; }

        [Required]
        public Guid FeeHeadId { get; set; }

        [Required, StringLength(250)]
        public string Description { get; set; } = string.Empty;

        [Required, StringLength(100)]
        public string Period { get; set; } = string.Empty;

        [Range(typeof(decimal), "0.01", "9999999999")]
        public decimal Amount { get; set; }

        [Required]
        public DateOnly DueDate { get; set; }
    }

    public sealed class ConcessionInput
    {
        [Required]
        public Guid StudentEnrollmentId { get; set; }

        [Required]
        public Guid StudentChargeId { get; set; }

        [Range(typeof(decimal), "0.01", "9999999999")]
        public decimal Amount { get; set; }

        [Required, StringLength(500, MinimumLength = 3)]
        public string Reason { get; set; } = string.Empty;
    }

    public sealed class PaymentInput
    {
        [Required]
        public Guid StudentEnrollmentId { get; set; }

        [Required]
        public DateOnly PaymentDate { get; set; }

        [Required]
        public FeePaymentMode Mode { get; set; } = FeePaymentMode.Cash;

        [StringLength(150)]
        public string? Reference { get; set; }

        [StringLength(150)]
        public string? BankName { get; set; }

        [StringLength(500)]
        public string? Remarks { get; set; }

        [Range(typeof(decimal), "0.01", "9999999999")]
        public decimal Amount { get; set; }

        [Required, StringLength(100, MinimumLength = 8)]
        public string IdempotencyKey { get; set; } = string.Empty;
    }
}
