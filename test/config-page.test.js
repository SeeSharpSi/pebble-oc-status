'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const template = fs.readFileSync(path.join(root, 'docs/config.html'), 'utf8');

function runSettings(options = {}) {
  const pollRadios = ['0', '10', '30', '60'].map(value => ({ name: 'poll_rate', value }));
  const markRadios = ['0', '300', '900', '1800', '3600', '7200', '86400']
    .map(value => ({ name: 'mark_read_after', value }));
  const subagentRadios = ['show', 'number', 'hide']
    .map(value => ({ name: 'subagents', value }));
  const checkbox = { checked: false };
  const canned = { value: 'Continue\nYes\nNo\nRun tests' };
  const elements = {
    only_action: checkbox,
    canned_replies: canned,
    save: { addEventListener: (event, handler) => { if (event === 'click') save = handler; } }
  };
  let save;
  let savedLocation;
  const document = {
    querySelectorAll(selector) {
      if (selector === 'input[name="poll_rate"]') return pollRadios;
      if (selector === 'input[name="mark_read_after"]') return markRadios;
      if (selector === 'input[name="subagents"]') return subagentRadios;
      return [];
    },
    querySelector(selector) {
      const match = selector.match(/^input\[name="([^"]+)"\]:checked$/);
      if (!match) return null;
      return [pollRadios, markRadios, subagentRadios]
        .flat().find(radio => radio.name === match[1] && radio.checked) || null;
    },
    getElementById(id) { return elements[id]; }
  };
  Object.defineProperty(document, 'location', { set(value) { savedLocation = value; } });

  let html = template;
  if (Object.hasOwn(options, 'injectedSubagents')) {
    html = html.replaceAll('__OC_SUBAGENTS__', options.injectedSubagents);
  }
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, {
    document,
    location: { hash: options.hash || '', search: options.search || '' },
    isFinite,
    Number,
    Array,
    encodeURIComponent,
    JSON
  });
  return {
    pollRadios,
    markRadios,
    subagentRadios,
    checkbox,
    canned,
    save: () => {
      save();
      return JSON.parse(decodeURIComponent(savedLocation.slice(savedLocation.indexOf('#') + 1)));
    }
  };
}

function checkedValue(radios) {
  const selected = radios.find(radio => radio.checked);
  return selected && selected.value;
}

test('subagents defaults to Show when missing or invalid', () => {
  assert.equal(checkedValue(runSettings().subagentRadios), 'show');
  assert.equal(checkedValue(runSettings({ injectedSubagents: 'unexpected' }).subagentRadios), 'show');
  assert.equal(checkedValue(runSettings({ hash: '#subagents=unexpected' }).subagentRadios), 'show');
});

test('subagents accepts injected modes and standalone hash fallback', () => {
  for (const mode of ['show', 'number', 'hide']) {
    assert.equal(checkedValue(runSettings({ injectedSubagents: mode }).subagentRadios), mode);
    assert.equal(checkedValue(runSettings({ hash: `#subagents=${mode}` }).subagentRadios), mode);
  }
});

test('saving retains existing settings and adds selected subagent mode', () => {
  const settings = runSettings({
    injectedSubagents: 'number',
    hash: '#poll_rate=30&only_action=1&mark_read_after=900'
  });
  settings.canned.value = 'Keep\nGoing';
  assert.deepEqual(settings.save(), {
    poll_rate: 30,
    only_action: 1,
    mark_read_after: 900,
    subagents: 'number',
    canned_replies: ['Keep', 'Going']
  });
});

test('embedded settings HTML matches template and includes subagent warning', () => {
  const embedded = JSON.parse(fs.readFileSync(path.join(root, 'src/pkjs/config-page.json'), 'utf8'));
  assert.equal(embedded.html, template);
  assert.ok(template.includes('Number and Hide also hide subagent questions and permission requests from the watch list. They are not forwarded to the parent session. Open OpenCode on your phone or computer to respond.'));
});
