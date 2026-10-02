# 商品管理 · 完整方案（v3 · 极致版）

> **状态**：方案（未开工）　**日期**：2026-09-30　**基线**：v0.4.57
> **修订**：v1 初稿 → v2 把"发布"展开成半自动三段式 → v3（本文）补全工程细节：
> SKU 级映射、图片下载安全、并发与熔断、事务与容量、错误分类学、观测性、ADR、风险登记册、DoD 与验收矩阵。
>
> **阅读指引**
> - 只想知道"做成什么样" → §0 摘要 + §8 UI 规格 + §14 里程碑
> - 要评审工程细节 → §4 数据模型 / §5 同步 / §7 发布 / §9 安全 / §10 性能
> - 要开工 → §17 勘察清单 → §14 里程碑 → §19-C 文件清单
> - 要评估风险 → §16 风险登记册 + §15 决策记录
>
> **本文的一条铁律**：任何平台锚点、字段、控件形态，**未真机实测一律标"待实测"**，绝不预填。
> 这是本项目平台适配层的红线（`constants/business.ts` 顶部注释原文）。

---

## 0. 摘要

### 0.1 三条流水线

```
① 同步（只读，全自动）     平台商品 → 本地（含图片本地化）
② 本地库（无风险）         编辑 / 归并 / 校验 / 导入导出
③ 发布（半自动）           本地商品 → 指定店铺：自动填 → 人工提交 → 自动回读
```

| 流水线 | 自动化程度 | 失败代价 | 可重试 |
| --- | --- | --- | --- |
| ① 同步 | 全自动 | 数据不准，可重来 | ✅ 幂等 |
| ② 本地库 | — | 本地数据，可备份 | — |
| ③ 发布 | **半自动**（填=自动 / 提交=人工 / 回读=自动） | 平台产生真实商品，难撤回 | ⚠️ 只重试失败店，不重放已成功步骤 |

### 0.2 十条关键设计决策（详见 §15 ADR）

| # | 决策 | 一句话理由 |
| --- | --- | --- |
| D1 | 同步与发布**分成两条独立管线**，不共用任务模板 | 只读与写入的风险、重试语义、可恢复性完全不同 |
| D2 | 平台商品与本地商品**不自动合并**，只给建议 | 合错了是两个商品被搅在一起，比不合并更糟 |
| D3 | 平台值与本地编辑**冲突时不覆盖** | 与 `decideLicenseWrite` 同哲学：宁可少填，不可填错 |
| D4 | 发布做成**三段式半自动**，最终提交永远人工 | `FUNCTIONAL_SPEC:7` 已定红线；平台侧无法可靠撤回 |
| D5 | 人工那一遍的输入**回读沉淀**为平台默认值 | 让自动化程度随使用上升，而不是每次都手填一遍 |
| D6 | 档位（L1/L2/L3）由**实测锚点推导**，不许手写 | 杜绝"声明了自动化其实填不进去" |
| D7 | 图片下载走**店铺 Session** 且做 SSRF/体积/格式三重校验 | remote_url 来自页面，是不可信输入 |
| D8 | 同步按**每店串行 + 跨店 2 并发**，带熔断 | 与 `sales-metrics-scheduler` 同节流口径，避免触发平台风控 |
| D9 | 商品级与 **SKU 级映射分开存** | 平台 SKU 增删频繁，混在商品行里会导致整行作废 |
| D10 | 一切"抓不到"都走**错误分类学 + 如实话术**，不猜不兜底 | 沿用本项目"如实说明"的界面风格 |

### 0.3 交付分期一览

| 期 | 内容 | 可否独立交付 |
| --- | --- | --- |
| M1 | 同步到本地（1 平台打样 → 铺开）+ 只读商品页 | ✅ 可交付 |
| M2 | 本地商品库（编辑 / 图片 / 归并 / 导入导出） | ✅ 可交付 |
| M3 | 半自动发布（L1 填充 + 回读闭环，1 平台） | ✅ 可交付 |
| M4 | 多店批量、差异核对、健康面板 | ✅ 可交付 |

---

## 1. 目标 / 非目标 / 边界

### 1.1 目标（用户原话拆解）

1. **同步所有平台店铺的商品到本地**：四家平台（拼多多 / 微信小店 / 抖店 / 快手小店）每家店的在售商品
   （标题 / 价格 / 库存 / SKU / 图片 / 状态 / 类目）落到本机数据库。
2. **商品保存到本地**：本地是一份**可编辑、可复用**的商品主数据（含图片本地化），不依赖平台在线。
3. **本地商品可以发布到指定的店铺**：选本地商品 → 选目标店铺（一或多）→ **半自动**建出平台商品
   （自动填 → 用户提交 → 自动回读落库）。

### 1.2 非目标（明确不做）

- ❌ 平台类目 / 资质 / 品牌库的自动匹配（要先实测登记）
- ❌ 无人工确认的全自动发布（见 D4）
- ❌ 平台 → 本地的反向实时回写（本地改价改库存自动推回平台）——第二期
- ❌ 跨平台库存实时双向同步（先做单向：本地 → 平台）
- ❌ 采集买家信息 / 评价内容 / 客服会话
- ❌ 商品营销（优惠券、活动报名、投放）——那是营销域，不是商品域

### 1.3 与既有模块的边界（明确不碰）

| 模块 | 关系 |
| --- | --- |
| `sales_metrics` / `product_sales_metrics` | 只**读**，用于商品页顺带显示销量；不改其采集逻辑 |
| `orders` | 完全无关，不共享表 |
| 达人邀约（`invite-*`） | 它会**引用**商品（邀约要选商品）；商品档案可供它读，但本期不改邀约流程 |
| 任务引擎 | 发布**复用**任务的步骤与门禁；但新增步骤类型必须同步登记到 `agent-step-effects.ts` |
| Agent | 只开放只读工具与"生成发布计划"；不开放执行发布 |

---

## 2. 术语

| 术语 | 含义 |
| --- | --- |
| **本地商品** | 平台无关的商品主数据（`products` + `product_variants` + `product_media`） |
| **平台商品** | 某个店铺里真实存在的商品（`product_platform_links` 的一行） |
| **归并** | 把平台商品挂到某个本地商品上（用户确认，D2） |
| **档位** | 发布的自动化程度 L1 填充 / L2 引导 / L3 接力（§7.2） |
| **交接点** | `awaiting_human`：应用填完停下，等用户在浏览器里提交（§7.4） |
| **回读** | 提交后把"用户填了什么、平台生成了什么"读回来落库（§7.5） |
| **草稿指纹** | `draft_hash`：本地商品内容哈希，用于判断"是否需要重发"与发布幂等键 |
| **熔断** | 连续失败达阈值后自动暂停该店同步，避免持续打平台（§5.4） |

---

## 3. 现状盘点（可复用资产）

| 能力 | 现有实现 | 复用方式 |
| --- | --- | --- |
| 平台适配层 | `main/platform-adapters/`：`PlatformAdapterRegistry` + 4 个 Adapter；`PlatformAdapterCapabilities` **已有 `products`/`inventory` 字段且全平台 false** | 新增 `collectProducts()`；能力位实测通过才置 true |
| 登录态门禁 | `platform-login-service.detectStoreLoginStatus`（含正向证据 `PROFILE_ANCHOR_RENDERED`） | 同步/发布前的前置门禁，非 `LOGGED_IN` 直接拒绝 |
| 结构化采集 A | `main/orders/`：`order-collection-service` + `order-repository` | 照抄"service 编排 + repository 落库"分层 |
| 结构化采集 B | `main/sales-metrics/`：`*-collection-service` + `*-repository` + `*-ledger` + `*-scheduler`（`maxParallel=2`、`circuitOpen`） | 照抄调度、并发、熔断、运行台账 |
| DOM 锚点档案 | `shared/constants/business.ts` 的 `BusinessProfile`（pageUrl / urlMarker / `anchorText` / measuredAt） | 商品档案照抄形状，继续"文案锚点而非 CSS 哈希" |
| 任务引擎 | `tasks/task-runner.ts` 步骤白名单 + `task-step-schemas.ts`（**strict zod**）+ `readTable` 的 `pickByHeader/expectHeaders/rejectHeaders/emptyOk` | 同步用只读步骤；发布用 `setInput/typeText/clickByText` |
| 副作用/幂等边界 | `shared/agent-step-effects.ts`（单一事实来源 + 集合同一性测试锁死） | 新步骤类型必须登记 |
| 确认门禁 | `waitForUserConfirmation` 步骤 + `requiresConfirmation` + `AGENT_CONFIRM_REQUIRED_ACTIONS` | 发布的人工交接点 |
| DB 约定 | `UNIQUE(platform, store_id, platform_*_id)`、金额**分**、`collected_at/source_updated_at/raw_snapshot_json`、FK CASCADE | 新表全部沿用 |
| 保留策略 | `services/retention.ts`（含 `app_settings['retention.policy']`） | 新增商品台账/图片清理项 |
| 备份 | `main/backup/`（Online Backup + 校验 + 失败回滚） | 商品库天然进备份 |
| 诊断 | `services/diagnostics.ts`（表行数 + 脱敏） | 新增商品表计数与同步健康 |
| 审计 | `services/audit-logger.writeAudit` | 三类商品事件 |
| 日志 | `services/logger.logMain`（按天 14 天） | 同步/发布结构化日志 |
| 导出经验 | `shared/invoice-csv.ts`（BOM + `escapeCsvCell` + 纯函数可测） | CSV 导入导出，含**公式注入防护** |
| 冲突哲学 | `shared/store-license.ts` 的 `decideLicenseWrite`（不覆盖、如实回报） | 商品冲突策略同源 |

**现状缺口（本方案要填的）**：商品管理页是占位（`UnifiedAppsPage.vue` 写着「商品管理数据源尚未接入」）；
`capabilities.products` 全平台 false；没有任何商品表、契约、适配器实现。

---

## 4. 领域模型

### 4.1 实体关系（文字 ER）

```
stores ──1:N── product_platform_links ──N:1── products ──1:N── product_variants
   │                    │                        │                 │
   │                    └──N:1── product_sku_links ┘                 │
   │                                        │                       │
   ├──1:N── product_sync_runs               └──1:N── product_media ─┘
   ├──1:N── product_publish_items ──N:1── product_publish_jobs ──N:1── products
   └──1:N──  (product_platform_defaults：product_id 可空 = 平台级默认)
```

核心不变式：
- 一个平台商品（`platform + store_id + platform_product_id`）**只能挂一个**本地商品；
- 一个本地商品在**同一店铺**最多有一个平台商品（防止"发重了"被当成两条合法记录）；
- 平台 SKU 与本地变体是**多对多但受约束的映射**（见 4.6）。

### 4.2 `products`（本地商品主表）

```sql
CREATE TABLE IF NOT EXISTS products (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  subtitle        TEXT,
  description     TEXT,
  brand           TEXT,
  local_category  TEXT,              -- 本地组织维度，不是平台类目
  tags_json       TEXT,
  cover_media_id  TEXT,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK(status IN ('draft','ready','published','archived')),
  draft_hash      TEXT NOT NULL,     -- 内容指纹：发布幂等键 + "是否需要重发"
  source_link_id  TEXT,              -- 从哪个平台商品"另存为本地商品"来的（可空）
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER            -- 软删：发布台账还引用它
);
CREATE INDEX IF NOT EXISTS idx_products_status   ON products(status, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_products_title    ON products(title) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_products_updated  ON products(updated_at DESC);
```

> `deleted_at` 用软删：硬删会连带把 `product_publish_items`（历史发布证据）级联掉，那是审计材料。

### 4.3 `product_variants`（本地 SKU）

```sql
CREATE TABLE IF NOT EXISTS product_variants (
  id                 TEXT PRIMARY KEY,
  product_id         TEXT NOT NULL,
  spec_json          TEXT,            -- [{"name":"颜色","value":"红"},…]
  sku_code           TEXT,
  barcode            TEXT,
  price_minor        INTEGER,
  market_price_minor INTEGER,
  stock              INTEGER,
  weight_gram        INTEGER,
  image_media_id     TEXT,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  -- 同一商品内规格组合不可重复（"红/L" 只能有一行）
  UNIQUE(product_id, spec_json),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id, sort_order);
```

### 4.4 `product_media`（图片）

```sql
CREATE TABLE IF NOT EXISTS product_media (
  id            TEXT PRIMARY KEY,
  product_id    TEXT,                 -- 可为空：平台商品的图先落库，归并后回填
  variant_id    TEXT,
  role          TEXT NOT NULL DEFAULT 'gallery'
                CHECK(role IN ('cover','gallery','detail','sku')),
  origin        TEXT NOT NULL DEFAULT 'platform'
                CHECK(origin IN ('platform','local','imported')),
  remote_url    TEXT,
  local_path    TEXT,                 -- userData/product-media/<aa>/<sha256>.<ext>
  sha256        TEXT,
  bytes         INTEGER,
  width         INTEGER,
  height        INTEGER,
  mime          TEXT,
  state         TEXT NOT NULL DEFAULT 'pending'
                CHECK(state IN ('pending','localized','failed','blocked','missing')),
  fail_reason   TEXT,                 -- 为什么没本地化（防盗链/超限/私网地址/格式不允许）
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_sha ON product_media(sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_product ON product_media(product_id, role, sort_order);
CREATE INDEX IF NOT EXISTS idx_media_state   ON product_media(state) WHERE state != 'localized';
```

> `sha256` 唯一索引 = **同图只存一份文件**（10 个商品共用一张主图 → 1 个文件、10 行记录）。
> `state='blocked'` 与 `'failed'` 分开：前者是**我们主动拒绝**（私网地址/格式不允许），后者是**下载失败**（网络/防盗链），话术不同。

### 4.5 `product_platform_links`（商品级映射，**同步幂等的关键**）

```sql
CREATE TABLE IF NOT EXISTS product_platform_links (
  id                     TEXT PRIMARY KEY,
  product_id             TEXT,        -- NULL = 平台有、本地未归并
  platform               TEXT NOT NULL,
  store_id               TEXT NOT NULL,
  platform_product_id    TEXT NOT NULL,
  -- 平台侧原值（同步回来的真相），与本地编辑值分开存
  platform_title         TEXT,
  platform_subtitle      TEXT,
  platform_status        TEXT         CHECK(platform_status IN ('on_sale','off_shelf','auditing','violation','missing','unknown')),
  platform_price_minor   INTEGER,
  platform_stock         INTEGER,
  platform_category_path TEXT,
  platform_image_count   INTEGER,
  platform_updated_at    INTEGER,
  first_seen_at          INTEGER NOT NULL,
  collected_at           INTEGER NOT NULL,
  raw_snapshot_json      TEXT,        -- 保底：整行原始表数据（参与保留策略）
  UNIQUE(platform, store_id, platform_product_id),
  -- 同一店铺里一个本地商品只允许一个平台商品（防"发重了"被当成两条合法记录）
  UNIQUE(store_id, product_id),
  FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_ppl_product ON product_platform_links(product_id);
CREATE INDEX IF NOT EXISTS idx_ppl_store   ON product_platform_links(store_id, platform_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ppl_orphan  ON product_platform_links(store_id) WHERE product_id IS NULL;
```

> `UNIQUE(store_id, product_id)` 里 SQLite 对 NULL 不去重，正好实现"未归并的可以有很多行、已归并的每店只能一行"。

### 4.6 `product_sku_links`（**SKU 级映射**，v3 新增）

为什么单独一张表：平台 SKU 会**增删和改名**（"红/L" 改成 "红色/L码"），
如果 SKU 映射塞在商品行里（比如一个 JSON 字段），任何一次 SKU 变动都会让整行失效、整条映射作废——
而实际上商品本身没变。分开存之后：商品映射稳定，SKU 映射可以逐条新增/停用。

```sql
CREATE TABLE IF NOT EXISTS product_sku_links (
  id                 TEXT PRIMARY KEY,
  link_id            TEXT NOT NULL,       -- → product_platform_links.id
  variant_id         TEXT,                -- NULL = 平台有这个 SKU，本地还没对上
  platform_sku_id    TEXT NOT NULL,
  platform_spec_json TEXT,                -- 平台侧的规格组合原文
  platform_price_minor INTEGER,
  platform_stock     INTEGER,
  state              TEXT NOT NULL DEFAULT 'active'
                     CHECK(state IN ('active','missing')),  -- missing = 平台侧没了，不删行
  collected_at       INTEGER NOT NULL,
  UNIQUE(link_id, platform_sku_id),
  FOREIGN KEY (link_id) REFERENCES product_platform_links(id) ON DELETE CASCADE,
  FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_sku_links_link    ON product_sku_links(link_id, state);
CREATE INDEX IF NOT EXISTS idx_sku_links_variant ON product_sku_links(variant_id) WHERE variant_id IS NOT NULL;
```

**SKU 对不上的三种情况，界面必须分开说**（不能都叫"缺货"）：

| 情况 | 含义 | 界面话术 |
| --- | --- | --- |
| 平台有、本地无 | 平台新增了规格 | 「平台新增规格：红/L —— [加入本地]」 |
| 本地有、平台无 | 本地新加的规格还没发布，或平台上被删了 | 「本地有、平台无：蓝/M —— [本次发布会新增]」 |
| 两边都有、价格/库存不同 | 正常差异 | 「平台 ¥99 / 本地 ¥109 —— [以平台为准] [以本地为准]」 |

### 4.7 `product_platform_defaults`（半自动"越用越自动"的来源）

```sql
CREATE TABLE IF NOT EXISTS product_platform_defaults (
  id           TEXT PRIMARY KEY,
  product_id   TEXT,                  -- NULL = 平台级默认（不区分商品）
  platform     TEXT NOT NULL,
  scope        TEXT NOT NULL CHECK(scope IN ('product','platform_default')),
  field_key    TEXT NOT NULL,         -- category_path / shipping_template / brand / after_sale …
  field_value  TEXT,
  source       TEXT NOT NULL CHECK(source IN ('human_readback','user_edit')),
  confirmed_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_defaults_key
  ON product_platform_defaults(platform, COALESCE(product_id,''), field_key);
```

### 4.8 台账三张表

```sql
CREATE TABLE IF NOT EXISTS product_sync_runs (
  id             TEXT PRIMARY KEY,
  store_id       TEXT NOT NULL,
  trigger        TEXT NOT NULL CHECK(trigger IN ('manual','schedule')),
  status         TEXT NOT NULL,   -- SUCCEEDED/PARTIAL/FAILED/LOGIN_REQUIRED/PAGE_CHANGED/SKIPPED_CIRCUIT
  reason_code    TEXT,
  fetched_count  INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  updated_count  INTEGER NOT NULL DEFAULT 0,
  missing_count  INTEGER NOT NULL DEFAULT 0,
  skipped_count  INTEGER NOT NULL DEFAULT 0,
  has_more       INTEGER NOT NULL DEFAULT 0,
  page_count     INTEGER NOT NULL DEFAULT 0,
  duration_ms    INTEGER,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  safe_message   TEXT,
  FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_store ON product_sync_runs(store_id, started_at DESC);

CREATE TABLE IF NOT EXISTS product_publish_jobs (
  id           TEXT PRIMARY KEY,
  product_id   TEXT NOT NULL,
  draft_hash   TEXT NOT NULL,     -- 发布时锁定的指纹
  mode         TEXT NOT NULL DEFAULT 'fill' CHECK(mode IN ('fill')),
  status       TEXT NOT NULL,     -- prechecking/running/awaiting_human/verifying/done/partial/failed/discarded
  created_at   INTEGER NOT NULL,
  finished_at  INTEGER
);

CREATE TABLE IF NOT EXISTS product_publish_items (
  id                  TEXT PRIMARY KEY,
  job_id              TEXT NOT NULL,
  store_id            TEXT NOT NULL,
  tier                TEXT NOT NULL CHECK(tier IN ('L1','L2','L3')),   -- 本次实际用了哪档
  status              TEXT NOT NULL,
  filled_json         TEXT,      -- 逐字段填充结果 {field: 'filled'|'filled_unverified'|'skipped'|'manual'}
  manual_field_count  INTEGER NOT NULL DEFAULT 0,   -- §7.10 的度量
  platform_product_id TEXT,
  reason_code         TEXT,
  safe_message        TEXT,
  evidence_json       TEXT,      -- 双证据结论（成功文案命中/列表回查），不含页面原文
  task_run_id         TEXT,
  updated_at          INTEGER NOT NULL,
  UNIQUE(job_id, store_id),
  FOREIGN KEY (job_id) REFERENCES product_publish_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_publish_items_pending ON product_publish_items(status) WHERE status IN ('awaiting_human','needs_review');
```

### 4.9 索引与查询模式（按 UI 反推，避免建完才发现要全表扫）

| 界面动作 | 查询 | 依赖索引 |
| --- | --- | --- |
| 商品列表（按本地商品） | `products WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT/OFFSET` | `idx_products_updated` |
| 商品列表（按平台展开） | `product_platform_links WHERE store_id=? ORDER BY platform_updated_at DESC` | `idx_ppl_store` |
| 「未归并」分组 | `product_platform_links WHERE store_id=? AND product_id IS NULL` | `idx_ppl_orphan`（部分索引） |
| 某商品的各平台状态 | `product_platform_links WHERE product_id=?` | `idx_ppl_product` |
| 上次同步 | `product_sync_runs WHERE store_id=? ORDER BY started_at DESC LIMIT 1` | `idx_sync_runs_store` |
| 未完成的发布 | `product_publish_items WHERE status IN ('awaiting_human','needs_review')` | 部分索引 |
| 未本地化图片 | `product_media WHERE state != 'localized'` | `idx_media_state`（部分索引） |

### 4.10 迁移与回滚

- 迁移版本：**v19**（`migrations.ts` 追加一个 `{version, name, up, down}`）。⚠️ 原方案写的 v18 已被 `sales_metrics_ad_spend` 占用，实施时改用 v19（2026-09-30 修正）。
- `up`：一次建 10 张表 + 索引（`CREATE TABLE IF NOT EXISTS`，幂等）。
- `down`：按依赖逆序 `DROP TABLE`（item → job → sku_links → links → defaults → media → variants → products；sync_runs 独立）。
- **图片文件不进迁移**：`down` 只删表，`userData/product-media/` 留在磁盘（下次启动由保留策略清孤儿）；
  迁移的 `down` 绝不能删用户文件——这是本项目"只删自己产出的东西"的纪律。
- 老库升级无数据迁移负担（全是新表），风险低；升级前建议自动备份（复用 `backup` 模块，M1 里挂上）。

### 4.11 容量估算与保留策略

**估算**（用于决定策略，不是精确值）

| 项 | 单件 | 1000 件 | 10000 件 |
| --- | --- | --- | --- |
| `products` + variants 行 | ~1KB | 1MB | 10MB |
| `product_platform_links`（4 平台） | ~1.5KB × 4 | 6MB | 60MB |
| `raw_snapshot_json`（每行原文） | ~2KB × 4 | 8MB | 80MB |
| 图片（8 张/商品，200KB/张，去重后按 0.7 计） | ~1.1MB | 1.1GB | 11GB |
| **结论** | | 图片是主要成本 | **必须有上限与清理** |

**保留策略**（追加到 `retention.ts` 的 policy，全部可在设置里关）：

| 项 | 默认 | 理由 |
| --- | --- | --- |
| `raw_snapshot_json` 保留 | 最近 3 次同步 | 仅供差异对比，留多了没意义 |
| `product_sync_runs` | 90 天 | 排障材料 |
| `product_publish_items` | **永不自动删** | 发布证据/审计，用户可手动清 |
| 孤儿图片文件（无 `product_media` 引用） | 启动时扫描，90 天后删 | 同 `pruneOrphanStorePartitions` 的思路 |
| 图片缓存总量上限 | 默认 5GB，超限提示用户（**不静默删**） | 静默删用户商品图是不可接受的 |

---

## 5. 同步（拉取）设计

### 5.1 契约

```ts
// packages/shared/src/contracts/platform-product.ts（新增）
export interface PlatformProductCollectionOptions {
  maxPages: number
  maxProducts: number
  timeoutMs: number
  sinceMs?: number          // 增量：不支持增量的平台如实忽略
}

export interface PlatformProductSku {
  platformSkuId: string
  spec: Array<{ name: string; value: string }>
  priceMinor: number | null
  stock: number | null
  skuCode: string | null
  imageUrl: string | null
  state: 'active' | 'missing'
}

export interface PlatformProduct {
  platformProductId: string
  title: string
  subtitle: string | null
  status: 'on_sale' | 'off_shelf' | 'auditing' | 'violation' | 'unknown'
  priceMinor: number | null
  stock: number | null
  categoryPath: string | null
  imageUrls: string[]
  skus: PlatformProductSku[]
  platformUpdatedAt: number | null
  rawRow?: string[]         // 保底原文（落 raw_snapshot_json，参与保留策略）
}

export interface PlatformProductCollectionResult {
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'LOGIN_REQUIRED' | 'PAGE_CHANGED' | 'DATA_SOURCE_NOT_VERIFIED'
  products: PlatformProduct[]
  fetchedCount: number
  skippedCount: number
  pageCount: number
  hasMore: boolean          // 达上限截断 → 界面如实提示"还有更多"
  reasonCode: string
  safeMessage: string
}
```

`PlatformAdapter` 增加可选方法（能力位为真才允许有实现）：

```ts
collectProducts?(context: PlatformAdapterContext, options: PlatformProductCollectionOptions): Promise<PlatformProductCollectionResult>
```

### 5.2 商品档案 `ProductProfile`（形状照抄 `BusinessProfile`）

```ts
export interface ProductFieldAnchor {
  field: ProductFieldKey          // title / price / stock / status / sku / image / category
  anchorText: string              // 实测的页面文案（不用 CSS 哈希）
  verified: boolean               // 是否真机验证过（档位推导的唯一依据）
  deep?: boolean
  valueMaxLen?: number
}

export interface ProductProfile {
  platform: string
  listUrl: string
  urlMarker: string
  deep?: boolean
  // 表格型列表（优先，复用 readTable 的成熟能力）
  tableSelector?: string
  pickByHeader?: string
  headerMap?: Record<string, ProductColumnKey>
  expectHeaders?: string[]        // 方向/表校验（复用发票中心那套思路）
  // 卡片型列表（无表格时）
  cardAnchors?: ProductFieldAnchor[]
  fields: ProductFieldAnchor[]
  pagination: 'none' | 'nextText' | 'scroll'
  nextPageText?: string | null
  pageSize: number
  measuredAt: string
  measuredCount: number
  note?: string
}
```

**能力位纪律**：`capabilities.products` 只有在"该平台商品档案真机跑通一轮、条数与页面一致"之后才置 `true`。
在此之前界面如实显示「该平台尚未实测到商品列表，暂不能同步」——**不拿猜的选择器去试**。

### 5.3 同步管线（九步，每步可单独失败并如实上报）

```
1. 前置门禁   detectStoreLoginStatus → 非 LOGGED_IN 直接 LOGIN_REQUIRED（不抓登录页）
2. 熔断检查   连续失败 ≥ 阈值 → SKIPPED_CIRCUIT（不静默，界面显示"已暂停，原因…"）
3. 建轮次     product_sync_runs 落一行 status='running'
4. 逐页采集   navigate → waitForPage → readTable(pickByHeader/expectHeaders)
              → 表头失配 → PAGE_CHANGED 立即停止（不写任何数据）
5. 规范化     金额→分；库存→整数；状态→五态枚举（判不出一律 unknown）；SKU 规格归一化
6. 事务 UPSERT 一个事务内：links + sku_links + 缺失标记（见 5.5）
7. 图片入队   不阻塞主流程，落 product_media(state='pending')
8. 收尾       写回 runs（计数/耗时/hasMore）；更新熔断计数；写审计
9. 异步图片   队列按店铺串行下载（见 5.9）
```

### 5.4 并发、限速、预算、熔断

| 维度 | 口径 | 对齐现有实现 |
| --- | --- | --- |
| 单店 | **串行**（同一店铺同时只有一个同步轮次） | `sales-metrics` 同款 |
| 跨店 | 最多 **2 并发** | `sales-metrics-scheduler` 的 `maxParallel=2` |
| 页间 | 每页之间 **随机 600–1500ms** | 给平台留余量，避免风控 |
| 单轮预算 | `maxPages`（默认 20）/ `maxProducts`（默认 500）/ `timeoutMs`（默认 120s） | 任一触顶 → `hasMore=true` 如实提示 |
| 熔断 | 连续失败 **3** 次 → 暂停该店自动同步；界面显示"已暂停（连续 3 次失败：登录取不到/页面改版）"+「重试一次」 | `circuitOpen` 语义 |
| 手动同步 | **不受熔断限制**（用户显式要求就试一次），但仍按单店串行 | 与调度区分 |

> 为什么限速要写进方案：这个应用是在**用户真实店铺**上跑，触发平台风控的代价是用户的账号。宁可慢。

### 5.5 事务与幂等

- 一轮同步的**全部写库操作在一个事务里**（`better-sqlite3` 的 `db.transaction`）：
  - 任一页失败 → 整轮回滚（不留"半轮"数据），`runs` 写 `PARTIAL` 并说明停在第几页；
  - 例外：`runs` 行本身在事务外先写（否则失败时没有台账可查）。
- UPSERT 语义（`INSERT ... ON CONFLICT(platform,store_id,platform_product_id) DO UPDATE`）：
  - 已存在 → `updated_count++`；
  - 不存在 → `inserted_count++`；
  - 内容完全一致（`raw_snapshot_json` 相同）→ `skipped_count++`，**不写库**（减少 WAL 增长）。
- 本轮**没出现**的平台商品 → `platform_status='missing'`（不删行，见 D3 同源哲学）。
- `missing` 的商品在下次出现时**自动复活**（`missing → 原状态`），并在界面上标"回归"。

### 5.6 规范化的"不猜"规则

| 字段 | 规则 | 判不出时 |
| --- | --- | --- |
| 价格 | 去货币符号/千分位 → **分为单位整数**；多 SKU 时取最小值展示、明细存各行 | `NULL`（界面显示"—"，不显示 0） |
| 库存 | 纯数字；"充足"/"999+" 这类文案 → **不解析**，标 `unknown` | `NULL` + 界面标"库存未取到" |
| 状态 | 只在命中实测文案时才映射五态（在售/下架/审核中/违规/未知） | `unknown` |
| 规格 | 按平台的分隔符（多为 `;` 或空格）拆 `name:value`；拆不出就整串作为一个规格值 | 原样保留，界面显示原文 |
| 类目 | 原样保留平台给的路径串 | 原文 |

**绝不**做的兜底：把读不到的库存当 0（会误导运营补货）、把审核中当在售。

### 5.7 增量与差异

- 优先用列表页的"更新时间"列（若平台提供）做 `sinceMs` 增量；
- 不支持增量的平台：全量拉取 + 与 `raw_snapshot_json` 做行级 diff，无变化则 `skipped`；
- **增量只影响"要不要写库"，不影响"能不能发现缺失"**：增量轮次不做 `missing` 标记
  （没拉到的范围外商品不能算消失），只有全量轮次才标 `missing`——这条必须写进代码注释，极易搞错。

### 5.8 冲突策略矩阵（平台值 vs 本地值）

| 场景 | 平台值 | 本地值 | 策略 |
| --- | --- | --- | --- |
| 本地未归并 | 有 | 无 | 正常写入 link |
| 本地已归并、只有平台变 | 变 | 未改 | 更新 `platform_*` 原值，**不动本地**，标"平台有更新" |
| 两边都变且不同 | 变 | 改过 | 标 `divergent`，界面把两边摆出来让用户选（**不自动合并**） |
| 平台商品消失 | `missing` | 有 | 不删本地；界面提示"平台上已不存在"[标记为已下架] |
| 平台商品复活 | 有 | 有 | 自动复活 link，标"回归" |

### 5.9 图片本地化（含安全，这是最容易出问题的一节）

**流程**：入队 → 校验 → 下载 → 校验 → 落盘 → 去重 → 写库。

**安全校验（`remote_url` 是不可信输入，来自页面）**：

| 风险 | 防护 |
| --- | --- |
| **SSRF**（图片 URL 指向内网/本机） | 只允许 `http/https`；解析主机名后**拒绝私有网段/环回/链路本地/保留地址**（含 IPv6）；重定向最多 3 跳且每跳重新校验 |
| 路径穿越 | 落盘路径**只由 sha256 生成**，与 remote_url 无关；文件名不含任何用户输入 |
| 超大文件 | 单张上限 **10MB**（Content-Length + 流式计数双保险），超限标 `failed(reason=too_large)` |
| 格式伪装 | 读 **magic bytes** 判真实类型，只接受 jpg/png/webp/gif；**明确拒绝 SVG**（可含脚本，且本项目会渲染这些图） |
| 解压炸弹 | 用 `image-size` 之类只读头部的方式取尺寸，不整体解码；尺寸上限 10000×10000 |
| 防盗链 | 优先带该店铺页面的 `Referer`；仍 403 则标 `failed(host_referer)`，界面显示"未本地化（防盗链）" |
| 慢速攻击 | 单张总超时 20s，超时标 `failed(timeout)` |
| 磁盘写满 | 写前检查可用空间；不足则暂停队列并在界面提示（不是静默失败） |

**并发**：图片下载 **每店串行、跨店 2 并发**（与同步同口径），失败重试 1 次后放弃（不无限重试）。

**去重**：落盘前算 sha256，已存在则只写一行 `product_media`（`local_path` 复用），不重复下载。

### 5.10 错误分类学（同步）

| reasonCode | 触发 | 用户话术 | 可重试 | 需用户操作 |
| --- | --- | --- | --- | --- |
| `LOGIN_REQUIRED` | 未登录/会话过期 | 「店铺未登录，请先在浏览器里登录」 | ✅ 登录后 | ✅ |
| `VERIFY_REQUIRED` | 平台要安全验证 | 「平台要求安全验证，请在浏览器里完成」 | ✅ | ✅ |
| `PAGE_CHANGED` | 表头/锚点失配 | 「平台页面已改版，本平台同步暂时不可用（已如实停止，未写入数据）」 | ❌（等适配） | ❌ |
| `DATA_SOURCE_NOT_VERIFIED` | 该平台商品档案未实测 | 「该平台尚未实测到商品列表，暂不能同步」 | ❌ | ❌ |
| `TIMEOUT` | 超预算 | 「同步超时，已拉取前 N 件」 | ✅ | ❌ |
| `CIRCUIT_OPEN` | 连续失败熔断 | 「已暂停自动同步（连续 3 次失败）」+[重试一次] | 手动 | ✅ |
| `RATE_LIMITED` | 平台限流文案命中 | 「平台提示访问过于频繁，已暂停」 | ✅（延后） | ❌ |
| `IMAGE_BLOCKED` | 图片被安全策略拒绝 | 「有 N 张图片未本地化（原因）」 | ❌ | ❌ |
| `INTERNAL` | 其它 | 「同步失败，详见日志」+ 审计 | ✅ | ❌ |

### 5.11 调度

- 每店一条"商品同步计划"（`app_settings` 或复用 `sales_collection_plans` 的表结构思路），**默认关闭**，用户开启；
- 默认间隔 **6 小时**（商品变动远慢于订单/经营数据）；
- 「最近一次同步」的显示口径与发票中心一致：取**最近一次运行**再看它的状态，
  失败信息**只挂最近一次**（避免"早已被后续成功覆盖的旧失败"一直挂着——这是发票中心踩过的坑）。

---

## 6. 本地商品库

### 6.1 统一商品模型

| 分区 | 字段 |
| --- | --- |
| 基础 | 标题（按各平台最严上限 60 字）、副标题、描述、品牌 |
| 媒体 | 主图 1 张、图集 N 张、详情图 N 张（本地化后拖拽排序） |
| SKU | 规格组（颜色/尺码）× 组合 → 价格/库存/条码/重量/图 |
| 物流售后 | 重量、发货时效、运费模板名、售后政策（逐平台登记） |
| 平台附加 | 类目路径、资质、白底图要求（**逐平台存**在 `product_platform_defaults`，不塞公共字段） |

### 6.2 校验规则（单一实现，主进程与渲染层共用）

```ts
export function productDraftIssues(product: ProductDraft, target: PublishTargetProfile): ProductDraftIssue[]
// ProductDraftIssue = { level: 'blocker'|'warning'|'info'; field: ProductFieldKey; message: string; fixHint?: string }
```

规则示例（**逐条对应真机实测结论，未实测的一律不写规则**）：

| 级别 | 示例 |
| --- | --- |
| blocker | 标题为空 / 无主图 / 无可售 SKU / 价格 ≤ 0 / 类目未选（当平台强制类目时） |
| warning | 该平台不支持副标题（会丢弃）/ 图片少于平台最低要求 / 标题超长（会截断） |
| info | 本地价格与平台当前价不同（发布后会覆盖）/ 该 SKU 平台上已存在 |

界面在发布前**逐条列出**，`blocker` 阻断发布，`warning` 需要用户勾选"我知道了"。

### 6.3 归并（平台商品 → 本地商品）

- 默认状态：平台商品 `product_id IS NULL`，界面单独分组「平台上发现、本地还没有归属」；
- **建议而非自动**（D2）：按"标题归一化 + 主图 sha256"给候选，用户点「并入」才写映射；
- 归并时解析 SKU：能按规格组合对上的自动建立 `product_sku_links`，对不上的逐条列出让用户处理；
- 反向操作「另存为本地商品」：把平台商品复制成本地商品（`source_link_id` 记来源），用于"以平台某个商品为模板"。

### 6.4 导入导出

- CSV（UTF-8 BOM + 正确转义，直接复用 `escapeCsvCell` 的经验）；
- **公式注入防护**：以 `= + - @` 开头的文本单元格加前缀（发票审查里发现的问题，不在新模块重犯）；
- 变体展开成多行（`product_id` 列重复）；
- 导入流程：解析 → **预览 diff**（新增/更新/冲突）→ 用户确认 → 单事务落库；
- 图片列：导出为本地路径或远端 URL（可配），导入时不自动下载（避免导入大 CSV 时疯狂打网络）。

### 6.5 批量操作

批量改价（按百分比/固定值）、批量加标签、批量归档、批量发布（见 §7.8）。
所有批量操作**先出预览**（影响 N 个商品、变化明细），确认后执行，并写审计（只记计数）。

---

## 7. 发布（写入）设计：半自动化

### 7.1 三段式

```
① 预填（全自动）   应用把本地商品里该有的字段全部填进平台表单
② 把关（人工）     用户核对、补缺、自己点"提交/发布"
③ 回读（全自动）   读回"用户实际填了什么、平台生成了什么商品"→ 落库
```

**分界点必须固定且可见**，不是"能自动就自动、不能就甩给用户"。

### 7.2 三档模式（推导，不许手写）

| 档 | 名称 | 应用做什么 | 用户做什么 | 适用条件 |
| --- | --- | --- | --- | --- |
| **L1** | 填充 | 打开发布页 → 逐字段填值 → 能自动的图片上传 → 停下等你 | 核对、补缺、点提交 | 该平台**字段锚点已实测登记** |
| **L2** | 引导 | 打开页面 + 应用侧列"逐字段核对清单"（不写值） | 照清单自己填、自己提交 | 发布页已实测但**字段锚点不全** |
| **L3** | 接力 | 只打开页面 + 记录开始/结束 | 全程手动 | 该平台**未实测** |

档位由 `ProductPublishProfile.fields[].verified` 推导：

```
verifiable = fields.filter(f => f.verified).length
tier = verifiable === fields.length ? 'L1' : verifiable > 0 ? 'L2' : 'L3'
```

**不允许手写"我是 L1"**——杜绝"声明了自动化其实填不进去"（本项目"能力位不许撒谎"的纪律）。

### 7.3 自动/人工分工矩阵

| 步骤 | 归谁 | 关键约束 |
| --- | --- | --- |
| 打开发布页 | 🤖 | 地址须实测登记 |
| 选类目 | 🤖 建议 + 👤 确认 | 可自动点，但**必须停在下拉已展开**由用户确认；第二次起用回读值做默认建议 |
| 标题/副标题/描述 | 🤖 | 不支持的字段标 `warning` 并列出，**不静默丢弃** |
| 价格/库存 | 🤖 | 分→元字符串；**填完必须回读校验**（平台可能补 `.00`） |
| SKU 规格 | 🤖（实测支持时） | 不支持则降级为单 SKU + `warning` |
| 图片上传 | 🤖（入口可控时） | 否则标"需人工上传"并**按顺序列出该传哪几张** |
| 物流模板/运费 | 🤖 用上次选择 / 👤 首次 | 同"选类目" |
| 资质/品牌 | 👤 | 涉及证照，一律不代填 |
| **最终提交** | 👤 **不可配置** | §7.9 |
| 结果核对 | 🤖 | 双证据 |
| 回读与沉淀 | 🤖 | §7.5 |

**"🤖"也不是无脑填**：每个字段填完要能**读回校验**；读不回 → `filled_unverified`，
**在核对清单里醒目列出**让用户多看一眼，而不是假装成功。

### 7.4 单店发布状态机

```
prechecking ──失败──→ precheck_failed
     │
     └─通过─→ filling ──部分失败──→ fill_partial（逐字段列出没填上的）
                 │
                 └─→ awaiting_human  ←—— 人工交接点（浏览器已停在填好的页面）
                        ├ 「放弃」      → discarded（页面留在原处，不提交）
                        ├ 「暂停」      → 保持 awaiting_human（可过夜）
                        └ 「我已提交」  → verifying
                                            ├ 双证据一致 → confirmed
                                            └ 不一致     → needs_review
```

**中断与恢复**
- `awaiting_human` 可以过夜；应用重启后 item 仍在；
- 界面出现「继续上次未完成的发布」→ **不重放填充步骤**（副作用类型被 `AGENT_NON_RESUMABLE_STEP_TYPES` 拦住），
  直接回到核对清单；
- 门禁步骤超时（默认 1 小时，可配）→ **不自动提交、不自动放弃**，停在 `awaiting_human`。

### 7.5 回读闭环（"越用越自动"）

提交后（`verifying`）三类**只读**回读：

1. **平台商品标识**：列表回查该标题 → 读 `platform_product_id` / `platform_sku_id` →
   写 `product_platform_links` + `product_sku_links`（**SKU 级也要落**，否则下次发布无法判断哪些规格已存在）；
2. **用户实际填的值**：读回发布页关键字段，与本地对比：
   - 本地没有、用户填了 → 建议写入 `product_platform_defaults`（**需用户确认**）；
   - 本地有、用户改了 → 摆两边让用户选是否回写本地（不自动改，避免"这次特批"变成默认值）；
3. **该平台必填字段清单**：把"发布页必填但本地没有"的字段记下来，下次发布前**在本地补全清单里提示**。

### 7.6 字段级 diff（发布前必须给用户看的表）

发布预检时生成三列对比，逐字段呈现：

```
字段            本地值        平台当前值     上次发布值    本次动作
标题            真皮沙发…     （无）         —            填入
价格            ¥1299         （无）         —            填入
库存            20            （无）         —            填入
类目            家居>沙发      （无）         —            建议填入，待你确认
运费模板        包邮          （无）         包邮          用上次选择
副标题          进口头层牛皮   —             —            该平台不支持 → 跳过（warning）
```

这张表同时是**核对清单**的数据源——用户看一张表就够了，不需要在浏览器里逐项找。

### 7.7 幂等与重复防护

| 风险 | 防护 |
| --- | --- |
| 任务重试重复填充/提交 | `click*` 步骤 `retryLimit` 强制 0（`normalizeStepRetryLimit`）；发布步骤全部登记进 `AGENT_SIDE_EFFECT_STEP_TYPES` |
| 用户手滑点两次"发布" | `idempotencyKey = publish:<productId>:<storeId>:<draftHash>`；同键在途直接返回既有 item |
| 恢复时重放前序步骤 | 副作用 → `AGENT_NON_RESUMABLE_STEP_TYPES`；配合 §7.4 的续做入口 |
| 用户在浏览器里点了两次提交 | 回读时若列表回查出**两条同标题** → `needs_review` + 如实提示"疑似重复提交" |
| 已发布过的商品被再发 | 预检 `product_platform_links`；`draft_hash` 未变 → 默认拒绝，提示"与上次完全一致" |
| 同店同商品并发两次发布 | DB 层 `UNIQUE(job_id, store_id)` + 预检查在途 job |
| 部分店铺失败 | 每店独立 item，互不影响；**不做整体回滚**（平台侧无法可靠回滚） |

### 7.8 批量发布的节流与编排

- 单次批量上限：**20 店 × 20 商品 = 400 个 item**；
- 编排：**一次只打开一个店铺**（复用 `openStoreBrowser`，避免多店同时开页面与内存压力）；
- 人工交接在批量下的形态：逐店进入 `awaiting_human` → 用户可「处理这家」「跳过这家先做下一家」「全部暂停」；
- 已完成的店不受影响；中止后未开始的 item 保持 `pending`，可续跑；
- 进度条必须显示"已完成 / 待人工 / 失败"三个数，而不是一个百分比。

### 7.9 不可配置的人工边界
- 应用里**不提供**"自动提交"开关；
- Agent 只给 `preparePublishPlan`（生成计划），**不给** `executePublish`；
- 依据：`docs/FUNCTIONAL_SPEC.md:7`「发布商品」属必须由用户在浏览器内最终确认的高风险动作；
  且平台侧没有可靠的批量撤回。

> 例外条款：若将来某平台提供**幂等且可撤回**的官方开放接口，可为那条路径单独开"可信自动提交"——
> 那是另一个特性，不是本方案的兑现方式。

### 7.10 度量（写进验收）

| 指标 | L1 目标（第 2 次起） |
| --- | --- |
| 手动填写字段数 | ≤ 1 |
| 手动上传图片数 | 0 |
| 全程点击 | ≤ 3（确认类目 → 点提交 → 回来点「我已提交」） |

发布完成后如实显示：「本次你手动填了 2 项（类目、运费模板）· 已记为默认，下次自动」。
**做不到这个数就说明半自动没做出来。**

---

### 7.11 静默失效：本模块踩过的五种形态与防线（2026-10-01 补）


这个模块反复被同一类 bug 咬：**"看起来做了，其实没做，而且不报错"**。它比抛异常危险得多——
抛异常会有人去查，静默失效会一路走到用户面前变成"界面在撒谎"。

**已实测踩到的五种形态**（每种都有真实案例）：

| 形态 | 案例 | 为什么难查 |
| --- | --- | --- |
| **过滤了一个不存在的值** | 「全部暂停」的 SQL 写 `status = 'in_progress'`，而台账里"正在跑"叫 `prechecking/filling/fill_partial/verifying` → 永远命中 0 行 | 返回"0 条"，看起来像"本来就没有"，不像错误 |
| **强转两套不同名的词表** | `batchProgressFor` 把台账 status `as` 强转成规则层 `BatchItemState`，而台账的失败叫 `precheck_failed`、规则层数的是 `failed` → **失败项被漏统计，界面显示"失败 0"** | 类型检查通过（`as` 绕过了），进度数字看起来正常 |
| **读不到 ShadowRoot 就当成"没有"** | `document.querySelectorAll` / `DOM.querySelectorAll` / `document.body.innerText` 都不穿透 ShadowRoot；微信后台整页在 ShadowRoot 里 → 查到"0 个"、等到"表单没渲染"、误判"弹窗已关" | "空结果"和"真没有"长得一模一样 |
| **输入事件投递到了视口外/遮罩下** | `dispatchMouseEvent` 只往视口内投递；坐标越界（`y=863` vs 视口 704px）或弹窗遮罩盖着时，点击**静默无效** | 不报错、不抛异常，页面毫无反应 |
| **兜底把真实异常吞成一句套话** | IPC 兜底 catch 只返回"商品操作失败"，**日志里也没有堆栈** | 界面上只有五个字，排查时一点线索都没有（实测为此多花一整轮）；加上日志后**一次**就拿到真因 `Error: Browser not open for this store` |

**五条防线**（按性价比排序）：

1. **词表收敛到一处** —— `packages/shared/src/product-status.ts`。状态名只许从这里取，
   仓储 SQL 只许用词表里的名字。
2. **源码扫描测试兜底** —— `tests/unit/product-status-vocabulary.test.ts` 断言"仓储 SQL 里出现的
   状态名必须全在词表里"。**已实测验证它能抓住那个 bug**（把 SQL 改回 `in_progress` 会立刻失败）。
3. **显式映射，且 `default` 走保守分支** —— `toBatchItemState()` 认不出来的状态**按 `failed` 处理**。
   口径：**宁可多报一个失败让人去看，也不要悄悄吞掉**。
4. **真机验收只能靠截图** —— 前两种形态可以靠测试兜底，后两种（DOM/输入事件）**没有静态办法**，
   唯一可靠的判断是**截图看一眼**。本项目里"截图看一眼"已经解决过三次卡住很久的问题。
5. **兜底错误必须留日志** —— 可以给用户一句笼统的话，但**真实异常与堆栈必须进日志**。
   否则任何异常都会退化成"操作失败"，等于**系统性丢失错误信息**。

> 一条经验：**凡是"点了没反应"的现象，先怀疑这五种形态，不要怀疑平台**。
> 本项目里所有"平台时好时坏"的判断，最后都被证明是我自己这边的静默失效。

## 8. UI 规格

### 8.1 页面结构（替换 `UnifiedAppsPage.vue` 的商品管理分支）

```
┌ 左：店铺/平台筛选 ─┬─ 中：商品区 ───────────────────────┬─ 右：详情 / 发布抽屉 ┐
│ 全部 / 各平台      │ [同步商品] 上次同步：3 分钟前 ✓     │ 商品编辑            │
│ ☑ 1111（抖店）     │ ┌ 分组：本地商品 ┐                  │  标题/价格/库存     │
│ ☑ 慕么美（拼多多） │ │ 表格：图/标题/价/库存/状态/平台 │  图片（本地化状态） │
│ ☑ 微信小店测试     │ └────────────────┘                  │  SKU 表 + 规格差异  │
│ ☑ 福气满满（快手） │ ┌ 分组：平台上发现、本地无归属 ┐    │ ── 发布（半自动）── │
│                    │ │ [并入本地] [另存为本地商品]   │    │ 目标店铺（多选）    │
│ 未实测：快手       │ └────────────────┘                  │ 字段级 diff 表      │
│  （商品列表）      │ 分组：图片未本地化 N 张 [重试]      │ 档位 L1/L2/L3       │
└────────────────────┴─────────────────────────────────────┴─────────────────────┘
```

### 8.2 状态矩阵（每个状态都要有明确话术，不能只有"加载中/空"）

| 状态 | 界面表现 |
| --- | --- |
| 未同步过 | 「还没有同步过商品」+[同步商品] |
| 同步中 | 进度（第 N 页 / 已拉 M 件）+ 可中止 |
| 同步成功 | 「上次同步 3 分钟前 · 新增 0 / 更新 12 / 平台上消失 1」 |
| 部分成功 | 「本次只同步了前 200 件（还有更多）」+[继续同步] |
| 未登录 | 「店铺未登录」+[去登录]（复用发票中心的登录态入口） |
| 页面改版 | 「平台页面已改版，同步已停止且**未写入任何数据**」 |
| 未实测平台 | 「该平台尚未实测到商品列表，暂不能同步」 |
| 熔断 | 「已暂停自动同步（连续 3 次失败）」+[重试一次] |
| 无商品 | 「该店铺平台上有 0 个商品」（与"没同步到"区分） |

### 8.3 关键交互

- 商品列表：分页 50/页（>2000 件时启用虚拟滚动）；图片懒加载；
- 归并：拖拽或按钮，**必须确认**；归并后给出"已建立 N 条 SKU 映射、M 条待处理"；
- 发布抽屉：目标店铺多选 → 逐店预检结果（档位/缺项/已发布过）→ 生成发布任务；
- **核对清单**（§9 的核心界面）：

```
✓ 标题        已填   「真皮沙发…」            [在页面中定位]
✓ 价格/库存   已填   ¥1299 / 20
⚠ 类目        待你确认（已展开，建议：家居>沙发）
✗ 图片        需你上传（3 张，按顺序）：cover.jpg / a.jpg / b.jpg
○ 运费模板    用上次选择：包邮
[ 我在浏览器里提交好了 ]  [ 放弃 ]  [ 暂停，稍后继续 ]
```

### 8.4 必说不可的话术清单（"如实说明"是本项目的界面风格）

- 「该平台尚未实测到商品列表，暂不能同步」
- 「本次只同步了前 200 件，还有更多」
- 「有 3 张图片未本地化（防盗链）」
- 「该平台不支持副标题，本次已跳过」
- 「需要人工选择类目」
- 「本次以 L3 接力模式打开页面（该平台发布页未实测）」
- 「发布结果待核对」（附两条证据的实际结论）
- 「上次有一次未完成的发布」+[继续]
- 「疑似重复提交，请到平台确认」

---

## 9. 安全与合规

| 面 | 措施 |
| --- | --- |
| 读/写分离 | 同步步骤全部只读（`isSideEffectStepType` 全 false），可在 `storeScope.readOnly` 下跑；发布必含 `waitForUserConfirmation` |
| 高风险动作登记 | 「发布商品」加入 `AGENT_CONFIRM_REQUIRED_ACTIONS` / `softwareActionNeedsApproval`；`custom-task.ts` 的"提交类动作前必须有门禁"校验继续生效 |
| Agent 边界 | 只读工具 `syncProducts` / `listProducts` + `preparePublishPlan`（只出计划）；**无** `executePublish` |
| 图片安全 | SSRF/私网拒绝、路径只由 sha256 生成、10MB 上限、magic bytes、**拒绝 SVG**、重定向 ≤3 跳（§5.9） |
| 隐私 | 商品数据不含买家信息；`raw_snapshot_json` 参与保留；诊断包不含商品原图与价格明细 |
| 审计 | `product.sync` / `product.publish.prepare` / `product.publish.confirm`（只记计数与结果码） |
| 反风控 | 限速、每店串行、随机停顿、熔断（§5.4）；**不做"越夜越猛"的批量拉取** |
| 批量上限 | 400 item/次 + 明显的进度与中止入口 |
| 本地数据 | 商品库进已有备份流程；导出走用户显式操作 |

---

## 10. 性能与容量

| 关注点 | 结论/措施 |
| --- | --- |
| 列表查询 | 全部走 §4.9 的索引；禁止 `LIKE '%x%'` 全表扫（搜索走标题前缀索引或 FTS） |
| 大批量 UPSERT | 单事务 + prepared statement 复用；跳过无变化行（§5.5） |
| WAL 增长 | `raw_snapshot_json` 保留 3 轮；批量写后 `wal_checkpoint(TRUNCATE)` 视情况 |
| 图片 | 懒加载 + 本地文件优先；列表只查 `cover_media_id`，不联查全部图 |
| 渲染 | 50/页分页；>2000 行启用虚拟滚动；发布清单不渲染全量商品 |
| 调度 | 跨店 2 并发；图片队列与同步队列分离（图片慢不拖同步） |
| 容量 | §4.11 估算：图片是主要成本 → 5GB 软上限 + 孤儿清理 + 超限**提示不静默删** |

---

## 11. 可观测性

| 面 | 做法 |
| --- | --- |
| 日志 | `logMain` 结构化：`{platform, storeId, operation: 'collectProducts', page, fetched, duration, result, reasonCode}`（不含商品原文） |
| 审计 | 三类事件（§9） |
| 健康面板 | 新增「商品同步健康」卡片：每店 上次成功时间 / 连续失败次数 / 熔断状态 / 未本地化图片数 / 未完成发布数 |
| 诊断包 | `diagnostics.ts` 增加 10 张商品表的行数统计（只计数，不含内容） |
| 度量 | §7.10 的人工操作计数、滑动的同步成功率（近 20 次） |

---

## 12. 错误码表（新增，统一前缀 `PRODUCT_`）

| 码 | 场景 | 可重试 | 用户可见话术 |
| --- | --- | --- | --- |
| `PRODUCT_SYNC_LOGIN_REQUIRED` | 未登录 | ✅ | 请先登录该店铺 |
| `PRODUCT_SYNC_VERIFY_REQUIRED` | 需安全验证 | ✅ | 请在浏览器里完成验证 |
| `PRODUCT_SYNC_PAGE_CHANGED` | 锚点失配 | ❌ | 平台已改版，已停止且未写入数据 |
| `PRODUCT_SYNC_UNVERIFIED_PLATFORM` | 未实测 | ❌ | 该平台尚未实测到商品列表 |
| `PRODUCT_SYNC_TIMEOUT` | 超预算 | ✅ | 已拉取前 N 件 |
| `PRODUCT_SYNC_CIRCUIT_OPEN` | 熔断 | 手动 | 已暂停自动同步 |
| `PRODUCT_PUBLISH_TIER_L3` | 未实测平台 | ❌ | 以接力模式打开页面 |
| `PRODUCT_PUBLISH_FIELD_UNSUPPORTED` | 平台不支持该字段 | ❌ | 已跳过（warning） |
| `PRODUCT_PUBLISH_FILL_UNVERIFIED` | 填了读不回 | ⚠️ | 请重点核对这几项 |
| `PRODUCT_PUBLISH_DUPLICATE_BLOCKED` | 草稿未变 | 手动 | 与上次完全一致，无需重发 |
| `PRODUCT_PUBLISH_NEEDS_REVIEW` | 双证据不一致 | ⚠️ | 发布结果待核对 |
| `PRODUCT_PUBLISH_SUSPECT_DUPLICATE` | 疑似重复提交 | ⚠️ | 请到平台确认是否发重 |
| `PRODUCT_MEDIA_BLOCKED` | 图片被安全策略拒绝 | ❌ | 有 N 张图片未本地化（原因） |
| `PRODUCT_DB_CAPACITY` | 磁盘不足 | 手动 | 磁盘空间不足，已暂停图片下载 |

---

## 13. 测试与验收矩阵

### 13.1 单元测试（纯函数）

| 主题 | 断言要点 |
| --- | --- |
| 字段映射 | 各平台列名 → 统一字段；未知列进"其他"不丢 |
| 规范化 | 金额→分；"充足"→ null 而非 0；状态映射只在实测文案命中时成立 |
| `productDraftIssues` | blocker/warning/info 分级正确；不支持字段不静默丢 |
| `buildPublishSteps` | 步骤序列含门禁；**不含**提交动作；字段缺失时正确标 manual |
| 档位推导 | 锚点未实测→L3；部分→L2；全实测→L1；**不可能声明 L1 却填不进去** |
| 发布状态机 | 非法迁移被拒（如 `filling→confirmed`） |
| 幂等键 | 同商品同店同 draft_hash 得到同键 |
| CSV | 往返一致；公式注入前缀 |
| 图片安全 | 私网 URL 被拒；SVG 被拒；超限被拒；sha256 去重 |

### 13.2 契约与一致性测试

- `capabilities.products === true` ⟺ 适配器真有 `collectProducts` 且档案 `measuredAt` 非空
  （照抄 `pdd-sales-metrics-profile.test.ts` 的"声明与实现一致"断言）；
- 发布步骤类型全部登记进 `AGENT_SIDE_EFFECT_STEP_TYPES`（集合同一性，照抄 `agent-step-effects.test.ts`）；
- **源码级断言**：应用里不存在"自动点提交"的代码路径（照抄 `webview-embedding-boundary.test.ts` 的做法）。

### 13.3 真机验收（`tools/acceptance/product-*.js`）

| 脚本 | 验什么 | 期望 |
| --- | --- | --- |
| `product-sync-verify.js` | 真机同步一轮 | 本地条数 = 页面条数；重复同步 inserted=0 |
| `product-sync-negative.js` | 未登录 / 改版 / 半页 | 未登录不写数据；改版标 `PAGE_CHANGED` 且不写脏数据 |
| `product-media-verify.js` | 图片本地化 | 同图只落一份；防盗链如实标 failed |
| `product-publish-fill.js` | L1 填充 | 逐字段读回一致；不一致项标 unverified |
| `product-publish-resume.js` | 中断续做 | 重启后不重放填充步骤，直接回核对清单 |
| `product-publish-readback.js` | 回读闭环 | 第二次发布自动字段数 > 第一次；默认值需确认才写 |

### 13.4 验收矩阵（功能 × 场景）

| 功能 | 顺利 | 边界 | 失败 | 用户误操作 |
| --- | --- | --- | --- | --- |
| 同步 | 全量一致 | 截断 hasMore | 未登录/改版 | 同步中关掉应用 |
| 归并 | 标题+主图命中 | 一对多候选 | 无候选 | 误归并 → 可撤销 |
| 图片 | 全部本地化 | 部分防盗链 | 磁盘满 | 删本地商品后孤儿文件 |
| 发布 | L1 一次成功 | 部分字段需人工 | 双证据不一致 | 门禁处直接关应用 / 重复点提交 |

---

## 14. 里程碑（含 DoD）

### M1 · 同步到本地

**范围**：迁移 **v19**（9 张表）+ 契约 + 同步服务 + repository + 1 平台商品档案（微信小店，真机实测）+ 只读商品页 + `products:sync/list/syncRuns` IPC。

**DoD**
- [ ] 迁移 up/down 双向可跑；`tests/unit/migrations.test.ts` 覆盖新表
- [ ] 真机同步条数与平台页面一致（或如实 `hasMore`）
- [ ] 未登录 / 改版 / 超时三条路径都**不写脏数据**且话术正确
- [ ] 重复同步 `inserted=0`
- [ ] 图片本地化跑通（含一条防盗链如实失败）
- [ ] 熔断与限速已生效（连续 3 次失败自动暂停并可见）
- [ ] 新增单测 ≥ 25 条；全量测试与 `tsc --noEmit` 全绿

### M2 · 本地商品库

**范围**：编辑 / 校验 / 图片管理 / 归并 / CSV 导入导出 / 批量改价与标签。

**DoD**
- [ ] 编辑后 `draft_hash` 变化；校验分级正确
- [ ] CSV 往返一致 + 公式注入防护
- [ ] 归并可撤销；SKU 级映射（4.6）三种情况分别呈现
- [ ] 保留策略新增项已接入并可在设置里关

### M3 · 半自动发布（L1）

**范围**：预检 + 档位推导 + `buildPublishSteps` + 核对清单 + 状态机 + 回读闭环 + 发布台账。

**DoD（对应 §7 的可执行断言）**
- [ ] 不填错：每个自动字段读回校验；读不回标 `filled_unverified` 并在清单列出
- [ ] 提交必人工：步骤序列里没有提交动作；源码级断言通过
- [ ] 越用越自动：第二次自动字段数 > 第一次；第二次人工项 ≤ 1
- [ ] 可中断可续做：重启后不重放填充
- [ ] 不误报成功：双证据不一致 → `needs_review` 且不写 links
- [ ] 重复草稿被拒

### M4 · 多店批量与健康面板

**DoD**
- [ ] 3 店批量，1 店失败 → 另 2 店成功且台账正确；重试只跑失败店
- [ ] 批量可随时中止，已完成不受影响
- [ ] 健康面板显示每店同步健康度、熔断状态、未完成发布

---

## 15. 决策记录（ADR）

| # | 决策 | 备选 | 为什么选它 | 代价 |
| --- | --- | --- | --- | --- |
| D1 | 同步与发布两条管线 | 一套任务模板 | 风险/重试/恢复语义不同 | 代码有重复的编排骨架 |
| D2 | 归并需人工确认 | 按标题自动合并 | 合错=两商品搅一起，不可逆 | 首次使用有手工成本 |
| D3 | 冲突不覆盖本地 | 平台优先/本地优先 | 错一个字段就是错价错货 | 用户需要处理 `divergent` |
| D4 | 提交永远人工 | 可配置自动提交 | 项目红线 + 平台无法撤回 | 批量时仍需人工点 |
| D5 | 人工输入回读沉淀 | 不沉淀 | 否则"半自动"永远停在半自动 | 多一张表 + 一次确认交互 |
| D6 | 档位由实测推导 | 手写档位 | 杜绝"声明了自动化却填不进去" | 需要维护 `verified` 标记 |
| D7 | 图片走店铺 Session + 三重校验 | 主进程直连 | 复用登录态与代理，且必须防 SSRF | 实现更复杂 |
| D8 | 每店串行 + 跨店 2 并发 | 全并发 | 用户账号的风控代价不可接受 | 同步慢 |
| D9 | SKU 级映射独立表 | 塞进商品行 JSON | SKU 增删频繁，会让整行映射作废 | 多一次 join |
| D10 | 一切抓不到都如实分类 | 兜底默认值 | 兜底的值会被当成事实用于决策 | 界面上"未取到"的状态更多 |

---

## 16. 风险登记册

| # | 风险 | 概率 | 影响 | 缓解 | 触发信号 |
| --- | --- | --- | --- | --- | --- |
| R1 | 平台商品页结构与实测不符 | 中 | 同步不可用 | 锚点档案 + `PAGE_CHANGED` 如实停止；不写脏数据 | 同步连续 `PAGE_CHANGED` |
| R2 | 价格/库存字体反爬 | 中 | 关键字段取不到 | 采集前实测；取不到就 `unknown`，不用 OCR 硬凑 | 价格全为 `unknown` |
| R3 | 发布页字段远超本地模型 | 高 | 人工项居高不下 | 回读沉淀 + L2 引导模式（不硬填） | §7.10 指标不下降 |
| R4 | 平台风控（拉取/发布过频） | 中 | **用户账号受影响** | 限速 + 熔断 + 批量上限 | `RATE_LIMITED` 文案命中 |
| R5 | 图片磁盘占满 | 中 | 应用不可用 | 5GB 软上限 + 超限提示（不静默删） | 磁盘告警 |
| R6 | 重复发布产生垃圾链接 | 低 | 平台上出现重复商品 | 幂等键 + 预检 + 回读查重 | `PRODUCT_PUBLISH_SUSPECT_DUPLICATE` |
| R7 | 归并错导致商品数据混乱 | 中 | 数据可信度下降 | 必须人工确认 + 可撤销 | 用户反馈"商品被合并了" |
| R8 | 平台推出官方商品 API | 低（利好） | 现有 DOM 方案冗余 | 适配器契约可换实现（`collectProducts` 不变） | — |
| R9 | 商品量级远超预期（万级） | 中 | 同步慢/界面卡 | 分页 + 增量 + 虚拟滚动 | 单轮 `hasMore` 恒真 |
| R10 | 用户把"本地库"当成唯一真相 | 中 | 平台上被改过而本地不知 | 冲突矩阵 + 差异提示 + 上次同步时间常显 | `divergent` 增多 |

---

## 17. 真机勘察清单与脚本

> **开工前必做**（半天）。产出一份 `docs/product-profiles.md`，把下表逐格填上。
> 每一项都写"怎么测"和"测出来影响什么"——不做无目的的探索。

| # | 未知项 | 怎么测 | 影响 |
| --- | --- | --- | --- |
| 1 | 商品列表页 URL / SPA / 分页方式 | 打开店铺 → 商品 → 抄 URL；翻页看地址或滚动 | `ProductProfile.pagination` |
| 2 | 每页条数与总数 | 列表页看"共 N 条" | `hasMore` 判定与预算 |
| 3 | 价格/库存是否字体反爬 | 选中数字复制，看是否乱码（拼多多 sycm 有先例） | 能否读文本；否则只能 `unknown` |
| 4 | 列表列名/卡片文案 | 抄表头文案（这就是锚点） | `headerMap` / `cardAnchors` |
| 5 | 是否有"更新时间"列 | 看列表 | 能否做增量 |
| 6 | SKU 是否在列表页可见 | 点开一个多规格商品 | 决定是否必须进详情页 |
| 7 | 发布页入口与 URL | 从商品列表点"发布新商品" | `publishUrl` |
| 8 | 发布页必填字段清单与顺序 | 走一遍新建流程，记录必填项 | 半自动人工项的数量 |
| 9 | 类目控件形态（层级下拉/搜索） | 点开看 | 能否"建议+确认" |
| 10 | 图片上传入口是否 `input[type=file]` | DevTools 看元素 | 图片能否自动上传 |
| 11 | **已填字段能否回读** | 填一个标题，用 `document.querySelector` 看 value | **回读闭环能否成立（D5 的前提）** |
| 12 | 提交后的成功判据 | 提交一个测试商品，记文案/跳转 | 双证据 |
| 13 | 同标题重复提交是否被拦 | 故意再提交一次 | 查重策略 |
| 14 | 发布后是"直接上架"还是"审核中" | 看商品列表状态 | 状态映射 |
| 15 | 商品页是否在 ShadowRoot 内 | 看是否有 `micro-app` / `shadowRoot` | `deep` 标记 |

**勘察脚本**（复用仓库既有做法，`wx-invite-test/` 下已有大量同类脚本可抄）：

```
node wx-invite-test/probe-products-list.mjs <平台>       # 列表页结构 + 表头 + 条数 + 是否反爬
node wx-invite-test/probe-product-publish-page.mjs <平台> # 发布页字段清单 + 是否可回读 + 类目控件
```

两个脚本的输出直接贴进 `docs/product-profiles.md`——**档案里的每个字段都要能追溯到一次实测**。

---

## 18. 上线 / 回滚 / 开关

| 项 | 做法 |
| --- | --- |
| 功能开关 | `app_settings['product.feature'] = { sync: bool, publish: bool }`；默认**同步开、发布关**（发布要在真机验收通过后手动打开） |
| 灰度 | 先在一家店上跑通同步，再铺开到全部店；发布先只开 1 个平台 |
| 升级前备份 | M1 起，迁移前自动调 `backup` 模块（失败则中止迁移） |
| 回滚 | 关开关（立即停用，不动数据）→ 必要时跑 migration `down`（只删表，不删图片文件） |
| 灾难恢复 | 商品库随备份恢复；图片目录单独说明（备份含 DB，图片目录需用户自行保留或重新下载） |
| 上线检查单 | 迁移双向、开关生效、限速生效、熔断生效、审计可见、诊断包含新表计数、保留策略生效 |

---

## 19. 附录

### A. 跨平台字段映射表（模板，**待实测填充**）

| 统一字段 | 拼多多 | 微信小店 | 抖店 | 快手小店 |
| --- | --- | --- | --- | --- |
| 列表页 URL | 待实测 | 待实测 | 待实测 | 待实测（已知导航「商品 → 商品列表」） |
| 标题 | 待实测 | 待实测 | 待实测 | 待实测 |
| 价格 / 库存 | 待实测 | 待实测 | 待实测 | 待实测 |
| SKU | 待实测 | 待实测 | 待实测 | 待实测 |
| 图片 | 待实测 | 待实测 | 待实测 | 待实测 |
| 状态文案 | 待实测 | 待实测 | 待实测 | 待实测 |
| 类目路径 | 待实测 | 待实测 | 待实测 | 待实测 |
| 发布页 URL | 待实测 | 待实测 | 待实测 | 待实测 |
| 必填字段清单 | 待实测 | 待实测 | 待实测 | 待实测 |
| 字段可否回读 | 待实测 | 待实测 | 待实测 | 待实测 |

> 实现顺序：**先打通一个平台**（建议抖店或微信小店——已有较完整的 DOM/ShadowRoot 采集经验与实测证据），
> 再逐个铺开。每铺开一个平台，都要更新此表并补 `measuredAt`。

### B. 状态枚举（单一来源，禁止散落字符串）

| 域 | 取值 |
| --- | --- |
| 平台商品状态 | `on_sale` / `off_shelf` / `auditing` / `violation` / `missing` / `unknown` |
| 本地商品状态 | `draft` / `ready` / `published` / `archived` |
| 同步轮次状态 | `SUCCEEDED` / `PARTIAL` / `FAILED` / `LOGIN_REQUIRED` / `PAGE_CHANGED` / `SKIPPED_CIRCUIT` |
| 发布 item 状态 | `pending` / `precheck_failed` / `filling` / `fill_partial` / `awaiting_human` / `verifying` / `confirmed` / `needs_review` / `failed` / `discarded` |
| 图片状态 | `pending` / `localized` / `failed` / `blocked` / `missing` |

### C. 落地文件清单

| 类型 | 文件 |
| --- | --- |
| 契约 | ➕ `packages/shared/src/contracts/platform-product.ts`；✏️ `contracts/platform-adapter.ts`、`contracts/ipc.ts` |
| 常量/档案 | ➕ `packages/shared/src/constants/product.ts` |
| 规则 | ➕ `packages/shared/src/product-rules.ts`（校验/映射/指纹/档位推导） |
| 主进程 | ➕ `main/products/{product-sync-service,product-repository,product-media-service,product-sync-scheduler}.ts`<br>➕ `main/products/{product-publish-service,product-publish-state,product-readback-service}.ts`<br>✏️ `main/platform-adapters/*`（`collectProducts` + 发布页档案） |
| DB | ✏️ `main/db/migrations.ts`（v19）；✏️ `services/retention.ts` |
| IPC | ➕ `main/ipc/product-handlers.ts`；✏️ `preload/index.ts`、`renderer/src/env.d.ts` |
| 渲染层 | ✏️ `UnifiedAppsPage.vue`；➕ `ProductEditorDrawer.vue` / `ProductPublishPanel.vue` / `ProductPublishChecklist.vue` / `ProductSyncHealthCard.vue` |
| 安全 | ✏️ `shared/agent-step-effects.ts`、`main/services/agent-service.ts` |
| 测试 | ➕ `tests/unit/product-*.test.ts`、`tools/acceptance/product-*.js` |
| 文档 | ➕ `docs/product-profiles.md`（实测记录，勘察产出） |

### D. 工作量估算（人日，含测试与真机验收）

| 期 | 内容 | 估算 |
| --- | --- | --- |
| M1 | 迁移+契约+同步服务+1 平台档案+只读页 | **8–12** |
| M2 | 编辑/图片/归并/CSV/批量 | **10–14** |
| M3 | 半自动发布（预检/填充/清单/状态机/回读） | **12–16** |
| M4 | 多店批量/差异/健康面板 | **6–9** |
| — | 每增加一个平台的档案实测与适配 | **2–4** |

风险系数：平台改版导致的返工不在此列（按经验留 20% 余量）。

---

## 20. 下一步（明确的两个选项）

**选项 A：先勘察**（推荐）
花半天跑 §17 的两个脚本，把 15 项未知填进 `docs/product-profiles.md`。
好处：M1/M3 的实现不会再返工；坏处：半天不见功能。

**选项 B：直接开工 M1**
按本文 §5 + §14-M1 落地（迁移 + 同步服务 + 只读页），平台档案边做边测。
好处：快；坏处：若第 3/11 项（字体反爬 / 字段可回读）结论不利，部分设计要改。

无论哪条路，**M3 之前的第 11 项（发布页字段能否回读）必须先有结论**——它是"越用越自动"的前提，
没有它，半自动就只能停在"每次人工填一遍"。
