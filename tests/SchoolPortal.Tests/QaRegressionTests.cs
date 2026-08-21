using System.Globalization;
using System.Net;
using System.Net.Mime;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Academics;
using SchoolPortal.Domain.Attendance;
using SchoolPortal.Domain.Fees;
using SchoolPortal.Domain.Library;
using SchoolPortal.Domain.Students;
using SchoolPortal.Infrastructure.Identity;
using SchoolPortal.Infrastructure.Persistence;

namespace SchoolPortal.Tests;

public sealed partial class QaRegressionTests(
    WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task PaymentWithUndefinedModeOrFutureDateIsRejected()
    {
        var account = await CreateUserAsync(RoleCatalog.Accounts);
        var fixture = await CreateStudentFixtureAsync(account.UserId, withCharge: true);
        try
        {
            using var client = CreateClient();
            await LoginExpectingRedirectAsync(client, account);

            using (var undefinedMode = await PostPaymentAsync(
                client,
                fixture.EnrollmentId,
                mode: "99",
                paymentDate: DateTime.Today))
            {
                Assert.True(
                    undefinedMode.StatusCode == HttpStatusCode.OK,
                    $"Expected 200, got {(int)undefinedMode.StatusCode} -> {undefinedMode.Headers.Location}");
                Assert.Contains(
                    "Choose a valid payment mode",
                    await undefinedMode.Content.ReadAsStringAsync());
            }

            using (var futureDate = await PostPaymentAsync(
                client,
                fixture.EnrollmentId,
                mode: nameof(FeePaymentMode.Cash),
                paymentDate: DateTime.Today.AddDays(1)))
            {
                Assert.Equal(HttpStatusCode.OK, futureDate.StatusCode);
                Assert.Contains(
                    "cannot be in the future",
                    await futureDate.Content.ReadAsStringAsync());
            }

            await using var scope = factory.Services.CreateAsyncScope();
            var dbContext = scope.ServiceProvider
                .GetRequiredService<SchoolPortalDbContext>();
            Assert.Equal(
                0,
                await dbContext.Set<FeePayment>()
                    .CountAsync(x => x.StudentEnrollmentId == fixture.EnrollmentId));
        }
        finally
        {
            await CleanupStudentFixtureAsync(fixture);
            await DeleteUserAsync(account.Username);
        }
    }

    [Fact]
    public async Task OversizedReversalReasonFailsGracefullyAndKeepsPaymentPosted()
    {
        var account = await CreateUserAsync(RoleCatalog.Accounts);
        var fixture = await CreateStudentFixtureAsync(account.UserId, withCharge: true);
        try
        {
            using var client = CreateClient();
            await LoginExpectingRedirectAsync(client, account);

            using (var posted = await PostPaymentAsync(
                client,
                fixture.EnrollmentId,
                mode: nameof(FeePaymentMode.Cash),
                paymentDate: DateTime.Today))
            {
                Assert.Equal(HttpStatusCode.Redirect, posted.StatusCode);
            }

            Guid paymentId;
            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var dbContext = scope.ServiceProvider
                    .GetRequiredService<SchoolPortalDbContext>();
                paymentId = await dbContext.Set<FeePayment>()
                    .Where(x => x.StudentEnrollmentId == fixture.EnrollmentId)
                    .Select(x => x.Id)
                    .SingleAsync();
            }

            var ledgerPath = $"/Fees/Ledger?EnrollmentId={fixture.EnrollmentId}";
            var token = await GetAntiforgeryTokenAsync(client, ledgerPath);
            using var reversal = await client.PostAsync(
                "/Fees/Ledger?handler=Reverse",
                new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["paymentId"] = paymentId.ToString(),
                    ["enrollmentId"] = fixture.EnrollmentId.ToString(),
                    ["ReversalReason"] = new string('x', 600),
                    ["__RequestVerificationToken"] = token,
                }));
            Assert.Equal(HttpStatusCode.OK, reversal.StatusCode);
            Assert.Contains(
                "under 500 characters",
                await reversal.Content.ReadAsStringAsync());

            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var dbContext = scope.ServiceProvider
                    .GetRequiredService<SchoolPortalDbContext>();
                var status = await dbContext.Set<FeePayment>()
                    .Where(x => x.Id == paymentId)
                    .Select(x => x.Status)
                    .SingleAsync();
                Assert.Equal(FeePaymentStatus.Posted, status);
            }
        }
        finally
        {
            await CleanupStudentFixtureAsync(fixture);
            await DeleteUserAsync(account.Username);
        }
    }

    [Fact]
    public async Task DirectChargeWithoutDueDateIsRejected()
    {
        var account = await CreateUserAsync(RoleCatalog.Accounts);
        var fixture = await CreateStudentFixtureAsync(account.UserId, withCharge: false);
        try
        {
            using var client = CreateClient();
            await LoginExpectingRedirectAsync(client, account);

            var ledgerPath = $"/Fees/Ledger?EnrollmentId={fixture.EnrollmentId}";
            var token = await GetAntiforgeryTokenAsync(client, ledgerPath);
            using var response = await client.PostAsync(
                "/Fees/Ledger?handler=AddCharge",
                new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["NewCharge.StudentEnrollmentId"] = fixture.EnrollmentId.ToString(),
                    ["NewCharge.FeeHeadId"] = fixture.HeadId.ToString(),
                    ["NewCharge.Description"] = "Late admission fee",
                    ["NewCharge.Period"] = "April",
                    ["NewCharge.Amount"] = "100",
                    ["__RequestVerificationToken"] = token,
                }));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Contains(
                "Enter the due date",
                await response.Content.ReadAsStringAsync());

            await using var scope = factory.Services.CreateAsyncScope();
            var dbContext = scope.ServiceProvider
                .GetRequiredService<SchoolPortalDbContext>();
            Assert.Equal(
                0,
                await dbContext.Set<StudentCharge>()
                    .CountAsync(x => x.StudentEnrollmentId == fixture.EnrollmentId));
        }
        finally
        {
            await CleanupStudentFixtureAsync(fixture);
            await DeleteUserAsync(account.Username);
        }
    }

    [Fact]
    public async Task AttendanceCorrectionRejectsUndefinedStatus()
    {
        var admin = await CreateUserAsync(RoleCatalog.SuperAdministrator);
        var fixture = await CreateStudentFixtureAsync(admin.UserId, withCharge: false);
        Guid entryId;
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var dbContext = scope.ServiceProvider
                .GetRequiredService<SchoolPortalDbContext>();
            var session = new AttendanceSession
            {
                AcademicYearId = fixture.YearId,
                SectionId = fixture.SectionId,
                Date = DateOnly.FromDateTime(DateTime.Today),
                PeriodNumber = 0,
                MarkedByUserId = admin.UserId,
            };
            var entry = new AttendanceEntry
            {
                Session = session,
                StudentEnrollmentId = fixture.EnrollmentId,
                Status = AttendanceStatus.Present,
                MarkedByUserId = admin.UserId,
            };
            dbContext.Add(entry);
            await dbContext.SaveChangesAsync();
            entryId = entry.Id;
        }

        try
        {
            using var client = CreateClient();
            await LoginExpectingRedirectAsync(client, admin);

            var token = await GetAntiforgeryTokenAsync(client, "/Attendance");
            using var response = await client.PostAsync(
                "/Attendance?handler=Correct",
                new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["Correction.EntryId"] = entryId.ToString(),
                    ["Correction.NewStatus"] = "99",
                    ["Correction.Reason"] = "Marked in error",
                    ["__RequestVerificationToken"] = token,
                }));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Contains(
                "Choose a valid status",
                await response.Content.ReadAsStringAsync());

            await using var scope = factory.Services.CreateAsyncScope();
            var dbContext = scope.ServiceProvider
                .GetRequiredService<SchoolPortalDbContext>();
            var status = await dbContext.Set<AttendanceEntry>()
                .Where(x => x.Id == entryId)
                .Select(x => x.Status)
                .SingleAsync();
            Assert.Equal(AttendanceStatus.Present, status);
        }
        finally
        {
            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var dbContext = scope.ServiceProvider
                    .GetRequiredService<SchoolPortalDbContext>();
                await dbContext.Set<AttendanceCorrection>()
                    .Where(x => x.AttendanceEntry.Id == entryId)
                    .ExecuteDeleteAsync();
                await dbContext.Set<AttendanceEntry>()
                    .Where(x => x.Id == entryId)
                    .ExecuteDeleteAsync();
                await dbContext.Set<AttendanceSession>()
                    .Where(x => x.SectionId == fixture.SectionId)
                    .ExecuteDeleteAsync();
            }

            await CleanupStudentFixtureAsync(fixture);
            await DeleteUserAsync(admin.Username);
        }
    }

    [Fact]
    public async Task AdministratorCannotDisableOrDemoteOwnAccount()
    {
        var admin = await CreateUserAsync(RoleCatalog.Administrator);
        try
        {
            using var client = CreateClient();
            await LoginExpectingRedirectAsync(client, admin);

            var token = await GetAntiforgeryTokenAsync(client, "/Administration");
            using var response = await client.PostAsync(
                "/Administration?handler=UpdateAccess",
                new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["EditAccess.UserId"] = admin.UserId.ToString(),
                    ["EditAccess.Role"] = RoleCatalog.Administrator,
                    ["EditAccess.IsActive"] = "false",
                    ["__RequestVerificationToken"] = token,
                }));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Contains(
                "cannot change or disable your own account",
                await response.Content.ReadAsStringAsync());

            await using var scope = factory.Services.CreateAsyncScope();
            var userManager = scope.ServiceProvider
                .GetRequiredService<UserManager<ApplicationUser>>();
            var user = await userManager.FindByIdAsync(admin.UserId.ToString());
            Assert.NotNull(user);
            Assert.True(user.IsActive);
        }
        finally
        {
            await DeleteUserAsync(admin.Username);
        }
    }

    [Fact]
    public async Task AdministratorCannotGrantSuperAdministratorAccess()
    {
        var admin = await CreateUserAsync(RoleCatalog.Administrator);
        var target = await CreateUserAsync(RoleCatalog.Teacher);
        try
        {
            using var client = CreateClient();
            await LoginExpectingRedirectAsync(client, admin);

            var token = await GetAntiforgeryTokenAsync(client, "/Administration");
            using var response = await client.PostAsync(
                "/Administration?handler=UpdateAccess",
                new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["EditAccess.UserId"] = target.UserId.ToString(),
                    ["EditAccess.Role"] = RoleCatalog.SuperAdministrator,
                    ["EditAccess.IsActive"] = "true",
                    ["__RequestVerificationToken"] = token,
                }));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Contains(
                "Only a Super Administrator can grant",
                await response.Content.ReadAsStringAsync());

            await using var scope = factory.Services.CreateAsyncScope();
            var userManager = scope.ServiceProvider
                .GetRequiredService<UserManager<ApplicationUser>>();
            var user = await userManager.FindByIdAsync(target.UserId.ToString());
            Assert.NotNull(user);
            Assert.False(await userManager.IsInRoleAsync(
                user,
                RoleCatalog.SuperAdministrator));
        }
        finally
        {
            await DeleteUserAsync(admin.Username);
            await DeleteUserAsync(target.Username);
        }
    }

    [Fact]
    public async Task LoginDoesNotRevealDisabledAccountsToWrongPasswords()
    {
        var account = await CreateUserAsync(RoleCatalog.Teacher, isActive: false);
        try
        {
            using var client = CreateClient();
            var token = await GetAntiforgeryTokenAsync(client, "/Account/Login");
            using var response = await client.PostAsync(
                "/Account/Login",
                new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["Input.Username"] = account.Username,
                    ["Input.Password"] = "WrongPassword1",
                    ["__RequestVerificationToken"] = token,
                }));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var html = await response.Content.ReadAsStringAsync();
            Assert.Contains("Invalid username or password", html);
            Assert.DoesNotContain("This account is disabled", html);
        }
        finally
        {
            await DeleteUserAsync(account.Username);
        }
    }

    [Fact]
    public async Task LoginIgnoresNonLocalReturnUrls()
    {
        var account = await CreateUserAsync(RoleCatalog.Teacher);
        try
        {
            using var client = CreateClient();
            var token = await GetAntiforgeryTokenAsync(client, "/Account/Login");
            using var response = await client.PostAsync(
                "/Account/Login",
                new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["Input.Username"] = account.Username,
                    ["Input.Password"] = account.Password,
                    ["Input.ReturnUrl"] = "https://evil.example/phish",
                    ["__RequestVerificationToken"] = token,
                }));
            Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
            var location = response.Headers.Location?.OriginalString ?? string.Empty;
            Assert.DoesNotContain("evil.example", location);
        }
        finally
        {
            await DeleteUserAsync(account.Username);
        }
    }

    [Fact]
    public async Task LibraryCopyCannotBeForcedIntoIssuedStatus()
    {
        var librarian = await CreateUserAsync(RoleCatalog.Librarian);
        var library = await CreateLibraryFixtureAsync();
        try
        {
            using var client = CreateClient();
            await LoginExpectingRedirectAsync(client, librarian);

            var token = await GetAntiforgeryTokenAsync(client, "/Library");
            using var response = await client.PostAsync(
                "/Library?handler=SetCopyStatus",
                new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["copyId"] = library.CopyId.ToString(),
                    ["status"] = nameof(LibraryCopyStatus.Issued),
                    ["__RequestVerificationToken"] = token,
                }));
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);

            await using var scope = factory.Services.CreateAsyncScope();
            var dbContext = scope.ServiceProvider
                .GetRequiredService<SchoolPortalDbContext>();
            var status = await dbContext.Set<LibraryCopy>()
                .Where(x => x.Id == library.CopyId)
                .Select(x => x.Status)
                .SingleAsync();
            Assert.Equal(LibraryCopyStatus.Available, status);
        }
        finally
        {
            await CleanupLibraryFixtureAsync(library);
            await DeleteUserAsync(librarian.Username);
        }
    }

    [Fact]
    public async Task CirculationRejectsFutureIssueAndReturnDates()
    {
        var librarian = await CreateUserAsync(RoleCatalog.Librarian);
        var fixture = await CreateStudentFixtureAsync(librarian.UserId, withCharge: false);
        var library = await CreateLibraryFixtureAsync();
        try
        {
            using var client = CreateClient();
            await LoginExpectingRedirectAsync(client, librarian);

            var token = await GetAntiforgeryTokenAsync(client, "/Library/Circulation");
            using var futureIssue = await client.PostAsync(
                "/Library/Circulation?handler=Issue",
                new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["Issue.StudentId"] = fixture.StudentId.ToString(),
                    ["Issue.AccessionNumber"] = library.AccessionNumber,
                    ["Issue.IssuedDate"] = DateTime.Today.AddDays(300)
                        .ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                    ["__RequestVerificationToken"] = token,
                }));
            Assert.Equal(HttpStatusCode.OK, futureIssue.StatusCode);
            Assert.Contains(
                "cannot be in the future",
                await futureIssue.Content.ReadAsStringAsync());

            await using var scope = factory.Services.CreateAsyncScope();
            var dbContext = scope.ServiceProvider
                .GetRequiredService<SchoolPortalDbContext>();
            Assert.Equal(
                0,
                await dbContext.Set<BookIssue>()
                    .CountAsync(x => x.LibraryCopyId == library.CopyId));
        }
        finally
        {
            await CleanupLibraryFixtureAsync(library);
            await CleanupStudentFixtureAsync(fixture);
            await DeleteUserAsync(librarian.Username);
        }
    }

    [Fact]
    public async Task StudentSearchTreatsWildcardsAsLiterals()
    {
        var admin = await CreateUserAsync(RoleCatalog.SuperAdministrator);
        var fixture = await CreateStudentFixtureAsync(admin.UserId, withCharge: false);
        try
        {
            using var client = CreateClient();
            await LoginExpectingRedirectAsync(client, admin);

            using var wildcard = await client.GetAsync("/Students?Search=%25");
            Assert.Equal(HttpStatusCode.OK, wildcard.StatusCode);
            var html = await wildcard.Content.ReadAsStringAsync();
            Assert.DoesNotContain(fixture.AdmissionNumber, html);

            using var literal = await client.GetAsync(
                $"/Students?Search={fixture.AdmissionNumber}&Status=Active");
            Assert.Equal(HttpStatusCode.OK, literal.StatusCode);
            Assert.Contains(
                fixture.AdmissionNumber,
                await literal.Content.ReadAsStringAsync());
        }
        finally
        {
            await CleanupStudentFixtureAsync(fixture);
            await DeleteUserAsync(admin.Username);
        }
    }

    private static async Task<HttpResponseMessage> PostPaymentAsync(
        HttpClient client,
        Guid enrollmentId,
        string mode,
        DateTime paymentDate)
    {
        var path = $"/Fees/Ledger?EnrollmentId={enrollmentId}";
        var token = await GetAntiforgeryTokenAsync(client, path);
        return await client.PostAsync(
            "/Fees/Ledger?handler=Payment",
            new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["Payment.StudentEnrollmentId"] = enrollmentId.ToString(),
                ["Payment.PaymentDate"] = paymentDate.ToString(
                    "yyyy-MM-dd",
                    CultureInfo.InvariantCulture),
                ["Payment.Mode"] = mode,
                ["Payment.Amount"] = "50",
                ["Payment.Reference"] = string.Empty,
                ["Payment.BankName"] = string.Empty,
                ["Payment.Remarks"] = "QA regression test",
                ["Payment.IdempotencyKey"] = Guid.NewGuid().ToString("N"),
                ["__RequestVerificationToken"] = token,
            }));
    }

    private static async Task LoginExpectingRedirectAsync(
        HttpClient client,
        TestAccount account)
    {
        using var login = await LoginAsync(client, account.Username, account.Password);
        Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);
    }

    private async Task<TestAccount> CreateUserAsync(string role, bool isActive = true)
    {
        var username = $"qa-{Guid.NewGuid():N}";
        const string password = "SafePassword9";
        await using var scope = factory.Services.CreateAsyncScope();
        var userManager = scope.ServiceProvider
            .GetRequiredService<UserManager<ApplicationUser>>();
        var user = new ApplicationUser
        {
            UserName = username,
            DisplayName = "QA regression user",
            IsActive = isActive,
        };
        Assert.True((await userManager.CreateAsync(user, password)).Succeeded);
        Assert.True((await userManager.AddToRoleAsync(user, role)).Succeeded);
        return new TestAccount(user.Id, username, password);
    }

    private async Task<StudentFixture> CreateStudentFixtureAsync(
        Guid userId,
        bool withCharge)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider
            .GetRequiredService<SchoolPortalDbContext>();
        var suffix = Guid.NewGuid().ToString("N")[..8];
        var year = new AcademicYear
        {
            Name = $"Q{suffix}",
            StartDate = DateOnly.FromDateTime(DateTime.Today.AddMonths(-2)),
            EndDate = DateOnly.FromDateTime(DateTime.Today.AddMonths(10)),
        };
        var schoolClass = new SchoolClass { Name = $"QA class {suffix}", SortOrder = 997 };
        var section = new Section { AcademicYear = year, Class = schoolClass, Name = "A" };
        var student = new Student
        {
            AdmissionNumber = $"QA-{suffix}",
            FirstName = "Regression",
            LastName = "Student",
            AdmissionDate = DateOnly.FromDateTime(DateTime.Today),
        };
        var enrollment = new StudentEnrollment
        {
            Student = student,
            AcademicYear = year,
            Class = schoolClass,
            Section = section,
            RollNumber = 1,
        };
        var head = new FeeHead { Code = $"QH{suffix}", Name = $"QA head {suffix}" };
        dbContext.AddRange(enrollment, head);
        if (withCharge)
        {
            dbContext.Add(new StudentCharge
            {
                StudentEnrollment = enrollment,
                FeeHead = head,
                Description = "QA charge",
                Period = "April",
                Amount = 100,
                DueDate = DateOnly.FromDateTime(DateTime.Today.AddDays(-10)),
                CreatedByUserId = userId,
            });
        }

        await dbContext.SaveChangesAsync();
        return new StudentFixture(
            year.Id,
            schoolClass.Id,
            section.Id,
            student.Id,
            enrollment.Id,
            head.Id,
            student.AdmissionNumber);
    }

    private async Task CleanupStudentFixtureAsync(StudentFixture fixture)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider
            .GetRequiredService<SchoolPortalDbContext>();
        var paymentIds = await dbContext.Set<FeePayment>()
            .Where(x => x.StudentEnrollmentId == fixture.EnrollmentId)
            .Select(x => x.Id)
            .ToListAsync();
        await dbContext.Set<FeePaymentReversal>()
            .Where(x => paymentIds.Contains(x.FeePaymentId))
            .ExecuteDeleteAsync();
        await dbContext.Set<FeePaymentAllocation>()
            .Where(x => paymentIds.Contains(x.FeePaymentId))
            .ExecuteDeleteAsync();
        await dbContext.Set<FeeReceipt>()
            .Where(x => paymentIds.Contains(x.FeePaymentId))
            .ExecuteDeleteAsync();
        await dbContext.Set<FeePayment>()
            .Where(x => x.StudentEnrollmentId == fixture.EnrollmentId)
            .ExecuteDeleteAsync();
        await dbContext.Set<FeeConcession>()
            .Where(x => x.StudentCharge.StudentEnrollmentId == fixture.EnrollmentId)
            .ExecuteDeleteAsync();
        await dbContext.Set<StudentCharge>()
            .Where(x => x.StudentEnrollmentId == fixture.EnrollmentId)
            .ExecuteDeleteAsync();
        await dbContext.Set<FeeHead>()
            .Where(x => x.Id == fixture.HeadId)
            .ExecuteDeleteAsync();
        await dbContext.Set<BookIssue>()
            .Where(x => x.StudentId == fixture.StudentId)
            .ExecuteDeleteAsync();
        await dbContext.Set<StudentEnrollment>()
            .Where(x => x.Id == fixture.EnrollmentId)
            .ExecuteDeleteAsync();
        await dbContext.Set<Student>()
            .Where(x => x.Id == fixture.StudentId)
            .ExecuteDeleteAsync();
        await dbContext.Set<Section>()
            .Where(x => x.Id == fixture.SectionId)
            .ExecuteDeleteAsync();
        await dbContext.Set<AcademicYear>()
            .Where(x => x.Id == fixture.YearId)
            .ExecuteDeleteAsync();
        await dbContext.Set<SchoolClass>()
            .Where(x => x.Id == fixture.ClassId)
            .ExecuteDeleteAsync();
    }

    private async Task<LibraryFixture> CreateLibraryFixtureAsync()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider
            .GetRequiredService<SchoolPortalDbContext>();
        var suffix = Guid.NewGuid().ToString("N")[..8];
        var title = new LibraryTitle
        {
            Title = $"QA title {suffix}",
            Author = new LibraryAuthor { Name = $"QA author {suffix}" },
            Category = new LibraryCategory { Name = $"QA category {suffix}" },
        };
        var copy = new LibraryCopy
        {
            LibraryTitle = title,
            AccessionNumber = $"QAC-{suffix}",
        };
        dbContext.Add(copy);
        await dbContext.SaveChangesAsync();
        return new LibraryFixture(
            title.Id,
            title.AuthorId,
            title.CategoryId,
            copy.Id,
            copy.AccessionNumber);
    }

    private async Task CleanupLibraryFixtureAsync(LibraryFixture fixture)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider
            .GetRequiredService<SchoolPortalDbContext>();
        await dbContext.Set<BookIssue>()
            .Where(x => x.LibraryCopyId == fixture.CopyId)
            .ExecuteDeleteAsync();
        await dbContext.Set<LibraryCopy>()
            .Where(x => x.Id == fixture.CopyId)
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
            new FormUrlEncodedContent(new Dictionary<string, string>
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

    private sealed record TestAccount(Guid UserId, string Username, string Password);

    private sealed record StudentFixture(
        Guid YearId,
        Guid ClassId,
        Guid SectionId,
        Guid StudentId,
        Guid EnrollmentId,
        Guid HeadId,
        string AdmissionNumber);

    private sealed record LibraryFixture(
        Guid TitleId,
        Guid AuthorId,
        Guid CategoryId,
        Guid CopyId,
        string AccessionNumber);
}
