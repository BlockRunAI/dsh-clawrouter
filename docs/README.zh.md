<div align="center">

<img src="https://raw.githubusercontent.com/BlockRunAI/dsh-clawrouter/main/assets/banner.png" alt="dsh-clawrouter — review the dangerous command, before it runs" width="600">

<h1>给 DeepSeek Harness 智能体配一个「第二大脑」</h1>

<p>DeepSeek 又快又便宜，主循环就该继续用它。<br><br>
<strong>这个插件补的是它做不到的事：危险命令执行前，让更强的模型先审一遍。</strong><br><br>
<em>一个钱包直调 <!-- br:models.chatVisible -->70<!-- /br:models.chatVisible --> 个模型。不注册账号，不用 API Key，不用信用卡。</em></p>

<br>

<img src="https://img.shields.io/badge/🛡️_执行前审查-success?style=for-the-badge" alt="执行前审查">&nbsp;
<img src="https://img.shields.io/badge/🧠_Claude_审_DeepSeek-black?style=for-the-badge" alt="Claude 审 DeepSeek">&nbsp;
<img src="https://img.shields.io/badge/🔑_零_API_Key-blue?style=for-the-badge" alt="零 API Key">&nbsp;
<img src="https://img.shields.io/badge/💰_x402_USDC-purple?style=for-the-badge" alt="x402 USDC">

[![npm version](https://img.shields.io/npm/v/dsh-clawrouter.svg?style=flat-square&color=cb3837)](https://npmjs.com/package/dsh-clawrouter)
[![npm downloads](https://img.shields.io/npm/dm/dsh-clawrouter.svg?style=flat-square&color=blue)](https://npmjs.com/package/dsh-clawrouter)
[![GitHub stars](https://img.shields.io/github/stars/BlockRunAI/dsh-clawrouter?style=flat-square&label=GitHub%20stars)](https://github.com/BlockRunAI/dsh-clawrouter)
[![CI](https://img.shields.io/github/actions/workflow/status/BlockRunAI/dsh-clawrouter/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/BlockRunAI/dsh-clawrouter/actions)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](../LICENSE)

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek-Harness_插件-4D6BFE?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![x402 Protocol](https://img.shields.io/badge/x402-微支付-purple?style=flat-square)](https://x402.org)
[![Base](https://img.shields.io/badge/Base-USDC-0052FF?style=flat-square&logo=coinbase&logoColor=white)](https://base.org)
[![Telegram](https://img.shields.io/badge/Telegram-社区-26A5E4?style=flat-square&logo=telegram)](https://t.me/blockrunAI)

[English](../README.md) | 中文

</div>

> **dsh-clawrouter** 是一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，把一个更强的模型放在智能体危险操作的前面。当智能体准备执行 `rm -rf ~`，审查模型会读一遍并给出放行 / 拒绝 / 交给你——由真实的工具执行器强制执行，而不是靠提示词劝阻。它同时注册一条 BlockRun provider 路由，让审查模型（以及全部 <!-- br:models.chatVisible -->70<!-- /br:models.chatVisible --> 个模型）都能用一个钱包直接调用：不注册账号、不用 API Key，通过 [x402](https://x402.org) 用 USDC 按次付费。MIT 许可。

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

**审查模型不可用时**，默认交给你处理（`onReviewerFailure: ask`）。它绝不会默默放行——失效即放行的安全闸门比没有更糟；也不会因为一次网络抖动就把会话卡死。无人值守的自动化可以改成 `deny`。

### 2. `/spend`

```
/spend
```

本进程启动以来这条路由花了多少钱——总额、分模型、token 成本与固定费用分开列。

**这条路由按「次」计费，不按 token 计费。** 对着真实钱包实测：3 次调用（`max_tokens=24`）花 $0.006，3 次（`max_tokens=4096`）同样花 $0.006，而 1 次**生成了 8,000 个 token** 的调用只花 $0.002 —— 每次调用的价格完全一样。链上结算的是签名后的 402 报价，**与模型之后生成了多少无关**。

所以 `/spend` 报的是 `调用次数 × 单价`，token 数只作为参考显示，**绝不换算成金额**。那次 8,000 token 的调用，如果按 token 算是 $0.004243 —— 比真实扣费高了一倍多。

单次价格在约 1000 输入 token 以内是固定的，超过之后会**同时随上下文和模型增长**。以下是从网关自己的 402 报价实测得到（读报价不花钱）：

| 模型 | 小请求 | ~22K 输入 | ~112K 输入 |
|---|---|---|---|
| `openai/gpt-4.1-nano` | $0.002 | $0.005 | $0.023 |
| `deepseek/deepseek-chat` | $0.002 | $0.007 | $0.031 |
| `google/gemini-3.5-flash` | $0.002 | $0.066 | $0.325 |
| `anthropic/claude-opus-5` | $0.002 | $0.217 | **$1.081** |

**起点都是 $0.002，然后分化出 30 多倍的差距。** 一个持有 10 万 token 上下文的编程智能体，用 DeepSeek 每次调用约是下限的 **15 倍**，用 Opus 则是 **500 倍**。所以当平均调用带着大上下文时，`/spend` 会明确提示，并让你去看**自己所用模型**的价格，而不是记住某一个数字。它同样看不到「付了钱但失败」的请求。钱包余额才是权威。

`requestFeeUsd` 默认 `0.002`，因为这是网关真实报的价：约 17 token 的请求，402 返回 `{"amount":"0.002000"}`。BlockRun 目前公开的价格页写的是 $0.001。

### 3. `/review`

```
/review <粘贴 diff、方案，或者智能体给出的结论>
```

用同一个强模型审你指定的内容。有用户[反馈过](https://github.com/deepseek-ai/deepseek-harness/discussions/475)这种情况：智能体其实已经读到了关键证据，却先下了错误结论，直到被人追问才发现真正的 bug。

### 4. 一个钱包，<!-- br:models.chatVisible -->70<!-- /br:models.chatVisible --> 个模型

注册一条 `blockrun` provider 路由。认证方式是**钱包签名**而不是 API Key：每次请求通过 x402 用 USDC 按次付费。不注册、不 KYC、不绑卡、不用给每家厂商都开一个账号。

这一点在 DeepSeek 覆盖不到的模型上最有价值——Claude、GPT、Gemini、Grok，而这恰恰是「审查」需要的。

## 快速开始

```sh
dsh plugin --profile web add dsh-clawrouter
export BASE_CHAIN_WALLET_KEY=0x...   # 也可以存进 credentials 服务
```

**这个 key 从哪来？** 没有 API key 可粘贴——认证方式就是钱包签名。

- **用过 BlockRun 的其他工具？** 那你已经有钱包了。SDK 存在 `~/.blockrun/.session`，ClawRouter 存在 `~/.openclaw/blockrun/wallet.key`。哪个存在就导出哪个：`export BASE_CHAIN_WALLET_KEY=$(cat ~/.blockrun/.session)`
- **还没有钱包？** `npx -y @blockrun/clawrouter` 会生成一个并打印地址。记下地址后停掉它，往这个地址转几美元 USDC（Base 链），然后导出私钥。

本插件**不会自己去读**这两个文件。一个「用户没配置过、却悄悄盖住了他真正配置的那个」的凭据，正是 harness 凭据机制要防的事——所以它只读你指定的那个引用。

Base 链上 5 美元的 USDC 够跑几千次调用。配置里写的是**引用**（`walletKeyEnv`）而不是密钥本身，并且每次请求实时解析——换密钥下一次调用即生效，任何密钥都不会进入配置文件。

## 配置项

`blockrun-llm`（provider 路由）：

| 配置 | 默认值 | 含义 |
|---|---|---|
| `provider` | `blockrun` | 注册的路由名 |
| `walletKeyEnv` | `BASE_CHAIN_WALLET_KEY` | 存放 EVM 钱包私钥的凭据**引用** |
| `apiUrl` | `https://blockrun.ai/api` | API 根地址 |
| `timeoutMs` | `300000` | 单次请求超时 |
| `auxiliaryModel` | *(关闭)* | Harness 自身维护调用所用的模型——见下 |
| `requestFeeUsd` | `0.002` | 每次请求的固定费用，`/spend` 会用到——取网关实际报价，见下 |

### 把 compaction 的开销降下来

Harness 会通过「总结」来压缩长会话，而它用的是**当前对话正在用的那个模型**。挂在旗舰模型上，就意味着一次次用旗舰输入价来做总结，而且是整个会话反复做。

一次约 10 万 token 的 compaction，**Claude Opus 5 上大约 $0.50**，**DeepSeek V4 Flash 上大约 $0.014**。总结本来就是便宜模型干得很好的活，而且这类调用和你的对话**不共享前缀**——挪走不损失任何缓存命中：

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
| `onReviewerFailure` | `ask` | `ask` 交给你；`deny` 直接拒绝（无人值守） |
| `extraRules` | `[]` | 追加的 `{name, pattern, tools}` 风险规则 |

装上这条路由**不会**改变你的默认模型。`dsh-base` 依然是 `deepseek-official`，只有你显式指定时才会走这条路由。

## 几句实话

- **这不会让 DeepSeek 变便宜。** 对话按厂商原价计费，外加每次请求 $0.001 的固定费用，而且 BlockRun 目前不计入 DeepSeek 的缓存命中折扣——所以把主循环挂到这上面反而**更贵**。主循环请继续直连 DeepSeek，这个插件只用来做 DeepSeek 做不了的事。
- **免费额度只能用来验证插件通不通，不能当主力。** 免费的 NVIDIA 模型可能会把提示词用于服务改进，别拿它对着私有代码库跑，更不要用它当审查模型。
- **每次审查都是一次模型调用**，只在命中风险规则时触发，上限 30 秒。
- **审查模型只看到被标记的那一次工具调用**，不会看到整个仓库。

## 已知限制

- **图片会被明确拒绝，而不是被悄悄丢掉**——走这条路由发送图片内容会以 `UNSUPPORTED` 失败；视觉能力在计划中。
- **推理档位（reasoning effort）同样是明确拒绝**，不会被静默忽略。
- **中断请求会立刻停止投递，但底层 HTTP 请求本身还取消不了**——要等 `@blockrun/llm` 支持 `AbortSignal`，目前连接会在 SDK 自己的超时后关闭。
- **本插件不记录自己花了多少钱。** Harness 的会话日志会拒绝它不认识的事件类型，而仓库外的插件无法把自己的事件标记为可忽略，所以它不写任何会话事件。它也不会写进 `~/.blockrun/cost_log.jsonl`：那个账本是 `@blockrun/llm` 的 `LLMClient` 写的，而本适配器用的流式客户端只在内存里累计。目前请直接看钱包余额——这条说明的早先版本指向了那个账本，那会让你看到的是**其他工具**的花费，而不是本插件的。
- **智能路由（`blockrun/auto`）尚未接入**，缺的不是路由器。虚拟模型必须报告**一个**上下文窗口，而 Harness 用它来决定何时压缩：报最大的，某一轮路由到小模型时会直接溢出且压缩永不触发；报最小的，所有会话都会过早压缩。在这个问题有诚实答案之前，请直接指定模型 id —— `auxiliaryModel` 已经把真正花钱的维护调用挪走了，省钱的部分本来就在那里。
- **压缩可能比需要的时机更早触发。** 本路由报告的是网关模型目录里声明的上下文窗口。对着真实网关实测：`openai/gpt-4.1-nano` 接受了 **450,037** token 的输入，并正确复述了第一行的标记——没有截断，但这是目录声明的 128,000 的 3.5 倍。Harness 是按声明值来决定何时压缩的，所以会话可能在模型其实还吃得下的时候就压缩了。已向上游反馈；本插件如实报告目录的值而不是往高了猜——猜高了就是拿「提前压缩」换「静默溢出」。
- **上下文溢出是靠请求大小判定的，不是靠错误文案。** 真实溢出从网关返回的是 `{"message":"API request failed"}`——厂商原始文案被清洗掉了，常规的文本检测器什么都匹配不到。所以在收到 400 之后，如果请求本身已经超过该模型声明的窗口，就按溢出处理，好让压缩能够恢复。文本检测器仍然优先，所以网关哪天不再清洗，这里会自动回到正轨。
- **上一轮的 reasoning 不会回传。** DeepSeek 的思考模式文档要求在带 tool call 的轮次回传 `reasoning_content`，但这一条路由要服务 <!-- br:models.chatVisible -->70<!-- /br:models.chatVisible --> 个来自不同厂商的模型——某一家要求的字段，另一家可能直接拒绝。所以推理模型配合多步工具调用时效果可能略有下降，遇到了请反馈。

## 开发

```sh
npm test          # 181 个离线测试，含两套走真实 cordis Loader 的组合测试
npm run test:e2e  # 真实网关测试——会花掉真实 USDC（约 $0.02）；没有钱包时自动跳过
```

用**本地 link** 开发时（`dsh plugin add /path/to/dsh-clawrouter`），本包的 **devDependencies** 会被带进 profile，于是出现两份 `@deepseek-ai/dsh-llm`。跨这两份做 `instanceof LlmError` 会失败，harness 就会把所有失败都显示成 `UNKNOWN`，而不是真实错误码。要验证错误码，请用 `npm pack` 出来的 tarball 安装，而不是 link。

只有这套 live 测试会真正走一遍 x402 握手：签名本身就是认证，任何 mock 都替代不了。它被刻意排除在 `npm test` 之外，不会被误跑。

## 更新日志

见 [CHANGELOG.md](https://github.com/BlockRunAI/dsh-clawrouter/blob/main/CHANGELOG.md)。早期几个版本修的都是不报错的静默 bug，用着旧版本的话建议升级。

## 许可证

[MIT](../LICENSE)
