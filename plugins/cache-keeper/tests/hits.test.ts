import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const AUTO = { options: { leadSeconds: 30, jitterSeconds: 0, maxPings: 3, display: 'both' }, timeoutMs: 60_000 }
const START = { cwd: '/w', surface: 'terminal', isInteractive: true } as const
const TRANSCRIPT = '/home/u/.claude/projects/w/s.jsonl'
const BAND = {
  plugin: 'cache-keeper',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 160, scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const

type Usage = { read: number; wrote: number; uncached?: number; ttl?: '5m' | '1h' }

// One API response as Claude Code writes it: possibly several rows sharing the message id.
function response(id: string, u: Usage, rows = 1) {
  const split = u.ttl === '5m' ? { ephemeral_5m_input_tokens: u.wrote, ephemeral_1h_input_tokens: 0 } : { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: u.wrote }
  const row = JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    message: {
      id,
      model: 'claude-opus-5-5',
      usage: {
        input_tokens: u.uncached ?? 2,
        cache_read_input_tokens: u.read,
        cache_creation_input_tokens: u.wrote,
        cache_creation: split,
        output_tokens: 50,
      },
    },
  })
  return Array.from({ length: rows }, () => row)
}

const BOUNDARY = JSON.stringify({ type: 'system', subtype: 'compact_boundary' })
const SIDECHAIN = JSON.stringify({
  type: 'assistant',
  isSidechain: true,
  message: { id: 'sub', model: 'claude-haiku-4-5', usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 90_000 } },
})

function world(on: On, lines: string[]) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const transcript = lines.join('\n') + '\n'
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.Stop', () => ({}))
  on('ui.status', () => ({ value: undefined }))
  on('fs.stat', () => ({ value: { kind: 'file', size: transcript.length, mtimeMs: 0, isSymbolicLink: false } as never }))
  on('fs.read', () => ({ value: transcript }))
  return clock
}

async function bandAfterTurn($: Parameters<Parameters<typeof test>[2] & Function>[0], clock: { advance: (ms: number) => Promise<void> }) {
  await $.session.start(START)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.classic.Stop({ stop_hook_active: false, transcript_path: TRANSCRIPT })
  await clock.advance(1000)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const text = (await ui.find({ type: 'Box' }))?.text ?? ''
  await ui.unmount()
  return text
}

test('hit rates count each API response once, however many rows it spans', AUTO, async ($, on) => {
  const lines = [
    ...response('m1', { read: 0, wrote: 30_000, uncached: 0 }, 3),
    ...response('m2', { read: 30_000, wrote: 10_000, uncached: 0 }, 2),
    ...response('m3', { read: 39_600, wrote: 400, uncached: 0 }, 4),
    SIDECHAIN,
  ]
  const text = await bandAfterTurn($, world(on, lines))
  // last: 39,600 / 40,000; session: 69,600 / 110,000 over 3 requests (the subagent's row is not the session's).
  expect(text).toContain('cache hit 99.0% last request · 63.3% this session (3 requests)')
  expect(text).not.toContain('⚠')
})

test('a request that rebuilds the cache is flagged with what it cost', AUTO, async ($, on) => {
  const lines = [...response('m1', { read: 200_000, wrote: 2_000 }), ...response('m2', { read: 0, wrote: 203_000 })]
  const text = await bandAfterTurn($, world(on, lines))
  // 203k written at Opus 5.5's $4 input × 2 (1-hour write) = $1.62
  expect(text).toContain('⚠ cache rebuilt by the last request: read 0 / wrote 203k (≈ $1.62)')
  expect(text).toContain('cache hit 0.0% last request')
})

test('the rebuild right after a compaction is expected, not flagged', AUTO, async ($, on) => {
  const lines = [...response('m1', { read: 200_000, wrote: 2_000 }), BOUNDARY, ...response('m2', { read: 0, wrote: 25_000 })]
  const text = await bandAfterTurn($, world(on, lines))
  expect(text).not.toContain('⚠')
})

test('small prompts never raise the warning', AUTO, async ($, on) => {
  const lines = [...response('m1', { read: 8_000, wrote: 500 }), ...response('m2', { read: 0, wrote: 9_000 })]
  const text = await bandAfterTurn($, world(on, lines))
  expect(text).not.toContain('⚠')
})

// A transcript past what one $.fs.read takes (4 MiB): only its tail is read, by a child process.
function bigWorld(on: On, tail: string, failure?: string) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const seen = { reads: 0, runs: [] as { argv: readonly string[]; env?: Record<string, string> }[] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.Stop', () => ({}))
  on('ui.status', () => ({ value: undefined }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 17_000_000, mtimeMs: 0, isSymbolicLink: false } as never }))
  on('fs.read', () => {
    seen.reads += 1
    throw new Error('over 4 MiB')
  })
  on('process.run', (_$, e) => {
    seen.runs.push({ argv: e.argv, env: e.init?.env })
    const exitCode = failure === undefined ? 0 : 1
    return { value: { exitCode, stdout: tail, stderr: failure ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { clock, seen }
}

test('a transcript past 4 MiB is read from its tail, the cut first line dropped', AUTO, async ($, on) => {
  // The tail starts mid-row: a broken fragment that even names a compaction.
  const fragment = 'ory":"compact_boundary","usage":{"cache_read_input_tokens":1}}'
  const lines = [fragment, ...response('m1', { read: 300_000, wrote: 4_000 }), ...response('m2', { read: 303_000, wrote: 1_000 })]
  const { clock, seen } = bigWorld(on, lines.join('\n') + '\n')
  const text = await bandAfterTurn($, clock)
  expect(seen.reads).toBe(0)
  expect(seen.runs[0]?.argv).toEqual(['tail', '-c', '3145728', TRANSCRIPT])
  expect(text).toContain('TTL 1h (auto)')
  expect(text).toContain('cache hit 99.7% last request · 99.2% the last 2 requests')
})

test('on Windows the tail comes from PowerShell, the path passed outside the script', AUTO, async ($, on) => {
  const path = 'C:\\Users\\u\\.claude\\projects\\w\\s.jsonl'
  const { clock, seen } = bigWorld(on, ['', ...response('m1', { read: 0, wrote: 40_000, ttl: '5m' })].join('\n'))
  await $.session.start(START)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.classic.Stop({ stop_hook_active: false, transcript_path: path })
  await clock.advance(1000)
  const run = seen.runs.at(-1)!
  expect(run.argv[0]).toBe('powershell.exe')
  expect(run.argv.join(' ')).not.toContain(path)
  expect(run.env?.CACHE_KEEPER_PATH).toContain('s.jsonl')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Box' }))?.text ?? '').toContain('TTL 5m (auto)')
  await ui.unmount()
})

test('a tail that fails to read says why, without the path', AUTO, async ($, on) => {
  const { clock } = bigWorld(on, '', 'tail: Permission denied\nmore')
  const text = await bandAfterTurn($, clock)
  expect(text).toContain('TTL 5m (assumed) · transcript unreadable: tail: Permission denied')
})
