<template>
  <div class="agent-composer">
    <div class="composer-context"><span class="context-pulse"></span><span>{{ scopeLabel || '当前会话' }}</span><span class="composer-agent">root-ceo</span></div>
    <div class="intent-row" aria-label="快捷意图">
      <button v-for="intent in intents" :key="intent.label" type="button" :disabled="disabled" @click="send(intent.text)">{{ intent.label }}</button>
    </div>
    <textarea v-model="draft" :disabled="disabled" maxlength="500" rows="2" placeholder="描述你要完成的事情，或询问当前状态…" @keydown="onKeydown" />
    <div class="composer-foot"><span>Enter 发送 · Shift+Enter 换行 · 高风险动作会等待人工确认</span><span class="char-count">{{ draft.length }}/500</span><button class="agent-send" type="button" :disabled="disabled || !draft.trim()" @click="send(draft)">{{ disabled ? '处理中…' : '发送' }}<img v-if="!disabled" :src="sendIcon" alt="" /></button></div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import sendIcon from '../../assets/generated/ui-icons/send.png'
const props = defineProps<{ disabled?: boolean; scopeLabel?: string }>()
const emit = defineEmits<{ send: [text: string] }>()
const draft = ref('')
const intents = [{ label: '查看店铺', text: '查看当前可用店铺和状态' }, { label: '检查商品', text: '检查当前店铺商品状态' }, { label: '看经营数据', text: '查看近期经营数据和异常' }, { label: '看待办', text: '查看需要我处理的待办事项' }]
function send(input: string) { const value = input.trim(); if (props.disabled || !value) return; draft.value = ''; emit('send', value) }
function onKeydown(event: KeyboardEvent) { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(draft.value) } }
</script>

<style scoped>
.agent-composer { border:1px solid rgba(130,119,201,.42);border-radius:13px;background:#f7f9fd;padding:9px 10px 7px;box-shadow:0 -8px 24px rgba(16,24,40,.06); }.composer-context { display:flex;align-items:center;gap:6px;color:var(--color-text-muted);font-size:9px; }.composer-agent { margin-left:auto;color:#5b3df5; }.context-pulse { width:6px;height:6px;border-radius:50%;background:#70c9a7;box-shadow:0 0 0 3px rgba(112,201,167,.12); }.intent-row { display:flex;gap:5px;margin:8px 0 6px;overflow-x:auto; }.intent-row button { flex:0 0 auto;border:1px solid var(--color-border);border-radius:99px;padding:4px 8px;background:#f2f4f8;color:var(--color-text-secondary);font-size:9px;cursor:pointer; }.intent-row button:hover { border-color:#8277c9;color:#4326d9; }.intent-row button:disabled { opacity:.45;cursor:default; }
textarea { display:block;width:100%;min-height:44px;max-height:110px;resize:vertical;border:0;outline:0;background:transparent;color:var(--color-text-primary);font:inherit;font-size:12px;line-height:1.55; }.composer-foot { display:flex;align-items:center;gap:8px;margin-top:5px;color:var(--color-text-muted);font-size:9px; }.composer-foot>span:first-child { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }.char-count { margin-left:auto;flex:0 0 auto; }.agent-send { display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;border:0;border-radius:7px;padding:6px 10px;background:linear-gradient(120deg,#3985ea,#7954d9);color:#fff;font-size:11px;font-weight:700;cursor:pointer; }.agent-send img { width:14px;height:14px;object-fit:contain; }.agent-send:disabled { opacity:.5;cursor:default; }
</style>
