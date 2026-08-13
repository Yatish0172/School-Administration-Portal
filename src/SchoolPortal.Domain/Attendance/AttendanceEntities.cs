using SchoolPortal.Domain.Academics;
using SchoolPortal.Domain.Students;

namespace SchoolPortal.Domain.Attendance;

public enum AttendanceStatus
{
    Present = 1,
    Absent = 2,
    Late = 3,
    HalfDay = 4,
    Leave = 5,
}

public sealed class AttendanceSession
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid AcademicYearId { get; set; }

    public AcademicYear AcademicYear { get; set; } = null!;

    public Guid SectionId { get; set; }

    public Section Section { get; set; } = null!;

    public DateOnly Date { get; set; }

    public int PeriodNumber { get; set; }

    public Guid MarkedByUserId { get; set; }

    public DateTimeOffset MarkedAtUtc { get; set; } = DateTimeOffset.UtcNow;

    public DateTimeOffset UpdatedAtUtc { get; set; } = DateTimeOffset.UtcNow;

    public uint Version { get; set; }

    public ICollection<AttendanceEntry> Entries { get; set; } = [];
}

public sealed class AttendanceEntry
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid AttendanceSessionId { get; set; }

    public AttendanceSession Session { get; set; } = null!;

    public Guid StudentEnrollmentId { get; set; }

    public StudentEnrollment StudentEnrollment { get; set; } = null!;

    public AttendanceStatus Status { get; set; } = AttendanceStatus.Present;

    public string? Reason { get; set; }

    public Guid MarkedByUserId { get; set; }

    public DateTimeOffset MarkedAtUtc { get; set; } = DateTimeOffset.UtcNow;

    public uint Version { get; set; }

    public ICollection<AttendanceCorrection> Corrections { get; set; } = [];
}

public sealed class AttendanceCorrection
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid AttendanceEntryId { get; set; }

    public AttendanceEntry AttendanceEntry { get; set; } = null!;

    public AttendanceStatus OldStatus { get; set; }

    public AttendanceStatus NewStatus { get; set; }

    public string Reason { get; set; } = string.Empty;

    public Guid CorrectedByUserId { get; set; }

    public DateTimeOffset CorrectedAtUtc { get; set; } = DateTimeOffset.UtcNow;
}
