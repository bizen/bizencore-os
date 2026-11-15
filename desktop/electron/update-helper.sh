#!/bin/sh
# The helper lives outside the running bundle and swaps only after its owner exits.
set -eu
unset ELECTRON_RUN_AS_NODE NODE_OPTIONS
job=$1
installed=$2
owner=$3
temporary=$4
tempRoot=${TMPDIR:-/tmp}
tempRoot=${tempRoot%/}
case "$temporary" in "$tempRoot"/bizencore-update-??????) ;; *) exit 2 ;; esac
[ -d "$temporary" ] && [ ! -L "$temporary" ] || exit 2
parent=$(/usr/bin/dirname "$installed")
case "$job" in "$parent"/.bizencore-update-??????) ;; *) exit 2 ;; esac
case "$installed" in *.app) ;; *) exit 2 ;; esac
case "$owner" in ''|*[!0-9]*) exit 2 ;; esac
[ -d "$job" ] && [ ! -L "$job" ] && [ -d "$installed" ] && [ ! -L "$installed" ] || exit 2
[ -d "$job/new.app" ] && [ ! -L "$job/new.app" ] && [ ! -e "$job/previous.app" ] || exit 2
exec >> "$job/install.log" 2>&1
echo "helper-armed owner=$owner"
: > "$job/armed"
i=0
while /bin/kill -0 "$owner" 2>/dev/null; do
  i=$((i + 1)); [ "$i" -lt 120 ] || { echo "owner-exit-timeout"; exit 3; }
  /bin/sleep 1
done
[ -d "$job" ] && [ -d "$job/new.app" ] && [ ! -e "$job/cancelled" ] || exit 3
echo "owner-exited; swapping"
/bin/mv "$installed" "$job/previous.app"
if ! /bin/mv "$job/new.app" "$installed"; then
  [ -e "$installed" ] || /bin/mv "$job/previous.app" "$installed"
  "$installed/Contents/MacOS/bizencore terminal" --bizencore-update-rolled-back >> "$job/launch.log" 2>&1 &
  /bin/rm -rf "$temporary" "$job/new.app"
  exit 4
fi
"$installed/Contents/MacOS/bizencore terminal" "--bizencore-update=$(/usr/bin/basename "$job")" >> "$job/launch.log" 2>&1 &
child=$!
i=0
while [ "$i" -lt 60 ]; do
  if [ -f "$job/ready" ]; then
    echo "new-renderer-ready"
    # Startup acknowledged the new renderer; only now discard the previous bundle.
    /bin/rm -rf "$temporary" "$job"
    exit 0
  fi
  /bin/kill -0 "$child" 2>/dev/null || break
  i=$((i + 1)); /bin/sleep 1
done
echo "new-launch-failed; rolling-back"
# Kill only the process launched by this helper, never another installed copy.
if [ "$(/bin/ps -p "$child" -o ppid= | /usr/bin/tr -d ' ')" = "$$" ]; then
  /bin/kill -TERM "$child" 2>/dev/null || true
  /bin/sleep 2
  if [ "$(/bin/ps -p "$child" -o ppid= | /usr/bin/tr -d ' ')" = "$$" ]; then /bin/kill -KILL "$child" 2>/dev/null || true; fi
fi
wait "$child" 2>/dev/null || true
/bin/mv "$installed" "$job/failed.app"
/bin/mv "$job/previous.app" "$installed"
: > "$job/rolled-back"
"$installed/Contents/MacOS/bizencore terminal" --bizencore-update-rolled-back >> "$job/launch.log" 2>&1 &
/bin/rm -rf "$temporary" "$job/failed.app"
exit 5
