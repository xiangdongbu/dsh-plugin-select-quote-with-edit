import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
} from 'react'
import { composerCardOf, isSubmitKey, willSubmit } from './dom.ts'
import { QuoteChip } from './chip.tsx'
import {
  chipOrder,
  chipPresent,
  hasRestoreMarks,
  inlineChipsSupported,
  insertQuoteChip,
  materializeQuoteMarks,
  onChipPresence,
  resetInlineChips,
  setActiveChip,
  takeQueuedQuoteRestore,
} from './inline-chips.ts'
import { t } from './i18n.ts'
import { openDetail } from './detail.tsx'
import { clearSourceMark, getSourceMark, locateQuote } from './locate.ts'
import { useSourceMark } from './source-mark.tsx'
import {
  clearQuotes,
  bindSession,
  getQuotes,
  removeQuote,
  replaceQuotes,
  subscribe,
} from './store.ts'
import {
  composeMessage,
  DRAFT_MARKER,
  QUOTES_OPEN,
  QUOTE_MARK,
  readComposedDraft,
  spotMapOf,
  stripDraftMarker,
  withDraftMarker,
  withQuoteMarks,
  type Quote,
} from './protocol.ts'
import { runtime } from './runtime.ts'
import { ensureStyles } from './styles.ts'

export interface ComposerPanelProps {
  useInput?: <T>(selector: (state: { draft: string; draftRev: number }) => T) => T
  inputActions?: {
    setDraft(text: string): void
  }
  sessionId?: string
  [key: string]: unknown
}

type UseInput = NonNullable<ComposerPanelProps['useInput']>

/**
 * True while an IME composition is in flight. Anything that writes the draft
 * must check this: replacing editor content mid-composition drops the
 * composing text.
 */
function useComposing(): MutableRefObject<boolean> {
  const composing = useRef(false)
  useEffect(() => {
    const onStart = (): void => {
      composing.current = true
    }
    const onEnd = (): void => {
      composing.current = false
    }
    document.addEventListener('compositionstart', onStart, true)
    document.addEventListener('compositionend', onEnd, true)
    return () => {
      document.removeEventListener('compositionstart', onStart, true)
      document.removeEventListener('compositionend', onEnd, true)
    }
  }, [])
  return composing
}

/**
 * 输入框内的待发引用 chip 行（`conversation.input.overlay`）。
 *
 * Quotes never enter the editor as text: the chips are the only affordance,
 * and the protocol block is folded into the draft one capture-phase step
 * before the composer's own send handler reads it. An invisible U+200B marker
 * keeps the send button usable while only quotes are pending.
 */
export function ComposerPanel(props: ComposerPanelProps): React.ReactNode {
  ensureStyles()
  const { useInput, inputActions, sessionId } = props
  const draft = useInput ? useInput((state) => state.draft) : ''
  const [items, setItems] = useState<readonly Quote[]>([])
  const located = useSourceMark()
  const stackRef = useRef<HTMLDivElement | null>(null)
  const draftRef = useRef(draft)
  const actionsRef = useRef(inputActions)
  const foldingRef = useRef(false)
  const composing = useComposing()
  // Inline chips are the goal; the row above the editor stays as the fallback
  // for hosts that do not register the reference-chip node.
  const [mode, setMode] = useState<'inline' | 'row'>('inline')
  const [tick, setTick] = useState(0)
  const presentRef = useRef<ReadonlySet<string>>(new Set<string>())
  const seenRef = useRef<Set<string>>(new Set<string>())
  const attemptsRef = useRef(0)
  /**
   * Quote ids whose chips are waiting behind QUOTE_MARK characters in a freshly
   * written draft (withdraw refill / composed paste). Non-null means: do not run
   * the ordinary insertion — the marks are about to become the chips.
   */
  const restoreRef = useRef<string[] | null>(null)
  draftRef.current = draft
  actionsRef.current = inputActions

  const setDraftSafe = useCallback((text: string) => {
    actionsRef.current?.setDraft(text)
  }, [])

  const sync = useCallback(() => {
    setItems(getQuotes())
  }, [])

  useEffect(() => {
    bindSession(sessionId)
  }, [sessionId])

  // Expose the fold guard to the editor: its write-back composes the same
  // protocol block the rewind-restore path looks for, so it must mark the
  // fold before the draft lands (see chrome.ts sendEdit).
  useEffect(() => {
    if (!inputActions) return
    // Debug affordance (probes set __dsqeDebug): expose the host's composer
    // actions so headless tests can drive setDraft / addAttachments directly.
    if ((globalThis as { __dsqeDebug?: boolean }).__dsqeDebug === true) {
      ;(globalThis as { __dsqeInputActions?: unknown }).__dsqeInputActions = inputActions
    }
    runtime.markFolded = (): void => {
      foldingRef.current = true
    }
    return () => {
      if (runtime.markFolded !== null) runtime.markFolded = null
    }
  }, [inputActions])

  useEffect(() => {
    sync()
    return subscribe(sync)
  }, [sync, sessionId])

  // The editor publishes which quote ids currently own a chip. A chip deleted
  // with Backspace / Delete simply stops appearing here — that is how removal
  // reaches the store, so a chip and its pending quote never drift apart.
  // The drop is deferred: a presence set can be one editor state behind (an
  // editor swap, a mid-commit read), and removing on that stutter would eat a
  // quote whose chip is still on screen.
  useEffect(() => {
    const timers = new Map<string, number>()
    const cancel = (id: string): void => {
      const timer = timers.get(id)
      if (timer === undefined) return
      window.clearTimeout(timer)
      timers.delete(id)
    }
    const off = onChipPresence((next) => {
      presentRef.current = next
      for (const quote of getQuotes()) {
        if (next.has(quote.id)) {
          cancel(quote.id)
          continue
        }
        if (!seenRef.current.has(quote.id) || timers.has(quote.id)) continue
        timers.set(
          quote.id,
          window.setTimeout(() => {
            timers.delete(quote.id)
            if (chipPresent(quote.id)) return
            removeQuote(quote.id)
          }, 220),
        )
      }
      for (const id of next) seenRef.current.add(id)
    })
    return () => {
      off()
      for (const timer of timers.values()) window.clearTimeout(timer)
      timers.clear()
    }
  }, [])

  // Session switch rebuilds the editor: neither the chip set nor the
  // "already seen" bookkeeping survives it.
  useEffect(() => {
    resetInlineChips()
    presentRef.current = new Set<string>()
    seenRef.current = new Set<string>()
    attemptsRef.current = 0
    restoreRef.current = null
  }, [sessionId])

  // Keep the editor in step with the store: every pending quote owns exactly
  // one chip, minted at the caret when it arrives.
  useEffect(() => {
    if (mode !== 'inline') return
    // A paste already wrote marked text into the editor: swap the marks for
    // chips instead of appending a second chip per pending quote.
    const queued = takeQueuedQuoteRestore()
    if (queued !== null) {
      materializeQuoteMarks(queued)
      return
    }
    // A restore is in flight: its marks become the chips, in their own passes.
    if (restoreRef.current !== null || hasRestoreMarks()) return
    const dbg = (globalThis as { __dsqeDebug?: boolean }).__dsqeDebug === true
    if (dbg) {
      console.log('[dsqe] effect', {
        items: items.map((quote) => quote.id),
        present: [...presentRef.current],
        attempts: attemptsRef.current,
      })
    }
    for (const quote of items) {
      if (presentRef.current.has(quote.id)) continue
      if (!inlineChipsSupported()) {
        attemptsRef.current += 1
        if (dbg) console.log('[dsqe] unsupported', attemptsRef.current)
        if (attemptsRef.current > 25) setMode('row')
        return
      }
      if (!insertQuoteChip(quote)) {
        if (dbg) console.log('[dsqe] insert failed -> row')
        setMode('row')
        return
      }
      seenRef.current.add(quote.id)
    }
  }, [items, draft, mode, sessionId, tick])

  // The composer can mount a beat after this overlay; poll briefly while a
  // quote still has no chip rather than falling back to the row too early.
  useEffect(() => {
    if (mode !== 'inline' || items.length === 0) return
    if (items.every((quote) => presentRef.current.has(quote.id))) return
    const timer = setTimeout(() => setTick((value) => value + 1), 400)
    return () => clearTimeout(timer)
  }, [mode, items, tick, draft])

  // Ring the chip whose source text is underlined in the transcript.
  useEffect(() => {
    setActiveChip(located?.quoteId ?? null)
  }, [located])

  // A quote that left the composer (sent, or deleted) must not keep the
  // transcript underlined — the chip that owns the mark is gone.
  useEffect(() => {
    const located = getSourceMark()
    if (located?.quoteId === undefined) return
    if (!items.some((quote) => quote.id === located.quoteId)) clearSourceMark()
  }, [items])

  // Reserve draft height under the absolute chip row (row mode only — inline
  // chips sit in the text and need no reservation).
  useEffect(() => {
    if (mode !== 'row') return
    const element = stackRef.current
    if (!element) return
    const card = composerCardOf(element)
    if (!card) return
    const apply = (): void => {
      card.style.setProperty('--dsqe-pad', `${element.offsetHeight + 16}px`)
    }
    card.classList.add('dsqe_pad')
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(element)
    return () => {
      observer.disconnect()
      card.classList.remove('dsqe_pad')
      card.style.removeProperty('--dsqe-pad')
    }
  }, [items, sessionId, mode])

  // Keep the invisible marker in step with the quote list, once per list /
  // draft change. Never write while an IME composition is in flight.
  //
  // Inline mode never writes: a chip is real content, so the send button is
  // already live — and the host's `setDraft` rebuilds the paragraphs from text,
  // which would wipe every chip. The marker exists for the row fallback only.
  useEffect(() => {
    if (mode !== 'row') return
    if (composing.current) return
    if (items.length === 0) {
      if (draft.includes(DRAFT_MARKER)) setDraftSafe(stripDraftMarker(draft))
      return
    }
    if (!draft.includes(DRAFT_MARKER) && draft.trim() === '') {
      setDraftSafe(withDraftMarker(draft))
    }
  }, [items, draft, mode, setDraftSafe])

  // Fold pending quotes into the draft at the send gesture (Enter in the
  // composer, or the primary send button — the last button of the card that
  // does not render the stop square). Capture phase: the composer's own
  // handler reads the folded draft afterwards.
  useEffect(() => {
    if (items.length === 0 || !actionsRef.current) return

    const inject = (): void => {
      const current = getQuotes()
      if (current.length === 0) return
      foldingRef.current = true
      // Record where each chip sat so the sent message (and a later withdraw)
      // keeps the user's order instead of stacking every chip up front.
      const order = chipOrder()
      const spots = spotMapOf(draftRef.current, order) ?? undefined
      if ((globalThis as { __dsqeDebug?: boolean }).__dsqeDebug === true) {
        console.log('[dsqe] fold', {
          draft: JSON.stringify(draftRef.current),
          order,
          spots: spots === undefined ? null : [...spots],
        })
      }
      actionsRef.current?.setDraft(composeMessage(draftRef.current, current, spots))
      clearQuotes()
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isSubmitKey(event)) return
      const target = event.target
      if (!(target instanceof HTMLElement) || !target.isContentEditable) return
      const card = composerCardOf(target)
      if (!card || !willSubmit(card, draftRef.current)) return
      inject()
    }

    const onClick = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      const card = composerCardOf(target)
      if (!card) return
      const button = target.closest('button')
      if (!button || (button as HTMLButtonElement).disabled) return
      const buttons = card.querySelectorAll('button')
      if (buttons.length === 0 || buttons[buttons.length - 1] !== button) return
      if (button.querySelector('svg rect') !== null) return
      inject()
    }

    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('click', onClick, true)
    }
  }, [items.length, setDraftSafe])

  // A rewind/withdraw refills a withdrawn message verbatim, protocol block
  // included. Unfold it here: quotes back into the chips, the user's own
  // words back into the editor — each chip at the offset it was sent from
  // (`at`), which is what keeps the order the user typed.
  useLayoutEffect(() => {
    if (!draft.includes(QUOTES_OPEN)) {
      foldingRef.current = false
      return
    }
    if (foldingRef.current || composing.current) return
    const restored = readComposedDraft(draft)
    if (restored === null) return
    foldingRef.current = true
    replaceQuotes(restored.quotes)
    // Stable sort: two chips at the same offset keep their payload order.
    const placed = [...restored.quotes]
      .filter((quote) => typeof quote.at === 'number')
      .sort((left, right) => (left.at ?? 0) - (right.at ?? 0))
    if (placed.length > 0) {
      const ats = placed.map((quote) => quote.at ?? 0)
      restoreRef.current = placed.map((quote) => quote.id)
      setDraftSafe(withQuoteMarks(restored.rest, ats))
      return
    }
    setDraftSafe(restored.rest)
  }, [draft, sessionId, setDraftSafe])

  // The marked draft is the intermediate step: as soon as it lands, swap each
  // mark for the chip of the matching quote. Until then the ordinary insert
  // path stays out of the way (it would append duplicates behind the marks).
  useLayoutEffect(() => {
    const pending = restoreRef.current
    if (pending === null) return
    if (!draft.includes(QUOTE_MARK) && !hasRestoreMarks()) {
      // The mark never made it into the draft (host sanitized it): give up on
      // positions and let the normal insertion place the chips.
      if (draft.length > 0) restoreRef.current = null
      return
    }
    restoreRef.current = null
    materializeQuoteMarks(pending)
  }, [draft])

  if (!sessionId || items.length === 0 || mode === 'inline') return null

  return (
    <div ref={stackRef} className="dsqe-chipRow">
      {items.map((quote) => (
        <QuoteChip
          key={quote.id}
          quote={quote}
          active={located?.quoteId === quote.id}
          hint={quote.long ? t('chip.openDetail') : t('chip.locate')}
          onOpen={() => {
            // A pasted long body has no source in the transcript — it opens
            // the detail pane instead. A selection quote scrolls back to its
            // original position and underlines it there.
            if (quote.long) {
              openDetail(quote.text, true)
              return
            }
            locateQuote(quote.text, quote.id)
          }}
          onRemove={() => removeQuote(quote.id)}
        />
      ))}
    </div>
  )
}