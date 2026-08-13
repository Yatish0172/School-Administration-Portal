namespace SchoolPortal.Web.Identity;

public sealed class PortalAuthenticationOptions
{
    public const string SectionName = "Authentication";

    public bool RequirePassword { get; set; } = true;

    public bool BypassLogin { get; set; }
}
