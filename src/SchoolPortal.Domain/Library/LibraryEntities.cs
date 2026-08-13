using SchoolPortal.Domain.Students;

namespace SchoolPortal.Domain.Library;

public enum LibraryCopyStatus
{
    Available = 1,
    Issued = 2,
    Lost = 3,
    Damaged = 4,
    Withdrawn = 5,
}

public enum LibraryCopyCondition
{
    Good = 1,
    Fair = 2,
    Damaged = 3,
}

public enum BookIssueStatus
{
    Issued = 1,
    Returned = 2,
    Lost = 3,
}

public enum LibraryFineStatus
{
    Pending = 1,
    Paid = 2,
    Waived = 3,
}

public sealed class LibraryAuthor
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public string Name { get; set; } = string.Empty;

    public ICollection<LibraryTitle> Titles { get; set; } = [];
}

public sealed class LibraryCategory
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public string Name { get; set; } = string.Empty;

    public ICollection<LibraryTitle> Titles { get; set; } = [];
}

public sealed class LibraryPublisher
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public string Name { get; set; } = string.Empty;

    public ICollection<LibraryTitle> Titles { get; set; } = [];
}

public sealed class LibraryTitle
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public string Title { get; set; } = string.Empty;

    public Guid AuthorId { get; set; }

    public LibraryAuthor Author { get; set; } = null!;

    public Guid CategoryId { get; set; }

    public LibraryCategory Category { get; set; } = null!;

    public Guid? PublisherId { get; set; }

    public LibraryPublisher? Publisher { get; set; }

    public string? Isbn { get; set; }

    public string? ClassificationNumber { get; set; }

    public string? Edition { get; set; }

    public int? PublicationYear { get; set; }

    public string Language { get; set; } = "English";

    public string? ShelfLocation { get; set; }

    public string? Description { get; set; }

    public bool IsActive { get; set; } = true;

    public DateTimeOffset CreatedAtUtc { get; set; } = DateTimeOffset.UtcNow;

    public uint Version { get; set; }

    public ICollection<LibraryCopy> Copies { get; set; } = [];
}

public sealed class LibraryCopy
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid LibraryTitleId { get; set; }

    public LibraryTitle LibraryTitle { get; set; } = null!;

    public string AccessionNumber { get; set; } = string.Empty;

    public DateOnly? PurchaseDate { get; set; }

    public decimal? Price { get; set; }

    public LibraryCopyStatus Status { get; set; } = LibraryCopyStatus.Available;

    public LibraryCopyCondition Condition { get; set; } = LibraryCopyCondition.Good;

    public string? Notes { get; set; }

    public uint Version { get; set; }

    public ICollection<BookIssue> Issues { get; set; } = [];
}

public sealed class LibraryPolicy
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public int LoanDays { get; set; } = 14;

    public int MaximumBooksPerStudent { get; set; } = 2;

    public int MaximumRenewals { get; set; } = 2;

    public decimal FinePerOverdueDay { get; set; } = 1;

    public Guid UpdatedByUserId { get; set; }

    public DateTimeOffset UpdatedAtUtc { get; set; } = DateTimeOffset.UtcNow;

    public uint Version { get; set; }
}

public sealed class BookIssue
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid LibraryCopyId { get; set; }

    public LibraryCopy LibraryCopy { get; set; } = null!;

    public Guid StudentId { get; set; }

    public Student Student { get; set; } = null!;

    public DateOnly IssuedDate { get; set; }

    public DateOnly DueDate { get; set; }

    public DateOnly? ReturnedDate { get; set; }

    public BookIssueStatus Status { get; set; } = BookIssueStatus.Issued;

    public int RenewalCount { get; set; }

    public Guid IssuedByUserId { get; set; }

    public Guid? ReturnedByUserId { get; set; }

    public Guid? LostByUserId { get; set; }

    public DateTimeOffset? LostAtUtc { get; set; }

    public string? LossReason { get; set; }

    public DateTimeOffset CreatedAtUtc { get; set; } = DateTimeOffset.UtcNow;

    public uint Version { get; set; }

    public ICollection<BookRenewal> Renewals { get; set; } = [];

    public LibraryFine? Fine { get; set; }
}

public sealed class BookRenewal
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid BookIssueId { get; set; }

    public BookIssue BookIssue { get; set; } = null!;

    public DateOnly PreviousDueDate { get; set; }

    public DateOnly NewDueDate { get; set; }

    public Guid RenewedByUserId { get; set; }

    public DateTimeOffset RenewedAtUtc { get; set; } = DateTimeOffset.UtcNow;
}

public sealed class LibraryFine
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid BookIssueId { get; set; }

    public BookIssue BookIssue { get; set; } = null!;

    public Guid StudentId { get; set; }

    public Student Student { get; set; } = null!;

    public decimal Amount { get; set; }

    public int DaysOverdue { get; set; }

    public string Reason { get; set; } = string.Empty;

    public LibraryFineStatus Status { get; set; } = LibraryFineStatus.Pending;

    public Guid? SettledByUserId { get; set; }

    public DateTimeOffset? SettledAtUtc { get; set; }

    public string? SettlementReason { get; set; }
}
