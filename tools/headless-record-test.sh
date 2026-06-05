#!/usr/bin/env bash
# Prove the note_detect recording pipeline (browser capture -> WAV) with no
# human and no guitar. See headless-record-test.js for the why.
#
#   tools/headless-record-test.sh            # against http://localhost:8000
#   SLOP_URL=http://host:8000 tools/headless-record-test.sh
#
# Needs Playwright + Chromium. We don't add it to the plugin's deps (keeps the
# shipped plugin lean); this resolves an install in priority order and prints
# the one command to create one if none is found.
set -euo pipefail
cd "$(dirname "$0")"

FAKE_WAV="${FAKE_WAV:-/tmp/fakemic.wav}"
export FAKE_WAV SLOP_URL="${SLOP_URL:-http://localhost:8000}"

# 1. Fake-mic WAV (12s 110Hz tone, 48k/16-bit) — regenerate if absent.
if [ ! -f "$FAKE_WAV" ]; then
    command -v ffmpeg >/dev/null || { echo "need ffmpeg to make $FAKE_WAV"; exit 2; }
    ffmpeg -y -f lavfi -i "sine=frequency=110:duration=12" -ar 48000 -ac 2 -sample_fmt s16 "$FAKE_WAV" >/dev/null 2>&1
fi

# 2. Resolve a Playwright install with the require() path; first hit wins.
for dir in "$PWD/.headless" "$HOME/src/slopsmith/node_modules/.." /tmp/headless-rec; do
    if [ -d "$dir/node_modules/playwright" ]; then export NODE_PATH="$dir/node_modules"; break; fi
done
if [ -z "${NODE_PATH:-}" ]; then
    cat <<EOF
Playwright not found. Create a local install once (kept out of the plugin):
    mkdir -p "$PWD/.headless" && cd "$PWD/.headless" \\
      && npm init -y >/dev/null && npm i playwright && npx playwright install chromium
Then re-run this script.
EOF
    exit 3
fi

echo "Playwright: $NODE_PATH   URL: $SLOP_URL   mic: $FAKE_WAV"
exec node headless-record-test.js
