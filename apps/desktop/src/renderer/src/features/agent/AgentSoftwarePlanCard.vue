<template>
  <section class="agent-software-plan-card">
    <header class="plan-card-head">
      <div><span class="plan-kicker">软件操作预览</span><h3>{{ draft.name }}</h3></div>
      <button type="button" class="plan-cancel-x" title="取消计划" @click="$emit('cancel')">×</button>
    </header>
    <div class="software-plan-note">智能体只会调用 ShopPilot 已有的店铺、标签页、任务和子 Agent 能力（组织变更需确认），不会修改源码或访问文件。</div>
    <label class="plan-field">操作目标<textarea :value="draft.goal" maxlength="500" rows="2" readonly /></label>
    <div class="steps-title"><strong>预计操作（{{ draft.steps.length }}）</strong><span>执行前由 Main 再次校验</span></div>
    <ol class="software-steps">
      <li v-for="(step, index) in draft.steps" :key="step.id" class="software-step">
        <span class="step-index">{{ index + 1 }}</span>
        <div class="step-copy"><strong>{{ step.description }}</strong><span>{{ actionLabel(step.action.type) }} · {{ step.risk === 'write' ? '需确认' : '只读' }}</span></div>
      </li>
    </ol>
    <div v-if="draft.requiresConfirmation" class="plan-confirm-note">⚠ 此操作会改变软件状态，点击执行即代表你确认继续。</div>
    <div class="plan-actions">
      <button type="button" class="secondary" :disabled="busy" @click="$emit('cancel')">取消</button>
      <button type="button" class="primary" :disabled="busy || locked" @click="$emit('execute')">{{ busy ? '处理中…' : draft.requiresConfirmation ? '确认并执行' : '执行软件操作' }}</button>
    </div>
    <p class="plan-footnote">执行完成后会刷新软件级上下文；结果以 Main 返回的真实状态为准。</p>
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { AGENT_TOOL_LABELS } from '@shared/agent-tool-labels'
import type { AgentSoftwareActionType, AgentSoftwarePlan } from '@shared/schemas/agent'

const props = defineProps<{ plan: AgentSoftwarePlan; busy?: boolean }>()
defineEmits<{ 'update:plan': [plan: AgentSoftwarePlan]; execute: []; cancel: [] }>()
const draft = ref<AgentSoftwarePlan>(copy(props.plan))
const locked = ref(false)
watch(() => props.plan, value => { draft.value = copy(value) }, { deep: true })
watch(() => draft.value.status, value => { locked.value = !['draft', 'validated'].includes(value) }, { immediate: true })
function copy(plan: AgentSoftwarePlan): AgentSoftwarePlan { return JSON.parse(JSON.stringify(plan)) }
/**
 * 动作名来自共享的纯数据表（74 项全覆盖）：之前是 14 项的局部映射 + 强转，
 * 新增工具在计划卡上会显示成 "undefined · 需确认"。
 * 用 @shared/agent-tool-labels 而不是 @shared/agent-tools：后者会连带 node:crypto，浏览器构建过不去。
 */
function actionLabel(type: AgentSoftwareActionType): string {
  return AGENT_TOOL_LABELS[type] || type
}
</script>

<style scoped>
.agent-software-plan-card { flex:0 0 auto;margin:0 10px 8px;padding:11px;border:1px solid rgba(130,119,235,.45);border-radius:11px;background:linear-gradient(160deg,rgba(57,74,143,.13),rgba(44,37,79,.12)); }
.plan-card-head { display:flex;justify-content:space-between;align-items:center;margin-bottom:8px; }.plan-kicker { color:#a6a0f8;font-size:9px;letter-spacing:.08em;text-transform:uppercase; }.plan-card-head h3 { margin:2px 0;color:var(--color-text-primary);font-size:14px; }
.plan-cancel-x { width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--color-text-secondary);font-size:18px;cursor:pointer; }
.software-plan-note { padding:7px 8px;border-radius:7px;background:rgba(76,88,160,.12);color:var(--color-text-muted);font-size:9px;line-height:1.45; }
.plan-field { display:block;margin-top:8px;color:var(--color-text-secondary);font-size:10px; }.plan-field textarea { display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:7px 8px;border:1px solid var(--color-border);border-radius:6px;background:rgba(9,12,24,.32);color:var(--color-text-primary);font:inherit;font-size:11px;resize:vertical; }
.steps-title { display:flex;justify-content:space-between;gap:6px;align-items:center;margin:12px 0 7px;color:var(--color-text-primary);font-size:11px; }.steps-title span { color:var(--color-text-muted);font-size:9px; }
.software-steps { display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none; }.software-step { display:flex;align-items:flex-start;gap:8px;padding:7px 8px;border:1px solid var(--color-border);border-radius:7px;background:rgba(255,255,255,.025); }.step-index { display:grid;place-items:center;flex:0 0 18px;height:18px;border-radius:50%;background:rgba(124,108,225,.25);color:#d5ceff;font-size:9px; }.step-copy { display:flex;flex-direction:column;gap:3px;min-width:0; }.step-copy strong { color:var(--color-text-primary);font-size:10px;line-height:1.4; }.step-copy span { color:var(--color-text-muted);font-size:9px; }
.plan-confirm-note { margin-top:8px;color:#f0c96d;font-size:10px;line-height:1.5; }.plan-actions { display:flex;gap:6px;margin-top:10px; }.plan-actions button { flex:1;min-width:0;border:1px solid var(--color-border);border-radius:7px;padding:7px 5px;background:rgba(255,255,255,.045);color:var(--color-text-primary);font-size:10px;cursor:pointer; }.plan-actions .primary { border:0;background:linear-gradient(120deg,#3985ea,#7954d9);font-weight:700; }.plan-actions button:disabled { opacity:.5;cursor:default; }.plan-footnote { margin:7px 0 0;color:var(--color-text-muted);font-size:9px;line-height:1.45; }
</style>
