using System.Data;
using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Domain.Fees;
using SchoolPortal.Infrastructure.Persistence;
using SchoolPortal.Web.Administration;

namespace SchoolPortal.Web.Fees;

public sealed record FeePaymentRequest(
    Guid StudentEnrollmentId,
    DateOnly PaymentDate,
    FeePaymentMode Mode,
    string? Reference,
    string? BankName,
    string? Remarks,
    decimal Amount,
    string IdempotencyKey);

public sealed record FeePaymentResult(
    Guid PaymentId,
    string ReceiptNumber,
    bool IsReplay);

public sealed class FeePostingService(
    SchoolPortalDbContext dbContext,
    AuditWriter auditWriter,
    IHttpContextAccessor httpContextAccessor)
{
    public async Task<FeePaymentResult> PostAsync(
        FeePaymentRequest request,
        CancellationToken cancellationToken)
    {
        Validate(request);
        var userId = CurrentUserId();

        await using var transaction = await dbContext.Database.BeginTransactionAsync(
            IsolationLevel.Serializable,
            cancellationToken);
        await dbContext.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({request.IdempotencyKey}, 0))",
            cancellationToken);

        var existing = await dbContext.Set<FeePayment>()
            .Include(x => x.Receipt)
            .SingleOrDefaultAsync(
                x => x.IdempotencyKey == request.IdempotencyKey,
                cancellationToken);
        if (existing is not null)
        {
            EnsureReplayMatches(existing, request);
            await transaction.CommitAsync(cancellationToken);
            return new FeePaymentResult(
                existing.Id,
                existing.Receipt.ReceiptNumber,
                true);
        }

        await dbContext.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({request.StudentEnrollmentId.ToString()}, 0))",
            cancellationToken);

        var enrollmentExists = await dbContext.Set<Domain.Students.StudentEnrollment>()
            .AnyAsync(
                x => x.Id == request.StudentEnrollmentId
                    && x.Status == Domain.Students.EnrollmentStatus.Active,
                cancellationToken);
        if (!enrollmentExists)
        {
            throw new InvalidOperationException(
                "Choose an active student enrollment.");
        }

        var charges = await dbContext.Set<StudentCharge>()
            .Where(x =>
                x.StudentEnrollmentId == request.StudentEnrollmentId
                && x.Status == StudentChargeStatus.Active)
            .Include(x => x.Concessions)
            .Include(x => x.PaymentAllocations)
                .ThenInclude(x => x.FeePayment)
            .OrderBy(x => x.DueDate)
            .ThenBy(x => x.CreatedAtUtc)
            .ToListAsync(cancellationToken);

        var balances = charges
            .Select(charge => new
            {
                Charge = charge,
                Balance = FeeBalanceCalculator.Outstanding(charge),
            })
            .Where(x => x.Balance > 0)
            .ToList();
        var totalOutstanding = balances.Sum(x => x.Balance);
        if (request.Amount > totalOutstanding)
        {
            throw new InvalidOperationException(
                $"The payment exceeds the outstanding balance of {totalOutstanding:N2}.");
        }

        var sequence = await dbContext.Database
            .SqlQuery<long>(
                $"SELECT nextval('portal.\"FeeReceiptNumberSequence\"') AS \"Value\"")
            .SingleAsync(cancellationToken);
        var receiptNumber = $"RCP-{request.PaymentDate.Year}-{sequence:D6}";
        var payment = new FeePayment
        {
            StudentEnrollmentId = request.StudentEnrollmentId,
            PaymentDate = request.PaymentDate,
            Mode = request.Mode,
            Reference = Clean(request.Reference),
            BankName = Clean(request.BankName),
            Remarks = Clean(request.Remarks),
            Amount = request.Amount,
            IdempotencyKey = request.IdempotencyKey.Trim(),
            PostedByUserId = userId,
            Receipt = new FeeReceipt
            {
                ReceiptNumber = receiptNumber,
            },
        };

        var remaining = request.Amount;
        foreach (var item in balances)
        {
            if (remaining <= 0)
            {
                break;
            }

            var allocated = Math.Min(remaining, item.Balance);
            payment.Allocations.Add(new FeePaymentAllocation
            {
                StudentChargeId = item.Charge.Id,
                Amount = allocated,
            });
            remaining -= allocated;
        }

        if (remaining != 0)
        {
            throw new InvalidOperationException(
                "The payment could not be allocated completely. Reload and try again.");
        }

        dbContext.Add(payment);
        auditWriter.Add(
            "fee.payment.posted",
            nameof(FeePayment),
            payment.Id,
            null,
            new
            {
                payment.StudentEnrollmentId,
                payment.PaymentDate,
                payment.Mode,
                payment.Reference,
                payment.Amount,
                ReceiptNumber = receiptNumber,
                Allocations = payment.Allocations.Select(x => new
                {
                    x.StudentChargeId,
                    x.Amount,
                }),
            });
        await dbContext.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new FeePaymentResult(payment.Id, receiptNumber, false);
    }

    public async Task ReverseAsync(
        Guid paymentId,
        string reason,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(reason) || reason.Trim().Length < 5)
        {
            throw new InvalidOperationException(
                "Enter a reversal reason of at least five characters.");
        }

        var userId = CurrentUserId();
        await using var transaction = await dbContext.Database.BeginTransactionAsync(
            IsolationLevel.Serializable,
            cancellationToken);
        await dbContext.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({paymentId.ToString()}, 0))",
            cancellationToken);

        var payment = await dbContext.Set<FeePayment>()
            .AsNoTracking()
            .Include(x => x.Receipt)
            .Include(x => x.Reversal)
            .SingleOrDefaultAsync(x => x.Id == paymentId, cancellationToken);
        if (payment is null)
        {
            throw new InvalidOperationException("The payment no longer exists.");
        }

        if (payment.Status == FeePaymentStatus.Reversed
            || payment.Reversal is not null)
        {
            throw new InvalidOperationException(
                "That payment has already been reversed.");
        }

        var updated = await dbContext.Set<FeePayment>()
            .Where(x =>
                x.Id == payment.Id
                && x.Status == FeePaymentStatus.Posted)
            .ExecuteUpdateAsync(
                setters => setters.SetProperty(
                    x => x.Status,
                    FeePaymentStatus.Reversed),
                cancellationToken);
        if (updated != 1)
        {
            throw new InvalidOperationException(
                "That payment was changed by another user. Reload and try again.");
        }

        dbContext.Add(new FeePaymentReversal
        {
            FeePaymentId = payment.Id,
            Reason = reason.Trim(),
            ReversedByUserId = userId,
        });
        auditWriter.Add(
            "fee.payment.reversed",
            nameof(FeePayment),
            payment.Id,
            new
            {
                Status = FeePaymentStatus.Posted,
                payment.Amount,
                payment.Receipt.ReceiptNumber,
            },
            new
            {
                Status = FeePaymentStatus.Reversed,
                Reason = reason.Trim(),
            });
        await dbContext.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    private static void Validate(FeePaymentRequest request)
    {
        if (request.StudentEnrollmentId == Guid.Empty)
        {
            throw new InvalidOperationException("Choose a student.");
        }

        if (request.Amount <= 0)
        {
            throw new InvalidOperationException(
                "Enter a payment amount greater than zero.");
        }

        if (string.IsNullOrWhiteSpace(request.IdempotencyKey)
            || request.IdempotencyKey.Trim().Length < 8)
        {
            throw new InvalidOperationException(
                "The payment safety key is missing. Reload and try again.");
        }

        if (request.Mode != FeePaymentMode.Cash
            && string.IsNullOrWhiteSpace(request.Reference))
        {
            throw new InvalidOperationException(
                "Enter the cheque, UPI, card, or bank reference.");
        }
    }

    private static void EnsureReplayMatches(
        FeePayment existing,
        FeePaymentRequest request)
    {
        if (existing.StudentEnrollmentId != request.StudentEnrollmentId
            || existing.PaymentDate != request.PaymentDate
            || existing.Mode != request.Mode
            || existing.Amount != request.Amount
            || !string.Equals(
                existing.Reference,
                Clean(request.Reference),
                StringComparison.Ordinal)
            || !string.Equals(
                existing.BankName,
                Clean(request.BankName),
                StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                "That payment safety key was already used with different details.");
        }
    }

    private Guid CurrentUserId()
    {
        var value = httpContextAccessor.HttpContext?.User.FindFirstValue(
            ClaimTypes.NameIdentifier);
        return Guid.TryParse(value, out var userId)
            ? userId
            : throw new InvalidOperationException(
                "A signed-in user is required for financial transactions.");
    }

    private static string? Clean(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
