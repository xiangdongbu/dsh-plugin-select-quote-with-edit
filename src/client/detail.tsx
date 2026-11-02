/**
 * Right-hand detail drawer for quote / long-text capsules.
 *
 * Clicking a capsule in a sent message bubble opens this panel: the full
 * text, scrollable, slides in from the right edge of the viewport. Plain
 * module-level store — any chip (React or plain-DOM) can open it without
 * prop drilling; the panel itself is a `shell.overlay` slot so it is always
 * mounted, above the hover tips and drawers of the host.
 */

import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from './i18n.ts'
import { ClipIcon, QuoteIcon, XIcon } from './icons.tsx'
import { cx, ensureStyles } from './styles.ts'

export interface DetailTarget {
  readonly text: string
  readonly long: boolean
}

let current: DetailTarget | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Open the drawer with the given capsule body (idempotent for equal text). */
export function openDetail(text: string, long = false): void {
  const next: DetailTarget = { text, long }
  if (current?.text === next.text && current?.long === next.long) return
  current = next
  notify()
}

export function closeDetail(): void {
  if (current === null) return
  current = null
  notify()
}

function useDetail(): DetailTarget | null {
  const [state, setState] = useState<DetailTarget | null>(current)
  useEffect(() => {
    const sync = (): void => setState(current)
    listeners.add(sync)
    return () => {
      listeners.delete(sync)
    }
  }, [])
  return state
}

/**
 * The drawer (`shell.overlay`). Rendered through a body portal so message
 * surfaces with `contain: layout` cannot clip it.
 */
export function QuoteDetailPanel(): React.ReactNode {
  ensureStyles()
  const detail = useDetail()

  useEffect(() => {
    if (!detail) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeDetail()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [detail])

  if (!detail) return null
  const Icon = detail.long ? ClipIcon : QuoteIcon

  return createPortal(
    <aside className="dsqe-drawer" role="dialog" aria-label={t('detail.title')}>
      <header className="dsqe-drawerHead">
        <span className="dsqe-drawerIcon">
          <Icon />
        </span>
        <span className="dsqe-drawerTitle">{detail.long ? t('detail.titleLong') : t('detail.title')}</span>
        <button
          type="button"
          className="dsqe-drawerClose"
          aria-label={t('detail.close')}
          title={t('detail.close')}
          onClick={closeDetail}
        >
          <XIcon />
        </button>
      </header>
      <div className={cx('dsqe-drawerBody', detail.long && 'dsqe-drawerBodyLong')}>{detail.text}</div>
    </aside>,
    document.body,
  )
}
