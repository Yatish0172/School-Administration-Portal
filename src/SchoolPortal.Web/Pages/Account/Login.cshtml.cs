using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using SchoolPortal.Infrastructure.Identity;
using SchoolPortal.Web.Identity;

namespace SchoolPortal.Web.Pages.Account;

[AllowAnonymous]
public sealed class LoginModel(
    UserManager<ApplicationUser> userManager,
    SignInManager<ApplicationUser> signInManager,
    IOptions<PortalAuthenticationOptions> authenticationOptions) : PageModel
{
    public bool PasswordRequired => authenticationOptions.Value.RequirePassword;

    [BindProperty]
    public LoginInput Input { get; set; } = new();

    [TempData]
    public string? StatusMessage { get; set; }

    public async Task<IActionResult> OnGetAsync(string? returnUrl = null)
    {
        if (User.Identity?.IsAuthenticated == true)
        {
            return RedirectToPage("/Index");
        }

        if (!await userManager.Users.AnyAsync())
        {
            return RedirectToPage("/Setup");
        }

        Input.ReturnUrl = returnUrl;
        return Page();
    }

    public async Task<IActionResult> OnPostAsync()
    {
        if (!ModelState.IsValid)
        {
            return Page();
        }

        var username = Input.Username.Trim();
        var user = await userManager.FindByNameAsync(username);
        if (user is not null && !user.IsActive)
        {
            ModelState.AddModelError(string.Empty, "This account is disabled.");
            return Page();
        }

        Microsoft.AspNetCore.Identity.SignInResult result;
        if (PasswordRequired)
        {
            if (string.IsNullOrWhiteSpace(Input.Password))
            {
                ModelState.AddModelError(
                    $"{nameof(Input)}.{nameof(Input.Password)}",
                    "Password is required.");
                return Page();
            }

            result = await signInManager.PasswordSignInAsync(
                username,
                Input.Password,
                isPersistent: false,
                lockoutOnFailure: true);
        }
        else if (user is not null)
        {
            await signInManager.SignInAsync(user, isPersistent: false);
            result = Microsoft.AspNetCore.Identity.SignInResult.Success;
        }
        else
        {
            result = Microsoft.AspNetCore.Identity.SignInResult.Failed;
        }

        if (result.Succeeded)
        {
            user = await userManager.FindByNameAsync(username);
            if (user is not null)
            {
                user.LastLoginAtUtc = DateTimeOffset.UtcNow;
                await userManager.UpdateAsync(user);
            }

            return LocalRedirect(Input.ReturnUrl ?? Url.Page("/Index")!);
        }

        if (result.IsLockedOut)
        {
            ModelState.AddModelError(
                string.Empty,
                "Account locked after repeated failed attempts. Try again in 15 minutes.");
            return Page();
        }

        ModelState.AddModelError(string.Empty, "Invalid username or password.");
        return Page();
    }

    public sealed class LoginInput
    {
        [Required]
        public string Username { get; set; } = string.Empty;

        [DataType(DataType.Password)]
        public string Password { get; set; } = string.Empty;

        public string? ReturnUrl { get; set; }
    }
}
