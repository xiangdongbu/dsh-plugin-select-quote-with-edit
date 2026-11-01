import React from 'react'
import type { ClientContext, SlotEntryInspection, UserMessageProps } from './context.d.ts'
import { LOCALE_NS } from './identity.ts'
import { bindLocale, DICTIONARIES } from './i18n.ts'
import { ensureStyles } from './styles.ts'
import { watchQuoteEchoStrip } from './echo-strip.ts'
import { watchStorageAdoption } from './store.ts'
import { watchMessageChrome } from './chrome.ts'
import { SelectionToolbar } from './selection-toolbar.tsx'
import { ComposerPanel } from './composer-panel.tsx'
import { ComposerBridge } from './composer-bridge.tsx'
import { UserMessageView } from './transcript.tsx'
import { pickDelegate } from './host-node.ts'
import { watchQuotePaste } from './paste.ts'

/**
 * Browser half of dsh-plugin-select-quote-with-edit — the two features in one
 * client module:
 *
 * - **划词引用**：selection toolbar (`shell.overlay`), pending quote chips in
 *   the composer (`conversation.input.overlay` + U+200B marker + send-time
 *   folding + rewind restore), quote bubbles in the transcript;
 * - **消息编辑**：hover action row (time / edit / copy) + inline editor on
 *   user messages (plain DOM chrome), sending via the resident composer.
 *
 * Both share the `<dsh-quotes>` wire protocol, the same quote store, the same
 * preview panel and the same chat-node view.
 */
export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ensureStyles()

  // Two-language dictionary, as the host requires (zh + en in one call);
  // `bind` resolves against the user's active language on every call.
  ctx.effect(
    () => ctx.locale.register(LOCALE_NS, DICTIONARIES),
    'select-quote-with-edit: dictionaries',
  )
  bindLocale({ translate: ctx.locale.bind(LOCALE_NS) })

  // The optimistic send echo paints the submitted text verbatim — strip the
  // protocol block from it (and from the queue preview).
  ctx.effect(() => watchQuoteEchoStrip(), 'select-quote-with-edit: echo strip')

  // Another tab wrote (or cleared) one of our session partitions: adopt it.
  ctx.effect(() => watchStorageAdoption(), 'select-quote-with-edit: storage adoption')

  // Pasting copied message content into the composer restores its quotes as
  // pending chips (the quotes ride in the clipboard's HTML flavor).
  ctx.effect(() => watchQuotePaste(), 'select-quote-with-edit: quote paste')

  // Root: always-mounted selection toolbar. Root-scoped so transcript
  // selections are observed no matter which session or history view is up.
  ctx.slots.inject('shell.overlay', () => {
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'select-quote-with-edit-toolbar',
        order: 100,
      },
      SelectionToolbar,
    )
  })

  // Session: composer bridge (publishes inputActions for the editor) and the
  // pending quote chips.
  ctx.slots.inject('conversation.input.overlay', () => {
    ctx.slots.register(
      {
        name: 'conversation.input.overlay',
        id: 'select-quote-with-edit-bridge',
        order: 1,
      },
      ComposerBridge,
    )
  })
  ctx.slots.inject('conversation.input.overlay', () => {
    ctx.slots.register(
      {
        name: 'conversation.input.overlay',
        id: 'select-quote-with-edit-card',
        order: 20,
      },
      ComposerPanel,
    )
  })

  // History: one view for both features. It wins the election at -20, tags
  // the row and registers the wire text for the editor, renders the custom
  // chip bubble for quoted messages, and delegates everything else to the
  // host view untouched. `steering` is the same bubble under another key.
  const entries = (): readonly SlotEntryInspection[] =>
    typeof ctx.slots.entries === 'function' ? ctx.slots.entries('conversation.chat.node') : []
  function UserNode(props: UserMessageProps) {
    return (
      <UserMessageView
        {...props}
        kind="user"
        delegateOf={() => pickDelegate(entries(), UserNode, 'user')}
      />
    )
  }
  function SteeringNode(props: UserMessageProps) {
    return (
      <UserMessageView
        {...props}
        kind="steering"
        delegateOf={() => pickDelegate(entries(), SteeringNode, 'steering')}
      />
    )
  }
  for (const [key, View] of [
    ['user', UserNode],
    ['steering', SteeringNode],
  ] as const) {
    ctx.slots.inject('conversation.chat.node', () => {
      ctx.slots.register(
        {
          name: 'conversation.chat.node',
          key,
          priority: -20,
          // The delegated host view needs its own translator; the chat
          // namespace is the one it is written against.
          locale: 'chat',
        },
        View,
      )
    })
  }

  // Hover chrome: action row + inline editor (plain DOM).
  ctx.effect(() => watchMessageChrome(), 'select-quote-with-edit: hover chrome')
}
