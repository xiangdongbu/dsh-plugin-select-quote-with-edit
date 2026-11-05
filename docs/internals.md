# dsh-plugin-select-quote-with-edit 实现说明

合并自 `dsh-plugin-select-quote-simple`（划词引用）与 `dsh-plugin-edit`（消息编辑），一个浏览器模块承载两套功能，共享协议、存储、预览面板与消息节点视图。用户文档见 [README](../README.md)。

## 目录结构

```
src/index.ts                     # Node 半：仅保持包挂载
src/client/identity.ts           # 包名 / locale 命名空间
src/client/context.d.ts          # 宿主 Context 最小类型
src/client/protocol.ts           # <dsh-quotes> wire 协议 + U+200B 标记 + 撤回还原
src/client/store.ts              # 按会话待发引用 + localStorage 持久化 + storage 对账
src/client/runtime.ts            # inputActions + markFolded + sessionId/withdraw（撤回）
src/client/i18n.ts               # zh / en 词典（含时间格式模板）
src/client/styles.ts             # 全部 CSS（dsqe- 前缀，深浅两套静态色 + 宿主磨砂 token）
src/client/dom.ts                # composer/选区 DOM 约定、提交手势、剪贴板
src/client/icons.tsx             # React 组件用内联图标
src/client/svg.ts                # 纯 DOM chrome 用的 SVG 字符串
src/client/selection-toolbar.tsx # 划词工具条（shell.overlay）
src/client/composer-panel.tsx    # 输入框行内胶囊编排（光标处插节点）+ 顶部 chip 行兜底 + 标记 + 发送折叠 + 撤回还原
src/client/chip.tsx              # React 引用 chip（顶部行/气泡内，悬停全文预览，长文本胶囊图标）
src/client/inline-chips.ts       # 行内胶囊：宿主 reference-chip 节点的插入 / 存在性订阅 / source 注册（0.7.0+）
src/client/chip-clipboard.ts     # 输入框内复制/剪切：胶囊按 label 内联进剪贴板 + v2 位置载荷（0.7.2+）
src/client/detail.tsx            # 右侧详情（消息胶囊点击打开，模块级 store + 本地抽屉兜底）
src/client/locate.ts             # 「定位原文」：拍平索引 + 反查 Range + 滚动 + 标记状态（无 React）
src/client/source-mark.tsx        # 下划线层（shell.overlay order 90）：Range 的 client rects 叠 fixed 线
src/client/sidebar-tab.tsx       # 原生右侧边栏详情标签页（sidebarRightTabs + openTabIn，JSON 高亮）
src/client/composer-resize.ts    # 输入框顶边 grip 拖拽调高（钳制 + localStorage 持久化，双击复原）
src/client/host-node.ts          # 委托链解析 + Delegate 类型
src/client/registry.ts           # flowKey → {raw, time, seq}（node 视图写入，chrome 读取）
src/client/composer-bridge.tsx   # conversation.input.overlay 桥（inputActions/markFolded/sessionId/withdraw）
src/client/transcript.tsx        # user/steering 节点视图：标记 + 引用气泡 + 委托
src/client/chrome.ts             # 悬停操作行（复制/编辑/撤回，尺寸对齐宿主）+ 内联编辑器（纯 DOM）
src/client/withdraw.ts           # 撤回引擎：解析 seq → /rewind-plugin @seq both → 原文回填
src/client/echo-strip.ts         # 回显/排队预览的协议块剥离
src/client/index.tsx             # 客户端入口
scripts/build.mjs / verify.mjs / build-mock.mjs / serve-mock.mjs / sync-desktop.mjs
test/mock/                       # mock dsh 客户端（含 -10 模拟消息插件，?fakequote=1）
```

## 客户端贡献

| 位置 | 类型 | 说明 |
|---|---|---|
| `shell.overlay` | list slot | 定位下划线层（order 90）+ 划词工具条（order 100）+ 本地详情抽屉兜底（order 110），root 级常驻 |
| `sidebar.right.pane.tab` (+ `.title`) | keyed slot | 原生侧边栏详情标签页正文（`key` = 标签 id，配合 `sidebarRightTabs.register` + `sidebarRight.openTabIn`） |
| `conversation.input.overlay` | list slot | 桥（order 1，发布 inputActions/markFolded）+ 顶部 chip 行（order 20，**仅兜底**；正常走行内胶囊） |
| `conversation.chat.node` | keyed slot | `user` / `steering`（`priority: -20`、`locale: 'chat'`）：标记 + 引用气泡 + 委托 |
| `ctx.locale` | 语言服务 | `register(ns, {zh, en})` + `bind` |
| MutationObserver | effect | 回显/排队预览协议块剥离 |
| window.storage | effect | 跨标签会话分区对账 |

## 关键机制

**1. 一个节点视图承载三套功能（-20 接管）**
user/steering 选举胜出后，视图只输出 `display: contents` 标记（`data-dsqe-user`）：
- layout effect 把 `{raw, time, seq}` 注册进 registry（key = 行的 `data-chat-flow-key`；`seq` 取自 `node.data.seq`，供撤回落位），行加 `dsqe_row`（position: relative，悬停 chrome 与编辑器的定位上下文）；
- 引用消息自绘 chip 气泡（`data-dsqe-quote-bubble`，只渲染「引用 chip + 正文」，不再在下方重复引用全文——top 胶囊已表达引用，悬停 chip 看全文）；普通消息委托宿主 `UserMessageNodeView`（组件名识别，node 原样）；宿主视图缺失时兜底纯文本气泡；
- 引用行加 `dsqe_rowQuote` 恒定预留操作行高度（`calc(28px + font-delta)`），使悬停操作行显示/隐藏不改变布局（不再上下跳动）；
- 其他消息插件视图（负优先级）存在时整行委托给它（共存），标记与注册照常。

**2. 划词引用链**（继承自 select-quote-simple，原样保留）
选区准入（起止都在 `[data-chat-flow-key]` 且不在 composer）→ 工具条浮出 → 「添加到对话」进 store（按会话持久化）→ 输入框**行内胶囊**（插在光标处，见 §13；U+200B 保发送键）→ 发送手势捕获阶段折叠成协议块 → 回显剥离 → 气泡内 chip 回显 → 撤回还原。

**3. 消息编辑链**（继承自 dsh-plugin-edit）
悬停标记行 → 普通消息把「编辑」+「撤回」注入宿主自己的操作行（`MessageIconActions` 的 `data-clock="start"` 根元素，编辑在前、撤回紧接其后，React 重建后由 pointerover/pointermove 重注入）；这两个按钮是**每行各一份的常驻元素**（`ensureHostButtons` 在 node 视图挂载时即注入），放在宿主自己的 `[data-clock]` 容器内，因此**跟随复制按钮的悬停显隐过渡一起出现/淡出**，不由插件单独增删；引用气泡无宿主行，退回插件自绘操作行（时间/复制/编辑/撤回，尺寸与间距对齐宿主 `MessageIconActions`：28px 按钮 / 15px 图标 / 8px gap / 13px 时间，定位在恒定预留区内距气泡 4px）→ 编辑卡（引用 chip + contenteditable 正文 + 提示 + 取消/发送，`fit-content` 右对齐、`max-width: 76%`）→ 发送：`runtime.markFolded()` 置折叠守卫 → `setDraft(composeMessage(正文, 剩余引用))` → 40ms 后触发 composer 主发送按钮。

**3b. 消息撤回链（withdraw.ts）**
点 ↶（编辑按钮之后）→ chrome 从行的 `data-chat-flow-key` / `data-chat-anchor-key` 定位消息 → bridge 发布的 `runtime.withdraw` 从宿主 `uiConversation` 的 chat 快照按 anchor key 解析 `seq`（回退到 registry 记录的 `node.data.seq`）→ 调 `sessions.binding(sessionId).session.command('/rewind-plugin @<seq> both')`：追加面遮蔽标记撤回目标及其之后的消息，并以 `both` 模式按检查点还原本轮改过的文件 → **先把** registry 里的**原始 wire 文本**（含 `<dsh-quotes>` 块）经 `inputActions.setDraft` 立即写回输入框（不等待文件还原/命令结算，点击即回填），输入框面板的「撤回还原」把协议块拆回待发引用 chip；命令结果只用于失败提示；随后调用 `session.loadThrough(targetSeq)` 把历史窗口回退到目标消息——否则一次较深的撤回会把已加载窗口留在若干「撤回标记」空行上，聊天区看起来空白、只余「加载更早」。图片：撤回前从 node 视图登记到 registry 的 `image` 内容块（回退到 chat 快照）取出附件 ref；**等回退在客户端视图里生效（目标行从 chat 快照消失）后**再还原，避免与回退引起的会话重绑竞态把新草稿丢掉——后台 `session.readAttachment` 读字节 → `conversation.createDrafts(sessionId, files)`，再优先用 composer 自身的 `inputActions.addAttachments(ids)`（回退到 `conversation.input.for(scope).addAttachments`）把图片加回输入框。回退引擎 `dsh-rewind-plugin` 是本包依赖：安装本插件时一并装好，并由本包的 `cordis.patch.yml` 以 bundle 行挂载（Host 半部注册命令与快照、Client 半部提供撤回后的可见性遮蔽）；其自带 ↶ 按钮由 CSS 隐藏（`.dsh-rewind-btn`），只保留本插件这一个入口。

**4. 折叠守卫（markFolded，合并后可修的竞态）**
编辑发送把协议块写回草稿后，composer 面板的「撤回还原」会在 React 提交时读到完整块——若不加守卫会把它反解成待发引用并写 storage，与发送竞态产生残留（后台标签页/慢渲染下必现）。发送前 `runtime.markFolded()` 置 `foldingRef`，撤回还原路径跳过这一次；发送清空草稿后守卫自动复位。

**5. 编辑卡 chip / 输入框 chip：× 替换图标**
chip 内同时渲染 × 按钮与引用图标，占同一槽位（CSS 按 `data-x-shown` 切换 display），悬停只换图标不加节点，胶囊宽度恒定；输入框待发 chip（`chip.tsx` 的 `QuoteChip`）同样采用该模式——× 不再作为胶囊左侧单独的按钮出现，移出即还原图标。悬停同时在上方浮全文预览（body 级 fixed 单例，上翻/下翻 + 140ms 指针桥 + 滚动重排）。点 × 从 `editingQuotes` 移除，发送按剩余重组；全删光且正文为空时发送置灰。

**5b. 编辑卡里的 chip 按原位置内嵌（0.7.3+，chrome.ts）**
编辑卡**只有一个 contentEditable**（`.dsqe_editText`），chip 以 `contenteditable="false"` + `data-quote-id` 的内联 span 直接坐进句子——0.7.2 及以前是「顶部一排 chip + 下面一段正文」，所以编辑按钮打开的卡片永远是「胶囊全在最前」。`fillEditBody()` 按 `quote.at` 切正文、逐段插 chip（无 `at` 的老消息退回旧排版，全放最前）。发送时 `readEditBody()` 走一遍 DOM：文本节点累计字符、遇到 chip 记下 `{id, at}`、`<br>` 记换行、`<div>/<p>` 记块边界（Chrome 回车产生的是 div），**跳过 chip 自己的 label 文本**——直接读 `innerText` 会把胶囊文字算进正文。前导空白不计入 `at`（`composeMessage` 会 trim 掉它，对齐 `spotMapOf` 的口径），尾部空白裁剪不影响已有偏移。最后只把**仍在 DOM 里**的 chip 计入 payload，用户点 × 删掉的那枚不会偷偷跟着发出去。

**6. 时间格式**：当天 `HH:mm`；昨天 `昨天 HH:mm`；今年 `M月D日 HH:mm`；跨年 `YYYY年M月D日 HH:mm`（文案走词典 time.*）。

**8. 复制携带引用 + 粘贴还原 / 长文本胶囊（paste.ts）**
消息操作行的「复制」写双通道剪贴板（`copyRich`）：`text/plain` = 展示正文；`text/html` = 正文 + 不可见注释 `<!--dsh-quote-data:[{"text":…}]-->`（`<`→`\u003c`、`--`→`\u002d` 转义，防提前闭合）。粘贴到其他应用只看到正文；粘贴进 composer 时 document 捕获阶段的 `paste` 监听器解析标记 → `preventDefault` → 逐条 `addQuote` → `execCommand('insertText')` 在光标处插入正文（失败则 `runtime.draft` 兜底追加）。无标记 / JSON 坏 / 空数组一律不拦截（原生粘贴）。clipboard 写入优先 `navigator.clipboard.write` + `ClipboardItem`（Blob 双通道），降级为选中隐藏富节点 `execCommand('copy')`（HTML 通道保留）。

**9. 超长文本胶囊链（0.3.0+）**
粘贴进 composer 的纯文本 ≥ `LONG_TEXT_THRESHOLD`（500 字符）且无引用标记时：`preventDefault` + **`stopImmediatePropagation`** → `addQuote(text, { long: true })` 折叠为**长文本胶囊**。事件截断是必须的：宿主 Lexical 编辑器的 paste 处理（`onPasteForRichText`）**不检查 `defaultPrevented`**，事件一旦冒泡到编辑器根元素就会派发 `PASTE_COMMAND` 把剪贴板全文再插一遍（0.3.0 只 `preventDefault` 时胶囊旁边仍出现全文，即此因）；引用数据粘贴分支同理截断，让 `execCommand('insertText')` 成为唯一插入路径。（`chip.tsx` 按 `quote.long` 渲染三行文字线文档图标 `ClipIcon`；`protocol.chipLabel` 把 chip 的 DOM 文本截到 200 字符防大粘贴撑爆布局，全文只存在于 store / 协议块 / 预览面板）。发送时 `composeMessage` 在协议块条目上序列化 `long: true`；`scanQuotes` / `readComposedDraft` / store 持久化都保留该标记——**撤回还原后胶囊原样回到输入框**。气泡内的胶囊由 transcript 传 `onOpen`，点击经 `detail.tsx` 的模块级 store（`openDetail(text, long)`）打开右侧详情。

**10. 原生侧边栏详情（0.4.0+，sidebar-tab.tsx）**
`openDetail` **优先走宿主原生右侧边栏**（与 `dsh-file-review` 同款接入，**`sidebarRight` / `sidebarRightTabs` 必须声明在插件 `inject` 数组里宿主才会注入**——0.4.0 漏了声明导致永远降级本地抽屉；bundle 内仍 duck typing 松解析，不 import 宿主包）：`sidebarRightTabs.register({ id, kind, title })` 注册标签页 → `slots.inject('sidebar.right.pane.tab')` / `('sidebar.right.pane.tab.title')` 注册正文与标题（`key` = 标签 id）→ 打开用 `sidebarRight.openTabIn(sessionId, tabId, { params: { text, long? } })`，正文组件从 `useTabInfo().tab.navigation.params` 读参数（宿主传入的 hook prop）。`index.tsx` 在 `ctx.effect` 里安装（服务可能晚于 `apply()` 就绪，100ms × 10 次重试），成功后把 opener 挂到 `runtime.detailOpener`；宿主 Minimal profile / mock 无此服务时**降级为本地抽屉**（`shell.overlay` order 110，body portal，× / Esc 关闭）。正文组件 `DetailBody` **照 `dsh-file-review` 的审查面板排版**（0.7.3 重做，用户以截图指认该面板为「native 侧边栏」的标准）：`.dsqe-pane`（100% 高 flex 列）→ `.dsqe-paneHead`（64px，图标块 + `.dsqe-paneTitle` + `{n} 行` / `{n} 字符` 胶囊标签 + 右侧 `.dsqe-paneTools` 圆角工具条：「复制全文」「自动换行」）→ `.dsqe-paneBody`（`--dsqe-pane-canvas` 凹陷画布，滚动）→ `.dsqe-fileCard`（圆角 + 外阴影白卡）→ `.dsqe-fileHead`（44px sticky：折叠箭头 + 图标 + 名称 + 行数/字数）→ `.dsqe-code`（等宽，`.dsqe-codeLine` 逐行 flex，`.dsqe-codeNo` 行号 **`position: sticky; left: 0`** 横向滚动时固定，行 hover 变底）。画布色由 `color-mix(in oklab, var(--dsqe-label) 4%, var(--dsqe-pane-bg))` 算——宿主 `--dsw-alias-bg-layer-1` 与 `-l2` 实测同为 `#fff`，直接拿 layer2 当画布会白成一片（这是「看起来不像原生面板」的直接原因之一）。**滚动容器的顶部内边距必须为 0**（0.7.4 修）：`position: sticky; top: 0` 贴的是 scrollport（padding box）边缘，而 `padding-top` 留在吸顶卡头之上，代码就从那条缝里滚过去 —— 表现为「滑动时顶部漏出一行内容」。所以 `.dsqe-paneBody` 用 `padding: 0 12px 20px`，卡头与标题条之间的 12px 间距交给 `.dsqe-fileCard` 的 `margin-top`（会随内容一起滚走）；`.dsqe-paneHead` 另加不透明底 + `position: relative; z-index: 1` 兜底。`.dsqe-codeNo` 也补了 `z-index: 1`，横向滚动时行号始终压在代码之上。**JSON 自动识别**：`looksLikeJson`（`{`/`[` 开头 + `JSON.parse` 成功且为 object，2MB 上限防卡死）→ 紧凑 JSON 自动 `JSON.stringify(_, null, 2)` 格式化 → 按行分 token（`JSON_TOKEN_RE`：键 / 字符串 / 数字 / 字面量 / 结构符）渲染语法配色（`--dsqe-json-*` 明暗各一组）；JSON 默认不换行（横向滚动 + 行号固定），纯文本默认自动换行。「复制全文」走 `copyText`，成功切 ✓ 1.5s。悬浮预览（React tip 与 chrome 的 DOM 单例 tip）都有 `max-height: 50vh + overflow-y: auto`。旧消息条目无 `long` 字段按普通引用渲染，协议向后兼容。

**7. 回显剥离 / storage 对账 / U+200B**：与两个前身插件一致，剥离幂等（合并后只有一份观察器）。

**12. 点击 chip 定位原文（0.6.0+，locate.ts + source-mark.tsx）**
点输入框里的引用 chip → `locateQuote(text, quoteId)`：找容器（`[data-conversation-scroll]` → 最后一条 `[data-chat-flow-key]` 的可滚动祖先 → 全部行的最近公共父级）→ `TreeWalker` 遍历文本节点，跳过 composer 与插件自己的 UI（`[data-composer-card]` / `.dsqe-chip` / `.dsqe-tipWrap` / `.dsqe-drawer` / `.dsqe-sideWrap` / `.dsqe_editor`）→ **拍平**成一个字符串（连续空白压成一个空格；用「最近块级祖先」判断块边界，相邻块之间补一个虚拟空格，替代 DOM 里根本不存在的换行）→ 归一化的引用做 `lastIndexOf`（同一句出现多次取**最后一次**：离输入框最近，几乎总是刚选的那处）→ 命中区间经 `owner/offset` 数组反查回 `(textNode, offset)` 造 `Range`（跨 `<code>` / `<strong>` / 段落都成立）。超长引用按 120/60/30 字符前缀逐级回退（选区跨过被折叠的代码块时仍能落位）。

下划线**不写进消息 DOM**：`Range.getClientRects()` 拿到逐行矩形，`source-mark.tsx` 在 `document.body` 上叠同尺寸的 fixed 指示（淡底 + 2px 虚线底边，虚线是为了读起来像「引用标记」而不是超链接/选区），并按对话滚动容器的矩形裁剪（底部再让出 composer 顶边，避免盖住输入框）。平滑滚动 900ms 内用 rAF 连续重算，之后靠 `scroll`/`resize` 事件跟随；`Range` 脱离文档（消息被撤回、会话切换、行被虚拟化）即自动清除。标记状态是模块级 store（`getSourceMark/subscribeSourceMark`），chip 用 `data-active` 高亮、再点同一枚 chip 关闭（`locateQuote` 返回 `'off'`），`Esc` 或点击别处也关闭；找不到时 `getMissingToken()` 递增，浮出一条 2.6s 提示。粘贴产生的 `long: true` 胶囊没有对话原文，点击仍走右侧详情。

**11. 输入框手动调高（0.5.0+，composer-resize.ts）**
纯 DOM 装饰（与 hover chrome 同生命周期，`ctx.effect(() => watchComposerResize())`）：MutationObserver 盯 `[data-composer-card]`，出现的卡片加 `dsqe_rzCard`（position:relative）并在顶边中央挂一枚 grip（`dsqe-rzHandle`，absolute top:-5px，76×12 命中区，细横条 `::after` 默认 0.3 透明度、悬停/拖拽 0.75）。`pointerdown` 起拖（Pointer Capture，body 标 `data-dsqe-resizing` 锁选择 + ns-resize 光标）：目标元素 = 卡内 `[data-lexical-editor="true"]` 自身或其最近 `overflow-y: auto/scroll` 祖先（`composerScrollAreaOf`），高度 = 起始高 + (startY − clientY)（输入框贴底，**上拖变高**），写入 inline `height`/`max-height` 并强制 `overflow-y: auto`，钳制在 `COMPOSER_MIN_HEIGHT`(44) ～ `min(COMPOSER_MAX_HEIGHT`(640), 60vh)`；`pointerup` 存 localStorage（`dsh.select-quote-with-edit.composerHeight`），卡片再现时（含刷新后）自动套用；`dblclick` 清 inline 高度 + 清存储复原。与 chip 行的 `--dsqe-pad` 预留互不影响（ResizeObserver 自适应）。

**13. 输入框行内胶囊（0.7.0+，inline-chips.ts）**
待发引用与粘贴生成的长文本胶囊**直接坐在编辑器正文里**（插在光标处、跟着文字排版流动），不再钉在输入框顶部一行。做法是**复用宿主自己的行内引用节点**，不自己造节点：

- 宿主 composer 是 Lexical 编辑器，`[data-lexical-editor="true"]` 根元素上有 `__lexicalEditor`；它内建的 `reference-chip`（`DecoratorNode`，`isInline() === true`、`isKeyboardSelectable() === false`）就是 `@` 文件/会话引用的那枚胶囊。插件用 `editor._nodes.get('reference-chip').klass` 拿构造器，`new` 一个实例以 `source: 'dsh-quote'` 区分来源，宿主自己的 React 渲染原样拿来用
- 插入在 `editor.update(fn, { discrete: true })` 里做：`_selection.anchor.type === 'text'` → `splitText(offset)` 后在 head 上 `insertAfter(chip)`（offset 0 用 `insertBefore`）；`'element'` → 宿主段落上 `splice(offset, 0, [chip])`，**若这个 element 点是 root 本身**（空输入框就是 `{key:'root', offset:0}`）则改走 `placeInBlock()`：落到光标指向的 block 的**开头**、或最后一个 block 的**末尾**，一个 block 都没有时先用 `_nodes.get('paragraph')` 造一个段落再放——把胶囊直接 `root.append(chip)` 会让 root 出现非法子节点，且光标停在 root 级 element 点上，**下一个按键会另起一段，胶囊被单独挤成一行**；**没有可用光标**（焦点还在对话区）→ 同样走 `placeInBlock(…, ∞)` = 最后一个 block 的 `append`
- 插完把光标停在**同一段落内**紧挨胶囊的位置，而且必须落在**文本节点**里：`parent.select(index + 1, index + 1)` 这种 element 点会被 Lexical 归一化提到 root（叶子 block 里全是 decorator 时没有可转换的文本点），于是打字又另起一段。做法是 `parent.splice(index + 1, 0, [filler])` 插一个**内容为 U+200B 的空文本节点**再 `filler.select(0, 0)`——空串会被 Lexical 拒（#99/#282），U+200B 可以；它不显示、`composeMessage` 里 `stripDraftMarker` 会把它去掉，不会漏进消息
- **读节点属性必须绕开 `$` API**：`ReferenceChipNode.getSource()/getReference()` 内部走 `$getNodeByKey`，在没有活动 editor state 的地方调用会抛 Lexical **#195**。而 update listener 恰好就是这种地方——早期版本因此在 update 提交后抛错，调用方误判「插入失败」，于是反复重插（一次引用插出上百枚胶囊、顶部行也不消失）。现在只读原始字段 `__source` / `__ref`（getter 仅作新宿主的兜底，且包 try/catch），并且每个节点单独 try/catch：**一个坏节点不能打断整次扫描**
- **插入是幂等的**：模块级 `owned` 记住已插过的 id，`present` / 已提交状态里已有该 id 就直接算成功；同一 id 连续失败两次就放弃并退回顶部行。面板（overlay）重挂载会重置 React state，幂等守卫让「重挂载 → 再插一次」不再可能
- **删除**：`watchChipDeletion()` 在 document 捕获阶段截 `Backspace` / `Delete`，只处理「光标紧挨我们自己的胶囊、中间没有可删字符」的情况（文本点看前后兄弟，element 点看相邻子节点、必要时下钻到 block 的首/尾叶子），`target.remove()` 后把光标重锚到父节点，并**立刻 `removeQuote`**——否则面板看到「store 有、编辑器没有」会马上补插回来。带 `⌘/Ctrl/Alt/Shift` 的组合键一律放行
- **胶囊与 store 以编辑器为准**：`registerUpdateListener` 每次全量扫 `_nodeMap`，发布 `present: Set<quoteId>`（并给 `getElementByKey` 拿到的 DOM 打 `data-dsqe-active` 高亮）。面板订阅这份集合：store 里有、编辑器里没有的补插；**编辑器里没有但曾经有过**的 → 延迟 220ms 再 `removeQuote`（一次扫描可能落后一个 state），删前用 `chipPresent()` 以已提交状态复核
- **不能写 U+200B 标记**：宿主的 `setDraft(text)` 是「清空 root + 按行重建段落」，会连带擦掉所有胶囊。行内模式下胶囊本身就是内容、发送键已可用，所以标记 effect **只在 row 降级模式**里跑
- **序列化不能拒**：胶囊若活到提交，宿主会走 `serializeReference('dsh-quote', id)` 找 owner 的 codec，找不到就 reject 整条消息。故 `registerQuoteSource` 在 `ctx.get('inputTriggers')` 上注册同名 source（`trigger` 用一个永不输入的 `\u0002`）：`codec.serialize` 兜底成 `<quote>…</quote>`、`openReference` 把点击路由回「定位原文 / 打开详情」（服务可能晚于 `apply()` 就绪，250ms × 40 次重试）
- **占位符必须剥**：节点 `getTextContent()` 是 `clipboardText`，composer 的剪贴板投影里每枚胶囊占一个 **U+FFFC**；`protocol.composeMessage` 先用 `stripChipPlaceholders`（`/[\uE100-\uE11D\uFFFC]/gu`，与宿主 `REFERENCE_PLACEHOLDER_RE` 同集）剥掉再拼正文
- **降级到顶部行**：`inlineChipsSupported()`（编辑器在 + 节点类型在）不成立、或插入被编辑器拒绝，面板把 `mode` 切到 `'row'`，退回 0.6.0 的顶部 chip 行（`--dsqe-pad` 预留高度只在 row 模式生效）；切换会话 `resetInlineChips()` 清掉缓存的存在性、`owned` 与失败计数
- 调试开关：控制台执行 `globalThis.__dsqeDebug = true` 可看到 `[dsqe]` 前缀的 scan / insert / delete 轨迹

**14. 顺序一致（0.7.2+，位置协议 + 回填标记 + 剪贴板 v2）**

「引用 + 文本1111 + 长文本 + 文本222」这样交错输入，要求**发送后的气泡**和**撤回回填后的输入框**都保持同样的顺序。三条路径各有一套落位机制：

- **发送**：`chipOrder()` 按**文档顺序**给出胶囊的 quoteId 列表——`_nodeMap` 的遍历顺序是创建顺序，不能用；`ElementNode` 的子节点在这个 Lexical 版本里是**键的链表**（`__first` / `__next` 都是字符串 key，必须经 `_nodeMap.get(key)` 解析成节点，也没有 `__children` 数组）。`spotMapOf(draft, order)` 把「draft 里第 N 个 U+FFFC」换算成「去掉占位符后正文里的字符偏移」，`composeMessage(draft, quotes, spots)` 把它写成 payload 的 `at`；气泡侧 `transcript.bubbleContent()` 按 `at` 把胶囊与文字**交错**渲染（老消息无 `at` 保持「胶囊在前」的旧排版）
- **撤回回填**：宿主 `setDraft` 会洗掉 `[\uE100-\uE11D\uFFFC]`，所以占位符换成私用区 **U+E000**（`QUOTE_MARK`）：`withQuoteMarks(text, ats)` 写出带标记的草稿，标记落地后 `materializeQuoteMarks(ids)` 一趟遍历把所有标记按顺序换成 chip。**`splitText(0)` 不是切分**（返回原节点、没有尾段），落在文本节点开头的标记必须走「从另一头切」的分支，否则第一枚胶囊永远落不下去；同一个文本节点里的多枚标记要用游标逐个处理，切完一次后面的偏移就失效了
- **复制 / 粘贴**：`chip-clipboard.ts` 只在「选区里确实有我们的胶囊」时接管 `copy` / `cut`，写 `text/plain`（每枚胶囊内联成 label）+ `text/html`（`<!--dsh-quote-data:{"v":2,"text":…,"quotes":[{text,long?,at?}]}-->`）；块边界最多记一次换行（`pendingBreak = Math.max(pendingBreak, 1)`），不会出现 `\n\n\n`。`paste.ts` 两种载荷都认（v2 / 「复制」消息时的裸数组），带 `at` 时 `addQuote` → `queueQuoteRestore(ids)` → `insertPlain(withQuoteMarks(...))`，由面板的插入 effect 消费队列，避免与「一枚引用插一枚胶囊」的循环抢同一次提交
- **全选删除（一次清空）**：宿主的删除路径只走文本节点，元素型 chip 它不碰，所以两边各删一段——但**不能互相打断**。0.7.2 的做法是 `preventDefault` + `execCommand('delete')` + `removeChipsByRef()`：宿主根本不听 `execCommand`，文字留下、胶囊删掉，于是要按两下；而把补删放到 `setTimeout` 里，`editor.update` 又被宿主 pending 的 edit 吞掉（`removed: 2` 但树里仍在）。现在的做法：`watchChipDeletion()` 在 **keydown 里同步** `removeChipsByRef()` 且**不拦截默认行为**，宿主的文字删除照常发生，一次按键全清；`beforeinput`（IME / `insertText` 覆盖选区，没有可打印 keydown）再补一遍。`removeChipsByRef()` 结尾会重读一次树（`committedOf` + `scan`），宿主连同段落一起删掉、没有节点可 `remove()` 的 ref 也要从 store 移除，否则面板会看到「store 有、编辑器没有」再补插一枚。`cut` 因为必须先 `preventDefault`（否则浏览器覆盖剪贴板），删除改为向 root 派发一个 `new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true })`，走宿主真正监听的那条路径
- **粘贴回来不欠删除（0.7.6+）**：两个隐形字符问题 + 一个孤儿问题，都表现为「粘贴回输入框后按删除，第一下没反应」。
  ① `finish()` 过去给每枚新胶囊**无条件**补一个 U+200B 填充文本节点；胶囊插在文本中间时 `splitText` 已切出尾段文本节点，再补一个就是**两个零宽字符叠在一起**。现在先看胶囊的下一个兄弟：是文本节点就直接 `select(0, 0)` 复用（`finish:parent {filler: 'reuse-next'}`），造新节点只兜底「胶囊后面什么都没有」的情况
  ② `chip-clipboard` 的 `emitText` 现在剥掉 `[\u200b\ufeff]`——全选复制时正文里的填充符跟着进了剪贴板，粘贴回来它们就成了正文的一部分，删到最后才现形
  ③ `tidyFillers()`：正文（非零宽字符）存在时把树里所有 U+200B 清干净——独立填充节点直接 `remove()`，混在正文里的零宽串用 `splitText` 切出来再删；**只有胶囊没有正文**时保留恰好一个（发送键靠它可用）。它在两处同步运行：`materializeQuoteMarks` 收尾（粘贴 / 撤回回填），以及 `watchChipDeletion` 的 Backspace/Delete keydown 里（都在手势内同步，挂到 `setTimeout` 会被宿主吞）
  ④ **粘贴替换选区时的孤儿 quote**：`paste.ts` 接管粘贴（marker 路径 / 长文本路径）会 `preventDefault` 后走 `execCommand('insertText')`——但 `execCommand` **不触发 `beforeinput`**（headless 实测，连宿主的输入路径都不走），选区里原有胶囊被宿主删掉却没人通知 store，面板的兜底插入循环就把孤儿 quote 补成多余的胶囊。现在两个粘贴分支动手前都先 `removeChipsInSelection()`（导出自 `inline-chips`，复用 `removeChipsByRef` 的「删节点 + 移 quote + 撤回 stash」全套）
- **输入框滚动不外溢（0.7.7+）**：输入框文字长了出现滚动条后，滚到顶/底再滚，**正文跟着滚**。排查链路很绕：`overscroll-behavior: contain` 挂到滚动容器（`composer-resize.ts` 的 `composerScrollAreaOf` 能找到它）后用真实滚轮探针测，正文照样动——但合成 `WheelEvent`（不触发原生滚动）却滚不动正文，最小化嵌套页面里 `contain` 又完全正常。最后给所有滚动容器的 `scrollTop` setter 上探针抓调用栈，真凶现形：**宿主在正文滚动容器上挂了自己的 `onWheel`，输入框到边界后它直接 `scrollTop = ...` 手动滚正文**——JS 赋值不走滚动链，CSS 拦不住。修法是 document 捕获阶段的 `wheelGuard`：目标在 composer 卡片内**且滚动容器确实可滚**（`scrollHeight > clientHeight`）时 `stopPropagation()`——捕获阶段的 document 监听永远先于宿主挂在正文容器上的任何监听执行；输入框没有溢出时不拦，保留宿主「滚输入框转发正文」的原生体验。`contain` 仍保留作原生链式滚动的纵深防御。另外 `keepScrollLocal` 改为幂等重入：宿主「先插卡片外壳、后填编辑器」，`ensureHandle` 首跑时滚动容器还不存在，必须靠观察器在内层 DOM 变化时重跑（持久化高度也跟着补挂到新容器上）
- **引用气泡的图片缩略图（0.7.8+）**：带引用/长文本胶囊的消息粘贴图片后发送，气泡上看不到缩略图（无胶囊时宿主自己的视图渲染正常）。图片**其实已随消息到达模型**——丢的只是我们自己 `UserMessageView` 引用分支里的缩略图渲染：宿主传入的 `loadImage(attachment)` 返回的是 **Promise**（blob/object URL 是异步解析的），直接把返回值塞进 `<img src>` 得到字面量 `"[object Promise]"`，加载必然失败。修法是 `AttachmentImage` 组件：同时接受同步字符串与 Promise，resolve 后再渲染 `<img>`；卸载时置 `alive` 防止晚到的 setState。这个 prop 的返回类型契约要写进「依赖的产品内部约定」里复核：`loadImage` 可能同步返回 `string | undefined`，也可能返回 `Promise<string | undefined>`
- **带图消息 + 胶囊的发送路径本身没问题**：折叠 `inject()` → 宿主 `setDraft`（实测**不清附件**，探针单独验证过）→ 宿主提交，附件块（`content` 里 `type:"image"` 的 block）原样随消息走；变体实验（图前加胶囊 / 长文本胶囊 + 图）模型都收到了 `probe.png`。只有回显渲染这一层丢图
- **重复胶囊墙（0.7.9+）**：反复粘贴同一段长文本后，几十枚同文本胶囊一次性炸出。链条是三环叠加：① `materializeQuoteMarks` 的标记**单独成文本节点**时（paste-back 的标记就是草稿唯一内容），`splitText(1)` 没有尾段，`swap:head-failed`，chip 没放上——现在有 `head-solo` 分支整节点替换，失败路径也走 `removeMarkBestEffort` 把标记删干净；② 失败曾被**虚报成功**（`placed += 1` 不看 swap 结果），残留标记又让 `hasRestoreMarks()` 永远为真、**面板插入 effect 被冻住**，quote 全成孤儿——现在物化后按树里实际剩余标记数修正 `placed`（`marks:leftover`）；③ `addQuote` 不去重，反复粘贴堆了 44 条同文本 quote，标记一消失 effect 把它们**一次全插出来**——现在同文本同类型直接返回已有 quote。排查利器：`scrollTop` setter 探针之外的又一招——给 `localStorage` 的 store 全键计数 + `[dsqe]` 全量日志对时间线，`swap:head-failed` 与 `chips:0` 同帧出现即锁死
- **输入框 grip 隐形化（0.7.10→0.7.11）**：调高热区在卡片顶边中央（76×12px，`top: -5px`），**不渲染任何可见把手**——`::after { content: none }`、`background: none`，唯一提示是悬停时 `cursor: ns-resize`；拖拽、双击复原、持久化全部不变。中途一版做过「默认隐藏、悬停浮现」（`opacity` + `pointer-events` 切换），用户后来说干脆不要可见条，改回隐形热区常驻。**关键坑：定位与选择器不能挂我们往卡片上加的类**——宿主 React 重渲染会重置卡片的 `className`，插件加的 `dsqe_rzCard` 随时被抹掉（实测复现）；所以定位（`position: relative`）挂在宿主自己维护的 `[data-composer-card]` 属性上，插件不再往宿主卡片写任何 class

## 依赖的产品内部约定（升级 dsh 后复核）

- `[data-composer-card]` + 主发送按钮为卡片内最后一个 `button`（停止按钮渲染 `svg rect`）；
- 用户消息悬停操作行根元素带 `data-clock="start"`（助手行是 `end`；CSS module 类名会被哈希，属性是稳定钩子）；
- `[data-lexical-editor="true"]`、`[data-chat-flow-key]`、`[data-conversation-scroll]`、`[data-submission-echo]` / `[data-queue-dock]`；
- 行内胶囊：根元素上的 `__lexicalEditor`（`update` / `_nodes` / `_nodeMap` / `_selection` / `registerUpdateListener` / `getElementByKey`）、节点类型 `reference-chip`（构造参数 `{source, ref, label, appearance, clipboardText}`、`getSource()` / `getReference()`）、chip 在剪贴板投影里占 U+FFFC、占位符正则 `/[\uE100-\uE11D\uFFFC]/gu`；另外：`_nodes.get('text')` / `_nodes.get('paragraph')` 的 `klass`（可以直接 `new`，但空文本节点会被拒）、root 只接受 block 子节点（`rootNode.splice` 收到文本节点即 #282）；
- `ctx.get('inputTriggers').registerSource({ trigger, name, codec: { clipboardText, serialize }, openReference })`：未注册 source 的胶囊活到提交会让整条消息 reject；
- 槽位 `shell.overlay` / `conversation.input.overlay`（props 带 `useInput`、`inputActions.setDraft`）/ `conversation.chat.node`（user/steering）；
- 聊天节点视图 props：`loadImage(attachment)` 返回 `string | undefined` **或 `Promise<string | undefined>`**（0.7.8 实测是 Promise——同步当字符串用会渲染成 `"[object Promise]"`）；用户消息 `content` 里的图片是 `{type:'image', attachment:{attachmentId, mediaType, name?}}` 块；
- `ctx.locale.register/bind`；`ctx.slots.inject/register/entries`；
- `ctx.get('sessions')` / `ctx.get('uiConversation')`（撤回定位 seq 与发命令用）；`sessions.binding(id).session.command(line)`；
- `dsh-rewind-plugin` 的内部命令 `/rewind-plugin @<seq> both`、其 Client 可见性遮蔽、以及它自带按钮的类名 `dsh-rewind-btn`（用于隐藏，避免重复入口）；
- 深色：`body[data-ds-dark-theme]`；磨砂走 `--dsw-menu-*`；
- 不 `require` 任何 Harness Client 包（verify 有闸）。

## 排错

| 现象 | 先查 |
|---|---|
| 划词没有工具条 | 选区起止是否都在 `[data-chat-flow-key]` 消息内；style 是否已注入（刷新页面） |
| 一次添加出现两条引用 | 先排除页面上的真实鼠标操作与自动化混跑（演示面板可见时用户点击也会计入） |
| 发送后引用条数变多 / storage 残留 | markFolded 守卫是否生效（编辑发送必须先置 foldingRef 再 setDraft） |
| 悬停没有操作行 | 行内是否有 `data-dsqe-user` 标记；是否正在编辑 |
| 气泡出现 JSON | 委托链是否落到宿主视图（宿主/兜底路径会剥块） |
| 预览面板错位/巨大 | JS 与 CSS 的类名前缀是否一致（连字符 vs 下划线） |
| 点 chip 没滚到原文 / 提示找不到 | 原文是否在已加载消息里；下划线层是否在 `shell.overlay`（order 90）；拍平索引的块边界（`blockOwnerOf`）是否被新渲染结构打乱 |
| 引用插出很多枚胶囊 / 顶部行也不消失 | 扫描是否在 update listener 里抛 Lexical #195（读 getter 而非原始字段 `__source`）；插入是否幂等（`owned` 守卫）；控制台开 `__dsqeDebug` 看 insert:threw / insert:placed 次数 |
| 按 Backspace 删不掉胶囊，反而把段落拆成两段 | 光标是否落在 root 级 element 点（`selectNext` 的老问题）；`watchChipDeletion` 是否注册；是否带了 ⌘/Ctrl/Alt 被放行 |
| 删掉胶囊后它又自己回来了 | 删除路径是否同时 `removeQuote`（否则面板按「store 有、编辑器没有」补插） |
| 引用还是显示在输入框顶部一行（不是行内） | 宿主是否还注册 `reference-chip` 节点（`inlineChipsSupported()`）；插入后 `present` 里有没有该 id——任一失败即 `mode='row'` 兜底，看控制台无异常属预期降级 |
| 行内胶囊删掉了但引用还在 / 反过来 | `registerUpdateListener` 是否绑上（`ensureAttached` 只在 `insertQuoteChip` 时触发）；`seenRef` 记过的 id 才会被删，切换会话后 `resetInlineChips()` 会清空 |
| 发送出去多出「￼」字符 | `composeMessage` 是否还带 `stripChipPlaceholders`（U+FFFC 来自 chip 的 `getTextContent`） |
| 发送后胶囊全堆在正文最前面 | payload 里有没有 `at`：`chipOrder()` 是否为空（`__first` 是键的链表，必须经 `_nodeMap` 解析）；气泡是否走 `bubbleContent` 而不是老排版 |
| 撤回回填后顺序乱 / 第二枚胶囊没回来 | 看 `marks:nodes` 的 offsets 是否覆盖每枚标记；文本节点开头的标记（offset 0）是否走到 head 分支（`swap:head-failed` 说明 `splitText(0)` 被当成了切分） |
| 输入框里全选复制不到胶囊 | `chip-clipboard.ts` 有没有接管（剪贴板 HTML 里应有 `"v":2`）；胶囊 DOM 上有没有 `data-composer-chip-ref`（`paintActive()` 打的） |
| 全选删除要按两下（第一下只删文字或只删胶囊） | 宿主的删除路径只走文本节点、不碰元素型 chip，所以两边的删除必须各管一段，且**不能互相打断**：`preventDefault` 会连宿主的文字删除一起挡掉（`execCommand('delete')` 宿主根本不听），而在 `setTimeout` 里补删 chip 会被宿主 pending 的 edit 吞掉。现在的做法是 keydown 里**同步**删 chip、不拦截默认删除；IME / `insertText` 覆盖选区的路径没有可打印 keydown，靠 `beforeinput` 补一遍 |
| 侧栏详情滚动时顶部漏出一行内容 | 滚动容器是不是带了 `padding-top`：sticky 卡头贴 scrollport、内边距留在它上方，内容就从缝里过去。`.dsqe-paneBody` 必须 `padding: 0 12px 20px`，间距交给 `.dsqe-fileCard` 的 `margin-top` |
| 插入胶囊后打的字跑到下一行 | 胶囊是否被直接塞进 root（应走 `placeInBlock`）；光标有没有 U+200B 文本节点落脚 |
