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
src/client/composer-panel.tsx    # 输入框 chip 行 + 标记 + 发送折叠 + 撤回还原
src/client/chip.tsx              # React 引用 chip（输入框/气泡内，悬停全文预览）
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
| `shell.overlay` | list slot | 划词工具条（order 100，root 级常驻） |
| `conversation.input.overlay` | list slot | 桥（order 1，发布 inputActions/markFolded）+ chip 行（order 20） |
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
选区准入（起止都在 `[data-chat-flow-key]` 且不在 composer）→ 工具条浮出 → 「添加到对话」进 store（按会话持久化）→ 输入框 chip（U+200B 保发送键）→ 发送手势捕获阶段折叠成协议块 → 回显剥离 → 气泡内 chip 回显 → 撤回还原。

**3. 消息编辑链**（继承自 dsh-plugin-edit）
悬停标记行 → 普通消息把「编辑」+「撤回」注入宿主自己的操作行（`MessageIconActions` 的 `data-clock="start"` 根元素，编辑在前、撤回紧接其后，React 重建后由 pointerover/pointermove 重注入）；这两个按钮是**每行各一份的常驻元素**（`ensureHostButtons` 在 node 视图挂载时即注入），放在宿主自己的 `[data-clock]` 容器内，因此**跟随复制按钮的悬停显隐过渡一起出现/淡出**，不由插件单独增删；引用气泡无宿主行，退回插件自绘操作行（时间/复制/编辑/撤回，尺寸与间距对齐宿主 `MessageIconActions`：28px 按钮 / 15px 图标 / 8px gap / 13px 时间，定位在恒定预留区内距气泡 4px）→ 编辑卡（引用 chip + contenteditable 正文 + 提示 + 取消/发送，`fit-content` 右对齐、`max-width: 76%`）→ 发送：`runtime.markFolded()` 置折叠守卫 → `setDraft(composeMessage(正文, 剩余引用))` → 40ms 后触发 composer 主发送按钮。

**3b. 消息撤回链（withdraw.ts）**
点 ↶（编辑按钮之后）→ chrome 从行的 `data-chat-flow-key` / `data-chat-anchor-key` 定位消息 → bridge 发布的 `runtime.withdraw` 从宿主 `uiConversation` 的 chat 快照按 anchor key 解析 `seq`（回退到 registry 记录的 `node.data.seq`）→ 调 `sessions.binding(sessionId).session.command('/rewind-plugin @<seq> both')`：追加面遮蔽标记撤回目标及其之后的消息，并以 `both` 模式按检查点还原本轮改过的文件 → **先把** registry 里的**原始 wire 文本**（含 `<dsh-quotes>` 块）经 `inputActions.setDraft` 立即写回输入框（不等待文件还原/命令结算，点击即回填），输入框面板的「撤回还原」把协议块拆回待发引用 chip；命令结果只用于失败提示；随后调用 `session.loadThrough(targetSeq)` 把历史窗口回退到目标消息——否则一次较深的撤回会把已加载窗口留在若干「撤回标记」空行上，聊天区看起来空白、只余「加载更早」。图片：撤回前从 node 视图登记到 registry 的 `image` 内容块（回退到 chat 快照）取出附件 ref；**等回退在客户端视图里生效（目标行从 chat 快照消失）后**再还原，避免与回退引起的会话重绑竞态把新草稿丢掉——后台 `session.readAttachment` 读字节 → `conversation.createDrafts(sessionId, files)`，再优先用 composer 自身的 `inputActions.addAttachments(ids)`（回退到 `conversation.input.for(scope).addAttachments`）把图片加回输入框。回退引擎 `dsh-rewind-plugin` 是本包依赖：安装本插件时一并装好，并由本包的 `cordis.patch.yml` 以 bundle 行挂载（Host 半部注册命令与快照、Client 半部提供撤回后的可见性遮蔽）；其自带 ↶ 按钮由 CSS 隐藏（`.dsh-rewind-btn`），只保留本插件这一个入口。

**4. 折叠守卫（markFolded，合并后可修的竞态）**
编辑发送把协议块写回草稿后，composer 面板的「撤回还原」会在 React 提交时读到完整块——若不加守卫会把它反解成待发引用并写 storage，与发送竞态产生残留（后台标签页/慢渲染下必现）。发送前 `runtime.markFolded()` 置 `foldingRef`，撤回还原路径跳过这一次；发送清空草稿后守卫自动复位。

**5. 编辑卡 chip / 输入框 chip：× 替换图标**
chip 内同时渲染 × 按钮与引用图标，占同一槽位（CSS 按 `data-x-shown` 切换 display），悬停只换图标不加节点，胶囊宽度恒定；输入框待发 chip（`chip.tsx` 的 `QuoteChip`）同样采用该模式——× 不再作为胶囊左侧单独的按钮出现，移出即还原图标。悬停同时在上方浮全文预览（body 级 fixed 单例，上翻/下翻 + 140ms 指针桥 + 滚动重排）。点 × 从 `editingQuotes` 移除，发送按剩余重组；全删光且正文为空时发送置灰。

**6. 时间格式**：当天 `HH:mm`；昨天 `昨天 HH:mm`；今年 `M月D日 HH:mm`；跨年 `YYYY年M月D日 HH:mm`（文案走词典 time.*）。

**8. 复制携带引用 + 粘贴还原（paste.ts）**
消息操作行的「复制」写双通道剪贴板（`copyRich`）：`text/plain` = 展示正文；`text/html` = 正文 + 不可见注释 `<!--dsh-quote-data:[{"text":…}]-->`（`<`→`\u003c`、`--`→`\u002d` 转义，防提前闭合）。粘贴到其他应用只看到正文；粘贴进 composer 时 document 捕获阶段的 `paste` 监听器解析标记 → `preventDefault` → 逐条 `addQuote` → `execCommand('insertText')` 在光标处插入正文（失败则 `runtime.draft` 兜底追加）。无标记 / JSON 坏 / 空数组一律不拦截（原生粘贴）。clipboard 写入优先 `navigator.clipboard.write` + `ClipboardItem`（Blob 双通道），降级为选中隐藏富节点 `execCommand('copy')`（HTML 通道保留）。

**7. 回显剥离 / storage 对账 / U+200B**：与两个前身插件一致，剥离幂等（合并后只有一份观察器）。

## 依赖的产品内部约定（升级 dsh 后复核）

- `[data-composer-card]` + 主发送按钮为卡片内最后一个 `button`（停止按钮渲染 `svg rect`）；
- 用户消息悬停操作行根元素带 `data-clock="start"`（助手行是 `end`；CSS module 类名会被哈希，属性是稳定钩子）；
- `[data-lexical-editor="true"]`、`[data-chat-flow-key]`、`[data-submission-echo]` / `[data-queue-dock]`；
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
