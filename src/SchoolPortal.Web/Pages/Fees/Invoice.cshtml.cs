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
public sealed class InvoiceModel(
    SchoolPortalDbContext dbContext,
    AuditWriter auditWriter) : PageModel
{
    public StudentEnrollment Enrollment { get; private set; } = null!;
    public IReadOnlyList<InvoiceChargeRow> Charges { get; private set; } = [];
    public DateOnly IssueDate { get; private set; }
    public string InvoiceNumber { get; private set; } = string.Empty;
    public bool PrintNow { get; private set; }
    public decimal TotalCharged => Charges.Sum(x => x.Amount);
    public decimal TotalConcession => Charges.Sum(x => x.Concession);
    public decimal TotalPaid => Charges.Sum(x => x.Paid);
    public decimal TotalOutstanding => Charges.Sum(x => x.Outstanding);

    public async Task<IActionResult> OnGetAsync(
        Guid EnrollmentId,
        bool print,
        CancellationToken cancellationToken)
    {
        if (!await LoadAsync(EnrollmentId, cancellationToken))
        {
            return NotFound();
        }

        PrintNow = print;
        return Page();
    }

    public async Task<IActionResult> OnPostPrintAsync(
        Guid EnrollmentId,
        CancellationToken cancellationToken)
    {
        if (!await LoadAsync(EnrollmentId, cancellationToken))
        {
            return NotFound();
        }

        auditWriter.Add(
            "fee.invoice.printed",
            "FeeInvoice",
            Enrollment.Id,
            null,
            new
            {
                InvoiceNumber,
                Enrollment.Student.AdmissionNumber,
                Enrollment.AcademicYear.Name,
                TotalOutstanding,
            });
        await dbContext.SaveChangesAsync(cancellationToken);
        return RedirectToPage(new { EnrollmentId, print = true });
    }

    private async Task<bool> LoadAsync(
        Guid enrollmentId,
        CancellationToken cancellationToken)
    {
        var enrollment = await dbContext.Set<StudentEnrollment>()
            .AsNoTracking()
            .Include(x => x.Student)
            .Include(x => x.AcademicYear)
            .Include(x => x.Class)
            .Include(x => x.Section)
            .SingleOrDefaultAsync(x => x.Id == enrollmentId, cancellationToken);
        if (enrollment is null)
        {
            return false;
        }

        Enrollment = enrollment;
        IssueDate = DateOnly.FromDateTime(DateTime.Today);
        InvoiceNumber = $"INV-{Safe(enrollment.AcademicYear.Name)}-{Safe(enrollment.Student.AdmissionNumber)}";
        var charges = await dbContext.Set<StudentCharge>()
            .AsNoTracking()
            .Where(x =>
                x.StudentEnrollmentId == enrollment.Id
                && x.Status == StudentChargeStatus.Active)
            .Include(x => x.FeeHead)
            .Include(x => x.Concessions)
            .Include(x => x.PaymentAllocations)
                .ThenInclude(x => x.FeePayment)
            .OrderBy(x => x.DueDate)
            .ThenBy(x => x.CreatedAtUtc)
            .ToListAsync(cancellationToken);
        Charges = charges.Select(x => new InvoiceChargeRow(
            x.FeeHead.Name,
            x.Description,
            x.Period,
            x.DueDate,
            x.Amount,
            FeeBalanceCalculator.ConcessionTotal(x),
            FeeBalanceCalculator.PaidTotal(x),
            FeeBalanceCalculator.Outstanding(x))).ToArray();
        return true;
    }

    private static string Safe(string value) =>
        new(value.Where(char.IsLetterOrDigit).Select(char.ToUpperInvariant).ToArray());

    public sealed record InvoiceChargeRow(
        string Name,
        string Description,
        string Period,
        DateOnly DueDate,
        decimal Amount,
        decimal Concession,
        decimal Paid,
        decimal Outstanding);
}
