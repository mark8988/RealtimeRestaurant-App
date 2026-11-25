using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Restaurant.Admin.Services;

namespace Restaurant.Admin.Controllers;

[Authorize, ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
public class BackendController(StaffCredentials credentials) : Controller
{
    [AllowAnonymous, HttpGet]
    public IActionResult Login() => User.Identity?.IsAuthenticated == true
        ? RedirectToAction("Index", "Menu") : View();

    [AllowAnonymous, HttpPost]
    public async Task<IActionResult> Login(string? username, string? password)
    {
        if (!(Matches(username, credentials.Username) & Matches(password, credentials.Password)))
        {
            ModelState.AddModelError("", "帳號或密碼錯誤。");
            return View();
        }
        var identity = new ClaimsIdentity([new Claim(ClaimTypes.Name, credentials.Username)],
            CookieAuthenticationDefaults.AuthenticationScheme);
        await HttpContext.SignInAsync(new ClaimsPrincipal(identity));
        return RedirectToAction("Index", "Menu");
    }
    [HttpPost]
    public async Task<IActionResult> Logout()
    {
        await HttpContext.SignOutAsync();
        return RedirectToAction(nameof(Login));
    }
    static bool Matches(string? input, string expected) => CryptographicOperations.FixedTimeEquals(
        SHA256.HashData(Encoding.UTF8.GetBytes(input ?? "")), SHA256.HashData(Encoding.UTF8.GetBytes(expected)));
}
