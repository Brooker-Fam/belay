#!/usr/bin/env bash
# Make a freshly reset Android phone a Belay-managed phone, over adb.
#
# Before running it:
#   1. Factory reset the phone. In the setup wizard, skip every account (no Google account).
#   2. Settings > About phone > tap "Build number" 7 times, then
#      Settings > System > Developer options > turn on "USB debugging".
#   3. Plug the phone in and tap "Allow" on the USB debugging prompt.
#
# Usage: android/scripts/provision.sh [options] [APK]
#
#   APK          the agent to install. Default: the release build,
#                android/app/build/outputs/apk/release/app-release.apk (build it with
#                android/scripts/build-release.sh).
#   --debug      install the debug build instead (test-only: unprovision.sh can undo it)
#   --serial S   the phone's adb serial, when more than one device is connected
#   --server URL connect Belay to the family's Belay server at the end (needs --code):
#                its address, like https://belay.example.org
#   --code CODE  the one-time code from the server's "Add a phone" page
#   --dry-run    run every check, change nothing, and print the commands it would run
#   --yes        don't ask before making Belay the device owner
#   --no-reboot  skip the restart at the end (see below)
#   -h, --help   this text
#
# What it does, in order: checks the phone (connected, no accounts, a single user, no
# device owner yet), checks the APK, installs it, runs
# `dpm set-device-owner family.brooker.belay/.AdminReceiver`, then grants what only adb
# can grant, so later phases never need another factory reset: usage access and the
# battery-optimization exemption. Then it restarts the phone once: Android only locks
# the managed notice's notification settings at boot, and the restart checks that Belay
# comes back by itself. With --server and --code, it last connects Belay to the family's
# server, through a receiver only the adb shell can reach (the phone must be online).
# Run again on a provisioned phone, it installs the APK as an update, grants again, and
# connects again if asked.
#
# A release build that becomes device owner can only be removed by a factory reset.
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

APK=""
USE_DEBUG=0
REBOOT=1
SERVER=""
CODE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --debug) USE_DEBUG=1 ;;
    --no-reboot) REBOOT=0 ;;
    --serial) SERIAL="${2:?--serial needs a value}"; shift ;;
    --server) SERVER="${2:?--server needs a value}"; shift ;;
    --code) CODE="${2:?--code needs a value}"; shift ;;
    --dry-run) DRY_RUN=1 ;;
    --yes) ASSUME_YES=1 ;;
    -h | --help) usage; exit 0 ;;
    -*) die "Unknown option $1" "Run with --help to see the options." ;;
    *) APK="$1" ;;
  esac
  shift
done
if [ -z "$APK" ]; then
  if [ "$USE_DEBUG" = 1 ]; then
    APK="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
  else
    APK="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
  fi
fi

# Everything else is the plan, provision-plan.json: the checks, the steps in order and what
# each says. The setup kit (setup-kit/) runs the same file, so the two can't drift apart.
plan_load
plan_set apk "$APK"
plan_set server "$SERVER"
plan_set code "$CODE"
plan_set dry_run "$([ "$DRY_RUN" = 1 ] && echo 1 || true)"
plan_set assume_yes "$([ "$ASSUME_YES" = 1 ] && echo 1 || true)"
plan_set reboot "$([ "$REBOOT" = 1 ] && echo 1 || true)"
plan_run steps
