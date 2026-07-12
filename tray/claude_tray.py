#!/usr/bin/env python3
"""Claude Discord Bot - Linux System Tray App"""

import subprocess
import os
import sys
import threading
import time
import webbrowser
from datetime import datetime

# Force gtk backend for left-click support (AppIndicator doesn't allow custom left-click)
os.environ.setdefault("PYSTRAY_BACKEND", "gtk")

try:
    import pystray
    from PIL import Image, ImageDraw
except ImportError:
    print("Installing required packages: pip3 install pystray Pillow")
    subprocess.run([sys.executable, "-m", "pip", "install", "pystray", "Pillow"], check=True)
    import pystray
    from PIL import Image, ImageDraw

SERVICE_NAME = "claude-discord"
BOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(BOT_DIR, ".env")
import urllib.request
import json
import re

update_available = False
current_version = "unknown"
cached_release_notes = ""
cached_new_version = ""

# Usage data
usage_data = None  # dict: {five_hour, seven_day, seven_day_sonnet} each {utilization, resets_at}
usage_last_fetched = None  # datetime
USAGE_CACHE_PATH = os.path.join(os.path.expanduser("~"), ".claude", ".usage-cache.json")
_control_panel_window = None

# Placeholder values from .env.example that should be treated as unconfigured
EXAMPLE_VALUES = {
    "your_bot_token_here", "your_server_id_here", "your_user_id_here",
    "/Users/yourname/projects", "/Users/you/projects",
}

# --- Env Configuration Check ---

def _load_env():
    env = {}
    if not os.path.exists(ENV_PATH):
        return env
    with open(ENV_PATH) as f:
        for line in f:
            line = line.strip()
            if line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip()
    return env


def is_env_configured():
    if not os.path.exists(ENV_PATH):
        return False
    env = _load_env()
    token = env.get("DISCORD_BOT_TOKEN", "")
    guild = env.get("DISCORD_GUILD_ID", "")
    if not token or token in EXAMPLE_VALUES:
        return False
    if not guild or guild in EXAMPLE_VALUES:
        return False
    return True


def is_running():
    return os.path.exists(os.path.join(BOT_DIR, ".bot.lock"))


def get_version():
    try:
        result = subprocess.run(
            ["git", "describe", "--tags", "--always"],
            capture_output=True, text=True, cwd=BOT_DIR
        )
        ver = result.stdout.strip()
        return ver if ver else "unknown"
    except Exception:
        return "unknown"


def _extract_tag(version):
    """'v1.1.0-3-gabcdef' -> 'v1.1.0'"""
    parts = version.split("-")
    if len(parts) >= 3 and parts[-1].startswith("g"):
        return "-".join(parts[:-2])
    return version


def _parse_version(tag):
    """'v1.1.0' -> [1, 1, 0]"""
    cleaned = tag.lstrip("v")
    try:
        return [int(x) for x in cleaned.split(".")]
    except ValueError:
        return [0]


def _is_newer(a, b):
    """Returns True if version a > b"""
    for i in range(max(len(a), len(b))):
        av = a[i] if i < len(a) else 0
        bv = b[i] if i < len(b) else 0
        if av > bv:
            return True
        if av < bv:
            return False
    return False


def _strip_markdown(text):
    result = text.replace("**", "")
    result = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", result)
    lines = [line for line in result.split("\n") if "Full Changelog:" not in line]
    result = "\n".join(lines)
    while "\n\n\n" in result:
        result = result.replace("\n\n\n", "\n\n")
    return result.strip()


def fetch_release_notes():
    global cached_release_notes, cached_new_version
    try:
        url = "https://api.github.com/repos/chadingTV/claudecode-discord/releases"
        req = urllib.request.Request(url)
        req.add_header("Accept", "application/vnd.github.v3+json")
        req.add_header("User-Agent", "claudecode-discord-tray")
        with urllib.request.urlopen(req, timeout=10) as response:
            releases = json.loads(response.read().decode())

        current_tag = _extract_tag(current_version)
        current_parts = _parse_version(current_tag)
        notes = []
        latest_tag = current_tag

        for r in releases:
            tag = r.get("tag_name", "")
            body = r.get("body", "")
            if r.get("draft", False):
                continue
            r_parts = _parse_version(tag)
            if _is_newer(r_parts, current_parts):
                notes.append((tag, body))
                if _is_newer(r_parts, _parse_version(latest_tag)):
                    latest_tag = tag

        notes.sort(key=lambda x: _parse_version(x[0]))
        formatted = "\n\n".join(
            f"━━━ {tag} ━━━\n{_strip_markdown(body)}" for tag, body in notes
        )
        cached_release_notes = formatted
        cached_new_version = latest_tag
    except Exception:
        cached_release_notes = ""
        cached_new_version = ""


def check_for_updates():
    global update_available, current_version
    try:
        current_version = get_version()
        subprocess.run(["git", "fetch", "origin", "main", "--tags"], capture_output=True, cwd=BOT_DIR)
        local = subprocess.run(
            ["git", "rev-parse", "HEAD"], capture_output=True, text=True, cwd=BOT_DIR
        ).stdout.strip()
        remote = subprocess.run(
            ["git", "rev-parse", "origin/main"], capture_output=True, text=True, cwd=BOT_DIR
        ).stdout.strip()
        update_available = bool(local and remote and local != remote)
        if update_available:
            fetch_release_notes()
    except Exception:
        update_available = False


def _show_update_confirmation():
    """Show update confirmation dialog with release notes using yad or zenity."""
    title = "Update Available"
    version_info = f"{current_version} → {cached_new_version}" if cached_new_version else ""

    if cached_release_notes:
        text = (version_info + "\n\n" + cached_release_notes) if version_info else cached_release_notes
        # Try yad first
        try:
            result = subprocess.run(
                ["yad", "--text-info", "--title=" + title,
                 "--width=500", "--height=400",
                 "--button=" + "Update:0",
                 "--button=" + "Cancel:1",
                 "--fontname=monospace 10", "--wrap"],
                input=text, text=True, capture_output=True
            )
            return result.returncode == 0
        except FileNotFoundError:
            pass
        # zenity fallback
        try:
            result = subprocess.run(
                ["zenity", "--text-info", "--title=" + title,
                 "--width=500", "--height=400",
                 "--ok-label=" + "Update",
                 "--cancel-label=" + "Cancel"],
                input=text, text=True, capture_output=True
            )
            return result.returncode == 0
        except FileNotFoundError:
            pass

    # No release notes or no dialog tool — simple question
    msg = "Do you want to update to the latest version?"
    if version_info:
        msg = version_info + "\n\n" + msg
    try:
        result = subprocess.run(
            ["zenity", "--question", "--title=" + title, "--text=" + msg],
            capture_output=True
        )
        return result.returncode == 0
    except FileNotFoundError:
        pass
    try:
        result = subprocess.run(
            ["yad", "--question", "--title=" + title, "--text=" + msg],
            capture_output=True
        )
        return result.returncode == 0
    except FileNotFoundError:
        pass
    # No dialog tool available — proceed anyway
    return True


def perform_update(icon, item):
    global update_available, current_version
    if not _show_update_confirmation():
        return

    # Stop bot before update
    subprocess.run(["systemctl", "--user", "stop", SERVICE_NAME], capture_output=True)
    time.sleep(1)

    subprocess.run(["git", "fetch", "origin", "main", "--tags"], capture_output=True, cwd=BOT_DIR)
    pull_result = subprocess.run(["git", "reset", "--hard", "origin/main"], capture_output=True, text=True, cwd=BOT_DIR)

    if pull_result.returncode != 0:
        err_msg = pull_result.stderr.strip() or pull_result.stdout.strip() or "Unknown error"
        icon.notify("Update failed (git pull): " + err_msg,
                    "Update Failed")
        # Restart bot even on failure
        subprocess.run(["systemctl", "--user", "start", SERVICE_NAME], capture_output=True)
        update_icon(icon)
        return

    install_result = subprocess.run(["npm", "install"], capture_output=True, text=True, cwd=BOT_DIR)
    subprocess.run(["npm", "rebuild", "better-sqlite3"], capture_output=True, cwd=BOT_DIR)
    build_result = subprocess.run(["npm", "run", "build"], capture_output=True, text=True, cwd=BOT_DIR)

    if build_result.returncode != 0:
        err_msg = build_result.stderr.strip() or build_result.stdout.strip() or "Unknown error"
        icon.notify("Update failed (build): " + err_msg[:200],
                    "Update Failed")
        # Restart bot even on failure
        subprocess.run(["systemctl", "--user", "start", SERVICE_NAME], capture_output=True)
        update_icon(icon)
        return

    # Regenerate systemd service file (node path may change)
    start_script = os.path.join(BOT_DIR, "linux-start.sh")
    subprocess.run(["/bin/bash", start_script, "--regen-service"], capture_output=True)

    current_version = get_version()
    update_available = False

    # Always restart bot after update
    subprocess.run(["systemctl", "--user", "enable", SERVICE_NAME], capture_output=True)
    subprocess.run(["systemctl", "--user", "start", SERVICE_NAME], capture_output=True)

    time.sleep(2)
    update_icon(icon)
    icon.menu = create_menu()
    icon.notify("Updated to version: " + current_version,
                "Update Complete")


def create_icon(color):
    """Create a colored circle icon"""
    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    margin = 8
    draw.ellipse([margin, margin, size - margin, size - margin], fill=color)
    return img


def auto_rebuild_if_needed():
    """Auto-rebuild if source is newer than dist."""
    dist_path = os.path.join(BOT_DIR, "dist", "index.js")
    if not os.path.exists(dist_path):
        subprocess.run(["npm", "install"], capture_output=True, cwd=BOT_DIR)
        subprocess.run(["npm", "run", "build"], capture_output=True, cwd=BOT_DIR)
        return
    dist_mtime = os.path.getmtime(dist_path)
    src_dir = os.path.join(BOT_DIR, "src")
    for root, _, files in os.walk(src_dir):
        for f in files:
            if f.endswith(".ts") and os.path.getmtime(os.path.join(root, f)) > dist_mtime:
                subprocess.run(["npm", "install"], capture_output=True, cwd=BOT_DIR)
                subprocess.run(["npm", "run", "build"], capture_output=True, cwd=BOT_DIR)
                return


def start_bot(icon, item):
    auto_rebuild_if_needed()
    subprocess.run(["systemctl", "--user", "start", SERVICE_NAME], capture_output=True)
    time.sleep(2)
    update_icon(icon)
    icon.menu = create_menu()
    if is_running():
        icon.notify("Bot is running. Click tray icon to manage.",
                    "Claude Discord Bot Started")


def stop_bot(icon, item):
    subprocess.run(["systemctl", "--user", "stop", SERVICE_NAME], capture_output=True)
    time.sleep(1)
    update_icon(icon)
    icon.menu = create_menu()


def restart_bot(icon, item):
    subprocess.run(["systemctl", "--user", "restart", SERVICE_NAME], capture_output=True)
    time.sleep(2)
    update_icon(icon)
    icon.menu = create_menu()


def open_log(icon, item):
    log_path = os.path.join(BOT_DIR, "bot.log")
    if os.path.exists(log_path):
        subprocess.Popen(["xdg-open", log_path])


def open_folder(icon, item):
    subprocess.Popen(["xdg-open", BOT_DIR])


def open_github(icon, item):
    webbrowser.open("https://github.com/chadingTV/claudecode-discord")


def open_github_issues(icon, item):
    webbrowser.open("https://github.com/chadingTV/claudecode-discord/issues")


def edit_settings(icon, item):
    """Open settings dialog using GTK3 (native look) or fallback"""
    try:
        _edit_settings_gtk(icon)
    except Exception:
        # Fallback: open in text editor
        env_path = os.path.join(BOT_DIR, ".env")
        if os.path.exists(env_path):
            subprocess.Popen(["xdg-open", env_path])
        else:
            subprocess.Popen(["xdg-open", os.path.join(BOT_DIR, ".env.example")])


def _edit_settings_gtk(icon=None):
    """Edit settings using GTK3 native dialog with pre-filled values"""
    import gi
    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk

    env = _load_env()
    fields = [
        ("DISCORD_BOT_TOKEN", "Discord Bot Token"),
        ("DISCORD_GUILD_ID", "Discord Guild ID (Server ID)"),
        ("BASE_PROJECT_DIR", "Base Project Directory"),
        ("RATE_LIMIT_PER_MINUTE", "Rate Limit Per Minute"),
        ("SHOW_COST", "Show Cost (true/false)"),
    ]
    defaults = {"RATE_LIMIT_PER_MINUTE": "10", "SHOW_COST": "true", "BASE_PROJECT_DIR": ""}
    placeholders = {
        "DISCORD_BOT_TOKEN": "Paste your bot token here",
        "DISCORD_GUILD_ID": "Right-click server > Copy Server ID",
        "BASE_PROJECT_DIR": "e.g. /home/you/projects",
        "RATE_LIMIT_PER_MINUTE": "10",
        "SHOW_COST": "false recommended for Max plan",
    }

    dialog = Gtk.Dialog(
        title="Claude Discord Bot Settings",
        flags=0,
    )
    dialog.add_buttons(
        "Cancel", Gtk.ResponseType.CANCEL,
        "Save", Gtk.ResponseType.OK
    )
    dialog.set_default_size(550, -1)
    dialog.set_position(Gtk.WindowPosition.CENTER)
    dialog.set_border_width(15)

    # Style the Save button
    save_btn = dialog.get_widget_for_response(Gtk.ResponseType.OK)
    save_btn.get_style_context().add_class("suggested-action")

    content = dialog.get_content_area()
    content.set_spacing(8)

    # Title
    title = Gtk.Label()
    title.set_markup(f"<b><big>{'Claude Discord Bot Settings'}</big></b>")
    title.set_halign(Gtk.Align.START)
    content.pack_start(title, False, False, 0)

    subtitle = Gtk.Label(label="Please fill in the required fields.")
    subtitle.set_halign(Gtk.Align.START)
    subtitle.get_style_context().add_class("dim-label")
    content.pack_start(subtitle, False, False, 0)

    # Setup guide link
    link = Gtk.LinkButton.new_with_label(
        "https://github.com/chadingTV/claudecode-discord/blob/main/SETUP.md",
        "Open Setup Guide"
    )
    link.set_halign(Gtk.Align.START)
    content.pack_start(link, False, False, 0)

    issue_link = Gtk.LinkButton.new_with_label(
        "https://github.com/chadingTV/claudecode-discord/issues",
        "Bug Report / Feature Request (GitHub Issues)"
    )
    issue_link.set_halign(Gtk.Align.START)
    content.pack_start(issue_link, False, False, 0)

    content.pack_start(Gtk.Separator(), False, False, 4)

    entries = {}
    for key, label_text in fields:
        lbl = Gtk.Label()
        lbl.set_markup(f"<b>{label_text}:</b>")
        lbl.set_halign(Gtk.Align.START)
        content.pack_start(lbl, False, False, 0)

        if key == "BASE_PROJECT_DIR":
            hbox = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
            entry = Gtk.Entry()
            entry.set_hexpand(True)
            entry.set_placeholder_text(placeholders.get(key, ""))
            hbox.pack_start(entry, True, True, 0)

            browse_btn = Gtk.Button(label="Browse...")
            def on_browse(btn, e=entry):
                chooser = Gtk.FileChooserDialog(
                    title="Select Base Project Directory",
                    action=Gtk.FileChooserAction.SELECT_FOLDER,
                )
                chooser.add_buttons(
                    "Cancel", Gtk.ResponseType.CANCEL,
                    "Select", Gtk.ResponseType.OK
                )
                chooser.set_position(Gtk.WindowPosition.CENTER)
                if chooser.run() == Gtk.ResponseType.OK:
                    e.set_text(chooser.get_filename())
                chooser.destroy()
            browse_btn.connect("clicked", on_browse)
            hbox.pack_start(browse_btn, False, False, 0)
            content.pack_start(hbox, False, False, 0)
        else:
            entry = Gtk.Entry()
            entry.set_placeholder_text(placeholders.get(key, ""))
            content.pack_start(entry, False, False, 0)

        # Pre-fill (filter out example values)
        current = env.get(key, "")
        if current in EXAMPLE_VALUES:
            current = ""

        if key == "DISCORD_BOT_TOKEN" and len(current) > 10:
            entry.set_placeholder_text(
                "****" + current[-6:] + " (enter full token to change)"
            )
        elif current:
            entry.set_text(current)
        else:
            default = defaults.get(key, "")
            if default:
                entry.set_text(default)

        entries[key] = entry

    note = Gtk.Label(label="* Max plan users should set Show Cost to false")
    note.set_halign(Gtk.Align.START)
    note.get_style_context().add_class("dim-label")
    content.pack_start(note, False, False, 4)

    dialog.show_all()
    response = dialog.run()

    if response == Gtk.ResponseType.OK:
        new_env = {}
        for key, _ in fields:
            val = entries[key].get_text().strip()
            if val:
                new_env[key] = val
            elif key == "DISCORD_BOT_TOKEN":
                # Keep existing token if left empty
                existing = env.get(key, "")
                if existing not in EXAMPLE_VALUES:
                    new_env[key] = existing
                else:
                    new_env[key] = ""
            else:
                new_env[key] = defaults.get(key, "")

        if not new_env.get("DISCORD_BOT_TOKEN") or not new_env.get("DISCORD_GUILD_ID") or not new_env.get("BASE_PROJECT_DIR"):
            err = Gtk.MessageDialog(
                message_type=Gtk.MessageType.ERROR,
                buttons=Gtk.ButtonsType.OK,
                text="Bot Token, Guild ID (Server ID), and Base Project Directory are required."
            )
            err.run()
            err.destroy()
            dialog.destroy()
            return

        with open(ENV_PATH, "w") as f:
            for key, _ in fields:
                if key == "SHOW_COST":
                    f.write("# Show estimated API cost in task results (set false for Max plan users)\n")
                f.write(f"{key}={new_env.get(key, '')}\n")

    dialog.destroy()

    if icon:
        update_icon(icon)
        icon.menu = create_menu()


AUTOSTART_DIR = os.path.join(os.path.expanduser("~"), ".config", "autostart")
AUTOSTART_FILE = os.path.join(AUTOSTART_DIR, "claude-discord-tray.desktop")


def is_autostart_enabled():
    return os.path.exists(AUTOSTART_FILE)


def toggle_autostart(icon, item):
    if is_autostart_enabled():
        try:
            os.remove(AUTOSTART_FILE)
        except OSError:
            pass
    else:
        os.makedirs(AUTOSTART_DIR, exist_ok=True)
        tray_script = os.path.join(BOT_DIR, "tray", "claude_tray.py")
        tray_icon = os.path.join(BOT_DIR, "docs", "icon-rounded.png")
        with open(AUTOSTART_FILE, "w") as f:
            f.write(f"""[Desktop Entry]
Type=Application
Name=Claude Discord Bot Tray
Comment=Claude Discord Bot system tray manager
Exec=/bin/bash -c 'sleep 3 && python3 {tray_script}'
Icon={tray_icon}
Terminal=false
X-GNOME-Autostart-enabled=true
StartupNotify=false
""")
        # Ensure systemd service file exists for bot management
        start_script = os.path.join(BOT_DIR, "linux-start.sh")
        subprocess.run(["/bin/bash", start_script, "--regen-service"], capture_output=True)
        subprocess.run(["loginctl", "enable-linger"], capture_output=True)
    icon.menu = create_menu()


def _refresh_oauth_token(cred_path, cred):
    """Refresh expired OAuth token and update credentials file."""
    try:
        refresh_token = cred.get("claudeAiOauth", {}).get("refreshToken", "")
        if not refresh_token:
            return None
        post_data = urllib.parse.urlencode({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
            "scope": "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
        }).encode()
        req = urllib.request.Request("https://platform.claude.com/v1/oauth/token",
                                     data=post_data, method="POST")
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        with urllib.request.urlopen(req, timeout=15) as resp:
            token_data = json.loads(resp.read().decode())
        new_access = token_data.get("access_token")
        if not new_access:
            return None
        new_refresh = token_data.get("refresh_token", refresh_token)
        expires_in = token_data.get("expires_in", 3600)
        new_expires_at = int(time.time() * 1000) + expires_in * 1000
        cred["claudeAiOauth"]["accessToken"] = new_access
        cred["claudeAiOauth"]["refreshToken"] = new_refresh
        cred["claudeAiOauth"]["expiresAt"] = new_expires_at
        with open(cred_path, "w") as f:
            json.dump(cred, f)
        return new_access
    except Exception:
        return None


def _is_token_expired(cred):
    expires_at = cred.get("claudeAiOauth", {}).get("expiresAt", 0)
    now_ms = int(time.time() * 1000)
    return now_ms >= (expires_at - 300000)


def fetch_usage(open_page_on_fail=False):
    global usage_data, usage_last_fetched
    try:
        cred_path = os.path.join(os.path.expanduser("~"), ".claude", ".credentials.json")
        if not os.path.exists(cred_path):
            if open_page_on_fail:
                webbrowser.open("https://claude.ai/settings/usage")
            return
        with open(cred_path) as f:
            cred = json.load(f)

        # Auto-refresh if expired
        if _is_token_expired(cred):
            _refresh_oauth_token(cred_path, cred)

        token = cred.get("claudeAiOauth", {}).get("accessToken", "")
        if not token:
            if open_page_on_fail:
                webbrowser.open("https://claude.ai/settings/usage")
            return

        req = urllib.request.Request("https://api.anthropic.com/api/oauth/usage")
        req.add_header("Authorization", "Bearer " + token)
        req.add_header("anthropic-beta", "oauth-2025-04-20")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 401:
                # Token invalid, try refresh and retry
                new_token = _refresh_oauth_token(cred_path, cred)
                if new_token:
                    req2 = urllib.request.Request("https://api.anthropic.com/api/oauth/usage")
                    req2.add_header("Authorization", "Bearer " + new_token)
                    req2.add_header("anthropic-beta", "oauth-2025-04-20")
                    with urllib.request.urlopen(req2, timeout=10) as resp:
                        data = json.loads(resp.read().decode())
                else:
                    raise
            else:
                raise

        usage_data = {}
        for key in ("five_hour", "seven_day", "seven_day_sonnet"):
            if key in data and "utilization" in data[key]:
                usage_data[key] = {
                    "utilization": data[key]["utilization"] / 100.0,
                    "resets_at": data[key].get("resets_at", ""),
                }
        usage_last_fetched = datetime.now()
        # Save cache
        data["_fetched_at"] = datetime.utcnow().isoformat() + "Z"
        try:
            with open(USAGE_CACHE_PATH, "w") as f:
                json.dump(data, f)
        except Exception:
            pass
    except Exception:
        if open_page_on_fail:
            webbrowser.open("https://claude.ai/settings/usage")


def load_usage_cache():
    global usage_data, usage_last_fetched
    if usage_data is not None:
        return
    try:
        from datetime import datetime
        with open(USAGE_CACHE_PATH) as f:
            data = json.load(f)
        usage_data = {}
        for key in ("five_hour", "seven_day", "seven_day_sonnet"):
            if key in data and "utilization" in data[key]:
                usage_data[key] = {
                    "utilization": data[key]["utilization"] / 100.0,
                    "resets_at": data[key].get("resets_at", ""),
                }
        fetched_str = data.get("_fetched_at", "")
        if fetched_str:
            usage_last_fetched = datetime.fromisoformat(fetched_str.replace("Z", "+00:00")).astimezone().replace(tzinfo=None)
    except Exception:
        pass


def format_reset_time(iso_str):
    if not iso_str:
        return ""
    try:
        from datetime import datetime, timezone
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        diff = (dt - datetime.now(timezone.utc)).total_seconds()
        if diff <= 0:
            return "Resetting..."
        hours = int(diff) // 3600
        minutes = (int(diff) % 3600) // 60
        if hours > 0:
            return f"Reset in {hours}h"
        return f"Reset in {minutes}m"
    except Exception:
        return ""


def format_last_fetched():
    if usage_last_fetched is None:
        return ""
    from datetime import datetime
    ago = int((datetime.now() - usage_last_fetched).total_seconds())
    if ago < 60:
        return "Updated just now"
    if ago < 3600:
        return f"Updated {ago // 60}m ago"
    return f"Updated {ago // 3600}h ago"


def show_control_panel(icon, item):
    global _control_panel_window
    try:
        import gi
        gi.require_version("Gtk", "3.0")
        from gi.repository import Gtk, Gdk, GLib, Pango
    except Exception:
        return

    if _control_panel_window is not None:
        try:
            GLib.idle_add(_control_panel_window.present)
            return
        except Exception:
            _control_panel_window = None

    def _build_panel():
        _show_control_panel_gtk(icon)
    GLib.idle_add(_build_panel)


def _show_control_panel_gtk(icon):
    global _control_panel_window
    import gi
    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk, Gdk, GLib, Pango

    def rebuild():
        nonlocal content_box
        # Clear existing content
        for child in content_box.get_children():
            content_box.remove(child)

        running = is_running()
        has_env = is_env_configured()

        # --- Header ---
        header = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        header.set_margin_start(8)
        header.set_margin_end(8)

        icon_path = os.path.join(BOT_DIR, "docs", "icon-rounded.png")
        if os.path.exists(icon_path):
            try:
                from gi.repository import GdkPixbuf
                pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(icon_path, 48, 48, True)
                img = Gtk.Image.new_from_pixbuf(pixbuf)
                header.pack_start(img, False, False, 0)
            except Exception:
                pass

        title_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        title_label = Gtk.Label()
        title_label.set_markup("<b><big>Claude Discord Bot</big></b>")
        title_label.set_halign(Gtk.Align.START)
        title_box.pack_start(title_label, False, False, 0)
        ver_label = Gtk.Label(label=current_version)
        ver_label.set_halign(Gtk.Align.START)
        ver_label.get_style_context().add_class("dim-label")
        title_box.pack_start(ver_label, False, False, 0)
        header.pack_start(title_box, True, True, 0)

        content_box.pack_start(header, False, False, 0)
        content_box.pack_start(Gtk.Separator(), False, False, 4)

        # --- Status ---
        status_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        status_box.set_margin_start(8)
        dot_color = "orange" if not has_env else ("lime" if running else "red")
        dot_label = Gtk.Label()
        dot_label.set_markup(f'<span foreground="{dot_color}" font="16">●</span>')
        status_box.pack_start(dot_label, False, False, 0)
        status_text = (
            "Setup Required" if not has_env
            else ("Running" if running else "Stopped")
        )
        status_label = Gtk.Label()
        status_label.set_markup(f"<b><big>{status_text}</big></b>")
        status_box.pack_start(status_label, False, False, 0)
        content_box.pack_start(status_box, False, False, 4)

        # --- Usage section ---
        if usage_data and len(usage_data) > 0:
            usage_frame = Gtk.Frame()
            usage_frame.set_shadow_type(Gtk.ShadowType.IN)
            usage_vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
            usage_vbox.set_margin_top(8)
            usage_vbox.set_margin_bottom(8)
            usage_vbox.set_margin_start(10)
            usage_vbox.set_margin_end(10)

            usage_title = Gtk.Label()
            usage_title.set_markup(f"<b>{'Claude Code Usage'}</b>")
            usage_title.set_halign(Gtk.Align.START)
            usage_vbox.pack_start(usage_title, False, False, 0)

            items = [
                ("five_hour", "Session (5hr)"),
                ("seven_day", "Weekly (7 day)"),
                ("seven_day_sonnet", "Weekly Sonnet"),
            ]
            for key, label in items:
                if key not in usage_data:
                    continue
                util = usage_data[key]["utilization"]
                pct = int(util * 100)
                reset = format_reset_time(usage_data[key].get("resets_at", ""))

                row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
                name_lbl = Gtk.Label(label=label)
                name_lbl.set_halign(Gtk.Align.START)
                row.pack_start(name_lbl, True, True, 0)
                pct_lbl = Gtk.Label(label=f"{pct}%")
                pct_lbl.set_halign(Gtk.Align.END)
                if util > 0.8:
                    pct_lbl.set_markup(f'<span foreground="red"><b>{pct}%</b></span>')
                elif util > 0.5:
                    pct_lbl.set_markup(f'<span foreground="orange"><b>{pct}%</b></span>')
                row.pack_end(pct_lbl, False, False, 0)
                usage_vbox.pack_start(row, False, False, 0)

                # Progress bar
                pbar = Gtk.ProgressBar()
                pbar.set_fraction(min(util, 1.0))
                pbar.set_size_request(-1, 8)
                pbar.set_show_text(False)
                # Color via CSS
                css_color = "#e05050" if util > 0.8 else "#dca032" if util > 0.5 else "#4285f4"
                css_prov = Gtk.CssProvider()
                css_prov.load_from_data(f"progressbar trough {{ min-height: 8px; }} progressbar progress {{ min-height: 8px; background-color: {css_color}; }}".encode())
                pbar.get_style_context().add_provider(css_prov, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
                usage_vbox.pack_start(pbar, False, False, 0)

                if reset:
                    reset_lbl = Gtk.Label(label=reset)
                    reset_lbl.set_halign(Gtk.Align.START)
                    reset_lbl.get_style_context().add_class("dim-label")
                    reset_lbl.modify_font(Pango.FontDescription.from_string("8"))
                    usage_vbox.pack_start(reset_lbl, False, False, 0)

            # Last fetched + refresh row
            bottom_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
            fetched_text = format_last_fetched()
            if fetched_text:
                fetched_lbl = Gtk.Label(label=fetched_text)
                fetched_lbl.get_style_context().add_class("dim-label")
                fetched_lbl.modify_font(Pango.FontDescription.from_string("8"))
                bottom_row.pack_start(fetched_lbl, True, True, 0)

            refresh_btn = Gtk.Button(label="Refresh")
            refresh_btn.set_relief(Gtk.ReliefStyle.NONE)
            def on_refresh(_b):
                threading.Thread(target=lambda: (fetch_usage(), GLib.idle_add(rebuild)), daemon=True).start()
            refresh_btn.connect("clicked", on_refresh)
            bottom_row.pack_end(refresh_btn, False, False, 0)
            usage_vbox.pack_start(bottom_row, False, False, 2)

            # Make whole usage area clickable to open web page
            usage_event = Gtk.EventBox()
            usage_event.add(usage_vbox)
            usage_event.connect("button-press-event", lambda w, e: webbrowser.open("https://claude.ai/settings/usage"))
            usage_event.set_tooltip_text("Click to open usage page")
            usage_frame.add(usage_event)
            content_box.pack_start(usage_frame, False, False, 4)
        else:
            fetch_btn = Gtk.Button(label="Load Usage Info")
            def on_fetch(_b):
                threading.Thread(target=lambda: (fetch_usage(open_page_on_fail=True), GLib.idle_add(rebuild)), daemon=True).start()
            fetch_btn.connect("clicked", on_fetch)
            content_box.pack_start(fetch_btn, False, False, 4)

        content_box.pack_start(Gtk.Separator(), False, False, 4)

        # --- Bot controls ---
        if has_env:
            btn_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
            if running:
                stop_btn = Gtk.Button(label="Stop Bot")
                stop_btn.get_style_context().add_class("destructive-action")
                stop_btn.connect("clicked", lambda _b: (stop_bot(icon, None), rebuild()))
                btn_box.pack_start(stop_btn, True, True, 0)

                restart_btn = Gtk.Button(label="Restart Bot")
                restart_btn.connect("clicked", lambda _b: (restart_bot(icon, None), rebuild()))
                btn_box.pack_start(restart_btn, True, True, 0)
            else:
                start_btn = Gtk.Button(label="Start Bot")
                start_btn.get_style_context().add_class("suggested-action")
                start_btn.connect("clicked", lambda _b: (start_bot(icon, None), rebuild()))
                btn_box.pack_start(start_btn, True, True, 0)
            content_box.pack_start(btn_box, False, False, 4)

        # Settings
        settings_btn = Gtk.Button(label="Settings...")
        settings_btn.connect("clicked", lambda _b: edit_settings(icon, None))
        content_box.pack_start(settings_btn, False, False, 2)

        if has_env:
            util_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
            log_btn = Gtk.Button(label="View Log")
            log_btn.connect("clicked", lambda _b: open_log(icon, None))
            util_box.pack_start(log_btn, True, True, 0)
            folder_btn = Gtk.Button(label="Open Folder")
            folder_btn.connect("clicked", lambda _b: open_folder(icon, None))
            util_box.pack_start(folder_btn, True, True, 0)
            content_box.pack_start(util_box, False, False, 2)

        content_box.pack_start(Gtk.Separator(), False, False, 4)

        # Autostart
        auto_check = Gtk.CheckButton(label="Launch on System Startup")
        auto_check.set_active(is_autostart_enabled())
        auto_check.connect("toggled", lambda _b: toggle_autostart(icon, None))
        content_box.pack_start(auto_check, False, False, 2)

        # Update
        if update_available:
            upd_btn = Gtk.Button(label="Update Available - Click to Update")
            upd_btn.get_style_context().add_class("suggested-action")
            upd_btn.connect("clicked", lambda _b: (win.destroy(), perform_update(icon, None)))
            content_box.pack_start(upd_btn, False, False, 2)
        else:
            chk_btn = Gtk.Button(label="Check for Updates")
            def on_check_update(_b):
                check_for_updates()
                rebuild()
                if not update_available:
                    dlg = Gtk.MessageDialog(parent=win, message_type=Gtk.MessageType.INFO,
                        buttons=Gtk.ButtonsType.OK,
                        text="You are running the latest version.")
                    dlg.run()
                    dlg.destroy()
            chk_btn.connect("clicked", on_check_update)
            content_box.pack_start(chk_btn, False, False, 2)

        content_box.pack_start(Gtk.Separator(), False, False, 4)

        # Info
        info_label = Gtk.Label(label="Closing this window does not stop the bot.\nThe bot runs in the background via systemd.")
        info_label.get_style_context().add_class("dim-label")
        info_label.modify_font(Pango.FontDescription.from_string("8"))
        content_box.pack_start(info_label, False, False, 0)

        # Quit
        quit_btn = Gtk.Button(label="Quit Bot")
        quit_btn.connect("clicked", lambda _b: (win.destroy(), quit_all(icon, None)))
        content_box.pack_start(quit_btn, False, False, 2)

        content_box.pack_start(Gtk.Separator(), False, False, 4)

        # GitHub links
        gh_link = Gtk.LinkButton.new_with_label(
            "https://github.com/chadingTV/claudecode-discord",
            "GitHub: chadingTV/claudecode-discord")
        content_box.pack_start(gh_link, False, False, 0)
        issue_link = Gtk.LinkButton.new_with_label(
            "https://github.com/chadingTV/claudecode-discord/issues",
            "Bug Report / Feature Request (GitHub Issues)")
        content_box.pack_start(issue_link, False, False, 0)
        star_label = Gtk.Label(label="If you find this useful, please give it a Star on GitHub!")
        star_label.get_style_context().add_class("dim-label")
        star_label.modify_font(Pango.FontDescription.from_string("8"))
        content_box.pack_start(star_label, False, False, 0)

        content_box.show_all()

    win = Gtk.Window(title="Claude Discord Bot")
    win.set_default_size(440, -1)
    win.set_position(Gtk.WindowPosition.CENTER)
    win.set_border_width(12)
    win.set_resizable(False)
    # Set WM_CLASS so desktop environment matches the .desktop file icon
    win.set_wmclass("claude-discord-bot", "Claude Discord Bot")

    icon_path = os.path.join(BOT_DIR, "docs", "icon.ico")
    png_path = os.path.join(BOT_DIR, "docs", "icon-rounded.png")
    try:
        if os.path.exists(png_path):
            win.set_icon_from_file(png_path)
            # Set as default icon for all windows in this app
            Gtk.Window.set_default_icon_from_file(png_path)
        elif os.path.exists(icon_path):
            win.set_icon_from_file(icon_path)
    except Exception:
        pass

    content_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
    win.add(content_box)

    _control_panel_window = win

    def on_destroy(_w):
        global _control_panel_window
        _control_panel_window = None
    win.connect("destroy", on_destroy)

    rebuild()
    win.show_all()

    # If usage data is stale (>5 min), fetch immediately on panel open
    def _fetch_if_stale():
        if usage_last_fetched is None or (datetime.now() - usage_last_fetched).total_seconds() > 300:
            fetch_usage()
            GLib.idle_add(rebuild)
    threading.Thread(target=_fetch_if_stale, daemon=True).start()


def quit_all(icon, item):
    if is_running():
        subprocess.run(["systemctl", "--user", "stop", SERVICE_NAME], capture_output=True)
    icon.stop()


def update_icon(icon):
    running = is_running()
    has_env = is_env_configured()
    if not has_env:
        color = (255, 165, 0, 255)  # orange
        icon.title = "Claude Bot: Setup Required"
    elif running:
        color = (76, 175, 80, 255)  # green
        icon.title = "Claude Bot: Running"
    else:
        color = (244, 67, 54, 255)  # red
        icon.title = "Claude Bot: Stopped"
    icon.icon = create_icon(color)


def manual_check_update(icon, item):
    check_for_updates()
    icon.menu = create_menu()
    if update_available:
        icon.notify("A new update is available. Click 'Update' in the menu.",
                    "Update Available")
    else:
        icon.notify("No updates available.",
                    "Up to Date")


def create_menu():
    running = is_running()
    has_env = is_env_configured()

    # Default item: left-click opens control panel
    panel_item = pystray.MenuItem(
        "Control Panel",
        show_control_panel, default=True, visible=False
    )

    version_item = pystray.MenuItem("Version: " + current_version, None, enabled=False)
    check_update_item = pystray.MenuItem(
        "Check for Updates",
        manual_check_update, visible=not update_available
    )
    update_item = pystray.MenuItem(
        "Update Available - Click to Update",
        perform_update, visible=update_available
    )
    autostart_item = pystray.MenuItem(
        "Launch on System Startup",
        toggle_autostart, checked=lambda item: is_autostart_enabled()
    )

    # GitHub link
    github_item = pystray.MenuItem("GitHub: chadingTV/claudecode-discord", open_github)
    issues_item = pystray.MenuItem("Bug Report / Feature Request", open_github_issues)

    if not has_env:
        return pystray.Menu(
            panel_item,
            pystray.MenuItem("Setup Required", None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Control Panel", show_control_panel),
            pystray.MenuItem("Setup...", edit_settings),
            pystray.Menu.SEPARATOR,
            autostart_item,
            version_item,
            check_update_item,
            update_item,
            pystray.Menu.SEPARATOR,
            github_item,
            issues_item,
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit", quit_all),
        )

    if running:
        return pystray.Menu(
            panel_item,
            pystray.MenuItem("Running", None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Control Panel", show_control_panel),
            pystray.MenuItem("Stop Bot", stop_bot),
            pystray.MenuItem("Restart Bot", restart_bot),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Settings...", edit_settings),
            pystray.MenuItem("View Log", open_log),
            pystray.MenuItem("Open Folder", open_folder),
            pystray.Menu.SEPARATOR,
            autostart_item,
            version_item,
            check_update_item,
            update_item,
            pystray.Menu.SEPARATOR,
            github_item,
            issues_item,
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit", quit_all),
        )
    else:
        return pystray.Menu(
            panel_item,
            pystray.MenuItem("Stopped", None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Control Panel", show_control_panel),
            pystray.MenuItem("Start Bot", start_bot),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Settings...", edit_settings),
            pystray.MenuItem("View Log", open_log),
            pystray.MenuItem("Open Folder", open_folder),
            pystray.Menu.SEPARATOR,
            autostart_item,
            version_item,
            check_update_item,
            update_item,
            pystray.Menu.SEPARATOR,
            github_item,
            issues_item,
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit", quit_all),
        )


def refresh_loop(icon):
    update_check_counter = 0
    while icon.visible:
        time.sleep(5)
        try:
            update_icon(icon)
            icon.menu = create_menu()
            # Check for git updates every 5 hours (3600 * 5s intervals)
            update_check_counter += 1
            if update_check_counter >= 3600:
                update_check_counter = 0
                check_for_updates()
                icon.menu = create_menu()
        except Exception:
            pass


def _usage_fetch_loop(icon):
    """Fetch usage on start, then every 5 minutes only while panel is open."""
    fetch_usage()
    while icon.visible:
        time.sleep(300)
        try:
            if _control_panel_window is not None:
                fetch_usage()
        except Exception:
            pass


def _install_desktop_entry():
    """Install .desktop file so taskbar shows the correct app icon."""
    apps_dir = os.path.join(os.path.expanduser("~"), ".local", "share", "applications")
    desktop_file = os.path.join(apps_dir, "claude-discord-bot.desktop")
    tray_icon = os.path.join(BOT_DIR, "docs", "icon-rounded.png")
    tray_script = os.path.join(BOT_DIR, "tray", "claude_tray.py")
    try:
        os.makedirs(apps_dir, exist_ok=True)
        with open(desktop_file, "w") as f:
            f.write(f"""[Desktop Entry]
Type=Application
Name=Claude Discord Bot
Comment=Claude Discord Bot system tray manager
Exec=python3 {tray_script}
Icon={tray_icon}
Terminal=false
StartupWMClass=claude-discord-bot
StartupNotify=false
NoDisplay=true
""")
    except Exception:
        pass


def main():
    global current_version
    current_version = get_version()
    check_for_updates()
    load_usage_cache()
    _install_desktop_entry()

    running = is_running()
    has_env = is_env_configured()
    if not has_env:
        color = (255, 165, 0, 255)  # orange
    elif running:
        color = (76, 175, 80, 255)  # green
    else:
        color = (244, 67, 54, 255)  # red

    icon = pystray.Icon(
        "claude-bot",
        create_icon(color),
        "Claude Bot",
        menu=create_menu(),
    )

    if not is_env_configured():
        # Auto-open settings if .env is missing
        def auto_open_settings():
            time.sleep(1)
            edit_settings(icon, None)
        threading.Thread(target=auto_open_settings, daemon=True).start()
    elif not is_running():
        # Auto-start if .env exists but bot is not running
        def auto_start():
            time.sleep(1)
            start_bot(icon, None)
        threading.Thread(target=auto_start, daemon=True).start()

    refresh_thread = threading.Thread(target=refresh_loop, args=(icon,), daemon=True)
    refresh_thread.start()

    usage_thread = threading.Thread(target=_usage_fetch_loop, args=(icon,), daemon=True)
    usage_thread.start()

    icon.run()


def ensure_single_instance():
    """Ensure only one tray app instance is running (PID file based)."""
    pid_file = os.path.join(BOT_DIR, ".tray.pid")
    my_pid = os.getpid()

    # Check if existing instance is alive
    if os.path.exists(pid_file):
        try:
            old_pid = int(open(pid_file).read().strip())
            if old_pid != my_pid:
                os.kill(old_pid, 0)  # Check if process exists
                # Process exists — kill it
                os.kill(old_pid, 9)
                time.sleep(0.5)
        except (ValueError, ProcessLookupError, PermissionError):
            pass  # Process already dead or invalid PID

    # Write our PID
    with open(pid_file, "w") as f:
        f.write(str(my_pid))

    # Cleanup PID file on exit
    import atexit
    atexit.register(lambda: os.remove(pid_file) if os.path.exists(pid_file) else None)


if __name__ == "__main__":
    ensure_single_instance()
    main()
