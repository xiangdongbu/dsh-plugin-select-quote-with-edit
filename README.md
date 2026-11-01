# dsh-plugin-select-quote-with-edit

[DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart)（dsh）的客户端插件，把「划词引用」与「消息编辑」合成一个插件：

- **划词引用**：选中对话文字，浮出「复制 / 添加到对话」；引用以 chip 进入输入框与已发送气泡，悬停查看全文
- **消息编辑**：悬停自己发送的消息，下方浮出「时间 / 编辑 / 复制」；内联编辑后作为一条新消息发出

![悬停操作行](assets/screenshot-1-hover.png)

## 功能

### 划词引用

- **划词工具条**：选区上方浮出「复制 / 添加到对话」（没空间自动翻到下方）；「复制」点击后变「已复制」，1.5 秒还原，不打断选区
- **输入框 chip**：引用以 chip（图标 + 截断文本）出现在输入框左上角，悬停出 × 与全文预览，可删除；只有引用没打字时发送按钮依然可用（U+200B 标记）
- **发送回显**：引用以协议块随消息交给模型；发送瞬间回显与排队预览里的协议 JSON 自动剥离
- **气泡回显**：已发送消息渲染为「chip + 正文 + 引用全文」，悬停 chip 查看全文
- **随会话持久化**：未发送引用存 localStorage（保留 20 个会话 / 7 天），刷新恢复，跨标签对账；撤回消息带协议块回输入框时自动拆回待发 chip

### 消息编辑

- **悬停操作行**：悬停自己发送的消息（user / steering），气泡下方紧贴浮出「时间 + 编辑 + 复制」；时间带日期（当天 `23:29`、昨天 `昨天 23:29`、更早 `10月30日 23:29`）；移开防抖收起
- **内联编辑**：原气泡变成编辑卡——引用 chip + 可编辑正文同行，下方提示与「取消 / 发送」；`Esc` 取消、`⌘/Ctrl + Enter` 发送；空正文且无引用时发送置灰
- **编辑时管理引用**：悬停 chip，× **替换引用图标占位**（胶囊宽度不变），上方浮出全文预览；点 × 从本次编辑移除该引用，发送按剩余引用重组协议块
- **发送为新消息**：写回输入框并触发宿主自己的发送手势（带折叠守卫，不与撤回还原竞态）；引用原样保留

![内联编辑](assets/screenshot-2-editor.png)

## 安装

**从 Git 仓库直装**（桌面端插件页填入仓库地址，或命令行）：

```sh
dsh plugin --profile desktop add git+https://github.com/xiangdongbu/dsh-plugin-select-quote-with-edit.git
# 或 SSH：
dsh plugin --profile desktop add git+ssh://git@github.com/xiangdongbu/dsh-plugin-select-quote-with-edit.git
```

仓库已提交构建产物（`lib/index.js`、`lib/client.js`），克隆即可安装，无需本地构建。装完若界面没立刻出现，重启一次 App；之后改 `lib/client.js` 由 `dsh-client-hmr` 热替换。

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
npm run check        # typecheck + build + 36 项无头校验
npm run mock         # mock 宿主 + http://127.0.0.1:4173/test/mock/app.html
```

mock 宿主复刻 dsh web 客户端 DOM 约定（composer 卡片、lexical 编辑器、flow-key 消息行、发送回显、slot 注册表），并内置 priority -10 的模拟消息插件视图（`?fakequote=1`）验证委托共存。已验证：划词工具条、复制（已复制反馈）、添加到对话（单条不重复）、输入框 chip 悬停删除、发送折叠与回显剥离、气泡 chip 回显、悬停操作行（时间格式 + 贴合间距）、内联编辑、编辑卡 × 替换图标（宽度不变）、移除引用后发送、保留引用发送、无引用插件环境独立运行。

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

- 一个浏览器模块承载两套功能，`user` / `steering` 消息节点以 `priority: -20` 接管：挂 `display: contents` 标记（供悬停 chrome 定位与原文注册）、引用消息自绘 chip 气泡、普通消息委托宿主视图
- 划词工具条、输入框 chip 行、悬停操作行、内联编辑器分别挂 `shell.overlay` 与 `conversation.input.overlay`；编辑器经 bridge 拿到宿主 `inputActions`，发送前先置折叠守卫再写草稿，避免撤回还原竞态
- 全部样式一个前缀（`dsqe-`），深浅色跟随产品的 `body[data-ds-dark-theme]`

## 已知限制

- 带引用的气泡由插件绘制，不显示宿主的悬停动作行；普通消息零改动
- 若宿主对用户消息自带悬停动作行，两者会并存
- 主动斷开旧的两个插件才能避免功能重复

## License

[MIT](LICENSE) © 2026 xiangdongbu
