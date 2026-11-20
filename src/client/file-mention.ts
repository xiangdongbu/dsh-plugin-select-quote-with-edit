/**
 * 拖入的文件 / 文件夹：线格式与解析规则（纯函数，无 DOM、无 React）。
 *
 * 输入框里的胶囊由宿主的 `reference-chip` 节点承担（见 inline-chips.ts），
 * 但**发送出去的消息只是一段文本** —— 所以胶囊在消息里的形态必须是可解析的
 * 纯文本：文件 `@/abs/path`，文件夹 `@/abs/path/`（尾斜杠就是目录标记，
 * 模型读起来也自然）。这里给出这层线格式的正反两向实现，以及正文渲染用的
 * user-text 规则；两边共用同一份解析，避免发送与显示各写一套。
 */

/** 一个被引用的文件或文件夹。`path` 永远是不带尾斜杠的绝对路径。 */
export interface FileMention {
  readonly path: string
  readonly directory: boolean
}

/** 正文里那一小段文字的解析结果（含它在消息文本里的位置）。 */
export interface ParsedMention extends FileMention {
  readonly start: number
  readonly end: number
}

/** 正文节点 id：user-text 规则与 `conversation.user.text.node` 的 entryKey。 */
export const FILE_NODE_ID = 'dsqe-file'

/** 把这些字符当作路径的终点：空白、引号、常见的中英文标点。 */
const STOP_RE = /[\s"'<>()[\]{}，。、；：？！「」『』（）]/u

/**
 * 中日韩字符。
 *
 * 路径本身可以含中文（`/Users/bu/Downloads/109沪金今日涨幅-SSE.json`），所以
 * 不能一见到 CJK 就截断；但用户经常紧贴着写文案（`…-SSE.json今天几号`），
 * 于是补一条：**路径已经以 `扩展名` 收尾之后**再遇到 CJK，就当作文案的开始。
 * 这样 `…/109沪金…json` 里的中文照旧是路径，而 `.json今天几号` 的「今天几号」不会
 * 被吞进胶囊。
 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u
/** 已经形成「文件名.扩展名」的结尾。 */
const EXT_TAIL_RE = /\.[A-Za-z0-9]{1,8}$/u

/** 路径里出现控制字符或引号就不当引用（宿主自己也是这么判的）。 */
const FORBIDDEN_RE = /[\u0000-\u001f\u007f-\u009f"]/u

/**
 * 归一化一条路径：反斜杠转正斜杠、去掉尾斜杠、拒绝相对路径。
 * 返回 null = 不是一条能当引用的绝对路径。
 */
export function normalizePath(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (FORBIDDEN_RE.test(trimmed)) return null
  const slashed = trimmed.replace(/\\/g, '/')
  const absolute = slashed.startsWith('/') || /^[A-Za-z]:\//u.test(slashed)
  if (!absolute) return null
  const body = slashed.replace(/\/+$/u, '')
  if (body === '' || body === '/') return null
  return body
}

/** 文件名（文件夹带尾斜杠），胶囊上显示的那一小段。 */
export function displayName(path: string, directory: boolean): string {
  const clean = normalizePath(path) ?? path
  const parts = clean.split('/').filter((part) => part !== '')
  const name = parts.length === 0 ? clean : (parts[parts.length - 1] as string)
  return directory ? `${name}/` : name
}

/** 消息文本里的线格式：文件 `@/abs`，文件夹 `@/abs/`，含空格时加引号。 */
export function mentionText(path: string, directory: boolean): string {
  const clean = normalizePath(path) ?? path
  const text = directory ? `${clean}/` : clean
  return /\s/u.test(text) ? `@"${text}"` : `@${text}`
}

/** 从一条 `@…` 线格式里取回路径（解析失败返回 null）。 */
export function parseMentionText(mention: string): FileMention | null {
  const trimmed = mention.trim()
  if (!trimmed.startsWith('@')) return null
  let body = trimmed.slice(1)
  if (body.startsWith('"')) {
    if (!body.endsWith('"') || body.length < 3) return null
    body = body.slice(1, -1)
  }
  const directory = body.endsWith('/')
  const clean = normalizePath(body)
  if (clean === null) return null
  return { path: clean, directory }
}

/** 拖拽/粘贴里 `file://` URI 列表的第一条文件路径。 */
export function pathFromUriList(text: string): string | null {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (!/^file:\/\//iu.test(trimmed)) continue
    try {
      const url = new URL(trimmed)
      const decoded = decodeURIComponent(url.pathname)
      // Windows 的 `file:///C:/x` 会解成 `/C:/x`
      const withoutSlash = /^\/[A-Za-z]:\//u.test(decoded) ? decoded.slice(1) : decoded
      const clean = normalizePath(withoutSlash)
      if (clean !== null) return clean
    } catch {
      continue
    }
  }
  return null
}

/**
 * 从正文的 `at` 位置尝试读一条引用。
 *
 * 只认 `@` 后面紧跟绝对路径的写法（`@/…`、`@"/…"`、`@"C:/…"`）。
 * 邮箱这类 `a@/x` 由「@ 前是单词字符就不认」挡掉；空路径与
 * 只有一段的路径（`@/x`）也不认，避免误伤普通文本。
 */
export function parseMentionAt(text: string, at: number): ParsedMention | null {
  if (text[at] !== '@') return null
  const before = at > 0 ? (text[at - 1] as string) : ''
  if (before !== '' && /[\w.+-]/u.test(before)) return null

  let cursor = at + 1
  const quoted = text[cursor] === '"'
  if (quoted) cursor += 1

  const head = text[cursor] ?? ''
  const windows = /[A-Za-z]/u.test(head) && text[cursor + 1] === ':'
  if (!(head === '/' || (windows && (text[cursor + 2] === '/' || text[cursor + 2] === '\\')))) {
    return null
  }

  const start = cursor
  while (cursor < text.length) {
    const char = text[cursor] as string
    if (quoted) {
      if (char === '"') break
    } else if (STOP_RE.test(char)) {
      break
    } else if (CJK_RE.test(char) && EXT_TAIL_RE.test(text.slice(start, cursor))) {
      // `…/a.json今天几号`：扩展名之后的中文是文案，不是路径。
      break
    }
    cursor += 1
  }
  if (quoted && text[cursor] !== '"') return null

  const raw = text.slice(start, cursor)
  const directory = raw.endsWith('/')
  const clean = normalizePath(raw)
  if (clean === null) return null
  if (clean.split('/').filter((part) => part !== '').length < 2) return null

  const end = quoted ? cursor + 1 : cursor
  return { start: at, end, path: clean, directory }
}

/**
 * 正文渲染规则：把消息里的 `@/abs/path` 识别成我们自己的引用节点。
 *
 * `order` 比宿主的 `session`（10）更小：同起点时先选我们，宿主的
 * 文件引用只认工作区内的相对路径（`@src/a.ts`），两者不会抢。
 */
export const fileMentionRule = {
  id: FILE_NODE_ID,
  order: 5,
  match(text: string, from: number): { id: string; start: number; end: number; data: FileMention } | undefined {
    for (let start = text.indexOf('@', from); start >= 0; start = text.indexOf('@', start + 1)) {
      const hit = parseMentionAt(text, start)
      if (hit === null) continue
      return {
        id: FILE_NODE_ID,
        start: hit.start,
        end: hit.end,
        data: { path: hit.path, directory: hit.directory },
      }
    }
    return undefined
  },
}

/** 正文里所有引用，按出现顺序（纯文本气泡自己渲染时用）。 */
export function mentionsInText(text: string): ParsedMention[] {
  const out: ParsedMention[] = []
  let from = 0
  while (from < text.length) {
    const hit = fileMentionRule.match(text, from)
    if (hit === undefined) break
    out.push({ ...hit.data, start: hit.start, end: hit.end })
    from = hit.end
  }
  return out
}
