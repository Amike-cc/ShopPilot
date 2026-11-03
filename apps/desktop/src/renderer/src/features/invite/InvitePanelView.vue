<template>
  <section class="invite-panel" data-test="invite-panel">
    <div class="env-sec invite-config-sec">
      <div class="env-h">达人邀约 <span v-if="inviteProfile" class="row-sub">· {{ inviteProfile.platform }}</span><span v-else class="row-sub">· 当前平台未接入真实邀约流程</span></div>
      <template v-if="!inviteProfile">
        <div class="env-note">当前平台暂不支持达人邀约；已接入：抖店、微信小店、快手小店。保留入口但不会猜测页面选择器或伪造发送结果。</div>
      </template>
      <template v-else>
        <div class="invite-config-actions"><button type="button" class="mini-btn" data-test="invite-open-page" title="只打开广场并应用筛选/读取候选，不发送任何邀约" @click="openInvitePage">打开广场 · 仅预览</button><button type="button" class="mini-btn" data-test="invite-save-config" :disabled="inviteSaving" @click="saveInviteConfig">{{ inviteSaving ? '保存中…' : '保存配置' }}</button></div>
        <div v-if="isDoudianContact" class="env-note invite-contact-note" data-test="invite-contact-flow-note">抖店当前为「逐人沟通」：每位点一次「在线沟通」，平台不回读是否被接受，逐人记录显示为「邀请中」；话术/联系方式/权益由平台侧会话完成，本面板不再要求。</div>
        <!-- 侧栏模式的紧凑步骤导航（独立页有自己的四步导航，这里只在 step 未传时出现） -->
        <nav v-if="isSidebarMode" class="invite-panel-steps" data-test="invite-panel-steps" aria-label="邀约配置步骤">
          <button
            v-for="tab in inviteStepTabs" :key="tab.n" type="button"
            class="invite-panel-step" :class="{ on: activeStep === tab.n }"
            :data-test="`invite-panel-step-${tab.n}`" :aria-current="activeStep === tab.n ? 'step' : undefined"
            @click="goLocalStep(tab.n)"
          ><b>{{ tab.n }}</b><span>{{ tab.label }}</span></button>
        </nav>
        <template v-if="isBatchProfile(inviteProfile)">
          <div v-show="showStep(1)" class="invite-form-grid">
            <label class="invite-field"><span>{{ inviteProfile.categoryLabelText || '主推类目' }}</span><select v-model="invite.category" data-test="invite-category"><option value="">不限</option><option v-for="item in inviteCategoryOptions" :key="item" :value="item">{{ item }}</option></select></label>
            <label class="invite-field"><span>二级类目</span><select v-model="invite.subcategory" data-test="invite-subcategory" :disabled="!invite.category"><option value="">不限</option><option v-for="item in inviteSubcategoryOptions" :key="item" :value="item">{{ item }}</option></select></label>
            <label v-if="inviteProfile.categoryDepth === 3" class="invite-field"><span>三级类目</span><select v-model="invite.category3" data-test="invite-category3" :disabled="!invite.subcategory || !inviteThirdCategoryOptions.length"><option value="">不限</option><option v-for="item in inviteThirdCategoryOptions" :key="item" :value="item">{{ item }}</option></select></label>
            <label class="invite-field"><span>{{ isDoudianContact ? '本次最多邀约' : '每批邀约数量' }}</span><input v-model.number="invite.count" data-test="invite-count" type="number" min="1" :max="inviteProfile.maxBatch" /></label>
            <label v-if="!isDoudianContact" class="invite-field"><span>本次最多邀约<small> · 到量即停</small></span><input v-model.number="invite.totalCap" data-test="invite-total-cap" type="number" min="1" max="500" /></label>
            <label v-if="!isDoudianContact && inviteProfile.goodsModal" class="invite-field">
              <span>邀约商品数量<small v-if="inviteProfile.maxProducts"> · 最多 {{ inviteProfile.maxProducts }}</small></span>
              <input v-model.number="invite.batchProductCount" data-test="invite-batch-product-count" type="number" :min="1" :max="inviteProfile.maxProducts || 10" />
            </label>
          </div>
          <!-- 达人类型筛选（抖店真机实测文案 2026-10-21）：打开达人广场时由主进程应用到平台 radio -->
          <div v-show="showStep(1)" v-if="inviteProfile.platform === '抖店'" class="invite-choice-group" data-test="invite-doudian-finder-type">
            <span>达人类型<small> · 打开达人广场时应用</small></span>
            <div class="invite-chips">
              <label v-for="t in DOUDIAN_FINDER_TYPES" :key="t" class="inv-chip" :class="{ on: doudianFinderType === t }">
                <input type="radio" name="invite-doudian-finder-type" :value="t" :checked="doudianFinderType === t" :data-test="'invite-finder-type-doudian-' + t" @change="doudianFinderType = t" />{{ t }}
              </label>
            </div>
            <div class="env-note" data-test="invite-doudian-filter-scope">当前版本按「主推类目 + 达人类型」筛选；达人等级、销售额等快筛尚未接入，运行前请在广场人工核对。</div>
          </div>
          <!-- 候选预览（2026-10-21 真机实测打通）：打开达人广场时从列表卡片读取，
               供发送前人工核对"将邀请的是这些人"——候选预览/目标名单的第一版 -->
          <div v-show="showStep(1)" v-if="squareCandidates.length" class="invite-choice-group" data-test="invite-candidates-preview">
            <span>广场候选预览<small> · 打开达人广场时读取，共 {{ squareCandidates.length }} 位（{{ candidateAgeText }}）</small></span>
            <div class="invite-candidates">
              <div v-for="(c, i) in squareCandidates.slice(0, 8)" :key="`${c.nickname}-${i}`" class="invite-candidate">
                <b>{{ c.nickname }}</b>
                <small>{{ c.summary }}</small>
              </div>
              <div v-if="squareCandidates.length > 8" class="invite-candidate-more">…其余 {{ squareCandidates.length - 8 }} 位见广场页面</div>
            </div>
            <div v-if="invite.subcategory || invite.category3" class="env-note" data-test="invite-preview-scope-note">预览按一级类目「{{ invite.category || '不限' }}」读取；开始邀约时会再按二级/三级类目收窄。</div>
            <div v-if="plannedTotal > squareCandidates.length" class="env-note" data-test="invite-preview-count-note">预览只读取首屏 {{ squareCandidates.length }} 位；本次计划 {{ plannedTotal }} 位，运行时会继续滚动列表，实际可邀人数以页面为准。</div>
          </div>
          <div v-show="showStep(2)" v-if="!isDoudianContact && inviteProfile.levels.length" class="invite-choice-group"><span>达人等级</span><div class="invite-chips"><label v-for="level in inviteProfile.levels" :key="level" class="inv-chip" :class="{ on: invite.levels.includes(level) }"><input v-model="invite.levels" type="checkbox" :value="level" :data-test="`invite-level-${level}`" />{{ level }}</label></div></div>
          <div v-show="showStep(2)" v-if="!isDoudianContact && inviteProfile.strengths" class="invite-choice-group"><span>{{ inviteProfile.strengths.label }}</span><div class="invite-chips"><label v-for="strength in inviteProfile.strengths.options" :key="strength" class="inv-chip" :class="{ on: invite.strengths.includes(strength) }"><input v-model="invite.strengths" type="checkbox" :value="strength" :data-test="`invite-strength-${strength}`" />{{ strength }}</label></div></div>
          <div v-show="showStep(2)" v-if="!isDoudianContact && inviteProfile.benefits?.length" class="invite-choice-group"><span>{{ inviteProfile.benefitsLabelText || '专属权益' }}<small v-if="inviteProfile.benefitsMax"> · 最多 {{ inviteProfile.benefitsMax }} 项</small></span><div class="invite-chips"><label v-for="benefit in inviteProfile.benefits" :key="benefit" class="inv-chip" :class="{ on: invite.benefits.includes(benefit) }"><input v-model="invite.benefits" type="checkbox" :value="benefit" :data-test="`invite-benefit-${benefit}`" />{{ benefit }}</label></div></div>
          <div v-show="showStep(2)" v-if="!isDoudianContact && inviteProfile.drawerForm?.mainCategory" class="invite-form-grid"><label class="invite-field"><span>主营类目</span><select v-model="invite.mainCategory" data-test="invite-main-category"><option value="">不填写</option><option v-for="item in inviteMainCategoryPaths" :key="item" :value="item">{{ item }}</option></select></label></div>
          <div v-show="showStep(2)" v-if="!isDoudianContact && (inviteProfile.contactSelectors?.phone || inviteProfile.contactSelectors?.wechat || inviteProfile.contactSelectors?.contact)" class="invite-form-grid">
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
        <div v-if="showStep(3) && inviteProfile.flow === 'batch-list' && !inviteProfile.scriptSelector" class="env-note" data-test="invite-step3-noop">{{ isDoudianContact ? '逐人沟通不需要填写话术：会话内容在平台侧完成，本面板只负责筛选与发起。' : '本平台这一版不需要单独填写话术：邀约文案与权益在平台的邀约弹窗里选择，这里只负责把已配置的筛选与商品带过去。' }}</div>
        <div v-show="showStep(4)" v-if="isBatchProfile(inviteProfile)" class="env-note invite-scope-summary" data-test="invite-scope-summary">{{ inviteScopeSummary }}</div>
        <ul v-show="showStep(4)" v-if="inviteMissingItems.length" class="invite-missing" data-test="invite-missing"><li v-for="item in inviteMissingItems" :key="item">{{ item }}</li></ul>
        <div v-show="showStep(4)" class="invite-start-row">
          <button type="button" class="mini-btn primary" data-test="invite-start" :disabled="!inviteReady || inviteSubmitting" @click="submit"><img class="button-icon" :src="browserStartIcon" alt="" />{{ inviteSubmitting ? '正在启动…' : '开始邀约' }}</button>
          <!-- 批量流（抖店/快手）的总量在第 1 步已经填过，这里再放一个 maxInvites 会显示一个不参与执行的值。 -->
          <label v-if="!isBatchProfile(inviteProfile)" class="invite-max-invites" title="平台不显示今日剩余次数，这里是我们自己的上限：到量就干净收工">本次最多邀约
            <input type="number" min="1" max="50" step="1" v-model.number="invite.maxInvites" data-test="invite-max-invites" />
            位
          </label>
          <label class="invite-max-invites" title="0 = 不设日上限；设置后同一天累计到此数会拒绝启动">日上限
            <input type="number" min="0" max="500" step="1" v-model.number="invite.dailyCap" data-test="invite-daily-cap" />
            位
          </label>
          <span class="row-sub">{{ inviteReady ? `配置完整，本次计划 ${plannedTotal} 位` : '补齐必填项后可开始' }}</span>
          <span v-if="inviteRecentCount" class="row-sub" data-test="invite-recent-count">· 近 7 天已邀 {{ inviteRecentCount }} 位，会自动跳过</span>
          <span v-if="inviteBlacklistCount" class="row-sub" data-test="invite-blacklist-count">· 黑名单 {{ inviteBlacklistCount }} 位，会自动跳过</span>
          <span v-if="inviteQuota" class="row-sub" data-test="invite-quota">· 今日已发 {{ inviteQuota.used }}{{ inviteQuota.limit ? ` / ${inviteQuota.limit}` : '（未设日上限）' }}<template v-if="inviteQuota.reserved"> · 运行中预留 {{ inviteQuota.reserved }}</template></span>
        </div>
        <div v-show="showStep(4)" class="env-note invite-backend-note" data-test="invite-backend-note">邀约在后台独立运行：不会打开或切换你的浏览器页面，可以继续正常浏览。</div>
        <!-- 侧栏模式：当前步的"下一步"引导；抖店只有两步，下一步直接到「启动」 -->
        <div v-if="isSidebarMode && nextStepN !== null" class="invite-panel-next">
          <button type="button" class="mini-btn primary" data-test="invite-panel-next" @click="goLocalStep(nextStepN)">下一步：{{ nextStepLabel }} →</button>
        </div>
      </template>
    </div>
    <div class="env-sec invite-live-sec" :class="{ collapsed: isSidebarMode && liveLogCollapsed }">
      <button
        v-if="isSidebarMode" type="button"
        class="env-h invite-live-toggle" data-test="invite-live-toggle"
        :aria-expanded="!liveLogCollapsed"
        @click="liveLogCollapsed = !liveLogCollapsed"
      >达人邀约运行记录<span v-if="inviteDisplayStatus" class="row-sub"> · {{ inviteDisplayStatus }}</span><span class="invite-live-caret">{{ liveLogCollapsed ? '▸' : '▾' }}</span></button>
      <div v-else class="env-h">达人邀约运行记录<span v-if="inviteDisplayStatus" class="row-sub"> · {{ inviteDisplayStatus }}</span></div>
      <template v-if="!isSidebarMode || !liveLogCollapsed">
      <div v-if="!inviteCampaign && !inviteLatest && !inviteCampaignError" class="browser-panel-empty invite-live-empty" data-test="invite-live-empty">本店铺还没有邀约运行，点“开始邀约”后这里会显示批次进度和每位达人的结果。</div>
      <template v-else>
        <!--
          2026-11-01：记录区以主进程库里的批次/逐人记录为准（重启后仍在），
          实时日志只在运行中且还没有轮末结果时兜底展示。
        -->
        <div class="invite-live-status" :class="inviteDisplayTone" data-test="invite-live-stuck">
          <b>{{ inviteDisplayStatus || (inviteCampaignError ? '读取失败' : '等待运行') }}</b><span v-if="inviteDisplayCounts"> · {{ inviteDisplayCounts }}</span>
        </div>
        <div v-if="inviteDisplayReason" class="env-note invite-live-reason" data-test="invite-live-reason">{{ inviteDisplayReason }}</div>
        <!-- 独立邀约页已下线：这里提供最近批次回看，历史逐人结果仍然可查。 -->
        <label v-if="inviteCampaigns.length > 1" class="invite-campaign-picker">
          <span>查看批次</span>
          <select :value="inviteSelectedCampaignId || inviteCampaign?.id || ''" data-test="invite-campaign-picker" @change="onSelectInviteCampaign">
            <option v-for="campaign in inviteCampaigns" :key="campaign.id" :value="campaign.id">{{ inviteCampaignOptionText(campaign) }}</option>
          </select>
        </label>
        <div class="tc-btns">
          <button v-if="inviteDisplayActive && inviteDisplayRunId" type="button" class="mini-btn" data-test="invite-live-stop" @click="stopInviteRun(inviteDisplayRunId)"><img class="button-icon" :src="browserStopIcon" alt="" />停止</button>
          <button type="button" class="mini-btn" data-test="invite-live-refresh" @click="refreshInvite"><img class="button-icon" :src="browserRefreshIcon" alt="" />刷新</button>
        </div>
        <div class="invite-live-summary" data-test="invite-live-summary">
          <span>{{ inviteDisplaySummary }}</span>
          <span v-if="inviteRecentCount" class="row-sub">近 7 天已邀 {{ inviteRecentCount }} 位</span>
        </div>
        <div ref="inviteLiveLogEl" class="log-box invite-live-log" data-test="invite-live-log">
          <template v-if="inviteCampaignRecords.length">
            <div v-for="record in inviteCampaignRecords.slice(0, 40)" :key="record.id" class="log-line" :class="inviteRecordTone(record)">{{ inviteRecordLine(record) }}</div>
            <div v-if="inviteCampaignRecords.length > 40" class="log-line invite-record-more">…其余 {{ inviteCampaignRecords.length - 40 }} 条记录已保存在批次里</div>
          </template>
          <template v-else-if="inviteCampaignError">
            <div class="log-line log-fail">读取邀约记录失败：{{ inviteCampaignError }}</div>
          </template>
          <template v-else-if="inviteDisplayActive">
            <div v-if="!inviteDisplayLogs.length" class="log-line">等待运行输出…开始邀约后，这里会先显示运行日志，轮末写入逐人结果。</div>
            <div v-for="(log, index) in inviteDisplayLogs" :key="`${inviteDisplayRunId}-${index}`" class="log-line" :class="inviteLogToneClass(inviteLogText(log))">{{ inviteLogText(log) }}</div>
          </template>
          <template v-else>
            <div class="log-line">没有逐人记录{{ inviteDisplayNoRecordHint }}</div>
          </template>
        </div>
      </template>
      </template>
    </div>
    <div class="env-sec invite-unavailable"><div class="env-note">达人邀约配置与平台页面仍沿用真实运行、店铺配置和人工操作边界；未配置时不会伪造可发送结果。</div></div>
  </section>
</template>

<script setup lang="ts">
/**
 * 达人邀约配置 + 运行记录的**唯一视图**（2026-10-25 起只剩店铺浏览器右侧栏；
 * 应用中心的独立邀约页已下线）。视图只接收 `useCreatorInvite` 的返回值，
 * 不自己读写 IPC——状态、校验、启动口径只有一份，验收脚本引用的 data-test 锚点全部保留。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { DOUDIAN_FINDER_MAP, DOUDIAN_FINDER_TYPES, isBatchProfile } from '@shared/constants/invite'
import browserStartIcon from '../../assets/generated/ui-icons/browser-start-gen.png'
import browserStopIcon from '../../assets/generated/ui-icons/browser-stop-gen.png'
import browserRefreshIcon from '../../assets/generated/ui-icons/browser-refresh-gen.png'
import { inviteCampaignOptionText } from './composables/invite-run-labels'
import { invitePanelSteps, nextInvitePanelStep, normalizeInvitePanelStep } from './composables/invite-panel-steps'
import type { CreatorInviteController } from '../workbench/use-creator-invite'

/**
 * 侧栏内置步骤导航（抖店 2 步 / 其余 4 步）；用 v-show 而不是 v-if：
 * 隐藏步骤仍在 DOM 里，验收锚点与已填的值都不会因为切步丢失。
 */
const props = defineProps<{ controller: CreatorInviteController }>()
const emit = defineEmits<{ (event: 'started'): void }>()

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
  inviteCampaign,
  inviteCampaigns,
  inviteCampaignRecords,
  inviteCampaignError,
  inviteSelectedCampaignId,
  selectInviteCampaign,
  inviteDisplayRunId,
  inviteDisplayActive,
  inviteDisplayStatus,
  inviteDisplayTone,
  inviteDisplayCounts,
  inviteDisplayReason,
  inviteDisplaySummary,
  inviteDisplayNoRecordHint,
  inviteDisplayLogs,
  inviteRecordLine,
  inviteRecordTone,
  applyInviteScript,
  saveInviteConfig,
  openInvitePage,
  inviteLogText,
  stopInviteRun,
  startInvite,
  refreshInvite
} = props.controller

/** 候选预览的时效标注：超过 30 分钟提示重新打开广场刷新。 */
const squareCandidates = props.controller.squareCandidates
const candidateAgeText = computed(() => {
  const last = squareCandidates.value[squareCandidates.value.length - 1]
  if (!last?.at) return '刚刚'
  const minutes = Math.round((Date.now() - last.at) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes >= 30) return `已过去 ${minutes} 分钟，建议重新打开广场刷新`
  return `${minutes} 分钟前`
})

/**
 * 抖店达人类型筛选（2026-10-21）：chips 用抖店真实文案；invite.finderType 的存量值
 * 可能是微信口径（如默认「全部带货者」），getter 统一经映射折算成抖店文案再高亮，
 * setter 直接写回抖店文案——主进程 FINDER_MAP 两种口径都认识。
 */
const doudianFinderType = computed<string>({
  get: () => DOUDIAN_FINDER_MAP[invite.finderType] || invite.finderType || '全部达人',
  set: (v) => { invite.finderType = v }
})

/** 定时启动输入已按 2026-10-21 用户要求移除；批次排期能力保留在服务层与批次列表管理中。 */

/**
 * 邀约记录行着色（2026-10-21 用户要求：日志显示邀约记录不显示步骤）。
 * 按行内容判调性：成功绿、跳过黄、失败红，其余默认色。关键词来自任务引擎的实际日志措辞。
 */
function inviteLogToneClass(text: string): string {
  if (/已邀约|邀约成功|发送成功|✓|完成第/.test(text)) return 'log-ok'
  if (/跳过|已沟通过|黑名单|重复/.test(text)) return 'log-skip'
  if (/失败|错误|error|异常|超时|未找到/.test(text)) return 'log-fail'
  return ''
}

/**
 * 步骤显示逻辑（2026-10-25 起只剩侧栏）：
 * 应用中心的独立邀约页已下线，本视图只嵌在店铺浏览器右侧栏（窄容器），
 * 所以固定用内置的紧凑步骤导航、单步显示，不再接受外部 step/layout。
 *
 * 2026-11-01 修复：改版时删掉了 `activeStep` 定义但模板仍在引用，导致步骤不高亮、
 * 「下一步」永远不出现（生产构建不会为 undefined 报错）。现在显式 alias 到 localStep，
 * 并把步数策略抽到 invite-panel-steps（可单测）。
 */
/** 逐人沟通平台（抖店）：一位一轮，没有抽屉表单 → 等级/权益/优势/联系方式/商品数量/话术都不参与执行。 */
const isDoudianContact = computed(() => {
  const profile = inviteProfile.value
  return !!profile && isBatchProfile(profile) && profile.contactOnly === true
})
/** 抖店没有受众/话术页，导航只保留「目标 → 启动」；其他平台仍是四步。 */
const inviteStepTabs = computed(() => invitePanelSteps(isDoudianContact.value))
const localStep = ref(1)
/** 模板里的 `activeStep`：与 localStep 同一份状态（ref 在模板中自动解包）。 */
const activeStep = localStep
/** 只剩侧栏形态；保留常量是为了模板里既有的条件分支不必改动。 */
const isSidebarMode = true
const nextStepN = computed(() => nextInvitePanelStep(localStep.value, isDoudianContact.value))
const nextStepLabel = computed(() => inviteStepTabs.value.find(step => step.n === nextStepN.value)?.label || '')
function goLocalStep(n: number): void {
  localStep.value = normalizeInvitePanelStep(Math.round(Number(n) || 1), isDoudianContact.value)
}
function showStep(step: number): boolean {
  return localStep.value === step
}
// 切平台/店铺后档案可能会变（例如从微信切到抖店），当前步要落到新平台真实存在的步骤上。
watch(inviteStepTabs, tabs => {
  if (!tabs.some(step => step.n === localStep.value)) localStep.value = tabs[0].n
})
// 换了一家店/平台就回到第 1 步：否则切店后直接停在上一家的「启动」页，像是配置丢了。
watch(() => inviteProfile.value?.platform, () => { localStep.value = 1 })
/** 本次计划量：抖店/逐人流按「本次最多」；快手批量按「每批 × 轮次 → 本次总量」 */
const plannedTotal = computed(() => {
  const profile = inviteProfile.value
  if (!profile || !isBatchProfile(profile)) return Math.max(1, Number(invite.maxInvites) || 10)
  return isDoudianContact.value
    ? Math.max(1, Number(invite.count) || 1)
    : Math.max(1, Math.min(500, Number(invite.totalCap) || 200))
})
/** 启动前确认用的筛选摘要：类目路径 + 达人类型（抖店用平台真实 radio 文案）。 */
const inviteScopeSummary = computed(() => {
  const profile = inviteProfile.value
  if (!profile || !isBatchProfile(profile)) return ''
  const path = [invite.category, invite.subcategory, invite.category3].filter(Boolean).join(' / ') || '不限类目'
  // 只有抖店面板真正应用「达人类型」；快手没有这个控件，别拿配置里的旧 finderType 冒充当前筛选。
  const type = profile.platform === '抖店' ? doudianFinderType.value : ''
  return `本次筛选：类目 ${path}${type ? ` · 达人类型 ${type}` : ''}`
})
/** 侧栏日志区折叠（默认展开保持实时反馈；收起时省出一屏空间给表单）。 */
const liveLogCollapsed = ref(false)

async function submit(): Promise<void> {
  if (!await startInvite()) return
  emit('started')
  void refreshInvite()
}

/** 回看历史批次：切到哪条就把详情（含逐人记录）重新读一遍。 */
function onSelectInviteCampaign(event: Event): void {
  const target = event.target as HTMLSelectElement | null
  if (target) selectInviteCampaign(target.value)
}

/**
 * 运行记录按"最新在前"排，自动滚动要回到顶部才是最新一条；
 * 没有逐人记录时的实时日志是时间正序，仍滚到底。只依赖条数/运行变化，不打断用户翻看。
 */
watch(
  () => `${inviteDisplayRunId.value}:${inviteCampaignRecords.value.length}:${inviteDisplayLogs.value.length}`,
  () => {
    void nextTick(() => {
      const el = inviteLiveLogEl.value
      if (!el) return
      el.scrollTop = inviteCampaignRecords.value.length ? 0 : el.scrollHeight
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
/* 步骤导航：步数随平台变化（抖店 2 步，其余 4 步），用 auto columns 而不是写死 repeat(4)。 */
.invite-panel .invite-panel-steps { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 4px; margin-top: 8px; }
.invite-panel .invite-panel-step { display: flex; align-items: center; justify-content: center; gap: 5px; min-height: 27px; padding: 4px 6px; border: 1px solid var(--dash-border); border-radius: 7px; background: var(--dash-surface); color: var(--dash-text-muted); cursor: pointer; font-size: 10px; font-weight: 600; transition: background .12s, color .12s, border-color .12s; }
.invite-panel .invite-panel-step b { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 50%; background: var(--dash-border); color: var(--dash-text); font-size: 9px; }
.invite-panel .invite-panel-step:hover { border-color: var(--dash-text-muted); }
.invite-panel .invite-panel-step.on { border-color: rgba(59,130,246,.55); background: rgba(59,130,246,.14); color: #1d4ed8; }
.invite-panel .invite-panel-step.on b { background: #3b82f6; color: #ffffff; }
.invite-panel .invite-panel-step:focus-visible { outline: 2px solid rgba(59,130,246,.55); outline-offset: 1px; }
.invite-panel-next { display: flex; justify-content: flex-end; margin-top: 10px; }
/* 运行状态卡：颜色跟状态走，不再把「已完成/执行失败」都画成橙色警告。 */
.invite-live-status { padding: 7px 9px; border: 1px solid rgba(148,163,184,.32); border-radius: 7px; background: rgba(148,163,184,.1); color: var(--dash-text-soft); font-size: 10px; line-height: 1.45; }
.invite-live-status b { font-weight: 700; }
.invite-live-status.active { border-color: rgba(59,130,246,.35); background: rgba(59,130,246,.1); color: #1d4ed8; }
.invite-live-status.ok { border-color: rgba(16,185,129,.3); background: rgba(16,185,129,.1); color: #027a48; }
.invite-live-status.warn { border-color: rgba(242,165,87,.28); background: rgba(245,158,11,.12); color: #92400e; }
.invite-live-status.fail { border-color: rgba(217,45,32,.28); background: rgba(217,45,32,.08); color: #b42318; }
.invite-live-reason { color: #b42318; overflow-wrap: anywhere; }
.invite-campaign-picker { display: flex; align-items: center; gap: 6px; margin-top: 6px; color: var(--dash-text-muted); font-size: 10px; }
.invite-campaign-picker select { min-width: 0; flex: 1; height: 26px; padding: 0 6px; border: 1px solid var(--dash-border); border-radius: 6px; background: #ffffff; color: var(--dash-text-soft); font: inherit; font-size: 9.5px; }
.invite-live-summary { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin: 6px 0 4px; color: var(--dash-text-soft); font-size: 10px; line-height: 1.45; }
.invite-live-summary > span:first-child { min-width: 0; overflow-wrap: anywhere; }
.invite-live-log { max-height: 260px; }
.invite-record-more { color: var(--dash-text-muted); }
.invite-live-log .log-line.log-ok { color: #027a48; }
.invite-live-log .log-line.log-skip { color: #b54708; }
.invite-live-log .log-line.log-fail { color: #b42318; }
.step-row { display: flex; align-items: flex-start; gap: 7px; padding: 7px 0 0 3px; }
.s-ico { width: 17px; flex: 0 0 17px; text-align: center; font-size: 11px; }
.tc-btns { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
.invite-message { padding: 5px 0 2px; line-height: 1.5; white-space: normal; }
.log-box { max-height: 210px; margin-top: 8px; padding: 7px 8px; overflow-y: auto; border: 1px solid var(--dash-border); border-radius: 7px; background: #f7f9fd; }
.log-line { color: #4a5568; font-family: Consolas, monospace; font-size: 9px; line-height: 1.6; overflow-wrap: anywhere; }
.invite-unavailable { padding: 10px 2px; border-bottom: 0; }
.invite-backend-note { color: #4c1d95; }
.invite-scope-summary { margin-top: 8px; color: var(--dash-text-soft); overflow-wrap: anywhere; }
.invite-contact-note { margin-top: 6px; padding: 7px 9px; border: 1px solid rgba(124,92,255,.22); border-radius: 7px; background: rgba(124,92,255,.07); color: #4c1d95; }

</style>
