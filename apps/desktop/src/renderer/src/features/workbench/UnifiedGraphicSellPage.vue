<template>
  <section class="graphic-sell-page" data-test="graphic-sell-page">
    <header class="gs-head">
      <div class="gs-brand">
        <button type="button" class="gs-brand-mark" aria-label="返回首页" @click="emit('go-home')">ϟ</button>
        <strong>店管家</strong>
        <span class="gs-crumb">AI 创作 / 图文带货</span>
      </div>
      <div class="gs-status-bar" data-test="graphic-sell-config">
        <span class="gs-status" :class="readiness.copyReady ? 'ready' : 'warn'" :title="copyStatusHint"><i></i>文案：{{ readiness.copyLabel }}</span>
        <span class="gs-status" :class="readiness.imageReady ? 'ready' : 'warn'" :title="imageStatusHint"><i></i>生图：{{ readiness.imageLabel }}</span>
        <button type="button" class="gs-ghost-button" data-test="graphic-sell-history-toggle" :aria-expanded="historyOpen" @click="historyOpen = !historyOpen">历史记录 <em>{{ historySessions.length }}</em></button>
        <button type="button" class="gs-ghost-button" :disabled="generating" @click="resetAll">清空</button>
      </div>
    </header>

    <div class="gs-body">
      <aside class="gs-form" aria-label="图文带货配置">
        <section class="gs-card">
          <h3><i>1</i>商品信息 <em>* 名称必填</em></h3>
          <label class="gs-field">商品名称
            <input v-model="productName" type="text" :maxlength="SELL_COPY_LIMITS.productName" placeholder="例如：便携折叠露营椅" data-test="graphic-sell-product-name" />
          </label>
          <label class="gs-field">卖点 / 使用场景 <small>选填</small>
            <textarea v-model="sellingPoints" :maxlength="SELL_COPY_LIMITS.sellingPoints" rows="3" placeholder="例如：轻量铝合金支架、3 秒收纳、承重 120kg，适合露营 / 钓鱼 / 野餐" data-test="graphic-sell-selling-points"></textarea>
            <span class="gs-count">{{ sellingPoints.length }} / {{ SELL_COPY_LIMITS.sellingPoints }}</span>
          </label>
          <div class="gs-pair">
            <label class="gs-field">售价 <small>选填</small><input v-model="price" :maxlength="SELL_COPY_LIMITS.price" placeholder="例如 ¥129" data-test="graphic-sell-price" /></label>
            <label class="gs-field">原价 <small>选填</small><input v-model="originalPrice" :maxlength="SELL_COPY_LIMITS.originalPrice" placeholder="例如 ¥199" data-test="graphic-sell-original-price" /></label>
          </div>
          <label class="gs-field">目标人群 <small>选填</small><input v-model="audience" :maxlength="SELL_COPY_LIMITS.audience" placeholder="例如：露营新手、有娃家庭" data-test="graphic-sell-audience" /></label>
        </section>

        <section class="gs-card">
          <h3><i>2</i>商品图 <em>{{ requiresProductImage ? '该效果必填' : '选填' }} · {{ materials.length }}/{{ MAX_GRAPHIC_SELL_MATERIALS }}</em></h3>
          <p class="gs-hint">效果模板要用商品图做参考，才能保住颜色、面料、图案与刺绣文字一致；「AI 自由设计」可以不上传。</p>
          <div class="gs-dropzone" :class="{ full: materials.length >= MAX_GRAPHIC_SELL_MATERIALS }" role="button" tabindex="0" data-test="graphic-sell-material-dropzone" @click="materialInput?.click()" @keydown.enter.prevent="materialInput?.click()" @dragover.prevent @drop.prevent="onMaterialDrop">
            <input ref="materialInput" class="gs-visually-hidden" type="file" multiple accept=".jpg,.jpeg,.png,image/jpeg,image/png" data-test="graphic-sell-material-input" @change="onMaterialFiles" />
            <span class="gs-plus">+</span><strong>拖拽或点击上传</strong><small>PNG / JPEG，单张 ≤ 5MB，最多 3 张</small>
          </div>
          <ul v-if="materials.length" class="gs-materials">
            <li v-for="(item, index) in materials" :key="`${item.name}-${index}`">
              <img :src="item.dataUrl" :alt="item.name" /><span>{{ item.name }}</span>
              <button type="button" :aria-label="`移除 ${item.name}`" @click="removeMaterial(index)">×</button>
            </li>
          </ul>
          <p v-if="uploadError" class="gs-error">{{ uploadError }}</p>
        </section>

        <section class="gs-card">
          <h3><i>3</i>效果模板 <em>决定配图的场景与构图</em></h3>
          <div class="gs-effects" role="group" aria-label="效果模板">
            <button
              v-for="item in GRAPHIC_SELL_EFFECT_OPTIONS"
              :key="item.key"
              type="button"
              class="gs-effect"
              :class="{ active: effect === item.key }"
              :aria-pressed="effect === item.key"
              :data-test="`graphic-sell-effect-${item.key}`"
              @click="selectEffect(item.key)"
            >
              <span class="gs-effect-name">{{ item.label }}<em v-if="item.key === 'bed-lying'">推荐</em></span>
              <small>{{ item.note }}</small>
            </button>
          </div>
          <div v-if="effectOption.key === 'bed-lying'" class="gs-effect-ref" data-test="graphic-sell-effect-reference">
            <div class="gs-effect-ref-head"><strong>参考效果</strong><small>俯拍躺床 · 9:16 · 商品由模特自然展示</small></div>
            <div class="gs-effect-ref-grid">
              <img v-for="(art, index) in effectReferenceArts" :key="index" :src="art" :alt="`参考效果 ${index + 1}`" />
            </div>
          </div>
          <label class="gs-field">出镜模特
            <select v-model="model" data-test="graphic-sell-model" :disabled="Boolean(effectOption.forcedModel)">
              <option v-for="item in modelOptions" :key="item.key" :value="item.key">{{ item.label }} · {{ item.note }}</option>
            </select>
          </label>
        </section>

        <section class="gs-card">
          <h3><i>4</i>发布设置</h3>
          <label class="gs-field">平台
            <select v-model="platform" data-test="graphic-sell-platform">
              <option v-for="item in GRAPHIC_SELL_PLATFORM_OPTIONS" :key="item.key" :value="item.key">{{ item.label }}</option>
            </select>
            <span class="gs-hint">{{ platformNote }}</span>
          </label>
          <label class="gs-field">笔记风格
            <select v-model="style" data-test="graphic-sell-style">
              <option v-for="item in GRAPHIC_SELL_STYLE_OPTIONS" :key="item.key" :value="item.key">{{ item.label }}</option>
            </select>
            <span class="gs-hint">{{ styleNote }}</span>
          </label>
          <span class="gs-field-label">配图数量</span>
          <div class="gs-segmented" role="group" aria-label="配图数量" data-test="graphic-sell-image-count">
            <button v-for="count in GRAPHIC_SELL_IMAGE_COUNT_OPTIONS" :key="count" type="button" :class="{ active: imageCount === count }" @click="imageCount = count">{{ count }} 张</button>
          </div>
          <label class="gs-field">图片比例
            <select v-model="ratio" data-test="graphic-sell-ratio">
              <option v-for="item in GRAPHIC_SELL_RATIO_OPTIONS" :key="item.key" :value="item.key">{{ item.label }}</option>
            </select>
          </label>
        </section>
      </aside>

      <main class="gs-canvas">
        <section v-if="!copy && !generating" class="gs-empty" data-test="graphic-sell-empty">
          <span class="gs-kicker">IMAGE + TEXT COMMERCE</span>
          <h1>一次生成整套带货图文</h1>
          <p>先出标题、正文与话题标签，再按文案里的逐图画面描述生成配图；生成后可编辑、复制与保存。</p>
          <ol class="gs-flow">
            <li><b>1</b><strong>填商品信息</strong><small>名称必填，卖点 / 价格选填</small></li>
            <li><b>2</b><strong>上传商品图</strong><small>效果模板靠它保住商品一致</small></li>
            <li><b>3</b><strong>AI 出文案 + 配图</strong><small>{{ effectOption.label }} · {{ imageCount }} 张 · {{ ratioLabel }}</small></li>
          </ol>
          <p v-if="configError" class="gs-error">{{ configError }}</p>
          <p v-else-if="!readiness.copyReady || !readiness.imageReady" class="gs-warn" data-test="graphic-sell-config-warning">
            {{ readiness.copyReady ? '' : '文案接口未配置；' }}{{ readiness.imageReady ? '' : '生图接口未配置；' }}请到「设置中心 → AI 配置」补齐后再生成。
          </p>
          <p v-if="!configError && readiness.copyReady && readiness.imageReady && requiresProductImage && !materials.length" class="gs-warn" data-test="graphic-sell-effect-hint">
            当前效果「{{ effectOption.label }}」需要先上传商品图：生成时会以它为准保住颜色、面料、图案与刺绣文字一致。
          </p>
          <p v-if="generationError" class="gs-error" data-test="graphic-sell-error">{{ generationError }}</p>
        </section>

        <section v-else-if="generating" class="gs-progress" data-test="graphic-sell-progress">
          <span class="gs-loader"></span>
          <h2>{{ phase || '正在生成…' }}</h2>
          <p>文案与配图分两步请求；配图按逐图画面描述一张张出，请勿离开本页。</p>
          <div class="gs-progress-steps"><span :class="{ done: Boolean(copy) }">① 带货文案</span><span :class="{ active: Boolean(copy) && !images.length, done: images.length > 0 }">② 配图 {{ images.length }}/{{ imageCount }}</span></div>
        </section>

        <template v-else-if="copy">
          <section class="gs-note" data-test="graphic-sell-result">
            <header class="gs-note-head">
              <span class="gs-avatar">{{ avatarLetter }}</span>
              <div><b>图文带货预览</b><small>{{ platform }} · {{ style }}</small></div>
              <span class="gs-note-model" :title="`文案模型：${copy.model}`">{{ copy.model }}</span>
            </header>
            <div class="gs-note-media" :style="{ aspectRatio: previewAspect }">
              <img v-if="activeImage" :src="activeImage.url" :alt="`配图 ${activeImage.index + 1}`" data-test="graphic-sell-active-image" />
              <div v-else class="gs-media-placeholder">配图待生成</div>
              <span v-if="activeImage" class="gs-page-count">{{ activeImageIndex + 1 }} / {{ images.length || imageCount }}</span>
            </div>
            <div v-if="images.length > 1" class="gs-thumbs" data-test="graphic-sell-thumbs">
              <button v-for="(image, index) in images" :key="index" type="button" :class="{ active: activeImageIndex === index }" @click="activeImageIndex = index"><img :src="image.url" :alt="`配图 ${index + 1}`" /></button>
            </div>
            <div class="gs-note-body">
              <p v-if="editableCoverText.trim()" class="gs-cover-text">封面大字：{{ editableCoverText }}</p>
              <label class="gs-field">标题<input v-model="editableTitle" :maxlength="SELL_COPY_LIMITS.title" data-test="graphic-sell-edit-title" /></label>
              <label class="gs-field">正文<textarea v-model="editableBody" :maxlength="SELL_COPY_LIMITS.body" rows="6" data-test="graphic-sell-edit-body"></textarea></label>
              <label class="gs-field">话题标签<input v-model="editableTagsText" maxlength="220" placeholder="空格 / 逗号分隔，例如：露营 收纳 好物分享" data-test="graphic-sell-edit-tags" /></label>
              <p class="gs-tags"><span v-for="tag in editableTags" :key="tag">#{{ tag }}</span></p>
            </div>
            <footer class="gs-note-actions">
              <button type="button" class="gs-button primary" data-test="graphic-sell-copy-full" @click="copySellText('full')">复制完整文案</button>
              <button type="button" class="gs-button" @click="copySellText('title')">复制标题</button>
              <button type="button" class="gs-button" @click="copySellText('body')">复制正文</button>
              <button type="button" class="gs-button" @click="copySellText('tags')">复制话题</button>
            </footer>
          </section>

          <section class="gs-images" data-test="graphic-sell-images">
            <div class="gs-section-head"><h2>生成配图</h2><span>{{ images.length }} / {{ imageCount }} 张 · {{ ratioLabel }}</span></div>
            <p v-if="images.length" class="gs-hint">哪张不满意可单独「重绘」：只重发这一张，文案与其它配图保持不变。</p>
            <div v-if="!images.length" class="gs-images-empty">{{ generationNotice || generationError || '配图尚未返回，可点下方「换一批重新生成」再试。' }}</div>
            <div v-else class="gs-image-grid">
              <figure v-for="(image, index) in images" :key="index" :class="{ active: activeImageIndex === index, regenerating: regeneratingIndex === index }" @click="activeImageIndex = index">
                <div v-if="regeneratingIndex === index" class="gs-image-redrawing"><span class="gs-loader"></span>重绘中…</div>
                <img v-else :src="image.url" :alt="`配图 ${index + 1}`" />
                <figcaption>
                  <span>配图 {{ index + 1 }}</span>
                  <span class="gs-image-actions">
                    <button type="button" :disabled="saving || generating || regeneratingIndex >= 0" @click.stop="activeImageIndex = index; saveActiveImage()">保存</button>
                    <button type="button" :data-test="`graphic-sell-regenerate-${index}`" :disabled="generating || regeneratingIndex >= 0" @click.stop="activeImageIndex = index; regenerateImage(index)">重绘</button>
                  </span>
                </figcaption>
              </figure>
            </div>
            <p v-if="saveNotice" class="gs-save" :class="{ error: saveNoticeError }">{{ saveNotice }}<button v-if="savedPath" type="button" @click="revealSavedImage">打开文件夹</button></p>
          </section>

          <p v-if="generationNotice" class="gs-warn">{{ generationNotice }}</p>
          <p v-if="generationError" class="gs-error" data-test="graphic-sell-error">{{ generationError }}</p>
          <p v-if="copy.source === 'main-text'" class="gs-hint">本次文案由「主文本 API 回退」生成（设置中心未单独配置生图文本 API）。</p>
        </template>
      </main>

      <aside v-if="historyOpen" class="gs-history" data-test="graphic-sell-history" aria-label="图文带货历史记录">
        <header><h2>历史记录</h2><button type="button" class="gs-icon-button" aria-label="关闭历史" @click="historyOpen = false">×</button></header>
        <p v-if="!historySessions.length" class="gs-hint">还没有生成记录。生成成功后会自动保存文案与配图会话。</p>
        <article v-for="session in historySessions" :key="session.id" class="gs-history-item">
          <div class="gs-history-thumb"><img v-if="session.images[0]" :src="session.images[0].url" alt="" /><span v-else>文案</span></div>
          <div class="gs-history-meta"><strong>{{ session.title || '未命名会话' }}</strong><small>{{ session.platform }} · {{ session.style }} · {{ formatDate(session.createdAt) }}</small></div>
          <button type="button" class="gs-button" :disabled="generating || regeneratingIndex >= 0" @click="restoreSession(session)">恢复</button>
          <button type="button" class="gs-icon-button" aria-label="删除这条记录" :disabled="generating || regeneratingIndex >= 0" @click="removeHistorySession(session.id)">×</button>
        </article>
      </aside>
    </div>

    <footer class="gs-footer">
      <p class="gs-estimate">{{ regeneratingIndex >= 0 ? `正在重绘第 ${regeneratingIndex + 1} 张配图…` : generating ? phase : `将请求 ${plannedRequestCount} 次接口：1 次文案 + ${plannedRequestCount - 1} 次配图` }}</p>
      <p v-if="actionNotice" class="gs-action-notice" :class="{ error: actionNoticeError }" data-test="graphic-sell-action-notice">{{ actionNotice }}</p>
      <button type="button" class="gs-generate" data-test="graphic-sell-generate-button" :disabled="generating || regeneratingIndex >= 0 || !canGenerate" @click="requestGeneration"><span>ϟ</span>{{ generating ? (phase || '生成中…') : copy ? '换一批重新生成' : '生成带货图文' }}</button>
    </footer>

    <div v-if="confirmOpen" class="gs-confirm-backdrop" @click.self="confirmOpen = false">
      <section class="gs-confirm" role="dialog" aria-modal="true" aria-labelledby="gs-confirm-title" data-test="graphic-sell-confirm">
        <h2 id="gs-confirm-title">确认开始生成？</h2>
        <p>请求会发送到已保存的 AI 接口并可能产生第三方费用；先出文案，再按文案逐张出配图。</p>
        <dl>
          <div><dt>文案接口</dt><dd>{{ readiness.copyLabel }}</dd></div>
          <div><dt>生图服务</dt><dd>{{ imageStatusHint }}</dd></div>
          <div><dt>商品</dt><dd>{{ productName.trim() }}</dd></div>
          <div><dt>平台 / 风格</dt><dd>{{ platform }} · {{ style }}</dd></div>
          <div><dt>效果模板</dt><dd>{{ effectOption.label }} · 出镜：{{ sellModelLabel(model) }}</dd></div>
          <div><dt>配图</dt><dd>{{ imageCount }} 张 · {{ ratioLabel }}</dd></div>
          <div><dt>请求次数</dt><dd>{{ plannedRequestCount }} 次（1 次文案 + {{ plannedRequestCount - 1 }} 次配图）</dd></div>
          <div v-if="materials.length"><dt>商品素材</dt><dd>{{ materials.map(item => item.name).join('、') }}</dd></div>
        </dl>
        <div class="gs-confirm-actions">
          <button type="button" class="gs-button" @click="confirmOpen = false">取消</button>
          <button type="button" class="gs-button primary" data-test="graphic-sell-confirm-submit" @click="submitGeneration">确认发送</button>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { SELL_COPY_LIMITS } from '@shared/contracts/ai-sell-copy'
import {
  GRAPHIC_SELL_EFFECT_OPTIONS,
  GRAPHIC_SELL_IMAGE_COUNT_OPTIONS,
  GRAPHIC_SELL_PLATFORM_OPTIONS,
  GRAPHIC_SELL_RATIO_OPTIONS,
  GRAPHIC_SELL_STYLE_OPTIONS,
  MAX_GRAPHIC_SELL_MATERIALS,
  sellModelLabel
} from './graphic-sell'
import { useGraphicSellGeneration } from './use-graphic-sell'
// 用户提供的 4 张参考效果图（俯拍躺床 / 玩偶与小猫点缀 / 不同姿势），直接作为模板预览
import effectBedPinkTeddy from '../../assets/ui/graphic-sell/effect-bed-pink-teddy.jpg'
import effectBedBlueCat from '../../assets/ui/graphic-sell/effect-bed-blue-cat.jpg'
import effectBedBlueCrossed from '../../assets/ui/graphic-sell/effect-bed-blue-crossed.jpg'
import effectBedBlueArms from '../../assets/ui/graphic-sell/effect-bed-blue-arms.jpg'

const effectReferenceArts = [effectBedPinkTeddy, effectBedBlueCat, effectBedBlueCrossed, effectBedBlueArms]

const emit = defineEmits<{ (event: 'go-home'): void; (event: 'busy-change', busy: boolean): void }>()

const {
  productName,
  sellingPoints,
  price,
  originalPrice,
  audience,
  platform,
  style,
  effect,
  model,
  effectOption,
  modelOptions,
  requiresProductImage,
  selectEffect,
  imageCount,
  ratio,
  materials,
  materialInput,
  uploadError,
  onMaterialFiles,
  onMaterialDrop,
  removeMaterial,
  config,
  configError,
  readiness,
  generating,
  regeneratingIndex,
  phase,
  generationError,
  generationNotice,
  confirmOpen,
  copy,
  images,
  activeImageIndex,
  activeImage,
  editableTitle,
  editableBody,
  editableTagsText,
  editableCoverText,
  editableTags,
  canGenerate,
  plannedRequestCount,
  ratioLabel,
  requestGeneration,
  submitGeneration,
  resetAll,
  saving,
  savedPath,
  saveNotice,
  saveNoticeError,
  actionNotice,
  actionNoticeError,
  saveActiveImage,
  revealSavedImage,
  copySellText,
  regenerateImage,
  historySessions,
  historyOpen,
  restoreSession,
  removeHistorySession
} = useGraphicSellGeneration({ emit })

const platformNote = computed(() => GRAPHIC_SELL_PLATFORM_OPTIONS.find(item => item.key === platform.value)?.note || '')
const styleNote = computed(() => GRAPHIC_SELL_STYLE_OPTIONS.find(item => item.key === style.value)?.note || '')
const copyStatusHint = computed(() => readiness.value.copyReady
  ? `文案将走：${readiness.value.copyLabel}`
  : '未配置：请到设置中心 → AI 配置 → 生图文本 API（或主文本 API）填写地址、模型和 Key')
const imageStatusHint = computed(() => readiness.value.imageReady
  ? `生图模型：${config.value?.imageModel || readiness.value.imageLabel}`
  : '未配置：请到设置中心 → AI 配置 → 生图接口填写地址、模型和 Key')
const avatarLetter = computed(() => (productName.value.trim() || '图文带货').slice(0, 1))
const previewAspect = computed(() => ratio.value.replace(':', ' / '))

function formatDate(value: number): string {
  if (!value) return '时间未知'
  return new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}
</script>

<style scoped>
/* 图文带货是浅色工作台（外层导航仍是深色壳）：左配置面板 + 中笔记画布 + 右侧历史抽屉。 */
.graphic-sell-page{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;overflow:hidden;background:#f5f7fb;color:#16275e}
.gs-head{display:flex;align-items:center;justify-content:space-between;gap:16px;height:58px;min-height:58px;flex:0 0 58px;padding:0 24px;border-bottom:1px solid #edf0f5;background:rgba(255,255,255,.96);backdrop-filter:blur(10px);z-index:5}
.gs-brand{display:flex;align-items:center;gap:8px;min-width:0;color:#1e2a41;font-size:15px}
.gs-brand-mark{display:grid;place-items:center;width:31px;height:31px;border:0;border-radius:8px;background:#4c6fff;color:#fff;font-size:20px;cursor:pointer;box-shadow:0 4px 10px rgba(76,111,255,.22)}
.gs-crumb{overflow:hidden;color:#8b95a7;font-size:12px;text-overflow:ellipsis;white-space:nowrap}
.gs-status-bar{display:flex;align-items:center;gap:8px;min-width:0;overflow-x:auto;scrollbar-width:none}
.gs-status-bar::-webkit-scrollbar{display:none}
.gs-status{display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border:1px solid #e3e9f2;border-radius:999px;background:#f8fafd;color:#65758f;font-size:10px;white-space:nowrap;cursor:help}
.gs-status i{width:6px;height:6px;border-radius:50%;background:#f0a04b}
.gs-status.ready{border-color:#c9e9d8;background:#f2fbf6;color:#1d7a55}
.gs-status.ready i{background:#25b47a}
.gs-status.warn{border-color:#f2ddc0;background:#fff8ef;color:#a2620f}
.gs-ghost-button{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border:1px solid #e3e9f2;border-radius:8px;background:#fff;color:#5b6b87;font-size:11px;cursor:pointer;white-space:nowrap}
.gs-ghost-button:hover{border-color:#b9c6f7;color:#3949c9}
.gs-ghost-button em{padding:0 5px;border-radius:999px;background:#eef1ff;color:#4d5be0;font-size:10px;font-style:normal}
.gs-ghost-button:disabled{cursor:not-allowed;opacity:.5}
.gs-body{display:grid;grid-template-columns:minmax(300px,340px) minmax(0,1fr);gap:16px;flex:1;min-height:0;padding:16px 24px 0}
.gs-form{display:flex;flex-direction:column;gap:12px;min-height:0;overflow-y:auto;padding:0 6px 6px 0;scrollbar-width:thin}
.gs-card{flex:none;padding:14px;border:1px solid rgba(103,143,207,.2);border-radius:14px;background:rgba(255,255,255,.92);box-shadow:0 12px 30px rgba(91,125,180,.08)}
.gs-card h3{display:flex;align-items:center;gap:7px;margin:0 0 10px;color:#16275e;font-size:13px;font-weight:600}
.gs-card h3 i{display:grid;place-items:center;width:18px;height:18px;border-radius:50%;background:#e8ecff;color:#5b3df5;font-size:10px;font-style:normal}
.gs-card h3 em{margin-left:auto;color:#98a2b3;font-size:10px;font-style:normal;font-weight:400}
.gs-field{display:flex;flex-direction:column;gap:5px;margin-bottom:10px;color:#31508d;font-size:11px}
.gs-field:last-child{margin-bottom:0}
.gs-field small{color:#98a2b3;font-size:9px;font-weight:400}
.gs-field input,.gs-field select,.gs-field textarea{display:block;width:100%;padding:0 10px;border:1px solid rgba(103,143,207,.28);border-radius:9px;background:#fff;color:#22386e;font:inherit;font-size:12px;outline:0}
.gs-field input,.gs-field select{height:34px}
.gs-field textarea{min-height:78px;padding:8px 10px;resize:vertical;line-height:1.6}
.gs-field input:focus,.gs-field select:focus,.gs-field textarea:focus{border-color:#7188f7;box-shadow:0 0 0 3px rgba(113,136,247,.14)}
.gs-field input::placeholder,.gs-field textarea::placeholder{color:#9aa6bb}
.gs-count{align-self:flex-end;margin-top:-2px;color:#98a2b3;font-size:9px}
.gs-pair{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.gs-field-label{display:block;margin-bottom:6px;color:#31508d;font-size:11px}
.gs-hint{margin:0 0 8px;color:#7a8bad;font-size:10px;line-height:1.55}
.gs-field .gs-hint{margin:0}
.gs-error{margin:8px 0 0;color:#c13f61;font-size:11px;line-height:1.5;overflow-wrap:anywhere}
.gs-warn{margin:8px 0 0;color:#b54708;font-size:11px;line-height:1.5}
.gs-dropzone{display:flex;flex-direction:column;align-items:center;gap:5px;padding:16px 12px;border:1px dashed rgba(113,147,205,.55);border-radius:12px;background:rgba(246,250,255,.8);color:#5b6f9c;cursor:pointer;text-align:center}
.gs-dropzone:hover,.gs-dropzone:focus-visible{border-color:#6d4aff;background:rgba(238,242,255,.9);outline:none}
.gs-dropzone.full{cursor:not-allowed;opacity:.6}
.gs-plus{color:#6d4aff;font-size:20px;line-height:1}
.gs-dropzone strong{color:#33477d;font-size:11px}
.gs-dropzone small{color:#98a2b3;font-size:9px;line-height:1.5}
.gs-materials{display:flex;flex-direction:column;gap:6px;margin:10px 0 0;padding:0;list-style:none}
.gs-materials li{display:flex;align-items:center;gap:8px;padding:5px 7px;border-radius:9px;background:rgba(238,243,255,.78)}
.gs-materials img{width:32px;height:32px;object-fit:cover;border-radius:7px}
.gs-materials span{min-width:0;flex:1;overflow:hidden;color:#4a5b85;font-size:10px;text-overflow:ellipsis;white-space:nowrap}
.gs-materials button{display:inline-flex;padding:0 4px;border:0;background:transparent;color:#98a2b3;font-size:15px;cursor:pointer}
.gs-materials button:hover{color:#c13f61}
.gs-segmented{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-bottom:10px}
.gs-segmented button{height:30px;border:1px solid rgba(103,143,207,.24);border-radius:8px;background:#fff;color:#5b6b87;font-size:11px;cursor:pointer}
.gs-segmented button.active{border-color:#6d4aff;background:#eef0ff;color:#4d3bd8;font-weight:600}
.gs-effects{display:flex;flex-direction:column;gap:6px;margin-bottom:10px}
.gs-effect{display:flex;flex-direction:column;gap:3px;padding:9px 10px;border:1px solid rgba(103,143,207,.24);border-radius:10px;background:#fff;color:#4a5b85;text-align:left;cursor:pointer}
.gs-effect:hover{border-color:#9fb0f7}
.gs-effect.active{border-color:#6d4aff;background:#f3f1ff;box-shadow:0 0 0 2px rgba(109,74,255,.12)}
.gs-effect-name{display:flex;align-items:center;gap:6px;color:#263c6e;font-size:12px;font-weight:600}
.gs-effect-name em{padding:1px 6px;border-radius:999px;background:#efe9ff;color:#5b3df5;font-size:9px;font-style:normal;font-weight:600}
.gs-effect small{color:#8b96ab;font-size:10px;line-height:1.5}
.gs-effect-ref{margin-bottom:10px;padding:9px;border:1px solid rgba(103,143,207,.2);border-radius:10px;background:rgba(247,250,255,.8)}
.gs-effect-ref-head{display:flex;align-items:baseline;gap:8px;margin-bottom:7px}
.gs-effect-ref-head strong{color:#31508d;font-size:10px}
.gs-effect-ref-head small{color:#98a2b3;font-size:9px}
.gs-effect-ref-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:5px}
.gs-effect-ref-grid img{display:block;width:100%;aspect-ratio:9/16;object-fit:cover;border-radius:6px;background:#eef2f8}
.gs-canvas{display:flex;flex-direction:column;gap:14px;min-width:0;min-height:0;overflow-y:auto;padding:0 2px 16px;scrollbar-width:thin}
.gs-empty{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:320px;padding:28px;border:1px solid rgba(103,143,207,.18);border-radius:18px;background:rgba(255,255,255,.86);box-shadow:0 15px 38px rgba(91,125,180,.1);text-align:center}
.gs-kicker{color:#7f72d0;font-size:10px;letter-spacing:.1em}
.gs-empty h1{margin:0;color:#1f2a44;font-size:26px;letter-spacing:-.02em}
.gs-empty p{max-width:520px;margin:0;color:#7a8bad;font-size:12px;line-height:1.7}
.gs-flow{display:flex;gap:10px;margin:16px 0 4px;padding:0;list-style:none;flex-wrap:wrap;justify-content:center}
.gs-flow li{display:flex;width:150px;flex-direction:column;gap:3px;padding:12px;border:1px solid #e7ecf6;border-radius:12px;background:#fbfcff;text-align:left}
.gs-flow b{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:#e8ecff;color:#5b3df5;font-size:10px}
.gs-flow strong{color:#263c6e;font-size:12px}
.gs-flow small{color:#8b96ab;font-size:9px}
.gs-progress{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:320px;padding:28px;border:1px dashed rgba(113,136,247,.4);border-radius:18px;background:rgba(244,248,255,.8);text-align:center}
.gs-progress h2{margin:6px 0 0;color:#263c6e;font-size:18px}
.gs-progress p{margin:0;color:#7a8bad;font-size:11px}
.gs-loader{width:26px;height:26px;border:3px solid #e3e8f1;border-top-color:#6d4aff;border-radius:50%;animation:gs-spin .8s linear infinite}
@keyframes gs-spin{to{transform:rotate(360deg)}}
.gs-progress-steps{display:flex;gap:16px;margin-top:8px;color:#98a2b3;font-size:11px}
.gs-progress-steps .active{color:#4d5be0;font-weight:600}
.gs-progress-steps .done{color:#1d7a55}
.gs-note{display:flex;flex-direction:column;gap:0;max-width:760px;overflow:hidden;border:1px solid rgba(103,143,207,.2);border-radius:16px;background:#fff;box-shadow:0 15px 38px rgba(91,125,180,.12)}
.gs-note-head{display:flex;align-items:center;gap:9px;padding:12px 14px;border-bottom:1px solid #f0f3f8}
.gs-avatar{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:linear-gradient(150deg,#ffe0c2,#ffc7a0);color:#a9641c;font-size:13px;font-weight:600}
.gs-note-head div{display:flex;min-width:0;flex:1;flex-direction:column}
.gs-note-head b{color:#22304c;font-size:12px}
.gs-note-head small{color:#8b96ab;font-size:10px}
.gs-note-model{max-width:40%;overflow:hidden;color:#9aa6bb;font-size:10px;text-overflow:ellipsis;white-space:nowrap}
.gs-note-media{position:relative;display:grid;place-items:center;background:#f2f5fa;overflow:hidden}
.gs-note-media img{display:block;width:100%;height:100%;object-fit:cover}
.gs-media-placeholder{padding:40px;color:#98a2b3;font-size:12px}
.gs-page-count{position:absolute;right:10px;bottom:10px;padding:2px 8px;border-radius:999px;background:rgba(16,24,40,.55);color:#fff;font-size:10px}
.gs-thumbs{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid #f0f3f8;overflow-x:auto;scrollbar-width:thin}
.gs-thumbs button{flex:none;width:44px;height:44px;padding:0;overflow:hidden;border:1px solid #e3e9f2;border-radius:8px;background:#fff;cursor:pointer}
.gs-thumbs button.active{border-color:#6d4aff;box-shadow:0 0 0 2px rgba(109,74,255,.16)}
.gs-thumbs img{display:block;width:100%;height:100%;object-fit:cover}
.gs-note-body{padding:12px 14px 4px}
.gs-cover-text{margin:0 0 10px;padding:7px 10px;border-radius:8px;background:#fff5e8;color:#a2620f;font-size:11px;line-height:1.5}
.gs-tags{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}
.gs-tags span{color:#4f69dc;font-size:11px}
.gs-note-actions{display:flex;flex-wrap:wrap;gap:8px;padding:8px 14px 14px}
.gs-button{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:32px;padding:0 12px;border:1px solid #dbe3f2;border-radius:9px;background:#fff;color:#3c548c;font-size:11px;cursor:pointer}
.gs-button:hover{border-color:#9fb0f7;color:#2f3fc4}
.gs-button.primary{border-color:#5b3df5;background:#6d4aff;color:#fff}
.gs-button.primary:hover{background:#5b3df5}
.gs-button:disabled{cursor:not-allowed;opacity:.55}
.gs-icon-button{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:#98a2b3;font-size:16px;cursor:pointer}
.gs-icon-button:hover{background:#f2f5fb;color:#c13f61}
.gs-images{max-width:760px;padding:16px;border:1px solid rgba(103,143,207,.2);border-radius:16px;background:#fff;box-shadow:0 12px 30px rgba(91,125,180,.08)}
.gs-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:10px}
.gs-section-head h2{margin:0;color:#22304c;font-size:14px}
.gs-section-head span{color:#8b96ab;font-size:10px}
.gs-images-empty{padding:18px;border:1px dashed #dbe3f2;border-radius:10px;background:#fafcff;color:#7a8bad;font-size:11px;line-height:1.6}
.gs-image-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px}
.gs-image-grid figure{margin:0;overflow:hidden;border:1px solid #e3e9f2;border-radius:10px;background:#fff;cursor:pointer}
.gs-image-grid figure.active{border-color:#6d4aff;box-shadow:0 0 0 2px rgba(109,74,255,.16)}
.gs-image-grid figure.regenerating{border-color:#6d4aff;box-shadow:0 0 0 2px rgba(109,74,255,.16)}
.gs-image-grid img{display:block;width:100%;aspect-ratio:3/4;object-fit:cover}
.gs-image-redrawing{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;width:100%;aspect-ratio:3/4;background:rgba(244,248,255,.92);color:#5b6f9c;font-size:10px}
.gs-image-grid figcaption{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 8px;color:#68768c;font-size:10px}
.gs-image-actions{display:inline-flex;align-items:center;gap:4px}
.gs-image-grid figcaption button{padding:2px 7px;border:1px solid #dbe3f2;border-radius:6px;background:#fff;color:#4f5f83;font-size:10px;cursor:pointer}
.gs-image-grid figcaption button:hover{border-color:#9fb0f7;color:#2f3fc4}
.gs-image-grid figcaption button:disabled{cursor:not-allowed;opacity:.5}
.gs-save{display:flex;align-items:center;gap:8px;margin:10px 0 0;color:#1d7a55;font-size:10px;line-height:1.5;overflow-wrap:anywhere}
.gs-save.error{color:#c13f61}
.gs-save button{padding:2px 7px;border:1px solid #dbe3f2;border-radius:6px;background:#fff;color:#4f5f83;font-size:10px;cursor:pointer}
.gs-history{position:absolute;top:74px;right:16px;bottom:74px;z-index:8;display:flex;width:min(360px,88vw);flex-direction:column;gap:8px;overflow-y:auto;padding:14px;border:1px solid #e3e9f2;border-radius:14px;background:#fff;box-shadow:0 24px 60px rgba(16,24,40,.18);scrollbar-width:thin}
.gs-history header{display:flex;align-items:center;justify-content:space-between;gap:8px}
.gs-history h2{margin:0;color:#22304c;font-size:14px}
.gs-history-item{display:flex;align-items:center;gap:8px;padding:8px;border:1px solid #eef1f7;border-radius:10px;background:#fbfcff}
.gs-history-thumb{display:grid;place-items:center;width:44px;height:44px;flex:none;overflow:hidden;border-radius:8px;background:repeating-linear-gradient(135deg,#f1f4f8 0,#f1f4f8 6px,#f8fafc 6px,#f8fafc 12px);color:#98a2b3;font-size:9px}
.gs-history-thumb img{display:block;width:100%;height:100%;object-fit:cover}
.gs-history-meta{display:flex;min-width:0;flex:1;flex-direction:column;gap:3px}
.gs-history-meta strong{overflow:hidden;color:#263c6e;font-size:11px;text-overflow:ellipsis;white-space:nowrap}
.gs-history-meta small{overflow:hidden;color:#8b96ab;font-size:9px;text-overflow:ellipsis;white-space:nowrap}
.gs-footer{display:flex;align-items:center;gap:14px;min-height:64px;flex:0 0 auto;margin-top:12px;padding:10px 24px;border-top:1px solid #e9edf5;background:rgba(255,255,255,.96)}
.gs-estimate{margin:0;flex:1;min-width:0;overflow:hidden;color:#7a8bad;font-size:10px;line-height:1.5;text-overflow:ellipsis;white-space:nowrap}
.gs-action-notice{margin:0;color:#1d7a55;font-size:11px;white-space:nowrap}
.gs-action-notice.error{color:#c13f61}
.gs-generate{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-width:200px;min-height:40px;padding:0 20px;border:1px solid #5b3df5;border-radius:11px;background:#6d4aff;color:#fff;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 8px 20px rgba(109,74,255,.24)}
.gs-generate:disabled{cursor:not-allowed;opacity:.55;box-shadow:none}
.gs-confirm-backdrop{position:fixed;inset:0;z-index:300;display:grid;place-items:center;padding:20px;background:rgba(16,24,40,.42)}
.gs-confirm{width:min(540px,100%);padding:20px;border:1px solid rgba(118,101,229,.42);border-radius:16px;background:#fff;color:#16275e;box-shadow:0 24px 60px rgba(16,24,40,.28)}
.gs-confirm h2{margin:0 0 8px;font-size:17px}
.gs-confirm p{margin:0 0 12px;color:#65769b;font-size:12px;line-height:1.6}
.gs-confirm dl{display:flex;flex-direction:column;gap:6px;margin:0 0 14px;padding:10px 12px;border-radius:10px;background:#f1f5ff}
.gs-confirm dl>div{display:flex;gap:10px;font-size:11px}
.gs-confirm dt{flex:0 0 74px;color:#7181a4}
.gs-confirm dd{margin:0;color:#2c427e;overflow-wrap:anywhere}
.gs-confirm-actions{display:flex;justify-content:flex-end;gap:8px}
.gs-visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:1080px){.gs-body{grid-template-columns:minmax(0,1fr)}.gs-form{max-height:44vh}.gs-note,.gs-images{max-width:none}}
</style>
