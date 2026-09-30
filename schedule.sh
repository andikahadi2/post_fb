#!/usr/bin/env bash
# Daftarkan posting otomatis ke cron (Linux/macOS), jam 08:00 dan 19:00.
# Pakai: ./schedule.sh          Hapus: ./schedule.sh --remove
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
TAG="# ai-post-fb"
JOBS="0 8,19 * * * cd \"$DIR\" && \"$NODE\" post.js >> post.log 2>&1 $TAG"

current="$(crontab -l 2>/dev/null | grep -vF "$TAG" || true)"
if [[ "${1:-}" == "--remove" ]]; then
  printf '%s\n' "$current" | crontab -
  echo "Jadwal dihapus."
else
  printf '%s\n%s\n' "$current" "$JOBS" | crontab -
  echo "Terjadwal jam 08:00 & 19:00. Log: $DIR/post.log"
fi
