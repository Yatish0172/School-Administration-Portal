using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using SchoolPortal.Domain.Licensing;

namespace SchoolPortal.Infrastructure.Persistence.Configurations;

internal sealed class TrialStateConfiguration : IEntityTypeConfiguration<TrialState>
{
    public void Configure(EntityTypeBuilder<TrialState> builder)
    {
        builder.ToTable("TrialState");
        builder.HasKey(x => x.Id);
        builder.Property(x => x.FirstRunAtUtc).IsRequired();
    }
}
