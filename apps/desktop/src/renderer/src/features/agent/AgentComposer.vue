<template>
  <div class="agent-composer">
    <div class="composer-mode"><span class="context-pulse"></span><span>普通对话</span><span>不会执行操作</span></div>
    <textarea v-model="draft" :disabled="disabled" maxlength="500" rows="2" placeholder="输入你想聊的问题…" @keydown="onKeydown" />
    <div class="composer-foot">
      <span>Enter 发送 · Shift+Enter 换行</span>
      <span class="char-count">{{ draft.length }}/500</span>
      <button class="agent-send" type="button" :disabled="disabled || !draft.trim()" @click="send(draft)">{{ disabled ? '回复中…' : '发送' }}<img v-if="!disabled" :src="sendIcon" alt="" /></button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import sendIcon from '../../assets/generated/ui-icons/send.png'

const props = defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ send: [text: string] }>()
const draft = ref('')

function send(input: string) {
  const value = input.trim()
  if (props.disabled || !value) return
  draft.value = ''
  emit('send', value)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    send(draft.value)
  }
}
</script>

<style scoped>
.agent-composer { flex:0 0 auto;border:1px solid rgba(130,119,201,.42);border-radius:13px;background:#f7f9fd;padding:9px 10px 7px;box-shadow:0 -8px 24px rgba(16,24,40,.06); }
.composer-mode { display:flex;align-items:center;gap:6px;margin-bottom:6px;color:var(--color-text-muted);font-size:9px; }.composer-mode span:last-child { margin-left:auto; }
.context-pulse { width:6px;height:6px;border-radius:50%;background:#70c9a7;box-shadow:0 0 0 3px rgba(112,201,167,.12); }
textarea { display:block;width:100%;min-height:44px;max-height:110px;resize:vertical;border:0;outline:0;background:transparent;color:var(--color-text-primary);font:inherit;font-size:12px;line-height:1.55; }
.composer-foot { display:flex;align-items:center;gap:8px;margin-top:5px;color:var(--color-text-muted);font-size:9px; }.composer-foot>span:first-child { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }.char-count { margin-left:auto;flex:0 0 auto; }
.agent-send { display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;border:0;border-radius:7px;padding:6px 10px;background:linear-gradient(120deg,#3985ea,#7954d9);color:#fff;font-size:11px;font-weight:700;cursor:pointer; }.agent-send img { width:14px;height:14px;object-fit:contain; }.agent-send:disabled { opacity:.5;cursor:default; }
</style>
