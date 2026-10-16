/**
 * 客服新消息提示音（2026-10-16「实时检测店铺消息」）。
 *
 * 用 WebAudio **现场合成**两声短提示，不引入音频资源文件：仓库里没有音频资产目录，
 * 为一声"叮"塞一个 wav 不值得，合成还能避免打包体积与解码开销。
 *
 * 边界：
 *   · 可关：设置里允许关掉（`setCustomerMessageSoundEnabled`），默认开；
 *   · 失败一律静默——提醒的主体是红点与桌面通知，声音只是加分项，
 *     没有音频设备/被系统禁掉时绝不能让提醒链路报错。
 */

let soundEnabled = true

export function setCustomerMessageSoundEnabled(enabled: boolean): void {
  soundEnabled = enabled === true
}

export function isCustomerMessageSoundEnabled(): boolean {
  return soundEnabled
}

/**
 * 启动时按设置应用一次（`notify.customerSound`，默认开）。
 * 读设置失败就保持默认开——提示音不是关键路径，不能因为读设置失败把提醒搞哑。
 */
export async function initCustomerMessageSound(): Promise<boolean> {
  try {
    const result = await window.shopilot.settings.get('notify.customerSound')
    const value = result?.ok ? (result.data as { value?: unknown } | null)?.value : undefined
    if (typeof value === 'boolean') soundEnabled = value
  } catch {
    // 保持默认（开）
  }
  return soundEnabled
}

/** 两声短促提示（880Hz → 1320Hz）：比单音更容易被注意到，也不刺耳 */
const BEEP_TONES = [880, 1320]
const BEEP_GAP_SECONDS = 0.16

export function playCustomerMessageBeep(): void {
  if (!soundEnabled) return
  try {
    const Ctor = (globalThis as { AudioContext?: new () => AudioContext }).AudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    const now = ctx.currentTime
    for (let index = 0; index < BEEP_TONES.length; index++) {
      const oscillator = ctx.createOscillator()
      const gain = ctx.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = BEEP_TONES[index]
      const start = now + index * BEEP_GAP_SECONDS
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14)
      oscillator.connect(gain)
      gain.connect(ctx.destination)
      oscillator.start(start)
      oscillator.stop(start + BEEP_GAP_SECONDS)
    }
    if (typeof ctx.close === 'function') {
      setTimeout(() => { try { void ctx.close() } catch { /* 已关闭 */ } }, 900)
    }
  } catch {
    // 静默：声音不是提醒的必要条件
  }
}

/** 仅供单测：注入一个假的 AudioContext 构造函数，验证"可关"与"失败静默"两条边界 */
export function __setAudioContextForTest(ctor: unknown): void {
  ;(globalThis as { AudioContext?: unknown }).AudioContext = ctor
}
