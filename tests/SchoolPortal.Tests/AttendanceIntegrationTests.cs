using System.Globalization;
using System.Net;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Academics;
using SchoolPortal.Domain.Administration;
using SchoolPortal.Domain.Attendance;
using SchoolPortal.Domain.Students;
using SchoolPortal.Infrastructure.Identity;
using SchoolPortal.Infrastructure.Persistence;

namespace SchoolPortal.Tests;

public sealed partial class AttendanceIntegrationTests(
    WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task RegisterPersistsWholeRosterAuditAndReports()
    {
        var account = await CreateUserAsync(RoleCatalog.SuperAdministrator);
        var fixture = await CreateFixtureAsync(account.UserId);
        try
        {
            using var client = CreateClient();
            using var login = await LoginAsync(
                client,
                account.Username,
                account.Password);
            Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);

            var date = DateOnly.FromDateTime(DateTime.Today);
            var path = AttendancePath(fixture.SectionId, date);
            var token = await GetAntiforgeryTokenAsync(client, path);
            using var response = await client.PostAsync(
                "/Attendance?handler=Save",
                new FormUrlEncodedContent(
                    new Dictionary<string, string>
                    {
                        ["SectionId"] = fixture.SectionId.ToString(),
                        ["Date"] = date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                        ["PeriodNumber"] = "0",
                        ["Entries[0].EnrollmentId"] =
                            fixture.FirstEnrollmentId.ToString(),
                        ["Entries[0].Status"] =
                            ((int)AttendanceStatus.Present).ToString(CultureInfo.InvariantCulture),
                        ["Entries[0].Reason"] = string.Empty,
                        ["Entries[1].EnrollmentId"] =
                            fixture.SecondEnrollmentId.ToString(),
                        ["Entries[1].Status"] =
                            ((int)AttendanceStatus.Absent).ToString(CultureInfo.InvariantCulture),
                        ["Entries[1].Reason"] = "Unwell",
                        ["__RequestVerificationToken"] = token,
                    }));

            var responseBody = await response.Content.ReadAsStringAsync();
            Assert.True(
                response.StatusCode == HttpStatusCode.Redirect,
                $"Expected redirect, received {response.StatusCode}: {responseBody}");

            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var dbContext = scope.ServiceProvider
                    .GetRequiredService<SchoolPortalDbContext>();
                var session = await dbContext.Set<AttendanceSession>()
                    .AsNoTracking()
                    .Include(x => x.Entries)
                    .SingleAsync(x =>
                        x.SectionId == fixture.SectionId
                        && x.Date == date
                        && x.PeriodNumber == 0);
                Assert.Equal(2, session.Entries.Count);
                Assert.Contains(
                    session.Entries,
                    x => x.Status == AttendanceStatus.Absent
                        && x.Reason == "Unwell");
                Assert.True(await dbContext.Set<AuditEvent>().AnyAsync(x =>
                    x.EntityId == session.Id.ToString()
                    && x.EventType == "attendance.register.created"));
            }

            using var report = await client.GetAsync(
                $"/Attendance/Reports?SectionId={fixture.SectionId}"
                + $"&From={date:yyyy-MM-dd}&To={date:yyyy-MM-dd}"
                + $"&ReportDate={date:yyyy-MM-dd}&Threshold=75");
            Assert.Equal(HttpStatusCode.OK, report.StatusCode);
            var html = await report.Content.ReadAsStringAsync();
            Assert.Contains("Absent Student", html, StringComparison.Ordinal);
            Assert.Contains("9000000002", html, StringComparison.Ordinal);
            Assert.Contains("Unwell", html, StringComparison.Ordinal);
        }
        finally
        {
            await CleanupFixtureAsync(fixture);
            await DeleteUserAsync(account.Username);
        }
    }

    [Fact]
    public async Task LockedRegisterCanOnlyBeChangedThroughAuditedCorrection()
    {
        var account = await CreateUserAsync(RoleCatalog.SuperAdministrator);
        var fixture = await CreateFixtureAsync(account.UserId);
        var lockedDate = DateOnly.FromDateTime(DateTime.Today.AddDays(-3));
        var entryId = await SeedRegisterAsync(
            fixture,
            account.UserId,
            lockedDate,
            AttendanceStatus.Absent);
        try
        {
            using var client = CreateClient();
            using var login = await LoginAsync(
                client,
                account.Username,
                account.Password);
            Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);

            var path = AttendancePath(fixture.SectionId, lockedDate);
            var token = await GetAntiforgeryTokenAsync(client, path);
            using var saveResponse = await client.PostAsync(
                "/Attendance?handler=Save",
                new FormUrlEncodedContent(
                    new Dictionary<string, string>
                    {
                        ["SectionId"] = fixture.SectionId.ToString(),
                        ["Date"] = lockedDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                        ["PeriodNumber"] = "0",
                        ["Entries[0].EnrollmentId"] =
                            fixture.FirstEnrollmentId.ToString(),
                        ["Entries[0].Status"] =
                            ((int)AttendanceStatus.Present).ToString(CultureInfo.InvariantCulture),
                        ["Entries[1].EnrollmentId"] =
                            fixture.SecondEnrollmentId.ToString(),
                        ["Entries[1].Status"] =
                            ((int)AttendanceStatus.Present).ToString(CultureInfo.InvariantCulture),
                        ["__RequestVerificationToken"] = token,
                    }));
            Assert.Equal(HttpStatusCode.OK, saveResponse.StatusCode);
            var lockedHtml = await saveResponse.Content.ReadAsStringAsync();
            Assert.Contains(
                "This register is locked",
                lockedHtml,
                StringComparison.Ordinal);

            token = await GetAntiforgeryTokenAsync(client, path);
            using var correctionResponse = await client.PostAsync(
                "/Attendance?handler=Correct",
                new FormUrlEncodedContent(
                    new Dictionary<string, string>
                    {
                        ["Correction.EntryId"] = entryId.ToString(),
                        ["Correction.NewStatus"] =
                            ((int)AttendanceStatus.Present).ToString(CultureInfo.InvariantCulture),
                        ["Correction.EntryReason"] = "Medical note received",
                        ["Correction.Reason"] = "Approved after verification",
                        ["__RequestVerificationToken"] = token,
                    }));
            Assert.Equal(HttpStatusCode.Redirect, correctionResponse.StatusCode);

            await using var scope = factory.Services.CreateAsyncScope();
            var dbContext = scope.ServiceProvider
                .GetRequiredService<SchoolPortalDbContext>();
            var correctedEntry = await dbContext.Set<AttendanceEntry>()
                .AsNoTracking()
                .SingleAsync(x => x.Id == entryId);
            Assert.Equal(AttendanceStatus.Present, correctedEntry.Status);
            var correction = await dbContext.Set<AttendanceCorrection>()
                .AsNoTracking()
                .SingleAsync(x => x.AttendanceEntryId == entryId);
            Assert.Equal(AttendanceStatus.Absent, correction.OldStatus);
            Assert.Equal(AttendanceStatus.Present, correction.NewStatus);
            Assert.Equal("Approved after verification", correction.Reason);
            Assert.True(await dbContext.Set<AuditEvent>().AnyAsync(x =>
                x.EntityId == entryId.ToString()
                && x.EventType == "attendance.entry.corrected"));
        }
        finally
        {
            await CleanupFixtureAsync(fixture);
            await DeleteUserAsync(account.Username);
        }
    }

    [Fact]
    public async Task TeacherCannotMarkAnUnassignedSection()
    {
        var account = await CreateUserAsync(RoleCatalog.Teacher);
        var fixture = await CreateFixtureAsync(account.UserId);
        try
        {
            using var client = CreateClient();
            using var login = await LoginAsync(
                client,
                account.Username,
                account.Password);
            Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);

            var date = DateOnly.FromDateTime(DateTime.Today);
            var assignedPage = await client.GetAsync(
                AttendancePath(fixture.SectionId, date));
            Assert.Equal(HttpStatusCode.OK, assignedPage.StatusCode);
            var assignedHtml = await assignedPage.Content.ReadAsStringAsync();
            Assert.Contains("Present Student", assignedHtml, StringComparison.Ordinal);

            var token = await GetAntiforgeryTokenAsync(
                client,
                AttendancePath(fixture.SectionId, date));
            using var response = await client.PostAsync(
                "/Attendance?handler=Save",
                new FormUrlEncodedContent(
                    new Dictionary<string, string>
                    {
                        ["SectionId"] = fixture.UnassignedSectionId.ToString(),
                        ["Date"] = date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                        ["PeriodNumber"] = "0",
                        ["__RequestVerificationToken"] = token,
                    }));

            Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
            Assert.Equal(
                "/Account/AccessDenied",
                response.Headers.Location?.AbsolutePath);
        }
        finally
        {
            await CleanupFixtureAsync(fixture);
            await DeleteUserAsync(account.Username);
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
        var username = $"attendance-{Guid.NewGuid():N}";
        const string password = "SafePassword9";
        await using var scope = factory.Services.CreateAsyncScope();
        var userManager = scope.ServiceProvider
            .GetRequiredService<UserManager<ApplicationUser>>();
        var user = new ApplicationUser
        {
            UserName = username,
            DisplayName = "Attendance test user",
            IsActive = true,
        };
        Assert.True((await userManager.CreateAsync(user, password)).Succeeded);
        Assert.True((await userManager.AddToRoleAsync(user, role)).Succeeded);
        return new TestAccount(user.Id, username, password);
    }

    private async Task<AttendanceFixture> CreateFixtureAsync(Guid teacherUserId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<SchoolPortalDbContext>();
        var suffix = Guid.NewGuid().ToString("N")[..8];
        var year = new AcademicYear
        {
            Name = $"A{suffix}",
            StartDate = DateOnly.FromDateTime(DateTime.Today.AddMonths(-4)),
            EndDate = DateOnly.FromDateTime(DateTime.Today.AddMonths(8)),
        };
        var schoolClass = new SchoolClass
        {
            Name = $"Attendance class {suffix}",
            SortOrder = 998,
        };
        var section = new Section
        {
            AcademicYear = year,
            Class = schoolClass,
            Name = "A",
            Capacity = 40,
            ClassTeacherUserId = teacherUserId,
        };
        var unassignedSection = new Section
        {
            AcademicYear = year,
            Class = schoolClass,
            Name = "B",
            Capacity = 40,
        };
        var firstStudent = new Student
        {
            AdmissionNumber = $"AT-P-{suffix}",
            FirstName = "Present",
            LastName = "Student",
            AdmissionDate = DateOnly.FromDateTime(DateTime.Today),
            Guardians =
            [
                new Guardian
                {
                    Relation = "Mother",
                    Name = "Present Guardian",
                    Phone = "9000000001",
                    IsPrimary = true,
                },
            ],
        };
        var secondStudent = new Student
        {
            AdmissionNumber = $"AT-A-{suffix}",
            FirstName = "Absent",
            LastName = "Student",
            AdmissionDate = DateOnly.FromDateTime(DateTime.Today),
            Guardians =
            [
                new Guardian
                {
                    Relation = "Father",
                    Name = "Absent Guardian",
                    Phone = "9000000002",
                    IsPrimary = true,
                },
            ],
        };
        var firstEnrollment = new StudentEnrollment
        {
            Student = firstStudent,
            AcademicYear = year,
            Class = schoolClass,
            Section = section,
            RollNumber = 1,
        };
        var secondEnrollment = new StudentEnrollment
        {
            Student = secondStudent,
            AcademicYear = year,
            Class = schoolClass,
            Section = section,
            RollNumber = 2,
        };
        dbContext.AddRange(
            section,
            unassignedSection,
            firstEnrollment,
            secondEnrollment);
        await dbContext.SaveChangesAsync();
        return new AttendanceFixture(
            year.Id,
            schoolClass.Id,
            section.Id,
            unassignedSection.Id,
            firstStudent.Id,
            secondStudent.Id,
            firstEnrollment.Id,
            secondEnrollment.Id);
    }

    private async Task<Guid> SeedRegisterAsync(
        AttendanceFixture fixture,
        Guid userId,
        DateOnly date,
        AttendanceStatus firstStudentStatus)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<SchoolPortalDbContext>();
        var session = new AttendanceSession
        {
            AcademicYearId = fixture.YearId,
            SectionId = fixture.SectionId,
            Date = date,
            MarkedByUserId = userId,
            Entries =
            [
                new AttendanceEntry
                {
                    StudentEnrollmentId = fixture.FirstEnrollmentId,
                    Status = firstStudentStatus,
                    MarkedByUserId = userId,
                },
                new AttendanceEntry
                {
                    StudentEnrollmentId = fixture.SecondEnrollmentId,
                    Status = AttendanceStatus.Present,
                    MarkedByUserId = userId,
                },
            ],
        };
        dbContext.Add(session);
        await dbContext.SaveChangesAsync();
        return session.Entries.Single(x =>
            x.StudentEnrollmentId == fixture.FirstEnrollmentId).Id;
    }

    private async Task CleanupFixtureAsync(AttendanceFixture fixture)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<SchoolPortalDbContext>();
        var sessionIds = await dbContext.Set<AttendanceSession>()
            .Where(x => x.SectionId == fixture.SectionId)
            .Select(x => x.Id)
            .ToListAsync();
        var entryIds = await dbContext.Set<AttendanceEntry>()
            .Where(x => sessionIds.Contains(x.AttendanceSessionId))
            .Select(x => x.Id)
            .ToListAsync();
        await dbContext.Set<AuditEvent>()
            .Where(x =>
                sessionIds.Select(id => id.ToString()).Contains(x.EntityId)
                || entryIds.Select(id => id.ToString()).Contains(x.EntityId))
            .ExecuteDeleteAsync();
        await dbContext.Set<AttendanceCorrection>()
            .Where(x => entryIds.Contains(x.AttendanceEntryId))
            .ExecuteDeleteAsync();
        await dbContext.Set<AttendanceEntry>()
            .Where(x => sessionIds.Contains(x.AttendanceSessionId))
            .ExecuteDeleteAsync();
        await dbContext.Set<AttendanceSession>()
            .Where(x => sessionIds.Contains(x.Id))
            .ExecuteDeleteAsync();
        await dbContext.Set<StudentEnrollment>()
            .Where(x =>
                x.Id == fixture.FirstEnrollmentId
                || x.Id == fixture.SecondEnrollmentId)
            .ExecuteDeleteAsync();
        await dbContext.Set<Guardian>()
            .Where(x =>
                x.StudentId == fixture.FirstStudentId
                || x.StudentId == fixture.SecondStudentId)
            .ExecuteDeleteAsync();
        await dbContext.Set<Student>()
            .Where(x =>
                x.Id == fixture.FirstStudentId
                || x.Id == fixture.SecondStudentId)
            .ExecuteDeleteAsync();
        await dbContext.Set<Section>()
            .Where(x =>
                x.Id == fixture.SectionId
                || x.Id == fixture.UnassignedSectionId)
            .ExecuteDeleteAsync();
        await dbContext.Set<AcademicYear>()
            .Where(x => x.Id == fixture.YearId)
            .ExecuteDeleteAsync();
        await dbContext.Set<SchoolClass>()
            .Where(x => x.Id == fixture.ClassId)
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
            $"Expected {path} to succeed, but received {(int)response.StatusCode}.");
        var html = await response.Content.ReadAsStringAsync();
        var tokenMatch = AntiforgeryTokenPattern().Match(html);
        Assert.True(tokenMatch.Success, $"Anti-forgery token missing from {path}.");
        return WebUtility.HtmlDecode(tokenMatch.Groups[1].Value);
    }

    private static string AttendancePath(Guid sectionId, DateOnly date) =>
        $"/Attendance?SectionId={sectionId}&Date={date:yyyy-MM-dd}&PeriodNumber=0";

    [GeneratedRegex(
        "name=\"__RequestVerificationToken\"[^>]*value=\"([^\"]+)\"",
        RegexOptions.CultureInvariant)]
    private static partial Regex AntiforgeryTokenPattern();

    private sealed record TestAccount(
        Guid UserId,
        string Username,
        string Password);

    private sealed record AttendanceFixture(
        Guid YearId,
        Guid ClassId,
        Guid SectionId,
        Guid UnassignedSectionId,
        Guid FirstStudentId,
        Guid SecondStudentId,
        Guid FirstEnrollmentId,
        Guid SecondEnrollmentId);
}
