/**
 * Strip quote protocol blocks from transient host surfaces that render the
 * submitted text verbatim: the optimistic send echo (`[data-submission-echo]`)
 * and the queued-messages preview (`[data-queue-dock]`).
 *
 * dsh-plugin-select-quote-simple ships an identical stripper; both can be
 * active at once — rewriting is idempotent (a stripped node has no markers
 * left), and a `storage`-style double pass is harmless.
 */

import { QUOTES_OPEN, QUOTES_CLOSE, scanQuotes } from './protocol.ts'

const SURFACES = '[data-submission-echo],[data-queue-dock]'

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
    rewriteTextNode(root as Text)
    return
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return
  const element = root as Element
  if (!element.matches(SURFACES) && !element.querySelector(SURFACES)) return
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
