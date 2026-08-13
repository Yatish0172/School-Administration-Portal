using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Fees;
using SchoolPortal.Infrastructure.Persistence;
using SchoolPortal.Web.Administration;

namespace SchoolPortal.Web.Pages.Fees;

[Authorize(Policy = PermissionCatalog.PolicyPrefix + PermissionCatalog.Fees.View)]
public sealed class ReceiptModel(
    SchoolPortalDbContext dbContext,
    AuditWriter auditWriter) : PageModel
{
    public FeeReceipt Receipt { get; private set; } = null!;

    public FeePayment Payment => Receipt.FeePayment;

    public bool PrintNow { get; private set; }

    public bool IsDuplicate => Receipt.PrintCount > 1;

    public async Task<IActionResult> OnGetAsync(
        string number,
        bool print,
        CancellationToken cancellationToken)
    {
        PrintNow = print;
        var receipt = await Query()
            .SingleOrDefaultAsync(
                x => x.ReceiptNumber == number,
                cancellationToken);
        if (receipt is null)
        {
            return NotFound();
        }

        Receipt = receipt;
        return Page();
    }

    public async Task<IActionResult> OnPostPrintAsync(
        string number,
        CancellationToken cancellationToken)
    {
        var receipt = await dbContext.Set<FeeReceipt>()
            .SingleOrDefaultAsync(
                x => x.ReceiptNumber == number,
                cancellationToken);
        if (receipt is null)
        {
            return NotFound();
        }

        receipt.PrintCount++;
        receipt.LastPrintedAtUtc = DateTimeOffset.UtcNow;
        auditWriter.Add(
            "fee.receipt.printed",
            nameof(FeeReceipt),
            receipt.Id,
            new { PrintCount = receipt.PrintCount - 1 },
            new
            {
                receipt.PrintCount,
                receipt.LastPrintedAtUtc,
            });
        await dbContext.SaveChangesAsync(cancellationToken);
        return RedirectToPage(new { number, print = true });
    }

    private IQueryable<FeeReceipt> Query() =>
        dbContext.Set<FeeReceipt>()
            .AsNoTracking()
            .Include(x => x.FeePayment)
                .ThenInclude(x => x.StudentEnrollment)
                    .ThenInclude(x => x.Student)
            .Include(x => x.FeePayment)
                .ThenInclude(x => x.StudentEnrollment)
                    .ThenInclude(x => x.AcademicYear)
            .Include(x => x.FeePayment)
                .ThenInclude(x => x.StudentEnrollment)
                    .ThenInclude(x => x.Class)
            .Include(x => x.FeePayment)
                .ThenInclude(x => x.StudentEnrollment)
                    .ThenInclude(x => x.Section)
            .Include(x => x.FeePayment)
                .ThenInclude(x => x.Allocations)
                    .ThenInclude(x => x.StudentCharge)
                        .ThenInclude(x => x.FeeHead)
            .Include(x => x.FeePayment)
                .ThenInclude(x => x.Reversal);
}
