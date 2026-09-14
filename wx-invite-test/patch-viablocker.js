const fs = require('fs')
const p = 'apps/desktop/src/main/tasks/task-runner.ts'
const raw = fs.readFileSync(p, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'
const oldBlock = `    const blocker = deepAt(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return { ok: false, reason: 'COVERED', coveredBy: blocker ? blocker.tagName + '.' + String(blocker.className || '').slice(0, 40) : 'unknown' };`
const newBlock = `    const blocker = deepAt(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    // 遮挡者若是"同一行/同一卡片里的可点链接"（平台常把整卡做成 <a> 覆盖住里面的按钮），
    // 点它就是用户实际会做的事（实测微信广场的「详情」被 A.w-full text-right 盖住）。
    // 限定同一行内才算，跨行绝不乱点。
    const rowOf = (el) => el.closest('tr, li, [data-row-key], [class*="card"], [class*="dorami"]') || el.parentElement;
    if (blocker) {
      let anc = blocker;
      for (let i = 0; i < 4 && anc; i++, anc = anc.parentElement) {
        const tag = anc.tagName;
        const interactive = tag === 'A' || tag === 'BUTTON' || tag === 'LABEL' || anc.getAttribute('role') === 'button';
        if (interactive && rowOf(anc) === rowOf(hit)) {
          return { ok: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), clickedText: String(hit.innerText || '').replace(/\\\\s+/g, ' ').trim().slice(0, 40), candidates: cands.length, viaBlocker: tag + '.' + String(anc.className || '').slice(0, 30) };
        }
      }
    }
    return { ok: false, reason: 'COVERED', coveredBy: blocker ? blocker.tagName + '.' + String(blocker.className || '').slice(0, 40) : 'unknown' };`
if (!raw.includes(oldBlock)) throw new Error('old block not found')
fs.writeFileSync(p, raw.replace(oldBlock, newBlock))
console.log('patched viaBlocker logic')
