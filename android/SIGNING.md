# Android release signing

The release build is signed only from environment variables. If any of them is
missing the build stops with `Release signing is not configured...`; it never
falls back to the debug key.

| Variable | Meaning |
| --- | --- |
| `ANDROID_KEYSTORE_PATH` | absolute path to your `.jks` file |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | key alias inside the keystore |
| `ANDROID_KEY_PASSWORD` | key password (often the same as the keystore password) |

## This project's keystore

The release key for this app already exists at
`D:\family planner\signing\family-planner-release.jks` (alias `family-planner`),
with its password in `signing\CREDENTIALS.txt`. Both are ignored by git; back
them up offline, and re-export the certificate fingerprint with:

```cmd
keytool -list -v -keystore "D:\family planner\signing\family-planner-release.jks" -alias family-planner | findstr SHA256
```

The sections below are the from-scratch procedure, kept for a rebuild of the key.

## 1. Create your keystore (run this yourself, once)

```bash
keytool -genkeypair -v \
  -keystore ~/family-planner-release.jks \
  -alias family-planner \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -storetype JKS
```

Pick a strong password and store it in your password manager. **This file is the
app's identity**: losing it means you can never update an installed copy.
Keep an offline backup of the `.jks` and its passwords.

## 2. Base64-encode it for GitHub

Linux/macOS:

```bash
base64 -w0 ~/family-planner-release.jks > keystore.b64
```

Windows PowerShell:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\family-planner-release.jks")) | Set-Content keystore.b64 -NoNewline
```

## 3. Add four repository secrets

GitHub → Settings → Secrets and variables → Actions → New repository secret:

- `ANDROID_KEYSTORE_BASE64` — contents of `keystore.b64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS` (e.g. `family-planner`)
- `ANDROID_KEY_PASSWORD`

Delete `keystore.b64` from your machine afterwards. Never commit the `.jks`,
the base64 file, or the passwords — `.gitignore` already blocks `*.jks`,
`*.keystore`, `keystore.properties`, `local.properties` and `signing/`.

## 4. Local release build (optional)

```bash
export ANDROID_KEYSTORE_PATH="$HOME/family-planner-release.jks"
export ANDROID_KEYSTORE_PASSWORD='…'
export ANDROID_KEY_ALIAS='family-planner'
export ANDROID_KEY_PASSWORD='…'
./gradlew assembleRelease
```

APK: `android/app/build/outputs/apk/release/app-release.apk`.
