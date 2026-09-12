<template>
  <span class="platform-icon" :style="{ width: size + 'px', height: size + 'px' }">
    <img
      v-if="platformIcon"
      class="platform-icon-image"
      :src="platformIcon"
      :width="size"
      :height="size"
      :alt="name"
    />
    <svg v-else viewBox="0 0 24 24" :width="size" :height="size" role="img" :aria-label="name">
      <!-- 其他：店铺门面 -->
      <rect x="3" y="4" width="18" height="5" rx="2" fill="#6B7280" />
      <path d="M5 9h14v10.2a.8.8 0 0 1-.8.8H5.8a.8.8 0 0 1-.8-.8V9Z" fill="#6B7280" />
      <rect x="9.6" y="14" width="4.8" height="6" rx=".8" fill="rgba(15,19,26,.85)" />
      <rect x="6.6" y="11.4" width="3" height="2.2" rx=".6" fill="rgba(15,19,26,.85)" />
      <rect x="14.4" y="11.4" width="3" height="2.2" rx=".6" fill="rgba(15,19,26,.85)" />
    </svg>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import douyinIcon from '../assets/douyin-store.png'
import kuaishouIcon from '../assets/kuaishou-store.png'
import pinduoduoIcon from '../assets/pinduoduo.png'
import wechatIcon from '../assets/wechat-store.png'

const props = withDefaults(defineProps<{ name?: string; size?: number }>(), {
  name: '',
  size: 14
})

const kind = computed(() => {
  const n = props.name || ''
  if (n.includes('拼多多')) return 'pdd'
  if (n.includes('微信')) return 'wechat'
  if (n.includes('快手')) return 'kuaishou'
  if (n.includes('抖')) return 'douyin'
  return 'other'
})

const platformIcon = computed(() => {
  if (kind.value === 'pdd') return pinduoduoIcon
  if (kind.value === 'wechat') return wechatIcon
  if (kind.value === 'kuaishou') return kuaishouIcon
  if (kind.value === 'douyin') return douyinIcon
  return ''
})
</script>

<style scoped>
.platform-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  vertical-align: middle;
}
.platform-icon svg {
  display: block;
}
.platform-icon-image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
</style>
