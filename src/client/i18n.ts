/**
 * Interface language follows the host: dictionaries go to `ctx.locale` and
 * `t()` resolves against the user's active language every call.
 */

type Dict = Record<string, string>

export const DICTIONARIES: Record<string, Dict> = {
  zh: {
    'toolbar.copy': '复制',
    'toolbar.copied': '已复制',
    'toolbar.add': '添加到对话',
    'chip.remove': '删除引用',
    'chip.longRemove': '删除超长文本',
    'chip.locate': '点击定位到原文',
    'chip.openDetail': '点击查看全文',
    'locate.missing': '没找到原文，它可能在更早、尚未加载的消息里',
    'detail.title': '引用详情',
    'detail.titleLong': '超长文本',
    'detail.tab': '引用',
    'detail.nameText': '引用文本',
    'detail.nameJson': '引用文本 · JSON',
    'detail.lines': '{count} 行',
    'detail.chars': '{count} 字符',
    'detail.wrapOn': '自动换行',
    'detail.wrapOff': '不换行',
    'detail.expand': '展开',
    'detail.collapse': '折叠',
    'detail.close': '关闭',
    'detail.copy': '复制全文',
    'detail.copied': '已复制',
    'detail.empty': '没有要展示的内容',
    'resize.handle': '拖拽调整输入框高度，双击复原',
    'row.copy': '复制',
    'row.copied': '已复制',
    'row.edit': '编辑',
    'row.undo': '撤回',
    'undo.failed': '撤回失败，请确认已安装回退插件',
    'editor.cancel': '取消',
    'editor.send': '发送',
    'editor.hint': '编辑后将从此处重新开始对话，已有产物不会被删除',
    'editor.removeQuote': '删除引用',
    'time.yesterday': '昨天',
    'time.sameYear': '{m}月{d}日',
    'time.otherYear': '{y}年{m}月{d}日',
  },
  en: {
    'toolbar.copy': 'Copy',
    'toolbar.copied': 'Copied',
    'toolbar.add': 'Add to conversation',
    'chip.remove': 'Remove quote',
    'chip.longRemove': 'Remove long text',
    'chip.locate': 'Click to jump to the source',
    'chip.openDetail': 'Click to read the full text',
    'locate.missing': 'Source not found — it may be in an earlier message that is not loaded yet',
    'detail.title': 'Quote detail',
    'detail.titleLong': 'Long text',
    'detail.tab': 'Quote',
    'detail.nameText': 'Quoted text',
    'detail.nameJson': 'Quoted text · JSON',
    'detail.lines': '{count} lines',
    'detail.chars': '{count} chars',
    'detail.wrapOn': 'Wrap',
    'detail.wrapOff': 'No wrap',
    'detail.expand': 'Expand',
    'detail.collapse': 'Collapse',
    'detail.close': 'Close',
    'detail.copy': 'Copy full text',
    'detail.copied': 'Copied',
    'detail.empty': 'Nothing to show',
    'resize.handle': 'Drag to resize the composer, double-click to reset',
    'row.copy': 'Copy',
    'row.copied': 'Copied',
    'row.edit': 'Edit',
    'row.undo': 'Undo',
    'undo.failed': 'Undo failed — is the rewind plugin installed?',
    'editor.cancel': 'Cancel',
    'editor.send': 'Send',
    'editor.hint': 'Editing restarts the conversation from here; existing artifacts are kept.',
    'editor.removeQuote': 'Remove quote',
    'time.yesterday': 'Yesterday',
    'time.sameYear': '{m}/{d}',
    'time.otherYear': '{y}/{m}/{d}',
  },
}

export const LOCALE_KEYS = Object.keys(DICTIONARIES.zh)

let translate: (key: string) => string = (key) => DICTIONARIES.zh[key] ?? DICTIONARIES.en[key] ?? key

export function bindLocale(options: { translate: (key: string) => string }): void {
  translate = options.translate
}

export function t(key: string): string {
  return translate(key)
}
