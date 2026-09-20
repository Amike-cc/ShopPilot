# 达人邀约功能优化报告

**生成时间**: 2026-09-17  
**版本**: 0.4.35  
**状态**: 功能完善，建议进一步优化性能

---

## 📊 当前实现评估

### 架构设计 ⭐⭐⭐⭐⭐

**优势**:
- ✅ 完全模拟人工操作，合规性强
- ✅ 平台适配层架构清晰（每平台独立档案）
- ✅ 错误处理机制完善（`stopOn` / `onCode`）
- ✅ 人工确认门禁（批量流）
- ✅ 截图留档（每轮自动保存）
- ✅ 详细的步骤日志与进度事件

**覆盖平台**:
- 抖店（批量流）: `batch-list`
- 微信小店（辅助流）: `assist-form`
- 快手小店（批量流）: `batch-list`

### 性能瓶颈分析

#### 1. 批量勾选滚动加载 🔴 高影响

**现状**:
```typescript
// clickAll 步骤需要多轮滚动才能勾满 40 位
maxRounds: 25  // 最多 25 轮
每轮: 轮询等待 + 勾选 + 滚动 + 等待落定
总耗时: 约 2-5 分钟/批次
```

**瓶颈**:
- 虚拟列表一屏只渲染 ~19 行
- 滚动后需等待渲染（80ms × 20 次检测）
- 每轮勾选间隔 240ms（防止与框架重渲染冲突）

**优化建议**:
```typescript
// 建议 1: 动态调整滚动步长
const scrollStep = Math.floor(box.clientHeight * 0.95)
// 改为
const scrollStep = Math.min(
  Math.floor(box.clientHeight * 1.5),  // 滚动 1.5 屏
  box.scrollHeight - box.scrollTop - box.clientHeight
)

// 建议 2: 减少渲染等待轮询次数
for (let i = 0; i < 20; i++) {  // 当前 20 次
  await new Promise(r => setTimeout(r, 80));
}
// 改为
for (let i = 0; i < 10; i++) {  // 10 次足够
  await new Promise(r => setTimeout(r, 100));
}

// 建议 3: 并行读取计数（不阻塞点击）
// 当前：每次点击后都读计数（240ms）
// 优化：每勾选 5 位读一次计数
```

**预期收益**: 勾满 40 位耗时从 2-5 分钟降至 1-2 分钟

---

#### 2. AI 话术生成稳定性 🟡 中影响

**现状**:
```typescript
type: 'aiGenerate',
timeoutMs: 90000,  // 90 秒超时
retryLimit: 2      // 最多重试 2 次
```

**问题**:
- 模型偶发超时会终止整批（前面已邀约的位数作废）
- 真机实测：第 25 轮 `aiGenerate` 超时，前 24 位已发出但整单报失败

**已有保护**:
- ✅ 步骤级重试（`retryLimit: 2`）
- ✅ 幂等性（重跑只是重新生成覆盖同一输入框）

**优化建议**:
```typescript
// 建议 1: 增加超时时间（大模型推理慢）
timeoutMs: 120000  // 改为 120 秒

// 建议 2: 降级策略（模型不可用时用手动话术）
if (opts.scriptMode === 'ai') {
  try {
    await aiGenerate(...)
  } catch (e) {
    if (attempts >= 2 && opts.fallbackScript) {
      // 降级到手动话术
      await typeText(opts.fallbackScript)
    } else throw e
  }
}

// 建议 3: 话术模板缓存
// 同一批次的商品信息相同，可缓存首次生成的话术
```

**预期收益**: 减少因 AI 超时导致的整批失败

---

#### 3. 错误恢复等待时间 🟢 低影响

**现状**:

**微信详情页打不开**:
```typescript
code: 'TASK_DAREN_PAGE_UNOPENABLE',
limit: 6,
restart: true,
steps: [
  { type: 'waitMs', input: { ms: 20000 } }  // 等待 20 秒
]
```

**快手类目下拉残留**:
```typescript
// 点完类目后用 Escape 收起下拉
{ type: 'pressKey', input: { key: 'Escape' } }
await new Promise(r => setTimeout(r, 400))  // 固定等待 400ms
```

**优化建议**:
```typescript
// 建议 1: 指数退避
const backoffMs = Math.min(5000 * Math.pow(1.5, attempt), 60000)

// 建议 2: 条件等待（弹层真正消失后继续）
{ 
  type: 'pressKey', 
  input: { key: 'Escape' },
  verify: { goneSelector: '.category-popover' }  // 新增验证
}
```

**预期收益**: 减少不必要的固定等待

---

## 🎯 优先级推荐

### P0 - 立即实施（高收益低风险）

1. **增加 AI 话术生成超时**
   ```typescript
   timeoutMs: 90000 → 120000
   ```
   - 修改位置: `invite-steps.ts:439` / `invite-steps.ts:220`
   - 风险: 无
   - 收益: 减少超时失败

2. **优化滚动落定等待**
   ```typescript
   // 从 20 次减少到 10 次
   for (let i = 0; i < 10; i++) {
     await new Promise(r => setTimeout(r, 100));
   }
   ```
   - 修改位置: `task-runner.ts:1949`
   - 风险: 低（仍有 1 秒等待）
   - 收益: 每批节省 ~30 秒

### P1 - 短期优化（需要测试）

3. **批量勾选计数优化**
   ```typescript
   // 每勾选 5 位读一次计数（而非每次）
   if (clicked.length % 5 === 0 || clicked.length >= LIMIT) {
     const current = read();
     // 检查计数是否符合预期
   }
   ```
   - 修改位置: `task-runner.ts:1900-1910`
   - 风险: 中（需真机验证）
   - 收益: 每批节省 ~1 分钟

4. **动态滚动步长**
   ```typescript
   const scrollStep = Math.min(
     Math.floor(box.clientHeight * 1.5),
     box.scrollHeight - box.scrollTop - box.clientHeight
   )
   ```
   - 修改位置: `task-runner.ts:1946`
   - 风险: 中（需真机验证）
   - 收益: 减少滚动轮次

### P2 - 长期优化（架构改进）

5. **话术模板缓存**
   - 同一批次商品信息相同，缓存首次生成的话术
   - 修改位置: 新增缓存层
   - 风险: 低
   - 收益: 第 2 批起生成话术耗时几乎为 0

6. **并行批次处理**（慎重）
   - 同时运行多个批次（不同店铺窗口）
   - 风险: 高（可能触发平台限流）
   - 收益: 吞吐量提升 2-3 倍
   - **不推荐**: 平台有限流机制，可能适得其反

---

## 📝 代码质量评估

### 已实现的最佳实践 ✅

1. **错误分类清晰**
   ```typescript
   - TASK_QUOTA_EXCEEDED: 额度用完（正常收尾）
   - TASK_SELECTION_SHORTFALL: 候选不足（正常收尾）
   - TASK_DAREN_NOT_INVITABLE: 不满足平台条件（跳过）
   - TASK_DAREN_PAGE_UNOPENABLE: 详情页打不开（退避重试）
   - TASK_SEND_PARTIAL: 部分发送失败（如实报告）
   ```

2. **幂等性保证**
   - 填写话术是幂等的（重试覆盖同一输入框）
   - 已访问记录机制（`visitedRows`）

3. **安全门禁**
   - 批量流：人工确认门禁（`waitForUserConfirmation`）
   - 辅助流：平台确认弹窗（`确认发送邀约`）

4. **可观察性**
   - 每轮截图留档
   - 详细的步骤 payload
   - 进度事件实时推送

### 潜在改进点

1. **日志结构化** 🟡
   ```typescript
   // 当前
   logMain('info', `勾选 ${clicked} 位达人`)
   
   // 建议
   logMain('info', 'invite.select', { 
     clicked, 
     platform, 
     category, 
     round 
   })
   ```

2. **指标收集** 🟡
   ```typescript
   // 建议新增指标
   - invite.batch.duration_ms
   - invite.batch.success_rate
   - invite.ai.generation_duration_ms
   - invite.scroll.rounds_count
   ```

---

## 🔬 真机测试建议

### 回归测试清单

实施上述优化后，必须在**真实店铺**验证：

#### 抖店（批量流）
- [ ] 筛选类目后勾选 40 位（一屏 19 行需滚动）
- [ ] AI 话术生成（有商品信息时）
- [ ] 手动话术（无 AI 配置时）
- [ ] 额度用尽时的提前停止
- [ ] 已邀约达人的跳过

#### 微信小店（辅助流）
- [ ] 逐个邀约 5 位（翻页 + 详情页跳转）
- [ ] 详情页打不开的退避重试
- [ ] 已邀约达人的跳过（按钮禁用）
- [ ] 额度预检（"今日剩余N次"）
- [ ] 商品自动添加（`ensureRows`）

#### 快手小店（批量流）
- [ ] 勾选 2 位（最低要求）
- [ ] 商品弹窗选择
- [ ] 二次确认框（"继续发送邀约"）
- [ ] 部分发送失败的如实报告

### 性能基准

| 场景 | 当前耗时 | 优化目标 | 测量方法 |
|------|---------|---------|---------|
| 勾选 40 位（抖店） | 2-5 分钟 | < 2 分钟 | 计时 `clickAll` 步骤 |
| AI 生成话术 | 10-30 秒 | 稳定 < 20 秒 | 计时 `aiGenerate` 步骤 |
| 单批完整流程（抖店） | 5-8 分钟 | < 5 分钟 | 计时整个 `loop` |
| 逐个邀约 10 位（微信） | 15-20 分钟 | < 15 分钟 | 计时整个 `loop` |

---

## 📦 实施计划

### 第一阶段：低风险优化（1 天）

1. 修改 AI 超时配置（P0-1）
2. 优化滚动等待（P0-2）
3. 运行完整单元测试（200 项）
4. 真机回归测试（抖店 1 批）

### 第二阶段：性能优化（3 天）

1. 实施批量勾选计数优化（P1-3）
2. 实施动态滚动步长（P1-4）
3. 真机性能基准测试（三个平台）
4. 调整参数至最优值

### 第三阶段：长期改进（待定）

1. 话术模板缓存（P2-5）
2. 日志结构化（P2）
3. 指标收集仪表盘

---

## ⚠️ 风险提示

### 不建议的优化

1. **并行批次处理**
   - 同时运行多个批次可能触发平台限流
   - 实测快手连续快速邀约会被限流 1-2 分钟

2. **跳过人工确认门禁**
   - 当前批量流有人工确认（抖店/快手）
   - 这是防止误触的最后一道防线

3. **减少重试次数**
   - 当前 `retryLimit: 2` 已经很保守
   - 进一步减少会降低稳定性

4. **逆向协议接口**
   - 法律风险、账号风险、维护成本
   - 详见《达人邀约功能协议分析报告》

---

## 📚 参考文档

- 平台档案: `packages/shared/src/constants/invite.ts`
- 步骤构造: `packages/shared/src/invite-steps.ts`
- 任务引擎: `apps/desktop/src/main/tasks/task-runner.ts`
- 单元测试: `tests/unit/invite.test.ts`（49 项）

---

## ✅ 总结

当前达人邀约功能的**架构设计优秀**，已经具备：
- 完善的错误处理
- 清晰的平台适配层
- 可靠的安全门禁
- 详细的日志与截图

**建议优化方向**是**性能调优**而非架构重构：
- ✅ 低风险快速优化（AI 超时、滚动等待）
- ✅ 中风险性能优化（计数频率、滚动步长）
- ❌ 高风险架构改动（并行批次、协议接口）

**预期收益**：单批邀约耗时降低 30-50%，稳定性提升。
