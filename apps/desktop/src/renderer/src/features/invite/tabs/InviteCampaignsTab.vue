<template>
      <div v-if="loading && !campaigns.length" class="invite-state" data-test="invite-v2-loading">正在读取邀约批次…</div>
      <div v-else-if="!campaigns.length && !orphanTasks.length" class="invite-empty" data-test="invite-v2-empty">
        <h2>还没有邀约批次</h2>
        <p>从「新建邀约」进入当前店铺的配置面板，按平台实测流程发起第一批；完成后这里会出现批次与逐人记录。</p>
        <button type="button" class="invite-btn primary" @click="openConfig">去配置并开始</button>
      </div>
      <div v-else class="invite-campaigns" data-test="invite-v2-campaign-list">
        <article
          v-for="campaign in campaigns"
          :key="campaign.id"
          class="invite-campaign"
          data-test="invite-v2-campaign-row"
          @click="openDetail(campaign)"
        >
          <div class="invite-campaign-main">
            <div class="invite-campaign-title">
              <strong>{{ campaign.name }}</strong>
              <span class="invite-chip" :class="campaignStatusTone(campaign.status)">{{ campaignStatusLabel(campaign.status) }}</span>
            </div>
            <div class="invite-campaign-meta">
              <span>{{ campaign.storeName || storeName(campaign.storeId) }}</span>
              <span>{{ campaign.platform }}</span>
              <span>{{ formatTime(campaign.createdAt) }}</span>
              <span v-if="campaign.status === 'scheduled' && campaign.scheduledAt">计划启动：{{ formatTime(campaign.scheduledAt) }}</span>
              <span v-if="campaign.stopReason">停止原因：{{ stopReasonLabel(campaign.stopReason) }}</span>
              <span v-else-if="campaign.statusReason">{{ campaign.statusReason }}</span>
            </div>
          </div>
          <div class="invite-campaign-counts">
            <span><b>{{ campaign.targetCount }}</b>计划</span>
            <span><b>{{ campaign.sentCount }}</b>已发</span>
            <span><b>{{ campaign.skippedCount }}</b>跳过</span>
            <span><b>{{ campaign.failedCount }}</b>失败</span>
          </div>
          <div class="invite-campaign-actions">
            <button type="button" class="invite-mini" @click.stop="openDetail(campaign)">查看</button>
            <button v-if="campaign.status === 'scheduled'" type="button" class="invite-mini danger" data-test="invite-v2-cancel-schedule" @click.stop="cancelSchedule(campaign.id)">取消排期</button>
            <button v-if="campaign.runId && (campaign.status === 'running' || campaign.status === 'paused')" type="button" class="invite-mini danger" @click.stop="stopCampaign(campaign.runId)">停止</button>
            <button type="button" class="invite-mini" @click.stop="openStore(campaign.storeId)">打开店铺</button>
          </div>
        </article>

        <section v-if="orphanTasks.length" class="invite-orphans">
          <h2>未关联批次的邀约任务</h2>
          <p>这些任务由旧版本或智能体创建，没有批次元数据；记录仍按任务/运行写入。</p>
          <article v-for="task in orphanTasks" :key="task.id" class="invite-orphan-row">
            <div><strong>{{ task.name }}</strong><small>{{ storeName(task.storeScope) }} · {{ formatTime(task.createdAt) }}</small></div>
            <span class="invite-chip muted">{{ campaignStatusLabel(task.latestRun?.status === 'running' ? 'running' : task.latestRun?.status === 'failed' ? 'failed' : task.latestRun?.status === 'succeeded' ? 'completed' : 'ready') }}</span>
            <!-- 孤儿任务没有 storeScope（null）：按钮禁用而非把 null 塞进导航 -->
            <button type="button" class="invite-mini" :disabled="!task.storeScope" @click="task.storeScope && openStore(task.storeScope)">打开店铺</button>
          </article>
        </section>
      </div>
</template>

<script setup lang="ts">
import { inject } from 'vue'
import { INVITE_PAGE_KEY } from '../invite-page-context'

const page = inject(INVITE_PAGE_KEY)!
const { loading, campaigns, orphanTasks, openConfig, openDetail, campaignStatusTone, campaignStatusLabel, storeName, formatTime, stopReasonLabel, stopCampaign, cancelSchedule, openStore } = page
</script>
