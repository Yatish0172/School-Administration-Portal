using System.Net;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Academics;
using SchoolPortal.Domain.Administration;
using SchoolPortal.Domain.Examinations;
using SchoolPortal.Domain.Students;
using SchoolPortal.Infrastructure.Identity;
using SchoolPortal.Infrastructure.Persistence;

namespace SchoolPortal.Tests;

public sealed partial class ExaminationIntegrationTests(
    WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task MarksPublishLockAndReopenPreserveAuditHistory()
    {
        var account = await CreateUserAsync(RoleCatalog.SuperAdministrator);
        var fixture = await CreateFixtureAsync(account.UserId, assignTeacher: false);
        try
        {
            using var client = CreateClient();
            using var login = await LoginAsync(
                client,
                account.Username,
                account.Password);
            Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);

            var incompletePath =
                $"/Exams/Results?ExaminationId={fixture.ExamId}"
                + $"&SectionId={fixture.SectionId}";
            var incompleteToken = await GetAntiforgeryTokenAsync(
                client,
                incompletePath);
            using (var incomplete = await client.PostAsync(
                "/Exams/Results?handler=Publish",
                new FormUrlEncodedContent(
                    new Dictionary<string, string>
                    {
                        ["id"] = fixture.ExamId.ToString(),
                        ["SectionId"] = fixture.SectionId.ToString(),
                        ["__RequestVerificationToken"] = incompleteToken,
                    })))
            {
                Assert.Equal(HttpStatusCode.OK, incomplete.StatusCode);
                var incompleteHtml = await incomplete.Content.ReadAsStringAsync();
                Assert.Contains("marks are still blank", incompleteHtml);
            }
            await SaveMarksAsync(
                client,
                fixture,
                HttpStatusCode.Redirect,
                firstMark: "82",
                secondAbsent: true);

            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var dbContext = scope.ServiceProvider
                    .GetRequiredService<SchoolPortalDbContext>();
                var marks = await dbContext.Set<StudentMark>()
                    .AsNoTracking()
                    .Where(x => x.ExaminationSubjectId == fixture.ExamSubjectId)
                    .OrderBy(x => x.StudentEnrollmentId)
                    .ToListAsync();
                Assert.Equal(2, marks.Count);
                Assert.Contains(
                    marks,
                    x => x.MarksObtained == 82 && x.Grade == "A");
                Assert.Contains(
                    marks,
                    x => x.IsAbsent && x.MarksObtained == null);
            }

            var resultsPath =
                $"/Exams/Results?ExaminationId={fixture.ExamId}"
                + $"&SectionId={fixture.SectionId}";
            var token = await GetAntiforgeryTokenAsync(client, resultsPath);
            using var publish = await client.PostAsync(
                "/Exams/Results?handler=Publish",
                new FormUrlEncodedContent(
                    new Dictionary<string, string>
                    {
                        ["id"] = fixture.ExamId.ToString(),
                        ["SectionId"] = fixture.SectionId.ToString(),
                        ["__RequestVerificationToken"] = token,
                    }));
            Assert.Equal(HttpStatusCode.Redirect, publish.StatusCode);

            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var dbContext = scope.ServiceProvider
                    .GetRequiredService<SchoolPortalDbContext>();
                var exam = await dbContext.Set<Examination>()
                    .AsNoTracking()
                    .SingleAsync(x => x.Id == fixture.ExamId);
                Assert.Equal(ExaminationStatus.Published, exam.Status);
                Assert.NotNull(exam.PublishedAtUtc);
                Assert.True(await dbContext.Set<ExaminationStatusChange>()
                    .AnyAsync(x =>
                        x.ExaminationId == exam.Id
                        && x.NewStatus == ExaminationStatus.Published));
                Assert.True(await dbContext.Set<AuditEvent>().AnyAsync(x =>
                    x.EntityId == exam.Id.ToString()
                    && x.EventType == "examination.results.published"));
            }

            var lockedResponse = await SaveMarksAsync(
                client,
                fixture,
                HttpStatusCode.OK,
                firstMark: "90",
                secondAbsent: true);
            var lockedHtml = await lockedResponse.Content.ReadAsStringAsync();
            Assert.Contains("Published marks are read-only", lockedHtml);
            lockedResponse.Dispose();

            token = await GetAntiforgeryTokenAsync(client, resultsPath);
            using var reopen = await client.PostAsync(
                "/Exams/Results?handler=Reopen",
                new FormUrlEncodedContent(
                    new Dictionary<string, string>
                    {
                        ["id"] = fixture.ExamId.ToString(),
                        ["SectionId"] = fixture.SectionId.ToString(),
                        ["ReopenReason"] = "Verified correction requested",
                        ["__RequestVerificationToken"] = token,
                    }));
            Assert.Equal(HttpStatusCode.Redirect, reopen.StatusCode);

            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var dbContext = scope.ServiceProvider
                    .GetRequiredService<SchoolPortalDbContext>();
                var exam = await dbContext.Set<Examination>()
                    .AsNoTracking()
                    .SingleAsync(x => x.Id == fixture.ExamId);
                Assert.Equal(ExaminationStatus.MarksEntry, exam.Status);
                Assert.Null(exam.PublishedAtUtc);
                var change = await dbContext.Set<ExaminationStatusChange>()
                    .AsNoTracking()
                    .SingleAsync(x =>
                        x.ExaminationId == exam.Id
                        && x.OldStatus == ExaminationStatus.Published);
                Assert.Equal("Verified correction requested", change.Reason);
            }
        }
        finally
        {
            await CleanupFixtureAsync(fixture);
            await DeleteUserAsync(account.Username);
        }
    }

    [Fact]
    public async Task TeacherScopeAndEntryWindowAreEnforcedServerSide()
    {
        var account = await CreateUserAsync(RoleCatalog.Teacher);
        var fixture = await CreateFixtureAsync(account.UserId, assignTeacher: true);
        try
        {
            using var client = CreateClient();
            using var login = await LoginAsync(
                client,
                account.Username,
                account.Password);
            Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);

            var overLimit = await SaveMarksAsync(
                client,
                fixture,
                HttpStatusCode.OK,
                firstMark: "101",
                secondAbsent: false);
            var overLimitHtml = await overLimit.Content.ReadAsStringAsync();
            Assert.Contains("Marks cannot exceed 100", overLimitHtml);
            overLimit.Dispose();
            await SaveMarksAsync(
                client,
                fixture,
                HttpStatusCode.Redirect,
                firstMark: "74",
                secondAbsent: false);

            var assignedPath = MarksPath(
                fixture.ExamId,
                fixture.ExamSubjectId,
                fixture.SectionId);
            var token = await GetAntiforgeryTokenAsync(client, assignedPath);
            using var denied = await client.PostAsync(
                "/Exams/Marks?handler=Save",
                new FormUrlEncodedContent(
                    new Dictionary<string, string>
                    {
                        ["ExaminationId"] = fixture.ExamId.ToString(),
                        ["ExaminationSubjectId"] =
                            fixture.ExamSubjectId.ToString(),
                        ["SectionId"] = fixture.UnassignedSectionId.ToString(),
                        ["__RequestVerificationToken"] = token,
                    }));
            Assert.Equal(HttpStatusCode.Redirect, denied.StatusCode);
            Assert.Equal(
                "/Account/AccessDenied",
                denied.Headers.Location?.AbsolutePath);

            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var dbContext = scope.ServiceProvider
                    .GetRequiredService<SchoolPortalDbContext>();
                var exam = await dbContext.Set<Examination>()
                    .SingleAsync(x => x.Id == fixture.ExamId);
                exam.MarksEntryClosesAtUtc = DateTimeOffset.UtcNow.AddMinutes(-1);
                await dbContext.SaveChangesAsync();
            }

            var closedResponse = await SaveMarksAsync(
                client,
                fixture,
                HttpStatusCode.OK,
                firstMark: "75",
                secondAbsent: false);
            var closedHtml = await closedResponse.Content.ReadAsStringAsync();
            Assert.Contains("marks-entry window is closed", closedHtml);
            closedResponse.Dispose();
        }
        finally
        {
            await CleanupFixtureAsync(fixture);
            await DeleteUserAsync(account.Username);
        }
    }

    private static async Task<HttpResponseMessage> SaveMarksAsync(
        HttpClient client,
        ExamFixture fixture,
        HttpStatusCode expectedStatus,
        string firstMark,
        bool secondAbsent)
    {
        var path = MarksPath(
            fixture.ExamId,
            fixture.ExamSubjectId,
            fixture.SectionId);
        var token = await GetAntiforgeryTokenAsync(client, path);
        var fields = new Dictionary<string, string>
        {
            ["ExaminationId"] = fixture.ExamId.ToString(),
            ["ExaminationSubjectId"] = fixture.ExamSubjectId.ToString(),
            ["SectionId"] = fixture.SectionId.ToString(),
            ["Entries[0].EnrollmentId"] = fixture.FirstEnrollmentId.ToString(),
            ["Entries[0].MarksObtained"] = firstMark,
            ["Entries[0].IsAbsent"] = "false",
            ["Entries[0].Remarks"] = string.Empty,
            ["Entries[1].EnrollmentId"] = fixture.SecondEnrollmentId.ToString(),
            ["Entries[1].MarksObtained"] = secondAbsent ? string.Empty : "61",
            ["Entries[1].IsAbsent"] = secondAbsent ? "true" : "false",
            ["Entries[1].Remarks"] = secondAbsent ? "Medical leave" : string.Empty,
            ["__RequestVerificationToken"] = token,
        };
        var response = await client.PostAsync(
            "/Exams/Marks?handler=Save",
            new FormUrlEncodedContent(fields));
        var body = await response.Content.ReadAsStringAsync();
        Assert.True(
            response.StatusCode == expectedStatus,
            $"Expected {expectedStatus}, received {response.StatusCode}: {body}");
        return response;
    }

    private async Task<TestAccount> CreateUserAsync(string role)
    {
        var username = $"exam-{Guid.NewGuid():N}";
        const string password = "SafePassword9";
        await using var scope = factory.Services.CreateAsyncScope();
        var userManager = scope.ServiceProvider
            .GetRequiredService<UserManager<ApplicationUser>>();
        var user = new ApplicationUser
        {
            UserName = username,
            DisplayName = "Examination test user",
            IsActive = true,
        };
        Assert.True((await userManager.CreateAsync(user, password)).Succeeded);
        Assert.True((await userManager.AddToRoleAsync(user, role)).Succeeded);
        return new TestAccount(user.Id, username, password);
    }

    private async Task<ExamFixture> CreateFixtureAsync(
        Guid teacherUserId,
        bool assignTeacher)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<SchoolPortalDbContext>();
        var suffix = Guid.NewGuid().ToString("N")[..8];
        var year = new AcademicYear
        {
            Name = $"E{suffix}",
            StartDate = DateOnly.FromDateTime(DateTime.Today.AddMonths(-4)),
            EndDate = DateOnly.FromDateTime(DateTime.Today.AddMonths(8)),
        };
        var schoolClass = new SchoolClass
        {
            Name = $"Exam class {suffix}",
            SortOrder = 997,
        };
        var section = new Section
        {
            AcademicYear = year,
            Class = schoolClass,
            Name = "A",
            Capacity = 40,
        };
        var unassignedSection = new Section
        {
            AcademicYear = year,
            Class = schoolClass,
            Name = "B",
            Capacity = 40,
        };
        var subject = new Subject
        {
            Class = schoolClass,
            Name = $"Mathematics {suffix}",
            Code = $"M{suffix}",
            MaximumMarks = 100,
        };
        if (assignTeacher)
        {
            dbContext.Add(new TeacherAssignment
            {
                AcademicYear = year,
                Class = schoolClass,
                Section = section,
                Subject = subject,
                TeacherUserId = teacherUserId,
            });
        }

        var firstStudent = new Student
        {
            AdmissionNumber = $"EX-1-{suffix}",
            FirstName = "First",
            LastName = "Candidate",
            AdmissionDate = DateOnly.FromDateTime(DateTime.Today),
        };
        var secondStudent = new Student
        {
            AdmissionNumber = $"EX-2-{suffix}",
            FirstName = "Second",
            LastName = "Candidate",
            AdmissionDate = DateOnly.FromDateTime(DateTime.Today),
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
        var exam = new Examination
        {
            AcademicYear = year,
            Class = schoolClass,
            Name = $"Unit Test {suffix}",
            Term = "Unit Test",
            Status = ExaminationStatus.MarksEntry,
            MarksEntryOpensAtUtc = DateTimeOffset.UtcNow.AddHours(-1),
            MarksEntryClosesAtUtc = DateTimeOffset.UtcNow.AddDays(2),
        };
        var examSubject = new ExaminationSubject
        {
            Examination = exam,
            Subject = subject,
            MaximumMarks = 100,
            PassMarks = 40,
        };
        dbContext.AddRange(
            section,
            unassignedSection,
            firstEnrollment,
            secondEnrollment,
            examSubject,
            new GradeRule
            {
                AcademicYear = year,
                Class = schoolClass,
                Grade = "A",
                MinimumPercent = 50,
                MaximumPercent = 100,
            },
            new GradeRule
            {
                AcademicYear = year,
                Class = schoolClass,
                Grade = "F",
                MinimumPercent = 0,
                MaximumPercent = 49.99m,
            });
        await dbContext.SaveChangesAsync();
        return new ExamFixture(
            year.Id,
            schoolClass.Id,
            section.Id,
            unassignedSection.Id,
            subject.Id,
            firstStudent.Id,
            secondStudent.Id,
            firstEnrollment.Id,
            secondEnrollment.Id,
            exam.Id,
            examSubject.Id);
    }

    private async Task CleanupFixtureAsync(ExamFixture fixture)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<SchoolPortalDbContext>();
        var auditEntityIds = new[]
        {
            fixture.ExamId.ToString(),
            fixture.ExamSubjectId.ToString(),
        };
        await dbContext.Set<AuditEvent>()
            .Where(x => auditEntityIds.Contains(x.EntityId))
            .ExecuteDeleteAsync();
        await dbContext.Set<ExaminationStatusChange>()
            .Where(x => x.ExaminationId == fixture.ExamId)
            .ExecuteDeleteAsync();
        await dbContext.Set<StudentMark>()
            .Where(x => x.ExaminationSubjectId == fixture.ExamSubjectId)
            .ExecuteDeleteAsync();
        await dbContext.Set<ExaminationSubject>()
            .Where(x => x.Id == fixture.ExamSubjectId)
            .ExecuteDeleteAsync();
        await dbContext.Set<Examination>()
            .Where(x => x.Id == fixture.ExamId)
            .ExecuteDeleteAsync();
        await dbContext.Set<GradeRule>()
            .Where(x =>
                x.AcademicYearId == fixture.YearId
                && x.ClassId == fixture.ClassId)
            .ExecuteDeleteAsync();
        await dbContext.Set<TeacherAssignment>()
            .Where(x =>
                x.AcademicYearId == fixture.YearId
                && x.ClassId == fixture.ClassId)
            .ExecuteDeleteAsync();
        await dbContext.Set<StudentEnrollment>()
            .Where(x =>
                x.Id == fixture.FirstEnrollmentId
                || x.Id == fixture.SecondEnrollmentId)
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
        await dbContext.Set<Subject>()
            .Where(x => x.Id == fixture.SubjectId)
            .ExecuteDeleteAsync();
        await dbContext.Set<AcademicYear>()
            .Where(x => x.Id == fixture.YearId)
            .ExecuteDeleteAsync();
        await dbContext.Set<SchoolClass>()
            .Where(x => x.Id == fixture.ClassId)
            .ExecuteDeleteAsync();
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
        Assert.True(
            response.IsSuccessStatusCode,
            $"Expected {path} to succeed, received {(int)response.StatusCode}.");
        var html = await response.Content.ReadAsStringAsync();
        var tokenMatch = AntiforgeryTokenPattern().Match(html);
        Assert.True(tokenMatch.Success, $"Anti-forgery token missing from {path}.");
        return WebUtility.HtmlDecode(tokenMatch.Groups[1].Value);
    }

    private static string MarksPath(
        Guid examId,
        Guid examSubjectId,
        Guid sectionId) =>
        $"/Exams/Marks?ExaminationId={examId}"
        + $"&ExaminationSubjectId={examSubjectId}"
        + $"&SectionId={sectionId}";

    [GeneratedRegex(
        "name=\"__RequestVerificationToken\"[^>]*value=\"([^\"]+)\"",
        RegexOptions.CultureInvariant)]
    private static partial Regex AntiforgeryTokenPattern();

    private sealed record TestAccount(
        Guid UserId,
        string Username,
        string Password);

    private sealed record ExamFixture(
        Guid YearId,
        Guid ClassId,
        Guid SectionId,
        Guid UnassignedSectionId,
        Guid SubjectId,
        Guid FirstStudentId,
        Guid SecondStudentId,
        Guid FirstEnrollmentId,
        Guid SecondEnrollmentId,
        Guid ExamId,
        Guid ExamSubjectId);
}
