/**
 * `/dingo` RPC 通道：client ↔ host，JSON POST，loopback 权威。
 *
 * | endpoint | 用途 |
 * |----------|------|
 * | feedback | 插播队列快照 / 关闭 / 重播 / 播完上报 / 打断 / 上报当前会话 |
 * | set-current-session | 客户端上报"当前查看的对话"（当/当当 判定用） |
 * | set-visibility | 客户端上报"DSH Web UI 前台可见性"（决定是否发系统通知） |
 * | auto-name | 对话自动命名（header 按钮 / agent 指令共用） |
 *
 * 跳转说明：卡片点击跳转改由 client 侧 `sessions.open` 直接完成（与侧边栏
 * 点击同一入口），host 端不再需要 /dingo.switch 解析工作区（已移除）。
 *
 * @module dsh-dingo/rpc
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ChannelAuthority } from './types.ts';
import type { FeedbackEngine, FeedbackSnapshot } from './feedback.ts';
import { autoNameSession } from './auto-name.ts';

/** RPC 校验/业务错误。 */
export class RpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/** `/dingo` RPC 通道依赖。 */
export interface DingoRpcDeps {
  /** 插播反馈引擎（提醒队列/提示音/卡片数据源）。 */
  readonly feedback: FeedbackEngine;
  /** 设置"当前查看会话"（客户端上报；广播/引擎 own 判定用）。 */
  readonly setCurrentSessionId?: (id: string | undefined) => void;
  /** 上报"DSH Web UI 是否前台可见"（决定是否发系统通知）。 */
  readonly setWebVisible?: (visible: boolean) => void;
}

/**
 * 注册 `/dingo` RPC 通道（可逆 effect；unload 时自动卸载）。
 *
 * ⚠️ 必须用 **`ctx.inject(['connection', 'webServer'], cb)`** 的作用域注入，
 * 不能直接 `ctx.connection.rpc.handle(...)`，也不能只把 `connection` 放进插件顶层
 * `inject`：`handle()` 内部是
 * `owner.effect(() => owner.webServer.register(route))`（见 dsh-client-connection
 * 的 `register`），即它要求**读该服务作用域**同时持有 `connection` 和 `webServer`，
 * 否则抛 `cannot get property "webServer" without inject`。
 * 这正是 DSH 自己在 `dsh-api-gateway` 里的写法（`ctx.inject(["connection","webServer"], …)`）。
 *
 * 作用域注入还有个好处：两个服务缺失时（例如 headless profile）**回调不执行**，
 * RPC 通道静默不注册，而不是让整个 profile 启动失败。
 */
/**
 * `/dingo` 通道的请求信封（与 dsh-client-connection 的 createWebConnectionRpc 对齐）。
 * 客户端 `rpc.call('/dingo', endpoint, payload)` 实际发的是
 * `POST /dingo/<endpoint>`，body 为 `{type:'client-request', rpcId, method, payload}`，
 * 期望拿到 `{type:'server-response', rpcId, result}`。
 */
interface DingoRpcRequestEnvelope {
  readonly type?: unknown;
  readonly rpcId?: unknown;
  readonly method?: unknown;
  readonly payload?: unknown;
}

/** 业务分发：与传输无关，便于单测。 */
async function dispatchDingoEndpoint(
  ctx: Context,
  deps: DingoRpcDeps,
  endpoint: string,
  payload: unknown,
): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string; details: Record<string, unknown> } }> {
  switch (endpoint) {
    case 'feedback': {
      return handleFeedbackEndpoint(deps.feedback, payload);
    }
    case 'set-current-session': {
      // 客户端上报"当前查看的对话"：当前对话回复 → 当/当当（crisp 档），
      // 其他对话 → 另一声音（soft 档"叮"）+ 卡片；own 判定也用它。
      const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
      const sid = typeof record.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : undefined;
      deps.setCurrentSessionId?.(sid);
      return { ok: true, value: { current: sid ?? null } };
    }
    case 'set-visibility': {
      // 客户端上报 DSH Web UI 前台可见性：可见时浏览器内提醒已够，
      // 不发系统通知；不可见/未开 → 发系统通知。
      const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
      deps.setWebVisible?.(record.visible === true);
      return { ok: true, value: { visible: record.visible === true } };
    }
    case 'auto-name': {
      // 2.0 对话自动命名：header 按钮 / agent 自然语言指令共用同一 host 服务。
      const record = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
      const sid = typeof record.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : undefined;
      if (!sid) {
        return { ok: false, error: { code: 'internal', message: 'sessionId 必填', details: {} } };
      }
      const result = await autoNameSession(ctx, sid);
      if (!result.ok) {
        return { ok: false, error: { code: 'internal', message: result.error ?? 'auto-name failed', details: {} } };
      }
      return { ok: true, value: { title: result.title } };
    }
    default:
      return {
        ok: false,
        error: { code: 'internal', message: `unknown /dingo endpoint: ${endpoint}`, details: {} },
      };
  }
}

/** 有界地读完请求体。 */
function readRequestBody(req: import('node:http').IncomingMessage, limitBytes = 1 << 20): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 严格判断一个 hostname 是否落在 127.0.0.0/8 内。
 *
 * 必须逐段校验，不能用 `/^127\./` 这类前缀匹配：攻击者可以注册
 * `127.0.0.1.evil.com` 这样的域名，前缀匹配会放行它，而那正是 DNS rebinding
 * 的经典绕过形态（隔离实例实测：前缀匹配下该 Host 返回 200，应 403）。
 * @param hostname - 已小写、已去掉端口的 hostname。
 * @returns 是否是合法的回环 IPv4 字面量。
 */
function isLoopbackIpv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  if (parts[0] !== '127') return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

/**
 * 判断请求方是否是本机（loopback）权威。
 *
 * `rpc.handle` 原本会替调用方做这层 authority 校验（`channelAuthority` 配置：
 * loopback / trusted-host），但既然它在 0.1.5 里坏了、我们改成自己注册路由，
 * 就必须把这层校验补回来，否则 `POST /dingo/*` 会对任何能访问到端口的来源开放。
 *
 * 同时检查两件事：
 * 1. `Host` 头的 hostname 是回环字面量（`127.0.0.0/8`、`::1`、`localhost`）——
 *    挡 DNS rebinding（外部域名解析到本机时 Host 仍是那个域名）。
 * 2. TCP 对端地址本身是回环——挡"用 127.0.0.1 当 Host 头的外部请求"。
 *
 * 逃生舱：`DSH_DINGO_TRUSTED_HOSTS`（逗号分隔）额外放行 Host（用于把端口暴露到
 * LAN 并配了 `trustedHosts` 的部署，对应 `channelAuthority: 'trusted-host'`）。
 * 注意逃生舱**只放行 Host 头**，仍然要求对端是回环——要真正开放到 LAN，
 * 这层检查需要相应放宽，那是部署方的显式决定。
 * @param req - 入站请求。
 * @returns 是否放行该请求。
 */
function isLoopbackAuthority(req: import('node:http').IncomingMessage): boolean {
  const rawHost = req.headers.host;
  if (typeof rawHost !== 'string' || rawHost.length === 0) return false;
  // 去掉端口：IPv6 字面量形如 `[::1]:3080`，其余形如 `host:port`。
  const closing = rawHost.indexOf(']');
  const withoutPort = rawHost.startsWith('[')
    ? rawHost.slice(1, closing === -1 ? rawHost.length : closing)
    : rawHost.slice(0, rawHost.includes(':') ? rawHost.indexOf(':') : rawHost.length);
  const hostname = withoutPort.toLowerCase();
  const extra = (process.env.DSH_DINGO_TRUSTED_HOSTS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  const hostAllowed =
    hostname === 'localhost' || hostname === '::1' || hostname === '0:0:0:0:0:0:0:1' || isLoopbackIpv4(hostname) || extra.includes(hostname);
  if (!hostAllowed) return false;
  const remote = req.socket?.remoteAddress ?? '';
  if (remote === '') return false;
  return remote === '::1' || remote === '0:0:0:0:0:0:0:1' || isLoopbackIpv4(remote.replace(/^::ffff:/, ''));
}

/**
 * 注册 `/dingo` RPC 通道（可逆 effect；unload 时自动卸载）。
 *
 * ⚠️ 这里**不用 `connection.rpc.handle()`**。0.1.5 里它是坏的：
 * `register()` 内部取 `owner = this.ctx`（= connection 插件 `apply` 的上下文，其
 * `inject` 只有 `["credentials"]`），随后 `owner.webServer.register(route)` 直接抛
 * `cannot get property "webServer" without inject`（dsh-client-connection/lib/index.js
 * :541-543 / :602-618）。该异常被 effect 吞掉，于是通道**静默注册失败**，请求落到
 * `dsh-host-frontend-static` 的 fallback，表现为 `POST /dingo/<endpoint>` → **405**。
 * （已在隔离实例实测复现。）
 *
 * 改为在自己的作用域里直接 `webServer.register`，并手写同一套信封协议：
 * 客户端发 `{type:'client-request', rpcId, method, payload}`，我们回
 * `{type:'server-response', rpcId, result}`（见 dsh-client-connection/lib/client.js
 * :6197-6232 的 createWebConnectionRpc / parseConnectionResponse）。
 * 因为绕过了 `rpc.handle`，authority 校验由本文件的 `isLoopbackAuthority` 补齐。
 *
 * 作用域注入仍然保留：`connection` / `webServer` 缺失时（headless profile）回调不执行，
 * 通道静默不注册，而不是让整个 profile 启动失败。
 */
export function installDingoRpc(ctx: Context, deps: DingoRpcDeps, authority: ChannelAuthority): void {
  ctx.inject(['connection', 'webServer'], (rpcCtx: Context) => {
    const handleRequest = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> => {
      const sendJson = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
      };
      const sendResult = (rpcId: unknown, result: unknown): void => {
        sendJson(200, { type: 'server-response', rpcId, result });
      };
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      // authority 校验（补 `rpc.handle` 原本那一层）。放在最前：未通过时不解析
      // 请求体，也不泄露任何业务信息。
      if (!isLoopbackAuthority(req)) {
        res.writeHead(403).end();
        return;
      }
      let envelope: DingoRpcRequestEnvelope;
      try {
        const raw = await readRequestBody(req);
        envelope = (raw.length === 0 ? {} : JSON.parse(raw)) as DingoRpcRequestEnvelope;
      } catch (error) {
        sendResult(undefined, { ok: false, error: { code: 'bad-request', message: `请求体解析失败：${error instanceof Error ? error.message : String(error)}`, details: {} } });
        return;
      }
      const rpcId = envelope.rpcId;
      if (envelope.type !== 'client-request' || typeof rpcId !== 'string' || typeof envelope.method !== 'string') {
        sendResult(rpcId, { ok: false, error: { code: 'bad-request', message: '非法 RPC 信封', details: {} } });
        return;
      }
      // method 与路径末段一致（channel 'dingo' → method 'feedback'）。
      const endpoint = envelope.method.split('/').pop() ?? envelope.method;
      try {
        const result = await dispatchDingoEndpoint(ctx, deps, endpoint, envelope.payload);
        sendResult(rpcId, result);
      } catch (error) {
        sendResult(rpcId, { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} } });
      }
    };
    // `webServer` 的类型没有被 cordis 的 Context 声明合并（dsh-host-webserver 未导出
    // 该 merge），运行时却是可用的（隔离实例已实测 webServer/connection/rpc 三者均在）。
    const webCtx = rpcCtx as unknown as {
      webServer: {
        register(route: {
          kind: 'prefix';
          path: string;
          handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>;
        }): () => void;
      };
    };
    rpcCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: '/dingo', handler: handleRequest }),
      'dsh-dingo: /dingo channel',
    );
  });
}


/* ──────────────────────────────────────────────────────────────────────
 * /dingo.feedback（提醒队列客户端通道）
 * ────────────────────────────────────────────────────────────────────── */

/** `/dingo.feedback` 请求。 */
export interface FeedbackRpcRequest {
  readonly action:
    | 'announcements'
    | 'dismiss'
    | 'replay'
    | 'spoken'
    | 'interrupt'
    | 'set-active-session'
    | 'dismiss-card'
    | 'mark-seen';
  readonly id?: string;
  readonly sessionId?: string;
}

/** 处理 `/dingo.feedback`（引擎已存在）。 */
function handleFeedbackEndpoint(engine: FeedbackEngine, payload: unknown): { ok: true; value: unknown } {
  const request = validateFeedbackPayload(payload);
  switch (request.action) {
    case 'announcements': {
      const snapshot: FeedbackSnapshot = engine.snapshot();
      return { ok: true, value: snapshot };
    }
    case 'dismiss':
      return { ok: true, value: { ok: engine.dismiss(request.id ?? '') } };
    case 'replay':
      return { ok: true, value: { ok: engine.replay(request.id ?? '') } };
    case 'spoken':
      // 客户端播完上报 → 引擎播下一条
      engine.completeSpeech(request.id);
      return { ok: true, value: { ok: true } };
    case 'interrupt':
      // 用户打断 → 停止当前插播，队列保留
      engine.interruptCurrent();
      return { ok: true, value: { ok: true } };
    case 'set-active-session':
      engine.setActiveSession(request.sessionId);
      return { ok: true, value: { ok: true } };
    case 'dismiss-card':
      // 2.0 × 关闭：仅移除本次卡片
      return { ok: true, value: { ok: engine.dismissCard(request.sessionId) } };
    case 'mark-seen':
      // 2.0 点击结论态卡片：已看过 → 正常
      return { ok: true, value: { ok: engine.markSeen(request.sessionId) } };
  }
}

/** 校验 `/dingo.feedback` 请求形状。 */
function validateFeedbackPayload(payload: unknown): FeedbackRpcRequest {
  if (typeof payload !== 'object' || payload === null) {
    throw new RpcError('bad-request', 'feedback 请求必须是对象');
  }
  const record = payload as Record<string, unknown>;
  const action = record.action;
  const known = new Set<FeedbackRpcRequest['action']>(['announcements', 'dismiss', 'replay', 'spoken', 'interrupt', 'set-active-session', 'dismiss-card', 'mark-seen']);
  if (typeof action !== 'string' || !known.has(action as FeedbackRpcRequest['action'])) {
    throw new RpcError('bad-request', `action 非法：${String(action)}（支持 announcements/dismiss/replay/spoken/interrupt/set-active-session/dismiss-card/mark-seen）`);
  }
  if (record.id !== undefined && typeof record.id !== 'string') {
    throw new RpcError('bad-request', 'id 必须是字符串');
  }
  if (record.sessionId !== undefined && typeof record.sessionId !== 'string') {
    throw new RpcError('bad-request', 'sessionId 必须是字符串');
  }
  return {
    action: action as FeedbackRpcRequest['action'],
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
  };
}

