import base64
import io
import json
import logging
import math
import re
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Iterable

import folder_paths
import numpy as np
from aiohttp import web
from PIL import Image
from server import PromptServer

logger = logging.getLogger(__name__)

EXTENSION_PREFIX = "checkpoint_handpicker_suite"
PREVIEW_EVENT = "ruminar.checkpoint_handpicker_suite.preview"
CYCLER_EVENT = "ruminar.checkpoint_handpicker_suite.cycler"
TAGGER_EVENT = "ruminar.checkpoint_handpicker_suite.tagger"
STATUS_CHANGED_EVENT = "ruminar.checkpoint_handpicker_suite.status_changed"

STATUS_VALUES = ["favorite", "nice", "keep", "delete", "none"]
STATUS_ICON = {
    "favorite": "💛",
    "nice": "👍",
    "keep": "✔",
    "delete": "🗑",
    "none": "—",
}
STATUS_LABEL = {
    "favorite": "favorite",
    "nice": "nice",
    "keep": "keep",
    "delete": "delete",
    "none": "none",
}

NODE_DIR = Path(__file__).resolve().parent
DATA_DIR = NODE_DIR / "data"
STATUS_DB_PATH = DATA_DIR / "checkpoint_statuses.json"
FAVORITES_COMPAT_PATH = DATA_DIR / "checkpoint_favorites.json"
DELETE_QUEUE_PATH = Path(folder_paths.get_temp_directory()).resolve() / "checkpoint_delete_queue.jsonl"
DELETE_SCRIPT_PATH = Path(folder_paths.get_temp_directory()).resolve() / "delete_reserved_checkpoints.py"

JPEG_QUALITY = 80
JPEG_OPTIMIZE = False
GAP = 6
MAX_IMAGES = 64
MAX_LONG_EDGE = 512
MAX_CONTENT_EDGE = 4096
ALLOWED_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
ALLOWED_CHECKPOINT_SUFFIX = ".safetensors"

_STATE_LOCK = threading.Lock()
_CYCLER_STATES: dict[str, dict] = {}


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
    # compatibility file for older tools that only know favorites
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
    if status not in STATUS_VALUES:
        status = "none"
    return status


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


def _get_checkpoint_list() -> list[str]:
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


def _select_checkpoint_value(value: str | None) -> tuple[str, str]:
    relpath = _normalize_relpath(value or "")
    items = _checkpoint_items()
    if _is_valid_checkpoint_relpath(relpath):
        for item in items:
            if item["ckpt_name_str"] == relpath:
                return item["ckpt_name_str"], item["ckpt_name_safe"]
    if items:
        first = items[0]
        return first["ckpt_name_str"], first["ckpt_name_safe"]
    return "", "checkpoint"


def _status_summary_text(prefix: str) -> str:
    summary = _delete_status_summary()
    return (
        f"{prefix}: {summary['total']} total "
        f"(💛:{summary['favorite']}, 👍:{summary['nice']}, ✔:{summary['keep']}, 🗑:{summary['delete']}, —:{summary['none']})"
    )


def _status_icons_for_filter(active_statuses: list[str]) -> str:
    icons = []
    for s in ["favorite", "nice", "keep", "delete", "none"]:
        if s in active_statuses:
            icons.append(STATUS_ICON[s])
    return "".join(icons)


def _log_widget_refresh(updated_count: int):
    logger.info("[CheckpointHandpickerSuite] Updated checkpoint widgets: %s", updated_count)


def _active_delete_records() -> dict[str, dict]:
    active = {}
    if not DELETE_QUEUE_PATH.exists():
        return active
    try:
        for line in DELETE_QUEUE_PATH.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            rec = json.loads(line)
            typ = rec.get("type")
            relpath = _normalize_relpath(rec.get("ckpt_name_str", ""))
            rid = rec.get("id")
            if typ == "reserve" and rid and relpath:
                active[relpath] = rec
            elif typ == "cancel" and rid:
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


def _checkpoint_roots() -> list[Path]:
    try:
        roots = folder_paths.get_folder_paths("checkpoints")
    except Exception:
        roots = []
    return [Path(p).resolve() for p in roots]


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


def _write_delete_script():
    script = f'''#!/usr/bin/env python3
import json
from pathlib import Path

QUEUE_PATH = Path(r"{str(DELETE_QUEUE_PATH)}")


def active_records():
    active = {{}}
    if not QUEUE_PATH.exists():
        return active
    for line in QUEUE_PATH.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        typ = rec.get("type")
        relpath = rec.get("ckpt_name_str", "")
        rid = rec.get("id")
        if typ == "reserve" and rid and relpath:
            active[relpath] = rec
        elif typ == "cancel" and rid:
            for key, value in list(active.items()):
                if value.get("id") == rid:
                    active.pop(key, None)
    return active


records = list(active_records().values())
print("Checkpoint delete script")
print(f"Targets: {{len(records)}}")
for idx, rec in enumerate(records, start=1):
    ckpt = Path(rec["resolved_path"])
    json_path = ckpt.with_suffix(".json")
    print(f"\n[{{idx}}/{{len(records)}}] Delete checkpoint?")
    print(f"  relpath: {{rec['ckpt_name_str']}}")
    print(f"  safetensors: {{ckpt}}")
    print(f"  json: {{json_path}}")
    answer = input("Delete this checkpoint? (y/N): ").strip().lower()
    if answer != 'y':
        print("Skipped.")
        continue
    if ckpt.exists():
        ckpt.unlink()
        print("Deleted:", ckpt)
    if json_path.exists():
        json_path.unlink()
        print("Deleted:", json_path)

print("\nDeletion completed.")
print("Please return to ComfyUI and click:")
print("Checkpoint List Selector -> Refresh All")
'''
    DELETE_SCRIPT_PATH.write_text(script, encoding="utf-8")


def _send_event(name: str, payload: dict, client_id=None):
    server = PromptServer.instance
    client_id = client_id or getattr(server, "client_id", None)
    if client_id:
        server.send_sync(name, payload, client_id)
    else:
        server.send_sync(name, payload)


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
    return [_pil_from_array(arr) for arr in batch[:MAX_IMAGES]]


def _normalize_image_to_tile(img: Image.Image, tile_w: int, tile_h: int) -> Image.Image:
    resampling = getattr(Image, "Resampling", Image).LANCZOS
    w, h = img.size
    scale = min(tile_w / max(1, w), tile_h / max(1, h))
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    return img.resize((new_w, new_h), resampling)


def _reference_tile_size(images: list[Image.Image]) -> tuple[int, int]:
    ref = images[0]
    w, h = ref.size
    if w <= 0 or h <= 0:
        return 512, 512
    ratio = w / h
    if ratio < 0.25 or ratio > 4.0:
        return 512, 512
    if w >= h:
        return MAX_LONG_EDGE, max(1, int(round(MAX_LONG_EDGE / ratio)))
    return max(1, int(round(MAX_LONG_EDGE * ratio))), MAX_LONG_EDGE


def _choose_layout(count: int, tile_w: int, tile_h: int) -> SheetLayout:
    best = None
    max_cols_by_size = max(1, MAX_CONTENT_EDGE // max(1, tile_w))
    max_rows_by_size = max(1, MAX_CONTENT_EDGE // max(1, tile_h))
    max_cols_by_count = min(count, max_cols_by_size)
    for cols in range(1, max_cols_by_count + 1):
        rows = math.ceil(count / cols)
        if rows > max_rows_by_size:
            continue
        content_w = cols * tile_w
        content_h = rows * tile_h
        placed = min(count, cols * rows)
        if content_w > MAX_CONTENT_EDGE or content_h > MAX_CONTENT_EDGE:
            continue
        score = (placed, -abs(content_w - content_h), -cols)
        if best is None or score > best[0]:
            canvas_w = content_w + GAP * max(0, cols - 1)
            canvas_h = content_h + GAP * max(0, rows - 1)
            best = (score, SheetLayout(cols, rows, tile_w, tile_h, canvas_w, canvas_h, placed))
    if best is not None:
        return best[1]
    cols = max(1, min(count, max_cols_by_size))
    rows = max(1, min(max_rows_by_size, math.ceil(count / cols)))
    content_w = cols * tile_w
    content_h = rows * tile_h
    return SheetLayout(cols, rows, tile_w, tile_h, content_w + GAP * max(0, cols - 1), content_h + GAP * max(0, rows - 1), min(count, cols * rows))


def _build_contact_sheet(images: list[Image.Image]) -> tuple[Image.Image | None, dict]:
    if not images:
        return None, {"count": 0, "columns": 0, "rows": 0, "tile_width": 0, "tile_height": 0}
    tile_w, tile_h = _reference_tile_size(images)
    layout = _choose_layout(min(len(images), MAX_IMAGES), tile_w, tile_h)
    canvas = Image.new("RGB", (layout.canvas_width, layout.canvas_height), (24, 24, 24))
    normalized = [_normalize_image_to_tile(img, tile_w, tile_h) for img in images[:layout.count]]
    for idx, img in enumerate(normalized):
        row = idx // layout.cols
        col = idx % layout.cols
        x = col * (tile_w + GAP)
        y = row * (tile_h + GAP)
        px = x + (tile_w - img.width) // 2
        py = y + (tile_h - img.height) // 2
        if img.mode == "RGBA":
            canvas.paste(img, (px, py), img)
        else:
            canvas.paste(img, (px, py))
    return canvas, {
        "count": layout.count,
        "columns": layout.cols,
        "rows": layout.rows,
        "tile_width": tile_w,
        "tile_height": tile_h,
        "gap": GAP,
        "max_long_edge": MAX_LONG_EDGE,
        "max_images": MAX_IMAGES,
    }


def _encode_jpeg(image: Image.Image) -> str:
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=JPEG_OPTIMIZE)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _send_preview(node_id, title: str, image: Image.Image | None, extra: dict | None = None):
    payload = {
        "node": int(node_id) if node_id is not None else None,
        "title": title,
        "format": "jpeg",
        "image": None,
        "width": 0,
        "height": 0,
    }
    if image is not None:
        payload["image"] = _encode_jpeg(image)
        payload["width"] = image.width
        payload["height"] = image.height
    if extra:
        payload.update(extra)
    _send_event(PREVIEW_EVENT, payload)


def _find_preview_images(ckpt_name_str: str, search_directory: str | None = None) -> tuple[list[Path], str]:
    relpath = _normalize_relpath(ckpt_name_str)
    safe = _ckpt_name_safe_from_relpath(relpath)
    roots = []
    if search_directory and str(search_directory).strip():
        roots.append(Path(str(search_directory)).expanduser().resolve())
    else:
        roots.append(Path(folder_paths.get_output_directory()).resolve())
    found: list[Path] = []
    for root in roots:
        if not root.exists() or not root.is_dir():
            continue
        for path in sorted(root.rglob("*"), key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True):
            if len(found) >= MAX_IMAGES:
                break
            if not path.is_file() or path.suffix.lower() not in ALLOWED_IMAGE_SUFFIXES:
                continue
            name = path.stem.lower()
            if safe.lower() in name:
                found.append(path)
        if found:
            return found, str(root)
    return found, str(roots[0]) if roots else ""


def _send_cycler_update(node_id: str | None, title: str, status_text: str):
    _send_event(CYCLER_EVENT, {
        "node": int(node_id) if node_id is not None and str(node_id).isdigit() else None,
        "title": title,
        "status_text": status_text,
    })


def _get_cycler_state(node_key: str) -> dict:
    with _STATE_LOCK:
        state = _CYCLER_STATES.get(node_key)
        if state is None:
            state = {
                "use_local_list": True,
                "local_list": [],
                "active_filter": [],  # empty means All
                "repeat_count": 0,
                "current_index": 0,
                "cycle_count": 0,
                "last_checkpoint_hash": "",
                "last_ckpt_name": "",
                "last_title": "",
                "last_hold_index": 0,
                "last_change_every": 1,
                # compatibility with older draft state/routes
                "accept_queue": True,
                "override_queue": [],
                "accept_filter": True,
            }
            _CYCLER_STATES[node_key] = state
        # migrate older draft keys in-memory
        if "use_local_list" not in state:
            state["use_local_list"] = bool(state.get("accept_queue", True))
        if "local_list" not in state:
            state["local_list"] = list(state.get("override_queue", []))
        if "active_filter" not in state:
            state["active_filter"] = []
        return state

def _checkpoint_hash(names: Iterable[str]) -> str:
    return "\n".join(names)


def _filter_checkpoints(checkpoints: list[str], statuses: list[str]) -> tuple[list[str], bool]:
    if not statuses:
        return checkpoints, False
    active = [s for s in statuses if s in STATUS_VALUES]
    if not active:
        return checkpoints, False
    filtered = [ckpt for ckpt in checkpoints if _get_status(ckpt) in active]
    if not filtered:
        return checkpoints, True
    return filtered, False


def _find_start_index(checkpoints: list[str], start_checkpoint: str) -> int:
    rel = _normalize_relpath(start_checkpoint)
    for i, ckpt in enumerate(checkpoints):
        if _normalize_relpath(ckpt) == rel:
            return i
    return 0


def _build_cycler_title(source: str, ckpt_name: str, hold_index: int, change_every: int, active_filter: list[str], fallback_all: bool, local_list_total: int) -> str:
    status = _get_status(ckpt_name)
    icon = STATUS_ICON[status] if status != "none" else ""
    display = f"{icon} {ckpt_name}".strip()
    if source == "local_list":
        return f"Cycler : {display} (Local List)"
    if fallback_all:
        return f"Cycler : ⚠ {ckpt_name} ({hold_index}/{change_every} Filter:0→All)"
    return f"Cycler : {display} ({hold_index}/{change_every})"


def _filter_label(active_filter: list[str]) -> str:
    if not active_filter:
        return "All"
    icons = _status_icons_for_filter(active_filter)
    return icons or "All"


def _build_cycler_status_text(source: str, ckpt_name: str, active_filter: list[str], fallback_all: bool, local_list_remaining: list[str], hold_index: int, change_every: int, total_matches: int, local_list_total: int | None = None) -> str:
    lines = []
    if ckpt_name:
        status = _get_status(ckpt_name)
        lines.append(f"Current: {STATUS_ICON[status]} {ckpt_name}" if status != "none" else f"Current: {ckpt_name}")
    else:
        lines.append("Current: (not executed yet)")
    if source == "local_list":
        lines.append("Source: Local List")
        total = local_list_total if local_list_total is not None else len(local_list_remaining)
        lines.append(f"Local List Total: {total}")
        lines.append(f"Local List Remaining: {len(local_list_remaining)}")
        if local_list_remaining:
            lines.append("Remaining:")
            for i, item in enumerate(local_list_remaining[:8], start=1):
                s = _get_status(item)
                prefix = STATUS_ICON[s] if s != "none" else "-"
                lines.append(f"{i}. {prefix} {item}")
        if active_filter:
            lines.append(f"Filter: {_filter_label(active_filter)}")
            lines.append("Note: Local List has priority over Filter.")
    else:
        lines.append("Source: Normal Cycle" if not active_filter else "Source: Status Filter")
        lines.append(f"Filter: {_filter_label(active_filter)}")
        if fallback_all:
            lines.append("⚠ Filter matched 0 checkpoints. Using all checkpoints.")
        lines.append(f"Matches: {total_matches}")
        lines.append(f"Hold: {hold_index} / {change_every}")
        if local_list_remaining:
            lines.append(f"Local List Pending: {len(local_list_remaining)}")
    return "\n".join(lines)


def _build_cycler_pending_status_text(state: dict) -> str:
    all_checkpoints = _get_checkpoint_list()
    active_filter = state.get("active_filter", []) or []
    filtered, fallback_all = _filter_checkpoints(all_checkpoints, active_filter)
    if not filtered:
        filtered = all_checkpoints
    local_list = list(state.get("local_list", []))
    last_ckpt = state.get("last_ckpt_name", "")
    hold = int(state.get("last_hold_index") or 0)
    change_every = int(state.get("last_change_every") or 1)
    source = "local_list" if local_list else "cycle"
    if not last_ckpt and filtered:
        # keep status honest: this is not current output, just a pending preview
        lines = ["Current: (not executed yet)"]
        if local_list:
            lines.append("Source: Local List")
            lines.append(f"Local List Total: {len(local_list)}")
            lines.append(f"Local List Remaining: {len(local_list)}")
            lines.append("Pending:")
            for i, item in enumerate(local_list[:8], start=1):
                s = _get_status(item)
                prefix = STATUS_ICON[s] if s != "none" else "-"
                lines.append(f"{i}. {prefix} {item}")
            if active_filter:
                lines.append(f"Filter: {_filter_label(active_filter)}")
                lines.append("Note: Local List has priority over Filter.")
        else:
            lines.append("Source: Normal Cycle" if not active_filter else "Source: Status Filter")
            lines.append(f"Filter: {_filter_label(active_filter)}")
            if fallback_all:
                lines.append("⚠ Filter matched 0 checkpoints. Using all checkpoints.")
            lines.append(f"Matches: {len(filtered)}")
            lines.append("Note: Filter will apply on next Cycler execution.")
        return "\n".join(lines)
    return _build_cycler_status_text(
        source,
        last_ckpt,
        active_filter,
        fallback_all,
        local_list,
        hold if hold else 1,
        change_every,
        len(filtered),
        len(local_list),
    )


def _send_cycler_state_update(node_id: str, state: dict):
    _send_cycler_update(node_id, "", _build_cycler_pending_status_text(state))


class CheckpointListSelector:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "checkpoint": ("STRING", {"default": ""}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("ckpt_name", "ckpt_name_str", "ckpt_name_safe")
    FUNCTION = "select"
    CATEGORY = "checkpoint/handpicker"

    @classmethod
    def IS_CHANGED(cls, checkpoint="", unique_id=None):
        return float("nan")

    def select(self, checkpoint="", unique_id=None):
        ckpt_name_str, ckpt_name_safe = _select_checkpoint_value(checkpoint)
        return (ckpt_name_str, ckpt_name_str, ckpt_name_safe)


class CheckpointNameCycler:
    @classmethod
    def INPUT_TYPES(cls):
        checkpoints = _get_checkpoint_list()
        return {
            "required": {
                "start_checkpoint": (checkpoints if checkpoints else [""],),
                "mode": (["fixed", "increment", "randomize"], {"default": "increment"}),
                "change_every": ("INT", {"default": 1, "min": 1, "max": 999999}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = (_get_checkpoint_list() if _get_checkpoint_list() else [""], "STRING", "STRING")
    RETURN_NAMES = ("ckpt_name", "ckpt_name_str", "ckpt_name_safe")
    FUNCTION = "cycle"
    CATEGORY = "checkpoint/handpicker"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return time.time_ns()

    def cycle(self, start_checkpoint, mode, change_every, unique_id=None):
        node_key = str(unique_id) if unique_id is not None else "__default__"
        state = _get_cycler_state(node_key)
        all_checkpoints = _get_checkpoint_list()
        fallback_all = False
        active_filter = state.get("active_filter", []) or []
        filtered, fallback_all = _filter_checkpoints(all_checkpoints, active_filter)
        if not filtered:
            filtered = all_checkpoints
        checkpoint_hash = _checkpoint_hash(filtered)
        if state.get("last_checkpoint_hash") != checkpoint_hash:
            state["current_index"] = _find_start_index(filtered, start_checkpoint)
            state["repeat_count"] = 0
            state["last_checkpoint_hash"] = checkpoint_hash
        if not filtered:
            return ("", "", "checkpoint")

        local_list = state.get("local_list", []) if state.get("use_local_list", True) else []
        source = "cycle"
        if local_list:
            ckpt_name = local_list.pop(0)
            state["local_list"] = local_list
            # keep older draft key mirrored for compatibility while testing
            state["override_queue"] = local_list
            hold_index = 1
            local_total = len(local_list) + 1
            title = _build_cycler_title("local_list", ckpt_name, hold_index, int(change_every), active_filter, False, local_total)
            status_text = _build_cycler_status_text("local_list", ckpt_name, active_filter, False, local_list, hold_index, int(change_every), len(filtered), local_total)
        else:
            index = max(0, min(int(state.get("current_index", 0)), len(filtered) - 1))
            ckpt_name = filtered[index]
            state["repeat_count"] = int(state.get("repeat_count", 0)) + 1
            hold_index = state["repeat_count"]
            if hold_index >= int(change_every):
                state["repeat_count"] = 0
                if mode == "increment":
                    next_index = index + 1
                    if next_index >= len(filtered):
                        next_index = 0
                        state["cycle_count"] = int(state.get("cycle_count", 0)) + 1
                    state["current_index"] = next_index
                elif mode == "randomize":
                    state["current_index"] = int(time.time_ns()) % len(filtered)
            title = _build_cycler_title(source, ckpt_name, hold_index, int(change_every), active_filter, fallback_all, 0)
            status_text = _build_cycler_status_text(source, ckpt_name, active_filter, fallback_all, local_list, hold_index, int(change_every), len(filtered), 0)
        state["last_ckpt_name"] = ckpt_name
        state["last_title"] = title
        state["last_hold_index"] = hold_index
        state["last_change_every"] = int(change_every)
        _send_cycler_update(node_key, title, status_text)
        return (ckpt_name, ckpt_name, _ckpt_name_safe_from_relpath(ckpt_name))


class CheckpointStatusTagger:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "ckpt_name_str": ("STRING", {"forceInput": True}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "tag"
    CATEGORY = "checkpoint/handpicker"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, ckpt_name_str, unique_id=None):
        return float("nan")

    def tag(self, ckpt_name_str, unique_id=None):
        relpath = _normalize_relpath(ckpt_name_str)
        status = _get_status(relpath)
        title = f"Tagger : {STATUS_ICON[status]} {relpath}" if status != "none" else f"Tagger : {relpath}"
        _send_event(TAGGER_EVENT, {
            "node": int(unique_id) if unique_id is not None else None,
            "ckpt_name_str": relpath,
            "status": status,
            "title": title,
        })
        return ()


class EphemeralPreviewTap:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"image": ("IMAGE",)},
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "tap"
    CATEGORY = "checkpoint/handpicker/preview"

    @classmethod
    def IS_CHANGED(cls, image, unique_id=None):
        return float("nan")

    def tap(self, image, unique_id=None):
        try:
            pil_images = _tensor_batch_to_pil(image)
            sheet, meta = _build_contact_sheet(pil_images)
            _send_preview(unique_id, "Ephemeral Preview Tap", sheet, meta)
        except Exception:
            logger.exception("EphemeralPreviewTap failed")
        return (image,)


class EphemeralPreview:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"image": ("IMAGE",)},
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ()
    FUNCTION = "preview"
    CATEGORY = "checkpoint/handpicker/preview"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, image, unique_id=None):
        return float("nan")

    def preview(self, image, unique_id=None):
        try:
            pil_images = _tensor_batch_to_pil(image)
            sheet, meta = _build_contact_sheet(pil_images)
            _send_preview(unique_id, "Ephemeral Preview", sheet, meta)
        except Exception:
            logger.exception("EphemeralPreview failed")
        return ()


class ImageDirPreview:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "ckpt_name_str": ("STRING", {"forceInput": True}),
            },
            "optional": {
                "search_directory": ("STRING", {"forceInput": True}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "preview"
    CATEGORY = "checkpoint/handpicker/preview"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, ckpt_name_str, search_directory=None, unique_id=None):
        return float("nan")

    def preview(self, ckpt_name_str, search_directory=None, unique_id=None):
        relpath = _normalize_relpath(ckpt_name_str)
        paths, root = _find_preview_images(relpath, search_directory)
        pil_images = []
        for path in paths[:MAX_IMAGES]:
            try:
                pil_images.append(Image.open(path).convert("RGB"))
            except Exception:
                logger.exception("Failed to open preview image: %s", path)
        sheet, meta = _build_contact_sheet(pil_images)
        title = f"ImageDir : {STATUS_ICON[_get_status(relpath)]} {relpath}" if _get_status(relpath) != "none" else f"ImageDir : {relpath}"
        extra = {"ckpt_name_str": relpath, "search_directory": root, "preview_found": bool(paths)}
        extra.update(meta)
        _send_preview(unique_id, title, sheet, extra)
        return ()


routes = PromptServer.instance.routes


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
    items = _checkpoint_items()
    summary = _delete_status_summary()
    updated = len(items)  # backend-side best-effort info for logs only
    logger.info("[CheckpointHandpickerSuite] Refresh All completed.")
    logger.info(
        "[CheckpointHandpickerSuite] Checkpoints: %s total (favorite=%s, nice=%s, keep=%s, delete=%s, none=%s)",
        summary["total"], summary["favorite"], summary["nice"], summary["keep"], summary["delete"], summary["none"],
    )
    _log_widget_refresh(updated)
    return web.json_response({
        "ok": True,
        "items": items,
        "summary": summary,
        "status_text": _status_summary_text("Refresh All"),
    })


@routes.post(f"/{EXTENSION_PREFIX}/tagger/set_status")
async def tagger_set_status(request):
    data = await request.json()
    relpath = _normalize_relpath(data.get("ckpt_name_str", ""))
    requested = str(data.get("status", "none"))
    if not _is_valid_checkpoint_relpath(relpath):
        return web.json_response({"ok": False, "error": "Invalid checkpoint path."}, status=400)
    if requested not in STATUS_VALUES:
        return web.json_response({"ok": False, "error": "Invalid status."}, status=400)

    current = _get_status(relpath)
    if requested == "none":
        status = "none"
    elif requested == current:
        status = "none"  # toggle off
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
                "id": f"{int(time.time())}_{uuid.uuid4().hex[:12]}",
                "ckpt_name_str": relpath,
                "ckpt_name_safe": _ckpt_name_safe_from_relpath(relpath),
                "resolved_path": resolved["path"],
                "reserved_at": _now_iso(),
            })
            _write_delete_script()
    elif current == "delete" and status != "delete":
        active = _active_delete_records().get(relpath)
        if active:
            _append_delete_record({
                "version": 1,
                "type": "cancel",
                "id": active.get("id"),
                "ckpt_name_str": relpath,
                "cancelled_at": _now_iso(),
            })
            _write_delete_script()
    payload = {
        "ok": True,
        "ckpt_name_str": relpath,
        "status": _get_status(relpath),
        "status_icon": STATUS_ICON[_get_status(relpath)],
        "summary": _delete_status_summary(),
    }
    _send_event(STATUS_CHANGED_EVENT, payload)
    return web.json_response(payload)


@routes.post(f"/{EXTENSION_PREFIX}/cycler/set_flags")
async def cycler_set_flags(request):
    data = await request.json()
    node_id = str(data.get("node_id", ""))
    state = _get_cycler_state(node_id)
    if "use_local_list" in data:
        state["use_local_list"] = bool(data.get("use_local_list"))
        state["accept_queue"] = state["use_local_list"]
    _send_cycler_state_update(node_id, state)
    return web.json_response({"ok": True, "use_local_list": state["use_local_list"]})


@routes.post(f"/{EXTENSION_PREFIX}/cycler/set_filter")
async def cycler_set_filter(request):
    data = await request.json()
    node_id = str(data.get("node_id", ""))
    statuses = [s for s in data.get("statuses", []) if s in STATUS_VALUES]
    state = _get_cycler_state(node_id)
    state["active_filter"] = statuses.copy()
    _send_cycler_state_update(node_id, state)
    logger.info("[CheckpointHandpickerSuite] Updated cycler filter for node %s: %s", node_id, statuses or ["All"])
    return web.json_response({"ok": True, "node_id": node_id, "statuses": statuses})


@routes.post(f"/{EXTENSION_PREFIX}/cycler/local_list_append")
async def cycler_local_list_append(request):
    data = await request.json()
    relpath = _normalize_relpath(data.get("ckpt_name_str", ""))
    if not _is_valid_checkpoint_relpath(relpath):
        return web.json_response({"ok": False, "error": "Invalid checkpoint path."}, status=400)
    updated = 0
    with _STATE_LOCK:
        target_states = list(_CYCLER_STATES.items())
    for node_id, state in target_states:
        if state.get("use_local_list", True):
            state.setdefault("local_list", []).append(relpath)
            state["override_queue"] = state["local_list"]
            updated += 1
            _send_cycler_state_update(node_id, state)
    logger.info("[CheckpointHandpickerSuite] Pushed checkpoint to %s Local List(s): %s", updated, relpath)
    return web.json_response({"ok": True, "updated": updated})


@routes.post(f"/{EXTENSION_PREFIX}/cycler/clear_local_list")
async def cycler_clear_local_list(request):
    data = await request.json()
    node_id = str(data.get("node_id", ""))
    state = _get_cycler_state(node_id)
    cleared = len(state.get("local_list", []))
    state["local_list"] = []
    state["override_queue"] = []
    _send_cycler_state_update(node_id, state)
    logger.info("[CheckpointHandpickerSuite] Cleared Local List for node %s: %s item(s)", node_id, cleared)
    return web.json_response({"ok": True, "cleared": cleared})


NODE_CLASS_MAPPINGS = {
    "CheckpointListSelector": CheckpointListSelector,
    "CheckpointNameCycler": CheckpointNameCycler,
    "CheckpointStatusTagger": CheckpointStatusTagger,
    "EphemeralPreviewTap": EphemeralPreviewTap,
    "EphemeralPreview": EphemeralPreview,
    "ImageDirPreview": ImageDirPreview,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "CheckpointListSelector": "Checkpoint List Selector",
    "CheckpointNameCycler": "Checkpoint Name Cycler",
    "CheckpointStatusTagger": "Checkpoint Status Tagger",
    "EphemeralPreviewTap": "Ephemeral Preview Tap",
    "EphemeralPreview": "Ephemeral Preview",
    "ImageDirPreview": "ImageDir Preview",
}
