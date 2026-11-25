using System.Net;
using System.Net.Http.Json;
using Restaurant.Admin.Models;

namespace Restaurant.Admin.Services;

public record StaffCredentials(string Username, string Password);
public class MenuException(string message, int status) : Exception(message)
{
    public int Status { get; } = status;
}

public class MenuService(HttpClient client)
{
    const string DraftRoute = "/api/admin/draft";
    public Task<MenuDraft> Read(CancellationToken ct) => Send(HttpMethod.Get, DraftRoute, null, ct);
    public Task<MenuDraft> Publish(long revision, CancellationToken ct) =>
        Send(HttpMethod.Post, "/api/admin/publish", new { revision }, ct);

    public async Task Change(long revision, Action<List<MenuItem>> change, CancellationToken ct)
    {
        var draft = await Read(ct);
        if (draft.Revision != revision) throw new MenuException("草稿已更新，請回到菜單核對最新資料。", 409);
        change(draft.Items);
        await Send(HttpMethod.Put, DraftRoute, new { revision, draft.Items }, ct);
    }
    public static int Find(List<MenuItem> items, string id)
    {
        var index = items.FindIndex(item => item.Id == id);
        return index >= 0 ? index : throw new MenuException("找不到這道餐點。", 404);
    }
    async Task<MenuDraft> Send(HttpMethod method, string path, object? body, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, path);
        if (body != null) request.Content = JsonContent.Create(body);
        try
        {
            using var response = await client.SendAsync(request, ct);
            if (!response.IsSuccessStatusCode)
            {
                if (response.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.Conflict)
                {
                    var error = await response.Content.ReadFromJsonAsync<ApiError>(ct);
                    throw new MenuException(error?.Error ?? "無法更新草稿。", (int)response.StatusCode);
                }
                throw new MenuException("菜單服務無法使用，請確認服務連線及管理權杖。", 503);
            }
            return await response.Content.ReadFromJsonAsync<MenuDraft>(ct)
                ?? throw new MenuException("菜單服務回覆為空。", 502);
        }
        catch (HttpRequestException) { throw new MenuException("無法連線到菜單服務。", 503); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw new MenuException("菜單服務逾時。", 503); }
    }
    record ApiError(string Error);
}
