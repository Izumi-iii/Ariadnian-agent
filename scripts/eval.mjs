// npm run eval —— 运行测评，参数原样传给 python -m evals
//   npm run eval                          用网页「设置」里的模型跑全部测评
//   npm run eval -- --limit 30            每项只取 30 条，先快速看一眼
//   npm run eval -- --model deepseek/deepseek-chat --tasks judge,fake_cite
//   npm run eval -- --offline             不调用模型，只跑离线基线
import { BACKEND, ensureInstalled, requireTools, run } from './lib.mjs'

requireTools()
ensureInstalled()
run('uv', ['run', 'python', '-m', 'evals', ...process.argv.slice(2)], {
  cwd: BACKEND,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
})
