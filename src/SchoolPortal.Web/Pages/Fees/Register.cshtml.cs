using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Fees;
using SchoolPortal.Infrastructure.Persistence;

namespace SchoolPortal.Web.Pages.Fees;

[Authorize(Policy = PermissionCatalog.PolicyPrefix + PermissionCatalog.Fees.View)]
public sealed class RegisterModel(
    SchoolPortalDbContext dbContext) : PageModel
{
    [BindProperty(SupportsGet = true)]
    public string? Search { get; set; }

    [BindProperty(SupportsGet = true)]
    public DateOnly? From { get; set; }

    [BindProperty(SupportsGet = true)]
    public DateOnly? To { get; set; }

    [BindProperty(SupportsGet = true)]
    public FeePaymentMode? Mode { get; set; }

    [BindProperty(SupportsGet = true)]
    public FeePaymentStatus? Status { get; set; }

    public IReadOnlyList<PaymentRow> Payments { get; private set; } = [];

    public decimal PostedTotal => Payments.Where(x => x.Status == FeePaymentStatus.Posted).Sum(x => x.Amount);
    public decimal ReversedTotal => Payments.Where(x => x.Status == FeePaymentStatus.Reversed).Sum(x => x.Amount);
    public decimal NetTotal => PostedTotal;

    public bool CanPost => User.HasClaim(
        PermissionCatalog.ClaimType,
        PermissionCatalog.Fees.PostPayment);

    public async Task OnGetAsync(CancellationToken cancellationToken)
    {
        From ??= DateOnly.FromDateTime(DateTime.Today.AddDays(-30));
        To ??= DateOnly.FromDateTime(DateTime.Today);
        if (From > To)
        {
            (From, To) = (To, From);
        }

        var query = dbContext.Set<FeePayment>()
            .AsNoTracking()
            .Where(x => x.PaymentDate >= From && x.PaymentDate <= To);
        if (Mode.HasValue)
        {
            query = query.Where(x => x.Mode == Mode);
        }

        if (Status.HasValue)
        {
            query = query.Where(x => x.Status == Status);
        }

        var search = Search?.Trim();
        if (!string.IsNullOrWhiteSpace(search))
        {
            var pattern = $"%{search}%";
            query = query.Where(x =>
                EF.Functions.ILike(x.Receipt.ReceiptNumber, pattern)
                || EF.Functions.ILike(x.StudentEnrollment.Student.AdmissionNumber, pattern)
                || EF.Functions.ILike(x.StudentEnrollment.Student.FirstName, pattern)
                || EF.Functions.ILike(x.StudentEnrollment.Student.LastName, pattern)
                || (x.Reference != null && EF.Functions.ILike(x.Reference, pattern)));
        }

        Payments = await query
            .OrderByDescending(x => x.PostedAtUtc)
            .Take(500)
            .Select(x => new PaymentRow(
                x.StudentEnrollmentId,
                x.Receipt.ReceiptNumber,
                x.StudentEnrollment.Student.AdmissionNumber,
                x.StudentEnrollment.Student.FirstName + " " + x.StudentEnrollment.Student.LastName,
                x.StudentEnrollment.Class.Name + " " + x.StudentEnrollment.Section.Name,
                x.PaymentDate,
                x.Mode,
                x.Reference,
                x.Amount,
                x.Status))
            .ToListAsync(cancellationToken);
    }

    public sealed record PaymentRow(
        Guid EnrollmentId,
        string ReceiptNumber,
        string AdmissionNumber,
        string StudentName,
        string ClassSection,
        DateOnly Date,
        FeePaymentMode Mode,
        string? Reference,
        decimal Amount,
        FeePaymentStatus Status);
}
