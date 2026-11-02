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

export interface AttachmentReadResult {
  readonly ok?: boolean
  readonly value?: { readonly data?: Uint8Array | ArrayBuffer }
  readonly error?: unknown
}

export interface SessionLike {
  command?(line: string): Promise<CommandResult>
  /** Read a durable attachment's bytes (for restoring images on withdraw). */
  readAttachment?(attachmentId: string): Promise<AttachmentReadResult>
}

export interface SessionsLike {
  binding?(id: string): { session?: SessionLike } | undefined
  /** Session scope handle, as passed to the composer's attachment API. */
  scope?(id: string): unknown
}

/** A composer draft handle returned by `conversation.createDrafts`. */
export interface DraftLike {
  readonly id: string
}

export interface ComposerInputLike {
  for(scope: unknown): { addAttachments(ids: readonly string[]): boolean }
}

/** The slice of the conversation service used to put images back in the composer. */
export interface ConversationLike {
  readonly input?: ComposerInputLike
  createDrafts?(sessionId: string, files: readonly File[]): DraftLike[]
  releaseDraftAttachments?(drafts: readonly DraftLike[]): void
}

/** One durable image reference carried by an `image` content block. */
export interface ImageAttachmentRef {
  readonly attachmentId: string
  readonly mediaType: string
  readonly name?: string
}

export interface ChatNodeLike {
  readonly data?: { readonly seq?: number; readonly content?: unknown }
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

/**
 * Wait (bounded) until `seq` is no longer a visible node in the chat snapshot.
 * After a rewind the client session view rebinds; restoring draft attachments
 * before that rebind gets them dropped, so image restore waits for the target to
 * disappear first (mirrors the rewind plugin's own outcome wait). Never throws.
 */
export async function waitUntilHidden(
  getUiConversation: () => UiConversationLike | undefined,
  sessionId: string,
  seq: number,
  timeoutMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = chatSnapshotOf(getUiConversation(), sessionId)
    const nodes = snapshot?.nodes
    if (snapshot === undefined) {
      // view not ready — nothing to wait for
      return false
    }
    if (nodes === undefined || typeof nodes.values !== 'function') return true
    let visible = false
    for (const node of nodes.values()) {
      if (node?.data?.seq === seq && node.visibility !== 'hidden') {
        visible = true
        break
      }
    }
    if (!visible) return true
    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 50)
    })
  }
}

/** Image references carried by a message node's `image` content blocks. */
export function imagesOfKey(
  snapshot: ChatSnapshotLike | undefined,
  key: string,
): ImageAttachmentRef[] {
  const node = snapshot?.nodes?.get?.(key)
  const content = node?.data?.content
  if (!Array.isArray(content)) return []
  const images: ImageAttachmentRef[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; attachment?: unknown }
    if (candidate.type !== 'image') continue
    const attachment = candidate.attachment as
      | { attachmentId?: unknown; mediaType?: unknown; name?: unknown }
      | undefined
    if (typeof attachment?.attachmentId !== 'string') continue
    if (typeof attachment.mediaType !== 'string') continue
    images.push({
      attachmentId: attachment.attachmentId,
      mediaType: attachment.mediaType,
      ...(typeof attachment.name === 'string' ? { name: attachment.name } : {}),
    })
  }
  return images
}

const IMAGE_MEDIA_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export interface RestoreImagesDeps {
  readonly sessionId: string
  readonly session?: SessionLike
  /** Session scope handle (fallback path via `conversation.input.for`). */
  readonly scope?: unknown
  readonly getConversation: () => ConversationLike | undefined
  /**
   * Preferred: the composer's own `inputActions.addAttachments`, already bound
   * to the resident shell. Avoids scope-resolution mismatches.
   */
  readonly addAttachments?: (ids: readonly string[]) => boolean
}

/**
 * Put a withdrawn message's images back into the composer: read each durable
 * attachment's bytes, build Files, create drafts, and add their ids to the
 * composer's attachment list (the same path the host uses to attach images).
 *
 * Returns the number of images re-attached (0 when unsupported/unavailable).
 * Never throws.
 */
export async function restoreImages(
  deps: RestoreImagesDeps,
  images: readonly ImageAttachmentRef[],
): Promise<number> {
  if (images.length === 0) return 0
  const { session } = deps
  const conversation = deps.getConversation()
  const canAddViaActions = deps.addAttachments !== undefined
  const canAddViaScope =
    conversation?.input !== undefined && deps.scope !== undefined && deps.scope !== null
  if (
    session?.readAttachment === undefined ||
    conversation?.createDrafts === undefined ||
    (!canAddViaActions && !canAddViaScope)
  ) {
    return 0
  }
  const files: File[] = []
  for (const [index, ref] of images.entries()) {
    const extension = IMAGE_MEDIA_EXTENSION[ref.mediaType]
    if (extension === undefined) continue
    try {
      const result = await session.readAttachment(ref.attachmentId)
      if (result?.ok !== true || result.value?.data === undefined) continue
      const name = ref.name ?? `image-${index + 1}.${extension}`
      files.push(new File([result.value.data as BlobPart], name, { type: ref.mediaType }))
    } catch {
      // skip this image, keep the rest
    }
  }
  if (files.length === 0) return 0
  try {
    const drafts = conversation.createDrafts(deps.sessionId, files)
    const ids = drafts.map((draft) => draft.id)
    const admitted = canAddViaActions
      ? deps.addAttachments!(ids)
      : conversation.input!.for(deps.scope).addAttachments(ids)
    if (!admitted) {
      conversation.releaseDraftAttachments?.(drafts)
      return 0
    }
    return drafts.length
  } catch {
    return 0
  }
}

export interface WithdrawDeps {
  readonly sessionId: string
  readonly flowKey: string
  /** `data-chat-anchor-key` of the row (the chat snapshot's node key). */
  readonly anchorKey: string
  readonly getSessions: () => SessionsLike | undefined
  readonly getUiConversation: () => UiConversationLike | undefined
  /** Conversation service (composer attachments) for image restore. */
  readonly getConversation?: () => ConversationLike | undefined
  /** Raw wire text of the message (protocol block included), if known. */
  readonly getRaw: (flowKey: string) => string | undefined
  /** fallback seq recorded by the node view, when the snapshot is unavailable. */
  readonly getSeq?: (flowKey: string) => number | undefined
  /** Image refs recorded by the node view (most reliable source). */
  readonly getImages?: (flowKey: string) => readonly ImageAttachmentRef[] | undefined
  /** Composer's own addAttachments action (preferred for image restore). */
  readonly addAttachments?: (ids: readonly string[]) => boolean
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

  const sessions = deps.getSessions()
  const session = sessions?.binding?.(deps.sessionId)?.session
  if (session?.command === undefined) {
    return { ok: false, refilled: false, reason: 'no-session' }
  }

  // Read the message's images before the rewind hides the node. The node view
  // is the most faithful source; the chat snapshot is the fallback.
  let images = deps.getImages?.(deps.flowKey) ?? []
  if (images.length === 0) {
    images = imagesOfKey(snapshot, deps.anchorKey)
    if (images.length === 0) images = imagesOfKey(snapshot, deps.flowKey)
  }
  const scope = sessions?.scope?.(deps.sessionId)
  // The conversation service is reached through the session-scoped context in
  // the shipped code (e.g. ui-commands does `binding.ctx.get("conversation")`);
  // the root ctx may not resolve it for a sibling plugin. Try scoped first.
  const scopeLike = scope as { get?: (name: string) => unknown } | undefined
  const scopedConversation = scopeLike?.get?.('conversation') as ConversationLike | undefined
  const conversation = scopedConversation ?? deps.getConversation?.()

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

  // Restore images AFTER the rewind settles. Doing it before/with the command
  // raced the rewind's session-view rebind, which dropped the fresh drafts —
  // that is why images went missing. Wait for the target row to disappear from
  // the (client) chat view first, then restore. Text refill above stays instant.
  if (images.length > 0 && conversation !== undefined) {
    try {
      await waitUntilHidden(deps.getUiConversation, deps.sessionId, seq, 2000)
      await restoreImages(
        {
          sessionId: deps.sessionId,
          session,
          scope,
          getConversation: () => conversation,
          ...(deps.addAttachments !== undefined ? { addAttachments: deps.addAttachments } : {}),
        },
        images,
      )
    } catch {
      // image restore is best-effort
    }
  }
  return { ok: true, refilled }
}
