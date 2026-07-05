#!/bin/bash
# ============================================================
#  AquaChord — deploy script
#  ใช้บนเซิร์ฟเวอร์:  cd <repo>/_src && bash deploy/deploy.sh [branch]
#  ทำ: git pull → rsync site/ → public_html → เขียน version.json
#       → บัมป์ service-worker cache อัตโนมัติ (ไม่ต้องแก้มือ) → ตั้ง perms
#  ปลอดภัย: ไม่แตะ private/config.php (อยู่นอก webroot) และคง cgi-bin
# ============================================================
set -euo pipefail

BRANCH="${1:-main}"
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN_DIR="/home/admin/domains/aquachord.online"
WEB="$DOMAIN_DIR/public_html"
ORIGIN_IP="123.253.62.251"

cd "$SRC_DIR"
echo "→ อัปเดตซอร์สจาก origin/$BRANCH ..."
git fetch --quiet origin "$BRANCH"
git checkout --quiet "$BRANCH"
git pull --ff-only --quiet origin "$BRANCH"

VER="$(tr -d '[:space:]' < VERSION)"
SHA="$(git rev-parse --short HEAD)"
TS="$(date +%s)000"

echo "→ sync site/ → public_html (คง cgi-bin, ลบไฟล์เก่าที่ไม่มีใน repo) ..."
rsync -a --delete --exclude 'cgi-bin/' "$SRC_DIR/site/" "$WEB/"

# version.json — แหล่งเวอร์ชัน runtime (frontend + API อ่านตัวนี้)
printf '{"version":"%s","sha":"%s","builtAt":%s}\n' "$VER" "$SHA" "$TS" > "$WEB/version.json"

# บัมป์ cache ของ service worker อัตโนมัติทุก deploy → เครื่องผู้ใช้โหลดของใหม่เอง
sed -i "s/const CACHE = '[^']*';/const CACHE = 'aquachord-$VER-$SHA';/" "$WEB/sw.js"

echo "→ ตั้งสิทธิ์ไฟล์ ..."
find "$WEB" -type d -exec chmod 755 {} \;
find "$WEB" -type f -exec chmod 644 {} \;

echo "✓ deployed AquaChord v$VER ($SHA)"
echo -n "  live version.json: "
curl -s --resolve "aquachord.online:443:$ORIGIN_IP" -k https://aquachord.online/version.json || true
echo
echo -n "  api health: "
curl -s --resolve "aquachord.online:443:$ORIGIN_IP" -k https://aquachord.online/api/health || true
echo
