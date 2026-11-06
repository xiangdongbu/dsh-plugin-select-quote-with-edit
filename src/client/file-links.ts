/**
 * 正文里的项目文件路径：悬停下划线、点击在右侧打开。
 *
 * 宿主把回答渲染成 markdown，路径要么躺在行内 `code` 里（
 * `staticAssets/plotly/plotly.min.html`），要么散在正文文字里。宿主自己只把
 * 显式链接（`[文字](路径)`）交给它的 openFile，裸路径一律当普通文本——所以
 * 这里补一遍：
 *
 * - 命中路径的行内 `code`：直接给该元素打标记（不包 anchor，避免破坏 code 的
 *   盒子与换行规则）；
 * - 正文文本节点里命中的片段：切成三段包成 `<a>`。**不带 href**——宿主与其他
 *   插件的链接拦截都只看 `href`，给了 href 就会被它们接管。
 * - 点击走一个 document 级代理，转成绝对路径后交给 `dsh-better-sidebar` 的
 *   `openFile(scope, path, title, { line })`，由它在右侧打开编辑器 tab。
 *
 * 两条硬约束：
 * 1. **流式输出中的消息不碰**。React 正在写那些文本节点，把它们拆开会让我们
 *    的片段停在旧文字上（消息看起来卡住）。所以按「静默 700ms 才动手」的节奏
 *    扫，另外跳过 `[data-streaming]` 子树。
 * 2. 拿不到服务就只提示、不改文字：宁可少一个链接，也不能让正文变形。
 *
 * 只扫 `[data-chat-flow-key]` 里 markdown 根（类名形如 `_markdown_<hash>_<n>`）
 * 之下的内容，插件自己的用户气泡（`.dsqe_row`）、代码块、已有链接一概跳过。
 */
import { t } from './i18n.ts'
import { runtime } from './runtime.ts'

/** 命中路径的元素都带这个属性（行内 code 与生成的 anchor 共用）。 */
export const LINK_ATTR = 'data-dsqe-filelink'
/** 悬停下划线的样式钩子（styles.ts）。 */
export const LINK_CLASS = 'dsqe_filelink'
/** 路径本身（可能含 `:行号`，行号单独存在 `data-dsqe-line`）。 */
const PATH_ATTR = 'data-dsqe-path'
const LINE_ATTR = 'data-dsqe-line'

/** markdown 根：CSS module 本地名固定含 markdown，hash 会随构建变。 */
const MARKDOWN = '[class*="markdown"]'
/** 聊天流里的一行（宿主写在每个 node 行上）。 */
const ROW = '[data-chat-flow-key]'
/** 不进去的位置：代码块、已有链接、可编辑区、插件自己的东西。 */
const SKIP = `pre, code, a, textarea, input, script, style, [contenteditable="true"], [${LINK_ATTR}]`
/** 内容静默这么久才动手（流式输出期间一直有新内容进来）。 */
const SETTLE_MS = 700
/** 巡检间隔：宿主把整块 DOM 换掉时不会留下任何线索，只能定期补扫。 */
const SWEEP_MS = 500

/**
 * 认作「文件」的扩展名。刻意不含 `com` / `io` / `app` / `dev` 这类顶级域名，
 * 否则正文里的 `example.com` 会被当成文件。
 */
const EXTENSIONS = [
  'astro', 'avif', 'bash', 'bat', 'bmp', 'c', 'cc', 'cfg', 'cjs', 'clj', 'cmd',
  'conf', 'config', 'cpp', 'cs', 'css', 'csv', 'cxx', 'dart', 'diff', 'env', 'ex',
  'exs', 'fish', 'gif', 'go', 'gradle', 'graphql', 'gql', 'gz', 'h', 'hbs', 'hh',
  'hpp', 'htm', 'html', 'ico', 'ini', 'ipynb', 'java', 'jpeg', 'jpg', 'js', 'json',
  'json5', 'jsonc', 'jsx', 'kt', 'kts', 'less', 'lock', 'log', 'lua', 'm', 'map',
  'md', 'mdx', 'mjs', 'ml', 'mm', 'patch', 'pdf', 'php', 'plist', 'png', 'properties',
  'proto', 'ps1', 'py', 'pyi', 'rb', 'rs', 'sass', 'scss', 'sh', 'sol', 'sql',
  'svelte', 'svg', 'swift', 'tar', 'tgz', 'toml', 'ts', 'tsv', 'tsx', 'txt', 'vue',
  'wasm', 'webp', 'xml', 'yaml', 'yml', 'zip',
]

/**
 * 扩展名的正则分支：**按长度倒序**，否则 `htm` 会先吃掉 `html`、`md` 会先吃掉
 * `mdx`——那样 `plotly.min.html` 会只匹配到 `.htm`，后面跟着的 `l` 又被右边
 * 边界判成"更长串的一部分"，整个 token 就被丢掉了。
 */
const EXT_SOURCE = [...EXTENSIONS].sort((left, right) => right.length - left.length).join('|')

/** 一个路径 token：可选前缀（`./` `../` `~/` `C:\`）+ 段 + 扩展名 + 可选 `:行`。 */
const TOKEN = String.raw`(?:\.{0,2}[\\/]|~[\\/]|[A-Za-z]:[\\/])?[A-Za-z0-9_.@+-]+(?:[\\/][A-Za-z0-9_.@+-]+)*\.(?:${EXT_SOURCE})(?::\d+(?:-\d+)?)?`

/** token 左边挨着这些字符说明它只是更长串的一部分（`x/a.ts`、`a.ts.md`）。 */
const LEFT_BAD = /[A-Za-z0-9_.@+\-\\/~]/
/** 右边同理（中文标点、空格、引号都是合法的结束）。 */
const RIGHT_BAD = /[A-Za-z0-9_\-\\/]/

export interface FileHit {
  /** 在原文里的起止（含头不含尾）。 */
  readonly start: number
  readonly end: number
  /** 命中的原文（保留 `:行` 后缀）。 */
  readonly raw: string
  /** 去掉行号后的路径。 */
  readonly path: string
  /** 路径后跟着的 `:12` / `:12-20` 里的起始行。 */
  readonly line?: number
}

/**
 * 从一段纯文本里找出文件路径（按出现顺序）。纯函数，可单测。
 *
 * 拒绝的形态：URL（`https://…`）、邮箱、`x.com` 这类域名、`a/b` 这种没扩展名
 * 的片段、以及被更长的词包住的片段。
 */
export function scanPaths(text: string): FileHit[] {
  if (text.length < 4) return []
  const hits: FileHit[] = []
  const pattern = new RegExp(TOKEN, 'g')
  for (const match of text.matchAll(pattern)) {
    const raw = match[0]
    const start = match.index ?? 0
    const end = start + raw.length
    const before = start > 0 ? text[start - 1] : ''
    if (before !== '' && LEFT_BAD.test(before)) continue
    if (end < text.length && RIGHT_BAD.test(text[end])) continue
    // `https://host/a.ts`：token 前面是 `//`，把它当路径就错了
    const head = text.slice(Math.max(0, start - 3), start)
    if (head.includes('://') || head.includes('@')) continue
    const suffix = /:(\d+)(?:-(\d+))?$/.exec(raw)
    const path = suffix === null ? raw : raw.slice(0, raw.length - suffix[0].length)
    if (path === '' || /^\.{1,2}$/u.test(path)) continue
    hits.push({ start, end, raw, path, ...(suffix === null ? {} : { line: Number(suffix[1]) }) })
  }
  return hits
}

/** 词法归一：合并 `//`、消掉 `.` / `..`（不碰真实磁盘，客户端读不到 fs）。 */
function normalizePath(path: string): string {
  const absolute = path.startsWith('/')
  const out: string[] = []
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (out.length > 0) out.pop()
      continue
    }
    out.push(segment)
  }
  const joined = out.join('/')
  return absolute ? `/${joined}` : joined
}

/**
 * 相对路径 → 以会话 cwd 为基准的绝对路径（`~` 与非绝对且无 cwd 时原样返回，
 * 让 host 侧按自己的规则展开）。纯函数，可单测。
 */
export function resolveAgainst(cwd: string | undefined, path: string): string {
  const trimmed = path.trim()
  if (trimmed === '') return trimmed
  if (trimmed.startsWith('~')) return trimmed
  const slashed = trimmed.replace(/\\/g, '/')
  if (slashed.startsWith('/') || /^[A-Za-z]:\//.test(slashed)) return normalizePath(slashed)
  if (cwd === undefined || cwd.trim() === '') return normalizePath(slashed)
  return normalizePath(`${cwd.trim().replace(/\\/g, '/').replace(/\/+$/u, '')}/${slashed}`)
}

/** 路径最后一段（tab 标题用）。 */
export function basenameOf(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter((part) => part !== '')
  return parts.length === 0 ? path : parts[parts.length - 1]
}

/** 最小可用形状：`dsh-better-sidebar` 的 `ctx.betterSidebar`。 */
export interface BetterSidebarLike {
  openFile?: (
    scope: { sessionId: string; cwd?: string },
    path: string,
    title?: string,
    options?: { line?: number; lineEnd?: number },
  ) => void
}

export interface FileLinkDeps {
  /** 当前会话 id（点击时读，可能还没绑定）。 */
  sessionId(): string | null
  /** 当前会话的工作目录（相对路径的基准）。 */
  cwd(): string | undefined
  /** 右侧栏服务（dsh-better-sidebar）；没装就是 null。 */
  service(): BetterSidebarLike | null
  /** 失败时的轻提示。 */
  hint(text: string): void
}

/** 从一个元素上取回应打开的路径（供点击代理与单测共用）。 */
export function linkOf(element: {
  getAttribute(name: string): string | null
}): { path: string; line?: number } | null {
  const path = element.getAttribute(PATH_ATTR)
  if (path === null || path.trim() === '') return null
  const raw = element.getAttribute(LINE_ATTR)
  const line = raw === null ? Number.NaN : Number(raw)
  return { path, ...(Number.isFinite(line) && line > 0 ? { line } : {}) }
}

/**
 * 打开一个正文里的路径。绝对路径化之后交给右侧栏；服务缺失只提示，不猜。
 * 单测通过 `deps` 注入假服务。
 */
export function openFileLink(
  path: string,
  line: number | undefined,
  deps: FileLinkDeps,
): boolean {
  const target = resolveAgainst(deps.cwd(), path)
  const sessionId = deps.sessionId()
  const service = deps.service()
  if (sessionId === null || service === null || typeof service.openFile !== 'function') {
    deps.hint(t('filelink.unavailable'))
    return false
  }
  const cwd = deps.cwd()
  const scope: { sessionId: string; cwd?: string } =
    cwd === undefined || cwd.trim() === '' ? { sessionId } : { sessionId, cwd }
  try {
    service.openFile(
      scope,
      target,
      basenameOf(target),
      line === undefined ? undefined : { line },
    )
    return true
  } catch {
    deps.hint(t('filelink.unavailable'))
    return false
  }
}

/** 给一个元素打上可点击路径的标记（行内 code 的路径，不改结构）。 */
function markElement(element: HTMLElement, hit: FileHit, cwd: string | undefined): void {
  element.setAttribute(LINK_ATTR, '')
  element.setAttribute(PATH_ATTR, hit.path)
  if (hit.line !== undefined) element.setAttribute(LINE_ATTR, String(hit.line))
  element.classList.add(LINK_CLASS)
  element.setAttribute('role', 'link')
  element.setAttribute('title', resolveAgainst(cwd, hit.path))
}

/** 建一个 anchor：不带 href，宿主/别的插件的链接拦截就接管不了它。 */
function createAnchor(hit: FileHit, cwd: string | undefined): HTMLAnchorElement {
  const anchor = document.createElement('a')
  anchor.className = LINK_CLASS
  anchor.setAttribute(LINK_ATTR, '')
  anchor.setAttribute(PATH_ATTR, hit.path)
  if (hit.line !== undefined) anchor.setAttribute(LINE_ATTR, String(hit.line))
  anchor.setAttribute('role', 'link')
  anchor.setAttribute('title', resolveAgainst(cwd, hit.path))
  anchor.textContent = hit.raw
  return anchor
}

/**
 * 把一个文本节点里命中的路径包成 anchor（前缀/中间/后缀各一段文本）。
 * 返回是否改动过 DOM。
 */
function splitTextNode(node: Text, cwd: string | undefined): boolean {
  const text = node.nodeValue ?? ''
  const hits = scanPaths(text)
  if (hits.length === 0) return false
  const fragment = document.createDocumentFragment()
  let cursor = 0
  for (const hit of hits) {
    if (hit.start > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, hit.start)))
    fragment.appendChild(createAnchor(hit, cwd))
    cursor = hit.end
  }
  if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)))
  node.replaceWith(fragment)
  return true
}

/** 扫一个 markdown 根：先标记行内 code，再把正文文本节点切开。 */
export function decorateRoot(root: HTMLElement, cwd: string | undefined): number {
  let changed = 0
  for (const code of Array.from(root.querySelectorAll<HTMLElement>('code'))) {
    if (code.closest('pre') !== null || code.hasAttribute(LINK_ATTR)) continue
    const text = (code.textContent ?? '').trim()
    if (text === '') continue
    const hits = scanPaths(text)
    if (hits.length !== 1 || hits[0].raw !== text) continue
    markElement(code, hits[0], cwd)
    changed += 1
  }

  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const parent = node.parentElement
      if (parent === null) return NodeFilter.FILTER_REJECT
      if (parent.closest(SKIP) !== null) return NodeFilter.FILTER_REJECT
      if ((node.nodeValue ?? '').trim().length < 4) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  while (walker.nextNode() !== null) {
    if (walker.currentNode instanceof Text) nodes.push(walker.currentNode)
  }
  for (const node of nodes) {
    // 上一个节点切开后可能连坐：节点已脱离文档就跳过
    if (!node.isConnected) continue
    if (splitTextNode(node, cwd)) changed += 1
  }
  return changed
}

/**
 * 常驻：把聊天流里正文的路径变成可点击。返回 teardown。
 *
 * 只在「内容静默 SETTLE_MS」之后动手——流式输出期间 React 正持有那些文本节点，
 * 拆开它会让文字停在旧内容上。
 */
export function watchFileLinks(deps: FileLinkDeps): () => void {
  try {
    const cwdOf = (): string | undefined => {
      try {
        return deps.cwd()
      } catch {
        return undefined
      }
    }
    /** 每个 markdown 根最后一次变化的时间。 */
    const touched = new WeakMap<Element, number>()
    const mark = (node: Node | null | undefined): void => {
      if (node === null || node === undefined) return
      const element = node instanceof Element ? node : node.parentElement
      if (element === null) return
      const root = element.closest(MARKDOWN)
      if (root !== null) touched.set(root, Date.now())
    }

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        mark(record.target)
        for (const node of Array.from(record.addedNodes)) mark(node)
        for (const node of Array.from(record.removedNodes)) mark(node)
      }
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })

    const sweep = (): void => {
      const now = Date.now()
      for (const root of Array.from(document.querySelectorAll<HTMLElement>(`${ROW} ${MARKDOWN}`))) {
        if (now - (touched.get(root) ?? 0) < SETTLE_MS) continue
        if (root.closest('[data-streaming]') !== null) continue
        // 插件自己的用户气泡（chip 气泡、引用详情）不掺和
        if (root.closest('.dsqe_row') !== null) continue
        try {
          decorateRoot(root, cwdOf())
        } catch {
          // 单条消息失败不影响其它
        }
      }
    }

    const onClick = (event: Event): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      const element = target.closest(`[${LINK_ATTR}]`)
      if (!(element instanceof HTMLElement)) return
      const link = linkOf(element)
      if (link === null) return
      event.preventDefault()
      event.stopPropagation()
      openFileLink(link.path, link.line, deps)
    }

    document.addEventListener('click', onClick, true)
    const timer = window.setInterval(sweep, SWEEP_MS)
    sweep()
    // 首帧之后再补两次：会话内容常在布局稳定之后才挂上来
    const timers = [400, 1500].map((delay) => window.setTimeout(sweep, delay))

    return () => {
      observer.disconnect()
      document.removeEventListener('click', onClick, true)
      window.clearInterval(timer)
      for (const id of timers) window.clearTimeout(id)
    }
  } catch {
    return () => {}
  }
}

/** 简单提示（复用 chrome 的提示条容器样式除外，这里自带内联样式）。 */
export function showFileHint(text: string): void {
  try {
    const hint = document.createElement('div')
    hint.className = 'dsqe_undoHint'
    hint.setAttribute('role', 'status')
    hint.textContent = text
    hint.style.position = 'fixed'
    hint.style.left = '50%'
    hint.style.bottom = '96px'
    hint.style.transform = 'translateX(-50%)'
    hint.style.zIndex = '2147483000'
    hint.style.padding = '8px 12px'
    hint.style.borderRadius = '8px'
    hint.style.fontSize = '12px'
    hint.style.color = '#fff'
    hint.style.background = 'rgba(0, 0, 0, 0.78)'
    hint.style.pointerEvents = 'none'
    document.body.appendChild(hint)
    window.setTimeout(() => hint.remove(), 3200)
  } catch {
    // 提示失败无所谓
  }
}

/** 当前会话 id：先看 composer 发布的那份，再看 sessions 列表的「当前」。 */
export function currentSessionId(sessions: unknown): string | null {
  if (runtime.sessionId !== null) return runtime.sessionId
  const snapshot = (sessions as { list?: { getSnapshot?: () => unknown } } | undefined)?.list?.getSnapshot?.()
  if (snapshot === null || typeof snapshot !== 'object') return null
  const record = snapshot as Record<string, unknown>
  for (const key of ['activeId', 'currentId', 'selectedId', 'activeSessionId', 'currentSessionId']) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

/** 会话 cwd：`sessions.list.getSnapshot().byId[id].cwd`（宿主列表摘要）。 */
export function cwdOfSession(sessions: unknown, sessionId: string | null): string | undefined {
  if (sessionId === null) return undefined
  const snapshot = (sessions as { list?: { getSnapshot?: () => unknown } } | undefined)?.list?.getSnapshot?.()
  if (snapshot === null || typeof snapshot !== 'object') return undefined
  const byId = (snapshot as { byId?: Record<string, unknown> }).byId
  if (byId === undefined || byId === null) return undefined
  const entry = byId[sessionId]
  if (entry === null || typeof entry !== 'object') return undefined
  const cwd = (entry as { cwd?: unknown }).cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}
