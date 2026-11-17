#!/usr/bin/env bash
# The setup kit's container (setup-kit/Dockerfile; docs/setup-kit.md).
#
#   docker run --rm -it -p 127.0.0.1:8090:8090 -v ~/.config/belay:/keys belay-setup [serve]
#
# 1. The first time, it makes your family's release key in the folder you give as /keys, with
#    android/scripts/make-release-key.sh (once, ever: it never overwrites a key), and shows the
#    certificate's SHA-256 and how to back the key up (docs/signing.md).
# 2. It builds Belay and signs it with that key: android/scripts/build-release.sh, which asks
#    for the key's password.
# 3. It serves the setup page at http://localhost:8090: open it in Chrome or Edge on this
#    computer to set up the phone.
#
# With "serve", it only serves the page, and the page installs an APK you choose.
set -euo pipefail

KEYS=/keys
KEYSTORE="$KEYS/belay-release.p12"
REPO=/belay
SCRIPTS="$REPO/android/scripts"
APK="$REPO/android/app/build/outputs/apk/release/app-release.apk"

say() { printf '%s\n' "$*"; }
stop() {
  printf '\nSTOPPED: %s\n' "$1" >&2
  shift
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  exit 1
}
usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
serve() { exec node "$REPO/setup-kit/dist/server.js"; }

case "${1:-}" in
  "") ;;
  serve) serve ;;
  -h | --help)
    usage
    exit 0
    ;;
  *) stop "Unknown command $1" "Run it with --help to see what it does." ;;
esac

RUN="docker run --rm -it -p 127.0.0.1:8090:8090 -v ~/.config/belay:/keys belay-setup"

# The key folder must be one from your computer: anything written to a folder inside the
# container is gone when it stops, and with it every phone's way to be updated. A Docker volume
# isn't one either (/proc/self/mountinfo names its .../volumes/<name>/_data): with --rm an
# anonymous one is deleted, and a named one is hard to back up.
if ! awk -v keys="$KEYS" '$5 == keys { found = 1; if ($4 ~ /\/volumes\/[^\/]+\/_data$/) volume = 1 }
  END { exit !(found && !volume) }' /proc/self/mountinfo; then
  stop "No folder from your computer is at /keys." \
    "Make one for the key (mkdir -p ~/.config/belay), then give it with -v:" "$RUN"
fi

if [ ! -e "$KEYSTORE" ]; then
  [ -t 0 ] || stop "The first run makes your family's release key, and asks you for a password for it." \
    "Run it with -it, so it can ask:" "$RUN"
  # make-release-key.sh refuses the image's own copy of the repository; this is for yours.
  if [ -e "$KEYS/.git" ] || [ -e "$KEYS/android/scripts/make-release-key.sh" ]; then
    stop "The folder at /keys looks like a copy of the Belay repository. Keys never go in the repository:" \
      "give a folder of its own, like ~/.config/belay."
  fi
  say ""
  say "There's no release key in the folder you gave as /keys, so this is the first run: making"
  say "your family's release key, once, with android/scripts/make-release-key.sh."
  say ""
  say "Every Belay you build is signed with this key, and a phone only takes updates signed with"
  say "the key it was set up with. Lose it, and every phone has to be factory reset to update"
  say "Belay. It stays in your folder, on this computer: the family's server never has it."
  say ""
  "$SCRIPTS/make-release-key.sh" "$KEYS"
  # Files made by the container belong to whoever owns the folder, so you can back them up.
  owner="$(stat -c '%u:%g' "$KEYS")"
  chown "$owner" "$KEYSTORE" "$KEYS/signing.properties" 2>/dev/null || true
  say ""
  say "  3. Once: restore the backup on another computer and build with it (this kit, or"
  say "     android/scripts/build-release.sh), to prove the backup works (docs/signing.md)."
  say ""
  say "The key is in the folder you gave as /keys (for example ~/.config/belay), with"
  say "signing.properties, which says where the key is as the kit sees it (/keys/belay-release.p12)."
  say "To build with the Android SDK on this computer instead, change that line to the folder's own path."
  say ""
  say "Write down the certificate SHA-256 above: the setup page shows it again, to compare."
  read -r -p "Press Enter when the key and its password are backed up... " _
fi

# Build with the key in /keys, whatever path its signing.properties names (it may have been made
# outside the container). The password isn't stored: build-release.sh asks for it.
[ -t 0 ] || [ -n "${BELAY_STORE_PASSWORD:-}" ] || stop "Building Belay asks for the key's password." "Run it with -it, so it can ask:" "$RUN"
props="$(mktemp -d)/signing.properties"
alias_name="$(sed -n 's/^keyAlias=//p' "$KEYS/signing.properties" 2>/dev/null | head -n 1 || true)"
printf 'storeFile=%s\nkeyAlias=%s\n' "$KEYSTORE" "${alias_name:-belay}" >"$props"
say ""
say "Building Belay and signing it with your key (android/scripts/build-release.sh)."
say "It takes a few minutes."
if ! BELAY_SIGNING_PROPERTIES="$props" "$SCRIPTS/build-release.sh"; then
  stop "The build failed (above). A mistyped password is the usual reason: run this again."
fi
rm -f "$props"
[ -f "$APK" ] || stop "The build didn't make $APK."

say ""
say "Compare the certificate SHA-256 above with the one you wrote down when the key was made."
export BELAY_KIT_APK="$APK"
serve
