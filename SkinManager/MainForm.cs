using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace SkengSkinManager
{
    public class MainForm : Form
    {
        private WebView2 _web;

        // Serializer for the emitted mission def: omit nulls so the base64 stays
        // small and only carries fields the admin actually set.
        private static readonly JsonSerializerSettings MissionSettings = new JsonSerializerSettings
        {
            NullValueHandling = NullValueHandling.Ignore,
            DefaultValueHandling = DefaultValueHandling.Ignore,
        };

        public MainForm()
        {
            Text = "Skeng Skin Manager";
            Width = 1440;
            Height = 920;
            MinimumSize = new System.Drawing.Size(1000, 640);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = System.Drawing.Color.FromArgb(20, 20, 24);

            _web = new WebView2 { Dock = DockStyle.Fill };
            Controls.Add(_web);
            Load += async (s, e) => await InitWeb();
        }

        private async Task InitWeb()
        {
            try
            {
                var env = await CoreWebView2Environment.CreateAsync(null, Paths.WebViewData);
                await _web.EnsureCoreWebView2Async(env);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "WebView2 runtime is required.\n\n" +
                    "Install the 'Evergreen' runtime from:\n" +
                    "https://developer.microsoft.com/microsoft-edge/webview2/\n\n" +
                    ex.Message,
                    "Skeng Skin Manager", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            var core = _web.CoreWebView2;
            // Serve the UI and the image cache from virtual hosts so browsing is
            // pure local file access (instant) and images need no data-uri bloat.
            core.SetVirtualHostNameToFolderMapping("app.skin", Paths.WwwRoot,
                CoreWebView2HostResourceAccessKind.Allow);
            core.SetVirtualHostNameToFolderMapping("cache.skin", Paths.ImageCache,
                CoreWebView2HostResourceAccessKind.Allow);

            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.WebMessageReceived += OnWebMessage;

            core.Navigate("https://app.skin/index.html");
        }

        // ── RPC: JS posts {id, method, args}; we reply {id, ok, result|error}. ──
        private async void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string id = null;
            try
            {
                var req = JObject.Parse(e.WebMessageAsJson);
                id = (string)req["id"];
                var method = (string)req["method"];
                var args = req["args"] as JObject ?? new JObject();
                var result = await Dispatch(method, args);
                Respond(id, true, result, null);
            }
            catch (Exception ex)
            {
                Respond(id, false, null, ex.Message);
            }
        }

        private void Respond(string id, bool ok, object result, string error)
        {
            var payload = new JObject
            {
                ["id"] = id,
                ["ok"] = ok,
                ["result"] = result == null ? JValue.CreateNull() : JToken.FromObject(result),
                ["error"] = error == null ? JValue.CreateNull() : new JValue(error),
            };
            try { _web.CoreWebView2.PostWebMessageAsJson(payload.ToString(Formatting.None)); }
            catch { /* view tearing down */ }
        }

        private async Task<object> Dispatch(string method, JObject a)
        {
            switch (method)
            {
                case "getMeta":
                    return new { version = "1.0", root = Paths.Root, cacheHost = "https://cache.skin/" };

                case "loadLibrary":
                    return Store.LoadLibrary();

                case "saveLibrary":
                {
                    var lib = a["library"]?.ToObject<Library>() ?? new Library();
                    Store.SaveLibrary(lib);
                    return new { saved = true };
                }

                case "addSource":
                    return await AddSource((string)a["input"]);

                case "ensureImages":
                    return await EnsureImages(a["items"] as JArray);

                case "refreshDetails":
                    return await RefreshDetails(a["ids"] as JArray);

                case "loadMissions":
                    return await LoadMissions((string)a["path"]);

                case "buildImportCommand":
                    return BuildImportCommand(a["def"] as JObject);

                case "copy":
                {
                    var text = (string)a["text"] ?? "";
                    if (text.Length > 0) Clipboard.SetText(text);
                    return new { ok = true };
                }

                case "pickFile":
                    return PickFile((string)a["title"], (string)a["filter"]);

                case "openExternal":
                    OpenExternal((string)a["url"]);
                    return new { ok = true };

                default:
                    throw new Exception("unknown method: " + method);
            }
        }

        // Resolve a collection link/single link/bare id -> resolved skin entries.
        private async Task<object> AddSource(string input)
        {
            var id = Steam.ParseId(input);
            if (id == null) throw new Exception("No workshop id found in: " + input);

            var children = await Steam.GetCollectionChildren(id);
            var ids = children.Count > 0 ? children : new List<string> { id };
            var details = await Steam.GetDetails(ids);

            // Cache every preview image up front (the one acceptable "loading"
            // moment); browsing afterwards is instant from cache.skin.
            await Task.WhenAll(details.Select(d => ImageCache.Ensure(d.Id, d.PreviewUrl)));

            var skins = details.Select(d =>
            {
                var sn = ShortnameMap.Suggest(d.Tags);
                return new SkinEntry
                {
                    id = d.Id,
                    title = d.Title,
                    tags = d.Tags,
                    previewUrl = d.PreviewUrl,
                    banned = d.Banned,
                    shortname = sn,
                    shortnameAuto = !string.IsNullOrEmpty(sn),
                    cached = ImageCache.Has(d.Id),
                    addedAt = DateTime.UtcNow.ToString("o"),
                };
            }).ToList();

            return new { isCollection = children.Count > 0, count = skins.Count, skins };
        }

        private async Task<object> EnsureImages(JArray items)
        {
            var cached = new List<string>();
            if (items != null)
            {
                var ids = new List<string>();
                var tasks = new List<Task>();
                foreach (var it in items)
                {
                    var iid = (string)it["id"];
                    var url = (string)it["url"];
                    if (string.IsNullOrEmpty(iid)) continue;
                    ids.Add(iid);
                    tasks.Add(ImageCache.Ensure(iid, url));
                }
                await Task.WhenAll(tasks);
                cached.AddRange(ids.Where(ImageCache.Has));
            }
            return new { cached };
        }

        private async Task<object> RefreshDetails(JArray idsArr)
        {
            var ids = idsArr?.Select(t => (string)t).Where(s => !string.IsNullOrEmpty(s)).ToList()
                      ?? new List<string>();
            var details = await Steam.GetDetails(ids);
            await Task.WhenAll(details.Select(d => ImageCache.Ensure(d.Id, d.PreviewUrl)));
            var updated = details.Select(d => new
            {
                id = d.Id,
                title = d.Title,
                tags = d.Tags,
                previewUrl = d.PreviewUrl,
                banned = d.Banned,
                cached = ImageCache.Has(d.Id),
            }).ToList();
            return new { updated };
        }

        private async Task<object> LoadMissions(string path)
        {
            if (string.IsNullOrEmpty(path))
            {
                path = PickFileRaw("Open missions.json", "JSON (*.json)|*.json|All files (*.*)|*.*");
                if (string.IsNullOrEmpty(path)) return new { cancelled = true };
            }
            if (!File.Exists(path)) throw new Exception("File not found: " + path);

            var json = await File.ReadAllTextAsync(path);
            var cat = JsonConvert.DeserializeObject<MissionCatalog>(json) ?? new MissionCatalog();

            var missions = new List<object>();
            var usage = new Dictionary<string, List<string>>();

            foreach (var kv in cat.Missions)
            {
                var d = kv.Value;
                if (d == null) continue;
                if (string.IsNullOrEmpty(d.Key)) d.Key = kv.Key;

                if (d.Rewards != null)
                {
                    foreach (var r in d.Rewards)
                    {
                        if (r == null) continue;
                        if (string.Equals(r.Type, "skin", StringComparison.OrdinalIgnoreCase)
                            && !string.IsNullOrEmpty(r.Target))
                            AddUsage(usage, r.Target, d.Key);
                        if (r.SkinSetEntries != null)
                            foreach (var se in r.SkinSetEntries)
                                if (se.Value != 0UL) AddUsage(usage, se.Value.ToString(), d.Key);
                    }
                }

                missions.Add(new
                {
                    key = d.Key,
                    title = d.Title,
                    type = d.Type,
                    description = d.Description,
                    trackers = (d.Trackers ?? new List<MissionTrackerSpec>())
                        .Select(t => new { key = t.Key, threshold = t.Threshold }).ToList(),
                    rewards = (d.Rewards ?? new List<MissionReward>())
                        .Select(r => new { type = r.Type, target = r.Target, itemShortname = r.ItemShortname }).ToList(),
                });
            }

            return new { path, count = missions.Count, missions, skinUsage = usage };
        }

        private static void AddUsage(Dictionary<string, List<string>> usage, string skinId, string missionKey)
        {
            if (!usage.TryGetValue(skinId, out var list)) usage[skinId] = list = new List<string>();
            if (!list.Contains(missionKey)) list.Add(missionKey);
        }

        private object BuildImportCommand(JObject defObj)
        {
            if (defObj == null) throw new Exception("No mission def provided.");
            var def = defObj.ToObject<MissionDef>();
            if (def == null || string.IsNullOrEmpty(def.Key)) throw new Exception("Mission needs a Key.");
            var json = JsonConvert.SerializeObject(def, MissionSettings);
            var b64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(json));
            return new { command = "bya.admin missions import " + b64, json, length = b64.Length };
        }

        private object PickFile(string title, string filter)
        {
            var path = PickFileRaw(title, filter);
            return string.IsNullOrEmpty(path) ? (object)new { cancelled = true } : new { path };
        }

        private string PickFileRaw(string title, string filter)
        {
            using var dlg = new OpenFileDialog
            {
                Title = string.IsNullOrEmpty(title) ? "Open file" : title,
                Filter = string.IsNullOrEmpty(filter) ? "All files (*.*)|*.*" : filter,
                CheckFileExists = true,
            };
            return dlg.ShowDialog(this) == DialogResult.OK ? dlg.FileName : null;
        }

        private void OpenExternal(string url)
        {
            if (string.IsNullOrEmpty(url)) return;
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
            catch { /* ignore */ }
        }
    }
}
