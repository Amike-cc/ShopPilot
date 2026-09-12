/**
 * 密码对话框专用 preload：唯一暴露的能力是把结果交回主进程。
 * 该窗口不加载应用 preload，不暴露任何业务 IPC 面。
 *
 * 注意：必须用 contextBridge（而非 window.x = ...）——contextIsolation 下直接赋值只落在隔离世界，
 * 页面主世界读不到，确认/口令按钮会静默失效（M4 打包态对话验收发现的真实缺陷）。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__pwDone', (value) => {
  ipcRenderer.send('pw-dialog:done', value === undefined ? null : value)
})
