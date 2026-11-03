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
  --version-code 1 --version-name 2.0

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
echo "APK: $ROOT/android/FamilyPlanner.apk ($(du -h "$ROOT/android/FamilyPlanner.apk" | cut -f1))"
