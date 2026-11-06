/**
 * The message attachment loader the host hands to chat node views.
 *
 * Shape is unstable in practice: it may answer with a URL string, with a
 * promise for a blob/object URL, or with `undefined` when the attachment is not
 * readable yet. Our own thumbnails accept all three; the host's own
 * `MessageImage` does not — it runs `load(attachment).then(...)`, so anything
 * that is not thenable throws, and a *throwing* slot entry is retired by the
 * registry (`reportEntryError(..., { abdicate: true })`). Once
 * `conversation.chat.user.images` has been retired, every user message in that
 * session renders text without images until the app is reloaded.
 *
 * Passing the host a normalized loader (always a promise, never throwing)
 * keeps that pipeline alive.
 */
export type ImageLoader = (attachment: unknown) => string | undefined | Promise<string | undefined>

/**
 * One wrapper per underlying loader. The host re-runs its image effect when
 * the `load` prop changes identity, so handing it a fresh function on every
 * render would reload every thumbnail (and flicker). Keyed by the original
 * function, so the wrapper is as stable as the host's own loader.
 */
const wrappers = new WeakMap<ImageLoader, (attachment: unknown) => Promise<string | undefined>>()

export function normalizeLoader(
  loadImage: ImageLoader | undefined,
): ((attachment: unknown) => Promise<string | undefined>) | undefined {
  if (typeof loadImage !== 'function') return undefined
  const cached = wrappers.get(loadImage)
  if (cached !== undefined) return cached
  const loader = (attachment: unknown): Promise<string | undefined> => {
    try {
      return Promise.resolve(loadImage(attachment))
    } catch {
      return Promise.resolve(undefined)
    }
  }
  // `peek` is the host's synchronous fast path for the first paint; keep any
  // side properties the original loader carries.
  for (const key of Object.keys(loadImage)) {
    const value = (loadImage as unknown as Record<string, unknown>)[key]
    ;(loader as unknown as Record<string, unknown>)[key] = value
  }
  wrappers.set(loadImage, loader)
  return loader
}
