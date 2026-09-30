#!/usr/bin/env bash
# Daftarkan posting otomatis ke cron (Linux/macOS): jam 19:00, plus catch-up tiap jam 20-23
# (--catchup hanya jalan kalau slot 19:00 hari ini terlewat/gagal, mis. komputer mati atau 9Router down).
# Pakai: ./schedule.sh          Hapus: ./schedule.sh --remove
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
TAG="# ai-post-fb"
JOBS="0 19 * * * cd \"$DIR\" && \"$NODE\" post.js >> post.log 2>&1 $TAG
5 20-23 * * * cd \"$DIR\" && \"$NODE\" post.js --catchup >> post.log 2>&1 $TAG"

current="$(crontab -l 2>/dev/null | grep -vF "$TAG" || true)"
if [[ "${1:-}" == "--remove" ]]; then
  printf '%s\n' "$current" | crontab -
  echo "Jadwal dihapus."
else
  printf '%s\n%s\n' "$current" "$JOBS" | crontab -
  echo "Terjadwal setiap hari jam 19:00 (+ catch-up 20:05-23:05). Log: $DIR/post.log"
fi
