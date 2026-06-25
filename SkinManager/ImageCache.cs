using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace SkengSkinManager
{
    // Downloads workshop preview images once into %AppData%\...\imgcache\<id>.jpg.
    // The web UI loads them from the virtual host (cache.skin/<id>.jpg), so once
    // cached there is zero network on browse -> "no visible loading times".
    public static class ImageCache
    {
        private static readonly SemaphoreSlim Gate = new SemaphoreSlim(8);

        public static string FileFor(string id) => Path.Combine(Paths.ImageCache, id + ".jpg");

        public static bool Has(string id) => File.Exists(FileFor(id));

        // Returns true if the image is present (already cached or freshly downloaded).
        public static async Task<bool> Ensure(string id, string url)
        {
            if (string.IsNullOrEmpty(id)) return false;
            var dest = FileFor(id);
            if (File.Exists(dest) && new FileInfo(dest).Length > 0) return true;
            if (string.IsNullOrEmpty(url)) return false;

            await Gate.WaitAsync().ConfigureAwait(false);
            try
            {
                var bytes = await Steam.Download(url).ConfigureAwait(false);
                if (bytes != null && bytes.Length > 0)
                {
                    await File.WriteAllBytesAsync(dest, bytes).ConfigureAwait(false);
                    return true;
                }
            }
            catch { /* leave uncached; UI shows a placeholder */ }
            finally { Gate.Release(); }
            return false;
        }
    }
}
