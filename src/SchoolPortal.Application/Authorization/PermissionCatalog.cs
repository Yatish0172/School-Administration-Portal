namespace SchoolPortal.Application.Authorization;

public sealed record PermissionDefinition(
    string Key,
    string Module,
    string Description);

public static class PermissionCatalog
{
    public const string ClaimType = "permission";
    public const string PolicyPrefix = "Permission:";

    public static class Students
    {
        public const string View = "students.view";
        public const string Create = "students.create";
        public const string Edit = "students.edit";
        public const string ViewSensitive = "students.view-sensitive";
        public const string ManageDocuments = "students.manage-documents";
    }

    public static class Academics
    {
        public const string Manage = "academics.manage";
    }

    public static class Attendance
    {
        public const string View = "attendance.view";
        public const string MarkAssigned = "attendance.mark-assigned";
        public const string MarkAny = "attendance.mark-any";
        public const string Correct = "attendance.correct";
    }

    public static class Exams
    {
        public const string View = "exams.view";
        public const string Configure = "exams.configure";
    }

    public static class Marks
    {
        public const string Enter = "marks.enter";
        public const string Review = "marks.review";
        public const string Publish = "marks.publish";
    }

    public static class Fees
    {
        public const string View = "fees.view";
        public const string Configure = "fees.configure";
        public const string PostPayment = "fees.post-payment";
        public const string ReversePayment = "fees.reverse-payment";
        public const string Reports = "fees.reports";
    }

    public static class Library
    {
        public const string View = "library.view";
        public const string Manage = "library.manage";
        public const string Issue = "library.issue";
        public const string Return = "library.return";
        public const string ViewFines = "library.view-fines";
    }

    public static class Reports
    {
        public const string View = "reports.view";
        public const string Export = "reports.export";
    }

    public static class Administration
    {
        public const string ManageUsers = "administration.manage-users";
        public const string ManageRoles = "administration.manage-roles";
        public const string ManageSettings = "administration.manage-settings";
        public const string ViewAudit = "administration.view-audit";
    }

    public static class Backup
    {
        public const string View = "backup.view";
        public const string Run = "backup.run";
        public const string Restore = "backup.restore";
    }

    public static class System
    {
        public const string ViewHealth = "system.view-health";
    }

    public static IReadOnlyList<PermissionDefinition> All { get; } =
    [
        new(Students.View, "Students", "View student records."),
        new(Students.Create, "Students", "Create student records."),
        new(Students.Edit, "Students", "Edit student records."),
        new(Students.ViewSensitive, "Students", "View sensitive student information."),
        new(Students.ManageDocuments, "Students", "Upload and manage student documents."),
        new(Academics.Manage, "Academics", "Manage academic years, classes, sections, and subjects."),
        new(Attendance.View, "Attendance", "View attendance."),
        new(Attendance.MarkAssigned, "Attendance", "Mark attendance for assigned classes."),
        new(Attendance.MarkAny, "Attendance", "Mark attendance for any class."),
        new(Attendance.Correct, "Attendance", "Correct submitted attendance."),
        new(Exams.View, "Exams", "View examinations, date sheets, and results."),
        new(Exams.Configure, "Exams", "Configure exams and grading."),
        new(Marks.Enter, "Marks", "Enter marks."),
        new(Marks.Review, "Marks", "Review submitted marks."),
        new(Marks.Publish, "Marks", "Publish results."),
        new(Fees.View, "Fees", "View fee accounts."),
        new(Fees.Configure, "Fees", "Configure fee structures and concessions."),
        new(Fees.PostPayment, "Fees", "Post fee payments."),
        new(Fees.ReversePayment, "Fees", "Reverse posted payments."),
        new(Fees.Reports, "Fees", "View fee reports."),
        new(Library.View, "Library", "View the library catalogue."),
        new(Library.Manage, "Library", "Manage library books and copies."),
        new(Library.Issue, "Library", "Issue books."),
        new(Library.Return, "Library", "Return books."),
        new(Library.ViewFines, "Library", "View library fines and settlement status."),
        new(Reports.View, "Reports", "View reports."),
        new(Reports.Export, "Reports", "Export reports."),
        new(Administration.ManageUsers, "Administration", "Manage portal users."),
        new(Administration.ManageRoles, "Administration", "Manage roles and permissions."),
        new(Administration.ManageSettings, "Administration", "Manage school settings."),
        new(Administration.ViewAudit, "Administration", "View the audit log."),
        new(Backup.View, "Backup", "View backup status."),
        new(Backup.Run, "Backup", "Run a backup."),
        new(Backup.Restore, "Backup", "Restore a backup."),
        new(System.ViewHealth, "System", "View system health."),
    ];

    public static string Policy(string permission) => $"{PolicyPrefix}{permission}";
}
