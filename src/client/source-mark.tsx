import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from './i18n.ts'
import { ensureStyles } from './styles.ts'
import {
  clearSourceMark,
  getMissingToken,
  getSourceMark,
  linesOf,
  subscribeMissing,
  subscribeSourceMark,
  type SourceLine,
  type SourceMark,
} from './locate.ts'

/** Subscribe to the located-source mark (null when nothing is marked). */
export function useSourceMark(): SourceMark | null {
  const [state, setState] = useState<SourceMark | null>(getSourceMark())
  useEffect(() => {
    const sync = (): void => setState(getSourceMark())
    sync()
    return subscribeSourceMark(sync)
  }, [])
  return state
}

/** Bumped once per failed lookup; the toast keys off it. */
function useMissingToken(): number {
  const [state, setState] = useState(getMissingToken)
  useEffect(() => {
    const sync = (): void => setState(getMissingToken())
    sync()
    return subscribeMissing(sync)
  }, [])
  return state
}

function sameLines(a: readonly SourceLine[], b: readonly SourceLine[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (
      Math.abs(left.left - right.left) > 0.5 ||
      Math.abs(left.top - right.top) > 0.5 ||
      Math.abs(left.width - right.width) > 0.5 ||
      Math.abs(left.height - right.height) > 0.5
    ) {
      return false
    }
  }
  return true
}

/**
 * 「定位原文」的下划线层（`shell.overlay`）。
 *
 * The mark is a live `Range` inside someone else's React tree, so the plugin
 * never touches that DOM: it paints one fixed-position line per client rect on
 * top of `document.body` instead. Rects are re-read while the smooth scroll
 * settles (short rAF window) and on every scroll/resize afterwards — the
 * underline follows the text, and disappears the moment the range is detached
 * (message collapsed, session switched, row virtualized away).
 */
export function SourceMarkOverlay(): React.ReactNode {
  ensureStyles()
  const mark = useSourceMark()
  const missingToken = useMissingToken()
  const [lines, setLines] = useState<readonly SourceLine[]>([])
  const [toast, setToast] = useState(false)

  useEffect(() => {
    if (mark === null) {
      setLines([])
      return
    }
    let frame = 0
    const settleUntil = Date.now() + 900
    const read = (): void => {
      if (!mark.range.startContainer.isConnected) {
        clearSourceMark()
        return
      }
      const next = linesOf(mark)
      setLines((previous) => (sameLines(previous, next) ? previous : next))
    }
    const tick = (): void => {
      read()
      if (Date.now() < settleUntil) frame = window.requestAnimationFrame(tick)
    }
    tick()
    const onReflow = (): void => read()
    document.addEventListener('scroll', onReflow, true)
    window.addEventListener('resize', onReflow)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('scroll', onReflow, true)
      window.removeEventListener('resize', onReflow)
    }
  }, [mark])

  // Esc or a click anywhere outside the chips / the underline itself dismisses
  // the mark. Clicks on a chip are left alone: the chip's own handler toggles.
  useEffect(() => {
    if (mark === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      clearSourceMark()
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) {
        clearSourceMark()
        return
      }
      if (target.closest('.dsqe-chip, .dsqe-srcMark, .dsqe-srcToast') !== null) return
      clearSourceMark()
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [mark])

  useEffect(() => {
    if (missingToken === 0) return
    setToast(true)
    const timer = window.setTimeout(() => setToast(false), 2600)
    return () => window.clearTimeout(timer)
  }, [missingToken])

  return createPortal(
    <>
      {lines.map((line, index) => (
        <span
          key={`${mark?.token ?? 0}-${index}`}
          className="dsqe-srcMark"
          style={{
            left: line.left,
            top: line.top,
            width: line.width,
            height: line.height,
          }}
        />
      ))}
      {toast ? (
        <div className="dsqe-srcToast" role="status">
          {t('locate.missing')}
        </div>
      ) : null}
    </>,
    document.body,
  )
}
