using System.ComponentModel.DataAnnotations;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;
using Microsoft.EntityFrameworkCore;
using SchoolPortal.Application.Authorization;
using SchoolPortal.Domain.Academics;
using SchoolPortal.Domain.Fees;
using SchoolPortal.Domain.Students;
using SchoolPortal.Infrastructure.Persistence;
using SchoolPortal.Web.Administration;

namespace SchoolPortal.Web.Pages.Fees;

[Authorize(Policy = PermissionCatalog.PolicyPrefix + PermissionCatalog.Fees.View)]
public sealed class IndexModel(
    SchoolPortalDbContext dbContext,
    AuditWriter auditWriter) : PageModel
{
    [BindProperty(SupportsGet = true)]
    public Guid? SelectedPlanId { get; set; }

    [BindProperty]
    public FeeHeadInput NewHead { get; set; } = new();

    [BindProperty]
    public FeePlanInput NewPlan { get; set; } = new();

    [BindProperty]
    public FeePlanItemInput NewItem { get; set; } = new();

    [TempData]
    public string? StatusMessage { get; set; }

    public IReadOnlyList<FeeHead> Heads { get; private set; } = [];

    public IReadOnlyList<FeePlan> Plans { get; private set; } = [];

    public IReadOnlyList<AcademicYear> AcademicYears { get; private set; } = [];

    public IReadOnlyList<SchoolClass> Classes { get; private set; } = [];

    public IReadOnlyList<Section> Sections { get; private set; } = [];

    public FeePlan? SelectedPlan { get; private set; }

    public bool CanConfigure => User.HasClaim(
        PermissionCatalog.ClaimType,
        PermissionCatalog.Fees.Configure);

    public async Task OnGetAsync(CancellationToken cancellationToken) =>
        await LoadAsync(cancellationToken);

    public async Task<IActionResult> OnPostCreateHeadAsync(
        CancellationToken cancellationToken)
    {
        if (!CanConfigure)
        {
            return Forbid();
        }

        ModelState.Clear();
        if (!TryValidateModel(NewHead, nameof(NewHead)))
        {
            await LoadAsync(cancellationToken);
            return Page();
        }

        var head = new FeeHead
        {
            Code = NewHead.Code.Trim().ToUpperInvariant(),
            Name = NewHead.Name.Trim(),
            Description = Clean(NewHead.Description),
            IsRefundable = NewHead.IsRefundable,
            SortOrder = NewHead.SortOrder,
        };
        dbContext.Add(head);
        auditWriter.Add(
            "fee.head.created",
            nameof(FeeHead),
            head.Id,
            null,
            new
            {
                head.Code,
                head.Name,
                head.IsRefundable,
            });
        return await SaveAsync(
            "Fee head created.",
            SelectedPlanId,
            cancellationToken);
    }

    public async Task<IActionResult> OnPostCreatePlanAsync(
        CancellationToken cancellationToken)
    {
        if (!CanConfigure)
        {
            return Forbid();
        }

        ModelState.Clear();
        if (!TryValidateModel(NewPlan, nameof(NewPlan)))
        {
            await LoadAsync(cancellationToken);
            return Page();
        }

        var year = await dbContext.Set<AcademicYear>()
            .SingleOrDefaultAsync(
                x => x.Id == NewPlan.AcademicYearId,
                cancellationToken);
        var schoolClass = await dbContext.Set<SchoolClass>()
            .SingleOrDefaultAsync(
                x => x.Id == NewPlan.ClassId && x.IsActive,
                cancellationToken);
        if (year is null || schoolClass is null)
        {
            ModelState.AddModelError(
                string.Empty,
                "Choose a valid academic year and class.");
        }
        else if (year.Status == AcademicYearStatus.Closed)
        {
            ModelState.AddModelError(
                string.Empty,
                "Fee plans cannot be added to a closed year.");
        }

        if (!ModelState.IsValid)
        {
            await LoadAsync(cancellationToken);
            return Page();
        }

        var plan = new FeePlan
        {
            AcademicYearId = NewPlan.AcademicYearId,
            ClassId = NewPlan.ClassId,
            Name = NewPlan.Name.Trim(),
        };
        dbContext.Add(plan);
        auditWriter.Add(
            "fee.plan.created",
            nameof(FeePlan),
            plan.Id,
            null,
            new
            {
                plan.AcademicYearId,
                plan.ClassId,
                plan.Name,
            });
        return await SaveAsync(
            "Fee plan created. Add its scheduled charges next.",
            plan.Id,
            cancellationToken);
    }

    public async Task<IActionResult> OnPostAddItemAsync(
        CancellationToken cancellationToken)
    {
        if (!CanConfigure)
        {
            return Forbid();
        }

        ModelState.Clear();
        if (!TryValidateModel(NewItem, nameof(NewItem)))
        {
            SelectedPlanId = NewItem.FeePlanId;
            await LoadAsync(cancellationToken);
            return Page();
        }

        var plan = await dbContext.Set<FeePlan>()
            .Include(x => x.AcademicYear)
            .SingleOrDefaultAsync(
                x => x.Id == NewItem.FeePlanId,
                cancellationToken);
        var headExists = await dbContext.Set<FeeHead>()
            .AnyAsync(
                x => x.Id == NewItem.FeeHeadId && x.IsActive,
                cancellationToken);
        if (plan is null || !headExists)
        {
            return NotFound();
        }

        if (plan.AcademicYear.Status == AcademicYearStatus.Closed)
        {
            ModelState.AddModelError(
                string.Empty,
                "A closed academic year's fee plan cannot change.");
        }
        else if (NewItem.DueDate < plan.AcademicYear.StartDate
            || NewItem.DueDate > plan.AcademicYear.EndDate)
        {
            ModelState.AddModelError(
                string.Empty,
                "The due date must fall inside the academic year.");
        }

        if (!ModelState.IsValid)
        {
            SelectedPlanId = plan.Id;
            await LoadAsync(cancellationToken);
            return Page();
        }

        var item = new FeePlanItem
        {
            FeePlanId = plan.Id,
            FeeHeadId = NewItem.FeeHeadId,
            Period = NewItem.Period.Trim(),
            Amount = NewItem.Amount,
            DueDate = NewItem.DueDate,
        };
        dbContext.Add(item);
        auditWriter.Add(
            "fee.plan-item.created",
            nameof(FeePlanItem),
            item.Id,
            null,
            new
            {
                item.FeePlanId,
                item.FeeHeadId,
                item.Period,
                item.Amount,
                item.DueDate,
            });
        return await SaveAsync(
            "Scheduled charge added.",
            plan.Id,
            cancellationToken);
    }

    public async Task<IActionResult> OnPostAssignAsync(
        Guid planId,
        Guid sectionId,
        CancellationToken cancellationToken)
    {
        if (!CanConfigure)
        {
            return Forbid();
        }

        var plan = await dbContext.Set<FeePlan>()
            .Include(x => x.Items)
                .ThenInclude(x => x.FeeHead)
            .Include(x => x.AcademicYear)
            .SingleOrDefaultAsync(x => x.Id == planId, cancellationToken);
        var section = await dbContext.Set<Section>()
            .SingleOrDefaultAsync(x => x.Id == sectionId, cancellationToken);
        if (plan is null
            || section is null
            || section.AcademicYearId != plan.AcademicYearId
            || section.ClassId != plan.ClassId)
        {
            return NotFound();
        }

        if (plan.AcademicYear.Status == AcademicYearStatus.Closed)
        {
            StatusMessage = "Charges cannot be assigned for a closed academic year.";
            return RedirectToPage(new { SelectedPlanId = plan.Id });
        }

        if (plan.Items.Count == 0)
        {
            StatusMessage = "Add scheduled charges before assigning this plan.";
            return RedirectToPage(new { SelectedPlanId = plan.Id });
        }

        var enrollments = await dbContext.Set<StudentEnrollment>()
            .Where(x =>
                x.SectionId == section.Id
                && x.Status == EnrollmentStatus.Active)
            .ToListAsync(cancellationToken);
        var enrollmentIds = enrollments.Select(x => x.Id).ToArray();
        var itemIds = plan.Items.Select(x => x.Id).ToArray();
        var existing = await dbContext.Set<StudentCharge>()
            .Where(x =>
                enrollmentIds.Contains(x.StudentEnrollmentId)
                && x.FeePlanItemId.HasValue
                && itemIds.Contains(x.FeePlanItemId.Value))
            .Select(x => new
            {
                x.StudentEnrollmentId,
                x.FeePlanItemId,
            })
            .ToListAsync(cancellationToken);
        var existingKeys = existing
            .Select(x => (x.StudentEnrollmentId, x.FeePlanItemId!.Value))
            .ToHashSet();
        var userId = CurrentUserId();
        var charges = (
            from enrollment in enrollments
            from item in plan.Items
            where !existingKeys.Contains((enrollment.Id, item.Id))
            select new StudentCharge
            {
                StudentEnrollmentId = enrollment.Id,
                FeeHeadId = item.FeeHeadId,
                FeePlanItemId = item.Id,
                Description = $"{item.FeeHead.Name} - {item.Period}",
                Period = item.Period,
                Amount = item.Amount,
                DueDate = item.DueDate,
                CreatedByUserId = userId,
            }).ToList();
        dbContext.AddRange(charges);
        auditWriter.Add(
            "fee.plan.assigned",
            nameof(FeePlan),
            plan.Id,
            null,
            new
            {
                SectionId = section.Id,
                ChargeCount = charges.Count,
                EnrollmentCount = enrollments.Count,
            });
        try
        {
            await dbContext.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException)
        {
            StatusMessage =
                "Some charges were already assigned by another user. Review the section's charges.";
            return RedirectToPage(new { SelectedPlanId = plan.Id });
        }

        StatusMessage = charges.Count == 0
            ? "This plan was already assigned to every active student in the section."
            : $"{charges.Count} student charges created.";
        return RedirectToPage(new { SelectedPlanId = plan.Id });
    }

    private async Task LoadAsync(CancellationToken cancellationToken)
    {
        Heads = await dbContext.Set<FeeHead>()
            .AsNoTracking()
            .OrderBy(x => x.SortOrder)
            .ThenBy(x => x.Name)
            .ToListAsync(cancellationToken);
        Plans = await dbContext.Set<FeePlan>()
            .AsNoTracking()
            .Include(x => x.AcademicYear)
            .Include(x => x.Class)
            .Include(x => x.Items)
                .ThenInclude(x => x.FeeHead)
            .OrderByDescending(x => x.AcademicYear.StartDate)
            .ThenBy(x => x.Class.SortOrder)
            .ThenBy(x => x.Name)
            .ToListAsync(cancellationToken);
        AcademicYears = await dbContext.Set<AcademicYear>()
            .AsNoTracking()
            .OrderByDescending(x => x.StartDate)
            .ToListAsync(cancellationToken);
        Classes = await dbContext.Set<SchoolClass>()
            .AsNoTracking()
            .Where(x => x.IsActive)
            .OrderBy(x => x.SortOrder)
            .ThenBy(x => x.Name)
            .ToListAsync(cancellationToken);
        SelectedPlan = Plans.FirstOrDefault(x => x.Id == SelectedPlanId)
            ?? (Plans.Count > 0 ? Plans[0] : null);
        SelectedPlanId = SelectedPlan?.Id;
        Sections = SelectedPlan is null
            ? []
            : await dbContext.Set<Section>()
                .AsNoTracking()
                .Where(x =>
                    x.AcademicYearId == SelectedPlan.AcademicYearId
                    && x.ClassId == SelectedPlan.ClassId
                    && x.IsActive)
                .OrderBy(x => x.Name)
                .ToListAsync(cancellationToken);
    }

    private async Task<IActionResult> SaveAsync(
        string message,
        Guid? planId,
        CancellationToken cancellationToken)
    {
        try
        {
            await dbContext.SaveChangesAsync(cancellationToken);
            StatusMessage = message;
            return RedirectToPage(new { SelectedPlanId = planId });
        }
        catch (DbUpdateException)
        {
            ModelState.AddModelError(
                string.Empty,
                "That fee setup entry already exists.");
            SelectedPlanId = planId;
            await LoadAsync(cancellationToken);
            return Page();
        }
    }

    private Guid CurrentUserId()
    {
        var value = User.FindFirstValue(ClaimTypes.NameIdentifier);
        return Guid.TryParse(value, out var userId)
            ? userId
            : throw new InvalidOperationException("A signed-in user is required.");
    }

    private static string? Clean(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    public sealed class FeeHeadInput
    {
        [Required, StringLength(30)]
        public string Code { get; set; } = string.Empty;

        [Required, StringLength(150)]
        public string Name { get; set; } = string.Empty;

        [StringLength(500)]
        public string? Description { get; set; }

        public bool IsRefundable { get; set; }

        [Range(0, 9999)]
        public int SortOrder { get; set; }
    }

    public sealed class FeePlanInput
    {
        [Required]
        public Guid AcademicYearId { get; set; }

        [Required]
        public Guid ClassId { get; set; }

        [Required, StringLength(150)]
        public string Name { get; set; } = string.Empty;
    }

    public sealed class FeePlanItemInput
    {
        [Required]
        public Guid FeePlanId { get; set; }

        [Required]
        public Guid FeeHeadId { get; set; }

        [Required, StringLength(100)]
        public string Period { get; set; } = string.Empty;

        [Range(typeof(decimal), "0.01", "9999999999")]
        public decimal Amount { get; set; }

        [Required]
        public DateOnly DueDate { get; set; }
    }
}
