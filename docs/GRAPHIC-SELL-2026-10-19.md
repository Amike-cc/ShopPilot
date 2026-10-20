# 图文带货（AI 创作新增工作台）—— 2026-10-19

## 1. 功能定位

「AI 创作」页新增独立工具 **图文带货**：填商品信息 → AI 生成一套可直接发布的带货图文笔记
（标题 / 正文 / 话题标签 / 封面大字 / 逐图画面描述）→ 再按逐图描述生成配图 →
可在页内编辑、一键复制、保存图片、查看/恢复历史会话。

它复用了设置中心已有的两套 AI 配置，不新增第三套 Key：

| 用途 | 配置来源 | 未配置时 |
|---|---|---|
| 带货文案 | **生图文本 API**（优先）；没配好则回退**主文本 API** | 页面顶栏显示「文案：未配置」，生成按钮不可点并给出设置路径 |
| 配图 | **生图 API**（与「AI 生成商品图」同一套） | 顶栏显示「生图：未配置」，同上 |

边界（如实声明）：

- **不代替用户发布**：没有平台自动发布/挂车能力，只产出素材与文案；发布仍需人工在平台后台完成。
- **AI 配图不渲染中文标题**：中文文字渲染不可靠（错字比没有更糟），提示词统一要求「留出干净排版区、不生成文字」；
  标题/正文/话题以可复制文本给出，封面大字由用户自己在平台编辑器里排版。
- **生图尺寸受供应商限制**：接口只接受 `1024x1024` / `1536x1024` / `1024x1536` 三种尺寸；
  参考效果的 9:16 与 3:4 都映射到 `1024x1536` 竖版，导出后可按平台需要再裁切。
- **效果是否"像"取决于生图模型**：模板提供的是场景/构图/模特/色调与商品一致性约束（走图生图端点、以商品图为参考）；
  不同供应商对"平铺商品图 → 模特穿着效果"的能力差异较大，页面不承诺百分比相似。商品图建议用正面平铺/白底、细节清晰。
- 历史会话受 localStorage 约 5MB 配额约束：超预算时**保留文案、丢弃配图**（界面会说明），
  用户可重新生成配图；文案/正文/标签始终可恢复。

## 2. 用户流程（页面）

入口：左侧导航「AI 创作」→ 卡片「图文带货」；应用中心「内容创作」分类下同名卡片。

1. **商品信息**：商品名称（必填）、卖点/使用场景、售价、原价、目标人群（选填）。
2. **商品图**（效果模板必填、AI 自由设计选填；最多 3 张，PNG/JPEG ≤5MB/张）：有图时文案模型会读图核对卖点，
   图片同时作为配图原图与"商品一致性"参考。
3. **效果模板**：躺床俯拍（默认，参考效果同款）/ 平铺净景 / AI 自由设计；出镜模特（儿童 / 成年女性 / 自动 / 无人）。
4. **发布设置**：平台（通用 / 小红书 / 抖音 / 快手 / 视频号）、笔记风格（种草分享 / 测评对比 / 生活方式 /
   使用教程 / 促销爆款）、配图数量（3 / 4 / 6 / 9）、图片比例（9:16 / 3:4 / 1:1 / 4:3）。
5. **生成**：先弹确认框（文案接口、生图模型、商品、平台/风格、效果模板、配图张数、请求次数、素材清单），
   确认后先请求文案，再按效果模板的逐张构图请求配图（效果模板一张一请求；AI 自由设计单次最多 4 张）。
6. **结果**：笔记预览（配图轮播 + 缩略图）、可编辑的标题/正文/话题、配图网格；
   支持复制完整文案/标题/正文/话题、保存当前图并在文件夹中定位。
7. **历史**：按时间倒序列出会话（标题、平台/风格、效果模板、时间、首图缩略），可恢复或删除。

生成期间离开页面会被拦截（文案与图片只在页面内存里，卸载即丢）；页面被强制卸载时也会显式复位忙碌状态。

## 2.5 效果模板（2026-10-19 按用户 4 张参考图新增）

用户上传的商品图 → 生成**参考效果同款**配图，是「图文带货」的核心交付形态。参考图效果拆解：

- **构图**：俯拍（bird's-eye）躺床构图，竖屏约 9:16；人物仰卧、身体自然舒展，商品完整可见；
- **场景**：柔和床品背景（床单自然褶皱、同色系枕头），粉彩 / 清透低饱和色调，柔和均匀的自然光；
- **主体**：商品由儿童模特自然穿戴/使用（面料质感、刺绣文字、领口袖口细节清晰）；
- **点缀**：毛绒玩偶或白色小猫同框，强化居家生活感；
- **姿势轮换**：正面俯卧、侧身微转、俯拍近景（材质/刺绣特写）、玩偶/小猫氛围 4 种构图；
- **画面干净**：不叠文字、价格标签、水印或品牌 Logo。

因此工作台新增「效果模板」与「出镜模特」：

| 模板 | 说明 | 推荐参数 | 商品图 |
|---|---|---|---|
| **躺床俯拍（默认）** | 参考效果同款：俯拍躺床 + 柔和床品 + 模特自然展示，可配玩偶/小猫 | 9:16 · 儿童模特 | 必填 |
| 平铺净景 | 无人出镜：商品平铺在干净浅色背景上的目录级俯拍 | 3:4 · 无人 | 必填 |
| AI 自由设计 | 按文案逐图设计场景（原行为，适合非服装类商品） | 3:4 · 自动 | 选填 |

- 选择模板会自动套用推荐比例与模特（用户仍可手动改），选择写进 `localStorage`，下次打开直接沿用；
- 模板模式下**一张图一次生图请求**：提示词里的构图按张序轮换（正面/侧身/近景/氛围），
  一次 `n=4` 会让四张图共用同一段构图，出不来参考图那种多样的姿势；
- 模板提示词含**商品一致性最高优先级约束**：颜色、面料、图案、刺绣文字与版型不变，
  且若上传的是平铺商品图，要求模特穿上该商品——这是"同款效果"与"长得像的另一件商品"的分界线；
- 模式没有商品图时，模板类生成按钮不可点并说明原因，避免花钱生成无法核对的商品；
- 4 张参考效果图作为页面内预览素材随页面按需加载（`assets/ui/graphic-sell/`）。

## 2.6 生图质量优化（2026-10-19 实测复盘）

用真实商品（"暖暖套装"）按首版模板跑了一组 4 张图，逐张与参考效果对比后发现 5 类问题，均已针对性修复：

| 实测问题 | 原因 | 修复 |
|---|---|---|
| 睁眼微笑看镜头、影楼写真感 | 提示词只写"自然放松"，模型默认输出摆拍人像 | 明确「眼睛轻闭、表情安静放松（像睡着一样），不看镜头、不微笑摆拍」；补「不要过度磨皮、娃娃脸、塑料感」 |
| 凭空多出第二个孩子/第二套商品/多件道具 | 氛围构图只写"人物与玩偶或小猫"，未限制主体数量 | 新增「禁止编造」条款：只出现一位人物与一套商品；不添加参考图没有的配饰/发饰/花纹床品/额外道具 |
| 商品上出现 `D' laudi` 等乱码假英文 | 旧提示词无条件要求"刺绣文字与位置不变"，商品本无文字时模型自己编字 | 文字条款改为**条件式**：参考图确实有文字才原样保留；没有文字时画面不出现任何字母，禁止编造品牌名 |
| 构图倾斜、脚部被裁、近景变成人像特写 | 构图描述不够具体 | 每张构图写死：正上方 90° 垂直俯拍、全身完整入画不裁脚、四周留 8–12% 空间；第 3 张改为面料/工艺特写并「严禁人脸大特写」 |
| 一套图里常有 1–2 张跑偏，只能全部「换一批」 | 无单张重发能力 | 结果区每张配图新增「**重绘**」：复用同一份文案/效果模板/模特/商品图，只重发这一张（n=1），替换原图并同步历史 |

另外：第 4 张氛围图改为"同一场景 + 至多一件玩偶或一只小猫"，不再引入其他人物。


## 3. 数据流与安全边界

```
Renderer（页面/组合式函数）
  └─ window.shopilot.ai.generateSellCopy(结构化字段)
       └─ preload: ai:image-text:sell-copy
            └─ Main ai-handlers：assertTrustedRenderer → generateSellCopyText
                 ├─ main/services/ai-sell-copy.ts：输入清洗 / 提示词组装 / JSON 解析（纯函数）
                 └─ ai-client.chatCompleteForImageText（生图文本 API，未配置则回退主文本 API）
  └─ window.shopilot.ai.generateImage({ prompt, size, n, confirmed, sourceImages })
  └─ window.shopilot.ai.saveImage(...)（主进程另存为对话框，回传真实写入路径）
```

- **提示词只在主进程**：渲染层只能提交 `productName / sellingPoints / price / originalPrice / audience /
  platform / style / imageCount / images`，不能注入 system 指令；平台/风格/张数由 shared 白名单归一。
- **API Key 只在主进程**：所有通道只回「是否已配置」，界面不接收也不显示 Key。
- **图片限制**：文案接口最多读 3 张、单张 ≤8MB、仅 png/jpeg/webp；生图请求沿用既有 `AI_IMAGE_GENERATE` 限制。
- **审计**：成功只记 `model(读图N张)(是否回退)`，失败只记错误码；不写商品名、卖点、正文与 Key。
- **失败如实**：接口错误统一经主进程本地化后展示，不静默降级、不伪造“生成成功”。

## 4. 接口契约

通道：`ai:image-text:sell-copy`（`IPC_CHANNELS.AI_IMAGE_TEXT_SELL_COPY`；AI 域未接入 IpcContract，preload 走 `ipcRenderer.invoke`）。

请求（字段均可选，主进程再清洗一次）：

```ts
{
  productName?: string      // ≤120
  sellingPoints?: string    // ≤500
  price?: string            // ≤24
  originalPrice?: string    // ≤24
  audience?: string         // ≤120
  platform?: string         // 通用/小红书/抖音/快手/视频号（未知值回落「通用」）
  style?: string            // 种草分享/测评对比/生活方式/使用教程/促销爆款（未知值回落「种草分享」）
  imageCount?: number       // 1–9，决定 imagePrompts 条数
  images?: Array<{ mimeType: string; b64Json: string }>   // ≤3 张，≤8MB/张
}
```

返回（shared `SellCopyResult`）：

```ts
{
  title: string             // 保证非空（模型标题 → 正文首行 → 商品名 → 「好物推荐」）
  body: string
  tags: string[]            // 不带 #，≤8 条、每条 ≤20 字
  coverText: string         // 封面大字，≤20 字
  imagePrompts: string[]    // 长度恒等于 imageCount（不足补占位画面描述）
  model: string
  elapsedMs: number
  source: 'image-text' | 'main-text'   // 本次实际走的配置，界面如实展示
  imageCount: number        // 真实读图张数（0 = 纯文本生成）；与配图张数是两个字段
}
```

纯逻辑与上限的唯一事实来源：`packages/shared/src/contracts/ai-sell-copy.ts`
（`SELL_COPY_PLATFORMS / SELL_COPY_STYLES / SELL_COPY_LIMITS / normalizeSellCopyPlatform / clampSellCopyImageCount`）。
模型输出解析策略：先取 JSON（容忍 ```json 围栏与前后说明文字）→ 逐字段清洗 → 文本兜底
（标题=首行、正文=剩余文本、tags=[]），确保界面不会收到没有标题/正文的空结果。

## 5. 改动文件

| 层 | 文件 | 内容 |
|---|---|---|
| 契约 | `packages/shared/src/contracts/ai-sell-copy.ts`（新） | 输入/输出类型、平台/风格白名单、上限与归一小函数 |
| 契约 | `packages/shared/src/contracts/ipc.ts` | 新增 `AI_IMAGE_TEXT_SELL_COPY` 通道 |
| 主进程 | `apps/desktop/src/main/services/ai-sell-copy.ts`（新） | 输入清洗 / 提示词组装 / 模型输出解析（纯函数，无 electron/db） |
| 主进程 | `apps/desktop/src/main/services/ai-client.ts` | `generateSellCopyText`，复用生图文本链路与主文本回退 |
| 主进程 | `apps/desktop/src/main/ipc/ai-handlers.ts` | 新 handler：可信校验 + 审计 + 统一错误话术 |
| 主进程 | `apps/desktop/src/main/services/audit-logger.ts` | `AuditAction` 增加 `ai.imageText.sellCopy` |
| 桥接 | `apps/desktop/src/preload/index.ts` / `apps/desktop/src/renderer/src/env.d.ts` | `ai.generateSellCopy` |
| 渲染层 | `features/workbench/graphic-sell.ts`（新） | 组参、可用性判据、结果收口、效果模板与生图提示词、历史预算（纯函数） |
| 渲染层 | `features/workbench/use-graphic-sell.ts`（新） | 表单/配置/效果模板/生成/保存/复制/历史状态机 |
| 渲染层 | `features/workbench/UnifiedGraphicSellPage.vue`（新） | 工作台 UI、效果模板与参考效果、确认框、结果编辑、历史抽屉 |
| 素材 | `assets/ui/graphic-sell/effect-bed-*.jpg`（新，4 张） | 参考效果预览（用户提供的效果图） |
| 路由 | `features/workbench/UnifiedAppsPage.vue` / `DashboardView.vue` | AI 创作卡片入口、页面挂载、标题、导航高亮、生成中离开保护 |
| 测试 | `tests/unit/ai-sell-copy.test.ts`（新，44 例） | 主进程纯逻辑：清洗/提示词/解析/兜底 |
| 测试 | `tests/unit/graphic-sell.test.ts`（新，39 例） | 渲染层纯逻辑：组参/判据/清洗/效果模板提示词/预设记忆/历史 |
| 测试 | `tests/unit/graphic-sell-page.test.ts`（新，15 例） | 跨进程接线守卫：shared↔main↔preload↔env↔页面↔路由↔参考素材↔重绘 |
| 测试 | `tests/unit/graphic-sell-component.test.ts`（新，5 例） | happy-dom 挂载冒烟：默认参考效果/确认/真实请求参数/失败态/单张重绘 |
| 测试 | `tests/unit/image-studio-parity.test.ts` | 生成中离开保护的断言随值守函数泛化同步更新 |

## 6. 验证

- `pnpm.cmd exec vitest run`：全量通过（含本功能 103 个新用例）。
- `pnpm.cmd exec tsc --noEmit`、`pnpm.cmd exec tsc -p tsconfig.test.json`、`pnpm.cmd exec vue-tsc --noEmit`：0 错误。
- `pnpm.cmd exec eslint <改动文件>`：0 error。
- 组件挂载用例覆盖：无 Electron 桥时如实提示、配置齐全时确认框 → 文案请求参数 → 配图请求参数
  （`confirmed: true`、`n ≤ 4`、比例映射尺寸、提示词含逐图画面描述）→ 结果区渲染；
  文案接口失败时报可执行中文错误且不继续生图。
