namespace SchoolPortal.Domain.Academics;

public enum AcademicYearStatus
{
    Open = 1,
    Closed = 2,
}

public enum SubjectKind
{
    Core = 1,
    Elective = 2,
}

public enum SubjectComponent
{
    Theory = 1,
    Practical = 2,
}

public sealed class AcademicYear
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public string Name { get; set; } = string.Empty;

    public DateOnly StartDate { get; set; }

    public DateOnly EndDate { get; set; }

    public bool IsCurrent { get; set; }

    public AcademicYearStatus Status { get; set; } = AcademicYearStatus.Open;

    public uint Version { get; set; }
}

public sealed class SchoolClass
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public string Name { get; set; } = string.Empty;

    public int? Level { get; set; }

    public string? Stream { get; set; }

    public int SortOrder { get; set; }

    public bool IsActive { get; set; } = true;

    public uint Version { get; set; }
}

public sealed class Section
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid AcademicYearId { get; set; }

    public AcademicYear AcademicYear { get; set; } = null!;

    public Guid ClassId { get; set; }

    public SchoolClass Class { get; set; } = null!;

    public string Name { get; set; } = string.Empty;

    public int Capacity { get; set; } = 40;

    public Guid? ClassTeacherUserId { get; set; }

    public bool IsActive { get; set; } = true;

    public uint Version { get; set; }
}

public sealed class Subject
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid ClassId { get; set; }

    public SchoolClass Class { get; set; } = null!;

    public string Name { get; set; } = string.Empty;

    public string Code { get; set; } = string.Empty;

    public SubjectKind Kind { get; set; } = SubjectKind.Core;

    public SubjectComponent Component { get; set; } = SubjectComponent.Theory;

    public decimal MaximumMarks { get; set; } = 100;

    public bool IsActive { get; set; } = true;

    public uint Version { get; set; }
}

public sealed class TeacherAssignment
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid AcademicYearId { get; set; }

    public AcademicYear AcademicYear { get; set; } = null!;

    public Guid ClassId { get; set; }

    public SchoolClass Class { get; set; } = null!;

    public Guid SectionId { get; set; }

    public Section Section { get; set; } = null!;

    public Guid SubjectId { get; set; }

    public Subject Subject { get; set; } = null!;

    public Guid TeacherUserId { get; set; }

    public uint Version { get; set; }
}
