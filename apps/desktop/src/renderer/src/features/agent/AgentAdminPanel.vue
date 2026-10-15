<template>
  <section class="agent-settings" data-test="agent-admin-panel" data-agent-panel="models">
    <header class="settings-head">
      <div><strong>对话模型</strong><span>在这里手动配置纯文本对话所用模型。聊天本身没有店铺、页面或任务操作接口。</span></div>
      <button class="mini-btn" type="button" :disabled="loading" @click="loadModels">{{ loading ? '刷新中…' : '刷新' }}</button>
    </header>

    <p class="settings-hint">主 Agent 的模型地址、模型名和 API Key 统一从「AI 配置」管理；此处只管理其他对话模型 Profile。</p>
    <p v-if="message" class="settings-message" :class="{ error: messageIsError }" :role="messageIsError ? 'alert' : 'status'">{{ message }}</p>
    <p v-if="loading && profiles.length === 0" class="settings-empty" role="status">正在读取模型 Profile…</p>
    <p v-else-if="!loading && profiles.length === 0 && !messageIsError" class="settings-empty">尚无模型 Profile。可在下方创建可选的对话模型。</p>

    <div v-for="profile in profiles" :key="profile.id" class="profile-card">
      <div class="profile-title"><strong>{{ profile.name }}</strong><span v-if="profile.id === 'model_default-main'" class="status-pill primary-profile">主 Agent 全局配置</span><span v-else :class="['status-pill', profile.health]">{{ profile.health }}</span></div>
      <div class="profile-meta">{{ profile.id }} · {{ profile.provider }} · {{ profile.model }}</div>
      <div class="profile-meta">{{ profile.endpoint }} · API Key {{ profile.hasKey ? '已配置' : '未配置' }}</div>
      <div class="profile-meta">上下文 {{ contextLabel(profile) }} · {{ profile.enabled ? '已启用' : '已停用' }}</div>
      <div class="profile-actions">
        <button class="mini-btn" type="button" :disabled="loading || saving || !!testingProfileId || !profile.hasKey" :title="profile.hasKey ? '发送最小文本请求验证接口' : '请先配置 API Key'" @click="testModel(profile.id)">{{ testingProfileId === profile.id ? '测试中…' : profile.hasKey ? '测试连接' : '请先配置 API Key' }}</button>
        <button v-if="profile.id !== 'model_default-main'" class="mini-btn" type="button" :disabled="loading || saving" @click="editModel(profile)">编辑</button>
        <button v-if="profile.hasKey && profile.id !== 'model_default-main'" class="mini-btn" type="button" :disabled="loading || saving" @click="clearModelKey(profile)">清除 Key</button>
        <button v-if="profile.id !== 'model_default-main'" class="mini-btn danger" type="button" :disabled="loading || saving" @click="deleteModel(profile)">删除</button>
      </div>
    </div>

    <form class="profile-form" @submit.prevent="saveModel">
      <strong>{{ modelDraft.id ? '编辑模型 Profile' : '新增模型 Profile' }}</strong>
      <label>名称<input v-model="modelDraft.name" required maxlength="120" /></label>
      <div class="form-row"><label>服务商<input v-model="modelDraft.provider" required maxlength="80" /></label><label>模型<input v-model="modelDraft.model" required maxlength="160" /></label></div>
      <label>接口地址<input v-model="modelDraft.endpoint" type="url" required maxlength="500" placeholder="https://api.example.com/v1" /></label>
      <label>API Key<input v-model="modelDraft.apiKey" type="password" autocomplete="new-password" placeholder="留空保持现有 Key" /></label>
      <div class="form-row"><label>超时（毫秒）<input v-model.number="modelDraft.timeoutMs" type="number" min="1000" max="3600000" /></label><label>最大输出 token<input v-model.number="modelDraft.maxTokens" type="number" min="16" max="128000" /></label></div>
      <details>
        <summary>高级配置</summary>
        <div class="advanced-fields">
          <label>上下文窗口（留空自动）<input v-model.number="modelDraft.contextWindowTokens" type="number" min="4096" max="2000000" placeholder="自动推导" /></label>
          <label>备用 Profile<select v-model="modelDraft.fallbackProfileId"><option value="">不配置</option><option v-for="profile in profiles.filter(item => item.id !== modelDraft.id)" :key="profile.id" :value="profile.id">{{ profile.name }}</option></select></label>
          <label>日预算单位<input v-model="modelDraft.budgetCurrency" maxlength="8" /></label>
          <label>日预算数量<input v-model="modelDraft.budgetAmount" type="number" min="0" /></label>
          <label>价格币种<input v-model="modelDraft.pricingCurrency" maxlength="8" /></label>
          <label>输入价 / 百万 token<input v-model="modelDraft.inputPerMTok" type="number" min="0" step="0.01" /></label>
          <label>输出价 / 百万 token<input v-model="modelDraft.outputPerMTok" type="number" min="0" step="0.01" /></label>
        </div>
        <label class="enabled-check"><input v-model="modelDraft.enabled" type="checkbox" />启用此 Profile</label>
      </details>
      <div class="form-actions"><button class="mini-btn primary" type="submit" :disabled="saving">{{ saving ? '保存中…' : '保存模型' }}</button><button class="mini-btn" type="button" @click="resetDraft">清空表单</button></div>
    </form>
  </section>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { describeResolvedContextWindow } from '@shared/agent-context'
import type { ModelProfile, ModelProfileInput } from '@shared/schemas/agent-domain'

const profiles = ref<ModelProfile[]>([])
const loading = ref(false)
const saving = ref(false)
const testingProfileId = ref('')
const message = ref('')
const messageIsError = ref(false)
const modelDraft = reactive<ModelProfileInput & { budgetCurrency: string; budgetAmount: string; pricingCurrency: string; inputPerMTok: string; outputPerMTok: string }>(freshDraft())

function freshDraft(): ModelProfileInput & { budgetCurrency: string; budgetAmount: string; pricingCurrency: string; inputPerMTok: string; outputPerMTok: string } {
  return {
    name: '', provider: '', model: '', endpoint: '', timeoutMs: 30000, maxTokens: 1200,
    contextWindowTokens: null, temperature: 0.7, concurrencyLimit: 1,
    fallbackProfileId: null, dailyBudget: null, pricing: null, enabled: true,
    capabilities: { chat: true, json: true, vision: false, cancellation: true },
    budgetCurrency: 'tokens', budgetAmount: '', pricingCurrency: 'USD', inputPerMTok: '', outputPerMTok: ''
  }
}

function setMessage(value: string, isError = false) {
  message.value = value
  messageIsError.value = isError
}

function contextLabel(profile: ModelProfile): string {
  return describeResolvedContextWindow(profile.resolvedContextWindowTokens, profile.resolvedContextSource)
}

async function loadModels() {
  if (loading.value) return
  loading.value = true
  setMessage('')
  try {
    const result = await window.shopilot.agentSettings.modelList({ limit: 200 })
    if (!result.ok) return setMessage(result.error.message, true)
    profiles.value = result.data.items
  } catch (error) {
    setMessage(String((error as Error)?.message || error), true)
  } finally {
    loading.value = false
  }
}

function editModel(profile: ModelProfile) {
  Object.assign(modelDraft, {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    model: profile.model,
    endpoint: profile.endpoint,
    timeoutMs: profile.timeoutMs,
    maxTokens: profile.maxTokens,
    contextWindowTokens: profile.contextWindowTokens,
    temperature: profile.temperature,
    concurrencyLimit: profile.concurrencyLimit,
    fallbackProfileId: profile.fallbackProfileId,
    dailyBudget: profile.dailyBudget,
    pricing: profile.pricing,
    budgetCurrency: profile.dailyBudget?.currency || 'tokens',
    budgetAmount: profile.dailyBudget ? String(profile.dailyBudget.amount) : '',
    pricingCurrency: profile.pricing?.currency || 'USD',
    inputPerMTok: profile.pricing ? String(profile.pricing.inputPerMTok) : '',
    outputPerMTok: profile.pricing ? String(profile.pricing.outputPerMTok) : '',
    enabled: profile.enabled,
    capabilities: { ...profile.capabilities },
    apiKey: '',
    clearKey: false
  })
  setMessage(`正在编辑「${profile.name}」`)
}

function toInput(): ModelProfileInput {
  const dailyBudget = modelDraft.budgetAmount === '' ? null : { currency: modelDraft.budgetCurrency || 'tokens', amount: Number(modelDraft.budgetAmount) }
  const pricing = modelDraft.inputPerMTok === '' && modelDraft.outputPerMTok === ''
    ? null
    : { currency: modelDraft.pricingCurrency || 'USD', inputPerMTok: Number(modelDraft.inputPerMTok || 0), outputPerMTok: Number(modelDraft.outputPerMTok || 0) }
  return {
    ...(modelDraft.id ? { id: modelDraft.id } : {}),
    name: modelDraft.name,
    provider: modelDraft.provider,
    model: modelDraft.model,
    endpoint: modelDraft.endpoint,
    ...(modelDraft.apiKey ? { apiKey: modelDraft.apiKey } : {}),
    temperature: Number(modelDraft.temperature),
    maxTokens: Number(modelDraft.maxTokens),
    contextWindowTokens: modelDraft.contextWindowTokens == null || Number(modelDraft.contextWindowTokens) < 4096 ? null : Number(modelDraft.contextWindowTokens),
    timeoutMs: Number(modelDraft.timeoutMs),
    fallbackProfileId: modelDraft.fallbackProfileId || null,
    capabilities: { ...modelDraft.capabilities },
    concurrencyLimit: Number(modelDraft.concurrencyLimit),
    dailyBudget,
    pricing,
    enabled: modelDraft.enabled
  }
}

async function saveModel() {
  if (saving.value) return
  saving.value = true
  try {
    const result = await window.shopilot.agentSettings.modelSet(toInput())
    if (!result.ok) return setMessage(result.error.message, true)
    resetDraft()
    await loadModels()
    if (!messageIsError.value) setMessage('模型 Profile 已保存。')
  } catch (error) {
    setMessage(String((error as Error)?.message || error), true)
  } finally {
    saving.value = false
  }
}

async function testModel(profileId: string) {
  if (testingProfileId.value || loading.value) return
  testingProfileId.value = profileId
  try {
    const result = await window.shopilot.agentSettings.modelTest(profileId)
    if (!result.ok) return setMessage(`模型测试失败（${result.error.code}）：${result.error.message}`, true)
    await loadModels()
    if (!messageIsError.value) setMessage(`模型连接成功：${result.data.model}，${result.data.elapsedMs} ms`)
  } catch (error) {
    setMessage(String((error as Error)?.message || error), true)
  } finally {
    testingProfileId.value = ''
  }
}

async function clearModelKey(profile: ModelProfile) {
  const confirmed = window.confirm(`确认清除「${profile.name}」的 API Key？`)
  if (!confirmed) return
  saving.value = true
  try {
    // `profile` comes from a Vue ref and nested fields are reactive proxies.
    // Electron's context bridge only accepts structured-cloneable data; pass a
    // plain snapshot so clearing a key cannot fail with DataCloneError.
    const payload = JSON.parse(JSON.stringify({
      id: profile.id, name: profile.name, provider: profile.provider, model: profile.model, endpoint: profile.endpoint,
      timeoutMs: profile.timeoutMs, maxTokens: profile.maxTokens, contextWindowTokens: profile.contextWindowTokens,
      temperature: profile.temperature, concurrencyLimit: profile.concurrencyLimit, fallbackProfileId: profile.fallbackProfileId,
      dailyBudget: profile.dailyBudget, pricing: profile.pricing, enabled: profile.enabled, capabilities: profile.capabilities, clearKey: true
    })) as ModelProfileInput
    const result = await window.shopilot.agentSettings.modelSet(payload)
    if (!result.ok) return setMessage(result.error.message, true)
    await loadModels()
    if (!messageIsError.value) setMessage('模型 API Key 已清除。')
  } catch (error) {
    setMessage(String((error as Error)?.message || error), true)
  } finally {
    saving.value = false
  }
}

async function deleteModel(profile: ModelProfile) {
  const confirmed = window.confirm(`确认删除模型 Profile「${profile.name}」？`)
  if (!confirmed) return
  saving.value = true
  try {
    const result = await window.shopilot.agentSettings.modelDelete(profile.id)
    if (!result.ok) return setMessage(result.error.message, true)
    await loadModels()
    if (!messageIsError.value) setMessage('模型 Profile 已删除。')
  } catch (error) {
    setMessage(String((error as Error)?.message || error), true)
  } finally {
    saving.value = false
  }
}

function resetDraft() { Object.assign(modelDraft, freshDraft()) }
onMounted(() => { void loadModels() })
</script>

<style scoped>
.agent-settings { display:flex;flex-direction:column;gap:10px;min-height:0;height:100%;overflow:auto;color:var(--color-text-primary); }
.settings-head { display:flex;align-items:center;gap:12px;padding:10px;border:1px solid var(--color-border);border-radius:8px;background:rgba(101,119,190,.06); }.settings-head>div { display:flex;flex-direction:column;gap:4px; }.settings-head strong { font-size:12px; }.settings-head span,.profile-meta { color:var(--color-text-muted);font-size:10px;line-height:1.45; }.settings-head button { margin-left:auto; }
.profile-card,.profile-form { display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--color-border);border-radius:8px;background:var(--color-bg-secondary); }.profile-title { display:flex;align-items:center;gap:8px;font-size:11px; }.status-pill { margin-left:auto;border-radius:99px;padding:3px 7px;background:#eef2f6;color:#475467;font-size:9px; }.status-pill.healthy { background:#ecfdf3;color:#027a48; }.status-pill.degraded,.status-pill.disabled { background:#fef3f2;color:#b42318; }.profile-actions,.form-actions { display:flex;flex-wrap:wrap;gap:6px; }.mini-btn { border:1px solid var(--color-border);border-radius:6px;padding:5px 8px;background:#f8f9fc;color:var(--color-text-secondary);font-size:10px;cursor:pointer; }.mini-btn.primary { border-color:#6558d3;background:#6558d3;color:#fff; }.mini-btn.danger { color:#b42318; }.mini-btn:disabled { opacity:.55;cursor:default; }
.profile-form>strong { font-size:11px; }.profile-form label { display:flex;flex-direction:column;gap:4px;color:var(--color-text-secondary);font-size:10px; }.profile-form input,.profile-form select { min-width:0;width:100%;padding:7px;border:1px solid var(--color-border);border-radius:6px;background:#fff;color:var(--color-text-primary);font:inherit; }.form-row,.advanced-fields { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px; }.profile-form details { padding-top:4px;color:var(--color-text-secondary);font-size:10px; }.profile-form summary { cursor:pointer; }.advanced-fields { margin:8px 0; }.enabled-check { flex-direction:row!important;align-items:center; }.enabled-check input { width:auto; }.settings-message { margin:0;padding:8px;border-radius:6px;background:#ecfdf3;color:#027a48;font-size:10px; }.settings-message.error { background:#fef3f2;color:#b42318; }
 .settings-hint,.settings-empty { margin:0;padding:8px 10px;border:1px solid var(--color-border);border-radius:7px;background:rgba(101,119,190,.04);color:var(--color-text-muted);font-size:10px;line-height:1.5; }.primary-profile { margin-left:auto;background:#f2efff;color:#5b43bd; }
</style>
