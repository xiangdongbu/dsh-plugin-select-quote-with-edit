/**
 * 把 lib/ 的产物推给桌面客户端已安装的副本（宿主 500ms stat 热更新；换包版本
 * 仍需重启客户端）。用法：
 *
 *   npm run sync:desktop                     # 同步一次
 *   npm run sync:desktop -- --watch          # 常驻，lib/ 变化即推送
 *   npm run sync:desktop -- --profile web    # 指定 profile（默认 desktop）
 *
 * 前提：插件已安装到 <DSH_HOME>/profiles/<profile>/node_modules/<包名>。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const libDir = resolve(root, 'lib')
const log = (message) => console.log(`[${pkg.name}] ${message}`)
const fail = (message) => {
  console.error(`[${pkg.name}] ${message}`)
  process.exit(1)
}

const argv = process.argv.slice(2)
const flagValue = (name) => {
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) fail(`--${name} needs a value`)
  return value
}
const profile = flagValue('profile') ?? process.env.DSH_PROFILE ?? 'desktop'
const watch = argv.includes('--watch')

const installedDir = join(
  process.env.DSH_HOME || join(homedir(), '.dsh'),
  'profiles',
  profile,
  'node_modules',
  pkg.name,
)
const targetDir = join(installedDir, 'lib')

if (!existsSync(targetDir)) {
  fail(
    `no installed bundle at ${targetDir}\n` +
      `  先把插件装进 "${profile}" profile（npm publish 后安装，或手动复制整个包目录），再运行本脚本。`,
  )
}

function bundleFiles() {
  return readdirSync(libDir).filter((name) => statSync(join(libDir, name)).isFile())
}

function bundleSignature() {
  return bundleFiles()
    .map((name) => {
      const stats = statSync(join(libDir, name))
      return `${name}:${stats.mtimeMs}:${stats.size}`
    })
    .join('|')
}

function sync() {
  const written = []
  for (const name of bundleFiles()) {
    const source = join(libDir, name)
    const target = join(targetDir, name)
    // Compare bytes, not mtimes: rewriting identical bytes would trigger a
    // pointless hot reload (the host stats the file signature).
    if (existsSync(target) && readFileSync(target).equals(readFileSync(source))) continue
    writeFileSync(target, readFileSync(source))
    written.push(name)
  }
  return written
}

const first = sync()
if (first.length === 0) log(`profile "${profile}" bundle already matches ${libDir}`)
else log(`synced ${first.join(', ')} -> ${targetDir}`)

if (!watch) process.exit(0)

log(`watching ${libDir} (Ctrl-C to stop)`)
let signature = bundleSignature()
const timer = setInterval(() => {
  const next = bundleSignature()
  if (next === signature) return
  signature = next
  const written = sync()
  if (written.length > 0) log(`pushed ${written.join(', ')} — the plugin reloads`)
}, 300)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearInterval(timer)
    process.exit(0)
  })
}
