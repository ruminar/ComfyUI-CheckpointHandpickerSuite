"""Disk protocol shared by CheckpointHandpickerSuite and HandpickerStudio."""

import ctypes
import json
import os
import stat
import tempfile
import time
from contextlib import contextmanager
from ctypes import wintypes
from pathlib import Path


STATUS_VALUES = {"god", "favorite", "nice", "keep", "delete", "none"}


@contextmanager
def evaluation_lock(database_path):
    database_path.parent.mkdir(parents=True, exist_ok=True)
    with database_path.with_name("checkpoint_statuses.lock").open("a+b") as lock:
        if os.name == "nt":
            import msvcrt

            def acquire():
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)

            def release():
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            def acquire():
                fcntl.lockf(lock, fcntl.LOCK_EX | fcntl.LOCK_NB, 1, 0)

            def release():
                fcntl.lockf(lock, fcntl.LOCK_UN, 1, 0)

        deadline = time.monotonic() + 2
        while True:
            try:
                acquire()
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise OSError("Could not lock the checkpoint status database.")
                time.sleep(0.025)
        try:
            yield
        finally:
            release()


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def load_database(path, *, allow_missing=False):
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"), object_pairs_hook=_unique_object)
    except FileNotFoundError:
        if allow_missing:
            return {"version": 1, "statuses": {}}
        raise
    if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("statuses"), dict):
        raise ValueError("Invalid checkpoint status database.")
    keys = set()
    for key, entry in data["statuses"].items():
        normalized = os.path.normcase(key)
        if (normalized in keys or not isinstance(entry, dict) or not isinstance(entry.get("status"), str)
                or entry["status"] not in STATUS_VALUES):
            raise ValueError(f"Invalid or duplicate checkpoint status: {key}")
        keys.add(normalized)
    return data


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def active_reservations(path):
    active = {}
    try:
        contents = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return active
    for line in contents.splitlines():
        if not line.strip():
            continue
        entry = json.loads(line, object_pairs_hook=_unique_object)
        if not isinstance(entry, dict) or not entry.get("id") or entry.get("type") not in {"reserve", "cancel"}:
            raise ValueError("Invalid checkpoint deletion reservation.")
        key = (entry.get("ckpt_name_str") or "").replace("\\", "/")
        if entry["type"] == "reserve":
            if not key:
                raise ValueError("Deletion reservation is missing a checkpoint path.")
            active[key] = entry
        elif key:
            if active.get(key, {}).get("id") == entry["id"]:
                active.pop(key, None)
        else:
            active = {relpath: record for relpath, record in active.items() if record["id"] != entry["id"]}
    return active


def append_reservation(path, entry):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as stream:
        stream.write("\n" + json.dumps(entry, ensure_ascii=False) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def busy_keys(database_path):
    folder = database_path.parent / "checkpoint_studio_disposals"
    try:
        records = list(folder.iterdir())
    except FileNotFoundError:
        return set()
    keys = set()
    for path in records:
        if path.suffix != ".json":
            continue
        record = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_unique_object)
        if (not isinstance(record, dict) or not isinstance(record.get("key"), str) or not record["key"]
                or record.get("phase") not in ("prepared", "recycled")):
            raise ValueError("Invalid Studio checkpoint disposal record.")
        keys.add(os.path.normcase(record["key"]))
    return keys


def ensure_idle(database_path, relpath):
    if os.path.normcase(relpath) in busy_keys(database_path):
        raise OSError("This checkpoint has a pending HandpickerStudio disposal.")


class _FileInformation(ctypes.Structure):
    _fields_ = [(name, wintypes.DWORD) for name in (
        "attributes", "created_low", "created_high", "access_low", "access_high", "write_low", "write_high",
        "volume", "size_high", "size_low", "links", "index_high", "index_low"
    )]


@contextmanager
def _open_windows(path, access, share):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                   wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.GetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.POINTER(_FileInformation)]
    kernel.SetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    handle = kernel.CreateFileW(str(path), access, share, None, 3, 0x00200000, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        info = _FileInformation()
        if not kernel.GetFileInformationByHandle(handle, ctypes.byref(info)):
            raise ctypes.WinError(ctypes.get_last_error())
        if info.attributes & (0x10 | 0x400):
            raise ValueError(f"Not a regular file: {path}")
        yield kernel, handle, [info.volume, info.index_high, info.index_low, info.size_high, info.size_low,
                               info.write_high, info.write_low]
    finally:
        kernel.CloseHandle(handle)


def file_identity(path):
    if os.name == "nt":
        with _open_windows(path, 0, 7) as (_, _, identity):
            return identity
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f"Not a regular file: {path}")
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns]


def remove_verified(path, expected):
    if os.name == "nt":
        with _open_windows(path, 0x10000, 1) as (kernel, handle, identity):
            if identity != expected:
                raise ValueError(f"File changed after confirmation: {path}")
            disposition = ctypes.c_ubyte(1)
            if not kernel.SetFileInformationByHandle(handle, 4, ctypes.byref(disposition), 1):
                raise ctypes.WinError(ctypes.get_last_error())
    else:
        if file_identity(path) != expected:
            raise ValueError(f"File changed after confirmation: {path}")
        path.unlink()
