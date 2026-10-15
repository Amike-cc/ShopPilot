import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 设置中心重构（「平台入口」合并 + 「安全」「数据与维护」迁入 + 交互统一）的源码级回归。
 *
 * 为什么用源码级断言：这里钉的是**结构与纪律**（保存行为、草稿守护、迁移完整性、跳转白名单），
 * 运行时很难在小单测里直接触发（需要完整 Electron 渲染环境）；真实行为由
 * tools/acceptance/settings-cdp-verify.js（应用锁全链路 / 采集开关 / 备份恢复）与
 * m1-cdp-verify.js（平台入口两组同屏 / 邀约地址覆盖）覆盖，这里保证两侧口径一致。
 */
const read = (p: string) => readFileSync(resolve(p), 'utf8')

const PAGE = read('apps/desktop/src/renderer/src/features/workbench/UnifiedSettingsPage.vue')
const SURFACE = read('apps/desktop/src/renderer/src/features/workbench/DashboardBrowserSurface.vue')
const VIEW = read('apps/desktop/src/renderer/src/features/workbench/DashboardView.vue')

describe('设置中心页签结构', () => {
  it('五个页签：平台入口 / AI 配置 / 安全 / 数据与维护 / 关于软件', () => {
    expect(PAGE).toContain("{ key: 'entry', label: '平台入口'")
    expect(PAGE).toContain("{ key: 'ai', label: 'AI 配置'")
    expect(PAGE).toContain("{ key: 'security', label: '安全'")
    expect(PAGE).toContain("{ key: 'maintenance', label: '数据与维护'")
    expect(PAGE).toContain("{ key: 'about', label: '关于软件'")
    // 旧的独立「配置 / 达人广场」页签已合并，选择器不再存在
    expect(PAGE).not.toContain('data-test="settings-config"')
    expect(PAGE).not.toContain('data-test="settings-square"')
    expect(PAGE).toContain('data-test="settings-entry"')
    expect(PAGE).toContain('data-test="settings-entry-platform"')
    expect(PAGE).toContain('data-test="settings-entry-square"')
  })

  it('页签读取失败有常显角标（不用点进去才发现）', () => {
    expect(PAGE).toContain('settings-tab-alert')
    expect(PAGE).toMatch(/const tabIssues = computed/)
  })

  it('内容少的页签不再被 420px 强制留白撑开（视觉收敛）', () => {
    expect(PAGE).not.toContain('min-height:420px')
  })
})

describe('平台入口（合并保存）', () => {
  it('一个保存按钮写两组覆盖值，且第二组失败时如实报告部分成功', () => {
    expect(PAGE).toMatch(/async function saveEntry/)
    expect(PAGE).toContain("settings.set('platform.homeUrls', homeNext)")
    expect(PAGE).toContain('settings.set(INVITE_SQUARE_URLS_SETTING, squareNext)')
    expect(PAGE).toContain('平台首页地址已保存，但达人广场地址保存失败')
  })

  it('保存后停留在设置中心（不再保存即关闭），关闭只发生在带守护的 requestClose', () => {
    const saveEntry = PAGE.slice(PAGE.indexOf('async function saveEntry'), PAGE.indexOf('function secSay'))
    expect(saveEntry.length).toBeGreaterThan(0)
    expect(saveEntry).not.toContain("emit('close')")
    expect(PAGE).toMatch(/function requestClose[\s\S]{0,120}emit\('close'\)/)
  })

  it('未保存修改在关闭/切页签时先确认（不静默丢弃）', () => {
    expect(PAGE).toMatch(/const entryDirty = computed/)
    expect(PAGE).toMatch(/function selectTab[\s\S]{0,160}confirmDiscardDrafts/)
    expect(PAGE).toMatch(/function requestClose[\s\S]{0,120}confirmDiscardDrafts/)
    // 保存成功后立即刷新基线（否则刚保存完还被判"有未保存修改"）
    expect(PAGE).toMatch(/homeBaseline\.value = homeNext/)
    expect(PAGE).toMatch(/squareBaseline\.value = squareNext/)
  })

  it('留空=恢复默认的口径不变（写库时只保留非空值）', () => {
    expect(PAGE).toMatch(/if \(value\) homeNext\[platform\.name\] = value/)
    expect(PAGE).toMatch(/if \(value\) squareNext\[profile\.platform\] = value/)
  })
})

describe('设置中心细节打磨（未保存反馈 / 提示淡出 / 控件）', () => {
  it('无改动时保存按钮禁用；有改动显示「有未保存的修改」徽标与「放弃更改」', () => {
    expect(PAGE).toContain('data-test="settings-entry-unsaved"')
    expect(PAGE).toContain('data-test="settings-entry-discard"')
    expect(PAGE).toMatch(/:disabled="[^"]*entrySaving[^"]*!entryDirty"/)
    expect(PAGE).toMatch(/function discardEntry[\s\S]{0,400}homeBaseline\.value\[platform\.name\] \|\| ''/)
    expect(PAGE).toMatch(/function discardEntry[\s\S]{0,500}squareBaseline\.value\[profile\.platform\] \|\| ''/)
  })

  it('保存成功提示限时淡出、有未保存修改时自动隐藏、卸载时清计时器', () => {
    expect(PAGE).toMatch(/function flashSavedMessage[\s\S]{0,300}6000/)
    expect(PAGE).toMatch(/savedMessage && !entryDirty/)
    expect(PAGE).toMatch(/onBeforeUnmount\([\s\S]{0,160}clearTimeout\(savedMessageTimer\)/)
  })

  it('采集开关是自定义开关外观的原生 checkbox（data-test 契约不变、可点击可勾选）', () => {
    expect(PAGE).toMatch(/type="checkbox" class="settings-switch" data-test="maintenance-auto-collect"/)
    expect(PAGE).toMatch(/\.settings-switch:checked/)
    expect(PAGE).toMatch(/appearance:none/)
  })

  it('说明/提示/分组采用统一视觉层（单一收敛层，无 420px 留白与重阴影残留）', () => {
    expect(PAGE).toMatch(/\.settings-note\{[^}]*border:1px solid #edf0f5/)
    expect(PAGE).toMatch(/\.settings-group\{[^}]*background:#f8fafc/)
    expect(PAGE).not.toContain('min-height:420px')
    expect(PAGE).not.toContain('settings-head-tags')
  })
})

describe('安全页签（自侧栏迁入，单一入口）', () => {
  it('设置/更换/移除主密码与空闲锁定全走主进程 IPC；移除用内联确认而非 window.prompt', () => {
    expect(PAGE).toContain('security.setPassword')
    expect(PAGE).toContain('security.removePassword')
    expect(PAGE).toContain("settings.set('security.idleMinutes'")
    expect(PAGE).toContain('data-test="security-remove-pw"')
    expect(PAGE).not.toContain('window.prompt')
  })

  it('安全操作成功后同步全局状态（ws.refreshSecurity，左栏与侧栏读它）', () => {
    expect(PAGE).toMatch(/async function syncSecurity[\s\S]{0,200}ws\.refreshSecurity/)
  })

  it('空闲锁定保存失败把下拉还原到真实值（不显示假状态）', () => {
    expect(PAGE).toMatch(/securityIdle\.value = savedIdleMinutes/)
  })

  it('侧栏不再重复提供设置/更换/移除主密码 UI，只保留立即锁定与跳转', () => {
    expect(SURFACE).not.toContain('btn-set-pw')
    expect(SURFACE).not.toContain('data-test="sel-idle"')
    expect(SURFACE).not.toContain('setMasterPw')
    expect(SURFACE).not.toContain('window.prompt')
    expect(SURFACE).toContain('data-test="btn-lock-now"')
    expect(SURFACE).toContain("emit('open-settings', 'security')")
  })
})

describe('数据与维护页签（自侧栏迁入）', () => {
  it('采集总开关用 shared 常量与解析函数（fail-closed），保存失败还原勾选', () => {
    expect(PAGE).toContain('AUTO_COLLECTION_SETTING')
    expect(PAGE).toContain('parseAutoCollectionEnabled')
    expect(PAGE).toMatch(/collectionEnabled\.value = !next/)
  })

  it('备份/恢复/诊断/审计/内存快照齐备；恢复前如实提示、恢复后刷新店铺列表', () => {
    expect(PAGE).toContain('backup.create')
    expect(PAGE).toContain('backup.restore')
    expect(PAGE).toContain('diagnostics.export')
    expect(PAGE).toContain('audit.export')
    expect(PAGE).toContain('memoryDiagnostics')
    expect(PAGE).toMatch(/doRestore[\s\S]{0,700}ws\.refreshStores/)
    expect(PAGE).toMatch(/doRestore[\s\S]{0,300}window\.confirm/)
  })

  it('侧栏不再提供备份/诊断按钮，仅保留跳转（避免两处入口各自演化）', () => {
    expect(SURFACE).not.toContain('btn-backup')
    expect(SURFACE).not.toContain('btn-diag')
    expect(SURFACE).not.toContain('doBackup')
    expect(SURFACE).not.toContain('doRestore')
    expect(SURFACE).toContain("emit('open-settings', 'maintenance')")
  })
})

describe('接线：环境面板 → 设置中心页签', () => {
  it('DashboardView 白名单映射页签，未知值回落「平台入口」', () => {
    expect(VIEW).toContain('@open-settings="openSettingsTab"')
    expect(VIEW).toMatch(/const SETTINGS_TABS: SettingsTab\[\] = \['entry', 'ai', 'security', 'maintenance', 'about'\]/)
    expect(VIEW).toMatch(/function openSettingsTab[\s\S]{0,220}navigateTo\('settings'\)/)
    expect(VIEW).toContain("type SettingsTab = 'entry' | 'ai' | 'security' | 'maintenance' | 'about'")
  })
})
