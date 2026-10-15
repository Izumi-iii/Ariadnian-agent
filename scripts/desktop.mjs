// npm run desktop —— 打包桌面版（pywebview + PyInstaller）
//   npm run desktop              构建前端 → PyInstaller 打包到 desktop/dist/Ariadne/ → （Windows 且装了 Inno Setup）生成安装程序
//   npm run desktop -- --dev     不打包，直接以桌面窗口运行当前代码，方便调试
// 版本号取自根目录 package.json，也可以用环境变量 ARIADNE_VERSION 覆盖
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BACKEND, FRONTEND, ROOT, ensureInstalled, has, isWin, log, paint, requireTools, run, warn } from './lib.mjs'

requireTools()
ensureInstalled()
const dev = process.argv.includes('--dev')
const version = process.env.ARIADNE_VERSION ?? JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '0.1.0'
const env = { ...process.env, PYTHONUTF8: '1', ARIADNE_VERSION: version }

log('构建前端')
run('npm', ['run', 'build'], { cwd: FRONTEND })

// 桌面版额外依赖只在这里临时装（uv run --with），不改动后端的依赖锁文件
if (dev) {
  log('以桌面窗口运行（开发模式，数据目录与打包版相同）')
  run('uv', ['run', '--with', 'pywebview>=6', 'python', '../desktop/launcher.py'], { cwd: BACKEND, env })
  process.exit(0)
}

log(`打包 Ariadne ${version}`)
const dist = join(ROOT, 'desktop', 'dist')
rmSync(join(dist, 'Ariadne'), { recursive: true, force: true })
run(
  'uv',
  ['run', '--with', 'pyinstaller>=6.10', '--with', 'pywebview>=6', 'pyinstaller', '../desktop/ariadne.spec', '--noconfirm',
    '--distpath', '../desktop/dist', '--workpath', '../desktop/build'],
  { cwd: BACKEND, env },
)
log(`程序目录：${paint('web', join(dist, 'Ariadne'))}`)

if (isWin) {
  const iscc = ['iscc', join(process.env['ProgramFiles(x86)'] ?? '', 'Inno Setup 6', 'ISCC.exe'), join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe')]
    .find((c) => c === 'iscc' ? has('iscc') : existsSync(c))
  if (iscc) {
    log('生成安装程序')
    run(iscc, [`/DAppVersion=${version}`, join(ROOT, 'desktop', 'installer.iss')])
    log(`安装程序：${paint('web', join(dist, `Ariadne-Setup-${version}.exe`))}`)
  } else {
    warn('没有找到 Inno Setup，跳过安装程序。安装：winget install JRSoftware.InnoSetup，之后重新运行即可')
  }
}
