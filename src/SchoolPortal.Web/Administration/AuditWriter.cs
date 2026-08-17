using System.Security.Claims;
using System.Text.Json;
using SchoolPortal.Domain.Administration;
using SchoolPortal.Infrastructure.Persistence;

namespace SchoolPortal.Web.Administration;

public sealed class AuditWriter(
    SchoolPortalDbContext dbContext,
    IHttpContextAccessor httpContextAccessor)
{
    private static readonly JsonSerializerOptions SerializerOptions =
        new(JsonSerializerDefaults.Web);

    public void Add(
        string eventType,
        string entityType,
        Guid entityId,
        object? before,
        object? after)
    {
        var httpContext = httpContextAccessor.HttpContext;
        var userIdValue = httpContext?.User.FindFirstValue(ClaimTypes.NameIdentifier);
        var userId = Guid.TryParse(userIdValue, out var parsedUserId)
            ? parsedUserId
            : (Guid?)null;

        dbContext.Set<AuditEvent>().Add(new AuditEvent
        {
            UserId = userId,
            EventType = eventType,
            EntityType = entityType,
            EntityId = entityId.ToString(),
            BeforeJson = Serialize(before),
            AfterJson = Serialize(after),
            CorrelationId = httpContext?.TraceIdentifier ?? Guid.NewGuid().ToString("N"),
            IpAddress = httpContext?.Connection.RemoteIpAddress?.ToString(),
        });
    }

    private static string? Serialize(object? value) =>
        value is null
            ? null
            : JsonSerializer.Serialize(value, SerializerOptions);
}
