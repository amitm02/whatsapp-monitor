import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

export interface LockAcquired {
  ok: true
  release: () => void
}

export interface LockBusy {
  ok: false
  existingPid: number
}

export type LockResult = LockAcquired | LockBusy

function isProcessAlive(pid: number): boolean {
  try {
    // `kill(pid, 0)` doesn't actually send a signal — it just checks whether
    // the process exists and is reachable. Throws ESRCH if dead, EPERM if
    // alive but we don't have permission (still counts as alive).
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
}

/**
 * Acquire an exclusive PID-file lock. Returns `{ok: true, release}` on
 * success, `{ok: false, existingPid}` if another live process holds it.
 *
 * Stale locks (file exists but PID is gone) are cleaned up automatically —
 * this handles the common "previous run crashed without removing the file"
 * case. The lock is otherwise inherited from the old PID as long as that
 * process is still alive.
 *
 * Release is idempotent and best-effort; it only removes the file if it
 * still contains our PID (so a newer instance's lock isn't accidentally
 * wiped by a stale shutdown handler).
 */
export function acquireLock(lockPath: string): LockResult {
  mkdirSync(dirname(lockPath), { recursive: true })

  if (existsSync(lockPath)) {
    let existingPid: number | null = null
    try {
      const raw = readFileSync(lockPath, 'utf-8').trim()
      const parsed = Number.parseInt(raw, 10)
      if (Number.isInteger(parsed) && parsed > 0) existingPid = parsed
    } catch {
      // Unreadable — treat as stale.
    }

    if (existingPid !== null && existingPid !== process.pid && isProcessAlive(existingPid)) {
      return { ok: false, existingPid }
    }

    // Stale lock (process gone, file unreadable, or our own PID from a
    // previous run with the same pid — unlikely but harmless): clear it.
    try {
      unlinkSync(lockPath)
    } catch {
      // Race: another process may have just cleaned it. Fine — we'll fail
      // at the write below if there's a real conflict.
    }
  }

  try {
    // wx = fail if file exists, atomic vs. concurrent acquirers.
    writeFileSync(lockPath, String(process.pid), { encoding: 'utf-8', flag: 'wx', mode: 0o644 })
  } catch (err) {
    // Someone else won the race between our existsSync check and the write.
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      try {
        const raw = readFileSync(lockPath, 'utf-8').trim()
        const existingPid = Number.parseInt(raw, 10)
        return {
          ok: false,
          existingPid: Number.isInteger(existingPid) ? existingPid : -1,
        }
      } catch {
        return { ok: false, existingPid: -1 }
      }
    }
    throw err
  }

  const release = () => {
    try {
      if (!existsSync(lockPath)) return
      const raw = readFileSync(lockPath, 'utf-8').trim()
      const pid = Number.parseInt(raw, 10)
      // Only remove if it's still ours — otherwise we'd be deleting another
      // instance's lock (would happen if we crashed, someone else took over,
      // and then our shutdown handler fired late).
      if (pid === process.pid) {
        unlinkSync(lockPath)
      }
    } catch {
      // best-effort
    }
  }

  return { ok: true, release }
}
