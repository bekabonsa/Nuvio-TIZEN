#!/usr/bin/env python3
import base64
import hashlib
import hmac
import html
import json
import mimetypes
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

import requests

QBT_URL = os.environ.get("QBITTORRENT_URL", "http://127.0.0.1:8080").rstrip("/")
QBT_USERNAME = os.environ.get("QBITTORRENT_USERNAME", "admin")
QBT_PASSWORD = os.environ.get("QBITTORRENT_PASSWORD", "")
BRIDGE_TOKEN = os.environ.get("BRIDGE_TOKEN", "")
BRIDGE_PORT = int(os.environ.get("BRIDGE_PORT", "8788"))
IMDB_HELPER_BASE_URL = os.environ.get("IMDB_HELPER_BASE_URL", "http://127.0.0.1:8791").rstrip("/")
FFMPEG_BIN = os.environ.get("FFMPEG_PATH", "ffmpeg")
FFPROBE_BIN = os.environ.get("FFPROBE_PATH", "ffprobe")
BRIDGE_TRANSCODE_VIDEO_CODEC = os.environ.get("BRIDGE_TRANSCODE_VIDEO_CODEC", "libx265")
BRIDGE_TRANSCODE_PRESET = os.environ.get("BRIDGE_TRANSCODE_PRESET", "faster")
BRIDGE_TRANSCODE_CRF = os.environ.get("BRIDGE_TRANSCODE_CRF", "18")
BRIDGE_TRANSCODE_AUDIO_CODEC = os.environ.get("BRIDGE_TRANSCODE_AUDIO_CODEC", "ac3")
BRIDGE_TRANSCODE_AUDIO_BITRATE = os.environ.get("BRIDGE_TRANSCODE_AUDIO_BITRATE", "640k")
BRIDGE_TRANSCODE_READ_IDLE_SECONDS = int(os.environ.get("BRIDGE_TRANSCODE_READ_IDLE_SECONDS", "120"))
DOWNLOAD_ROOT = Path(os.environ.get("DOWNLOAD_ROOT", "/srv/torrents/downloads")).resolve()
METADATA_ROOT = Path(os.environ.get("METADATA_ROOT", "/srv/torrents/metadata")).resolve()
AUTH_DB_PATH = Path(os.environ.get("NUVIO_AUTH_DB_PATH", str(METADATA_ROOT / "nuvio-auth.sqlite3"))).resolve()
AUTH_ACCESS_TOKEN_SECONDS = int(os.environ.get("NUVIO_AUTH_ACCESS_TOKEN_SECONDS", str(24 * 60 * 60)))
AUTH_REFRESH_TOKEN_SECONDS = int(os.environ.get("NUVIO_AUTH_REFRESH_TOKEN_SECONDS", str(30 * 24 * 60 * 60)))
AUTH_PASSWORD_ITERATIONS = int(os.environ.get("NUVIO_AUTH_PASSWORD_ITERATIONS", "210000"))
TV_LOGIN_SESSION_SECONDS = int(os.environ.get("NUVIO_TV_LOGIN_SESSION_SECONDS", "300"))
AUTH_ALLOW_PUBLIC_SIGNUP = os.environ.get("NUVIO_AUTH_ALLOW_PUBLIC_SIGNUP", "").lower() in ("1", "true", "yes")

HASH_RE = re.compile(r"^[a-fA-F0-9]{40}$|^[a-zA-Z2-7]{32}$")
VIDEO_EXTENSIONS = (".mkv", ".mp4", ".avi", ".mov", ".m4v", ".webm")
SUBTITLE_EXTENSIONS = (".srt", ".vtt", ".ass", ".ssa")
METADATA_KEYS = {
    "itemId",
    "itemName",
    "itemType",
    "poster",
    "background",
    "videoId",
    "videoTitle",
    "season",
    "episode",
    "streamTitle",
}
STREAM_WAIT_SECONDS = 25
STREAM_WAIT_INTERVAL_SECONDS = 0.5
SUBTITLE_WAIT_SECONDS = 60
DIRECT_VIDEO_CODECS = {"h264", "hevc", "h265"}
DIRECT_AUDIO_CODECS = {"aac", "ac3", "eac3", "mp3"}
TRANSCODE_AUDIO_CODECS = {"dts", "dca", "truehd", "mlp", "flac", "opus", "vorbis"}

session = requests.Session()
last_login = 0
preferences_cache = {"loaded_at": 0, "value": {}}


def now_seconds():
    return int(time.time())


def utc_iso(ts=None):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts or now_seconds()))


def b64url(data):
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def b64url_decode(value):
    padding = "=" * ((4 - len(value) % 4) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def normalize_email(email):
    return str(email or "").strip().lower()


def hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        str(password).encode("utf-8"),
        salt,
        AUTH_PASSWORD_ITERATIONS,
    )
    return "pbkdf2_sha256${}${}${}".format(
        AUTH_PASSWORD_ITERATIONS,
        b64url(salt),
        b64url(digest),
    )


def verify_password(password, stored):
    try:
        algorithm, iterations, salt, expected = str(stored or "").split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256",
            str(password).encode("utf-8"),
            b64url_decode(salt),
            int(iterations),
        )
        return hmac.compare_digest(b64url(digest), expected)
    except Exception:
        return False


def generate_id(prefix):
    return prefix + "_" + secrets.token_urlsafe(18)


def generate_code():
    alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
    return "".join(secrets.choice(alphabet) for _ in range(8))


def token_hash(token):
    return hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()


def db_connection():
    AUTH_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(AUTH_DB_PATH), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def bootstrap_auth_user(conn):
    email = normalize_email(os.environ.get("NUVIO_AUTH_EMAIL") or os.environ.get("NUVIO_BOOTSTRAP_EMAIL"))
    password = os.environ.get("NUVIO_AUTH_PASSWORD") or os.environ.get("NUVIO_BOOTSTRAP_PASSWORD")
    display_name = os.environ.get("NUVIO_AUTH_DISPLAY_NAME") or "Nuvio"

    if not email or not password:
        return

    existing = conn.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
    user_id = existing["id"] if existing else generate_id("usr")
    if existing:
        conn.execute(
            """
            UPDATE users
               SET password_hash=?, display_name=?, is_anonymous=0, updated_at=?
             WHERE id=?
            """,
            (hash_password(password), display_name, now_seconds(), user_id),
        )
    else:
        conn.execute(
            """
            INSERT INTO users (id,email,password_hash,display_name,is_anonymous,created_at,updated_at)
            VALUES (?,?,?,?,0,?,?)
            """,
            (user_id, email, hash_password(password), display_name, now_seconds(), now_seconds()),
        )


def bootstrap_addons(conn):
    raw = os.environ.get("NUVIO_ADDON_URLS", "")
    urls = [item.strip() for item in re.split(r"[\n,]+", raw) if item.strip()]
    email = normalize_email(os.environ.get("NUVIO_AUTH_EMAIL") or os.environ.get("NUVIO_BOOTSTRAP_EMAIL"))
    if not urls or not email:
        return
    user = conn.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
    if not user:
        return
    for index, url in enumerate(urls):
        conn.execute(
            """
            INSERT INTO addons (user_id,profile_id,url,sort_order,created_at)
            VALUES (?,?,?,?,?)
            ON CONFLICT(user_id,profile_id,url)
            DO UPDATE SET sort_order=excluded.sort_order
            """,
            (user["id"], 1, url, index, now_seconds()),
        )


def init_auth_db():
    with db_connection() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE,
                password_hash TEXT,
                display_name TEXT,
                is_anonymous INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                access_hash TEXT NOT NULL UNIQUE,
                refresh_hash TEXT UNIQUE,
                expires_at INTEGER NOT NULL,
                refresh_expires_at INTEGER,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_access_hash ON sessions(access_hash);
            CREATE INDEX IF NOT EXISTS idx_sessions_refresh_hash ON sessions(refresh_hash);
            CREATE TABLE IF NOT EXISTS tv_login_sessions (
                code TEXT PRIMARY KEY,
                device_nonce TEXT NOT NULL,
                creator_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
                status TEXT NOT NULL,
                approved_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
                expires_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS addons (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                profile_id INTEGER NOT NULL DEFAULT 1,
                url TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                UNIQUE(user_id, profile_id, url)
            );
            CREATE TABLE IF NOT EXISTS watch_progress (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                profile_id INTEGER NOT NULL DEFAULT 1,
                progress_key TEXT NOT NULL,
                content_id TEXT NOT NULL,
                content_type TEXT NOT NULL,
                video_id TEXT,
                season INTEGER,
                episode INTEGER,
                position REAL NOT NULL DEFAULT 0,
                duration REAL NOT NULL DEFAULT 0,
                last_watched TEXT,
                updated_at TEXT NOT NULL,
                UNIQUE(user_id, profile_id, progress_key)
            );
            CREATE INDEX IF NOT EXISTS idx_watch_progress_user ON watch_progress(user_id, profile_id, updated_at);
            CREATE TABLE IF NOT EXISTS library (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                profile_id INTEGER NOT NULL DEFAULT 1,
                content_id TEXT NOT NULL,
                content_type TEXT NOT NULL,
                name TEXT,
                poster TEXT,
                poster_shape TEXT,
                background TEXT,
                description TEXT,
                release_info TEXT,
                imdb_rating REAL,
                genres TEXT,
                addon_base_url TEXT,
                added_at INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(user_id, profile_id, content_type, content_id)
            );
            CREATE INDEX IF NOT EXISTS idx_library_user ON library(user_id, profile_id, updated_at);
            """
        )
        bootstrap_auth_user(conn)
        bootstrap_addons(conn)


def make_session(conn, user_id):
    access_token = secrets.token_urlsafe(48)
    refresh_token = secrets.token_urlsafe(48)
    session_id = generate_id("ses")
    now = now_seconds()
    conn.execute(
        """
        INSERT INTO sessions (id,user_id,access_hash,refresh_hash,expires_at,refresh_expires_at,created_at)
        VALUES (?,?,?,?,?,?,?)
        """,
        (
            session_id,
            user_id,
            token_hash(access_token),
            token_hash(refresh_token),
            now + AUTH_ACCESS_TOKEN_SECONDS,
            now + AUTH_REFRESH_TOKEN_SECONDS,
            now,
        ),
    )
    return {
        "session_id": session_id,
        "access_token": access_token,
        "refresh_token": refresh_token,
        "expires_in": AUTH_ACCESS_TOKEN_SECONDS,
    }


def user_payload(row):
    if not row:
        return None
    role = "anon" if row["is_anonymous"] else "authenticated"
    payload = {
        "id": row["id"],
        "aud": role,
        "role": role,
        "email": row["email"],
        "created_at": utc_iso(row["created_at"]),
        "updated_at": utc_iso(row["updated_at"]),
        "user_metadata": {},
    }
    if row["display_name"]:
        payload["user_metadata"]["name"] = row["display_name"]
    return payload


def auth_response(conn, user_row, session_payload):
    return {
        "access_token": session_payload["access_token"],
        "refresh_token": session_payload["refresh_token"],
        "expires_in": session_payload["expires_in"],
        "token_type": "bearer",
        "user": user_payload(user_row),
    }


def create_anonymous_user(conn):
    now = now_seconds()
    user_id = generate_id("anon")
    conn.execute(
        """
        INSERT INTO users (id,email,password_hash,display_name,is_anonymous,created_at,updated_at)
        VALUES (?,NULL,NULL,NULL,1,?,?)
        """,
        (user_id, now, now),
    )
    return conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()


def authenticated_user_from_header(headers, allow_anonymous=False):
    auth = headers.get("Authorization", "")
    if not auth.lower().startswith("bearer "):
        return None, None
    raw_token = auth.split(" ", 1)[1].strip()
    if not raw_token:
        return None, None
    with db_connection() as conn:
        row = conn.execute(
            """
            SELECT s.*, u.email, u.display_name, u.is_anonymous, u.created_at AS user_created_at,
                   u.updated_at AS user_updated_at
              FROM sessions s
              JOIN users u ON u.id = s.user_id
             WHERE s.access_hash=?
            """,
            (token_hash(raw_token),),
        ).fetchone()
        if not row or row["expires_at"] < now_seconds():
            return None, None
        if row["is_anonymous"] and not allow_anonymous:
            return None, None
        user = {
            "id": row["user_id"],
            "email": row["email"],
            "display_name": row["display_name"],
            "is_anonymous": row["is_anonymous"],
            "created_at": row["user_created_at"],
            "updated_at": row["user_updated_at"],
        }
        return user, row


def parse_profile_id(payload, default=1):
    try:
        return int(payload.get("p_profile_id") or payload.get("profile_id") or default)
    except Exception:
        return default


def parse_limit(payload, key, default, maximum):
    try:
        value = int(payload.get(key) or default)
    except Exception:
        value = default
    return max(0, min(value, maximum))


def json_list(value):
    if isinstance(value, list):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        except Exception:
            return []
    return []


def qbt_login():
    global last_login
    if time.time() - last_login < 300:
        return
    response = session.post(
        QBT_URL + "/api/v2/auth/login",
        data={"username": QBT_USERNAME, "password": QBT_PASSWORD},
        timeout=10,
    )
    response.raise_for_status()
    if response.text.strip() != "Ok.":
        raise RuntimeError("qBittorrent login failed")
    last_login = time.time()


def qbt_get(path, **params):
    qbt_login()
    response = session.get(QBT_URL + path, params=params, timeout=15)
    if response.status_code == 403:
        global last_login
        last_login = 0
        qbt_login()
        response = session.get(QBT_URL + path, params=params, timeout=15)
    response.raise_for_status()
    return response


def qbt_post(path, data=None, files=None):
    qbt_login()
    response = session.post(QBT_URL + path, data=data or {}, files=files, timeout=30)
    if response.status_code == 403:
        global last_login
        last_login = 0
        qbt_login()
        response = session.post(QBT_URL + path, data=data or {}, files=files, timeout=30)
    response.raise_for_status()
    return response


def qbt_preferences():
    now = time.time()
    if now - preferences_cache["loaded_at"] < 60:
        return preferences_cache["value"]
    try:
        value = qbt_get("/api/v2/app/preferences").json()
    except Exception:
        value = {}
    preferences_cache["loaded_at"] = now
    preferences_cache["value"] = value if isinstance(value, dict) else {}
    return preferences_cache["value"]


def magnet_from_payload(payload):
    magnet = str(payload.get("magnet") or "").strip()
    info_hash = str(payload.get("infoHash") or payload.get("info_hash") or "").strip()
    if magnet.startswith("magnet:?"):
        return magnet
    if info_hash and HASH_RE.match(info_hash):
        return "magnet:?xt=urn:btih:" + info_hash
    raise ValueError("Expected magnet or valid infoHash")


def hash_from_magnet(magnet):
    match = re.search(r"xt=urn:btih:([^&]+)", magnet, re.I)
    return match.group(1).lower() if match else ""


def torrent_info(torrent_hash):
    items = qbt_get("/api/v2/torrents/info", hashes=torrent_hash).json()
    return items[0] if items else None


def torrents_info():
    return qbt_get("/api/v2/torrents/info").json()


def torrent_files(torrent_hash):
    return qbt_get("/api/v2/torrents/files", hash=torrent_hash).json()


def selected_file(torrent_hash, index=None):
    files = torrent_files(torrent_hash)
    if not files:
        return None
    if index is not None:
        for item in files:
            if int(item.get("index", -1)) == int(index):
                return item
    video_files = [item for item in files if str(item.get("name", "")).lower().endswith(VIDEO_EXTENSIONS)]
    return max(video_files or files, key=lambda item: int(item.get("size") or 0))


def is_video_file(file_item):
    return str(file_item.get("name", "")).lower().endswith(VIDEO_EXTENSIONS)


def is_subtitle_file(file_item):
    return str(file_item.get("name", "")).lower().endswith(SUBTITLE_EXTENSIONS)


def normalize_match_stem(path):
    stem = Path(str(path or "")).stem.lower()
    stem = re.sub(r"\b(720p|1080p|2160p|480p|web[-_. ]?dl|web[-_. ]?rip|bluray|brrip|x264|x265|h264|h265|hevc|aac|ac3|dts)\b", " ", stem)
    stem = re.sub(r"[^a-z0-9]+", " ", stem)
    return re.sub(r"\s+", " ", stem).strip()


def episode_token(path):
    name = Path(str(path or "")).stem.lower()
    match = re.search(r"s(\d{1,2})[ ._\-]*e(\d{1,3})", name)
    if match:
        return f"s{int(match.group(1)):02d}e{int(match.group(2)):02d}"
    match = re.search(r"\b(\d{1,2})x(\d{1,3})\b", name)
    if match:
        return f"s{int(match.group(1)):02d}e{int(match.group(2)):02d}"
    return ""


def subtitle_matches_video(subtitle_item, video_item, files):
    try:
        subtitle_path = safe_relative_path(subtitle_item)
        video_path = safe_relative_path(video_item)
    except ValueError:
        return False

    if subtitle_path.parent != video_path.parent:
        return False

    video_token = episode_token(video_path.name)
    if video_token:
        return episode_token(subtitle_path.name) == video_token

    same_parent_videos = [
        item for item in files
        if is_video_file(item) and safe_relative_path(item).parent == video_path.parent
    ]
    if len(same_parent_videos) <= 1:
        return True

    subtitle_stem = normalize_match_stem(subtitle_path.name)
    video_stem = normalize_match_stem(video_path.name)
    return bool(
        subtitle_stem
        and video_stem
        and (
            subtitle_stem == video_stem
            or subtitle_stem.startswith(video_stem)
            or video_stem.startswith(subtitle_stem)
        )
    )


def subtitle_files(torrent_hash, video_item):
    if not video_item:
        return []
    files = torrent_files(torrent_hash)
    subtitles = []
    for item in files:
        if not is_subtitle_file(item):
            continue
        try:
            if subtitle_matches_video(item, video_item, files):
                subtitles.append(item)
        except Exception:
            continue
    return subtitles


def subtitle_label(file_item, index):
    relative = Path(str(file_item.get("name") or ""))
    stem = relative.stem.replace(".", " ").replace("_", " ").replace("-", " ").strip()
    return stem or f"Subtitle {index + 1}"


def subtitle_language(file_item):
    name = Path(str(file_item.get("name") or "")).stem.lower()
    if re.search(r"(^|[._\-\s])(en|eng|english)([._\-\s]|$)", name):
        return "eng"
    if re.search(r"(^|[._\-\s])(no|nor|nob|norwegian)([._\-\s]|$)", name):
        return "nor"
    if re.search(r"(^|[._\-\s])(sv|swe|swedish)([._\-\s]|$)", name):
        return "swe"
    if re.search(r"(^|[._\-\s])(da|dan|danish)([._\-\s]|$)", name):
        return "dan"
    return ""


def subtitle_format(file_item):
    suffix = Path(str(file_item.get("name") or "")).suffix.lower().lstrip(".")
    return "vtt" if suffix == "vtt" else suffix


def subtitle_entries(handler, torrent_hash, video_item, token, info=None):
    info = info or torrent_info(torrent_hash) or {}
    entries = []
    for index, item in enumerate(subtitle_files(torrent_hash, video_item)):
        file_index = int(item.get("index", index))
        language = subtitle_language(item)
        try:
            ready = bool(resolve_file_path(info, item))
        except Exception:
            ready = False
        entry = {
            "url": f"{public_base(handler)}/subtitle/{torrent_hash}/{file_index}?token={token}",
            "label": subtitle_label(item, index),
            "name": subtitle_label(item, index),
            "format": subtitle_format(item),
            "source": "torrent-bridge",
            "provider": "Torrent Bridge",
            "ready": ready,
        }
        if language:
            entry["lang"] = language
            entry["language"] = language
        entries.append(entry)
    return entries


def metadata_path(torrent_hash):
    clean_hash = str(torrent_hash or "").strip().lower()
    if not HASH_RE.match(clean_hash):
        raise ValueError("Invalid torrent hash")
    return METADATA_ROOT / f"{clean_hash}.json"


def read_metadata(torrent_hash):
    try:
        path = metadata_path(torrent_hash)
        if not path.exists():
            return {}
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def normalize_metadata(payload):
    raw = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    metadata = {}
    for key in METADATA_KEYS:
        value = raw.get(key)
        if value is None or value == "":
            continue
        metadata[key] = value
    title = str(payload.get("title") or "").strip()
    if title and "streamTitle" not in metadata:
        metadata["streamTitle"] = title
    metadata["cachedAt"] = int(time.time())
    return metadata


def write_metadata(torrent_hash, metadata):
    if not metadata:
        return
    METADATA_ROOT.mkdir(parents=True, exist_ok=True)
    path = metadata_path(torrent_hash)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(metadata, handle, ensure_ascii=True, separators=(",", ":"))


def remove_metadata(torrent_hash):
    try:
        metadata_path(torrent_hash).unlink(missing_ok=True)
    except Exception:
        pass


def safe_relative_path(file_item):
    relative = Path(str(file_item.get("name") or ""))
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("Unsafe torrent file path")
    return relative


def safe_file_path_under(root_path, relative):
    root = Path(root_path).resolve()
    path = (root / relative).resolve()
    if root not in path.parents and path != root:
        raise ValueError("Torrent file escaped save path")
    return path


def candidate_file_paths(info, file_item):
    relative = safe_relative_path(file_item)
    candidates = []
    roots = []
    preferences = qbt_preferences()
    save_path = Path(info.get("save_path") or DOWNLOAD_ROOT).resolve()
    content_path = info.get("content_path")

    roots.append(save_path)

    if content_path:
        content = Path(str(content_path)).resolve()
        if content.suffix.lower() in VIDEO_EXTENSIONS:
            candidates.append(content)
        else:
            roots.append(content)
            if relative.parts and content.name == relative.parts[0]:
                roots.append(content.parent)

    if preferences.get("temp_path_enabled"):
        temp_path = preferences.get("temp_path")
        if temp_path:
            roots.append(Path(str(temp_path)).resolve())

    for root in roots:
        try:
            candidate = safe_file_path_under(root, relative)
        except ValueError:
            continue
        candidates.append(candidate)
        if preferences.get("incomplete_files_ext"):
            candidates.append(candidate.with_name(candidate.name + ".!qB"))

    unique = []
    for candidate in candidates:
        if candidate not in unique:
            unique.append(candidate)
    return unique


def resolve_file_path(info, file_item):
    for path in candidate_file_paths(info, file_item):
        if path.exists() and path.is_file() and path.stat().st_size > 0:
            return path
    return None


def safe_file_path(info, file_item):
    return safe_file_path_under(Path(info.get("save_path") or DOWNLOAD_ROOT).resolve(), safe_relative_path(file_item))


def command_exists(command):
    if not command:
        return False
    if os.path.isabs(command) or os.sep in command:
        return Path(command).exists()
    return shutil.which(command) is not None


def ffprobe_media(path):
    if not command_exists(FFPROBE_BIN):
        return None
    try:
        result = subprocess.run(
            [
                FFPROBE_BIN,
                "-v",
                "quiet",
                "-analyzeduration",
                "100M",
                "-probesize",
                "100M",
                "-print_format",
                "json",
                "-show_streams",
                "-show_format",
                str(path),
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=30,
        )
        payload = json.loads(result.stdout or "{}")
        return payload if isinstance(payload, dict) else None
    except Exception:
        return None


def first_probe_stream(probe, codec_type):
    for stream in (probe or {}).get("streams") or []:
        if stream.get("codec_type") == codec_type:
            return stream
    return None


def probe_stream_text(stream):
    values = []
    if not stream:
        return ""
    for key in ("codec_name", "codec_long_name", "profile", "codec_tag_string", "pix_fmt", "color_transfer"):
        values.append(str(stream.get(key) or ""))
    tags = stream.get("tags") if isinstance(stream.get("tags"), dict) else {}
    for value in tags.values():
        values.append(str(value or ""))
    for item in stream.get("side_data_list") or []:
        if isinstance(item, dict):
            values.extend(str(value or "") for value in item.values())
    return " ".join(values).lower()


def media_name_text(file_item, path=None):
    values = [str(file_item.get("name") or "")]
    if path:
        values.append(path.name)
    return " ".join(values).lower()


def detects_dolby_vision(video_stream, file_item, path=None):
    text = probe_stream_text(video_stream) + " " + media_name_text(file_item, path)
    return bool(re.search(r"(^|[^a-z0-9])(dv|dovi|dolby[ ._\-]?vision)([^a-z0-9]|$)", text))


def detects_hdr(video_stream, file_item, path=None):
    text = probe_stream_text(video_stream) + " " + media_name_text(file_item, path)
    return bool(
        "smpte2084" in text
        or "arib-std-b67" in text
        or re.search(r"(^|[^a-z0-9])(hdr|hdr10|hlg)([^a-z0-9]|$)", text)
    )


def normalized_codec(stream):
    codec = str(stream.get("codec_name") or "").lower() if stream else ""
    return "h265" if codec == "hevc" else codec


def selected_playback_audio_codec(audio_stream):
    return normalized_codec(audio_stream)


def can_copy_audio_to_ts(audio_stream):
    codec = selected_playback_audio_codec(audio_stream)
    return not audio_stream or codec in DIRECT_AUDIO_CODECS


def audio_requires_transcode(audio_stream):
    codec = selected_playback_audio_codec(audio_stream)
    return bool(audio_stream and codec in TRANSCODE_AUDIO_CODECS)


def build_stream_url(handler, torrent_hash, file_index, token):
    return f"{public_base(handler)}/stream/{torrent_hash}/{file_index}?token={token}"


def build_transcode_url(handler, torrent_hash, file_index, token, mode):
    return f"{public_base(handler)}/transcode/{torrent_hash}/{file_index}?token={token}&mode={mode}"


def build_playback_plan(handler, torrent_hash, file_item, path, token):
    file_index = int(file_item.get("index", 0))
    direct_url = build_stream_url(handler, torrent_hash, file_index, token)
    probe = ffprobe_media(path)
    video = first_probe_stream(probe, "video")
    audio = first_probe_stream(probe, "audio")
    video_codec = normalized_codec(video)
    audio_codec = selected_playback_audio_codec(audio)
    reasons = []
    mode = "direct"
    compatible = True
    dolby_vision = detects_dolby_vision(video, file_item, path)
    hdr = detects_hdr(video, file_item, path)

    if dolby_vision:
        compatible = False
        mode = "transcode"
        reasons.append("Dolby Vision was detected; Samsung AVPlay commonly rejects DV in MKV.")
    elif video and video_codec and video_codec not in DIRECT_VIDEO_CODECS:
        compatible = False
        mode = "transcode"
        reasons.append(f"Video codec {video_codec} is not in the direct playback allowlist.")
    elif audio_requires_transcode(audio):
        compatible = False
        mode = "remux"
        reasons.append(f"Audio codec {audio_codec} is likely unsafe for AVPlay; video can be copied.")

    if mode == "direct":
        playback_url = direct_url
        quality = "direct"
    elif mode == "remux":
        playback_url = build_transcode_url(handler, torrent_hash, file_index, token, "remux")
        quality = "lossless-video-copy"
    else:
        playback_url = build_transcode_url(handler, torrent_hash, file_index, token, "transcode")
        quality = "high-quality-video-transcode"

    return {
        "url": playback_url,
        "directUrl": direct_url,
        "mode": mode,
        "compatible": compatible,
        "needsTranscode": mode != "direct",
        "quality": quality,
        "reasons": reasons,
        "probe": {
            "videoCodec": video_codec,
            "audioCodec": audio_codec,
            "width": video.get("width") if video else None,
            "height": video.get("height") if video else None,
            "profile": video.get("profile") if video else "",
            "hdr": hdr,
            "dolbyVision": dolby_vision,
            "container": Path(path).suffix.lower().lstrip("."),
            "ffprobe": bool(probe),
        },
    }


def normalize_transcode_mode(value, fallback):
    mode = str(value or fallback or "auto").strip().lower()
    if mode not in ("auto", "direct", "remux", "transcode"):
        return fallback if fallback in ("remux", "transcode") else "auto"
    return mode


def normalize_start_seconds(value):
    try:
        seconds = float(value or 0)
    except Exception:
        return 0
    if seconds <= 0:
        return 0
    return int(seconds)


def ffmpeg_playback_args(path, plan, mode, start_seconds, pipe_input=False):
    probe = ffprobe_media(path) or {}
    video = first_probe_stream(probe, "video")
    audio = first_probe_stream(probe, "audio")
    active_mode = normalize_transcode_mode(mode, plan.get("mode"))
    if active_mode in ("auto", "direct"):
        active_mode = plan.get("mode") if plan.get("mode") != "direct" else "remux"
    hdr = bool(plan.get("probe", {}).get("hdr")) or detects_hdr(video, {}, path)
    args = [
        FFMPEG_BIN,
        "-hide_banner",
        "-loglevel",
        "error",
        "-fflags",
        "+genpts",
    ]

    if start_seconds > 0:
        args.extend(["-ss", str(start_seconds)])

    if pipe_input:
        args.extend(["-seekable", "0"])

    args.extend([
        "-analyzeduration",
        "100M",
        "-probesize",
        "100M",
        "-i",
        "pipe:0" if pipe_input else str(path),
        "-map",
        "0:v:0",
    ])

    if audio:
        args.extend(["-map", f"0:{audio.get('index')}"])
    else:
        args.extend(["-map", "0:a:0?"])

    args.extend(["-sn", "-dn", "-map_metadata", "-1"])

    if active_mode == "transcode":
        codec = BRIDGE_TRANSCODE_VIDEO_CODEC
        args.extend(["-c:v", codec])
        if codec in ("libx265", "hevc", "hevc_nvenc", "hevc_vaapi"):
            args.extend(["-preset", BRIDGE_TRANSCODE_PRESET, "-crf", BRIDGE_TRANSCODE_CRF])
            if hdr:
                args.extend([
                    "-pix_fmt",
                    "yuv420p10le",
                    "-color_primaries",
                    "bt2020",
                    "-color_trc",
                    "smpte2084",
                    "-colorspace",
                    "bt2020nc",
                    "-x265-params",
                    "repeat-headers=1:hdr10=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc",
                ])
            else:
                args.extend(["-pix_fmt", "yuv420p"])
        elif codec in ("libx264", "h264", "h264_nvenc", "h264_vaapi"):
            args.extend(["-preset", BRIDGE_TRANSCODE_PRESET, "-crf", BRIDGE_TRANSCODE_CRF, "-pix_fmt", "yuv420p"])
    else:
        args.extend(["-c:v", "copy"])

    if audio:
        if can_copy_audio_to_ts(audio):
            args.extend(["-c:a", "copy"])
        else:
            args.extend([
                "-c:a",
                BRIDGE_TRANSCODE_AUDIO_CODEC,
                "-b:a",
                BRIDGE_TRANSCODE_AUDIO_BITRATE,
                "-ac",
                "6",
            ])
    else:
        args.extend([
            "-c:a",
            BRIDGE_TRANSCODE_AUDIO_CODEC,
            "-b:a",
            BRIDGE_TRANSCODE_AUDIO_BITRATE,
            "-ac",
            "6",
        ])

    args.extend([
        "-avoid_negative_ts",
        "make_zero",
        "-muxdelay",
        "0",
        "-muxpreload",
        "0",
        "-mpegts_flags",
        "+resend_headers",
        "-f",
        "mpegts",
        "pipe:1",
    ])
    return args, active_mode


def file_progress_value(info, file_item):
    for source in (file_item, info):
        try:
            value = float(source.get("progress"))
            if value >= 0:
                return min(1.0, value)
        except Exception:
            continue
    return 0.0


def should_pipe_growing_file(info, file_item, start_seconds):
    return start_seconds <= 0 and file_progress_value(info, file_item) < 0.999


def feed_growing_file(stdin, path, total_size):
    position = 0
    idle_started = None
    try:
        with path.open("rb") as handle:
            while position < total_size:
                try:
                    available = path.stat().st_size
                except FileNotFoundError:
                    available = 0

                if position >= available:
                    if idle_started is None:
                        idle_started = time.time()
                    if time.time() - idle_started >= BRIDGE_TRANSCODE_READ_IDLE_SECONDS:
                        break
                    time.sleep(STREAM_WAIT_INTERVAL_SECONDS)
                    continue

                idle_started = None
                handle.seek(position)
                to_read = min(1024 * 1024, available - position)
                chunk = handle.read(to_read)
                if not chunk:
                    time.sleep(STREAM_WAIT_INTERVAL_SECONDS)
                    continue
                stdin.write(chunk)
                stdin.flush()
                position += len(chunk)
    except (BrokenPipeError, ConnectionResetError):
        pass
    finally:
        try:
            stdin.close()
        except Exception:
            pass


def prioritize_selected_file(torrent_hash, preferred_index):
    if preferred_index is None or preferred_index == "":
        return

    selected_index = str(preferred_index)
    files = []
    for _ in range(12):
        try:
            files = torrent_files(torrent_hash)
        except Exception:
            files = []
        if files:
            break
        time.sleep(0.5)

    if not files:
        return

    selected_item = None
    for item in files:
        if str(item.get("index")) == selected_index:
            selected_item = item
            break

    kept_indices = {selected_index}
    if selected_item:
        for item in files:
            try:
                if is_subtitle_file(item) and subtitle_matches_video(item, selected_item, files):
                    kept_indices.add(str(item.get("index")))
            except Exception:
                continue

    all_indices = [str(item.get("index")) for item in files if item.get("index") is not None]
    other_indices = [index for index in all_indices if index not in kept_indices]
    if other_indices:
        try:
            qbt_post(
                "/api/v2/torrents/filePrio",
                data={"hash": torrent_hash, "id": "|".join(other_indices), "priority": "0"},
            )
        except Exception:
            pass
    if selected_index in all_indices:
        try:
            qbt_post(
                "/api/v2/torrents/filePrio",
                data={"hash": torrent_hash, "id": "|".join(sorted(kept_indices)), "priority": "7"},
            )
        except Exception:
            pass


def public_base(handler):
    host = handler.headers.get("Host", "")
    proto = handler.headers.get("X-Forwarded-Proto", "http")
    return proto + "://" + host


def make_status(handler, torrent_hash, preferred_index=None, info=None):
    info = info or torrent_info(torrent_hash)
    if not info:
        return {"hash": torrent_hash, "found": False, "ready": False}
    torrent_hash = str(info.get("hash") or torrent_hash).lower()
    file_item = selected_file(torrent_hash, preferred_index)
    stream_url = None
    playback = None
    file_exists = False
    subtitles = []
    token = parse_qs(urlparse(handler.path).query).get("token", [""])[0] or BRIDGE_TOKEN
    if file_item:
        path = None
        try:
            path = resolve_file_path(info, file_item)
            file_exists = bool(path)
        except Exception:
            file_exists = False
        try:
            subtitles = subtitle_entries(handler, torrent_hash, file_item, token, info)
        except Exception:
            subtitles = []
        if file_exists:
            file_index = int(file_item.get("index", 0))
            stream_url = build_stream_url(handler, torrent_hash, file_index, token)
            playback = build_playback_plan(handler, torrent_hash, file_item, path, token)
            playback["live"] = file_progress_value(info, file_item) < 0.999
            playback["fileProgress"] = file_progress_value(info, file_item)
    return {
        "hash": torrent_hash,
        "found": True,
        "ready": bool(stream_url),
        "name": info.get("name"),
        "state": info.get("state"),
        "progress": info.get("progress"),
        "downloadSpeed": info.get("dlspeed"),
        "eta": info.get("eta"),
        "seeds": info.get("num_seeds"),
        "size": info.get("size"),
        "totalSize": info.get("total_size"),
        "amountLeft": info.get("amount_left"),
        "addedOn": info.get("added_on"),
        "completedOn": info.get("completion_on"),
        "savePath": info.get("save_path"),
        "contentPath": info.get("content_path"),
        "file": file_item,
        "metadata": read_metadata(torrent_hash),
        "streamUrl": stream_url,
        "playbackUrl": playback.get("url") if playback else stream_url,
        "playback": playback,
        "subtitles": subtitles,
    }


def list_statuses(handler):
    statuses = []
    for item in torrents_info():
        torrent_hash = str(item.get("hash") or "").lower()
        if not torrent_hash:
            continue
        try:
            statuses.append(make_status(handler, torrent_hash, None, item))
        except Exception as error:
            statuses.append({
                "hash": torrent_hash,
                "found": True,
                "ready": False,
                "name": item.get("name"),
                "state": item.get("state"),
                "progress": item.get("progress"),
                "error": str(error),
                "metadata": read_metadata(torrent_hash),
            })
    statuses.sort(key=lambda item: item.get("addedOn") or item.get("metadata", {}).get("cachedAt") or 0, reverse=True)
    return statuses


class Handler(BaseHTTPRequestHandler):
    server_version = "NuvioBridge/0.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - - [%s] %s\n" % (self.client_address[0], self.log_date_time_string(), fmt % args))

    def authorized(self):
        if not BRIDGE_TOKEN:
            return False
        auth = self.headers.get("Authorization", "")
        query_token = parse_qs(urlparse(self.path).query).get("token", [""])[0]
        return auth == "Bearer " + BRIDGE_TOKEN or query_token == BRIDGE_TOKEN

    def send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, Range, Accept, apikey, x-client-info")
        self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
        self.send_header("Access-Control-Max-Age", "86400")

    def send_json(self, code, payload):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(code)
        self.send_cors_headers()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_html(self, code, markup):
        body = markup.encode("utf-8")
        self.send_response(code)
        self.send_cors_headers()
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def read_json(self):
        body = self.read_body()
        if not body:
            return {}
        return json.loads(body.decode("utf-8"))

    def read_form(self):
        body = self.read_body()
        if not body:
            return {}
        return {key: values[0] if values else "" for key, values in parse_qs(body.decode("utf-8")).items()}

    def current_user(self, allow_anonymous=False):
        return authenticated_user_from_header(self.headers, allow_anonymous=allow_anonymous)[0]

    def require_user(self, allow_anonymous=False):
        user = self.current_user(allow_anonymous=allow_anonymous)
        if not user:
            self.send_json(401, {"error": "Unauthorized"})
            return None
        return user

    def handle_auth_token(self, parsed):
        grant_type = parse_qs(parsed.query).get("grant_type", ["password"])[0]
        payload = self.read_json()
        try:
            with db_connection() as conn:
                if grant_type == "password":
                    email = normalize_email(payload.get("email"))
                    password = payload.get("password") or ""
                    user = conn.execute(
                        "SELECT * FROM users WHERE email=? AND is_anonymous=0",
                        (email,),
                    ).fetchone()
                    if not user or not verify_password(password, user["password_hash"]):
                        self.send_json(400, {"error": "invalid_grant", "message": "Invalid email or password"})
                        return
                    session_payload = make_session(conn, user["id"])
                    self.send_json(200, auth_response(conn, user, session_payload))
                    return

                if grant_type == "refresh_token":
                    refresh_token = payload.get("refresh_token") or ""
                    session_row = conn.execute(
                        "SELECT * FROM sessions WHERE refresh_hash=?",
                        (token_hash(refresh_token),),
                    ).fetchone()
                    if not session_row or not session_row["refresh_expires_at"] or session_row["refresh_expires_at"] < now_seconds():
                        self.send_json(401, {"error": "invalid_grant", "message": "Refresh token expired"})
                        return
                    user = conn.execute("SELECT * FROM users WHERE id=?", (session_row["user_id"],)).fetchone()
                    conn.execute("DELETE FROM sessions WHERE id=?", (session_row["id"],))
                    session_payload = make_session(conn, user["id"])
                    self.send_json(200, auth_response(conn, user, session_payload))
                    return

                if grant_type == "anonymous":
                    user = create_anonymous_user(conn)
                    session_payload = make_session(conn, user["id"])
                    self.send_json(200, auth_response(conn, user, session_payload))
                    return

                self.send_json(400, {"error": "unsupported_grant_type", "message": "Unsupported grant type"})
        except Exception as error:
            self.send_json(500, {"error": "Auth failed", "message": str(error)})

    def handle_auth_signup(self):
        payload = self.read_json()
        email = normalize_email(payload.get("email"))
        password = payload.get("password") or ""
        try:
            with db_connection() as conn:
                if not email:
                    user = create_anonymous_user(conn)
                    session_payload = make_session(conn, user["id"])
                    self.send_json(200, auth_response(conn, user, session_payload))
                    return

                if not AUTH_ALLOW_PUBLIC_SIGNUP:
                    self.send_json(403, {"error": "signup_disabled", "message": "Public account signup is disabled"})
                    return

                if not password:
                    self.send_json(400, {"error": "invalid_request", "message": "Password is required"})
                    return

                existing = conn.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
                if existing:
                    self.send_json(409, {"error": "user_exists", "message": "User already exists"})
                    return
                now = now_seconds()
                user_id = generate_id("usr")
                conn.execute(
                    """
                    INSERT INTO users (id,email,password_hash,display_name,is_anonymous,created_at,updated_at)
                    VALUES (?,?,?,?,0,?,?)
                    """,
                    (
                        user_id,
                        email,
                        hash_password(password),
                        payload.get("display_name") or email,
                        now,
                        now,
                    ),
                )
                user = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
                session_payload = make_session(conn, user["id"])
                self.send_json(200, auth_response(conn, user, session_payload))
        except Exception as error:
            self.send_json(500, {"error": "Signup failed", "message": str(error)})

    def handle_auth_user(self):
        user = self.require_user(allow_anonymous=True)
        if not user:
            return
        self.send_json(200, {"user": user_payload(user)})

    def handle_addons_query(self, parsed, legacy=False):
        user = self.require_user()
        if not user:
            return
        params = parse_qs(parsed.query)
        profile_id = 1
        if "profile_id" in params:
            value = params["profile_id"][0]
            if value.startswith("eq."):
                value = value[3:]
            try:
                profile_id = int(value)
            except Exception:
                profile_id = 1
        with db_connection() as conn:
            rows = conn.execute(
                """
                SELECT url, sort_order
                  FROM addons
                 WHERE user_id=? AND profile_id=?
                 ORDER BY sort_order ASC, id ASC
                """,
                (user["id"], profile_id),
            ).fetchall()
        if legacy:
            self.send_json(200, [{"base_url": row["url"], "position": row["sort_order"]} for row in rows])
        else:
            self.send_json(200, [{"url": row["url"], "sort_order": row["sort_order"]} for row in rows])

    def handle_rpc(self, rpc_name):
        allow_anonymous = rpc_name in ("start_tv_login_session", "poll_tv_login_session")
        user = self.require_user(allow_anonymous=allow_anonymous)
        if not user:
            return
        payload = self.read_json()

        try:
            if rpc_name == "get_sync_owner":
                self.send_json(200, user["id"])
                return
            if rpc_name == "sync_pull_addons":
                self.handle_sync_pull_addons(user, payload)
                return
            if rpc_name == "sync_pull_watch_progress":
                self.handle_sync_pull_watch_progress(user, payload)
                return
            if rpc_name == "sync_push_watch_progress":
                self.handle_sync_push_watch_progress(user, payload)
                return
            if rpc_name == "sync_delete_watch_progress":
                self.handle_sync_delete_watch_progress(user, payload)
                return
            if rpc_name == "sync_pull_library":
                self.handle_sync_pull_library(user, payload)
                return
            if rpc_name == "sync_push_library":
                self.handle_sync_push_library(user, payload)
                return
            if rpc_name == "start_tv_login_session":
                self.handle_start_tv_login_session(user, payload)
                return
            if rpc_name == "poll_tv_login_session":
                self.handle_poll_tv_login_session(payload)
                return
            self.send_json(404, {"error": "Could not find the function"})
        except Exception as error:
            self.send_json(500, {"error": "RPC failed", "message": str(error)})

    def handle_sync_pull_addons(self, user, payload):
        profile_id = parse_profile_id(payload)
        with db_connection() as conn:
            rows = conn.execute(
                """
                SELECT url, sort_order
                  FROM addons
                 WHERE user_id=? AND profile_id=?
                 ORDER BY sort_order ASC, id ASC
                """,
                (user["id"], profile_id),
            ).fetchall()
        self.send_json(200, [{"url": row["url"], "sort_order": row["sort_order"]} for row in rows])

    def handle_sync_pull_watch_progress(self, user, payload):
        profile_id = parse_profile_id(payload)
        limit = parse_limit(payload, "p_limit", 50, 500)
        with db_connection() as conn:
            rows = conn.execute(
                """
                SELECT progress_key, content_id, content_type, video_id, season, episode,
                       position, duration, last_watched, updated_at
                  FROM watch_progress
                 WHERE user_id=? AND profile_id=?
                 ORDER BY updated_at DESC, id DESC
                 LIMIT ?
                """,
                (user["id"], profile_id, limit),
            ).fetchall()
        self.send_json(200, [dict(row) for row in rows])

    def handle_sync_push_watch_progress(self, user, payload):
        profile_id = parse_profile_id(payload)
        entries = payload.get("p_entries") if isinstance(payload.get("p_entries"), list) else []
        updated_at = utc_iso()
        with db_connection() as conn:
            for entry in entries:
                progress_key = str(entry.get("progress_key") or entry.get("content_id") or "").strip()
                content_id = str(entry.get("content_id") or "").strip()
                content_type = str(entry.get("content_type") or "").strip()
                if not progress_key or not content_id or not content_type:
                    continue
                conn.execute(
                    """
                    INSERT INTO watch_progress (
                        user_id, profile_id, progress_key, content_id, content_type, video_id,
                        season, episode, position, duration, last_watched, updated_at
                    )
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(user_id, profile_id, progress_key)
                    DO UPDATE SET
                        content_id=excluded.content_id,
                        content_type=excluded.content_type,
                        video_id=excluded.video_id,
                        season=excluded.season,
                        episode=excluded.episode,
                        position=excluded.position,
                        duration=excluded.duration,
                        last_watched=excluded.last_watched,
                        updated_at=excluded.updated_at
                    """,
                    (
                        user["id"],
                        profile_id,
                        progress_key,
                        content_id,
                        content_type,
                        entry.get("video_id"),
                        entry.get("season"),
                        entry.get("episode"),
                        float(entry.get("position") or 0),
                        float(entry.get("duration") or 0),
                        entry.get("last_watched"),
                        updated_at,
                    ),
                )
        self.send_json(200, {"ok": True})

    def handle_sync_delete_watch_progress(self, user, payload):
        profile_id = parse_profile_id(payload)
        keys = [str(item) for item in payload.get("p_keys", []) if str(item)]
        if not keys:
            self.send_json(200, {"ok": True})
            return
        placeholders = ",".join("?" for _ in keys)
        with db_connection() as conn:
            conn.execute(
                f"""
                DELETE FROM watch_progress
                 WHERE user_id=? AND profile_id=?
                   AND (progress_key IN ({placeholders}) OR content_id IN ({placeholders}))
                """,
                [user["id"], profile_id] + keys + keys,
            )
        self.send_json(200, {"ok": True})

    def handle_sync_pull_library(self, user, payload):
        profile_id = parse_profile_id(payload)
        limit = parse_limit(payload, "p_limit", 500, 1000)
        offset = parse_limit(payload, "p_offset", 0, 100000)
        with db_connection() as conn:
            rows = conn.execute(
                """
                SELECT id, user_id, profile_id, content_id, content_type, name, poster, poster_shape,
                       background, description, release_info, imdb_rating, genres, addon_base_url,
                       added_at, created_at, updated_at
                  FROM library
                 WHERE user_id=? AND profile_id=?
                 ORDER BY updated_at DESC, id DESC
                 LIMIT ? OFFSET ?
                """,
                (user["id"], profile_id, limit, offset),
            ).fetchall()
        payload_rows = []
        for row in rows:
            item = dict(row)
            item["genres"] = json_list(item.get("genres"))
            payload_rows.append(item)
        self.send_json(200, payload_rows)

    def handle_sync_push_library(self, user, payload):
        profile_id = parse_profile_id(payload)
        items = payload.get("p_items") if isinstance(payload.get("p_items"), list) else []
        updated_at = utc_iso()
        kept_keys = []
        with db_connection() as conn:
            for item in items:
                content_id = str(item.get("content_id") or "").strip()
                content_type = str(item.get("content_type") or "").strip()
                if not content_id or not content_type:
                    continue
                kept_keys.append((content_type, content_id))
                created_at = item.get("created_at") or item.get("added_at") or updated_at
                if isinstance(created_at, (int, float)):
                    created_at = utc_iso(float(created_at) / 1000 if created_at > 10000000000 else float(created_at))
                conn.execute(
                    """
                    INSERT INTO library (
                        user_id, profile_id, content_id, content_type, name, poster, poster_shape,
                        background, description, release_info, imdb_rating, genres, addon_base_url,
                        added_at, created_at, updated_at
                    )
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(user_id, profile_id, content_type, content_id)
                    DO UPDATE SET
                        name=excluded.name,
                        poster=excluded.poster,
                        poster_shape=excluded.poster_shape,
                        background=excluded.background,
                        description=excluded.description,
                        release_info=excluded.release_info,
                        imdb_rating=excluded.imdb_rating,
                        genres=excluded.genres,
                        addon_base_url=excluded.addon_base_url,
                        added_at=excluded.added_at,
                        updated_at=excluded.updated_at
                    """,
                    (
                        user["id"],
                        profile_id,
                        content_id,
                        content_type,
                        item.get("name"),
                        item.get("poster"),
                        item.get("poster_shape") or "POSTER",
                        item.get("background"),
                        item.get("description"),
                        item.get("release_info"),
                        item.get("imdb_rating"),
                        json.dumps(item.get("genres") if isinstance(item.get("genres"), list) else [], separators=(",", ":")),
                        item.get("addon_base_url"),
                        item.get("added_at"),
                        str(created_at),
                        updated_at,
                    ),
                )
            existing = conn.execute(
                "SELECT content_type, content_id FROM library WHERE user_id=? AND profile_id=?",
                (user["id"], profile_id),
            ).fetchall()
            for row in existing:
                key = (row["content_type"], row["content_id"])
                if key not in kept_keys:
                    conn.execute(
                        "DELETE FROM library WHERE user_id=? AND profile_id=? AND content_type=? AND content_id=?",
                        (user["id"], profile_id, key[0], key[1]),
                    )
        self.send_json(200, {"ok": True})

    def handle_start_tv_login_session(self, user, payload):
        device_nonce = str(payload.get("p_device_nonce") or "").strip()
        if not device_nonce:
            self.send_json(400, {"error": "invalid_request", "message": "Device nonce is required"})
            return
        redirect_base = str(payload.get("p_redirect_base_url") or "").strip() or public_base(self) + "/tv-login"
        code = generate_code()
        expires_at = now_seconds() + TV_LOGIN_SESSION_SECONDS
        with db_connection() as conn:
            while conn.execute("SELECT 1 FROM tv_login_sessions WHERE code=?", (code,)).fetchone():
                code = generate_code()
            conn.execute(
                """
                INSERT INTO tv_login_sessions (
                    code, device_nonce, creator_user_id, status, approved_user_id,
                    expires_at, created_at, updated_at
                )
                VALUES (?,?,?,?,NULL,?,?,?)
                """,
                (code, device_nonce, user["id"], "pending", expires_at, now_seconds(), now_seconds()),
            )
        web_url = redirect_base + ("&" if "?" in redirect_base else "?") + "code=" + quote(code)
        self.send_json(200, {
            "code": code,
            "web_url": web_url,
            "qr_content": web_url,
            "expires_at": utc_iso(expires_at),
            "poll_interval_seconds": 3,
        })

    def tv_login_status(self, conn, code, device_nonce=None):
        row = conn.execute("SELECT * FROM tv_login_sessions WHERE code=?", (code,)).fetchone()
        if not row:
            return None, "expired"
        if device_nonce is not None and not hmac.compare_digest(row["device_nonce"], device_nonce):
            return None, "expired"
        if row["expires_at"] < now_seconds() and row["status"] != "approved":
            conn.execute(
                "UPDATE tv_login_sessions SET status='expired', updated_at=? WHERE code=?",
                (now_seconds(), code),
            )
            return row, "expired"
        return row, row["status"]

    def handle_poll_tv_login_session(self, payload):
        code = str(payload.get("p_code") or "").strip().upper()
        device_nonce = str(payload.get("p_device_nonce") or "").strip()
        with db_connection() as conn:
            _, status = self.tv_login_status(conn, code, device_nonce)
        self.send_json(200, {"status": status if status in ("pending", "approved", "expired") else "expired"})

    def handle_tv_login_exchange(self):
        user = self.require_user(allow_anonymous=True)
        if not user:
            return
        payload = self.read_json()
        code = str(payload.get("code") or "").strip().upper()
        device_nonce = str(payload.get("device_nonce") or "").strip()
        with db_connection() as conn:
            row, status = self.tv_login_status(conn, code, device_nonce)
            if not row or status != "approved" or not row["approved_user_id"]:
                self.send_json(409, {"error": "not_approved", "message": "TV login has not been approved"})
                return
            approved_user = conn.execute("SELECT * FROM users WHERE id=?", (row["approved_user_id"],)).fetchone()
            session_payload = make_session(conn, approved_user["id"])
            conn.execute(
                "UPDATE tv_login_sessions SET status='exchanged', updated_at=? WHERE code=?",
                (now_seconds(), code),
            )
            self.send_json(200, auth_response(conn, approved_user, session_payload))

    def render_tv_login_page(self, code, message="", tone=""):
        code = str(code or "").strip().upper()
        safe_code = html.escape(code)
        safe_message = html.escape(message)
        status_class = "error" if tone == "error" else "success" if tone == "success" else ""
        message_markup = f'<p class="message {status_class}">{safe_message}</p>' if safe_message else ""
        return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nuvio TV Login</title>
  <style>
    body {{
      margin: 0;
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #101418;
      color: #f7f9fb;
      display: grid;
      place-items: center;
    }}
    main {{
      width: min(92vw, 420px);
      padding: 28px;
      background: #1a2027;
      border: 1px solid #303945;
      border-radius: 8px;
      box-shadow: 0 22px 60px rgba(0,0,0,.34);
    }}
    h1 {{ margin: 0 0 8px; font-size: 26px; }}
    p {{ margin: 0 0 18px; color: #b9c2cc; line-height: 1.45; }}
    label {{ display: block; margin: 14px 0 6px; color: #d7dee7; font-size: 14px; }}
    input {{
      width: 100%;
      box-sizing: border-box;
      padding: 12px 13px;
      border-radius: 6px;
      border: 1px solid #46515d;
      background: #0f1419;
      color: #f7f9fb;
      font-size: 16px;
    }}
    button {{
      width: 100%;
      margin-top: 18px;
      padding: 13px;
      border: 0;
      border-radius: 6px;
      background: #24a37b;
      color: #06110d;
      font-weight: 700;
      font-size: 16px;
    }}
    .code {{ color: #f7f9fb; font-weight: 700; letter-spacing: .08em; }}
    .message {{ margin-top: 14px; }}
    .message.error {{ color: #ffaaa5; }}
    .message.success {{ color: #8fe7c5; }}
  </style>
</head>
<body>
  <main>
    <h1>Connect Nuvio TV</h1>
    <p>Approve code <span class="code">{safe_code}</span> by signing in with your Nuvio account.</p>
    <form method="post" action="/tv-login">
      <input type="hidden" name="code" value="{safe_code}">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="email" required>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Approve TV Login</button>
    </form>
    {message_markup}
  </main>
</body>
</html>"""

    def handle_tv_login_page(self, parsed):
        code = parse_qs(parsed.query).get("code", [""])[0]
        if not code:
            self.send_html(400, self.render_tv_login_page("", "Missing TV login code.", "error"))
            return
        with db_connection() as conn:
            _, status = self.tv_login_status(conn, code)
        if status == "expired":
            self.send_html(410, self.render_tv_login_page(code, "This TV login code expired. Refresh the QR code on the TV.", "error"))
            return
        if status == "approved":
            self.send_html(200, self.render_tv_login_page(code, "This TV login is already approved.", "success"))
            return
        self.send_html(200, self.render_tv_login_page(code))

    def handle_tv_login_approval(self):
        form = self.read_form()
        code = str(form.get("code") or "").strip().upper()
        email = normalize_email(form.get("email"))
        password = form.get("password") or ""
        with db_connection() as conn:
            row, status = self.tv_login_status(conn, code)
            if not row or status == "expired":
                self.send_html(410, self.render_tv_login_page(code, "This TV login code expired. Refresh the QR code on the TV.", "error"))
                return
            if status == "approved":
                self.send_html(200, self.render_tv_login_page(code, "This TV login is already approved.", "success"))
                return
            user = conn.execute(
                "SELECT * FROM users WHERE email=? AND is_anonymous=0",
                (email,),
            ).fetchone()
            if not user or not verify_password(password, user["password_hash"]):
                self.send_html(401, self.render_tv_login_page(code, "Invalid email or password.", "error"))
                return
            conn.execute(
                """
                UPDATE tv_login_sessions
                   SET status='approved', approved_user_id=?, updated_at=?
                 WHERE code=?
                """,
                (user["id"], now_seconds(), code),
            )
            self.send_html(200, self.render_tv_login_page(code, "Approved. You can return to the TV.", "success"))

    def proxy_imdb_helper(self, parsed):
        helper_path = parsed.path[len("/imdb"):] or "/"
        target_url = IMDB_HELPER_BASE_URL + helper_path
        if parsed.query:
            target_url += "?" + parsed.query

        try:
            response = requests.get(target_url, timeout=70)
        except Exception as error:
            self.send_json(502, {"error": "IMDb helper unavailable", "message": str(error)})
            return

        body = response.content
        self.send_response(response.status_code)
        self.send_cors_headers()
        self.send_header("Content-Type", response.headers.get("Content-Type", "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.send_json(200, {"ok": True})
            return
        if parsed.path == "/imdb" or parsed.path.startswith("/imdb/"):
            self.proxy_imdb_helper(parsed)
            return
        if parsed.path == "/tv-login":
            self.handle_tv_login_page(parsed)
            return
        if parsed.path == "/auth/v1/user":
            self.handle_auth_user()
            return
        if parsed.path == "/rest/v1/addons":
            self.handle_addons_query(parsed)
            return
        if parsed.path == "/rest/v1/tv_addons":
            self.handle_addons_query(parsed, legacy=True)
            return
        if not self.authorized():
            self.send_json(401, {"error": "Unauthorized"})
            return
        if parsed.path == "/api/torrents":
            self.send_json(200, {"items": list_statuses(self)})
            return
        status_match = re.match(r"^/api/torrents/([^/]+)$", parsed.path)
        if status_match:
            params = parse_qs(parsed.query)
            index = params.get("fileIndex", [None])[0]
            self.send_json(200, make_status(self, status_match.group(1), index))
            return
        stream_match = re.match(r"^/stream/([^/]+)/(\d+)$", parsed.path)
        if stream_match:
            self.stream_file(stream_match.group(1), int(stream_match.group(2)))
            return
        transcode_match = re.match(r"^/transcode/([^/]+)/(\d+)$", parsed.path)
        if transcode_match:
            self.transcode_file(transcode_match.group(1), int(transcode_match.group(2)))
            return
        subtitle_match = re.match(r"^/subtitle/([^/]+)/(\d+)$", parsed.path)
        if subtitle_match:
            self.subtitle_file(subtitle_match.group(1), int(subtitle_match.group(2)))
            return
        self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/auth/v1/token":
            self.handle_auth_token(parsed)
            return
        if parsed.path == "/auth/v1/signup":
            self.handle_auth_signup()
            return
        if parsed.path == "/functions/v1/tv-logins-exchange":
            self.handle_tv_login_exchange()
            return
        if parsed.path == "/tv-login":
            self.handle_tv_login_approval()
            return
        rpc_match = re.match(r"^/rest/v1/rpc/([^/]+)$", parsed.path)
        if rpc_match:
            self.handle_rpc(rpc_match.group(1))
            return
        if not self.authorized():
            self.send_json(401, {"error": "Unauthorized"})
            return
        if parsed.path != "/api/torrents":
            self.send_json(404, {"error": "Not found"})
            return
        try:
            payload = self.read_json()
            magnet = magnet_from_payload(payload)
            torrent_hash = hash_from_magnet(magnet)
            metadata = normalize_metadata(payload)
            qbt_post(
                "/api/v2/torrents/add",
                data={
                    "urls": magnet,
                    "savepath": str(DOWNLOAD_ROOT),
                    "sequentialDownload": "true",
                    "firstLastPiecePrio": "true",
                    "paused": "false",
                },
            )
            prioritize_selected_file(torrent_hash, payload.get("fileIndex"))
            write_metadata(torrent_hash, metadata)
            self.send_json(202, make_status(self, torrent_hash, payload.get("fileIndex")))
        except Exception as error:
            self.send_json(400, {"error": str(error)})

    def do_DELETE(self):
        if not self.authorized():
            self.send_json(401, {"error": "Unauthorized"})
            return

        parsed = urlparse(self.path)
        match = re.match(r"^/api/torrents/([^/]+)$", parsed.path)
        if not match:
            self.send_json(404, {"error": "Not found"})
            return

        torrent_hash = match.group(1).strip().lower()
        if not HASH_RE.match(torrent_hash):
            self.send_json(400, {"error": "Invalid torrent hash"})
            return

        params = parse_qs(parsed.query)
        delete_files = params.get("deleteFiles", ["1"])[0] not in ("0", "false", "False", "no")
        try:
            qbt_post(
                "/api/v2/torrents/delete",
                data={
                    "hashes": torrent_hash,
                    "deleteFiles": "true" if delete_files else "false",
                },
            )
            remove_metadata(torrent_hash)
            self.send_json(200, {"ok": True, "hash": torrent_hash, "deletedFiles": delete_files})
        except Exception as error:
            self.send_json(400, {"error": str(error)})

    def stream_file(self, torrent_hash, index):
        info = torrent_info(torrent_hash)
        if not info:
            self.send_json(404, {"error": "Torrent not found"})
            return
        file_item = selected_file(torrent_hash, index)
        if not file_item:
            self.send_json(404, {"error": "File not found"})
            return
        try:
            path = resolve_file_path(info, file_item)
        except Exception as error:
            self.send_json(400, {"error": str(error)})
            return
        if not path:
            self.send_json(409, {"error": "File is not ready yet"})
            return
        total_size = int(file_item.get("size") or path.stat().st_size)
        available_size = path.stat().st_size
        start, requested_end = 0, None
        range_header = self.headers.get("Range")
        if range_header:
            match = re.match(r"bytes=(\d*)-(\d*)", range_header)
            if match:
                if match.group(1):
                    start = int(match.group(1))
                if match.group(2):
                    requested_end = int(match.group(2))

        wait_started = time.time()
        while start >= available_size and start < total_size and time.time() - wait_started < STREAM_WAIT_SECONDS:
            time.sleep(STREAM_WAIT_INTERVAL_SECONDS)
            try:
                available_size = path.stat().st_size
            except FileNotFoundError:
                available_size = 0

        if start >= available_size or start >= total_size:
            self.send_response(416)
            self.send_cors_headers()
            self.send_header("Content-Range", f"bytes */{total_size}")
            self.end_headers()
            return

        if requested_end is None:
            end = available_size - 1
        else:
            end = min(requested_end, available_size - 1, total_size - 1)

        if end < start:
            self.send_response(416)
            self.send_cors_headers()
            self.send_header("Content-Range", f"bytes */{total_size}")
            self.end_headers()
            return

        length = end - start + 1
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(206 if range_header else 200)
        self.send_cors_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("Content-Range", f"bytes {start}-{end}/{total_size}")
        self.end_headers()
        with path.open("rb") as handle:
            handle.seek(start)
            remaining = length
            while remaining > 0:
                chunk = handle.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def transcode_file(self, torrent_hash, index):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        requested_mode = params.get("mode", ["auto"])[0]
        start_seconds = normalize_start_seconds(params.get("start", [0])[0])
        info = torrent_info(torrent_hash)
        if not info:
            self.send_json(404, {"error": "Torrent not found"})
            return
        file_item = selected_file(torrent_hash, index)
        if not file_item:
            self.send_json(404, {"error": "File not found"})
            return
        if not command_exists(FFMPEG_BIN):
            self.send_json(500, {"error": "ffmpeg is not available on this bridge node"})
            return
        try:
            path = resolve_file_path(info, file_item)
        except Exception as error:
            self.send_json(400, {"error": str(error)})
            return
        if not path:
            self.send_json(409, {"error": "File is not ready yet"})
            return

        token = params.get("token", [""])[0] or BRIDGE_TOKEN
        plan = build_playback_plan(self, str(info.get("hash") or torrent_hash).lower(), file_item, path, token)
        total_size = int(file_item.get("size") or path.stat().st_size)
        pipe_input = should_pipe_growing_file(info, file_item, start_seconds)
        args, active_mode = ffmpeg_playback_args(path, plan, requested_mode, start_seconds, pipe_input)
        try:
            child = subprocess.Popen(
                args,
                stdin=subprocess.PIPE if pipe_input else subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
        except Exception as error:
            self.send_json(500, {"error": str(error)})
            return

        if pipe_input:
            threading.Thread(
                target=feed_growing_file,
                args=(child.stdin, path, total_size),
                daemon=True,
            ).start()

        self.send_response(200)
        self.send_cors_headers()
        self.send_header("Content-Type", "video/mp2t")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Nuvio-Playback-Mode", active_mode)
        self.end_headers()

        try:
            while True:
                chunk = child.stdout.read(1024 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            try:
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        child.kill()
            finally:
                if child.stdout:
                    child.stdout.close()

    def subtitle_file(self, torrent_hash, index):
        info = torrent_info(torrent_hash)
        if not info:
            self.send_json(404, {"error": "Torrent not found"})
            return
        file_item = None
        try:
            for item in torrent_files(torrent_hash):
                if int(item.get("index", -1)) == int(index) and is_subtitle_file(item):
                    file_item = item
                    break
        except Exception as error:
            self.send_json(400, {"error": str(error)})
            return
        if not file_item:
            self.send_json(404, {"error": "Subtitle not found"})
            return

        try:
            qbt_post(
                "/api/v2/torrents/filePrio",
                data={"hash": torrent_hash, "id": str(index), "priority": "7"},
            )
        except Exception:
            pass

        wait_started = time.time()
        path = None
        while time.time() - wait_started < SUBTITLE_WAIT_SECONDS:
            try:
                path = resolve_file_path(info, file_item)
            except Exception as error:
                self.send_json(400, {"error": str(error)})
                return
            if path:
                break
            time.sleep(STREAM_WAIT_INTERVAL_SECONDS)

        if not path:
            self.send_json(409, {"error": "Subtitle is not ready yet"})
            return

        content_type = mimetypes.guess_type(path.name)[0] or "text/plain"
        body = path.read_bytes()
        self.send_response(200)
        self.send_cors_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    if not BRIDGE_TOKEN:
        raise SystemExit("BRIDGE_TOKEN is required")
    DOWNLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    METADATA_ROOT.mkdir(parents=True, exist_ok=True)
    init_auth_db()
    server = ThreadingHTTPServer(("0.0.0.0", BRIDGE_PORT), Handler)
    print(f"Nuvio bridge listening on 0.0.0.0:{BRIDGE_PORT}", flush=True)
    print(f"Nuvio auth database: {AUTH_DB_PATH}", flush=True)
    server.serve_forever()
