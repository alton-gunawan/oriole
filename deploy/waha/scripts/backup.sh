#!/usr/bin/env bash
# Backup WAHA session + media data. Session data lives in data/sessions —
# losing it means re-pairing the number with the phone. Run on a schedule
# (cron / launchd / OrbStack task) and copy backups/ off-machine.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p data/sessions data/media backups
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="backups/waha-${STAMP}.tar.gz"

tar -czf "$OUT" data/sessions data/media
echo "Backup written: $OUT ($(du -h "$OUT" | cut -f1))"

# Keep the last 7 backups, drop older ones.
ls -1t backups/waha-*.tar.gz 2>/dev/null | tail -n +8 | xargs -r rm -f
