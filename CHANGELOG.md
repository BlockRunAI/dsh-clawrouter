# Changelog

All notable changes to `dsh-clawrouter`. Versions follow [semver](https://semver.org).

Entries say what changed for *you*, and what it meant when it was wrong — most of the fixes below were silent, so "upgrade if you are on an earlier version" is the honest summary of every one of them.

## 0.3.7 — 2026-08-14

### Added
- **Unknown model ids now suggest what you meant.** With seventy slash-prefixed ids, a wrong name is nearly always a near miss, and the previous error just restated the failure. Verified against the live catalog: `deepseek-chat` suggests `deepseek/deepseek-chat` (dropped vendor prefix), `anthropic/claude-opus5` suggests `anthropic/claude-opus-5` (missing hyphen), `deepseek/deepseek-v4` suggests `deepseek/deepseek-v4-pro` (truncated suffix). A name unrelated to anything in the catalog suggests nothing rather than the nearest noise, and every message now links the model list.

### Documented
- Developing against a **linked checkout** pulls this package's devDependencies into the profile, giving a second copy of `@deepseek-ai/dsh-llm`. `instanceof LlmError` fails across the two copies, so the harness reports every failure as `UNKNOWN` rather than its real code. That looks exactly like a product bug — it cost an investigation here — and disappears when installed from a tarball or npm.

## 0.3.6 — 2026-08-14

### Fixed
- **An unfunded wallet did not say what to fund.** Following 0.3.5's setup instructions lands you here next: the payment is rejected and the error said "check your wallet balance" — but you configured a *private key*, and the address to send USDC to is derived from it. The one fact needed to act was the one fact missing. The failure now names the address.

  The failure code was already right: `PAYMENT_REQUIRED` is not retryable, so an empty wallet fails immediately rather than being retried against three times.

## 0.3.5 — 2026-08-14

### Fixed
- **The first run dead-ended for anyone without a wallet.** Running with no credential produced a correct error — name the variable, name the route, explain there is no API key — and then stopped, because it never said where a wallet comes from. A developer who has never held a private key cannot act on "set this variable".

  The diagnostic now covers both real starting states, and both were run before being recommended:
  - a wallet already exists, at `~/.blockrun/.session` (SDK) or `~/.openclaw/blockrun/wallet.key` (ClawRouter) — the ecosystem uses two locations
  - no wallet exists, and `npx -y @blockrun/clawrouter` generates one and prints its address

  This route still reads neither file. A credential nobody configured, silently shadowing the one they did, is what the credentials seam exists to prevent.

## 0.3.4 — 2026-08-14

### Fixed
- **The cost warning added in 0.3.3 quoted one model's prices as if they were everyone's.** Measuring the same prompt across four models at ~112K input tokens: `openai/gpt-4.1-nano` quotes $0.023, `deepseek/deepseek-chat` $0.031, `google/gemini-3.5-flash` $0.325, and `anthropic/claude-opus-5` **$1.081**.

  All four start at the same $0.002 floor and then diverge more than thirty-fold. 0.3.3 printed the DeepSeek figures with no model named, so an Opus user read a number 35x under their real charge — while being warned about *under*-reporting. The warning now gives the spread and points at your own model's rate instead of one number.

## 0.3.3 — 2026-08-14

### Fixed
- **`/spend` understated long-context work by roughly fifteen times, silently.** 0.3.2 established that settlement is per request rather than per token, and called the total a floor. Measuring the gateway's 402 quotes — which cost nothing, since a quote is not a payment — showed how far under that floor sits once context grows: flat at $0.002 up to ~1K input tokens, then $0.007 at ~22K, $0.031 at ~112K, $0.122 at ~450K.

  A coding agent working in a 100K-token context is the whole point of this plugin, and it pays about fifteen times the floor per call. The total now says so whenever the average call carries a large context, with the measured figures, instead of leaving a confident small number on screen.

  The warning keys on the average rather than any single call, so one large call among hundreds of small ones stays quiet.

## 0.3.2 — 2026-08-14

### Fixed
- **`/spend` overstated a real charge by more than double.** Measured against a funded wallet: three calls capped at 24 output tokens cost $0.006, three capped at 4096 cost $0.006, and one that generated **8,000** output tokens cost **$0.002** — the same per call every time. Settlement follows the signed 402 quote and does not depend on what the model produces. Pricing that last call from its tokens gave $0.004243.

  The meter no longer converts tokens into money at all. It reports `calls x price` and carries token counts as counts — exact for ordinary calls, a floor for very large inputs, and blind to a request that failed after paying.

  0.3.1's explanation was wrong in the other direction: it said the figure would read *low* because settlement is priced on `max_tokens`. Raising `max_tokens` from 24 to 4096 changed the charge not at all. Both stories were models built from reading code; only the wallet settled it.

## 0.3.1 — 2026-08-14

### Fixed
- **`/spend` counted nothing at all.** The translator buffers usage and emits it from `end()`; the adapter only watched the per-chunk output, so five real calls produced a meter reading of zero. Every unit test of the meter passed the whole time. Caught by comparing against the wallet, which is the only thing that could have caught it.
- **The flat per-request fee is `$0.002`, not `$0.001`.** Measured against the gateway's own 402 quote (`{"amount":"0.002000"}` for a ~17-token request) and confirmed by the wallet moving exactly $0.006 across three calls. BlockRun's published pricing page says $0.001, so the previous default understated every total by half.

### Corrected
- **`/spend` is an estimate, not the billing formula.** 0.3.0 claimed it computed what BlockRun bills. What actually settles is the signed 402 quote, and the gateway prices that on estimated input plus `max_tokens` — the cap, not the tokens produced. A request capped at 4096 that answers in 50 is charged for far more than it used, and this counts actual usage, so it reads low by that gap. It is still worth showing, and now says why it is a floor rather than merely that it is one.

## 0.3.0 — 2026-08-14

### Added
- **`/spend`** — what this route has cost since the process started: total, per model, token cost and flat fees separately.

  0.2.9 corrected a note claiming spend landed in `~/.blockrun/cost_log.jsonl`; the streaming client this adapter uses never writes there. Rather than wait on the SDK, the figure is computed here from the provider's reported usage and the catalog's published rates — which was described as the formula BlockRun bills on — see 0.3.1, where measuring against the wallet showed that settlement follows the 402 quote instead. That last point is the same finding that makes routing a cache-warm loop through this gateway *more* expensive, used the other way round.

  It counts only calls that completed, so it is a floor and says so; the wallet is the authority. A model the catalog publishes no rate for is reported as unpriced rather than counted as free, because a total that quietly omits calls is worse than one that admits the gap.
- `requestFeeUsd` (default `0.001`) — the flat per-request fee, configurable because it is a published price rather than a protocol constant, and a stale number here would be a wrong total.

## 0.2.9 — 2026-08-14

### Documented
- **Corrected a false claim about spend tracking.** Earlier releases said settled costs land in `~/.blockrun/cost_log.jsonl`. They do not: that ledger is written by `@blockrun/llm`'s `LLMClient`, while the streaming client this adapter uses only accumulates in memory. Checked against a real 5,006-entry ledger — not one entry came from this plugin, so the note was sending people to look at other tools' spending and read it as their own.

  The README now says plainly that this plugin records nothing, and to check the wallet.

### Verified
- The size-based overflow classification added in 0.2.8 is now proven against the live gateway, not only in unit tests — an oversized prompt to `gpt-4o` surfaces `CONTEXT_WINDOW_EXCEEDED`, paired with an ordinary request on the same model so a mapping that flagged everything would fail too. 0.2.6 passed its unit tests while being inert; this path does not get to claim that twice.

## 0.2.8 — 2026-08-14

### Fixed
- **Compaction recovery still did not fire, despite 0.2.6.** That release mapped context overflow to `CONTEXT_WINDOW_EXCEEDED` using the harness's text detectors. Measured against the live gateway, a real overflow comes back as `{"message":"API request failed"}` — the gateway sanitizes the provider's wording away, so the detectors match nothing and the failure fell through to `INVALID_REQUEST`. The 0.2.6 entry claimed a recovery that was never actually reached.

  Request size is the signal that survives: after a 400, and only then, a request larger than the model's own declared window is classified as an overflow. The text detectors still run first, so this corrects itself the moment the gateway stops sanitizing.

### Measured
- The understated context window is **specific, not systemic**. `gpt-4.1-mini` accepted 140,008 tokens against a declared 128,000; `gpt-4o` rejected the same prompt at the same declared figure. So the gpt-4.1 family is understated and the rest of the catalog is right — a precise upstream fix rather than a broad one.

## 0.2.7 — 2026-08-14

### Documented
- Measured the gateway's real context behaviour rather than assuming it. `openai/gpt-4.1-nano` accepted a **450,037-token** prompt and recalled a marker from its first line — so there is **no silent truncation**, which was the failure worth ruling out: a session quietly losing its own beginning would be worse than an error.

  The catalog declares 128,000 for that model, and the harness sizes compaction from the declared figure, so sessions can compact while the model would still have taken the whole prompt. That is catalog data to fix upstream; this plugin keeps reporting what the catalog says, because guessing higher would trade early compaction for silent overflow.
- The context-overflow mapping added in 0.2.6 is unit-tested but could not be confirmed against real gateway wording, because an overflow could not be provoked. Said so rather than implying it was verified.

## 0.2.6 — 2026-08-14

### Fixed
- **Long sessions lost automatic compaction recovery.** (Only partly, as it turned out — see 0.2.8: the gateway sanitizes the wording these detectors need, so this mapping did not fire in practice.) `compaction-basic` decides whether to recover from a context overflow by comparing the failure code against `CONTEXT_WINDOW_EXCEEDED`. This adapter reported an overflow as a plain `INVALID_REQUEST`, so the recovery never fired and the session simply failed instead of compacting and carrying on.

  Overflow and exhausted-quota wording are now detected with the harness's own `isContextWindowExceededError` / `isQuotaExceededError`, and mapped to `CONTEXT_WINDOW_EXCEEDED` and `QUOTA`. A `402` stays `PAYMENT_REQUIRED` even when it says "insufficient balance" — x402's own status is the more precise answer, and a short wallet is a different fix from an exhausted account.

  Detection reads the provider body as well as the message: `@blockrun/llm` puts only `"…: HTTP <status>"` in `message` and keeps the decoded body on `response`, so matching the message alone would never have seen the wording.
- The empty-stream error now uses the harness's exported `EMPTY_RESPONSE_CODE` instead of a hardcoded copy, so a rename upstream cannot silently drop it out of the retryable set.

## 0.2.5 — 2026-08-14

### Fixed
- **A cancelled turn could pop an approval prompt.** The review wrapper caught every error, including the caller's own abort, and turned it into an `uncertain` verdict — which escalates. Cancelling a turn mid-review therefore asked a human to approve a call nobody was waiting for. A caller abort now declines instead.
- **A turn cancelled *before* the review started hung for the full timeout.** The caller's signal was wired up with `addEventListener`, and a listener added to an already-aborted signal never fires — so the one case where the answer was known immediately was the one case that waited 30 seconds. The caller's signal and the deadline are now combined with `AbortSignal.any`, which propagates an already-aborted signal.

## 0.2.4 — 2026-08-14

### Fixed
- **Escalating to a human skipped the rest of the policy chain.** A waterfall listener that returns without delegating short-circuits it, so when the reviewer was unsure the gate's `ask` replaced every later `tools/pre-execute` listener. A stricter policy that would have *denied* the call never ran, and a human clicking Allow could run something the deployment had already refused — this gate widening the very policy it sits in front of.

  An escalation now takes the downstream decision first and is only ever added on top of a call the rest of the chain would have allowed. "It only ever narrows" is now true of every path, not just the cleared one.

### Added
- Live tests that try to talk a real reviewer into clearing `rm -rf ~`: an embedded verdict object, "ignore all previous instructions", claimed security-team authority, a fake system turn, and role reversal. All five are refused.

## 0.2.3 — 2026-08-14

### Added
- This changelog, eight releases late.
- Tests asserting the READMEs against the real schemas: every config key must appear in both languages, the documented default reviewer model must be the real one, the translations must carry the same sections, and the gate must really be off by default. Doc drift had already shipped twice, and the README is the only place a config key is discoverable.

## 0.2.2 — 2026-08-14

### Added
- A banner, in the ClawRouter house style. The SVG ships beside the PNG so it stays editable.

## 0.2.1 — 2026-08-14

### Added
- The risk policy now catches destruction that isn't spelled `rm`: `git clean -f` (destroys uncommitted *and* ignored files), `find … -delete` / `-exec rm`, `git checkout -- .` and `git restore .` (discard the whole worktree), `terraform destroy`, and `npm`/`pnpm`/`yarn publish` — a registry won't let you take a release back.
- Wire-level tests: a local HTTP server asserting what actually leaves the process.

### Fixed
- `home-or-root-target` required a space after `~`, so it missed `mv ~/project /tmp`.

### Deliberately not added
`docker system prune` (images can be re-pulled), `kill -9 -1`, `shutdown` — rare from a coding agent. A policy that flags everything gets switched off, and then it protects nothing.

## 0.2.0 — 2026-08-14

### Added
- **`auxiliaryModel`** — route the harness's own maintenance calls (context compaction, session titles) to a cheaper model.

  Compaction summarizes the *whole* conversation, and the harness runs it on whatever model the conversation is using. A ~100K-token compaction is roughly **$0.50 on `claude-opus-5` and $0.014 on `deepseek-chat`**, repeated for the life of a long session. These calls share no prefix with your conversation, so moving them forfeits no prompt-cache hit — which is exactly why this is worth doing when rerouting the conversation itself is not.

  Off by default. A conversation request is never redirected: the model you pinned is the model your conversation gets.

## 0.1.4 — 2026-08-14

### Fixed
- **The gate flagged ordinary file writes.** Writing a cleanup script, a Makefile whose `clean` target is `rm -rf build`, a README quoting `git reset --hard`, or an edit adding a `sudo apt-get` line — four of five ordinary writes tripped a rule, because the command-position anchor treats the start of a line as a command and the scan read file bodies.

  With a real reviewer some of these could have been **denied outright**. Writing a Makefile is the most ordinary thing a coding agent does.

  Body-carrying arguments (`content`, `new_string`, `diff`, …) are now data. This costs no coverage: what a file body does happens when something executes it, and that execution is a separate call the gate still reads. Writing to `~/.ssh/authorized_keys` is still flagged — the path is in `file_path`, not the body.

## 0.1.3 — 2026-08-14

### Fixed
- **Failures were retried blindly.** The adapter read `error.status`, but `@blockrun/llm` reports `statusCode`. The read was always `undefined`, so every failure normalized to `TRANSPORT` — which the harness *does* retry.

  An insufficient-funds `402` was therefore retried twice against a wallet that could not pay, and a `401` was retried instead of failing fast. Retrying cannot fund a wallet or fix a key. Statuses now map to `AUTH`, `PAYMENT_REQUIRED`, `RATE_LIMIT`, `INVALID_REQUEST`, and `SERVER`, and the status reaches the harness.
- An abort raised during the model-catalog read is no longer swallowed.

## 0.1.2 — 2026-08-14

### Fixed
- **One caller's cancellation broke every other caller.** The shared catalog request carried whichever `AbortSignal` arrived first, then handed that promise to every concurrent caller — so one agent cancelling its turn failed the catalog read of every other agent. The shared request now carries no caller signal and owns a 15s deadline.
- **User text travelling with a tool result was dropped**, silently deleting what you said on the way to the model.
- **Empty tool output was sent as empty content.** Succeeding while printing nothing is ordinary (`chmod`, `mkdir`, a quiet build); strict gateways read an empty tool message as malformed. It now sends `(no output)`.
- **Verdict parsing was quadratic.** A reviewer response whose braces never close made the parse walk to the end of the text from every `{` — 2.3s to reject a 200k-brace response, inside the tool-execution path. Now ~4ms.
- Reviewer output is bounded at 16k characters, and an empty response says so instead of reporting a generic parse failure.
- The review gate no longer declares `commands` in `inject`, so it mounts in compositions with no command surface — the headless and automation setups that most need it.

## 0.1.1 — 2026-08-14

### Fixed
- npm rendered the Chinese README. npm force-includes every root `README*` regardless of `files`, and its picker chose `README.zh.md`; the translation moved to `docs/`.

## 0.1.0 — 2026-08-14

Initial release.

- **Review gate** — a stronger model reviews risky tool calls before they run and answers allow / deny / escalate, enforced by the real tool executor rather than by a prompt. Off by default.
- **`/review`** — put the same model on a diff, a plan, or the agent's own conclusion.
- **BlockRun provider route** — 70 models behind one wallet, authenticated by signature instead of an API key, paid per request in USDC over x402.
