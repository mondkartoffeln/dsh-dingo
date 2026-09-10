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

/** 会话历史/重命名 API 的最小形状（避免强耦合）。 */
interface SessionsApiLike {
  history(request: { rpcId: unknown; payload: { sessionId: string; maxMessages?: number } }): Promise<{
    result: {
      ok: boolean
      value?: { events?: readonly HistoryEntryLike[] }
      error?: { message?: string }
    }
  }>
  rename(request: { rpcId: unknown; payload: { sessionId: string; title: string } }): Promise<{
    result: {
      ok: boolean
      value?: { title: string }
      error?: { message?: string }
    }
  }>
}

interface HistoryEntryLike {
  event?: { type?: string; data?: Record<string, unknown>; [key: string]: unknown }
}

/**
 * 执行自动命名：读取最近消息 → 规则生成标题 → 写入 session.rename。
 * 返回新标题；失败时保持原名并返回错误信息。
 */
export async function autoNameSession(
  ctx: Context,
  sessionId: string,
  options?: AutoNameOptions,
): Promise<AutoNameResult> {
  const api = (ctx as unknown as { apiProxy?: { sessions?: SessionsApiLike } }).apiProxy
  if (!api?.sessions) {
    return { ok: false, error: '自动命名不可用：缺少 apiProxy.sessions' }
  }

  const rpcId = makeRpcId()
  const history = await api.sessions.history({ rpcId, payload: { sessionId, maxMessages: 50 } })
  if (!history.result.ok || !history.result.value) {
    return { ok: false, error: history.result.error?.message ?? '读取会话历史失败' }
  }

  const texts = extractRecentUserTexts(history.result.value.events ?? [])
  const target = await resolveTitleTarget(ctx, options)
  const title = (target ? await generateTitleWithLlm(target, texts) : undefined) ?? generateTitle(texts)
  if (!title) {
    return { ok: false, error: '未能从对话内容生成有效标题' }
  }

  const renamed = await api.sessions.rename({ rpcId, payload: { sessionId, title } })
  if (!renamed.result.ok) {
    return { ok: false, error: renamed.result.error?.message ?? '写入标题失败' }
  }

  return { ok: true, title: renamed.result.value?.title ?? title }
}

/** 从 history 事件中提取最近 user 纯文本（只取用户输入，省 token 且更代表意图）。 */
function extractRecentUserTexts(events: readonly HistoryEntryLike[]): string[] {
  const texts: string[] = []
  for (const entry of events) {
    const event = entry.event
    if (!event) continue
    if (event.type !== 'user/message') continue
    const data = event.data as { content?: unknown; message?: { content?: unknown } } | undefined
    // 兼容多种历史形状：
    // - dsh-session 新版：data.content 就是 UserMessage.content
    // - 旧形状：data.message.content / event.message.content
    // - 极端情况：data 本身就是字符串
    const content = (data && 'content' in data)
      ? data.content
      : data?.message?.content ?? (event as { message?: { content?: unknown } }).message?.content ?? (typeof data === 'string' ? data : undefined)
    const text = extractText(content)
    if (text) texts.push(text)
  }
  // 最近消息在尾部；只取最近 5 条用户消息，控制 token 成本。
  return texts.slice(-5)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractText(content: any): string {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text
          if (typeof part.content === 'string') return part.content
        }
        return ''
      })
      .filter(Boolean)
      .join(' ')
      .trim()
  }
  return ''
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

/** 生成一次宿主 RPC 调用 id。 */
function makeRpcId(): string {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
