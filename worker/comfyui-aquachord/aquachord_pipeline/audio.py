"""อ่าน/แปลงเสียง: ไฟล์ (CLI) หรือ AUDIO dict ของ ComfyUI → numpy float32 [channels, samples]"""
from __future__ import annotations

import numpy as np

MAX_INPUT_SECONDS_HARD = 1800.0  # ยาวเกินนี้ปฏิเสธเลย (กัน RAM ระเบิด) — ส่วน 600 วิแรกใช้ตัดตามปกติ


class AudioError(Exception):
    """อ่านเสียงไม่ได้/ยาวเกิน/สั้นเกิน — ข้อความสั้น ภาษาอังกฤษ ไม่มี path"""


def _clean(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float32)
    if x.ndim == 1:
        x = x[None, :]
    if x.ndim != 2 or x.shape[1] == 0:
        raise AudioError("audio is empty")
    if x.shape[0] > 8 and x.shape[1] <= 8:  # [samples, channels] → [channels, samples]
        x = x.T
    x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    if peak > 1.0:  # เสียงบางไฟล์เกินช่วง — ปรับให้อยู่ใน [-1, 1]
        x = x / peak
    return np.ascontiguousarray(x[:2] if x.shape[0] > 2 else x)


def from_comfy(audio) -> tuple[np.ndarray, int]:
    """AUDIO ของ ComfyUI = {'waveform': Tensor[batch, channels, samples], 'sample_rate': int} — ใช้ batch แรก"""
    if not isinstance(audio, dict) or "waveform" not in audio or "sample_rate" not in audio:
        raise AudioError("invalid AUDIO input")
    wav = audio["waveform"]
    try:
        sr = int(audio["sample_rate"])
    except (TypeError, ValueError):
        raise AudioError("invalid sample rate") from None
    if sr < 4000 or sr > 384000:
        raise AudioError("unsupported sample rate")
    shape = tuple(getattr(wav, "shape", ()))
    if not shape or shape[-1] / sr > MAX_INPUT_SECONDS_HARD:
        raise AudioError("audio is too long" if shape else "invalid AUDIO input")
    try:
        import torch
        if isinstance(wav, torch.Tensor):
            wav = (wav[0] if wav.ndim == 3 else wav).detach().float().cpu().numpy()
    except ImportError:
        pass
    wav = np.asarray(wav)
    if wav.ndim == 3:
        wav = wav[0]
    return _clean(wav), sr


def load_file(path: str) -> tuple[np.ndarray, int]:
    """soundfile (wav/flac/ogg/mp3) → ถ้าไม่ได้ลอง librosa/audioread (m4a ต้องมี ffmpeg)"""
    err = None
    try:
        import soundfile as sf
        info = sf.info(path)
        if info.frames / max(1, info.samplerate) > MAX_INPUT_SECONDS_HARD:
            raise AudioError("audio is too long")
        data, sr = sf.read(path, dtype="float32", always_2d=True)
        return _clean(data.T), int(sr)
    except AudioError:
        raise
    except Exception as e:  # noqa: BLE001 — ลองตัวอ่านถัดไป
        err = e
    try:
        import librosa
        data, sr = librosa.load(path, sr=None, mono=False, duration=MAX_INPUT_SECONDS_HARD + 1)
        return _clean(data), int(sr)
    except Exception as e:  # noqa: BLE001
        err = e
    raise AudioError(f"could not read audio ({type(err).__name__})")


def resample(x: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    """x: [channels, samples] หรือ [samples] → sr_out (soxr คุณภาพ HQ)"""
    if sr_in == sr_out:
        return np.ascontiguousarray(x, dtype=np.float32)
    import soxr
    if x.ndim == 1:
        return soxr.resample(x.astype(np.float32), sr_in, sr_out).astype(np.float32)
    y = soxr.resample(np.ascontiguousarray(x.T, dtype=np.float32), sr_in, sr_out)
    return np.ascontiguousarray(np.asarray(y, dtype=np.float32).T)


def to_mono(x: np.ndarray) -> np.ndarray:
    return x.mean(axis=0).astype(np.float32) if x.ndim == 2 else x.astype(np.float32)


def rms_db(x: np.ndarray) -> float:
    r = float(np.sqrt(np.mean(np.square(x, dtype=np.float64)))) if x.size else 0.0
    return 20.0 * np.log10(max(r, 1e-10))
