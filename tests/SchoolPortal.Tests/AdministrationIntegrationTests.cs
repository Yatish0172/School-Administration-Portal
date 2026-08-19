using System.Net;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Infrastructure.Identity;

namespace SchoolPortal.Tests;

public sealed partial class AdministrationIntegrationTests(
    WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task AdministratorCanCreateUserAndModifyAccess()
    {
        var administratorUsername = $"access-admin-{Guid.NewGuid():N}";
        var managedUsername = $"managed-{Guid.NewGuid():N}";
        const string password = "SafePassword9";

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var userManager = scope.ServiceProvider
                .GetRequiredService<UserManager<ApplicationUser>>();
            var administrator = new ApplicationUser
            {
                UserName = administratorUsername,
                DisplayName = "Access administrator",
                IsActive = true,
            };
            Assert.True((await userManager.CreateAsync(administrator, password)).Succeeded);
            Assert.True((await userManager.AddToRoleAsync(
                administrator,
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
            using var login = await LoginAsync(client, administratorUsername, password);
            Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);

            using (var page = await client.GetAsync("/Administration"))
            {
                Assert.Equal(HttpStatusCode.OK, page.StatusCode);
                var html = await page.Content.ReadAsStringAsync();
                Assert.Contains("User access", html);
                Assert.Contains("Add new user", html);
                Assert.Contains("Manage access", html);
            }

            using (var create = await PostAsync(
                client,
                "/Administration?handler=Create",
                new Dictionary<string, string>
                {
                    ["NewUser.DisplayName"] = "Managed User",
                    ["NewUser.Username"] = managedUsername,
                    ["NewUser.Email"] = "managed@example.test",
                    ["NewUser.Role"] = RoleCatalog.Teacher,
                    ["NewUser.Password"] = password,
                    ["NewUser.ConfirmPassword"] = password,
                }))
            {
                Assert.Equal(HttpStatusCode.Redirect, create.StatusCode);
            }

            Guid managedUserId;
            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var userManager = scope.ServiceProvider
                    .GetRequiredService<UserManager<ApplicationUser>>();
                var managedUser = await userManager.FindByNameAsync(managedUsername);
                Assert.NotNull(managedUser);
                managedUserId = managedUser.Id;
                Assert.True(managedUser.MustChangePassword);
                Assert.True(await userManager.IsInRoleAsync(managedUser, RoleCatalog.Teacher));
            }

            using (var update = await PostAsync(
                client,
                "/Administration?handler=UpdateAccess",
                new Dictionary<string, string>
                {
                    ["EditAccess.UserId"] = managedUserId.ToString(),
                    ["EditAccess.Role"] = RoleCatalog.Accounts,
                    ["EditAccess.IsActive"] = "false",
                }))
            {
                Assert.Equal(HttpStatusCode.Redirect, update.StatusCode);
            }

            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var userManager = scope.ServiceProvider
                    .GetRequiredService<UserManager<ApplicationUser>>();
                var managedUser = await userManager.FindByNameAsync(managedUsername);
                Assert.NotNull(managedUser);
                Assert.False(managedUser.IsActive);
                Assert.True(await userManager.IsInRoleAsync(managedUser, RoleCatalog.Accounts));
                Assert.False(await userManager.IsInRoleAsync(managedUser, RoleCatalog.Teacher));
            }
        }
        finally
        {
            await DeleteUserAsync(managedUsername);
            await DeleteUserAsync(administratorUsername);
        }
    }

    private async Task DeleteUserAsync(string username)
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

    private static async Task<HttpResponseMessage> LoginAsync(
        HttpClient client,
        string username,
        string password)
    {
        var token = await GetTokenAsync(client, "/Account/Login");
        return await client.PostAsync(
            "/Account/Login",
            new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["__RequestVerificationToken"] = token,
                ["Input.Username"] = username,
                ["Input.Password"] = password,
            }));
    }

    private static async Task<HttpResponseMessage> PostAsync(
        HttpClient client,
        string path,
        Dictionary<string, string> values)
    {
        values["__RequestVerificationToken"] =
            await GetTokenAsync(client, "/Administration");
        return await client.PostAsync(path, new FormUrlEncodedContent(values));
    }

    private static async Task<string> GetTokenAsync(
        HttpClient client,
        string path)
    {
        using var response = await client.GetAsync(path);
        var html = await response.Content.ReadAsStringAsync();
        var match = AntiforgeryRegex().Match(html);
        Assert.True(match.Success);
        return WebUtility.HtmlDecode(match.Groups["token"].Value);
    }

    [GeneratedRegex(
        "name=\"__RequestVerificationToken\"[^>]*value=\"(?<token>[^\"]+)\"",
        RegexOptions.IgnoreCase)]
    private static partial Regex AntiforgeryRegex();
}
