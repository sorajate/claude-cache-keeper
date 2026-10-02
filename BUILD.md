# BUILD.md: brief for a Claude Code agent

Paste this file to a Claude Code agent, or point it here, to rebuild, port or extend **cache-keeper**. The finished reference implementation is in `plugins/cache-keeper/`. Read it alongside this brief.

---

## The prompt

> Build a Claude Code **function-hook plugin** (a "mod") named `cache-keeper`. First load the `plugin-authoring` skill, then treat the `claude-code.d.ts` it writes as the authority on every API name and shape. The plugin keeps the main conversation's prompt cache warm while the person is idle, compacts once when they stay away, and never compacts again until they come back. It shows all of this live in a band above the prompt.
>
> **Behaviour**
>
> 1. When a main-thread turn ends, the cache is fresh: set `expiresAt = now + TTL` and `idleSince = now`, and reset the ping count. **Detect the TTL; don't configure it.** Claude Code chooses 5m or 1h itself. In a `classic.Stop` hook (main thread: `e.agent_id === undefined`), read `e.transcript_path` with `$.fs.read` and walk the newest `assistant` rows that are not sidechains. The first one gives `model` and context (`input + cache_read + cache_creation`), and the newest one with a cache write gives the TTL: any `ephemeral_5m_input_tokens > 0` → 5m, else `ephemeral_1h_input_tokens > 0` → 1h. Assume 5m until a write is seen. If the TTL changed while warm, re-time `expiresAt = idleSince + TTL`. `ttlSeconds > 0` overrides.
> 2. At `expiresAt - lead` (lead default 30 s), if fewer than `maxPings` (default 3) pings have been sent, send a keep-alive ping with `$.model.fork({ prompt })`. That is one tool-less request over the session's own transcript, so the API serves the prefix from cache and the cache TTL restarts. On success, `pings += 1` and `expiresAt = sentAt + TTL`.
> 3. Once all pings are spent, at the next `expiresAt - lead` (still before the last window lapses, so the summariser reads a warm cache) call `$.session.compact()`. Then go **dormant**: start a fresh countdown for display, but never ping or compact again.
> 4. Only real activity leaves dormant and re-arms the cycle: a `prompt.submit` whose `origin.kind !== 'plugin'`, or a main `turn.start`. The person's own `/compact` (`session.compact` with `trigger: 'manual'`) also goes to dormant. Compacting a compacted context again is how context gets lost.
> 5. **Hold** the compaction (and ping instead, at most 6 extra) while the prompt box holds a draft (`$.prompt.read()`) or an agent is running (`$.agent.list()`).
> 6. **Go cold, never spend** when the cache has already lapsed (`now >= expiresAt`, e.g. the machine slept), when a ping reports `cache_read_input_tokens` of 0 or less than `cache_creation_input_tokens` (the prefix was re-written: `/model`, lapse), or when pings fail until expiry. Retry a failed ping after 10 s while the window lasts. Never retry a failed compaction.
> 7. Ignore the plugin's own requests. Keep a `selfBusy` counter around fork and compact, skip `turn.start` while it is non-zero unless a real `prompt.submit` just armed `expectTurn`, and accept `turn.complete` only for the main loop (`agentId === undefined`) whose `turnId` was recorded at a real `turn.start`. Subagent turns never reset the timer: they use their own transcript.
>
> **Display** (`ui.render` on `{ component: 'AbovePrompt' }`, redrawn each second by writing a `now` atom from a 1 s `$.clock.every` started in `session.start`)
>
> - Row 1: `Cache Keeper <state title>  idle <duration>`
> - Row 2: `ping ●●○ 2/3 → compact ○  next <action> in <seconds>  · cache lapses in <duration>`. The countdown is green above 60 s, yellow at 60 s or less, red at 15 s or less.
> - Row 3: a `█░` bar plus `NN% of the idle run to auto-compact`.
> - Row 4: `TTL 1h (auto) · opus-5-5 · context 305k · ping ≈ $0.06 · cold rebuild ≈ $2.44 (2× write)`. A ping costs context × the model's cache-read rate. A rebuild costs context × input × 1.25 (5m) or 2 (1h). Optional last row: a yellow note such as `compact held: draft typed`.
> - Other states: `working <t>`, `pinging…`, `compacting…`, `compacted · waiting for you, no more pings`, `cache cold · …`, `off`.
> - Respect `e.props.maxRows`, size to `e.props.bodyColumns`, and return `next(e)` when `hasSurvey` is set or there is nothing to show.
> - A `display` option of `band`, `status` (`$.ui.status` one-liner) or `both`.
>
> **Also**: a `/cache-keeper [status|on|off]` command (`$.command.register` in `session.start`, answered by `command.run`), and `userConfig` options `ttlSeconds`, `leadSeconds`, `maxPings`, `compactInstructions` and `display`. Do nothing in non-interactive sessions (`session.start`'s `e.isInteractive`).
>
> **Done means** `claude plugin validate`, `tsc -p` and `claude plugin test` all pass, with tests for: 3 pings then 1 compaction at the right times, nothing more after the compaction however long it stays idle, a new turn mid-cycle restarting the count, a draft holding the compaction, a manual `/compact` going dormant, failing pings going cold, and the band's text on the `terminal` and `desktop` surfaces.

---

## Layout

```
.claude-plugin/marketplace.json      # makes the repo installable: /plugin marketplace add <owner>/<repo>
plugins/cache-keeper/
  .claude-plugin/plugin.json         # name, version, "types", userConfig
  hooks/hooks.json                   # { "modules": ["./register.tsx"] }
  hooks/register.tsx                 # the whole plugin
  types/index.d.ts                   # $.state contract: 'cache-keeper': { keeper: KeeperState; now: number }
  tests/keeper.test.ts               # claude plugin test
  tsconfig.json
```

## State model

All state that must survive a hot reload lives in `$.state` (`atom` / `read` / `update` from `'claude-code'`). Module variables reset on reload.

| Phase | Entered on | Does |
| --- | --- | --- |
| `unknown` | start, before any reply | nothing; band hidden |
| `busy` | real prompt or main `turn.start` | nothing; shows `working` |
| `warm` | main `turn.complete`, successful ping | ping or compact at `expiresAt - lead` |
| `pinging` / `compacting` | the action in flight | nothing |
| `dormant` | after any compaction | countdown only, no actions |
| `cold` | lapsed or ping missed/failed | nothing |

An `epoch` counter goes up on every real activity. When a ping or compaction resolves, its result is applied only if the epoch is unchanged, so a reply that arrives after the person came back is dropped.

## Hard-won API notes (Claude Code 2.1.287)

The plugin API is early access, so check each of these against the current `claude-code.d.ts`.

- **Functions that take `$` must be top-level declarations** (`function x($) {}` or a `const` bound to one). `claude plugin validate` rejects `$` passed to closures defined inside `register`. Keep configuration in a module-level object that `register(on, options)` fills.
- **`update($, atom, fn)` callbacks need a return-type annotation** (`(s): KeeperState => ({ ...s, phase: 'warm' })`). Otherwise the string-literal union widens to `string` and nothing type-checks.
- **`$.state` outlives a reload, and so does an older version's shape.** On `session.start`, merge the stored value over the defaults (`{ ...INITIAL, ...saved }`) and treat absent or `NaN` times as unknown. Without this, 0.2.0 drew `NaN%` over 0.1.0's state.
- **Classic hook events are hookable as `classic.<Event>`.** `classic.Stop` carries `transcript_path` and `background_tasks`. In tests, raise it with `$.classic.Stop({ stop_hook_active: false, transcript_path })` and answer `on('classic.Stop', () => ({}))` beneath. Mock `fs.stat` and `fs.read` as operations (`{ value }`).
- **The validator treats every name handed `$` as one function.** A local `const ping = …` elsewhere in the file counts as a second declaration of `ping($, …)`.
- **`$.model.fork`** answers `nothing-to-fork` before the first reply and after `/clear`. Its `usage` (on every arm except that one) tells you whether the cache served the prefix.
- **`$.session.compact()`** rejects while a turn runs and resolves `{ skip }` when a hook vetoed it.
- **`$.clock.every(ms, fn)`** started in `session.start` keeps running until reload. `$` captured there stays valid in the callback.
- The module is `.tsx` because the band uses JSX. Elements come from `$.ui.resolve(e)`, not globals.
- **Test kit (`claude-code/testing`):**
  - Operation events (`command.register`, `ui.status`, `ui.toast`, `agent.list`, `prompt.read`, `model.fork`, `state.get`) are answered as `{ value: ... }`. Core events (`session.start`, `turn.start`, `turn.complete`, `session.compact`) are answered with their result directly.
  - A compaction answer needs at least one message.
  - Register each event only once per test.
  - `mock.clock(on)` plus `advance(1000)` in a loop drives the ticker. `clock.set` fires every tick on the way, so it can't simulate a sleeping machine.
  - `$.ui.mount({ plugin, surface, component: 'AbovePrompt', props: { hasSurvey, isWorking, maxRows, bodyColumns, scroll: { offset, bodyRows }, view: {} } })`, then `(await ui.find({ type: 'Box' }))?.text` gives the whole band as one string.
  - The test's `$` has no `state` noun. To seed old state, wrap `state.get` and rewrite `stored.value.value`.

## Verify

```sh
cd plugins/cache-keeper
claude plugin validate .
claude plugin test .
tsc -p .          # after Claude Code has loaded the plugin once and written .claude-plugin/types/
```

Then load it live with `claude --plugin-dir plugins/cache-keeper` and set `ttlSeconds` to 60 to watch a full cycle in about 4 minutes.

## Ideas not built yet

- Hold the compaction on `classic.Stop`'s `background_tasks` (it lists running background Bash too).
- Show the estimated money saved per idle stretch, using `usage` from the pings and the turn before.
