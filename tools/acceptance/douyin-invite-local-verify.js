/**
 * 抖店达人邀约本地端到端验收。
 *
 * 使用独立临时 userData 和本地仿真达人广场，完整走一遍：
 * UI 创建抖店邀约任务 -> 勾选 -> 打开邀约抽屉（**改版后的结构化表单**）
 * -> 停在中国式人工确认门禁 -> 确认 -> 仿真平台接收 -> 下一轮额度用尽收尾。
 *
 * 仿真站点按 2026-09-22 真机实测的抖店行为建模，三处"照着真实平台来"是刻意的：
 *  ① 类目级联：**点二级 = 只应用「一级/二级」且弹层收起**；三级列只在**悬停**二级项时才渲染
 *     —— 于是"点二级再点三级"这条老路径在这里必然失败（与真机一致）；
 *  ② 抽屉：没有话术 textarea，改由「主营下拉 + 核心优势 + 权益 + 手机号/微信号 + 推荐商品开关」
 *     拼装邀约消息，其中联系方式与推荐商品是必填项；
 *  ③ 「批量邀约带货」按钮只在**已有勾选**时才出现（真机它就在「已选择N位达人」那条提示里）。
 *
 * 不连接真实抖店，不会向真实达人发送邀约。
 */
const { spawn, execSync } = require('child_process')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.resolve(__dirname, '../..')
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const CDP_PORT = process.env.SHOPILOT_DOUYIN_CDP_PORT || '9261'
const CONTACT_PHONE = '15057937334'
const CONTACT_WECHAT = 'jiaoe988'
const results = []

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`)
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32' && child.pid) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    else child.kill('SIGKILL')
  } catch { /* 进程可能已自行退出 */ }
}

function freeDebugPort(port) {
  if (process.platform !== 'win32') return
  try {
    const out = execSync(`netstat -ano | findstr LISTENING | findstr :${port}`, { encoding: 'utf8' })
    const pids = new Set(out.split(/\r?\n/).map(line => line.trim().split(/\s+/).pop()).filter(p => /^\d+$/.test(p)))
    for (const pid of pids) {
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }) } catch { /* ignore */ }
    }
  } catch { /* 没有占用 */ }
}

function focusAppWindow(pid) {
  if (process.platform !== 'win32' || !pid) return
  try {
    execSync(
      `powershell -NoProfile -Command "$w = New-Object -ComObject WScript.Shell; ` +
      `for ($i = 0; $i -lt 20; $i++) { if ($w.AppActivate(${pid})) { break }; Start-Sleep -Milliseconds 300 }"`,
      { stdio: 'ignore', timeout: 20000 }
    )
  } catch { /* 页面可见性断言会如实暴露 */ }
}

const STRENGTH_OPTIONS = [
  '行业知名度高', '其他平台知名度高', '源头工厂', '货源充足', '品类丰富',
  '用户口碑高', '多款爆款', '商品品质高', '多项专利',
  '48h发货', '现货现发', '七天无理由退货', '售后无忧'
]
const BENEFIT_OPTIONS = ['专属高佣', '免费样品', '佣金可谈', '机制可谈', '优质视频投流', '视频素材/脚本支持', '带货指导/陪跑']

function startSite() {
  const state = {
    sentBatches: 0,
    sentCount: 0,
    quotaExhausted: false,
    /** 每次发送时的抽屉快照（用于比对"第 2 轮有没有把记住的选项点掉"） */
    sends: [],
    /** 已邀约的达人行（真机：发出去的达人在下一次打开广场时复选框是 disabled，不允许重复邀约） */
    invitedKeys: [],
    /** 三级列的展开次数（悬停二级项触发）——证明"悬停开列"这条手势真的发生了 */
    hoverExpands: 0,
    /** 二级项被**点击**的次数：真机点二级=只应用两级并收起弹层，所以这里必须是 0 */
    secondLevelClicks: 0,
    /**
     * 抽屉表单（**平台会记住上次填写**：真机实测第 2 轮打开抽屉时，主营/核心优势/权益
     * 都还是上次的值，连触发器上的文案都变成上次选的类目，不再是「请下拉选择」）。
     */
    drawer: { mainCategory: '', strengths: [], benefits: [], phone: '', wechat: '', goodsAdded: 0 }
  }

  function page() {
    const disabled = state.quotaExhausted ? 'disabled' : ''
    return `<!doctype html><html><head><meta charset="utf-8"><title>抖店达人广场-本地验收</title>
      <style>
        body { font: 14px sans-serif; margin: 20px; }
        table { border-collapse: collapse; margin: 16px 0; }
        td, th { border: 1px solid #ccc; padding: 8px 14px; }
        .drawer { display:none; }
        .drawer.open { display:block; position:fixed; left:0; top:0; width:100%; height:100%; padding:20px; box-sizing:border-box; background:#fff; overflow:auto; }
        textarea { width:100%; height:100px; box-sizing:border-box; }
        button { padding:8px 14px; }
        .auxo-cascader-menu-item { padding:6px 10px; border:1px solid #eee; cursor:pointer; display:block; width:200px; }
        .auxo-cascader-multiple-wrapper { border:1px solid #ddd; padding:6px; width:200px; display:inline-block; cursor:pointer; }
      </style></head><body>
      <h1>抖店达人广场（本地验收）</h1>
      <div class="quick-filter-button-enums"><button id="category-chip"><span>个护家清</span></button><button><span>生鲜</span></button></div>
      <div class="quick-filter-cascader-popover" style="display:none">
        <ul class="auxo-cascader-menu" id="col1">
          <li class="auxo-cascader-menu-item" id="category-any">不限</li>
          <li class="auxo-cascader-menu-item auxo-cascader-menu-item-expand" id="category-sub-2" data-sub="个人护理">个人护理</li>
          <li class="auxo-cascader-menu-item auxo-cascader-menu-item-expand" id="category-sub" data-sub="家清纸品">家清纸品</li>
        </ul>
        <ul class="auxo-cascader-menu" id="col2" style="display:none"></ul>
      </div>
      <div id="filtered-row"><span>已筛选</span><span id="filtered-value"></span></div>
      <div>达人等级 <button>LV0</button><button>LV1</button><button>LV2</button><button>LV3</button></div>
      <div><button>搜索</button></div>
      <div id="selected-bar" style="display:none">已选择 <b id="selected-count">0</b> 位达人 <button class="auxo-btn auxo-btn-link" id="batch-invite"><span>批量邀约带货</span></button></div>
      <table><thead><tr><th><input type="checkbox" id="all"></th><th>达人</th></tr></thead><tbody>
        ${['A', 'B', 'C', 'D', 'E', 'F'].map((name, i) => `<tr data-row-key="daren-${i + 1}"><td><label><input type="checkbox" class="daren"${state.invitedKeys.includes('daren-' + (i + 1)) ? ' disabled' : ''}></label></td><td>达人${name}${state.invitedKeys.includes('daren-' + (i + 1)) ? '（已邀约）' : ''}</td></tr>`).join('')}
      </tbody></table>
      <div class="auxo-drawer auxo-drawer-right" id="drawer">
        <h2>批量沟通 · 邀约信息</h2>
        <p>你好，这里是本地验收店, 主营
          <span class="auxo-cascader-multiple-wrapper" id="drawer-main-trigger"><span class="auxo-cascader-multiple-placeholder">请下拉选择</span></span>
        </p>
        <p>我们的核心优势：最多选 5 项</p>
        <div id="strengths">${STRENGTH_OPTIONS.map((s, i) => `<label style="display:inline-block;margin:2px 8px"><input type="checkbox" class="strength" data-name="${s}" data-idx="${i}">${s}</label>`).join('')}</div>
        <p>我们可以为您提供的权益：最多选 3 项</p>
        <div id="benefits">${BENEFIT_OPTIONS.map((b, i) => `<label style="display:inline-block;margin:2px 8px"><input type="checkbox" class="benefit" data-name="${b}" data-idx="${i}">${b}</label>`).join('')}</div>
        <p>* 联系方式</p>
        <div><label for="phone">手机号</label><input id="phone" class="auxo-input" placeholder="请输入" maxlength="11" type="text" value=""></div>
        <div><label for="wechat">微信号</label><input id="wechat" class="auxo-input" placeholder="请输入" maxlength="20" type="text" value=""></div>
        <p>* 专属推荐商品</p>
        <div><label id="goods-switch-label"><span class="auxo-switch auxo-switch-small" id="goods-switch"></span>使用平台推荐商品</label>
          <span id="goods-count">已添加 0/5</span></div>
        <p><button id="confirm-send" ${disabled}>确认发送</button> <button id="cancel-send">取消</button></p>
        ${state.quotaExhausted ? '<p id="quota-hint">今日邀约额度已用尽</p>' : ''}
      </div>
      <script>
        const state = ${JSON.stringify(state)};
        // 暴露给验收脚本直接读（经典脚本里的 const 不挂在 window 上）
        window.__gesture = (window.__gesture = state);
        const drawer = document.getElementById('drawer');
        const popover = document.querySelector('.quick-filter-cascader-popover');
        const col2 = document.getElementById('col2');
        const checks = [...document.querySelectorAll('tbody input[type=checkbox]')];
        const count = () => checks.filter(x => x.checked).length;
        const redraw = () => {
          const n = count();
          document.getElementById('selected-count').textContent = String(n);
          // 真机：按钮就在「已选择N位达人」这条提示里，没勾选时压根不在 DOM
          document.getElementById('selected-bar').style.display = n > 0 ? 'block' : 'none';
        };
        for (const c of checks) c.addEventListener('change', redraw);

        // ---- 类目级联：点一级 chip 开合弹层；悬停二级项才渲染三级列；**点二级 = 两级 + 收起** ----
        const closePopover = () => { popover.style.display = 'none'; col2.style.display = 'none'; col2.innerHTML = ''; };
        document.getElementById('category-chip').addEventListener('click', () => {
          if (popover.style.display === 'none') { popover.style.display = 'block'; col2.style.display = 'none'; col2.innerHTML = ''; }
          else closePopover();
        });
        const renderThird = (sub) => {
          if (col2.dataset.sub === sub && col2.style.display !== 'none') return;
          col2.dataset.sub = sub;
          col2.style.display = 'block';
          col2.innerHTML = '';
          if (sub !== '家清纸品') return;
          // 先出现相似叶子，真正的「纸品」稍后才渲染，逼真覆盖异步级联场景
          const near = document.createElement('li');
          near.className = 'auxo-cascader-menu-item';
          near.id = 'category-third-near';
          near.textContent = '纸品用品';
          near.addEventListener('click', () => {
            document.getElementById('filtered-value').textContent = ' 个护家清 / 家清纸品（纸品用品）';
            closePopover();
          });
          col2.appendChild(near);
          setTimeout(() => {
            const leaf = document.createElement('li');
            leaf.className = 'auxo-cascader-menu-item';
            leaf.id = 'category-third-leaf';
            leaf.textContent = '纸品';
            leaf.addEventListener('click', () => {
              document.getElementById('filtered-value').textContent = ' 个护家清 / 家清纸品（纸品）';
              closePopover();
            });
            col2.appendChild(leaf);
          }, 650);
        };
        for (const li of document.querySelectorAll('#col1 .auxo-cascader-menu-item')) {
          // 悬停（真实鼠标会给 mouseover/mouseenter；引擎的 hover 步骤也一样）
          li.addEventListener('mouseover', () => {
            const sub = li.dataset.sub;
            if (!sub) return;
            state.hoverExpands += 1;
            renderThird(sub);
          });
          li.addEventListener('mouseenter', () => {
            const sub = li.dataset.sub;
            if (!sub) return;
            renderThird(sub);
          });
          li.addEventListener('click', (ev) => {
            if (!li.dataset.sub) return;
            // 真机实测：点二级项 = 立刻应用「一级/二级」并把弹层收起（三级列随之消失）
            state.secondLevelClicks += 1;
            document.getElementById('filtered-value').textContent = ' 个护家清 ' + li.dataset.sub;
            ev.stopPropagation();
            closePopover();
          });
        }
        document.getElementById('category-any').addEventListener('click', () => {
          document.getElementById('filtered-value').textContent = ' 个护家清';
          closePopover();
        });

        // ---- 抽屉（改版后的结构化表单）----
        // 真机口径：打开抽屉时**平台会带上上次填写的内容**（主营/核心优势/权益/联系方式都保留），
        // 所以这里也按 state.drawer 预填——第 2 轮才可能出现"重复点击=反选"这类问题。
        const goodsCount = document.getElementById('goods-count');
        let goodsAdded = 0;
        const prefill = () => {
          const d = state.drawer || {};
          document.querySelector('.auxo-cascader-multiple-placeholder').textContent = d.mainCategory || '请下拉选择';
          for (const cb of document.querySelectorAll('.strength')) cb.checked = (d.strengths || []).includes(cb.dataset.name);
          for (const cb of document.querySelectorAll('.benefit')) cb.checked = (d.benefits || []).includes(cb.dataset.name);
          document.getElementById('phone').value = d.phone || '';
          document.getElementById('wechat').value = d.wechat || '';
        };
        document.getElementById('batch-invite').addEventListener('click', () => {
          drawer.classList.add('open', 'auxo-drawer-open');
          // 平台每次打开抽屉都把"推荐商品"开关重置为关（实测：上轮开过也不保留）
          goodsAdded = 0;
          goodsCount.textContent = '已添加 0/5';
          document.getElementById('goods-switch').className = 'auxo-switch auxo-switch-small';
          prefill();
        });
        document.getElementById('cancel-send').addEventListener('click', () => {
          drawer.classList.remove('open', 'auxo-drawer-open');
        });
        document.getElementById('goods-switch-label').addEventListener('click', () => {
          const sw = document.getElementById('goods-switch');
          const on = sw.className.includes('auxo-switch-checked');
          sw.className = 'auxo-switch auxo-switch-small' + (on ? '' : ' auxo-switch-checked');
          goodsAdded = on ? 0 : 2;   // 平台按达人匹配：实测开一次挂 2 个
          goodsCount.textContent = '已添加 ' + goodsAdded + '/5';
        });

        // 主营（多选级联）：**必须真实鼠标点击**才展开；**点一级项**才出二级列（悬停不出，真机实测）；
        // 点二级后触发器显示「一级/二级」。
        // 面板是 body 级浮层（.auxo-cascader-menus 挂在 body 下、**不在抽屉里**）——真机实测如此，
        // 流程若用抽屉当查找范围就会一个选项都找不到（这里是那条 bug 的回归网）。
        const mainPop = document.createElement('div');
        mainPop.className = 'auxo-cascader-menus';
        // 真机的面板是浮层且**在视口内**（悬停/点击都要能点到）——这里用 fixed 定位还原
        mainPop.style.cssText = 'display:none;position:fixed;left:320px;top:120px;z-index:60;background:#fff;border:1px solid #ddd;padding:6px;';
        document.body.appendChild(mainPop);
        document.getElementById('drawer-main-trigger').addEventListener('mousedown', (ev) => {
          // 真机：合成 click 打不开它，只有鼠标按下（受信任输入）才展开
          if (!ev.isTrusted) return;
          if (mainPop.style.display === 'none') {
            mainPop.style.display = 'block';
            mainPop.innerHTML = '';
            // 真机的级联项**每项都带复选框**（多选级联），选中态就是那个复选框——
            // 引擎的 skipIfChecked 正是读它来判断"这项已经选着了"，所以仿真必须如实带上。
            const remembered = state.drawer.mainCategory === '个护家清/家清纸品';
            const mk = (text, id, checked) => {
              const li = document.createElement('li');
              li.className = 'auxo-cascader-menu-item auxo-cascader-menu-item-expand';
              li.id = id;
              li.innerHTML = '<span class="auxo-checkbox-wrapper"><input type="checkbox"' + (checked ? ' checked' : '') + '></span>' + text;
              return li;
            };
            const root = mk('个护家清', 'drawer-main-root', remembered);
            const sub = mk('家清纸品', 'drawer-main-sub', remembered);
            sub.style.display = 'none';
            // 真机：点一级项才展开子列（悬停无效）
            root.addEventListener('click', (e) => {
              if (!e.isTrusted) return;
              sub.style.display = 'block';
            });
            // 真机：点已勾选的二级项 = **反选**（所以流程要用 skipIfChecked 幂等填写）
            sub.addEventListener('click', () => {
              const cb = sub.querySelector('input');
              const next = !cb.checked;
              cb.checked = next;
              root.querySelector('input').checked = next;
              state.drawer.mainCategory = next ? '个护家清/家清纸品' : '';
              document.querySelector('.auxo-cascader-multiple-placeholder').textContent = state.drawer.mainCategory || '请下拉选择';
              mainPop.style.display = 'none';
            });
            mainPop.appendChild(root);
            mainPop.appendChild(sub);
          } else mainPop.style.display = 'none';
        });

        // 核心优势/权益：平台对超量勾选**静默忽略**（实测权益第 4 项点了不生效）
        for (const cb of document.querySelectorAll('.strength')) {
          cb.addEventListener('click', (ev) => {
            const chosen = [...document.querySelectorAll('.strength')].filter(x => x.checked && x !== cb).length;
            if (!cb.checked && chosen >= 5) { ev.preventDefault(); return }
          });
        }
        for (const cb of document.querySelectorAll('.benefit')) {
          cb.addEventListener('click', (ev) => {
            const chosen = [...document.querySelectorAll('.benefit')].filter(x => x.checked && x !== cb).length;
            if (!cb.checked && chosen >= 3) { ev.preventDefault(); return }
          });
        }

        document.getElementById('confirm-send').addEventListener('click', () => {
          if (${state.quotaExhausted}) return;
          const phone = document.getElementById('phone').value;
          const wechat = document.getElementById('wechat').value;
          const strengths = [...document.querySelectorAll('.strength')].filter(x => x.checked).map(x => x.dataset.name);
          const benefits = [...document.querySelectorAll('.benefit')].filter(x => x.checked).map(x => x.dataset.name);
          // 平台把这次填写**记住**（下一轮打开抽屉时预填）
          state.drawer = { mainCategory: state.drawer.mainCategory, strengths, benefits, phone, wechat, goodsAdded };
          const keys = [...document.querySelectorAll('tbody tr')]
            .filter(tr => { const cb = tr.querySelector('input.daren'); return cb && cb.checked })
            .map(tr => tr.getAttribute('data-row-key'));
          fetch('/__send', {
            method: 'POST',
            headers: {'content-type':'application/json'},
            keepalive: true,
            body: JSON.stringify({
              count: count(),
              keys,
              // 级联手势的证据（这两个计数只在页面里累加，必须回传，否则服务端看不到）
              hoverExpands: state.hoverExpands,
              secondLevelClicks: state.secondLevelClicks,
              drawer: state.drawer
            })
          });
          drawer.classList.remove('open', 'auxo-drawer-open');
        });
        redraw();
      </script></body></html>`
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><body>本地店铺</body></html>')
      return
    }
    if (req.method === 'GET' && req.url === '/daren-square') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page())
      return
    }
    if (req.method === 'GET' && req.url === '/square_doudian_pc_api/square/filter?type=1&req_scene=1') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        code: 0,
        data: {
          headers: [{
            key: 'main_cate_new',
            title: '主推类目',
            options: [{
              label: '个护家清',
              children: [{
                label: '家清纸品',
                children: [{ label: '纸品' }, { label: '清洁用品' }]
              }]
            }]
          }]
        }
      }))
      return
    }
    if (req.method === 'GET' && req.url === '/__state') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(state))
      return
    }
    if (req.method === 'POST' && req.url === '/__send') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}')
          state.sentBatches += 1
          state.sentCount += Number(parsed.count) || 0
          if (typeof parsed.hoverExpands === 'number') state.hoverExpands = parsed.hoverExpands
          if (typeof parsed.secondLevelClicks === 'number') state.secondLevelClicks = parsed.secondLevelClicks
          if (parsed.drawer) state.drawer = parsed.drawer
          // 发出去的达人进入"已邀约"（下次打开广场时复选框 disabled，真机口径）
          for (const k of (Array.isArray(parsed.keys) ? parsed.keys : [])) {
            if (!state.invitedKeys.includes(k)) state.invitedKeys.push(k)
          }
          // 每批的抽屉快照：第 2 批与第 1 批必须一致（平台记住上次填写 + 幂等填写）
          state.sends.push({ count: Number(parsed.count) || 0, keys: parsed.keys || [], drawer: parsed.drawer || null })
          // 两批之后额度用尽：第 3 轮走到"确认发送可用性预检"就会干净收尾（TASK_QUOTA_EXCEEDED）
          if (state.sentBatches >= 2) state.quotaExhausted = true
        } catch { /* 验收会在状态断言里暴露 */ }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
      return
    }
    res.writeHead(404)
    res.end('not found')
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        base: `http://127.0.0.1:${address.port}`,
        state,
        close: () => new Promise(r => server.close(r))
      })
    })
  })
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve
      this.ws.onerror = reject
    })
    this.ws.onmessage = event => {
      const msg = JSON.parse(event.data)
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      if (msg.error) pending.reject(new Error(msg.error.message))
      else pending.resolve(msg.result)
    }
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression, awaitPromise = true) {
    await this.ready
    const result = await this.send('Runtime.evaluate', {
      expression: awaitPromise ? `(async () => { ${expression} })()` : expression,
      awaitPromise,
      returnByValue: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    return result.result.value
  }

  close() { try { this.ws.close() } catch { /* ignore */ } }
}

async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`)
  return response.json()
}

async function getTargets() { return fetchJson(`http://127.0.0.1:${CDP_PORT}/json`) }

async function waitForCDP(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      if (response.ok) return
    } catch { /* retry */ }
    await sleep(400)
  }
  throw new Error('CDP endpoint not ready')
}

async function connectUi() {
  const targets = await getTargets()
  const target = targets.find(t => t.type === 'page' && t.url.includes('/renderer/index.html'))
  if (!target) throw new Error('ShopPilot UI target not found')
  const cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.eval(`const until = Date.now() + 15000; while (!window.shopilot && Date.now() < until) await new Promise(r => setTimeout(r, 100)); return !!window.shopilot;`)
  return cdp
}

async function connectPage(urlPart) {
  const targets = await getTargets()
  const target = targets.find(t => (t.type === 'page' || t.type === 'webview') && t.url.includes(urlPart))
  if (!target) throw new Error(`page target not found: ${urlPart}`)
  const cdp = new CDP(target.webSocketDebuggerUrl)
  await cdp.ready
  return cdp
}

async function pollRun(api, runId, predicate, timeoutMs) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    const result = await api.taskResults(runId)
    if (result.ok) {
      last = result.data
      if (predicate(result.data)) return result.data
    }
    await sleep(400)
  }
  return last
}

async function main() {
  console.log('=== 抖店达人邀约本地端到端验收 ===')
  const site = await startSite()
  const userData = path.join(os.tmpdir(), 'shopilot-douyin-invite-' + Date.now())
  fs.mkdirSync(userData, { recursive: true })
  freeDebugPort(CDP_PORT)
  let app = null
  let ui = null

  try {
    app = spawn(electronExe, [
      root,
      '--no-sandbox',
      `--remote-debugging-port=${CDP_PORT}`,
      '--user-data-dir=' + userData,
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows'
    ], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, NODE_ENV: 'production', ELECTRON_ENABLE_LOGGING: '1', SHOPILOT_DISABLE_CDP_FP: '1' }
    })

    await waitForCDP()
    focusAppWindow(app.pid)
    await sleep(1200)
    ui = await connectUi()

    const api = {
      taskList: () => ui.eval(`return await window.shopilot.task.list();`),
      taskResults: runId => ui.eval(`return await window.shopilot.task.results(${JSON.stringify(runId)});`),
      taskConfirm: (runId, approved) => ui.eval(`return await window.shopilot.task.confirm(${JSON.stringify(runId)}, ${approved});`),
      taskDelete: taskId => ui.eval(`return await window.shopilot.task.delete(${JSON.stringify(taskId)});`),
      settingsSet: (key, value) => ui.eval(`return await window.shopilot.settings.set(${JSON.stringify(key)}, ${JSON.stringify(value)});`),
      storeCreate: input => ui.eval(`return await window.shopilot.store.create(${JSON.stringify(input)});`),
      state: () => fetchJson(site.base + '/__state')
    }

    const settings = await api.settingsSet('invite.squareUrls', { '抖店': site.base + '/daren-square' })
    check('本地达人广场地址可通过现有设置注入', settings.ok, JSON.stringify(settings.error || settings.data))

    const createdStore = await api.storeCreate({
      name: '抖店邀约本地验收',
      platform: '抖店',
      adminUrl: site.base + '/'
    })
    check('创建抖店本地验收店铺', createdStore.ok && !!createdStore.data?.id, JSON.stringify(createdStore.error || createdStore.data))
    if (!createdStore.ok) throw new Error('store create failed')
    const storeId = createdStore.data.id

    await ui.eval(`location.reload(); return true;`)
    await sleep(3500)
    focusAppWindow(app.pid)
    ui = await connectUi()

    const opened = await ui.eval(`
      const cards = [...document.querySelectorAll('.store-card')];
      const card = cards.find(x => x.textContent.includes('抖店邀约本地验收'));
      if (!card) return false;
      (card.querySelector('.store-action') || card).click();
      return true;
    `)
    check('通过 UI 打开抖店验收店铺', opened)
    await sleep(2200)

    const panelReady = await ui.eval(`
      const taskTab = [...document.querySelectorAll('.ptab')].find(x => x.textContent.trim() === '任务');
      if (!taskTab) return false;
      taskTab.click();
      await new Promise(r => setTimeout(r, 500));
      const inviteTab = document.querySelector('[data-test="task-tab-invite"]');
      if (!inviteTab) return false;
      inviteTab.click();
      await new Promise(r => setTimeout(r, 600));
      return !!document.querySelector('[data-test="invite-panel"]');
    `)
    check('抖店达人邀约面板可打开', panelReady)

    const panelShape = await ui.eval(`return {
      hasScript: !!document.querySelector('[data-test="invite-script"]'),
      scriptMode: !!document.querySelector('[data-test="invite-script-mode-manual"]'),
      hasPhone: !!document.querySelector('[data-test="invite-batch-phone"]'),
      hasWechat: !!document.querySelector('[data-test="invite-batch-wechat"]'),
      hasContact: !!document.querySelector('[data-test="invite-batch-contact"]'),
      hasMainCategory: !!document.querySelector('[data-test="invite-main-category"]'),
      strengthCount: document.querySelectorAll('[data-test^="invite-strength-"]').length
    };`)
    check('改版抽屉的面板形态：无话术区、有手机号/微信号/主营、无"联系人"、核心优势 13 项',
      panelShape.hasScript === false && panelShape.scriptMode === false &&
      panelShape.hasPhone && panelShape.hasWechat && panelShape.hasContact === false &&
      panelShape.hasMainCategory && panelShape.strengthCount === 13,
      JSON.stringify(panelShape))

    const configured = await ui.eval(`
      const openPage = document.querySelector('[data-test="invite-open-page"]');
      if (!openPage) return { error: 'missing-open-page' };
      openPage.click();
      await new Promise(r => setTimeout(r, 4200));
      const level = document.querySelector('[data-test="invite-level-LV0"]');
      const category = document.querySelector('[data-test="invite-category"]');
      const subcategory = document.querySelector('[data-test="invite-subcategory"]');
      const category3 = document.querySelector('[data-test="invite-category3"]');
      const count = document.querySelector('[data-test="invite-count"]');
      const mainCategory = document.querySelector('[data-test="invite-main-category"]');
      if (!level || !category || !subcategory || !category3 || !count || !mainCategory) return { error: 'missing-controls' };
      if (!level.checked) level.click();
      const setValue = (el, value) => {
        const proto = el.tagName === 'TEXTAREA'
          ? HTMLTextAreaElement.prototype
          : el.tagName === 'SELECT'
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setValue(category, '个护家清');
      await new Promise(r => setTimeout(r, 300));
      setValue(subcategory, '家清纸品');
      await new Promise(r => setTimeout(r, 300));
      setValue(category3, '纸品');
      setValue(count, '2');
      setValue(mainCategory, '个护家清/家清纸品');
      setValue(document.querySelector('[data-test="invite-batch-phone"]'), ${JSON.stringify(CONTACT_PHONE)});
      setValue(document.querySelector('[data-test="invite-batch-wechat"]'), ${JSON.stringify(CONTACT_WECHAT)});
      // 核心优势 5 项 + 权益 3 项（平台上限），再多点一个权益验证面板会拦住
      for (const s of ['源头工厂', '品类丰富', '多款爆款', '商品品质高', '售后无忧']) {
        document.querySelector('[data-test="invite-strength-' + s + '"]').click();
        await new Promise(r => setTimeout(r, 60));
      }
      for (const b of ['专属高佣', '免费样品', '佣金可谈']) {
        document.querySelector('[data-test="invite-benefit-' + b + '"]').click();
        await new Promise(r => setTimeout(r, 60));
      }
      document.querySelector('[data-test="invite-benefit-机制可谈"]').click();
      await new Promise(r => setTimeout(r, 700));
      const start = document.querySelector('[data-test="invite-start"]');
      const pickedBenefits = [...document.querySelectorAll('[data-test^="invite-benefit-"]')].filter(x => x.checked).map(x => x.getAttribute('data-test').replace('invite-benefit-', ''));
      return {
        level: level.checked,
        category: category.value,
        subcategory: subcategory.value,
        category3: category3.value,
        category3Options: [...category3.options].map(x => x.value),
        count: count.value,
        mainCategory: mainCategory.value,
        pickedBenefits,
        startDisabled: start ? start.disabled : null
      };
    `)
    check('面板读取真实三级类目并配置可用（个护家清/家清纸品/纸品、LV0、每批 2 位、主营、联系方式）',
      configured.level === true &&
      configured.category === '个护家清' &&
      configured.subcategory === '家清纸品' &&
      configured.category3 === '纸品' &&
      configured.category3Options.includes('纸品') &&
      configured.count === '2' &&
      configured.mainCategory === '个护家清/家清纸品' &&
      configured.startDisabled === false,
      JSON.stringify(configured))
    check('权益按平台上限收敛在 3 项（第 4 项被面板拦下）',
      Array.isArray(configured.pickedBenefits) &&
      configured.pickedBenefits.length === 3 &&
      !configured.pickedBenefits.includes('机制可谈'),
      JSON.stringify(configured.pickedBenefits))

    // ---------- 配置按店铺独立保存（用户要求：每店一份，配置一次就够了） ----------
    const readSetting = (key) => ui.eval(`const r = await window.shopilot.settings.get(${JSON.stringify(key)}); return r.ok ? r.data.value : null;`)
    const writeSetting = (key, value) => ui.eval(`const r = await window.shopilot.settings.set(${JSON.stringify(key)}, ${JSON.stringify(value)}); return r.ok;`)
    const openStoreByName = async (name) => {
      // 刚 reload 完店铺卡片可能还没渲染 → 轮询等一下再点（点不到就会读到空面板）
      for (let i = 0; i < 20; i++) {
        const st = await ui.eval(`
          const cards = [...document.querySelectorAll('.store-card')];
          const card = cards.find(x => x.textContent.includes(${JSON.stringify(name)}));
          if (!card) return { step: 'no-card', cards: cards.length };
          (card.querySelector('.store-action') || card).click();
          await new Promise(r => setTimeout(r, 1200));
          const taskTab = [...document.querySelectorAll('.ptab')].find(x => x.textContent.trim() === '任务');
          if (taskTab) taskTab.click();
          await new Promise(r => setTimeout(r, 500));
          const inv = document.querySelector('[data-test="task-tab-invite"]');
          if (inv) inv.click();
          await new Promise(r => setTimeout(r, 800));
          return { step: 'done', panel: !!document.querySelector('[data-test="invite-panel"]') };
        `)
        if (st && st.step === 'done') { await sleep(800); return true }
        await sleep(800)
      }
      return false
    }

    const storeAKey = 'invite.config.store.' + storeId
    // 显式点「保存配置」→ 立刻落库（不依赖 500ms 防抖）
    const savedNow = await ui.eval(`
      const b = document.querySelector('[data-test="invite-save-config"]');
      if (!b) return { error: 'missing-save-button' };
      b.click();
      await new Promise(r => setTimeout(r, 1200));
      return { clicked: true };
    `)
    check('面板有「保存配置」按钮', savedNow && savedNow.clicked === true, JSON.stringify(savedNow))
    const savedA = await readSetting(storeAKey)
    check('「保存配置」把配置写进**本店铺**的键（invite.config.store.<storeId>）',
      !!savedA && savedA.category === '个护家清' && savedA.subcategory === '家清纸品' && savedA.category3 === '纸品' &&
        savedA.count === 2 && savedA.mainCategory === '个护家清/家清纸品' &&
        savedA.batchPhone === CONTACT_PHONE && savedA.batchWechat === CONTACT_WECHAT &&
        JSON.stringify(savedA.benefits) === JSON.stringify(['专属高佣', '免费样品', '佣金可谈']) &&
        JSON.stringify(savedA.strengths) === JSON.stringify(['源头工厂', '品类丰富', '多款爆款', '商品品质高', '售后无忧']),
      JSON.stringify({ key: storeAKey, saved: savedA }))

    // 旧版本按平台存的键（invite.config.抖店）：给"还没有自己配置的店铺"当初始值
    await writeSetting('invite.config.抖店', {
      category: '个护家清', subcategory: '家清纸品', category3: '', levels: ['LV2'], count: 7, script: '', scriptMode: 'manual',
      benefits: ['免费样品'], strengths: ['多项专利'], mainCategory: '', extraFilters: {},
      batchContact: '', batchPhone: '13900000000', batchWechat: 'legacy_wx', batchProductCount: 1
    })
    const storeB = await api.storeCreate({ name: '抖店验收二号店', platform: '抖店', adminUrl: site.base + '/' })
    check('创建第二家抖店店铺（同平台，用来验证配置互不覆盖）', storeB.ok && !!storeB.data?.id, JSON.stringify(storeB.error || storeB.data))
    const storeBId = storeB.ok ? storeB.data.id : null
    await ui.eval(`location.reload(); return true;`)
    await sleep(3500)
    focusAppWindow(app.pid)
    ui = await connectUi()
    const openedB = await openStoreByName('抖店验收二号店')
    const panelB = await ui.eval(`return {
      category: (document.querySelector('[data-test="invite-category"]') || {}).value,
      subcategory: (document.querySelector('[data-test="invite-subcategory"]') || {}).value,
      count: (document.querySelector('[data-test="invite-count"]') || {}).value,
      phone: (document.querySelector('[data-test="invite-batch-phone"]') || {}).value,
      wechat: (document.querySelector('[data-test="invite-batch-wechat"]') || {}).value
    };`)
    check('新店铺首次打开：用旧版按平台的存档做初始值（迁移老配置）',
      openedB && panelB.category === '个护家清' && panelB.subcategory === '家清纸品' &&
        panelB.count === '7' && panelB.phone === '13900000000' && panelB.wechat === 'legacy_wx',
      JSON.stringify(panelB))
    const migratedB = await readSetting('invite.config.store.' + storeBId)
    check('迁移后 B 店写出自己的键（此后与 A 店各自独立）',
      !!migratedB && migratedB.count === 7 && migratedB.batchPhone === '13900000000',
      JSON.stringify({ key: 'invite.config.store.' + storeBId, saved: migratedB }))

    // B 店改成自己的配置 → A 店那份不能被改动
    await ui.eval(`
      const setV = (el, v) => {
        const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      setV(document.querySelector('[data-test="invite-count"]'), '3');
      setV(document.querySelector('[data-test="invite-batch-phone"]'), '13811112222');
      setV(document.querySelector('[data-test="invite-batch-wechat"]'), 'store_b_wx');
      await new Promise(r => setTimeout(r, 1500));
      return true;
    `)
    await sleep(1200)
    const savedAAfter = await readSetting(storeAKey)
    const savedBAfter = await readSetting('invite.config.store.' + storeBId)
    check('B 店改动只写自己的键：A 店那份一字未动',
      !!savedAAfter && savedAAfter.count === 2 && savedAAfter.batchPhone === CONTACT_PHONE &&
        savedAAfter.category3 === '纸品' &&
        !!savedBAfter && savedBAfter.count === 3 && savedBAfter.batchPhone === '13811112222',
      JSON.stringify({ a: { count: savedAAfter && savedAAfter.count, phone: savedAAfter && savedAAfter.batchPhone }, b: { count: savedBAfter && savedBAfter.count, phone: savedBAfter && savedBAfter.batchPhone } }))

    // 切回 A 店 → 面板恢复 A 店自己的配置（这才是"配置一次就够"的实际体验）
    focusAppWindow(app.pid)
    const openedA = await openStoreByName('抖店邀约本地验收')
    const panelA = await ui.eval(`return {
      category: (document.querySelector('[data-test="invite-category"]') || {}).value,
      subcategory: (document.querySelector('[data-test="invite-subcategory"]') || {}).value,
      category3: (document.querySelector('[data-test="invite-category3"]') || {}).value,
      count: (document.querySelector('[data-test="invite-count"]') || {}).value,
      mainCategory: (document.querySelector('[data-test="invite-main-category"]') || {}).value,
      phone: (document.querySelector('[data-test="invite-batch-phone"]') || {}).value,
      strengths: [...document.querySelectorAll('[data-test^="invite-strength-"]')].filter(x => x.checked).length
    };`)
    check('切回 A 店：面板恢复 A 店自己的配置（含三级类目/主营/联系方式/核心优势）',
      openedA && panelA.category === '个护家清' && panelA.subcategory === '家清纸品' && panelA.category3 === '纸品' &&
        panelA.count === '2' && panelA.mainCategory === '个护家清/家清纸品' &&
        panelA.phone === CONTACT_PHONE && panelA.strengths === 5,
      JSON.stringify(panelA))

    const clicked = await ui.eval(`
      const start = document.querySelector('[data-test="invite-start"]');
      if (!start || start.disabled) return false;
      start.click();
      start.click();
      await new Promise(r => setTimeout(r, 1000));
      return true;
    `)
    check('通过 UI「开始邀约」创建并启动任务', clicked)

    let task = null
    for (let i = 0; i < 30 && !task; i++) {
      const listed = await api.taskList()
      if (listed.ok) task = (listed.data || []).find(t => t.storeScope === storeId && String(t.name).startsWith('达人邀约 · 抖店'))
      if (!task) await sleep(300)
    }
    const allTasks = await api.taskList()
    check('快速双击仅创建一个邀约任务', allTasks.ok && allTasks.data.filter(t => t.storeScope === storeId && t.name.startsWith('达人邀约 · 抖店')).length === 1)
    check('任务列表出现抖店邀约任务', !!task, task ? `${task.name} / ${task.latestRun?.status}` : 'not found')
    if (!task?.latestRun?.id) throw new Error('invite task not created')
    const runId = task.latestRun.id

    // 步骤定义直接来自任务本身（无门禁后不再有"跑到门禁停下来看步骤"这个时机）
    const innerSteps = (task.steps && task.steps[0] && task.steps[0].input && task.steps[0].input.steps) || []
    const types = innerSteps.map(s => s.type)
    check('任务定义里没有人工确认门禁（用户要求：达人邀约不需要人工允许，直接执行）',
      !types.includes('waitForUserConfirmation'),
      JSON.stringify(types))

    const clickAllDefinition = innerSteps.find(s => s.type === 'clickAll')
    check('邀约任务包含抖店批量勾选步骤（最多 2 位、允许滚动续选）',
      clickAllDefinition?.input?.selector === 'tbody input[type=checkbox]' &&
      clickAllDefinition?.input?.max === 2 &&
      clickAllDefinition?.input?.scroll === true,
      JSON.stringify(clickAllDefinition?.input || null))
    const hoverStep = innerSteps.find(s => s.type === 'hover')
    check('三级类目：悬停二级（限定在级联弹层内）→ 再真实点击三级叶子',
      hoverStep?.input?.text === '家清纸品' &&
        hoverStep?.input?.within?.selector === '.quick-filter-cascader-popover' &&
        innerSteps.find(s => s.type === 'clickByText' && s.input?.text === '纸品')?.input?.exact === true &&
        innerSteps.findIndex(s => s.type === 'hover') < innerSteps.findIndex(s => s.type === 'clickByText' && s.input?.text === '纸品'),
      JSON.stringify({ hover: hoverStep?.input || null }))
    check('改版抽屉：没有写话术的步骤；抽屉判据用根容器',
      !types.includes('aiGenerate') &&
        !types.includes('readText') &&
        !innerSteps.some(s => s.type === 'waitForSelector' && String(s.input?.selector) === 'textarea') &&
        innerSteps.some(s => s.type === 'waitForSelector' && String(s.input?.selector).includes('auxo-drawer')) &&
        innerSteps.some(s => s.type === 'waitForGone' && String(s.input?.selector).includes('auxo-drawer')),
      JSON.stringify(types))
    const drawerContacts = innerSteps.filter(s => s.type === 'setInput').map(s => String(s.input.selector))
    const goodsAssert = innerSteps.find(s => s.type === 'requireQuota' && String(s.input?.textIncludes) === '已添加')
    check('必填项都在发送前处理：手机号/微信号 + 推荐商品开关（错误码不是额度类）',
      drawerContacts.includes('#phone') && drawerContacts.includes('#wechat') &&
        goodsAssert?.input?.code === 'TASK_PRODUCT_NOT_SELECTED' &&
        innerSteps.some(s => s.type === 'clickByText' && String(s.input?.text) === '使用平台推荐商品'),
      JSON.stringify({ drawerContacts, goods: goodsAssert?.input || null }))
    check('平台"记住上次填写"的字段都按幂等方式填（skipIfChecked / 触发器按选择器真点）',
      innerSteps.some(s => s.type === 'click' && s.input?.selector === '.auxo-cascader-multiple-wrapper' && s.input?.mode === 'real') &&
        innerSteps.filter(s => s.type === 'clickByText' && s.input?.skipIfChecked === true).length >= 5,
      JSON.stringify({
        trigger: innerSteps.find(s => s.type === 'click')?.input || null,
        skipCount: innerSteps.filter(s => s.type === 'clickByText' && s.input?.skipIfChecked === true).length
      }))

    // ---------- 无人工确认门禁：点下「开始邀约」后直接连续发送，跑到额度用完为止 ----------
    const started = await pollRun(api, runId, data => data.run.status === 'running', 30000)
    check('任务直接开跑（用户要求：不设人工确认门禁，点下即真实发送）',
      !!started && started.steps?.[0]?.input?.steps?.some(s => s.type === 'waitForUserConfirmation') === false,
      JSON.stringify({ status: started?.run?.status }))

    let terminal = null
    const t0 = Date.now()
    for (;;) {
      const data = await api.taskResults(runId)
      const st = data && data.ok && data.data ? data.data.run.status : null
      // 出现等待确认就说明门禁还在（用户明确不要）——如实失败，别让它静静停着
      if (st === 'waiting_confirmation') {
        check('运行不应停在人工确认门禁', false, '仍出现了 waiting_confirmation')
        await api.taskConfirm(runId, true)
      }
      if (['succeeded', 'failed', 'cancelled'].includes(st)) { terminal = data.data; break }
      if (Date.now() - t0 > 150000) break
      await sleep(600)
    }
    check('仿真发送后任务成功收尾', terminal?.run.status === 'succeeded',
      terminal ? `${terminal.run.status} / ${terminal.run.errorMessage || terminal.run.statusReason || ''}` : 'no run data')

    await sleep(1000)
    const finalState = await api.state()
    check('仿真平台收到 2 批（每批 2 位），不重复发送',
      finalState.sentBatches === 2 && finalState.sentCount === 4,
      JSON.stringify({ sentBatches: finalState.sentBatches, sentCount: finalState.sentCount }))
    check('两批邀约的是**不同**的达人（发出去的达人在下一轮变成禁用态，不会被重复邀约）',
      finalState.invitedKeys.length === 4 &&
        JSON.stringify(finalState.sends[0].keys) !== JSON.stringify(finalState.sends[1].keys),
      JSON.stringify({ invitedKeys: finalState.invitedKeys, keys1: finalState.sends[0].keys, keys2: finalState.sends[1].keys }))
    const drawerOk = (d) => d &&
      d.mainCategory === '个护家清/家清纸品' &&
      JSON.stringify(d.strengths) === JSON.stringify(['源头工厂', '品类丰富', '多款爆款', '商品品质高', '售后无忧']) &&
      JSON.stringify(d.benefits) === JSON.stringify(['专属高佣', '免费样品', '佣金可谈']) &&
      d.phone === CONTACT_PHONE &&
      d.wechat === CONTACT_WECHAT &&
      d.goodsAdded >= 1
    check('抽屉里的结构化表单按面板配置真的填好了（主营/核心优势/权益/联系方式/推荐商品）',
      drawerOk(finalState.sends[0] && finalState.sends[0].drawer),
      JSON.stringify(finalState.sends[0] && finalState.sends[0].drawer))
    // 第 2 轮的抽屉是"平台记住上次填写"的状态：流程若不带 skipIfChecked / 按文案找触发器，
    // 这里就会看到已选项被点掉（真机踩到的正是这个）。
    check('第 2 轮复发：记住的填写没有被"再点一遍"取消（幂等填写）',
      drawerOk(finalState.sends[1] && finalState.sends[1].drawer) &&
        JSON.stringify(finalState.sends[1].drawer) === JSON.stringify(finalState.sends[0].drawer),
      JSON.stringify(finalState.sends[1] && finalState.sends[1].drawer))
    check('发送后下一轮额度用尽并触发正常停止',
      finalState.quotaExhausted === true,
      JSON.stringify({ quotaExhausted: finalState.quotaExhausted }))

    // 页面侧取证：跑完之后广场上仍留着本轮筛选的痕迹（每轮都会重新筛选一次）
    const page = await connectPage('/daren-square')
    const pageState = await page.eval(`
      const third = document.getElementById('category-third-leaf');
      return {
        filtered: (document.getElementById('filtered-value') || {}).innerText || '',
        thirdVisible: !!third && getComputedStyle(third).display !== 'none',
        scriptTextarea: !!document.querySelector('#drawer textarea'),
        drawerOpen: !!document.querySelector('#drawer.auxo-drawer-open')
      };
    `)
    check('仿真平台三级类目筛选真实生效（三级靠悬停展开、点二级不会生效）',
      /个护家清/.test(pageState.filtered) &&
        /家清纸品/.test(pageState.filtered) &&
        /（纸品）/.test(pageState.filtered) &&
        !/纸品用品/.test(pageState.filtered),
      JSON.stringify({ filtered: pageState.filtered }))
    // 只断言"没有话术框"：**抽屉停在打开态是预期的**——最后一轮是走到"确认发送可用性预检"
    // 才因额度用尽收工的（那时抽屉刚打开、还没发送），下一次运行开头的 navigate 会重新加载页面。
    // "发送后抽屉关闭"由每轮里的 waitForGone 校验（没关就不会成功收尾，见上面那条断言）。
    check('改版抽屉里没有话术 textarea（消息由选项拼装）',
      pageState.scriptTextarea === false,
      JSON.stringify({ textarea: pageState.scriptTextarea, drawerOpen: pageState.drawerOpen }))
    const gesture = await page.eval(`return {
      hoverExpands: window.__gesture ? window.__gesture.hoverExpands : null,
      secondLevelClicks: window.__gesture ? window.__gesture.secondLevelClicks : null
    };`)
    // 三级列在选中后随弹层一起收起（真机也是如此），所以判据是"悬停次数 > 0 且从未点过二级项"
    // —— 点二级项会只应用两级并收起弹层，那样三级就永远点不到
    check('三级列是靠**悬停**展开的，全程没有点过二级项（点二级=只应用两级并收起弹层）',
      gesture.hoverExpands > 0 && gesture.secondLevelClicks === 0,
      JSON.stringify(gesture))

    const loopResult = terminal?.results?.find(r => r.kind === 'executed' && r.payload?.action === 'loop')
    check('循环结果记录额度用尽停止原因（跑满 2 批）',
      loopResult?.payload?.stopReason === 'TASK_QUOTA_EXCEEDED' && loopResult?.payload?.completedRounds === 2,
      JSON.stringify(loopResult?.payload ? {
        completedRounds: loopResult.payload.completedRounds,
        stopReason: loopResult.payload.stopReason
      } : null))

    check('发送后截图留档并落盘',
      !!loopResult?.artifactPath && fs.existsSync(loopResult.artifactPath),
      loopResult ? JSON.stringify({ path: loopResult.artifactPath, sha256: loopResult.artifactSha256?.slice(0, 12) }) : 'no screenshot')

    const deleted = await api.taskDelete(task.id)
    check('验收任务可删除（级联清理运行记录）', deleted.ok)
    page.close()
  } catch (error) {
    check('验收执行未中断', false, String(error?.stack || error))
  } finally {
    ui?.close()
    killTree(app)
    await sleep(1000)
    await site.close()
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* 临时目录由系统回收 */ }
  }

  const passed = results.filter(r => r.ok).length
  console.log(`\n通过 ${passed}/${results.length}`)
  if (passed !== results.length) process.exit(1)
  console.log('ALL_DOUYIN_INVITE_LOCAL_ACCEPTANCE_PASSED')
}

main().catch(error => {
  console.error('RUNNER_ERROR', error)
  process.exit(1)
})
