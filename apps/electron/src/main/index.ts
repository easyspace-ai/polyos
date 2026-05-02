import { app, BrowserWindow, ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'

const isDev = !app.isPackaged
const defaultBackendHost = '127.0.0.1'
const portRangeStart = Number.parseInt(process.env.BACKEND_PORT_MIN ?? '16543', 10)
const portRangeEnd = Number.parseInt(process.env.BACKEND_PORT_MAX ?? '17000', 10)
let backendProc: ChildProcess | null = null

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Rust `polybackend` binary copied as `server-${platform}-${arch}` (see repo Makefile). */
function backendExecutableName(): string {
  const ext = process.platform === 'win32' ? '.exe' : ''
  return `server-${process.platform}-${process.arch}${ext}`
}

async function resolveBackendExecutable(): Promise<string> {
  if (process.env.BACKEND_EXECUTABLE) {
    return process.env.BACKEND_EXECUTABLE
  }

  if (app.isPackaged) {
    return join(process.resourcesPath, 'backend', backendExecutableName())
  }

  const repoRoot = join(__dirname, '..', '..', '..')
  return join(repoRoot, 'apps', 'backend', 'bin', backendExecutableName())
}

function resolveWebDir(): string {
  if (process.env.POLYBACKEND_WEB_DIR?.trim()) {
    return process.env.POLYBACKEND_WEB_DIR.trim()
  }
  if (app.isPackaged) {
    return join(process.resourcesPath, 'backend', 'web')
  }
  const repoRoot = join(__dirname, '..', '..', '..')
  return join(repoRoot, 'apps', 'frontend', 'dist', 'client')
}

function resolveDataDir(): string {
  if (process.env.POLYBACKEND_DATA_DIR?.trim()) {
    return process.env.POLYBACKEND_DATA_DIR.trim()
  }
  return join(app.getPath('appData'), 'PolyBot', 'data')
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => {
      srv.close(() => resolve(true))
    })
    srv.listen(port, defaultBackendHost)
  })
}

async function pickBackendPort(): Promise<number> {
  const fixed = process.env.BACKEND_PORT?.trim() ?? process.env.PORT?.trim()
  if (fixed) {
    const parsed = Number.parseInt(fixed, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }
    throw new Error(`invalid fixed backend port: ${fixed}`)
  }

  for (let p = portRangeStart; p <= portRangeEnd; p += 1) {
    if (await isPortAvailable(p)) {
      return p
    }
  }
  throw new Error(`no available backend port in range ${portRangeStart}-${portRangeEnd}`)
}

async function waitForBackendReady(url: string, timeoutMs = 20000): Promise<void> {
  const healthUrl = new URL('/health', url)
  const deadline = Date.now() + timeoutMs

  const pingHealth = async (): Promise<boolean> => {
    await new Promise<void>((resolve, reject) => {
      const req = request(
        {
          protocol: healthUrl.protocol,
          hostname: healthUrl.hostname,
          port: healthUrl.port,
          path: healthUrl.pathname,
          method: 'GET',
          timeout: 1500,
        },
        (res) => {
          res.resume()
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
            resolve()
            return
          }
          reject(new Error(`health status ${String(res.statusCode)}`))
        },
      )
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', reject)
      req.end()
    })
    return true
  }

  while (Date.now() < deadline) {
    try {
      if (await pingHealth()) {
        return
      }
    } catch {
      // backend may still be starting.
    }
    await sleep(500)
  }
  throw new Error(`backend health check timeout: ${healthUrl.toString()}`)
}

async function startBackend(): Promise<void> {
  if (backendProc) {
    return
  }

  const executablePath = await resolveBackendExecutable()
  await access(executablePath)
  const port = process.env.PORT
  if (!port) {
    throw new Error('PORT is not set before startBackend')
  }
  const webDir = resolveWebDir()
  const dataDir = resolveDataDir()
  await mkdir(dataDir, { recursive: true })
  console.info(`polybackend data dir: ${dataDir}`)
  backendProc = spawn(executablePath, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      PORT: port,
      POLYBACKEND_PORT: process.env.POLYBACKEND_PORT ?? port,
      POLYBACKEND_WEB_DIR: webDir,
      POLYBACKEND_DATA_DIR: dataDir,
    },
  })
  backendProc.stdout?.on('data', (chunk) => {
    process.stdout.write(`[polybackend] ${String(chunk)}`)
  })
  backendProc.stderr?.on('data', (chunk) => {
    process.stderr.write(`[polybackend] ${String(chunk)}`)
  })

  backendProc.on('exit', (code, signal) => {
    console.error(`backend exited code=${String(code)} signal=${String(signal)}`)
    backendProc = null
  })
}

function stopBackend(): void {
  if (!backendProc || backendProc.killed) {
    return
  }
  try {
    backendProc.kill('SIGTERM')
  } catch {
    // no-op
  }
}

function createWindow(url: string): void {
  const win = new BrowserWindow({
    width: 960,
    height: 640,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.once('ready-to-show', () => {
    win.show()
  })

  // Electron 只负责拉起 Rust backend，然后打开业务 URL。
  void win.loadURL(url)
  if (isDev) {
    win.webContents.openDevTools({ mode: 'detach' })
  }
}

ipcMain.handle('app:ping', () => 'pong')

app.whenReady()
  .then(async () => {
    const selectedPort = await pickBackendPort()
    process.env.PORT = String(selectedPort)
    process.env.POLYBACKEND_PORT = process.env.POLYBACKEND_PORT ?? String(selectedPort)
    const backendUrl = process.env.BACKEND_URL?.trim() || `http://${defaultBackendHost}:${selectedPort}`
    const appUrlTemplate = process.env.APP_URL?.trim()
    const appUrl = appUrlTemplate
      ? appUrlTemplate.replaceAll('{PORT}', String(selectedPort)).replaceAll('{BACKEND_URL}', backendUrl)
      : backendUrl

    await startBackend()
    await waitForBackendReady(backendUrl)
    createWindow(appUrl)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow(appUrl)
      }
    })
  })
  .catch((err: unknown) => {
    console.error('electron startup failed', err)
    app.quit()
  })

app.on('window-all-closed', () => {
  stopBackend()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  stopBackend()
})
