/**
 * 任务失败错误码分类。
 *
 * 【为什么单独成文件】
 * 这层逻辑此前是 task-runner.ts 里的一个 if 链，只有靠"人肉记得加分支"来维护——
 * 结果就是：引擎新抛一个错误码，分类函数不认识，run 的 error_code 落成 INTERNAL_ERROR。
 * 用户看到"内部错误"，真实原因（页面出现了失败文案 / 按钮被浮层遮住 / 截图时窗口没显示）
 * 全被吞掉；而 task_runs.error_code 是界面直接展示给用户的那一列。
 *
 * 真正危险的是**静默**：`TASK_TEXT_PRESENT` 是平台明确拒绝（业务结果），
 * 不是软件故障，报成 INTERNAL_ERROR 会让人以为是程序坏了，甚至重复提交。
 *
 * 所以抽成纯模块 + 单测：单测从 task-runner 源码里扫出所有 throw 的错误码，
 * 逐个断言"必须被分类器认识"，新加错误码时忘了登记会当场测试失败。
 */

/**
 * 错误消息首部形如 `CODE: 说明` 的固定错误码。
 * 顺序无关紧要（各自互不为前缀），但保持与 task-runner 里的抛出一致便于对照。
 */
const PREFIX_CODES: readonly string[] = [
  'TASK_TIMEOUT',
  'TASK_SELECTOR_CHANGED',
  'NAVIGATION_BLOCKED',
  'TASK_CONFIRMATION_REQUIRED',
  'TASK_TARGET_DISABLED',
  // 目标被浮层遮住（实测快手级联弹层盖住按钮）：用户能自己解决（把窗口拉宽）
  'TASK_TARGET_COVERED',
  // 目标整块在视口外（弹层靠 rAF 定位但页面被节流）：与"被遮挡"分开，
  // 否则会把"页面被后台节流"误导成"窗口太窄"
  'TASK_TARGET_OUT_OF_VIEWPORT',
  // 文案缺席断言命中（平台用文案告诉我们它拒绝了）：这是**业务结果**，不是内部错误
  'TASK_TEXT_PRESENT',
  // 额度预检不过（微信今日剩余不足 / 抖店确认发送禁用等）
  'TASK_QUOTA_EXCEEDED',
  // 广场可选达人不足（要 40 位但池子里只有更少）——发送前中止，别发错数量
  'TASK_SELECTION_SHORTFALL',
  // 当前分页里的候选都已处理过，由 loop 的 onCode 恢复步骤消化
  'TASK_PAGE_EXHAUSTED',
  // 这一位达人的详情页打不开（微应用间歇性不渲染），交给 onCode 退避重试
  'TASK_DAREN_PAGE_UNOPENABLE',
  // 页面正常，但平台明说不满足合作条件：重试同一位永远没用，必须跳过换人
  'TASK_DAREN_NOT_INVITABLE',
  // 「邀请带货」禁用且平台说明是"已经邀约过"：同样要跳过换人
  'TASK_DAREN_ALREADY_INVITED',
  // 店铺视图当时未挂载（弹层遮挡导致摘除）：需要真实落点的步骤无法进行
  'TASK_VIEW_DETACHED',
  // 邀约商品没真正选上：必须在发送前如实失败，绝不能落进 stopOn 被当成"按预期收工"
  'TASK_PRODUCT_NOT_SELECTED',
  // 提交后页面上出现了平台给的**失败文案**（实测快手「部分邀约发送失败」）
  'TASK_SEND_PARTIAL',
  // 页面被重定向到登录页（登录态失效）：用户能自己解决，与"页面慢/改版"区分开
  'TASK_LOGIN_REQUIRED',
  // 页签点了但没选中（平台同名页签数据不同）
  'TASK_TAB_NOT_ACTIVE',
  // 微信小店（assist-form）流程专属：邀约页未打开 / 受信任写入未生效
  'TASK_INVITE_PAGE_NOT_OPEN',
  'TASK_INPUT_NOT_APPLIED',
  // 店铺浏览器/任务标签页被关闭（此前落进 INTERNAL_ERROR，看不出真实原因）
  'BROWSER_CLOSED',
  // 截图时视口未渲染（页面不可见）：工件落不下来，得让用户知道是"窗口没显示"
  'CAPTURE_EMPTY',
  // 步骤参数非法：本不该在运行时出现，但一旦出现要能定位到具体步骤类型
  'TASK_INVALID_STEP',
  // 状态机不允许的操作（如对已结束的运行执行恢复）
  'TASK_BAD_STATE',
  // AI 相关的固定错误码：便于界面区分"没配 Key / 地址不合法 / 超时 / 请求失败"
  'AI_NOT_CONFIGURED',
  'AI_BAD_ENDPOINT',
  'AI_TIMEOUT',
  'AI_REQUEST_FAILED',
  // AI_EMPTY_SOURCE / AI_EMPTY_OUTPUT 统一归到 AI_EMPTY_OUTPUT（界面按"没取到内容"处理）
  'AI_EMPTY_SOURCE',
  'AI_EMPTY_OUTPUT'
]

/** 归一到对外错误码：AI 的两条空内容错误合并成一条 */
function normalize(code: string): string {
  return code === 'AI_EMPTY_SOURCE' ? 'AI_EMPTY_OUTPUT' : code
}

/**
 * 包装码：它们把**内层真实错误码**藏在消息里，自己不携带信息。
 * `LOOP_ROUND_FAILED: 第 2/5 轮…失败：TASK_QUOTA_EXCEEDED: …`
 * 这种必须取内层那个码，否则 loop 的 stopOn / onCode 永远匹配不上。
 */
const WRAPPER_CODES = new Set(['LOOP_ROUND_FAILED'])

/**
 * 通用错误码形状：`[A-Z][A-Z0-9_]*_[A-Z0-9_]+` —— 要求**至少含一个下划线**。
 *
 * 为什么要这个兜底：白名单只能靠人记得同步，实测已经漏了 5 个（见文件头注释）。
 * 更关键的是有一类码**不是字面量**，而是从步骤参数传进来的：
 * `requireTextAbsent` / `requireQuota` 的 `code` 字段由用户在编排里指定，
 * 扫描源码根本不可能发现它，白名单法注定会把它吞成 INTERNAL_ERROR。
 *
 * 两个收紧都是为了**避免误命中**：错误码一律写在消息开头（`CODE: 说明`），
 * 或包装码的内层（`…失败：CODE: 说明`），所以只认这两种位置。
 *
 * - 要求下划线：避开 URL 里的 `HTTP:` / `HTTPS:` 之类噪音（协议名不含下划线）；
 * - 只认开头/冒号后：否则消息里**引用**某个码的普通文本（例如把错误码写进提示语，
 *   或页面原文里恰好出现 `A_B`）会被当成真实错误码。这不是学术风险——loop 的
 *   `stopOn` 会把命中的码当成"按预期收工"，误命中等于静默漏发却记成功。
 */
const GENERIC_CODE = /(?:^|[:：]\s*)([A-Z][A-Z0-9_]*_[A-Z0-9_]+)/g

/**
 * 从异常里提取对外错误码。
 *
 * 两段式：先按已知码精确识别（保证既有语义一字不变），再通用兜底。
 * 兜底把此前会静默变成 INTERNAL_ERROR 的码透出来——包括步骤参数里指定的自定义码。
 * 完全认不出来才返回 INTERNAL_ERROR。
 */
export function classifyTaskError(e: unknown): string {
  const msg = String((e as { message?: unknown })?.message ?? e)

  // 第一段：已知码，按登记顺序匹配（保持与旧 if 链完全一致的优先级）
  for (const code of PREFIX_CODES) {
    if (msg.includes(code)) return normalize(code)
  }

  // 第二段：通用兜底——取第一个不是包装码的 `CODE` 形状 token
  for (const m of msg.matchAll(GENERIC_CODE)) {
    const code = m[1]
    if (WRAPPER_CODES.has(code)) continue
    return normalize(code)
  }

  return 'INTERNAL_ERROR'
}

/** 供单测对照：分类器认识的全部错误码（归一后） */
export const KNOWN_ERROR_CODES: readonly string[] = Array.from(new Set(PREFIX_CODES.map(normalize)))
