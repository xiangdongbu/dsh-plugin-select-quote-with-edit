import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const libDir = resolve(root, 'lib')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

mkdirSync(libDir, { recursive: true })

/**
 * Client half: bundle the browser module with esbuild (react stays external —
 * the host module table provides it through `require`) and wrap it in the
 * ModuleLoader preamble the dsh web client expects at /plugins/<id>/client.js.
 */
async function buildClient() {
  const outDir = resolve(libDir, '.client-build')
  rmSync(outDir, { recursive: true, force: true })
  await build({
    entryPoints: [resolve(root, 'src/client/index.tsx')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'transform',
    outfile: resolve(outDir, 'index.js'),
    external: ['react', 'react-dom', 'react-dom/client'],
    logLevel: 'info',
  })
  const rawPath = [resolve(outDir, 'index.js'), resolve(outDir, 'index.cjs')].find((candidate) =>
    existsSync(candidate),
  )
  if (!rawPath) throw new Error('client build produced no output')
  const raw = readFileSync(rawPath, 'utf8').replace(
    /^Object\.defineProperty\(exports, Symbol\.toStringTag, \{ value: "Module" \}\);\s*/m,
    '',
  )
  const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${raw}
\t\treturn module.exports;
\t}
});
`
  writeFileSync(resolve(libDir, 'client.js'), wrapped)
  rmSync(outDir, { recursive: true, force: true })
  console.log(`[dsh-plugin-select-quote-with-edit] wrote ${resolve(libDir, 'client.js')}`)
}

/** Host half: the Node entry the Loader resolves by package name. */
async function buildHost() {
  await build({
    entryPoints: [resolve(root, 'src/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    outfile: resolve(libDir, 'index.js'),
    logLevel: 'info',
  })
  console.log(`[dsh-plugin-select-quote-with-edit] wrote ${resolve(libDir, 'index.js')}`)
}

await buildHost()
await buildClient()
