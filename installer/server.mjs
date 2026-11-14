// Tiny static server for Mac / Linux (needs Node 18+). Windows uses start.ps1 instead.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exec } from 'node:child_process'
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'app')
const port = +process.env.PORT || 8080
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html'
  const f = path.join(root, path.normalize(p))
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found') }
  res.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res)
}).listen(port, '127.0.0.1', () => {
  const url = `http://localhost:${port}/`; console.log('RAS Hatchery running at ' + url + '  (Ctrl+C to stop)')
  exec(process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`, () => {})
})
