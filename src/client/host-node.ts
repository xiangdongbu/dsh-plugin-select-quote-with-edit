import type { SlotEntryInspection } from './context.d.ts'

/**
 * The delegated view: another plugin's node view or the host's own.
 * `kind` decides whether the `node` prop may be rewritten (see user-node).
 */
export interface Delegate {
  component: unknown
  kind: 'plugin' | 'host'
}

const HOST_NODE_NAME = 'UserMessageNodeView'

/** Component name across memo/forwardRef/plain function shapes. */
export function componentName(component: unknown): string | undefined {
  const candidate = component as
    | {
        type?: { name?: string }
        render?: { name?: string }
        name?: string
        displayName?: string
      }
    | undefined
  return (
    candidate?.type?.name ??
    candidate?.render?.name ??
    candidate?.name ??
    candidate?.displayName
  )
}

/**
 * The delegate registered for `key`, or undefined when it cannot be
 * identified safely. Plugin views (negative priority, lowest first) win over
 * the host; the host view is identified by component name. More than one
 * ambiguous candidate with no named host yields undefined — callers show
 * their fallback instead of delegating to an arbitrary wrapper.
 */
export function pickDelegate(
  entries: readonly SlotEntryInspection[],
  self: unknown,
  key: string,
): Delegate | undefined {
  const candidates = entries.filter(
    (entry) =>
      entry.options?.key === key &&
      entry.component !== undefined &&
      entry.component !== self,
  )
  const pluginViews = candidates
    .filter((entry) => typeof entry.options?.priority === 'number' && entry.options.priority < 0)
    .sort((a, b) => (a.options?.priority ?? 0) - (b.options?.priority ?? 0))
  if (pluginViews.length > 0 && pluginViews[0]?.component != null) {
    return { component: pluginViews[0].component, kind: 'plugin' }
  }
  const named = candidates.find((entry) => componentName(entry.component) === HOST_NODE_NAME)
  if (named !== undefined && named.component != null) {
    return { component: named.component, kind: 'host' }
  }
  if (candidates.length === 1 && candidates[0]?.component != null) {
    return { component: candidates[0].component, kind: 'host' }
  }
  return undefined
}
