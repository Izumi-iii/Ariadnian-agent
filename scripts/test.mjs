// npm test —— 后端测试（离线，不需要 API key）+ 前端类型检查
import { BACKEND, FRONTEND, ensureInstalled, log, requireTools, run } from './lib.mjs'

requireTools()
ensureInstalled()
log('后端测试')
run('uv', ['run', 'pytest', '-q'], { cwd: BACKEND })
log('前端类型检查')
run('npx', ['tsc', '-b'], { cwd: FRONTEND })
log('全部通过')
