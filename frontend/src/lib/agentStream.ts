import { useCallback, useEffect, useRef, useState } from 'react'
import { api, streamSSE } from './api'

/**
 * Agent 的 SSE 流：可以中途停止。
 * 停止 = 断开流（后端在当前这一步做完后不再往下走）+ 标记任务为「已停止」；之后可以从检查点继续。
 */
export function useAgentStream() {
  const ctrl = useRef<AbortController | null>(null)
  const [running, setRunning] = useState(false)
  useEffect(() => () => ctrl.current?.abort(), [])

  const run = useCallback(async (path: string, body: unknown, onEvent: (e: any) => void): Promise<'ok' | 'stopped'> => {
    ctrl.current?.abort()
    const c = new AbortController()
    ctrl.current = c
    setRunning(true)
    try {
      await streamSSE(path, body, onEvent, c.signal)
      return 'ok'
    } catch (e: any) {
      if (c.signal.aborted) return 'stopped'
      throw e
    } finally {
      if (ctrl.current === c) {
        ctrl.current = null
        setRunning(false)
      }
    }
  }, [])

  const stop = useCallback((threadId: string | null) => {
    ctrl.current?.abort()
    if (threadId) api.agentStop(threadId).catch(() => undefined)
  }, [])

  return { run, stop, running }
}
