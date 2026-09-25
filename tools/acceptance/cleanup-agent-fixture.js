/* Remove only the memory files created by agent-domain-cdp-verify.js. */
const fs = require('fs')
const path = require('path')
const root = path.resolve(process.env.APPDATA || '', 'ShopPilot', 'agent-memory')
const agentsRoot = path.join(root, 'agents')
if (!fs.existsSync(root)) process.exit(0)
const removedIds = []
for (const agentId of fs.existsSync(agentsRoot) ? fs.readdirSync(agentsRoot) : []) {
  const dir = path.join(agentsRoot, agentId)
  if (!fs.statSync(dir).isDirectory()) continue
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue
    const file = path.join(dir, name)
    const body = fs.readFileSync(file, 'utf8')
    if (!body.includes('抖店库存低于 10 件时，先读取页面证据再提交给 CEO 审核。')) continue
    const resolved = path.resolve(file)
    if (!resolved.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw new Error(`unexpected memory path: ${resolved}`)
    fs.unlinkSync(resolved)
    removedIds.push(path.basename(name, '.md'))
  }
}
const manifestPath = path.join(root, 'manifest.json')
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.entries = (manifest.entries || []).filter(entry => !removedIds.includes(entry.id))
  manifest.generatedAt = Date.now()
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
}
let removedSnapshots = 0
for (const name of fs.readdirSync(root)) {
  if (!/^snapshot-179023\d+\.bin$/.test(name)) continue
  const file = path.resolve(root, name)
  if (!file.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw new Error(`unexpected snapshot path: ${file}`)
  fs.unlinkSync(file)
  removedSnapshots++
}
console.log(JSON.stringify({ root, removedMemoryFiles: removedIds.length, removedSnapshots, remainingManifestEntries: fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')).entries.length : 0 }))
