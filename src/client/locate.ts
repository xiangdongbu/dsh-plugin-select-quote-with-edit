/**
 * 「定位原文」—— 点击输入框里的引用胶囊，滚到消息里那段原文并给它划下划线。
 *
 * 难点不在滚动，而在**把引用文本找回它原来所在的 DOM 位置**：
 * - 渲染后的 markdown 把一句话拆成多个 text node（`但 ` + `<code>node_modules</code>`
 *   + ` 里…`），所以只能按「整行拍平后的字符串」匹配，再把命中区间反查回
 *   (node, offset) 造一个 `Range`；
 * - 换行、缩进、块级元素之间在 DOM 里没有空白，人眼看到却有 —— 归一化时把
 *   连续空白压成一个空格，并在跨块边界补一个虚拟空格；
 * - 引用是从消息里选出来的，所以同一段文字出现多次时取**最后一个**：离输入框
 *   最近的那一处，才几乎总是用户刚选的那一处。
 *
 * 这里只做定位与状态，不画东西：下划线由 `source-mark.tsx` 用 `Range` 的
 * client rects 叠在 `document.body` 上，绝不改写消息 DOM —— React 托管的节点
 * 一旦被我们包一层 span，下一次 diff 就可能抛 "node to be removed"。
 */

const SKIP_SELECTOR = [
  // The resident composer: the draft must never be matched against itself.
  '[data-composer-card]',
  // Our own chrome: chips, hover previews, drawer, sidebar pane, inline editor.
  '.dsqe-chip',
  '.dsqe-tipWrap',
  '.dsqe-drawer',
  '.dsqe-sideWrap',
  '.dsqe_editor',
  'script',
  'style',
  'noscript',
  'textarea',
].join(',')

/** Tag names that never introduce a block boundary on their own. */
const INLINE_TAGS = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'BR', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN', 'EM',
  'I', 'INS', 'KBD', 'LABEL', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG',
  'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR',
])

/** Shortest prefix worth retrying when the full selection cannot be matched. */
const NEEDLE_FALLBACK_LENGTHS = [120, 60, 30]
const MIN_NEEDLE = 8

export type LocateResult = 'located' | 'missing' | 'off'

export interface SourceMark {
  readonly range: Range
  /** The transcript container the range lives in (used to clip the underlines). */
  readonly root: Element
  /** Chip that produced the mark; clicking the same chip again clears it. */
  readonly quoteId?: string
  /** Bumped per locate, so React remounts the underline layer. */
  readonly token: number
}

export interface QuoteChunk {
  readonly text: string
  /**
   * True when this text node opens a new block (`<p>`, `<li>`, `<pre>`…). A
   * space is implied at that boundary even though the DOM carries none.
   */
  readonly blockStart?: boolean
}

export interface QuoteIndex {
  /** Whitespace-normalized text of the whole row. */
  readonly text: string
  /** Per normalized char: index into the chunk list (-1 for a virtual space). */
  readonly owner: readonly number[]
  /** Per normalized char: offset inside that chunk (-1 for a virtual space). */
  readonly offset: readonly number[]
  /** Per chunk: normalized index of its first kept char (-1 when it kept none). */
  readonly starts: readonly number[]
}

export interface QuoteMatch {
  readonly start: number
  readonly end: number
}

const ZERO_WIDTH = /[\u200b\ufeff]/g

/**
 * Canonical form of a quote for matching: zero-width characters dropped
 * (the composer draft carries one), whitespace runs collapsed, ends trimmed —
 * exactly what `buildIndex` does to the transcript.
 */
export function normalizeQuote(text: string): string {
  return text.replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim()
}

/**
 * Match candidates, longest first. A selection that crossed a collapsed code
 * block or a table can never match verbatim; its opening clause usually still
 * does, and that is enough to land the reader in the right place.
 */
export function candidateNeedles(text: string): string[] {
  const full = normalizeQuote(text)
  if (!full) return []
  const out: string[] = [full]
  for (const length of NEEDLE_FALLBACK_LENGTHS) {
    if (full.length <= length) continue
    const prefix = full.slice(0, length).replace(/\s+$/, '')
    if (prefix.length >= MIN_NEEDLE && !out.includes(prefix)) out.push(prefix)
  }
  return out
}

/** Flatten chunks into one normalized string plus the reverse mapping. */
export function buildIndex(chunks: readonly QuoteChunk[]): QuoteIndex {
  const chars: string[] = []
  const owner: number[] = []
  const offset: number[] = []
  const starts: number[] = new Array<number>(chunks.length).fill(-1)
  let pendingSpace = false
  /** A space has already been emitted for the boundary we are standing on. */
  let spacedAtBoundary = false

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex]
    const text = chunk.text
    if (!text) continue
    // A block boundary implies one space even when the DOM carries none. A
    // whitespace-only node between the two blocks emits that space itself (it
    // is a boundary too), so the following block must not add a second one.
    if (chars.length > 0 && chunk.blockStart === true) {
      if (!spacedAtBoundary) {
        chars.push(' ')
        owner.push(-1)
        offset.push(-1)
        spacedAtBoundary = true
      }
      pendingSpace = false
    }
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index]
      if (char === '\u200b' || char === '\ufeff') continue
      if (/\s/.test(char)) {
        pendingSpace = true
        continue
      }
      if (pendingSpace && chars.length > 0) {
        chars.push(' ')
        owner.push(-1)
        offset.push(-1)
      }
      pendingSpace = false
      spacedAtBoundary = false
      if (starts[chunkIndex] === -1) starts[chunkIndex] = chars.length
      chars.push(char)
      owner.push(chunkIndex)
      offset.push(index)
    }
  }

  return { text: chars.join(''), owner, offset, starts }
}

/** Last occurrence of any candidate — the one nearest the composer. */
export function findMatch(index: QuoteIndex, needles: readonly string[]): QuoteMatch | null {
  if (index.text.length === 0) return null
  for (const needle of needles) {
    if (!needle) continue
    const at = index.text.lastIndexOf(needle)
    if (at >= 0) return { start: at, end: at + needle.length }
  }
  return null
}

// ---------------------------------------------------------------- DOM side

function isInline(element: Element | null): boolean {
  return element === null || INLINE_TAGS.has(element.tagName)
}

/** Nearest block-level ancestor of a text node, bounded by the search root. */
function blockOwnerOf(node: Node, root: Element): Element {
  let element = node.parentElement
  while (element !== null && element !== root) {
    if (!isInline(element)) return element
    element = element.parentElement
  }
  return root
}

function collectChunks(root: Element): { chunks: QuoteChunk[]; nodes: Text[] } {
  const chunks: QuoteChunk[] = []
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let previousBlock: Element | null = null
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const textNode = node as Text
    if (textNode.data.length === 0) continue
    const parent = textNode.parentElement
    if (parent === null) continue
    if (parent.closest(SKIP_SELECTOR) !== null) continue
    const block = blockOwnerOf(textNode, root)
    const blockStart = previousBlock !== null && block !== previousBlock
    previousBlock = block
    chunks.push({ text: textNode.data, blockStart })
    nodes.push(textNode)
  }
  return { chunks, nodes }
}

function rangeFor(index: QuoteIndex, nodes: readonly Text[], match: QuoteMatch): Range | null {
  const startChunk = index.owner[match.start]
  const endChunk = index.owner[match.end - 1]
  if (startChunk === undefined || endChunk === undefined) return null
  if (startChunk < 0 || endChunk < 0) return null
  const startNode = nodes[startChunk]
  const endNode = nodes[endChunk]
  if (startNode === undefined || endNode === undefined) return null
  const startOffset = index.offset[match.start]
  const endOffset = index.offset[match.end - 1]
  if (startOffset < 0 || endOffset < 0) return null
  const range = document.createRange()
  try {
    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset + 1)
  } catch {
    return null
  }
  return range
}

function scrollerOf(element: Element): HTMLElement | null {
  let node: Element | null = element.parentElement
  while (node !== null) {
    const style = window.getComputedStyle(node)
    if (/(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 4) {
      return node as HTMLElement
    }
    node = node.parentElement
  }
  return null
}

/** The transcript scroller: the host's own hook first, then geometry. */
function transcriptRoot(): Element | null {
  if (typeof document === 'undefined') return null
  const explicit = document.querySelector('[data-conversation-scroll]')
  if (explicit !== null) return explicit
  const rows = document.querySelectorAll('[data-chat-flow-key]')
  if (rows.length > 0) {
    const last = rows[rows.length - 1]
    const scroller = scrollerOf(last)
    if (scroller !== null) return scroller
    // No scrollable ancestor: use the closest element that contains every row.
    const first = rows[0]
    let node: Element = last
    while (node.parentElement !== null && !node.parentElement.contains(first)) {
      node = node.parentElement
    }
    return node.parentElement ?? node
  }
  const composer = document.querySelector('[data-composer-card]')
  return composer === null ? null : scrollerOf(composer)
}

function scrollRangeIntoView(range: Range, root: Element): void {
  if (typeof window === 'undefined') return
  if (!range.startContainer.isConnected) return
  const style = window.getComputedStyle(root)
  const scroller =
    /(auto|scroll|overlay)/.test(style.overflowY) ? (root as HTMLElement) : (scrollerOf(root) ?? null)
  if (scroller === null) return
  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return
  const box = scroller.getBoundingClientRect()
  if (box.height === 0) return
  const delta = rect.top - box.top - box.height / 2 + rect.height / 2
  if (Math.abs(delta) < 6) return
  try {
    scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: 'smooth' })
  } catch {
    scroller.scrollTop += delta
  }
}

// ---------------------------------------------------------------- state

let mark: SourceMark | null = null
let token = 0
let missingToken = 0
const markListeners = new Set<() => void>()
const missingListeners = new Set<() => void>()

function notifyMark(): void {
  for (const listener of markListeners) listener()
}

function notifyMissing(): void {
  for (const listener of missingListeners) listener()
}

export function getSourceMark(): SourceMark | null {
  return mark
}

export function subscribeSourceMark(listener: () => void): () => void {
  markListeners.add(listener)
  return () => {
    markListeners.delete(listener)
  }
}

export function getMissingToken(): number {
  return missingToken
}

export function subscribeMissing(listener: () => void): () => void {
  missingListeners.add(listener)
  return () => {
    missingListeners.delete(listener)
  }
}

export function clearSourceMark(): void {
  if (mark === null) return
  mark = null
  notifyMark()
}

function miss(): LocateResult {
  missingToken += 1
  notifyMissing()
  return 'missing'
}

/**
 * Locate `text` in the transcript, scroll it to the middle of the viewport and
 * mark it. Clicking the chip that owns the current mark toggles it off.
 */
export function locateQuote(text: string, quoteId?: string): LocateResult {
  const active = mark
  if (active !== null && quoteId !== undefined && active.quoteId === quoteId) {
    clearSourceMark()
    return 'off'
  }
  const needles = candidateNeedles(text)
  if (needles.length === 0) return miss()
  const root = transcriptRoot()
  if (root === null) return miss()
  const { chunks, nodes } = collectChunks(root)
  const index = buildIndex(chunks)
  const match = findMatch(index, needles)
  if (match === null) return miss()
  const range = rangeFor(index, nodes, match)
  if (range === null) return miss()
  token += 1
  mark = { range, root, token, ...(quoteId !== undefined ? { quoteId } : {}) }
  notifyMark()
  scrollRangeIntoView(range, root)
  return 'located'
}

export interface SourceLine {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/**
 * Where to paint the underline: one line per client rect, clipped against the
 * transcript viewport so nothing bleeds over the header or the composer.
 */
export function linesOf(source: SourceMark): SourceLine[] {
  const range = source.range
  if (!range.startContainer.isConnected) return []
  let clip: { top: number; bottom: number; left: number; right: number }
  try {
    const box = source.root.getBoundingClientRect()
    clip = { top: box.top, bottom: box.bottom, left: box.left, right: box.right }
  } catch {
    return []
  }
  // Never paint over the composer: it sits above the transcript in z-order and
  // would otherwise be covered by an underline that scrolled underneath it.
  const composer = document.querySelector('[data-composer-card]')
  if (composer !== null) {
    const card = composer.getBoundingClientRect()
    if (card.top > clip.top) clip.bottom = Math.min(clip.bottom, card.top - 2)
  }
  const lines: SourceLine[] = []
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width <= 0 || rect.height <= 0) continue
    const top = Math.max(rect.top, clip.top)
    const bottom = Math.min(rect.bottom, clip.bottom)
    if (bottom - top < 2) continue
    const left = Math.max(rect.left, clip.left)
    const right = Math.min(rect.right, clip.right)
    if (right - left <= 0) continue
    lines.push({ left, top, width: right - left, height: bottom - top })
  }
  return lines
}
