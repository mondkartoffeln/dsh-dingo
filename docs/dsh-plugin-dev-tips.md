# DSH Plugin 开发技巧与踩坑总结

> 适用项目：dsh-dingo（以及其他 DSH Cordis 插件）
> 目的：把多次开发中遇到的问题沉淀下来，避免重复踩坑。

## 1. Cordis 服务访问：`ctx.xxx` 必须声明 `inject`，可选服务用 `ctx.get()`

### 问题现象

直接访问某个服务属性，启动时报错：

```
Error: cannot get property "tools" without inject
    at installRenameTool ...
```

### 原因

Cordis 的 `ctx` 是代理对象。插件 `apply(ctx)` 里直接访问 `ctx.tools`、`ctx.connection`、`ctx.apiProxy` 等，**必须先在插件的 `inject` 数组里声明**，否则 Cordis 不允许直接读取。

### 正确做法

| 场景 | 做法 |
|---|---|
| 该服务是插件必需依赖 | 在 `export const inject = ['connection', 'apiProxy', ...]` 里声明，然后直接 `ctx.connection` |
| 该服务是可选/可能不存在 | 用 `ctx.get('tools')` 获取，拿不到就 `undefined`，安全跳过 |
| 不确定是否存在 | 优先 `ctx.get()`，不要直接 `ctx.xxx` |

示例：

```ts
// 错误：没有在 inject 声明 tools，直接访问会崩
const tools = ctx.tools

// 正确：可选服务用 ctx.get
const tools = ctx.get('tools')
if (!tools?.register) return
```

### 容易踩到的服务

- `tools`：工具注册服务（`dsh-base` 必有）
- `commands`：斜杠命令服务
- `sessions`：活动会话 store（`ctx.sessions.get(id)` → 活动 `Session`）
- `sessionTitle`：标题服务（`rename(session, title)` / `get(session)`，均**同步**）
- `workspaceRegistry`：工作区清单（`list()`，同步）
- `llm`：LLM 服务
- `connection` / `webServer`：**仅 web profile** 存在，且必须一起用（见 §1.1）
- ~~`apiProxy`~~：**新版 DSH 已移除**（改为 api-gateway / api-remotes /
  api-session-controller）。2026-09 因它遗留在 `inject` 里导致 web profile 无法启动。

### 1.1 `inject` 是硬等待：声明错了整个 profile 起不来（2026-09 真实事故）

**症状**：启动直接失败，插件根本没跑起来：

```
Error: dsh: plugin tree failed to load: dsh: 1 entry did not activate
dsh-dingo: pending (waiting for service: apiProxy)
```

**原因**：Cordis 的 `inject` 不是"尽量等"，而是**硬等待**。任何一个名字在宿主里
不存在，该插件的 fiber 就永远是 INACTIVE，而 boot 阶段的 `assertEntriesActivated`
会因此判定**整个 profile 加载失败**。它不会告诉你"这个服务不存在"，只报 pending。

**正确做法**（三种，按需选）：

| 场景 | 做法 |
|---|---|
| 服务在所有目标 profile 都有 | 放进顶层 `inject` |
| 服务可能缺失，且缺失时该功能应静默跳过 | `ctx.get('svc')` 惰性取，判空降级 |
| **服务就绪后还要读它**（尤其要读多个） | `ctx.inject(['a','b'], (scoped) => { scoped.effect(...) })` |
| **只该在 web 里生效的功能** | 用作用域注入，别放顶层 `inject` |

**作用域注入**是 `dsh-api-gateway` 的标准姿势：

```ts
ctx.inject(['connection', 'webServer'], (rpcCtx) => {
  rpcCtx.effect(() => rpcCtx.connection.rpc.handle('/dingo', handler, { authority }), 'label')
})
```

**为什么 `/dingo` RPC 必须两个一起注入**：`connection.rpc.handle()` 内部是
`owner.effect(() => owner.webServer.register(route))`（见 `dsh-client-connection`
的 `register`）。也就是说它会在**读该服务的那个作用域**上访问 `webServer`——
只把 `connection` 放进顶层 `inject` 会报：

```
cannot get property "webServer" without inject
```

**另一个坑：默认参数会在 install 阶段求值。**

```ts
// 错误：apply 一执行就崩（即使函数体没被调用）
function resolver(ctx: Context, api: unknown = (ctx as any).apiProxy) { ... }

// 正确：把读取挪进返回的函数体，运行期再取
function resolver(ctx: Context) {
  return async (id: string) => {
    const svc = ctx.get('workspaceRegistry')   // 惰性、可判空
    ...
  }
}
```

## 2. Host 侧读写会话：用 sessions / sessionTitle / workspaceRegistry

新版 DSH **没有** `ctx.apiProxy`。宿主侧直接调服务（都是本进程调用，不需要 RPC）：

```ts
// 1) sessionId → 活动 Session（同步；未加载则为 undefined）
const session = ctx.get('sessions')?.get(sessionId)

// 2) 读最近用户消息（同步、冻结快照）
const events = session.snapshotEvents()
for (const e of events) {
  if (e.type !== 'user/message') continue
  if (e.data.source?.kind !== 'user') continue   // 跳过插件注入的上下文
  const text = e.data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
}

// 3) 重命名（同步；返回 { title, messageSeqs, source, eventSeq, updatedAt }）
ctx.get('sessionTitle')?.rename(session, title)

// 4) 工作区名（同步）
ctx.get('workspaceRegistry')?.list()   // [{ title, sessionIds, ... }]
```

要点：

- 事件信封是 `{ type, seq, time, data }`，**文本在 `event.data.content[i].text`**，
  不是 `event.message...`；
- `sessionTitle.rename` 要求传入的必须是**同一个活动 Session 实例**
  （内部 `ctx.sessions.get(session.id) !== session` 就抛错）；
- 标题规范化后为空会抛 `SessionTitleInvalidError`，**超长不报错、直接截断**
  （默认 `maxTitleBytes: 80` UTF-8 字节）；
- 显式重命名会**钉住**标题：自动标题生成被取代，之后不再自动改名。

### 历史坑（旧 apiProxy 时代，仅供查旧资料时对照）

旧版宿主侧是 `ctx.apiProxy`，且必须是 RPC 窄格式 `{ rpcId, payload: { ... } }`，
直接传业务对象会报 `Cannot destructure property 'sessionId' of 'request.payload'`。
**该服务在新版已整个移除**，新代码不要再照抄这一节。

## 3. 改完源码必须重新 build

### 问题现象

本地 DSH profile 通过 `link:/path/to/dsh-dingo` 指向仓库，但 DSH 加载的是 `lib/` 下的构建产物，不是 `src/`。

如果只改 `src/` 不执行 `npm run build`，重启 DSH 后跑的仍是旧代码。

### 正确流程

```bash
npm run verify
# 或至少
npm run build
```

然后重启 DSH。

## 4. Host 侧改动通常需要重启 DSH

- Client 前端（React 组件、样式）在开发模式下可能可以 HMR。
- Host 侧（RPC、服务注册、工具注册、事件订阅）属于插件生命周期，**结构变了必须重启 DSH**。
- 如果当前 shell 是 DSH 的子进程，不要在里面直接杀 DSH，否则会把自己的会话也杀掉；建议在外部终端重启。

## 5. 注册工具 / 命令 / 槽位时注意服务是否存在

### 工具

```ts
const tools = ctx.get('tools')
if (!tools?.register) return
ctx.effect(() => tools.register(tool), 'plugin: tool')
```

### 命令

```ts
const commands = ctx.get('commands')
if (!commands?.register) return
commands.register({ ... })
```

### 客户端槽位

- 使用 `ctx.slots.inject('slot.name', () => ctx.slots.register({ ... }, Component))`
- 槽位名必须与对应包的 SlotMap 声明匹配
- 类型导入用来加载 SlotMap 增强，不能省略

## 6. RPC 通道注意 authority

- `/dingo` 默认 `loopback` 只信任回环来源。
- 如果通过域名/远程访问，需要在 profile patch 里配置：

```yaml
- id: dsh-dingo
  config:
    channelAuthority: trusted-host
```

## 7. 新增 host 能力时，记得同步暴露给 agent

- 如果希望主 LLM 能调用某个能力，需要注册成 **tool**（`ctx.tools`），不是只加 RPC。
- 如果希望用户能用斜杠命令，需要注册成 **command**（`ctx.commands`）。
- 如果希望 UI 有入口，需要注册 **client slot**。

## 8. 测试与验证

- `npm run typecheck`
- `npm test`
- `npm run build`
- 涉及 RPC / 工具时，补对应单测
- 涉及 client 槽位时，至少保证 build 通过
- **改 `inject` / 服务访问后，务必做一次真实启动验证**（配置 dump 只验证组装、
  不验证激活，会漏掉 `cannot get property ... without inject` 这类运行时错误）。
  安全的做法是用**隔离的 `DSH_HOME` + 一个 web profile**（base + web-app + 本插件）
  起一次：

  ```powershell
  $env:DSH_HOME = "<临时目录>"; dsh --profile <测试profile> --port 0 --no-open
  ```
  `--port 0` 让 OS 选空闲端口，不会撞上正在跑的实例；起得来即说明
  `assertEntriesActivated` 通过。

## 9. 常见错误速查

| 错误 | 原因 | 解决 |
|---|---|---|
| `cannot get property "xxx" without inject` | 直接访问未 inject 的服务 | 惰性 `ctx.get('xxx')`，或 `ctx.inject(['xxx'], cb)` 作用域注入 |
| `... entry did not activate` / `pending (waiting for service: X)` | 顶层 `inject` 声明了宿主没有的服务（如已移除的 `apiProxy`） | 从顶层 `inject` 移除，改用 `ctx.get()` 或作用域注入 |
| `cannot get property "webServer" without inject` | `connection.rpc.handle()` 需要作用域同时持有 `connection` + `webServer` | `ctx.inject(['connection','webServer'], cb)` |
| `Cannot destructure property 'sessionId' of 'request.payload'` | 旧 apiProxy 时代的调用形状 | 新版已无 apiProxy；改用 `sessions` / `sessionTitle` 直调 |
| `session "..." is not live in this store` | `sessionTitle.rename` 收到的不是活动 Session 实例 | 用 `ctx.get('sessions').get(id)` 取同一个实例 |
| `session title must contain visible characters` | 标题规范化后为空 | 传入非空可见字符 |
| `unknown /dingo endpoint` | RPC endpoint 未注册 | 在 `installDingoRpc` 的 switch 里加 case |
| `failed to apply loader entry` | 插件 apply 阶段抛错 | 看堆栈第一个业务错误，通常是服务访问/类型问题 |
| 改了代码没生效 | DSH 加载的是 `lib/` | 先 `npm run build` 再重启 |
| 远程访问 RPC 403 | authority 仍是 loopback | profile patch 改为 `trusted-host` |
