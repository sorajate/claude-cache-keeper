# claude-cache-keeper

A Claude Code plugin that keeps the **prompt cache** warm while you step away, then compacts the conversation **once** and waits for you.

Claude Code caches your conversation after each request, for 5 minutes or 1 hour depending on how it runs. Come back after the cache lapses and the next prompt writes the whole context into the cache again. One keep-alive ping only *reads* the cache, a small fraction of that price, and restarts the timer.

The plugin detects which TTL your session actually uses and times everything to it.

```
Cache Keeper idle · keeping the cache warm  idle 2m 15s
ping ●○○ 1/3 → compact ○  next ping 2/3 in 42s  · cache lapses in 1m 12s
███████░░░░░░░░░░░░░░░░░░░░░░░░░ 22% of the idle run to auto-compact
TTL 1h (auto) · opus-5-5 · context 305k · ping ≈ $0.06 · cold rebuild ≈ $2.44 (2× write)
```

## 5 minutes or 1 hour: what it costs

Claude Code picks the cache TTL itself (there is no setting for it). Subscription sessions have been seen on **1 hour**, and the default API cache is **5 minutes**. When it loads and after every turn, the plugin reads the newest responses in the session transcript: `usage.cache_creation` splits each write into `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`. A response with any 5-minute write counts as 5m, because its tail lapses first. Until a write has been seen, the plugin assumes 5m. Being wrong in that direction only costs an early ping, while assuming 1h too early would compact a cache that is about to lapse.

| | 5-minute TTL | 1-hour TTL |
| --- | --- | --- |
| Cache write | 1.25× input | **2×** input |
| Cache read (a ping) | 0.1× input (0.05× Opus 5.5, 0.025× Fable 5.1) | same |
| Lapses after | 5 min idle | 60 min idle |

The 1-hour TTL pays more on every turn, but only on the *new* tokens that turn writes. In exchange it survives breaks up to an hour without any ping. With the defaults, the plugin pings at **4m 30s / 59m 30s**, and the auto-compact lands about **18 min** (5m) or **about 4 h** (1h) into an idle stretch.

The band's last row prices one ping and one cold rebuild of your current context, at first-party API list prices. On a subscription you pay in usage limits instead of dollars, but the ratio between ping and rebuild is the same.

## What it does

With the defaults (5 min TTL, act 30 s before it lapses, 3 pings):

```
turn ends  → cache 5:00, idle starts
 4:30      → ping 1/3   (one tool-less request over the cached transcript)
 9:00      → ping 2/3
13:30      → ping 3/3
18:00      → auto-compact, while the cache is still warm (cheap to read)
           → "compacted · waiting for you": counts the new cache down,
             never pings or compacts again until you do something
```

- **Never compacts twice.** After the idle compaction, or your own `/compact`, it goes dormant. Only your next prompt or turn re-arms it, so a long absence can't summarise the context away.
- **Holds compaction** while you have a draft typed in the prompt box or background agents are running. It keeps pinging instead, up to 6 more times.
- **Stops when pinging is pointless.** If the cache has already lapsed (laptop asleep, `/model` switched) or pings keep failing, it shows `cache cold` and does nothing. A ping then would only pay for a full re-cache.
- **Ignores its own requests**, so pings and compactions never re-arm the timer. Subagent turns don't reset it either: they use their own transcript, not the main thread's cache.

## Install

Inside Claude Code:

```
/plugin marketplace add sorajate/claude-cache-keeper
/plugin install cache-keeper@claude-cache-keeper
```

Or from a terminal:

```sh
claude plugin marketplace add sorajate/claude-cache-keeper
claude plugin install cache-keeper@claude-cache-keeper
```

Start a new session. The band appears above the prompt after the first reply.

Update later with `claude plugin marketplace update claude-cache-keeper` and then `claude plugin update cache-keeper@claude-cache-keeper`.

### Try it without installing

```sh
git clone https://github.com/sorajate/claude-cache-keeper
claude --plugin-dir ./claude-cache-keeper/plugins/cache-keeper
```

## Use

| Command | |
| --- | --- |
| `/cache-keeper` | Current state and settings |
| `/cache-keeper off` / `on` | Pause or resume pinging and compaction |

Settings live under `/config` → cache-keeper, or `/plugin configure cache-keeper@claude-cache-keeper`:

| Option | Default | |
| --- | --- | --- |
| `ttlSeconds` | `0` | `0` detects the TTL from the session. Any other value forces that many seconds. |
| `leadSeconds` | `30` | How long before the cache lapses to ping or compact |
| `maxPings` | `3` | Pings per idle stretch before compacting |
| `compactInstructions` | empty | What the idle compaction's summary should keep |
| `display` | `band` | `band` (above the prompt), `status` (one line), or `both` |

Tip: set `ttlSeconds` to `60` for a few minutes to watch a whole cycle quickly, then set it back to `0`.

## Requirements and caveats

- Claude Code with **function-hook plugins** (built and tested on 2.1.287). That plugin API is early access and may change between releases.
- Each ping is a real API request: it reads the cached context (about 0.1× input price) plus a tiny reply.
- The countdown after a compaction is for information only. The compacted conversation is cached by your next request.
- TTL detection reads the session transcript after each turn (skipped past 64 MB). If the plugin can't read it, the band shows `TTL 5m (assumed)` and the reason.
- Prices are a built-in table of first-party list prices. An unknown model shows multipliers instead of dollars.
- Known gap: a long-running background **Bash** task (not an agent) does not hold the compaction yet.

## Develop

```sh
cd plugins/cache-keeper
claude plugin validate .
claude plugin test .
```

Claude Code writes the API typings to `.claude-plugin/types/` the first time it loads the plugin from disk, and after that `tsc -p .` type-checks it. That folder is git-ignored on purpose: its MCP typings list the tools of whoever loaded the plugin.

[BUILD.md](BUILD.md) is a complete brief for another Claude Code agent to rebuild or extend this plugin.

## License

MIT
