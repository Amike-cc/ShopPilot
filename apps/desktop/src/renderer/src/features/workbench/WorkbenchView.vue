<template>
  <div class="workbench">
    <!-- 左栏：店铺侧边栏 - §8.2 StoreSidebar（可收起为窄轨：新建/回收站/设置仍可达） -->
    <aside class="sidebar" :class="{ collapsed: leftSidebarCollapsed }" data-test="sidebar">
      <div class="sidebar-rail" v-if="leftSidebarCollapsed">
        <button class="rail-btn" data-test="sidebar-expand" title="展开左侧栏（Ctrl+Shift+E）" @click="expandSidebar()">›</button>
        <button class="rail-btn" data-test="rail-new" title="新建店铺" @click="openCreateDialog()">+</button>
        <button class="rail-btn" data-test="rail-trash" title="回收站" @click="openTrash">
          🗑
          <span v-if="ws.trashStores.length" class="rail-badge" data-test="rail-trash-badge"></span>
        </button>
        <button class="rail-btn" data-test="rail-settings" title="设置（含软件更新）" @click="openSettings()">⚙</button>
        <button class="rail-btn dc-rail-btn" data-test="rail-datacenter" title="数据中心（全部店铺）" @click="openDataCenter()">📊</button>
      </div>

      <template v-else>
      <div class="brand">
        <div class="brand-logo">商</div>
        <div class="brand-name">ShopPilot</div>
        <button class="sidebar-collapse" data-test="sidebar-collapse" title="收起左侧栏（Ctrl+Shift+E）" @click="collapseSidebar()">‹</button>
      </div>

      <div class="sidebar-tools">
        <div class="search-box">
          <span class="search-ico">🔍</span>
          <input v-model="ws.search" placeholder="搜索店铺 / 平台 / 标签" />
        </div>
        <button class="btn-new" @click="openCreateDialog()" title="新建店铺">+</button>
      </div>

<div class="filter-platform" v-if="ws.platformCounts && Object.keys(ws.platformCounts).length > 0">
        <div class="fp-header">
          <span class="fp-label">平台</span>
          <button v-if="ws.filterPlatform" class="fp-clear" @click="ws.filterPlatform = ''" title="清除平台筛选">✕</button>
        </div>
        <button
          :class="['fp-chip', { on: !ws.filterPlatform }]"
          @click="ws.filterPlatform = ''"
          title="显示全部平台"
        >
          全部
          <span class="fp-count">{{ totalFilteredCount }}</span>
        </button>
        <template v-for="p in availablePlatforms" :key="p.name">
          <button
            :class="['fp-chip', { on: ws.filterPlatform === p.name }]"
            :style="chipStyle(ws.filterPlatform === p.name, p.color)"
            @click="ws.filterPlatform = p.name"
            :title="p.name + '（' + p.count + ' 家店铺）'"
          >
            <template v-if="p.platform">
              <PlatformIcon :name="p.platform" :size="12" />
            </template>
            <template v-else>
              <span class="fp-other-icon">📦</span>
            </template>
            <span>{{ p.shortName }}</span>
            <span class="fp-count">{{ p.count }}</span>
          </button>
        </template>
      </div>

      <div class="store-list">
        <div v-if="ws.filteredStores.length === 0" class="empty-hint">
          <template v-if="ws.search || ws.filterPlatform">
            没有匹配的店铺
            <br />
            <button class="link" @click="clearFilters">清除全部筛选条件</button>
          </template>
          <template v-else>
            没有店铺<br /><button class="link" @click="openCreateDialog()">新建第一个</button>
          </template>
        </div>
        <div v-for="grp in ws.groupedStores" :key="grp.group" class="store-group">
          <div class="group-title">{{ grp.group }}</div>
          <div
            v-for="s in grp.items"
            :key="s.id"
            :class="['store-card', { active: ws.selectedStoreId === s.id, displayed: ws.displayedStoreId === s.id }]"
            @click="ws.selectStore(s.id)"
            @contextmenu.prevent="onStoreContext(s, $event)"
          >
            <PlatformIcon :name="s.platform" :size="32" />
            <div class="store-meta">
              <div class="store-name">{{ s.name }}</div>
              <div class="store-sub">
                <span class="dot" :style="{ background: statusColor(s.status) }"></span>
                <PlatformIcon :name="s.platform" :size="12" />
                <span>{{ s.platform }}</span>
              </div>
            </div>
            <button
              class="store-action"
              :title="isOpen(s.id) ? '关闭浏览器' : '打开浏览器'"
              @click.stop="toggleStore(s.id)"
            >{{ isOpen(s.id) ? '⏻' : '▶' }}</button>
          </div>
        </div>
      </div>

      <div class="sidebar-dc">
        <button class="dc-entry-row" data-test="datacenter-open" title="数据中心：汇总展示所有店铺的数据" @click="openDataCenter()">
          <span class="dc-ico">📊</span>
          <span class="dc-txt">数据中心</span>
          <span class="row-sub">全部店铺</span>
        </button>
      </div>

      <div class="sidebar-footer">
        <button class="foot-btn" @click="openTrash">🗑 回收站<span v-if="ws.trashStores.length" class="badge">{{ ws.trashStores.length }}</span></button>
        <button class="foot-btn" @click="onCapture" :disabled="!ws.activeTab" title="截图当前页">📸 截图</button>
        <button class="foot-btn" data-test="settings-open-btn" @click="openSettings()" title="设置（含软件更新）">⚙ 设置</button>
      </div>
      </template>
    </aside>

    <!-- 中栏：浏览器视口 - §8.2 BrowserViewport -->
    <main class="browser-col">
      <template v-if="ws.displayedStoreId">
        <!-- 标签栏（兼作标题栏拖拽区；右栏收起时右上角是原生窗口按钮，需避让） -->
        <div class="tab-strip" :class="{ 'wco-avoid': rightPanelCollapsed }">
          <div class="tabs">
            <div
              v-for="t in ws.displayedTabs"
              :key="t.id"
              :class="['tab', { active: ws.activeTab?.id === t.id, pinned: t.isPinned }]"
              @click="ws.activateTab(t.id)"
            >
              <span v-if="t.loading" class="tab-spinner"></span>
              <span class="tab-title" :title="t.title || t.url">{{ t.title || '新标签页' }}</span>
              <button class="tab-close" @click.stop="ws.closeTab(t.id)">×</button>
            </div>
          </div>
          <button class="tab-add" @click="ws.newTab()" title="新标签页">+</button>
        </div>

        <!-- 地址栏 -->
        <div class="address-bar">
          <!-- 首页（左上角）：回到该店铺所在平台的后台首页，见 homeUrl -->
          <button
            class="nav-btn"
            data-test="nav-home"
            :disabled="!homeUrl"
            :title="homeUrl ? '店铺首页：' + homeUrl : '未配置后台地址'"
            @click="goHome"
          >⌂</button>
          <button class="nav-btn" @click="ws.tabControl('back')" title="后退">‹</button>
          <button class="nav-btn" @click="ws.tabControl('forward')" title="前进">›</button>
          <button class="nav-btn" @click="ws.tabControl('reload')" title="刷新">⟳</button>
          <div class="url-box">
            <input
              ref="urlInput"
              v-model="urlDraft"
              @keydown.enter="submitUrl"
              :key="ws.activeTab?.id + ws.activeTab?.url"
              spellcheck="false"
            />
          </div>
          <button class="nav-btn" @click="bookmarkCurrent" title="收藏本页">☆</button>
          <button class="nav-btn" @click="openWindow" title="独立窗口打开">⧉</button>
        </div>

        <!-- WebContentsView 挂载区域（透明占位，主进程按此 bounds 覆盖真实页面） -->
        <div class="viewport" ref="viewportEl"></div>
      </template>

      <!-- 欢迎页 -->
      <div v-else class="welcome">
        <div class="welcome-inner">
          <div class="welcome-logo">商</div>
          <h1>欢迎使用 ShopPilot</h1>
          <p class="welcome-desc">电商店铺浏览器工作台。选择左侧店铺开始，或创建一个新店铺。</p>
          <div class="quick-platforms">
            <button v-for="p in quickPlatforms" :key="p.name" class="qp" @click="quickCreate(p)">
              <PlatformIcon :name="p.name" :size="16" />{{ p.name }}
            </button>
          </div>
        </div>
      </div>
    </main>

    <!-- 右栏：面板 - §8.2 概览/书签/下载（可收起为窄轨：图标=面板，展开即回到该面板） -->
    <aside class="right-panel" :class="{ collapsed: rightPanelCollapsed }" v-if="ws.displayedStoreId" data-test="right-panel">
      <div class="panel-rail" v-if="rightPanelCollapsed">
        <button class="rail-btn" data-test="panel-expand" title="展开右侧栏（Ctrl+Shift+B）" @click="expandPanel()">‹</button>
        <button
          v-for="t in panelTabs"
          :key="t.key"
          :class="['rail-btn', { on: ws.rightPanel === t.key }]"
          :title="t.label"
          :data-test="'rail-' + t.key"
          @click="expandPanel(t.key)"
        >
          {{ t.icon }}
          <span v-if="t.key === 'tasks' && confirmationCount > 0" class="rail-badge" data-test="rail-confirm-badge"></span>
        </button>
      </div>

      <template v-else>
      <div class="panel-tabs">
        <button :class="['ptab', { on: ws.rightPanel === 'bookmarks' }]" @click="switchPanel('bookmarks')">收藏</button>
        <button :class="['ptab', { on: ws.rightPanel === 'downloads' }]" @click="switchPanel('downloads')">下载</button>
        <button :class="['ptab', { on: ws.rightPanel === 'env' }]" @click="switchPanel('env')">环境</button>
        <button :class="['ptab', { on: ws.rightPanel === 'tasks' }]" @click="switchPanel('tasks')">任务</button>
        <button class="panel-collapse" data-test="panel-collapse" title="收起右侧栏（Ctrl+Shift+B）" @click="collapsePanel()">›</button>
      </div>

      <!-- 人工确认门禁：必须在任何面板都能看到（曾在"任务"面板分支内，用户切到别的面板时任务干等，看起来像卡死） -->
      <div v-for="c in ws.confirmations" :key="c.runId" class="confirm-bar" data-test="task-confirm">
        <div class="cf-txt">
          ⚠ 需要人工确认
          <div class="row-sub">{{ c.message }}（步骤 {{ c.stepIndex + 1 }}）</div>
        </div>
        <div class="cf-btns">
          <button class="mini-btn primary" data-test="confirm-allow" @click="confirmRun(c.runId, true)">允许</button>
          <button class="mini-btn" data-test="confirm-deny" @click="confirmRun(c.runId, false)">拒绝</button>
        </div>
      </div>

      <div class="panel-body" v-if="ws.rightPanel === 'bookmarks'">
        <!-- 平台入口（§16 平台适配层）：只读展示，不入库；深链随平台改版可能变化 -->
        <div class="env-sec" v-if="entryRoutes.length" data-test="entry-routes">
          <div class="env-h"><PlatformIcon :name="displayedPlatformName" :size="14" /><span style="margin-left:6px">{{ displayedPlatformName }} · 平台入口</span></div>
          <div v-for="r in entryRoutes" :key="r.id" class="row-item" data-test="entry-route" @click="ws.navigate(r.url)">
            <div class="row-main">{{ r.title }}</div>
            <div class="row-sub">{{ shortUrl(r.url) }}</div>
          </div>
          <div class="env-note">平台入口由内置适配器提供，页面改版可能调整地址；失效可直接在下方自建收藏。</div>
        </div>

        <div v-if="ws.bookmarks.length === 0" class="empty-hint">暂无收藏</div>
        <div v-for="b in ws.bookmarks" :key="b.id" class="row-item" @click="ws.navigate(b.url)">
          <div class="row-main">{{ b.title }}</div>
          <div class="row-sub">{{ shortUrl(b.url) }}</div>
          <button class="row-del" @click.stop="delBookmark(b.id)">×</button>
        </div>
      </div>

      <div class="panel-body" v-else-if="ws.rightPanel === 'downloads'">
        <div v-if="ws.downloads.length === 0" class="empty-hint">暂无下载</div>
        <div v-for="d in ws.downloads" :key="d.id" class="row-item">
          <div class="row-main" :title="d.fileName">{{ d.fileName }}</div>
          <div class="row-sub">
            <span :class="['dl-state', d.state]">{{ dlStateText(d.state) }}</span>
            <span v-if="d.sizeBytes"> · {{ fmtSize(d.sizeBytes) }}</span>
          </div>
          <button class="row-del" @click.stop="showInFolder(d.id)" title="打开所在文件夹">📁</button>
        </div>
      </div>

      <!-- 环境面板：代理绑定 / 代理管理 / 指纹验证 - §8.1 / §13 -->
      <div class="panel-body env-body" v-else-if="ws.rightPanel === 'env'">
        <div class="env-sec">
          <div class="env-h">网络出口</div>
          <div class="bind-row">
            <select v-model="proxyBindId" @change="applyBind">
              <option value="">直连（不使用代理）</option>
              <option v-for="p in proxies" :key="p.id" :value="p.id">{{ p.label || p.host + ':' + p.port }}</option>
            </select>
          </div>
          <div class="env-note" v-if="envBindingNote">{{ envBindingNote }}</div>
          <div class="env-note ok" v-if="lastProxyAuth">✔ 已注入代理凭据 {{ lastProxyAuth.username }}（{{ new Date(lastProxyAuth.at).toLocaleTimeString() }}）</div>
        </div>

        <div class="env-sec">
          <div class="env-h">代理列表</div>
          <div v-if="proxies.length === 0" class="empty-hint">暂无代理，可在下方添加</div>
          <div v-for="p in proxies" :key="p.id" class="proxy-item">
            <span class="p-dot" :style="{ background: p.status === 'ok' ? '#10B981' : p.status === 'error' ? '#EF4444' : '#6B7280' }" :title="'状态: ' + p.status"></span>
            <div class="p-info">
              <div class="row-main">{{ p.label || p.host }}<span v-if="p.hasCredential" title="含凭据"> 🔑</span></div>
              <div class="row-sub">{{ p.type }}://{{ p.host }}:{{ p.port }} · {{ p.lastLatencyMs != null ? p.lastLatencyMs + ' ms' : '未检测' }}</div>
            </div>
            <button class="mini-btn" @click="testProxy(p)" :disabled="testingIds.includes(p.id)">{{ testingIds.includes(p.id) ? '…' : '检测' }}</button>
            <button class="row-del" @click="removeProxy(p.id)" title="删除">×</button>
          </div>
          <div class="proxy-add">
            <input v-model="np.label" placeholder="名称（可选）" />
            <div class="add-line">
              <select v-model="np.type"><option value="http">http</option><option value="https">https</option><option value="socks5">socks5</option></select>
              <input v-model="np.host" placeholder="主机" class="f-host" />
              <input v-model.number="np.port" type="number" placeholder="端口" class="f-port" />
            </div>
            <div class="add-line">
              <input v-model="np.user" placeholder="用户名（可选）" autocomplete="off" />
              <input v-model="np.pass" type="password" placeholder="密码（可选，本机加密存储）" autocomplete="new-password" />
            </div>
            <button class="mini-btn primary" @click="addProxy" :disabled="!np.host || !np.port">保存代理</button>
          </div>
        </div>

        <div class="env-sec">
          <div class="env-h">环境指纹
            <button class="mini-btn" style="margin-left:auto" @click="verifyEnv" :disabled="verifying">{{ verifying ? '验证中…' : '打开该店铺页面后验证' }}</button>
          </div>
          <div v-if="verifyItems.length === 0" class="env-note">未验证。字段实际值需在店铺浏览器打开后采集，无法验证的字段如实标记"未验证"。</div>
          <div v-for="it in verifyItems" :key="it.field" class="verify-item">
            <span>{{ it.state === 'verified' ? '✅' : '❓' }}</span>
            <div class="v-info">
              <div class="row-main">{{ it.field }}</div>
              <div class="row-sub" :title="'期望 ' + it.expected + ' / 实际 ' + (it.actual ?? '—')">期望 {{ clip(it.expected) }} → 实际 {{ clip(it.actual) }}</div>
            </div>
          </div>
        </div>

        <!-- 会话与 Cookie - §6.3 / §10.2 -->
        <div class="env-sec" data-test="session-sec">
          <div class="env-h">会话与 Cookie</div>
          <div class="cf-btns" style="margin-bottom:6px">
            <button class="mini-btn" data-test="btn-export-session" @click="exportSession" :disabled="secBusy">导出加密会话包…</button>
            <button class="mini-btn" data-test="btn-import-session" @click="importSession" :disabled="secBusy">导入会话包…</button>
          </div>
          <div class="env-note">导出包经口令加密（scrypt + AES-256-GCM）并带有效期；口令由主进程托管窗口采集，不经过界面脚本。</div>
          <input v-model="ckSearch" placeholder="搜索 Cookie（名称/域）" class="ck-search" @input="refreshCookies" />
          <div class="row-sub" style="margin:4px 0">共 {{ cookiesTotal }} 条<span v-if="ckSearch">（筛选后 {{ cookies.length }}）</span></div>
          <div v-for="c in cookies.slice(0, 40)" :key="c.domain + c.path + c.name" class="proxy-item ck-item">
            <div class="p-info">
              <div class="row-main" :title="c.valuePreview">{{ c.name }}<span v-if="c.httpOnly" class="ck-flag">HttpOnly</span><span v-if="c.secure" class="ck-flag">Secure</span></div>
              <div class="row-sub">{{ c.domain }}{{ c.path }} · {{ c.session ? '会话级' : c.expires }} · {{ c.valuePreview }}</div>
            </div>
            <button class="row-del" @click="delCookie(c)" title="删除该 Cookie">×</button>
          </div>
          <button v-if="cookiesTotal > 0" class="mini-btn danger-btn" @click="clearCookies">清空该店铺全部 Cookie</button>
        </div>

        <!-- 应用锁 - §6.5 -->
        <div class="env-sec" data-test="lock-sec">
          <div class="env-h">应用锁</div>
          <template v-if="!ws.securityEnabled">
            <div class="env-note">未设置主密码。设置后可随时锁定应用；锁定会隐藏浏览器视图并拒绝一切业务操作，解锁需主密码。</div>
            <input v-model="pw1" type="password" placeholder="新主密码（≥8 位）" autocomplete="new-password" />
            <input v-model="pw2" type="password" placeholder="再次输入" autocomplete="new-password" style="margin-top:6px" />
            <button class="mini-btn primary" data-test="btn-set-pw" :disabled="pw1.length < 8 || pw1 !== pw2" @click="setMasterPw">设置主密码</button>
          </template>
          <template v-else>
            <div class="cf-btns" style="margin-bottom:6px">
              <button class="mini-btn primary" data-test="btn-lock-now" @click="lockNow">🔒 立即锁定</button>
              <button class="mini-btn" @click="showChangePw = !showChangePw">{{ showChangePw ? '收起' : '更换密码' }}</button>
              <button class="mini-btn danger-btn" @click="removePw">移除主密码</button>
            </div>
            <div class="bind-row">
              <span class="row-sub" style="margin-right:8px">空闲自动锁定</span>
              <select v-model.number="idleMinSel" data-test="sel-idle" @change="applyIdle">
                <option :value="0">关闭</option>
                <option :value="5">5 分钟</option>
                <option :value="15">15 分钟</option>
                <option :value="30">30 分钟</option>
                <option :value="60">60 分钟</option>
              </select>
            </div>
            <template v-if="showChangePw">
              <input v-model="oldPw" type="password" placeholder="旧主密码" autocomplete="off" />
              <input v-model="pw1" type="password" placeholder="新主密码（≥8 位）" autocomplete="new-password" style="margin-top:6px" />
              <input v-model="pw2" type="password" placeholder="再次输入" autocomplete="new-password" style="margin-top:6px" />
              <button class="mini-btn primary" style="margin-top:6px" :disabled="!oldPw || pw1.length < 8 || pw1 !== pw2" @click="setMasterPw">更新</button>
            </template>
          </template>
          <div v-if="secMsg" class="env-note" :class="{ ok: secMsgOk }">{{ secMsg }}</div>
        </div>

        <!-- 备份与诊断 - §10.2 / §22 / §28 -->
        <div class="env-sec" data-test="diag-sec">
          <div class="env-h">备份与诊断</div>
          <div class="cf-btns" style="flex-wrap:wrap">
            <button class="mini-btn" data-test="btn-backup" :disabled="busyBackup" @click="doBackup">{{ busyBackup ? '备份中…' : '立即备份数据库' }}</button>
            <button class="mini-btn" data-test="btn-diag" :disabled="busyDiag" @click="doDiagnostics">导出诊断包</button>
            <button class="mini-btn" @click="doAuditExport">导出审计日志</button>
          </div>
          <div v-if="backups.length" class="row-sub" style="margin-top:6px">最近备份：{{ backups[0].createdAt ? new Date(backups[0].createdAt).toLocaleString() : '—' }}（{{ (backups[0].sizeBytes / 1024).toFixed(0) }} KB）
            <button class="mini-btn" style="margin-left:6px" @click="doRestore(backups[0].id)">恢复到此备份</button>
          </div>
          <div class="env-note">诊断包只含版本、系统、迁移版本、代理体检与脱敏日志，绝不含会话 Cookie、密码或订单原文（§22）。</div>
        </div>
      </div>

      <!-- 任务面板 - §4.4 / §6.6（二级页签：任务列表 / 达人邀约） -->
      <div class="panel-body env-body" v-else>
        <!-- 达人邀约：按店铺平台匹配平台档案；本版只有抖店，其余平台明确拒绝 -->
        <div class="sub-pane" data-test="invite-panel">
          <div class="env-sec" v-if="!inviteProfile">
            <div class="env-h">达人邀约</div>
            <div class="empty-hint" style="padding:14px 8px">
              当前店铺的平台<b>暂不支持</b>达人邀约
            </div>
            <div class="env-note">
              本版已实现的平台：<b>{{ INVITE_SUPPORTED_PLATFORMS.join('、') }}</b>。其余平台未实测，不做猜测式实现——后续按平台逐个补齐（每加一家只需新增一份平台档案）。
              <template v-if="!ws.displayedStoreId"><br>请先打开一个店铺。</template>
            </div>
          </div>

          <template v-else>
          <div class="env-sec">
            <div class="env-h">达人邀约 · {{ inviteProfile.platform }}
              <button class="mini-btn" style="margin-left:auto" data-test="invite-open-page" @click="openInvitePage">打开达人广场</button>
            </div>

            <!-- batch-list（抖店）：广场筛选 → 批量勾选 → 抽屉话术（平台流程相互独立） -->
            <template v-if="inviteProfile.flow === 'batch-list'">
            <div class="env-note">
              可邀约的是"未发过消息"的达人——平台对已邀约过的行会禁用复选框，执行时<b>跳过并如实回报</b>跳过数量。
            </div>

            <label class="inv-row">主推类目
              <select v-model="invite.category" data-test="invite-category">
                <option value="">不筛选（全部）</option>
                <option v-for="c in inviteProfile.categories" :key="c" :value="c">{{ c }}</option>
              </select>
            </label>

            <div class="inv-row inv-block">达人等级
              <span class="inv-chips">
                <label
                  v-for="lv in inviteProfile.levels" :key="lv"
                  class="inv-chip" :class="{ on: invite.levels.includes(lv) }"
                >
                  <input type="checkbox" :value="lv" v-model="invite.levels" :data-test="'invite-level-' + lv" />{{ lv }}
                </label>
              </span>
            </div>
            <div class="env-note">
              额度按「店铺类型 × 达人等级」下发：实测本店只有 <b>{{ inviteProfile.levelsWithQuotaHint.join(' / ') }}</b> 有额度，其余为 0（邀约按钮会变禁用态）。额度随经营情况变化，请自行确认。
            </div>

            <label class="inv-row">本批数量
              <input type="number" min="1" :max="inviteProfile.maxBatch" v-model.number="invite.count" class="inv-num" data-test="invite-count" />
              <span class="row-sub">上限 {{ inviteProfile.maxBatch }} 位（平台限制）</span>
            </label>

            <div class="inv-row inv-block">话术来源
              <span class="inv-chips">
                <label class="inv-chip" :class="{ on: invite.scriptMode === 'manual' }">
                  <input type="radio" value="manual" v-model="invite.scriptMode" data-test="invite-script-mode-manual" />手填
                </label>
                <label class="inv-chip" :class="{ on: invite.scriptMode === 'ai' }">
                  <input type="radio" value="ai" v-model="invite.scriptMode" data-test="invite-script-mode-ai" />AI 生成
                </label>
              </span>
            </div>

            <label class="inv-row inv-block">邀约话术
              <textarea v-model="invite.script" :readonly="invite.scriptMode === 'ai'" :maxlength="inviteProfile.scriptMaxLen" rows="3" data-test="invite-script"
                :placeholder="invite.scriptMode === 'ai'
                  ? '不用填：执行到邀约抽屉后，AI 读取平台推荐商品现场生成并写入这个框'
                  : '您好，我们是……想邀请您合作带货：给专属高佣与免费寄样，提供现成素材，发货售后我们全包。'"></textarea>
              <span class="row-sub" v-if="invite.scriptMode === 'manual'">{{ invite.script.length }}/{{ inviteProfile.scriptMaxLen }}</span>
              <span class="row-sub" v-else>AI 生成 · 不超过 {{ inviteProfile.scriptMaxLen }} 字 · 发送前会停下让你核对</span>
            </label>
            <div class="env-note" v-if="invite.scriptMode === 'ai' && !aiReady">
              <b>AI 未配置</b>：请到「设置 → AI 配置」填写接口地址、模型名与 API Key（可先点「测试连接」验证）。
            </div>
            <div class="env-note" v-else-if="invite.scriptMode === 'ai'">
              AI 会在打开邀约抽屉后读取该抽屉里的商品信息生成话术；<b>生成的原文会落库留档</b>，且放行前会停下让你核对。
            </div>

            <div class="inv-row inv-block">专属权益（可多选）
              <span class="inv-chips">
                <label
                  v-for="b in inviteProfile.benefits" :key="b"
                  class="inv-chip" :class="{ on: invite.benefits.includes(b) }"
                >
                  <input type="checkbox" :value="b" v-model="invite.benefits" :data-test="'invite-benefit-' + b" />{{ b }}
                </label>
              </span>
            </div>

            <div class="cf-btns" style="margin-top:10px">
              <button v-if="!inviteRun" class="mini-btn primary" data-test="invite-start" :disabled="!inviteReady" @click="startInvite">开始邀约</button>
              <template v-else>
                <span class="row-sub" style="align-self:center">邀约进行中 · {{ statusLabel(inviteRun.status) }}</span>
                <button class="mini-btn" data-test="invite-stop" @click="stopInvite">停止邀约</button>
              </template>
            </div>
            <div class="env-note" v-if="!ws.displayedStoreId">请先打开一个店铺（任务要绑定店铺执行）。</div>
            </template>

            <!-- assist-form（微信小店）：人工选人进邀约页，引擎代填表单+门禁后发送 -->
            <template v-else>
            <div class="env-note">
              微信小店按达人<b>逐个邀约</b>（每位达人一张独立表单，平台不支持批量）：
              ① 点「打开达人广场」→ 自己挑选达人，进其详情页点「<b>邀请带货</b>」；
              ② 停在邀约表单页，回到这里点「开始邀约」——软件自建标签页打开同一邀约页，代填下面的联系方式与话术；
              ③ 填完<b>停下让你核对</b>，确认后才会点「发送邀约」。每次运行邀约 1 位，{{ inviteProfile.dailyQuotaHint }}。
            </div>

            <label class="inv-row">邀约联系人
              <input type="text" v-model="invite.contact" maxlength="30" data-test="invite-contact" placeholder="商家侧联系人（必填）" />
            </label>
            <label class="inv-row">微信号
              <input type="text" v-model="invite.wechat" maxlength="30" data-test="invite-wechat" placeholder="与手机号至少填一个" />
            </label>
            <label class="inv-row">手机号码
              <input type="text" v-model="invite.phone" maxlength="11" data-test="invite-phone" placeholder="与微信号至少填一个" />
            </label>

            <div class="inv-row inv-block">话术来源
              <span class="inv-chips">
                <label class="inv-chip" :class="{ on: invite.scriptMode === 'manual' }">
                  <input type="radio" value="manual" v-model="invite.scriptMode" data-test="invite-script-mode-manual" />手填
                </label>
                <label class="inv-chip" :class="{ on: invite.scriptMode === 'ai' }">
                  <input type="radio" value="ai" v-model="invite.scriptMode" data-test="invite-script-mode-ai" />AI 生成
                </label>
              </span>
            </div>

            <label class="inv-row inv-block">合作说明（邀约话术）
              <textarea v-model="invite.script" :readonly="invite.scriptMode === 'ai'" :maxlength="inviteProfile.scriptMaxLen" rows="3" data-test="invite-script"
                :placeholder="invite.scriptMode === 'ai'
                  ? '不用填：执行到邀约页后，AI 读取邀约商品信息现场生成并写入这个框'
                  : '您好，我们是……想邀请您合作带货：给专属高佣与免费寄样，提供现成素材，发货售后我们全包。'"></textarea>
              <span class="row-sub" v-if="invite.scriptMode === 'manual'">{{ invite.script.length }}/{{ inviteProfile.scriptMaxLen }}</span>
              <span class="row-sub" v-else>AI 生成 · 不超过 {{ inviteProfile.scriptMaxLen }} 字 · 发送前会停下让你核对</span>
            </label>
            <div class="env-note" v-if="invite.scriptMode === 'ai' && !aiReady">
              <b>AI 未配置</b>：请到「设置 → AI 配置」填写接口地址、模型名与 API Key（可先点「测试连接」验证）。
            </div>
            <div class="env-note" v-else-if="invite.scriptMode === 'ai'">
              AI 会在邀约页读取邀约商品信息生成话术；<b>生成的原文会落库留档</b>，且放行前会停下让你核对。
            </div>

            <label class="inv-row">添加商品数量
              <input type="number" min="1" :max="inviteProfile.maxProducts" v-model.number="invite.productCount" class="inv-num" data-test="invite-product-count" />
              <span class="row-sub">页面已有商品则原样不动；没有才自动添加，最多 {{ inviteProfile.maxProducts }} 个</span>
            </label>

            <div class="cf-btns" style="margin-top:10px">
              <button v-if="!inviteRun" class="mini-btn primary" data-test="invite-start" :disabled="!inviteReady" @click="startInvite">开始邀约</button>
              <template v-else>
                <span class="row-sub" style="align-self:center">邀约进行中 · {{ statusLabel(inviteRun.status) }}</span>
                <button class="mini-btn" data-test="invite-stop" @click="stopInvite">停止邀约</button>
              </template>
            </div>
            <div class="env-note" v-if="!ws.displayedStoreId">请先打开一个店铺（任务要绑定店铺执行）。</div>
            </template>
          </div>

          <div class="env-sec">
            <div class="env-h">邀约记录<span class="row-sub" v-if="inviteHistory.length"> · 近 {{ inviteHistory.length }} 次</span></div>
            <div class="env-note">达人邀约是独立功能，邀约运行不出现在「任务列表」；这里保留本店铺的邀约运行明细（步骤结果、门禁日志、截图工件）。</div>
            <div v-if="!inviteHistory.length" class="empty-hint" style="padding:8px 4px">本店铺还没有邀约记录</div>
            <div v-for="t in inviteHistory" :key="t.id" class="task-card" :class="{ on: detailTaskId === t.id }" data-test="invite-history-card">
              <div class="tc-head" @click="toggleTaskDetail(t)">
                <div class="p-info">
                  <div class="row-main">{{ t.name.replace('达人邀约 · ', '') }}</div>
                  <div class="row-sub">
                    {{ runTimeLabel(t) }} · {{ t.steps.length }} 步<template v-if="liveStatus(t)"> · {{ statusLabel(liveStatus(t)) }}</template>
                  </div>
                </div>
                <button class="mini-btn" v-if="['running','paused','queued','waiting_confirmation'].includes(liveStatus(t))" @click.stop="runOp(t, 'cancel')" data-test="invite-history-stop">停止</button>
                <button class="row-del" title="删除记录" @click.stop="delTask(t.id)">×</button>
              </div>
              <template v-if="detailTaskId === t.id">
                <div class="step-row" v-for="(s, i) in t.steps" :key="i">
                  <span class="s-ico">{{ stepIcon(t, i) }}</span>
                  <div class="p-info">
                    <div class="row-main">{{ i + 1 }}. {{ s.type }}<span class="row-sub"> · {{ s.timeoutMs / 1000 }}s</span></div>
                    <div class="row-sub">{{ stepInputBrief(s) }}<template v-if="stepResultBrief(t, i)"> ⇒ {{ stepResultBrief(t, i) }}</template></div>
                  </div>
                </div>
                <div class="tc-btns" v-if="detailRunId(t)">
                  <button class="mini-btn" v-if="liveStatus(t) === 'failed'" @click="runOp(t, 'retry')" title="跳过已成功步骤，副作用步骤不可恢复">从失败步骤继续</button>
                  <button class="mini-btn" @click="loadTaskDetail(t)">刷新</button>
                </div>
                <div class="row-sub" v-if="liveMessage(t)" style="padding:2px 0">{{ liveMessage(t) }}</div>
                <div class="log-box" v-if="ws.taskLogs[detailRunId(t)]?.length">
                  <div class="log-line" v-for="(l, i) in ws.taskLogs[detailRunId(t)]" :key="i">
                    {{ new Date(l.at || Date.now()).toLocaleTimeString() }} [{{ l.phase }}]{{ l.stepType ? ' ' + l.stepType : '' }} {{ l.message || '' }}
                  </div>
                </div>
              </template>
            </div>
          </div>

          <div class="env-sec">
            <div class="env-h">执行说明</div>
            <template v-if="inviteProfile.flow === 'batch-list'">
              <div class="env-note">
                点「开始邀约」会启动一次受策展的邀约运行（<b>独立功能，不进任务列表</b>；运行明细见下方「邀约记录」）：进入达人广场 → 选类目与等级 → 搜索 → 勾选前 N 位可邀约达人 → 打开邀约抽屉 → <b>先检测可邀约额度</b>（抖店不展示剩余数字，以抽屉「确认发送」是否可用来判定，不足/受限时如实失败）→ 填话术（手填或 AI 生成）→ 勾权益 → <b>停下等你确认</b> → 才会点「确认发送」。<b>拒绝即整单取消，绝不继续</b>。
              </div>
              <div class="env-note">
                邀约进行中面板会出现「停止邀约」，随时可中止运行。联系方式（手机号/微信号）与专属推荐商品由平台在抽屉里要求填写：联系方式请在平台侧填好（<b>本应用不保存你的手机号/微信号</b>），商品用平台的"推荐商品"即可。发送不可撤回，并消耗店铺邀约额度。频繁自动操作可能触发平台风控验证（如出现验证码请在页面上手动完成后重试）。
              </div>
            </template>
            <template v-else>
              <div class="env-note">
                点「开始邀约」会启动一次受策展的邀约运行（<b>独立功能，不进任务列表</b>；运行明细见下方「邀约记录」）：自建标签页镜像你打开的邀约页 → <b>先检测可邀约额度</b>（读取页面「今日剩余N次」，为 0 时如实失败）→ 填联系方式与合作说明（手填，或 AI 按邀约商品生成）→ 确保邀约商品（页面已有则不动）→ <b>停下等你核对</b> → 才会点「发送邀约」，并在平台「确认发送邀约」弹窗上点「确认」。<b>拒绝即整单取消，绝不发送</b>。发送不可撤回，并消耗店铺邀约额度。
              </div>
              <div class="env-note">
                选人由你人工完成（达人详情页 URL 带每人专属 token，软件不猜测、不代选）。运行会<b>把运行标签页切到前台</b>供你核对；邀约进行中面板会出现「停止邀约」；发送成功后会自动截图留档（「邀约记录」里可查）。
              </div>
            </template>
          </div>
          </template>
        </div>
      </div>
      </template>
    </aside>

    <!-- 数据中心：汇总展示所有店铺的数据（只读；数据来自本机快照与运行记录） -->
    <div v-if="dataCenterOpen" class="modal-mask" @click.self="dataCenterOpen = false">
      <div class="modal modal-wide dc-modal" data-test="datacenter-modal">
        <div class="dc-head">
          <h2 style="margin:0">数据中心</h2>
          <span class="row-sub">汇总所有店铺 · {{ dc.generatedAt ? new Date(dc.generatedAt).toLocaleString() : '加载中' }}<template v-if="dcLoading"> · 刷新中…</template></span>
          <button class="mini-btn" data-test="datacenter-refresh" :disabled="dcLoading" @click="loadDataCenter()">刷新</button>
          <button class="mini-btn" data-test="datacenter-close" @click="dataCenterOpen = false">关闭</button>
        </div>

        <div class="dc-cards">
          <div class="dc-card"><div class="dc-num">{{ dc.totals.stores }}</div><div class="dc-label">店铺</div></div>
          <div class="dc-card"><div class="dc-num">{{ dc.totals.online }}</div><div class="dc-label">在线</div></div>
          <div class="dc-card"><div class="dc-num">{{ dc.totals.archived }}</div><div class="dc-label">已归档</div></div>
          <div class="dc-card"><div class="dc-num">{{ dc.totals.trash }}</div><div class="dc-label">回收站</div></div>
          <div class="dc-card"><div class="dc-num">{{ dc.totals.platforms }}</div><div class="dc-label">平台数</div></div>
          <div class="dc-card"><div class="dc-num">{{ dc.totals.snapshots }}</div><div class="dc-label">指标快照</div></div>
          <div class="dc-card"><div class="dc-num">{{ dc.totals.tasks }}</div><div class="dc-label">任务</div></div>
        </div>

        <div class="env-h">按平台</div>
        <div class="dc-chips" v-if="dc.byPlatform.length">
          <span class="dc-chip" v-for="p in dc.byPlatform" :key="p.platform">{{ p.platform }} · {{ p.c }}（在线 {{ p.online || 0 }}）</span>
        </div>
        <div v-else class="empty-hint">还没有店铺</div>

        <div class="env-h">经营指标<span class="row-sub"> · 销量 / 订单 / 销售额 / 退款金额 / 退款订单数（任务从各平台后台页面读取，每店每指标取最新）</span>
          <button class="mini-btn" style="margin-left:auto" data-test="datacenter-collect" :disabled="dcCollecting" @click="collectBusinessData()">采集经营数据</button>
        </div>
        <table class="dc-table" v-if="bizRows.length">
          <thead><tr><th>店铺</th><th>平台</th><th v-for="m in BIZ_METRICS" :key="m.key">{{ m.label }}</th><th>采集时间</th></tr></thead>
          <tbody>
            <tr v-for="r in bizRows" :key="r.storeId">
              <td>{{ r.storeName }}</td>
              <td class="row-sub">{{ r.platform }}</td>
              <td v-for="m in BIZ_METRICS" :key="m.key" :class="{ 'dc-val': r.values[m.key] != null }">
                {{ bizValue(m.key, r.values[m.key]) }}
                <span v-if="r.manual[m.key]" class="dc-manual" title="手动录入（该平台数字不可自动读取）">手动</span>
                <span
                  v-if="bizDelta(m.key, r.values[m.key], r.prevs[m.key])"
                  class="dc-delta"
                  :class="{ up: bizDelta(m.key, r.values[m.key], r.prevs[m.key])!.dir === 'up', down: bizDelta(m.key, r.values[m.key], r.prevs[m.key])!.dir === 'down' }"
                >{{ bizDelta(m.key, r.values[m.key], r.prevs[m.key])!.dir === 'up' ? '▲' : bizDelta(m.key, r.values[m.key], r.prevs[m.key])!.dir === 'down' ? '▼' : '' }}{{ bizDelta(m.key, r.values[m.key], r.prevs[m.key])!.text }}</span>
              </td>
              <td class="row-sub">{{ r.lastAt ? new Date(r.lastAt).toLocaleString() : '—' }}</td>
            </tr>
            <tr class="dc-total" v-if="bizTotals.contributors">
              <td>合计</td>
              <td class="row-sub">已采集 {{ bizTotals.contributors }} 家</td>
              <td v-for="m in BIZ_METRICS" :key="m.key" class="dc-val">
                {{ bizTotals.sums[m.key] != null ? bizValue(m.key, bizTotals.sums[m.key]) : '—' }}
              </td>
              <td class="row-sub">各平台自报口径</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty-hint">还没有店铺</div>
        <div class="env-note" v-if="bizNotes.length">
          <div v-for="(n, i) in bizNotes" :key="i">口径 · {{ n }}</div>
        </div>

        <!-- 手动录入：平台用反抓取字体渲染数字时（实测拼多多），由用户看页面自行录入 -->
        <div class="dc-manual-form">
          <span class="row-sub">手动录入</span>
          <select v-model="manualDraft.storeId" data-test="dc-manual-store">
            <option v-for="s in ws.stores" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
          <select v-model="manualDraft.metric" data-test="dc-manual-metric">
            <option v-for="m in BIZ_METRICS" :key="m.key" :value="m.key">{{ m.label }}</option>
          </select>
          <input v-model.number="manualDraft.value" type="number" min="0" step="0.01" placeholder="值" class="inv-num" data-test="dc-manual-value" />
          <button class="mini-btn" :disabled="!manualReady" data-test="dc-manual-save" @click="saveManualMetric">录入</button>
        </div>
        <div class="env-note">
          个别平台（实测<b>拼多多</b>）把数字用<b>反抓取字体的私有区码位</b>渲染——页面 DOM 与接口 JSON 里都不是数字字符，自动读取必须持续对抗平台的反自动化措施，本应用<b>不做这种绕过</b>。这类平台请你自己看后台把数字录进来：录入值会标注「<b>手动</b>」来源，并同样计入合计，绝不与自动采集的数字混淆。
        </div>

        <div class="env-note" v-if="!BUSINESS_SUPPORTED_PLATFORMS.length">
          经营指标的页面锚点<b>尚未实测</b>：本应用没有平台官方 API，只能从各平台后台页面读取（走任务的「指标快照」机制）。实测一个平台登记一个——未登记的平台不会拿猜测的选择器去试。已登记：<b>暂无</b>。
        </div>

        <div class="env-h">指标快照<span class="row-sub"> · 任务 readText/readTable 步骤按「指标名」落库；每店每指标取最新一条</span></div>
        <table class="dc-table" v-if="dc.snapshots.length">
          <thead><tr><th>店铺</th><th>指标</th><th>值</th><th>采集时间</th></tr></thead>
          <tbody>
            <tr v-for="(s, i) in dc.snapshots" :key="i">
              <td>{{ s.storeName }}</td>
              <td>{{ s.metric }}</td>
              <td class="dc-val">{{ typeof s.value === 'object' ? JSON.stringify(s.value) : s.value }}</td>
              <td class="row-sub">{{ new Date(s.capturedAt).toLocaleString() }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty-hint">还没有指标快照：在任务的 readText / readTable 步骤里填「指标名」，运行后就会汇总到这里</div>

        <div class="env-h">邀约运行<span class="row-sub"> · 达人邀约独立功能的全部运行（含各店铺）</span></div>
        <div class="dc-chips" v-if="dc.invite.byStatus.length">
          <span class="dc-chip" v-for="s in dc.invite.byStatus" :key="s.status">{{ statusLabel(s.status) }} · {{ s.c }}</span>
        </div>
        <div v-else class="empty-hint">还没有邀约运行记录</div>
        <table class="dc-table" v-if="dc.invite.recent.length">
          <thead><tr><th>店铺</th><th>邀约</th><th>状态</th><th>结束时间</th><th>错误</th></tr></thead>
          <tbody>
            <tr v-for="(r, i) in dc.invite.recent" :key="i">
              <td>{{ r.storeName || '（已删除店铺）' }}</td>
              <td>{{ String(r.taskName || '').replace('达人邀约 · ', '') }}</td>
              <td :class="{ 'dc-bad': ['failed','cancelled'].includes(r.status) }">{{ statusLabel(r.status) }}</td>
              <td class="row-sub">{{ r.finished_at || r.started_at ? new Date(r.finished_at || r.started_at).toLocaleString() : '-' }}</td>
              <td class="row-sub">{{ r.error_code || '-' }}</td>
            </tr>
          </tbody>
        </table>

        <div class="env-h">任务运行（近 7 天）<span class="row-sub"> · 全部任务（邀约除外也含在内）</span></div>
        <div class="dc-chips" v-if="dc.runs.byStatus.length">
          <span class="dc-chip" v-for="s in dc.runs.byStatus" :key="s.status">{{ statusLabel(s.status) }} · {{ s.c }}</span>
        </div>
        <div v-else class="empty-hint">近 7 天没有任务运行</div>
        <table class="dc-table" v-if="dc.runs.recentIssues.length">
          <thead><tr><th>店铺</th><th>任务</th><th>状态</th><th>错误码</th><th>时间</th></tr></thead>
          <tbody>
            <tr v-for="(r, i) in dc.runs.recentIssues" :key="i">
              <td>{{ r.storeName || '（已删除店铺）' }}</td>
              <td>{{ String(r.taskName || '').slice(0, 40) }}</td>
              <td class="dc-bad">{{ statusLabel(r.status) }}</td>
              <td class="row-sub">{{ r.error_code || '-' }}</td>
              <td class="row-sub">{{ r.finished_at ? new Date(r.finished_at).toLocaleString() : '-' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 新建店铺对话框 -->
    <div v-if="ws.createDialogOpen" class="modal-mask" @click.self="ws.createDialogOpen = false">
      <div class="modal">
        <h2>新建店铺</h2>
        <label>店铺名称<input v-model="form.name" data-test="store-name" placeholder="例如：美国主站" /></label>
        <label>平台
          <div class="platform-pick">
            <PlatformIcon :name="form.platform" :size="18" />
            <select v-model="form.platform" data-test="platform-select" @change="onPlatformChange">
              <option v-for="p in quickPlatforms" :key="p.name" :value="p.name">{{ p.name }}</option>
              <option value="其他">其他（自定义平台）</option>
            </select>
          </div>
        </label>
        <label>后台地址<input v-model="form.adminUrl" placeholder="例如：https://mms.pinduoduo.com" data-test="admin-url" />
          <span class="field-note" v-if="form.adminUrl">已按所选平台填入默认后台地址，可自行修改</span>
        </label>
        <label>标签（逗号分隔）<input v-model="form.tags" placeholder="主账号, 售后组" /></label>
        <label>备注<textarea v-model="form.notes" rows="2"></textarea></label>
        <div class="modal-actions">
          <button class="btn-ghost" @click="ws.createDialogOpen = false">取消</button>
          <button class="btn-primary" @click="submitCreate" :disabled="!form.name.trim() || !form.adminUrl.trim()">创建</button>
        </div>
      </div>
    </div>

    <!-- 回收站抽屉 -->
    <div v-if="ws.trashOpen" class="modal-mask" @click.self="ws.trashOpen = false">
      <div class="modal">
        <h2>回收站</h2>
        <div v-if="ws.trashStores.length === 0" class="empty-hint">回收站是空的</div>
        <div v-for="s in ws.trashStores" :key="s.id" class="trash-row">
          <PlatformIcon :name="s.platform" :size="28" />
          <div class="trash-meta"><div>{{ s.name }}</div><div class="row-sub"><PlatformIcon :name="s.platform" :size="12" /> {{ s.platform }}</div></div>
          <button class="btn-ghost sm" @click="ws.restoreStore(s.id)">恢复</button>
          <button class="btn-danger sm" @click="confirmPurge(s)">彻底删除</button>
        </div>
        <div class="modal-actions">
          <button class="btn-ghost" @click="ws.trashOpen = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- 店铺右键菜单（§4.3 店铺操作 / §6.6 复制配置） -->
    <div
      v-if="ctx.open && ctx.store"
      class="ctx-menu"
      data-test="store-ctx"
      :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }"
      @click.stop
      @contextmenu.prevent
    >
      <button class="ctx-item" data-test="ctx-toggle" @click="ctxAction('toggle')">
        {{ isOpen(ctx.store.id) ? '关闭浏览器' : '打开浏览器' }}
      </button>
      <button class="ctx-item" data-test="ctx-standalone" :disabled="!ctxStandalone" title="需先打开该店铺并选中标签页" @click="ctxAction('standalone')">
        在独立窗口打开当前标签页
      </button>
      <div class="ctx-sep"></div>
      <button class="ctx-item" data-test="ctx-rename" @click="ctxAction('rename')">重命名…</button>
      <button class="ctx-item" data-test="ctx-copycfg" :disabled="otherStores.length === 0" title="只复制环境指纹配置，不含会话与代理凭据" @click="ctxAction('copycfg')">
        复制环境配置到其他店铺…
      </button>
      <button class="ctx-item" data-test="ctx-copyid" @click="ctxAction('copyid')">复制店铺 ID</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item danger" data-test="ctx-trash" @click="ctxAction('trash')">移入回收站</button>
    </div>

    <!-- 重命名店铺 -->
    <div v-if="rename.open" class="modal-mask" @click.self="rename.open = false">
      <div class="modal">
        <h2>重命名店铺</h2>
        <input v-model="rename.value" data-test="rename-input" maxlength="60" placeholder="店铺名称" @keydown.enter="doRename" />
        <div class="modal-actions">
          <button class="btn-ghost" @click="rename.open = false">取消</button>
          <button class="btn-primary" data-test="rename-save" :disabled="!rename.value.trim()" @click="doRename">保存</button>
        </div>
      </div>
    </div>

    <!-- 复制环境配置（§6.6：只迁移配置结构，绝不迁移 Cookie 或代理凭据） -->
    <div v-if="copycfg.open" class="modal-mask" @click.self="copycfg.open = false">
      <div class="modal">
        <h2>复制环境配置</h2>
        <div class="env-note">来源「{{ copycfg.sourceName }}」。只复制环境指纹配置（UA / 语言 / 时区 / 屏幕 / WebGL 等），<b>不含 Cookie 会话，也不迁移代理凭据</b>。</div>
        <div v-if="otherStores.length === 0" class="empty-hint">没有其他店铺可复制</div>
        <label v-for="s in otherStores" :key="s.id" class="store-pick">
          <input type="checkbox" :value="s.id" v-model="copycfg.targets" data-test="pick-target" />
          <span>{{ s.name }}</span>
        </label>
        <div class="modal-actions">
          <button class="btn-ghost" @click="copycfg.open = false">取消</button>
          <button class="btn-primary" data-test="copy-apply" :disabled="copycfg.targets.length === 0" @click="doCopyConfig">复制到选中店铺</button>
        </div>
      </div>
    </div>

    <!-- 通用二次确认（危险操作；替代 window.confirm 的原生弹窗） -->
    <div v-if="confirmBox.open" class="modal-mask" @click.self="confirmBox.open = false">
      <div class="modal">
        <h2>{{ confirmBox.title }}</h2>
        <div class="env-note">{{ confirmBox.message }}</div>
        <div class="modal-actions">
          <button class="btn-ghost" data-test="confirm-cancel" @click="confirmBox.open = false">取消</button>
          <button class="btn-danger" data-test="confirm-ok" @click="runConfirm">确认</button>
        </div>
      </div>
    </div>

    <!-- 设置：配置（各平台首页地址）/ 达人广场 / AI 配置 / 关于软件（软件信息 + 更新） -->
    <div v-if="settingsOpen" class="modal-mask" data-test="settings-dialog" @click.self="settingsOpen = false">
      <div class="modal modal-wide settings-modal">
        <h2>设置</h2>
        <div class="sub-tabs">
          <button :class="['stab', { on: settingsTab === 'config' }]" data-test="settings-tab-config" @click="openSettingsTab('config')">配置</button>
          <button :class="['stab', { on: settingsTab === 'square' }]" data-test="settings-tab-square" @click="openSettingsTab('square')">达人广场</button>
          <button :class="['stab', { on: settingsTab === 'ai' }]" data-test="settings-tab-ai" @click="openSettingsTab('ai')">AI 配置</button>
          <button :class="['stab', { on: settingsTab === 'about' }]" data-test="settings-tab-about" @click="openSettingsTab('about')">关于软件</button>
        </div>

        <!-- 配置：每个平台的首页地址 -->
        <div v-if="settingsTab === 'config'" class="sub-pane" data-test="settings-config">
          <div class="env-note">为每个平台设置「首页」地址。地址栏左上角的 ⌂ 首页按钮会跳到它；留空表示使用平台默认地址。</div>
          <div v-for="p in quickPlatforms" :key="p.name" class="plat-row" data-test="platform-home-row">
            <span class="plat-name"><PlatformIcon :name="p.name" :size="14" />{{ p.name }}</span>
            <input
              v-model="homeUrlDraft[p.name]"
              :placeholder="p.adminUrl"
              :data-test="'home-url-' + p.name"
              spellcheck="false"
            />
            <button class="mini-btn" :disabled="!homeUrlDraft[p.name]" @click="resetPlatformHome(p.name)">恢复默认</button>
          </div>
          <div class="env-note">只做格式校验（须以 http:// 或 https:// 开头），不联网探测可达性——填错了首页就打不开，请自行确认。</div>
        </div>

        <!-- 达人广场（独立页签）：按平台覆盖内置默认地址 -->
        <div v-else-if="settingsTab === 'square'" class="sub-pane" data-test="settings-square">
          <div class="env-note">达人邀约进入的页面地址。留空 = 用内置默认（已实测的抖店地址）；换成别的地址后，流程会按新地址的末段等待页面就绪。</div>
          <div v-for="p in inviteProfiles" :key="p.platform" class="plat-row" data-test="square-url-row">
            <span class="plat-name"><PlatformIcon :name="p.platform" :size="14" />{{ p.platform }}</span>
            <input
              v-model="squareUrlDraft[p.platform]"
              :placeholder="p.pageUrl"
              :data-test="'square-url-' + p.platform"
              spellcheck="false"
            />
            <button class="mini-btn" :disabled="!squareUrlDraft[p.platform]" @click="resetSquareUrl(p.platform)">恢复默认</button>
          </div>
          <div class="env-note">当前已支持达人邀约的平台：<b>{{ INVITE_SUPPORTED_PLATFORMS.join('、') }}</b>（其余平台未实测，面板会明确拒绝而不是猜测）。</div>
          <div class="env-note">只做格式校验，不联网探测可达性。</div>
        </div>

        <!-- AI 配置（独立页签）：Key 经系统加密存储，不回显 -->
        <div v-else-if="settingsTab === 'ai'" class="sub-pane" data-test="settings-ai">
          <div class="env-note">用于「达人邀约」里按平台推荐商品自动生成邀约话术。走 <b>OpenAI 兼容</b>的 /chat/completions 协议：各家中转站、聚合网关、自建网关都能接。</div>
          <label class="plat-row">服务商
            <select v-model="aiProviderKey" data-test="ai-provider" @change="applyAiPreset(aiProviderKey)">
              <option v-for="p in AI_PROVIDER_PRESETS" :key="p.key" :value="p.key">{{ p.label }}</option>
              <option value="__custom__">自定义（下方手填地址与模型名）</option>
            </select>
          </label>
          <label class="plat-row">接口地址
            <input v-model="aiDraft.endpoint" data-test="ai-endpoint" spellcheck="false"
              :placeholder="DEFAULT_AI_ENDPOINT"
              @input="aiProviderKey = '__custom__'" />
          </label>
          <div class="env-note" v-if="aiResolvedEndpoint" data-test="ai-resolved">
            实际请求：<code>{{ aiResolvedEndpoint }}</code>
            <template v-if="aiModelsUrl"><br>模型列表：<code>{{ aiModelsUrl }}</code></template>
          </div>
          <div class="env-note" v-else>可填<b>基础地址</b>（如 <code>https://api.xxx.com/v1</code>，中转站通常给这个）或<b>完整补全地址</b>（以 <code>/chat/completions</code> 结尾）——基础地址会按 OpenAI 通行约定自动补全为实际请求地址。</div>
          <label class="plat-row">模型名
            <input v-model="aiDraft.model" data-test="ai-model" spellcheck="false" :placeholder="DEFAULT_AI_MODEL" />
          </label>
          <label class="plat-row">超时(ms)
            <input v-model.number="aiDraft.timeoutMs" type="number" :min="AI_TIMEOUT_MIN_MS" :max="AI_TIMEOUT_MAX_MS" data-test="ai-timeout" class="inv-num" />
          </label>
          <label class="plat-row">API Key
            <input v-model="aiKeyDraft" type="password" data-test="ai-key" autocomplete="new-password"
              :placeholder="aiConfig.hasKey ? '已配置（留空则不改动）' : '粘贴你的 API Key'" />
          </label>
          <div class="cf-btns" style="margin-top:8px">
            <button class="mini-btn" data-test="ai-models-btn" :disabled="aiModelsLoading" @click="fetchAiModels">{{ aiModelsLoading ? '获取中…' : '获取可用模型' }}</button>
            <button class="mini-btn primary" data-test="ai-test" :disabled="aiTesting" @click="testAi">{{ aiTesting ? '测试中…' : '测试连接' }}</button>
            <button class="mini-btn danger-btn" v-if="aiConfig.hasKey" data-test="ai-key-clear" @click="clearAiKey">清除 Key</button>
          </div>
          <div class="plat-row" v-if="aiModels.length">
            <span class="plat-name" style="width:auto;flex:0 0 auto">可选模型</span>
            <select data-test="ai-model-pick" :value="aiDraft.model" @change="pickAiModel(($event.target as HTMLSelectElement).value)">
              <option value="">— 选择后填入上方模型名 —</option>
              <option v-for="m in aiModels" :key="m" :value="m">{{ m }}</option>
            </select>
            <span class="row-sub">{{ aiModels.length }} 个</span>
          </div>
          <div class="env-note" :class="{ ok: aiMsgOk }" v-if="aiMsg" data-test="ai-msg">{{ aiMsg }}</div>
          <div class="env-note">
            Key 经系统 safeStorage（Windows DPAPI）加密存储、<b>只在主进程使用，界面永不回显</b>，也不会进诊断包。
            AI 请求由主进程<b>直连出网，不走店铺代理</b>；接口地址须为 https://（仅本机 127.0.0.1/localhost 允许 http://）。
            非敏感项（接口地址 / 模型名 / 超时）随「保存」写入，Key 点「保存」时一并写入（留空表示不改）。
            「获取可用模型」是只读请求 <b>/models</b>（由接口地址推导，见上方"模型列表"），拉不到就如实报错、不编造候选。
            预设只是便捷预填，各家的模型名与可用性以你的账号为准。
          </div>
        </div>

        <!-- 关于软件：软件信息 + 更新 -->
        <div v-else class="sub-pane" data-test="settings-about">
          <div class="about-head">
            <div class="brand-logo about-logo">商</div>
            <div>
              <div class="about-name">ShopPilot</div>
              <div class="row-sub">电商店铺浏览器工作台</div>
            </div>
          </div>
          <div class="about-row"><span>版本</span><b data-test="about-version">v{{ updateStatus.currentVersion || '—' }}</b></div>
          <div class="about-row"><span>构建标签</span><b>INTERNAL_BUILD</b></div>
          <div class="about-row">
            <span>仓库</span>
            <b class="about-repo">github.com/Amike-cc/ShopPilot
              <button class="mini-btn" @click="copyRepoUrl">复制</button>
            </b>
          </div>
          <div class="env-note">未做代码签名，按 §21.5 只能标记 INTERNAL_BUILD；自动更新仅做 SHA-512 哈希校验、无签名校验。</div>

          <div class="env-h" style="margin-top:14px">软件更新</div>
          <!-- 更新区块：内部 data-test 与原对话框保持一致，验收脚本只需改"怎么进来" -->
          <div data-test="update-dialog">
            <div class="update-channel-row">
              <label>更新通道</label>
              <select data-test="update-channel" v-model="updateChannel" @change="saveUpdateChannel">
                <option value="stable">稳定版 stable</option>
                <option value="beta">测试版 beta</option>
              </select>
            </div>
            <label class="update-autocheck" title="开启后每次启动延迟自动检查一次更新">
              <input type="checkbox" data-test="update-autocheck" v-model="updateAutoCheck" @change="saveUpdateAutoCheck">启动时自动检查
            </label>
            <div v-if="updateStatus.state === 'checking'" class="update-message" data-test="update-message">正在检查更新…</div>
            <div v-else-if="updateStatus.state === 'available'" class="update-message" data-test="update-message">发现新版本 v{{ updateStatus.version }}</div>
            <div v-else-if="updateStatus.state === 'downloading'" class="update-message" data-test="update-message">正在下载 v{{ updateStatus.version }}（{{ Math.round(updateStatus.percent || 0) }}%）</div>
            <div v-else-if="updateStatus.state === 'downloaded'" class="update-message success-text" data-test="update-message">更新已下载并通过 SHA-512 校验，重启后安装</div>
            <div v-else-if="updateStatus.state === 'not-available'" class="update-message" data-test="update-message">当前已是最新版本</div>
            <div v-else-if="updateStatus.state === 'error'" class="update-message error-text" data-test="update-message">{{ updateStatus.error }}</div>
            <div v-else class="update-message" data-test="update-message">检查 GitHub Releases 上的新版本；下载完成校验哈希后重启安装，安装失败保留旧版本。</div>
            <div v-if="updateStatus.state === 'downloading'" class="update-progress"><span :style="{ width: (updateStatus.percent || 0) + '%' }"></span></div>
            <div class="cf-btns" style="margin-top:8px">
              <button v-if="['idle','not-available','error'].includes(updateStatus.state)" class="mini-btn primary" data-test="update-check-btn" @click="checkUpdate">检查更新</button>
              <button v-if="updateStatus.state === 'available'" class="mini-btn primary" data-test="update-download-btn" @click="downloadUpdate">下载更新</button>
              <button v-if="updateStatus.state === 'downloaded'" class="mini-btn primary" data-test="update-install-btn" @click="installUpdate">重启并安装</button>
            </div>
          </div>
        </div>

        <div class="modal-actions">
          <template v-if="settingsTab !== 'about'">
            <button class="btn-ghost" @click="settingsOpen = false">取消</button>
            <button class="btn-primary" data-test="settings-save" @click="saveSettingsConfig">保存</button>
          </template>
          <button v-else class="btn-ghost" @click="settingsOpen = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- Toast -->
    <div class="toast-host">
      <div v-for="t in ws.toasts" :key="t.id" :class="['toast', t.kind]">{{ t.text }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useWorkspaceStore, type StoreRow } from '../../stores/workspace'
import PlatformIcon from '../../components/PlatformIcon.vue'
import { inviteProfileFor, INVITE_PROFILES, INVITE_SUPPORTED_PLATFORMS } from '@shared/constants/invite'
import { buildInviteSteps } from '@shared/invite-steps'
import { BIZ_METRICS, businessProfileFor, BUSINESS_SUPPORTED_PLATFORMS } from '@shared/constants/business'
import { buildBusinessCollectSteps } from '@shared/business-steps'
import {
  DEFAULT_AI_ENDPOINT, DEFAULT_AI_MODEL, DEFAULT_AI_TIMEOUT_MS,
  AI_TIMEOUT_MIN_MS, AI_TIMEOUT_MAX_MS, INVITE_SQUARE_URLS_SETTING,
  AI_PROVIDER_PRESETS, normalizeAiEndpoint, modelsUrlFromChat
} from '@shared/constants/ai'

const ws = useWorkspaceStore()
const viewportEl = ref<HTMLElement | null>(null)
const urlInput = ref<HTMLElement | null>(null)
const urlDraft = ref('')

// ── 平台筛选增强 ──
/** 当前搜索+状态筛选后未过滤平台前的总店铺数 */
const totalFilteredCount = computed(() => {
  return Object.values(ws.platformCounts).reduce((a, b) => a + b, 0)
})

/** 可用平台列表：只在 quickPlatforms 有店铺的平台 + "其他"(自定义平台聚合) */
const availablePlatforms = computed(() => {
  const counts = ws.platformCounts
  // 已知平台：只保留有店铺的
  const known = quickPlatforms
    .filter(p => counts[p.name])
    .map(p => ({ name: p.name, shortName: p.name, platform: p.name, color: p.color, count: counts[p.name] }))
  // "其他": 不在 quickPlatforms 中的自定义平台
  const knownNames = new Set(quickPlatforms.map(p => p.name))
  let otherCount = 0
  for (const plat of Object.keys(counts)) {
    if (!knownNames.has(plat)) otherCount += counts[plat]
  }
  const result = [...known]
  if (otherCount > 0) {
    result.push({ name: '__other__', shortName: '其他', platform: '', color: '#8B5CF6', count: otherCount })
  }
  return result
})

/** 每个平台 chip 的激活态样式（使用平台色替代统一 primary 色） */
function chipStyle(active: boolean, color: string) {
  if (!active) return {}
  return { backgroundColor: color, borderColor: color }
}

let resizeObserver: ResizeObserver | null = null

// 平台目录来自主进程（shared/constants/platforms.ts），国内四家：拼多多/微信小店/快手小店/抖店
interface PlatformDef { name: string; color: string; adminUrl: string; entryRoutes: Array<{ title: string; url: string }> }
const quickPlatforms = (window.shopilot.platforms || []) as PlatformDef[]
const DEFAULT_PLATFORM = quickPlatforms[0]?.name || '拼多多'

// ── 设置：平台首页地址（持久化在 app_settings.platform.homeUrls） ──
/**
 * 平台首页地址覆盖表：{ 平台名: 地址 }。空/缺省表示用平台目录里的默认地址。
 * 用户可在「设置 → 配置」里为每个平台指定首页；按用户选择，**配置值优先级最高**，
 * 即无论店铺自己填了什么后台地址，首页按钮都走这里配的地址。
 */
const platformHomeUrls = ref<Record<string, string>>({})
/** 设置弹窗内"配置"页的草稿（保存前的编辑态，避免直接改到生效值） */
const homeUrlDraft = reactive<Record<string, string>>({})
const settingsOpen = ref(false)
const settingsTab = ref<'config' | 'square' | 'ai' | 'about'>('config')

/** 某平台的实际首页地址：配置值 → 平台目录默认 */
function platformHome(platformName: string): string {
  const configured = (platformHomeUrls.value[platformName] || '').trim()
  if (configured) return configured
  return quickPlatforms.find(p => p.name === platformName)?.adminUrl || ''
}

async function loadPlatformHomeUrls() {
  const res = await window.shopilot.settings.get('platform.homeUrls')
  const v = res.ok ? res.data?.value : null
  platformHomeUrls.value = v && typeof v === 'object' ? v : {}
}

// ---------- 设置：达人广场地址（按平台覆盖内置默认）----------
const inviteProfiles = computed(() => Object.values(INVITE_PROFILES))
const squareUrls = ref<Record<string, string>>({})
const squareUrlDraft = reactive<Record<string, string>>({})

/** 某平台实际使用的达人广场地址：配置值 → 平台档案内置默认 */
function squareUrlFor(platformName: string): string {
  const configured = (squareUrls.value[platformName] || '').trim()
  if (configured) return configured
  return INVITE_PROFILES[platformName]?.pageUrl || ''
}

async function loadSquareUrls() {
  const res = await window.shopilot.settings.get(INVITE_SQUARE_URLS_SETTING)
  const v = res.ok ? res.data?.value : null
  squareUrls.value = v && typeof v === 'object' ? v : {}
}

/** 存覆盖表；只做格式校验（http/https），不联网探测——与平台首页地址同一红线 */
async function saveSquareUrls(): Promise<boolean> {
  const next: Record<string, string> = {}
  for (const p of inviteProfiles.value) {
    const v = (squareUrlDraft[p.platform] || '').trim()
    if (!v) continue
    if (!/^https?:\/\//i.test(v)) {
      ws.toast(`「${p.platform}」的达人广场地址需以 http:// 或 https:// 开头`, 'error')
      return false
    }
    next[p.platform] = v
  }
  const res = await window.shopilot.settings.set(INVITE_SQUARE_URLS_SETTING, next)
  if (!res.ok) { ws.toast('保存达人广场地址失败: ' + res.error.message, 'error'); return false }
  squareUrls.value = next
  return true
}

function resetSquareUrl(platformName: string) { squareUrlDraft[platformName] = '' }

// ---------- 设置：AI 配置（大模型）----------
const aiConfig = ref<{ endpoint: string; resolvedEndpoint?: string; model: string; timeoutMs: number; hasKey: boolean }>({
  endpoint: DEFAULT_AI_ENDPOINT, model: DEFAULT_AI_MODEL, timeoutMs: DEFAULT_AI_TIMEOUT_MS, hasKey: false
})
const aiDraft = reactive({ endpoint: '', model: '', timeoutMs: DEFAULT_AI_TIMEOUT_MS })
const aiKeyDraft = ref('')
const aiMsg = ref('')
const aiMsgOk = ref(false)
const aiTesting = ref(false)
/** 「获取可用模型」拉回来的模型名（只读接口；失败时保持为空并如实报错，不编造候选） */
const aiModels = ref<string[]>([])
const aiModelsLoading = ref(false)
/** 服务商预设（含中转站/自定义）：只是便捷预填，选完仍可任意改地址与模型名 */
const aiProviderKey = ref('__custom__')

/** 规范化后的实际请求地址（与主进程同一套规则，界面据此让用户看清"到底请求哪"） */
const aiResolvedEndpoint = computed(() => normalizeAiEndpoint(aiDraft.endpoint))
/** 由实际请求地址推导的模型列表地址（推不出来就不显示，不猜） */
const aiModelsUrl = computed(() => modelsUrlFromChat(aiDraft.endpoint) || '')

/** 选中预设：填基础地址 + 常见模型名；「自定义」只切标记，不动用户已填内容 */
function applyAiPreset(key: string) {
  const p = AI_PROVIDER_PRESETS.find(x => x.key === key)
  if (!p || !p.baseUrl) return
  aiDraft.endpoint = p.baseUrl
  if (p.models.length && !p.models.includes(aiDraft.model)) aiDraft.model = p.models[0]
  aiModels.value = []
  aiMsg.value = ''
}

/** 载入配置后按地址反查所属预设（只为下拉显示正确，不改用户数据） */
function matchPresetFor(endpoint: string): string {
  const norm = normalizeAiEndpoint(endpoint)
  const hit = AI_PROVIDER_PRESETS.find(p => p.baseUrl && normalizeAiEndpoint(p.baseUrl) === norm)
  return hit ? hit.key : '__custom__'
}

async function loadAiConfig() {
  const res = await window.shopilot.ai.configGet()
  if (!res.ok) return
  aiConfig.value = res.data
  aiDraft.endpoint = res.data.endpoint
  aiDraft.model = res.data.model
  aiDraft.timeoutMs = res.data.timeoutMs
  aiProviderKey.value = matchPresetFor(res.data.endpoint)
}

/** 保存 AI 非敏感项；Key 留空表示不改动（避免误清空） */
async function saveAiConfig(): Promise<boolean> {
  const res = await window.shopilot.ai.configSet({
    endpoint: aiDraft.endpoint.trim(),
    model: aiDraft.model.trim(),
    timeoutMs: Number(aiDraft.timeoutMs) || DEFAULT_AI_TIMEOUT_MS
  })
  if (!res.ok) { ws.toast('保存 AI 配置失败: ' + res.error.message, 'error'); return false }
  aiConfig.value = res.data
  const key = aiKeyDraft.value.trim()
  if (key) {
    const kr = await window.shopilot.ai.setKey(key)
    if (!kr.ok) { ws.toast('保存 API Key 失败: ' + kr.error.message, 'error'); return false }
    aiKeyDraft.value = ''
    aiConfig.value = { ...aiConfig.value, hasKey: kr.data.hasKey }
  }
  return true
}

async function testAi() {
  aiTesting.value = true
  aiMsg.value = ''
  // 先落盘再测，避免"测的是旧配置"
  if (!(await saveAiConfig())) { aiTesting.value = false; return }
  const res = await window.shopilot.ai.test()
  aiTesting.value = false
  if (res.ok) { aiMsgOk.value = true; aiMsg.value = `连接成功：模型 ${res.data.model}，${res.data.elapsedMs}ms` }
  else { aiMsgOk.value = false; aiMsg.value = `连接失败（${res.error.code}）：${res.error.message}` }
}

/**
 * 获取可用模型：只读 GET /models（地址由接口地址推导）。
 * 先落盘再拉取，避免"拿旧地址去请求"；失败只如实报错，不保留/编造任何候选模型。
 */
async function fetchAiModels() {
  aiModelsLoading.value = true
  aiMsg.value = ''
  if (!(await saveAiConfig())) { aiModelsLoading.value = false; return }
  const res = await window.shopilot.ai.listModels()
  aiModelsLoading.value = false
  if (res.ok) {
    aiModels.value = res.data.models
    aiMsgOk.value = true
    aiMsg.value = `已获取 ${res.data.models.length} 个可用模型（${res.data.elapsedMs}ms），在下拉里选一个即填入模型名`
  } else {
    aiModels.value = []
    aiMsgOk.value = false
    aiMsg.value = `获取模型失败（${res.error.code}）：${res.error.message}`
  }
}

/** 选中下拉项 → 只把模型名填进输入框（仍需点「保存」才生效） */
function pickAiModel(name: string) {
  if (name) aiDraft.model = name
}

// 接口地址一改，之前拉到的模型列表就不再对应当前端点了：立即清空，避免误选
watch(() => aiDraft.endpoint, () => { aiModels.value = [] })

async function clearAiKey() {
  const res = await window.shopilot.ai.clearKey()
  if (res.ok) { aiConfig.value = { ...aiConfig.value, hasKey: false }; aiMsgOk.value = true; aiMsg.value = 'API Key 已清除' }
  else { aiMsgOk.value = false; aiMsg.value = '清除失败: ' + res.error.message }
}

function openSettings(tab: 'config' | 'square' | 'ai' | 'about' = 'config') {
  settingsOpen.value = true
  settingsTab.value = tab
  for (const p of quickPlatforms) homeUrlDraft[p.name] = platformHomeUrls.value[p.name] || ''
  for (const p of inviteProfiles.value) squareUrlDraft[p.platform] = squareUrls.value[p.platform] || ''
  void loadAiConfig()
  if (tab === 'about') void refreshUpdatePanel()
}

/** 打开"关于软件"页时刷新版本与更新状态（进入设置弹窗时调用） */
async function refreshUpdatePanel() {
  const [ch, ac, res] = await Promise.all([
    window.shopilot.settings.get('update.channel'),
    window.shopilot.settings.get('update.autoCheck'),
    window.shopilot.update.status()
  ])
  if (ch.ok && (ch.data?.value === 'stable' || ch.data?.value === 'beta')) updateChannel.value = ch.data.value
  if (ac.ok) updateAutoCheck.value = ac.data?.value === true
  if (res.ok) applyUpdateStatus(res.data)
}

/**
 * 保存平台首页地址。只接受 http(s) 开头或留空（留空 = 回退平台默认）；
 * 这里不做可达性探测——与仓库"不猜测地址"的红线一致，配错了首页就打不开，由用户自己判断。
 */
async function savePlatformHomeUrls(): Promise<boolean> {
  const next: Record<string, string> = {}
  for (const p of quickPlatforms) {
    const v = (homeUrlDraft[p.name] || '').trim()
    if (!v) continue
    if (!/^https?:\/\//i.test(v)) {
      ws.toast(`「${p.name}」的首页地址需以 http:// 或 https:// 开头`, 'error')
      return false
    }
    next[p.name] = v
  }
  const res = await window.shopilot.settings.set('platform.homeUrls', next)
  if (!res.ok) { ws.toast('保存失败: ' + res.error.message, 'error'); return false }
  platformHomeUrls.value = next
  ws.toast('平台首页地址已保存', 'success')
  return true
}

/** 单个平台恢复默认（清空覆盖值，仅改草稿，仍需点保存） */
function resetPlatformHome(name: string) {
  homeUrlDraft[name] = ''
}

/** 保存当前页签自己的配置；校验/写入失败就留在弹窗里，成功才关闭 */
async function saveSettingsConfig() {
  const tab = settingsTab.value
  if (tab === 'config') {
    if (!(await savePlatformHomeUrls())) return
  } else if (tab === 'square') {
    if (!(await saveSquareUrls())) return
    ws.toast('达人广场地址已保存', 'success')
  } else if (tab === 'ai') {
    if (!(await saveAiConfig())) return
    ws.toast('AI 配置已保存', 'success')
  } else {
    settingsOpen.value = false
    return
  }
  settingsOpen.value = false
}

/** 复制仓库地址（不跳转外链：渲染层不做外部导航，避免被导航拦截策略挡住） */
async function copyRepoUrl() {
  try {
    await navigator.clipboard.writeText('https://github.com/Amike-cc/ShopPilot')
    ws.toast('已复制仓库地址', 'success')
  } catch {
    ws.toast('复制失败：github.com/Amike-cc/ShopPilot', 'info')
  }
}

/**
 * 首页按钮的目标地址，按优先级：**设置里配置的平台首页 → 店铺自己的后台地址 → 平台目录默认 → 空**。
 * 配置值优先级最高是用户明确选择的（配了就以它为准）；未配置时仍尊重店铺自己填的后台地址，
 * 否则"每个店铺可定制后台地址"对四家平台就形同失效了。
 */
const homeUrl = computed(() => {
  const s = ws.stores.find(x => x.id === ws.displayedStoreId)
  if (!s) return ''
  const configured = (platformHomeUrls.value[s.platform] || '').trim()
  return configured || (s.adminUrl || '').trim() || platformHome(s.platform)
})

/** 回到店铺首页；无活动标签页时 ws.navigate 会新建一个 */
function goHome() {
  if (homeUrl.value) ws.navigate(homeUrl.value)
}

const form = reactive({ name: '', platform: DEFAULT_PLATFORM, adminUrl: '', tags: '', notes: '' })

type UpdateState = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
const updateStatus = reactive<{ state: UpdateState; currentVersion: string; version?: string; percent?: number; error?: string }>({ state: 'idle', currentVersion: '' })
/** 更新通道与启动自动检查（§21 双通道）：持久化在 app_settings，主进程检查时读取 */
const updateChannel = ref<string>('stable')
const updateAutoCheck = ref(false)
let updateEventHandler: ((payload: any) => void) | null = null

function applyUpdateStatus(payload: any) {
  if (!payload) return
  Object.assign(updateStatus, payload)
}
async function openSettingsTab(tab: 'config' | 'square' | 'ai' | 'about') {
  settingsTab.value = tab
  if (tab === 'about') await refreshUpdatePanel()
}

async function saveUpdateChannel() {
  await window.shopilot.settings.set('update.channel', updateChannel.value === 'beta' ? 'beta' : 'stable')
  const res = await window.shopilot.update.status()
  if (res.ok) applyUpdateStatus(res.data)
}
async function saveUpdateAutoCheck() {
  await window.shopilot.settings.set('update.autoCheck', updateAutoCheck.value === true)
}
async function checkUpdate() {
  updateStatus.state = 'checking'
  const res = await window.shopilot.update.check()
  if (res.ok) applyUpdateStatus(res.data)
  else { updateStatus.state = 'error'; updateStatus.error = res.error.message }
}
async function downloadUpdate() {
  const res = await window.shopilot.update.download()
  if (res.ok) applyUpdateStatus(res.data)
  else { updateStatus.state = 'error'; updateStatus.error = res.error.message }
}
async function installUpdate() { await window.shopilot.update.install() }

/**
 * 选中平台后自动填入该平台的后台地址（仅当地址为空或仍是别的平台的默认值时，不覆盖用户手填）。
 * 取「设置 → 配置」里配的平台首页地址，其次平台目录默认——保持与首页按钮同一套地址来源。
 */
function applyPlatformDefaults(name: string) {
  if (!quickPlatforms.some(p => p.name === name)) return
  const target = platformHome(name)
  const cur = (form.adminUrl || '').trim()
  const isOtherPlatformDefault = quickPlatforms.some(p => p.name !== name && platformHome(p.name) === cur)
  if (!cur || isOtherPlatformDefault) form.adminUrl = target
}
function onPlatformChange() { applyPlatformDefaults(form.platform) }

/** 一键清除所有筛选条件（搜索 + 平台 + 状态） */
function clearFilters() {
  ws.search = ''
  ws.filterPlatform = ''
}

function isOpen(id: string) { return ws.openStoreIds.includes(id) }

function statusColor(s: string) {
  return ({ online: '#10B981', launching: '#3B82F6', needs_login: '#F59E0B', proxy_error: '#EF4444', archived: '#6B6B6B' } as any)[s] || '#6B7280'
}

function shortUrl(u: string) { try { return new URL(u).host } catch { return u } }
function fmtSize(n: number) { if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB' }
function dlStateText(s: string) { return ({ completed: '已完成', in_progress: '下载中', cancelled: '已取消', interrupted: '中断' } as any)[s] || s }

type ViewportReport = { x: number; y: number; width: number; height: number }
let pendingViewportReport: ViewportReport | null = null
let viewportReportRunning = false

/**
 * ResizeObserver、面板切换和窗口 resize 可能在同一帧连续触发。
 * IPC invoke 虽然返回 Promise，但多个调用并不保证按视觉状态顺序完成，
 * 旧 bounds 晚到时会把原生 WebContentsView 留在过期宽度。串行提交并只保留最新值。
 */
function flushViewportReports() {
  if (viewportReportRunning) return
  viewportReportRunning = true
  void (async () => {
    try {
      while (pendingViewportReport) {
        const next = pendingViewportReport
        pendingViewportReport = null
        await window.shopilot.browser.setViewport(next)
      }
    } finally {
      viewportReportRunning = false
      if (pendingViewportReport) flushViewportReports()
    }
  })()
}

function reportViewport() {
  const el = viewportEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  pendingViewportReport = {
    x: Math.round(r.left), y: Math.round(r.top),
    width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height))
  }
  flushViewportReports()
}

async function toggleStore(id: string) {
  if (isOpen(id)) await ws.closeStore(id)
  else await ws.openStore(id)
}

function submitUrl() {
  let u = urlDraft.value.trim()
  if (!u) return
  if (!/^[a-z]+:\/\//i.test(u)) u = 'https://' + u
  ws.navigate(u)
}

watch(() => ws.activeTab?.url, (v) => { urlDraft.value = v || '' }, { immediate: true })
watch(() => ws.displayedStoreId, () => { nextTick(reportViewport) })

async function bookmarkCurrent() {
  const t = ws.activeTab
  if (!t || t.url === 'about:blank') { ws.toast('当前页无法收藏', 'info'); return }
  const res = await window.shopilot.bookmark.create({ storeId: ws.displayedStoreId, url: t.url, title: t.title || t.url })
  if (res.ok) { ws.toast('已收藏', 'success'); ws.refreshBookmarks() }
}

async function delBookmark(id: string) {
  await window.shopilot.bookmark.delete(id)
  ws.refreshBookmarks()
}

function openWindow() {
  if (ws.activeTab) window.shopilot.browser.openWindow(ws.displayedStoreId!, ws.activeTab.id)
}

// ---------- 环境面板：代理 + 指纹（§8.1 / §13 / §16） ----------
interface ProxyLite { id: string; type: string; host: string; port: number; label: string | null; status: string; hasCredential: boolean; lastLatencyMs: number | null }
const proxies = ref<ProxyLite[]>([])
const proxyBindId = ref('')
const envBindingNote = ref('')
const lastProxyAuth = ref<{ at: number; username: string; proxyId: string } | null>(null)
const testingIds = ref<string[]>([])
const verifyItems = ref<Array<{ field: string; expected: any; actual: any; state: string }>>([])
const verifying = ref(false)
const np = reactive({ label: '', type: 'http', host: '', port: null as number | null, user: '', pass: '' })

async function refreshEnv() {
  const pl = await window.shopilot.proxy.list()
  if (pl.ok) proxies.value = pl.data
  const sid = ws.displayedStoreId
  if (!sid) return
  const st = await window.shopilot.session.status(sid)
  if (st.ok) {
    const b = st.data.binding
    proxyBindId.value = b && b.mode === 'bound' ? (b.proxyId || '') : ''
    envBindingNote.value = b && b.mode === 'bound' ? '当前：绑定代理' : '当前：直连'
    lastProxyAuth.value = st.data.lastProxyAuth || null
  }
}

async function applyBind() {
  const sid = ws.displayedStoreId
  if (!sid) return
  const res = await window.shopilot.proxy.bind(sid, proxyBindId.value || null)
  if (res.ok) {
    ws.toast(proxyBindId.value ? '已绑定代理，对打开中的店铺即时生效' : '已切回直连', 'success')
    refreshEnv()
  } else ws.toast('绑定失败: ' + res.error.message, 'error')
}

async function testProxy(p: ProxyLite) {
  testingIds.value = [...testingIds.value, p.id]
  const res = await window.shopilot.proxy.test({ type: p.type, host: p.host, port: p.port }, p.id)
  testingIds.value = testingIds.value.filter(x => x !== p.id)
  if (res.ok && res.data.ok) ws.toast(`代理可达，延迟 ${res.data.latencyMs} ms`, 'success')
  else ws.toast('代理不可达: ' + (res.ok ? res.data.errorCode : res.error.message), 'error')
  refreshEnv()
}

async function addProxy() {
  const draft = { type: np.type, host: np.host.trim(), port: Number(np.port), label: np.label.trim() || undefined }
  const res = await window.shopilot.proxy.create(draft, np.user || undefined, np.pass || undefined)
  if (res.ok) {
    ws.toast('代理已保存（凭据经本机加密存储，不回显）', 'success')
    np.label = ''; np.host = ''; np.port = null; np.user = ''; np.pass = ''
    refreshEnv()
  } else ws.toast('保存失败: ' + res.error.message, 'error')
}

async function removeProxy(id: string) {
  if (!window.confirm('删除该代理？绑定它的店铺会回退直连。')) return
  await window.shopilot.proxy.delete(id)
  if (proxyBindId.value === id) proxyBindId.value = ''
  refreshEnv()
}

async function verifyEnv() {
  const sid = ws.displayedStoreId
  if (!sid) return
  verifying.value = true
  const res = await window.shopilot.profile.verify(sid)
  verifying.value = false
  if (res.ok) {
    verifyItems.value = res.data.items
    const bad = res.data.items.filter((i: any) => i.state !== 'verified').length
    ws.toast(bad === 0 ? '环境指纹全部字段实测一致' : `${bad} 个字段未验证（需浏览器打开该店铺页面）`, bad === 0 ? 'success' : 'info')
  } else ws.toast('验证失败: ' + res.error.message, 'error')
}

function clip(v: any): string {
  const s = v == null ? '—' : String(v)
  return s.length > 46 ? s.slice(0, 43) + '…' : s
}

// ---------- 会话包 / Cookie 查看器（§6.3 / §10.2） ----------
const cookies = ref<any[]>([])
const cookiesTotal = ref(0)
const ckSearch = ref('')
const secBusy = ref(false)

async function refreshCookies() {
  const sid = ws.displayedStoreId
  if (!sid) { cookies.value = []; cookiesTotal.value = 0; return }
  const res = await window.shopilot.session.cookies(sid, ckSearch.value || undefined)
  if (res.ok) { cookies.value = res.data.items; cookiesTotal.value = res.data.total }
}

async function exportSession() {
  const sid = ws.displayedStoreId
  if (!sid) return
  secBusy.value = true
  const res = await window.shopilot.session.export(sid)
  secBusy.value = false
  if (res.ok) ws.toast(`会话包已导出（${res.data.cookieCount} 条 Cookie，有效期至 ${new Date(res.data.expiresAt).toLocaleDateString()}）`, 'success')
  else if (res.error.code !== 'SESSION_CANCELLED') ws.toast('导出失败: ' + res.error.message, 'error')
  if (res.ok) refreshCookies()
}

async function importSession() {
  const sid = ws.displayedStoreId
  if (!sid) return
  secBusy.value = true
  const res = await window.shopilot.session.import(sid, '', true)
  secBusy.value = false
  if (res.ok) ws.toast(`会话已导入：${res.data.imported} 条 Cookie 生效${res.data.failed ? `（${res.data.failed} 条失败）` : ''}${res.data.profileRestored ? '，指纹配置已随包恢复' : ''}`, 'success')
  else if (res.error.code !== 'SESSION_CANCELLED') ws.toast('导入失败: ' + res.error.message, 'error')
  refreshCookies()
}

async function delCookie(c: any) {
  const sid = ws.displayedStoreId
  if (!sid) return
  await window.shopilot.session.deleteCookie(sid, c.name, c.domain, c.path, c.secure)
  refreshCookies()
}

async function clearCookies() {
  const sid = ws.displayedStoreId
  if (!sid) return
  if (!window.confirm(`清空「${storeName(sid)}」的全部 Cookie？该店铺的登录态将失效。`)) return
  const res = await window.shopilot.session.clearCookies(sid)
  if (res.ok) ws.toast('Cookie 已清空', 'success')
  refreshCookies()
}

// ---------- 应用锁（§6.5 / §189） ----------
const pw1 = ref(''); const pw2 = ref(''); const oldPw = ref('')
const showChangePw = ref(false)
const secMsg = ref(''); const secMsgOk = ref(false)
const idleMinSel = ref(0)

function say(msg: string, okf = true) { secMsg.value = msg; secMsgOk.value = okf }

async function setMasterPw() {
  const wasEnabled = ws.securityEnabled
  const res = await window.shopilot.security.setPassword(pw1.value, wasEnabled ? oldPw.value : undefined)
  if (res.ok) {
    say(wasEnabled ? '主密码已更新' : '主密码已设置，可立即锁定或等待空闲自动锁定')
    pw1.value = ''; pw2.value = ''; oldPw.value = ''; showChangePw.value = false
    await ws.refreshSecurity()
  } else say(res.error.message, false)
}

async function removePw() {
  const cred = window.prompt('移除主密码需输入当前密码')
  if (!cred) return
  const res = await window.shopilot.security.removePassword(cred)
  if (res.ok) { say('主密码已移除'); await ws.refreshSecurity() }
  else say(res.error.message, false)
}

async function lockNow() {
  const res = await window.shopilot.security.lock()
  if (res.ok) await ws.refreshSecurity()
  else say(res.error.message, false)
}

async function applyIdle() {
  const res = await window.shopilot.settings.set('security.idleMinutes', idleMinSel.value)
  if (res.ok) { say(idleMinSel.value ? `空闲 ${idleMinSel.value} 分钟自动锁定已启用` : '空闲自动锁定已关闭'); await ws.refreshSecurity() }
}

watch(() => ws.idleMinutes, (v) => { idleMinSel.value = v }, { immediate: true })
watch(() => ws.proxyEpoch, () => { refreshEnv() })
watch(() => ws.displayedStoreId, () => { refreshCookies(); if (ws.rightPanel === 'bookmarks') refreshEntryRoutes() })

// ---------- 备份与诊断（§10.2 / §22 / §28） ----------
const backups = ref<any[]>([])
const busyBackup = ref(false)
const busyDiag = ref(false)

async function refreshBackups() {
  const res = await window.shopilot.backup.list()
  if (res.ok) backups.value = (res.data || []).slice(0, 3)
}

async function doBackup() {
  busyBackup.value = true
  const res = await window.shopilot.backup.create()
  busyBackup.value = false
  if (res.ok) { ws.toast('数据库备份完成（含校验和）', 'success'); refreshBackups() }
  else ws.toast('备份失败: ' + res.error.message, 'error')
}

async function doRestore(id: string) {
  if (!window.confirm('恢复将覆盖当前数据库（恢复前会自动创建安全快照）。继续？')) return
  busyBackup.value = true
  const res = await window.shopilot.backup.restore(id)
  busyBackup.value = false
  if (res.ok) { ws.toast('已恢复备份，安全快照已保留', 'success'); await ws.refreshStores() }
  else ws.toast('恢复失败（现有数据未受影响）: ' + res.error.message, 'error')
}

async function doDiagnostics() {
  busyDiag.value = true
  const res = await window.shopilot.diagnostics.export()
  busyDiag.value = false
  if (res.ok) ws.toast('诊断包已导出：' + res.data.path, 'success')
  else if (res.error.code !== 'SESSION_CANCELLED') ws.toast('导出失败: ' + res.error.message, 'error')
}

async function doAuditExport() {
  const res = await window.shopilot.audit.export({ limit: 5000 })
  if (res.ok) ws.toast(`审计日志已导出（${res.data.rows} 条）`, 'success')
  else if (res.error.code !== 'SESSION_CANCELLED') ws.toast('导出失败: ' + res.error.message, 'error')
}

refreshBackups()

watch(() => ws.displayedStoreId, () => { verifyItems.value = []; detailTaskId.value = null; if (ws.rightPanel === 'env') refreshEnv() })

// ---------- 任务面板（§4.4 预定义步骤 / §6.6 事件） ----------
/** 任务功能对应每个店铺：任务列表只显示当前显示店铺的任务（引擎侧仍存全量，仅界面按店铺隔离）。
 *  达人邀约是独立功能——邀约运行（名称前缀「达人邀约 ·」）不进任务列表，只在邀约面板的「邀约记录」里展示；
 *  未打开店铺时显示历史遗留的"未绑定店铺"任务（新任务一律绑定店铺） */
const INVITE_TASK_PREFIX = '达人邀约 ·'
const inviteHistory = computed(() => {
  const sid = ws.displayedStoreId
  if (!sid) return []
  return ws.tasks.filter(t => t.storeScope === sid && t.name.startsWith(INVITE_TASK_PREFIX)).slice(0, 5)
})
/** 邀约记录行的时间标签：取最近一次运行的结束/开始/创建时间 */
function runTimeLabel(t: any): string {
  const run = t.latestRun
  const ts = run?.finishedAt || run?.startedAt || t.createdAt
  if (!ts) return ''
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
// ---------- 达人邀约：按「当前店铺的平台」匹配平台档案（平台流程相互独立） ----------
const inviteProfile = computed(() => {
  const s = ws.stores.find(x => x.id === ws.displayedStoreId)
  return inviteProfileFor(s?.platform)
})
const invite = reactive({
  category: '' as string,
  levels: [] as string[],
  count: 5,
  script: '',
  benefits: [] as string[],
  /** 话术来源：手填 / AI 按平台推荐商品生成（AI 模式下话术框只读，由任务运行时写入） */
  scriptMode: 'manual' as 'manual' | 'ai',
  // ---- 以下为 assist-form（微信小店）专属字段 ----
  contact: '',
  wechat: '',
  phone: '',
  productCount: 1,
  /** 跨平台不共话术：切到不同平台的店铺时清空脚本（抖店/微信的话术口径不同） */
  platformKey: ''
})
// 店铺/平台变化时把可选项重置为该平台档案的默认值（脚本/联系人保留，避免用户输入被清掉）
watch(inviteProfile, (p) => {
  if (!p) return
  if (invite.platformKey !== p.platform) {
    invite.script = ''
    invite.scriptMode = 'manual'
    invite.platformKey = p.platform
  }
  if (p.flow === 'batch-list') {
    invite.category = p.categories[2] || p.categories[0] || ''
    invite.levels = [...p.levelsWithQuotaHint]
    invite.benefits = []
    invite.count = Math.max(1, Math.min(invite.count || 5, p.maxBatch))
  } else {
    invite.levels = []
    invite.benefits = []
    invite.count = 1
    invite.productCount = Math.max(1, Math.min(invite.productCount || 1, p.maxProducts))
  }
}, { immediate: true })

/** AI 是否可用（接口地址/模型名有值 + 主进程已存 Key）——AI 模式下用它当"开始邀约"的前置条件 */
const aiReady = computed(() => !!aiConfig.value.endpoint && !!aiConfig.value.model && aiConfig.value.hasKey)

const inviteReady = computed(() => {
  const p = inviteProfile.value
  if (!p || !ws.displayedStoreId) return false
  const scriptOk = invite.scriptMode === 'ai' ? aiReady.value : invite.script.trim().length > 0
  // 微信小店：联系人必填，微信号/手机号至少一个（平台用来联系商家）
  if (p.flow === 'assist-form') {
    return scriptOk &&
      invite.contact.trim().length > 0 &&
      (invite.wechat.trim().length > 0 || invite.phone.trim().length > 0) &&
      invite.productCount >= 1 && invite.productCount <= p.maxProducts
  }
  return invite.levels.length > 0 &&
    invite.count >= 1 && invite.count <= p.maxBatch &&
    scriptOk
})

/** 打开达人广场：带上登录态让用户确认页面 / 填写平台侧联系方式 */
function openInvitePage() {
  const p = inviteProfile.value
  if (p) ws.navigate(squareUrlFor(p.platform))
}

/**
 * 步骤序列构造已下沉到 shared/invite-steps.ts（渲染层与单测共用，平台流程相互独立）。
 * 这里只负责把面板配置收拢成对应流程的 options。
 */
/** 当前店铺是否有邀约任务在途（排队/运行/等确认/暂停）：有则面板显示「停止邀约」并禁用「开始」 */
const ACTIVE_RUN_STATES = ['queued', 'running', 'waiting_confirmation', 'paused']
const inviteRun = computed(() => {
  const sid = ws.displayedStoreId
  if (!sid) return null
  for (const t of ws.tasks) {
    if (t.storeScope !== sid || !t.name.startsWith('达人邀约 ·')) continue
    const run = t.latestRun
    if (!run) continue
    const st = ws.runLive[run.id]?.status || run.status
    if (ACTIVE_RUN_STATES.includes(st)) return { taskId: t.id, runId: run.id, status: st }
  }
  return null
})

async function stopInvite() {
  const run = inviteRun.value
  if (!run) return
  const res = await window.shopilot.task.cancel(run.runId)
  if (res.ok) ws.toast('已请求停止邀约，运行将尽快取消', 'info')
  else ws.toast('停止邀约失败: ' + res.error.message, 'error')
  await ws.refreshTasks()
}

async function startInvite() {
  const p = inviteProfile.value
  if (!p || !inviteReady.value) return
  const squareUrl = squareUrlFor(p.platform)
  const steps = p.flow === 'batch-list'
    ? buildInviteSteps(p, {
        batch: {
          category: invite.category, levels: invite.levels, count: invite.count,
          script: invite.script, scriptMode: invite.scriptMode, benefits: invite.benefits
        }
      }, squareUrl)
    : buildInviteSteps(p, {
        assist: {
          contact: invite.contact, wechat: invite.wechat, phone: invite.phone,
          script: invite.script, scriptMode: invite.scriptMode, productCount: invite.productCount
        }
      }, squareUrl)
  const name = p.flow === 'batch-list'
    ? `达人邀约 · ${p.platform} · ${invite.category || '全部'} · 最多 ${invite.count} 位`
    : `达人邀约 · ${p.platform} · 辅助填单 · ${invite.contact.trim() || '未命名'}`
  const created = await window.shopilot.task.create({ name, storeScope: ws.displayedStoreId, steps })
  if (!created.ok) { ws.toast('创建邀约任务失败: ' + created.error.message, 'error'); return }
  const started = await window.shopilot.task.run(created.data.id)
  if (!started.ok) { ws.toast('启动邀约任务失败: ' + started.error.message, 'error'); return }
  ws.toast('邀约任务已启动：点「发送」前会先停下让你确认', 'success')
  // 留在邀约面板：进行中状态与「停止邀约」按钮就地可见（任务详情在「任务列表」页签可查）
  await ws.refreshTasks()
}

const tf = reactive({
  name: '', storeId: '', everyMin: null as number | null,
  steps: [] as Array<{ type: string; timeoutSec: number; retry: number; params: Record<string, string> }>
})

const detailTaskId = ref<string | null>(null)
const detailData = reactive<Record<string, any>>({})

function storeName(id: string | null) {
  if (!id) return '未绑定店铺'
  const s = ws.stores.find(x => x.id === id)
  return s ? s.name : '店铺'
}
function statusLabel(st: string) {
  return ({ queued: '排队中', running: '运行中', waiting_confirmation: '等待确认', paused: '已暂停', succeeded: '已成功', failed: '已失败', cancelled: '已取消' } as any)[st] || st
}
function liveStatus(t: any): string {
  const rid = t.latestRun?.id
  return (rid && ws.runLive[rid]?.status) || t.latestRun?.status || ''
}
function liveMessage(t: any): string {
  const rid = t.latestRun?.id
  if (rid && ws.runLive[rid]?.message) return ws.runLive[rid].message
  return t.latestRun?.statusReason || t.latestRun?.errorMessage || ''
}
function detailRunId(t: any): string | null { return t.latestRun?.id || null }
function resultOf(t: any, i: number) {
  const d = detailData[t.id]
  return d?.results?.find((r: any) => r.stepIndex === i) || null
}
function stepIcon(t: any, i: number): string {
  if (resultOf(t, i)) return '✅'
  const st = liveStatus(t)
  const live = t.latestRun ? ws.runLive[t.latestRun.id] : null
  const at = live?.stepIndex ?? t.latestRun?.currentStep
  if (st === 'failed' && at === i) return '❌'
  if ((st === 'running' || st === 'waiting_confirmation') && at === i) return '⏳'
  if (st === 'paused' && at === i) return '⏸'
  if (st === 'queued') return '·'
  return '·'
}
function stepInputBrief(s: any): string {
  const p = s.input || {}
  if (s.type === 'navigate') return String(p.url || '').slice(0, 48)
  if (s.type === 'fillDraft') return `${p.selector || ''} · ${String(p.text || '').length} 字符`
  if (p.selector) return String(p.selector) + (p.metric ? ` → ${p.metric}` : '')
  if (p.message) return String(p.message).slice(0, 48)
  if (p.urlIncludes) return String(p.urlIncludes)
  return ''
}
function stepResultBrief(t: any, i: number): string {
  const r = resultOf(t, i)
  return r ? String(r.summary || r.kind).slice(0, 60) : ''
}

async function toggleTaskDetail(t: any) {
  if (detailTaskId.value === t.id) { detailTaskId.value = null; return }
  detailTaskId.value = t.id
  await loadTaskDetail(t)
}
async function loadTaskDetail(t: any) {
  if (!t.latestRun?.id) { delete detailData[t.id]; return }
  const res = await window.shopilot.task.results(t.latestRun.id)
  if (res.ok) detailData[t.id] = res.data
  else delete detailData[t.id]
}

async function delTask(id: string) {
  if (!window.confirm('删除该任务？其运行记录与结果引用将一并级联删除。')) return
  await window.shopilot.task.delete(id)
  if (detailTaskId.value === id) detailTaskId.value = null
  ws.refreshTasks()
}

async function runOp(t: any, action: 'pause' | 'resume' | 'retry' | 'cancel') {
  const rid = t.latestRun?.id
  if (!rid) return
  const api = window.shopilot.task
  let res: any
  if (action === 'pause') res = await api.pause(rid)
  else if (action === 'resume') res = await api.resume(rid)
  else if (action === 'retry') res = await api.resume(rid, 'retry')
  else res = await api.cancel(rid)
  if (!res.ok) ws.toast('操作失败: ' + res.error.message, 'error')
  setTimeout(() => ws.refreshTasks(), 400)
}

async function confirmRun(runId: string, approved: boolean) {
  const res = await window.shopilot.task.confirm(runId, approved)
  if (!res.ok) ws.toast('确认失败: ' + res.error.message, 'error')
  ws.clearConfirmation(runId)
  setTimeout(() => ws.refreshTasks(), 400)
}

async function onCapture() {
  if (!ws.activeTab || !ws.displayedStoreId) return
  const res = await window.shopilot.browser.capture(ws.displayedStoreId, ws.activeTab.id, 'png')
  if (res.ok) {
    const a = document.createElement('a')
    a.href = 'data:image/png;base64,' + res.data.data
    a.download = `capture-${Date.now()}.png`
    a.click()
    ws.toast('已截图并保存', 'success')
  } else ws.toast('截图失败: ' + res.error.message, 'error')
}

/**
 * 右侧栏收起/展开（用户要求"右侧边栏可以收起"）。
 * 收起后留 44px 窄轨：图标=各面板，点一下即展开并回到该面板；状态写入 app_settings 持久化。
 * 两条不变量：① 有待处理的人工确认时**不允许收起**（否则门禁提示被藏起来，任务看起来又"卡住"）；
 * ② 收起状态下若来了新的确认请求，自动临时展开并提示（不改用户偏好）。
 */
const panelTabs = [
  { key: 'bookmarks', label: '收藏', icon: '★' },
  { key: 'downloads', label: '下载', icon: '↓' },
  { key: 'env', label: '环境', icon: '⚙' },
  { key: 'tasks', label: '任务', icon: '☑' }
] as Array<{ key: 'bookmarks' | 'downloads' | 'env' | 'tasks'; label: string; icon: string }>

const rightPanelCollapsed = ref(false)
// 注意：ws.confirmations 是 Record<runId, item>（对象），不是数组 —— 用 .length 会恒为 undefined，
// 导致"待确认时禁止收起"与"来新确认自动展开"两条守卫静默失效（M3 断言当场抓到）。
const confirmationCount = computed(() => Object.keys(ws.confirmations || {}).length)

/** 中栏宽度变了 → 立刻上报原生视图 bounds（ResizeObserver 之外再兜一次，避免慢一帧） */
function syncViewportSoon() {
  nextTick(() => {
    reportViewport()
    requestAnimationFrame(reportViewport)
    setTimeout(reportViewport, 80)
    setTimeout(reportViewport, 250)
  })
}

function collapsePanel() {
  if (confirmationCount.value > 0) {
    ws.toast('有待处理的人工确认，处理后才能收起右侧栏', 'info')
    return
  }
  rightPanelCollapsed.value = true
  window.shopilot.settings.set('ui.rightPanelCollapsed', true).catch(() => {})
  syncViewportSoon()
}

function expandPanel(p?: 'bookmarks' | 'downloads' | 'env' | 'tasks') {
  rightPanelCollapsed.value = false
  if (p) switchPanel(p)
  window.shopilot.settings.set('ui.rightPanelCollapsed', false).catch(() => {})
  syncViewportSoon()
}

function togglePanel() {
  if (rightPanelCollapsed.value) expandPanel()
  else collapsePanel()
}

/**
 * 左栏收起/展开（用户要求"左侧边栏可以收起和展开"），与右栏同一套约定：
 * 收起留 44px 窄轨（新建/回收站/更新仍可达），状态写入 app_settings 持久化，Ctrl+Shift+E 切换。
 * 与右栏不同：左栏不设门禁——人工确认门禁提示在右栏，收起左栏不会藏住它。
 */
const leftSidebarCollapsed = ref(false)

function collapseSidebar() {
  leftSidebarCollapsed.value = true
  window.shopilot.settings.set('ui.leftSidebarCollapsed', true).catch(() => {})
  syncViewportSoon()
}

function expandSidebar() {
  leftSidebarCollapsed.value = false
  window.shopilot.settings.set('ui.leftSidebarCollapsed', false).catch(() => {})
  syncViewportSoon()
}

function toggleSidebar() {
  if (leftSidebarCollapsed.value) expandSidebar()
  else collapseSidebar()
}

watch(confirmationCount, (n) => {
  if (n > 0 && rightPanelCollapsed.value) {
    rightPanelCollapsed.value = false
    ws.toast('任务需要人工确认，已临时展开右侧栏', 'info')
    syncViewportSoon()
  }
})

function switchPanel(p: 'bookmarks' | 'downloads' | 'env' | 'tasks') {
  ws.rightPanel = p
  if (p === 'downloads') ws.refreshDownloads()
  else if (p === 'env') { refreshEnv(); refreshCookies() }
  else if (p === 'tasks') ws.refreshTasks()
  else { ws.refreshBookmarks(); refreshEntryRoutes() }
}

/**
 * 平台入口（§16）：按当前店铺的平台取内置适配器入口，只读展示不入库。
 * 目前平台为国内四家（拼多多/微信小店/快手小店/抖店），非内置平台返回空列表 → 不显示该段。
 */
const entryRoutes = ref<any[]>([])
const displayedPlatformName = computed(() => ws.stores.find(s => s.id === ws.displayedStoreId)?.platform || '')

async function refreshEntryRoutes() {
  const sid = ws.displayedStoreId
  if (!sid) { entryRoutes.value = []; return }
  const res = await window.shopilot.bookmark.entryRoutes(sid)
  entryRoutes.value = res && res.ok ? (res.data.routes || []) : []
}

/**
 * 店铺右键菜单：使用应用内菜单，并纳入弹层遮挡处理（店铺页面是原生层，会盖住 HTML 菜单）。
 */
const ctx = reactive({ open: false, x: 0, y: 0, store: null as StoreRow | null })
const otherStores = computed(() => ws.stores.filter(s => s.id !== ctx.store?.id))
const ctxStandalone = computed(() =>
  !!ctx.store && isOpen(ctx.store.id) && ws.displayedStoreId === ctx.store.id && !!ws.activeTab
)

function onStoreContext(s: StoreRow, ev?: MouseEvent) {
  ctx.store = s
  // 菜单尺寸按内容估算后夹在窗口内，避免靠边右键时菜单跑出屏幕
  const w = 250, h = 300
  const x = ev ? ev.clientX : 60
  const y = ev ? ev.clientY : 60
  ctx.x = Math.max(8, Math.min(x, window.innerWidth - w - 8))
  ctx.y = Math.max(8, Math.min(y, window.innerHeight - h - 8))
  ctx.open = true
}

function closeCtx() { ctx.open = false }
function onDocMouseDown(ev: MouseEvent) {
  if (!ctx.open) return
  const el = ev.target as HTMLElement | null
  if (el && el.closest && el.closest('[data-test="store-ctx"]')) return
  closeCtx()
}
function onDocKey(ev: KeyboardEvent) {
  if (ev.key === 'Escape') closeCtx()
  // Ctrl+Shift+B：收起/展开右侧栏（与 Ctrl+Shift+L 锁定同一套快捷键约定）
  if (ev.ctrlKey && ev.shiftKey && (ev.key === 'B' || ev.key === 'b')) { ev.preventDefault(); togglePanel() }
  // Ctrl+Shift+E：收起/展开左侧栏
  if (ev.ctrlKey && ev.shiftKey && (ev.key === 'E' || ev.key === 'e')) { ev.preventDefault(); toggleSidebar() }
}

const rename = reactive({ open: false, value: '' })
const copycfg = reactive({ open: false, sourceId: '', sourceName: '', targets: [] as string[] })
const confirmBox = reactive({ open: false, title: '', message: '', onOk: null as null | (() => void | Promise<void>) })

async function ctxAction(kind: 'toggle' | 'standalone' | 'rename' | 'copycfg' | 'copyid' | 'trash') {
  const s = ctx.store
  if (!s) return
  closeCtx()
  if (kind === 'toggle') { await toggleStore(s.id); return }
  if (kind === 'standalone') {
    const tab = ws.activeTab
    if (!tab) { ws.toast('没有可打开的标签页', 'info'); return }
    const res = await window.shopilot.browser.openWindow(s.id, tab.id)
    ws.toast(res.ok ? '已在独立窗口打开' : '打开失败: ' + res.error.message, res.ok ? 'success' : 'error')
    return
  }
  if (kind === 'rename') { rename.value = s.name; rename.open = true; return }
  if (kind === 'copycfg') { copycfg.sourceId = s.id; copycfg.sourceName = s.name; copycfg.targets = []; copycfg.open = true; return }
  if (kind === 'copyid') {
    try {
      await navigator.clipboard.writeText(s.id)
      ws.toast('已复制店铺 ID', 'success')
    } catch {
      ws.toast('复制失败：' + s.id, 'info')
    }
    return
  }
  if (kind === 'trash') {
    confirmBox.title = '移入回收站'
    confirmBox.message = `「${s.name}」将移入回收站，会话与环境配置保留，可在回收站恢复或彻底删除。`
    confirmBox.onOk = async () => { await ws.moveToTrash(s.id) }
    confirmBox.open = true
  }
}

async function runConfirm() {
  const fn = confirmBox.onOk
  confirmBox.open = false
  confirmBox.onOk = null
  if (fn) await fn()
}

async function doRename() {
  const s = ctx.store
  const name = rename.value.trim()
  if (!s || !name) return
  const res = await window.shopilot.store.update({ storeId: s.id, patch: { name } })
  if (res.ok) { rename.open = false; await ws.refreshStores(); ws.toast('已重命名', 'success') }
  else ws.toast('重命名失败: ' + res.error.message, 'error')
}

async function doCopyConfig() {
  const src = copycfg.sourceId
  const targets = [...copycfg.targets]
  if (!src || targets.length === 0) return
  const res = await window.shopilot.profile.copyConfig(src, targets)
  if (res.ok) {
    copycfg.open = false
    await ws.refreshStores()
    const copied = res.data?.copied ?? 0
    const skipped = res.data?.skipped || []
    // 如实回报：跳过（环境已锁定/店铺不存在）绝不写成"成功"
    if (skipped.length) {
      const why = skipped.map((s: any) => s.reason === 'PROFILE_LOCKED' ? '环境已锁定' : '店铺不存在').join('、')
      ws.toast(`已复制 ${copied} 个，跳过 ${skipped.length} 个（${why}）`, copied ? 'info' : 'error')
    } else {
      ws.toast(`已复制环境配置到 ${copied} 个店铺（不含会话与代理凭据）`, 'success')
    }
  } else ws.toast('复制配置失败: ' + res.error.message, 'error')
}

/**
 * 数据中心：汇总所有店铺的数据（只读）。
 * 数据全部来自本机：stores / store_snapshots（任务指标快照）/ task_runs（任务与邀约运行）。
 * 没有数据就如实显示空状态，不做任何估算补数。
 */
const dataCenterOpen = ref(false)
const dcLoading = ref(false)
const dcCollecting = ref(false)

/** 经营指标矩阵：按店铺汇总五个指标的最新快照值（值从 store_snapshots 的 biz.* 指标名来），
 *  并带上"上一次采集值"用于显示增减 */
const bizRows = computed(() => {
  const byStore = new Map<string, { storeId: string; storeName: string; platform: string; values: Record<string, unknown>; prevs: Record<string, unknown>; manual: Record<string, boolean>; lastAt: number }>()
  for (const s of ws.stores) {
    byStore.set(s.id, { storeId: s.id, storeName: s.name, platform: s.platform, values: {}, prevs: {}, manual: {}, lastAt: 0 })
  }
  for (const snap of dc.snapshots as any[]) {
    if (!String(snap.metric || '').startsWith('biz.')) continue
    const hit = [...byStore.values()].find(r => r.storeName === snap.storeName)
    if (!hit) continue
    hit.values[snap.metric] = snap.value
    if (snap.manual) hit.manual[snap.metric] = true
    if (snap.prevValue != null) hit.prevs[snap.metric] = snap.prevValue
    if (snap.capturedAt > hit.lastAt) hit.lastAt = snap.capturedAt
  }
  return [...byStore.values()]
})

/** 手动录入草稿（平台反抓取导致无法自动读取时使用；来源会如实标注"手动"） */
const manualDraft = reactive({ storeId: '', metric: 'biz.orders' as string, value: null as number | null })
const manualReady = computed(() =>
  !!manualDraft.storeId && !!manualDraft.metric &&
  manualDraft.value != null && Number.isFinite(Number(manualDraft.value)) && Number(manualDraft.value) >= 0
)

async function saveManualMetric() {
  if (!manualReady.value) return
  const res = await window.shopilot.overview.manualMetric(manualDraft.storeId, manualDraft.metric, Number(manualDraft.value))
  if (!res.ok) { ws.toast('录入失败: ' + res.error.message, 'error'); return }
  ws.toast('已录入（来源：手动）', 'success')
  manualDraft.value = null
  await loadDataCenter()
}

/** 合计行：只对**已采集到的数值**求和，并如实标注参与合计的店铺数（不做任何估算补齐） */
const bizTotals = computed(() => {
  const sums: Record<string, number> = {}
  let contributors = 0
  for (const r of bizRows.value) {
    let has = false
    for (const m of BIZ_METRICS) {
      const v = r.values[m.key]
      if (typeof v === 'number' && Number.isFinite(v)) { sums[m.key] = (sums[m.key] || 0) + v; has = true }
    }
    if (has) contributors++
  }
  return { sums, contributors }
})

/** 经营指标单元格显示：金额类补 ¥ 与千分位；没有值如实显示"—"（未采集） */
function bizValue(key: string, v: unknown): string {
  if (v == null || v === '') return '—'
  const money = key === 'biz.gmv' || key === 'biz.refundAmount'
  if (typeof v === 'number' && Number.isFinite(v)) {
    const s = v.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
    return money ? '¥' + s : s
  }
  return String(v)
}

/** 与上一次采集相比的增减（delta 文本 + 方向），供界面显示 ▲/▼ */
function bizDelta(key: string, v: unknown, prev: unknown): { text: string; dir: 'up' | 'down' | 'flat' } | null {
  if (typeof v !== 'number' || typeof prev !== 'number') return null
  const d = v - prev
  if (!Number.isFinite(d) || d === 0) return { text: '持平', dir: 'flat' }
  const money = key === 'biz.gmv' || key === 'biz.refundAmount'
  const abs = Math.abs(d).toLocaleString('zh-CN', { maximumFractionDigits: 2 })
  return { text: (d > 0 ? '+' : '-') + (money ? '¥' : '') + abs, dir: d > 0 ? 'up' : 'down' }
}
const dc = reactive<any>({
  generatedAt: 0,
  totals: { stores: 0, online: 0, archived: 0, trash: 0, platforms: 0, snapshots: 0, tasks: 0 },
  byPlatform: [] as any[],
  snapshots: [] as any[],
  invite: { byStatus: [] as any[], recent: [] as any[] },
  runs: { byStatus: [] as any[], recentIssues: [] as any[] }
})

function openDataCenter() {
  dataCenterOpen.value = true
  // 手动录入默认选中"当前显示的店铺"，减少一步选择
  if (!manualDraft.storeId) manualDraft.storeId = ws.displayedStoreId || ws.stores[0]?.id || ''
  void loadDataCenter()
}

async function loadDataCenter() {
  dcLoading.value = true
  try {
    const res = await window.shopilot.overview.datacenter()
    if (res.ok) {
      Object.assign(dc, res.data)
    } else {
      ws.toast('数据中心加载失败: ' + res.error.message, 'error')
    }
  } finally {
    dcLoading.value = false
  }
}

/** 经营指标口径说明（来自各平台实测档案的 note）：界面如实展示，避免"数字没有口径" */
const bizNotes = computed(() => {
  const plats = new Set(ws.stores.map(s => s.platform))
  return [...plats]
    .map(p => businessProfileFor(p))
    .filter((p): p is NonNullable<typeof p> => !!p && !!p.note)
    .map(p => `${p.platform}（实测 ${p.measuredAt}）：${p.note}`)
})
/**
 * 采集经营数据：为每个「平台已实测」的店铺各创建一个只读采集任务并立即运行
 * （navigate 经营数据页 → 每个指标一条 readText，值落 store_snapshots）。
 * 未实测平台不猜锚点，如实跳过并说明；需要店铺浏览器已打开（引擎不静默拉起，§4.4）。
 */
async function collectBusinessData() {
  const supported = ws.stores.filter(s => !!businessProfileFor(s.platform))
  if (!supported.length) {
    ws.toast('还没有已实测经营指标锚点的平台——需要先在真实登录态后台实测页面锚点（不猜选择器）', 'error')
    return
  }
  dcCollecting.value = true
  let created = 0
  const runIds: string[] = []
  const skipped: string[] = []
  try {
    for (const s of supported) {
      const profile = businessProfileFor(s.platform)!
      const steps = buildBusinessCollectSteps(profile)
      const res = await window.shopilot.task.create({
        name: `经营数据采集 · ${s.platform} · ${new Date().toLocaleDateString()}`,
        storeScope: s.id,
        steps
      })
      if (!res.ok) { skipped.push(`${s.name}（创建失败）`); continue }
      const run = await window.shopilot.task.run(res.data.id)
      if (!run.ok) { skipped.push(`${s.name}（启动失败）`); continue }
      if (run.data?.runId) runIds.push(run.data.runId)
      created++
    }
    await ws.refreshTasks()
    const notOpen = supported.filter(s => !ws.openStoreIds.includes(s.id)).length
    ws.toast(
      `已启动 ${created} 个采集任务` +
      (notOpen ? `（其中 ${notOpen} 家店铺浏览器未打开，会排队等待，不静默拉起）` : '') +
      (skipped.length ? `；跳过：${skipped.join('、')}` : ''),
      created ? 'success' : 'error'
    )
    // 采集要跑十几秒到一分钟：等运行结束后再刷新数据中心的数字，避免界面停在旧值上。
    // 任务列表已移除——这里**逐店如实汇报结果**（含失败原因），失败不被埋在看不见的运行记录里。
    if (runIds.length) {
      const deadline = Date.now() + 180000
      let last: any[] = []
      for (;;) {
        await new Promise(r => setTimeout(r, 3000))
        const list = await window.shopilot.task.list()
        const all = list.ok ? (list.data.tasks || list.data) : []
        last = all.filter((x: any) => x.latestRun && runIds.includes(x.latestRun.id))
        const done = runIds.every(id => {
          const t = all.find((x: any) => x.latestRun?.id === id)
          const st = t?.latestRun?.status
          return st && ['succeeded', 'failed', 'cancelled'].includes(st)
        })
        if (done || Date.now() > deadline) break
      }
      const parts = last.map((t: any) => {
        const st = t.latestRun?.status
        const name = String(t.name || '').split(' · ')[1] || t.name
        if (st === 'succeeded') return `${name} ✓`
        if (st === 'queued') return `${name}（排队等浏览器打开）`
        if (st === 'failed') return `${name} ✗ ${t.latestRun?.errorCode || '失败'}${t.latestRun?.errorMessage ? '：' + String(t.latestRun.errorMessage).slice(0, 60) : ''}`
        return `${name}（${st || '未知'}）`
      })
      if (parts.length) ws.toast('采集结果 —— ' + parts.join('｜'), last.every((t: any) => t.latestRun?.status === 'succeeded') ? 'success' : 'error')
      await ws.refreshTasks()
    }
    await loadDataCenter()
  } finally {
    dcCollecting.value = false
  }
}

/**
 * 弹层遮挡：店铺页面是原生 WebContentsView（永远画在 HTML 之上），
 * 弹层落在视口区域内会被整块盖住（实测回收站弹窗遮挡比例 100%）→ 遮挡期间摘除挂载。
 * 右键菜单通常落在左栏、不与视口相交，那种情况不摘除（避免每次右键中栏白闪）。
 */
const ctxOverlapViewport = ref(false)
let lastObscured = false
let overlaySyncChain: Promise<void> = Promise.resolve()
let overlayRevision = 0

function refreshOverlayOcclusion() {
  const revision = ++overlayRevision
  overlaySyncChain = overlaySyncChain.then(async () => {
    await nextTick()
    // A newer watch event has already scheduled a fresher DOM state.
    if (revision !== overlayRevision) return

    const modalOpen = !!(ws.createDialogOpen || ws.trashOpen || rename.open || copycfg.open || confirmBox.open || settingsOpen.value || dataCenterOpen.value)
    if (ctx.open && viewportEl.value) {
      const m = document.querySelector('[data-test="store-ctx"]')?.getBoundingClientRect()
      const v = viewportEl.value.getBoundingClientRect()
      ctxOverlapViewport.value = !!m && !(m.right <= v.left || m.left >= v.right || m.bottom <= v.top || m.top >= v.bottom)
    } else {
      ctxOverlapViewport.value = false
    }
    const shouldHide = modalOpen || ctxOverlapViewport.value
    if (shouldHide === lastObscured) return
    lastObscured = shouldHide
    await window.shopilot.browser.setViewsObscured(shouldHide)
  }).catch(() => {})
}

watch(
  () => [ws.createDialogOpen, ws.trashOpen, ctx.open, rename.open, copycfg.open, confirmBox.open, settingsOpen.value, dataCenterOpen.value],
  () => { refreshOverlayOcclusion() },
  { immediate: true }
)

async function openTrash() {
  await ws.refreshTrash()
  ws.trashOpen = true
}

async function confirmPurge(s: StoreRow) {
  if (window.confirm(`彻底删除「${s.name}」？此操作不可撤销，将清除其环境、下载记录与缓存。`)) {
    await ws.purgeStore(s.id)
  }
}

function quickCreate(p: { name: string }) { openCreateDialog(p.name) }

/** 打开"新建店铺"对话框：带上所选平台的默认后台地址（避免默认平台却给空地址，用户还得自己粘） */
function openCreateDialog(platformName?: string) {
  const name = platformName || DEFAULT_PLATFORM
  form.platform = name
  form.adminUrl = ''
  form.name = ''
  applyPlatformDefaults(name)
  ws.createDialogOpen = true
}

async function submitCreate() {
  const name = form.name.trim()
  const adminUrl = form.adminUrl.trim()
  if (!name || !adminUrl) {
    ws.toast('请填写店铺名称和后台地址', 'info')
    return
  }
  const tags = form.tags.split(',').map(t => t.trim()).filter(Boolean)
  const res = await ws.createStore({ name, platform: form.platform, adminUrl, tags, notes: form.notes.trim() })
  if (res && res.ok) {
    Object.assign(form, { name: '', platform: DEFAULT_PLATFORM, adminUrl: '', tags: '', notes: '' })
  }
}

function showInFolder(id: string) { window.shopilot.download.showInFolder(id) }

onMounted(async () => {
  updateEventHandler = (payload: any) => applyUpdateStatus(payload)
  window.shopilot.on('update:statusChanged', updateEventHandler)
  window.shopilot.on('update:progress', updateEventHandler)
  // 采集任务可能在数据中心的等待窗口之后才跑完（例如运行排队等店铺浏览器打开）：
  // 任何运行结束都刷新一次已打开的数据中心，避免表格停在旧数字上
  window.shopilot.on('task:progress', (ev: any) => {
    if (!dataCenterOpen.value) return
    if (ev?.phase === 'finished' || ev?.phase === 'failed') void loadDataCenter()
  })
  await ws.init()
  // Renderer reloads do not reset main-process WebContentsView state. Explicitly
  // clear a stale overlay flag before the first viewport report; app-lock state
  // remains authoritative in the main process and still prevents mounting.
  lastObscured = true
  refreshOverlayOcclusion()
  if (ws.rightPanel === 'bookmarks') refreshEntryRoutes()
  // 恢复「设置 → 配置」里的平台首页地址（影响首页按钮与新建店铺的默认后台地址）
  await loadPlatformHomeUrls()
  // 达人广场地址覆盖表（邀约面板与设置都用它）
  await loadSquareUrls()
  // AI 配置（只回 hasKey，Key 本身永不回渲染层）：邀约面板的"AI 生成"要据此判断能不能开始
  await loadAiConfig()
  // 恢复上次的右栏收起状态
  const saved = await window.shopilot.settings.get('ui.rightPanelCollapsed')
  if (saved?.ok && saved.data?.value === true) { rightPanelCollapsed.value = true }
  // 恢复上次的左栏收起状态
  const savedLeft = await window.shopilot.settings.get('ui.leftSidebarCollapsed')
  if (savedLeft?.ok && savedLeft.data?.value === true) { leftSidebarCollapsed.value = true }
  await nextTick()
  if (viewportEl.value) {
    resizeObserver = new ResizeObserver(() => reportViewport())
    resizeObserver.observe(viewportEl.value)
  }
  window.addEventListener('resize', reportViewport)
  window.addEventListener('mousedown', onDocMouseDown, true)
  window.addEventListener('keydown', onDocKey)
  reportViewport()
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  window.removeEventListener('resize', reportViewport)
  window.removeEventListener('mousedown', onDocMouseDown, true)
  window.removeEventListener('keydown', onDocKey)
  if (updateEventHandler) {
    window.shopilot.off('update:statusChanged', updateEventHandler)
    window.shopilot.off('update:progress', updateEventHandler)
  }
})
</script>

<style scoped>
.workbench { display: flex; width: 100vw; height: 100vh; overflow: hidden; }

/* 左栏 */
.sidebar {
  width: 304px; min-width: 304px; height: 100%;
  background: var(--color-bg-secondary);
  border-right: 1px solid var(--color-border);
  display: flex; flex-direction: column;
}
.brand { display: flex; align-items: center; gap: 10px; padding: 16px; -webkit-app-region: drag; }
.brand-logo {
  width: 30px; height: 30px; border-radius: 8px;
  background: linear-gradient(135deg, #3b82f6, #8b5cf6);
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 16px;
}
.brand-name { font-weight: 600; font-size: 15px; }
/* 更新入口已搬进「设置 → 关于软件」，品牌行只留 logo/名称/收起按钮；
   margin-left:auto 从原 .brand-update 挪到这里，收起按钮才会留在右端 */
.sidebar-collapse {
  margin-left: auto;
  width: 26px; height: 26px; flex: 0 0 auto; border: 0; background: none;
  border-radius: 6px; font-size: 15px; line-height: 1; color: var(--color-text-secondary);
  -webkit-app-region: no-drag;
}
.sidebar-collapse:hover { background: var(--color-bg-tertiary); color: #fff; }

/* 左栏收起态：留一条窄轨（新建/回收站/更新仍可达；顶部留拖拽区，按钮自身 no-drag） */
.sidebar.collapsed { width: 44px; min-width: 44px; }
.sidebar-rail {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 16px 0 8px; height: 100%; -webkit-app-region: drag;
}
.sidebar-rail .rail-btn { -webkit-app-region: no-drag; }

.sidebar-tools { display: flex; gap: 8px; padding: 0 16px 10px; }
.search-box {
  flex: 1; display: flex; align-items: center; gap: 6px;
  background: var(--color-bg-tertiary); border: 1px solid var(--color-border);
  border-radius: var(--radius-sm); padding: 0 10px; height: 32px;
}
.search-box input { flex: 1; background: none; border: none; outline: none; color: var(--color-text-primary); font-size: 13px; }
.search-ico { opacity: .6; font-size: 12px; }
.btn-new {
  width: 32px; height: 32px; border-radius: var(--radius-sm);
  background: var(--color-primary); color: #fff; font-size: 18px; line-height: 1;
  display: flex; align-items: center; justify-content: center;
}
.btn-new:hover { filter: brightness(1.1); }

.filter-chips { display: flex; gap: 6px; padding: 0 16px 10px; }
.filter-platform {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 0 16px 10px;
}
.fp-header { display: flex; align-items: center; gap: 6px; width: 100%; margin-bottom: 2px; }
.fp-label { font-size: 11px; color: var(--color-text-muted); flex-shrink: 0; }
.fp-clear {
  font-size: 10px; color: var(--color-primary); background: none; border: 0; cursor: pointer; padding: 0; line-height: 1; text-decoration: underline;
}
.fp-chip {
  display: flex; align-items: center; gap: 4px;
  font-size: 11px; padding: 2px 8px; border-radius: 20px;
  background: var(--color-bg-tertiary); color: var(--color-text-secondary); border: 1px solid var(--color-border);
  cursor: pointer; height: 24px; transition: background .15s, border-color .15s, color .15s;
}
.fp-chip:hover:not(.on) { border-color: var(--color-text-secondary); }
.fp-chip.on { color: #fff; }
.fp-count {
  font-size: 10px; opacity: .7; background: rgba(255,255,255,.2); border-radius: 8px;
  padding: 0 5px; line-height: 14px; min-width: 14px; text-align: center;
}
.fp-chip:not(.on) .fp-count { background: var(--color-border); color: var(--color-text-muted); }
.fp-other-icon { font-size: 12px; }

.store-list { flex: 1; overflow-y: auto; padding: 4px 10px; }
.store-group { margin-bottom: 8px; }
.group-title { font-size: 11px; color: var(--color-text-muted); padding: 8px 6px 4px; text-transform: uppercase; letter-spacing: .04em; }

.store-card {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  border-radius: var(--radius-sm); cursor: pointer; border: 1px solid transparent;
}
.store-card:hover { background: var(--color-bg-tertiary); }
.store-card.active { background: var(--color-bg-tertiary); }
.store-card.displayed { border-color: var(--color-primary); }
.avatar {
  width: 34px; height: 34px; border-radius: 8px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-weight: 600; font-size: 15px; color: #fff;
}
.avatar.sm { width: 28px; height: 28px; font-size: 13px; border-radius: 6px; }
.store-meta { flex: 1; min-width: 0; }
.store-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.store-sub { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--color-text-secondary); }
.dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.store-action { width: 26px; height: 26px; border-radius: 6px; color: var(--color-text-secondary); font-size: 13px; opacity: 0; }
.store-card:hover .store-action { opacity: 1; }
.store-action:hover { background: var(--color-bg-elevated); color: var(--color-primary); }

.empty-hint { color: var(--color-text-muted); font-size: 13px; text-align: center; padding: 30px 10px; line-height: 1.8; }
.field-note { display: block; font-size: 11px; color: var(--color-text-secondary); margin-top: 4px; }
.link { color: var(--color-primary); text-decoration: underline; }
/* 右栏收起态：只留一条窄轨（图标=面板；徽标=有待人工确认） */
.right-panel.collapsed { width: 44px; min-width: 44px; }
/* 顶部 46px 避让：右上角原生窗口按钮（WCO 高 38px）压在窄轨上方 */
.panel-rail { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 46px 0 8px; height: 100%; }
.rail-btn {
  position: relative; width: 30px; height: 30px; border: 0; background: none; cursor: pointer;
  border-radius: 6px; font-size: 14px; color: var(--color-text-secondary); line-height: 1;
}
.rail-btn:hover { background: var(--color-bg-tertiary); color: #fff; }
.rail-btn.on { background: var(--color-bg-tertiary); color: #fff; }
.rail-badge { position: absolute; top: 2px; right: 2px; width: 8px; height: 8px; border-radius: 50%; background: var(--color-warning); }
.panel-collapse {
  flex: 0 0 30px; border: 0; background: none; cursor: pointer;
  font-size: 15px; color: var(--color-text-secondary);
  -webkit-app-region: no-drag;
}
.panel-collapse:hover { background: var(--color-bg-tertiary); color: #fff; }

.sidebar-footer { display: flex; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--color-border); }
.foot-btn {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
  height: 32px; border-radius: var(--radius-sm); font-size: 12px;
  background: var(--color-bg-tertiary); color: var(--color-text-secondary);
}
.foot-btn:hover:not(:disabled) { color: var(--color-text-primary); }
.foot-btn:disabled { opacity: .4; cursor: not-allowed; }
.badge { background: var(--color-error); color: #fff; border-radius: 10px; padding: 0 6px; font-size: 10px; }

/* 中栏 */
.browser-col { flex: 1; display: flex; flex-direction: column; background: var(--color-bg-primary); min-width: 0; }
.tab-strip { display: flex; align-items: center; height: 38px; background: var(--color-bg-secondary); padding: 0 8px; gap: 4px; -webkit-app-region: drag; }
/* §17 顶部融合（titleBarStyle:'hidden'）：标签栏即标题栏拖拽区，可交互元素排除；
   右栏收起时右上角原生窗口按钮（WCO ≈140×38）会压住标签栏右端，避让 140-44(窄轨)+8 = 104px */
.tab, .tab-close, .tab-add { -webkit-app-region: no-drag; }
.tab-strip.wco-avoid { padding-right: 104px; }
.tabs { display: flex; gap: 4px; overflow-x: auto; flex: 1; height: 100%; align-items: center; }
.tab {
  display: flex; align-items: center; gap: 6px; max-width: 220px; min-width: 120px;
  height: 28px; padding: 0 8px 0 10px; border-radius: 8px;
  background: var(--color-bg-tertiary); font-size: 12px; cursor: pointer;
}
.tab.active { background: var(--color-bg-primary); box-shadow: inset 0 0 0 1px var(--color-border); }
.tab.pinned { min-width: 40px; }
.tab-title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tab-close { width: 16px; height: 16px; border-radius: 4px; color: var(--color-text-secondary); line-height: 1; font-size: 14px; }
.tab-close:hover { background: rgba(255,255,255,.12); color: #fff; }
.tab-spinner { width: 11px; height: 11px; border: 2px solid var(--color-border); border-top-color: var(--color-primary); border-radius: 50%; animation: spin .7s linear infinite; flex-shrink: 0; }
@keyframes spin { to { transform: rotate(360deg); } }
.tab-add { width: 26px; height: 26px; border-radius: 6px; font-size: 17px; color: var(--color-text-secondary); }
.tab-add:hover { background: var(--color-bg-tertiary); color: #fff; }

.address-bar { display: flex; align-items: center; gap: 4px; height: 44px; padding: 0 8px; background: var(--color-bg-primary); border-bottom: 1px solid var(--color-border); }
.nav-btn { width: 30px; height: 30px; border-radius: 6px; color: var(--color-text-secondary); font-size: 16px; display: flex; align-items: center; justify-content: center; }
.nav-btn:hover { background: var(--color-bg-tertiary); color: #fff; }
.nav-btn:disabled { opacity: .35; cursor: default; }
.nav-btn:disabled:hover { background: none; color: var(--color-text-secondary); }
.url-box { flex: 1; height: 30px; background: var(--color-bg-tertiary); border: 1px solid var(--color-border); border-radius: 15px; padding: 0 14px; display: flex; align-items: center; }
.url-box input { width: 100%; background: none; border: none; outline: none; color: var(--color-text-primary); font-size: 13px; }
.viewport { flex: 1; position: relative; background: #fff; }

/* 欢迎页 */
/* §17 顶部融合：欢迎页空白区也可拖动窗口（右上角是原生窗口按钮 overlay） */
.welcome { flex: 1; display: flex; align-items: center; justify-content: center; -webkit-app-region: drag; }
.welcome-inner { text-align: center; max-width: 520px; -webkit-app-region: no-drag; }
.welcome-logo { width: 64px; height: 64px; border-radius: 16px; margin: 0 auto 18px; background: linear-gradient(135deg,#3b82f6,#8b5cf6); display: flex; align-items: center; justify-content: center; font-size: 32px; font-weight: 700; }
.welcome h1 { font-size: 24px; margin-bottom: 8px; }
.welcome-desc { color: var(--color-text-secondary); margin-bottom: 24px; }
.quick-platforms { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; }
.qp { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 20px; background: var(--color-bg-secondary); border: 1px solid var(--color-border); font-size: 13px; }
.qp:hover { border-color: var(--color-primary); }
.qp-dot { width: 10px; height: 10px; border-radius: 50%; }

/* 右栏 */
.right-panel { width: 320px; min-width: 320px; height: 100%; background: var(--color-bg-secondary); border-left: 1px solid var(--color-border); display: flex; flex-direction: column; }
/* §17 顶部融合：面板顶行也是标题栏拖拽区；右侧 140px 留给原生窗口按钮（WCO） */
.panel-tabs { display: flex; height: 40px; border-bottom: 1px solid var(--color-border); padding-right: 140px; -webkit-app-region: drag; }
.ptab { flex: 1; font-size: 13px; color: var(--color-text-secondary); border-bottom: 2px solid transparent; -webkit-app-region: no-drag; }
.ptab.on { color: #fff; border-bottom-color: var(--color-primary); }
.panel-body { flex: 1; overflow-y: auto; padding: 8px; }
.row-item { position: relative; padding: 8px 30px 8px 10px; border-radius: var(--radius-sm); cursor: pointer; }
.row-item:hover { background: var(--color-bg-tertiary); }
.row-main { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row-sub { font-size: 11px; color: var(--color-text-secondary); }
/* 行内小按钮（删除/打开目录）。原实现把"绝对定位 + opacity:0 悬停显示"写在 .row-del 基类上，
   导致 .proxy-item / .tc-head / .tstep 里的删除按钮既不可见、又相对 .modal-mask 跑到窗口右上角。
   现在：基类=可见的静态小按钮；仅 .row-item（列表行）保留悬停显示。 */
.row-del { width: 22px; height: 22px; flex: 0 0 auto; border: 0; background: none; border-radius: 4px; color: var(--color-text-muted); opacity: .65; cursor: pointer; }
.row-item .row-del { position: absolute; right: 8px; top: 10px; width: 20px; height: 20px; opacity: 0; }
.row-item:hover .row-del { opacity: 1; }
.row-del:hover { background: var(--color-bg-elevated); color: #fff; opacity: 1; }
.dl-state { font-weight: 500; }
.dl-state.completed { color: var(--color-success); }
.dl-state.in_progress { color: var(--color-primary); }
.dl-state.cancelled, .dl-state.interrupted { color: var(--color-error); }

/* 模态 */
.modal-mask {
  position: fixed; inset: 0; background: rgba(0,0,0,.55); display: flex;
  align-items: center; justify-content: center; z-index: 100;
  /* The window uses hidden title bars and app-region drag zones. A modal must
     explicitly opt out, otherwise mouse clicks are interpreted as window drag
     gestures and text fields never receive focus. */
  -webkit-app-region: no-drag;
}
.modal, .modal * { -webkit-app-region: no-drag; }
.modal { position: relative; z-index: 101; width: 420px; max-height: 80vh; overflow-y: auto; background: var(--color-bg-secondary); border: 1px solid var(--color-border); border-radius: var(--radius); padding: 22px; }
.modal h2 { font-size: 17px; margin-bottom: 16px; }
.modal label { display: block; font-size: 12px; color: var(--color-text-secondary); margin-bottom: 12px; }
.modal input, .modal select, .modal textarea {
  width: 100%; margin-top: 4px; padding: 8px 10px; border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary); border: 1px solid var(--color-border); color: #fff; font-size: 13px; outline: none;
}
.modal input:focus, .modal textarea:focus { border-color: var(--color-primary); }
.platform-pick { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
.platform-pick select { margin-top: 0; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }
.btn-primary { background: var(--color-primary); color: #fff; padding: 8px 18px; border-radius: var(--radius-sm); font-size: 13px; }
.btn-primary:disabled { opacity: .45; cursor: not-allowed; }
.btn-ghost { background: var(--color-bg-tertiary); color: var(--color-text-primary); padding: 8px 16px; border-radius: var(--radius-sm); font-size: 13px; }
.btn-danger { background: var(--color-error); color: #fff; padding: 8px 14px; border-radius: var(--radius-sm); font-size: 13px; }
.btn-ghost.sm, .btn-danger.sm { padding: 5px 10px; font-size: 12px; }

.trash-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--color-border); }
.trash-meta { flex: 1; font-size: 13px; }

/* Toast */
.toast-host { position: fixed; right: 20px; bottom: 20px; display: flex; flex-direction: column; gap: 8px; z-index: 200; }
.toast { padding: 10px 16px; border-radius: var(--radius-sm); font-size: 13px; background: var(--color-bg-elevated); border: 1px solid var(--color-border); box-shadow: 0 8px 24px rgba(0,0,0,.4); animation: slideIn .2s ease; }
.toast.success { border-color: var(--color-success); }
.toast.error { border-color: var(--color-error); }
@keyframes slideIn { from { transform: translateX(20px); opacity: 0; } to { transform: none; opacity: 1; } }

/* 环境面板 - §13 / §16 */
.env-body { display: flex; flex-direction: column; gap: 0; }
.env-sec { padding: 12px 14px; border-bottom: 1px solid var(--color-border); }
.env-h { font-size: 12px; font-weight: 600; color: var(--color-text-secondary); letter-spacing: .5px; margin-bottom: 10px; display: flex; align-items: center; }
.bind-row select { width: 100%; background: var(--color-bg-tertiary); color: var(--color-text-primary); border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 7px 9px; font-size: 13px; }
.env-note { font-size: 12px; color: var(--color-text-secondary); margin-top: 8px; line-height: 1.5; }
.env-note.ok { color: var(--color-success); }
.proxy-item { display: flex; align-items: center; gap: 8px; padding: 7px 0; }
.p-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.p-info { flex: 1; min-width: 0; }
.mini-btn { background: var(--color-bg-elevated); color: var(--color-text-primary); border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 4px 9px; font-size: 12px; cursor: pointer; flex-shrink: 0; }
.mini-btn:hover:not(:disabled) { border-color: var(--color-primary); }
.mini-btn:disabled { opacity: .5; cursor: default; }
.mini-btn.primary { background: var(--color-primary); border-color: var(--color-primary); color: #fff; }
.proxy-add { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.proxy-add input, .add-line select, .add-line input { background: var(--color-bg-tertiary); color: var(--color-text-primary); border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 6px 8px; font-size: 12px; width: 100%; box-sizing: border-box; }
.add-line { display: flex; gap: 6px; }
.add-line select { width: 74px; min-width: 74px; flex: 0 0 74px; }
.add-line .f-host { flex: 1 1 auto; min-width: 60px; width: auto; }
.add-line .f-port { width: 72px; min-width: 72px; flex: 0 0 72px; }
.verify-item { display: flex; align-items: center; gap: 8px; padding: 6px 0; }
.v-info { flex: 1; min-width: 0; }

/* 会话 / Cookie / 应用锁 / 备份诊断：只作用于这三段，
   不要写成 .env-sec input —— 会连带改掉"添加代理"那一行的下拉/主机宽度（实测把主机输入挤到 18px 并让右栏横向溢出） */
[data-test="session-sec"] input, [data-test="session-sec"] select,
[data-test="lock-sec"] input, [data-test="lock-sec"] select,
[data-test="diag-sec"] input, [data-test="diag-sec"] select {
  background: var(--color-bg-tertiary); color: var(--color-text-primary); border: 1px solid var(--color-border);
  border-radius: var(--radius-sm); padding: 6px 8px; font-size: 12px; width: 100%; box-sizing: border-box; margin-top: 6px;
}
[data-test="session-sec"] .mini-btn, [data-test="lock-sec"] .mini-btn, [data-test="diag-sec"] .mini-btn { margin-top: 6px; }
.env-sec .cf-btns .mini-btn { margin-top: 0; }
.ck-search { margin-top: 6px; }
.ck-item { padding: 5px 0; }
.ck-flag { font-size: 10px; color: var(--color-text-muted); border: 1px solid var(--color-border); border-radius: 4px; padding: 0 4px; margin-left: 5px; }
.danger-btn { color: #fca5a5; border-color: #7f1d1d; }
.danger-btn:hover { background: rgba(239, 68, 68, .15); }

/* 任务面板 - §4.4 / §6.6 */
.confirm-bar { background: rgba(245, 158, 11, .12); border-bottom: 1px solid var(--color-warning); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.cf-txt { font-size: 13px; color: var(--color-warning); }
.cf-btns { display: flex; gap: 8px; }
.tc-headsec { display: flex; align-items: center; justify-content: space-between; }
.task-card { padding: 10px 14px; }
.task-card.on { background: var(--color-bg-secondary); }
.tc-head { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.step-row { display: flex; align-items: flex-start; gap: 8px; padding: 5px 0 0 4px; }
.s-ico { width: 18px; text-align: center; flex-shrink: 0; font-size: 12px; }
.tc-btns { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.log-box { margin-top: 8px; background: var(--color-bg-primary); border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 6px 8px; max-height: 160px; overflow-y: auto; }
.log-line { font-size: 11px; color: var(--color-text-secondary); font-family: Consolas, monospace; line-height: 1.6; word-break: break-all; }
.modal-wide { width: 560px; max-width: 92vw; }
/* ---------- 数据中心入口（左栏底部：独立一行） ---------- */
.sidebar-dc { padding: 8px 12px 0; border-top: 1px solid var(--color-border); }
.dc-entry-row {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 8px 10px; border-radius: var(--radius-sm); font-size: 13px;
  color: var(--color-text-primary); background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
}
.dc-entry-row:hover { border-color: var(--color-primary); color: #fff; }
.dc-entry-row .dc-ico { font-size: 14px; }
.dc-entry-row .dc-txt { flex: 1 1 auto; text-align: left; }
/* 左栏收起为窄轨时：数据中心图标钉在窄轨底部（左下角） */
.sidebar-rail .dc-rail-btn { margin-top: auto; }
.dc-modal { width: 880px; max-width: 94vw; max-height: 84vh; }
.dc-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.dc-head .row-sub { flex: 1 1 auto; }
.dc-cards { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 6px; }
.dc-card {
  flex: 1 1 90px; min-width: 84px; padding: 10px 8px; text-align: center;
  background: var(--color-bg-tertiary); border: 1px solid var(--color-border); border-radius: var(--radius-sm);
}
.dc-num { font-size: 20px; font-weight: 600; color: #fff; }
.dc-label { font-size: 11px; color: var(--color-text-secondary); margin-top: 2px; }
.dc-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.dc-chip {
  font-size: 11px; padding: 3px 8px; border-radius: 10px;
  background: var(--color-bg-tertiary); border: 1px solid var(--color-border); color: var(--color-text-secondary);
}
.dc-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 10px; }
.dc-table th {
  text-align: left; padding: 5px 6px; color: var(--color-text-secondary);
  border-bottom: 1px solid var(--color-border); font-weight: 500;
}
.dc-table td { padding: 5px 6px; border-bottom: 1px solid rgba(255,255,255,.05); vertical-align: top; }
.dc-val { font-weight: 600; color: #fff; }
.dc-bad { color: #ff7875; }
.dc-total td { border-top: 1px solid var(--color-border); font-weight: 600; }
.dc-delta { margin-left: 4px; font-size: 10px; font-weight: 400; color: var(--color-text-secondary); }
.dc-delta.up { color: #4ade80; }
.dc-delta.down { color: #ff7875; }
.dc-manual {
  margin-left: 4px; font-size: 10px; font-weight: 400; padding: 1px 4px; border-radius: 6px;
  background: rgba(250, 173, 20, .16); color: #faad14; border: 1px solid rgba(250, 173, 20, .35);
}
.dc-manual-form {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  margin: 8px 0 6px; padding: 8px; border: 1px dashed var(--color-border); border-radius: var(--radius-sm);
}
.dc-manual-form select, .dc-manual-form input {
  background: var(--color-bg-tertiary); color: var(--color-text-primary);
  border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 4px 6px; font-size: 12px;
}
.update-modal { width: 390px; }
/* 设置弹窗 + 任务面板二级页签共用的页签条。刻意不复用 .panel-tabs：
   那是右栏一级页签，带 padding-right:140px 给原生窗口按钮避让，装在弹窗/面板里会右侧留白诡异 */
.sub-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--color-border); margin-bottom: 10px; }
.stab {
  padding: 6px 12px; font-size: 13px; color: var(--color-text-secondary);
  border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.stab:hover { color: var(--color-text-primary); }
.stab.on { color: #fff; border-bottom-color: var(--color-primary); }
.settings-modal { width: 520px; }
.sub-pane { display: flex; flex-direction: column; }
/* 达人邀约面板：全部按 [data-test="invite-panel"] 作用域限定，
   避免历史上"通用 .env-sec input 撑爆布局"那类连带影响（右栏只有 320px 宽） */
[data-test="invite-panel"] .inv-row { display: flex; align-items: center; gap: 6px; margin: 6px 0; font-size: 12px; color: var(--color-text-secondary); }
[data-test="invite-panel"] .inv-block { flex-direction: column; align-items: stretch; gap: 4px; }
[data-test="invite-panel"] select,
[data-test="invite-panel"] textarea,
[data-test="invite-panel"] .inv-num,
[data-test="invite-panel"] .inv-row > input[type="text"] {
  box-sizing: border-box; background: var(--color-bg-tertiary); color: var(--color-text-primary);
  border: 1px solid var(--color-border); border-radius: var(--radius-sm);
  padding: 5px 7px; font-size: 12px; outline: none;
}
[data-test="invite-panel"] select:focus,
[data-test="invite-panel"] textarea:focus,
[data-test="invite-panel"] .inv-num:focus,
[data-test="invite-panel"] .inv-row > input[type="text"]:focus { border-color: var(--color-primary); }
[data-test="invite-panel"] select { flex: 1 1 auto; min-width: 0; }
[data-test="invite-panel"] .inv-row > input[type="text"] { flex: 1 1 auto; min-width: 0; }
[data-test="invite-panel"] textarea { width: 100%; resize: vertical; font-family: inherit; }
[data-test="invite-panel"] .inv-num { width: 64px; flex: 0 0 64px; }
[data-test="invite-panel"] .inv-chips { display: flex; flex-wrap: wrap; gap: 4px; }
[data-test="invite-panel"] .inv-chip {
  display: flex; align-items: center; gap: 3px; font-size: 11px; padding: 2px 7px;
  border: 1px solid var(--color-border); border-radius: 20px; cursor: pointer;
}
[data-test="invite-panel"] .inv-chip.on { border-color: var(--color-primary); color: #fff; }
[data-test="invite-panel"] .inv-chip input { width: auto; margin: 0; flex: 0 0 auto; }
/* 平台首页地址配置行：名称 + 自适应输入 + 恢复默认。宽度按容器算，
   不要写通用 .env-sec input（历史上那条规则把"添加代理"的输入挤到 18px 并让右栏横向溢出） */
.plat-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; }
.plat-name { display: flex; align-items: center; gap: 5px; width: 96px; flex: 0 0 96px; font-size: 12.5px; }
.plat-row input {
  flex: 1 1 auto; min-width: 0; box-sizing: border-box;
  background: var(--color-bg-tertiary); color: var(--color-text-primary);
  border: 1px solid var(--color-border); border-radius: var(--radius-sm);
  padding: 6px 8px; font-size: 12px; outline: none;
}
.plat-row input:focus { border-color: var(--color-primary); }
/* AI 页签的超时是数字框，不该像地址那样占满整行（候选 .inv-num 只作用在邀约面板里） */
[data-test="settings-ai"] .inv-num { flex: 0 0 96px; width: 96px; }
/* 模型下拉与输入框同一行：允许收缩，否则 .modal select{width:100%} 会把行撑出横向溢出 */
[data-test="settings-ai"] .plat-row select { flex: 1 1 auto; min-width: 0; }
.about-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.about-logo { width: 40px; height: 40px; font-size: 20px; border-radius: 10px; }
.about-name { font-size: 15px; font-weight: 600; }
.about-row { display: flex; align-items: center; gap: 10px; font-size: 12.5px; padding: 4px 0; }
.about-row > span { width: 62px; flex: 0 0 62px; color: var(--color-text-secondary); }
.about-repo { display: flex; align-items: center; gap: 8px; font-weight: 400; color: var(--color-text-primary); }
.update-version { color: var(--color-text-secondary); font-size: 12px; margin: -8px 0 14px; }
.update-message { min-height: 34px; font-size: 13px; line-height: 1.6; }
.success-text { color: var(--color-success); }
.error-text { color: var(--color-error); }
.update-progress { height: 6px; border-radius: 3px; background: var(--color-bg-tertiary); overflow: hidden; margin: 8px 0 14px; }
.update-progress span { display: block; height: 100%; background: var(--color-primary); transition: width .2s ease; }
/* 通道一行、自动检查独立成行。原先两者挤在一个不换行的 flex 行里：
   "启动时自动检查"被压缩后 nowrap 文本溢出 84px（旧更新对话框就有，只是没人量过）。
   实测 flex-wrap:wrap 也压不住（auto margin + nowrap 的组合），改成两行结构最稳。 */
.update-channel-row { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 12px; color: var(--color-text-secondary); }
.update-channel-row select { width: 138px; }
.update-autocheck { display: flex; align-items: center; gap: 4px; margin: 0 0 12px; font-size: 12px; color: var(--color-text-secondary); white-space: nowrap; cursor: pointer; }
/* .modal input{width:100%} 会连复选框一起撑成整行宽：实测复选框 474px + 文字 84px = 558px，
   把设置弹窗顶出横向滚动条（旧更新对话框同样中招，只是没人量过）。与 .store-pick input 同一处修正。 */
.update-autocheck input[type="checkbox"] { width: auto; margin: 0; flex: 0 0 auto; }

/* 店铺右键菜单 */
.ctx-menu {
  position: fixed; z-index: 300; min-width: 236px; padding: 4px;
  background: var(--color-bg-elevated); border: 1px solid var(--color-border);
  border-radius: var(--radius-sm); box-shadow: 0 10px 28px rgba(0, 0, 0, .5);
}
.ctx-item {
  display: block; width: 100%; text-align: left; background: none; border: 0;
  color: var(--color-text-primary); font-size: 12.5px; padding: 7px 10px;
  border-radius: 4px; cursor: pointer;
}
.ctx-item:hover:not(:disabled) { background: var(--color-bg-tertiary); }
.ctx-item:disabled { opacity: .45; cursor: default; }
.ctx-item.danger { color: var(--color-error); }
.ctx-sep { height: 1px; background: var(--color-border); margin: 4px 2px; }
.store-pick { display: flex; align-items: center; gap: 8px; padding: 5px 2px; font-size: 12.5px; cursor: pointer; }
.store-pick input { width: auto; margin: 0; }
.tstep { border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: 8px; margin-bottom: 8px; display: flex; flex-direction: column; gap: 6px; }
/* 注意：.modal input/select{width:100%} 会覆盖这里的宽度（实测超时/重试框被撑到 496px，
   一行撑到 ~1100px 导致整行溢出、删除按钮被挤出可视区）——此处用 .tstep 前缀提高优先级 */
.tstep .add-line { display: flex; align-items: center; gap: 6px; }
.tstep .t-type { width: 168px; flex: 0 0 168px; }
.tstep .f-port2 { width: 68px; flex: 0 0 68px; }
.tstep .f-wide { width: 100%; flex: 1 1 auto; min-width: 0; }
.tstep .mini-lab { font-size: 11px; color: var(--color-text-secondary); flex: 0 0 auto; }
.tstep .row-del { margin-left: auto; }.t-type { flex: 1; }
.f-port2 { width: 68px; flex-shrink: 0; }
.f-wide { flex: 1; }
.tpl-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
</style>
