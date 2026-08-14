<div align="center">

<h1>dsh-clawrouter</h1>

<p>给 DeepSeek Harness 智能体配一个「第二大脑」。<br>
DeepSeek 又快又便宜，主循环就该继续用它。<br><br>
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

它只会**收紧**，不会放宽。审查通过的调用，依然要经过你已有的沙箱、权限和审批。它不替代权限系统，只是站在权限系统前面。

在 profile 的 `cordis.patch.yml` 里启用：

```yaml
- id: blockrun-review
  config:
    enabled: true
    reviewerModel: anthropic/claude-opus-5
```

**哪些会被审查。** 刻意做得很窄——一个动不动就报警的闸门，最后一定会被关掉，那就等于没有保护。读取、编辑、构建从不触发。内置规则只盯：递归删除、裸写磁盘、fork 炸弹、`curl … | sh`、强制推送与 hard reset、`chmod 777`、`sudo`，以及碰 `~/.ssh`、`~/.aws`、`/etc/passwd` 的操作。

**提到一条命令不等于执行它**——`grep -rn "rm -rf" docs/` 不会被拦；**写下一条命令同样不等于执行它**——包含 `rm -rf build` 的 Makefile、清理脚本、引用了 `git reset --hard` 的 README，都是再正常不过的工作。文件正文类参数（`content`、`new_string`、`diff` 等）一律当作数据看待：文件里的命令真正生效是在有人去执行它的时候，而那一次执行是另一个调用，本闸门照样会读。可以加自己的规则：

```yaml
    extraRules:
      - name: no-prod-deploy
        pattern: "deploy\\s+--env[= ]prod"
```

**审查模型不可用时**，默认交给你处理（`onReviewerFailure: ask`）。它绝不会默默放行——失效即放行的安全闸门比没有更糟；也不会因为一次网络抖动就把会话卡死。无人值守的自动化可以改成 `deny`。

### 2. `/review`

```
/review <粘贴 diff、方案，或者智能体给出的结论>
```

用同一个强模型审你指定的内容。有用户[反馈过](https://github.com/deepseek-ai/deepseek-harness/discussions/475)这种情况：智能体其实已经读到了关键证据，却先下了错误结论，直到被人追问才发现真正的 bug。

### 3. 一个钱包，<!-- br:models.chatVisible -->70<!-- /br:models.chatVisible --> 个模型

注册一条 `blockrun` provider 路由。认证方式是**钱包签名**而不是 API Key：每次请求通过 x402 用 USDC 按次付费。不注册、不 KYC、不绑卡、不用给每家厂商都开一个账号。

这一点在 DeepSeek 覆盖不到的模型上最有价值——Claude、GPT、Gemini、Grok，而这恰恰是「审查」需要的。

## 快速开始

```sh
dsh plugin --profile web add dsh-clawrouter
export BASE_CHAIN_WALLET_KEY=0x...   # 也可以存进 credentials 服务
```

Base 链上 5 美元的 USDC 够跑几千次调用。配置里写的是**引用**（`walletKeyEnv`）而不是密钥本身，并且每次请求实时解析——换密钥下一次调用即生效，任何密钥都不会进入配置文件。

## 配置项

`blockrun-llm`（provider 路由）：

| 配置 | 默认值 | 含义 |
|---|---|---|
| `provider` | `blockrun` | 注册的路由名 |
| `walletKeyEnv` | `BASE_CHAIN_WALLET_KEY` | 存放 EVM 钱包私钥的凭据**引用** |
| `apiUrl` | `https://blockrun.ai/api` | API 根地址 |
| `timeoutMs` | `300000` | 单次请求超时 |

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
- **没有花费投影（spend projection）。** Harness 的会话日志会拒绝它不认识的事件类型，而仓库外的插件无法把自己的事件标记为可忽略——所以本插件不写任何会话事件。实际结算金额在 `~/.blockrun/cost_log.jsonl`。
- **智能路由（`blockrun/auto`）尚未接入**，目前请直接指定模型 id。
- **上一轮的 reasoning 不会回传。** DeepSeek 的思考模式文档要求在带 tool call 的轮次回传 `reasoning_content`，但这一条路由要服务 <!-- br:models.chatVisible -->70<!-- /br:models.chatVisible --> 个来自不同厂商的模型——某一家要求的字段，另一家可能直接拒绝。所以推理模型配合多步工具调用时效果可能略有下降，遇到了请反馈。

## 开发

```sh
npm test          # 68 个离线测试，含两套走真实 cordis Loader 的组合测试
npm run test:e2e  # 真实网关测试——会花掉真实 USDC（约 $0.02）；没有钱包时自动跳过
```

只有这套 live 测试会真正走一遍 x402 握手：签名本身就是认证，任何 mock 都替代不了。它被刻意排除在 `npm test` 之外，不会被误跑。

## 许可证

[MIT](../LICENSE)
