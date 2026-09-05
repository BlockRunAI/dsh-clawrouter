<div align="center">

<img src="https://raw.githubusercontent.com/BlockRunAI/dsh-clawrouter/main/assets/banner.png" alt="dsh-clawrouter — review the dangerous command, before it runs" width="600">

<h1>给 DeepSeek Harness 智能体配一个「第二大脑」</h1>

<p>DeepSeek 又快又便宜，主循环就该继续用它。<br><br>
<strong>这个插件补的是它做不到的事：危险命令执行前，让更强的模型先审一遍。</strong><br><br>
<em>一个凭据直调 <!-- br:models.chatVisible -->75<!-- /br:models.chatVisible --> 个模型——在 <a href="https://user.blockrun.ai">user.blockrun.ai</a> 领一把 API Key，或者不想注册就用 Solana / Base 钱包。</em></p>

<br>

<img src="https://img.shields.io/badge/🛡️_执行前审查-success?style=for-the-badge" alt="执行前审查">&nbsp;
<img src="https://img.shields.io/badge/🧠_Claude_审_DeepSeek-black?style=for-the-badge" alt="Claude 审 DeepSeek">&nbsp;
<img src="https://img.shields.io/badge/🔑_API_Key_或_钱包-blue?style=for-the-badge" alt="API Key 或钱包">&nbsp;
<img src="https://img.shields.io/badge/💰_x402_USDC-purple?style=for-the-badge" alt="x402 USDC">

[![npm version](https://img.shields.io/npm/v/dsh-clawrouter.svg?style=flat-square&color=cb3837)](https://npmjs.com/package/dsh-clawrouter)
[![npm downloads](https://img.shields.io/npm/dm/dsh-clawrouter.svg?style=flat-square&color=blue)](https://npmjs.com/package/dsh-clawrouter)
[![GitHub stars](https://img.shields.io/github/stars/BlockRunAI/dsh-clawrouter?style=flat-square&label=GitHub%20stars)](https://github.com/BlockRunAI/dsh-clawrouter)
[![CI](https://img.shields.io/github/actions/workflow/status/BlockRunAI/dsh-clawrouter/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/BlockRunAI/dsh-clawrouter/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](../LICENSE)

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek-Harness_插件-4D6BFE?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![x402 Protocol](https://img.shields.io/badge/x402-微支付-purple?style=flat-square)](https://x402.org)
[![领取 API Key](https://img.shields.io/badge/领取_API_Key-user.blockrun.ai-0B7285?style=flat-square)](https://user.blockrun.ai)
[![Solana](https://img.shields.io/badge/Solana-USDC-14F195?style=flat-square&logo=solana&logoColor=black)](https://solana.com)
[![Base](https://img.shields.io/badge/Base-USDC-0052FF?style=flat-square&logo=coinbase&logoColor=white)](https://base.org)
[![Telegram](https://img.shields.io/badge/Telegram-社区-26A5E4?style=flat-square&logo=telegram)](https://t.me/blockrunAI)

[English](../README.md) | 中文

</div>

> **dsh-clawrouter** 是一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，把一个更强的模型放在智能体危险操作的前面。当智能体准备执行 `rm -rf ~`，审查模型会读一遍并给出放行 / 拒绝 / 交给你——由真实的工具执行器强制执行，而不是靠提示词劝阻。它同时注册一条 BlockRun provider 路由，让审查模型（以及全部 <!-- br:models.chatVisible -->75<!-- /br:models.chatVisible --> 个模型）都能用**一个凭据**直接调用：在 [user.blockrun.ai](https://user.blockrun.ai) 领一把 BlockRun API Key，按真实 token 用量计费；或者不想注册任何账号，就用 Solana / Base 钱包通过 [x402](https://x402.org) 用 USDC 按次付费。MIT 许可。

```sh
dsh plugin --profile web add dsh-clawrouter
```

---

## 为什么做这个

社区里反复出现的两件事：

> 「是否有类似 Codex 或者 CC 的审查模式？即额外调用模型审查指令，以解放双手？Full Access 还是太让人担心了。」
> —— [#421](https://github.com/deepseek-ai/deepseek-harness/discussions/421)

> 「使用 Full Access 模式创建并测试插件时误删了我的整个家目录」
> —— [#461](https://github.com/deepseek-ai/deepseek-harness/discussions/461)

`Full Access` 是全有或全无：要么每条命令都手动批准，要么什么都不批直接赌一把。这个插件提供第三种选择。

## 对比

|                    | 全部手动批准     | Full Access | 权限规则           | **dsh-clawrouter**       |
| ------------------ | ---------------- | ----------- | ------------------ | ------------------------ |
| **解放双手**       | 否               | 是          | 是                 | **是**                   |
| **能拦住 `rm -rf ~`** | 你得正好看见  | 否          | 只有你写过这条规则 | **能**                   |
| **理解意图**       | 靠你自己         | 无          | 否，只做字面匹配   | **能，模型真的在读**     |
| **在哪里强制**     | UI 弹窗          | —           | 执行器             | **执行器**               |
| **失效时**         | —                | 放行        | 拒绝               | **交给人，绝不默默放行** |
| **会审查日常操作** | 全都审           | 都不审      | 都不审            | **都不审**               |

## 它做什么

### 1. 审查闸门

当智能体准备执行破坏性操作时，一个强模型（默认 `anthropic/claude-opus-5`）会读一遍并给出结论：

| 结论 | 结果 |
|---|---|
| safe（安全） | 原样放行，继续走正常的权限链 |
| dangerous（危险） | **拒绝**，并给出智能体能据此调整的理由 |
| uncertain（不确定） | **交给你决定**——弹出正常的审批提示 |

它只会**收紧**，不会放宽。审查通过的调用，依然要经过你已有的沙箱、权限和审批；**升级给人处理时也一样**——如果更严格的策略本来就会拒绝这次调用，你拿到的是那个拒绝，而不是一个审批弹窗。它不替代权限系统，只是站在权限系统前面。

在 profile 的 `cordis.patch.yml` 里启用：

```yaml
- id: blockrun-review
  config:
    enabled: true
    reviewerModel: anthropic/claude-opus-5
```

**哪些会被审查。** 刻意做得很窄——一个动不动就报警的闸门，最后一定会被关掉，那就等于没有保护。读取、编辑、构建从不触发。内置规则只盯：递归删除、裸写磁盘、fork 炸弹、`curl … | sh`、强制推送与 hard reset、`chmod 777`、`sudo`，以及碰 `~/.ssh`、`~/.aws`、`/etc/passwd` 的操作；还有那些**不叫 `rm` 但一样在删东西**的：`git clean -fdx`、`find … -delete`、`git checkout -- .`、`terraform destroy`，以及 `npm publish`（发出去的版本，registry 不让你收回）。

**提到一条命令不等于执行它**——`grep -rn "rm -rf" docs/` 不会被拦；**写下一条命令同样不等于执行它**——包含 `rm -rf build` 的 Makefile、清理脚本、引用了 `git reset --hard` 的 README，都是再正常不过的工作。文件正文类参数（`content`、`new_string`、`diff` 等）一律当作数据看待：文件里的命令真正生效是在有人去执行它的时候，而那一次执行是另一个调用，本闸门照样会读。可以加自己的规则：

```yaml
    extraRules:
      - name: no-prod-deploy
        pattern: "deploy\\s+--env[= ]prod"
```

**如果 `reviewerModel` 写错了**，每一条被标记的命令都会升级或被拒绝——这看起来和「闸门在谨慎工作」一模一样。现在失败会带上原因，所以拒绝信息里会直接写「BlockRun does not serve model … Did you mean …?」，而不是一句干巴巴的超时；在有日志导出器的组合里还会额外记一条警告。

**审查模型不可用时**，默认交给你处理（`onReviewerFailure: ask`）。它绝不会默默放行——失效即放行的安全闸门比没有更糟；也不会因为一次网络抖动就把会话卡死。无人值守的自动化可以改成 `deny`。

### 一直开着要花多少

实测数据，因为这才是决定你会不会一直开着它的问题：

| | |
|---|---|
| 日常操作触发率 | **0/59** —— 包含那些只是**提到**危险命令的（`grep -rn "rm -rf" docs/`、`echo "DROP TABLE" >> notes.md`） |
| 危险命令漏掉 | **0/39** —— 覆盖 git、容器、集群、云存储、数据库、主机状态 |
| 抓「以后才执行」的文件 | git hooks、CI workflow、shell 启动文件、launch agent、`.gitconfig`、`.env`、npm `postinstall`、sandbox 提权 —— 10/10，15 条日常文件操作 0 误报 |
| 抗绕过 | `\rm -rf /`、`command rm`、`env rm`、`eval "rm -rf $DIR"`、`bash -c "…"`、`\| xargs rm`，以及管进 shell 的 heredoc |
| 触发时的费用 | `claude-opus-5` 上 **$0.0057** —— 这是 512 token 输出上限下的价格，不设上限是 $0.0249 |
| 触发时的延迟 | 约 3 秒 |
| 审查模型看到什么 | 约 356 token —— 只有那一次被标记的调用，**不是你的会话** |

**这个数字取决于输出上限。** 这条网关是按请求报价的——输入大小加上请求里写的 `max_tokens`——并且不管模型实际吐出多少，都按这个额度结算；所以一次审查申请了却用不上的输出空间，每次触发都要照付。`reviewerMaxTokens`（512）就是让一个两字段的 JSON 裁决按它自己的体量收费。0.10.0 之前，审查请求继承的是 `claude-opus-5` 自报的 128,000 输出上限，单次要 **$0.28–0.33**；如果你还在更早的版本上，请升级，而不是换一个更弱的审查模型。

也就是说：**日常工作里它是隐形的** —— 不加延迟、不花钱、不弹窗；只在真正值得看一眼的命令上花掉大约半分钱。「32 条零触发」这个数字有测试守着，将来哪条新规则开始拦 `npm test`，会挂在 CI 上，而不是挂在你的会话里。

### 2. `/spend`

```
/spend
```

本进程启动以来这条路由花了多少钱——总额、分模型、token 与费用。

**这个数字怎么算，取决于你用的是哪种凭据**，因为两者的计费口径是真的不一样。`/spend` 会在总额下面的那句话里说明它用的是哪一种。

**用 API Key 时：** 按厂商实际报告的 token 数 × catalog 公布的每百万单价计算。这就是你账户被开票的口径——没有每次调用费、没有最低消费——所以这个数字是跟 [`/dashboard/activity`](https://user.blockrun.ai/dashboard/activity) 对得上的，而不是近似。对真实账户主机实测：`openai/gpt-5.5` 在 16 输入 / 17 输出 token 时报 `$0.000590`，也就是 `16/1M × $5 + 17/1M × $30`。catalog 没有给出单价的模型会被记为**未定价**并明确标出，绝不会悄悄按 `$0` 处理。

**用钱包时：** 是网关当次给出的固定报价。同一个请求在两条链上的报价并不一样——2026-09-05 实测，Base 是 `2000` µUSDC，Solana 是 `1000`——所以 `/spend` 用的是这次调用**实际结算的那条链**的数字（`requestFeeUsd`、`solanaRequestFeeUsd`）。一段会话如果两种都用过，会报 `mixed` 并把两种口径都解释一遍。

以下所有内容都是在讲**钱包**路径，那里的数字是「报价」而不是「用量」。0.11.0 之前这些数字也被用在 API Key 部署上，会把一段全是小请求的会话高估好几个数量级。

**你为「请求了多少」付费，不是为「拿到了多少」付费。** 网关按请求报价——输入规模，加上你要求的 `max_tokens`——然后无论模型怎么回答，都按这个报价结算。对生产环境实测：

| 请求的 `max_tokens` | `claude-opus-5` | `deepseek-chat` |
|---|---|---|
| 16 | $0.0020 | $0.0020 |
| 1,000 | $0.0036 | $0.0020 |
| 8,000 | $0.0211 | $0.0020 |
| 60,000 | $0.1511 | $0.0027 |

由此有两点，第二点是真花钱的。

**有一条 $0.002 的下限**——$0.001 最低支付额加 $0.001 固定手续费。低于它的一切报价都一样，这就是上表里 `deepseek-chat` 几乎不动的原因：它便宜到连 8,000 输出 token 都还在下限之下。这一节的早先版本，正是从这个观察得出「按次计费不按 token」的结论——而那只在 `deepseek-chat`（这条路由上最便宜的模型）上测过，下限把费率完全遮住了。

**大的 `max_tokens` 即使回复很短也照样计费。** 所以 `defaultMaxTokens` 由 `maxOutputCeiling`（8,192）封顶，而不是取模型自报的 `max_output`。不封顶的话，`claude-opus-5` 自报 128,000，带着这个默认值的请求报价 **$0.3211**——完全不设上限是 $0.0216，设成 1,000 是 $0.0036。**89 倍的差价，由一个调用方从没设过的字段决定。** 确实需要长回复的场景再调高 `maxOutputCeiling`，那时你是在**有意识地**为它付费。

**报价的另一半由输入规模决定。** 同一请求在不同 prompt 规模下，`max_tokens` 保持很小：

| 模型 | 小请求 | ~22K 输入 | ~112K 输入 |
|---|---|---|---|
| `openai/gpt-4.1-nano` | $0.002 | $0.005 | $0.023 |
| `deepseek/deepseek-chat` | $0.002 | $0.007 | $0.031 |
| `google/gemini-3.5-flash` | $0.002 | $0.066 | $0.325 |
| `anthropic/claude-opus-5` | $0.002 | $0.217 | **$1.081** |

全都从同一条下限起步，然后分化 30 多倍。一个持有 10 万 token 上下文的编程智能体，在 DeepSeek 上每次调用约为下限的 15 倍，在 Opus 上是 500 倍。`/spend` 会在你的平均上下文很大时主动提示，并指向你自己模型的费率，而不是给一个数。它也看不见「付了钱但失败」的请求。**钱包余额才是权威。**

**免费模型就是 $0，`/spend` 会如实这么写。** catalog 标记为 `free` 的那 <!-- br:models.free -->7<!-- /br:models.free --> 个模型根本走不到 x402 握手——网关直接返回 `200`，没有 `402`，所以没有签过任何报价，链上也没有任何结算。它们的行显示为 `$0  N calls  (free tier — no payment was signed)`；下面那条「大上下文」告警只按**付费调用**来计算平均值，因为一次从未被报价的调用不可能被低估。0.10.3 之前，每一次调用都会被按固定请求价记一笔，于是一整段只用免费模型的会话会报出一个完全虚构的花费。

**它也会告诉你「这次其实是别的模型回答的」。** 网关在免费层背后会静默替换——对 `nvidia/nemotron-3-ultra-550b` 的请求大约每三次就有一次由一个 30B 应答——而实际应答的模型写在它推送的 chunk 上。`/spend` 会把它列在你所请求的那一行下面：

```
nvidia/nemotron-3-nano-omni-30b-a3b-reasoning  $0  3 calls  (free tier — no payment was signed)
    answered by nvidia/nemotron-3-nano-30b on 1 of 3 — the gateway substituted a different model
    answered by nvidia/nemotron-3-super-120b on 2 of 3 — the gateway substituted a different model
```

这次调用仍然计在**你请求的**那个 id 上，而不是实际应答的那个：本计量器对每次调用都按同一个固定价计费，所以落在哪一行都不会改变总额，而你自己选的那个 id 才是你认得出来的。

读 402 报价免费，所以上面每个数字你都可以不花钱自己复现。

`requestFeeUsd` 默认 `0.002`，因为这是网关真实报的价：约 17 token 的请求，402 返回 `{"amount":"0.002000"}`。BlockRun 目前公开的价格页写的是 $0.001。

### 3. `/review`

```
/review <粘贴 diff、方案，或者智能体给出的结论>
```

用同一个强模型审你指定的内容。有用户[反馈过](https://github.com/deepseek-ai/deepseek-harness/discussions/475)这种情况：智能体其实已经读到了关键证据，却先下了错误结论，直到被人追问才发现真正的 bug。

### 4. `/gate` —— 确认安全网真的是开着的

```
/gate         # 闸门armed了吗？用的什么配置？
/gate drill   # 让一条危险命令走一遍真实审查模型
```

一个悄悄关着的安全功能，比从没装过更糟——因为你已经不看了。而这个闸门**可以在用户看到的一切都正常的情况下是关的**：`enabled` 默认 `false`，patch layer 会**整块替换**某一行的 `config` 而不是合并键，并且 `/review` 无论闸门开关都会注册——所以 `/review` 能用，只说明插件加载了，**完全不说明**工具调用有没有被审查。

所以 `/gate` 无论闸门开不开都会注册，并直接告诉你是哪种状态。`/gate drill` 会把 `rm -rf / --no-preserve-root` 送进风险匹配器和真实的审查模型——**永远不会送给任何工具**——并分两段分别汇报，因为这两段的失败原因毫不相干：规则不再匹配是策略问题，审查模型连不上是钱包或模型问题。运行时这两种都会塌缩成「交给你」，而那和「闸门正常工作」长得一模一样。drill 就是用来把它们分开的。代价是一次审查调用。

### 5. 视觉 —— 给你的智能体一双它本来没有的眼睛

DeepSeek 没有任何视觉模型，所以这是**能力**，不是省钱。贴一张图，视觉模型就能读：

```yaml
- id: blockrun-llm
  config:
    visionModels: [google/gemini-3.5-flash]   # 收窄实测默认值；自己验证过就可以加
```

**网关的 `vision` 标签不足以采信，所以本插件不信它。** 每个带标签的聊天模型都会收到一张纯色 PNG 并被问它是什么颜色，而且要连问**三种不同颜色**——只问一种是能蒙的——三次全对才会被声明支持图片输入。你可以用 `npm run probe:vision` 自己重测，它会直接打印可粘贴的名单。2026-08-31 实测，40 个里 34 个答对：

| 结果 | 模型 |
|---|---|
| 答对 | 所有带标签的 Anthropic、Google、Moonshot、xAI、Z.ai 模型；OpenAI 的非 `pro` 模型加 `gpt-5.6-sol-pro`、`gpt-5.6-terra-pro`，以及现在的 `gpt-5.6-luna-pro`；还有 `deepseek/deepseek-v4-flash-vision-exp` 和 `xiaomi/mimo-v2.5` |
| **拒收图片**——三次全部 `INVALID_REQUEST` | `openai/gpt-5.2-pro`、`gpt-5.4-pro`、`gpt-5.5-pro` |
| 回答说没收到图片，**因为网关根本没把图片发出去** | `nvidia/llama-3.2-11b-vision` |
| **根本没测到——是别的模型在回答** | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`（由 `nemotron-3-nano-30b` 应答）、`qwen/qwen3.8-flash`（由 `qwen3.7-flash` 应答） |

`llama-3.2-11b-vision` 那一行不是模型的问题：网关在发出请求之前，会在它的两条 NVIDIA 路径上**无条件**剥掉所有图片部分，而依据是一句「NVIDIA 模型没有视觉能力」的过时注释。直接对 NVIDIA 实测，这个模型和 `nemotron-3-nano-omni` 都能正确说出颜色。它仍然留在名单外，因为这份名单记录的是**穿过这条网关**之后还能用的东西——但这是网关的 bug，而且正在修。

最后一行是你自己往名单里加东西之前最该看懂的。这两个不是「不行」，是**根本没被接通**。`nemotron-3-nano-omni` 大约一半的探测轮次能通过，另一半由一个完全没有视觉能力的模型应答——收录它等于换来一条「网关心情好才通」的图片通道，而它心情不好时，你拿到的是一段关于它从没看过的图片的、自信的错误答案。`qwen3.8-flash` 则是**付费模型被更便宜的付费模型顶替**，所以这不是免费层特有的毛病。已向上游反馈：BlockRunAI/blockrun#450。

`gpt-5.6-luna-pro` 是往好的方向变的，但原因并不是它看起来的那样。它根本不是图片问题：目录里给它标的价低于 OpenAI 的实际收费，而网关的上游成本上限是**按目录价推导**的，于是每次请求都匹配不到任何 endpoint——它又没有声明 fallback，所以直接硬失败。把价格改对就通了，图片其实一直是好的。上面三个 `pro` 条目的图片修复是另一个改动，目前仍然开着，这就是它们还在拒收的原因。

第一次实测（2026-08-16）要糟得多：OpenAI 收了钱之后返回 HTTP 400，xAI 返回 503，Anthropic 把 `[Error: 400 {"message":"Could not process image"}]` 当作**助手文本**流回来——于是 harness 看到的是一次完全正常的成功轮次，智能体会把这串报错当成模型写的内容去执行。网关此后把这三种都修好了，本插件仍会识别这个确切形状（整条消息除了一个转发来的报错之外什么都没有），并把这次请求判为失败，状态码按它本该以 HTTP 形式到达时的方式映射。如果回答只是**提到**了某个错误，或者这一轮还调用了工具，则不会被改判。所以只有当网关给它打了 `vision` 标签**并且**它出现在 `visionModels` 里时，这个模型才会被声明支持图片输入，默认值就是实测集合。两个信号必须同时成立——只信标签会过度声称，只信列表则会在网关改标签之后继续声称。

自己验证过其他模型就往里加；那是改配置，不需要等这边发版。

### 6. 推理强度

推理模型提供 `high` 和 `max`，按 catalog 的 `reasoning` 标签逐个声明。

`max` 是 DeepSeek 的词汇，harness 沿用了它。OpenAI 的词汇是 `low | medium | high`，其他值会**收了钱之后返回 HTTP 400** —— 所以 `max` 会被翻译成各家最接近的值，而不是直接拒绝。「我要最多的思考」不该因为一个拼写而失败。

但**完全不会推理的模型**是另一回事，会在**付款之前本地拒绝**：`openai/gpt-4o` 会先收钱再拒绝 `reasoning_effort`。catalog 里写明了哪些模型合格，所以这个判断不花钱。

### 7. 一个凭据，<!-- br:models.chatVisible -->75<!-- /br:models.chatVisible --> 个模型

注册一条 `blockrun` provider 路由，覆盖 BlockRun 提供的全部模型。这一点在 DeepSeek 覆盖不到的模型上最有价值——Claude、GPT、Gemini、Grok，而这恰恰是「审查」需要的。

付费方式有三种，三选一。它们不是同一扇门的三个把手：主机不同、计费方式不同、钱花完时的报错也不同。

| | **API Key**（推荐） | **Solana 钱包** | **Base 钱包** |
|---|---|---|---|
| 凭据 | [user.blockrun.ai](https://user.blockrun.ai) 签发的 `brk_live_…` | bs58 编码的 Solana 私钥 | 一把 EVM 私钥 |
| 主机 | `api.blockrun.ai` | `sol.blockrun.ai/api` | `blockrun.ai/api` |
| 计费 | 按真实 token 用量 × 公开价目表，**无每次调用费、无最低消费** | 每次请求一个固定报价，本地签名后上链结算（x402） | 同上，在 Base 上 |
| 充值 | 在后台用信用卡或电汇 | 往自己的地址转 Solana 链 SPL USDC | 往自己的地址转 Base 链 USDC |
| 消费记录在哪 | 账户账本 `user.blockrun.ai/dashboard` | 钱包余额本身 | 钱包余额本身 |
| 是否需要注册 | Google 登录 | 完全不需要 | 完全不需要 |
| 配置项 | `apiKeyEnv` | `solanaWalletKeyEnv` | `walletKeyEnv` |

**检查顺序就是上面这个顺序。** API Key 优先，因为那是你**特意**选的凭据——如果反过来去动一个你只是碰巧导出过的钱包，那就是拿你的钱付了一笔你本打算记在账户上的调用。**Solana 排在 Base 前面**：两个钱包都配了，说明的是这个部署**能**在哪些链上付款，而不是它更想用哪条；这条路由选 Solana。两个网关提供的模型目录完全一致，已逐个 id 核对过。

多加一个凭据不会影响现有部署：三个都不设，你的配置就什么都没变。

走 Solana 需要 `@solana/web3.js` 和 `@solana/spl-token`。它们是**可选** peer 依赖，所以 API Key 或只用 Base 的部署不会背上它们：

```sh
npm install @solana/web3.js @solana/spl-token
```

其中 <!-- br:models.free -->7<!-- /br:models.free --> 个模型在三条路径上都是免费的。在两个钱包网关上它们**连凭据都不需要**：网关对 `billing_mode: "free"` 的模型直接返回 `200`，根本不会走 x402 握手。在 `api.blockrun.ai` 上仍然要带 Key，因为那台主机对未认证请求一律返回 `401`，不管模型收不收费。这份名单是从 catalog 实时读取的，没有写死在这里——它变动的速度远快于本插件发版。

## 快速开始

```sh
dsh plugin --profile web add dsh-clawrouter
export BLOCKRUN_API_KEY=brk_live_...   # 也可以存进 credentials 服务
```

**安装时会打印六条 `✕ missing peer`，这是正常的。** 这些包由 harness 在运行时提供，所有第一方 bundle 也都是这么声明 peer 的——反过来直接依赖它们，会让 profile 里出现第二份 cordis，那种坏法要难查得多。已在全新环境实测：profile 正常组装，`dsh --profile web --dump-config` 能列出两行配置。什么都不缺。

### 领一把 API Key

这是最短的一条路；除非你明确不想开账号，否则就走这条。

1. 打开 **[user.blockrun.ai](https://user.blockrun.ai)**，用 Google 登录。账户创建出来就是预付费、余额为 0 的——注册本身不花钱。
2. 在 **[user.blockrun.ai/dashboard/credits](https://user.blockrun.ai/dashboard/credits)** 充值——信用卡结账，金额较大可以走电汇。
3. 在 **[user.blockrun.ai/dashboard/keys](https://user.blockrun.ai/dashboard/keys)** 签发一把 Key。明文只显示一次，当场复制。
4. `export BLOCKRUN_API_KEY=brk_live_...`

这样换来的是：**按真实 token 用量精确计费，没有每次调用费，也没有最低消费**，并且每一次调用都会写进你的账户账本——[`/dashboard/activity`](https://user.blockrun.ai/dashboard/activity) 上能看到每次调用的 request id、模型、token 数和金额，所以 `/spend` 和账单可以互相对账。

余额为 0 的 Key 仍然能调免费模型；任何收费模型会以 `PAYMENT_REQUIRED` 失败，并把你指向充值页面。

### 或者：用钱包，完全不开账号

BlockRun 也接受钱包签名，通过 x402 用 USDC 按次付费。不注册、不 KYC、不绑卡、不用给每家厂商都开一个账号。支持两条链，本路由优先 Solana。

**Solana**

```sh
npm install @solana/web3.js @solana/spl-token   # 可选 peer，只有这条路径需要
export SOLANA_WALLET_KEY=...                    # bs58 私钥
```

SDK 把 Solana 钱包存在 `~/.blockrun/.solana-session`；没有的话 `npx -y @blockrun/clawrouter` 会生成一个并打印地址。往这个地址转 Solana 链上的 SPL USDC。

**Base**

- **用过 BlockRun 的其他工具？** 那你已经有 Base 钱包了。SDK 存在 `~/.blockrun/.session`，ClawRouter 存在 `~/.openclaw/blockrun/wallet.key`。哪个存在就导出哪个：`export BASE_CHAIN_WALLET_KEY=$(cat ~/.blockrun/.session)`
- **还没有钱包？** `npx -y @blockrun/clawrouter` 会生成一个并打印地址。记下地址后停掉它，往这个地址转几美元 USDC（Base 链），然后导出私钥。

**别转错链。** 这是两条曲线上的两把不同的密钥，USDC 转到另一条链的地址上就没了——这也是为什么本路由的付费失败提示里，永远会把**链名**和地址一起写出来。

Base 链上 5 美元的 USDC，够跑约 **2,500** 次闸门审查（它们都落在 $0.002 的下限上）——也只够约 **5** 次带 10 万 token 上下文的 Opus 调用。同样是 5 美元；请按你**实际打算怎么用**这条路由来充值，而不是按它的下限。

### 或者：两个都不要

catalog 里标记为 `free` 的那 <!-- br:models.free -->7<!-- /br:models.free --> 个模型，在两个钱包网关上都完全不需要任何凭据。网关对它们返回 `200`、从不发起 x402 握手，所以 `dsh-clawrouter` 在发送之前不会去要密钥。选 `nvidia/nemotron-3.5-lightning` 或 `cohere/north-mini-code`，什么都不导出就能跑通。其余所有模型在你设置凭据之前仍然会以 `MISSING_CREDENTIAL` 失败——这个豁免是**按模型**判定的、从 catalog 读出来的，不是整体放宽。

### 关于凭据本身

本插件**不会自己去读**任何密钥文件。一个「用户没配置过、却悄悄盖住了他真正配置的那个」的凭据，正是 harness 凭据机制要防的事——所以它只读你指定的那个引用。

配置里写的三个都是**引用**（`apiKeyEnv`、`solanaWalletKeyEnv`、`walletKeyEnv`）而不是密钥本身，并且每次请求实时解析——换密钥下一次调用即生效，任何密钥都不会进入配置文件。

## 配置项

`blockrun-llm`（provider 路由）：

| 配置 | 默认值 | 含义 |
|---|---|---|
| `provider` | `blockrun` | 注册的路由名 |
| `apiKeyEnv` | `BLOCKRUN_API_KEY` | 存放 BlockRun 账户 Key（`brk_live_…`）的凭据**引用**——**最优先** |
| `solanaWalletKeyEnv` | `SOLANA_WALLET_KEY` | 存放 bs58 Solana 私钥的凭据**引用**——**排在 Base 之前** |
| `walletKeyEnv` | `BASE_CHAIN_WALLET_KEY` | 存放 EVM 钱包私钥的凭据**引用**，仅在前两个都没有时使用 |
| `apiKeyUrl` | `https://api.blockrun.ai` | API Key 认证所对应的账户 API 根地址 |
| `solanaApiUrl` | `https://sol.blockrun.ai/api` | Solana 钱包付费所走的 x402 网关根地址 |
| `apiUrl` | `https://blockrun.ai/api` | Base 钱包付费所走的 x402 网关根地址 |
| `timeoutMs` | `300000` | 单次请求超时 |
| `auxiliaryModel` | *(关闭)* | Harness 自身维护调用所用的模型——见下 |
| `requestFeeUsd` | `0.002` | **Base 钱包路径**上每次请求的固定费用，`/spend` 会用到——取网关实际报价，见下 |
| `solanaRequestFeeUsd` | `0.001` | **Solana 钱包路径**上的同一个数字，网关的报价不一样。API Key 按 token 计费，两个都不看。 |

### 把 compaction 的开销降下来

Harness 会通过「总结」来压缩长会话，而它用的是**当前对话正在用的那个模型**。挂在旗舰模型上，就意味着一次次用旗舰输入价来做总结，而且是整个会话反复做。

一次约 10 万 token 的 compaction，**Claude Opus 5 上大约 $0.90**，**DeepSeek V4 Flash 上大约 $0.026**——这是在该规模下读实时 402 报价得到的，与上面的表格一致。总结本来就是便宜模型干得很好的活，而且这类调用和你的对话**不共享前缀**——挪走不损失任何缓存命中：

```yaml
- id: blockrun-llm
  config:
    auxiliaryModel: deepseek/deepseek-chat
```

默认关闭，且只影响 Harness 自己标记为维护性质的调用（compaction、会话标题）。**对话请求永远不会被改道。**

`blockrun-review`（审查闸门）：

| 配置 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `false` | 是否自动拦截工具调用 |
| `reviewerProvider` | `blockrun` | 审查模型所在的路由 |
| `reviewerModel` | `anthropic/claude-opus-5` | 要选一个和智能体**不同且更强**的模型 |
| `timeoutMs` | `30000` | 单次审查的时间上限 |
| `reviewerMaxTokens` | `512` | 单次审查请求的输出上限；用不用得到都要付钱 |
| `onReviewerFailure` | `ask` | `ask` 交给你；`deny` 直接拒绝（无人值守） |
| `extraRules` | `[]` | 追加的 `{name, pattern, tools}` 风险规则 |

装上这条路由**不会**改变你的默认模型。`dsh-base` 依然是 `deepseek-official`，只有你显式指定时才会走这条路由。

## 几句实话

- **这不会让 DeepSeek 变便宜。** 每次请求按它自己的 402 报价计费——小请求 $0.002，随输入规模上涨——而且 BlockRun 不计入 DeepSeek 的缓存命中折扣。一次缓存命中的智能体轮次，直连 DeepSeek 约 $0.000056，走这里在 22K 输入时约 $0.007。主循环请继续直连 DeepSeek，这个插件只用来做 DeepSeek 做不了的事。
- **免费额度只能用来验证插件通不通，不能当主力。** 目前有 <!-- br:models.free -->7<!-- /br:models.free --> 个免费模型，而它们之所以免费，是因为有别人的条款在替你买单：其中的 NVIDIA 条目可能会把提示词用于服务改进，别拿它们对着私有代码库跑，更不要用它们当审查模型。这一层的更替也非常快——2026-08-30 当天 NVIDIA 一次性下线了 5 个免费模型里的 4 个，替补当天就补上了。本路由是实时读取名单的，所以不需要在这里发版就能跟上；但你上周指定的某个免费模型，这周可能根本就不在了。
- **免费模型可能由另一个模型来回答，而 `/spend` 会告诉你。** 网关在免费层后面挂了一条 fallback 级联，而且**替换时不会报错**。实测：对 `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`（免费层唯一的视觉模型）的每一次请求都由别的模型应答；而对 `nvidia/nemotron-3-ultra-550b`（列表里最大的免费模型）每三次就有一次由一个 30B 回答。其中一个顶替者 `nvidia/nemotron-3-super-120b` **根本不在公开 catalog 里**。从 0.10.4 起，本路由会读取每个 chunk 的 `model` 字段，并在 `/spend` 里把实际应答的模型列在你所请求的那一行下面——是补充说明，不是取代。这只是**如实报告**，不是拦截：那个回复是真实的，也会照常送达。已向上游反馈：BlockRunAI/blockrun#450。
- **每次审查都是一次模型调用**，只在命中风险规则时触发，上限 30 秒。
- **审查模型只看到被标记的那一次工具调用**，不会看到整个仓库。

## 已知限制

- **只有实测不接受图片的模型才会拒绝图片**——`visionModels` 是真正对着一张图答对了的集合，光有 `vision` 标签不够：有好几个带标签的模型会先收钱再失败。目前排除 6 个，见第 5 节。（这一条以前写的是「图片会被明确拒绝，视觉能力在计划中」，旁边还有一条说推理档位同样被拒绝。两个能力都在 0.10.0 就发布了，而这两条说明又活了三个版本——而且恰恰活在读者专门用来查「什么不能用」的那一节里。）
- **中断请求会立刻停止投递，但底层 HTTP 请求本身还取消不了**——要等 `@blockrun/llm` 支持 `AbortSignal`，目前连接会在 SDK 自己的超时后关闭。
- **本插件不保存持久的消费记录。** `/spend` 只活在进程的生命周期里。Harness 的会话日志会拒绝它不认识的事件类型，而仓库外的插件无法把自己的事件标记为可忽略，所以它不写任何会话事件。它也不会写进 `~/.blockrun/cost_log.jsonl`：那个账本是 `@blockrun/llm` 的 `LLMClient` 写的，而本适配器用的流式客户端只在内存里累计。用 API Key 时持久记录在 BlockRun 那边——每次调用都会落到 [`/dashboard/activity`](https://user.blockrun.ai/dashboard/activity) 背后的账户账本，带 request id、模型、token 数和金额。用钱包时，钱包余额本身就是那份记录。
- **插件这一侧读不到余额，也读不到用量。** `api.blockrun.ai` 对外只有 `/v1/chat/completions`、`/v1/messages` 和模型目录；`/v1/usage`、`/v1/balance` 这类端点都是 `404`。所以 `/spend` 没法显示你的剩余额度，账户余额耗尽只会在下一次调用时以指向充值页面的 `PAYMENT_REQUIRED` 暴露出来，不会提前预警。
- **Solana 需要两个可选 peer 依赖。** `@solana/web3.js` 和 `@solana/spl-token` 是**可选** peer 而不是普通依赖，因为 `@solana/spl-token` 会拉进 `bigint-buffer`，它的原生 `toBigIntLE()` 有一个至今没有修复版本的缓冲区溢出。设成可选，是为了不让每一个用 API Key 或只用 Base 的部署都在 lockfile 里背上它。走 Solana 请自行安装；没装就发 Solana 请求会直接报错并点名这两个包。
- **响应里的 `model` 字段不一定等于你请求的那个 id，也不一定是被顶替了。** OpenAI 系的模型会回显厂商带版本号的 id——请求 `openai/gpt-5.5` 回来的是 `gpt-5.5-2026-04-23`，`anthropic/claude-sonnet-4-6` 回来的是 `anthropic/claude-sonnet-4.6`。`/spend` 的「被顶替」那一行会把它当成换了模型。这只是显示问题，而且早于 API Key 这条路径——两台主机上实测一致——但确实会让这行提示在没有发生任何顶替时也出现。
- **智能路由（`blockrun/auto`）尚未接入**，缺的不是路由器。虚拟模型必须报告**一个**上下文窗口，而 Harness 用它来决定何时压缩：报最大的，某一轮路由到小模型时会直接溢出且压缩永不触发；报最小的，所有会话都会过早压缩。在这个问题有诚实答案之前，请直接指定模型 id —— `auxiliaryModel` 已经把真正花钱的维护调用挪走了，省钱的部分本来就在那里。
- **压缩可能比需要的时机更早触发。** 本路由报告的是网关模型目录里声明的上下文窗口。对着真实网关实测：`openai/gpt-4.1-nano` 接受了 **450,037** token 的输入，并正确复述了第一行的标记——没有截断，但这是目录声明的 128,000 的 3.5 倍。Harness 是按声明值来决定何时压缩的，所以会话可能在模型其实还吃得下的时候就压缩了。已向上游反馈；本插件如实报告目录的值而不是往高了猜——猜高了就是拿「提前压缩」换「静默溢出」。
- **上下文溢出是靠请求大小判定的，不是靠错误文案。** 真实溢出从网关返回的是 `{"message":"API request failed"}`——厂商原始文案被清洗掉了，常规的文本检测器什么都匹配不到。所以在收到 400 之后，如果请求本身已经超过该模型声明的窗口，就按溢出处理，好让压缩能够恢复。文本检测器仍然优先，所以网关哪天不再清洗，这里会自动回到正轨。
- **上一轮的 reasoning 不会回传。** DeepSeek 的思考模式文档要求在带 tool call 的轮次回传 `reasoning_content`，但这一条路由要服务 <!-- br:models.chatVisible -->75<!-- /br:models.chatVisible --> 个来自不同厂商的模型——某一家要求的字段，另一家可能直接拒绝。所以推理模型配合多步工具调用时效果可能略有下降，遇到了请反馈。

## 开发

```sh
npm test          # 离线测试，含走真实 cordis Loader 的组合测试
npm run test:e2e  # 真实网关测试，三套互相独立、绝不互相顶替：
                  # Base 钱包（花真实 USDC，约 $0.02）、Solana 钱包（SOLANA_WALLET_KEY
                  # 或 ~/.blockrun/.solana-session）、账户主机（BLOCKRUN_API_KEY）。
                  # 各自缺凭据就各自跳过。
npm run sync:models  # 从实时 catalog 刷新两份 README 里的模型数量和免费模型数
npm run probe:vision # 实测哪些带 vision 标签的模型真的能接受图片；直接打印可粘贴的名单
npm run test:docker  # 在干净容器里安装**已发布**的包，验证它能组装起来
```

用**本地 link** 开发时（`dsh plugin add /path/to/dsh-clawrouter`），本包的 **devDependencies** 会被带进 profile，于是出现两份 `@deepseek-ai/dsh-llm`。跨这两份做 `instanceof LlmError` 会失败，harness 就会把所有失败都显示成 `UNKNOWN`，而不是真实错误码。要验证错误码，请用 `npm pack` 出来的 tarball 安装，而不是 link。

只有这几套 live 测试会真正走一遍 x402 握手（签名本身就是认证，任何 mock 都替代不了），而且 Solana 是另一条曲线上的另一种签名，Base 那套证明的东西一点都带不过去。也只有它们能证明 API Key 确实打到了账户主机、并且是按账户开票的口径计费的。它被刻意排除在 `npm test` 之外，不会被误跑。

## 更新日志

见 [CHANGELOG.md](https://github.com/BlockRunAI/dsh-clawrouter/blob/main/CHANGELOG.md)。早期几个版本修的都是不报错的静默 bug，用着旧版本的话建议升级。

## 许可证

[MIT](../LICENSE)
