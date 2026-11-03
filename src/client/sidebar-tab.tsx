/**
 * Native right-sidebar integration for the capsule detail — modelled on
 * `dsh-file-review`'s review pane, which is the reference for what a native
 * sidebar tab looks like:
 *
 *   header  ─ icon tile · title · meta pills · · · · toolbar (copy / wrap)
 *   body    ─ recessed canvas
 *             └ card ─ sticky header (chevron · name · stats)
 *                      └ numbered code lines with a sticky gutter
 *
 * The tab itself is a real `sidebarRightTabs` entry opened per session via
 * `sidebarRight.openTabIn`, so the host draws the tab strip and the close /
 * split controls; nothing here imitates those.
 *
 * `sidebarRight` / `sidebarRightTabs` are declared in the plugin's `inject`
 * list (same as dsh-file-review) so the host passes them into the client
 * context. They are still resolved loosely (duck typing — the bundle must not
 * require host packages). When they are unavailable (mock harness, Minimal
 * profile) the installer returns null and the caller keeps the local drawer.
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

/** Plain text as lines (the same numbered body the JSON view uses). */
function textLines(text: string): Token[][] {
  return text.split('\n').map((line) => [{ text: line, cls: '' }])
}

function count(value: number): string {
  return value.toLocaleString()
}

// ---------------------------------------------------------------- tab body

/** Chevron that turns with the card's collapsed state (file-review's header). */
function ChevronIcon(): React.ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M4 6.5 8 10.5 12 6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * The tab body, dressed exactly like the host's file review pane: a header
 * strip with the title/meta and a small toolbar, then a card whose sticky
 * header names the content and whose body is a numbered, monospace listing.
 */
function DetailBody({ text, long }: { text: string; long: boolean }): React.ReactNode {
  ensureStyles()
  const json = looksLikeJson(text)
  const lines = json ? tokenizeJson(displayJson(text)) : textLines(text)
  const [copied, setCopied] = useState(false)
  // Wrapping is the readable default for prose; code-like JSON keeps its
  // indentation and scrolls sideways, as in the review pane.
  const [wrap, setWrap] = useState(!json)
  const [collapsed, setCollapsed] = useState(false)

  const onCopy = (): void => {
    void copyText(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  const title = long ? t('detail.titleLong') : t('detail.title')
  const name = json ? t('detail.nameJson') : t('detail.nameText')

  return (
    <div className="dsqe-pane">
      <header className="dsqe-paneHead">
        <div className="dsqe-paneHeading">
          <span className="dsqe-paneTile">{long ? <ClipIcon /> : <QuoteIcon />}</span>
          <span className="dsqe-paneTitle">{title}</span>
          <span className="dsqe-panePill">
            {t('detail.lines').replace('{count}', count(lines.length))}
          </span>
          <span className="dsqe-panePill">
            {t('detail.chars').replace('{count}', count(text.length))}
          </span>
        </div>
        <div className="dsqe-paneTools">
          <button
            type="button"
            className="dsqe-toolBtn"
            onClick={onCopy}
            title={copied ? t('detail.copied') : t('detail.copy')}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            <span>{copied ? t('detail.copied') : t('detail.copy')}</span>
          </button>
          <button
            type="button"
            className="dsqe-toolBtn"
            data-on={wrap ? 'true' : 'false'}
            aria-pressed={wrap}
            onClick={() => setWrap((value) => !value)}
            title={wrap ? t('detail.wrapOn') : t('detail.wrapOff')}
          >
            <span>{wrap ? t('detail.wrapOn') : t('detail.wrapOff')}</span>
          </button>
        </div>
      </header>
      <div className="dsqe-paneBody">
        <section className="dsqe-fileCard" data-collapsed={collapsed ? 'true' : 'false'}>
          <header className="dsqe-fileHead">
            <button
              type="button"
              className="dsqe-fileChev"
              data-open={collapsed ? 'false' : 'true'}
              aria-expanded={!collapsed}
              aria-label={collapsed ? t('detail.expand') : t('detail.collapse')}
              title={collapsed ? t('detail.expand') : t('detail.collapse')}
              onClick={() => setCollapsed((value) => !value)}
            >
              <ChevronIcon />
            </button>
            <span className="dsqe-fileIcon">{json ? <ClipIcon /> : <QuoteIcon />}</span>
            <span className="dsqe-fileName">{name}</span>
            {collapsed ? null : (
              <>
                <span className="dsqe-fileMeta">
                  {t('detail.lines').replace('{count}', count(lines.length))}
                </span>
                <span className="dsqe-fileSpacer" />
                <span className="dsqe-fileMeta">
                  {t('detail.chars').replace('{count}', count(text.length))}
                </span>
              </>
            )}
          </header>
          {collapsed ? null : (
            <div className="dsqe-code" data-wrap={wrap ? 'true' : 'false'} role="code">
              {lines.map((tokens, index) => (
                <div className="dsqe-codeLine" key={index}>
                  <span className="dsqe-codeNo">{index + 1}</span>
                  <span className="dsqe-codeText">
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
          )}
        </section>
      </div>
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
  return <>{t('detail.tab')}</>
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
      title: () => t('detail.tab'),
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
