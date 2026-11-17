#!/usr/bin/env bash
# Provisioning and change detection, end to end, on an emulator (CI runs it on Android 17).
# It REFUSES to run on anything but an emulator: it makes Belay the device owner.
#
# Usage: android/scripts/ci-emulator-test.sh <debug APK> <androidTest APK> [<fixture v1 APK> <fixture v2 APK>]
#
# 1. provision.sh (debug build), including its restart
# 2. device owner, foreground service, the managed notice (and that it can't be dismissed),
#    the standby bucket, uninstall blocked
# 3. installing, updating and removing a package are detected (by any layer)
# 4. the instrumented tests; with the two fixture APKs (./gradlew :fixture:assembleV1Debug
#    :fixture:assembleV2Debug), they also install, update and remove the fixture app and
#    check the outbox got the three events
# 5. a restart: Belay comes back by itself and its change log survives
# 6. unprovision.sh releases device owner and uninstalls
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

APK="${1:?debug APK}"
TEST_APK="${2:?androidTest APK}"
FIXTURE_V1="${3:-}"
FIXTURE_V2="${4:-}"
TEST_PKG="$PKG.test"
if [ -n "$FIXTURE_V1$FIXTURE_V2" ]; then
  [ -f "$FIXTURE_V1" ] && [ -f "$FIXTURE_V2" ] || die "fixture APKs not found: '$FIXTURE_V1' '$FIXTURE_V2'"
fi

find_adb
pick_device
if [ "$(ash getprop ro.boot.qemu)" != 1 ] && [ "$(ash getprop ro.kernel.qemu)" != 1 ]; then
  die "$SERIAL is not an emulator. This test sets a device owner: emulators only."
fi
phone_summary

step() { printf '\n=== %s\n' "$*"; }
# Waits until Belay logs a line containing $1 (the log is cleared before each action).
# grep reads from a process substitution, so its own status is the result.
wait_log() {
  grep -m1 -F -- "$1" < <(timeout "${2:-60}" "$ADB_BIN" -s "$SERIAL" logcat -v brief -s Belay:I)
}
# What Belay was doing, for a failed check.
diagnose() {
  echo "--- Belay's log (last 80 lines):"
  "$ADB_BIN" -s "$SERIAL" logcat -d -v brief -s Belay:V AndroidRuntime:E | tail -n 80 || true
  echo "--- Belay's processes:"
  ash "ps -A | grep -F $PKG" || true
  echo "--- last heartbeats:"
  state | grep -o '"heartbeats":.*' | cut -c 1-1500 || true
}
# A summary of Belay's stored state: heartbeats, changes and outbox counts, which debug
# builds write after every agent step (DebugTools.afterStep). Read with run-as (debug builds
# only). Retries briefly, and shows run-as's own error if it never succeeds.
state() {
  local out _
  for _ in 1 2 3 4 5 6; do
    out="$(adb shell run-as "$PKG" cat no_backup/debug-state.json 2>&1 | tr -d '\r' || true)"
    case "$out" in "{"*) printf '%s\n' "$out"; return 0 ;; esac
    sleep 2
  done
  printf 'run-as failed: %s\n' "$out" >&2
  return 1
}
service_running() { ash dumpsys activity services "$PKG/.service.BelayService" | contains 'isForeground=true'; }
wait_boot() {
  adb wait-for-device
  for _ in $(seq 1 150); do
    [ "$(ash getprop sys.boot_completed 2>/dev/null)" = 1 ] && return 0
    sleep 2
  done
  die "the emulator didn't finish booting"
}

step "Let the freshly booted system settle, then list its accounts (types only)"
# Something on a Google APIs image can add an account seconds after boot, which then
# blocks set-device-owner. Wait, and show what is there.
sleep "${SETTLE_SECONDS:-45}"
types="$(account_types)"
echo "accounts: ${types:-none}"

step "Provision the debug build with provision.sh"
"$SCRIPTS_DIR/provision.sh" --yes --serial "$SERIAL" "$APK"

step "Device owner, service and managed notice"
is_belay_owner || die "Belay isn't the device owner" "$(owners_text)"
owners_text
# What woke Belay, from its heartbeat log. After `dpm set-device-owner`, Android binds
# the DeviceAdminService, which starts Belay even though nothing opened it yet.
triggers="$(state | grep -o '"trigger":"[^"]*"' | sort | uniq -c || true)"
[ -n "$triggers" ] || die "couldn't read Belay's state with run-as"
printf 'heartbeats by trigger:\n%s\n' "$triggers"
state | contains '"admin service bound"' || die "Android never bound BelayAdminService"
service_running || die "BelayService isn't running in the foreground"
ash dumpsys activity services "$PKG/.service.BelayAdminService" | contains 'ServiceRecord' ||
  die "Android didn't bind BelayAdminService (the DeviceAdminService)"
echo "DeviceAdminService bound by the system"
record="$(ash dumpsys notification --noredact | grep -F "pkg=$PKG " || true)"
record="${record%%$'\n'*}"
[ -n "$record" ] || die "no notification from $PKG"
printf '%s\n' "$record"
# FLAG_NO_DISMISS (hidden, 0x2000): Android 14+ keeps a device owner's ongoing notice
# undismissable. Android 17's dumpsys prints the flags by name; older versions in hex.
flags="$(grep -o 'flags=[A-Za-z0-9_|]*' <<<"$record" || true)"
flags="${flags%%$'\n'*}"
flags="${flags#flags=}"
case "$flags" in
  *NO_DISMISS*) ;;
  0x*) [ $((flags & 0x2000)) != 0 ] || die "the managed notice can be dismissed (flags=$flags)" ;;
  *) die "the managed notice can be dismissed (flags=$flags)" ;;
esac
echo "managed notice flags=$flags: not dismissible"
bucket="$(ash am get-standby-bucket "$PKG")"
[ "$bucket" = 5 ] || die "standby bucket is $bucket, expected 5 (exempted)"
echo "standby bucket: $bucket (exempted)"
ash dumpsys deviceidle whitelist | contains ",$PKG," || die "not on the battery-optimization allowlist"
ash appops get "$PKG" GET_USAGE_STATS | contains allow || die "usage access not granted"
out="$(adb uninstall "$PKG" 2>&1 || true)"
printf '%s\n' "$out"
if grep -q '^Success' <<<"$out"; then die "Belay could be uninstalled"; fi

# Any layer may catch a change first (broadcast, getChangedPackages, full scan); what
# matters is that none is missed. The matching log line shows which layer it was.
step "Install, update and remove are detected"
adb logcat -c
adb install -t "$TEST_APK"
wait_log "change: INSTALLED $TEST_PKG by " || { diagnose; die "install not detected"; }
adb logcat -c
adb install -r -t "$TEST_APK"
wait_log "change: UPDATED $TEST_PKG by " || { diagnose; die "update not detected"; }

step "Instrumented tests"
if [ -n "$FIXTURE_V1" ]; then
  adb push "$FIXTURE_V1" /data/local/tmp/belay-fixture-v1.apk
  adb push "$FIXTURE_V2" /data/local/tmp/belay-fixture-v2.apk
else
  echo "no fixture APKs given: the fixture test is skipped"
fi
out="$(ash am instrument -w "$TEST_PKG/androidx.test.runner.AndroidJUnitRunner")"
printf '%s\n' "$out"
grep -q '^OK (' <<<"$out" || die "instrumented tests failed"

adb logcat -c
adb uninstall "$TEST_PKG"
wait_log "change: REMOVED $TEST_PKG by " || { diagnose; die "removal not detected"; }

step "Restart: Belay comes back by itself, and its log survives"
adb reboot
wait_boot
for _ in $(seq 1 120); do service_running && break; sleep 1; done
service_running || die "BelayService didn't come back after the restart"
state | contains "\"$TEST_PKG\"" || die "the change log didn't survive the restart"
# BOOT_COMPLETED reaches apps late on images with Google services; the DeviceAdminService
# has usually started Belay well before. Wait for the boot heartbeat.
booted=0
for _ in $(seq 1 60); do
  if state | contains '"phone started"'; then booted=1; break; fi
  sleep 2
done
[ "$booted" = 1 ] || { diagnose; die "no boot heartbeat within two minutes of the restart"; }

step "Unprovision (debug builds only)"
"$SCRIPTS_DIR/unprovision.sh" --yes --serial "$SERIAL"
if has_owner; then die "still has an owner" "$(owners_text)"; fi
if ash pm path "$PKG" | contains 'package:'; then die "Belay is still installed"; fi

step "All emulator checks passed"
