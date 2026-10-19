<template>
  <section :class="['unified-page unified-data-page', { 'invoice-center-page': mode === 'invoices', 'tax-report-page': mode === 'tax' }]" :data-test="`unified-${mode}-page`">
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
    <div v-if="errorMessage" class="unified-alert error" role="alert">{{ errorMessage }} <button type="button" @click="load"><img class="button-icon" :src="dataRetryIcon" alt="" />重试</button></div>
    <div v-if="loading" class="unified-state"><span class="loader"></span>正在读取本机数据…</div>
    <template v-else>
      <div v-if="mode === 'analytics'" class="unified-stat-grid">
        <article v-for="card in totalCards" :key="card.label" class="unified-stat-card"><span>{{ card.label }}</span><strong>{{ card.value }}</strong><small>{{ card.note }}</small></article>
      </div>

      <div v-if="mode === 'analytics'" class="unified-data-grid">
        <section class="unified-card data-wide"><div class="unified-card-head"><div><h2>经营指标</h2><span>每店每指标取本机最新快照</span></div><button type="button" class="unified-button ghost" :disabled="collecting" @click="collectBusiness"><img class="button-icon" :src="dataAnalyticsSheetIcon" alt="" />{{ collecting ? '创建任务中…' : '采集经营数据' }}</button></div><div v-if="metricRows.length" class="unified-table-wrap"><table class="unified-table"><thead><tr><th>店铺</th><th>平台</th><th v-for="metric in bizMetrics" :key="metric.key">{{ metric.label }}</th><th>采集时间</th></tr></thead><tbody><tr v-for="row in metricRows" :key="row.storeId"><td>{{ row.storeName }}</td><td>{{ row.platform }}</td><td v-for="metric in bizMetrics" :key="metric.key">{{ formatValue(row.values[metric.key], metric.key) }}<em v-if="row.manual[metric.key]">手动</em></td><td>{{ row.lastAt ? formatTime(row.lastAt) : '—' }}</td></tr></tbody></table></div><div v-else class="unified-empty compact">暂无经营快照。请在店铺浏览器中采集或运行读取任务。</div></section>
        <section class="unified-card"><div class="unified-card-head"><div><h2>指标快照</h2><span>{{ snapshotRows.length }} 条本机记录</span></div></div><div v-if="snapshotRows.length" class="snapshot-list"><div v-for="snapshot in snapshotRows.slice(0, 12)" :key="snapshot.storeId + snapshot.metric + snapshot.capturedAt" class="snapshot-row"><div><strong>{{ snapshot.metric }}</strong><small>{{ snapshot.storeName || snapshot.storeId }}</small></div><span>{{ displayValue(snapshot.value) }}</span></div></div><div v-else class="unified-empty compact">暂无快照</div></section>
      </div>

      <SalesMetricsMonitorCard v-if="mode === 'analytics'" @open-store="emit('open-store', $event)" />


      <template v-else-if="mode === 'invoices'">
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
      <template v-else-if="mode === 'tax'">
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
      </template>

      <section v-if="mode === 'analytics'" class="unified-card manual-card"><div class="unified-card-head"><div><h2>手动录入指标</h2><span>仅用于平台反抓取导致无法自动读取的数字，来源会标注为手动</span></div></div><div class="manual-form"><select v-model="manual.storeId" aria-label="店铺"><option value="">选择店铺</option><option v-for="store in ws.stores" :key="store.id" :value="store.id">{{ store.name }}</option></select><select v-model="manual.metric" aria-label="指标"><option v-for="metric in bizMetrics" :key="metric.key" :value="metric.key">{{ metric.label }}</option></select><input v-model.number="manual.value" type="number" min="0" placeholder="数值" /><button type="button" class="unified-button ghost" :disabled="!manualReady" @click="saveManual"> <img class="button-icon" :src="dataManualEntrySheetIcon" alt="" />录入</button></div></section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import { isPendingSection } from '@shared/constants/invoice'
import { taxAmountText } from '@shared/tax-income'
import { UNKNOWN_TAX_SUBJECT_LABEL } from '@shared/tax-subject'
import { NO_LICENSE_KEY } from '@shared/store-license'
import SalesMetricsMonitorCard from './SalesMetricsMonitorCard.vue'
import invoiceIcon from '../../assets/generated/ui-icons/invoice-gen.png'
import dataRetryIcon from '../../assets/generated/ui-icons/data-retry-gen.png'
import dataAnalyticsSheetIcon from '../../assets/generated/ui-icons/data-analytics-sheet-gen.png'
import dataSyncSheetIcon from '../../assets/generated/ui-icons/data-sync-sheet-gen.png'
import dataExportSheetIcon from '../../assets/generated/ui-icons/data-export-sheet-gen.png'
import dataInvoiceScheduleSheetIcon from '../../assets/generated/ui-icons/data-invoice-schedule-sheet-gen.png'
import dataInvoiceOpenSheetIcon from '../../assets/generated/ui-icons/data-invoice-open-sheet-gen.png'
import dataLicenseEditSheetIcon from '../../assets/generated/ui-icons/data-license-edit-sheet-gen.png'
import dataLicenseSaveSheetIcon from '../../assets/generated/ui-icons/data-license-save-sheet-gen.png'
import dataLicenseCancelSheetIcon from '../../assets/generated/ui-icons/data-license-cancel-sheet-gen.png'
import dataManualEntrySheetIcon from '../../assets/generated/ui-icons/data-manual-entry-sheet-gen.png'
import { useInvoiceDetail } from './use-invoice-detail'
import { useTaxLicense } from './use-tax-license'
import { useDataCollection } from './use-data-collection'

type DataMode = 'analytics' | 'invoices' | 'tax'
const props = defineProps<{ mode: DataMode }>()
const emit = defineEmits<{ 'open-store': [storeId: string] }>()
const ws = useWorkspaceStore()
// ---------- 发票明细 / 涉税与证照 / 采集与导出（状态机见 use-*.ts）----------
// 页面只保留模板与 props；三块域逻辑各自成 composable，模板变量由下面解构提供。
const page = useInvoiceDetail({ props, emit })
const {
  loading,
  collecting,
  errorMessage,
  invoiceData,
  taxData,
  taxCollecting,
  entityCollecting,
  entityProgress,
  entityReport,
  manual,
  subtitle,
  bizMetrics,
  totalCards,
  snapshotRows,
  invoiceRows,
  invoiceLicense,
  invoiceStatusFilter,
  invoicePlatformFilter,
  invoiceQuery,
  invoicePeriodFilter,
  licenseEditingId,
  licenseDraft,
  licenseSaving,
  licenseEditError,
  invoiceView,
  isSubjectCollapsed,
  toggleSubjectGroup,
  isStoreDirsOpen,
  toggleStoreDirs,
  invoiceSort,
  filtersOpen,
  activeFilterCount,
  exporting,
  exportConfirm,
  licenseSummary,
  activeLicense,
  subjectInvoiceRows,
  visibleInvoiceRows,
  invoiceTotal,
  invoiceGrandTotal,
  invoiceCoverage,
  unlicensedPending,
  licenseShare,
  invoiceRisk,
  invoiceScopeLabel,
  platformColor,
  invoicePlatformOptions,
  invoiceOpenUrl,
  invoiceOpenLabel,
  invoiceOpenTitle,
  openInvoicePage,
  openStoreAdmin,
  openStoreDetail,
  sectionKey,
  isSectionOpen,
  toggleSection,
  openDetailSections,
  sectionColumns,
  detailCell,
  invoiceRowAmountText,
  metricRows,
  manualReady,
  displayValue,
  formatTime,
  formatValue,
  exportScopeLabel,
  exportScopeTitle,
  openExportConfirm,
} = page
const tax = useTaxLicense(page)
const {
  sectionAmount,
  invoiceSubjectGroups,
  invoicePlatformCoverage,
  invoiceCsvColumns,
  taxDisclaimer,
  taxBasis,
  taxRows,
  taxSupportedPlatforms,
  taxView,
  taxExpandedSubject,
  taxSubjectGroups,
  taxSubjectTotal,
  taxSubjectLabel,
  taxLicenseVerdictText,
  taxCellOf,
  taxGoods,
  taxService,
  taxRowNet,
  taxRowReconciles,
  taxStoreSummary,
  taxSectionsWithItems,
  taxEmptyNotes,
  openLicenseEditor,
  saveLicense,
  licenseEditingGroupKey,
  saveLicenseInGroup,
  startFillLicense,
  storeNameOf,
  entityVerdict,
  entityReportText,
  entitySupportedPlatforms,
  licenseNameOptions,
} = tax
const collection = useDataCollection(page, tax, { props })
const {
  load,
  collectStoreEntities,
  collectBusiness,
  collectInvoices,
  collectTaxReport,
  invoiceSchedule,
  toggleInvoiceSchedule,
  saveManual,
  exportSubject,
  confirmExportInvoices,
} = collection
const title = computed(() => props.mode === 'invoices' ? '发票中心' : props.mode === 'tax' ? '涉税信息' : '数据分析')
</script>

<style scoped>
.unified-page{min-width:0;min-height:0;height:100%;overflow:auto;padding:22px 24px 32px;color:var(--dash-text)}.unified-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:16px}.unified-page-head h1{margin:5px 0 7px;font-size:25px}.unified-page-head p{margin:0;color:var(--dash-text-muted);font-size:12px}.unified-page-actions{display:flex;gap:8px}.button-icon{width:15px;height:15px;object-fit:contain;vertical-align:-3px;margin-right:5px}.unified-button{min-height:32px;padding:0 13px;border:1px solid var(--dash-border);border-radius:9px;background:#ffffff;color:var(--dash-text-soft);cursor:pointer}.unified-button:hover,.unified-button:focus-visible{border-color:rgba(151,120,255,.7);color:var(--dash-text);outline:none}.unified-button.primary{border-color:#5b3df5;background:#6d4aff;color:#ffffff}.unified-button:disabled{opacity:.55;cursor:not-allowed}.unified-stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:14px}.unified-stat-card{display:flex;flex-direction:column;gap:6px;padding:14px;border:1px solid var(--dash-border);border-radius:12px;background:#ffffff}.unified-stat-card span,.unified-stat-card small{color:var(--dash-text-muted);font-size:11px}.unified-stat-card strong{font-size:25px}.unified-data-grid{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(260px,1fr);gap:12px}.unified-card{min-width:0;padding:16px;border:1px solid var(--dash-border);border-radius:13px;background:#ffffff}.unified-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}.unified-card-head h2{margin:0 0 5px;font-size:16px}.unified-card-head span{color:var(--dash-text-muted);font-size:11px}.unified-table-wrap{overflow:auto}.unified-table{width:100%;border-collapse:collapse;font-size:11px}.unified-table th,.unified-table td{padding:10px 9px;border-bottom:1px solid rgba(111,137,177,.12);text-align:left;white-space:nowrap}.unified-table th{color:var(--dash-text-muted);font-weight:500}.unified-table td{color:var(--dash-text-soft)}.unified-table em{display:inline-block;margin-left:4px;padding:2px 4px;border-radius:4px;background:rgba(242,165,87,.15);color:#b54708;font-size:9px;font-style:normal}.unified-empty,.unified-state{display:flex;min-height:180px;align-items:center;justify-content:center;gap:10px;flex-direction:column;color:var(--dash-text-muted);border:1px dashed var(--dash-border);border-radius:11px}.unified-empty.compact{min-height:90px}.unified-alert{padding:10px 12px;margin-bottom:12px;border-radius:9px;font-size:12px}.unified-alert.error{border:1px solid rgba(239,99,119,.35);background:rgba(117,37,58,.2);color:#b42318}.unified-alert button{margin-left:8px;border:0;background:transparent;color:#fff;text-decoration:underline;cursor:pointer}.snapshot-list{display:flex;flex-direction:column;gap:8px}.snapshot-row{display:flex;justify-content:space-between;gap:10px;padding:10px;border-radius:8px;background:#f7f9fd}.snapshot-row strong,.snapshot-row small{display:block}.snapshot-row small{margin-top:4px;color:var(--dash-text-muted);font-size:10px}.snapshot-row>span{color:#5b3df5;font-size:12px}.dc-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:12px}.dc-card{padding:13px 14px;border:1px solid var(--dash-border);border-radius:12px;background:#ffffff}.dc-num{color:var(--dash-text);font-size:24px;font-weight:700;letter-spacing:-.02em}.dc-label{margin-top:4px;color:var(--dash-text-muted);font-size:11px}.inv-lic-bar{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin-bottom:12px}.inv-lic-title{color:var(--dash-text-muted);font-size:11.5px}.inv-lic-chip{display:inline-flex;align-items:center;gap:5px;min-height:30px;padding:0 11px;border:1px solid var(--dash-border);border-radius:999px;background:#ffffff;color:var(--dash-text-soft);cursor:pointer;font-size:11.5px}.inv-lic-chip i{color:var(--dash-text-muted);font-style:normal}.inv-lic-chip.on{border-color:rgba(124,92,255,.6);background:rgba(124,92,255,.12);color:#5b3df5}.inv-lic-chip.on i{color:#5b3df5}.inv-lic-chip.none{border-style:dashed}.inv-row-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.inv-row-head b{color:var(--dash-text);font-size:13px}.inv-row-sub{color:var(--dash-text-muted);font-size:10.5px}.inv-count{margin-left:auto;color:var(--dash-text-soft);font-size:11.5px}.inv-lic-tag{display:inline-flex;align-items:center;gap:4px;min-height:24px;padding:0 9px;border:1px solid rgba(124,92,255,.35);border-radius:999px;background:rgba(124,92,255,.1);color:#5b3df5;cursor:pointer;font-size:10.5px}.inv-lic-tag em{color:var(--dash-text-muted);font-style:normal}.inv-lic-tag.none{border-style:dashed;border-color:var(--dash-border);background:transparent;color:var(--dash-text-muted)}.inv-open-page{min-height:24px;padding:0 10px;font-size:10.5px;white-space:nowrap}.inv-lic-edit{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin-top:9px;padding:9px;border:1px dashed var(--dash-border);border-radius:10px}.inv-lic-edit input{height:32px;min-width:200px;flex:1 1 220px;padding:0 9px;border:1px solid var(--dash-border);border-radius:8px;background:#f7f9fd;color:var(--dash-text-soft)}.inv-lic-err{color:#b42318;font-size:11px}.inv-schedule-dot{width:7px;height:7px;border-radius:50%;background:#98a2b3}.inv-schedule-dot.on{background:#12b76a}.invoice-section em{margin-left:4px;padding:1px 5px;border-radius:6px;background:#fff4e5;color:#b54708;font-size:9.5px;font-style:normal}.invoice-list{display:flex;flex-direction:column;gap:12px}.invoice-row{padding:13px;border:1px solid var(--dash-border);border-radius:10px;background:rgba(8,16,31,.45)}.invoice-row-head{display:flex;justify-content:space-between;gap:10px;margin-bottom:10px}.invoice-row-head strong{display:block}.invoice-row-head span{display:block;margin-top:4px;color:var(--dash-text-muted);font-size:10px}.invoice-sections{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.invoice-section{display:flex;flex-direction:column;gap:5px;padding:10px;border-radius:8px;background:#ededef}.invoice-section span{color:var(--dash-text-muted);font-size:10px}.manual-card{margin-top:12px}.manual-form{display:flex;flex-wrap:wrap;gap:8px}.manual-form select,.manual-form input{height:34px;min-width:160px;padding:0 9px;border:1px solid var(--dash-border);border-radius:8px;background:#f7f9fd;color:var(--dash-text-soft)}.loader{width:18px;height:18px;border:2px solid rgba(163,143,255,.2);border-top-color:#7c5cff;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
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
