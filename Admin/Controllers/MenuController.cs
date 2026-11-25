using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Restaurant.Admin.Models;
using Restaurant.Admin.Services;

namespace Restaurant.Admin.Controllers;

[Authorize, ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
public class MenuController(MenuService service) : Controller, IExceptionFilter
{
    [HttpGet] public async Task<IActionResult> Index(CancellationToken ct) => View(await service.Read(ct));
    [HttpGet] public async Task<IActionResult> ListView(CancellationToken ct) => PartialView("_ListView", await service.Read(ct));

    [HttpGet] public async Task<IActionResult> CreatePage(CancellationToken ct) =>
        View("Editor", new ItemForm { Revision = (await service.Read(ct)).Revision });

    [HttpGet] public async Task<IActionResult> UpdatePage(string id, CancellationToken ct)
    {
        var draft = await service.Read(ct);
        var item = draft.Items[MenuService.Find(draft.Items, id)];
        return View("Editor", ItemForm.From(item, draft.Revision));
    }

    [HttpPost] public async Task<IActionResult> Save(ItemForm form, CancellationToken ct)
    {
        if (!ModelState.IsValid) return View("Editor", form);
        try
        {
            await service.Change(form.Revision, items =>
            {
                if (string.IsNullOrEmpty(form.Id)) items.Add(form.ToItem(Guid.NewGuid().ToString("N")));
                else items[MenuService.Find(items, form.Id)] = form.ToItem(form.Id);
            }, ct);
        }
        catch (MenuException e) when (e.Status is 400 or 409)
        {
            Response.StatusCode = e.Status;
            ModelState.AddModelError("", e.Message);
            return View("Editor", form);
        }
        return Done("餐點已儲存到草稿。");
    }

    [HttpPost] public async Task<IActionResult> Toggle(string id, long revision, CancellationToken ct)
    {
        await service.Change(revision, items =>
        {
            var i = MenuService.Find(items, id);
            items[i] = items[i] with { Available = !items[i].Available };
        }, ct);
        return Done("供應狀態已儲存到草稿。");
    }
    [HttpPost] public async Task<IActionResult> Delete(string id, long revision, CancellationToken ct)
    {
        await service.Change(revision, items => items.RemoveAt(MenuService.Find(items, id)), ct);
        return Done("餐點已從草稿移除。");
    }
    [HttpPost] public async Task<IActionResult> Publish(long revision, CancellationToken ct)
    {
        var published = await service.Publish(revision, ct);
        return Done($"已發布菜單 v{published.Version}。");
    }
    IActionResult Done(string message)
    {
        TempData["Notice"] = message;
        return RedirectToAction(nameof(Index));
    }
    public void OnException(ExceptionContext context)
    {
        if (context.Exception is not MenuException error) return;
        ViewData["Error"] = error.Message;
        context.Result = new ViewResult { ViewName = "Error", ViewData = ViewData, StatusCode = error.Status };
        context.ExceptionHandled = true;
    }
}
