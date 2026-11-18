// X11 presence: idle time from bin/xidle.py (XScreenSaver extension) and the i3lock process as the lock signal.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { REPO_DIR } from '../../config.ts'

// Parses xidle.py's stdout (milliseconds). Null when it is not a non-negative number.
export function parseXidle(stdout: string): number | null {
  const n = Number(String(stdout).trim())
  return Number.isFinite(n) && n >= 0 ? n : null
}

// X idle time in ms via bin/xidle.py, or null if it cannot be read (no X display, script failed).
export function x11IdleMs(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      'python3',
      ['-I', join(REPO_DIR, 'bin', 'xidle.py')],
      { timeout: 3000, env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' } },
      (err, stdout) => {
        if (err) return resolve(null)
        resolve(parseXidle(String(stdout)))
      },
    )
  })
}

// True while an i3lock process runs.
export function x11Locked(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('pgrep', ['-x', 'i3lock'], { timeout: 2000 }, (err) => resolve(!err))
  })
}
