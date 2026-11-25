using System.Net.Http.Headers;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Mvc;
using Restaurant.Admin.Services;

var builder = WebApplication.CreateBuilder(args);
string Required(string key) => !string.IsNullOrWhiteSpace(builder.Configuration[key])
    ? builder.Configuration[key]! : throw new InvalidOperationException($"請設定 {key}。");

var credentials = new StaffCredentials(Required("ADMIN_USERNAME"), Required("ADMIN_PASSWORD"));
var token = Required("ADMIN_TOKEN");
var menuAddress = new Uri(builder.Configuration["MENU_API_URL"] ?? "http://127.0.0.1:8787");
if (string.IsNullOrEmpty(builder.Configuration["urls"]))
    builder.WebHost.UseUrls("http://127.0.0.1:5080");

builder.Services.AddSingleton(credentials);
builder.Services.AddHttpClient<MenuService>(client =>
{
    client.BaseAddress = menuAddress;
    client.Timeout = TimeSpan.FromSeconds(10);
    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
}).ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false });
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme).AddCookie(options =>
{
    options.LoginPath = "/Backend/Login";
    options.Cookie.Name = "Restaurant.Staff";
    options.Cookie.HttpOnly = true;
    options.Cookie.SameSite = SameSiteMode.Strict;
    options.ExpireTimeSpan = TimeSpan.FromHours(8);
});
builder.Services.AddControllersWithViews(options => options.Filters.Add(new AutoValidateAntiforgeryTokenAttribute()));
var app = builder.Build();
app.UseStaticFiles();
app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();
app.MapControllerRoute("default", "{controller=Menu}/{action=Index}/{id?}");
app.Run();
