<template>
  <section class="agent-plan-card">
    <header class="plan-card-head"><div><span class="plan-kicker">派发前预览</span><h3>任务计划</h3></div><button type="button" class="plan-cancel-x" title="取消计划" @click="$emit('cancel')"><img :src="closeIcon" alt="" /></button></header>
    <div class="plan-context">
      <div class="context-line"><span>店铺</span><strong>{{ draft.storeName }}</strong></div>
      <div class="context-line"><span>页面</span><strong>{{ draft.pageTitle || draft.currentUrl || '当前标签页' }}</strong></div>
      <div class="context-url" :title="draft.currentUrl">{{ draft.currentUrl || '无 URL' }}</div>
    </div>
    <label class="plan-field">任务目标<textarea :value="draft.goal" maxlength="500" rows="2" :disabled="locked" @input="setPlan({ goal: ($event.target as HTMLTextAreaElement).value })" /></label>
    <label class="plan-field">任务名称<input :value="draft.name" maxlength="80" :disabled="locked" @input="setPlan({ name: ($event.target as HTMLInputElement).value })" /></label>
    <div class="steps-title"><strong>预计步骤（{{ draft.steps.length }}）</strong><span>类型、风险和确认门禁由 Main 校验</span></div>
    <div class="steps-list">
      <AgentPlanStepRow v-for="(step, index) in draft.steps" :key="step.id" :step="step" :index="index" :observation="observation" :disabled="locked" @update="replaceStep(index, $event)" @remove="removeStep(index)" />
    </div>
    <button class="add-read-step" type="button" :disabled="locked || proposalStepCount >= 12 || draft.steps.length >= 25" @click="addReadStep">＋ 添加读取标题步骤</button>
    <div class="schedule-box">
      <label class="schedule-toggle"><input type="checkbox" :checked="!!draft.schedule" :disabled="locked" @change="toggleSchedule(($event.target as HTMLInputElement).checked)" />重复调度</label>
      <label v-if="draft.schedule" class="schedule-interval">每隔 <input type="number" min="1" max="43200" :value="Math.round(draft.schedule.everyMs / 60000)" :disabled="locked" @input="setInterval(Number(($event.target as HTMLInputElement).value))" /> 分钟执行</label>
      <p v-if="draft.schedule" class="schedule-note">使用现有任务调度器；店铺未打开时按项目现有规则等待，不会静默打开浏览器。</p>
    </div>
    <div v-if="draft.requiresConfirmation" class="plan-confirm-note"><img :src="warningIcon" alt="" />此计划含 {{ draft.steps.filter(step => step.requiresConfirmation).length }} 个执行前人工确认门禁。</div>
    <div class="plan-actions">
      <button type="button" class="secondary" :disabled="busy" @click="$emit('cancel')">取消</button>
      <button type="button" class="secondary" :disabled="busy || locked" @click="$emit('create', false)">仅派发（不执行）</button>
      <button type="button" class="primary" :disabled="busy || locked" @click="$emit('create', true)">{{ busy ? '处理中…' : '派发并执行' }}</button>
    </div>
    <p class="plan-footnote">计划未经确认不会运行。提交、发送、发布、删除、付款等点击前会停下等待人工确认。</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AgentPlanStepRow from './AgentPlanStepRow.vue'
import type { AgentPageObservation, AgentPlan, AgentPlanStep } from '@shared/schemas/agent'
import closeIcon from '../../assets/generated/ui-icons/close.png'
import warningIcon from '../../assets/generated/ui-icons/warning.png'

const props = defineProps<{ plan: AgentPlan; observation: AgentPageObservation | null; busy?: boolean }>()
const emit = defineEmits<{ 'update:plan': [plan: AgentPlan]; create: [run: boolean]; cancel: [] }>()
const draft = ref<AgentPlan>(copy(props.plan))
const locked = ref(false)
const proposalStepCount = computed(() => draft.value.steps.filter(step => !['useTab', 'waitForUserConfirmation'].includes(step.type)).length)
watch(() => props.plan, value => { draft.value = copy(value) }, { deep: true })
watch(() => draft.value.status, value => { locked.value = !['draft', 'validated'].includes(value) }, { immediate: true })
function copy(plan: AgentPlan): AgentPlan { return JSON.parse(JSON.stringify(plan)) }
function publish(next: AgentPlan) { draft.value = next; emit('update:plan', next) }
function setPlan(patch: Partial<AgentPlan>) { publish({ ...draft.value, ...patch }) }
function replaceStep(index: number, step: AgentPlanStep) { const steps = draft.value.steps.slice(); steps[index] = step; publish({ ...draft.value, steps }) }
function removeStep(index: number) { const steps = draft.value.steps.filter((_, i) => i !== index); publish({ ...draft.value, steps, requiresConfirmation: steps.some(step => step.requiresConfirmation) }) }
function addReadStep() {
  const step: AgentPlanStep = { id: `manual-${Date.now()}`, type: 'readText', input: { selector: 'title', privacyRedact: true }, description: '读取当前页面标题', risk: 'read', requiresConfirmation: false, timeoutMs: 15000, retryLimit: 0 }
  publish({ ...draft.value, steps: [...draft.value.steps, step] })
}
function toggleSchedule(enabled: boolean) { publish({ ...draft.value, schedule: enabled ? { everyMs: 3600000 } : null }) }
function setInterval(minutes: number) { publish({ ...draft.value, schedule: { everyMs: Math.min(Math.max(Math.round(minutes || 1), 1), 43200) * 60000 } }) }
</script>

<style scoped>
.agent-plan-card { flex:0 0 auto;margin:0 10px 8px;padding:11px;border:1px solid rgba(130,119,235,.45);border-radius:11px;background:linear-gradient(160deg,rgba(57,74,143,.13),rgba(44,37,79,.12)); }
.plan-card-head { display:flex;justify-content:space-between;align-items:center;margin-bottom:8px; }.plan-kicker { color:#a6a0f8;font-size:9px;letter-spacing:.08em;text-transform:uppercase; }.plan-card-head h3 { margin:2px 0;color:var(--color-text-primary);font-size:14px; }
.plan-cancel-x { display:grid;place-items:center;width:24px;height:24px;border:0;border-radius:6px;background:transparent;cursor:pointer; }.plan-cancel-x img { width:16px;height:16px;object-fit:contain; }
.plan-context { border-radius:7px;padding:8px;background:#f2f4f8; }.context-line { display:flex;gap:8px;margin-bottom:5px;font-size:10px; }.context-line span { flex:0 0 32px;color:var(--color-text-muted); }.context-line strong { color:var(--color-text-primary);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }.context-url { color:var(--color-text-muted);font-size:9px;overflow-wrap:anywhere;line-height:1.4; }
.plan-field { display:block;margin-top:8px;color:var(--color-text-secondary);font-size:10px; }.plan-field input,.plan-field textarea { display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:7px 8px;border:1px solid var(--color-border);border-radius:6px;background:rgba(9,12,24,.32);color:var(--color-text-primary);font:inherit;font-size:11px; }.plan-field textarea { resize:vertical; }
.steps-title { display:flex;justify-content:space-between;gap:6px;align-items:center;margin:12px 0 7px;color:var(--color-text-primary);font-size:11px; }.steps-title span { color:var(--color-text-muted);font-size:9px; }.steps-list { display:flex;flex-direction:column;gap:7px;max-height:230px;overflow:auto; }
.add-read-step { margin-top:7px;border:1px dashed var(--color-border);border-radius:7px;padding:6px 8px;background:transparent;color:var(--color-text-secondary);font-size:10px;cursor:pointer; }.add-read-step:disabled { opacity:.5; }
.schedule-box { display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:10px;padding-top:8px;border-top:1px solid var(--color-border);font-size:10px;color:var(--color-text-secondary); }.schedule-toggle { display:flex;gap:5px;align-items:center; }.schedule-interval input { width:66px;margin:0 4px;padding:5px;border:1px solid var(--color-border);border-radius:5px;background:#ffffff;color:var(--color-text-primary); }.schedule-note { flex-basis:100%;margin:0;color:var(--color-text-muted);font-size:9px;line-height:1.45; }
.plan-confirm-note { display:flex;align-items:center;gap:5px;margin-top:8px;color:#b54708;font-size:10px;line-height:1.5; }.plan-confirm-note img { width:15px;height:15px;object-fit:contain;flex:0 0 auto; }.plan-actions { display:flex;gap:6px;margin-top:10px; }.plan-actions button { flex:1;min-width:0;border:1px solid var(--color-border);border-radius:7px;padding:7px 5px;background:#f2f4f8;color:var(--color-text-primary);font-size:10px;cursor:pointer; }.plan-actions .primary { border:0;background:linear-gradient(120deg,#3985ea,#7954d9);font-weight:700; }.plan-actions button:disabled { opacity:.5;cursor:default; }.plan-footnote { margin:7px 0 0;color:var(--color-text-muted);font-size:9px;line-height:1.45; }
</style>
