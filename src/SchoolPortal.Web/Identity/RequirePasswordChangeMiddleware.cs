using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Options;
using SchoolPortal.Infrastructure.Identity;

namespace SchoolPortal.Web.Identity;

public sealed class RequirePasswordChangeMiddleware(RequestDelegate next)
{
    private static readonly PathString ChangePasswordPath = "/Account/ChangePassword";
    private static readonly PathString LogoutPath = "/Account/Logout";

    public async Task InvokeAsync(
        HttpContext context,
        UserManager<ApplicationUser> userManager,
        IOptions<PortalAuthenticationOptions> authenticationOptions)
    {
        var path = context.Request.Path;
        var bypass = path.StartsWithSegments(ChangePasswordPath)
            || path.StartsWithSegments(LogoutPath)
            || path.StartsWithSegments("/health")
            || path.StartsWithSegments("/css")
            || path.StartsWithSegments("/js")
            || path.StartsWithSegments("/lib");

        if (authenticationOptions.Value.RequirePassword
            && !bypass
            && context.User.Identity?.IsAuthenticated == true)
        {
            var user = await userManager.GetUserAsync(context.User);
            if (user?.MustChangePassword == true)
            {
                context.Response.Redirect(ChangePasswordPath);
                return;
            }
        }

        await next(context);
    }
}
