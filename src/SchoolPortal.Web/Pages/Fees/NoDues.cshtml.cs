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
public sealed class NoDuesModel(
    SchoolPortalDbContext dbContext,
    AuditWriter auditWriter) : PageModel
{
    public StudentEnrollment Enrollment { get; private set; } = null!;
    public DateOnly IssueDate { get; private set; }
    public string CertificateNumber { get; private set; } = string.Empty;
    public decimal TotalOutstanding { get; private set; }
    public bool CanIssue => TotalOutstanding == 0;
    public bool PrintNow { get; private set; }

    public async Task<IActionResult> OnGetAsync(
        Guid EnrollmentId,
        bool print,
        CancellationToken cancellationToken)
    {
        if (!await LoadAsync(EnrollmentId, cancellationToken))
        {
            return NotFound();
        }

        PrintNow = print && CanIssue;
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

        if (!CanIssue)
        {
            ModelState.AddModelError(
                string.Empty,
                "The No Dues Certificate cannot be printed while a fee balance remains.");
            return Page();
        }

        auditWriter.Add(
            "fee.no-dues-certificate.printed",
            "FeeNoDuesCertificate",
            Enrollment.Id,
            null,
            new
            {
                CertificateNumber,
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
        CertificateNumber = $"NOC-{Safe(enrollment.AcademicYear.Name)}-{Safe(enrollment.Student.AdmissionNumber)}";
        var charges = await dbContext.Set<StudentCharge>()
            .AsNoTracking()
            .Where(x =>
                x.StudentEnrollmentId == enrollment.Id
                && x.Status == StudentChargeStatus.Active)
            .Include(x => x.Concessions)
            .Include(x => x.PaymentAllocations)
                .ThenInclude(x => x.FeePayment)
            .ToListAsync(cancellationToken);
        TotalOutstanding = charges.Sum(FeeBalanceCalculator.Outstanding);
        return true;
    }

    private static string Safe(string value) =>
        new(value.Where(char.IsLetterOrDigit).Select(char.ToUpperInvariant).ToArray());
}
