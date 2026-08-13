using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Library;
using SchoolPortal.Domain.Students;
using SchoolPortal.Infrastructure.Persistence;
using SchoolPortal.Web.Library;

namespace SchoolPortal.Web.Pages.Library;

[Authorize(Policy = PermissionCatalog.PolicyPrefix + PermissionCatalog.Library.View)]
public sealed class ReportsModel(
    SchoolPortalDbContext dbContext,
    LibraryCirculationService circulationService) : PageModel
{
    [BindProperty(SupportsGet = true)]
    public BookIssueStatus? Status { get; set; }

    [BindProperty(SupportsGet = true)]
    public Guid? StudentId { get; set; }

    public IReadOnlyList<Student> Students { get; private set; } = [];

    public IReadOnlyList<BookIssue> Issues { get; private set; } = [];

    public IReadOnlyList<StockRow> Stock { get; private set; } = [];

    public LibraryPolicyValues Policy { get; private set; } =
        new(14, 2, 2, 1);

    public int TotalCopies => Stock.Sum(x => x.Total);

    public int AvailableCopies => Stock.Sum(x => x.Available);

    public int IssuedCopies => Stock.Sum(x => x.Issued);

    public int LostCopies => Stock.Sum(x => x.Lost);

    public int OverdueCount => Issues.Count(x =>
        x.Status == BookIssueStatus.Issued
        && x.DueDate < DateOnly.FromDateTime(DateTime.Today));

    public async Task OnGetAsync(CancellationToken cancellationToken)
    {
        Students = await dbContext.Set<Student>()
            .AsNoTracking()
            .OrderBy(x => x.AdmissionNumber)
            .Take(1000)
            .ToListAsync(cancellationToken);
        var query = dbContext.Set<BookIssue>()
            .AsNoTracking()
            .Include(x => x.Student)
            .Include(x => x.LibraryCopy)
                .ThenInclude(x => x.LibraryTitle)
            .Include(x => x.Fine)
            .AsQueryable();
        if (Status.HasValue)
        {
            query = query.Where(x => x.Status == Status.Value);
        }

        if (StudentId.HasValue)
        {
            query = query.Where(x => x.StudentId == StudentId.Value);
        }

        Issues = await query
            .OrderByDescending(x => x.IssuedDate)
            .Take(1000)
            .ToListAsync(cancellationToken);
        Stock = await dbContext.Set<LibraryTitle>()
            .AsNoTracking()
            .Include(x => x.Copies)
            .OrderBy(x => x.Title)
            .Select(x => new StockRow(
                x.Title,
                x.Copies.Count,
                x.Copies.Count(c => c.Status == LibraryCopyStatus.Available),
                x.Copies.Count(c => c.Status == LibraryCopyStatus.Issued),
                x.Copies.Count(c => c.Status == LibraryCopyStatus.Lost),
                x.Copies.Count(c =>
                    c.Status == LibraryCopyStatus.Damaged
                    || c.Status == LibraryCopyStatus.Withdrawn)))
            .ToListAsync(cancellationToken);
        Policy = await circulationService.GetPolicyAsync(cancellationToken);
    }

    public sealed record StockRow(
        string Title,
        int Total,
        int Available,
        int Issued,
        int Lost,
        int Other);
}
