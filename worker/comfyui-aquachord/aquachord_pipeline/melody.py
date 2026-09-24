"""ทำนองร้อง: f0 ของ vocal stem ด้วย torchfcpe (MIT) → ตัดเป็นโน้ต MIDI {t0, t1, pitch, conf}

ตัดโน้ต (เรียบง่าย ทนทาน):
1. voiced = conf ≥ voicing_threshold, f0 ในช่วงเสียงร้อง และพลังงาน vocal stem ไม่ต่ำกว่ายอด −gate_db
2. median smoothing ของ pitch (semitone) ภายในช่วง voiced
3. แยกโน้ตเมื่อ pitch เบี่ยงจากโน้ตปัจจุบัน > 0.6 semitone ต่อเนื่อง > 60 ms (แยก ณ จุดที่เริ่มเบี่ยง)
4. โน้ตสั้นกว่า 90 ms ทิ้ง · ช่องว่าง < 40 ms ระหว่างโน้ต pitch เดียวกันรวมเป็นโน้ตเดียว
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .audio import resample

FCPE_SR = 16000
MODEL_NAME = "torchfcpe 0.0.4 (bundled fcpe_c_v001)"


@dataclass
class SegParams:
    voicing_threshold: float = 0.05
    f0_min: float = 65.0
    f0_max: float = 1100.0
    gate_db: float = 40.0          # ตัดเฟรมที่เบากว่ายอด (percentile 95) เกินเท่านี้
    median_frames: int = 5         # 50 ms ที่ hop 10 ms
    jump_semitones: float = 0.6
    jump_hold_s: float = 0.060
    min_note_s: float = 0.090
    merge_gap_s: float = 0.040


def hz_to_midi(f0):
    f0 = np.asarray(f0, dtype=np.float64)
    out = np.full(f0.shape, np.nan)
    ok = f0 > 0
    out[ok] = 69.0 + 12.0 * np.log2(f0[ok] / 440.0)
    return out


def _median_filter_runs(midi: np.ndarray, voiced: np.ndarray, k: int) -> np.ndarray:
    if k <= 1:
        return midi
    out = midi.copy()
    h = k // 2
    n = len(midi)
    i = 0
    while i < n:
        if not voiced[i]:
            i += 1
            continue
        j = i
        while j < n and voiced[j]:
            j += 1
        seg = midi[i:j]
        for t in range(i, j):
            a, b = max(i, t - h), min(j, t + h + 1)
            out[t] = np.median(midi[a:b])
        i = j
        del seg
    return out


def segment_notes(f0_hz, conf, hop_s: float, energy_db=None, params: SegParams | None = None) -> list[dict]:
    """f0/conf ต่อเฟรม (hop_s วินาที) → [{'t0','t1','pitch','conf'}] เรียงตามเวลา ไม่ซ้อนกัน"""
    p = params or SegParams()
    f0 = np.asarray(f0_hz, dtype=np.float64).reshape(-1)
    cf = np.asarray(conf, dtype=np.float64).reshape(-1) if conf is not None else np.ones_like(f0)
    n = min(len(f0), len(cf))
    f0, cf = f0[:n], cf[:n]
    if n == 0:
        return []
    voiced = (cf >= p.voicing_threshold) & (f0 >= p.f0_min) & (f0 <= p.f0_max)
    if energy_db is not None:
        e = np.asarray(energy_db, dtype=np.float64).reshape(-1)
        if len(e) < n:
            e = np.pad(e, (0, n - len(e)), constant_values=-120.0)
        e = e[:n]
        ref = np.percentile(e, 95) if np.isfinite(e).any() else 0.0
        voiced &= e >= ref - p.gate_db
    midi = hz_to_midi(np.where(voiced, f0, 0.0))
    midi = _median_filter_runs(midi, voiced, p.median_frames)

    hold = max(1, int(round(p.jump_hold_s / hop_s)))
    notes: list[tuple[int, int]] = []  # (start_frame, end_frame_exclusive)
    i = 0
    while i < n:
        if not voiced[i]:
            i += 1
            continue
        start = i
        ref_vals = [midi[i]]
        dev_start = None
        j = i + 1
        while j < n and voiced[j]:
            cur = float(np.median(ref_vals))
            if abs(midi[j] - cur) > p.jump_semitones:
                if dev_start is None:
                    dev_start = j
                if j - dev_start + 1 > hold:
                    notes.append((start, dev_start))
                    start = dev_start
                    ref_vals = list(midi[dev_start:j + 1])
                    dev_start = None
            else:
                dev_start = None
                ref_vals.append(midi[j])
                if len(ref_vals) > 40:  # อ้างอิงช่วงล่าสุด ~0.4 วิ (รองรับ glide ช้า ๆ)
                    ref_vals = ref_vals[-40:]
            j += 1
        notes.append((start, j))
        i = j

    out: list[dict] = []
    for a, b in notes:
        if b <= a:
            continue
        pitch = int(round(float(np.median(midi[a:b]))))
        if not 0 <= pitch <= 127:
            continue
        out.append({"t0": a * hop_s, "t1": b * hop_s, "pitch": pitch, "conf": float(np.mean(cf[a:b])),
                    "_n": b - a})

    # รวมช่องว่างสั้น ๆ ระหว่างโน้ต pitch เดียวกัน (ก่อนทิ้งโน้ตสั้น — ให้โน้ตที่ขาดเป็นท่อนได้ต่อกัน)
    merged: list[dict] = []
    for nt in out:
        if merged and merged[-1]["pitch"] == nt["pitch"] and nt["t0"] - merged[-1]["t1"] < p.merge_gap_s + 1e-9:
            m = merged[-1]
            tot = m["_n"] + nt["_n"]
            m["conf"] = (m["conf"] * m["_n"] + nt["conf"] * nt["_n"]) / tot
            m["_n"] = tot
            m["t1"] = nt["t1"]
        else:
            merged.append(dict(nt))
    res = []
    for m in merged:
        if m["t1"] - m["t0"] + 1e-9 < p.min_note_s:
            continue
        m.pop("_n", None)
        res.append(m)
    return res


def frame_energy_db(y: np.ndarray, sr: int, hop_s: float, n_frames: int) -> np.ndarray:
    hop = max(1, int(round(sr * hop_s)))
    win = hop * 2
    out = np.full(n_frames, -120.0)
    for k in range(n_frames):
        a = max(0, k * hop - hop // 2)
        seg = y[a:a + win]
        if len(seg):
            r = float(np.sqrt(np.mean(seg.astype(np.float64) ** 2)))
            out[k] = 20.0 * np.log10(max(r, 1e-10))
    return out


def extract_f0(vocals: np.ndarray, sr: int, device: str, check_cancel=None) -> tuple[np.ndarray, np.ndarray, float]:
    """torchfcpe บน 16 kHz → (f0_hz, conf, hop_s) · conf = ค่าสูงสุดของ latent (ความมั่นใจของโมเดล)"""
    import torch
    from torchfcpe import spawn_bundled_infer_model  # type: ignore

    y = resample(vocals, sr, FCPE_SR)
    model = spawn_bundled_infer_model(device=device)
    hop_s = model.get_hop_size() / model.get_model_sr()
    f0s, confs = [], []
    chunk = FCPE_SR * 30  # ทีละ 30 วิ กัน VRAM/RAM (FCPE เป็นโมเดลเฟรมต่อเฟรม — ต่อกันได้ตรง ๆ)
    hop = model.get_hop_size()
    chunk -= chunk % hop
    try:
        with torch.no_grad():
            for a in range(0, len(y), chunk):
                if check_cancel:
                    check_cancel()
                seg = y[a:a + chunk]
                wav = torch.from_numpy(np.ascontiguousarray(seg, dtype=np.float32))[None, :, None].to(device)
                try:
                    mel = model.wav2mel(wav, FCPE_SR)
                    latent = model.model.forward(mel)
                    conf = latent.max(dim=-1)[0][0]
                    cents = model.model.latent2cents_local_decoder(latent, mask=False)
                    f0 = model.model.cent_to_f0(cents)[0, :, 0]
                except AttributeError:  # API ภายในเปลี่ยน → ใช้ infer สาธารณะ (ไม่มี conf)
                    f0 = model.infer(wav, sr=FCPE_SR, decoder_mode="local_argmax", threshold=0.006)[0, :, 0]
                    conf = (f0 > 0).float()
                n_exp = len(seg) // hop + (1 if a + chunk >= len(y) else 0)
                f0s.append(f0[:n_exp].float().cpu().numpy())
                confs.append(conf[:n_exp].float().cpu().numpy())
    finally:
        del model
    f0 = np.concatenate(f0s) if f0s else np.zeros(0)
    conf = np.concatenate(confs) if confs else np.zeros(0)
    return f0, conf, hop_s


def transcribe(vocals: np.ndarray, sr: int, ctx, params: SegParams | None = None) -> dict:
    f0, conf, hop_s = extract_f0(vocals, sr, ctx.device, check_cancel=ctx.check_cancel)
    energy = frame_energy_db(resample(vocals, sr, FCPE_SR), FCPE_SR, hop_s, len(f0))
    notes = segment_notes(f0, conf, hop_s, energy_db=energy, params=params)
    return {"source": "fcpe", "notes": notes, "model": MODEL_NAME}
