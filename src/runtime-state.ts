import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { ConnectionState } from './types.js'

/**
 * A snapshot of the running `whatsapp-monitor run` service's live state.
 * Written to disk by `run` so that `status` (a separate process) can see
 * the live connection state — particularly useful for distinguishing
 * between "running and healthy" and "running but in `conflict` state"
 * (status 440), which ps-level detection can't tell apart.
 */
export interface RuntimeState {
  pid: number
  startedAt: number
  updatedAt: number
  connectionState: ConnectionState
  lastActivityAt: number
  reconnectAttempts: number
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
}

export function writeRuntimeState(path: string, state: RuntimeState): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    // Plain write is fine — this file is purely observational, a mid-write
    // crash just means `status` may read a stale or partial value, and the
    // next tick will overwrite it.
    writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8')
  } catch {
    // best-effort — don't break the main loop if the state file can't be written
  }
}

export function readRuntimeState(path: string): RuntimeState | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as RuntimeState
    if (typeof parsed.pid !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Read the runtime state, but return null if the writing process is no
 * longer alive. Prevents `status` from reporting a stale "connected" state
 * from a `run` that crashed without cleanup.
 */
export function readLiveRuntimeState(path: string): RuntimeState | null {
  const state = readRuntimeState(path)
  if (!state) return null
  if (!isProcessAlive(state.pid)) return null
  return state
}

export function clearRuntimeState(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // best-effort
  }
}
