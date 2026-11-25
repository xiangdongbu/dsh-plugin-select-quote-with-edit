/**
 * 发送手势里「草稿被折成 wire 文本」那一瞬的遮罩。
 *
 * 背景：引用和文件胶囊在草稿里是 chip + 纯文本，真正发给模型的是
 * `composeMessage` 合成后的整段 wire 文本（`Quoted references:` 头部 +
 * `<dsh-quotes>` 里一整段 JSON）。宿主的发送入口只认草稿内容，所以插件只能在
 * 发送手势里先用 `setDraft(wire)` 写进去、再让宿主自己提交 —— 而这两步之间
 * 宿主会重渲染一次输入框，浏览器绘制出来就是一大段 JSON 闪一下。
 *
 * 遮的是**输入框的可见性**，不是内容：`visibility` 保留布局，但布局本身也得夹住
 * —— wire 文本比用户敲的长得多，编辑区会按内容自动长高，发送瞬间会弹出一张几乎
 * 空白的高卡片。所以这里同时把编辑区的 `max-height` 冻在当前高度，撤销时逐字还原。
 * 一旦宿主把草稿清掉（正常发送）或用户改了草稿，{@link revealComposedDraft}
 * 立刻撤掉；如果宿主既不清也不提交（比如发送被拒绝），{@link MAX_MS} 兜底，
 * 宁可见到 wire 文本也不能让输入框一直空着。
 */

import { composerScrollAreaOf } from './composer-resize.ts'

const CARD = '[data-composer-card]'

/** 遮罩属性；样式在 `styles.ts`（`[data-dsqe-folding]`）。 */
export const FOLDING_ATTR = 'data-dsqe-folding'

/** 最长遮罩时间，超过就放出来（发送失败时用户还要能看见并重试）。 */
const MAX_MS = 1200

let timer: ReturnType<typeof setTimeout> | null = null

/** 遮罩期间被冻住高度的元素，以及它原来的内联样式（撤销时逐字还原）。 */
let frozen: { element: HTMLElement; maxHeight: string; overflow: string } | null = null

/** 遮住输入框，直到 {@link revealComposedDraft} 或超时。 */
export function concealComposedDraft(ms = MAX_MS): void {
  if (typeof document === 'undefined') return
  const card = document.querySelector(CARD)
  if (card instanceof HTMLElement) {
    // 高度必须先冻住：wire 文本比用户输入长得多（引用块 + JSON），
    // 输入框会按内容自动长高 —— visibility 只藏内容、不藏布局，结果就是
    // 发送瞬间弹出一张几乎空白的高卡片。冻的是**编辑区**（不是整张卡，
    // 否则底部工具栏会被裁掉），遮罩撤掉时一起还原。
    const area = composerScrollAreaOf(card) ?? card.querySelector('[data-lexical-editor="true"]')
    if (area instanceof HTMLElement) {
      const height = Math.round(area.getBoundingClientRect().height)
      if (height > 0) {
        frozen = { element: area, maxHeight: area.style.maxHeight, overflow: area.style.overflowY }
        area.style.setProperty('max-height', `${height}px`)
        area.style.setProperty('overflow-y', 'hidden')
      }
    }
    card.setAttribute(FOLDING_ATTR, '1')
  }
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
  if (frozen !== null) {
    frozen.element.style.removeProperty('max-height')
    frozen.element.style.removeProperty('overflow-y')
    if (frozen.maxHeight !== '') frozen.element.style.maxHeight = frozen.maxHeight
    if (frozen.overflow !== '') frozen.element.style.overflowY = frozen.overflow
    frozen = null
  }
}
