import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from './i18n.ts'
import { CheckIcon, CopyIcon, QuoteIcon } from './icons.tsx'
import { addQuote } from './store.ts'
import {
  copyText,
  focusComposer,
  readSelectionSnapshot,
  sameRect,
  type SelectionSnapshot,
} from './dom.ts'
import { ensureStyles } from './styles.ts'

interface ToolbarState {
  readonly text: string
  readonly firstRect: DOMRect
  readonly lastRect: DOMRect
}

/**
 * 划词工具条（`shell.overlay`）。
 *
 * The toolbar follows the selection: it appears after a drag/keyboard
 * selection inside the transcript, tracks scroll/resize via re-reading the
 * live selection, and collapses as soon as the selection is gone. Both
 * buttons keep the selection alive across the click (`pointerdown` is
 * prevented); 「复制」 flips its label to 「已复制」 for a moment, 「添加到对话」
 * stores the quote, clears the selection and focuses the composer.
 */
export function SelectionToolbar(): React.ReactNode {
  ensureStyles()
  const [state, setState] = useState<ToolbarState | null>(null)
  const [copied, setCopied] = useState(false)
  const stateRef = useRef<ToolbarState | null>(null)
  const copiedTimer = useRef<number | null>(null)
  stateRef.current = state

  const refresh = useCallback((): void => {
    const snapshot: SelectionSnapshot | null = readSelectionSnapshot()
    if (!snapshot) {
      setState(null)
      return
    }
    const current = stateRef.current
    if (
      current &&
      current.text === snapshot.text &&
      sameRect(current.firstRect, snapshot.firstRect) &&
      sameRect(current.lastRect, snapshot.lastRect)
    ) {
      return
    }
    setState({
      text: snapshot.text,
      firstRect: snapshot.firstRect,
      lastRect: snapshot.lastRect,
    })
  }, [])

  useEffect(() => {
    let timer: number | null = null
    const schedule = (): void => {
      // Throttled with a timeout rather than requestAnimationFrame: a hidden
      // or occluded webview can pause rAF indefinitely, which would freeze
      // the toolbar until the next visible frame.
      if (timer !== null) return
      timer = window.setTimeout(() => {
        timer = null
        refresh()
      }, 30)
    }
    const onBlur = (): void => setState(null)
    document.addEventListener('pointerup', schedule, true)
    document.addEventListener('keyup', schedule, true)
    document.addEventListener('selectionchange', schedule)
    document.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('pointerup', schedule, true)
      document.removeEventListener('keyup', schedule, true)
      document.removeEventListener('selectionchange', schedule)
      document.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('blur', onBlur)
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [refresh])

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
    },
    [],
  )

  const onCopy = useCallback((): void => {
    const text = stateRef.current?.text
    if (!text) return
    void copyText(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => {
        copiedTimer.current = null
        setCopied(false)
      }, 1500)
    })
  }, [])

  const onAdd = useCallback((): void => {
    const text = stateRef.current?.text
    if (!text) return
    addQuote(text)
    window.getSelection()?.removeAllRanges()
    setState(null)
    setCopied(false)
    focusComposer()
  }, [])

  if (!state) return null

  // Center above the first line of the selection; flip below the last line
  // when there is no headroom, and clamp horizontally to the viewport.
  const approxWidth = 200
  let left = state.firstRect.left + state.firstRect.width / 2
  left = Math.min(Math.max(left, approxWidth / 2 + 8), window.innerWidth - approxWidth / 2 - 8)
  const above = state.firstRect.top >= 76
  const top = above ? state.firstRect.top - 8 : state.lastRect.bottom + 8

  return createPortal(
    <div
      className="dsqe-toolbar"
      role="toolbar"
      style={{
        left,
        top,
        transform: above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
      }}
      onPointerDown={(event) => event.preventDefault()}
    >
      <span className="dsqe-toolbarRow">
        <button type="button" className="dsqe-toolbarBtn" onClick={onCopy}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          <span>{copied ? t('toolbar.copied') : t('toolbar.copy')}</span>
        </button>
        <button type="button" className="dsqe-toolbarBtn" onClick={onAdd}>
          <QuoteIcon />
          <span>{t('toolbar.add')}</span>
        </button>
      </span>
    </div>,
    document.body,
  )
}
