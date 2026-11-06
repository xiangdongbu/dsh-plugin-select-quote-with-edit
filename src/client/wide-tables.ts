/**
 * 临时诊断（0.7.21，用完即删）：把正文里「宽表格」的盒模型写进 localStorage，
 * 这样不用开 devtools 也能知道表格到底是宽了还是容器宽了。
 *
 * 记录内容：table / wrapper / 最近的 markdown 根 / 消息行的实际宽度，
 * wrapper 的 clientWidth 与 scrollWidth、computed overflow-x、视口宽度。
 * 只跑 6 次（1.5s 一次）就停，只写 localStorage['dsqe-table-metrics']。
 */
const KEY = 'dsqe-table-metrics'
const TICKS = 6
const TICK_MS = 1500

export function recordWideTableMetrics(): void {
  try {
    let timer: number | undefined
    let left = TICKS
    const width = (element: Element | null): number | null =>
      element === null ? null : Math.round(element.getBoundingClientRect().width)

    const tick = (): void => {
      left -= 1
      if (left <= 0 && timer !== undefined) window.clearInterval(timer)
      const wrappers = Array.from(document.querySelectorAll<HTMLElement>('.md-table-wide'))
      if (wrappers.length === 0) return
      const seen = wrappers.slice(0, 4).map((wrapper) => {
        const table = wrapper.querySelector('table')
        const markdown = wrapper.closest<HTMLElement>('[class*="markdown"]')
        const row = wrapper.closest<HTMLElement>('[data-chat-flow-key]')
        return {
          table: width(table),
          parent: width(wrapper.parentElement),
          wrapper: width(wrapper),
          wrapperClient: wrapper.clientWidth,
          wrapperScroll: wrapper.scrollWidth,
          overflowX: getComputedStyle(wrapper).overflowX,
          markdown: width(markdown),
          markdownClient: markdown?.clientWidth ?? null,
          row: width(row),
          viewport: window.innerWidth,
        }
      })
      window.localStorage.setItem(KEY, JSON.stringify(seen))
    }

    timer = window.setInterval(tick, TICK_MS)
    tick()
  } catch {
    // 诊断用：任何环境不支持都直接跳过
  }
}
