using System.Text;
using SchoolPortal.Web.Reporting;

namespace SchoolPortal.Tests;

public sealed class ReportExportServiceTests
{
    [Fact]
    public void CsvExportUsesUtf8HeadersFormattingAndFormulaProtection()
    {
        var definition = new ReportDefinition(
            "test-report",
            "Test report",
            "Tests",
            "Export verification",
            "reports.view",
            false,
            [
                new("student", "Student"),
                new("amount", "Amount", ReportValueKind.Number),
                new("date", "Date", ReportValueKind.Date),
            ]);
        var report = new ReportData(
            definition,
            [
                new Dictionary<string, object?>
                {
                    ["student"] = "=CMD",
                    ["amount"] = 125.5m,
                    ["date"] = new DateOnly(2026, 8, 19),
                },
            ],
            new ReportFilters(),
            new DateTimeOffset(2026, 8, 19, 10, 0, 0, TimeSpan.Zero),
            "Test user");

        var bytes = new ReportExportService().ToCsv(report);
        var csv = Encoding.UTF8.GetString(bytes);

        Assert.StartsWith("\uFEFF", csv);
        Assert.Contains("\"Student\",\"Amount\",\"Date\"", csv);
        Assert.Contains("\"'=CMD\",\"125.50\",\"19 Aug 2026\"", csv);
    }

    [Fact]
    public void PdfAndExcelExportsProduceExpectedDocumentFormats()
    {
        var definition = new ReportDefinition(
            "format-report",
            "Format report",
            "Tests",
            "Document verification",
            "reports.view",
            false,
            [
                new("student", "Student"),
                new("amount", "Amount", ReportValueKind.Number),
            ]);
        var report = new ReportData(
            definition,
            [
                new Dictionary<string, object?>
                {
                    ["student"] = "Asha Sharma",
                    ["amount"] = 250m,
                },
            ],
            new ReportFilters(),
            DateTimeOffset.UtcNow,
            "Test user");
        var exporter = new ReportExportService();

        var pdf = exporter.ToPdf(report);
        Assert.True(pdf.Length > 500);
        Assert.Equal("%PDF", Encoding.ASCII.GetString(pdf, 0, 4));

        var excel = exporter.ToExcel(report);
        Assert.True(excel.Length > 500);
        Assert.Equal((byte)'P', excel[0]);
        Assert.Equal((byte)'K', excel[1]);
    }
}
