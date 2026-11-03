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
import { composeMessage, DRAFT_MARKER, QUOTES_OPEN, readComposedDraft, stripDraftMarker, withDraftMarker, type Quote } from './protocol.ts'
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

  // A quote that left the composer (sent, or deleted) must not keep the
  // transcript underlined — the chip that owns the mark is gone.
  useEffect(() => {
    const located = getSourceMark()
    if (located?.quoteId === undefined) return
    if (!items.some((quote) => quote.id === located.quoteId)) clearSourceMark()
  }, [items])

  // Reserve draft height under the absolute chip row.
  useEffect(() => {
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
  }, [items, sessionId])

  // Keep the invisible marker in step with the quote list, once per list /
  // draft change. Never write while an IME composition is in flight.
  useEffect(() => {
    if (composing.current) return
    if (items.length === 0) {
      if (draft.includes(DRAFT_MARKER)) setDraftSafe(stripDraftMarker(draft))
      return
    }
    if (!draft.includes(DRAFT_MARKER) && draft.trim() === '') {
      setDraftSafe(withDraftMarker(draft))
    }
  }, [items, draft, setDraftSafe])

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
      actionsRef.current?.setDraft(composeMessage(draftRef.current, current))
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
  // words back into the editor. Runs only when a COMPLETE block is present,
  // and never for the block this plugin just folded at the send gesture.
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
    setDraftSafe(restored.rest)
  }, [draft, sessionId, setDraftSafe])

  if (!sessionId || items.length === 0) return null

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