/**
 * 体检：仓库构建 ↔ 桌面端已安装副本 ↔ profile 依赖锁定，三者是不是同一个版本。
 *
 * 为什么需要这个脚本：桌面端 profile 的依赖是用 pnpm 从 GitHub 装的，锁文件里
 * 钉的是某个 commit。插件管理器每次装/卸插件都会重跑一次 install，把
 * `node_modules/<包名>` **整目录还原成锁文件里的那个 commit**——于是本地
 * `sync:desktop` 推上去的构建会被静默换回旧版，表现就是「刚才还好好的，一重启
 * 或者一装别的插件，按钮/修复又没了」。
 *
 * 用法：npm run doctor
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const profileArg = process.argv[2]
const profile =
  process.env.DSH_PROFILE ?? (profileArg !== undefined && !profileArg.startsWith('--') ? profileArg : 'desktop')
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(home, 'profiles', profile)
const installedDir = join(profileDir, 'node_modules', pkg.name)

const say = (mark, text) => console.log(`${mark} ${text}`)
const TODO = []

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

// ---- 1. 仓库 ----------------------------------------------------------------
const repoBundle = resolve(root, 'lib/client.js')
say('·', `仓库            ${root}`)
say('·', `仓库版本        v${pkg.version}`)
if (!existsSync(repoBundle)) {
  say('✘', 'lib/client.js 不存在 —— 先跑 npm run build')
} else {
  say('·', `仓库构建        ${statSync(repoBundle).size} 字节，${statSync(repoBundle).mtime.toISOString()}`)
}

// ---- 2. 已安装副本 ----------------------------------------------------------
if (!existsSync(installedDir)) {
  say('✘', `未安装到 profile "${profile}"：${installedDir}`)
  say(' ', `  装上之后才能用 npm run sync:desktop`)
} else {
  const installedPkgPath = join(installedDir, 'package.json')
  const installedBundle = join(installedDir, 'lib/client.js')
  const installedVersion = existsSync(installedPkgPath)
    ? JSON.parse(readFileSync(installedPkgPath, 'utf8')).version
    : '(缺 package.json)'
  const sameBytes =
    existsSync(installedBundle) && existsSync(repoBundle)
      ? readFileSync(installedBundle).equals(readFileSync(repoBundle))
      : false

  say(sameBytes ? '✔' : '✘', `已安装版本      v${installedVersion}${sameBytes ? '' : `（与仓库构建不同步）`}`)
  if (!sameBytes) {
    TODO.push('复制当前构建到已安装副本：npm run sync:desktop')
  }
  if (installedVersion !== pkg.version) {
    TODO.push(`已安装副本是 v${installedVersion}，仓库是 v${pkg.version}：先 npm run sync:desktop，再完全退出客户端重开`)
  }

  // 关键内容抽查：这些符号只在某个版本之后才有，用来看「装的是不是带修复的构建」
  if (existsSync(installedBundle)) {
    const code = readFileSync(installedBundle, 'utf8')
    const markers = [
      ['槽位 children 声明（0.7.12：否则 node 视图崩溃、宿主回退、编辑/撤回按钮消失）', 'renderSlotChain'],
      ['轮次导航幽灵标记（0.7.16+）', 'ghostTurnsOf'],
      ['操作带预留（0.7.18+）', 'dsqe_rowOwnActions'],
    ]
    for (const [label, marker] of markers) {
      const ok = code.includes(marker)
      say(ok ? '✔' : '✘', `${label}`)
      if (!ok) TODO.push(`已安装副本缺少「${label}」——只能 sync，别指望重启`)
    }
  }
}

// ---- 3. profile 依赖锁定 ----------------------------------------------------
const profileManifest = join(profileDir, 'package.json')
const lockPath = join(profileDir, 'pnpm-lock.yaml')
if (existsSync(profileManifest)) {
  const manifest = JSON.parse(readFileSync(profileManifest, 'utf8'))
  const spec = (manifest.dependencies ?? {})[pkg.name] ?? (manifest.devDependencies ?? {})[pkg.name] ?? '(未声明)'
  say('·', `profile 依赖    ${spec}`)

  if (existsSync(lockPath)) {
    const lock = readFileSync(lockPath, 'utf8')
    // 锁文件里对 git 依赖记的是 codeload tarball 的 commit
    const pin = new RegExp(
      `codeload\\.github\\.com/[^/]+/${pkg.name}/tar\\.gz/([0-9a-f]{40})`,
      'u',
    ).exec(lock)
    const head = git(['rev-parse', 'HEAD'])
    if (pin === null) {
      say('·', '锁文件提交      未锁定 git 版本（可能是本地 link / registry 版本）')
    } else if (head !== '' && pin[1] === head) {
      say('✔', `锁文件提交      ${pin[1].slice(0, 8)}（= 本地 HEAD）`)
    } else if (head !== '' && spec.includes(head)) {
      // 依赖已经指到本地 HEAD，只是锁文件还记着旧 commit：下一次 install 会
      // 重新解析成新 commit。这期间已安装副本不会被换回旧版，属可接受状态。
      say('·', `锁文件提交      ${pin[1].slice(0, 8)}（依赖已指向 ${head.slice(0, 8)}，下次安装自动重解析）`)
    } else {
      say('✘', `锁文件提交      ${pin[1].slice(0, 8)}${head === '' ? '' : `（本地 HEAD 是 ${head.slice(0, 8)}）`}`)
      TODO.push(
        `锁文件钉的是 ${pin[1].slice(0, 8)}：插件管理器下次装/卸插件时会把已安装副本还原成那个 commit。` +
          `把 profile 依赖改成 github:xiangdongbu/${pkg.name}#${head || '<本地HEAD>'}。`,
      )
    }
  }
}

// ---- 4. 结论 ----------------------------------------------------------------
console.log('')
if (TODO.length === 0) {
  console.log('✔ 一切一致：仓库构建 = 已安装副本，且 profile 锁定的就是本地 HEAD。')
} else {
  console.log('需要处理：')
  for (const item of TODO) console.log(`  - ${item}`)
}
