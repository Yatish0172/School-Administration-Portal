namespace SchoolPortal.Domain.Academics;

public enum AcademicBreakScope
{
    AllClasses = 1,
    ClassRange = 2,
}

public sealed class AcademicBreakPeriod
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public string Name { get; set; } = string.Empty;

    public AcademicBreakScope Scope { get; set; } =
        AcademicBreakScope.AllClasses;

    public Guid? FromClassId { get; set; }

    public SchoolClass? FromClass { get; set; }

    public Guid? ToClassId { get; set; }

    public SchoolClass? ToClass { get; set; }

    public TimeOnly StartsAt { get; set; }

    public TimeOnly EndsAt { get; set; }

    public bool IsActive { get; set; } = true;

    public uint Version { get; set; }
}
