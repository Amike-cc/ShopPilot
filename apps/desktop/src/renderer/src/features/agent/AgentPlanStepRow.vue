<template>
  <article class="plan-step-row">
    <header class="step-head">
      <span class="step-index">{{ index + 1 }}</span>
      <span class="step-type">{{ step.type }}</span>
      <span class="risk-tag" :class="step.risk">{{ riskLabel }}</span>
      <span v-if="step.requiresConfirmation" class="confirm-tag">需人工确认</span>
      <button class="remove-step" type="button" :disabled="disabled" title="删除此步骤" aria-label="删除此步骤" @click="$emit('remove')">×</button>
    </header>
    <label class="field-label">步骤说明<input :value="step.description" :disabled="disabled" maxlength="120" @input="setDescription(($event.target as HTMLInputElement).value)" /></label>
    <div v-if="fieldKey" class="field-label">
      <label :for="fieldId">{{ fieldLabel }}</label>
      <textarea v-if="fieldKey === 'message'" :id="fieldId" :value="fieldText" :disabled="disabled" maxlength="500" rows="2" @input="setInput(fieldKey, ($event.target as HTMLTextAreaElement).value)" />
      <input v-else :id="fieldId" :value="fieldText" :disabled="disabled" :type="fieldKey === 'url' ? 'url' : 'text'" maxlength="500" :list="optionListId" @input="setInput(fieldKey, ($event.target as HTMLInputElement).value)" />
      <datalist v-if="options.length" :id="optionListId"><option v-for="item in options" :key="item" :value="item" /></datalist>
    </div>
    <label v-if="step.type === 'waitMs'" class="field-label">等待毫秒
      <input type="number" min="100" max="120000" :value="Number(step.input.ms || 1000)" :disabled="disabled" @input="setInput('ms', Number(($event.target as HTMLInputElement).value))" />
    </label>
    <div class="step-limits">
      <label>超时 <input type="number" min="500" :max="step.type === 'waitForUserConfirmation' ? 3600000 : 120000" :value="step.timeoutMs" :disabled="disabled" @input="setStep({ timeoutMs: Number(($event.target as HTMLInputElement).value) })" /> ms</label>
      <label>重试 <input type="number" min="0" max="1" :value="step.retryLimit" :disabled="disabled || step.requiresConfirmation" @input="setStep({ retryLimit: Number(($event.target as HTMLInputElement).value) })" /></label>
    </div>
    <p v-if="step.requiresConfirmation" class="confirm-explain">执行前会停在任务确认门禁；拒绝后 TaskRunner 会取消任务并停止后续步骤。</p>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { AgentPageObservation, AgentPlanStep } from '@shared/schemas/agent'

const props = defineProps<{ step: AgentPlanStep; index: number; observation: AgentPageObservation | null; disabled?: boolean }>()
const emit = defineEmits<{ update: [step: AgentPlanStep]; remove: [] }>()
const fieldId = computed(() => `agent-step-${props.index}-field`)
const optionListId = computed(() => `agent-step-${props.index}-options`)
const fieldKey = computed(() => ({
  navigate: 'url', waitForPage: 'urlIncludes', waitForSelector: 'selector', waitForGone: 'selector',
  readText: 'selector', readTable: 'selector', readLabelValue: 'label', click: 'selector',
  clickByText: 'text', waitForUserConfirmation: 'message'
} as Record<string, string>)[props.step.type] || '')
const fieldLabel = computed(() => ({ url: '导航地址（同源）', urlIncludes: '等待 URL 包含', selector: 'Selector', label: '读取标签', text: '按钮文案', message: '人工确认提示' } as Record<string, string>)[fieldKey.value] || fieldKey.value)
const fieldText = computed(() => String(props.step.input[fieldKey.value] ?? ''))
const options = computed(() => {
  if (fieldKey.value === 'text') return props.observation?.buttons.map(button => button.text) || []
  if (fieldKey.value === 'selector' && props.step.type === 'readTable') return props.observation?.tables.map(table => table.selector) || []
  if (fieldKey.value === 'selector') return props.observation?.selectorCandidates || []
  return []
})
const riskLabel = computed(() => ({ read: '读取', write: '写入/点击', submit: '提交/不可逆' })[props.step.risk])
function setDescription(description: string) { emit('update', { ...props.step, description }) }
function setInput(key: string, value: unknown) { emit('update', { ...props.step, input: { ...props.step.input, [key]: value } }) }
function setStep(patch: Partial<AgentPlanStep>) { emit('update', { ...props.step, ...patch }) }
</script>

<style scoped>
.plan-step-row { border:1px solid var(--color-border);border-radius:9px;padding:9px;background:rgba(255,255,255,.025); }
.step-head { display:flex;align-items:center;gap:6px;margin-bottom:8px; }
.step-index { display:grid;place-items:center;width:21px;height:21px;border-radius:7px;background:rgba(104,112,225,.2);color:#c4c2ff;font-size:10px;font-weight:700; }
.step-type { color:var(--color-text-primary);font-size:11px;font-weight:700; }
.risk-tag,.confirm-tag { border-radius:20px;padding:3px 6px;font-size:9px;white-space:nowrap; }
.risk-tag.read { background:rgba(35,160,123,.14);color:#84dbbd; }.risk-tag.write { background:rgba(224,161,53,.16);color:#efca7e; }.risk-tag.submit { background:rgba(223,91,87,.17);color:#ffa8a0; }
.confirm-tag { background:rgba(239,181,60,.14);color:#f0c96d; }
.remove-step { margin-left:auto;border:0;border-radius:6px;width:23px;height:23px;background:transparent;color:#c2c4d1;font-size:17px;cursor:pointer; }.remove-step:hover { background:rgba(220,80,80,.18);color:#ffaaa6; }
.field-label { display:block;margin-top:8px;color:var(--color-text-secondary);font-size:10px; }
.field-label input,.field-label textarea { display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:7px 8px;border:1px solid var(--color-border);border-radius:6px;background:rgba(9,12,24,.35);color:var(--color-text-primary);font:inherit;font-size:11px; }
.field-label textarea { resize:vertical; }.field-label input:focus,.field-label textarea:focus { outline:1px solid #7776e8; }
.step-limits { display:flex;gap:12px;margin-top:8px;color:var(--color-text-secondary);font-size:10px; }
.step-limits input { width:75px;margin:0 3px;padding:4px 5px;border:1px solid var(--color-border);border-radius:5px;background:rgba(9,12,24,.35);color:var(--color-text-primary);font:inherit;font-size:10px; }
.confirm-explain { margin:7px 0 0;color:#e9bf69;font-size:10px;line-height:1.5; }
button:disabled,input:disabled,textarea:disabled { opacity:.58; }
</style>
