# Skeng Skin Manager

A small Windows desktop tool to **catalog Rust skins** (from Steam Workshop
collections / item links), preview them, sort them into groups, and **generate
missions** that hand them out as rewards — emitted as a single paste-able
`bya.admin missions import <base64>` console command for BYAplugin.

It is **read-only against the live server**: it never touches the running
`missions.json`. You optionally feed it a *copy* of `missions.json` to see which
skins are already used, and it outputs console commands you paste in-game.

## Stack

- **.NET 8 (WinForms host) + WebView2** — C# core (file I/O, Steam HTTP, image
  cache, clipboard) with a web UI (`wwwroot/`) for the responsive grid.
- **Newtonsoft.Json** — the same serializer the plugin uses, so the mission def
  we emit round-trips 1:1 with `BYAMissionDef`.
- IPC is a JSON request/response over `WebView2` web-messages (see
  `MainForm.OnWebMessage` ↔ `app.js call()`).

## Build & run

```powershell
cd tools\SkinManager
dotnet restore
dotnet run            # or: dotnet build -c Release
```

Requirements:
- .NET 8 SDK.
- The **WebView2 Evergreen Runtime** (preinstalled on current Win10/11; else
  https://developer.microsoft.com/microsoft-edge/webview2/).
- If NuGet pins the WebView2 version, run `dotnet add package Microsoft.Web.WebView2`.

All app data (library, cached images, WebView2 profile) lives under
`%AppData%\SkengSkinManager\`.

## How it works

- **Add skins**: paste a Workshop **collection** link, a single item link, or a
  bare id, pick a group, hit **Add**. The app resolves it via the key-free Steam
  endpoints (`GetCollectionDetails` / `GetPublishedFileDetails`), downloads each
  preview image once into the local cache, and auto-suggests an item *shortname*
  from the workshop tags (`ShortnameMap.cs` — extend it freely; you can always
  override per-skin).
- **Browse**: groups in the sidebar, search by title/shortname/id/tag. Images
  load from the local cache host (`cache.skin`) so browsing is instant.
- **Per skin**: copy `/skincreate <shortname> <id>` to preview in-game, edit the
  shortname/group, open the workshop page, or **Create mission from this skin**.
- **Cross-reference**: *Load missions.json* tags each skin with the missions
  that already reward it.
- **Generate mission**: title + type + optional bonus XP + optional trigger
  (`None` / kills / wins / custom tracker grammar). Produces
  `bya.admin missions import <base64>` — paste it in the in-game F1 console as an
  admin. Re-importing the same key edits the mission in place.

## Server side

The companion command lives in the server plugin (the separate **RustSkengServer**
repo, `oxide/plugins/BYAplugin.cs`):

```
bya.admin missions import <base64 of a BYAMissionDef JSON>
```

It decodes (standard or url-safe base64), deserializes into `BYAMissionDef`, and
upserts it into the catalog (scrubbing profiles + bumping the tracker version so
edits reconcile). Every field round-trips, so anything the app can express on a
mission, the server accepts.

## Layout

| File | Role |
|------|------|
| `Program.cs` / `MainForm.cs` | WinForms entry + WebView2 host + RPC dispatch |
| `Steam.cs` | Workshop collection/detail client (no API key) |
| `ImageCache.cs` | one-time preview-image download cache |
| `ShortnameMap.cs` | Workshop-tag → Rust item shortname suggestions |
| `Store.cs` / `Paths.cs` | library persistence + app-data paths |
| `Models.cs` | mirror of the plugin mission models + local library model |
| `wwwroot/` | the web UI (`index.html`, `styles.css`, `app.js`) |
