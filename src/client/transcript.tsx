import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { scanQuotes, type ParsedQuote } from './protocol.ts'
import { QuoteChip, type QuoteLike } from './chip.tsx'
import { openDetail } from './detail.tsx'
import { locateQuote } from './locate.ts'
import { pickDelegate } from './host-node.ts'
import { registerMessage, type ImageRef } from './registry.ts'
import { ensureHostButtons } from './chrome.ts'
import type { UserMessageProps } from './context.d.ts'
import { ensureStyles } from './styles.ts'
import { t } from './i18n.ts'

function isTextBlock(block: unknown): boolean {
  if (block === null || typeof block !== 'object') return false
  const candidate = block as { type?: unknown; attachment?: unknown; text?: unknown }
  if (
    (candidate.type === 'image' || candidate.type === 'file') &&
    candidate.attachment !== undefined
  ) {
    return false
  }
  return candidate.type === 'text' || typeof candidate.text === 'string'
}

function contentBlocksToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(isTextBlock)
    .map((block) => String((block as { text?: unknown }).text ?? ''))
    .join('')
}

/** Replace all text blocks with one stripped text block, keeping the rest. */
function strippedContent(raw: unknown, text: string): unknown[] {
  const rest = Array.isArray(raw) ? raw.filter((block) => !isTextBlock(block)) : []
  if (text) rest.unshift({ type: 'text', text })
  return rest
}

function imageAttachments(content: unknown): unknown[] {
  if (!Array.isArray(content)) return []
  const images: unknown[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; attachment?: unknown }
    if (candidate.type === 'image' && candidate.attachment !== undefined) {
      images.push(candidate.attachment)
    }
  }
  return images
}

/** Normalize the message's image attachment blocks for the withdraw refill. */
function toImageRefs(content: unknown): ImageRef[] {
  const refs: ImageRef[] = []
  for (const attachment of imageAttachments(content)) {
    const candidate = attachment as
      | { attachmentId?: unknown; mediaType?: unknown; name?: unknown }
      | undefined
    if (typeof candidate?.attachmentId !== 'string') continue
    if (typeof candidate.mediaType !== 'string') continue
    refs.push({
      attachmentId: candidate.attachmentId,
      mediaType: candidate.mediaType,
      ...(typeof candidate.name === 'string' ? { name: candidate.name } : {}),
    })
  }
  return refs
}

function toChipQuote(quote: ParsedQuote, index: number): QuoteLike {
  return {
    id: `${quote.id}-${index}`,
    text: quote.text,
    ...(quote.long ? { long: true } : {}),
  }
}

/** What a click on one chip does: underline the source, or open the capsule. */
function openChip(quote: ParsedQuote, index: number): void {
  if (quote.long === true) {
    openDetail(quote.text, true)
    return
  }
  locateQuote(quote.text, `${quote.id}-${index}`)
}

/**
 * One attachment thumbnail. The host's `loadImage` resolves asynchronously
 * (it returns a promise for the blob/object URL — assigning it to `src`
 * directly yields a literal `[object Promise]` and the image never loads,
 * which is exactly why quote bubbles used to show no images). Accept both a
 * plain URL and a promise, and re-render once it settles.
 */
function AttachmentImage(props: {
  attachment: unknown
  loadImage: (attachment: unknown) => string | undefined | Promise<string | undefined>
}): React.ReactNode {
  const { attachment, loadImage } = props
  const [url, setUrl] = useState<string | undefined>(undefined)
  useEffect(() => {
    let alive = true
    setUrl(undefined)
    let result: string | undefined | Promise<string | undefined>
    try {
      result = loadImage(attachment)
    } catch {
      return
    }
    if (result === undefined) return
    if (typeof result === 'string') {
      setUrl(result)
      return
    }
    result
      .then((resolved) => {
        if (alive && typeof resolved === 'string') setUrl(resolved)
      })
      .catch(() => {
        // no thumbnail for this attachment
      })
    return () => {
      alive = false
    }
  }, [attachment, loadImage])
  return url === undefined ? null : <img src={url} alt="" />
}

/**
 * The bubble body, chip by chip where the user typed them.
 *
 * Quotes composed by 0.7.2+ carry `at` (their offset in the message's own
 * text); interleaving on it restores the order the user saw in the composer.
 * Older messages have no offsets — those keep the old layout (chips first),
 * which is exactly what they looked like when they were sent.
 */
function bubbleContent(
  text: string,
  quotes: readonly ParsedQuote[],
  small: boolean,
): React.ReactNode[] {
  const placed = quotes
    .map((quote, index) => ({ quote, index, at: quote.at }))
    .filter((entry): entry is { quote: ParsedQuote; index: number; at: number } =>
      typeof entry.at === 'number',
    )
    .sort((left, right) => left.at - right.at)
  const chip = (quote: ParsedQuote, index: number): React.ReactNode => (
    <QuoteChip
      key={`${quote.id}-${index}`}
      quote={toChipQuote(quote, index)}
      small={small}
      hint={quote.long === true ? t('chip.openDetail') : t('chip.locate')}
      onOpen={() => openChip(quote, index)}
    />
  )
  if (placed.length === 0) {
    return [
      ...quotes.map((quote, index) => chip(quote, index)),
      text ? (
        <span key="text" className="dsqe-bubbleText">
          {text}
        </span>
      ) : null,
    ]
  }
  const nodes: React.ReactNode[] = []
  let cursor = 0
  for (const entry of placed) {
    const at = Math.max(cursor, Math.min(text.length, entry.at))
    if (at > cursor) {
      nodes.push(
        <span key={`t-${cursor}`} className="dsqe-bubbleText">
          {text.slice(cursor, at)}
        </span>,
      )
    }
    nodes.push(chip(entry.quote, entry.index))
    cursor = at
  }
  if (cursor < text.length) {
    nodes.push(
      <span key={`t-${cursor}`} className="dsqe-bubbleText">
        {text.slice(cursor)}
      </span>,
    )
  }
  return nodes
}

/**
 * Replacement for the built-in `user` / `steering` Chat node view — the one
 * view behind both features:
 *
 * - **marker** (`display: contents`, layout-neutral): tags the row as a user
 *   message for the hover chrome, registers the original wire text +
 *   timestamp for the editor, and marks the row as a positioning context;
 * - **quoted messages** render the custom chip bubble (chips + own text on
 *   the first row, full quote text below, hover previews);
 * - **plain messages** delegate to the host's own `UserMessageNodeView`
 *   untouched (zero visual change), or a plain fallback bubble when the host
 *   view cannot be identified;
 * - another message plugin's view (negative priority, e.g. a leftover
 *   separate plugin) wins the delegation and receives the node untouched.
 *
 * Raw protocol blocks never reach the host view: the host path receives the
 * node with the block stripped from its text blocks.
 */
export function UserMessageView(
  props: UserMessageProps & {
    kind: 'user' | 'steering'
    delegateOf: () => ReturnType<typeof pickDelegate>
  },
): React.ReactNode {
  ensureStyles()
  const { node, delegateOf, kind, ...rest } = props
  const raw = contentBlocksToText(node?.data?.content)
  const time = typeof node?.data?.time === 'number' ? node.data.time : undefined
  const seq = typeof node?.data?.seq === 'number' ? node.data.seq : undefined
  const markerRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const element = markerRef.current
    if (!element) return
    const row = element.closest('[data-chat-flow-key]')
    if (!(row instanceof HTMLElement)) return
    const flowKey = row.getAttribute('data-chat-flow-key')
    if (flowKey) {
      registerMessage(flowKey, {
        raw,
        ...(time !== undefined ? { time } : {}),
        ...(seq !== undefined ? { seq } : {}),
        images: toImageRefs(node?.data?.content),
      })
    }
    row.classList.add('dsqe_row')
    // Quote bubbles have no host action row, so reserve the action-row height
    // permanently (see .dsqe_rowQuote). Constant height = no layout jump when
    // the hover row shows/hides.
    const isQuote = scanQuotes(raw).quotes.length > 0
    row.classList.toggle('dsqe_rowQuote', isQuote)
    // Plain messages: place edit + undo next to the native copy button up
    // front (not only after the first hover), so they are always present and
    // inherit the host's own reveal transition — synced with the copy button.
    if (!isQuote) ensureHostButtons(row)
  }, [raw, time, seq])

  const scanned = scanQuotes(raw)
  const text = scanned.rest.trim()
  const delegate = delegateOf?.()
  const rewrittenNode =
    delegate?.kind === 'host' && text !== raw.trim()
      ? {
          ...node,
          data: { ...node?.data, content: strippedContent(node?.data?.content, text) },
        }
      : node

  let content: React.ReactNode
  if (delegate !== undefined && delegate.kind === 'plugin') {
    const Delegate = delegate.component as
      | React.ComponentType<Record<string, unknown>>
      | undefined
    content =
      Delegate !== undefined ? (
        <Delegate {...rest} node={node} />
      ) : (
        <div className="dsqe-fallbackRow">
          <div className="dsqe-fallbackBubble">{text}</div>
        </div>
      )
  } else if (scanned.quotes.length > 0) {
    const images = imageAttachments(node?.data?.content)
    const loadImage = rest.loadImage as
      | ((attachment: unknown) => string | undefined)
      | undefined
    content = (
      <div className="dsqe-userRow">
        <div className="dsqe-userStack" data-dsqe-quote-bubble="true">
          {images.length > 0 && loadImage !== undefined ? (
            <div className="dsqe-userImages" data-message-attachments="true">
              {images.map((attachment, index) => (
                <AttachmentImage key={`image-${index}`} attachment={attachment} loadImage={loadImage} />
              ))}
            </div>
          ) : null}
          <div className="dsqe-bubble">
            <div className="dsqe-bubbleRow">{bubbleContent(text, scanned.quotes, true)}</div>
          </div>
        </div>
      </div>
    )
  } else {
    const Host = delegate?.component as
      | React.ComponentType<Record<string, unknown>>
      | undefined
    content =
      Host !== undefined ? (
        <Host {...rest} node={rewrittenNode} />
      ) : (
        <div className="dsqe-fallbackRow">
          <div className="dsqe-fallbackBubble">{text}</div>
        </div>
      )
  }

  return (
    <div ref={markerRef} className="dsqe_marker" data-dsqe-user="true" data-dsqe-kind={kind}>
      {content}
    </div>
  )
}
