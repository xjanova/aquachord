"""โหนด AquaChordTranscribe — ห่อ pipeline ใน aquachord_pipeline ให้ ComfyUI เรียกได้

อินเทอร์เฟซตรงตาม docs/09-GPU-TRANSCRIBE.md §1.1 (aixman validate กราฟกับ schema นี้)
"""
import json

MODES = ["open", "sheetsage2"]
LANGUAGES = ["th", "auto", "en"]


class AquaChordTranscribe:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO",),
                "mode": (MODES, {"default": "open"}),
                "language": (LANGUAGES, {"default": "th"}),
                "lyrics": ("STRING", {"multiline": True, "default": ""}),
                "options": ("STRING", {"multiline": False, "default": "{}"}),
            },
            "optional": {
                "sheetsage_encoder": ("AUDIO_ENCODER",),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("result_json",)
    FUNCTION = "transcribe"
    OUTPUT_NODE = True
    CATEGORY = "audio/aquachord"
    DESCRIPTION = "Transcribe chords, beats, Thai lyrics and melody into AquaChord TranscriptionResult JSON."

    def transcribe(self, audio, mode, language, lyrics, options, sheetsage_encoder=None):
        # import ช้า ๆ — ให้ ComfyUI โหลดรายการโหนดได้แม้ dependency หนักยังไม่พร้อม
        from .aquachord_pipeline.runner import run_from_comfy

        try:
            opts = json.loads(options or "{}")
            if not isinstance(opts, dict):
                opts = {}
        except (ValueError, TypeError):
            opts = {}
        result = run_from_comfy(
            audio=audio,
            mode=mode,
            language=language,
            lyrics=lyrics or "",
            options=opts,
            sheetsage_encoder=sheetsage_encoder,
        )
        text = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
        return {"ui": {"text": (text,)}, "result": (text,)}


NODE_CLASS_MAPPINGS = {"AquaChordTranscribe": AquaChordTranscribe}
NODE_DISPLAY_NAME_MAPPINGS = {"AquaChordTranscribe": "AquaChord Transcribe (chords · Thai lyrics · melody)"}
