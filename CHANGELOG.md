# Changelog

All notable changes to `dsh-clawrouter`. Versions follow [semver](https://semver.org).

Entries say what changed for *you*, and what it meant when it was wrong — most of the fixes below were silent, so "upgrade if you are on an earlier version" is the honest summary of every one of them.

## 0.10.6 — 2026-08-31

### Added
- **The vision probe now has tests, and enabling them found a third bug in it.** `probe:vision` decides what goes into `VERIFIED_VISION_MODELS`, and that list decides whether the harness will let an image be sent at all — so it is a measuring instrument whose output is pasted into source, and it had already been wrong twice in an afternoon. Both times the bug looked exactly like the failure it was written to detect, which is why reading its output could not catch either. Its judgement is now separated from its requests and tested offline: that the PNG it sends really is the colour it claims (a malformed encoder would fail every model and read as a gateway-wide outage), that the three colour patterns reject each other so a blind guess cannot pass, that a correct answer from a substituted model is not a pass, that a short run cannot promote a model, and that the cost estimate follows catalog prices rather than the floor.
- **`scripts/**` is now actually typechecked.** It was already in `tsconfig.test.json`'s `include`, but without `allowJs` TypeScript silently ignores `.mjs` — so the entry had been decorative. `checkJs` immediately caught the third probe bug (`paid > 0` against an array, left behind when the cost estimate started needing the array rather than its length, which disabled the "no wallet key" warning without removing it) and a bare string passed where a branded `AttachmentId` was required — the same mistake this project shipped once before and wrote a CHANGELOG entry about.

### Changed
- **`nvidia/llama-3.2-11b-vision` was written up as a model that cannot see; it is a gateway that never sends the image.** The gateway strips every `image_url` part on both its NVIDIA paths before dispatch — unconditionally, for every NVIDIA model, under a comment asserting that NVIDIA models have no vision. Probed directly against NVIDIA, that model and `nemotron-3-nano-omni` both name the colour correctly, so the comment is false and the entry's fluent "you didn't provide an image" is simply accurate. It stays out of `visionModels`, because this list is what works *through* this gateway and nothing here has changed for a caller — but the fault was mis-attributed to the vendor, and the streaming path drops the image with no log line at all, which is why it took a source read to see. Found with BlockRunAI/blockrun's own maintainers; fix is theirs.
- **Opened BlockRunAI/blockrun#456** to fix the drop itself, since the report alone would have left it standing: one shared module for both NVIDIA legs, image parts forwarded when the catalog tags the model `vision`, still dropped for a text-only one, and now logged on both legs rather than silently on the streaming one. When it deploys, `npm run probe:vision -- --models=nvidia/llama-3.2-11b-vision,nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` re-measures both for free and they should join the default.
- **Filed BlockRunAI/blockrun#453** for the relayed-error-as-assistant-text shape noted under 0.10.5: a `200` whose `choices[0].message.content` is a stringified upstream error, structurally identical to a real answer. `src/translate.ts` already refuses it here; the issue asks for it at the gateway, since a client that has not implemented the check has no way to know.

## 0.10.5 — 2026-08-31

### Fixed
- **Three models that can read images were refused, and one that cannot was nearly admitted.** `VERIFIED_VISION_MODELS` goes from 31 to 34, measured 2026-08-31 across 40 tagged models: `deepseek/deepseek-v4-flash-vision-exp`, `xiaomi/mimo-v2.5` and `openai/gpt-5.6-luna-pro` all answer correctly and are now offered image input. The first two are new to the catalog. `gpt-5.6-luna-pro` is a different story than it looked: it was never an image failure, it was **unroutable** — the catalog priced it below what OpenAI charges, the gateway derives its upstream cost ceiling from that price, so every call matched no endpoint and failed outright, with no fallback declared to absorb it. Repricing fixed the model; the image had always worked. The image fix for the three `pro` entries is a separate, still-open change, which is why those still refuse. The three `gpt-*-pro` entries still cannot take an image, but they now fail `INVALID_REQUEST` instead of silently dropping it and billing for the answer — also an upstream fix.

  Two stay out for a reason worth stating plainly, because it is not that they failed: **they were never reached.** `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` is answered by `nemotron-3-nano-30b`, which has no vision, on about half of all runs — it passes on the other half, which is exactly the trap. `qwen/qwen3.8-flash` is answered by `qwen/qwen3.7-flash`, a cheaper model that the catalog does not tag `vision` at all, so the substitution is not a free-tier quirk: it happens to paid models, between models of different price and different capability. Both reported as BlockRunAI/blockrun#450. Admitting either would buy an image path that works when the gateway's cascade feels like it, and produces a confident wrong answer about an unseen image when it does not.

### Added
- **`npm run probe:vision`** — measures which `vision`-tagged models actually accept an image and prints the `VERIFIED_VISION_MODELS` array to paste back. The list had been measured by hand three times in a fortnight, each time because the roster moved underneath it, and the fourth refresh was going to be another set of ad-hoc curl commands. It also makes the measurement stricter than the hand runs were: three different colours per model instead of one, all of which must be right, because a single solid colour is guessable and a model that answers a plausible colour without receiving the image could have passed the old check. Free models cost nothing to probe; paid ones are ~$0.002 per call, and the estimate is printed before anything is sent.

  Its first real run found two faults in itself, which is the argument for the script rather than against it — both were failure modes the hand runs shared and nobody could see. It asked for 24 output tokens, enough for a one-word answer but not enough for a *reasoning* model to think first, so `deepseek/deepseek-v4-flash-vision-exp`, `qwen/qwen3.8-flash` and `xiaomi/mimo-v2.5` returned three empty answers each and read as vision failures. And it did not check which model answered: `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` passed 3 of 3 on a run where the gateway happened to reach it, having been substituted 6 of 6 an hour earlier. A probe whose failure mode is indistinguishable from the failure it looks for is worse than no probe.

  Both are fixed. The cap is 256, the cost estimate is computed from catalog output prices rather than the $0.002 floor (a `$180/M` model is ~$0.046 a call at that cap, not $0.002), a right answer from a substituted model is not a pass, and `--models=a,b` re-runs a named few so a verdict that turned on timing can be re-checked without paying for the whole sweep.

  The three vision-tagged models added on 2026-08-31 remain unmeasured and therefore still excluded — see the known gap under 0.10.4. Run the probe against a funded wallet to close it.

## 0.10.4 — 2026-08-31

### Fixed
- **The model count said 70; the gateway now serves 73.** `deepseek/deepseek-v4-flash-vision-exp`, `qwen/qwen3.8-flash` and `xiaomi/mimo-v2.5` were added within hours of 0.10.3 — the deployment caught up with the roster BlockRunAI/blockrun#448 had already landed. Regenerated with `npm run sync:models`; the free count is unchanged at 7.

### Added
- **`/spend` now says when a different model answered.** The gateway substitutes silently behind the free tier, and it is not the corner case it looked like: every request for `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` was answered by something else, one request in three for `nvidia/nemotron-3-ultra-550b` — the largest free model listed, 550B at 1M context — came back from a 30B at 131K, and one substitute (`nvidia/nemotron-3-super-120b`) does not appear in the public catalog at all, so it could not have been selected or checked. Each chunk names the model that served it, so this route now reads that field and prints the substitute under the row for the id you asked for. The call still counts against the model you requested: this meter prices every call at the same flat figure, so which row it lands on cannot move the total, and the requested id is the one you would recognize. It is a report, not a guard — the reply is real and it is delivered. Reported upstream as BlockRunAI/blockrun#450, with the roster change added to #443.

  Only the streaming endpoint makes this possible, which is the endpoint this route uses: there the `model` field is the canonical BlockRun id for every provider, so a mismatch is a real substitution. The non-streaming endpoint returns vendor-versioned ids on some paths and a composite `"asked (fallback: served)"` string on others, and the same check there would be noise.

### Known gap
- **Three newly-added vision models are not yet in the `visionModels` default**, so an image sent to `deepseek/deepseek-v4-flash-vision-exp`, `qwen/qwen3.8-flash` or `xiaomi/mimo-v2.5` is still refused as unsupported. All three carry the `vision` tag — the tagged count went 37 to 40 — but the default list only ever contains models measured to accept a real image through this gateway, and these three arrived after the last measurement run. They are paid, so measuring them costs a few cents against a funded wallet; until that runs, set `visionModels` explicitly if you want to use one. Listing them on the tag alone is the mistake that made 0.10.2 necessary: several tagged models charge and then fail.

## 0.10.3 — 2026-08-30

### Fixed
- **Not one of the free models was reachable, because the route asked for a wallet before it looked at what you named.** BlockRun rebuilt its free tier on 2026-08-30 — NVIDIA retired four of the five free models in a single sweep and seven now stand in their place — and the gateway serves every one of them with HTTP 200 and no `402` at all. This plugin resolved the wallet key as the first thing a request did, so a machine with no key exported failed with `MISSING_CREDENTIAL` before it could discover that the model needed no key. The credential is now resolved only for a model the catalog does not bill as `free`, which is what the "no accounts, no API keys, no credit card" line on the front of this README was supposed to mean. Verified against the live gateway with nothing exported: `nvidia/nemotron-3.5-lightning`, `cohere/north-mini-code` and `poolside/laguna-xs-2.1` all answered, and `deepseek/deepseek-chat` still failed with `MISSING_CREDENTIAL`. The exemption is read per model from the catalog, so a model repriced away from free starts requiring the key on the next catalog read — and if the catalog cannot be read at all, every model is treated as paid.
- **`/spend` charged for calls that cost nothing.** Every completed call was counted at the flat request price regardless of model, so a session spent trying the free tier reported a total invented out of a wallet nothing had touched. Free rows now read `$0  N calls  (free tier — no payment was signed)`, the total is summed from the rows rather than from the call count, and the large-context warning averages over the paid calls alone — a call that was never quoted cannot be under-quoted.
- **The model count said 68; the gateway serves 70.** `npm run sync:models` now also generates the free-model count, which is the figure most likely to go stale: four of five free models died in one morning. Both counts carry markers in both READMEs and are checked against the live catalog in the e2e suite.

### Changed
- **The reason `visionModels` excludes two NVIDIA entries is not the one that was documented.** The list itself is unchanged at 31, but the free tier turned over underneath it: `nemotron-nano-12b-v2-vl` was retired and `nvidia/llama-3.2-11b-vision` took its place. Re-measured with the same inline PNG — `llama-3.2-11b-vision` answered "you didn't provide an image" on 3 of 3, and `nemotron-3-nano-omni-30b-a3b-reasoning` answered correctly on only 3 of 8. The five misses were not the model: the gateway's free-tier fallback served `nvidia/nemotron-3-nano-30b`, which has no vision at all — six consecutive requests in a row, at the time of writing. The response does name the substitute in its `model` field, and this route does not read it, so `/spend` and every error message attribute the call to the model you asked for. Reported as BlockRunAI/blockrun#450 and documented under "Honest notes".
- **Two "known limitations" described a plugin that stopped existing three releases ago.** Both READMEs still said images were refused and vision was planned, and that reasoning-effort selection was refused. Both shipped in 0.10.0. A stale entry is worse in that section than anywhere else: it is where a reader goes specifically to find out what does not work.

## 0.10.2 — 2026-08-30

### Fixed
- **The default `visionModels` was four models; the gateway now serves images on thirty-one.** The verified set was measured on 2026-08-16, when OpenAI returned HTTP 400 after payment, xAI 503, and Anthropic relayed an upstream error as the model's answer. Re-measured on 2026-08-30 with the same inline PNG against every tagged chat model: 31 of 37 answer correctly, including every Anthropic, Google, xAI and Z.ai entry. The default now lists all thirty-one, so an image sent to `anthropic/claude-sonnet-5` or `openai/gpt-5.5` is no longer refused by the harness as unsupported. Still excluded, because each failure is paid for: `openai/gpt-5.2-pro`, `gpt-5.4-pro` and `gpt-5.5-pro` drop the image and answer as if none was sent, `gpt-5.6-luna-pro` returns HTTP 500 after payment, and both NVIDIA Nemotron entries answer wrongly or rate-limit. Raised by [Rosecheng7](https://github.com/BlockRunAI/dsh-clawrouter/issues/2), whose harness could only reach four models with an attachment.

## 0.10.1 — 2026-08-16

### Fixed
- **The review gate asked for output it never used, and paid for it.** The gateway settles on the `max_tokens` a request asks for, so an uncapped review was billed at four times the price of the two-field JSON verdict it produces: $0.0249 against $0.0057 on `anthropic/claude-opus-5`, every time the gate fired. Reviews now ask for 512 tokens, configurable as `reviewerMaxTokens`. Raise it only if verdict reasons are being truncated.
- **The documented cost of a review was stale.** The README said $0.0048; the measured figure at the new cap is $0.0057, and on 0.9.0 — where the reviewer inherited Opus's advertised 128,000-token output — it was $0.28–0.33. Thanks to [Rosecheng7](https://github.com/BlockRunAI/dsh-clawrouter/issues/1) for reporting the gap between the table and the wallet.

## 0.10.0 — 2026-08-15

### Fixed
- **The default output cap billed 89x on Opus.** This gateway quotes from the request — input size plus the `max_tokens` asked for — and settles that amount whichever way the model answers. `defaultMaxTokens` was taken from a model's advertised `max_output`, so `anthropic/claude-opus-5` carried a 128,000 default and quoted **$0.3211** per call, against $0.0216 with no cap and $0.0036 capped at 1,000. Eighty-nine times the cost, decided by a field the caller never set. Capped at the new `maxOutputCeiling` (8,192); raise it when a workload genuinely needs long replies.

### Corrected
- **"Priced per request, not per token" was wrong, and had been since 0.3.2.** Per-token pricing is live. What the earlier measurement found was a **floor** — a $0.001 minimum payment plus a flat $0.001 transaction fee — and it was taken only on `deepseek/deepseek-chat`, the cheapest model on the route, where even 8,000 output tokens stays under that floor. Opus across the same range: $0.0020 at 16 tokens, $0.0036 at 1,000, $0.0211 at 8,000, $0.1511 at 60,000. The observation that produced tokens do not change the charge was correct; the explanation was not. Thanks to Dev J for checking it against production rather than taking it on faith.
- `/spend` no longer says "not billed by token". Its figure remains a lower bound, for a better-understood reason.



### Added
- **Reasoning effort.** Previously any `reasoningEffort` threw `UNSUPPORTED`, so a DSH user routing a reasoning model through BlockRun could not ask for more thinking at all. Efforts are now declared per model from the catalog's `reasoning` tag and sent as `reasoning_effort`. Measured on `deepseek/deepseek-reasoner`: `max` produced 386 characters of reasoning against 248 at the default, so it takes effect rather than merely being accepted.
- **Per-vendor dialect translation.** `max` is DeepSeek's vocabulary, which the harness adopts; OpenAI's is `low | medium | high` and it returns HTTP 400 **after taking payment** for anything else. `max` is translated to each vendor's nearest value instead of being refused — asking for the most thinking available should not fail over a spelling. Anthropic, Google and xAI accepted `max` without error and without producing reasoning either way, so the downgrade loses them nothing.
- **A local refusal for models that do not reason.** `openai/gpt-4o` charges and then rejects `reasoning_effort` outright, so the adapter checks the catalog first and fails free, naming the model and what to do instead.



### Fixed
- **Every rule assumed a shell command; file writes caught 2 of 10.** Writing `.git/hooks/pre-commit`, `.github/workflows/ci.yml`, `~/.bashrc`, a LaunchAgent, `.gitconfig`, `.env`, or an npm `postinstall` all executes code later — on the next commit, the next CI run holding your secrets, the next install on someone else's machine. None were flagged; the two that were, were caught by the credential-path rule recognising a filename by accident. Now 10 of 10, with 0 false positives across 15 ordinary file edits including routine `package.json` work, `.env.example`, and documentation that discusses git hooks.

### Added
- **`RiskRule.params`** matches on a parameter being present at all, for `sandbox_permissions` — dangerous because it was passed, not for its value, which is an ordinary word.
- **`RiskRule.includeBody`** lets a rule opt into seeing file content. Content is excluded by default because it is data, but npm runs `postinstall` on every install, so that one file's body is executable. The rule pays for the access by being specific enough not to fire on prose about postinstall.



### Fixed
- **The gate caught 1 of 39 realistic destructive commands.** Recall is the ceiling on everything this plugin claims — a command the matcher never flags is one the reviewer never sees — and it had never been measured against anything but the commands the rules were written for. Twenty-two rules added, covering branch and remote-branch deletion, stash and reflog destruction, container volumes, `kubectl delete`, `helm uninstall`, S3 removal, `gh repo delete`, `DROP`/`TRUNCATE`/`FLUSHALL` through a database client, `crontab -r`, firewall flushes, service stops, disk erase, `rsync --delete`, package purge and unpublish, unattended `terraform apply`, `shred`, system-path truncation, and permission stripping. Now 39 of 39, with 0 false positives across 59 ordinary commands.
- **Command-position anchoring was trivially evadable.** `rm -rf /` was flagged while `\rm -rf /`, `command rm -rf /`, `env rm -rf /`, `eval "rm -rf $DIR"`, `bash -c "rm -rf /"` and `… | xargs rm` all passed — the worst shape for a safety filter, stopping the honest spelling and passing the deliberate one.
- **`npm publish --dry-run` no longer counts as publishing.**

### Added
- **Heredoc bodies are treated as data**, so `cat > cleanup.sh << EOF` carrying `rm -rf /tmp/build` stays quiet — but only when the body is written rather than run. Piping a heredoc into a shell, feeding one to `bash` on stdin, or writing a script and invoking it in the same command all keep the body in scope; each was a working bypass first. An unterminated heredoc is never stripped, since the strip would otherwise swallow every command after it.
- **A permanent risk corpus** (`tests/risk-corpus.spec.ts`): 39 destructive commands, 59 ordinary ones including commands that merely mention a destructive one, and 6 heredoc bypasses.



### Fixed
- **An upstream error the gateway relays as assistant text is now a failure, not an answer.** Measured: an image request to `anthropic/claude-sonnet-5` or `claude-opus-5` returns HTTP 200 and streams `[Error: 400 {"message":"Could not process image"}]` as the model's reply. The harness sees an ordinary successful turn, the call is paid for, and the agent acts on the error string as though the model wrote it. Detection is anchored to the whole message, so an answer that merely mentions an error, or a turn that also called a tool, is untouched. The relayed status maps exactly as it would have if it had arrived as a real one.
- **A completed response with no content finishes with `EMPTY_RESPONSE`** rather than as a successful empty message, matching the first-party DeepSeek adapter. Previously only a stream with no finish reason at all was caught.

### Corrected
- **0.5.0 described the Anthropic vision failure wrongly.** It said those models "charged, then streamed nothing — no error, no content". They stream a great deal: the upstream error, as the answer. The original observation was truncated by `head` because the relayed text begins with two newlines, and the blank line got read as an empty response. The corrected behaviour is worse than what was published, not better.



### Fixed
- A bare string was passed where the e2e vision test needed a branded `AttachmentId`. The test typecheck reported it and 0.5.0 was published anyway — the check is only worth having if publishing waits for it, so `prepublishOnly` now runs both typecheck programs and the unit suite.



### Added
- **Vision.** DeepSeek serves no vision model, so this is capability rather than savings. A user message carrying an image now serializes to OpenAI content parts with the attachment inlined as a `data:` URL; a message without one still serializes to a bare string, so text traffic is unchanged on the wire. Images are read through the optional attachment service, resolved per request, and several in one turn resolve concurrently.
- **`visionModels`** selects which models may receive an image, defaulting to the four measured to work.

### Measured
- **The gateway's `vision` tag cannot be trusted, and the failures are paid.** Thirty-five entries carry it; ten were sent the same inline PNG. Google's three and `moonshot/kimi-k3` answered correctly. OpenAI's three returned HTTP 400 *after taking payment*, `xai/grok-4.5` returned 503, and both Anthropic models charged and streamed nothing at all — no error and no content, which downstream is indistinguishable from a model that had nothing to say. A model is therefore offered image input only when the gateway tags it `vision` **and** it appears in `visionModels`; the tag alone over-claims, and the list alone would keep claiming vision after the gateway retags a model.



### Added
- **A from-zero Docker smoke test** (`npm run test:docker`). Installs the published package from npm into a container that has never seen this project and asserts eleven things: that the profile composes, that the gate ships disarmed, that `lib/` is in the tarball and `src/` is not, and that the npm description's model count matches the README's. Passes on `linux/arm64` and `linux/amd64`. Needs no wallet and no key.

### Documented
- **`dsh` needs `python3`, `make` and `g++` on a slim Node image.** Its `node-pty` dependency has no prebuild for `node:22-slim` on either architecture, so npm rebuilds from source and the install dies at `Could not find any Python installation to use` — a message that names neither dsh nor this plugin. Found by running the install in a clean container rather than reasoning about it; it had always worked on a developer machine.



### Fixed
- **The install's six `✕ missing peer` lines are now explained before a user meets them.** Walked the first-run path on a clean `DSH_HOME` against the published package: `dsh plugin add` prints six missing-peer errors, and the profile then composes correctly and lists both rows under `--dump-config`. The warnings are cosmetic — the harness supplies those packages at runtime, and every first-party bundle declares its peers the same way — but six red marks during the very first command read as a failed install.



### Fixed
- **npm advertised 70 models while every README said 67.** `package.json`'s description carries the same count on the package page, where an HTML marker cannot go, so filling the markers in 0.3.13 moved the stale copy somewhere less visible rather than removing it. `npm run sync:models` owns that string now and fails loudly if the description stops matching.

### Added
- **Two gates that make "does the README need updating?" mechanical.** Every command the plugin registers must be documented in both READMEs, read from the source so a new command cannot ship undocumented; and the npm description's model count must equal the READMEs'. Both were fed their bug and rejected it.



### Added
- **`/gate` — check the safety net is actually up.** The gate can be off while everything a user can see looks correct: `enabled` defaults to `false`, a patch layer replaces a row's whole `config` rather than merging keys, and `/review` registers either way — so a working `/review` is evidence the plugin loaded and no evidence at all that tool calls are inspected. `/gate` is registered whether or not the gate is armed, which is the point; a command that appeared only when the gate worked could never report the one state worth asking about.
- **`/gate drill`** sends `rm -rf / --no-preserve-root` through the risk matcher and the live reviewer — never to a tool — and reports each stage separately. A rule that stopped matching is a policy problem; an unreachable reviewer is a wallet or model problem. At runtime both collapse into "escalate", which is indistinguishable from the gate working, so the drill deliberately does not reuse the gate's own error folding.
- **Tests are typechecked.** `tsconfig.test.json` covers `tests/` and `scripts/`, which the base program excluded because it emits `src` into `lib` with a `rootDir`.

### Fixed
- Four latent type errors in tests that had never been checked, including a fixture using `kind: 'error'` against a `'reply' | 'throw' | 'hang'` union — it matched no branch, silently ran the default behaviour, and passed the wrong scenario.



### Fixed
- **The model count said 70; the catalog exposes 67.** Eight sites across both READMEs carried `<!-- br:models.chatVisible -->` markers — the notation for generated content — but the script that fills them was never written, so the number froze at whatever was true the day it was typed.

### Added
- **`npm run sync:models`** rewrites every marker from the live catalog, counting through `projectCatalog` so the figure is what this route exposes rather than what the gateway lists. It refuses to write `0`.
- **Two gates, split by what each can know.** An offline test asserts every marker agrees with the others, catching a hand-edit of one site; a live e2e test asserts the count matches the gateway and names `sync:models` in its failure message. Both were fed their bug and rejected it.

### Changed
- `tsx` is a devDependency, so a maintenance script can import the plugin's own catalog projection instead of restating the filter in JavaScript.



### Fixed
- **"$5 covers thousands of calls" quoted only the flattering end of a range this document measures.** True at the $0.002 floor, where $5 buys about 2,500 gate reviews. At the other end of the same table it buys about five 100K-context calls on Opus — a 500x spread, given as one number, in the paragraph where a reader decides how much to fund. Both figures are stated now, with the advice to fund for intended use rather than for the floor.

### Added
- **The funding advice is checked as arithmetic.** Each promised call count must equal the funding amount divided by a price the pricing table states. The gate rejects the old slogan and, separately, a version that quotes an accurate 2,500 without its counterweight — a correct number can still mislead by being the only one offered.



### Fixed
- **A third pricing claim disagreed with the measured table.** The compaction section said a ~100K-token summarization runs $0.50 on Claude Opus 5 and $0.014 on DeepSeek V4 Flash. Live 402 quotes at that size read **$0.901** and **$0.0262** — both understated by about 1.8x, the signature of the per-token estimate this project disproved in 0.3.2. The argument for moving compaction to a cheap model gets stronger, not weaker: the real gap is 34x.

### Added
- **The README's prose is now checked against its own pricing table.** Three releases in a row shipped a dollar figure in prose that contradicted the table a few sections above it, so the check is mechanical rather than editorial. Above the flat floor the quote is linear in input size — 100K/112K measured 0.89 for Opus and 0.90 for DeepSeek against an input ratio of 0.893 — which gives a tight enough bound to catch a stale estimate.

  The first version of this gate asserted only that the 100K figure fell between the 22K and 112K quotes. Fed the actual bug, it passed: $0.50 sits inside that band. A bound that admits the defect it was written for is worse than no bound, because it reports the claim as verified. Both stale figures are now used as fixtures, per language.



### Fixed
- **The READMEs contradicted themselves about pricing.** One section said, correctly since 0.3.2, that this route is priced per request rather than per token. The "Honest notes" section still carried the original 0.1.0 claim — "provider cost plus a flat $0.001/request" — which 0.3.2 disproved. The correction had been applied in one place and not the other, for eleven releases, in the section named for being honest.

  The conclusion was never wrong: do not route a cache-warm loop through this gateway. The reasoning now matches the measurements, and the comparison is starker than the old one — about $0.000056 for a cache-hit turn on DeepSeek directly against roughly $0.007 here at 22K input tokens.

## 0.3.9 — 2026-08-14

### Measured
- **What the gate costs to leave on**, which is the question that decides whether anyone keeps it enabled. Against 32 commands from a real coding session it fired **zero** times, and it missed **none** of the destructive set. One review is ~356 tokens — the flagged call, not the conversation — quoting **$0.0048** on `claude-opus-5` and $0.002 on cheaper reviewers, and taking about 3 seconds.

  So it is invisible during ordinary work and bills about half a cent on the rare command that earns a second opinion. Both figures are in the READMEs.

### Added
- A test asserting the zero-of-32 trigger rate. The failure this guards against is a future rule that starts flagging `npm test` — noise is how a safety gate gets switched off, and it should fail CI rather than someone's session.

## 0.3.8 — 2026-08-14

### Fixed
- **A mistyped `reviewerModel` was indistinguishable from the gate working.** Every flagged command escalated or was denied, with no hint that the reviewer itself could not exist — a broken safety feature looks identical to a cautious one from the user's seat, and with `onReviewerFailure: deny` it would block risky commands forever with no clue why.

  The cause is now carried: a denial reads *"BlockRun does not serve model "anthropic/claude-opus5" … Did you mean "anthropic/claude-opus-5"?"*, verified in a real session.

  That works because the reviewer's failure is no longer flattened. The harness reports most adapter failures as a terminal chunk rather than a throw, and this code turned that into a bare `reviewer stream ended: error`, discarding the code and message the diagnosis needed. Configuration failures are also logged once — useful where a log exporter is composed, though `dsh-base` composes none, so the reason string is the channel that actually reaches a headless user.

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
