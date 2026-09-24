"""ประกอบ TranscriptionResult v1 (docs/09 §4) + ปัดทศนิยม 3 ตำแหน่ง + ตรวจ/ซ่อมให้ผ่านกติกา

sanitize() ไม่โยน error: ซ่อมเท่าที่ซ่อมได้ (เรียง, ตัดซ้อน, label ผิด grammar → null) แล้วคืนรายการปัญหา
ให้ runner ใส่ใน warnings[] — ผลต้องใช้ได้เสมอแม้บางขั้นให้ข้อมูลแปลก ๆ
"""
from __future__ import annotations

import math

from .chords import is_valid_key, is_valid_label

FORMAT = "aquachord-transcription"
VERSION = 1
NODE_ID = "comfyui-aquachord@0.1.0"
MODEL_KEYS = ("separation", "beats", "chords", "key", "asr", "align", "pitch")


def _num(x, nd=3):
    """float → ปัด 3 ตำแหน่ง; NaN/inf → None"""
    if x is None:
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    r = round(f, nd)
    return 0.0 if r == 0 else r


def _time_list(xs, duration):
    out = []
    for x in xs or []:
        v = _num(x)
        if v is None or v < 0 or (duration is not None and v > duration + 1e-3):
            continue
        if out and v <= out[-1]:
            continue
        out.append(v)
    return out


def empty_result(mode: str) -> dict:
    return {
        "format": FORMAT,
        "version": VERSION,
        "mode": mode,
        "engine": {"node": NODE_ID, "models": {}},
        "durationSec": 0.0,
        "tempo": None,
        "timeSig": [4, 4],
        "beats": [],
        "downbeats": [],
        "key": None,
        "chords": [],
        "sections": [],
        "lyrics": None,
        "melody": None,
        "warnings": [],
        "timings": {},
    }


def sanitize(res: dict) -> list[str]:
    """ซ่อม res ในที่ (in place) ตามกติกา §4 → คืนรายการปัญหาที่พบ (ภาษาอังกฤษสั้น ๆ)"""
    problems: list[str] = []
    dur = _num(res.get("durationSec")) or 0.0
    res["durationSec"] = dur

    res["tempo"] = _num(res.get("tempo"), 1) if res.get("tempo") else None
    ts = res.get("timeSig")
    if not (isinstance(ts, (list, tuple)) and len(ts) == 2 and all(isinstance(v, int) and v > 0 for v in ts)):
        res["timeSig"] = [4, 4]
    else:
        res["timeSig"] = [int(ts[0]), int(ts[1])]

    res["beats"] = _time_list(res.get("beats"), dur)
    res["downbeats"] = _time_list(res.get("downbeats"), dur)

    k = res.get("key")
    if k is not None and not is_valid_key(k):
        problems.append(f"key {k!r} does not match grammar; dropped")
        res["key"] = None

    chords = []
    for c in sorted(res.get("chords") or [], key=lambda c: (_num(c.get("t0")) or 0.0)):
        t0, t1 = _num(c.get("t0")), _num(c.get("t1"))
        if t0 is None or t1 is None:
            continue
        t0 = max(0.0, t0)
        t1 = min(dur, t1) if dur else t1
        if chords and t0 < chords[-1]["t1"]:
            t0 = chords[-1]["t1"]
        if t1 <= t0:
            continue
        label = c.get("label")
        if label is not None and not is_valid_label(label):
            problems.append(f"chord label {label!r} does not match grammar; wrote N.C.")
            label = None
        item = {"t0": t0, "t1": t1, "label": label}
        conf = _num(c.get("conf"))
        if conf is not None:
            item["conf"] = min(1.0, max(0.0, conf))
        if chords and chords[-1]["label"] == label and chords[-1]["t1"] == t0:
            chords[-1]["t1"] = t1
            continue
        chords.append(item)
    res["chords"] = chords

    secs = []
    for s in sorted(res.get("sections") or [], key=lambda s: (_num(s.get("t")) or 0.0)):
        t = _num(s.get("t"))
        lab = s.get("label")
        if t is None or t < 0 or not isinstance(lab, str) or not lab:
            continue
        secs.append({"t": t, "label": lab[:40]})
    res["sections"] = secs

    mel = res.get("melody")
    if mel is not None:
        notes = []
        for n in sorted(mel.get("notes") or [], key=lambda n: (_num(n.get("t0")) or 0.0)):
            t0, t1 = _num(n.get("t0")), _num(n.get("t1"))
            try:
                p = int(n.get("pitch"))
            except (TypeError, ValueError):
                continue
            if t0 is None or t1 is None or not 0 <= p <= 127:
                continue
            if notes and t0 < notes[-1]["t1"]:
                notes[-1]["t1"] = t0
                if notes[-1]["t1"] <= notes[-1]["t0"]:
                    notes.pop()
            if t1 <= t0:
                continue
            conf = _num(n.get("conf"))
            notes.append({"t0": t0, "t1": t1, "pitch": p, "conf": None if conf is None else min(1.0, max(0.0, conf))})
        res["melody"] = {"source": mel.get("source", "fcpe"), "notes": notes}

    lyr = res.get("lyrics")
    if lyr is not None:
        if not isinstance(lyr, dict) or not isinstance(lyr.get("lines"), list):
            problems.append("lyrics result had an unexpected shape; dropped")
            res["lyrics"] = None
        else:
            lines = []
            for ln in lyr["lines"]:
                if not isinstance(ln, dict):
                    continue
                t0, t1 = _num(ln.get("t0")), _num(ln.get("t1"))
                if t0 is None or t1 is None or t1 < t0:
                    continue
                syls = []
                for s in ln.get("syllables") or []:
                    if not isinstance(s, dict):
                        continue
                    s0, s1 = _num(s.get("t0")), _num(s.get("t1"))
                    if s0 is None or s1 is None or s1 < s0:
                        continue
                    syls.append({"t0": s0, "t1": s1, "text": str(s.get("text", ""))})
                syls.sort(key=lambda s: s["t0"])
                lines.append({"t0": t0, "t1": t1, "text": str(ln.get("text", "")), "syllables": syls})
            lines.sort(key=lambda l: l["t0"])
            src = lyr.get("source")
            res["lyrics"] = {
                "source": src if src in ("user", "asr") else "asr",
                "language": str(lyr.get("language") or "th"),
                "text": str(lyr.get("text") or ""),
                "lines": lines,
            }

    res["warnings"] = [str(w)[:300] for w in (res.get("warnings") or [])]
    res["timings"] = {str(k): _num(v) for k, v in (res.get("timings") or {}).items() if _num(v) is not None}
    models = res.get("engine", {}).get("models", {})
    res["engine"] = {"node": NODE_ID, "models": {k: str(v) for k, v in models.items() if v}}
    return problems


def validate(res: dict) -> list[str]:
    """ตรวจอย่างเดียว (ใช้ใน test/self-check): คืนรายการที่ผิดกติกา §4 — ว่าง = ผ่าน"""
    errs = []
    if res.get("format") != FORMAT or res.get("version") != VERSION:
        errs.append("format/version")
    if res.get("mode") not in ("open", "sheetsage2"):
        errs.append("mode")
    prev = -1.0
    for c in res.get("chords", []):
        if c["t0"] < prev - 1e-9 or c["t1"] <= c["t0"]:
            errs.append(f"chord order/overlap at {c['t0']}")
        prev = c["t1"]
        if c["label"] is not None and not is_valid_label(c["label"]):
            errs.append(f"chord label {c['label']}")
    for name in ("beats", "downbeats"):
        xs = res.get(name, [])
        if any(b <= a for a, b in zip(xs, xs[1:])):
            errs.append(f"{name} not increasing")
    if res.get("key") is not None and not is_valid_key(res["key"]):
        errs.append("key")
    mel = res.get("melody")
    if mel:
        prev = -1.0
        for n in mel["notes"]:
            if n["t0"] < prev - 1e-9 or n["t1"] <= n["t0"] or not 0 <= n["pitch"] <= 127:
                errs.append(f"note at {n['t0']}")
            prev = n["t1"]

    def _chk(o, path="$"):
        if isinstance(o, float):
            if not math.isfinite(o) or round(o, 3) != o:
                errs.append(f"float {path}")
        elif isinstance(o, dict):
            for k, v in o.items():
                _chk(v, f"{path}.{k}")
        elif isinstance(o, (list, tuple)):
            for i, v in enumerate(o):
                _chk(v, f"{path}[{i}]")
    _chk(res)
    return errs
