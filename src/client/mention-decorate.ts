/**
 * 用户消息里的 `@绝对路径` → 胶囊（DOM 层，不依赖任何宿主渲染链路）。
 *
 * 为什么不用宿主的机制：正文胶囊本可以靠两条宿主能力实现 ——
 * `uiConversation.userText.register(rule)` 把 `@/abs/path` 切成节点，再由
 * `conversation.user.text.node` 上 key 为 `dsqe-file` 的渲染器画出来。实测
 * 两条都不可靠：规则注册成功、节点也切出来了，渲染器仍然回落到原文；而
 * `dsh-code-pill` 还会遍历 `conversation.chat.node` 的条目**直接改写**
 * `entry.component`，让「委托给宿主视图」这条退路也可能指向包装器。
 *
 * 所以这里退到最外层：消息渲染完之后，直接把用户行里的 `@/path` 文本换成
 * 胶囊元素。谁渲染的这一行都无所谓，连历史消息也会一起补上。
 */
import { displayName, mentionsInText } from './file-mention.ts'
import { t } from './i18n.ts'
import { ensureStyles } from './styles.ts'

export interface MentionDecorateDeps {
  /** 在右侧编辑器打开一个绝对路径；返回 false = 打不开。 */
  openFile(path: string): boolean
  /** 失败时的轻提示。 */
  hint(text: string): void
}

/** 用户消息行：我们的标记、或宿主自己的行属性。 */
const ROW_SELECTOR = '[data-dsqe-user="true"], [data-chat-flow-kind="user"]'

/** 这些地方一律不碰：已经处理过的胶囊、代码、链接、编辑器。 */
const SKIP_SELECTOR =
  'pre, code, a, textarea, input, script, style, [contenteditable="true"], [data-dsqe-filechip], [data-dsqe-decorated]'

const DECORATED = 'data-dsqe-decorated'

const FILE_ICON =
  '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.2 2.6h4.4l3.2 3.2v7.6H4.2z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M8.6 2.6v3.2h3.2" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>'

const FOLDER_ICON =
  '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.2 4.4c0-.6.5-1.1 1.1-1.1h2.5l1.3 1.5h5.6c.6 0 1.1.5 1.1 1.1v5.7c0 .6-.5 1.1-1.1 1.1H3.3c-.6 0-1.1-.5-1.1-1.1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>'

function iconSpan(svg: string): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = 'dsqe_fileChipIcon'
  span.setAttribute('aria-hidden', 'true')
  span.innerHTML = svg
  return span
}

function nameSpan(text: string): HTMLSpanElement {
  const span = document.createElement('span')
  span.className = 'dsqe_fileChipName'
  span.textContent = text
  return span
}

/** 造一颗胶囊元素（与 React 版 `<FileRefChip>` 同一批类名）。 */
function chipElement(path: string, directory: boolean, deps: MentionDecorateDeps): HTMLElement {
  if (directory) {
    const chip = document.createElement('span')
    chip.className = 'dsqe_dirChip'
    chip.dataset.dsqeFilechip = 'dir'
    chip.title = `${path}/ · ${t('filechip.folder')}`
    chip.append(iconSpan(FOLDER_ICON), nameSpan(`${path}/`))
    return chip
  }
  const chip = document.createElement('span')
  chip.className = 'dsqe_fileChip'
  chip.dataset.dsqeFilechip = 'file'
  chip.setAttribute('role', 'link')
  chip.tabIndex = 0
  chip.title = `${path} · ${t('filechip.open')}`
  chip.append(iconSpan(FILE_ICON), nameSpan(displayName(path, false)))
  const open = (event: Event): void => {
    event.preventDefault()
    event.stopPropagation()
    if (!deps.openFile(path)) deps.hint(t('filelink.unavailable'))
  }
  chip.addEventListener('click', open)
  chip.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') open(event)
  })
  return chip
}

/** 把一个文本节点里的所有 `@/路径` 换成胶囊；返回是否改动过。 */
function decorateTextNode(node: Text, deps: MentionDecorateDeps): boolean {
  const value = node.nodeValue ?? ''
  if (!value.includes('@')) return false
  const mentions = mentionsInText(value)
  if (mentions.length === 0) return false
  const parent = node.parentNode
  if (parent === null) return false

  const fragment = document.createDocumentFragment()
  let cursor = 0
  for (const mention of mentions) {
    if (mention.start > cursor) {
      fragment.appendChild(document.createTextNode(value.slice(cursor, mention.start)))
    }
    fragment.appendChild(chipElement(mention.path, mention.directory, deps))
    cursor = mention.end
  }
  if (cursor < value.length) fragment.appendChild(document.createTextNode(value.slice(cursor)))
  parent.replaceChild(fragment, node)
  return true
}

/** 遍历一行用户消息里的文本节点（遇到跳过区就整枝放弃）。 */
function decorateRow(row: Element, deps: MentionDecorateDeps): boolean {
  if (row.getAttribute(DECORATED) === '1') return false
  // 没有 `@` 的行直接放过：这是每 120ms 巡检的主要开销来源。
  if (!(row.textContent ?? '').includes('@')) return false
  const nodes: Text[] = []
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
    acceptNode: (candidate) => {
      const parent = (candidate as Text).parentElement
      if (parent === null) return NodeFilter.FILTER_REJECT
      if (parent.closest(SKIP_SELECTOR) !== null) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  for (let current = walker.nextNode(); current !== null; current = walker.nextNode()) {
    nodes.push(current as Text)
  }
  let touched = false
  for (const node of nodes) if (decorateTextNode(node, deps)) touched = true
  if (touched) row.setAttribute(DECORATED, '1')
  return touched
}

/**
 * 开始把用户消息里的 `@/路径` 画成胶囊。
 *
 * 用 `MutationObserver` 跟着新消息 / 切换会话走；`setTimeout` 去抖（宿主在
 * 窗口不可见时会暂停 rAF，见宽表格那段的教训）。已处理的行打上
 * `data-dsqe-decorated`，我们自己的改动不会引起自我循环。
 */
export function watchMentionChips(deps: MentionDecorateDeps): () => void {
  if (typeof document === 'undefined') return () => {}
  ensureStyles()
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const sweep = (): void => {
    if (stopped) return
    const rows = document.querySelectorAll(ROW_SELECTOR)
    for (const row of Array.from(rows)) decorateRow(row, deps)
  }

  const schedule = (): void => {
    if (stopped || timer !== null) return
    timer = setTimeout(() => {
      timer = null
      sweep()
    }, 120)
  }

  sweep()
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target as Element | null
      if (target !== null && typeof target.closest === 'function' && target.closest('[data-dsqe-filechip]') !== null) {
        continue
      }
      schedule()
      return
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  // 兜底巡检：有的会话切换只改文本不改结构。
  const sweeper = setInterval(sweep, 2000)

  return () => {
    stopped = true
    observer.disconnect()
    clearInterval(sweeper)
    if (timer !== null) clearTimeout(timer)
  }
}
