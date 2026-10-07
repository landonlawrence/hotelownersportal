// Bundles each Lambda handler into dist/lambda/<name>/index.mjs for CDK assets.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const handlers = ['api', 'worker', 'emailReceiver', 'scanResult', 'scheduler'];
rmSync('dist', { recursive: true, force: true });
for (const name of handlers) {
  await build({
    entryPoints: [`src/lambda/${name}.ts`],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: `dist/lambda/${name}/index.mjs`,
    sourcemap: true,
    minify: true,
    // AWS SDK v3 is provided by the Lambda runtime.
    external: ['@aws-sdk/*'],
    banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
    logLevel: 'warning',
  });
}
console.log(`Built ${handlers.length} Lambda bundles`);
