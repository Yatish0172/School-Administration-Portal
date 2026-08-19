using System.Net;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Infrastructure.Identity;

namespace SchoolPortal.Tests;

public sealed partial class PortalFrontendIntegrationTests(
    WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task SuperAdministratorCanOpenEveryPrimaryPortalScreenAndThemeAsset()
    {
        var username = $"frontend-admin-{Guid.NewGuid():N}";
        const string password = "SafePassword9";

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var userManager = scope.ServiceProvider
                .GetRequiredService<UserManager<ApplicationUser>>();
            var user = new ApplicationUser
            {
                UserName = username,
                DisplayName = "Frontend QA administrator",
                IsActive = true,
            };
            Assert.True((await userManager.CreateAsync(user, password)).Succeeded);
            Assert.True((await userManager.AddToRoleAsync(
                user,
                RoleCatalog.SuperAdministrator)).Succeeded);
        }

        try
        {
            using var client = factory.CreateClient(
                new WebApplicationFactoryClientOptions
                {
                    AllowAutoRedirect = false,
                    HandleCookies = true,
                });
            using var login = await LoginAsync(client, username, password);
            Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);

            var routes = new[]
            {
                "/",
                "/Students",
                "/Students/Create",
                "/Academics",
                "/Administration",
                "/Staff",
                "/Attendance",
                "/Attendance/Reports",
                "/Exams",
                "/Exams/Marks",
                "/Exams/Results",
                "/Fees/Overview",
                "/Fees/Ledger",
                "/Fees/Register",
                "/Fees",
                "/Fees/Reports",
                "/Library",
                "/Library/Circulation",
                "/Library/Fines",
                "/Library/Reports",
                "/Reports",
                "/Account/ChangePassword",
            };

            foreach (var route in routes)
            {
                using var response = await client.GetAsync(route);
                if (route == "/Students/Create"
                    && response.StatusCode == HttpStatusCode.Redirect)
                {
                    Assert.Equal(
                        "/Academics",
                        response.Headers.Location?.OriginalString);
                    continue;
                }

                Assert.True(
                    response.IsSuccessStatusCode,
                    $"Expected {route} to succeed, received {(int)response.StatusCode}.");
                var html = await response.Content.ReadAsStringAsync();
                Assert.Contains("portal-theme", html, StringComparison.Ordinal);
                Assert.Contains("class=\"portal-body\"", html, StringComparison.Ordinal);
                Assert.Contains("id=\"main-content\"", html, StringComparison.Ordinal);
            }

            foreach (var asset in new[]
            {
                "/css/portal-theme.css",
                "/js/site.js",
                "/fonts/NotoSans-Regular.ttf",
                "/fonts/NotoSans-Bold.ttf",
            })
            {
                using var response = await client.GetAsync(asset);
                Assert.True(
                    response.IsSuccessStatusCode,
                    $"Expected frontend asset {asset} to load, received {(int)response.StatusCode}.");
            }
        }
        finally
        {
            await using var scope = factory.Services.CreateAsyncScope();
            var userManager = scope.ServiceProvider
                .GetRequiredService<UserManager<ApplicationUser>>();
            var user = await userManager.FindByNameAsync(username);
            if (user is not null)
            {
                Assert.True((await userManager.DeleteAsync(user)).Succeeded);
            }
        }
    }

    private static async Task<HttpResponseMessage> LoginAsync(
        HttpClient client,
        string username,
        string password)
    {
        using var loginPage = await client.GetAsync("/Account/Login");
        loginPage.EnsureSuccessStatusCode();
        var html = await loginPage.Content.ReadAsStringAsync();
        var tokenMatch = AntiforgeryTokenPattern().Match(html);
        Assert.True(tokenMatch.Success);

        return await client.PostAsync(
            "/Account/Login",
            new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["Input.Username"] = username,
                ["Input.Password"] = password,
                ["__RequestVerificationToken"] = WebUtility.HtmlDecode(
                    tokenMatch.Groups[1].Value),
            }));
    }

    [GeneratedRegex(
        "name=\"__RequestVerificationToken\"[^>]*value=\"([^\"]+)\"",
        RegexOptions.CultureInvariant)]
    private static partial Regex AntiforgeryTokenPattern();
}
