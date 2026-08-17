using System.Data;
using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Domain.Library;
using SchoolPortal.Domain.Students;
using SchoolPortal.Infrastructure.Persistence;
using SchoolPortal.Web.Administration;

namespace SchoolPortal.Web.Library;

public sealed record LibraryPolicyValues(
    int LoanDays,
    int MaximumBooksPerStudent,
    int MaximumRenewals,
    decimal FinePerOverdueDay);

public sealed record BookReturnResult(
    Guid IssueId,
    int DaysOverdue,
    decimal FineAmount);

public sealed class LibraryCirculationService(
    SchoolPortalDbContext dbContext,
    AuditWriter auditWriter,
    IHttpContextAccessor httpContextAccessor)
{
    public async Task<Guid> IssueAsync(
        string accessionNumber,
        Guid studentId,
        DateOnly issuedDate,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(accessionNumber))
        {
            throw new InvalidOperationException("Enter an accession number.");
        }

        if (studentId == Guid.Empty)
        {
            throw new InvalidOperationException("Choose a student.");
        }

        var userId = CurrentUserId();
        var policy = await GetPolicyAsync(cancellationToken);
        var normalizedAccession = accessionNumber.Trim().ToUpperInvariant();
        await using var transaction = await dbContext.Database.BeginTransactionAsync(
            IsolationLevel.Serializable,
            cancellationToken);
        await LockAsync($"library-copy:{normalizedAccession}", cancellationToken);
        await LockAsync($"library-student:{studentId}", cancellationToken);

        var student = await dbContext.Set<Student>()
            .AsNoTracking()
            .SingleOrDefaultAsync(x => x.Id == studentId, cancellationToken);
        if (student is null || student.Status != StudentStatus.Active)
        {
            throw new InvalidOperationException(
                "Books can only be issued to an active student.");
        }

        var copy = await dbContext.Set<LibraryCopy>()
            .AsNoTracking()
            .Include(x => x.LibraryTitle)
            .SingleOrDefaultAsync(
                x => x.AccessionNumber == normalizedAccession,
                cancellationToken);
        if (copy is null)
        {
            throw new InvalidOperationException(
                "No copy has that accession number.");
        }

        if (copy.Status != LibraryCopyStatus.Available)
        {
            throw new InvalidOperationException(
                $"That copy is {copy.Status.ToString().ToLowerInvariant()} and cannot be issued.");
        }

        var activeIssueCount = await dbContext.Set<BookIssue>()
            .CountAsync(
                x => x.StudentId == studentId
                    && x.Status == BookIssueStatus.Issued,
                cancellationToken);
        if (activeIssueCount >= policy.MaximumBooksPerStudent)
        {
            throw new InvalidOperationException(
                $"This student already holds {activeIssueCount} book(s). "
                + $"The configured limit is {policy.MaximumBooksPerStudent}.");
        }

        var copyUpdated = await dbContext.Set<LibraryCopy>()
            .Where(x =>
                x.Id == copy.Id
                && x.Status == LibraryCopyStatus.Available)
            .ExecuteUpdateAsync(
                setters => setters.SetProperty(
                    x => x.Status,
                    LibraryCopyStatus.Issued),
                cancellationToken);
        if (copyUpdated != 1)
        {
            throw new InvalidOperationException(
                "That copy was issued by another user. Reload and try again.");
        }

        var issue = new BookIssue
        {
            LibraryCopyId = copy.Id,
            StudentId = studentId,
            IssuedDate = issuedDate,
            DueDate = issuedDate.AddDays(policy.LoanDays),
            IssuedByUserId = userId,
        };
        dbContext.Add(issue);
        auditWriter.Add(
            "library.book.issued",
            nameof(BookIssue),
            issue.Id,
            null,
            new
            {
                issue.LibraryCopyId,
                copy.AccessionNumber,
                Title = copy.LibraryTitle.Title,
                issue.StudentId,
                issue.IssuedDate,
                issue.DueDate,
            });
        await dbContext.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return issue.Id;
    }

    public async Task RenewAsync(
        Guid issueId,
        DateOnly renewalDate,
        CancellationToken cancellationToken)
    {
        var userId = CurrentUserId();
        var policy = await GetPolicyAsync(cancellationToken);
        await using var transaction = await dbContext.Database.BeginTransactionAsync(
            IsolationLevel.Serializable,
            cancellationToken);
        await LockAsync($"library-issue:{issueId}", cancellationToken);

        var issue = await dbContext.Set<BookIssue>()
            .AsNoTracking()
            .Include(x => x.LibraryCopy)
                .ThenInclude(x => x.LibraryTitle)
            .SingleOrDefaultAsync(x => x.Id == issueId, cancellationToken);
        if (issue is null || issue.Status != BookIssueStatus.Issued)
        {
            throw new InvalidOperationException(
                "That book is not currently issued.");
        }

        if (renewalDate > issue.DueDate)
        {
            throw new InvalidOperationException(
                "An overdue book must be returned before it can be issued again.");
        }

        if (issue.RenewalCount >= policy.MaximumRenewals)
        {
            throw new InvalidOperationException(
                $"The maximum of {policy.MaximumRenewals} renewal(s) has been reached.");
        }

        var newDueDate = issue.DueDate.AddDays(policy.LoanDays);
        var updated = await dbContext.Set<BookIssue>()
            .Where(x =>
                x.Id == issue.Id
                && x.Status == BookIssueStatus.Issued
                && x.RenewalCount == issue.RenewalCount)
            .ExecuteUpdateAsync(
                setters => setters
                    .SetProperty(x => x.DueDate, newDueDate)
                    .SetProperty(
                        x => x.RenewalCount,
                        issue.RenewalCount + 1),
                cancellationToken);
        if (updated != 1)
        {
            throw new InvalidOperationException(
                "That loan was changed by another user. Reload and try again.");
        }

        dbContext.Add(new BookRenewal
        {
            BookIssueId = issue.Id,
            PreviousDueDate = issue.DueDate,
            NewDueDate = newDueDate,
            RenewedByUserId = userId,
        });
        auditWriter.Add(
            "library.book.renewed",
            nameof(BookIssue),
            issue.Id,
            new
            {
                issue.DueDate,
                issue.RenewalCount,
            },
            new
            {
                DueDate = newDueDate,
                RenewalCount = issue.RenewalCount + 1,
            });
        await dbContext.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task<BookReturnResult> ReturnAsync(
        Guid issueId,
        DateOnly returnedDate,
        LibraryCopyCondition condition,
        CancellationToken cancellationToken)
    {
        var userId = CurrentUserId();
        var policy = await GetPolicyAsync(cancellationToken);
        await using var transaction = await dbContext.Database.BeginTransactionAsync(
            IsolationLevel.Serializable,
            cancellationToken);
        await LockAsync($"library-issue:{issueId}", cancellationToken);

        var issue = await dbContext.Set<BookIssue>()
            .AsNoTracking()
            .Include(x => x.LibraryCopy)
                .ThenInclude(x => x.LibraryTitle)
            .SingleOrDefaultAsync(x => x.Id == issueId, cancellationToken);
        if (issue is null || issue.Status != BookIssueStatus.Issued)
        {
            throw new InvalidOperationException(
                "That book has already been returned or closed.");
        }

        if (returnedDate < issue.IssuedDate)
        {
            throw new InvalidOperationException(
                "The return date cannot be before the issue date.");
        }

        var daysOverdue = Math.Max(
            0,
            returnedDate.DayNumber - issue.DueDate.DayNumber);
        var fineAmount = decimal.Round(
            daysOverdue * policy.FinePerOverdueDay,
            2,
            MidpointRounding.AwayFromZero);
        var issueUpdated = await dbContext.Set<BookIssue>()
            .Where(x =>
                x.Id == issue.Id
                && x.Status == BookIssueStatus.Issued)
            .ExecuteUpdateAsync(
                setters => setters
                    .SetProperty(x => x.Status, BookIssueStatus.Returned)
                    .SetProperty(x => x.ReturnedDate, returnedDate)
                    .SetProperty(x => x.ReturnedByUserId, userId),
                cancellationToken);
        if (issueUpdated != 1)
        {
            throw new InvalidOperationException(
                "That loan was changed by another user. Reload and try again.");
        }

        var copyStatus = condition == LibraryCopyCondition.Damaged
            ? LibraryCopyStatus.Damaged
            : LibraryCopyStatus.Available;
        await dbContext.Set<LibraryCopy>()
            .Where(x => x.Id == issue.LibraryCopyId)
            .ExecuteUpdateAsync(
                setters => setters
                    .SetProperty(x => x.Status, copyStatus)
                    .SetProperty(x => x.Condition, condition),
                cancellationToken);
        if (fineAmount > 0)
        {
            dbContext.Add(new LibraryFine
            {
                BookIssueId = issue.Id,
                StudentId = issue.StudentId,
                Amount = fineAmount,
                DaysOverdue = daysOverdue,
                Reason = $"{daysOverdue} overdue day(s)",
            });
        }

        auditWriter.Add(
            "library.book.returned",
            nameof(BookIssue),
            issue.Id,
            new { Status = BookIssueStatus.Issued },
            new
            {
                Status = BookIssueStatus.Returned,
                ReturnedDate = returnedDate,
                Condition = condition,
                DaysOverdue = daysOverdue,
                FineAmount = fineAmount,
            });
        await dbContext.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new BookReturnResult(issue.Id, daysOverdue, fineAmount);
    }

    public async Task MarkLostAsync(
        Guid issueId,
        string reason,
        DateOnly lostDate,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(reason) || reason.Trim().Length < 5)
        {
            throw new InvalidOperationException(
                "Enter a loss reason of at least five characters.");
        }

        var userId = CurrentUserId();
        var policy = await GetPolicyAsync(cancellationToken);
        await using var transaction = await dbContext.Database.BeginTransactionAsync(
            IsolationLevel.Serializable,
            cancellationToken);
        await LockAsync($"library-issue:{issueId}", cancellationToken);
        var issue = await dbContext.Set<BookIssue>()
            .AsNoTracking()
            .Include(x => x.Fine)
            .SingleOrDefaultAsync(x => x.Id == issueId, cancellationToken);
        if (issue is null || issue.Status != BookIssueStatus.Issued)
        {
            throw new InvalidOperationException(
                "That book is not currently issued.");
        }

        var daysOverdue = Math.Max(
            0,
            lostDate.DayNumber - issue.DueDate.DayNumber);
        var fineAmount = decimal.Round(
            daysOverdue * policy.FinePerOverdueDay,
            2,
            MidpointRounding.AwayFromZero);
        await dbContext.Set<BookIssue>()
            .Where(x =>
                x.Id == issue.Id
                && x.Status == BookIssueStatus.Issued)
            .ExecuteUpdateAsync(
                setters => setters
                    .SetProperty(x => x.Status, BookIssueStatus.Lost)
                    .SetProperty(x => x.LostByUserId, userId)
                    .SetProperty(x => x.LostAtUtc, DateTimeOffset.UtcNow)
                    .SetProperty(x => x.LossReason, reason.Trim()),
                cancellationToken);
        await dbContext.Set<LibraryCopy>()
            .Where(x => x.Id == issue.LibraryCopyId)
            .ExecuteUpdateAsync(
                setters => setters.SetProperty(
                    x => x.Status,
                    LibraryCopyStatus.Lost),
                cancellationToken);
        if (fineAmount > 0 && issue.Fine is null)
        {
            dbContext.Add(new LibraryFine
            {
                BookIssueId = issue.Id,
                StudentId = issue.StudentId,
                Amount = fineAmount,
                DaysOverdue = daysOverdue,
                Reason = $"{daysOverdue} overdue day(s) before loss",
            });
        }

        auditWriter.Add(
            "library.book.lost",
            nameof(BookIssue),
            issue.Id,
            new { Status = BookIssueStatus.Issued },
            new
            {
                Status = BookIssueStatus.Lost,
                Reason = reason.Trim(),
                DaysOverdue = daysOverdue,
                FineAmount = fineAmount,
            });
        await dbContext.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task SettleFineAsync(
        Guid fineId,
        bool waive,
        string? reason,
        CancellationToken cancellationToken)
    {
        if (waive && (string.IsNullOrWhiteSpace(reason) || reason.Trim().Length < 3))
        {
            throw new InvalidOperationException(
                "Enter a reason for waiving the fine.");
        }

        var userId = CurrentUserId();
        await using var transaction = await dbContext.Database.BeginTransactionAsync(
            IsolationLevel.Serializable,
            cancellationToken);
        await LockAsync($"library-fine:{fineId}", cancellationToken);
        var fine = await dbContext.Set<LibraryFine>()
            .AsNoTracking()
            .SingleOrDefaultAsync(x => x.Id == fineId, cancellationToken);
        if (fine is null || fine.Status != LibraryFineStatus.Pending)
        {
            throw new InvalidOperationException(
                "That fine has already been settled.");
        }

        var newStatus = waive
            ? LibraryFineStatus.Waived
            : LibraryFineStatus.Paid;
        var updated = await dbContext.Set<LibraryFine>()
            .Where(x =>
                x.Id == fine.Id
                && x.Status == LibraryFineStatus.Pending)
            .ExecuteUpdateAsync(
                setters => setters
                    .SetProperty(x => x.Status, newStatus)
                    .SetProperty(x => x.SettledByUserId, userId)
                    .SetProperty(x => x.SettledAtUtc, DateTimeOffset.UtcNow)
                    .SetProperty(
                        x => x.SettlementReason,
                        waive ? reason!.Trim() : null),
                cancellationToken);
        if (updated != 1)
        {
            throw new InvalidOperationException(
                "That fine was settled by another user.");
        }

        auditWriter.Add(
            "library.fine.settled",
            nameof(LibraryFine),
            fine.Id,
            new
            {
                fine.Status,
                fine.Amount,
            },
            new
            {
                Status = newStatus,
                Reason = waive ? reason!.Trim() : null,
            });
        await dbContext.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task<LibraryPolicyValues> GetPolicyAsync(
        CancellationToken cancellationToken)
    {
        var policy = await dbContext.Set<LibraryPolicy>()
            .AsNoTracking()
            .OrderBy(x => x.UpdatedAtUtc)
            .LastOrDefaultAsync(cancellationToken);
        return policy is null
            ? new LibraryPolicyValues(14, 2, 2, 1)
            : new LibraryPolicyValues(
                policy.LoanDays,
                policy.MaximumBooksPerStudent,
                policy.MaximumRenewals,
                policy.FinePerOverdueDay);
    }

    private Task<int> LockAsync(
        string key,
        CancellationToken cancellationToken) =>
        dbContext.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({key}, 0))",
            cancellationToken);

    private Guid CurrentUserId()
    {
        var value = httpContextAccessor.HttpContext?.User.FindFirstValue(
            ClaimTypes.NameIdentifier);
        return Guid.TryParse(value, out var userId)
            ? userId
            : throw new InvalidOperationException(
                "A signed-in user is required for library transactions.");
    }
}
