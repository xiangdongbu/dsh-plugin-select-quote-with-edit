/**
 * Strip quote protocol blocks from transient host surfaces that render the
 * submitted text verbatim: the optimistic send echo (`[data-submission-echo]`)
 * and the queued-messages preview (`[data-queue-dock]`).
 *
 * dsh-plugin-select-quote-simple ships an identical stripper; both can be
 * active at once — rewriting is idempotent (a stripped node has no markers
 * left), and a `storage`-style double pass is harmless.
 */

import { QUOTES_CLOSE, QUOTES_HEADER_HINT, QUOTES_OPEN, scanQuotes } from './protocol.ts'

const SURFACES = '[data-submission-echo],[data-queue-dock]'

/**
 * 遮罩标记：带引用的回显行在「原始 wire 文本」和「我们的气泡」之间那一小段。
 *
 * 为什么不只是剥文本：协议块是**多行**的（`Quoted references:` 头部 + JSON），
 * 宿主把它交给 markdown 渲染后会拆成好几个节点（标题、段落、代码块），于是
 * `rewriteTextNode` 这种「同一个文本节点里找开闭标签」的写法接不住 —— 开标签在
 * 一段、闭标签在另一段，`close < 0` 直接返回，半截 JSON 就露出来了。跨节点改写
 * 要动 React 拥有的结构，风险更大；回显本来就是瞬态的，所以这里按可见性遮住，
 * 等 `[data-dsqe-quote-bubble]` 出现（我们的气泡接手）或超时再放出来。
 *
 * `visibility: hidden` 而不是 `display: none`：保留高度，气泡接手时列表不跳动。
 */
const CONCEAL_ATTR = 'data-dsqe-quote-echo'

/** 遮罩最长存在时间；再多就宁可露出原文，也不能让消息一直看不见。 */
const CONCEAL_MS = 900

/** 这段文本是不是「带引用块的 wire 文本」（渲染后的样子也算）。 */
function looksLikeQuoteWire(text: string): boolean {
  if (text.includes(QUOTES_OPEN)) return true
  return text.includes('Quoted references:') && text.includes(QUOTES_HEADER_HINT)
}

/**
 * 把回显行遮起来，直到我们的气泡接手 / 协议块消失 / 超时。
 *
 * 只遮会话流里的回显行：排队区（`[data-queue-dock]`）里的那份是列表预览，
 * 遮掉会让人以为消息丢了，那边继续只做文本剥离。
 */
function concealEcho(surface: Element): void {
  if (surface.hasAttribute(CONCEAL_ATTR)) return
  if (surface.closest('[data-queue-dock]') !== null) return
  if (!looksLikeQuoteWire(surface.textContent ?? '')) return
  surface.setAttribute(CONCEAL_ATTR, '1')
  let settled = false
  const reveal = (): void => {
    if (settled) return
    settled = true
    surface.removeAttribute(CONCEAL_ATTR)
    inner.disconnect()
    clearTimeout(timer)
  }
  const inner = new MutationObserver(() => {
    // 只认「我们自己的气泡接手了」。不能用「协议块不见了」当条件 —— 剥离是我们
    // 自己做的，剥完立刻满足那条，遮罩会马上失效，于是又回到「先看到一条没有
    // 胶囊的裸文本」。剩余情况交给 CONCEAL_MS 超时兜底。
    if (surface.querySelector('[data-dsqe-quote-bubble]') !== null) reveal()
  })
  inner.observe(surface, { childList: true, subtree: true, characterData: true })
  const timer = setTimeout(reveal, CONCEAL_MS)
}

function rewriteTextNode(node: Text): void {
  const value = node.nodeValue
  if (!value || !value.includes(QUOTES_OPEN)) return
  const parent = node.parentElement
  if (!parent || !parent.closest(SURFACES)) return
  const open = value.indexOf(QUOTES_OPEN)
  const close = value.indexOf(QUOTES_CLOSE, open + QUOTES_OPEN.length)
  if (close < 0) return
  node.nodeValue = scanQuotes(value).rest
}

function stripWithin(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    // 同样先遮再剥（理由见下面的块分支）。
    const surface = (root as Text).parentElement?.closest(SURFACES) ?? null
    if (surface !== null) concealEcho(surface)
    rewriteTextNode(root as Text)
    return
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return
  const element = root as Element
  const own = element.matches(SURFACES) ? element : null
  const nested = element.querySelector(SURFACES)
  if (own === null && nested === null) return
  // 先遮再剥：剥完就认不出「这行本来带协议块」了，而遮罩正是靠这个特征决定
  // 要不要藏 —— 顺序反了就会出现「先看到一条没有胶囊的裸文本，过一会儿胶囊才来」。
  if (own !== null) concealEcho(own)
  for (const surface of Array.from(element.querySelectorAll(SURFACES))) concealEcho(surface)
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let current = walker.nextNode()
  while (current) {
    rewriteTextNode(current as Text)
    current = walker.nextNode()
  }
}

export function watchQuoteEchoStrip(): () => void {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') {
        stripWithin(record.target)
        continue
      }
      for (const node of record.addedNodes) stripWithin(node)
    }
  })
  const root = document.body ?? document.documentElement
  if (root) {
    observer.observe(root, { childList: true, characterData: true, subtree: true })
    stripWithin(root)
  }
  return () => observer.disconnect()
}
