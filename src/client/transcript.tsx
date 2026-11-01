import React, { useLayoutEffect, useRef } from 'react'
import { scanQuotes, type ParsedQuote } from './protocol.ts'
import { QuoteChip, type QuoteLike } from './chip.tsx'
import { pickDelegate } from './host-node.ts'
import { registerMessage } from './registry.ts'
import type { UserMessageProps } from './context.d.ts'
import { ensureStyles } from './styles.ts'

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

function toChipQuote(quote: ParsedQuote, index: number): QuoteLike {
  return { id: `${quote.id}-${index}`, text: quote.text }
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
  const markerRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const element = markerRef.current
    if (!element) return
    const row = element.closest('[data-chat-flow-key]')
    if (!(row instanceof HTMLElement)) return
    const flowKey = row.getAttribute('data-chat-flow-key')
    if (flowKey) registerMessage(flowKey, { raw, ...(time !== undefined ? { time } : {}) })
    row.classList.add('dsqe_row')
  }, [raw, time])

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
    const chipQuotes = scanned.quotes.map(toChipQuote)
    content = (
      <div className="dsqe-userRow">
        <div className="dsqe-userStack" data-dsqe-quote-bubble="true">
          {images.length > 0 && loadImage !== undefined ? (
            <div className="dsqe-userImages" data-message-attachments="true">
              {images.map((attachment, index) => {
                const url = loadImage(attachment)
                return url === undefined ? null : (
                  <img key={`image-${index}`} src={url} alt="" />
                )
              })}
            </div>
          ) : null}
          <div className="dsqe-bubble">
            <div className="dsqe-bubbleRow">
              {chipQuotes.map((quote) => (
                <QuoteChip key={quote.id} quote={quote} small />
              ))}
              {text ? <span className="dsqe-bubbleText">{text}</span> : null}
            </div>
            {scanned.quotes.map((quote, index) => (
              <div key={`${quote.id}-body-${index}`} className="dsqe-quoteBody">
                {quote.text}
              </div>
            ))}
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
