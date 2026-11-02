import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from './i18n.ts'
import { QuoteIcon, XIcon } from './icons.tsx'
import { cx, ensureStyles } from './styles.ts'

export interface QuoteLike {
  readonly id: string
  readonly text: string
}

interface TipPosition {
  left: number
  top: number
  side: 'above' | 'below'
}

/**
 * One quote chip with an optional delete button and a hover preview.
 *
 * Hovering the chip (or the preview) keeps the preview open; leaving either
 * schedules a short close, so the pointer can cross the 8px bridge. The
 * preview is a `document.body`-level fixed portal: message surfaces with
 * `contain: layout` would otherwise hijack fixed positioning.
 */
export function QuoteChip(props: {
  quote: QuoteLike
  onRemove?: () => void
  small?: boolean
}): React.ReactNode {
  ensureStyles()
  const { quote, onRemove, small } = props
  const [open, setOpen] = useState(false)
  const [tipPos, setTipPos] = useState<TipPosition | null>(null)
  const chipRef = useRef<HTMLSpanElement | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)
  const closeTimer = useRef<number | null>(null)

  const cancelClose = (): void => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  const scheduleClose = (): void => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setOpen(false)
      setTipPos(null)
    }, 140)
  }
  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    },
    [],
  )

  // Place the preview once mounted and keep it glued to the chip while the
  // page scrolls or resizes. Measured while `visibility: hidden`, so there is
  // no first-frame flash at (0, 0).
  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const chip = chipRef.current
      const tip = tipRef.current
      if (!chip || !tip) return
      if (!chip.isConnected) {
        setOpen(false)
        setTipPos(null)
        return
      }
      const rect = chip.getBoundingClientRect()
      const margin = 8
      const width = tip.offsetWidth
      const height = tip.offsetHeight
      const left = Math.min(Math.max(margin, rect.left), window.innerWidth - margin - width)
      // Prefer above; flip below only when there is no headroom (leave room
      // for the app header).
      if (rect.top >= height + 68) {
        setTipPos({ left, top: rect.top - 8 - height, side: 'above' })
      } else {
        setTipPos({ left, top: rect.bottom + 8, side: 'below' })
      }
    }
    place()
    const onReflow = (): void => {
      if (chipRef.current?.isConnected) place()
    }
    window.addEventListener('resize', onReflow)
    document.addEventListener('scroll', onReflow, true)
    return () => {
      window.removeEventListener('resize', onReflow)
      document.removeEventListener('scroll', onReflow, true)
    }
  }, [open, quote.text])

  return (
    <span
      className="dsqe-chipCluster"
      onMouseEnter={() => {
        cancelClose()
        setOpen(true)
      }}
      onMouseLeave={scheduleClose}
    >
      <span
        ref={chipRef}
        className={cx('dsqe-chip', small && 'dsqe-chipSm')}
        data-x-shown={open && onRemove ? 'true' : undefined}
      >
        {onRemove ? (
          <button
            type="button"
            className="dsqe-chipDelIcon"
            aria-label={t('chip.remove')}
            title={t('chip.remove')}
            onPointerDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation()
              onRemove()
            }}
          >
            <XIcon />
          </button>
        ) : null}
        <span className="dsqe-chipIcon">
          <QuoteIcon />
        </span>
        <span className="dsqe-chipText">{quote.text}</span>
      </span>
      {open
        ? createPortal(
            <div
              ref={tipRef}
              className="dsqe-tipWrap"
              data-side={tipPos?.side ?? 'above'}
              style={{
                left: tipPos?.left ?? 0,
                top: tipPos?.top ?? 0,
                // Hidden until the layout effect has measured and placed the
                // panel — no first-frame flash at (0, 0).
                visibility: tipPos ? 'visible' : 'hidden',
              }}
              onMouseEnter={cancelClose}
              onMouseLeave={scheduleClose}
            >
              <div className="dsqe-tipIn">
                <div className="dsqe-tip">
                  <QuoteIcon />
                  <span>{quote.text}</span>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </span>
  )
}
