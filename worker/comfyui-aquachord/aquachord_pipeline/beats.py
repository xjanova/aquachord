"""จังหวะ/ห้อง: beat_this (CPJKU, MIT) checkpoint final0 → beats, downbeats, tempo, timeSig

final0 (ไม่ใช่ small0): ตัวเต็มแม่นกว่าเล็กน้อยในเพลงที่มีหลายชั้นเสียง ขนาด 81 MB และบน GPU ใช้ไม่ถึง 2 วินาที
ต่อเพลง จึงไม่มีเหตุให้ใช้ตัวเล็ก · checkpoint โหลดผ่าน models_dir (ไม่ใช่ torch.hub cache)
ออฟไลน์/ดาวน์โหลดไม่ได้ → คำเตือน + ประมาณ tempo/beat ด้วย librosa.beat.beat_track (downbeat เดาทุก 4 beat)
"""
from __future__ import annotations

import numpy as np

from . import models
from .audio import resample

BEAT_SR = 22050
MODEL_NAME = "beat_this final0 (CPJKU)"
FALLBACK_NAME = "librosa beat_track (fallback)"


def tempo_from_beats(beats) -> float | None:
    b = np.asarray(beats, dtype=np.float64)
    if len(b) < 3:
        return None
    ibi = np.diff(b)
    ibi = ibi[(ibi > 0.2) & (ibi < 2.0)]  # 30–300 BPM
    if len(ibi) == 0:
        return None
    return float(round(60.0 / float(np.median(ibi)), 1))


def time_signature(beats, downbeats) -> list[int]:
    """นับ beat ระหว่าง downbeat ติดกัน → ค่าฐานนิยม (2–7) เป็นตัวบน; ข้อมูลไม่พอ = [4, 4]"""
    b = np.asarray(beats, dtype=np.float64)
    d = np.asarray(downbeats, dtype=np.float64)
    if len(d) < 3 or len(b) < 4:
        return [4, 4]
    counts = []
    for a, c in zip(d, d[1:]):
        n = int(np.sum((b >= a - 1e-3) & (b < c - 1e-3)))
        if 2 <= n <= 7:
            counts.append(n)
    if not counts:
        return [4, 4]
    vals, freq = np.unique(counts, return_counts=True)
    return [int(vals[int(np.argmax(freq))]), 4]


def run_beat_this(mono: np.ndarray, sr: int, device: str, dtype) -> tuple[np.ndarray, np.ndarray]:
    import torch
    from beat_this.inference import Audio2Beats  # type: ignore

    ckpt = models.beat_this_checkpoint("final0")
    use_fp16 = str(device).startswith("cuda") and dtype != torch.float32
    y = resample(mono, sr, BEAT_SR).astype(np.float64)
    tracker = Audio2Beats(checkpoint_path=str(ckpt), device=device, float16=use_fp16, dbn=False)
    try:
        beats, downbeats = tracker(y, BEAT_SR)
    finally:
        del tracker
        models.release_gpu()
    return np.asarray(beats, dtype=np.float64), np.asarray(downbeats, dtype=np.float64)


def fallback_beats(mono: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
    import librosa
    y = resample(mono, sr, BEAT_SR)
    _tempo, frames = librosa.beat.beat_track(y=y, sr=BEAT_SR, hop_length=512)
    beats = librosa.frames_to_time(frames, sr=BEAT_SR, hop_length=512)
    return np.asarray(beats, dtype=np.float64), np.asarray(beats[::4], dtype=np.float64)


def detect(mono: np.ndarray, sr: int, ctx) -> dict:
    """คืน {'beats','downbeats','tempo','timeSig','model'} — beat_this ล้ม = fallback + ctx.warn"""
    try:
        beats, downbeats = run_beat_this(mono, sr, ctx.device, ctx.dtype)
        model = MODEL_NAME
    except Exception as e:  # noqa: BLE001 — ออฟไลน์/checksum/โมดูลไม่มี
        if getattr(ctx, "is_cancel", lambda _e: False)(e):
            raise
        ctx.warn(f"beats: beat_this unavailable ({type(e).__name__}); tempo estimated with librosa, "
                 "downbeats guessed every 4 beats")
        beats, downbeats = fallback_beats(mono, sr)
        model = FALLBACK_NAME
    beats = np.unique(np.round(beats, 3))
    downbeats = np.unique(np.round(downbeats, 3))
    return {
        "beats": beats.tolist(),
        "downbeats": downbeats.tolist(),
        "tempo": tempo_from_beats(beats),
        "timeSig": time_signature(beats, downbeats),
        "model": model,
    }
