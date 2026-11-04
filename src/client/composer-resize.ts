/**
 * Manual composer height: a grip on the composer card's top edge drags the
 * editor's scroll area taller (double-click resets to the host default). The
 * chosen height persists in localStorage and is re-applied whenever a composer
 * card shows up; it is clamped to COMPOSER_MIN_HEIGHT … min(60vh, 640px).
 *
 * Plain DOM (same lifecycle as the hover chrome): the host owns the composer,
 * the plugin only decorates its card — no host imports, duck-typed DOM
 * contract `[data-composer-card]` + `[data-lexical-editor="true"]`.
 */

import { COMPOSER_CARD } from './dom.ts'
import { t } from './i18n.ts'

const STORAGE_KEY = 'dsh.select-quote-with-edit.composerHeight'
export const COMPOSER_MIN_HEIGHT = 44
export const COMPOSER_MAX_HEIGHT = 640
/** Hard cap relative to the viewport, so small windows stay usable. */
const MAX_VH = 0.6

const HANDLE_CLASS = 'dsqe-rzHandle'
const CARD_CLASS = 'dsqe_rzCard'
const DRAGGING_FLAG = 'data-dragging'
const RESIZING_FLAG = 'data-dsqe-resizing'

function readSaved(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const value = raw === null ? Number.NaN : Number(raw)
    return Number.isFinite(value) && value >= COMPOSER_MIN_HEIGHT ? value : null
  } catch {
    return null
  }
}

function save(height: number | null): void {
  try {
    if (height === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, String(Math.round(height)))
  } catch {
    // Storage unavailable — the height just stays session-only.
  }
}

function maxHeightCap(): number {
  return Math.min(COMPOSER_MAX_HEIGHT, Math.round(window.innerHeight * MAX_VH))
}

/**
 * The element whose height the grip drives: the editor itself, or — when the
 * host wraps the Lexical root in a scroll container — that container.
 */
export function composerScrollAreaOf(card: HTMLElement): HTMLElement | null {
  const editor = card.querySelector<HTMLElement>('[data-lexical-editor="true"]')
  if (!editor) return null
  let node: HTMLElement | null = editor
  while (node !== null && node !== card) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node
    node = node.parentElement
  }
  return editor
}

/**
 * Keep composer scrolling local. With long input the editor area scrolls on
 * its own; without this, the moment it reaches an edge the wheel keeps
 * chaining into the transcript underneath (the page scrolls along with the
 * composer). `contain` stops the chaining while leaving the area's own
 * scrolling untouched.
 *
 * The host assembles the card in two passes — the shell first, the editor and
 * its scroll wrapper later — so this re-runs on inner DOM changes and re-pins
 * whenever a (re)built scroll area shows up. A persisted height rides along,
 * because it belongs to the area that just got replaced.
 */
const lastAreaOf = new WeakMap<HTMLElement, HTMLElement>()

function keepScrollLocal(card: HTMLElement): void {
  const area = composerScrollAreaOf(card)
  if (!area) return
  if (area === lastAreaOf.get(card) && area.style.overscrollBehavior === 'contain') return
  area.style.overscrollBehavior = 'contain'
  lastAreaOf.set(card, area)
  const saved = readSaved()
  if (saved !== null) applyComposerHeight(card, saved)
}

/**
 * The host forwards wheel events to the transcript itself: an `onWheel`
 * listener on the transcript scroller assigns `scrollTop` directly once the
 * composer can't consume the delta, so `overscroll-behavior: contain` (which
 * only stops native chaining) is not enough — the transcript scrolled along
 * with the composer anyway. While the composer has its own scrollbar, the
 * wheel must stay local: swallow the event in the capture phase at document
 * level, which always runs before any listener the host keeps on the
 * transcript scroller. When the composer has no overflow there is nothing to
 * keep local, and the host's forwarding stays the desired behavior.
 */
function wheelGuard(event: WheelEvent): void {
  const target = event.target
  if (!(target instanceof Element)) return
  const card = target.closest<HTMLElement>(COMPOSER_CARD)
  if (card === null) return
  const area = composerScrollAreaOf(card)
  if (area === null) return
  if (area.scrollHeight <= area.clientHeight + 1) return
  event.stopPropagation()
}

/** Set the editor height (clamped); returns the applied value, 0 = no area. */
export function applyComposerHeight(card: HTMLElement, height: number): number {
  const area = composerScrollAreaOf(card)
  if (!area) return 0
  const clamped = Math.min(Math.max(Math.round(height), COMPOSER_MIN_HEIGHT), maxHeightCap())
  area.style.height = `${clamped}px`
  area.style.maxHeight = `${clamped}px`
  area.style.overflowY = 'auto'
  area.style.overscrollBehavior = 'contain'
  return clamped
}

/** Back to the host's own sizing and clear the persisted height. */
export function resetComposerHeight(card: HTMLElement): void {
  const area = composerScrollAreaOf(card)
  if (!area) return
  area.style.removeProperty('height')
  area.style.removeProperty('max-height')
  area.style.removeProperty('overflow-y')
  // Clear the saved height BEFORE keepScrollLocal: it re-applies a persisted
  // height when it discovers a (re)built scroll area, which would resurrect
  // the height this call is meant to forget.
  save(null)
  lastAreaOf.delete(card)
  keepScrollLocal(card)
}

function ensureHandle(card: HTMLElement): void {
  // Runs repeatedly for the same card (the host fills its shell in later), so
  // everything below the handle creation must be idempotent.
  keepScrollLocal(card)
  if (card.querySelector(`.${HANDLE_CLASS}`)) return
  card.classList.add(CARD_CLASS)
  const handle = document.createElement('div')
  handle.className = HANDLE_CLASS
  handle.setAttribute('role', 'separator')
  handle.setAttribute('aria-orientation', 'horizontal')
  handle.title = t('resize.handle')
  handle.setAttribute('aria-label', t('resize.handle'))

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    const area = composerScrollAreaOf(card)
    if (!area) return
    event.preventDefault()
    const startY = event.clientY
    const startHeight = area.getBoundingClientRect().height
    handle.setPointerCapture(event.pointerId)
    handle.setAttribute(DRAGGING_FLAG, 'true')
    document.body.setAttribute(RESIZING_FLAG, 'true')

    const onMove = (move: PointerEvent): void => {
      // Dragging up grows the editor: the composer sits at the window bottom.
      applyComposerHeight(card, startHeight + (startY - move.clientY))
    }
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      handle.removeAttribute(DRAGGING_FLAG)
      document.body.removeAttribute(RESIZING_FLAG)
      const moved = composerScrollAreaOf(card)
      if (moved) save(moved.getBoundingClientRect().height)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  })

  handle.addEventListener('dblclick', () => {
    resetComposerHeight(card)
  })

  card.appendChild(handle)
  const saved = readSaved()
  if (saved !== null) applyComposerHeight(card, saved)
}

function scan(root: Element): void {
  const cards = root.querySelectorAll<HTMLElement>(COMPOSER_CARD)
  for (const card of cards) ensureHandle(card)
}

/** Decorate every composer card (now and as they appear). Returns a dispose. */
export function watchComposerResize(): () => void {
  document.addEventListener('wheel', wheelGuard, { capture: true, passive: true })
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue
        // The host builds the card shell first and drops the editor into it
        // afterwards: added nodes INSIDE an existing card must re-run the
        // decoration too (the scroll wrapper shows up that way), not just
        // whole new cards.
        const owner = node.closest<HTMLElement>(COMPOSER_CARD)
        if (owner !== null) ensureHandle(owner)
        else scan(node)
      }
    }
  })
  const root = document.body ?? document.documentElement
  if (root) {
    observer.observe(root, { childList: true, subtree: true })
    scan(root)
  }
  return () => {
    document.removeEventListener('wheel', wheelGuard, { capture: true })
    observer.disconnect()
  }
}
