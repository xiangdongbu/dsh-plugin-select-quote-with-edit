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

import { chipLabel, CHIP_PLACEHOLDER, DRAFT_MARKER, QUOTE_MARK, type Quote } from './protocol.ts'
import { getQuotes, removeQuote, replaceQuotes } from './store.ts'

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
  getTextContent?: () => string
  getTextContentSize?: () => number
  getChildren?: () => LexicalNode[]
  getChildrenSize?: () => number
  getNextSibling?: () => LexicalNode | null
  getParent?: () => LexicalNode | null
  getIndexWithinParent?: () => number
  getPreviousSibling?: () => LexicalNode | null
  isAttached?: () => boolean
  remove?: () => void
  splitText?: (offset: number) => LexicalNode[]
  select?: (anchorOffset: number, focusOffset: number) => void
  insertBefore?: (node: LexicalNode, restoreSelection?: boolean) => void
  insertAfter?: (node: LexicalNode, restoreSelection?: boolean) => void
  append?: (node: LexicalNode) => void
  splice?: (start: number, deleteCount: number, nodes: LexicalNode[]) => void
  selectNext?: (anchorOffset?: number, focusOffset?: number) => void
  /** Raw chip fields (see ReferenceChipNode): readable without a $ context. */
  __source?: unknown
  __ref?: unknown
  /** Raw text content on a plain Lexical TextNode. */
  __text?: unknown
  /** Raw child list on an ElementNode: `getChildren()` is NOT safe outside `$`. */
  __children?: unknown
  /** Lexical ≥0.23 keeps children as a linked list of *node keys*, not nodes. */
  __first?: string | LexicalNode | null
  __next?: string | LexicalNode | null
}

/** A collapsed selection point (Lexical `Point`), duck-typed. */
interface SelectionPoint {
  key: string
  offset: number
  type: string
  getNode?: () => LexicalNode | null
}

interface EditorStateLike {
  _nodeMap?: Map<string, LexicalNode>
  _selection?: {
    anchor?: SelectionPoint
    focus?: SelectionPoint
  } | null
  read?: (fn: () => void) => void
}

interface LexicalEditorLike {
  _editorState?: EditorStateLike
  _pendingEditorState?: EditorStateLike | null
  _nodes?: Map<string, { klass?: new (...args: never[]) => LexicalNode }>
  update?: (fn: () => void, options?: { discrete?: boolean }) => void
  getEditorState?: () => EditorStateLike
  getElementByKey?: (key: string) => Element | null
  registerUpdateListener?: (fn: (payload: { editorState: EditorStateLike }) => void) => () => void
}

type PresenceListener = (present: ReadonlySet<string>) => void

/** Opt-in tracing: set `globalThis.__dsqeDebug = true` in the console. */
function trace(event: string, data?: unknown): void {
  const flag = (globalThis as { __dsqeDebug?: boolean }).__dsqeDebug
  if (flag !== true) return
  console.log(`[dsqe] ${event}`, data ?? '')
}

/** Private-use marks are invisible in a console dump; show them as `<M>`. */
function escapeMarks(text: string): string {
  return text.split(QUOTE_MARK).join('<M>')
}

/** The slice of `ctx.inputTriggers` this plugin uses. */
interface TriggerService {
  registerSource(source: unknown): () => void
}

const listeners = new Set<PresenceListener>()
const keyOf = new Map<string, string>()
let attached: { editor: LexicalEditorLike; off: () => void } | null = null
let present: ReadonlySet<string> = new Set<string>()
let activeId: string | null = null
/**
 * Quote ids this plugin has already placed in the current editor, and ids it
 * has ever *seen* placed. Together they make insertion idempotent across the
 * overlay remounting (which resets React state) and across an editor update
 * that reports a chip we already inserted.
 */
const owned = new Set<string>()
const seenPlaced = new Set<string>()
/** Per-quote failed-insert counter: two failures means "give up, use the row". */
const failures = new Map<string, number>()
/**
 * Quotes dropped by a chip deletion, keyed by id. `⌘/Ctrl + Z` restores the
 * chip node but not the store entry; seeing the chip again puts the quote back
 * so an undone deletion never leaves a chip that sends nothing.
 */
const stashed = new Map<string, Quote>()
const STASH_LIMIT = 20

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

/**
 * The committed state only. A pending state can be mid-update (or a stale
 * leftover) and would make a chip look deleted for one frame.
 */
function committedOf(editor: LexicalEditorLike): EditorStateLike | null {
  return editor.getEditorState?.() ?? editor._editorState ?? null
}

function chipClassOf(editor: LexicalEditorLike): (new (insert: ChipInsert) => LexicalNode) | null {
  const entry = editor._nodes?.get?.(CHIP_TYPE)
  const klass = entry?.klass
  return typeof klass === 'function' ? (klass as unknown as new (insert: ChipInsert) => LexicalNode) : null
}

/** The host's plain text node class (`$createTextNode` is not ours to import). */
function textClassOf(editor: LexicalEditorLike): (new (text: string) => LexicalNode) | null {
  const entry = editor._nodes?.get?.('text') as
    | { klass?: new (text: string) => LexicalNode; replace?: new (text: string) => LexicalNode }
    | undefined
  // `replace` is what `$applyNodeReplacement` would mint; inserting a raw
  // `klass` instance makes Lexical reject the node (replacement mismatch).
  const klass = entry?.replace ?? entry?.klass
  return typeof klass === 'function' ? klass : null
}

/** The host's paragraph class, for the empty-editor case below. */
function paragraphClassOf(editor: LexicalEditorLike): (new () => LexicalNode) | null {
  const entry = editor._nodes?.get?.('paragraph') as
    | { klass?: new () => LexicalNode; replace?: new () => LexicalNode }
    | undefined
  const klass = entry?.replace ?? entry?.klass
  return typeof klass === 'function' ? klass : null
}

/** True when this host can host inline chips at all. */
export function inlineChipsSupported(): boolean {
  const editor = editorOf()
  if (!editor) return false
  return chipClassOf(editor) !== null
}

/**
 * The chip's source name.
 *
 * Read the raw field first: `getSource()` goes through `$getNodeByKey`, which
 * throws Lexical #195 ("unable to find an active editor state") when called
 * from an update listener — the exact place we read chips. The getter stays as
 * a fallback for a host that renames its fields.
 */
function sourceOf(node: LexicalNode): unknown {
  if (typeof node.__source === 'string') return node.__source
  try {
    return typeof node.getSource === 'function' ? node.getSource() : undefined
  } catch {
    return undefined
  }
}

/** The chip's owner-scoped reference id, read the same defensive way. */
function refOf(node: LexicalNode): unknown {
  if (typeof node.__ref === 'string') return node.__ref
  try {
    return typeof node.getReference === 'function' ? node.getReference() : undefined
  } catch {
    return undefined
  }
}

/** Every quote id that owns a chip in one editor state. */
function chipRefsOf(state: EditorStateLike | null): { refs: Set<string>; keys: Map<string, string> } {
  const refs = new Set<string>()
  const keys = new Map<string, string>()
  const map = state?._nodeMap
  if (!map || typeof map.forEach !== 'function') return { refs, keys }
  map.forEach((node) => {
    if (!node) return
    // One unreadable node must never abort the walk — a throwing listener makes
    // the host swallow the whole commit and our caller misread it as a failed
    // insert (which is how chips used to pile up).
    try {
      if (typeof node.getType === 'function' && node.getType() !== CHIP_TYPE) return
      if (sourceOf(node) !== QUOTE_SOURCE) return
      const ref = refOf(node)
      if (typeof ref !== 'string' || ref.length === 0) return
      refs.add(ref)
      const key = node.getKey?.()
      if (typeof key === 'string') keys.set(ref, key)
    } catch {
      // ignore this node
    }
  })
  return { refs, keys }
}

function scan(state: EditorStateLike | null): void {
  let found = chipRefsOf(state)
  // No chip at all: the fields may be private in a newer host, so retry the
  // getters inside a real `$` context (`read`) before believing the state.
  if (found.refs.size === 0 && typeof state?.read === 'function') {
    try {
      state.read(() => {
        found = chipRefsOf(state)
      })
    } catch {
      // keep the empty result
    }
  }
  keyOf.clear()
  for (const [ref, key] of found.keys) keyOf.set(ref, key)
  // An undone deletion brings the chip node back without the store entry: the
  // stash puts the quote back so the chip is never a dead end.
  for (const id of found.refs) {
    const quote = stashed.get(id)
    if (quote === undefined) continue
    stashed.delete(id)
    if (!getQuotes().some((item) => item.id === id)) replaceQuotes([...getQuotes(), quote])
  }
  // A chip that was once placed and is gone now was deleted by the user: the
  // quote may be inserted again if it ever comes back (withdraw / undo).
  for (const id of owned) {
    if (!found.refs.has(id) && seenPlaced.has(id)) owned.delete(id)
  }
  for (const id of found.refs) seenPlaced.add(id)
  present = found.refs
  paintActive()
  trace('scan', { present: [...found.refs], dom: chipInDom() })
  for (const listener of listeners) listener(found.refs)
}

/** Ring the chip whose source text is currently underlined in the transcript. */
function paintActive(): void {
  const editor = attached?.editor
  if (!editor || typeof editor.getElementByKey !== 'function') return
  for (const [quoteId, key] of keyOf) {
    const element = editor.getElementByKey(key)
    if (!element) continue
    // The clipboard serializer needs to know which quote a chip element is:
    // the host's DOM only carries `data-composer-chip="<source>"`.
    if (element.getAttribute('data-composer-chip-ref') !== quoteId) {
      element.setAttribute('data-composer-chip-ref', quoteId)
    }
    if (quoteId === activeId) element.setAttribute('data-dsqe-active', '')
    else element.removeAttribute('data-dsqe-active')
  }
}

/** Bind to the current editor, rebinding when the composer is rebuilt. */
function ensureAttached(): LexicalEditorLike | null {
  const editor = editorOf()
  if (!editor) return null
  if (attached?.editor === editor) return editor
  trace('attach', {
    rebind: attached !== null,
    editors: document.querySelectorAll('[data-lexical-editor="true"]').length,
  })
  attached?.off()
  const off = editor.registerUpdateListener?.(({ editorState }) => scan(editorState)) ?? (() => {})
  attached = { editor, off }
  scan(committedOf(editor))
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

/**
 * Ground truth for "this quote still owns a chip right now".
 *
 * Used before dropping a pending quote: a presence set can be one state behind
 * (an editor swap, a mid-commit read), and acting on that would delete a quote
 * whose chip is perfectly visible.
 */
export function chipPresent(id: string): boolean {
  if (present.has(id)) return true
  const editor = attached?.editor ?? editorOf()
  if (!editor) return chipInDom()
  return chipRefsOf(committedOf(editor)).refs.has(id)
}

/** The node payload for one pending quote (shared by insert and restore). */
function chipInsertFor(quote: Quote): ChipInsert {
  return {
    source: QUOTE_SOURCE,
    ref: quote.id,
    label: chipLabel(quote.text, 120),
    appearance: 'session',
    clipboardText: CHIP_PLACEHOLDER,
  }
}

/**
 * Children of a node, read without a `$` context.
 *
 * `ElementNode.getChildren()` goes through `getLatest()` → `$getNodeByKey`,
 * which throws Lexical #195 when called from outside an editor update — the
 * exact place the composer overlay reads the tree. The raw links are the same
 * data: Lexical ≥0.23 keeps children as a linked list of node *keys*
 * (`__first` / `__next`, resolved through the state's `_nodeMap`), older builds
 * keep a `__children` array.
 */
function childrenOf(node: LexicalNode, map?: Map<string, LexicalNode>): LexicalNode[] {
  const array = node.__children
  if (Array.isArray(array)) return array as LexicalNode[]
  const first = node.__first
  if (first !== null && first !== undefined) {
    if (typeof first === 'object') {
      const out: LexicalNode[] = []
      let current: LexicalNode | null = first
      for (let guard = 0; current && guard < 10_000; guard += 1) {
        out.push(current)
        current = typeof current.__next === 'object' ? current.__next : null
      }
      return out
    }
    if (map !== undefined) {
      const out: LexicalNode[] = []
      let key: string | LexicalNode | null = first
      for (let guard = 0; typeof key === 'string' && guard < 10_000; guard += 1) {
        const child = map.get(key)
        if (!child) break
        out.push(child)
        key = child.__next ?? null
      }
      return out
    }
  }
  try {
    return typeof node.getChildren === 'function' ? node.getChildren() : []
  } catch {
    return []
  }
}

/** True when a node is one of the host's reference chips. */
function isChipNode(node: LexicalNode): boolean {
  // Instances of this build carry no `getType`; the constructor's static one
  // does. Fall back to "carries our source", which only a chip can.
  try {
    const ctor = (node as { constructor?: { getType?: () => string } }).constructor
    const type = typeof ctor?.getType === 'function' ? ctor.getType() : undefined
    if (type !== undefined) return type === CHIP_TYPE
  } catch {
    // fall through to the source check
  }
  return sourceOf(node) === QUOTE_SOURCE
}

/**
 * Quote ids that own a chip right now, **in document order**.
 *
 * The composer's clipboard projection carries one U+FFFC per chip in the same
 * order, so this list is what turns "there are two placeholders" into "the
 * first one is quote A". `_nodeMap` iteration order is *not* document order
 * (it is creation order), hence the tree walk.
 */
export function chipOrder(): string[] {
  const editor = attached?.editor ?? editorOf()
  if (!editor) return []
  const state = committedOf(editor)
  const map = state?._nodeMap
  const root = map?.get?.('root') ?? null
  if (!map || !root) return []
  const out: string[] = []
  const walk = (node: LexicalNode, depth: number): void => {
    if (depth > 24) return
    try {
      if (isChipNode(node)) {
        if (sourceOf(node) === QUOTE_SOURCE) {
          const ref = refOf(node)
          if (typeof ref === 'string' && ref.length > 0) out.push(ref)
        }
        return
      }
      for (const child of childrenOf(node, map)) walk(child, depth + 1)
    } catch {
      // one unreadable node must not hide the rest
    }
  }
  walk(root, 0)
  trace(
    'order',
    JSON.stringify({
      attachedIsLive: attached?.editor === editorOf(),
      out: out.length,
      top: childrenOf(root, map).map((child) => {
        const ctor = (child as { constructor?: { getType?: () => string; name?: string } }).constructor
        return {
          ctor: ctor?.name,
          ctorType: typeof ctor?.getType === 'function' ? ctor.getType() : null,
          src: String((child as { __source?: unknown }).__source),
          kids: childrenOf(child, map).length,
        }
      }),
    }),
  )
  return out
}

/** First QUOTE_MARK left in the document, as (text node, offset). */
function firstMark(
  node: LexicalNode,
  map?: Map<string, LexicalNode>,
  depth = 0,
): { node: LexicalNode; offset: number } | null {
  if (depth > 24) return null
  const text = typeof node.__text === 'string' ? node.__text : null
  if (text !== null) {
    const offset = text.indexOf(QUOTE_MARK)
    return offset >= 0 ? { node, offset } : null
  }
  for (const child of childrenOf(node, map)) {
    const hit = firstMark(child, map, depth + 1)
    if (hit !== null) return hit
  }
  return null
}

/** Every text node that still carries marks, with its mark offsets (ascending). */
function markNodes(
  node: LexicalNode,
  map: Map<string, LexicalNode>,
  out: { node: LexicalNode; offsets: number[] }[] = [],
  depth = 0,
): { node: LexicalNode; offsets: number[] }[] {
  if (depth > 24) return out
  const text = typeof node.__text === 'string' ? node.__text : null
  if (text !== null) {
    if (text.includes(QUOTE_MARK)) {
      const offsets: number[] = []
      for (let index = 0; index < text.length; index += 1) {
        if (text[index] === QUOTE_MARK) offsets.push(index)
      }
      out.push({ node, offsets })
    }
    return out
  }
  for (const child of childrenOf(node, map)) markNodes(child, map, out, depth + 1)
  return out
}

/**
 * Delete one mark character from `node` without leaving a trace. Last-resort
 * cleanup for a failed swap: a leftover mark is invisible to the user but
 * keeps {@link hasRestoreMarks} true forever, which freezes the panel's
 * insertion effect and piles every pending quote up behind it. Best effort —
 * when even this cannot cut the character out, the whole node goes.
 */
function removeMarkBestEffort(node: LexicalNode, offset: number): void {
  try {
    const text = String(node.__text ?? '')
    if (text.length <= 1) {
      node.remove?.()
      return
    }
    if (offset === 0) {
      const parts = node.splitText?.(1) ?? []
      parts[0]?.remove?.()
      return
    }
    const [head, tail] = node.splitText?.(offset) ?? []
    if (!tail) {
      node.remove?.()
      return
    }
    const parts = typeof tail.splitText === 'function' ? tail.splitText(1) : []
    parts[0]?.remove?.()
    void head
  } catch {
    try {
      node.remove?.()
    } catch {
      // nothing more to try
    }
  }
}

/**
 * Replace the mark character at `offset` with `chip`, keeping the text around
 * it, and return the node that now holds the remainder (so a second mark in
 * the same text node can be handled with a valid cursor).
 */
function swapMarkForChip(node: LexicalNode, offset: number, chip: LexicalNode | null): LexicalNode | null {
  if (typeof node.splitText !== 'function') {
    trace('swap:no-split', escapeMarks(String(node.__text ?? '')))
    removeMarkBestEffort(node, offset)
    return null
  }
  const source = escapeMarks(String(node.__text ?? ''))
  // `splitText(0)` is not a split (the host returns the node untouched, with no
  // remainder), so a mark sitting at the head of a text node is cut off from
  // the other end instead.
  if (offset === 0) {
    // A node that IS the mark — the pasted-mark case, where the character
    // lands alone in its own text node — cannot be split at all: there is no
    // remainder to cut towards. Replace the node in place. (This used to fall
    // into the generic head branch, fail on the missing remainder, and strand
    // the quote behind an invisible mark that blocked every later insert.)
    if (String(node.__text ?? '').length === 1) {
      if (chip !== null) node.insertBefore?.(chip)
      node.remove?.()
      trace('swap:ok', { offset, chip: chip !== null, mode: 'head-solo', rest: '' })
      return null
    }
    const parts = typeof node.splitText === 'function' ? node.splitText(1) : []
    const mark = parts[0] ?? null
    const rest = parts[1] ?? null
    if (mark === null || rest === null) {
      trace('swap:head-failed', { offset, text: source })
      removeMarkBestEffort(node, 0)
      return null
    }
    if (chip !== null) rest.insertBefore?.(chip)
    mark.remove?.()
    trace('swap:ok', { offset, chip: chip !== null, mode: 'head', rest: escapeMarks(String(rest.__text ?? '')) })
    return rest
  }
  const [head, tail] = node.splitText(offset)
  if (!tail) {
    trace('swap:no-tail', { offset, text: source })
    removeMarkBestEffort(node, offset)
    return null
  }
  const parts = typeof tail.splitText === 'function' ? tail.splitText(1) : []
  const mark = parts[0] ?? null
  const rest = parts[1] ?? null
  if (mark === null) {
    trace('swap:mark-failed', { offset, text: source })
    removeMarkBestEffort(node, offset)
    return null
  }
  if (chip !== null && head && typeof head.insertAfter === 'function') {
    head.insertAfter(chip, false)
  }
  mark.remove?.()
  trace('swap:ok', {
    offset,
    chip: chip !== null,
    mode: 'mid',
    head: escapeMarks(String(head?.__text ?? '')),
    rest: rest === null ? null : escapeMarks(String(rest.__text ?? '')),
  })
  return rest ?? null
}

/**
 * Put chips back where {@link QUOTE_MARK} says they were.
 *
 * Used by the withdraw refill and by a paste of composed content: the marked
 * text is written first (the host accepts U+E000), then each mark becomes the
 * chip of the matching id, in document order.
 *
 * @param ids - quote ids, in mark order.
 * @returns whether any chip was placed.
 */
export function materializeQuoteMarks(ids: readonly string[]): boolean {
  const editor = ensureAttached()
  if (!editor) return false
  const Klass = chipClassOf(editor)
  if (!Klass) return false
  const quotes = new Map(getQuotes().map((quote) => [quote.id, quote]))
  let placed = 0
  let dropped = 0
  let seen = 0
  try {
    editor.update?.(
      () => {
        const state = stateOf(editor)
        const map = state?._nodeMap
        const root = map?.get?.('root') ?? null
        if (!map || !root) return
        const entries = markNodes(root, map)
        trace(
          'marks:nodes',
          JSON.stringify(
            entries.map((entry) => ({
              text: escapeMarks(String(entry.node.__text ?? '')),
              offsets: entry.offsets,
            })),
          ),
        )
        for (const entry of entries) {
          // One node may hold several marks: walk it once with a cursor, so
          // each offset stays valid after the previous split.
          let tail: LexicalNode | null = entry.node
          let base = 0
          for (const offset of entry.offsets) {
            if (tail === null) break
            const id = ids[seen]
            seen += 1
            const quote = id === undefined ? undefined : quotes.get(id)
            tail = swapMarkForChip(
              tail,
              offset - base,
              quote === undefined ? null : new Klass(chipInsertFor(quote)),
            )
            if (quote === undefined) dropped += 1
            else placed += 1
            base = offset + 1
          }
        }
      },
      { discrete: true },
    )
  } catch (error) {
    trace('marks:threw', String(error))
    return false
  }
  scan(committedOf(editor))
  // The pasted draft can carry U+200B fillers (an older copy, or the host's
  // own normalization): drop them now, or Backspace spends its first presses
  // on characters the user cannot see.
  tidyFillers()
  // Honest bookkeeping: count the marks that actually remain in the tree. A
  // failed swap used to be counted as placed, which stranded its quote behind
  // an invisible mark — and with a mark stuck in the draft, hasRestoreMarks()
  // froze the panel's insertion effect, so repeated pastes piled up orphan
  // quotes that all came out at once later (the wall of duplicate chips).
  const committedState = stateOf(editor)
  const committedMap = committedState?._nodeMap
  const committedRoot = committedMap?.get?.('root') ?? null
  const leftover =
    committedRoot && committedMap
      ? markNodes(committedRoot, committedMap).reduce((total, entry) => total + entry.offsets.length, 0)
      : 0
  if (leftover > 0) {
    placed = Math.max(0, placed - leftover)
    trace('marks:leftover', { leftover })
  }
  trace('marks:placed', { placed, dropped, seen, present: [...present] })
  for (const id of ids) {
    if (present.has(id)) owned.add(id)
  }
  return placed > 0
}

/**
 * True while marked text is still waiting to become chips (the marked draft
 * has not landed in the editor yet). The caller must not run the ordinary
 * "one chip per pending quote" insertion during that window — it would append
 * duplicates behind the marks.
 */
export function hasRestoreMarks(): boolean {
  const editor = attached?.editor ?? editorOf()
  if (!editor) return false
  const map = committedOf(editor)?._nodeMap
  const root = map?.get?.('root') ?? null
  return root !== null && map !== undefined && firstMark(root, map) !== null
}

/**
 * Remove the caret filler U+200Bs the plugin (and a paste of an older copy)
 * left behind, so Backspace never spends a press on an invisible character.
 *
 * - With real text anywhere, every U+200B goes — standalone filler nodes and
 *   runs embedded in typed text alike.
 * - With only chips pending, exactly one survives: it is what keeps the send
 *   button enabled while the draft has no characters.
 *
 * Must run from a user gesture (keydown) or right after materialization, never
 * from a later task: the host swallows editor updates issued outside its own
 * input processing.
 */
export function tidyFillers(): boolean {
  const editor = attached?.editor ?? editorOf()
  if (!editor) return false
  let touched = false
  try {
    editor.update?.(() => {
      const state = stateOf(editor)
      const map = state?._nodeMap
      const root = map?.get?.('root')
      if (!map || !root) return
      // Snapshot the text nodes once; splits below mint fresh nodes on purpose.
      const texts: LexicalNode[] = []
      const collect = (node: LexicalNode, depth: number): void => {
        if (depth > 24) return
        const text = typeof node.__text === 'string' ? node.__text : null
        if (text !== null) {
          if (text.includes(DRAFT_MARKER)) texts.push(node)
          return
        }
        for (const child of childrenOf(node, map)) collect(child, depth + 1)
      }
      collect(root, 0)
      if (texts.length === 0) return
      const real = texts.some((node) => String(node.__text).replace(DRAFT_MARKER, '').length > 0)
      /** With nothing but chips pending, the first filler stays (send button). */
      let kept = false
      for (const node of texts) {
        let current: LexicalNode | null = node
        for (let guard = 0; current !== null && guard < 64; guard += 1) {
          const text = String(current.__text ?? '')
          const at = text.indexOf(DRAFT_MARKER)
          if (at < 0) break
          if (text.replace(DRAFT_MARKER, '').length === 0) {
            if (!real && !kept) {
              kept = true
              break
            }
            const parent = current.getParent?.() ?? null
            const key = current.getKey?.()
            try {
              current.remove?.()
              touched = true
            } catch {
              break
            }
            // If the caret sat inside the removed filler, re-anchor it.
            try {
              const anchor = state._selection?.anchor
              if (anchor && anchor.type === 'text' && anchor.key === key) {
                parent?.select?.(0, 0)
              }
            } catch {
              // caret placement is cosmetic
            }
            break
          }
          // Embedded run: split it out of the real text, drop the piece, and
          // keep scanning whatever follows it.
          if (typeof current.splitText !== 'function') break
          let runLength = 0
          while (at + runLength < text.length && text[at + runLength] === DRAFT_MARKER) runLength += 1
          try {
            const parts = at > 0 ? current.splitText(at) : [null, current]
            const tail = (parts[1] ?? null) as LexicalNode | null
            if (tail === null) break
            const tailText = String(tail.__text ?? '')
            if (runLength < tailText.length && typeof tail.splitText === 'function') {
              const split = tail.splitText(runLength)
              const filler = (split[0] ?? null) as LexicalNode | null
              const rest = (split[1] ?? null) as LexicalNode | null
              filler?.remove?.()
              touched = true
              current = rest
            } else {
              tail.remove?.()
              touched = true
              current = null
            }
          } catch {
            break
          }
        }
      }
      trace('tidy', { touched, real, nodes: texts.length })
    }, { discrete: true })
  } catch (error) {
    trace('tidy:threw', String(error))
  }
  return touched
}

/**
 * A paste has already written its marked text straight into the editor and
 * only needs the marks swapped for chips. The panel consumes this on its next
 * pass, which keeps insertion in one place (and out of a race with its own
 * "one chip per pending quote" loop).
 */
let queuedRestore: string[] | null = null

export function queueQuoteRestore(ids: readonly string[]): void {
  queuedRestore = ids.length > 0 ? [...ids] : null
}

export function takeQueuedQuoteRestore(): string[] | null {
  const queued = queuedRestore
  queuedRestore = null
  return queued
}

/** Forget cached presence (session switch): the editor content is replaced. */
export function resetInlineChips(): void {
  present = new Set<string>()
  keyOf.clear()
  activeId = null
  owned.clear()
  seenPlaced.clear()
  failures.clear()
  stashed.clear()
  queuedRestore = null
}

/** The composer currently shows a chip of ours (ground truth, DOM level). */
function chipInDom(): boolean {
  if (typeof document === 'undefined') return false
  return document.querySelector(`[data-composer-chip="${QUOTE_SOURCE}"]`) !== null
}

/**
 * Insert one quote chip at the caret as an atomic inline node.
 *
 * Idempotent: a quote that already owns a chip (or that this plugin already
 * placed) is a success without touching the editor again. That guard is what
 * keeps the caller's retry loop from minting a second, third, hundredth chip
 * when anything about the editor read-back is unreliable.
 *
 * Returns false only when the host cannot place it (no editor, type not
 * registered, the edit threw) — the caller's cue to fall back to the chip row.
 */
export function insertQuoteChip(quote: Quote): boolean {
  const editor = ensureAttached()
  if (!editor) {
    trace('insert:no-editor', quote.id)
    return false
  }
  if (present.has(quote.id) || owned.has(quote.id)) {
    trace('insert:already', { id: quote.id, present: present.has(quote.id) })
    owned.add(quote.id)
    return true
  }
  const current = chipRefsOf(committedOf(editor))
  if (current.refs.has(quote.id)) {
    trace('insert:found-in-state', quote.id)
    owned.add(quote.id)
    present = current.refs
    return true
  }
  const failed = failures.get(quote.id) ?? 0
  if (failed >= 2) {
    trace('insert:gave-up', quote.id)
    return false
  }
  const Klass = chipClassOf(editor)
  if (!Klass) {
    trace('insert:no-class', quote.id)
    return false
  }

  const insert: ChipInsert = chipInsertFor(quote)

  let placed = false
  try {
    editor.update?.(
      () => {
        placed = placeChip(editor, Klass, insert)
      },
      { discrete: true },
    )
  } catch (error) {
    failures.set(quote.id, failed + 1)
    trace('insert:threw', String(error))
    return false
  }
  if (!placed) {
    failures.set(quote.id, failed + 1)
    trace('insert:not-placed', quote.id)
    return false
  }
  owned.add(quote.id)
  failures.delete(quote.id)
  // Re-read the committed state so presence does not depend on the update
  // listener alone (it can be dropped when the editor swaps instances).
  scan(committedOf(editor))
  const ok = present.has(quote.id) || chipInDom()
  trace('insert:placed', { id: quote.id, present: [...present], ok })
  if (!ok) failures.set(quote.id, failed + 1)
  return ok
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
        return finish(editor, chip)
      }
      const [head] = node.splitText(at)
      if (head && typeof head.insertAfter === 'function') {
        head.insertAfter(chip, false)
        return finish(editor, chip)
      }
    }
  } else if (anchor && anchor.type === 'element') {
    const node = map.get(anchor.key)
    const root = map.get('root')
    if (node && node === root) {
      // A caret on the root itself (empty composer, or focus parked outside
      // the text): only blocks may live there, so aim at the block the caret
      // points at — the chip must start out inside a line.
      const placed = placeInBlock(editor, chip, root, anchor.offset)
      if (placed) return finish(editor, chip)
    } else if (node && typeof node.splice === 'function') {
      node.splice(Math.max(0, anchor.offset), 0, [chip])
      return finish(editor, chip)
    }
  }

  // No usable caret (focus is in the transcript): append to the last block.
  const root = map.get('root')
  if (root && placeInBlock(editor, chip, root, Number.POSITIVE_INFINITY)) {
    return finish(editor, chip)
  }
  return false
}

/**
 * Insert `chip` inside one of the root's blocks (never straight into the root),
 * minting a paragraph when the composer has none yet.
 */
function placeInBlock(
  editor: LexicalEditorLike,
  chip: LexicalNode,
  root: LexicalNode,
  offset: number,
): boolean {
  let blocks: LexicalNode[] = []
  try {
    blocks = typeof root.getChildren === 'function' ? root.getChildren() : []
  } catch {
    blocks = []
  }
  if (blocks.length === 0) {
    const ParagraphKlass = paragraphClassOf(editor)
    if (!ParagraphKlass) return false
    try {
      const paragraph = new ParagraphKlass()
      root.append?.(paragraph)
      if (typeof paragraph.append !== 'function') return false
      paragraph.append(chip)
      return true
    } catch (error) {
      trace('place:paragraph-threw', String(error))
      return false
    }
  }
  const last = blocks[blocks.length - 1]
  if (offset >= blocks.length) {
    if (typeof last.append !== 'function') return false
    last.append(chip)
    return true
  }
  const block = blocks[Math.max(0, offset)]
  if (typeof block.splice !== 'function') return false
  block.splice(0, 0, [chip])
  return true
}

/**
 * Park the caret just after the fresh chip.
 *
 * No trailing filler text: minting a text node here fights Lexical's own
 * normalization (a throw inside the update rolls the whole insertion back), and
 * the caret landing on an element point is fine — {@link deleteAdjacentChip}
 * handles that case explicitly, which is why Backspace still removes the chip.
 */
function finish(editor: LexicalEditorLike, chip: LexicalNode): boolean {
  try {
    const parent = chip.getParent?.() ?? null
    const index = chip.getIndexWithinParent?.()
    const name = (parent as { constructor?: { name?: string } } | null)?.constructor?.name
    // Caret *inside the same paragraph*, right after the chip. `selectNext`
    // resolves to a root-level element point, which makes Backspace look at the
    // neighbouring block instead of the chip.
    //
    // The caret has to land in a *text* node: an element point at the end of a
    // block whose children are all decorators is normalised up to the root, and
    // the next keystroke then opens a second paragraph (the chip ended up on a
    // line of its own). A zero-length text node right after the chip gives the
    // caret somewhere real to sit.
    const TextKlass = textClassOf(editor)
    if (parent && typeof parent.select === 'function' && typeof index === 'number' && TextKlass) {
      // A text node right after the chip already gives the caret a home — the
      // split-path tail (placeChip) or an earlier filler. Selecting it costs
      // nothing; minting a second filler stacks invisible U+200Bs and the user
      // then presses Backspace on characters that do not exist.
      const next = chip.getNextSibling?.() ?? null
      const isTextNode = typeof next?.select === 'function' && typeof (next as { __text?: unknown }).__text === 'string'
      if (next !== null && isTextNode && typeof next.select === 'function') {
        try {
          next.select(0, 0)
          trace('finish:parent', { name, index, filler: 'reuse-next' })
          return true
        } catch (error) {
          trace('finish:select-threw', String(error))
        }
      }
      let filler: LexicalNode | null = null
      try {
        filler = new TextKlass(DRAFT_MARKER)
      } catch (error) {
        trace('finish:new-threw', String(error))
      }
      if (filler !== null) {
        try {
          // `splice` (element-level insert) is what the element-anchor branch
          // uses as well; `node.insertAfter` rejects a text node here.
          if (typeof parent.splice === 'function') parent.splice(index + 1, 0, [filler])
          else chip.insertAfter?.(filler, false)
        } catch (error) {
          trace('finish:insert-threw', String(error))
          filler = null
        }
      }
      if (filler !== null && typeof filler.select === 'function') {
        try {
          filler.select(0, 0)
          trace('finish:parent', { name, index, filler: true })
          return true
        } catch (error) {
          trace('finish:select-threw', String(error))
        }
      }
      parent.select(index + 1, index + 1)
      trace('finish:parent', { name, index, filler: false })
    } else {
      chip.selectNext?.(0, 0)
      trace('finish:next', { name, index, hasSelect: typeof parent?.select })
    }
  } catch (error) {
    trace('finish:threw', String(error))
  }
  return true
}

/**
 * The first / last leaf inside a node: an element point can name a whole block,
 * and the chip we care about is the block's edge child.
 */
function edgeLeaf(node: LexicalNode, side: 'first' | 'last'): LexicalNode | null {
  let current: LexicalNode | null = node
  for (let depth = 0; depth < 12 && current !== null; depth += 1) {
    const children: LexicalNode[] = current.getChildren?.() ?? []
    if (children.length === 0) return current
    current = side === 'first' ? children[0] : children[children.length - 1]
  }
  return current
}

/**
 * Delete the chip next to a collapsed caret, the way the user expects.
 *
 * Lexical deletes a preceding decorator only when the caret sits inside a text
 * node; a caret parked on an element point (the natural state right after a
 * chip at the end of a paragraph) makes Backspace split the paragraph instead.
 * Rather than depend on that, we look at the caret ourselves: if the neighbour
 * in the key's direction is *our* chip and there is no character to delete in
 * between, remove the node whole.
 *
 * @param backward - true for Backspace (previous neighbour), false for Delete.
 * @returns whether a chip was removed (the caller then swallows the key).
 */
function deleteAdjacentChip(backward: boolean): boolean {
  const editor = ensureAttached()
  if (!editor) return false
  let removedRef: string | null = null
  try {
    editor.update?.(
      () => {
        const state = stateOf(editor)
        const selection = state?._selection
        const anchor = selection?.anchor
        const focus = selection?.focus
        if (!anchor || !focus) return
        if (anchor.key !== focus.key || anchor.offset !== focus.offset) return
        const node = anchor.getNode?.() ?? state?._nodeMap?.get(anchor.key) ?? null
        trace('delete:probe', { type: anchor.type, offset: anchor.offset, node: node && node.getType?.() })
        if (!node) return
        let target: LexicalNode | null = null
        if (anchor.type === 'text') {
          const text = typeof node.__text === 'string' ? node.__text : ''
          if (backward) {
            if (anchor.offset !== 0) return
            target = node.getPreviousSibling?.() ?? null
          } else {
            if (anchor.offset !== text.length) return
            target = node.getNextSibling?.() ?? null
          }
        } else {
          const children = node.getChildren?.() ?? []
          const neighbour = backward ? (children[anchor.offset - 1] ?? null) : (children[anchor.offset] ?? null)
          // A block-level caret points at a paragraph; the chip lives one level
          // deeper, at the paragraph's first/last leaf.
          target = neighbour ? edgeLeaf(neighbour, backward ? 'last' : 'first') : null
        }
        if (!target) return
        if (typeof target.getType === 'function' && target.getType() !== CHIP_TYPE) return
        if (sourceOf(target) !== QUOTE_SOURCE) return
        const parent = target.getParent?.() ?? null
        const index = anchor.type === 'text' ? 0 : backward ? anchor.offset - 1 : anchor.offset
        const ref = refOf(target)
        target.remove?.()
        // Re-anchor the caret in the parent: a selection pointing at the removed
        // node makes Lexical skip the DOM reconciliation for this commit, which
        // is how a deleted chip used to stay on screen.
        try {
          parent?.select?.(Math.max(0, index), Math.max(0, index))
        } catch {
          // caret placement is cosmetic
        }
        removedRef = typeof ref === 'string' ? ref : null
      },
      { discrete: true },
    )
  } catch (error) {
    trace('delete:threw', String(error))
    return false
  }
  if (removedRef === null) return false
  // Drop the pending quote in the same breath: otherwise the panel sees "quote
  // in the store, no chip in the editor" and helpfully inserts it right back.
  const quote = getQuotes().find((item) => item.id === removedRef)
  if (quote !== undefined) {
    stashed.set(removedRef, quote)
    if (stashed.size > STASH_LIMIT) {
      const oldest = stashed.keys().next().value
      if (oldest !== undefined) stashed.delete(oldest)
    }
  }
  owned.delete(removedRef)
  removeQuote(removedRef)
  trace('delete:removed', removedRef)
  return true
}

/** Chip refs inside a non-collapsed selection, in document order. */
function chipsInSelection(): string[] {
  if (typeof window === 'undefined') return []
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return []
  const range = selection.getRangeAt(0)
  const refs: string[] = []
  for (const element of Array.from(
    document.querySelectorAll(`[data-composer-chip="${QUOTE_SOURCE}"]`),
  )) {
    if (!range.intersectsNode(element)) continue
    const ref = element.getAttribute('data-composer-chip-ref')
    if (typeof ref === 'string' && ref.length > 0) refs.push(ref)
  }
  return refs
}

/**
 * Keys that wipe the current selection rather than moving the caret.
 *
 * A selection that spans chips is deleted twice over: the host removes its own
 * text nodes, we remove the element chips. Caret-moving keys (arrows, Shift,
 * Tab, …) must not trigger the chip sweep, or merely extending a selection
 * would eat the quotes.
 */
function replacesSelection(key: string): boolean {
  if (key === 'Backspace' || key === 'Delete' || key === 'Enter') return true
  // IME confirmation / printable characters replace the selection as well.
  return key === 'Process' || key.length === 1
}

/**
 * Input types that replace the current selection. `beforeinput` is the only
 * signal for IME / `insertText` typing (Playwright and real IMEs both drive the
 * composer without a printable `keydown`), so the same sweep has to run there.
 */
function replacesSelectionWithInput(inputType: string): boolean {
  return (
    inputType === 'insertText' ||
    inputType === 'insertCompositionText' ||
    inputType === 'insertFromPaste' ||
    inputType === 'insertFromDrop' ||
    inputType.startsWith('delete')
  )
}

/**
 * Remove chips by ref: Select-all + Backspace / Delete only drops text nodes
 * in the host's own path, so the chips used to survive in an empty draft.
 */
function removeChipsByRef(refs: readonly string[]): number {
  if (refs.length === 0) return 0
  const editor = ensureAttached()
  if (!editor) return 0
  trace('removeChips:start', { refs, keys: [...keyOf] })
  let removed = 0
  try {
    editor.update?.(
      () => {
        const map = stateOf(editor)?._nodeMap
        if (!map) return
        for (const ref of refs) {
          const key = keyOf.get(ref)
          const node = key === undefined ? undefined : map.get(key)
          if (!node || typeof node.remove !== 'function') continue
          try {
            node.remove()
            removed += 1
          } catch {
            // ignore this chip
          }
        }
      },
      { discrete: true },
    )
  } catch (error) {
    trace('removeChips:threw', String(error))
  }
  // Re-read the tree: the host may have deleted whole paragraphs (chip
  // included) before this ran, in which case there is no node left to remove
  // but the quote must still stop being pending — otherwise the panel sees
  // "quote in the store, no chip" and helpfully inserts it again.
  const state = committedOf(editor)
  if (state !== null) scan(state)
  let dropped = 0
  for (const ref of refs) {
    if (state !== null) {
      if (keyOf.has(ref)) continue
    } else if (removed === 0) {
      continue
    }
    const quote = getQuotes().find((item) => item.id === ref)
    if (quote !== undefined) {
      stashed.set(ref, quote)
      if (stashed.size > STASH_LIMIT) {
        const oldest = stashed.keys().next().value
        if (oldest !== undefined) stashed.delete(oldest)
      }
    }
    owned.delete(ref)
    removeQuote(ref)
    dropped += 1
  }
  if (removed === 0 && dropped === 0) return 0
  trace('removeChips:removed', { removed, dropped })
  return Math.max(removed, dropped)
}

/**
 * Remove chips (and their pending quotes) covered by the current selection.
 *
 * The paste interceptor calls this when it takes over a paste that replaces a
 * selection holding chips: the host is about to delete those chips with the
 * selection, but nothing tells the store — and the panel's fallback loop would
 * then re-insert a chip for every orphaned quote. `execCommand` does not fire
 * `beforeinput` everywhere, so the usual sweep cannot be relied on here.
 */
export function removeChipsInSelection(): number {
  return removeChipsByRef(chipsInSelection())
}

/**
 * Swallow Backspace / Delete when it is aimed at one of our chips, and keep a
 * selection-spanning delete from leaving chips behind.
 *
 * Capture phase, so the host's own key handling never sees the key for the
 * single-chip case; every other keystroke passes straight through.
 */
export function watchChipDeletion(): () => void {
  if (typeof document === 'undefined') return () => {}
  const inComposer = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement &&
    target.isContentEditable &&
    target.closest('[data-composer-card]') !== null

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (!inComposer(event.target)) return
    const selected = chipsInSelection()
    trace('key:selection', { key: event.key, chips: selected.length })
    if (selected.length > 0) {
      if (!replacesSelection(event.key)) return
      // Synchronous, and without preventDefault: the host removes the text in
      // its own pass, we take the chips out here. (An update issued from a
      // later task gets swallowed by the host's pending edit, and an
      // execCommand delete in between is ignored — between the two, clearing
      // the composer used to need one press per kind of content.)
      removeChipsByRef(selected)
      return
    }
    if (event.key !== 'Backspace' && event.key !== 'Delete') return
    // The plugin's own U+200B caret fillers are invisible: a Backspace that
    // only eats one looks like a dead key. Sweep them first — synchronously,
    // inside the gesture, so the host's delete then hits a real character.
    tidyFillers()
    if (!deleteAdjacentChip(event.key === 'Backspace')) return
    event.preventDefault()
    event.stopPropagation()
  }

  // IME input and programmatic `insertText` replace a selection without a
  // printable keydown, so the same sweep runs on `beforeinput` — the last
  // moment the DOM still shows what is about to be replaced.
  const onBeforeInput = (event: Event): void => {
    const input = event as InputEvent
    if (typeof input.inputType !== 'string') return
    if (!replacesSelectionWithInput(input.inputType)) return
    if (!inComposer(event.target)) return
    const selected = chipsInSelection()
    if (selected.length === 0) return
    trace('input:selection', { inputType: input.inputType, chips: selected.length })
    removeChipsByRef(selected)
  }

  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('beforeinput', onBeforeInput, true)
  return () => {
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('beforeinput', onBeforeInput, true)
  }
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
