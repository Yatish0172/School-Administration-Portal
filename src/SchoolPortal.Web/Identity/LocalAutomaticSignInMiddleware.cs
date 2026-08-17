using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Infrastructure.Identity;

namespace SchoolPortal.Web.Identity;

public sealed class LocalAutomaticSignInMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(
        HttpContext context,
        UserManager<ApplicationUser> userManager,
        SignInManager<ApplicationUser> signInManager,
        IOptions<PortalAuthenticationOptions> authenticationOptions)
    {
        if (!authenticationOptions.Value.BypassLogin
            || context.User.Identity?.IsAuthenticated == true
            || IsInfrastructureRequest(context.Request.Path))
        {
            await next(context);
            return;
        }

        var administrators = await userManager.GetUsersInRoleAsync(
            RoleCatalog.SuperAdministrator);
        var user = administrators.FirstOrDefault(x => x.IsActive)
            ?? await userManager.Users
                .Where(x => x.IsActive)
                .OrderBy(x => x.UserName)
                .FirstOrDefaultAsync();
        if (user is null)
        {
            await next(context);
            return;
        }

        await signInManager.SignInAsync(user, isPersistent: false);
        context.Response.Redirect(
            $"{context.Request.PathBase}{context.Request.Path}{context.Request.QueryString}");
    }

    private static bool IsInfrastructureRequest(PathString path) =>
        path.StartsWithSegments("/health")
        || path.StartsWithSegments("/css")
        || path.StartsWithSegments("/js")
        || path.StartsWithSegments("/lib")
        || path.StartsWithSegments("/_framework");
}
