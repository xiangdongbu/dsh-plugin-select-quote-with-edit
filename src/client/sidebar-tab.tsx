/**
 * Native right-sidebar integration for the capsule detail (dsh-file-review
 * style): a dedicated `sidebarRightTabs` tab + `sidebar.right.pane.tab` slot,
 * opened per session via `sidebarRight.openTabIn`. JSON capsule bodies are
 * detected and rendered with line numbers + token colors; everything else is
 * pre-wrap text.
 *
 * The `sidebarRight` / `sidebarRightTabs` services are declared in the
 * plugin's `inject` list (same as dsh-file-review) so the host passes them
 * into the client context. They are still resolved loosely here (duck
 * typing — the bundle must not require host packages). When they are
 * unavailable (mock harness, Minimal profile) the installer returns null and
 * the caller keeps the local fixed drawer as fallback.
 */

import React, { useState } from 'react'
import { t } from './i18n.ts'
import { CheckIcon, ClipIcon, CopyIcon, QuoteIcon } from './icons.tsx'
import { copyText } from './dom.ts'
import { ensureStyles } from './styles.ts'
import { runtime } from './runtime.ts'

const DETAIL_TAB_ID = 'select-quote-with-edit:detail'

export interface DetailParams {
  readonly text: string
  readonly long?: boolean
}

interface TabInfoLike {
  readonly tab?: {
    readonly visible?: boolean
    readonly navigation?: { readonly params?: DetailParams }
  }
}

type UseTabInfo = () => TabInfoLike

// ---------------------------------------------------------------- JSON view

interface Token {
  readonly text: string
  readonly cls: string
}

const JSON_TOKEN_RE =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])/g

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false
  if (trimmed.length > 2_000_000) return false
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return parsed !== null && typeof parsed === 'object'
  } catch {
    return false
  }
}

/** Tokenize JSON source into per-line token runs for the line-numbered view. */
function tokenizeJson(src: string): Token[][] {
  const tokens: Token[] = []
  let last = 0
  for (const match of src.matchAll(JSON_TOKEN_RE)) {
    const start = match.index
    if (start > last) tokens.push({ text: src.slice(last, start), cls: '' })
    if (match[2] !== undefined) {
      // A key: the string plus its colon.
      tokens.push({ text: match[1], cls: 'dsqe-jsonKey' })
      tokens.push({ text: match[2], cls: '' })
    } else if (match[1] !== undefined) {
      tokens.push({ text: match[1], cls: 'dsqe-jsonStr' })
    } else if (match[3] !== undefined) {
      tokens.push({ text: match[3], cls: 'dsqe-jsonLit' })
    } else if (match[4] !== undefined) {
      tokens.push({ text: match[4], cls: 'dsqe-jsonNum' })
    } else {
      tokens.push({ text: match[5] ?? '', cls: '' })
    }
    last = start + match[0].length
  }
  if (last < src.length) tokens.push({ text: src.slice(last), cls: '' })

  // Distribute tokens across lines (tokens themselves never span lines: JSON
  // strings cannot contain raw newlines).
  const lines: Token[][] = [[]]
  for (const token of tokens) {
    const parts = token.text.split('\n')
    parts.forEach((part, index) => {
      if (index > 0) lines.push([])
      if (part.length > 0) lines[lines.length - 1]!.push({ text: part, cls: token.cls })
    })
  }
  return lines
}

/** Pretty-print compact JSON so the tab matches the native file view. */
function displayJson(text: string): string {
  const trimmed = text.trim()
  if (trimmed.includes('\n')) return trimmed
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return trimmed
  }
}

function JsonBody({ text }: { text: string }): React.ReactNode {
  const lines = tokenizeJson(displayJson(text))
  return (
    <div className="dsqe-sideBody dsqe-sideJson" role="code">
      {lines.map((tokens, index) => (
        <div className="dsqe-jsonLine" key={index}>
          <span className="dsqe-jsonLineNo">{index + 1}</span>
          <span className="dsqe-jsonCode">
            {tokens.map((token, tokenIndex) =>
              token.cls ? (
                <span key={tokenIndex} className={token.cls}>
                  {token.text}
                </span>
              ) : (
                <span key={tokenIndex}>{token.text}</span>
              ),
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- tab body

function DetailBody({ text, long }: { text: string; long: boolean }): React.ReactNode {
  ensureStyles()
  const [copied, setCopied] = useState(false)
  const Icon = long ? ClipIcon : QuoteIcon
  const onCopy = (): void => {
    void copyText(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="dsqe-sideWrap">
      <header className="dsqe-drawerHead">
        <span className="dsqe-drawerIcon">
          <Icon />
        </span>
        <span className="dsqe-drawerTitle">
          {long ? t('detail.titleLong') : t('detail.title')}
        </span>
        <button
          type="button"
          className="dsqe-drawerClose"
          aria-label={copied ? t('detail.copied') : t('detail.copy')}
          title={copied ? t('detail.copied') : t('detail.copy')}
          onClick={onCopy}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </header>
      {looksLikeJson(text) ? <JsonBody text={text} /> : <div className="dsqe-sideBody">{text}</div>}
    </div>
  )
}

/** Empty-state when the tab is open without params (fresh sidebar reset). */
function DetailTabBody(props: Record<string, unknown>): React.ReactNode {
  ensureStyles()
  const useTabInfo = props.useTabInfo as UseTabInfo | undefined
  // A hook: must run on every render, before any conditional return.
  const tabInfo = useTabInfo ? useTabInfo() : null
  const params = tabInfo?.tab?.navigation?.params
  if (!params || typeof params.text !== 'string' || params.text.length === 0) {
    return <div className="dsqe-sideEmpty">{t('detail.empty')}</div>
  }
  return <DetailBody text={params.text} long={params.long === true} />
}

function DetailTabTitle(): React.ReactNode {
  return <>{t('detail.title')}</>
}

// ---------------------------------------------------------------- installer

function resolveService(ctx: unknown, name: string): unknown {
  const record = ctx as Record<string, unknown>
  const direct = record[name]
  if (direct !== undefined) return direct
  try {
    return typeof record.get === 'function' ? (record.get as (n: string) => unknown)(name) : undefined
  } catch {
    return undefined
  }
}

/**
 * Register the native sidebar tab and return the opener
 * `(text, long) => boolean`. Returns null when the sidebar services are not
 * reachable yet — `index.tsx` retries a few times before degrading to the
 * local drawer.
 */
export function installSidebarDetail(ctx: unknown): ((text: string, long: boolean) => boolean) | null {
  try {
    const tabs = resolveService(ctx, 'sidebarRightTabs') as
      | { register?: (def: unknown) => unknown }
      | undefined
    const right = resolveService(ctx, 'sidebarRight') as
      | { openTabIn?: (sessionId: string, tabId: string, options: unknown) => unknown }
      | undefined
    const slots = resolveService(ctx, 'slots') as
      | {
          inject?: (name: string, register: () => void) => void
          register?: (def: Record<string, unknown>, component: unknown) => void
        }
      | undefined
    if (
      typeof tabs?.register !== 'function' ||
      typeof right?.openTabIn !== 'function' ||
      typeof slots?.inject !== 'function' ||
      typeof slots?.register !== 'function'
    ) {
      return null
    }

    tabs.register({
      id: DETAIL_TAB_ID,
      kind: DETAIL_TAB_ID,
      title: () => t('detail.title'),
    })
    slots.inject('sidebar.right.pane.tab', () => {
      slots.register!({ name: 'sidebar.right.pane.tab', key: DETAIL_TAB_ID }, DetailTabBody)
    })
    slots.inject('sidebar.right.pane.tab.title', () => {
      slots.register!({ name: 'sidebar.right.pane.tab.title', key: DETAIL_TAB_ID }, DetailTabTitle)
    })

    return (text: string, long: boolean): boolean => {
      const sessionId = runtime.sessionId
      if (sessionId === null) return false
      try {
        const params: DetailParams = { text, ...(long ? { long: true } : {}) }
        right.openTabIn!(sessionId, DETAIL_TAB_ID, { params })
        return true
      } catch {
        return false
      }
    }
  } catch {
    return null
  }
}
