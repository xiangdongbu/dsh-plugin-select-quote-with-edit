/**
 * 正文宽表格收口（宿主 markdown）。
 *
 * 为什么不用纯 CSS：宿主给宽表格的包装层 `._tableScroll_xxx.md-table-wide` 只有
 * `max-width: 100%`，可它实际会**跑出父级**——实测（0.7.21 采样，视口 1863）：
 *
 *   表格 1130 / 包装层 1512 / 父级(正文列) 748
 *
 * 包装层比父级宽一倍，说明它并不按普通块级流排（是个不收缩的 flex/定位盒），
 * 于是 `max-width: 100%` 与 `table { width: 100% }` 都落不到正文列上：表格连
 * 容器一起溢出、而容器自己的 scrollWidth == clientWidth，连横向滚动都没有。
 *
 * 所以这里按**实测像素**收口：拿最近的正文列（markdown 根 / 消息行）的实际
 * 宽度，把包装层钉成这个宽度，再让表格 100% 铺在里面。宽度变了（换窗口尺寸、
 * 换会话、流式追加行）就重算——用 rAF 合帧 + 记录已应用的宽度，避免抖动。
 */
const WIDE = '.md-table-wide'
const APPLIED = 'dsqeTableWidth'

/** 正文列：优先父级（markdown 根），退到消息行。 */
function columnWidthOf(wrapper: HTMLElement): number {
  const anchor =
    wrapper.parentElement instanceof HTMLElement
      ? wrapper.parentElement
      : wrapper.closest<HTMLElement>('[data-chat-flow-key]')
  if (anchor === null) return 0
  const width = Math.floor(anchor.getBoundingClientRect().width)
  // 父级还没排版（0）或明显不是正文列（比视口还宽）时放弃，别把表格钉错。
  if (width <= 0 || width > window.innerWidth) return 0
  return width
}

function clamp(wrapper: HTMLElement): void {
  const width = columnWidthOf(wrapper)
  if (width === 0) return
  if (wrapper.dataset[APPLIED] === String(width)) return
  wrapper.dataset[APPLIED] = String(width)
  wrapper.style.setProperty('width', `${width}px`, 'important')
  wrapper.style.setProperty('max-width', `${width}px`, 'important')
  wrapper.style.setProperty('box-sizing', 'border-box', 'important')
  wrapper.style.setProperty('overflow-x', 'auto', 'important')
  const table = wrapper.querySelector('table')
  if (table instanceof HTMLElement) {
    table.style.setProperty('width', '100%', 'important')
    table.style.setProperty('max-width', '100%', 'important')
  }
}

/**
 * 常驻：DOM 变化（新表格、流式追加、切会话）与窗口尺寸变化时重新收口。
 * 返回 teardown。
 */
export function watchWideTables(): () => void {
  try {
    let frame = 0
    const run = (): void => {
      frame = 0
      for (const wrapper of Array.from(document.querySelectorAll<HTMLElement>(WIDE))) {
        try {
          clamp(wrapper)
        } catch {
          // 单张表失败不影响其它
        }
      }
    }
    const schedule = (): void => {
      if (frame === 0) frame = window.requestAnimationFrame(run)
    }

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target
        if (target instanceof Element && target.closest(WIDE) !== null) {
          schedule()
          return
        }
        for (const node of Array.from(record.addedNodes)) {
          if (
            node instanceof Element &&
            (node.matches(WIDE) || node.querySelector(WIDE) !== null)
          ) {
            schedule()
            return
          }
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })

    const onResize = (): void => schedule()
    window.addEventListener('resize', onResize)
    schedule()

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onResize)
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  } catch {
    return () => {}
  }
}
