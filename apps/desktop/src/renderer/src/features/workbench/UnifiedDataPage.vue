<template>
  <section :class="['unified-page unified-data-page', { 'invoice-center-page': mode === 'invoices' }]" :data-test="`unified-${mode}-page`">
    <header class="unified-page-head">
      <div><span class="dashboard-eyebrow">WORKSPACE / DATA</span><h1>{{ title }}</h1><p>{{ subtitle }}</p></div>
      <div class="unified-page-actions"><button v-if="mode !== 'invoices'" type="button" class="unified-button ghost" :disabled="loading" @click="load"><img class="button-icon" :src="dataSyncSheetIcon" alt="" />{{ loading ? '读取中…' : '刷新数据' }}</button><template v-if="mode === 'invoices'">
          <!-- ⚠ 验收脚本按 data-test="invoice-export" 定位导出按钮（invoice-license-local-verify.js 第 13 步），
               改这段工具栏必须保留它。
               顺带改正一处 bug：原来的 v-if 写反了（mode !== 'invoices'），于是「数据分析」页上挂着一个
               "导出待开票 CSV"按钮——导出/采集只属于发票中心。 -->
          <button type="button" class="unified-button ghost" data-test="invoice-export" :disabled="!invoiceRows.length" :title="exportScopeTitle" @click="openExportConfirm"><img class="button-icon" :src="dataExportSheetIcon" alt="" />{{ exportScopeLabel }}</button>
          <button type="button" class="unified-button primary" data-test="invoice-collect" :disabled="collecting || entityCollecting" @click="collectInvoices"><img class="button-icon" :src="invoiceIcon" alt="" />{{ collecting ? '创建任务中…' : '采集发票数据' }}</button>
        </template></div>
    </header>
    <div class="unified-route-tabs" role="tablist" aria-label="数据页面"><button v-for="tab in tabs" :key="tab.key" type="button" :class="{ active: mode === tab.key }" @click="emit('change-mode', tab.key)">{{ tab.label }}</button></div>
    <div v-if="errorMessage" class="unified-alert error" role="alert">{{ errorMessage }} <button type="button" @click="load"><img class="button-icon" :src="dataRetryIcon" alt="" />重试</button></div>
    <div v-if="loading" class="unified-state"><span class="loader"></span>正在读取本机数据…</div>
    <template v-else>
      <div v-if="mode !== 'orders' && mode !== 'invoices'" class="unified-stat-grid">
        <article v-for="card in totalCards" :key="card.label" class="unified-stat-card"><span>{{ card.label }}</span><strong>{{ card.value }}</strong><small>{{ card.note }}</small></article>
      </div>

      <div v-if="mode === 'analytics'" class="unified-data-grid">
        <section class="unified-card data-wide"><div class="unified-card-head"><div><h2>经营指标</h2><span>每店每指标取本机最新快照</span></div><button type="button" class="unified-button ghost" :disabled="collecting" @click="collectBusiness"><img class="button-icon" :src="dataAnalyticsSheetIcon" alt="" />{{ collecting ? '创建任务中…' : '采集经营数据' }}</button></div><div v-if="metricRows.length" class="unified-table-wrap"><table class="unified-table"><thead><tr><th>店铺</th><th>平台</th><th v-for="metric in bizMetrics" :key="metric.key">{{ metric.label }}</th><th>采集时间</th></tr></thead><tbody><tr v-for="row in metricRows" :key="row.storeId"><td>{{ row.storeName }}</td><td>{{ row.platform }}</td><td v-for="metric in bizMetrics" :key="metric.key">{{ formatValue(row.values[metric.key], metric.key) }}<em v-if="row.manual[metric.key]">手动</em></td><td>{{ row.lastAt ? formatTime(row.lastAt) : '—' }}</td></tr></tbody></table></div><div v-else class="unified-empty compact">暂无经营快照。请在店铺浏览器中采集或运行读取任务。</div></section>
        <section class="unified-card"><div class="unified-card-head"><div><h2>指标快照</h2><span>{{ snapshotRows.length }} 条本机记录</span></div></div><div v-if="snapshotRows.length" class="snapshot-list"><div v-for="snapshot in snapshotRows.slice(0, 12)" :key="snapshot.storeId + snapshot.metric + snapshot.capturedAt" class="snapshot-row"><div><strong>{{ snapshot.metric }}</strong><small>{{ snapshot.storeName || snapshot.storeId }}</small></div><span>{{ displayValue(snapshot.value) }}</span></div></div><div v-else class="unified-empty compact">暂无快照</div></section>
      </div>

      <SalesMetricsMonitorCard v-if="mode === 'analytics'" @open-store="emit('open-store', $event)" />

      <section v-else-if="mode === 'orders'" class="unified-card"><div class="unified-card-head"><div><h2>订单明细</h2><span>来自最近一次订单整表快照，不伪造实时数据</span></div><button type="button" class="unified-button primary" :disabled="collecting" @click="collectOrders"><img class="button-icon" :src="dataOrdersSheetIcon" alt="" />{{ collecting ? '创建任务中…' : '采集订单明细' }}</button></div><div v-if="orderStores.length" class="order-store-list"><article v-for="store in orderStores" :key="store.storeId" class="order-store-block"><div class="order-store-head"><div><strong>{{ store.storeName }}</strong><span>{{ store.platform }} · {{ store.supported ? '已登记页面档案' : '尚未实测' }}</span></div><span>{{ store.rows?.length || 0 }} 行</span></div><div v-if="store.error" class="unified-alert error">最近一次采集失败：{{ store.error.message || store.error.code }}</div><div v-if="store.rows?.length" class="unified-table-wrap"><table class="unified-table"><thead><tr><th v-for="column in store.columns || []" :key="column.key">{{ column.label }}</th></tr></thead><tbody><tr v-for="(row,index) in store.rows.slice(0, 30)" :key="index"><td v-for="column in store.columns || []" :key="column.key">{{ row.cells?.[column.key] || '—' }}</td></tr></tbody></table></div><div v-else class="unified-empty compact">{{ store.supported ? '暂无订单快照' : '该平台订单页面尚未实测，系统不会猜测选择器' }}</div></article></div><div v-else class="unified-empty">暂无订单数据。点击“采集订单明细”后，任务结果会回到这里。</div></section>

      <template v-else>
        <div class="inv-shell">
          <!-- ============ 左栏：开票主体分账 ============
               发票按营业执照开，不按平台账号开；同一个执照下常挂好几家店，
               只看"店铺"会把一个主体的票拆成几份，对不上账。
               契约（invoice-license-local-verify.js 第 4/5/6/8/10/13 步）：
               本栏必须**恰好 4 个** .inv-lic-chip（全部 / 各主体… / 未填写营业执照，顺序不变），
               文本里要带「家数」，选中态恰好一个 .on。加筛选胶囊请另起 class。 -->
          <aside class="inv-rail">
            <div class="inv-rail-head">
              <b>开票主体</b>
              <span>发票按营业执照分账。同一执照下的多家店合并计算。</span>
            </div>
            <div class="inv-lic-bar" data-test="invoice-license-bar">
              <button
                type="button" class="inv-lic-chip" :class="{ on: !activeLicense }"
                data-test="invoice-license-all" title="不加主体筛选，看全部店铺"
                @click="invoiceLicense = ''"
              >
                <span class="inv-lic-name">全部主体</span>
                <span class="inv-lic-figs"><i>{{ licenseSummary.storeCount }} 家</i><template v-if="licenseSummary.pendingCount"> · {{ licenseSummary.pendingCount }} 条 · {{ licenseSummary.amountText }}</template></span>
                <span class="inv-lic-share" aria-hidden="true"><i :style="{ width: licenseShare(licenseSummary.pendingCount) }"></i></span>
              </button>
              <button
                v-for="l in licenseSummary.items" :key="l.key" type="button"
                class="inv-lic-chip" :class="{ on: activeLicense === l.key, none: l.key === NO_LICENSE_KEY }"
                :data-test="'invoice-license-' + l.key"
                :title="l.key === NO_LICENSE_KEY ? '这些店铺还没填营业执照——点店铺行上的主体标签手动补，或点下方「获取主体营业执照」让软件去平台后台读回来' : (l.no ? '统一社会信用代码：' + l.no : '只填了主体名称，没有统一社会信用代码')"
                @click="invoiceLicense = activeLicense === l.key ? '' : l.key"
              >
                <span class="inv-lic-name">{{ l.label || '未填写营业执照' }}</span>
                <span v-if="l.no" class="inv-lic-no">{{ l.no }}</span>
                <span class="inv-lic-figs"><i>{{ l.storeCount }} 家</i><template v-if="l.pendingCount"> · {{ l.pendingCount }} 条 · {{ l.amountText }}</template><template v-else> · 无待开票</template></span>
                <span class="inv-lic-share" aria-hidden="true"><i :style="{ width: licenseShare(l.pendingCount) }"></i></span>
              </button>
            </div>
            <button
              type="button" class="unified-button ghost inv-rail-btn" data-test="invoice-entity-collect"
              :disabled="collecting || entityCollecting" @click="collectStoreEntities"
              :title="'去平台后台把本店自己的主体（营业执照名称 / 统一社会信用代码）读回来，填入还空着的营业执照字段；与已填不一致时不覆盖，只如实报出来。仅对已实测过主体信息页的平台生效（当前：' + entitySupportedPlatforms.join('、') + '）'"
            ><img class="button-icon" :src="dataLicenseEditSheetIcon" alt="" />{{ entityCollecting ? '获取中…' : '获取主体营业执照' }}</button>
            <p v-if="entityCollecting && entityProgress" class="inv-rail-tip" data-test="invoice-entity-progress">
              正在读取主体信息：<b>{{ entityProgress.done }}/{{ entityProgress.total }}</b> 家已完成<template v-if="entityProgress.waiting.length">，还在等 <b>{{ entityProgress.waiting.join('、') }}</b></template>——每家最多等 1 分钟，超时会如实标出来
            </p>
            <p v-else class="inv-rail-tip">去平台后台读回主体：只填空缺、不覆盖你已填的值；不一致时只报告。</p>
          </aside>

          <div class="inv-main">
        <!-- 概览一行（2026-10-15 精简）：原「采集状态条 + 4 张 KPI 卡 + 自动更新行 + 两条说明段落」
             合并为一条——屏上只留数字与必要警告，完整解释收进各 chip 的 title。
             红线不变：采集失败与"确实没有发票"必须分得开（登录失效/本次没采到/未解析都在这里如实出现）。
             契约（发票中心验收第 4/5 步）：本条内 .dc-num 必须**恰好 3 个**、依次是
             「待开票条数 / 可开金额合计 / 有票待开的店铺数」——脚本按这三个数验证主体筛选联动。 -->
        <div class="inv-brief" data-test="invoice-totals">
          <div class="inv-brief-nums">
            <span>待开票 <b class="dc-num">{{ invoiceTotal.count }}</b> 条</span>
            <span>可开 <b class="dc-num">{{ invoiceTotal.amountText }}</b></span>
            <span>有票待开 <b class="dc-num">{{ invoiceTotal.stores }}</b> 家</span>
            <em class="inv-brief-scope">本口径内共 {{ subjectInvoiceRows.length }} 家店<template v-if="activeLicense"> · 全部主体共 {{ invoiceGrandTotal.count }} 条</template></em>
          </div>
          <div class="inv-brief-status" data-test="invoice-status">
            <span class="inv-status-dot" :class="{ on: invoiceCoverage.ok > 0 }" aria-hidden="true"></span>
            <span>最近采集 <b>{{ invoiceCoverage.lastAt ? formatTime(invoiceCoverage.lastAt) : '—' }}</b> · 覆盖 <b>{{ invoiceCoverage.ok }}/{{ invoiceCoverage.total }}</b> 家店</span>
            <button v-if="invoiceCoverage.loginRequired" type="button" class="inv-chip err" data-test="invoice-status-login" @click="openStoreAdmin(invoiceRows.find(r => r.loginRequired))">
              {{ invoiceCoverage.loginRequired }} 家登录态失效 → 去登录
            </button>
            <button v-if="unlicensedPending.stores" type="button" class="inv-chip warn" data-test="invoice-status-license" @click="invoiceLicense = NO_LICENSE_KEY">
              {{ unlicensedPending.stores }} 家店未填营业执照 → 去补录
            </button>
            <span v-if="invoiceCoverage.notCollected" class="inv-chip warn">{{ invoiceCoverage.notCollected }} 家本次没采到</span>
            <span v-if="invoiceTotal.unparsed" class="inv-chip warn" :title="`有 ${invoiceTotal.unparsed} 条金额无法解析为数字（页面写的是「—」或空）——它们未计入可开金额合计，条数照常计。`">{{ invoiceTotal.unparsed }} 条金额未解析</span>
            <span v-if="invoiceTotal.historical" class="inv-chip" :title="`另有 ${invoiceTotal.historical} 条属「已提交 / 已通过」的方向（各平台的「处理中 / 处理记录」这类）——商家在那边没有待办，不计入待开票条数与金额合计；记录照常列在各店铺下方并标「无需操作」。`">{{ invoiceTotal.historical }} 条无需操作</span>
            <span v-if="invoiceRisk.late" class="inv-chip err" :title="invoiceRisk.soon ? `另有 ${invoiceRisk.soon} 条 3 日内到期` : '暂无临期'">{{ invoiceRisk.late }} 条已逾期</span>
            <span v-else-if="invoiceRisk.soon" class="inv-chip warn" :title="`${invoiceRisk.soon} 条 3 日内到期`">{{ invoiceRisk.soon }} 条临期</span>
          </div>
          <div class="inv-brief-side">
            <!-- 自动更新内联开关：**必须同时看两件事**——任务上挂没挂周期、自动采集总开关有没有打开。
                 只看任务周期会把"挂着但永远不会触发"显示成"已启用"（2026-10-15 审查确认的假状态）。 -->
            <span class="inv-brief-schedule" data-test="invoice-schedule" :data-active="invoiceSchedule.active ? '1' : '0'">
              <button
                type="button" class="inv-chip"
                :class="{ on: invoiceSchedule.active, warn: !invoiceSchedule.active && invoiceSchedule.enabled > 0 && !invoiceSchedule.autoEnabled }"
                data-test="invoice-schedule-toggle" :disabled="collecting"
                :title="invoiceSchedule.active
                  ? `每 3 小时自动更新已启用（${invoiceSchedule.enabled}/${invoiceSchedule.total} 家挂着周期）——点这里关闭`
                  : (invoiceSchedule.enabled > 0 && !invoiceSchedule.autoEnabled
                    ? '已挂周期但不会自动跑——自动采集总开关是关的；点这里一并打开'
                    : '点这里开启每 3 小时自动更新（会连同自动采集总开关一并打开）')"
                @click="toggleInvoiceSchedule(!invoiceSchedule.active)"
              >
                <img class="button-icon" :src="dataInvoiceScheduleSheetIcon" alt="" />自动更新 · {{ invoiceSchedule.active ? '开' : (invoiceSchedule.enabled > 0 && !invoiceSchedule.autoEnabled ? '不自动跑' : '关') }}
              </button>
            </span>
            <button type="button" class="inv-brief-refresh" data-test="invoice-refresh" :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新' }}</button>
          </div>
        </div>

        <!-- （2026-10-15 精简）：KPI 卡、自动更新行与两条说明段落已并入上方「概览一行」——
             金额未解析 / 无需操作 / 逾期的完整解释收进了各自 chip 的 title，屏上只留摘要。
             数字口径与筛选联动不变（原契约「.dc-num 依次是 条数/金额/店铺数」已迁到 .inv-brief）。 -->

        <!-- 工具栏：采集/导出已上移到页头，这里只放"看哪一份数据"的控件。
             此前 invoiceQuery / invoiceStatusFilter / invoicePlatformFilter / invoicePeriodFilter
             逻辑齐备却**没有任何渲染控件**（恒为默认值，等于死筛选）——本页补上，
             并加一个「按主体」分组视图（申报/交代账直接看它；组下店铺行可点击进入店铺详情）。
             契约：data-test="invoice-export" 在页头，别删。 -->
        <div class="inv-toolbar" data-test="invoice-toolbar">
          <input v-model="invoiceQuery" type="text" class="inv-search" data-test="invoice-search" placeholder="搜索：店铺 / 单号 / 类型 / 抬头 / 税号…" />
          <!-- 四个下拉折叠进「筛选」面板（2026-10-15 精简）：常态只占一个按钮的宽度；
               控件本体与 data-test 原样保留，筛选/排序逻辑与联动不变。 -->
          <button type="button" class="unified-button ghost inv-mini" data-test="invoice-filter-toggle" :aria-expanded="filtersOpen" @click="filtersOpen = !filtersOpen">筛选<template v-if="activeFilterCount"> · {{ activeFilterCount }}</template></button>
          <div v-show="filtersOpen" class="inv-filter-panel" data-test="invoice-filter-panel">
            <select v-model="invoiceStatusFilter" class="inv-select" data-test="invoice-filter-status" aria-label="状态筛选">
              <option value="all">全部状态</option>
              <option value="pending">有待开票</option>
              <option value="processed">有无需操作</option>
              <option value="error">有异常</option>
            </select>
            <select v-model="invoicePlatformFilter" class="inv-select" data-test="invoice-filter-platform" aria-label="平台筛选">
              <option value="">全部平台</option>
              <option v-for="name in invoicePlatformOptions" :key="name" :value="name">{{ name }}</option>
            </select>
            <select v-model="invoicePeriodFilter" class="inv-select" data-test="invoice-filter-period" aria-label="采集时间筛选">
              <option value="all">不限采集时间</option>
              <option value="1">最近 1 天采集</option>
              <option value="7">最近 7 天采集</option>
              <option value="30">最近 30 天采集</option>
            </select>
            <select v-model="invoiceSort" class="inv-select" data-test="invoice-sort" aria-label="排序">
              <option value="none">按平台顺序</option>
              <option value="amountDesc">金额从高到低</option>
              <option value="amountAsc">金额从低到高</option>
            </select>
          </div>
          <div class="inv-seg" data-test="invoice-view-switch" role="tablist" aria-label="视图切换">
            <button type="button" :class="{ on: invoiceView === 'stores' }" data-test="invoice-view-stores" @click="invoiceView = 'stores'">按店铺</button>
            <button type="button" :class="{ on: invoiceView === 'summary' }" data-test="invoice-view-summary" @click="invoiceView = 'summary'">按主体</button>
          </div>
          <span class="inv-toolbar-meta" data-test="invoice-scope-meta">
            口径：<b>{{ invoiceScopeLabel }}</b>
            <template v-if="invoiceView === 'summary'"> · 共 <b>{{ invoiceSubjectGroups.length }}</b> 个开票主体</template>
            <template v-else> · 显示 <b>{{ visibleInvoiceRows.length }}</b> / {{ subjectInvoiceRows.length }} 家店</template>
          </span>
        </div>

        <section class="unified-card">
          <div class="unified-card-head">
            <div>
              <h2>{{ invoiceView === 'summary' ? '按开票主体' : '待开票清单' }}</h2>
              <span>{{ invoiceView === 'summary'
                ? '申报与交代账直接看它：一个主体一块，组下方列出该主体的全部店铺；点店铺行进入店铺详情（金额占比一眼看出票压在哪个公司名下，无需操作的记录不计入）'
                : '只展示平台页面采集到的待办和历史记录（本应用只读，不代提交）' }}</span>
            </div>
          </div>
          <!-- 获取主体营业执照的逐店结果：填了什么、哪不一致、哪个平台取不了——全部照实说，不合并成一句"完成" -->
          <div v-if="entityReport.length" class="inv-entity-report" data-test="invoice-entity-report">
            <div class="inv-entity-report-head">
              <b>获取主体营业执照 · 结果</b>
              <button type="button" class="unified-button ghost inv-mini" @click="entityReport = []">关闭</button>
            </div>
            <div v-for="r in entityReport" :key="r.storeId" class="inv-entity-report-row" :data-test="'invoice-entity-result-' + r.storeId">
              <b>{{ r.storeName || storeNameOf(r.storeId) }}</b>
              <span>{{ entityReportText(r) }}</span>
            </div>
          </div>
          <div v-if="!invoiceData" class="unified-empty" data-test="invoice-load-failed">发票数据没读出来（原因见上方红条）——这不等于"没有发票"，点「刷新数据」重试。</div>
          <div v-else-if="!invoiceRows.length" class="unified-empty">暂无发票记录。采集结果会由本机任务写入数据库。</div>
          <!-- 按主体分组：一个主体一块（含「未填写」那一档，固定排最后）。申报/交代账直接看它；
               组下方列出该主体的**全部**店铺，店铺行可点击进入该店「店铺详情」（工作台浏览器视图）。
               金额占比条用来一眼看出票压在哪个公司名下。口径与 KPI 一致（跟随左侧选中的主体）。 -->
          <div v-else-if="invoiceView === 'summary'" class="inv-summary" data-test="invoice-summary">
            <div v-if="!invoiceSubjectGroups.length" class="unified-empty compact">当前口径下没有可汇总的开票主体。</div>
            <section
              v-for="group in invoiceSubjectGroups" :key="group.key"
              class="inv-subject" :class="{ none: group.key === NO_LICENSE_KEY }"
              :data-test="'invoice-subject-group-' + group.key"
            >
              <div class="inv-subject-head">
                <span class="inv-subject-bar" aria-hidden="true"></span>
                <div class="inv-subject-id">
                  <div class="inv-subject-name">
                    <b>{{ group.label }}</b><em v-if="group.no">{{ group.no }}</em>
                    <span v-if="group.key === NO_LICENSE_KEY" class="inv-chip warn" data-test="'invoice-subject-needs-license-' + group.key">需补录</span>
                  </div>
                  <div class="inv-subject-figs">
                    <span>{{ group.storeCount }} 家店 · 待开票 <b>{{ group.pendingCount }}</b> 条 · 可开 <b class="inv-sum-amount">{{ group.amountText }}</b><template v-if="group.historyCount"> · 无需操作 {{ group.historyCount }} 条</template><template v-if="group.unparsed"> · {{ group.unparsed }} 条未解析</template></span>
                    <span class="inv-sum-bar" role="img" :aria-label="group.shareTitle" :title="group.shareTitle"><i :style="{ width: group.share }"></i></span>
                    <em class="inv-subject-share">{{ group.shareText }}</em>
                  </div>
                </div>
                <div class="inv-subject-actions">
                  <button v-if="group.key === NO_LICENSE_KEY && group.stores.length" type="button" class="unified-button ghost inv-mini" data-test="'invoice-subject-fill-' + group.key" @click="startFillLicense(group)">去补录</button>
                  <button type="button" class="unified-button ghost inv-mini" :data-test="'invoice-summary-export-' + group.key" @click="exportSubject(group.key)">导出该主体</button>
                  <button type="button" class="unified-button ghost inv-mini" :data-test="'invoice-subject-toggle-' + group.key" @click="toggleSubjectGroup(group.key)">{{ isSubjectCollapsed(group.key) ? `展开店铺（${group.storeCount}）` : '收起' }}</button>
                </div>
              </div>
              <div class="inv-subject-label">
                下属店铺 · {{ group.storeCount }} 家<template v-if="group.key === NO_LICENSE_KEY"> · 补录后自动归入对应主体，不会并入任何真实主体</template>
              </div>
              <div v-show="!isSubjectCollapsed(group.key)" class="inv-subject-stores">
                <div
                  v-for="row in group.stores" :key="row.storeId"
                  class="inv-subject-store" :data-test="'invoice-subject-store-' + row.storeId"
                  role="button" tabindex="0"
                  :title="`进入「${row.storeName}」的店铺详情`"
                  @click="openStoreDetail(row)"
                  @keydown.enter.prevent="openStoreDetail(row)"
                  @keydown.space.prevent="openStoreDetail(row)"
                >
                  <span class="inv-platform-dot" :style="{ background: platformColor(row.platform) }" aria-hidden="true"></span>
                  <div class="inv-subject-store-main">
                    <div class="inv-subject-store-name"><b>{{ row.storeName }}</b><span class="inv-row-sub"> · {{ row.platform }}</span></div>
                    <div class="inv-subject-store-sub">
                      <template v-if="row.capturedAt">采集于 {{ formatTime(row.capturedAt) }} · </template>待办 {{ row.count }} 条 · 可开 {{ row.amountText }}
                    </div>
                  </div>
                  <span v-if="row.loginRequired" class="inv-chip err" data-test="'invoice-subject-store-flag-login-' + row.storeId">登录失效</span>
                  <span v-else-if="row.lastFailed" class="inv-chip err" :title="row.failTitle" data-test="'invoice-subject-store-flag-fail-' + row.storeId">最近采集失败</span>
                  <span v-else-if="!row.supported" class="inv-chip" :title="row.unsupportedReason || '该平台尚未实测到可读取的发票页'">未实测</span>
                  <span v-else-if="row.emptyNote" class="inv-chip warn" :title="row.emptyNote">本次没读到</span>
                  <button
                    v-if="row.needsLicense" type="button" class="inv-chip warn" data-test="'invoice-subject-store-fill-' + row.storeId"
                    title="点这里补录营业执照（发票按主体分账、导出给代账按主体分开）"
                    @click.stop="openLicenseEditor(row)"
                  >未填执照</button>
                  <span class="inv-subject-enter" aria-hidden="true">进入店铺 →</span>
                </div>
                <div
                  v-if="licenseEditingId && licenseEditingGroupKey === group.key"
                  class="inv-lic-edit inv-subject-editor" :data-test="'invoice-subject-license-edit-' + licenseEditingId"
                >
                  <span class="inv-subject-editor-for">补录 / 修改「{{ storeNameOf(licenseEditingId) }}」的营业执照</span>
                  <input v-model="licenseDraft.name" list="store-license-names" data-test="invoice-license-name" placeholder="营业执照主体名称（如：上海某某贸易有限公司）" />
                  <input v-model="licenseDraft.no" data-test="invoice-license-no" placeholder="统一社会信用代码（选填，18 位；旧税号 15 位）" />
                  <button type="button" class="unified-button" data-test="invoice-license-save" :disabled="licenseSaving" @click="saveLicenseInGroup()">{{ licenseSaving ? '保存中…' : '保存' }}</button>
                  <button type="button" class="unified-button ghost" data-test="invoice-license-cancel" @click="licenseEditingId = ''">取消</button>
                  <span v-if="licenseEditError" class="inv-lic-err" data-test="invoice-license-error">{{ licenseEditError }}</span>
                </div>
              </div>
            </section>
          </div>
          <div v-else-if="!visibleInvoiceRows.length" class="unified-empty">没有符合当前筛选的记录。</div>
          <div v-else class="invoice-list">
            <article v-for="row in visibleInvoiceRows" :key="row.storeId" class="invoice-row" data-test="invoice-row">
              <div class="invoice-row-head inv-row-head">
                <span class="inv-platform-dot" :style="{ background: platformColor(row.platform) }" aria-hidden="true"></span>
                <b>{{ row.storeName }}</b>
                <span class="inv-row-sub">{{ row.platform }} · {{ row.supported === false ? '尚未实测' : '已登记页面档案' }}<template v-if="row.capturedAt"> · 采集于 {{ formatTime(row.capturedAt) }}</template></span>
                <!-- 每店可开金额：申报时逐店对账要用（口径与上方合计一致：只算 pending 方向、解析不出的不计入） -->
                <span class="inv-row-amount" :data-test="'invoice-row-amount-' + row.storeId">可开 {{ invoiceRowAmountText(row) }}</span>
                <button
                  type="button" class="inv-lic-tag" :class="{ none: !row.licenseName }"
                  :data-test="'invoice-store-license-' + row.storeId"
                  :title="row.licenseNo ? '统一社会信用代码：' + row.licenseNo + '（点击修改）' : '点这里填营业执照（发票按主体分账、导出给代账按主体分开）'"
                  @click="openLicenseEditor(row)"
                >
                  <img class="button-icon" :src="dataLicenseEditSheetIcon" alt="" />{{ row.licenseName || '未填营业执照' }}<em v-if="row.licenseNo"> · {{ row.licenseNo }}</em>
                </button>
                <!-- 跳转开票地址：看到「N 条待办」之后，下一步就是去平台把票开了。
                     地址取档案里**实测的发票页**（就是采集读的那一页），没档案的平台退回后台首页。 -->
                <button
                  type="button" class="unified-button ghost inv-open-page"
                  :data-test="'invoice-open-page-' + row.storeId"
                  :disabled="!invoiceOpenUrl(row)"
                  :title="invoiceOpenTitle(row)"
                  @click="openInvoicePage(row)"
                ><img class="button-icon" :src="dataInvoiceOpenSheetIcon" alt="" />{{ invoiceOpenLabel(row) }}</button>
                <span class="inv-count">
                  {{ row.count || 0 }} 条待办<template v-if="row.historyCount"> · 无需操作 {{ row.historyCount }} 条</template>
                </span>
              </div>

              <!-- 开票主体（申报要用的那一列）：左边是**已填/将写入导出表**的主体，右边是平台后台读回来的
                   主体，用来核对对不对。平台没实测过主体页时如实说明原因，而不是让人对着"未填写"猜。 -->
              <div class="inv-entity-line" :data-test="'invoice-entity-' + row.storeId">
                <span class="inv-entity-fill">
                  开票主体：<b>{{ row.licenseName || '未填写' }}</b><em v-if="row.licenseNo"> · {{ row.licenseNo }}</em>
                  <template v-if="!row.licenseName && !row.licenseNo">（导出 CSV 的「营业执照」列会写「未填写」，申报按主体分不开）</template>
                </span>
                <span v-if="row.entity && (row.entity.name || row.entity.no)" class="inv-entity-read">
                  平台读到：<b>{{ row.entity.name || '（没读到名称）' }}</b><em v-if="row.entity.no"> · {{ row.entity.no }}</em><template v-if="row.entity.capturedAt">（{{ formatTime(row.entity.capturedAt) }}）</template>
                  —— {{ entityVerdict(row) }}
                </span>
                <span v-else-if="row.entitySupported" class="inv-entity-hint">平台主体：还没有读到值（点上方「获取主体营业执照」去读；个人店铺本来就没有这两行）</span>
                <span v-else class="inv-entity-hint" :title="row.entityUnsupported || '该平台尚未实测到可读的主体信息页'">平台主体：该平台暂不能自动获取（悬停看原因）</span>
              </div>

              <div v-if="licenseEditingId === row.storeId" class="inv-lic-edit" :data-test="'invoice-license-edit-' + row.storeId">
                <input v-model="licenseDraft.name" list="store-license-names" data-test="invoice-license-name" placeholder="营业执照主体名称（如：上海某某贸易有限公司）" />
                <input v-model="licenseDraft.no" data-test="invoice-license-no" placeholder="统一社会信用代码（选填，18 位；旧税号 15 位）" />
                <button type="button" class="unified-button" data-test="invoice-license-save" :disabled="licenseSaving" @click="saveLicense(row)"><img class="button-icon" :src="dataLicenseSaveSheetIcon" alt="" />{{ licenseSaving ? '保存中…' : '保存' }}</button>
                <button type="button" class="unified-button" data-test="invoice-license-cancel" @click="licenseEditingId = ''"><img class="button-icon" :src="dataLicenseCancelSheetIcon" alt="" />取消</button>
                <span v-if="licenseEditError" class="inv-lic-err" data-test="invoice-license-error">{{ licenseEditError }}</span>
              </div>

              <!-- 采集失败/登录失效/平台未实测：主进程都算好了（lastFail/loginRequired/unsupportedReason），
                   这里必须显示出来——否则"登录过期"和"确实没有发票"在屏上长得一模一样。 -->
              <div v-if="row.loginRequired" class="unified-alert error inv-row-alert" :data-test="'invoice-login-required-' + row.storeId">
                该店登录态已失效，采集读不到发票数据。<button type="button" class="unified-button ghost inv-mini" @click="openStoreAdmin(row)"><img class="button-icon" :src="dataInvoiceOpenSheetIcon" alt="" />去登录</button>
              </div>
              <div v-else-if="row.lastFail" class="unified-alert error inv-row-alert" :data-test="'invoice-last-fail-' + row.storeId">
                最近一次采集失败<template v-if="row.lastFail.at">（{{ formatTime(row.lastFail.at) }}）</template>：{{ row.lastFail.message || row.lastFail.code }}<template v-if="!row.capturedAt">——这个方向还没有数据</template>
              </div>
              <div v-else-if="!row.supported" class="unified-alert error inv-row-alert" :data-test="'invoice-unsupported-' + row.storeId">
                {{ row.unsupportedReason || '该平台尚未实测到可读取的发票页' }}
              </div>

              <!-- 方向明细默认收起（2026-10-15 精简）：首屏只留店铺级信息，点开才渲染明细表
                   （v-if 而非 v-show——收起时连 DOM 都不建，行多时渲染成本也跟着降）。 -->
              <div v-if="row.sections?.length" class="inv-dir-bar">
                <button type="button" class="inv-dir-toggle" :data-test="'invoice-dir-toggle-' + row.storeId" @click="toggleStoreDirs(row.storeId)">
                  {{ isStoreDirsOpen(row.storeId) ? '收起方向明细' : `展开方向明细（${row.sections.length} 个开票方向）` }}
                </button>
              </div>
              <div v-if="isStoreDirsOpen(row.storeId)" class="invoice-sections">
                <div
                  v-for="section in row.sections" :key="section.metricKey || section.name"
                  class="invoice-section" :class="{ idle: !isPendingSection(section), blank: !(section.items?.length) }"
                  data-test="invoice-section"
                >
                  <!-- 徽标三态：待开票（橙）/ 无需操作（灰，带原因）/ 无记录（灰）。
                       0 条的方向不该喊「待开票」——用「无记录」，避免扫一眼以为有活干。 -->
                  <div class="inv-sec-top">
                    <span class="inv-sec-name">{{ section.name }}</span>
                    <em v-if="!isPendingSection(section)" class="inv-sec-badge skip" :title="section.notPendingNote || '商家无需再操作，不计入上方待开票合计'">无需操作</em>
                    <em v-else-if="section.items?.length" class="inv-sec-badge todo">待开票</em>
                    <em v-else class="inv-sec-badge blank">无记录</em>
                  </div>
                  <div class="inv-sec-num">{{ section.items?.length || 0 }}<small>条</small></div>
                  <div class="inv-sec-amt" :class="{ muted: !isPendingSection(section) || !sectionAmount(section).parsed }">
                    {{ section.items?.length ? sectionAmount(section).text : '暂无数据' }}
                  </div>
                  <div class="inv-sec-foot">
                    <!-- A1：采集到的**记录本身**（单号/金额/抬头/税号…）——此前只显示条数，用户看不到任何一条明细 -->
                    <button
                      v-if="section.items?.length"
                      type="button" class="inv-detail-toggle"
                      :data-test="'invoice-detail-toggle-' + (section.metricKey || section.name)"
                      @click="toggleSection(section)"
                    >{{ isSectionOpen(section) ? '收起明细' : `查看明细（${section.items.length} 条）` }}</button>
                    <span v-else class="inv-sec-none">无记录</span>
                    <!-- 无需操作的方向：条数照常展示，但必须说明它不进合计——否则用户会以为金额漏算了 -->
                    <em v-if="!isPendingSection(section)" class="inv-sec-flag" :title="section.notPendingNote || '商家无需再操作，不计入待开票合计'">不计入合计</em>
                    <!-- 比实测少：采集读数少于档案里登记的实测条数 → 只提示"可以对照一下"。
                         不能说死"抓漏了"：档案里的 measuredRows 是**实测那一天的快照**，
                         而待开票账单会随处理/结清自然减少（实测抖店「我给平台开票」= 档案 1 条、现在 0 条，
                         真实原因是账单已处理完，不是抓漏）。把两种可能都写出来，由用户判断。 -->
                    <em
                      v-if="section.measuredRows && (section.items?.length || 0) < section.measuredRows"
                      class="inv-sec-few"
                      :data-test="'invoice-section-few-' + (section.metricKey || section.name)"
                      :title="'档案实测那天这个方向有 ' + section.measuredRows + ' 条，本次读到 ' + (section.items?.length || 0) + ' 条。可能是账单已处理完（正常），也可能是抓漏了（平台改版/页面没加载完）——再采集一次对照即可分辨。'"
                    >比实测少（{{ section.measuredRows }}）</em>
                    <!-- 上一次采集没读到这个方向（页签没切成功等）：如实说明，并明确下面是哪一次的数据 -->
                    <em
                      v-if="section.emptyNote" class="inv-sec-empty"
                      :data-test="'invoice-section-empty-' + (section.metricKey || section.name)"
                      :title="'最近一次采集没读到这个方向：' + section.emptyNote + '。下面显示的是上一次成功采集的数据，不是本次结果。'"
                    >本次没读到<template v-if="section.emptyAt">（{{ formatTime(section.emptyAt) }}）</template></em>
                  </div>
                </div>
              </div>
              <!-- A1：明细表放在**整行宽**的区块里（方向卡片本身只有 150px 宽，表格挤进去没法看） -->
              <div v-if="openDetailSections(row).length" class="inv-detail-list" :data-test="'invoice-detail-' + row.storeId">
                <div v-for="section in openDetailSections(row)" :key="sectionKey(section)" class="inv-detail-block">
                  <div class="inv-detail-head">
                    <b>{{ section.name }}</b>
                    <span>{{ section.items.length }} 条<template v-if="section.capturedAt"> · 采集于 {{ formatTime(section.capturedAt) }}</template></span>
                  </div>
                  <div class="inv-detail-wrap">
                    <table class="inv-detail-table" :data-test="'invoice-detail-table-' + sectionKey(section)">
                      <thead>
                        <tr><th v-for="col in sectionColumns(section)" :key="col.label">{{ col.label }}</th></tr>
                      </thead>
                      <tbody>
                        <tr v-for="(item, index) in section.items.slice(0, 200)" :key="index" data-test="invoice-detail-row">
                          <td v-for="col in sectionColumns(section)" :key="col.label">{{ detailCell(item, col.key) || '—' }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <div v-if="section.items.length > 200" class="inv-detail-more">只显示前 200 条（共 {{ section.items.length }} 条）；完整清单用「导出待开票 CSV」。</div>
                </div>
              </div>
              <div v-else class="unified-empty compact">{{ row.supported === false ? (row.unsupportedReason || '该平台尚未实测到可读取的发票页') : (row.note || '暂无发票数据') }}</div>
            </article>
          </div>
        </section>

        <!-- ==================== 涉税信息报送 ====================
             平台按《互联网平台企业涉税信息报送规定》**按季度**向税务机关报送的经营数据。
             ⚠ 平台自己写了这份数据"不得作为税务申报…使用"——那句提示必须与数据**同屏**（见 tax-disclaimer），
             否则等于应用在引导用户拿它去申报，而平台恰恰说了不能用。 -->
        <section class="tax-card" data-test="tax-report">
          <div class="unified-card-head">
            <div>
              <h2>涉税信息报送</h2>
              <span>平台报送给税务机关的经营数据（本应用只读；已实测可采集：{{ taxSupportedPlatforms.join('、') }}）</span>
            </div>
            <div class="inv-head-actions">
              <!-- 默认「按主体统计」：平台按季度报的是"你这个纳税人"的收入，同一家公司在几家店的
                   数据在税务眼里是同一个主体的一份收入；按店铺列，用户得自己拿计算器加。 -->
              <div class="inv-seg" data-test="tax-view-switch" role="tablist" aria-label="涉税数据视图">
                <button type="button" :class="{ on: taxView === 'subject' }" data-test="tax-view-subject" @click="taxView = 'subject'">按主体统计</button>
                <button type="button" :class="{ on: taxView === 'stores' }" data-test="tax-view-stores" @click="taxView = 'stores'">按店铺</button>
              </div>
              <button
                type="button" class="unified-button primary" data-test="tax-collect"
                :disabled="collecting || taxCollecting || entityCollecting" @click="collectTaxReport"
              >{{ taxCollecting ? '创建任务中…' : '采集涉税报送数据' }}</button>
            </div>
          </div>

          <div v-if="taxDisclaimer" class="tax-disclaimer" data-test="tax-disclaimer">
            <span><b>平台用途限制：</b>{{ taxDisclaimer }}<em>（平台页面原文照录）</em></span>
          </div>
          <p v-if="taxBasis" class="tax-basis">{{ taxBasis }}</p>

          <div v-if="!taxData" class="unified-alert error" data-test="tax-load-failed">涉税报送数据没读出来（原因见上方红条）——这不等于"没有报送数据"，点「刷新数据」重试。</div>
          <div v-else-if="!taxRows.length" class="unified-empty">还没有店铺。</div>
          <template v-else>
            <!-- 全口径合计：主体数 / 涉及店铺 / 报送期数 / 收入净额合计（解析不出的期不计入并单独计数） -->
            <div class="tax-totals" data-test="tax-totals">
              共 <b>{{ taxSubjectTotal.subjects }}</b> 个报送主体 · 涉及 <b>{{ taxSubjectTotal.stores }}</b> 家店 ·
              <b>{{ taxSubjectTotal.periods }}</b> 个报送期 · 收入净额合计
              <b class="tax-net">{{ taxAmountText(taxSubjectTotal.netTotal) }}</b>
              <em v-if="taxSubjectTotal.incompletePeriods">（{{ taxSubjectTotal.incompletePeriods }} 期金额未解析，未计入）</em>
              <em v-if="taxSubjectTotal.settleOnlyPeriods">
                （另有 {{ taxSubjectTotal.settleOnlyPeriods }} 期只有「结算金额」口径——微信小店不分货物/服务，
                未并进收入净额合计，单列在右）
              </em>
              <em v-if="taxSubjectTotal.mismatched" class="tax-mismatch-inline">
                {{ taxSubjectTotal.mismatched }} 个主体的报送主体与店铺执照对不上，去核对
              </em>
            </div>

            <!-- ===== 按主体统计（默认）===== -->
            <div v-if="taxView === 'subject'" class="tax-subjects" data-test="tax-subject-list">
              <table class="inv-detail-table tax-table tax-subject-table">
                <thead><tr>
                  <th>开票主体</th><th>纳税人识别号</th><th>涉及店铺</th>
                  <th class="num">报送期数</th><th>期间范围</th>
                  <th class="num">货物收入净额</th><th class="num">服务收入净额</th><th class="num">收入净额合计</th><th class="num">结算金额</th>
                  <th>主体核对</th><th></th>
                </tr></thead>
                <tbody>
                  <template v-for="group in taxSubjectGroups" :key="group.key">
                    <tr :data-test="'tax-subject-' + group.key">
                      <td><b>{{ taxSubjectLabel(group) }}</b></td>
                      <td>{{ group.taxNo || '—' }}</td>
                      <td><span v-for="name in group.storeNames" :key="name" class="inv-sum-store">{{ name }}</span></td>
                      <td class="num">{{ group.periodCount }}</td>
                      <td>{{ group.earliest === group.latest ? group.earliest : `${group.earliest} ~ ${group.latest}` }}</td>
                      <td class="num">{{ taxAmountText(group.goodsNet) }}</td>
                      <td class="num">{{ taxAmountText(group.serviceNet) }}</td>
                      <td class="num tax-net">{{ taxAmountText(group.netTotal) }}</td>
                      <td class="num">{{ taxAmountText(group.settleTotal) }}</td>
                      <td>
                        <span
                          class="tax-verdict" :class="taxLicenseVerdictText(group).tone"
                          :data-test="'tax-verdict-' + group.key"
                        >{{ taxLicenseVerdictText(group).text }}</span>
                      </td>
                      <td>
                        <button
                          type="button" class="unified-button ghost inv-mini"
                          :data-test="'tax-subject-toggle-' + group.key"
                          @click="taxExpandedSubject = taxExpandedSubject === group.key ? '' : group.key"
                        >{{ taxExpandedSubject === group.key ? '收起明细' : `逐期明细（${group.periodCount}）` }}</button>
                      </td>
                    </tr>
                    <tr v-if="taxExpandedSubject === group.key" :data-test="'tax-subject-detail-' + group.key">
                      <td colspan="10" class="tax-subject-detail-cell">
                        <table class="inv-detail-table tax-table">
                          <thead><tr>
                            <th>涉税数据所属期</th><th class="num">本期净额合计</th><th>店铺</th><th>平台</th>
                            <th class="num">货物收入净额</th><th class="num">服务收入净额</th>
                          </tr></thead>
                          <tbody>
                            <tr v-for="(p, i) in group.periods" :key="i" data-test="tax-subject-period">
                              <td>{{ p.period || '—' }}</td>
                              <td class="num tax-net">
                                {{ taxAmountText(p.netTotal) }}
                                <em v-if="p.incomplete" class="tax-mismatch" title="这一期有收入段没解析出来——未计入该主体的合计">未解析</em>
                              </td>
                              <td>{{ p.storeName }}</td>
                              <td>{{ p.platform }}</td>
                              <td class="num">{{ taxAmountText(p.goodsNet) }}</td>
                              <td class="num">{{ taxAmountText(p.serviceNet) }}</td>
                            </tr>
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  </template>
                </tbody>
              </table>
              <p class="inv-detail-more">
                归组按<b>纳税人识别号</b>优先（没有识别号时按名称，同名主体会并到一起）；
                名称与识别号都没读到的期间单独归入「{{ UNKNOWN_TAX_SUBJECT_LABEL }}」，<b>不会</b>并进任何真实主体。
              </p>
            </div>

            <!-- ===== 按店铺 ===== -->
            <div v-else class="tax-store-list">
            <article v-for="row in taxRows" :key="row.storeId" class="tax-store" data-test="tax-row">
              <div class="tax-store-head">
                <span class="inv-platform-dot" :style="{ background: platformColor(row.platform) }" aria-hidden="true"></span>
                <b>{{ row.storeName }}</b>
                <span class="inv-row-sub">{{ row.platform }}<template v-if="row.measuredAt"> · 实测档案 {{ row.measuredAt }}</template></span>
                <span v-if="row.capturedAt" class="inv-row-sub">· 采集于 {{ formatTime(row.capturedAt) }}</span>
                <span class="tax-store-figs" :data-test="'tax-summary-' + row.storeId">
                  {{ taxStoreSummary(row).periods }} 个报送期 · 收入净额合计 {{ taxStoreSummary(row).netText }}
                </span>
              </div>

              <!-- 登录失效 / 采集失败 / 平台未实测：三种"读不到"要分得开，不能都显示成"没有数据" -->
              <!-- 「本次没读到」（expected=false 的空标记 → 读取侧 emptyNote）：
                   与发票分区的 inv-sec-empty 同一条规矩——不能把上一次的数据静默当成本次结果 -->
              <div
                v-for="note in taxEmptyNotes(row)"
                :key="'tax-empty-' + row.storeId + '-' + note.metricKey"
                class="unified-alert error inv-row-alert"
                :data-test="'tax-empty-note-' + row.storeId"
              >
                本次没读到「{{ note.name }}」<template v-if="note.emptyAt">（{{ formatTime(note.emptyAt) }}）</template>：{{ note.emptyNote }}。<template v-if="taxSectionsWithItems(row).length">下面显示的是上一次成功采集的数据，不是本次结果。</template>
              </div>
              <div v-if="row.loginRequired" class="unified-alert error inv-row-alert" :data-test="'tax-login-required-' + row.storeId">
                该店登录态已失效，采集读不到报送数据。<button type="button" class="unified-button ghost inv-mini" @click="openStoreAdmin(row)">去登录</button>
              </div>
              <div v-else-if="row.lastFail" class="unified-alert error inv-row-alert" :data-test="'tax-last-fail-' + row.storeId">
                最近一次采集失败<template v-if="row.lastFail.at">（{{ formatTime(row.lastFail.at) }}）</template>：{{ row.lastFail.message || row.lastFail.code }}
              </div>
              <div v-else-if="!row.supported" class="unified-alert error inv-row-alert" :data-test="'tax-unsupported-' + row.storeId">
                {{ row.unsupportedReason || '该平台尚未实测到可读取的涉税信息报送页' }}
              </div>

              <template v-else-if="taxSectionsWithItems(row).length">
                <div v-for="section in taxSectionsWithItems(row)" :key="section.metricKey" class="tax-periods">
                  <table class="inv-detail-table tax-table" :data-test="'tax-table-' + row.storeId">
                    <thead><tr>
                      <!-- 「本期净额合计」紧挨着所属期：这是申报时要看的那个数，12 列的表格横向滚动时
                           它必须留在第一屏（放在最后一列会被挤出可视区，等于最该看的数看不见）。 -->
                      <th>涉税数据所属期</th><th class="num">本期净额合计</th>
                      <th>主体名称</th><th>纳税人识别号</th>
                      <th class="num">货物收入金额</th><th class="num">货物退款</th><th class="num">货物收入净额</th>
                      <th class="num">服务收入金额</th><th class="num">服务退款</th><th class="num">服务收入净额</th>
                      <th class="num">佣金/服务费</th><th class="num">订单笔数</th>
                      <!-- 微信小店的口径：只给「结算金额 / 退款金额」两个数，不分货物/服务，
                           也不并进「本期净额合计」（是不是同一口径无从确认）。追加在末尾 -->
                      <th class="num">结算金额</th><th class="num">退款金额</th>
                    </tr></thead>
                    <tbody>
                      <tr v-for="(item, i) in section.items" :key="i" data-test="tax-period-row">
                        <td>{{ taxCellOf(item, 'period') || '—' }}</td>
                        <td class="num tax-net">
                          {{ taxAmountText(taxRowNet(item)) }}
                          <em
                            v-if="taxRowReconciles(item) === false" class="tax-mismatch"
                            title="平台给的三段对不上：收入金额 − 退款金额 ≠ 收入净额。申报前先核对，别直接采用。"
                          >数对不上</em>
                        </td>
                        <td>{{ taxCellOf(item, 'subject') || '—' }}</td>
                        <td>{{ taxCellOf(item, 'taxNo') || '—' }}</td>
                        <td class="num">{{ taxAmountText(taxGoods(item).amount) }}</td>
                        <td class="num">{{ taxAmountText(taxGoods(item).refund) }}</td>
                        <td class="num">{{ taxAmountText(taxGoods(item).net) }}</td>
                        <td class="num">{{ taxAmountText(taxService(item).amount) }}</td>
                        <td class="num">{{ taxAmountText(taxService(item).refund) }}</td>
                        <td class="num">{{ taxAmountText(taxService(item).net) }}</td>
                        <td class="num">{{ taxCellOf(item, 'commission') || '—' }}</td>
                        <td class="num">{{ taxCellOf(item, 'orders') || '—' }}</td>
                        <td class="num">{{ taxCellOf(item, 'settleTotal') || '—' }}</td>
                        <td class="num">{{ taxCellOf(item, 'refundTotal') || '—' }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p v-if="taxStoreSummary(row).unparsed" class="inv-detail-more">
                  有 <b>{{ taxStoreSummary(row).unparsed }}</b> 个报送期的收入三段没解析出来——这些期<b>未计入</b>净额合计（解析不出不当 0 算）。
                </p>
              </template>
              <div v-else class="unified-empty compact">该店还没有报送数据（点上方「采集涉税报送数据」去读；新店可能还没到报送期）。</div>
            </article>
          </div>
          </template>
        </section>

        <!-- 平台覆盖与金额口径：锚点都来自真机实测并登记实测日期，改版时如实报错而不是显示错数据。 -->
        <section class="inv-cover" data-test="invoice-coverage">
          <div class="unified-card-head">
            <div><h2>平台覆盖与金额口径</h2><span>所有锚点都来自真机实测并登记实测日期；平台改版时如实报错，而不是显示错数据。</span></div>
          </div>
          <div class="inv-cover-grid">
            <div class="inv-cover-plats">
              <div v-for="item in invoicePlatformCoverage" :key="item.platform" class="inv-cover-plat" :data-test="'invoice-coverage-' + item.platform">
                <div class="inv-cover-plat-head">
                  <b>{{ item.platform }}</b>
                  <em :class="{ on: item.measured }">{{ item.measured ? '已实测' : '未实测' }}</em>
                </div>
                <div class="inv-cover-plat-body">{{ item.note }}</div>
              </div>
            </div>
            <ul class="inv-cover-list">
              <li><b>待开票 ≠ 全部记录。</b>各平台把「已提交 / 已审核通过」的流水放在同一个发票页，它们照常展示，但<b>不计入</b>待开票条数与可开金额。</li>
              <li><b>金额口径按平台各自页面为准。</b>含税 / 不含税、阈值金额与账单金额各不相同，界面不做跨平台换算。</li>
              <li><b>解析不出就不计入。</b>合计只累加整串就是金额的单元格，并单独标出未解析条数。</li>
              <li><b>只读。</b>软件只打开平台的发票页把清单读回来；开发票、上传发票仍由你在平台页面上完成。</li>
            </ul>
          </div>
        </section>

        <!-- 导出确认：把「导出范围 / 行数 / 金额」写在屏上再落盘。
             导出是分主体做的——用户在屏上点了某家公司，拿到的不该是别家的单号与税号。 -->
        <div v-if="exportConfirm.open" class="inv-modal-mask" data-test="invoice-export-confirm" @click.self="exportConfirm.open = false">
          <div class="inv-modal" role="dialog" aria-modal="true" aria-label="导出待开票清单">
            <div class="inv-modal-head">
              <h3>导出待开票清单</h3>
              <p>只导出「待开票」的行；无需操作的历史流水不会进这份表。文件只落在本机，不上传。</p>
            </div>
            <div class="inv-modal-body">
              <div class="inv-modal-row"><span>导出范围</span><b data-test="invoice-export-scope">{{ exportConfirm.scopeLabel }}</b></div>
              <div class="inv-modal-row"><span>待开票行数</span><b data-test="invoice-export-rows">{{ exportConfirm.pendingRows }} 条</b></div>
              <div class="inv-modal-row"><span>可开金额</span><b class="inv-modal-amount">{{ exportConfirm.amountText }}</b></div>
              <div v-if="exportConfirm.unparsed" class="inv-modal-row"><span>提醒</span><b class="inv-modal-warn">{{ exportConfirm.unparsed }} 条金额无法解析，CSV 里保留原始文本、不写成 0</b></div>
              <div class="inv-modal-row"><span>列</span><b class="inv-modal-cols">{{ invoiceCsvColumns }}</b></div>
            </div>
            <div class="inv-modal-foot">
              <button type="button" class="unified-button ghost" data-test="invoice-export-cancel" @click="exportConfirm.open = false">取消</button>
              <button type="button" class="unified-button primary" data-test="invoice-export-do" :disabled="exporting" @click="confirmExportInvoices">{{ exporting ? '导出中…' : '导出 CSV' }}</button>
            </div>
          </div>
        </div>

        <!-- 主体名称候选：填过的 + 平台读回来的，补录时直接选，不用手打（此前 list 指向的 datalist 只存在于已废弃的旧弹窗里） -->
        <datalist id="store-license-names">
          <option v-for="name in licenseNameOptions" :key="name" :value="name" />
        </datalist>
          </div><!-- /inv-main -->
        </div><!-- /inv-shell -->
        <!-- 移动端（<768）常驻操作条：桌面隐藏，窄屏固定在滚动容器底部——采集/导出是最高频动作，
             滚动中也够得着；按钮热区 ≥ 40px（视觉）+ 容器 padding 补足 44px 触控面。 -->
        <div class="inv-mobile-actions">
          <button type="button" class="unified-button primary" :disabled="collecting || entityCollecting" @click="collectInvoices">{{ collecting ? '创建任务中…' : '采集发票数据' }}</button>
          <button type="button" class="unified-button" :disabled="!invoiceRows.length" :title="exportScopeTitle" @click="openExportConfirm">导出</button>
        </div>
      </template>

      <section v-if="mode === 'analytics'" class="unified-card manual-card"><div class="unified-card-head"><div><h2>手动录入指标</h2><span>仅用于平台反抓取导致无法自动读取的数字，来源会标注为手动</span></div></div><div class="manual-form"><select v-model="manual.storeId" aria-label="店铺"><option value="">选择店铺</option><option v-for="store in ws.stores" :key="store.id" :value="store.id">{{ store.name }}</option></select><select v-model="manual.metric" aria-label="指标"><option v-for="metric in bizMetrics" :key="metric.key" :value="metric.key">{{ metric.label }}</option></select><input v-model.number="manual.value" type="number" min="0" placeholder="数值" /><button type="button" class="unified-button ghost" :disabled="!manualReady" @click="saveManual"> <img class="button-icon" :src="dataManualEntrySheetIcon" alt="" />录入</button></div></section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import { EVENT_CHANNELS } from '@shared/contracts/ipc'
import { BIZ_METRICS, businessProfileFor } from '@shared/constants/business'
import type { BusinessProfile } from '@shared/constants/business'
import { buildBusinessCollectSteps } from '@shared/business-steps'
import { ordersProfileFor } from '@shared/constants/orders'
import type { OrdersProfile } from '@shared/constants/orders'
import { buildOrdersCollectSteps } from '@shared/orders-steps'
import { invoiceProfileFor, INVOICE_TASK_PREFIX, isPendingSection } from '@shared/constants/invoice'
import type { InvoiceProfile } from '@shared/constants/invoice'
import { TAX_SUPPORTED_PLATFORMS, TAX_TASK_PREFIX, taxProfileFor } from '@shared/constants/tax'
import type { TaxProfile } from '@shared/constants/tax'
import { AUTO_COLLECTION_SETTING, parseAutoCollectionEnabled, pickLatestCollectTask } from '@shared/constants/collection'
import { taxAmountText, taxIncomeFromCells, taxPeriodNetOf } from '@shared/tax-income'
import { buildTaxCollectSteps } from '@shared/tax-steps'
import {
  UNKNOWN_TAX_SUBJECT_KEY, UNKNOWN_TAX_SUBJECT_LABEL,
  groupTaxPeriodsBySubject, taxSubjectTotals
} from '@shared/tax-subject'
import { findPlatform } from '@shared/constants/platforms'
import { buildInvoiceCollectSteps } from '@shared/invoice-steps'
import { entityProfileFor, entityUnsupportedNote, ENTITY_SUPPORTED_PLATFORMS } from '@shared/constants/entity'
import { buildEntityCollectSteps } from '@shared/entity-steps'
import { NO_LICENSE_KEY, entityVerdictText, groupStoresByLicense, normalizeLicenseName } from '@shared/store-license'
import { invoiceAmountText, parseInvoiceAmount } from '@shared/invoice-amount'
import SalesMetricsMonitorCard from './SalesMetricsMonitorCard.vue'
import invoiceIcon from '../../assets/generated/ui-icons/invoice-gen.png'
import dataRetryIcon from '../../assets/generated/ui-icons/data-retry-gen.png'
import dataAnalyticsSheetIcon from '../../assets/generated/ui-icons/data-analytics-sheet-gen.png'
import dataOrdersSheetIcon from '../../assets/generated/ui-icons/data-orders-sheet-gen.png'
import dataSyncSheetIcon from '../../assets/generated/ui-icons/data-sync-sheet-gen.png'
import dataExportSheetIcon from '../../assets/generated/ui-icons/data-export-sheet-gen.png'
import dataInvoiceScheduleSheetIcon from '../../assets/generated/ui-icons/data-invoice-schedule-sheet-gen.png'
import dataInvoiceOpenSheetIcon from '../../assets/generated/ui-icons/data-invoice-open-sheet-gen.png'
import dataLicenseEditSheetIcon from '../../assets/generated/ui-icons/data-license-edit-sheet-gen.png'
import dataLicenseSaveSheetIcon from '../../assets/generated/ui-icons/data-license-save-sheet-gen.png'
import dataLicenseCancelSheetIcon from '../../assets/generated/ui-icons/data-license-cancel-sheet-gen.png'
import dataManualEntrySheetIcon from '../../assets/generated/ui-icons/data-manual-entry-sheet-gen.png'

type DataMode = 'analytics' | 'orders' | 'invoices'
const props = defineProps<{ mode: DataMode }>()
const emit = defineEmits<{ 'change-mode': [mode: DataMode]; 'open-store': [storeId: string] }>()
const ws = useWorkspaceStore()
const loading = ref(false)
const collecting = ref(false)
const errorMessage = ref('')
const dataCenter = ref<any | null>(null)
const orderData = ref<any | null>(null)
const invoiceData = ref<any | null>(null)
/** 涉税信息报送（平台按季度报送给税务机关的经营数据；随数据一起带回平台自己的用途限制） */
const taxData = ref<any | null>(null)
const taxCollecting = ref(false)
/** 「获取主体营业执照」：采集进行中 + 逐店结果（填了哪些、哪不一致、哪些平台取不了，全部照实展示） */
const entityCollecting = ref(false)
/**
 * 采集进度（跑的时候就要显示）。
 *
 * 为什么需要：一次采集要开店铺浏览器 + 建任务 + 跑任务 + 轮询，冷启动实测要 1 分多钟，
 * 而结果面板与 toast 都是**全部跑完才出现**——中途只有按钮文案变成「获取中…」，
 * 看起来就是"点了没反应"。这里把"共几家 / 已完成几家 / 还在等哪几家"实时显示出来。
 */
const entityProgress = ref<{ total: number; done: number; waiting: string[] } | null>(null)
const entityReport = ref<any[]>([])
// 页面切换时让正在等待任务结果的采集流程尽快收尾，避免卸载后的旧流程继续轮询、
// 再把结果写回已经不存在的组件状态。
let entityCollectGeneration = 0
const manual = reactive({ storeId: '', metric: 'biz.orders', value: null as number | null })
const tabs: Array<{ key: DataMode; label: string }> = [{ key: 'analytics', label: '经营分析' }, { key: 'orders', label: '订单明细' }, { key: 'invoices', label: '发票中心' }]
const title = computed(() => props.mode === 'orders' ? '订单管理' : props.mode === 'invoices' ? '发票中心' : '数据分析')
const subtitle = computed(() => props.mode === 'orders' ? '按店铺查看已采集的订单整表快照。' : props.mode === 'invoices' ? '开票与申报资料统一管理。' : '销售额、订单和经营指标均来自本机快照。')
const bizMetrics = BIZ_METRICS
const totalCards = computed(() => { const t = dataCenter.value?.totals || {}; return [{ label: '店铺', value: t.stores ?? '—', note: `${t.online ?? 0} 家在线` }, { label: '平台', value: t.platforms ?? '—', note: '已配置的平台' }, { label: '指标快照', value: t.snapshots ?? '—', note: '本机采集记录' }, { label: '任务', value: t.tasks ?? '—', note: '任务定义总数' }] })
const snapshotRows = computed<any[]>(() => dataCenter.value?.snapshots || [])
const orderStores = computed<any[]>(() => orderData.value?.stores || [])
const invoiceRows = computed<any[]>(() => invoiceData.value?.rows || [])
/**
 * 每行补上「无需操作」条数。
 *
 * 各平台把「处理中 / 处理记录」这类**已提交、商家无需再操作**的流水放在同一个发票页，
 * 它们照常展示，但绝不能计入"待开票条数/可开金额"——计入就是虚高（主进程给的 `count`
 * 已经是按 pending 过滤过的；这里再把历史条数单独算出来，好让界面把两个数都说清楚）。
 */
const invoiceAllRows = computed<any[]>(() => invoiceRows.value.map((row: any) => ({
  ...row,
  historyCount: (row.sections || []).reduce((n: number, sec: any) => n + (isPendingSection(sec) ? 0 : (sec.items?.length || 0)), 0)
})))

/** 选中的开票主体（不存在的 key 自动退回"全部"，避免卡在一个空列表里退不出来） */
const invoiceLicense = ref('')
type InvoiceStatusFilter = 'all' | 'pending' | 'processed' | 'error'
const invoiceStatusFilter = ref<InvoiceStatusFilter>('all')
const invoicePlatformFilter = ref('')
const invoiceQuery = ref('')
const invoicePeriodFilter = ref('all')
const licenseEditingId = ref('')
const licenseDraft = reactive({ name: '', no: '' })
const licenseSaving = ref(false)
const licenseEditError = ref('')
/**
 * 视图：按主体分组（**默认**，申报与交代账看它；组下店铺行可点击进入店铺详情）
 * / 按店铺列表（排查视图；每个店铺的「方向明细」点开才渲染）。
 *
 * 2026-10-15 精简：默认从「按店铺」改为「按主体」——打开先看"票压在哪个主体"，店铺列表是二级视角。
 */
const invoiceView = ref<'stores' | 'summary'>('summary')
/**
 * 「按主体」视图里**被收起**的主体组（默认全部展开）。
 *
 * 为什么默认展开：这个视图的第一眼就该回答"谁手下有哪些店"——如果默认收起来，
 * 用户看到的还是一行行主体，跟旧平表没区别，"层级关系"要再点一次才出现。
 * 家数多的组也不怕：最多一家店一行，屏上就那几行。
 */
const collapsedSubjects = ref<Set<string>>(new Set())
function isSubjectCollapsed(key: string): boolean { return collapsedSubjects.value.has(key) }
function toggleSubjectGroup(key: string): void {
  const next = new Set(collapsedSubjects.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedSubjects.value = next
}
/** 「按店铺」视图里展开了「方向明细」的店铺（默认收起——明细点开才渲染，不占首屏） */
const expandedStoreDirs = ref<Set<string>>(new Set())
function isStoreDirsOpen(storeId: string): boolean { return expandedStoreDirs.value.has(storeId) }
function toggleStoreDirs(storeId: string): void {
  const next = new Set(expandedStoreDirs.value)
  if (next.has(storeId)) next.delete(storeId)
  else next.add(storeId)
  expandedStoreDirs.value = next
}
/** 行内排序：默认「按平台顺序」——与主进程给的顺序一致，不擅自重排 */
const invoiceSort = ref<'none' | 'amountDesc' | 'amountAsc'>('none')
/**
 * 工具栏「筛选」面板开合（2026-10-15 精简）：常态只显示搜索与「筛选 · N」，
 * 点开才展开 状态 / 平台 / 采集时间 / 排序 四个下拉；生效中的筛选项数量标在按钮上。
 */
const filtersOpen = ref(false)
const activeFilterCount = computed(() => {
  let count = 0
  if (invoiceStatusFilter.value !== 'all') count++
  if (invoicePlatformFilter.value) count++
  if (invoicePeriodFilter.value !== 'all') count++
  if (invoiceSort.value !== 'none') count++
  return count
})
/** 导出确认浮层：先把"导哪一户、几行、多少钱"写在屏上，再去调主进程（见 openExportConfirm） */
const exporting = ref(false)
const exportConfirm = reactive({ open: false, scopeLabel: '全部主体', pendingRows: 0, amountText: '—', unparsed: 0 })

const licenseGroups = computed(() => groupStoresByLicense(ws.stores.map(store => ({
  id: store.id, licenseName: store.licenseName ?? null, licenseNo: store.licenseNo ?? null
}))))

/**
 * 每个开票主体的待开票条数与金额。
 *
 * 金额用**未按主体筛选**的那一份行来算：胶囊之间要能横向比较，若在筛选后的结果上算，
 * 点开一个主体，别的主体数字全变 0。解析不出的金额**不计入**合计，但条数照数、并标出未解析条数。
 */
const licenseSummary = computed(() => {
  const items = licenseGroups.value.groups.map(group => ({
    ...group, pendingCount: 0, amount: 0, unparsed: 0, stores: 0, amountText: ''
  }))
  const byKey = new Map(items.map(item => [item.key, item]))
  for (const row of invoiceAllRows.value) {
    const hit = byKey.get(licenseGroups.value.keyByStore.get(row.storeId) || '')
    if (!hit) continue
    if ((row.sections || []).some((sec: any) => isPendingSection(sec) && (sec.items?.length || 0) > 0)) hit.stores++
    for (const sec of row.sections || []) {
      if (!isPendingSection(sec)) continue
      for (const item of sec.items || []) {
        hit.pendingCount++
        const amount = parseInvoiceAmount(item.cells?.amount)
        if (amount == null) hit.unparsed++
        else hit.amount += amount
      }
    }
  }
  // P1-2：hasAny 的语义是"**解析出了**金额"（进过 amount 累加），不是"合计 > 0"。
  // 用 `amount > 0` 会把两种真实情况误显示成「—」：退款/冲正把净额抵成负数、或整批都是 0.00。
  const parsedAny = items.some(item => item.pendingCount > item.unparsed)
  const withText = items.map(item => ({ ...item, amountText: invoiceAmountText(item.amount, item.pendingCount > item.unparsed) }))
  return {
    items: withText,
    storeCount: ws.stores.length,
    pendingCount: withText.reduce((sum, item) => sum + item.pendingCount, 0),
    amountText: invoiceAmountText(withText.reduce((sum, item) => sum + item.amount, 0), parsedAny)
  }
})

const activeLicense = computed(() => (
  invoiceLicense.value && licenseSummary.value.items.some(item => item.key === invoiceLicense.value)
    ? invoiceLicense.value
    : ''
))

/** 页面上列出的店铺先按营业执照筛一道（用统一归属表，见 shared/store-license.ts）。 */
const subjectInvoiceRows = computed<any[]>(() => (
  activeLicense.value
    ? invoiceAllRows.value.filter(row => licenseGroups.value.keyByStore.get(row.storeId) === activeLicense.value)
    : invoiceAllRows.value
))

function rowHasPending(row: any): boolean {
  return (row.sections || []).some((section: any) => isPendingSection(section) && (section.items?.length || 0) > 0)
}
function rowHasProcessed(row: any): boolean {
  return Number(row.historyCount || 0) > 0
}
function rowHasIssue(row: any): boolean {
  return !!(row.loginRequired || row.lastFail || row.supported === false || (row.sections || []).some((section: any) => section.emptyNote))
}
function invoiceStatusMatches(row: any): boolean {
  if (invoiceStatusFilter.value === 'all') return true
  if (invoiceStatusFilter.value === 'pending') return rowHasPending(row)
  if (invoiceStatusFilter.value === 'processed') return rowHasProcessed(row)
  return rowHasIssue(row)
}
function invoiceQueryMatches(row: any): boolean {
  const query = invoiceQuery.value.trim().toLowerCase()
  if (!query) return true
  return JSON.stringify(row).toLowerCase().includes(query)
}
function invoicePeriodMatches(row: any): boolean {
  if (invoicePeriodFilter.value === 'all') return true
  const days = Number(invoicePeriodFilter.value)
  const capturedAt = Number(row.capturedAt || 0)
  return capturedAt > 0 && capturedAt >= Date.now() - days * 86400000
}

/** 页面列表同时支持主体、平台、状态、时间和文本筛选；顶部指标仍保持主体口径，避免搜索一行就改变总额。 */
const visibleInvoiceRows = computed<any[]>(() => {
  const rows = subjectInvoiceRows.value.filter(row => {
    const platformOk = !invoicePlatformFilter.value || row.platform === invoicePlatformFilter.value
    return platformOk && invoiceStatusMatches(row) && invoiceQueryMatches(row) && invoicePeriodMatches(row)
  })
  if (invoiceSort.value === 'none') return rows
  return [...rows].sort((a, b) => {
    const keyA = invoiceRowSortKey(a)
    const keyB = invoiceRowSortKey(b)
    if (keyA == null && keyB == null) return 0
    if (keyA == null) return 1
    if (keyB == null) return -1
    return invoiceSort.value === 'amountDesc' ? keyB - keyA : keyA - keyB
  })
})

/** 顶部合计：跟着当前筛选走（"合计"是这一屏的数字；胶囊上的横向比较才是不跟筛选走的那一份） */
const invoiceTotal = computed(() => {
  let count = 0
  let amount = 0
  let unparsed = 0
  let historical = 0
  let stores = 0
  for (const row of subjectInvoiceRows.value) {
    let storePending = 0
    for (const sec of row.sections || []) {
      if (!isPendingSection(sec)) { historical += sec.items?.length || 0; continue }
      for (const item of sec.items || []) {
        count++
        storePending++
        const value = parseInvoiceAmount(item.cells?.amount)
        if (value == null) unparsed++
        else amount += value
      }
    }
    if (storePending > 0) stores++
  }
  // P1-2：hasAny = 至少解析出过一条金额（count - unparsed > 0），而不是"合计 > 0"——
  // 否则"这批票全是 0.00"或"退款把净额抵成负数"都会显示成「—」，把真实数字藏起来。
  return { count, amountText: invoiceAmountText(amount, count - unparsed > 0), stores, historical, unparsed }
})

/**
 * 不受主体筛选影响的全局口径（只用于 KPI 第 1 张卡的交叉印证：
 * 「当前主体 N 条 · 全部主体共 M 条」——否则点了某个公司就再也看不到总数）。
 */
const invoiceGrandTotal = computed(() => {
  let count = 0
  let amount = 0
  let unparsed = 0
  for (const row of invoiceAllRows.value) {
    for (const section of row.sections || []) {
      if (!isPendingSection(section)) continue
      for (const item of section.items || []) {
        count++
        const value = parseInvoiceAmount(item?.cells?.amount)
        if (value == null) unparsed++
        else amount += value
      }
    }
  }
  return { count, amountText: invoiceAmountText(amount, count - unparsed > 0) }
})

/**
 * 采集覆盖情况：这批数字是什么时候的、覆盖了几家、哪几家根本没读到。
 *
 * 为什么单列 `notCollected` 且排除登录态失效：登录失效已经单独一个 chip，
 * 两个数重叠会让「1 家登录态失效」看起来像「1 家登录态失效 + 1 家采不到」= 2 家。
 */
const invoiceCoverage = computed(() => {
  const rows = invoiceAllRows.value
  const captured = rows.filter(row => Number(row.capturedAt || 0) > 0)
  return {
    total: rows.length,
    ok: captured.length,
    loginRequired: rows.filter(row => !!row.loginRequired).length,
    notCollected: rows.filter(row => !row.loginRequired && (!!row.lastFail || row.supported === false)).length,
    lastAt: captured.reduce((max, row) => Math.max(max, Number(row.capturedAt) || 0), 0)
  }
})

/** 还没填营业执照的店铺（状态条上给一条"去补录"的路；不填就申报时按主体分不开） */
const unlicensedPending = computed(() => {
  const item = licenseSummary.value.items.find(entry => entry.key === NO_LICENSE_KEY)
  return { stores: item?.storeCount || 0, pendingCount: item?.pendingCount || 0 }
})

/** 主体胶囊上的占比条：该主体在「待开票条数」里的份额（申报时一眼看出票压在哪个公司名下） */
function licenseShare(count: number): string {
  const total = licenseSummary.value.pendingCount || 0
  if (!total || !count) return '0%'
  return `${Math.max(2, Math.round(count / total * 100))}%`
}

/**
 * 承诺/到期时间 → 逾期或临期。
 *
 * 各平台写法不同（`2026-09-04`、`2026年09月04日`、`逾期 40 天`），**能算就算，算不出就不标**——
 * 宁可少标一个临期，也不猜一个日期出来（猜错会让商家去催一个根本没到期的单子）。
 */
function invoiceDeadlineState(value: unknown): { kind: 'late' | 'soon'; days: number } | null {
  const raw = String(value ?? '').trim()
  if (!raw || raw === '—' || raw === '-' || raw === '--') return null
  /**
   * 「预计」类是**预测**日期，没有承诺含义 → 一律不判逾期。
   *
   * 2026-10-15 审查 BUG：实测快手「阈值生效时间」写成 `2026-06-10(预计)`，曾被映射到 deadline，
   * 于是"过去的日期 = 已逾期"把一批正常账单算成假的已逾期（实测 5 条）。
   * 档案侧的错映射已修（不再映射 deadline），这里再兜一道：任何带"预计"的值都不参与逾期判定。
   */
  if (/预计/.test(raw)) return null
  const matched = /(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})/.exec(raw)
  if (matched) {
    const at = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])).getTime()
    if (Number.isFinite(at)) {
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const days = Math.round((at - today.getTime()) / 86400000)
      if (days < 0) return { kind: 'late', days: -days }
      if (days <= 3) return { kind: 'soon', days }
      return null
    }
  }
  // 文字形态的逾期：实测拼多多/抖店混用两种写法——「已逾期 236 天」「已超时 21天36分钟07秒」
  // （只认「逾期」会把抖店那条真超时的漏掉，KPI 反而少报）。
  const late = /(?:逾期|已超时|超时)\s*(\d+)\s*天/.exec(raw)
  return late ? { kind: 'late', days: Number(late[1]) } : null
}

/** 时间风险（只算**待办**方向：无需操作的历史流水没有承诺期，不该报成逾期） */
const invoiceRisk = computed(() => {
  let late = 0
  let soon = 0
  for (const row of subjectInvoiceRows.value) {
    for (const section of row.sections || []) {
      if (!isPendingSection(section)) continue
      for (const item of section.items || []) {
        const state = invoiceDeadlineState(item?.cells?.deadline)
        if (!state) continue
        if (state.kind === 'late') late++
        else soon++
      }
    }
  }
  return { late, soon }
})

/** 当前口径的名字（工具条上写死"口径：…"，避免用户对着数字猜这是谁家的） */
const invoiceScopeLabel = computed(() => {
  if (!activeLicense.value) return '全部主体'
  if (activeLicense.value === NO_LICENSE_KEY) return '未填写营业执照'
  const item = licenseSummary.value.items.find(entry => entry.key === activeLicense.value)
  return item?.label || item?.no || '当前主体'
})

/** 平台品牌色（用于店铺行前的圆点；取不到就退回中性灰，不猜颜色） */
function platformColor(name: unknown): string {
  return findPlatform(String(name || ''))?.color || '#98a2b3'
}

/** 工具条「平台」下拉的候选：只列当前数据里真实出现过的平台 */
const invoicePlatformOptions = computed<string[]>(() => {
  const names = new Set<string>()
  for (const row of invoiceRows.value) {
    const name = String(row.platform || '').trim()
    if (name) names.add(name)
  }
  return [...names]
})

/** 单个方向的金额与"解析出过金额没有"（无需操作的方向金额要置灰，因为它不进合计） */
function sectionAmount(section: any): { text: string; parsed: boolean } {
  let total = 0
  let parsed = 0
  for (const item of section?.items || []) {
    const value = parseInvoiceAmount(item?.cells?.amount)
    if (value == null) continue
    total += value
    parsed++
  }
  return { text: invoiceAmountText(total, parsed > 0), parsed: parsed > 0 }
}

/**
 * 「按主体」分组的行模型：一个主体一组，组下挂该主体的**全部店铺**（店铺行可点击进入店铺详情）。
 *
 * 三条纪律：
 *   · 归属用 licenseGroups.keyByStore 这**一张**归属表（见 shared/store-license.ts 文件头——
 *     不能各店各算一遍 licenseKeyOf，否则"胶囊写 2 家、组里只有 1 家"）；同一执照下的多家店
 *     自动并到一块，没填执照的单独一组固定排最后（排序规则在 shared 的 groupStoresByLicense 里）。
 *   · **不许静默丢行**：行对应的店铺若暂时不在 ws.stores（刷新时序），兜底归入「未填写」组里显示，
 *     而不是像旧实现那样 `|| ''` + continue 无声吞掉（那会让"店里有票、屏上没店"变成无痕迹的假象）。
 *   · 数字口径与 KPI / 胶囊 / 导出完全一致（待开票条数与金额来自 licenseSummary）。
 *     「金额占比」的分母必须是**金额**，不是条数（2026-10-15 审查 BUG，实测按条数会把结论看反）；
 *     总额 ≤ 0（整批退款冲正、或全是 0 元）时不给比例：分母没有意义，条只能画最小宽度。
 *
 * 口径跟随左侧选中的主体（选了 A 就只汇总 A）——与 KPI 一致，避免两处数字对不上。
 */
const invoiceSubjectGroups = computed(() => {
  const groups = licenseSummary.value.items
  const totalAmount = groups.reduce((sum, group) => sum + group.amount, 0)
  const shareOf = (amount: number): { width: string; pct: number | null } => {
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) return { width: '2%', pct: null }
    const pct = amount / totalAmount * 100
    return { width: `${Math.max(2, Math.min(100, Math.round(pct)))}%`, pct }
  }
  // 行 → 组：每行必须落到一个组里（兜底 NO_LICENSE_KEY，见上方说明），组内保持载荷顺序（不擅自重排）
  const rowsByKey = new Map<string, any[]>()
  for (const row of invoiceAllRows.value) {
    const key = licenseGroups.value.keyByStore.get(row.storeId) || NO_LICENSE_KEY
    const list = rowsByKey.get(key) || []
    list.push(row)
    rowsByKey.set(key, list)
  }
  return groups
    .filter(group => !activeLicense.value || group.key === activeLicense.value)
    .map(group => {
      const share = shareOf(group.amount)
      const label = group.label || '未填写营业执照'
      const groupRows = rowsByKey.get(group.key) || []
      const stores = groupRows.map((row: any) => ({
        storeId: String(row.storeId),
        storeName: String(row.storeName || row.storeId),
        platform: String(row.platform || ''),
        count: Number(row.count || 0),
        amountText: invoiceRowAmountText(row),
        capturedAt: Number(row.capturedAt) || null,
        loginRequired: !!row.loginRequired,
        lastFailed: !!row.lastFail,
        failTitle: row.lastFail
          ? `最近一次采集失败${row.lastFail.at ? `（${formatTime(Number(row.lastFail.at))}）` : ''}：${row.lastFail.message || row.lastFail.code || '未知原因'}`
          : '',
        supported: row.supported !== false,
        unsupportedReason: String(row.unsupportedReason || ''),
        // 「本次没读到」如实上屏（与按店铺视图同一条规矩：不能把上一次的数据静默当成本次结果）
        emptyNote: (row.sections || [])
          .filter((sec: any) => !!sec.emptyNote)
          .map((sec: any) => `「${sec.name}」${sec.emptyNote}`)
          .join('；'),
        needsLicense: !row.licenseName && !row.licenseNo
      }))
      return {
        key: group.key,
        label,
        no: group.no || '',
        // 家数以**列出来的店铺行**为准：屏上"N 家"与下面实际有几行必须对得上
        storeCount: stores.length,
        pendingCount: group.pendingCount,
        amountText: group.amountText,
        unparsed: group.unparsed,
        historyCount: groupRows.reduce((sum: number, row: any) => sum + Number(row.historyCount || 0), 0),
        share: share.width,
        shareText: share.pct == null ? '占比 —' : `占比 ${share.pct >= 10 ? Math.round(share.pct) : share.pct.toFixed(1)}%`,
        // 条上没有数字，把确切比例挂到 title 上——否则用户只能看个大概长短
        shareTitle: share.pct == null
          ? `${label}：本口径下可开金额合计不大于 0，算不出占比`
          : `${label}：可开金额 ${group.amountText}，占本口径 ${share.pct.toFixed(1)}%（按金额，不是按条数）`,
        stores
      }
    })
})

/** 平台覆盖：哪个平台登记了真机实测档案、有几个开票方向（没档案的如实说明，不给假锚点） */
const invoicePlatformCoverage = computed(() => {
  const names = new Set<string>()
  for (const store of ws.stores) names.add(String(store.platform || ''))
  for (const row of invoiceRows.value) names.add(String(row.platform || ''))
  return [...names].filter(Boolean).map(platform => {
    const profile = invoiceProfileFor(platform)
    return {
      platform,
      measured: !!profile,
      note: profile
        ? `${profile.sections.length} 个开票方向 · 实测日期 ${profile.measuredAt}`
        : '尚未实测到可读取的发票页——不登记假锚点，界面如实说明而不是拿猜的选择器去试'
    }
  })
})

/** 导出 CSV 的列（照着主进程给的统一列拼，列名不在这里硬编码） */
const invoiceCsvColumns = computed(() => {
  const labels = ((invoiceData.value?.columns || []) as Array<{ label?: string }>).map(col => String(col.label || '')).filter(Boolean)
  return [...labels, '店铺', '营业执照', '统一社会信用代码', '是否待办'].join(' · ')
})

/** 行内排序：按"该店待开票金额"；一条金额都解析不出的店排在最后，而不是当 0 排在最前 */
function invoiceRowSortKey(row: any): number | null {
  const { total, parsed } = invoiceRowAmount(row)
  return parsed ? total : null
}

/* ==================== 涉税信息报送（平台按季度报送给税务机关的经营数据） ==================== */

/**
 * 平台自己写的用途限制。**必须与数据同屏显示**。
 * 快手该页原文：数据"不得作为税务申报、财务审计、监管备案等任何用途使用"。
 * 把这份数据摆到发票中心（用户拿它做申报的地方）却不带这句话，等于应用在替平台背书——
 * 而平台恰恰说了不能用。所以它随接口一起回来，界面如实展示。
 */
const taxDisclaimer = computed(() => String(taxData.value?.disclaimer || ''))
/** 报送依据（同页原文），用来交代这份数据到底是什么 */
const taxBasis = computed(() => String(taxData.value?.basis || ''))
const taxRows = computed<any[]>(() => taxData.value?.rows || [])
/** 已实测可采集涉税报送的平台（说明文案里如实列出，未实测的照实说不支持） */
const taxSupportedPlatforms = TAX_SUPPORTED_PLATFORMS
/**
 * 涉税数据的看法：**按主体** / 按店铺。
 *
 * 默认按主体：平台按季度报送的是"你这个纳税人"的收入，同一家公司在几家店的数据
 * 在税务机关眼里是**同一个主体的一份收入**；按店铺列，用户得自己拿计算器加。
 */
const taxView = ref<'subject' | 'stores'>('subject')
/** 展开查看某主体的逐期明细（空 = 都收起） */
const taxExpandedSubject = ref('')

/**
 * 按主体归组的报送数据（归组规则与金额口径在 shared/tax-subject.ts，有 19 条单测）。
 * 入参里的 licenseName/licenseNo 来自主进程，用来核对"平台报的主体"与"你填的执照"。
 */
const taxSubjectGroups = computed(() => groupTaxPeriodsBySubject(taxRows.value as any))
const taxSubjectTotal = computed(() => taxSubjectTotals(taxSubjectGroups.value))

/** 主体显示名（读不到主体信息时给一个明确的桶名，而不是空着） */
function taxSubjectLabel(group: any): string {
  return group?.label || (group?.key === UNKNOWN_TAX_SUBJECT_KEY ? UNKNOWN_TAX_SUBJECT_LABEL : '（未读到主体名称）')
}

/**
 * 平台报送主体 vs 店铺营业执照。
 *
 * 为什么单独做这一句：申报是按主体报的，而"平台报的是哪家公司"与"你执照里填的是哪家公司"
 * 不一致时，报出去就是错的主体——这件事必须在申报前被看见，而不是等税务比对出异常。
 */
function taxLicenseVerdictText(group: any): { text: string; tone: 'ok' | 'warn' | 'err' } {
  if (!group) return { text: '', tone: 'warn' }
  // 主体是**从店铺营业执照推来的**（平台页面没给主体信息，实测抖店就是这种）→
  // 必须说清来源。写成"与执照一致"是循环论证：那个主体本来就是拿执照填的。
  if (group.subjectSource === 'license') return { text: '主体取自店铺营业执照（平台页面未给主体）', tone: 'warn' }
  // 走到这里只有一种可能：页面没给主体、店里也没填营业执照（填了就会标 license）。
  // 所以直接给可执行的下一步，而不是一句"没有可核对的主体信息"。
  if (group.subjectSource === 'unknown') return { text: '平台页面未给主体，且店铺未填营业执照 —— 补填后即可归入主体', tone: 'warn' }
  if (group.licenseVerdict === 'mismatch') {
    return { text: `与执照不一致：${group.mismatchedStores.join('、')}`, tone: 'err' }
  }
  if (group.licenseVerdict === 'store-empty') {
    return { text: `还没填营业执照：${group.unlicensedStores.join('、')}`, tone: 'warn' }
  }
  if (group.licenseVerdict === 'match') return { text: '与已填执照一致', tone: 'ok' }
  return { text: '没有可核对的主体信息', tone: 'warn' }
}

function taxCellOf(row: any, key: string): string {
  return String(row?.cells?.[key] ?? '')
}
/** 货物口径的三段：快手是"一格三段式文本"、抖店是"三列分开"——统一走 taxIncomeFromCells 适配 */
function taxGoods(row: any) { return taxIncomeFromCells(row?.cells, 'goods') }
/** 服务口径的三段（同上） */
function taxService(row: any) { return taxIncomeFromCells(row?.cells, 'service') }
/**
 * 该报送期的申报口径净额：**平台给了「收入净额合计」就用它的**（实测抖店有这一列），
 * 没给才用 货物净额 + 服务净额（实测快手）。任一段缺失且平台也没给 → null（宁可显示「—」）
 */
function taxRowNet(row: any): number | null { return taxPeriodNetOf(row?.cells, taxGoods(row), taxService(row)) }
/**
 * 平台给的三段是否自洽（`金额 − 退款 = 净额`）。false = 平台自己的数对不上——
 * 申报前正是要被看见的那种事，所以单独标出来而不是替它圆过去。
 */
function taxRowReconciles(row: any): boolean | null {
  const goods = taxGoods(row); const service = taxService(row)
  if (goods.reconciles === false || service.reconciles === false) return false
  if (goods.reconciles === null && service.reconciles === null) return null
  return true
}
/** 某店的报送期汇总：期数 + 能算出来的净额合计（解析不出的期**不计入**并单独计数） */
function taxStoreSummary(storeRow: any) {
  let periods = 0; let net = 0; let netParsed = 0; let unparsed = 0
  for (const section of storeRow?.sections || []) {
    for (const item of section.items || []) {
      periods++
      const value = taxRowNet(item)
      if (value == null) unparsed++
      else { net += value; netParsed++ }
    }
  }
  return { periods, netParsed, unparsed, netText: taxAmountText(netParsed ? Math.round(net * 100) / 100 : null) }
}
/** 该店**有数据**的报送方向（没数据的整段不渲染，避免一大片空表） */
function taxSectionsWithItems(storeRow: any): any[] {
  return (storeRow?.sections || []).filter((section: any) => (section.items?.length || 0) > 0)
}
/**
 * 该店**本次没读到**的报送方向（采集侧 expected=false 的空标记，读取侧带出来的 emptyNote）。
 *
 * 为什么必须有它（2026-10-15 审查 H2）：发票分区对"本次没读到但有旧数据"会标红提示
 * （inv-sec-empty），涉税分区此前漏了——"本次没读到"时界面把**上一次的数据连旧时间一起**
 * 当当前结果显示，用户以为读到了。这里逐方向如实列出。
 */
function taxEmptyNotes(storeRow: any): Array<{ metricKey: string; name: string; emptyNote: string; emptyAt: number | null }> {
  return (storeRow?.sections || [])
    .filter((section: any) => !!section.emptyNote)
    .map((section: any) => ({
      metricKey: String(section.metricKey || ''),
      name: String(section.name || '涉税信息报送'),
      emptyNote: String(section.emptyNote),
      emptyAt: section.emptyAt || null
    }))
}

/**
 * 打开行内补录时，**从 `ws.stores` 取最新值**，不用一次性 IPC 载荷里的旧值。
 *
 * 为什么：这一行如果刚从行内保存过（或刚被「获取主体营业执照」写过），载荷里的 row 还是旧的。
 * 按旧 row 回填会把编辑框填成旧的空值——用户看着"没填上"再点一次保存，就把刚落库的主体清空了
 * （空串在 schema 里合法）。旧实现刻意避开过这一点（见已废弃弹窗的注释）。
 */
function openLicenseEditor(row: any) {
  const fresh = ws.stores.find(item => item.id === row.storeId)
  licenseEditingId.value = row.storeId
  // 店铺在 ws.stores 里就以它为准（哪怕它是空的）——否则"清空执照 + 载荷还是旧值"时，
  // 回填会把已清空的旧主体塞回输入框，再点一次保存就等于把清空撤销了
  licenseDraft.name = fresh ? (fresh.licenseName || '') : (row.licenseName || '')
  licenseDraft.no = fresh ? (fresh.licenseNo || '') : (row.licenseNo || '')
  licenseEditError.value = ''
}

/** 只重取发票载荷（不整页 loading、不重置滚动位置）：行内改完主体、取完主体后用 */
async function reloadInvoiceData() {
  const res = await window.shopilot.overview.invoiceCenter()
  if (res.ok) invoiceData.value = res.data
}

/** 只重取涉税报送载荷（同上：采集完刷新，但不整页 loading） */
async function reloadTaxData() {
  const res = await window.shopilot.overview.taxReport()
  if (res.ok) taxData.value = res.data
}

async function saveLicense(row: any) {
  licenseSaving.value = true
  licenseEditError.value = ''
  const result = await ws.setStoreLicense(row.storeId, licenseDraft.name.trim(), licenseDraft.no.trim())
  licenseSaving.value = false
  if (!result.ok) { licenseEditError.value = result.message || '保存失败'; return }
  licenseEditingId.value = ''
  // 保存成功后只重取发票载荷：行上的主体标签与「营业执照」胶囊都跟着刷新，而又不会把整页
  // 换成"正在读取本机数据…"（那会丢掉滚动位置）。
  await reloadInvoiceData()
  ws.toast('营业执照已保存', 'success')
}

/**
 * 「按主体」分组视图里正在编辑的店铺属于哪个组（编辑器挂在那一组下面）。
 * 兜底 NO_LICENSE_KEY 与行分桶同口径——绝不出现"编辑框开了、但不在任何组里"。
 */
const licenseEditingGroupKey = computed(() => (
  licenseEditingId.value ? (licenseGroups.value.keyByStore.get(licenseEditingId.value) || NO_LICENSE_KEY) : ''
))

/** 分组视图的「保存」：没有行对象，按正在编辑的 storeId 找回那一行，走同一套 saveLicense 纪律 */
async function saveLicenseInGroup(): Promise<void> {
  const row = invoiceAllRows.value.find(item => item.storeId === licenseEditingId.value)
  if (!row) return
  await saveLicense(row)
}

/** 未填写组的「去补录」：先展开该组（收起来了就看不见编辑器），再打开第一家未填执照店铺的行内编辑器 */
function startFillLicense(group: any): void {
  if (isSubjectCollapsed(group.key)) toggleSubjectGroup(group.key)
  const first = (group.stores || []).find((row: any) => row.needsLicense) || group.stores?.[0]
  if (first) openLicenseEditor(first)
}

/** 店铺名（结果面板里按 storeId 反查；取不到就退回主进程给的名字） */
function storeNameOf(storeId: string): string {
  return ws.stores.find(store => store.id === storeId)?.name || storeId
}

/**
 * 「平台读到的主体」与「已填主体」的对照结论——规则在 shared（compareStoreEntity/entityVerdictText，有单测）：
 * 平台没读到的字段说"未比对"，店里空着而平台读到的是"可补录"，只有真比过的字段才配说"一致"。
 */
function entityVerdict(row: any): string {
  return entityVerdictText(row, row.entity)
}

/** 「获取主体营业执照」结果里每行的一句话（照实说：填了什么、哪不一致、为什么取不了） */
function entityReportText(r: any): string {
  const written = r.written || {}
  // 平台值是哪次读的：写回可能用的是**旧快照**（这次没采到），不说清时间就会被当成"刚读到的"
  const readAt = r.entity?.capturedAt ? `（平台值读于 ${formatTime(r.entity.capturedAt)}）` : ''
  if (r.status === 'fill') {
    const parts: string[] = []
    if (written.licenseName) parts.push(`名称「${written.licenseName}」`)
    if (written.licenseNo) parts.push(`统一社会信用代码「${written.licenseNo}」`)
    return `已填入 ${parts.join(' + ')}${readAt}`
  }
  if (r.status === 'same') {
    // 「一致」只留给**比过的**字段：平台只读到一项时，另一项明说没比对
    const readName = !!r.entity?.name
    const readNo = !!r.entity?.no
    if (readName && readNo) return `平台读到的主体与已填一致，未改动${readAt}`
    const read = readName ? '名称' : '信用代码'
    const notRead = readName ? '信用代码' : '名称'
    return `平台读到的${read}与已填一致，未改动${readAt}；${notRead}平台没读到，未比对`
  }
  if (r.status === 'start-failed') return `这次没能开始采集：${r.note || '未知原因'}——结果里的结论来自上一次采集`
  if (r.status === 'conflict') {
    return '平台读到的与你已填的不一致——没有覆盖你的填写，请自己核对：' +
      (r.conflicts || []).map((c: any) => `${c.field === 'licenseName' ? '名称' : '信用代码'}：已填「${c.existing}」／平台「${c.fetched}」`).join('；')
  }
  if (r.status === 'nothing') {
    if (!(r.rejected || []).length) return '平台页面上没读到主体信息——该店可能是个人店铺（本来没有营业执照），也可能页面已改版；没有写入任何值'
    return '平台给的值不可用（未写入）：' + (r.rejected || []).map((x: any) => `${x.field === 'licenseName' ? '名称' : '信用代码'} ${x.raw}——${x.why}`).join('；')
  }
  if (r.status === 'no-data') return r.note || '还没有采到该店的主体信息'
  if (r.status === 'unsupported') return '该平台暂不能自动获取：' + (r.note || entityUnsupportedNote(r.platform))
  return String(r.status)
}

/** 已实测主体信息页的平台（按钮 tooltip 里如实写出来，免得用户以为"某家没处理"） */
const entitySupportedPlatforms = ENTITY_SUPPORTED_PLATFORMS

/** 补录主体时的名称候选：已填过的 + 平台读回来的（都去重、去空） */
const licenseNameOptions = computed<string[]>(() => {
  const names = new Set<string>()
  for (const store of ws.stores) {
    const name = normalizeLicenseName(store.licenseName)
    if (name) names.add(name)
  }
  for (const row of invoiceAllRows.value) {
    const name = normalizeLicenseName(row.entity?.name)
    if (name) names.add(name)
  }
  return [...names]
})

/**
 * 跳转该店的「开票地址」。地址口径（与采集口径一致，宁缺毋滥）：
 *   ① 有实测档案的平台 → 档案里的发票页（就是采集读的那一页，如 store.weixin.qq.com/shop/bill/home）；
 *   ② 没档案的平台 → 退回该店自己的后台地址，并在 tooltip 里如实写明"尚未实测到发票页"；
 *   ③ 两者都没有 → 返回空串，按钮置灰（不猜地址）。
 */
function invoiceOpenUrl(row: any): string {
  return String(row?.pageUrl || row?.adminUrl || '')
}
function invoiceOpenLabel(row: any): string {
  if (row?.pageUrl) return '打开开票页'
  return row?.adminUrl ? '打开后台' : '无地址'
}
function invoiceOpenTitle(row: any): string {
  const url = invoiceOpenUrl(row)
  if (!url) return '这家店既没有实测的发票页，也没有后台地址——先在店铺页补一个后台地址'
  return row?.pageUrl
    ? `在该店浏览器里打开开票页：${url}`
    : `该平台尚未实测到可读取的发票页，改为打开后台首页：${url}`
}

/**
 * 打开开票页：确保店铺浏览器已打开并显示 → 切到该店浏览器页 → **新标签页**直达开票地址。
 *
 * 为什么新开标签页而不是覆盖当前页：用户可能正在那家店里做事（刚提交完发票、正在填表），
 * 覆盖掉就把他的上下文弄丢了；新标签页用完随手关即可。
 */
async function openInvoicePage(row: any) {
  const url = invoiceOpenUrl(row)
  if (!url) { ws.toast('这家店没有可跳转的地址（该平台尚未实测到发票页）', 'info'); return }
  // 先自己把店铺开起来（await 得到结果），再让父组件切页——emit 不返回 Promise，不能反过来依赖它
  if (!ws.openStoreIds.includes(row.storeId) || ws.displayedStoreId !== row.storeId) {
    await ws.openStore(row.storeId)
  }
  emit('open-store', row.storeId)
  await ws.newTab(url)
  ws.toast(`已打开「${row.storeName}」的开票页`, 'success')
}

/** 去登录：打开该店的**后台首页**（登录态失效时用户在后台扫码/登录，不是在发票页上） */
async function openStoreAdmin(row: any) {
  const url = String(row?.adminUrl || row?.pageUrl || '')
  if (!url) { ws.toast('这家店没有可打开的后台地址', 'info'); return }
  if (!ws.openStoreIds.includes(row.storeId) || ws.displayedStoreId !== row.storeId) {
    await ws.openStore(row.storeId)
  }
  emit('open-store', row.storeId)
  await ws.newTab(url)
  ws.toast(`已打开「${row.storeName}」的后台，登录后回发票中心点「采集发票数据」`, 'success')
}

/**
 * 点击「按主体」分组里的店铺行 → 进入该店的**店铺详情**（工作台里的该店浏览器视图）。
 *
 * 与「打开开票页 / 去登录」同一套纪律：先自己把店铺开起来（await 得到结果），再 emit 让父组件
 * 切页——emit 不返回 Promise，不能反过来依赖它。已打开且正在显示的店不重复打开（openStore 幂等）。
 */
async function openStoreDetail(row: any) {
  if (!ws.openStoreIds.includes(row.storeId) || ws.displayedStoreId !== row.storeId) {
    await ws.openStore(row.storeId)
  }
  emit('open-store', row.storeId)
}

/**
 * A1：明细表的列与取值。
 *
 * 为什么列要**按方向动态裁**：payload 的统一列有 8 列（INVOICE_COLUMNS + 其他信息），
 * 但每个平台只填其中几列（抖店 4 列、拼多多 15 列），全摊出来是一大片"—"。
 * 这里只保留"这个方向至少有一条非空值"的列，外加有值时的「其他信息」（未映射列）。
 */
const openSections = ref<Record<string, boolean>>({})
function sectionKey(section: any): string { return String(section?.metricKey || section?.name || '') }
function isSectionOpen(section: any): boolean { return !!openSections.value[sectionKey(section)] }
function toggleSection(section: any) {
  const key = sectionKey(section)
  openSections.value = { ...openSections.value, [key]: !openSections.value[key] }
}
/** 该店当前展开的方向（用于渲染明细区块） */
function openDetailSections(row: any): any[] {
  return (row?.sections || []).filter((section: any) => (section.items?.length || 0) > 0 && isSectionOpen(section))
}
function sectionColumns(section: any): Array<{ key: string; label: string }> {
  const columns = (invoiceData.value?.columns || []) as Array<{ key: string; label: string }>
  const items = (section?.items || []) as any[]
  const used = columns.filter(col => items.some(item => String(item?.cells?.[col.key] ?? '').trim() !== ''))
  const hasExtras = items.some(item => (item?.extras || []).length > 0)
  const out = used.map(col => ({ key: col.key, label: col.label }))
  if (hasExtras) out.push({ key: '__extras', label: '其他信息' })
  return out
}
function detailCell(item: any, key: string): string {
  if (key === '__extras') return (item?.extras || []).map((x: any) => `${x.label}：${x.value}`).join('；')
  return String(item?.cells?.[key] ?? '')
}
function invoiceRowAmount(row: any): { total: number; parsed: number; text: string } {
  let total = 0
  let parsed = 0
  for (const section of row?.sections || []) {
    if (!isPendingSection(section)) continue
    for (const item of section.items || []) {
      const amount = parseInvoiceAmount(item.cells?.amount)
      if (amount == null) continue
      total += amount
      parsed++
    }
  }
  return { total, parsed, text: invoiceAmountText(total, parsed > 0) }
}
function invoiceRowAmountText(row: any): string {
  return invoiceRowAmount(row).text
}
const metricRows = computed(() => {
  const rows = new Map<string, any>()
  for (const store of ws.stores) rows.set(store.id, { storeId: store.id, storeName: store.name, platform: store.platform, values: {}, manual: {}, lastAt: 0 })
  for (const snapshot of snapshotRows.value) { const row = rows.get(snapshot.storeId); if (!row || !String(snapshot.metric).startsWith('biz.')) continue; row.values[snapshot.metric] = snapshot.value; row.manual[snapshot.metric] = !!snapshot.manual; row.lastAt = Math.max(row.lastAt, Number(snapshot.capturedAt) || 0) }
  return [...rows.values()]
})
const manualReady = computed(() => !!manual.storeId && manual.value != null && Number.isFinite(Number(manual.value)) && Number(manual.value) >= 0)
function displayValue(value: unknown) { return value == null || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value) }
function formatTime(value: number) { return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
function formatValue(value: unknown, key: string) { const number = typeof value === 'number' ? value : Number(value); if (!Number.isFinite(number)) return '—'; return key.includes('gmv') || key.includes('Amount') ? `¥ ${number.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}` : number.toLocaleString('zh-CN') }
async function load() {
  // P1-7（2026-10-15 审查）：无 preload（纯渲染调试模式）时给出降级提示，而不是 TypeError 白屏
  if (!window.shopilot) {
    errorMessage.value = '原生桥接不可用（纯渲染模式）：数据中心无法加载'
    return
  }
  loading.value = true
  errorMessage.value = ''
  try {
    const responses = await Promise.all([
      window.shopilot.overview.datacenter(),
      window.shopilot.overview.orders(),
      window.shopilot.overview.invoiceCenter(),
      window.shopilot.overview.taxReport(),
      window.shopilot.settings.get(AUTO_COLLECTION_SETTING)
    ])
    if (!responses[0].ok) throw new Error(responses[0].error.message)
    dataCenter.value = responses[0].data
    // B3：单个通道失败**不能**退化成空列表——发票中心读取失败与"确实没采过"在屏上必须能分辨
    const failed: string[] = []
    if (!responses[1].ok) failed.push(`订单快照读取失败：${responses[1].error.message}`)
    if (!responses[2].ok) failed.push(`发票数据读取失败：${responses[2].error.message}`)
    if (!responses[3].ok) failed.push(`涉税报送数据读取失败：${responses[3].error.message}`)
    orderData.value = responses[1].ok ? responses[1].data : null
    invoiceData.value = responses[2].ok ? responses[2].data : null
    taxData.value = responses[3].ok ? responses[3].data : null
    /**
     * 自动采集总开关（`collection.autoEnabled`，主进程 fail-closed 读它）。
     *
     * 为什么界面上要单独读它：任务上挂着 `everyMs` **不等于**会自动跑——总开关关着时
     * 调度器直接 return（scheduler.ts 的 isAutoCollectionEnabled 分支）。只看任务周期就会
     * 把"挂着但永远不会触发"显示成"已启用"（2026-10-15 审查确认的假状态）。
     * 读失败按**关**处理；解析用 shared 的 `parseAutoCollectionEnabled`——它兼容历史值
     * （1 / "true" / "1"），以前这里手写 `=== true`，存量值会让屏上显示"总开关是关的"
     * 而主进程实际在跑（与上面同一类假状态，2026-10-15 审查 M3）。
     */
    autoCollectionOn.value = responses[4]?.ok ? parseAutoCollectionEnabled(responses[4].data?.value) : false
    if (failed.length) errorMessage.value = failed.join('；')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error)
  } finally { loading.value = false }
}
/** 发票自动采集周期：3 小时（用户要求「发票中心三个小时更新一次」） */
const INVOICE_SCHEDULE_MS = 3 * 60 * 60 * 1000
/**
 * 自动采集总开关是否打开。**默认 false**（与主进程 fail-closed 同口径）：
 * 读不到就按"不会自动跑"显示，绝不乐观地告诉用户"已在自动更新"。
 * 键与解析都用 shared/constants/collection 的导出（单一事实来源，以前手抄字面量会漂移）。
 */
const autoCollectionOn = ref(false)
// INVOICE_TASK_PREFIX 来自 @shared/constants/invoice（单一事实来源）：
// 这里用它**认领**同一个采集任务，任务中心/概览那边用同一条规则把它**排除**在任务之外。

type CollectKind = 'business' | 'orders' | 'invoice' | 'tax'

/** 该平台在这个采集域下的档案（没有 = 抓不了；界面按域分别如实说明，不混成一句"暂不支持"） */
function collectProfileOf(kind: CollectKind, platform: string): any {
  if (kind === 'business') return businessProfileFor(platform)
  if (kind === 'orders') return ordersProfileFor(platform)
  if (kind === 'tax') return taxProfileFor(platform)
  return invoiceProfileFor(platform)
}

/** 该采集域的步骤构造（每域一份；档案形状不同，各自有单测） */
function collectStepsOf(kind: CollectKind, profile: any): any[] {
  if (kind === 'business') return buildBusinessCollectSteps(profile as BusinessProfile)
  if (kind === 'orders') return buildOrdersCollectSteps(profile as OrdersProfile)
  if (kind === 'tax') return buildTaxCollectSteps(profile as TaxProfile)
  return buildInvoiceCollectSteps(profile as InvoiceProfile)
}

/** 采集任务名（带前缀的域便于复用时按前缀认领同一个任务） */
function collectTaskName(kind: CollectKind, storeName: string) {
  if (kind === 'business') return `经营指标采集 · ${storeName}`
  if (kind === 'orders') return `订单明细采集 · ${storeName}`
  if (kind === 'tax') return `${TAX_TASK_PREFIX}${storeName}`
  return `${INVOICE_TASK_PREFIX}${storeName}`
}

/**
 * 复用已有任务，而不是每点一次就新建一个。
 *
 * 原实现每次点「采集」都 task.create 一个新任务——实测点两轮就留下
 * 「发票采集 · 抖店」「发票采集 · 抖店 · 2026/9/15」一串同名任务：任务中心越堆越多，
 * 而定时更新只能挂在其中一个上（挂错就等于没挂）。这里按"店铺 + 名称前缀"认领一个，
 * 把步骤与周期一起更新到它身上。
 *
 * 认领口径与开关/状态条**必须一致**：统一走 shared 的 `pickLatestCollectTask`
 * （取 `updatedAt` 最新）——以前认领按 updatedAt、开关按列表序，库里若有历史重复
 * 任务，改周期的和跑数据的可能不是同一个（2026-10-15 审查 C3）。
 *
 * 返回值带 `updateWarning`：任务正有未结束的运行 → 含 steps 的更新会被主进程拒
 * （TASK_BAD_STATE，task-store.updateTask）；此时**去掉 steps 重试**（name/schedule
 * 在运行中本就允许改），两次都失败才把原因交给调用方如实展示——不能一边宣称
 * "每 3 小时自动更新"，一边实际什么都没写上（2026-10-15 审查 C2）。
 */
async function ensureCollectTask(kind: CollectKind, store: any, steps: any[], schedule: unknown): Promise<{ taskId: string; updateWarning: string | null }> {
  const name = collectTaskName(kind, store.name)
  const listed = await window.shopilot.task.list()
  const existing = pickLatestCollectTask(listed.ok ? (listed.data as any[]) : [], store.id, collectTaskName(kind, ''))
  if (existing) {
    const updated = await window.shopilot.task.update({ taskId: existing.id, name, steps, schedule })
    if (updated.ok) return { taskId: String(existing.id), updateWarning: null }
    // 含 steps 的更新被拒（多为正有未结束的运行）→ 不带 steps 重试：name/schedule 在运行中允许改，
    // 重试成功则周期确实挂上了，toast 才不是假话；仍失败才把原因带走如实展示。
    const retried = await window.shopilot.task.update({ taskId: existing.id, name, schedule })
    return { taskId: String(existing.id), updateWarning: retried.ok ? null : String(retried.error?.message || '配置更新被拒') }
  }
  const created = await window.shopilot.task.create({ name, storeScope: store.id, steps, schedule })
  return { taskId: created.ok ? String((created.data as any).id) : '', updateWarning: null }
}

async function createCollectionTasks(kind: CollectKind) {
  const supported = ws.stores.filter(store => !!collectProfileOf(kind, store.platform))
  if (!supported.length) { ws.toast('当前没有已实测的可采集平台，系统不会猜测页面选择器', 'info'); return }
  collecting.value = true
  let created = 0
  /** 任务配置没能写上的店（原因只记第一条）：toast 必须如实说，不能宣称"已挂上周期"（C2） */
  const stuck: string[] = []
  let stuckWhy = ''
  try {
    for (const store of supported) {
      const profile = collectProfileOf(kind, store.platform)
      if (!profile) continue
      if (!ws.openStoreIds.includes(store.id)) await window.shopilot.browser.open(store.id)
      const steps = collectStepsOf(kind, profile)
      // 只有发票采集挂周期（每 3 小时）：经营指标已有自己的 10 分钟调度器，给任务再挂一次
      // 会变成两套调度各跑一遍；涉税报送**按季度**更新，3 小时一轮没有意义，保持手动采集。
      const schedule = kind === 'invoice' ? { everyMs: INVOICE_SCHEDULE_MS, backgroundOpen: true } : undefined
      const claimed = await ensureCollectTask(kind, store, steps, schedule)
      if (!claimed.taskId) continue
      if (claimed.updateWarning) { stuck.push(store.name); stuckWhy = stuckWhy || claimed.updateWarning }
      const run = await window.shopilot.task.run(claimed.taskId)
      if (run.ok) created++
    }
    await ws.refreshTasks()
    /**
     * 只有**总开关确实打开**时才敢说"会自动更新"。
     *
     * 任务上挂了 `everyMs` ≠ 会自动跑：总开关关着时调度器直接 return（scheduler.ts）。
     * 以前这里无条件写"发票每 3 小时自动更新一次"——实测总开关是 false，这句是假话，
     * 用户会以为数据在自动刷新（2026-10-15 审查确认）。
     */
    const suffix = kind === 'invoice'
      ? (autoCollectionOn.value
          ? '；发票每 3 小时自动更新一次'
          : '；注意：自动采集总开关是关的，这批任务不会自动跑——要自动更新请点上方「开启每 3 小时自动更新」')
      : kind === 'tax' ? '；报送数据按季度更新，下一季再采一次即可' : ''
    // 配置没写上的店必须在同一条 toast 里点名（C2）：否则用户会以为周期已挂、或在任务中心找不到原因
    const stuckNote = stuck.length
      ? `；注意：${stuck.length} 家（${stuck.join('、')}）的任务配置未能更新（${stuckWhy}），本次先按原配置执行`
      : ''
    ws.toast(created ? `已启动 ${created} 个采集任务${suffix}${stuckNote}` : `采集任务未能启动，请查看任务中心${stuckNote}`, created ? 'success' : 'error')
  } finally { collecting.value = false }
}

/** 主体采集任务名前缀（与发票采集同样"认领同一个"，免得任务中心堆一串同名任务） */
const ENTITY_TASK_PREFIX = '主体信息采集 ·'

async function ensureEntityCollectTask(store: any, steps: any[]): Promise<string> {
  const name = `${ENTITY_TASK_PREFIX}${store.name}`
  const listed = await window.shopilot.task.list()
  const existing = pickLatestCollectTask(listed.ok ? (listed.data as any[]) : [], store.id, ENTITY_TASK_PREFIX)
  if (existing) {
    // 任务正有未结束的运行 → 步骤改不了（主进程会拒），去掉 steps 重试一次把名字写上，
    // 仍用它跑一次：步骤由档案推导，本来就不随点击变化（与 C2 同一处置）
    const updated = await window.shopilot.task.update({ taskId: existing.id, name, steps })
    if (!updated.ok) await window.shopilot.task.update({ taskId: existing.id, name })
    return String(existing.id)
  }
  const created = await window.shopilot.task.create({ name, storeScope: store.id, steps })
  return created.ok ? String((created.data as any).id) : ''
}

/**
 * 「获取主体营业执照」：去平台后台把**本店自己的主体**读回来，再按主进程的判定写进店铺。
 *
 * 两步分开（都复用既有机制）：
 *  1. 采集：只对**已实测主体信息页**的平台建只读采集任务（navigate → readLabelValue×N → 快照 entity.name/no）；
 *  2. 写回：`overview.entityApply()` 按快照决定写不写——**空则填；与已填不一致不覆盖**，两边都报出来（错一个公司就是错票）。
 * 未实测的平台（微信小店：主体卡是 display:none 且代码掩码；抖店/拼多多：当时登录态过期，没测到页）
 * **不猜选择器**，它们的店铺会在结果里以 unsupported + 原因如实列出。
 */
async function collectStoreEntities() {
  const generation = ++entityCollectGeneration
  const supported = ws.stores.filter(store => !!entityProfileFor(store.platform))
  entityCollecting.value = true
  entityReport.value = []
  try {
    // 说明：即使一家都没有已实测的平台，也**仍然走一遍写回**——结果面板会把每家"为什么取不了"写清楚，
    // 而不是让用户对着一句"没有需要新填的主体"猜（最终提示见函数末尾）。
    const runIds: string[] = []
    /** runId → 店名：等待时要说清"还在等哪一家"，而不是只报一个数字 */
    const runStore = new Map<string, string>()
    // 逐店记"这次没能开始采集"的原因：不记的话，一家都没跑起来时界面会安安静静地
    // 回一句"没有需要新填的主体"，而那句结论其实来自上一次的旧快照（比报错更危险）。
    const startFailures = new Map<string, string>()
    for (const store of supported) {
      if (generation !== entityCollectGeneration) return
      if (!ws.openStoreIds.includes(store.id)) {
        // 引擎不静默拉起店铺浏览器（§4.4）：用户点这个按钮就是要采这几家 → 显式打开。
        // 注意 browser.open 是**返回 {ok:false}** 而不是抛异常，必须看返回值。
        const opened = await window.shopilot.browser.open(store.id)
        if (!opened.ok) {
          startFailures.set(store.id, `店铺浏览器没能打开（${opened.error?.message || '未知原因'}）——采集要等页面就绪`)
          continue
        }
      }
      const taskId = await ensureEntityCollectTask(store, buildEntityCollectSteps(entityProfileFor(store.platform)!) as any[])
      if (!taskId) { startFailures.set(store.id, '采集任务没能创建（可去任务中心看原因）'); continue }
      const run = await window.shopilot.task.run(taskId)
      const runId = run.ok ? String((run.data as any)?.runId || '') : ''
      if (!runId) {
        startFailures.set(store.id, `采集任务没能启动（${run.ok ? '没有返回运行 id' : run.error?.message || '未知原因'}）`)
        continue
      }
      runIds.push(runId)
      runStore.set(runId, store.name)
    }
    if (generation !== entityCollectGeneration) return
    await ws.refreshTasks()
    /**
     * 等待：**逐店各算各的超时**，不是一个总时限。
     *
     * 以前是一个固定 150 秒的总 deadline：只要有一家卡住（浏览器没开起来、任务排在别人后面），
     * 其余几家早就跑完了也要陪着等到 150 秒，用户看到的是一分多钟的"获取中…"。
     * 现在每家自己计时，超时就把它标成"未按时跑完"从等待集合里摘掉，其余的正常收尾。
     */
    const perStoreMs = 60000
    const timedOutNames: string[] = []
    let timedOut = false
    if (runIds.length) {
      const pending = new Set(runIds)
      const firstSeenPending = new Map<string, number>()
      entityProgress.value = { total: runIds.length, done: 0, waiting: [...runStore.values()] }
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 3000))
        if (generation !== entityCollectGeneration) return
        const list = await window.shopilot.task.list()
        const all = (list.ok ? (list.data as any[]) : [])
        for (const id of [...pending]) {
          const task = all.find(item => item.latestRun?.id === id)
          const status = task?.latestRun?.status
          if (status && ['succeeded', 'failed', 'cancelled'].includes(status)) { pending.delete(id); continue }
          if (!firstSeenPending.has(id)) firstSeenPending.set(id, Date.now())
          if (Date.now() - (firstSeenPending.get(id) as number) > perStoreMs) {
            pending.delete(id)
            timedOut = true
            const name = runStore.get(id)
            if (name) timedOutNames.push(name)
          }
        }
        entityProgress.value = {
          total: runIds.length,
          done: runIds.length - pending.size,
          waiting: [...pending].map(id => runStore.get(id) || '店铺')
        }
        if (!pending.size) break
      }
    }
    if (generation !== entityCollectGeneration) return
    // 写回：空则填、不一致不覆盖（判定在主进程，界面只如实展示结果）
    const applied = await window.shopilot.overview.entityApply()
    if (!applied.ok) { ws.toast('写回主体信息失败：' + applied.error.message, 'error'); return }
    if (generation !== entityCollectGeneration) return
    const appliedRows = ((applied.data as any)?.rows || []) as any[]
    // 没跑起来的店：把原因钉在它自己那一行上（每店一行，不加重复行）
    entityReport.value = appliedRows.map(row => startFailures.has(row.storeId)
      ? { ...row, status: 'start-failed', note: startFailures.get(row.storeId) }
      : row)
    const filled = Number((applied.data as any)?.filled || 0)
    // 超时也要如实说，而且要**说是哪家**：否则"采集完成"会把还在排队/跑着的店铺当成已采集
    const lateNote = timedOut ? `（${timedOutNames.join('、')} 未在 1 分钟内跑完，结果可能不全；稍后可再点一次）` : ''
    const toastText = !supported.length
      ? '当前没有已实测主体信息页的平台——不会去猜选择器（每家的原因见下方结果）'
      : startFailures.size
        ? `${startFailures.size} 家没能开始采集，结果里的结论来自上一次采集（详见下方结果）`
        : filled
          ? `已按平台读到的主体填入 ${filled} 家店铺的营业执照`
          : '没有需要新填的主体（详见下方结果）'
    ws.toast(toastText + lateNote, startFailures.size ? 'error' : (filled ? 'success' : 'info'))
    await Promise.all([ws.refreshStores(), reloadInvoiceData()])
  } finally {
    entityCollecting.value = false
    entityProgress.value = null
  }
}
function collectBusiness() { return createCollectionTasks('business') }
function collectOrders() { return createCollectionTasks('orders') }
function collectInvoices() { return createCollectionTasks('invoice') }
/**
 * 采集涉税报送数据。
 *
 * 采集完**重新取一次**报送数据（`reloadTaxData`）：否则用户点完按钮，屏上还是"还没采集"，
 * 得手动刷新才能看到——"点了没反应"是这类只读采集最容易让人误判的地方。
 */
async function collectTaxReport() {
  if (taxCollecting.value) return
  taxCollecting.value = true
  try {
    await createCollectionTasks('tax')
    await reloadTaxData()
  } finally { taxCollecting.value = false }
}

/** 发票自动更新现状（逐店一条：哪几家挂着周期、上次什么时候触发） */
const invoiceSchedule = computed(() => {
  const supported = ws.stores.filter(store => !!invoiceProfileFor(store.platform))
  // 认领口径与采集、开关统一（shared.pickLatestCollectTask，取 updatedAt 最新）——口径不一致时
  // 状态条看的是 A 任务、开关改的是 B 任务，用户会看到"开了自动更新但数据不动"（C3）
  const tasks = supported.map(store => pickLatestCollectTask(ws.tasks, store.id, INVOICE_TASK_PREFIX))
  const scheduled = tasks.filter(task => Number((task?.schedule as any)?.everyMs || 0) === INVOICE_SCHEDULE_MS)
  const fired = scheduled.map(task => Number((task as any)?.lastFiredAt || 0)).filter(value => value > 0)
  /**
   * `enabled` 只说明"任务上挂没挂 3 小时周期"；**能不能真的自动跑还要看总开关**。
   * 两者都满足才算"自动更新生效"——只看前者会在总开关关着时显示成"已启用"
   * （实测：总开关 false、4 家全挂着周期，界面写着「已启用 4/4 家」而调度器一次都不会触发）。
   */
  const autoEnabled = autoCollectionOn.value
  return {
    total: supported.length,
    enabled: scheduled.length,
    /** 挂着周期**且**总开关打开 = 真的会自动更新 */
    active: scheduled.length > 0 && autoEnabled,
    autoEnabled,
    lastFiredAt: fired.length ? Math.max(...fired) : 0
  }
})

/** 一键开关自动更新：给每家的发票任务挂上/摘掉 3 小时周期 */
async function toggleInvoiceSchedule(enabled: boolean) {
  collecting.value = true
  try {
    /**
     * 打开时必须**连总开关一起打开**：只挂任务周期、总开关还关着的话，
     * 调度器根本不会触发（scheduler.ts 的 isAutoCollectionEnabled 分支直接 return），
     * 用户点了"开启"却发现数据永远不更新——这正是 2026-10-15 审查确认的假状态。
     */
    if (enabled) {
      const setResult = await window.shopilot.settings.set(AUTO_COLLECTION_SETTING, true)
      if (!setResult?.ok) {
        ws.toast('打开自动采集总开关失败：' + (setResult?.error?.message || '未知原因'), 'error')
        return
      }
      autoCollectionOn.value = true
    }
    let changed = 0
    for (const store of ws.stores.filter(item => !!invoiceProfileFor(item.platform))) {
      // 与采集认领用同一个口径（C3）：开关改的必须正是任务中心跑的那一个
      const task = pickLatestCollectTask(ws.tasks, store.id, INVOICE_TASK_PREFIX)
      if (!task) continue
      const result = await window.shopilot.task.update({ taskId: task.id, schedule: enabled ? { everyMs: INVOICE_SCHEDULE_MS, backgroundOpen: true } : null })
      if (result.ok) changed++
    }
    await ws.refreshTasks()
    if (!changed) {
      // 一家都没挂上（还没有发票任务）→ 把刚打开的总开关退回去，别留下"开着但不干活"的状态
      if (enabled) {
        await window.shopilot.settings.set(AUTO_COLLECTION_SETTING, false)
        autoCollectionOn.value = false
      }
      ws.toast('还没有发票采集任务——先点一次「采集发票数据」', 'info')
      return
    }
    ws.toast(enabled
      ? `已开启每 3 小时自动更新（${changed} 家，总开关已一并打开）`
      : `已关闭这 ${changed} 家的自动更新（自动采集总开关保持原样）`, 'success')
  } finally { collecting.value = false }
}
async function saveManual() { if (!manualReady.value) return; const result = await window.shopilot.overview.manualMetric(manual.storeId, manual.metric, Number(manual.value)); if (!result.ok) { ws.toast('录入失败：' + result.error.message, 'error'); return } ws.toast('已录入手动指标', 'success'); manual.value = null; await load() }
/**
 * 导出**跟随屏上的营业执照筛选**（申报是分主体做的，导出的表也就该按主体分开）。
 *
 * 为什么要跟：用户在屏上点了某个主体，看到的条数/金额只剩这个主体的，导出却给全部主体——
 * 文件自带「营业执照 / 统一社会信用代码」两列，把 A 公司的清单交给 A 的代账时就会带出别家的单号与税号。
 * 主进程按同一个 key 用共享的归属规则（shared/store-license.groupStoresByLicense）再筛一遍，
 * 不信任渲染层传店铺 id。
 */
const exportScope = computed(() => {
  const key = activeLicense.value
  if (!key) return null
  const item = licenseSummary.value.items.find(entry => entry.key === key)
  return { key, label: item?.label || (key === NO_LICENSE_KEY ? '未填写营业执照' : '') }
})
const exportScopeLabel = computed(() => (exportScope.value ? '导出该主体 CSV' : '导出待开票 CSV'))
const exportScopeTitle = computed(() => (exportScope.value
  ? `只导出当前选中的主体「${exportScope.value.label || '未填写营业执照'}」的待开票记录；点「全部」可导出所有主体`
  : '导出全部主体的待开票记录；先在「营业执照」里点一个主体，可只导出该主体'))
/**
 * 打开导出确认浮层：把「导哪一户、几行、多少钱」写在屏上再落盘。
 *
 * 为什么加这一步：导出是**分主体**做的（申报就是按主体报）。用户在屏上点了某家公司，
 * 拿到的不该是别家的单号与税号——范围写在按钮上还不够，落盘前再确认一次。
 */
function openExportConfirm() {
  const scope = exportScope.value
  const item = scope ? licenseSummary.value.items.find(entry => entry.key === scope.key) : null
  exportConfirm.scopeLabel = scope ? (scope.label || '未填写营业执照') : '全部主体'
  exportConfirm.pendingRows = item ? item.pendingCount : licenseSummary.value.pendingCount
  exportConfirm.amountText = item ? item.amountText : licenseSummary.value.amountText
  exportConfirm.unparsed = item ? item.unparsed : licenseSummary.value.items.reduce((sum, entry) => sum + entry.unparsed, 0)
  exportConfirm.open = true
}

/** 汇总表里点「导出该主体」：先切到那个主体，再走同一套确认流程 */
function exportSubject(key: string) {
  invoiceLicense.value = key
  openExportConfirm()
}

async function confirmExportInvoices() {
  if (exporting.value) return
  exporting.value = true
  try {
    if (await exportInvoices()) exportConfirm.open = false
  } finally {
    exporting.value = false
  }
}

async function exportInvoices(): Promise<boolean> {
  const result = await window.shopilot.overview.invoiceExport(exportScope.value ? { licenseKey: exportScope.value.key } : {})
  if (!result.ok) { ws.toast('导出失败：' + result.error.message, 'error'); return false }
  if (result.data?.canceled) return false
  // 导出里既有"待开票"也有"无需操作"（已提交/已通过）的行，两个数都报出来，免得与屏上合计对不上
  const rows = Number(result.data.rows || 0)
  const pending = Number(result.data.pendingRows ?? rows)
  const suffix = pending === rows ? '' : `（其中待开票 ${pending} 条、无需操作 ${rows - pending} 条）`
  ws.toast(`已导出 ${rows} 条记录${suffix}（${result.data.scopeLabel || '全部主体'}）`, 'success')
  return true
}
function onTaskProgress(event: any) { if (event?.phase === 'finished' || event?.phase === 'failed') void load() }
watch(() => props.mode, () => { void load() })
onMounted(() => {
  if (!window.shopilot) return
  window.shopilot.on(EVENT_CHANNELS.TASK_PROGRESS, onTaskProgress)
  void load()
  void ws.refreshTasks()
})
onBeforeUnmount(() => {
  entityCollectGeneration++
  window.shopilot?.off?.(EVENT_CHANNELS.TASK_PROGRESS, onTaskProgress)
})
</script>

<style scoped>
.unified-page{min-width:0;min-height:0;height:100%;overflow:auto;padding:22px 24px 32px;color:var(--dash-text)}.unified-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:16px}.unified-page-head h1{margin:5px 0 7px;font-size:25px}.unified-page-head p{margin:0;color:var(--dash-text-muted);font-size:12px}.unified-page-actions{display:flex;gap:8px}.button-icon{width:15px;height:15px;object-fit:contain;vertical-align:-3px;margin-right:5px}.unified-button{min-height:32px;padding:0 13px;border:1px solid var(--dash-border);border-radius:9px;background:#ffffff;color:var(--dash-text-soft);cursor:pointer}.unified-button:hover,.unified-button:focus-visible{border-color:rgba(151,120,255,.7);color:var(--dash-text);outline:none}.unified-button.primary{border-color:#5b3df5;background:#6d4aff;color:#ffffff}.unified-button:disabled{opacity:.55;cursor:not-allowed}.unified-route-tabs{display:flex;gap:5px;margin-bottom:15px;padding:4px;border:1px solid var(--dash-border);border-radius:10px;background:#ecedee}.unified-route-tabs button{height:30px;padding:0 14px;border:0;border-radius:7px;background:transparent;color:var(--dash-text-muted);cursor:pointer}.unified-route-tabs button.active{background:rgba(113,78,231,.36);color:#4c1d95}.unified-stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:14px}.unified-stat-card{display:flex;flex-direction:column;gap:6px;padding:14px;border:1px solid var(--dash-border);border-radius:12px;background:#ffffff}.unified-stat-card span,.unified-stat-card small{color:var(--dash-text-muted);font-size:11px}.unified-stat-card strong{font-size:25px}.unified-data-grid{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(260px,1fr);gap:12px}.unified-card{min-width:0;padding:16px;border:1px solid var(--dash-border);border-radius:13px;background:#ffffff}.unified-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}.unified-card-head h2{margin:0 0 5px;font-size:16px}.unified-card-head span{color:var(--dash-text-muted);font-size:11px}.unified-table-wrap{overflow:auto}.unified-table{width:100%;border-collapse:collapse;font-size:11px}.unified-table th,.unified-table td{padding:10px 9px;border-bottom:1px solid rgba(111,137,177,.12);text-align:left;white-space:nowrap}.unified-table th{color:var(--dash-text-muted);font-weight:500}.unified-table td{color:var(--dash-text-soft)}.unified-table em{display:inline-block;margin-left:4px;padding:2px 4px;border-radius:4px;background:rgba(242,165,87,.15);color:#b54708;font-size:9px;font-style:normal}.unified-empty,.unified-state{display:flex;min-height:180px;align-items:center;justify-content:center;gap:10px;flex-direction:column;color:var(--dash-text-muted);border:1px dashed var(--dash-border);border-radius:11px}.unified-empty.compact{min-height:90px}.unified-alert{padding:10px 12px;margin-bottom:12px;border-radius:9px;font-size:12px}.unified-alert.error{border:1px solid rgba(239,99,119,.35);background:rgba(117,37,58,.2);color:#b42318}.unified-alert button{margin-left:8px;border:0;background:transparent;color:#fff;text-decoration:underline;cursor:pointer}.snapshot-list{display:flex;flex-direction:column;gap:8px}.snapshot-row{display:flex;justify-content:space-between;gap:10px;padding:10px;border-radius:8px;background:#f7f9fd}.snapshot-row strong,.snapshot-row small{display:block}.snapshot-row small{margin-top:4px;color:var(--dash-text-muted);font-size:10px}.snapshot-row>span{color:#5b3df5;font-size:12px}.dc-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:12px}.dc-card{padding:13px 14px;border:1px solid var(--dash-border);border-radius:12px;background:#ffffff}.dc-num{color:var(--dash-text);font-size:24px;font-weight:700;letter-spacing:-.02em}.dc-label{margin-top:4px;color:var(--dash-text-muted);font-size:11px}.inv-lic-bar{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin-bottom:12px}.inv-lic-title{color:var(--dash-text-muted);font-size:11.5px}.inv-lic-chip{display:inline-flex;align-items:center;gap:5px;min-height:30px;padding:0 11px;border:1px solid var(--dash-border);border-radius:999px;background:#ffffff;color:var(--dash-text-soft);cursor:pointer;font-size:11.5px}.inv-lic-chip i{color:var(--dash-text-muted);font-style:normal}.inv-lic-chip.on{border-color:rgba(124,92,255,.6);background:rgba(124,92,255,.12);color:#5b3df5}.inv-lic-chip.on i{color:#5b3df5}.inv-lic-chip.none{border-style:dashed}.inv-row-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.inv-row-head b{color:var(--dash-text);font-size:13px}.inv-row-sub{color:var(--dash-text-muted);font-size:10.5px}.inv-count{margin-left:auto;color:var(--dash-text-soft);font-size:11.5px}.inv-lic-tag{display:inline-flex;align-items:center;gap:4px;min-height:24px;padding:0 9px;border:1px solid rgba(124,92,255,.35);border-radius:999px;background:rgba(124,92,255,.1);color:#5b3df5;cursor:pointer;font-size:10.5px}.inv-lic-tag em{color:var(--dash-text-muted);font-style:normal}.inv-lic-tag.none{border-style:dashed;border-color:var(--dash-border);background:transparent;color:var(--dash-text-muted)}.inv-open-page{min-height:24px;padding:0 10px;font-size:10.5px;white-space:nowrap}.inv-lic-edit{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin-top:9px;padding:9px;border:1px dashed var(--dash-border);border-radius:10px}.inv-lic-edit input{height:32px;min-width:200px;flex:1 1 220px;padding:0 9px;border:1px solid var(--dash-border);border-radius:8px;background:#f7f9fd;color:var(--dash-text-soft)}.inv-lic-err{color:#b42318;font-size:11px}.inv-schedule-dot{width:7px;height:7px;border-radius:50%;background:#98a2b3}.inv-schedule-dot.on{background:#12b76a}.invoice-section em{margin-left:4px;padding:1px 5px;border-radius:6px;background:#fff4e5;color:#b54708;font-size:9.5px;font-style:normal}.order-store-list,.invoice-list{display:flex;flex-direction:column;gap:12px}.order-store-block,.invoice-row{padding:13px;border:1px solid var(--dash-border);border-radius:10px;background:rgba(8,16,31,.45)}.order-store-head,.invoice-row-head{display:flex;justify-content:space-between;gap:10px;margin-bottom:10px}.order-store-head strong,.invoice-row-head strong{display:block}.order-store-head span,.invoice-row-head span{display:block;margin-top:4px;color:var(--dash-text-muted);font-size:10px}.invoice-sections{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.invoice-section{display:flex;flex-direction:column;gap:5px;padding:10px;border-radius:8px;background:#ededef}.invoice-section span{color:var(--dash-text-muted);font-size:10px}.manual-card{margin-top:12px}.manual-form{display:flex;flex-wrap:wrap;gap:8px}.manual-form select,.manual-form input{height:34px;min-width:160px;padding:0 9px;border:1px solid var(--dash-border);border-radius:8px;background:#f7f9fd;color:var(--dash-text-soft)}.loader{width:18px;height:18px;border:2px solid rgba(163,143,255,.2);border-top-color:#7c5cff;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:980px){.unified-stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.unified-data-grid{grid-template-columns:1fr}}
/* 发票中心：主体（申报要用的那一列）与「获取主体营业执照」结果 */
.inv-head-actions{display:flex;gap:8px;flex-wrap:wrap}
.inv-mini{min-height:26px;padding:0 10px;font-size:11px}
.inv-entity-line{display:flex;flex-wrap:wrap;gap:6px 18px;margin:0 0 10px;padding:8px 10px;border-radius:8px;background:#f7f9fd;font-size:11px;color:var(--dash-text-soft)}
.inv-entity-line b{color:var(--dash-text)}
.inv-entity-line em{font-style:normal;color:var(--dash-text-muted)}
.inv-entity-read{color:var(--dash-text-soft)}
.inv-entity-hint{color:var(--dash-text-muted)}
.inv-entity-report{margin-bottom:12px;padding:10px 12px;border:1px solid var(--dash-border);border-radius:10px;background:#fbfcfe}
.inv-entity-report-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.inv-entity-report-row{display:flex;gap:10px;padding:4px 0;border-top:1px solid var(--dash-border);font-size:11px;color:var(--dash-text-soft)}
.inv-entity-report-row b{flex:0 0 140px;color:var(--dash-text)}
.inv-entity-report-row span{min-width:0}
/* 行头「可开 ¥…」：申报时逐店对账要看，字号与副标题同级但用主色强调 */
.inv-row-amount{padding:2px 7px;border-radius:7px;background:#f4f1ff;color:#5b3fd6;font-size:10.5px;font-weight:600;white-space:nowrap}
/* 「本次没读到」标记：与「无需操作」同尺寸但用红色，且压过 .invoice-section em 的橙色 */
.invoice-section .inv-sec-empty{margin-left:4px;padding:1px 5px;border-radius:6px;background:#fef3f2;color:#b42318;font-size:9.5px;font-style:normal}
/* 「比实测少」提示（档案里登记过实测条数时的抓漏告警） */
.invoice-section .inv-sec-few{margin-left:4px;padding:1px 5px;border-radius:6px;background:#fffaeb;color:#b54708;font-size:9.5px;font-style:normal}
/* A1 明细：默认收起，展开后是一张不回流的窄表 */
.inv-row-alert{display:flex;align-items:center;gap:8px;margin:0 0 10px;font-size:11px}
.inv-detail-toggle{margin-top:6px;align-self:flex-start;padding:2px 8px;border:1px solid var(--dash-border);border-radius:7px;background:#ffffff;color:var(--dash-text-soft);font-size:10px;cursor:pointer}
.inv-detail-toggle:hover{border-color:rgba(151,120,255,.7);color:var(--dash-text)}
.inv-detail-list{display:flex;flex-direction:column;gap:10px;margin-top:10px;min-width:0}
.inv-detail-head{display:flex;align-items:baseline;gap:8px;margin-bottom:4px;font-size:11px;color:var(--dash-text-soft)}
.inv-detail-head b{color:var(--dash-text);font-size:11.5px}
.inv-detail-wrap{min-width:0;overflow-x:auto}
.inv-detail-table{border-collapse:collapse;font-size:10.5px;white-space:nowrap}
.inv-detail-table th,.inv-detail-table td{padding:4px 8px;border:1px solid var(--dash-border);text-align:left}
.inv-detail-table th{background:#f2f4f8;color:var(--dash-text-soft);font-weight:600}
.inv-detail-table td{color:var(--dash-text)}
.inv-detail-more{margin-top:4px;color:var(--dash-text-muted);font-size:10px}

/* ===================== 发票中心 v2（2026-10-14 按设计稿落地） =====================
   设计稿：assets/design/invoice-center-v1/（可点原型 + 8 张设计图）。
   色板沿用本页既有的 --dash-* 令牌，与仓库 App.vue 的 :root 是同一套。 */
/* 外壳：左「开票主体分账」栏 + 右主列；窄窗口折成一列 */
.inv-shell{display:grid;grid-template-columns:250px minmax(0,1fr);gap:14px;align-items:start}
.inv-main{display:flex;flex-direction:column;gap:12px;min-width:0}
@media(max-width:1200px){.inv-shell{grid-template-columns:1fr}.inv-rail{position:static}}

/* 主体分账栏 */
.inv-rail{position:sticky;top:0;display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--dash-border);border-radius:13px;background:#ffffff;min-width:0}
.inv-rail-head b{display:block;font-size:13px;color:var(--dash-text)}
.inv-rail-head span{display:block;margin-top:4px;color:var(--dash-text-muted);font-size:11px;line-height:1.5}
.inv-rail .inv-lic-bar{display:flex;flex-direction:column;gap:6px;margin:0}
.inv-rail .inv-lic-chip{display:flex;flex-direction:column;align-items:stretch;gap:3px;width:100%;min-height:0;padding:9px 10px;border-radius:10px;text-align:left}
.inv-lic-name{color:var(--dash-text);font-size:12px;font-weight:600;line-height:1.35}
.inv-lic-no{color:var(--dash-text-muted);font-size:10px;letter-spacing:.2px}
.inv-lic-figs{color:var(--dash-text-soft);font-size:10.5px}
.inv-lic-share{display:block;height:3px;margin-top:2px;border-radius:3px;background:#eef1f7;overflow:hidden}
.inv-lic-share i{display:block;height:100%;border-radius:3px;background:linear-gradient(135deg,#8b5cff,#6a3cf0)}
.inv-rail .inv-lic-chip.on .inv-lic-name{color:#5b3df5}
/* 「未填写营业执照」是一档要被清掉的桶，不是主角：警示黄底 */
.inv-rail .inv-lic-chip.none{border-color:#fbdda8;background:#fffaf1}
.inv-rail .inv-lic-chip.none .inv-lic-share i{background:#f7b955}
.inv-rail .inv-lic-chip.none.on{background:#fff2e0;border-color:#f7c98b}
.inv-rail-btn{width:100%;justify-content:center}
.inv-rail-tip{margin:0;color:var(--dash-text-muted);font-size:10.5px;line-height:1.5}

/* 概览一行（2026-10-15 精简：状态条 + 4 张 KPI 卡 + 自动更新行 + 说明段落合并为一条） */
.inv-brief{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;margin-bottom:12px;padding:9px 12px;border:1px solid var(--dash-border);border-radius:11px;background:#ffffff;font-size:11.5px;color:var(--dash-text-soft)}
.inv-brief-nums{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 14px}
.inv-brief-nums .dc-num{font-size:15px;font-weight:700;letter-spacing:-.01em;color:var(--dash-text)}
.inv-brief-scope{color:var(--dash-text-muted);font-size:10.5px;font-style:normal}
.inv-brief-status{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.inv-brief-status b{color:var(--dash-text)}
.inv-brief-side{margin-left:auto;display:flex;align-items:center;gap:4px}
.inv-brief-refresh{border:0;background:transparent;color:#5b3df5;font-size:11.5px;cursor:pointer;padding:3px 6px;border-radius:7px}
.inv-brief-refresh:hover{background:#f4f2ff}
.inv-brief-refresh:disabled{color:var(--dash-text-muted);cursor:default}
button.inv-chip.on{border-color:rgba(18,183,106,.5);color:#067647}
.inv-status-dot{width:7px;height:7px;border-radius:50%;background:#98a2b3;flex:none}
.inv-status-dot.on{background:#12b76a;box-shadow:0 0 0 3px rgba(18,183,106,.16)}
.inv-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border:1px solid var(--dash-border);border-radius:999px;background:#f7f9fd;color:var(--dash-text-soft);font-size:10.5px}
button.inv-chip{cursor:pointer}
button.inv-chip:hover{border-color:rgba(151,120,255,.7);color:var(--dash-text)}
.inv-chip.warn{border-color:#fbdda8;background:#fffaf1;color:#b54708}
.inv-chip.err{border-color:#fecdca;background:#fef3f2;color:#b42318}

/* 筛选面板（2026-10-15 精简：状态/平台/采集时间/排序四个下拉默认折叠在「筛选 · N」按钮后） */
.inv-filter-panel{display:flex;flex-wrap:wrap;align-items:center;gap:7px;width:100%;padding:8px;border:1px dashed var(--dash-border);border-radius:10px;background:#fafbff}

/* 工具条 */
.inv-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:7px}
.inv-search{flex:1 1 220px;min-width:170px;max-width:330px;height:30px;padding:0 10px;border:1px solid var(--dash-border);border-radius:9px;background:#ffffff;color:var(--dash-text);font-size:11px}
.inv-search:focus{border-color:rgba(124,92,255,.6);outline:none}
.inv-select{height:30px;padding:0 8px;border:1px solid var(--dash-border);border-radius:9px;background:#ffffff;color:var(--dash-text-soft);font-size:11px}
.inv-seg{display:inline-flex;padding:2px;border:1px solid var(--dash-border);border-radius:9px;background:#f2f4f8}
.inv-seg button{height:24px;padding:0 10px;border:0;border-radius:7px;background:transparent;color:var(--dash-text-muted);font-size:11px;cursor:pointer}
.inv-seg button.on{background:#ffffff;color:#5b3df5;font-weight:600;box-shadow:0 1px 3px rgba(16,24,40,.1)}
.inv-toolbar-meta{margin-left:auto;color:var(--dash-text-muted);font-size:10.5px}
.inv-toolbar-meta b{color:var(--dash-text)}

/* 店铺卡：原来是 rgba(8,16,31,.45) 深色块（上一版遗留），配浅色正文几乎读不出来——改回白卡 */
.invoice-list .invoice-row{padding:14px;border:1px solid var(--dash-border);border-radius:12px;background:#ffffff}
.invoice-list .invoice-row:hover{border-color:#e2dbff}
.invoice-list .inv-row-head > b{font-size:14px}
.inv-platform-dot{width:8px;height:8px;border-radius:50%;flex:none;background:#98a2b3}

/* 方向卡：徽标三态 + 条数/金额 + 角标。无需操作的方向金额置灰并标「不计入合计」 */
.invoice-sections{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:9px}
.invoice-section{display:flex;flex-direction:column;gap:5px;padding:11px 12px;border:1px solid var(--dash-border);border-radius:11px;background:#ffffff}
.invoice-section.idle{background:#fafbfd;border-color:#eef1f7}
.invoice-section.blank{background:#fbfcfd}
.inv-sec-top{display:flex;align-items:center;gap:6px;min-width:0}
.invoice-section .inv-sec-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dash-text);font-size:12px;font-weight:600}
.invoice-section .inv-sec-badge{margin:0;flex:none;padding:1px 6px;border-radius:999px;background:#fdeccd;color:#b54708;font-size:9.5px;font-style:normal;white-space:nowrap}
.invoice-section .inv-sec-badge.skip{background:#eef1f7;color:#5b6472}
.invoice-section .inv-sec-badge.blank{background:#eef1f7;color:#98a2b3}
.inv-sec-num{color:var(--dash-text);font-size:19px;font-weight:700;letter-spacing:-.3px;font-variant-numeric:tabular-nums}
.inv-sec-num small{margin-left:3px;color:var(--dash-text-muted);font-size:11px;font-weight:500}
.inv-sec-amt{color:#5b3df5;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}
.inv-sec-amt.muted{color:var(--dash-text-muted);font-weight:500;font-size:11.5px}
.inv-sec-foot{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-top:5px;padding-top:7px;border-top:1px dashed var(--dash-border)}
.inv-sec-foot .inv-detail-toggle{margin-top:0;align-self:auto}
.inv-sec-none{color:var(--dash-text-muted);font-size:10px}
.invoice-section .inv-sec-flag{margin:0 0 0 auto;padding:0;background:transparent;color:var(--dash-text-muted);font-size:9.5px;font-style:normal}

/* 按主体分组：一个主体一块，组下方列出其店铺（点店铺行进入店铺详情） */
.inv-summary{min-width:0;display:grid;gap:12px}
.inv-subject{border:1px solid var(--dash-border);border-radius:13px;background:#ffffff;overflow:hidden}
.inv-subject.none{border-style:dashed}
.inv-subject-head{display:flex;align-items:flex-start;gap:10px;padding:13px 14px 7px}
.inv-subject-bar{width:4px;min-height:38px;align-self:stretch;border-radius:2px;background:linear-gradient(180deg,#8b5cff,#6a3cf0)}
.inv-subject.none .inv-subject-bar{background:#c9cdd6}
.inv-subject-id{flex:1;min-width:0}
.inv-subject-name{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.inv-subject-name b{font-size:13px;color:var(--dash-text)}
.inv-subject-name em{color:var(--dash-text-muted);font-size:10.5px;font-style:normal}
.inv-subject-figs{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:5px;color:var(--dash-text-soft);font-size:11px}
.inv-subject-figs b{color:var(--dash-text)}
.inv-subject-share{color:var(--dash-text-muted);font-size:10px;font-style:normal}
.inv-subject-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto}
.inv-subject-label{padding:2px 14px 7px 30px;color:var(--dash-text-muted);font-size:10.5px}
.inv-subject-stores{display:grid}
.inv-subject-store{display:flex;align-items:center;gap:10px;padding:10px 14px;border-top:1px solid #f4f6fa;cursor:pointer}
.inv-subject-store:hover{background:#fafbfe}
.inv-subject-store:focus-visible{outline:2px solid rgba(139,92,255,.45);outline-offset:-2px}
.inv-subject-store-main{flex:1;min-width:0}
.inv-subject-store-name{display:flex;align-items:baseline;gap:4px;flex-wrap:wrap}
.inv-subject-store-name b{font-size:12.5px;color:var(--dash-text)}
.inv-subject-store-sub{margin-top:2px;color:var(--dash-text-muted);font-size:10.5px}
.inv-subject-enter{color:#5b3df5;font-size:10.5px;white-space:nowrap;flex:0 0 auto}
.inv-subject-editor{margin:0 14px 12px 44px}
.inv-subject-editor-for{color:var(--dash-text-soft);font-size:11px}
.inv-sum-amount{color:#5b3df5 !important;font-weight:700}
.inv-sum-store{display:inline-block;margin:0 4px 4px 0;padding:1px 7px;border:1px solid var(--dash-border);border-radius:999px;background:#f7f9fd;color:var(--dash-text-soft);font-size:10px}
.inv-sum-bar{display:block;width:86px;height:6px;border-radius:4px;background:#eef1f7;overflow:hidden}
.inv-sum-bar i{display:block;height:100%;border-radius:4px;background:linear-gradient(135deg,#8b5cff,#6a3cf0)}

/* 平台覆盖与金额口径 */
.inv-cover{padding:16px;border:1px solid var(--dash-border);border-radius:13px;background:#ffffff}
.inv-cover-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}
@media(max-width:980px){.inv-cover-grid{grid-template-columns:1fr}}
.inv-cover-plats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;align-content:start}
.inv-cover-plat{padding:9px 10px;border:1px solid var(--dash-border);border-radius:10px;background:#fcfdff}
.inv-cover-plat-head{display:flex;align-items:center;gap:6px}
.inv-cover-plat-head b{font-size:11.5px;color:var(--dash-text)}
.inv-cover-plat-head em{margin-left:auto;padding:1px 6px;border-radius:999px;background:#eef1f7;color:var(--dash-text-muted);font-size:9.5px;font-style:normal}
.inv-cover-plat-head em.on{background:#e9f9f0;color:#067647}
.inv-cover-plat-body{margin-top:5px;color:var(--dash-text-muted);font-size:10px;line-height:1.5}
.inv-cover-list{margin:0;padding-left:15px;color:var(--dash-text-soft);font-size:11px;line-height:1.75}
.inv-cover-list li{margin-bottom:7px}
.inv-cover-list b{color:var(--dash-text)}

/* 导出确认浮层 */
.inv-modal-mask{position:fixed;inset:0;z-index:60;display:grid;place-items:center;background:rgba(16,18,24,.42)}
.inv-modal{width:470px;max-width:calc(100vw - 40px);border-radius:16px;background:#ffffff;box-shadow:0 12px 32px rgba(16,24,40,.18);overflow:hidden}
.inv-modal-head{padding:18px 20px 12px}
.inv-modal-head h3{margin:0;font-size:16px;color:var(--dash-text)}
.inv-modal-head p{margin:6px 0 0;color:var(--dash-text-muted);font-size:11px;line-height:1.55}
.inv-modal-body{padding:0 20px}
.inv-modal-row{display:flex;align-items:baseline;gap:10px;padding:9px 0;border-top:1px solid var(--dash-border);font-size:11.5px}
.inv-modal-row span{flex:0 0 74px;color:var(--dash-text-muted)}
.inv-modal-row b{min-width:0;color:var(--dash-text);font-weight:600}
.inv-modal-amount{color:#5b3df5 !important;font-size:15px}
.inv-modal-warn{color:#b54708 !important;font-weight:500}
.inv-modal-cols{color:var(--dash-text-soft) !important;font-weight:400;line-height:1.5}
.inv-modal-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:12px;padding:14px 20px 18px;border-top:1px solid var(--dash-border);background:#fbfcfe}

/* ===================== 涉税信息报送 ===================== */
.tax-card{padding:16px;border:1px solid var(--dash-border);border-radius:13px;background:#ffffff}
/* 平台原文的用途限制：与数据同屏、不可折叠。用警示色而不是信息色——它说的是"不许拿它申报" */
.tax-disclaimer{display:flex;gap:8px;align-items:flex-start;margin-bottom:8px;padding:10px 12px;border:1px solid #fecdca;border-radius:10px;background:#fef3f2;color:#b42318;font-size:11.5px;line-height:1.6}
.tax-disclaimer b{font-weight:700}
.tax-disclaimer em{font-style:normal;color:#d92d20;opacity:.8}
.tax-basis{margin:0 0 12px;color:var(--dash-text-muted);font-size:10.5px;line-height:1.6}
.tax-store-list{display:flex;flex-direction:column;gap:12px}
.tax-store{padding:13px;border:1px solid var(--dash-border);border-radius:12px;background:#ffffff}
.tax-store-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:10px}
.tax-store-head > b{font-size:14px;color:var(--dash-text)}
.tax-store-figs{margin-left:auto;padding:2px 8px;border-radius:7px;background:#f4f1ff;color:#5b3fd6;font-size:10.5px;font-weight:600;white-space:nowrap}
.tax-periods{min-width:0;overflow-x:auto}
.tax-table{font-size:10.5px}
.tax-table th.num,.tax-table td.num{text-align:right;font-variant-numeric:tabular-nums}
.tax-net{font-weight:700;color:#5b3df5}
.tax-mismatch{display:block;margin-top:2px;padding:1px 5px;border-radius:6px;background:#fef3f2;color:#b42318;font-size:9px;font-style:normal;font-weight:600}

/* ---- 按主体统计 ---- */
.tax-totals{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px;margin-bottom:10px;padding:9px 11px;border:1px solid var(--dash-border);border-radius:10px;background:#f8fafd;color:var(--dash-text-soft);font-size:11.5px}
.tax-totals b{color:var(--dash-text)}
.tax-totals b.tax-net{color:#5b3df5;font-size:13px}
.tax-totals em{font-style:normal;color:var(--dash-text-muted)}
.tax-totals em.tax-mismatch-inline{margin-left:6px;padding:1px 7px;border-radius:999px;background:#fef3f2;color:#b42318;font-weight:600}
.tax-subjects{min-width:0;overflow-x:auto}
.tax-subject-table td{vertical-align:top}
.tax-subject-table td > b{color:var(--dash-text)}
.tax-subject-detail-cell{padding:0 !important;background:#fbfcfe}
.tax-subject-detail-cell > table{margin:6px 8px}
/* 主体核对结论：一致=绿、未填执照=黄、与执照不一致=红（申报前要看的就是最后那种） */
.tax-verdict{display:inline-block;padding:2px 7px;border-radius:7px;font-size:10px;line-height:1.5}
.tax-verdict.ok{background:#e9f9f0;color:#067647}
.tax-verdict.warn{background:#fff6e5;color:#b54708}
.tax-verdict.err{background:#fef3f2;color:#b42318;font-weight:600}

/* 「按店铺」视图：方向明细折叠条（2026-10-15 精简——点开才渲染明细表，不占首屏） */
.inv-dir-bar{margin-top:10px}
.inv-dir-toggle{display:inline-flex;align-items:center;gap:5px;padding:4px 11px;border:1px dashed var(--dash-border);border-radius:999px;background:transparent;color:var(--dash-text-soft);font-size:10.5px;cursor:pointer}
.inv-dir-toggle:hover{border-color:rgba(151,120,255,.7);color:var(--dash-text)}
.inv-dir-bar + .invoice-sections{margin-top:10px}

/* 移动端（<768）：单列重排 + 底部常驻操作条（2026-10-15 精简）。
   桌面不受影响（.inv-mobile-actions 默认 display:none）。 */
.inv-mobile-actions{display:none}
@media(max-width:768px){
  .unified-page{padding:14px 12px 18px}
  .unified-page-head{flex-direction:column;align-items:stretch;gap:10px;margin-bottom:12px}
  .unified-page-head h1{font-size:20px;margin:2px 0 4px}
  .unified-page-head p{font-size:11px}
  .unified-page-actions{flex-wrap:wrap}
  .unified-page-head .unified-page-actions .unified-button{flex:1 1 auto;justify-content:center}
  .inv-rail{display:block;padding:8px}
  .inv-rail .inv-rail-head{display:none}
  .inv-rail .inv-lic-bar{flex-direction:row;flex-wrap:nowrap;overflow-x:auto;padding-bottom:4px}
  .inv-rail .inv-lic-chip{width:auto;min-width:168px;flex:0 0 auto}
  .inv-rail-btn{width:auto;margin-top:4px}
  .inv-rail-tip{display:none}
  .inv-brief{flex-direction:column;align-items:stretch;gap:8px}
  .inv-brief-side{margin-left:0;justify-content:space-between}
  .inv-brief-nums{gap:4px 10px}
  .inv-toolbar .inv-search{flex:1 1 100%;max-width:none}
  .inv-toolbar-meta{margin-left:0;flex:1 1 100%}
  .inv-subject-head{flex-wrap:wrap}
  .inv-subject-actions{width:100%;justify-content:flex-start;margin-top:2px}
  .inv-subject-label{padding-left:14px}
  .inv-subject-store{flex-wrap:wrap;row-gap:6px}
  .inv-subject-enter{margin-left:auto}
  .inv-mobile-actions{display:flex;gap:8px;position:sticky;bottom:0;z-index:6;margin-top:10px;padding:8px 0 10px;border-top:1px solid var(--dash-border);background:#ffffff}
  .inv-mobile-actions .unified-button{flex:1;justify-content:center;min-height:40px}
}
</style>
