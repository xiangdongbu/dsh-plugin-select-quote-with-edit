/**
 * Cross-slot runtime: the composer bridge publishes `inputActions` (plus the
 * current draft read) here so the plain-DOM editor (chrome.ts) can write the
 * edited text into the resident composer and submit it as a new message, and
 * the paste interceptor can fall back to appending when execCommand is
 * unavailable. The panel also exposes `markFolded` — the editor's write-back
 * must set the fold guard, or the rewind-restore path would read the
 * just-composed protocol block out of the draft and turn it back into pending
 * quotes (racing the send).
 *
 * `sessionId` + `withdraw` are published by the same bridge for the ↶ action:
 * the plain-DOM chrome has no React context, so it reaches the withdraw engine
 * (resolve the message seq, invoke the rewind command, refill the composer)
 * through this runtime.
 */

import type { WithdrawOutcome } from './withdraw.ts'

export interface ComposerActions {
  readonly setDraft: (text: string) => void
  /** Add already-created draft attachment ids to this composer (host action). */
  readonly addAttachments?: (ids: readonly string[]) => boolean
}

export const runtime: {
  inputActions: ComposerActions | null
  markFolded: (() => void) | null
  /** Latest composer draft, published by the bridge on every change. */
  draft: string | null
  /** Session the composer currently belongs to. */
  sessionId: string | null
  /** Withdraw the message at `(flowKey, anchorKey)`; see withdraw.ts. */
  withdraw: ((flowKey: string, anchorKey: string) => Promise<WithdrawOutcome>) | null
  /**
   * Open the capsule detail in the host's native right sidebar
   * (sidebar-tab.tsx). Returns false when the sidebar service is missing or
   * no session is bound — the caller then falls back to the local drawer.
   */
  detailOpener: ((text: string, long: boolean) => boolean) | null
  /**
   * Pin the session title to the user's own typed text for a quote-chip
   * message (title-pin.ts): published by the bridge which owns the session
   * handle; the transcript node view calls it when a chip message renders.
   */
  pinTitle:
    | ((raw: string, seq: number | undefined, time: number | undefined, isFirst: boolean) => void)
    | null
} = {
  inputActions: null,
  markFolded: null,
  draft: null,
  sessionId: null,
  withdraw: null,
  detailOpener: null,
  pinTitle: null,
}
