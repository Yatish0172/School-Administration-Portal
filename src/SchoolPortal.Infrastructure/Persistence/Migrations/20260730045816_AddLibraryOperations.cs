using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable
#pragma warning disable CA1861

namespace SchoolPortal.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddLibraryOperations : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateSequence(
                name: "LibraryAccessionNumberSequence",
                schema: "portal");

            migrationBuilder.CreateTable(
                name: "LibraryAuthors",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_LibraryAuthors", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "LibraryCategories",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_LibraryCategories", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "LibraryPolicies",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    LoanDays = table.Column<int>(type: "integer", nullable: false),
                    MaximumBooksPerStudent = table.Column<int>(type: "integer", nullable: false),
                    MaximumRenewals = table.Column<int>(type: "integer", nullable: false),
                    FinePerOverdueDay = table.Column<decimal>(type: "numeric(14,2)", precision: 14, scale: 2, nullable: false),
                    UpdatedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    UpdatedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_LibraryPolicies", x => x.Id);
                    table.ForeignKey(
                        name: "FK_LibraryPolicies_AspNetUsers_UpdatedByUserId",
                        column: x => x.UpdatedByUserId,
                        principalSchema: "portal",
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "LibraryPublishers",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_LibraryPublishers", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "LibraryTitles",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Title = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    AuthorId = table.Column<Guid>(type: "uuid", nullable: false),
                    CategoryId = table.Column<Guid>(type: "uuid", nullable: false),
                    PublisherId = table.Column<Guid>(type: "uuid", nullable: true),
                    Isbn = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: true),
                    ClassificationNumber = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: true),
                    Edition = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: true),
                    PublicationYear = table.Column<int>(type: "integer", nullable: true),
                    Language = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: false),
                    ShelfLocation = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    Description = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    IsActive = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_LibraryTitles", x => x.Id);
                    table.ForeignKey(
                        name: "FK_LibraryTitles_LibraryAuthors_AuthorId",
                        column: x => x.AuthorId,
                        principalSchema: "portal",
                        principalTable: "LibraryAuthors",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_LibraryTitles_LibraryCategories_CategoryId",
                        column: x => x.CategoryId,
                        principalSchema: "portal",
                        principalTable: "LibraryCategories",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_LibraryTitles_LibraryPublishers_PublisherId",
                        column: x => x.PublisherId,
                        principalSchema: "portal",
                        principalTable: "LibraryPublishers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "LibraryCopies",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    LibraryTitleId = table.Column<Guid>(type: "uuid", nullable: false),
                    AccessionNumber = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    PurchaseDate = table.Column<DateOnly>(type: "date", nullable: true),
                    Price = table.Column<decimal>(type: "numeric(14,2)", precision: 14, scale: 2, nullable: true),
                    Status = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    Condition = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    Notes = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_LibraryCopies", x => x.Id);
                    table.ForeignKey(
                        name: "FK_LibraryCopies_LibraryTitles_LibraryTitleId",
                        column: x => x.LibraryTitleId,
                        principalSchema: "portal",
                        principalTable: "LibraryTitles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "BookIssues",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    LibraryCopyId = table.Column<Guid>(type: "uuid", nullable: false),
                    StudentId = table.Column<Guid>(type: "uuid", nullable: false),
                    IssuedDate = table.Column<DateOnly>(type: "date", nullable: false),
                    DueDate = table.Column<DateOnly>(type: "date", nullable: false),
                    ReturnedDate = table.Column<DateOnly>(type: "date", nullable: true),
                    Status = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    RenewalCount = table.Column<int>(type: "integer", nullable: false),
                    IssuedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    ReturnedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    LostByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    LostAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    LossReason = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    CreatedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_BookIssues", x => x.Id);
                    table.ForeignKey(
                        name: "FK_BookIssues_AspNetUsers_IssuedByUserId",
                        column: x => x.IssuedByUserId,
                        principalSchema: "portal",
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_BookIssues_AspNetUsers_LostByUserId",
                        column: x => x.LostByUserId,
                        principalSchema: "portal",
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_BookIssues_AspNetUsers_ReturnedByUserId",
                        column: x => x.ReturnedByUserId,
                        principalSchema: "portal",
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_BookIssues_LibraryCopies_LibraryCopyId",
                        column: x => x.LibraryCopyId,
                        principalSchema: "portal",
                        principalTable: "LibraryCopies",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_BookIssues_Students_StudentId",
                        column: x => x.StudentId,
                        principalSchema: "portal",
                        principalTable: "Students",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "BookRenewals",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    BookIssueId = table.Column<Guid>(type: "uuid", nullable: false),
                    PreviousDueDate = table.Column<DateOnly>(type: "date", nullable: false),
                    NewDueDate = table.Column<DateOnly>(type: "date", nullable: false),
                    RenewedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    RenewedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_BookRenewals", x => x.Id);
                    table.ForeignKey(
                        name: "FK_BookRenewals_AspNetUsers_RenewedByUserId",
                        column: x => x.RenewedByUserId,
                        principalSchema: "portal",
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_BookRenewals_BookIssues_BookIssueId",
                        column: x => x.BookIssueId,
                        principalSchema: "portal",
                        principalTable: "BookIssues",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "LibraryFines",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    BookIssueId = table.Column<Guid>(type: "uuid", nullable: false),
                    StudentId = table.Column<Guid>(type: "uuid", nullable: false),
                    Amount = table.Column<decimal>(type: "numeric(14,2)", precision: 14, scale: 2, nullable: false),
                    DaysOverdue = table.Column<int>(type: "integer", nullable: false),
                    Reason = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    Status = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    SettledByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    SettledAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    SettlementReason = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_LibraryFines", x => x.Id);
                    table.ForeignKey(
                        name: "FK_LibraryFines_AspNetUsers_SettledByUserId",
                        column: x => x.SettledByUserId,
                        principalSchema: "portal",
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_LibraryFines_BookIssues_BookIssueId",
                        column: x => x.BookIssueId,
                        principalSchema: "portal",
                        principalTable: "BookIssues",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_LibraryFines_Students_StudentId",
                        column: x => x.StudentId,
                        principalSchema: "portal",
                        principalTable: "Students",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_BookIssues_DueDate_Status",
                schema: "portal",
                table: "BookIssues",
                columns: new[] { "DueDate", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_BookIssues_IssuedByUserId",
                schema: "portal",
                table: "BookIssues",
                column: "IssuedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_BookIssues_LibraryCopyId",
                schema: "portal",
                table: "BookIssues",
                column: "LibraryCopyId",
                unique: true,
                filter: "\"Status\" = 'Issued'");

            migrationBuilder.CreateIndex(
                name: "IX_BookIssues_LostByUserId",
                schema: "portal",
                table: "BookIssues",
                column: "LostByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_BookIssues_ReturnedByUserId",
                schema: "portal",
                table: "BookIssues",
                column: "ReturnedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_BookIssues_StudentId_Status",
                schema: "portal",
                table: "BookIssues",
                columns: new[] { "StudentId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_BookRenewals_BookIssueId_RenewedAtUtc",
                schema: "portal",
                table: "BookRenewals",
                columns: new[] { "BookIssueId", "RenewedAtUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_BookRenewals_RenewedByUserId",
                schema: "portal",
                table: "BookRenewals",
                column: "RenewedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_LibraryAuthors_Name",
                schema: "portal",
                table: "LibraryAuthors",
                column: "Name",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_LibraryCategories_Name",
                schema: "portal",
                table: "LibraryCategories",
                column: "Name",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_LibraryCopies_AccessionNumber",
                schema: "portal",
                table: "LibraryCopies",
                column: "AccessionNumber",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_LibraryCopies_LibraryTitleId_Status",
                schema: "portal",
                table: "LibraryCopies",
                columns: new[] { "LibraryTitleId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_LibraryFines_BookIssueId",
                schema: "portal",
                table: "LibraryFines",
                column: "BookIssueId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_LibraryFines_SettledByUserId",
                schema: "portal",
                table: "LibraryFines",
                column: "SettledByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_LibraryFines_StudentId_Status",
                schema: "portal",
                table: "LibraryFines",
                columns: new[] { "StudentId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_LibraryPolicies_UpdatedByUserId",
                schema: "portal",
                table: "LibraryPolicies",
                column: "UpdatedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_LibraryPublishers_Name",
                schema: "portal",
                table: "LibraryPublishers",
                column: "Name",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_LibraryTitles_AuthorId",
                schema: "portal",
                table: "LibraryTitles",
                column: "AuthorId");

            migrationBuilder.CreateIndex(
                name: "IX_LibraryTitles_CategoryId",
                schema: "portal",
                table: "LibraryTitles",
                column: "CategoryId");

            migrationBuilder.CreateIndex(
                name: "IX_LibraryTitles_Isbn",
                schema: "portal",
                table: "LibraryTitles",
                column: "Isbn",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_LibraryTitles_PublisherId",
                schema: "portal",
                table: "LibraryTitles",
                column: "PublisherId");

            migrationBuilder.CreateIndex(
                name: "IX_LibraryTitles_Title_AuthorId_Edition",
                schema: "portal",
                table: "LibraryTitles",
                columns: new[] { "Title", "AuthorId", "Edition" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "BookRenewals",
                schema: "portal");

            migrationBuilder.DropTable(
                name: "LibraryFines",
                schema: "portal");

            migrationBuilder.DropTable(
                name: "LibraryPolicies",
                schema: "portal");

            migrationBuilder.DropTable(
                name: "BookIssues",
                schema: "portal");

            migrationBuilder.DropTable(
                name: "LibraryCopies",
                schema: "portal");

            migrationBuilder.DropTable(
                name: "LibraryTitles",
                schema: "portal");

            migrationBuilder.DropTable(
                name: "LibraryAuthors",
                schema: "portal");

            migrationBuilder.DropTable(
                name: "LibraryCategories",
                schema: "portal");

            migrationBuilder.DropTable(
                name: "LibraryPublishers",
                schema: "portal");

            migrationBuilder.DropSequence(
                name: "LibraryAccessionNumberSequence",
                schema: "portal");
        }
    }
}
