using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using SchoolPortal.Infrastructure.Identity;
using SchoolPortal.Infrastructure.Persistence;

namespace SchoolPortal.Infrastructure;

public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructure(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        var connectionString = configuration.GetConnectionString("SchoolDb");
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            throw new InvalidOperationException(
                "Connection string 'SchoolDb' is required.");
        }

        services.AddDbContext<SchoolPortalDbContext>(options =>
            options.UseNpgsql(connectionString, npgsql =>
                npgsql.MigrationsAssembly(typeof(SchoolPortalDbContext).Assembly.FullName)));

        services
            .AddIdentityCore<ApplicationUser>(options =>
            {
                options.Lockout.AllowedForNewUsers = true;
                options.Lockout.MaxFailedAccessAttempts = 5;
                options.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(15);
                options.Password.RequiredLength = 8;
                options.Password.RequireDigit = true;
                options.Password.RequireLowercase = true;
                options.Password.RequireUppercase = true;
                options.Password.RequireNonAlphanumeric = false;
                options.User.RequireUniqueEmail = false;
            })
            .AddRoles<IdentityRole<Guid>>()
            .AddEntityFrameworkStores<SchoolPortalDbContext>()
            .AddSignInManager();

        services.AddScoped<TeacherAccountProvisioner>();

        services
            .AddHealthChecks()
            .AddDbContextCheck<SchoolPortalDbContext>(
                name: "postgresql",
                tags: ["ready"]);

        return services;
    }
}
