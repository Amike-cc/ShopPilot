<template>
  <section class="chat-image-page" data-test="chat-image-page">
    <header class="ci-head">
      <div class="ci-brand">
        <button type="button" class="ci-brand-mark" aria-label="返回首页" @click="emit('go-home')"><img :src="brandMark" alt="" /></button>
        <strong>ShopPilot</strong>
        <span class="ci-brand-sub">对话生图</span>
      </div>
      <div class="ci-head-actions">
        <span class="ci-model" :class="{ off: !configured }" data-test="chat-image-model">模型：{{ model || '未配置' }}</span>
        <label class="ci-select"><span>比例</span>
          <select v-model="ratio" data-test="chat-image-ratio" :disabled="busy">
            <option v-for="item in CHAT_IMAGE_RATIO_OPTIONS" :key="item.key" :value="item.key">{{ item.label }}</option>
          </select>
        </label>
        <label class="ci-select"><span>张数</span>
          <select v-model.number="imageCount" data-test="chat-image-count" :disabled="busy">
            <option v-for="count in CHAT_IMAGE_COUNT_OPTIONS" :key="count" :value="count">{{ count }} 张</option>
          </select>
        </label>
        <button type="button" class="ci-ghost" data-test="chat-image-new" :disabled="busy || !messages.length" @click="reset">新对话</button>
        <AiToolSettings title="对话生图 · 模型设置" :sections="['image']" @closed="reloadConfig" />
      </div>
    </header>

    <div class="ci-body">
      <div ref="scrollArea" class="ci-thread" data-test="chat-image-thread">
        <div v-if="!messages.length && !busy" class="ci-empty">
          <div class="ci-empty-mark" aria-hidden="true"><AppIcon name="message" :size="26" /></div>
          <h1>描述画面，连续对话改图</h1>
          <p>每条消息直接生成图片；生成后可点「基于这张改」，把结果作为下一轮参考图继续调整。</p>
          <div class="ci-examples">
            <button v-for="example in EXAMPLES" :key="example" type="button" data-test="chat-image-example" @click="useExample(example)">{{ example }}</button>
          </div>
        </div>

        <template v-for="message in messages" :key="message.id">
          <div v-if="message.role === 'user'" class="ci-row user" data-test="chat-image-user-message">
            <div class="ci-bubble user">
              <div v-if="message.reference" class="ci-ref-inline">
                <img :src="message.reference.dataUrl" :alt="message.reference.name" />
                <span>参考图 · {{ message.reference.name }}</span>
              </div>
              <p>{{ message.text }}</p>
            </div>
          </div>
          <div v-else class="ci-row assistant" data-test="chat-image-assistant-message">
            <div class="ci-bubble assistant">
              <div v-if="message.error" class="ci-error" role="alert">
                <strong>生成失败</strong>
                <p>{{ message.error }}</p>
              </div>
              <div v-else-if="message.images?.length" class="ci-result-grid" :class="{ single: message.images.length === 1 }">
                <figure v-for="(image, imageIndex) in message.images" :key="image.url.slice(-32) + imageIndex" class="ci-result">
                  <img :src="image.url" :alt="`对话生成图片 ${imageIndex + 1}`" loading="lazy" @load="scrollToBottom" />
                  <figcaption>
                    <span class="ci-result-meta">{{ image.model }}<template v-if="image.elapsedMs"> · {{ (image.elapsedMs / 1000).toFixed(1) }}s</template></span>
                    <span class="ci-result-actions">
                      <button type="button" :data-test="`chat-image-save-${message.id}-${imageIndex}`" @click="saveImage(image.url, imageIndex + 1)">保存</button>
                      <button type="button" class="primary" :data-test="`chat-image-use-reference-${message.id}-${imageIndex}`" @click="useResultAsReference(message, image)">基于这张改</button>
                    </span>
                  </figcaption>
                </figure>
              </div>
            </div>
          </div>
        </template>

        <div v-if="busy" class="ci-generating" data-test="chat-image-generating" role="status">
          <span class="ci-spinner" aria-hidden="true"></span>
          <span>{{ phase || '正在生成图片…' }}</span>
        </div>
      </div>

      <div class="ci-composer-wrap">
        <div v-if="reference" class="ci-reference-chip" data-test="chat-image-reference">
          <img :src="reference.dataUrl" :alt="reference.name" />
          <span>下一轮参考图：{{ reference.name }}</span>
          <button type="button" aria-label="移除参考图" @click="clearReference">×</button>
        </div>
        <div v-if="configError" class="ci-config-error" role="alert">{{ configError }}</div>
        <div v-if="attachError" class="ci-config-error" role="alert">{{ attachError }}</div>
        <div v-if="notice" :class="['ci-notice', { error: noticeIsError }]" role="status">{{ notice }}</div>
        <div class="ci-composer">
          <button type="button" class="ci-attach" title="上传参考图（下一轮生效）" aria-label="上传参考图" :disabled="busy" @click="materialInput?.click()">
            <AppIcon name="upload" :size="16" />
          </button>
          <input ref="materialInput" class="visually-hidden" type="file" accept="image/png,image/jpeg" data-test="chat-image-material-input" @change="onMaterialFiles" />
          <textarea
            ref="composerInput"
            v-model="draft"
            rows="2"
            maxlength="1000"
            data-test="chat-image-input"
            placeholder="描述你想要的图片；回车发送，Shift+回车换行"
            @keydown.enter.exact.prevent="sendMessage"
          ></textarea>
          <button type="button" class="ci-send" data-test="chat-image-send" :disabled="!draft.trim() || busy || !configured" @click="sendMessage">
            <AppIcon name="arrow-right" :size="15" />{{ busy ? '生成中…' : '发送' }}
          </button>
        </div>
        <p class="ci-hint">
          每轮按「{{ ratio }} · {{ imageCount }} 张」生成；「基于这张改」会把该图作为下一轮参考图。
          {{ configured ? '结果来自真实生图接口，保存时选择本地路径。' : '生图接口未配置，请点右上角「模型设置」。' }}
        </p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import AppIcon from '../../components/ui/AppIcon.vue'
import AiToolSettings from './AiToolSettings.vue'
import brandMark from '../../assets/generated/shopilot-logo-generated.png'
import {
  CHAT_IMAGE_COUNT_OPTIONS,
  CHAT_IMAGE_MAX_REFERENCE_BYTES,
  CHAT_IMAGE_RATIO_OPTIONS
} from './chat-image'
import { useChatImage, type ChatImageMessage, type ChatImageResult } from './use-chat-image'

const emit = defineEmits<{ 'go-home': []; 'busy-change': [busy: boolean] }>()
const {
  messages,
  draft,
  ratio,
  imageCount,
  reference,
  busy,
  phase,
  notice,
  noticeIsError,
  configError,
  model,
  configured,
  reloadConfig,
  setReference,
  clearReference,
  reset,
  send,
  saveImage
} = useChatImage()

const EXAMPLES = [
  '白色背景的商品主图，柔和阴影，主体居中',
  '春季女装模特街拍，暖色调，浅景深',
  '咖啡杯场景图，木质桌面，清晨侧光'
]

const scrollArea = ref<HTMLElement | null>(null)
const composerInput = ref<HTMLTextAreaElement | null>(null)
const materialInput = ref<HTMLInputElement | null>(null)
const attachError = ref('')

function scrollToBottom(): void {
  void nextTick(() => {
    const area = scrollArea.value
    if (area) area.scrollTop = area.scrollHeight
  })
}
function useExample(text: string): void {
  draft.value = text
  composerInput.value?.focus()
}
async function sendMessage(): Promise<void> {
  await send()
  scrollToBottom()
  composerInput.value?.focus()
}
function useResultAsReference(message: ChatImageMessage, image: ChatImageResult): void {
  setReference({
    name: `对话结果-${new Date(message.at).toLocaleTimeString('zh-CN', { hour12: false })}.png`,
    dataUrl: image.url
  })
  composerInput.value?.focus()
}
function onMaterialFiles(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  attachError.value = ''
  if (!file) return
  if (!/^image\/(png|jpeg)$/i.test(file.type)) { attachError.value = '参考图只支持 PNG / JPEG'; return }
  if (file.size > CHAT_IMAGE_MAX_REFERENCE_BYTES) { attachError.value = '参考图单张不能超过 5MB'; return }
  const reader = new FileReader()
  reader.onload = () => setReference({ name: file.name, dataUrl: String(reader.result || '') })
  reader.onerror = () => { attachError.value = '读取参考图失败，请重新选择' }
  reader.readAsDataURL(file)
}
watch(busy, value => emit('busy-change', value))
watch(() => messages.value.length, scrollToBottom, { flush: 'post' })
watch(attachError, scrollToBottom, { flush: 'post' })
onMounted(() => { void reloadConfig() })
</script>

<style scoped>
.chat-image-page{display:flex;min-width:0;min-height:0;flex:1;flex-direction:column;overflow:hidden;color:var(--dash-text);background:var(--ui-canvas)}
.ci-head{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:58px;flex:0 0 58px;padding:0 24px;border-bottom:1px solid var(--ui-border);background:rgba(255,255,255,.96);backdrop-filter:blur(10px);z-index:5}
.ci-brand{display:flex;align-items:center;gap:8px;min-width:0;color:#1e2a41;font-size:15px}
.ci-brand-mark{display:grid;place-items:center;width:30px;height:30px;padding:0;border:1px solid var(--ui-border);border-radius:8px;background:#fff;cursor:pointer;box-shadow:var(--e1)}
.ci-brand-mark img{width:22px;height:22px;object-fit:contain}
.ci-brand-sub{padding-left:8px;border-left:1px solid var(--ui-border);color:var(--ui-text-muted);font-size:11px;font-weight:500;white-space:nowrap}
.ci-head-actions{display:flex;align-items:center;gap:9px;min-width:0;flex-wrap:wrap;justify-content:flex-end}
.ci-model{max-width:185px;overflow:hidden;padding:3px 8px;border:1px solid var(--ui-border);border-radius:999px;color:var(--success-text);background:var(--success-soft);font-size:10.5px;text-overflow:ellipsis;white-space:nowrap}
.ci-model.off{color:var(--warning-text);background:var(--warning-soft);border-color:rgba(247,144,9,.28)}
.ci-select{display:inline-flex;align-items:center;gap:5px;color:var(--ui-text-muted);font-size:10.5px;white-space:nowrap}
.ci-select select{height:30px;padding:0 6px;border:1px solid var(--ui-border);border-radius:7px;background:#fff;color:var(--ui-text-soft);font:inherit}
.ci-ghost{min-height:30px;padding:0 10px;border:1px solid var(--ui-border);border-radius:7px;background:#fff;color:var(--ui-text-soft);font-size:10.5px;cursor:pointer}
.ci-ghost:hover:not(:disabled){border-color:var(--brand-border);color:var(--brand-text)}
.ci-ghost:disabled{opacity:.5;cursor:not-allowed}
.ci-body{display:flex;min-height:0;flex:1;flex-direction:column}
.ci-thread{flex:1;min-height:0;overflow:auto;padding:24px max(24px,calc((100% - 900px)/2)) 18px;scroll-behavior:smooth}
.ci-empty{display:flex;min-height:100%;align-items:center;justify-content:center;flex-direction:column;text-align:center;padding:40px 0}
.ci-empty-mark{display:grid;place-items:center;width:58px;height:58px;margin-bottom:16px;border-radius:18px;background:linear-gradient(145deg,#6d4aff,#9b7bff);color:#fff;box-shadow:0 14px 30px -16px rgba(109,74,255,.7)}
.ci-empty h1{margin:0 0 8px;color:#172033;font-size:24px;letter-spacing:-.02em}
.ci-empty p{max-width:560px;margin:0;color:var(--ui-text-muted);font-size:12px;line-height:1.7}
.ci-examples{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:18px}
.ci-examples button{max-width:260px;padding:7px 12px;border:1px solid var(--ui-border);border-radius:999px;background:var(--ui-surface);color:var(--ui-text-soft);font-size:11px;cursor:pointer}
.ci-examples button:hover{border-color:var(--brand-border);color:var(--brand-text);background:var(--brand-soft)}
.ci-row{display:flex;margin:0 0 16px}
.ci-row.user{justify-content:flex-end}
.ci-row.assistant{justify-content:flex-start}
.ci-bubble{max-width:min(720px,88%);border-radius:14px;padding:12px 14px;font-size:12.5px;line-height:1.7;box-shadow:var(--e1)}
.ci-bubble.user{background:var(--brand);color:#fff;border-bottom-right-radius:4px}
.ci-bubble.user p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.ci-bubble.assistant{width:auto;max-width:min(760px,92%);border:1px solid var(--ui-border);background:var(--ui-surface);color:var(--ui-text)}
.ci-ref-inline{display:inline-flex;align-items:center;gap:7px;margin-bottom:8px;padding:4px 7px;border-radius:8px;background:rgba(255,255,255,.18);font-size:10px}
.ci-ref-inline img{width:34px;height:34px;border-radius:6px;object-fit:cover}
.ci-result-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.ci-result-grid.single{grid-template-columns:minmax(0,1fr)}
.ci-result{display:flex;min-width:0;flex-direction:column;margin:0;overflow:hidden;border:1px solid var(--ui-border);border-radius:11px;background:var(--ui-surface-subtle)}
.ci-result img{display:block;width:100%;max-height:460px;object-fit:contain;background:#f1f4fa}
.ci-result figcaption{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 8px;border-top:1px solid var(--ui-border);flex-wrap:wrap}
.ci-result-meta{min-width:0;overflow:hidden;color:var(--ui-text-muted);font-size:9.5px;text-overflow:ellipsis;white-space:nowrap}
.ci-result-actions{display:inline-flex;gap:5px;flex:0 0 auto}
.ci-result-actions button{padding:3px 8px;border:1px solid var(--ui-border);border-radius:6px;background:#fff;color:var(--ui-text-soft);font-size:10px;cursor:pointer}
.ci-result-actions button:hover{border-color:var(--brand-border);color:var(--brand-text)}
.ci-result-actions button.primary{border-color:var(--brand);background:var(--brand);color:#fff}
.ci-error{padding:2px 0}
.ci-error strong{color:var(--danger-text);font-size:11px}
.ci-error p{margin:5px 0 0;color:var(--danger-text);font-size:11.5px;line-height:1.55;overflow-wrap:anywhere}
.ci-generating{display:flex;align-items:center;gap:9px;margin:2px 0 16px;padding:10px 12px;border:1px dashed rgba(109,74,255,.35);border-radius:11px;background:rgba(109,74,255,.05);color:var(--ui-text-muted);font-size:11.5px}
.ci-spinner{width:13px;height:13px;border:2px solid rgba(109,74,255,.24);border-top-color:#6d4aff;border-radius:50%;animation:ci-spin .8s linear infinite}
@keyframes ci-spin{to{transform:rotate(360deg)}}
.ci-composer-wrap{flex:0 0 auto;padding:0 max(24px,calc((100% - 900px)/2)) 16px;background:linear-gradient(180deg,transparent,var(--ui-canvas) 32%)}
.ci-reference-chip{display:flex;align-items:center;gap:7px;width:fit-content;max-width:100%;margin:0 0 7px;padding:4px 8px 4px 4px;border:1px solid var(--brand-border);border-radius:9px;background:var(--brand-soft);color:var(--brand-text);font-size:10.5px}
.ci-reference-chip img{width:30px;height:30px;border-radius:6px;object-fit:cover}
.ci-reference-chip span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ci-reference-chip button{display:grid;place-items:center;width:18px;height:18px;padding:0;border:0;border-radius:50%;background:rgba(0,0,0,.08);color:inherit;cursor:pointer}
.ci-config-error,.ci-notice{margin:0 0 7px;padding:7px 10px;border-radius:8px;font-size:11px;line-height:1.5}
.ci-config-error{border:1px solid rgba(247,144,9,.32);background:var(--warning-soft);color:var(--warning-text)}
.ci-notice{border:1px solid rgba(18,183,106,.26);background:var(--success-soft);color:var(--success-text)}
.ci-notice.error{border-color:rgba(217,45,32,.26);background:var(--danger-soft);color:var(--danger-text)}
.ci-composer{display:flex;align-items:flex-end;gap:9px;padding:9px;border:1px solid var(--ui-border-strong);border-radius:14px;background:var(--ui-surface);box-shadow:0 10px 30px -22px rgba(15,23,42,.45)}
.ci-composer:focus-within{border-color:var(--brand-border);box-shadow:0 0 0 3px rgba(109,74,255,.1)}
.ci-attach{display:grid;place-items:center;width:32px;height:32px;flex:0 0 32px;padding:0;border:1px solid var(--ui-border);border-radius:8px;background:var(--ui-surface-subtle);color:var(--ui-text-muted);cursor:pointer}
.ci-attach:hover:not(:disabled){color:var(--brand-text);border-color:var(--brand-border)}
.ci-attach:disabled{opacity:.5;cursor:not-allowed}
.ci-composer textarea{min-width:0;flex:1;max-height:150px;min-height:44px;padding:6px 2px;border:0;outline:0;resize:vertical;background:transparent;color:var(--ui-text);font:inherit;font-size:12.5px;line-height:1.6}
.ci-send{display:inline-flex;align-items:center;gap:5px;min-height:34px;padding:0 14px;flex:0 0 auto;border:1px solid var(--brand);border-radius:9px;background:var(--brand);color:#fff;font-size:11.5px;font-weight:600;cursor:pointer}
.ci-send:disabled{opacity:.5;cursor:not-allowed}
.ci-hint{margin:7px 2px 0;color:var(--ui-text-muted);font-size:10px;line-height:1.5}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media(max-width:1100px){
  .ci-head{align-items:flex-start;flex-direction:column;height:auto;min-height:58px;padding:10px 16px;gap:8px}
  .ci-head-actions{justify-content:flex-start}
  .ci-thread,.ci-composer-wrap{padding-left:16px;padding-right:16px}
}
</style>
