import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// 60 s TTL, act 10 s before it lapses: one action every 50 s, compaction at 200 s.
const OPTIONS = { ttlSeconds: 60, leadSeconds: 10, jitterSeconds: 0, maxPings: 3, display: 'both' }
const SLOW = { options: OPTIONS, timeoutMs: 60_000 }
const START = { cwd: '/w', surface: 'terminal', isInteractive: true } as const

type Agent = { id: string; description: string; type: string; status: string }

function world(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const seen = { forks: [] as number[], compacts: [] as number[], status: '' as string | undefined, agents: [] as Agent[] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.Stop', () => ({}))
  on('fs.stat', () => ({ value: { kind: 'other', size: 0, mtimeMs: 0, isSymbolicLink: false } as never }))
  on('ui.status', (_$, e) => {
    seen.status = e.text
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('agent.list', () => ({ value: seen.agents }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('model.fork', () => {
    seen.forks.push(clock.now())
    const usage = { input_tokens: 12, output_tokens: 2, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 }
    return { value: { isAnswered: true, text: 'ok', usage } }
  })
  on('session.compact', () => {
    seen.compacts.push(clock.now())
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }
  })
  return { clock, seen }
}

const complete = (turnId: string, agentId?: string) =>
  ({ answer: 'done', durationMs: 10, isAborted: false, turnId, reason: 'answer', agentId }) as const

async function seconds(clock: { advance: (ms: number) => Promise<void> }, n: number) {
  for (let i = 0; i < n; i += 1) await clock.advance(1000)
}

test('a subagent finishing a turn does not restart the main cache countdown', SLOW, async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start(START)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(complete('t1'))
  await seconds(clock, 120)
  expect(seen.forks.length).toBe(2)

  // Its requests use its own transcript: they never refresh the main thread's cache.
  await $.turn.complete(complete('sub-1', 'agent-7'))
  await seconds(clock, 85)
  expect(seen.forks.length).toBe(3)
  expect(seen.compacts.length).toBe(1)
})

test('a running background agent holds the compaction; its end lets it through', SLOW, async ($, on) => {
  const { clock, seen } = world(on)
  seen.agents = [{ id: 'a1', description: 'research', type: 'general-purpose', status: 'running' }]
  await $.session.start(START)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(complete('t1'))

  await seconds(clock, 255)
  expect(seen.compacts.length).toBe(0)
  expect(seen.forks.length).toBe(5)
  expect(seen.status).toMatch(/compact held: agents running/)

  seen.agents = [{ ...seen.agents[0]!, status: 'completed' }]
  await seconds(clock, 50)
  expect(seen.compacts.length).toBe(1)
})

test('background shells at the last stop hold the compaction too', SLOW, async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start(START)
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.turn.complete(complete('t1'))
  const shell = { id: 'b1', type: 'local_bash', status: 'running', description: 'npm run build' }
  await $.classic.Stop({ stop_hook_active: false, transcript_path: '', background_tasks: [shell] })

  await seconds(clock, 255)
  expect(seen.compacts.length).toBe(0)
  expect(seen.status).toMatch(/compact held: background tasks running/)

  // The shell's end wakes the session: a new turn, and a stop with nothing in flight.
  await $.turn.start({ text: '', turnId: 't2' })
  await $.turn.complete(complete('t2'))
  await $.classic.Stop({ stop_hook_active: false, transcript_path: '', background_tasks: [] })
  await seconds(clock, 205)
  expect(seen.compacts.length).toBe(1)
})

test('held pings stop after the cap: the cache is left to lapse, never compacted', SLOW, async ($, on) => {
  const { clock, seen } = world(on)
  seen.agents = [{ id: 'a1', description: 'long job', type: 'general-purpose', status: 'running' }]
  await $.session.start(START)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(complete('t1'))
  await seconds(clock, 700)
  expect(seen.forks.length).toBe(3 + 6)
  expect(seen.compacts.length).toBe(0)
  expect(seen.status).toMatch(/^cache cold/)
})

test('jitter acts a little early at random, never late', { ...SLOW, options: { ...OPTIONS, jitterSeconds: 20 } }, async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.start(START)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const t0 = clock.now()
  await $.turn.complete(complete('t1'))
  await seconds(clock, 60)
  // Jitter is capped at 10% of the 60 s TTL: the first ping lands between 44 s and 50 s.
  expect(seen.forks.length).toBe(1)
  const at = (seen.forks[0]! - t0) / 1000
  expect(at).toBeGreaterThanOrEqual(44)
  expect(at).toBeLessThanOrEqual(50)
})
