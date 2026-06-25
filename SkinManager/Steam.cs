using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;

namespace SkengSkinManager
{
    // Steam Workshop read client. Uses the two key-free endpoints:
    //   ISteamRemoteStorage/GetCollectionDetails/v1/  -> collection -> child ids
    //   ISteamRemoteStorage/GetPublishedFileDetails/v1/ -> id -> title/preview/tags
    // Both are POST form-encoded and require NO API key.
    public static class Steam
    {
        private static readonly HttpClient Http = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(20)
        };

        public class Detail
        {
            public string Id;
            public string Title;
            public string PreviewUrl;
            public List<string> Tags = new List<string>();
            public bool Banned;
        }

        // Pull a workshop id out of a URL or accept a bare numeric id.
        public static string ParseId(string input)
        {
            if (string.IsNullOrWhiteSpace(input)) return null;
            input = input.Trim();
            if (Regex.IsMatch(input, "^\\d+$")) return input;
            var m = Regex.Match(input, "[?&]id=(\\d+)");
            if (m.Success) return m.Groups[1].Value;
            // last-ditch: any long digit run
            m = Regex.Match(input, "(\\d{6,})");
            return m.Success ? m.Groups[1].Value : null;
        }

        // If the id is a collection, return its child ids; otherwise return empty.
        public static async Task<List<string>> GetCollectionChildren(string id)
        {
            var form = new List<KeyValuePair<string, string>>
            {
                new KeyValuePair<string, string>("collectioncount", "1"),
                new KeyValuePair<string, string>("publishedfileids[0]", id),
            };
            var children = new List<string>();
            try
            {
                var resp = await Http.PostAsync(
                    "https://api.steampowered.com/ISteamRemoteStorage/GetCollectionDetails/v1/",
                    new FormUrlEncodedContent(form)).ConfigureAwait(false);
                var body = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                var root = JObject.Parse(body);
                var details = root["response"]?["collectiondetails"] as JArray;
                if (details == null) return children;
                foreach (var d in details)
                {
                    var kids = d["children"] as JArray;
                    if (kids == null) continue;
                    foreach (var k in kids)
                    {
                        var cid = (string)k["publishedfileid"];
                        if (!string.IsNullOrEmpty(cid)) children.Add(cid);
                    }
                }
            }
            catch { /* not a collection / network blip -> caller falls back to single id */ }
            return children;
        }

        // Batch detail lookup. Steam accepts many ids per call.
        public static async Task<List<Detail>> GetDetails(IEnumerable<string> ids)
        {
            var list = new List<string>(ids);
            var result = new List<Detail>();
            if (list.Count == 0) return result;

            const int chunk = 100;
            for (int off = 0; off < list.Count; off += chunk)
            {
                var slice = list.GetRange(off, Math.Min(chunk, list.Count - off));
                var form = new List<KeyValuePair<string, string>>
                {
                    new KeyValuePair<string, string>("itemcount", slice.Count.ToString()),
                };
                for (int i = 0; i < slice.Count; i++)
                    form.Add(new KeyValuePair<string, string>($"publishedfileids[{i}]", slice[i]));

                var resp = await Http.PostAsync(
                    "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
                    new FormUrlEncodedContent(form)).ConfigureAwait(false);
                var body = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                var arr = JObject.Parse(body)["response"]?["publishedfiledetails"] as JArray;
                if (arr == null) continue;
                foreach (var d in arr)
                {
                    var det = new Detail
                    {
                        Id = (string)d["publishedfileid"],
                        Title = (string)d["title"],
                        PreviewUrl = (string)d["preview_url"],
                        Banned = ((int?)d["banned"] ?? 0) != 0 || ((int?)d["result"] ?? 1) != 1,
                    };
                    if (d["tags"] is JArray tags)
                        foreach (var t in tags)
                        {
                            var tag = (string)t["tag"];
                            if (!string.IsNullOrEmpty(tag)) det.Tags.Add(tag);
                        }
                    if (!string.IsNullOrEmpty(det.Id)) result.Add(det);
                }
            }
            return result;
        }

        public static async Task<byte[]> Download(string url)
        {
            return await Http.GetByteArrayAsync(url).ConfigureAwait(false);
        }

        // Throttle the page scrapes so a big collection doesn't hammer Steam.
        private static readonly SemaphoreSlim AcceptGate = new SemaphoreSlim(8);

        // A skin accepted into the game shows an Item Store link + "has been
        // accepted" on its Workshop page; custom/workshop-only skins do not. The
        // Steam API does not expose this, so we scrape the page. On any error we
        // return false (keep the skin) rather than risk dropping a custom one.
        public static async Task<bool> IsAccepted(string id)
        {
            if (string.IsNullOrEmpty(id)) return false;
            await AcceptGate.WaitAsync().ConfigureAwait(false);
            try
            {
                var html = await Http.GetStringAsync(
                    $"https://steamcommunity.com/sharedfiles/filedetails/?id={id}").ConfigureAwait(false);
                return html.IndexOf("store.steampowered.com/itemstore", StringComparison.OrdinalIgnoreCase) >= 0
                    || html.IndexOf("has been accepted", StringComparison.OrdinalIgnoreCase) >= 0;
            }
            catch { return false; }
            finally { AcceptGate.Release(); }
        }
    }
}
