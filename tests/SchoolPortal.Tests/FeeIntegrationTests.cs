using System.Net;
using System.Net.Mime;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Academics;
using SchoolPortal.Domain.Administration;
using SchoolPortal.Domain.Fees;
using SchoolPortal.Domain.Students;
using SchoolPortal.Infrastructure.Identity;
using SchoolPortal.Infrastructure.Persistence;

namespace SchoolPortal.Tests;

public sealed partial class FeeIntegrationTests(
    WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task PaymentRetryIsIdempotentAndReversalPreservesHistory()
    {
        var account = await CreateUserAsync(RoleCatalog.Accounts);
        var fixture = await CreateFixtureAsync(account.UserId);
        try
        {
            using var client = CreateClient();
            using var login = await LoginAsync(
                client,
                account.Username,
                account.Password);
            Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);

            var idempotencyKey = Guid.NewGuid().ToString("N");
            using var overpayment = await PostPaymentAsync(
                client,
                fixture.EnrollmentId,
                999m,
                idempotencyKey);
            Assert.Equal(HttpStatusCode.OK, overpayment.StatusCode);
            Assert.Contains(
                "exceeds the outstanding balance",
                await overpayment.Content.ReadAsStringAsync());

            idempotencyKey = Guid.NewGuid().ToString("N");
            using var posted = await PostPaymentAsync(
                client,
                fixture.EnrollmentId,
                120m,
                idempotencyKey);
            Assert.Equal(HttpStatusCode.Redirect, posted.StatusCode);
            Assert.StartsWith(
                "/Fees/Receipt",
                posted.Headers.Location?.OriginalString);

            using var replay = await PostPaymentAsync(
                client,
                fixture.EnrollmentId,
                120m,
                idempotencyKey);
            Assert.Equal(HttpStatusCode.Redirect, replay.StatusCode);

            Guid paymentId;
            string receiptNumber;
            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var dbContext = scope.ServiceProvider
                    .GetRequiredService<SchoolPortalDbContext>();
                var payment = await dbContext.Set<FeePayment>()
                    .AsNoTracking()
                    .Include(x => x.Receipt)
                    .Include(x => x.Allocations)
                    .SingleAsync(
                        x => x.IdempotencyKey == idempotencyKey);
                paymentId = payment.Id;
                receiptNumber = payment.Receipt.ReceiptNumber;
                Assert.Equal(120m, payment.Amount);
                Assert.Equal(2, payment.Allocations.Count);
                Assert.Collection(
                    payment.Allocations
                        .Select(x => x.Amount)
                        .OrderBy(x => x),
                    amount => Assert.Equal(20m, amount),
                    amount => Assert.Equal(100m, amount));
                Assert.Equal(
                    1,
                    await dbContext.Set<FeePayment>()
                        .CountAsync(x => x.IdempotencyKey == idempotencyKey));
                Assert.True(await dbContext.Set<AuditEvent>().AnyAsync(x =>
                    x.EntityId == payment.Id.ToString()
                    && x.EventType == "fee.payment.posted"));
            }

            var receiptPath = $"/Fees/Receipt?number={receiptNumber}";
            var printToken = await GetAntiforgeryTokenAsync(client, receiptPath);
            using var print = await client.PostAsync(
                "/Fees/Receipt?handler=Print",
                new FormUrlEncodedContent(
                    new Dictionary<string, string>
                    {
                        ["number"] = receiptNumber,
                        ["__RequestVerificationToken"] = printToken,
                    }));
            Assert.Equal(HttpStatusCode.Redirect, print.StatusCode);

            var ledgerPath = $"/Fees/Ledger?EnrollmentId={fixture.EnrollmentId}";
            var reversalToken = await GetAntiforgeryTokenAsync(client, ledgerPath);
            using var reversal = await client.PostAsync(
                "/Fees/Ledger?handler=Reverse",
                new FormUrlEncodedContent(
                    new Dictionary<string, string>
                    {
                        ["paymentId"] = paymentId.ToString(),
                        ["enrollmentId"] = fixture.EnrollmentId.ToString(),
                        ["ReversalReason"] = "Duplicate counter entry",
                        ["__RequestVerificationToken"] = reversalToken,
                    }));
            Assert.Equal(HttpStatusCode.Redirect, reversal.StatusCode);

            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var dbContext = scope.ServiceProvider
                    .GetRequiredService<SchoolPortalDbContext>();
                var payment = await dbContext.Set<FeePayment>()
                    .AsNoTracking()
                    .Include(x => x.Receipt)
                    .Include(x => x.Allocations)
                    .Include(x => x.Reversal)
                    .SingleAsync(x => x.Id == paymentId);
                Assert.Equal(FeePaymentStatus.Reversed, payment.Status);
                Assert.NotNull(payment.Reversal);
                Assert.Equal("Duplicate counter entry", payment.Reversal.Reason);
                Assert.Equal(2, payment.Allocations.Count);
                Assert.Equal(receiptNumber, payment.Receipt.ReceiptNumber);
                Assert.Equal(1, payment.Receipt.PrintCount);
                Assert.True(await dbContext.Set<AuditEvent>().AnyAsync(x =>
                    x.EntityId == payment.Id.ToString()
                    && x.EventType == "fee.payment.reversed"));

                var charges = await dbContext.Set<StudentCharge>()
                    .AsNoTracking()
                    .Where(x => x.StudentEnrollmentId == fixture.EnrollmentId)
                    .Include(x => x.Concessions)
                    .Include(x => x.PaymentAllocations)
                        .ThenInclude(x => x.FeePayment)
                    .ToListAsync();
                Assert.Equal(150m, charges.Sum(FeeBalance));
            }
        }
        finally
        {
            await CleanupFixtureAsync(fixture);
            await DeleteUserAsync(account.Username);
        }
    }

    [Fact]
    public async Task FeeRoutesEnforceRolePermissions()
    {
        var teacher = await CreateUserAsync(RoleCatalog.Teacher);
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
                using var response = await teacherClient.GetAsync("/Fees/Ledger");
                Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
                Assert.Equal(
                    "/Account/AccessDenied",
                    response.Headers.Location?.AbsolutePath);
            }

            using (var principalClient = CreateClient())
            {
                using var login = await LoginAsync(
                    principalClient,
                    principal.Username,
                    principal.Password);
                Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);
                using var ledger = await principalClient.GetAsync("/Fees/Ledger");
                using var reports = await principalClient.GetAsync("/Fees/Reports");
                Assert.Equal(HttpStatusCode.OK, ledger.StatusCode);
                Assert.Equal(HttpStatusCode.OK, reports.StatusCode);
            }
        }
        finally
        {
            await DeleteUserAsync(teacher.Username);
            await DeleteUserAsync(principal.Username);
        }
    }

    private static async Task<HttpResponseMessage> PostPaymentAsync(
        HttpClient client,
        Guid enrollmentId,
        decimal amount,
        string idempotencyKey)
    {
        var path = $"/Fees/Ledger?EnrollmentId={enrollmentId}";
        var token = await GetAntiforgeryTokenAsync(client, path);
        return await client.PostAsync(
            "/Fees/Ledger?handler=Payment",
            new FormUrlEncodedContent(
                new Dictionary<string, string>
                {
                    ["Payment.StudentEnrollmentId"] = enrollmentId.ToString(),
                    ["Payment.PaymentDate"] = DateTime.Today.ToString(
                        "yyyy-MM-dd",
                        System.Globalization.CultureInfo.InvariantCulture),
                    ["Payment.Mode"] = FeePaymentMode.Cash.ToString(),
                    ["Payment.Amount"] = amount.ToString(
                        System.Globalization.CultureInfo.InvariantCulture),
                    ["Payment.Reference"] = string.Empty,
                    ["Payment.BankName"] = string.Empty,
                    ["Payment.Remarks"] = "Integration test",
                    ["Payment.IdempotencyKey"] = idempotencyKey,
                    ["__RequestVerificationToken"] = token,
                }));
    }

    private async Task<TestAccount> CreateUserAsync(string role)
    {
        var username = $"fees-{Guid.NewGuid():N}";
        const string password = "SafePassword9";
        await using var scope = factory.Services.CreateAsyncScope();
        var userManager = scope.ServiceProvider
            .GetRequiredService<UserManager<ApplicationUser>>();
        var user = new ApplicationUser
        {
            UserName = username,
            DisplayName = "Fee integration user",
            IsActive = true,
        };
        Assert.True((await userManager.CreateAsync(user, password)).Succeeded);
        Assert.True((await userManager.AddToRoleAsync(user, role)).Succeeded);
        return new TestAccount(user.Id, username, password);
    }

    private async Task<FeeFixture> CreateFixtureAsync(Guid userId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<SchoolPortalDbContext>();
        var suffix = Guid.NewGuid().ToString("N")[..8];
        var year = new AcademicYear
        {
            Name = $"F{suffix}",
            StartDate = DateOnly.FromDateTime(DateTime.Today.AddMonths(-2)),
            EndDate = DateOnly.FromDateTime(DateTime.Today.AddMonths(10)),
        };
        var schoolClass = new SchoolClass
        {
            Name = $"Fee class {suffix}",
            SortOrder = 998,
        };
        var section = new Section
        {
            AcademicYear = year,
            Class = schoolClass,
            Name = "A",
        };
        var student = new Student
        {
            AdmissionNumber = $"FE-{suffix}",
            FirstName = "Finance",
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
        var head = new FeeHead
        {
            Code = $"FH{suffix}",
            Name = $"Tuition {suffix}",
        };
        var firstCharge = new StudentCharge
        {
            StudentEnrollment = enrollment,
            FeeHead = head,
            Description = "First installment",
            Period = "April",
            Amount = 100,
            DueDate = DateOnly.FromDateTime(DateTime.Today.AddDays(-60)),
            CreatedByUserId = userId,
        };
        var secondCharge = new StudentCharge
        {
            StudentEnrollment = enrollment,
            FeeHead = head,
            Description = "Second installment",
            Period = "May",
            Amount = 50,
            DueDate = DateOnly.FromDateTime(DateTime.Today.AddDays(-30)),
            CreatedByUserId = userId,
        };
        dbContext.AddRange(firstCharge, secondCharge);
        await dbContext.SaveChangesAsync();
        return new FeeFixture(
            year.Id,
            schoolClass.Id,
            section.Id,
            student.Id,
            enrollment.Id,
            head.Id);
    }

    private async Task CleanupFixtureAsync(FeeFixture fixture)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<SchoolPortalDbContext>();
        var paymentIds = await dbContext.Set<FeePayment>()
            .Where(x => x.StudentEnrollmentId == fixture.EnrollmentId)
            .Select(x => x.Id)
            .ToListAsync();
        var receiptIds = await dbContext.Set<FeeReceipt>()
            .Where(x => paymentIds.Contains(x.FeePaymentId))
            .Select(x => x.Id)
            .ToListAsync();
        await dbContext.Set<AuditEvent>()
            .Where(x =>
                paymentIds.Select(id => id.ToString()).Contains(x.EntityId)
                || receiptIds.Select(id => id.ToString()).Contains(x.EntityId))
            .ExecuteDeleteAsync();
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

    private static decimal FeeBalance(StudentCharge charge) =>
        Math.Max(
            0,
            charge.Amount
                - charge.Concessions.Sum(x => x.Amount)
                - charge.PaymentAllocations
                    .Where(x => x.FeePayment.Status == FeePaymentStatus.Posted)
                    .Sum(x => x.Amount));

    [GeneratedRegex(
        "name=\"__RequestVerificationToken\"[^>]*value=\"([^\"]+)\"",
        RegexOptions.CultureInvariant)]
    private static partial Regex AntiforgeryTokenPattern();

    private sealed record TestAccount(
        Guid UserId,
        string Username,
        string Password);

    private sealed record FeeFixture(
        Guid YearId,
        Guid ClassId,
        Guid SectionId,
        Guid StudentId,
        Guid EnrollmentId,
        Guid HeadId);
}
