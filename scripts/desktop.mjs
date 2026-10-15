// npm run desktop —— 打包 Electron 桌面版
//   npm run desktop              构建前端 → PyInstaller 打包后端 → electron-builder 生成安装包（desktop/dist/）
//   npm run desktop -- --dev     不打包，直接用 Electron 窗口运行当前源码，方便调试
// 版本号取自根目录 package.json，也可以用环境变量 ARIADNE_VERSION 覆盖
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BACKEND, FRONTEND, ROOT, ensureInstalled, log, paint, requireTools, run } from './lib.mjs'

requireTools()
ensureInstalled()
const dev = process.argv.includes('--dev')
const ELECTRON = join(ROOT, 'desktop', 'electron')
const version = process.env.ARIADNE_VERSION ?? JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '0.1.0'

// Electron 和打包工具要从 GitHub 下载二进制，国内很慢；本地默认走 npmmirror 镜像，CI 上直接用官方源
const env = { ...process.env, PYTHONUTF8: '1', ARIADNE_VERSION: version }
if (!process.env.CI) {
  env.ELECTRON_MIRROR ??= 'https://npmmirror.com/mirrors/electron/'
  env.ELECTRON_BUILDER_BINARIES_MIRROR ??= 'https://npmmirror.com/mirrors/electron-builder-binaries/'
}

if (!existsSync(join(ELECTRON, 'node_modules', 'electron'))) {
  log('安装 Electron（首次需要几分钟）')
  run('npm', ['install', '--no-audit', '--no-fund'], { cwd: ELECTRON, env })
}

log('构建前端')
run('npm', ['run', 'build'], { cwd: FRONTEND })

if (dev) {
  log('用 Electron 窗口运行源码（数据目录与打包版相同）')
  run('npx', ['electron', '.'], { cwd: ELECTRON, env })
  process.exit(0)
}

log(`打包后端 ${version}`)
rmSync(join(ROOT, 'desktop', 'dist', 'ariadne-server'), { recursive: true, force: true })
run(
  'uv',
  ['run', '--with', 'pyinstaller>=6.10', 'pyinstaller', '../desktop/ariadne.spec', '--noconfirm',
    '--distpath', '../desktop/dist', '--workpath', '../desktop/build'],
  { cwd: BACKEND, env },
)

log('打包桌面应用')
run('npx', ['electron-builder', '--publish', 'never', `-c.extraMetadata.version=${version}`], { cwd: ELECTRON, env })
log(`完成：${paint('web', join(ROOT, 'desktop', 'dist'))}`)
