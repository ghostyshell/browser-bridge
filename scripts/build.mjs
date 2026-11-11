#!/usr/bin/env node
/**
 * Build every target with esbuild.
 *
 *   src/daemon     -> dist/daemon/server.js        (node, cjs)
 *   src/cli        -> dist/cli/chromectl.js        (node, cjs, shebang, +x)
 *   src/scripts    -> dist/scripts/*.js            (node, cjs, shebang, +x)
 *   src/extension  -> extension/*.js               (browser; statics stay in extension/)
 *
 * Extension statics (manifest, popup.html/css, icons) are already in
 * extension/ and are left untouched, so the unpacked extension keeps the same
 * directory and therefore the same extension id across rebuilds.
 */
import { build } from 'esbuild';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dev = process.argv.includes('--dev');

const common = {
  bundle: true,
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  logLevel: 'warning',
  target: 'node20',
};

const nodeTargets = [
  { entry: 'src/daemon/server.ts', out: 'dist/daemon/server.js', external: ['ws'] },
  { entry: 'src/cli/chromectl.ts', out: 'dist/cli/chromectl.js', banner: '#!/usr/bin/env node' },
  // these two carry their own shebang in source
  { entry: 'src/scripts/cdp-ext-eval.ts', out: 'dist/scripts/cdp-ext-eval.js', external: ['ws'] },
  { entry: 'src/scripts/cdp-load-extension.ts', out: 'dist/scripts/cdp-load-extension.js', external: ['ws'] },
];

const browserTargets = [
  { entry: 'src/extension/background.ts', out: 'extension/background.js' },
  { entry: 'src/extension/content.ts', out: 'extension/content.js' },
  { entry: 'src/extension/popup.ts', out: 'extension/popup.js' },
];

async function main() {
  await mkdir(join(root, 'dist'), { recursive: true });

  for (const t of nodeTargets) {
    const outfile = join(root, t.out);
    await mkdir(dirname(outfile), { recursive: true });
    await build({
      ...common,
      entryPoints: [join(root, t.entry)],
      outfile,
      platform: 'node',
      format: 'cjs',
      external: t.external ?? [],
      banner: t.banner ? { js: t.banner } : undefined,
    });
    if (t.banner || t.entry.includes('src/scripts/')) await chmod(outfile, 0o755);
    console.log(`built ${t.out}`);
  }
  await chmod(join(root, 'bin/chromectl'), 0o755);

  for (const t of browserTargets) {
    await build({
      ...common,
      entryPoints: [join(root, t.entry)],
      outfile: join(root, t.out),
      platform: 'browser',
      format: 'iife',
      target: 'chrome116',
      minify: false,
    });
    console.log(`built ${t.out}`);
  }
}

await rm(join(root, 'dist/cli/.keep'), { force: true });
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
