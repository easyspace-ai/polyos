import { useCallback, useState } from 'react'
import type { ShellApi } from '../preload/preload'

declare global {
  interface Window {
    shell?: ShellApi
  }
}

export function App(): JSX.Element {
  const [last, setLast] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onPing = useCallback(async () => {
    if (!window.shell) {
      setLast('preload 未注入（仅浏览器打开 HTML 时会出现）')
      return
    }
    setBusy(true)
    try {
      const r = await window.shell.ping()
      setLast(`IPC 返回: ${r}，平台: ${window.shell.platform}`)
    } catch (e) {
      setLast(`错误: ${String(e)}`)
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <div className="card">
      <h1>Electron 最小壳</h1>
      <p>
        主进程、预加载与 Vite 渲染进程已就绪。在此目录下扩展业务代码即可；打包仍走{' '}
        <code>electron-builder</code>。
      </p>
      <div className="row">
        <button type="button" disabled={busy} onClick={() => void onPing()}>
          {busy ? '请求中…' : '测试 IPC ping'}
        </button>
        {last ? <span>{last}</span> : null}
      </div>
    </div>
  )
}
