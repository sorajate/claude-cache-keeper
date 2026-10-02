import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// 60 s TTL, act 10 s before it lapses: one action every 50 s, compaction at 200 s.
const OPTIONS = { ttlSeconds: 60, leadSeconds: 10, jitterSeconds: 0, maxPings: 3, display: 'both' }
const SLOW = { options: OPTIONS, timeoutMs: 60_000 }

const HIT = {
  input_tokens: 12,
  output_tokens: 2,
  cache_read_input_tokens: 40_000,
  cache_creation_input_tokens: 0,
}

function world(on: On, failPings = false) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const seen = { forks: [] as number[], compacts: [] as number[], status: '' as string | undefined, draft: '' }

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.status', (_$, e) => {
    seen.status = e.text
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('prompt.read', () => ({ value: { text: seen.draft, cursor: seen.draft.length } }))
  on('model.fork', () => {
    seen.forks.push(clock.now())
    if (failPings) {
      const usage = { ...HIT, cache_read_input_tokens: 0, output_tokens: 0 }
      return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage } }
    }
    return { value: { isAnswered: true, text: 'ok', usage: HIT } }
  })
  on('session.compact', () => {
    seen.compacts.push(clock.now())
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }
  })

  return { clock, seen }
}

const START = { cwd: '/w', surface: 'terminal', isInteractive: true } as const

const turn = (turnId: string) => ({
  answer: 'done',
  durationMs: 10,
  isAborted: false,
  turnId,
  reason: 'answer',
}) as const

async function seconds(clock: { advance: (ms: number) => Promise<void> }, n: number) {
  for (let i = 0; i < n; i += 1) await clock.advance(1000)
}

test('pings three times before each lapse, then compacts once before the third window ends', SLOW, async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start(START)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(turn('t1'))
  const t0 = clock.now()

  await seconds(clock, 5)
  expect(seen.status).toMatch(/^cache 0:5\d · ping 0\/3 · compact in 3:1\d$/)

  await seconds(clock, 210)
  expect(seen.forks.map(at => (at - t0) / 1000)).toEqual([50, 100, 150])
  expect(seen.compacts.map(at => (at - t0) / 1000)).toEqual([200])
  expect(seen.status).toMatch(/compacted, waiting for you/)
})

test('after the idle compaction nothing fires again, however long it stays idle', SLOW, async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start(START)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(turn('t1'))

  await seconds(clock, 900)
  expect(seen.forks.length).toBe(3)
  expect(seen.compacts.length).toBe(1)
  expect(seen.status).toBe('cache cold · compacted, waiting for you')
})

test('a new turn mid-cycle starts the count afresh', SLOW, async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start(START)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(turn('t1'))
  await seconds(clock, 120)
  expect(seen.forks.length).toBe(2)

  await $.turn.start({ text: 'more', turnId: 't2' })
  await $.turn.complete(turn('t2'))
  await seconds(clock, 160)
  expect(seen.forks.length).toBe(5)
  expect(seen.compacts.length).toBe(0)
  await seconds(clock, 50)
  expect(seen.compacts.length).toBe(1)
})

test('a typed draft holds the compaction and keeps the cache warm instead', SLOW, async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start(START)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(turn('t1'))
  seen.draft = 'half a thought'

  await seconds(clock, 255)
  expect(seen.compacts.length).toBe(0)
  expect(seen.forks.length).toBe(5)
  expect(seen.status).toMatch(/compact held: draft typed/)

  seen.draft = ''
  await seconds(clock, 50)
  expect(seen.compacts.length).toBe(1)
})

test('the person\'s own /compact counts afresh but never pings or compacts again', SLOW, async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start(START)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(turn('t1'))
  await seconds(clock, 20)

  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'x', toolUses: [] }] } as never)
  await seconds(clock, 5)
  expect(seen.status).toMatch(/^cache 0:5\d · compacted, waiting for you$/)
  await seconds(clock, 600)
  expect(seen.forks.length).toBe(0)
  expect(seen.compacts.length).toBe(1)
})

test('pings that keep failing let the cache go cold, with no compaction', SLOW, async ($, on) => {
  const { clock, seen } = world(on, true)
  await $.session.start(START)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(turn('t1'))
  await seconds(clock, 400)
  expect(seen.forks.length).toBe(1)
  expect(seen.compacts.length).toBe(0)
  expect(seen.status).toBe('cache cold · lapsed before a ping')
})

const BAND = {
  plugin: 'cache-keeper',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const

test('the band shows the step, the seconds to the next action and the idle time', SLOW, async ($, on) => {
  const { clock } = world(on)
  await $.session.start(START)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(turn('t1'))
  await seconds(clock, 20)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const text = (await ui.find({ type: 'Box' }))?.text ?? ''
    expect(text).toContain('Cache Keeper idle · keeping the cache warm  idle 20s')
    expect(text).toContain('ping ○○○ 0/3 → compact ○  next ping 1/3 in 30s  · cache lapses in 40s')
    expect(text).toContain('10% of the idle run to auto-compact')
    await ui.unmount()
  }

  await seconds(clock, 200)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const text = (await ui.find({ type: 'Box' }))?.text ?? ''
  expect(text).toContain('compacted · waiting for you, no more pings  idle 3m 40s')
  expect(text).toContain('ping ●●● 3/3 → compact ●')
  await ui.unmount()
})

test('state saved by 0.1.0 (no idle fields) never draws NaN after the reload', SLOW, async ($, on) => {
  const { clock } = world(on)
  const now = clock.now()
  const old = { phase: 'warm', isOff: false, pings: 1, holdPings: 0, expiresAt: now + 40_000, epoch: 3, turnId: 't0', retryAt: 0, note: '' }
  // The host still holds what 0.1.0 wrote until the plugin writes again.
  on('state.get', async (_$, e, next) => {
    const stored = await next(e)
    const read = stored.value
    return e.key === 'keeper' && read !== undefined && read.value === undefined
      ? { value: { ...read, value: old } }
      : stored
  })
  await $.session.start(START)
  await seconds(clock, 2)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const text = (await ui.find({ type: 'Box' }))?.text ?? ''
  expect(text).not.toContain('NaN')
  expect(text).toContain('idle -')
  expect(text).toContain('next ping 2/3 in 28s')
  await ui.unmount()

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(turn('t1'))
  await seconds(clock, 5)
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const fresh = (await after.find({ type: 'Box' }))?.text ?? ''
  expect(fresh).toContain('idle 5s')
  expect(fresh).toMatch(/\d+% of the idle run to auto-compact/)
  await after.unmount()
})
