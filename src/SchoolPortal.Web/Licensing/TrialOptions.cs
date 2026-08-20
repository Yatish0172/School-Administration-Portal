namespace SchoolPortal.Web.Licensing;

public sealed class TrialOptions
{
    public const string SectionName = "Trial";

    public bool Enabled { get; set; }

    public int DurationDays { get; set; } = 7;
}
