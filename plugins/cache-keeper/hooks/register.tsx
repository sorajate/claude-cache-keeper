import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { CacheInfo, CacheRebuild, CacheTtl, KeeperState } from '../types'

type $ = EngineInterface
type CompactResult = Awaited<ReturnType<$['session']['compact']>>

const PING_PROMPT =
  'Prompt-cache keep-alive from the cache-keeper plugin. Reply with exactly: ok'
const TICK_MS = 1000
const RETRY_MS = 10_000
// Pings allowed past maxPings while compaction is held (draft typed, agents running).
const HOLD_PING_CAP = 6
// Until a cache write shows which TTL the session uses, assume the shorter one:
// pinging a 1-hour cache early costs a cheap read, compacting it early costs the context.
const DEFAULT_TTL_MS = 300_000
const TTL_MS: Record<CacheTtl, number> = { '5m': 300_000, '1h': 3_600_000 }
// $.fs.read rejects past 4 MiB: a longer transcript has only its tail read, by a
// child process, whose output stays under the same 4 MiB cap.
const READ_LIMIT_BYTES = 4 * 1024 * 1024
const TAIL_BYTES = 3 * 1024 * 1024
// The tail on Windows, where no `tail` ships: the path and size come in through the
// environment, so nothing of them is ever parsed as script.
const TAIL_SCRIPT = [
  '$n = [int64]$env:CACHE_KEEPER_TAIL',
  "$f = [IO.File]::Open($env:CACHE_KEEPER_PATH, 'Open', 'Read', 'ReadWrite')",
  'try {',
  '  $start = [Math]::Max([int64]0, $f.Length - $n)',
  "  [void]$f.Seek($start, 'Begin')",
  '  $b = New-Object byte[] ($f.Length - $start)',
  '  $t = 0',
  '  while ($t -lt $b.Length) { $k = $f.Read($b, $t, $b.Length - $t); if ($k -le 0) { break }; $t += $k }',
  '  $o = [Console]::OpenStandardOutput(); $o.Write($b, 0, $t); $o.Flush()',
  '} finally { $f.Close() }',
].join('\n')

const INITIAL: KeeperState = {
  phase: 'unknown',
  isOff: false,
  pings: 0,
  holdPings: 0,
  expiresAt: 0,
  epoch: 0,
  turnId: '',
  retryAt: 0,
  note: '',
  idleSince: 0,
  activeSince: 0,
  cache: { ttl: '', model: '', contextTokens: 0, detail: '', hitLast: -1, hitSession: -1, requests: 0, isTail: false, rebuild: null },
  transcriptPath: '',
  backgroundTasks: 0,
  jitterMs: 0,
}

const keeper = atom({ plugin: 'cache-keeper', key: 'keeper' } as const, INITIAL)
// Written every tick so the band redraws each second.
const ticker = atom({ plugin: 'cache-keeper', key: 'now' } as const, 0)

// ttlMs and leadMs are the effective values: the override when set, else what was detected.
const config = {
  ttlMs: DEFAULT_TTL_MS,
  leadMs: 30_000,
  overrideTtlMs: 0,
  leadSettingMs: 30_000,
  jitterSettingMs: 20_000,
  maxPings: 3,
  instructions: '',
  hasBand: true,
  hasStatus: false,
}

// Our own fork or compaction in flight: events it raises are not the person's activity.
let selfBusy = 0
let isActing = false
let expectTurn = false

function positive(value: unknown, fallback: number) {
  return typeof value === 'number' && value > 0 ? value : fallback
}

function configure(options: PluginOptions) {
  config.overrideTtlMs = positive(options.ttlSeconds, 0) * 1000
  config.leadSettingMs = positive(options.leadSeconds, 30) * 1000
  const jitter = options.jitterSeconds
  config.jitterSettingMs = typeof jitter === 'number' && jitter >= 0 ? jitter * 1000 : 20_000
  useTtl(config.overrideTtlMs || DEFAULT_TTL_MS)
  config.maxPings = Math.floor(positive(options.maxPings, 3))
  const text = options.compactInstructions
  config.instructions = typeof text === 'string' ? text.trim() : ''
  const display = options.display
  config.hasBand = display !== 'status'
  config.hasStatus = display === 'status' || display === 'both'
}

function useTtl(ms: number) {
  config.ttlMs = ms
  config.leadMs = Math.min(config.leadSettingMs, ms / 2)
}

// A fresh random head start for the next window: pings off an exact beat.
function drawJitter() {
  return Math.random() * Math.min(config.jitterSettingMs, config.ttlMs / 10)
}

// When this window's ping or compaction is due.
function actAt(s: KeeperState) {
  return Math.max(s.expiresAt - config.leadMs - s.jitterMs, s.retryAt)
}

// The effective TTL for what the transcript showed, unless the person forced one.
function applyCache(cache: CacheInfo) {
  if (config.overrideTtlMs > 0) return
  useTtl(cache.ttl === '' ? DEFAULT_TTL_MS : TTL_MS[cache.ttl])
}

function ttlLabel(cache: CacheInfo) {
  if (config.overrideTtlMs > 0) return `TTL ${span(config.ttlMs)} (set)`
  return cache.ttl === '' ? 'TTL 5m (assumed)' : `TTL ${cache.ttl} (auto)`
}

type UsageRow = {
  type?: string
  isSidechain?: boolean
  message?: {
    id?: string
    model?: string
    usage?: {
      input_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
    }
  }
}

type Request = {
  model: string
  read: number
  wrote: number
  uncached: number
  ttl: CacheTtl | ''
  // A compaction came between this request and the one before: its rebuild is expected.
  isAfterCompaction: boolean
}

// A rebuild worth a warning: the previous prompt was sizeable, this one read back
// less than half of it and wrote at least that much anew.
const REBUILD_MIN_TOKENS = 20_000

function promptOf(request: Request) {
  return request.read + request.wrote + request.uncached
}

// Reads a session transcript's main-thread responses, one per API response
// (Claude Code splits a response over several rows that share its message id):
// the last one's model and context, the TTL of the latest that wrote cache (any
// 5-minute write counts as 5m: its tail lapses first), and the hit rates.
export function sampleTranscript(text: string): CacheInfo | undefined {
  const requests: Request[] = []
  const seen = new Set<string>()
  let isAfterCompaction = false
  for (const line of text.split('\n')) {
    if (line.includes('"compact_boundary"')) isAfterCompaction = true
    if (!line.includes('"usage"')) continue
    let row: UsageRow
    try {
      row = JSON.parse(line) as UsageRow
    } catch {
      continue
    }
    const usage = row.message?.usage
    if (row.type !== 'assistant' || row.isSidechain === true || usage === undefined) continue
    const read = usage.cache_read_input_tokens ?? 0
    const wrote = usage.cache_creation_input_tokens ?? 0
    const uncached = usage.input_tokens ?? 0
    const id = row.message?.id ?? `${read}/${wrote}/${uncached}`
    if (seen.has(id)) continue
    seen.add(id)
    const split = usage.cache_creation
    const ttl = (split?.ephemeral_5m_input_tokens ?? 0) > 0 ? '5m' : (split?.ephemeral_1h_input_tokens ?? 0) > 0 ? '1h' : ''
    requests.push({ model: row.message?.model ?? '', read, wrote, uncached, ttl, isAfterCompaction })
    isAfterCompaction = false
  }

  const last = requests.at(-1)
  if (last === undefined) return undefined
  let read = 0
  let total = 0
  let ttl: CacheTtl | '' = ''
  for (const request of requests) {
    read += request.read
    total += promptOf(request)
    if (request.ttl !== '') ttl = request.ttl
  }
  const previous = requests.at(-2)
  const isRebuild =
    previous !== undefined &&
    !last.isAfterCompaction &&
    promptOf(previous) >= REBUILD_MIN_TOKENS &&
    last.read < promptOf(previous) / 2 &&
    last.wrote >= promptOf(previous) / 2
  const rebuild: CacheRebuild | null = isRebuild ? { read: last.read, wrote: last.wrote } : null
  const context = promptOf(last)
  return {
    ttl,
    model: last.model,
    contextTokens: context,
    detail: '',
    hitLast: context > 0 ? last.read / context : -1,
    hitSession: total > 0 ? read / total : -1,
    requests: requests.length,
    isTail: false,
    rebuild,
  }
}

type Rate = { input: number; read: number }

// First-party $/MTok (cached 2026-09-25). Longest matching prefix wins.
const RATES: [string, Rate][] = [
  ['claude-fable-5-1', { input: 10, read: 0.25 }],
  ['claude-mythos-5-1', { input: 10, read: 0.25 }],
  ['claude-fable-5', { input: 10, read: 1 }],
  ['claude-mythos-5', { input: 10, read: 1 }],
  ['claude-opus-5-5', { input: 4, read: 0.2 }],
  ['claude-opus-5', { input: 5, read: 0.5 }],
  ['claude-opus-4', { input: 5, read: 0.5 }],
  ['claude-sonnet-5-5', { input: 2, read: 0.2 }],
  ['claude-sonnet-5', { input: 2, read: 0.2 }],
  ['claude-sonnet-4', { input: 3, read: 0.3 }],
  ['claude-haiku-4', { input: 1, read: 0.1 }],
]

function rateOf(model: string) {
  const id = model.replace(/^(us\.)?anthropic\./, '')
  let best: [string, Rate] | undefined
  for (const entry of RATES) {
    if (id.startsWith(entry[0]) && (best === undefined || entry[0].length > best[0].length)) best = entry
  }
  return best?.[1]
}

function dollars(amount: number) {
  return amount < 0.01 ? '<$0.01' : `$${amount.toFixed(2)}`
}

function thousands(tokens: number) {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
}

function percent(share: number) {
  return share < 0 ? '-' : `${(share * 100).toFixed(1)}%`
}

export function hitLine(cache: CacheInfo) {
  if (cache.requests === 0) return undefined
  const scope = cache.isTail ? `the last ${cache.requests} requests` : `this session (${cache.requests} requests)`
  return `cache hit ${percent(cache.hitLast)} last request · ${percent(cache.hitSession)} ${scope}`
}

// The warning for a request that rebuilt the cache, priced as a write at the session's TTL.
export function rebuildLine(cache: CacheInfo) {
  if (cache.rebuild === null) return undefined
  const { read, wrote } = cache.rebuild
  const rate = rateOf(cache.model)
  const writeRate = cache.ttl === '1h' ? 2 : 1.25
  const cost = rate === undefined ? '' : ` (≈ ${dollars((wrote * rate.input * writeRate) / 1e6)})`
  return `⚠ cache rebuilt by the last request: read ${thousands(read)} / wrote ${thousands(wrote)}${cost}`
}

// What one keep-alive and one cold rebuild of this context cost, as the band shows them.
export function priceLine(cache: CacheInfo) {
  const isHour = config.overrideTtlMs > 0 ? config.ttlMs > 300_000 : cache.ttl === '1h'
  const writeRate = isHour ? 2 : 1.25
  const model = cache.model.replace(/^claude-/, '') || 'model ?'
  const head = `${ttlLabel(cache)} · ${model} · context ${thousands(cache.contextTokens)}`
  const rate = rateOf(cache.model)
  if (rate === undefined || cache.contextTokens === 0) {
    return `${head} · ping ≈ one cache read · cold rebuild ${writeRate}× input`
  }
  const pingCost = (cache.contextTokens * rate.read) / 1e6
  const rebuildCost = (cache.contextTokens * rate.input * writeRate) / 1e6
  return `${head} · ping ≈ ${dollars(pingCost)} · cold rebuild ≈ ${dollars(rebuildCost)} (${writeRate}× write)`
}

// Where Claude Code keeps this session's transcript, for a load before any Stop
// event has named it: <config dir>/projects/<root, non-alphanumerics as '-'>/<id>.jsonl.
async function guessTranscript($: $) {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const configDir = configured ?? (home === undefined ? undefined : `${home}/.claude`)
  if (configDir === undefined) return ''
  const project = (await $.session.root()).replace(/[^A-Za-z0-9]/g, '-')
  return `${configDir}/projects/${project}/${await $.session.id()}.jsonl`
}

async function noteDetail($: $, detail: string) {
  await update($, keeper, (s): KeeperState =>
    s.cache.model === '' ? { ...s, cache: { ...s.cache, detail } } : s,
  )
}

// The transcript's last TAIL_BYTES, from its first whole line on.
async function readTail($: $, transcriptPath: string) {
  const isWindows = /^[A-Za-z]:|\\/.test(transcriptPath)
  const argv = isWindows
    ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', TAIL_SCRIPT]
    : ['tail', '-c', String(TAIL_BYTES), transcriptPath]
  const env = { CACHE_KEEPER_PATH: transcriptPath, CACHE_KEEPER_TAIL: String(TAIL_BYTES) }
  const result = await $.process.run(argv, { env, timeoutMs: 15_000 })
  if (result.exitCode !== 0) throw new Error(result.stderr.trim().split('\n')[0] || `tail exited ${result.exitCode}`)
  return result.stdout.slice(result.stdout.indexOf('\n') + 1)
}

async function detect($: $, transcriptPath: string) {
  let text: string
  let isTail = false
  try {
    const stat = await $.fs.stat(transcriptPath)
    if (stat.kind !== 'file') return noteDetail($, 'checked after the next reply')
    isTail = stat.size > READ_LIMIT_BYTES
    text = isTail ? await readTail($, transcriptPath) : await $.fs.read(transcriptPath)
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).replace(transcriptPath, 'transcript')
    return noteDetail($, `transcript unreadable: ${reason.slice(0, 100)}`)
  }
  const sampled = sampleTranscript(text)
  if (sampled === undefined) return noteDetail($, 'checked after the next reply')
  const cache = { ...sampled, isTail }
  const before = config.ttlMs
  applyCache(cache)
  const after = config.ttlMs
  await update($, keeper, (s): KeeperState => {
    const isRetimed = s.phase === 'warm' && after !== before && s.idleSince > 0
    // Re-time the countdown the last turn started under the old TTL.
    const next = { ...s, cache, transcriptPath }
    return isRetimed ? { ...next, expiresAt: s.idleSince + after } : next
  })
}

function clock(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

async function markBusy($: $, turnId?: string) {
  const now = await $.clock.now()
  await update($, keeper, (s): KeeperState => ({
    ...s,
    phase: 'busy',
    activeSince: s.phase === 'busy' ? s.activeSince : now,
    pings: 0,
    holdPings: 0,
    retryAt: 0,
    epoch: s.epoch + 1,
    turnId: turnId ?? s.turnId,
    note: '',
  }))
}

async function markWarm($: $) {
  const now = await $.clock.now()
  await update($, keeper, (s): KeeperState => ({
    ...s,
    phase: 'warm',
    pings: 0,
    holdPings: 0,
    expiresAt: now + config.ttlMs,
    jitterMs: drawJitter(),
    retryAt: 0,
    epoch: s.epoch + 1,
    idleSince: now,
    note: '',
  }))
}

// After any compaction: count the new cache down, but never ping or compact it again
// until the person does something.
async function markDormant($: $, note: string, isActivity: boolean) {
  const now = await $.clock.now()
  await update($, keeper, (s): KeeperState => ({
    ...s,
    phase: 'dormant',
    pings: isActivity ? 0 : s.pings,
    holdPings: 0,
    expiresAt: now + config.ttlMs,
    retryAt: 0,
    epoch: isActivity ? s.epoch + 1 : s.epoch,
    idleSince: isActivity ? now : s.idleSince,
    note,
  }))
}

// Why compaction should wait even though the pings are spent.
async function holdReason($: $, s: KeeperState) {
  const box = await $.prompt.read()
  if (box.text.trim() !== '') return 'draft typed'
  const agents = await $.agent.list()
  if (agents.some(agent => agent.status === 'running')) return 'agents running'
  // Shells and agents in flight at the last stop: each one's end wakes the session.
  if (s.backgroundTasks > 0) return 'background tasks running'
  return undefined
}

async function ping($: $, from: KeeperState, hold?: string) {
  const isHeld = hold !== undefined
  await update($, keeper, (s): KeeperState => ({ ...s, phase: 'pinging' }))
  const sentAt = await $.clock.now()
  selfBusy += 1
  const reply = await $.model.fork({ prompt: PING_PROMPT }).finally(() => {
    selfBusy -= 1
  })
  const now = await $.clock.now()

  await update($, keeper, (s): KeeperState => {
    if (s.epoch !== from.epoch) return s
    if (!reply.isAnswered && reply.reason === 'nothing-to-fork') {
      return { ...s, phase: 'unknown', note: '' }
    }
    const served = reply.usage.cache_read_input_tokens
    const written = reply.usage.cache_creation_input_tokens
    const isSent = reply.isAnswered || reply.reason === 'empty-reply'
    if (isSent && served > 0 && served >= written) {
      return {
        ...s,
        phase: 'warm',
        pings: isHeld ? s.pings : s.pings + 1,
        holdPings: isHeld ? s.holdPings + 1 : s.holdPings,
        expiresAt: sentAt + config.ttlMs,
        jitterMs: drawJitter(),
        retryAt: 0,
        note: isHeld ? `compact held: ${hold}` : '',
      }
    }
    if (isSent) {
      // The prefix was written afresh: the entry had already lapsed (a /model, a sleep).
      return { ...s, phase: 'cold', note: 'ping missed the cache; stopped' }
    }
    return { ...s, phase: 'warm', retryAt: now + RETRY_MS, note: `ping failed (${reply.reason})` }
  })
}

async function compact($: $, from: KeeperState) {
  await update($, keeper, (s): KeeperState => ({ ...s, phase: 'compacting' }))
  selfBusy += 1
  let result: CompactResult | undefined
  try {
    result = await $.session.compact(
      config.instructions === '' ? undefined : { instructions: config.instructions },
    )
  } catch {
    result = undefined
  } finally {
    selfBusy -= 1
  }

  const current = await read($, keeper)
  if (current.epoch !== from.epoch) return
  if (result === undefined) {
    // Never retried: a loop of compactions is what this plugin must not cause.
    await update($, keeper, (s): KeeperState => ({ ...s, phase: 'cold', note: 'auto-compact failed' }))
    return
  }
  await markDormant($, result.skip === undefined ? '' : `compact skipped: ${result.skip}`, false)
  $.ui.toast('cache-keeper: idle, conversation compacted; waiting for you')
}

async function act($: $, s: KeeperState, now: number) {
  if (now >= s.expiresAt) {
    await update($, keeper, (cur): KeeperState =>
      cur.epoch === s.epoch ? { ...cur, phase: 'cold', note: 'lapsed before a ping' } : cur,
    )
    return
  }
  if (now < actAt(s)) return

  if (s.pings < config.maxPings) return ping($, s)
  const hold = await holdReason($, s)
  if (hold === undefined) return compact($, s)
  if (s.holdPings < HOLD_PING_CAP) return ping($, s, hold)
  // Held too long: let it lapse rather than ping forever.
}

function describe(s: KeeperState, now: number) {
  if (s.isOff) return 'cache-keeper off'
  const left = s.expiresAt - now
  switch (s.phase) {
    case 'unknown':
      return undefined
    case 'busy':
      return 'cache: active'
    case 'pinging':
      return 'cache: pinging…'
    case 'compacting':
      return 'cache: compacting…'
    case 'cold':
      return `cache cold${s.note === '' ? '' : ` · ${s.note}`}`
    case 'dormant':
      return left > 0
        ? `cache ${clock(left)} · compacted, waiting for you`
        : 'cache cold · compacted, waiting for you'
    case 'warm': {
      const { leadMs, ttlMs, maxPings } = config
      const spent = Math.min(s.pings, maxPings)
      const compactAt = actAt(s) + (maxPings - spent) * (ttlMs - leadMs)
      const tail = s.holdPings > 0 ? '' : ` · compact in ${clock(compactAt - now)}`
      const note = s.note === '' ? '' : ` · ${s.note}`
      return `cache ${clock(left)} · ping ${spent}/${maxPings}${tail}${note}`
    }
  }
}

async function tick($: $) {
  const now = await $.clock.now()
  const s = await read($, keeper)
  if (!s.isOff && !isActing && s.phase === 'warm') {
    isActing = true
    try {
      await act($, s, now)
    } finally {
      isActing = false
    }
  }
  const after = await $.clock.now()
  await update($, ticker, () => after)
  if (config.hasStatus) $.ui.status(describe(await read($, keeper), after))
}

type Tone = 'green' | 'yellow' | 'red' | 'cyan' | 'gray'

type BandView = {
  tone: Tone
  title: string
  idle: string
  steps: string
  next?: { label: string; left: string; tone: Tone }
  cache?: string
  progress?: number
  price?: string
  hits?: string
  rebuild?: string
  note: string
}

// A time this plugin recorded: absent, zero or NaN means it never saw it.
function known(at: number | undefined): at is number {
  return typeof at === 'number' && Number.isFinite(at) && at > 0
}

function span(ms: number) {
  if (!Number.isFinite(ms)) return '-'
  const total = Math.max(0, Math.ceil(ms / 1000))
  if (total < 60) return `${total}s`
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = `${minutes}m ${String(total % 60).padStart(2, '0')}s`
  return hours > 0 ? `${hours}h ${rest}` : rest
}

function urgency(ms: number): Tone {
  return ms <= 15_000 ? 'red' : ms <= 60_000 ? 'yellow' : 'green'
}

function steps(s: KeeperState) {
  const { maxPings } = config
  const spent = Math.min(s.pings, maxPings)
  const dots = Array.from({ length: maxPings }, (_, i) => (i < spent ? '●' : '○')).join('')
  const compacted = s.phase === 'dormant' ? '●' : '○'
  return `ping ${dots} ${spent}/${maxPings} → compact ${compacted}`
}

function bandView(s: KeeperState, now: number): BandView | undefined {
  const { leadMs, ttlMs, maxPings } = config
  const idle = known(s.idleSince) && s.phase !== 'busy' ? span(now - s.idleSince) : '-'
  const note = s.note
  const price =
    s.cache.model === '' ? `${ttlLabel(s.cache)} · ${s.cache.detail || 'checked after the next reply'}` : priceLine(s.cache)
  const base = { idle, steps: steps(s), note, price, hits: hitLine(s.cache), rebuild: rebuildLine(s.cache) }
  const cache = s.expiresAt > now ? span(s.expiresAt - now) : 'lapsed'

  if (s.isOff) return { ...base, tone: 'gray', title: 'off · /cache-keeper on to resume' }
  switch (s.phase) {
    case 'unknown':
      return undefined
    case 'busy':
      return { ...base, tone: 'cyan', title: `working${known(s.activeSince) ? ` ${span(now - s.activeSince)}` : ''} · every request refreshes the cache` }
    case 'pinging':
      return { ...base, tone: 'cyan', title: `pinging ${Math.min(s.pings + 1, maxPings)}/${maxPings}…`, cache }
    case 'compacting':
      return { ...base, tone: 'cyan', title: 'compacting…', cache }
    case 'cold':
      return { ...base, tone: 'gray', title: 'cache cold · next prompt re-caches the context' }
    case 'dormant':
      return { ...base, tone: 'gray', title: 'compacted · waiting for you, no more pings', cache }
    case 'warm': {
      const dueAt = actAt(s)
      const spent = Math.min(s.pings, maxPings)
      const isHeld = s.holdPings > 0
      const label = spent < maxPings ? `ping ${spent + 1}/${maxPings}` : isHeld ? 'ping (compact held)' : 'auto-compact'
      const compactAt = dueAt + (maxPings - spent) * (ttlMs - leadMs)
      const fraction = (now - s.idleSince) / Math.max(1, compactAt - s.idleSince)
      const progress =
        isHeld || !known(s.idleSince) || !Number.isFinite(fraction)
          ? undefined
          : Math.min(1, Math.max(0, fraction))
      return {
        ...base,
        tone: 'green',
        title: 'idle · keeping the cache warm',
        next: { label, left: span(dueAt - now), tone: urgency(dueAt - now) },
        cache,
        progress,
      }
    }
  }
}

function bar(fraction: number, width: number) {
  const filled = Math.round(fraction * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export const register: Register = (on, options) => {
  configure(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.isInteractive) return started

    await $.command.register({
      name: 'cache-keeper',
      description: 'Prompt-cache keeper: status, on or off',
      argumentHint: '[status|on|off]',
    })
    // A reload keeps the state an older version wrote and drops the old module
    // mid-action: fill in the fields it lacked and settle what it left behind.
    await update($, keeper, (saved): KeeperState => {
      const s = { ...INITIAL, ...saved, cache: { ...INITIAL.cache, ...saved?.cache } }
      applyCache(s.cache)
      return s.phase === 'pinging'
        ? { ...s, phase: 'warm' }
        : s.phase === 'compacting'
          ? { ...s, phase: 'cold', note: 'reloaded mid-compact' }
          : s
    })
    $.clock.every(TICK_MS, () => void tick($))
    // Detect at once rather than after the next reply: a reload, a resumed session.
    try {
      const known = (await read($, keeper)).transcriptPath
      const path = known !== '' ? known : await guessTranscript($)
      if (path !== '') await detect($, path)
    } catch {
      // No guess: the first Stop event names the transcript.
    }
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'plugin') {
      expectTurn = true
      await markBusy($)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (selfBusy === 0 || expectTurn) {
      expectTurn = false
      await markBusy($, e.turnId)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const s = await read($, keeper)
    if (e.agentId === undefined && e.turnId === s.turnId) await markWarm($)
    return done
  })

  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (e.agent_id !== undefined) return result
    const inFlight = e.background_tasks?.length ?? 0
    await update($, keeper, (s): KeeperState => ({ ...s, backgroundTasks: inFlight }))
    if (e.transcript_path !== '') await detect($, e.transcript_path)
    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger === 'manual' && result.skip === undefined) {
      await markDormant($, '', true)
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!config.hasBand || e.props.hasSurvey) return next(e)
    const ticked = await read($, ticker)
    const view = bandView(await read($, keeper), ticked > 0 ? ticked : await $.clock.now())
    if (view === undefined) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(10, Math.min(40, e.props.bodyColumns - 34))
    const compactAt = view.progress === undefined ? undefined : `${Math.round(view.progress * 100)}% of the idle run to auto-compact`

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text bold>Cache Keeper </Text>
          <Text color={view.tone} wrap="truncate-end">{view.title}</Text>
          <Text dimColor>{`  idle ${view.idle}`}</Text>
        </Box>
        {e.props.maxRows >= 2 && (
          <Box flexDirection="row">
            <Text>{view.steps}</Text>
            {view.next !== undefined && <Text>{`  next ${view.next.label} in `}</Text>}
            {view.next !== undefined && <Text bold color={view.next.tone}>{view.next.left}</Text>}
            {view.cache !== undefined && <Text dimColor wrap="truncate-end">{`  · cache lapses in ${view.cache}`}</Text>}
          </Box>
        )}
        {e.props.maxRows >= 3 && compactAt !== undefined && view.progress !== undefined && (
          <Text dimColor wrap="truncate-end">{`${bar(view.progress, width)} ${compactAt}`}</Text>
        )}
        {e.props.maxRows >= 4 && view.price !== undefined && <Text dimColor wrap="truncate-end">{view.price}</Text>}
        {e.props.maxRows >= 5 && view.hits !== undefined && <Text dimColor wrap="truncate-end">{view.hits}</Text>}
        {e.props.maxRows >= 3 && view.rebuild !== undefined && <Text color="yellow" wrap="truncate-end">{view.rebuild}</Text>}
        {e.props.maxRows >= 3 && view.note !== '' && <Text color="yellow" wrap="truncate-end">{view.note}</Text>}
      </Box>
    )
  })

  on('command.run', { command: 'cache-keeper' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      await update($, keeper, (s): KeeperState => ({ ...s, isOff: arg === 'off' }))
      await tick($)
      return { text: `cache-keeper ${arg}` }
    }
    const line = describe(await read($, keeper), await $.clock.now()) ?? 'cache: no response yet'
    const s = await read($, keeper)
    const { leadMs, maxPings } = config
    return {
      text: [line, priceLine(s.cache), hitLine(s.cache), rebuildLine(s.cache), `(ping ${leadMs / 1000}s before it lapses, ${maxPings} pings then compact)`]
        .filter(part => part !== undefined)
        .join('\n'),
    }
  })
}
