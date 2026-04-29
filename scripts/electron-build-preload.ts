/**
 * Bundle preload → apps/electron/dist/preload.cjs
 */

import { spawn } from 'bun'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'

const ROOT_DIR = join(import.meta.dir, '..')
const DIST_DIR = join(ROOT_DIR, 'apps/electron/dist')

if (!existsSync(DIST_DIR)) {
  mkdirSync(DIST_DIR, { recursive: true })
}

const esbuildBin = join(ROOT_DIR, 'node_modules', 'esbuild', 'bin', 'esbuild')

const proc = spawn({
  cmd: [
    'node',
    esbuildBin,
    'apps/electron/src/preload/preload.ts',
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--outfile=apps/electron/dist/preload.cjs',
    '--external:electron',
  ],
  cwd: ROOT_DIR,
  stdout: 'inherit',
  stderr: 'inherit',
})

const code = await proc.exited
if (code !== 0) {
  console.error('preload build failed:', code)
  process.exit(code)
}
console.log('preload.cjs ok')
process.exit(0)
