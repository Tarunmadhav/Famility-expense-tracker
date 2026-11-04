#!/usr/bin/env bash
# Builds android/FamilyPlanner.apk with the installed Android SDK (no Gradle, no network).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK_WIN="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$LOCALAPPDATA\\Android\\Sdk}}"
SDK="$(cygpath -u "$SDK_WIN" 2>/dev/null || echo "$SDK_WIN")"
[ -d "$SDK" ] || { echo "Android SDK not found (looked in $SDK)"; exit 1; }

BT="$(ls -d "$SDK"/build-tools/*/ | sort -V | tail -1)"
PLATFORM="$(ls -d "$SDK"/platforms/android-*/ | sort -V | tail -1)"
AJAR="${PLATFORM}android.jar"
[ -f "$AJAR" ] || { echo "android.jar not found in $PLATFORM"; exit 1; }

OUT="$ROOT/android/build"
MANIFEST="$ROOT/android/app/src/main/AndroidManifest.xml"
SRC="$ROOT/android/app/src/main/java"
# The version lives in gradle.properties; reading it here keeps the shell build and
# a Gradle build of the same source at the same version instead of drifting.
VERSION_CODE="$(sed -n 's/^versionCode=//p' "$ROOT/android/gradle.properties" | tr -d '\r' | head -1)"
VERSION_NAME="$(sed -n 's/^versionName=//p' "$ROOT/android/gradle.properties" | tr -d '\r' | head -1)"
: "${VERSION_CODE:=1}" "${VERSION_NAME:=1.0}"

rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex" "$ROOT/android/app/src/main/res/mipmap-xxxhdpi"

# Launcher icon comes from the generated PWA artwork.
cp "$ROOT/web/public/icon-192.png" "$ROOT/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png"

echo "build-tools : $BT"
echo "platform    : $PLATFORM"

tool() {
  local name="$1"
  for candidate in "${BT}${name}" "${BT}${name}.exe" "${BT}${name}.bat" "${BT}${name}.cmd"; do
    if [ -f "$candidate" ]; then echo "$candidate"; return 0; fi
  done
  echo "${BT}${name}"
}
AAPT2="$(tool aapt2)"
D8="$(tool d8)"
ZIPALIGN="$(tool zipalign)"
APKSIGNER="$(tool apksigner)"

"$AAPT2" compile --dir "$ROOT/android/app/src/main/res" -o "$OUT/res.zip"

"$AAPT2" link \
  -o "$OUT/app-unsigned.apk" \
  -I "$AJAR" \
  --manifest "$MANIFEST" \
  -R "$OUT/res.zip" \
  --java "$OUT/gen" \
  --min-sdk-version 26 \
  --target-sdk-version 35 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME"

# Gradle normally generates BuildConfig from plannerApiBaseUrl. This path has no
# Gradle, so emit the same class here or MainActivity cannot resolve START_URL.
PLANNER_URL="$(sed -n 's/^plannerApiBaseUrl=//p' "$ROOT/android/gradle.properties" | tr -d '\r' | head -1)"
: "${PLANNER_URL:=https://family-finance-planner.tarungudipatimadhav.workers.dev/}"
printf 'package com.family.planner;\n\npublic final class BuildConfig {\n  public static final String PLANNER_URL = "%s";\n}\n' "$PLANNER_URL" > "$OUT/gen/com/family/planner/BuildConfig.java"

GEN_FILES=()
while IFS= read -r file; do GEN_FILES+=("$file"); done < <(find "$OUT/gen" -name '*.java')

javac -nowarn -source 8 -target 8 -classpath "$AJAR" -d "$OUT/classes" \
  "$SRC/com/family/planner/MainActivity.java" \
  "${GEN_FILES[@]}"

CLASS_FILES=()
while IFS= read -r file; do CLASS_FILES+=("$file"); done < <(find "$OUT/classes" -name '*.class')

"$D8" --lib "$AJAR" --min-api 26 --output "$OUT/dex" "${CLASS_FILES[@]}"

(cd "$OUT/dex" && jar uf "$OUT/app-unsigned.apk" classes.dex)

"$ZIPALIGN" -f 4 "$OUT/app-unsigned.apk" "$OUT/app-aligned.apk"

KEYSTORE="$ROOT/android/debug.keystore"
if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -v -keystore "$KEYSTORE" -alias androiddebugkey \
    -storepass android -keypass android -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Family Planner, OU=Household, O=Family, L=Vijayawada, C=IN" > /dev/null 2>&1
fi

"$APKSIGNER" sign --ks "$KEYSTORE" --ks-key-alias androiddebugkey \
  --ks-pass pass:android --key-pass pass:android \
  --out "$ROOT/android/FamilyPlanner.apk" "$OUT/app-aligned.apk"

"$APKSIGNER" verify --print-certs "$ROOT/android/FamilyPlanner.apk" | head -4

# Publish the build next to the web app so /api/version can point at a real file.
mkdir -p "$ROOT/web/public/download"
cp "$ROOT/android/FamilyPlanner.apk" "$ROOT/web/public/download/family-planner-$VERSION_NAME.apk"
echo "APK: $ROOT/android/FamilyPlanner.apk ($(du -h "$ROOT/android/FamilyPlanner.apk" | cut -f1)) v$VERSION_NAME ($VERSION_CODE)"
echo "Served at: /download/family-planner-$VERSION_NAME.apk";
