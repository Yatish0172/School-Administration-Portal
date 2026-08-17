using System.Net;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Academics;
using SchoolPortal.Domain.Administration;
using SchoolPortal.Domain.Students;
using SchoolPortal.Infrastructure.Identity;
using SchoolPortal.Infrastructure.Persistence;

namespace SchoolPortal.Tests;

public sealed partial class AcademicStudentIntegrationTests(
    WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task AdmissionPersistsStudentGuardianEnrollmentAndAuditTogether()
    {
        var account = await CreateUserAsync(RoleCatalog.SuperAdministrator);
        var academic = await CreateAcademicFixtureAsync(capacity: 2);
        var uniqueSuffix = Guid.NewGuid().ToString("N")[..8];
        try
        {
            using var client = CreateClient();
            using var loginResponse = await LoginAsync(
                client,
                account.Username,
                account.Password);
            Assert.Equal(HttpStatusCode.Redirect, loginResponse.StatusCode);

            var token = await GetAntiforgeryTokenAsync(client, "/Students/Create");
            using var response = await client.PostAsync(
                "/Students/Create",
                new FormUrlEncodedContent(
                    new Dictionary<string, string>
                    {
                        ["Input.FirstName"] = "Aarav",
                        ["Input.LastName"] = $"Test{uniqueSuffix}",
                        ["Input.AdmissionDate"] = "2026-07-30",
                        ["Input.Nationality"] = "Indian",
                        ["Guardians[0].Relation"] = "Father",
                        ["Guardians[0].Name"] = $"Guardian {uniqueSuffix}",
                        ["Guardians[0].Phone"] = $"9000{uniqueSuffix[..6]}",
                        ["Guardians[0].IsPrimary"] = "true",
                        ["Enrollment.AcademicYearId"] = academic.YearId.ToString(),
                        ["Enrollment.ClassId"] = academic.ClassId.ToString(),
                        ["Enrollment.SectionId"] = academic.SectionId.ToString(),
                        ["__RequestVerificationToken"] = token,
                    }));

            Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
            Assert.StartsWith(
                "/Students/Details/",
                response.Headers.Location?.OriginalString,
                StringComparison.Ordinal);

            await using var scope = factory.Services.CreateAsyncScope();
            var dbContext = scope.ServiceProvider.GetRequiredService<SchoolPortalDbContext>();
            var student = await dbContext.Set<Student>()
                .AsNoTracking()
                .Include(x => x.Guardians)
                .Include(x => x.Enrollments)
                .SingleAsync(x => x.LastName == $"Test{uniqueSuffix}");

            Assert.Matches(@"^ADM-\d{4}-\d{5}$", student.AdmissionNumber);
            var guardian = Assert.Single(student.Guardians);
            Assert.True(guardian.IsPrimary);
            Assert.Equal($"Guardian {uniqueSuffix}", guardian.Name);
            var enrollment = Assert.Single(student.Enrollments);
            Assert.Equal(academic.SectionId, enrollment.SectionId);
            Assert.Equal(1, enrollment.RollNumber);
            Assert.True(await dbContext.Set<AuditEvent>().AnyAsync(x =>
                x.EntityId == student.Id.ToString()
                && x.EventType == "student.admitted"));
        }
        finally
        {
            await CleanupAcademicFixtureAsync(
                academic,
                studentLastName: $"Test{uniqueSuffix}");
            await DeleteUserAsync(account.Username);
        }
    }

    [Fact]
    public async Task TeacherCanViewStudentsButCannotManageAcademicStructure()
    {
        var account = await CreateUserAsync(RoleCatalog.Teacher);
        try
        {
            using var client = CreateClient();
            using var loginResponse = await LoginAsync(
                client,
                account.Username,
                account.Password);
            Assert.Equal(HttpStatusCode.Redirect, loginResponse.StatusCode);

            using var studentsResponse = await client.GetAsync("/Students");
            Assert.Equal(HttpStatusCode.OK, studentsResponse.StatusCode);

            using var academicsResponse = await client.GetAsync("/Academics");
            Assert.Equal(HttpStatusCode.Redirect, academicsResponse.StatusCode);
            Assert.Equal(
                "/Account/AccessDenied",
                academicsResponse.Headers.Location?.AbsolutePath);
        }
        finally
        {
            await DeleteUserAsync(account.Username);
        }
    }

    [Fact]
    public async Task DatabaseRejectsDuplicateEnrollmentForTheSameStudentAndYear()
    {
        var academic = await CreateAcademicFixtureAsync(capacity: 5);
        var studentId = Guid.NewGuid();
        try
        {
            await using var scope = factory.Services.CreateAsyncScope();
            var dbContext = scope.ServiceProvider.GetRequiredService<SchoolPortalDbContext>();
            dbContext.Add(new Student
            {
                Id = studentId,
                AdmissionNumber = $"TEST-{Guid.NewGuid():N}",
                FirstName = "Schema",
                LastName = "Invariant",
                AdmissionDate = DateOnly.FromDateTime(DateTime.Today),
            });
            dbContext.AddRange(
                new StudentEnrollment
                {
                    StudentId = studentId,
                    AcademicYearId = academic.YearId,
                    ClassId = academic.ClassId,
                    SectionId = academic.SectionId,
                    RollNumber = 10,
                },
                new StudentEnrollment
                {
                    StudentId = studentId,
                    AcademicYearId = academic.YearId,
                    ClassId = academic.ClassId,
                    SectionId = academic.SectionId,
                    RollNumber = 11,
                });

            await Assert.ThrowsAsync<DbUpdateException>(
                () => dbContext.SaveChangesAsync());
        }
        finally
        {
            await CleanupAcademicFixtureAsync(academic, studentId: studentId);
        }
    }

    private HttpClient CreateClient() =>
        factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false,
            HandleCookies = true,
        });

    private async Task<TestAccount> CreateUserAsync(string role)
    {
        var username = $"module-{Guid.NewGuid():N}";
        const string password = "SafePassword9";
        await using var scope = factory.Services.CreateAsyncScope();
        var userManager = scope.ServiceProvider
            .GetRequiredService<UserManager<ApplicationUser>>();
        var user = new ApplicationUser
        {
            UserName = username,
            DisplayName = "Module test user",
            IsActive = true,
        };
        Assert.True((await userManager.CreateAsync(user, password)).Succeeded);
        Assert.True((await userManager.AddToRoleAsync(user, role)).Succeeded);
        return new TestAccount(username, password);
    }

    private async Task<AcademicFixture> CreateAcademicFixtureAsync(int capacity)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<SchoolPortalDbContext>();
        var suffix = Guid.NewGuid().ToString("N")[..8];
        var year = new AcademicYear
        {
            Name = $"T{suffix}",
            StartDate = new DateOnly(2026, 4, 1),
            EndDate = new DateOnly(2027, 3, 31),
        };
        var schoolClass = new SchoolClass
        {
            Name = $"Test class {suffix}",
            SortOrder = 999,
        };
        var section = new Section
        {
            AcademicYear = year,
            Class = schoolClass,
            Name = "A",
            Capacity = capacity,
        };
        dbContext.Add(section);
        await dbContext.SaveChangesAsync();
        return new AcademicFixture(year.Id, schoolClass.Id, section.Id);
    }

    private async Task CleanupAcademicFixtureAsync(
        AcademicFixture academic,
        string? studentLastName = null,
        Guid? studentId = null)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<SchoolPortalDbContext>();
        var studentIds = await dbContext.Set<Student>()
            .Where(x =>
                (studentLastName != null && x.LastName == studentLastName)
                || (studentId.HasValue && x.Id == studentId.Value))
            .Select(x => x.Id)
            .ToListAsync();

        if (studentIds.Count != 0)
        {
            await dbContext.Set<AuditEvent>()
                .Where(x => studentIds.Select(id => id.ToString()).Contains(x.EntityId))
                .ExecuteDeleteAsync();
            await dbContext.Set<StudentEnrollment>()
                .Where(x => studentIds.Contains(x.StudentId))
                .ExecuteDeleteAsync();
            await dbContext.Set<Guardian>()
                .Where(x => studentIds.Contains(x.StudentId))
                .ExecuteDeleteAsync();
            await dbContext.Set<Student>()
                .Where(x => studentIds.Contains(x.Id))
                .ExecuteDeleteAsync();
        }

        await dbContext.Set<Section>()
            .Where(x => x.Id == academic.SectionId)
            .ExecuteDeleteAsync();
        await dbContext.Set<AcademicYear>()
            .Where(x => x.Id == academic.YearId)
            .ExecuteDeleteAsync();
        await dbContext.Set<SchoolClass>()
            .Where(x => x.Id == academic.ClassId)
            .ExecuteDeleteAsync();
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
        Assert.True(
            response.IsSuccessStatusCode,
            $"Expected {path} to return success, but received {(int)response.StatusCode} with location {response.Headers.Location}.");
        var html = await response.Content.ReadAsStringAsync();
        var tokenMatch = AntiforgeryTokenPattern().Match(html);
        Assert.True(tokenMatch.Success, $"Anti-forgery token missing from {path}.");
        return WebUtility.HtmlDecode(tokenMatch.Groups[1].Value);
    }

    [GeneratedRegex(
        "name=\"__RequestVerificationToken\"[^>]*value=\"([^\"]+)\"",
        RegexOptions.CultureInvariant)]
    private static partial Regex AntiforgeryTokenPattern();

    private sealed record TestAccount(string Username, string Password);

    private sealed record AcademicFixture(
        Guid YearId,
        Guid ClassId,
        Guid SectionId);
}
