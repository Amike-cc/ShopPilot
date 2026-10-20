<template>
    <div v-if="detailOpen" class="invite-drawer-mask" data-test="invite-v2-campaign-detail" @click.self="closeDetail">
      <aside class="invite-drawer">
        <header class="invite-drawer-head">
          <div>
            <span class="invite-eyebrow">CAMPAIGN</span>
            <h2>{{ detail?.campaign?.name || '读取中…' }}</h2>
            <p v-if="detail">{{ detail.campaign.storeName || storeName(detail.campaign.storeId) }} · {{ detail.campaign.platform }} · {{ formatTime(detail.campaign.createdAt) }}</p>
          </div>
          <button type="button" class="invite-mini" @click="closeDetail">关闭</button>
        </header>
        <div v-if="detailLoading" class="invite-state">正在读取批次详情…</div>
        <template v-else-if="detail">
          <div class="invite-detail-kpis">
            <span><b>{{ detail.campaign.targetCount }}</b>计划</span>
            <span><b>{{ detail.campaign.sentCount }}</b>已发送</span>
            <span><b>{{ detail.campaign.skippedCount }}</b>跳过</span>
            <span><b>{{ detail.campaign.failedCount }}</b>失败</span>
            <span><b>{{ detail.campaign.unknownCount }}</b>未知</span>
          </div>
          <div class="invite-detail-line">
            <span class="invite-chip" :class="campaignStatusTone(detail.campaign.status)">{{ campaignStatusLabel(detail.campaign.status) }}</span>
            <span>停止原因：{{ stopReasonLabel(detail.campaign.stopReason) }}</span>
            <span v-if="detail.run">运行：{{ detail.run.status }}</span>
            <button v-if="detail.run && (detail.run.status === 'running' || detail.run.status === 'paused')" type="button" class="invite-mini danger" @click="stopCampaign(detail.run.id)">停止运行</button>
          </div>
          <div v-if="!detail.records.length" class="invite-empty small">这个批次还没有逐人记录。批量流会在发送成功后写入实际勾选名单。</div>
          <div v-else class="invite-record-table compact">
            <div class="invite-record-head">
              <span>达人</span><span>状态</span><span>来源</span><span>时间</span><span>修正</span>
            </div>
            <div v-for="record in detail.records" :key="record.id" class="invite-record-row">
              <span class="invite-record-name"><strong>{{ record.nickname }}</strong><small>{{ record.identityLevel === 'username' ? '用户名匹配' : '仅昵称匹配' }}</small></span>
              <span><em class="invite-chip" :class="recordStatusTone(record.status)">{{ recordStatusLabel(record.status) }}</em></span>
              <span>{{ record.statusSource === 'platform' ? '平台回读' : record.statusSource === 'manual' ? '人工修正' : '本地记录' }}</span>
              <span>{{ formatTime(record.invitedAt || record.createdAt) }}</span>
              <span>
                <select class="invite-asset-select" data-test="invite-v2-record-status-select" :value="record.status" @change="setManualStatus(record, ($event.target as HTMLSelectElement).value)">
                  <option value="sent">已发送</option>
                  <option value="inviting">邀请中</option>
                  <option value="accepted">已接受</option>
                  <option value="rejected">已拒绝</option>
                  <option value="expired">已过期</option>
                  <option value="unknown">状态未知</option>
                </select>
              </span>
            </div>
          </div>
        </template>
        <div v-else class="invite-state">批次不存在或读取失败。</div>
      </aside>
    </div>
</template>

<script setup lang="ts">
import { inject } from 'vue'
import { INVITE_PAGE_KEY } from './invite-page-context'

const page = inject(INVITE_PAGE_KEY)!
const { detailOpen, detail, detailLoading, closeDetail, storeName, formatTime, campaignStatusTone, campaignStatusLabel, stopReasonLabel, stopCampaign, recordStatusTone, recordStatusLabel, setManualStatus } = page
</script>
