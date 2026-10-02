<script lang="ts">
/**
 * 回读结果的模块级缓存。
 *
 * **为什么不能只放在组件里**（2026-10-02 真机实测）：点「回读页面实际值」会**打开店铺页面**
 * 并把应用**切到「店铺工作台」视图**，本组件随之被**卸载** —— 组件局部 ref 必丢，
 * 于是用户回到「商品管理」时组件重新挂载、`readback` 又是 null，**面板永远不出现**。
 * 表现极具迷惑性：回读成功、toast 报了成功、界面上却什么都没有（§7.11 静默失效）。
 * 放在模块作用域即可跨视图存活。
 */
export const readbackCache: { current: null | { itemId: string; suggestions: unknown[]; readFields: string[]; missingFields: string[] } } = { current: null }
</script>
<template>
  <section class="unified-page unified-apps-page" :data-test="`unified-${mode}-page`">
    <header class="unified-page-head">
      <div>
        <span class="dashboard-eyebrow">WORKSPACE / {{ mode === 'products' ? 'PRODUCTS' : mode === 'ai' ? 'AI STUDIO' : 'APPS' }}</span>
        <h1>{{ title }}</h1>
        <p>{{ subtitle }}</p>
      </div>
      <button v-if="mode === 'products'" type="button" class="unified-button primary" @click="emit('navigate', 'stores')"><img class="button-icon" :src="storeManageIcon" alt="" />管理店铺</button>
    </header>

    <template v-if="mode === 'products'">
      <!-- 商品管理（M1：同步 + 只读清单）。发布不在这里——发布要走任务引擎 + 人工确认门禁。 -->
      <div class="unified-alert info" v-if="!hasAnyMeasuredPlatform">
        <strong>暂无已实测的商品数据源</strong>
        <span>四个平台里还没有实测到商品列表的档案，因此暂不能同步。这不是"没有商品"，是"这个平台还没实测"。</span>
      </div>

      <div v-if="ws.ready && ws.stores.length" class="product-toolbar">
        <button type="button" class="unified-button primary" :disabled="!!syncingStoreId" @click="syncAll">
          <img class="button-icon" :src="syncIcon" alt="" />{{ syncingStoreId ? '同步中…' : '同步全部店铺' }}</button>
        <span class="product-toolbar-hint">{{ productSummary }}</span>
        <button type="button" class="unified-button" :disabled="loadingProducts" @click="loadProducts">
          <img class="button-icon" :src="syncIcon" alt="" />刷新清单</button>
      </div>

      <div v-if="!ws.ready" class="unified-state"><span class="loader"></span>正在读取店铺…</div>
      <div v-else-if="!ws.stores.length" class="unified-empty">暂无店铺<button type="button" class="inline-link" @click="emit('navigate', 'stores')">添加店铺</button></div>

      <div v-else class="product-store-list">
        <article v-for="store in ws.stores" :key="store.id" class="product-store-card">
          <PlatformIcon :name="store.platform" :size="34" />
          <div class="product-store-copy">
            <strong>{{ store.name }}</strong>
            <span>{{ store.platform }} · {{ storeSyncText(store) }}</span>
          </div>
          <span class="unified-status" :class="statusClass(store.status)"><i></i>{{ statusLabel(store.status) }}</span>
          <button type="button" class="unified-button" :data-test="'product-sync-' + store.id" :disabled="!!syncingStoreId" @click="syncStore(store)">
            <img class="button-icon" :src="productSyncIcon" alt="" />{{ syncingStoreId === store.id ? '同步中…' : '同步商品' }}
          </button>
          <button type="button" class="unified-button" @click="emit('open-store', store.id)">
          <img class="button-icon" :src="externalIcon" alt="" />打开店铺后台</button>
        </article>
      </div>

      <div v-if="ws.ready && ws.stores.length" class="product-table-wrap">
        <div class="product-table-head">
          <h2>本地已同步的商品（{{ productTotal }} 条）</h2>
          <span v-if="orphanCount">其中 {{ orphanCount }} 条在平台上发现、本地还没有归属</span>
        </div>
        <div v-if="loadingProducts" class="unified-state"><span class="loader"></span>正在读取商品…</div>
        <div v-else-if="!productRows.length" class="unified-empty">
          <span>还没有同步到商品。</span>
          <span class="product-empty-hint">点上面的「同步商品」从平台拉取；未实测的平台会明确说明原因，不会假装有数据。</span>
        </div>
        <table v-else class="product-table">
          <thead><tr><th>平台 / 店铺</th><th>商品</th><th>价格</th><th>库存</th><th>状态</th><th>本地归属</th></tr></thead>
          <tbody>
            <tr v-for="row in productRows" :key="row.linkId" :data-test="'product-row-' + row.platformProductId">
              <td><span class="product-platform">{{ row.platform }}</span><small>{{ row.storeName }}</small></td>
              <td><span class="product-title">{{ row.platformTitle || '标题未取到' }}</span><small>ID: {{ row.platformProductId }}</small></td>
              <td>{{ formatMinor(row.platformPriceMinor) }}</td>
              <td>{{ row.platformStock == null ? '未取到' : row.platformStock }}</td>
              <td>{{ productStatusLabel(row.platformStatus || 'unknown') }}</td>
              <td>
                <template v-if="row.productTitle">{{ row.productTitle }}</template>
                <template v-else>
                  <span class="product-orphan">未归并</span>
                  <!-- 归并**必须由用户点**（方案 D2：绝不自动合并） -->
                  <button type="button" class="unified-button ghost" :data-test="'product-detail-' + row.platformProductId"
                          :disabled="busy" @click="collectDetail(row)">
                  <img class="button-icon" :src="scanQueueIcon" alt="" />拉取详情</button>
                  <button type="button" class="unified-button ghost" :data-test="'product-save-as-' + row.platformProductId"
                          :disabled="busy" @click="saveAsLocal(row)">
                  <img class="button-icon" :src="downloadImageIcon" alt="" />另存为本地商品</button>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="productRows.length < productTotal" class="product-more">
          本页显示 {{ productRows.length }} / {{ productTotal }} 条（分页显示，不是同步丢了数据）
        </p>
      </div>

      <!-- 本地商品库（M2）：本地商品是"可以发布到任意店铺"的那一份主数据 -->
      <div v-if="ws.ready && ws.stores.length" class="product-table-wrap">
        <div class="product-table-head">
          <h2>本地商品（{{ localTotal }} 条）</h2>
          <span>平台商品归入本地商品后，才能编辑并发布到指定店铺</span>
          <button type="button" class="unified-button ghost" :data-test="'batch-create'" :disabled="busy" @click="createBatch">
          <img class="button-icon" :src="publishIcon" alt="" />批量发布（全部 × 在线店铺）</button>
          <button type="button" class="unified-button ghost" :data-test="'media-queue-scan'" :disabled="busy" @click="scanMediaQueue">
          <img class="button-icon" :src="scanQueueIcon" alt="" />扫图片队列</button>
          <button type="button" class="unified-button ghost" :data-test="'media-queue-run'" :disabled="busy" @click="runMediaQueue">
          <img class="button-icon" :src="downloadImageIcon" alt="" />跑队列（20 张）</button>
          <button type="button" class="unified-button ghost" :data-test="'media-orphans'" :disabled="busy" @click="scanOrphans">
          <img class="button-icon" :src="cleanupIcon" alt="" />查孤儿文件</button>
        </div>
        <div v-if="!localRows.length" class="unified-empty">
          <span>还没有本地商品。</span>
          <span class="product-empty-hint">在上面的平台商品行点「另存为本地商品」就会建出一条本地商品。</span>
        </div>
        <table v-else class="product-table">
          <thead><tr><th>标题</th><th>规格</th><th>主图</th><th>已挂平台商品</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="row in localRows" :key="row.id" :data-test="'local-product-' + row.id">
              <td><span class="product-title">{{ row.title || '（无标题）' }}</span><small>{{ row.status }} · 更新 {{ formatTime(row.updatedAt) }}</small></td>
              <td>{{ row.variantCount }} 个</td>
              <td>{{ mediaStateLabel(row.coverState) }}</td>
              <td>{{ row.linkCount }}</td>
              <td class="product-actions">
                <button type="button" class="unified-button ghost" :data-test="'local-edit-' + row.id" :disabled="busy" @click="openEditor(row)">
                <img class="button-icon" :src="manualEditIcon" alt="" />编辑</button>
                <button type="button" class="unified-button ghost" :data-test="'local-localize-' + row.id" :disabled="busy" @click="localizeMedia(row)">
                <img class="button-icon" :src="downloadImageIcon" alt="" />下载图片到本地</button>
                <button type="button" class="unified-button ghost" :data-test="'local-preflight-' + row.id" :disabled="busy" @click="runPreflight(row)">
                <img class="button-icon" :src="preflightIcon" alt="" />发布预检</button>
                <button type="button" class="unified-button ghost" :disabled="busy" @click="removeLocal(row)">
                <img class="button-icon" :src="cleanupIcon" alt="" />删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 发布预检结果（M3）：字段级 diff 就是那张"看一张表就够"的核对清单（方案 §7.6） -->
      <div v-if="preflight" class="product-table-wrap" :data-test="'publish-preflight'">
        <div class="product-table-head">
          <h2>发布预检 · {{ preflight.storeName }}</h2>
          <span :class="'verdict-' + preflight.precheck.verdict">{{ preflight.precheck.summary }}</span>
        </div>
        <table class="product-table">
          <thead><tr><th>字段</th><th>本地值</th><th>平台当前值</th><th>上次发布值</th><th>本次动作</th></tr></thead>
          <tbody>
            <tr v-for="field in preflight.precheck.fields" :key="field.field" :data-test="'preflight-field-' + field.field">
              <td>{{ field.label }}</td>
              <td>{{ field.localValue ?? '—' }}</td>
              <td>{{ field.platformValue ?? '（还没读页面）' }}</td>
              <td>{{ field.lastValue ?? '—' }}</td>
              <td :class="'issue-' + field.level">
                {{ fieldActionLabel(field.action) }}
                <small v-if="field.note">{{ field.note }}</small>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="preflight.precheck.blockers.length" class="product-issues">
          <div v-for="(issue, index) in preflight.precheck.blockers" :key="index" class="issue-blocker">
            <b>阻断</b><span>{{ issue.message }}</span><small v-if="issue.fixHint">{{ issue.fixHint }}</small>
          </div>
        </div>
        <div v-if="preflight.precheck.warnings.length" class="product-issues">
          <div v-for="(issue, index) in preflight.precheck.warnings" :key="index" class="issue-warning">
            <b>提醒</b><span>{{ issue.message }}</span><small v-if="issue.fixHint">{{ issue.fixHint }}</small>
          </div>
        </div>
        <p v-if="preflight.precheck.missingRequired.length" class="product-more">
          本地还缺这些必填项：{{ preflight.precheck.missingRequired.join('、') }}（下次发布前补全会更省事）
        </p>
        <div class="product-drawer-actions" style="padding:12px 16px">
          <button type="button" class="unified-button primary" :data-test="'publish-open-page'"
                  :disabled="busy || preflight.precheck.verdict === 'blocked'" @click="openPublishPage(false)">
                  <img class="button-icon" :src="externalIcon" alt="" />打开平台发布页</button>
          <button type="button" class="unified-button ghost" :data-test="'publish-open-fill'"
                  :disabled="busy || preflight.precheck.verdict === 'blocked'" @click="openPublishPage(true)">
                  <img class="button-icon" :src="publishIcon" alt="" />打开并预填（L1）</button>
              <button type="button" class="unified-button ghost" :data-test="'publish-open-gate'" :disabled="busy" @click="openGate"><img class="button-icon" :src="publishGateIcon" alt="" />开人工确认门禁</button>
          <button type="button" class="unified-button ghost" :data-test="'publish-confirm'" :disabled="busy" @click="confirmSubmitted(true)"><img class="button-icon" :src="publishConfirmIcon" alt="" />我已提交</button>
          <button type="button" class="unified-button ghost" :data-test="'publish-readback'" :disabled="busy" @click="runReadback">
          <img class="button-icon" :src="scanQueueIcon" alt="" />回读页面实际值</button>
          <button type="button" class="unified-button ghost" :disabled="busy" @click="confirmSubmitted(false)"><img class="button-icon" :src="publishAbandonIcon" alt="" />放弃这次发布</button>
          <button type="button" class="unified-button ghost" @click="preflight = null"><img class="button-icon" :src="panelCloseIcon" alt="" />关闭</button>
          <span class="product-empty-hint">应用**不会**替你点提交：页面填完后由你自己提交。</span>
        </div>
      </div>

      <!-- 图片队列与孤儿清理（方案 §5.9）：清理是**用户确认后**才删 -->
      <div v-if="mediaQueue" class="product-table-wrap" :data-test="'media-queue-panel'">
        <div class="product-table-head">
          <h2>图片本地化队列 / 保留策略</h2>
          <span :data-test="'media-queue-summary'">{{ mediaQueue.summary }}</span>
        </div>
        <p v-if="mediaQueue.items.length" class="product-more">
          队列 {{ mediaQueue.items.length }} 项，其中会真的下载 {{ mediaQueue.items.filter(i => i.shouldAttempt).length }} 项
          <template v-if="mediaQueue.items.some(i => !i.shouldAttempt)">
            ；不重试的：{{ mediaQueue.items.filter(i => !i.shouldAttempt).slice(0, 2).map(i => i.reason).join('；') }}
          </template>
        </p>
        <div v-if="mediaQueue.orphans" class="product-issues">
          <div :class="mediaQueue.orphans.orphans.length ? 'issue-warning' : 'issue-info'">
            <b>孤儿文件</b><span :data-test="'media-orphan-summary'">{{ mediaQueue.orphans.summary }}</span>
            <small>判定：不在商品媒体表里、且超过 24 小时宽限期。清理只删应用自己的 product-media 目录里的文件。</small>
          </div>
          <div class="product-drawer-actions">
            <button type="button" class="unified-button ghost" :data-test="'media-cleanup'" :disabled="busy || !mediaQueue.orphans.orphans.length"
                    @click="cleanupOrphans">
                    <img class="button-icon" :src="cleanupIcon" alt="" />确认清理（{{ mediaQueue.orphans.orphans.length }} 个）</button>
          </div>
        </div>
        <div class="product-drawer-actions" style="padding:12px 16px">
          <button type="button" class="unified-button ghost" @click="mediaQueue = null">关闭</button>
          <span class="product-empty-hint">清理**只会删**应用自己目录里、且没有任何商品在用的文件。</span>
        </div>
      </div>

      <!-- 批量进度（M5，方案 §7.8）：**三个数**，不是一个百分比 -->
      <div v-if="batch" class="product-table-wrap" :data-test="'publish-batch-panel'">
        <div class="product-table-head">
          <h2>批量发布进度</h2>
          <span :data-test="'batch-summary'">{{ batch.progress.summary }}</span>
        </div>
        <div class="product-issues" style="flex-direction:row;gap:18px">
          <div><b>已完成</b><span :data-test="'batch-done'">{{ batch.progress.done }}</span></div>
          <div><b>待人工</b><span :data-test="'batch-waiting'">{{ batch.progress.waitingHuman }}</span></div>
          <div><b>失败</b><span :data-test="'batch-failed'">{{ batch.progress.failed }}</span></div>
          <div><b>未开始</b><span>{{ batch.progress.pending }}</span></div>
          <div><b>已跳过</b><span>{{ batch.progress.skipped }}</span></div>
        </div>
        <p class="product-more">
          当前该处理的店铺：<b>{{ batch.progress.currentStoreId ? storeNameOf(batch.progress.currentStoreId) : '（没有待处理的店铺）' }}</b>
          —— 一次只打开一个店铺；应用**不会**替你点提交。
        </p>
        <table class="product-table">
          <thead><tr><th>店铺</th><th>项数</th><th>状态分布</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="store in ws.stores.filter(s => batchItemsOfStore(s.id).length)" :key="store.id" :data-test="'batch-store-' + store.id">
              <td>{{ store.name }}<small>{{ store.platform }}</small></td>
              <td>{{ batchItemsOfStore(store.id).length }}</td>
              <td>{{ statusCountsText(batchItemsOfStore(store.id)) }}</td>
              <td class="product-actions">
                <button type="button" class="unified-button ghost" :data-test="`batch-store-now-${store.id}`" :disabled="busy" @click="handleStoreNow(store.id)"><img class="button-icon" :src="batchHandleStoreIcon" alt="" />处理这家</button>
                <button type="button" class="unified-button ghost" :disabled="busy" @click="skipStore(store.id)"><img class="button-icon" :src="batchSkipStoreIcon" alt="" />跳过这家</button>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="product-drawer-actions" style="padding:12px 16px">
          <button type="button" class="unified-button ghost" :data-test="'batch-abort'" :disabled="busy" @click="pauseBatch"><img class="button-icon" :src="batchPauseIcon" alt="" />全部暂停</button>
          <button type="button" class="unified-button ghost" :disabled="busy" @click="loadBatch">
          <img class="button-icon" :src="syncIcon" alt="" />刷新进度</button>
          <button type="button" class="unified-button ghost" @click="batch = null"><img class="button-icon" :src="bulkPanelCloseIcon" alt="" />关闭</button>
        </div>
      </div>

      <!-- 回读建议（M4，方案 §7.5）：**应用不会自动改**，逐条由用户点「接受」才落库 -->
      <div v-if="readback" class="product-table-wrap" :data-test="'publish-readback-panel'">
        <div class="product-table-head">
          <h2>回读建议（页面上实际填的值 vs 本地）</h2>
          <span>读到的字段：{{ readback.readFields.join('、') || '无' }}<template v-if="readback.missingFields.length">；页面上没有：{{ readback.missingFields.join('、') }}</template></span>
        </div>
        <div v-if="!readback.suggestions.length" class="unified-empty"><span>没有可显示的建议。</span></div>
        <table v-else class="product-table">
          <thead><tr><th>字段</th><th>本地值</th><th>页面上的值</th><th>判断</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="item in readback.suggestions" :key="item.field" :data-test="'readback-' + item.field">
              <td>{{ item.label }}</td>
              <td>{{ item.localValue ?? '—' }}</td>
              <td>{{ item.platformValue ?? '—' }}</td>
              <td><span class="product-orphan">{{ suggestionKindLabel(item.kind) }}</span><small>{{ item.note }}</small></td>
              <td class="product-actions">
                <button v-if="item.kind === 'suggest_default' || item.kind === 'suggest_writeback'" type="button"
                        class="unified-button ghost" :data-test="'readback-accept-' + item.field" :disabled="busy"
                        @click="acceptSuggestion(item)">
                        <img class="button-icon" :src="acceptIcon" alt="" />接受</button>
                <span v-else class="product-empty-hint">无需处理</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="product-drawer-actions" style="padding:12px 16px">
          <button type="button" class="unified-button ghost" @click="readback = null"><img class="button-icon" :src="bulkPanelCloseIcon" alt="" />关闭</button>
          <span class="product-empty-hint">应用**不会**自动改本地：只有你点了「接受」的条目才会落库。</span>
        </div>
      </div>

      <!-- 编辑抽屉：只编辑"能编辑的部分"（标题 / 规格价格库存）；图片与规格补齐在后续轮次 -->
      <div v-if="editing" class="product-drawer" :data-test="'product-editor'">
        <div class="product-drawer-head">
          <strong>编辑本地商品</strong>
          <button type="button" class="inline-link" @click="editing = null"><img class="button-icon" :src="bulkPanelCloseIcon" alt="" />关闭</button>
        </div>
        <label class="product-field"><span>标题</span>
          <input v-model="editing.title" type="text" :data-test="'editor-title'" />
        </label>
        <div v-for="(variant, index) in editing.variants" :key="index" class="product-field-row">
          <label class="product-field"><span>规格 {{ index + 1 }}</span>
            <input :value="specText(variant.spec)" disabled />
          </label>
          <label class="product-field"><span>价格（元）</span>
            <input v-model="variant.priceYuan" type="text" :data-test="'editor-price-' + index" />
          </label>
          <label class="product-field"><span>库存</span>
            <input v-model="variant.stockText" type="text" :data-test="'editor-stock-' + index" />
          </label>
        </div>
        <div v-if="editorIssues.length" class="product-issues">
          <div v-for="(issue, index) in editorIssues" :key="index" :class="'issue-' + issue.level">
            <b>{{ issue.level === 'blocker' ? '阻断' : issue.level === 'warning' ? '注意' : '提示' }}</b>
            <span>{{ issue.message }}</span>
            <small v-if="issue.fixHint">{{ issue.fixHint }}</small>
          </div>
        </div>
        <div class="product-drawer-actions">
          <button type="button" class="unified-button primary" :data-test="'editor-save'" :disabled="busy" @click="saveEditor"><img class="button-icon" :src="productSaveCheckIcon" alt="" />保存</button>
        </div>
      </div>
    </template>

    <template v-else-if="mode === 'ai'">
      <div class="ai-assistant-card">
        <div class="ai-orb" aria-hidden="true"><img :src="assistantArt" alt="" /></div>
        <div class="ai-assistant-copy"><span class="available-pill"><i></i>已接入</span><h2>AI 电商助手</h2><p>通过当前 Agent 助手进行分析、规划和店铺工作流协助。执行写入操作仍会按现有流程请求确认。</p></div>
        <button type="button" class="unified-button primary" @click="emit('open-assistant')"><img class="button-icon" :src="assistantOpenIcon" alt="" />打开助手</button>
      </div>
      <div class="app-card-grid">
        <article class="app-card app-card-action" @click="emit('navigate', 'image-studio')" @keydown.enter="emit('navigate', 'image-studio')" tabindex="0" role="button"><span class="app-card-icon purple"><img :src="aiAppIcon" alt="" /></span><div><h2>AI 生成商品图</h2><p>进入模型选择、对话生图和真实结果预览工作台。</p></div><span class="app-card-arrow"><img :src="forwardIcon" alt="" /></span></article>
        <article class="app-card"><span class="app-card-icon blue"><img :src="publishAppIcon" alt="" /></span><div><h2>批量发布商品</h2><p>尚无商品发布页面或发布 API。</p></div><span class="unavailable-pill">暂不可用</span></article>
        <article class="app-card"><span class="app-card-icon teal"><img :src="videoAppIcon" alt="" /></span><div><h2>短视频去重</h2><p>当前项目没有对应的媒体处理模块。</p></div><span class="unavailable-pill">暂不可用</span></article>
        <article class="app-card"><span class="app-card-icon orange"><img :src="mediaAppIcon" alt="" /></span><div><h2>影像级干扰</h2><p>当前项目没有对应的影像处理模块。</p></div><span class="unavailable-pill">暂不可用</span></article>
        <article class="app-card app-card-action" @click="emit('navigate', 'settings')" @keydown.enter="emit('navigate', 'settings')" tabindex="0" role="button"><span class="app-card-icon violet"><img :src="settingsAppIcon" alt="" /></span><div><h2>AI 模型配置</h2><p>查看现有服务商、模型连接和 Agent 配置。</p></div><span class="app-card-arrow"><img :src="forwardIcon" alt="" /></span></article>
        <article class="app-card app-card-action" @click="emit('navigate', 'tasks')" @keydown.enter="emit('navigate', 'tasks')" tabindex="0" role="button"><span class="app-card-icon cyan"><img :src="tasksAppIcon" alt="" /></span><div><h2>AI 任务中心</h2><p>查看 TaskRunner 中真实任务与运行状态。</p></div><span class="app-card-arrow"><img :src="forwardIcon" alt="" /></span></article>
      </div>
    </template>

    <template v-else>
      <div class="app-card-grid">
        <article v-for="item in appLinks" :key="item.key" class="app-card app-card-action" tabindex="0" role="button" @click="emit('navigate', item.page)" @keydown.enter="emit('navigate', item.page)">
          <span class="app-card-icon" :class="item.tone"><img :src="item.icon" alt="" /></span><div><h2>{{ item.label }}</h2><p>{{ item.description }}</p></div><span class="app-card-arrow"><img :src="forwardIcon" alt="" /></span>
        </article>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { hasProductProfile } from '@shared/constants/product'
import { productStatusLabel } from '@shared/product-rules'
import type { PlatformProductStatus } from '@shared/contracts/platform-product'
import PlatformIcon from '../../components/PlatformIcon.vue'
import { useWorkspaceStore } from '../../stores/workspace'
import aiAppIcon from '../../assets/icons/nav-ai.svg'
import publishAppIcon from '../../assets/icons/app-orders.svg'
import videoAppIcon from '../../assets/icons/app-tasks.svg'
import mediaAppIcon from '../../assets/icons/app-invoices.svg'
import settingsAppIcon from '../../assets/icons/nav-settings.svg'
import storesAppIcon from '../../assets/icons/app-stores.svg'
import analyticsAppIcon from '../../assets/icons/app-analytics.svg'
import ordersAppIcon from '../../assets/icons/app-orders.svg'
import invoicesAppIcon from '../../assets/icons/app-invoices.svg'
import tasksAppIcon from '../../assets/icons/app-tasks.svg'
import forwardIcon from '../../assets/generated/ui-icons/forward-gen.png'
import syncIcon from '../../assets/generated/ui-icons/sync-gen.png'
import publishIcon from '../../assets/generated/ui-icons/publish-gen.png'
import preflightIcon from '../../assets/generated/ui-icons/preflight-gen.png'
import externalIcon from '../../assets/generated/ui-icons/external-gen.png'
import downloadImageIcon from '../../assets/generated/ui-icons/download-image-gen.png'
import cleanupIcon from '../../assets/generated/ui-icons/cleanup-gen.png'
import acceptIcon from '../../assets/generated/ui-icons/accept-gen.png'
import scanQueueIcon from '../../assets/generated/ui-icons/scan-queue-gen.png'
import manualEditIcon from '../../assets/generated/ui-icons/manual-edit-gen.png'
import assistantArt from '../../assets/generated/ai-assistant-generated.png'
import storeManageIcon from '../../assets/generated/ui-icons/app-store-gen.png'
import productSyncIcon from '../../assets/generated/ui-icons/product-sync-sheet-gen.png'
import publishGateIcon from '../../assets/generated/ui-icons/publish-gate-sheet-gen.png'
import publishConfirmIcon from '../../assets/generated/ui-icons/publish-confirm-sheet-gen.png'
import publishAbandonIcon from '../../assets/generated/ui-icons/publish-abandon-sheet-gen.png'
import panelCloseIcon from '../../assets/generated/ui-icons/panel-close-sheet-gen.png'
import batchHandleStoreIcon from '../../assets/generated/ui-icons/batch-handle-store-gen.png'
import batchSkipStoreIcon from '../../assets/generated/ui-icons/batch-skip-store-gen.png'
import batchPauseIcon from '../../assets/generated/ui-icons/batch-pause-gen.png'
import bulkPanelCloseIcon from '../../assets/generated/ui-icons/panel-close-bulk-gen.png'
import productSaveCheckIcon from '../../assets/generated/ui-icons/product-save-check-gen.png'
import assistantOpenIcon from '../../assets/generated/ui-icons/assistant-open-gen.png'

type Mode = 'products' | 'ai' | 'apps'
type Page = 'stores' | 'analytics' | 'orders' | 'invoices' | 'tasks' | 'settings' | 'image-studio'
const props = defineProps<{ mode: Mode }>()
const emit = defineEmits<{
  navigate: [page: Page]
  'open-store': [storeId: string]
  'open-assistant': []
}>()
const ws = useWorkspaceStore()
const title = computed(() => props.mode === 'products' ? '商品管理' : props.mode === 'ai' ? 'AI 创作工具' : '应用中心')
const subtitle = computed(() => props.mode === 'products' ? '把各平台店铺的商品同步到本地；本地商品可以发布到指定店铺（半自动，提交由你在浏览器里确认）。' : props.mode === 'ai' ? '访问当前已接入的 Agent 助手、配置和任务能力。' : '从同一工作区进入店铺、数据、任务和设置页面。')
const appLinks: Array<{ key: string; label: string; description: string; icon: string; tone: string; page: Page }> = [
  { key: 'stores', label: '店铺管理', description: '管理店铺、平台、登录状态和本机浏览器工作区。', icon: storesAppIcon, tone: 'blue', page: 'stores' },
  { key: 'analytics', label: '数据分析', description: '查看真实快照、经营指标和数据采集入口。', icon: analyticsAppIcon, tone: 'purple', page: 'analytics' },
  { key: 'orders', label: '订单管理', description: '查看已经采集的订单快照和平台支持状态。', icon: ordersAppIcon, tone: 'cyan', page: 'orders' },
  { key: 'invoices', label: '发票中心', description: '汇总真实待开票记录，并导出 CSV。', icon: invoicesAppIcon, tone: 'orange', page: 'invoices' },
  { key: 'tasks', label: 'AI 任务中心', description: '管理 TaskRunner 任务、运行、确认和进度。', icon: tasksAppIcon, tone: 'teal', page: 'tasks' },
  { key: 'settings', label: '设置中心', description: '平台地址、AI、Agent、技能、插件和软件更新。', icon: settingsAppIcon, tone: 'violet', page: 'settings' }
]
function statusLabel(status: string) { return ({ online: '在线', launching: '启动中', needs_login: '登录失效', proxy_error: '代理异常', offline: '离线', incomplete: '离线', archived: '已归档' } as Record<string, string>)[status] || '未知状态' }
function statusClass(status: string) { return status === 'online' ? 'online' : ['needs_login', 'proxy_error'].includes(status) ? 'warning' : 'offline' }

// ---------------------------------------------------------------- 商品管理（M1）

interface ProductRow {
  linkId: string
  platform: string
  storeId: string
  storeName: string
  platformProductId: string
  platformTitle: string | null
  platformStatus: PlatformProductStatus | null
  platformPriceMinor: number | null
  platformStock: number | null
  productId: string | null
  productTitle: string | null
}
interface RunRow { storeId: string; platform: string; total: number; orphan: number; latestRun: { status: string; reasonCode: string | null; startedAt: number; safeMessage: string | null; hasMore: number; insertedCount: number; updatedCount: number; missingCount: number } | null }

const productRows = ref<ProductRow[]>([])
const productTotal = ref(0)
const runRows = ref<RunRow[]>([])
const loadingProducts = ref(false)
const syncingStoreId = ref('')
const lastNotice = ref('')

/** 四个平台里只要有一家已实测登记，就还值得显示"同步"入口；一个都没有时页面顶部如实说明。 */
const hasAnyMeasuredPlatform = computed(() => ws.stores.some(store => hasProductProfile(store.platform)))
const orphanCount = computed(() => productRows.value.filter(row => !row.productId).length)
const productSummary = computed(() => {
  if (!runRows.value.length) return '还没有同步过'
  const synced = runRows.value.filter(row => row.total > 0).length
  const withRun = runRows.value.filter(row => row.latestRun)
  const failed = withRun.filter(row => row.latestRun && !['SUCCEEDED', 'PARTIAL'].includes(row.latestRun.status))
  if (!withRun.length) return '还没有同步过'
  const failedText = failed.length ? `，${failed.length} 家最近一次没成功` : ''
  return `${withRun.length} 家店有同步记录、本地共 ${productTotal.value} 条商品${failedText}${synced ? '' : ''}`
})

function formatMinor(minor: number | null): string {
  if (minor == null) return '未取到'
  return `￥${(minor / 100).toFixed(2)}`
}

/** 每家店"上次同步"如实说：状态 + 时间 + 为什么没成功。 */
function storeSyncText(store: { id: string; platform: string }): string {
  const row = runRows.value.find(item => item.storeId === store.id)
  if (!row) return '还没有同步过'
  if (!row.latestRun) return '还没有同步过'
  const run = row.latestRun
  const at = new Date(run.startedAt)
  const time = `${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const statusText: Record<string, string> = {
    SUCCEEDED: `同步成功（新增 ${run.insertedCount} / 更新 ${run.updatedCount}${run.missingCount ? ` / 平台上消失 ${run.missingCount}` : ''}）`,
    PARTIAL: '部分成功',
    LOGIN_REQUIRED: '未登录，没能同步',
    PAGE_CHANGED: '平台页面已改版，已停止且未写入数据',
    FAILED: '同步失败',
    RUNNING: '同步中'
  }
  const head = statusText[run.status] || run.status
  const tail = run.hasMore ? ' · 本次被截断，还有更多' : ''
  return `${head} · ${time}${tail}`
}

async function loadProducts(): Promise<void> {
  if (props.mode !== 'products') return
  loadingProducts.value = true
  try {
    const [list, runs] = await Promise.all([
      window.shopilot.products.list({ limit: 200 }),
      window.shopilot.products.syncRuns({})
    ])
    if (list.ok) {
      const data = list.data as { rows?: ProductRow[]; total?: number } | undefined
      productRows.value = data?.rows ?? []
      productTotal.value = data?.total ?? 0
    } else {
      ws.toast('读取商品失败：' + list.error.message, 'error')
    }
    if (runs.ok) runRows.value = ((runs.data as { rows?: RunRow[] } | undefined)?.rows) ?? []
  } finally {
    loadingProducts.value = false
  }
}

async function syncOne(storeId: string): Promise<void> {
  syncingStoreId.value = storeId
  try {
    const result = await window.shopilot.products.sync({ storeId, trigger: 'manual' })
    if (!result.ok) { ws.toast('同步失败：' + result.error.message, 'error'); return }
    const data = result.data as { status: string; safeMessage: string } | undefined
    // 成功/失败都用主进程给的原话，界面不自己编一套（"未登录""平台改版"这些必须原样透出）
    const ok = data?.status === 'SUCCEEDED' || data?.status === 'PARTIAL'
    ws.toast(data?.safeMessage || (ok ? '同步完成' : '同步未完成'), ok ? 'success' : 'error')
  } catch (error) {
    ws.toast('同步失败：' + String((error as Error)?.message || error), 'error')
  } finally {
    syncingStoreId.value = ''
    await loadProducts()
  }
}

async function syncStore(store: { id: string }): Promise<void> {
  lastNotice.value = ''
  await syncOne(store.id)
}

/** 同步全部：**逐店串行**（与方案 §5.4 的"单店串行、跨店 2 并发"一致；界面入口先做串行，稳且可解释）。 */
async function syncAll(): Promise<void> {
  for (const store of ws.stores) {
    await syncOne(store.id)
  }
}

onMounted(() => { void loadProducts(); void loadLocalProducts() })
watch(() => props.mode, () => { void loadProducts(); void loadLocalProducts() })

// ---------------------------------------------------------------- 本地商品库（M2）

interface LocalRow { id: string; title: string; status: string; updatedAt: number; variantCount: number; coverState: string | null; linkCount: number }
interface EditorVariant { spec: Array<{ name: string; value: string }>; priceYuan: string; stockText: string }
interface EditorState { productId: string; title: string; variants: EditorVariant[] }
interface DraftIssue { level: 'blocker' | 'warning' | 'info'; field: string; message: string; fixHint?: string }
interface PublishField {
  field: string; label: string; localValue: string | null; platformValue: string | null
  lastValue: string | null; action: string; level: 'info' | 'warning' | 'blocker'; note?: string
}
interface PublishPrecheck {
  verdict: 'ready' | 'ready_with_warnings' | 'blocked'
  tier: string; summary: string; storeId?: string
  blockers: DraftIssue[]; warnings: DraftIssue[]
  fields: PublishField[]; missingRequired: string[]
}
interface PreflightState { productId: string; itemId: string | null; storeName: string; precheck: PublishPrecheck }
interface ReadbackSuggestion {
  field: string; label: string; kind: 'suggest_default' | 'suggest_writeback' | 'same' | 'only_local'
  localValue: string | null; platformValue: string | null; note: string
}
interface ReadbackState { itemId: string; suggestions: ReadbackSuggestion[]; readFields: string[]; missingFields: string[] }
interface BatchProgress {
  total: number; done: number; waitingHuman: number; failed: number; pending: number; running: number; skipped: number
  currentStoreId: string | null; finished: boolean; summary: string
}
interface BatchItem { itemId: string; productId: string; storeId: string; status: string; safeMessage: string | null }
interface BatchState { batchId: string; progress: BatchProgress; items: BatchItem[] }

const localRows = ref<LocalRow[]>([])
const localTotal = ref(0)
const busy = ref(false)
const editing = ref<EditorState | null>(null)
const editorIssues = ref<DraftIssue[]>([])
const preflight = ref<PreflightState | null>(null)
// 初值从**模块级缓存**取：回读会切视图导致本组件卸载，回来时靠它把结果带回来（见文件顶部说明）
const readback = ref<ReadbackState | null>(readbackCache.current as ReadbackState | null)
watch(readback, value => { readbackCache.current = value as never })
const batch = ref<BatchState | null>(null)
interface MediaQueueState {
  summary: string
  items: Array<{ role: string; shouldAttempt: boolean; reason: string | null }>
  orphans: { orphans: unknown[]; keepCount: number; orphanBytes: number; summary: string } | null
}
const mediaQueue = ref<MediaQueueState | null>(null)

function mediaStateLabel(state: string | null): string {
  if (!state) return '没有主图'
  return ({ localized: '已本地化', pending: '未本地化', failed: '本地化失败', blocked: '已拒绝', missing: '文件缺失' } as Record<string, string>)[state] || state
}
function formatTime(ms: number): string {
  const at = new Date(ms)
  return `${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}
function specText(spec: Array<{ name: string; value: string }>): string {
  if (!spec.length) return '单规格（列表页拿不到 SKU，待补）'
  return spec.map(part => `${part.name}:${part.value}`).join(' / ')
}
/** 分 → 元字符串（编辑框里显示的是元，保存时再转回分；绝不用浮点存金额）。 */
function minorToYuan(minor: number | null): string {
  return minor == null ? '' : (minor / 100).toFixed(2)
}
function yuanToMinor(text: string): number | null {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 100)
}

async function loadLocalProducts(): Promise<void> {
  if (props.mode !== 'products') return
  const result = await window.shopilot.products.library.list({ limit: 100 })
  if (!result.ok) { ws.toast('读取本地商品失败：' + result.error.message, 'error'); return }
  const data = result.data as { rows?: LocalRow[]; total?: number } | undefined
  localRows.value = data?.rows ?? []
  localTotal.value = data?.total ?? 0
}

/**
 * 拉取详情：去商品详情页读**真正的商品图与规格**。
 *
 * 为什么需要这一步：列表页每行只有一张缩略图，微信实测是 **SVG**（本地化会如实拒绝）；
 * 详情页才是 WebP 真图。所以"另存为本地商品"之前先拉一次详情，图片本地化才有意义。
 */
async function collectDetail(row: ProductRow): Promise<void> {
  busy.value = true
  try {
    const result = await window.shopilot.products.detail.collect({ storeId: row.storeId, platformProductId: row.platformProductId })
    if (!result.ok) { ws.toast('拉取详情失败：' + result.error.message, 'error'); return }
    const data = result.data as { status: string; safeMessage: string; imageCount: number; specNames: string[] } | undefined
    const ok = data?.status === 'SUCCEEDED'
    ws.toast(data?.safeMessage || (ok ? '已拉取详情' : '没能拉到详情'), ok ? 'success' : 'error')
    await loadProducts()
  } finally {
    busy.value = false
  }
}

/**
 * 发布预检（M3）：算清楚"能不能发、要让人看什么、会不会重复发"。
 *
 * 预检**不写平台、不开页面**，只产出台账与那张字段级 diff 表；
 * 真正打开页面是用户看完清单之后的事（`openPublishPage`），而且**永远不点提交**。
 */
async function runPreflight(row: LocalRow): Promise<void> {
  const online = ws.stores.filter(store => store.status === 'online')
  if (!online.length) { ws.toast('没有在线店铺，先登录要发布的店铺', 'error'); return }
  busy.value = true
  try {
    const result = await window.shopilot.products.publish.preflight({ productId: row.id, storeIds: online.map(store => store.id) })
    if (!result.ok) { ws.toast('发布预检失败：' + result.error.message, 'error'); return }
    const data = result.data as { jobId: string | null; itemId: string | null; precheck: PublishPrecheck | null } | undefined
    if (!data?.precheck) { ws.toast('预检没有返回结果', 'error'); return }
    const store = online.find(item => item.id === data.precheck!.storeId)
    preflight.value = { productId: row.id, itemId: data.itemId, storeName: store?.name ?? '目标店铺', precheck: data.precheck }
    ws.toast(data.precheck.summary, data.precheck.verdict === 'blocked' ? 'error' : 'success')
  } finally {
    busy.value = false
  }
}

/** 打开平台发布页（**只打开，不代填不提交**）：页面交给用户，应用停在人工交接点。 */
async function openPublishPage(fill: boolean): Promise<void> {
  const state = preflight.value
  if (!state?.itemId) { ws.toast('这条发布项还没有台账记录，请重新预检', 'error'); return }
  busy.value = true
  try {
    const result = await window.shopilot.products.publish.open({ itemId: state.itemId, fill })
    if (!result.ok) { ws.toast('打开发布页失败：' + result.error.message, 'error'); return }
    const data = result.data as { state: string; tier: string; safeMessage: string } | undefined
    ws.toast(data?.safeMessage || '已打开发布页', data?.state === 'awaiting_human' ? 'success' : 'error')
  } finally {
    busy.value = false
  }
}

/**
 * 开人工确认门禁：**走任务引擎的 waitForUserConfirmation**（方案 §7.4）。
 *
 * 门禁只负责"等人"，超时**不自动提交也不自动放弃**（可过夜）。任务引擎里
 * 只有一个「等确认」步骤，没有任何点击/填写副作用步骤。
 */
async function openGate(): Promise<void> {
  const state = preflight.value
  if (!state?.itemId) { ws.toast('请先做发布预检', 'error'); return }
  busy.value = true
  try {
    const result = await window.shopilot.products.publish.openGate({ itemId: state.itemId })
    if (!result.ok) { ws.toast('开门禁失败：' + result.error.message, 'error'); return }
    const data = result.data as { ok: boolean; safeMessage: string } | undefined
    ws.toast(data?.safeMessage || '已开人工确认门禁', data?.ok ? 'success' : 'error')
  } finally {
    busy.value = false
  }
}

/** 用户在平台上自己点完提交后，回来告诉我们 —— 然后进只读回读（应用不会去点提交）。 */
async function confirmSubmitted(approved: boolean): Promise<void> {
  const state = preflight.value
  if (!state?.itemId) { ws.toast('请先做发布预检', 'error'); return }
  busy.value = true
  try {
    const result = await window.shopilot.products.publish.confirm({ itemId: state.itemId, approved })
    if (!result.ok) { ws.toast('操作失败：' + result.error.message, 'error'); return }
    const data = result.data as { state: string; safeMessage: string } | undefined
    ws.toast(data?.safeMessage || '已记录', 'success')
    if (approved) {
      const verify = await window.shopilot.products.publish.verify({ itemId: state.itemId })
      const v = verify.ok ? verify.data as { state: string; safeMessage: string } : null
      ws.toast(v ? `回读：${v.safeMessage}` : '回读失败', v?.state === 'confirmed' ? 'success' : 'error')
    }
  } finally {
    busy.value = false
  }
}

/**
 * 回读"用户实际填的值"（M4，方案 §7.5）：**只读页面**产出建议，应用不自动改本地。
 *
 * 落库只能逐条点「接受」——这是方案里"不自动改，避免'这次特批'变成默认值"的落点。
 */
async function runReadback(): Promise<void> {
  const state = preflight.value
  if (!state?.itemId) { ws.toast('请先做发布预检', 'error'); return }
  busy.value = true
  try {
    const result = await window.shopilot.products.publish.readback({ itemId: state.itemId })
    if (!result.ok) { ws.toast('回读失败：' + result.error.message, 'error'); return }
    const data = result.data as { ok: boolean; suggestions: ReadbackSuggestion[]; safeMessage: string; readFields: string[]; missingFields: string[] } | undefined
    if (!data?.ok) { ws.toast(data?.safeMessage || '回读没成功', 'error'); return }
    readback.value = { itemId: state.itemId, suggestions: data.suggestions, readFields: data.readFields, missingFields: data.missingFields }
    // ⚠️ **直接写模块级缓存，不能依赖 watch**（2026-10-02 真机实测）：
    // 回读会打开店铺页面 → 应用切到「店铺工作台」→ 本组件**卸载** → Vue 会**停止它的所有 watch**，
    // 而 IPC 是稍后才 resolve 的 —— 于是上面这行赋值发生在一个**已卸载**的组件上，
    // watch 永远不触发，缓存永远为空。表现：回读成功、toast 有、回到商品管理却什么都没有。
    readbackCache.current = readback.value
    ws.toast(data.safeMessage, 'success')
  } finally {
    busy.value = false
  }
}

/** 接受一条建议 → 落库（默认值 / 回写本地）。用户不点就什么都不会写。 */
async function acceptSuggestion(item: ReadbackSuggestion): Promise<void> {
  const state = readback.value
  if (!state) return
  busy.value = true
  try {
    const result = await window.shopilot.products.publish.acceptSuggestion({
      itemId: state.itemId, field: item.field,
      kind: item.kind === 'suggest_default' ? 'suggest_default' : 'suggest_writeback'
    })
    if (!result.ok) { ws.toast('接受失败：' + result.error.message, 'error'); return }
    ws.toast((result.data as { safeMessage?: string } | undefined)?.safeMessage || '已处理', 'success')
    // 处理过的条目从列表里移掉（避免重复点）
    readback.value = { ...state, suggestions: state.suggestions.filter(row => row.field !== item.field) }
    await loadLocalProducts()
  } finally {
    busy.value = false
  }
}

function suggestionKindLabel(kind: string): string {
  return ({
    suggest_default: '建议存为默认值', suggest_writeback: '与本地不一致', same: '一致', only_local: '平台上是空的'
  } as Record<string, string>)[kind] || kind
}

/**
 * 建一次批量发布（M5，方案 §7.8）：**全部本地商品 × 全部在线店铺**（规则层判上限）。
 *
 * 这一步**只建台账**：不预检、不开页面、不填字段、不提交。
 * 之后按"当前店铺"逐店往前走 —— 一次只打开一个店铺。
 */
async function createBatch(): Promise<void> {
  const online = ws.stores.filter(store => store.status === 'online')
  if (!localRows.value.length) { ws.toast('还没有本地商品', 'error'); return }
  if (!online.length) { ws.toast('没有在线店铺，先登录要发布的店铺', 'error'); return }
  busy.value = true
  try {
    const result = await window.shopilot.products.publish.batchCreate({
      productIds: localRows.value.slice(0, 20).map(row => row.id),
      storeIds: online.slice(0, 20).map(store => store.id)
    })
    if (!result.ok) { ws.toast('建批量失败：' + result.error.message, 'error'); return }
    const data = result.data as { ok: boolean; batchId: string | null; errors: string[]; progress: BatchProgress } | undefined
    if (!data?.ok) { ws.toast('批量计划被拒绝：' + (data?.errors || []).join('；'), 'error'); return }
    batch.value = { batchId: data.batchId!, progress: data.progress, items: [] }
    ws.toast('已建批量：' + data.progress.summary, 'success')
    await loadBatch()
  } finally {
    busy.value = false
  }
}

/** 读批量进度（**三个数**：已完成 / 待人工 / 失败）。 */
async function loadBatch(): Promise<void> {
  const state = batch.value
  if (!state?.batchId) return
  const result = await window.shopilot.products.publish.batchProgress({ batchId: state.batchId })
  if (!result.ok) return
  const data = result.data as { progress: BatchProgress; items: BatchItem[] } | undefined
  if (data?.progress) batch.value = { ...state, progress: data.progress, items: data.items ?? [] }
}

/**
 * 「处理这家」：把这家店**当前要处理的项**打开发布页（走已验证的 openForHuman 路径，仍然不提交）。
 *
 * 为什么单独一个按钮：批量跑起来之后，人需要能"挑一家现在就看" ——
 * 而不是只能等编排自己轮到它。
 */
async function handleStoreNow(storeId: string): Promise<void> {
  const items = batchItemsOfStore(storeId)
  const target = items.find(item => item.status === 'pending') ?? items.find(item => item.status === 'awaiting_human') ?? items[0]
  if (!target) { ws.toast('这家店没有可处理的项', 'error'); return }
  busy.value = true
  try {
    const result = await window.shopilot.products.publish.open({ itemId: target.id, fill: true })
    if (!result.ok) { ws.toast('打开发布页失败：' + result.error.message, 'error'); return }
    ws.toast((result.data as { safeMessage?: string } | undefined)?.safeMessage || '已打开发布页', 'success')
  } finally {
    busy.value = false
  }
}

/** 「全部暂停」：只把"正在跑"的退回未开始；**已经在等人工的保持等待**（人工交接点不该被冲掉）。 */
async function pauseBatch(): Promise<void> {
  const batchId = batch.value?.batchId
  if (!batchId) { ws.toast('还没有批次可以暂停', 'error'); return }
  busy.value = true
  try {
    const result = await window.shopilot.products.publish.batchAbort({ batchId })
    if (!result.ok) { ws.toast('暂停失败：' + result.error.message, 'error'); return }
    ws.toast((result.data as { safeMessage?: string } | undefined)?.safeMessage || '已暂停', 'success')
    await loadBatch()
  } finally {
    busy.value = false
  }
}

/** 「跳过这家先做下一家」：只跳过该店**还没开始**的项（已在等人工的不动）。 */
async function skipStore(storeId: string): Promise<void> {
  const state = batch.value
  if (!state?.batchId) return
  busy.value = true
  try {
    const result = await window.shopilot.products.publish.batchSkipStore({ batchId: state.batchId, storeId })
    if (!result.ok) { ws.toast('跳过失败：' + result.error.message, 'error'); return }
    ws.toast((result.data as { safeMessage?: string } | undefined)?.safeMessage || '已跳过', 'success')
    await loadBatch()
  } finally {
    busy.value = false
  }
}

/** 该店在批量里的项（用来显示"这家店有几条、什么状态"）。 */
function batchItemsOfStore(storeId: string): BatchItem[] {
  return (batch.value?.items ?? []).filter(row => row.storeId === storeId)
}

function storeNameOf(storeId: string): string {
  return ws.stores.find(store => store.id === storeId)?.name ?? storeId.slice(0, 12)
}

/**
 * 把该店的项按状态汇总成一行文字。
 *
 * 写成函数而不是模板里用 `| JSON.stringify`：Vue 3 **移除了过滤器语法**，
 * 用 `|` 会被 eslint 判成 `vue/no-deprecated-filter`（实测被 lint 抓到）。
 */
function statusCountsText(items: BatchItem[]): string {
  const counts: Record<string, number> = {}
  for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1
  return Object.entries(counts).map(([state, count]) => `${batchStateLabel(state)} ${count}`).join('、') || '—'
}

function batchStateLabel(state: string): string {
  return ({
    pending: '未开始', running: '进行中', awaiting_human: '待人工', confirmed: '已完成',
    needs_review: '待核对', failed: '失败', skipped: '已跳过', discarded: '已放弃'
  } as Record<string, string>)[state] || state
}

/**
 * 图片本地化队列与保留策略（方案 §5.9）。
 *
 * `scan` 只算、`run` 才下载；`orphans` **只判定不删**，`cleanup` 是用户点了确认才删。
 * 队列扫描会如实说明"哪些不该再试"（被安全规则拒绝的、失败超上限的）—— 不反复重试。
 */
async function scanMediaQueue(): Promise<void> {
  busy.value = true
  try {
    const result = await window.shopilot.products.library.queueScan({ maxItems: 200 })
    if (!result.ok) { ws.toast('扫描失败：' + result.error.message, 'error'); return }
    const data = result.data as { items: Array<{ role: string; shouldAttempt: boolean; reason: string | null }>; summary: string; candidates: number } | undefined
    mediaQueue.value = { summary: data?.summary ?? '', items: data?.items ?? [], orphans: mediaQueue.value?.orphans ?? null }
    ws.toast(data?.summary || '扫描完成', 'success')
  } finally {
    busy.value = false
  }
}

async function runMediaQueue(): Promise<void> {
  busy.value = true
  try {
    const result = await window.shopilot.products.library.queueRun({ maxItems: 20 })
    if (!result.ok) { ws.toast('跑队列失败：' + result.error.message, 'error'); return }
    ws.toast((result.data as { summary?: string } | undefined)?.summary || '队列跑完', 'success')
    await Promise.all([scanMediaQueue(), loadLocalProducts()])
  } finally {
    busy.value = false
  }
}

/** 查孤儿（只判定）：把"将删除 N 个文件/共多少 MB"摆给用户看，**不删**。 */
async function scanOrphans(): Promise<void> {
  busy.value = true
  try {
    const result = await window.shopilot.products.library.orphans()
    if (!result.ok) { ws.toast('查询失败：' + result.error.message, 'error'); return }
    const data = result.data as { orphans: unknown[]; keepCount: number; orphanBytes: number; summary: string } | undefined
    mediaQueue.value = { summary: mediaQueue.value?.summary ?? '', items: mediaQueue.value?.items ?? [], orphans: data ?? null }
    ws.toast(data?.summary || '查询完成', 'success')
  } finally {
    busy.value = false
  }
}

/** 清理孤儿：**用户点了确认才删**（且只删我们自己的目录里、不在表里的文件）。 */
async function cleanupOrphans(): Promise<void> {
  const pending = mediaQueue.value?.orphans
  if (!pending?.orphans?.length) { ws.toast('没有可清理的孤儿文件', 'error'); return }
  busy.value = true
  try {
    const result = await window.shopilot.products.library.cleanupOrphans()
    if (!result.ok) { ws.toast('清理失败：' + result.error.message, 'error'); return }
    ws.toast((result.data as { summary?: string } | undefined)?.summary || '清理完成', 'success')
    await scanOrphans()
  } finally {
    busy.value = false
  }
}

function fieldActionLabel(action: string): string {
  return ({
    fill: '填入', fill_suggest: '建议填入（待你确认）', keep_platform: '保留平台值',
    reuse_last: '用上次选择', skip_unsupported: '跳过（平台不支持）', leave_empty: '不填（本地也没有）'
  } as Record<string, string>)[action] || action
}

/** 另存为本地商品（**用户点了才执行**；服务里没有自动合并的路径）。 */async function saveAsLocal(row: ProductRow): Promise<void> {
  busy.value = true
  try {
    const result = await window.shopilot.products.library.saveAsLocal({
      platform: row.platform, storeId: row.storeId, platformProductId: row.platformProductId
    })
    if (!result.ok) { ws.toast('另存为失败：' + result.error.message, 'error'); return }
    const issues = (result.data as { issues?: DraftIssue[] } | undefined)?.issues ?? []
    const blockers = issues.filter(issue => issue.level === 'blocker').length
    ws.toast(blockers ? `已建出本地商品，但有 ${blockers} 项待补（如缺主图/规格）` : '已建出本地商品', blockers ? 'error' : 'success')
    await Promise.all([loadProducts(), loadLocalProducts()])
  } finally {
    busy.value = false
  }
}

async function openEditor(row: LocalRow): Promise<void> {
  const result = await window.shopilot.products.library.get(row.id)
  if (!result.ok) { ws.toast('打开失败：' + result.error.message, 'error'); return }
  const data = result.data as { draft: { title: string; variants: Array<{ spec: Array<{ name: string; value: string }>; priceMinor: number | null; stock: number | null }> } }
  editing.value = {
    productId: row.id,
    title: data.draft.title,
    variants: data.draft.variants.map(variant => ({
      spec: variant.spec ?? [],
      priceYuan: minorToYuan(variant.priceMinor),
      stockText: variant.stock == null ? '' : String(variant.stock)
    }))
  }
  editorIssues.value = []
}

async function saveEditor(): Promise<void> {
  const state = editing.value
  if (!state) return
  busy.value = true
  try {
    // 读回完整草稿再改（只提交被编辑的字段，避免把没显示的字段清空）
    const current = await window.shopilot.products.library.get(state.productId)
    if (!current.ok) { ws.toast('保存失败：' + current.error.message, 'error'); return }
    const draft = (current.data as { draft: Record<string, unknown> }).draft
    const variants = (draft.variants as Array<Record<string, unknown>>).map((variant, index) => ({
      ...variant,
      priceMinor: yuanToMinor(state.variants[index]?.priceYuan ?? ''),
      stock: state.variants[index]?.stockText?.trim() ? Number(state.variants[index].stockText) : null
    }))
    const result = await window.shopilot.products.library.save({
      productId: state.productId, draft: { ...draft, title: state.title, variants }
    })
    if (!result.ok) { ws.toast('保存失败：' + result.error.message, 'error'); return }
    editorIssues.value = ((result.data as { issues?: DraftIssue[] } | undefined)?.issues) ?? []
    ws.toast(editorIssues.value.some(i => i.level === 'blocker') ? '已保存（仍有待补项）' : '已保存', editorIssues.value.some(i => i.level === 'blocker') ? 'error' : 'success')
    await loadLocalProducts()
  } finally {
    busy.value = false
  }
}

/** 下载图片到本地：主进程做 SSRF/体积/格式校验与 sha256 去重，这里只显示如实结果。 */
async function localizeMedia(row: LocalRow): Promise<void> {
  busy.value = true
  try {
    const result = await window.shopilot.products.library.localizeMedia(row.id)
    if (!result.ok) { ws.toast('下载图片失败：' + result.error.message, 'error'); return }
    const data = result.data as { total: number; localized: number; deduped: number; failed: number; blocked: number; details?: Array<{ reason: string | null }> } | undefined
    const reasons = [...new Set((data?.details ?? []).map(item => item.reason).filter(Boolean))]
    const summary = `共 ${data?.total ?? 0} 张：本地化 ${data?.localized ?? 0}、重复 ${data?.deduped ?? 0}、失败 ${data?.failed ?? 0}、拒绝 ${data?.blocked ?? 0}`
    ws.toast(reasons.length ? `${summary}（原因：${reasons.join('、')}）` : summary, (data?.failed || data?.blocked) ? 'error' : 'success')
    await loadLocalProducts()
  } finally {
    busy.value = false
  }
}

async function removeLocal(row: LocalRow): Promise<void> {
  busy.value = true
  try {
    const result = await window.shopilot.products.library.remove(row.id)
    if (!result.ok) { ws.toast('删除失败：' + result.error.message, 'error'); return }
    ws.toast('已删除（软删，发布台账保留）', 'success')
    await Promise.all([loadProducts(), loadLocalProducts()])
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.unified-page{min-width:0;min-height:0;height:100%;overflow:auto;padding:22px 24px 32px;color:var(--dash-text)}.unified-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:18px}.unified-page-head h1{margin:5px 0 7px;font-size:25px}.unified-page-head p{margin:0;color:var(--dash-text-muted);font-size:12px}.unified-button{min-height:34px;padding:0 13px;border:1px solid var(--dash-border);border-radius:9px;background:#ffffff;color:var(--dash-text-soft);cursor:pointer}.unified-button:hover,.unified-button:focus-visible{border-color:rgba(151,120,255,.7);color:var(--dash-text);outline:2px solid rgba(151,120,255,.35);outline-offset:1px}.unified-button.primary{border-color:#5b3df5;background:#6d4aff;color:#ffffff}.unified-alert{display:flex;flex-direction:column;gap:5px;padding:14px 16px;margin-bottom:14px;border:1px solid rgba(76,157,255,.23);border-radius:11px;background:rgba(33,91,158,.12);color:var(--dash-text-soft);font-size:12px}.unified-alert strong{color:#1d4ed8}.unified-state,.unified-empty{display:flex;min-height:150px;align-items:center;justify-content:center;gap:12px;flex-direction:column;border:1px dashed var(--dash-border);border-radius:12px;color:var(--dash-text-muted)}.inline-link{border:0;background:transparent;color:#7c5cff;cursor:pointer}.product-store-list{display:flex;flex-direction:column;gap:10px}.product-store-card{display:flex;align-items:center;gap:12px;padding:14px;border:1px solid var(--dash-border);border-radius:12px;background:#ffffff}.product-store-copy{display:flex;min-width:0;flex:1;flex-direction:column;gap:5px}.product-store-copy span{overflow:hidden;color:var(--dash-text-muted);font-size:11px;text-overflow:ellipsis;white-space:nowrap}.unified-status{display:flex;align-items:center;gap:5px;color:var(--dash-text-muted);font-size:10px}.unified-status i,.available-pill i{width:7px;height:7px;border-radius:50%;background:#98a2b3}.unified-status.online,.available-pill{color:#027a48}.unified-status.online i,.available-pill i{background:#12b76a}.unified-status.warning{color:#b54708}.unified-status.warning i{background:#f9f0eb}.ai-assistant-card{display:flex;align-items:center;gap:20px;padding:20px;margin-bottom:14px;border:1px solid rgba(139,92,246,.34);border-radius:15px;background:radial-gradient(circle at 15% 40%,rgba(107,70,214,.22),transparent 32%),#ecedee;box-shadow:inset 0 0 32px rgba(123,81,241,.06)}.ai-orb{position:relative;display:grid;width:68px;height:68px;flex:0 0 auto;place-items:center;border:1px solid rgba(167,134,255,.7);border-radius:50%;background:radial-gradient(circle at 50% 42%,#eff0f4,#ecedef 70%);box-shadow:0 0 28px rgba(135,90,255,.35)}.ai-orb img{width:68px;height:68px;object-fit:contain;position:relative;z-index:1}.ai-orb:before{content:'';position:absolute;width:28px;height:17px;border-radius:50%;background:#ebeced;box-shadow:0 0 0 4px rgba(93,179,255,.13)}.ai-orb i{position:absolute;z-index:1;width:5px;height:5px;border-radius:50%;background:#43bdff}.ai-orb i:first-child{transform:translateX(-8px)}.ai-orb i:last-child{transform:translateX(8px)}.ai-assistant-copy{min-width:0;flex:1}.ai-assistant-copy h2{margin:6px 0;font-size:18px}.ai-assistant-copy p{max-width:680px;margin:0;color:var(--dash-text-muted);font-size:11px;line-height:1.6}.available-pill{display:inline-flex;align-items:center;gap:5px;font-size:10px}.app-card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}.app-card{display:flex;min-height:96px;align-items:center;gap:12px;padding:15px;border:1px solid var(--dash-border);border-radius:12px;background:#ecedef}.app-card-action{cursor:pointer;transition:transform .15s,border-color .15s,background .15s}.app-card-action:hover,.app-card-action:focus-visible{transform:translateY(-1px);border-color:var(--dash-border-strong);background:#edeef0;outline:2px solid rgba(151,120,255,.3);outline-offset:1px}.app-card>div{min-width:0;flex:1}.app-card h2{margin:0 0 5px;font-size:13px}.app-card p{margin:0;color:var(--dash-text-muted);font-size:10px;line-height:1.5}.app-card-icon{display:grid;width:38px;height:38px;flex:0 0 auto;place-items:center;border-radius:10px;background:rgba(117,92,242,.16);color:#5b3df5;font-size:18px}.app-card-icon img{width:22px;height:22px;object-fit:contain}.app-card-icon.purple,.app-card-icon.violet{background:rgba(128,87,245,.2);color:#5b3df5}.app-card-icon.blue{background:rgba(54,140,255,.18);color:#1d4ed8}.app-card-icon.cyan{background:rgba(29,187,240,.16);color:#1d4ed8}.app-card-icon.teal{background:rgba(21,193,168,.16);color:#027a48}.app-card-icon.orange{background:rgba(247,144,76,.16);color:#b54708}.unavailable-pill{flex:0 0 auto;padding:4px 7px;border:1px solid rgba(242,165,87,.18);border-radius:6px;color:#b54708;font-size:9px}.app-card-arrow{display:grid;place-items:center;margin-left:auto;color:#9d8ae2}.app-card-arrow img{width:17px;height:17px;object-fit:contain}.loader{width:18px;height:18px;border:2px solid rgba(163,143,255,.2);border-top-color:#7c5cff;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:880px){.unified-page{padding:16px}.app-card-grid{grid-template-columns:1fr}.product-store-card{flex-wrap:wrap}.product-store-copy{min-width:calc(100% - 60px)}}
/* 商品管理（M1）：同步工具条 + 只读商品表 */
.product-toolbar{display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap}
.product-toolbar-hint{color:var(--dash-text-muted);font-size:11px}
.product-table-wrap{margin-top:18px;border:1px solid var(--dash-border);border-radius:12px;background:#fff;overflow:hidden}
.product-table-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--dash-border)}
.product-table-head h2{margin:0;font-size:14px}
.product-table-head span{color:var(--dash-text-muted);font-size:11px}
.product-empty-hint{color:var(--dash-text-muted);font-size:11px}
.product-table{width:100%;border-collapse:collapse;font-size:12px}
.product-table th{padding:9px 12px;border-bottom:1px solid var(--dash-border);color:var(--dash-text-muted);font-size:11px;font-weight:500;text-align:left;white-space:nowrap}
.product-table td{padding:10px 12px;border-bottom:1px solid rgba(0,0,0,.05);vertical-align:top}
.product-table tr:last-child td{border-bottom:0}
.product-table small{display:block;margin-top:3px;color:var(--dash-text-muted);font-size:10px}
.product-platform{font-weight:500}
.product-title{display:block;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.product-more{margin:0;padding:10px 16px;color:var(--dash-text-muted);font-size:11px}
/* 本地商品库（M2）：归并按钮 / 编辑抽屉 / 分级校验 */
.product-orphan{color:var(--dash-text-muted)}
.product-actions{display:flex;gap:6px;flex-wrap:wrap}
.unified-button.ghost{min-height:26px;padding:0 9px;font-size:11px}.button-icon{width:15px;height:15px;object-fit:contain;vertical-align:-3px;margin-right:5px}
.product-drawer{position:fixed;top:0;right:0;z-index:40;display:flex;flex-direction:column;gap:12px;width:420px;height:100%;padding:18px;overflow:auto;border-left:1px solid var(--dash-border);background:#fff;box-shadow:-12px 0 32px rgba(16,24,40,.12)}
.product-drawer-head{display:flex;align-items:center;justify-content:space-between}
.product-field{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dash-text-muted)}
.product-field input{min-height:30px;padding:0 9px;border:1px solid var(--dash-border);border-radius:8px;font-size:12px;color:var(--dash-text)}
.product-field input:disabled{background:#f7f8fa;color:var(--dash-text-muted)}
.product-field-row{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:8px}
.product-issues{display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--dash-border);border-radius:10px;background:#fbfcfe;font-size:11px}
.product-issues b{margin-right:6px}
.product-issues small{display:block;margin-top:2px;color:var(--dash-text-muted)}
.issue-blocker b{color:#b42318}.issue-warning b{color:#b54708}.issue-info b{color:#175cd3}
.product-drawer-actions{display:flex;gap:8px}
</style>
