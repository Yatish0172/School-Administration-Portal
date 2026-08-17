using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable
#pragma warning disable CA1861

namespace SchoolPortal.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddExaminationsAndMarks : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "Examinations",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    AcademicYearId = table.Column<Guid>(type: "uuid", nullable: false),
                    ClassId = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "character varying(150)", maxLength: 150, nullable: false),
                    Term = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    StartDate = table.Column<DateOnly>(type: "date", nullable: true),
                    EndDate = table.Column<DateOnly>(type: "date", nullable: true),
                    Weightage = table.Column<decimal>(type: "numeric(6,2)", precision: 6, scale: 2, nullable: false),
                    Status = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    MarksEntryOpensAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    MarksEntryClosesAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    PublishedByUserId = table.Column<Guid>(type: "uuid", nullable: true),
                    PublishedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    CreatedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Examinations", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Examinations_AcademicYears_AcademicYearId",
                        column: x => x.AcademicYearId,
                        principalSchema: "portal",
                        principalTable: "AcademicYears",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Examinations_AspNetUsers_PublishedByUserId",
                        column: x => x.PublishedByUserId,
                        principalSchema: "portal",
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Examinations_Classes_ClassId",
                        column: x => x.ClassId,
                        principalSchema: "portal",
                        principalTable: "Classes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "GradeRules",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    AcademicYearId = table.Column<Guid>(type: "uuid", nullable: false),
                    ClassId = table.Column<Guid>(type: "uuid", nullable: false),
                    Grade = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: false),
                    MinimumPercent = table.Column<decimal>(type: "numeric(6,2)", precision: 6, scale: 2, nullable: false),
                    MaximumPercent = table.Column<decimal>(type: "numeric(6,2)", precision: 6, scale: 2, nullable: false),
                    Points = table.Column<decimal>(type: "numeric(6,2)", precision: 6, scale: 2, nullable: true),
                    Description = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_GradeRules", x => x.Id);
                    table.ForeignKey(
                        name: "FK_GradeRules_AcademicYears_AcademicYearId",
                        column: x => x.AcademicYearId,
                        principalSchema: "portal",
                        principalTable: "AcademicYears",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_GradeRules_Classes_ClassId",
                        column: x => x.ClassId,
                        principalSchema: "portal",
                        principalTable: "Classes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "ExaminationStatusChanges",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ExaminationId = table.Column<Guid>(type: "uuid", nullable: false),
                    OldStatus = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    NewStatus = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    Reason = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    ChangedByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    ChangedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ExaminationStatusChanges", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ExaminationStatusChanges_AspNetUsers_ChangedByUserId",
                        column: x => x.ChangedByUserId,
                        principalSchema: "portal",
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_ExaminationStatusChanges_Examinations_ExaminationId",
                        column: x => x.ExaminationId,
                        principalSchema: "portal",
                        principalTable: "Examinations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "ExaminationSubjects",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ExaminationId = table.Column<Guid>(type: "uuid", nullable: false),
                    SubjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    MaximumMarks = table.Column<decimal>(type: "numeric(8,2)", precision: 8, scale: 2, nullable: false),
                    PassMarks = table.Column<decimal>(type: "numeric(8,2)", precision: 8, scale: 2, nullable: false),
                    ExaminationDate = table.Column<DateOnly>(type: "date", nullable: true),
                    StartsAt = table.Column<TimeOnly>(type: "time without time zone", nullable: true),
                    EndsAt = table.Column<TimeOnly>(type: "time without time zone", nullable: true),
                    Weightage = table.Column<decimal>(type: "numeric(6,2)", precision: 6, scale: 2, nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ExaminationSubjects", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ExaminationSubjects_Examinations_ExaminationId",
                        column: x => x.ExaminationId,
                        principalSchema: "portal",
                        principalTable: "Examinations",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_ExaminationSubjects_Subjects_SubjectId",
                        column: x => x.SubjectId,
                        principalSchema: "portal",
                        principalTable: "Subjects",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "StudentMarks",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    ExaminationSubjectId = table.Column<Guid>(type: "uuid", nullable: false),
                    StudentEnrollmentId = table.Column<Guid>(type: "uuid", nullable: false),
                    MarksObtained = table.Column<decimal>(type: "numeric(8,2)", precision: 8, scale: 2, nullable: true),
                    IsAbsent = table.Column<bool>(type: "boolean", nullable: false),
                    Grade = table.Column<string>(type: "character varying(10)", maxLength: 10, nullable: true),
                    Remarks = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    EnteredByUserId = table.Column<Guid>(type: "uuid", nullable: false),
                    EnteredAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    UpdatedAtUtc = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_StudentMarks", x => x.Id);
                    table.ForeignKey(
                        name: "FK_StudentMarks_AspNetUsers_EnteredByUserId",
                        column: x => x.EnteredByUserId,
                        principalSchema: "portal",
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_StudentMarks_ExaminationSubjects_ExaminationSubjectId",
                        column: x => x.ExaminationSubjectId,
                        principalSchema: "portal",
                        principalTable: "ExaminationSubjects",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_StudentMarks_StudentEnrollments_StudentEnrollmentId",
                        column: x => x.StudentEnrollmentId,
                        principalSchema: "portal",
                        principalTable: "StudentEnrollments",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Examinations_AcademicYearId_ClassId_Name",
                schema: "portal",
                table: "Examinations",
                columns: new[] { "AcademicYearId", "ClassId", "Name" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Examinations_ClassId",
                schema: "portal",
                table: "Examinations",
                column: "ClassId");

            migrationBuilder.CreateIndex(
                name: "IX_Examinations_PublishedByUserId",
                schema: "portal",
                table: "Examinations",
                column: "PublishedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_ExaminationStatusChanges_ChangedByUserId",
                schema: "portal",
                table: "ExaminationStatusChanges",
                column: "ChangedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_ExaminationStatusChanges_ExaminationId_ChangedAtUtc",
                schema: "portal",
                table: "ExaminationStatusChanges",
                columns: new[] { "ExaminationId", "ChangedAtUtc" });

            migrationBuilder.CreateIndex(
                name: "IX_ExaminationSubjects_ExaminationId_SubjectId",
                schema: "portal",
                table: "ExaminationSubjects",
                columns: new[] { "ExaminationId", "SubjectId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ExaminationSubjects_SubjectId",
                schema: "portal",
                table: "ExaminationSubjects",
                column: "SubjectId");

            migrationBuilder.CreateIndex(
                name: "IX_GradeRules_AcademicYearId_ClassId_Grade",
                schema: "portal",
                table: "GradeRules",
                columns: new[] { "AcademicYearId", "ClassId", "Grade" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_GradeRules_ClassId",
                schema: "portal",
                table: "GradeRules",
                column: "ClassId");

            migrationBuilder.CreateIndex(
                name: "IX_StudentMarks_EnteredByUserId",
                schema: "portal",
                table: "StudentMarks",
                column: "EnteredByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_StudentMarks_ExaminationSubjectId_StudentEnrollmentId",
                schema: "portal",
                table: "StudentMarks",
                columns: new[] { "ExaminationSubjectId", "StudentEnrollmentId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_StudentMarks_StudentEnrollmentId",
                schema: "portal",
                table: "StudentMarks",
                column: "StudentEnrollmentId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ExaminationStatusChanges",
                schema: "portal");

            migrationBuilder.DropTable(
                name: "GradeRules",
                schema: "portal");

            migrationBuilder.DropTable(
                name: "StudentMarks",
                schema: "portal");

            migrationBuilder.DropTable(
                name: "ExaminationSubjects",
                schema: "portal");

            migrationBuilder.DropTable(
                name: "Examinations",
                schema: "portal");
        }
    }
}
