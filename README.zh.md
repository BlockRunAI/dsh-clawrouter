# dsh-clawrouter

[English](README.md) | 中文

**给 DeepSeek Harness 智能体配一个"第二大脑"。**

DeepSeek 又快又便宜，主循环就该继续用它。这个插件补的是它做不到的事：在危险命令执行之前，让一个更强的模型先审一遍；以及用一个钱包直接调用 70 个模型——不用注册账号，不用 API Key，不用信用卡。

```sh
dsh plugin --profile web add dsh-clawrouter
```

---

## 为什么做这个

社区里反复出现的两件事：

> 「是否有类似 Codex 或者 CC 的审查模式？即额外调用模型审查指令，以解放双手？Full Access 还是太让人担心了。」

> 「使用 Full Access 模式创建并测试插件时误删了我的整个家目录」

`Full Access` 是全有或全无：要么每条命令都手动批准，要么什么都不批直接赌一把。这个插件提供第三种选择——**让另一个更强的模型，在危险命令执行前先看一眼。**

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
- update:
    - id: blockrun-review
      config:
        enabled: true
        reviewerModel: anthropic/claude-opus-5
```

**哪些会被审查。** 刻意做得很窄——一个动不动就报警的闸门，最后一定会被关掉，那就等于没有保护。普通的读取、编辑、构建从不触发。内置规则只盯：递归删除、裸写磁盘、fork 炸弹、`curl … | sh`、强制推送与 hard reset、`chmod 777`、`sudo`，以及碰 `~/.ssh`、`~/.aws`、`/etc/passwd` 的操作。

**提到一条命令不等于执行它**——`grep -rn "rm -rf" docs/` 不会被拦。可以用 `extraRules` 加自己的规则：

```yaml
        extraRules:
          - name: no-prod-deploy
            pattern: "deploy\\s+--env[= ]prod"
```

**审查模型不可用时**，默认交给你处理（`onReviewerFailure: ask`）。它绝不会默默放行——一个失效即放行的安全闸门比没有更糟；也不会因为一次网络抖动就把会话卡死。无人值守的自动化可以改成 `deny`。

### 2. `/review`

```
/review <粘贴 diff、方案，或者智能体给出的结论>
```

用同一个强模型审你指定的内容。有用户反馈过这种情况：智能体其实已经读到了关键证据，却先下了错误结论，直到被人追问才发现真正的 bug——这个命令就是干这个的。

### 3. 一个钱包，70 个模型

注册一条 `blockrun` provider 路由。认证方式是**钱包签名**而不是 API Key：每次请求通过 [x402](https://x402.org) 用 USDC 按次付费。不注册、不 KYC、不绑卡、不用给每家厂商都开一个账号。

这一点在 DeepSeek 覆盖不到的模型上最有价值——Claude、GPT、Gemini、Grok 以及视觉模型，而这恰恰是"审查"和"第二意见"需要的。

## 安装

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
| `reviewerModel` | `anthropic/claude-opus-5` | 审查模型——要选一个和智能体**不同且更强**的模型 |
| `timeoutMs` | `30000` | 单次审查的时间上限 |
| `onReviewerFailure` | `ask` | `ask` 交给你；`deny` 直接拒绝（适合无人值守） |
| `extraRules` | `[]` | 追加的 `{name, pattern, tools}` 风险规则 |

装上这条路由**不会**改变你的默认模型。`dsh-base` 依然是 `deepseek-official`，只有你显式指定时才会走这条路由。

## 几句实话

- **这不会让 DeepSeek 变便宜。** 对话按厂商原价计费，外加每次请求 $0.001 的固定费用，而且 BlockRun 目前不计入 DeepSeek 的缓存命中折扣——所以把主循环挂到这上面反而**更贵**。主循环请继续直连 DeepSeek，这个插件只用来做 DeepSeek 做不了的事。
- **免费额度只能用来验证插件通不通，不能当主力。** 免费的 NVIDIA 模型可能会把提示词用于服务改进，所以别拿它对着私有代码库跑，更不要用它当审查模型。
- **每次审查都是一次模型调用**，只在命中风险规则时触发，上限 30 秒。
- **审查模型只看到被标记的那一次工具调用**，不会看到整个仓库。

## 已知限制

- **图片会被明确拒绝，而不是被悄悄丢掉**——走这条路由发送图片内容会以 `UNSUPPORTED` 失败；视觉能力在计划中。
- **推理档位（reasoning effort）同样是明确拒绝**，不会被静默忽略。
- **中断请求会立刻停止投递，但底层 HTTP 请求本身还取消不了**——要等 `@blockrun/llm` 支持 `AbortSignal`，目前连接会在 SDK 自己的超时后关闭。
- **没有花费投影（spend projection）。** Harness 的会话日志会拒绝它不认识的事件类型，而仓库外的插件无法把自己的事件标记为可忽略——所以本插件不写任何会话事件。实际结算金额在 `~/.blockrun/cost_log.jsonl`。
- **智能路由（`blockrun/auto`）尚未接入**，目前请直接指定模型 id。

## 许可证

MIT
