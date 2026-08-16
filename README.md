<div align="center">

<img src="https://raw.githubusercontent.com/BlockRunAI/dsh-clawrouter/main/assets/banner.png" alt="dsh-clawrouter — review the dangerous command, before it runs" width="600">

<h1>A second brain for your DeepSeek Harness agent</h1>

<p>DeepSeek is fast and cheap — keep it for the loop.<br><br>
<strong>This adds what it cannot do: a stronger model reviews the dangerous command before it runs.</strong><br><br>
<em><!-- br:models.chatVisible -->67<!-- /br:models.chatVisible --> models from one wallet. No accounts. No API keys. No credit card.</em></p>

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

> **dsh-clawrouter** is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that puts a stronger model in front of your agent's dangerous actions. When the agent proposes `rm -rf ~`, a reviewer model reads it and answers allow / deny / ask — enforced by the real tool executor, not by a prompt. It also registers a BlockRun provider route, so the reviewer (and any of <!-- br:models.chatVisible -->67<!-- /br:models.chatVisible --> models) is reachable from one wallet with no accounts and no API keys, paid per request in USDC over [x402](https://x402.org). MIT licensed.

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

**If you mistype `reviewerModel`**, every flagged command escalates or is denied — which looks exactly like the gate working cautiously. The failure now carries the cause, so a denial reads *"BlockRun does not serve model … Did you mean …?"* rather than a bare timeout, and a warning is logged wherever a log exporter is composed.

**When the reviewer is unreachable**, the gate escalates to you (`onReviewerFailure: ask`, the default). It never silently allows — a safety gate that fails open is worse than none — and never hard-blocks on a network blip. Unattended automation can set `deny`.

### What it costs to leave on

Measured, because this is the question that decides whether you keep it enabled:

| | |
|---|---|
| Fires on ordinary work | **never** — 0 of 59, including commands that merely *mention* a destructive one (`grep -rn "rm -rf" docs/`, `echo "DROP TABLE" >> notes.md`) |
| Misses dangerous work | **none** of 39, across git, containers, clusters, cloud storage, databases, and host state |
| Catches files that execute later | git hooks, CI workflows, shell startup files, launch agents, `.gitconfig`, `.env`, npm `postinstall`, sandbox escalation — 10 of 10, 0 false positives across 15 ordinary file edits |
| Survives evasion | `\rm -rf /`, `command rm`, `env rm`, `eval "rm -rf $DIR"`, `bash -c "…"`, `\| xargs rm`, and heredocs piped into a shell |
| Cost when it does fire | **$0.0057** on `claude-opus-5`, at the 512-token reviewer cap — $0.0249 without it |
| Latency when it does fire | ~3s |
| What the reviewer sees | ~356 tokens — the flagged call, not your conversation |

**That figure depends on the cap.** This gateway quotes from the request — input size plus the `max_tokens` asked for — and settles that amount whichever way the model answers, so a review that asks for room it never uses pays for it every time the gate fires. `reviewerMaxTokens` (512) is what keeps a two-field JSON verdict priced like one. Before 0.10.0 the reviewer inherited `claude-opus-5`'s advertised 128,000-token output and cost **$0.28–0.33** per review; if you are on an earlier version, upgrade rather than switching to a weaker reviewer.

So during normal work it is invisible: no latency, no cost, no prompts. It bills roughly half a cent on the rare command that deserves a second opinion. Both corpora are tests, so a rule that starts flagging `npm test` — or stops flagging `kubectl delete namespace` — fails CI rather than your session.

Not every dangerous action is a shell command. Writing `.git/hooks/pre-commit`, `.github/workflows/ci.yml`, or an npm `postinstall` runs code later — on the next commit, the next CI run with your secrets, the next `npm install` on someone else's machine. These are quieter than `rm -rf`, and worse for it: a user watching for destruction sees nothing happen at all. Measured before those rules existed, 2 of 10 were flagged.

**Recall is the ceiling on everything above:** a command the matcher never flags is a command the reviewer never sees. An earlier version of this table claimed nothing was missed, measured against the six commands the rules had been written for. Against the 39 above, those same rules caught **one**. The corpus exists so that number can never again be taken on faith.

### 2. `/spend`

```
/spend
```

What this route has cost since the process started — total, per model, tokens and flat fees separately.

**You pay for what you request, not what you get.** The gateway quotes from the request — input size plus the `max_tokens` you ask for — and settles that quoted amount whichever way the model answers. Measured against production:

| `max_tokens` requested | `claude-opus-5` | `deepseek-chat` |
|---|---|---|
| 16 | $0.0020 | $0.0020 |
| 1,000 | $0.0036 | $0.0020 |
| 8,000 | $0.0211 | $0.0020 |
| 60,000 | $0.1511 | $0.0027 |

Two things follow, and the second one costs real money.

**There is a floor of $0.002** — a $0.001 minimum payment plus a flat $0.001 transaction fee. Below it everything quotes the same, which is why `deepseek-chat` barely moves in that table: it is cheap enough that even 8,000 output tokens stays under the floor. An earlier version of this section concluded from exactly that observation that billing was per request rather than per token. It was measured only on `deepseek-chat`, the cheapest model on the route, where the floor hides the rate entirely.

**A large `max_tokens` is billed even when the reply is short.** This is why `defaultMaxTokens` is capped at `maxOutputCeiling` (8,192) rather than taken from a model's advertised `max_output`. Left uncapped, `claude-opus-5` advertises 128,000, and a request carrying that default quotes **$0.3211** — against $0.0216 with no cap at all and $0.0036 capped at 1,000. Eighty-nine times the cost, decided by a field the caller never set. Raise `maxOutputCeiling` when a workload genuinely needs long replies; you are then paying for them deliberately.

**Input size drives the other half of the quote.** The same request at growing prompt sizes, `max_tokens` held small:

| Model | small | ~22K in | ~112K in |
|---|---|---|---|
| `openai/gpt-4.1-nano` | $0.002 | $0.005 | $0.023 |
| `deepseek/deepseek-chat` | $0.002 | $0.007 | $0.031 |
| `google/gemini-3.5-flash` | $0.002 | $0.066 | $0.325 |
| `anthropic/claude-opus-5` | $0.002 | $0.217 | **$1.081** |

Everything starts at the same floor and then diverges by more than thirty-fold. A coding agent holding a 100K-token context pays roughly fifteen times the floor per call on DeepSeek — and five hundred times on Opus. `/spend` says so whenever your average call carries a large context, and points you at your own model's rate rather than one number. It is also blind to a request that failed after paying. Your wallet balance is the authority.

Reading a 402 quote is free, so every figure above is reproducible without spending anything.

The default `requestFeeUsd` is `0.002` because that is what the gateway quotes: a 402 for a ~17-token request returns `{"amount":"0.002000"}`. BlockRun's published pricing page currently says $0.001.

### 3. `/review`

```
/review <paste a diff, a plan, or the agent's conclusion>
```

Runs the same strong model over material you choose. For the case one user [reported](https://github.com/deepseek-ai/deepseek-harness/discussions/475): the agent read the right evidence, drew the wrong conclusion, and only a direct challenge surfaced the real bug.

### 4. `/gate` — check the net is actually up

```
/gate         # is the gate armed, and with what?
/gate drill   # put a dangerous command through the live reviewer
```

A safety feature that is quietly off is worse than one never installed, because you stopped watching. This gate can be off while everything a user can see looks right: `enabled` defaults to `false`, a patch layer **replaces** a row's whole `config` rather than merging keys, and `/review` registers either way — so a working `/review` tells you the plugin loaded and **nothing** about whether tool calls are being inspected.

`/gate` is therefore registered whether or not the gate is armed, and says which. `/gate drill` sends `rm -rf / --no-preserve-root` through the risk matcher and the real reviewer — never to a tool — and reports each stage separately, because they fail for unrelated reasons: a rule that stopped matching is a policy problem, an unreachable reviewer is a wallet or model problem. At runtime those both collapse into "escalate", which is indistinguishable from the gate working. The drill is what tells them apart. It costs one reviewer call.

### 5. Vision — give your agent eyes it does not have

DeepSeek serves no vision model, so this is capability rather than savings. Attach an image and a vision model reads it:

```yaml
- id: blockrun-llm
  config:
    visionModels: [google/gemini-3.5-flash]   # the default; widen as you verify
```

**The gateway's `vision` tag is not sufficient, so this plugin does not trust it.** Thirty-five entries carry it. Ten were sent the same inline PNG and asked its colour:

| Model | Result |
|---|---|
| `google/gemini-2.5-flash`, `gemini-3.5-flash`, `gemini-3.6-flash` | answered correctly |
| `moonshot/kimi-k3` | answered correctly |
| `openai/gpt-4o`, `gpt-4.1`, `gpt-5.6-sol` | **HTTP 400 after taking payment** |
| `xai/grok-4.5` | HTTP 503 after taking payment |
| `anthropic/claude-sonnet-5`, `claude-opus-5` | **HTTP 200, upstream 400 relayed as the model's answer** |

Anthropic's is the worst of these. The call returns 200 and streams `[Error: 400 {"message":"Could not process image"}]` as assistant text, so the harness sees an ordinary successful turn and the agent acts on the error string as though the model wrote it. This plugin now detects that exact shape — the whole message being nothing but a relayed error — and finishes the request as a failure with the status mapped as if it had arrived as one. An answer that merely mentions an error, or a turn that also called a tool, is left alone. So a model is offered image input only when the gateway tags it `vision` **and** it appears in `visionModels`, which defaults to the four measured to work. Both signals must agree — the tag alone over-claims, and the list alone would keep claiming vision for a model the gateway has since retagged.

Widen it yourself as you verify others; that is a config change, not a release here.

### 6. Reasoning effort

Reasoning models get `high` and `max`, declared per model from the catalog's `reasoning` tag.

`max` is DeepSeek's vocabulary, which the harness adopts. OpenAI's is `low | medium | high`, and it returns **HTTP 400 after taking payment** for anything else — so `max` is translated to each vendor's nearest value rather than refused. Asking for the most thinking available should not fail over a spelling.

Asking a model that does not reason at all is a different case, and is refused **locally, before paying**: `openai/gpt-4o` charges and then rejects `reasoning_effort` outright. The catalog says which models qualify, so that costs nothing to discover.

### 7. <!-- br:models.chatVisible -->67<!-- /br:models.chatVisible --> models from one wallet

Registers a `blockrun` provider route. Authentication is a **wallet signature**, not an API key: each request is paid per call in USDC over x402. No signup, no KYC, no credit card, no per-lab account.

That matters most for models DeepSeek does not serve — Claude, GPT, Gemini, Grok — which is exactly what a reviewer needs.

## Quick Start

```sh
dsh plugin --profile web add dsh-clawrouter
export BASE_CHAIN_WALLET_KEY=0x...   # or store it via the credentials service
```

**The install prints `✕ missing peer` for six harness packages. That is expected.** The harness itself supplies them at runtime, and every first-party bundle declares its peers the same way — the alternative, depending on them directly, gives the profile a second copy of cordis and breaks the plugin in ways that are much harder to read. Verified on a clean install: the profile composes and `dsh --profile web --dump-config` lists both rows. Nothing is missing.

**Where does the key come from?** There is no API key to paste — authentication is a wallet signature.

- **Already run a BlockRun tool?** You have a wallet already. The SDK keeps it at `~/.blockrun/.session`, ClawRouter at `~/.openclaw/blockrun/wallet.key`. Export whichever exists: `export BASE_CHAIN_WALLET_KEY=$(cat ~/.blockrun/.session)`
- **No wallet yet?** `npx -y @blockrun/clawrouter` generates one and prints its address. Stop it once you have the address, send it a few USDC on Base, then export the key.

This plugin reads neither file on its own. A credential nobody configured, quietly shadowing the one they did, is exactly what the harness credentials seam exists to prevent — so it only ever reads the reference you name.

$5 of USDC on Base covers about **2,500** gate reviews, which run at the $0.002 floor — and about **5** calls carrying a 100K-token context on Opus. Both figures are the same $5; fund for the way you intend to use the route rather than for its floor. The key is a **reference** in configuration (`walletKeyEnv`), resolved per request — rotating it takes effect on the very next call, and no secret enters a config file.

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

A ~100K-token compaction runs about **$0.90 on Claude Opus 5** and about **$0.026 on DeepSeek V4 Flash** — read from live 402 quotes at that size, consistent with the table above. Summarizing is a job a cheap model does well, and those calls share no prefix with your conversation — so moving them forfeits no prompt-cache hit:

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
| `reviewerMaxTokens` | `512` | output cap asked for per review, and billed whether or not it is used |
| `onReviewerFailure` | `ask` | `ask` escalates to you; `deny` blocks (unattended runs) |
| `extraRules` | `[]` | additional `{name, pattern, tools}` risk rules |

Mounting the route does **not** change your default model. `dsh-base` keeps `deepseek-official`; this route is used only where you ask for it.

## Honest notes

- **This will not make DeepSeek cheaper.** Each request is priced from its own 402 quote — $0.002 at small sizes, climbing with input — and BlockRun does not price DeepSeek's cache-hit discount. A cache-warm agent turn costs DeepSeek about $0.000056 directly against roughly $0.007 here at 22K input tokens. Keep your DeepSeek key for the loop; use this for what DeepSeek cannot do.
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
- **Prior-turn reasoning is not sent back.** DeepSeek's thinking-mode guide says `reasoning_content` should be returned on tool-call turns, but this one route serves <!-- br:models.chatVisible -->67<!-- /br:models.chatVisible --> models from many vendors, and a field one of them requires is a field another may reject. Multi-step tool use on a reasoning model may be slightly degraded as a result; please report it if you hit it.

## Development

```sh
npm test          # 185 offline tests, including two real-cordis-Loader compositions
npm run test:e2e  # live gateway tests — spends real USDC (~$0.02); skips without a wallet
npm run sync:models  # refresh the model count in both READMEs from the live catalog
npm run test:docker  # install the PUBLISHED package in a clean container and assert it composes
```

Developing against a linked checkout (`dsh plugin add /path/to/dsh-clawrouter`) pulls this package's **devDependencies** into the profile, giving a second copy of `@deepseek-ai/dsh-llm`. `instanceof LlmError` then fails across the two copies and the harness reports every failure as `UNKNOWN` instead of its real code. Test error codes from a packed tarball (`npm pack`) rather than a link.

The live suite is the only thing that exercises the x402 handshake, because the signature *is* the authentication and no mock can stand in for it. It is deliberately excluded from `npm test` so it never runs by accident.

## Changelog

See [CHANGELOG.md](https://github.com/BlockRunAI/dsh-clawrouter/blob/main/CHANGELOG.md). Several early releases fixed silent bugs, so upgrading is worth it if you are on an earlier version.

## License

[MIT](LICENSE)
