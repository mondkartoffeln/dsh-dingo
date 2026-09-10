import { describe, expect, it } from 'vitest'
import { autoNameSession } from '../src/auto-name.ts'

interface FakeLlm {
  listModels?: (provider: string) => Promise<readonly { id?: string }[]>
  stream: (options: unknown) => AsyncIterable<{ type: string; text?: string }>
}

function fakeCtx(overrides: {
  history?: () => unknown
  rename?: () => unknown
  noSessions?: boolean
  llm?: FakeLlm
} = {}) {
  return {
    get: (name: string) => (name === 'llm' ? overrides.llm : undefined),
    apiProxy: overrides.noSessions ? undefined : {
      sessions: {
        history: overrides.history ?? (async () => ({
          result: {
            ok: true,
            value: {
              events: [
                { event: { type: 'user/message', data: { content: '帮我优化一下这个项目的构建流程' } } },
                { event: { type: 'assistant/message', data: { message: { content: '好的，我来分析构建脚本。' } } } },
              ],
            },
          },
        })),
        rename: overrides.rename ?? (async (request: { payload: { title: string } }) => ({
          result: { ok: true, value: { title: request.payload.title, seq: 1 } },
        })),
      },
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

describe('autoNameSession', () => {
  it('从最近 user 消息生成标题并调用 rename', async () => {
    let renamed = ''
    const ctx = fakeCtx({
      rename: async (request: { payload: { title: string } }) => {
        renamed = request.payload.title
        return { result: { ok: true, value: { title: request.payload.title, seq: 1 } } }
      },
    }) as never
    const result = await autoNameSession(ctx as never, 'sess-1')
    expect(result.ok).toBe(true)
    expect(result.title).toBe('帮我优化一下这个项目的构建流程')
    expect(renamed).toBe('帮我优化一下这个项目的构建流程')
  })

  it('缺少 apiProxy.sessions 时返回失败', async () => {
    const ctx = fakeCtx({ noSessions: true }) as never
    const result = await autoNameSession(ctx as never, 'sess-1')
    expect(result.ok).toBe(false)
  })

  it('rename 失败时返回失败且保持原名', async () => {
    const ctx = fakeCtx({
      rename: async () => ({ result: { ok: false, error: { message: 'title-invalid' } } }),
    }) as never
    const result = await autoNameSession(ctx as never, 'sess-1')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('title-invalid')
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
    expect(result.title).toBe('帮我优化一下这个项目的构建流程')
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

    expect(result.title).toBe('帮我优化一下这个项目的构建流程')
  })
})
