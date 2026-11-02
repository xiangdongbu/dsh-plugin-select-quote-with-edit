/**
 * 撤回消息 (withdraw / rewind) — the engine side of the ↶ action.
 *
 * Withdrawing a message means three things at once:
 *
 * 1. the message and everything after it leave the model context and the
 *    rendered transcript (an append-only "surface marker" the host inserts);
 * 2. every file the turn touched is restored to its pre-turn content (the
 *    workspace checkpoint restore);
 * 3. the withdrawn message is refilled into the composer verbatim, so a quote
 *    message carries its `<dsh-quotes>` block back and the composer panel
 *    unfolds it into pending quote chips again.
 *
 * All three are provided by the resident `dsh-rewind-plugin`: it registers an
 * internal `/rewind-plugin @<seq> <mode>` command that appends the surface
 * marker and, in `both` mode, restores snapshotted files. This module only
 * resolves the message's log `seq`, invokes that command, and puts the raw
 * wire text back into the composer. Everything is dependency-injected so the
 * logic is unit-testable without the host.
 *
 * The command name is an implementation detail of dsh-rewind-plugin; if the
 * plugin is absent the command is simply unmatched and we report a failure
 * without touching the draft.
 */

/** `dsh-rewind-plugin`'s internal execution command (see its hidden.ts). */
export const ENGINE_COMMAND = 'rewind-plugin'

export interface CommandResult {
  readonly ok?: boolean
  readonly value?: { readonly matched?: boolean }
  readonly error?: { readonly message?: string }
}

export interface SessionLike {
  command?(line: string): Promise<CommandResult>
}

export interface SessionsLike {
  binding?(id: string): { session?: SessionLike } | undefined
}

export interface ChatNodeLike {
  readonly data?: { readonly seq?: number }
  /** The rewind plugin's visibility layer hides shadowed rows in place. */
  readonly visibility?: 'visible' | 'hidden'
}

export interface ChatSnapshotLike {
  readonly nodes?: Map<string, ChatNodeLike>
  readonly order?: readonly string[]
}

export interface ChatViewLike {
  getSnapshot?(): ChatSnapshotLike | undefined
}

export interface ConversationBindingLike {
  target?(name: string): ChatViewLike | undefined
}

export interface UiConversationLike {
  binding?(id: string): ConversationBindingLike | undefined
}

/** The chat snapshot for a session, or undefined when the view is not ready. */
export function chatSnapshotOf(
  ui: UiConversationLike | undefined,
  sessionId: string,
): ChatSnapshotLike | undefined {
  try {
    return ui?.binding?.(sessionId)?.target?.('chat')?.getSnapshot?.()
  } catch {
    return undefined
  }
}

/** Look up the log `seq` of a message node in a chat snapshot (by anchor key). */
export function seqOfKey(
  snapshot: ChatSnapshotLike | undefined,
  key: string,
): number | undefined {
  if (snapshot === undefined) return undefined
  const nodes = snapshot.nodes
  if (nodes !== undefined && typeof nodes.get === 'function') {
    const direct = nodes.get(key)
    const seq = direct?.data?.seq
    if (typeof seq === 'number') return seq
  }
  // Fallback: some snapshots expose `order` without a Map `get`.
  for (const orderedKey of snapshot.order ?? []) {
    if (orderedKey !== key) continue
    const node = nodes?.get?.(orderedKey)
    const seq = node?.data?.seq
    if (typeof seq === 'number') return seq
  }
  return undefined
}

export interface WithdrawDeps {
  readonly sessionId: string
  readonly flowKey: string
  /** `data-chat-anchor-key` of the row (the chat snapshot's node key). */
  readonly anchorKey: string
  readonly getSessions: () => SessionsLike | undefined
  readonly getUiConversation: () => UiConversationLike | undefined
  /** Raw wire text of the message (protocol block included), if known. */
  readonly getRaw: (flowKey: string) => string | undefined
  /** fallback seq recorded by the node view, when the snapshot is unavailable. */
  readonly getSeq?: (flowKey: string) => number | undefined
  readonly setDraft: (text: string) => void
}

export interface WithdrawOutcome {
  readonly ok: boolean
  /** True when the message text was written back into the composer. */
  readonly refilled: boolean
  /** Machine-readable failure reason (for logging only). */
  readonly reason?: string
}

/**
 * Withdraw the message at `flowKey`: rewind the conversation + files, and
 * refill the composer with the message's raw wire text.
 *
 * The refill is **not** gated on the rewind/restore finishing. The host's
 * rewind handler awaits workspace file restore (which can take a while), so
 * awaiting the command before writing the draft made the input box appear to
 * lag. Here the command is dispatched, the composer is filled immediately, and
 * only then does the caller continue to await the command result (for the
 * failure hint).
 *
 * Returns `ok:false` when the seq cannot be resolved or the rewind command is
 * unavailable/rejected; the draft is still filled when a raw text is known.
 */
export async function withdrawMessage(deps: WithdrawDeps): Promise<WithdrawOutcome> {
  const snapshot = chatSnapshotOf(deps.getUiConversation(), deps.sessionId)
  let seq = seqOfKey(snapshot, deps.anchorKey)
  if (seq === undefined) seq = seqOfKey(snapshot, deps.flowKey)
  if (seq === undefined) seq = deps.getSeq?.(deps.flowKey)
  if (seq === undefined) return { ok: false, refilled: false, reason: 'no-seq' }

  const session = deps.getSessions()?.binding?.(deps.sessionId)?.session
  if (session?.command === undefined) {
    return { ok: false, refilled: false, reason: 'no-session' }
  }

  // Dispatch the rewind, then write the draft in the same tick (before awaiting
  // the slow file-restore handler) so the composer updates instantly.
  const command = session.command(`/${ENGINE_COMMAND} @${seq} both`)
  const raw = deps.getRaw(deps.flowKey)
  let refilled = false
  if (raw !== undefined) {
    try {
      deps.setDraft(raw)
      refilled = true
    } catch {
      // keep going: the rewind itself may still be useful
    }
  }

  let result: CommandResult
  try {
    result = await command
  } catch {
    return { ok: false, refilled, reason: 'command-threw' }
  }
  if (result?.ok !== true) return { ok: false, refilled, reason: 'command-rejected' }
  if (result.value?.matched === false) return { ok: false, refilled, reason: 'command-unmatched' }
  return { ok: true, refilled }
}
