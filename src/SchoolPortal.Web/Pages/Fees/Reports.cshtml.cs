using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Fees;
using SchoolPortal.Infrastructure.Persistence;
using SchoolPortal.Web.Fees;

namespace SchoolPortal.Web.Pages.Fees;

[Authorize(Policy = PermissionCatalog.PolicyPrefix + PermissionCatalog.Fees.Reports)]
public sealed class ReportsModel(
    SchoolPortalDbContext dbContext) : PageModel
{
    [BindProperty(SupportsGet = true)]
    public DateOnly? From { get; set; }

    [BindProperty(SupportsGet = true)]
    public DateOnly? To { get; set; }

    public IReadOnlyList<CollectionRow> Collections { get; private set; } = [];

    public IReadOnlyList<DuesRow> Dues { get; private set; } = [];

    public decimal CollectedTotal => Collections
        .Where(x => x.Status == FeePaymentStatus.Posted)
        .Sum(x => x.Amount);

    public decimal ReversedTotal => Collections
        .Where(x => x.Status == FeePaymentStatus.Reversed)
        .Sum(x => x.Amount);

    public decimal OutstandingTotal => Dues.Sum(x => x.Outstanding);

    public async Task OnGetAsync(CancellationToken cancellationToken)
    {
        From ??= DateOnly.FromDateTime(DateTime.Today);
        To ??= DateOnly.FromDateTime(DateTime.Today);
        if (From > To)
        {
            (From, To) = (To, From);
        }

        Collections = await dbContext.Set<FeePayment>()
            .AsNoTracking()
            .Where(x => x.PaymentDate >= From && x.PaymentDate <= To)
            .Include(x => x.Receipt)
            .Include(x => x.StudentEnrollment)
                .ThenInclude(x => x.Student)
            .OrderBy(x => x.PostedAtUtc)
            .Select(x => new CollectionRow(
                x.Receipt.ReceiptNumber,
                x.PaymentDate,
                x.StudentEnrollment.Student.AdmissionNumber,
                x.StudentEnrollment.Student.FirstName
                    + " "
                    + x.StudentEnrollment.Student.LastName,
                x.Mode,
                x.Reference,
                x.Amount,
                x.Status))
            .ToListAsync(cancellationToken);

        var charges = await dbContext.Set<StudentCharge>()
            .AsNoTracking()
            .Where(x => x.Status == StudentChargeStatus.Active)
            .Include(x => x.StudentEnrollment)
                .ThenInclude(x => x.Student)
            .Include(x => x.StudentEnrollment)
                .ThenInclude(x => x.Class)
            .Include(x => x.StudentEnrollment)
                .ThenInclude(x => x.Section)
            .Include(x => x.Concessions)
            .Include(x => x.PaymentAllocations)
                .ThenInclude(x => x.FeePayment)
            .ToListAsync(cancellationToken);
        Dues = charges
            .Select(x => new
            {
                Charge = x,
                Outstanding = FeeBalanceCalculator.Outstanding(x),
            })
            .Where(x => x.Outstanding > 0)
            .GroupBy(x => x.Charge.StudentEnrollment)
            .Select(group => new DuesRow(
                group.Key.Id,
                group.Key.Student.AdmissionNumber,
                group.Key.Student.FullName,
                $"{group.Key.Class.Name} {group.Key.Section.Name}",
                group.Sum(x => x.Outstanding),
                group.Sum(x => AgeAmount(
                    x.Charge.DueDate,
                    x.Outstanding,
                    int.MinValue,
                    30)),
                group.Sum(x => AgeAmount(x.Charge.DueDate, x.Outstanding, 31, 60)),
                group.Sum(x => AgeAmount(x.Charge.DueDate, x.Outstanding, 61, 90)),
                group.Sum(x => AgeAmount(x.Charge.DueDate, x.Outstanding, 91, int.MaxValue))))
            .OrderByDescending(x => x.Outstanding)
            .ToList();
    }

    private static decimal AgeAmount(
        DateOnly dueDate,
        decimal amount,
        int minimumDays,
        int maximumDays)
    {
        var days = DateOnly.FromDateTime(DateTime.Today).DayNumber
            - dueDate.DayNumber;
        return days >= minimumDays && days <= maximumDays ? amount : 0;
    }

    public sealed record CollectionRow(
        string ReceiptNumber,
        DateOnly Date,
        string AdmissionNumber,
        string StudentName,
        FeePaymentMode Mode,
        string? Reference,
        decimal Amount,
        FeePaymentStatus Status);

    public sealed record DuesRow(
        Guid EnrollmentId,
        string AdmissionNumber,
        string StudentName,
        string ClassSection,
        decimal Outstanding,
        decimal Days0To30,
        decimal Days31To60,
        decimal Days61To90,
        decimal DaysOver90);
}
