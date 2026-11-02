/** Minimal shapes of the cordis client context this plugin touches. */

export interface SlotDefinition {
  name: string
  id?: string
  key?: string
  order?: number
  priority?: number
  locale?: string
}

export interface SlotEntryInspection {
  options?: SlotDefinition
  component?: unknown
}

export interface LocaleService {
  register(ns: string, dicts: Record<string, Record<string, string>>): unknown
  register(ns: string, id: string, dict: Record<string, string>): unknown
  bind(ns: string): (key: string, params?: Record<string, unknown>) => string
  getSnapshot(): { locales: { id: string }[]; revision: number }
  getLocale(): { active: string }
  subscribe(fn: () => void): () => void
}

export interface SlotsService {
  inject(name: string, register: () => void): unknown
  register(def: SlotDefinition, component: unknown): unknown
  entries?(name: string): readonly SlotEntryInspection[]
}

export interface ClientContext {
  effect(fn: () => unknown, label: string): unknown
  slots: SlotsService
  locale: LocaleService
  /** Resolve another host service by name (e.g. `sessions`, `uiConversation`). */
  get?(name: string): unknown
}

/** Props of the host `conversation.chat.node` views this plugin replaces. */
export interface UserMessageProps {
  node: {
    data?: {
      content?: unknown
      time?: number
      /** Log seq of the message (used by the ↶ withdraw action). */
      seq?: number
    } & Record<string, unknown>
  } & Record<string, unknown>
  hostNodeOf?: () => unknown
  [key: string]: unknown
}
