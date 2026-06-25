using System.IO;
using Newtonsoft.Json;

namespace SkengSkinManager
{
    // Library persistence (load/save the local skin catalog). Plain pretty JSON
    // so it's hand-inspectable.
    public static class Store
    {
        private static readonly JsonSerializerSettings Settings = new JsonSerializerSettings
        {
            Formatting = Formatting.Indented,
            NullValueHandling = NullValueHandling.Ignore,
        };

        public static Library LoadLibrary()
        {
            try
            {
                if (File.Exists(Paths.LibraryFile))
                {
                    var json = File.ReadAllText(Paths.LibraryFile);
                    var lib = JsonConvert.DeserializeObject<Library>(json);
                    if (lib != null)
                    {
                        lib.groups ??= new System.Collections.Generic.List<SkinGroup>();
                        lib.skins ??= new System.Collections.Generic.List<SkinEntry>();
                        return lib;
                    }
                }
            }
            catch { /* corrupt -> start fresh */ }
            return new Library();
        }

        public static void SaveLibrary(Library lib)
        {
            Paths.Ensure(Paths.Root);
            File.WriteAllText(Paths.LibraryFile, JsonConvert.SerializeObject(lib, Settings));
        }
    }
}
