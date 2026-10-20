<template>
  <section class="invite-panel" data-test="invite-panel">
    <div class="env-sec invite-config-sec">
      <div class="env-h">达人邀约 <span v-if="inviteProfile" class="row-sub">· {{ inviteProfile.platform }}</span><span v-else class="row-sub">· 当前平台未接入真实邀约流程</span></div>
      <template v-if="!inviteProfile">
        <div class="env-note">当前平台暂不支持达人邀约；已接入：抖店、微信小店、快手小店。保留入口但不会猜测页面选择器或伪造发送结果。</div>
      </template>
      <template v-else>
        <div class="invite-config-actions"><button type="button" class="mini-btn" data-test="invite-open-page" @click="openInvitePage">打开达人广场</button><button type="button" class="mini-btn" data-test="invite-save-config" :disabled="inviteSaving" @click="saveInviteConfig">{{ inviteSaving ? '保存中…' : '保存配置' }}</button></div>
        <template v-if="isBatchProfile(inviteProfile)">
          <div v-show="showStep(1)" class="invite-form-grid">
            <label class="invite-field"><span>{{ inviteProfile.categoryLabelText || '主推类目' }}</span><select v-model="invite.category" data-test="invite-category"><option value="">不限</option><option v-for="item in inviteCategoryOptions" :key="item" :value="item">{{ item }}</option></select></label>
            <label class="invite-field"><span>二级类目</span><select v-model="invite.subcategory" data-test="invite-subcategory" :disabled="!invite.category"><option value="">不限</option><option v-for="item in inviteSubcategoryOptions" :key="item" :value="item">{{ item }}</option></select></label>
            <label v-if="inviteProfile.categoryDepth === 3" class="invite-field"><span>三级类目</span><select v-model="invite.category3" data-test="invite-category3" :disabled="!invite.subcategory || !inviteThirdCategoryOptions.length"><option value="">不限</option><option v-for="item in inviteThirdCategoryOptions" :key="item" :value="item">{{ item }}</option></select></label>
            <label class="invite-field"><span>每批邀约数量</span><input v-model.number="invite.count" data-test="invite-count" type="number" min="1" :max="inviteProfile.maxBatch" /></label>
            <label v-if="inviteProfile.goodsModal" class="invite-field">
              <span>邀约商品数量<small v-if="inviteProfile.maxProducts"> · 最多 {{ inviteProfile.maxProducts }}</small></span>
              <input v-model.number="invite.batchProductCount" data-test="invite-batch-product-count" type="number" :min="1" :max="inviteProfile.maxProducts || 10" />
            </label>
          </div>
          <div v-show="showStep(2)" v-if="inviteProfile.levels.length" class="invite-choice-group"><span>达人等级</span><div class="invite-chips"><label v-for="level in inviteProfile.levels" :key="level" class="inv-chip" :class="{ on: invite.levels.includes(level) }"><input v-model="invite.levels" type="checkbox" :value="level" :data-test="`invite-level-${level}`" />{{ level }}</label></div></div>
          <div v-show="showStep(2)" v-if="inviteProfile.strengths" class="invite-choice-group"><span>{{ inviteProfile.strengths.label }}</span><div class="invite-chips"><label v-for="strength in inviteProfile.strengths.options" :key="strength" class="inv-chip" :class="{ on: invite.strengths.includes(strength) }"><input v-model="invite.strengths" type="checkbox" :value="strength" :data-test="`invite-strength-${strength}`" />{{ strength }}</label></div></div>
          <div v-show="showStep(2)" v-if="inviteProfile.benefits?.length" class="invite-choice-group"><span>{{ inviteProfile.benefitsLabelText || '专属权益' }}<small v-if="inviteProfile.benefitsMax"> · 最多 {{ inviteProfile.benefitsMax }} 项</small></span><div class="invite-chips"><label v-for="benefit in inviteProfile.benefits" :key="benefit" class="inv-chip" :class="{ on: invite.benefits.includes(benefit) }"><input v-model="invite.benefits" type="checkbox" :value="benefit" :data-test="`invite-benefit-${benefit}`" />{{ benefit }}</label></div></div>
          <div v-show="showStep(2)" v-if="inviteProfile.drawerForm?.mainCategory" class="invite-form-grid"><label class="invite-field"><span>主营类目</span><select v-model="invite.mainCategory" data-test="invite-main-category"><option value="">不填写</option><option v-for="item in inviteMainCategoryPaths" :key="item" :value="item">{{ item }}</option></select></label></div>
          <div v-show="showStep(2)" v-if="inviteProfile.contactSelectors?.phone || inviteProfile.contactSelectors?.wechat || inviteProfile.contactSelectors?.contact" class="invite-form-grid">
            <label v-if="inviteProfile.contactSelectors?.contact" class="invite-field"><span>联系人</span><input v-model="invite.batchContact" data-test="invite-batch-contact" maxlength="30" placeholder="联系人" /></label>
            <label v-if="inviteProfile.contactSelectors?.phone" class="invite-field"><span>手机号</span><input v-model="invite.batchPhone" data-test="invite-batch-phone" maxlength="20" placeholder="11 位手机号" /></label>
            <label v-if="inviteProfile.contactSelectors?.wechat" class="invite-field"><span>微信号</span><input v-model="invite.batchWechat" data-test="invite-batch-wechat" maxlength="40" placeholder="微信号" /></label>
          </div>
        </template>
        <template v-else>
          <div v-show="showStep(1)" class="invite-form-grid"><label class="invite-field"><span>邀约联系人</span><input v-model="invite.contact" data-test="invite-contact" placeholder="联系人" /></label><label class="invite-field"><span>微信号</span><input v-model="invite.wechat" data-test="invite-wechat" placeholder="微信号" /></label><label class="invite-field"><span>手机号</span><input v-model="invite.phone" data-test="invite-phone" placeholder="手机号" /></label></div>
          <label v-show="showStep(1)" class="invite-field" style="margin-top:8px">
            <span>商品ID<small> · 可留空；一行一个，或用逗号/空格分隔</small></span>
            <textarea v-model="invite.productIds" data-test="invite-product-ids" rows="2" spellcheck="false" placeholder="每行一个商品ID，例如：&#10;10000687986563&#10;10000687986564&#10;（留空 = 平台自动挑 1 个）"></textarea>
          </label>
          <label v-show="showStep(1)" class="invite-field" style="margin-top:8px"><span>带货者类型</span>
            <select v-model="invite.finderType" data-test="invite-finder-type">
              <option v-for="t in inviteProfile.finderTypes" :key="t" :value="t">{{ t }}</option>
            </select>
          </label>
          <div v-show="showStep(2)" class="invite-choice-group">
            <span>{{ inviteProfile.finderCategoryLabel }}
              <small v-if="invite.finderCategories.length"> · 已选 {{ invite.finderCategories.length }} 项</small>
              <button v-if="invite.finderCategories.length" type="button" class="browser-panel-row-action" data-test="invite-finder-cats-clear" @click="invite.finderCategories.splice(0)">清空</button>
            </span>
            <input v-if="inviteCatsExpanded || inviteCatQuery" v-model="inviteCatQuery" type="text" class="invite-cat-search" data-test="invite-cat-search" placeholder="搜索类目，如 母婴 / 生鲜" />
            <div class="invite-chips">
              <label v-for="c in inviteCategoryShown" :key="c" class="inv-chip" :class="{ on: invite.finderCategories.includes(c) }">
                <input type="checkbox" :value="c" v-model="invite.finderCategories" :data-test="'invite-finder-category-' + c" />{{ c }}
              </label>
            </div>
            <button
              v-if="!inviteCatQuery && (inviteCategoryHidden > 0 || inviteCatsExpanded)"
              type="button" class="mini-btn" data-test="invite-finder-cats-toggle"
              @click="inviteCatsExpanded = !inviteCatsExpanded"
            >{{ inviteCatsExpanded ? '收起类目' : `展开全部 ${inviteProfile.finderCategories.length} 项（还有 ${inviteCategoryHidden} 项）` }}</button>
          </div>
          <div v-show="showStep(2)" v-if="inviteProfile.finderSalesMetric && inviteProfile.finderSalesTiers?.length" class="invite-choice-group">
            <span>{{ inviteProfile.finderSalesMetric }} <small>近30日 · 可多选 · 选完立即生效</small></span>
            <div class="invite-chips">
              <label
                v-for="tier in inviteProfile.finderSalesTiers" :key="tier"
                class="inv-chip" :class="{ on: invite.finderSalesTiers.includes(tier) }"
              >
                <input
                  type="checkbox" :value="tier" :checked="invite.finderSalesTiers.includes(tier)"
                  :data-test="'invite-finder-sales-' + tier" @change="toggleSalesTier(tier)"
                />{{ tier }}
              </label>
            </div>
            <div class="env-note" v-if="inviteSalesTypeWarning">{{ inviteSalesTypeWarning }}</div>
          </div>
          <div v-show="showStep(2)" class="invite-choice-group">
            <span>{{ inviteProfile.finderOtherLabel }}</span>
            <div class="invite-chips">
              <label v-for="f in inviteProfile.finderOtherFilters" :key="f" class="inv-chip" :class="{ on: invite.finderOtherFilters.includes(f) }">
                <input type="checkbox" :value="f" v-model="invite.finderOtherFilters" :data-test="'invite-finder-other-' + f" />{{ f }}
              </label>
            </div>
          </div>
          <div v-show="showStep(2)" class="env-note">广场筛选会在「开始邀约」时由任务引擎按顺序应用（点完会回读勾选态，没选上就如实失败）。</div>
        </template>
        <div v-show="showStep(3)" v-if="inviteProfile.flow !== 'batch-list' || !!inviteProfile.scriptSelector" class="invite-choice-group invite-script-group">
          <span>邀约话术<small> · 最多 {{ inviteProfile.scriptMaxLen }} 字</small></span>
          <div class="invite-script-row">
            <select v-model="inviteScriptId" data-test="invite-script-select" @change="applyInviteScript(inviteScriptId)">
              <option value="">从话术库选择…</option>
              <option v-for="script in inviteScripts" :key="script.id" :value="script.id">{{ script.name }}</option>
            </select>
            <label class="inv-chip" :class="{ on: invite.scriptMode === 'manual' }">
              <input v-model="invite.scriptMode" type="radio" value="manual" data-test="invite-script-mode-manual" />手动
            </label>
            <label class="inv-chip" :class="{ on: invite.scriptMode === 'ai' }">
              <input v-model="invite.scriptMode" type="radio" value="ai" data-test="invite-script-mode-ai" />AI 生成
            </label>
          </div>
          <textarea
            v-model="invite.script"
            data-test="invite-script"
            rows="3"
            :maxlength="inviteProfile.scriptMaxLen"
            :readonly="invite.scriptMode === 'ai'"
            placeholder="手填话术，或选 AI 由运行时生成（AI 模式需先在设置中心配置 Key）"
          ></textarea>
          <div v-if="invite.scriptMode === 'ai' && !inviteAiConfigured" class="env-note invite-ai-hint">AI 未配置：开始按钮已禁用。请到「设置中心 → AI 配置」填 Key，或切回手动话术。</div>
        </div>
        <div v-if="showStep(3) && inviteProfile.flow === 'batch-list' && !inviteProfile.scriptSelector" class="env-note" data-test="invite-step3-noop">本平台这一版不需要单独填写话术：邀约文案与权益在平台的邀约弹窗里选择，这里只负责把已配置的筛选与商品带过去。</div>
        <ul v-show="showStep(4)" v-if="inviteMissingItems.length" class="invite-missing" data-test="invite-missing"><li v-for="item in inviteMissingItems" :key="item">{{ item }}</li></ul>
        <div v-show="showStep(4)" class="invite-start-row">
          <button type="button" class="mini-btn primary" data-test="invite-start" :disabled="!inviteReady || inviteSubmitting" @click="submit"><img class="button-icon" :src="browserStartIcon" alt="" />{{ inviteSubmitting ? '正在启动…' : '开始邀约' }}</button>
          <label class="invite-schedule" title="选填：到点后由主进程自动启动，应用重启也能恢复；中途可在批次列表取消">
            <span>定时启动</span>
            <input v-model="scheduleAt" type="datetime-local" data-test="invite-schedule-at" />
            <button v-if="scheduleAt" type="button" class="mini-btn" data-test="invite-schedule-clear" @click="scheduleAt = ''">立即</button>
          </label>
          <span v-if="scheduleError" class="row-sub invite-schedule-error" data-test="invite-schedule-error">{{ scheduleError }}</span>
          <label class="invite-max-invites" title="平台不显示今日剩余次数，这里是我们自己的上限：到量就干净收工">本次最多邀约
            <input type="number" min="1" max="50" step="1" v-model.number="invite.maxInvites" data-test="invite-max-invites" />
            位
          </label>
          <label class="invite-max-invites" title="0 = 不设日上限；设置后同一天累计到此数会拒绝启动">日上限
            <input type="number" min="0" max="500" step="1" v-model.number="invite.dailyCap" data-test="invite-daily-cap" />
            位
          </label>
          <span class="row-sub">{{ inviteReady ? `配置完整，最多发 ${invite.maxInvites} 位` : '补齐必填项后可开始' }}</span>
          <span v-if="inviteRecentCount" class="row-sub" data-test="invite-recent-count">· 近 7 天已邀 {{ inviteRecentCount }} 位，会自动跳过</span>
          <span v-if="inviteBlacklistCount" class="row-sub" data-test="invite-blacklist-count">· 黑名单 {{ inviteBlacklistCount }} 位，会自动跳过</span>
          <span v-if="inviteQuota" class="row-sub" data-test="invite-quota">· 今日已发 {{ inviteQuota.used }}{{ inviteQuota.limit ? ` / ${inviteQuota.limit}` : '（未设日上限）' }}<template v-if="inviteQuota.reserved"> · 运行中预留 {{ inviteQuota.reserved }}</template></span>
        </div>
        <div v-show="showStep(4)" class="env-note invite-backend-note" data-test="invite-backend-note">邀约在后台独立运行：不会打开或切换你的浏览器页面，可以继续正常浏览。</div>
      </template>
    </div>
    <div class="env-sec invite-live-sec">
      <div class="env-h">达人邀约实时日志<span v-if="inviteLatest" class="row-sub"> · {{ inviteStatus(inviteLatest) }}</span></div>
      <div v-if="!inviteLatest" class="browser-panel-empty invite-live-empty" data-test="invite-live-empty">本店铺还没有邀约运行，点“开始邀约”后这里会实时显示进度。</div>
      <template v-else>
        <div class="invite-live-stuck" data-test="invite-live-stuck">{{ inviteStuckText(inviteLatest) }}</div>
        <div class="step-row" v-for="(step, index) in (inviteLatest.steps || [])" :key="`${inviteLatest.id}-${index}`"><span class="s-ico">{{ inviteStepIcon(inviteLatest, toStepIndex(index)) }}</span><div class="v-info"><div class="row-main">第 {{ toStepIndex(index) + 1 }} 步 · {{ inviteStepLabel(step) }}</div><div class="row-sub">{{ inviteStepInput(step) }}</div></div></div>
        <div class="tc-btns" v-if="inviteRunId(inviteLatest)"><button v-if="inviteActive(inviteLatest)" type="button" class="mini-btn" data-test="invite-live-stop" @click="stopInvite(inviteLatest)"><img class="button-icon" :src="browserStopIcon" alt="" />停止</button><button type="button" class="mini-btn" @click="ws.refreshTasks()"><img class="button-icon" :src="browserRefreshIcon" alt="" />刷新</button></div>
        <div v-if="inviteLiveMessage(inviteLatest)" class="row-sub invite-message">{{ inviteLiveMessage(inviteLatest) }}</div>
        <div ref="inviteLiveLogEl" class="log-box invite-live-log" data-test="invite-live-log"><div v-if="!inviteLogs(inviteLatest).length" class="log-line">等待运行输出…开始邀约后，这里的日志会实时滚动，卡住时看停在最后几行。</div><div v-for="(log, index) in inviteLogs(inviteLatest)" :key="`${inviteRunId(inviteLatest)}-${index}`" class="log-line">{{ inviteLogText(log) }}</div></div>
      </template>
    </div>
    <div class="env-sec invite-unavailable"><div class="env-note">达人邀约配置与平台页面仍沿用真实运行、店铺配置和人工操作边界；未配置时不会伪造可发送结果。</div></div>
  </section>
</template>

<script setup lang="ts">
/**
 * 达人邀约配置 + 实时日志的**唯一视图**。
 *
 * 同一份模板同时给两处用（2026-10-19「达人邀约作为单独功能」）：
 *   · 店铺浏览器侧栏（原来就在这里）；
 *   · 应用中心 → 达人邀约 独立页（不需要打开店铺浏览器）。
 * 视图只接收 `useCreatorInvite` 的返回值，不自己读写 IPC——两处的状态、校验、启动口径因此
 * 不可能漂移；验收脚本引用的 data-test 锚点也全部保留。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { isBatchProfile } from '@shared/constants/invite'
import browserStartIcon from '../../assets/generated/ui-icons/browser-start-gen.png'
import browserStopIcon from '../../assets/generated/ui-icons/browser-stop-gen.png'
import browserRefreshIcon from '../../assets/generated/ui-icons/browser-refresh-gen.png'
import { useWorkspaceStore } from '../../stores/workspace'
import type { CreatorInviteController } from '../workbench/use-creator-invite'

/**
 * `step`：四步向导的当前步（1 目标 / 2 受众 / 3 话术 / 4 确认）。
 * 不传 = 展示全部（侧栏保持单页长表单，改动最小）。用 v-show 而不是 v-if：
 * 隐藏的步骤仍在 DOM 里，验收锚点与已填的值都不会因为切步丢失。
 */
const props = defineProps<{ controller: CreatorInviteController; step?: number | null }>()
const emit = defineEmits<{ (event: 'started'): void }>()

const ws = useWorkspaceStore()
const {
  inviteLiveLogEl,
  inviteProfile,
  invite,
  inviteSaving,
  inviteQuota,
  inviteScripts,
  inviteScriptId,
  inviteAiConfigured,
  inviteSubmitting,
  inviteRecentCount,
  inviteBlacklistCount,
  inviteCategoryOptions,
  inviteSubcategoryOptions,
  inviteThirdCategoryOptions,
  inviteMainCategoryPaths,
  inviteMissingItems,
  inviteCatQuery,
  inviteCatsExpanded,
  inviteCategoryShown,
  inviteCategoryHidden,
  inviteSalesTypeWarning,
  toggleSalesTier,
  inviteReady,
  inviteLatest,
  applyInviteScript,
  saveInviteConfig,
  openInvitePage,
  inviteRunId,
  inviteStatus,
  inviteActive,
  inviteStuckText,
  inviteStepIcon,
  inviteStepLabel,
  toStepIndex,
  inviteStepInput,
  inviteLiveMessage,
  inviteLogs,
  inviteLogText,
  stopInvite,
  startInvite
} = props.controller

/** 定时启动（选填）：空字符串 = 立即启动。 */
const scheduleAt = ref('')
const scheduleMs = computed(() => {
  const raw = scheduleAt.value.trim()
  if (!raw) return null
  const ms = new Date(raw).getTime()
  return Number.isFinite(ms) ? ms : null
})
const scheduleError = computed(() => {
  if (!scheduleAt.value.trim()) return ''
  if (scheduleMs.value == null) return '时间格式无法识别'
  if (scheduleMs.value < Date.now() + 60_000) return '定时启动至少要晚于当前时间 1 分钟'
  return ''
})

/** 当前步是否要显示；未传 step 时全显示（侧栏）。 */
function showStep(step: number): boolean {
  return props.step == null || props.step === step
}

async function submit(): Promise<void> {
  if (scheduleError.value) { ws.toast(`定时启动时间不可用：${scheduleError.value}`, 'error'); return }
  if (await startInvite({ scheduleAt: scheduleMs.value })) emit('started')
}

/** 日志自动滚到底：只依赖"日志条数/运行变化"，不打断用户向上翻看历史（跟随最新一条）。 */
watch(
  () => `${inviteRunId(inviteLatest.value)}:${inviteLogs(inviteLatest.value).length}`,
  () => {
    void nextTick(() => {
      if (inviteLiveLogEl.value) inviteLiveLogEl.value.scrollTop = inviteLiveLogEl.value.scrollHeight
    })
  }
)
</script>

<style scoped>
.env-sec { padding: 12px 14px; border-bottom: 1px solid var(--dash-border); }
.env-h { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; color: var(--dash-text-soft); font-size: 11px; font-weight: 600; letter-spacing: .3px; }
.env-note { margin-top: 7px; color: var(--dash-text-muted); font-size: 10px; line-height: 1.5; }
.row-main { overflow: hidden; color: var(--dash-text-soft); text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }
.row-sub { overflow: hidden; color: var(--dash-text-muted); text-overflow: ellipsis; white-space: nowrap; font-size: 9px; }
.v-info { min-width: 0; flex: 1; }
.button-icon { width: 14px; height: 14px; object-fit: contain; vertical-align: middle; margin-right: 4px; }
.mini-btn { min-height: 25px; padding: 0 8px; border: 1px solid var(--dash-border); border-radius: 6px; background: #ffffff; color: var(--dash-text-soft); cursor: pointer; font-size: 9px; white-space: nowrap; }
.mini-btn:hover:not(:disabled), .mini-btn:focus-visible { border-color: rgba(145,116,255,.7); color: var(--dash-text); outline: none; }
.mini-btn:disabled { cursor: not-allowed; opacity: .48; }
.mini-btn.primary { border-color: #5b3df5; background: #6d4aff; color: #ffffff; }
.browser-panel-empty { display: grid; min-height: 150px; place-items: center; color: var(--dash-text-muted); font-size: 11px; text-align: center; gap: 4px; }
.browser-panel-row-action { display: grid; place-items: center; flex: 0 0 auto; border: 0; background: transparent; color: var(--dash-text-muted); cursor: pointer; }
.invite-panel { min-width: 0; }
.invite-config-sec { padding-bottom: 12px; }
.invite-config-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 7px 0 9px; }
.invite-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; margin-top: 8px; }
.invite-field { display: flex; min-width: 0; flex-direction: column; gap: 4px; color: var(--dash-text-muted); font-size: 10px; }
.invite-field input, .invite-field select, .invite-field textarea { min-width: 0; height: 29px; padding: 0 7px; border: 1px solid var(--dash-border); border-radius: 6px; background: #ffffff; color: var(--dash-text-soft); font-size: 10px; }
.invite-field textarea { height: auto; min-height: 44px; padding: 6px 7px; line-height: 1.5; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.invite-field input:focus, .invite-field select:focus, .invite-field textarea:focus { border-color: rgba(145,113,255,.78); outline: none; box-shadow: 0 0 0 2px rgba(145,113,255,.14); }
.invite-choice-group { margin-top: 9px; color: var(--dash-text-muted); font-size: 10px; }
.invite-schedule { display: inline-flex; align-items: center; gap: 5px; color: var(--dash-text-muted); font-size: 10px; }
.invite-schedule input { height: 26px; padding: 0 6px; border: 1px solid var(--dash-border); border-radius: 6px; background: #ffffff; color: var(--dash-text); font: inherit; font-size: 10px; }
.invite-schedule-error { color: #b42318; }
.invite-script-group textarea { width: 100%; box-sizing: border-box; min-height: 64px; margin-top: 6px; padding: 6px 7px; border: 1px solid var(--dash-border); border-radius: 6px; background: #ffffff; color: var(--dash-text-soft); font: inherit; font-size: 10px; line-height: 1.5; resize: vertical; }
.invite-script-group textarea:focus { border-color: rgba(145,113,255,.78); outline: none; box-shadow: 0 0 0 2px rgba(145,113,255,.14); }
.invite-script-group textarea[readonly] { background: #f7f8fa; color: var(--dash-text-muted); }
.invite-script-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.invite-script-row select { min-width: 0; flex: 1; height: 26px; padding: 0 6px; border: 1px solid var(--dash-border); border-radius: 6px; background: #ffffff; color: var(--dash-text-soft); font: inherit; font-size: 9.5px; }
.invite-ai-hint { margin-top: 5px; color: #b54708; }
.invite-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
.inv-chip { display: inline-flex; align-items: center; gap: 4px; min-height: 24px; padding: 0 6px; border: 1px solid rgba(111,137,177,.22); border-radius: 999px; background: #f7f9fd; color: var(--dash-text-muted); cursor: pointer; font-size: 9px; }
.inv-chip input { position: absolute; opacity: 0; pointer-events: none; }
.inv-chip.on { border-color: rgba(135,102,246,.72); background: rgba(111,77,225,.18); color: #4c1d95; }
.invite-missing { margin: 8px 0 0; padding: 7px 8px 7px 21px; border: 1px solid rgba(242,165,87,.2); border-radius: 7px; background: rgba(245,158,11,.12); color: #92400e; font-size: 9px; line-height: 1.5; }
.invite-start-row { display: flex; align-items: center; gap: 8px; margin-top: 9px; flex-wrap: wrap; }
.invite-live-sec { padding: 3px 2px 12px; border-bottom: 0; }
.invite-live-empty { min-height: 150px; padding: 12px; line-height: 1.6; }
.invite-live-stuck { padding: 8px 9px; border: 1px solid rgba(242,165,87,.24); border-radius: 7px; background: rgba(245,158,11,.12); color: #92400e; font-size: 10px; line-height: 1.45; }
.step-row { display: flex; align-items: flex-start; gap: 7px; padding: 7px 0 0 3px; }
.s-ico { width: 17px; flex: 0 0 17px; text-align: center; font-size: 11px; }
.tc-btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
.invite-message { padding: 5px 0 2px; line-height: 1.5; white-space: normal; }
.log-box { max-height: 210px; margin-top: 8px; padding: 7px 8px; overflow-y: auto; border: 1px solid var(--dash-border); border-radius: 7px; background: #f7f9fd; }
.log-line { color: #4a5568; font-family: Consolas, monospace; font-size: 9px; line-height: 1.6; overflow-wrap: anywhere; }
.invite-unavailable { padding: 10px 2px; border-bottom: 0; }
.invite-backend-note { color: #4c1d95; }
</style>
