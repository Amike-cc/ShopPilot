<template>
  <div class="agent-composer">
    <textarea v-model="draft" :disabled="disabled" maxlength="500" rows="2" placeholder="例如：现在有哪些店铺？或：读取当前页面标题" @keydown="onKeydown" />
    <div class="composer-foot"><span>Enter 发送 · Shift+Enter 换行 · 未打开店铺也能对话</span><button class="agent-send" type="button" :disabled="disabled || !draft.trim()" @click="send">{{ disabled ? '处理中…' : '发送 ↑' }}</button></div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
const props = defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ send: [text: string] }>()
const draft = ref('')
function send() { const value = draft.value.trim(); if (props.disabled || !value) return; draft.value = ''; emit('send', value) }
function onKeydown(event: KeyboardEvent) { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() } }
</script>

<style scoped>
.agent-composer { border:1px solid var(--color-border);border-radius:11px;background:rgba(255,255,255,.035);padding:9px 10px 7px; }
textarea { display:block;width:100%;min-height:44px;max-height:110px;resize:vertical;border:0;outline:0;background:transparent;color:var(--color-text-primary);font:inherit;font-size:12px;line-height:1.55; }
textarea::placeholder { color:var(--color-text-muted); }
.composer-foot { display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:5px;color:var(--color-text-muted);font-size:10px; }
.agent-send { border:0;border-radius:7px;padding:6px 10px;background:linear-gradient(120deg,#3985ea,#7954d9);color:#fff;font-size:11px;font-weight:700;cursor:pointer; }
.agent-send:disabled { opacity:.5;cursor:default; }
</style>
