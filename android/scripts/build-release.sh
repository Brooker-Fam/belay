#!/usr/bin/env bash
# Build the release APK, signed with the family's release key (make-release-key.sh).
#
# Usage: android/scripts/build-release.sh
#
# Reads ~/.config/belay/signing.properties (or $BELAY_SIGNING_PROPERTIES) and asks for
# the key's password unless BELAY_STORE_PASSWORD is set. Prints the APK's path and the
# certificate it is signed with: check it matches the one make-release-key.sh printed.
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
signer="$(apk_signer "$APK" || true)"
if [ -n "${signer%%|*}" ]; then
  info "signed by: ${signer#*|}"
  info "certificate SHA-256: ${signer%%|*}"
else
  warn "Couldn't read the signature (apksigner missing?)."
fi
