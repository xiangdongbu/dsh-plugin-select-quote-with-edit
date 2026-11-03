/**
 * Paste interceptor for the resident composer.
 *
 * Two behaviors, both gated on the composer's contenteditable target:
 *
 * 1. 「复制」 on a quoted message stows the quotes in the clipboard's HTML
 *    flavor as an invisible `<!--dsh-quote-data:…-->` comment. When that
 *    clipboard content is pasted into the composer, this listener restores
 *    the quotes as pending chips and inserts just the display text — the
 *    pasted result looks exactly like 「添加到对话」.
 *
 * 2. A plain-text paste at or above LONG_TEXT_THRESHOLD characters becomes a
 *    long-text capsule chip (icon + hover preview + delete, same as a quote
 *    chip) instead of dumping a wall of text into the editor. The full text
 *    rides the `<dsh-quotes>` protocol block at send time, so the message
 *    shows a capsule too and the model still sees the whole text.
 *
 * Every other paste target (and any clipboard content below the threshold
 * without our marker) is untouched.
 */

import { addQuote } from './store.ts'
import { queueQuoteRestore } from './inline-chips.ts'
import { LONG_TEXT_THRESHOLD, withQuoteMarks } from './protocol.ts'
import { runtime } from './runtime.ts'

const MARKER_RE = /<!--dsh-quote-data:([\s\S]*?)-->/
const COMPOSER_CARD = '[data-composer-card]'

interface PastedQuote {
  readonly text: string
  readonly long?: boolean
  readonly at?: number
}

interface PastedPayload {
  /** The copied selection's own text (v2 payloads only). */
  readonly text?: string
  readonly quotes: readonly PastedQuote[]
}

function quoteEntries(value: unknown): PastedQuote[] {
  if (!Array.isArray(value)) return []
  const out: PastedQuote[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const text = (entry as { text?: unknown }).text
    if (typeof text !== 'string' || !text.trim()) continue
    const long = (entry as { long?: unknown }).long === true
    const rawAt = (entry as { at?: unknown }).at
    const at =
      typeof rawAt === 'number' && Number.isFinite(rawAt) && rawAt >= 0 ? Math.floor(rawAt) : undefined
    out.push({ text: text.trim(), ...(long ? { long: true } : {}), ...(at === undefined ? {} : { at }) })
  }
  return out
}

/**
 * Two shapes ride in the marker comment:
 *
 * - v2 `{ v: 2, text, quotes: [{ text, long?, at? }] }` — written by the
 *   composer's own copy handler, carries the selection text and each chip's
 *   offset, so the paste restores the exact order;
 * - the legacy bare array `[{ text }]` — written by 「复制」 on a message;
 *   there is no selection text, the clipboard's plain flavor provides it.
 */
function parsePayload(value: unknown): PastedPayload | null {
  if (Array.isArray(value)) {
    const quotes = quoteEntries(value)
    return quotes.length > 0 ? { quotes } : null
  }
  if (value === null || typeof value !== 'object') return null
  const record = value as { v?: unknown; text?: unknown; quotes?: unknown }
  if (record.v !== 2) return null
  const quotes = quoteEntries(record.quotes)
  if (quotes.length === 0) return null
  return {
    quotes,
    ...(typeof record.text === 'string' ? { text: record.text } : {}),
  }
}

export function watchQuotePaste(): () => void {
  const onPaste = (event: ClipboardEvent): void => {
    const target = event.target instanceof Element ? event.target : null
    if (!target || !target.closest(COMPOSER_CARD)) return
    if (!(target as HTMLElement).isContentEditable) return
    const plain = event.clipboardData?.getData('text/plain') ?? ''

    const html = event.clipboardData?.getData('text/html') ?? ''
    const match = MARKER_RE.exec(html)
    if (match !== null) {
      let parsed: PastedPayload | null = null
      try {
        parsed = parsePayload(JSON.parse(match[1]))
      } catch {
        parsed = null
      }
      if (parsed === null) return

      // preventDefault alone is not enough: Lexical's own paste handler does
      // not check `defaultPrevented` and would insert the clipboard text a
      // second time next to our `execCommand` insert. Stop the event here so
      // `execCommand('insertText')` (which goes through Lexical's beforeinput
      // input path) is the only insertion.
      event.preventDefault()
      event.stopImmediatePropagation()

      // Add first, queue second, insert last — all in one tick, so the panel's
      // chip-insertion effect (which runs after this handler) sees the queued
      // restore and materializes the chips at their offsets instead of
      // appending them behind the pasted text.
      const pairs: { id: string; at?: number }[] = []
      for (const entry of parsed.quotes) {
        const quote = addQuote(entry.text, entry.long === true ? { long: true } : undefined)
        if (quote === null) continue
        pairs.push({ id: quote.id, ...(entry.at === undefined ? {} : { at: entry.at }) })
      }
      const placed = pairs
        .filter((pair): pair is { id: string; at: number } => typeof pair.at === 'number')
        .sort((left, right) => left.at - right.at)

      if (placed.length === 0) {
        insertPlain(event, plain)
        return
      }
      const base = parsed.text ?? plain
      queueQuoteRestore(placed.map((pair) => pair.id))
      insertPlain(event, withQuoteMarks(base, placed.map((pair) => pair.at)))
      return
    }

    // Long-text paste: no quote marker, but far more text than belongs in an
    // editor. Swap the literal insert for a capsule chip; nothing enters the
    // draft. `stopImmediatePropagation` is essential here: the host editor is
    // Lexical, whose own paste handler (onPasteForRichText) does NOT check
    // `defaultPrevented` — it re-inserts the clipboard text on its own. The
    // event must never reach the editor root, or the wall of text reappears
    // next to the capsule. The U+200B marker effect (composer-panel) keeps
    // the send button usable while only the chip is pending.
    const trimmed = plain.trim()
    if (trimmed.length < LONG_TEXT_THRESHOLD) return
    event.preventDefault()
    event.stopImmediatePropagation()
    addQuote(trimmed, { long: true })
  }
  document.addEventListener('paste', onPaste, true)
  return () => {
    document.removeEventListener('paste', onPaste, true)
  }
}

/** Insert display text at the caret through the editor's own input path. */
function insertPlain(_event: ClipboardEvent, plain: string): void {
  if (plain.length === 0) return
  let inserted = false
  try {
    inserted = document.execCommand('insertText', false, plain)
  } catch {
    inserted = false
  }
  if (!inserted) {
    const base = runtime.draft ?? ''
    runtime.inputActions?.setDraft(base + plain)
  }
}
