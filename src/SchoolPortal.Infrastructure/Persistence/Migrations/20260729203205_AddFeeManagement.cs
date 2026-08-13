using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable
#pragma warning disable CA1861

namespace SchoolPortal.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddFeeManagement : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateSequence(
                name: "FeeReceiptNumberSequence",
                schema: "portal");

            migrationBuilder.CreateTable(
                name: "FeeHeads",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Code = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    Name = table.Column<string>(type: "character varying(150)", maxLength: 150, nullable: false),
                    Description = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    IsRefundable = table.Column<bool>(type: "boolean", nullable: false),
                    IsActive = table.Column<bool>(type: "boolean", nullable: false),
                    SortOrder = table.Column<int>(type: "integer", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_FeeHeads", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "FeePayments",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    StudentEnrollmentId = table.Column<Guid>(type: "uuid", nullable: false),
                    PaymentDate = table.Column<DateOnly>(type: "date", nullable: false),
                    Mode = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    Reference = table.Column<string>(type: "character varying(150)", maxLength: 150, nullable: true),
                    BankName = table.Column<string>(type: "character varying(150)", maxLength: 150, nullable: true),
                    Remarks = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    Amount = table.Column<decimal>(type: "numeric(14,2)", precision: 14, scale: 2, nullable: false),
                    Status = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    IdempotencyKey = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    PostedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    PostedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_FeePayments", x => x.Id);
                    table.ForeignKey(
                        name: "FK_FeePayments_AspNetUsers_PostedByUserId",
                        column: x => x.PostedByUserId,
                        principalSchema: "portal",
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_FeePayments_StudentEnrollments_StudentEnrollmentId",
                        column: x => x.StudentEnrollmentId,
                        principalSchema: "portal",
                        principalTable: "StudentEnrollments",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "FeePlans",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    AcademicYearId = table.Column<Guid>(type: "uuid", nullable: false),
                    ClassId = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "character varying(150)", maxLength: 150, nullable: false),
                    IsActive = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_FeePlans", x => x.Id);
                    table.ForeignKey(
                        name: "FK_FeePlans_AcademicYears_AcademicYearId",
                        column: x => x.AcademicYearId,
                        principalSchema: "portal",
                        principalTable: "AcademicYears",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_FeePlans_Classes_ClassId",
                        column: x => x.ClassId,
                        principalSchema: "portal",
                        principalTable: "Classes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "FeePaymentReversals",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    FeePaymentId = table.Column<Guid>(type: "uuid", nullable: false),
                    Reason = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    ReversedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    ReversedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_FeePaymentReversals", x => x.Id);
                    table.ForeignKey(
                        name: "FK_FeePaymentReversals_AspNetUsers_ReversedByUserId",
                        column: x => x.ReversedByUserId,
                        principalSchema: "portal",
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_FeePaymentReversals_FeePayments_FeePaymentId",
                        column: x => x.FeePaymentId,
                        principalSchema: "portal",
                        principalTable: "FeePayments",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "FeeReceipts",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    FeePaymentId = table.Column<Guid>(type: "uuid", nullable: false),
                    ReceiptNumber = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    IssuedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    PrintCount = table.Column<int>(type: "integer", nullable: false),
                    LastPrintedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_FeeReceipts", x => x.Id);
                    table.ForeignKey(
                        name: "FK_FeeReceipts_FeePayments_FeePaymentId",
                        column: x => x.FeePaymentId,
                        principalSchema: "portal",
                        principalTable: "FeePayments",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "FeePlanItems",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    FeePlanId = table.Column<Guid>(type: "uuid", nullable: false),
                    FeeHeadId = table.Column<Guid>(type: "uuid", nullable: false),
                    Period = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    Amount = table.Column<decimal>(type: "numeric(14,2)", precision: 14, scale: 2, nullable: false),
                    DueDate = table.Column<DateOnly>(type: "date", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_FeePlanItems", x => x.Id);
                    table.ForeignKey(
                        name: "FK_FeePlanItems_FeeHeads_FeeHeadId",
                        column: x => x.FeeHeadId,
                        principalSchema: "portal",
                        principalTable: "FeeHeads",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_FeePlanItems_FeePlans_FeePlanId",
                        column: x => x.FeePlanId,
                        principalSchema: "portal",
                        principalTable: "FeePlans",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "StudentCharges",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    StudentEnrollmentId = table.Column<Guid>(type: "uuid", nullable: false),
                    FeeHeadId = table.Column<Guid>(type: "uuid", nullable: false),
                    FeePlanItemId = table.Column<Guid>(type: "uuid", nullable: true),
                    Description = table.Column<string>(type: "character varying(250)", maxLength: 250, nullable: false),
                    Period = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    Amount = table.Column<decimal>(type: "numeric(14,2)", precision: 14, scale: 2, nullable: false),
                    DueDate = table.Column<DateOnly>(type: "date", nullable: false),
                    Status = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    CreatedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_StudentCharges", x => x.Id);
                    table.ForeignKey(
                        name: "FK_StudentCharges_AspNetUsers_CreatedByUserId",
                        column: x => x.CreatedByUserId,
                        principalSchema: "portal",
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_StudentCharges_FeeHeads_FeeHeadId",
                        column: x => x.FeeHeadId,
                        principalSchema: "portal",
                        principalTable: "FeeHeads",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_StudentCharges_FeePlanItems_FeePlanItemId",
                        column: x => x.FeePlanItemId,
                        principalSchema: "portal",
                        principalTable: "FeePlanItems",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_StudentCharges_StudentEnrollments_StudentEnrollmentId",
                        column: x => x.StudentEnrollmentId,
                        principalSchema: "portal",
                        principalTable: "StudentEnrollments",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "FeeConcessions",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    StudentChargeId = table.Column<Guid>(type: "uuid", nullable: false),
                    Amount = table.Column<decimal>(type: "numeric(14,2)", precision: 14, scale: 2, nullable: false),
                    Reason = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    ApprovedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    ApprovedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_FeeConcessions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_FeeConcessions_AspNetUsers_ApprovedByUserId",
                        column: x => x.ApprovedByUserId,
                        principalSchema: "portal",
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_FeeConcessions_StudentCharges_StudentChargeId",
                        column: x => x.StudentChargeId,
                        principalSchema: "portal",
                        principalTable: "StudentCharges",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "FeePaymentAllocations",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    FeePaymentId = table.Column<Guid>(type: "uuid", nullable: false),
                    StudentChargeId = table.Column<Guid>(type: "uuid", nullable: false),
                    Amount = table.Column<decimal>(type: "numeric(14,2)", precision: 14, scale: 2, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_FeePaymentAllocations", x => x.Id);
                    table.ForeignKey(
                        name: "FK_FeePaymentAllocations_FeePayments_FeePaymentId",
                        column: x => x.FeePaymentId,
                        principalSchema: "portal",
                        principalTable: "FeePayments",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_FeePaymentAllocations_StudentCharges_StudentChargeId",
                        column: x => x.StudentChargeId,
                        principalSchema: "portal",
                        principalTable: "StudentCharges",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_FeeConcessions_ApprovedByUserId",
                schema: "portal",
                table: "FeeConcessions",
                column: "ApprovedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_FeeConcessions_StudentChargeId",
                schema: "portal",
                table: "FeeConcessions",
                column: "StudentChargeId");

            migrationBuilder.CreateIndex(
                name: "IX_FeeHeads_Code",
                schema: "portal",
                table: "FeeHeads",
                column: "Code",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_FeeHeads_Name",
                schema: "portal",
                table: "FeeHeads",
                column: "Name",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_FeePaymentAllocations_FeePaymentId_StudentChargeId",
                schema: "portal",
                table: "FeePaymentAllocations",
                columns: new[] { "FeePaymentId", "StudentChargeId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_FeePaymentAllocations_StudentChargeId",
                schema: "portal",
                table: "FeePaymentAllocations",
                column: "StudentChargeId");

            migrationBuilder.CreateIndex(
                name: "IX_FeePaymentReversals_FeePaymentId",
                schema: "portal",
                table: "FeePaymentReversals",
                column: "FeePaymentId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_FeePaymentReversals_ReversedByUserId",
                schema: "portal",
                table: "FeePaymentReversals",
                column: "ReversedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_FeePayments_IdempotencyKey",
                schema: "portal",
                table: "FeePayments",
                column: "IdempotencyKey",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_FeePayments_PostedByUserId",
                schema: "portal",
                table: "FeePayments",
                column: "PostedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_FeePayments_StudentEnrollmentId_PaymentDate",
                schema: "portal",
                table: "FeePayments",
                columns: new[] { "StudentEnrollmentId", "PaymentDate" });

            migrationBuilder.CreateIndex(
                name: "IX_FeePlanItems_FeeHeadId",
                schema: "portal",
                table: "FeePlanItems",
                column: "FeeHeadId");

            migrationBuilder.CreateIndex(
                name: "IX_FeePlanItems_FeePlanId_FeeHeadId_Period_DueDate",
                schema: "portal",
                table: "FeePlanItems",
                columns: new[] { "FeePlanId", "FeeHeadId", "Period", "DueDate" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_FeePlans_AcademicYearId_ClassId_Name",
                schema: "portal",
                table: "FeePlans",
                columns: new[] { "AcademicYearId", "ClassId", "Name" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_FeePlans_ClassId",
                schema: "portal",
                table: "FeePlans",
                column: "ClassId");

            migrationBuilder.CreateIndex(
                name: "IX_FeeReceipts_FeePaymentId",
                schema: "portal",
                table: "FeeReceipts",
                column: "FeePaymentId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_FeeReceipts_ReceiptNumber",
                schema: "portal",
                table: "FeeReceipts",
                column: "ReceiptNumber",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_StudentCharges_CreatedByUserId",
                schema: "portal",
                table: "StudentCharges",
                column: "CreatedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_StudentCharges_FeeHeadId",
                schema: "portal",
                table: "StudentCharges",
                column: "FeeHeadId");

            migrationBuilder.CreateIndex(
                name: "IX_StudentCharges_FeePlanItemId",
                schema: "portal",
                table: "StudentCharges",
                column: "FeePlanItemId");

            migrationBuilder.CreateIndex(
                name: "IX_StudentCharges_StudentEnrollmentId_DueDate",
                schema: "portal",
                table: "StudentCharges",
                columns: new[] { "StudentEnrollmentId", "DueDate" });

            migrationBuilder.CreateIndex(
                name: "IX_StudentCharges_StudentEnrollmentId_FeePlanItemId",
                schema: "portal",
                table: "StudentCharges",
                columns: new[] { "StudentEnrollmentId", "FeePlanItemId" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "FeeConcessions",
                schema: "portal");

            migrationBuilder.DropTable(
                name: "FeePaymentAllocations",
                schema: "portal");

            migrationBuilder.DropTable(
                name: "FeePaymentReversals",
                schema: "portal");

            migrationBuilder.DropTable(
                name: "FeeReceipts",
                schema: "portal");

            migrationBuilder.DropTable(
                name: "StudentCharges",
                schema: "portal");

            migrationBuilder.DropTable(
                name: "FeePayments",
                schema: "portal");

            migrationBuilder.DropTable(
                name: "FeePlanItems",
                schema: "portal");

            migrationBuilder.DropTable(
                name: "FeeHeads",
                schema: "portal");

            migrationBuilder.DropTable(
                name: "FeePlans",
                schema: "portal");

            migrationBuilder.DropSequence(
                name: "FeeReceiptNumberSequence",
                schema: "portal");
        }
    }
}
