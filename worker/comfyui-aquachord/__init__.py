"""ComfyUI-AquaChord — ถอดคอร์ด จังหวะ เนื้อร้องไทย และทำนองจากไฟล์เสียงในโหนดเดียว

สัญญาของโหนด (ชื่อ ชนิด ค่า) อยู่ที่ docs/09-GPU-TRANSCRIBE.md §1.1 — aixman สร้างกราฟจากสัญญานี้
ห้ามเปลี่ยนชื่อ input หรือชนิดโดยไม่อัปเดตเอกสารและ catalog ของ aixman พร้อมกัน
"""
from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
