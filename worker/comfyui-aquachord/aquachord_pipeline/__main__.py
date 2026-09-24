"""CLI ทดสอบนอก ComfyUI — รันจากโฟลเดอร์ worker/comfyui-aquachord:

  python -m aquachord_pipeline song.mp3 --lyrics lyrics.txt --mode open --language th --out result.json
  python -m aquachord_pipeline song.mp3 --stages separate beats chords --device cpu
  python -m aquachord_pipeline song.mp3 --mode sheetsage2 --sheetsage-weights sheetsage2_bf16.safetensors

ที่เก็บโมเดล: env AQUACHORD_MODELS_DIR (ไม่ตั้ง = ./models)
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path

from .runner import ALL_STAGES, LANGUAGES, MODES, PipelineError, run_file


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m aquachord_pipeline",
                                 description="AquaChord transcription (chords, beats, Thai lyrics, melody)")
    ap.add_argument("audio", help="audio file (wav/flac/ogg/mp3)")
    ap.add_argument("--lyrics", help="UTF-8 text file with the song lyrics (empty = ASR)")
    ap.add_argument("--mode", choices=MODES, default="open")
    ap.add_argument("--language", choices=LANGUAGES, default="th")
    ap.add_argument("--out", help="write TranscriptionResult JSON here (default: stdout)")
    ap.add_argument("--device", help="cpu | cuda | cuda:N (default: auto)")
    ap.add_argument("--stages", nargs="+", choices=ALL_STAGES, help="subset of stages (default: all)")
    ap.add_argument("--max-seconds", type=float, default=600.0)
    ap.add_argument("--chord-source", choices=("mix", "accompaniment"), help="audio used for chord recognition")
    ap.add_argument("--sheetsage-weights", help="sheetsage2_bf16.safetensors (mode sheetsage2 only)")
    ap.add_argument("--comfy-root", default=r"D:\Temp\audio-in\comfy036",
                    help="ComfyUI checkout used to load SheetSage2 (mode sheetsage2 only)")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s", stream=sys.stderr)
    lyrics = ""
    if a.lyrics:
        try:
            lyrics = Path(a.lyrics).read_text(encoding="utf-8-sig")
        except (OSError, UnicodeDecodeError) as e:
            print(f"error: cannot read lyrics file ({type(e).__name__})", file=sys.stderr)
            return 2
    options = {"maxSeconds": a.max_seconds}
    if a.stages:
        options["stages"] = a.stages
    if a.chord_source:
        options["chordSource"] = a.chord_source

    encoder = None
    if a.mode == "sheetsage2" and a.sheetsage_weights:
        from .sheetsage import load_encoder_standalone
        try:
            encoder = load_encoder_standalone(a.sheetsage_weights, a.comfy_root)
        except Exception as e:  # noqa: BLE001
            print(f"warning: could not load SheetSage2 ({type(e).__name__}); open models will be used",
                  file=sys.stderr)

    t0 = time.time()
    try:
        res = run_file(a.audio, mode=a.mode, language=a.language, lyrics=lyrics, options=options,
                       device=a.device, sheetsage_encoder=encoder)
    except PipelineError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    text = json.dumps(res, ensure_ascii=False, indent=1)
    if a.out:
        out = Path(a.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
    else:
        sys.stdout.reconfigure(encoding="utf-8")
        print(text)

    from .runner import run as _run
    ctx = getattr(_run, "last_ctx", None)
    summary = {
        "seconds": round(time.time() - t0, 1),
        "timings": res.get("timings"),
        "vramPeakMB": getattr(ctx, "vram_peak_mb", None),
        "key": res.get("key"), "tempo": res.get("tempo"), "timeSig": res.get("timeSig"),
        "chords": len(res.get("chords") or []), "beats": len(res.get("beats") or []),
        "melodyNotes": len((res.get("melody") or {}).get("notes") or []),
        "lyricsLines": len((res.get("lyrics") or {}).get("lines") or []),
        "warnings": res.get("warnings"),
    }
    print(json.dumps(summary, ensure_ascii=False), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
