import { describe, expect, it } from 'vitest'
import { nextSessionIndex } from '../src/client/cycle.ts'

describe('nextSessionIndex（活跃会话循环切换）', () => {
  it('列表为空 → -1（快捷键应静默无动作）', () => {
    expect(nextSessionIndex(0, -1, 1)).toBe(-1)
    expect(nextSessionIndex(0, 0, -1)).toBe(-1)
  })

  it('当前会话不在列表里：往下取第一个，往上取最后一个', () => {
    expect(nextSessionIndex(3, -1, 1)).toBe(0)
    expect(nextSessionIndex(3, -1, -1)).toBe(2)
  })

  it('往下到末尾时回绕到开头', () => {
    expect(nextSessionIndex(3, 2, 1)).toBe(0)
  })

  it('往上到开头时回绕到末尾', () => {
    expect(nextSessionIndex(3, 0, -1)).toBe(2)
  })

  it('中间位置正常前后移动', () => {
    expect(nextSessionIndex(4, 1, 1)).toBe(2)
    expect(nextSessionIndex(4, 1, -1)).toBe(0)
  })

  it('只有一个活跃会话时停在原地（不会算出越界下标）', () => {
    expect(nextSessionIndex(1, 0, 1)).toBe(0)
    expect(nextSessionIndex(1, 0, -1)).toBe(0)
  })

  it('结果永远落在 [0, length) 内', () => {
    for (const length of [1, 2, 3, 7]) {
      for (let current = -1; current < length; current++) {
        for (const step of [1, -1]) {
          const index = nextSessionIndex(length, current, step)
          expect(index).toBeGreaterThanOrEqual(0)
          expect(index).toBeLessThan(length)
        }
      }
    }
  })

  it('连按 N 次正好绕回起点（循环一致性）', () => {
    const length = 4
    let index = 0
    for (let i = 0; i < length; i++) index = nextSessionIndex(length, index, 1)
    expect(index).toBe(0)
  })
})
