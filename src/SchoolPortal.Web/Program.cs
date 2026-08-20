using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using SchoolPortal.Infrastructure;
using SchoolPortal.Infrastructure.Persistence;
using SchoolPortal.Web.Attendance;
using SchoolPortal.Web.Authorization;
using SchoolPortal.Web.Examinations;
using SchoolPortal.Web.Identity;
using SchoolPortal.Web.Reporting;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorPages(options =>
{
    options.Conventions.AuthorizeFolder("/");
    options.Conventions.AllowAnonymousToPage("/Setup");
    options.Conventions.AllowAnonymousToPage("/Account/Login");
    options.Conventions.AllowAnonymousToPage("/Error");
});
builder.Services.AddInfrastructure(builder.Configuration);
builder.Services
    .AddAuthentication(IdentityConstants.ApplicationScheme)
    .AddIdentityCookies(options =>
    {
        options.ApplicationCookie!.Configure(cookie =>
        {
            cookie.Cookie.Name = "SchoolPortal.Session";
            cookie.Cookie.HttpOnly = true;
            cookie.Cookie.SameSite = SameSiteMode.Lax;
            cookie.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
            cookie.LoginPath = "/Account/Login";
            cookie.AccessDeniedPath = "/Account/AccessDenied";
            cookie.ExpireTimeSpan = TimeSpan.FromMinutes(20);
            cookie.SlidingExpiration = true;
        });
    });
builder.Services.AddAuthorization();
builder.Services.AddHttpContextAccessor();
builder.Services.Configure<PortalAuthenticationOptions>(
    builder.Configuration.GetSection(PortalAuthenticationOptions.SectionName));
builder.Services.AddScoped<SchoolPortal.Web.Administration.AuditWriter>();
builder.Services.Configure<AttendanceOptions>(
    builder.Configuration.GetSection(AttendanceOptions.SectionName));
builder.Services.AddScoped<AttendanceAccessService>();
builder.Services.AddScoped<MarkAccessService>();
builder.Services.AddScoped<SchoolPortal.Web.Fees.FeePostingService>();
builder.Services.AddScoped<SchoolPortal.Web.Library.LibraryCirculationService>();
builder.Services.Configure<ReportingOptions>(
    builder.Configuration.GetSection(ReportingOptions.SectionName));
builder.Services.AddScoped<StandardReportService>();
builder.Services.AddScoped<ReportExportService>();
builder.Services.AddSingleton<IAuthorizationPolicyProvider, PermissionPolicyProvider>();
builder.Services.AddScoped<IAuthorizationHandler, PermissionAuthorizationHandler>();
builder.Services.Configure<SchoolPortal.Web.Licensing.TrialOptions>(
    builder.Configuration.GetSection(SchoolPortal.Web.Licensing.TrialOptions.SectionName));

var app = builder.Build();

await app.Services.InitializeSchoolPortalDatabaseAsync();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error");
    app.UseHsts();
}

app.UseHttpsRedirection();
app.UseRouting();
app.UseMiddleware<SchoolPortal.Web.Licensing.TrialExpiryMiddleware>();
app.UseAuthentication();
app.UseMiddleware<LocalAutomaticSignInMiddleware>();
app.UseMiddleware<RequirePasswordChangeMiddleware>();
app.UseAuthorization();

app.MapStaticAssets();
app.MapRazorPages()
   .WithStaticAssets();

app.MapHealthChecks("/health/live", new HealthCheckOptions
{
    Predicate = _ => false,
    ResponseWriter = WriteHealthResponse,
})
.AllowAnonymous();

app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready"),
    ResponseWriter = WriteHealthResponse,
})
.AllowAnonymous();

app.Run();

static async Task WriteHealthResponse(HttpContext context, HealthReport report)
{
    context.Response.ContentType = "application/json";

    var payload = new
    {
        status = report.Status.ToString().ToLowerInvariant(),
        time = DateTimeOffset.UtcNow,
        checks = report.Entries.Select(entry => new
        {
            name = entry.Key,
            status = entry.Value.Status.ToString().ToLowerInvariant(),
            durationMs = entry.Value.Duration.TotalMilliseconds,
        }),
    };

    await context.Response.WriteAsync(JsonSerializer.Serialize(payload));
}

public partial class Program;