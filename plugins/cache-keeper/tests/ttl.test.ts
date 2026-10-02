import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// No ttlSeconds: the TTL comes from the transcript.
const AUTO = { options: { leadSeconds: 30, jitterSeconds: 0, maxPings: 3, display: 'both' }, timeoutMs: 60_000 }

const START = { cwd: '/w', surface: 'terminal', isInteractive: true } as const
const TRANSCRIPT = '/home/u/.claude/projects/w/s.jsonl'

const BAND = {
  plugin: 'cache-keeper',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 160, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const

function response(model: string, read: number, written: { m5?: number; h1?: number }) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      model,
      usage: {
        input_tokens: 3,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: (written.m5 ?? 0) + (written.h1 ?? 0),
        cache_creation: { ephemeral_5m_input_tokens: written.m5 ?? 0, ephemeral_1h_input_tokens: written.h1 ?? 0 },
      },
    },
  })
}

function world(on: On, transcript: string, reads: string[] = []) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const seen = { forks: [] as number[], compacts: 0 }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('fs.stat', () => ({ value: { kind: 'file', size: transcript.length, mtimeMs: 0, isSymbolicLink: false } as never }))
  on('fs.read', (_$, e) => {
    reads.push((e as { path: string }).path)
    return { value: transcript }
  })
  on('classic.Stop', () => ({}))
  on('model.fork', () => {
    seen.forks.push(clock.now())
    const usage = { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 0 }
    return { value: { isAnswered: true, text: 'ok', usage } }
  })
  on('session.compact', () => {
    seen.compacts += 1
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }
  })
  return { clock, seen }
}

async function endTurn($: Parameters<Parameters<typeof test>[2] & Function>[0], turnId: string) {
  await $.turn.start({ text: 'hi', turnId })
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId, reason: 'answer' })
  await $.classic.Stop({ stop_hook_active: false, transcript_path: TRANSCRIPT })
}

async function band($: Parameters<Parameters<typeof test>[2] & Function>[0]) {
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const text = (await ui.find({ type: 'Box' }))?.text ?? ''
  await ui.unmount()
  return text
}

async function seconds(clock: { advance: (ms: number) => Promise<void> }, n: number) {
  for (let i = 0; i < n; i += 1) await clock.advance(1000)
}

test('a 1-hour cache is detected: no ping until 59m 30s, prices at the 2× write rate', AUTO, async ($, on) => {
  const lines = [response('claude-opus-5-5', 290_000, { h1: 15_000 }), response('claude-opus-5-5', 297_000, { h1: 8_000 })]
  const { clock, seen } = world(on, lines.join('\n') + '\n')
  await $.session.start(START)
  await endTurn($, 't1')
  await seconds(clock, 10)

  const text = await band($)
  expect(text).toContain('next ping 1/3 in 59m 20s')
  expect(text).toContain('TTL 1h (auto) · opus-5-5 · context 305k · ping ≈ $0.06 · cold rebuild ≈ $2.44 (2× write)')

  await seconds(clock, 400)
  expect(seen.forks.length).toBe(0)
  expect(seen.compacts).toBe(0)
})

test('any 5-minute write in the latest response means 5m, priced at 1.25×', AUTO, async ($, on) => {
  const lines = [response('claude-sonnet-5-5', 100_000, { h1: 4_000, m5: 900 })]
  const { clock, seen } = world(on, lines.join('\n'))
  await $.session.start(START)
  await endTurn($, 't1')
  await seconds(clock, 10)

  const text = await band($)
  expect(text).toContain('next ping 1/3 in 4m 20s')
  expect(text).toContain('TTL 5m (auto) · sonnet-5-5 · context 105k · ping ≈ $0.02 · cold rebuild ≈ $0.26 (1.25× write)')
  await seconds(clock, 265)
  expect(seen.forks.length).toBe(1)
})

test('a response that only read the cache keeps the TTL of the last one that wrote', AUTO, async ($, on) => {
  const lines = [response('claude-opus-5-5', 100_000, { h1: 2_000 }), response('claude-opus-5-5', 102_000, {})]
  const { clock } = world(on, lines.join('\n'))
  await $.session.start(START)
  await endTurn($, 't1')
  await seconds(clock, 1)
  expect(await band($)).toContain('TTL 1h (auto)')
})

test('before anything was detected it assumes 5m, the safe side', AUTO, async ($, on) => {
  const { clock } = world(on, '')
  await $.session.start(START)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await seconds(clock, 10)
  expect(await band($)).toContain('next ping 1/3 in 4m 20s')
})

test('an explicit ttlSeconds overrides what the transcript shows', { ...AUTO, options: { ...AUTO.options, ttlSeconds: 300 } }, async ($, on) => {
  const lines = [response('claude-opus-5-5', 290_000, { h1: 15_000 })]
  const { clock } = world(on, lines.join('\n'))
  await $.session.start(START)
  await endTurn($, 't1')
  await seconds(clock, 10)
  const text = await band($)
  expect(text).toContain('next ping 1/3 in 4m 20s')
  expect(text).toContain('TTL 5m 00s (set)')
})

test('on load it reads this session transcript by itself, before any Stop event', AUTO, async ($, on) => {
  const reads: string[] = []
  const { clock } = world(on, response('claude-opus-5-5', 290_000, { h1: 15_000 }), reads)
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/u' : undefined }))
  on('session.root', () => ({ value: 'D:/Work/2026/workspace' }))
  on('session.id', () => ({ value: 'abc-123' }))
  await $.session.start(START)
  // The host normalises separators to the platform's own.
  expect(reads.join().replace(/\\/g, '/')).toContain('C:/Users/u/.claude/projects/D--Work-2026-workspace/abc-123.jsonl')

  // No classic.Stop raised: the TTL below can only come from the load.
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await seconds(clock, 10)
  const text = await band($)
  expect(text).toContain('TTL 1h (auto) · opus-5-5')
  expect(text).toContain('next ping 1/3 in 59m 20s')
})

test('with nothing detected the band says why instead of hiding the TTL row', AUTO, async ($, on) => {
  const { clock } = world(on, '')
  await $.session.start(START)
  await endTurn($, 't1')
  await seconds(clock, 1)
  expect(await band($)).toContain('TTL 5m (assumed) · checked after the next reply')
})
