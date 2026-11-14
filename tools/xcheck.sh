#!/bin/sh
# The web page's protocol code (web/src/lib) against the firmware in the host simulator: frames built by the web
# code are played into the simulator, and the device's replies are parsed back with it.  From the repo root:
#   tools/xcheck.sh
set -e
cd "$(dirname "$0")/.."
out=$(pwd)/app/build/host
uv run base/tools/build.py app --host >/dev/null 2>&1
(cd web && npx vite-node scripts/xcheck.ts gen "$out/xcheck.txt" "$out/xcheck.syx")
app/build/host/soundbrd_host "$out/xcheck.txt" "$out" | grep -v '^  ok'
(cd web && npx vite-node scripts/xcheck.ts verify "$out/xcheck.syx" "$out/xcheck.txt.icon")
