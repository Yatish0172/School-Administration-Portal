using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Academics;
using SchoolPortal.Domain.Administration;
using SchoolPortal.Domain.Examinations;
using SchoolPortal.Infrastructure.Persistence;
using SchoolPortal.Web.Administration;
using SchoolPortal.Web.Attendance;
using SchoolPortal.Web.Reporting;

namespace SchoolPortal.Web.Pages.Reports;

[Authorize(Policy = PermissionCatalog.PolicyPrefix + PermissionCatalog.Reports.View)]
public sealed class IndexModel(
    SchoolPortalDbContext dbContext,
    StandardReportService reportService,
    ReportExportService exportService,
    AttendanceAccessService attendanceAccessService,
    AuditWriter auditWriter) : PageModel
{
    [BindProperty(SupportsGet = true)]
    public string? ReportKey { get; set; }

    [BindProperty(SupportsGet = true)]
    public DateOnly? From { get; set; }

    [BindProperty(SupportsGet = true)]
    public DateOnly? To { get; set; }

    [BindProperty(SupportsGet = true)]
    public Guid? AcademicYearId { get; set; }

    [BindProperty(SupportsGet = true)]
    public Guid? SectionId { get; set; }

    [BindProperty(SupportsGet = true)]
    public Guid? ExaminationId { get; set; }

    [BindProperty(SupportsGet = true)]
    public string? Status { get; set; }

    public IReadOnlyList<ReportDefinition> Catalogue { get; private set; } = [];

    public IReadOnlyList<AcademicYear> AcademicYears { get; private set; } = [];

    public IReadOnlyList<Section> Sections { get; private set; } = [];

    public IReadOnlyList<Examination> Examinations { get; private set; } = [];

    public ReportData? Preview { get; private set; }

    public string? ErrorMessage { get; private set; }

    public bool CanExport =>
        User.HasClaim(
            PermissionCatalog.ClaimType,
            PermissionCatalog.Reports.Export);

    public async Task OnGetAsync(CancellationToken cancellationToken)
    {
        await LoadOptionsAsync(cancellationToken);
        if (string.IsNullOrWhiteSpace(ReportKey))
        {
            return;
        }

        try
        {
            Preview = await reportService.BuildAsync(
                ReportKey,
                CreateFilters(),
                User,
                cancellationToken);
        }
        catch (Exception exception) when (
            exception is ReportRowLimitException
                or KeyNotFoundException
                or UnauthorizedAccessException)
        {
            ErrorMessage = exception.Message;
        }
    }

    public async Task<IActionResult> OnGetExportAsync(
        string format,
        CancellationToken cancellationToken)
    {
        if (!CanExport)
        {
            return Forbid();
        }

        if (string.IsNullOrWhiteSpace(ReportKey))
        {
            return BadRequest("Choose a report before exporting.");
        }

        if (!string.Equals(format, "xlsx", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(format, "pdf", StringComparison.OrdinalIgnoreCase))
        {
            return BadRequest("The export format must be xlsx or pdf.");
        }

        try
        {
            var report = await reportService.BuildAsync(
                ReportKey,
                CreateFilters(),
                User,
                cancellationToken);
            var bytes = string.Equals(format, "xlsx", StringComparison.OrdinalIgnoreCase)
                ? exportService.ToExcel(report)
                : exportService.ToPdf(report);
            var auditId = Guid.NewGuid();
            auditWriter.Add(
                report.Definition.IsSensitive
                    ? "report.sensitive-exported"
                    : "report.exported",
                "ReportExport",
                auditId,
                null,
                new
                {
                    report.Definition.Key,
                    Format = format.ToLowerInvariant(),
                    RowCount = report.Rows.Count,
                    report.Definition.IsSensitive,
                    Filters = report.Filters,
                    report.RequestedBy,
                    report.GeneratedAtUtc,
                });
            await dbContext.SaveChangesAsync(cancellationToken);

            var contentType = string.Equals(
                format,
                "xlsx",
                StringComparison.OrdinalIgnoreCase)
                ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                : "application/pdf";
            var filename =
                $"{report.Definition.Key}-{report.GeneratedAtUtc:yyyyMMdd-HHmmss}.{format.ToLowerInvariant()}";
            return File(bytes, contentType, filename);
        }
        catch (UnauthorizedAccessException)
        {
            return Forbid();
        }
        catch (KeyNotFoundException exception)
        {
            return BadRequest(exception.Message);
        }
        catch (ReportRowLimitException exception)
        {
            return BadRequest(exception.Message);
        }
    }

    private ReportFilters CreateFilters() =>
        new(
            From,
            To,
            AcademicYearId,
            SectionId,
            ExaminationId,
            Status);

    private async Task LoadOptionsAsync(CancellationToken cancellationToken)
    {
        Catalogue = reportService.GetAvailable(User);
        AcademicYears = await dbContext.Set<AcademicYear>()
            .AsNoTracking()
            .OrderByDescending(x => x.StartDate)
            .ToListAsync(cancellationToken);

        var sectionQuery = dbContext.Set<Section>()
            .AsNoTracking()
            .Where(x => x.IsActive);
        if (User.IsInRole(RoleCatalog.Teacher))
        {
            var sectionIds = await attendanceAccessService
                .GetAccessibleSectionIdsAsync(User, cancellationToken);
            sectionQuery = sectionQuery.Where(x => sectionIds.Contains(x.Id));
        }

        Sections = await sectionQuery
            .OrderBy(x => x.Class.SortOrder)
            .ThenBy(x => x.Name)
            .Include(x => x.Class)
            .Include(x => x.AcademicYear)
            .ToListAsync(cancellationToken);
        Examinations = await dbContext.Set<Examination>()
            .AsNoTracking()
            .OrderByDescending(x => x.StartDate)
            .ThenBy(x => x.Name)
            .ToListAsync(cancellationToken);
    }
}
