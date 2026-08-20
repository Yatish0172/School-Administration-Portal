namespace SchoolPortal.Domain.Licensing;

public sealed class TrialState
{
    public Guid Id { get; set; } = Guid.NewGuid();

    public DateTimeOffset FirstRunAtUtc { get; set; }
}
