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
  if (wrapper.dataset[APPLIED] === String(width)) return
  wrapper.dataset[APPLIED] = String(width)
  for (const [property, value] of [
    ['width', `${width}px`],
    ['max-width', `${width}px`],
    ['min-width', `${width}px`],
    ['box-sizing', 'border-box'],
    ['overflow-x', 'auto'],
  ] as const) {
    wrapper.style.setProperty(property, value, 'important')
  }
  // 宿主正文是 `display: flex` 的容器（XNZzAa_body），宽表格作为 flex 项会被
  // 交叉轴对齐到右边——宽度钉住后它就整体往左溢出去了。这里显式左对齐。
  wrapper.style.setProperty('align-self', 'flex-start', 'important')
  wrapper.style.setProperty('margin-left', '0', 'important')
  wrapper.style.setProperty('margin-right', 'auto', 'important')
  const table = wrapper.querySelector('table')
  if (table instanceof HTMLElement) {
    // 像素而非 100%：百分比会落到更窄的包含块上，把表格压成 min-content。
    table.style.setProperty('width', `${width}px`, 'important')
    table.style.setProperty('min-width', `${width}px`, 'important')
    table.style.setProperty('max-width', `${width}px`, 'important')
  }
  // 之前溢出时被滚动过的话，回到左端，否则看起来还是「偏出左边」。
  if (wrapper.scrollLeft !== 0) wrapper.scrollLeft = 0
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

/**
 * 临时诊断（0.7.23，确认后删）：把宽表格这条盒模型链写进
 * localStorage['dsqe-table-metrics']，用于核对「表格到底多宽、链上谁在约束」。
 */
export function recordTableSnapshot(): void {
  try {
    const describe = (element: Element | null): string => {
      if (!(element instanceof HTMLElement)) return 'null'
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      const cls = (element.className || '').toString().split(/\s+/u).slice(0, 2).join('.')
      return (
        `${element.tagName.toLowerCase()}${cls === '' ? '' : `.${cls}`}` +
        `[x=${Math.round(rect.left)},w=${Math.round(rect.width)},d=${style.display},align=${style.alignItems},as=${style.alignSelf}]`
      )
    }
    let left = 3
    const tick = (): void => {
      left -= 1
      if (left <= 0) window.clearInterval(timer)
      const wrappers = Array.from(document.querySelectorAll<HTMLElement>(WIDE)).slice(0, 3)
      if (wrappers.length === 0) return
      const tables = wrappers.map((wrapper) => {
        const table = wrapper.querySelector('table')
        const chain: string[] = []
        let node: Element | null = wrapper
        for (let i = 0; i < 5 && node !== null; i += 1) {
          chain.push(describe(node))
          node = node.parentElement
        }
        const rect = wrapper.getBoundingClientRect()
        return {
          applied: wrapper.dataset[APPLIED] ?? null,
          wrapper: { x: Math.round(rect.left), w: Math.round(rect.width), styleWidth: wrapper.style.width },
          scrollLeft: wrapper.scrollLeft,
          tableWidth: table === null ? null : Math.round(table.getBoundingClientRect().width),
          tableStyleWidth: table instanceof HTMLElement ? table.style.width : null,
          chain,
        }
      })
      window.localStorage.setItem('dsqe-table-metrics', JSON.stringify({ tables, viewport: window.innerWidth }))
    }
    const timer = window.setInterval(tick, 1200)
    tick()
  } catch {
    // 诊断用
  }
}
