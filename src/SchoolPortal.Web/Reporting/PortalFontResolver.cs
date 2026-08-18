using System.Reflection;
using PdfSharp.Fonts;

namespace SchoolPortal.Web.Reporting;

internal sealed class PortalFontResolver : IFontResolver
{
    public const string FamilyName = "Portal Sans";

    private const string RegularFace = "NotoSans-Regular";
    private const string BoldFace = "NotoSans-Bold";
    private const string ResourcePrefix =
        "SchoolPortal.Web.Reporting.Fonts.";
    private static readonly Lazy<byte[]> RegularFont =
        new(() => ReadResource("NotoSans-Regular.ttf"));
    private static readonly Lazy<byte[]> BoldFont =
        new(() => ReadResource("NotoSans-Bold.ttf"));

    public FontResolverInfo ResolveTypeface(
        string familyName,
        bool isBold,
        bool isItalic) =>
        new(isBold ? BoldFace : RegularFace);

    public byte[] GetFont(string faceName) => faceName switch
    {
        RegularFace => RegularFont.Value,
        BoldFace => BoldFont.Value,
        _ => throw new InvalidOperationException(
            $"Unknown embedded PDF font face '{faceName}'."),
    };

    private static byte[] ReadResource(string fileName)
    {
        using var stream = Assembly.GetExecutingAssembly()
            .GetManifestResourceStream(ResourcePrefix + fileName)
            ?? throw new InvalidOperationException(
                $"Embedded PDF font '{fileName}' was not found.");
        using var memory = new MemoryStream();
        stream.CopyTo(memory);
        return memory.ToArray();
    }
}
