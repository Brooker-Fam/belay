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

# The receiver checks both again. These checks keep the values safe to pass through
# `adb shell`, which hands them to the phone's shell.
if [ -n "$SERVER$CODE" ]; then
  [ -n "$SERVER" ] && [ -n "$CODE" ] || die "--server and --code go together." "Run with --help to see the options."
  [[ "$SERVER" =~ ^(https?://)?[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]] ||
    die "--server $SERVER doesn't look like a server address." "It should look like https://belay.example.org"
  [[ "$CODE" =~ ^[A-Za-z0-9\ -]{8,12}$ ]] ||
    die "--code $CODE doesn't look like a code." "A code has 8 letters and numbers, like 7KQ2M9XA."
fi

if [ "$DRY_RUN" = 1 ]; then say "Belay: provisioning (dry run: nothing on the phone changes)"; else say "Belay: provisioning"; fi

# 1. The APK.
[ -f "$APK" ] || die "No APK at $APK" \
  "Build it first: android/scripts/build-release.sh (or ./gradlew :app:assembleDebug with --debug)."
pkg="$(apk_package "$APK" || true)"
if [ -n "$pkg" ] && [ "$pkg" != "$PKG" ]; then
  die "$APK is $pkg, not $PKG."
fi
TEST_ONLY=unknown
if apk_is_test_only "$APK"; then TEST_ONLY=yes; else [ $? = 1 ] && TEST_ONLY=no; fi
signer="$(apk_signer "$APK" || true)"
if [ -z "$(build_tool apksigner)" ]; then
  warn "apksigner not found (Android SDK build-tools): can't check how the APK is signed."
elif [ -z "${signer%%|*}" ]; then
  die "$APK isn't signed." "A release build needs the release key: see docs/signing.md."
fi
say "APK: $APK"
info "test-only (debug) build: $TEST_ONLY"
[ -n "$signer" ] && info "signed by: ${signer#*|}" && info "certificate SHA-256: ${signer%%|*}"
if [ "$TEST_ONLY" = no ] && [[ "$signer" == *"CN=Android Debug"* ]]; then
  die "This release APK is signed with a debug key." \
    "A device owner can only ever be updated with the key it was installed with." \
    "Sign release builds with the family's release key: see docs/signing.md."
fi

# 2. The phone.
find_adb
pick_device
phone_summary
if [ "${PHONE_SDK:-0}" -lt 31 ] 2>/dev/null; then
  die "Belay needs Android 12 (API 31) or newer; this phone has API $PHONE_SDK."
fi

UPDATE=0
if is_belay_owner; then
  UPDATE=1
  say "Belay is already the device owner: installing the APK as an update."
elif has_owner; then
  die "This phone already has a device owner or profile owner:" "$(owners_text)" \
    "Factory reset it first (Settings > System > Reset options > Erase all data)."
else
  accounts="$(ash dumpsys account | grep -c 'Account {' || true)"
  if [ "$accounts" != 0 ]; then
    # Only the account types: names are email addresses.
    die "The phone has $accounts account(s) on it:" "$(account_types)" \
      "Android only lets an app become device owner on a phone with no accounts." \
      "Factory reset, and skip every account in the setup wizard. Add the parent-owned" \
      "Google account after provisioning (docs/pixel.md)."
  fi
  # Android 17's own Parental Controls keep their PIN in a hidden supervising profile, which
  # `cmd user list -v` shows as "type=profile.SUPERVISING" (AOSP 17
  # UserManagerServiceShellCommand), and which makes `dpm set-device-owner` refuse.
  if ash cmd user list -v 2>/dev/null | matches 'type=profile\.SUPERVISING'; then
    die "Android's own Parental Controls are set up on this phone. Turn them off in Settings > Parental controls, then run this again."
  fi
  users="$(ash pm list users | grep -c 'UserInfo{' || true)"
  if [ "$users" != 1 ]; then
    die "The phone has $users users or profiles (a guest, a work profile, Private Space...)." \
      "Android only lets an app become device owner when there's a single user:" \
      "$(ash pm list users | grep 'UserInfo{' | sed 's/^[[:space:]]*/  /' || true)" \
      "Remove the others in Settings > System > Users, or factory reset."
  fi
  info "No accounts, one user, no device owner: ready."
fi

if [ "$UPDATE" = 0 ]; then
  if [ "$TEST_ONLY" = yes ]; then
    say "This is a debug (test-only) build: unprovision.sh can release it later without a reset."
  else
    say "This is a release build. Once it is the device owner, ONLY A FACTORY RESET removes it."
  fi
  confirm "Make Belay the device owner of this phone?" || die "Nothing changed: you said no."
fi

# 3. Install.
say "Installing..."
info "If the phone shows a Play Protect prompt, note its exact words for"
info "docs/platform-notes.md before you answer it."
install_args=(install -r)
[ "$TEST_ONLY" = yes ] && install_args+=(-t)
if [ "$DRY_RUN" = 1 ]; then
  run adb "${install_args[@]}" "$APK"
else
  out="$(adb "${install_args[@]}" "$APK" 2>&1)" || true
  printf '%s\n' "$out" | sed 's/^/  /'
  if ! grep -q '^Success' <<<"$out"; then
    case "$out" in
      *INSTALL_FAILED_UPDATE_INCOMPATIBLE*)
        die "A Belay signed with a different key is already installed." \
          "If it's a debug build: android/scripts/unprovision.sh, then run this again." \
          "If it's a release build: only a factory reset removes it." ;;
      *INSTALL_FAILED_TEST_ONLY*)
        die "The APK is test-only but was installed without -t." ;;
      *) die "adb install failed." ;;
    esac
  fi
fi

# 4. Device owner.
if [ "$UPDATE" = 0 ]; then
  say "Making Belay the device owner..."
  if [ "$DRY_RUN" = 1 ]; then
    run adb shell dpm set-device-owner "$ADMIN"
  else
    out="$(ash dpm set-device-owner "$ADMIN" 2>&1)" || true
    printf '%s\n' "$out" | sed 's/^/  /'
    if ! grep -q '^Success' <<<"$out"; then
      if grep -q 'accounts' <<<"$out"; then
        die "dpm set-device-owner found an account (above), added after the check. Its type:" \
          "$(account_types)" \
          "An app on the phone signed in by itself. Remove that account in Settings >" \
          "Passwords & accounts (or uninstall the app for now), then run this again."
      fi
      die "dpm set-device-owner failed (above)." \
        "Common causes: an account or a second user appeared; the phone isn't freshly reset."
    fi
  fi
fi

# 5. What only adb can grant, so later phases never need a factory reset.
say "Granting usage access (for Phase 3 screen time)..."
run adb shell appops set "$PKG" GET_USAGE_STATS allow
if [ "$DRY_RUN" = 0 ]; then
  if ash appops get "$PKG" GET_USAGE_STATS | contains 'allow'; then
    info "usage access: granted"
  else
    warn "usage access didn't stick: $(ash appops get "$PKG" GET_USAGE_STATS)"
  fi
fi

say "Exempting Belay from battery optimization (Doze still applies to everything else)..."
run_quiet adb shell dumpsys deviceidle whitelist "+$PKG"
BATTERY_OK=0
if [ "$DRY_RUN" = 0 ]; then
  if ash dumpsys deviceidle whitelist | contains ",$PKG,"; then
    BATTERY_OK=1
    info "battery exemption: granted"
  else
    warn "The battery exemption didn't stick. Open Belay on the phone: under Setup checks,"
    warn "tap Allow next to \"Battery: not restricted\" (Android's own dialog)."
  fi
fi

# Connects Belay to the family's server. EnrollReceiver, which only senders holding
# WRITE_SECURE_SETTINGS (the adb shell) can reach, enrolls and answers with a short
# outcome. The answer never contains the device token.
ENROLLED=""
enroll() {
  local cmd out result
  say "Connecting Belay to $SERVER..."
  cmd=(adb shell am broadcast -a "$PKG.ENROLL" -n "$PKG/.EnrollReceiver"
    --es server "'$SERVER'" --es code "'$CODE'")
  if [ "$DRY_RUN" = 1 ]; then
    run "${cmd[@]}"
    return
  fi
  # Right after the restart the phone may not be online yet. The code is only used once the
  # server answers, so trying again while it can't be reached is safe.
  local tries=0
  while :; do
    out="$("${cmd[@]}" 2>&1 | tr -d '\r')" || true
    result="$(sed -n 's/^Broadcast completed: //p' <<<"$out")"
    case "$result" in
      *'data="failed: unreachable'*)
        tries=$((tries + 1))
        if [ "$tries" -lt 12 ]; then
          [ "$tries" != 1 ] || info "The server can't be reached yet (the phone may still be connecting); trying again for a minute..."
          sleep 5
          continue
        fi
        ;;
    esac
    break
  done
  case "$result" in
    "result=-1, data="*)
      ENROLLED="$(sed 's/^result=-1, data="//; s/"$//' <<<"$result")"
      info "Belay: $ENROLLED"
      ;;
    *'data="failed: unreachable'*)
      warn "Belay couldn't reach the server: $(sed 's/^result=[-0-9]*, data="//; s/"$//' <<<"$result")"
      warn "Check that the phone is online and the address is right, then run this again with the same --code (it works for 30 minutes)."
      ;;
    *"data="*)
      warn "Belay couldn't connect: $(sed 's/^result=[-0-9]*, data="//; s/"$//' <<<"$result")"
      warn "Fix that, then run this again with --server and a new --code."
      ;;
    *)
      warn "Belay didn't answer the enrollment broadcast:"
      printf '%s\n' "$out" | sed 's/^/  /' >&2
      warn "Is the phone unlocked, and is this a Phase 1 build of Belay?"
      ;;
  esac
}

# 6. Start Belay and check it is running.
say "Starting Belay..."
run_quiet adb shell am start -n "$PKG/.ui.MainActivity"
if [ "$DRY_RUN" = 1 ]; then
  if [ -n "$SERVER" ]; then enroll; fi
  say "Dry run finished: the checks passed, and nothing on the phone changed."
  exit 0
fi
service_running() {
  ash dumpsys activity services "$PKG/.service.BelayService" | contains 'isForeground=true'
}
wait_for_service() {
  local _
  for _ in $(seq 1 "$1"); do
    service_running && return 0
    sleep 1
  done
  return 1
}
running=0
wait_for_service 20 && running=1

# 7. Restart once. Android locks the notification settings of an app whose
#    POST_NOTIFICATIONS was granted by policy only while it boots; until then the managed
#    notice's channel could still be switched off. The restart also shows that Belay comes
#    back by itself after a boot.
if [ "$UPDATE" = 0 ] && [ "$REBOOT" = 1 ] && [ "$running" = 1 ]; then
  say "Restarting the phone once (Android locks the managed notice's settings at boot)..."
  # Android saves the battery allowlist 5 seconds after a change
  # (DeviceIdleController.writeConfigFileLocked): restarting sooner loses the exemption.
  sleep 8
  adb reboot
  adb wait-for-device
  for _ in $(seq 1 150); do
    [ "$(ash getprop sys.boot_completed 2>/dev/null)" = 1 ] && break
    sleep 2
  done
  say "If the phone asks for its PIN, unlock it now."
  running=0
  wait_for_service 180 && running=1
  if [ "$BATTERY_OK" = 1 ] && ! ash dumpsys deviceidle whitelist | contains ",$PKG,"; then
    warn "The battery exemption didn't survive the restart; granting it again."
    adb shell dumpsys deviceidle whitelist "+$PKG" >/dev/null
    sleep 8
  fi
fi
BATTERY_OK=0
ash dumpsys deviceidle whitelist | contains ",$PKG," && BATTERY_OK=1

# 8. Connect to the family's server. After the restart, so the phone is unlocked again
#    (Belay's service only runs after that) and back online.
if [ -n "$SERVER" ]; then enroll; fi

say ""
say "Result:"
owners_text | sed 's/^/  owners: /'
if [ "$running" = 1 ]; then
  info "Belay's foreground service is running."
else
  warn "Belay's service isn't running yet; open Belay on the phone and check Setup checks."
fi
info "standby bucket: $(ash am get-standby-bucket "$PKG" 2>/dev/null) (5 means exempted)"
[ "$BATTERY_OK" = 1 ] || warn "Battery exemption missing (see above)."
if [ -n "$SERVER" ]; then
  if [ -n "$ENROLLED" ]; then info "Belay server: $ENROLLED"; else warn "Not connected to a Belay server (see above)."; fi
fi
say ""
say "Next: on the phone, open Belay. Under Setup checks everything should have a check mark."
say "Then continue with docs/phase0-checklist.md."
