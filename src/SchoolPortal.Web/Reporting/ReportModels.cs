namespace SchoolPortal.Web.Reporting;

public enum ReportValueKind
{
    Text,
    WholeNumber,
    Number,
    Percentage,
    Date,
    DateTime,
}

public sealed record ReportColumn(
    string Key,
    string Label,
    ReportValueKind Kind = ReportValueKind.Text);

public sealed record ReportDefinition(
    string Key,
    string Name,
    string Module,
    string Description,
    string RequiredPermission,
    bool IsSensitive,
    IReadOnlyList<ReportColumn> Columns);

public sealed record ReportFilters(
    DateOnly? From = null,
    DateOnly? To = null,
    Guid? AcademicYearId = null,
    Guid? SectionId = null,
    Guid? ExaminationId = null,
    string? Status = null)
{
    public IReadOnlyList<string> Describe()
    {
        var values = new List<string>();
        if (From.HasValue)
        {
            values.Add($"From: {From:dd MMM yyyy}");
        }

        if (To.HasValue)
        {
            values.Add($"To: {To:dd MMM yyyy}");
        }

        if (AcademicYearId.HasValue)
        {
            values.Add($"Academic year: {AcademicYearId}");
        }

        if (SectionId.HasValue)
        {
            values.Add($"Section: {SectionId}");
        }

        if (ExaminationId.HasValue)
        {
            values.Add($"Examination: {ExaminationId}");
        }

        if (!string.IsNullOrWhiteSpace(Status))
        {
            values.Add($"Status: {Status}");
        }

        return values.Count == 0 ? ["No optional filters"] : values;
    }
}

public sealed record ReportData(
    ReportDefinition Definition,
    IReadOnlyList<IReadOnlyDictionary<string, object?>> Rows,
    ReportFilters Filters,
    DateTimeOffset GeneratedAtUtc,
    string RequestedBy);

public sealed class ReportingOptions
{
    public const string SectionName = "Reporting";

    public int MaxSynchronousRows { get; set; } = 5000;
}

public sealed class ReportRowLimitException(
    string reportName,
    int limit)
    : InvalidOperationException(
        $"{reportName} exceeds the synchronous limit of {limit:N0} rows. Narrow the filters and run it again.");
