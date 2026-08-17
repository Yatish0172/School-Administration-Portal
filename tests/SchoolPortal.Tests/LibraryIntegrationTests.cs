using System.Net;
using System.Net.Mime;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Administration;
using SchoolPortal.Domain.Library;
using SchoolPortal.Domain.Students;
using SchoolPortal.Infrastructure.Identity;
using SchoolPortal.Infrastructure.Persistence;

namespace SchoolPortal.Tests;

public sealed partial class LibraryIntegrationTests(
    WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task CirculationEnforcesLimitsAndPreservesCompleteHistory()
    {
        var account = await CreateUserAsync(RoleCatalog.Librarian);
        var fixture = await CreateFixtureAsync(account.UserId);
        try
        {
            using var client = CreateClient();
            using var login = await LoginAsync(
                client,
                account.Username,
                account.Password);
            Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);

            using var firstIssue = await IssueAsync(
                client,
                fixture.StudentId,
                fixture.FirstAccession,
                DateOnly.FromDateTime(DateTime.Today.AddDays(-10)));
            Assert.True(
                firstIssue.StatusCode == HttpStatusCode.Redirect,
                await firstIssue.Content.ReadAsStringAsync());
            using var secondIssue = await IssueAsync(
                client,
                fixture.StudentId,
                fixture.SecondAccession,
                DateOnly.FromDateTime(DateTime.Today));
            Assert.Equal(HttpStatusCode.Redirect, secondIssue.StatusCode);

            using var limitResponse = await IssueAsync(
                client,
                fixture.StudentId,
                fixture.ThirdAccession,
                DateOnly.FromDateTime(DateTime.Today));
            Assert.Equal(HttpStatusCode.OK, limitResponse.StatusCode);
            Assert.Contains(
                "configured limit is 2",
                await limitResponse.Content.ReadAsStringAsync());

            Guid firstIssueId;
            Guid secondIssueId;
            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var dbContext = scope.ServiceProvider
                    .GetRequiredService<SchoolPortalDbContext>();
                var issues = await dbContext.Set<BookIssue>()
                    .AsNoTracking()
                    .Include(x => x.LibraryCopy)
                    .Where(x => x.StudentId == fixture.StudentId)
                    .ToListAsync();
                Assert.Equal(2, issues.Count);
                firstIssueId = issues.Single(
                    x => x.LibraryCopy.AccessionNumber == fixture.FirstAccession).Id;
                secondIssueId = issues.Single(
                    x => x.LibraryCopy.AccessionNumber == fixture.SecondAccession).Id;
            }

            using var overdueRenewal = await RenewAsync(
                client,
                firstIssueId,
                fixture.StudentId);
            Assert.Equal(HttpStatusCode.OK, overdueRenewal.StatusCode);
            Assert.Contains(
                "overdue book must be returned",
                await overdueRenewal.Content.ReadAsStringAsync());

            using var renewed = await RenewAsync(
                client,
                secondIssueId,
                fixture.StudentId);
            Assert.Equal(HttpStatusCode.Redirect, renewed.StatusCode);
            using var renewalLimit = await RenewAsync(
                client,
                secondIssueId,
                fixture.StudentId);
            Assert.Equal(HttpStatusCode.OK, renewalLimit.StatusCode);
            Assert.Contains(
                "maximum of 1 renewal",
                await renewalLimit.Content.ReadAsStringAsync());

            using var returned = await ReturnAsync(
                client,
                firstIssueId,
                fixture.StudentId);
            Assert.Equal(HttpStatusCode.Redirect, returned.StatusCode);

            Guid fineId;
            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var dbContext = scope.ServiceProvider
                    .GetRequiredService<SchoolPortalDbContext>();
                var issue = await dbContext.Set<BookIssue>()
                    .AsNoTracking()
                    .Include(x => x.LibraryCopy)
                    .Include(x => x.Fine)
                    .SingleAsync(x => x.Id == firstIssueId);
                Assert.Equal(BookIssueStatus.Returned, issue.Status);
                Assert.Equal(LibraryCopyStatus.Available, issue.LibraryCopy.Status);
                Assert.NotNull(issue.Fine);
                Assert.Equal(6m, issue.Fine.Amount);
                Assert.Equal(3, issue.Fine.DaysOverdue);
                fineId = issue.Fine.Id;
            }

            var finePath = "/Library/Fines?Status=Pending";
            var fineToken = await GetAntiforgeryTokenAsync(client, finePath);
            using var settleFine = await client.PostAsync(
                "/Library/Fines?handler=Settle",
                new FormUrlEncodedContent(
                    new Dictionary<string, string>
                    {
                        ["fineId"] = fineId.ToString(),
                        ["waive"] = "false",
                        ["SettlementReason"] = string.Empty,
                        ["__RequestVerificationToken"] = fineToken,
                    }));
            Assert.Equal(HttpStatusCode.Redirect, settleFine.StatusCode);

            var circulationPath =
                $"/Library/Circulation?StudentId={fixture.StudentId}";
            var lossToken = await GetAntiforgeryTokenAsync(
                client,
                circulationPath);
            using var lost = await client.PostAsync(
                "/Library/Circulation?handler=Lost",
                new FormUrlEncodedContent(
                    new Dictionary<string, string>
                    {
                        ["issueId"] = secondIssueId.ToString(),
                        ["studentId"] = fixture.StudentId.ToString(),
                        ["LossReason"] = "Reported missing by student",
                        ["__RequestVerificationToken"] = lossToken,
                    }));
            Assert.Equal(HttpStatusCode.Redirect, lost.StatusCode);

            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var dbContext = scope.ServiceProvider
                    .GetRequiredService<SchoolPortalDbContext>();
                var renewedIssue = await dbContext.Set<BookIssue>()
                    .AsNoTracking()
                    .Include(x => x.LibraryCopy)
                    .Include(x => x.Renewals)
                    .SingleAsync(x => x.Id == secondIssueId);
                Assert.Equal(BookIssueStatus.Lost, renewedIssue.Status);
                Assert.Equal(LibraryCopyStatus.Lost, renewedIssue.LibraryCopy.Status);
                Assert.Single(renewedIssue.Renewals);
                var fine = await dbContext.Set<LibraryFine>()
                    .AsNoTracking()
                    .SingleAsync(x => x.Id == fineId);
                Assert.Equal(LibraryFineStatus.Paid, fine.Status);
                Assert.True(await dbContext.Set<AuditEvent>().AnyAsync(x =>
                    x.EntityId == firstIssueId.ToString()
                    && x.EventType == "library.book.returned"));
                Assert.True(await dbContext.Set<AuditEvent>().AnyAsync(x =>
                    x.EntityId == secondIssueId.ToString()
                    && x.EventType == "library.book.lost"));
            }

            using var reports = await client.GetAsync(
                $"/Library/Reports?StudentId={fixture.StudentId}");
            Assert.Equal(HttpStatusCode.OK, reports.StatusCode);
            var reportHtml = await reports.Content.ReadAsStringAsync();
            Assert.Contains(fixture.FirstAccession, reportHtml);
            Assert.Contains(fixture.SecondAccession, reportHtml);
        }
        finally
        {
            await CleanupFixtureAsync(fixture);
            await DeleteUserAsync(account.Username);
        }
    }

    [Fact]
    public async Task LibraryRoutesEnforceRolePermissions()
    {
        var teacher = await CreateUserAsync(RoleCatalog.Teacher);
        var accounts = await CreateUserAsync(RoleCatalog.Accounts);
        var principal = await CreateUserAsync(RoleCatalog.Principal);
        try
        {
            using (var teacherClient = CreateClient())
            {
                using var login = await LoginAsync(
                    teacherClient,
                    teacher.Username,
                    teacher.Password);
                Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);
                using var circulation = await teacherClient.GetAsync(
                    "/Library/Circulation");
                Assert.Equal(HttpStatusCode.OK, circulation.StatusCode);
                var token = await GetAntiforgeryTokenAsync(
                    teacherClient,
                    "/Library/Circulation");
                using var deniedIssue = await teacherClient.PostAsync(
                    "/Library/Circulation?handler=Issue",
                    new FormUrlEncodedContent(
                        new Dictionary<string, string>
                        {
                            ["Issue.StudentId"] = Guid.NewGuid().ToString(),
                            ["Issue.AccessionNumber"] = "ACC-NOACCESS",
                            ["Issue.IssuedDate"] = DateTime.Today.ToString(
                                "yyyy-MM-dd",
                                System.Globalization.CultureInfo.InvariantCulture),
                            ["__RequestVerificationToken"] = token,
                        }));
                Assert.Equal(HttpStatusCode.Redirect, deniedIssue.StatusCode);
                Assert.Equal(
                    "/Account/AccessDenied",
                    deniedIssue.Headers.Location?.AbsolutePath);
            }

            using (var accountsClient = CreateClient())
            {
                using var login = await LoginAsync(
                    accountsClient,
                    accounts.Username,
                    accounts.Password);
                Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);
                using var fines = await accountsClient.GetAsync("/Library/Fines");
                Assert.Equal(HttpStatusCode.OK, fines.StatusCode);
                using var catalogue = await accountsClient.GetAsync("/Library/Index");
                Assert.Equal(HttpStatusCode.Redirect, catalogue.StatusCode);
                Assert.Equal(
                    "/Account/AccessDenied",
                    catalogue.Headers.Location?.AbsolutePath);
            }

            using (var principalClient = CreateClient())
            {
                using var login = await LoginAsync(
                    principalClient,
                    principal.Username,
                    principal.Password);
                Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);
                using var reports = await principalClient.GetAsync("/Library/Reports");
                Assert.Equal(HttpStatusCode.OK, reports.StatusCode);
            }
        }
        finally
        {
            await DeleteUserAsync(teacher.Username);
            await DeleteUserAsync(accounts.Username);
            await DeleteUserAsync(principal.Username);
        }
    }

    private static async Task<HttpResponseMessage> IssueAsync(
        HttpClient client,
        Guid studentId,
        string accessionNumber,
        DateOnly issuedDate)
    {
        var token = await GetAntiforgeryTokenAsync(
            client,
            $"/Library/Circulation?StudentId={studentId}");
        return await client.PostAsync(
            "/Library/Circulation?handler=Issue",
            new FormUrlEncodedContent(
                new Dictionary<string, string>
                {
                    ["Issue.StudentId"] = studentId.ToString(),
                    ["Issue.AccessionNumber"] = accessionNumber,
                    ["Issue.IssuedDate"] = issuedDate.ToString(
                        "yyyy-MM-dd",
                        System.Globalization.CultureInfo.InvariantCulture),
                    ["__RequestVerificationToken"] = token,
                }));
    }

    private static async Task<HttpResponseMessage> RenewAsync(
        HttpClient client,
        Guid issueId,
        Guid studentId)
    {
        var token = await GetAntiforgeryTokenAsync(
            client,
            $"/Library/Circulation?StudentId={studentId}");
        return await client.PostAsync(
            "/Library/Circulation?handler=Renew",
            new FormUrlEncodedContent(
                new Dictionary<string, string>
                {
                    ["issueId"] = issueId.ToString(),
                    ["studentId"] = studentId.ToString(),
                    ["__RequestVerificationToken"] = token,
                }));
    }

    private static async Task<HttpResponseMessage> ReturnAsync(
        HttpClient client,
        Guid issueId,
        Guid studentId)
    {
        var token = await GetAntiforgeryTokenAsync(
            client,
            $"/Library/Circulation?StudentId={studentId}");
        return await client.PostAsync(
            "/Library/Circulation?handler=Return",
            new FormUrlEncodedContent(
                new Dictionary<string, string>
                {
                    ["Return.IssueId"] = issueId.ToString(),
                    ["Return.StudentId"] = studentId.ToString(),
                    ["Return.ReturnedDate"] = DateTime.Today.ToString(
                        "yyyy-MM-dd",
                        System.Globalization.CultureInfo.InvariantCulture),
                    ["Return.Condition"] = LibraryCopyCondition.Good.ToString(),
                    ["__RequestVerificationToken"] = token,
                }));
    }

    private async Task<TestAccount> CreateUserAsync(string role)
    {
        var username = $"library-{Guid.NewGuid():N}";
        const string password = "SafePassword9";
        await using var scope = factory.Services.CreateAsyncScope();
        var userManager = scope.ServiceProvider
            .GetRequiredService<UserManager<ApplicationUser>>();
        var user = new ApplicationUser
        {
            UserName = username,
            DisplayName = "Library integration user",
            IsActive = true,
        };
        Assert.True((await userManager.CreateAsync(user, password)).Succeeded);
        Assert.True((await userManager.AddToRoleAsync(user, role)).Succeeded);
        return new TestAccount(user.Id, username, password);
    }

    private async Task<LibraryFixture> CreateFixtureAsync(Guid userId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<SchoolPortalDbContext>();
        var suffix = Guid.NewGuid().ToString("N")[..8].ToUpperInvariant();
        var student = new Student
        {
            AdmissionNumber = $"LIB-{suffix}",
            FirstName = "Library",
            LastName = "Student",
            AdmissionDate = DateOnly.FromDateTime(DateTime.Today),
        };
        var author = new LibraryAuthor { Name = $"Author {suffix}" };
        var category = new LibraryCategory { Name = $"Category {suffix}" };
        var publisher = new LibraryPublisher { Name = $"Publisher {suffix}" };
        var title = new LibraryTitle
        {
            Title = $"Test title {suffix}",
            Author = author,
            Category = category,
            Publisher = publisher,
            Isbn = $"978-{suffix}",
        };
        var firstCopy = new LibraryCopy
        {
            LibraryTitle = title,
            AccessionNumber = $"ACC-{suffix}-1",
        };
        var secondCopy = new LibraryCopy
        {
            LibraryTitle = title,
            AccessionNumber = $"ACC-{suffix}-2",
        };
        var thirdCopy = new LibraryCopy
        {
            LibraryTitle = title,
            AccessionNumber = $"ACC-{suffix}-3",
        };
        var policy = new LibraryPolicy
        {
            LoanDays = 7,
            MaximumBooksPerStudent = 2,
            MaximumRenewals = 1,
            FinePerOverdueDay = 2,
            UpdatedByUserId = userId,
            UpdatedAtUtc = DateTimeOffset.UtcNow.AddSeconds(1),
        };
        dbContext.AddRange(student, firstCopy, secondCopy, thirdCopy, policy);
        await dbContext.SaveChangesAsync();
        return new LibraryFixture(
            student.Id,
            author.Id,
            category.Id,
            publisher.Id,
            title.Id,
            firstCopy.Id,
            secondCopy.Id,
            thirdCopy.Id,
            firstCopy.AccessionNumber,
            secondCopy.AccessionNumber,
            thirdCopy.AccessionNumber,
            policy.Id);
    }

    private async Task CleanupFixtureAsync(LibraryFixture fixture)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<SchoolPortalDbContext>();
        var issueIds = await dbContext.Set<BookIssue>()
            .Where(x => x.StudentId == fixture.StudentId)
            .Select(x => x.Id)
            .ToListAsync();
        var fineIds = await dbContext.Set<LibraryFine>()
            .Where(x => issueIds.Contains(x.BookIssueId))
            .Select(x => x.Id)
            .ToListAsync();
        var auditEntityIds = issueIds
            .Concat(fineIds)
            .Select(x => x.ToString())
            .ToArray();
        await dbContext.Set<AuditEvent>()
            .Where(x => auditEntityIds.Contains(x.EntityId))
            .ExecuteDeleteAsync();
        await dbContext.Set<LibraryFine>()
            .Where(x => issueIds.Contains(x.BookIssueId))
            .ExecuteDeleteAsync();
        await dbContext.Set<BookRenewal>()
            .Where(x => issueIds.Contains(x.BookIssueId))
            .ExecuteDeleteAsync();
        await dbContext.Set<BookIssue>()
            .Where(x => issueIds.Contains(x.Id))
            .ExecuteDeleteAsync();
        var copyIds = new[]
        {
            fixture.FirstCopyId,
            fixture.SecondCopyId,
            fixture.ThirdCopyId,
        };
        await dbContext.Set<LibraryCopy>()
            .Where(x => copyIds.Contains(x.Id))
            .ExecuteDeleteAsync();
        await dbContext.Set<LibraryTitle>()
            .Where(x => x.Id == fixture.TitleId)
            .ExecuteDeleteAsync();
        await dbContext.Set<LibraryAuthor>()
            .Where(x => x.Id == fixture.AuthorId)
            .ExecuteDeleteAsync();
        await dbContext.Set<LibraryCategory>()
            .Where(x => x.Id == fixture.CategoryId)
            .ExecuteDeleteAsync();
        await dbContext.Set<LibraryPublisher>()
            .Where(x => x.Id == fixture.PublisherId)
            .ExecuteDeleteAsync();
        await dbContext.Set<LibraryPolicy>()
            .Where(x => x.Id == fixture.PolicyId)
            .ExecuteDeleteAsync();
        await dbContext.Set<Student>()
            .Where(x => x.Id == fixture.StudentId)
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
        Assert.Equal(
            MediaTypeNames.Text.Html,
            response.Content.Headers.ContentType?.MediaType);
        var html = await response.Content.ReadAsStringAsync();
        var tokenMatch = AntiforgeryTokenPattern().Match(html);
        Assert.True(tokenMatch.Success, $"Anti-forgery token missing from {path}.");
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

    private sealed record LibraryFixture(
        Guid StudentId,
        Guid AuthorId,
        Guid CategoryId,
        Guid PublisherId,
        Guid TitleId,
        Guid FirstCopyId,
        Guid SecondCopyId,
        Guid ThirdCopyId,
        string FirstAccession,
        string SecondAccession,
        string ThirdAccession,
        Guid PolicyId);
}
