"""เนื้อร้อง — จัดเวลาเนื้อที่ผู้ใช้วาง (source='user') หรือถอดเองด้วย ASR (source='asr')

สัญญากับ runner (docs/09-GPU-TRANSCRIBE.md §1.3 + §4 'lyrics'):
    transcribe_lyrics(vocals, sr, lyrics_text, language, ctx) -> dict | None
    prefetch(models_dir) -> None

- vocals: numpy float32 mono [-1, 1] (vocal stem หลังแยกเสียง), sr ใดก็ได้ (resample ภายใน)
- ctx: มี device, dtype, models_dir, progress(frac, label), warn(msg), cancelled()
- คืน object "lyrics" ของ TranscriptionResult v1:
    {source, language, text, lines: [{t0, t1, text, syllables: [{t0, t1, text}], section?}]}
  (section = hint ท่อนจาก tag ที่ผู้ใช้ใส่ — field เสริม optional)
- คืน None เมื่อไม่มีเสียงร้อง/ล้มทั้งหมด (เรียก ctx.warn ก่อนเสมอ) — ปล่อยโมเดลจาก GPU ก่อนคืนทุกทาง
"""
from __future__ import annotations

import gc
import os
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import thai_text
from .align import (
    FRAME_SEC,
    SR,
    AlignParams,
    CtcModel,
    align_lines,
    frame_db,
    plan_chunks,
    to_mono_16k,
    voiced_mask,
)

MAX_LYRICS_CHARS = 20000  # partner API จำกัด 5000 อยู่แล้ว — กันกรณีเรียก node ตรง
MIN_VOICED_SEC = 1.0


@dataclass(frozen=True)
class ModelSpec:
    repo: str
    revision: str  # pin commit — กัน repo ต้นทางเปลี่ยนน้ำหนัก/ไฟล์ใต้เท้าเรา
    allow: tuple[str, ...] | None
    license: str


MODELS: dict[str, ModelSpec] = {
    # CTC จัดเวลาไทย — มีแต่ pytorch_model.bin (transformers โหลดแบบ weights_only) — ไม่โหลด
    # training_args.bin/rng_state.pth/scheduler.pt ที่เป็น pickle ไม่จำเป็น
    "align_th": ModelSpec(
        "airesearch/wav2vec2-large-xlsr-53-th",
        "3155938c549b23eee16b1d4b55dcb161b7fe4bcf",
        ("config.json", "preprocessor_config.json", "vocab.json", "tokenizer_config.json",
         "special_tokens_map.json", "pytorch_model.bin"),
        "CC-BY-SA-4.0",
    ),
    "align_en": ModelSpec(
        "facebook/wav2vec2-base-960h",
        "22aad52d435eb6dbaf354bdad9b0da84ce7d6156",
        ("config.json", "preprocessor_config.json", "vocab.json", "tokenizer_config.json",
         "special_tokens_map.json", "model.safetensors"),
        "Apache-2.0",
    ),
    "asr": ModelSpec("Qwen/Qwen3-ASR-1.7B-hf", "bcd2b5b7f32b480ab5790554cfa8347f246a14f3", None, "Apache-2.0"),
    # ตัวเล็กสำหรับทดสอบบน CPU (AQUACHORD_ASR_MODEL=0.6b)
    "asr_small": ModelSpec("Qwen/Qwen3-ASR-0.6B-hf", "7f1569a48a89f3e3f4dc3a5c9d28bddd903bc76c", None, "Apache-2.0"),
}


def _asr_key() -> str:
    return "asr_small" if os.environ.get("AQUACHORD_ASR_MODEL", "").strip().lower() in ("0.6b", "small") else "asr"


def model_ids() -> dict[str, str]:
    """ชื่อโมเดลสำหรับ engine.models ของ TranscriptionResult"""
    return {"asr": MODELS[_asr_key()].repo, "align": MODELS["align_th"].repo}


# ================================================================ ดาวน์โหลดโมเดล

_locks: dict[str, threading.Lock] = {k: threading.Lock() for k in MODELS}
_paths: dict[str, Path] = {}


def _cache_dir(models_dir) -> Path:
    return Path(models_dir) / "hf"


def model_path(key: str, models_dir) -> Path:
    """โฟลเดอร์ snapshot ของโมเดล — โหลดครั้งแรกถ้ายังไม่มี (รอ prefetch ที่กำลังโหลดอยู่ผ่าน lock เดียวกัน)"""
    spec = MODELS[key]
    cache = _cache_dir(models_dir)
    with _locks[key]:
        p = _paths.get(key)
        if p is not None and p.is_dir():
            return p
        from huggingface_hub import snapshot_download

        kw = dict(repo_id=spec.repo, revision=spec.revision, cache_dir=str(cache))
        if spec.allow:
            kw["allow_patterns"] = list(spec.allow)
        try:
            p = Path(snapshot_download(local_files_only=True, **kw))
        except Exception:  # noqa: BLE001 — ยังไม่มีในเครื่อง -> โหลดจริง
            cache.mkdir(parents=True, exist_ok=True)
            p = Path(snapshot_download(**kw))
        _paths[key] = p
        return p


def prefetch(models_dir) -> None:
    """โหลดน้ำหนักทั้งหมดของเนื้อร้องล่วงหน้า (เรียกจาก background thread ตอน import node)
    เรียกซ้ำ/พร้อมกันได้ — ตัวที่มีแล้วคืนทันที, ตัวที่กำลังโหลดอยู่จะรอ lock เดียวกัน"""
    for key in ("align_th", _asr_key(), "align_en"):
        try:
            model_path(key, models_dir)
        except Exception:  # noqa: BLE001 — prefetch ห้ามทำให้ ComfyUI ล้ม; ตอนใช้งานจริงจะลองใหม่และ warn
            pass


# ================================================================ ctx helpers


class _Ctx:
    """ห่อ ctx แบบ duck-typed — callback ที่พังต้องไม่ทำให้งานเนื้อร้องล้ม"""

    def __init__(self, ctx):
        import torch

        self._c = ctx
        self.device = str(getattr(ctx, "device", "cpu") or "cpu")
        self.dtype = getattr(ctx, "dtype", None) or torch.float32
        if self.device == "cpu":
            self.dtype = torch.float32
        self.models_dir = Path(getattr(ctx, "models_dir", "models/aquachord"))
        self.warnings: list[str] = []

    def progress(self, frac: float, label: str) -> None:
        f = getattr(self._c, "progress", None)
        if callable(f):
            try:
                f(float(min(1.0, max(0.0, frac))), label)
            except Exception:  # noqa: BLE001
                pass

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)
        f = getattr(self._c, "warn", None)
        if callable(f):
            try:
                f(msg)
            except Exception:  # noqa: BLE001
                pass

    def cancelled(self) -> bool:
        f = getattr(self._c, "cancelled", None)
        if callable(f):
            try:
                return bool(f())
            except Exception:  # noqa: BLE001
                return False
        return False


def _free() -> None:
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass


# ================================================================ งานหลัก


def transcribe_lyrics(vocals, sr, lyrics_text, language, ctx) -> dict | None:
    c = _Ctx(ctx)
    try:
        return _run(vocals, sr, lyrics_text, language, c)
    except Exception as e:  # noqa: BLE001 — ห้ามล้มทั้งงาน: ใส่ warning แล้วไปต่อ (spec §1.1)
        c.warn(f"lyrics: failed ({type(e).__name__})")
        return None
    finally:
        _free()


def _run(vocals, sr, lyrics_text, language, c: _Ctx) -> dict | None:
    lang = language if language in ("th", "en", "auto") else "th"
    c.progress(0.0, "เตรียมเสียงร้อง")
    try:
        wav = to_mono_16k(vocals, sr)
    except (ValueError, TypeError):
        c.warn("lyrics: unreadable vocal stem")
        return None
    if len(wav) < SR:
        c.warn("lyrics: vocal stem too short")
        return None
    db = frame_db(wav)
    voiced = voiced_mask(db)
    if float(voiced.sum()) * FRAME_SEC < MIN_VOICED_SEC:
        c.warn("lyrics: no vocals detected")
        return None
    chunks = plan_chunks(voiced, db)

    user = lyrics_text if isinstance(lyrics_text, str) else ""
    user = user.strip()
    if len(user) > MAX_LYRICS_CHARS:
        user = user[:MAX_LYRICS_CHARS]
        c.warn("lyrics: pasted lyrics truncated")
    doc = None
    if user:
        text_lang = lang if lang != "auto" else (thai_text.script_of(user) or "th")
        doc = thai_text.parse_lyrics(user, text_lang)
        if not doc.lines:
            c.warn("lyrics: pasted lyrics had no usable lines, using ASR")
            doc = None

    if doc is not None:
        return _align_user(wav, voiced, chunks, doc, lang, c)
    return _asr_then_align(wav, voiced, chunks, lang, c)


def _pick_aligner(lang: str, text: str) -> str | None:
    if lang == "en":
        return "align_en"
    if lang == "th":
        return "align_th"
    s = thai_text.script_of(text)
    return {"th": "align_th", "en": "align_en"}.get(s)


def _emissions(key: str, wav, chunks, c: _Ctx, p0: float, p1: float):
    path = model_path(key, c.models_dir)
    if c.cancelled():
        return None, None
    c.progress(p0, "โหลดโมเดลจัดเวลาเนื้อ")
    ctc = CtcModel(path, c.device, c.dtype)
    try:
        lp = ctc.emissions(
            wav, chunks,
            progress=lambda f: c.progress(p0 + (p1 - p0) * f, "จัดเวลาเนื้อร้อง"),
            cancelled=c.cancelled,
        )
        return lp, ctc.vocab
    finally:
        ctc.close()
        del ctc
        _free()


def _align_user(wav, voiced, chunks, doc: thai_text.Lyrics, lang: str, c: _Ctx) -> dict | None:
    key = _pick_aligner(lang, doc.text)
    out_lang = "en" if key == "align_en" else "th"
    base = {"source": "user", "language": out_lang, "text": doc.text, "lines": []}
    if key is None:
        c.warn("lyrics: no aligner for this script, lyrics kept without timing")
        return base
    lp, vocab = _emissions(key, wav, chunks, c, 0.05, 0.85)
    if lp is None:
        c.warn("lyrics: cancelled")
        return None
    c.progress(0.86, "จับคู่เนื้อกับเสียง")
    res = align_lines(lp, doc.lines, vocab, voiced, AlignParams(allow_skip=True), cancelled=c.cancelled)
    lines = [r for r in res if r is not None]
    skipped = sum(1 for r in res if r is None)
    if not lines:
        c.warn("lyrics: could not align pasted lyrics to the vocals")
    elif skipped:
        c.warn(f"lyrics: {skipped} of {len(res)} lines not found in the audio")
    base["lines"] = _sanitize(lines, len(wav) / SR)
    c.progress(1.0, "เนื้อร้องเสร็จ")
    return base


def _asr_then_align(wav, voiced, chunks, lang: str, c: _Ctx) -> dict | None:
    from .asr import QwenAsr

    key = _asr_key()
    path = model_path(key, c.models_dir)
    if c.cancelled():
        c.warn("lyrics: cancelled")
        return None
    c.progress(0.03, "โหลดโมเดลถอดเนื้อ")
    asr = QwenAsr(path, c.device, c.dtype)
    try:
        segs = asr.transcribe(
            wav, chunks, voiced, lang,
            progress=lambda f: c.progress(0.05 + 0.5 * f, "ถอดเนื้อร้อง"),
            cancelled=c.cancelled,
        )
    finally:
        asr.close()
        del asr
        _free()
    if segs is None:
        c.warn("lyrics: cancelled")
        return None
    dropped = [s for s in segs if s.dropped and s.dropped != "silent"]
    segs = [s for s in segs if s.text]
    if dropped:
        c.warn(f"lyrics: dropped {len(dropped)} ASR segments as noise/hallucination")
    if not segs:
        c.warn("lyrics: ASR found no lyrics")
        return None

    codes = [s.language for s in segs if s.language]
    out_lang = max(set(codes), key=codes.count) if codes else (lang if lang != "auto" else "th")
    all_text = "\n".join(s.text for s in segs)
    key_al = _pick_aligner(lang if lang != "auto" else out_lang if out_lang in ("th", "en") else "auto", all_text)

    per_seg: list[list[thai_text.LyricLine]] = []
    for s in segs:
        text_lang = out_lang if out_lang in ("th", "en") else "th"
        lines = [thai_text.make_line(0, t, text_lang) for t in thai_text.split_long_text(s.text)]
        per_seg.append([ln for ln in lines if ln is not None])

    lines_out: list[dict] = []
    lp = vocab = None
    if key_al is not None:
        lp, vocab = _emissions(key_al, wav, chunks, c, 0.58, 0.9)
        if lp is None:
            c.warn("lyrics: cancelled")
            return None
    else:
        c.warn("lyrics: timing is approximate for this language")
    c.progress(0.92, "จับคู่เนื้อกับเสียง")
    T = len(voiced)
    for s, lines in zip(segs, per_seg):
        if not lines:
            continue
        got = None
        if lp is not None:
            w0, w1 = max(0, s.f0 - 10), min(T, s.f1 + 10)
            res = align_lines(lp[w0:w1], lines, vocab, voiced[w0:w1], AlignParams(allow_skip=False), frame_offset=w0)
            if all(r is not None for r in res):
                got = res
        if got is None:  # จัดเวลาไม่ได้ -> กระจายเวลาตามช่วงที่มีเสียงของก้อน (หยาบ)
            got = _coarse_lines(lines, s.f0, s.f1, voiced)
        for d in got:
            lines_out.extend(_split_at_pauses(d))
    lines_out = _sanitize(lines_out, len(wav) / SR)
    if not lines_out:
        c.warn("lyrics: ASR found no lyrics")
        return None
    c.progress(1.0, "เนื้อร้องเสร็จ")
    return {
        "source": "asr",
        "language": out_lang,
        "text": "\n".join(d["text"] for d in lines_out),
        "lines": lines_out,
    }


# ================================================================ หลังจัดเวลา


def _join_syllables(syls: list[dict]) -> str:
    out = ""
    for s in syls:
        t = s["text"]
        if out and (t[:1].isascii() and t[:1].isalnum() or out[-1:].isascii() and out[-1:].isalnum()):
            out += " "
        out += t
    return out


def _split_at_pauses(d: dict, max_chars: int = 36, min_chars: int = 8) -> list[dict]:
    """บรรทัด ASR ที่ยาวเกิน -> ตัดที่ช่วงหยุดหายใจที่ยาวที่สุด (ไม่ให้ชิ้นสั้นกว่า min_chars)"""
    syls = d["syllables"]
    text_len = sum(len(s["text"]) for s in syls)
    if text_len <= max_chars or len(syls) < 2:
        return [d]
    cum = np.cumsum([len(s["text"]) for s in syls])
    best, best_score = None, -1e9
    for i in range(len(syls) - 1):
        left, right = int(cum[i]), int(text_len - cum[i])
        if left < min_chars or right < min_chars:
            continue
        gap = syls[i + 1]["t0"] - syls[i]["t1"]
        # ช่วงเงียบยาวสำคัญที่สุด; เท่ากันให้ตัดใกล้กลาง
        score = gap * 10.0 + syls[i + 1]["t0"] - syls[i]["t0"] - abs(left - right) / max(1, text_len)
        if score > best_score:
            best, best_score = i, score
    if best is None:
        return [d]
    a, b = syls[: best + 1], syls[best + 1 :]
    parts = []
    for part in (a, b):
        nd = {"t0": part[0]["t0"], "t1": part[-1]["t1"], "text": _join_syllables(part), "syllables": part}
        parts.extend(_split_at_pauses(nd, max_chars, min_chars))
    return parts


def _coarse_lines(lines: list[thai_text.LyricLine], f0: int, f1: int, voiced: np.ndarray) -> list[dict]:
    """ไม่มีตัวจัดเวลา -> กระจายพยางค์เท่า ๆ กันบนเฟรมที่มีเสียงของก้อน"""
    fr = np.flatnonzero(voiced[f0:f1]) + f0
    if fr.size == 0:
        fr = np.arange(f0, max(f1, f0 + 1))
    units = [(li, s) for li, ln in enumerate(lines) for s in ln.syllables]
    n = max(1, len(units))
    out: list[dict] = []
    for li, ln in enumerate(lines):
        syls = []
        for k, (lj, s) in enumerate(units):
            if lj != li:
                continue
            a = int(fr[min(fr.size - 1, k * fr.size // n)])
            b = int(fr[min(fr.size - 1, (k + 1) * fr.size // n - 1)]) + 1
            syls.append({"t0": round(a * FRAME_SEC, 3), "t1": round(max(b, a + 1) * FRAME_SEC, 3), "text": s.text})
        if syls:
            out.append({"t0": syls[0]["t0"], "t1": syls[-1]["t1"], "text": ln.text, "syllables": syls})
    return out


def _sanitize(lines: list[dict], dur: float) -> list[dict]:
    """บังคับกติกา §4: วินาที 3 ตำแหน่ง, เรียงตามเวลา, อยู่ในความยาวเสียง, t1 > t0"""
    dur = round(max(0.0, float(dur)), 3)
    flat: list[tuple[int, dict]] = []  # (index บรรทัด, พยางค์) เรียงตามเวลาทั้งเพลง
    src = sorted((d for d in lines if d.get("syllables")), key=lambda x: float(x["syllables"][0]["t0"]))
    for li, d in enumerate(src):
        for s in d["syllables"]:
            flat.append((li, {"t0": float(s["t0"]), "t1": float(s["t1"]), "text": str(s["text"])}))
    # เวลาเริ่มไม่ถอยหลัง + ไม่ซ้อนกับพยางค์ถัดไป + อยู่ใน [0, dur]
    prev_t0 = 0.0
    for _, s in flat:
        s["t0"] = min(max(s["t0"], prev_t0, 0.0), dur)
        prev_t0 = s["t0"]
    for k, (_, s) in enumerate(flat):
        nxt = flat[k + 1][1]["t0"] if k + 1 < len(flat) else dur
        s["t1"] = min(max(s["t1"], s["t0"]), nxt, dur)
    out: list[dict] = []
    for li, d in enumerate(src):
        syls = []
        for lj, s in flat:
            if lj != li:
                continue
            t0, t1 = round(s["t0"], 3), round(s["t1"], 3)
            if t1 <= t0:  # พยางค์ที่ถูกบีบจนไม่มีเวลา — ให้ 1 ms แทนการทิ้ง (ข้อความต้องครบ)
                if t0 >= dur:
                    t0 = round(max(0.0, dur - 0.001), 3)
                t1 = round(min(dur, t0 + 0.001), 3)
            syls.append({"t0": t0, "t1": t1, "text": s["text"]})
        if not syls:
            continue
        nd = {"t0": syls[0]["t0"], "t1": syls[-1]["t1"], "text": d["text"], "syllables": syls}
        if d.get("section"):
            nd["section"] = d["section"]
        out.append(nd)
    return out
