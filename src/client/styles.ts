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
}

/* ---------- 消息行标记（悬停 chrome / 编辑器的定位上下文） ---------- */
.dsqe_row { position: relative; }
.dsqe_rowPad {
  --dsqe-hover-pad: 30px;
  padding-bottom: var(--dsqe-hover-pad) !important;
}
.dsqe_rowEditing .dsqe_marker { display: none; }
.dsqe_marker { display: contents; }

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
.dsqe-chipDel {
  appearance: none;
  border: 0;
  margin: 0;
  padding: 0;
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--dsqe-label-2);
  cursor: pointer;
}
.dsqe-chipDel:hover { background: rgba(127, 127, 127, 0.18); color: var(--dsqe-label); }
.dsqe-chipDel svg { width: 12px; height: 12px; }

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
.dsqe-bubbleRow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.dsqe-bubbleText { min-width: 0; }
.dsqe-quoteBody { margin-top: 6px; white-space: pre-wrap; }
.dsqe-userImages {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}
.dsqe-userImages img { max-width: 240px; max-height: 240px; border-radius: 12px; }

/* ---------- 悬停操作行（时间 / 编辑 / 复制） ---------- */
.dsqe_actions {
  position: absolute;
  /* 行在悬停时带 30px 底部留白；从行底回退这段留白再贴 4px，
     让操作行紧贴气泡下缘（参考 UI 的间距） */
  top: calc(100% - var(--dsqe-hover-pad, 30px) + 4px);
  right: 10px;
  display: none;
  align-items: center;
  z-index: 6;
}
.dsqe_actions[data-shown='true'] { display: inline-flex; }
.dsqe_time {
  font-size: 12px;
  line-height: 17px;
  color: var(--dsqe-label-2);
  margin-right: 8px;
  user-select: none;
}
.dsqe_iconBtn {
  appearance: none;
  border: 0;
  margin: 0;
  padding: 0;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--dsqe-label-2);
  cursor: pointer;
}
.dsqe_iconBtn:hover { background: rgba(127, 127, 127, 0.16); color: var(--dsqe-label); }
.dsqe_iconBtn svg { width: 14px; height: 14px; }

/* ---------- 内联编辑器 ---------- */
.dsqe_editor {
  position: relative;
  z-index: 6;
  margin-top: 8px;
  border-radius: 16px;
  background: var(--dsqe-card);
  box-shadow: var(--dsqe-elev);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  animation: dsqe-rise-in 0.12s ease-out;
}
.dsqe_editBody {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
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
  flex: 1 1 140px;
  min-width: 0;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsqe-label);
  outline: none;
  min-height: 22px;
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
  background: var(--dsqe-chip-bg);
  color: var(--dsqe-label);
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
