using SchoolPortal.Domain.Academics;
using SchoolPortal.Domain.Students;

namespace SchoolPortal.Domain.Examinations;

public enum ExaminationStatus
{
    Setup = 1,
    MarksEntry = 2,
    Published = 3,
}

public sealed class Examination
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid AcademicYearId { get; set; }

    public AcademicYear AcademicYear { get; set; } = null!;

    public Guid ClassId { get; set; }

    public SchoolClass Class { get; set; } = null!;

    public string Name { get; set; } = string.Empty;

    public string Term { get; set; } = string.Empty;

    public DateOnly? StartDate { get; set; }

    public DateOnly? EndDate { get; set; }

    public decimal Weightage { get; set; } = 100;

    public ExaminationStatus Status { get; set; } = ExaminationStatus.Setup;

    public DateTimeOffset? MarksEntryOpensAtUtc { get; set; }

    public DateTimeOffset? MarksEntryClosesAtUtc { get; set; }

    public Guid? PublishedByUserId { get; set; }

    public DateTimeOffset? PublishedAtUtc { get; set; }

    public DateTimeOffset CreatedAtUtc { get; set; } = DateTimeOffset.UtcNow;

    public DateTimeOffset UpdatedAtUtc { get; set; } = DateTimeOffset.UtcNow;

    public uint Version { get; set; }

    public ICollection<ExaminationSubject> Subjects { get; set; } = [];

    public ICollection<ExaminationStatusChange> StatusChanges { get; set; } = [];
}

public sealed class ExaminationSubject
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid ExaminationId { get; set; }

    public Examination Examination { get; set; } = null!;

    public Guid SubjectId { get; set; }

    public Subject Subject { get; set; } = null!;

    public decimal MaximumMarks { get; set; } = 100;

    public decimal PassMarks { get; set; } = 33;

    public DateOnly? ExaminationDate { get; set; }

    public TimeOnly? StartsAt { get; set; }

    public TimeOnly? EndsAt { get; set; }

    public decimal Weightage { get; set; } = 100;

    public uint Version { get; set; }

    public ICollection<StudentMark> Marks { get; set; } = [];
}

public sealed class GradeRule
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid AcademicYearId { get; set; }

    public AcademicYear AcademicYear { get; set; } = null!;

    public Guid ClassId { get; set; }

    public SchoolClass Class { get; set; } = null!;

    public string Grade { get; set; } = string.Empty;

    public decimal MinimumPercent { get; set; }

    public decimal MaximumPercent { get; set; }

    public decimal? Points { get; set; }

    public string? Description { get; set; }

    public uint Version { get; set; }
}

public sealed class StudentMark
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid ExaminationSubjectId { get; set; }

    public ExaminationSubject ExaminationSubject { get; set; } = null!;

    public Guid StudentEnrollmentId { get; set; }

    public StudentEnrollment StudentEnrollment { get; set; } = null!;

    public decimal? MarksObtained { get; set; }

    public bool IsAbsent { get; set; }

    public string? Grade { get; set; }

    public string? Remarks { get; set; }

    public Guid EnteredByUserId { get; set; }

    public DateTimeOffset EnteredAtUtc { get; set; } = DateTimeOffset.UtcNow;

    public DateTimeOffset UpdatedAtUtc { get; set; } = DateTimeOffset.UtcNow;

    public uint Version { get; set; }
}

public sealed class ExaminationStatusChange
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid ExaminationId { get; set; }

    public Examination Examination { get; set; } = null!;

    public ExaminationStatus OldStatus { get; set; }

    public ExaminationStatus NewStatus { get; set; }

    public string? Reason { get; set; }

    public Guid ChangedByUserId { get; set; }

    public DateTimeOffset ChangedAtUtc { get; set; } = DateTimeOffset.UtcNow;
}
