/**
 * Inline quote chips: pending quotes and pasted long bodies live *inside* the
 * composer text, exactly where the caret was, instead of a row pinned above the
 * editor.
 *
 * The host composer is a Lexical editor that already ships an atomic inline
 * decorator node for its own `@` references — `reference-chip`. It sits in the
 * text line, arrows step over it in one move, and Backspace / Delete remove it
 * whole (that is the node's documented `isKeyboardSelectable: false` design).
 * We mint the same node with our own source name, so the chip flows with the
 * text and inherits the host's chip styling, while the host never tries to
 * resolve our reference as a file.
 *
 * Two host contracts make this safe:
 *
 * 1. The node's `getTextContent()` is its `clipboardText`; the composer's
 *    clipboard projection therefore carries one U+FFFC per chip. Folding at
 *    send time strips those placeholders (see protocol.ts).
 * 2. `ctx.inputTriggers.registerSource` lets a plugin own a reference source
 *    with a `codec`. We register one so a chip that ever reaches submit
 *    serializes instead of rejecting the message, and so clicking a chip routes
 *    back to 「定位原文」 / the detail pane.
 *
 * Everything here is defensive: if the node type is not registered or the
 * editor rejects the edit, callers fall back to the original chip row.
 */

import { chipLabel, CHIP_PLACEHOLDER, type Quote } from './protocol.ts'
import { getQuotes } from './store.ts'

/** The host's inline reference node type (see the conversation package). */
export const CHIP_TYPE = 'reference-chip'
/** Our source name: the chip's serializer / activation routing key. */
export const QUOTE_SOURCE = 'dsh-quote'
/**
 * Trigger character for the registered source. It is never typed, so the
 * source never opens a menu — it exists only for the codec and click routing.
 */
const SOURCE_TRIGGER = '\u0002'

interface ChipInsert {
  source: string
  ref: string
  label: string
  appearance?: string
  clipboardText: string
}

interface LexicalNode {
  getType?: () => string
  getKey?: () => string
  getSource?: () => string
  getReference?: () => string
  getTextContentSize?: () => number
  getChildren?: () => LexicalNode[]
  getChildrenSize?: () => number
  isAttached?: () => boolean
  splitText?: (offset: number) => LexicalNode[]
  insertBefore?: (node: LexicalNode, restoreSelection?: boolean) => void
  insertAfter?: (node: LexicalNode, restoreSelection?: boolean) => void
  append?: (node: LexicalNode) => void
  splice?: (start: number, deleteCount: number, nodes: LexicalNode[]) => void
  selectNext?: (anchorOffset?: number, focusOffset?: number) => void
}

interface EditorStateLike {
  _nodeMap?: Map<string, LexicalNode>
  _selection?: { anchor?: { key: string; offset: number; type: string } } | null
}

interface LexicalEditorLike {
  _editorState?: EditorStateLike
  _pendingEditorState?: EditorStateLike | null
  _nodes?: Map<string, { klass?: new (insert: ChipInsert) => LexicalNode }>
  update?: (fn: () => void, options?: { discrete?: boolean }) => void
  getEditorState?: () => EditorStateLike
  getElementByKey?: (key: string) => Element | null
  registerUpdateListener?: (fn: (payload: { editorState: EditorStateLike }) => void) => () => void
}

type PresenceListener = (present: ReadonlySet<string>) => void

/** The slice of `ctx.inputTriggers` this plugin uses. */
interface TriggerService {
  registerSource(source: unknown): () => void
}

const listeners = new Set<PresenceListener>()
const keyOf = new Map<string, string>()
let attached: { editor: LexicalEditorLike; off: () => void } | null = null
let present: ReadonlySet<string> = new Set<string>()
let activeId: string | null = null

/** The resident composer's editor instance, reached through its root element. */
function editorOf(): LexicalEditorLike | null {
  if (typeof document === 'undefined') return null
  const root = document.querySelector('[data-lexical-editor="true"]')
  if (!(root instanceof HTMLElement)) return null
  const editor = (root as unknown as { __lexicalEditor?: LexicalEditorLike }).__lexicalEditor
  return editor && typeof editor.update === 'function' ? editor : null
}

function stateOf(editor: LexicalEditorLike): EditorStateLike | null {
  return editor._pendingEditorState ?? editor._editorState ?? null
}

function chipClassOf(editor: LexicalEditorLike): (new (insert: ChipInsert) => LexicalNode) | null {
  const entry = editor._nodes?.get?.(CHIP_TYPE)
  const klass = entry?.klass
  return typeof klass === 'function' ? klass : null
}

/** True when this host can host inline chips at all. */
export function inlineChipsSupported(): boolean {
  const editor = editorOf()
  if (!editor) return false
  return chipClassOf(editor) !== null
}

function scan(state: EditorStateLike | null): void {
  const next = new Set<string>()
  keyOf.clear()
  const map = state?._nodeMap
  if (map && typeof map.forEach === 'function') {
    map.forEach((node) => {
      if (!node || typeof node.getType !== 'function' || node.getType() !== CHIP_TYPE) return
      if (typeof node.getSource !== 'function' || node.getSource() !== QUOTE_SOURCE) return
      const ref = node.getReference?.()
      if (typeof ref !== 'string' || ref.length === 0) return
      next.add(ref)
      const key = node.getKey?.()
      if (typeof key === 'string') keyOf.set(ref, key)
    })
  }
  present = next
  paintActive()
  for (const listener of listeners) listener(next)
}

/** Ring the chip whose source text is currently underlined in the transcript. */
function paintActive(): void {
  const editor = attached?.editor
  if (!editor || typeof editor.getElementByKey !== 'function') return
  for (const [quoteId, key] of keyOf) {
    const element = editor.getElementByKey(key)
    if (!element) continue
    if (quoteId === activeId) element.setAttribute('data-dsqe-active', '')
    else element.removeAttribute('data-dsqe-active')
  }
}

/** Bind to the current editor, rebinding when the composer is rebuilt. */
function ensureAttached(): LexicalEditorLike | null {
  const editor = editorOf()
  if (!editor) return null
  if (attached?.editor === editor) return editor
  attached?.off()
  const off = editor.registerUpdateListener?.(({ editorState }) => scan(editorState)) ?? (() => {})
  attached = { editor, off }
  scan(editor.getEditorState?.() ?? stateOf(editor))
  return editor
}

/** Subscribe to the set of quote ids that currently own a chip. */
export function onChipPresence(listener: PresenceListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Highlight (or un-highlight) one chip; null clears the ring. */
export function setActiveChip(id: string | null): void {
  if (activeId === id) return
  activeId = id
  paintActive()
}

/** Forget cached presence (session switch): the editor content is replaced. */
export function resetInlineChips(): void {
  present = new Set<string>()
  keyOf.clear()
  activeId = null
}

/**
 * Insert one quote chip at the caret as an atomic inline node.
 *
 * Returns false when the host cannot place it (no editor, type not registered,
 * or the edit did not stick), which is the caller's cue to fall back to the
 * chip row. The post-check reads the presence set published by the update
 * listener, so a silently dropped node still counts as a failure.
 */
export function insertQuoteChip(quote: Quote): boolean {
  const editor = ensureAttached()
  if (!editor) return false
  const Klass = chipClassOf(editor)
  if (!Klass) return false

  const insert: ChipInsert = {
    source: QUOTE_SOURCE,
    ref: quote.id,
    label: chipLabel(quote.text, 120),
    appearance: 'session',
    clipboardText: CHIP_PLACEHOLDER,
  }

  let placed = false
  try {
    editor.update?.(
      () => {
        placed = placeChip(editor, Klass, insert)
      },
      { discrete: true },
    )
  } catch {
    return false
  }
  if (!placed) return false
  // A node that never reached the document would leave the store ahead of the
  // editor; treat it as a failure so the caller can fall back.
  return present.has(quote.id)
}

/** Runs inside `editor.update`: split the caret text and drop the chip between. */
function placeChip(
  editor: LexicalEditorLike,
  Klass: new (insert: ChipInsert) => LexicalNode,
  insert: ChipInsert,
): boolean {
  const state = stateOf(editor)
  const map = state?._nodeMap
  if (!map) return false
  const chip = new Klass(insert)
  const anchor = state?._selection?.anchor ?? null

  if (anchor && anchor.type === 'text') {
    const node = map.get(anchor.key)
    if (node && typeof node.splitText === 'function' && node.isAttached?.() !== false) {
      const size =
        typeof node.getTextContentSize === 'function'
          ? node.getTextContentSize()
          : (node.getChildrenSize?.() ?? 0)
      const at = Math.max(0, Math.min(anchor.offset, size))
      if (at === 0) {
        node.insertBefore?.(chip)
        return finish(chip)
      }
      const [head] = node.splitText(at)
      if (head && typeof head.insertAfter === 'function') {
        head.insertAfter(chip, false)
        return finish(chip)
      }
    }
  } else if (anchor && anchor.type === 'element') {
    const node = map.get(anchor.key)
    if (node && typeof node.splice === 'function') {
      node.splice(Math.max(0, anchor.offset), 0, [chip])
      return finish(chip)
    }
  }

  // No usable caret (focus is in the transcript): append to the last block.
  const root = map.get('root')
  const blocks = typeof root?.getChildren === 'function' ? root.getChildren() : []
  const last = blocks.length > 0 ? blocks[blocks.length - 1] : null
  if (last && typeof last.append === 'function') {
    last.append(chip)
    return finish(chip)
  }
  if (root && typeof root.append === 'function') {
    root.append(chip)
    return finish(chip)
  }
  return false
}

/** Park the caret just after the fresh chip, then report success. */
function finish(chip: LexicalNode): boolean {
  try {
    chip.selectNext?.(0, 0)
  } catch {
    // Caret placement is cosmetic; the node itself is what matters.
  }
  return true
}

/**
 * Register our reference source on the host's trigger service.
 *
 * The service may not exist yet when the plugin applies (it is a sibling
 * client plugin), so registration retries briefly instead of giving up.
 */
export interface QuoteOpeners {
  /** Open a pasted long body in the right-hand detail pane. */
  openDetail(text: string, long: boolean): void
  /** Scroll back to the quoted source and underline it. */
  locate(text: string, id: string): void
}

export function registerQuoteSource(
  ctx: { get?: (name: string) => unknown },
  openers: QuoteOpeners,
): () => void {
  let dispose: (() => void) | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let attempts = 0

  const install = (): boolean => {
    if (dispose !== null) return true
    let service: TriggerService | null = null
    try {
      service = (ctx.get?.('inputTriggers') as TriggerService | undefined) ?? null
    } catch {
      service = null
    }
    if (!service || typeof service.registerSource !== 'function') return false
    try {
      dispose = service.registerSource({
        trigger: SOURCE_TRIGGER,
        name: QUOTE_SOURCE,
        codec: {
          clipboardText: (ref: string) => ref,
          serialize: (ref: string) => Promise.resolve(serializeQuote(ref)),
        },
        openReference: (_session: unknown, reference: { ref?: unknown }): boolean =>
          openQuote(typeof reference?.ref === 'string' ? reference.ref : '', openers),
      })
    } catch {
      // A duplicate registration (plugin reload) is not fatal: the existing
      // source already routes clicks and serializes.
      dispose = () => {}
    }
    return true
  }

  if (!install() && typeof window !== 'undefined') {
    timer = setInterval(() => {
      attempts += 1
      if (install() || attempts >= 40) {
        if (timer !== null) clearInterval(timer)
        timer = null
      }
    }, 250)
  }

  return () => {
    if (timer !== null) clearInterval(timer)
    timer = null
    dispose?.()
    dispose = null
  }
}

/** Click routing for a chip: underline the source, or open a pasted body. */
function openQuote(id: string, openers: QuoteOpeners): boolean {
  const quote = getQuotes().find((item) => item.id === id)
  if (!quote) return false
  if (quote.long) {
    openers.openDetail(quote.text, true)
    return true
  }
  openers.locate(quote.text, quote.id)
  return true
}

/**
 * Last-resort serializer: only reached when a chip survives to submit without
 * the fold step (another send path). Keeping it readable is better than
 * rejecting the message.
 */
function serializeQuote(ref: string): string {
  const quote = getQuotes().find((item) => item.id === ref)
  if (!quote) return ''
  return `\n<quote>\n${quote.text}\n</quote>\n`
}
