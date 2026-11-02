/**
 * Durable-message registry: the `user` / `steering` node view (priority -20)
 * records every message's original wire text and timestamp here, keyed by the
 * transcript flow key. The plain-DOM hover chrome (chrome.ts) reads entries
 * from here when the user hovers a row or starts editing — no DOM text
 * scraping, no heuristics.
 *
 * The map is overwritten per flow key on re-render and is bounded by the
 * conversation length; the current host keeps old messages mounted, so stale
 * entries are tiny strings and are not pruned.
 */

/** A durable image reference captured from a message's `image` content block. */
export interface ImageRef {
  readonly attachmentId: string
  readonly mediaType: string
  readonly name?: string
}

export interface MessageEntry {
  readonly raw: string
  readonly time?: number
  /** Log seq of the message, when the host exposes it (for ↶ withdraw). */
  readonly seq?: number
  /** Image references carried by the message (restored into the composer on ↶). */
  readonly images?: readonly ImageRef[]
}

const registry = new Map<string, MessageEntry>()

export function registerMessage(flowKey: string, entry: MessageEntry): void {
  registry.set(flowKey, entry)
}

export function getMessage(flowKey: string): MessageEntry | undefined {
  return registry.get(flowKey)
}
