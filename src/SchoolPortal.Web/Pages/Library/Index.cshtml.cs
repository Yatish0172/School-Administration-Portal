using System.ComponentModel.DataAnnotations;
using System.Data;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Library;
using SchoolPortal.Infrastructure.Persistence;
using SchoolPortal.Web.Administration;
using SchoolPortal.Web.Library;

namespace SchoolPortal.Web.Pages.Library;

[Authorize(Policy = PermissionCatalog.PolicyPrefix + PermissionCatalog.Library.View)]
public sealed class IndexModel(
    SchoolPortalDbContext dbContext,
    LibraryCirculationService circulationService,
    AuditWriter auditWriter) : PageModel
{
    [BindProperty(SupportsGet = true)]
    public string? Search { get; set; }

    [BindProperty(SupportsGet = true)]
    public Guid? SelectedTitleId { get; set; }

    [BindProperty]
    public TitleInput NewTitle { get; set; } = new();

    [BindProperty]
    public CopyInput NewCopies { get; set; } = new();

    [BindProperty]
    public string ReferenceName { get; set; } = string.Empty;

    [BindProperty]
    public PolicyInput Policy { get; set; } = new();

    [TempData]
    public string? StatusMessage { get; set; }

    public IReadOnlyList<LibraryTitle> Titles { get; private set; } = [];

    public IReadOnlyList<LibraryAuthor> Authors { get; private set; } = [];

    public IReadOnlyList<LibraryCategory> Categories { get; private set; } = [];

    public IReadOnlyList<LibraryPublisher> Publishers { get; private set; } = [];

    public LibraryTitle? SelectedTitle { get; private set; }

    public bool CanManage => User.HasClaim(
        PermissionCatalog.ClaimType,
        PermissionCatalog.Library.Manage);

    public async Task OnGetAsync(CancellationToken cancellationToken)
    {
        await LoadAsync(cancellationToken);
        var policy = await circulationService.GetPolicyAsync(cancellationToken);
        Policy = new PolicyInput
        {
            LoanDays = policy.LoanDays,
            MaximumBooksPerStudent = policy.MaximumBooksPerStudent,
            MaximumRenewals = policy.MaximumRenewals,
            FinePerOverdueDay = policy.FinePerOverdueDay,
        };
    }

    public async Task<IActionResult> OnPostCreateReferenceAsync(
        string referenceType,
        CancellationToken cancellationToken)
    {
        if (!CanManage)
        {
            return Forbid();
        }

        if (string.IsNullOrWhiteSpace(ReferenceName))
        {
            ModelState.AddModelError(
                nameof(ReferenceName),
                "Enter a name.");
            await LoadAsync(cancellationToken);
            return Page();
        }

        if (string.IsNullOrWhiteSpace(referenceType))
        {
            return BadRequest();
        }

        var name = ReferenceName.Trim();
        Guid entityId;
        object entity;
        switch (referenceType.Trim().ToLowerInvariant())
        {
            case "author":
                var author = new LibraryAuthor { Name = name };
                entityId = author.Id;
                entity = author;
                break;
            case "category":
                var category = new LibraryCategory { Name = name };
                entityId = category.Id;
                entity = category;
                break;
            case "publisher":
                var publisher = new LibraryPublisher { Name = name };
                entityId = publisher.Id;
                entity = publisher;
                break;
            default:
                return BadRequest();
        }

        dbContext.Add(entity);
        auditWriter.Add(
            "library.reference.created",
            entity.GetType().Name,
            entityId,
            null,
            new
            {
                Type = referenceType,
                Name = name,
            });
        return await SaveAsync(
            $"{referenceType} created.",
            SelectedTitleId,
            cancellationToken);
    }

    public async Task<IActionResult> OnPostCreateTitleAsync(
        CancellationToken cancellationToken)
    {
        if (!CanManage)
        {
            return Forbid();
        }

        ModelState.Clear();
        if (!TryValidateModel(NewTitle, nameof(NewTitle)))
        {
            await LoadAsync(cancellationToken);
            return Page();
        }

        var authorExists = await dbContext.Set<LibraryAuthor>()
            .AnyAsync(x => x.Id == NewTitle.AuthorId, cancellationToken);
        var categoryExists = await dbContext.Set<LibraryCategory>()
            .AnyAsync(x => x.Id == NewTitle.CategoryId, cancellationToken);
        var publisherExists = !NewTitle.PublisherId.HasValue
            || await dbContext.Set<LibraryPublisher>()
                .AnyAsync(
                    x => x.Id == NewTitle.PublisherId.Value,
                    cancellationToken);
        if (!authorExists || !categoryExists || !publisherExists)
        {
            ModelState.AddModelError(
                string.Empty,
                "Choose valid catalogue references.");
            await LoadAsync(cancellationToken);
            return Page();
        }

        var title = new LibraryTitle
        {
            Title = NewTitle.Title.Trim(),
            AuthorId = NewTitle.AuthorId,
            CategoryId = NewTitle.CategoryId,
            PublisherId = NewTitle.PublisherId,
            Isbn = Clean(NewTitle.Isbn),
            ClassificationNumber = Clean(NewTitle.ClassificationNumber),
            Edition = Clean(NewTitle.Edition),
            PublicationYear = NewTitle.PublicationYear,
            Language = NewTitle.Language.Trim(),
            ShelfLocation = Clean(NewTitle.ShelfLocation),
            Description = Clean(NewTitle.Description),
        };
        dbContext.Add(title);
        auditWriter.Add(
            "library.title.created",
            nameof(LibraryTitle),
            title.Id,
            null,
            new
            {
                title.Title,
                title.AuthorId,
                title.CategoryId,
                title.PublisherId,
                title.Isbn,
                title.ClassificationNumber,
                title.ShelfLocation,
            });
        return await SaveAsync(
            "Catalogue title created. Add physical copies next.",
            title.Id,
            cancellationToken);
    }

    public async Task<IActionResult> OnPostAddCopiesAsync(
        CancellationToken cancellationToken)
    {
        if (!CanManage)
        {
            return Forbid();
        }

        SelectedTitleId = NewCopies.LibraryTitleId;
        ModelState.Clear();
        if (!TryValidateModel(NewCopies, nameof(NewCopies)))
        {
            await LoadAsync(cancellationToken);
            return Page();
        }

        var title = await dbContext.Set<LibraryTitle>()
            .AsNoTracking()
            .SingleOrDefaultAsync(
                x => x.Id == NewCopies.LibraryTitleId && x.IsActive,
                cancellationToken);
        if (title is null)
        {
            return NotFound();
        }

        await using var transaction = await dbContext.Database.BeginTransactionAsync(
            IsolationLevel.Serializable,
            cancellationToken);
        var copies = new List<LibraryCopy>();
        for (var index = 0; index < NewCopies.Quantity; index++)
        {
            var sequence = await dbContext.Database
                .SqlQuery<long>(
                    $"SELECT nextval('portal.\"LibraryAccessionNumberSequence\"') AS \"Value\"")
                .SingleAsync(cancellationToken);
            copies.Add(new LibraryCopy
            {
                LibraryTitleId = title.Id,
                AccessionNumber = $"ACC-{sequence:D6}",
                PurchaseDate = NewCopies.PurchaseDate,
                Price = NewCopies.Price,
                Condition = NewCopies.Condition,
            });
        }

        dbContext.AddRange(copies);
        auditWriter.Add(
            "library.copies.created",
            nameof(LibraryTitle),
            title.Id,
            null,
            new
            {
                Quantity = copies.Count,
                Accessions = copies.Select(x => x.AccessionNumber),
                NewCopies.PurchaseDate,
                NewCopies.Price,
            });
        await dbContext.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        StatusMessage = $"{copies.Count} physical copy/copies added.";
        return RedirectToPage(new { SelectedTitleId = title.Id });
    }

    public async Task<IActionResult> OnPostSetCopyStatusAsync(
        Guid copyId,
        LibraryCopyStatus status,
        CancellationToken cancellationToken)
    {
        if (!CanManage)
        {
            return Forbid();
        }

        if (!Enum.IsDefined(status))
        {
            return BadRequest();
        }

        var copy = await dbContext.Set<LibraryCopy>()
            .SingleOrDefaultAsync(x => x.Id == copyId, cancellationToken);
        if (copy is null)
        {
            return NotFound();
        }

        SelectedTitleId = copy.LibraryTitleId;
        if (copy.Status == LibraryCopyStatus.Issued)
        {
            ModelState.AddModelError(
                string.Empty,
                "An issued copy must be returned or marked lost from circulation.");
            await LoadAsync(cancellationToken);
            return Page();
        }

        var before = copy.Status;
        copy.Status = status;
        if (status == LibraryCopyStatus.Damaged)
        {
            copy.Condition = LibraryCopyCondition.Damaged;
        }

        auditWriter.Add(
            "library.copy.status-changed",
            nameof(LibraryCopy),
            copy.Id,
            new { Status = before },
            new { Status = copy.Status });
        await dbContext.SaveChangesAsync(cancellationToken);
        StatusMessage = "Copy status updated.";
        return RedirectToPage(new { SelectedTitleId });
    }

    public async Task<IActionResult> OnPostUpdatePolicyAsync(
        CancellationToken cancellationToken)
    {
        if (!CanManage)
        {
            return Forbid();
        }

        ModelState.Clear();
        if (!TryValidateModel(Policy, nameof(Policy)))
        {
            await LoadAsync(cancellationToken);
            return Page();
        }

        var policy = await dbContext.Set<LibraryPolicy>()
            .OrderBy(x => x.UpdatedAtUtc)
            .LastOrDefaultAsync(cancellationToken);
        var before = policy is null
            ? null
            : new
            {
                policy.LoanDays,
                policy.MaximumBooksPerStudent,
                policy.MaximumRenewals,
                policy.FinePerOverdueDay,
            };
        if (policy is null)
        {
            policy = new LibraryPolicy();
            dbContext.Add(policy);
        }

        policy.LoanDays = Policy.LoanDays;
        policy.MaximumBooksPerStudent = Policy.MaximumBooksPerStudent;
        policy.MaximumRenewals = Policy.MaximumRenewals;
        policy.FinePerOverdueDay = Policy.FinePerOverdueDay;
        policy.UpdatedByUserId = CurrentUserId();
        policy.UpdatedAtUtc = DateTimeOffset.UtcNow;
        auditWriter.Add(
            "library.policy.updated",
            nameof(LibraryPolicy),
            policy.Id,
            before,
            new
            {
                policy.LoanDays,
                policy.MaximumBooksPerStudent,
                policy.MaximumRenewals,
                policy.FinePerOverdueDay,
            });
        await dbContext.SaveChangesAsync(cancellationToken);
        StatusMessage = "Circulation policy updated.";
        return RedirectToPage(new { SelectedTitleId });
    }

    private async Task LoadAsync(CancellationToken cancellationToken)
    {
        var query = dbContext.Set<LibraryTitle>()
            .AsNoTracking()
            .Include(x => x.Author)
            .Include(x => x.Category)
            .Include(x => x.Publisher)
            .Include(x => x.Copies)
            .AsQueryable();
        if (!string.IsNullOrWhiteSpace(Search))
        {
            var search = Search.Trim();
            query = query.Where(x =>
                EF.Functions.ILike(x.Title, $"%{search}%")
                || EF.Functions.ILike(x.Author.Name, $"%{search}%")
                || (x.Isbn != null
                    && EF.Functions.ILike(x.Isbn, $"%{search}%"))
                || (x.ShelfLocation != null
                    && EF.Functions.ILike(x.ShelfLocation, $"%{search}%")));
        }

        Titles = await query
            .OrderBy(x => x.Title)
            .Take(500)
            .ToListAsync(cancellationToken);
        Authors = await dbContext.Set<LibraryAuthor>()
            .AsNoTracking()
            .OrderBy(x => x.Name)
            .ToListAsync(cancellationToken);
        Categories = await dbContext.Set<LibraryCategory>()
            .AsNoTracking()
            .OrderBy(x => x.Name)
            .ToListAsync(cancellationToken);
        Publishers = await dbContext.Set<LibraryPublisher>()
            .AsNoTracking()
            .OrderBy(x => x.Name)
            .ToListAsync(cancellationToken);
        SelectedTitle = Titles.FirstOrDefault(x => x.Id == SelectedTitleId)
            ?? (Titles.Count > 0 ? Titles[0] : null);
        SelectedTitleId = SelectedTitle?.Id;
    }

    private async Task<IActionResult> SaveAsync(
        string message,
        Guid? titleId,
        CancellationToken cancellationToken)
    {
        try
        {
            await dbContext.SaveChangesAsync(cancellationToken);
            StatusMessage = message;
            return RedirectToPage(new { SelectedTitleId = titleId });
        }
        catch (DbUpdateException)
        {
            ModelState.AddModelError(
                string.Empty,
                "That catalogue entry already exists.");
            SelectedTitleId = titleId;
            await LoadAsync(cancellationToken);
            return Page();
        }
    }

    private Guid CurrentUserId()
    {
        var value = User.FindFirstValue(ClaimTypes.NameIdentifier);
        return Guid.TryParse(value, out var userId)
            ? userId
            : throw new InvalidOperationException("A signed-in user is required.");
    }

    private static string? Clean(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    public sealed class TitleInput
    {
        [Required, StringLength(300)]
        public string Title { get; set; } = string.Empty;

        [Required]
        public Guid AuthorId { get; set; }

        [Required]
        public Guid CategoryId { get; set; }

        public Guid? PublisherId { get; set; }

        [StringLength(30)]
        public string? Isbn { get; set; }

        [StringLength(50)]
        public string? ClassificationNumber { get; set; }

        [StringLength(50)]
        public string? Edition { get; set; }

        [Range(1000, 2200)]
        public int? PublicationYear { get; set; }

        [Required, StringLength(50)]
        public string Language { get; set; } = "English";

        [StringLength(100)]
        public string? ShelfLocation { get; set; }

        [StringLength(1000)]
        public string? Description { get; set; }
    }

    public sealed class CopyInput
    {
        [Required]
        public Guid LibraryTitleId { get; set; }

        [Range(1, 200)]
        public int Quantity { get; set; } = 1;

        public DateOnly? PurchaseDate { get; set; }

        [Range(typeof(decimal), "0", "9999999999")]
        public decimal? Price { get; set; }

        public LibraryCopyCondition Condition { get; set; } =
            LibraryCopyCondition.Good;
    }

    public sealed class PolicyInput
    {
        [Range(1, 365)]
        public int LoanDays { get; set; } = 14;

        [Range(1, 50)]
        public int MaximumBooksPerStudent { get; set; } = 2;

        [Range(0, 20)]
        public int MaximumRenewals { get; set; } = 2;

        [Range(typeof(decimal), "0", "999999")]
        public decimal FinePerOverdueDay { get; set; } = 1;
    }
}
