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
let activeType = "all";
let query = "";
let missions = null;          // { path, missions:[], skinUsage:{id:[keys]} }
let selectedId = null;
const selected = new Set();    // bulk-select set of skin ids
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
function applyZoom(px) { $("#grid").style.setProperty("--tile", px + "px"); }

// ── item-type classifier (from shortname) for the type filter ────────────
const TYPE_DEFS = [
  ["rifle", "Rifles"], ["smg", "SMGs"], ["pistol", "Pistols"], ["shotgun", "Shotguns"],
  ["lmg", "LMGs"], ["bow", "Bows"], ["explosive", "Explosives"], ["melee", "Melee/Tools"],
  ["clothing", "Clothing"], ["deployable", "Deployables"], ["other", "Other"],
];
const CLOTHING = new Set([
  "ballistic.helmet", "metal.facemask", "coffeecan.helmet", "wood.armor.helmet", "knightsarmour.helmet",
  "hat.wolf", "bucket.helmet", "deer.skull.mask", "nightvisiongoggles", "ballistic.vest", "metal.plate.torso",
  "roadsign.jacket", "jacket", "wood.armor.jacket", "attire.hide.poncho", "jacket.snow", "draculacape",
  "knighttorso.armour", "hoodie", "tshirt", "burlap.shirt", "tanktop", "attire.hide.helterneck", "tactical.gloves",
  "roadsign.gloves", "burlap.gloves", "woodarmor.gloves", "burlap.gloves.new", "ballistic.legarmor", "roadsign.kilt",
  "knightsarmour.skirt", "wood.armor.pants", "chicken.costume", "horse.costume", "pants", "burlap.trousers",
  "pants.shorts", "attire.hide.pants", "attire.hide.skirt", "shoes.boots", "attire.hide.boots", "boots.frog",
  "burlap.shoes", "hazmatsuit", "hazmatsuit.nomadsuit", "hazmatsuit.lumberjack", "hazmatsuit.arcticsuit",
  "ninjasuit", "attire.egg.suit",
]);
function typeOf(s) {
  const sn = (s.shortname || "").toLowerCase();
  if (!sn) return "other";
  if (CLOTHING.has(sn)) return "clothing";
  if (sn.startsWith("rifle.")) return "rifle";
  if (sn.startsWith("smg.")) return "smg";
  if (sn.startsWith("pistol.")) return "pistol";
  if (sn.startsWith("shotgun.")) return "shotgun";
  if (sn.startsWith("lmg.")) return "lmg";
  if (sn.startsWith("bow.") || sn === "crossbow") return "bow";
  if (sn.startsWith("rocket.") || sn.startsWith("grenade.") || sn.startsWith("explosive.") || sn === "multiplegrenadelauncher") return "explosive";
  if (sn.startsWith("knife.") || sn.startsWith("salvaged.") || sn.startsWith("axe.") || sn.startsWith("icepick.") ||
      ["machete", "hatchet", "pickaxe", "stonehatchet", "stone.pickaxe", "rock", "jackhammer", "chainsaw", "mace", "longsword", "torch"].includes(sn)) return "melee";
  if (sn.startsWith("box.") || sn.startsWith("door.") || sn.startsWith("furnace") || sn.startsWith("cupboard.") ||
      sn.startsWith("wall.frame.") || ["vending.machine", "locker", "target.reactive", "fridge", "sleepingbag", "rug"].includes(sn)) return "deployable";
  if (sn.startsWith("hat.") || sn.endsWith(".helmet") || sn.endsWith(".facemask") || sn.startsWith("mask.") ||
      sn.startsWith("burlap.") || sn.startsWith("roadsign.") || sn.startsWith("jacket.") || sn.startsWith("shoes.") ||
      sn.startsWith("diving.") || sn.startsWith("attire.") || sn.startsWith("tshirt") ||
      ["hoodie", "pants", "shorts", "metal.plate.torso"].includes(sn)) return "clothing";
  return "other";
}
function inGroup(s) {
  if (activeGroup === "ungrouped") return !s.groupId || !groupById(s.groupId);
  if (activeGroup === "all") return true;
  return s.groupId === activeGroup;
}
function renderAll() { renderGroups(); renderTypeBar(); renderGrid(); renderBulkBar(); }

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
    li.onclick = () => { activeGroup = id; renderGroups(); renderTypeBar(); renderGrid(); };
    if (id !== "all" && id !== "ungrouped") {
      li.ondblclick = () => openGroupManager(id);
      li.title = "Double-click to manage (rename / recolor / reorder / delete)";
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
    if (!inGroup(s)) return false;
    if (activeType !== "all" && typeOf(s) !== activeType) return false;
    if (!q) return true;
    return (s.title || "").toLowerCase().includes(q)
      || (s.shortname || "").toLowerCase().includes(q)
      || s.id.includes(q)
      || (s.tags || []).some((t) => t.toLowerCase().includes(q));
  });
}

// type-filter chips above the grid. Counts are computed over the active group
// (ignoring the type + search filters) so the bar is stable while you type.
function renderTypeBar() {
  const bar = $("#typebar");
  bar.innerHTML = "";
  const set = lib.skins.filter(inGroup);
  if (!set.length) { bar.classList.add("hidden"); return; }
  const counts = {};
  for (const s of set) { const t = typeOf(s); counts[t] = (counts[t] || 0) + 1; }
  if (activeType !== "all" && !counts[activeType]) activeType = "all";  // stale -> reset
  bar.classList.remove("hidden");
  const chip = (key, label, count) => {
    const c = el("button", "tchip" + (activeType === key ? " active" : ""));
    c.append(el("span", "tl", label), el("span", "tc", String(count)));
    c.onclick = () => { activeType = key; renderTypeBar(); renderGrid(); };
    bar.append(c);
  };
  chip("all", "All", set.length);
  for (const [k, label] of TYPE_DEFS) if (counts[k]) chip(k, label, counts[k]);
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
    if (selected.has(s.id)) tile.classList.add("checked");
    tile.onclick = () => openDetail(s.id);

    const chk = el("input", "tcheck");
    chk.type = "checkbox";
    chk.checked = selected.has(s.id);
    chk.title = "Select for bulk actions";
    chk.onclick = (ev) => { ev.stopPropagation(); toggleSelect(s.id); };
    tile.append(chk);

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

// ── bulk selection ───────────────────────────────────────────────────────
function toggleSelect(id) {
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  renderGrid(); renderBulkBar();
}
function renderBulkBar() {
  const bar = $("#bulkbar");
  bar.innerHTML = "";
  if (!selected.size) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  bar.append(el("span", "bcount", selected.size + " selected"));

  const sel = el("select");
  sel.append(Object.assign(el("option"), { value: "", textContent: "Move to…" }));
  sel.append(Object.assign(el("option"), { value: "__ungroup", textContent: "Ungrouped" }));
  for (const g of lib.groups) sel.append(Object.assign(el("option"), { value: g.id, textContent: g.name }));
  sel.onchange = () => {
    if (!sel.value) return;
    const gid = sel.value === "__ungroup" ? null : sel.value;
    let n = 0;
    for (const s of lib.skins) if (selected.has(s.id)) { s.groupId = gid; n++; }
    save(); selected.clear(); renderAll();
    toast(`Moved ${n} skin(s) ${gid ? "to " + (groupById(gid)?.name || "group") : "to ungrouped"}`);
  };
  bar.append(sel);

  const clear = el("button", "ghost", "Clear");
  clear.onclick = () => { selected.clear(); renderGrid(); renderBulkBar(); };
  bar.append(clear);

  const del = el("button", "ghost danger", "Delete");
  del.onclick = () => {
    if (!confirm(`Remove ${selected.size} selected skin(s) from the library?`)) return;
    lib.skins = lib.skins.filter((s) => !selected.has(s.id));
    selected.clear(); save(); renderAll();
  };
  bar.append(del);
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
  inp.onchange = () => { s.shortname = inp.value.trim(); s.shortnameAuto = false; save(); renderAll(); openDetail(id); };
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
  gs.onchange = () => { s.groupId = gs.value || null; save(); renderAll(); };
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
  del.onclick = () => { if (confirm("Remove this skin from the library?")) { lib.skins = lib.skins.filter((x) => x.id !== id); selectedId = null; save(); $("#detail").classList.add("hidden"); renderAll(); } };
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
    const res = await call("addSource", { input, catalogFilter: $("#catalogFilter").checked });
    busy(false);
    if (!res.skins.length)
      return toast(res.dropped ? `All ${res.dropped} skin(s) were off-catalog (filter on)` : "Nothing found (private/removed item?)", true);
    let added = 0, updated = 0;
    for (const ns of res.skins) {
      const ex = lib.skins.find((x) => x.id === ns.id);
      if (ex) { ex.title = ns.title; ex.tags = ns.tags; ex.previewUrl = ns.previewUrl; ex.cached = ns.cached; ex.banned = ns.banned; if (!ex.shortname) { ex.shortname = ns.shortname; ex.shortnameAuto = ns.shortnameAuto; } if (groupId) ex.groupId = groupId; updated++; }
      else { ns.groupId = groupId || null; lib.skins.push(ns); added++; }
    }
    save(); renderAll();
    $("#srcInput").value = "";
    if (res.dropped) console.log("Dropped (off-catalog):", res.droppedTitles);
    toast(`${res.isCollection ? "Collection" : "Item"}: +${added} new, ${updated} updated`
      + (res.dropped ? ` · ${res.dropped} off-catalog dropped` : ""));
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
// Full group manager modal: rename, recolor, reorder, delete + add.
let gmFocus = null;
function openGroupManager(focusId) { gmFocus = focusId || null; renderGroupManager(); $("#groupModal").classList.remove("hidden"); }
function closeGroupManager() { $("#groupModal").classList.add("hidden"); gmFocus = null; }
function renderGroupManager() {
  const body = $("#groupModalBody");
  body.innerHTML = "";
  if (!lib.groups.length)
    body.append(Object.assign(el("p", "muted"), { textContent: "No groups yet — add one below." }));

  lib.groups.forEach((g, idx) => {
    const row = el("div", "grow");

    const sw = el("div", "swatches");
    for (const col of PALETTE) {
      const b = el("button", "sw" + (g.color === col ? " on" : ""));
      b.style.background = col;
      b.title = col;
      b.onclick = () => { g.color = col; save(); renderGroupManager(); renderGroups(); renderGrid(); };
      sw.append(b);
    }

    const name = el("input", "gname-in");
    name.value = g.name;
    name.onchange = () => { g.name = (name.value.trim() || g.name); save(); renderGroups(); };
    if (gmFocus === g.id) setTimeout(() => { name.focus(); name.select(); }, 0);

    const cnt = el("span", "gcnt", lib.skins.filter((s) => s.groupId === g.id).length + " skins");

    const up = el("button", "gbtn", "↑"); up.disabled = idx === 0;
    up.onclick = () => { [lib.groups[idx - 1], lib.groups[idx]] = [lib.groups[idx], lib.groups[idx - 1]]; save(); renderGroupManager(); renderGroups(); };
    const dn = el("button", "gbtn", "↓"); dn.disabled = idx === lib.groups.length - 1;
    dn.onclick = () => { [lib.groups[idx + 1], lib.groups[idx]] = [lib.groups[idx], lib.groups[idx + 1]]; save(); renderGroupManager(); renderGroups(); };

    const del = el("button", "gbtn danger", "✕");
    del.title = "Delete group (its skins become ungrouped)";
    del.onclick = () => {
      const n = lib.skins.filter((s) => s.groupId === g.id).length;
      if (!confirm(`Delete "${g.name}"?` + (n ? ` ${n} skin(s) become ungrouped.` : ""))) return;
      lib.skins.forEach((s) => { if (s.groupId === g.id) s.groupId = null; });
      lib.groups = lib.groups.filter((x) => x.id !== g.id);
      if (activeGroup === g.id) activeGroup = "all";
      save(); renderGroupManager(); renderAll();
    };

    row.append(sw, name, cnt, up, dn, del);
    body.append(row);
  });

  const add = el("button", "primary", "+ Add group");
  add.style.cssText = "width:100%;margin-top:12px";
  add.onclick = () => {
    const g = { id: uid("g_"), name: "New group", color: PALETTE[lib.groups.length % PALETTE.length] };
    lib.groups.push(g); gmFocus = g.id; save(); renderGroupManager(); renderGroups();
  };
  body.append(add);
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
$("#zoom").addEventListener("input", (e) => { applyZoom(e.target.value); localStorage.setItem("zoom", e.target.value); });
$("#catalogFilter").addEventListener("change", (e) => localStorage.setItem("catalogFilter", e.target.checked));
$("#selectAll").onclick = () => {
  const vis = visibleSkins();
  const allSel = vis.length && vis.every((s) => selected.has(s.id));
  vis.forEach((s) => allSel ? selected.delete(s.id) : selected.add(s.id));
  renderGrid(); renderBulkBar();
};
$("#addGroup").onclick = () => newGroup();
$("#manageGroups").onclick = () => openGroupManager();
$("#groupModalClose").onclick = closeGroupManager;
$("#groupModal").addEventListener("click", (e) => { if (e.target.id === "groupModal") closeGroupManager(); });
$("#loadMissions").onclick = loadMissions;
$("#detailClose").onclick = closeDetail;
$("#genClose").onclick = closeGen;
$("#genModal").addEventListener("click", (e) => { if (e.target.id === "genModal") closeGen(); });
$("#srcGroup").addEventListener("change", (e) => { if (e.target.value === "__new") { const g = newGroup(); if (!g) e.target.value = ""; } });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("#groupModal").classList.contains("hidden")) { closeGroupManager(); return; }
  if (!$("#genModal").classList.contains("hidden")) { closeGen(); return; }
  if (!$("#detail").classList.contains("hidden")) { closeDetail(); return; }
  if (selected.size) { selected.clear(); renderGrid(); renderBulkBar(); }
});

// ── boot ─────────────────────────────────────────────────────────────────
(async function boot() {
  try {
    lib = await call("loadLibrary");
    lib.groups = lib.groups || [];
    lib.skins = lib.skins || [];
  } catch { lib = { groups: [], skins: [] }; }
  // restore UI prefs (localStorage persists per-origin in the WebView2 profile)
  const z = parseInt(localStorage.getItem("zoom") || "158", 10);
  $("#zoom").value = z; applyZoom(z);
  const cf = localStorage.getItem("catalogFilter");
  $("#catalogFilter").checked = (cf === null) ? true : (cf === "true");
  renderAll();
})();
