import { describe, expect, it } from 'vitest'
import {
  ACTIVE_DOWNLOAD_STATES,
  DEFAULT_ZOOM_FACTOR,
  ZOOM_STEPS,
  canControlDownload,
  clampWarmStoreLimit,
  clampZoomFactor,
  downloadStateLabel,
  formatFindProgress,
  formatZoomPercent,
  isDownloadActiveState,
  isTerminalDownloadState,
  stepZoomFactor,
  warmStoreLimitLabel
} from '@shared/browser-tools'

describe('缩放档位', () => {
  it('脏值一律回落 100%，不把页面渲染成 0 倍', () => {
    for (const bad of [undefined, null, 'abc', NaN, 0, -1, Infinity]) {
      expect(clampZoomFactor(bad)).toBe(DEFAULT_ZOOM_FACTOR)
    }
  })

  it('吸附到最接近的档位，不是截断', () => {
    expect(clampZoomFactor(0.99)).toBe(1)
    expect(clampZoomFactor(0.72)).toBe(0.75)
    expect(clampZoomFactor(1.22)).toBe(1.25)
    expect(clampZoomFactor(1.9)).toBe(2)
  })

  it('逐格前进/后退，并在两端停住（不循环）', () => {
    expect(stepZoomFactor(1, 1)).toBe(1.1)
    expect(stepZoomFactor(1, -1)).toBe(0.9)
    expect(stepZoomFactor(ZOOM_STEPS[ZOOM_STEPS.length - 1], 1)).toBe(ZOOM_STEPS[ZOOM_STEPS.length - 1])
    expect(stepZoomFactor(ZOOM_STEPS[0], -1)).toBe(ZOOM_STEPS[0])
  })

  it('一段连续放大后再连续缩小能回到 100%', () => {
    let factor: number = DEFAULT_ZOOM_FACTOR
    for (let i = 0; i < 3; i++) factor = stepZoomFactor(factor, 1)
    expect(formatZoomPercent(factor)).toBe('150%')
    for (let i = 0; i < 3; i++) factor = stepZoomFactor(factor, -1)
    expect(factor).toBe(DEFAULT_ZOOM_FACTOR)
  })

  it('百分比文案按整数展示，不带浮点尾巴', () => {
    expect(formatZoomPercent(0.67)).toBe('67%')
    expect(formatZoomPercent(1)).toBe('100%')
    expect(formatZoomPercent(2)).toBe('200%')
  })
})

describe('下载状态口径', () => {
  it('暂停仍算进行中：不能因为暂停就释放页面/占用计数', () => {
    expect(ACTIVE_DOWNLOAD_STATES).toContain('paused')
    expect(isDownloadActiveState('paused')).toBe(true)
    expect(isTerminalDownloadState('paused')).toBe(false)
  })

  it('三个终态才允许回收 DownloadItem 引用', () => {
    for (const state of ['completed', 'cancelled', 'interrupted']) {
      expect(isTerminalDownloadState(state)).toBe(true)
      expect(isDownloadActiveState(state)).toBe(false)
    }
  })

  it('未知状态既不算进行中也不算终态（不猜、不误杀）', () => {
    expect(isDownloadActiveState('weird')).toBe(false)
    expect(isTerminalDownloadState('weird')).toBe(false)
  })

  it('只有进行中（含暂停）的下载才显示控制按钮', () => {
    expect(canControlDownload('progressing')).toBe(true)
    expect(canControlDownload('paused')).toBe(true)
    expect(canControlDownload('completed')).toBe(false)
    expect(canControlDownload('cancelled')).toBe(false)
  })

  it('文案如实：paused 是「已暂停」，不是「已完成」', () => {
    expect(downloadStateLabel('paused')).toBe('已暂停')
    expect(downloadStateLabel('completed')).toBe('已完成')
    expect(downloadStateLabel('interrupted')).toBe('中断')
    expect(downloadStateLabel('')).toBe('未知状态')
  })
})

describe('查找命中计数', () => {
  it('没命中统一 0/0', () => {
    expect(formatFindProgress(0, 0)).toBe('0/0')
    expect(formatFindProgress(undefined, undefined)).toBe('0/0')
    expect(formatFindProgress(-1, 2)).toBe('0/0')
  })

  it('有命中时展示 当前/总数', () => {
    expect(formatFindProgress(12, 3)).toBe('3/12')
    expect(formatFindProgress(12, 0)).toBe('0/12')
  })
})

describe('多店保活档位', () => {
  it('clamp 到 1–4：越界与脏值都收敛，不会出现 0 家或 99 家', () => {
    expect(clampWarmStoreLimit(2)).toBe(2)
    expect(clampWarmStoreLimit(1)).toBe(1)
    expect(clampWarmStoreLimit(4)).toBe(4)
    expect(clampWarmStoreLimit(0)).toBe(1)
    expect(clampWarmStoreLimit(9)).toBe(4)
    expect(clampWarmStoreLimit('3')).toBe(3)
    expect(clampWarmStoreLimit(null)).toBe(1)
    expect(clampWarmStoreLimit('abc')).toBe(1)
    expect(clampWarmStoreLimit(2.9)).toBe(2)
  })

  it('文案按每店 150MB 估算，便于用户预判内存代价', () => {
    expect(warmStoreLimitLabel(1)).toBe('1 家 · 约 150MB')
    expect(warmStoreLimitLabel(3)).toBe('3 家 · 约 450MB')
    expect(warmStoreLimitLabel(99)).toBe('4 家 · 约 600MB')
  })
})
