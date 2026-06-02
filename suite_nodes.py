import asyncio
import base64
import io
import json
import logging
import math
import random
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
IMAGE_DIR_DEFAULT_MAX_IMAGES = 12
IMAGE_DIR_MAX_IMAGES = 80
MAX_LONG_EDGE = 512
MAX_CONTENT_EDGE = 4096
ALLOWED_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
ALLOWED_CHECKPOINT_SUFFIX = ".safetensors"

_STATE_LOCK = threading.Lock()
_CYCLER_STATES: dict[str, dict] = {}


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
    """Write the manual checkpoint deletion script into ComfyUI's temp directory.

    The generated script intentionally uses plain print() for blank lines.
    Do not generate string literals like "\\n..." here, because this function
    itself writes Python source code and nested escaping is easy to break.
    """
    DELETE_SCRIPT_PATH.parent.mkdir(parents=True, exist_ok=True)

    roots_json = json.dumps(
        [str(root.resolve()) for root in _checkpoint_roots()],
        ensure_ascii=False,
        indent=2,
    )

    script_template = '''#!/usr/bin/env python3
# Generated by ComfyUI-CheckpointHandpickerSuite.
# This script reads the delete reservation queue at execution time.
# Review each prompt carefully. Default answer is No.

import json
from pathlib import Path


QUEUE_PATH = Path(__QUEUE_PATH_LITERAL__)
ALLOWED_ROOTS = [Path(p).resolve() for p in __ALLOWED_ROOTS_JSON__]
ALLOWED_SUFFIXES = {".safetensors", ".json"}


def is_under_root(path, root):
    path = Path(path).resolve()
    root = Path(root).resolve()
    return path == root or root in path.parents


def is_safe_target(path):
    path = Path(path).resolve()
    if path.suffix.lower() not in ALLOWED_SUFFIXES:
        return False
    return any(is_under_root(path, root) for root in ALLOWED_ROOTS)


def read_records():
    if not QUEUE_PATH.exists():
        return []

    records = []
    for line in QUEUE_PATH.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
            if isinstance(rec, dict):
                records.append(rec)
        except Exception as exc:
            print("Skipping invalid queue record:", exc)
    return records


def active_records():
    active = {}
    for rec in read_records():
        typ = rec.get("type")
        relpath = rec.get("ckpt_name_str", "")
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
    return active


def active_targets():
    targets = []
    for relpath, rec in sorted(active_records().items(), key=lambda x: x[0].lower()):
        raw_ckpt_path = rec.get("resolved_path") or rec.get("safetensors_path") or ""
        if not raw_ckpt_path:
            print("Skipping target without resolved_path:", relpath)
            continue

        ckpt = Path(raw_ckpt_path).resolve()
        json_path = Path(rec.get("json_path") or ckpt.with_suffix(".json")).resolve()
        targets.append({
            "ckpt_name_str": relpath,
            "safetensors_path": str(ckpt),
            "json_path": str(json_path),
            "reserved_at": rec.get("reserved_at", ""),
        })
    return targets


def delete_file(path):
    path = Path(path).resolve()

    if not is_safe_target(path):
        print("Unsafe target, skipped:", path)
        return

    if not path.exists():
        print("Not found:", path)
        return

    if not path.is_file():
        print("Not a file, skipped:", path)
        return

    path.unlink()
    print("Deleted:", path)


def main():
    targets = active_targets()

    print("Checkpoint delete script")
    print("Queue file:", QUEUE_PATH)
    print("Allowed roots:")
    for root in ALLOWED_ROOTS:
        print("  ", root)
    print("Targets:", len(targets))

    for idx, item in enumerate(targets, start=1):
        print()
        print(f"[{idx}/{len(targets)}] Delete checkpoint?")
        print("  relpath:", item["ckpt_name_str"])
        print("  safetensors:", item["safetensors_path"])
        print("  json:", item["json_path"])
        if item.get("reserved_at"):
            print("  reserved_at:", item["reserved_at"])

        answer = input("Delete this checkpoint? (y/N): ").strip().lower()
        if answer != "y":
            print("Skipped.")
            continue

        delete_file(item["safetensors_path"])
        delete_file(item["json_path"])

    print()
    print("Deletion completed.")
    print("Please return to ComfyUI and click:")
    print("Checkpoint List Selector -> Refresh All")


if __name__ == "__main__":
    main()
'''

    script = (
        script_template
        .replace("__QUEUE_PATH_LITERAL__", repr(str(DELETE_QUEUE_PATH)))
        .replace("__ALLOWED_ROOTS_JSON__", roots_json)
    )

    DELETE_SCRIPT_PATH.write_text(script, encoding="utf-8", newline="\n")
    return DELETE_SCRIPT_PATH

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
    # EphemeralPreview is a faithful branch-end preview. Do not silently drop
    # batch items here; the contact sheet builder will shrink only when needed.
    return [_pil_from_array(arr) for arr in batch]


def _clamp_image_dir_max_images(value) -> int:
    try:
        value = int(value)
    except Exception:
        value = IMAGE_DIR_DEFAULT_MAX_IMAGES
    return max(1, min(IMAGE_DIR_MAX_IMAGES, value))


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


def _reference_image_size(images: list[Image.Image]) -> tuple[int, int]:
    if not images:
        return 512, 512
    ref = images[0]
    w, h = ref.size
    if w <= 0 or h <= 0:
        return 512, 512
    ratio = w / h
    if ratio < 0.25 or ratio > 4.0:
        return 512, 512
    return int(w), int(h)


def _layout_for_grid(count: int, ref_w: int, ref_h: int, cols: int, rows: int, allow_upscale: bool = False) -> SheetLayout | None:
    scale = min(MAX_CONTENT_EDGE / max(1, cols * ref_w), MAX_CONTENT_EDGE / max(1, rows * ref_h))
    if not allow_upscale:
        scale = min(1.0, scale)
    if scale <= 0:
        return None
    tile_w = max(1, int(ref_w * scale))
    tile_h = max(1, int(ref_h * scale))
    content_w = cols * tile_w
    content_h = rows * tile_h
    if content_w > MAX_CONTENT_EDGE or content_h > MAX_CONTENT_EDGE:
        return None
    return SheetLayout(
        cols,
        rows,
        tile_w,
        tile_h,
        content_w + GAP * max(0, cols - 1),
        content_h + GAP * max(0, rows - 1),
        count,
    )


def _choose_layout_fit(count: int, ref_w: int, ref_h: int, allow_upscale: bool = False) -> SheetLayout:
    """Choose a contact-sheet layout using MAX_CONTENT_EDGE as the image-content limit.

    GAP is intentionally ignored for the fit calculation and added only to the
    final canvas size. This keeps overview sheets readable, with the small gap
    overflow accepted by design.

    The grid is chosen by scoring every possible column count and selecting the
    layout whose final content area is closest to square. This avoids hard-coded
    per-count tables while naturally choosing layouts such as:

    - 5 portrait images  -> 3x2
    - 10 portrait images -> 4x3
    - 12 portrait images -> 4x3
    - 80 landscape images -> 8x10

    Tie-breakers prefer larger tile scale, fewer empty cells, and then a layout
    that follows the source image orientation.
    """
    count = max(1, int(count))
    ref_w = max(1, int(ref_w))
    ref_h = max(1, int(ref_h))

    eps = 1e-12
    landscape = ref_w >= ref_h
    best = None

    for cols in range(1, count + 1):
        rows = math.ceil(count / cols)
        cells = cols * rows
        empty = cells - count

        raw_w = cols * ref_w
        raw_h = rows * ref_h
        scale = min(MAX_CONTENT_EDGE / max(1, raw_w), MAX_CONTENT_EDGE / max(1, raw_h))
        if not allow_upscale:
            scale = min(1.0, scale)
        if scale <= 0:
            continue

        tile_w = max(1, int(ref_w * scale))
        tile_h = max(1, int(ref_h * scale))
        content_w = cols * tile_w
        content_h = rows * tile_h
        if content_w <= 0 or content_h <= 0:
            continue
        if content_w > MAX_CONTENT_EDGE or content_h > MAX_CONTENT_EDGE:
            continue

        canvas_w = content_w + GAP * max(0, cols - 1)
        canvas_h = content_h + GAP * max(0, rows - 1)

        # Gemini-style grid choice: make the whole sheet as close to square as
        # possible. Use EPS so near-identical float results do not flap between
        # layouts.
        aspect_score = max(content_w, content_h) / max(1, min(content_w, content_h))
        orientation_bonus = 1 if ((cols >= rows) if landscape else (rows >= cols)) else 0
        tie_score = (
            round(scale, 8),
            -empty,
            orientation_bonus,
            cols if landscape else rows,
        )

        layout = SheetLayout(cols, rows, tile_w, tile_h, canvas_w, canvas_h, count)
        if best is None:
            best = (aspect_score, tie_score, layout)
            continue

        best_aspect, best_tie, _ = best
        if aspect_score < best_aspect - eps:
            best = (aspect_score, tie_score, layout)
        elif abs(aspect_score - best_aspect) <= eps and tie_score > best_tie:
            best = (aspect_score, tie_score, layout)

    if best is not None:
        return best[2]
    return SheetLayout(1, count, ref_w, ref_h, ref_w, count * ref_h + GAP * max(0, count - 1), count)


def _build_contact_sheet(
    images: list[Image.Image],
    progress_callback=None,
    max_images: int | None = None,
    allow_upscale: bool = False,
) -> tuple[Image.Image | None, dict]:
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
            canvas.paste(img, (px, py))
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

def _encode_jpeg(image: Image.Image) -> str:
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=JPEG_QUALITY, optimize=JPEG_OPTIMIZE)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _send_preview(node_id, title: str, image: Image.Image | None, extra: dict | None = None, tab_id: str | None = None):
    payload = {
        "node": int(node_id) if node_id is not None and str(node_id).isdigit() else None,
        "title": title,
        "format": "jpeg",
        "image": None,
        "width": 0,
        "height": 0,
    }
    if tab_id is not None:
        payload["tab_id"] = _clean_tab_id(tab_id)
    if image is not None:
        payload["image"] = _encode_jpeg(image)
        payload["width"] = image.width
        payload["height"] = image.height
    if extra:
        payload.update(extra)
    _send_event(PREVIEW_EVENT, payload)


def _image_dir_title(relpath: str) -> str:
    status = _get_status(relpath)
    return f"ImageDir : {STATUS_ICON[status]} {relpath}" if status != "none" else f"ImageDir : {relpath}"


def _send_image_dir_progress(node_id, relpath: str, message: str, value: int = 0, total: int = 0, tab_id: str | None = None, root: str = ""):
    # Keep both the old CheckpointCleanupReview field names and the newer
    # ImageDirPreview caption field. Some frontend builds draw one or the other.
    _send_preview(
        node_id,
        _image_dir_title(relpath),
        None,
        {
            "node_class": "ImageDirPreview",
            "ckpt_name_str": relpath,
            "search_directory": root,
            "status": "loading",
            "message": message,
            "progress_message": message,
            "progress_value": value,
            "progress_total": total,
            "progress": True,
        },
        tab_id=tab_id,
    )


def _resolve_search_root(search_directory: str | None) -> tuple[Path, str]:
    if search_directory is None:
        return Path(folder_paths.get_output_directory()).resolve(), "default_output"
    value = str(search_directory).strip()
    if not value:
        return Path(folder_paths.get_output_directory()).resolve(), "default_output"
    try:
        candidate = Path(value).expanduser().resolve()
        if candidate.exists() and candidate.is_dir():
            return candidate, "custom"
        return Path(folder_paths.get_output_directory()).resolve(), "invalid_fallback_output"
    except Exception:
        return Path(folder_paths.get_output_directory()).resolve(), "invalid_fallback_output"


def _iter_dirs_newest_first(root: Path):
    root = root.resolve()
    queue = [root]
    while queue:
        current = queue.pop(0)
        yield current
        try:
            children = [p for p in current.iterdir() if p.is_dir()]
            children.sort(key=lambda p: p.stat().st_mtime, reverse=True)
            queue[0:0] = children
        except Exception:
            continue


def _find_preview_images(ckpt_name_str: str, search_directory: str | None = None, max_images: int = IMAGE_DIR_DEFAULT_MAX_IMAGES, progress_callback=None) -> tuple[list[Path], str, str]:
    relpath = _normalize_relpath(ckpt_name_str)
    safe = _ckpt_name_safe_from_relpath(relpath)
    root, mode = _resolve_search_root(search_directory)
    found: list[Path] = []
    if not root.exists() or not root.is_dir():
        return found, str(root), "missing_search_root"

    safe_lower = safe.lower()
    for directory in _iter_dirs_newest_first(root):
        try:
            files = [
                p for p in directory.iterdir()
                if p.is_file()
                and p.suffix.lower() in ALLOWED_IMAGE_SUFFIXES
                and safe_lower in p.stem.lower()
            ]
            files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
            for file in files:
                resolved = file.resolve()
                # A symlink should not escape the selected preview root.
                try:
                    if resolved != root and root not in resolved.parents:
                        continue
                except Exception:
                    continue
                found.append(resolved)
                if progress_callback:
                    progress_callback(len(found), max_images, f"Found preview images {len(found)}/{max_images}")
                if len(found) >= max_images:
                    return found, str(root), mode
        except Exception:
            continue
    return found, str(root), mode


def _load_pil_images(paths: list[Path], max_images: int | None = None, progress_callback=None) -> list[Image.Image]:
    images: list[Image.Image] = []
    limit = len(paths) if max_images is None else max(1, min(int(max_images), len(paths)))
    total = limit
    for index, path in enumerate(paths[:limit], start=1):
        if progress_callback:
            progress_callback(index - 1, total, f"Loading preview images {index}/{total}")
        try:
            with Image.open(path) as img:
                images.append(img.convert("RGB"))
        except Exception:
            logger.exception("Failed to open preview image: %s", path)
        if progress_callback:
            progress_callback(index, total, f"Loading preview images {index}/{total}")
    return images


def _load_image_dir_preview(
    node_id,
    ckpt_name_str: str,
    search_directory: str | None = None,
    tab_id: str | None = None,
    send_progress: bool = True,
    max_preview_images: int = IMAGE_DIR_DEFAULT_MAX_IMAGES,
) -> tuple[Image.Image | None, dict]:
    relpath = _normalize_relpath(ckpt_name_str)
    max_preview_images = _clamp_image_dir_max_images(max_preview_images)

    def progress(value: int, total: int, message: str, root: str = ""):
        if send_progress:
            _send_image_dir_progress(node_id, relpath, message, value=value, total=total, tab_id=tab_id, root=root)

    progress(0, max_preview_images, "Searching preview images...")
    paths, root, mode = _find_preview_images(
        relpath,
        search_directory,
        max_images=max_preview_images,
        progress_callback=lambda v, t, m: progress(v, t, m, root=""),
    )
    progress(len(paths), max_preview_images, f"Found preview images {len(paths)}/{max_preview_images}", root=root)

    pil_images = _load_pil_images(
        paths,
        max_images=max_preview_images,
        progress_callback=lambda v, t, m: progress(v, t, m, root=root),
    ) if paths else []
    if pil_images:
        sheet, meta = _build_contact_sheet(
            pil_images,
            progress_callback=lambda v, t, m: progress(v, t, m, root=root),
            max_images=max_preview_images,
            allow_upscale=False,
        )
        progress(max_preview_images, max_preview_images, "Encoding preview image...", root=root)
    else:
        sheet, meta = None, {"count": 0, "columns": 0, "rows": 0, "tile_width": 0, "tile_height": 0}

    extra = {
        "node_class": "ImageDirPreview",
        "ckpt_name_str": relpath,
        "search_directory": root,
        "search_mode": mode,
        "preview_found": bool(paths),
        "preview_count": len(paths),
        "max_preview_images": max_preview_images,
        "status": "ready" if sheet is not None else "no_preview",
        "message": "Preview ready." if sheet is not None else f"No preview images found: {relpath}",
        "progress_message": "Preview ready." if sheet is not None else f"No preview images found: {relpath}",
        "progress_value": max_preview_images,
        "progress_total": max_preview_images,
    }
    extra.update(meta)
    return sheet, extra

def _send_cycler_update(
    node_id: str | None,
    title: str,
    status_text: str,
    tab_id: str | None = None,
    ckpt_name_str: str | None = None,
    source: str | None = None,
    mode: str | None = None,
    hold_index: int | None = None,
    change_every: int | None = None,
):
    payload = {
        "node": int(node_id) if node_id is not None and str(node_id).isdigit() else None,
        "title": title,
        "status_text": status_text,
    }
    if tab_id is not None:
        payload["tab_id"] = _clean_tab_id(tab_id)
    if ckpt_name_str:
        relpath = _normalize_relpath(ckpt_name_str)
        status = _get_status(relpath)
        payload.update({
            "ckpt_name_str": relpath,
            "ckpt_name_safe": _ckpt_name_safe_from_relpath(relpath),
            "status": status,
            "status_icon": STATUS_ICON[status],
        })
    if source is not None:
        payload["source"] = source
    if mode is not None:
        payload["mode"] = mode
    if hold_index is not None:
        payload["hold_index"] = hold_index
    if change_every is not None:
        payload["change_every"] = change_every
    _send_event(CYCLER_EVENT, payload)


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
                "last_normal_ckpt_name": "",
                "last_title": "",
                "last_hold_index": 0,
                "last_change_every": 1,
                "last_mode": "increment",
                "last_all_checkpoint_hash": "",
                "shuffle_deck": [],
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
        if "shuffle_deck" not in state:
            state["shuffle_deck"] = []
        if "last_mode" not in state:
            state["last_mode"] = "increment"
        if "last_all_checkpoint_hash" not in state:
            state["last_all_checkpoint_hash"] = ""
        if "last_normal_ckpt_name" not in state:
            state["last_normal_ckpt_name"] = state.get("last_ckpt_name", "")
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


def _active_filter_values(statuses: list[str] | None) -> list[str]:
    return [s for s in (statuses or []) if s in STATUS_VALUES]


def _filter_match_count(checkpoints: list[str], statuses: list[str] | None) -> int:
    active = _active_filter_values(statuses)
    if not active:
        return len(checkpoints)
    return sum(1 for ckpt in checkpoints if _get_status(ckpt) in active)


def _matches_filter(ckpt_name: str, statuses: list[str] | None, fallback_all: bool = False) -> bool:
    active = _active_filter_values(statuses)
    if fallback_all or not active:
        return True
    return _get_status(ckpt_name) in active


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


def _build_cycler_status_text(source: str, ckpt_name: str, active_filter: list[str], fallback_all: bool, local_list_remaining: list[str], hold_index: int, change_every: int, total_matches: int, local_list_total: int | None = None, mode: str = "") -> str:
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
            if len(local_list_remaining) > 8:
                lines.append(f"+{len(local_list_remaining) - 8} more")
        if active_filter:
            lines.append(f"Filter: {_filter_label(active_filter)}")
            lines.append("Note: Local List has priority over Filter.")
    else:
        if mode == "fixed":
            lines.append("Source: Fixed")
            if active_filter:
                lines.append(f"Filter: {_filter_label(active_filter)}")
                lines.append("Note: Filter is ignored in fixed mode.")
        else:
            lines.append("Source: Normal Cycle" if not active_filter else "Source: Status Filter")
            lines.append(f"Filter: {_filter_label(active_filter)}")
            if fallback_all:
                lines.append("⚠ Filter matched 0 checkpoints. Using all checkpoints.")
            lines.append(f"Matches: {total_matches}")
        lines.append(f"Mode: {mode or 'increment'}")
        lines.append(f"Hold: {hold_index} / {change_every}")
        if local_list_remaining:
            lines.append(f"Local List Pending: {len(local_list_remaining)}")
    return "\n".join(lines)


def _build_cycler_pending_status_text(state: dict) -> str:
    all_checkpoints = _get_checkpoint_list()
    active_filter = state.get("active_filter", []) or []
    match_count = _filter_match_count(all_checkpoints, active_filter)
    fallback_all = bool(active_filter) and match_count == 0
    local_list = list(state.get("local_list", []))
    last_ckpt = state.get("last_ckpt_name", "")
    hold = int(state.get("last_hold_index") or 0)
    change_every = int(state.get("last_change_every") or 1)
    mode = state.get("last_mode", "increment")
    source = "local_list" if local_list else "cycle"
    if not last_ckpt:
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
            if len(local_list) > 8:
                lines.append(f"+{len(local_list) - 8} more")
            if active_filter:
                lines.append(f"Filter: {_filter_label(active_filter)}")
                lines.append("Note: Local List has priority over Filter.")
        else:
            if mode == "fixed":
                lines.append("Source: Fixed")
                if active_filter:
                    lines.append(f"Filter: {_filter_label(active_filter)}")
                    lines.append("Note: Filter is ignored in fixed mode.")
            else:
                lines.append("Source: Normal Cycle" if not active_filter else "Source: Status Filter")
                lines.append(f"Filter: {_filter_label(active_filter)}")
                if fallback_all:
                    lines.append("⚠ Filter matched 0 checkpoints. Using all checkpoints.")
                lines.append(f"Matches: {match_count}")
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
        match_count,
        len(local_list),
        mode,
    )


def _send_cycler_state_update(node_id: str, state: dict, tab_id: str | None = None):
    _send_cycler_update(node_id, "", _build_cycler_pending_status_text(state), tab_id=tab_id)


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

    RETURN_TYPES = (_get_checkpoint_list() if _get_checkpoint_list() else [""], "STRING", "STRING")
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
                "mode": (["fixed", "increment", "randomize", "shuffle_once"], {"default": "increment"}),
                "change_every": ("INT", {"default": 1, "min": 1, "max": 999999}),
            },
            "optional": {
                "hps_tab_id": ("STRING", {"default": "", "hidden": True}),
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

    def cycle(self, start_checkpoint, mode, change_every, hps_tab_id="", unique_id=None):
        node_id = str(unique_id) if unique_id is not None else "__default__"
        tab_id = _clean_tab_id(hps_tab_id)
        node_key = _state_key(tab_id, node_id)
        state = _get_cycler_state(node_key)
        all_checkpoints = _get_checkpoint_list()
        if not all_checkpoints:
            return ("", "", "checkpoint")

        mode = mode if mode in ("fixed", "increment", "randomize", "shuffle_once") else "increment"
        change_every = max(1, int(change_every or 1))
        active_filter = _active_filter_values(state.get("active_filter", []) or [])
        match_count = _filter_match_count(all_checkpoints, active_filter)
        fallback_all = bool(active_filter) and match_count == 0
        all_set = set(all_checkpoints)

        all_hash = _checkpoint_hash(all_checkpoints)
        if state.get("last_all_checkpoint_hash") != all_hash:
            state["last_all_checkpoint_hash"] = all_hash
            state["current_index"] = max(0, min(int(state.get("current_index", 0)), len(all_checkpoints) - 1))
            state["shuffle_deck"] = [ckpt for ckpt in state.get("shuffle_deck", []) if ckpt in all_set]
            if state.get("last_normal_ckpt_name") not in all_set:
                state["last_normal_ckpt_name"] = ""
                state["repeat_count"] = 0

        # Local List is an isolated manual lane:
        # one entry per execution, no filter, no change_every, no normal index/deck progress.
        local_list = list(state.get("local_list", [])) if state.get("use_local_list", True) else []
        selected_from_local = None
        skipped_local = 0
        while local_list:
            candidate = _normalize_relpath(local_list.pop(0))
            if candidate in all_set:
                selected_from_local = candidate
                break
            skipped_local += 1
        if selected_from_local:
            state["local_list"] = local_list
            state["override_queue"] = local_list
            ckpt_name = selected_from_local
            hold_index = 1
            local_total = len(local_list) + 1
            title = _build_cycler_title("local_list", ckpt_name, hold_index, 1, active_filter, False, local_total)
            status_text = _build_cycler_status_text("local_list", ckpt_name, active_filter, False, local_list, hold_index, 1, match_count, local_total, mode)
            if skipped_local:
                status_text += f"\nSkipped missing Local List item(s): {skipped_local}"
            state["last_ckpt_name"] = ckpt_name
            state["last_title"] = title
            state["last_hold_index"] = hold_index
            state["last_change_every"] = change_every
            state["last_mode"] = mode
            _send_cycler_update(
                node_id,
                title,
                status_text,
                tab_id=tab_id,
                ckpt_name_str=ckpt_name,
                source="local_list",
                mode=mode,
                hold_index=hold_index,
                change_every=1,
            )
            return (ckpt_name, ckpt_name, _ckpt_name_safe_from_relpath(ckpt_name))
        elif skipped_local:
            state["local_list"] = []
            state["override_queue"] = []

        def is_match(ckpt: str) -> bool:
            return _matches_filter(ckpt, active_filter, fallback_all)

        def find_next_increment(start_idx: int) -> tuple[str, int]:
            start_idx = max(0, min(int(start_idx), len(all_checkpoints) - 1))
            for offset in range(len(all_checkpoints)):
                idx = (start_idx + offset) % len(all_checkpoints)
                ckpt = all_checkpoints[idx]
                if is_match(ckpt):
                    return ckpt, idx
            return all_checkpoints[start_idx], start_idx

        def filtered_candidates() -> list[str]:
            if fallback_all or not active_filter:
                return all_checkpoints
            return [ckpt for ckpt in all_checkpoints if _get_status(ckpt) in active_filter]

        def draw_from_shuffle_deck() -> str:
            deck = [ckpt for ckpt in state.get("shuffle_deck", []) if ckpt in all_set]
            while True:
                if not deck:
                    deck = list(all_checkpoints)
                    random.shuffle(deck)
                candidate = deck.pop(0)
                # In shuffle_once, skipped non-matching cards are consumed too.
                if is_match(candidate):
                    state["shuffle_deck"] = deck
                    return candidate

        last_ckpt = state.get("last_normal_ckpt_name", "")
        repeat_count = int(state.get("repeat_count", 0))
        can_hold_last = (
            repeat_count > 0
            and repeat_count < change_every
            and last_ckpt in all_set
            and (mode == "fixed" or is_match(last_ckpt))
        )

        new_selection = False
        if can_hold_last:
            ckpt_name = last_ckpt
            try:
                selected_index = all_checkpoints.index(ckpt_name)
            except ValueError:
                selected_index = 0
        else:
            new_selection = True
            if mode == "fixed":
                requested = _normalize_relpath(start_checkpoint)
                ckpt_name = requested if requested in all_set else all_checkpoints[0]
                selected_index = all_checkpoints.index(ckpt_name)
            elif mode == "randomize":
                candidates = filtered_candidates()
                ckpt_name = random.choice(candidates if candidates else all_checkpoints)
                selected_index = all_checkpoints.index(ckpt_name)
            elif mode == "shuffle_once":
                ckpt_name = draw_from_shuffle_deck()
                selected_index = all_checkpoints.index(ckpt_name)
            else:  # increment
                ckpt_name, selected_index = find_next_increment(int(state.get("current_index", 0)))

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

        source = "cycle"
        title = _build_cycler_title(source, ckpt_name, hold_index, change_every, active_filter, fallback_all and mode != "fixed", 0)
        status_text = _build_cycler_status_text(source, ckpt_name, active_filter, fallback_all and mode != "fixed", [], hold_index, change_every, match_count, 0, mode)
        if mode == "shuffle_once":
            status_text += f"\nShuffle Deck Remaining: {len(state.get('shuffle_deck', []))}"
        state["last_ckpt_name"] = ckpt_name
        state["last_normal_ckpt_name"] = ckpt_name
        state["last_title"] = title
        state["last_hold_index"] = hold_index
        state["last_change_every"] = change_every
        state["last_mode"] = mode
        _send_cycler_update(
            node_id,
            title,
            status_text,
            tab_id=tab_id,
            ckpt_name_str=ckpt_name,
            source=source,
            mode=mode,
            hold_index=hold_index,
            change_every=change_every,
        )
        return (ckpt_name, ckpt_name, _ckpt_name_safe_from_relpath(ckpt_name))


class CheckpointStatusTagger:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "ckpt_name_str": ("STRING", {"forceInput": True}),
            },
            "optional": {
                "hps_tab_id": ("STRING", {"default": "", "hidden": True}),
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
    def IS_CHANGED(cls, ckpt_name_str, hps_tab_id="", unique_id=None):
        return float("nan")

    def tag(self, ckpt_name_str, hps_tab_id="", unique_id=None):
        relpath = _normalize_relpath(ckpt_name_str)
        status = _get_status(relpath)
        title = f"Tagger : {STATUS_ICON[status]} {relpath}" if status != "none" else f"Tagger : {relpath}"
        _send_event(TAGGER_EVENT, {
            "node": int(unique_id) if unique_id is not None else None,
            "tab_id": _clean_tab_id(hps_tab_id),
            "node_class": "CheckpointStatusTagger",
            "ckpt_name_str": relpath,
            "status": status,
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
            _send_preview(unique_id, "Ephemeral Preview", sheet, meta, tab_id=hps_tab_id)
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
                "max_preview_images": ("INT", {"default": IMAGE_DIR_DEFAULT_MAX_IMAGES, "min": 1, "max": IMAGE_DIR_MAX_IMAGES}),
                "hps_tab_id": ("STRING", {"default": "", "hidden": True}),
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
    def IS_CHANGED(cls, ckpt_name_str, search_directory=None, max_preview_images=IMAGE_DIR_DEFAULT_MAX_IMAGES, hps_tab_id="", unique_id=None):
        return float("nan")

    def preview(self, ckpt_name_str, search_directory=None, max_preview_images=IMAGE_DIR_DEFAULT_MAX_IMAGES, hps_tab_id="", unique_id=None):
        relpath = _normalize_relpath(ckpt_name_str)
        sheet, extra = _load_image_dir_preview(unique_id, relpath, search_directory, tab_id=hps_tab_id, send_progress=True, max_preview_images=max_preview_images)
        _send_preview(unique_id, _image_dir_title(relpath), sheet, extra, tab_id=hps_tab_id)
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
        "scope": "global",
        "ok": True,
        "ckpt_name_str": relpath,
        "status": _get_status(relpath),
        "status_icon": STATUS_ICON[_get_status(relpath)],
        "summary": _delete_status_summary(),
    }
    _send_event(STATUS_CHANGED_EVENT, payload)
    return web.json_response(payload)


@routes.post(f"/{EXTENSION_PREFIX}/review/sync_checkpoint")
async def review_sync_checkpoint(request):
    data = await request.json()
    relpath = _normalize_relpath(data.get("ckpt_name_str", ""))
    if not _is_valid_checkpoint_relpath(relpath):
        return web.json_response({"ok": False, "error": "Invalid checkpoint path."}, status=400)

    tab_id = _clean_tab_id(data.get("tab_id", ""))
    tagger_ids = [str(x) for x in data.get("tagger_node_ids", []) if str(x).isdigit()]
    preview_targets = []
    raw_preview_targets = data.get("preview_targets")
    if isinstance(raw_preview_targets, list):
        for item in raw_preview_targets:
            if isinstance(item, dict):
                node_id = str(item.get("node_id", ""))
                if node_id.isdigit():
                    preview_targets.append({
                        "node_id": node_id,
                        "search_directory": str(item.get("search_directory") or ""),
                        "max_preview_images": _clamp_image_dir_max_images(item.get("max_preview_images", IMAGE_DIR_DEFAULT_MAX_IMAGES)),
                    })
    if not preview_targets:
        preview_targets = [
            {"node_id": str(x), "search_directory": "", "max_preview_images": IMAGE_DIR_DEFAULT_MAX_IMAGES}
            for x in data.get("preview_node_ids", [])
            if str(x).isdigit()
        ]
    status = _get_status(relpath)
    title = f"Tagger : {STATUS_ICON[status]} {relpath}" if status != "none" else f"Tagger : {relpath}"
    for node_id in tagger_ids:
        _send_event(TAGGER_EVENT, {
            "node": int(node_id),
            "tab_id": tab_id,
            "node_class": "CheckpointStatusTagger",
            "ckpt_name_str": relpath,
            "status": status,
            "title": title,
        })

    preview_count = 0
    for target in preview_targets:
        node_id = target["node_id"]
        search_directory = target.get("search_directory") or None
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
        _send_preview(node_id, _image_dir_title(relpath), sheet, extra, tab_id=tab_id)
        preview_count += 1

    return web.json_response({
        "ok": True,
        "ckpt_name_str": relpath,
        "taggers": len(tagger_ids),
        "previews": preview_count,
        "status": status,
    })


@routes.post(f"/{EXTENSION_PREFIX}/cycler/set_flags")
async def cycler_set_flags(request):
    data = await request.json()
    node_id = str(data.get("node_id", ""))
    tab_id = _clean_tab_id(data.get("tab_id", ""))
    state = _get_cycler_state(_state_key(tab_id, node_id))
    if "use_local_list" in data:
        state["use_local_list"] = bool(data.get("use_local_list"))
        state["accept_queue"] = state["use_local_list"]
    _send_cycler_state_update(node_id, state, tab_id=tab_id)
    return web.json_response({"ok": True, "use_local_list": state["use_local_list"]})


@routes.post(f"/{EXTENSION_PREFIX}/cycler/set_filter")
async def cycler_set_filter(request):
    data = await request.json()
    node_id = str(data.get("node_id", ""))
    tab_id = _clean_tab_id(data.get("tab_id", ""))
    statuses = [s for s in data.get("statuses", []) if s in STATUS_VALUES]
    state = _get_cycler_state(_state_key(tab_id, node_id))
    state["active_filter"] = statuses.copy()
    _send_cycler_state_update(node_id, state, tab_id=tab_id)
    logger.info("[CheckpointHandpickerSuite] Updated cycler filter for tab %s node %s: %s", tab_id, node_id, statuses or ["All"])
    return web.json_response({"ok": True, "node_id": node_id, "statuses": statuses})


@routes.post(f"/{EXTENSION_PREFIX}/cycler/local_list_append")
async def cycler_local_list_append(request):
    data = await request.json()
    relpath = _normalize_relpath(data.get("ckpt_name_str", ""))
    if not _is_valid_checkpoint_relpath(relpath):
        return web.json_response({"ok": False, "error": "Invalid checkpoint path."}, status=400)
    tab_id = _clean_tab_id(data.get("tab_id", ""))
    target_node_ids = [str(x) for x in data.get("target_node_ids", []) if str(x).isdigit()]
    updated = 0
    for node_id in target_node_ids:
        state = _get_cycler_state(_state_key(tab_id, node_id))
        if state.get("use_local_list", True):
            state.setdefault("local_list", []).append(relpath)
            state["override_queue"] = state["local_list"]
            updated += 1
            _send_cycler_state_update(node_id, state, tab_id=tab_id)
    logger.info("[CheckpointHandpickerSuite] Pushed checkpoint to %s Local List(s) in tab %s: %s", updated, tab_id, relpath)
    return web.json_response({"ok": True, "updated": updated})


@routes.post(f"/{EXTENSION_PREFIX}/cycler/clear_local_list")
async def cycler_clear_local_list(request):
    data = await request.json()
    node_id = str(data.get("node_id", ""))
    tab_id = _clean_tab_id(data.get("tab_id", ""))
    state = _get_cycler_state(_state_key(tab_id, node_id))
    cleared = len(state.get("local_list", []))
    state["local_list"] = []
    state["override_queue"] = []
    _send_cycler_state_update(node_id, state, tab_id=tab_id)
    logger.info("[CheckpointHandpickerSuite] Cleared Local List for tab %s node %s: %s item(s)", tab_id, node_id, cleared)
    return web.json_response({"ok": True, "cleared": cleared})


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
