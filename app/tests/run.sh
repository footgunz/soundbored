#!/bin/sh
# soundbored's host-simulator tests: build, expand the @-directives (tools/sbtool.py), run.  From the repo root:
#   app/tests/run.sh
set -e
cd "$(dirname "$0")/../.."
uv run base/tools/build.py app --host >/dev/null 2>&1
out=app/build/host
fails=0
for t in app/tests/sounds.txt; do
    uv run tools/sbtool.py expand "$t" "$out/$(basename "$t")"
    app/build/host/soundbrd_host "$out/$(basename "$t")" "$out" || fails=1
done
exit $fails
