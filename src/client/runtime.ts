/**
 * Cross-slot runtime: the composer bridge publishes `inputActions` here so
 * the plain-DOM editor (chrome.ts) can write the edited text into the
 * resident composer and submit it as a new message. The panel also exposes
 * `markFolded` — the editor's write-back must set the fold guard, or the
 * rewind-restore path would read the just-composed protocol block out of the
 * draft and turn it back into pending quotes (racing the send).
 */

export interface ComposerActions {
  readonly setDraft: (text: string) => void
}

export const runtime: {
  inputActions: ComposerActions | null
  markFolded: (() => void) | null
} = {
  inputActions: null,
  markFolded: null,
}
