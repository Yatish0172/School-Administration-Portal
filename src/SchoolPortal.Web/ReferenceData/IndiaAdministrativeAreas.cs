namespace SchoolPortal.Web.ReferenceData;

public static class IndiaAdministrativeAreas
{
    public static IReadOnlyList<string> States { get; } =
    [
        "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar",
        "Chhattisgarh", "Goa", "Gujarat", "Haryana", "Himachal Pradesh",
        "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh",
        "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland",
        "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu",
        "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand",
        "West Bengal",
    ];

    public static IReadOnlyList<string> UnionTerritories { get; } =
    [
        "Andaman and Nicobar Islands", "Chandigarh",
        "Dadra and Nagar Haveli and Daman and Diu", "Delhi",
        "Jammu and Kashmir", "Ladakh", "Lakshadweep", "Puducherry",
    ];
}
