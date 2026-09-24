"""แยกเสียงร้อง/ดนตรีด้วย Mel-Band RoFormer (Kim, weights MIT) — chunk 8 วิ + overlap-add

- ทำงานได้ทั้ง CUDA และ CPU; VRAM ที่ใช้จริง ~2–3 GB (fp32, batch 1) จึงอยู่ใต้เป้า 6 GB
- ผลรวมสะสมบน CPU (ไม่เก็บทั้งเพลงไว้ใน VRAM)
- คืน vocals/accompaniment แบบ mono float32 ที่ 44100 Hz
"""
from __future__ import annotations

import numpy as np

from . import models
from .audio import resample

SEP_SR = 44100
MODEL_NAME = f"{models.KIM_REPO}@{models.KIM_REVISION[:7]} (Mel-Band RoFormer vocals)"


def _window(size: int, fade: int) -> np.ndarray:
    w = np.ones(size, dtype=np.float32)
    w[:fade] = np.linspace(0.0, 1.0, fade, dtype=np.float32)
    w[-fade:] = np.linspace(1.0, 0.0, fade, dtype=np.float32)
    return w


def load_model(device: str):
    import torch
    from .vendor.mel_band_roformer import KIM_VOCALS_CONFIG, MelBandRoformer

    ckpt = models.kim_checkpoint()
    model = MelBandRoformer(**KIM_VOCALS_CONFIG)
    sd = torch.load(str(ckpt), map_location="cpu", weights_only=True)
    model.load_state_dict(sd, strict=True)
    del sd
    return model.to(device).eval()


def demix(model, mix: np.ndarray, device: str, dtype, chunk: int, overlap: int = 2,
          progress=None, check_cancel=None) -> np.ndarray:
    """overlap-add แบบเดียวกับ inference ของ Kim (fade 10% + reflect pad ขอบ) — mix: [2, n] → vocals [2, n]"""
    import torch

    n = mix.shape[1]
    step = chunk // overlap
    fade = chunk // 10
    border = chunk - step
    padded = n > 2 * border and border > 0
    x = np.pad(mix, ((0, 0), (border, border)), mode="reflect") if padded else mix
    total = x.shape[1]
    out = np.zeros_like(x, dtype=np.float32)
    counter = np.zeros(total, dtype=np.float32)
    base_win = _window(chunk, fade)
    starts = list(range(0, total, step))
    use_amp = str(device).startswith("cuda") and dtype != torch.float32
    with torch.inference_mode():
        for k, i in enumerate(starts):
            if check_cancel:
                check_cancel()
            part = x[:, i:i + chunk]
            length = part.shape[1]
            if length < chunk:
                mode = "reflect" if length > chunk // 2 + 1 else "constant"
                part = np.pad(part, ((0, 0), (0, chunk - length)), mode=mode)
            t = torch.from_numpy(np.ascontiguousarray(part)).unsqueeze(0).to(device)
            with torch.autocast(device_type="cuda", dtype=dtype, enabled=use_amp):
                y = model(t)[0]
            y = y.float().cpu().numpy()
            win = base_win.copy()
            if i == 0:
                win[:fade] = 1.0
            elif i + chunk >= total:
                win[-fade:] = 1.0
            out[:, i:i + length] += y[:, :length] * win[:length]
            counter[i:i + length] += win[:length]
            if progress:
                progress((k + 1) / len(starts))
    out /= np.maximum(counter, 1e-8)
    np.nan_to_num(out, copy=False)
    if padded:
        out = out[:, border:-border]
    return out


def separate(mix: np.ndarray, sr: int, ctx, chunk: int | None = None) -> dict:
    """mix: [channels, samples] ใด ๆ → {'vocals','accompaniment' (mono 44.1k), 'sr', 'model', 'device'}"""
    import torch
    from .vendor.mel_band_roformer import KIM_CHUNK_SIZE

    x = resample(mix, sr, SEP_SR)
    if x.shape[0] == 1:
        x = np.repeat(x, 2, axis=0)
    chunk = int(chunk or KIM_CHUNK_SIZE)
    device = ctx.device
    model = None
    try:
        try:
            model = load_model(device)
            vocals = demix(model, x, device, ctx.dtype, chunk, progress=lambda f: ctx.progress(f, "separate"),
                           check_cancel=ctx.check_cancel)
        except torch.cuda.OutOfMemoryError:
            # VRAM ไม่พอ (มีงานอื่นถือไว้) → ถอยไป CPU (ช้าแต่เสร็จ)
            ctx.warn("separate: GPU out of memory, retried on CPU")
            model = None
            models.release_gpu()
            device = "cpu"
            model = load_model(device)
            vocals = demix(model, x, device, torch.float32, chunk, progress=lambda f: ctx.progress(f, "separate"),
                           check_cancel=ctx.check_cancel)
    finally:
        model = None
        models.release_gpu()
    acc = x - vocals
    return {
        "vocals": np.clip(vocals.mean(axis=0), -1.0, 1.0).astype(np.float32),
        "accompaniment": np.clip(acc.mean(axis=0), -1.0, 1.0).astype(np.float32),
        "sr": SEP_SR,
        "model": MODEL_NAME,
        "device": device,
    }
