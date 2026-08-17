namespace SchoolPortal.Application.Authorization;

public static class RoleCatalog
{
    public const string SuperAdministrator = "Super Administrator";
    public const string Administrator = "Administrator";
    public const string Principal = "Principal";
    public const string Teacher = "Teacher";
    public const string Accounts = "Accounts";
    public const string Librarian = "Librarian";

    public static IReadOnlyList<string> All { get; } =
    [
        SuperAdministrator,
        Administrator,
        Principal,
        Teacher,
        Accounts,
        Librarian,
    ];

    public static IReadOnlyDictionary<string, IReadOnlyCollection<string>> DefaultPermissions { get; } =
        new Dictionary<string, IReadOnlyCollection<string>>(StringComparer.Ordinal)
        {
            [SuperAdministrator] = PermissionCatalog.All.Select(x => x.Key).ToArray(),
            [Administrator] = PermissionCatalog.All
                .Where(x => x.Key != PermissionCatalog.Backup.Restore)
                .Select(x => x.Key)
                .ToArray(),
            [Principal] =
            [
                PermissionCatalog.Students.View,
                PermissionCatalog.Students.ViewSensitive,
                PermissionCatalog.Attendance.View,
                PermissionCatalog.Attendance.MarkAny,
                PermissionCatalog.Attendance.Correct,
                PermissionCatalog.Exams.View,
                PermissionCatalog.Exams.Configure,
                PermissionCatalog.Marks.Review,
                PermissionCatalog.Marks.Publish,
                PermissionCatalog.Fees.View,
                PermissionCatalog.Fees.Reports,
                PermissionCatalog.Library.View,
                PermissionCatalog.Reports.View,
                PermissionCatalog.Reports.Export,
                PermissionCatalog.Administration.ViewAudit,
                PermissionCatalog.System.ViewHealth,
            ],
            [Teacher] =
            [
                PermissionCatalog.Students.View,
                PermissionCatalog.Attendance.View,
                PermissionCatalog.Attendance.MarkAssigned,
                PermissionCatalog.Exams.View,
                PermissionCatalog.Marks.Enter,
                PermissionCatalog.Library.View,
                PermissionCatalog.Reports.View,
            ],
            [Accounts] =
            [
                PermissionCatalog.Students.View,
                PermissionCatalog.Fees.View,
                PermissionCatalog.Fees.Configure,
                PermissionCatalog.Fees.PostPayment,
                PermissionCatalog.Fees.ReversePayment,
                PermissionCatalog.Fees.Reports,
                PermissionCatalog.Library.ViewFines,
                PermissionCatalog.Reports.View,
                PermissionCatalog.Reports.Export,
            ],
            [Librarian] =
            [
                PermissionCatalog.Students.View,
                PermissionCatalog.Library.View,
                PermissionCatalog.Library.Manage,
                PermissionCatalog.Library.Issue,
                PermissionCatalog.Library.Return,
                PermissionCatalog.Library.ViewFines,
                PermissionCatalog.Reports.View,
                PermissionCatalog.Reports.Export,
            ],
        };
}
