/**
 * Pending quotes, partitioned by session and persisted to localStorage under
 * `dsh.select-quote-with-edit.quotes.<sessionId>` — the same shape as the host
 * composer draft, so refresh / restart / session switch behave alike.
 *
 * Quotes with no bound session live in an in-memory `pending` bucket only.
 */

import type { Quote } from './protocol.ts'

const STORAGE_PREFIX = 'dsh.select-quote-with-edit.quotes.'
const MAX_SESSIONS = 20
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

interface StoredPayload {
  v: 1
  updatedAt: number
  items: { id: string; text: string; long?: true }[]
}

function storageAvailable(): boolean {
  try {
    const probe = '__dsqe_probe__'
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return true
  } catch {
    return false
  }
}

function loadFromStorage(sessionId: string): Quote[] {
  if (!storageAvailable()) return []
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + sessionId)
    if (!raw) return []
    const payload = JSON.parse(raw) as Partial<StoredPayload> | null
    if (!payload || !Array.isArray(payload.items)) return []
    const quotes: Quote[] = []
    for (const item of payload.items) {
      if (!item || typeof item.id !== 'string' || typeof item.text !== 'string') continue
      const text = item.text.trim()
      if (!text) continue
      quotes.push({ id: item.id, text, ...(item.long ? { long: true } : {}) })
    }
    return quotes
  } catch {
    return []
  }
}

function writeToStorage(sessionId: string, quotes: readonly Quote[]): void {
  if (!storageAvailable()) return
  try {
    const payload: StoredPayload = {
      v: 1,
      updatedAt: Date.now(),
      items: quotes.map((quote) => ({
        id: quote.id,
        text: quote.text,
        ...(quote.long ? { long: true as const } : {}),
      })),
    }
    window.localStorage.setItem(STORAGE_PREFIX + sessionId, JSON.stringify(payload))
  } catch {
    // Quota / private mode: keep going with the in-memory copy.
  }
}

function removeFromStorage(sessionId: string): void {
  if (!storageAvailable()) return
  try {
    window.localStorage.removeItem(STORAGE_PREFIX + sessionId)
  } catch {
    // ignore
  }
}

/** Drop sessions older than 7 days; keep only the 20 most recent writes. */
function pruneStorage(): void {
  if (!storageAvailable()) return
  try {
    const entries: { key: string; updatedAt: number }[] = []
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index)
      if (!key || !key.startsWith(STORAGE_PREFIX)) continue
      let updatedAt = 0
      try {
        const payload = JSON.parse(window.localStorage.getItem(key) ?? '') as Partial<StoredPayload> | null
        updatedAt = typeof payload?.updatedAt === 'number' ? payload.updatedAt : 0
      } catch {
        updatedAt = 0
      }
      entries.push({ key, updatedAt })
    }
    const now = Date.now()
    let alive = entries.filter((entry) => now - entry.updatedAt <= MAX_AGE_MS)
    const expired = entries.filter((entry) => now - entry.updatedAt > MAX_AGE_MS)
    alive.sort((a, b) => b.updatedAt - a.updatedAt)
    const overflow = alive.slice(MAX_SESSIONS)
    for (const entry of [...expired, ...overflow]) window.localStorage.removeItem(entry.key)
  } catch {
    // ignore
  }
}

let sessionId: string | null = null
const bySession = new Map<string, Quote[]>()
let pending: Quote[] = []
const listeners = new Set<() => void>()

function current(): Quote[] {
  if (sessionId === null) return pending
  return bySession.get(sessionId) ?? []
}

function notify(): void {
  for (const listener of listeners) listener()
}

function setQuotes(list: Quote[]): void {
  if (sessionId === null) {
    pending = list
    notify()
    return
  }
  if (list.length === 0) {
    bySession.delete(sessionId)
    removeFromStorage(sessionId)
  } else {
    bySession.set(sessionId, list)
    writeToStorage(sessionId, list)
    pruneStorage()
  }
  notify()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getQuotes(): readonly Quote[] {
  return current()
}

/**
 * Bind the store to a session. Called whenever the composer overlay mounts or
 * switches sessions; reads persisted quotes for sessions the store has not
 * seen yet (the in-memory copy, if any, wins — it can only be newer).
 */
export function bindSession(id: string | undefined): void {
  const next = typeof id === 'string' && id.length > 0 ? id : null
  if (next === sessionId) return
  sessionId = next
  if (sessionId !== null && !bySession.has(sessionId)) {
    bySession.set(sessionId, loadFromStorage(sessionId))
  }
  notify()
}

export function addQuote(text: string, options?: { long?: boolean }): Quote | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  // One chip per distinct content: a repeated add (paste the same long text
  // twice, a payload that carries a quote again) must return the existing
  // quote instead of minting a twin. Without this, repeated pastes used to
  // pile up identical quotes that all materialized at once as a wall of
  // duplicate chips.
  const existing = current().find(
    (quote) => quote.text === trimmed && (quote.long === true) === (options?.long === true),
  )
  if (existing) return existing
  const quote: Quote = {
    id: `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    text: trimmed,
    ...(options?.long ? { long: true } : {}),
  }
  setQuotes([...current(), quote])
  return quote
}

export function removeQuote(id: string): void {
  const list = current()
  if (!list.some((quote) => quote.id === id)) return
  setQuotes(list.filter((quote) => quote.id !== id))
}

export function clearQuotes(): void {
  if (current().length === 0) return
  setQuotes([])
}

/** Replace the whole list — the rewind-restore path. */
export function replaceQuotes(quotes: readonly Quote[]): void {
  setQuotes([...quotes])
}

/**
 * Adopt storage writes from OTHER tabs/windows (a `storage` event never fires
 * in the tab that wrote it, so this cannot react to our own writes). The
 * affected partition is replaced wholesale — last-write-wins: every local
 * change is written through immediately, so memory is only ever older than
 * storage when the event arrives.
 */
export function watchStorageAdoption(): () => void {
  if (typeof window === 'undefined' || !storageAvailable()) return () => {}
  const onStorage = (event: StorageEvent): void => {
    if (event.storageArea !== null && event.storageArea !== window.localStorage) return
    if (event.key === null) {
      // localStorage.clear(): re-read every partition this tab holds.
      for (const id of Array.from(bySession.keys())) {
        const stored = loadFromStorage(id)
        if (stored.length === 0) bySession.delete(id)
        else bySession.set(id, stored)
      }
      pending = []
      notify()
      return
    }
    if (!event.key.startsWith(STORAGE_PREFIX)) return
    const id = event.key.slice(STORAGE_PREFIX.length)
    if (!id) return
    const stored = loadFromStorage(id)
    if (stored.length === 0) bySession.delete(id)
    else bySession.set(id, stored)
    if (id === sessionId) notify()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener('storage', onStorage)
  }
}
