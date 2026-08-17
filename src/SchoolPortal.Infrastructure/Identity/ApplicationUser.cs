using Microsoft.AspNetCore.Identity;

namespace SchoolPortal.Infrastructure.Identity;

public sealed class ApplicationUser : IdentityUser<Guid>
{
    public string DisplayName { get; set; } = string.Empty;

    public bool IsActive { get; set; } = true;

    public bool MustChangePassword { get; set; }

    public DateTimeOffset? LastLoginAtUtc { get; set; }
}
