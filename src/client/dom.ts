/**
 * Host DOM contract helpers: composer geometry, submit gestures, selection
 * snapshot and clipboard. Every assumption about composer / transcript DOM
 * lives in this file.
 */

export const COMPOSER_CARD = '[data-composer-card]'
export const FLOW_ITEM = '[data-chat-flow-key]'

export function composerCardOf(node: Element | null): HTMLElement | null {
  const card = node?.closest(COMPOSER_CARD)
  return card instanceof HTMLElement ? card : null
}

/** Non-empty when the composer's own send gesture actually submits. */
export function willSubmit(card: HTMLElement, draft: string): boolean {
  return draft.trim().length > 0 || card.querySelector('img') !== null
}

/**
 * True for the Enter gestures the host submits: plain Enter, Ctrl+Enter, and
 * Meta+Enter. Shift+Enter inserts a newline; Alt, AltGraph, both modifiers
 * together, and IME composition are ignored.
 */
export function isSubmitKey(event: {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  isComposing: boolean
}): boolean {
  if (event.key !== 'Enter') return false
  if (event.shiftKey || event.altKey) return false
  if (event.ctrlKey && event.metaKey) return false
  if (event.isComposing) return false
  return true
}

function elementOf(node: Node | null): Element | null {
  if (!node) return null
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
}

function lastEditable(): HTMLElement | null {
  const nodes = document.querySelectorAll<HTMLElement>('[contenteditable="true"]')
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (node instanceof HTMLElement) return node
  }
  return null
}

/** Focus the resident composer editor and park the caret at the end. */
export function focusComposer(): void {
  const editor =
    document.querySelector<HTMLElement>('[data-lexical-editor="true"]') ?? lastEditable()
  if (!editor) return
  editor.focus({ preventScroll: false })
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
}

export interface SelectionSnapshot {
  readonly text: string
  /** Flow item the selection starts in (already known to be a transcript node). */
  readonly firstRect: DOMRect
  readonly lastRect: DOMRect
}

/**
 * The live selection as a toolbar snapshot. Only selections whose anchor and
 * focus both sit inside a transcript flow item qualify — the composer, sidebar
 * and other panels never trigger the toolbar.
 */
export function readSelectionSnapshot(): SelectionSnapshot | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const text = selection.toString()
  if (!text.trim()) return null
  const anchor = elementOf(selection.anchorNode)
  const focus = elementOf(selection.focusNode)
  if (!anchor || !focus) return null
  if (!anchor.closest(FLOW_ITEM) || !focus.closest(FLOW_ITEM)) return null
  if (anchor.closest(COMPOSER_CARD) || focus.closest(COMPOSER_CARD)) return null
  const range = selection.getRangeAt(0)
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  )
  const bounding = range.getBoundingClientRect()
  const firstRect = rects.length > 0 ? rects[0] : bounding
  const lastRect = rects.length > 0 ? rects[rects.length - 1] : bounding
  return { text, firstRect, lastRect }
}

export function sameRect(a: DOMRect, b: DOMRect): boolean {
  return (
    Math.abs(a.left - b.left) < 1 &&
    Math.abs(a.top - b.top) < 1 &&
    Math.abs(a.width - b.width) < 1 &&
    Math.abs(a.height - b.height) < 1
  )
}

/** Clipboard write with a textarea fallback for restricted contexts. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  // The fallback selects the textarea content, which would destroy the
  // user's selection — save it and put it back afterwards.
  const selection = window.getSelection()
  const saved = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', 'true')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    textarea.remove()
    return ok
  } catch {
    return false
  } finally {
    if (saved !== null && selection !== null) {
      selection.removeAllRanges()
      selection.addRange(saved)
    }
  }
}
