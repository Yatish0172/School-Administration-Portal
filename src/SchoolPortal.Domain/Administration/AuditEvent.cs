namespace SchoolPortal.Domain.Administration;

public sealed class AuditEvent
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public DateTimeOffset OccurredAtUtc { get; set; } = DateTimeOffset.UtcNow;

    public Guid? UserId { get; set; }

    public string EventType { get; set; } = string.Empty;

    public string EntityType { get; set; } = string.Empty;

    public string EntityId { get; set; } = string.Empty;

    public string? BeforeJson { get; set; }

    public string? AfterJson { get; set; }

    public string CorrelationId { get; set; } = string.Empty;

    public string? IpAddress { get; set; }
}
