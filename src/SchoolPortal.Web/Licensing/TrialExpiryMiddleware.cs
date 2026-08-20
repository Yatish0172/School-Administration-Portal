using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using SchoolPortal.Domain.Licensing;
using SchoolPortal.Infrastructure.Persistence;

namespace SchoolPortal.Web.Licensing;

public sealed class TrialExpiryMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(
        HttpContext context,
        SchoolPortalDbContext dbContext,
        IOptions<TrialOptions> trialOptions)
    {
        var options = trialOptions.Value;
        if (!options.Enabled || IsInfrastructureRequest(context.Request.Path))
        {
            await next(context);
            return;
        }

        var trial = await dbContext.Set<TrialState>()
            .AsNoTracking()
            .SingleOrDefaultAsync();
        var expiresAtUtc = trial?.FirstRunAtUtc.AddDays(options.DurationDays);
        if (expiresAtUtc is null || DateTimeOffset.UtcNow <= expiresAtUtc)
        {
            await next(context);
            return;
        }

        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        context.Response.ContentType = "text/html; charset=utf-8";
        await context.Response.WriteAsync(BuildExpiredPage(expiresAtUtc.Value));
    }

    private static bool IsInfrastructureRequest(PathString path) =>
        path.StartsWithSegments("/health");

    private static string BuildExpiredPage(DateTimeOffset expiresAtUtc) => $$"""
        <!DOCTYPE html>
        <html lang="en">
        <head>
        <meta charset="utf-8" />
        <title>Trial expired - School Administration Portal</title>
        <style>
            body {
                margin: 0;
                min-height: 100vh;
                display: grid;
                place-items: center;
                font-family: Segoe UI, Arial, sans-serif;
                background: radial-gradient(circle at 82% 2%, rgba(77, 196, 216, 0.14), transparent 24rem), #f3f6fb;
                color: #17233c;
            }
            .card {
                width: min(100%, 480px);
                margin: 1rem;
                padding: 2.25rem;
                border: 1px solid #dfe6ef;
                border-radius: 1.15rem;
                background: #fff;
                box-shadow: 0 24px 60px rgba(35, 51, 81, 0.12);
            }
            .eyebrow {
                margin-bottom: 0.45rem;
                color: #2457c5;
                font-size: 0.75rem;
                font-weight: 800;
                letter-spacing: 0.12em;
                text-transform: uppercase;
            }
            h1 { margin: 0 0 0.75rem; font-size: 1.6rem; letter-spacing: -0.02em; }
            p { color: #667085; line-height: 1.55; }
        </style>
        </head>
        <body>
            <div class="card">
                <p class="eyebrow">Trial period ended</p>
                <h1>This 7-day evaluation has expired</h1>
                <p>
                    The trial period for this installation ended on
                    {{expiresAtUtc.ToLocalTime():dddd, d MMMM yyyy}}.
                    Please contact DeepStation to continue using the School Administration Portal.
                </p>
            </div>
        </body>
        </html>
        """;
}
