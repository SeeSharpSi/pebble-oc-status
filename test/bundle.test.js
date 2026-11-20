'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const packageJson = require('../package.json');

function combinedPageScript() {
  const html = fs.readFileSync(path.join(root, 'src/config.html'), 'utf8');
  const match = html.match(/<!-- ocstatus:settings-script -->\s*<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'combined config page includes OC Status settings script');
  return match[1];
}

function createSettingsPage(options = {}) {
  const listeners = {};
  const sent = [];
  const elements = new Map();
  const radios = {};
  for (const [name, values] of Object.entries({
    ocstatus_poll_rate: ['0', '10', '30', '60'],
    ocstatus_mark_read_after: ['0', '300', '900', '1800', '3600', '7200', '86400'],
    ocstatus_subagents: ['show', 'number', 'hide']
  })) {
    radios[name] = values.map(value => ({ name, value, checked: false }));
  }
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id, value: '', textContent: '', disabled: false, checked: false,
        attributes: {}, listeners: {},
        classList: { toggle() {} },
        addEventListener(type, handler) { this.listeners[type] = handler; },
        setAttribute(name, value) { this.attributes[name] = value; }
      });
    }
    return elements.get(id);
  }
  const document = {
    getElementById: element,
    querySelectorAll(selector) {
      const match = selector.match(/^input\[name="([^"]+)"\]$/);
      return match ? radios[match[1]] || [] : [];
    },
    querySelector(selector) {
      const match = selector.match(/^input\[name="([^"]+)"\]:checked$/);
      return match ? (radios[match[1]] || []).find(radio => radio.checked) || null : null;
    }
  };
  const Pebble = {
    addEventListener(type, callback) { listeners[type] = callback; },
    readyTargets() { return options.readyTargets || []; },
    sendMessage(target, message) {
      sent.push({ target, message: structuredClone(message) });
      if (target !== 'pkjs') throw new Error('Unexpected target: ' + target);
      if (message.type === 'ocstatus_settings') {
        if (options.loadError) return Promise.reject(new Error(options.loadError));
        return Promise.resolve(options.saved || {
          poll_rate: 30,
          only_action: 1,
          subagents: 'number',
          mark_read_after: 900,
          canned_replies: ['Go', 'Run tests']
        });
      }
      if (message.type === 'ocstatus_save_settings') {
        return Promise.resolve(message.settings);
      }
      throw new Error('Unexpected message type: ' + message.type);
    }
  };
  const context = vm.createContext({
    document, Pebble, Promise, Array, String, Number, Error, Object, console,
    structuredClone
  });
  vm.runInContext(combinedPageScript(), context, { filename: 'src/config.html:ocstatus-settings' });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return {
    document, radios, sent, listeners, flush,
    async ready(target) { listeners.ready({ target }); await flush(); },
    async save() { element('ocstatusSave').listeners.click(); await flush(); }
  };
}

test('combined manifest preserves watchapp identity and references generated plugin assets', () => {
  const pebble = packageJson.pebble;
  assert.equal(pebble.uuid, '67166e14-419d-42b3-9bb4-af34cc83b436');
  assert.deepEqual(pebble.targetPlatforms, ['aplite', 'basalt', 'chalk', 'diorite', 'emery', 'flint', 'gabbro']);
  assert.equal(pebble.projectType, undefined);
  assert.equal(pebble.configPage, 'src/config.html');
  assert.equal(pebble.plugin.script, 'src/plugin/index.js');
  assert.ok(Array.isArray(pebble.plugin.sources) && pebble.plugin.sources.length > 0);
  assert.ok(Array.isArray(pebble.plugin.actions) && pebble.plugin.actions.length > 0);
  assert.deepEqual(pebble.usesPermissions.map(permission =>
    typeof permission === 'string' ? permission : permission.name),
  ['Internet', 'LocalNetwork', 'ShowNotifications', 'InvokeAction']);
  assert.equal(pebble.usesPermissions.find(permission => permission.name === 'ShowNotifications').required, false);
  const legacyAction = pebble.usesPermissions.find(permission => permission.name === 'InvokeAction');
  assert.equal(legacyAction.plugin, '4e2c758f-8a31-4bf2-a6d9-7c40ec9b5173');
  assert.equal(legacyAction.required, false);
  assert.notEqual(legacyAction.plugin, pebble.uuid);
  assert.ok(pebble.messageKeys.includes('open_reply'));
  assert.ok(fs.existsSync(path.join(root, pebble.plugin.script)));
  assert.ok(fs.existsSync(path.join(root, pebble.configPage)));
  assert.match(fs.readFileSync(path.join(root, pebble.plugin.script), 'utf8'),
    /^globalThis\.__ocStatusBundled = true;\n/);
});

test('bundled settings wait for PKJS ready before applying saved values and send settings through pkjs', async () => {
  const page = createSettingsPage();
  assert.deepEqual(page.sent, []);
  assert.equal(page.document.getElementById('ocstatusControls').disabled, true);
  await page.ready('plugin');
  assert.deepEqual(page.sent, [], 'plugin readiness must not initialize local watch settings');
  await page.ready('pkjs');
  assert.deepEqual(page.sent, [{ target: 'pkjs', message: { type: 'ocstatus_settings' } }]);
  assert.equal(page.radios.ocstatus_poll_rate.find(radio => radio.checked).value, '30');
  assert.equal(page.radios.ocstatus_mark_read_after.find(radio => radio.checked).value, '900');
  assert.equal(page.radios.ocstatus_subagents.find(radio => radio.checked).value, 'number');
  assert.equal(page.document.getElementById('ocstatus_only_action').checked, true);
  assert.equal(page.document.getElementById('ocstatus_canned_replies').value, 'Go\nRun tests');

  page.radios.ocstatus_poll_rate.forEach(radio => { radio.checked = radio.value === '10'; });
  page.radios.ocstatus_mark_read_after.forEach(radio => { radio.checked = radio.value === '300'; });
  page.radios.ocstatus_subagents.forEach(radio => { radio.checked = radio.value === 'hide'; });
  page.document.getElementById('ocstatus_only_action').checked = false;
  page.document.getElementById('ocstatus_canned_replies').value = 'Continue\nRun tests';
  await page.save();
  assert.deepEqual(page.sent[1], {
    target: 'pkjs',
    message: {
      type: 'ocstatus_save_settings',
      settings: {
        poll_rate: 10,
        only_action: 0,
        subagents: 'hide',
        mark_read_after: 300,
        canned_replies: ['Continue', 'Run tests']
      }
    }
  });
  assert.match(page.document.getElementById('ocstatusFeedback').textContent, /saved/i);
});

test('late ready replay loads saved settings and failed load never enables default-overwrite save', async () => {
  const late = createSettingsPage({ readyTargets: ['pkjs'] });
  await late.flush();
  assert.deepEqual(late.sent, [{ target: 'pkjs', message: { type: 'ocstatus_settings' } }]);
  assert.equal(late.radios.ocstatus_subagents.find(radio => radio.checked).value, 'number');

  const unavailable = createSettingsPage({ readyTargets: ['pkjs'], loadError: 'PKJS unavailable' });
  await unavailable.flush();
  assert.equal(unavailable.document.getElementById('ocstatusControls').disabled, true);
  assert.equal(unavailable.document.getElementById('ocstatusSave').disabled, true);
  assert.match(unavailable.document.getElementById('ocstatusFeedback').textContent, /unavailable/i);
  assert.equal(unavailable.sent.some(call => call.message.type === 'ocstatus_save_settings'), false);
});

test('generated config and script are consumable and sync check passes', () => {
  const html = fs.readFileSync(path.join(root, 'src/config.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert.equal(scripts.length, 2, 'plugin config runtime plus watch settings runtime');
  for (const script of scripts) new vm.Script(script);
  for (const id of ['ocstatusPreferences', 'ocstatusControls', 'ocstatusSave', 'replyAlerts']) {
    assert.match(html, new RegExp('\\bid="' + id + '"'), `combined config page has #${id}`);
  }
  assert.match(html, /Pebble\.sendMessage\('pkjs', message\)/);
  assert.match(html, /Pebble\.readyTargets\(\)/);
  assert.match(html, /Pebble\.sendMessage\('plugin',\s*message\)/);
  const pluginScript = fs.readFileSync(path.join(root, 'src/plugin/index.js'), 'utf8');
  new vm.Script(pluginScript);
  assert.match(pluginScript, /globalThis\.__ocStatusBundled = true;/);
});
