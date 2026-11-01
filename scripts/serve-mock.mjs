/** Static file server for the mock page: npm run mock → http://127.0.0.1:4173/test/mock/app.html */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/') pathname = '/test/mock/app.html'
    const filePath = normalize(join(root, pathname))
    if (!filePath.startsWith(root)) throw new Error('outside root')
    const body = await readFile(filePath)
    res.writeHead(200, { 'content-type': types[extname(filePath)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }
})

const port = Number(process.env.PORT ?? 4173)
server.listen(port, '127.0.0.1', () => {
  console.log(`[mock] http://127.0.0.1:${port}/test/mock/app.html`)
})
