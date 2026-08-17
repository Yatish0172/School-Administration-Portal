using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace SchoolPortal.Infrastructure.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class AddAcademicBreakPeriods : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "AcademicBreakPeriods",
                schema: "portal",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    Scope = table.Column<string>(type: "character varying(30)", maxLength: 30, nullable: false),
                    FromClassId = table.Column<Guid>(type: "uuid", nullable: true),
                    ToClassId = table.Column<Guid>(type: "uuid", nullable: true),
                    StartsAt = table.Column<TimeOnly>(type: "time without time zone", nullable: false),
                    EndsAt = table.Column<TimeOnly>(type: "time without time zone", nullable: false),
                    IsActive = table.Column<bool>(type: "boolean", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AcademicBreakPeriods", x => x.Id);
                    table.ForeignKey(
                        name: "FK_AcademicBreakPeriods_Classes_FromClassId",
                        column: x => x.FromClassId,
                        principalSchema: "portal",
                        principalTable: "Classes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_AcademicBreakPeriods_Classes_ToClassId",
                        column: x => x.ToClassId,
                        principalSchema: "portal",
                        principalTable: "Classes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AcademicBreakPeriods_FromClassId",
                schema: "portal",
                table: "AcademicBreakPeriods",
                column: "FromClassId");

            migrationBuilder.CreateIndex(
                name: "IX_AcademicBreakPeriods_Name_StartsAt_FromClassId_ToClassId",
                schema: "portal",
                table: "AcademicBreakPeriods",
                columns: ["Name", "StartsAt", "FromClassId", "ToClassId"],
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_AcademicBreakPeriods_ToClassId",
                schema: "portal",
                table: "AcademicBreakPeriods",
                column: "ToClassId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AcademicBreakPeriods",
                schema: "portal");
        }
    }
}
