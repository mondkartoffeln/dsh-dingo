/**
 * dsh-dingo — 活跃会话循环切换的纯逻辑。
 *
 * 刻意独立成一个**无 React / 无 DOM** 的模块：快捷键那段最容易出错的是下标数学
 * （回绕、只有 1 个、当前会话不在列表里），放在这里就能用单测钉死。
 *
 * @module dsh-dingo/client/cycle
 */

/**
 * 计算下一个活跃会话在有序卡片列表中的下标（循环，含首尾回绕）。
 *
 * @param length - 活跃会话数量（卡片数）。
 * @param currentIndex - 当前会话在列表中的下标；不在列表里传 -1。
 * @param step - `+1` 下一个，`-1` 上一个。
 * @returns 目标下标；列表为空时返回 `-1`。
 *
 * @example
 * nextSessionIndex(3, 2, 1)  // 0  —— 末尾回绕到开头
 * nextSessionIndex(3, 0, -1) // 2  —— 开头回绕到末尾
 * nextSessionIndex(2, -1, 1) // 0  —— 当前会话不在列表里
 * nextSessionIndex(1, 0, 1)  // 0  —— 只有一个活跃会话
 */
export function nextSessionIndex(length: number, currentIndex: number, step: number): number {
  if (!Number.isFinite(length) || length <= 0) return -1
  if (currentIndex < 0) return step > 0 ? 0 : length - 1
  return (currentIndex + step + length) % length
}
