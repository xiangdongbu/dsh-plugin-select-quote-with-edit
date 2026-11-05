/**
 * 概览条幽灵标记 —— 撤回后右侧「轮次导航」仍显示已撤回的轮次。
 *
 * 宿主的 `turnOutline` projection 是全日志的纯折叠（只认 turn/start、
 * user/message、assistant/message、turn/end 四种事件），不知道撤回插件
 * 追加的面遮蔽标记——被撤回的轮次永远留在概览条里（变 `markUnloaded`，
 * 「加载并跳转」过去也只有被遮蔽的空行）。宿主侧不可改，只能在客户端
 * 把对应的标记按钮藏掉。
 *
 * 定位被撤回轮次的方法：概览条的悬停预览（`role=tooltip`）显示该轮的
 * prompt 预览文本，宿主用与 `dsh-session-turn-outline` 相同的 preview
 * 算法从消息文本块计算。撤回成功后我们知道被撤回消息的 wire 文本，
 * 按同一算法算出预览并**记账待匹配**；rail 任何时刻出现（撤回当下、
 * 切会话回来、刷新）都在 observer 节流循环里逐个悬停标记按钮、比对
 * tooltip 文本，命中的按钮从 aria-label 里取轮次号转正为幽灵记账；
 * MutationObserver 持续把幽灵轮次的标记按钮 `display: none`（React
 * 重渲染后再次隐藏）。
 */
import { chatSnapshotOf, type UiConversationLike } from './withdraw.ts'
import { runtime } from './runtime.ts'

const GHOST_KEY = 'dsqe-ghost-turns'
const PENDING_KEY = 'dsqe-ghost-pending'
const HEALED_KEY = 'dsqe-ghost-healed'
/** 与宿主 `dsh-session-turn-outline` 的 PROMPT_PREVIEW_LIMIT 一致。 */
const PREVIEW_LIMIT = 50
/** 待匹配的重试间隔（observer 回调触发频繁，节流匹配尝试）。 */
const MATCH_RETRY_MS = 3000
/** 待匹配条目与会话记账的上限，防止 localStorage 无界增长。 */
const MAX_RECORDS = 20

/**
 * 复刻宿主的 rail 预览算法：文本块以空格拼接、折叠空白、按 50 字符截断
 * （`normalized.length > limit - 1` 时 `slice(0, limit - 1).trimEnd()` 加省略号）。
 */
export function previewOfWire(raw: string): string {
  const normalized = raw.replace(/\s+/gu, ' ').trim()
  if (normalized.length > PREVIEW_LIMIT - 1) {
    return `${normalized.slice(0, PREVIEW_LIMIT - 1).trimEnd()}…`
  }
  return normalized
}

/**
 * localStorage 的带内存镜像读写：无 localStorage 的环境（单测、受限容器）
 * 退化为内存存储，记账逻辑照常可测、可运行。
 */
const memoryStore: Record<string, string> = {}

function lsGet(key: string): string | null {
  try {
    const stored = localStorage.getItem(key)
    return stored === null ? (memoryStore[key] ?? null) : stored
  } catch {
    return memoryStore[key] ?? null
  }
}

function lsSet(key: string, value: string): void {
  memoryStore[key] = value
  try {
    localStorage.setItem(key, value)
  } catch {
    // localStorage 满了就只用内存镜像（最坏情况是重启后记账失效）
  }
}

function readJson<T>(key: string, fallback: T): T {
  const stored = lsGet(key)
  if (stored === null) return fallback
  try {
    return JSON.parse(stored) as T
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  lsSet(key, JSON.stringify(value))
}

function ghostsFor(sessionId: string): number[] {
  const all = readJson<Record<string, number[]>>(GHOST_KEY, {})
  return all[sessionId] ?? []
}

function rememberGhost(sessionId: string, turn: number): void {
  const all = readJson<Record<string, number[]>>(GHOST_KEY, {})
  const list = all[sessionId] ?? []
  if (!list.includes(turn)) list.push(turn)
  const keys = Object.keys(all)
  const trimmed = keys.length > MAX_RECORDS ? Object.fromEntries(keys.slice(-MAX_RECORDS).map((k) => [k, all[k]])) : all
  trimmed[sessionId] = list
  writeJson(GHOST_KEY, trimmed)
}

/** 撤回预览的待匹配账本：sessionId → preview（rail 出现前先落账）。 */
interface PendingEntry {
  readonly sessionId: string
  readonly preview: string
}

function pendingList(): PendingEntry[] {
  return readJson<PendingEntry[]>(PENDING_KEY, [])
}

/** 调试/测试钩子：当前待匹配账本。 */
export function pendingEntriesOf(sessionId: string): PendingEntry[] {
  return pendingList().filter((entry) => entry.sessionId === sessionId)
}

function writePending(list: PendingEntry[]): void {
  writeJson(PENDING_KEY, list.slice(-MAX_RECORDS))
}

/** rail 的标记按钮：类名带 mark 的、aria-label 带轮次数字的 button。 */
function markButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button[class*="mark"][aria-label]')).filter(
    (button) => /\d/.test(button.getAttribute('aria-label') ?? ''),
  )
}

function turnOfButton(button: HTMLButtonElement): number | undefined {
  const match = (button.getAttribute('aria-label') ?? '').match(/(\d+)/u)
  return match === null ? undefined : Number(match[1])
}

/** 悬停一个标记按钮并读取 tooltip 的 prompt 预览文本（异步：等 React 渲染）。 */
async function previewOfMark(button: HTMLButtonElement): Promise<string | null> {
  button.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, 80)
  })
  const nav = button.closest('nav')
  // 宿主的 tooltip（role=tooltip）里第一个子元素是 prompt 预览、第二个是
  // response 预览——只读 prompt，与记账的 previewOfWire 对齐。
  const tooltip = nav?.querySelector('[role="tooltip"]')
  const prompt = tooltip?.firstElementChild?.textContent ?? tooltip?.textContent ?? null
  nav?.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }))
  return prompt === null || prompt === '' ? null : prompt
}

/** 撤回成功后调用：把被撤回消息的 rail 预览记入待匹配账本。永不抛错。 */
export function ghostWithdrawnTurn(sessionId: string, previewText: string): void {
  try {
    if (previewText === '') return
    const list = pendingList().filter((entry) => entry.sessionId !== sessionId || entry.preview !== previewText)
    list.push({ sessionId, preview: previewText })
    writePending(list)
    ensureGhostObserver()
    const dbg = (globalThis as { __dsqeDebug?: boolean }).__dsqeDebug === true
    if (dbg) console.log('[dsqe] rail:pending', { sessionId: sessionId.slice(0, 12), preview: previewText })
  } catch {
    // 概览条过滤是纯体验优化，任何失败都静默
  }
}

/** 文本块拼接（宿主 rail 预览的输入与消息 content 的文本块一致）。 */
function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      parts.push(String((block as { text?: unknown }).text ?? ''))
    }
  }
  return parts.join(' ')
}

/**
 * 开账自愈：扫描会话快照里被遮蔽（visibility=hidden）的用户消息，把它们的
 * rail 预览补记入待匹配账本。覆盖所有「撤回发生在记账逻辑之外」的场景——
 * 旧版本撤回的、桌面端还没重启就撤回的——否则那些幽灵标记永远留在概览条上。
 * 按 seq 记账去重（dsqe-ghost-healed），只在会话绑定变化时调用。
 */
export function healGhostBookkeeping(
  sessionId: string,
  getUiConversation: () => UiConversationLike | undefined,
): void {
  try {
    const snapshot = chatSnapshotOf(getUiConversation(), sessionId)
    const nodes = snapshot?.nodes
    if (nodes === undefined || typeof nodes.values !== 'function') return
    const healed = readJson<Record<string, number[]>>(HEALED_KEY, {})
    const done = healed[sessionId] ?? []
    let changed = false
    for (const node of nodes.values()) {
      if (node?.visibility !== 'hidden') continue
      const key = String((node as { key?: unknown }).key ?? '')
      // 用户消息行的 key 形如 `13:input-message<uuid>`；撤回目标之后的助手
      // 行也被遮蔽，但它们不该进概览条记账。
      if (!key.includes('input-message')) continue
      const seq = (node as { data?: { seq?: unknown } }).data?.seq
      if (typeof seq !== 'number') continue
      if (done.includes(seq)) continue
      const preview = previewOfWire(textOfContent(node.data?.content))
      if (preview === '') continue
      done.push(seq)
      changed = true
      const list = pendingList().filter((entry) => entry.sessionId !== sessionId || entry.preview !== preview)
      list.push({ sessionId, preview })
      writePending(list)
      const dbg = (globalThis as { __dsqeDebug?: boolean }).__dsqeDebug === true
      if (dbg) console.log('[dsqe] rail:heal', { sessionId: sessionId.slice(0, 12), seq, preview })
    }
    if (changed) {
      const keys = Object.keys(healed)
      const trimmed =
        keys.length > MAX_RECORDS
          ? Object.fromEntries(keys.slice(-MAX_RECORDS).map((k) => [k, healed[k]]))
          : healed
      trimmed[sessionId] = done.slice(-200)
      writeJson(HEALED_KEY, trimmed)
    }
  } catch {
    // 自愈是纯体验优化，任何失败都静默
  }
}

/** 尝试把待匹配预览对到 rail 标记上：命中即转正为幽灵记账。 */
async function tryMatchPending(): Promise<void> {
  const sessionId = runtime.sessionId
  if (sessionId === null) return
  const pending = pendingList().filter((entry) => entry.sessionId === sessionId)
  if (pending.length === 0) return
  const buttons = markButtons()
  if (buttons.length === 0) return
  for (const button of buttons) {
    const shown = await previewOfMark(button)
    if (shown === null) continue
    // 精确匹配优先；前缀兜底——宿主对 loaded 轮次的预览截断路径可能与
    // outline 的 50 字符算法略有出入。
    const hit =
      pending.find((entry) => entry.preview === shown) ??
      pending.find(
        (entry) =>
          entry.preview.slice(0, 30) === shown.slice(0, 30) ||
          shown.startsWith(entry.preview.slice(0, 30)),
      )
    if (hit === undefined) continue
    const turn = turnOfButton(button)
    if (turn === undefined) return
    rememberGhost(sessionId, turn)
    writePending(pendingList().filter((entry) => !(entry.sessionId === hit.sessionId && entry.preview === hit.preview)))
    const dbg = (globalThis as { __dsqeDebug?: boolean }).__dsqeDebug === true
    if (dbg) console.log('[dsqe] rail:ghost', { sessionId: sessionId.slice(0, 12), turn, preview: hit.preview })
    applyGhostFilter()
    return
  }
}

let lastMatchAttempt = 0

/** 把当前会话记账轮次的标记按钮藏掉；顺带节流地补匹配待定预览。 */
function applyGhostFilter(): void {
  const sessionId = runtime.sessionId
  if (sessionId === null) return
  const ghosts = ghostsFor(sessionId)
  for (const button of markButtons()) {
    const turn = turnOfButton(button)
    if (turn === undefined) continue
    const ghost = ghosts.includes(turn)
    if (ghost) {
      button.style.display = 'none'
      button.setAttribute('data-dsqe-ghost', 'true')
    } else if (button.getAttribute('data-dsqe-ghost') === 'true') {
      button.style.display = ''
      button.removeAttribute('data-dsqe-ghost')
    }
  }
  const now = Date.now()
  if (pendingList().some((entry) => entry.sessionId === sessionId) && now - lastMatchAttempt > MATCH_RETRY_MS) {
    lastMatchAttempt = now
    void tryMatchPending()
  }
}

let observer: MutationObserver | null = null
let scheduled = false

/** 安装一次性的 DOM 观察器：概览条重渲染后重新应用过滤（rAF 合帧）。 */
export function ensureGhostObserver(): void {
  if (observer !== null) return
  observer = new MutationObserver(() => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      applyGhostFilter()
    })
  })
  observer.observe(document.body, { childList: true, subtree: true })
}
