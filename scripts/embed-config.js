'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'docs', 'config.html'), 'utf8');
const output = path.join(root, 'src', 'pkjs', 'config-page.json');
fs.writeFileSync(output, JSON.stringify({ html }) + '\n');
console.log(`Wrote ${path.relative(root, output)} (${html.length} HTML characters)`);
