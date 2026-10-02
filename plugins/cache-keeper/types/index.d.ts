export type KeeperPhase =
  | 'unknown'
  | 'busy'
  | 'warm'
  | 'pinging'
  | 'compacting'
  | 'dormant'
  | 'cold'

export type KeeperState = {
  phase: KeeperPhase
  isOff: boolean
  /** Keep-alive pings sent in this idle stretch. */
  pings: number
  /** Extra pings sent because compaction was held (draft typed, agents running). */
  holdPings: number
  /** When the cache entry lapses, ms since the epoch; 0 when unknown. */
  expiresAt: number
  /** Bumped on every real activity, so a ping or compaction that lands late is dropped. */
  epoch: number
  /** The main turn this plugin saw start outside its own requests. */
  turnId: string
  retryAt: number
  note: string
  /** When the person last left the session idle (the main turn ended); 0 when unknown. */
  idleSince: number
  /** When the running turn began. */
  activeSince: number
}

declare module 'claude-code' {
  interface PluginState {
    'cache-keeper': { keeper: KeeperState; now: number }
  }
}
