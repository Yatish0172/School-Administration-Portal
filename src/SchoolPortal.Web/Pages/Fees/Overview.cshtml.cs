using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Fees;
using SchoolPortal.Infrastructure.Persistence;
using SchoolPortal.Web.Fees;

namespace SchoolPortal.Web.Pages.Fees;

[Authorize(Policy = PermissionCatalog.PolicyPrefix + PermissionCatalog.Fees.View)]
public sealed class OverviewModel(
    SchoolPortalDbContext dbContext) : PageModel
{
    public decimal CollectedToday { get; private set; }
    public decimal ReversedToday { get; private set; }
    public int PaymentCountToday { get; private set; }
    public decimal TotalOutstanding { get; private set; }
    public int StudentsWithBalance { get; private set; }
    public int OverdueStudents { get; private set; }
    public IReadOnlyList<RecentPaymentRow> RecentPayments { get; private set; } = [];

    public bool CanPost => User.HasClaim(
        PermissionCatalog.ClaimType,
        PermissionCatalog.Fees.PostPayment);

    public async Task OnGetAsync(CancellationToken cancellationToken)
    {
        var today = DateOnly.FromDateTime(DateTime.Today);
        var todayPayments = await dbContext.Set<FeePayment>()
            .AsNoTracking()
            .Where(x => x.PaymentDate == today)
            .Select(x => new { x.Amount, x.Status })
            .ToListAsync(cancellationToken);
        CollectedToday = todayPayments.Where(x => x.Status == FeePaymentStatus.Posted).Sum(x => x.Amount);
        ReversedToday = todayPayments.Where(x => x.Status == FeePaymentStatus.Reversed).Sum(x => x.Amount);
        PaymentCountToday = todayPayments.Count(x => x.Status == FeePaymentStatus.Posted);

        var charges = await dbContext.Set<StudentCharge>()
            .AsNoTracking()
            .Where(x => x.Status == StudentChargeStatus.Active)
            .Include(x => x.Concessions)
            .Include(x => x.PaymentAllocations)
                .ThenInclude(x => x.FeePayment)
            .ToListAsync(cancellationToken);
        var balances = charges
            .Select(charge => new
            {
                charge.StudentEnrollmentId,
                charge.DueDate,
                Outstanding = FeeBalanceCalculator.Outstanding(charge),
            })
            .Where(x => x.Outstanding > 0)
            .ToArray();
        TotalOutstanding = balances.Sum(x => x.Outstanding);
        StudentsWithBalance = balances.Select(x => x.StudentEnrollmentId).Distinct().Count();
        OverdueStudents = balances.Where(x => x.DueDate < today).Select(x => x.StudentEnrollmentId).Distinct().Count();

        RecentPayments = await dbContext.Set<FeePayment>()
            .AsNoTracking()
            .OrderByDescending(x => x.PostedAtUtc)
            .Take(10)
            .Select(x => new RecentPaymentRow(
                x.StudentEnrollmentId,
                x.Receipt.ReceiptNumber,
                x.StudentEnrollment.Student.AdmissionNumber,
                x.StudentEnrollment.Student.FirstName + " " + x.StudentEnrollment.Student.LastName,
                x.StudentEnrollment.Class.Name + " " + x.StudentEnrollment.Section.Name,
                x.PaymentDate,
                x.Mode,
                x.Amount,
                x.Status))
            .ToListAsync(cancellationToken);
    }

    public sealed record RecentPaymentRow(
        Guid EnrollmentId,
        string ReceiptNumber,
        string AdmissionNumber,
        string StudentName,
        string ClassSection,
        DateOnly Date,
        FeePaymentMode Mode,
        decimal Amount,
        FeePaymentStatus Status);
}
