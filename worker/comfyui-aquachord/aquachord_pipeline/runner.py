"""ตัวคุม pipeline: เสียง → แยกเสียงร้อง → จังหวะ → คอร์ด/คีย์ → เนื้อร้อง → ทำนอง → TranscriptionResult v1

- แต่ละขั้นอยู่ใน try/except → ใส่ warnings[] แล้วไปต่อ
- ล้มทั้งงาน (RuntimeError ข้อความอังกฤษสั้น ๆ ไม่มี path) เฉพาะ: อ่านเสียงไม่ได้ / ยาวเกินแม้ตัดแล้ว /
  สั้นเกิน / ไม่มีขั้นไหนสำเร็จเลย
- การยกเลิกจาก ComfyUI (InterruptProcessingException) ไม่ถูกกลืน — ส่งต่อให้ ComfyUI จัดการ
- ใน ComfyUI รายงานความคืบหน้าผ่าน comfy.utils.ProgressBar; ใน CLI ใช้ logging
"""
from __future__ import annotations

import logging
import re
import threading
import time

import numpy as np

from . import models
from .audio import AudioError, from_comfy, load_file, resample, to_mono
from .result import empty_result, sanitize

log = logging.getLogger("aquachord")

MODES = ("open", "sheetsage2")
LANGUAGES = ("th", "auto", "en")
ALL_STAGES = ("separate", "beats", "chords", "lyrics", "melody")
MAX_SECONDS = 600.0
MIN_SECONDS = 1.0
MAX_LYRICS_CHARS = 20000
DEFAULT_CHORD_SOURCE = "mix"  # ดูเหตุผลใน README (ผลทดสอบ accompaniment vs mix)

STAGE_WEIGHTS = {"prefetch": 1, "separate": 30, "sheetsage2": 25, "beats": 5, "chords": 12, "key": 2,
                 "lyrics": 30, "melody": 8}


class PipelineError(RuntimeError):
    """ล้มทั้งงาน — ข้อความสั้น ภาษาอังกฤษ ไม่มี path/secret"""


class Cancelled(Exception):
    """ยกเลิกจาก CLI (ใน ComfyUI ใช้ InterruptProcessingException ของมันเอง)"""


_PATH_RE = re.compile(r"([A-Za-z]:[\\/][^\s'\"]*|(?:/[^\s/'\"]+){2,}/?|https?://\S+)")


def safe_error(e: BaseException, limit: int = 120) -> str:
    """ข้อความ error ที่ใส่ warnings ได้: ตัด path/URL ออก + จำกัดความยาว"""
    msg = _PATH_RE.sub("<path>", str(e) or "").strip().replace("\n", " ")
    name = type(e).__name__
    if not msg:
        return name
    return f"{name}: {msg[:limit]}"


# ---------- options ----------

def parse_options(options) -> dict:
    """{"stages": [...], "maxSeconds": 600, "chordSource": "mix"|"accompaniment"} — key ที่ไม่รู้จักข้าม"""
    o = options if isinstance(options, dict) else {}
    stages = o.get("stages")
    if isinstance(stages, (list, tuple)):
        st = [s for s in ALL_STAGES if s in {str(x).strip().lower() for x in stages}]
    else:
        st = list(ALL_STAGES)
    try:
        ms = float(o.get("maxSeconds", MAX_SECONDS))
        if not np.isfinite(ms):
            raise ValueError
    except (TypeError, ValueError):
        ms = MAX_SECONDS
    ms = float(min(MAX_SECONDS, max(5.0, ms)))
    cs = o.get("chordSource", DEFAULT_CHORD_SOURCE)
    cs = cs if cs in ("mix", "accompaniment") else DEFAULT_CHORD_SOURCE
    return {"stages": st, "maxSeconds": ms, "chordSource": cs}


# ---------- context ----------

class PipelineContext:
    """ctx ที่ส่งให้ทุกขั้น (รวม lyrics.transcribe_lyrics) — attribute ตามสัญญา: device, dtype, models_dir,
    progress(frac, label), warn(msg), cancelled()"""

    def __init__(self, device: str, stages: list[str], in_comfy: bool = False, cancel_event=None,
                 progress_hook=None):
        self.device = device
        self.dtype = models.pick_dtype(device)
        self.models_dir = models.models_dir()
        self.warnings: list[str] = []
        self.timings: dict[str, float] = {}
        self.vram_peak_mb: dict[str, float] = {}
        self.in_comfy = in_comfy
        self._cancel_event = cancel_event or threading.Event()
        self._progress_hook = progress_hook
        self._stage = None
        self._span = (0.0, 1.0)
        self._last_log = -1.0
        weights = {s: STAGE_WEIGHTS.get(s, 5) for s in stages}
        total = float(sum(weights.values())) or 1.0
        acc = 0.0
        self._spans = {}
        for s in stages:
            w = weights[s] / total
            self._spans[s] = (acc, acc + w)
            acc += w
        self._pbar = None
        if in_comfy:
            try:
                import comfy.utils  # type: ignore
                self._pbar = comfy.utils.ProgressBar(1000)
            except Exception:
                self._pbar = None
        self._mm = None
        if in_comfy:
            try:
                import comfy.model_management as mm  # type: ignore
                self._mm = mm
            except Exception:
                self._mm = None

    # --- สัญญา ctx ---
    def warn(self, msg: str) -> None:
        msg = str(msg).strip()
        if not msg:
            return
        if self._stage and not re.match(r"^[A-Za-z0-9_-]{2,16}:", msg):
            msg = f"{self._stage}: {msg}"
        if msg not in self.warnings:
            self.warnings.append(msg[:300])
            log.warning("%s", msg)

    def progress(self, frac: float, label: str = "") -> None:
        try:
            frac = float(frac)
        except (TypeError, ValueError):
            return
        frac = min(1.0, max(0.0, frac))
        a, b = self._span
        overall = a + (b - a) * frac
        self._report(overall, label or self._stage or "")

    def cancelled(self) -> bool:
        if self._cancel_event.is_set():
            return True
        if self._mm is not None:
            try:
                return bool(self._mm.processing_interrupted())
            except Exception:
                return False
        return False

    # --- ภายใน ---
    def check_cancel(self) -> None:
        if self._mm is not None:
            self._mm.throw_exception_if_processing_interrupted()
        if self._cancel_event.is_set():
            raise Cancelled()

    @staticmethod
    def is_cancel(e: BaseException) -> bool:
        return isinstance(e, (Cancelled, KeyboardInterrupt)) or type(e).__name__ == "InterruptProcessingException"

    def _report(self, overall: float, label: str) -> None:
        if self._pbar is not None:
            try:
                self._pbar.update_absolute(int(round(overall * 1000)), 1000)
            except Exception:
                pass
        if self._progress_hook is not None:
            try:
                self._progress_hook(overall, label)
            except Exception:
                pass
        if overall - self._last_log >= 0.05 or overall >= 1.0:
            self._last_log = overall
            log.info("progress %3d%% %s", int(overall * 100), label)

    def begin(self, stage: str) -> None:
        self._stage = stage
        self._span = self._spans.get(stage, (self._span[1], self._span[1]))
        self._report(self._span[0], stage)
        if str(self.device).startswith("cuda"):
            try:
                import torch
                torch.cuda.reset_peak_memory_stats()
            except Exception:
                pass

    def end(self, stage: str, t0: float) -> None:
        self.timings[stage] = round(time.time() - t0, 3)
        if str(self.device).startswith("cuda"):
            try:
                import torch
                self.vram_peak_mb[stage] = round(torch.cuda.max_memory_allocated() / 2**20, 1)
            except Exception:
                pass
        self._report(self._span[1], stage)
        self._stage = None


class _Stage:
    """with _Stage(ctx, 'beats') as ok: ... — ล้ม = warning (ยกเว้นยกเลิก) · ok.success บอกผล"""

    def __init__(self, ctx: PipelineContext, name: str):
        self.ctx, self.name, self.success = ctx, name, False

    def __enter__(self):
        self.ctx.check_cancel()
        self.t0 = time.time()
        self.ctx.begin(self.name)
        return self

    def __exit__(self, et, e, tb):
        self.ctx.end(self.name, self.t0)
        models.release_gpu()
        if e is None:
            self.success = True
            return False
        if self.ctx.is_cancel(e):
            return False
        log.exception("stage %s failed", self.name)
        self.ctx.warnings.append(f"{self.name}: failed ({safe_error(e)})")
        return True  # กลืน error — ไปขั้นต่อไป


# ---------- pipeline ----------

def _import_lyrics():
    from . import lyrics as lyrics_mod  # ไฟล์ของโมดูลเนื้อร้อง (อาจไม่มีหรือ dependency ไม่ครบ)
    return lyrics_mod


def run(mix: np.ndarray, sr: int, mode: str = "open", language: str = "th", lyrics: str = "",
        options=None, sheetsage_encoder=None, device: str | None = None, in_comfy: bool = False,
        cancel_event=None, progress_hook=None) -> dict:
    t_all = time.time()
    warnings_pre: list[str] = []
    if mode not in MODES:
        warnings_pre.append(f"unknown mode {str(mode)[:20]!r}; used open")
        mode = "open"
    if language not in LANGUAGES:
        warnings_pre.append(f"unknown language {str(language)[:20]!r}; used th")
        language = "th"
    lyrics = lyrics if isinstance(lyrics, str) else ""
    if len(lyrics) > MAX_LYRICS_CHARS:
        warnings_pre.append(f"lyrics longer than {MAX_LYRICS_CHARS} characters were truncated")
        lyrics = lyrics[:MAX_LYRICS_CHARS]
    opts = parse_options(options)
    stages = opts["stages"]

    raw_dur = mix.shape[1] / float(sr)
    if raw_dur < MIN_SECONDS:
        raise PipelineError("audio is too short")
    if raw_dur > opts["maxSeconds"] + 1e-6:
        mix = mix[:, : int(opts["maxSeconds"] * sr)]
        warnings_pre.append(f"audio is {raw_dur:.0f}s long; analysed the first {opts['maxSeconds']:.0f}s only")
    dur = mix.shape[1] / float(sr)
    mono = to_mono(mix)

    run_stages = ["prefetch"]
    if "separate" in stages:
        run_stages.append("separate")
    if mode == "sheetsage2" and {"beats", "chords", "melody"} & set(stages):
        run_stages.append("sheetsage2")
    for s in ("beats", "chords"):
        if s in stages:
            run_stages.append(s)
    if "chords" in stages:
        run_stages.append("key")
    for s in ("lyrics", "melody"):
        if s in stages:
            run_stages.append(s)

    device = device or models.pick_device()
    ctx = PipelineContext(device, run_stages, in_comfy=in_comfy, cancel_event=cancel_event,
                          progress_hook=progress_hook)
    ctx.warnings.extend(warnings_pre)
    res = empty_result(mode)
    res["durationSec"] = dur
    mdl = res["engine"]["models"]
    succeeded: list[str] = []

    # 0) รอ prefetch (เริ่มตอน import โหนด) — ไม่ต้องรอถ้ายังไม่ได้เริ่ม
    t0 = time.time()
    ctx.begin("prefetch")
    if not models.wait_prefetch(timeout=900.0, cancelled=ctx.cancelled):
        ctx.check_cancel()
        ctx.warn("prefetch: model download still running; continuing")
    ctx.end("prefetch", t0)
    if in_comfy:
        models.free_comfy_models()

    # 1) แยกเสียงร้อง
    vocals = acc = None
    stem_sr = sr
    if "separate" in run_stages:
        with _Stage(ctx, "separate") as st:
            from . import separate
            out = separate.separate(mix, sr, ctx)
            vocals, acc, stem_sr = out["vocals"], out["accompaniment"], out["sr"]
            mdl["separation"] = out["model"]
        if st.success:
            succeeded.append("separate")

    # 2) SheetSage2 (ถ้าเลือก)
    ss = None
    if "sheetsage2" in run_stages:
        if sheetsage_encoder is None:
            ctx.warnings.append("sheetsage2: no SheetSage2 audio encoder connected; used open models")
        else:
            with _Stage(ctx, "sheetsage2") as st:
                from . import sheetsage
                events = sheetsage.run_transcribe(sheetsage_encoder, mix, sr, check_cancel=ctx.check_cancel)
                ss = sheetsage.events_to_fields(events, dur)
                for w in ss.get("warnings", []):
                    ctx.warn(w)
            if st.success and ss is not None:
                succeeded.append("sheetsage2")
            else:
                ss = None
                ctx.warnings.append("sheetsage2: transcription failed; used open models")

    # 3) จังหวะ
    beats_list = None
    if "beats" in run_stages:
        if ss and len(ss["beats"]) >= 2:
            from . import sheetsage
            res.update(beats=ss["beats"], downbeats=ss["downbeats"], tempo=ss["tempo"], timeSig=ss["timeSig"])
            mdl["beats"] = sheetsage.MODEL_NAME
            beats_list = ss["beats"]
            succeeded.append("beats")
        else:
            with _Stage(ctx, "beats") as st:
                from . import beats as beatmod
                b = beatmod.detect(mono, sr, ctx)
                res.update(beats=b["beats"], downbeats=b["downbeats"], tempo=b["tempo"], timeSig=b["timeSig"])
                mdl["beats"] = b["model"]
                beats_list = b["beats"]
            if st.success:
                succeeded.append("beats")

    # 4) คอร์ด + คีย์
    raw = None
    cqt = None
    if "chords" in run_stages:
        from . import chords as chordmod
        if ss and ss["chords_raw"]:
            from . import sheetsage
            raw = ss["chords_raw"]
            mdl["chords"] = sheetsage.MODEL_NAME
            succeeded.append("chords")
        else:
            with _Stage(ctx, "chords") as st:
                use_acc = opts["chordSource"] == "accompaniment" and acc is not None
                src = acc if use_acc else mono
                src_sr = stem_sr if use_acc else sr
                if opts["chordSource"] == "accompaniment" and acc is None:
                    ctx.warn("accompaniment stem unavailable; recognised chords on the full mix")
                y22 = resample(src, src_sr, chordmod.CHORD_SR)
                out = chordmod.run_lv_chordia(y22, ctx.device, beats=beats_list, check_cancel=ctx.check_cancel)
                raw, cqt = out["segments"], out["cqt"]
                mdl["chords"] = out["model"] + (" on accompaniment" if use_acc else " on mix")
            if st.success:
                succeeded.append("chords")

        with _Stage(ctx, "key") as st:
            from . import key as keymod
            keyname = None
            if ss and ss.get("key"):
                keyname = ss["key"]
                mdl["key"] = "SheetSage2"
            else:
                if cqt is not None:
                    chroma = keymod.chroma_from_cqt(cqt)
                else:
                    base = acc if acc is not None else mono
                    base_sr = stem_sr if acc is not None else sr
                    chroma = keymod.chroma_from_audio(resample(base, base_sr, 22050), 22050)
                keyname, _kconf, _dbg = keymod.detect_key(chroma, chordmod.key_evidence(raw or []))
                mdl["key"] = "Krumhansl-Kessler chroma + chord fit"
            res["key"] = keyname
            if raw:
                segs, cw = chordmod.to_aquachord(raw, keyname)
                for w in cw:
                    ctx.warnings.append(f"chords: {w}")
                res["chords"] = chordmod.clean_segments(segs, beats=beats_list, duration=dur)
            if ss and ss.get("sections"):
                res["sections"] = ss["sections"]
        if st.success and keyname:
            succeeded.append("key")

    # vocal stem สำหรับเนื้อร้อง/ทำนอง
    vox, vox_sr = vocals, stem_sr
    if vox is None and ({"lyrics", "melody"} & set(run_stages)):
        vox, vox_sr = mono, sr
        why = "separation was not run" if "separate" not in run_stages else "separation failed"
        ctx.warnings.append(f"vocals: {why}; lyrics/melody used the full mix")

    # 5) เนื้อร้อง (โมดูลของทีม lyrics)
    if "lyrics" in run_stages:
        lyrics_mod = None
        try:
            lyrics_mod = _import_lyrics()
        except Exception as e:  # ImportError หรือ dependency ในโมดูลนั้นล้ม
            log.warning("lyrics import failed: %s", safe_error(e))
            ctx.warnings.append("lyrics: lyrics module unavailable")
        if lyrics_mod is not None:
            with _Stage(ctx, "lyrics") as st:
                out = lyrics_mod.transcribe_lyrics(np.ascontiguousarray(vox, dtype=np.float32), int(vox_sr),
                                                   lyrics, language, ctx)
                res["lyrics"] = out
                names = getattr(lyrics_mod, "MODEL_NAMES", None)
                if isinstance(names, dict):
                    for k in ("asr", "align"):
                        if names.get(k):
                            mdl[k] = str(names[k])
            if st.success and res["lyrics"]:
                succeeded.append("lyrics")

    # 6) ทำนอง
    if "melody" in run_stages:
        if ss and ss["melody"]["notes"]:
            from . import sheetsage
            res["melody"] = ss["melody"]
            mdl["pitch"] = sheetsage.MODEL_NAME
            succeeded.append("melody")
        else:
            with _Stage(ctx, "melody") as st:
                from . import melody as melmod
                m = melmod.transcribe(vox, vox_sr, ctx)
                res["melody"] = {"source": m["source"], "notes": m["notes"]}
                mdl["pitch"] = m["model"]
            if st.success:
                succeeded.append("melody")

    ctx.check_cancel()
    res["warnings"] = ctx.warnings
    ctx.timings["total"] = round(time.time() - t_all, 3)
    res["timings"] = dict(ctx.timings)
    problems = sanitize(res)
    res["warnings"] += [f"result: {p}" for p in problems]
    ctx.progress(1.0, "done")
    run.last_ctx = ctx  # สำหรับ CLI: peak VRAM ต่อขั้น
    if not succeeded:
        raise PipelineError("no analysis stage succeeded")
    return res


run.last_ctx = None


def run_from_comfy(audio, mode, language, lyrics, options, sheetsage_encoder=None) -> dict:
    """เรียกจากโหนด AquaChordTranscribe — AUDIO dict ของ ComfyUI"""
    try:
        mix, sr = from_comfy(audio)
    except AudioError as e:
        raise PipelineError(f"AquaChord: {e}") from None
    try:
        return run(mix, sr, mode=mode, language=language, lyrics=lyrics, options=options,
                   sheetsage_encoder=sheetsage_encoder, device=models.pick_device(), in_comfy=True)
    except PipelineError as e:
        msg = str(e)
        raise PipelineError(msg if msg.startswith("AquaChord:") else f"AquaChord: {msg}") from None


def run_file(path: str, mode: str = "open", language: str = "th", lyrics: str = "", options=None,
             device: str | None = None, sheetsage_encoder=None, cancel_event=None, progress_hook=None) -> dict:
    """CLI / ทดสอบนอก ComfyUI"""
    try:
        mix, sr = load_file(path)
    except AudioError as e:
        raise PipelineError(str(e)) from None
    return run(mix, sr, mode=mode, language=language, lyrics=lyrics, options=options,
               sheetsage_encoder=sheetsage_encoder, device=device, in_comfy=False,
               cancel_event=cancel_event, progress_hook=progress_hook)
