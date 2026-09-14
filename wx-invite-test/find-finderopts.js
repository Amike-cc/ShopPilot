const fs = require('fs')
const L = fs.readFileSync('apps/desktop/src/renderer/src/features/workbench/WorkbenchView.vue', 'utf8').split(/\r?\n/)
L.forEach((l, i) => { if (/finderCategor|finderType/.test(l)) console.log((i + 1) + ': ' + l.trim().slice(0, 120)) })
