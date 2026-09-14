/** 列出 CDP 目标 */
const PORT = process.env.SHOPILOT_CDP_PORT || '9250'
fetch(`http://127.0.0.1:${PORT}/json/list`)
  .then(r => r.json())
  .then(list => {
    console.log('targets', list.length)
    for (const t of list) console.log(t.type, '|', String(t.url).slice(0, 140))
    process.exit(0)
  })
  .catch(e => { console.log('ERR', e.message); process.exit(1) })
