import React, { useEffect } from 'react'
import { runtime, type ComposerActions } from './runtime.ts'
import { getMessage } from './registry.ts'
import {
  withdrawMessage,
  type ConversationLike,
  type SessionsLike,
  type UiConversationLike,
  type WithdrawOutcome,
} from './withdraw.ts'

/**
 * Lazy accessors into the host services the ↶ withdraw needs. They are
 * resolved at click time (not at apply time) so a service that mounts slightly
 * later is still picked up, and so the mock harness (which provides none)
 * simply reports "unavailable" instead of throwing.
 */
export interface WithdrawServices {
  readonly sessions?: () => unknown
  readonly uiConversation?: () => unknown
  readonly conversation?: () => unknown
}

/**
 * Composer bridge (`conversation.input.overlay`): publishes the resident
 * composer's `inputActions` and current draft into the shared runtime so the
 * plain-DOM editor can write the edited message back and submit it as a new
 * message, and the paste interceptor can append when needed. It also publishes
 * the ↶ withdraw engine bound to the current session.
 */
export function ComposerBridge(props: {
  useInput?: <T>(selector: (state: { draft: string; draftRev: number }) => T) => T
  inputActions?: ComposerActions
  sessionId?: string
  services?: WithdrawServices
  [key: string]: unknown
}): React.ReactNode {
  const actions = props.inputActions ?? null
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : null
  const services = props.services
  const draft = typeof props.useInput === 'function' ? props.useInput((state) => state.draft) : ''
  useEffect(() => {
    runtime.inputActions = actions
    runtime.draft = draft
    runtime.sessionId = sessionId
    runtime.withdraw =
      sessionId === null
        ? null
        : (flowKey: string, anchorKey: string): Promise<WithdrawOutcome> =>
            withdrawMessage({
              sessionId,
              flowKey,
              anchorKey,
              getSessions: () => services?.sessions?.() as SessionsLike | undefined,
              getUiConversation: () => services?.uiConversation?.() as UiConversationLike | undefined,
              getConversation: () => services?.conversation?.() as ConversationLike | undefined,
              getRaw: (key) => getMessage(key)?.raw,
              getSeq: (key) => getMessage(key)?.seq,
              setDraft: (text) => {
                runtime.inputActions?.setDraft(text)
              },
            })
    return () => {
      if (runtime.inputActions === actions) runtime.inputActions = null
      if (runtime.draft === draft) runtime.draft = null
      if (runtime.sessionId === sessionId) {
        runtime.sessionId = null
        runtime.withdraw = null
      }
    }
  })
  return null
}
