#!/usr/bin/env bash
# Undo provision.sh for a DEBUG (test-only) build, without a factory reset.
#
# A release build can't be removed this way: Android only lets `dpm remove-active-admin`
# remove test-only admins. To remove a release build, factory reset the phone from
# Settings (docs/pixel.md, "Returning the phone to normal").
#
# Usage: android/scripts/unprovision.sh [--serial S] [--keep-app] [--dry-run] [--yes]
#
#   --keep-app   release device owner but leave the app installed
#   --serial S   the phone's adb serial, when more than one device is connected
#   --dry-run    check, change nothing, print the commands it would run
#   --yes        don't ask first
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

KEEP_APP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --keep-app) KEEP_APP=1 ;;
    --serial) SERIAL="${2:?--serial needs a value}"; shift ;;
    --dry-run) DRY_RUN=1 ;;
    --yes) ASSUME_YES=1 ;;
    -h | --help) usage; exit 0 ;;
    *) die "Unknown argument $1" "Run with --help to see the options." ;;
  esac
  shift
done

find_adb
pick_device
phone_summary

ash pm path "$PKG" | contains 'package:' || die "Belay isn't installed on this phone."
if ! ash dumpsys package "$PKG" | matches '^[[:space:]]+(flags|pkgFlags)=.*TEST_ONLY'; then
  die "The installed Belay is a release build, not a test-only debug build." \
    "Only a factory reset removes a release device owner: see docs/pixel.md."
fi

confirm "Release Belay as device owner$([ "$KEEP_APP" = 0 ] && printf ' and uninstall it')?" ||
  die "Nothing changed: you said no."

if is_belay_owner; then
  say "Releasing device owner..."
  run adb shell dpm remove-active-admin "$ADMIN"
else
  say "Belay isn't the device owner (already released)."
fi
run_quiet adb shell dumpsys deviceidle whitelist "-$PKG" || true
if [ "$KEEP_APP" = 0 ]; then
  say "Uninstalling..."
  run adb uninstall "$PKG"
fi

if [ "$DRY_RUN" = 0 ]; then
  say "Result:"
  owners_text | sed 's/^/  owners: /'
  if ash pm path "$PKG" | contains 'package:'; then info "Belay is still installed."; else info "Belay is uninstalled."; fi
fi
