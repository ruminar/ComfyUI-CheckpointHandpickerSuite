import asyncio
import base64
import io
import json
import logging
import math
import os
import random
import re
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

import folder_paths
import numpy as np
from aiohttp import web
from PIL import Image, ImageOps
from server import PromptServer

logger = logging.getLogger(__name__)

# v9h: ImageDirPreview right-click event separation and blank-area suppression.
# v9g: ImageDirPreview right-click capture fix for ComfyUI/LiteGraph context menu.
# v9f: ImageDirPreview context menu foundation and Set as checkpoint thumbnail.
# v9e: add top-tier god checkpoint status.
# v9d: sticky/current-selection thumbnail popup refinement.
# v9c: ListSelector hover thumbnail popup.
# v9b: v8l baseline plus delete-script thumbnail sidecar candidates.
# v8g: restore-safe Cycler runtime controls, global shuffle deck, and UI regression fixes.
EXTENSION_PREFIX = "checkpoint_handpicker_suite"
PREVIEW_EVENT = "ruminar.checkpoint_handpicker_suite.preview"
CYCLER_EVENT = "ruminar.checkpoint_handpicker_suite.cycler"
TAGGER_EVENT = "ruminar.checkpoint_handpicker_suite.tagger"
STATUS_CHANGED_EVENT = "ruminar.checkpoint_handpicker_suite.status_changed"

STATUS_VALUES = ["god", "favorite", "nice", "keep", "delete", "none"]
STATUS_ICON = {"god": "👑", "favorite": "💛", "nice": "👍", "keep": "✔", "delete": "🗑", "none": "—"}
STATUS_LABEL = {"god": "god!", "favorite": "favorite", "nice": "nice", "keep": "keep", "delete": "delete", "none": "none"}

NODE_DIR = Path(__file__).resolve().parent
DATA_DIR = NODE_DIR / "data"
STATUS_DB_PATH = DATA_DIR / "checkpoint_statuses.json"
FAVORITES_COMPAT_PATH = DATA_DIR / "checkpoint_favorites.json"
try:
    TEMP_DIR = Path(folder_paths.get_temp_directory()).resolve()
except Exception:
    TEMP_DIR = NODE_DIR / "temp"
DELETE_QUEUE_PATH = TEMP_DIR / "checkpoint_delete_queue.jsonl"
DELETE_SCRIPT_PATH = TEMP_DIR / "delete_reserved_checkpoints.py"

JPEG_QUALITY = 80
JPEG_OPTIMIZE = False
GAP = 6
IMAGE_DIR_DEFAULT_MAX_IMAGES = 12
IMAGE_DIR_MAX_IMAGES = 80
IMAGE_DIR_SCAN_LIMIT = 3000
MAX_CONTENT_EDGE = 4096
ALLOWED_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
ALLOWED_THUMBNAIL_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
ALLOWED_CHECKPOINT_SUFFIX = ".safetensors"

_STATE_LOCK = threading.Lock()
_CYCLER_STATES: dict[str, dict] = {}
_TAGGER_STATES: dict[str, dict] = {}
_PREVIEW_STATES: dict[str, dict] = {}
_TAB_EXECUTION_STATES: dict[str, dict] = {}
_EXECUTION_REVISION = 0


def _clean_tab_id(value) -> str:
    value = str(value or "").strip()
    if not value:
        return "__legacy__"
    value = re.sub(r"[^0-9A-Za-z_.:-]+", "_", value)[:128]
    return value or "__legacy__"


def _state_key(tab_id, node_id) -> str:
    return f"{_clean_tab_id(tab_id)}:{str(node_id or '__none__')}"


@dataclass
class SheetLayout:
    cols: int
    rows: int
    tile_width: int
    tile_height: int
    canvas_width: int
    canvas_height: int
    count: int


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _ensure_data_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _normalize_relpath(value: str) -> str:
    return str(PurePosixPath(str(value or "").replace("\\", "/")))


def _is_valid_checkpoint_relpath(value: str) -> bool:
    if not value or not isinstance(value, str):
        return False
    value = value.replace("\\", "/")
    path = PurePosixPath(value)
    if path.is_absolute():
        return False
    if any(part in ("", ".", "..") for part in path.parts):
        return False
    return value.lower().endswith(ALLOWED_CHECKPOINT_SUFFIX)


def _ckpt_name_safe_from_relpath(value: str) -> str:
    relpath = _normalize_relpath(value)
    if relpath.lower().endswith(ALLOWED_CHECKPOINT_SUFFIX):
        relpath = relpath[:-len(ALLOWED_CHECKPOINT_SUFFIX)]
    return re.sub(r"[^0-9A-Za-z_-]+", "_", relpath).strip("_") or "checkpoint"


def _safe_json_write(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _load_status_db() -> dict:
    _ensure_data_dir()
    if not STATUS_DB_PATH.exists():
        return {"version": 1, "statuses": {}}
    try:
        data = json.loads(STATUS_DB_PATH.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("root must be object")
        statuses = data.setdefault("statuses", {})
        if not isinstance(statuses, dict):
            data["statuses"] = {}
        data.setdefault("version", 1)
        return data
    except Exception:
        logger.exception("Failed to read checkpoint_statuses.json; using empty database")
        return {"version": 1, "statuses": {}}


def _save_status_db(data: dict):
    _safe_json_write(STATUS_DB_PATH, data)
    favorites = {}
    for relpath, entry in data.get("statuses", {}).items():
        if entry.get("status") == "favorite":
            favorites[relpath] = {
                "ckpt_name_str": relpath,
                "ckpt_name_safe": _ckpt_name_safe_from_relpath(relpath),
                "favorited_at": entry.get("updated_at", _now_iso()),
                "last_seen_at": entry.get("updated_at", _now_iso()),
            }
    _safe_json_write(FAVORITES_COMPAT_PATH, {"version": 1, "favorites": favorites})


def _get_status(relpath: str) -> str:
    relpath = _normalize_relpath(relpath)
    db = _load_status_db()
    entry = db.get("statuses", {}).get(relpath) or {}
    status = entry.get("status", "none")
    return status if status in STATUS_VALUES else "none"


def _set_status(relpath: str, status: str):
    relpath = _normalize_relpath(relpath)
    if not _is_valid_checkpoint_relpath(relpath):
        raise ValueError("Invalid checkpoint path")
    if status not in STATUS_VALUES:
        raise ValueError(f"Invalid status: {status}")
    db = _load_status_db()
    statuses = db.setdefault("statuses", {})
    if status == "none":
        statuses.pop(relpath, None)
    else:
        statuses[relpath] = {
            "status": status,
            "updated_at": _now_iso(),
            "ckpt_name_safe": _ckpt_name_safe_from_relpath(relpath),
        }
    _save_status_db(db)


def _get_supported_checkpoint_extensions() -> set[str]:
    default_extensions = {".ckpt", ".pt", ".bin", ".pth", ".safetensors"}
    extensions = getattr(folder_paths, "supported_pt_extensions", None)
    if not extensions:
        return default_extensions
    return {str(ext).lower() for ext in extensions}


def _clear_checkpoint_filename_cache():
    cache = getattr(folder_paths, "filename_list_cache", None)
    if isinstance(cache, dict):
        cache.pop("checkpoints", None)


def _checkpoint_roots() -> list[Path]:
    try:
        roots = folder_paths.get_folder_paths("checkpoints")
    except Exception:
        roots = []
    return [Path(p).resolve() for p in roots]


def _get_checkpoint_list() -> list[str]:
    """Return ComfyUI's normal checkpoint list order.

    This order is intentionally not re-sorted here. Before Refresh All has patched
    every checkpoint combo type, CheckpointNameCycler must expose the same combo
    ordering as ComfyUI's standard CheckpointLoaderSimple, otherwise combo output
    types can diverge and fail when the queue starts.
    """
    try:
        names = folder_paths.get_filename_list("checkpoints")
    except Exception:
        logger.exception("Failed to list checkpoints")
        names = []
    seen = set()
    out = []
    for name in names:
        relpath = _normalize_relpath(name)
        if relpath in seen or not _is_valid_checkpoint_relpath(relpath):
            continue
        seen.add(relpath)
        out.append(relpath)
    return out


def _scan_registered_checkpoint_folders() -> list[str]:
    results = set()
    extensions = _get_supported_checkpoint_extensions()
    for root in _checkpoint_roots():
        try:
            if not root.exists() or not root.is_dir():
                continue
            for dirpath, _dirnames, filenames in os.walk(root):
                dirpath = Path(dirpath)
                for filename in filenames:
                    if Path(filename).suffix.lower() not in extensions:
                        continue
                    try:
                        relpath = Path(dirpath, filename).resolve().relative_to(root).as_posix()
                    except Exception:
                        continue
                    results.add(_normalize_relpath(relpath))
        except Exception:
            logger.exception("Failed to scan checkpoint root: %s", root)
    return sorted(results, key=lambda value: value.lower())


def _get_fresh_checkpoint_values() -> list[str]:
    results = set()
    _clear_checkpoint_filename_cache()
    try:
        results.update(_normalize_relpath(name) for name in folder_paths.get_filename_list("checkpoints"))
    except Exception:
        logger.exception("Failed to refresh checkpoint list through folder_paths")
    try:
        results.update(_scan_registered_checkpoint_folders())
    except Exception:
        logger.exception("Failed to refresh checkpoint list by scanning folders")
    return sorted((x for x in results if x), key=lambda value: value.lower())


def _checkpoint_items() -> list[dict]:
    items = []
    for relpath in _get_checkpoint_list():
        status = _get_status(relpath)
        icon = STATUS_ICON[status] if status != "none" else "  "
        label = f"{icon} {relpath}" if icon.strip() else f"   {relpath}"
        items.append({
            "ckpt_name": relpath,
            "ckpt_name_str": relpath,
            "ckpt_name_safe": _ckpt_name_safe_from_relpath(relpath),
            "status": status,
            "status_icon": STATUS_ICON[status],
            "label": label,
        })
    return items


def _delete_status_summary() -> dict[str, int]:
    checkpoints = _get_checkpoint_list()
    counts = {s: 0 for s in STATUS_VALUES if s != "none"}
    for relpath in checkpoints:
        status = _get_status(relpath)
        if status in counts:
            counts[status] += 1
    counts["none"] = len(checkpoints) - sum(counts.values())
    counts["total"] = len(checkpoints)
    return counts


def _status_summary_text(prefix: str) -> str:
    summary = _delete_status_summary()
    return (
        f"{prefix}: {summary['total']} total "
        f"(👑:{summary['god']}, 💛:{summary['favorite']}, 👍:{summary['nice']}, ✔:{summary['keep']}, 🗑:{summary['delete']}, —:{summary['none']})"
    )


def _status_icons_for_filter(active_statuses: list[str]) -> str:
    return "".join(STATUS_ICON[s] for s in ["god", "favorite", "nice", "keep", "delete", "none"] if s in active_statuses)


def _filter_display(active_statuses: list[str]) -> str:
    icons = _status_icons_for_filter(active_statuses)
    return icons or "all"


def _log_widget_refresh(updated_count: int):
    logger.info("[CheckpointHandpickerSuite] Updated checkpoint widgets: %s", updated_count)


def _parse_saved_int(value, fallback: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return fallback


def _parse_saved_bool(value, fallback: bool = True) -> bool:
    text = str(value or "").strip().lower()
    if not text:
        return fallback
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return fallback


def _normalize_status_list(value) -> list[str]:
    raw = value
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return []
        try:
            raw = json.loads(text)
        except Exception:
            raw = [x.strip() for x in text.split(",")]
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    seen = {str(x).strip() for x in raw if str(x).strip() in STATUS_VALUES}
    return [s for s in STATUS_VALUES if s in seen]


def _valid_mode(value) -> str:
    value = str(value or "increment")
    return value if value in {"fixed", "increment", "randomize", "shuffle_once"} else "increment"


def _valid_change_every(value) -> int:
    try:
        n = int(value)
    except Exception:
        n = 1
    return max(1, min(999999, n))


def _get_default_cycler_state() -> dict:
    return {
        # runtime_controls are the live controls used by the next execution.
        # Python function arguments are only a fallback when the frontend state
        # has not been initialized yet.
        "runtime_controls": {
            "mode": "increment",
            "change_every": 1,
            "start_checkpoint": "",
            "active_filter": [],
            "use_local_list": True,
            "settings_revision": 0,
        },
        "runtime_controls_initialized": False,
        # runtime_state: mutable execution inventory/decks/counters.
        "local_list": [],
        "local_index": 0,
        "override_queue": [],
        "current_index": 0,
        "repeat_count": 0,
        "cycle_count": 0,
        "shuffle_deck": [],
        # last_execution_snapshot is the original record of the last checkpoint
        # that was actually returned downstream. Local List contents are NOT
        # stored here; they are a separate runtime_state ledger.
        "last_execution_snapshot": None,
        # legacy mirrors kept for old JS/payload compatibility.
        "use_local_list": True,
        "accept_queue": True,
        "active_filter": [],
        "settings_revision": 0,
        "last_ckpt_name": "",
        "last_normal_ckpt_name": "",
        "last_source": "cycle",
        "last_title": "Checkpoint Name Cycler",
        "last_status_text": "Current: (not executed yet)",
        "last_hold_index": 0,
        "last_change_every": 1,
        "last_mode": "increment",
        "last_start_checkpoint": "",
        "execution_revision": 0,
    }


def _get_cycler_state(key: str) -> dict:
    with _STATE_LOCK:
        state = _CYCLER_STATES.get(key)
        if state is None:
            state = _get_default_cycler_state()
            _CYCLER_STATES[key] = state
        return state


def _runtime_controls_from_state(state: dict) -> dict:
    raw = state.get("runtime_controls")
    if not isinstance(raw, dict):
        raw = {}
    controls = {
        "mode": _valid_mode(raw.get("mode", state.get("last_mode", "increment"))),
        "change_every": _valid_change_every(raw.get("change_every", state.get("last_change_every", 1))),
        "start_checkpoint": _normalize_relpath(raw.get("start_checkpoint", state.get("last_start_checkpoint", ""))),
        "active_filter": _normalize_status_list(raw.get("active_filter", state.get("active_filter", []))),
        "use_local_list": bool(raw.get("use_local_list", state.get("use_local_list", True))),
        "settings_revision": _parse_saved_int(raw.get("settings_revision", state.get("settings_revision", 0)), 0),
    }
    state["runtime_controls"] = controls
    # Keep legacy mirrors in sync. These mirrors are runtime controls, not last
    # execution facts.
    state["last_mode"] = controls["mode"]
    state["last_change_every"] = controls["change_every"]
    state["last_start_checkpoint"] = controls["start_checkpoint"]
    state["active_filter"] = list(controls["active_filter"])
    state["use_local_list"] = controls["use_local_list"]
    state["accept_queue"] = controls["use_local_list"]
    state["settings_revision"] = controls["settings_revision"]
    return controls


def _set_runtime_controls(state: dict, *, mode=None, change_every=None, start_checkpoint=None, active_filter=None, use_local_list=None, settings_revision=None, mark_initialized=True) -> dict:
    controls = _runtime_controls_from_state(state)
    if mode is not None:
        controls["mode"] = _valid_mode(mode)
    if change_every is not None:
        controls["change_every"] = _valid_change_every(change_every)
    if start_checkpoint is not None:
        controls["start_checkpoint"] = _normalize_relpath(start_checkpoint)
    if active_filter is not None:
        controls["active_filter"] = _normalize_status_list(active_filter)
    if use_local_list is not None:
        controls["use_local_list"] = bool(use_local_list)
    if settings_revision is not None:
        controls["settings_revision"] = max(0, _parse_saved_int(settings_revision, controls.get("settings_revision", 0)))
    state["runtime_controls"] = controls
    if mark_initialized:
        state["runtime_controls_initialized"] = True
    return _runtime_controls_from_state(state)


def _last_execution_snapshot(state: dict) -> dict:
    snap = state.get("last_execution_snapshot")
    if isinstance(snap, dict) and snap.get("ckpt_name"):
        return snap
    # Migrate old last_* fields if present.
    ckpt = state.get("last_ckpt_name", "") or ""
    if not ckpt:
        return {}
    return {
        "ckpt_name": ckpt,
        "ckpt_name_safe": _ckpt_name_safe_from_relpath(ckpt),
        "source": state.get("last_source", "cycle"),
        "mode_used": state.get("last_mode", "increment"),
        "base_mode": state.get("last_mode", "increment"),
        "change_every_used": _valid_change_every(state.get("last_change_every", 1)),
        "hold_index": max(0, _parse_saved_int(state.get("last_hold_index"), 0)),
        "filter_used": list(state.get("active_filter", [])),
        "fallback_all": False,
    }


def _should_accept_settings_update(state: dict, revision: int) -> tuple[bool, int]:
    revision = max(0, _parse_saved_int(revision, 0))
    current = max(0, _parse_saved_int(state.get("settings_revision"), 0))
    if revision >= current:
        return True, revision
    return False, current


def _cycler_state_payload(state: dict) -> dict:
    controls = _runtime_controls_from_state(state)
    snap = _last_execution_snapshot(state)
    ckpt = snap.get("ckpt_name", "") or ""
    status = _get_status(ckpt) if ckpt else "none"
    active_filter = list(controls.get("active_filter", []))
    valid_local_items = _valid_local_list(state.get("local_list", []))
    local_count = len(valid_local_items)
    filter_matches = _filter_match_count(active_filter)
    use_local = bool(controls.get("use_local_list", True))

    if ckpt:
        display_source = snap.get("source", "cycle")
        hold_index = max(0, _parse_saved_int(snap.get("hold_index"), 0))
        change_every = _valid_change_every(snap.get("change_every_used", controls.get("change_every", 1)))
        mode_used = snap.get("mode_used", controls.get("mode", "increment"))
        fallback_all = bool(snap.get("fallback_all", False))
        title = _build_cycler_title(display_source, ckpt, hold_index, change_every, active_filter, fallback_all, local_count if use_local else 0)
        status_text = _build_cycler_status_text(
            display_source,
            ckpt,
            active_filter,
            fallback_all,
            [],
            hold_index,
            change_every,
            filter_matches,
            local_count,
            mode_used,
            local_items=valid_local_items,
            use_local_list=use_local,
            shuffle_deck_remaining=(
                len(state.get("shuffle_deck", []))
                if display_source != "local_list" and (snap.get("base_mode", mode_used) == "shuffle_once" or mode_used == "shuffle_once")
                else None
            ),
        )
    else:
        title = "Checkpoint Name Cycler"
        status_text = _build_cycler_idle_status_text("", state)

    state["last_title"] = title
    state["last_status_text"] = status_text
    return {
        "ckpt_name_str": ckpt,
        "ckpt_name_safe": _ckpt_name_safe_from_relpath(ckpt) if ckpt else "",
        "status": status,
        "status_icon": STATUS_ICON[status],
        "title": title,
        "status_text": status_text,
        "use_local_list": bool(controls.get("use_local_list", True)),
        "active_filter": active_filter,
        "filter_matches": filter_matches,
        "filter_total": _checkpoint_total_count(),
        "settings_revision": _parse_saved_int(controls.get("settings_revision"), 0),
        "local_list_count": len(valid_local_items),
        "local_list_items": valid_local_items,
        "runtime_controls": {
            "mode": controls.get("mode", "increment"),
            "change_every": controls.get("change_every", 1),
            "start_checkpoint": controls.get("start_checkpoint", ""),
            "active_filter": active_filter,
            "use_local_list": bool(controls.get("use_local_list", True)),
            "settings_revision": _parse_saved_int(controls.get("settings_revision"), 0),
        },
        "runtime_controls_initialized": bool(state.get("runtime_controls_initialized", False)),
        "shuffle_deck_remaining": len(state.get("shuffle_deck", [])),
        "mode": controls.get("mode", "increment"),
        "change_every": controls.get("change_every", 1),
        "start_checkpoint": controls.get("start_checkpoint", ""),
        "last_execution_snapshot": snap,
        "execution_revision": state.get("execution_revision", 0),
    }


def _store_tagger_state(tab_id, node_id, ckpt_name_str, status):
    key = _state_key(tab_id, node_id)
    with _STATE_LOCK:
        _TAGGER_STATES[key] = {
            "ckpt_name_str": ckpt_name_str,
            "ckpt_name_safe": _ckpt_name_safe_from_relpath(ckpt_name_str) if ckpt_name_str else "",
            "status": status,
            "status_icon": STATUS_ICON.get(status, "—"),
            "updated_at": _now_iso(),
        }


def _store_preview_state(tab_id, node_id, ckpt_name_str, status, **extra):
    key = _state_key(tab_id, node_id)
    with _STATE_LOCK:
        _PREVIEW_STATES[key] = {
            "ckpt_name_str": ckpt_name_str,
            "ckpt_name_safe": _ckpt_name_safe_from_relpath(ckpt_name_str) if ckpt_name_str else "",
            "status": status,
            "status_icon": STATUS_ICON.get(status, "—"),
            "updated_at": _now_iso(),
            **extra,
        }


def _store_tab_execution_state(tab_id, payload: dict):
    global _EXECUTION_REVISION
    with _STATE_LOCK:
        _EXECUTION_REVISION += 1
        payload = dict(payload)
        payload["execution_revision"] = _EXECUTION_REVISION
        payload["updated_at"] = _now_iso()
        _TAB_EXECUTION_STATES[_clean_tab_id(tab_id)] = payload
        return payload


def _get_tab_execution_state(tab_id) -> dict:
    with _STATE_LOCK:
        return dict(_TAB_EXECUTION_STATES.get(_clean_tab_id(tab_id), {}))


def _send_event(name: str, payload: dict, client_id=None):
    try:
        server = PromptServer.instance
        client_id = client_id or getattr(server, "client_id", None)
        if client_id:
            server.send_sync(name, payload, client_id)
        else:
            server.send_sync(name, payload)
    except Exception:
        logger.exception("[CheckpointHandpickerSuite] failed to send event: %s", name)


def _send_status_changed(relpath: str, tab_id: str = "", node_id=None):
    status = _get_status(relpath)
    _send_event(STATUS_CHANGED_EVENT, {
        "node": int(node_id) if str(node_id or "").isdigit() else None,
        "tab_id": _clean_tab_id(tab_id),
        "node_class": "CheckpointStatusTagger",
        "ckpt_name_str": relpath,
        "ckpt_name_safe": _ckpt_name_safe_from_relpath(relpath),
        "status": status,
        "status_icon": STATUS_ICON[status],
    })


def _send_cycler_state_update(node_id, state: dict, tab_id: str = ""):
    payload = _cycler_state_payload(state)
    payload.update({
        "node": int(node_id) if str(node_id or "").isdigit() else None,
        "tab_id": _clean_tab_id(tab_id),
        "node_class": "CheckpointNameCycler",
    })
    _send_event(CYCLER_EVENT, payload)


def _split_state_key(key: str) -> tuple[str, str]:
    tab_id, sep, node_id = str(key or "").partition(":")
    if not sep:
        return "__legacy__", tab_id
    return tab_id, node_id


def _refresh_cycler_states_for_status_change(relpath: str):
    """Resend affected Cycler state after a tag/status change.

    This keeps the current title, status panel, filter match count, and Local
    List item icons in sync without mutating the Cycler title from frontend
    STATUS_CHANGED_EVENT handling. Events are sent after releasing _STATE_LOCK.
    """
    relpath = _normalize_relpath(relpath)
    updates: list[tuple[str, str, dict]] = []
    with _STATE_LOCK:
        for key, state in list(_CYCLER_STATES.items()):
            snap = _last_execution_snapshot(state)
            last_ckpt = _normalize_relpath(snap.get("ckpt_name", "") or state.get("last_ckpt_name", ""))
            local_items = {_normalize_relpath(item) for item in state.get("local_list", [])}
            controls = state.get("runtime_controls") if isinstance(state.get("runtime_controls"), dict) else {}
            active_filter = _normalize_status_list(controls.get("active_filter", state.get("active_filter", [])))
            if last_ckpt != relpath and relpath not in local_items and not active_filter:
                continue
            tab_id, node_id = _split_state_key(key)
            if not node_id or node_id == "__none__":
                continue
            updates.append((tab_id, node_id, state))
    for tab_id, node_id, state in updates:
        _send_cycler_state_update(node_id, state, tab_id=tab_id)


def _send_cycler_update(node_id, title, status_text, tab_id="", **extra):
    payload = {
        "node": int(node_id) if str(node_id or "").isdigit() else None,
        "tab_id": _clean_tab_id(tab_id),
        "node_class": "CheckpointNameCycler",
        "title": title,
        "status_text": status_text,
        **extra,
    }
    _send_event(CYCLER_EVENT, payload)


def _send_preview(node_id, title, image: Image.Image | None, extra: dict | None = None, tab_id: str = ""):
    extra = dict(extra or {})
    payload = {
        "node": int(node_id) if str(node_id or "").isdigit() else None,
        "tab_id": _clean_tab_id(tab_id),
        "title": title,
        **extra,
    }
    if image is None:
        payload.update({"image": None, "format": "jpeg"})
    else:
        payload.update(_encode_preview_payload(image))
    _send_event(PREVIEW_EVENT, payload)


def _active_delete_records() -> dict[str, dict]:
    active = {}
    if not DELETE_QUEUE_PATH.exists():
        return active
    try:
        for line in DELETE_QUEUE_PATH.read_text(encoding="utf-8", errors="replace").splitlines():
            if not line.strip():
                continue
            rec = json.loads(line)
            typ = rec.get("type")
            relpath = _normalize_relpath(rec.get("ckpt_name_str", ""))
            rid = rec.get("id")
            if typ == "reserve" and rid and relpath:
                active[relpath] = rec
            elif typ == "cancel":
                if relpath:
                    active.pop(relpath, None)
                elif rid:
                    for key, value in list(active.items()):
                        if value.get("id") == rid:
                            active.pop(key, None)
    except Exception:
        logger.exception("Failed to parse delete queue")
    return active


def _append_delete_record(record: dict):
    DELETE_QUEUE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with DELETE_QUEUE_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def _resolve_checkpoint_unique(ckpt_name_str: str):
    relpath = _normalize_relpath(ckpt_name_str)
    if not _is_valid_checkpoint_relpath(relpath):
        return None
    candidates = []
    for root in _checkpoint_roots():
        path = (root / relpath).resolve()
        try:
            path.relative_to(root)
        except Exception:
            continue
        if path.exists() and path.is_file():
            candidates.append(path)
    if len(candidates) != 1:
        return None
    path = candidates[0]
    return {"path": str(path), "root": str(path.parent), "json_path": str(path.with_suffix(".json"))}


def _is_path_under_root(path: Path, root: Path) -> bool:
    try:
        path = Path(path).resolve()
        root = Path(root).resolve()
        return path == root or root in path.parents
    except Exception:
        return False


def _checkpoint_thumbnail_candidates(safetensors_path: Path) -> list[Path]:
    """Return conservative sidecar thumbnail candidates for a checkpoint.

    Only files in the same directory as the checkpoint are considered. This is
    intentionally stricter than ImageDirPreview source-image scanning: delete
    script targets must be direct sidecars, not arbitrary generated images.
    """
    path = Path(safetensors_path).resolve()
    parent = path.parent
    stem = path.stem
    name = path.name
    patterns: list[str] = []
    for ext in sorted(ALLOWED_THUMBNAIL_SUFFIXES):
        patterns.extend([
            f"{stem}{ext}",
            f"{name}{ext}",
            f"{stem}.thumbnail{ext}",
            f"{stem}.thumb{ext}",
            f"{stem}.preview{ext}",
            f"{name}.thumbnail{ext}",
            f"{name}.thumb{ext}",
            f"{name}.preview{ext}",
        ])
    candidates: list[Path] = []
    seen: set[str] = set()
    for pattern in patterns:
        candidate = (parent / pattern).resolve()
        if str(candidate) in seen:
            continue
        seen.add(str(candidate))
        if candidate.exists() and candidate.is_file():
            candidates.append(candidate)
    return candidates


def _load_sidecar_thumbnail_preview(relpath: str) -> tuple[Image.Image | None, str]:
    """Load the first conservative sidecar thumbnail for a checkpoint.

    This is the display counterpart of the v9b delete-script sidecar policy.
    It intentionally does not scan output/review folders or ImageDirPreview
    source directories: hover thumbnails are direct checkpoint sidecars only.
    """
    resolved = _resolve_checkpoint_unique(relpath)
    if not resolved:
        return None, ""
    safetensors_path = Path(resolved["path"]).resolve()
    roots = _checkpoint_roots()
    if roots and not any(_is_path_under_root(safetensors_path, root) for root in roots):
        return None, ""
    for thumb_path in _checkpoint_thumbnail_candidates(safetensors_path):
        if roots and not any(_is_path_under_root(thumb_path, root) for root in roots):
            continue
        try:
            with Image.open(thumb_path) as img:
                img = ImageOps.exif_transpose(img)
                img.thumbnail((512, 512), Image.Resampling.LANCZOS)
                return img.convert("RGB"), str(thumb_path)
        except Exception:
            logger.exception("Failed to load ListSelector thumbnail: %s", thumb_path)
    return None, ""


def _preferred_checkpoint_thumbnail_path(safetensors_path: Path) -> Path:
    existing = _checkpoint_thumbnail_candidates(safetensors_path)
    if existing:
        return Path(existing[0]).resolve()
    return Path(safetensors_path).resolve().with_suffix(".jpg")


def _get_preview_state_item(tab_id, node_id, item_index):
    key = _state_key(tab_id, node_id)
    with _STATE_LOCK:
        state = dict(_PREVIEW_STATES.get(key, {}))
    source_paths = state.get("source_paths")
    if not isinstance(source_paths, list):
        return None, None, None, None
    try:
        index = int(item_index)
    except Exception:
        return state, None, None, None
    if index < 0 or index >= len(source_paths):
        return state, None, None, None
    raw_path = str(source_paths[index] or "").strip()
    if not raw_path:
        return state, None, None, None
    try:
        source_path = Path(raw_path).resolve()
    except Exception:
        return state, None, None, None
    return state, index, source_path, _normalize_relpath(state.get("ckpt_name_str", ""))


def _preview_item_exists_for_state(state: dict | None, source_path: Path | None) -> bool:
    if not state or source_path is None:
        return False
    try:
        if not source_path.exists() or not source_path.is_file():
            return False
    except Exception:
        return False
    search_root = _safe_search_root(state.get("search_directory"))
    if search_root is not None and not _is_path_under_root(source_path, search_root):
        return False
    if source_path.suffix.lower() not in ALLOWED_IMAGE_SUFFIXES:
        return False
    return True


def _set_checkpoint_thumbnail_from_preview_item(relpath: str, source_path: Path) -> dict:
    relpath = _normalize_relpath(relpath)
    if not _is_valid_checkpoint_relpath(relpath):
        raise ValueError("Invalid checkpoint path.")
    resolved = _resolve_checkpoint_unique(relpath)
    if not resolved:
        raise ValueError("Checkpoint not found.")
    ckpt_path = Path(resolved["path"]).resolve()
    target_path = _preferred_checkpoint_thumbnail_path(ckpt_path)
    target_path.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source_path) as img:
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGB")
        if max(img.width, img.height) > 1024:
            img.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
        img.save(target_path, format="JPEG", quality=JPEG_QUALITY, optimize=JPEG_OPTIMIZE)
    return {
        "ckpt_name_str": relpath,
        "ckpt_name_safe": _ckpt_name_safe_from_relpath(relpath),
        "source_path": str(source_path),
        "thumbnail_path": str(target_path),
    }


def _delete_plan_targets() -> list[dict]:
    roots = _checkpoint_roots()
    targets = []
    for relpath, rec in sorted(_active_delete_records().items(), key=lambda item: item[0].lower()):
        raw_path = rec.get("resolved_path") or rec.get("safetensors_path") or ""
        if raw_path:
            safetensors_path = Path(raw_path).resolve()
        else:
            resolved = _resolve_checkpoint_unique(relpath)
            if not resolved:
                continue
            safetensors_path = Path(resolved["path"]).resolve()
        if safetensors_path.suffix.lower() != ALLOWED_CHECKPOINT_SUFFIX:
            continue
        if roots and not any(_is_path_under_root(safetensors_path, root) for root in roots):
            continue
        raw_json_path = rec.get("json_path") or ""
        json_path = Path(raw_json_path).resolve() if raw_json_path else safetensors_path.with_suffix(".json")
        thumbnail_paths = []
        for thumb_path in _checkpoint_thumbnail_candidates(safetensors_path):
            if roots and not any(_is_path_under_root(thumb_path, root) for root in roots):
                continue
            thumbnail_paths.append(str(thumb_path))
        targets.append({
            "ckpt_name_str": relpath,
            "safetensors_path": str(safetensors_path),
            "json_path": str(json_path),
            "thumbnail_paths": thumbnail_paths,
            "reserved_at": rec.get("reserved_at", ""),
        })
    return targets


def _write_delete_script():
    DELETE_QUEUE_PATH.parent.mkdir(parents=True, exist_ok=True)
    script_path = DELETE_SCRIPT_PATH
    plan_path = DELETE_SCRIPT_PATH.with_name("checkpoint_delete_plan.txt")
    targets = _delete_plan_targets()
    roots_json = json.dumps([str(root) for root in _checkpoint_roots()], ensure_ascii=False, indent=2)
    script_lines = [
        "#!/usr/bin/env python3",
        "# Generated by ComfyUI-CheckpointHandpickerSuite.",
        "# Review each prompt carefully. Default answer is No.",
        "",
        "import json",
        "from pathlib import Path",
        "",
        "SCRIPT_DIR = Path(__file__).resolve().parent",
        "QUEUE_PATH = SCRIPT_DIR / 'checkpoint_delete_queue.jsonl'",
        f"ALLOWED_ROOTS = [Path(p).resolve() for p in {roots_json}]",
        "ALLOWED_THUMBNAIL_SUFFIXES = {'.jpg', '.jpeg', '.png', '.webp'}",
        "ALLOWED_SUFFIXES = {'.safetensors', '.json'} | ALLOWED_THUMBNAIL_SUFFIXES",
        "",
        "def is_under_root(path, root):",
        "    path = Path(path).resolve()",
        "    root = Path(root).resolve()",
        "    return path == root or root in path.parents",
        "",
        "def is_safe_target(path):",
        "    path = Path(path).resolve()",
        "    if path.suffix.lower() not in ALLOWED_SUFFIXES:",
        "        return False",
        "    return any(is_under_root(path, root) for root in ALLOWED_ROOTS)",
        "",
        "def thumbnail_candidates(safetensors_path):",
        "    path = Path(safetensors_path).resolve()",
        "    parent = path.parent",
        "    stem = path.stem",
        "    name = path.name",
        "    patterns = []",
        "    for ext in sorted(ALLOWED_THUMBNAIL_SUFFIXES):",
        "        patterns.extend([",
        "            f'{stem}{ext}', f'{name}{ext}',",
        "            f'{stem}.thumbnail{ext}', f'{stem}.thumb{ext}', f'{stem}.preview{ext}',",
        "            f'{name}.thumbnail{ext}', f'{name}.thumb{ext}', f'{name}.preview{ext}',",
        "        ])",
        "    found = []",
        "    seen = set()",
        "    for pattern in patterns:",
        "        candidate = (parent / pattern).resolve()",
        "        if str(candidate) in seen:",
        "            continue",
        "        seen.add(str(candidate))",
        "        if candidate.exists() and candidate.is_file() and is_safe_target(candidate):",
        "            found.append(candidate)",
        "    return found",
        "",
        "def read_records():",
        "    if not QUEUE_PATH.exists():",
        "        return []",
        "    records = []",
        "    for line in QUEUE_PATH.read_text(encoding='utf-8', errors='replace').splitlines():",
        "        if not line.strip():",
        "            continue",
        "        try:",
        "            rec = json.loads(line)",
        "            if isinstance(rec, dict): records.append(rec)",
        "        except Exception as exc:",
        "            print('Skipping invalid queue record:', exc)",
        "    return records",
        "",
        "def active_records():",
        "    active = {}",
        "    for rec in read_records():",
        "        rec_type = rec.get('type')",
        "        relpath = rec.get('ckpt_name_str') or ''",
        "        rid = rec.get('id')",
        "        if rec_type == 'reserve' and relpath:",
        "            active[relpath] = rec",
        "        elif rec_type == 'cancel':",
        "            if relpath: active.pop(relpath, None)",
        "            elif rid:",
        "                for key, value in list(active.items()):",
        "                    if value.get('id') == rid: active.pop(key, None)",
        "    return active",
        "",
        "def delete_file(path):",
        "    path = Path(path).resolve()",
        "    if not is_safe_target(path):",
        "        print('Unsafe target, skipped:', path); return",
        "    if not path.exists():",
        "        print('Not found:', path); return",
        "    if not path.is_file():",
        "        print('Not a file, skipped:', path); return",
        "    path.unlink(); print('Deleted:', path)",
        "",
        "def main():",
        "    targets = []",
        "    for relpath, rec in sorted(active_records().items(), key=lambda item: item[0].lower()):",
        "        raw = rec.get('resolved_path') or rec.get('safetensors_path') or ''",
        "        if not raw:",
        "            print('Skipping target without resolved_path:', relpath); continue",
        "        safetensors_path = Path(raw).resolve()",
        "        json_path = Path(rec.get('json_path') or safetensors_path.with_suffix('.json')).resolve()",
        "        thumbnails = thumbnail_candidates(safetensors_path)",
        "        targets.append((relpath, safetensors_path, json_path, thumbnails, rec.get('reserved_at', '')))",
        "    print('Checkpoint delete script')",
        "    print('Queue file:', QUEUE_PATH)",
        "    print('Targets:', len(targets))",
        "    for idx, (relpath, safetensors_path, json_path, thumbnails, reserved_at) in enumerate(targets, start=1):",
        "        print()",
        "        print('[{}/{}] Delete checkpoint?'.format(idx, len(targets)))",
        "        print('  relpath:', relpath)",
        "        print('  safetensors:', safetensors_path)",
        "        print('  json:', json_path)",
        "        if thumbnails:",
        "            print('  thumbnails:')",
        "            for thumb in thumbnails:",
        "                print('    -', thumb)",
        "        else:",
        "            print('  thumbnails: (none)')",
        "        answer = input('Delete this checkpoint and listed sidecar thumbnails? (y/N): ').strip().lower()",
        "        if answer != 'y': print('Skipped.'); continue",
        "        delete_file(safetensors_path)",
        "        delete_file(json_path)",
        "        for thumb in thumbnails:",
        "            delete_file(thumb)",
        "    print()",
        "    print('Deletion completed. Please return to ComfyUI and click Refresh All.')",
        "",
        "if __name__ == '__main__': main()",
        "",
    ]
    script_path.write_text("\n".join(script_lines), encoding="utf-8", newline="\n")
    plan_lines = [
        "Checkpoint delete plan",
        f"Generated at: {_now_iso()}",
        f"Queue file: {DELETE_QUEUE_PATH}",
        f"Active targets: {len(targets)}",
        "",
    ]
    for idx, item in enumerate(targets, start=1):
        plan_lines.extend([
            f"[{idx}] {item['ckpt_name_str']}",
            f"    safetensors: {item['safetensors_path']}",
            f"    json:        {item['json_path']}",
            "    thumbnails:",
            *([f"        - {thumb}" for thumb in item.get("thumbnail_paths", [])] or ["        (none)"]),
            f"    reserved_at: {item.get('reserved_at', '')}",
            "",
        ])
    plan_path.write_text("\n".join(plan_lines), encoding="utf-8", newline="\n")
    return script_path, plan_path, len(targets)


def _prune_missing_delete_records_on_refresh(checkpoint_values: list[str] | None = None) -> int:
    active = _active_delete_records()
    if not active:
        return 0
    current_names = {_normalize_relpath(value) for value in (checkpoint_values if checkpoint_values is not None else _get_fresh_checkpoint_values())}
    pruned = 0
    for relpath, rec in list(active.items()):
        relpath = _normalize_relpath(relpath)
        rid = rec.get("id")
        if not rid or relpath in current_names:
            continue
        raw_path = rec.get("resolved_path") or rec.get("safetensors_path") or ""
        if raw_path:
            try:
                if Path(raw_path).expanduser().resolve().exists():
                    continue
            except Exception:
                pass
        _append_delete_record({
            "version": 1,
            "type": "cancel",
            "id": rid,
            "ckpt_name_str": relpath,
            "reason": "missing_on_refresh",
            "cancelled_at": _now_iso(),
        })
        if _get_status(relpath) == "delete":
            _set_status(relpath, "none")
        pruned += 1
    if pruned:
        try:
            _write_delete_script()
        except Exception:
            logger.exception("Failed to rewrite delete script after pruning missing delete reservations")
    return pruned


def _patch_backend_checkpoint_classes(checkpoint_values: list[str]) -> list[str]:
    patched = []
    values = list(checkpoint_values) or [""]
    try:
        import nodes as comfy_nodes
    except Exception:
        logger.exception("Failed to import ComfyUI nodes for checkpoint refresh patch")
        return patched
    mappings = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {})
    for class_name, node_class in list(mappings.items()):
        name = str(class_name)
        try:
            if name == "CheckpointLoaderSimple":
                def loader_input_types(cls, _values=values):
                    return {"required": {"ckpt_name": (list(_values),)}}
                node_class.INPUT_TYPES = classmethod(loader_input_types)
                patched.append(name)
                continue
            if "CheckpointNameSelector" in name:
                def selector_input_types(cls, _values=values):
                    return {"required": {"ckpt_name": (list(_values),)}}
                node_class.INPUT_TYPES = classmethod(selector_input_types)
                node_class.RETURN_TYPES = (list(values), "STRING")
                patched.append(name)
                continue
            if name == "CheckpointListSelector":
                def list_selector_input_types(cls, _values=values):
                    return {"required": {"checkpoint": ("STRING", {"default": ""})}, "hidden": {"unique_id": "UNIQUE_ID"}}
                node_class.INPUT_TYPES = classmethod(list_selector_input_types)
                node_class.RETURN_TYPES = (list(values), "STRING", "STRING")
                patched.append(name)
                continue
            if name == "CheckpointNameCycler":
                def cycler_input_types(cls, _values=values):
                    return {
                        "required": {
                            "start_checkpoint": (list(_values),),
                            "mode": (["fixed", "increment", "randomize", "shuffle_once"], {"default": "increment"}),
                            "change_every": ("INT", {"default": 1, "min": 1, "max": 999999}),
                        },
                        "optional": {
                            "hps_tab_id": ("STRING", {"default": "", "hidden": True}),
                            "hps_filter_statuses": ("STRING", {"default": "", "hidden": True}),
                            "hps_use_local_list": ("STRING", {"default": "", "hidden": True}),
                            "hps_settings_revision": ("STRING", {"default": "0", "hidden": True}),
                        },
                        "hidden": {"unique_id": "UNIQUE_ID"},
                    }
                node_class.INPUT_TYPES = classmethod(cycler_input_types)
                node_class.RETURN_TYPES = (list(values), "STRING", "STRING")
                patched.append(name)
                continue
        except Exception as exc:
            logger.warning("[CheckpointHandpickerSuite] failed to patch %s: %s", name, exc)
    return patched


def _pil_from_array(arr: np.ndarray) -> Image.Image:
    arr = np.clip(arr * 255.0, 0, 255).astype(np.uint8)
    if arr.ndim == 2:
        return Image.fromarray(arr, mode="L")
    if arr.shape[-1] == 1:
        return Image.fromarray(arr[..., 0], mode="L")
    if arr.shape[-1] == 3:
        return Image.fromarray(arr, mode="RGB")
    if arr.shape[-1] == 4:
        return Image.fromarray(arr, mode="RGBA")
    raise ValueError(f"Unsupported channel count: {arr.shape[-1]}")


def _tensor_batch_to_pil(image_tensor) -> list[Image.Image]:
    if image_tensor.ndim == 3:
        image_tensor = image_tensor.unsqueeze(0)
    batch = image_tensor.detach().cpu().numpy()
    return [_pil_from_array(arr) for arr in batch]


def _clamp_image_dir_max_images(value) -> int:
    try:
        value = int(value)
    except Exception:
        value = IMAGE_DIR_DEFAULT_MAX_IMAGES
    return max(1, min(IMAGE_DIR_MAX_IMAGES, value))


def _reference_image_size(images: list[Image.Image]) -> tuple[int, int]:
    if not images:
        return 512, 512
    w, h = images[0].size
    if w <= 0 or h <= 0:
        return 512, 512
    ratio = w / h
    if ratio < 0.25 or ratio > 4.0:
        return 512, 512
    return int(w), int(h)


def _choose_layout_fit(count: int, ref_w: int, ref_h: int, allow_upscale: bool = False) -> SheetLayout:
    count = max(1, int(count))
    ref_w = max(1, int(ref_w))
    ref_h = max(1, int(ref_h))
    best = None
    landscape = ref_w >= ref_h
    for cols in range(1, count + 1):
        rows = math.ceil(count / cols)
        empty = cols * rows - count
        scale = min(MAX_CONTENT_EDGE / max(1, cols * ref_w), MAX_CONTENT_EDGE / max(1, rows * ref_h))
        if not allow_upscale:
            scale = min(1.0, scale)
        if scale <= 0:
            continue
        tile_w = max(1, int(ref_w * scale))
        tile_h = max(1, int(ref_h * scale))
        content_w = cols * tile_w
        content_h = rows * tile_h
        if content_w > MAX_CONTENT_EDGE or content_h > MAX_CONTENT_EDGE:
            continue
        canvas_w = content_w + GAP * max(0, cols - 1)
        canvas_h = content_h + GAP * max(0, rows - 1)
        aspect_score = max(content_w, content_h) / max(1, min(content_w, content_h))
        orientation_bonus = 1 if ((cols >= rows) if landscape else (rows >= cols)) else 0
        tie_score = (round(scale, 8), -empty, orientation_bonus, cols if landscape else rows)
        layout = SheetLayout(cols, rows, tile_w, tile_h, canvas_w, canvas_h, count)
        if best is None or aspect_score < best[0] - 1e-12 or (abs(aspect_score - best[0]) <= 1e-12 and tie_score > best[1]):
            best = (aspect_score, tie_score, layout)
    if best:
        return best[2]
    return SheetLayout(1, count, ref_w, ref_h, ref_w, count * ref_h + GAP * max(0, count - 1), count)


def _fit_image_to_tile(img: Image.Image, tile_w: int, tile_h: int, allow_upscale: bool = False) -> Image.Image:
    resampling = getattr(Image, "Resampling", Image).LANCZOS
    w, h = img.size
    scale = min(tile_w / max(1, w), tile_h / max(1, h))
    if not allow_upscale:
        scale = min(1.0, scale)
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    if (new_w, new_h) == (w, h):
        return img.copy()
    return img.resize((new_w, new_h), resampling)


def _build_contact_sheet(images: list[Image.Image], progress_callback=None, max_images: int | None = None, allow_upscale: bool = False) -> tuple[Image.Image | None, dict]:
    if not images:
        return None, {"count": 0, "columns": 0, "rows": 0, "tile_width": 0, "tile_height": 0}
    if max_images is None:
        limit = len(images)
    else:
        limit = max(1, min(int(max_images), len(images)))
    selected = images[:limit]
    ref_w, ref_h = _reference_image_size(selected)
    layout = _choose_layout_fit(len(selected), ref_w, ref_h, allow_upscale=allow_upscale)
    canvas = Image.new("RGB", (layout.canvas_width, layout.canvas_height), (24, 24, 24))
    normalized = []
    total = layout.count
    for idx, img in enumerate(selected[:layout.count], start=1):
        if progress_callback:
            progress_callback(idx - 1, total, f"Building preview sheet {idx}/{total}")
        normalized.append(_fit_image_to_tile(img, layout.tile_width, layout.tile_height, allow_upscale=allow_upscale))
        if progress_callback:
            progress_callback(idx, total, f"Building preview sheet {idx}/{total}")
    for idx, img in enumerate(normalized):
        row = idx // layout.cols
        col = idx % layout.cols
        x = col * (layout.tile_width + GAP)
        y = row * (layout.tile_height + GAP)
        px = x + (layout.tile_width - img.width) // 2
        py = y + (layout.tile_height - img.height) // 2
        if img.mode == "RGBA":
            canvas.paste(img, (px, py), img)
        else:
            canvas.paste(img.convert("RGB"), (px, py))
    return canvas, {
        "count": layout.count,
        "columns": layout.cols,
        "rows": layout.rows,
        "tile_width": layout.tile_width,
        "tile_height": layout.tile_height,
        "gap": GAP,
        "max_content_edge": MAX_CONTENT_EDGE,
        "allow_upscale": allow_upscale,
        "max_images": max_images if max_images is not None else len(images),
    }


def _encode_preview_payload(image: Image.Image) -> dict:
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=JPEG_OPTIMIZE)
    return {
        "image": base64.b64encode(buf.getvalue()).decode("ascii"),
        "format": "jpeg",
        "width": image.width,
        "height": image.height,
    }


def _send_image_dir_progress(node_id, relpath, tab_id, message, value=0, total=0, max_preview_images=IMAGE_DIR_DEFAULT_MAX_IMAGES):
    status = _get_status(relpath) if relpath else "none"
    _send_preview(node_id, _image_dir_title(relpath), None, {
        "node_class": "ImageDirPreview",
        "ckpt_name_str": relpath,
        "ckpt_name_safe": _ckpt_name_safe_from_relpath(relpath) if relpath else "",
        "status": "loading",
        "status_icon": STATUS_ICON[status],
        "message": message,
        "progress": True,
        "progress_message": message,
        "progress_value": value,
        "progress_total": total,
        "max_preview_images": max_preview_images,
    }, tab_id=tab_id)


def _image_dir_title(relpath: str) -> str:
    status = _get_status(relpath) if relpath else "none"
    if relpath and status != "none":
        return f"ImageDir : {STATUS_ICON[status]} {relpath}"
    if relpath:
        return f"ImageDir : {relpath}"
    return "ImageDir Preview"


def _safe_search_root(value) -> Path | None:
    raw = str(value or "").strip()
    if not raw:
        try:
            return Path(folder_paths.get_output_directory()).resolve()
        except Exception:
            return None
    try:
        path = Path(raw).expanduser().resolve()
        return path if path.exists() and path.is_dir() else None
    except Exception:
        return None


def _image_matches_checkpoint(path: Path, relpath: str) -> bool:
    safe = _ckpt_name_safe_from_relpath(relpath).lower()
    stem = Path(relpath).stem.lower()
    hay = "/".join(part.lower() for part in path.parts)
    return safe in hay or stem in hay


def _find_image_dir_candidates(relpath: str, search_directory=None, limit: int = IMAGE_DIR_SCAN_LIMIT) -> list[Path]:
    root = _safe_search_root(search_directory)
    if root is None:
        return []
    found = []
    try:
        for dirpath, _dirnames, filenames in os.walk(root):
            for filename in filenames:
                p = Path(dirpath) / filename
                if p.suffix.lower() not in ALLOWED_IMAGE_SUFFIXES:
                    continue
                if not _image_matches_checkpoint(p, relpath):
                    continue
                try:
                    mtime = p.stat().st_mtime
                except Exception:
                    mtime = 0.0
                found.append((mtime, p))
                if len(found) >= limit:
                    # Keep scanning bounded. Sort latest first below.
                    pass
    except Exception:
        logger.exception("ImageDirPreview scan failed: %s", root)
    found.sort(key=lambda item: item[0], reverse=True)
    return [p for _mtime, p in found[:limit]]


def _load_image_file(path: Path) -> Image.Image | None:
    try:
        with Image.open(path) as img:
            img = ImageOps.exif_transpose(img)
            if img.mode not in ("RGB", "RGBA", "L"):
                img = img.convert("RGB")
            return img.copy()
    except Exception:
        logger.warning("[CheckpointHandpickerSuite] failed to read preview image: %s", path, exc_info=True)
        return None


def _load_image_dir_preview(node_id, relpath, search_directory=None, tab_id="", send_progress=True, max_preview_images=IMAGE_DIR_DEFAULT_MAX_IMAGES):
    max_preview_images = _clamp_image_dir_max_images(max_preview_images)

    def progress(value: int, total: int, message: str):
        if send_progress:
            _send_image_dir_progress(node_id, relpath, tab_id, message, value, total, max_preview_images)

    progress(0, max_preview_images, "Searching preview images...")
    paths = _find_image_dir_candidates(relpath, search_directory)
    selected_paths = paths[:max_preview_images]
    progress(len(selected_paths), max_preview_images, f"Found preview images {len(selected_paths)}/{max_preview_images}")

    images = []
    loaded_paths = []
    total = len(selected_paths)
    for idx, path in enumerate(selected_paths, start=1):
        progress(idx - 1, max(1, total), f"Loading preview image {idx}/{total}")
        img = _load_image_file(path)
        if img is not None:
            images.append(img)
            loaded_paths.append(path)
        progress(idx, max(1, total), f"Loading preview image {idx}/{total}")

    def cb(value, total, message):
        progress(value, total, message)

    sheet, extra = _build_contact_sheet(images, progress_callback=cb, max_images=max_preview_images)
    if sheet is not None:
        progress(max_preview_images, max_preview_images, "Encoding preview image...")
    status = _get_status(relpath)
    extra.update({
        "node_class": "ImageDirPreview",
        "ckpt_name_str": relpath,
        "ckpt_name_safe": _ckpt_name_safe_from_relpath(relpath),
        "status": status,
        "status_icon": STATUS_ICON[status],
        "message": f"{len(images)} image(s) found" if images else "no preview images found",
        "progress_message": "Preview ready." if sheet is not None else "no preview images found",
        "progress_value": max_preview_images,
        "progress_total": max_preview_images,
        "search_directory": str(_safe_search_root(search_directory) or ""),
        "max_preview_images": max_preview_images,
        "source_paths": [str(p) for p in loaded_paths],
    })
    return sheet, extra


def _valid_local_list(local_list: list[str] | None) -> list[str]:
    """Return valid Local List entries while preserving order and duplicates.

    Local List is a manual per-Cycler queue, not a set. The same checkpoint may
    intentionally be pushed multiple times, and each entry must be consumed
    independently.
    """
    all_set = set(_get_checkpoint_list())
    local = []
    for item in local_list or []:
        rel = _normalize_relpath(item)
        if rel in all_set:
            local.append(rel)
    return local


def _filter_match_count(active_filter: list[str]) -> int:
    all_checkpoints = _get_checkpoint_list()
    if not active_filter:
        return len(all_checkpoints)
    return sum(1 for ckpt in all_checkpoints if _get_status(ckpt) in active_filter)


def _checkpoint_total_count() -> int:
    return len(_get_checkpoint_list())


def _build_local_list_lines(local_items: list[str], max_items: int = 20) -> list[str]:
    shown = []
    for index, item in enumerate(list(local_items[:max_items]), start=1):
        status = _get_status(item)
        icon = STATUS_ICON[status] if status != "none" else " "
        shown.append(f"{index:>2}. {icon} {item}")
    if len(local_items) > max_items:
        shown.append(f"... and {len(local_items) - max_items} more")
    return shown


def _build_cycler_title(source, ckpt_name, hold_index, change_every, active_filter, fallback_all, local_count) -> str:
    status = _get_status(ckpt_name) if ckpt_name else "none"
    icon = STATUS_ICON[status] if status != "none" else ""
    prefix = "Cycler"
    # Filter state is shown by the filter buttons and the status panel. Do not
    # duplicate it in the title.
    if fallback_all:
        prefix += " [fallback all]"
    if source == "local_list" and local_count > 0:
        prefix += f" [local:{local_count}]"
    body = f"{icon} {ckpt_name}".strip() if ckpt_name else "(none)"
    if source == "local_list":
        return f"{prefix} : {body}"
    return f"{prefix} : {body} ({hold_index}/{change_every})"


def _build_cycler_status_text(source, ckpt_name, active_filter, fallback_all, queue, hold_index, change_every, match_count, local_count, mode, local_items=None, use_local_list=True, shuffle_deck_remaining=None) -> str:
    status = _get_status(ckpt_name) if ckpt_name else "none"
    current = f"Current: {STATUS_ICON[status]} {ckpt_name}" if status != "none" and ckpt_name else (f"Current: {ckpt_name}" if ckpt_name else "Current: (none)")
    display_mode = "local list" if source == "local_list" else mode
    lines = [
        current,
        f"Mode: {display_mode}" if source == "local_list" else f"Mode: {mode}  Hold: {hold_index}/{change_every}",
        f"Filter: {_filter_display(active_filter)}  Matches: {match_count} / {_checkpoint_total_count()}",
    ]
    if fallback_all:
        lines.append("Filter fallback: all checkpoints")
    if shuffle_deck_remaining is not None:
        lines.append(f"Shuffle Deck Remaining: {shuffle_deck_remaining}")
    if use_local_list and local_count > 0:
        items = list(local_items or [])
        lines.append(f"Local List Remaining: {local_count} item(s)")
        lines.extend(_build_local_list_lines(items))
    if queue:
        lines.append(f"Local List Remaining: {len(queue)} item(s)")
    return "\n".join(lines)


def _build_cycler_idle_status_text(action: str, state: dict, detail: str = "") -> str:
    """Build a status panel for UI-only operations such as Push/Clear Local List.

    This is a synthesized display: last_execution_snapshot provides the current
    job, runtime_controls provide the live filter/mode settings, and Local List
    comes from runtime_state.
    """
    controls = _runtime_controls_from_state(state)
    snap = _last_execution_snapshot(state)
    ckpt_name = snap.get("ckpt_name", "") or ""
    status = _get_status(ckpt_name) if ckpt_name else "none"
    active_filter = list(controls.get("active_filter", []))
    local_items = _valid_local_list(state.get("local_list", []))
    local_count = len(local_items)
    mode = controls.get("mode", "increment")
    current = f"Current: {STATUS_ICON[status]} {ckpt_name}" if status != "none" and ckpt_name else (f"Current: {ckpt_name}" if ckpt_name else "Current: (not executed yet)")
    use_local = bool(controls.get("use_local_list", True))
    local_job_active = snap.get("source") == "local_list"
    if local_job_active:
        mode_line = "Mode: local list"
    else:
        hold_index = max(0, _parse_saved_int(snap.get("hold_index"), 0))
        change_every = _valid_change_every(snap.get("change_every_used", controls.get("change_every", 1)))
        mode_line = f"Mode: {snap.get('mode_used', mode)}  Hold: {hold_index}/{change_every}" if ckpt_name else f"Mode: {mode}"
    lines = [
        current,
        mode_line,
        f"Filter: {_filter_display(active_filter)}  Matches: {_filter_match_count(active_filter)} / {_checkpoint_total_count()}",
    ]
    if (not local_job_active) and (controls.get("mode") == "shuffle_once" or snap.get("base_mode") == "shuffle_once" or snap.get("mode_used") == "shuffle_once"):
        lines.append(f"Shuffle Deck Remaining: {len(state.get('shuffle_deck', []))}")
    if use_local and local_count > 0:
        lines.append(f"Local List Remaining: {local_count} item(s)")
        lines.extend(_build_local_list_lines(local_items))
    return "\n".join(lines)


def _candidate_checkpoints(active_filter: list[str]) -> tuple[list[str], bool, int]:
    """Return global candidates, fallback flag, and global filter match count.

    Local List is intentionally handled outside this function. Filter metadata is
    always about the entire checkpoint set, not about the Local List.
    """
    all_checkpoints = _get_checkpoint_list()
    if not active_filter:
        return list(all_checkpoints), False, len(all_checkpoints)
    filtered = [ckpt for ckpt in all_checkpoints if _get_status(ckpt) in active_filter]
    if filtered:
        return filtered, False, len(filtered)
    return list(all_checkpoints), bool(all_checkpoints), 0


class CheckpointListSelector:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"checkpoint": ("STRING", {"default": ""})},
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = (_get_checkpoint_list() or [""], "STRING", "STRING")
    RETURN_NAMES = ("ckpt_name", "ckpt_name_str", "ckpt_name_safe")
    FUNCTION = "select"
    CATEGORY = "checkpoint/handpicker"

    def select(self, checkpoint="", unique_id=None):
        rel = _normalize_relpath(checkpoint)
        if rel not in _get_checkpoint_list():
            items = _get_checkpoint_list()
            rel = items[0] if items else ""
        return (rel, rel, _ckpt_name_safe_from_relpath(rel) if rel else "checkpoint")


class CheckpointNameCycler:
    @classmethod
    def INPUT_TYPES(cls):
        values = _get_checkpoint_list() or [""]
        return {
            "required": {
                "start_checkpoint": (values,),
                "mode": (["fixed", "increment", "randomize", "shuffle_once"], {"default": "increment"}),
                "change_every": ("INT", {"default": 1, "min": 1, "max": 999999}),
            },
            "optional": {
                "hps_tab_id": ("STRING", {"default": "", "hidden": True}),
                "hps_filter_statuses": ("STRING", {"default": "", "hidden": True}),
                "hps_use_local_list": ("STRING", {"default": "", "hidden": True}),
                "hps_settings_revision": ("STRING", {"default": "0", "hidden": True}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = (_get_checkpoint_list() or [""], "STRING", "STRING")
    RETURN_NAMES = ("ckpt_name", "ckpt_name_str", "ckpt_name_safe")
    FUNCTION = "cycle"
    CATEGORY = "checkpoint/handpicker"

    @classmethod
    def IS_CHANGED(cls, start_checkpoint, mode="increment", change_every=1, hps_tab_id="", hps_filter_statuses="", hps_use_local_list="", hps_settings_revision="0", unique_id=None):
        return float("nan")

    def cycle(self, start_checkpoint, mode="increment", change_every=1, hps_tab_id="", hps_filter_statuses="", hps_use_local_list="", hps_settings_revision="0", unique_id=None):
        tab_id = _clean_tab_id(hps_tab_id)
        node_id = str(unique_id or "")
        key = _state_key(tab_id, node_id)
        state = _get_cycler_state(key)

        prompt_mode = _valid_mode(mode)
        prompt_change_every = _valid_change_every(change_every)
        prompt_filter = _normalize_status_list(hps_filter_statuses)
        prompt_use_local_list = _parse_saved_bool(hps_use_local_list, bool(_runtime_controls_from_state(state).get("use_local_list", True)))
        prompt_start_checkpoint = _normalize_relpath(start_checkpoint)
        prompt_revision = _parse_saved_int(hps_settings_revision, _runtime_controls_from_state(state).get("settings_revision", 0))

        controls = _runtime_controls_from_state(state)
        current_revision = _parse_saved_int(controls.get("settings_revision"), 0)
        # First execution can seed runtime_controls from prompt arguments. After
        # that, prompt JSON is treated as a stale fallback unless its revision is
        # newer than the backend runtime state.
        if not state.get("runtime_controls_initialized") or prompt_revision > current_revision:
            controls = _set_runtime_controls(
                state,
                mode=prompt_mode,
                change_every=prompt_change_every,
                start_checkpoint=prompt_start_checkpoint,
                active_filter=prompt_filter,
                use_local_list=prompt_use_local_list,
                settings_revision=max(prompt_revision, current_revision),
                mark_initialized=True,
            )
        else:
            controls = _runtime_controls_from_state(state)

        mode = _valid_mode(controls.get("mode", prompt_mode))
        change_every = _valid_change_every(controls.get("change_every", prompt_change_every))
        active_filter = _normalize_status_list(controls.get("active_filter", prompt_filter))
        use_local_list = bool(controls.get("use_local_list", prompt_use_local_list))
        start_checkpoint_used = _normalize_relpath(controls.get("start_checkpoint") or prompt_start_checkpoint)

        all_checkpoints = _get_checkpoint_list()
        if not all_checkpoints:
            title = "Cycler : no checkpoints"
            status_text = "Current: (no checkpoints)"
            state["last_title"] = title
            state["last_status_text"] = status_text
            _send_cycler_update(node_id, title, status_text, tab_id=tab_id)
            return ("", "", "checkpoint")

        if start_checkpoint_used not in all_checkpoints:
            # Backend fallback only. The frontend must still keep the visible
            # combo value valid so ComfyUI's queue-time validation does not fail.
            start_checkpoint_used = all_checkpoints[0]
            controls = _set_runtime_controls(state, start_checkpoint=start_checkpoint_used, mark_initialized=bool(state.get("runtime_controls_initialized", False)))

        global_candidates, fallback_all, global_match_count = _candidate_checkpoints(active_filter)
        local_items = _valid_local_list(state.get("local_list", []))
        use_local_source = use_local_list and bool(local_items)
        candidates = local_items if use_local_source else global_candidates
        if not candidates:
            candidates = all_checkpoints
            fallback_all = True
        candidate_set = set(candidates)

        def start_index() -> int:
            requested = _normalize_relpath(start_checkpoint_used)
            if requested in all_checkpoints:
                return all_checkpoints.index(requested)
            return 0

        source = "local_list" if use_local_source else "cycle"
        hold_index = 1
        selected_index = 0

        if use_local_source:
            # Manual Local List queue. It is a runtime_state ledger, not part of
            # last_execution_snapshot. Consume exactly one item per execution.
            ckpt_name = local_items[0]
            remaining_local_items = local_items[1:]
            state["local_list"] = remaining_local_items
            state["override_queue"] = remaining_local_items
            state["local_index"] = 0
            selected_index = all_checkpoints.index(ckpt_name)
            title = _build_cycler_title("local_list", ckpt_name, 1, change_every, active_filter, False, len(remaining_local_items))
            status_text = _build_cycler_status_text(
                "local_list",
                ckpt_name,
                active_filter,
                False,
                [],
                1,
                change_every,
                global_match_count,
                len(remaining_local_items),
                "local list",
                local_items=remaining_local_items,
                use_local_list=True,
                shuffle_deck_remaining=None,
            )
            local_items = remaining_local_items
        else:
            repeat_count = max(0, int(state.get("repeat_count", 0)))
            last_ckpt = _normalize_relpath(state.get("last_normal_ckpt_name") or state.get("last_ckpt_name", ""))
            can_hold_last = last_ckpt in candidate_set and repeat_count > 0 and repeat_count < change_every

            def find_next_increment(current_index: int):
                if not candidates:
                    return all_checkpoints[0], 0
                n = len(all_checkpoints)
                start = max(0, min(n - 1, current_index))
                for offset in range(n):
                    idx = (start + offset) % n
                    ckpt = all_checkpoints[idx]
                    if ckpt in candidate_set:
                        return ckpt, idx
                ckpt = candidates[0]
                return ckpt, all_checkpoints.index(ckpt)

            def draw_from_shuffle_deck():
                # v8g: shuffle_once is a global shuffled increment.
                # The deck is built from all checkpoints, while the active filter
                # is applied when scanning the deck. Non-matching checkpoints are
                # skipped AND consumed, matching increment's "cursor moved on"
                # semantics without exposing an extra cursor UI.
                all_set = set(all_checkpoints)
                deck = [x for x in state.get("shuffle_deck", []) if x in all_set]

                def refill_deck():
                    fresh = list(all_checkpoints)
                    random.shuffle(fresh)
                    return fresh

                if not deck:
                    deck = refill_deck()

                for _pass in range(2):
                    while deck:
                        ckpt = deck.pop(0)
                        if ckpt in candidate_set:
                            state["shuffle_deck"] = deck
                            return ckpt
                    # The remaining global deck had no item for the current
                    # filter. Start a new global deck and scan once more.
                    deck = refill_deck()

                # Defensive fallback. This should be unreachable when candidates
                # is non-empty, but keeps the node alive if checkpoint state
                # changes under us.
                state["shuffle_deck"] = deck
                return candidates[0]

            if can_hold_last:
                ckpt_name = last_ckpt
                selected_index = all_checkpoints.index(ckpt_name)
            else:
                if mode == "fixed":
                    requested = _normalize_relpath(start_checkpoint_used)
                    ckpt_name = requested if requested in candidate_set else candidates[0]
                    selected_index = all_checkpoints.index(ckpt_name)
                elif mode == "randomize":
                    ckpt_name = random.choice(candidates)
                    selected_index = all_checkpoints.index(ckpt_name)
                elif mode == "shuffle_once":
                    ckpt_name = draw_from_shuffle_deck()
                    selected_index = all_checkpoints.index(ckpt_name)
                else:
                    ckpt_name, selected_index = find_next_increment(int(state.get("current_index", start_index())))

            hold_index = repeat_count + 1 if can_hold_last else 1
            if hold_index >= change_every:
                state["repeat_count"] = 0
                if mode == "increment":
                    next_index = selected_index + 1
                    if next_index >= len(all_checkpoints):
                        next_index = 0
                        state["cycle_count"] = int(state.get("cycle_count", 0)) + 1
                    state["current_index"] = next_index
                else:
                    state["current_index"] = selected_index
            else:
                state["repeat_count"] = hold_index
                state["current_index"] = selected_index

            state["last_normal_ckpt_name"] = ckpt_name
            title = _build_cycler_title("cycle", ckpt_name, hold_index, change_every, active_filter, fallback_all and mode != "fixed", len(local_items) if use_local_list else 0)
            status_text = _build_cycler_status_text(
                "cycle",
                ckpt_name,
                active_filter,
                fallback_all and mode != "fixed",
                [],
                hold_index,
                change_every,
                global_match_count,
                len(local_items),
                mode,
                local_items=local_items,
                use_local_list=use_local_list,
                shuffle_deck_remaining=len(state.get("shuffle_deck", [])) if mode == "shuffle_once" else None,
            )

        status = _get_status(ckpt_name)
        snapshot = {
            "ckpt_name": ckpt_name,
            "ckpt_name_safe": _ckpt_name_safe_from_relpath(ckpt_name),
            "source": source,
            "mode_used": "local_list" if use_local_source else mode,
            "base_mode": mode,
            "change_every_used": change_every,
            "filter_used": list(active_filter),
            "use_local_list_used": use_local_list,
            "fallback_all": False if use_local_source else (fallback_all and mode != "fixed"),
            "matches_at_resolve": global_match_count,
            "local_list_count_after": len(local_items),
            "hold_index": hold_index,
            "hold_total": change_every,
            "status": status,
            "status_icon": STATUS_ICON[status],
            "title": title,
            "status_text": status_text,
        }
        state["last_execution_snapshot"] = snapshot
        state["last_ckpt_name"] = ckpt_name
        state["last_source"] = source
        state["last_title"] = title
        state["last_status_text"] = status_text
        state["last_hold_index"] = hold_index
        # Mirrors of runtime controls, not queue-prompt arguments.
        state["last_change_every"] = change_every
        state["last_mode"] = mode
        state["last_start_checkpoint"] = start_checkpoint_used

        exec_state = _store_tab_execution_state(tab_id, {
            "node": int(unique_id) if unique_id is not None else None,
            "node_class": "CheckpointNameCycler",
            "ckpt_name_str": ckpt_name,
            "ckpt_name_safe": _ckpt_name_safe_from_relpath(ckpt_name),
            "status": status,
            "status_icon": STATUS_ICON[status],
            "source": source,
            "mode": "local_list" if use_local_source else mode,
            "mode_used": "local_list" if use_local_source else mode,
            "base_mode": mode,
            "change_every": change_every,
            "change_every_used": change_every,
            "filter_used": list(active_filter),
            "fallback_all": False if use_local_source else (fallback_all and mode != "fixed"),
            "matches_at_resolve": global_match_count,
            "local_list_count": len(local_items),
            "hold_index": hold_index,
            "title": title,
            "status_text": status_text,
            "last_execution_snapshot": snapshot,
        })
        state["execution_revision"] = exec_state.get("execution_revision", 0)
        snapshot["execution_revision"] = state["execution_revision"]
        state["last_execution_snapshot"] = snapshot
        _send_cycler_update(
            node_id,
            title,
            status_text,
            tab_id=tab_id,
            ckpt_name_str=ckpt_name,
            ckpt_name_safe=_ckpt_name_safe_from_relpath(ckpt_name),
            status=status,
            status_icon=STATUS_ICON[status],
            source=source,
            mode="local_list" if use_local_source else mode,
            base_mode=mode,
            hold_index=hold_index,
            change_every=change_every,
            local_list_count=len(local_items),
            local_list_items=list(local_items),
            filter_matches=global_match_count,
            filter_total=_checkpoint_total_count(),
            active_filter=list(active_filter),
            use_local_list=use_local_list,
            runtime_controls=controls,
            last_execution_snapshot=snapshot,
            execution_revision=state["execution_revision"],
        )
        return (ckpt_name, ckpt_name, _ckpt_name_safe_from_relpath(ckpt_name))


class CheckpointStatusTagger:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"ckpt_name_str": ("STRING", {"forceInput": True})},
            "optional": {"hps_tab_id": ("STRING", {"default": "", "hidden": True})},
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ()
    FUNCTION = "tag"
    CATEGORY = "checkpoint/handpicker"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, ckpt_name_str, hps_tab_id="", unique_id=None):
        return float("nan")

    def tag(self, ckpt_name_str, hps_tab_id="", unique_id=None):
        relpath = _normalize_relpath(ckpt_name_str)
        status = _get_status(relpath)
        title = f"Tagger : {STATUS_ICON[status]} {relpath}" if status != "none" else f"Tagger : {relpath}"
        _store_tagger_state(hps_tab_id, unique_id, relpath, status)
        _send_event(TAGGER_EVENT, {
            "node": int(unique_id) if unique_id is not None else None,
            "tab_id": _clean_tab_id(hps_tab_id),
            "node_class": "CheckpointStatusTagger",
            "ckpt_name_str": relpath,
            "ckpt_name_safe": _ckpt_name_safe_from_relpath(relpath),
            "status": status,
            "status_icon": STATUS_ICON[status],
            "title": title,
        })
        return ()


class EphemeralPreview:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"image": ("IMAGE",)},
            "optional": {"hps_tab_id": ("STRING", {"default": "", "hidden": True})},
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ()
    FUNCTION = "preview"
    CATEGORY = "checkpoint/handpicker/preview"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, image, hps_tab_id="", unique_id=None):
        return float("nan")

    def preview(self, image, hps_tab_id="", unique_id=None):
        try:
            pil_images = _tensor_batch_to_pil(image)
            sheet, meta = _build_contact_sheet(pil_images)
            meta["node_class"] = "EphemeralPreview"
            exec_state = _get_tab_execution_state(hps_tab_id)
            ckpt_name = exec_state.get("ckpt_name_str", "")
            status = exec_state.get("status", _get_status(ckpt_name) if ckpt_name else "none")
            if ckpt_name:
                meta.update({
                    "ckpt_name_str": ckpt_name,
                    "ckpt_name_safe": _ckpt_name_safe_from_relpath(ckpt_name),
                    "status": status,
                    "status_icon": STATUS_ICON.get(status, "—"),
                    "execution_revision": exec_state.get("execution_revision", 0),
                })
                title = f"Preview : {STATUS_ICON[status]} {ckpt_name}" if status != "none" else f"Preview : {ckpt_name}"
                _store_preview_state(hps_tab_id, unique_id, ckpt_name, status, execution_revision=exec_state.get("execution_revision", 0))
            else:
                title = "Ephemeral Preview"
            _send_preview(unique_id, title, sheet, meta, tab_id=hps_tab_id)
        except Exception:
            logger.exception("EphemeralPreview failed")
        return ()


class ImageDirPreview:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"ckpt_name_str": ("STRING", {"forceInput": True})},
            "optional": {
                "search_directory": ("STRING", {"forceInput": True}),
                "max_preview_images": ("INT", {"default": IMAGE_DIR_DEFAULT_MAX_IMAGES, "min": 1, "max": IMAGE_DIR_MAX_IMAGES}),
                "hps_tab_id": ("STRING", {"default": "", "hidden": True}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ()
    FUNCTION = "preview"
    CATEGORY = "checkpoint/handpicker/preview"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, ckpt_name_str, search_directory=None, max_preview_images=IMAGE_DIR_DEFAULT_MAX_IMAGES, hps_tab_id="", unique_id=None):
        return float("nan")

    def preview(self, ckpt_name_str, search_directory=None, max_preview_images=IMAGE_DIR_DEFAULT_MAX_IMAGES, hps_tab_id="", unique_id=None):
        relpath = _normalize_relpath(ckpt_name_str)
        sheet, extra = _load_image_dir_preview(unique_id, relpath, search_directory, tab_id=hps_tab_id, send_progress=True, max_preview_images=max_preview_images)
        status = _get_status(relpath)
        _store_preview_state(hps_tab_id, unique_id, relpath, status, node_class="ImageDirPreview")
        _send_preview(unique_id, _image_dir_title(relpath), sheet, extra, tab_id=hps_tab_id)
        return ()


routes = PromptServer.instance.routes


@routes.get(f"/{EXTENSION_PREFIX}/node_state")
async def node_state(request):
    node_id = str(request.query.get("node_id", ""))
    tab_id = _clean_tab_id(request.query.get("tab_id", ""))
    node_class = str(request.query.get("node_class", ""))
    key = _state_key(tab_id, node_id)
    if node_class == "CheckpointNameCycler":
        state = _get_cycler_state(key)
        payload = _cycler_state_payload(state)
        payload.update({"ok": True, "node_id": node_id, "node_class": node_class})
        return web.json_response(payload)
    if node_class == "CheckpointStatusTagger":
        state = dict(_TAGGER_STATES.get(key, {}))
        state.update({"ok": True, "node_id": node_id, "node_class": node_class})
        return web.json_response(state)
    if node_class == "EphemeralPreview":
        state = dict(_PREVIEW_STATES.get(key, {}))
        if not state:
            exec_state = _get_tab_execution_state(tab_id)
            if exec_state.get("ckpt_name_str"):
                state = {
                    "ckpt_name_str": exec_state.get("ckpt_name_str", ""),
                    "ckpt_name_safe": exec_state.get("ckpt_name_safe", ""),
                    "status": exec_state.get("status", "none"),
                    "status_icon": exec_state.get("status_icon", "—"),
                    "execution_revision": exec_state.get("execution_revision", 0),
                }
        state.update({"ok": True, "node_id": node_id, "node_class": node_class})
        return web.json_response(state)
    return web.json_response({"ok": False, "error": "Unsupported node_class."}, status=400)


@routes.get(f"/{EXTENSION_PREFIX}/selector/thumbnail")
async def selector_thumbnail(request):
    relpath = _normalize_relpath(request.query.get("ckpt_name_str", ""))
    if not relpath:
        return web.json_response({"ok": False, "error": "ckpt_name_str is required."}, status=400)
    if not _is_valid_checkpoint_relpath(relpath):
        return web.json_response({"ok": False, "error": "Invalid checkpoint path."}, status=400)
    image, path = _load_sidecar_thumbnail_preview(relpath)
    if image is None:
        return web.json_response({"ok": True, "found": False, "ckpt_name_str": relpath})
    payload = _encode_preview_payload(image)
    payload.update({
        "ok": True,
        "found": True,
        "ckpt_name_str": relpath,
        "thumbnail_path": path,
    })
    return web.json_response(payload)


@routes.post(f"/{EXTENSION_PREFIX}/image_dir_preview/context_menu")
async def image_dir_preview_context_menu(request):
    data = await request.json()
    node_id = str(data.get("node_id", ""))
    tab_id = _clean_tab_id(data.get("tab_id", ""))
    state, index, source_path, relpath = _get_preview_state_item(tab_id, node_id, data.get("item_index"))
    if not state or index is None or source_path is None or not relpath:
        return web.json_response({"ok": False, "error": "Preview item not found."}, status=404)
    exists = _preview_item_exists_for_state(state, source_path)
    if not exists:
        return web.json_response({
            "ok": True,
            "node_id": node_id,
            "item_index": index,
            "exists": False,
            "ckpt_name_str": relpath,
            "source_path": str(source_path),
            "items": [{"id": "deleted", "label": "Image deleted", "enabled": False}],
        })
    return web.json_response({
        "ok": True,
        "node_id": node_id,
        "item_index": index,
        "exists": True,
        "ckpt_name_str": relpath,
        "source_path": str(source_path),
        "items": [{"id": "set_thumbnail", "label": "Set as checkpoint thumbnail", "enabled": True}],
    })


@routes.post(f"/{EXTENSION_PREFIX}/image_dir_preview/set_thumbnail")
async def image_dir_preview_set_thumbnail(request):
    data = await request.json()
    node_id = str(data.get("node_id", ""))
    tab_id = _clean_tab_id(data.get("tab_id", ""))
    state, index, source_path, relpath = _get_preview_state_item(tab_id, node_id, data.get("item_index"))
    if not state or index is None or source_path is None or not relpath:
        return web.json_response({"ok": False, "error": "Preview item not found."}, status=404)
    if not _preview_item_exists_for_state(state, source_path):
        return web.json_response({
            "ok": True,
            "exists": False,
            "message": "Image deleted",
            "ckpt_name_str": relpath,
            "source_path": str(source_path),
        })
    try:
        payload = _set_checkpoint_thumbnail_from_preview_item(relpath, source_path)
    except ValueError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)
    except Exception:
        logger.exception("[CheckpointHandpickerSuite] failed to set checkpoint thumbnail")
        return web.json_response({"ok": False, "error": "Failed to set checkpoint thumbnail."}, status=500)
    payload.update({
        "ok": True,
        "exists": True,
        "message": "Checkpoint thumbnail updated.",
    })
    return web.json_response(payload)


@routes.get(f"/{EXTENSION_PREFIX}/list_checkpoints")
async def list_checkpoints(_request):
    items = _checkpoint_items()
    return web.json_response({
        "ok": True,
        "items": items,
        "summary": _delete_status_summary(),
        "status_text": _status_summary_text("List only"),
    })


@routes.post(f"/{EXTENSION_PREFIX}/refresh_all")
async def refresh_all(_request):
    checkpoint_values = _get_fresh_checkpoint_values()
    pruned_delete_records = _prune_missing_delete_records_on_refresh(checkpoint_values)
    patched_classes = _patch_backend_checkpoint_classes(checkpoint_values)
    items = _checkpoint_items()
    summary = _delete_status_summary()
    updated = len(checkpoint_values)
    logger.info("[CheckpointHandpickerSuite] Refresh All completed.")
    logger.info("[CheckpointHandpickerSuite] Checkpoints: %s total (favorite=%s, nice=%s, keep=%s, delete=%s, none=%s)", summary["total"], summary["favorite"], summary["nice"], summary["keep"], summary["delete"], summary["none"])
    logger.info("[CheckpointHandpickerSuite] Backend checkpoint classes patched: %s", patched_classes)
    if pruned_delete_records:
        logger.info("[CheckpointHandpickerSuite] Pruned missing delete reservation(s): %s", pruned_delete_records)
    _log_widget_refresh(updated)
    return web.json_response({
        "ok": True,
        "items": items,
        "summary": summary,
        "status_text": _status_summary_text("Refresh All"),
        "checkpoint_values": checkpoint_values,
        "patched_classes": patched_classes,
        "pruned_delete_records": pruned_delete_records,
    })


@routes.post(f"/{EXTENSION_PREFIX}/tagger/set_status")
async def tagger_set_status(request):
    data = await request.json()
    relpath = _normalize_relpath(data.get("ckpt_name_str", ""))
    requested = str(data.get("status", "none"))
    tab_id = _clean_tab_id(data.get("tab_id", ""))
    node_id = data.get("node_id") or data.get("node")
    if not _is_valid_checkpoint_relpath(relpath):
        return web.json_response({"ok": False, "error": "Invalid checkpoint path."}, status=400)
    if requested not in STATUS_VALUES:
        return web.json_response({"ok": False, "error": "Invalid status."}, status=400)
    current = _get_status(relpath)
    if requested == "none":
        status = "none"
    elif requested == current:
        status = "none"
    elif requested == "delete" and current not in ("none", "delete"):
        return web.json_response({"ok": False, "error": "Delete is available only from none."}, status=400)
    else:
        status = requested
    _set_status(relpath, status)
    if status == "delete":
        resolved = _resolve_checkpoint_unique(relpath)
        if resolved:
            _append_delete_record({
                "version": 1,
                "type": "reserve",
                "id": f"{int(time.time())}_{uuid.uuid4().hex}",
                "ckpt_name_str": relpath,
                "resolved_path": resolved["path"],
                "json_path": resolved["json_path"],
                "reserved_at": _now_iso(),
            })
            _write_delete_script()
    else:
        # Cancel active delete reservation for this checkpoint if it existed.
        active = _active_delete_records().get(relpath)
        if active and active.get("id"):
            _append_delete_record({
                "version": 1,
                "type": "cancel",
                "id": active.get("id"),
                "ckpt_name_str": relpath,
                "cancelled_at": _now_iso(),
                "reason": f"status_changed_to_{status}",
            })
            _write_delete_script()
    _store_tagger_state(tab_id, node_id, relpath, status)
    _send_status_changed(relpath, tab_id=tab_id, node_id=node_id)
    _refresh_cycler_states_for_status_change(relpath)
    return web.json_response({
        "ok": True,
        "ckpt_name_str": relpath,
        "ckpt_name_safe": _ckpt_name_safe_from_relpath(relpath),
        "status": status,
        "status_icon": STATUS_ICON[status],
        "summary": _delete_status_summary(),
    })


@routes.post(f"/{EXTENSION_PREFIX}/cycler/set_runtime_controls")
async def cycler_set_runtime_controls(request):
    data = await request.json()
    node_id = str(data.get("node_id", ""))
    tab_id = _clean_tab_id(data.get("tab_id", ""))
    state = _get_cycler_state(_state_key(tab_id, node_id))
    revision = _parse_saved_int(data.get("settings_revision"), _runtime_controls_from_state(state).get("settings_revision", 0))
    accepted, revision = _should_accept_settings_update(state, revision)
    if accepted:
        _set_runtime_controls(
            state,
            mode=data.get("mode") if "mode" in data else None,
            change_every=data.get("change_every") if "change_every" in data else None,
            start_checkpoint=data.get("start_checkpoint", "") if "start_checkpoint" in data else None,
            active_filter=data.get("active_filter") if "active_filter" in data else None,
            use_local_list=bool(data.get("use_local_list")) if "use_local_list" in data else None,
            settings_revision=revision,
            mark_initialized=True,
        )
    _send_cycler_state_update(node_id, state, tab_id=tab_id)
    payload = _cycler_state_payload(state)
    payload.update({"ok": True, "accepted": accepted, "node_id": node_id})
    return web.json_response(payload)


@routes.post(f"/{EXTENSION_PREFIX}/cycler/set_flags")
async def cycler_set_flags(request):
    data = await request.json()
    node_id = str(data.get("node_id", ""))
    tab_id = _clean_tab_id(data.get("tab_id", ""))
    state = _get_cycler_state(_state_key(tab_id, node_id))
    revision = _parse_saved_int(data.get("settings_revision"), _parse_saved_int(state.get("settings_revision"), 0))
    accepted, revision = _should_accept_settings_update(state, revision)
    if accepted:
        _set_runtime_controls(
            state,
            mode=data.get("mode") if "mode" in data else None,
            change_every=data.get("change_every") if "change_every" in data else None,
            start_checkpoint=data.get("start_checkpoint", "") if "start_checkpoint" in data else None,
            use_local_list=bool(data.get("use_local_list")) if "use_local_list" in data else None,
            settings_revision=revision,
            mark_initialized=True,
        )
    _send_cycler_state_update(node_id, state, tab_id=tab_id)
    payload = _cycler_state_payload(state)
    payload.update({"ok": True, "accepted": accepted, "use_local_list": state["use_local_list"]})
    return web.json_response(payload)


@routes.post(f"/{EXTENSION_PREFIX}/cycler/set_filter")
async def cycler_set_filter(request):
    data = await request.json()
    node_id = str(data.get("node_id", ""))
    tab_id = _clean_tab_id(data.get("tab_id", ""))
    statuses = _normalize_status_list(data.get("statuses", []))
    state = _get_cycler_state(_state_key(tab_id, node_id))
    revision = _parse_saved_int(data.get("settings_revision"), _parse_saved_int(state.get("settings_revision"), 0))
    accepted, revision = _should_accept_settings_update(state, revision)
    if accepted:
        _set_runtime_controls(
            state,
            mode=data.get("mode") if "mode" in data else None,
            change_every=data.get("change_every") if "change_every" in data else None,
            start_checkpoint=data.get("start_checkpoint", "") if "start_checkpoint" in data else None,
            active_filter=statuses.copy(),
            settings_revision=revision,
            mark_initialized=True,
        )
    _send_cycler_state_update(node_id, state, tab_id=tab_id)
    logger.info("[CheckpointHandpickerSuite] Updated cycler filter for tab %s node %s: %s accepted=%s", tab_id, node_id, statuses or ["All"], accepted)
    payload = _cycler_state_payload(state)
    payload.update({"ok": True, "accepted": accepted, "node_id": node_id, "statuses": _runtime_controls_from_state(state).get("active_filter", [])})
    return web.json_response(payload)


@routes.post(f"/{EXTENSION_PREFIX}/cycler/local_list_append")
async def cycler_local_list_append(request):
    data = await request.json()
    relpath = _normalize_relpath(data.get("ckpt_name_str", ""))
    if not _is_valid_checkpoint_relpath(relpath):
        return web.json_response({"ok": False, "error": "Invalid checkpoint path."}, status=400)
    tab_id = _clean_tab_id(data.get("tab_id", ""))
    target_node_ids = [str(x) for x in data.get("target_node_ids", []) if str(x).isdigit()]
    updated = 0
    states = []
    for node_id in target_node_ids:
        state = _get_cycler_state(_state_key(tab_id, node_id))
        if state.get("use_local_list", True):
            local_list = state.setdefault("local_list", [])
            local_list.append(relpath)
            state["override_queue"] = local_list
            state["last_status_text"] = _build_cycler_idle_status_text("", state)
            updated += 1
            _send_cycler_state_update(node_id, state, tab_id=tab_id)
            payload = _cycler_state_payload(state)
            payload.update({"node_id": node_id})
            states.append(payload)
    logger.info("[CheckpointHandpickerSuite] Pushed checkpoint to %s Local List(s) in tab %s: %s", updated, tab_id, relpath)
    return web.json_response({"ok": True, "updated": updated, "states": states})


@routes.post(f"/{EXTENSION_PREFIX}/cycler/clear_local_list")
async def cycler_clear_local_list(request):
    data = await request.json()
    node_id = str(data.get("node_id", ""))
    tab_id = _clean_tab_id(data.get("tab_id", ""))
    state = _get_cycler_state(_state_key(tab_id, node_id))
    cleared = len(state.get("local_list", []))
    state["local_list"] = []
    state["override_queue"] = []
    state["last_status_text"] = _build_cycler_idle_status_text("", state)
    _send_cycler_state_update(node_id, state, tab_id=tab_id)
    logger.info("[CheckpointHandpickerSuite] Cleared Local List for tab %s node %s: %s item(s)", tab_id, node_id, cleared)
    payload = _cycler_state_payload(state)
    payload.update({"node_id": node_id})
    return web.json_response({"ok": True, "cleared": cleared, "state": payload})


@routes.post(f"/{EXTENSION_PREFIX}/review/sync_checkpoint")
async def review_sync_checkpoint(request):
    data = await request.json()
    relpath = _normalize_relpath(data.get("ckpt_name_str", ""))
    tab_id = _clean_tab_id(data.get("tab_id", ""))
    if not _is_valid_checkpoint_relpath(relpath):
        return web.json_response({"ok": False, "error": "Invalid checkpoint path."}, status=400)
    status = _get_status(relpath)
    title = f"Tagger : {STATUS_ICON[status]} {relpath}" if status != "none" else f"Tagger : {relpath}"
    tagger_node_ids = [str(x) for x in data.get("tagger_node_ids", []) if str(x).isdigit()]
    for node_id in tagger_node_ids:
        _store_tagger_state(tab_id, node_id, relpath, status)
        _send_event(TAGGER_EVENT, {
            "node": int(node_id),
            "tab_id": tab_id,
            "node_class": "CheckpointStatusTagger",
            "ckpt_name_str": relpath,
            "ckpt_name_safe": _ckpt_name_safe_from_relpath(relpath),
            "status": status,
            "status_icon": STATUS_ICON[status],
            "title": title,
        })

    preview_targets = data.get("preview_targets")
    if not isinstance(preview_targets, list):
        preview_targets = []
        for node_id in data.get("preview_node_ids", []) or []:
            preview_targets.append({"node_id": node_id})

    preview_count = 0
    for target in preview_targets:
        try:
            node_id = str(target.get("node_id", ""))
            if not node_id.isdigit():
                continue
            search_directory = target.get("search_directory")
            max_preview_images = _clamp_image_dir_max_images(target.get("max_preview_images", IMAGE_DIR_DEFAULT_MAX_IMAGES))
            sheet, extra = await asyncio.to_thread(
                _load_image_dir_preview,
                node_id,
                relpath,
                search_directory,
                tab_id,
                True,
                max_preview_images,
            )
            _store_preview_state(tab_id, node_id, relpath, status, node_class="ImageDirPreview")
            _send_preview(node_id, _image_dir_title(relpath), sheet, extra, tab_id=tab_id)
            preview_count += 1
        except Exception:
            logger.exception("[CheckpointHandpickerSuite] failed to sync ImageDirPreview")

    return web.json_response({
        "ok": True,
        "ckpt_name_str": relpath,
        "ckpt_name_safe": _ckpt_name_safe_from_relpath(relpath),
        "status": status,
        "status_icon": STATUS_ICON[status],
        "taggers": len(tagger_node_ids),
        "previews": preview_count,
    })


NODE_CLASS_MAPPINGS = {
    "CheckpointListSelector": CheckpointListSelector,
    "CheckpointNameCycler": CheckpointNameCycler,
    "CheckpointStatusTagger": CheckpointStatusTagger,
    "EphemeralPreview": EphemeralPreview,
    "ImageDirPreview": ImageDirPreview,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "CheckpointListSelector": "Checkpoint List Selector",
    "CheckpointNameCycler": "Checkpoint Name Cycler",
    "CheckpointStatusTagger": "Checkpoint Status Tagger",
    "EphemeralPreview": "Ephemeral Preview",
    "ImageDirPreview": "ImageDir Preview",
}
