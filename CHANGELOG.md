# Changelog

All notable changes to `dsh-clawrouter`. Versions follow [semver](https://semver.org).

Entries say what changed for *you*, and what it meant when it was wrong — most of the fixes below were silent, so "upgrade if you are on an earlier version" is the honest summary of every one of them.

## 0.2.4 — 2026-08-14

### Fixed
- **Escalating to a human skipped the rest of the policy chain.** A waterfall listener that returns without delegating short-circuits it, so when the reviewer was unsure the gate's `ask` replaced every later `tools/pre-execute` listener. A stricter policy that would have *denied* the call never ran, and a human clicking Allow could run something the deployment had already refused — this gate widening the very policy it sits in front of.

  An escalation now takes the downstream decision first and is only ever added on top of a call the rest of the chain would have allowed. "It only ever narrows" is now true of every path, not just the cleared one.

### Added
- Live tests that try to talk a real reviewer into clearing `rm -rf ~`: an embedded verdict object, "ignore all previous instructions", claimed security-team authority, a fake system turn, and role reversal. All five are refused.

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
