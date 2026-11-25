using System.ComponentModel.DataAnnotations;

namespace Restaurant.Admin.Models;

public record MenuItem(string Id, string Name, string Category, string Description, int Price,
    bool Available, string[] Tags, string[] Allergens);
public record MenuDraft(long Revision, long Version, List<MenuItem> Items);

public class ItemForm
{
    public string? Id { get; set; }
    public long Revision { get; set; }
    [Required(ErrorMessage = "請填寫餐點名稱。"), StringLength(80)] public string Name { get; set; } = "";
    [Required(ErrorMessage = "請填寫分類。"), StringLength(40)] public string Category { get; set; } = "";
    [Required(ErrorMessage = "請填寫餐點介紹。"), StringLength(600)] public string Description { get; set; } = "";
    [Required(ErrorMessage = "請填寫價格。"), Range(0, 999999)] public int? Price { get; set; }
    public bool Available { get; set; } = true;
    public string? Tags { get; set; }
    public string? Allergens { get; set; }

    public static ItemForm From(MenuItem item, long revision) => new()
    {
        Id = item.Id, Revision = revision, Name = item.Name, Category = item.Category,
        Description = item.Description, Price = item.Price, Available = item.Available,
        Tags = string.Join("、", item.Tags), Allergens = string.Join("、", item.Allergens)
    };
    public MenuItem ToItem(string id) => new(id, Name.Trim(), Category.Trim(), Description.Trim(),
        Price!.Value, Available, Split(Tags), Split(Allergens));
    static string[] Split(string? value) => (value ?? "").Split(['、', ',', '，'],
        StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries).Distinct().ToArray();
}
