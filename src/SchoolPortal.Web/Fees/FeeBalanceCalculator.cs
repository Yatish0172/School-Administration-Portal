using SchoolPortal.Domain.Fees;

namespace SchoolPortal.Web.Fees;

public static class FeeBalanceCalculator
{
    public static decimal ConcessionTotal(StudentCharge charge) =>
        Math.Min(
            charge.Amount,
            charge.Concessions.Sum(x => x.Amount));

    public static decimal PaidTotal(StudentCharge charge) =>
        charge.PaymentAllocations
            .Where(x => x.FeePayment.Status == FeePaymentStatus.Posted)
            .Sum(x => x.Amount);

    public static decimal Outstanding(StudentCharge charge) =>
        Math.Max(
            0,
            charge.Amount - ConcessionTotal(charge) - PaidTotal(charge));
}
