"""BYA map thumbnail manager.

Two-pane Windows tool. Top pane = ShareX inbox (raw captures awaiting a
proper name). Bottom pane = already-uploaded thumbnails in maptn/.

Naming an inbox image kicks the full pipeline in one click:
  copy → maptn/<name>.png → git add → commit → push → copy jsDelivr URL.

Stdlib only — tkinter, subprocess, urllib, shutil. No pip installs.
Lives at the repo root next to maptn/. Double-click to launch via the
pythonw.exe association for .pyw files.
"""
import ctypes
import json
import os
import re
import shutil
import subprocess
import threading
import time
import tkinter as tk
from ctypes import wintypes
from datetime import datetime
from pathlib import Path
from tkinter import filedialog, messagebox, simpledialog, ttk
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

REPO_DIR    = Path(__file__).resolve().parent
THUMBS_DIR  = REPO_DIR / "maptn"
MAPS_DIR    = REPO_DIR / "maps"
CONFIG_PATH = REPO_DIR / "manage.config.json"
PERF_WARN_BYTES = 100 * 1024
NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")

DEFAULT_SHAREX_DIR = Path(os.environ.get("USERPROFILE", "")) / "Documents" / "ShareX" / "Screenshots"


# ─── recycle bin (Windows-only) ──────────────────────────────────────────────
# stdlib via SHFileOperationW so we don't need send2trash. FOF_ALLOWUNDO is
# the flag that routes the delete through the recycle bin rather than the
# permanent-delete path — without it this would be equivalent to Path.unlink.

class _SHFILEOPSTRUCTW(ctypes.Structure):
    _fields_ = [
        ("hwnd",                  wintypes.HWND),
        ("wFunc",                 wintypes.UINT),
        ("pFrom",                 wintypes.LPCWSTR),
        ("pTo",                   wintypes.LPCWSTR),
        ("fFlags",                ctypes.c_ushort),
        ("fAnyOperationsAborted", wintypes.BOOL),
        ("hNameMappings",         wintypes.LPVOID),
        ("lpszProgressTitle",     wintypes.LPCWSTR),
    ]

_FO_DELETE         = 0x0003
_FOF_ALLOWUNDO     = 0x0040
_FOF_NOCONFIRMATION = 0x0010
_FOF_SILENT        = 0x0004
_FOF_NOERRORUI     = 0x0400


def recycle(path):
    """Send a file to the Windows Recycle Bin. Raises OSError on failure."""
    # SHFileOperationW expects a double-null-terminated string for pFrom.
    p = str(Path(path).resolve()) + "\0\0"
    op = _SHFILEOPSTRUCTW(
        hwnd=None, wFunc=_FO_DELETE, pFrom=p, pTo=None,
        fFlags=_FOF_ALLOWUNDO | _FOF_NOCONFIRMATION | _FOF_SILENT | _FOF_NOERRORUI,
        fAnyOperationsAborted=False, hNameMappings=None, lpszProgressTitle=None,
    )
    rc = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    if rc != 0:
        raise OSError(f"SHFileOperationW returned {rc} for {path}")


# ─── config ──────────────────────────────────────────────────────────────────

def load_config():
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_config(cfg):
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


# ─── git plumbing ────────────────────────────────────────────────────────────

def run_git(*args, timeout=30):
    try:
        r = subprocess.run(
            ["git", *args],
            cwd=REPO_DIR,
            capture_output=True,
            text=True,
            timeout=timeout,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        return r.returncode, (r.stdout + r.stderr).strip()
    except FileNotFoundError:
        return -1, "git is not on PATH"
    except subprocess.TimeoutExpired:
        return -1, "git command timed out"


def parse_remote():
    rc, out = run_git("remote", "get-url", "origin")
    if rc != 0:
        return None
    m = re.search(r"github\.com[:/]([^/]+)/([^/.\s]+)", out)
    return (m.group(1), m.group(2)) if m else None


def file_sync_status(rel_path):
    rc, out = run_git("status", "--porcelain", "--", rel_path)
    if rc != 0 or not out:
        return "clean"
    code = out[:2]
    if "?" in code:
        return "untracked"
    if "A" in code:
        return "staged"
    return "modified"


def ahead_behind():
    rc, _ = run_git("rev-parse", "--abbrev-ref", "@{u}")
    if rc != 0:
        return "no upstream yet"
    rc, out = run_git("rev-list", "--left-right", "--count", "@{u}...HEAD")
    if rc != 0:
        return ""
    try:
        behind, ahead = (int(n) for n in out.split())
    except ValueError:
        return ""
    if ahead and behind: return f"diverged ↑{ahead} ↓{behind}"
    if ahead:            return f"↑ ahead by {ahead}"
    if behind:           return f"↓ behind by {behind}"
    return "up to date"


# ─── jsDelivr URLs ───────────────────────────────────────────────────────────

def jsdelivr_url(user, repo, filename):
    return f"https://cdn.jsdelivr.net/gh/{user}/{repo}@main/maptn/{filename}"


def purge_url(user, repo, filename):
    return f"https://purge.jsdelivr.net/gh/{user}/{repo}@main/maptn/{filename}"


def raw_map_url(user, repo, filename):
    """Direct GitHub raw URL for .map files. Bypassing jsDelivr's CDN here
    is intentional — .map files are large one-shot downloads at server
    boot, not high-frequency cached assets. raw.githubusercontent serves
    them directly and is more predictable for the Rust server's `server.levelurl`
    fetch path."""
    return f"https://raw.githubusercontent.com/{user}/{repo}/main/maps/{filename}"


def http_get(url, timeout=15):
    req = Request(url, headers={"User-Agent": "bya-thumbnail-manager"})
    with urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8", errors="replace")


# ─── thumbnail loader ────────────────────────────────────────────────────────

def make_preview(path, max_w=144, max_h=36):
    """tkinter PhotoImage natively reads PNG since 3.4. Subsample for the
    preview — nearest-neighbor downsampling, chunky but readable for the
    4:1 strips we're working with. PIL would give smoother results but
    we're keeping deps to stdlib."""
    img = tk.PhotoImage(file=str(path))
    sx = max(1, img.width() // max_w)
    sy = max(1, img.height() // max_h)
    return img.subsample(max(sx, sy))


# ─── GUI ─────────────────────────────────────────────────────────────────────

class App:
    STATUS_COLORS = {
        "untracked": "#e0a458",
        "modified":  "#e08858",
        "staged":    "#5ca3e0",
        "clean":     "#5ca85c",
    }
    BG_ROOT  = "#1c1c20"
    BG_PANEL = "#22222a"
    BG_BAR   = "#26262c"

    def __init__(self, root):
        self.root = root
        self.remote = parse_remote()
        if self.remote is None:
            messagebox.showerror(
                "Not a GitHub repo",
                f"Couldn't read a GitHub remote from {REPO_DIR}.\n"
                "This tool expects to sit at the root of a repo whose "
                "'origin' points at github.com.",
            )
            root.destroy()
            return
        self.user, self.repo = self.remote
        THUMBS_DIR.mkdir(exist_ok=True)
        MAPS_DIR.mkdir(exist_ok=True)

        self.cfg = load_config()
        self.sharex_dir = Path(self.cfg.get("sharex_dir") or DEFAULT_SHAREX_DIR)

        # PhotoImage cache: (path_str, mtime, size) → PhotoImage. Doubles as
        # the GC anchor — Tk drops PhotoImages whose only ref is a Label, so
        # we keep them referenced here. Cache is pruned to live entries at
        # the end of every full refresh; replaced files miss the cache
        # automatically because the key includes mtime + size.
        self._preview_cache = {}
        # Fingerprint of the last rendered state; refresh() compares against
        # this and skips the widget rebuild if nothing changed. Makes
        # alt-tab-back near-instant when no files were added/changed.
        self._last_fingerprint = None
        # Status map for uploaded files, computed once per refresh by a
        # single batched `git status --porcelain` call instead of N calls.
        self._status_map = {}
        # Once we've confirmed origin/main is set as upstream, it stays set
        # forever. Cache the answer so we don't pay a `git rev-parse` round
        # trip on every upload. None=unknown, True=set, False=not yet.
        self._upstream_known_set = None
        # Track the live toast so a new one replaces the previous instead
        # of stacking on top of it during back-to-back uploads.
        self._current_toast = None

        root.title(f"BYA Thumbnails — {self.user}/{self.repo}")
        root.geometry("1280x980")
        root.minsize(900, 600)
        root.configure(bg=self.BG_ROOT)

        self._build_toolbar()
        self._build_panes()
        self._build_statusbar()

        # Auto-refresh when the window comes to foreground (alt-tab back,
        # click on title bar from another app, etc.) so a freshly-captured
        # ShareX screenshot lands in the inbox without a manual Refresh.
        #
        # Two guards prevent the earlier flicker bug:
        #   1. event.widget is self.root → ignores child-widget FocusIn,
        #      so clicking any button or Entry inside the app doesn't rebuild
        #      the UI.
        #   2. Entry-has-focus skip → if you alt-tab away mid-rename and
        #      back, the Entry's focus is restored before our handler runs;
        #      seeing it focused, we leave the inbox alone so your typed
        #      name isn't blown away.
        # A 1-second debounce coalesces redundant FocusIn pairs that some
        # WMs fire during the alt-tab transition.
        self._last_focus_refresh = 0.0
        self.root.bind("<FocusIn>", self._on_focus_in)
        self.refresh()

    # ── layout ──

    def _btn(self, parent, text, command, accent=False, danger=False):
        bg = "#3a3a44"
        if accent: bg = "#2f6ef0"
        if danger: bg = "#a83838"
        return tk.Button(
            parent, text=text, command=command,
            bg=bg, fg="white",
            font=("Segoe UI", 9, "bold" if accent else "normal"),
            relief="flat",
            activebackground="#4a4a54" if not (accent or danger) else ("#5588ff" if accent else "#cc4444"),
            activeforeground="white",
            padx=10, pady=4, borderwidth=0, cursor="hand2",
        )

    def _build_toolbar(self):
        bar = tk.Frame(self.root, bg=self.BG_BAR, height=42)
        bar.pack(fill="x", side="top"); bar.pack_propagate(False)

        self._btn(bar, "↻ Refresh", self.refresh).pack(side="left", padx=(10, 4), pady=7)
        self._btn(bar, "📁 ShareX folder…", self.choose_sharex_dir).pack(side="left", padx=4, pady=7)
        self._btn(bar, "📁 Open maptn/", lambda: self._open_path(THUMBS_DIR)).pack(side="left", padx=4, pady=7)
        self._btn(bar, "📁 Open maps/", lambda: self._open_path(MAPS_DIR)).pack(side="left", padx=4, pady=7)

        self.remote_label = tk.Label(bar, text="", bg=self.BG_BAR, fg="#888", font=("Segoe UI", 9))
        self.remote_label.pack(side="right", padx=10)

    def _build_panes(self):
        # Dark-theme the Notebook tabs so they don't clash with the rest of
        # the UI. ttk styles are global so we override the standard names.
        style = ttk.Style()
        style.configure("BYA.TNotebook", background=self.BG_ROOT, borderwidth=0)
        style.configure("BYA.TNotebook.Tab",
                        background=self.BG_BAR, foreground="#aaa",
                        padding=[18, 7], borderwidth=0,
                        font=("Segoe UI", 10, "bold"))
        style.map("BYA.TNotebook.Tab",
                  background=[("selected", self.BG_PANEL)],
                  foreground=[("selected", "white")])

        nb = ttk.Notebook(self.root, style="BYA.TNotebook")
        nb.pack(fill="both", expand=True)

        # ── Thumbnails tab ────────────────────────────────────────────────
        thumb_tab = tk.Frame(nb, bg=self.BG_ROOT)
        nb.add(thumb_tab, text="Thumbnails")

        # Top pane: ShareX inbox.
        inbox_hdr = tk.Frame(thumb_tab, bg=self.BG_BAR, height=26); inbox_hdr.pack(fill="x")
        inbox_hdr.pack_propagate(False)
        tk.Label(inbox_hdr, text="ShareX inbox", bg=self.BG_BAR, fg="#ddd",
                 font=("Segoe UI", 9, "bold")).pack(side="left", padx=10, pady=2)
        self.inbox_path_lbl = tk.Label(inbox_hdr, text="", bg=self.BG_BAR, fg="#888",
                                       font=("Consolas", 8))
        self.inbox_path_lbl.pack(side="left", padx=8)

        self.inbox_canvas, self.inbox_frame = self._scrolled_list(thumb_tab, height=300)

        # Divider
        tk.Frame(thumb_tab, bg="#000", height=2).pack(fill="x")

        # Bottom pane: uploaded thumbnails.
        up_hdr = tk.Frame(thumb_tab, bg=self.BG_BAR, height=26); up_hdr.pack(fill="x")
        up_hdr.pack_propagate(False)
        tk.Label(up_hdr, text="Uploaded thumbnails (maptn/)", bg=self.BG_BAR, fg="#ddd",
                 font=("Segoe UI", 9, "bold")).pack(side="left", padx=10, pady=2)

        self.uploaded_canvas, self.uploaded_frame = self._scrolled_list(thumb_tab)

        # ── Maps tab ──────────────────────────────────────────────────────
        maps_tab = tk.Frame(nb, bg=self.BG_ROOT)
        nb.add(maps_tab, text="Maps")

        maps_hdr = tk.Frame(maps_tab, bg=self.BG_BAR, height=34); maps_hdr.pack(fill="x")
        maps_hdr.pack_propagate(False)
        tk.Label(maps_hdr, text="Uploaded maps (maps/)", bg=self.BG_BAR, fg="#ddd",
                 font=("Segoe UI", 9, "bold")).pack(side="left", padx=10, pady=2)
        self._btn(maps_hdr, "+ Add .map file…", self.pick_and_upload_map, accent=True).pack(
            side="right", padx=10, pady=3
        )

        self.maps_canvas, self.maps_frame = self._scrolled_list(maps_tab)

    def _scrolled_list(self, parent, height=None):
        wrap = tk.Frame(parent, bg=self.BG_ROOT)
        if height is not None:
            wrap.configure(height=height); wrap.pack_propagate(False)
        wrap.pack(fill="both", expand=(height is None))

        canvas = tk.Canvas(wrap, bg=self.BG_ROOT, highlightthickness=0)
        scroll = ttk.Scrollbar(wrap, orient="vertical", command=canvas.yview)
        canvas.configure(yscrollcommand=scroll.set)
        canvas.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")

        frame = tk.Frame(canvas, bg=self.BG_ROOT)
        win = canvas.create_window((0, 0), window=frame, anchor="nw")
        frame.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.bind("<Configure>", lambda e: canvas.itemconfig(win, width=e.width))

        def on_wheel(e, c=canvas):
            c.yview_scroll(int(-e.delta / 120), "units")
        canvas.bind("<Enter>", lambda e, c=canvas: c.bind_all("<MouseWheel>", lambda ev: on_wheel(ev, c)))
        canvas.bind("<Leave>", lambda e: canvas.unbind_all("<MouseWheel>"))

        return canvas, frame

    def _build_statusbar(self):
        self.status = tk.Label(
            self.root, text="", bg=self.BG_BAR, fg="#aaa",
            font=("Consolas", 9), anchor="w", padx=10, pady=6,
        )
        self.status.pack(fill="x", side="bottom")

    # ── state / config ──

    def choose_sharex_dir(self):
        d = filedialog.askdirectory(initialdir=str(self.sharex_dir), title="Select ShareX screenshots folder")
        if not d: return
        self.sharex_dir = Path(d)
        self.cfg["sharex_dir"] = str(self.sharex_dir)
        save_config(self.cfg)
        self.refresh()

    def set_status(self, text):
        self.status.config(text=text)

    def _on_focus_in(self, event):
        if event.widget is not self.root:
            return
        try:
            focused = self.root.focus_get()
        except KeyError:
            focused = None
        if isinstance(focused, tk.Entry):
            return
        now = time.time()
        if now - self._last_focus_refresh < 1.0:
            return
        self._last_focus_refresh = now
        self.refresh()

    def _show_toast(self, text, duration_ms=2200, color="#2e7d33"):
        """Small bottom-right notification overlay. Auto-dismisses; click to
        dismiss early. Built as a borderless Toplevel so it can sit on top
        of the app without participating in layout. Replaces any toast that
        was already on screen so back-to-back actions don't stack."""
        if self._current_toast is not None:
            try:
                self._current_toast.destroy()
            except tk.TclError:
                pass
            self._current_toast = None

        toast = tk.Toplevel(self.root)
        self._current_toast = toast
        toast.overrideredirect(True)
        try:
            toast.attributes("-topmost", True)
        except tk.TclError:
            pass
        toast.configure(bg=color)
        tk.Label(
            toast, text=text, bg=color, fg="white",
            font=("Segoe UI", 10, "bold"), padx=14, pady=8,
        ).pack()

        # Position above the status bar, anchored to the bottom-right of root.
        self.root.update_idletasks()
        toast.update_idletasks()
        rx = self.root.winfo_rootx()
        ry = self.root.winfo_rooty()
        rw = self.root.winfo_width()
        rh = self.root.winfo_height()
        tw = toast.winfo_width()
        th = toast.winfo_height()
        x = rx + rw - tw - 20
        y = ry + rh - th - 50    # leave space for the status bar
        toast.geometry(f"+{x}+{y}")

        def dismiss(_e=None):
            try:
                toast.destroy()
            except tk.TclError:
                pass
            if self._current_toast is toast:
                self._current_toast = None

        toast.bind("<Button-1>", dismiss)
        for child in toast.winfo_children():
            child.bind("<Button-1>", dismiss)
        self.root.after(duration_ms, dismiss)

    # ── data refresh ──

    def refresh(self):
        self.remote_label.config(text=f"{self.user}/{self.repo}")
        self.inbox_path_lbl.config(text=str(self.sharex_dir))

        # Collect all file lists up-front so we can fingerprint and decide
        # whether the widget rebuild is even needed.
        inbox_pngs = self._list_sharex_pngs()
        uploaded_pngs = sorted(
            THUMBS_DIR.glob("*.png"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        uploaded_maps = sorted(
            MAPS_DIR.glob("*.map"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )

        # Cheap fingerprint: (path, mtime, size) for every file. Catches
        # adds, deletes, and in-place replacements. When the user alt-tabs
        # back without touching any files, this matches and we skip the
        # entire widget teardown/rebuild — refresh becomes near-instant.
        fingerprint = tuple(
            (str(p), p.stat().st_mtime, p.stat().st_size)
            for p in inbox_pngs + uploaded_pngs + uploaded_maps
        )
        if fingerprint == self._last_fingerprint:
            self.set_status(
                f"{len(uploaded_pngs)} thumbnails · {len(uploaded_maps)} maps · {ahead_behind()}"
            )
            return
        self._last_fingerprint = fingerprint

        # Batched git status for the whole repo — one subprocess instead of
        # one-per-file. On Windows where process startup is slow, this is
        # the difference between visibly-stuttering and instant.
        self._status_map = self._build_status_map()

        for child in self.inbox_frame.winfo_children():    child.destroy()
        for child in self.uploaded_frame.winfo_children(): child.destroy()
        for child in self.maps_frame.winfo_children():     child.destroy()

        self._render_inbox(inbox_pngs)
        self._render_uploaded(uploaded_pngs)
        self._render_maps(uploaded_maps)

        # Prune the preview cache to entries still referenced by the rendered
        # rows. Without this the cache would grow forever as files come and
        # go (especially in the ShareX inbox). Maps don't generate previews
        # so they don't need to be in the live-keys set.
        live_keys = {
            (str(p), p.stat().st_mtime, p.stat().st_size)
            for p in inbox_pngs + uploaded_pngs
        }
        self._preview_cache = {
            k: v for k, v in self._preview_cache.items() if k in live_keys
        }

        self.set_status(
            f"{len(uploaded_pngs)} thumbnails · {len(uploaded_maps)} maps · {ahead_behind()}"
        )

    def _build_status_map(self):
        """Returns {relpath: status} parsed from a single git status call
        against the whole repo. Keys are full relative paths (e.g.
        'maptn/foo.png', 'maps/bar.map'). Files not present are clean."""
        rc, out = run_git("status", "--porcelain", "--", "maptn/", "maps/")
        if rc != 0 or not out:
            return {}
        result = {}
        for line in out.splitlines():
            if len(line) < 4:
                continue
            code = line[:2]
            name = line[3:].strip().strip('"')
            if "?" in code:   result[name] = "untracked"
            elif "A" in code: result[name] = "staged"
            else:             result[name] = "modified"
        return result

    def _list_sharex_pngs(self, limit=30):
        """Scan the ShareX folder's top level + the 2 most-recently-modified
        subfolders (covers ShareX's default YYYY-MM/ layout without rglob-ing
        years of history). Falls back gracefully on permission errors."""
        if not self.sharex_dir.exists():
            return []
        pngs = []
        try:
            subdirs = []
            with os.scandir(self.sharex_dir) as it:
                for entry in it:
                    try:
                        if entry.is_file() and entry.name.lower().endswith(".png"):
                            pngs.append(Path(entry.path))
                        elif entry.is_dir():
                            subdirs.append((entry.stat().st_mtime, Path(entry.path)))
                    except (PermissionError, OSError):
                        continue
            subdirs.sort(reverse=True)
            for _, d in subdirs[:2]:
                try:
                    with os.scandir(d) as it:
                        for entry in it:
                            if entry.is_file() and entry.name.lower().endswith(".png"):
                                pngs.append(Path(entry.path))
                except (PermissionError, OSError):
                    continue
        except (PermissionError, OSError):
            return []
        pngs.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        return pngs[:limit]

    def _render_inbox(self, pngs):
        if not pngs:
            tk.Label(
                self.inbox_frame,
                text=f"No PNGs found in {self.sharex_dir}\n"
                     "Capture a screenshot with ShareX, then click Refresh "
                     "(or click ShareX folder… to point at a different path).",
                bg=self.BG_ROOT, fg="#666", font=("Segoe UI", 10),
                justify="left", padx=24, pady=24,
            ).pack(anchor="w")
            return
        for p in pngs:
            self._build_inbox_row(p)

    def _render_uploaded(self, pngs):
        # Newest-uploaded first. shutil.copyfile (used by upload_as) doesn't
        # copy metadata, so the destination's mtime is set to "now" — sorting
        # by mtime descending naturally puts your most recent uploads at top.
        if not pngs:
            tk.Label(
                self.uploaded_frame,
                text="No thumbnails uploaded yet.\n"
                     "Name an image from the inbox above to publish it.",
                bg=self.BG_ROOT, fg="#666", font=("Segoe UI", 10),
                justify="left", padx=24, pady=24,
            ).pack(anchor="w")
            return
        # 2-column grid so ~20 thumbnails fit on screen without scrolling.
        # uniform="u" keeps both columns the same width regardless of content.
        self.uploaded_frame.grid_columnconfigure(0, weight=1, uniform="u")
        self.uploaded_frame.grid_columnconfigure(1, weight=1, uniform="u")
        for i, p in enumerate(pngs):
            r, col = i // 2, i % 2
            self._build_uploaded_row(p, grid=(r, col))

    # ── row builders ──

    def _preview_cell(self, parent, path):
        box = tk.Frame(parent, bg=self.BG_ROOT, width=144, height=36)
        box.pack(side="left", padx=(0, 12)); box.pack_propagate(False)
        try:
            st = path.stat()
            key = (str(path), st.st_mtime, st.st_size)
            img = self._preview_cache.get(key)
            if img is None:
                img = make_preview(path)
                self._preview_cache[key] = img
            tk.Label(box, image=img, bg=self.BG_ROOT, borderwidth=0).pack(expand=True)
        except Exception:
            tk.Label(box, text="(no preview)", bg=self.BG_ROOT, fg="#666",
                     font=("Segoe UI", 8)).pack(expand=True)
        return box

    def _build_inbox_row(self, path):
        row = tk.Frame(self.inbox_frame, bg=self.BG_PANEL, padx=10, pady=8)
        row.pack(fill="x", padx=10, pady=4)

        self._preview_cell(row, path)

        meta = tk.Frame(row, bg=self.BG_PANEL); meta.pack(side="left", fill="x", expand=True)
        tk.Label(meta, text=path.name, bg=self.BG_PANEL, fg="#eee",
                 font=("Segoe UI", 10), anchor="w").pack(anchor="w")
        size_kb = path.stat().st_size / 1024
        size_col = "#e08858" if path.stat().st_size > PERF_WARN_BYTES else "#888"
        ts = datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d %H:%M")
        tk.Label(meta, text=f"{size_kb:.1f} KB · captured {ts}",
                 bg=self.BG_PANEL, fg=size_col, font=("Segoe UI", 9)).pack(anchor="w")

        right = tk.Frame(row, bg=self.BG_PANEL); right.pack(side="right")

        # Default name = original stem stripped of timestamp prefix.
        default_name = re.sub(r"^\d{4}-\d{2}-\d{2}[_\- ]?\d*\-?", "", path.stem) or path.stem

        name_var = tk.StringVar(value=default_name)
        entry = tk.Entry(right, textvariable=name_var, width=18,
                         bg="#3a3a44", fg="white", insertbackground="white",
                         relief="flat", font=("Consolas", 10))
        entry.pack(side="left", padx=(0, 6), ipady=4)

        def go():
            name = name_var.get().strip()
            if not NAME_RE.match(name):
                self.set_status(f"invalid name '{name}' — use letters, digits, _ or -")
                return
            self.upload_as(path, name)

        entry.bind("<Return>", lambda e: go())
        self._btn(right, "Upload as ↑", go, accent=True).pack(side="left", padx=(0, 4))
        self._btn(right, "🗑", lambda p=path: self.delete_inbox(p), danger=True).pack(side="left")

    def _build_uploaded_row(self, path, grid=None):
        # Look up status from the batched map built at refresh start instead
        # of shelling out to git per-row. Files not in the map are clean.
        status = self._status_map.get(f"maptn/{path.name}", "clean")
        size_bytes = path.stat().st_size
        size_kb = size_bytes / 1024
        size_color = "#e08858" if size_bytes > PERF_WARN_BYTES else "#aaa"

        row = tk.Frame(self.uploaded_frame, bg=self.BG_PANEL, padx=8, pady=6)
        if grid is not None:
            r, col = grid
            row.grid(row=r, column=col, sticky="ew", padx=6, pady=3)
        else:
            row.pack(fill="x", padx=10, pady=4)

        self._preview_cell(row, path)

        meta = tk.Frame(row, bg=self.BG_PANEL); meta.pack(side="left", fill="x", expand=True)
        tk.Label(meta, text=path.stem, bg=self.BG_PANEL, fg="#eee",
                 font=("Segoe UI", 11, "bold"), anchor="w").pack(anchor="w")
        sub = tk.Frame(meta, bg=self.BG_PANEL); sub.pack(anchor="w")
        tk.Label(sub, text="●", bg=self.BG_PANEL,
                 fg=self.STATUS_COLORS[status], font=("Segoe UI", 10)).pack(side="left")
        tk.Label(sub, text=f" {status}", bg=self.BG_PANEL,
                 fg=self.STATUS_COLORS[status], font=("Segoe UI", 9)).pack(side="left")
        tk.Label(sub, text=f"  ·  {size_kb:.1f} KB", bg=self.BG_PANEL,
                 fg=size_color, font=("Segoe UI", 9)).pack(side="left")

        right = tk.Frame(row, bg=self.BG_PANEL); right.pack(side="right")
        self._btn(right, "📋 Copy URL", lambda p=path: self.copy_url(p)).pack(side="left", padx=(0, 4))
        self._btn(right, "🗘 Purge CDN", lambda p=path: self.purge_cdn(p)).pack(side="left", padx=(0, 4))
        self._btn(right, "🗑", lambda p=path: self.delete_uploaded(p), danger=True).pack(side="left")

    # ── actions ──

    def upload_as(self, src_path, name):
        target = THUMBS_DIR / f"{name}.png"
        if target.exists():
            if not messagebox.askyesno(
                "Overwrite?", f"maptn/{target.name} already exists. Overwrite + republish?"
            ):
                return

        # Optimistic URL hand-off: the jsDelivr URL is deterministic from the
        # filename, so copy it to the clipboard and surface the toast NOW —
        # before the slow git + network work runs. By the time the user has
        # alt-tabbed into the game and navigated to the admin TN popup, the
        # push has completed and the URL is valid. Status bar tracks the
        # actual push state until done.
        url = jsdelivr_url(self.user, self.repo, target.name)
        self.root.clipboard_clear()
        self.root.clipboard_append(url)
        self._show_toast(f"📋 URL copied · uploading {target.name}…", duration_ms=3500)
        self.set_status(f"uploading {target.name} → {url}")

        def worker():
            try:
                shutil.copyfile(src_path, target)
            except OSError as ex:
                self.root.after(0, lambda: self.set_status(f"copy failed: {ex}"))
                return

            log = []
            def step(*args):
                rc, out = run_git(*args)
                log.append(f"$ git {' '.join(args)}\n{out or '(no output)'}")
                return rc, out

            rc, _ = step("add", "--", f"maptn/{target.name}")
            if rc != 0:
                self._finish_upload(src_path, target, "git add failed", "\n\n".join(log), ok=False)
                return

            ts = datetime.now().strftime("%Y-%m-%d %H:%M")
            rc, _ = step("commit", "-m", f"add thumbnail {name} · {ts}")
            if rc != 0:
                # Could mean "nothing to commit" (re-upload of identical bytes).
                # In that case still try a push and proceed.
                if "nothing to commit" not in (log[-1] or "").lower():
                    self._finish_upload(src_path, target, "git commit failed", "\n\n".join(log), ok=False)
                    return

            # Push: rev-parse only on the first upload of the session (the
            # answer is stable once upstream is set, so don't pay the
            # subprocess cost every time).
            if self._upstream_known_set is None:
                rc_u, _ = run_git("rev-parse", "--abbrev-ref", "@{u}")
                self._upstream_known_set = (rc_u == 0)
            if not self._upstream_known_set:
                rc, _ = step("push", "-u", "origin", "HEAD")
                if rc == 0:
                    self._upstream_known_set = True
            else:
                rc, _ = step("push")
            if rc != 0:
                self._finish_upload(src_path, target, "git push failed", "\n\n".join(log), ok=False)
                return

            self._finish_upload(src_path, target, "uploaded", "\n\n".join(log), ok=True)

        threading.Thread(target=worker, daemon=True).start()

    def _finish_upload(self, src_path, target, summary, log, ok):
        def done():
            if not ok:
                self.refresh()
                self.set_status(f"✗ {summary}")
                messagebox.showerror("Upload failed", log[-2000:])
                return
            # Best-effort: recycle the source ShareX capture now that it's
            # been published. Failures here don't fail the upload — file
            # just stays in the inbox and the user can delete it manually.
            recycle_note = ""
            try:
                recycle(src_path)
            except OSError as ex:
                recycle_note = f"  (kept source: {ex})"
            self.refresh()
            url = jsdelivr_url(self.user, self.repo, target.name)
            # URL is already on the clipboard from the click handler — don't
            # rewrite it (could clobber something the user copied in between).
            self.set_status(f"✓ {summary} · URL on clipboard → {url}{recycle_note}")
            self._show_toast(f"✓ Pushed · {target.name}")
        self.root.after(0, done)

    def copy_url(self, path):
        url = jsdelivr_url(self.user, self.repo, path.name)
        self.root.clipboard_clear()
        self.root.clipboard_append(url)
        self.set_status(f"copied → {url}")
        self._show_toast(f"📋 URL copied · {path.name}")

    def purge_cdn(self, path):
        url = purge_url(self.user, self.repo, path.name)
        self.set_status(f"purging {path.name} …")

        def worker():
            try:
                status, body = http_get(url)
                msg = f"purge {path.name}: HTTP {status}"
                if status != 200:
                    msg += f" — {body[:120]}"
            except (URLError, HTTPError) as ex:
                msg = f"purge failed: {ex}"
            self.root.after(0, lambda: self.set_status(msg))

        threading.Thread(target=worker, daemon=True).start()

    def delete_inbox(self, path):
        """Send a ShareX inbox capture to the Recycle Bin. No confirmation —
        the file is recoverable from Recycle Bin if the click was accidental."""
        try:
            recycle(path)
        except OSError as ex:
            self.set_status(f"recycle failed: {ex}")
            return
        self.refresh()
        self.set_status(f"moved to Recycle Bin: {path.name}")

    def delete_uploaded(self, path):
        if not messagebox.askyesno(
            "Delete + push?",
            f"Remove maptn/{path.name} from the repo and push?\n"
            "Any in-game admin TN URL pointing at this file will start "
            "returning 404 once jsDelivr's cache expires.",
        ):
            return

        self.set_status(f"removing {path.name} …")

        def worker():
            log = []
            def step(*args):
                rc, out = run_git(*args)
                log.append(f"$ git {' '.join(args)}\n{out or '(no output)'}")
                return rc, out

            try:
                path.unlink()
            except OSError as ex:
                self.root.after(0, lambda: self.set_status(f"unlink failed: {ex}"))
                return

            rc, _ = step("add", "-A", "--", f"maptn/{path.name}")
            if rc != 0:
                self._finish_delete(path, "git add failed", "\n\n".join(log), ok=False); return
            ts = datetime.now().strftime("%Y-%m-%d %H:%M")
            rc, _ = step("commit", "-m", f"remove thumbnail {path.stem} · {ts}")
            if rc != 0:
                self._finish_delete(path, "commit failed", "\n\n".join(log), ok=False); return
            rc, _ = step("push")
            if rc != 0:
                self._finish_delete(path, "push failed", "\n\n".join(log), ok=False); return
            self._finish_delete(path, "removed and pushed", "\n\n".join(log), ok=True)

        threading.Thread(target=worker, daemon=True).start()

    def _finish_delete(self, path, summary, log, ok):
        def done():
            self.refresh()
            self.set_status(("✓ " if ok else "✗ ") + summary)
            if not ok:
                messagebox.showerror("Delete failed", log[-2000:])
        self.root.after(0, done)

    # ── Maps tab ───────────────────────────────────────────────────────────

    def _render_maps(self, paths):
        if not paths:
            tk.Label(
                self.maps_frame,
                text="No maps uploaded yet.\n"
                     "Click  + Add .map file…  in the header above to publish one.",
                bg=self.BG_ROOT, fg="#666", font=("Segoe UI", 10),
                justify="left", padx=24, pady=24,
            ).pack(anchor="w")
            return
        # Single-column list — maps are infrequent enough that the dense
        # 2-column grid used for thumbnails would be wasted on whitespace.
        for p in paths:
            self._build_map_row(p)

    def _build_map_row(self, path):
        status = self._status_map.get(f"maps/{path.name}", "clean")
        size_bytes = path.stat().st_size
        size_mb = size_bytes / (1024 * 1024)
        # 100 MB is GitHub's hard reject; warn at 50 MB.
        size_color = "#e08858" if size_bytes > 50 * 1024 * 1024 else "#aaa"

        row = tk.Frame(self.maps_frame, bg=self.BG_PANEL, padx=12, pady=10)
        row.pack(fill="x", padx=10, pady=4)

        meta = tk.Frame(row, bg=self.BG_PANEL); meta.pack(side="left", fill="x", expand=True)
        tk.Label(meta, text=path.stem, bg=self.BG_PANEL, fg="#eee",
                 font=("Segoe UI", 11, "bold"), anchor="w").pack(anchor="w")
        sub = tk.Frame(meta, bg=self.BG_PANEL); sub.pack(anchor="w")
        tk.Label(sub, text="●", bg=self.BG_PANEL,
                 fg=self.STATUS_COLORS[status], font=("Segoe UI", 10)).pack(side="left")
        tk.Label(sub, text=f" {status}", bg=self.BG_PANEL,
                 fg=self.STATUS_COLORS[status], font=("Segoe UI", 9)).pack(side="left")
        tk.Label(sub, text=f"  ·  {size_mb:.1f} MB", bg=self.BG_PANEL,
                 fg=size_color, font=("Segoe UI", 9)).pack(side="left")

        right = tk.Frame(row, bg=self.BG_PANEL); right.pack(side="right")
        self._btn(right, "📋 Copy URL", lambda p=path: self.copy_map_url(p)).pack(side="left", padx=(0, 4))
        self._btn(right, "🗑", lambda p=path: self.delete_map(p), danger=True).pack(side="left")

    def pick_and_upload_map(self):
        src = filedialog.askopenfilename(
            title="Select .map file to upload",
            filetypes=[("Rust map files", "*.map"), ("All files", "*.*")],
        )
        if not src:
            return
        src_path = Path(src)
        # Default name = source filename minus the .map extension.
        default = re.sub(r"\.map$", "", src_path.name, flags=re.IGNORECASE)
        name = simpledialog.askstring(
            "Name the map",
            f"Choose a name for {src_path.name}\n(letters, digits, _ or - only)",
            initialvalue=default,
            parent=self.root,
        )
        if name is None:
            return
        name = name.strip()
        if not NAME_RE.match(name):
            messagebox.showerror("Invalid name",
                                 f"'{name}' — use letters, digits, _ or -")
            return
        target = MAPS_DIR / f"{name}.map"
        if target.exists():
            if not messagebox.askyesno(
                "Overwrite?",
                f"maps/{target.name} already exists. Overwrite + republish?\n"
                "Any server.levelurl currently pointing at this map will "
                "fetch the new bytes on next boot.",
            ):
                return
        self.upload_map_as(src_path, name)

    def upload_map_as(self, src_path, name):
        target = MAPS_DIR / f"{name}.map"

        # Same optimistic-URL pattern as thumbnails: the raw GitHub URL is
        # deterministic from the filename, so copy it to the clipboard now
        # and let the slow git+network work happen in the background.
        url = raw_map_url(self.user, self.repo, target.name)
        self.root.clipboard_clear()
        self.root.clipboard_append(url)
        self._show_toast(f"📋 URL copied · uploading {target.name}…", duration_ms=5000)
        self.set_status(f"uploading {target.name} → {url}")

        def worker():
            try:
                shutil.copyfile(src_path, target)
            except OSError as ex:
                self.root.after(0, lambda: self.set_status(f"copy failed: {ex}"))
                return

            log = []
            def step(*args):
                rc, out = run_git(*args)
                log.append(f"$ git {' '.join(args)}\n{out or '(no output)'}")
                return rc, out

            rc, _ = step("add", "--", f"maps/{target.name}")
            if rc != 0:
                self._finish_map_upload(target, "git add failed", "\n\n".join(log), ok=False)
                return

            ts = datetime.now().strftime("%Y-%m-%d %H:%M")
            rc, _ = step("commit", "-m", f"add map {name} · {ts}")
            if rc != 0 and "nothing to commit" not in (log[-1] or "").lower():
                self._finish_map_upload(target, "git commit failed", "\n\n".join(log), ok=False)
                return

            if self._upstream_known_set is None:
                rc_u, _ = run_git("rev-parse", "--abbrev-ref", "@{u}")
                self._upstream_known_set = (rc_u == 0)
            if not self._upstream_known_set:
                rc, _ = step("push", "-u", "origin", "HEAD")
                if rc == 0:
                    self._upstream_known_set = True
            else:
                rc, _ = step("push")
            if rc != 0:
                self._finish_map_upload(target, "git push failed", "\n\n".join(log), ok=False)
                return

            self._finish_map_upload(target, "uploaded", "\n\n".join(log), ok=True)

        threading.Thread(target=worker, daemon=True).start()

    def _finish_map_upload(self, target, summary, log, ok):
        def done():
            self.refresh()
            if ok:
                url = raw_map_url(self.user, self.repo, target.name)
                self.set_status(f"✓ {summary} · URL on clipboard → {url}")
                self._show_toast(f"✓ Pushed · {target.name}")
            else:
                self.set_status(f"✗ {summary}")
                messagebox.showerror("Map upload failed", log[-2000:])
        self.root.after(0, done)

    def copy_map_url(self, path):
        url = raw_map_url(self.user, self.repo, path.name)
        self.root.clipboard_clear()
        self.root.clipboard_append(url)
        self.set_status(f"copied → {url}")
        self._show_toast(f"📋 URL copied · {path.name}")

    def delete_map(self, path):
        if not messagebox.askyesno(
            "Delete + push?",
            f"Remove maps/{path.name} from the repo and push?\n"
            "Any server.levelurl pointing at this file will 404 on next boot.",
        ):
            return
        self.set_status(f"removing {path.name} …")

        def worker():
            log = []
            def step(*args):
                rc, out = run_git(*args)
                log.append(f"$ git {' '.join(args)}\n{out or '(no output)'}")
                return rc, out

            try:
                path.unlink()
            except OSError as ex:
                self.root.after(0, lambda: self.set_status(f"unlink failed: {ex}"))
                return

            rc, _ = step("add", "-A", "--", f"maps/{path.name}")
            if rc != 0:
                self._finish_delete(path, "git add failed", "\n\n".join(log), ok=False); return
            ts = datetime.now().strftime("%Y-%m-%d %H:%M")
            rc, _ = step("commit", "-m", f"remove map {path.stem} · {ts}")
            if rc != 0:
                self._finish_delete(path, "commit failed", "\n\n".join(log), ok=False); return
            rc, _ = step("push")
            if rc != 0:
                self._finish_delete(path, "push failed", "\n\n".join(log), ok=False); return
            self._finish_delete(path, "removed and pushed", "\n\n".join(log), ok=True)

        threading.Thread(target=worker, daemon=True).start()

    def _open_path(self, p):
        try:
            if os.name == "nt":
                os.startfile(p)
            else:
                subprocess.Popen(["xdg-open", str(p)])
        except OSError as ex:
            self.set_status(f"open failed: {ex}")


def main():
    root = tk.Tk()
    try:
        ttk.Style(root).theme_use("clam")
    except tk.TclError:
        pass
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
