/**
 * dsh-dingo — client half：会话卡片 Rail + 自动命名按钮 + 提示音播放。
 *
 * - 2.0 卡片 Rail 挂载到 `sidebar.footer.action`（侧边栏底部、设置上方；hero 页也可见）；
 * - 自动命名按钮挂载到会话头部操作行（`conversation.session.header.actions`，正 order）；
 * - 继续轮询 `/dingo.feedback` 消费声音层（speaking 提示音）与 1:1 卡片快照；
 * - 上报"当前查看的对话"（/dingo.set-current-session）。
 *
 * @module dsh-dingo/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// header actions 槽位由 dsh-client-ui-conversation 声明；sidebar foot 槽位由 dsh-client-ui-sidebar 声明；
// type-only 导入加载 SlotMap 增强
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { SessionCardRailCompact, type SessionCardRailCompactProps } from './SessionCardRailCompact.tsx'
import { AutoNameButton, type AutoNameButtonProps } from './AutoNameButton.tsx'
import { WorkspaceLabel, type WorkspaceLabelProps } from './WorkspaceLabel.tsx'
import { installDeepLink } from './deep-link.ts'

/** 客户端插件名（web server 按此 id 注册/卸载）。 */
export const name = 'dsh-dingo-client'

/** 客户端所需服务：槽位系统、文案命名空间、Connection（含 /dingo RPC）。 */
export const inject = ['slots', 'locale', 'connection'] as const

/** 客户端文案命名空间（无自定义文案时用内置）。 */
export const LOCALE_NS = 'dingo'

/**
 * 注册提醒卡片（shell.overlay 全局浮层）。
 * useSessions 由框架标准 props 注入（读取当前打开的对话）。
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  const rpc = connection.rpc
  // 会话跳转服务：卡片点击 / 系统通知深链 → 直接打开对应对话（与侧边栏点击同一入口）。
  //
  // ⚠️ 必须**惰性**取服务：`ctx.get()` 不等服务就绪，客户端插件的挂载顺序也没有保证。
  // 若在 apply 阶段读一次就存下来，会话服务晚挂载时会永久拿到 undefined，而调用点
  // 又被 `?.` + try/catch 兜着 → 点卡片「静默无反应」，且**深链整段装不上**。
  // （同源事故：host 侧把 `(ctx as any).apiProxy` 写成默认参数，加载即崩。）
  const getSessions = (): {
    open(id: string): void
    binding(id: string): { ctx: unknown } | undefined
  } | undefined => ctx.get('sessions') as {
    open(id: string): void
    binding(id: string): { ctx: unknown } | undefined
  } | undefined

  /**
   * 打开指定会话 —— 卡片点击与深链跳转的唯一入口。
   * 服务缺失或会话不在列表（已删除/归档/所属工作区未连接）时返回 false；
   * 不抛错：调用方是 UI 事件，失败不该炸掉渲染。
   */
  const openSessionById = (sessionId: string): boolean => {
    const sessions = getSessions()
    if (sessions === undefined) return false
    try {
      sessions.open(sessionId)
      return true
    } catch {
      return false
    }
  }

  // 会话输入服务：用于读取任意会话的未发送草稿（同样惰性解析）。
  const getDraftBySession = (sessionId: string): string => {
    try {
      const conversation = ctx.get('conversation') as {
        input: {
          for(actx: unknown): { state: { getSnapshot(): { draft: string } } }
          shell?(id: string): { state: { getSnapshot(): { draft: string } } }
        }
      } | undefined
      const input = conversation?.input.shell?.(sessionId) ?? conversation?.input.for((getSessions()?.binding(sessionId) as { ctx: unknown } | undefined)?.ctx as never)
      return input?.state.getSnapshot()?.draft ?? ''
    } catch {
      return ''
    }
  }

  // 系统通知深链：dingOpen 参数 + 标签页复用（已有 DSH 标签页接管跳转并聚焦）。
  // 无条件安装：目标服务在点击时才惰性解析，缺失也只是返回 false，不会崩。
  ctx.effect(() => installDeepLink({
    openSession: openSessionById,
    channel: typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('dsh-dingo-deeplink') : undefined,
    closeWindow: () => window.close(),
  }), 'dsh-dingo: deeplink')

  // 上报 DSH Web UI 前台可见性：host 据此决定是否发系统通知
  // （可见 → 浏览器内提醒已够；不可见/未开 → 系统通知）。
  // 注意：页面刚加载时 document.hasFocus() 可能为 false（初始上报误报不可见），
  // 之后窗口已聚焦但 focus 事件不重发 → host 一直以为不可见 → 当前对话也弹系统通知。
  // 修复：值变化才上报 + 3s 定时兜底，保证状态最终一致。
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    let last: boolean | undefined
    const report = (): void => {
      const visible = document.visibilityState === 'visible' && document.hasFocus()
      if (visible === last) return
      last = visible
      void rpc.call('/dingo', 'set-visibility', { visible }).catch(() => {})
    }
    report()
    document.addEventListener('visibilitychange', report)
    window.addEventListener('focus', report)
    window.addEventListener('blur', report)
    const timer = setInterval(report, 3000)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', report)
      window.removeEventListener('focus', report)
      window.removeEventListener('blur', report)
    }
  }, 'dsh-dingo: visibility report')

  // 2.0 卡片 Rail：全局会话雷达 → 侧边栏底部（设置上方；折叠 rail 时压成小图标）。
  ctx.effect(() => {
    return ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'dsh-dingo-card-rail',
      // 负 order 排在最先：wrap 后独占第一行，Cordis / remote-web-ui 换到下一行。
      order: -100,
      inject: () => ({
        rpc,
        getDraftBySession,
        // 卡片点击 → 直达对应会话（惰性解析 sessions，见 openSessionById）。
        openSession: openSessionById,
      }),
    }, SessionCardRailCompact as unknown as (props: SessionCardRailCompactProps) => JSX.Element))
  }, 'dsh-dingo: session card rail slot')

  // 2.0 当前工作区标签：放在标准操作之后、Rename 之前。
  ctx.effect(() => {
    return ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'dsh-dingo-workspace-label',
      order: 40,
    }, WorkspaceLabel as unknown as (props: WorkspaceLabelProps) => JSX.Element))
  }, 'dsh-dingo: workspace label slot')

  // 2.0 自动命名按钮：放在工作区标签之后、卡片 Rail 左侧。
  ctx.effect(() => {
    return ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'dsh-dingo-auto-name',
      order: 50,
      inject: () => ({ rpc }),
    }, AutoNameButton as unknown as (props: AutoNameButtonProps) => JSX.Element))
  }, 'dsh-dingo: auto name button slot')
}
