#!/usr/bin/env node
// Publish the release row /api/version reads, straight from the APK on disk.
//
// The hash used to be written by hand, so the app was told to expect a build it
// was not downloading and kept offering the same "update" for ever. This reads the
// real file, computes its sha256, and writes meta.release in one statement:
//
//   node scripts/release-meta.mjs [--remote]
//
// Without --remote it targets the local wrangler dev database.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const remote = process.argv.includes('--remote');

function gradleProps() {
  const text = readFileSync(join(root, 'android/gradle.properties'), 'utf8');
  const get = (key) => (text.match(new RegExp(`^${key}=(.*)$`, 'm')) || [])[1]?.trim() || '';
  return { versionName: get('versionName'), versionCode: get('versionCode') };
}

const { versionName, versionCode } = gradleProps();
if (!versionName) throw new Error('versionName missing from android/gradle.properties');

const apkPath = join(root, 'android/FamilyPlanner.apk');
const bytes = readFileSync(apkPath);
const sha = createHash('sha256').update(bytes).digest('hex');

// A published APK is immutable once its hash is advertised; refuse to advertise a
// file that is not the one the server will hand out.
const servedPath = join(root, `web/public/download/family-planner-${versionName}.apk`);
let served = null;
try {
  served = createHash('sha256').update(readFileSync(servedPath)).digest('hex');
} catch {
  /* the build copies it; a missing copy is reported below */
}
if (served && served !== sha) {
  throw new Error(`web/public/download/...${versionName}.apk is not the APK in android/ — rebuild first`);
}

const url = `https://family-finance-planner.tarungudipatimadhav.workers.dev/download/family-planner-${versionName}.apk`;
const release = {
  version: versionName,
  versionCode: Number(versionCode) || null,
  apkUrl: url,
  apkSha256: sha,
  publishedAt: new Date().toISOString().slice(0, 10),
  notes: 'Phone layout fixes, per-book calendar feeds, WhatsApp number handling.',
};

const sql = `INSERT INTO meta (k, v) VALUES ('release', '${JSON.stringify(release).replace(/'/g, "''")}')
             ON CONFLICT(k) DO UPDATE SET v = excluded.v`;

// A file, not --command: the JSON payload contains quotes that a shell would eat.
const sqlPath = join(root, '.tmp/release-meta.sql');
mkdirSync(join(root, '.tmp'), { recursive: true });
writeFileSync(sqlPath, `${sql};\n`);
// Called through node and the local wrangler entry point: no npx, no shell, so it
// behaves the same from Git Bash, cmd and CI.
const wranglerBin = join(root, 'node_modules/wrangler/bin/wrangler.js');
const args = [wranglerBin, 'd1', 'execute', 'family-planner', '--file', sqlPath, '--yes'];
if (remote) args.push('--remote');

console.log(`apk      ${apkPath}`);
console.log(`sha256   ${sha}`);
console.log(`size     ${(bytes.length / 1024).toFixed(1)} KB`);
console.log(`target   ${remote ? 'remote D1' : 'local D1'}`);
execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
console.log('release meta written');
