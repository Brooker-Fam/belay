#!/usr/bin/env bash
# Build the release APK, signed with the family's release key (make-release-key.sh).
#
# Usage: android/scripts/build-release.sh
#
# Reads ~/.config/belay/signing.properties (or $BELAY_SIGNING_PROPERTIES) and asks for
# the key's password unless BELAY_STORE_PASSWORD is set. Prints the APK's path, its version
# code and name (adding it to the family's server for an update takes the version code), the
# certificate it is signed with (check it matches the one make-release-key.sh printed) and
# the file's own SHA-256 (the server's page shows it once the file is added).
set -euo pipefail
# shellcheck source-path=SCRIPTDIR source=lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

PROPS="${BELAY_SIGNING_PROPERTIES:-$HOME/.config/belay/signing.properties}"
[ -f "$PROPS" ] || die "No $PROPS." "Create the release key first: android/scripts/make-release-key.sh"
export BELAY_SIGNING_PROPERTIES="$PROPS"

if [ -z "${BELAY_STORE_PASSWORD:-}" ]; then
  printf 'Release key password: '
  read -rs BELAY_STORE_PASSWORD
  printf '\n'
fi
export BELAY_STORE_PASSWORD
export BELAY_KEY_PASSWORD="${BELAY_KEY_PASSWORD:-$BELAY_STORE_PASSWORD}"

(cd "$ANDROID_DIR" && ./gradlew --quiet :app:assembleRelease)

APK="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
[ -f "$APK" ] || die "The build didn't produce $APK."
say "Built $APK"
# The version as the APK has it, which is what the phone checks.
aapt2="$(build_tool aapt2)"
badging=""
[ -z "$aapt2" ] || badging="$("$aapt2" dump badging "$APK" 2>/dev/null | sed -n '/^package: /p' || true)"
version_code="$(sed -n "s/.* versionCode='\([0-9]*\)'.*/\1/p" <<<"$badging")"
version_name="$(sed -n "s/.* versionName='\([^']*\)'.*/\1/p" <<<"$badging")"
if [ -n "$version_code" ]; then
  info "version code: $version_code"
  [ -z "$version_name" ] || info "version name: $version_name"
else
  warn "Couldn't read the version code (aapt2 missing?): it's versionCode in android/app/build.gradle.kts."
fi
signer="$(apk_signer "$APK" || true)"
if [ -n "${signer%%|*}" ]; then
  info "signed by: ${signer#*|}"
  info "certificate SHA-256: ${signer%%|*}"
else
  warn "Couldn't read the signature (apksigner missing?)."
fi
info "the file's SHA-256: $(sha256_of "$APK")"
if [ -n "$version_code" ]; then
  say "Updating Belay from your server takes this file and its version code, $version_code (the"
  say "phone's page, Updating Belay). The next build replaces the file: keep a copy."
fi
