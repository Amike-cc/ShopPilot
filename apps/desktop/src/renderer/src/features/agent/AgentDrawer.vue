<template>
  <section class="agent-drawer" role="dialog" aria-modal="false" aria-label="智能体助手">
    <header class="agent-header">
      <div class="agent-title-mark">✦</div>
      <div class="agent-title"><strong>智能体</strong><span :class="['agent-presence', { working: agent.busy || ['running','waiting_confirmation'].includes(agent.status) }]">{{ presenceLabel }}</span></div>
      <button class="agent-close" type="button" aria-label="关闭智能体面板" title="关闭智能体" @click="$emit('close')">×</button>
    </header>
    <div class="agent-context-strip">
      <div><span class="context-icon">应</span><span class="context-main">智能体 · {{ storeCountLabel }}</span></div>
      <div><span class="context-icon">店</span><span class="context-main">当前店铺：{{ storeName || '未选择店铺' }}</span></div>
      <div><span class="context-icon">页</span><span class="context-main">{{ tabTitle || '无活动标签页' }}</span></div>
      <div class="drawer-url" :title="displayUrl">{{ displayUrl || '无页面地址' }}</div>
    </div>
    <nav class="agent-shortcuts" aria-label="智能体快捷操作">
      <button type="button" :disabled="agent.busy || !storeName" :title="storeName ? '新建任务' : '需要先打开店铺才能做页面任务'" @click="agent.newTask(); focusComposer()">＋ 新建任务</button>
      <button type="button" :disabled="agent.busy || !storeName" :title="storeName ? '观察页面' : '需要先打开店铺才能观察页面'" @click="agent.observePage()">⌕ 观察页面</button>
      <button type="button" :disabled="agent.busy" @click="agent.refreshSoftwareContext()">▦ 查看软件</button>
      <button type="button" @click="$emit('view-tasks')">☷ 查看任务</button>
    </nav>
    <div ref="scrollArea" class="agent-scroll-area">
      <details v-if="agent.observation?.screenshot.available && agent.observation.screenshot.dataUrl" class="agent-preview">
        <summary>本次页面截图预览 · 临时保留</summary>
        <img :src="agent.observation.screenshot.dataUrl" alt="当前页面截图预览" />
      </details>
      <AgentMessageList :messages="agent.messages" :busy="agent.busy" :status-label="agent.stateLabel" />
      <div v-if="agent.error" class="agent-error" role="alert"><strong>{{ agent.error.code }}</strong><span>{{ agent.error.message }}</span></div>
      <section v-if="agent.softwareContext" class="agent-software-context">
        <div class="software-context-head"><strong>软件上下文</strong><span>{{ openStoreCount }}/{{ storeCount }} 店铺已打开 · {{ agent.softwareContext.agents.length }} 子 Agent · {{ agent.softwareContext.jobs.length }} Job · {{ agent.softwareContext.skills.length }} 技能 · {{ agent.softwareContext.recentTasks.length }} 个任务</span></div>
        <div class="software-context-stores">
          <span v-for="store in agent.softwareContext.stores.slice(0, 6)" :key="store.id" :class="['software-store-chip', { current: store.isDisplayed }]" :title="store.name">{{ store.name }}<i>{{ store.isOpen ? '●' : '○' }}</i></span>
          <span v-if="agent.softwareContext.stores.length > 6" class="software-store-more">+{{ agent.softwareContext.stores.length - 6 }}</span>
        </div>
        <div class="software-context-stores">
          <span v-for="item in agent.softwareContext.agents.slice(0, 6)" :key="item.id" class="software-store-chip" :title="`${item.name} · ${item.role} · ${item.status}`">{{ item.name }}<i>{{ item.status === 'active' ? '●' : '○' }}</i></span>
          <span v-if="agent.softwareContext.agents.length > 6" class="software-store-more">+{{ agent.softwareContext.agents.length - 6 }}</span>
        </div>
        <div v-if="agent.softwareContext.skills.length" class="software-context-stores">
          <span v-for="skill in agent.softwareContext.skills.slice(0, 6)" :key="skill.id" class="software-store-chip" :title="`技能：${skill.name} · ${skill.stepCount} 步`">{{ skill.name }}<i>⚙</i></span>
          <span v-if="agent.softwareContext.skills.length > 6" class="software-store-more">+{{ agent.softwareContext.skills.length - 6 }}</span>
        </div>
      </section>
      <AgentSoftwarePlanCard v-if="agent.softwarePlan" :plan="agent.softwarePlan" :busy="agent.busy" @update:plan="agent.softwarePlan = $event" @execute="agent.executeSoftwarePlan()" @cancel="agent.clearPlan()" />
      <AgentPlanCard v-if="agent.plan" :plan="agent.plan" :observation="agent.observation" :busy="agent.busy" @update:plan="agent.plan = $event" @create="agent.validateCreate($event)" @cancel="agent.clearPlan()" />
      <section v-if="agent.task" class="agent-task-card">
        <header class="task-card-head"><div><strong>{{ agent.task.name }}</strong><span>{{ agent.task.status }}</span></div><button v-if="!agent.task.id.startsWith('ajob_')" type="button" @click="$emit('view-task', agent.task?.id)">查看任务详情</button></header>
        <div class="task-identifiers">执行子 Agent：{{ agent.task.executorName }}<br />Job {{ agent.task.jobId }}<span v-if="!agent.task.id.startsWith('ajob_')"><br />任务 {{ agent.task.id }}</span><br />运行 {{ agent.task.runId || '尚未运行' }}</div>
        <div class="task-progress-track"><span :style="{ width: `${progressPercent}%` }"></span></div>
        <div class="task-progress-meta"><span>{{ agent.task.currentStep == null ? '等待步骤' : `步骤 ${agent.task.currentStep + 1} / ${agent.task.totalSteps}` }}</span><span>{{ progressPercent }}%</span></div>
        <p class="task-message">{{ agent.task.message }}</p>
        <div v-if="agent.task.confirmation" class="agent-confirm-card">
          <strong>等待人工确认</strong><p>{{ agent.task.confirmation.message }}</p>
          <div><button class="approve" :disabled="agent.busy" @click="agent.confirmTask(true)">确认继续</button><button :disabled="agent.busy" @click="agent.confirmTask(false)">拒绝并取消</button></div>
        </div>
        <div v-if="agent.task.errorCode || agent.task.errorMessage" class="task-error"><strong>{{ agent.task.errorCode || 'TASK_ERROR' }}</strong><span>{{ agent.task.errorMessage }}</span></div>
        <div class="task-ops">
          <button v-if="!['succeeded','failed','cancelled','expired'].includes(agent.task.status)" :disabled="agent.busy" @click="agent.cancelJob()">取消 Job</button>
          <button v-if="['succeeded','failed','cancelled'].includes(agent.task.status)" :disabled="agent.busy" @click="agent.refreshJob()">刷新结果</button>
        </div>
        <div v-if="agent.task.results" class="task-results">
          <strong>TaskRunner 结果</strong>
          <div v-for="result in agent.task.results.results" :key="result.id" class="task-result-item">
            <span class="result-kind">{{ result.kind }}</span>
            <span v-if="result.kind === 'text'">{{ result.payload?.text ?? result.summary }}</span>
            <span v-else-if="result.kind === 'table'">表头：{{ (result.payload?.headers || []).join(' · ') || '无' }}；行数：{{ result.payload?.rowCount ?? '未知' }}</span>
            <span v-else-if="result.kind === 'screenshot'">截图工件：{{ result.artifactPath || result.summary }}</span>
            <span v-else>{{ result.summary }}</span>
          </div>
        </div>
      </section>
    </div>
    <AgentComposer ref="composer" :disabled="agent.busy" @send="agent.generatePlan" />
    <footer class="agent-footer">AI Key 仅存于主进程 · 智能体负责对话与软件操作，页面任务由子 Agent 通过现有 TaskRunner 执行</footer>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { sanitizeAgentUrl } from '@shared/agent-privacy'
import { useAgentStore } from '../../stores/agent'
import AgentComposer from './AgentComposer.vue'
import AgentMessageList from './AgentMessageList.vue'
import AgentPlanCard from './AgentPlanCard.vue'
import AgentSoftwarePlanCard from './AgentSoftwarePlanCard.vue'

const props = defineProps<{ storeName: string; tabTitle: string; currentUrl: string }>()
const agent = useAgentStore()
const scrollArea = ref<HTMLElement | null>(null)
const composer = ref<{ $el: HTMLElement } | null>(null)
const displayUrl = computed(() => sanitizeAgentUrl(props.currentUrl))
const storeCount = computed(() => agent.softwareContext?.stores.length || 0)
const openStoreCount = computed(() => agent.softwareContext?.stores.filter(store => store.isOpen).length || 0)
const storeCountLabel = computed(() => storeCount.value ? `${storeCount.value} 家店铺可操作` : '等待店铺上下文')
const presenceLabel = computed(() => agent.busy ? agent.stateLabel : agent.aiConfigured === false ? 'AI 未配置' : agent.aiConfigured ? agent.stateLabel : '就绪')
const progressPercent = computed(() => {
  if (!agent.task?.totalSteps || agent.task.currentStep == null) return agent.task?.status === 'succeeded' ? 100 : 0
  return Math.min(100, Math.round(((agent.task.currentStep + (agent.task.status === 'succeeded' ? 1 : 0)) / agent.task.totalSteps) * 100))
})
function focusComposer() { void nextTick(() => composer.value?.$el?.querySelector('textarea')?.focus()) }
const emit = defineEmits<{ close: []; 'view-tasks': []; 'view-task': [taskId?: string] }>()
function onEscape(event: KeyboardEvent) { if (event.key === 'Escape') { event.preventDefault(); emit('close') } }
watch(() => agent.messages.length, () => nextTick(() => { if (scrollArea.value) scrollArea.value.scrollTop = scrollArea.value.scrollHeight }), { flush: 'post' })
onMounted(() => window.addEventListener('keydown', onEscape))
onBeforeUnmount(() => window.removeEventListener('keydown', onEscape))
</script>

<style scoped>
.agent-drawer { position:relative;display:flex;flex-direction:column;min-width:0;width:100%;height:100%;overflow:hidden;color:var(--color-text-primary);background:var(--color-bg-secondary); }
.agent-header { display:flex;align-items:center;gap:9px;flex:0 0 auto;padding:9px 12px;border-bottom:1px solid var(--color-border); }.agent-title-mark { display:grid;place-items:center;width:30px;height:30px;border-radius:10px;background:linear-gradient(145deg,#2e86e9,#8150d9);color:white;font-size:18px; }.agent-title { display:flex;flex-direction:column;gap:2px; }.agent-title strong { font-size:13px; }.agent-presence { color:#77c9ac;font-size:9px; }.agent-presence.working { color:#eac36b; }.agent-close { margin-left:auto;width:26px;height:26px;border:0;border-radius:7px;background:transparent;color:var(--color-text-secondary);font-size:18px;cursor:pointer; }
.agent-context-strip { flex:0 0 auto;padding:8px 12px;border-bottom:1px solid var(--color-border); }.agent-context-strip>div { display:flex;align-items:center;gap:7px;margin:3px 0;font-size:10px; }.context-icon { display:grid;place-items:center;flex:0 0 18px;height:18px;border-radius:5px;background:rgba(121,102,222,.15);color:#c8c0ff;font-size:9px; }.context-main { overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--color-text-primary); }.drawer-url { margin:5px 0 0 25px;color:var(--color-text-muted);font-size:9px;overflow-wrap:anywhere;line-height:1.4; }
.agent-shortcuts { flex:0 0 auto;display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--color-border); }.agent-shortcuts button,.task-card-head button { border:1px solid var(--color-border);border-radius:7px;padding:6px 7px;background:rgba(255,255,255,.035);color:var(--color-text-secondary);font-size:10px;white-space:nowrap;cursor:pointer; }.agent-shortcuts button:disabled { opacity:.45;cursor:default; }
.agent-software-context { margin:6px 10px 8px;padding:8px;border:1px solid rgba(101,119,190,.3);border-radius:9px;background:rgba(80,96,171,.08); }.software-context-head { display:flex;justify-content:space-between;gap:8px;align-items:baseline; }.software-context-head strong { font-size:10px; }.software-context-head span { color:var(--color-text-muted);font-size:9px; }.software-context-stores { display:flex;flex-wrap:wrap;gap:5px;margin-top:7px; }.software-store-chip,.software-store-more { max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:4px 6px;border:1px solid var(--color-border);border-radius:6px;color:var(--color-text-muted);font-size:9px; }.software-store-chip.current { border-color:rgba(123,109,225,.8);color:var(--color-text-primary); }.software-store-chip i { margin-left:4px;color:#75c9a2;font-style:normal;font-size:8px; }.software-store-more { color:#b9b0f4; }
.agent-preview { margin:8px 10px 2px;padding:7px;border:1px solid var(--color-border);border-radius:8px;color:var(--color-text-secondary);font-size:10px; }.agent-preview summary { cursor:pointer; }.agent-preview img { display:block;width:100%;height:auto;max-height:220px;object-fit:contain;margin-top:7px;border-radius:5px;background:#10121a; }
.agent-scroll-area { flex:1 1 auto;min-height:80px;overflow:auto;padding-bottom:68px;scroll-behavior:smooth; }.agent-error,.task-error { display:flex;flex-direction:column;gap:4px;margin:4px 10px 8px;padding:9px;border:1px solid rgba(225,92,92,.34);border-radius:8px;background:rgba(150,43,43,.11);color:#ffb7b0;font-size:10px;overflow-wrap:anywhere; }.agent-error strong,.task-error strong { font-size:10px; }
.agent-task-card { margin:4px 10px 10px;padding:10px;border:1px solid var(--color-border);border-radius:10px;background:rgba(255,255,255,.025); }.task-card-head { display:flex;justify-content:space-between;align-items:center;gap:8px; }.task-card-head>div { min-width:0;display:flex;flex-direction:column;gap:3px; }.task-card-head strong { font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }.task-card-head span,.task-identifiers { color:var(--color-text-muted);font-size:9px; }.task-identifiers { margin-top:7px;line-height:1.5;overflow-wrap:anywhere; }.task-progress-track { height:5px;margin-top:8px;border-radius:5px;background:rgba(255,255,255,.08);overflow:hidden; }.task-progress-track span { display:block;height:100%;border-radius:5px;background:linear-gradient(90deg,#3697ec,#9a65e7);transition:width .2s; }.task-progress-meta { display:flex;justify-content:space-between;margin-top:4px;color:var(--color-text-muted);font-size:9px; }.task-message { margin:6px 0;color:var(--color-text-secondary);font-size:10px;line-height:1.5; }
.agent-confirm-card { margin-top:8px;padding:9px;border:1px solid rgba(239,189,78,.5);border-radius:8px;background:rgba(214,161,41,.1); }.agent-confirm-card strong { color:#f4cf78;font-size:11px; }.agent-confirm-card p { max-height:75px;overflow:auto;color:var(--color-text-primary);font-size:10px;line-height:1.5; }.agent-confirm-card>div { display:flex;gap:6px; }.agent-confirm-card button,.task-ops button { border:1px solid var(--color-border);border-radius:6px;padding:6px 8px;background:rgba(255,255,255,.06);color:var(--color-text-primary);font-size:10px;cursor:pointer; }.agent-confirm-card .approve { border:0;background:#39896e; }.task-ops { display:flex;gap:6px;flex-wrap:wrap;margin-top:7px; }.task-ops button:disabled,.agent-confirm-card button:disabled { opacity:.5; }
.task-results { display:flex;flex-direction:column;gap:6px;margin-top:9px;padding-top:8px;border-top:1px solid var(--color-border); }.task-results>strong { font-size:10px; }.task-result-item { display:flex;align-items:flex-start;gap:6px;color:var(--color-text-secondary);font-size:9px;line-height:1.5;overflow-wrap:anywhere; }.result-kind { flex:0 0 48px;color:#aaa1f2; }
.agent-composer { flex:0 0 auto;margin:5px 10px 0; }.agent-footer { flex:0 0 auto;padding:5px 12px 8px;color:var(--color-text-muted);font-size:9px;text-align:center; }
</style>
