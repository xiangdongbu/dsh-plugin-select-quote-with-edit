/**
 * 会话标题钉住 —— 带引用胶囊的首条消息会污染宿主的自动标题。
 *
 * 宿主的 `session-title-first-prompt-llm` 用第一条用户消息的全文（含
 * `<dsh-quotes>` 协议块与长文本）喂标题模型，生成的标题是长文本开头
 * （如 "# Quoted references: Each…"），不是用户自己输入的那句话。
 *
 * 标题服务的契约里有官方逃生门：`rename` 写入的 `session/title` 事件
 * `source.kind === "user"` 会**永久钉住**标题——in-flight 的自动生成被
 * supersede，后续用户消息也不再调度生成（`SessionTitleService.onUserMessage`
 * 里 `source.kind === "user"` 直接 return；唯一的解锁路径是显式 refresh）。
 *
 * 所以：带胶囊且有自己输入文字的用户消息渲染时，用「自己输入的文字的
 * 第一行」调 `session.rename(title)`，标题就是用户的那句话。
 *
 * 触发条件（全部满足才动手，避免覆盖用户手动改名或 LLM 已生成的好标题）：
 * - 消息确实带引用胶囊（协议块），且自己输入的文字非空；
 * - 是会话的第一条用户消息（自动标题只在这一条上生成）；
 * - 消息时间新鲜（2 分钟内）——老会话重挂载时不碰已存在的标题；
 * - 该消息 seq 没有钉过（localStorage 记账，撤回重发可再次钉）。
 */
import { scanQuotes } from './protocol.ts'

const PIN_KEY = 'dsqe-title-pins'
/** 只钉很新的消息：老会话重挂载时不动已有标题（可能已被用户手动改名）。 */
const PIN_MAX_AGE_MS = 120_000
/** 标题取自己输入文字的首行，超长截断（宿主还会按字节再截一次）。 */
const TITLE_MAX_CHARS = 60

/** 从 wire 文本提取候选标题：带胶囊且自己输入了文字时，返回首行；否则 null。 */
export function titleFromRaw(raw: string): string | null {
  const scan = scanQuotes(raw)
  if (scan.quotes.length === 0) return null
  const typed = scan.rest.trim()
  if (typed === '') return null
  const line = typed
    .split(/\r?\n/u)
    .map((part) => part.trim())
    .find((part) => part.length > 0)
  if (line === undefined || line === '') return null
  return line.length > TITLE_MAX_CHARS ? `${line.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…` : line
}

function readPins(): Set<string> {
  try {
    const stored = localStorage.getItem(PIN_KEY)
    return new Set(stored === null ? [] : (JSON.parse(stored) as string[]))
  } catch {
    return new Set()
  }
}

function rememberPin(key: string): void {
  const pins = readPins()
  pins.add(key)
  try {
    // 只保留最近 500 条，防止 localStorage 无界增长
    localStorage.setItem(PIN_KEY, JSON.stringify([...pins].slice(-500)))
  } catch {
    // localStorage 满了就放弃记账（最坏情况是重发时重复 rename）
  }
}

export interface PinTitleSession {
  /** 客户端会话门面的改名 API（宿主标准化后写 `session/title` 事件）。 */
  rename?(title: string): Promise<unknown>
}

/**
 * 尝试钉标题。`isFirstUserRow`：这条消息是 DOM 里第一条用户行（首条消息
 * 才有自动标题要抢）。返回是否真的发起了 rename。
 */
export function maybePinSessionTitle(
  session: PinTitleSession | undefined,
  sessionId: string,
  seq: number | undefined,
  time: number | undefined,
  raw: string,
  isFirstUserRow: boolean,
): boolean {
  const dbg = (globalThis as { __dsqeDebug?: boolean }).__dsqeDebug === true
  const title = titleFromRaw(raw)
  if (title === null) {
    if (dbg) console.log('[dsqe] title:skip', { reason: 'no-typed-text-or-no-chips' })
    return false
  }
  if (!isFirstUserRow) {
    if (dbg) console.log('[dsqe] title:skip', { reason: 'not-first-user-row' })
    return false
  }
  if (session?.rename === undefined) {
    if (dbg) console.log('[dsqe] title:skip', { reason: 'no-rename-api' })
    return false
  }
  if (time === undefined || Date.now() - time > PIN_MAX_AGE_MS) {
    if (dbg) console.log('[dsqe] title:skip', { reason: 'stale', time })
    return false
  }
  const key = `${sessionId}:${seq ?? 'x'}`
  if (readPins().has(key)) return false
  rememberPin(key)
  if (dbg) console.log('[dsqe] title:pin', { sessionId: sessionId.slice(0, 12), title })
  try {
    const result = session.rename(title)
    if (result !== undefined && typeof result.catch === 'function') {
      result.catch((error: unknown) => {
        if (dbg) console.log('[dsqe] title:pin-failed', String(error))
      })
    }
  } catch (error) {
    if (dbg) console.log('[dsqe] title:pin-threw', String(error))
  }
  return true
}
