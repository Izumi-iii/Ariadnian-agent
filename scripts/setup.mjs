// npm run setup —— 安装后端（uv）和前端（npm）依赖，并生成 backend/.env
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { BACKEND, FRONTEND, log, requireTools, run, warn } from './lib.mjs'

requireTools()

log('安装后端依赖（uv sync）')
run('uv', ['sync'], { cwd: BACKEND })

log('安装前端依赖（npm install）')
run('npm', ['install', '--no-audit', '--no-fund'], { cwd: FRONTEND })

const env = join(BACKEND, '.env')
if (!existsSync(env)) {
  copyFileSync(join(BACKEND, '.env.example'), env)
  warn('已生成 backend/.env，请填写 LLM_API_KEY 等配置（不想配置可以先用 npm run demo 离线体验）')
}

log('完成。接下来：')
console.log('    npm run dev     开发模式（前后端热更新，自动打开浏览器）')
console.log('    npm run demo    离线演示（不调用模型，不需要 API key）')
console.log('    npm start       生产模式（构建前端，单端口 http://localhost:8000）')
