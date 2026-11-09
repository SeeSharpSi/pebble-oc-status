// OC Status PKJS: the phone-side bridge between the OpenCode Pebble plugin and the watch UI.
//
// Everything here is read-only with respect to OpenCode until the user answers a question.
// Sessions come from the plugin's `agent/chats` and `opencode/active_session` sources. A
// question takes precedence when a session is opened; otherwise the app shows the latest reply
// the plugin exposes. That reply source follows the plugin's configured default session, so the
// UI says so plainly rather than pretending every session can be read back.

var OPENCODE_UUID = '4e2c758f-8a31-4bf2-a6d9-7c40ec9b5173';
var MAX_SESSIONS = 20;
var MAX_CHOICES = 24;
var REPLY_CHUNK_SIZE = 150;
var REPLY_CHUNK_BYTES = 380;
var KNOWN_LIMIT = 40;
var KNOWN_MAX_AGE_SEC = 12 * 60 * 60;

var FLAG_RUNNING = 0x01;
var FLAG_ATTENTION = 0x02;
var FLAG_QUESTION = 0x04;
var FLAG_UNVIEWED = 0x08;
var FLAG_SUBAGENT = 0x10;
var FLAG_PERMISSION = 0x20;

var KEY_UNVIEWED = 'ocstatus.unviewed.v1';
var KEY_VIEWED_REPLY = 'ocstatus.viewedReply.v1';
var KEY_KNOWN = 'ocstatus.known.v1';

var state = {
  installed: null,
  configured: null,
  chats: [],
  active: [],
  questions: {},
  reply: null,
  replies: {},
  chatStatus: {},
  permissions: {},
  promptUpload: null,
  markReadInFlight: {},
  markReadDone: {},
  permissionPending: false,
  errors: {},
  known: readObject(KEY_KNOWN, {}),
  unviewed: readObject(KEY_UNVIEWED, {}),
  viewedReply: readObject(KEY_VIEWED_REPLY, {}),
  previousActive: {},
  suppressUnviewedUntil: {},
  subscriptions: [],
  subscribed: false,
  listSignature: '',
  detailSession: '',
  detailKind: '',
  flow: null,
  lastReplyKey: '',
  actionPending: false
};

var sendQueue = [];
var sending = false;

// ---------------------------------------------------------------- small helpers

function log(message) {
  console.log('[OCStatus] ' + message);
}

function readObject(key, fallback) {
  try {
    var raw = localStorage.getItem(key);
    if (!raw) return fallback;
    var parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeObject(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    log('could not save ' + key + ': ' + e);
  }
}

function propText(property) {
  if (!property) return '';
  if (property.longText && typeof property.longText.text === 'string') return property.longText.text;
  if (property.shortText && typeof property.shortText.text === 'string') return property.shortText.text;
  return '';
}

function propBool(property) {
  return !!(property && property.boolean && property.boolean.value === true);
}

function propNumber(property) {
  if (!property || !property.numericValue) return 0;
  var value = property.numericValue.value;
  return typeof value === 'number' && isFinite(value) ? value : 0;
}

function cleanName(value) {
  var text = value ? String(value).replace(/[\r\n\t]+/g, ' ') : '';
  text = text.replace(/\s+/g, ' ');
  if (text.length > 54) text = text.slice(0, 54);
  return text || 'Untitled';
}

function unicodeChunks(text, maxBytes, maxChars) {
  var out = [];
  var start = 0;
  var bytes = 0;
  var chars = 0;
  var i = 0;
  while (i < text.length) {
    var code = text.codePointAt(i);
    var units = code > 0xffff ? 2 : 1;
    var width = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (chars > 0 && (bytes + width > maxBytes || chars + 1 > maxChars)) {
      out.push(text.slice(start, i));
      start = i;
      bytes = 0;
      chars = 0;
    }
    bytes += width;
    chars += 1;
    i += units;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

function pluginInstalled() {
  try {
    var plugins = Pebble.enumeratePlugins();
    if (!Array.isArray(plugins)) return false;
    return plugins.some(function (plugin) { return plugin && plugin.uuid === OPENCODE_UUID; });
  } catch (e) {
    return false;
  }
}

function errorCode(error) {
  if (!error) return 'UNKNOWN';
  if (typeof error === 'string') return error;
  return typeof error.code === 'string' ? error.code : 'UNKNOWN';
}

function errorText(error) {
  var code = errorCode(error);
  if (code === 'AUTH_REQUIRED') return 'Configure the OpenCode plugin';
  if (code === 'PERMISSION_DENIED') return 'Permission denied in Pebble app';
  if (code === 'RATE_LIMITED') return 'OpenCode is rate limited';
  if (code === 'TIMEOUT') return 'OpenCode timed out';
  if (code === 'PLUGIN_UNAVAILABLE') return 'OpenCode plugin unavailable';
  if (error && typeof error.message === 'string' && error.message) return error.message;
  return 'OpenCode unavailable';
}

function shortErrorText(error) {
  var text = errorText(error);
  if (text.length > 64) text = text.slice(0, 64);
  return text;
}

// ---------------------------------------------------------------- outgoing messages

function isListMessage(dict) {
  return !!(dict.list_begin || dict.list_end ||
            (dict.index !== undefined && dict.session_id !== undefined));
}

function isDetailMessage(dict) {
  return !!(dict.detail_kind !== undefined || dict.reply_chunk !== undefined ||
            dict.reply_end !== undefined || dict.choice_label !== undefined ||
            dict.question_end !== undefined);
}

function dropQueuedDetail() {
  sendQueue = sendQueue.filter(function (message) { return !isDetailMessage(message); });
}

function enqueue(message) {
  if (!message) return;
  sendQueue.push(message);
  if (sendQueue.length > 120) sendQueue.splice(0, sendQueue.length - 120);
  pump();
}

function enqueueList(messages) {
  // A newer snapshot makes an older one obsolete. Drop queued list traffic so a burst of
  // session updates cannot leave the watch a minute behind.
  sendQueue = sendQueue.filter(function (message) { return !isListMessage(message); });
  messages.forEach(enqueue);
}

function pump() {
  if (sending || sendQueue.length === 0) return;
  sending = true;
  var message = sendQueue.shift();
  try {
    Pebble.sendAppMessage(message, function () {
      sending = false;
      pump();
    }, function (error) {
      sending = false;
      log('send failed: ' + JSON.stringify(error));
      setTimeout(pump, 250);
    });
  } catch (e) {
    sending = false;
    log('send threw: ' + e);
    setTimeout(pump, 250);
  }
}

// ---------------------------------------------------------------- session names and memory

function activeFor(id) {
  for (var i = 0; i < state.active.length; i++) {
    if (state.active[i].id === id) return state.active[i];
  }
  return null;
}

function chatFor(id) {
  for (var i = 0; i < state.chats.length; i++) {
    if (state.chats[i].id === id) return state.chats[i];
  }
  return null;
}

function nameFor(id) {
  var active = activeFor(id);
  if (active && active.name) return active.name;
  var chat = chatFor(id);
  if (chat && chat.name) return chat.name;
  if (state.known[id] && state.known[id].name) return state.known[id].name;
  return 'Session';
}

function rememberSession(id, name, updated) {
  if (!id || id === 'new') return;
  var clean = cleanName(name || nameFor(id));
  var stamp = updated && updated > 0 ? Math.floor(updated) : Math.floor(Date.now() / 1000);
  var entry = state.known[id];
  if (entry && entry.name === clean && entry.updated === stamp) return;
  if (entry && entry.name && clean.length < entry.name.length && clean.length <= 8) {
    clean = entry.name;
  }
  state.known[id] = { name: clean, updated: stamp };
  pruneKnown();
  writeObject(KEY_KNOWN, state.known);
}

function pruneKnown() {
  var ids = Object.keys(state.known);
  if (ids.length <= KNOWN_LIMIT) return;
  ids.sort(function (a, b) {
    return (state.known[a].updated || 0) - (state.known[b].updated || 0);
  });
  while (ids.length > KNOWN_LIMIT) {
    delete state.known[ids.shift()];
  }
}

function markUnviewed(id) {
  if (!id) return;
  if (state.unviewed[id]) return;
  state.unviewed[id] = true;
  writeObject(KEY_UNVIEWED, state.unviewed);
}

function clearUnviewed(id) {
  if (!id || !state.unviewed[id]) return;
  delete state.unviewed[id];
  writeObject(KEY_UNVIEWED, state.unviewed);
}

function clearAttentionFor(id) {
  clearUnviewed(id);
  state.suppressUnviewedUntil[id] = Date.now() + 15000;
}

function viewedReplyMatches(id, messageId) {
  return !!(messageId && state.viewedReply[id] === messageId);
}

function markReplyViewed(id, messageId) {
  if (!id || !messageId) return;
  if (state.viewedReply[id] === messageId) return;
  state.viewedReply[id] = messageId;
  var ids = Object.keys(state.viewedReply);
  if (ids.length > KNOWN_LIMIT) {
    ids.sort(function (a, b) { return state.viewedReply[a] < state.viewedReply[b] ? -1 : 1; });
    delete state.viewedReply[ids[0]];
  }
  writeObject(KEY_VIEWED_REPLY, state.viewedReply);
}

function countAttention(sessions) {
  var count = 0;
  sessions.forEach(function (session) {
    if (session.flags & FLAG_ATTENTION) count++;
  });
  return count;
}

function statusText() {
  if (state.installed === false) return 'No OC plugin';
  if (state.errors.active === 'AUTH_REQUIRED' || state.errors.chats === 'AUTH_REQUIRED') {
    return 'Configure';
  }
  if (state.errors.active === 'PERMISSION_DENIED' || state.errors.chats === 'PERMISSION_DENIED') {
    return 'Denied';
  }
  if (state.errors.active || state.errors.chats) return 'Unavailable';
  if (state.configured === false) return 'Configure';
  var sessions = mergedSessions();
  var attention = countAttention(sessions);
  if (attention > 0) return attention + (attention === 1 ? ' needs you' : ' need you');
  var active = state.active.length;
  if (active > 0) return active + ' active';
  if (sessions.length > 0) return 'No active';
  return state.installed ? 'No sessions' : 'Connecting...';
}

// ---------------------------------------------------------------- session list

function mergedSessions() {
  var now = Math.floor(Date.now() / 1000);
  var seen = {};
  var chatIds = {};
  var list = [];

  state.chats.forEach(function (chat) { chatIds[chat.id] = true; });

  function add(id, fallbackName, updated) {
    if (!id || id === 'new' || seen[id]) return;
    seen[id] = true;
    var active = activeFor(id);
    var chat = chatFor(id);
    var known = state.known[id];
    var status = state.chatStatus[id];
    var name = active && active.name ? active.name :
               status && status.name ? status.name :
               chat && chat.name ? chat.name :
               known && known.name ? known.name : cleanName(fallbackName);
    var flags = 0;
    if (status) {
      if (status.needsAction) flags |= FLAG_ATTENTION;
      if (status.permissionCount > 0 || status.reason === 'Permission') {
        flags |= FLAG_PERMISSION | FLAG_ATTENTION;
      }
      if (status.questionCount > 0 || status.reason === 'Question') {
        flags |= FLAG_QUESTION | FLAG_ATTENTION;
      }
      if (status.unread) flags |= FLAG_UNVIEWED | FLAG_ATTENTION;
      if (status.isSubagent) flags |= FLAG_SUBAGENT;
    }
    if (active) {
      if (active.status === 'Running') {
        flags |= FLAG_RUNNING;
      } else {
        flags |= FLAG_ATTENTION;
        if (active.status.indexOf('approval') !== -1) flags |= FLAG_PERMISSION;
        else if (active.status.indexOf('input') !== -1) flags |= FLAG_QUESTION;
      }
      if (active.subagent) flags |= FLAG_SUBAGENT;
    }
    if (state.questions[id] && state.questions[id].length) {
      flags |= FLAG_QUESTION | FLAG_ATTENTION;
    }
    if (!status && state.unviewed[id]) {
      flags |= FLAG_UNVIEWED | FLAG_ATTENTION;
    }
    list.push({ id: id, name: cleanName(name), flags: flags, updated: updated || 0 });
  }

  function knownOnly(unviewed) {
    return Object.keys(state.known).filter(function (id) {
      if (activeFor(id) || chatIds[id]) return false;
      if (unviewed) return !!state.unviewed[id] && !state.chatStatus[id];
      var known = state.known[id];
      return !state.unviewed[id] &&
             ((state.questions[id] && state.questions[id].length) ||
              now - (known.updated || 0) < KNOWN_MAX_AGE_SEC);
    }).sort(function (a, b) {
      return (state.known[b].updated || 0) - (state.known[a].updated || 0);
    });
  }

  function attentionRank(status) {
    if (status.reason === 'Permission') return 0;
    if (status.reason === 'Question') return 1;
    if (status.reason === 'Unread') return 2;
    return 3;
  }

  // Running sessions first in the plugin's parent-before-child order, then chats that need
  // action, then completions that are not in the chat list, then the chat list in plugin order.
  state.active.forEach(function (active) { add(active.id, active.name, active.updated); });
  Object.keys(state.chatStatus)
    .filter(function (id) { return state.chatStatus[id].needsAction; })
    .sort(function (a, b) {
      var left = state.chatStatus[a];
      var right = state.chatStatus[b];
      var rank = attentionRank(left) - attentionRank(right);
      return rank !== 0 ? rank : (right.updated || 0) - (left.updated || 0);
    })
    .forEach(function (id) { add(id, state.chatStatus[id].name, state.chatStatus[id].updated); });
  knownOnly(true).forEach(function (id) { add(id, state.known[id].name, state.known[id].updated); });
  state.chats.forEach(function (chat) { add(chat.id, chat.name, 0); });
  Object.keys(state.chatStatus).forEach(function (id) {
    add(id, state.chatStatus[id].name, state.chatStatus[id].updated);
  });
  knownOnly(false).forEach(function (id) { add(id, state.known[id].name, state.known[id].updated); });
  Object.keys(state.questions).forEach(function (id) { add(id, 'Question', 0); });

  return list.slice(0, MAX_SESSIONS);
}

function listSignature(sessions) {
  var signature = [];
  sessions.forEach(function (session) {
    signature.push([session.id, session.name, session.flags].join('\u0001'));
  });
  return signature.join('\u0002') + '\u0003' + statusText();
}function sendList(force) {
  var sessions = mergedSessions();
  var signature = listSignature(sessions);
  if (!force && signature === state.listSignature) return;
  state.listSignature = signature;

  var messages = [{ list_begin: 1, count: sessions.length }];
  sessions.forEach(function (session, index) {
    messages.push({
      index: index,
      session_id: session.id,
      session_name: session.name,
      session_flags: session.flags
    });
  });
  messages.push({ list_end: 1, status_text: statusText() });
  enqueueList(messages);
}

function rebuild(force) {
  sendList(!!force);
}

// ---------------------------------------------------------------- source handlers

function onConfigured(envelope) {
  state.errors.configured = null;
  var instance = envelope && envelope.instances && envelope.instances[0];
  state.configured = instance ? propBool((instance.properties || {}).configured) : false;
  rebuild();
}

function onChats(envelope) {
  state.errors.chats = null;
  var chats = [];
  var seen = {};
  (envelope && envelope.instances ? envelope.instances : []).forEach(function (instance) {
    if (!instance || !instance.instanceId || instance.instanceId === 'new' || seen[instance.instanceId]) return;
    seen[instance.instanceId] = true;
    var properties = instance.properties || {};
    var name = cleanName(propText(properties.name) || propText(properties.title));
    chats.push({ id: instance.instanceId, name: name });
    rememberSession(instance.instanceId, name, 0);
  });
  state.chats = chats;
  rebuild();
}

function onActive(envelope) {
  state.errors.active = null;
  var previous = state.previousActive;
  var next = {};
  var active = [];

  (envelope && envelope.instances ? envelope.instances : []).forEach(function (instance) {
    if (!instance || !instance.instanceId) return;
    var properties = instance.properties || {};
    var id = instance.instanceId;
    var status = propText(properties.status) || 'Running';
    var name = cleanName(propText(properties.name) || propText(properties.title));
    var subagent = propBool(properties.is_subagent);
    var updated = propNumber(properties.updated);

    next[id] = { subagent: subagent };
    active.push({ id: id, name: name, status: status, subagent: subagent, updated: updated });

    // A new run supersedes an old completion badge. Subagents are support activity, not
    // sessions the user chose, so they do not become their own remembered history entries.
    if (!previous[id] && state.unviewed[id]) clearUnviewed(id);
    if (!subagent) rememberSession(id, name, updated);
  });

  Object.keys(previous).forEach(function (id) {
    if (next[id]) return;
    if (previous[id] && previous[id].subagent) return;
    if (state.detailSession === id) return;
    if (state.suppressUnviewedUntil[id] > Date.now()) return;
    rememberSession(id, nameFor(id), 0);
    markUnviewed(id);
  });

  state.previousActive = next;
  state.active = active;
  rebuild();
}

function chatStatusEntry(properties) {
  var sessionId = propText(properties.session_id);
  if (!sessionId) return null;
  var name = cleanName(propText(properties.name) || propText(properties.title) || nameFor(sessionId));
  return {
    sessionId: sessionId,
    name: name,
    title: propText(properties.title) || name,
    messageId: propText(properties.message_id),
    needsAction: propBool(properties.needs_action),
    reason: propText(properties.reason) || 'None',
    permissionCount: propNumber(properties.permission_count),
    questionCount: propNumber(properties.question_count),
    unread: propBool(properties.unread),
    updated: propNumber(properties.updated),
    isDefault: propBool(properties.is_default),
    isSubagent: propBool(properties.is_subagent)
  };
}

function recomputeChatStatus(entry) {
  if (!entry) return;
  entry.needsAction = entry.permissionCount > 0 || entry.questionCount > 0 || entry.unread;
  entry.reason = entry.permissionCount > 0 ? 'Permission' :
                 entry.questionCount > 0 ? 'Question' :
                 entry.unread ? 'Unread' : 'None';
}

function onChatStatus(envelope) {
  state.errors.chatStatus = null;
  var map = {};
  (envelope && envelope.instances ? envelope.instances : []).forEach(function (instance) {
    if (!instance) return;
    var entry = chatStatusEntry(instance.properties || {});
    if (!entry) return;
    if (entry.messageId && (state.markReadDone[entry.sessionId + '|' + entry.messageId] ||
        viewedReplyMatches(entry.sessionId, entry.messageId))) {
      entry.unread = false;
      recomputeChatStatus(entry);
    }
    map[entry.sessionId] = entry;
    rememberSession(entry.sessionId, entry.name, entry.updated);
  });
  state.chatStatus = map;
  rebuild();
}

function parseFields(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    var parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

function onQuestions(envelope) {
  state.errors.question = null;
  var map = {};
  (envelope && envelope.instances ? envelope.instances : []).forEach(function (instance) {
    if (!instance) return;
    var properties = instance.properties || {};
    var sessionId = propText(properties.session_id);
    var formId = propText(properties.form_id);
    if (!sessionId || !formId) return;
    var fields = parseFields(propText(properties.fields));
    if (!fields) return;
    var form = {
      sessionId: sessionId,
      formId: formId,
      title: propText(properties.question) || propText(properties.name) || 'Question',
      fields: fields,
      answerable: propBool(properties.answerable)
    };
    if (!map[sessionId]) map[sessionId] = [];
    map[sessionId].push(form);
  });
  state.questions = map;

  if (state.flow) {
    var live = map[state.flow.sessionId] || [];
    var stillThere = live.some(function (form) { return form.formId === state.flow.form.formId; });
    if (!stillThere) {
      var closedSession = state.flow.sessionId;
      state.flow = null;
      if (state.detailSession === closedSession && state.detailKind === 'question') {
        sendMessageDetail(closedSession, 'Question', 'Closed',
          'This question is no longer pending. It may have been answered elsewhere.');
      }
    }
  }
  rebuild();
}

function permissionEntry(properties) {
  var sessionId = propText(properties.session_id);
  var requestId = propText(properties.request_id);
  if (!sessionId || !requestId) return null;
  return {
    sessionId: sessionId,
    requestId: requestId,
    action: propText(properties.action) || 'permission',
    resources: propText(properties.resources) || '[]',
    message: propText(properties.message) || '',
    name: cleanName(propText(properties.name) || propText(properties.title) || nameFor(sessionId))
  };
}

function onPermissions(envelope) {
  state.errors.permission = null;
  var map = {};
  (envelope && envelope.instances ? envelope.instances : []).forEach(function (instance) {
    if (!instance) return;
    var entry = permissionEntry(instance.properties || {});
    if (!entry) return;
    if (!map[entry.sessionId]) map[entry.sessionId] = [];
    map[entry.sessionId].push(entry);
    rememberSession(entry.sessionId, entry.name, 0);
  });
  state.permissions = map;
}

function refreshPermissionsForDetail(sessionId, callback) {
  if (typeof Pebble.readSource !== 'function') {
    callback(null);
    return;
  }
  Pebble.readSource({
    plugin: OPENCODE_UUID,
    category: 'opencode',
    item: 'permission'
  }).then(function (envelope) {
    onPermissions(envelope);
    callback(null);
  }).catch(function (error) {
    state.errors.permission = errorCode(error);
    callback(error);
  });
}

function startPermission(sessionId) {
  var list = state.permissions[sessionId] || [];
  if (!list.length) return false;
  var entry = list[0];
  var resources = entry.resources || '[]';
  var text = 'Action: ' + entry.action + '\n\nResources:\n' + resources;
  if (entry.message) text += '\n\n' + entry.message;
  if (resources.length > 120 || text.length > 240) {
    sendMessageDetail(sessionId, nameFor(sessionId), 'Permission',
      'This permission request is too large to review on the watch. Open OpenCode on the phone or computer.');
    return true;
  }
  state.detailKind = 'permission';
  enqueue({
    detail_kind: 4,
    session_id: sessionId,
    detail_title: nameFor(sessionId),
    detail_status: entry.action,
    detail_text: text,
    permission_request_id: entry.requestId
  });
  return true;
}

function replyEntryFromProperties(sessionId, properties, fallbackName) {
  var text = propText(properties.text);
  var title = cleanName(propText(properties.name) || propText(properties.title) ||
                        fallbackName || nameFor(sessionId));
  return {
    sessionId: sessionId,
    messageId: propText(properties.message_id),
    text: text,
    hasText: !!text,
    complete: propBool(properties.complete),
    status: propText(properties.status),
    title: title,
    updated: propNumber(properties.updated),
    isDefault: propBool(properties.is_default)
  };
}

function mergeReplyEntry(base, update) {
  var merged = {};
  var source = base || {};
  Object.keys(source).forEach(function (key) { merged[key] = source[key]; });
  Object.keys(update || {}).forEach(function (key) { merged[key] = update[key]; });
  merged.isDefault = !!((base && base.isDefault) || (update && update.isDefault));
  return merged;
}

function replyEntryFor(sessionId) {
  var mapped = state.replies[sessionId] || null;
  var focused = state.reply && state.reply.sessionId === sessionId ? state.reply : null;
  if (focused && (!mapped || focused.updated >= mapped.updated)) {
    return mergeReplyEntry(mapped, focused);
  }
  return mapped;
}

function replyEntryKey(entry) {
  return entry.sessionId + '|' + entry.messageId + '|' +
         (entry.complete ? '1' : '0') + '|' + (entry.text ? entry.text.length : 0);
}

function markReplyEntryAttention(entry) {
  if (!entry || !entry.complete || !entry.messageId || !entry.hasText) return;
  if (state.detailSession === entry.sessionId) return;
  if (!state.unviewed[entry.sessionId] && !viewedReplyMatches(entry.sessionId, entry.messageId)) {
    markUnviewed(entry.sessionId);
  }
}

function maybeUpdateOpenReply(entry) {
  if (!entry || !entry.hasText) return;
  if (state.detailSession !== entry.sessionId || state.detailKind !== 'reply') return;
  var key = replyEntryKey(entry);
  if (key === state.lastReplyKey) return;
  state.lastReplyKey = key;
  sendReplyDetail(entry.sessionId);
}

function onReplies(envelope) {
  state.errors.replies = null;
  var map = {};
  (envelope && envelope.instances ? envelope.instances : []).forEach(function (instance) {
    if (!instance) return;
    var properties = instance.properties || {};
    var sessionId = propText(properties.session_id);
    if (!sessionId) return;
    var entry = replyEntryFromProperties(sessionId, properties, '');
    if (state.reply && state.reply.sessionId === sessionId &&
        state.reply.updated >= entry.updated) {
      entry = mergeReplyEntry(entry, state.reply);
    }
    map[sessionId] = entry;
    rememberSession(sessionId, entry.title, entry.updated);
    markReplyEntryAttention(entry);
  });
  if (state.reply && !map[state.reply.sessionId]) {
    map[state.reply.sessionId] = state.reply;
  }
  state.replies = map;
  var selected = map[state.detailSession];
  if (selected) maybeUpdateOpenReply(selected);
  rebuild();
}

function applyReply(envelope, fromDetail) {
  state.errors.reply = null;
  var instance = envelope && envelope.instances && envelope.instances[0];
  if (!instance) {
    state.reply = null;
    return;
  }
  var properties = instance.properties || {};
  var sessionId = propText(properties.session_id);
  var entry = replyEntryFromProperties(sessionId, properties, '');
  entry.isDefault = !!(state.replies[sessionId] && state.replies[sessionId].isDefault);
  state.reply = entry;
  state.replies[sessionId] = mergeReplyEntry(state.replies[sessionId], entry);
  rememberSession(sessionId, entry.title, entry.updated);
  markReplyEntryAttention(entry);
  if (!fromDetail) maybeUpdateOpenReply(entry);
}

// ---------------------------------------------------------------- detail replies

function noReplyMessage(sessionId) {
  if (state.replies[sessionId]) {
    return 'No latest reply is available yet.';
  }
  return 'This session is not in the plugin\'s recent replies. Increase Recent replies in the OpenCode plugin settings, or set this session as the default.';
}

function sendMessageDetail(sessionId, title, status, text) {
  state.detailKind = 'message';
  enqueue({
    detail_kind: 3,
    session_id: sessionId,
    detail_title: cleanName(title || nameFor(sessionId)),
    detail_status: status || '',
    detail_text: text
  });
}

function sendReplyDetail(sessionId) {
  var reply = replyEntryFor(sessionId);
  if (!reply || !reply.hasText) {
    var status = reply && reply.status ? reply.status : 'No reply';
    sendMessageDetail(sessionId, nameFor(sessionId), status, noReplyMessage(sessionId));
    return;
  }
  state.detailKind = 'reply';
  var text = reply.text || '';
  var chunks = unicodeChunks(text, REPLY_CHUNK_BYTES, REPLY_CHUNK_SIZE);
  enqueue({
    detail_kind: 1,
    session_id: sessionId,
    detail_title: reply.title || nameFor(sessionId),
    detail_status: reply.status || '',
    detail_message_id: reply.messageId || '',
    reply_count: chunks.length
  });
  chunks.forEach(function (chunk, index) {
    enqueue({ session_id: sessionId, reply_index: index, reply_chunk: chunk });
  });
  enqueue({ session_id: sessionId, reply_end: 1 });
  state.lastReplyKey = replyEntryKey(reply);
}

function waitingText(sessionId) {
  var active = activeFor(sessionId);
  if (!active || active.status === 'Running') return '';
  if (active.status === 'Waiting for approval') {
    return 'This session is waiting for approval. Approve it in OpenCode on the phone or computer.';
  }
  return 'This session is waiting for input. Open it in OpenCode on the phone or computer.';
}

function refreshFocusedReply(sessionId, sendFallback) {
  if (typeof Pebble.readSource !== 'function') return;
  Pebble.readSource({
    plugin: OPENCODE_UUID,
    category: 'opencode',
    item: 'reply'
  }).then(function (envelope) {
    applyReply(envelope, true);
    if (state.detailSession !== sessionId || state.detailKind === 'question') return;
    var entry = replyEntryFor(sessionId);
    if (entry && entry.hasText) {
      sendReplyDetail(sessionId);
    } else if (sendFallback) {
      sendMessageDetail(sessionId, nameFor(sessionId),
        entry && entry.status ? entry.status : 'No reply', noReplyMessage(sessionId));
    }
  }).catch(function (error) {
    state.errors.reply = errorCode(error);
    if (sendFallback && state.detailSession === sessionId && state.detailKind !== 'question') {
      sendMessageDetail(sessionId, nameFor(sessionId), 'Reply unavailable', shortErrorText(error));
    }
  });
}

function refreshReplyForDetail(sessionId) {
  var waiting = waitingText(sessionId);
  if (waiting) {
    sendMessageDetail(sessionId, nameFor(sessionId), activeFor(sessionId).status, waiting);
    return;
  }

  var entry = replyEntryFor(sessionId);
  var focusedSession = !!(entry && (entry.isDefault ||
    (state.reply && state.reply.sessionId === sessionId)));
  if (entry && entry.hasText) {
    sendReplyDetail(sessionId);
    if (focusedSession) refreshFocusedReply(sessionId, false);
    return;
  }
  if (entry && focusedSession) {
    refreshFocusedReply(sessionId, true);
    return;
  }
  if (entry) {
    sendMessageDetail(sessionId, nameFor(sessionId), entry.status || 'No reply',
      noReplyMessage(sessionId));
    return;
  }

  if (typeof Pebble.readSource !== 'function') {
    sendMessageDetail(sessionId, nameFor(sessionId), 'No reply', noReplyMessage(sessionId));
    return;
  }

  Pebble.readSource({
    plugin: OPENCODE_UUID,
    category: 'opencode',
    item: 'replies'
  }).then(function (envelope) {
    onReplies(envelope);
    if (state.detailSession !== sessionId || state.detailKind === 'question') return;
    var fresh = replyEntryFor(sessionId);
    if (fresh && fresh.hasText) {
      sendReplyDetail(sessionId);
      if (fresh.isDefault || (state.reply && state.reply.sessionId === sessionId)) {
        refreshFocusedReply(sessionId, false);
      }
    } else if (fresh && (fresh.isDefault ||
               (state.reply && state.reply.sessionId === sessionId))) {
      refreshFocusedReply(sessionId, true);
    } else if (fresh) {
      sendMessageDetail(sessionId, nameFor(sessionId), fresh.status || 'No reply',
        noReplyMessage(sessionId));
    } else {
      sendMessageDetail(sessionId, nameFor(sessionId), 'No reply', noReplyMessage(sessionId));
    }
  }).catch(function (error) {
    state.errors.replies = errorCode(error);
    if (state.detailSession === sessionId && state.detailKind !== 'question') {
      sendMessageDetail(sessionId, nameFor(sessionId), 'Replies unavailable',
        shortErrorText(error));
    }
  });
}

// ---------------------------------------------------------------- detail questions

function detailConditionsMet(when, answers) {
  if (!when) return true;
  if (!Array.isArray(when)) return false;
  for (var i = 0; i < when.length; i++) {
    var condition = when[i];
    if (!condition || typeof condition.key !== 'string') return false;
    if (!Object.prototype.hasOwnProperty.call(answers, condition.key)) return false;
    var value = answers[condition.key];
    if (condition.op === 'eq' ? value !== condition.value : value === condition.value) return false;
  }
  return true;
}

function answerableFieldKind(field) {
  if (!field || typeof field !== 'object' || field.hidden) return null;
  if (field.type === 'external') return null;
  if (field.type === 'boolean') return 'bool';
  if (field.type === 'multiselect') {
    return Array.isArray(field.options) ? 'multi' : null;
  }
  if (field.type === 'string' && Array.isArray(field.options) && field.options.length > 0) {
    return 'single';
  }
  return null;
}

function multiSelected(flow, key) {
  if (!flow.multi[key]) flow.multi[key] = {};
  return flow.multi[key];
}

function selectedValues(flow, key) {
  var selected = multiSelected(flow, key);
  return Object.keys(selected).filter(function (value) { return selected[value]; });
}

function promptChoices(flow) {
  var field = flow.field;
  var choices = [];
  if (!field) return choices;

  if (field.type === 'boolean') {
    choices.push({ label: 'Yes', value: true });
    choices.push({ label: 'No', value: false });
  } else if (field.type === 'multiselect') {
    var selected = multiSelected(flow, field.key);
    (field.options || []).forEach(function (option, index) {
      if (index >= MAX_CHOICES - 1) return;
      choices.push({
        label: typeof option.label === 'string' ? option.label : option.value,
        value: option.value,
        selected: !!selected[option.value]
      });
    });
    choices.push({ label: 'Done', value: '__done__', done: true });
  } else {
    (field.options || []).forEach(function (option) {
      choices.push({
        label: typeof option.label === 'string' ? option.label : option.value,
        value: option.value
      });
    });
  }
  return choices;
}

function sendQuestionPrompt(notice) {
  var flow = state.flow;
  if (!flow || !flow.field) return;
  var field = flow.field;
  var choices = promptChoices(flow);
  flow.choices = choices;

  var fieldTitle = typeof field.title === 'string' && field.title ? field.title : field.key;
  var noticeText = notice || flow.overrideNotice || '';
  flow.overrideNotice = '';

  state.detailKind = 'question';
  enqueue({
    detail_kind: 2,
    session_id: flow.sessionId,
    question_title: String(flow.form.title).slice(0, 80),
    question_field: String(fieldTitle).slice(0, 48),
    question_notice: String(noticeText).slice(0, 32),
    question_count: choices.length,
    question_multi: field.type === 'multiselect' ? 1 : 0
  });
  choices.forEach(function (choice, index) {
    enqueue({
      session_id: flow.sessionId,
      choice_index: index,
      choice_label: String(choice.label).slice(0, 54),
      choice_flags: (choice.selected ? 1 : 0) | (choice.done ? 2 : 0)
    });
  });
  enqueue({ session_id: flow.sessionId, question_end: 1 });
}

function advanceFlow() {
  var flow = state.flow;
  if (!flow) return;

  while (flow.fieldIndex < flow.form.fields.length) {
    var field = flow.form.fields[flow.fieldIndex];
    if (!field || typeof field !== 'object') {
      flow.fieldIndex++;
      continue;
    }
    if (field.hidden) {
      flow.fieldIndex++;
      continue;
    }
    if (!detailConditionsMet(field.when, flow.answers)) {
      flow.fieldIndex++;
      continue;
    }
    var kind = answerableFieldKind(field);
    if (!kind) {
      if (field.required) {
        state.flow = null;
        sendMessageDetail(flow.sessionId, flow.form.title, 'Desktop only',
          'This question needs a free-form answer, so it can only be answered in OpenCode.');
        return;
      }
      flow.fieldIndex++;
      continue;
    }
    flow.field = field;
    sendQuestionPrompt();
    return;
  }

  submitFlow();
}

function submitFlow() {
  var flow = state.flow;
  if (!flow) return;
  state.flow = null;
  state.actionPending = true;
  var sessionId = flow.sessionId;
  var formId = flow.form.formId;
  var answer = flow.answers;

  Promise.resolve().then(function () {
    return Pebble.invokeAction({
      plugin: OPENCODE_UUID,
      action: 'answer_question',
      args: { session_id: sessionId, form_id: formId, answer: answer }
    });
  }).then(function (result) {
    state.actionPending = false;
    clearAttentionFor(sessionId);
    if (state.questions[sessionId]) {
      state.questions[sessionId] = state.questions[sessionId].filter(function (form) {
        return form.formId !== formId;
      });
      if (state.questions[sessionId].length === 0) delete state.questions[sessionId];
    }
    var text = result && typeof result.text === 'string' && result.text ? result.text : 'OpenCode accepted the answer.';
    if (text.length > 220) text = text.slice(0, 220);
    if (state.detailSession === sessionId) {
      enqueue({ result_ok: 1, result_text: text, session_id: sessionId });
    }
    rebuild(true);
  }).catch(function (error) {
    state.actionPending = false;
    if (state.detailSession === sessionId) {
      enqueue({ result_ok: 0, result_text: shortErrorText(error), session_id: sessionId });
    }
    rebuild();
  });
}

function decidePermission(sessionId, requestId, decision) {
  if (state.permissionPending) return;
  state.permissionPending = true;
  Promise.resolve().then(function () {
    return Pebble.invokeAction({
      plugin: OPENCODE_UUID,
      action: 'approve_permission',
      args: {
        session_id: sessionId,
        request_id: requestId,
        decision: decision === 'reject' ? 'reject' : 'once'
      }
    });
  }).then(function (result) {
    state.permissionPending = false;
    if (state.permissions[sessionId]) {
      state.permissions[sessionId] = state.permissions[sessionId].filter(function (entry) {
        return entry.requestId !== requestId;
      });
      if (!state.permissions[sessionId].length) delete state.permissions[sessionId];
    }
    var status = state.chatStatus[sessionId];
    if (status) {
      status.permissionCount = Math.max(0, status.permissionCount - 1);
      recomputeChatStatus(status);
    }
    var text = result && typeof result.text === 'string' && result.text ? result.text :
      (decision === 'reject' ? 'Permission rejected.' : 'Permission approved.');
    if (text.length > 220) text = text.slice(0, 220);
    if (state.detailSession === sessionId) {
      enqueue({ result_ok: 1, result_text: text, session_id: sessionId });
    }
    rebuild(true);
  }).catch(function (error) {
    state.permissionPending = false;
    if (state.detailSession === sessionId) {
      enqueue({ result_ok: 0, result_text: sendErrorText(error), session_id: sessionId });
    }
    rebuild();
  });
}

function markChatRead(sessionId, messageId) {
  if (!sessionId || !messageId) return;
  var entry = replyEntryFor(sessionId);
  if (!entry || entry.messageId !== messageId || !entry.complete) return;
  var key = sessionId + '|' + messageId;
  if (state.markReadInFlight[key] || state.markReadDone[key]) return;
  state.markReadInFlight[key] = true;

  Promise.resolve().then(function () {
    return Pebble.invokeAction({
      plugin: OPENCODE_UUID,
      action: 'mark_chat_read',
      args: { session_id: sessionId, message_id: messageId }
    });
  }).then(function () {
    state.markReadInFlight[key] = false;
    state.markReadDone[key] = true;
    var doneKeys = Object.keys(state.markReadDone);
    if (doneKeys.length > 100) delete state.markReadDone[doneKeys[0]];
    markReplyViewed(sessionId, messageId);
    clearUnviewed(sessionId);
    var fresh = state.chatStatus[sessionId];
    if (fresh && fresh.messageId === messageId) {
      fresh.unread = false;
      recomputeChatStatus(fresh);
    }
    rebuild();
  }).catch(function (error) {
    state.markReadInFlight[key] = false;
    log('mark read failed: ' + errorCode(error));
  });
}

function startQuestion(sessionId) {
  var forms = state.questions[sessionId];
  if (!forms || forms.length === 0) return false;
  var form = forms[0];

  state.detailKind = 'question';
  if (!form.answerable) {
    sendMessageDetail(sessionId, form.title, 'Desktop only',
      'This question has to be answered in OpenCode on the phone or computer.');
    return true;
  }

  state.flow = {
    sessionId: sessionId,
    form: form,
    answers: {},
    fieldIndex: 0,
    field: null,
    multi: {},
    choices: [],
    overrideNotice: ''
  };
  state.lastReplyKey = '';
  advanceFlow();
  return true;
}

function selectChoice(index) {
  var flow = state.flow;
  if (!flow || !flow.field || state.actionPending) {
    if (!state.actionPending) {
      enqueue({ result_ok: 0, result_text: 'This question is no longer available.', session_id: state.detailSession });
    }
    return;
  }
  if (index < 0 || index >= flow.choices.length) {
    enqueue({ result_ok: 0, result_text: 'That choice is no longer available.', session_id: flow.sessionId });
    return;
  }
  var choice = flow.choices[index];
  var field = flow.field;

  if (field.type === 'multiselect') {
    if (choice.done) {
      var selected = selectedValues(flow, field.key);
      if (field.minItems !== undefined && selected.length < field.minItems) {
        flow.overrideNotice = 'Select at least ' + field.minItems;
        sendQuestionPrompt();
        return;
      }
      if (field.maxItems !== undefined && selected.length > field.maxItems) {
        flow.overrideNotice = 'Select at most ' + field.maxItems;
        sendQuestionPrompt();
        return;
      }
      flow.answers[field.key] = selected;
      flow.fieldIndex++;
      flow.field = null;
      advanceFlow();
      return;
    }
    var selectedMap = multiSelected(flow, field.key);
    if (selectedMap[choice.value]) {
      delete selectedMap[choice.value];
    } else {
      if (field.maxItems !== undefined && selectedValues(flow, field.key).length >= field.maxItems) {
        flow.overrideNotice = 'Select at most ' + field.maxItems;
        sendQuestionPrompt();
        return;
      }
      selectedMap[choice.value] = true;
    }
    sendQuestionPrompt();
    return;
  }

  flow.answers[field.key] = choice.value;
  flow.fieldIndex++;
  flow.field = null;
  advanceFlow();
}

// ---------------------------------------------------------------- detail lifecycle

function openDetail(sessionId) {
  state.detailSession = sessionId;
  state.detailKind = '';
  state.lastReplyKey = '';
  state.flow = null;
  state.actionPending = false;
  dropQueuedDetail();
  clearAttentionFor(sessionId);
  rebuild();
}

function continueQuestionOrReply(sessionId) {
  if (state.detailSession !== sessionId) return;
  if (startQuestion(sessionId)) return;

  var status = state.chatStatus[sessionId];
  var active = activeFor(sessionId);
  var questionLikely = (status && (status.questionCount > 0 || status.reason === 'Question')) ||
                       (active && active.status.indexOf('input') !== -1);
  var needsQuestionCheck = questionLikely && typeof Pebble.readSource === 'function';
  if (!needsQuestionCheck) {
    refreshReplyForDetail(sessionId);
    return;
  }

  // Chat status or the active map can say "Waiting for input" before the question source
  // has polled. Read that source once before falling back to the reply view.
  Pebble.readSource({
    plugin: OPENCODE_UUID,
    category: 'opencode',
    item: 'question'
  }).then(function (envelope) {
    onQuestions(envelope);
    if (state.detailSession === sessionId && !state.flow && !startQuestion(sessionId)) {
      refreshReplyForDetail(sessionId);
    }
  }).catch(function (error) {
    state.errors.question = errorCode(error);
    if (state.detailSession === sessionId && !state.flow) {
      refreshReplyForDetail(sessionId);
    }
  });
}

function handleDetailRequest(sessionId) {
  if (!sessionId) return;
  openDetail(sessionId);
  if (state.installed === false) {
    sendMessageDetail(sessionId, nameFor(sessionId), 'Plugin missing',
      'Install and configure the OpenCode Pebble plugin, then open this app again.');
    return;
  }

  var status = state.chatStatus[sessionId];
  var active = activeFor(sessionId);
  var permissionLikely = !!(
    (status && (status.permissionCount > 0 || status.reason === 'Permission')) ||
    (active && active.status.indexOf('approval') !== -1)
  );

  if (permissionLikely && typeof Pebble.readSource === 'function') {
    refreshPermissionsForDetail(sessionId, function (error) {
      if (state.detailSession !== sessionId) return;
      if (error) {
        sendMessageDetail(sessionId, nameFor(sessionId), 'Permission',
          'Could not load the permission request. Open OpenCode on the phone or computer.');
        return;
      }
      if (startPermission(sessionId)) return;
      continueQuestionOrReply(sessionId);
    });
    return;
  }

  continueQuestionOrReply(sessionId);
}

// ---------------------------------------------------------------- subscriptions

function subscribeSource(category, item, key, onData) {
  try {
    state.subscriptions.push(Pebble.subscribeToSource({
      plugin: OPENCODE_UUID,
      category: category,
      item: item,
      onData: function (envelope) {
        state.errors[key] = null;
        onData(envelope);
      },
      onError: function (error) {
        state.errors[key] = errorCode(error);
        log(key + ' error: ' + errorCode(error) + ' ' + (error && error.message ? error.message : ''));
        rebuild();
      }
    }));
  } catch (e) {
    state.errors[key] = errorCode(e);
    log(key + ' subscribe threw: ' + e);
  }
}

function startSubscriptions() {
  if (state.subscribed) return;
  state.subscribed = true;
  subscribeSource('agent', 'configured', 'configured', onConfigured);
  subscribeSource('agent', 'chats', 'chats', onChats);
  subscribeSource('opencode', 'active_session', 'active', onActive);
  subscribeSource('opencode', 'chat_status', 'chatStatus', onChatStatus);
  subscribeSource('opencode', 'question', 'question', onQuestions);
  subscribeSource('opencode', 'reply', 'reply', function (envelope) {
    applyReply(envelope, false);
    rebuild();
  });
}

function ensurePlugin() {
  if (state.installed) return;
  if (pluginInstalled()) {
    state.installed = true;
    startSubscriptions();
    rebuild(true);
  }
}

function sendErrorText(error) {
  var text = error && typeof error.message === 'string' && error.message ? error.message : errorText(error);
  if (text.length > 220) text = text.slice(0, 220);
  return text;
}

function sendPromptResult(ok, text, sessionId) {
  enqueue({
    send_ok: ok ? 1 : 0,
    send_result_text: text,
    session_id: sessionId
  });
}

function beginPromptUpload(payload) {
  var sessionId = payload && payload.session_id ? String(payload.session_id) : '';
  var count = Number(payload && payload.send_prompt_count);
  if (!sessionId || !isFinite(count) || count < 1 || count > 64) {
    sendPromptResult(false, 'Invalid reply upload.', sessionId);
    state.promptUpload = null;
    return;
  }
  state.promptUpload = {
    sessionId: sessionId,
    delivery: Number(payload.send_delivery) === 1 ? 'steer' : 'queue',
    count: count,
    next: 0,
    text: '',
    sending: false
  };
}

function appendPromptChunk(payload) {
  var upload = state.promptUpload;
  if (!upload || upload.sending) return;
  var index = Number(payload.send_prompt_index);
  var chunk = payload.send_prompt_chunk;
  if (!isFinite(index) || typeof chunk !== 'string') return;
  if (index !== upload.next) {
    sendPromptResult(false, 'Reply upload was out of order.', upload.sessionId);
    state.promptUpload = null;
    return;
  }
  upload.text += chunk;
  upload.next += 1;
}

function finishPromptUpload() {
  var upload = state.promptUpload;
  if (!upload) return;
  if (upload.next !== upload.count || !upload.text.trim()) {
    sendPromptResult(false, 'Reply was empty or incomplete.', upload.sessionId);
    state.promptUpload = null;
    return;
  }
  if (upload.text.length > 16000) {
    sendPromptResult(false, 'Reply is too long to send.', upload.sessionId);
    state.promptUpload = null;
    return;
  }
  upload.sending = true;
  var delivery = upload.delivery;
  var sessionId = upload.sessionId;
  state.promptUpload = null;

  Promise.resolve().then(function () {
    return Pebble.invokeAction({
      plugin: OPENCODE_UUID,
      action: 'send_to_agent',
      args: { message: upload.text, chat_id: sessionId, delivery: delivery }
    });
  }).then(function (result) {
    var text = result && typeof result.text === 'string' && result.text ? result.text :
      (delivery === 'steer' ? 'Message steered into OpenCode.' : 'Message queued for OpenCode.');
    if (text.length > 220) text = text.slice(0, 220);
    enqueue({ send_ok: 1, send_result_text: text, session_id: sessionId });
    clearAttentionFor(sessionId);
    var entry = replyEntryFor(sessionId);
    if (entry && entry.messageId && entry.complete) markReplyViewed(sessionId, entry.messageId);
    rebuild(true);
  }).catch(function (error) {
    enqueue({ send_ok: 0, send_result_text: sendErrorText(error), session_id: sessionId });
    rebuild();
  });
}

function handleWatchMessage(payload) {
  if (!payload) return;
  if (payload.req) {
    ensurePlugin();
    sendList(true);
  }
  if (payload.send_prompt_begin) {
    beginPromptUpload(payload);
  }
  if (payload.send_prompt_chunk !== undefined && payload.send_prompt_index !== undefined) {
    appendPromptChunk(payload);
  }
  if (payload.send_prompt_end) {
    finishPromptUpload();
  }
  if (payload.mark_read && payload.session_id && payload.detail_message_id) {
    markChatRead(String(payload.session_id), String(payload.detail_message_id));
  }
  if (payload.permission_decision && payload.session_id && payload.permission_request_id) {
    decidePermission(String(payload.session_id), String(payload.permission_request_id),
      Number(payload.permission_choice) === 1 ? 'reject' : 'once');
  }
  if (payload.detail_close && payload.session_id) {
    if (String(payload.session_id) === state.detailSession) {
      state.detailSession = '';
      state.detailKind = '';
      state.lastReplyKey = '';
      state.flow = null;
      if (state.promptUpload &&
          state.promptUpload.sessionId === String(payload.session_id)) {
        state.promptUpload = null;
      }
    }
  }
  if (payload.detail_req && payload.session_id) {
    handleDetailRequest(String(payload.session_id));
  }
  if (payload.answer_req && payload.session_id && payload.choice_index !== undefined) {
    if (String(payload.session_id) === state.detailSession) {
      selectChoice(Number(payload.choice_index));
    }
  }
}

// ---------------------------------------------------------------- start

Pebble.addEventListener('appmessage', function (event) {
  handleWatchMessage(event && event.payload);
});

Pebble.addEventListener('ready', function () {
  state.installed = pluginInstalled();
  if (state.installed) startSubscriptions();
  rebuild(true);
});
