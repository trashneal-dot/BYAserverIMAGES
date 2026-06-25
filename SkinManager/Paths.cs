using System;
using System.IO;

namespace SkengSkinManager
{
    // Central app-data layout. Everything the tool owns lives under
    // %AppData%\SkengSkinManager so it survives rebuilds and stays out of the repo.
    public static class Paths
    {
        public static readonly string Root =
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                         "SkengSkinManager");

        public static string WebViewData => Ensure(Path.Combine(Root, "webview2"));
        public static string ImageCache  => Ensure(Path.Combine(Root, "imgcache"));
        public static string LibraryFile => Path.Combine(Root, "library.json");
        public static string SettingsFile => Path.Combine(Root, "settings.json");

        // wwwroot ships next to the exe (copied by the csproj <Content> rule).
        public static string WwwRoot =>
            Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "wwwroot");

        public static string Ensure(string dir)
        {
            Directory.CreateDirectory(dir);
            return dir;
        }
    }
}
