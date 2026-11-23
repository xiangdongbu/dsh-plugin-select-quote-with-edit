/**
 * 发送手势里「草稿被折成 wire 文本」那一瞬的遮罩。
 *
 * 背景：引用和文件胶囊在草稿里是 chip + 纯文本，真正发给模型的是
 * `composeMessage` 合成后的整段 wire 文本（`Quoted references:` 头部 +
 * `<dsh-quotes>` 里一整段 JSON）。宿主的发送入口只认草稿内容，所以插件只能在
 * 发送手势里先用 `setDraft(wire)` 写进去、再让宿主自己提交 —— 而这两步之间
 * 宿主会重渲染一次输入框，浏览器绘制出来就是一大段 JSON 闪一下。
 *
 * 遮的是**输入框的可见性**，不是内容：`visibility` 保留布局高度，卡片不跳；
 * 一旦宿主把草稿清掉（正常发送）或用户改了草稿，{@link revealComposedDraft}
 * 立刻撤掉；如果宿主既不清也不提交（比如发送被拒绝），{@link MAX_MS} 兜底，
 * 宁可见到 wire 文本也不能让输入框一直空着。
 */

const CARD = '[data-composer-card]'

/** 遮罩属性；样式在 `styles.ts`（`[data-dsqe-folding]`）。 */
export const FOLDING_ATTR = 'data-dsqe-folding'

/** 最长遮罩时间，超过就放出来（发送失败时用户还要能看见并重试）。 */
const MAX_MS = 1200

let timer: ReturnType<typeof setTimeout> | null = null

/** 遮住输入框，直到 {@link revealComposedDraft} 或超时。 */
export function concealComposedDraft(ms = MAX_MS): void {
  if (typeof document === 'undefined') return
  const card = document.querySelector(CARD)
  if (card !== null) card.setAttribute(FOLDING_ATTR, '1')
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(revealComposedDraft, ms)
}

/** 撤掉遮罩（幂等）。 */
export function revealComposedDraft(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  if (typeof document === 'undefined') return
  for (const element of Array.from(document.querySelectorAll(`[${FOLDING_ATTR}]`))) {
    element.removeAttribute(FOLDING_ATTR)
  }
}
