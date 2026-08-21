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

public sealed partial class AcademicStructureIntegrationTests(
    WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task AcademicsDefaultsDatesAndPersistsTeacherAssignments()
    {
        var administrator = await CreateUserAsync(
            RoleCatalog.SuperAdministrator,
            "Academic administrator");
        var teacher = await CreateUserAsync(
            RoleCatalog.Teacher,
            "Assigned teacher");
        var suffix = Guid.NewGuid().ToString("N")[..8];
        var className = $"Academic class {suffix}";
        var subjectCode = $"SUB{suffix}".ToUpperInvariant();
        var yearName = await FindAvailableYearNameAsync();
        Guid yearId = default;
        Guid classId = default;
        Guid sectionId = default;
        Guid subjectId = default;
        try
        {
            using var client = CreateClient();
            using var login = await LoginAsync(
                client,
                administrator.Username,
                administrator.Password);
            Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);

            var today = DateOnly.FromDateTime(DateTime.Today);
            var yearMinimum = new DateOnly(DateTime.Today.Year, 1, 1);
            using (var page = await client.GetAsync("/Academics"))
            {
                Assert.Equal(HttpStatusCode.OK, page.StatusCode);
                var html = await page.Content.ReadAsStringAsync();
                var todayValue = yearMinimum.ToString(
                    "yyyy-MM-dd",
                    System.Globalization.CultureInfo.InvariantCulture);
                Assert.Contains($"min=\"{todayValue}\"", html);
                Assert.Contains($"value=\"{todayValue}\"", html);
                Assert.Contains("Subjects and Teacher Assignments", html);
                Assert.Contains("data-auto-dismiss=\"5000\"", html);
                Assert.Contains("id=\"classSetupModal\"", html);
                Assert.Contains("modal-dialog-scrollable", html);
                Assert.Contains("Lunch and Break Times", html);
                Assert.DoesNotContain("<details", html, StringComparison.OrdinalIgnoreCase);
                Assert.Contains("Assigned teacher", html);
                Assert.Contains("id=\"editYearModal\"", html);
                Assert.Contains("Classes and Sections", html);
                Assert.Contains("Class Teachers", html);
                Assert.Contains("id=\"subjectTeacherModal\"", html);
                Assert.Contains("modal-xl", html);
                Assert.Contains("id=\"assignment-classes\"", html);
                Assert.Contains("id=\"assignment-sections\"", html);
                Assert.Contains("Subjects and Teacher Assignments", html);
                Assert.DoesNotContain("<th>Status</th>", html);
                Assert.DoesNotContain("Assign one teacher per subject", html);
                Assert.DoesNotContain("Create an all-class break", html);
                Assert.Contains("type=\"hidden\" id=\"edit-break-active\"", html);
                Assert.DoesNotContain("Create a Nursery-Class 12 range", html);
                Assert.DoesNotContain("BulkClassSetup_AcademicYearId", html);
                Assert.DoesNotContain("SectionCount_AcademicYearId", html);
                Assert.DoesNotContain("NewTeacherAssignment_AcademicYearId", html);
                Assert.DoesNotContain("NewSubject_Code", html);
                Assert.DoesNotContain("NewSubject_MaximumMarks", html);
            }

            using (var response = await PostAsync(
                client,
                "CreateYear",
                new Dictionary<string, string>
                {
                    ["NewAcademicYear.Name"] = yearName,
                    ["NewAcademicYear.StartDate"] = today.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
                    ["NewAcademicYear.EndDate"] = today
                        .AddYears(1)
                        .AddDays(-1)
                        .ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
                }))
            {
                Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
            }

            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var dbContext = scope.ServiceProvider
                    .GetRequiredService<SchoolPortalDbContext>();
                yearId = await dbContext.Set<AcademicYear>()
                    .Where(x => x.Name == yearName)
                    .Select(x => x.Id)
                    .SingleAsync();
            }

            using (var response = await PostAsync(
                client,
                "CreateClass",
                new Dictionary<string, string>
                {
                    ["ClassInput.Name"] = className,
                    ["ClassInput.Level"] = "8",
                    ["ClassInput.Stream"] = "General",
                    ["ClassInput.SortOrder"] = "800",
                }))
            {
                Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
            }

            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var dbContext = scope.ServiceProvider
                    .GetRequiredService<SchoolPortalDbContext>();
                classId = await dbContext.Set<SchoolClass>()
                    .Where(x => x.Name == className)
                    .Select(x => x.Id)
                    .SingleAsync();
            }

            using (var response = await PostAsync(
                client,
                "CreateSubject",
                new Dictionary<string, string>
                {
                    ["NewSubject.ClassId"] = classId.ToString(),
                    ["NewSubject.Name"] = $"Mathematics {suffix}",
                }))
            {
                Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
            }

            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var dbContext = scope.ServiceProvider
                    .GetRequiredService<SchoolPortalDbContext>();
                subjectId = await dbContext.Set<Subject>()
                    .Where(x => x.ClassId == classId && x.Name == $"Mathematics {suffix}")
                    .Select(x => x.Id)
                    .SingleAsync();
            }

            using (var response = await PostAsync(
                client,
                "CreateSection",
                new Dictionary<string, string>
                {
                    ["NewSection.AcademicYearId"] = yearId.ToString(),
                    ["NewSection.ClassId"] = classId.ToString(),
                    ["NewSection.Name"] = "A",
                    ["NewSection.Capacity"] = "40",
                    ["NewSection.ClassTeacherUserId"] = teacher.UserId.ToString(),
                }))
            {
                Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
            }

            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var dbContext = scope.ServiceProvider
                    .GetRequiredService<SchoolPortalDbContext>();
                var section = await dbContext.Set<Section>()
                    .SingleAsync(x =>
                        x.AcademicYearId == yearId
                        && x.ClassId == classId
                        && x.Name == "A");
                sectionId = section.Id;
                Assert.Equal(teacher.UserId, section.ClassTeacherUserId);
            }

            using (var response = await PostAsync(
                client,
                "AssignTeacher",
                new Dictionary<string, string>
                {
                    ["NewTeacherAssignment.AcademicYearId"] = yearId.ToString(),
                    ["NewTeacherAssignment.SectionId"] = sectionId.ToString(),
                    ["NewTeacherAssignment.SubjectId"] = subjectId.ToString(),
                    ["NewTeacherAssignment.TeacherUserId"] = teacher.UserId.ToString(),
                }))
            {
                Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
            }
            using (var response = await PostAsync(
                client,
                "SaveSubjectTeacher",
                new Dictionary<string, string>
                {
                    ["NewSubjectTeacherAssignment.SubjectName"] = $"Mathematics {suffix}",
                    ["NewSubjectTeacherAssignment.TeacherUserId"] = teacher.UserId.ToString(),
                    ["NewSubjectTeacherAssignment.ClassIds"] = classId.ToString(),
                    ["NewSubjectTeacherAssignment.SectionIds"] = sectionId.ToString(),
                }))
            {
                Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
            }

            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var dbContext = scope.ServiceProvider
                    .GetRequiredService<SchoolPortalDbContext>();
                var assignment = await dbContext.Set<TeacherAssignment>()
                    .AsNoTracking()
                    .SingleAsync(x =>
                        x.AcademicYearId == yearId
                        && x.SectionId == sectionId
                        && x.SubjectId == subjectId);
                Assert.Equal(classId, assignment.ClassId);
                Assert.Equal(teacher.UserId, assignment.TeacherUserId);
            }

            using (var response = await PostAsync(
                client,
                "RemoveClass",
                new Dictionary<string, string>
                {
                    ["id"] = classId.ToString(),
                }))
            {
                Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
            }

            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var dbContext = scope.ServiceProvider
                    .GetRequiredService<SchoolPortalDbContext>();
                Assert.False((await dbContext.Set<SchoolClass>()
                    .SingleAsync(x => x.Id == classId)).IsActive);
                Assert.False((await dbContext.Set<Subject>()
                    .SingleAsync(x => x.Id == subjectId)).IsActive);
                Assert.False(await dbContext.Set<Section>()
                    .AnyAsync(x => x.Id == sectionId));
                Assert.False(await dbContext.Set<TeacherAssignment>()
                    .AnyAsync(x => x.SectionId == sectionId));
            }

            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var dbContext = scope.ServiceProvider
                    .GetRequiredService<SchoolPortalDbContext>();
                var year = await dbContext.Set<AcademicYear>()
                    .SingleAsync(x => x.Id == yearId);
                year.StartDate = new DateOnly(DateTime.Today.Year, 1, 1);
                year.EndDate = DateOnly.FromDateTime(DateTime.Today).AddDays(-1);
                year.Status = AcademicYearStatus.Open;
                year.IsCurrent = true;
                await dbContext.SaveChangesAsync();
            }

            using (var page = await client.GetAsync("/Academics"))
            {
                Assert.Equal(HttpStatusCode.OK, page.StatusCode);
            }

            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var dbContext = scope.ServiceProvider
                    .GetRequiredService<SchoolPortalDbContext>();
                var year = await dbContext.Set<AcademicYear>()
                    .AsNoTracking()
                    .SingleAsync(x => x.Id == yearId);
                Assert.Equal(AcademicYearStatus.Closed, year.Status);
                Assert.False(year.IsCurrent);
            }
        }
        finally
        {
            await CleanupAsync(yearId, classId, sectionId, subjectId);
            await DeleteUserAsync(administrator.Username);
            await DeleteUserAsync(teacher.Username);
        }
    }

    [Fact]
    public async Task AcademicsRejectsAnAcademicYearStartingBeforeToday()
    {
        var administrator = await CreateUserAsync(
            RoleCatalog.SuperAdministrator,
            "Date validation administrator");
        try
        {
            using var client = CreateClient();
            using var login = await LoginAsync(
                client,
                administrator.Username,
                administrator.Password);
            Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);
            var today = DateOnly.FromDateTime(DateTime.Today);
            using var response = await PostAsync(
                client,
                "CreateYear",
                new Dictionary<string, string>
                {
                    ["NewAcademicYear.Name"] = "2198-99",
                    ["NewAcademicYear.StartDate"] = new DateOnly(DateTime.Today.Year - 1, 12, 31)
                        .ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
                    ["NewAcademicYear.EndDate"] = today
                        .AddYears(1)
                        .ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
                });
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Contains(
                "The start date cannot be before 1 January of the current year.",
                await response.Content.ReadAsStringAsync());
        }
        finally
        {
            await DeleteUserAsync(administrator.Username);
        }
    }

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

    private async Task<string> FindAvailableYearNameAsync()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider
            .GetRequiredService<SchoolPortalDbContext>();
        var existing = await dbContext.Set<AcademicYear>()
            .Select(x => x.Name)
            .ToListAsync();
        for (var year = 2100; year < 2198; year++)
        {
            var candidate = $"{year}-{(year + 1) % 100:00}";
            if (!existing.Contains(candidate, StringComparer.Ordinal))
            {
                return candidate;
            }
        }

        throw new InvalidOperationException("No free integration-test year name.");
    }

    private async Task CleanupAsync(
        Guid yearId,
        Guid classId,
        Guid sectionId,
        Guid subjectId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider
            .GetRequiredService<SchoolPortalDbContext>();
        if (sectionId != Guid.Empty || subjectId != Guid.Empty)
        {
            await dbContext.Set<TeacherAssignment>()
                .Where(x =>
                    x.SectionId == sectionId
                    || x.SubjectId == subjectId)
                .ExecuteDeleteAsync();
        }

        if (sectionId != Guid.Empty)
        {
            await dbContext.Set<Section>()
                .Where(x => x.Id == sectionId)
                .ExecuteDeleteAsync();
        }

        if (subjectId != Guid.Empty)
        {
            await dbContext.Set<Subject>()
                .Where(x => x.Id == subjectId)
                .ExecuteDeleteAsync();
        }

        if (yearId != Guid.Empty)
        {
            await dbContext.Set<AcademicYear>()
                .Where(x => x.Id == yearId)
                .ExecuteDeleteAsync();
        }

        if (classId != Guid.Empty)
        {
            await dbContext.Set<SchoolClass>()
                .Where(x => x.Id == classId)
                .ExecuteDeleteAsync();
        }
    }

    private async Task<TestAccount> CreateUserAsync(
        string role,
        string displayName)
    {
        var username = $"academic-{Guid.NewGuid():N}";
        const string password = "SafePassword9";
        await using var scope = factory.Services.CreateAsyncScope();
        var userManager = scope.ServiceProvider
            .GetRequiredService<UserManager<ApplicationUser>>();
        var user = new ApplicationUser
        {
            UserName = username,
            DisplayName = displayName,
            IsActive = true,
        };
        Assert.True((await userManager.CreateAsync(user, password)).Succeeded);
        Assert.True((await userManager.AddToRoleAsync(user, role)).Succeeded);
        return new TestAccount(user.Id, username, password);
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
        var tokenMatch = AntiforgeryTokenPattern().Match(html);
        Assert.True(tokenMatch.Success);
        return WebUtility.HtmlDecode(tokenMatch.Groups[1].Value);
    }

    [GeneratedRegex(
        "name=\"__RequestVerificationToken\"[^>]*value=\"([^\"]+)\"",
        RegexOptions.CultureInvariant)]
    private static partial Regex AntiforgeryTokenPattern();

    private sealed record TestAccount(
        Guid UserId,
        string Username,
        string Password);
}
