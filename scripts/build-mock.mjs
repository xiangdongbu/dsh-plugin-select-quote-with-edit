/** Build the mock dsh host (test/mock/mock-host.tsx → mock-host.js, IIFE). */
import { build } from 'esbuild'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: [resolve(root, 'test/mock/mock-host.tsx')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'transform',
  outfile: resolve(root, 'test/mock/mock-host.js'),
  // React is bundled INTO the mock (it only exists here to play the host);
  // the plugin's own bundle keeps react external and resolves it through the
  // require table this mock installs.
  logLevel: 'info',
})
console.log('[mock] wrote test/mock/mock-host.js')
