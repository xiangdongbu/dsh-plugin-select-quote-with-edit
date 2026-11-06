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
import { QuoteDetailPanel, openDetail } from './detail.tsx'
import { locateQuote } from './locate.ts'
import { SourceMarkOverlay } from './source-mark.tsx'
import { installSidebarDetail } from './sidebar-tab.tsx'
import { UserMessageView } from './transcript.tsx'
import { pickDelegate } from './host-node.ts'
import { runtime } from './runtime.ts'
import { syncGhostsSoon } from './turn-ghost.ts'
import { watchComposerResize } from './composer-resize.ts'
import { recordWideTableMetrics } from './wide-tables.ts'
import { watchQuotePaste } from './paste.ts'
import { registerQuoteSource, watchChipDeletion } from './inline-chips.ts'
import { watchChipClipboard } from './chip-clipboard.ts'

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
export const inject = ['slots', 'locale', 'sessions', 'sidebarRight', 'sidebarRightTabs']

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

  // Inline chips ride the host's own reference node; the source registration
  // owns click routing (「定位原文」/ 详情) and the fallback serializer.
  ctx.effect(
    () => registerQuoteSource(ctx, { openDetail, locate: locateQuote }),
    'select-quote-with-edit: inline quote source',
  )

  // Backspace / Delete aimed at one of our chips removes it whole. Lexical only
  // does that for a text-node caret; on an element point it splits the block.
  ctx.effect(() => watchChipDeletion(), 'select-quote-with-edit: chip deletion')

  // Select-all + copy in the composer must carry the chips too: the host's own
  // projection writes the invisible U+FFFC placeholder, so the selection used
  // to copy the typed text only.
  ctx.effect(() => watchChipClipboard(), 'select-quote-with-edit: chip clipboard')

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

  // Root: the underline layer for 「定位原文」. Below the toolbar and the
  // drawer, above the transcript itself — it paints over message text but must
  // never swallow pointer events (the lines are pointer-events: none).
  ctx.slots.inject('shell.overlay', () => {
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'select-quote-with-edit-source-mark',
        order: 90,
      },
      SourceMarkOverlay,
    )
  })

  // Root: right-hand detail for capsule clicks in sent messages. The native
  // sidebar tab is preferred (sidebar-tab.tsx); the sidebar services may lag
  // apply() in some profiles, so retry briefly before keeping the local
  // drawer (QuoteDetailPanel) as the fallback.
  ctx.effect(() => {
    let tries = 10
    const attempt = (): void => {
      const opener = installSidebarDetail(ctx)
      if (opener !== null) {
        runtime.detailOpener = opener
        return
      }
      if (tries > 0) {
        tries -= 1
        window.setTimeout(attempt, 100)
      }
    }
    attempt()
    return () => {
      tries = 0
      if (runtime.detailOpener !== null) runtime.detailOpener = null
    }
  }, 'select-quote-with-edit: native sidebar detail tab')
  ctx.slots.inject('shell.overlay', () => {
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'select-quote-with-edit-detail',
        order: 110,
      },
      QuoteDetailPanel,
    )
  })

  // Session: composer bridge (publishes inputActions for the editor, and the
  // ↶ withdraw engine) and the pending quote chips.
  // The withdraw engine talks to `sessions` (run the rewind command) and
  // `uiConversation` (resolve the message seq from the chat snapshot); both are
  // resolved lazily so a missing service degrades to a no-op instead of
  // breaking apply().
  const safeGet = (name: string): unknown => {
    try {
      const direct = (ctx as unknown as Record<string, unknown>)[name]
      if (direct !== undefined) return direct
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * `uiConversation` is NOT in this plugin's `inject` list (adding a service
   * there makes the whole plugin wait for it), and a property read of a
   * non-injected service is gated — so the withdraw engine has been running
   * without a chat snapshot all along and silently falling back to the seq the
   * node view registered. The rail-ghost filter cannot work that way: it needs
   * the snapshot's `visibility` + `location.turn`. Resolve the service through
   * an optional child scope, exactly like `dsh-rewind-plugin` does.
   */
  const injected: { uiConversation?: unknown; conversation?: unknown } = {}
  ctx.effect(() => {
    const inject = (ctx as unknown as {
      inject?: (names: readonly string[], callback: (child: Record<string, unknown>) => unknown) => unknown
    }).inject
    if (typeof inject !== 'function') return
    const dispose = inject(['uiConversation', 'conversation'], (child) => {
      const read = (name: string): unknown => {
        try {
          const get = child.get
          const value = typeof get === 'function' ? (get as (key: string) => unknown).call(child, name) : undefined
          return value ?? child[name]
        } catch {
          return undefined
        }
      }
      injected.uiConversation = read('uiConversation')
      injected.conversation = read('conversation')
      // The snapshot may only become readable now: re-run the rail ghost sync.
      syncGhostsSoon()
    })
    return () => {
      injected.uiConversation = undefined
      injected.conversation = undefined
      if (typeof dispose === 'function') (dispose as () => void)()
    }
  }, 'select-quote-with-edit: uiConversation scope')

  const withdrawServices = {
    sessions: () => safeGet('sessions'),
    uiConversation: () => injected.uiConversation ?? safeGet('uiConversation'),
    conversation: () => injected.conversation ?? safeGet('conversation'),
  }
  function ComposerBridgeWithServices(props: Record<string, unknown>) {
    return <ComposerBridge {...props} services={withdrawServices} />
  }
  ctx.slots.inject('conversation.input.overlay', () => {
    ctx.slots.register(
      {
        name: 'conversation.input.overlay',
        id: 'select-quote-with-edit-bridge',
        order: 1,
      },
      ComposerBridgeWithServices,
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
          // The 0.2.2-rc host hands `renderSlotChain` only to entries that
          // declare the child chains their view renders. Without this the
          // plain-message delegation (our view rendering the host component
          // with our props) crashed — renderSlotChain is not a function — the
          // host tore the crashed entry down, and the whole transcript fell
          // back to plain host views: no chips, no edit/withdraw buttons.
          children: { 'conversation.chat.user.before': { kind: 'chain', scope: 'session' } },
        },
        View,
      )
    })
  }

  // Hover chrome: action row + inline editor (plain DOM).
  ctx.effect(() => watchMessageChrome(), 'select-quote-with-edit: hover chrome')

  // Composer grip: drag the input taller, double-click resets (plain DOM).
  ctx.effect(() => watchComposerResize(), 'select-quote-with-edit: composer resize')

  // TEMP(0.7.21): wide-markdown-table box metrics -> localStorage.
  recordWideTableMetrics()

}
