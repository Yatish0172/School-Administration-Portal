using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Library;
using SchoolPortal.Infrastructure.Persistence;
using SchoolPortal.Web.Library;

namespace SchoolPortal.Web.Pages.Library;

[Authorize(Policy = PermissionCatalog.PolicyPrefix + PermissionCatalog.Library.ViewFines)]
public sealed class FinesModel(
    SchoolPortalDbContext dbContext,
    LibraryCirculationService circulationService) : PageModel
{
    [BindProperty(SupportsGet = true)]
    public LibraryFineStatus? Status { get; set; } = LibraryFineStatus.Pending;

    [BindProperty]
    public string SettlementReason { get; set; } = string.Empty;

    [TempData]
    public string? StatusMessage { get; set; }

    public IReadOnlyList<LibraryFine> Fines { get; private set; } = [];

    public decimal PendingTotal => Fines
        .Where(x => x.Status == LibraryFineStatus.Pending)
        .Sum(x => x.Amount);

    public bool CanSettle => User.HasClaim(
        PermissionCatalog.ClaimType,
        PermissionCatalog.Library.Return);

    public async Task OnGetAsync(CancellationToken cancellationToken) =>
        await LoadAsync(cancellationToken);

    public async Task<IActionResult> OnPostSettleAsync(
        Guid fineId,
        bool waive,
        CancellationToken cancellationToken)
    {
        if (!CanSettle)
        {
            return Forbid();
        }

        try
        {
            await circulationService.SettleFineAsync(
                fineId,
                waive,
                SettlementReason,
                cancellationToken);
            StatusMessage = waive
                ? "Fine waived with the recorded reason."
                : "Fine marked paid.";
            return RedirectToPage(new { Status });
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
        var query = dbContext.Set<LibraryFine>()
            .AsNoTracking()
            .Include(x => x.Student)
            .Include(x => x.BookIssue)
                .ThenInclude(x => x.LibraryCopy)
                    .ThenInclude(x => x.LibraryTitle)
            .AsQueryable();
        if (Status.HasValue)
        {
            query = query.Where(x => x.Status == Status.Value);
        }

        Fines = await query
            .OrderByDescending(x => x.BookIssue.ReturnedDate)
            .ThenBy(x => x.Student.AdmissionNumber)
            .Take(500)
            .ToListAsync(cancellationToken);
    }
}
