"use strict";

// ── RPC bridge to the C# host (WebMessage request/response) ──────────────
const _pending = new Map();
let _seq = 0;
window.chrome.webview.addEventListener("message", (e) => {
  const m = e.data;
  const p = _pending.get(m.id);
  if (!p) return;
  _pending.delete(m.id);
  if (m.ok) p.resolve(m.result);
  else p.reject(new Error(m.error || "host error"));
});
function call(method, args = {}) {
  return new Promise((resolve, reject) => {
    const id = "r" + ++_seq;
    _pending.set(id, { resolve, reject });
    window.chrome.webview.postMessage({ id, method, args });
  });
}

// ── state ────────────────────────────────────────────────────────────────
let lib = { groups: [], skins: [] };
let activeGroup = "all";
let query = "";
let missions = null;          // { path, missions:[], skinUsage:{id:[keys]} }
let selectedId = null;
let saveTimer = null;
const CACHE = "https://cache.skin/";

// ── helpers ────────────────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

function toast(msg, bad) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (bad ? " bad" : "");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), 2600);
}
function busy(on, text) {
  $("#busyText").textContent = text || "Working…";
  $("#busy").classList.toggle("hidden", !on);
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => call("saveLibrary", { library: lib }).catch(() => {}), 250);
}
function uid(p) { return p + Math.random().toString(36).slice(2, 8); }
function groupById(id) { return lib.groups.find((g) => g.id === id); }
function usage(id) { return (missions && missions.skinUsage && missions.skinUsage[id]) || []; }
function imgFor(s) { return CACHE + encodeURIComponent(s.id) + ".jpg"; }
function skincreate(s) { return `/skincreate ${s.shortname || "<shortname>"} ${s.id}`; }
function slug(t) {
  return "skin_" + (t || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "skin_" + uid("");
}

// ── render: groups sidebar ───────────────────────────────────────────────
function renderGroups() {
  const ul = $("#groupList");
  ul.innerHTML = "";
  const mk = (id, name, color, count) => {
    const li = el("li");
    if (id === activeGroup) li.classList.add("active");
    const dot = el("span", "dot"); dot.style.background = color || "transparent";
    if (!color) dot.style.boxShadow = "inset 0 0 0 1px var(--border)";
    li.append(dot, el("span", "gname", name), el("span", "gcount", String(count)));
    li.onclick = () => { activeGroup = id; renderGroups(); renderGrid(); };
    if (id !== "all" && id !== "ungrouped") {
      li.ondblclick = () => editGroup(id);
      li.title = "Double-click to rename / recolor / delete";
    }
    ul.append(li);
  };
  mk("all", "All skins", "", lib.skins.length);
  const ungrouped = lib.skins.filter((s) => !s.groupId || !groupById(s.groupId)).length;
  if (ungrouped) mk("ungrouped", "Ungrouped", "", ungrouped);
  for (const g of lib.groups)
    mk(g.id, g.name, g.color, lib.skins.filter((s) => s.groupId === g.id).length);

  // group <select> in the add bar — default is "Ungrouped" (value ""),
  // "+ New group…" goes last so a plain Add never hijacks into a prompt.
  const sel = $("#srcGroup");
  const prev = sel.value;
  sel.innerHTML = "";
  const optNone = el("option", null, "Ungrouped"); optNone.value = ""; sel.append(optNone);
  for (const g of lib.groups) { const o = el("option", null, g.name); o.value = g.id; sel.append(o); }
  const optNew = el("option", null, "+ New group…"); optNew.value = "__new"; sel.append(optNew);
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;

  $("#statSkins").textContent = lib.skins.length;
  $("#statGroups").textContent = lib.groups.length;
}

// ── render: skin grid ────────────────────────────────────────────────────
function visibleSkins() {
  const q = query.trim().toLowerCase();
  return lib.skins.filter((s) => {
    if (activeGroup === "ungrouped") { if (s.groupId && groupById(s.groupId)) return false; }
    else if (activeGroup !== "all" && s.groupId !== activeGroup) return false;
    if (!q) return true;
    return (s.title || "").toLowerCase().includes(q)
      || (s.shortname || "").toLowerCase().includes(q)
      || s.id.includes(q)
      || (s.tags || []).some((t) => t.toLowerCase().includes(q));
  });
}

function renderGrid() {
  const grid = $("#grid");
  grid.innerHTML = "";
  const list = visibleSkins();
  $("#empty").classList.toggle("hidden", lib.skins.length !== 0);
  const missingImg = [];

  for (const s of list) {
    const tile = el("div", "tile");
    if (s.id === selectedId) tile.classList.add("sel");
    tile.onclick = () => openDetail(s.id);

    const thumb = el("div", "thumb");
    const img = el("img");
    img.loading = "lazy";
    img.src = imgFor(s);
    img.onerror = () => { img.remove(); thumb.textContent = "no preview"; };
    thumb.append(img);
    if (!s.cached && s.previewUrl) missingImg.push({ id: s.id, url: s.previewUrl });

    const meta = el("div", "meta");
    meta.append(el("div", "ttl", s.title || "(untitled)"));

    const row = el("div", "row");
    const sn = el("span", "badge sn" + (s.shortname ? (s.shortnameAuto ? " auto" : "") : " none"),
      s.shortname || "no shortname");
    sn.title = s.shortname ? (s.shortnameAuto ? "Auto-suggested — click skin to confirm" : "shortname") : "Set a shortname (needed for /skincreate + skin rewards)";
    row.append(sn);
    const u = usage(s.id);
    if (u.length) { const b = el("span", "badge used", "✓ " + u.length); b.title = "Used in: " + u.join(", "); row.append(b); }
    if (s.banned) row.append(el("span", "badge banned", "banned"));

    const copy = el("button", "mini ghost", "copy");
    copy.title = skincreate(s);
    copy.onclick = (ev) => { ev.stopPropagation(); call("copy", { text: skincreate(s) }); toast("Copied " + skincreate(s)); };
    row.append(copy);

    meta.append(row);
    tile.append(thumb, meta);
    grid.append(tile);
  }

  if (missingImg.length) ensureImages(missingImg);
}

async function ensureImages(items) {
  try {
    const res = await call("ensureImages", { items });
    const set = new Set(res.cached || []);
    if (!set.size) return;
    for (const s of lib.skins) if (set.has(s.id)) s.cached = true;
    save();
    // refresh just the now-cached tiles' images
    renderGrid();
  } catch {}
}

// ── detail panel ─────────────────────────────────────────────────────────
function openDetail(id) {
  selectedId = id;
  const s = lib.skins.find((x) => x.id === id);
  if (!s) return;
  renderGrid();
  const d = $("#detailBody");
  d.innerHTML = "";

  const big = el("img", "big");
  big.src = imgFor(s);
  big.onerror = () => { big.replaceWith(el("div", "big")); };
  d.append(big);
  d.append(el("h2", null, s.title || "(untitled)"));
  d.append(el("div", "tagline", "id " + s.id + (s.tags && s.tags.length ? "  ·  tags: " + s.tags.join(", ") : "")));

  // shortname editor
  const f1 = el("div", "field");
  f1.append(Object.assign(el("label"), { textContent: "ITEM SHORTNAME (for /skincreate + skin reward)" }));
  const c1 = el("div", "ctl");
  const inp = el("input"); inp.value = s.shortname || ""; inp.placeholder = "e.g. rifle.ak";
  inp.onchange = () => { s.shortname = inp.value.trim(); s.shortnameAuto = false; save(); renderGrid(); openDetail(id); };
  c1.append(inp); f1.append(c1);
  if (s.shortnameAuto && s.shortname) f1.append(Object.assign(el("p", "note"), { textContent: "Auto-suggested from tags — edit to confirm." }));
  d.append(f1);

  // group mover
  const f2 = el("div", "field");
  f2.append(Object.assign(el("label"), { textContent: "GROUP" }));
  const c2 = el("div", "ctl");
  const gs = el("select");
  gs.append(Object.assign(el("option"), { value: "", textContent: "— ungrouped —" }));
  for (const g of lib.groups) gs.append(Object.assign(el("option"), { value: g.id, textContent: g.name }));
  gs.value = s.groupId || "";
  gs.onchange = () => { s.groupId = gs.value || null; save(); renderGroups(); renderGrid(); };
  c2.append(gs); f2.append(c2); d.append(f2);

  // /skincreate command
  const cmdF = el("div", "field");
  cmdF.append(Object.assign(el("label"), { textContent: "PREVIEW IN-GAME (/skincreate)" }));
  const cmd = el("div", "cmd");
  const code = el("code", null, skincreate(s));
  const cbtn = el("button", "primary", "Copy");
  cbtn.onclick = () => { call("copy", { text: skincreate(s) }); toast("Copied to clipboard"); };
  cmd.append(code, cbtn); cmdF.append(cmd);
  cmdF.append(Object.assign(el("p", "note"), { textContent: "Paste in the F1 console in-game to preview. (/skinapply " + s.id + " skins the held item instead.)" }));
  d.append(cmdF);

  // usage
  const u = usage(s.id);
  if (missions) {
    const uf = el("div", "field");
    uf.append(Object.assign(el("label"), { textContent: "USED IN MISSIONS" }));
    uf.append(u.length ? Object.assign(el("div", "usedlist"), { textContent: u.join(", ") })
                       : Object.assign(el("div", "muted"), { textContent: "not used yet" }));
    d.append(uf);
  }

  // actions
  const acts = el("div", "field");
  const gen = el("button", "primary", "Create mission from this skin →");
  gen.style.width = "100%";
  gen.onclick = () => openGen(s);
  acts.append(gen);
  const wl = el("button", "ghost", "Open workshop page");
  wl.style.cssText = "width:100%;margin-top:8px";
  wl.onclick = () => call("openExternal", { url: "https://steamcommunity.com/sharedfiles/filedetails/?id=" + s.id });
  acts.append(wl);
  const del = el("button", "ghost danger", "Remove from library");
  del.style.cssText = "width:100%;margin-top:8px";
  del.onclick = () => { if (confirm("Remove this skin from the library?")) { lib.skins = lib.skins.filter((x) => x.id !== id); selectedId = null; save(); closeDetail(); renderGroups(); renderGrid(); } };
  acts.append(del);
  d.append(acts);

  $("#detail").classList.remove("hidden");
}
function closeDetail() { $("#detail").classList.add("hidden"); selectedId = null; renderGrid(); }

// ── mission generator ────────────────────────────────────────────────────
function openGen(s) {
  const b = $("#genBody");
  b.innerHTML = "";

  // reward preview (this skin) + optional xp
  const rl = el("div", "reward-line");
  const ico = el("img", "ico"); ico.src = imgFor(s); ico.onerror = () => ico.remove();
  rl.append(ico, Object.assign(el("div"), { innerHTML: `<b>Skin reward</b><br><span class="muted">${s.title || s.id} → ${s.shortname || "<set shortname!>"}</span>` }));
  b.append(rl);

  const titleF = el("div", "field");
  titleF.append(Object.assign(el("label"), { textContent: "MISSION TITLE" }));
  const titleI = el("input"); titleI.placeholder = "e.g. Whiteout Warrior"; titleF.append(titleI);
  b.append(titleF);

  const row = el("div", "gen-row");
  const keyF = el("div", "field");
  keyF.append(Object.assign(el("label"), { textContent: "KEY (unique id)" }));
  const keyI = el("input"); keyI.placeholder = "auto from title"; keyF.append(keyI);
  let keyEdited = false; keyI.oninput = () => keyEdited = true;
  titleI.oninput = () => { if (!keyEdited) keyI.value = slug(titleI.value); };
  const typeF = el("div", "field");
  typeF.append(Object.assign(el("label"), { textContent: "TYPE" }));
  const typeS = el("select");
  for (const t of ["standard", "daily", "weekly", "secondary"]) typeS.append(Object.assign(el("option"), { value: t, textContent: t }));
  typeF.append(typeS);
  row.append(keyF, typeF); b.append(row);

  // optional extra XP reward
  const xpF = el("div", "field");
  xpF.append(Object.assign(el("label"), { textContent: "BONUS XP (optional)" }));
  const xpI = el("input"); xpI.type = "number"; xpI.min = "0"; xpI.placeholder = "0"; xpF.append(xpI);
  b.append(xpF);

  // trigger
  const trF = el("div", "field");
  trF.append(Object.assign(el("label"), { textContent: "TRIGGER" }));
  const trRow = el("div", "gen-row");
  const trS = el("select");
  [["none", "None (set triggers in-game)"], ["kill_total", "Kills (total)"], ["match_win", "Wins"], ["custom", "Custom tracker key…"]]
    .forEach(([v, t]) => trS.append(Object.assign(el("option"), { value: v, textContent: t })));
  const trN = el("input"); trN.type = "number"; trN.min = "1"; trN.value = "10"; trN.style.maxWidth = "90px";
  const trCustom = el("input"); trCustom.placeholder = "e.g. kill_class:smg@t2"; trCustom.classList.add("hidden");
  trRow.append(trS, trN, trCustom); trF.append(trRow);
  trS.onchange = () => {
    const isNone = trS.value === "none";
    trN.classList.toggle("hidden", isNone);
    trCustom.classList.toggle("hidden", trS.value !== "custom");
  };
  trS.onchange();
  b.append(trF);
  b.append(Object.assign(el("p", "note"), { textContent: "Custom uses the full tracker grammar (@tN tier, @mode/@queue, @map/@mapgroup, @air, @hs via _hs)." }));

  // output
  const out = el("div", "field");
  out.append(Object.assign(el("label"), { textContent: "IMPORT COMMAND" }));
  const cmd = el("div", "cmd");
  const code = el("code", null, "— fill the form, then Generate —");
  const copyBtn = el("button", "primary", "Copy"); copyBtn.disabled = true;
  cmd.append(code, copyBtn); out.append(cmd);
  out.append(Object.assign(el("p", "note"), { textContent: "Paste in the F1 console in-game (admin). Re-importing the same key edits in place." }));
  b.append(out);

  const genBtn = el("button", "primary", "Generate command");
  genBtn.style.cssText = "width:100%;margin-top:8px";
  genBtn.onclick = async () => {
    const title = titleI.value.trim();
    if (!title) return toast("Title is required", true);
    if (!s.shortname) return toast("Set this skin's shortname first", true);
    const key = (keyI.value.trim() || slug(title));
    const def = {
      Key: key, Title: title, Type: typeS.value,
      Rewards: [{ Type: "skin", Target: s.id, ItemShortname: s.shortname }],
      Trackers: [],
    };
    const xp = parseInt(xpI.value, 10);
    if (xp > 0) def.Rewards.push({ Type: "xp", Target: String(xp) });
    if (trS.value !== "none") {
      const tk = trS.value === "custom" ? trCustom.value.trim() : trS.value;
      if (!tk) return toast("Enter a custom tracker key", true);
      def.Trackers.push({ Key: tk, Threshold: Math.max(1, parseInt(trN.value, 10) || 1) });
    }
    try {
      const res = await call("buildImportCommand", { def });
      code.textContent = res.command;
      copyBtn.disabled = false;
      copyBtn.onclick = () => { call("copy", { text: res.command }); toast("Command copied"); };
      toast("Generated (" + res.length + " b64 chars)");
    } catch (e) { toast(e.message, true); }
  };
  b.append(genBtn);

  $("#genModal").classList.remove("hidden");
}
function closeGen() { $("#genModal").classList.add("hidden"); }

// ── add source flow ──────────────────────────────────────────────────────
async function addSource() {
  const input = $("#srcInput").value.trim();
  if (!input) return;
  let groupId = $("#srcGroup").value;
  if (groupId === "__new") { const g = newGroup(); if (!g) return; groupId = g.id; }

  busy(true, "Resolving workshop…");
  try {
    const res = await call("addSource", { input });
    busy(false);
    if (!res.skins.length) return toast("Nothing found (private/removed item?)", true);
    let added = 0, updated = 0;
    for (const ns of res.skins) {
      const ex = lib.skins.find((x) => x.id === ns.id);
      if (ex) { ex.title = ns.title; ex.tags = ns.tags; ex.previewUrl = ns.previewUrl; ex.cached = ns.cached; ex.banned = ns.banned; if (!ex.shortname) { ex.shortname = ns.shortname; ex.shortnameAuto = ns.shortnameAuto; } if (groupId) ex.groupId = groupId; updated++; }
      else { ns.groupId = groupId || null; lib.skins.push(ns); added++; }
    }
    save(); renderGroups(); renderGrid();
    $("#srcInput").value = "";
    toast(`${res.isCollection ? "Collection" : "Item"}: +${added} new, ${updated} updated`);
  } catch (e) { busy(false); toast(e.message, true); }
}

// ── groups CRUD ──────────────────────────────────────────────────────────
const PALETTE = ["#c9a54c", "#7ac070", "#5a9bd4", "#d97aa0", "#b07ad9", "#d98b5a", "#5ad9c2", "#d95a5a"];
function newGroup() {
  const name = prompt("New group name:");
  if (!name) return null;
  const g = { id: uid("g_"), name: name.trim(), color: PALETTE[lib.groups.length % PALETTE.length] };
  lib.groups.push(g); save(); renderGroups();
  $("#srcGroup").value = g.id;
  return g;
}
function editGroup(id) {
  const g = groupById(id); if (!g) return;
  const name = prompt("Rename group (clear + OK to delete):", g.name);
  if (name === null) return;
  if (name.trim() === "") {
    if (!confirm(`Delete group "${g.name}"? Skins become ungrouped.`)) return;
    lib.skins.forEach((s) => { if (s.groupId === id) s.groupId = null; });
    lib.groups = lib.groups.filter((x) => x.id !== id);
    if (activeGroup === id) activeGroup = "all";
  } else {
    g.name = name.trim();
  }
  save(); renderGroups(); renderGrid();
}

// ── missions cross-ref ───────────────────────────────────────────────────
async function loadMissions() {
  busy(true, "Reading missions…");
  try {
    const res = await call("loadMissions", {});
    busy(false);
    if (res.cancelled) return;
    missions = res;
    $("#missionState").textContent = `${res.count} missions · ${Object.keys(res.skinUsage || {}).length} skins used`;
    $("#missionState").title = res.path;
    renderGrid();
    toast("Loaded " + res.count + " missions");
  } catch (e) { busy(false); toast(e.message, true); }
}

// ── wire-up ──────────────────────────────────────────────────────────────
$("#srcAdd").onclick = addSource;
$("#srcInput").addEventListener("keydown", (e) => { if (e.key === "Enter") addSource(); });
$("#search").addEventListener("input", (e) => { query = e.target.value; renderGrid(); });
$("#addGroup").onclick = () => newGroup();
$("#loadMissions").onclick = loadMissions;
$("#detailClose").onclick = closeDetail;
$("#genClose").onclick = closeGen;
$("#genModal").addEventListener("click", (e) => { if (e.target.id === "genModal") closeGen(); });
$("#srcGroup").addEventListener("change", (e) => { if (e.target.value === "__new") { const g = newGroup(); if (!g) e.target.value = ""; } });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeGen(); if (!$("#genModal").classList.contains("hidden")) return; closeDetail(); } });

// ── boot ─────────────────────────────────────────────────────────────────
(async function boot() {
  try {
    lib = await call("loadLibrary");
    lib.groups = lib.groups || [];
    lib.skins = lib.skins || [];
  } catch { lib = { groups: [], skins: [] }; }
  renderGroups();
  renderGrid();
})();
