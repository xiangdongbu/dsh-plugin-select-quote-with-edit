/**
 * Hover chrome + inline editor, all plain DOM (no React).
 *
 * Hovering a user message row (tagged by the node view's `data-dsqe-user`
 * marker) surfaces the edit affordance. Plain messages delegate to the host's
 * own actions row (`MessageIconActions`, clock + copy): the plugin injects its
 * pencil + undo buttons right after the copy control instead of floating a
 * second row. Quote bubbles are plugin-drawn and come with no host row, so
 * they keep the plugin's own action row (time / copy / edit / undo) below the
 * bubble. 「编辑」 replaces the bubble with an inline editor (quote chips +
 * editable text + hint + 取消/发送). 「发送」 writes the re-composed wire text
 * into the resident composer and triggers its own send gesture, so the edit
 * lands as a new message through the host's ordinary submit path. 「撤回」
 * rewinds the message (and the files its turn touched) and refills the composer
 * with the original wire text (quote chips restored) — see withdraw.ts.
 */

import { t } from './i18n.ts'
import { getMessage } from './registry.ts'
import { composeMessage, scanQuotes, type Quote } from './protocol.ts'
import { runtime } from './runtime.ts'
import { copyRich, escapeHtml } from './dom.ts'
import { ensureStyles } from './styles.ts'
import { SVG_PENCIL, SVG_COPY, SVG_CHECK, SVG_INFO, SVG_QUOTE, SVG_X, SVG_UNDO } from './svg.ts'

const FLOW_ITEM = '[data-chat-flow-key]'
const COMPOSER_CARD = '[data-composer-card]'
// The host's MessageIconActions root carries `data-clock` ('start' on user /
// steering rows, 'end' on assistant tails) — a stable hook that survives the
// CSS-module class hashing.
const HOST_ACTIONS = '[data-clock="start"]'

let actionsEl: HTMLElement | null = null
let timeEl: HTMLElement | null = null
let editBtn: HTMLButtonElement | null = null
let copyBtn: HTMLButtonElement | null = null
let undoBtn: HTMLButtonElement | null = null
let hostEditBtn: HTMLButtonElement | null = null
let hostUndoBtn: HTMLButtonElement | null = null
let actionsRow: HTMLElement | null = null
let hideTimer: number | null = null
let copiedTimer: number | null = null
let lastPointer = { x: -1, y: -1 }
let editingRow: HTMLElement | null = null
let editorEl: HTMLElement | null = null
/** Working quote set of the open editor (chips can be removed while editing). */
let editingQuotes: Quote[] = []
let editorSendBtn: HTMLButtonElement | null = null
let editorTextEl: HTMLElement | null = null

// 悬停全文预览（body 级 fixed 单例，上方优先、放不下翻下方）
let tipEl: HTMLElement | null = null
let tipChip: HTMLElement | null = null
let tipTimer: number | null = null

function element(html: string, className: string): HTMLElement {
  const element = document.createElement('div')
  element.className = className
  element.innerHTML = html
  return element
}

/** The user-message row a pointer event happened in, if any. */
function rowOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const marker = target.closest('[data-dsqe-user]')
  if (marker instanceof Element) {
    const row = marker.closest(FLOW_ITEM)
    return row instanceof HTMLElement ? row : null
  }
  // The pointer can sit on the row itself (hover padding, gaps) or on a
  // chrome element inside it — neither carries the marker.
  const row = target.closest(FLOW_ITEM)
  if (row instanceof HTMLElement && row.querySelector('[data-dsqe-user]')) return row
  return null
}

/**
 * 悬停操作行的时间：当天只显示时分；昨天带前缀；今年带「M月D日」；更早带年份。
 * 文案随词典（time.yesterday / time.sameYear / time.otherYear）。
 */
function formatTime(time?: number): string {
  if (typeof time !== 'number' || !Number.isFinite(time)) return ''
  const date = new Date(time)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const hm = `${hh}:${mm}`
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (time >= startOfToday) return hm
  const m = String(date.getMonth() + 1)
  const d = String(date.getDate())
  if (time >= startOfToday - 86400000) return `${t('time.yesterday')} ${hm}`
  if (date.getFullYear() === now.getFullYear()) {
    return `${t('time.sameYear').replace('{m}', m).replace('{d}', d)} ${hm}`
  }
  return `${t('time.otherYear')
    .replace('{y}', String(date.getFullYear()))
    .replace('{m}', m)
    .replace('{d}', d)} ${hm}`
}

// ---------------------------------------------------------------- action row

function buildActions(): void {
  actionsEl = document.createElement('div')
  actionsEl.className = 'dsqe_actions'
  actionsEl.dataset.shown = 'false'

  timeEl = document.createElement('span')
  timeEl.className = 'dsqe_time'

  editBtn = document.createElement('button')
  editBtn.type = 'button'
  editBtn.className = 'dsqe_iconBtn'
  editBtn.title = t('row.edit')
  editBtn.setAttribute('aria-label', t('row.edit'))
  editBtn.innerHTML = SVG_PENCIL
  editBtn.addEventListener('click', () => {
    if (actionsRow !== null) startEdit(actionsRow)
  })

  copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.className = 'dsqe_iconBtn'
  copyBtn.title = t('row.copy')
  copyBtn.setAttribute('aria-label', t('row.copy'))
  copyBtn.innerHTML = SVG_COPY
  copyBtn.addEventListener('click', () => {
    void copyMessage()
  })

  undoBtn = document.createElement('button')
  undoBtn.type = 'button'
  undoBtn.className = 'dsqe_iconBtn dsqe_undoBtn'
  undoBtn.title = t('row.undo')
  undoBtn.setAttribute('aria-label', t('row.undo'))
  undoBtn.innerHTML = SVG_UNDO
  undoBtn.addEventListener('click', () => {
    if (actionsRow !== null) void withdrawRow(actionsRow)
  })

  actionsEl.append(timeEl, copyBtn, editBtn, undoBtn)
}

/**
 * The pencil + undo pair for the host's own actions row — separate singletons
 * from the plugin row's buttons, so both can coexist (an always-visible tail
 * row plus a hovered quote row elsewhere). Each row is resolved at click time
 * via closest(), so the same element works wherever it is injected.
 */
function buildHostButtons(): void {
  hostEditBtn = document.createElement('button')
  hostEditBtn.type = 'button'
  hostEditBtn.className = 'dsqe_iconBtn dsqe_hostEdit'
  hostEditBtn.title = t('row.edit')
  hostEditBtn.setAttribute('aria-label', t('row.edit'))
  hostEditBtn.innerHTML = SVG_PENCIL
  hostEditBtn.addEventListener('click', () => {
    const row = hostEditBtn?.closest(FLOW_ITEM)
    if (row instanceof HTMLElement) startEdit(row)
  })

  hostUndoBtn = document.createElement('button')
  hostUndoBtn.type = 'button'
  hostUndoBtn.className = 'dsqe_iconBtn dsqe_hostEdit dsqe_hostUndo'
  hostUndoBtn.title = t('row.undo')
  hostUndoBtn.setAttribute('aria-label', t('row.undo'))
  hostUndoBtn.innerHTML = SVG_UNDO
  hostUndoBtn.addEventListener('click', () => {
    const row = hostUndoBtn?.closest(FLOW_ITEM)
    if (row instanceof HTMLElement) void withdrawRow(row)
  })
}

/**
 * The host action the pencil anchors to: the built-in copy button — the
 * row's first foreign button. A Tooltip wrapper (if any) around it is part of
 * the visual unit, so the pencil sits after the wrapper instead of inside it.
 */
function copyUnitOf(host: HTMLElement): HTMLElement | null {
  for (const button of host.querySelectorAll('button')) {
    if (button === hostEditBtn || button === hostUndoBtn) continue
    const parent = button.parentElement
    return parent !== null && parent !== host && parent instanceof HTMLElement ? parent : button
  }
  return null
}

/**
 * Inject the pencil + undo into the row's host actions row, if the host
 * rendered one. Returns false for quote rows (plugin-drawn bubble, no host
 * row) so the caller falls back to the plugin row. The pair always sits right
 * after the copy button — a fixed spot, not "wherever the row ends": React may
 * rebuild or reshuffle the row (dropping or displacing the foreign buttons), so
 * every call re-checks the position and moves them back if needed.
 */
function ensureEditInHostRow(row: HTMLElement): boolean {
  if (editingRow !== null) return false
  const host = row.querySelector(HOST_ACTIONS)
  if (!(host instanceof HTMLElement)) return false
  if (hostEditBtn === null || hostUndoBtn === null) buildHostButtons()
  const unit = copyUnitOf(host)
  if (unit === null) {
    if (hostEditBtn!.parentElement !== host) host.appendChild(hostEditBtn!)
    if (hostUndoBtn!.parentElement !== host) host.appendChild(hostUndoBtn!)
    return true
  }
  const placed =
    hostEditBtn!.parentElement === host &&
    hostEditBtn!.previousElementSibling === unit &&
    hostUndoBtn!.parentElement === host &&
    hostEditBtn!.nextElementSibling === hostUndoBtn
  if (placed) return true
  unit.after(hostEditBtn!)
  hostEditBtn!.after(hostUndoBtn!)
  return true
}

async function copyMessage(): Promise<void> {
  if (actionsRow === null || copyBtn === null) return
  const flowKey = actionsRow.getAttribute('data-chat-flow-key') ?? ''
  const entry = getMessage(flowKey)
  if (!entry) return
  const scan = scanQuotes(entry.raw)
  // Quotes ride along in the HTML flavor as an invisible comment: pasting
  // into our composer restores them as pending chips (see paste.ts), while
  // every other target just sees the display text.
  const payload = scan.quotes.map((quote) => ({ text: quote.text }))
  const marker =
    payload.length > 0
      ? `<!--dsh-quote-data:${JSON.stringify(payload)
          .replace(/</g, '\\u003c')
          .replace(/--/g, '\\u002d\\u002d')}-->`
      : ''
  const html = `${marker}<div style="white-space:pre-wrap">${escapeHtml(scan.rest)}</div>`
  const ok = await copyRich(scan.rest, html)
  if (!ok || actionsRow === null) return
  copyBtn.innerHTML = SVG_CHECK
  copyBtn.title = t('row.copied')
  if (copiedTimer !== null) window.clearTimeout(copiedTimer)
  copiedTimer = window.setTimeout(() => {
    copiedTimer = null
    if (copyBtn === null) return
    copyBtn.innerHTML = SVG_COPY
    copyBtn.title = t('row.copy')
  }, 1200)
}

/** Transient floating hint under the composer (withdraw failures). */
function showUndoHint(text: string): void {
  const hint = document.createElement('div')
  hint.className = 'dsqe_undoHint'
  hint.setAttribute('role', 'status')
  hint.textContent = text
  const card = document.querySelector(COMPOSER_CARD)
  const rect = card instanceof HTMLElement ? card.getBoundingClientRect() : null
  hint.style.position = 'fixed'
  hint.style.left = `${Math.round(rect?.left ?? 16)}px`
  hint.style.bottom = `${Math.round(window.innerHeight - (rect?.top ?? window.innerHeight) + 8)}px`
  hint.style.zIndex = '2147483000'
  hint.style.padding = '8px 12px'
  hint.style.borderRadius = '8px'
  hint.style.fontSize = '12px'
  hint.style.color = '#fff'
  hint.style.background = 'rgba(0, 0, 0, 0.78)'
  hint.style.pointerEvents = 'none'
  document.body.appendChild(hint)
  window.setTimeout(() => hint.remove(), 3200)
}

/**
 * 撤回 the message in `row`: rewind the conversation + touched files and put the
 * original wire text back into the composer (the quote block unfolds back into
 * pending chips). The rewind engine lives behind `runtime.withdraw`, published
 * by the composer bridge.
 */
async function withdrawRow(row: HTMLElement): Promise<void> {
  const flowKey = row.getAttribute('data-chat-flow-key') ?? ''
  // The chat snapshot is keyed by the anchor key; for ordinary user rows it is
  // the same value as the flow key, but read it explicitly to stay aligned.
  const anchorKey = row.getAttribute('data-chat-anchor-key') ?? flowKey
  const withdraw = runtime.withdraw
  hideActionsImmediate()
  if (withdraw === null) {
    showUndoHint(t('undo.failed'))
    return
  }
  let outcome: Awaited<ReturnType<typeof withdraw>>
  try {
    outcome = await withdraw(flowKey, anchorKey)
  } catch {
    outcome = { ok: false, refilled: false, reason: 'threw' }
  }
  if (!outcome.ok) showUndoHint(t('undo.failed'))
}

function showActions(row: HTMLElement): void {
  if (editingRow !== null) return
  if (!row.classList.contains('dsqe_row')) return
  const flowKey = row.getAttribute('data-chat-flow-key') ?? ''
  const entry = getMessage(flowKey)
  if (!entry) return
  if (hideTimer !== null) {
    window.clearTimeout(hideTimer)
    hideTimer = null
  }
  if (actionsRow === row) return
  hideActionsImmediate()
  // The host already provides the actions row for delegated (plain) messages:
  // just add the pencil + undo to it. Track the row so leaving it removes the
  // extra buttons again — otherwise a hovered row keeps the full row forever
  // (the host's own time/copy row stays, ours must follow its reveal).
  if (ensureEditInHostRow(row)) {
    actionsRow = row
    return
  }
  // Quote bubbles are plugin-drawn with no host row: keep the plugin's own
  // action row (time / copy / edit / undo) under the bubble. The row already
  // reserves this height via .dsqe_rowQuote, so showing the overlay never
  // changes layout (no message jump).
  if (actionsEl === null) buildActions()
  timeEl!.textContent = formatTime(entry.time)
  timeEl!.style.display = timeEl!.textContent === '' ? 'none' : ''
  row.appendChild(actionsEl!)
  actionsEl!.dataset.shown = 'true'
  actionsRow = row
}

function hideActionsImmediate(): void {
  actionsEl?.remove()
  if (actionsEl !== null) actionsEl.dataset.shown = 'false'
  // Remove the host-row buttons too: the resting state must match the native
  // row (time + copy only, exactly as before the plugin), reappearing on hover.
  hostEditBtn?.remove()
  hostUndoBtn?.remove()
  actionsRow = null
}

/**
 * Hide after a short delay, but abort when the pointer is still inside the
 * row's current box: the row keeps a fixed height now, so this is purely a
 * flicker guard for the pointer crossing the bubble/action boundary.
 */
function scheduleHide(row: HTMLElement): void {
  if (hideTimer !== null) window.clearTimeout(hideTimer)
  hideTimer = window.setTimeout(() => {
    hideTimer = null
    if (editingRow === row) return
    if (actionsRow !== row) return
    const rect = row.getBoundingClientRect()
    if (
      lastPointer.x >= rect.left &&
      lastPointer.x <= rect.right &&
      lastPointer.y >= rect.top &&
      lastPointer.y <= rect.bottom
    ) {
      scheduleHide(row)
      return
    }
    hideActionsImmediate()
  }, 160)
}

// ---------------------------------------------------------------- editor

function placeCaretEnd(element: HTMLElement): void {
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.selectNodeContents(element)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
}

// ---- 悬停全文预览 ----

const onTipReflow = (): void => {
  if (tipChip?.isConnected) placeTip(tipChip)
  else hideTipNow()
}

function placeTip(chip: HTMLElement): void {
  const tip = ensureTip()
  const rect = chip.getBoundingClientRect()
  const margin = 8
  const width = tip.offsetWidth
  const height = tip.offsetHeight
  const left = Math.min(Math.max(margin, rect.left), window.innerWidth - margin - width)
  // Prefer above; flip below only without headroom (leave room for the header).
  if (rect.top >= height + 68) {
    tip.dataset.side = 'above'
    tip.style.top = `${Math.max(margin, rect.top - 8 - height)}px`
  } else {
    tip.dataset.side = 'below'
    tip.style.top = `${rect.bottom + 8}px`
  }
  tip.style.left = `${left}px`
  tip.style.visibility = 'visible'
}

function ensureTip(): HTMLElement {
  if (tipEl) return tipEl
  const tip = document.createElement('div')
  tip.className = 'dsqe-tipWrap'
  tip.dataset.side = 'above'
  tip.style.visibility = 'hidden'
  tip.innerHTML = `<div class="dsqe-tipIn"><div class="dsqe-tip">${SVG_QUOTE}<span class="dsqe-tipText"></span></div></div>`
  tip.addEventListener('pointerenter', cancelTipClose)
  tip.addEventListener('pointerleave', scheduleTipClose)
  document.body.appendChild(tip)
  tipEl = tip
  window.addEventListener('resize', onTipReflow)
  document.addEventListener('scroll', onTipReflow, true)
  return tip
}

function hideTipNow(): void {
  window.removeEventListener('resize', onTipReflow)
  document.removeEventListener('scroll', onTipReflow, true)
  tipEl?.remove()
  tipEl = null
  tipChip = null
  if (tipTimer !== null) {
    window.clearTimeout(tipTimer)
    tipTimer = null
  }
}

function scheduleTipClose(): void {
  if (tipTimer !== null) return
  tipTimer = window.setTimeout(() => {
    tipTimer = null
    hideTipNow()
  }, 140)
}

function cancelTipClose(): void {
  if (tipTimer !== null) {
    window.clearTimeout(tipTimer)
    tipTimer = null
  }
}

function showTip(chip: HTMLElement, text: string): void {
  cancelTipClose()
  const tip = ensureTip()
  const textEl = tip.querySelector<HTMLElement>('.dsqe-tipText')
  if (textEl) textEl.textContent = text
  tipChip = chip
  placeTip(chip)
}

function chipElement(quote: Quote): HTMLElement {
  const chip = document.createElement('span')
  chip.className = 'dsqe-echip'
  // The × occupies the icon's slot on hover (CSS swaps them via
  // data-x-shown), so the pill never changes width. The preview is a
  // body-level fixed panel above the chip with a short close delay, so the
  // pointer can cross the 8px bridge onto it.
  chip.innerHTML = `<button type="button" class="dsqe-echipDel" title="${t('editor.removeQuote')}" aria-label="${t('editor.removeQuote')}">${SVG_X}</button><span class="dsqe-echipIcon">${SVG_QUOTE}</span><span class="dsqe-chipText"></span>`
  const text = chip.querySelector('.dsqe-chipText')
  if (text) text.textContent = quote.text

  const del = chip.querySelector('button')
  del?.addEventListener('click', (event) => {
    event.stopPropagation()
    removeQuoteChip(chip, quote.id)
  })
  chip.addEventListener('pointerenter', () => {
    chip.dataset.xShown = 'true'
    showTip(chip, quote.text)
  })
  chip.addEventListener('pointerleave', () => {
    delete chip.dataset.xShown
    scheduleTipClose()
  })
  return chip
}

function removeQuoteChip(chip: HTMLElement, id: string): void {
  editingQuotes = editingQuotes.filter((quote) => quote.id !== id)
  chip.remove()
  if (tipChip === chip || !tipChip?.isConnected) hideTipNow()
  syncSendDisabled()
}

function syncSendDisabled(): void {
  if (editorSendBtn === null) return
  const text = (editorTextEl?.innerText ?? '').trim()
  editorSendBtn.disabled = text === '' && editingQuotes.length === 0
}

function submitComposer(): void {
  const card = document.querySelector(COMPOSER_CARD)
  if (!(card instanceof HTMLElement)) return
  const buttons = card.querySelectorAll('button')
  const send = buttons[buttons.length - 1]
  if (!(send instanceof HTMLButtonElement) || send.disabled) return
  // The composer's stop button renders an `svg rect`; the primary send does not.
  if (send.querySelector('svg rect') !== null) return
  send.click()
}

function startEdit(row: HTMLElement): void {
  if (editingRow !== null) exitEdit()
  const flowKey = row.getAttribute('data-chat-flow-key') ?? ''
  const entry = getMessage(flowKey)
  if (!entry) return
  const scan = scanQuotes(entry.raw)

  editingRow = row
  editingQuotes = scan.quotes.map((quote) => ({ ...quote }))
  hideActionsImmediate()
  row.classList.add('dsqe_rowEditing')

  const editor = document.createElement('div')
  editor.className = 'dsqe_editor'
  editor.setAttribute('data-dsqe-editor', 'true')

  const body = document.createElement('div')
  body.className = 'dsqe_editBody'
  for (const quote of editingQuotes) body.appendChild(chipElement(quote))

  const text = document.createElement('div')
  text.className = 'dsqe_editText'
  text.contentEditable = 'true'
  text.spellcheck = false
  text.setAttribute('role', 'textbox')
  text.setAttribute('aria-label', t('row.edit'))
  text.textContent = scan.rest
  body.appendChild(text)
  editor.appendChild(body)

  const foot = document.createElement('div')
  foot.className = 'dsqe_editFoot'

  const hint = element(SVG_INFO, 'dsqe_hint')
  hint.appendChild(document.createTextNode(t('editor.hint')))

  const btns = document.createElement('div')
  btns.className = 'dsqe_btns'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'dsqe_btn dsqe_btnCancel'
  cancel.textContent = t('editor.cancel')
  cancel.addEventListener('click', () => exitEdit())
  const send = document.createElement('button')
  send.type = 'button'
  send.className = 'dsqe_btn dsqe_btnSend'
  send.textContent = t('editor.send')
  send.addEventListener('click', () => sendEdit())
  btns.append(cancel, send)
  foot.append(hint, btns)
  editor.appendChild(foot)

  editorSendBtn = send
  editorTextEl = text
  text.addEventListener('input', syncSendDisabled)
  text.addEventListener('keydown', (event) => {
    if (!(event instanceof KeyboardEvent)) return
    if (event.key === 'Escape') {
      event.preventDefault()
      exitEdit()
      return
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
      event.preventDefault()
      if (!send.disabled) sendEdit()
    }
  })
  syncSendDisabled()

  row.appendChild(editor)
  editorEl = editor
  text.focus()
  placeCaretEnd(text)
}

function exitEdit(): void {
  editorEl?.remove()
  editorEl = null
  editingRow?.classList.remove('dsqe_rowEditing')
  editingRow = null
  editingQuotes = []
  editorSendBtn = null
  editorTextEl = null
  hideTipNow()
}

function sendEdit(): void {
  const row = editingRow
  const textEl = editorEl?.querySelector<HTMLElement>('.dsqe_editText')
  if (row === null || textEl == null) return
  const edited = (textEl.innerText ?? '').replace(/^\s+/, '').replace(/\s+$/, '')
  const wire = composeMessage(edited, editingQuotes)
  const actions = runtime.inputActions
  exitEdit()
  if (actions === null) {
    console.warn('[dsh-plugin-select-quote-with-edit] composer actions unavailable; edit not sent')
    return
  }
  // Mark the fold BEFORE the draft lands: the composer panel's
  // rewind-restore would otherwise read this block back out as a withdrawn
  // message and turn it into pending quotes, racing the send.
  runtime.markFolded?.()
  actions.setDraft(wire)
  // Submit through the resident composer's own send gesture once the draft
  // has landed. If another plugin (the quote plugin) unfolds the block back
  // into pending chips first, its own send intercept re-folds them — the wire
  // text is identical either way.
  window.setTimeout(() => submitComposer(), 40)
}

// ---------------------------------------------------------------- watch

export function watchMessageChrome(): () => void {
  ensureStyles()

  const onPointerOver = (event: Event): void => {
    if (!(event instanceof PointerEvent)) return
    const row = rowOf(event.target)
    if (row === null || editingRow !== null) return
    showActions(row)
  }
  const onPointerOut = (event: Event): void => {
    if (!(event instanceof PointerEvent)) return
    const row = rowOf(event.target)
    if (row === null || row !== actionsRow) return
    const related = event.relatedTarget
    if (related instanceof Node && row.contains(related)) return
    scheduleHide(row)
  }
  const onPointerMove = (event: Event): void => {
    if (!(event instanceof PointerEvent)) return
    lastPointer.x = event.clientX
    lastPointer.y = event.clientY
    // Cheap re-injection while the pointer travels a marked row: React may
    // have rebuilt the host actions row and dropped the pencil mid-hover.
    const row = rowOf(event.target)
    if (row !== null && row !== actionsRow) ensureEditInHostRow(row)
  }
  const onBlur = (): void => {
    if (editingRow === null) hideActionsImmediate()
  }

  document.addEventListener('pointerover', onPointerOver, true)
  document.addEventListener('pointerout', onPointerOut, true)
  document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true })
  window.addEventListener('blur', onBlur)
  return () => {
    document.removeEventListener('pointerover', onPointerOver, true)
    document.removeEventListener('pointerout', onPointerOut, true)
    document.removeEventListener('pointermove', onPointerMove, true)
    window.removeEventListener('blur', onBlur)
    exitEdit()
    hideActionsImmediate()
    hostEditBtn?.remove()
    hostEditBtn = null
    hostUndoBtn?.remove()
    hostUndoBtn = null
    hideTipNow()
    if (hideTimer !== null) window.clearTimeout(hideTimer)
    if (copiedTimer !== null) window.clearTimeout(copiedTimer)
  }
}
