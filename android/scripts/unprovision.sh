#!/usr/bin/env bash
# Undo provision.sh for a DEBUG (test-only) build, without a factory reset.
#
# A release build can't be removed this way: Android only lets `dpm remove-active-admin`
# remove test-only admins. To remove a release build, factory reset the phone from
# Settings (docs/pixel.md, "Returning the phone to normal").
#
# First it stops the debug build's texts test (docs/phase5-checklist.md, section 12), and
# waits for its answer, while Belay is still the device owner: that takes Google Messages'
# archival setting back and the restricted-messages app-op with it, which releasing or
# uninstalling doesn't (docs/platform-notes.md T8).
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

# The texts test (T8) off, with the debug build's adb switch, before device owner goes: its stop
# takes Google Messages' configuration back with setApplicationRestrictions, which is how Android's
# archival tracker hears of it and puts Belay's restricted-messages app-op back to default.
# Releasing device owner drops the configuration without telling the tracker, and uninstalling
# tells it nothing either, so the next install of family.brooker.belay, a release build too,
# would be allowed that app-op again (platform notes T8). `am broadcast` waits for the switch's
# answer (a stopped Belay gets it too).
#
# texts_test COMMAND: the switch's answer to `--es command COMMAND`: "ok <its line>" (RESULT_OK),
# "none" (result=0: nobody set a result), or "failed <what adb printed>" (its 1, or an adb error).
texts_test() {
  local out result
  out="$(adb shell am broadcast --include-stopped-packages -a "$PKG.DEBUG_ARCHIVAL" -n "$PKG/.DebugArchivalReceiver" --es command "$1" 2>&1 | tr -d '\r')" || true
  result="$(sed -n 's/^Broadcast completed: //p' <<<"$out")"
  case "$result" in
    'result=-1, data="'*) printf 'ok %s\n' "$(sed 's/^result=-1, data="//; s/"$//' <<<"$result")" ;;
    'result=0') echo none ;;
    *) printf 'failed %s\n' "$out" ;;
  esac
}

# result=0 is what a debug build from before the test answers (it has no switch), but also what
# Android answers when the switch's process dies before it finishes its answer (goAsync), so the
# stop may not have happened (the second bypass audit's C1). Only when `status` gets no answer
# either is there no switch; when it answers, the test must be off with Google Messages naming no
# one for Belay, or nothing else changes.
stop_texts_test() {
  local answer status again="Try again in a minute. If it never stops, a factory reset takes everything back (docs/pixel.md)."
  say "Stopping the texts test, if it's on..."
  if [ "$DRY_RUN" = 1 ]; then
    run adb shell am broadcast --include-stopped-packages -a "$PKG.DEBUG_ARCHIVAL" -n "$PKG/.DebugArchivalReceiver" --es command stop
    return 0
  fi
  answer="$(texts_test stop)"
  case "$answer" in
    ok\ *) info "${answer#ok }" ;;
    none)
      status="$(texts_test status)"
      case "$status" in
        none) warn "The texts test's switch didn't answer: a debug build from before the test has none, so there's nothing to stop." ;;
        'ok off'*'messages_archival: not set'* | 'ok off'*"Belay isn't the device owner"*)
          warn "The texts test's switch didn't answer the stop, but it says the test is off and Google Messages names no one for Belay:"
          info "${status#ok }"
          ;;
        ok\ *) die "The texts test's switch didn't answer the stop, and it may still be on, so nothing else changed." "${status#ok }" "$again" ;;
        *) die "The texts test's switch didn't answer the stop or say how it is, so nothing else changed." "${status#failed }" "$again" ;;
      esac
      ;;
    *) die "The texts test didn't stop, so nothing else changed." "${answer#failed }" "$again" ;;
  esac
}

# A stop denies READ_SMS by policy next, which restarts Belay (platform notes L7): wait for it
# while Belay is still the device owner, at most half a minute.
wait_for_read_sms() {
  [ "$DRY_RUN" = 1 ] && return 0
  local _
  for _ in $(seq 1 30); do
    ash dumpsys package "$PKG" | contains 'android.permission.READ_SMS: granted=true' || return 0
    sleep 1
  done
  if [ "$KEEP_APP" = 1 ]; then warn "Belay still holds READ_SMS: it keeps it until it's uninstalled."; fi
}

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

stop_texts_test
if is_belay_owner; then
  wait_for_read_sms
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
