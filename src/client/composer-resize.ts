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

/** Set the editor height (clamped); returns the applied value, 0 = no area. */
export function applyComposerHeight(card: HTMLElement, height: number): number {
  const area = composerScrollAreaOf(card)
  if (!area) return 0
  const clamped = Math.min(Math.max(Math.round(height), COMPOSER_MIN_HEIGHT), maxHeightCap())
  area.style.height = `${clamped}px`
  area.style.maxHeight = `${clamped}px`
  area.style.overflowY = 'auto'
  return clamped
}

/** Back to the host's own sizing and clear the persisted height. */
export function resetComposerHeight(card: HTMLElement): void {
  const area = composerScrollAreaOf(card)
  if (!area) return
  area.style.removeProperty('height')
  area.style.removeProperty('max-height')
  area.style.removeProperty('overflow-y')
  save(null)
}

function ensureHandle(card: HTMLElement): void {
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
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue
        if (node.matches(COMPOSER_CARD)) ensureHandle(node as HTMLElement)
        else scan(node)
      }
    }
  })
  const root = document.body ?? document.documentElement
  if (root) {
    observer.observe(root, { childList: true, subtree: true })
    scan(root)
  }
  return () => observer.disconnect()
}
