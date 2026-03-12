/**
 * TTL-based message deduplication cache.
 * Prevents processing the same message twice when Baileys redelivers during reconnects.
 */

export type DedupeCache = {
  /** Returns true if key was seen recently (within TTL), adds key if not seen */
  check: (key: string) => boolean
  /** Clear all entries */
  clear: () => void
  /** Get current cache size */
  size: () => number
}

export interface DedupeCacheOptions {
  /** Time-to-live in milliseconds (default: 20 minutes) */
  ttlMs: number
  /** Maximum number of entries (default: 5000) */
  maxSize: number
}

/**
 * Creates a deduplication cache with TTL-based expiration.
 *
 * Uses a Map with timestamp values. On each check:
 * 1. Prunes expired entries
 * 2. If at max size, prunes oldest entries
 * 3. Returns true if key exists (duplicate), false otherwise
 * 4. Adds key with current timestamp if not seen
 */
export function createDedupeCache(options: DedupeCacheOptions): DedupeCache {
  const { ttlMs, maxSize } = options
  const cache = new Map<string, number>()

  const pruneExpired = () => {
    const now = Date.now()
    for (const [key, timestamp] of cache) {
      if (now - timestamp > ttlMs) {
        cache.delete(key)
      }
    }
  }

  const pruneOldest = () => {
    if (cache.size <= maxSize) return

    // Convert to array, sort by timestamp, remove oldest entries
    const entries = Array.from(cache.entries())
    entries.sort((a, b) => a[1] - b[1])

    const toRemove = cache.size - maxSize
    for (let i = 0; i < toRemove; i++) {
      cache.delete(entries[i][0])
    }
  }

  return {
    check(key: string): boolean {
      pruneExpired()

      if (cache.has(key)) {
        return true // Duplicate
      }

      cache.set(key, Date.now())
      pruneOldest()

      return false // Not seen before
    },

    clear() {
      cache.clear()
    },

    size() {
      return cache.size
    },
  }
}
