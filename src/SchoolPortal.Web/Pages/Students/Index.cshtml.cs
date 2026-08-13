using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Academics;
using SchoolPortal.Domain.Students;
using SchoolPortal.Infrastructure.Persistence;

namespace SchoolPortal.Web.Pages.Students;

[Authorize(
    Policy = PermissionCatalog.PolicyPrefix + PermissionCatalog.Students.View)]
public sealed class IndexModel(
    SchoolPortalDbContext dbContext) : PageModel
{
    private const int PageSize = 25;

    [BindProperty(SupportsGet = true)]
    public string? Search { get; set; }

    [BindProperty(SupportsGet = true)]
    public StudentStatus? Status { get; set; } = StudentStatus.Active;

    [BindProperty(SupportsGet = true)]
    public Guid? ClassId { get; set; }

    [BindProperty(SupportsGet = true)]
    public Guid? SectionId { get; set; }

    [BindProperty(SupportsGet = true)]
    public int PageNumber { get; set; } = 1;

    public int Total { get; private set; }

    public int TotalPages { get; private set; }

    public IReadOnlyList<StudentRow> Rows { get; private set; } = [];

    public IReadOnlyList<SchoolClass> Classes { get; private set; } = [];

    public IReadOnlyList<Section> Sections { get; private set; } = [];

    public bool CanCreate => User.HasClaim(
        PermissionCatalog.ClaimType,
        PermissionCatalog.Students.Create);

    public async Task OnGetAsync()
    {
        PageNumber = Math.Max(1, PageNumber);
        var students = dbContext.Set<Student>()
            .AsNoTracking()
            .AsSplitQuery()
            .Include(x => x.Guardians)
            .Include(x => x.Enrollments)
                .ThenInclude(x => x.AcademicYear)
            .Include(x => x.Enrollments)
                .ThenInclude(x => x.Class)
            .Include(x => x.Enrollments)
                .ThenInclude(x => x.Section)
            .AsQueryable();

        if (Status.HasValue)
        {
            students = students.Where(x => x.Status == Status.Value);
        }

        if (ClassId.HasValue)
        {
            students = students.Where(x =>
                x.Enrollments.Any(enrollment =>
                    enrollment.ClassId == ClassId
                    && enrollment.Status == EnrollmentStatus.Active));
        }

        if (SectionId.HasValue)
        {
            students = students.Where(x =>
                x.Enrollments.Any(enrollment =>
                    enrollment.SectionId == SectionId
                    && enrollment.Status == EnrollmentStatus.Active));
        }

        if (!string.IsNullOrWhiteSpace(Search))
        {
            var term = Search.Trim();
            students = students.Where(x =>
                EF.Functions.ILike(x.AdmissionNumber, $"%{term}%")
                || EF.Functions.ILike(x.FirstName, $"%{term}%")
                || EF.Functions.ILike(x.LastName, $"%{term}%")
                || (x.MiddleName != null
                    && EF.Functions.ILike(x.MiddleName, $"%{term}%"))
                || x.Guardians.Any(guardian =>
                    EF.Functions.ILike(guardian.Name, $"%{term}%")
                    || EF.Functions.ILike(guardian.Phone, $"%{term}%")));
        }

        Total = await students.CountAsync();
        TotalPages = Math.Max(1, (int)Math.Ceiling(Total / (double)PageSize));
        PageNumber = Math.Min(PageNumber, TotalPages);

        var pageRows = await students
            .OrderBy(x => x.LastName)
            .ThenBy(x => x.FirstName)
            .Skip((PageNumber - 1) * PageSize)
            .Take(PageSize)
            .ToListAsync();

        Rows = pageRows.Select(student =>
        {
            var enrollment = student.Enrollments
                .OrderByDescending(x => x.AcademicYear.StartDate)
                .FirstOrDefault(x => x.Status == EnrollmentStatus.Active);
            var primaryGuardian = student.Guardians.FirstOrDefault(x => x.IsPrimary)
                ?? student.Guardians.FirstOrDefault();
            return new StudentRow(
                student.Id,
                student.AdmissionNumber,
                student.FullName,
                student.Status,
                enrollment?.Class.Name,
                enrollment?.Section.Name,
                enrollment?.RollNumber,
                primaryGuardian?.Name,
                primaryGuardian?.Phone);
        }).ToList();

        Classes = await dbContext.Set<SchoolClass>()
            .AsNoTracking()
            .Where(x => x.IsActive)
            .OrderBy(x => x.SortOrder)
            .ThenBy(x => x.Name)
            .ToListAsync();
        Sections = await dbContext.Set<Section>()
            .AsNoTracking()
            .Where(x => x.IsActive)
            .OrderBy(x => x.Name)
            .ToListAsync();
    }

    public sealed record StudentRow(
        Guid Id,
        string AdmissionNumber,
        string FullName,
        StudentStatus Status,
        string? ClassName,
        string? SectionName,
        int? RollNumber,
        string? GuardianName,
        string? GuardianPhone);
}
