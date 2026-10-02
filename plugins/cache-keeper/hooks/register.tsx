import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { KeeperState } from '../types'

type $ = EngineInterface
type CompactResult = Awaited<ReturnType<$['session']['compact']>>

const PING_PROMPT =
  'Prompt-cache keep-alive from the cache-keeper plugin. Reply with exactly: ok'
const TICK_MS = 1000
const RETRY_MS = 10_000
// Pings allowed past maxPings while compaction is held (draft typed, agents running).
const HOLD_PING_CAP = 6

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
}

const keeper = atom({ plugin: 'cache-keeper', key: 'keeper' } as const, INITIAL)
// Written every tick so the band redraws each second.
const ticker = atom({ plugin: 'cache-keeper', key: 'now' } as const, 0)

const config = {
  ttlMs: 300_000,
  leadMs: 30_000,
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
  config.ttlMs = positive(options.ttlSeconds, 300) * 1000
  config.leadMs = Math.min(positive(options.leadSeconds, 30) * 1000, config.ttlMs / 2)
  config.maxPings = Math.floor(positive(options.maxPings, 3))
  const text = options.compactInstructions
  config.instructions = typeof text === 'string' ? text.trim() : ''
  const display = options.display
  config.hasBand = display !== 'status'
  config.hasStatus = display === 'status' || display === 'both'
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
async function holdReason($: $) {
  const box = await $.prompt.read()
  if (box.text.trim() !== '') return 'draft typed'
  const agents = await $.agent.list()
  if (agents.some(agent => agent.status === 'running')) return 'agents running'
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
  if (now < s.expiresAt - config.leadMs || now < s.retryAt) return

  if (s.pings < config.maxPings) return ping($, s)
  const hold = await holdReason($)
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
      const compactAt = s.expiresAt - leadMs + (maxPings - spent) * (ttlMs - leadMs)
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
  const base = { idle, steps: steps(s), note }
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
      const actAt = Math.max(s.expiresAt - leadMs, s.retryAt)
      const spent = Math.min(s.pings, maxPings)
      const isHeld = s.holdPings > 0
      const label = spent < maxPings ? `ping ${spent + 1}/${maxPings}` : isHeld ? 'ping (compact held)' : 'auto-compact'
      const compactAt = s.expiresAt - leadMs + (maxPings - spent) * (ttlMs - leadMs)
      const fraction = (now - s.idleSince) / Math.max(1, compactAt - s.idleSince)
      const progress =
        isHeld || !known(s.idleSince) || !Number.isFinite(fraction)
          ? undefined
          : Math.min(1, Math.max(0, fraction))
      return {
        ...base,
        tone: 'green',
        title: 'idle · keeping the cache warm',
        next: { label, left: span(actAt - now), tone: urgency(actAt - now) },
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
      const s = { ...INITIAL, ...saved }
      return s.phase === 'pinging'
        ? { ...s, phase: 'warm' }
        : s.phase === 'compacting'
          ? { ...s, phase: 'cold', note: 'reloaded mid-compact' }
          : s
    })
    $.clock.every(TICK_MS, () => void tick($))
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
    const { ttlMs, leadMs, maxPings } = config
    return {
      text: `${line}\n(ttl ${ttlMs / 1000}s, ping ${leadMs / 1000}s before it lapses, ${maxPings} pings then compact)`,
    }
  })
}
