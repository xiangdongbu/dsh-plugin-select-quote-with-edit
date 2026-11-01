import React, { useEffect } from 'react'
import { runtime, type ComposerActions } from './runtime.ts'

/**
 * Composer bridge (`conversation.input.overlay`): publishes the resident
 * composer's `inputActions` into the shared runtime so the plain-DOM editor
 * can write the edited message back and submit it as a new message.
 */
export function ComposerBridge(props: {
  inputActions?: ComposerActions
  [key: string]: unknown
}): React.ReactNode {
  const actions = props.inputActions ?? null
  useEffect(() => {
    runtime.inputActions = actions
    return () => {
      if (runtime.inputActions === actions) runtime.inputActions = null
    }
  })
  return null
}
