/**
 * 无头校验：在浏览器之外验证 lib/ 产物。
 *
 * - lib/client.js 能在假 `window.__ModuleLoader__` 里加载，工厂返回的
 *   exports 能在 mock ctx 上完成 apply()：4 类 slot 注册 + 词典注册；
 * - 词典 zh/en 每个键都能解析出非空文案；
 * - 协议读写闭环（compose → scan / readComposedDraft）、坏块剥离、标记清理；
 * - store 的会话持久化（写入 → 新实例恢复 → 清除 → 过期修剪）；
 * - 产物卫生检查：不得 require 任何宿主包，echo 观察器必须监听
 *   characterData，包装头必须带正确的插件 id。
 *
 * 用法：node scripts/verify.mjs（先 npm run build）
 */
import { readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const LOCALE_NS_TEST = 'select-quote-with-edit'
const nodeRequire = createRequire(import.meta.url)

let failures = 0
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok  ${name}`)
  } else {
    failures += 1
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---------------------------------------------------------------- browser stubs
function makeStubs() {
  const styleElements = []
  const document = {
    body: null,
    head: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null
    },
    querySelectorAll() {
      return []
    },
    createElement(tag) {
      const element = {
        tagName: tag,
        style: { setProperty() {}, removeProperty() {}, position: '', opacity: '' },
        attributes: {},
        children: [],
        textContent: '',
        setAttribute(name, value) {
          this.attributes[name] = value
        },
        getAttribute(name) {
          return this.attributes[name]
        },
        appendChild(child) {
          this.children.push(child)
        },
        remove() {},
        select() {},
      }
      if (tag === 'style') styleElements.push(element)
      return element
    },
    createTreeWalker() {
      return { nextNode: () => null }
    },
    execCommand() {
      return false
    },
    __styleElements: styleElements,
  }
  document.body = {
    appendChild() {},
    parentElement: null,
    nodeType: 1,
    closest() {
      return null
    },
    matches() {
      return false
    },
    querySelector() {
      return null
    },
    querySelectorAll() {
      return []
    },
  }

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback
    }
    observe() {}
    disconnect() {}
  }

  class FakeResizeObserver {
    observe() {}
    disconnect() {}
    unobserve() {}
  }

  const window = {
    __ModuleLoader__: {
      loaded: [],
      load(definition) {
        this.loaded.push(definition)
      },
    },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    innerWidth: 1280,
    innerHeight: 800,
    localStorage: undefined,
    getSelection: () => null,
  }
  const navigator = { clipboard: undefined }
  return { window, document, FakeMutationObserver, FakeResizeObserver, navigator }
}

function runClientFactory(code, stubs) {
  const run = new Function(
    'window',
    'document',
    'MutationObserver',
    'ResizeObserver',
    'navigator',
    'NodeFilter',
    'Node',
    code,
  )
  run(
    stubs.window,
    stubs.document,
    stubs.FakeMutationObserver,
    stubs.FakeResizeObserver,
    stubs.navigator,
    { SHOW_TEXT: 4 },
    { TEXT_NODE: 3, ELEMENT_NODE: 1 },
  )
  const definitions = stubs.window.__ModuleLoader__.loaded
  if (definitions.length !== 1) {
    throw new Error(`expected exactly one module registration, got ${definitions.length}`)
  }
  const definition = definitions[0]
  const requireTable = {
    react: nodeRequire('react'),
    'react-dom': nodeRequire('react-dom'),
    'react-dom/client': nodeRequire('react-dom/client'),
  }
  const exports = definition.factory((name) => {
    const value = requireTable[name]
    if (value === undefined) throw new Error(`bundle requires unknown module "${name}"`)
    return value
  })
  return { definition, exports }
}

// ---------------------------------------------------------------- apply() smoke
function mockContext() {
  const registered = { slots: [], dicts: null, effects: [] }
  const ctx = {
    effect(fn, label) {
      const result = fn()
      registered.effects.push(label)
      return typeof result === 'function' ? result : undefined
    },
    slots: {
      inject(name, register) {
        register()
      },
      register(def, component) {
        registered.slots.push({ def, component })
      },
      entries() {
        return []
      },
    },
    locale: {
      register(ns, dictsOrId, maybeDict) {
        if (typeof dictsOrId === 'string') {
          registered.dicts = registered.dicts ?? {}
          registered.dicts[`${ns}/${dictsOrId}`] = maybeDict
        } else {
          registered.dicts = { ...registered.dicts, ...Object.fromEntries(
            Object.entries(dictsOrId).map(([id, dict]) => [`${ns}/${id}`, dict]),
          ) }
        }
        return undefined
      },
      bind(ns) {
        return (key) => {
          for (const [fullKey, dict] of Object.entries(registered.dicts ?? {})) {
            if (fullKey.startsWith(`${ns}/`) && typeof dict[key] === 'string') return dict[key]
          }
          throw new Error(`untranslated key "${key}" in namespace "${ns}"`)
        }
      },
      getSnapshot: () => ({ locales: [{ id: 'zh' }, { id: 'en' }], revision: 1 }),
      getLocale: () => ({ active: 'zh' }),
      subscribe: () => () => {},
    },
  }
  return { ctx, registered }
}

// ---------------------------------------------------------------- compile helpers
async function compileModule(entry, outfile) {
  await build({
    entryPoints: [resolve(root, entry)],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'es2022',
    outfile,
    logLevel: 'silent',
  })
  return await import(pathToFileURL(outfile).href)
}

// ---------------------------------------------------------------- main
const clientCode = readFileSync(resolve(root, 'lib/client.js'), 'utf8')
const stubs = makeStubs()
let exports
try {
  const result = runClientFactory(clientCode, stubs)
  exports = result.exports
  check('client bundle loads under __ModuleLoader__', true)
  check(
    'module id matches package name',
    stubs.window.__ModuleLoader__.loaded[0].id === pkg.name,
    stubs.window.__ModuleLoader__.loaded[0].id,
  )
} catch (error) {
  check('client bundle loads under __ModuleLoader__', false, String(error))
  process.exit(1)
}

check('client exports apply()', typeof exports.apply === 'function')
check(
  'client inject list is [slots, locale, sessions, sidebarRight, sidebarRightTabs]',
  Array.isArray(exports.inject) &&
    exports.inject.join(',') === 'slots,locale,sessions,sidebarRight,sidebarRightTabs',
  JSON.stringify(exports.inject),
)

const { ctx, registered } = mockContext()
try {
  exports.apply(ctx)
  check('apply() runs without throwing', true)
} catch (error) {
  check('apply() runs without throwing', false, String(error))
  process.exit(1)
}

const slotOf = (name) => registered.slots.filter((entry) => entry.def.name === name)
check(
  'registers shell.overlay toolbar + source mark + detail drawer',
  slotOf('shell.overlay').length === 3 &&
    slotOf('shell.overlay').some((entry) => entry.def.id === 'select-quote-with-edit-toolbar') &&
    slotOf('shell.overlay').some((entry) => entry.def.id === 'select-quote-with-edit-source-mark') &&
    slotOf('shell.overlay').some((entry) => entry.def.id === 'select-quote-with-edit-detail'),
  JSON.stringify(slotOf('shell.overlay').map((entry) => entry.def.id)),
)
check(
  'registers conversation.input.overlay bridge + card',
  slotOf('conversation.input.overlay').length === 2 &&
    slotOf('conversation.input.overlay').some((entry) => entry.def.id?.endsWith('-bridge')) &&
    slotOf('conversation.input.overlay').some((entry) => entry.def.id?.endsWith('-card')),
)
const chatNodes = slotOf('conversation.chat.node')
check(
  'registers user + steering chat nodes at priority -20 with locale chat',
  chatNodes.length === 2 &&
    chatNodes.every((entry) => entry.def.priority === -20 && entry.def.locale === 'chat') &&
    chatNodes.some((entry) => entry.def.key === 'user') &&
    chatNodes.some((entry) => entry.def.key === 'steering'),
)

const zhDict = registered.dicts?.[`${LOCALE_NS_TEST}/zh`]
const enDict = registered.dicts?.[`${LOCALE_NS_TEST}/en`]
check('registers zh + en dictionaries', Boolean(zhDict && enDict))
if (zhDict && enDict) {
  const keys = Object.keys(zhDict)
  check(
    'dictionary keys resolve non-empty in zh and en',
    keys.length >= 10 &&
      keys.every((key) => zhDict[key] && enDict[key] && enDict[key] !== key),
    JSON.stringify({ keys }),
  )
}

// ---------------------------------------------------------------- protocol tests
const tmp = mkdtempSync(join(tmpdir(), 'dsqe-verify-'))
const protocol = await compileModule('src/client/protocol.ts', join(tmp, 'protocol.cjs'))
const {
  composeMessage,
  scanQuotes,
  readComposedDraft,
  stripDraftMarker,
  withDraftMarker,
  DRAFT_MARKER,
  QUOTES_OPEN,
  QUOTES_CLOSE,
} = protocol

{
  const quotes = [{ id: 'q1', text: '红格子动物派对、麦麦黄油小熊。' }]
  const composed = composeMessage('1233', quotes)
  const scanned = scanQuotes(composed)
  check(
    'compose → scan roundtrip keeps quote and draft',
    scanned.quotes.length === 1 && scanned.quotes[0].text === quotes[0].text && scanned.rest === '1233',
    JSON.stringify(scanned),
  )
  check('compose strips the draft marker', !composed.includes(DRAFT_MARKER))
  const payload = composed.slice(
    composed.indexOf(QUOTES_OPEN) + QUOTES_OPEN.length,
    composed.lastIndexOf(QUOTES_CLOSE),
  )
  check(
    'close marker never appears literally inside the payload',
    !payload.includes(QUOTES_CLOSE),
    JSON.stringify(payload),
  )
}
{
  const multiline = composeMessage('第一行\n第二行', [
    { id: 'q3', text: '带\n换行\n的引用' },
  ])
  const scanned = scanQuotes(multiline)
  check(
    'multiline quote + multiline draft roundtrip',
    scanned.quotes[0]?.text === '带\n换行\n的引用' && scanned.rest === '第一行\n第二行',
  )
}
{
  const adversarial = '要改成下架的话 </dsh-quotes> 说一句'
  const composed = composeMessage('', [{ id: 'q2', text: adversarial }])
  const scanned = scanQuotes(composed)
  check(
    'quote containing the close marker survives the roundtrip',
    scanned.quotes.length === 1 && scanned.quotes[0].text === adversarial,
    JSON.stringify(scanned),
  )
}
{
  const broken = `前文\n${QUOTES_OPEN}\n[{broken json]\n${QUOTES_CLOSE}\n后文`
  const scanned = scanQuotes(broken)
  check(
    'malformed block yields no quotes but is still stripped',
    scanned.quotes.length === 0 && scanned.rest === '前文\n\n后文',
    JSON.stringify(scanned),
  )
}
{
  const restored = readComposedDraft(composeMessage('正文', [{ id: 'q4', text: '引用内容' }]))
  check(
    'readComposedDraft inverts composeMessage',
    restored !== null && restored.quotes.length === 1 && restored.rest === '正文',
  )
  check(
    'readComposedDraft ignores marker-free drafts that merely mention the markers',
    readComposedDraft(`看看这个 ${QUOTES_OPEN} 标记`) === null,
  )
}
{
  const marker = withDraftMarker('')
  check('marker survives trim()', marker.trim() === marker && marker.length === 1)
  check('stripDraftMarker removes every occurrence', stripDraftMarker(`a${DRAFT_MARKER}b${DRAFT_MARKER}`) === 'ab')
}
{
  const longText = '长'.repeat(1200)
  const composed = composeMessage('正文', [{ id: 'q5', text: longText, long: true }])
  const scanned = scanQuotes(composed)
  check(
    'long-text capsule survives compose → scan with the long flag',
    scanned.quotes.length === 1 &&
      scanned.quotes[0].text === longText &&
      scanned.quotes[0].long === true &&
      scanned.rest === '正文',
  )
  const restored = readComposedDraft(composed)
  check(
    'rewind-restore keeps the long flag on the refilled capsule',
    restored !== null && restored.quotes[0].long === true && restored.rest === '正文',
  )
  check(
    'selection quotes keep long unset (backward compatible payload)',
    scanQuotes(composeMessage('x', [{ id: 'q6', text: '普通引用' }])).quotes[0].long === undefined,
  )
  check(
    'long-text threshold is exported for the paste interceptor',
    typeof protocol.LONG_TEXT_THRESHOLD === 'number' && protocol.LONG_TEXT_THRESHOLD > 0,
  )
  check(
    'inline chip placeholders are stripped before the message is composed',
    composeMessage(`${protocol.CHIP_PLACEHOLDER}正文${protocol.CHIP_PLACEHOLDER}`, [
      { id: 'q7', text: '引用' },
    ]).endsWith('正文') &&
      !composeMessage(`${protocol.CHIP_PLACEHOLDER}正文`, [{ id: 'q8', text: 'x' }]).includes(
        protocol.CHIP_PLACEHOLDER,
      ),
  )
  check(
    'only a placeholder draft still folds into a sendable message',
    composeMessage(protocol.CHIP_PLACEHOLDER.repeat(2), [{ id: 'q9', text: '引用' }]).includes(
      '<dsh-quotes>',
    ),
  )
}

// ---------------------------------------------------------------- order tests
{
  const { CHIP_PLACEHOLDER, QUOTE_MARK, spotMapOf, withQuoteMarks } = protocol
  // The user's own case: 引用胶囊 + 文本1111 + 长文本胶囊 + 文本222.
  const draft = `${CHIP_PLACEHOLDER}文本1111${CHIP_PLACEHOLDER}文本222`
  const spots = spotMapOf(draft, ['qa', 'qb'])
  check(
    'order: every chip maps to its offset in the typed text',
    spots !== null && spots.get('qa') === 0 && spots.get('qb') === 6,
    JSON.stringify(spots === null ? null : [...spots]),
  )

  const quotes = [
    { id: 'qa', text: '引用内容' },
    { id: 'qb', text: '很长的一段文本', long: true },
  ]
  const composed = composeMessage(draft, quotes, spots)
  const scanned = scanQuotes(composed)
  check(
    'order: the wire payload carries each offset',
    scanned.quotes.length === 2 &&
      scanned.quotes[0].at === 0 &&
      scanned.quotes[1].at === 6 &&
      scanned.rest === '文本1111文本222',
    JSON.stringify({ quotes: scanned.quotes, rest: scanned.rest }),
  )
  const restored = readComposedDraft(composed)
  check(
    'order: withdraw refill recovers the same offsets',
    restored !== null && restored.quotes[0].at === 0 && restored.quotes[1].at === 6,
    JSON.stringify(restored === null ? null : restored.quotes),
  )

  check(
    'order: marks land at the recorded offsets',
    withQuoteMarks('文本1111文本222', [0, 6]) ===
      `${QUOTE_MARK}文本1111${QUOTE_MARK}文本222`,
    JSON.stringify(withQuoteMarks('文本1111文本222', [0, 6])),
  )
  check(
    'order: marks are clamped to the text and survive a reversed input',
    withQuoteMarks('abc', [9, 1]) === `a${QUOTE_MARK}bc${QUOTE_MARK}`,
    JSON.stringify(withQuoteMarks('abc', [9, 1])),
  )
  check(
    'order: leading whitespace never shifts an offset (it is trimmed)',
    JSON.stringify([...(spotMapOf(`\n\n  ${CHIP_PLACEHOLDER}正文`, ['qc']) ?? new Map())]) ===
      JSON.stringify([['qc', 0]]),
  )
  check(
    'order: a chip count mismatch gives up on positions instead of guessing',
    spotMapOf(draft, ['qa']) === null && spotMapOf(draft, ['qa', 'qb', 'qc']) === null,
  )
  check(
    'order: no chip means no offsets (row mode keeps the old layout)',
    spotMapOf('纯文本', []) === null,
  )
  check(
    'order: a stray restore mark never reaches the model',
    !composeMessage(`a${QUOTE_MARK}b`, [{ id: 'qd', text: '引用' }]).includes(QUOTE_MARK),
  )
  check(
    'order: messages without offsets still parse (backward compatible)',
    scanQuotes(composeMessage('正文', [{ id: 'qe', text: '旧引用' }])).quotes[0].at === undefined,
  )
}

// ---------------------------------------------------------------- locate tests
{
  const locate = await compileModule('src/client/locate.ts', join(tmp, 'locate.cjs'))
  const { normalizeQuote, candidateNeedles, buildIndex, findMatch } = locate

  check(
    'locate: normalization collapses whitespace + the draft zero-width marker',
    normalizeQuote('  但 \u200b node_modules\n\n里  ') === '但 node_modules 里',
    JSON.stringify(normalizeQuote('  但 \u200b node_modules\n\n里  ')),
  )

  // A rendered line: plain text → <code> → plain text, plus a following block.
  const chunks = [
    { text: '但 ' },
    { text: 'node_modules' },
    { text: ' 里这个包已经不存在了。\n' },
    { text: '要我把这两段', blockStart: true },
  ]
  const index = buildIndex(chunks)
  check(
    'locate: row index flattens nodes into one normalized line',
    index.text === '但 node_modules 里这个包已经不存在了。 要我把这两段',
    index.text,
  )
  const inline = findMatch(index, candidateNeedles('node_modules'))
  check(
    'locate: a match inside a code span maps back to that node + offset',
    inline !== null &&
      inline.start === 2 &&
      inline.end === 14 &&
      index.owner[inline.start] === 1 &&
      index.offset[inline.start] === 0 &&
      index.offset[inline.end - 1] === 11,
    JSON.stringify(inline),
  )
  const cross = findMatch(index, candidateNeedles('但 node_modules 里'))
  check(
    'locate: a match spanning text + code keeps both ends',
    cross !== null && index.owner[cross.start] === 0 && index.owner[cross.end - 1] === 2,
    JSON.stringify(cross),
  )
  check(
    'locate: block boundary supplies the space the DOM never had',
    findMatch(index, candidateNeedles('不存在了。 要我')) !== null,
  )
  check('locate: absent text yields no match', findMatch(index, candidateNeedles('完全不相干的一句话')) === null)

  // A quote whose newline came from a block boundary still matches.
  const twoBlocks = buildIndex([{ text: '第一段。' }, { text: '第二段', blockStart: true }])
  check(
    'locate: quote newline matches the implied block space',
    findMatch(twoBlocks, candidateNeedles('第一段。\n第二段')) !== null,
  )

  // Real markup puts a whitespace-only text node between the two blocks; it
  // must not turn the boundary into two spaces.
  const gap = buildIndex([
    { text: '段落一。' },
    { text: '\n      ', blockStart: true },
    { text: '段落二', blockStart: true },
  ])
  check('locate: a gap node between blocks yields exactly one space', gap.text === '段落一。 段落二', gap.text)
  check(
    'locate: cross-block quote still matches through the gap node',
    findMatch(gap, candidateNeedles('段落一。\n段落二')) !== null,
  )

  // Same phrase twice: the one nearest the composer wins.
  const repeated = buildIndex([{ text: '引用文本 A 引用文本 B 引用文本' }])
  const last = findMatch(repeated, candidateNeedles('引用文本'))
  check(
    'locate: the last occurrence wins (nearest the composer)',
    last !== null && last.start === repeated.text.lastIndexOf('引用文本'),
    JSON.stringify(last),
  )

  // Prefix fallback: a selection that crossed something unrenderable.
  const long = 'A'.repeat(200)
  const fallbackIndex = buildIndex([{ text: 'x ' + long + '!!' }])
  check(
    'locate: an over-long quote still lands via its opening clause',
    findMatch(fallbackIndex, candidateNeedles(long + 'Z'.repeat(50))) !== null,
  )
  const needles = candidateNeedles(long)
  check(
    'locate: candidates are longest-first and deduplicated',
    needles[0] === long && needles.length === 4 && new Set(needles).size === 4,
    JSON.stringify(needles.map((needle) => needle.length)),
  )
  const tiny = candidateNeedles('短引用')
  check('locate: short quotes keep exactly one candidate', tiny.length === 1 && tiny[0] === '短引用')
  check('locate: empty text never matches', candidateNeedles('   ').length === 0)

  // Underline geometry: `getClientRects()` reports one rect per inline run, so a
  // line with <code> yields several rects with different tops. They must merge
  // into ONE underline per visual line (two stacked lines was the 0.7.0 bug).
  const { linesOf } = locate
  globalThis.document = { querySelector: () => null }
  const rect = (left, top, width, height) => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  })
  const rangeStub = {
    startContainer: { isConnected: true },
    getClientRects: () => [
      rect(10, 100, 100, 18),
      rect(110, 101, 60, 20),
      rect(170, 100, 80, 18),
      rect(10, 124, 200, 18),
    ],
  }
  const rootStub = { getBoundingClientRect: () => ({ top: 0, bottom: 2000, left: 0, right: 2000 }) }
  const lines = linesOf({ range: rangeStub, root: rootStub, token: 1 })
  check(
    'locate: inline runs of one visual line merge into a single underline',
    lines.length === 2,
    JSON.stringify(lines),
  )
  check(
    'locate: the merged underline spans the whole line',
    Math.round(lines[0].left) === 10 && Math.round(lines[0].width) === 240,
    JSON.stringify(lines[0]),
  )
  delete globalThis.document
}

// ---------------------------------------------------------------- store tests
{
  const storage = new Map()
  const localStorageStub = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
    get length() {
      return storage.size
    },
    key: (index) => Array.from(storage.keys())[index] ?? null,
  }
  const storeA = await compileModule('src/client/store.ts', join(tmp, 'store-a.cjs'))
  const storeB = await compileModule('src/client/store.ts', join(tmp, 'store-b.cjs'))
  // store.ts reads window.localStorage (as in the browser) and registers a
  // `storage` listener for cross-tab adoption; expose the stub through the
  // same global and capture the listeners so the test can fire events.
  const storageListeners = {}
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: localStorageStub,
      addEventListener(type, fn) {
        ;(storageListeners[type] ??= []).push(fn)
      },
      removeEventListener() {},
    },
  })
  const offA = storeA.watchStorageAdoption()
  const offB = storeB.watchStorageAdoption()
  const fireStorage = (event) => {
    for (const handler of storageListeners.storage ?? []) handler(event)
  }

  storeA.bindSession('session-1')
  const added = storeA.addQuote('红格子动物派对、麦麦黄油小熊、花雕猫猫乐园。')
  check('addQuote stores the trimmed text', Boolean(added) && storeA.getQuotes()[0].text.includes('红格子'))
  check('quote is persisted to localStorage', storage.has('dsh.select-quote-with-edit.quotes.session-1'))

  storeB.bindSession('session-1')
  check(
    'a fresh module instance restores quotes from storage',
    storeB.getQuotes().length === 1 && storeB.getQuotes()[0].text === added.text,
    JSON.stringify(storeB.getQuotes()),
  )

  storeA.removeQuote(added.id)
  check('removeQuote clears the list and the storage key', storeA.getQuotes().length === 0 && !storage.has('dsh.select-quote-with-edit.quotes.session-1'))
  fireStorage({ key: 'dsh.select-quote-with-edit.quotes.session-1', storageArea: null })
  check('the other instance adopts the removal via the storage event', storeB.getQuotes().length === 0)
  if (typeof offA === 'function') offA()
  if (typeof offB === 'function') offB()

  storeA.bindSession(undefined)
  const orphan = storeA.addQuote('无会话引用')
  check('quotes without a session stay in memory', storeA.getQuotes().length === 1 && !storage.has('dsh.select-quote-with-edit.quotes.null'))
  storeA.clearQuotes()
  check('clearQuotes empties the pending bucket', orphan !== null && storeA.getQuotes().length === 0)

  storeA.bindSession('session-2')
  storeA.addQuote('过期会话引用')
  const oldKey = 'dsh.select-quote-with-edit.quotes.session-old'
  storage.set(oldKey, JSON.stringify({ v: 1, updatedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, items: [{ id: 'x', text: 'old' }] }))
  storeA.addQuote('触发修剪的引用')
  check('prune drops sessions older than 7 days', !storage.has(oldKey))

  // ---- long-text capsule persistence ----
  {
    const longKey = 'dsh.select-quote-with-edit.quotes.session-long'
    const longStore = await compileModule('src/client/store.ts', join(tmp, 'store-long.cjs'))
    longStore.bindSession('session-long')
    const longQuote = longStore.addQuote('粘贴的超长文本'.repeat(100), { long: true })
    const storedPayload = JSON.parse(storage.get(longKey) ?? '{}')
    check(
      'addQuote({ long: true }) persists the long flag',
      longQuote !== null && storedPayload.items?.[0]?.long === true,
      storage.get(longKey),
    )
    const reloaded = await compileModule('src/client/store.ts', join(tmp, 'store-long2.cjs'))
    reloaded.bindSession('session-long')
    const restoredList = reloaded.getQuotes()
    check(
      'a fresh instance restores the long flag from storage',
      restoredList.length === 1 && restoredList[0].long === true,
      JSON.stringify(restoredList),
    )
  }
  rmSync(tmp, { recursive: true, force: true })
}

// ---------------------------------------------------------------- bundle hygiene
check(
  'bundle never requires a host package',
  !/require\(\s*["']@deepseek-ai\//.test(clientCode),
)
check('echo observer watches characterData', clientCode.includes('characterData'))
check(
  'wrapper carries the expected plugin id',
  clientCode.includes(`window.__ModuleLoader__.load({`) && clientCode.includes(JSON.stringify(pkg.name)),
)
check('style injection is guarded (single <style>)', clientCode.includes('data-plugin-css'))
check(
  'editor chips ship icon-swapping × + preview logic',
  clientCode.includes('dsqe-echipDel') &&
    clientCode.includes('dsqe-echipIcon') &&
    clientCode.includes('dsqe-tipWrap'),
)
check('hover chrome watches pointer + time format dicts', clientCode.includes('time.sameYear') && clientCode.includes('pointerover'))
check(
  'edit pencil injects into the host actions row (data-clock hook)',
  clientCode.includes('[data-clock="start"]') && clientCode.includes('dsqe_hostEdit'),
)
check(
  'editor card is content-sized (fit-content)',
  clientCode.includes('fit-content'),
)
check(
  'undo (撤回) button ships next to edit + host injection',
  clientCode.includes('dsqe_hostUndo') &&
    clientCode.includes('dsqe_undoBtn') &&
    clientCode.includes('rewind-plugin') &&
    clientCode.includes('data-chat-anchor-key'),
)
check(
  'host-row edit/undo are per-row, persistent, and synced with the native copy button',
  clientCode.includes('data-dsqe-host-edit') &&
    clientCode.includes('data-dsqe-host-undo') &&
    clientCode.includes('ensureHostButtons') &&
    !clientCode.includes('hostEditBtn?.remove()'),
)
check(
  'composer chip swaps its icon for the delete × on hover',
  clientCode.includes('dsqe-chipDelIcon') &&
    clientCode.includes('dsqe-chipIcon') &&
    clientCode.includes('data-x-shown'),
)
check(
  'quote rows reserve constant action-row height (no layout jump)',
  clientCode.includes('dsqe_rowQuote') && !clientCode.includes('dsqe_rowPad'),
)
check(
  'sent quote bubble no longer duplicates the quote body text',
  !clientCode.includes('dsqe-quoteBody'),
)
check(
  'withdraw engine is bundled: dsh-rewind-plugin dependency + bundle row',
  typeof pkg.dependencies?.['dsh-rewind-plugin'] === 'string' &&
    readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8').includes('dsh-rewind-plugin'),
)
check(
  'the other plugin\'s ↶ button is hidden to avoid a duplicate',
  clientCode.includes('dsh-rewind-btn'),
)
check(
  'long-text paste becomes a capsule chip (threshold + doc icon + drawer)',
  clientCode.includes('LONG_TEXT_THRESHOLD') &&
    clientCode.includes('SVG_CLIP') &&
    clientCode.includes('data-openable') &&
    clientCode.includes('dsqe-drawer'),
)
check(
  'message capsules open the right-hand detail drawer',
  clientCode.includes('openDetail') && clientCode.includes('select-quote-with-edit-detail'),
)
check(
  'native sidebar tab is wired like dsh-file-review (register + openTabIn + tab slot)',
  clientCode.includes('sidebarRightTabs') &&
    clientCode.includes('openTabIn') &&
    clientCode.includes('sidebar.right.pane.tab') &&
    clientCode.includes('detailOpener'),
)
check(
  'JSON capsule bodies get the dedicated JSON view (detect + pretty print + line numbers)',
  clientCode.includes('looksLikeJson') &&
    clientCode.includes('displayJson') &&
    clientCode.includes('dsqe-code') &&
    clientCode.includes('dsqe-codeNo'),
)
check(
  'detail pane mirrors the native review tab (header + toolbar + sticky file card)',
  clientCode.includes('dsqe-paneHead') &&
    clientCode.includes('dsqe-paneTools') &&
    clientCode.includes('dsqe-fileCard') &&
    clientCode.includes('dsqe-fileChev') &&
    clientCode.includes('data-collapsed'),
)
check(
  'the pane scroller has no top padding, so the sticky header cannot be undercut',
  // A sticky header pins to the scrollport; padding-top would leave a band
  // above it where the scrolling code shows through.
  /\.dsqe-paneBody \{[^}]*padding: 0 12px 20px;/.test(clientCode) &&
    /\.dsqe-fileCard \{[^}]*margin-top: 12px;/.test(clientCode),
)
check(
  'the inline editor interleaves chips with the text by their recorded offset',
  clientCode.includes('fillEditBody') &&
    clientCode.includes('readEditBody') &&
    clientCode.includes('EDIT_CHIP_ATTR') &&
    clientCode.includes('contentEditable = "false"'),
)
check(
  'composer grip resizes the editor (drag + clamp + persistence + dblclick reset)',
  clientCode.includes('watchComposerResize') &&
    clientCode.includes('dsqe-rzHandle') &&
    clientCode.includes('COMPOSER_MIN_HEIGHT') &&
    clientCode.includes('COMPOSER_MAX_HEIGHT') &&
    clientCode.includes('composerHeight') &&
    clientCode.includes('dblclick'),
)
check(
  'composer chips jump to the source and underline it (no message DOM rewrite)',
  clientCode.includes('locateQuote') &&
    clientCode.includes('dsqe-srcMark') &&
    clientCode.includes('dsqe-srcToast') &&
    clientCode.includes('select-quote-with-edit-source-mark') &&
    clientCode.includes('getClientRects') &&
    clientCode.includes('data-active') &&
    // The underline must be painted, never injected into the message tree.
    !clientCode.includes('surroundContents'),
)
check(
  'quotes enter the composer as the host inline reference node, row is only a fallback',
  clientCode.includes('reference-chip') &&
    clientCode.includes('dsh-quote') &&
    clientCode.includes('registerSource') &&
    clientCode.includes('inputTriggers') &&
    clientCode.includes('insertQuoteChip') &&
    clientCode.includes('dsqe-active'),
)
check(
  'inline chips read the raw node fields (no $getNodeByKey outside an update)',
  clientCode.includes('__source') && clientCode.includes('__ref'),
)
check(
  'Backspace / Delete aimed at a chip removes it whole (capture-phase key handler)',
  clientCode.includes('watchChipDeletion') &&
    clientCode.includes('deleteAdjacentChip') &&
    clientCode.includes('data-composer-card'),
)
check(
  'inline mode never writes the U+200B marker (setDraft rebuilds the paragraphs)',
  clientCode.includes('mode !== "row"') || clientCode.includes("mode !== 'row'"),
)
check(
  'a chip is always placed inside a block, never straight into the root',
  // root.splice rejects a text node, and a root-level chip caret makes the next
  // keystroke open a second paragraph (the chip ended up on its own line).
  clientCode.includes('placeInBlock') && !clientCode.includes('root.append(chip)'),
)
check(
  'a fresh chip leaves the caret in a real text node (U+200B filler)',
  clientCode.includes('new TextKlass(DRAFT_MARKER)'),
)
check(
  'mark restore handles a mark at offset 0 (splitText(0) is not a split)',
  clientCode.includes('swap:head-failed'),
)
check(
  'select-all + Backspace also drops the chips in the selection',
  clientCode.includes('chipsInSelection') && clientCode.includes('removeChipsByRef'),
)
check(
  'one press clears chips *and* text (no execCommand, plus a beforeinput path)',
  // The sweep runs synchronously inside the key handler and again on
  // `beforeinput` (IME / insertText replace a selection without a printable
  // keydown). Relying on execCommand('delete') used to leave the typed text
  // behind — the host ignores it — which is why clearing took two presses.
  (() => {
    const execDeletes =
      (clientCode.split("execCommand('delete')").length - 1) +
      (clientCode.split('execCommand("delete")').length - 1)
    return (
      clientCode.includes('replacesSelectionWithInput') &&
      clientCode.includes('beforeinput') &&
      execDeletes === 0
    )
  })(),
)
check(
  'cut removes the selection through a keydown the host listens to',
  /new KeyboardEvent\("keydown", \{ key: "Backspace"/.test(clientCode),
)
check(
  'copy writes the v2 clipboard payload with each chip offset',
  clientCode.includes('dsh-quote-data') && clientCode.includes('v: 2'),
)

// ---------------------------------------------------------------- withdraw engine
{
  const wdir = mkdtempSync(join(tmpdir(), 'dsqe-withdraw-'))
  const withdraw = await compileModule('src/client/withdraw.ts', join(wdir, 'withdraw.cjs'))
  const { withdrawMessage, seqOfKey, imagesOfKey, restoreImages, ENGINE_COMMAND } = withdraw
  check('withdraw: engine command is the rewind plugin channel', ENGINE_COMMAND === 'rewind-plugin', ENGINE_COMMAND)
  const snapshot = { nodes: new Map([['k1', { data: { seq: 7 } }]]), order: ['k1'] }
  check('withdraw: seq resolves from the chat snapshot', seqOfKey(snapshot, 'k1') === 7)
  check('withdraw: unknown key has no seq', seqOfKey(snapshot, 'nope') === undefined)

  const wire = 'block\n<dsh-quotes>\n[{"text":"引用"}]\n</dsh-quotes>\n\n1233'
  let cmd = null
  let draft = null
  const deps = {
    sessionId: 's1',
    flowKey: 'k1',
    anchorKey: 'k1',
    getSessions: () => ({
      binding: () => ({
        session: {
          command: async (line) => {
            cmd = line
            return { ok: true, value: { matched: true } }
          },
        },
      }),
    }),
    getUiConversation: () => ({ binding: () => ({ target: () => ({ getSnapshot: () => snapshot }) }) }),
    getRaw: () => wire,
    setDraft: (text) => {
      draft = text
    },
    sleep: async () => {},
    waitMs: 0,
  }
  const ok = await withdrawMessage(deps)
  check(
    'withdraw: invokes /rewind-plugin @<seq> both',
    cmd === '/rewind-plugin @7 both',
    String(cmd),
  )
  check('withdraw: reports ok + refilled and restores the raw wire text', ok.ok === true && ok.refilled === true && draft === wire)
  {
    let release
    const pending = new Promise((resolve) => {
      release = resolve
    })
    let earlyDraft = null
    const run = withdrawMessage({
      ...deps,
      getSessions: () => ({ binding: () => ({ session: { command: () => pending } }) }),
      setDraft: (text) => {
        earlyDraft = text
      },
    })
    check(
      'withdraw: fills the composer immediately, before the (slow) command resolves',
      earlyDraft === wire,
      JSON.stringify(earlyDraft),
    )
    release({ ok: true, value: { matched: true } })
    await run
  }
  check(
    'withdraw: refilled quote block unfolds back into pending quotes',
    (() => {
      const restored = protocol.readComposedDraft(draft)
      return restored !== null && restored.quotes.length === 1 && restored.rest.includes('1233')
    })(),
  )

  const noSeq = await withdrawMessage({
    ...deps,
    getUiConversation: () => ({ binding: () => ({ target: () => ({ getSnapshot: () => ({ nodes: new Map() }) }) }) }),
    setDraft: () => {},
  })
  check('withdraw: no seq fails without refilling', noSeq.ok === false && noSeq.reason === 'no-seq', JSON.stringify(noSeq))

  const rejected = await withdrawMessage({
    ...deps,
    getSessions: () => ({ binding: () => ({ session: { command: async () => ({ ok: false }) } }) }),
  })
  check('withdraw: rejected command fails', rejected.ok === false && rejected.reason === 'command-rejected', JSON.stringify(rejected))

  const missing = await withdrawMessage({ ...deps, getSessions: () => undefined })
  check('withdraw: missing session service fails cleanly', missing.ok === false && missing.reason === 'no-session', JSON.stringify(missing))

  // ---- image restore ----
  const imageSnapshot = {
    nodes: new Map([
      [
        'img1',
        {
          data: {
            seq: 9,
            content: [
              { type: 'text', text: '看图' },
              { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', name: 'a.png' } },
              { type: 'image', attachment: { attachmentId: 'att-2', mediaType: 'image/jpeg' } },
              { type: 'file', attachment: { attachmentId: 'att-3', mediaType: 'application/pdf' } },
            ],
          },
        },
      ],
    ]),
    order: ['img1'],
  }
  const imgs = imagesOfKey(imageSnapshot, 'img1')
  check(
    'withdraw: collects image blocks only (skips text/file)',
    imgs.length === 2 && imgs[0].attachmentId === 'att-1' && imgs[1].mediaType === 'image/jpeg',
    JSON.stringify(imgs),
  )
  {
    const seen = { files: [], added: null, released: null }
    const restoredCount = await restoreImages(
      {
        sessionId: 's1',
        session: {
          readAttachment: async (id) => ({ ok: true, value: { data: new Uint8Array([id === 'att-1' ? 1 : 2]) } }),
        },
        scope: { token: 'scope' },
        getConversation: () => ({
          input: { for: () => ({ addAttachments: (ids) => { seen.added = ids; return true } }) },
          createDrafts: (_sid, files) => {
            seen.files = files
            return files.map((_f, i) => ({ id: `d${i}` }))
          },
          releaseDraftAttachments: (drafts) => {
            seen.released = drafts
          },
        }),
      },
      imgs,
    )
    check(
      'withdraw: restores images by reading bytes and adding drafts',
      restoredCount === 2 && seen.files.length === 2 && seen.added?.join(',') === 'd0,d1',
      JSON.stringify({ restoredCount, files: seen.files.length, added: seen.added }),
    )
    check('withdraw: restored image File keeps media type', seen.files[1]?.type === 'image/jpeg', seen.files[1]?.type)
  }
  {
    // Preferred path: composer's own inputActions.addAttachments (no scope needed).
    let addedViaActions = null
    let created = 0
    const count = await restoreImages(
      {
        sessionId: 's1',
        session: {
          readAttachment: async () => ({ ok: true, value: { data: new Uint8Array([1]) } }),
        },
        getConversation: () => ({
          createDrafts: (_sid, files) => {
            created = files.length
            return files.map((_f, i) => ({ id: `a${i}` }))
          },
        }),
        addAttachments: (ids) => {
          addedViaActions = ids
          return true
        },
      },
      imgs,
    )
    check(
      'withdraw: restores images via the composer addAttachments action',
      count === 2 && created === 2 && addedViaActions?.join(',') === 'a0,a1',
      JSON.stringify({ count, created, addedViaActions }),
    )
  }
  {
    const count = await restoreImages(
      { sessionId: 's1', session: undefined, scope: undefined, getConversation: () => undefined },
      imgs,
    )
    check('withdraw: image restore degrades to no-op without services', count === 0, String(count))
  }
  rmSync(wdir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- host half
{
  const host = await import(pathToFileURL(resolve(root, 'lib/index.js')).href)
  check('host half exports its package name', host.name === pkg.name, String(host.name))
  check('host half exports an apply function', typeof host.apply === 'function')
}

console.log('')
if (failures > 0) {
  console.error(`verify: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('verify: all checks passed')
