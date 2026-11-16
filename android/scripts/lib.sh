# shellcheck shell=bash
# Shared helpers for provision.sh, unprovision.sh, qr-payload.sh and build-release.sh.
# Sourced, not run. Variables here are used by the scripts that source it.
# shellcheck disable=SC2034

PKG=family.brooker.belay
ADMIN="$PKG/.AdminReceiver"
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$(dirname "$SCRIPTS_DIR")"

DRY_RUN=0
ASSUME_YES=0
SERIAL="${ANDROID_SERIAL:-}"

say() { printf '%s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() {
  printf '\nSTOPPED: %s\n' "$1" >&2
  shift
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  exit 1
}

# The first build tool found in $ANDROID_HOME/build-tools (newest version first), or empty.
build_tool() {
  local name="$1" sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}" dir
  if [ -d "$sdk/build-tools" ]; then
    while IFS= read -r dir; do
      if [ -x "$dir/$name" ]; then
        printf '%s\n' "$dir/$name"
        return
      fi
    done < <(find "$sdk/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -rV)
  fi
  command -v "$name" 2>/dev/null || true
}

find_adb() {
  local sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
  if [ -n "${ADB:-}" ]; then
    ADB_BIN="$ADB"
  elif [ -x "$sdk/platform-tools/adb" ]; then
    ADB_BIN="$sdk/platform-tools/adb"
  elif command -v adb >/dev/null 2>&1; then
    ADB_BIN="$(command -v adb)"
  else
    die "adb not found." "Install Android SDK Platform-Tools, or set ANDROID_HOME."
  fi
}

adb() {
  if [ -n "$SERIAL" ]; then "$ADB_BIN" -s "$SERIAL" "$@"; else "$ADB_BIN" "$@"; fi
}

# adb shell, with the carriage returns of older adb versions removed. Read-only use.
ash() { adb shell "$@" | tr -d '\r'; }

# Runs a command that changes the phone, or only prints it with --dry-run.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry run] %s\n' "$*"
  else
    "$@"
  fi
}

# Like run, but hides the command's output (never the dry-run line).
run_quiet() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  [dry run] %s\n' "$*"
  else
    "$@" >/dev/null
  fi
}

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  [ "$DRY_RUN" = 1 ] && return 0
  local answer
  printf '%s [y/N] ' "$1"
  read -r answer
  case "$answer" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

# Picks the one connected phone (or $SERIAL) and checks it is reachable.
pick_device() {
  local list ready unauthorized
  list="$("$ADB_BIN" devices | tail -n +2)"
  ready="$(printf '%s\n' "$list" | awk '$2 == "device" { print $1 }')"
  unauthorized="$(printf '%s\n' "$list" | awk '$2 == "unauthorized" { print $1 }')"
  if [ -n "$SERIAL" ]; then
    printf '%s\n' "$ready" | grep -qxF "$SERIAL" ||
      die "Phone $SERIAL isn't connected and authorized." "adb devices says:" "$list"
    return
  fi
  local count
  count="$(printf '%s\n' "$ready" | grep -c . || true)"
  if [ "$count" = 0 ]; then
    if [ -n "$unauthorized" ]; then
      die "The phone hasn't allowed this computer yet." \
        "Unlock it and tap Allow on the \"Allow USB debugging?\" prompt, then run this again."
    fi
    die "No phone found." \
      "Plug it in with a data cable, then on the phone: Settings > About phone > tap Build number" \
      "7 times; Settings > System > Developer options > USB debugging on."
  fi
  if [ "$count" -gt 1 ]; then
    die "More than one device is connected." "Pass --serial with one of:" "$ready"
  fi
  SERIAL="$ready"
}

phone_summary() {
  local model release sdk patch
  model="$(ash getprop ro.product.manufacturer) $(ash getprop ro.product.model)"
  release="$(ash getprop ro.build.version.release)"
  sdk="$(ash getprop ro.build.version.sdk)"
  patch="$(ash getprop ro.build.version.security_patch)"
  info "Phone: $model, Android $release (API $sdk), security update $patch, serial $SERIAL"
  PHONE_SDK="$sdk"
}

# Prints the device-owner/profile-owner lines of `dpm list-owners` ("no owners" when none).
owners() { ash dpm list-owners 2>/dev/null || true; }

is_belay_owner() { owners | grep -q "$PKG/"; }

# Test-only (debug) builds can be released without a factory reset.
apk_is_test_only() {
  local aapt2
  aapt2="$(build_tool aapt2)"
  [ -n "$aapt2" ] || return 2
  "$aapt2" dump xmltree --file AndroidManifest.xml "$1" 2>/dev/null | grep -q 'android:testOnly([^)]*)=true'
}

apk_package() {
  local aapt2
  aapt2="$(build_tool aapt2)"
  [ -n "$aapt2" ] || return 2
  "$aapt2" dump badging "$1" 2>/dev/null | sed -n "s/^package: name='\([^']*\)'.*/\1/p"
}

# "<sha256 hex>|<certificate DN>" of the APK's first signer, or empty when unsigned.
apk_signer() {
  local apksigner out
  apksigner="$(build_tool apksigner)"
  [ -n "$apksigner" ] || return 2
  out="$("$apksigner" verify --print-certs "$1" 2>/dev/null)" || return 1
  # apksigner prints "Signer #1 certificate ..." or, in newer versions, "V2 Signer: certificate ...".
  printf '%s|%s\n' \
    "$(printf '%s\n' "$out" | sed -nE 's/^(Signer #1|V[0-9.]+ Signer:) certificate SHA-256 digest: //p' | head -1)" \
    "$(printf '%s\n' "$out" | sed -nE 's/^(Signer #1|V[0-9.]+ Signer:) certificate DN: //p' | head -1)"
}
