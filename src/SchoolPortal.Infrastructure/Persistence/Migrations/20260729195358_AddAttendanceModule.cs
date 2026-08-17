using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable
#pragma warning disable CA1861

namespace SchoolPortal.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddAttendanceModule : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "AttendanceSessions",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    AcademicYearId = table.Column<Guid>(type: "uuid", nullable: false),
                    SectionId = table.Column<Guid>(type: "uuid", nullable: false),
                    Date = table.Column<DateOnly>(type: "date", nullable: false),
                    PeriodNumber = table.Column<int>(type: "integer", nullable: false),
                    MarkedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    MarkedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AttendanceSessions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_AttendanceSessions_AcademicYears_AcademicYearId",
                        column: x => x.AcademicYearId,
                        principalSchema: "portal",
                        principalTable: "AcademicYears",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_AttendanceSessions_AspNetUsers_MarkedByUserId",
                        column: x => x.MarkedByUserId,
                        principalSchema: "portal",
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_AttendanceSessions_Sections_SectionId",
                        column: x => x.SectionId,
                        principalSchema: "portal",
                        principalTable: "Sections",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "AttendanceEntries",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    AttendanceSessionId = table.Column<Guid>(type: "uuid", nullable: false),
                    StudentEnrollmentId = table.Column<Guid>(type: "uuid", nullable: false),
                    Status = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    Reason = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    MarkedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    MarkedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AttendanceEntries", x => x.Id);
                    table.ForeignKey(
                        name: "FK_AttendanceEntries_AspNetUsers_MarkedByUserId",
                        column: x => x.MarkedByUserId,
                        principalSchema: "portal",
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_AttendanceEntries_AttendanceSessions_AttendanceSessionId",
                        column: x => x.AttendanceSessionId,
                        principalSchema: "portal",
                        principalTable: "AttendanceSessions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_AttendanceEntries_StudentEnrollments_StudentEnrollmentId",
                        column: x => x.StudentEnrollmentId,
                        principalSchema: "portal",
                        principalTable: "StudentEnrollments",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "AttendanceCorrections",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    AttendanceEntryId = table.Column<Guid>(type: "uuid", nullable: false),
                    OldStatus = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    NewStatus = table.Column<string>(type: "character varying(20)", maxLength: 20, nullable: false),
                    Reason = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    CorrectedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    CorrectedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AttendanceCorrections", x => x.Id);
                    table.ForeignKey(
                        name: "FK_AttendanceCorrections_AspNetUsers_CorrectedByUserId",
                        column: x => x.CorrectedByUserId,
                        principalSchema: "portal",
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_AttendanceCorrections_AttendanceEntries_AttendanceEntryId",
                        column: x => x.AttendanceEntryId,
                        principalSchema: "portal",
                        principalTable: "AttendanceEntries",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AttendanceCorrections_AttendanceEntryId_CorrectedAtUtc",
                schema: "portal",
                table: "AttendanceCorrections",
                columns: new[] { "AttendanceEntryId", "CorrectedAtUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_AttendanceCorrections_CorrectedByUserId",
                schema: "portal",
                table: "AttendanceCorrections",
                column: "CorrectedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_AttendanceEntries_AttendanceSessionId_StudentEnrollmentId",
                schema: "portal",
                table: "AttendanceEntries",
                columns: new[] { "AttendanceSessionId", "StudentEnrollmentId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_AttendanceEntries_MarkedByUserId",
                schema: "portal",
                table: "AttendanceEntries",
                column: "MarkedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_AttendanceEntries_StudentEnrollmentId",
                schema: "portal",
                table: "AttendanceEntries",
                column: "StudentEnrollmentId");

            migrationBuilder.CreateIndex(
                name: "IX_AttendanceSessions_AcademicYearId_SectionId_Date_PeriodNumb~",
                schema: "portal",
                table: "AttendanceSessions",
                columns: new[] { "AcademicYearId", "SectionId", "Date", "PeriodNumber" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_AttendanceSessions_MarkedByUserId",
                schema: "portal",
                table: "AttendanceSessions",
                column: "MarkedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_AttendanceSessions_SectionId",
                schema: "portal",
                table: "AttendanceSessions",
                column: "SectionId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AttendanceCorrections",
                schema: "portal");

            migrationBuilder.DropTable(
                name: "AttendanceEntries",
                schema: "portal");

            migrationBuilder.DropTable(
                name: "AttendanceSessions",
                schema: "portal");
        }
    }
}
