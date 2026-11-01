/**
 * Node half of dsh-plugin-select-quote-with-edit.
 *
 * The product surface is the browser client module (`./client`). This entry
 * only keeps the package mounted in the Loader so the Host can discover the
 * `dsh.client` declaration in package.json. The plugin has no settings, so no
 * `Config` schema is exported.
 */

export const name = 'dsh-plugin-select-quote-with-edit'

export function apply(_ctx: unknown): void {
  // Client-only plugin: nothing to do on the Host side.
}
