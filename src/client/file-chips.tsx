/**
 * 拖进输入框的文件 / 文件夹 → 胶囊。
 *
 * 三件事：
 *
 * 1. **输入框**：宿主自己也会处理拖入（带真实路径的非图片文件变成 `@路径`
 *    chip），但它的引用源在有些 profile 里退化成一串纯文本。这里在 document
 *    捕获阶段先接手：拿到真实路径（桌面端 `__DSH_HOST_PATHS__.pathFor`，网页
 *    端退回 `text/uri-list`），插入一颗我们自己的 reference-chip，来源是
 *    {@link FILE_SOURCE}，ref 就是 `@绝对路径`。
 * 2. **点击**：胶囊的点击由宿主交给该来源的 `openReference`，这里转给
 *    `dsh-better-sidebar` 的 `openFile`，在右侧编辑器打开。
 * 3. **发送后**：消息里留下的是一段文本（`@/abs/file`，目录带尾斜杠），正文
 *    的 user-text 规则（file-mention.ts）把它重新渲染成同样的胶囊：文件可点，
 *    文件夹只显示、不可点。
 *
 * 图片不在这里拦：它们该走宿主的附件上传。
 */
import React from 'react'
import { t } from './i18n.ts'
import { FileIcon, FolderIcon } from './icons.tsx'
import { insertReferenceChip } from './inline-chips.ts'
import {
  displayName,
  fileMentionRule,
  mentionText,
  normalizePath,
  parseMentionText,
  pathFromUriList,
  type FileMention,
} from './file-mention.ts'
import { ensureStyles } from './styles.ts'

/** 我们的引用来源名（与 quote 源并列注册在宿主的 inputTriggers 上）。 */
export const FILE_SOURCE = 'dsh-file'
/** 触发字符：永远不会被输入，只为拿到 codec 与点击路由。 */
const SOURCE_TRIGGER = '\u0003'

export interface FileChipDeps {
  /** 在右侧编辑器打开一个绝对路径。返回 false = 打不开（会提示）。 */
  openFile(path: string): boolean
  /** 失败时的轻提示。 */
  hint(text: string): void
}

/**
 * 当前生效的「打开文件」入口（index.tsx 装配时写入）。
 *
 * 胶囊组件有两种用法：正文规则渲染（没有 props 可以传依赖）和插槽注册，
 * 统一从这里取，避免两处各接一套服务。
 */
let openFileByPath: ((path: string) => boolean) | null = null

export function setFileOpener(fn: ((path: string) => boolean) | null): void {
  openFileByPath = fn
}

/** 打开一颗胶囊指向的文件；没有装配入口时什么都不做。 */
export function openFileChip(path: string): boolean {
  return openFileByPath?.(path) ?? false
}

/** 正文里的胶囊：文件可点开；文件夹只有颜色和图标，不可点。 */
export function FileRefChip(props: {
  node?: { data?: { path?: unknown; directory?: unknown } }
  raw?: string
  open?: (path: string) => boolean
}): React.ReactNode {
  ensureStyles()
  const data = props.node?.data ?? {}
  const path = typeof data.path === 'string' ? data.path : ''
  const directory = data.directory === true
  // 读不出路径时退回原文，绝不吞字。
  if (path === '') {
    return <span className="dsqe_fileChipRaw">{props.raw ?? ''}</span>
  }
  const name = displayName(path, directory)
  if (directory) {
    // 目录给整条路径：它不可点，路径本身就是能读到的东西。
    return (
      <span
        className="dsqe_dirChip"
        data-dsqe-filechip="dir"
        title={`${path}/ · ${t('filechip.folder')}`}
      >
        <span className="dsqe_fileChipIcon" aria-hidden="true">
          <FolderIcon />
        </span>
        <span className="dsqe_fileChipName">{`${path}/`}</span>
      </span>
    )
  }
  const open = (event: React.SyntheticEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    if (props.open !== undefined) props.open(path)
    else openFileChip(path)
  }
  return (
    <span
      className="dsqe_fileChip"
      data-dsqe-filechip="file"
      role="link"
      tabIndex={0}
      title={`${path} · ${t('filechip.open')}`}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') open(event)
      }}
    >
      <span className="dsqe_fileChipIcon" aria-hidden="true">
        <FileIcon />
      </span>
      <span className="dsqe_fileChipName">{name}</span>
    </span>
  )
}

/** 宿主 inputTriggers 的最小形状。 */
interface TriggerService {
  registerSource(source: unknown): () => void
}

/**
 * 注册文件胶囊的来源：codec 让胶囊在提交时序列化成 `@路径`，点击路由把
 * chip 的 ref 交给右侧编辑器。服务可能比本插件晚挂载，所以按 quote 源同样的
 * 方式短暂重试。
 */
export function registerFileSource(
  ctx: { get?: (name: string) => unknown },
  deps: Pick<FileChipDeps, 'openFile'>,
): () => void {
  let dispose: (() => void) | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let attempts = 0

  const install = (): boolean => {
    if (dispose !== null) return true
    let service: TriggerService | null = null
    try {
      service = (ctx.get?.('inputTriggers') as TriggerService | undefined) ?? null
    } catch {
      service = null
    }
    if (!service || typeof service.registerSource !== 'function') return false
    try {
      dispose = service.registerSource({
        trigger: SOURCE_TRIGGER,
        name: FILE_SOURCE,
        codec: {
          clipboardText: (ref: string) => ref,
          serialize: (ref: string) => Promise.resolve(ref),
        },
        openReference: (
          _session: unknown,
          reference: { ref?: unknown },
        ): boolean => {
          const mention = typeof reference?.ref === 'string' ? reference.ref : ''
          const parsed = parseMentionText(mention)
          // 文件夹不可点；打不开时由 deps 自己提示。
          if (parsed === null || parsed.directory) return false
          return deps.openFile(parsed.path)
        },
      })
    } catch {
      dispose = () => {}
    }
    return true
  }

  if (!install() && typeof window !== 'undefined') {
    timer = setInterval(() => {
      attempts += 1
      if (install() || attempts >= 40) {
        if (timer !== null) clearInterval(timer)
        timer = null
      }
    }, 250)
  }

  return () => {
    if (timer !== null) clearInterval(timer)
    timer = null
    dispose?.()
    dispose = null
  }
}

/** 注销句柄：宿主返回的 disposer 形状不保证。 */
function toDisposer(value: unknown): () => void {
  return typeof value === 'function' ? (value as () => void) : () => {}
}

/**
 * 把正文规则挂到 `uiConversation.userText`。服务没就绪时什么都不做（正文退回
 * 纯文本，不影响别的功能）。
 */
export function registerFileMentionRule(uiConversation: unknown): () => void {
  const service = uiConversation as
    | { userText?: { register?: (rule: unknown) => unknown } }
    | undefined
  const register = service?.userText?.register
  if (typeof register !== 'function' || service?.userText === undefined) return () => {}
  try {
    return toDisposer(register.call(service.userText, fileMentionRule))
  } catch {
    return () => {}
  }
}

/** 桌面端桥：真实路径（Electron 的 webUtils.getPathForFile）。 */
interface HostPathBridge {
  pathFor?(file: File): string
}

function bridgeOf(): HostPathBridge | undefined {
  return (globalThis as { __DSH_HOST_PATHS__?: HostPathBridge }).__DSH_HOST_PATHS__
}

/**
 * 从一次拖放里取出「该变成胶囊」的条目。
 *
 * 图片不取（留给宿主的附件上传）；拿不到真实路径的也不取（网页端的外部
 * 文件没有本机路径，硬编一个反而是错的）。items 存在但一个都没命中时**不再**
 * 退回 uri-list，否则会把被跳过的那张图片当成文件引用。
 */
export function collectDropped(data: DataTransfer): FileMention[] {
  const bridge = bridgeOf()
  const out: FileMention[] = []
  const items = data.items ? Array.from(data.items) : []
  if (items.length > 0) {
    for (const item of items) {
      if (item.kind !== 'file') continue
      let file: File | null = null
      try {
        file = item.getAsFile()
      } catch {
        file = null
      }
      if (file === null) continue
      let directory = false
      try {
        const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
        directory = entry?.isDirectory === true
      } catch {
        directory = false
      }
      if (!directory && file.type.startsWith('image/')) continue
      let path = ''
      try {
        path = bridge?.pathFor?.(file) ?? ''
      } catch {
        path = ''
      }
      const clean = normalizePath(path)
      if (clean === null) continue
      out.push({ path: clean, directory })
    }
    return out
  }
  // 没有 items 明细（老浏览器 / 跨应用拖拽）：只能从 uri-list 里抠一条。
  const uri = pathFromUriList(data.getData('text/uri-list'))
  if (uri !== null) out.push({ path: uri, directory: false })
  return out
}

/** 拖放点是否落在输入框（编辑器本身或它的外接矩形）里。 */
function droppedInComposer(target: EventTarget | null, x: number, y: number): boolean {
  const element = target instanceof Element ? target : null
  if (element !== null && element.closest('[data-lexical-editor="true"]') !== null) return true
  const editor = document.querySelector('[data-lexical-editor="true"]')
  if (!(editor instanceof HTMLElement)) return false
  const rect = editor.getBoundingClientRect()
  return x >= rect.left - 8 && x <= rect.right + 8 && y >= rect.top - 8 && y <= rect.bottom + 8
}

/** 胶囊插不进去时的兜底：把路径当普通文本插到光标处。 */
function insertPlainText(text: string): void {
  if (text === '') return
  let inserted = false
  try {
    inserted = document.execCommand('insertText', false, text)
  } catch {
    inserted = false
  }
  if (!inserted) {
    const draft = document.querySelector('[data-lexical-editor="true"]')
    if (draft instanceof HTMLElement) draft.focus()
  }
}

/**
 * document 捕获阶段接管拖入：只在落点位于输入框、且确实拿到了本机路径时
 * 才阻止宿主的默认处理。图片、网页端的外部文件一律不拦。
 */
export function watchFileDrops(deps: FileChipDeps): () => void {
  const onDrop = (event: DragEvent): void => {
    if (event.defaultPrevented) return
    const data = event.dataTransfer
    if (data === null) return
    if (!droppedInComposer(event.target, event.clientX, event.clientY)) return
    const items = collectDropped(data)
    if (items.length === 0) return

    // 宿主（Lexical）自己的 drop 处理不认 defaultPrevented，必须拦住事件本身。
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()

    let placed = 0
    const fallback: string[] = []
    for (const item of items) {
      const mention = mentionText(item.path, item.directory)
      const ok = insertReferenceChip({
        source: FILE_SOURCE,
        ref: mention,
        // 文件夹直接显示路径（不可点），文件显示文件名（悬停看全路径）。
        label: item.directory ? `${item.path}/` : displayName(item.path, item.directory),
        appearance: item.directory ? 'folder' : 'file',
        clipboardText: mention,
      })
      if (ok) placed += 1
      else fallback.push(mention)
    }
    if (placed === 0) {
      deps.hint(t('filechip.insertFailed'))
      insertPlainText(fallback.join(' '))
    }
  }
  document.addEventListener('drop', onDrop, true)
  return () => {
    document.removeEventListener('drop', onDrop, true)
  }
}
