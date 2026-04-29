/**
 * Dev: esbuild main + preload, copy resources, Vite, Electron (VITE_DEV_SERVER_URL)
 */

import { spawn } from 'bun'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, cpSync, rmSync } from 'fs'
import { join } from 'path'

const ROOT_DIR = join(import.meta.dir, '..')
const ELECTRON_DIR = join(ROOT_DIR, 'apps/electron')
const DIST_DIR = join(ELECTRON_DIR, 'dist')
const require = createRequire(import.meta.url)
const electronPath = require('electron') as string

const vitePort = process.env.VITE_PORT || '5173'
const viteUrl = `http://localhost:${vitePort}`

async function run(cmd: string[], cwd: string): Promise<number> {
  const p = spawn({ cmd, cwd, stdout: 'inherit', stderr: 'inherit' })
  return p.exited
}

function copyResources(): void {
  const src = join(ELECTRON_DIR, 'resources')
  const dest = join(DIST_DIR, 'resources')
  if (!existsSync(src)) {
    return
  }
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true })
  }
  mkdirSync(DIST_DIR, { recursive: true })
  cpSync(src, dest, { recursive: true })
  console.log('resources → dist/resources')
}

if (!existsSync(DIST_DIR)) {
  mkdirSync(DIST_DIR, { recursive: true })
}

const esbuildBin = join(ROOT_DIR, 'node_modules', 'esbuild', 'bin', 'esbuild')

let code = await run(
  [
    'node',
    esbuildBin,
    'apps/electron/src/main/index.ts',
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--outfile=apps/electron/dist/main.cjs',
    '--external:electron',
  ],
  ROOT_DIR,
)
if (code !== 0) {
  process.exit(code)
}

code = await run(
  [
    'node',
    esbuildBin,
    'apps/electron/src/preload/preload.ts',
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--outfile=apps/electron/dist/preload.cjs',
    '--external:electron',
  ],
  ROOT_DIR,
)
if (code !== 0) {
  process.exit(code)
}

copyResources()

const viteProc = spawn({
  cmd: [
    'bun',
    'x',
    'vite',
    'dev',
    '--config',
    'apps/electron/vite.config.ts',
    '--strict-port',
    '--port',
    vitePort,
  ],
  cwd: ROOT_DIR,
  stdout: 'inherit',
  stderr: 'inherit',
})

await new Promise((r) => setTimeout(r, 1500))

const electronProc = spawn({
  cmd: [electronPath, '.'],
  cwd: ELECTRON_DIR,
  stdout: 'inherit',
  stderr: 'inherit',
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: viteUrl,
  },
})

let exiting = false
function stopVite(): void {
  try {
    viteProc.kill('SIGTERM')
  } catch {
    /* ignore */
  }
}

function exitAll(c: number): void {
  if (exiting) {
    return
  }
  exiting = true
  stopVite()
  process.exit(c)
}

void electronProc.exited.then((c) => exitAll(c ?? 0))

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopVite()
    try {
      electronProc.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    exitAll(0)
  })
}
