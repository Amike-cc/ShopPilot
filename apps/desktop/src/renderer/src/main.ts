/**
 * Vue 应用入口
 * 单工作台屏幕：店铺页是固定视口区域里的 DOM `<webview>`，不使用多路由跳转。
 *
 * 样式加载顺序（必须在 mount 之前）：
 *   tokens → base → components
 * tokens 定义变量，base 复位元素，components 提供 ui-* 组件类；页面内的 scoped 样式在其后。
 */

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './app/App.vue'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'

const app = createApp(App)
app.use(createPinia())
app.mount('#app')
