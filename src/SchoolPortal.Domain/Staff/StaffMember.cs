namespace SchoolPortal.Domain.Staff;

public sealed class StaffMember
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public string StaffNumber { get; set; } = string.Empty;

    public string FirstName { get; set; } = string.Empty;

    public string? MiddleName { get; set; }

    public string LastName { get; set; } = string.Empty;

    public string Designation { get; set; } = string.Empty;

    public string? Department { get; set; }

    public string? EmploymentType { get; set; }

    public DateOnly? DateOfJoining { get; set; }

    public string Phone { get; set; } = string.Empty;

    public string? AlternatePhone { get; set; }

    public string? Email { get; set; }

    public string Address { get; set; } = string.Empty;

    public string City { get; set; } = string.Empty;

    public string State { get; set; } = string.Empty;

    public string PostalCode { get; set; } = string.Empty;

    public string? EmergencyContactName { get; set; }

    public string? EmergencyContactPhone { get; set; }

    public Guid? PortalUserId { get; set; }

    public bool IsActive { get; set; } = true;

    public uint Version { get; set; }

    public string FullName => string.Join(
        " ",
        new[] { FirstName, MiddleName, LastName }
            .Where(value => !string.IsNullOrWhiteSpace(value)));
}
