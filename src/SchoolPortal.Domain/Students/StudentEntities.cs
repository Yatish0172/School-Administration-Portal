using SchoolPortal.Domain.Academics;

namespace SchoolPortal.Domain.Students;

public enum StudentStatus
{
    Active = 1,
    TransferCertificateIssued = 2,
    Left = 3,
    Alumni = 4,
}

public enum EnrollmentStatus
{
    Active = 1,
    Completed = 2,
    Withdrawn = 3,
}

public sealed class Student
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public string AdmissionNumber { get; set; } = string.Empty;

    public string FirstName { get; set; } = string.Empty;

    public string? MiddleName { get; set; }

    public string LastName { get; set; } = string.Empty;

    public DateOnly? DateOfBirth { get; set; }

    public string? Gender { get; set; }

    public string? BloodGroup { get; set; }

    public string? Category { get; set; }

    public string? Religion { get; set; }

    public string? MotherTongue { get; set; }

    public string Nationality { get; set; } = "Indian";

    public string? AadhaarNumber { get; set; }

    public DateOnly AdmissionDate { get; set; }

    public string? PreviousSchool { get; set; }

    public string? PermanentAddress { get; set; }

    public string? CorrespondenceAddress { get; set; }

    public string? City { get; set; }

    public string? State { get; set; }

    public string? PinCode { get; set; }

    public string? Remarks { get; set; }

    public StudentStatus Status { get; set; } = StudentStatus.Active;

    public DateTimeOffset CreatedAtUtc { get; set; } = DateTimeOffset.UtcNow;

    public DateTimeOffset UpdatedAtUtc { get; set; } = DateTimeOffset.UtcNow;

    public uint Version { get; set; }

    public ICollection<Guardian> Guardians { get; set; } = [];

    public ICollection<StudentEnrollment> Enrollments { get; set; } = [];

    public string FullName =>
        string.Join(
            ' ',
            new[] { FirstName, MiddleName, LastName }
                .Where(x => !string.IsNullOrWhiteSpace(x)));
}

public sealed class Guardian
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid StudentId { get; set; }

    public Student Student { get; set; } = null!;

    public string Relation { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public string Phone { get; set; } = string.Empty;

    public string? Email { get; set; }

    public string? Occupation { get; set; }

    public decimal? AnnualIncome { get; set; }

    public bool IsPrimary { get; set; }
}

public sealed class StudentEnrollment
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public Guid StudentId { get; set; }

    public Student Student { get; set; } = null!;

    public Guid AcademicYearId { get; set; }

    public AcademicYear AcademicYear { get; set; } = null!;

    public Guid ClassId { get; set; }

    public SchoolClass Class { get; set; } = null!;

    public Guid SectionId { get; set; }

    public Section Section { get; set; } = null!;

    public int RollNumber { get; set; }

    public EnrollmentStatus Status { get; set; } = EnrollmentStatus.Active;

    public DateTimeOffset CreatedAtUtc { get; set; } = DateTimeOffset.UtcNow;

    public uint Version { get; set; }
}
