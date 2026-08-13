# dsh-clawrouter

English | [中文](README.zh.md)

**A second brain for your DeepSeek Harness agent.**

DeepSeek is cheap and fast, and you should keep using it for the loop. This plugin adds the things it *cannot* do: have a stronger model review a dangerous command before it runs, and reach 70 models from one wallet — no accounts, no API keys, no credit card.

```sh
dsh plugin --profile web add dsh-clawrouter
```

---

## Why this exists

Two things people keep asking for in the Harness discussions:

> 「是否有类似 Codex 或者 CC 的审查模式？即额外调用模型审查指令，以解放双手？Full Access 还是太让人担心了。」
> *Is there a review mode like Codex or Claude Code — call an extra model to review the command, to free up my hands? Full Access is too worrying.*

> 「使用 Full Access 模式创建并测试插件时误删了我的整个家目录」
> *Testing a plugin in Full Access mode, it deleted my entire home directory.*

`Full Access` is all-or-nothing: approve everything by hand, or approve nothing and hope. This plugin adds a third option — **a different, stronger model looks at the dangerous commands before they run.**

## What it does

### 1. Review gate

When the agent proposes something destructive, a strong model (default `anthropic/claude-opus-5`) reads it and answers:

| Verdict | What happens |
|---|---|
| safe | the call proceeds to the normal permission chain, untouched |
| dangerous | **denied**, with a reason the agent can act on |
| uncertain | **escalated to you** — the normal approval prompt |

It only ever *narrows*. A call the reviewer clears still faces every sandbox, permission, and approval gate you already have. This does not replace your permission system; it sits in front of it.

Enable it in your profile's `cordis.patch.yml`:

```yaml
- update:
    - id: blockrun-review
      config:
        enabled: true
        reviewerModel: anthropic/claude-opus-5
```

**What gets reviewed.** Deliberately narrow — a gate that fires on ordinary work gets switched off, and then it protects nobody. Ordinary reads, edits, and builds are never reviewed. The shipped rules flag recursive deletes, raw disk writes, fork bombs, `curl … | sh`, force-pushes and hard resets, `chmod 777`, `sudo`, and anything touching `~/.ssh`, `~/.aws`, or `/etc/passwd`.

Mentioning a command is not running one — `grep -rn "rm -rf" docs/` is not flagged. Add your own rules with `extraRules`:

```yaml
        extraRules:
          - name: no-prod-deploy
            pattern: "deploy\\s+--env[= ]prod"
```

**When the reviewer is unreachable**, the gate escalates to you (`onReviewerFailure: ask`, the default). It never silently allows — a safety gate that fails open is worse than none — and it never hard-blocks on a network blip. Unattended automation can set `deny` instead.

### 2. `/review`

```
/review <paste a diff, a plan, or the agent's conclusion>
```

Runs the same strong model over material you choose. Useful for the case one user described: the agent read the right evidence, drew the wrong conclusion, and only a direct challenge surfaced the real bug.

### 3. 70 models from one wallet

Registers a `blockrun` provider route. Authentication is a **wallet signature**, not an API key: each request is paid per call in USDC over [x402](https://x402.org). No signup, no KYC, no credit card, no per-lab account.

That matters most for the models DeepSeek does not serve — Claude, GPT, Gemini, Grok, and vision models — which is exactly what a reviewer or a second opinion needs.

## Setup

```sh
dsh plugin --profile web add dsh-clawrouter
export BASE_CHAIN_WALLET_KEY=0x...   # or store it via the credentials service
```

$5 of USDC on Base covers thousands of calls. The key is a **reference** in configuration (`walletKeyEnv`) and is resolved per request, so rotating it takes effect on the very next call and no secret ever enters a config file.

## Configuration

`blockrun-llm` — the provider route:

| Key | Default | Meaning |
|---|---|---|
| `provider` | `blockrun` | harness route key to register |
| `walletKeyEnv` | `BASE_CHAIN_WALLET_KEY` | credential *reference* holding the EVM wallet key |
| `apiUrl` | `https://blockrun.ai/api` | API root; point at another gateway if you have one |
| `timeoutMs` | `300000` | per-request timeout |

`blockrun-review` — the gate:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | whether the automatic gate intercepts tool calls |
| `reviewerProvider` | `blockrun` | provider route carrying the reviewer |
| `reviewerModel` | `anthropic/claude-opus-5` | reviewer model — use a *different, stronger* model than the agent |
| `timeoutMs` | `30000` | how long one review may take |
| `onReviewerFailure` | `ask` | `ask` escalates to you; `deny` blocks (for unattended runs) |
| `extraRules` | `[]` | additional `{name, pattern, tools}` risk rules |

Mounting the route does **not** change your default model. `dsh-base` keeps `deepseek-official`; this route is used only where you ask for it.

## Honest notes

- **This will not make DeepSeek cheaper.** Chat is billed at provider cost plus a flat $0.001/request, and BlockRun does not currently price DeepSeek's cache-hit discount — so routing your main agent loop through it costs *more* than calling DeepSeek directly. Keep your DeepSeek key for the loop. Use this for what DeepSeek cannot do.
- **The free tier is a smoke test, not a workhorse.** The free NVIDIA models may use prompts for service improvement, so do not point them at a private codebase, and never use one as the reviewer.
- **A review costs a model call.** It runs only on flagged calls, with a 30s ceiling.
- **The reviewer sees the flagged tool call**, not your whole repository.

## Known limitations

- **Images are refused, not silently dropped.** Sending image content through this route fails with `UNSUPPORTED`; vision is planned.
- **Reasoning-effort selection is refused** rather than quietly ignored.
- **An aborted request stops delivery immediately, but the in-flight HTTP request is not itself cancelled** until `@blockrun/llm` accepts an `AbortSignal`; the socket closes on the SDK's own timeout.
- **No spend projection.** Harness session logs refuse event types a build does not know, and an out-of-repo plugin cannot mark its events ignorable — so this plugin writes no session events. Settled costs are in `~/.blockrun/cost_log.jsonl`.
- **Smart routing (`blockrun/auto`) is not wired up yet.** Pin a model id for now.

## License

MIT
