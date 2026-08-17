using System.Net;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Academics;
using SchoolPortal.Infrastructure.Identity;
using SchoolPortal.Infrastructure.Persistence;

namespace SchoolPortal.Tests;

public sealed partial class AcademicSetupIntegrationTests(
    WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task BulkSetupCreatesSectionsAndPersistsClassRangeBreak()
    {
        var account = await CreateAdministratorAsync();
        var yearName = await FindAvailableYearNameAsync();
        var createdClassIds = new List<Guid>();
        Guid yearId = default;
        Guid breakId = default;
        try
        {
            using var client = CreateClient();
            using var login = await LoginAsync(
                client,
                account.Username,
                account.Password);
            Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);
            var minimum = new DateOnly(DateTime.Today.Year, 1, 1);

            using (var response = await PostAsync(
                client,
                "CreateYear",
                new()
                {
                    ["NewAcademicYear.Name"] = yearName,
                    ["NewAcademicYear.StartDate"] = Date(minimum),
                    ["NewAcademicYear.EndDate"] = Date(minimum.AddYears(1).AddDays(-1)),
                }))
            {
                Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
            }

            HashSet<Guid> originalClassIds;
            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var dbContext = scope.ServiceProvider
                    .GetRequiredService<SchoolPortalDbContext>();
                yearId = await dbContext.Set<AcademicYear>()
                    .Where(x => x.Name == yearName)
                    .Select(x => x.Id)
                    .SingleAsync();
                originalClassIds = (await dbContext.Set<SchoolClass>()
                    .Where(x => new[] { "Nursery", "LKG", "UKG", "Class 1" }
                        .Contains(x.Name))
                    .Select(x => x.Id)
                    .ToListAsync())
                    .ToHashSet();
            }

            using (var response = await PostAsync(
                client,
                "BulkSetupClasses",
                new()
                {
                    ["BulkClassSetup.AcademicYearId"] = yearId.ToString(),
                    ["BulkClassSetup.FromClassKey"] = "nursery",
                    ["BulkClassSetup.ToClassKey"] = "class-1",
                    ["BulkClassSetup.SectionCount"] = "3",
                    ["BulkClassSetup.SectionCapacity"] = "35",
                }))
            {
                Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
            }

            Guid nurseryId;
            Guid classOneId;
            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var dbContext = scope.ServiceProvider
                    .GetRequiredService<SchoolPortalDbContext>();
                var configuredClasses = await dbContext.Set<SchoolClass>()
                    .Where(x => new[] { "Nursery", "LKG", "UKG", "Class 1" }
                        .Contains(x.Name))
                    .OrderBy(x => x.SortOrder)
                    .ToListAsync();
                Assert.Equal(4, configuredClasses.Count);
                createdClassIds.AddRange(configuredClasses
                    .Where(x => !originalClassIds.Contains(x.Id))
                    .Select(x => x.Id));
                nurseryId = configuredClasses.Single(x => x.Name == "Nursery").Id;
                classOneId = configuredClasses.Single(x => x.Name == "Class 1").Id;
                var sections = await dbContext.Set<Section>()
                    .Where(x => x.AcademicYearId == yearId)
                    .ToListAsync();
                Assert.Equal(12, sections.Count);
                Assert.All(sections, section =>
                {
                    Assert.True(section.IsActive);
                    Assert.Equal(35, section.Capacity);
                });
            }

            using (var response = await PostAsync(
                client,
                "SetSectionCount",
                new()
                {
                    ["SectionCount.AcademicYearId"] = yearId.ToString(),
                    ["SectionCount.ClassId"] = nurseryId.ToString(),
                    ["SectionCount.DesiredCount"] = "2",
                    ["SectionCount.Capacity"] = "30",
                }))
            {
                Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
            }

            using (var response = await PostAsync(
                client,
                "CreateBreakPeriod",
                new()
                {
                    ["NewBreakPeriod.Name"] = "Junior lunch",
                    ["NewBreakPeriod.Scope"] = AcademicBreakScope.ClassRange.ToString(),
                    ["NewBreakPeriod.FromClassId"] = nurseryId.ToString(),
                    ["NewBreakPeriod.ToClassId"] = classOneId.ToString(),
                    ["NewBreakPeriod.StartsAt"] = "12:00",
                    ["NewBreakPeriod.EndsAt"] = "12:30",
                }))
            {
                Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
            }

            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var dbContext = scope.ServiceProvider
                    .GetRequiredService<SchoolPortalDbContext>();
                var nurserySections = await dbContext.Set<Section>()
                    .Where(x =>
                        x.AcademicYearId == yearId
                        && x.ClassId == nurseryId)
                    .OrderBy(x => x.Name)
                    .ToListAsync();
                Assert.Equal(2, nurserySections.Count);
                Assert.Equal(30, nurserySections.Single(x => x.Name == "A").Capacity);
                Assert.DoesNotContain(nurserySections, x => x.Name == "C");
                var breakPeriod = await dbContext.Set<AcademicBreakPeriod>()
                    .SingleAsync(x => x.Name == "Junior lunch");
                breakId = breakPeriod.Id;
                Assert.Equal(AcademicBreakScope.ClassRange, breakPeriod.Scope);
                Assert.Equal(nurseryId, breakPeriod.FromClassId);
                Assert.Equal(classOneId, breakPeriod.ToClassId);
                Assert.Equal(new TimeOnly(12, 0), breakPeriod.StartsAt);
            }

            using (var page = await client.GetAsync("/Academics"))
            {
                var html = await page.Content.ReadAsStringAsync();
                Assert.DoesNotContain("C (inactive)", html);
            }
        }
        finally
        {
            await CleanupAsync(yearId, breakId, createdClassIds);
            await DeleteUserAsync(account.Username);
        }
    }

    private async Task CleanupAsync(
        Guid yearId,
        Guid breakId,
        List<Guid> createdClassIds)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider
            .GetRequiredService<SchoolPortalDbContext>();
        if (breakId != Guid.Empty)
        {
            await dbContext.Set<AcademicBreakPeriod>()
                .Where(x => x.Id == breakId)
                .ExecuteDeleteAsync();
        }

        if (yearId != Guid.Empty)
        {
            await dbContext.Set<Section>()
                .Where(x => x.AcademicYearId == yearId)
                .ExecuteDeleteAsync();
            await dbContext.Set<AcademicYear>()
                .Where(x => x.Id == yearId)
                .ExecuteDeleteAsync();
        }

        if (createdClassIds.Count != 0)
        {
            await dbContext.Set<SchoolClass>()
                .Where(x => createdClassIds.Contains(x.Id))
                .ExecuteDeleteAsync();
        }
    }

    private async Task<TestAccount> CreateAdministratorAsync()
    {
        var username = $"setup-{Guid.NewGuid():N}";
        const string password = "SafePassword9";
        await using var scope = factory.Services.CreateAsyncScope();
        var userManager = scope.ServiceProvider
            .GetRequiredService<UserManager<ApplicationUser>>();
        var user = new ApplicationUser
        {
            UserName = username,
            DisplayName = "Academic setup administrator",
            IsActive = true,
        };
        Assert.True((await userManager.CreateAsync(user, password)).Succeeded);
        Assert.True((await userManager.AddToRoleAsync(
            user,
            RoleCatalog.SuperAdministrator)).Succeeded);
        return new TestAccount(username, password);
    }

    private async Task<string> FindAvailableYearNameAsync()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider
            .GetRequiredService<SchoolPortalDbContext>();
        var existing = await dbContext.Set<AcademicYear>()
            .Select(x => x.Name)
            .ToListAsync();
        return Enumerable.Range(2200, 50)
            .Select(year => $"{year}-{(year + 1) % 100:00}")
            .First(candidate => !existing.Contains(candidate, StringComparer.Ordinal));
    }

    private static string Date(DateOnly value) =>
        value.ToString(
            "yyyy-MM-dd",
            System.Globalization.CultureInfo.InvariantCulture);

    private static async Task<HttpResponseMessage> PostAsync(
        HttpClient client,
        string handler,
        Dictionary<string, string> values)
    {
        values["__RequestVerificationToken"] =
            await GetAntiforgeryTokenAsync(client, "/Academics");
        return await client.PostAsync(
            $"/Academics?handler={handler}",
            new FormUrlEncodedContent(values));
    }

    private HttpClient CreateClient() =>
        factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false,
            HandleCookies = true,
        });

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
        var token = await GetAntiforgeryTokenAsync(client, "/Account/Login");
        return await client.PostAsync(
            "/Account/Login",
            new FormUrlEncodedContent(
                new Dictionary<string, string>
                {
                    ["Input.Username"] = username,
                    ["Input.Password"] = password,
                    ["Input.ReturnUrl"] = "/",
                    ["__RequestVerificationToken"] = token,
                }));
    }

    private static async Task<string> GetAntiforgeryTokenAsync(
        HttpClient client,
        string path)
    {
        using var response = await client.GetAsync(path);
        Assert.True(response.IsSuccessStatusCode);
        var html = await response.Content.ReadAsStringAsync();
        var match = AntiforgeryTokenPattern().Match(html);
        Assert.True(match.Success);
        return WebUtility.HtmlDecode(match.Groups[1].Value);
    }

    [GeneratedRegex(
        "name=\"__RequestVerificationToken\"[^>]*value=\"([^\"]+)\"",
        RegexOptions.CultureInvariant)]
    private static partial Regex AntiforgeryTokenPattern();

    private sealed record TestAccount(string Username, string Password);
}
