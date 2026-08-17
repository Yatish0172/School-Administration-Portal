using System.ComponentModel.DataAnnotations;
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
public sealed class CirculationModel(
    SchoolPortalDbContext dbContext,
    LibraryCirculationService circulationService) : PageModel
{
    [BindProperty(SupportsGet = true)]
    public Guid? StudentId { get; set; }

    [BindProperty]
    public IssueInput Issue { get; set; } = new();

    [BindProperty]
    public ReturnInput Return { get; set; } = new();

    [BindProperty]
    public string LossReason { get; set; } = string.Empty;

    [TempData]
    public string? StatusMessage { get; set; }

    public IReadOnlyList<Student> Students { get; private set; } = [];

    public IReadOnlyList<BookIssue> ActiveIssues { get; private set; } = [];

    public IReadOnlyList<BookIssue> History { get; private set; } = [];

    public LibraryPolicyValues Policy { get; private set; } =
        new(14, 2, 2, 1);

    public bool CanIssue => User.HasClaim(
        PermissionCatalog.ClaimType,
        PermissionCatalog.Library.Issue);

    public bool CanReturn => User.HasClaim(
        PermissionCatalog.ClaimType,
        PermissionCatalog.Library.Return);

    public async Task OnGetAsync(CancellationToken cancellationToken)
    {
        Issue.IssuedDate = DateOnly.FromDateTime(DateTime.Today);
        Return.ReturnedDate = DateOnly.FromDateTime(DateTime.Today);
        await LoadAsync(cancellationToken);
    }

    public async Task<IActionResult> OnPostIssueAsync(
        CancellationToken cancellationToken)
    {
        if (!CanIssue)
        {
            return Forbid();
        }

        StudentId = Issue.StudentId;
        ModelState.Clear();
        if (!TryValidateModel(Issue, nameof(Issue)))
        {
            await LoadAsync(cancellationToken);
            return Page();
        }

        try
        {
            await circulationService.IssueAsync(
                Issue.AccessionNumber,
                Issue.StudentId,
                Issue.IssuedDate,
                cancellationToken);
            StatusMessage = "Book issued successfully.";
            return RedirectToPage(new { StudentId });
        }
        catch (InvalidOperationException exception)
        {
            ModelState.AddModelError(string.Empty, exception.Message);
            await LoadAsync(cancellationToken);
            return Page();
        }
    }

    public async Task<IActionResult> OnPostRenewAsync(
        Guid issueId,
        Guid studentId,
        CancellationToken cancellationToken)
    {
        if (!CanIssue)
        {
            return Forbid();
        }

        StudentId = studentId;
        try
        {
            await circulationService.RenewAsync(
                issueId,
                DateOnly.FromDateTime(DateTime.Today),
                cancellationToken);
            StatusMessage = "Loan renewed and renewal history recorded.";
            return RedirectToPage(new { StudentId });
        }
        catch (InvalidOperationException exception)
        {
            ModelState.AddModelError(string.Empty, exception.Message);
            await LoadAsync(cancellationToken);
            return Page();
        }
    }

    public async Task<IActionResult> OnPostReturnAsync(
        CancellationToken cancellationToken)
    {
        if (!CanReturn)
        {
            return Forbid();
        }

        StudentId = Return.StudentId;
        ModelState.Clear();
        if (!TryValidateModel(Return, nameof(Return)))
        {
            await LoadAsync(cancellationToken);
            return Page();
        }

        try
        {
            var result = await circulationService.ReturnAsync(
                Return.IssueId,
                Return.ReturnedDate,
                Return.Condition,
                cancellationToken);
            StatusMessage = result.FineAmount > 0
                ? $"Book returned. A fine of {result.FineAmount:N2} was raised for {result.DaysOverdue} overdue day(s)."
                : "Book returned with no overdue fine.";
            return RedirectToPage(new { StudentId });
        }
        catch (InvalidOperationException exception)
        {
            ModelState.AddModelError(string.Empty, exception.Message);
            await LoadAsync(cancellationToken);
            return Page();
        }
    }

    public async Task<IActionResult> OnPostLostAsync(
        Guid issueId,
        Guid studentId,
        CancellationToken cancellationToken)
    {
        if (!CanReturn)
        {
            return Forbid();
        }

        StudentId = studentId;
        try
        {
            await circulationService.MarkLostAsync(
                issueId,
                LossReason,
                DateOnly.FromDateTime(DateTime.Today),
                cancellationToken);
            StatusMessage = "Copy marked lost. The loan remains in permanent history.";
            return RedirectToPage(new { StudentId });
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
        Students = await dbContext.Set<Student>()
            .AsNoTracking()
            .Where(x => x.Status == StudentStatus.Active)
            .OrderBy(x => x.AdmissionNumber)
            .Take(1000)
            .ToListAsync(cancellationToken);
        var query = dbContext.Set<BookIssue>()
            .AsNoTracking()
            .Include(x => x.Student)
            .Include(x => x.LibraryCopy)
                .ThenInclude(x => x.LibraryTitle)
            .Include(x => x.Renewals)
            .Include(x => x.Fine)
            .AsQueryable();
        if (StudentId.HasValue)
        {
            query = query.Where(x => x.StudentId == StudentId.Value);
        }

        ActiveIssues = await query
            .Where(x => x.Status == BookIssueStatus.Issued)
            .OrderBy(x => x.DueDate)
            .ToListAsync(cancellationToken);
        History = await query
            .Where(x => x.Status != BookIssueStatus.Issued)
            .OrderByDescending(x => x.ReturnedDate ?? x.IssuedDate)
            .Take(100)
            .ToListAsync(cancellationToken);
        Policy = await circulationService.GetPolicyAsync(cancellationToken);
        if (Issue.StudentId == Guid.Empty && StudentId.HasValue)
        {
            Issue.StudentId = StudentId.Value;
        }

        if (Issue.IssuedDate == default)
        {
            Issue.IssuedDate = DateOnly.FromDateTime(DateTime.Today);
        }

        if (Return.ReturnedDate == default)
        {
            Return.ReturnedDate = DateOnly.FromDateTime(DateTime.Today);
        }
    }

    public sealed class IssueInput
    {
        [Required]
        public Guid StudentId { get; set; }

        [Required, StringLength(40)]
        public string AccessionNumber { get; set; } = string.Empty;

        [Required]
        public DateOnly IssuedDate { get; set; }
    }

    public sealed class ReturnInput
    {
        [Required]
        public Guid IssueId { get; set; }

        [Required]
        public Guid StudentId { get; set; }

        [Required]
        public DateOnly ReturnedDate { get; set; }

        public LibraryCopyCondition Condition { get; set; } =
            LibraryCopyCondition.Good;
    }
}
