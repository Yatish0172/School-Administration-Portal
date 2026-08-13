using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using SchoolPortal.Infrastructure.Persistence;

namespace SchoolPortal.Tests;

public sealed class DatabaseReadinessTests(
    WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task ReadyHealthEndpointReportsPostgreSqlHealthy()
    {
        using var client = factory.CreateClient();

        using var response = await client.GetAsync("/health/ready");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        await using var stream = await response.Content.ReadAsStreamAsync();
        using var json = await JsonDocument.ParseAsync(stream);
        Assert.Equal("healthy", json.RootElement.GetProperty("status").GetString());

        var postgreSql = json.RootElement
            .GetProperty("checks")
            .EnumerateArray()
            .Single(check => check.GetProperty("name").GetString() == "postgresql");

        Assert.Equal("healthy", postgreSql.GetProperty("status").GetString());
    }

    [Fact]
    public async Task DatabaseHasNoPendingMigrations()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var dbContext = scope.ServiceProvider
            .GetRequiredService<SchoolPortalDbContext>();

        var pendingMigrations = await dbContext.Database
            .GetPendingMigrationsAsync();

        Assert.Empty(pendingMigrations);
    }
}
