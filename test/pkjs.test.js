'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const OPENCODE_UUID = '4e2c758f-8a31-4bf2-a6d9-7c40ec9b5173';
const BUNDLED_OPENCODE_UUID = '67166e14-419d-42b3-9bb4-af34cc83b436';

function harness(options = {}) {
  const handlers = {};
  const subscriptions = [];
  const sent = [];
  const storage = new Map();
  Object.keys(options.storage || {}).forEach((key) => storage.set(key, options.storage[key]));
  const actions = [];
  const opened = [];
  const reads = [];
  const sourceEnvelopes = new Map();
  const timers = new Map();
  const pendingAcks = [];
  const deferredReads = [];
  let nextTimer = 0;
  let now = options.now === undefined ? Date.now() : options.now;
  let replyEnvelope = options.reply || null;
  let repliesEnvelope = options.replies || null;
  let permissionEnvelope = options.permission || null;
  let installed = options.installed !== false;
  let plugins = options.plugins || [{ uuid: OPENCODE_UUID, name: 'OpenCode' }];

  const Pebble = {
    enumeratePlugins() {
      return installed ? plugins : [];
    },
    subscribeToSource(config) {
      subscriptions.push(config);
      return {
        unsubscribe() {
          const index = subscriptions.indexOf(config);
          if (index >= 0) subscriptions.splice(index, 1);
        }
      };
    },
    readSource(request) {
      reads.push(request);
      if (Array.isArray(options.deferReads) && options.deferReads.includes(request.item)) {
        return new Promise((resolve, reject) => deferredReads.push({
          item: request.item, request, resolve, reject
        }));
      }
      if (request.item === 'reply' && replyEnvelope) return Promise.resolve(replyEnvelope);
      if (request.item === 'replies' && repliesEnvelope) return Promise.resolve(repliesEnvelope);
      if (request.item === 'permission') {
        return Promise.resolve(permissionEnvelope || { instances: [] });
      }
      if (sourceEnvelopes.has(request.item)) return Promise.resolve(sourceEnvelopes.get(request.item));
      return Promise.reject(Object.assign(new Error('No reply'), { code: 'PLUGIN_UNAVAILABLE' }));
    },
    invokeAction(request) {
      actions.push(request);
      return Promise.resolve({ ok: true, text: 'Answer sent.' });
    },
    openURL(url) {
      opened.push(url);
    },
    sendAppMessage(message, success, failure) {
      sent.push(message);
      if (options.deferAcks) pendingAcks.push({ success, failure });
      else if (success) success();
    },
    addEventListener(name, callback) {
      handlers[name] = callback;
    }
  };

  const sandbox = {
    Pebble,
    console: { log() {} },
    localStorage: {
      getItem(key) {
        if (options.failStorageReadKey === key) throw new Error('storage unavailable');
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        if (options.failStorageWrites) throw new Error('storage unavailable');
        storage.set(key, String(value));
      },
      removeItem(key) { storage.delete(key); }
    },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    require(name) {
      if (name === './config-page.json') {
        return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'pkjs', 'config-page.json'), 'utf8'));
      }
      throw new Error('Unexpected require: ' + name);
    },
    Promise,
    Date: { now() { return now; } },
    JSON,
    Math,
    Object,
    Array,
    String,
    Number,
    isFinite
  };

  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'pkjs', 'index.js'), 'utf8'), sandbox);
  Pebble.addEventListener('ready', handlers.ready);
  handlers.ready({});
  function runTimerWithDelay(delay) {
    const entry = Array.from(timers.entries()).find(([, timer]) => timer.delay === delay);
    if (!entry) return false;
    timers.delete(entry[0]);
    entry[1].callback();
    return true;
  }
  const savedSettings = JSON.parse((options.storage || {})['ocstatus.settings.v1'] || '{}');
  if (!options.deferStartup && !savedSettings.poll_rate) runTimerWithDelay(1500);

  function fire(category, item, envelope) {
    const subscription = subscriptions.find((entry) => entry.category === category && entry.item === item);
    assert.ok(subscription, `no subscription for ${category}/${item}`);
    subscription.onData(envelope);
  }

  function watch(payload) {
    handlers.appmessage({ payload });
  }

  function takeSent() {
    return sent.splice(0, sent.length);
  }

  function runTimers() {
    const due = Array.from(timers.values()).map((timer) => timer.callback);
    timers.clear();
    due.forEach((callback) => callback());
  }

  function advanceTime(ms) { now += ms; }

  function ackNext(error) {
    const ack = pendingAcks.shift();
    assert.ok(ack, 'no pending AppMessage acknowledgement');
    if (error) ack.failure(error);
    else ack.success();
  }

  function ackAll() {
    while (pendingAcks.length) ackNext();
  }

  function resolveRead(item, envelope, index = 0) {
    const match = deferredReads.filter((read) => read.item === item)[index];
    assert.ok(match, `no deferred read for ${item}`);
    deferredReads.splice(deferredReads.indexOf(match), 1);
    match.resolve(envelope);
  }

  function sessionMessages(messages) {
    const end = messages.map((message, index) => message.list_end ? index : -1).filter((index) => index >= 0).pop();
    const start = end === undefined ? 0 : messages.reduce((found, message, index) => {
      return message.list_begin && index < end ? index : found;
    }, 0);
    const snapshot = end === undefined ? messages : messages.slice(start, end + 1);
    return snapshot
      .filter((message) => message.index !== undefined && message.session_id !== undefined)
      .sort((a, b) => a.index - b.index)
      .map((message) => ({
        id: message.session_id,
        name: message.session_name,
        flags: message.session_flags
      }));
  }

  return {
    Pebble, handlers, subscriptions, actions, opened, fire, watch, takeSent, sessionMessages, runTimers,
    advanceTime, ackNext, ackAll, pendingAcks, deferredReads, resolveRead, runTimerWithDelay,
    setReply(envelope) { replyEnvelope = envelope; },
    setReplies(envelope) { repliesEnvelope = envelope; },
    setPermission(envelope) { permissionEnvelope = envelope; },
    setSource(item, envelope) { sourceEnvelopes.set(item, envelope); },
    setInstalled(value) { installed = value; },
    setPlugins(value) { plugins = value; },
    reads,
    storage
  };
}

function session(id, name, status = 'Running') {
  return {
    instanceId: id,
    properties: {
      name: { shortText: { text: name.slice(0, 7) }, longText: { text: name } },
      title: { longText: { text: name } },
      status: { shortText: { text: status.slice(0, 7) }, longText: { text: status } },
      is_subagent: { boolean: { value: false } },
      updated: { timestamp: { value: 1700000000 } }
    }
  };
}

function subagentSession(id, rootId, parentId, name = id, status = 'Running') {
  const instance = session(id, name, status);
  instance.properties.is_subagent.boolean.value = true;
  if (rootId !== undefined) instance.properties.root_session_id = { longText: { text: rootId } };
  if (parentId !== undefined) instance.properties.parent_session_id = { longText: { text: parentId } };
  return instance;
}

function setSubagentMode(h, mode) {
  h.handlers.webviewclosed({
    response: encodeURIComponent(JSON.stringify({ subagents: mode }))
  });
}

function chat(id, name) {
  return {
    instanceId: id,
    properties: { name: { shortText: { text: name } }, title: { shortText: { text: name } } }
  };
}

function question(sessionId, formId, fields, answerable = true) {
  return {
    instanceId: `${sessionId}:${formId}`,
    properties: {
      session_id: { longText: { text: sessionId } },
      form_id: { longText: { text: formId } },
      question: { longText: { text: 'Pick one' } },
      fields: { longText: { text: JSON.stringify(fields) } },
      answerable: { boolean: { value: answerable } }
    }
  };
}

function reply(sessionId, messageId, text, complete = true) {
  return {
    instanceId: sessionId,
    properties: {
      session_id: { longText: { text: sessionId } },
      message_id: { longText: { text: messageId } },
      name: { shortText: { text: sessionId }, longText: { text: 'Krtni Project' } },
      text: { shortText: { text: text.slice(0, 7) }, longText: { text } },
      complete: { boolean: { value: complete } },
      status: { shortText: { text: complete ? 'Done' : 'Writing' }, longText: { text: complete ? 'Done' : 'Writing' } },
      updated: { timestamp: { value: 1700000000 } }
    }
  };
}

function replyRow(sessionId, title, messageId, text, isDefault = false) {
  return {
    instanceId: sessionId,
    properties: {
      name: { shortText: { text: title.slice(0, 7) }, longText: { text: title } },
      title: { longText: { text: title } },
      session_id: { longText: { text: sessionId } },
      message_id: { longText: { text: messageId } },
      text: { shortText: { text: text.slice(0, 7) }, longText: { text } },
      updated: { timestamp: { value: 1700000000 } },
      complete: { boolean: { value: true } },
      status: { shortText: { text: 'Done' }, longText: { text: 'Done' } },
      is_default: { boolean: { value: isDefault } }
    }
  };
}

function replyFrames(messages) {
  const start = messages.map((message, index) => message.detail_kind === 1 ? index : -1)
    .filter((index) => index >= 0).pop();
  if (start === undefined) return [];
  const end = messages.findIndex((message, index) => index > start && message.reply_end);
  return messages.slice(start, end < 0 ? undefined : end + 1);
}

function listRows(messages) {
  const end = messages.map((message, index) => message.list_end ? index : -1)
    .filter((index) => index >= 0).pop();
  if (end === undefined) return [];
  let start = 0;
  for (let index = 0; index < end; index++) {
    if (messages[index].list_begin) start = index;
  }
  return messages.slice(start + 1, end).filter((message) =>
    message.index !== undefined && message.session_id !== undefined);
}

function dictionaryBytes(message) {
  return 1 + Object.keys(message).reduce((total, key) => {
    const value = message[key];
    return total + 7 + (typeof value === 'string' ? Buffer.byteLength(value, 'utf8') + 1 : 4);
  }, 0);
}

function utf8Prefix(text, maxBytes) {
  let output = '';
  let bytes = 0;
  for (const point of text) {
    const width = Buffer.byteLength(point, 'utf8');
    if (bytes + width > maxBytes) break;
    output += point;
    bytes += width;
  }
  return output;
}

function chatStatusRow(sessionId, title, options = {}) {
  const reason = options.reason || 'None';
  return {
    instanceId: sessionId,
    properties: {
      name: { shortText: { text: title.slice(0, 7) }, longText: { text: title } },
      title: { longText: { text: title } },
      session_id: { longText: { text: sessionId } },
      message_id: { longText: { text: options.messageId || '' } },
      needs_action: { boolean: { value: reason !== 'None' } },
      reason: { shortText: { text: reason.slice(0, 7) }, longText: { text: reason } },
      permission_count: { numericValue: { value: options.permissionCount || 0 } },
      question_count: { numericValue: { value: options.questionCount || 0 } },
      unread: { boolean: { value: !!options.unread } },
      updated: { timestamp: { value: options.updated || 1700000000 } },
      is_default: { boolean: { value: !!options.isDefault } },
      is_subagent: { boolean: { value: false } },
      url: { longText: { text: '' } }
    }
  };
}

function permissionRow(sessionId, title, requestId, action, resources, message = '') {
  return {
    instanceId: sessionId + ':' + requestId,
    properties: {
      name: { shortText: { text: title.slice(0, 7) }, longText: { text: title } },
      title: { longText: { text: title } },
      session_id: { longText: { text: sessionId } },
      request_id: { longText: { text: requestId } },
      action: { shortText: { text: action.slice(0, 7) }, longText: { text: action } },
      resources: { longText: { text: JSON.stringify(resources) } },
      message: { longText: { text: message } },
      url: { longText: { text: '' } }
    }
  };
}

test('sessions merge chats and active runs with the right status indicators', () => {
  const h = harness();
  h.takeSent();
  h.fire('agent', 'configured', { instances: [{ properties: { configured: { boolean: { value: true } } } }] });
  h.fire('agent', 'chats', { instances: [chat('ses_a', 'Krtni Project'), chat('ses_b', 'Website changes'), chat('ses_c', 'Todo list')] });
  h.fire('opencode', 'active_session', { instances: [session('ses_a', 'Krtni Project'), session('ses_b', 'Website changes')] });
  h.fire('opencode', 'question', {
    instances: [question('ses_c', 'frm_1', [{ key: 'choice', type: 'string', title: 'Choose', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] }])]
  });

  const messages = h.takeSent();
  const sessions = h.sessionMessages(messages);
  assert.deepEqual(sessions.map((entry) => entry.id), ['ses_a', 'ses_b', 'ses_c']);
  assert.equal(sessions[0].flags & 1, 1, 'running spinner');
  assert.equal(sessions[1].flags & 1, 1, 'running spinner');
  assert.equal(sessions[2].flags & 2, 2, 'attention dot');
  assert.equal(sessions[2].flags & 4, 4, 'question');
});

test('startup subscribes to lightweight sources first and publishes names and running sessions immediately', () => {
  const h = harness({ deferStartup: true });
  assert.deepEqual(h.subscriptions.map((entry) => entry.item), ['configured', 'chats', 'active_session']);
  h.fire('agent', 'chats', { instances: [chat('ses_fast', 'Fast named session')] });
  let messages = h.takeSent();
  assert.equal(listRows(messages)[0].session_name, 'Fast named session');
  assert.deepEqual(h.subscriptions.map((entry) => entry.item), ['configured', 'chats', 'active_session']);

  h.fire('opencode', 'active_session', { instances: [session('ses_fast', 'Fast named session')] });
  messages = h.takeSent();
  assert.ok(listRows(messages)[0].session_flags & 0x01, 'running flag appears before detail subscriptions');
  assert.deepEqual(h.subscriptions.map((entry) => entry.item), [
    'configured', 'chats', 'active_session', 'chat_status', 'question', 'replies', 'reply'
  ]);
});

test('startup badge sources fill in after core session list publishes', () => {
  const h = harness({ deferStartup: true });
  h.fire('agent', 'chats', { instances: [chat('ses_badge', 'Badge session')] });
  h.fire('opencode', 'active_session', { instances: [] });
  assert.equal(listRows(h.takeSent()).length, 1, 'core list is available before badge source data');
  h.fire('opencode', 'chat_status', {
    instances: [chatStatusRow('ses_badge', 'Badge session', { reason: 'Permission', permissionCount: 1 })]
  });
  assert.ok(listRows(h.takeSent())[0].session_flags & 0x20, 'permission badge fills after detail phase');
});

test('startup fallback opens details when core source never responds', () => {
  const h = harness({ deferStartup: true });
  assert.equal(h.runTimerWithDelay(1500), true);
  assert.deepEqual(h.subscriptions.map((entry) => entry.item), [
    'configured', 'chats', 'active_session', 'chat_status', 'question', 'replies', 'reply'
  ]);
  assert.equal(h.runTimerWithDelay(1500), false, 'fallback timer cleared after opening details');
});

test('startup core errors count as settled and do not wait for fallback', () => {
  const h = harness({ deferStartup: true });
  h.subscriptions.find((entry) => entry.item === 'chats').onError({ code: 'PLUGIN_UNAVAILABLE' });
  h.subscriptions.find((entry) => entry.item === 'active_session').onError({ code: 'PLUGIN_UNAVAILABLE' });
  assert.ok(h.subscriptions.some((entry) => entry.item === 'chat_status'), 'detail phase opens on core errors');
  assert.equal(h.runTimerWithDelay(1500), false, 'error completion clears fallback timer');
});

test('mode switch ignores stale startup callbacks and cancels delayed detail subscription', () => {
  const h = harness({ deferStartup: true });
  const oldChats = h.subscriptions.find((entry) => entry.item === 'chats');
  const oldActive = h.subscriptions.find((entry) => entry.item === 'active_session');
  h.handlers.webviewclosed({ response: encodeURIComponent(JSON.stringify({ poll_rate: 10 })) });
  oldChats.onData({ instances: [chat('ses_stale', 'Stale session')] });
  oldActive.onData({ instances: [session('ses_stale', 'Stale session')] });
  assert.equal(h.subscriptions.some((entry) => entry.item === 'chat_status'), false);
  assert.equal(listRows(h.takeSent()).some((row) => row.session_id === 'ses_stale'), false);
});

test('manual polling stages first detail reads after core and preserves later poll cadence', async () => {
  const h = harness({
    storage: { 'ocstatus.settings.v1': JSON.stringify({ poll_rate: 10 }) },
    deferReads: ['chats', 'active_session']
  });
  assert.deepEqual(h.reads.map((read) => read.item), ['configured', 'chats', 'active_session']);
  h.resolveRead('chats', { instances: [chat('ses_manual', 'Manual session')] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.reads.map((read) => read.item), ['configured', 'chats', 'active_session']);
  h.resolveRead('active_session', { instances: [session('ses_manual', 'Manual session')] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.reads.map((read) => read.item), [
    'configured', 'chats', 'active_session', 'chat_status', 'question'
  ]);
  assert.ok(listRows(h.takeSent()).some((row) => row.session_id === 'ses_manual'), 'core list publishes');
  assert.equal(h.runTimerWithDelay(1500), false, 'core completion clears startup fallback');
  assert.equal(h.runTimerWithDelay(10000), true, 'next poll retains configured 10-second cadence');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.reads.slice(5).map((read) => read.item), [
    'configured', 'chats', 'active_session', 'chat_status', 'question'
  ]);
});

test('manual first cycle waits for staged detail reads before scheduling next poll', async () => {
  const h = harness({
    storage: { 'ocstatus.settings.v1': JSON.stringify({ poll_rate: 10 }) },
    deferReads: ['chat_status', 'question']
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.reads.map((read) => read.item), [
    'configured', 'chats', 'active_session', 'chat_status', 'question'
  ]);
  assert.equal(h.runTimerWithDelay(10000), false, 'first cycle remains pending on detail reads');
  h.resolveRead('chat_status', { instances: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.runTimerWithDelay(10000), false, 'all staged detail reads must settle');
  h.resolveRead('question', { instances: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.runTimerWithDelay(10000), true, 'next cycle starts at configured cadence after details');
});

test('stopped manual startup ignores late detail read results', async () => {
  const h = harness({
    storage: { 'ocstatus.settings.v1': JSON.stringify({ poll_rate: 10 }) },
    deferReads: ['chat_status', 'question']
  });
  await new Promise((resolve) => setImmediate(resolve));
  h.handlers.webviewclosed({ response: encodeURIComponent(JSON.stringify({ poll_rate: 0 })) });
  h.takeSent();
  h.resolveRead('chat_status', {
    instances: [chatStatusRow('ses_late', 'Late permission', { reason: 'Permission', permissionCount: 1 })]
  });
  h.resolveRead('question', { instances: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listRows(h.takeSent()).some((row) => row.session_id === 'ses_late'), false,
    'old generation detail cannot publish after mode switch');
});

test('subagent setting defaults to Show, falls back on invalid values, persists, and injects', () => {
  const h = harness();
  h.fire('opencode', 'active_session', {
    instances: [session('ses_root', 'Root'), subagentSession('ses_child', 'ses_root', 'ses_root')]
  });
  let sessions = h.sessionMessages(h.takeSent());
  assert.deepEqual(sessions.map((entry) => entry.id), ['ses_root', 'ses_child']);
  assert.ok(sessions[1].flags & 0x10, 'default Show preserves child flag and row');

  h.handlers.showConfiguration();
  let html = decodeURIComponent(h.opened.pop().slice('data:text/html;charset=utf-8,'.length));
  assert.match(html, /var injectedSubagents = 'show';/);
  setSubagentMode(h, 'invalid');
  let settings = JSON.parse(h.storage.get('ocstatus.settings.v1'));
  assert.equal(settings.subagents, 'show');
  h.handlers.showConfiguration();
  html = decodeURIComponent(h.opened.pop().slice('data:text/html;charset=utf-8,'.length));
  assert.match(html, /var injectedSubagents = 'show';/);

  setSubagentMode(h, 'number');
  settings = JSON.parse(h.storage.get('ocstatus.settings.v1'));
  assert.equal(settings.subagents, 'number');
  h.handlers.showConfiguration();
  html = decodeURIComponent(h.opened.pop().slice('data:text/html;charset=utf-8,'.length));
  assert.match(html, /var injectedSubagents = 'number';/);
});

test('Show keeps fresh support activity out of history and preserves known roots across reload', () => {
  const now = Math.floor(Date.now() / 1000);
  const known = { ses_root: { name: 'Root history', updated: now } };
  for (let i = 0; i < 39; i++) {
    known['legacy_' + i] = { name: 'Legacy ' + i, updated: now - 100 - i };
  }
  const h = harness({ storage: { 'ocstatus.known.v1': JSON.stringify(known) } });
  h.fire('opencode', 'active_session', {
    instances: [subagentSession('ses_fresh_child', 'ses_root', 'ses_root')]
  });
  let sessions = h.sessionMessages(h.takeSent());
  assert.ok(sessions.some((entry) => entry.id === 'ses_fresh_child'), 'Show lists active child');
  let saved = JSON.parse(h.storage.get('ocstatus.known.v1'));
  assert.equal(saved.ses_fresh_child, undefined, 'fresh support child is not remembered');
  assert.ok(saved.ses_root, 'active support does not evict root history');

  h.fire('opencode', 'active_session', { instances: [] });
  sessions = h.sessionMessages(h.takeSent());
  assert.equal(sessions.some((entry) => entry.id === 'ses_fresh_child'), false,
    'finished support child disappears');
  saved = JSON.parse(h.storage.get('ocstatus.known.v1'));
  assert.equal(saved.ses_fresh_child, undefined);
  assert.ok(saved.ses_root);

  const reloaded = harness({ storage: Object.fromEntries(h.storage) });
  sessions = reloaded.sessionMessages(reloaded.takeSent());
  assert.equal(sessions.some((entry) => entry.id === 'ses_fresh_child'), false,
    'reload does not resurrect fresh support child');
  assert.ok(sessions.some((entry) => entry.id === 'ses_root'), 'root history survives reload');
});

test('legitimate reply history inherits active child classification', () => {
  const h = harness();
  h.fire('opencode', 'active_session', {
    instances: [subagentSession('ses_child', 'ses_root', 'ses_root')]
  });
  h.fire('opencode', 'reply', {
    instances: [reply('ses_child', 'msg_child', 'Remembered child reply')]
  });
  const known = JSON.parse(h.storage.get('ocstatus.known.v1'));
  assert.equal(known.ses_child.isSubagent, true);
  assert.equal(known.ses_child.rootSessionId, 'ses_root');
  assert.equal(known.ses_child.parentSessionId, 'ses_root');
  setSubagentMode(h, 'hide');
  assert.equal(h.sessionMessages(h.takeSent()).some((entry) => entry.id === 'ses_child'), false,
    'later hidden mode filters legitimate cached child history');
});

test('active child classification updates existing history without changing its identity or age', () => {
  const original = { name: 'Saved child title', updated: 1234567890 };
  const h = harness({ storage: {
    'ocstatus.known.v1': JSON.stringify({ ses_child: original })
  } });
  h.fire('opencode', 'active_session', {
    instances: [subagentSession('ses_child', 'ses_root', 'ses_root', 'Live tool name')]
  });
  const known = JSON.parse(h.storage.get('ocstatus.known.v1'));
  assert.equal(known.ses_child.name, original.name);
  assert.equal(known.ses_child.updated, original.updated);
  assert.equal(known.ses_child.isSubagent, true);
  assert.equal(known.ses_child.rootSessionId, 'ses_root');
  assert.equal(known.ses_child.parentSessionId, 'ses_root');
});

test('Hide removes active, completed, unread, question, permission, and cached child rows', () => {
  const h = harness();
  h.fire('agent', 'chats', { instances: [chat('ses_root', 'Root chat')] });
  h.fire('opencode', 'active_session', {
    instances: [subagentSession('ses_child', 'ses_root', 'ses_root')]
  });
  setSubagentMode(h, 'hide');
  assert.equal(h.sessionMessages(h.takeSent()).some((entry) => entry.id === 'ses_child'), false,
    'active child hidden immediately');
  h.fire('opencode', 'active_session', { instances: [] });
  const childStatus = chatStatusRow('ses_child', 'Child', {
    reason: 'Permission', permissionCount: 1, questionCount: 1,
    unread: true, messageId: 'msg_child'
  });
  childStatus.properties.is_subagent = { boolean: { value: true } };
  h.fire('opencode', 'chat_status', { instances: [childStatus] });
  h.fire('opencode', 'question', {
    instances: [question('ses_child', 'frm_child', [
      { key: 'choice', type: 'string', options: [{ value: 'yes', label: 'Yes' }] }
    ])]
  });
  h.fire('opencode', 'reply', { instances: [reply('ses_child', 'msg_child', 'Cached child reply')] });
  h.takeSent();
  h.watch({ req: 1 });
  let sessions = h.sessionMessages(h.takeSent());
  assert.deepEqual(sessions.map((entry) => entry.id), ['ses_root']);
  assert.equal(h.actions.length, 0, 'hiding did not dismiss child state');

  setSubagentMode(h, 'show');
  sessions = h.sessionMessages(h.takeSent());
  const child = sessions.find((entry) => entry.id === 'ses_child');
  assert.ok(child);
  assert.ok(child.flags & 0x20, 'child permission retained');
  assert.ok(child.flags & 0x04, 'child question retained');
  assert.ok(child.flags & 0x08, 'child unread/cache retained');
});

test('Number groups nested children, idle and absent roots, and deduplicates child IDs', () => {
  const h = harness();
  setSubagentMode(h, 'number');
  h.fire('agent', 'chats', { instances: [chat('ses_root2', 'Idle named root')] });
  h.fire('opencode', 'active_session', {
    instances: [
      session('ses_root1', 'Running root'),
      subagentSession('ses_child1', 'ses_root1', 'ses_root1'),
      subagentSession('ses_child2', 'ses_root1', 'ses_child1', 'Nested child', 'Waiting for input'),
      subagentSession('ses_child2', 'ses_root1', 'ses_child1', 'Duplicate child', 'Running'),
      subagentSession('ses_child3', 'ses_root2', 'ses_root2'),
      subagentSession('ses_child4', 'ses_absent', 'ses_absent')
    ]
  });
  const messages = h.takeSent();
  const sessions = h.sessionMessages(messages);
  assert.deepEqual(sessions.map((entry) => entry.id), ['ses_root1', 'ses_root2', 'ses_absent']);
  assert.equal(sessions[0].flags & 0x01, 0x01, 'root own run remains actual-running flag');
  assert.ok(sessions[0].flags & 0x40);
  assert.equal(messages.find((message) => message.session_id === 'ses_root1' && message.subagent_count).subagent_count, 2);
  assert.equal(sessions[1].name, 'Idle named root', 'idle root uses its own chat name');
  assert.equal(messages.find((message) => message.session_id === 'ses_root2' && message.subagent_count).subagent_count, 1);
  assert.equal(sessions[1].flags & 0x01, 0, 'child activity does not alter activeFor(root)');
  assert.ok(sessions[1].flags & 0x40, 'idle parent gets group display flag');
  assert.equal(sessions[2].name, 'ses_absent', 'unlisted root falls back to root ID');
  assert.equal(messages.find((message) => message.session_id === 'ses_absent' && message.subagent_count).subagent_count, 1);
  assert.equal(sessions.some((entry) => entry.id.indexOf('ses_child') === 0), false);
});

test('Number rejects malformed relationships and conflicting duplicate children safely', () => {
  const h = harness();
  setSubagentMode(h, 'number');
  const instances = [
    subagentSession('ses_proto', '__proto__', 'ses_root'),
    subagentSession('ses_constructor', 'constructor', 'ses_root'),
    subagentSession('ses_bad_space', 'bad id', 'ses_root'),
    subagentSession('ses_self', 'ses_self', 'ses_self'),
    subagentSession('ses_missing_root', undefined, 'ses_root'),
    subagentSession('ses_missing_parent', 'ses_root', undefined),
    subagentSession('ses_bad_parent', 'ses_root', 'bad parent'),
    subagentSession('ses_new_root', 'new', 'ses_root'),
    subagentSession('ses_conflict', 'ses_root1', 'ses_root1'),
    subagentSession('ses_conflict', 'ses_root2', 'ses_root2')
  ];
  h.fire('opencode', 'active_session', { instances });
  const messages = h.takeSent();
  assert.deepEqual(listRows(messages), [], 'invalid or ambiguous relationships create no root rows');
  assert.match(messages.slice().reverse().find((message) => message.list_end).status_text,
    /Update plugin for subagent counts/);
  assert.equal(Object.prototype.ses_proto, undefined, 'relationship data cannot mutate Object.prototype');
  assert.equal(Object.prototype.polluted, undefined);
});

test('Number counts before row cap, clamps wire count, changes signature, and clears zero count', () => {
  const h = harness();
  setSubagentMode(h, 'number');
  h.fire('agent', 'chats', { instances: [chat('ses_root', 'Root')] });
  const many = Array.from({ length: 260 }, (_, index) =>
    subagentSession('ses_child_' + index, 'ses_root', 'ses_root'));
  many.push(many[0]);
  h.fire('opencode', 'active_session', { instances: many });
  let messages = h.takeSent();
  let rootRow = listRows(messages).find((message) => message.session_id === 'ses_root');
  assert.ok(rootRow, 'group root survives the 20-row cap');
  assert.equal(rootRow.subagent_count, 255, '260 unique children clamp to uint8');
  assert.equal(listRows(messages).length, 1);
  assert.equal(messages.slice().reverse().find((message) => message.list_end).status_text, '1 active',
    'footer reports one grouped visible root, not 260 hidden children');

  h.fire('opencode', 'active_session', {
    instances: [many[0], subagentSession('ses_extra', 'ses_root', 'ses_root')]
  });
  messages = h.takeSent();
  rootRow = listRows(messages).find((message) => message.session_id === 'ses_root');
  assert.equal(rootRow.subagent_count, 2, 'count changes despite unchanged group flag');
  assert.ok(messages.some((message) => message.list_begin), 'count signature change sends a list');

  h.fire('opencode', 'active_session', { instances: [many[0]] });
  messages = h.takeSent();
  rootRow = listRows(messages).find((message) => message.session_id === 'ses_root');
  assert.equal(rootRow.subagent_count, 1, 'finished child decrements count');

  h.fire('opencode', 'active_session', { instances: [session('ses_root', 'Root')] });
  messages = h.takeSent();
  rootRow = listRows(messages).find((message) => message.session_id === 'ses_root');
  assert.equal(rootRow.subagent_count, undefined, 'zero count is implicit');
  assert.equal(rootRow.session_flags & 0x40, 0, 'group flag clears at zero');
});

test('Only-action promotes grouped root; unmapped legacy children warn only in Number', () => {
  const h = harness();
  setSubagentMode(h, 'number');
  h.handlers.webviewclosed({ response: encodeURIComponent(JSON.stringify({ only_action: 1 })) });
  h.fire('opencode', 'active_session', {
    instances: [subagentSession('ses_child', 'ses_root', 'ses_root')]
  });
  let messages = h.takeSent();
  let sessions = h.sessionMessages(messages);
  assert.deepEqual(sessions.map((entry) => entry.id), ['ses_root']);
  assert.ok(sessions[0].flags & 0x40);

  h.fire('opencode', 'active_session', {
    instances: [
      subagentSession('ses_old_child'),
      subagentSession('ses_self_root', 'ses_self_root', 'ses_self_root')
    ]
  });
  messages = h.takeSent();
  assert.equal(h.sessionMessages(messages).length, 0, 'unmapped child is not promoted');
  assert.match(messages.find((message) => message.list_end).status_text, /Update plugin for subagent counts/);
  setSubagentMode(h, 'hide');
  messages = h.takeSent();
  assert.doesNotMatch(messages.find((message) => message.list_end).status_text, /Update plugin/);
  setSubagentMode(h, 'show');
  sessions = h.sessionMessages(h.takeSent());
  assert.ok(sessions.some((entry) => entry.id === 'ses_old_child'), 'Show remains compatible with older plugin');
});

test('unclassified legacy known-only rows stay hidden outside Show without losing metadata', () => {
  const now = Math.floor(Date.now() / 1000);
  const h = harness({ storage: {
    'ocstatus.known.v1': JSON.stringify({
      legacy: { name: 'Legacy cached row', updated: now },
      cachedChild: {
        name: 'Cached child', updated: now, isSubagent: true,
        rootSessionId: 'ses_root', parentSessionId: 'ses_root'
      },
      rememberedRoot: {
        name: 'Remembered root', updated: now, isSubagent: false,
        rootSessionId: 'rememberedRoot', parentSessionId: ''
      }
    }),
    'ocstatus.settings.v1': JSON.stringify({ subagents: 'number' })
  } });
  let sessions = h.sessionMessages(h.takeSent());
  assert.deepEqual(sessions.map((entry) => entry.id), ['rememberedRoot']);

  h.fire('agent', 'chats', { instances: [chat('ses_root', 'Root chat')] });
  h.fire('opencode', 'active_session', {
    instances: [subagentSession('ses_newChild', 'ses_root', 'ses_root')]
  });
  let known = JSON.parse(h.storage.get('ocstatus.known.v1'));
  assert.equal(known.ses_newChild, undefined, 'active support alone creates no history entry');
  const childStatus = chatStatusRow('ses_newChild', 'Cached child', {});
  childStatus.properties.is_subagent = { boolean: { value: true } };
  childStatus.properties.root_session_id = { longText: { text: 'ses_root' } };
  childStatus.properties.parent_session_id = { longText: { text: 'ses_root' } };
  h.fire('opencode', 'chat_status', { instances: [childStatus] });
  known = JSON.parse(h.storage.get('ocstatus.known.v1'));
  assert.equal(known.ses_root.isSubagent, false, 'authoritative chat root stays classified');
  assert.equal(known.ses_root.rootSessionId, 'ses_root');
  assert.equal(known.ses_newChild.isSubagent, true);
  assert.equal(known.ses_newChild.rootSessionId, 'ses_root');
  assert.equal(known.ses_newChild.parentSessionId, 'ses_root');

  setSubagentMode(h, 'hide');
  sessions = h.sessionMessages(h.takeSent());
  assert.equal(sessions.some((entry) => entry.id === 'cachedChild' || entry.id === 'legacy'), false);
  setSubagentMode(h, 'show');
  sessions = h.sessionMessages(h.takeSent());
  assert.ok(sessions.some((entry) => entry.id === 'legacy'), 'Show preserves legacy cache behavior');
});

test('grouped child activity does not make idle root steer dictated messages', async () => {
  const h = harness();
  setSubagentMode(h, 'number');
  h.fire('opencode', 'active_session', {
    instances: [subagentSession('ses_child', 'ses_root', 'ses_root')]
  });
  const root = h.sessionMessages(h.takeSent()).find((entry) => entry.id === 'ses_root');
  assert.ok(root.flags & 0x40);
  assert.equal(root.flags & 0x01, 0, 'aggregated flag is not root FLAG_RUNNING');

  h.watch({ send_prompt_begin: 1, session_id: 'ses_root', send_delivery: 0, send_prompt_count: 1 });
  h.watch({ send_prompt_index: 0, send_prompt_chunk: 'Queue this to the root.' });
  h.watch({ send_prompt_end: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.actions[0].args.delivery, 'queue');
  assert.equal(h.actions[0].args.chat_id, 'ses_root');
});

test('root permission keeps priority; child permission and question never route to parent', async () => {
  const h = harness();
  setSubagentMode(h, 'number');
  h.fire('agent', 'chats', { instances: [chat('ses_root', 'Root')] });
  h.fire('opencode', 'active_session', {
    instances: [
      subagentSession('ses_child', 'ses_root', 'ses_root', 'Child', 'Waiting for input'),
      subagentSession('ses_old_child')
    ]
  });
  const rootStatus = chatStatusRow('ses_root', 'Root', {
    reason: 'Permission', permissionCount: 1
  });
  const childStatus = chatStatusRow('ses_child', 'Child', {
    reason: 'Permission', permissionCount: 1, questionCount: 1
  });
  childStatus.properties.is_subagent = { boolean: { value: true } };
  h.fire('opencode', 'chat_status', { instances: [rootStatus, childStatus] });
  h.fire('opencode', 'question', {
    instances: [question('ses_child', 'frm_child', [
      { key: 'choice', type: 'string', options: [{ value: 'yes', label: 'Yes' }] }
    ])]
  });
  h.setPermission({
    instances: [
      permissionRow('ses_child', 'Child', 'child_perm', 'shell', ['echo child']),
      permissionRow('ses_root', 'Root', 'root_perm', 'shell', ['echo root'])
    ]
  });
  const listMessages = h.takeSent();
  let sessions = h.sessionMessages(listMessages);
  const root = sessions.find((entry) => entry.id === 'ses_root');
  assert.ok(root.flags & 0x20, 'root permission priority retained');
  assert.ok(root.flags & 0x40, 'child activity grouped on root');
  assert.equal(root.flags & 0x04, 0, 'child question not bubbled to root');
  assert.equal(listMessages.slice().reverse().find((message) => message.list_end).status_text, '1 needs you',
    'root permission attention outranks unmapped-child warning');

  h.watch({ detail_req: 1, session_id: 'ses_root' });
  await new Promise((resolve) => setImmediate(resolve));
  let detail = h.takeSent().find((message) => message.detail_kind === 4);
  assert.ok(detail);
  assert.equal(detail.permission_request_id, 'root_perm');

  setSubagentMode(h, 'show');
  h.takeSent();
  h.watch({ detail_req: 1, session_id: 'ses_child' });
  await new Promise((resolve) => setImmediate(resolve));
  detail = h.takeSent().find((message) => message.detail_kind === 4);
  assert.ok(detail, 'child permission remains stored');
  assert.equal(detail.permission_request_id, 'child_perm');
  h.setPermission({ instances: [permissionRow('ses_root', 'Root', 'root_perm', 'shell', ['echo root'])] });
  h.advanceTime(11000);
  h.watch({ detail_req: 1, session_id: 'ses_child' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(h.takeSent().some((message) => message.detail_kind === 2), 'child question remains stored');
  assert.equal(h.actions.length, 0, 'no question/permission was auto-dismissed');
});

test('opening a question shows its choices and submits the selected value', async () => {
  const h = harness();
  h.fire('opencode', 'question', {
    instances: [question('ses_q', 'frm_1', [{ key: 'choice', type: 'string', title: 'Choose', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] }])]
  });
  h.takeSent();

  h.watch({ detail_req: 1, session_id: 'ses_q' });
  const messages = h.takeSent();
  const begin = messages.find((message) => message.detail_kind === 2);
  assert.ok(begin);
  assert.equal(begin.question_count, 2);
  assert.deepEqual(messages.filter((message) => message.choice_label).map((message) => message.choice_label), ['Yes', 'No']);

  h.watch({ answer_req: 1, session_id: 'ses_q', choice_index: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.actions.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.actions[0].args)), {
    session_id: 'ses_q',
    form_id: 'frm_1',
    answer: { choice: 'no' }
  });
  assert.ok(h.takeSent().some((message) => message.result_ok === 1));
});

test('conditional fields are asked in order and free-form required fields stay on desktop', async () => {
  const h = harness();
  h.fire('opencode', 'question', {
    instances: [question('ses_q', 'frm_1', [
      { key: 'choice', type: 'string', title: 'Choose', options: [{ value: 'red', label: 'Red' }, { value: 'blue', label: 'Blue' }] },
      { key: 'note', type: 'string', title: 'Note', required: true, when: [{ key: 'choice', op: 'eq', value: 'red' }] }
    ])]
  });
  h.takeSent();
  h.watch({ detail_req: 1, session_id: 'ses_q' });
  h.watch({ answer_req: 1, session_id: 'ses_q', choice_index: 1 });
  const sent = h.takeSent();
  assert.equal(sent.some((message) => message.detail_kind === 3), false, 'no desktop fallback');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(h.actions[0].args.answer)), { choice: 'blue' });
});

test('completed replies become attention dots until the session is opened', () => {
  const h = harness();
  h.fire('agent', 'chats', { instances: [chat('ses_a', 'Krtni Project')] });
  h.fire('agent', 'configured', { instances: [{ properties: { configured: { boolean: { value: true } } } }] });
  h.fire('opencode', 'active_session', { instances: [session('ses_a', 'Krtni Project')] });
  h.fire('opencode', 'reply', { instances: [reply('ses_a', 'msg_1', 'Done with the first pass.')] });
  h.fire('opencode', 'active_session', { instances: [] });

  let sessions = h.sessionMessages(h.takeSent());
  assert.ok(sessions[0].flags & 8, 'unviewed flag');
  assert.ok(sessions[0].flags & 2, 'attention flag');

  h.watch({ detail_req: 1, session_id: 'ses_a' });
  const messages = h.takeSent();
  assert.ok(messages.some((message) => message.detail_kind === 1));
  assert.equal(
    messages.filter((message) => message.reply_chunk).map((message) => message.reply_chunk).join(''),
    'Done with the first pass.'
  );
  const unviewed = JSON.parse(h.storage.get('ocstatus.unviewed.v1') || '{}');
  assert.equal(unviewed.ses_a, undefined);
});

test('multiselect choices toggle and only submit once Done is chosen', async () => {
  const h = harness();
  h.fire('opencode', 'question', {
    instances: [question('ses_q', 'frm_multi', [
      {
        key: 'tags',
        type: 'multiselect',
        title: 'Tags',
        required: true,
        minItems: 1,
        options: [{ value: 'alpha', label: 'Alpha' }, { value: 'beta', label: 'Beta' }]
      }
    ])]
  });
  h.takeSent();
  h.watch({ detail_req: 1, session_id: 'ses_q' });
  let begin = h.takeSent().find((message) => message.detail_kind === 2);
  assert.equal(begin.question_multi, 1);
  assert.equal(begin.question_count, 3);

  h.watch({ answer_req: 1, session_id: 'ses_q', choice_index: 0 });
  let messages = h.takeSent();
  begin = messages.find((message) => message.detail_kind === 2);
  assert.equal(begin.question_count, 3);
  assert.equal(messages.find((message) => message.choice_index === 0).choice_flags, 1);

  h.watch({ answer_req: 1, session_id: 'ses_q', choice_index: 1 });
  h.takeSent();
  h.watch({ answer_req: 1, session_id: 'ses_q', choice_index: 1 });
  h.takeSent();
  h.watch({ answer_req: 1, session_id: 'ses_q', choice_index: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(h.actions[0].args.answer)), { tags: ['alpha'] });
});

test('a session that leaves the active map gets an unviewed dot and keeps its name', () => {
  const h = harness();
  h.fire('agent', 'chats', { instances: [chat('ses_a', 'Krtni Project')] });
  h.fire('opencode', 'active_session', { instances: [session('ses_a', 'Krtni Project')] });
  h.takeSent();
  h.fire('opencode', 'active_session', { instances: [] });
  const sessions = h.sessionMessages(h.takeSent());
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'ses_a');
  assert.equal(sessions[0].name, 'Krtni Project');
  assert.ok(sessions[0].flags & 8);
});

test('replies source supplies latest replies for non-default sessions', async () => {
  const h = harness();
  h.setReplies({
    instances: [
      replyRow('ses_a', 'Krtni Project', 'msg_a', 'First session reply'),
      replyRow('ses_b', 'Website changes', 'msg_b', 'Second session reply', true)
    ]
  });

  h.watch({ detail_req: 1, session_id: 'ses_a' });
  await new Promise((resolve) => setImmediate(resolve));
  const messages = h.takeSent();
  assert.ok(messages.some((message) => message.detail_kind === 1));
  assert.equal(
    messages.filter((message) => message.reply_chunk).map((message) => message.reply_chunk).join(''),
    'First session reply'
  );
  assert.equal(
    messages.some((message) => message.detail_kind === 3 && message.detail_status !== 'Loading'),
    false
  );
});

test('an uncached detail reads replies with a one-shot subscription', async () => {
  const h = harness();
  delete h.Pebble.readSource;

  h.watch({ detail_req: 1, session_id: 'ses_a' });
  const loading = h.takeSent();
  assert.ok(loading.some((message) => message.detail_kind === 3 && message.detail_status === 'Loading'));
  assert.equal(loading.some((message) => /not in the plugin/.test(message.detail_text || '')), false);

  const oneShot = h.subscriptions.filter((entry) => entry.item === 'replies').pop();
  assert.ok(oneShot);
  oneShot.onData({
    instances: [replyRow('ses_a', 'Krtni Project', 'msg_a', 'Reply from one-shot read')]
  });
  await new Promise((resolve) => setImmediate(resolve));

  const messages = h.takeSent();
  assert.equal(
    messages.filter((message) => message.reply_chunk).map((message) => message.reply_chunk).join(''),
    'Reply from one-shot read'
  );
  assert.equal(h.subscriptions.filter((entry) => entry.item === 'replies').length, 1);
});

test('running sessions show the spinner instead of an unread dot', () => {
  const h = harness();
  h.fire('opencode', 'chat_status', {
    instances: [chatStatusRow('ses_a', 'Running chat', {
      reason: 'Unread', unread: true, messageId: 'msg_1'
    })]
  });
  h.fire('opencode', 'active_session', { instances: [session('ses_a', 'Running chat')] });
  const sessions = h.sessionMessages(h.takeSent());
  assert.equal(sessions.length, 1);
  assert.ok(sessions[0].flags & 1, 'running flag');
  assert.equal(sessions[0].flags & 8, 0, 'no unread dot while running');
  assert.equal(sessions[0].flags & 2, 0, 'no attention count while running');
});

test('chat status drives permission, question, and unread badge flags', () => {
  const h = harness();
  h.fire('opencode', 'chat_status', {
    instances: [
      chatStatusRow('ses_perm', 'Permission chat', { reason: 'Permission', permissionCount: 1 }),
      chatStatusRow('ses_ask', 'Question chat', { reason: 'Question', questionCount: 1 }),
      chatStatusRow('ses_unread', 'Unread chat', { reason: 'Unread', unread: true, messageId: 'msg_u' })
    ]
  });
  const sessions = h.sessionMessages(h.takeSent());
  const flags = Object.fromEntries(sessions.map((session) => [session.id, session.flags]));
  assert.ok(flags.ses_perm & 0x20, 'permission badge');
  assert.ok(flags.ses_ask & 0x04, 'question badge');
  assert.ok(flags.ses_unread & 0x08, 'unread badge');
  assert.ok(flags.ses_perm & 0x02, 'permission attention');
});

test('closing detail lets later chat status replies become unviewed', () => {
  const h = harness();
  h.setReplies({ instances: [replyRow('ses_a', 'Krtni Project', 'msg_1', 'First reply')] });
  h.fire('opencode', 'chat_status', {
    instances: [chatStatusRow('ses_a', 'Krtni Project', {
      reason: 'Unread', unread: true, messageId: 'msg_1'
    })]
  });
  let sessions = h.sessionMessages(h.takeSent());
  assert.ok(sessions[0].flags & 8, 'initial unread dot');

  h.watch({ detail_req: 1, session_id: 'ses_a' });
  h.watch({ detail_close: 1, session_id: 'ses_a' });
  h.takeSent();
  h.fire('opencode', 'chat_status', {
    instances: [chatStatusRow('ses_a', 'Krtni Project', {
      reason: 'Unread', unread: true, messageId: 'msg_2'
    })]
  });
  h.watch({ req: 1 });
  sessions = h.sessionMessages(h.takeSent());
  assert.ok(sessions[0].flags & 8, 'new reply after closing detail is unviewed');
});

test('mark_read from the watch marks the displayed message read', async () => {
  const h = harness();
  h.setReplies({ instances: [replyRow('ses_a', 'Krtni Project', 'msg_1', 'First reply')] });
  h.fire('opencode', 'chat_status', {
    instances: [chatStatusRow('ses_a', 'Krtni Project', {
      reason: 'Unread', unread: true, messageId: 'msg_1'
    })]
  });
  h.takeSent();
  h.watch({ detail_req: 1, session_id: 'ses_a' });
  await new Promise((resolve) => setImmediate(resolve));
  h.takeSent();

  h.watch({ mark_read: 1, session_id: 'ses_a', detail_message_id: 'msg_1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(h.actions[0])), {
    plugin: OPENCODE_UUID,
    action: 'mark_chat_read',
    args: { session_id: 'ses_a', message_id: 'msg_1' }
  });
  const sessions = h.sessionMessages(h.takeSent());
  assert.equal(sessions[0].flags & 8, 0, 'unread dot cleared');
});

test('long-press clears a completed session without opening it', async () => {
  const h = harness();
  h.fire('opencode', 'chat_status', {
    instances: [chatStatusRow('ses_a', 'Krtni Project', {
      reason: 'Unread', unread: true, messageId: 'msg_1'
    })]
  });
  h.takeSent();

  h.watch({ clear_completed: 1, session_id: 'ses_a' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(h.actions[0])), {
    plugin: OPENCODE_UUID,
    action: 'mark_chat_read',
    args: { session_id: 'ses_a', message_id: 'msg_1' }
  });
  const messages = h.takeSent();
  assert.ok(messages.some((message) => message.clear_ok === 1));
  let sessions = h.sessionMessages(messages);
  assert.equal(sessions[0].flags & 8, 0, 'unread dot cleared');
  assert.equal(sessions[0].flags & 2, 0, 'attention cleared');

  h.fire('opencode', 'chat_status', {
    instances: [chatStatusRow('ses_a', 'Krtni Project', {
      reason: 'Unread', unread: true, messageId: 'msg_1'
    })]
  });
  h.watch({ req: 1 });
  sessions = h.sessionMessages(h.takeSent());
  assert.equal(sessions[0].flags & 8, 0, 'stale status does not restore the dot');
});

test('replies source is subscribed and cached replies survive an empty refresh', () => {
  const h = harness();
  assert.ok(h.subscriptions.some((entry) => entry.category === 'opencode' && entry.item === 'replies'));
  h.setReplies({ instances: [replyRow('ses_a', 'Krtni Project', 'msg_1', 'First reply')] });
  h.fire('opencode', 'replies', { instances: [replyRow('ses_a', 'Krtni Project', 'msg_1', 'First reply')] });
  h.takeSent();

  h.fire('opencode', 'replies', { instances: [] });
  h.takeSent();
  h.watch({ detail_req: 1, session_id: 'ses_a' });
  const messages = h.takeSent();
  assert.ok(messages.some((message) => message.detail_kind === 1));
  assert.equal(
    messages.filter((message) => message.reply_chunk).map((message) => message.reply_chunk).join(''),
    'First reply'
  );
});

test('a cached entry without text is refreshed before showing no reply', async () => {
  const h = harness();
  h.fire('opencode', 'replies', {
    instances: [{
      instanceId: 'ses_a',
      properties: {
        session_id: { longText: { text: 'ses_a' } },
        status: { shortText: { text: 'Idle' }, longText: { text: 'No reply' } }
      }
    }]
  });
  h.takeSent();
  h.setReplies({ instances: [replyRow('ses_a', 'Krtni Project', 'msg_1', 'Fresh reply')] });

  h.watch({ detail_req: 1, session_id: 'ses_a' });
  await new Promise((resolve) => setImmediate(resolve));
  const messages = h.takeSent();
  assert.ok(messages.some((message) => message.detail_kind === 1));
  assert.equal(
    messages.filter((message) => message.reply_chunk).map((message) => message.reply_chunk).join(''),
    'Fresh reply'
  );
});

test('opening a cached reply refreshes it from the replies source', async () => {
  const h = harness();
  h.setReplies({ instances: [replyRow('ses_a', 'Krtni Project', 'msg_old', 'Old reply')] });
  h.fire('opencode', 'replies', {
    instances: [replyRow('ses_a', 'Krtni Project', 'msg_old', 'Old reply')]
  });
  h.takeSent();

  h.watch({ detail_req: 1, session_id: 'ses_a' });
  await new Promise((resolve) => setImmediate(resolve));
  h.takeSent();

  h.setReplies({ instances: [replyRow('ses_a', 'Krtni Project', 'msg_new', 'Newest reply')] });
  h.watch({ detail_req: 1, session_id: 'ses_a' });
  await new Promise((resolve) => setImmediate(resolve));

  const messages = h.takeSent();
  const starts = messages.map((message, index) => message.detail_kind === 1 ? index : -1)
    .filter((index) => index >= 0);
  assert.equal(starts.length, 2, 'cached reply then fresh reply');
  const chunks = messages.slice(starts[starts.length - 1])
    .filter((message) => message.reply_chunk)
    .map((message) => message.reply_chunk).join('');
  assert.equal(chunks, 'Newest reply');
});

test('deferred replies read cannot replace intervening push at older or tied timestamp', async () => {
  for (const delayedTimestamp of [1700000000, 1800000000]) {
    const h = harness({ deferReads: ['replies'] });
    const old = replyRow('ses_a', 'Project', 'msg_z', 'Old snapshot');
    old.properties.updated.timestamp.value = 1700000000;
    h.fire('opencode', 'replies', { instances: [old] });
    h.takeSent();
    h.watch({ detail_req: 1, session_id: 'ses_a' });

    const pushed = replyRow('ses_a', 'Project', 'msg_a', 'Pushed canonical');
    pushed.properties.updated.timestamp.value = 1800000000;
    h.fire('opencode', 'replies', { instances: [pushed] });
    const delayed = replyRow('ses_a', 'Project', 'msg_z', 'Delayed stale read');
    delayed.properties.updated.timestamp.value = delayedTimestamp;
    h.resolveRead('replies', { instances: [delayed] });
    await new Promise((resolve) => setImmediate(resolve));

    const messages = h.takeSent();
    const starts = messages.filter((message) => message.detail_kind === 1);
    assert.equal(starts.length, 2, 'stale forced read did not trigger third transfer');
    const frames = replyFrames(messages);
    assert.equal(frames.filter((message) => message.reply_chunk)
      .map((message) => message.reply_chunk).join(''), 'Pushed canonical');
  }
});

test('deferred focused reply read preserves older/tied push and accepts newer timestamp', async () => {
  for (const delayedUpdated of [1700000000, 1800000000, 1900000000]) {
    const h = harness({ deferReads: ['replies', 'reply'] });
    const seed = reply('ses_a', 'msg_z', 'Seed content');
    seed.properties.updated.timestamp.value = 1700000000;
    h.fire('opencode', 'reply', { instances: [seed] });
    h.takeSent();
    h.watch({ detail_req: 1, session_id: 'ses_a' });

    const repliesRead = replyRow('ses_a', 'Krtni Project', 'msg_z', 'Seed content', true);
    repliesRead.properties.updated.timestamp.value = 1700000000;
    h.resolveRead('replies', { instances: [repliesRead] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(h.deferredReads.some((read) => read.item === 'reply'), 'focused forced read pending');

    const pushed = reply('ses_a', 'msg_a', 'Pushed content');
    pushed.properties.updated.timestamp.value = 1800000000;
    h.fire('opencode', 'reply', { instances: [pushed] });
    const acceptRead = delayedUpdated > 1800000000;
    const delayed = reply('ses_a', 'msg_z', acceptRead ? 'Read is newer' : 'Delayed stale reply');
    delayed.properties.updated.timestamp.value = delayedUpdated;
    h.resolveRead('reply', { instances: [delayed] });
    await new Promise((resolve) => setImmediate(resolve));

    const messages = h.takeSent();
    const frames = replyFrames(messages);
    const visible = frames.filter((message) => message.reply_chunk)
      .map((message) => message.reply_chunk).join('');
    assert.equal(visible, acceptRead ? 'Read is newer' : 'Pushed content');
    assert.equal(messages.filter((message) => message.detail_kind === 1).length,
      acceptRead ? 3 : 2,
      'only canonical visible updates trigger reply transfers');
  }
});

test('focused read does not replace equal-second canonical replies message ID', async () => {
  const h = harness();
  const canonical = replyRow('ses_a', 'Project', 'msg_new', 'Newest per-session reply', true);
  canonical.properties.updated.timestamp.value = 1800000000;
  h.setReplies({ instances: [canonical] });
  const focused = reply('ses_a', 'msg_old', 'Old focused-source reply');
  focused.properties.updated.timestamp.value = 1800000000;
  h.setReply({ instances: [focused] });
  h.fire('opencode', 'replies', { instances: [canonical] });
  h.takeSent();

  h.watch({ detail_req: 1, session_id: 'ses_a' });
  await new Promise((resolve) => setImmediate(resolve));
  const messages = h.takeSent();
  const headers = messages.filter((message) => message.detail_kind === 1);
  assert.equal(headers.length, 1, 'stale secondary read emitted no extra reply transfer');
  assert.equal(headers[0].detail_message_id, 'msg_new');
  assert.equal(messages.some((message) => message.detail_message_id === 'msg_old'), false);
  assert.equal(messages.filter((message) => message.reply_chunk)
    .map((message) => message.reply_chunk).join(''), 'Newest per-session reply');
});

test('reply packing honors byte cap, inbox budget, and Unicode codepoint boundaries', async () => {
  for (const cap of [1855, 4399]) {
    for (const [label, text] of [
      ['ASCII', 'a'.repeat(4096)],
      ['CJK', '界'.repeat(4096)],
      ['emoji', '\u{1F642}'.repeat(4096)],
      ['surrogate boundary', 'a'.repeat(379) + '\u{1F642}' + 'b'.repeat(20)]
    ]) {
      const h = harness();
      const inboxSize = cap === 1855 ? 512 : 1024;
      h.watch({ req: 1, reply_cap: cap, inbox_size: inboxSize });
      h.setReplies({ instances: [replyRow('ses_a', 'Project', 'msg_a', text)] });
      h.watch({ detail_req: 1, session_id: 'ses_a' });
      await new Promise((resolve) => setImmediate(resolve));
      const frames = replyFrames(h.takeSent());
      assert.ok(frames.length > 0, `${label}/${cap}: reply header missing`);
      const chunks = frames.filter((message) => message.reply_chunk).map((message) => message.reply_chunk);
      const assembled = chunks.join('');
      const expected = utf8Prefix(text, cap);
      assert.equal(assembled, expected, `${label}/${cap}: assembled capped prefix`);
      assert.equal(assembled.indexOf('\uFFFD'), -1, `${label}/${cap}: no replacement character`);
      assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 380), `${label}/${cap}: byte limit`);
      assert.ok(frames.every((message) => dictionaryBytes(message) <= inboxSize), `${label}/${cap}: inbox limit`);
    }
  }
});

test('reply fallback cap is 1855 bytes and non-Aplite 4096 ASCII uses 11 chunks', async () => {
  const h = harness();
  h.setReplies({ instances: [replyRow('ses_a', 'Project', 'msg_a', 'x'.repeat(4096))] });
  h.watch({ detail_req: 1, session_id: 'ses_a' });
  await new Promise((resolve) => setImmediate(resolve));
  let frames = replyFrames(h.takeSent());
  assert.equal(frames.filter((message) => message.reply_chunk).length, 5);
  assert.equal(frames.filter((message) => message.reply_chunk).map((message) => message.reply_chunk).join('').length, 1855);

  h.watch({ req: 1, reply_cap: 4399, inbox_size: 1024 });
  h.setReplies({ instances: [replyRow('ses_a', 'Project', 'msg_b', 'x'.repeat(4096))] });
  h.watch({ detail_req: 1, session_id: 'ses_a' });
  await new Promise((resolve) => setImmediate(resolve));
  frames = replyFrames(h.takeSent());
  assert.equal(frames.filter((message) => message.reply_chunk).length, 11);
  assert.equal(frames.length, 13, 'header + 11 chunks + end');
  assert.equal(frames.filter((message) => message.reply_chunk).map((message) => message.reply_chunk).join('').length, 4096);
});

test('reopening detail forces cached identical reply delivery', () => {
  const h = harness();
  h.fire('opencode', 'replies', {
    instances: [replyRow('ses_a', 'Project', 'msg_a', 'Same visible reply')]
  });
  h.takeSent();
  h.watch({ detail_req: 1, session_id: 'ses_a' });
  assert.equal(replyFrames(h.takeSent()).filter((message) => message.detail_kind === 1).length, 1);
  h.watch({ detail_close: 1, session_id: 'ses_a' });
  h.watch({ detail_req: 1, session_id: 'ses_a' });
  assert.equal(replyFrames(h.takeSent()).filter((message) => message.detail_kind === 1).length, 1);
});

test('reply packing preserves maximum supported ID and rejects IDs without safe payload room', async () => {
  const id = 's'.repeat(63);
  const h = harness();
  h.watch({ req: 1, reply_cap: 4399, inbox_size: 512 });
  h.setReplies({ instances: [replyRow(id, 'Project', 'msg_a', 'x'.repeat(4096))] });
  h.watch({ detail_req: 1, session_id: id });
  await new Promise((resolve) => setImmediate(resolve));
  let frames = replyFrames(h.takeSent());
  assert.ok(frames.length > 0);
  assert.ok(frames.every((message) => dictionaryBytes(message) <= 512));
  assert.ok(frames.every((message) => message.session_id === id));
  const maxIdChunks = frames.filter((message) => message.reply_chunk);
  assert.equal(Buffer.byteLength(maxIdChunks[0].reply_chunk, 'utf8'), 380);
  assert.ok(maxIdChunks.every((message) => Buffer.byteLength(message.reply_chunk, 'utf8') <= 380));

  h.watch({ req: 1, reply_cap: 4399, inbox_size: 1 });
  const tooLongId = id + 'x';
  h.setReplies({ instances: [replyRow(tooLongId, 'Project', 'msg_b', 'reply text')] });
  h.watch({ detail_req: 1, session_id: tooLongId });
  await new Promise((resolve) => setImmediate(resolve));
  const sent = h.takeSent();
  assert.equal(sent.some((message) => message.reply_chunk !== undefined), false);
  assert.equal(sent.some((message) => message.detail_kind === 3), false,
    'unsupported ID is not used to route an error to the wrong session');
});

test('identical focused poll emits no list frames, with five-minute full resync', async () => {
  const h = harness({ now: 1700000000000 });
  h.setSource('configured', { instances: [{ properties: { configured: { boolean: { value: true } } } }] });
  h.setSource('chats', { instances: [chat('ses_a', 'Polled chat')] });
  h.setSource('active_session', { instances: [session('ses_a', 'Polled chat')] });
  h.setSource('chat_status', { instances: [] });
  h.setSource('question', { instances: [] });
  h.handlers.webviewclosed({ response: encodeURIComponent(JSON.stringify({ poll_rate: 10 })) });
  await new Promise((resolve) => setImmediate(resolve));
  h.takeSent();

  h.advanceTime(10000);
  h.runTimers();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.takeSent().length, 0, 'identical second poll emits zero frames');

  h.advanceTime(290000);
  h.runTimers();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(h.takeSent().some((message) => message.list_begin), 'five-minute full list resync');
});

test('same-length reply corrections and visible metadata changes resend, duplicates do not', () => {
  const h = harness();
  h.watch({ detail_req: 1, session_id: 'ses_a' });
  h.takeSent();
  h.fire('opencode', 'reply', { instances: [reply('ses_a', 'msg_a', 'First text')] });
  assert.ok(h.takeSent().some((message) => message.detail_kind === 1));
  h.fire('opencode', 'reply', { instances: [reply('ses_a', 'msg_a', 'Other text')] });
  assert.ok(h.takeSent().some((message) => message.detail_kind === 1), 'same-length correction');
  h.fire('opencode', 'reply', { instances: [reply('ses_a', 'msg_a', 'Other text')] });
  assert.equal(h.takeSent().some((message) => message.detail_kind === 1), false, 'duplicate suppressed');
  const titleChange = reply('ses_a', 'msg_a', 'Other text');
  titleChange.properties.name.longText.text = 'Changed title';
  h.fire('opencode', 'reply', { instances: [titleChange] });
  assert.ok(h.takeSent().some((message) => message.detail_kind === 1), 'title change');
});

test('tail-only growth past reply capacity deduplicates; status and completion still update', () => {
  const h = harness();
  h.watch({ req: 1, reply_cap: 1855, inbox_size: 512 });
  h.watch({ detail_req: 1, session_id: 'ses_a' });
  h.takeSent();
  h.fire('opencode', 'reply', { instances: [reply('ses_a', 'msg_a', 'x'.repeat(1855) + 'A')] });
  assert.ok(h.takeSent().some((message) => message.detail_kind === 1));

  h.fire('opencode', 'reply', { instances: [reply('ses_a', 'msg_a', 'x'.repeat(1855) + 'B')] });
  assert.equal(h.takeSent().some((message) => message.detail_kind === 1), false,
    'unrendered tail growth does not retransmit');

  const changed = reply('ses_a', 'msg_a', 'x'.repeat(1855) + 'B', false);
  changed.properties.status.longText.text = 'Writing';
  changed.properties.status.shortText.text = 'Writing';
  h.fire('opencode', 'reply', { instances: [changed] });
  assert.ok(h.takeSent().some((message) => message.detail_kind === 1),
    'completion/status changes remain visible updates');
});

test('older focused reply push keeps newer canonical content and emits no duplicate frames', () => {
  const h = harness();
  const newer = replyRow('ses_a', 'Project', 'msg_z', 'Canonical newer reply');
  newer.properties.updated.timestamp.value = 1800000000;
  h.fire('opencode', 'replies', { instances: [newer] });
  h.takeSent();
  h.watch({ detail_req: 1, session_id: 'ses_a' });
  assert.equal(replyFrames(h.takeSent()).filter((message) => message.detail_kind === 1).length, 1);

  const olderPush = reply('ses_a', 'msg_a', 'Old focused push');
  olderPush.properties.updated.timestamp.value = 1700000000;
  h.fire('opencode', 'reply', { instances: [olderPush] });
  const afterOldPush = h.takeSent();
  assert.equal(afterOldPush.some((message) => message.detail_kind === 1), false);
  assert.equal(h.sessionMessages(afterOldPush).length, 0,
    'older reply metadata does not force unrelated list changes');
});

test('older reply snapshots cannot replace newer timestamps or lexical message IDs', () => {
  const h = harness();
  const newer = replyRow('ses_a', 'Project', 'msg_z', 'Newer content');
  newer.properties.updated.timestamp.value = 1800000000;
  const older = replyRow('ses_a', 'Project', 'msg_a', 'Older content');
  older.properties.updated.timestamp.value = 1700000000;
  h.fire('opencode', 'replies', { instances: [newer] });
  h.fire('opencode', 'replies', { instances: [older] });
  h.watch({ detail_req: 1, session_id: 'ses_a' });
  const cached = replyFrames(h.takeSent());
  assert.equal(cached.filter((message) => message.reply_chunk).map((message) => message.reply_chunk).join(''), 'Newer content');
});

test('failed reply frame clears dedupe marker for same-content retransmission', () => {
  const h = harness({ deferAcks: true });
  h.ackAll();
  h.takeSent();
  const value = replyRow('ses_a', 'Project', 'msg_a', 'Retry this reply');
  h.fire('opencode', 'replies', { instances: [value] });
  h.ackAll();
  h.takeSent();
  h.watch({ detail_req: 1, session_id: 'ses_a' });
  h.takeSent();
  h.ackNext(new Error('injected send failure'));
  h.fire('opencode', 'reply', { instances: [value] });
  const retry = h.takeSent();
  h.ackAll();
  retry.push(...h.takeSent());
  assert.ok(retry.some((message) => message.detail_kind === 1), 'same content retransmitted');
});

test('slow AppMessage acknowledgements preserve cached then fresh reply transfer order', async () => {
  const h = harness({ deferAcks: true });
  h.setReplies({ instances: [replyRow('ses_a', 'Project', 'msg_old', 'Old cached reply')] });
  h.fire('opencode', 'replies', { instances: [replyRow('ses_a', 'Project', 'msg_old', 'Old cached reply')] });
  h.ackAll();
  h.takeSent();

  h.watch({ detail_req: 1, session_id: 'ses_a' });
  const cachedHeader = h.pendingAcks[0];
  assert.ok(cachedHeader, 'cached transfer started');
  const cachedTransfer = h.takeSent();
  const sentBeforeFresh = cachedTransfer;
  assert.equal(sentBeforeFresh[0].detail_kind, 1);
  h.setReplies({ instances: [replyRow('ses_a', 'Project', 'msg_new', 'Fresh corrected reply')] });
  h.fire('opencode', 'replies', { instances: [replyRow('ses_a', 'Project', 'msg_new', 'Fresh corrected reply')] });
  await new Promise((resolve) => setImmediate(resolve));
  // Fresh transfer queues behind cached one while its first frame is still unacknowledged.
  h.ackAll();
  const delivered = cachedTransfer.concat(h.takeSent());
  const starts = delivered.map((message, index) => message.detail_kind === 1 ? index : -1)
    .filter((index) => index >= 0);
  assert.equal(starts.length, 2);
  const last = replyFrames(delivered.slice(starts[1]));
  assert.equal(last.filter((message) => message.reply_chunk).map((message) => message.reply_chunk).join(''), 'Fresh corrected reply');
});

test('question text and answer descriptions are sent to the watch', () => {
  const h = harness();
  const questionText = 'I found an uncommitted user edit in games/catan/info.json: the tagline is now "Trade, build, settle. But hexagons." Include it in this deploy or leave it uncommitted?';
  const field = {
    key: 'tagline',
    type: 'string',
    title: 'Uncommitted tagline',
    description: questionText,
    options: [
      { value: 'include', label: 'Include it', description: 'Commit the tagline change and deploy it with the new theme.' },
      { value: 'leave', label: 'Leave it uncommitted', description: 'Deploy only the theme and cache-busting changes; keep the tagline edit local.' }
    ]
  };
  h.fire('opencode', 'question', {
    instances: [question('ses_q', 'frm_1', [field])]
  });
  h.takeSent();

  h.watch({ detail_req: 1, session_id: 'ses_q' });
  const messages = h.takeSent();
  const begin = messages.find((message) => message.detail_kind === 2);
  assert.ok(begin);
  assert.ok(begin.question_description_count > 1);
  assert.equal(
    messages.filter((message) => message.question_description_chunk)
      .sort((a, b) => a.question_description_index - b.question_description_index)
      .map((message) => message.question_description_chunk).join(''),
    questionText
  );

  h.watch({ choice_detail_req: 1, session_id: 'ses_q', choice_index: 0 });
  const detail = h.takeSent().find((message) => message.choice_detail === 1);
  assert.ok(detail);
  assert.equal(detail.choice_index, 0);
  assert.equal(detail.choice_label, 'Include it');
  assert.equal(detail.choice_description, 'Commit the tagline change and deploy it with the new theme.');
});

test('showConfiguration opens the on-device settings page', () => {
  const h = harness();
  h.handlers.showConfiguration();
  assert.equal(h.opened.length, 1);
  assert.ok(h.opened[0].indexOf('data:text/html;charset=utf-8,') === 0);
  const html = decodeURIComponent(h.opened[0].slice('data:text/html;charset=utf-8,'.length));
  assert.match(html, /var injectedRate = Number\('0'\);/);
  assert.match(html, /var injectedOnly = '0';/);
  assert.match(html, /var injectedMarkRead = Number\('0'\);/);
  assert.match(html, /<h1>OpenCode Status<\/h1>/);
  assert.ok(html.indexOf('>Continue\nYes\nNo\nRun tests</textarea>') !== -1);
});

test('canned replies are configurable, normalized, and sent on request', () => {
  const h = harness();
  h.handlers.webviewclosed({
    response: encodeURIComponent(JSON.stringify({
      canned_replies: [' Continue ', '', 'Run tests', 'Run tests', 'x'.repeat(100)]
    }))
  });
  const settings = JSON.parse(h.storage.get('ocstatus.settings.v1'));
  assert.deepEqual(settings.canned_replies, ['Continue', 'Run tests', 'x'.repeat(80)]);

  h.takeSent();
  h.watch({ canned_req: 1 });
  const messages = h.takeSent();
  assert.equal(messages.find((message) => message.canned_begin).canned_count, 3);
  assert.deepEqual(
    messages.filter((message) => message.canned_text).map((message) => message.canned_text),
    ['Continue', 'Run tests', 'x'.repeat(80)]
  );
  assert.equal(messages.find((message) => message.canned_end).canned_count, 3);
});

test('empty canned replies are sent as an empty table', () => {
  const h = harness();
  h.handlers.webviewclosed({
    response: encodeURIComponent(JSON.stringify({ canned_replies: [] }))
  });
  h.takeSent();
  h.watch({ canned_req: 1 });
  const messages = h.takeSent();
  assert.ok(messages.some((message) => message.canned_begin));
  assert.equal(messages.some((message) => message.canned_text), false);
  assert.equal(messages.find((message) => message.canned_end).canned_count, 0);
});

test('concurrent detail opens share one one-shot replies read', async () => {
  const h = harness();
  delete h.Pebble.readSource;
  const before = h.subscriptions.filter((entry) => entry.item === 'replies').length;

  h.watch({ detail_req: 1, session_id: 'ses_a' });
  h.watch({ detail_req: 1, session_id: 'ses_b' });
  const during = h.subscriptions.filter((entry) => entry.item === 'replies');
  assert.equal(during.length, before + 1);
  const oneShot = during[during.length - 1];

  oneShot.onData({
    instances: [
      replyRow('ses_a', 'Krtni Project', 'msg_a', 'First reply'),
      replyRow('ses_b', 'Website changes', 'msg_b', 'Second reply')
    ]
  });
  await new Promise((resolve) => setImmediate(resolve));

  const messages = h.takeSent();
  assert.equal(
    messages.filter((message) => message.reply_chunk).map((message) => message.reply_chunk).join(''),
    'Second reply'
  );
});

test('a retired plugin source resubscribes after a delay', () => {
  const h = harness();
  const replied = h.subscriptions.filter((entry) => entry.item === 'replies').pop();
  assert.ok(replied);
  replied.onError({
    code: 'UNKNOWN',
    message: 'OpenCode was updated or removed; subscribe again'
  });
  assert.ok(h.subscriptions.length > 0, 'no immediate restart');
  h.runTimers();
  h.runTimerWithDelay(1500);
  assert.ok(h.subscriptions.some((entry) => entry.item === 'replies'), 'subscriptions restored');
});

test('only-action filter hides read sessions and persists', () => {
  const h = harness();
  h.fire('agent', 'chats', {
    instances: [chat('ses_a', 'Active chat'), chat('ses_b', 'Unread chat'), chat('ses_c', 'Read chat')]
  });
  h.fire('opencode', 'active_session', { instances: [session('ses_a', 'Active chat')] });
  h.fire('opencode', 'chat_status', {
    instances: [chatStatusRow('ses_b', 'Unread chat', {
      reason: 'Unread', unread: true, messageId: 'msg_b'
    })]
  });
  h.takeSent();

  h.handlers.webviewclosed({ response: encodeURIComponent(JSON.stringify({ poll_rate: 0, only_action: 1 })) });
  let sessions = h.sessionMessages(h.takeSent());
  assert.deepEqual(sessions.map((entry) => entry.id), ['ses_a', 'ses_b']);
  let settings = JSON.parse(h.storage.get('ocstatus.settings.v1'));
  assert.equal(settings.only_action, 1);
  assert.equal(settings.poll_rate, 0);

  h.handlers.webviewclosed({ response: encodeURIComponent(JSON.stringify({ poll_rate: 0, only_action: 0 })) });
  sessions = h.sessionMessages(h.takeSent());
  assert.deepEqual(sessions.map((entry) => entry.id), ['ses_a', 'ses_b', 'ses_c']);
  settings = JSON.parse(h.storage.get('ocstatus.settings.v1'));
  assert.equal(settings.only_action, 0);
});

test('custom poll rate stops subscriptions and reads sources on its own', async () => {
  const h = harness();
  h.setSource('configured', { instances: [{
    properties: { configured: { boolean: { value: true } } }
  }] });
  h.setSource('chats', { instances: [chat('ses_a', 'Polled chat')] });
  h.setSource('active_session', { instances: [session('ses_a', 'Polled chat')] });
  h.setSource('chat_status', { instances: [chatStatusRow('ses_a', 'Polled chat')] });
  h.setSource('question', { instances: [] });
  h.takeSent();
  assert.ok(h.subscriptions.length > 0);

  h.handlers.webviewclosed({ response: encodeURIComponent(JSON.stringify({ poll_rate: 10, only_action: 0 })) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.subscriptions.length, 0, 'subscriptions stopped');
  const sessions = h.sessionMessages(h.takeSent());
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'ses_a');

  h.handlers.webviewclosed({ response: encodeURIComponent(JSON.stringify({ poll_rate: 0, only_action: 0 })) });
  assert.ok(h.subscriptions.length > 0, 'subscriptions restored');
});

test('mark-read-after dismisses old unread replies on load', async () => {
  const h = harness();
  h.handlers.webviewclosed({
    response: encodeURIComponent(JSON.stringify({ mark_read_after: 900 }))
  });
  const now = Math.floor(Date.now() / 1000);
  h.fire('opencode', 'chat_status', {
    instances: [
      chatStatusRow('ses_old', 'Old unread', {
        reason: 'Unread', unread: true, messageId: 'msg_old', updated: 1700000000
      }),
      chatStatusRow('ses_new', 'Fresh unread', {
        reason: 'Unread', unread: true, messageId: 'msg_new', updated: now
      }),
      chatStatusRow('ses_perm', 'Permission unread', {
        reason: 'Permission', unread: true, permissionCount: 1,
        messageId: 'msg_perm', updated: 1700000000
      })
    ]
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].action, 'mark_chat_read');
  assert.deepEqual(JSON.parse(JSON.stringify(h.actions[0].args)), {
    session_id: 'ses_old',
    message_id: 'msg_old'
  });
  const sessions = h.sessionMessages(h.takeSent());
  const flags = Object.fromEntries(sessions.map((session) => [session.id, session.flags]));
  assert.equal(flags.ses_old & 8, 0, 'old unread cleared');
  assert.ok(flags.ses_new & 8, 'fresh unread kept');
  assert.ok(flags.ses_perm & 0x20, 'permission kept');
  const settings = JSON.parse(h.storage.get('ocstatus.settings.v1'));
  assert.equal(settings.mark_read_after, 900);
});

test('permission detail routes before replies and approves once', async () => {
  const h = harness();
  h.setPermission({
    instances: [permissionRow('ses_p', 'Project', 'perm_1', 'shell', ['git push'])]
  });
  h.fire('opencode', 'chat_status', {
    instances: [chatStatusRow('ses_p', 'Project', { reason: 'Permission', permissionCount: 1 })]
  });
  h.takeSent();

  h.watch({ detail_req: 1, session_id: 'ses_p' });
  await new Promise((resolve) => setImmediate(resolve));
  const detail = h.takeSent().find((message) => message.detail_kind === 4);
  assert.ok(detail);
  assert.equal(detail.permission_request_id, 'perm_1');
  assert.match(detail.detail_text, /Action: shell/);
  assert.match(detail.detail_text, /git push/);

  h.watch({
    permission_decision: 1,
    session_id: 'ses_p',
    permission_request_id: 'perm_1',
    permission_choice: 0
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.actions[0].action, 'approve_permission');
  assert.deepEqual(JSON.parse(JSON.stringify(h.actions[0].args)), {
    session_id: 'ses_p',
    request_id: 'perm_1',
    decision: 'once'
  });
  assert.ok(h.takeSent().some((message) => message.result_ok === 1));
});

test('dictated reply uploads and steers the selected session', async () => {
  const h = harness();
  h.takeSent();
  h.watch({
    send_prompt_begin: 1,
    session_id: 'ses_send',
    send_delivery: 1,
    send_prompt_count: 2
  });
  h.watch({ send_prompt_index: 0, send_prompt_chunk: 'Please ' });
  h.watch({ send_prompt_index: 1, send_prompt_chunk: 'continue.' });
  h.watch({ send_prompt_end: 1 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(h.actions.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.actions[0].args)), {
    message: 'Please continue.',
    chat_id: 'ses_send',
    delivery: 'steer'
  });
  const result = h.takeSent().find((message) => message.send_ok !== undefined);
  assert.ok(result);
  assert.equal(result.send_ok, 1);
  assert.equal(result.session_id, 'ses_send');
});

test('incomplete dictated reply is rejected without invoking an action', async () => {
  const h = harness();
  h.takeSent();
  h.watch({
    send_prompt_begin: 1,
    session_id: 'ses_send',
    send_delivery: 0,
    send_prompt_count: 2
  });
  h.watch({ send_prompt_index: 0, send_prompt_chunk: 'partial' });
  h.watch({ send_prompt_end: 1 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(h.actions.length, 0);
  const result = h.takeSent().find((message) => message.send_ok !== undefined);
  assert.ok(result);
  assert.equal(result.send_ok, 0);
});

test('missing plugin sends a clear status and no subscriptions', () => {
  const h = harness({ installed: false });
  assert.equal(h.subscriptions.length, 0);
  const messages = h.takeSent();
  const end = messages.find((message) => message.list_end);
  assert.equal(end.status_text, 'No OC plugin');
});

function bundledPlugin(sources = [
  { category: 'agent', items: ['chats'] },
  { category: 'opencode', items: ['replies', 'reply'] }
]) {
  return { uuid: BUNDLED_OPENCODE_UUID, name: 'OpenCode Status', sources };
}

function openReplyStorage(token, sessionId, expiresAt) {
  return {
    'ocstatus.replyLaunch.v1': JSON.stringify({
      [String(token)]: { sessionId, expiresAt }
    })
  };
}

test('bundled UUID is selected for sources, reads, and actions', async () => {
  const h = harness({ plugins: [bundledPlugin()] });
  assert.ok(h.subscriptions.length > 0);
  assert.ok(h.subscriptions.every((entry) => entry.plugin === BUNDLED_OPENCODE_UUID));

  h.watch({ detail_req: 1, session_id: 'ses_bundled' });
  assert.ok(h.reads.length > 0);
  assert.ok(h.reads.every((request) => request.plugin === BUNDLED_OPENCODE_UUID));

  h.watch({
    permission_decision: 1,
    session_id: 'ses_bundled',
    permission_request_id: 'perm_1',
    permission_choice: 0
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].plugin, BUNDLED_OPENCODE_UUID);
});

test('legacy UUID is the fallback when the bundled plugin is absent', () => {
  const h = harness();
  assert.ok(h.subscriptions.length > 0);
  assert.ok(h.subscriptions.every((entry) => entry.plugin === OPENCODE_UUID));
});

test('a bundled plugin with the wrong source list is not used', () => {
  const h = harness({ plugins: [bundledPlugin(['agent/chats'])] });
  assert.equal(h.subscriptions.length, 0);
  const end = h.takeSent().find((message) => message.list_end);
  assert.ok(end);
  assert.equal(end.status_text, 'No OC plugin');
});

test('open_reply routes a valid, unexpired token in the combined app', () => {
  const token = 123456;
  const h = harness({
    plugins: [bundledPlugin()],
    now: 1700000000000,
    storage: openReplyStorage(token, 'ses_launch', 1700000060000)
  });
  h.takeSent();
  h.watch({ open_reply: token });
  const response = h.takeSent().find((message) => message.open_reply !== undefined);
  assert.ok(response);
  assert.equal(response.open_reply, token);
  assert.equal(response.session_id, 'ses_launch');
});

test('valid open_reply route followed by detail_req reads reply for routed session', async () => {
  const token = 123457;
  const h = harness({
    plugins: [bundledPlugin()],
    now: 1700000000000,
    storage: openReplyStorage(token, 'ses_launch', 1700000060000)
  });
  h.takeSent();
  h.watch({ open_reply: token });
  const response = h.takeSent().find((message) => message.open_reply !== undefined);
  assert.equal(response.session_id, 'ses_launch');

  h.watch({ detail_req: 1, session_id: response.session_id });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(h.reads.some((request) => request.item === 'replies' &&
    request.plugin === BUNDLED_OPENCODE_UUID));
  assert.ok(h.takeSent().some((message) => message.session_id === 'ses_launch'));
});

test('open_reply rejects expired and malformed entries', () => {
  const token = 222;
  const expired = harness({
    plugins: [bundledPlugin()],
    now: 1700000000000,
    storage: openReplyStorage(token, 'ses_expired', 1700000000000)
  });
  expired.takeSent();
  expired.watch({ open_reply: token });
  let response = expired.takeSent().find((message) => message.open_reply !== undefined);
  assert.ok(response);
  assert.equal(response.open_reply, token);
  assert.equal(response.session_id, undefined);

  const nonNumericExpiry = harness({
    plugins: [bundledPlugin()],
    now: 1700000000000,
    storage: openReplyStorage(token, 'ses_numeric', '1700000060000')
  });
  nonNumericExpiry.takeSent();
  nonNumericExpiry.watch({ open_reply: token });
  response = nonNumericExpiry.takeSent().find((message) => message.open_reply !== undefined);
  assert.equal(response.session_id, undefined);

  const malformed = harness({
    plugins: [bundledPlugin()],
    now: 1700000000000,
    storage: {
      'ocstatus.replyLaunch.v1': JSON.stringify({
        [String(token)]: { sessionId: 'bad session!', expiresAt: 1700000060000 }
      })
    }
  });
  malformed.takeSent();
  malformed.watch({ open_reply: token });
  response = malformed.takeSent().find((message) => message.open_reply !== undefined);
  assert.ok(response);
  assert.equal(response.session_id, undefined);
});

test('open_reply does not resolve the shared token outside the combined app', () => {
  const token = 333;
  const h = harness({
    now: 1700000000000,
    storage: openReplyStorage(token, 'ses_legacy', 1700000060000)
  });
  h.takeSent();
  h.watch({ open_reply: token });
  const response = h.takeSent().find((message) => message.open_reply !== undefined);
  assert.ok(response);
  assert.equal(response.open_reply, token);
  assert.equal(response.session_id, undefined);
});

test('configmessage returns and saves sanitized settings without cross-setting changes', () => {
  const h = harness({
    storage: {
      'ocstatus.settings.v1': JSON.stringify({
        poll_rate: 0,
        subagents: 'number',
        mark_read_after: 900,
        canned_replies: ['Yes']
      })
    }
  });
  let replied = null;
  h.handlers.configmessage({
    data: { type: 'ocstatus_settings' },
    respond(value) { replied = value; }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(replied)), {
    poll_rate: 0,
    only_action: 0,
    subagents: 'number',
    mark_read_after: 900,
    canned_replies: ['Yes']
  });

  replied = null;
  h.handlers.configmessage({
    data: { type: 'ocstatus_save_settings', settings: { only_action: 1 } },
    respond(value) { replied = value; }
  });
  assert.equal(replied.only_action, 1);
  assert.equal(replied.poll_rate, 0);
  assert.equal(replied.subagents, 'number');
  assert.equal(replied.mark_read_after, 900);
  assert.deepEqual(JSON.parse(JSON.stringify(replied.canned_replies)), ['Yes']);

  replied = null;
  h.handlers.configmessage({
    payload: {
      type: 'ocstatus_save_settings',
      settings: { poll_rate: 999, canned_replies: [' Run ', 'Run', 'x'.repeat(100)] }
    },
    respond(value) { replied = value; }
  });
  assert.equal(replied.poll_rate, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(replied.canned_replies)), ['Run', 'x'.repeat(80)]);
});

test('configmessage reports failed settings persistence and restores in-memory settings', () => {
  const h = harness({ failStorageWrites: true });
  let replied = null;
  h.handlers.configmessage({
    data: { type: 'ocstatus_save_settings', settings: { only_action: 1 } },
    respond(value) { replied = value; }
  });
  assert.deepEqual(JSON.parse(JSON.stringify(replied)), { error: 'settings could not be saved' });
  h.handlers.configmessage({
    data: { type: 'ocstatus_settings' },
    respond(value) { replied = value; }
  });
  assert.equal(replied.only_action, 0);
});

test('manual polling reads recent replies at most once a minute only when opted in', async () => {
  const h = harness({
    plugins: [bundledPlugin()],
    storage: { 'ocstatus.replyAlerts.enabled.v1': '1' },
    replies: { instances: [] }
  });
  h.setSource('configured', { instances: [] });
  h.setSource('chats', { instances: [] });
  h.setSource('active_session', { instances: [] });
  h.setSource('chat_status', { instances: [] });
  h.setSource('question', { instances: [] });
  h.handlers.webviewclosed({ response: encodeURIComponent(JSON.stringify({ poll_rate: 10 })) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.reads.filter((request) => request.item === 'replies').length, 1);
  assert.equal(h.reads.find((request) => request.item === 'replies').plugin, BUNDLED_OPENCODE_UUID);

  h.reads.splice(0, h.reads.length);
  h.runTimers();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.reads.filter((request) => request.item === 'replies').length, 0);

  h.advanceTime(61000);
  h.runTimers();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.reads.filter((request) => request.item === 'replies').length, 1);
});

test('manual poll alert-setting read failure skips replies without blocking poll completion', async () => {
  const h = harness({
    plugins: [bundledPlugin()],
    storage: { 'ocstatus.replyAlerts.enabled.v1': '1' },
    failStorageReadKey: 'ocstatus.replyAlerts.enabled.v1'
  });
  h.setSource('configured', { instances: [] });
  h.setSource('chats', { instances: [] });
  h.setSource('active_session', { instances: [] });
  h.setSource('chat_status', { instances: [] });
  h.setSource('question', { instances: [] });
  h.handlers.webviewclosed({ response: encodeURIComponent(JSON.stringify({ poll_rate: 10 })) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(h.reads.some((request) => request.item === 'chat_status'));
  assert.ok(h.reads.some((request) => request.item === 'question'));
  assert.equal(h.reads.some((request) => request.item === 'replies'), false);
  assert.equal(h.runTimerWithDelay(10000), true, 'poll completion schedules next cycle');
});

test('manual polling does not read recent replies by default or for the legacy UUID', async () => {
  const off = harness({ plugins: [bundledPlugin()], replies: { instances: [] } });
  off.handlers.webviewclosed({ response: encodeURIComponent(JSON.stringify({ poll_rate: 10 })) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(off.reads.some((request) => request.item === 'replies'), false);

  const legacy = harness({
    storage: { 'ocstatus.replyAlerts.enabled.v1': '1' },
    replies: { instances: [] }
  });
  legacy.handlers.webviewclosed({ response: encodeURIComponent(JSON.stringify({ poll_rate: 10 })) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(legacy.reads.some((request) => request.item === 'replies'), false);
});
