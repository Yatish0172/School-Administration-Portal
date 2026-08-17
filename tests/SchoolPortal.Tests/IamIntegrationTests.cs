using System.Net;
using System.Security.Claims;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Infrastructure.Identity;
using SchoolPortal.Infrastructure.Persistence;

namespace SchoolPortal.Tests;

public sealed partial class IamIntegrationTests(
    WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task AnonymousDashboardRequestRedirectsToLogin()
    {
        using var client = CreateClient();

        using var response = await client.GetAsync("/");

        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        Assert.Equal(
            "/Account/Login",
            response.Headers.Location?.AbsolutePath);
    }

    [Fact]
    public async Task LocalBypassSkipsTheLoginScreen()
    {
        var account = await CreateUserAsync(mustChangePassword: false);
        try
        {
            using var localFactory = factory.WithWebHostBuilder(builder =>
                builder.ConfigureAppConfiguration((_, configuration) =>
                    configuration.AddInMemoryCollection(
                        new Dictionary<string, string?>
                        {
                            ["Authentication:BypassLogin"] = "true",
                            ["Authentication:RequirePassword"] = "false",
                        })));
            using var client = localFactory.CreateClient(
                new WebApplicationFactoryClientOptions
                {
                    AllowAutoRedirect = true,
                    HandleCookies = true,
                });

            using var response = await client.GetAsync("/");

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var html = await response.Content.ReadAsStringAsync();
            Assert.DoesNotContain("Welcome back", html);
            Assert.Contains("Dashboard", html);
        }
        finally
        {
            await DeleteUserAsync(account.Username);
        }
    }
    [Fact]
    public async Task SeededRolesContainTheCompletePermissionCatalogue()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<SchoolPortalDbContext>();
        var roleManager = scope.ServiceProvider
            .GetRequiredService<RoleManager<IdentityRole<Guid>>>();

        var permissionKeys = await dbContext.Permissions
            .Select(x => x.Key)
            .ToListAsync();
        Assert.Equal(
            PermissionCatalog.All.Select(x => x.Key).Order(),
            permissionKeys.Order());

        var superAdministrator = await roleManager.FindByNameAsync(
            RoleCatalog.SuperAdministrator);
        Assert.NotNull(superAdministrator);

        var superAdministratorClaims = await roleManager
            .GetClaimsAsync(superAdministrator);
        Assert.Equal(
            PermissionCatalog.All.Select(x => x.Key).Order(),
            superAdministratorClaims
                .Where(x => x.Type == PermissionCatalog.ClaimType)
                .Select(x => x.Value)
                .Order());
    }

    [Fact]
    public async Task ValidCredentialsCreateAnAuthenticatedSession()
    {
        var account = await CreateUserAsync(mustChangePassword: false);
        try
        {
            using var client = CreateClient();

            using var response = await LoginAsync(
                client,
                account.Username,
                account.Password);

            Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
            Assert.Equal("/", response.Headers.Location?.OriginalString);

            using var dashboardResponse = await client.GetAsync("/");
            Assert.Equal(HttpStatusCode.OK, dashboardResponse.StatusCode);
            var body = await dashboardResponse.Content.ReadAsStringAsync();
            Assert.Contains(account.DisplayName, body, StringComparison.Ordinal);
        }
        finally
        {
            await DeleteUserAsync(account.Username);
        }
    }

    [Fact]
    public async Task FiveFailedAttemptsLockTheAccount()
    {
        var account = await CreateUserAsync(mustChangePassword: false);
        try
        {
            using var client = CreateClient();

            for (var attempt = 0; attempt < 5; attempt++)
            {
                using var response = await LoginAsync(
                    client,
                    account.Username,
                    "WrongPassword9");
                Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            }

            await using var scope = factory.Services.CreateAsyncScope();
            var userManager = scope.ServiceProvider
                .GetRequiredService<UserManager<ApplicationUser>>();
            var user = await userManager.FindByNameAsync(account.Username);
            Assert.NotNull(user);
            Assert.True(await userManager.IsLockedOutAsync(user));
        }
        finally
        {
            await DeleteUserAsync(account.Username);
        }
    }

    [Fact]
    public async Task ForcedPasswordChangeBlocksDashboard()
    {
        var account = await CreateUserAsync(mustChangePassword: true);
        try
        {
            using var client = CreateClient();
            using var loginResponse = await LoginAsync(
                client,
                account.Username,
                account.Password);
            Assert.Equal(HttpStatusCode.Redirect, loginResponse.StatusCode);

            using var dashboardResponse = await client.GetAsync("/");
            Assert.Equal(HttpStatusCode.Redirect, dashboardResponse.StatusCode);
            Assert.Equal(
                "/Account/ChangePassword",
                dashboardResponse.Headers.Location?.OriginalString);
        }
        finally
        {
            await DeleteUserAsync(account.Username);
        }
    }

    [Fact]
    public async Task SetupClosesAfterAnyUserExists()
    {
        var account = await CreateUserAsync(mustChangePassword: false);
        try
        {
            using var client = CreateClient();

            using var response = await client.GetAsync("/Setup");

            Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
            Assert.Equal(
                "/Account/Login",
                response.Headers.Location?.OriginalString);
        }
        finally
        {
            await DeleteUserAsync(account.Username);
        }
    }

    [Fact]
    public async Task PermissionPolicyAcceptsTheMatchingPermissionClaim()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var authorizationService = scope.ServiceProvider
            .GetRequiredService<IAuthorizationService>();
        var principal = new ClaimsPrincipal(
            new ClaimsIdentity(
                [
                    new Claim(
                        PermissionCatalog.ClaimType,
                        PermissionCatalog.Students.View),
                ],
                authenticationType: "test"));

        var result = await authorizationService.AuthorizeAsync(
            principal,
            resource: null,
            PermissionCatalog.Policy(PermissionCatalog.Students.View));

        Assert.True(result.Succeeded);
    }

    private HttpClient CreateClient() =>
        factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false,
            HandleCookies = true,
        });

    private static async Task<HttpResponseMessage> LoginAsync(
        HttpClient client,
        string username,
        string password)
    {
        using var loginPage = await client.GetAsync("/Account/Login");
        loginPage.EnsureSuccessStatusCode();
        var html = await loginPage.Content.ReadAsStringAsync();
        var tokenMatch = AntiforgeryTokenPattern().Match(html);
        Assert.True(tokenMatch.Success, "The login anti-forgery token was not rendered.");

        return await client.PostAsync(
            "/Account/Login",
            new FormUrlEncodedContent(
                new Dictionary<string, string>
                {
                    ["Input.Username"] = username,
                    ["Input.Password"] = password,
                    ["Input.ReturnUrl"] = "/",
                    ["__RequestVerificationToken"] = WebUtility.HtmlDecode(
                        tokenMatch.Groups[1].Value),
                }));
    }

    private async Task<TestAccount> CreateUserAsync(bool mustChangePassword)
    {
        var username = $"test-{Guid.NewGuid():N}";
        const string password = "SafePassword9";
        var displayName = $"Test user {username[^6..]}";

        await using var scope = factory.Services.CreateAsyncScope();
        var userManager = scope.ServiceProvider
            .GetRequiredService<UserManager<ApplicationUser>>();
        var user = new ApplicationUser
        {
            UserName = username,
            DisplayName = displayName,
            IsActive = true,
            MustChangePassword = mustChangePassword,
        };

        var createResult = await userManager.CreateAsync(user, password);
        Assert.True(
            createResult.Succeeded,
            string.Join("; ", createResult.Errors.Select(x => x.Description)));
        var roleResult = await userManager.AddToRoleAsync(user, RoleCatalog.Teacher);
        Assert.True(
            roleResult.Succeeded,
            string.Join("; ", roleResult.Errors.Select(x => x.Description)));

        return new TestAccount(username, password, displayName);
    }

    private async Task DeleteUserAsync(string username)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var userManager = scope.ServiceProvider
            .GetRequiredService<UserManager<ApplicationUser>>();
        var user = await userManager.FindByNameAsync(username);
        if (user is not null)
        {
            var result = await userManager.DeleteAsync(user);
            Assert.True(
                result.Succeeded,
                string.Join("; ", result.Errors.Select(x => x.Description)));
        }
    }

    [GeneratedRegex(
        "name=\"__RequestVerificationToken\"[^>]*value=\"([^\"]+)\"",
        RegexOptions.CultureInvariant)]
    private static partial Regex AntiforgeryTokenPattern();

    private sealed record TestAccount(
        string Username,
        string Password,
        string DisplayName);
}
