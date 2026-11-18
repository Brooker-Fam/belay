# syntax=docker/dockerfile:1
# check=skip=FromPlatformFlagConstDisallowed
# The Belay setup kit: what provision.sh needs on a parent's computer (a JDK, the Android SDK,
# Gradle), pinned, in one image. On its first run it makes the family's release key in the folder
# mounted at /keys (make-release-key.sh); then it builds and signs Belay with that key
# (build-release.sh), keeps a copy of the app in that folder, and serves the setup page at
# http://localhost:8090, which sets up the phone over WebUSB from the parent's own browser.
# docs/setup-kit.md has the rest.
#
# Build it from the repository's root, then run it with a folder of its own for the key:
#   docker build -f setup-kit/Dockerfile -t belay-setup .
#   mkdir -p ~/.config/belay
#   docker run --rm -it -p 127.0.0.1:8090:8090 -v ~/.config/belay:/keys belay-setup
#
# Google only makes the SDK's build tools (and Gradle's aapt2) for x86_64 Linux, so every stage is
# linux/amd64 on purpose (the check skipped above), and a Mac with Apple silicon runs it under
# emulation.

# The server's Node and CI's JDK (Temurin 21), by digest.
ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
ARG JDK_IMAGE=eclipse-temurin:21.0.13_9-jdk@sha256:db5cc6341a1d7bc40cdb51e1f0d9824f3bb2cc8107d29da421dc4df7d11f05f1

FROM --platform=linux/amd64 ${JDK_IMAGE} AS jdk

# The kit: the page bundled, the Node code built, only the runtime dependencies kept.
FROM --platform=linux/amd64 ${NODE_IMAGE} AS kit
WORKDIR /belay/setup-kit
COPY setup-kit/package.json setup-kit/package-lock.json ./
# No install scripts: esbuild's binary comes in its own platform package.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY setup-kit/tsconfig.json setup-kit/tsconfig.build.json ./
COPY setup-kit/scripts ./scripts
COPY setup-kit/src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM --platform=linux/amd64 ${NODE_IMAGE}
ENV JAVA_HOME=/opt/java/openjdk \
    ANDROID_HOME=/opt/android-sdk \
    BELAY_KIT_HOST=0.0.0.0 \
    BELAY_KIT_PORT=8090
ENV PATH=$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH
COPY --from=jdk /opt/java/openjdk /opt/java/openjdk

# The Android SDK. The command-line tools by SHA-256 (as developer.android.com/studio lists it);
# then the packages the build uses, each archive checked by sdkmanager against the SHA-1 in
# Google's repository, and their revisions checked here, so a new revision stops the build until
# it's pinned. Installing them accepts the Android SDK License (developer.android.com/studio/terms).
ARG CMDLINE_TOOLS=https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip
ARG CMDLINE_TOOLS_SHA256=4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583
COPY setup-kit/scripts/fetch-pinned.mjs /tmp/fetch-pinned.mjs
RUN node /tmp/fetch-pinned.mjs "$CMDLINE_TOOLS" "$CMDLINE_TOOLS_SHA256" /tmp/cmdline-tools.zip \
 && mkdir -p "$ANDROID_HOME/cmdline-tools" \
 && cd "$ANDROID_HOME/cmdline-tools" \
 && jar xf /tmp/cmdline-tools.zip \
 && mv cmdline-tools latest \
 && chmod +x latest/bin/* \
 && rm /tmp/cmdline-tools.zip /tmp/fetch-pinned.mjs \
 && (yes | sdkmanager --licenses >/dev/null) \
 && sdkmanager --install "platforms;android-37.0" "build-tools;36.0.0" >/dev/null \
 && grep -qx 'Pkg.Revision=2' "$ANDROID_HOME/platforms/android-37.0/source.properties" \
 && grep -qx 'Pkg.Revision=36.0.0' "$ANDROID_HOME/build-tools/36.0.0/source.properties"

# The Android build, run once here (unsigned), so the parent's build needs nothing more from the
# internet: Gradle (the wrapper checks its SHA-256) and the dependencies the build pins.
WORKDIR /belay
COPY android ./android
RUN cd android \
 && ./gradlew --no-daemon --quiet :app:assembleRelease \
 && rm -rf app/build core/build fixture/build .gradle .kotlin

COPY --from=kit /belay/setup-kit/package.json ./setup-kit/
COPY --from=kit /belay/setup-kit/node_modules ./setup-kit/node_modules
COPY --from=kit /belay/setup-kit/dist ./setup-kit/dist
COPY setup-kit/entrypoint.sh ./setup-kit/
COPY LICENSE NOTICE ./
# No VOLUME for /keys: the entrypoint wants a folder from your computer there, given with -v.
EXPOSE 8090
ENTRYPOINT ["/belay/setup-kit/entrypoint.sh"]
