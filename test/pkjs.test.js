'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const OPENCODE_UUID = '4e2c758f-8a31-4bf2-a6d9-7c40ec9b5173';

function harness(options = {}) {
  const handlers = {};
  const subscriptions = [];
  const sent = [];
  const storage = new Map();
  const actions = [];
  const opened = [];
  const sourceEnvelopes = new Map();
  const timers = new Map();
  let nextTimer = 0;
  let replyEnvelope = options.reply || null;
  let repliesEnvelope = options.replies || null;
  let permissionEnvelope = options.permission || null;
  let installed = options.installed !== false;

  const Pebble = {
    enumeratePlugins() {
      return installed ? [{ uuid: OPENCODE_UUID, name: 'OpenCode' }] : [];
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
    sendAppMessage(message, success) {
      sent.push(message);
      if (success) success();
    },
    addEventListener(name, callback) {
      handlers[name] = callback;
    }
  };

  const sandbox = {
    Pebble,
    console: { log() {} },
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); }
    },
    setTimeout(callback) {
      const id = ++nextTimer;
      timers.set(id, callback);
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
    Date,
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
    const due = Array.from(timers.values());
    timers.clear();
    due.forEach((callback) => callback());
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
    setReply(envelope) { replyEnvelope = envelope; },
    setReplies(envelope) { repliesEnvelope = envelope; },
    setPermission(envelope) { permissionEnvelope = envelope; },
    setSource(item, envelope) { sourceEnvelopes.set(item, envelope); },
    setInstalled(value) { installed = value; },
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
