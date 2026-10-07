// Bundles the local development server (API + in-process worker) with esbuild.
import { build, context } from 'esbuild';

const options = {
  entryPoints: { server: 'src/local/server.ts', seedFiles: 'src/local/seedFiles.ts' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outdir: 'dist/local',
  outExtension: { '.js': '.mjs' },
  sourcemap: true,
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('esbuild watching src/ …');
} else {
  await build(options);
}
