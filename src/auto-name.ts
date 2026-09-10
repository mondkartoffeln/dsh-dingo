/**
 * dsh-dingo 2.0 — 对话自动命名（host 侧）。
 *
 * 双入口（header 按钮 / agent 自然语言指令）最终都调用这里的 `autoNameSession`：
 * 读取近期用户消息（合并后喂给 LLM）→ 优先用 DeepSeek-V4.1-Flash 生成有区分度的标题，
 * 失败时规则回退 → `session.rename`。
 *
 * @module dsh-dingo/auto-name
 */
import type { Context } from '@deepseek-ai/cordis'

/** 自动命名结果。 */
export interface AutoNameResult {
  ok: boolean
  title?: string
  error?: string
}

/** 自动命名可调项（由插件配置注入）。 */
export interface AutoNameOptions {
  /** 标题模型供应商（默认 `deepseek-official`）。 */
  provider?: string
  /** 首选标题模型 id（默认 `deepseek-flash` = DeepSeek-V4.1-Flash）。 */
  model?: string
}

/** 宿主 `ctx.llm` 的最小形状（避免强耦合）。 */
interface LlmLike {
  stream(options: unknown): AsyncIterable<{ type: string; text?: string }>
  listModels?(provider: string): Promise<readonly { id?: string }[]>
}

/** 已解析出的标题生成目标：LLM 服务 + 目录里真实存在的 provider/model。 */
interface TitleTarget {
  llm: LlmLike
  provider: string
  model: string
}

/** 默认标题模型供应商。 */
const DEFAULT_TITLE_PROVIDER = 'deepseek-official'

/**
 * 标题模型偏好顺序：**DeepSeek-V4.1-Flash（`deepseek-flash`）优先**，
 * 再逐级回退到仍然可用的旧型号。硬编码单一型号会在宿主升级或下线型号后
 * 静默失效（标题悄悄退回规则版），所以这里按"目录里真实存在"来挑。
 */
const TITLE_MODEL_PREFERENCE: readonly string[] = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro']

/* ──────────────────────────────────────────────────────────────────────
 * 宿主服务的最小形状（避免强耦合）
 *
 * 新版 DSH 已移除 `ctx.apiProxy`：会话状态改由 `ctx.sessions`（`SessionStore`，
 * 由 `@deepseek-ai/dsh-session` 提供）暴露；重命名改由 `ctx.sessionTitle`
 * （`@deepseek-ai/dsh-session-title`）提供。两者都按**可选**服务用 `ctx.get()` 取，
 * 拿不到就返回可读错误，绝不放进插件 `inject`（否则整个 profile 起不来）。
 * ────────────────────────────────────────────────────────────────────── */

/** 宿主活动会话的最小形状（`@deepseek-ai/dsh-session` 的 `Session`）。 */
export interface SessionLike {
  readonly id: string
  snapshotEvents?(): readonly SessionEventLike[]
}

/** 会话事件信封；`user/message` 的 `data` 即 `UserMessage`。 */
export interface SessionEventLike {
  readonly type?: string
  readonly data?: unknown
}

/** 宿主 `ctx.sessions`（`SessionStore`）的最小形状。 */
interface SessionsStoreLike {
  get(id: string): SessionLike | undefined
}

/**
 * 宿主 `ctx.sessionTitle` 的最小形状。
 * `rename` 是**同步**的，返回折叠后的标题快照（`{ title, eventSeq }`）；
 * 标题规范化后为空时抛 `SessionTitleInvalidError`，会话不在 store 里时抛 `Error`。
 */
interface SessionTitleLike {
  rename(session: SessionLike, title: string): { title?: string } | undefined
}

/** 取宿主活动会话；无 `sessions` 服务或会话未加载时返回 `undefined`。 */
export function liveSession(ctx: Context, sessionId: string): SessionLike | undefined {
  const sessions = ctx.get('sessions') as SessionsStoreLike | undefined
  return sessions?.get?.(sessionId)
}

/**
 * 把标题写入会话——**唯一**的重命名入口（`/dingo rename`、header 按钮、
 * `rename_current_session` 工具共用）。
 *
 * 走宿主 `session-title` 服务而不是自己 append 事件：标题规范化、对自动标题的
 * 取代（supersede）、`session/title` 事件的写入都由它负责。
 */
export function renameSessionTitle(
  ctx: Context,
  sessionId: string,
  title: string,
): { ok: true; title: string } | { ok: false; error: string } {
  const session = liveSession(ctx, sessionId)
  if (session === undefined) {
    return { ok: false, error: `重命名不可用：会话 ${sessionId} 未在宿主中加载（或宿主无 sessions 服务）` }
  }
  const titles = ctx.get('sessionTitle') as SessionTitleLike | undefined
  if (typeof titles?.rename !== 'function') {
    return { ok: false, error: '重命名不可用：宿主未挂载 session-title 服务' }
  }
  try {
    const accepted = titles.rename(session, title)
    return { ok: true, title: accepted?.title ?? title }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 执行自动命名：读取最近用户消息 → LLM/规则生成标题 → 写入会话标题。
 * 返回新标题；失败时保持原名并返回错误信息。
 */
export async function autoNameSession(
  ctx: Context,
  sessionId: string,
  options?: AutoNameOptions,
): Promise<AutoNameResult> {
  const session = liveSession(ctx, sessionId)
  if (session === undefined) {
    return { ok: false, error: `自动命名不可用：会话 ${sessionId} 未在宿主中加载（或宿主无 sessions 服务）` }
  }

  const texts = extractRecentUserTexts(session.snapshotEvents?.() ?? [])
  const target = await resolveTitleTarget(ctx, options)
  const title = (target ? await generateTitleWithLlm(target, texts) : undefined) ?? generateTitle(texts)
  if (!title) {
    return { ok: false, error: '未能从对话内容生成有效标题' }
  }

  const renamed = renameSessionTitle(ctx, sessionId, title)
  if (!renamed.ok) return { ok: false, error: renamed.error }
  return { ok: true, title: renamed.title }
}

/** 从会话事件里提取最近 user 纯文本（只取用户输入，省 token 且更代表意图）。 */
function extractRecentUserTexts(events: readonly SessionEventLike[]): string[] {
  const texts: string[] = []
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    // 只取**真人输入**：`user/message` 也可能是插件注入的上下文（goal 轮次、
    // 附加文件等），那些的 `source.kind !== 'user'`，拿来当意图会污染标题。
    // （旧存档事件可能没有 source，此时保持宽松。）
    const source = (event.data as { source?: { kind?: string } } | undefined)?.source
    if (source?.kind !== undefined && source.kind !== 'user') continue
    const text = extractText(event.data)
    if (text) texts.push(text)
  }
  // 最近消息在尾部；只取最近 5 条用户消息，控制 token 成本。
  return texts.slice(-5)
}

/**
 * 从 `user/message` 事件的 `data` 取纯文本。
 *
 * 新形状：`data` 就是 `UserMessage`，`content` 是 `ContentBlock[]`
 * （可见文本块为 `{ type: 'text', text }`）。同时保留旧形状兜底
 * （`data` 是字符串 / `data.message.content`），兼容存档会话。
 */
function extractText(data: unknown): string {
  if (typeof data === 'string') return data.trim()
  if (!data || typeof data !== 'object') return ''
  const record = data as { content?: unknown; message?: { content?: unknown } }
  const content = 'content' in record ? record.content : record.message?.content
  return blocksToText(content)
}

/** 把 `content`（字符串或 `ContentBlock[]`）拼成纯文本；只取可见文本块，跳过 reasoning。 */
function blocksToText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object') {
        const block = part as { type?: string; text?: unknown; content?: unknown }
        if (typeof block.text === 'string' && (block.type === undefined || block.type === 'text')) return block.text
        if (typeof block.content === 'string') return block.content
      }
      return ''
    })
    .filter(Boolean)
    .join(' ')
    .trim()
}

/**
 * 解析本次标题生成要用的 provider/model。
 *
 * 型号按 {@link TITLE_MODEL_PREFERENCE} 挑第一个**在当前供应商目录里真实存在**的：
 * DeepSeek-V4.1-Flash（`deepseek-flash`）优先，其次回退到旧型号；候选全都不在目录里
 * 时返回 `undefined`，交给规则标题，而不是发一次注定失败的请求。
 *
 * 注：DeepSeek 适配器对 `purpose: 'session-title'` 会强制关闭思考
 * （见 dsh-llm-deepseek 的 `resolveThinking`），所以标题调用不会把 maxTokens
 * 耗在推理上，60 token 足够。
 */
async function resolveTitleTarget(ctx: Context, options?: AutoNameOptions): Promise<TitleTarget | undefined> {
  const llm = ctx.get('llm') as LlmLike | undefined
  if (typeof llm?.stream !== 'function') return undefined

  const provider = options?.provider?.trim() || DEFAULT_TITLE_PROVIDER
  const preferred: string[] = []
  for (const candidate of [options?.model, ...TITLE_MODEL_PREFERENCE]) {
    const id = candidate?.trim()
    if (id && !preferred.includes(id)) preferred.push(id)
  }
  const fallback: TitleTarget | undefined = preferred[0] ? { llm, provider, model: preferred[0] } : undefined

  // 拿不到目录（旧宿主无 listModels）→ 信任首选型号；调用失败自然走规则回退。
  if (typeof llm.listModels !== 'function') return fallback

  try {
    const catalog = await llm.listModels(provider)
    const available = new Set(
      catalog
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    )
    // 目录为空 = 供应商未暴露型号信息 → 仍按首选型号试一次。
    if (available.size === 0) return fallback
    const model = preferred.find((id) => available.has(id))
    return model ? { llm, provider, model } : undefined
  } catch {
    return fallback
  }
}

/**
 * 用解析出的标题模型生成标题。
 * 依赖宿主已装配 `ctx.llm`；生成失败或输出不可用时返回 undefined，由规则回退接管。
 */
async function generateTitleWithLlm(target: TitleTarget, texts: string[]): Promise<string | undefined> {
  if (texts.length === 0) return undefined

  const prompt = [
    '请根据以下最近 5 条用户消息，生成一个简洁、准确且有区分度的会话标题。',
    '要求：',
    '- 中文 6~20 字，或英文 3~12 词；',
    '- 标题要具体，尤其开头几个字要能和其他会话明显区分，避免都是“帮我/优化/请问”这类雷同前缀；',
    '- 只输出标题本身，不要解释、不要思考过程、不要引号。',
    '',
    '最近用户消息：',
    ...texts.slice(-5).map((text, index) => `${index + 1}. ${text}`),
  ].join('\n')

  try {
    let title = ''
    const stream = target.llm.stream({
      provider: target.provider,
      model: target.model,
      // 辅助调用专用 purpose：DeepSeek 侧据此关闭思考（省钱、省延迟、不占 token 预算）。
      purpose: 'session-title',
      temperature: 0.3,
      maxTokens: 60,
      messages: [
        { role: 'user', content: [{ type: 'text', text: prompt }] },
      ],
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        title += chunk.text
      }
    }
    const clean = normalizeTitle(title)
    // 拒绝模型“反问/索要消息/无法生成”等非标题输出，交给规则回退。
    if (!clean || clean.length > 60 || /请提供|请给我|请发送|需要你提供|无法生成|请先提供|请补充/.test(clean)) {
      return undefined
    }
    return clean
  } catch {
    return undefined
  }
}

/** 清理模型原始输出：先去掉“标题：”这类前缀，再剥掉包裹引号。 */
function normalizeTitle(raw: string): string {
  return raw
    .replace(/^\s*(标题|会话标题|title)\s*[:：]\s*/i, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim()
}

/** 规则回退标题：取第一条用户消息，截断到 20 字。 */
function generateTitle(texts: string[]): string | undefined {
  const clean = (value: string): string =>
    value
      .replace(/[#*_>`~]/g, '')
      .replace(/\s+/g, ' ')
      .trim()

  const userText = texts.find((text) => text.length > 0)
  if (!userText) return undefined
  const candidate = clean(userText)
  if (!candidate) return undefined
  return candidate.length <= 20 ? candidate : `${candidate.slice(0, 20)}…`
}
