export type KeeperPhase =
  | 'unknown'
  | 'busy'
  | 'warm'
  | 'pinging'
  | 'compacting'
  | 'dormant'
  | 'cold'

export type CacheTtl = '5m' | '1h'

/** What the last main-thread request showed: read from the session transcript after each turn. */
export type CacheInfo = {
  /** The TTL its cache writes used; '' until a write has been seen. */
  ttl: CacheTtl | ''
  model: string
  /** Prompt tokens the next request re-sends (input + cache read + cache write). */
  contextTokens: number
  /** Why nothing was detected yet ('' once it was): no reply yet, or the transcript unreadable. */
  detail: string
  /** Share of the last request's prompt served from cache, 0 to 1; -1 when unknown. */
  hitLast: number
  /** Share of all main-thread prompt tokens this session served from cache, 0 to 1; -1 when unknown. */
  hitSession: number
  /** Main-thread API requests counted (one per response, however many transcript rows it spans). */
  requests: number
  /** The last request rebuilt most of a prompt the one before had cached; null when it did not. */
  rebuild: CacheRebuild | null
}

/** A request that wrote back most of what the previous one had read: a collapse or a lapse. */
export type CacheRebuild = {
  read: number
  wrote: number
}

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
  cache: CacheInfo
  /** The session transcript, as the last Stop event named it; '' until then. */
  transcriptPath: string
  /** Background tasks (shells, agents) in flight when the last main turn stopped. */
  backgroundTasks: number
  /** How much earlier than `expiresAt - lead` this window acts: a random share of the jitter. */
  jitterMs: number
}

declare module 'claude-code' {
  interface PluginState {
    'cache-keeper': { keeper: KeeperState; now: number }
  }
}
