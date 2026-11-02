# dsh-plugin-select-quote-with-edit

[DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart)（dsh）的客户端插件，把「划词引用」「消息编辑」「消息撤回」合成一个插件：

- **划词引用**：选中对话文字，浮出「复制 / 添加到对话」；引用以 chip 进入输入框与已发送气泡，悬停查看全文
- **消息编辑**：悬停自己发送的消息，在气泡下方的悬停操作行里出现「编辑」；内联编辑后作为一条新消息发出
- **消息撤回**：编辑按钮后面再加一个「撤回」↶ 图标，一键回退该消息及其之后的内容、还原本轮改过的文件，并把原文（含引用 chip）填回输入框

![悬停操作行](assets/screenshot-1-hover.png)

## 功能

### 划词引用

- **复制随引用**：点消息操作行的「复制」复制正文；若消息带引用，引用数据随剪贴板 HTML 通道一并携带（不可见，粘贴到其他应用只看到正文）；**粘贴回输入框时自动还原成待发引用 chip + 正文**，效果与「添加到对话」一致
- **划词工具条**：选区上方浮出「复制 / 添加到对话」（没空间自动翻到下方）；「复制」点击后变「已复制」，1.5 秒还原，不打断选区
- **输入框 chip**：引用以 chip（图标 + 截断文本）出现在输入框左上角；悬停时 × **替换掉胶囊最前面的引用图标**（胶囊宽度不变、不是另挂一个删除按钮），移出即还原图标，悬停同时浮出全文预览；只有引用没打字时发送按钮依然可用（U+200B 标记）
- **发送回显**：引用以协议块随消息交给模型；发送瞬间回显与排队预览里的协议 JSON 自动剥离
- **气泡回显**：已发送消息渲染为「引用 chip + 正文」——顶部胶囊已表达引用，**下方不再重复铺开引用全文**；悬停 chip 查看全文
- **随会话持久化**：未发送引用存 localStorage（保留 20 个会话 / 7 天），刷新恢复，跨标签对账；撤回消息带协议块回输入框时自动拆回待发 chip

### 消息编辑

- **悬停操作行**：普通消息把「编辑 + 撤回」作为**独立按钮常驻**在宿主操作行里，紧跟在原生「时间 + 复制」之后——与复制按钮**同步显隐**（同处宿主的 `[data-clock]` 容器，跟着它自己的悬停显隐过渡一起出现/淡出），不再单独增删、也不会只用一次就消失；带引用的气泡无宿主行，由插件自绘同款操作行（尺寸/间距与宿主一致）；引用气泡行**恒定预留操作行高度**，展示/隐藏不再引起消息上下跳动
- **内联编辑**：原气泡变成编辑卡——引用 chip + 可编辑正文同行，下方提示与「取消 / 发送」；卡片随内容收缩、与气泡同侧右对齐（`max-width: 76%`），不再横跨整行；`Esc` 取消、`⌘/Ctrl + Enter` 发送；空正文且无引用时发送置灰
- **编辑时管理引用**：悬停 chip，× **替换引用图标占位**（胶囊宽度不变），上方浮出全文预览；点 × 从本次编辑移除该引用，发送按剩余引用重组协议块
- **发送为新消息**：写回输入框并触发宿主自己的发送手势（带折叠守卫，不与撤回还原竞态）；引用原样保留

![内联编辑](assets/screenshot-2-editor.png)

### 消息撤回

- **编辑按钮后的 ↶ 图标**：普通消息把「撤回」注入宿主悬停操作行，紧跟在「编辑」之后（时间 + 复制 + 编辑 + 撤回）；带引用的气泡在插件自绘操作行里同样排在「编辑」之后。两种消息的操作行尺寸/间距与宿主原生行完全一致
- **一条消息的三种撤回**：点一下，目标消息及其之后的内容从模型上下文与渲染对话中撤回；本轮被工具改过的文件按检查点还原；被撤回消息的原文**点击即回填**输入框（不等待文件还原跑完），改完可直接重发
- **引用胶囊原样保留**：带引用的消息撤回后，协议块回填输入框时会被自动拆回**待发引用 chip**——和撤回前一样显示为引用胶囊，正文也回到编辑器
- **图片一并恢复**：带图片的消息撤回后，除了文字，消息里的图片也会按附件重新读回并加回输入框（与宿主附件一致的预览），不会只剩文字
- **内置回退引擎**：撤回的「对话回退 + 文件还原」由随本插件自动安装并挂载的 [`dsh-rewind-plugin`](https://github.com/SiriLee/dsh-rewind) 提供（内部 `/rewind-plugin @<seq> both` 命令）；其自带的 ↶ 按钮会被隐藏，只保留本插件这一个「撤回」入口

## 安装

**从 Git 仓库直装**（桌面端插件页填入仓库地址，或命令行）：

```sh
dsh plugin --profile desktop add git+https://github.com/xiangdongbu/dsh-plugin-select-quote-with-edit.git
# 或 SSH：
dsh plugin --profile desktop add git+ssh://git@github.com/xiangdongbu/dsh-plugin-select-quote-with-edit.git
```

仓库已提交构建产物（`lib/index.js`、`lib/client.js`），克隆即可安装，无需本地构建。装完若界面没立刻出现，重启一次 App；之后改 `lib/client.js` 由 `dsh-client-hmr` 热替换。

> 「撤回」的引擎 `dsh-rewind-plugin` 是本包依赖，安装本插件时会一并安装，并由本包 `cordis.patch.yml` 挂载；升级到含撤回的版本后**需要重启一次**以加载它的 Host 半部（文件快照/回退命令）。

> 这是 `dsh-plugin-select-quote-simple` 与 `dsh-plugin-edit` 的合并版：**安装本插件后请卸载那两个旧插件**，避免重复的划词工具条与消息接管。

本地开发：

```bash
git clone git@github.com:xiangdongbu/dsh-plugin-select-quote-with-edit.git
cd dsh-plugin-select-quote-with-edit
npm install && npm run check
cp dev.patch.example.yml dev.patch.yml   # 把 <CHECKOUT> 改成本仓库的绝对路径
dsh web --patch "$PWD/dev.patch.yml"
```

已装进桌面 profile 时，`npm run sync:desktop` 可热更新。

## 本地验证

```bash
npm run check        # typecheck + build + 59 项无头校验
npm run mock         # mock 宿主 + http://127.0.0.1:4173/test/mock/app.html
```

mock 宿主复刻 dsh web 客户端 DOM 约定（composer 卡片、lexical 编辑器、flow-key 消息行、宿主悬停操作行、发送回显、slot 注册表），并内置 priority -10 的模拟消息插件视图（`?fakequote=1`）验证委托共存；`sessions` / `uiConversation` 服务则模拟回退引擎执行 `/rewind-plugin @<seq> both`。已验证：划词工具条、复制（已复制反馈）、添加到对话（单条不重复）、输入框 chip 悬停时 × 替换图标、发送折叠与回显剥离、气泡 chip 回显且不再重复引用全文、悬停操作行（普通消息编辑 + 撤回按钮注入宿主行 + 引用气泡插件行、恒定预留高度不跳动）、内联编辑、编辑卡 × 替换图标（宽度不变）、移除引用后发送、保留引用发送、撤回（移除消息 + 定位 seq + `both` 模式还原文件 + 原文回填 + 引用胶囊还原）、无引用插件环境独立运行。

## 消息协议

```
# Quoted references:
Each item in the block below is text the user selected ...

<dsh-quotes>
[{"text":"…"}]
</dsh-quotes>

用户正文
```

与 `dsh-plugin-select-quote-simple` / `dsh-plugin-edit` 完全同格：JSON 内 `<` 转义 `\u003c`；展示层只认完整标记对（JSON 坏也剥）；只有完整 + JSON 合法 + 非空数组的块才会还原成待发 chip。

## 实现要点（详见 [docs/internals.md](docs/internals.md)）

- 一个浏览器模块承载三套功能，`user` / `steering` 消息节点以 `priority: -20` 接管：挂 `display: contents` 标记（供悬停 chrome 定位与原文注册）、引用消息自绘 chip 气泡、普通消息委托宿主视图
- 划词工具条、输入框 chip 行、悬停操作行、内联编辑器分别挂 `shell.overlay` 与 `conversation.input.overlay`；编辑器经 bridge 拿到宿主 `inputActions`，发送前先置折叠守卫再写草稿，避免撤回还原竞态
- 消息撤回经 bridge 拿到宿主 `sessions` / `uiConversation`：从 chat 快照按 anchor key 解析消息 `seq`，调用回退引擎的 `/rewind-plugin @<seq> both`（对话回退 + 文件还原），再把原文写回 `inputActions`；协议块由输入框面板自动拆回待发引用 chip
- 全部样式一个前缀（`dsqe-`），深浅色跟随产品的 `body[data-ds-dark-theme]`

## 已知限制

- 普通消息的「编辑 / 撤回」注入宿主悬停操作行（`data-clock="start"` 钩子）；宿主若改动该结构，自动回退为插件自绘操作行
- 带引用的气泡由插件绘制，宿主的悬停动作行不可用，插件自绘「时间 + 复制 + 编辑 + 撤回」；普通消息零改动
- 「撤回」的对话回退与文件还原由**随插件自动安装并挂载**的 `dsh-rewind-plugin` 提供（内部命令 `/rewind-plugin @<seq> both`）；因此首次安装/升级需要能访问 npm 解析该依赖，装完需重启一次以加载其 Host 半部
- 隐藏 `dsh-rewind-plugin` 自带 ↶ 按钮依赖其类名 `dsh-rewind-btn`；该插件若改名，两个撤回按钮会同时出现（功能不受影响）
- 主动斷开旧的两个插件才能避免功能重复

## License

[MIT](LICENSE) © 2026 xiangdongbu
