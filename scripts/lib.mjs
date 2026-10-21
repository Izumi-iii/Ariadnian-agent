// 启动脚本共用的小工具：只用 Node 内置模块，Windows / macOS / Linux 通用
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const BACKEND = join(ROOT, 'backend')
export const FRONTEND = join(ROOT, 'frontend')
export const isWin = process.platform === 'win32'

const COLORS = { api: '\x1b[34m', web: '\x1b[35m', ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', dim: '\x1b[2m' }
export const paint = (c, s) => `${COLORS[c] ?? ''}${s}\x1b[0m`
export const log = (msg) => console.log(paint('ok', '▸ ') + msg)
export const warn = (msg) => console.log(paint('warn', '! ') + msg)
export const fail = (msg) => {
  console.error(paint('err', '✗ ') + msg)
  process.exit(1)
}

// Windows 上 npm / npx 是 .cmd 脚本，必须经过 shell 才能执行。新版 Node 不允许“shell + 参数数组”
// （DEP0190 警告），所以在 Windows 上把命令和参数拼成一条带引号的命令行再交给 shell
const quote = (a) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)
function cmdline(cmd, args) {
  return isWin ? [[cmd, ...args].map(quote).join(' '), []] : [cmd, args]
}

export function has(cmd) {
  const r = spawnSync(...cmdline(cmd, ['--version']), { shell: isWin, stdio: 'ignore' })
  return r.status === 0
}

export function requireTools() {
  if (!has('uv')) fail('没有找到 uv。安装方法：https://docs.astral.sh/uv/getting-started/installation/ （Windows 可用 winget install astral-sh.uv）')
  if (!has('npm')) fail('没有找到 npm，请安装 Node.js 20 以上版本：https://nodejs.org/')
}

/** 同步执行一条命令，失败就退出 */
export function run(cmd, args, opts = {}) {
  console.log(paint('dim', `$ ${cmd} ${args.join(' ')}`))
  const r = spawnSync(...cmdline(cmd, args), { stdio: 'inherit', shell: isWin, ...opts })
  if (r.status !== 0) fail(`命令失败：${cmd} ${args.join(' ')}`)
}

/** 启动一个长期运行的子进程，输出加上带颜色的前缀 */
export function serve(name, cmd, args, opts = {}) {
  const child = spawn(...cmdline(cmd, args), { shell: isWin, env: { ...process.env, FORCE_COLOR: '1', ...opts.env }, cwd: opts.cwd ?? ROOT })
  const prefix = paint(name, `[${name}]`)
  const pipe = (stream) => {
    let buf = ''
    stream.on('data', (d) => {
      buf += d.toString()
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const l of lines) if (l.trim()) console.log(`${prefix} ${l}`)
    })
  }
  pipe(child.stdout)
  pipe(child.stderr)
  return child
}

/** 结束子进程（Windows 上要连同子孙进程一起结束） */
export function killTree(child) {
  if (!child || child.exitCode !== null) return
  if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGTERM')
}

export function openBrowser(url) {
  const [cmd, args] = isWin ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref()
  } catch {
    /* 打不开浏览器就算了 */
  }
}

export async function waitFor(url, timeoutMs = 60000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.ok) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/** package.json 里新加了依赖、但 node_modules 里还没有（例如 git pull 之后）时返回缺少的包 */
function missingFrontendDeps() {
  try {
    const pkg = JSON.parse(readFileSync(join(FRONTEND, 'package.json'), 'utf8'))
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    return deps.filter((d) => !existsSync(join(FRONTEND, 'node_modules', ...d.split('/'), 'package.json')))
  } catch {
    return []
  }
}

export function ensureInstalled() {
  if (!existsSync(join(BACKEND, '.venv')) || !existsSync(join(FRONTEND, 'node_modules'))) {
    warn('依赖还没安装，先执行一次 npm run setup')
    run('node', [join(ROOT, 'scripts', 'setup.mjs')])
    return
  }
  const missing = missingFrontendDeps()
  if (missing.length) {
    warn(`前端有新依赖还没安装（${missing.join(', ')}），先安装`)
    run('npm', ['install', '--no-audit', '--no-fund'], { cwd: FRONTEND })
  }
}
