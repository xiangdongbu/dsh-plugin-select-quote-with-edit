/**
 * All plugin CSS, injected once as a <style> element.
 *
 * Colors come from two places:
 * - material tokens where the product guarantees them (`--dsw-menu-*`), with
 *   self-contained fallbacks for the rest;
 * - a small static palette switched by the product's own
 *   `body[data-ds-dark-theme]` attribute (never `prefers-color-scheme`).
 *
 * Entrance animations only use transform — `opacity < 1` on an ancestor would
 * cut off backdrop sampling for the frosted layers.
 */

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ')
}

const BACKDROP = 'var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%))'

const CSS = `
body {
  --dsqe-label: #232629;
  --dsqe-label-2: #6b7075;
  --dsqe-surface: var(--dsw-menu-surface-fill, rgba(248, 249, 250, 0.94));
  --dsqe-card: #f4f5f7;
  --dsqe-border: rgba(0, 0, 0, 0.10);
  --dsqe-chip-bg: rgba(0, 0, 0, 0.05);
  --dsqe-chip-label: #4b4f55;
  --dsqe-quote-text: #1f2329;
  --dsqe-bubble: #e9f1fe;
  --dsqe-send-bg: #16171a;
  --dsqe-send-label: #ffffff;
  --dsqe-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.10), 0 3px 8px rgba(0, 0, 0, 0.05), 0 0 20px rgba(0, 0, 0, 0.05);
  --dsqe-elev: 0 0 0 0.5px rgba(0, 0, 0, 0.08), 0 3px 10px rgba(0, 0, 0, 0.06);
  --dsqe-json-key: #0550ae;
  --dsqe-json-str: #116329;
  --dsqe-json-num: #953800;
  --dsqe-json-lit: #8250df;
  --dsqe-src-line: rgba(37, 99, 235, 0.85);
  --dsqe-src-bg: rgba(37, 99, 235, 0.06);
  /* 侧边栏详情标签页（照原生审查面板：面板面 / 凹陷画布 / 分隔线）。
     The host exposes the same colour for both layer tokens, so the recessed
     canvas is mixed from the label colour exactly like dsh-file-review does —
     a hair of ink over the surface, flipping with the theme by itself. */
  --dsqe-pane-bg: var(--dsw-alias-bg-layer-1, #ffffff);
  --dsqe-pane-canvas: color-mix(in oklab, var(--dsqe-label) 4%, var(--dsqe-pane-bg));
  --dsqe-pane-line: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.10));
}
body[data-ds-dark-theme] {
  --dsqe-label: #f0f0f2;
  --dsqe-label-2: #a3a7ad;
  --dsqe-surface: var(--dsw-menu-surface-fill, rgba(39, 40, 43, 0.94));
  --dsqe-card: #2e2f33;
  --dsqe-border: rgba(255, 255, 255, 0.10);
  --dsqe-chip-bg: #35363a;
  --dsqe-chip-label: #d4d6da;
  --dsqe-quote-text: #ececee;
  --dsqe-bubble: #37383c;
  --dsqe-send-bg: #d9dadc;
  --dsqe-send-label: #1b1c1f;
  --dsqe-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.08), 0 8px 28px rgba(0, 0, 0, 0.42);
  --dsqe-elev: 0 0 0 0.5px rgba(255, 255, 255, 0.07), 0 6px 22px rgba(0, 0, 0, 0.35);
  --dsqe-json-key: #79c0ff;
  --dsqe-json-str: #7ee787;
  --dsqe-json-num: #ffa657;
  --dsqe-json-lit: #d2a8ff;
  --dsqe-src-line: rgba(138, 180, 255, 0.9);
  --dsqe-src-bg: rgba(138, 180, 255, 0.08);
  --dsqe-pane-bg: var(--dsw-alias-bg-layer-1, #232427);
  --dsqe-pane-canvas: color-mix(in oklab, var(--dsqe-label) 5%, var(--dsqe-pane-bg));
  --dsqe-pane-line: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.10));
}

/* ---------- 消息行标记（悬停 chrome / 编辑器的定位上下文） ---------- */
.dsqe_row { position: relative; }
/* Quote bubbles have no host action row of their own, so reserve the action
   row's height permanently. The row is shown/hidden on hover without changing
   layout, which keeps messages from jumping when the pointer enters/leaves. */
.dsqe_rowQuote { padding-bottom: calc(28px + var(--dsh-content-font-delta, 0px)) !important; }
/* A row that ends up with the plugin's OWN overlay row (no host [data-clock]
   container to hang the buttons on) reserves the same band, or the overlay
   would sit on top of the bubble's last line. */
.dsqe_rowOwnActions { padding-bottom: calc(28px + var(--dsh-content-font-delta, 0px)) !important; }
.dsqe_rowEditing .dsqe_marker { display: none; }
.dsqe_marker { display: contents; }

/* dsh-rewind-plugin renders its own per-message ↶ button when both plugins are
   active. This plugin owns the withdraw affordance (one-click, no mode popover),
   so hide the other one to avoid two undo icons in the same action row. */
.dsh-rewind-btn { display: none !important; }

/* ---------- 划词工具条 ---------- */
.dsqe-toolbar {
  position: fixed;
  z-index: 60;
  padding: 5px 8px;
  border-radius: 12px;
  background: var(--dsqe-surface);
  -webkit-backdrop-filter: ${BACKDROP};
  backdrop-filter: ${BACKDROP};
  box-shadow: var(--dsqe-shadow);
  font-family: inherit;
}
.dsqe-toolbarRow {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  animation: dsqe-rise-in 0.14s ease-out;
}
.dsqe-toolbarBtn {
  appearance: none;
  border: 0;
  margin: 0;
  background: transparent;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 8px;
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  color: var(--dsqe-label);
  white-space: nowrap;
  cursor: pointer;
}
.dsqe-toolbarBtn:hover { background: rgba(127, 127, 127, 0.16); }
.dsqe-toolbarBtn svg { width: 14px; height: 14px; opacity: 0.9; }

@keyframes dsqe-rise-in {
  from { transform: translateY(4px) scale(0.97); }
}

/* ---------- 引用 chip（输入框 + 气泡内） ---------- */
.dsqe-chipCluster {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  min-width: 0;
}
.dsqe-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  padding: 5px 10px;
  border-radius: 10px;
  border: 0.5px solid var(--dsqe-border);
  background: var(--dsqe-chip-bg);
  color: var(--dsqe-chip-label);
  font-size: 13px;
  line-height: 18px;
  cursor: default;
}
.dsqe-chip svg { width: 14px; height: 14px; flex: none; opacity: 0.9; }
/* The delete × occupies the leading icon's slot on hover (data-x-shown swaps
   them), so the pill never changes width and there is no separate delete
   button hanging off the chip's left edge. */
.dsqe-chipIcon {
  display: inline-flex;
  align-items: center;
  flex: none;
}
.dsqe-chipDelIcon {
  appearance: none;
  border: 0;
  margin: 0;
  padding: 0;
  display: none;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex: none;
  background: transparent;
  color: var(--dsqe-chip-label);
  cursor: pointer;
}
.dsqe-chipDelIcon:hover { color: var(--dsqe-label); }
.dsqe-chip[data-x-shown='true'] .dsqe-chipDelIcon { display: inline-flex; }
.dsqe-chip[data-x-shown='true'] .dsqe-chipIcon { display: none; }
.dsqe-chipText {
  min-width: 0;
  max-width: 128px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dsqe-chipSm {
  font-size: 12px;
  line-height: 17px;
  padding: 3px 9px;
  border-radius: 9px;
  background: rgba(127, 127, 127, 0.18);
  border-color: transparent;
}
.dsqe-chipSm svg { width: 13px; height: 13px; }
.dsqe-chipSm .dsqe-chipDelIcon { width: 13px; height: 13px; }
/* Message-bubble capsules open the detail drawer on click. */
.dsqe-chip[data-openable='true'] { cursor: pointer; }
.dsqe-chip[data-openable='true']:hover { background: var(--dsqe-chip-hover, rgba(127, 127, 127, 0.26)); }
/* The chip whose source is marked in the transcript. */
.dsqe-chip[data-active='true'] {
  background: var(--dsqe-src-bg);
  box-shadow: inset 0 0 0 1px var(--dsqe-src-line);
}

/* ---------- 「定位原文」下划线层 ---------- */
/* Painted over the message, never inside it: one fixed line per client rect of
   the located Range. A dashed bottom border reads as a reference mark (a solid
   one looks like a hyperlink or a text selection); the faint fill shows how far
   a long multi-line quote runs. */
.dsqe-srcMark {
  position: fixed;
  z-index: 40;
  box-sizing: border-box;
  pointer-events: none;
  border-radius: 2px;
  border-bottom: 2px dashed var(--dsqe-src-line);
  background: var(--dsqe-src-bg);
  animation: dsqe-src-in 0.2s ease-out;
}
@keyframes dsqe-src-in {
  from { transform: scaleY(0.6); opacity: 0.4; }
}
.dsqe-srcToast {
  position: fixed;
  left: 50%;
  bottom: 108px;
  transform: translateX(-50%);
  z-index: 65;
  max-width: min(420px, 86vw);
  padding: 8px 14px;
  border-radius: 10px;
  background: var(--dsqe-surface);
  -webkit-backdrop-filter: ${BACKDROP};
  backdrop-filter: ${BACKDROP};
  box-shadow: var(--dsqe-shadow);
  color: var(--dsqe-label);
  font-size: 13px;
  line-height: 19px;
  text-align: center;
  animation: dsqe-rise-in 0.14s ease-out;
}

/* ---------- 输入框内的 chip 行 ---------- */
.dsqe-chipRow {
  position: absolute;
  top: 10px;
  left: 14px;
  right: 14px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  z-index: 5;
}
.dsqe_pad { padding-top: var(--dsqe-pad, 44px) !important; }

/* ---------- chip 悬停全文预览（输入框 / 气泡 / 编辑卡共用） ---------- */
.dsqe-tipWrap {
  position: fixed;
  z-index: 58;
  pointer-events: auto;
}
.dsqe-tipWrap[data-side='above'] { padding-top: 8px; }
.dsqe-tipWrap[data-side='below'] { padding-bottom: 8px; }
.dsqe-tipIn { animation: dsqe-rise-in 0.12s ease-out; }
.dsqe-tip {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 400px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--dsqe-surface);
  -webkit-backdrop-filter: ${BACKDROP};
  backdrop-filter: ${BACKDROP};
  box-shadow: var(--dsqe-shadow);
  color: var(--dsqe-quote-text);
  font-size: 13px;
  line-height: 21px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dsqe-tip svg { width: 14px; height: 14px; flex: none; margin-top: 3px; opacity: 0.85; }
/* Long bodies scroll inside the hover preview instead of covering the screen. */
.dsqe-tip {
  max-height: min(340px, 50vh);
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* ---------- 消息胶囊点击后的右侧详情抽屉 ---------- */
.dsqe-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 70;
  width: min(440px, 88vw);
  display: flex;
  flex-direction: column;
  background: var(--dsqe-surface);
  -webkit-backdrop-filter: ${BACKDROP};
  backdrop-filter: ${BACKDROP};
  border-left: 0.5px solid var(--dsqe-border);
  box-shadow: var(--dsqe-elev);
  animation: dsqe-drawer-in 0.16s ease-out;
  font-family: inherit;
}
@keyframes dsqe-drawer-in {
  from { transform: translateX(24px); }
}
.dsqe-drawerHead {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 0.5px solid var(--dsqe-border);
  flex: none;
}
.dsqe-drawerIcon { display: inline-flex; color: var(--dsqe-label-2); }
.dsqe-drawerIcon svg { width: 15px; height: 15px; }
.dsqe-drawerTitle {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsqe-label);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dsqe-drawerClose {
  appearance: none;
  border: 0;
  margin: 0;
  padding: 6px;
  width: 28px;
  height: 28px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: transparent;
  color: var(--dsqe-label-2);
  cursor: pointer;
}
.dsqe-drawerClose:hover {
  background: rgba(127, 127, 127, 0.16);
  color: var(--dsqe-label);
}
.dsqe-drawerClose svg { width: 15px; height: 15px; }
.dsqe-drawerBody {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 16px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 21px;
  color: var(--dsqe-quote-text);
  user-select: text;
}

/* ---------- 原生侧边栏里的胶囊详情标签页（sidebar-tab.tsx） ----------
   结构照搬 dsh-file-review 的审查面板：顶部标题条 + 工具条，下面一块带
   sticky 名称行的卡片，正文是行号 + 等宽的代码区。 */
.dsqe-pane {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--dsqe-pane-bg);
  color: var(--dsqe-label);
  font-family: inherit;
  box-sizing: border-box;
}
.dsqe-paneHead {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
  min-height: 64px;
  padding: 12px 14px 12px 18px;
  border-bottom: 1px solid var(--dsqe-pane-line);
  /* Opaque: the title bar sits in the same column as the scroller, so keep
     anything that slips past the sticky header from showing through it. */
  background: var(--dsqe-pane-bg);
  position: relative;
  z-index: 1;
}
.dsqe-paneHeading {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.dsqe-paneTile {
  flex: none;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  background: var(--dsqe-chip-bg);
  color: var(--dsqe-label-2);
}
.dsqe-paneTile svg { width: 17px; height: 17px; }
.dsqe-paneTitle {
  font-size: 16px;
  font-weight: 650;
  letter-spacing: -0.01em;
  line-height: 22px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsqe-panePill {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--dsqe-pane-canvas);
  box-shadow: inset 0 0 0 1px var(--dsqe-pane-line);
  color: var(--dsqe-label-2);
  font-size: 12px;
  line-height: 20px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dsqe-paneTools {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 11px;
  background: var(--dsqe-pane-canvas);
  box-shadow: inset 0 0 0 1px var(--dsqe-pane-line);
}
.dsqe-toolBtn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsqe-label-2);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background-color 0.12s, color 0.12s, box-shadow 0.12s;
}
.dsqe-toolBtn:hover { background: var(--dsqe-pane-bg); color: var(--dsqe-label); }
.dsqe-toolBtn[data-on='true'] { color: var(--dsqe-label); }
.dsqe-toolBtn svg { width: 14px; height: 14px; flex: none; }
.dsqe-paneBody {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  /* No top padding: a sticky header pins to the scrollport, not to the content
     box, so padding here stays above the pinned header and the code keeps
     scrolling through that 12px band — it reads as content leaking out from
     under the title bar. The gap lives on the card's own margin instead, which
     scrolls away with it. */
  padding: 0 12px 20px;
  background: var(--dsqe-pane-canvas);
}
.dsqe-fileCard {
  margin-top: 12px;
  border-radius: 12px;
  background: var(--dsqe-pane-bg);
  box-shadow: 0 0 0 1px var(--dsqe-pane-line), 0 1px 2px rgba(0, 0, 0, 0.04),
    0 4px 14px -6px rgba(0, 0, 0, 0.10);
  overflow: clip;
}
.dsqe-fileHead {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  padding: 0 12px 0 6px;
  border-bottom: 1px solid var(--dsqe-pane-line);
  background: var(--dsqe-pane-bg);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.dsqe-fileCard[data-collapsed='true'] .dsqe-fileHead { border-bottom-color: transparent; }
.dsqe-fileChev {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsqe-label-2);
  cursor: pointer;
}
.dsqe-fileChev:hover { background: var(--dsqe-chip-bg); color: var(--dsqe-label); }
.dsqe-fileChev svg { width: 14px; height: 14px; transition: transform 0.14s ease; }
.dsqe-fileChev[data-open='false'] svg { transform: rotate(-90deg); }
.dsqe-fileIcon {
  flex: none;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  color: var(--dsqe-label-2);
}
.dsqe-fileIcon svg { width: 15px; height: 15px; }
.dsqe-fileName {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--dsqe-label);
}
.dsqe-fileMeta {
  flex: none;
  color: var(--dsqe-label-2);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  opacity: 0.85;
}
.dsqe-fileSpacer { flex: 1; }
/* 代码区：行号 gutter 横向滚动时固定（与原生审查面板一致） */
.dsqe-code {
  padding: 8px 0 14px;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 20px;
  color: var(--dsqe-quote-text);
  user-select: text;
}
.dsqe-codeLine { display: flex; min-width: fit-content; }
.dsqe-codeLine:hover { background: var(--dsqe-pane-canvas); }
.dsqe-codeNo {
  position: sticky;
  left: 0;
  /* Stay above the horizontally scrolling code (same stacking order). */
  z-index: 1;
  flex: none;
  width: 46px;
  padding-right: 12px;
  text-align: right;
  background: var(--dsqe-pane-bg);
  color: var(--dsqe-label-2);
  opacity: 0.6;
  user-select: none;
}
.dsqe-codeLine:hover .dsqe-codeNo { background: var(--dsqe-pane-canvas); }
.dsqe-codeText {
  flex: 1;
  padding-right: 16px;
  white-space: pre;
  overflow-wrap: normal;
}
.dsqe-code[data-wrap='true'] .dsqe-codeText {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dsqe-jsonKey { color: var(--dsqe-json-key); }
.dsqe-jsonStr { color: var(--dsqe-json-str); }
.dsqe-jsonNum { color: var(--dsqe-json-num); }
.dsqe-jsonLit { color: var(--dsqe-json-lit); }
.dsqe-sideEmpty {
  padding: 32px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--dsqe-label-2);
}

/* ---------- 输入框手动调高（composer-resize.ts） ----------
   卡片顶边中央一条**隐形**拖拽热区，上拖变高（输入框贴窗口底边）、双击复原；
   高度写进编辑器滚动区 inline style，持久化在 localStorage。
   不渲染任何可见把手——热区完全透明，只有悬停时的 ns-resize 光标提示；
   注意：定位挂宿主自己的 [data-composer-card] —— 宿主 React 重渲染会
   重置 className，我们往卡片上加的类随时可能被抹掉。 */
[data-composer-card] { position: relative; }
.dsqe-rzHandle {
  position: absolute;
  top: -5px;
  left: 50%;
  transform: translateX(-50%);
  width: 76px;
  height: 12px;
  cursor: ns-resize;
  touch-action: none;
  z-index: 6;
  background: none;
  border: none;
  pointer-events: auto;
}
.dsqe-rzHandle::after { content: none; }
body[data-dsqe-resizing='true'] {
  cursor: ns-resize;
  user-select: none;
  -webkit-user-select: none;
}

/* ---------- 对话记录里带引用的用户气泡 ---------- */
.dsqe-userRow {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}
.dsqe-userStack {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  max-width: 100%;
  min-width: 0;
}
.dsqe-bubble {
  max-width: 76%;
  padding: 10px 16px;
  border-radius: 22px;
  background: var(--dsqe-bubble);
  color: var(--dsqe-label);
  font-size: 14px;
  line-height: 22px;
  overflow-wrap: anywhere;
  box-sizing: border-box;
}
/* Inline flow, not flex: a chip sits exactly where the user typed it, in the
   middle of the text, and the text runs on around it. */
.dsqe-bubbleRow {
  display: block;
}
.dsqe-bubbleRow > .dsqe-chipCluster {
  margin: 0 3px;
  vertical-align: middle;
}
.dsqe-bubbleText { min-width: 0; white-space: pre-wrap; }
.dsqe-userImages {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}
.dsqe-userImages img { max-width: 240px; max-height: 240px; border-radius: 12px; }

/* ---------- 悬停操作行（时间 / 复制 / 编辑 / 撤回） ----------
   Metrics mirror the host's own MessageIconActions row (28px buttons, 15px
   glyphs, 8px gap, 13px time with 12px right padding) so the plugin-drawn row
   under a quote bubble and the host row under a plain message look identical. */
.dsqe_actions {
  position: absolute;
  /* The quote row permanently reserves 28px of action-row height; anchor the
     overlay 4px under the bubble so it never changes layout on show/hide. */
  top: calc(100% - 28px + 4px);
  right: 10px;
  display: none;
  align-items: center;
  gap: 8px;
  height: calc(28px + var(--dsh-content-font-delta, 0px));
  z-index: 6;
}
.dsqe_actions[data-shown='true'] { display: inline-flex; }
.dsqe_time {
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  color: var(--dsw-alias-label-tertiary, var(--dsqe-label-2));
  padding-right: 12px;
  user-select: none;
}
.dsqe_iconBtn {
  appearance: none;
  border: 0;
  margin: 0;
  padding: 6px;
  width: calc(28px + var(--dsh-content-font-delta, 0px));
  height: calc(28px + var(--dsh-content-font-delta, 0px));
  border-radius: var(--dsw-radius-sm, 6px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, var(--dsqe-label-2));
  cursor: pointer;
}
.dsqe_iconBtn:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.16));
  color: var(--dsw-alias-label-secondary, var(--dsqe-label));
}
.dsqe_iconBtn svg {
  width: calc(15px + var(--dsh-content-font-delta, 0px));
  height: calc(15px + var(--dsh-content-font-delta, 0px));
}

/* The pencil injected into the host's own actions row follows the host
   action-button metrics (28px box, 15px glyph, product alias tokens) so it
   reads as a native control next to the built-in copy button. */
.dsqe_hostEdit {
  width: calc(28px + var(--dsh-content-font-delta, 0px));
  height: calc(28px + var(--dsh-content-font-delta, 0px));
  padding: 6px;
  border-radius: var(--dsw-radius-sm, 6px);
  color: var(--dsw-alias-label-tertiary, var(--dsqe-label-2));
}
.dsqe_hostEdit:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.16));
  color: var(--dsw-alias-label-secondary, var(--dsqe-label));
}
.dsqe_hostEdit svg {
  width: calc(15px + var(--dsh-content-font-delta, 0px));
  height: calc(15px + var(--dsh-content-font-delta, 0px));
}

/* ---------- 内联编辑器 ---------- */
.dsqe_editor {
  position: relative;
  z-index: 6;
  /* Size to the content and sit on the bubble's side of the row, instead of
     stretching across the whole conversation column. */
  margin-top: 8px;
  margin-left: auto;
  width: fit-content;
  min-width: min(320px, 100%);
  max-width: 76%;
  border-radius: 16px;
  background: var(--dsqe-card);
  box-shadow: var(--dsqe-elev);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  animation: dsqe-rise-in 0.12s ease-out;
}
/* 编辑卡专用 chip：× 替换引用图标占位，胶囊宽度不变 */
.dsqe-echip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  padding: 4px 10px;
  border-radius: 10px;
  border: 0.5px solid var(--dsqe-chip-border, rgba(127, 127, 127, 0.25));
  background: var(--dsqe-chip-bg);
  color: var(--dsqe-chip-label);
  font-size: 12px;
  line-height: 17px;
  flex: none;
  /* Sits in the sentence, not on its own row — and stays put while the text
     around it is edited. */
  vertical-align: middle;
  margin: 0 1px;
  user-select: none;
}
body[data-ds-dark-theme] .dsqe-echip { --dsqe-chip-border: rgba(255, 255, 255, 0.14); }
.dsqe-echipDel,
.dsqe-echipIcon {
  width: 13px;
  height: 13px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.dsqe-echipDel {
  appearance: none;
  border: 0;
  margin: 0;
  padding: 0;
  background: transparent;
  color: var(--dsqe-chip-label);
  border-radius: 4px;
  cursor: pointer;
  display: none;
}
.dsqe-echip[data-x-shown='true'] .dsqe-echipDel { display: inline-flex; }
.dsqe-echip[data-x-shown='true'] .dsqe-echipIcon { display: none; }
.dsqe-echipDel:hover { color: var(--dsqe-label); }
.dsqe-echipDel svg { width: 13px; height: 13px; }
.dsqe-echipIcon svg { width: 13px; height: 13px; opacity: 0.9; }
.dsqe_editText {
  /* The whole editable card body: text *and* chips, inline. */
  flex: 0 1 auto;
  min-width: 0;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsqe-label);
  outline: none;
  min-height: 44px;
  max-height: 40vh;
  overflow-y: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}
.dsqe_editFoot {
  display: flex;
  align-items: center;
  gap: 10px;
}
.dsqe_hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 1;
  min-width: 0;
  font-size: 12px;
  line-height: 17px;
  color: var(--dsqe-label-2);
}
.dsqe_hint svg { width: 13px; height: 13px; flex: none; }
.dsqe_btns { display: inline-flex; align-items: center; gap: 8px; flex: none; }
.dsqe_btn {
  appearance: none;
  border: 0;
  margin: 0;
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  padding: 6px 14px;
  border-radius: 9px;
  cursor: pointer;
}
.dsqe_btnCancel {
  background: rgba(127, 127, 127, 0.18);
  color: var(--dsqe-label);
}
.dsqe_btnCancel:hover { background: rgba(127, 127, 127, 0.28); }
.dsqe_btnSend {
  background: var(--dsqe-send-bg);
  color: var(--dsqe-send-label);
}
.dsqe_btnSend:hover { filter: brightness(1.08); }
.dsqe_btnSend[disabled] { opacity: 0.45; cursor: default; filter: none; }

/* ---------- 行内胶囊（宿主 reference-chip 节点） ---------- */
/* The chip is the host's own inline reference node; we only add the ring that
   marks the quote whose source text is currently underlined. */
[data-composer-chip='dsh-quote'] { cursor: pointer; }
[data-composer-chip='dsh-quote'][data-dsqe-active] {
  outline: 2px solid var(--dsqe-src-line);
  outline-offset: 1px;
  border-radius: 6px;
}

/* ---------- 宿主视图不可用时的兜底气泡 ---------- */
.dsqe-fallbackRow {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}
.dsqe-fallbackBubble {
  max-width: 76%;
  padding: 10px 16px;
  border-radius: 22px;
  /* Delegation failed (host view not identifiable) — keep the host's own user
     bubble token so the row still looks like a message, not like a chip. */
  background: var(--dsw-specific-bubble, var(--dsqe-chip-bg));
  color: var(--dsw-alias-label-primary, var(--dsqe-label));
  font-size: 14px;
  line-height: 22px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  box-sizing: border-box;
}
`

const STYLE_ATTR = 'data-plugin-css'
const STYLE_ID = 'dsh-plugin-select-quote-with-edit/client.css'

export function ensureStyles(): void {
  if (document.querySelector(`style[${STYLE_ATTR}="${STYLE_ID}"]`)) return
  const element = document.createElement('style')
  element.setAttribute(STYLE_ATTR, STYLE_ID)
  element.textContent = CSS
  document.head.appendChild(element)
}
