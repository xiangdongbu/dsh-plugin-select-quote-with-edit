/**
 * 概览条幽灵标记 —— 撤回后右侧「轮次导航」仍显示已撤回的轮次。
 *
 * 宿主的 `turnOutline` projection 是全日志的纯折叠（只认 turn/start、
 * user/message、assistant/message、turn/end 四种事件），不知道撤回插件
 * 追加的遮蔽标记。rail 的 items = outline ∪ 已加载轮次，而
 * `turnNavigationItem` 会用 `isVisibleChatNode` 把整轮被遮蔽的项剔掉 ——
 * 于是被撤回的轮次只剩 outline 那一份，永远留在概览条上（还是
 * `markUnloaded`，「加载并跳转」过去也只有空行）。宿主侧不可改，只能在
 * 客户端把对应的标记按钮藏掉。
 *
 * 0.7.16 起不猜，直接读号：撤回不删日志、只追加遮蔽标记，
 * `dsh-rewind-plugin` 把被遮蔽的行标成 `visibility: 'hidden'`，而每个 Chat
 * 快照节点都带 `location.turn.turn` —— 正是概览条上的 turn 号。扫一遍
 * 快照把「被撤回的轮次号」收下来，按号藏标记即可。
 *
 * 旧实现（0.7.14–0.7.15）是悬停每个标记读 tooltip 的 50 字预览再比对文本，
 * 有三个致命问题，全部在这版消失：
 *   - 同一句话撤回多次（同文本）时账本按预览去重，只能藏掉一个；
 *   - 合成的 `pointermove` 不会让宿主的 tooltip 立刻换文本，读到上一条
 *     残留文本 → 张冠李戴，把没撤回的轮次藏了；
 *   - 已加载轮次的预览来自窗口、未加载的来自 outline，两者截断路径不同。
 *
 * 局限：只有落在当前加载窗口里的轮次才看得见。窗口外的老轮次无从判断，
 * 保留它的标记 —— 宁可多一个标记，不可藏错。
 */
import { chatSnapshotOf, type UiConversationLike } from './withdraw.ts'

/** 记账键。0.7.16 换新键，旧键（按预览文本匹配时代）里可能有错账，直接丢弃。 */
const GHOST_KEY = 'dsqe-ghost-turns-v2'
const LEGACY_KEYS = ['dsqe-ghost-turns', 'dsqe-ghost-pending', 'dsqe-ghost-healed']
/** 单会话 / 总会话的记账上限，防止 localStorage 无界增长。 */
const MAX_TURNS = 200
const MAX_SESSIONS = 40
/** 观察器里补扫快照的节流间隔。 */
const SYNC_THROTTLE_MS = 1200
/**
 * 撤回成功后补扫的延迟序列：遮蔽标记由 rewind 插件异步落盘，快照重建也
 * 不是同步的，单次扫描经常扫空。
 */
const SYNC_RETRY_MS = [80, 250, 700, 1600, 3000] as const

/** Chat 快照节点的结构切片（`dsh-rewind-plugin` 与本模块读的是同一批字段）。 */
interface ChatNodeSlice {
  readonly key?: unknown
  readonly kind?: unknown
  readonly visibility?: unknown
  readonly anchorSeq?: unknown
  readonly location?: { readonly kind?: unknown; readonly turn?: { readonly turn?: unknown } }
  readonly data?: { readonly seq?: unknown; readonly role?: unknown; readonly content?: unknown }
}

interface SnapshotSlice {
  readonly nodes?: unknown
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

function lsRemove(key: string): void {
  delete memoryStore[key]
  try {
    localStorage.removeItem(key)
  } catch {
    // 删不掉也无所谓：新键不复用旧数据
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

/** 一次性清掉按预览文本匹配时代的旧账本（键名不同，留着只会添乱）。 */
function dropLegacyBookkeeping(): void {
  for (const key of LEGACY_KEYS) lsRemove(key)
}

function allGhosts(): Record<string, number[]> {
  const stored = readJson<Record<string, number[]>>(GHOST_KEY, {})
  if (stored === null || typeof stored !== 'object') return {}
  return stored
}

/** 当前会话记账的幽灵轮次号（升序）。调试与测试入口。 */
export function ghostTurnsOf(sessionId: string): number[] {
  const list = allGhosts()[sessionId]
  return Array.isArray(list) ? list.filter((turn) => typeof turn === 'number') : []
}

function rememberGhostTurns(sessionId: string, turns: readonly number[]): void {
  const all = allGhosts()
  const list = all[sessionId] ?? []
  let changed = false
  for (const turn of turns) {
    if (!list.includes(turn)) {
      list.push(turn)
      changed = true
    }
  }
  if (!changed) return
  list.sort((left, right) => left - right)
  all[sessionId] = list.slice(-MAX_TURNS)
  const keys = Object.keys(all)
  const trimmed =
    keys.length > MAX_SESSIONS
      ? Object.fromEntries(keys.slice(-MAX_SESSIONS).map((key) => [key, all[key]]))
      : all
  writeJson(GHOST_KEY, trimmed)
}

/** 节点属于用户消息行（宿主 Chat 节点 kind 为 `user`；兼容旧版 key 形式）。 */
function isUserRow(node: ChatNodeSlice): boolean {
  if (node.kind === 'user') return true
  const key = typeof node.key === 'string' ? node.key : ''
  return key.includes('input-message')
}

/** 节点所属轮次号 —— 概览条上的 turn。 */
function turnOfNode(node: ChatNodeSlice): number | undefined {
  const turn = node.location?.turn?.turn
  if (typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0) return turn
  return undefined
}

/**
 * 快照里被遮蔽（撤回）的用户消息行 → 轮次号。纯函数，便于单测。
 * assistant / command / turn-process 行被遮蔽是撤回的连带结果，不进记账。
 */
export function hiddenTurnsIn(snapshot: unknown): number[] {
  const nodes = (snapshot as SnapshotSlice | undefined)?.nodes as
    | { values?: () => Iterable<ChatNodeSlice> }
    | undefined
  if (nodes === undefined || typeof nodes.values !== 'function') return []
  const turns = new Set<number>()
  for (const node of nodes.values()) {
    if (node === null || typeof node !== 'object') continue
    if (node.visibility !== 'hidden') continue
    if (!isUserRow(node)) continue
    const turn = turnOfNode(node)
    if (turn !== undefined) turns.add(turn)
  }
  return [...turns].sort((left, right) => left - right)
}

/**
 * 扫一遍会话快照，把被撤回轮次的编号补记入账（幂等）。返回本会话当前账目。
 * `getUiConversation` 用来拿当前绑定会话的 Chat 快照；快照没就绪时不清账。
 */
export function syncGhostTurns(
  sessionId: string,
  getUiConversation: () => UiConversationLike | undefined,
): number[] {
  try {
    const snapshot = chatSnapshotOf(getUiConversation(), sessionId)
    const found = hiddenTurnsIn(snapshot)
    if (found.length > 0) {
      rememberGhostTurns(sessionId, found)
      const dbg = (globalThis as { __dsqeDebug?: boolean }).__dsqeDebug === true
      if (dbg) console.log('[dsqe] rail:sync', { sessionId: sessionId.slice(0, 12), turns: found })
    }
  } catch {
    // 概览条过滤是纯体验优化，任何失败都静默
  }
  return ghostTurnsOf(sessionId)
}

/** 当前绑定的会话与其快照读取器（由 composer bridge 发布）。 */
interface GhostSession {
  readonly sessionId: string
  readonly getUi: () => UiConversationLike | undefined
}

let bound: GhostSession | null = null
let lastSyncAt = 0
const retryTimers = new Set<number>()

function clearRetries(): void {
  for (const timer of retryTimers) window.clearTimeout(timer)
  retryTimers.clear()
}

/** 立即扫一次 + 重排标记可见性。 */
function syncNow(): void {
  if (bound === null) return
  lastSyncAt = Date.now()
  syncGhostTurns(bound.sessionId, bound.getUi)
  applyGhostFilter()
}

/**
 * 短期内多扫几次：撤回刚发生时遮蔽标记还没落盘，切会话回来时快照可能还
 * 在重建。永不抛错。
 */
export function syncGhostsSoon(): void {
  if (bound === null) return
  clearRetries()
  syncNow()
  for (const delay of SYNC_RETRY_MS) {
    const timer = window.setTimeout(() => {
      retryTimers.delete(timer)
      syncNow()
    }, delay)
    retryTimers.add(timer)
  }
}

/**
 * 绑定当前会话（composer bridge 在会话切换时调用）。`sessionId` 为 null 时
 * 只解绑，不动账本。
 */
export function setGhostSession(
  sessionId: string | null,
  getUiConversation?: (() => UiConversationLike | undefined) | null,
): void {
  clearRetries()
  if (sessionId === null) {
    bound = null
    return
  }
  bound = { sessionId, getUi: getUiConversation ?? (() => undefined) }
  dropLegacyBookkeeping()
  ensureGhostObserver()
  syncGhostsSoon()
}

/**
 * rail 的标记按钮：宿主 `TurnMark` 渲染的 `button`（类名含 mark、带
 * `data-index`、aria-label 形如「跳转到第 3 轮」）。旧版宿主没有
 * `data-index` 时退回只看类名 + aria-label。
 */
function markButtons(): HTMLButtonElement[] {
  const strict = Array.from(
    document.querySelectorAll<HTMLButtonElement>('button[class*="mark"][data-index][aria-label]'),
  )
  const candidates =
    strict.length > 0
      ? strict
      : Array.from(document.querySelectorAll<HTMLButtonElement>('button[class*="mark"][aria-label]'))
  return candidates.filter((button) => /\d/u.test(button.getAttribute('aria-label') ?? ''))
}

/**
 * 从标记按钮的 aria-label 里取轮次号。宿主的两个文案模板都只带一个数字：
 * 「跳转到第 N 轮」/「加载并跳转到第 N 轮」/「Jump to turn N」。
 */
export function turnOfLabel(label: string): number | undefined {
  const match = label.match(/(\d+)/u)
  return match === null ? undefined : Number(match[1])
}

function turnOfButton(button: HTMLButtonElement): number | undefined {
  return turnOfLabel(button.getAttribute('aria-label') ?? '')
}

/** 把当前会话记账轮次的标记按钮藏掉；顺带节流补扫快照。 */
function applyGhostFilter(): void {
  if (bound === null) return
  const ghosts = ghostTurnsOf(bound.sessionId)
  for (const button of markButtons()) {
    const turn = turnOfButton(button)
    if (turn === undefined) continue
    if (ghosts.includes(turn)) {
      button.style.display = 'none'
      button.setAttribute('data-dsqe-ghost', 'true')
    } else if (button.getAttribute('data-dsqe-ghost') === 'true') {
      button.style.display = ''
      button.removeAttribute('data-dsqe-ghost')
    }
  }
  if (Date.now() - lastSyncAt > SYNC_THROTTLE_MS) syncNow()
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
