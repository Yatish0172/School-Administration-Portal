using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace SchoolPortal.Web.Pages.Account;

[Authorize]
public sealed class AccessDeniedModel : PageModel;
