import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 罗盘带货视频下载器 2.9.1 的接线守卫（2026-11-15）。
 *
 * 这批改动跨扩展内容脚本 / Service Worker / 主进程 session 三处，少接一处不会编译失败，
 * 只会在真实下载时表现为「弹了文件夹框但没落盘」「后台队列静默中断」或「取消后仍报完成」。
 * 只扫源码文本，不启动 Electron。
 */
const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
const content = read('assets/browser-extensions/luopan-downloader/content.js')
const background = read('assets/browser-extensions/luopan-downloader/background.js')
const manifest = JSON.parse(read('assets/browser-extensions/luopan-downloader/manifest.json'))
const session = read('apps/desktop/src/main/browser/session-manager.ts')

describe('罗盘下载器 2.9.1：先选目录再下载', () => {
  it('版本已升到 2.9.1', () => {
    expect(manifest.version).toBe('2.9.1')
  })

  it('内容脚本用 marker 触发保存目录，取消则整批不下载', () => {
    expect(content).toContain('__shopilot_pick_video_folder__.mp4')
    expect(content).toContain('triggerVideoFolderMarker')
    expect(content).toContain('ensureVideoFolder(btn)')
    expect(content).toContain("result === 'cancel'")
    expect(content).toContain('本批视频不会下载')
  })

  it('主进程同步选择目录，并用事件把 ok/cancel 回传页面', () => {
    expect(session).toContain("const VIDEO_SAVE_FOLDER_MARKER = '__shopilot_pick_video_folder__.mp4'")
    expect(session).toContain("notifyVideoSaveResult(webContents, 'ok')")
    expect(session).toContain("notifyVideoSaveResult(webContents, 'cancel')")
    expect(session).toContain('__lp_video_save_result')
    expect(session).toContain('SHOPILOT_TEST_VIDEO_SAVE_DIR')
    expect(session).toContain('SHOPILOT_TEST_VIDEO_SAVE_CANCEL')
  })

  it('blob 视频不 preventDefault 重发，而是 setSavePath 后原样落盘', () => {
    expect(session).toContain("if (itemUrl.startsWith('blob:'))")
    expect(session).toContain('saveBlobVideo(item')
    expect(session).toContain('targetItem.setSavePath(target)')
    expect(session).toContain('recordDownload(storeId, fileName, target, pageUrl)')
  })
})

describe('罗盘下载器 2.9.1：后台队列可靠性与进度', () => {
  it('Service Worker 保活，长队列不被回收', () => {
    expect(content).toContain("chrome.runtime.connect({ name: 'lp-keepalive' })")
    expect(background).toContain("port.name !== 'lp-keepalive'")
  })

  it('5xx/429/网络错误重试，403/404 立即失败', () => {
    expect(background).toContain('async function fetchVideo')
    expect(background).toContain('status >= 500 || status === 429')
    expect(background).toContain('attempt >= 2')
    expect(background).toContain('HTTP \' + status')
  })

  it('每个任务把终态回传页面，界面显示真实进度/失败', () => {
    expect(background).toContain('function notifyJob')
    expect(background).toContain("type: 'LP_JOB'")
    expect(content).toContain("msg.type === 'LP_JOB'")
    expect(content).toContain('下载 ${processed}/${dlState.total}')
    expect(content).toContain('失败 ${dlState.failed}')
    expect(content).toContain('后台下载任务已断开')
  })

  it('终态丢失有兜底：去重 + 静默超时放弃跟踪，且不谎报完成', () => {
    expect(content).toContain('dlState.jobs.has(jobId)')
    expect(content).toContain('function watchDownloadSilence')
    expect(content).toContain('setInterval(watchDownloadSilence, 5000)')
    expect(content).toContain('已停止跟踪')
  })

  it('榜单重启有上限：签名口径不一致时不会每 1.8 秒重启一次', () => {
    expect(content).toContain('RANK_RESTART_MAX')
    expect(content).toContain('RANK_RESTART_WINDOW_MS')
    expect(content).toContain('已暂停重拉')
  })

  it('榜单签名两侧同源：只用页面参数比，不把 DEFAULT_CFG / 补出来的日期算成筛选变化', () => {
    expect(content).toContain('rankPageSig')
    // 旧变量与「合并后签名」的写法必须消失，否则口径又会被混用
    expect(content).not.toContain('rankSig')
    expect(content).toMatch(/if \(sig !== rankPageSig\)/)
    expect(content).toMatch(/if \(sig === rankPageSig\) return/)
    // 记录签名处必须取最新页面请求参数，而不是 rankBaseParams()
    expect(content).toMatch(/rankPageSig = pageP && Object\.keys\(pageP\)\.length \? paramsSignature\(pageP\) : ''/)
  })
})
