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

**6. 时间格式**：当天 `HH:mm`；昨天 `昨天 HH:mm`；今年 `M月D日 HH:mm`；跨年 `YYYY年M月D日 HH:mm`（文案走词典 time.*）。

**8. 复制携带引用 + 粘贴还原 / 长文本胶囊（paste.ts）**
消息操作行的「复制」写双通道剪贴板（`copyRich`）：`text/plain` = 展示正文；`text/html` = 正文 + 不可见注释 `<!--dsh-quote-data:[{"text":…}]-->`（`<`→`\u003c`、`--`→`\u002d` 转义，防提前闭合）。粘贴到其他应用只看到正文；粘贴进 composer 时 document 捕获阶段的 `paste` 监听器解析标记 → `preventDefault` → 逐条 `addQuote` → `execCommand('insertText')` 在光标处插入正文（失败则 `runtime.draft` 兜底追加）。无标记 / JSON 坏 / 空数组一律不拦截（原生粘贴）。clipboard 写入优先 `navigator.clipboard.write` + `ClipboardItem`（Blob 双通道），降级为选中隐藏富节点 `execCommand('copy')`（HTML 通道保留）。

**9. 超长文本胶囊链（0.3.0+）**
粘贴进 composer 的纯文本 ≥ `LONG_TEXT_THRESHOLD`（500 字符）且无引用标记时：`preventDefault` + **`stopImmediatePropagation`** → `addQuote(text, { long: true })` 折叠为**长文本胶囊**。事件截断是必须的：宿主 Lexical 编辑器的 paste 处理（`onPasteForRichText`）**不检查 `defaultPrevented`**，事件一旦冒泡到编辑器根元素就会派发 `PASTE_COMMAND` 把剪贴板全文再插一遍（0.3.0 只 `preventDefault` 时胶囊旁边仍出现全文，即此因）；引用数据粘贴分支同理截断，让 `execCommand('insertText')` 成为唯一插入路径。（`chip.tsx` 按 `quote.long` 渲染三行文字线文档图标 `ClipIcon`；`protocol.chipLabel` 把 chip 的 DOM 文本截到 200 字符防大粘贴撑爆布局，全文只存在于 store / 协议块 / 预览面板）。发送时 `composeMessage` 在协议块条目上序列化 `long: true`；`scanQuotes` / `readComposedDraft` / store 持久化都保留该标记——**撤回还原后胶囊原样回到输入框**。气泡内的胶囊由 transcript 传 `onOpen`，点击经 `detail.tsx` 的模块级 store（`openDetail(text, long)`）打开右侧详情。

**10. 原生侧边栏详情（0.4.0+，sidebar-tab.tsx）**
`openDetail` **优先走宿主原生右侧边栏**（与 `dsh-file-review` 同款接入，**`sidebarRight` / `sidebarRightTabs` 必须声明在插件 `inject` 数组里宿主才会注入**——0.4.0 漏了声明导致永远降级本地抽屉；bundle 内仍 duck typing 松解析，不 import 宿主包）：`sidebarRightTabs.register({ id, kind, title })` 注册标签页 → `slots.inject('sidebar.right.pane.tab')` / `('sidebar.right.pane.tab.title')` 注册正文与标题（`key` = 标签 id）→ 打开用 `sidebarRight.openTabIn(sessionId, tabId, { params: { text, long? } })`，正文组件从 `useTabInfo().tab.navigation.params` 读参数（宿主传入的 hook prop）。`index.tsx` 在 `ctx.effect` 里安装（服务可能晚于 `apply()` 就绪，100ms × 10 次重试），成功后把 opener 挂到 `runtime.detailOpener`；宿主 Minimal profile / mock 无此服务时**降级为本地抽屉**（`shell.overlay` order 110，body portal，× / Esc 关闭）。正文组件 `DetailBody`：**JSON 自动识别**——`looksLikeJson`（`{`/`[` 开头 + `JSON.parse` 成功且为 object，2MB 上限防卡死）→ 紧凑 JSON 自动 `JSON.stringify(_, null, 2)` 格式化 → 按行分 token（`JSON_TOKEN_RE`：键 / 字符串 / 数字 / 字面量 / 结构符）渲染**行号 + 语法配色**代码视图（`--dsqe-json-*` 明暗主题各配一组）；非 JSON 走 pre-wrap 文本。标题栏带「复制全文」按钮（`copyText`，成功切 ✓ 1.5s）。悬浮预览（React tip 与 chrome 的 DOM 单例 tip）都有 `max-height: 50vh + overflow-y: auto`，长文本在预览面板内滚动。旧消息条目无 `long` 字段按普通引用渲染，协议向后兼容。

**7. 回显剥离 / storage 对账 / U+200B**：与两个前身插件一致，剥离幂等（合并后只有一份观察器）。

**12. 点击 chip 定位原文（0.6.0+，locate.ts + source-mark.tsx）**
点输入框里的引用 chip → `locateQuote(text, quoteId)`：找容器（`[data-conversation-scroll]` → 最后一条 `[data-chat-flow-key]` 的可滚动祖先 → 全部行的最近公共父级）→ `TreeWalker` 遍历文本节点，跳过 composer 与插件自己的 UI（`[data-composer-card]` / `.dsqe-chip` / `.dsqe-tipWrap` / `.dsqe-drawer` / `.dsqe-sideWrap` / `.dsqe_editor`）→ **拍平**成一个字符串（连续空白压成一个空格；用「最近块级祖先」判断块边界，相邻块之间补一个虚拟空格，替代 DOM 里根本不存在的换行）→ 归一化的引用做 `lastIndexOf`（同一句出现多次取**最后一次**：离输入框最近，几乎总是刚选的那处）→ 命中区间经 `owner/offset` 数组反查回 `(textNode, offset)` 造 `Range`（跨 `<code>` / `<strong>` / 段落都成立）。超长引用按 120/60/30 字符前缀逐级回退（选区跨过被折叠的代码块时仍能落位）。

下划线**不写进消息 DOM**：`Range.getClientRects()` 拿到逐行矩形，`source-mark.tsx` 在 `document.body` 上叠同尺寸的 fixed 指示（淡底 + 2px 虚线底边，虚线是为了读起来像「引用标记」而不是超链接/选区），并按对话滚动容器的矩形裁剪（底部再让出 composer 顶边，避免盖住输入框）。平滑滚动 900ms 内用 rAF 连续重算，之后靠 `scroll`/`resize` 事件跟随；`Range` 脱离文档（消息被撤回、会话切换、行被虚拟化）即自动清除。标记状态是模块级 store（`getSourceMark/subscribeSourceMark`），chip 用 `data-active` 高亮、再点同一枚 chip 关闭（`locateQuote` 返回 `'off'`），`Esc` 或点击别处也关闭；找不到时 `getMissingToken()` 递增，浮出一条 2.6s 提示。粘贴产生的 `long: true` 胶囊没有对话原文，点击仍走右侧详情。

**11. 输入框手动调高（0.5.0+，composer-resize.ts）**
纯 DOM 装饰（与 hover chrome 同生命周期，`ctx.effect(() => watchComposerResize())`）：MutationObserver 盯 `[data-composer-card]`，出现的卡片加 `dsqe_rzCard`（position:relative）并在顶边中央挂一枚 grip（`dsqe-rzHandle`，absolute top:-5px，76×12 命中区，细横条 `::after` 默认 0.3 透明度、悬停/拖拽 0.75）。`pointerdown` 起拖（Pointer Capture，body 标 `data-dsqe-resizing` 锁选择 + ns-resize 光标）：目标元素 = 卡内 `[data-lexical-editor="true"]` 自身或其最近 `overflow-y: auto/scroll` 祖先（`composerScrollAreaOf`），高度 = 起始高 + (startY − clientY)（输入框贴底，**上拖变高**），写入 inline `height`/`max-height` 并强制 `overflow-y: auto`，钳制在 `COMPOSER_MIN_HEIGHT`(44) ～ `min(COMPOSER_MAX_HEIGHT`(640), 60vh)`；`pointerup` 存 localStorage（`dsh.select-quote-with-edit.composerHeight`），卡片再现时（含刷新后）自动套用；`dblclick` 清 inline 高度 + 清存储复原。与 chip 行的 `--dsqe-pad` 预留互不影响（ResizeObserver 自适应）。

**13. 输入框行内胶囊（0.7.0+，inline-chips.ts）**
待发引用与粘贴生成的长文本胶囊**直接坐在编辑器正文里**（插在光标处、跟着文字排版流动），不再钉在输入框顶部一行。做法是**复用宿主自己的行内引用节点**，不自己造节点：

- 宿主 composer 是 Lexical 编辑器，`[data-lexical-editor="true"]` 根元素上有 `__lexicalEditor`；它内建的 `reference-chip`（`DecoratorNode`，`isInline() === true`、`isKeyboardSelectable() === false`）就是 `@` 文件/会话引用的那枚胶囊——**在行内、方向键一步跨过、Backspace/Delete 整块删除**。插件用 `editor._nodes.get('reference-chip').klass` 拿构造器，`new` 一个实例以 `source: 'dsh-quote'` 区分来源，宿主自己的 React 渲染与删除语义原样拿来用（自造节点注册不进宿主 `_nodes`，渲染与键盘行为都得重写，故不采用）
- 插入在 `editor.update(fn, { discrete: true })` 里做：`_selection.anchor.type === 'text'` → `splitText(offset)` 后在 head 上 `insertAfter(chip)`（offset 0 用 `insertBefore`）；`'element'` → `parent.splice(offset, 0, [chip])`；**没有可用光标**（焦点还在对话区，刚划完词）→ 落到最后一个 block 的 `append`。成功后 `chip.selectNext(0,0)` 把光标停在胶囊后面，接着打字就是「胶囊 + 正文」
- **胶囊与 store 以编辑器为准**：`editor.registerUpdateListener` 每次全量 `scan(_nodeMap)` 收集 `source === 'dsh-quote'` 的胶囊，发布 `present: Set<quoteId>`（同时给 `getElementByKey` 拿到的 DOM 打 `data-dsqe-active` 高亮）。面板订阅这份集合：store 里有、编辑器里没有的补插；**编辑器里没有但曾经有过**的 → `removeQuote`。所以**按删除键删胶囊就等于删引用**，不需要额外监听键盘
- **序列化不能拒**：胶囊若活到提交，宿主会走 `serializeReference('dsh-quote', id)` 找 owner 的 codec，找不到就 reject 整条消息。故 `registerQuoteSource` 在 `ctx.get('inputTriggers')` 上注册同名 source（`trigger` 用一个永不输入的 `\u0002`，只为 codec 与点击路由存在）：`codec.serialize` 兜底成 `<quote>…</quote>`、`openReference` 把点击路由回「定位原文 / 打开详情」（服务是兄弟插件、可能晚于 `apply()` 就绪，故 250ms × 40 次重试注册）。正常路径仍是发送手势里 `composeMessage` 折叠成协议块
- **占位符必须剥**：节点 `getTextContent()` 是 `clipboardText`，composer 的剪贴板投影里每枚胶囊占一个 **U+FFFC**；`protocol.composeMessage` 先用 `stripChipPlaceholders`（`/[\uE100-\uE11D\uFFFC]/gu`，与宿主 `REFERENCE_PLACEHOLDER_RE` 同集）剥掉再拼正文，否则占位符会漏进消息
- **降级到顶部行**：`inlineChipsSupported()`（编辑器在 + 节点类型在）不成立、或 `insertQuoteChip` 插入后 `present` 里没有该 id（编辑器静默丢弃），面板就把 `mode` 切到 `'row'`，退回 0.6.0 的顶部 chip 行（`--dsqe-pad` 预留高度那套只在 row 模式生效）；切换会话 `resetInlineChips()` 清掉缓存的存在性

## 依赖的产品内部约定（升级 dsh 后复核）

- `[data-composer-card]` + 主发送按钮为卡片内最后一个 `button`（停止按钮渲染 `svg rect`）；
- 用户消息悬停操作行根元素带 `data-clock="start"`（助手行是 `end`；CSS module 类名会被哈希，属性是稳定钩子）；
- `[data-lexical-editor="true"]`、`[data-chat-flow-key]`、`[data-conversation-scroll]`、`[data-submission-echo]` / `[data-queue-dock]`；
- 行内胶囊：根元素上的 `__lexicalEditor`（`update` / `_nodes` / `_nodeMap` / `_selection` / `registerUpdateListener` / `getElementByKey`）、节点类型 `reference-chip`（构造参数 `{source, ref, label, appearance, clipboardText}`、`getSource()` / `getReference()`）、chip 在剪贴板投影里占 U+FFFC、占位符正则 `/[\\uE100-\\uE11D\\uFFFC]/gu`；
- `ctx.get('inputTriggers').registerSource({ trigger, name, codec: { clipboardText, serialize }, openReference })`：未注册 source 的胶囊活到提交会让整条消息 reject；
- 槽位 `shell.overlay` / `conversation.input.overlay`（props 带 `useInput`、`inputActions.setDraft`）/ `conversation.chat.node`（user/steering）；
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
| 引用还是显示在输入框顶部一行（不是行内） | 宿主是否还注册 `reference-chip` 节点（`inlineChipsSupported()`）；插入后 `present` 里有没有该 id——任一失败即 `mode='row'` 兜底，看控制台无异常属预期降级 |
| 行内胶囊删掉了但引用还在 / 反过来 | `registerUpdateListener` 是否绑上（`ensureAttached` 只在 `insertQuoteChip` 时触发）；`seenRef` 记过的 id 才会被删，切换会话后 `resetInlineChips()` 会清空 |
| 发送出去多出「￼」字符 | `composeMessage` 是否还带 `stripChipPlaceholders`（U+FFFC 来自 chip 的 `getTextContent`） |
