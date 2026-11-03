/**
 * Copying a composer draft that holds chips.
 *
 * Select-all in the composer used to copy only the typed characters: a chip is
 * a `contenteditable=false` decorator span whose only text is its label, and
 * the host's own copy path projects it to the invisible U+FFFC placeholder. So
 * the clipboard lost the quotes entirely.
 *
 * Here we take over `copy` / `cut` for the composer only, and write a payload
 * the paste side can rebuild exactly:
 *
 * - `text/plain` — the selection with each chip inlined as its label, so other
 *   apps still see something sensible;
 * - `text/html` — the same visual, plus a `<!--dsh-quote-data:…-->` comment
 *   carrying `{ v: 2, text, quotes: [{ text, long?, at? }] }`. Pasting it back
 *   restores the quotes as chips at the recorded offsets (see paste.ts).
 *
 * Everything except a selection that actually contains one of our chips is
 * left to the browser.
 */

import { QUOTE_SOURCE } from './inline-chips.ts'
import { chipLabel } from './protocol.ts'
import { getQuotes } from './store.ts'

const CHIP_SELECTOR = `[data-composer-chip="${QUOTE_SOURCE}"]`
const COMPOSER_ROOT = '[data-lexical-editor="true"]'
const COMPOSER_CARD = '[data-composer-card]'

/** One chip inside the copied range, with its offset in the copied text. */
interface CopiedChip {
  readonly at: number
  readonly text: string
  readonly long?: boolean
}

interface CopiedFragment {
  /** The selection's own text: chips are cut out, their offsets recorded. */
  readonly text: string
  readonly chips: readonly CopiedChip[]
  /** The same content with each chip spelled out as its label (plain paste). */
  readonly readable: string
  /** `text/html` body: labels wrapped in a marker span. */
  readonly html: string
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const BLOCK_TAGS = new Set([
  'ADDRESS',
  'BLOCKQUOTE',
  'DIV',
  'LI',
  'OL',
  'P',
  'PRE',
  'TABLE',
  'UL',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
])

/** Serialize one cloned range into text-with-chip-offsets + readable html. */
function serialize(fragment: DocumentFragment): CopiedFragment {
  const quotes = getQuotes()
  let text = ''
  let readable = ''
  let html = ''
  /** Block boundaries collapse: an empty paragraph must not add a line. */
  let pendingBreak = 0
  const chips: CopiedChip[] = []

  const flushBreaks = (): void => {
    if (pendingBreak > 0 && (text.length > 0 || html.length > 0)) {
      const breaks = '\n'.repeat(pendingBreak)
      text += breaks
      readable += breaks
      html += breaks
    }
    pendingBreak = 0
  }

  const emitText = (value: string): void => {
    // Zero-width fillers are the plugin's own caret scaffolding, never user
    // content: copying them makes the paste re-insert invisible characters
    // that eat the first Backspace presses after a paste-back.
    const cleaned = value.replace(/[\u200b\ufeff]/gu, '')
    if (cleaned.length === 0) return
    flushBreaks()
    text += cleaned
    readable += cleaned
    html += escapeHtml(cleaned)
  }

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      emitText(node.nodeValue ?? '')
      return
    }
    if (!(node instanceof Element)) return
    if (node.matches(CHIP_SELECTOR)) {
      flushBreaks()
      const ref = chipRefOf(node)
      const quote = ref === null ? undefined : quotes.find((item) => item.id === ref)
      const label = chipLabel(quote?.text ?? node.textContent ?? '', 200)
      chips.push({ at: text.length, text: quote?.text ?? label, ...(quote?.long ? { long: true } : {}) })
      readable += label
      html += `<span data-dsh-quote="${escapeHtml(label)}">${escapeHtml(label)}</span>`
      return
    }
    if (node.tagName === 'BR') {
      pendingBreak += 1
      return
    }
    const block = BLOCK_TAGS.has(node.tagName)
    // One block boundary = at most one line break, whether it comes from the
    // element's open or its close tag.
    if (block) pendingBreak = Math.max(pendingBreak, 1)
    for (const child of Array.from(node.childNodes)) walk(child)
  }

  for (const child of Array.from(fragment.childNodes)) walk(child)
  // Trailing newlines come from the block boundaries, never from the user.
  return {
    text: text.replace(/\n+$/u, ''),
    readable: readable.replace(/\n+$/u, ''),
    html: html.replace(/(?:\n)+$/u, ''),
    chips,
  }
}

/** The quote id behind a chip element — React owns the props, the DOM the ref. */
function chipRefOf(element: Element): string | null {
  const ref = element.getAttribute('data-composer-chip-ref')
  if (typeof ref === 'string' && ref.length > 0) return ref
  return null
}

function markerOf(copied: CopiedFragment): string {
  if (copied.chips.length === 0) return ''
  const payload = {
    v: 2,
    text: copied.text,
    quotes: copied.chips.map((chip) => ({
      text: chip.text,
      ...(chip.long ? { long: true } : {}),
      at: chip.at,
    })),
  }
  return `<!--dsh-quote-data:${JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/--/g, '\\u002d\\u002d')}-->`
}

/** The selection's cloned content, or null when it is not in the composer. */
function selectionFragment(root: Element): DocumentFragment | null {
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null
  if (root.querySelector(CHIP_SELECTOR) === null) return null
  return range.cloneContents()
}

/**
 * Take over `copy` / `cut` inside the composer for selections that include a
 * chip. Returns the disposer.
 */
export function watchChipClipboard(): () => void {
  if (typeof document === 'undefined') return () => {}

  const onCopy = (event: ClipboardEvent): void => {
    const target = event.target
    const card =
      target instanceof Element
        ? target.closest(COMPOSER_CARD) ?? target.closest(COMPOSER_ROOT)
        : null
    if (card === null) return
    const root = document.querySelector(COMPOSER_ROOT)
    if (!(root instanceof Element)) return
    const fragment = selectionFragment(root)
    if (fragment === null) return
    const copied = serialize(fragment)
    if (copied.chips.length === 0) return
    const data = event.clipboardData
    if (data === null) return

    event.preventDefault()
    // Lexical's own copy handler would overwrite both flavors (setData
    // replaces), so the event must never reach it.
    event.stopPropagation()
    data.setData('text/plain', copied.readable)
    data.setData(
      'text/html',
      `<meta charset="utf-8">${markerOf(copied)}<div style="white-space:pre-wrap">${copied.html}</div>`,
    )

    if (event.type !== 'cut') return
    // Cut: preventing the default (needed above, or the browser overwrites the
    // clipboard) also cancels the deletion, and the host ignores
    // execCommand('delete'). Re-dispatch the key the host does listen to —
    // our own capture handler sees it first and sweeps the chips.
    try {
      root.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }),
      )
    } catch {
      // leaving the text in place is better than a half-deleted draft
    }
  }

  document.addEventListener('copy', onCopy, true)
  document.addEventListener('cut', onCopy, true)
  return () => {
    document.removeEventListener('copy', onCopy, true)
    document.removeEventListener('cut', onCopy, true)
  }
}
