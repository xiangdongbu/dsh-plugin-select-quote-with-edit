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
  'client inject list is [slots, locale]',
  Array.isArray(exports.inject) && exports.inject.join(',') === 'slots,locale',
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
check('registers shell.overlay toolbar', slotOf('shell.overlay').length === 1)
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
