// Bundles the verifier for the browser (ESM, dependencies inlined) and as a Node CLI.
import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
})

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
})

console.log('built dist/index.js, dist/cli.js')
