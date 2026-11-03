// Build: icons -> static site (dist/) -> deploy bundle (build/) + root deploy manifest.

import { build as viteBuild } from 'vite';
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { makeIcons } from './make-icons.mjs';

await makeIcons();
await viteBuild({ configFile: 'vite.config.js' });

await rm('build', { recursive: true, force: true });
await mkdir('build/static', { recursive: true });

await esbuild.build({
  entryPoints: ['src/worker.js'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  outfile: 'build/worker.js',
});

await cp('dist', 'build/static', { recursive: true });

// The hosting uploader accepts JS/text/JSON/WASM assets only: icons are served by
// the Worker itself (/icon-*.png) and security headers live in the HTML + Worker.
for (const file of await readdir('build/static')) {
  if (file.endsWith('.png') || file === '_headers') await rm(`build/static/${file}`);
}

const manifest = {
  entrypoint: 'worker.js',
  compatibilityDate: '2025-09-01',
  modules: [{ name: 'worker.js', type: 'esm', path: './build/worker.js' }],
  assetsDirectory: './build/static',
  spa: true,
};
await writeFile('deploy.json', `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile('build/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

console.log('Build complete: dist/ (web + PWA), build/ (worker.js + static/), deploy.json');
