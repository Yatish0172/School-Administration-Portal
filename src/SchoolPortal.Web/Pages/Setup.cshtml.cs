using System.ComponentModel.DataAnnotations;
using System.Data;
using System.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Infrastructure.Identity;
using SchoolPortal.Infrastructure.Persistence;

namespace SchoolPortal.Web.Pages;

[AllowAnonymous]
public sealed class SetupModel(
    SchoolPortalDbContext dbContext,
    UserManager<ApplicationUser> userManager,
    SignInManager<ApplicationUser> signInManager,
    IWebHostEnvironment environment) : PageModel
{
    [BindProperty]
    public SetupInput Input { get; set; } = new();

    public async Task<IActionResult> OnGetAsync()
    {
        if (!IsLocalRequest())
        {
            return NotFound();
        }

        return await userManager.Users.AnyAsync()
            ? RedirectToPage("/Account/Login")
            : Page();
    }

    public async Task<IActionResult> OnPostAsync()
    {
        if (!IsLocalRequest())
        {
            return NotFound();
        }

        if (!ModelState.IsValid)
        {
            return Page();
        }

        await using var transaction = await dbContext.Database
            .BeginTransactionAsync(IsolationLevel.Serializable);
        await dbContext.Database.ExecuteSqlRawAsync(
            "SELECT pg_advisory_xact_lock(8172635401)");

        if (await userManager.Users.AnyAsync())
        {
            await transaction.RollbackAsync();
            ModelState.AddModelError(
                string.Empty,
                "Setup is already complete. Sign in with an administrator account.");
            return Page();
        }

        var user = new ApplicationUser
        {
            UserName = Input.Username.Trim(),
            DisplayName = Input.DisplayName.Trim(),
            IsActive = true,
            MustChangePassword = false,
            LastLoginAtUtc = DateTimeOffset.UtcNow,
        };

        var createResult = await userManager.CreateAsync(user, Input.Password);
        if (!createResult.Succeeded)
        {
            AddErrors(createResult);
            await transaction.RollbackAsync();
            return Page();
        }

        var roleResult = await userManager.AddToRoleAsync(
            user,
            RoleCatalog.SuperAdministrator);
        if (!roleResult.Succeeded)
        {
            AddErrors(roleResult);
            await transaction.RollbackAsync();
            return Page();
        }

        await transaction.CommitAsync();
        await signInManager.SignInAsync(user, isPersistent: false);
        return RedirectToPage("/Index");
    }

    private bool IsLocalRequest()
    {
        var address = HttpContext.Connection.RemoteIpAddress;
        return address is not null
            ? IPAddress.IsLoopback(address)
            : environment.IsDevelopment();
    }

    private void AddErrors(IdentityResult result)
    {
        foreach (var error in result.Errors)
        {
            ModelState.AddModelError(string.Empty, error.Description);
        }
    }

    public sealed class SetupInput
    {
        [Required, StringLength(200)]
        [Display(Name = "Full name")]
        public string DisplayName { get; set; } = string.Empty;

        [Required, StringLength(100, MinimumLength = 3)]
        [RegularExpression(
            "^[A-Za-z0-9._-]+$",
            ErrorMessage = "Use only letters, numbers, dot, underscore, or hyphen.")]
        public string Username { get; set; } = string.Empty;

        [Required, DataType(DataType.Password), MinLength(8)]
        public string Password { get; set; } = string.Empty;

        [Required, DataType(DataType.Password)]
        [Compare(nameof(Password), ErrorMessage = "Passwords do not match.")]
        [Display(Name = "Confirm password")]
        public string ConfirmPassword { get; set; } = string.Empty;
    }
}
