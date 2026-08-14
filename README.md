<div align="center">

<img src="https://raw.githubusercontent.com/BlockRunAI/dsh-clawrouter/main/assets/banner.png" alt="dsh-clawrouter — review the dangerous command, before it runs" width="600">

<h1>A second brain for your DeepSeek Harness agent</h1>

<p>DeepSeek is fast and cheap — keep it for the loop.<br><br>
<strong>This adds what it cannot do: a stronger model reviews the dangerous command before it runs.</strong><br><br>
<em><!-- br:models.chatVisible -->70<!-- /br:models.chatVisible --> models from one wallet. No accounts. No API keys. No credit card.</em></p>

<br>

<img src="https://img.shields.io/badge/🛡️_Review_Before_Execute-success?style=for-the-badge" alt="Review before execute">&nbsp;
<img src="https://img.shields.io/badge/🧠_Claude_Reviews_DeepSeek-black?style=for-the-badge" alt="Claude reviews DeepSeek">&nbsp;
<img src="https://img.shields.io/badge/🔑_Zero_API_Keys-blue?style=for-the-badge" alt="No API keys">&nbsp;
<img src="https://img.shields.io/badge/💰_x402_USDC-purple?style=for-the-badge" alt="x402 USDC">

[![npm version](https://img.shields.io/npm/v/dsh-clawrouter.svg?style=flat-square&color=cb3837)](https://npmjs.com/package/dsh-clawrouter)
[![npm downloads](https://img.shields.io/npm/dm/dsh-clawrouter.svg?style=flat-square&color=blue)](https://npmjs.com/package/dsh-clawrouter)
[![GitHub stars](https://img.shields.io/github/stars/BlockRunAI/dsh-clawrouter?style=flat-square&label=GitHub%20stars)](https://github.com/BlockRunAI/dsh-clawrouter)
[![CI](https://img.shields.io/github/actions/workflow/status/BlockRunAI/dsh-clawrouter/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/BlockRunAI/dsh-clawrouter/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek-Harness_Plugin-4D6BFE?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![x402 Protocol](https://img.shields.io/badge/x402-Micropayments-purple?style=flat-square)](https://x402.org)
[![Base](https://img.shields.io/badge/Base-USDC-0052FF?style=flat-square&logo=coinbase&logoColor=white)](https://base.org)
[![Telegram](https://img.shields.io/badge/Telegram-Community-26A5E4?style=flat-square&logo=telegram)](https://t.me/blockrunAI)

English | [中文](https://github.com/BlockRunAI/dsh-clawrouter/blob/main/docs/README.zh.md)

</div>

> **dsh-clawrouter** is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that puts a stronger model in front of your agent's dangerous actions. When the agent proposes `rm -rf ~`, a reviewer model reads it and answers allow / deny / ask — enforced by the real tool executor, not by a prompt. It also registers a BlockRun provider route, so the reviewer (and any of <!-- br:models.chatVisible -->70<!-- /br:models.chatVisible --> models) is reachable from one wallet with no accounts and no API keys, paid per request in USDC over [x402](https://x402.org). MIT licensed.

```sh
dsh plugin --profile web add dsh-clawrouter
```

---

## Why this exists

Two things people keep asking for in the Harness discussions:

> 「是否有类似 Codex 或者 CC 的审查模式？即额外调用模型审查指令，以解放双手？Full Access 还是太让人担心了。」
> — [#421](https://github.com/deepseek-ai/deepseek-harness/discussions/421)
> *Is there a review mode like Codex or Claude Code — call an extra model to review the command, to free up my hands? Full Access is too worrying.*

> 「使用 Full Access 模式创建并测试插件时误删了我的整个家目录」
> — [#461](https://github.com/deepseek-ai/deepseek-harness/discussions/461)
> *Testing a plugin in Full Access mode, it deleted my entire home directory.*

`Full Access` is all-or-nothing: approve every command by hand, or approve nothing and hope. This adds a third option.

## How it compares

|                      | Approve everything | Full Access      | Permission rules   | **dsh-clawrouter**            |
| -------------------- | ------------------ | ---------------- | ------------------ | ----------------------------- |
| **Hands-free**       | No                 | Yes              | Yes                | **Yes**                       |
| **Catches `rm -rf ~`** | Only if you notice | No               | Only if you wrote the rule | **Yes**               |
| **Understands intent** | You do           | Nothing does     | No — literal match | **Yes, a model reads it**     |
| **Enforced where**   | UI prompt          | —                | Executor           | **Executor**                  |
| **Fails**            | —                  | open             | closed             | **to a human, never open**    |
| **Reviews ordinary work** | Everything    | Nothing          | Nothing            | **Nothing**                   |

## What it does

### 1. Review gate

When the agent proposes something destructive, a strong model (default `anthropic/claude-opus-5`) reads it and answers:

| Verdict | What happens |
|---|---|
| safe | proceeds to the normal permission chain, untouched |
| dangerous | **denied**, with a reason the agent can act on |
| uncertain | **escalated to you** — the normal approval prompt |

It only ever *narrows*. A call the reviewer clears still faces every sandbox, permission, and approval gate you already have — and an escalation defers to them too: if a stricter policy would have denied the call, you get that denial rather than an approval prompt. This does not replace your permission system; it sits in front of it.

Enable it in your profile's `cordis.patch.yml`:

```yaml
- id: blockrun-review
  config:
    enabled: true
    reviewerModel: anthropic/claude-opus-5
```

**What gets reviewed.** Deliberately narrow — a gate that fires on ordinary work gets switched off, and then it protects nobody. Reads, edits and builds are never reviewed. The shipped rules flag recursive deletes, raw disk writes, fork bombs, `curl … | sh`, force-pushes and hard resets, `chmod 777`, `sudo`, and anything touching `~/.ssh`, `~/.aws`, or `/etc/passwd` — plus destruction that isn't spelled `rm`: `git clean -fdx`, `find … -delete`, `git checkout -- .`, `terraform destroy`, and `npm publish` (a registry will not let you take a release back).

Mentioning a command is not running one — `grep -rn "rm -rf" docs/` is not flagged — and neither is **writing** one: a Makefile containing `rm -rf build`, a cleanup script, or a README quoting `git reset --hard` are all ordinary work. File-body arguments (`content`, `new_string`, `diff`, …) are treated as data, because what a file eventually does happens when something executes it, and that execution is a separate call this gate still reads. Add your own rules:

```yaml
    extraRules:
      - name: no-prod-deploy
        pattern: "deploy\\s+--env[= ]prod"
```

**When the reviewer is unreachable**, the gate escalates to you (`onReviewerFailure: ask`, the default). It never silently allows — a safety gate that fails open is worse than none — and never hard-blocks on a network blip. Unattended automation can set `deny`.

### 2. `/spend`

```
/spend
```

What this route has cost since the process started — total, per model, tokens and flat fees separately.

**This route is priced per request, not per token.** Measured against a funded wallet: three calls capped at 24 output tokens cost $0.006, three capped at 4096 cost $0.006, and one that generated 8,000 output tokens cost $0.002 — the same per call every time. What settles is the signed 402 quote, and settlement does not depend on what the model then produces.

So `/spend` reports `calls x price` and carries token counts as counts, never converting them into money. Pricing that 8,000-token call from its tokens gave $0.004243, more than double the real charge.

The request price is flat up to about a thousand input tokens, then climbs with **both context and the model**. Measured from the gateway's own 402 quotes (reading a quote costs nothing):

| Model | small | ~22K in | ~112K in |
|---|---|---|---|
| `openai/gpt-4.1-nano` | $0.002 | $0.005 | $0.023 |
| `deepseek/deepseek-chat` | $0.002 | $0.007 | $0.031 |
| `google/gemini-3.5-flash` | $0.002 | $0.066 | $0.325 |
| `anthropic/claude-opus-5` | $0.002 | $0.217 | **$1.081** |

Everything starts at the same $0.002 and then diverges by more than thirty-fold. A coding agent holding a 100K-token context pays roughly fifteen times the floor per call on DeepSeek — and **five hundred times** on Opus. `/spend` says so whenever your average call carries a large context, and points you at your own model's rate rather than one number. It is also blind to a request that failed after paying. Your wallet balance is the authority.

The default `requestFeeUsd` is `0.002` because that is what the gateway quotes: a 402 for a ~17-token request returns `{"amount":"0.002000"}`. BlockRun's published pricing page currently says $0.001.

### 3. `/review`

```
/review <paste a diff, a plan, or the agent's conclusion>
```

Runs the same strong model over material you choose. For the case one user [reported](https://github.com/deepseek-ai/deepseek-harness/discussions/475): the agent read the right evidence, drew the wrong conclusion, and only a direct challenge surfaced the real bug.

### 4. <!-- br:models.chatVisible -->70<!-- /br:models.chatVisible --> models from one wallet

Registers a `blockrun` provider route. Authentication is a **wallet signature**, not an API key: each request is paid per call in USDC over x402. No signup, no KYC, no credit card, no per-lab account.

That matters most for models DeepSeek does not serve — Claude, GPT, Gemini, Grok — which is exactly what a reviewer needs.

## Quick Start

```sh
dsh plugin --profile web add dsh-clawrouter
export BASE_CHAIN_WALLET_KEY=0x...   # or store it via the credentials service
```

**Where does the key come from?** There is no API key to paste — authentication is a wallet signature.

- **Already run a BlockRun tool?** You have a wallet already. The SDK keeps it at `~/.blockrun/.session`, ClawRouter at `~/.openclaw/blockrun/wallet.key`. Export whichever exists: `export BASE_CHAIN_WALLET_KEY=$(cat ~/.blockrun/.session)`
- **No wallet yet?** `npx -y @blockrun/clawrouter` generates one and prints its address. Stop it once you have the address, send it a few USDC on Base, then export the key.

This plugin reads neither file on its own. A credential nobody configured, quietly shadowing the one they did, is exactly what the harness credentials seam exists to prevent — so it only ever reads the reference you name.

$5 of USDC on Base covers thousands of calls. The key is a **reference** in configuration (`walletKeyEnv`), resolved per request — rotating it takes effect on the very next call, and no secret enters a config file.

## Configuration

`blockrun-llm` — the provider route:

| Key | Default | Meaning |
|---|---|---|
| `provider` | `blockrun` | harness route key to register |
| `walletKeyEnv` | `BASE_CHAIN_WALLET_KEY` | credential *reference* holding the EVM wallet key |
| `apiUrl` | `https://blockrun.ai/api` | API root |
| `timeoutMs` | `300000` | per-request timeout |
| `auxiliaryModel` | *(off)* | model for the harness's own maintenance calls — see below |
| `requestFeeUsd` | `0.002` | flat per-request fee, used by `/spend` — the quoted figure, see below |

### Cutting compaction cost

The harness compacts long sessions by summarizing them — and it does that on **whatever model the conversation is using**. On a flagship model that means paying flagship input rates to summarize, repeatedly, for the whole session.

A ~100K-token compaction runs about **$0.50 on Claude Opus 5** and about **$0.014 on DeepSeek V4 Flash**. Summarizing is a job a cheap model does well, and those calls share no prefix with your conversation — so moving them forfeits no prompt-cache hit:

```yaml
- id: blockrun-llm
  config:
    auxiliaryModel: deepseek/deepseek-chat
```

Off by default, and it only ever affects calls the harness itself marks as maintenance (compaction, session titles). **A conversation request is never redirected.**

`blockrun-review` — the gate:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | whether the automatic gate intercepts tool calls |
| `reviewerProvider` | `blockrun` | provider route carrying the reviewer |
| `reviewerModel` | `anthropic/claude-opus-5` | use a *different, stronger* model than the agent |
| `timeoutMs` | `30000` | how long one review may take |
| `onReviewerFailure` | `ask` | `ask` escalates to you; `deny` blocks (unattended runs) |
| `extraRules` | `[]` | additional `{name, pattern, tools}` risk rules |

Mounting the route does **not** change your default model. `dsh-base` keeps `deepseek-official`; this route is used only where you ask for it.

## Honest notes

- **This will not make DeepSeek cheaper.** Chat is billed at provider cost plus a flat $0.001/request, and BlockRun does not currently price DeepSeek's cache-hit discount — so routing your main agent loop through it costs *more* than calling DeepSeek directly. Keep your DeepSeek key for the loop. Use this for what DeepSeek cannot do.
- **The free tier is a smoke test, not a workhorse.** The free NVIDIA models may use prompts for service improvement, so do not point them at a private codebase, and never use one as the reviewer.
- **A review costs a model call.** It runs only on flagged calls, with a 30s ceiling.
- **The reviewer sees the flagged tool call**, not your whole repository.

## Known limitations

- **Images are refused, not silently dropped** — image content through this route fails with `UNSUPPORTED`; vision is planned.
- **Reasoning-effort selection is refused** rather than quietly ignored.
- **An aborted request stops delivery immediately, but the in-flight HTTP request is not itself cancelled** until `@blockrun/llm` accepts an `AbortSignal`; the socket closes on the SDK's own timeout.
- **This plugin does not record what it spends.** Harness session logs refuse event types a build does not know, and an out-of-repo plugin cannot mark its events ignorable, so it writes no session events. It also does not reach `~/.blockrun/cost_log.jsonl`: that ledger is written by `@blockrun/llm`'s `LLMClient`, and the streaming client this adapter uses tracks its spend in memory only. Check the wallet itself for now — an earlier version of this note pointed at the ledger, which would have shown you other tools' spending rather than this one's.
- **Smart routing (`blockrun/auto`) is not wired up**, and not for lack of a router. A virtual model has to report one context window, and the harness sizes compaction from it: report the largest candidate and a turn routed to a smaller model overflows with compaction never firing; report the smallest and every session compacts far too early. Until that has an honest answer, pin a model id — `auxiliaryModel` already moves the expensive maintenance calls, which is where the savings actually were.
- **Compaction may fire earlier than it needs to.** This route reports the context window the gateway's model catalog declares. Measured against the live gateway, `openai/gpt-4.1-nano` accepted a 450,037-token prompt and recalled a marker from the very first line — no truncation, but 3.5x the 128,000 the catalog states. The harness sizes compaction from the declared figure, so a session can compact while the model would still have taken the whole thing. Reported upstream; this plugin reports what the catalog says rather than guessing higher, because over-claiming would trade early compaction for silent overflow.
- **Context overflow is detected by request size, not by the error text.** A real overflow comes back from the gateway as `{"message":"API request failed"}` — the provider's wording is sanitized away, so the usual text detectors match nothing. After a 400, a request larger than the model's declared window is therefore treated as an overflow so compaction can recover. The text detectors still run first, so this corrects itself if the gateway stops sanitizing.
- **Prior-turn reasoning is not sent back.** DeepSeek's thinking-mode guide says `reasoning_content` should be returned on tool-call turns, but this one route serves <!-- br:models.chatVisible -->70<!-- /br:models.chatVisible --> models from many vendors, and a field one of them requires is a field another may reject. Multi-step tool use on a reasoning model may be slightly degraded as a result; please report it if you hit it.

## Development

```sh
npm test          # 181 offline tests, including two real-cordis-Loader compositions
npm run test:e2e  # live gateway tests — spends real USDC (~$0.02); skips without a wallet
```

Developing against a linked checkout (`dsh plugin add /path/to/dsh-clawrouter`) pulls this package's **devDependencies** into the profile, giving a second copy of `@deepseek-ai/dsh-llm`. `instanceof LlmError` then fails across the two copies and the harness reports every failure as `UNKNOWN` instead of its real code. Test error codes from a packed tarball (`npm pack`) rather than a link.

The live suite is the only thing that exercises the x402 handshake, because the signature *is* the authentication and no mock can stand in for it. It is deliberately excluded from `npm test` so it never runs by accident.

## Changelog

See [CHANGELOG.md](https://github.com/BlockRunAI/dsh-clawrouter/blob/main/CHANGELOG.md). Several early releases fixed silent bugs, so upgrading is worth it if you are on an earlier version.

## License

[MIT](LICENSE)
