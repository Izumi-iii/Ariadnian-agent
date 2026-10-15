// npm start —— 构建前端（有改动才重新构建），由后端单端口提供服务：http://localhost:8000
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { BACKEND, FRONTEND, ensureInstalled, killTree, log, openBrowser, paint, requireTools, run, serve, waitFor } from './lib.mjs'

requireTools()
ensureInstalled()

const newest = (dir) => {
  let t = 0
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name)
    t = Math.max(t, f.isDirectory() ? newest(p) : statSync(p).mtimeMs)
  }
  return t
}
const dist = join(FRONTEND, 'dist', 'index.html')
const srcTime = Math.max(newest(join(FRONTEND, 'src')), statSync(join(FRONTEND, 'package.json')).mtimeMs)
if (!existsSync(dist) || statSync(dist).mtimeMs < srcTime) {
  log('构建前端')
  run('npm', ['run', 'build'], { cwd: FRONTEND })
} else log('前端没有改动，跳过构建')

const port = process.env.PORT ?? '8000'
const api = serve('api', 'uv', ['run', 'uvicorn', 'app.main:app', '--host', process.env.HOST ?? '127.0.0.1', '--port', port], { cwd: BACKEND })
const stop = () => {
  killTree(api)
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
api.on('exit', (code) => process.exit(code ?? 0))

if (await waitFor(`http://127.0.0.1:${port}/api/health`)) {
  log(`已就绪：${paint('web', `http://localhost:${port}`)}   （Ctrl+C 退出）`)
  if (!process.env.NO_OPEN) openBrowser(`http://localhost:${port}`)
}
