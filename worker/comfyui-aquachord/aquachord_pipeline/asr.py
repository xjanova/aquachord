"""ถอดเนื้อร้องจาก vocal stem เมื่อผู้ใช้ไม่ได้วางเนื้อ — Qwen3-ASR (Apache-2.0)

ตัดสินใจ (2026-09-24): ใช้ checkpoint แบบ transformers native `Qwen/Qwen3-ASR-1.7B-hf`
ผ่าน `transformers>=5.13` (Qwen3ASRForConditionalGeneration อยู่ใน transformers แล้ว)
แทนแพ็กเกจ `qwen-asr` — แพ็กเกจนั้น pin transformers==4.57.6 และ import nagisa (Japanese
tokenizer ที่ต้องคอมไพล์) ตั้งแต่ `import qwen_asr` + ลาก gradio/flask มาด้วย ไม่จำเป็นต่อ inference

กันการ "หลอน" (hallucination) ของ ASR:
- ถอดเฉพาะก้อนที่ VAD บอกว่ามีเสียงร้อง (ก้อนเงียบไม่ส่งเข้าโมเดลเลย)
- ตัด n-gram ซ้ำยาว ๆ, ข้อความหนาแน่นเกินเวลาที่ร้องจริง, ประโยคสำเร็จรูป ("ขอบคุณที่รับชม", "subscribe")
- บังคับภาษาไทยเมื่อ language == 'th' แล้วทิ้งผลที่มีอักษรจีน/ญี่ปุ่น/เกาหลีหลุดมา
"""
from __future__ import annotations

import re
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

import numpy as np

from .align import FRAME_SEC, HOP, release

ASR_TARGET_LANG = {"th": "th", "en": "en", "auto": None}
_NAME_TO_CODE = {
    "thai": "th", "english": "en", "chinese": "zh", "cantonese": "yue", "japanese": "ja", "korean": "ko",
    "vietnamese": "vi", "indonesian": "id", "malay": "ms", "filipino": "fil", "hindi": "hi",
    "french": "fr", "german": "de", "spanish": "es", "portuguese": "pt", "italian": "it", "russian": "ru",
    "arabic": "ar", "turkish": "tr", "dutch": "nl",
}

# ข้อความสำเร็จรูปที่ ASR ชอบหลอนออกมาตอนเจอดนตรี/เงียบ (เทียบหลังตัดช่องว่าง/วรรคตอน, ตัวเล็ก)
_FILLER_EXACT = {
    "ขอบคุณครับ", "ขอบคุณค่ะ", "ขอบคุณ", "ขอบคุณที่รับชม", "ขอบคุณที่รับชมครับ", "ขอบคุณที่รับชมค่ะ",
    "thankyou", "thanks", "thankyouforwatching", "thanksforwatching", "you", "bye", "music", "musica",
    "ok", "okay", "yeah", "uh", "um", "hmm", "mm",
}
_FILLER_SUB = (
    "ติดตามช่อง", "กดติดตาม", "กดไลค์", "กดซับ", "ซับไทย", "คำบรรยายโดย", "คำบรรยายไทย", "subscribe",
    "subtitlesby", "subtitle", "amaraorg", "字幕", "订阅", "點贊", "点赞", "请不吝", "ご視聴",
)
_RE_TAGS = re.compile(r"<[^>]{0,40}>|\[[^\]]{0,40}\]|\((?:music|音乐|音楽|เพลง|ดนตรี|instrumental)[^)]{0,20}\)|[♪♫♬♩]", re.I)
_RE_CJK = re.compile(r"[぀-ヿ㐀-䶿一-鿿가-힯]")
_RE_NONWORD = re.compile(r"[\s\W_]+", re.UNICODE)


@dataclass
class AsrSegment:
    f0: int  # เฟรมเริ่มของก้อน (20 ms)
    f1: int  # เฟรมจบ (ไม่รวม)
    text: str  # ข้อความหลังกรองหลอนแล้ว ("" = ทิ้ง)
    language: str | None  # รหัสภาษา เช่น 'th'
    raw: str = ""  # ข้อความดิบจากโมเดล (debug)
    dropped: str = ""  # เหตุผลที่ทิ้ง ("" = ใช้ได้)


# ================================================================ กรองหลอน


def collapse_repeats(text: str, max_unit: int = 20, keep: int = 2, min_reps: int = 5) -> str:
    """หน่วยข้อความ (2..max_unit อักษร) ซ้ำติดกัน >= min_reps ครั้ง -> เหลือ keep ครั้ง;
    อักษรเดียวซ้ำ > 6 -> เหลือ 3 (เช่น โอ้ววววววว -> โอ้ววว)"""
    s = re.sub(r"(.)\1{6,}", lambda m: m.group(1) * 3, text)
    for unit in range(max_unit, 1, -1):
        rx = re.compile(r"(.{%d})(?:\s*\1){%d,}" % (unit, min_reps - 1), re.S)
        s = rx.sub(lambda m: " ".join([m.group(1)] * keep), s)
    return re.sub(r"\s+", " ", s).strip()


def compression_ratio(s: str) -> float:
    b = s.encode("utf-8")
    if not b:
        return 0.0
    return len(b) / max(1, len(zlib.compress(b, 9)))


def clean_asr_text(text: str, voiced_sec: float, language: str | None = "th") -> tuple[str, str]:
    """คืน (ข้อความที่ใช้ได้, เหตุผลที่ทิ้ง) — เหตุผล "" แปลว่าใช้ได้"""
    t = _RE_TAGS.sub(" ", text or "")
    t = re.sub(r"\s+", " ", t).strip()
    if not t:
        return "", "empty"
    if language == "th" and _RE_CJK.search(t):
        return "", "wrong-script"
    t = collapse_repeats(t)
    norm = _RE_NONWORD.sub("", t).lower()
    if not norm:
        return "", "empty"
    if norm in _FILLER_EXACT or any(f in norm for f in _FILLER_SUB):
        return "", "filler"
    # ร้องไทยจริง ~ 3-8 พยางค์/วิ (~6-20 อักษร/วิ) — เกิน 28 อักษร/วิ ของเวลาที่มีเสียง = หลอน
    if len(norm) / max(voiced_sec, 0.5) > 28.0:
        return "", "too-dense"
    if len(norm) > 40 and compression_ratio(norm) > 2.6:
        return "", "repetitive"
    return t, ""


# ================================================================ โมเดล


class QwenAsr:
    """Qwen3-ASR ผ่าน transformers native (AutoModelForMultimodalLM)"""

    def __init__(self, path: Path, device: str = "cpu", dtype=None):
        import torch
        from transformers import AutoModelForMultimodalLM, AutoProcessor

        self.device = device
        self.dtype = dtype or torch.float32
        self.processor = AutoProcessor.from_pretrained(str(path))
        self.model = AutoModelForMultimodalLM.from_pretrained(str(path), dtype=self.dtype).to(device).eval()

    def transcribe_chunk(self, wav: np.ndarray, language: str | None) -> tuple[str, str | None]:
        """คืน (ข้อความดิบ, รหัสภาษา) ของเสียงก้อนเดียว (16 kHz mono)"""
        import torch

        dur = len(wav) / 16000.0
        inputs = self.processor.apply_transcription_request(audio=wav.astype(np.float32), language=language)
        inputs = inputs.to(self.device)
        for k, v in list(inputs.items()):  # ส่ง feature เสียงเป็น dtype ของโมเดล แต่ ids คง int
            if hasattr(v, "is_floating_point") and v.is_floating_point():
                inputs[k] = v.to(self.dtype)
        max_new = int(min(448, 24 + 12 * dur))
        with torch.inference_mode():
            out = self.model.generate(**inputs, max_new_tokens=max_new, do_sample=False, num_beams=1)
        seq = out.sequences if hasattr(out, "sequences") else out
        gen = seq[:, inputs["input_ids"].shape[1] :]
        parsed = self.processor.decode(gen, return_format="parsed")
        if isinstance(parsed, list):
            parsed = parsed[0] if parsed else {}
        text = str(parsed.get("transcription") or "")
        lang = parsed.get("language")
        code = language
        if lang:
            code = _NAME_TO_CODE.get(str(lang).strip().lower(), code)
        return text, code

    def transcribe(
        self,
        wav: np.ndarray,
        chunks: Sequence[tuple[int, int]],
        voiced: np.ndarray,
        language: str,
        progress: Callable[[float], None] | None = None,
        cancelled: Callable[[], bool] | None = None,
        pad_frames: int = 10,
    ) -> list[AsrSegment] | None:
        """ถอดทุกก้อน (<= 25-30 วิ) — คืน None ถ้าถูกยกเลิก"""
        target = ASR_TARGET_LANG.get(language, "th")
        n_frames = len(voiced)
        total = sum(b - a for a, b in chunks) or 1
        done = 0
        segs: list[AsrSegment] = []
        for a, b in chunks:
            if cancelled and cancelled():
                return None
            voiced_sec = float(voiced[a:b].sum()) * FRAME_SEC
            if voiced_sec < 0.6:  # แทบไม่มีเสียงร้อง -> ไม่ส่งเข้าโมเดล (กันหลอนตอนเงียบ)
                segs.append(AsrSegment(a, b, "", target, dropped="silent"))
            else:
                f0, f1 = max(0, a - pad_frames), min(n_frames, b + pad_frames)
                raw, code = self.transcribe_chunk(wav[f0 * HOP : f1 * HOP], target)
                text, why = clean_asr_text(raw, voiced_sec, target)
                segs.append(AsrSegment(a, b, text, code, raw=raw, dropped=why))
            done += b - a
            if progress:
                progress(done / total)
        return segs

    def close(self) -> None:
        release(self.model)
        self.model = None
        self.processor = None
