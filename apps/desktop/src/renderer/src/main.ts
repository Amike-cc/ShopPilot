/**
 * Vue 应用入口
 * 单工作台屏幕：店铺页是固定视口区域里的 DOM `<webview>`，不使用多路由跳转。
 */

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './app/App.vue'

const app = createApp(App)
app.use(createPinia())
app.mount('#app')
