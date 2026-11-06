#!/usr/bin/env bash
# ---------------------------------------------------------------------------------------------------------------------
# android-build/create-project.sh [full|safe]
#
# Generates a fresh Capacitor Android project in $QR_PROJECT_DIR (default /tmp/app) and applies
# android-build/apply-native-patches.mjs to it. Used by .github/workflows/build-apk.yml; it can also be run by hand on a
# machine that has Node.js 22+ and the Android SDK (set the variables below first).
#
#   full  everything: push notifications, local reminders, deep links, shortcuts, adaptive icon, splash, offline page
#   safe  reduced build (the previous workflow's feature set + version/signing). The workflow only uses it as an
#         automatic fallback when a full DEBUG build fails.
#
# Required environment: APP_ID APP_NAME APP_VERSION APP_VERSION_CODE LIVE_URL
# Optional environment: GOOGLE_SERVICES_JSON (Firebase config, JSON or base64), QR_PROJECT_DIR, GITHUB_WORKSPACE
# ---------------------------------------------------------------------------------------------------------------------
set -euo pipefail

MODE="${1:-full}"
case "$MODE" in full | safe) ;; *) echo "usage: create-project.sh [full|safe]" >&2; exit 2 ;; esac

REPO="${GITHUB_WORKSPACE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PROJECT="${QR_PROJECT_DIR:-/tmp/app}"
export QR_PROJECT_DIR="$PROJECT" QR_MODE="$MODE"

: "${APP_ID:?APP_ID is not set}" "${APP_NAME:?APP_NAME is not set}" "${APP_VERSION:?APP_VERSION is not set}"
: "${APP_VERSION_CODE:?APP_VERSION_CODE is not set}" "${LIVE_URL:?LIVE_URL is not set}"

# Base set: exactly what the previous (known-working) workflow installed. Always required.
BASE_PLUGINS=(
  "@capacitor/core@8" "@capacitor/cli@8" "@capacitor/android@8"
  "@capawesome/capacitor-android-edge-to-edge-support@8"
)
# Official Capacitor 8 plugins used by the app UI (every one is feature-detected in app/js/native.js, so a plugin that
# is missing only disables its own feature):
#   app (back button, deep links, app info)  browser (external links)  clipboard  haptics  network (offline banner)
#   share (native share sheet)  splash-screen (branded launch)
# full build: all of them must install (a release must never silently lose a feature - the build fails loudly instead)
# safe build: installed one by one; one that cannot be installed is skipped with a warning, so the fallback still
#             produces an APK
UI_PLUGINS=(
  "@capacitor/app@8" "@capacitor/browser@8" "@capacitor/clipboard@8" "@capacitor/haptics@8"
  "@capacitor/network@8" "@capacitor/share@8" "@capacitor/splash-screen@8"
)
# full build only: push notifications (Firebase Cloud Messaging) and the daily reading reminder
FULL_PLUGINS=("@capacitor/push-notifications@8" "@capacitor/local-notifications@8")
# full build only, optional: Google Play in-app update check (only works for installs from Google Play)
OPTIONAL_PLUGINS=("@capawesome/capacitor-app-update@8")

echo "::group::Create the Capacitor project ($MODE) in $PROJECT"
rm -rf "$PROJECT"
mkdir -p "$PROJECT"
cd "$PROJECT"
npm init -y > /dev/null
npm install --no-audit --no-fund "${BASE_PLUGINS[@]}"
if [ "$MODE" = "full" ]; then
  npm install --no-audit --no-fund "${UI_PLUGINS[@]}"
  npm install --no-audit --no-fund "${FULL_PLUGINS[@]}"
  for plugin in "${OPTIONAL_PLUGINS[@]}"; do
    if ! npm install --no-audit --no-fund "$plugin"; then
      echo "::warning::Optional plugin $plugin could not be installed - the app falls back to the update notice from Firestore (siteConfig/appConfig)."
    fi
  done
else
  for plugin in "${UI_PLUGINS[@]}"; do
    if ! npm install --no-audit --no-fund "$plugin"; then
      echo "::warning::Safe build: plugin $plugin could not be installed and is skipped (its feature is disabled in this APK)."
    fi
  done
fi

node "$REPO/android-build/apply-native-patches.mjs" config --mode "$MODE" --repo "$REPO" --project "$PROJECT"
npx cap add android
node "$REPO/android-build/apply-native-patches.mjs" android --mode "$MODE" --repo "$REPO" --project "$PROJECT"

# a little more memory for Gradle (Firebase + AndroidX are larger than a plain Capacitor app)
printf '\norg.gradle.jvmargs=-Xmx3g -XX:MaxMetaspaceSize=768m -Dfile.encoding=UTF-8\n' >> android/gradle.properties

echo "Installed Capacitor plugins:"
npx cap ls android || true
echo "::endgroup::"
