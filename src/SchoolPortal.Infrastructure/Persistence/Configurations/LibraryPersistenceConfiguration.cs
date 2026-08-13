using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using SchoolPortal.Domain.Library;
using SchoolPortal.Infrastructure.Identity;

namespace SchoolPortal.Infrastructure.Persistence.Configurations;

internal sealed class LibraryAuthorConfiguration
    : IEntityTypeConfiguration<LibraryAuthor>
{
    public void Configure(EntityTypeBuilder<LibraryAuthor> builder)
    {
        builder.ToTable("LibraryAuthors");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Name).HasMaxLength(200).IsRequired();
        builder.HasIndex(x => x.Name).IsUnique();
    }
}

internal sealed class LibraryCategoryConfiguration
    : IEntityTypeConfiguration<LibraryCategory>
{
    public void Configure(EntityTypeBuilder<LibraryCategory> builder)
    {
        builder.ToTable("LibraryCategories");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Name).HasMaxLength(100).IsRequired();
        builder.HasIndex(x => x.Name).IsUnique();
    }
}

internal sealed class LibraryPublisherConfiguration
    : IEntityTypeConfiguration<LibraryPublisher>
{
    public void Configure(EntityTypeBuilder<LibraryPublisher> builder)
    {
        builder.ToTable("LibraryPublishers");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Name).HasMaxLength(200).IsRequired();
        builder.HasIndex(x => x.Name).IsUnique();
    }
}

internal sealed class LibraryTitleConfiguration
    : IEntityTypeConfiguration<LibraryTitle>
{
    public void Configure(EntityTypeBuilder<LibraryTitle> builder)
    {
        builder.ToTable("LibraryTitles");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Title).HasMaxLength(300).IsRequired();
        builder.Property(x => x.Isbn).HasMaxLength(30);
        builder.Property(x => x.ClassificationNumber).HasMaxLength(50);
        builder.Property(x => x.Edition).HasMaxLength(50);
        builder.Property(x => x.Language).HasMaxLength(50).IsRequired();
        builder.Property(x => x.ShelfLocation).HasMaxLength(100);
        builder.Property(x => x.Description).HasMaxLength(1000);
        builder.Property(x => x.Version).IsRowVersion();
        builder.HasIndex(x => x.Isbn).IsUnique();
        builder.HasIndex(x => new { x.Title, x.AuthorId, x.Edition }).IsUnique();
        builder.HasOne(x => x.Author)
            .WithMany(x => x.Titles)
            .HasForeignKey(x => x.AuthorId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(x => x.Category)
            .WithMany(x => x.Titles)
            .HasForeignKey(x => x.CategoryId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(x => x.Publisher)
            .WithMany(x => x.Titles)
            .HasForeignKey(x => x.PublisherId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

internal sealed class LibraryCopyConfiguration
    : IEntityTypeConfiguration<LibraryCopy>
{
    public void Configure(EntityTypeBuilder<LibraryCopy> builder)
    {
        builder.ToTable("LibraryCopies");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.AccessionNumber).HasMaxLength(40).IsRequired();
        builder.Property(x => x.Price).HasPrecision(14, 2);
        builder.Property(x => x.Status).HasConversion<string>().HasMaxLength(30);
        builder.Property(x => x.Condition).HasConversion<string>().HasMaxLength(30);
        builder.Property(x => x.Notes).HasMaxLength(500);
        builder.Property(x => x.Version).IsRowVersion();
        builder.HasIndex(x => x.AccessionNumber).IsUnique();
        builder.HasIndex(x => new { x.LibraryTitleId, x.Status });
        builder.HasOne(x => x.LibraryTitle)
            .WithMany(x => x.Copies)
            .HasForeignKey(x => x.LibraryTitleId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

internal sealed class LibraryPolicyConfiguration
    : IEntityTypeConfiguration<LibraryPolicy>
{
    public void Configure(EntityTypeBuilder<LibraryPolicy> builder)
    {
        builder.ToTable("LibraryPolicies");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.FinePerOverdueDay).HasPrecision(14, 2);
        builder.Property(x => x.Version).IsRowVersion();
        builder.HasOne<ApplicationUser>()
            .WithMany()
            .HasForeignKey(x => x.UpdatedByUserId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

internal sealed class BookIssueConfiguration
    : IEntityTypeConfiguration<BookIssue>
{
    public void Configure(EntityTypeBuilder<BookIssue> builder)
    {
        builder.ToTable("BookIssues");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Status).HasConversion<string>().HasMaxLength(30);
        builder.Property(x => x.LossReason).HasMaxLength(500);
        builder.Property(x => x.Version).IsRowVersion();
        builder.HasIndex(x => new { x.StudentId, x.Status });
        builder.HasIndex(x => new { x.DueDate, x.Status });
        builder.HasIndex(x => x.LibraryCopyId)
            .IsUnique()
            .HasFilter("\"Status\" = 'Issued'");
        builder.HasOne(x => x.LibraryCopy)
            .WithMany(x => x.Issues)
            .HasForeignKey(x => x.LibraryCopyId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(x => x.Student)
            .WithMany()
            .HasForeignKey(x => x.StudentId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<ApplicationUser>()
            .WithMany()
            .HasForeignKey(x => x.IssuedByUserId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<ApplicationUser>()
            .WithMany()
            .HasForeignKey(x => x.ReturnedByUserId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<ApplicationUser>()
            .WithMany()
            .HasForeignKey(x => x.LostByUserId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

internal sealed class BookRenewalConfiguration
    : IEntityTypeConfiguration<BookRenewal>
{
    public void Configure(EntityTypeBuilder<BookRenewal> builder)
    {
        builder.ToTable("BookRenewals");
        builder.HasKey(x => x.Id);
        builder.HasIndex(x => new { x.BookIssueId, x.RenewedAtUtc });
        builder.HasOne(x => x.BookIssue)
            .WithMany(x => x.Renewals)
            .HasForeignKey(x => x.BookIssueId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<ApplicationUser>()
            .WithMany()
            .HasForeignKey(x => x.RenewedByUserId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

internal sealed class LibraryFineConfiguration
    : IEntityTypeConfiguration<LibraryFine>
{
    public void Configure(EntityTypeBuilder<LibraryFine> builder)
    {
        builder.ToTable("LibraryFines");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.Amount).HasPrecision(14, 2);
        builder.Property(x => x.Reason).HasMaxLength(500).IsRequired();
        builder.Property(x => x.Status).HasConversion<string>().HasMaxLength(30);
        builder.Property(x => x.SettlementReason).HasMaxLength(500);
        builder.HasIndex(x => x.BookIssueId).IsUnique();
        builder.HasIndex(x => new { x.StudentId, x.Status });
        builder.HasOne(x => x.BookIssue)
            .WithOne(x => x.Fine)
            .HasForeignKey<LibraryFine>(x => x.BookIssueId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(x => x.Student)
            .WithMany()
            .HasForeignKey(x => x.StudentId)
            .OnDelete(DeleteBehavior.Restrict);
        builder.HasOne<ApplicationUser>()
            .WithMany()
            .HasForeignKey(x => x.SettledByUserId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}
