/**
 * TEMPORARY diagnostic build (not for release): post the runtime facts behind
 * the rail-ghost filter to a local beacon so the desktop renderer can be
 * inspected without devtools/CDP.
 */
import { runtime } from './runtime.ts'
import { ghostTurnsOf, hiddenTurnsIn } from './turn-ghost.ts'

const ENDPOINT = 'http://127.0.0.1:4210/diag'
const TICK_MS = 2000
const TICKS = 90

function b64(text: string): string {
  try {
    return btoa(unescape(encodeURIComponent(text)))
  } catch {
    return ''
  }
}

function send(payload: unknown): void {
  const body = JSON.stringify(payload)
  try {
    void fetch(ENDPOINT, { method: 'POST', mode: 'no-cors', body })
    return
  } catch {
    // fall through to the pixel channel
  }
  try {
    const image = new Image()
    image.src = `${ENDPOINT}?p=${encodeURIComponent(b64(body))}`
  } catch {
    // give up silently
  }
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  const type = typeof value
  if (type !== 'object') return type
  const keys = Object.keys(value as Record<string, unknown>)
  return `object{${keys.slice(0, 12).join(',')}}`
}

function safe(label: string, fn: () => unknown): unknown {
  try {
    return fn()
  } catch (error) {
    return { __error: `${label}: ${String(error)}` }
  }
}

function probe(ctx: Record<string, unknown>): unknown {
  const sessionId = runtime.sessionId
  const byProperty = (name: string): unknown => safe(name, () => ctx[name])
  const byGet = (name: string): unknown => {
    const get = ctx.get
    if (typeof get !== 'function') return 'no-ctx.get'
    return safe(name, () => (get as (key: string) => unknown).call(ctx, name))
  }
  const uiFromGet = byGet('uiConversation') as Record<string, unknown> | undefined
  const ui = (uiFromGet ?? (byProperty('uiConversation') as Record<string, unknown> | undefined)) as
    | {
        binding?: (id: string) => {
          target?: (name: string) => { getSnapshot?: () => unknown }
        }
      }
    | undefined
  const binding = safe('binding', () => (sessionId === null ? 'no-session' : typeof ui?.binding))
  const bound = safe('bound', () => (sessionId === null || ui?.binding === undefined ? 'no-binding' : describe(ui.binding(sessionId))))
  const target = safe('target', () => {
    const b = sessionId === null ? undefined : ui?.binding?.(sessionId)
    return b?.target === undefined ? 'no-target' : describe(b.target('chat'))
  })
  const snapshot = safe('snapshot', () => {
    const b = sessionId === null ? undefined : ui?.binding?.(sessionId)
    return describe(b?.target?.('chat')?.getSnapshot?.())
  })
  const nodeInfo = safe('nodes', () => {
    const b = sessionId === null ? undefined : ui?.binding?.(sessionId)
    const snap = b?.target?.('chat')?.getSnapshot?.() as
      | { nodes?: { values?: () => Iterable<Record<string, unknown>> }; order?: unknown }
      | undefined
    const nodes = snap?.nodes
    if (nodes === undefined || typeof nodes.values !== 'function') return { nodes: describe(nodes) }
    let total = 0
    let hidden = 0
    const rows: unknown[] = []
    for (const node of nodes.values()) {
      total += 1
      const visibility = (node as { visibility?: unknown }).visibility
      if (visibility === 'hidden') hidden += 1
      if (rows.length < 12) {
        const location = (node as { location?: { turn?: { turn?: unknown } } }).location
        rows.push({
          key: String((node as { key?: unknown }).key ?? '').slice(0, 40),
          kind: (node as { kind?: unknown }).kind,
          visibility,
          turn: location?.turn?.turn,
        })
      }
    }
    return { total, hidden, order: Array.isArray(snap?.order) ? snap.order.length : describe(snap?.order), rows }
  })
  const marks = safe('marks', () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('button[class*="mark"][aria-label]')).map((button) => ({
      label: button.getAttribute('aria-label'),
      index: button.getAttribute('data-index'),
      display: button.style.display,
      ghost: button.getAttribute('data-dsqe-ghost'),
      compact: button.getAttribute('data-dsqe-compact'),
      transform: button.style.transform,
      top: Math.round(button.getBoundingClientRect().top),
      cls: button.className.slice(0, 40),
    })),
  )
  const storage = safe('storage', () => {
    const out: Record<string, string | null> = {}
    for (const key of ['dsqe-ghost-turns-v2', 'dsqe-ghost-turns', 'dsqe-ghost-pending']) {
      try {
        out[key] = localStorage.getItem(key)
      } catch (error) {
        out[key] = `ERR ${String(error)}`
      }
    }
    return out
  })
  return {
    at: new Date().toISOString(),
    sessionId: sessionId === null ? null : sessionId.slice(0, 12),
    ctxGet: typeof ctx.get,
    uiByGet: describe(uiFromGet),
    uiByProperty: describe(byProperty('uiConversation')),
    sessionsByGet: describe(byGet('sessions')),
    binding,
    bound,
    target,
    snapshot,
    nodeInfo,
    marks,
    storage,
    detected: safe('detected', () => {
      const b = sessionId === null ? undefined : ui?.binding?.(sessionId)
      const snap = b?.target?.('chat')?.getSnapshot?.() as
        | {
            navigation?: { items?: () => readonly { turn?: unknown }[] }
            locations?: { getTurn?: (turn: number) => unknown }
          }
        | undefined
      const marks = Array.from(document.querySelectorAll<HTMLButtonElement>('button[class*="mark"][aria-label]'))
      const railTurns = marks
        .map((button) => Number((button.getAttribute('aria-label') ?? '').match(/(\d+)/u)?.[1]))
        .filter((turn) => Number.isFinite(turn))
      const items = typeof snap?.navigation?.items === 'function' ? snap.navigation.items() : []
      const byTurn = railTurns.slice(0, 12).map((turn) => {
        let keys: unknown = 'no-getTurn'
        try {
          keys = snap?.locations?.getTurn?.(turn)
        } catch (error) {
          keys = `ERR ${String(error)}`
        }
        return {
          turn,
          located: Array.isArray(keys) ? keys.length : String(keys),
          inItems: items.some((item) => item?.turn === turn),
        }
      })
      return {
        hiddenTurns: hiddenTurnsIn(snap),
        navigationTurns: items.map((item) => item?.turn),
        railTurns: byTurn,
        ledger: sessionId === null ? null : ghostTurnsOf(sessionId),
      }
    }),
  }
}

export function installDiag(ctx: Record<string, unknown>): void {
  try {
    let left = TICKS
    const tick = (): void => {
      const payload = probe(ctx)
      send(payload)
      try {
        localStorage.setItem('__dsqe_diag__', JSON.stringify(payload))
      } catch {
        // second channel only
      }
    }
    const timer = window.setInterval(() => {
      left -= 1
      if (left <= 0) window.clearInterval(timer)
      tick()
    }, TICK_MS)
    tick()
  } catch {
    // diagnostic only: a host without timers just skips it
  }
}
