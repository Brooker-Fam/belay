#!/usr/bin/env bash
# The Phase 0 path, end to end, on an emulator (CI runs it on Android 17).
# It REFUSES to run on anything but an emulator: it makes Belay the device owner.
#
# Usage: android/scripts/ci-emulator-test.sh <debug APK> <androidTest APK>
#
# 1. provision.sh (debug build), including its restart
# 2. device owner, foreground service, the managed notice (and that it can't be dismissed),
#    the standby bucket, uninstall blocked
# 3. installing, updating and removing a package are detected by the runtime receiver
# 4. the instrumented tests
# 5. a restart: Belay comes back by itself and its change log survives
# 6. unprovision.sh releases device owner and uninstalls
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

APK="${1:?debug APK}"
TEST_APK="${2:?androidTest APK}"
TEST_PKG="$PKG.test"

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
state() { ash run-as "$PKG" cat no_backup/agent-state.json; }
service_running() { ash dumpsys activity services "$PKG/.service.BelayService" | contains 'isForeground=true'; }
wait_boot() {
  adb wait-for-device
  for _ in $(seq 1 150); do
    [ "$(ash getprop sys.boot_completed 2>/dev/null)" = 1 ] && return 0
    sleep 2
  done
  die "the emulator didn't finish booting"
}

step "Provision the debug build with provision.sh"
"$SCRIPTS_DIR/provision.sh" --yes --serial "$SERIAL" "$APK"

step "Device owner, service and managed notice"
is_belay_owner || die "Belay isn't the device owner" "$(owners_text)"
owners_text
service_running || die "BelayService isn't running in the foreground"
ash dumpsys activity services "$PKG/.service.BelayAdminService" | contains 'ServiceRecord' ||
  die "Android didn't bind BelayAdminService (the DeviceAdminService)"
echo "DeviceAdminService bound by the system"
record="$(ash dumpsys notification --noredact | grep -F "pkg=$PKG " || true)"
record="${record%%$'\n'*}"
[ -n "$record" ] || die "no notification from $PKG"
printf '%s\n' "$record"
flags="$(grep -o 'flags=0x[0-9a-fA-F]*' <<<"$record" || true)"
flags="${flags%%$'\n'*}"
flags="${flags#flags=}"
# FLAG_NO_DISMISS (0x2000, hidden): Android 14+ keeps a device owner's ongoing notice undismissable.
[ -n "$flags" ] && [ $((flags & 0x2000)) != 0 ] || die "the managed notice can be dismissed (flags=$flags)"
echo "managed notice flags=$flags: not dismissible"
bucket="$(ash am get-standby-bucket "$PKG")"
[ "$bucket" = 5 ] || die "standby bucket is $bucket, expected 5 (exempted)"
echo "standby bucket: $bucket (exempted)"
ash dumpsys deviceidle whitelist | contains ",$PKG," || die "not on the battery-optimization allowlist"
ash appops get "$PKG" GET_USAGE_STATS | contains allow || die "usage access not granted"
out="$(adb uninstall "$PKG" 2>&1 || true)"
printf '%s\n' "$out"
if grep -q '^Success' <<<"$out"; then die "Belay could be uninstalled"; fi

step "Install, update and remove are detected"
adb logcat -c
adb install -t "$TEST_APK"
wait_log "change: INSTALLED $TEST_PKG by BROADCAST" || die "install not detected"
adb logcat -c
adb install -r -t "$TEST_APK"
wait_log "change: UPDATED $TEST_PKG by BROADCAST" || die "update not detected"

step "Instrumented tests"
out="$(ash am instrument -w "$TEST_PKG/androidx.test.runner.AndroidJUnitRunner")"
printf '%s\n' "$out"
grep -q '^OK (' <<<"$out" || die "instrumented tests failed"

adb logcat -c
adb uninstall "$TEST_PKG"
wait_log "change: REMOVED $TEST_PKG by BROADCAST" || die "removal not detected"

step "Restart: Belay comes back by itself, and its log survives"
adb reboot
wait_boot
for _ in $(seq 1 120); do service_running && break; sleep 1; done
service_running || die "BelayService didn't come back after the restart"
state | contains "\"$TEST_PKG\"" || die "the change log didn't survive the restart"
state | contains '"phone started"' || die "no boot heartbeat after the restart"

step "Unprovision (debug builds only)"
"$SCRIPTS_DIR/unprovision.sh" --yes --serial "$SERIAL"
if has_owner; then die "still has an owner" "$(owners_text)"; fi
if ash pm path "$PKG" | contains 'package:'; then die "Belay is still installed"; fi

step "All Phase 0 emulator checks passed"
