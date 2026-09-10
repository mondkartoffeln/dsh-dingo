import { describe, expect, it } from 'vitest'
import { autoNameSession, renameSessionTitle } from '../src/auto-name.ts'

interface FakeLlm {
  listModels?: (provider: string) => Promise<readonly { id?: string }[]>
  stream: (options: unknown) => AsyncIterable<{ type: string; text?: string }>
}

/** 新形状：`user/message` 的 data 就是 UserMessage，content 是 ContentBlock[]。 */
const defaultEvents = [
  { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '帮我优化一下这个项目的构建流程' }] } },
  { type: 'assistant/message', data: { role: 'assistant', content: [{ type: 'text', text: '好的，我来分析构建脚本。' }] } },
]

const USER_TEXT = '帮我优化一下这个项目的构建流程'

function fakeCtx(overrides: {
  events?: readonly unknown[]
  rename?: (session: unknown, title: string) => { title: string }
  llm?: FakeLlm
  noSessions?: boolean
  missingSession?: boolean
  noSessionTitle?: boolean
} = {}) {
  const session = { id: 'sess-1', snapshotEvents: () => overrides.events ?? defaultEvents }
  return {
    get: (name: string) => {
      if (name === 'llm') return overrides.llm
      if (name === 'sessions') {
        if (overrides.noSessions) return undefined
        return { get: (id: string) => (overrides.missingSession || id !== 'sess-1' ? undefined : session) }
      }
      if (name === 'sessionTitle') {
        if (overrides.noSessionTitle) return undefined
        return {
          rename: overrides.rename ?? ((_session: unknown, title: string) => ({ title, eventSeq: 1 })),
        }
      }
      return undefined
    },
  }
}

/** 目录里只广告给定型号的假 LLM；记录每次 stream 的调用参数。 */
function recordingLlm(models: readonly string[], reply = '构建流程优化') {
  const calls: Array<Record<string, unknown>> = []
  const llm: FakeLlm = {
    listModels: async () => models.map((id) => ({ id })),
    stream: (options) => {
      calls.push(options as Record<string, unknown>)
      return (async function* stream() {
        yield { type: 'text-delta', text: reply }
      })()
    },
  }
  return { llm, calls }
}

/** 从一次 stream 调用参数里取出实际喂给模型的 prompt 文本。 */
function promptOf(call: Record<string, unknown> | undefined): string {
  const messages = call?.messages as Array<{ content?: Array<{ text?: string }> }> | undefined
  return messages?.[0]?.content?.[0]?.text ?? ''
}

describe('autoNameSession', () => {
  it('从最近 user 消息生成标题并经 sessionTitle 写入', async () => {
    let renamedTitle = ''
    const ctx = fakeCtx({
      rename: (_session, title) => {
        renamedTitle = title
        return { title }
      },
    }) as never
    const result = await autoNameSession(ctx as never, 'sess-1')
    expect(result.ok).toBe(true)
    expect(result.title).toBe(USER_TEXT)
    expect(renamedTitle).toBe(USER_TEXT)
  })

  it('缺少 sessions 服务时返回失败', async () => {
    const result = await autoNameSession(fakeCtx({ noSessions: true }) as never, 'sess-1')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('sessions')
  })

  it('会话未在宿主中加载时返回失败', async () => {
    const result = await autoNameSession(fakeCtx({ missingSession: true }) as never, 'sess-1')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('未在宿主中加载')
  })

  it('缺少 sessionTitle 服务时返回失败', async () => {
    const result = await autoNameSession(fakeCtx({ noSessionTitle: true }) as never, 'sess-1')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('session-title')
  })

  it('rename 抛错（如标题非法）时返回失败', async () => {
    const ctx = fakeCtx({
      rename: () => {
        throw new Error('session title must contain visible characters')
      },
    }) as never
    const result = await autoNameSession(ctx as never, 'sess-1')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('session title must contain visible characters')
  })
})

describe('renameSessionTitle', () => {
  it('返回 sessionTitle.rename 规范化后的标题', () => {
    const ctx = fakeCtx({ rename: () => ({ title: '规范化后的标题' }) }) as never
    const result = renameSessionTitle(ctx as never, 'sess-1', '  原始标题  ')
    expect(result).toEqual({ ok: true, title: '规范化后的标题' })
  })

  it('无 sessions 服务时给出可读错误', () => {
    const result = renameSessionTitle(fakeCtx({ noSessions: true }) as never, 'sess-1', '标题')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('未在宿主中加载')
  })

  it('无 sessionTitle 服务时给出可读错误', () => {
    const result = renameSessionTitle(fakeCtx({ noSessionTitle: true }) as never, 'sess-1', '标题')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('session-title')
  })
})

describe('用户消息文本抽取（新形状）', () => {
  it('拼接多个 text block，忽略 reasoning block', async () => {
    let renamedTitle = ''
    const ctx = fakeCtx({
      events: [
        {
          type: 'user/message',
          data: {
            role: 'user',
            content: [
              { type: 'reasoning', text: '这是思考过程，不应被当成用户输入' },
              { type: 'text', text: '第一段' },
              { type: 'text', text: '第二段' },
            ],
          },
        },
      ],
      rename: (_s, title) => {
        renamedTitle = title
        return { title }
      },
    }) as never
    await autoNameSession(ctx as never, 'sess-1')
    expect(renamedTitle).toBe('第一段 第二段')
  })

  it('兼容旧形状（data.message.content 为字符串）', async () => {
    let renamedTitle = ''
    const ctx = fakeCtx({
      events: [{ type: 'user/message', data: { message: { content: '旧的存档消息形状' } } }],
      rename: (_s, title) => {
        renamedTitle = title
        return { title }
      },
    }) as never
    await autoNameSession(ctx as never, 'sess-1')
    expect(renamedTitle).toBe('旧的存档消息形状')
  })

  it('只把最近 5 条用户消息喂给模型', async () => {
    const events = Array.from({ length: 7 }, (_v, index) => ({
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: `消息${index + 1}` }] },
    }))
    const { llm, calls } = recordingLlm(['deepseek-flash'], '标题')
    await autoNameSession(fakeCtx({ events, llm }) as never, 'sess-1')

    const prompt = promptOf(calls[0])
    for (const kept of ['消息3', '消息4', '消息5', '消息6', '消息7']) expect(prompt).toContain(kept)
    for (const dropped of ['消息1', '消息2']) expect(prompt).not.toContain(dropped)
  })
})

describe('autoNameSession 标题模型（DeepSeek-V4.1-Flash 适配）', () => {
  it('目录里有 V4.1-Flash 时用它，且带上 session-title purpose', async () => {
    const { llm, calls } = recordingLlm(['deepseek-flash', 'deepseek-v4-flash'])
    const result = await autoNameSession(fakeCtx({ llm }) as never, 'sess-1')

    expect(result.ok).toBe(true)
    expect(result.title).toBe('构建流程优化')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.provider).toBe('deepseek-official')
    expect(calls[0]?.model).toBe('deepseek-flash')
    // DeepSeek 适配器据此关闭思考，保证 60 token 预算不被推理吃掉
    expect(calls[0]?.purpose).toBe('session-title')
  })

  it('目录里没有 V4.1-Flash 时回退到 deepseek-v4-flash', async () => {
    const { llm, calls } = recordingLlm(['deepseek-v4-flash'])
    const result = await autoNameSession(fakeCtx({ llm }) as never, 'sess-1')

    expect(result.title).toBe('构建流程优化')
    expect(calls[0]?.model).toBe('deepseek-v4-flash')
  })

  it('显式配置的标题模型优先于内置偏好', async () => {
    const { llm, calls } = recordingLlm(['deepseek-flash', 'deepseek-v4-pro'])
    await autoNameSession(fakeCtx({ llm }) as never, 'sess-1', { model: 'deepseek-v4-pro' })

    expect(calls[0]?.model).toBe('deepseek-v4-pro')
  })

  it('候选型号都不在目录里时不发请求，退回规则标题', async () => {
    const { llm, calls } = recordingLlm(['some-other-model'])
    const result = await autoNameSession(fakeCtx({ llm }) as never, 'sess-1')

    expect(calls).toHaveLength(0)
    expect(result.title).toBe(USER_TEXT)
  })

  it('没有 listModels 能力的旧宿主仍按首选型号调用', async () => {
    const calls: Array<Record<string, unknown>> = []
    const llm: FakeLlm = {
      stream: (options) => {
        calls.push(options as Record<string, unknown>)
        return (async function* stream() {
          yield { type: 'text-delta', text: '构建流程优化' }
        })()
      },
    }
    const result = await autoNameSession(fakeCtx({ llm }) as never, 'sess-1')

    expect(result.title).toBe('构建流程优化')
    expect(calls[0]?.model).toBe('deepseek-flash')
  })

  it('去掉模型输出里的“标题：”前缀与包裹引号', async () => {
    const { llm } = recordingLlm(['deepseek-flash'], '标题：“构建流程优化”')
    const result = await autoNameSession(fakeCtx({ llm }) as never, 'sess-1')

    expect(result.title).toBe('构建流程优化')
  })

  it('模型输出不可用（索要消息）时退回规则标题', async () => {
    const { llm } = recordingLlm(['deepseek-flash'], '请提供更多消息')
    const result = await autoNameSession(fakeCtx({ llm }) as never, 'sess-1')

    expect(result.title).toBe(USER_TEXT)
  })
})
