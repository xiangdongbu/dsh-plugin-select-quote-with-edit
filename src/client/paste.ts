/**
 * Paste interceptor for the resident composer.
 *
 * 「复制」 on a quoted message stows the quotes in the clipboard's HTML flavor
 * as an invisible `<!--dsh-quote-data:…-->` comment. When that clipboard
 * content is pasted into the composer, this listener restores the quotes as
 * pending chips and inserts just the display text — the pasted result looks
 * exactly like 「添加到对话」. Every other paste target (and any clipboard
 * content without our marker) is untouched.
 */

import { addQuote } from './store.ts'
import { runtime } from './runtime.ts'

const MARKER_RE = /<!--dsh-quote-data:([\s\S]*?)-->/
const COMPOSER_CARD = '[data-composer-card]'

export function watchQuotePaste(): () => void {
  const onPaste = (event: ClipboardEvent): void => {
    const target = event.target instanceof Element ? event.target : null
    if (!target || !target.closest(COMPOSER_CARD)) return
    if (!(target as HTMLElement).isContentEditable) return
    const html = event.clipboardData?.getData('text/html') ?? ''
    const match = MARKER_RE.exec(html)
    if (!match) return

    let quotes: string[] = []
    try {
      const parsed: unknown = JSON.parse(match[1])
      if (!Array.isArray(parsed)) return
      for (const entry of parsed) {
        if (entry !== null && typeof entry === 'object') {
          const text = (entry as { text?: unknown }).text
          if (typeof text === 'string' && text.trim()) quotes.push(text.trim())
        }
      }
    } catch {
      return
    }
    if (quotes.length === 0) return

    event.preventDefault()
    for (const text of quotes) addQuote(text)

    const plain = event.clipboardData?.getData('text/plain') ?? ''
    if (plain.length === 0) return
    // Insert the display text at the caret through the editor's own input
    // path (Lexical handles execCommand's beforeinput); fall back to
    // appending to the draft when that path is unavailable.
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
  document.addEventListener('paste', onPaste, true)
  return () => {
    document.removeEventListener('paste', onPaste, true)
  }
}
