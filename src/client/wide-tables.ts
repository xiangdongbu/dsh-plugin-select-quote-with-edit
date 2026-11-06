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
 * 所以这里按**实测像素**收口：包装层与表格都钉成正文列的像素宽度（百分比在这
 * 个盒子上不可靠——`width:100%` 曾经落到一个更窄的包含块上，把表格压成
 * min-content、每列只剩几个字符宽）。宽度变了（换窗口尺寸、换会话、流式追加行）
 * 就重算：rAF 合帧 + 首帧后再补算两次（排版常在首帧之后才稳定）。
 */
const WIDE = '.md-table-wide'
const APPLIED = 'dsqeTableWidth'

/** 正文列宽度：markdown 根 > 父级 > 消息行；拿不到可信值返回 0。 */
function columnWidthOf(wrapper: HTMLElement): number {
  const candidates: (HTMLElement | null)[] = [
    wrapper.closest<HTMLElement>('[class*="markdown"]'),
    wrapper.parentElement,
    wrapper.closest<HTMLElement>('[data-chat-flow-key]'),
  ]
  for (const candidate of candidates) {
    if (candidate === null) continue
    const width = Math.floor(candidate.getBoundingClientRect().width)
    // 太窄（还在排版）或比视口还宽（不是正文列）都不采用
    if (width < 240 || width > window.innerWidth) continue
    return width
  }
  return 0
}

function clamp(wrapper: HTMLElement): void {
  const width = columnWidthOf(wrapper)
  if (width === 0) return
  const table = wrapper.querySelector('table')
  if (!(table instanceof HTMLElement)) return

  if (wrapper.dataset[APPLIED] !== String(width)) {
    wrapper.dataset[APPLIED] = String(width)
    for (const [property, value] of [
      ['width', `${width}px`],
      ['max-width', `${width}px`],
      ['min-width', `${width}px`],
      ['box-sizing', 'border-box'],
      ['padding', '0'],
      ['margin', '0'],
      ['display', 'block'],
      ['overflow', 'visible'],
    ] as const) {
      wrapper.style.setProperty(property, value, 'important')
    }
    table.style.setProperty('width', `${width}px`, 'important')
    table.style.setProperty('min-width', `${width}px`, 'important')
    table.style.setProperty('max-width', `${width}px`, 'important')
  }

  // 最后一步按几何对齐：不管宿主包装层里夹了什么（内联块、占位、边距），
  // 直接把表格左边缘挪到包装层（= 正文列）的左边缘。用 margin-left 负值抵消，
  // 不做 DOM 搬迁——移动 React 托管的节点会在卸载时炸掉宿主视图。
  const column =
    wrapper.closest<HTMLElement>('[class*="markdown"]') ??
    wrapper.parentElement ??
    wrapper
  const offset = Math.round(
    column.getBoundingClientRect().left - table.getBoundingClientRect().left,
  )
  const current = Number.parseFloat(table.style.marginLeft || '0')
  if (Math.abs(offset) > 1 && current !== offset) {
    table.style.setProperty('margin-left', `${offset}px`, 'important')
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
    // 用 setTimeout 而不是 rAF：窗口不可见/被遮挡时 rAF 会暂停，表格就永远收不
    // 了口（切会话时常见）。setTimeout 最差也只是被节流到 1s。
    const schedule = (): void => {
      if (frame !== 0) return
      frame = window.setTimeout(() => {
        frame = 0
        run()
      }, 0)
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
    // 首帧之后再补两次：会话内容常在布局稳定后才算出正文列宽度。
    const timers = [300, 1200].map((delay) => window.setTimeout(schedule, delay))
    // 兜底巡检：元素被 React 整块替换后不会留下任何线索，只能定期补一次。
    const sweeper = window.setInterval(run, 2000)
    const onVisible = (): void => schedule()
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisible)
      window.clearInterval(sweeper)
      if (frame !== 0) window.clearTimeout(frame)
      for (const timer of timers) window.clearTimeout(timer)
    }
  } catch {
    return () => {}
  }
}
