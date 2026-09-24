"""อุปกรณ์/ชนิดตัวเลข, ที่เก็บโมเดล, ดาวน์โหลดน้ำหนัก, prefetch เบื้องหลัง และคืน VRAM

โมดูลนี้ต้อง import เบา (ไม่แตะ torch ตอน import) เพราะ __init__.py ของ pack เรียก start_prefetch()
ตอน ComfyUI โหลดรายการโหนด
"""
from __future__ import annotations

import gc
import hashlib
import logging
import os
import threading
import time
import urllib.request
from pathlib import Path

log = logging.getLogger("aquachord")

# ---------- รายการน้ำหนักที่ pin ไว้ (กัน supply-chain: revision เป็น commit sha / ไฟล์มี sha256) ----------

# Mel-Band RoFormer vocals (Kim) — HF model card: license MIT
KIM_REPO = "KimberleyJSN/melbandroformer"
KIM_REVISION = "ac9b0614ab3cd7f77219e18ba494dfd93956c348"
KIM_FILE = "MelBandRoformer.ckpt"
KIM_SHA256 = "87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e"  # = LFS etag (hf_hub_download ตรวจให้)

# beat_this (CPJKU, MIT) — checkpoint โฮสต์ที่ cloud ของ JKU (URL เดียวกับที่แพ็กเกจ beat_this ใช้)
BEAT_THIS_URL = "https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/{name}.ckpt"
BEAT_THIS_SHA256 = {
    # sha256 ของไฟล์ที่ดาวน์โหลดจริง 2026-09-24 (81,058,141 bytes) — ไม่ตรง = ไม่ใช้ไฟล์นั้น
    "final0": "8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331",
}

_download_lock = threading.Lock()


# ---------- device / dtype ----------

def pick_device(prefer: str | None = None) -> str:
    """'cuda' ถ้ามีและไม่ได้บังคับ cpu — ใน ComfyUI ใช้ get_torch_device() ของมัน"""
    import torch
    if prefer:
        prefer = prefer.lower()
        if prefer.startswith("cuda") and not torch.cuda.is_available():
            log.warning("CUDA not available, falling back to CPU")
            return "cpu"
        return prefer
    try:
        import comfy.model_management as mm  # type: ignore
        dev = mm.get_torch_device()
        return str(dev)
    except Exception:
        pass
    return "cuda" if torch.cuda.is_available() else "cpu"


def pick_dtype(device: str):
    """CPU หรือ compute capability < 7.0 (Pascal ลงไป) → float32; ไม่งั้น bf16 ถ้ารองรับ ไม่งั้น fp16"""
    import torch
    if not str(device).startswith("cuda") or not torch.cuda.is_available():
        return torch.float32
    try:
        idx = torch.device(device).index
        major, _minor = torch.cuda.get_device_capability(idx if idx is not None else torch.cuda.current_device())
    except Exception:
        return torch.float32
    if major < 7:
        return torch.float32
    try:
        if torch.cuda.is_bf16_supported():
            return torch.bfloat16
    except Exception:
        pass
    return torch.float16


def release_gpu(*objs) -> None:
    """ทิ้งอ้างอิงแล้วคืน VRAM — เรียกหลังจบแต่ละขั้น"""
    for o in objs:
        try:
            del o
        except Exception:
            pass
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
    try:
        import comfy.model_management as mm  # type: ignore
        mm.soft_empty_cache()
    except Exception:
        pass


def free_comfy_models() -> None:
    """ใน ComfyUI: ปลดโมเดลอื่นที่ค้างใน VRAM ก่อนเริ่มงาน (worker ทำงานทีละงาน)"""
    try:
        import comfy.model_management as mm  # type: ignore
        mm.unload_all_models()
        mm.soft_empty_cache()
    except Exception:
        pass


# ---------- models dir ----------

def models_dir() -> Path:
    """ComfyUI: <models>/aquachord  ·  ไม่งั้น env AQUACHORD_MODELS_DIR  ·  ไม่งั้น ./models"""
    try:
        import folder_paths  # type: ignore
        base = Path(folder_paths.models_dir) / "aquachord"
    except Exception:
        env = os.environ.get("AQUACHORD_MODELS_DIR", "").strip()
        base = Path(env) if env else Path.cwd() / "models"
    base.mkdir(parents=True, exist_ok=True)
    return base


def hf_cache_dir(mdir: Path | None = None) -> Path:
    d = (mdir or models_dir()) / "hf"
    d.mkdir(parents=True, exist_ok=True)
    return d


def hf_file(repo_id: str, filename: str, revision: str, mdir: Path | None = None) -> Path:
    """ดาวน์โหลด/หาไฟล์เดียวจาก HF (cache ใต้ models_dir/hf) — ออฟไลน์แต่มีไฟล์แล้วก็ใช้ได้"""
    from huggingface_hub import hf_hub_download
    cache = hf_cache_dir(mdir)
    try:
        p = hf_hub_download(repo_id, filename, revision=revision, cache_dir=str(cache))
    except Exception:
        # ออฟไลน์: ลองหาไฟล์ที่ cache ไว้แล้ว
        p = hf_hub_download(repo_id, filename, revision=revision, cache_dir=str(cache), local_files_only=True)
    return Path(p)


def hf_snapshot(repo_id: str, revision: str, allow_patterns=None, mdir: Path | None = None) -> Path:
    """ดาวน์โหลดหลายไฟล์ของ repo (กรองด้วย allow_patterns) — สำหรับโมดูลอื่นที่ต้องการทั้ง snapshot"""
    from huggingface_hub import snapshot_download
    cache = hf_cache_dir(mdir)
    try:
        p = snapshot_download(repo_id, revision=revision, allow_patterns=allow_patterns, cache_dir=str(cache))
    except Exception:
        p = snapshot_download(repo_id, revision=revision, allow_patterns=allow_patterns, cache_dir=str(cache),
                              local_files_only=True)
    return Path(p)


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def url_file(url: str, dest: Path, sha256: str | None = None, timeout: float = 60.0,
             max_bytes: int = 2 << 30) -> Path:
    """ดาวน์โหลด URL คงที่ (https เท่านั้น) ลง dest แบบ atomic (tmp → rename) + ตรวจ sha256 ถ้ามี"""
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    if not url.startswith("https://"):
        raise ValueError("only https downloads are allowed")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f"{dest.name}.{os.getpid()}.{threading.get_ident()}.part")
    req = urllib.request.Request(url, headers={"User-Agent": "comfyui-aquachord/0.1"})
    h = hashlib.sha256()
    total = 0
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r, open(tmp, "wb") as f:
            while True:
                b = r.read(1 << 20)
                if not b:
                    break
                total += len(b)
                if total > max_bytes:
                    raise ValueError("download too large")
                h.update(b)
                f.write(b)
        digest = h.hexdigest()
        if sha256 and digest != sha256:
            raise ValueError(f"checksum mismatch for {dest.name}")
        if dest.exists() and dest.stat().st_size > 0:  # มีคนอื่นดาวน์โหลดเสร็จก่อน
            return dest
        os.replace(tmp, dest)
        return dest
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass


# ---------- ไฟล์น้ำหนักของ music core ----------

def kim_checkpoint(mdir: Path | None = None) -> Path:
    return hf_file(KIM_REPO, KIM_FILE, KIM_REVISION, mdir)


def beat_this_checkpoint(name: str = "final0", mdir: Path | None = None) -> Path:
    mdir = mdir or models_dir()
    dest = mdir / "beat_this" / f"beat_this-{name}.ckpt"
    with _download_lock:
        if dest.exists() and dest.stat().st_size > 0:
            return dest
        # ไม่บังคับ sha256 ถ้าไม่ได้ pin (ค่าใน dict ต้องมาจากการดาวน์โหลดจริง)
        return url_file(BEAT_THIS_URL.format(name=name), dest, sha256=BEAT_THIS_SHA256.get(name), timeout=60.0)


# ---------- prefetch เบื้องหลัง ----------

_prefetch_thread: threading.Thread | None = None
_prefetch_done = threading.Event()
_prefetch_errors: list[str] = []
_prefetch_lock = threading.Lock()


def _prefetch_job(mdir: Path) -> None:
    t0 = time.time()
    steps = [
        ("separation", lambda: kim_checkpoint(mdir)),
        ("beats", lambda: beat_this_checkpoint("final0", mdir)),
    ]
    for name, fn in steps:
        try:
            fn()
        except Exception as e:  # ไม่ให้ prefetch ทำให้อะไรล้ม — ขั้นจริงจะลองใหม่เอง
            _prefetch_errors.append(f"{name}: {type(e).__name__}")
            log.warning("aquachord prefetch %s failed: %s", name, type(e).__name__)
    try:
        from . import lyrics as _lyrics  # ไฟล์ของโมดูลเนื้อร้อง (อาจยังไม่มี)
        pf = getattr(_lyrics, "prefetch", None)
        if callable(pf):
            pf(mdir)
    except ImportError:
        pass
    except Exception as e:
        _prefetch_errors.append(f"lyrics: {type(e).__name__}")
        log.warning("aquachord prefetch lyrics failed: %s", type(e).__name__)
    log.info("aquachord prefetch finished in %.1fs", time.time() - t0)


def _run_prefetch(mdir: Path) -> None:
    try:
        _prefetch_job(mdir)
    finally:
        _prefetch_done.set()


def start_prefetch(force: bool = False) -> bool:
    """เริ่ม thread ดาวน์โหลดน้ำหนัก (ครั้งเดียวต่อ process) — ปิดด้วย env AQUACHORD_PREFETCH=0"""
    global _prefetch_thread
    if not force and os.environ.get("AQUACHORD_PREFETCH", "1").strip() == "0":
        return False
    with _prefetch_lock:
        if _prefetch_thread is not None:
            return True
        try:
            mdir = models_dir()
        except Exception as e:
            log.warning("aquachord prefetch: models dir unavailable (%s)", type(e).__name__)
            return False
        _prefetch_done.clear()
        _prefetch_thread = threading.Thread(target=_run_prefetch, args=(mdir,), name="aquachord-prefetch",
                                            daemon=True)
        _prefetch_thread.start()
        return True


def wait_prefetch(timeout: float = 900.0, cancelled=None) -> bool:
    """รอ prefetch ที่เริ่มไว้ (ถ้าไม่ได้เริ่มก็คืนทันที) — ตรวจการยกเลิกทุก 1 วินาที"""
    if _prefetch_thread is None:
        return True
    deadline = time.time() + max(0.0, timeout)
    while not _prefetch_done.is_set():
        if cancelled is not None and cancelled():
            return False
        if time.time() >= deadline:
            return False
        _prefetch_done.wait(1.0)
    return True
