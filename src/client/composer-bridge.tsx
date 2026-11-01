import React, { useEffect } from 'react'
import { runtime, type ComposerActions } from './runtime.ts'

/**
 * Composer bridge (`conversation.input.overlay`): publishes the resident
 * composer's `inputActions` and current draft into the shared runtime so the
 * plain-DOM editor can write the edited message back and submit it as a new
 * message, and the paste interceptor can append when needed.
 */
export function ComposerBridge(props: {
  useInput?: <T>(selector: (state: { draft: string; draftRev: number }) => T) => T
  inputActions?: ComposerActions
  [key: string]: unknown
}): React.ReactNode {
  const actions = props.inputActions ?? null
  const draft = typeof props.useInput === 'function' ? props.useInput((state) => state.draft) : ''
  useEffect(() => {
    runtime.inputActions = actions
    runtime.draft = draft
    return () => {
      if (runtime.inputActions === actions) runtime.inputActions = null
      if (runtime.draft === draft) runtime.draft = null
    }
  })
  return null
}
