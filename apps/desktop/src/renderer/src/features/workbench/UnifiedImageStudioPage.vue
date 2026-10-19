<template>
  <section class="image-studio-page" :class="{ 'detail-mode': mode === 'detail' }" data-test="unified-image-studio-page">
    <header class="studio-page-head">
      <div class="studio-brand"><button type="button" class="studio-brand-mark" aria-label="返回首页" @click="emit('go-home')">ϟ</button><strong>店管家</strong></div>
      <nav class="studio-top-nav" data-test="studio-top-nav" aria-label="AI 商品创作导航">
        <button v-for="item in creativeModes" :key="item.key" type="button" :class="{ active: mode === item.key }" :data-test="`studio-top-nav-${item.key}`" :disabled="generating || sceneGenerating || confirmOpen || sceneConfirmOpen" @click="mode = item.key">{{ item.label }}</button>
      </nav>
    </header>

    <template v-if="mode === 'detail'">
      <div class="detail-composer" data-test="detail-composer">
        <aside class="detail-sidebar">
          <section class="detail-panel-card">
            <h3><i>1</i>商品素材 <em>* <small>1–3 张</small></em></h3>
            <div class="detail-upload" :class="{ filled: materials.length >= 3 }" role="button" tabindex="0" data-test="detail-material-dropzone" @click="materialInput?.click()" @keydown.enter.prevent="materialInput?.click()" @dragover.prevent @drop.prevent="onMaterialDrop">
              <input ref="materialInput" class="visually-hidden" type="file" multiple accept=".jpg,.jpeg,.png,image/jpeg,image/png" data-test="detail-material-input" @change="onMaterialFiles" />
              <svg class="detail-upload-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4m-4 4 4-4 4 4M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></svg><strong>拖拽或点击上传图片</strong><small>支持 JPG / PNG，最多 3 张</small>
            </div>
            <ul v-if="materials.length" class="detail-material-list"><li v-for="(item, index) in materials" :key="`${item.name}-${index}`"><img :src="item.dataUrl" :alt="item.name" /><span>{{ item.name }}</span><button type="button" :aria-label="`移除 ${item.name}`" @click="removeMaterial(index)">×</button></li></ul>
            <p v-if="uploadError" class="detail-error">{{ uploadError }}</p>
          </section>

          <section class="detail-panel-card">
            <h3><i>2</i>商品名称 <em>*</em></h3>
            <input v-model="productName" class="detail-input" type="text" maxlength="60" placeholder="例如：便携折叠露营椅" data-test="detail-product-name" />
            <label class="detail-field-label">内容重点 <small>选填</small></label>
            <textarea v-model="prompt" class="detail-textarea" maxlength="300" rows="3" placeholder="希望重点表达的卖点、使用场景或目标人群" data-test="detail-prompt"></textarea>
            <div class="detail-counter">{{ prompt.length }} / 300</div>
          </section>

          <section class="detail-panel-card detail-options-card">
            <h3><i>3</i>笔记风格</h3>
            <select v-model="detailNoteStyle" class="detail-select" data-test="detail-note-style"><option value="种草分享">种草分享</option><option value="测评对比">测评对比</option><option value="生活方式">生活方式</option><option value="使用教程">使用教程</option></select>
            <label class="detail-field-label">卡片数量</label>
            <div class="detail-segmented"><button v-for="count in [4,5,6,7,8]" :key="count" type="button" :class="{ active: detailCardCount === count }" @click="detailCardCount = count">{{ count }}</button><input v-model.number="detailCardCount" type="number" min="1" max="9" aria-label="卡片数量" @change="normalizeContentCount('detail')" /></div>
            <label class="detail-field-label">生图模型</label><select :value="usedModel || '未配置'" class="detail-select" data-test="detail-model" disabled :title="usedModel ? '模型来自设置中心，生成时使用此模型' : '请先在设置中心配置生图模型'"><option>{{ usedModel || '未配置' }}</option></select>
            <label class="detail-field-label">发布比例</label><select v-model="detailRatio" class="detail-select" data-test="detail-ratio"><option v-for="ratio in ratioOptions" :key="ratio.key" :value="ratio.key">{{ ratio.label }}</option></select>
            <label class="detail-field-label">字体</label><div class="font-select-control detail-font-control"><select v-model="detailFont" class="detail-select" data-test="detail-font"><option v-for="font in fontOptions" :key="font.key" :value="font.key">{{ font.label }}</option></select><span class="font-info" data-test="detail-font-meta" :title="fontLicenseHint" :aria-label="fontLicenseHint">⚠</span></div>
          </section>
        </aside>

        <main class="detail-canvas">
          <div class="detail-canvas-head"><h1>商品一键生成笔记</h1><p>配套图片、标题、正文和话题，一次备齐</p></div>
          <div class="detail-preview-wrap">
            <div class="detail-preview-title"><strong>完整小红书笔记</strong><span>案例示意</span></div>
            <div class="detail-case-controls" role="group" aria-label="案例演示控制">
              <button type="button" class="detail-case-icon-btn" data-test="detail-case-restart" aria-label="重新播放案例" title="重新播放案例" @click="restartDetailCase">↻</button>
              <button type="button" class="detail-case-icon-btn" data-test="detail-case-toggle" :aria-label="detailCasePlaying ? '暂停案例演示' : '播放案例演示'" :title="detailCasePlaying ? '暂停案例演示' : '播放案例演示'" @click="detailCasePlaying = !detailCasePlaying">{{ detailCasePlaying ? 'Ⅱ' : '▶' }}</button>
            </div>
            <article class="detail-note-card" data-test="detail-note-preview">
              <header><span class="detail-avatar">穿</span><b>穿搭灵感集</b><em>小红书</em><span class="detail-share">♧</span></header>
              <div class="detail-note-image" :style="{ aspectRatio: detailPreviewAspectRatio }">
                <img :src="detailPreviewArt" :alt="`笔记配图：${detailCaseLabels[detailCasePhase] || '穿搭封面'}`" />
                <span class="detail-page-count">1 / {{ Math.max(1, Math.min(9, Number(detailCardCount) || 6)) }}</span>
              </div>
              <div class="detail-note-body" :style="{ fontFamily: detailFontOption.cssFamily }"><h2>{{ productName.trim() || '一条丝巾，点亮秋冬基础款穿搭' }}</h2><p>{{ prompt.trim() || '蓝橙撞色，给素色大衣添一点亮点。系在颈间、披在肩上，或点缀包袋，同一条丝巾也能搭出不同心情。' }}</p><div class="detail-note-tags">#秋冬穿搭&nbsp; #丝巾搭配&nbsp; #日常穿搭</div><footer><span class="detail-comment-placeholder">说点什么...</span><span>♡</span><span>☆</span><span>◌</span></footer></div>
            </article>
            <p class="detail-preview-status">✓ 图片与文案，组成一篇完整笔记</p>
            <section v-if="activeImage || generating || generationError" class="detail-generated-result" data-test="detail-results">
              <div class="detail-generated-heading"><strong>真实生成结果</strong><span v-if="generatedImages.length">{{ activeImageIndex + 1 }} / {{ generatedImages.length }}</span></div>
              <div v-if="generating" class="chat-generating"><span class="loader"></span>正在等待供应商返回真实图片…</div>
              <div v-else-if="generationError && !activeImage" class="chat-error"><p>{{ generationError }}</p><button type="button" class="studio-button ghost" @click="requestGeneration">重试</button></div>
              <template v-else>
                <div class="detail-generated-thumbs"><button v-for="(image, index) in generatedImages" :key="`${image.url.slice(-24)}-${index}`" type="button" :class="['result-thumb', { active: activeImageIndex === index }]" @click="activeImageIndex = index"><img :src="image.url" :alt="`详情图 ${index + 1}`" /></button></div>
                <div v-if="activeImage" class="detail-generated-preview"><img data-test="detail-generated-image" :src="activeImage.url" alt="真实生成的详情图" /><div><span>模型：{{ activeImage.model }}</span><span>耗时：{{ activeImage.elapsedMs }}ms</span><button type="button" class="studio-button primary" :disabled="saving" @click="saveActiveImage">{{ saving ? '保存中…' : '保存图片' }}</button></div></div>
              </template>
              <p v-if="generationNotice" class="chat-notice">{{ generationNotice }}</p>
            </section>
          </div>
        </main>

        <footer class="detail-composer-footer"><p>将生成 {{ Math.max(1, Number(detailCardCount) || 6) }} 张图文卡片</p><button type="button" class="detail-generate-button" data-test="detail-generate-button" :disabled="!materials.length || !productName.trim() || generating || !configured" @click="requestGeneration"><span>ϟ</span>{{ generating ? '生成中…' : materials.length && productName.trim() ? '生成图文详情' : '请上传商品图片' }}</button></footer>
      </div>
    </template>

    <template v-else-if="mode === 'edit'">
      <div class="edit-workspace" data-test="edit-workspace">
        <aside class="edit-session-sidebar" aria-label="自由编辑会话">
          <button type="button" class="edit-new-session" data-test="edit-new-session" @click="resetEditSession"><span>＋</span>新对话</button>
          <div class="edit-history-title"><span>历史会话</span><em>{{ editSessionRecords.length }}</em></div>
          <button v-for="session in editSessionRecords" :key="session.id" type="button" class="edit-history-session" :class="{ active: activeEditSessionId === session.id }" @click="openHistorySession(session)"><strong>{{ session.title }}</strong><small>{{ session.items.length }} 轮 · {{ formatHistoryDate(session.createdAt) }}</small></button>
          <p v-if="!editSessionRecords.length" class="edit-history-empty">暂无历史会话</p>
        </aside>
        <main class="edit-main">
          <header class="edit-main-head"><strong>新对话</strong><span>自由编辑</span></header>
          <section class="edit-cases" aria-label="自由编辑使用案例">
            <div class="edit-case-stage">
              <div class="edit-case-image edit-case-compare">
                <img class="edit-case-base" :src="referenceMaterial?.dataUrl || editCaseArt.before" alt="图片翻译原图" />
                <div class="edit-case-after" :style="{ width: `${editCaseProgress}%` }"><img :src="editCaseArt.after" alt="图片翻译效果图" /></div>
                <span class="edit-case-label original">原图</span><span class="edit-case-label result">效果图</span>
                <input v-model.number="editCaseProgress" class="edit-case-slider" type="range" min="0" max="100" aria-label="原图与效果图对比" />
              </div>
              <div class="edit-case-copy"><h2>{{ editPresetOptions.find(item => item.key === editPreset)?.label || '图片翻译' }}</h2><p>按示例提示词快速开始编辑</p><button type="button" class="edit-use-prompt" @click="applyEditPreset(editPreset)">↓ 使用提示词</button></div>
              <button type="button" class="edit-case-toggle" data-test="edit-case-toggle" :aria-label="editCasePlaying ? '暂停自动播放' : '继续自动播放'" @click="editCasePlaying = !editCasePlaying">{{ editCasePlaying ? 'Ⅱ' : '▶' }}</button>
            </div>
            <div class="edit-case-tabs" role="tablist" aria-label="编辑案例">
              <button v-for="preset in editPresetOptions" :key="preset.key" type="button" role="tab" :aria-selected="editPreset === preset.key" :aria-label="preset.label" :class="{ active: editPreset === preset.key }" @click="applyEditPreset(preset.key)"><img :src="preset.thumb" alt="" /><span>{{ preset.label }}</span></button>
            </div>
          </section>
          <section class="edit-composer" data-test="edit-composer">
            <textarea v-model="prompt" maxlength="2000" placeholder="描述你想生成或修改的画面" aria-label="图片编辑要求" data-test="edit-prompt"></textarea>
            <div class="edit-composer-toolbar">
              <label class="edit-upload-button" data-test="edit-upload-button"><input ref="referenceInput" class="visually-hidden" type="file" multiple accept=".jpg,.jpeg,.png,image/jpeg,image/png" data-test="edit-reference-input" @change="onReferenceFile" /><svg class="inline-tool-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="10" r="1.5" /><path d="m5 17 5-5 3 3 3-4 3 6" /></svg>上传参考图</label>
              <button type="button" class="edit-optimize-button" :disabled="!prompt.trim()" @click="optimizeEditPrompt">✦ 优化提示词</button>
              <span class="edit-prompt-count">{{ prompt.length }} / 2000</span>
            </div>
            <p v-if="referenceUploadError" class="edit-generation-error">{{ referenceUploadError }}</p>
            <div class="edit-parameter-row">
              <label>生图模型<select :value="usedModel || '未配置'" disabled><option>{{ usedModel || '未配置' }}</option></select></label>
              <label>输出比例<select v-model="selectedRatio"><option v-for="ratio in freeEditRatioOptions" :key="ratio.key" :value="ratio.key">{{ ratio.label }}</option></select></label>
              <label>字体<span class="font-select-control"><select v-model="selectedFont"><option v-for="font in fontOptions" :key="font.key" :value="font.key">{{ font.label }}</option></select><span class="font-info" :title="fontLicenseHint" :aria-label="fontLicenseHint">⚠</span></span></label>
            </div>
            <button type="button" class="edit-send-button" data-test="edit-generate-button" :aria-label="generating ? '生成中' : '发送生成请求'" :title="generating ? '生成中…' : '发送生成请求'" :disabled="generating || !referenceMaterial || !prompt.trim() || !configured" @click="requestGeneration"><span>➤</span></button>
            <p v-if="generationError" class="edit-generation-error">{{ generationError }}</p>
          </section>
          <section v-if="activeImage" class="edit-result" data-test="edit-result"><img :src="activeImage.url" :alt="activeKindLabel" /><div><strong>{{ activeKindLabel }}</strong><button type="button" class="studio-button primary" :disabled="saving" @click="saveActiveImage">{{ saving ? '保存中…' : '保存图片' }}</button></div></section>
        </main>
      </div>
    </template>

    <template v-else-if="mode === 'replicate'">
      <div class="replicate-workspace" data-test="replicate-workspace">
        <aside class="replicate-sidebar">
          <section class="config-card replicate-step-card">
            <h3 class="config-title"><i>1</i>上传竞品参考图<em>* {{ competitorReferences.length }}/9张</em></h3>
            <p class="config-sub"><b>示例</b> 从竞品/同行找到的、你想替换的图片</p>
            <div class="dropzone" :class="{ full: competitorReferences.length >= 9 }" role="button" tabindex="0" data-test="competitor-dropzone" @click="competitorInput?.click()" @keydown.enter.prevent="competitorInput?.click()" @dragover.prevent @drop.prevent="onCompetitorDrop">
              <input ref="competitorInput" class="visually-hidden" type="file" multiple accept=".jpg,.jpeg,.png,image/jpeg,image/png" data-test="competitor-reference-input" @change="onCompetitorFiles" />
              <span class="dz-plus">+</span><strong>拖拽或点击上传图片</strong><small>1-9 张，每张不超过 5M，仅支持 JPG/PNG 格式</small>
            </div>
            <ul v-if="competitorReferences.length" class="dz-list"><li v-for="(item, index) in competitorReferences" :key="`${item.name}-${index}`"><img :src="item.dataUrl" :alt="item.name" /><span>{{ item.name }}</span><button type="button" :aria-label="`移除参考图 ${item.name}`" @click="removeCompetitorReference(index)">×</button></li></ul><p v-if="referenceUploadError" class="config-warn error">{{ referenceUploadError }}</p>
          </section>
          <section class="config-card replicate-step-card">
            <h3 class="config-title"><i>2</i>上传你的商品素材图<em>* {{ materials.length }}/1张</em></h3>
            <p class="config-sub"><b>示例</b> 上传白底/背景干净的图片效果更佳</p>
            <div class="dropzone" :class="{ full: materials.length >= 1 }" role="button" tabindex="0" data-test="replicate-material-dropzone" @click="materialInput?.click()" @keydown.enter.prevent="materialInput?.click()" @dragover.prevent @drop.prevent="onMaterialDrop">
              <input ref="materialInput" class="visually-hidden" type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" data-test="replicate-material-input" @change="onMaterialFiles" />
              <span class="dz-plus">+</span><strong>拖拽或点击上传图片</strong><small>不超过 5M，仅支持 JPG/PNG 格式</small>
            </div>
            <ul v-if="materials.length" class="dz-list"><li v-for="(item, index) in materials" :key="`${item.name}-${index}`"><img :src="item.dataUrl" :alt="item.name" /><span>{{ item.name }}</span><button type="button" :aria-label="`移除 ${item.name}`" @click="removeMaterial(index)">×</button></li></ul><p v-if="uploadError" class="config-warn error">{{ uploadError }}</p>
          </section>
          <section class="config-card replicate-step-card">
            <h3 class="config-title"><i>3</i>生成参数</h3>
            <label class="inline-field">生图模型<select :value="usedModel || '未配置'" disabled><option>{{ usedModel || '未配置' }}</option></select></label>
            <label class="inline-field">比例大小<select v-model="selectedRatio"><option v-for="ratio in ratioOptions" :key="ratio.key" :value="ratio.key">{{ ratio.label }}</option></select></label>
            <label class="inline-field">字体<span class="font-select-control"><select v-model="selectedFont"><option v-for="font in fontOptions" :key="font.key" :value="font.key">{{ font.label }}</option></select><span class="font-info" :title="fontLicenseHint" :aria-label="fontLicenseHint">⚠</span></span></label>
            <p class="config-note">输出图片会按所选比例进行构图</p>
            <p v-if="generationError" class="config-warn error">{{ generationError }}</p>
          </section>
        </aside>
        <footer class="special-generate-footer"><p>上传参考图和商品素材后即可开始复刻</p><button type="button" class="generate-button" data-test="replicate-generate-button" :disabled="generating || !configured || !materials.length || !competitorReferences.length" @click="requestGeneration">{{ generating ? '生成中…' : '开始复刻' }} <span>→</span></button><p v-if="generationError" class="config-warn error">{{ generationError }}</p></footer>
        <main class="replicate-main">
          <section v-if="!generatedImages.length && !generating" class="replicate-hero">
            <span class="special-kicker">PRODUCT REPLICA</span><h1>只需两步，轻松复刻商品视觉</h1><p>保留竞品图片的构图与氛围，将画面主体替换为你的商品</p>
            <div class="replicate-flow"><figure><img :src="referenceArt" alt="商品素材图预览" /><figcaption>商品素材</figcaption></figure><b>＋</b><figure><img :src="replicaArt" alt="竞品参考图预览" /><figcaption>竞品示例</figcaption></figure><b>→</b><figure><img :src="resultArt" alt="商品复刻效果示例" /><figcaption>生成结果</figcaption></figure></div>
            <div class="special-steps"><span>01 <b>上传竞品参考图</b></span><span>02 <b>上传你的商品</b></span><span>03 <b>一键复刻</b></span></div>
          </section>
          <section v-else class="studio-card results-card" data-test="replicate-results"><div class="card-heading compact"><div><span class="card-kicker">RESULT</span><h2>复刻结果</h2><p>点缩略图切换预览并保存。</p></div><span v-if="generatedImages.length" class="result-count">{{ activeImageIndex + 1 }}/{{ generatedImages.length }}</span></div><div v-if="generating" class="chat-generating"><span class="loader"></span>正在生成真实结果…</div><div v-for="group in generatedGroups" :key="group.kind" class="result-group"><div class="result-group-head"><strong>{{ group.label }}</strong></div><div class="result-grid"><button v-for="item in group.items" :key="`${item.image.url.slice(-24)}-${item.index}`" type="button" :class="['result-thumb', { active: activeImageIndex === item.index }]" @click="activeImageIndex = item.index"><img :src="item.image.url" :alt="`${group.label} ${item.index + 1}`" /></button></div></div><div v-if="activeImage" class="result-actions"><button type="button" class="studio-button primary" :disabled="saving" @click="saveActiveImage">{{ saving ? '保存中…' : '保存图片' }}</button></div></section>
        </main>
      </div>
    </template>

    <template v-else-if="mode === 'model'">
      <div class="special-workspace model-workspace" data-test="model-workspace">
        <aside class="special-sidebar">
          <section class="config-card"><h3 class="config-title"><i>1</i>上传你的商品素材图<em>* {{ materials.length }}/2张</em></h3><p class="config-sub">上传商品多角度图片，主体清晰效果更佳</p><div class="dropzone" :class="{ full: materials.length >= 2 }" role="button" tabindex="0" data-test="model-material-dropzone" @click="materialInput?.click()" @keydown.enter.prevent="materialInput?.click()" @dragover.prevent @drop.prevent="onMaterialDrop"><input ref="materialInput" class="visually-hidden" type="file" multiple accept=".jpg,.jpeg,.png,image/jpeg,image/png" @change="onMaterialFiles" /><span class="dz-plus">+</span><strong>拖拽或点击上传图片</strong><small>1-2 张，每张不超过 5M，仅支持 JPG/PNG 格式</small></div><ul v-if="materials.length" class="dz-list"><li v-for="(item, index) in materials" :key="`${item.name}-${index}`"><img :src="item.dataUrl" :alt="item.name" /><span>{{ item.name }}</span><button type="button" @click="removeMaterial(index)">×</button></li></ul><p v-if="uploadError" class="config-warn error">{{ uploadError }}</p></section>
            <section class="config-card"><h3 class="config-title"><i>2</i>模特形象<em>*</em></h3><div class="model-source-tabs" role="tablist" aria-label="模特形象来源"><button v-for="source in modelSourceOptions" :key="source.key" type="button" role="tab" :aria-selected="modelSource === source.key" :class="{ active: modelSource === source.key }" @click="modelSource = source.key">{{ source.label }}</button></div><div v-if="modelSource === 'library'" class="model-library-grid" aria-label="模特库列表"><button v-for="modelItem in modelLibraryOptions" :key="modelItem.key" type="button" :aria-label="modelItem.label" :class="{ active: modelAppearance === modelItem.label }" @click="modelAppearance = modelItem.label"><img class="model-card-art" :src="modelItem.dataUrl" :alt="modelItem.label" /></button></div><div v-else-if="modelSource === 'mine'" class="library-upload-block"><label class="library-upload-button"><input ref="modelLibraryInput" class="visually-hidden" type="file" multiple accept=".jpg,.jpeg,.png,image/jpeg,image/png" @change="onModelLibraryFiles" /><span>＋</span>上传模特图</label><p v-if="modelLibraryUploadError" class="config-warn error">{{ modelLibraryUploadError }}</p><div v-if="modelLibraryUploads.length" class="uploaded-library-grid"><button v-for="item in modelLibraryUploads" :key="item.name" type="button" :class="{ active: modelAppearance === item.name }" @click="modelAppearance = item.name"><img :src="item.dataUrl" :alt="item.name" /><small>{{ item.name }}</small></button></div><p v-else-if="!modelLibraryUploadError" class="library-empty">还没有模特形象，点击上方上传</p></div><div v-else><div class="profile-grid"><label>性别<select v-model="modelGender"><option>女</option><option>男</option><option>不限定</option></select></label><label>年龄段<select v-model="modelAge"><option>青年</option><option>少年</option><option>中年</option><option>不限定</option></select></label><label>人种<select v-model="modelEthnicity"><option>中国人</option><option>亚洲人</option><option>不限定</option></select></label><label>体型<select v-model="modelBody"><option>标准</option><option>纤细</option><option>健美</option><option>丰满</option><option>不限定</option></select></label></div><input v-model="modelAppearance" type="text" maxlength="200" placeholder="外貌细节（可选），例：小麦色皮肤、齐刘海、长发" data-test="model-appearance" /><button type="button" class="model-inline-generate-button" :disabled="generating || !configured || !materials.length || modeNeedsLibraryAsset" @click="requestGeneration">{{ generating ? '生成中…' : 'AI生成模特' }}</button></div></section>
            <section class="config-card"><h3 class="config-title"><i>3</i>拍摄场景<em>*</em></h3><div class="model-source-tabs" role="tablist" aria-label="拍摄场景来源"><button v-for="source in sceneSourceOptions" :key="source.key" type="button" role="tab" :aria-selected="sceneSource === source.key" :class="{ active: sceneSource === source.key }" @click="sceneSource = source.key">{{ source.label }}</button></div><div v-if="sceneSource === 'library'" class="scene-library-list"><button type="button" class="scene-smart" :aria-label="'智能推荐 生成模特图时智能匹配场景'" :class="{ active: modelScene === '智能推荐' }" @click="modelScene = '智能推荐'"><strong>✦ 智能推荐</strong><small>生成模特图时智能匹配场景</small></button><button v-for="scene in sceneLibraryOptions" :key="scene.key" type="button" :aria-label="scene.label" :class="{ active: modelScene === scene.label }" @click="modelScene = scene.label"><img class="scene-card-art" :src="scene.dataUrl" :alt="scene.label" /></button></div><div v-else-if="sceneSource === 'ai'" class="scene-ai-editor"><label class="model-scene-label">场景描述<input v-model="modelScene" type="text" maxlength="200" placeholder="例如：城市街头、暖光咖啡馆" /></label><div class="scene-reference-actions"><label class="library-upload-button"><input ref="sceneReferenceInput" class="visually-hidden" type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" @change="onSceneReferenceFile" /><span>＋</span>上传参考图抠图</label><button type="button" class="scene-generate-button" :disabled="sceneGenerating || generating || confirmOpen || sceneConfirmOpen || !configured" @click="requestSceneGeneration">{{ sceneGenerating ? '生成中…' : 'AI生成场景' }}</button></div><small class="scene-reference-hint">仅擦除图中人物，保留背景与商品</small><p v-if="sceneReference" class="scene-reference-selected">已选择：{{ sceneReference.name }}</p><p v-if="sceneGenerationError" class="config-warn error">{{ sceneGenerationError }}</p></div><div v-else class="library-upload-block"><label class="library-upload-button"><input ref="sceneLibraryInput" class="visually-hidden" type="file" multiple accept=".jpg,.jpeg,.png,image/jpeg,image/png" @change="onSceneLibraryFiles" /><span>＋</span>上传场景图</label><p v-if="sceneLibraryUploadError" class="config-warn error">{{ sceneLibraryUploadError }}</p><div v-if="sceneLibraryUploads.length" class="uploaded-library-grid"><button v-for="item in sceneLibraryUploads" :key="item.name" type="button" :class="{ active: modelScene === item.name }" @click="modelScene = item.name"><img :src="item.dataUrl" :alt="item.name" /><small>{{ item.name }}</small></button></div><p v-else-if="!sceneLibraryUploadError" class="library-empty">还没有拍摄场景，点击上方上传</p></div></section>
           <section class="config-card"><h3 class="config-title"><i>4</i>生成参数</h3><label class="inline-field">生图模型<select :value="usedModel || '未配置'" disabled><option>{{ usedModel || '未配置' }}</option></select></label><label class="inline-field">比例大小<select v-model="selectedRatio"><option v-for="ratio in ratioOptions" :key="ratio.key" :value="ratio.key">{{ ratio.label }}</option></select></label><label class="inline-field">字体<span class="font-select-control"><select v-model="selectedFont"><option v-for="font in fontOptions" :key="font.key" :value="font.key">{{ font.label }}</option></select><span class="font-info" :title="fontLicenseHint" :aria-label="fontLicenseHint">⚠</span></span></label><label class="model-scene-label">生成数量 <output>{{ modelCount }} 张</output></label><input v-model.number="modelCount" class="model-count-range" type="range" min="1" max="5" step="1" aria-label="生成数量" /><p v-if="modeNeedsLibraryAsset" class="config-warn">{{ libraryAssetRequirement }}</p><p v-if="generationError" class="config-warn error">{{ generationError }}</p></section>
         </aside>
        <footer class="special-generate-footer"><p>选择模特与场景后即可生成 {{ modelCount }} 张模特图</p><button type="button" class="generate-button" data-test="model-generate-button" :disabled="generating || sceneGenerating || confirmOpen || sceneConfirmOpen || !configured || !materials.length || modeNeedsLibraryAsset" @click="requestGeneration">{{ generating ? '生成中…' : 'AI生成模特' }} <span>→</span></button><p v-if="generationError" class="config-warn error">{{ generationError }}</p></footer>
        <main class="special-main"><section v-if="!generatedImages.length && !generating" class="special-hero"><span class="special-kicker">AI MODEL STUDIO</span><h1>只需三步，轻松生成专业模特图</h1><p>保留商品细节，智能匹配模特与场景，快速获得可用成片</p><div class="special-flow"><figure><img :src="modelProductArt" alt="牛仔马甲商品原图" /><figcaption>商品素材</figcaption></figure><b>→</b><figure><img :src="modelEffectOneArt" alt="AI模特效果图1" /><figcaption>生成结果 1</figcaption></figure><figure><img :src="modelEffectTwoArt" alt="AI模特效果图2" /><figcaption>生成结果 2</figcaption></figure></div><div class="special-steps"><span>01 <b>上传商品素材</b></span><span>02 <b>选择模特与场景</b></span><span>03 <b>一键生成</b></span></div></section><section v-else class="studio-card results-card"><div class="card-heading compact"><div><span class="card-kicker">RESULT</span><h2>模特图结果</h2></div><span class="result-count">{{ generatedImages.length }} 张</span></div><div v-if="generating" class="chat-generating"><span class="loader"></span>正在生成真实结果…</div><div class="result-grid"><button v-for="(image,index) in generatedImages" :key="`${image.url.slice(-24)}-${index}`" type="button" :class="['result-thumb',{active:activeImageIndex===index}]" @click="activeImageIndex=index"><img :src="image.url" :alt="`模特图 ${index+1}`" /></button></div><div v-if="activeImage" class="result-actions"><button type="button" class="studio-button primary" :disabled="saving" @click="saveActiveImage">{{ saving ? '保存中…' : '保存图片' }}</button></div></section></main>
      </div>
    </template>

    <template v-else-if="mode === 'quantity'">
        <div class="special-workspace quantity-workspace" data-test="quantity-workspace">
        <aside class="special-sidebar">
          <section class="config-card"><h3 class="config-title"><i>1</i>上传商品素材图<em>* {{ materials.length }}/5张</em></h3><p class="config-sub">上传 1~5 张素材图，每张代表一种变体（如不同颜色），主体清晰效果更佳</p><div class="dropzone" :class="{ full: materials.length >= 5 }" role="button" tabindex="0" data-test="quantity-material-dropzone" @click="materialInput?.click()" @keydown.enter.prevent="materialInput?.click()" @dragover.prevent @drop.prevent="onMaterialDrop"><input ref="materialInput" class="visually-hidden" type="file" multiple accept=".jpg,.jpeg,.png,image/jpeg,image/png" @change="onMaterialFiles" /><span class="dz-plus">+</span><strong>拖拽或点击上传图片</strong><small>1-5 张，每张不超过 5M，仅支持 JPG/PNG 格式</small></div><ul v-if="materials.length" class="dz-list"><li v-for="(item,index) in materials" :key="`${item.name}-${index}`"><img :src="item.dataUrl" :alt="item.name" /><span>{{ item.name }}</span><button type="button" @click="removeMaterial(index)">×</button></li></ul><p v-if="uploadError" class="config-warn error">{{ uploadError }}</p></section>
          <section class="config-card"><h3 class="config-title"><i>2</i>变体数量<em>*</em></h3><p class="config-sub">为每张素材图设置画面中的数量；单张时即生成 N 个同款商品</p><p v-if="!materials.length" class="mode-output-summary">请先上传商品素材图</p><div v-else class="variant-counts"><label v-for="(item,index) in materials" :key="`quantity-${item.name}-${index}`" class="variant-row"><img :src="item.dataUrl" :alt="item.name" /><span>{{ item.name }}</span><input v-model.number="variantCounts[index]" type="number" min="1" max="99" :aria-label="`${item.name}数量`" @input="normalizeVariantCount(index)" /><em>件</em></label></div></section>
          <section class="config-card"><h3 class="config-title"><i>3</i>指定文案</h3><p class="config-sub">不填则画面中不渲染文字</p><input :value="quantityCopy" type="text" maxlength="20" placeholder="如：8pcs、8 PCS、8个装、8件套" data-test="quantity-copy-input" @input="updateQuantityCopy" /><div class="config-count">{{ quantityCopy.length }} / 20</div></section>
          <section class="config-card"><h3 class="config-title"><i>4</i>生成参数</h3><label class="inline-field">生图模型<select :value="usedModel || '未配置'" disabled><option>{{ usedModel || '未配置' }}</option></select></label><label class="inline-field">比例大小<select v-model="selectedRatio"><option v-for="ratio in ratioOptions" :key="ratio.key" :value="ratio.key">{{ ratio.label }}</option></select></label><label class="inline-field">字体<span class="font-select-control"><select v-model="selectedFont"><option v-for="font in fontOptions" :key="font.key" :value="font.key">{{ font.label }}</option></select><span class="font-info" :title="fontLicenseHint" :aria-label="fontLicenseHint">⚠</span></span></label><p class="config-note">输出图片会按所选比例进行构图</p><p v-if="generationError" class="config-warn error">{{ generationError }}</p></section>
        </aside>
        <footer class="special-generate-footer"><p>上传 1-5 张商品素材图并设置各变体数量，即可生成白底数量图</p><button type="button" class="generate-button" data-test="quantity-generate-button" :disabled="generating || !configured || !materials.length" @click="requestGeneration">{{ generating ? '生成中…' : '生成数量图' }} <span>→</span></button><p v-if="generationError" class="config-warn error">{{ generationError }}</p></footer>
        <main class="special-main"><section v-if="!generatedImages.length && !generating" class="special-hero"><span class="special-kicker">PRODUCT QUANTITY</span><h1>上传商品素材图，设置各变体数量，一键生成</h1><p>单张素材生成 N 个同款商品，多张素材支持混色混装组合，适合多件装上架展示</p><div class="special-flow"><figure><img :src="quantityProductArt" alt="商品素材图预览" /><figcaption>商品素材</figcaption></figure><b>× 5</b><figure><img :src="quantityResultArt" alt="商品数量图效果示例" /><figcaption>生成结果</figcaption></figure></div><div class="special-steps"><span>01 <b>上传商品图</b></span><span>02 <b>设置各变体数量</b></span><span>03 <b>AI生成图片</b></span></div></section><section v-else class="studio-card results-card"><div class="card-heading compact"><div><span class="card-kicker">RESULT</span><h2>数量图结果</h2></div><span class="result-count">{{ generatedImages.length }} 张</span></div><div v-if="generating" class="chat-generating"><span class="loader"></span>正在生成真实结果…</div><div class="result-grid"><button v-for="(image,index) in generatedImages" :key="`${image.url.slice(-24)}-${index}`" type="button" :class="['result-thumb',{active:activeImageIndex===index}]" @click="activeImageIndex=index"><img :src="image.url" :alt="`数量图 ${index+1}`" /></button></div><div v-if="activeImage" class="result-actions"><button type="button" class="studio-button primary" :disabled="saving" @click="saveActiveImage">{{ saving ? '保存中…' : '保存图片' }}</button></div></section></main>
      </div>
    </template>

    <template v-else-if="mode === 'history'">
      <section class="studio-history-page" data-test="studio-history">
        <div class="history-page-heading">
          <div><h1>生图记录</h1></div>
          <div class="history-page-actions"><span>共 {{ historySessionRecords.length }} 条记录</span><button type="button" class="history-refresh" @click="loadPersistedHistory(); historyPage = 1">↻ 刷新</button></div>
        </div>
        <div class="history-filter-tabs" role="tablist" aria-label="生图记录类型"><button v-for="item in historyTypes" :key="item.key" type="button" role="tab" :aria-selected="historyFilter === item.key" :class="{ active: historyFilter === item.key }" @click="historyFilter = item.key; historyPage = 1">{{ item.label }}</button></div>
        <p v-if="!filteredHistory.length" class="history-empty">当前没有生成记录。切回对应创作页发起一次生成即可。</p>
        <div v-else class="history-session-list">
          <article v-for="session in historySessions" :key="session.id" class="history-session-card">
            <div class="history-session-images"><button v-for="item in session.items.slice(0, 5)" :key="`${item.url.slice(-24)}-${item.createdAt || 0}`" type="button" class="history-session-thumb" @click="openHistorySession(session)"><img :src="item.url" :alt="`${KIND_LABEL[item.kind]}预览`" /><span>查看</span></button><div v-for="index in Math.max(0, 5 - Math.min(5, session.items.length))" :key="`empty-${session.id}-${index}`" class="history-session-placeholder"></div></div>
            <div class="history-session-body"><span class="history-status">已完成</span><strong>{{ session.title }}</strong><p><b>{{ modeLabel(session.mode) }}</b> · 生成 {{ session.items.length }} 张 · {{ formatHistoryDate(session.createdAt) }}</p><button type="button" class="history-session-open" @click="openHistorySession(session)">查看{{ session.items.length > 1 ? '全部套图' : '会话' }}</button></div>
          </article>
        </div>
        <nav v-if="historyPageCount > 1" class="history-pagination" aria-label="生图记录分页"><button type="button" :disabled="historyPage <= 1" @click="historyPage--">‹</button><span>{{ historyPage }}</span><button type="button" :disabled="historyPage >= historyPageCount" @click="historyPage++">›</button><span class="history-page-size">10 条 / 每页</span></nav>
      </section>
    </template>

    <template v-else>
    <!-- ① 输入 → ② 生成中 → ③ 完成（跟着真实状态走） -->
    <ol class="studio-steps" data-test="studio-steps">
      <li :class="{ active: step === 1, done: step > 1 }"><i>{{ step > 1 ? '✓' : '1' }}</i><span>输入</span></li>
      <li :class="{ active: step === 2, done: step > 2 }"><i>{{ step > 2 ? '✓' : '2' }}</i><span>生成中</span></li>
      <li :class="{ active: step === 3 }"><i>3</i><span>完成</span></li>
    </ol>

    <div class="studio-layout">
      <div class="studio-main">
        <!-- 左：配置面板（上传素材 / 商品信息 / 生成内容 / 立即生成） -->
        <aside class="studio-config" data-test="studio-config">
          <div class="config-scroll" data-test="config-scroll">
          <section class="config-card">
             <h3 class="config-title"><i>1</i>上传你的商品素材图<em>* {{ materials.length }}/{{ materialLimit }}张</em></h3>
            <p class="config-sub">上传（商品多角度）的图片，主体清晰效果更佳 <button type="button" class="example-link" data-test="material-examples-toggle" :aria-expanded="showMaterialExamples" @click="showMaterialExamples = !showMaterialExamples">示例</button></p>
            <div class="dropzone"
              :class="{ full: materials.length >= materialLimit }"
              data-test="material-dropzone"
              role="button"
              tabindex="0"
              @click="materialInput?.click()"
              @keydown.enter.prevent="materialInput?.click()"
              @dragover.prevent
              @drop.prevent="onMaterialDrop"
            >
              <input ref="materialInput" class="visually-hidden" type="file" multiple accept=".jpg,.jpeg,.png,image/jpeg,image/png" data-test="material-input" @change="onMaterialFiles" />
              <span class="dz-plus">+</span>
              <strong>拖拽或点击上传图片</strong>
              <small>1-{{ materialLimit }} 张，每张不超过 5M，仅支持 JPG/PNG 格式</small>
            </div>
             <div v-if="showMaterialExamples" class="material-examples" data-test="material-examples" aria-label="示例商品素材">
               <button v-for="example in materialExamples" :key="example.name" type="button" class="material-example" :disabled="materials.length >= materialLimit" @click="addExampleMaterial(example)">
                 <img :src="example.dataUrl" :alt="example.label" />
                 <span>点击添加</span>
               </button>
             </div>
            <p v-if="uploadError" class="config-warn">{{ uploadError }}</p>
             <ul v-if="materials.length" class="dz-list">
              <li v-for="(item, index) in materials" :key="`${item.name}-${index}`">
                <img :src="item.dataUrl" :alt="item.name" />
                <span>{{ item.name }}</span>
                <button type="button" :aria-label="`移除 ${item.name}`" @click="removeMaterial(index)"><img :src="deleteIcon" alt="" /></button>
               </li>
             </ul>
          </section>

          <section class="config-card">
            <h3 class="config-title">自定义商品信息<em>（选填）</em></h3>
             <p class="config-sub">可填写商品名称、核心卖点、材质规格、适用人群等、生成要求等，帮助 AI 更准确理解商品</p>
            <input v-model="productName" type="text" maxlength="80" placeholder="商品名称（选填）" data-test="product-name" />
            <textarea v-model="prompt" :maxlength="promptMaxLength" rows="4" data-test="image-prompt" :placeholder="modeConfig.placeholder"></textarea>
            <div class="config-count">{{ prompt.length }}/{{ promptMaxLength }}</div>
            <div class="analyze-row"><button type="button" class="studio-button ghost" data-test="image-prompt-analyze" :disabled="analyzing || !canAnalyze" :title="analyzeTitle" @click="requestAnalyzeProduct">{{ analyzing ? '分析中…' : '✦ AI 分析商品' }}</button><span v-if="analyzeNote" class="config-note" data-test="image-prompt-analyze-note">{{ analyzeNote }}</span></div>
            <p v-if="analyzeError" class="config-warn error" data-test="image-prompt-analyze-error">{{ analyzeError }}</p>
          </section>

          <section class="config-card">
             <h3 class="config-title"><i>2</i>选择生成内容<em>*</em></h3>
             <label class="content-row" data-test="content-main">
              <input type="checkbox" v-model="wantMain" />
              <span>主图</span>
              <button type="button" class="count-step" aria-label="减少主图数量" :disabled="!wantMain || mainCount <= 1" @click.stop="adjustContentCount('main', -1)">−</button>
               <input type="number" min="1" max="4" v-model.number="mainCount" :disabled="!wantMain" aria-label="主图张数" @change="normalizeContentCount('main')" />
              <button type="button" class="count-step" aria-label="增加主图数量" :disabled="!wantMain || mainCount >= 4" @click.stop="adjustContentCount('main', 1)">＋</button>
              <em>张</em>
            </label>
             <label class="content-row" data-test="content-selling">
              <input type="checkbox" v-model="wantSelling" />
              <span>卖点图</span>
              <button type="button" class="count-step" aria-label="减少卖点图数量" :disabled="!wantSelling || sellingCount <= 1" @click.stop="adjustContentCount('selling', -1)">−</button>
              <input type="number" min="1" max="4" v-model.number="sellingCount" :disabled="!wantSelling" aria-label="卖点图张数" @change="normalizeContentCount('selling')" />
              <button type="button" class="count-step" aria-label="增加卖点图数量" :disabled="!wantSelling || sellingCount >= 4" @click.stop="adjustContentCount('selling', 1)">＋</button>
              <em>张</em>
            </label>
             <label class="content-row" data-test="content-white">
              <input type="checkbox" v-model="wantWhite" />
              <span>白底图</span>
              <button type="button" class="count-step" aria-label="减少白底图数量" :disabled="!wantWhite || whiteCount <= 1" @click.stop="adjustContentCount('white', -1)">−</button>
              <input type="number" min="1" max="4" v-model.number="whiteCount" :disabled="!wantWhite" aria-label="白底图张数" @change="normalizeContentCount('white')" />
              <button type="button" class="count-step" aria-label="增加白底图数量" :disabled="!wantWhite || whiteCount >= 4" @click.stop="adjustContentCount('white', 1)">＋</button>
              <em>张</em>
            </label>
             <label class="content-row" data-test="content-detail">
              <input type="checkbox" v-model="wantDetail" />
              <span>细节图</span>
              <button type="button" class="count-step" aria-label="减少细节图数量" :disabled="!wantDetail || detailCount <= 1" @click.stop="adjustContentCount('detail', -1)">−</button>
              <input type="number" min="1" max="2" v-model.number="detailCount" :disabled="!wantDetail" aria-label="详情页张数" @change="normalizeContentCount('detailShort')" />
              <button type="button" class="count-step" aria-label="增加细节图数量" :disabled="!wantDetail || detailCount >= 2" @click.stop="adjustContentCount('detail', 1)">＋</button>
              <em>张</em>
            </label>
             <p class="content-total">当前生成总数量：<strong>{{ plannedOutputCount }}</strong> 张</p>
          </section>
          <section class="config-card">
            <h3 class="config-title"><i>3</i>生图设置</h3>
            <label class="inline-field">生图模型<select :value="usedModel || '未配置'" data-test="image-model" disabled :title="usedModel ? '模型来自设置中心，生成时使用此模型' : '请先在设置中心配置生图模型'"><option>{{ usedModel || '未配置' }}</option></select></label>
            <label class="inline-field">比例大小<select v-model="selectedRatio" data-test="image-ratio"><option v-for="ratio in ratioOptions" :key="ratio.key" :value="ratio.key">{{ ratio.label }}</option></select></label>
            <label class="inline-field">字体<span class="font-select-control"><select v-model="selectedFont" data-test="image-font"><option v-for="font in fontOptions" :key="font.key" :value="font.key">{{ font.label }}</option></select><span class="font-info" data-test="image-font-meta" :title="fontLicenseHint" :aria-label="fontLicenseHint">⚠</span></span></label>
           <p class="config-note">输出图片会按所选比例进行构图</p>
           </section>
          <section class="config-card generation-style-card" data-test="generation-style-card">
            <div class="config-title config-title-with-action"><span><i>4</i>生成风格</span><label class="unify-style-control" title="让本次生成的整套图片保持相同风格"><span>统一风格</span><input v-model="unifiedStyle" type="checkbox" aria-label="统一风格" /></label></div>
            <div class="style-button-group" role="group" aria-label="生成风格">
              <button v-for="style in generationStyleOptions" :key="style" type="button" :class="{ active: generationStyle === style }" @click="generationStyle = style">{{ style }}</button>
            </div>
          </section>
          <section class="config-card generation-platform-card" data-test="generation-platform-card">
            <h3 class="config-title"><i>5</i>平台选择</h3>
            <div class="platform-button-group" role="group" aria-label="平台选择">
              <button v-for="item in platformOptions" :key="item" type="button" :class="{ active: platform === item }" @click="platform = item">{{ item }}</button>
            </div>
          </section>
           </div>

          <div class="config-footer">
            <p class="estimate" data-test="generate-estimate">预计生成 {{ plannedOutputCount }} 张图片</p>
             <button type="button" class="generate-button" data-test="generate-button" :disabled="generating || needsPrompt || modeNeedsSource || modeNeedsReference || !plannedJobs.length || !configured" @click="requestGeneration"><span>{{ generating ? '生成中…' : !configured ? '请先配置生图模型' : generateButtonLabel }}</span><img :src="sendIcon" alt="" /></button>
            <p v-if="!generatedImages.length && generationError" class="config-warn error" data-test="config-error">{{ generationError }}</p>
          </div>
        </aside>

      </div>

      <!-- 右：输出区（未生成时是引导页；生成后显示真实结果） -->
      <aside class="studio-side">
        <section v-if="!generatedImages.length && !generating" class="studio-hero" data-test="studio-hero">
          <h2>只需一步，商品套图一键生成</h2>
          <div class="hero-flow" aria-label="商品套图生成示意"><figure><img :src="referenceArt" alt="商品示例" /><figcaption>商品示例</figcaption></figure><b>→</b><figure><img :src="replicaArt" alt="效果图一" /><figcaption>效果图 1</figcaption></figure><figure><img :src="resultArt" alt="效果图二" /><figcaption>效果图 2</figcaption></figure><figure><img :src="effectThreeArt" alt="效果图三" /><figcaption>效果图 3</figcaption></figure></div>
          <p>上传商品图片，选择要生成的产品内容，AI自动生成专业电商套图</p>
        </section>

        <section v-else class="studio-card results-card" data-test="studio-results">
          <div class="card-heading compact">
            <div><span class="card-kicker">RESULT</span><h2>生成结果</h2><p>点缩略图可切换右侧预览的这张。</p></div>
            <span v-if="generatedImages.length" class="result-count">{{ activeImageIndex + 1 }}/{{ generatedImages.length }}</span>
          </div>
          <div v-if="generating" class="chat-generating" data-test="generating"><span class="loader"></span><span>正在等待供应商返回真实图片，页面不会填充示例结果…</span></div>
          <div v-else-if="generationError" class="chat-error" data-test="generation-error">
            <p>{{ generationError }}</p>
            <button type="button" class="studio-button ghost" @click="requestGeneration"><img class="button-icon" :src="studioRetryIcon" alt="" />重试</button>
          </div>
          <div v-for="group in generatedGroups" :key="group.kind" class="result-group">
            <div class="result-group-head"><strong>{{ group.label }}</strong><small>{{ group.note }}</small></div>
            <div class="result-grid" :class="{ single: group.items.length === 1 }">
              <button v-for="item in group.items" :key="`${item.image.url.slice(-24)}-${item.index}`" type="button" :class="['result-thumb', { active: activeImageIndex === item.index }]" @click="activeImageIndex = item.index"><img :src="item.image.url" :alt="`${group.label} ${item.index + 1}`" /></button>
            </div>
          </div>
          <div v-if="activeImage" class="result-meta"><span>{{ activeKindLabel }}</span><span>模型：{{ activeImage.model }}</span><span>耗时：{{ activeImage.elapsedMs }}ms</span></div>
          <p v-if="generationNotice" class="chat-notice">{{ generationNotice }}</p>
        </section>

         <section v-if="activeImage || generating || generationError" class="studio-card preview-card" data-test="studio-preview">
           <div class="card-heading compact">
             <div><span class="card-kicker">PREVIEW</span><h2>生成预览</h2><p>选择结果后可保存到本机。</p></div>
           </div>
           <div v-if="activeImage" class="single-image-preview"><img :src="activeImage.url" :alt="activeKindLabel" /></div>
           <div v-else-if="generating" class="empty-image-preview"><span class="loader"></span>生成中…</div>
           <div v-else class="empty-image-preview">{{ generationError }}</div>
           <div v-if="activeImage" class="result-meta"><span>{{ activeKindLabel }}</span><span>模型：{{ activeImage.model }}</span><span>耗时：{{ activeImage.elapsedMs }}ms</span></div>
          <div v-if="activeImage" class="result-actions">
            <button type="button" class="studio-button primary" data-test="image-save" :disabled="saving" @click="saveActiveImage"><img class="button-icon" :src="saveIcon" alt="" />{{ saving ? '保存中…' : '保存图片' }}</button>
            <button v-if="savedPath" type="button" class="studio-button ghost" data-test="image-reveal" @click="revealSavedImage"><img class="button-icon" :src="openIcon" alt="" />打开所在文件夹</button>
          </div>
          <p v-if="saveNotice" class="save-notice" :class="{ error: saveNoticeError }">{{ saveNotice }}</p>
           <p v-if="activeImage && generatedImages.length > 1" class="preview-hint">点击上方缩略图可切换预览。</p>
        </section>
      </aside>
    </div>

    </template>

    <div v-if="sceneConfirmOpen" class="confirm-backdrop" role="presentation" @click.self="sceneConfirmOpen = false">
      <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="scene-confirm-title">
        <div class="confirm-icon"><img :src="recommendIcon" alt="" /></div><h2 id="scene-confirm-title">确认生成场景参考图？</h2><p>请求会发送到已保存的图片接口并可能产生第三方费用，生成结果只在接口返回成功后显示。</p><dl><div><dt>模型</dt><dd>{{ usedModel || '配置中的模型' }}</dd></div><div><dt>功能</dt><dd>AI生成场景</dd></div><div><dt>场景描述</dt><dd>{{ modelScene.trim() || '自然、干净、适合商品展示的生活方式场景' }}</dd></div><div v-if="materials.length"><dt>商品素材</dt><dd>{{ materials.map(item => item.name).join('、') }}</dd></div><div v-if="sceneReference"><dt>场景参考图</dt><dd>{{ sceneReference.name }}</dd></div></dl>
        <div class="confirm-actions"><button type="button" class="studio-button ghost" @click="sceneConfirmOpen = false"><img class="button-icon" :src="studioCloseIcon" alt="" />取消</button><button type="button" class="studio-button primary" :disabled="sceneGenerating" @click="submitSceneGeneration"><img class="button-icon" :src="studioConfirmIcon" alt="" />确认发送</button></div>
      </section>
    </div>

    <div v-if="confirmOpen" class="confirm-backdrop" role="presentation" @click.self="confirmOpen = false">
      <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div class="confirm-icon"><img :src="recommendIcon" alt="" /></div><h2 id="confirm-title">确认开始生成？</h2><p>请求会发送到已保存的图片接口，生成结果只在接口返回成功后显示<span v-if="materials.length || referenceMaterial || competitorReferences.length">；已选择的原图和参考图会一并用于图片生成</span>。</p><dl><div><dt>模型</dt><dd>{{ usedModel || '配置中的模型' }}</dd></div><div><dt>创作页签</dt><dd>{{ modeConfig.label }}</dd></div><div><dt>生成内容</dt><dd>{{ planSummary }}</dd></div><div><dt>输出比例</dt><dd>{{ selectedRatio }}</dd></div><div><dt>字体</dt><dd>{{ effectiveFontOption.label }} · {{ effectiveFontOption.license }}</dd></div><div v-if="materials.length"><dt>商品素材</dt><dd>{{ materials.map(item => item.name).join('、') }}</dd></div><div v-if="mode === 'quantity' && materials.length"><dt>变体数量</dt><dd>{{ materials.map((item, index) => `${item.name} × ${Math.min(99, Math.max(1, Math.round(Number(variantCounts[index]) || 1)))} 件`).join('、') }}</dd></div><div v-if="mode === 'quantity'"><dt>指定文案</dt><dd>{{ quantityCopy.trim() || '不强制渲染文字' }}</dd></div><div v-if="competitorReferences.length"><dt>竞品参考图</dt><dd>{{ competitorReferences.length }} 张</dd></div><div v-if="referenceMaterial"><dt>编辑参考图</dt><dd>{{ referenceMaterial.name }}</dd></div></dl>
        <div class="confirm-actions"><button type="button" class="studio-button ghost" @click="confirmOpen = false"><img class="button-icon" :src="studioCloseIcon" alt="" />取消</button><button type="button" class="studio-button primary" :disabled="generating" @click="submitGeneration"><img class="button-icon" :src="studioConfirmIcon" alt="" />确认发送</button></div>
      </section>
    </div>
    <div v-if="analyzeConfirmOpen" class="confirm-backdrop" role="presentation" @click.self="analyzeConfirmOpen = false">
      <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="analyze-confirm-title">
        <div class="confirm-icon"><img :src="recommendIcon" alt="" /></div><h2 id="analyze-confirm-title">覆盖当前图片描述？</h2><p>AI 整理出的描述会替换输入框里已有的内容，原文字不会保留；请求只发送商品名称、描述和最多 {{ ANALYSIS_MAX_IMAGES }} 张素材图。</p>
        <div class="confirm-actions"><button type="button" class="studio-button ghost" data-test="image-prompt-analyze-cancel" @click="analyzeConfirmOpen = false"><img class="button-icon" :src="studioCloseIcon" alt="" />取消</button><button type="button" class="studio-button primary" data-test="image-prompt-analyze-confirm" @click="runAnalyzeProduct"><img class="button-icon" :src="studioConfirmIcon" alt="" />覆盖描述</button></div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import sendIcon from '../../assets/generated/ui-icons/send-studio-gen.png'
import recommendIcon from '../../assets/generated/ui-icons/recommend.png'
import deleteIcon from '../../assets/generated/ui-icons/delete.png'
import studioRetryIcon from '../../assets/generated/ui-icons/studio-retry-gen.png'
import studioCloseIcon from '../../assets/generated/ui-icons/studio-close-gen.png'
import studioConfirmIcon from '../../assets/generated/ui-icons/studio-confirm-send-gen.png'
import saveIcon from '../../assets/generated/ui-icons/settings-save-gen.png'
import openIcon from '../../assets/generated/ui-icons/open-gen.png'
// 生图文本 API 的组参 / 结果清洗 / 错误话术（纯模块，见 image-text-analysis.ts）
import { ANALYSIS_MAX_IMAGES } from './image-text-analysis'
import referenceArt from '../../assets/ui/image-studio/reference-site/product.jpg'
import replicaArt from '../../assets/ui/image-studio/reference-site/effect-1.jpg'
import resultArt from '../../assets/ui/image-studio/reference-site/effect-2.jpg'
import effectThreeArt from '../../assets/ui/image-studio/reference-site/effect-3.jpg'
import quantityProductArt from '../../assets/ui/image-studio/reference-site/quantity-product.jpg'
import quantityResultArt from '../../assets/ui/image-studio/reference-site/quantity-result.jpg'
import modelProductArt from '../../assets/ui/image-studio/reference-site/model-product.jpg'
import modelEffectOneArt from '../../assets/ui/image-studio/reference-site/model-effect-1.jpg'
import modelEffectTwoArt from '../../assets/ui/image-studio/reference-site/model-effect-2.jpg'
import { useImageStudioGeneration, KIND_LABEL, HISTORY_MAX_ITEMS, type GeneratedImage } from './use-image-studio-generation'
import { useImageStudioHistory } from './use-image-studio-history'

const emit = defineEmits<{ (event: 'go-home'): void; (event: 'busy-change', busy: boolean): void }>()
// ---------- 生成域 / 历史域（状态机与生命周期见 use-image-studio-*.ts）----------
// 模板与 submitGeneration 等提交入口留在组件里，仅做接线；域逻辑全部在两个 composable。
const gen = useImageStudioGeneration({ emit })
const {
  creativeModes,
  modeLabel,
  prompt,
  productName,
  wantMain,
  wantSelling,
  wantWhite,
  wantDetail,
  mainCount,
  sellingCount,
  whiteCount,
  detailCount,
  generationStyleOptions,
  platformOptions,
  generationStyle,
  unifiedStyle,
  platform,
  mode,
  modeConfig,
  materialLimit,
  promptMaxLength,
  detailNoteStyle,
  detailCardCount,
  detailRatio,
  detailPreviewAspectRatio,
  fontOptions,
  detailFont,
  detailCasePlaying,
  detailCasePhase,
  detailCaseLabels,
  detailPreviewArt,
  editCasePlaying,
  editCaseProgress,
  materials,
  showMaterialExamples,
  materialExamples,
  materialInput,
  referenceInput,
  competitorInput,
  modelLibraryInput,
  sceneLibraryInput,
  sceneReferenceInput,
  referenceMaterial,
  competitorReferences,
  referenceUploadError,
  variantCounts,
  quantityCopy,
  modelGender,
  modelAge,
  modelEthnicity,
  modelBody,
  modelAppearance,
  modelLibraryUploads,
  modelLibraryUploadError,
  modelScene,
  sceneLibraryUploads,
  sceneLibraryUploadError,
  sceneReference,
  sceneGenerating,
  sceneGenerationError,
  modelSource,
  modelCount,
  sceneSource,
  modelSourceOptions,
  sceneSourceOptions,
  modelLibraryOptions,
  sceneLibraryOptions,
  editPreset,
  editCaseArt,
  editPresetOptions,
  resetEditSession,
  selectedRatio,
  ratioOptions,
  freeEditRatioOptions,
  selectedFont,
  uploadError,
  modeNeedsSource,
  modeNeedsReference,
  selectedModelLibraryAsset,
  selectedSceneLibraryAsset,
  libraryAssetRequirement,
  modeNeedsLibraryAsset,
  selectedSystemModelAsset,
  selectedSystemSceneAsset,
  needsPrompt,
  generateButtonLabel,
  generationError,
  generationNotice,
  generating,
  confirmOpen,
  sceneConfirmOpen,
  generatedImages,
  activeImageIndex,
  historyImages,
  savedPath,
  saveNotice,
  saveNoticeError,
  configured,
  usedModel,
  detailFontOption,
  effectiveFontOption,
  fontLicenseHint,
  restartDetailCase,
  analyzing,
  analyzeError,
  analyzeNote,
  analyzeConfirmOpen,
  canAnalyze,
  analyzeTitle,
  requestAnalyzeProduct,
  runAnalyzeProduct,
  adjustContentCount,
  normalizeContentCount,
  activeImage,
  activeKindLabel,
  plannedJobs,
  planSummary,
  plannedOutputCount,
  generatedGroups,
  addExampleMaterial,
  onMaterialFiles,
  onMaterialDrop,
  removeMaterial,
  normalizeVariantCount,
  updateQuantityCopy,
  onModelLibraryFiles,
  onSceneLibraryFiles,
  onReferenceFile,
  onSceneReferenceFile,
  onCompetitorFiles,
  onCompetitorDrop,
  removeCompetitorReference,
  requestGeneration,
  buildPrompt,
  toImageSource,
  toImageSourceAsync,
  requestSceneGeneration,
  submitSceneGeneration,
} = gen
const history = useImageStudioHistory(gen)
const {
  historyFilter,
  historyPage,
  historyTypes,
  filteredHistory,
  historySessionRecords,
  editSessionRecords,
  activeEditSessionId,
  historySessions,
  historyPageCount,
  saving,
  loadPersistedHistory,
  schedulePersistHistory,
  formatHistoryDate,
  openHistorySession,
  applyEditPreset,
  saveActiveImage,
  revealSavedImage,
} = history
/** 步骤条：① 输入 → ② 生成中 → ③ 完成（跟着真实状态走，不假装） */
const step = computed(() => generating.value ? 2 : generatedImages.value.length ? 3 : 1)
// P1-6（2026-10-15 审查）：deep watch 落库改为防抖调度——见 persistHistory/schedulePersistHistory 注释

function optimizeEditPrompt() {
  const base = prompt.value.trim().replace(/[。；]+$/u, '')
  if (!base) return
  const additions: string[] = []
  if (!/(保持|保留)/u.test(base)) additions.push('保持商品主体、比例和材质一致')
  if (!/(不要|避免|禁止)/u.test(base)) additions.push('不要添加水印、品牌标识或多余文字')
  prompt.value = `${base}${additions.length ? `。${additions.join('，')}` : ''}。`.slice(0, 2000)
}

/**
 * 「AI 分析商品」：把商品名/描述 + 最多 3 张素材图交给设置中心的「生图文本 API」，
 * 用它整理出的图片描述替换输入框内容。这是主进程 `ai:imageText:analyze` 的渲染层入口，
 * 之前配置项一直是空转（渲染层零调用）。
 * 已有描述非空时先走**页内**确认（window.confirm 会阻塞渲染进程、卡 CDP），不自动覆盖用户手写的内容。
 */
async function submitGeneration() {
  if (generating.value) return
  // 固定本次请求的创作模式。即使外部脚本或未来新增入口在请求期间改变了
  // 页面状态，返回结果也必须归属于发起请求的页签，不能串到当前页签。
  const requestMode = mode.value
  const requestProductName = productName.value.trim()
  const requestEditPrompt = prompt.value.trim()
  generating.value = true; confirmOpen.value = false; generationError.value = ''
  generationNotice.value = ''
  if (modeNeedsLibraryAsset.value) { generating.value = false; generationError.value = libraryAssetRequirement.value; return }
  savedPath.value = ''; saveNotice.value = ''; saveNoticeError.value = false
  const sourceAssets = requestMode === 'edit'
    ? (referenceMaterial.value ? [referenceMaterial.value] : [])
    : requestMode === 'replicate'
      ? [...competitorReferences.value, ...materials.value]
      : requestMode === 'model'
        ? [...materials.value, ...(selectedSystemModelAsset.value ? [selectedSystemModelAsset.value] : []), ...(selectedModelLibraryAsset.value ? [selectedModelLibraryAsset.value] : []), ...(selectedSystemSceneAsset.value ? [selectedSystemSceneAsset.value] : []), ...(selectedSceneLibraryAsset.value ? [selectedSceneLibraryAsset.value] : []), ...(sceneReference.value ? [sceneReference.value] : [])]
        : materials.value
  // 在任何 FileReader/fetch 异步操作前固定计划与提示词；输入控件仍可被键盘或
  // 自动化事件触发时，本次请求也必须和确认时的页签参数一致。
  const jobs = plannedJobs.value.map(job => ({ ...job, prompt: buildPrompt(job.kind, requestMode) }))
  let sourceImages: Array<{ name: string; mimeType: string; b64Json: string }> = []
  try {
    const directSources = sourceAssets.map(toImageSource)
    sourceImages = (await Promise.all(sourceAssets.map((asset, index) => directSources[index] || toImageSourceAsync(asset))))
      .filter((item): item is { name: string; mimeType: string; b64Json: string } => Boolean(item))
  } catch {
    // 素材转换是生成请求的一部分；即使未来新增的转换器抛出异常，也要释放 busy
    // 状态并让用户看到可操作的错误，而不是把工作台永久锁在“生成中”。
    generating.value = false
    generationError.value = '部分素材读取失败，请重新上传后再试。'
    return
  }
  if (sourceImages.length !== sourceAssets.length) {
    generating.value = false
    generationError.value = '部分素材读取失败，请重新上传后再试。'
    return
  }
  const collected: GeneratedImage[] = []
  const sessionId = `image-session-${Date.now()}`
  const createdAt = Date.now()
  const title = requestMode === 'edit' ? requestEditPrompt.slice(0, 40) || '自由编辑' : requestProductName || modeLabel(requestMode)
  const failures: string[] = []
  const shortfalls: string[] = []
  try {
    // 依次请求（不并发）：主图与详情页各自成图，并发容易被供应商限流，也会让费用与结果对不上号。
    // 有些兼容接口会忽略 n 参数，只返回 1 张。对这种真实返回按缺口补发独立请求，
    // 让“卡片数量”兑现为页面实际拿到的图片数，而不是只显示一个短缺提示。
    for (const job of jobs) {
      let remaining = job.count
      let returned = 0
      while (remaining > 0) {
        try {
          const requestCount = Math.min(4, remaining)
          const result = await window.shopilot.ai.generateImage({ prompt: job.prompt, size: job.size, n: requestCount, confirmed: true, sourceImages })
          if (!result.ok) throw new Error(result.error.message)
          const images = Array.isArray(result.data?.images)
            ? result.data.images.map((item: any) => item?.b64Json ? `data:${item?.mimeType || 'image/png'};base64,${item?.b64Json}` : String(item?.url || '')).filter(Boolean).slice(0, remaining)
            : []
          if (!images.length) throw new Error('接口没有返回可预览图片')
          const model = String(result.data?.model || usedModel.value || '—')
          const elapsedMs = Number(result.data?.elapsedMs || 0)
          const batch = images.map((url: string) => ({ kind: job.kind, url, model, elapsedMs, mode: requestMode, sessionId, createdAt, title, ...(requestMode === 'edit' ? { prompt: requestEditPrompt } : {}) }))
          collected.push(...batch)
          // 每个真实返回批次立即落入历史；组件卸载或窗口异常关闭时也能找回已完成图片。
          if (batch.length) {
            historyImages.value = [...batch, ...historyImages.value].slice(0, HISTORY_MAX_ITEMS)
            schedulePersistHistory()
          }
          returned += images.length
          remaining -= images.length
        } catch (error: any) {
          failures.push(`${job.label}：${error?.message || '生成失败'}`)
          break
        }
      }
      if (returned < job.count) {
        shortfalls.push(`${job.label} 已得到 ${returned} 张（目标 ${job.count} 张）`)
      }
    }
    generatedImages.value = collected
    activeImageIndex.value = 0
    const notes = [...shortfalls, ...(failures.length && collected.length ? failures.map(item => `失败 ${item}`) : [])]
    if (notes.length) generationNotice.value = notes.join('；')
    // 全失败才作为错误展示；部分失败保留已拿到的图，并把失败原因如实写出来
    if (!collected.length) generationError.value = failures.join('；') || '图片生成失败，接口没有返回结果。'
  } finally { generating.value = false }
}

/**
 * 把当前结果存到本地。结果只活在渲染层内存里的话，用户其实拿不到图。
 * 走主进程的另存为对话框落盘，并把**真实写入路径**回显出来（不假装成功）。
 */
</script>

<style scoped>
/* AI 生图工作区是浅色工作台（外层导航仍是深色壳）。左配置面板 + 右输出区。 */
.image-studio-page{display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;overflow:hidden;padding:0 28px 12px;color:#16275e;background:#f5f7fb}
.studio-page-head{position:relative;top:auto;z-index:10;display:flex;align-items:center;justify-content:space-between;gap:16px;height:58px;min-height:58px;flex:0 0 58px;margin:0 -28px 14px;padding:0 28px;border-bottom:1px solid #edf0f5;background:rgba(255,255,255,.96);backdrop-filter:blur(10px)}
.studio-brand{display:flex;align-items:center;gap:7px;flex:0 0 auto;color:#1e2a41;font-size:16px}.studio-brand-mark{display:grid;place-items:center;width:31px;height:31px;border:0;border-radius:8px;background:#4c6fff;color:#fff;font-size:20px;cursor:pointer;box-shadow:0 4px 10px rgba(76,111,255,.22)}
.studio-top-nav{display:flex;align-items:center;gap:4px;flex:1;justify-content:flex-start;height:100%;margin-left:28px;overflow-x:auto;scrollbar-width:none}.studio-top-nav::-webkit-scrollbar{display:none}.studio-top-nav button{height:34px;padding:0 12px;border:0;border-radius:9px;background:transparent;color:#525d72;font-size:12px;cursor:pointer;white-space:nowrap}.studio-top-nav button:hover{background:#f1f4ff;color:#394bd0}.studio-top-nav button.active{background:#edf0ff;color:#4d5be0;font-weight:600}
.button-icon{width:16px;height:16px;object-fit:contain;vertical-align:-3px;margin-right:4px}
.studio-button{display:inline-flex;align-items:center;gap:5px;border:1px solid rgba(103,143,207,.2);background:rgba(255,255,255,.68);color:#38528d;cursor:pointer;border-radius:9px}
.studio-button{min-height:34px;padding:0 13px}
.studio-button:hover,.studio-button:focus-visible{border-color:rgba(151,120,255,.75);color:#16275e;outline:2px solid rgba(151,120,255,.26);outline-offset:1px}
.studio-button.primary{border-color:#5b3df5;background:#6d4aff;color:#fff}
.studio-button.ghost{background:rgba(255,255,255,.68)}
.studio-button:disabled{cursor:not-allowed;opacity:.55}
/* ① 输入 → ② 生成中 → ③ 完成 */
.studio-steps{display:flex;align-items:center;justify-content:center;gap:0;margin:0 0 16px;padding:0;list-style:none}
.studio-steps li{display:flex;align-items:center;gap:7px;color:#98a2b3;font-size:12px}
.studio-steps li+li::before{content:'';width:clamp(60px,16vw,220px);height:1px;margin:0 12px;background:#dbe3ef}
.studio-steps i{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:#e6ebf3;color:#7a8bad;font-size:11px;font-style:normal;font-weight:600}
.studio-steps li.active{color:#3d4bd6;font-weight:600}
.studio-steps li.active i{background:#5b3df5;color:#fff}
.studio-steps li.done i{background:#25b47a;color:#fff}
.studio-layout{display:grid;grid-template-columns:minmax(300px,340px) minmax(0,1fr);gap:16px;align-items:stretch;flex:1;min-height:0}
.studio-main{min-width:0;min-height:0}
.studio-side{min-width:0;min-height:0;height:100%;display:flex;flex-direction:column;gap:14px;overflow-y:auto;scrollbar-width:thin}
/* 左：配置面板。三块卡片在面板内滚动，"立即生成"是固定的 flex 项（不是 sticky，
   sticky-bottom 会浮在内容上把第三块卡片压住——实测踩过） */
.studio-config{display:flex;height:100%;min-height:0;flex-direction:column;gap:10px}
.config-scroll{display:flex;flex-direction:column;gap:12px;flex:1 1 auto;min-height:0;overflow-y:auto;padding:2px 8px 2px 2px;scrollbar-width:thin}
.config-card{padding:14px;border:1px solid rgba(103,143,207,.2);border-radius:14px;background:rgba(255,255,255,.85);box-shadow:0 12px 30px rgba(91,125,180,.1)}
.config-title{display:flex;align-items:center;gap:7px;margin:0 0 6px;color:#16275e;font-size:13px;font-weight:600}
.config-title i{display:grid;place-items:center;width:18px;height:18px;border-radius:50%;background:#e8ecff;color:#5b3df5;font-size:10px;font-style:normal}
.config-title em{margin-left:auto;color:#98a2b3;font-size:10px;font-style:normal;font-weight:400}
.config-sub{margin:0 0 10px;color:#7a8bad;font-size:10px;line-height:1.6}
.dropzone{display:flex;flex-direction:column;align-items:center;gap:5px;padding:18px 12px;border:1px dashed rgba(113,147,205,.55);border-radius:12px;background:rgba(246,250,255,.8);color:#5b6f9c;cursor:pointer;text-align:center}
.dropzone:hover,.dropzone:focus-visible{border-color:#6d4aff;background:rgba(238,242,255,.9);outline:none}
.dropzone.full{cursor:not-allowed;opacity:.6}
.dz-plus{font-size:20px;line-height:1;color:#6d4aff}
.dropzone strong{color:#33477d;font-size:11px}
.dropzone small{color:#98a2b3;font-size:9px;line-height:1.5}
.example-link{display:inline;margin-left:3px;padding:0;border:0;background:transparent;color:#4f69dc;font:inherit;font-size:10px;cursor:pointer;text-align:left}.example-link:hover{text-decoration:underline}
.material-examples{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin:8px 0 2px}.material-example{position:relative;display:flex;flex-direction:column;gap:4px;padding:4px;border:1px solid rgba(103,143,207,.22);border-radius:8px;background:#fff;color:#536bd8;font-size:9px;cursor:pointer}.material-example:hover:not(:disabled){border-color:#6d4aff;box-shadow:0 0 0 2px rgba(109,74,255,.12)}.material-example:disabled{cursor:not-allowed;opacity:.5}.material-example img{display:block;width:100%;height:70px;object-fit:cover;border-radius:5px}.material-example span{line-height:1.2}
.dz-list{display:flex;flex-direction:column;gap:6px;margin:10px 0 0;padding:0;list-style:none}
.dz-list li{display:flex;align-items:center;gap:8px;padding:5px 7px;border-radius:9px;background:rgba(238,243,255,.78)}
.dz-list img{width:32px;height:32px;object-fit:cover;border-radius:7px}
.dz-list span{min-width:0;flex:1;overflow:hidden;color:#4a5b85;font-size:10px;text-overflow:ellipsis;white-space:nowrap}
.dz-list button{display:inline-flex;padding:0;border:0;background:transparent;cursor:pointer}
.dz-list button img{width:14px;height:14px}
.config-warn{margin:9px 0 0;color:#b54708;font-size:10px;line-height:1.5}
.config-warn.error{color:#c13f61}
.config-note{margin:8px 0 0;color:#98a2b3;font-size:9px}
.config-card>input,.config-card>textarea{display:block;width:100%;margin-bottom:8px;padding:0 10px;border:1px solid rgba(103,143,207,.28);border-radius:9px;background:rgba(255,255,255,.92);color:#22386e;font:inherit;font-size:12px;outline:0}
.config-card>input{height:34px}
.config-card>textarea{min-height:86px;max-height:200px;padding:9px 10px;resize:vertical;line-height:1.6}
.config-card>input::placeholder,.config-card>textarea::placeholder{color:#8795b2}
.config-card>input:focus,.config-card>textarea:focus{border-color:#7188f7;box-shadow:0 0 0 3px rgba(113,136,247,.14)}
.config-count{margin:-4px 0 8px;color:#98a2b3;font-size:9px;text-align:right}
.config-grid{display:grid;gap:8px}
.config-grid input{height:32px;padding:0 10px;border:1px solid rgba(103,143,207,.24);border-radius:9px;background:rgba(255,255,255,.92);color:#22386e;font-size:11px;outline:0}
.config-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:10px}
/* 生成内容勾选行 */
.content-row{display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:8px 10px;border:1px solid rgba(103,143,207,.22);border-radius:10px;background:rgba(247,251,255,.85);color:#4a5b85;font-size:12px}
.content-row input[type=checkbox]{width:15px;height:15px;accent-color:#6d4aff}
.content-row span{flex:1;color:#2b3a5c}
.content-row input[type=number]{width:56px;height:28px;padding:0 8px;border:1px solid rgba(103,143,207,.28);border-radius:7px;background:#fff;color:#22386e;font-size:11px;text-align:center}
.content-row .count-step{display:grid;place-items:center;width:22px;height:22px;padding:0;border:1px solid rgba(103,143,207,.25);border-radius:6px;background:#fff;color:#526bdc;font-size:15px;line-height:1;cursor:pointer}.content-row .count-step:disabled{cursor:not-allowed;opacity:.42}
.content-row em{color:#7a8bad;font-size:10px;font-style:normal}
.content-total{margin:4px 0 0;color:#7a8bad;font-size:10px;text-align:right}.content-total strong{color:#4d5be0;font-size:13px}
.inline-field{display:flex;align-items:center;gap:8px;margin-top:4px;color:#61749f;font-size:10px}
.inline-field select{height:28px;padding:0 8px;border:1px solid rgba(103,143,207,.28);border-radius:7px;background:#fff;color:#22386e;font-size:11px}
.font-select-control{display:flex;align-items:center;gap:5px;min-width:0}.font-select-control select{min-width:0;flex:1}.inline-field .font-select-control{width:min(72%,220px);margin-left:auto}.edit-parameter-row .font-select-control,.detail-font-control{width:100%}.font-info{flex:none;cursor:help;color:#a17a22;font-size:11px}
.variant-counts,.reference-upload{margin-top:10px;padding:9px;border:1px solid rgba(103,143,207,.2);border-radius:10px;background:rgba(247,250,255,.8)}
.variant-counts-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:7px}.variant-counts-head strong{color:#31508d;font-size:10px}.variant-counts-head small{color:#98a2b3;font-size:9px}
.variant-row{display:flex;align-items:center;gap:6px;margin-top:5px;color:#5b6f9c;font-size:10px}.variant-row img{width:25px;height:25px;border-radius:5px;object-fit:cover}.variant-row span{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.variant-row input{width:48px;height:26px;border:1px solid rgba(103,143,207,.28);border-radius:6px;text-align:center;color:#22386e}.variant-row em{font-style:normal;color:#98a2b3}
.quantity-copy,.model-profile{margin-top:10px;padding:9px;border:1px solid rgba(103,143,207,.2);border-radius:10px;background:rgba(247,250,255,.8)}.quantity-copy label,.model-scene-label{display:flex;align-items:baseline;gap:6px;color:#31508d;font-size:10px}.quantity-copy label small{color:#98a2b3;font-size:9px;font-weight:400}.quantity-copy input,.model-profile>input{display:block;width:100%;height:29px;margin-top:7px;padding:0 8px;border:1px solid rgba(103,143,207,.28);border-radius:7px;background:#fff;color:#22386e;font-size:10px}.quantity-copy>div{margin-top:3px;color:#98a2b3;font-size:9px;text-align:right}.profile-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:7px}.profile-grid label{display:flex;align-items:center;justify-content:space-between;gap:5px;color:#5b6f9c;font-size:9px}.profile-grid select,.model-scene-label select{min-width:0;height:27px;padding:0 5px;border:1px solid rgba(103,143,207,.28);border-radius:6px;background:#fff;color:#22386e;font-size:9px}.model-source-tabs{display:flex;gap:4px;margin:7px 0}.model-source-tabs button,.preset-chips button{padding:4px 7px;border:1px solid rgba(103,143,207,.22);border-radius:6px;background:#fff;color:#657aa4;font-size:9px;cursor:pointer}.model-source-tabs button.active,.preset-chips button.active{border-color:#6d4aff;background:#eeeaff;color:#5738d8;font-weight:600}.profile-note{margin:0;color:#98a2b3;font-size:9px}.model-scene-label{justify-content:space-between;margin-top:7px;color:#5b6f9c;font-size:9px}.model-scene-label select{flex:1;margin-left:8px}.edit-presets{margin-bottom:8px;color:#61749f;font-size:10px}.preset-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}
.reference-dropzone{display:flex;align-items:center;justify-content:center;min-height:68px;border:1px dashed rgba(113,147,205,.5);border-radius:8px;background:#fff;color:#71809a;font-size:10px;cursor:pointer}.reference-dropzone img{display:block;width:100%;height:90px;object-fit:contain;border-radius:7px}.reference-remove{margin-top:6px;border:0;background:transparent;color:#c13f61;font-size:10px;cursor:pointer}
.detail-local-note{color:#8a94a7;font-size:9px}
.config-footer{flex:none;display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid rgba(103,143,207,.22);border-radius:14px;background:linear-gradient(180deg,rgba(255,255,255,.96),rgba(243,247,255,.98));box-shadow:0 -6px 18px rgba(91,125,180,.14)}
.estimate{margin:0;color:#7a8bad;font-size:10px;line-height:1.5;text-align:center}
.generate-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:40px;border:1px solid #5b3df5;border-radius:11px;background:#6d4aff;color:#fff;font-size:13px;font-weight:600;cursor:pointer}
.generate-button img{width:16px;height:16px;object-fit:contain}
.generate-button:disabled{cursor:not-allowed;opacity:.55}
/* 右：输出区 */
.studio-hero{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:0;padding:28px;border:1px solid rgba(103,143,207,.18);border-radius:18px;background:rgba(255,255,255,.82);box-shadow:0 15px 38px rgba(91,125,180,.12);text-align:center}
.studio-hero h2{margin:0;color:#1f2a44;font-size:26px;letter-spacing:-.02em}
.studio-hero p{margin:0;color:#7a8bad;font-size:12px}
.hero-art{width:min(220px,50%);height:auto;object-fit:contain;opacity:.95}.hero-flow{display:flex;align-items:center;gap:11px;margin:16px 0}.hero-flow figure{width:108px;margin:0}.hero-flow figure img{display:block;width:108px;height:108px;object-fit:cover;border-radius:10px;background:#f2f4f8}.hero-flow figcaption{margin-top:5px;color:#73809a;font-size:9px}.hero-flow>b{color:#8e99ad;font-size:18px;font-weight:400}
.hero-steps{display:flex;flex-direction:column;gap:5px;margin:6px 0 0;padding:0;color:#5b6f9c;font-size:11px;line-height:1.6;list-style:none}
.studio-card{border:1px solid rgba(103,143,207,.2);border-radius:14px;background:rgba(255,255,255,.82);box-shadow:0 15px 38px rgba(91,125,180,.13);padding:18px}
.card-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}
.card-kicker{color:#7f72d0;font-size:10px;letter-spacing:.08em}
.card-heading h2{margin:4px 0 5px;font-size:18px}
.card-heading p{margin:0;color:#6f7fa7;font-size:11px}
.result-count{padding:3px 8px;border-radius:999px;background:rgba(232,241,255,.9);color:#4b5bd6;font-size:10px}
/* 结果分组 */
.result-group{margin-top:8px}
.result-group-head{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}
.result-group-head strong{color:#16275e;font-size:11px}
.result-group-head small{color:#7a8bad;font-size:9px}
.result-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}
.result-grid.single{grid-template-columns:minmax(0,260px)}
.result-thumb{padding:0;border:1px solid rgba(113,147,205,.25);border-radius:10px;background:#fff;cursor:pointer;overflow:hidden;aspect-ratio:1/1}
.result-thumb img{display:block;width:100%;height:100%;object-fit:cover}
.result-thumb.active{border-color:#6b75ff;box-shadow:0 0 0 2px rgba(105,120,244,.2)}
.result-meta{display:flex;flex-wrap:wrap;gap:12px;margin-top:8px;color:#667085;font-size:10px}
.chat-generating{display:flex;align-items:center;gap:8px;padding:9px 10px;border:1px dashed rgba(113,136,247,.4);border-radius:9px;background:rgba(238,243,255,.7);color:#5b6f9c;font-size:11px}
.chat-error{padding:9px 10px;border:1px solid rgba(241,104,126,.3);border-radius:9px;background:rgba(255,237,243,.7)}
.chat-error p{margin:0 0 8px;color:#c13f61;font-size:11px;line-height:1.5}
.chat-notice{margin:8px 0 0;color:#b54708;font-size:10px}
.result-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.result-actions .studio-button{flex:1 1 auto;justify-content:center}
.save-notice{margin:8px 0 0;color:#1d7a55;font-size:10px;line-height:1.5;overflow-wrap:anywhere}
.save-notice.error{color:#c13f61}
.preview-hint{margin:8px 0 0;color:#7a8bad;font-size:10px;line-height:1.5}
/* 创作历史 */
.studio-history-page{min-height:calc(100vh - 124px);padding:22px 28px 42px;background:#f5f7fb}.history-page-heading{display:flex;align-items:center;justify-content:space-between;margin:4px 0 20px}.history-page-heading h1{margin:0;color:#1d2944;font-size:20px}.history-page-actions{display:flex;align-items:center;gap:10px;color:#7d8798;font-size:11px}.history-session-list{display:flex;flex-direction:column;gap:14px;max-width:780px;margin:16px auto}.history-session-card{display:flex;gap:14px;padding:13px 15px;border:1px solid #e7eaf0;background:#fff;box-shadow:0 2px 8px rgba(30,53,91,.04)}.history-session-images{display:grid;grid-template-columns:repeat(5,74px);gap:7px;flex:none}.history-session-thumb,.history-session-placeholder{position:relative;width:74px;height:74px;padding:0;border:0;border-radius:8px;overflow:hidden;background:repeating-linear-gradient(135deg,#f1f4f8 0,#f1f4f8 7px,#f8fafc 7px,#f8fafc 14px);cursor:pointer}.history-session-thumb img{display:block;width:100%;height:100%;object-fit:cover}.history-session-thumb span{position:absolute;inset:auto 0 0;padding:3px 0;background:rgba(18,30,53,.58);color:#fff;text-align:center;font-size:9px}.history-session-body{display:flex;align-items:flex-start;flex:1;min-width:0;flex-direction:column;gap:6px}.history-status{align-self:flex-end;padding:3px 7px;border:1px solid #b9e4ca;border-radius:4px;color:#18884b;background:#f2fbf5;font-size:9px}.history-session-body strong{color:#25324b;font-size:13px}.history-session-body p{margin:0;color:#7c8799;font-size:10px}.history-session-body p b{color:#6245de;font-weight:600}.history-session-open{align-self:flex-end;margin-top:auto;padding:6px 12px;border:1px solid #dce2ec;border-radius:7px;background:#fff;color:#5e6d85;font-size:10px;cursor:pointer}.history-session-open:hover{border-color:#8169ed;color:#5b3fd8}.history-pagination{display:flex;align-items:center;justify-content:center;gap:10px;margin:20px 0 0;color:#68768c;font-size:11px}.history-pagination button{width:27px;height:27px;border:1px solid #dfe4ed;border-radius:6px;background:#fff;color:#69768b;cursor:pointer}.history-pagination button:disabled{opacity:.4;cursor:not-allowed}.history-page-size{margin-left:10px;color:#8b95a6}.history-card{min-height:400px}
.history-empty{margin:6px 0 0;padding:20px;border:1px dashed rgba(113,136,247,.35);border-radius:12px;background:rgba(244,248,255,.7);color:#7a8bad;font-size:11px;text-align:center}
.history-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.history-item{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid rgba(113,147,205,.22);border-radius:12px;background:#fff;cursor:pointer;text-align:left}
.history-item img{display:block;width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:8px}
.history-item.active{border-color:#6d4aff;box-shadow:0 0 0 2px rgba(109,74,255,.16)}
.history-meta{color:#5b6472;font-size:10px}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.loader{width:14px;height:14px;border:2px solid #e3e8f1;border-top-color:#6d4aff;border-radius:50%;animation:studio-spin .8s linear infinite}
@keyframes studio-spin{to{transform:rotate(360deg)}}
.confirm-backdrop{position:fixed;inset:0;z-index:300;display:grid;place-items:center;padding:20px;background:rgba(16,24,40,.42)}
.confirm-dialog{width:min(520px,100%);padding:20px;border:1px solid rgba(118,101,229,.42);border-radius:16px;background:#fff;color:#16275e;box-shadow:0 24px 60px rgba(16,24,40,.28)}
.confirm-icon img{width:34px;height:34px;object-fit:contain}
.confirm-dialog h2{margin:6px 0 8px;font-size:17px}
.confirm-dialog p{margin:0 0 12px;color:#65769b;font-size:12px;line-height:1.6}
.confirm-dialog dl{display:flex;flex-direction:column;gap:6px;margin:0 0 14px;padding:10px 12px;border-radius:10px;background:#f1f5ff}
.confirm-dialog dl>div{display:flex;gap:10px;font-size:11px}
.confirm-dialog dt{flex:0 0 64px;color:#7181a4}
.confirm-dialog dd{margin:0;color:#2c427e;overflow-wrap:anywhere}
.confirm-actions{display:flex;justify-content:flex-end;gap:8px}
/* 图文详情：与设计稿一致的左侧步骤栏 + 中央笔记画布；所有字段仍绑定真实上传与生图状态。 */
.detail-mode{position:relative;min-height:calc(100vh - 150px);padding-bottom:0;background:#f5f7fb}
.detail-composer{display:grid;grid-template-columns:325px minmax(500px,1fr);min-height:calc(100vh - 150px);margin:-20px -24px -24px;position:relative}
.detail-sidebar{display:flex;flex-direction:column;gap:10px;padding:4px 12px 92px;background:#f1f2f7;border-right:1px solid #e1e4ec;overflow:auto}
.detail-panel-card{padding:12px 13px;border:1px solid #e0e2e8;border-radius:12px;background:#fff;box-shadow:0 2px 8px rgba(36,49,78,.04)}
.detail-panel-card h3{display:flex;align-items:center;gap:7px;margin:0 0 10px;color:#1d2538;font-size:12px;font-weight:700}.detail-panel-card h3 i{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:#4169e1;color:#fff;font-size:11px;font-style:normal}.detail-panel-card h3 em{margin-left:auto;color:#ec4f6d;font-size:10px;font-style:normal;font-weight:500}.detail-panel-card h3 em small{color:#9aa4b5;font-size:10px}
 .detail-upload{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:5px;min-height:84px;border:1px dashed #c8d1e2;border-radius:8px;background:#fbfcff;color:#71809a;cursor:pointer;text-align:center}.detail-upload:hover{border-color:#5573ef;background:#f7f9ff}.detail-upload-icon{display:block;width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.detail-upload strong{color:#71809a;font-size:11px;font-weight:500}.detail-upload small{color:#9aa4b5;font-size:9px}.detail-material-list{display:flex;flex-direction:column;gap:5px;margin:8px 0 0;padding:0;list-style:none}.detail-material-list li{display:flex;align-items:center;gap:7px;padding:4px 6px;border-radius:7px;background:#f3f6fc;color:#53627c;font-size:10px}.detail-material-list img{width:27px;height:27px;border-radius:5px;object-fit:cover}.detail-material-list span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.detail-material-list button{color:#8994a8;font-size:17px;line-height:1}.detail-error{margin:6px 0 0;color:#c43e5f;font-size:10px}
.detail-input,.detail-textarea,.detail-select{width:100%;border:1px solid #d7dce7;border-radius:7px;background:#fff;color:#33415f;outline:none;font:inherit;font-size:11px}.detail-input{height:30px;padding:0 9px}.detail-textarea{min-height:68px;padding:8px 9px;resize:none;line-height:1.55}.detail-input:focus,.detail-textarea:focus,.detail-select:focus{border-color:#6480ed;box-shadow:0 0 0 2px rgba(100,128,237,.12)}.detail-field-label{display:flex;align-items:center;gap:5px;margin:11px 0 6px;color:#26334f;font-size:11px;font-weight:600}.detail-field-label small{color:#a1a9b8;font-size:9px;font-weight:400}.detail-counter{text-align:right;color:#98a2b3;font-size:9px}.detail-options-card{padding-bottom:15px}.detail-select{height:30px;padding:0 8px;color:#34415f}.detail-segmented{display:flex;gap:1px;height:31px;padding:2px;border-radius:7px;background:#f0f2f6}.detail-segmented button{flex:1;border-radius:5px;color:#68748b;font-size:11px}.detail-segmented button.active{background:#fff;color:#314a9a;box-shadow:0 1px 3px rgba(32,45,80,.1);font-weight:600}.detail-segmented input{width:46px;border:1px solid #d7dce7;border-radius:5px;background:#fff;color:#34415f;text-align:center;font-size:11px}
.detail-canvas{position:relative;display:flex;align-items:center;justify-content:center;min-width:0;padding:25px 50px 80px;background:#f6f8fc}.detail-canvas-head{position:absolute;top:18px;left:0;right:0;text-align:center}.detail-canvas-head h1{margin:0;color:#18233c;font-size:22px;letter-spacing:-.02em}.detail-canvas-head p{margin:4px 0 0;color:#73809a;font-size:11px}.detail-preview-wrap{width:min(430px,100%);margin-top:23px}.detail-preview-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:11px;color:#18233c;font-size:12px}.detail-preview-title span{color:#9ca6b7;font-size:10px}.detail-note-card{overflow:hidden;border:1px solid #d6dcd9;border-radius:9px;background:#fff;box-shadow:0 8px 20px rgba(51,71,92,.08)}.detail-note-card header{display:flex;align-items:center;gap:6px;height:44px;padding:0 12px;color:#2e3440;font-size:10px}.detail-avatar{display:grid;place-items:center;width:23px;height:23px;border-radius:50%;background:#f0f2f5;color:#6d7b8e;font-size:10px}.detail-note-card header b{font-size:10px}.detail-note-card header em{color:#f14b68;font-size:9px;font-style:normal}.detail-share{margin-left:auto;color:#a2aab5;font-size:15px}.detail-note-image{position:relative;aspect-ratio:1.05/1;background:#f4f0e6;overflow:hidden}.detail-note-image>img{display:block;width:100%;height:100%;object-fit:cover}.detail-image-empty{display:flex;align-items:center;justify-content:center;flex-direction:column;width:100%;height:100%;gap:5px;color:#9aa4b5;font-size:12px}.detail-image-empty small{font-size:9px}.detail-page-count{position:absolute;right:9px;top:9px;padding:3px 6px;border-radius:5px;background:rgba(255,255,255,.85);color:#71809a;font-size:9px}.detail-note-body{padding:10px 12px 8px}.detail-note-body h2{margin:0 0 6px;color:#1f2937;font-family:serif;font-size:14px;font-weight:600}.detail-note-body p{margin:0;color:#637085;font-size:10px;line-height:1.7}.detail-note-tags{margin-top:7px;color:#7083a8;font-size:9px}.detail-note-body footer{display:flex;justify-content:flex-end;gap:12px;margin-top:8px;color:#8b95a3;font-size:17px}.detail-note-body footer span:first-child{color:#ff526d}.detail-preview-status{margin:8px 0 0;color:#62a48e;font-size:10px}.detail-composer-footer{position:absolute;left:0;bottom:0;width:325px;padding:10px 12px 12px;border-top:1px solid #dde2eb;background:rgba(255,255,255,.96);text-align:center}.detail-composer-footer p{margin:1px 0;color:#8995aa;font-size:10px}.detail-composer-footer p b{color:#526bdc;font-weight:600}.detail-generate-button{display:flex;align-items:center;justify-content:center;gap:7px;width:100%;height:39px;margin-top:7px;border-radius:20px;background:#e7ebf2;color:#9aa5b6;font-size:12px;font-weight:600;cursor:pointer}.detail-generate-button:not(:disabled){background:#5d6fe5;color:#fff;box-shadow:0 5px 14px rgba(93,111,229,.24)}.detail-generate-button:disabled{cursor:not-allowed}.detail-generate-button span{font-size:16px}
.single-image-preview{display:grid;place-items:center;min-height:220px;overflow:hidden;border:1px solid rgba(103,143,207,.18);border-radius:12px;background:#f7f9fd}.single-image-preview img{display:block;max-width:100%;max-height:360px;object-fit:contain}.empty-image-preview{display:flex;align-items:center;justify-content:center;gap:8px;min-height:180px;border:1px dashed rgba(113,136,247,.35);border-radius:12px;background:#f7f9fd;color:#7a8bad;font-size:11px}
.history-refresh{min-height:30px;padding:0 11px;border:1px solid rgba(103,143,207,.22);border-radius:8px;background:#fff;color:#53689a;font-size:11px;cursor:pointer}.history-refresh:hover{border-color:#6d4aff;color:#5238d7}.history-filter-tabs{display:flex;gap:5px;flex-wrap:wrap;margin:-2px 0 12px;padding-bottom:10px;border-bottom:1px solid #edf0f5}.history-filter-tabs button{min-height:28px;padding:0 10px;border:1px solid transparent;border-radius:7px;color:#71809a;font-size:10px;cursor:pointer}.history-filter-tabs button.active{border-color:#d8d6ff;background:#eeebff;color:#5738d8;font-weight:600}
.edit-workspace{display:grid;grid-template-columns:220px minmax(0,1fr);min-height:calc(100vh - 170px);margin:-4px 0 0;border:1px solid rgba(103,143,207,.2);border-radius:14px;overflow:hidden;background:#fff}.edit-session-sidebar{padding:14px 12px;background:#f6f7fb;border-right:1px solid #e7eaf0}.edit-new-session{display:flex;align-items:center;justify-content:center;gap:7px;width:100%;height:34px;border-radius:8px;background:#6547e8;color:#fff;font-size:12px;cursor:pointer}.edit-new-session span{font-size:18px;line-height:1}.edit-history-title{display:flex;align-items:center;justify-content:space-between;margin:24px 5px 0;color:#5e6d88;font-size:11px}.edit-history-title em{display:grid;place-items:center;min-width:20px;height:20px;border-radius:10px;background:#e8eaf2;color:#8994a8;font-style:normal;font-size:10px}.edit-history-session{display:flex;flex-direction:column;gap:3px;width:100%;margin-top:8px;padding:8px;border:1px solid transparent;border-radius:7px;background:transparent;color:#5e6d88;text-align:left;cursor:pointer}.edit-history-session:hover,.edit-history-session.active{border-color:#d8d0ff;background:#f0edff;color:#5b3dd5}.edit-history-session strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}.edit-history-session small{color:#929caf;font-size:9px}.edit-history-empty{margin:12px 5px;color:#9aa4b5;font-size:10px}.edit-main{min-width:0;padding:16px 22px 22px;background:#fbfcfe}.edit-main-head{display:flex;align-items:center;gap:12px;padding:2px 2px 14px;color:#1d2944}.edit-main-head strong{font-size:14px}.edit-main-head span{color:#8792a5;font-size:11px}.edit-cases{max-width:800px;margin:0 auto}.edit-case-stage{display:flex;align-items:center;gap:18px;min-height:210px;padding:18px;border:1px solid #e5e8ef;border-radius:13px;background:#fff}.edit-case-image{position:relative;width:230px;aspect-ratio:4/3;overflow:hidden;border-radius:9px;background:#eef1f6}.edit-case-image img{display:block;width:100%;height:100%;object-fit:cover}.edit-case-image span{position:absolute;left:10px;bottom:9px;padding:3px 7px;border-radius:5px;background:rgba(20,28,48,.65);color:#fff;font-size:9px}.edit-case-copy h2{margin:0;color:#202c45;font-size:17px}.edit-case-copy p{margin:7px 0 14px;color:#8290a6;font-size:11px}.edit-use-prompt{padding:0;border:0;background:transparent;color:#6245de;font-size:11px;cursor:pointer}.edit-case-tabs{display:flex;gap:6px;overflow-x:auto;margin:10px 0 16px}.edit-case-tabs button{min-height:30px;padding:0 11px;border:1px solid #e1e5ed;border-radius:7px;background:#fff;color:#65738b;font-size:10px;white-space:nowrap;cursor:pointer}.edit-case-tabs button.active{border-color:#c7bcff;background:#f0edff;color:#5b3dd5;font-weight:600}.edit-composer{max-width:800px;margin:0 auto;padding:14px;border:1px solid #e1e5ed;border-radius:13px;background:#fff}.edit-composer>textarea{display:block;width:100%;min-height:100px;padding:11px;border:1px solid #d8deea;border-radius:9px;resize:vertical;outline:none;color:#2a3856;font:inherit;font-size:12px;line-height:1.6}.edit-composer>textarea:focus{border-color:#6d4aff;box-shadow:0 0 0 3px rgba(109,74,255,.1)}.edit-composer-toolbar{display:flex;align-items:center;gap:11px;margin:9px 0;color:#7b89a0;font-size:10px}.edit-upload-button,.edit-optimize-button{display:inline-flex;align-items:center;gap:4px;padding:0;border:0;background:transparent;color:#5f6f8b;font-size:10px;cursor:pointer}.edit-upload-button:hover,.edit-optimize-button:hover:not(:disabled){color:#5f3bdd}.edit-optimize-button:disabled{opacity:.45;cursor:not-allowed}.edit-prompt-count{margin-left:auto;color:#9ca6b6;font-size:10px}.edit-parameter-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding-top:10px;border-top:1px solid #edf0f5}.edit-parameter-row label{display:flex;flex-direction:column;gap:5px;color:#71809a;font-size:10px}.edit-parameter-row select{height:30px;padding:0 7px;border:1px solid #d8deea;border-radius:7px;background:#fff;color:#33415f;font-size:10px}.edit-send-button{display:flex;align-items:center;justify-content:center;gap:7px;width:100%;height:37px;margin-top:12px;border:0;border-radius:9px;background:#6645e9;color:#fff;font-size:12px;font-weight:600;cursor:pointer}.edit-send-button:disabled{opacity:.45;cursor:not-allowed}.edit-generation-error{margin:8px 0 0;color:#c13f61;font-size:10px}.edit-result{display:flex;align-items:center;gap:14px;max-width:800px;margin:14px auto 0;padding:12px;border:1px solid #e1e5ed;border-radius:12px;background:#fff}.edit-result img{width:100px;height:100px;border-radius:8px;object-fit:cover}.edit-result>div{display:flex;flex-direction:column;gap:10px;color:#33415f;font-size:11px}
.replicate-workspace{display:grid;grid-template-columns:325px minmax(0,1fr);gap:16px;min-height:calc(100vh - 170px)}.replicate-sidebar{display:flex;flex-direction:column;gap:10px;min-width:0}.replicate-step-card{margin:0}.replicate-step-card .config-sub b{color:#536bd8;font-weight:600}.replicate-step-card .generate-button{width:100%;margin-top:10px}.replicate-main{min-width:0}.replicate-hero{display:flex;align-items:center;flex-direction:column;justify-content:center;min-height:540px;padding:30px;border:1px solid rgba(103,143,207,.18);border-radius:18px;background:radial-gradient(circle at 52% 49%,#fff 0 38%,#fafaff 38.5% 58%,#fff 59%);text-align:center;box-shadow:0 15px 38px rgba(91,125,180,.1)}.special-kicker{color:#7f72d0;font-size:10px;letter-spacing:.15em}.replicate-hero h1{margin:8px 0 6px;color:#1f2a44;font-size:25px}.replicate-hero>p{margin:0;color:#7a8bad;font-size:12px}.replicate-flow{display:flex;align-items:center;gap:15px;margin:26px 0} .replicate-flow figure{width:150px;margin:0}.replicate-flow figure img{display:block;width:150px;height:150px;object-fit:cover;border-radius:13px;background:#f2f4f8}.replicate-flow figcaption{margin-top:7px;color:#73809a;font-size:10px}.replicate-flow>b{color:#8e99ad;font-size:23px;font-weight:400}.special-steps{display:flex;gap:35px;color:#a0a8b8;font-size:10px}.special-steps span{display:flex;flex-direction:column;gap:3px}.special-steps b{color:#64738e;font-weight:500}.scene-library-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-top:8px}.scene-library-list button{display:flex;flex-direction:column;gap:5px;padding:5px;border:1px solid rgba(103,143,207,.22);border-radius:8px;background:#fff;color:#64738e;font-size:9px;text-align:left;cursor:pointer}.scene-library-list button.active{border-color:#6d4aff;background:#f0edff;color:#5738d8}.scene-card-art{display:block;width:100%;height:42px;border-radius:6px;background:linear-gradient(135deg,#d8e9ff,#f4cfb4)}.scene-card-art.tone-outdoor{background:linear-gradient(135deg,#b5e7cf,#c9e9ff)}.scene-card-art.tone-studio{background:linear-gradient(135deg,#eeeef3,#d1d6e7)}
.library-upload-block{display:flex;flex-direction:column;gap:8px;margin-top:8px}.library-upload-button{display:flex;align-items:center;justify-content:center;gap:5px;min-height:37px;border:1px dashed #bfcbe0;border-radius:8px;background:#fbfcff;color:#5c46d8;font-size:10px;cursor:pointer}.library-upload-button:hover{border-color:#6d4aff;background:#f7f5ff}.library-upload-button span{font-size:17px;line-height:1}.uploaded-library-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.uploaded-library-grid button{display:flex;flex-direction:column;gap:4px;min-width:0;padding:4px;border:1px solid rgba(103,143,207,.22);border-radius:7px;background:#fff;color:#64738e;text-align:left;cursor:pointer}.uploaded-library-grid button.active{border-color:#6d4aff;background:#f0edff;color:#5738d8}.uploaded-library-grid img{display:block;width:100%;height:54px;border-radius:5px;object-fit:cover;background:#eef1f6}.uploaded-library-grid small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:8px}.library-empty{padding:18px 8px;border:1px dashed #cfd7e8;border-radius:8px;color:#8a95a8;font-size:10px;text-align:center}.special-workspace{display:grid;grid-template-columns:325px minmax(0,1fr);gap:16px;min-height:calc(100vh - 170px)}.special-sidebar{display:flex;flex-direction:column;gap:10px;min-width:0}.special-main{min-width:0}.special-hero{display:flex;align-items:center;flex-direction:column;justify-content:center;min-height:540px;padding:30px;border:1px solid rgba(103,143,207,.18);border-radius:18px;background:radial-gradient(circle at 52% 49%,#fff 0 38%,#fafaff 38.5% 58%,#fff 59%);text-align:center;box-shadow:0 15px 38px rgba(91,125,180,.1)}.special-hero h1{max-width:720px;margin:8px 0 6px;color:#1f2a44;font-size:25px}.special-hero>p{margin:0;color:#7a8bad;font-size:12px}.special-flow{display:flex;align-items:center;gap:15px;margin:26px 0}.special-flow figure{width:180px;margin:0}.special-flow figure img{display:block;width:180px;height:180px;object-fit:cover;border-radius:13px;background:#f2f4f8}.special-flow figcaption{margin-top:7px;color:#73809a;font-size:10px}.special-flow>b{color:#8e99ad;font-size:23px;font-weight:400}
.model-library-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-top:8px}.model-library-grid button{display:flex;flex-direction:column;gap:4px;padding:4px;border:1px solid rgba(103,143,207,.22);border-radius:7px;background:#fff;color:#64738e;text-align:left;cursor:pointer}.model-library-grid button.active{border-color:#6d4aff;background:#f0edff;color:#5738d8}.model-card-art{display:block;width:100%;height:34px;border-radius:5px;background:linear-gradient(135deg,#e5c7b4,#c4d8ef)}.model-card-art.tone-model-2{background:linear-gradient(135deg,#c6e4d0,#f2d2b6)}.model-card-art.tone-model-3{background:linear-gradient(135deg,#ded6f5,#f4c8d2)}.model-card-art.tone-model-4{background:linear-gradient(135deg,#d0e4f6,#efdfb7)}.model-card-art.tone-model-5{background:linear-gradient(135deg,#efc3c3,#d5e7ef)}.model-card-art.tone-model-6{background:linear-gradient(135deg,#e2d0b7,#c9d1ed)}.model-card-art.tone-model-7{background:linear-gradient(135deg,#c7e9dd,#edd1e9)}.model-card-art.tone-model-8{background:linear-gradient(135deg,#d6d9ec,#f1dbbb)}.model-library-grid small{font-size:8px}.library-empty{padding:18px 8px;border:1px dashed #cfd7e8;border-radius:8px;color:#8a95a8;font-size:10px;text-align:center}.scene-smart{display:flex!important;justify-content:center;grid-column:1/-1;gap:3px;padding:9px!important;background:linear-gradient(135deg,#f3efff,#fff)!important;color:#6545d8!important;text-align:center!important}.scene-smart strong{font-size:10px}.scene-smart small{color:#8b7ac9;font-size:8px}
@media(max-width:1180px){.studio-layout,.replicate-workspace,.special-workspace{grid-template-columns:minmax(0,1fr)}.studio-side{order:-1}.replicate-hero,.special-hero{min-height:420px}}
@container (max-width:600px){.image-studio-page .studio-page-head{gap:6px}.image-studio-page .studio-top-nav{justify-content:flex-start;overflow-x:auto;scrollbar-width:none}.image-studio-page .studio-top-nav::-webkit-scrollbar{display:none}.image-studio-page .studio-steps li+li::before{width:40px}.image-studio-page .edit-workspace{grid-template-columns:1fr}.image-studio-page .edit-session-sidebar{display:none}.image-studio-page .edit-case-stage{flex-direction:column;align-items:stretch}.image-studio-page .edit-case-image{width:100%}.image-studio-page .edit-parameter-row{grid-template-columns:1fr}.image-studio-page .replicate-flow,.image-studio-page .special-flow,.image-studio-page .hero-flow{gap:6px}}
</style>
<style scoped>
.detail-case-controls{position:absolute;top:18px;right:18px;z-index:3;display:flex;justify-content:flex-end;gap:8px;margin:0}
.detail-case-controls button{display:grid;place-items:center;width:32px;height:32px;padding:0;border:1px solid #e4e7ec;border-radius:8px;background:#fff;color:#667085;font-size:15px;cursor:pointer;box-shadow:0 1px 3px rgba(16,24,40,.04)}
.detail-case-controls button:hover{border-color:#c7ceff;color:#4d5be0;background:#fbfbff}
.edit-case-toggle{padding:0;border:0;background:transparent;color:#71809a;font-size:10px;cursor:pointer}
.edit-case-toggle:hover{color:#4d5be0}
.edit-case-compare{isolation:isolate}
.edit-case-base{position:absolute!important;inset:0}
.edit-case-after{position:absolute;top:0;bottom:0;left:0;overflow:hidden;border-right:2px solid #fff;z-index:1}
.edit-case-after img{width:230px;max-width:none}
.edit-case-label{position:absolute;top:8px;padding:3px 6px;border-radius:4px;background:rgba(20,28,48,.58);color:#fff;font-size:8px;z-index:2}
.edit-case-label.original{left:8px}.edit-case-label.result{right:8px}
.edit-case-slider{position:absolute;inset:auto 8px 8px;width:calc(100% - 16px);z-index:3;accent-color:#6d4aff}
.edit-case-toggle{display:block;margin:8px auto 0}
.detail-preview-wrap{width:min(350px,100%)}
.detail-note-body footer{align-items:center;justify-content:flex-start}
.detail-note-body footer .detail-comment-placeholder{margin-right:auto;color:#9aa4b2;font-size:10px}
.detail-note-body footer span:not(.detail-comment-placeholder):first-of-type{color:#ff526d}
.detail-mode{min-height:0}
.detail-composer{flex:1 1 0;min-height:0;grid-template-columns:325px minmax(0,1fr);margin:-20px -24px -12px}
.detail-sidebar{min-height:0;overscroll-behavior:contain}
.detail-canvas{position:relative;min-height:0;overflow-y:auto;flex-direction:column;justify-content:flex-start;gap:8px;padding:16px 28px 14px}
.detail-canvas-head{position:static;flex:0 0 auto;width:100%;text-align:center}
.detail-preview-wrap{flex:0 0 auto;width:min(350px,100%);margin:0 auto}
.detail-preview-title{margin-bottom:8px}
.detail-case-controls{margin:0 0 7px}
.detail-mode .detail-case-controls{top:18px;right:18px;margin:0}
.detail-preview-status{margin-top:7px}
.detail-generated-result{width:min(620px,100%);margin:8px auto 0;padding:10px 12px;border:1px solid #dfe4ee;border-radius:10px;background:#fff;box-shadow:0 3px 12px rgba(36,49,78,.05)}
.detail-generated-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;color:#26334f;font-size:11px}.detail-generated-heading span{color:#7d89a0;font-size:10px}
.detail-generated-thumbs{display:flex;gap:6px;overflow-x:auto;padding-bottom:5px}.detail-generated-thumbs .result-thumb{flex:0 0 58px;width:58px;height:58px;border-radius:7px}.detail-generated-thumbs .result-thumb img{width:100%;height:100%;object-fit:cover}
.detail-generated-preview{display:grid;grid-template-columns:minmax(0,1fr) 112px;gap:10px;align-items:center;margin-top:8px}.detail-generated-preview>img{display:block;width:100%;max-height:260px;object-fit:contain;border:1px solid #edf0f5;border-radius:8px;background:#f7f9fd}.detail-generated-preview>div{display:flex;flex-direction:column;gap:7px;color:#71809a;font-size:9px}.detail-generated-preview .studio-button{width:100%;justify-content:center}
.detail-composer-footer{z-index:2}
.edit-workspace{flex:1 1 0;min-height:0;grid-template-columns:minmax(220px,24%) minmax(0,1fr);margin:-14px -28px -12px;border:0;border-radius:0}
.edit-session-sidebar{overflow-y:auto;padding:14px 12px;background:#fbfcff}
.edit-main{display:flex;flex-direction:column;min-height:0;overflow:hidden;padding:0;background:#f5f6fa}
.edit-main-head{flex:0 0 58px;min-height:58px;padding:0 20px;border-bottom:1px solid #e6e9ef;background:#fff}
.edit-cases{position:relative;display:flex;flex:1 1 0;flex-direction:column;align-items:center;justify-content:center;min-height:0;max-width:none;margin:0;padding:14px 20px 8px;overflow:auto}
.edit-case-stage{position:relative;display:flex;flex:0 0 auto;align-items:center;flex-direction:column;justify-content:center;gap:0;width:min(620px,100%);min-height:0;padding:0;border:0;background:transparent}
.edit-case-copy{display:flex;align-items:center;justify-content:space-between;gap:12px;width:min(406px,100%);margin-bottom:10px}
.edit-case-copy h2{font-size:15px}
.edit-case-copy p{display:none}
.edit-case-image{width:min(406px,85vw);aspect-ratio:3/2}
.edit-case-compare{--edit-case-width:min(406px,85vw)}
.edit-case-after img{width:var(--edit-case-width);height:100%;max-width:none}
.edit-case-toggle{position:absolute;right:max(calc((100% - min(406px,85vw))/2 + 12px),12px);bottom:12px;z-index:4;display:grid;place-items:center;width:44px;height:44px;margin:0;padding:0;border:0;border-radius:50%;background:#fff;color:#313b4d;font-size:16px;box-shadow:0 2px 8px rgba(22,34,57,.16)}
.edit-case-tabs{flex:0 0 auto;justify-content:center;max-width:100%;margin:12px 0 0;padding:0 0 4px}
.edit-case-tabs button{min-width:78px;height:52px;min-height:52px;padding:0 10px;border-radius:8px;font-size:10px}
.edit-composer{position:relative;flex:0 0 auto;width:calc(100% - 40px);max-width:none;margin:0 20px 14px;padding:12px 14px;border-color:#e0e4ec;border-radius:12px;box-shadow:0 4px 15px rgba(28,45,78,.04)}
.edit-composer>textarea{min-height:54px;padding:8px 10px;resize:none}
.edit-composer-toolbar{min-height:25px;margin:7px 0}
.edit-parameter-row{grid-template-columns:repeat(3,minmax(0,1fr));width:calc(100% - 54px);gap:7px;padding-top:8px}
.edit-parameter-row label{gap:4px}
.edit-parameter-row select{height:30px}
.edit-send-button{position:absolute;right:14px;bottom:12px;width:36px;height:36px;margin:0;border-radius:50%;font-size:17px}
@media(max-height:760px){.detail-canvas{gap:6px;padding-top:10px;padding-bottom:10px}.detail-preview-wrap{width:min(326px,100%)}.edit-composer{margin-bottom:8px;padding:9px 12px}.edit-composer>textarea{min-height:42px}.edit-case-tabs{margin-top:8px}.edit-case-image{width:min(360px,70vw)}.edit-case-compare{--edit-case-width:min(360px,70vw)}}
.studio-hero{gap:8px}
.studio-hero h2{font-size:24px}
.studio-hero>p{margin-top:8px;color:#8a95a7;font-size:11px}
.hero-flow{display:flex;align-items:center;justify-content:center;gap:0;width:min(620px,100%);margin:24px 0 8px}
.hero-flow figure{flex:0 0 auto;width:190px;margin:0}
.hero-flow figure:first-of-type{width:160px;margin-right:22px}
.hero-flow figure img{width:190px;height:174px;border-radius:12px;box-shadow:0 8px 24px rgba(34,48,78,.12)}
.hero-flow figure:first-of-type img{width:160px;height:160px;box-shadow:none}
.hero-flow figure:nth-of-type(3){margin-left:-112px;z-index:2}
.hero-flow figure:nth-of-type(4){margin-left:-112px;z-index:1}
.hero-flow figcaption{display:none}
.hero-flow>b{position:relative;z-index:4;flex:0 0 32px;margin:0 10px 0 0}
.detail-preview-wrap{width:min(350px,100%)}
.detail-note-body footer{align-items:center;justify-content:flex-start}
.detail-note-body footer .detail-comment-placeholder{margin-right:auto;color:#9aa4b2;font-size:10px}
.detail-note-body footer span:not(.detail-comment-placeholder):first-of-type{color:#ff526d}
.studio-hero{gap:8px}
.studio-hero h2{font-size:24px}
.studio-hero>p{margin-top:8px;color:#8a95a7;font-size:11px}
.hero-flow{display:flex;align-items:center;justify-content:center;gap:0;width:min(620px,100%);margin:24px 0 8px}
.hero-flow figure{flex:0 0 auto;width:190px;margin:0}
.hero-flow figure:first-of-type{width:160px;margin-right:22px}
.hero-flow figure img{width:190px;height:174px;border-radius:12px;box-shadow:0 8px 24px rgba(34,48,78,.12)}
.hero-flow figure:first-of-type img{width:160px;height:160px;box-shadow:none}
.hero-flow figure:nth-of-type(3){margin-left:-112px;z-index:2}
.hero-flow figure:nth-of-type(4){margin-left:-112px;z-index:1}
.hero-flow figcaption{display:none}
.hero-flow>b{position:relative;z-index:4;flex:0 0 32px;margin:0 10px 0 0}
.model-card-art{display:block;width:100%;height:54px;border-radius:5px;object-fit:cover;background:#eef1f6}.scene-card-art{display:block;width:100%;height:42px;border-radius:6px;object-fit:cover;background:#eef1f6}
.edit-case-copy{order:-1}
.edit-case-tabs button{display:flex;align-items:center;justify-content:flex-start;flex-direction:column;gap:4px;min-width:60px;width:60px;height:66px;min-height:66px;padding:4px 3px;font-size:9px}
.edit-case-tabs button img{display:block;width:54px;height:40px;border-radius:5px;object-fit:cover;background:#eef1f6}
.edit-case-tabs button span{display:block;overflow:hidden;max-width:100%;text-overflow:ellipsis;white-space:nowrap}
.detail-mode .detail-preview-wrap{width:min(350px,100%)}
@media(max-height:760px){.edit-case-image{width:min(406px,85vw)}.edit-case-compare{--edit-case-width:min(406px,85vw)}}
@media(max-height:760px){.detail-mode .detail-preview-wrap{width:min(290px,100%)}}
@media(max-height:650px){.detail-mode .detail-preview-wrap{width:min(290px,100%)}}
.special-sidebar .model-library-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
.special-sidebar .model-library-grid button{display:flex;align-items:stretch;min-width:0;min-height:140px}
.special-sidebar .model-card-art,.special-sidebar .scene-card-art{height:132px;object-fit:cover}
.special-sidebar .scene-library-list button{display:flex;align-items:stretch;justify-content:center;min-width:0;min-height:140px;padding:4px}
.special-sidebar .scene-smart{grid-column:auto}
.model-inline-generate-button,.scene-generate-button{display:flex;align-items:center;justify-content:center;min-height:30px;margin-top:8px;padding:0 12px;border:1px solid #6d5be9;border-radius:8px;background:#6d5be9;color:#fff;font-size:10px;cursor:pointer}.model-inline-generate-button:disabled,.scene-generate-button:disabled{opacity:.5;cursor:not-allowed}.scene-ai-editor{display:flex;flex-direction:column;gap:7px;margin-top:8px}.scene-ai-editor .model-scene-label{margin:0}.scene-reference-actions{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:6px}.scene-reference-actions .library-upload-button{min-height:30px;margin:0;padding:0 4px;font-size:9px}.scene-reference-actions .scene-generate-button{margin:0}.scene-reference-hint,.scene-reference-selected{color:#8a95a8;font-size:9px;line-height:1.4}.scene-reference-selected{margin:0;color:#5c46d8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.config-title-with-action{justify-content:space-between}.config-title-with-action>span{display:flex;align-items:center;gap:7px}.unify-style-control{display:flex;align-items:center;gap:7px;color:#7d8798;font-size:10px;font-weight:400;cursor:pointer}.unify-style-control input{appearance:none;position:relative;width:28px;height:16px;margin:0;border:0;border-radius:10px;background:#d8dce5;cursor:pointer;transition:background .16s}.unify-style-control input::after{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;content:'';box-shadow:0 1px 2px rgba(16,24,40,.18);transition:transform .16s}.unify-style-control input:checked{background:#5942e8}.unify-style-control input:checked::after{transform:translateX(12px)}.unify-style-control input:focus-visible{outline:2px solid rgba(89,66,232,.3);outline-offset:2px}.style-button-group{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px}.style-button-group button,.platform-button-group button{min-height:32px;padding:0 8px;border:1px solid #e5e8ef;border-radius:7px;background:#fff;color:#56647a;font:inherit;font-size:10px;white-space:nowrap;cursor:pointer;transition:border-color .15s,background .15s,color .15s}.style-button-group button:hover,.platform-button-group button:hover{border-color:#b9adff;color:#5b43df}.style-button-group button.active,.platform-button-group button.active{border-color:#6d55ed;background:#f3f0ff;color:#5b43df;font-weight:600}.platform-button-group{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px}
@media(max-width:1280px){.studio-layout{grid-template-columns:minmax(260px,290px) minmax(0,1fr)}}
@container (max-width:600px){.image-studio-page .hero-flow{width:min(370px,100%)}.image-studio-page .hero-flow figure{width:118px}.image-studio-page .hero-flow figure:first-of-type{width:104px;margin-right:8px}.image-studio-page .hero-flow figure img{width:118px;height:112px}.image-studio-page .hero-flow figure:first-of-type img{width:104px;height:104px}.image-studio-page .hero-flow figure:nth-of-type(3),.image-studio-page .hero-flow figure:nth-of-type(4){margin-left:-66px}.image-studio-page .hero-flow>b{flex-basis:22px;margin-right:6px}}
/* Special image modes use the same fixed left action area as the reference site. */
.inline-tool-icon{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.image-studio-page{container-type:inline-size}
.replicate-workspace,.special-workspace{position:relative;grid-template-rows:minmax(0,1fr);flex:1 1 auto;min-height:0;overflow:hidden}
.replicate-sidebar,.special-sidebar{min-height:0;overflow-y:auto;padding-bottom:96px;scrollbar-width:thin;overscroll-behavior:contain}
.replicate-main,.special-main{min-height:0;overflow:auto;overscroll-behavior:contain}
.replicate-hero,.special-hero{min-height:100%}
.special-generate-footer{position:absolute;left:0;bottom:0;z-index:5;width:325px;box-sizing:border-box;padding:10px 12px 12px;border-top:1px solid #dde2eb;background:rgba(255,255,255,.97);text-align:center;box-shadow:0 -4px 14px rgba(36,49,78,.04)}
.special-generate-footer p{margin:1px 0;color:#71809a;font-size:10px;line-height:1.45}
.special-generate-footer .generate-button{width:100%;margin-top:7px}
.replicate-flow figure{width:min(207px,calc((100% - 90px)/3))}
.replicate-flow figure img{width:100%;height:auto;aspect-ratio:1/1;object-fit:cover}
.model-workspace .special-flow,.quantity-workspace .special-flow{width:100%;justify-content:center}
.model-workspace .special-flow{gap:14px}
.model-workspace .special-flow figure:first-of-type{width:min(190px,29%)}
.model-workspace .special-flow figure:not(:first-of-type){width:min(171px,25%)}
.model-workspace .special-flow figure img{width:100%;height:auto;aspect-ratio:auto;object-fit:cover}
.quantity-workspace .special-flow{gap:14px}
.quantity-workspace .special-flow figure:first-of-type{width:min(242px,34%)}
.quantity-workspace .special-flow figure:last-of-type{width:min(291px,40%)}
.quantity-workspace .special-flow figure img{width:100%;height:auto;aspect-ratio:1/1;object-fit:cover}
.edit-case-tabs button{min-width:88px;width:88px}
.edit-case-tabs button img{width:82px;height:44px}
.edit-composer{height:68px;min-height:68px;box-sizing:border-box}
.edit-composer>textarea{height:25px;min-height:25px;padding:3px 6px;border-color:transparent;resize:none}
.edit-composer>textarea:focus{border-color:#d8deea}
.edit-composer-toolbar{position:static;min-height:0;gap:0;margin:0}
.edit-upload-button,.edit-optimize-button{position:absolute;bottom:8px;font-size:0;gap:0}
.edit-upload-button{left:14px}
.edit-optimize-button{left:42px}
.edit-upload-button .inline-tool-icon{width:16px;height:16px}
.edit-optimize-button::before{content:'✦';font-size:14px}
.edit-parameter-row{position:absolute;left:108px;right:95px;bottom:8px;width:auto;gap:7px;padding-top:0;border-top:0}
.edit-parameter-row label{gap:0}
.edit-parameter-row label{font-size:0}
.edit-parameter-row select{width:100%;height:28px;font-size:10px}
.edit-prompt-count{position:absolute;right:53px;bottom:13px;margin:0;font-size:9px;pointer-events:none}
.analyze-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}
.analyze-row .config-note{margin:0}
@container (min-width:901px){
  .image-studio-page .studio-layout{grid-template-columns:minmax(280px,320px) minmax(0,1fr)}
  .image-studio-page .replicate-workspace,.image-studio-page .special-workspace{display:grid;grid-template-columns:325px minmax(0,1fr);gap:16px;overflow:hidden}
  .image-studio-page .replicate-sidebar,.image-studio-page .special-sidebar{overflow-y:auto;padding-bottom:96px}
  .image-studio-page .replicate-main,.image-studio-page .special-main{min-height:0;overflow:auto}
  .image-studio-page .special-generate-footer{position:absolute;left:0;bottom:0;width:325px}
  .image-studio-page .replicate-hero,.image-studio-page .special-hero{min-height:100%}
}
@container (max-width:900px){.image-studio-page .replicate-workspace,.image-studio-page .special-workspace{display:flex;flex-direction:column;gap:12px;overflow-y:auto}.image-studio-page .replicate-sidebar,.image-studio-page .special-sidebar{overflow:visible;padding-bottom:0}.image-studio-page .replicate-main,.image-studio-page .special-main{min-height:420px;overflow:visible}.image-studio-page .replicate-hero,.image-studio-page .special-hero{min-height:420px}.image-studio-page .special-generate-footer{position:static;order:2;width:auto;flex:0 0 auto}.image-studio-page .replicate-main,.image-studio-page .special-main{order:3}}
</style>
