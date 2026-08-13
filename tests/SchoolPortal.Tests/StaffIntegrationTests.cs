using System.Net;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Academics;
using SchoolPortal.Domain.Staff;
using SchoolPortal.Infrastructure.Identity;
using SchoolPortal.Infrastructure.Persistence;

namespace SchoolPortal.Tests;

public sealed partial class StaffIntegrationTests(
    WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task AdministratorCanSaveReusableStaffDetails()
    {
        var username = $"staff-admin-{Guid.NewGuid():N}";
        const string password = "SafePassword9";
        Guid userId;
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var userManager = scope.ServiceProvider
                .GetRequiredService<UserManager<ApplicationUser>>();
            var user = new ApplicationUser
            {
                UserName = username,
                DisplayName = "Staff directory administrator",
                IsActive = true,
            };
            Assert.True((await userManager.CreateAsync(user, password)).Succeeded);
            Assert.True((await userManager.AddToRoleAsync(
                user,
                RoleCatalog.SuperAdministrator)).Succeeded);
            Assert.True((await userManager.AddToRoleAsync(
                user,
                RoleCatalog.Teacher)).Succeeded);
            userId = user.Id;
        }

        var staffNumber = $"STF-{Guid.NewGuid():N}"[..16].ToUpperInvariant();
        var standaloneTeacherNumber = $"TCH-{Guid.NewGuid():N}"[..16].ToUpperInvariant();
        Guid staffId = default;
        Guid standaloneTeacherId = default;
        Guid classId = default;
        Guid sectionId = default;
        Guid subjectId = default;
        Guid assignmentId = default;
        Guid createdYearId = default;
        try
        {
            using var client = factory.CreateClient(new WebApplicationFactoryClientOptions
            {
                AllowAutoRedirect = false,
            });
            using var login = await LoginAsync(client, username, password);
            Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);

            using (var page = await client.GetAsync("/Staff"))
            {
                Assert.Equal(HttpStatusCode.OK, page.StatusCode);
                var html = await page.Content.ReadAsStringAsync();
                Assert.Contains("Staff Details", html);
                Assert.Contains("Designation", html);
                Assert.Contains("Emergency contact", html);
                Assert.DoesNotContain(">Portal account<", html);
            }

            using (var response = await PostAsync(
                client,
                new Dictionary<string, string>
                {
                    ["NewStaff.StaffNumber"] = staffNumber,
                    ["NewStaff.FirstName"] = "Asha",
                    ["NewStaff.LastName"] = "Sharma",
                    ["NewStaff.Designation"] = "Class Teacher",
                    ["NewStaff.Department"] = "Primary",
                    ["NewStaff.EmploymentType"] = "Permanent",
                    ["NewStaff.Phone"] = "9876543210",
                    ["NewStaff.Email"] = "asha@example.test",
                    ["NewStaff.Address"] = "10 School Road",
                    ["NewStaff.City"] = "Delhi",
                    ["NewStaff.State"] = "Delhi",
                    ["NewStaff.PostalCode"] = "110001",
                    ["NewStaff.EmergencyContactName"] = "Ravi Sharma",
                    ["NewStaff.EmergencyContactPhone"] = "9876500000",
                    ["NewStaff.PortalUserId"] = userId.ToString(),
                }))
            {
                Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
            }

            using (var response = await PostAsync(
                client,
                new Dictionary<string, string>
                {
                    ["NewStaff.StaffNumber"] = standaloneTeacherNumber,
                    ["NewStaff.FirstName"] = "Meera",
                    ["NewStaff.LastName"] = "Nair",
                    ["NewStaff.Designation"] = "Subject Teacher",
                    ["NewStaff.Phone"] = "9876543211",
                    ["NewStaff.Address"] = "11 School Road",
                    ["NewStaff.City"] = "Delhi",
                    ["NewStaff.State"] = "Delhi",
                    ["NewStaff.PostalCode"] = "110001",
                }))
            {
                Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
            }

            await using var scope = factory.Services.CreateAsyncScope();
            var dbContext = scope.ServiceProvider
                .GetRequiredService<SchoolPortalDbContext>();
            var staff = await dbContext.Set<StaffMember>()
                .AsNoTracking()
                .SingleAsync(x => x.StaffNumber == staffNumber);
            staffId = staff.Id;
            Assert.Equal("Asha Sharma", staff.FullName);
            Assert.Equal("Class Teacher", staff.Designation);
            Assert.Equal(userId, staff.PortalUserId);
            var standaloneTeacher = await dbContext.Set<StaffMember>()
                .AsNoTracking()
                .SingleAsync(x => x.StaffNumber == standaloneTeacherNumber);
            standaloneTeacherId = standaloneTeacher.Id;
            Assert.Null(standaloneTeacher.PortalUserId);

            var today = DateOnly.FromDateTime(DateTime.Today);
            var year = await dbContext.Set<AcademicYear>()
                .Where(x => x.Status == AcademicYearStatus.Open && x.EndDate >= today)
                .OrderByDescending(x => x.IsCurrent)
                .ThenByDescending(x => x.StartDate)
                .FirstOrDefaultAsync();
            if (year is null)
            {
                year = new AcademicYear
                {
                    Name = $"staff-{Guid.NewGuid():N}"[..20],
                    StartDate = today,
                    EndDate = today.AddYears(1),
                    IsCurrent = true,
                };
                dbContext.Add(year);
                createdYearId = year.Id;
            }

            var schoolClass = new SchoolClass
            {
                Name = $"Teacher class {Guid.NewGuid():N}"[..30],
                SortOrder = 950,
            };
            var section = new Section
            {
                AcademicYearId = year.Id,
                ClassId = schoolClass.Id,
                Name = "A",
                ClassTeacherUserId = userId,
            };
            var subject = new Subject
            {
                ClassId = schoolClass.Id,
                Name = "Mathematics",
                Code = $"MATH-{Guid.NewGuid():N}"[..20].ToUpperInvariant(),
            };
            var assignment = new TeacherAssignment
            {
                AcademicYearId = year.Id,
                ClassId = schoolClass.Id,
                SectionId = section.Id,
                SubjectId = subject.Id,
                TeacherUserId = userId,
            };
            dbContext.AddRange(schoolClass, section, subject, assignment);
            await dbContext.SaveChangesAsync();
            classId = schoolClass.Id;
            sectionId = section.Id;
            subjectId = subject.Id;
            assignmentId = assignment.Id;

            using var teacherPage = await client.GetAsync("/Staff");
            var teacherHtml = await teacherPage.Content.ReadAsStringAsync();
            Assert.Contains("<h2>Teachers</h2>", teacherHtml);
            Assert.Contains("teacherDetailsModal", teacherHtml);
            Assert.Contains("teacher-details-button", teacherHtml);
            Assert.Contains("add-teacher-button", teacherHtml);
            Assert.Contains("teacher-edit-button", teacherHtml);
            Assert.Contains("Add Teacher", teacherHtml);
            Assert.DoesNotContain("<th>Class Teacher Of</th>", teacherHtml);
            Assert.Contains("Class Teacher Of", teacherHtml);
            Assert.Contains("title=\"Class Teacher\">CT</span>", teacherHtml);
            Assert.Contains("Mathematics", teacherHtml);
            Assert.Contains(schoolClass.Name, teacherHtml);
            Assert.Contains("Meera Nair", teacherHtml);
        }
        finally
        {
            await using var scope = factory.Services.CreateAsyncScope();
            var dbContext = scope.ServiceProvider
                .GetRequiredService<SchoolPortalDbContext>(); if (assignmentId != Guid.Empty)
            {
                await dbContext.Set<TeacherAssignment>()
                    .Where(x => x.Id == assignmentId)
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
            if (classId != Guid.Empty)
            {
                await dbContext.Set<SchoolClass>()
                    .Where(x => x.Id == classId)
                    .ExecuteDeleteAsync();
            }
            if (createdYearId != Guid.Empty)
            {
                await dbContext.Set<AcademicYear>()
                    .Where(x => x.Id == createdYearId)
                    .ExecuteDeleteAsync();
            }
            if (standaloneTeacherId != Guid.Empty)
            {
                await dbContext.Set<StaffMember>()
                    .Where(x => x.Id == standaloneTeacherId)
                    .ExecuteDeleteAsync();
            }
            if (staffId != Guid.Empty)
            {
                await dbContext.Set<StaffMember>()
                    .Where(x => x.Id == staffId)
                    .ExecuteDeleteAsync();
            }

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
        Dictionary<string, string> values)
    {
        values["__RequestVerificationToken"] =
            await GetTokenAsync(client, "/Staff");
        return await client.PostAsync(
            "/Staff?handler=Create",
            new FormUrlEncodedContent(values));
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
