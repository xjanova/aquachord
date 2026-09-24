"""mode 'sheetsage2': ใช้ SheetSage2 (m-a-p, น้ำหนัก CC-BY-NC-4.0) ที่ ComfyUI v0.36.0 โหลดผ่าน AudioEncoderLoader

อ้างอิงซอร์ส ComfyUI v0.36.0:
- comfy/audio_encoders/audio_encoders.py  SheetSage2AudioEncoder.generate_abc — วิธีเตรียมเสียง
  (mean channel → resample เป็น model_sample_rate 24 kHz → load_model_gpu(patcher) → model.transcribe(wave[None]))
- comfy/audio_encoders/sheetsage2.py  SheetSage2.transcribe → list ของ event:
  {'time': s, 'subbeat', 'global_subbeat', 'tokens_by_field', 'values': {
     'timestamp'?, 'rhythm'?: {'meter': (num, den), 'eighth_position': int}, 'structure'?: str,
     'key'?: 'G:minor', 'chord'?: 'A:min/b3' (Harte), 'melody'?: [{'pitch','track' (0=Vocal,1=Ins),
     'duration_bin','duration_steps','end_time'}]}}
- comfy/audio_encoders/sheetsage2_abc.py  events_to_abc — ตีความ beat จาก eighth_position×den/8 (ต้องเป็นจำนวนเต็ม)
  และช่วงคอร์ด/คีย์/ท่อน = จาก event นั้นถึง event ถัดไปที่มี field เดียวกัน

โมดูลนี้แปลง events → field ของ TranscriptionResult (ไม่พึ่ง ABC)
"""
from __future__ import annotations

from collections import Counter

import numpy as np

from . import chords as chordmod
from . import key as keymod

MODEL_NAME = "SheetSage2 (m-a-p, CC-BY-NC-4.0 weights via ComfyUI AudioEncoderLoader)"
MELODY_CONF = 0.75  # SheetSage2 ไม่มีความมั่นใจรายโน้ต — ใช้ค่าคงที่ (ดู README)
CHORD_CONF = None
SS_SR = 24000


def run_transcribe(encoder, mix: np.ndarray, sr: int, check_cancel=None) -> list[dict]:
    """เรียก SheetSage2.transcribe ผ่าน AUDIO_ENCODER object ของ ComfyUI — mix: [channels, samples]"""
    import torch
    import torchaudio

    model = getattr(encoder, "model", None)
    if model is None or not hasattr(model, "transcribe"):
        raise TypeError("connected audio encoder is not SheetSage2")
    try:
        import comfy.model_management as mm  # type: ignore
    except ImportError:
        mm = None
    target_sr = int(getattr(encoder, "model_sample_rate", SS_SR) or SS_SR)
    wav = torch.from_numpy(np.ascontiguousarray(mix, dtype=np.float32)).mean(dim=0, keepdim=True)  # [1, S]
    wav = torchaudio.functional.resample(wav, sr, target_sr)
    if check_cancel:
        check_cancel()
    if mm is not None and hasattr(encoder, "patcher"):
        mm.load_model_gpu(encoder.patcher)
    device = getattr(encoder, "load_device", "cpu")
    with torch.inference_mode():
        events = model.transcribe(wav.to(device))
    return list(events)


def _intervals(events, field, duration):
    rows = [[float(e["time"]), duration, e["values"][field]] for e in events if field in e.get("values", {})]
    for a, b in zip(rows, rows[1:]):
        a[1] = b[0]
    return [r for r in rows if r[1] > r[0]]


def key_from_sheetsage(value: str) -> str | None:
    """'G:minor' → 'Gm' · 'A#:major' → 'Bb' (ชื่อคีย์มาตรฐานของเรา)"""
    if not value or ":" not in value:
        return None
    root, mode = value.split(":", 1)
    pc = keymod.pc_of(root)
    if pc is None:
        return None
    return keymod.key_name(pc, mode.strip().lower().startswith("min"))


def events_to_fields(events: list[dict], duration: float) -> dict:
    """events → {'beats','downbeats','tempo','timeSig','key','chords_raw','chords','melody','sections','warnings'}"""
    from .beats import tempo_from_beats

    warnings: list[str] = []
    events = sorted(events, key=lambda e: (float(e.get("time", 0.0)), e.get("global_subbeat", 0)))
    beats, downbeats, meters = [], [], []
    meter = None
    for e in events:
        rhythm = e.get("values", {}).get("rhythm") or {}
        if rhythm.get("meter"):
            meter = tuple(rhythm["meter"])
            meters.append(meter)
        eighth = rhythm.get("eighth_position")
        if eighth is None or meter is None:
            continue
        num, den = int(meter[0]), int(meter[1])
        pos = eighth * den / 8.0
        if abs(pos - round(pos)) > 1e-9 or not 0 <= pos < num:
            continue  # ไม่ใช่ beat (เช่น ตำแหน่งเขบ็ตใน 6/8)
        t = float(e["time"])
        if beats and t <= beats[-1] + 1e-6:
            continue
        beats.append(t)
        if int(round(pos)) == 0:
            downbeats.append(t)
    time_sig = [4, 4]
    if meters:
        (num, den), _ = Counter(meters).most_common(1)[0]
        if 1 <= int(num) <= 32 and int(den) in (1, 2, 4, 8, 16, 32):
            time_sig = [int(num), int(den)]

    # key: ช่วงที่ยาวที่สุดรวม
    key_dur: Counter = Counter()
    for t0, t1, v in _intervals(events, "key", duration):
        k = key_from_sheetsage(v)
        if k:
            key_dur[k] += t1 - t0
    keyname = key_dur.most_common(1)[0][0] if key_dur else None
    if len(key_dur) > 1:
        warnings.append("sheetsage2: key changes detected; reported the longest one")

    raw = [(t0, t1, v, CHORD_CONF) for t0, t1, v in _intervals(events, "chord", duration)]
    chords, cw = chordmod.to_aquachord(raw, keyname)
    warnings += [f"chords: {w}" for w in cw]

    notes = []
    for e in events:
        t0 = float(e["time"])
        for nt in e.get("values", {}).get("melody", ()) or ():
            if int(nt.get("track", 1)) != 0:  # voice 0 = Vocal
                continue
            t1 = min(duration, float(nt.get("end_time", t0)))
            pitch = int(nt.get("pitch", -1))
            if t1 > t0 and 0 <= pitch <= 127:
                notes.append({"t0": t0, "t1": t1, "pitch": pitch, "conf": MELODY_CONF})
    notes.sort(key=lambda n: (n["t0"], n["pitch"]))
    # ตัดโน้ตที่ทับกัน (เสียงร้องเป็น monophonic) — เหมือน events_to_abc
    for a, b in zip(notes, notes[1:]):
        if a["t1"] > b["t0"]:
            a["t1"] = b["t0"]
    notes = [n for n in notes if n["t1"] > n["t0"] + 1e-6]

    sections = []
    for t0, _t1, lab in _intervals(events, "structure", duration):
        if sections and sections[-1]["label"] == lab:
            continue
        sections.append({"t": t0, "label": str(lab)})

    return {
        "beats": beats,
        "downbeats": downbeats,
        "tempo": tempo_from_beats(beats),
        "timeSig": time_sig,
        "key": keyname,
        "chords_raw": raw,
        "chords": chords,
        "melody": {"source": "sheetsage2", "notes": notes},
        "sections": sections,
        "warnings": warnings,
    }


def load_encoder_standalone(weights_path: str, comfy_root: str):
    """CLI: import ComfyUI จาก comfy_root แล้วโหลด AUDIO_ENCODER แบบเดียวกับ AudioEncoderLoader"""
    import sys
    if comfy_root not in sys.path:
        sys.path.insert(0, comfy_root)
    import comfy.utils  # type: ignore
    import comfy.audio_encoders.audio_encoders as ae  # type: ignore
    sd = comfy.utils.load_torch_file(weights_path, safe_load=True)
    enc = ae.load_audio_encoder_from_sd(sd)
    if enc is None:
        raise RuntimeError("invalid audio encoder file")
    return enc
