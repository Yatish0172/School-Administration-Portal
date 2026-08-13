namespace SchoolPortal.Web.Attendance;

public sealed class AttendanceOptions
{
    public const string SectionName = "Attendance";

    public int LockHours { get; set; } = 24;

    public decimal DefaulterThreshold { get; set; } = 75;
}
