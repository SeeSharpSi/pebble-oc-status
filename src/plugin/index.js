globalThis.__ocStatusBundled = true;
(function (root) {
  'use strict';

  var STATE_KEY = 'opencode.plugin.state.v1';
  var SNAPSHOT_CACHE_KEY = 'opencode.plugin.cache.v1';
  var LEGACY_CACHE_META_KEY = 'opencode.plugin.cache.meta.v1';
  var REPLY_ALERTS_KEY = 'opencode.plugin.reply-alerts.v1';
  var REPLY_ALERTS_ENABLED_KEY = 'ocstatus.replyAlerts.enabled.v1';
  var REPLY_LAUNCH_KEY = 'ocstatus.replyLaunch.v1';
  var MAX_REPLY_ALERT_SESSIONS = 20;
  var MAX_REPLY_ALERT_IDS = 20;
  var MAX_REPLY_ALERT_BYTES = 16384;
  var MAX_REPLY_NOTIFICATIONS = 5;
  var MAX_LAUNCH_ROUTES = 20;
  var LAUNCH_ROUTE_TTL_MS = 10 * 60 * 1000;
  var MAX_LAUNCH_TOKEN = 2147483647;
  var SNAPSHOT_TTL_MS = 5000;
  var MAX_CACHE_TTL_MS = 60000;
  var MAX_CACHE_ENTRIES = 64;
  var MAX_CACHE_BYTES = 262144;
  var DEFAULT_USERNAME = 'opencode';
  var DEFAULT_TITLE = 'New session';
  var PAGE_LIMIT = 50;
  var MAX_PAGES = 50;
  var DEFAULT_REPLY_COUNT = 10;
  var MAX_REPLY_COUNT = 20;
  var DELIVERY_MODES = ['queue', 'steer'];
  var DEFAULT_DELIVERY = 'queue';
  var MAX_ATTENTION_CHATS = 50;
  var requestCounter = 0;

  function makeError(code, message, httpStatus) {
    var err = new Error(message);
    err.code = code;
    if (httpStatus) err.httpStatus = httpStatus;
    return err;
  }

  function safeError(err) {
    var codes = ['INVALID_REQUEST', 'INVALID_ARGS', 'PERMISSION_DENIED', 'AUTH_REQUIRED', 'RATE_LIMITED', 'PLUGIN_UNAVAILABLE'];
    if (err && codes.indexOf(err.code) !== -1) return { code: err.code, message: err.message };
    return { code: 'PLUGIN_UNAVAILABLE', message: 'Request failed.' };
  }

  function utf8Bytes(value) {
    var encoded;
    try {
      encoded = encodeURIComponent(value).replace(/%([0-9A-F]{2})/g, function (_, hex) {
        return String.fromCharCode(parseInt(hex, 16));
      });
    } catch (_) {
      throw makeError('INVALID_ARGS', 'Text contains invalid Unicode.');
    }
    var bytes = [];
    for (var i = 0; i < encoded.length; i += 1) bytes.push(encoded.charCodeAt(i));
    return bytes;
  }

  function base64(value) {
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var bytes = utf8Bytes(value);
    var out = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var a = bytes[i];
      var hasB = i + 1 < bytes.length;
      var hasC = i + 2 < bytes.length;
      var b = hasB ? bytes[i + 1] : 0;
      var c = hasC ? bytes[i + 2] : 0;
      out += alphabet.charAt(a >> 2) + alphabet.charAt(((a & 3) << 4) | (b >> 4));
      out += hasB ? alphabet.charAt(((b & 15) << 2) | (c >> 6)) : '=';
      out += hasC ? alphabet.charAt(c & 63) : '=';
    }
    return out;
  }

  function base64url(value) {
    return base64(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function cleanURL(value) {
    if (typeof value !== 'string') throw makeError('INVALID_ARGS', 'Enter a valid server URL.');
    var url = value.trim();
    if (!url || /[\u0000-\u0020\u007f\\]/.test(url) || /[?#]/.test(url)) {
      throw makeError('INVALID_ARGS', 'Enter a valid server URL.');
    }
    var match = /^(https?):\/\/([^/]+)(\/.*)?$/i.exec(url);
    if (!match || match[2].indexOf('@') !== -1 || /%/.test(match[2])) {
      throw makeError('INVALID_ARGS', 'Server URL must use HTTP or HTTPS without credentials.');
    }
    var authority = match[2];
    var authorityMatch = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(authority);
    if (!authorityMatch) throw makeError('INVALID_ARGS', 'Enter a valid server URL.');
    if (authorityMatch[2] && (+authorityMatch[2] < 1 || +authorityMatch[2] > 65535)) {
      throw makeError('INVALID_ARGS', 'Enter a valid server URL.');
    }
    var host = authorityMatch[1];
    if (host.charAt(0) !== '[') {
      if (host.length > 253 || host.charAt(0) === '.' || host.charAt(host.length - 1) === '.') {
        throw makeError('INVALID_ARGS', 'Enter a valid server URL.');
      }
      var labels = host.split('.');
      for (var i = 0; i < labels.length; i += 1) {
        if (!labels[i] || labels[i].length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(labels[i])) {
          throw makeError('INVALID_ARGS', 'Enter a valid server URL.');
        }
      }
    }
    var path = match[3] || '';
    var decodedPath;
    try { decodedPath = decodeURIComponent(path); } catch (_) { throw makeError('INVALID_ARGS', 'Server URL path is invalid.'); }
    if (/[\\\u0000-\u001f\u007f]/.test(decodedPath) || /(^|\/)\.\.?($|\/)/.test(decodedPath)) {
      throw makeError('INVALID_ARGS', 'Server URL path is invalid.');
    }
    return url.replace(/\/+$/, '');
  }

  // OpenCode V2 server route uses normalized server URL as the server key.
  function sessionURL(server, id) {
    return server + '/server/' + base64url(server) + '/session/' + encodeURIComponent(id);
  }

  function emptyState() {
    return {
      url: '', username: DEFAULT_USERNAME, password: '', version: '', mode: 'default_chat',
      directory: '', selected: null, lastSessionID: null, nicknames: {}, reply_count: DEFAULT_REPLY_COUNT,
      default_delivery: DEFAULT_DELIVERY, auth_method: '', last_seen: {}, cache_generation: '',
      reply_alerts: false
    };
  }

  function validDelivery(value) {
    return DELIVERY_MODES.indexOf(value) !== -1;
  }

  function createService(options) {
    options = options || {};
    var storage = options.storage;
    var fetcher = options.fetch;
    var now = options.now || Date.now;
    var random = options.random;
    var bundled = options.bundled !== undefined ? !!options.bundled : root.__ocStatusBundled === true;
    var cacheWriteChain = Promise.resolve();
    var replyAlertChain = Promise.resolve();
    var sourceActiveMapInFlight = Object.create(null);
    var legacyCacheMetaInFlight = Object.create(null);
    var snapshotCacheContexts = new WeakMap();
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function' ||
        typeof storage.removeItem !== 'function' || typeof fetcher !== 'function') {
      throw new TypeError('storage and fetch are required');
    }

    async function load() {
      var raw;
      try { raw = await storage.getItem(STATE_KEY); } catch (_) { throw makeError('PLUGIN_UNAVAILABLE', 'Secure storage is unavailable.'); }
      if (!raw) return emptyState();
      try {
        var stored = typeof raw === 'string' ? JSON.parse(raw) : raw;
        var state = emptyState();
        Object.keys(state).forEach(function (key) {
          if (stored && stored[key] !== undefined) state[key] = stored[key];
        });
        if (!state.nicknames || typeof state.nicknames !== 'object' || Array.isArray(state.nicknames)) state.nicknames = {};
        if (!state.last_seen || typeof state.last_seen !== 'object' || Array.isArray(state.last_seen)) state.last_seen = {};
        if (!Number.isInteger(state.reply_count) || state.reply_count < 1 || state.reply_count > MAX_REPLY_COUNT) {
          state.reply_count = DEFAULT_REPLY_COUNT;
        }
        if (!validDelivery(state.default_delivery)) state.default_delivery = DEFAULT_DELIVERY;
        if (typeof state.reply_alerts !== 'boolean') state.reply_alerts = false;
        if (!state.password) state.auth_method = '';
        else if (state.auth_method !== 'pair') state.auth_method = 'password';
        return state;
      } catch (_) { return emptyState(); }
    }

    async function save(state) {
      if (state.url && state.password && /^2\./.test(state.version) && !state.cache_generation) {
        state.cache_generation = newCacheGeneration();
      }
      try { await storage.setItem(STATE_KEY, JSON.stringify(state)); }
      catch (_) { throw makeError('PLUGIN_UNAVAILABLE', 'Secure storage is unavailable.'); }
      if (state.cache_generation) { try { await storage.removeItem(LEGACY_CACHE_META_KEY); } catch (_) {} }
    }

    function newCacheGeneration() {
      requestCounter += 1;
      return String(now()) + '-' + String(random ? random() : Math.random().toString(36).slice(2)) + '-' + requestCounter;
    }

    function clearSnapshotCacheContext(state) {
      if (state && typeof state === 'object') snapshotCacheContexts.delete(state);
    }

    async function invalidateSnapshotCache(state) {
      state.cache_generation = newCacheGeneration();
      clearSnapshotCacheContext(state);
      try { await storage.removeItem(SNAPSHOT_CACHE_KEY); } catch (_) {}
      try { await storage.removeItem(LEGACY_CACHE_META_KEY); } catch (_) {}
    }

    async function invalidateAfterMutation(state) {
      clearSnapshotCacheContext(state);
      try {
        var fresh = await load();
        if (fresh.url === state.url && fresh.username === state.username && fresh.password === state.password && fresh.version === state.version) {
          await invalidateSnapshotCache(fresh);
          await save(fresh);
        } else {
          clearSnapshotCacheContext(fresh);
          await storage.removeItem(SNAPSHOT_CACHE_KEY);
        }
      } catch (_) { try { await storage.removeItem(SNAPSHOT_CACHE_KEY); } catch (_) {} }
    }

    async function invalidateBeforeMutation(state) {
      clearSnapshotCacheContext(state);
      var fresh = await load();
      if (fresh.url !== state.url || fresh.username !== state.username || fresh.password !== state.password || fresh.version !== state.version) {
        clearSnapshotCacheContext(fresh);
        throw makeError('PLUGIN_UNAVAILABLE', 'Connection changed before mutation. Refresh and retry.');
      }
      fresh.cache_generation = newCacheGeneration();
      clearSnapshotCacheContext(fresh);
      await save(fresh);
      try { await storage.removeItem(SNAPSHOT_CACHE_KEY); } catch (_) {}
    }

    function legacyMetaValid(meta, state) {
      return isPlainObject(meta) && Object.keys(meta).sort().join(',') === 'generation,url,username,version' &&
        typeof meta.generation === 'string' && meta.generation.length > 0 && meta.generation.length <= 128 &&
        meta.url === state.url && meta.username === state.username && meta.version === state.version;
    }

    function parseLegacyMeta(raw) {
      if (raw === null || raw === undefined) return null;
      try {
        var serialized = typeof raw === 'string' ? raw : JSON.stringify(raw);
        if (typeof serialized !== 'string' || serializedByteLength(serialized) > 2048) return null;
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (_) { return null; }
    }

    async function persistedLegacyIdentityMatches(state) {
      try {
        var raw = await storage.getItem(STATE_KEY);
        var saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return isPlainObject(saved) && saved.url === state.url && saved.username === state.username &&
          saved.password === state.password && saved.version === state.version && !saved.cache_generation;
      } catch (_) { return false; }
    }

    async function removeLegacyMetaIfGeneration(generation) {
      try {
        var raw = await storage.getItem(LEGACY_CACHE_META_KEY);
        var meta = parseLegacyMeta(raw);
        if (isPlainObject(meta) && meta.generation === generation) await storage.removeItem(LEGACY_CACHE_META_KEY);
      } catch (_) {}
    }

    async function sourceCacheState(state) {
      if (state.cache_generation || !state.url || !state.username || !state.password || !/^2\./.test(state.version) ||
          state.url.length > 1500 || state.username.length > 200 || state.version.length > 64) return state;
      var identity = state.url + '\n' + state.username + '\n' + state.version;
      if (legacyCacheMetaInFlight[identity]) return Object.assign({}, await legacyCacheMetaInFlight[identity]);
      var pending = (async function () {
        try {
          var rawMeta = await storage.getItem(LEGACY_CACHE_META_KEY);
          var meta = parseLegacyMeta(rawMeta);
          if (!legacyMetaValid(meta, state)) {
            if (!await persistedLegacyIdentityMatches(state)) return state;
            meta = { url: state.url, username: state.username, version: state.version, generation: newCacheGeneration() };
            var serialized = JSON.stringify(meta);
            if (serializedByteLength(serialized) > 2048) return state;
            await storage.setItem(LEGACY_CACHE_META_KEY, serialized);
            if (!await persistedLegacyIdentityMatches(state)) {
              await removeLegacyMetaIfGeneration(meta.generation);
              return state;
            }
          } else if (!await persistedLegacyIdentityMatches(state)) {
            await removeLegacyMetaIfGeneration(meta.generation);
            return state;
          }
          return Object.assign({}, state, { cache_generation: meta.generation });
        } catch (_) { return state; }
      })();
      legacyCacheMetaInFlight[identity] = pending;
      try { return Object.assign({}, await pending); }
      finally { if (legacyCacheMetaInFlight[identity] === pending) delete legacyCacheMetaInFlight[identity]; }
    }

    async function readCacheEnvelope(state) {
      if (!state.cache_generation) return null;
      var raw;
      try { raw = await storage.getItem(SNAPSHOT_CACHE_KEY); }
      catch (_) { return undefined; }
      try {
        if (raw === null || raw === undefined) return null;
        var serialized = typeof raw === 'string' ? raw : JSON.stringify(raw);
        if (typeof serialized !== 'string' || serializedByteLength(serialized) > MAX_CACHE_BYTES) return null;
        var cache = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!isPlainObject(cache) || Object.keys(cache).sort().join(',') !== 'entries,generation,url,username,version' ||
            cache.version !== 1 || typeof cache.generation !== 'string' || cache.generation.length > 128 || cache.generation !== state.cache_generation ||
            cache.url !== state.url || cache.username !== state.username || !isPlainObject(cache.entries) || Object.keys(cache.entries).length > MAX_CACHE_ENTRIES) return null;
        var current = now();
        var keys = Object.keys(cache.entries);
        for (var i = 0; i < keys.length; i += 1) {
          var entry = cache.entries[keys[i]];
          if (!keys[i] || keys[i].length > 220 || !isPlainObject(entry) ||
              Object.keys(entry).sort().join(',') !== 'expires,value,written' ||
              typeof entry.expires !== 'number' || !Number.isFinite(entry.expires) ||
              typeof entry.written !== 'number' || !Number.isFinite(entry.written) ||
              entry.written > current || entry.expires <= entry.written || entry.expires - entry.written > MAX_CACHE_TTL_MS ||
              entry.expires > current + MAX_CACHE_TTL_MS || !isPlainObject(entry.value)) return null;
          if (entry.expires <= current) delete cache.entries[keys[i]];
        }
        return cache;
      } catch (_) { return null; }
    }

    function serializedByteLength(value) {
      var bytes = 0;
      for (var i = 0; i < value.length; i += 1) {
        var code = value.charCodeAt(i);
        if (code < 0x80) bytes += 1;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) {
          bytes += 4;
          i += 1;
        } else bytes += 3;
        if (bytes > MAX_CACHE_BYTES) return bytes;
      }
      return bytes;
    }

    function memoizedCacheEnvelope(state) {
      var context = snapshotCacheContexts.get(state);
      if (context) {
        if (context.loaded) return Promise.resolve(context.envelope);
        if (context.pending) return context.pending;
      }
      var pending = readCacheEnvelope(state).then(function (envelope) {
        var current = snapshotCacheContexts.get(state);
        if (current && current.pending === pending) {
          if (envelope !== undefined) snapshotCacheContexts.set(state, { loaded: true, envelope: envelope });
          else snapshotCacheContexts.delete(state);
        }
        return envelope === undefined ? null : envelope;
      }, function () {
        var current = snapshotCacheContexts.get(state);
        if (current && current.pending === pending) snapshotCacheContexts.delete(state);
        return null;
      });
      snapshotCacheContexts.set(state, { loaded: false, pending: pending });
      return pending;
    }

    async function readSnapshotCache(state, name) {
      if (!await persistedGenerationMatches(state)) {
        clearSnapshotCacheContext(state);
        return null;
      }
      var cache = await memoizedCacheEnvelope(state);
      var entry = cache && cache.entries[name];
      return entry && entry.expires > now() ? entry.value : null;
    }

    async function persistedGenerationMatches(state) {
      try {
        var raw = await storage.getItem(STATE_KEY);
        var saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!isPlainObject(saved) || saved.url !== state.url || saved.username !== state.username ||
            saved.password !== state.password || saved.version !== state.version) return false;
        if (saved.cache_generation) return saved.cache_generation === state.cache_generation;
        if (!state.cache_generation) return false;
        var rawMeta = await storage.getItem(LEGACY_CACHE_META_KEY);
        var meta = parseLegacyMeta(rawMeta);
        return legacyMetaValid(meta, state) && meta.generation === state.cache_generation;
      } catch (_) { return false; }
    }

    function writeSnapshotCache(state, name, value, ttl) {
      if (!state.cache_generation) return Promise.resolve();
      var task = cacheWriteChain.then(async function () {
        try {
          if (!await persistedGenerationMatches(state)) {
            clearSnapshotCacheContext(state);
            return;
          }
          var cached = await readCacheEnvelope(state);
          if (cached === undefined) return;
          var cache = {
            version: 1, generation: state.cache_generation, url: state.url, username: state.username,
            entries: cached ? Object.assign({}, cached.entries) : {}
          };
          var current = now();
          Object.keys(cache.entries).forEach(function (key) {
            if (cache.entries[key].expires <= current) delete cache.entries[key];
          });
          cache.entries[name] = { expires: current + Math.min(ttl || SNAPSHOT_TTL_MS, MAX_CACHE_TTL_MS), written: current, value: value };
          var serialize = function () { return JSON.stringify(cache); };
          var serialized = serialize();
          while ((Object.keys(cache.entries).length > MAX_CACHE_ENTRIES || serializedByteLength(serialized) > MAX_CACHE_BYTES) && Object.keys(cache.entries).length > 1) {
            var oldest = Object.keys(cache.entries).filter(function (key) { return key !== name; }).sort(function (a, b) {
              return cache.entries[a].written - cache.entries[b].written;
            })[0];
            if (!oldest) break;
            delete cache.entries[oldest];
            serialized = serialize();
          }
          if (serializedByteLength(serialized) > MAX_CACHE_BYTES) return;
          if (!await persistedGenerationMatches(state)) {
            clearSnapshotCacheContext(state);
            return;
          }
          await storage.setItem(SNAPSHOT_CACHE_KEY, serialized);
          if (!await persistedGenerationMatches(state)) {
            clearSnapshotCacheContext(state);
            var after = await readCacheEnvelope(state);
            if (after && after.generation === state.cache_generation) await storage.removeItem(SNAPSHOT_CACHE_KEY);
            return;
          }
          snapshotCacheContexts.set(state, { loaded: true, envelope: cache });
        } catch (_) { clearSnapshotCacheContext(state); }
      });
      cacheWriteChain = task.catch(function () {});
      return task;
    }

    function sourceRefreshes() {
      return ['agent/chats', 'opencode/active_session', 'opencode/activity', 'opencode/reply', 'opencode/replies', 'opencode/chat_status', 'opencode/permission', 'opencode/question', 'opencode/job', 'opencode/execution', 'opencode/queue', 'opencode/shell', 'opencode/command'];
    }

    var permissionRefreshes = ['opencode/permission', 'opencode/chat_status', 'opencode/active_session', 'opencode/activity', 'opencode/reply', 'opencode/replies', 'opencode/execution'];
    var questionRefreshes = ['opencode/question', 'opencode/chat_status', 'opencode/active_session', 'opencode/activity', 'opencode/reply', 'opencode/replies', 'opencode/execution'];
    var interruptRefreshes = ['opencode/active_session', 'opencode/activity', 'opencode/reply', 'opencode/replies', 'opencode/chat_status', 'opencode/permission', 'opencode/question', 'opencode/job', 'opencode/execution', 'opencode/queue', 'opencode/shell'];

    function refresh(sources) {
      if (root.Pebble && typeof root.Pebble.refreshSources === 'function') {
        try { root.Pebble.refreshSources(sources || ['agent/chats', 'agent/configured', 'opencode/active_session', 'opencode/activity', 'opencode/reply', 'opencode/replies', 'opencode/chat_status', 'opencode/permission', 'opencode/question', 'opencode/job', 'opencode/usage', 'opencode/execution', 'opencode/queue', 'opencode/shell', 'opencode/command']); } catch (_) {}
      }
    }

    function configured(state) {
      return !!(state.url && state.username && state.password && /^2\./.test(state.version) &&
        ((state.mode === 'default_chat' && state.selected) || (state.mode === 'new_chat' && state.directory)));
    }

    function status(state) {
      return {
        connected: !!(state.url && state.password && state.version),
        configured: configured(state), url: state.url || '', username: state.username || DEFAULT_USERNAME,
        version: state.version || '', mode: state.mode || 'default_chat', directory: state.directory || '',
        selected: state.selected || null, nicknames: state.nicknames || {},
        reply_count: state.reply_count, default_delivery: state.default_delivery || DEFAULT_DELIVERY,
        auth_method: state.auth_method || '', reply_alerts: !!state.reply_alerts,
        notifications_supported: notificationsSupported()
      };
    }

    function requireConnection(state) {
      if (!state.url || !state.username || !state.password || !/^2\./.test(state.version)) {
        throw makeError('AUTH_REQUIRED', 'Connect to an OpenCode V2 server first.');
      }
    }

    function notificationFunction() {
      if (typeof options.showNotification === 'function') return options.showNotification;
      if (root.Pebble && typeof root.Pebble.showNotification === 'function') {
        return function (notification) { return root.Pebble.showNotification(notification); };
      }
      return null;
    }

    function notificationsSupported() {
      return typeof notificationFunction() === 'function';
    }

    function appStorage() {
      var candidate;
      try { candidate = options.localStorage !== undefined ? options.localStorage : root.localStorage; }
      catch (_) { return null; }
      if (!candidate || typeof candidate.getItem !== 'function' || typeof candidate.setItem !== 'function' ||
          typeof candidate.removeItem !== 'function') return null;
      return candidate;
    }

    function syncReplyAlertsEnabled(enabled) {
      var local = appStorage();
      if (!local) return;
      try {
        if (enabled) local.setItem(REPLY_ALERTS_ENABLED_KEY, '1');
        else local.removeItem(REPLY_ALERTS_ENABLED_KEY);
      } catch (_) {}
    }

    function clearReplyLaunchRoutes() {
      var local = appStorage();
      if (!local) return;
      try { local.removeItem(REPLY_LAUNCH_KEY); } catch (_) {}
    }

    async function clearReplyAlertState() {
      clearReplyLaunchRoutes();
      try { await storage.removeItem(REPLY_ALERTS_KEY); } catch (_) {}
    }

    function accountScope(state) {
      var identity = String(state.url || '') + '\n' + String(state.username || '') + '\n' + String(state.password || '');
      var hash = 2166136261;
      for (var i = 0; i < identity.length; i += 1) {
        hash ^= identity.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return String(state.url || '') + '\n' + String(state.username || '') + '\n' + (hash >>> 0).toString(36);
    }

    function validLaunchToken(key) {
      if (typeof key !== 'string' || !/^[1-9][0-9]{0,9}$/.test(key)) return false;
      var value = Number(key);
      return value <= MAX_LAUNCH_TOKEN && value === Math.floor(value);
    }

    function readLaunchRoutes(local) {
      var raw;
      try { raw = local.getItem(REPLY_LAUNCH_KEY); } catch (_) { return null; }
      if (raw === null || raw === undefined || raw === '') return {};
      try {
        var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!isPlainObject(parsed)) return {};
        var keys = Object.keys(parsed);
        if (keys.length > MAX_LAUNCH_ROUTES * 2) return {};
        var current = now();
        var routes = {};
        keys.forEach(function (key) {
          var route = parsed[key];
          if (!validLaunchToken(key) || !isPlainObject(route) ||
              Object.keys(route).sort().join(',') !== 'expiresAt,sessionId' ||
              !sessionID(route.sessionId) || typeof route.expiresAt !== 'number' ||
              !Number.isFinite(route.expiresAt) || route.expiresAt <= current) return;
          routes[key] = { sessionId: route.sessionId, expiresAt: route.expiresAt };
        });
        return routes;
      } catch (_) { return {}; }
    }

    function writeLaunchRoutes(local, routes) {
      var keys = Object.keys(routes).sort(function (a, b) { return routes[b].expiresAt - routes[a].expiresAt; });
      for (var i = MAX_LAUNCH_ROUTES; i < keys.length; i += 1) delete routes[keys[i]];
      try { local.setItem(REPLY_LAUNCH_KEY, JSON.stringify(routes)); return true; }
      catch (_) { return false; }
    }

    function randomLaunchToken() {
      var value;
      try {
        if (typeof random === 'function') {
          var candidate = random();
          if (typeof candidate === 'number' && Number.isFinite(candidate)) value = candidate;
        }
      } catch (_) {}
      if (typeof value === 'number') {
        var fromRandom = Math.floor(Math.abs(value)) % MAX_LAUNCH_TOKEN;
        return fromRandom + 1;
      }
      try {
        if (root.crypto && typeof root.crypto.getRandomValues === 'function') {
          var bytes = new Uint8Array(4);
          root.crypto.getRandomValues(bytes);
          var numeric = ((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3];
          return (numeric % MAX_LAUNCH_TOKEN) + 1;
        }
      } catch (_) {}
      return Math.floor(Math.random() * MAX_LAUNCH_TOKEN) + 1;
    }

    function createReplyRoute(sessionId) {
      if (!bundled || !sessionID(sessionId)) return null;
      var local = appStorage();
      if (!local) return null;
      var routes = readLaunchRoutes(local);
      if (routes === null) return null;
      var base = randomLaunchToken();
      var token = null;
      for (var attempt = 0; attempt < 8; attempt += 1) {
        var candidate = ((base - 1 + attempt) % MAX_LAUNCH_TOKEN) + 1;
        if (!Object.prototype.hasOwnProperty.call(routes, String(candidate))) { token = candidate; break; }
      }
      if (token === null) return null;
      routes[String(token)] = { sessionId: sessionId, expiresAt: now() + LAUNCH_ROUTE_TTL_MS };
      if (!writeLaunchRoutes(local, routes)) return null;
      return token;
    }

    function sanitizeReplyAlertBook(raw, scope) {
      if (raw === null || raw === undefined || raw === '') return null;
      try {
        var serialized = typeof raw === 'string' ? raw : JSON.stringify(raw);
        if (typeof serialized !== 'string' || serializedByteLength(serialized) > MAX_REPLY_ALERT_BYTES) return null;
        var book = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!isPlainObject(book) || Object.keys(book).sort().join(',') !== 'scope,seededAt,sessions,version' ||
            book.version !== 1 || typeof book.scope !== 'string' || book.scope !== scope ||
            typeof book.seededAt !== 'number' || !Number.isFinite(book.seededAt) || book.seededAt < 0 ||
            !isPlainObject(book.sessions) || Object.keys(book.sessions).length > MAX_REPLY_ALERT_SESSIONS) return null;
        var sessions = {};
        var keys = Object.keys(book.sessions);
        for (var i = 0; i < keys.length; i += 1) {
          var id = keys[i];
          var record = book.sessions[id];
          if (!sessionID(id) || !isPlainObject(record) || Object.keys(record).sort().join(',') !== 'completed,ids' ||
              typeof record.completed !== 'number' || !Number.isFinite(record.completed) || record.completed < 0 ||
              !Array.isArray(record.ids) || record.ids.length > MAX_REPLY_ALERT_IDS ||
              record.ids.some(function (value, index) {
                return !/^msg_[A-Za-z0-9_-]{1,196}$/.test(value) || record.ids.indexOf(value) !== index;
              })) return null;
          sessions[id] = { completed: record.completed, ids: record.ids.slice() };
        }
        return { version: 1, scope: scope, seededAt: book.seededAt, sessions: sessions };
      } catch (_) { return null; }
    }

    async function loadReplyAlertBook(scope) {
      var raw;
      try { raw = await storage.getItem(REPLY_ALERTS_KEY); } catch (_) { return null; }
      return sanitizeReplyAlertBook(raw, scope);
    }

    async function saveReplyAlertBook(book) {
      var keys = Object.keys(book.sessions).sort(function (a, b) {
        return book.sessions[b].completed - book.sessions[a].completed;
      });
      for (var i = MAX_REPLY_ALERT_SESSIONS; i < keys.length; i += 1) delete book.sessions[keys[i]];
      Object.keys(book.sessions).forEach(function (id) {
        var ids = book.sessions[id].ids;
        if (ids.length > MAX_REPLY_ALERT_IDS) book.sessions[id].ids = ids.slice(ids.length - MAX_REPLY_ALERT_IDS);
      });
      var serialized = JSON.stringify(book);
      if (serializedByteLength(serialized) > MAX_REPLY_ALERT_BYTES) return false;
      try { await storage.setItem(REPLY_ALERTS_KEY, serialized); return true; }
      catch (_) { return false; }
    }

    function recordCompletedReply(book, completed) {
      if (!book.sessions[completed.sessionId]) book.sessions[completed.sessionId] = { completed: 0, ids: [] };
      var record = book.sessions[completed.sessionId];
      if (record.ids.indexOf(completed.id) === -1) record.ids.push(completed.id);
      if (record.ids.length > MAX_REPLY_ALERT_IDS) record.ids = record.ids.slice(record.ids.length - MAX_REPLY_ALERT_IDS);
      if (completed.completed > record.completed) record.completed = completed.completed;
    }

    function completedReplyAlert(entry) {
      var reply = entry && entry.reply;
      var message = reply && reply.message;
      if (!message || typeof message.id !== 'string' || !/^msg_[A-Za-z0-9_-]{1,196}$/.test(message.id) ||
          !message.time || typeof message.time.completed !== 'number' || !Number.isFinite(message.time.completed) ||
          message.time.completed < 0 || typeof reply.text !== 'string' || !reply.text.trim()) return null;
      return {
        sessionId: entry.sessionId, id: message.id, completed: message.time.completed,
        failed: !!(message.error || message.finish === 'error')
      };
    }

    async function processReplyAlertsNow(state, entries) {
      try {
        if (!state.reply_alerts || !notificationsSupported()) return;
        var fresh = await load();
        if (!fresh.reply_alerts || !notificationsSupported() ||
            fresh.url !== state.url || fresh.username !== state.username ||
            fresh.password !== state.password || fresh.version !== state.version) return;
        var completed = [];
        entries.forEach(function (entry) {
          var alert = completedReplyAlert(entry);
          if (alert) completed.push(alert);
        });
        var scope = accountScope(fresh);
        var book = await loadReplyAlertBook(scope);
        if (!book) {
          book = { version: 1, scope: scope, seededAt: now(), sessions: {} };
          completed.forEach(function (alert) { recordCompletedReply(book, alert); });
          await saveReplyAlertBook(book);
          return;
        }
        var candidates = [];
        completed.forEach(function (alert) {
          var known = Object.prototype.hasOwnProperty.call(book.sessions, alert.sessionId);
          var record = known ? book.sessions[alert.sessionId] : { completed: 0, ids: [] };
          var existing = record.ids.indexOf(alert.id) !== -1;
          var stale = alert.completed < book.seededAt || (known && alert.completed < record.completed);
          if (!known) book.sessions[alert.sessionId] = record;
          recordCompletedReply(book, alert);
          if (!existing && !stale && !alert.failed) candidates.push(alert);
        });
        candidates.sort(function (a, b) {
          return a.completed - b.completed || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 :
            a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        });
        var seen = Object.create(null);
        var unique = candidates.filter(function (alert) {
          var key = alert.sessionId + '\n' + alert.id;
          if (seen[key]) return false;
          seen[key] = true;
          return true;
        }).slice(0, MAX_REPLY_NOTIFICATIONS);
        if (!await saveReplyAlertBook(book)) return;
        for (var i = 0; i < unique.length; i += 1) {
          var current = await load();
          if (!current.reply_alerts || !notificationsSupported() ||
              current.url !== state.url || current.username !== state.username ||
              current.password !== state.password || current.version !== state.version) return;
          var token = createReplyRoute(unique[i].sessionId);
          var notification = {
            layout: {
              type: 'genericNotification', title: 'OpenCode reply ready',
              tinyIcon: 'system://images/NOTIFICATION_GENERIC'
            },
            actions: token === null ? [] : [{ title: 'Open reply', type: 'openWatchApp', launchCode: token }]
          };
          try {
            var pending = notificationFunction()(notification);
            if (pending && typeof pending.catch === 'function') await pending.catch(function () {});
          } catch (_) {}
        }
      } catch (_) {}
    }

    function processReplyAlerts(state, entries) {
      var task = replyAlertChain.then(function () { return processReplyAlertsNow(state, entries); });
      replyAlertChain = task.catch(function () {});
      return task;
    }

    async function request(state, path, method, body, expectedStatus) {
      if (!state.url || !state.username || !state.password) {
        throw makeError('AUTH_REQUIRED', 'Connect to an OpenCode V2 server first.');
      }
      var response;
      var init = { method: method || 'GET', headers: { Accept: 'application/json' }, redirect: 'error' };
      init.headers.Authorization = 'Basic ' + base64(state.username + ':' + state.password);
      if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      try { response = await fetcher(state.url + path, init); }
      catch (fetchError) {
        if (fetchError && fetchError.name === 'NotAllowedError') throw makeError('PERMISSION_DENIED', 'OpenCode access is not permitted.');
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode request failed.');
      }
      if (!response || typeof response.status !== 'number') throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned an invalid response.');
      if (response.status < 200 || response.status >= 300) {
        var code = response.status === 401 ? 'AUTH_REQUIRED' : response.status === 403 ? 'PERMISSION_DENIED' :
          response.status === 429 ? 'RATE_LIMITED' : 'PLUGIN_UNAVAILABLE';
        var message = response.status === 409 ? 'OpenCode reported a conflict; request was not retried.' :
          (response.status >= 500 ? 'OpenCode is unavailable.' : 'OpenCode request was rejected.');
        throw makeError(code, message, response.status);
      }
      if (expectedStatus !== undefined && response.status !== expectedStatus) {
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned an unexpected success status.');
      }
      if (response.status === 204) return null;
      try { return await response.json(); }
      catch (_) { throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid JSON.'); }
    }

    function api(state, path, method, body, expectedStatus) { return request(state, '/api' + path, method, body, expectedStatus); }

    async function redeemPairingLink(value) {
      var link;
      try { link = cleanURL(value); }
      catch (_) { throw makeError('INVALID_ARGS', 'Enter an OpenCode pairing link.'); }
      var match = /^(https?:\/\/[^/]+)\/auth\/connect\/[^/]+$/.exec(link);
      if (!match) throw makeError('INVALID_ARGS', 'Enter an OpenCode pairing link.');
      var response;
      try {
        response = await fetcher(link, {
          method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error'
        });
      } catch (fetchError) {
        if (fetchError && fetchError.name === 'NotAllowedError') throw makeError('PERMISSION_DENIED', 'OpenCode access is not permitted.');
        throw makeError('PLUGIN_UNAVAILABLE', 'Pairing request failed.');
      }
      if (!response || typeof response.status !== 'number') throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned an invalid pairing response.');
      if (response.status === 400 || response.status === 401 || response.status === 404 || response.status === 410) {
        throw makeError('INVALID_ARGS', 'Pairing link is invalid or expired. Run opencode pair again.');
      }
      if (response.status === 403) throw makeError('PERMISSION_DENIED', 'OpenCode access is not permitted.');
      if (response.status === 429) throw makeError('RATE_LIMITED', 'OpenCode rate limit reached.');
      if (response.status < 200 || response.status >= 300) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode pairing request was rejected.');
      var body;
      try { body = await response.json(); }
      catch (_) { throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned an invalid pairing response.'); }
      if (!body || typeof body.token !== 'string' || !body.token || body.token.length > 4096) {
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned an invalid pairing response.');
      }
      return { origin: match[1], token: body.token };
    }

    function sessionID(id) { return typeof id === 'string' && /^ses[A-Za-z0-9_-]{1,160}$/.test(id); }
    function sessionPath(id) { return '/session/' + encodeURIComponent(id); }
    function titleOf(session) { return typeof session.title === 'string' && session.title ? session.title : 'Untitled session'; }
    function archived(session) { return !!(session.time && session.time.archived); }

    function validSession(session) {
      if (!session || typeof session !== 'object' || !sessionID(session.id) ||
          (session.title !== undefined && typeof session.title !== 'string') ||
          !session.location || typeof session.location.directory !== 'string' ||
          !session.time || typeof session.time !== 'object') {
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid session data.');
      }
      return session;
    }

    async function getSession(state, id) {
      var response = await api(state, sessionPath(id));
      var session = response && response.data;
      session = validSession(session);
      if (session.id !== id) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned a different session.');
      return session;
    }

    function validateCursor(cursor) {
      if (cursor === undefined || cursor === null) return null;
      if (typeof cursor !== 'string' || cursor.length > 4096) throw makeError('INVALID_ARGS', 'Invalid session cursor.');
      return cursor;
    }

    async function sessionsPage(state, cursor, bypassCache) {
      var params = 'limit=' + PAGE_LIMIT + '&parentID=null&archived=false';
      if (cursor !== null) params += '&cursor=' + encodeURIComponent(cursor);
      else params += '&order=desc';
      var cacheName = 'sessions:' + (cursor === null ? 'first' : cursor);
      var cached = bypassCache ? null : await readSnapshotCache(state, cacheName);
      var response = cached;
      if (response) {
        try {
          if (!Array.isArray(response.data) || !response.cursor || typeof response.cursor !== 'object') throw new Error('invalid cache');
          response.data.forEach(function (item) { validSession(item); });
        } catch (_) { response = null; cached = null; }
      }
      if (!response) response = await api(state, '/session?' + params);
      if (!response || !Array.isArray(response.data) || !response.cursor || typeof response.cursor !== 'object' ||
          (response.cursor.next !== undefined && response.cursor.next !== null && typeof response.cursor.next !== 'string')) {
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid session data.');
      }
      response.data.forEach(function (item) { validSession(item); });
      if (response.cursor.next === undefined) response.cursor.next = null;
      if (!cached) {
        await writeSnapshotCache(state, cacheName, {
          data: response.data.map(safeSessionSnapshot), cursor: { next: response.cursor.next }
        });
      }
      return response;
    }

    function isRootUnarchived(session) {
      return !archived(session) && !(session.parentID || session.parentId || session.parent_id);
    }

    function validateListSession(session) {
      validSession(session);
      if (!isRootUnarchived(session)) return false;
      return true;
    }

    async function allSessions(state) {
      var all = [];
      var ids = Object.create(null);
      var seenCursors = Object.create(null);
      var cursor = null;
      for (var page = 0; page < MAX_PAGES; page += 1) {
        var response = await sessionsPage(state, cursor, true);
        response.data.forEach(function (item) {
          if (!validateListSession(item)) return;
          if (!ids[item.id]) { ids[item.id] = true; all.push(item); }
        });
        var next = response.cursor.next;
        if (next === null || next === '') return all;
        if (typeof next !== 'string' || next.length > 4096 || seenCursors[next]) {
          throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid pagination data.');
        }
        if (page === MAX_PAGES - 1) throw makeError('PLUGIN_UNAVAILABLE', 'Too many sessions to resolve chat safely.');
        seenCursors[next] = true;
        cursor = next;
      }
      return all;
    }

    async function chatRows(state, cursor, includeInfo) {
      cursor = validateCursor(cursor);
      var page = await sessionsPage(state, cursor);
      var sessions = [];
      page.data.forEach(function (item) {
        if (!validateListSession(item)) return;
        var row = {
          session_id: item.id,
          title: titleOf(item),
          nickname: state.nicknames[item.id] || '',
          updated_at: Number(item.time.updated || item.time.created) || 0,
          directory: item.location.directory,
          url: sessionURL(state.url, item.id),
          isDefault: !!(state.selected && state.selected.session_id === item.id)
        };
        if (includeInfo) row.sessionInfo = item;
        sessions.push(row);
      });
      return { sessions: sessions, next_cursor: page.cursor.next };
    }

    function isPlainObject(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      var prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    }

    function unicodePrefix(value, limit) {
      var result = '';
      var count = 0;
      for (var i = 0; i < value.length && count < limit; count += 1) {
        var first = value.charCodeAt(i);
        if (first >= 0xd800 && first <= 0xdbff && i + 1 < value.length) {
          var second = value.charCodeAt(i + 1);
          if (second >= 0xdc00 && second <= 0xdfff) {
            result += value.slice(i, i + 2);
            i += 2;
            continue;
          }
        }
        result += value.charAt(i);
        i += 1;
      }
      return result;
    }

    function createLimiter(maxConcurrent) {
      var running = 0;
      var waiting = [];
      var stopped = false;
      var failure = null;

      function stop(reason) {
        if (stopped) return;
        stopped = true;
        failure = reason || makeError('PLUGIN_UNAVAILABLE', 'OpenCode scan failed.');
        while (waiting.length) waiting.shift().reject(failure);
      }

      function release() {
        running -= 1;
        if (!stopped && waiting.length) schedule(waiting.shift());
      }

      function schedule(entry) {
        if (stopped) {
          entry.reject(failure);
          return;
        }
        running += 1;
        Promise.resolve().then(entry.task).then(function (value) {
          entry.resolve(value);
          release();
        }, function (err) {
          stop(err);
          entry.reject(err);
          release();
        });
      }

      function limited(task) {
        return new Promise(function (resolve, reject) {
          var entry = { task: task, resolve: resolve, reject: reject };
          if (stopped) reject(failure);
          else if (running < maxConcurrent) schedule(entry);
          else waiting.push(entry);
        });
      }
      limited.stop = stop;
      return limited;
    }

    async function uncachedActiveSnapshot(state, onValidated) {
      requireConnection(state);
      var response = await api(state, '/session/active');
      var activeMap = response && response.data;
      if (!isPlainObject(activeMap)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid active session data.');
      var activeIDs = Object.keys(activeMap);
      if (activeIDs.length > 100) throw makeError('PLUGIN_UNAVAILABLE', 'Too many active sessions to inspect safely.');
      activeIDs.forEach(function (id) {
        if (!sessionID(id) || !isPlainObject(activeMap[id]) || activeMap[id].type !== 'running') {
          throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid active session data.');
        }
      });
      if (onValidated) onValidated();
      if (activeIDs.length === 0) return { sessions: [], attention: [], roots: [], attentionRoots: [] };

      var limitRequest = createLimiter(4);
      var metadata = Object.create(null);
      var metadataCount = 0;
      function fetchMetadata(id) {
        if (metadata[id]) return metadata[id];
        metadataCount += 1;
        if (metadataCount > 200) throw makeError('PLUGIN_UNAVAILABLE', 'Too many sessions to inspect safely.');
        metadata[id] = limitRequest(function () { return getSession(state, id); });
        return metadata[id];
      }
      function parentOf(session) {
        if (session.parentID === undefined || session.parentID === null) return null;
        if (!sessionID(session.parentID)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid parent session data.');
        return session.parentID;
      }
      async function ancestry(session) {
        var reverse = [session.id];
        var seen = Object.create(null);
        seen[session.id] = true;
        var current = session;
        var hops = 0;
        var parentID = parentOf(current);
        while (parentID !== null) {
          hops += 1;
          if (hops > 32 || seen[parentID]) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid parent session data.');
          seen[parentID] = true;
          var parent = await fetchMetadata(parentID);
          if (parent.id !== parentID) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned mismatched parent session data.');
          reverse.push(parent.id);
          current = parent;
          parentID = parentOf(current);
        }
        reverse.reverse();
        return reverse;
      }
      async function attentionFor(id) {
        var responses = await Promise.all([
          limitRequest(function () { return api(state, sessionPath(id) + '/permission'); }),
          limitRequest(function () { return api(state, sessionPath(id) + '/form'); })
        ]);
        var permissions = responses[0] && responses[0].data;
        var forms = responses[1] && responses[1].data;
        function validRequests(items) {
          if (!Array.isArray(items)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid attention data.');
          items.forEach(function (item) {
            if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || item.sessionID !== id) {
              throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid attention data.');
            }
          });
          return items.length > 0;
        }
        var hasPermissions = validRequests(permissions);
        var hasForms = validRequests(forms);
        if (hasPermissions) return 'permission';
        return hasForms ? 'form' : null;
      }

      var details;
      try {
        details = await Promise.all(activeIDs.map(async function (id) {
          var session = await fetchMetadata(id);
          if (session.id !== id) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned mismatched active session data.');
          var parentID = parentOf(session);
          var [path, attention] = await Promise.all([ancestry(session), attentionFor(id)]);
          return { session: session, parentID: parentID, path: path, attention: attention };
        }));
      } catch (scanError) {
        limitRequest.stop(scanError);
        throw scanError;
      }
      details.sort(function (a, b) {
        var length = Math.min(a.path.length, b.path.length);
        for (var i = 0; i < length; i += 1) {
          if (a.path[i] < b.path[i]) return -1;
          if (a.path[i] > b.path[i]) return 1;
        }
        return a.path.length - b.path.length;
      });
      var rootIDs = Object.create(null);
      var attentionRoots = Object.create(null);
      details.forEach(function (detail) {
        var rootID = detail.path[0];
        rootIDs[rootID] = true;
        if (detail.attention) attentionRoots[rootID] = true;
      });
      return {
        sessions: details,
        attention: details.map(function (detail) { return detail.attention; }),
        roots: Object.keys(rootIDs),
        attentionRoots: Object.keys(attentionRoots)
      };
    }

    var activeSnapshotInFlight = Object.create(null);
    function safeSessionSnapshot(session) {
      var result = { id: session.id, title: titleOf(session), location: { directory: session.location.directory }, time: {} };
      ['created', 'updated', 'archived'].forEach(function (key) {
        if (session.time && session.time[key] !== undefined && (typeof session.time[key] === 'number' || typeof session.time[key] === 'boolean')) result.time[key] = session.time[key];
      });
      if (session.parentID !== undefined) result.parentID = session.parentID;
      if (typeof session.agent === 'string') result.agent = session.agent;
      if (isPlainObject(session.model) && typeof session.model.providerID === 'string' && typeof session.model.id === 'string') {
        result.model = { providerID: session.model.providerID, id: session.model.id };
      }
      if (typeof session.outcome === 'string') result.outcome = session.outcome;
      if (typeof session.cost === 'number' && Number.isFinite(session.cost) && session.cost >= 0) result.cost = session.cost;
      if (isPlainObject(session.tokens)) {
        result.tokens = {};
        ['input', 'output', 'reasoning'].forEach(function (key) {
          if (typeof session.tokens[key] === 'number' && Number.isFinite(session.tokens[key]) && session.tokens[key] >= 0) result.tokens[key] = session.tokens[key];
        });
        if (isPlainObject(session.tokens.cache)) {
          result.tokens.cache = {};
          ['read', 'write'].forEach(function (key) {
            if (typeof session.tokens.cache[key] === 'number' && Number.isFinite(session.tokens.cache[key]) && session.tokens.cache[key] >= 0) result.tokens.cache[key] = session.tokens.cache[key];
          });
        }
      }
      return result;
    }

    async function activeSnapshot(state, onValidated) {
      requireConnection(state);
      var key = state.cache_generation || '';
      {
        var cached = await readSnapshotCache(state, 'active');
        if (cached && Array.isArray(cached.sessions) && Array.isArray(cached.attention) && Array.isArray(cached.roots) && Array.isArray(cached.attentionRoots) &&
            cached.sessions.length <= 100 && cached.attention.length === cached.sessions.length && cached.roots.length <= cached.sessions.length && cached.attentionRoots.length <= cached.roots.length) {
          try {
            var restored = cached.sessions.map(function (detail, index) {
                if (!isPlainObject(detail) || !isPlainObject(detail.session) || !sessionID(detail.session.id) ||
                    !Array.isArray(detail.path) || !detail.path.length || detail.path.length > 33 || !detail.path.every(sessionID) ||
                    detail.path.some(function (id, pathIndex) { return detail.path.indexOf(id) !== pathIndex; }) ||
                    detail.path[detail.path.length - 1] !== detail.session.id ||
                    (detail.parentID !== null && detail.parentID !== undefined && !sessionID(detail.parentID)) ||
                    (detail.attention !== null && ['permission', 'form'].indexOf(detail.attention) === -1) || cached.attention[index] !== detail.attention) throw new Error('invalid');
                validSession(detail.session);
                var parentID = detail.parentID === undefined || detail.parentID === null ? null : detail.parentID;
                var sessionParentID = detail.session.parentID === undefined || detail.session.parentID === null ? null : detail.session.parentID;
                if (detail.path.length === 1) {
                  if (parentID !== null || sessionParentID !== null) throw new Error('invalid');
                } else if (detail.path[detail.path.length - 2] !== parentID || sessionParentID !== parentID) throw new Error('invalid');
                return { session: detail.session, parentID: parentID, path: detail.path, attention: detail.attention };
            });
            if (!cached.roots.every(sessionID) || !cached.attentionRoots.every(sessionID) ||
                cached.roots.some(function (id, i) { return cached.roots.indexOf(id) !== i; }) ||
                cached.attentionRoots.some(function (id, i) { return cached.attentionRoots.indexOf(id) !== i; })) throw new Error('invalid');
            var expectedRoots = Object.create(null);
            var expectedAttentionRoots = Object.create(null);
            restored.forEach(function (detail) {
              expectedRoots[detail.path[0]] = true;
              if (detail.attention) expectedAttentionRoots[detail.path[0]] = true;
            });
            if (Object.keys(expectedRoots).length !== cached.roots.length || cached.roots.some(function (id) { return !expectedRoots[id]; }) ||
                Object.keys(expectedAttentionRoots).length !== cached.attentionRoots.length || cached.attentionRoots.some(function (id) { return !expectedAttentionRoots[id]; })) throw new Error('invalid');
            var ready = { sessions: restored, attention: cached.attention, roots: cached.roots, attentionRoots: cached.attentionRoots };
            if (onValidated) onValidated();
            return ready;
          } catch (_) {}
        }
      }
      if (activeSnapshotInFlight[key]) return activeSnapshotInFlight[key].then(function (value) { if (onValidated) onValidated(); return value; });
      var pending = uncachedActiveSnapshot(state, onValidated).then(async function (snapshot) {
        {
          var packed = {
            sessions: snapshot.sessions.map(function (detail) {
              return { session: safeSessionSnapshot(detail.session), parentID: detail.parentID, path: detail.path, attention: detail.attention };
            }),
            attention: snapshot.attention, roots: snapshot.roots, attentionRoots: snapshot.attentionRoots
          };
          await writeSnapshotCache(state, 'active', packed);
        }
        return snapshot;
      }).finally(function () { delete activeSnapshotInFlight[key]; });
      activeSnapshotInFlight[key] = pending;
      return pending;
    }

    function activeInstance(state, detail) {
      var session = detail.session;
      var attention = detail.attention;
      var statusText = attention === 'permission' ? 'Approve' : attention === 'form' ? 'Input' : 'Running';
      var statusLong = attention === 'permission' ? 'Waiting for approval' : attention === 'form' ? 'Waiting for input' : 'Running';
      var name = state.nicknames[session.id] || titleOf(session);
      var properties = {
        name: { shortText: { text: unicodePrefix(name, 7) }, longText: { text: name } },
        title: { longText: { text: titleOf(session) } },
        status: { shortText: { text: statusText }, longText: { text: statusLong } },
        directory: { longText: { text: session.location.directory } },
        url: { longText: { text: sessionURL(state.url, session.id) } },
        is_subagent: { boolean: { value: Boolean(detail.parentID) } },
        root_session_id: { longText: { text: detail.path[0] } }
      };
      if (detail.parentID) properties.parent_session_id = { longText: { text: detail.parentID } };
      if (typeof session.agent === 'string') properties.agent = { longText: { text: session.agent } };
      if (session.model && typeof session.model.providerID === 'string' && session.model.providerID &&
          typeof session.model.id === 'string' && session.model.id) {
        properties.model = { longText: { text: session.model.providerID + '/' + session.model.id } };
      }
      var updated = session.time && session.time.updated;
      if (typeof updated === 'number' && Number.isFinite(updated) && updated >= 0) {
        properties.updated = { timestamp: { value: Math.floor(updated / 1000) } };
      }
      addSessionMetrics(properties, session);
      return { instanceId: session.id, properties: properties };
    }

    function nonemptyID(value, max) {
      return typeof value === 'string' && value.length > 0 && value.length <= (max || 200) && !/[\u0000-\u001f\u007f]/.test(value);
    }

    function addSessionMetrics(properties, session) {
      if (!session || typeof session !== 'object') return;
      if (['succeeded', 'failed', 'interrupted'].indexOf(session.outcome) !== -1) properties.outcome = { shortText: { text: session.outcome }, longText: { text: session.outcome } };
      if (session.model && typeof session.model.providerID === 'string' && session.model.providerID && typeof session.model.id === 'string' && session.model.id) {
        properties.model = { longText: { text: session.model.providerID + '/' + session.model.id } };
      }
      if (typeof session.agent === 'string' && session.agent) properties.agent = { longText: { text: session.agent } };
      if (typeof session.cost === 'number' && Number.isFinite(session.cost) && session.cost >= 0) {
        var costText = '$' + session.cost.toFixed(2);
        if (costText.length > 32) costText = '$' + String(session.cost);
        properties.cost = { numericValue: { value: session.cost, min: 0, unit: 'USD' }, shortText: { text: costText } };
      }
      var tokens = session.tokens;
      if (!isPlainObject(tokens)) return;
      var fields = { input: 'tokens_input', output: 'tokens_output', reasoning: 'tokens_reasoning' };
      Object.keys(fields).forEach(function (key) {
        var value = tokens[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) properties[fields[key]] = { numericValue: { value: value, min: 0 } };
      });
      if (isPlainObject(tokens.cache)) {
        [['read', 'tokens_cache_read'], ['write', 'tokens_cache_write']].forEach(function (entry) {
          var value = tokens.cache[entry[0]];
          if (typeof value === 'number' && Number.isFinite(value) && value >= 0) properties[entry[1]] = { numericValue: { value: value, min: 0 } };
        });
      }
    }

    async function latestAssistantReply(state, id) {
      var chosen = null;
      var chosenText = '';
      var cursor = null;
      var seenCursors = Object.create(null);
      var seenIDs = Object.create(null);
      var inspected = 0;
      var newestID = null;
      while (inspected < 20 && !chosen) {
        var amount = Math.min(5, 20 - inspected);
        var path = sessionPath(id) + '/message?type=assistant&limit=' + amount;
        if (cursor === null) path += '&order=desc';
        else path += '&cursor=' + encodeURIComponent(cursor);
        var response = await api(state, path);
        if (!response || !Array.isArray(response.data) || response.data.length > amount || !response.cursor || typeof response.cursor !== 'object' ||
            (response.cursor.next !== undefined && response.cursor.next !== null && typeof response.cursor.next !== 'string')) {
          throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid assistant messages.');
        }
        if (typeof response.cursor.next === 'string' && response.cursor.next.length > 4096) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid pagination data.');
        response.data.forEach(function (message) {
          if (!message || message.type !== 'assistant' || !/^msg_[A-Za-z0-9_-]{1,196}$/.test(message.id) || seenIDs[message.id] ||
              (message.sessionID !== undefined && message.sessionID !== id) || !message.time || typeof message.time !== 'object' ||
              typeof message.time.created !== 'number' || !Number.isFinite(message.time.created) || message.time.created < 0 ||
              (message.time.completed !== undefined && (typeof message.time.completed !== 'number' || !Number.isFinite(message.time.completed) || message.time.completed < 0)) ||
              !Array.isArray(message.content)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid assistant messages.');
          seenIDs[message.id] = true;
          if (!newestID) newestID = message.id;
          inspected += 1;
          var text = '';
          message.content.forEach(function (part) {
            if (!isPlainObject(part) || ['text', 'reasoning', 'tool'].indexOf(part.type) === -1) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid assistant messages.');
            if (part.type === 'text') {
              if (typeof part.text !== 'string') throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid assistant messages.');
              text += part.text;
            }
          });
          if (!chosen && text) { chosen = message; chosenText = text; }
        });
        var next = response.cursor.next === undefined ? null : response.cursor.next;
        if (chosen || !response.data.length || next === null || next === '') break;
        if (next.length > 4096 || seenCursors[next]) {
          throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid pagination data.');
        }
        seenCursors[next] = true;
        cursor = next;
      }
      if (!chosen) return null;
      return { message: chosen, text: chosenText, newestID: newestID, inspected: inspected };
    }

    function replyStatus(message) {
      var failed = !!message.error || message.finish === 'error';
      var complete = typeof message.time.completed === 'number';
      return failed ? 'Error' : complete ? 'Done' : 'Writing';
    }

    async function sourceActiveMap(state) {
      var cached = await readSnapshotCache(state, 'active-map');
      if (cached && Array.isArray(cached.ids) && cached.ids.length <= 100 && cached.ids.every(sessionID) &&
          cached.ids.every(function (id, index) { return cached.ids.indexOf(id) === index; })) return cached.ids;
      var key = state.cache_generation + '|' + state.url + '|' + state.username;
      if (sourceActiveMapInFlight[key]) return sourceActiveMapInFlight[key];
      var pending = (async function () {
        var response = await api(state, '/session/active');
        var map = response && response.data;
        if (!isPlainObject(map) || Object.keys(map).length > 100) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid active session data.');
        var ids = Object.keys(map);
        ids.forEach(function (id) {
          if (!sessionID(id) || !isPlainObject(map[id]) || map[id].type !== 'running') throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid active session data.');
        });
        await writeSnapshotCache(state, 'active-map', { ids: ids }, SNAPSHOT_TTL_MS);
        return ids;
      })();
      sourceActiveMapInFlight[key] = pending;
      try { return await pending; }
      finally { if (sourceActiveMapInFlight[key] === pending) delete sourceActiveMapInFlight[key]; }
    }

    async function sourceAssistantReply(state, id, session) {
      var updated = session && session.time && session.time.updated;
      var cached = await readSnapshotCache(state, 'reply:' + id);
      if (cached && Object.keys(cached).sort().join(',') === 'completed,created,failed,finish,id,text,updated' && cached.failed === false &&
          typeof updated === 'number' && Number.isFinite(updated) && updated >= 0 && cached.updated === updated &&
          /^msg_[A-Za-z0-9_-]{1,196}$/.test(cached.id) && typeof cached.text === 'string' && cached.text.length <= 16384 &&
          typeof cached.created === 'number' && Number.isFinite(cached.created) && cached.created >= 0 && typeof cached.completed === 'number' && Number.isFinite(cached.completed) && cached.completed >= 0 &&
          ['stop', 'length', 'tool-calls', 'content-filter', 'unknown'].indexOf(cached.finish) !== -1) {
        try {
          var activeIDs = await sourceActiveMap(state);
          if (activeIDs.indexOf(id) === -1) {
            return { message: { id: cached.id, time: { created: cached.created, completed: cached.completed }, finish: cached.finish, error: cached.failed ? {} : undefined }, text: cached.text, newestID: cached.id };
          }
        } catch (_) { /* failure must refresh rather than serve cache */ }
      }
      var reply = await latestAssistantReply(state, id);
      if (reply && reply.newestID === reply.message.id && typeof reply.message.time.completed === 'number' && Number.isFinite(reply.message.time.completed) && reply.message.time.completed >= 0 && !reply.message.error && reply.message.finish !== 'error' &&
          typeof updated === 'number' && Number.isFinite(updated) && updated >= 0 && typeof reply.message.time.created === 'number' && Number.isFinite(reply.message.time.created) && reply.message.time.created >= 0) {
        await writeSnapshotCache(state, 'reply:' + id, {
          id: reply.message.id, text: unicodePrefix(reply.text, 4096), created: reply.message.time.created,
          completed: reply.message.time.completed, updated: updated, finish: reply.message.finish || 'stop', failed: false
        }, 60000);
      }
      return reply;
    }

    function replyInstances(state, id) {
      return getSession(state, id).then(async function (session) {
        var reply = await sourceAssistantReply(state, id, session);
        if (!reply) return [];
        var chosen = reply.message;
        var title = state.nicknames[id] || (state.selected && state.selected.session_id === id && state.selected.title) || titleOf(session);
        var complete = typeof chosen.time.completed === 'number';
        var updated = complete ? chosen.time.completed : chosen.time.created;
        return [{ instanceId: id, properties: {
          name: { shortText: { text: unicodePrefix(title, 7) }, longText: { text: title } },
          session_id: { longText: { text: id } }, message_id: { longText: { text: chosen.id } },
          text: { shortText: { text: unicodePrefix(reply.text, 7) }, longText: { text: unicodePrefix(reply.text, 4096) } },
          updated: { timestamp: { value: Math.floor(updated / 1000) } },
          complete: { boolean: { value: complete } },
          status: { shortText: { text: replyStatus(chosen) }, longText: { text: replyStatus(chosen) } },
          url: { longText: { text: sessionURL(state.url, id) } }
        }}].map(function (instance) { addSessionMetrics(instance.properties, session); return instance; });
      });
    }

    function repliesInstance(state, meta, reply, defaultID) {
      var name = meta.nickname || meta.title;
      var properties = {
        name: { shortText: { text: unicodePrefix(name, 7) }, longText: { text: name } },
        title: { longText: { text: meta.title } },
        session_id: { longText: { text: meta.session_id } },
        is_default: { boolean: { value: meta.session_id === defaultID } },
        url: { longText: { text: meta.url } }
      };
      if (reply) {
        var complete = typeof reply.message.time.completed === 'number';
        var updated = complete ? reply.message.time.completed : reply.message.time.created;
        var statusText = replyStatus(reply.message);
        properties.message_id = { longText: { text: reply.message.id } };
        properties.text = { shortText: { text: unicodePrefix(reply.text, 7) }, longText: { text: unicodePrefix(reply.text, 4096) } };
        properties.updated = { timestamp: { value: Math.floor(updated / 1000) } };
        properties.complete = { boolean: { value: complete } };
        properties.status = { shortText: { text: statusText }, longText: { text: statusText } };
      } else {
        properties.status = { shortText: { text: 'Idle' }, longText: { text: 'No reply' } };
      }
      addSessionMetrics(properties, meta.sessionInfo);
      return { instanceId: meta.session_id, properties: properties };
    }

    async function repliesInstances(state) {
      var page = await chatRows(state, null, true);
      var recent = page.sessions;
      var byID = Object.create(null);
      recent.forEach(function (row) {
        if (!byID[row.session_id]) byID[row.session_id] = row;
      });
      var defaultID = state.mode === 'default_chat' && state.selected && sessionID(state.selected.session_id) ? state.selected.session_id : null;
      var lastID = sessionID(state.lastSessionID) ? state.lastSessionID : null;
      var ordered = [];
      var seenIDs = Object.create(null);
      function addFocus(id) {
        if (!id || seenIDs[id]) return;
        seenIDs[id] = true;
        ordered.push(byID[id] ? { meta: byID[id] } : { id: id });
      }
      addFocus(defaultID);
      addFocus(lastID);
      recent.forEach(function (row) {
        if (seenIDs[row.session_id]) return;
        seenIDs[row.session_id] = true;
        ordered.push({ meta: row });
      });
      ordered = ordered.slice(0, state.reply_count);

      var limit = createLimiter(4);
      var entries;
      try {
        entries = await Promise.all(ordered.map(function (entry) {
          return limit(async function () {
            var meta = entry.meta;
            if (!meta) {
              var session = await getSession(state, entry.id);
              meta = {
                session_id: session.id,
                title: titleOf(session),
                nickname: state.nicknames[session.id] || '',
                url: sessionURL(state.url, session.id), sessionInfo: session
              };
            }
            var reply = await sourceAssistantReply(state, meta.session_id, meta.sessionInfo);
            return { instance: repliesInstance(state, meta, reply, defaultID), reply: reply, sessionId: meta.session_id };
          });
        }));
      } catch (err) {
        limit.stop(err);
        throw err;
      }
      if (state.reply_alerts && notificationsSupported()) await processReplyAlerts(state, entries);
      return { validUntilMs: now() + 60000, instances: entries.map(function (entry) { return entry.instance; }) };
    }

    function validPermissionRequest(item) {
      if (!isPlainObject(item) || !nonemptyID(item.id) || !sessionID(item.sessionID) ||
          typeof item.action !== 'string' || !item.action || !Array.isArray(item.resources) ||
          item.resources.some(function (resource) { return typeof resource !== 'string'; }) ||
          (item.message !== undefined && typeof item.message !== 'string')) {
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid permission data.');
      }
      return item;
    }

    async function pendingPermissions(state) {
      var response = await api(state, '/permission/request');
      if (!response || !Array.isArray(response.data)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid permission data.');
      return response.data.map(validPermissionRequest);
    }

    function validFormSummary(item) {
      if (!isPlainObject(item) || !nonemptyID(item.id) || !sessionID(item.sessionID) ||
          typeof item.title !== 'string' || !Array.isArray(item.fields)) {
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid question data.');
      }
      return item;
    }

    async function pendingForms(state) {
      var response = await api(state, '/form');
      if (!response || !Array.isArray(response.data)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid question data.');
      return response.data.map(validFormSummary);
    }

    function metaFromRow(row) {
      return {
        session_id: row.session_id, title: row.title, nickname: row.nickname || '',
        updated: row.updated_at || 0, is_subagent: false, sessionInfo: row.sessionInfo
      };
    }

    function metaFromSession(state, session) {
      return {
        session_id: session.id, title: titleOf(session), nickname: state.nicknames[session.id] || '',
        updated: Number(session.time.updated || session.time.created) || 0,
        is_subagent: Boolean(session.parentID), sessionInfo: session
      };
    }

    async function sessionMetas(state, ids, recentMap) {
      var metas = Object.create(null);
      ids.forEach(function (id) {
        if (recentMap[id]) metas[id] = metaFromRow(recentMap[id]);
      });
      var missing = ids.filter(function (id) { return !metas[id]; });
      var limit = createLimiter(4);
      try {
        await Promise.all(missing.map(async function (id) {
          var session = await limit(function () { return getSession(state, id); });
          metas[id] = metaFromSession(state, session);
        }));
      } catch (err) {
        limit.stop(err);
        throw err;
      }
      return metas;
    }

    function chatStatusInstance(state, meta, reply, permissionCount, questionCount, defaultID) {
      var name = meta.nickname || meta.title;
      var unread = !!(reply && state.last_seen[meta.session_id] !== reply.message.id);
      var reason = permissionCount > 0 ? 'permission' : questionCount > 0 ? 'question' : unread ? 'unread' : 'none';
      var shortReason = reason === 'permission' ? 'Perm' : reason === 'question' ? 'Ask' : reason === 'unread' ? 'Unread' : 'None';
      var longReason = reason === 'permission' ? 'Permission' : reason === 'question' ? 'Question' : reason === 'unread' ? 'Unread' : 'None';
      var properties = {
        name: { shortText: { text: unicodePrefix(name, 7) }, longText: { text: name } },
        title: { longText: { text: meta.title } },
        session_id: { longText: { text: meta.session_id } },
        needs_action: { boolean: { value: reason !== 'none' } },
        reason: { shortText: { text: shortReason }, longText: { text: longReason } },
        permission_count: { numericValue: { value: permissionCount, min: 0 }, shortText: { text: String(permissionCount) } },
        question_count: { numericValue: { value: questionCount, min: 0 }, shortText: { text: String(questionCount) } },
        unread: { boolean: { value: unread } },
        is_default: { boolean: { value: meta.session_id === defaultID } },
        is_subagent: { boolean: { value: meta.is_subagent } },
        url: { longText: { text: sessionURL(state.url, meta.session_id) } }
      };
      addSessionMetrics(properties, meta.sessionInfo);
      if (reply) properties.message_id = { longText: { text: reply.message.id } };
      var updated = reply ? (typeof reply.message.time.completed === 'number' ? reply.message.time.completed : reply.message.time.created) : meta.updated;
      if (typeof updated === 'number' && Number.isFinite(updated) && updated >= 0) {
        properties.updated = { timestamp: { value: Math.floor(updated / 1000) } };
      }
      return { instanceId: meta.session_id, properties: properties };
    }

    async function chatStatusInstances(state) {
      var loaded = await Promise.all([chatRows(state, null, true), pendingPermissions(state), pendingForms(state)]);
      var recent = loaded[0].sessions;
      var permissions = loaded[1];
      var forms = loaded[2];
      var recentMap = Object.create(null);
      recent.forEach(function (row) { if (!recentMap[row.session_id]) recentMap[row.session_id] = row; });
      var permissionCounts = Object.create(null);
      var questionCounts = Object.create(null);
      permissions.forEach(function (item) { permissionCounts[item.sessionID] = (permissionCounts[item.sessionID] || 0) + 1; });
      forms.forEach(function (item) { questionCounts[item.sessionID] = (questionCounts[item.sessionID] || 0) + 1; });
      var defaultID = state.mode === 'default_chat' && state.selected && sessionID(state.selected.session_id) ? state.selected.session_id : null;
      var lastID = sessionID(state.lastSessionID) ? state.lastSessionID : null;
      var ids = [];
      var seen = Object.create(null);
      function add(id) {
        if (!id || seen[id]) return;
        seen[id] = true;
        ids.push(id);
      }
      add(defaultID);
      add(lastID);
      recent.slice(0, state.reply_count).forEach(function (row) { add(row.session_id); });
      permissions.forEach(function (item) { add(item.sessionID); });
      forms.forEach(function (item) { add(item.sessionID); });
      if (ids.length > MAX_ATTENTION_CHATS) throw makeError('PLUGIN_UNAVAILABLE', 'Too many chats to inspect safely.');
      var metas = await sessionMetas(state, ids, recentMap);
      var limit = createLimiter(4);
      var instances;
      try {
        instances = await Promise.all(ids.map(function (id) {
          return limit(async function () {
            var reply = await sourceAssistantReply(state, id, metas[id].sessionInfo);
            return chatStatusInstance(state, metas[id], reply, permissionCounts[id] || 0, questionCounts[id] || 0, defaultID);
          });
        }));
      } catch (err) {
        limit.stop(err);
        throw err;
      }
      return { validUntilMs: now() + 20000, instances: instances };
    }

    async function permissionInstances(state) {
      var permissions = await pendingPermissions(state);
      if (!permissions.length) return { validUntilMs: now() + 20000, instances: [] };
      if (permissions.length > MAX_ATTENTION_CHATS) throw makeError('PLUGIN_UNAVAILABLE', 'Too many permission requests to inspect safely.');
      var recent = await chatRows(state, null);
      var recentMap = Object.create(null);
      recent.sessions.forEach(function (row) { if (!recentMap[row.session_id]) recentMap[row.session_id] = row; });
      var ids = [];
      permissions.forEach(function (item) { if (ids.indexOf(item.sessionID) === -1) ids.push(item.sessionID); });
      var metas = await sessionMetas(state, ids, recentMap);
      permissions.sort(function (a, b) {
        return a.sessionID < b.sessionID ? -1 : a.sessionID > b.sessionID ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      return { validUntilMs: now() + 20000, instances: permissions.map(function (item) {
        var meta = metas[item.sessionID];
        var name = meta.nickname || meta.title;
        var properties = {
          name: { shortText: { text: unicodePrefix(name, 7) }, longText: { text: name } },
          title: { longText: { text: meta.title } },
          session_id: { longText: { text: item.sessionID } },
          request_id: { longText: { text: item.id } },
          action: { shortText: { text: unicodePrefix(item.action, 7) }, longText: { text: item.action } },
          url: { longText: { text: sessionURL(state.url, item.sessionID) } }
        };
        var resources = JSON.stringify(item.resources);
        if (resources.length > 16000) throw makeError('PLUGIN_UNAVAILABLE', 'Permission resources exceed safe display size.');
        properties.resources = { longText: { text: resources } };
        if (typeof item.message === 'string' && item.message) properties.message = { longText: { text: item.message } };
        return { instanceId: item.sessionID + ':' + item.id, properties: properties };
      }) };
    }

    function usageMeter(meter, label) {
      if (!isPlainObject(meter) || typeof meter.percent !== 'number' || !Number.isFinite(meter.percent) ||
          meter.percent < 0 || meter.percent > 100 || typeof meter.limited !== 'boolean' ||
          typeof meter.resetsAt !== 'number' || !Number.isFinite(meter.resetsAt) || meter.resetsAt < 0) {
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid Go usage data.');
      }
      return { percent: meter.percent, limited: meter.limited, resetsAt: meter.resetsAt, label: label };
    }

    function percentText(value) {
      return String(Math.round(value)) + '%';
    }

    async function goUsageInstances(state) {
      var response;
      try { response = await api(state, '/experimental/usage/limits'); }
      catch (err) {
        if (err && (err.httpStatus === 404 || err.httpStatus === 405)) {
          throw makeError('PLUGIN_UNAVAILABLE', 'Go usage is not supported by this OpenCode server.');
        }
        throw err;
      }
      if (!response || !Object.prototype.hasOwnProperty.call(response, 'data')) {
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid Go usage data.');
      }
      if (response.data === null) return [];
      if (!isPlainObject(response.data) || !isPlainObject(response.data.workspace) ||
          !nonemptyID(response.data.workspace.id) || typeof response.data.workspace.usageURL !== 'string') {
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid Go usage data.');
      }
      if (response.data.go === undefined) return [];
      if (!isPlainObject(response.data.go)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid Go usage data.');
      var rolling = usageMeter(response.data.go.rolling, '5h');
      var weekly = usageMeter(response.data.go.weekly, 'Week');
      var monthly = usageMeter(response.data.go.monthly, 'Month');
      var meters = [rolling, weekly, monthly];
      var limited = meters.some(function (meter) { return meter.limited; });
      var maxPercent = Math.max(rolling.percent, weekly.percent, monthly.percent);
      var workspace = response.data.workspace;
      var title = typeof workspace.name === 'string' && workspace.name ? workspace.name : 'OpenCode Go';
      var properties = {
        name: { shortText: { text: unicodePrefix(title, 7) }, longText: { text: title } },
        workspace_id: { longText: { text: workspace.id } },
        go_rolling_percent: { numericValue: { value: rolling.percent, min: 0, max: 100 }, shortText: { text: percentText(rolling.percent) } },
        go_weekly_percent: { numericValue: { value: weekly.percent, min: 0, max: 100 }, shortText: { text: percentText(weekly.percent) } },
        go_monthly_percent: { numericValue: { value: monthly.percent, min: 0, max: 100 }, shortText: { text: percentText(monthly.percent) } },
        go_rolling_resets: { timestamp: { value: Math.floor(rolling.resetsAt / 1000) } },
        go_weekly_resets: { timestamp: { value: Math.floor(weekly.resetsAt / 1000) } },
        go_monthly_resets: { timestamp: { value: Math.floor(monthly.resetsAt / 1000) } },
        limited: { boolean: { value: limited }, shortText: { text: limited ? 'Yes' : 'No' } },
        status: { shortText: { text: limited ? 'Limited' : 'Active' }, longText: { text: limited ? 'Go limit reached' : 'Go usage available' } },
        summary: { shortText: { text: percentText(maxPercent) }, longText: { text: 'Go: 5h ' + percentText(rolling.percent) + ', week ' + percentText(weekly.percent) + ', month ' + percentText(monthly.percent) } },
        checked_at: { timestamp: { value: Math.floor(now() / 1000) } }
      };
      if (workspace.usageURL) properties.usage_url = { longText: { text: workspace.usageURL } };
      return [{ instanceId: workspace.id, properties: properties }];
    }

    async function jobInstances(state) {
      var response;
      try { response = await api(state, '/experimental/job'); }
      catch (err) {
        if (err && (err.httpStatus === 404 || err.httpStatus === 405)) throw makeError('PLUGIN_UNAVAILABLE', 'Background jobs are not supported by this OpenCode server.');
        throw err;
      }
      if (!response || !Array.isArray(response.data) || response.data.length > 200) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid background jobs.');
      var seen = Object.create(null);
      var jobs = response.data.map(function (job) {
        if (!job || ['shell', 'subagent', 'image'].indexOf(job.kind) === -1 || !nonemptyID(job.id, 200) ||
            !sessionID(job.sessionID) || ['running', 'completed', 'error', 'cancelled'].indexOf(job.status) === -1 ||
            !job.time || typeof job.time.started !== 'number' || !Number.isFinite(job.time.started) || job.time.started < 0 ||
            (job.title !== undefined && typeof job.title !== 'string') ||
            (job.kind === 'subagent' && job.childSessionID !== undefined && !sessionID(job.childSessionID))) {
          throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid background jobs.');
        }
        var key = job.kind + ':' + job.id;
        if (seen[key]) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned duplicate background jobs.');
        seen[key] = true;
        return job;
      });
      jobs.sort(function (a, b) { return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
      return jobs.map(function (job) {
        var title = typeof job.title === 'string' && job.title ? job.title : job.kind + ' job';
        var props = {
          name: { shortText: { text: unicodePrefix(title, 7) }, longText: { text: title } },
          job_id: { longText: { text: job.id } }, session_id: { longText: { text: job.sessionID } },
          kind: { shortText: { text: unicodePrefix(job.kind, 7) } }, status: { shortText: { text: unicodePrefix(job.status, 7) }, longText: { text: job.status } },
          started: { timestamp: { value: Math.floor(job.time.started / 1000) } },
          url: { longText: { text: sessionURL(state.url, job.sessionID) } }
        };
        if (job.kind === 'subagent' && sessionID(job.childSessionID)) props.child_session_id = { longText: { text: job.childSessionID } };
        return { instanceId: job.kind + ':' + job.id, properties: props };
      });
    }

    function focusedSessionID(state) {
      if (state.mode === 'default_chat' && state.selected && sessionID(state.selected.session_id)) return state.selected.session_id;
      return sessionID(state.lastSessionID) ? state.lastSessionID : null;
    }

    function scopedLocation(state, session) {
      var directory = session ? session.location.directory : state.directory;
      if (!directoryPath(directory)) throw makeError('INVALID_ARGS', 'Set an absolute server directory first.');
      return directory;
    }

    function boundedDisplayText(value, limit) {
      return unicodePrefix(value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '), limit);
    }

    function locationQuery(directory) { return '?location%5Bdirectory%5D=' + encodeURIComponent(directory); }

    function validStructuredError(value) {
      return isPlainObject(value) && typeof value.type === 'string' && !!value.type && value.type.length <= 128 &&
        typeof value.message === 'string' && validUnicodeString(value.message) && value.message.length <= 65536;
    }

    function validUnicodeString(value) {
      if (typeof value !== 'string') return false;
      for (var i = 0; i < value.length; i += 1) {
        var code = value.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          if (i + 1 >= value.length || value.charCodeAt(i + 1) < 0xdc00 || value.charCodeAt(i + 1) > 0xdfff) return false;
          i += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) return false;
      }
      return true;
    }

    function safeMessageDetail(error, fallback) {
      if (!error || typeof error.message !== 'string' || !validUnicodeString(error.message)) return fallback;
      var text = error.message.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
      return text ? unicodePrefix(text, 512) : fallback;
    }

    function terminalSessionOutcome(value) {
      if (value === 'failed') return { label: 'Failed', detail: 'Failed' };
      if (value === 'interrupted') return { label: 'Interrupted', detail: 'Interrupted' };
      if (value === 'succeeded') return { label: 'Idle', detail: 'Completed' };
      return null;
    }

    function validateLocationResponse(response, directory, message) {
      if (!isPlainObject(response) || !isPlainObject(response.location) || response.location.directory !== directory || !Array.isArray(response.data)) {
        throw makeError('PLUGIN_UNAVAILABLE', message);
      }
      return response.data;
    }

    function validCommandName(name) {
      return typeof name === 'string' && name.trim().length > 0 && name.length <= 200 && validUnicodeString(name) && !/[\u0000-\u001f\u007f-\u009f]/.test(name);
    }

    function validateCommandList(response, directory) {
      var commands = validateLocationResponse(response, directory, 'OpenCode returned invalid command data.');
      if (commands.length > 200) throw makeError('PLUGIN_UNAVAILABLE', 'Too many commands to inspect safely.');
      var seen = Object.create(null);
      commands.forEach(function (command) {
        if (!isPlainObject(command) || !validCommandName(command.name) || seen[command.name] ||
            command.description !== undefined && (typeof command.description !== 'string' || !validUnicodeString(command.description))) {
          throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid command data.');
        }
        seen[command.name] = true;
      });
      return commands;
    }

    async function executionInstances(state) {
      var id = focusedSessionID(state);
      if (!id) return { validUntilMs: now() + 20000, instances: [] };
      var session = await getSession(state, id);
      var loaded = await Promise.all([
        api(state, '/session/active'),
        api(state, sessionPath(id) + '/message?order=desc&limit=5')
      ]);
      var active = loaded[0] && loaded[0].data;
      var timeline = loaded[1];
      if (!isPlainObject(active) || Object.keys(active).length > 100 || !timeline || !Array.isArray(timeline.data) || timeline.data.length > 5 ||
          !isPlainObject(timeline.cursor) || Object.keys(timeline.cursor).some(function (key) { return key !== 'next' && key !== 'previous'; }) ||
          ['next', 'previous'].some(function (key) { return timeline.cursor[key] !== undefined && timeline.cursor[key] !== null &&
            (typeof timeline.cursor[key] !== 'string' || timeline.cursor[key].length > 4096); })) {
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid execution data.');
      }
      Object.keys(active).forEach(function (activeID) {
        if (!sessionID(activeID) || !isPlainObject(active[activeID]) || active[activeID].type !== 'running') throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid execution data.');
      });
      var messages = timeline.data;
      var seenMessageIDs = Object.create(null);
      messages.forEach(function (message) {
        if (!isPlainObject(message) || !/^msg_[A-Za-z0-9_-]{1,196}$/.test(message.id) || !message.time || typeof message.time.created !== 'number' ||
            !Number.isFinite(message.time.created) || message.time.created < 0 ||
            seenMessageIDs[message.id] || message.sessionID !== undefined && message.sessionID !== id ||
            ['agent-switched', 'model-switched', 'location-switched', 'user', 'synthetic', 'system', 'skill', 'shell', 'assistant', 'compaction', 'idle'].indexOf(message.type) === -1) {
          throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid execution timeline.');
        }
        seenMessageIDs[message.id] = true;
        if (message.type === 'assistant' && (!Array.isArray(message.content) || message.content.length > 1000 ||
            message.time.completed !== undefined && (typeof message.time.completed !== 'number' || !Number.isFinite(message.time.completed) || message.time.completed < 0) ||
            message.finish !== undefined && ['stop', 'length', 'tool-calls', 'content-filter', 'error', 'unknown'].indexOf(message.finish) === -1 ||
            message.error !== undefined && !validStructuredError(message.error) ||
            message.retry !== undefined && (!isPlainObject(message.retry) || !Number.isInteger(message.retry.attempt) || message.retry.attempt < 1 || typeof message.retry.at !== 'number' || !Number.isFinite(message.retry.at) || message.retry.at < 0 || !validStructuredError(message.retry.error)))) {
          throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid execution timeline.');
        }
        if (message.type === 'assistant') message.content.forEach(function (part) {
          if (!isPlainObject(part) || ['text', 'reasoning', 'tool'].indexOf(part.type) === -1) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid execution timeline.');
          if (part.type === 'text' || part.type === 'reasoning') {
            if (typeof part.text !== 'string' || part.text.length > 1000000 || !validUnicodeString(part.text)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid execution timeline.');
          } else if (!isPlainObject(part.state) || ['running', 'streaming', 'completed', 'error'].indexOf(part.state.status) === -1 ||
              part.name !== undefined && (typeof part.name !== 'string' || !part.name || part.name.length > 200 || !validUnicodeString(part.name) || /[\u0000-\u001f\u007f-\u009f]/.test(part.name)) ||
              part.state.status === 'error' && !validStructuredError(part.state.error)) {
            throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid execution timeline.');
          }
        });
        if (message.type === 'agent-switched' && (typeof message.agent !== 'string' || !message.agent || message.agent.length > 200 || !validUnicodeString(message.agent))) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid execution timeline.');
        if (message.type === 'model-switched' && (!isPlainObject(message.model) || typeof message.model.providerID !== 'string' || !message.model.providerID ||
            typeof message.model.id !== 'string' || !message.model.id)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid execution timeline.');
        if (message.type === 'location-switched' && !isPlainObject(message.location)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid execution timeline.');
        if (message.type === 'compaction' && (['running', 'completed', 'failed'].indexOf(message.status) === -1 || ['auto', 'manual'].indexOf(message.reason) === -1 ||
            (message.status !== 'failed' && (typeof message.summary !== 'string' || !validUnicodeString(message.summary))) || message.status === 'failed' && !validStructuredError(message.error))) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid execution timeline.');
        if (message.type === 'idle' && (['succeeded', 'failed', 'interrupted'].indexOf(message.outcome) === -1 || message.error !== undefined && !validStructuredError(message.error))) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid execution timeline.');
      });
      var current = messages.find(function (message) { return ['agent-switched', 'model-switched', 'location-switched'].indexOf(message.type) === -1; }) || null;
      var isActive = Object.prototype.hasOwnProperty.call(active, id);
      var currentTool = null;
      if (current && current.type === 'assistant') {
        current.content.forEach(function (part) {
          if (part.type === 'tool' && ['running', 'streaming'].indexOf(part.state.status) !== -1) currentTool = part;
        });
      }
      var label = 'Idle';
      var detail = 'Idle';
      var toolName = currentTool && typeof currentTool.name === 'string' ? unicodePrefix(currentTool.name, 200) : null;
      var retryAt = null;
      if (current && current.type === 'compaction') {
        if (current.status === 'failed') { label = 'Failed'; detail = 'Compaction failed: ' + safeMessageDetail(current.error, 'Compaction failed'); }
        else if (current.status === 'completed') { label = 'Idle'; detail = 'Compaction completed'; }
        else if (current.status === 'running') { label = 'Compacting'; detail = 'Compaction running'; }
        else throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid execution timeline.');
      }
      else if (current && current.type === 'assistant') {
        var retry = current.retry;
        if (retry && typeof retry === 'object' && typeof retry.at === 'number' && Number.isFinite(retry.at) && retry.at >= 0) {
          label = 'Retrying'; detail = 'Retry scheduled'; retryAt = retry.at;
          if (retry.error) detail += ': ' + safeMessageDetail(retry.error, 'Retry scheduled');
        } else if (currentTool) {
          label = 'Running'; detail = 'Tool running';
        } else if (current.content.some(function (part) { return part.type === 'tool' && part.state.status === 'error'; })) {
          var failedTool = current.content.filter(function (part) { return part.type === 'tool' && part.state.status === 'error'; }).pop();
          label = 'Failed'; detail = safeMessageDetail(failedTool.state.error, 'Tool failed');
        }
        else if (current.error || current.finish === 'error') { label = 'Failed'; detail = safeMessageDetail(current.error, 'Failed'); }
        else if (current.time.completed === undefined && !isActive && terminalSessionOutcome(session.outcome)) {
          label = terminalSessionOutcome(session.outcome).label; detail = terminalSessionOutcome(session.outcome).detail;
        }
        else if (current.time.completed === undefined) { label = 'Running'; detail = isActive ? 'Generating' : 'Writing'; }
        else if (current.finish === 'tool-calls') { label = 'Running'; detail = 'Tool call'; }
      } else if (current && current.type === 'idle') {
        if (['succeeded', 'failed', 'interrupted'].indexOf(current.outcome) === -1) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid execution timeline.');
        label = current.outcome === 'failed' ? 'Failed' : current.outcome === 'interrupted' ? 'Interrupted' : 'Idle';
        detail = current.outcome === 'succeeded' ? 'Completed' : current.outcome === 'failed' ? safeMessageDetail(current.error, 'Failed') : label;
      }
      else if (current && ['user', 'synthetic'].indexOf(current.type) !== -1) { label = 'Waiting'; detail = 'Waiting for assistant'; }
      else if (!current || ['agent-switched', 'model-switched', 'location-switched'].indexOf(current.type) !== -1) {
        var outcome = terminalSessionOutcome(session.outcome);
        if (outcome) { label = outcome.label; detail = outcome.detail; }
      }
      if (isActive && (label === 'Idle' || label === 'Waiting' || label === 'Interrupted' || !current || current.type === 'idle')) {
        label = 'Running';
        detail = 'Running';
      }
      detail = unicodePrefix(detail, 512);
      var title = state.nicknames[id] || titleOf(session);
      var props = {
        name: { shortText: { text: unicodePrefix(title, 7) }, longText: { text: title } },
        session_id: { longText: { text: id } },
        status: { shortText: { text: label }, longText: { text: detail } },
        detail: { longText: { text: detail } },
        url: { longText: { text: sessionURL(state.url, id) } }
      };
      if (toolName) props.tool = { longText: { text: toolName } };
      if (retryAt !== null) props.retry_at = { timestamp: { value: Math.floor(retryAt / 1000) } };
      if (session.time && typeof session.time.updated === 'number' && Number.isFinite(session.time.updated) && session.time.updated >= 0) props.updated = { timestamp: { value: Math.floor(session.time.updated / 1000) } };
      return { validUntilMs: now() + 20000, instances: [{ instanceId: id, properties: props }] };
    }

    function inboxItemValid(item, id) {
      if (!isPlainObject(item) || !/^msg_[A-Za-z0-9_-]{1,196}$/.test(item.id) || item.sessionID !== id ||
          ['user', 'synthetic', 'compaction', 'move'].indexOf(item.type) === -1 || !isPlainObject(item.time) ||
          typeof item.time.created !== 'number' || !Number.isFinite(item.time.created) || item.time.created < 0 ||
          !validDelivery(item.delivery) || item.payload === undefined || item.payload === null) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid inbox data.');
      if ((item.type === 'user' || item.type === 'synthetic') && (!isPlainObject(item.payload) || typeof item.payload.text !== 'string' ||
          !validUnicodeString(item.payload.text) || item.payload.text.length > 1048576)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid inbox data.');
      if (item.type === 'move' && !isPlainObject(item.payload)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid inbox data.');
      return item;
    }

    function validateInboxList(data, id) {
      if (!Array.isArray(data) || data.length > 200) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid inbox data.');
      var seen = Object.create(null);
      return data.map(function (item) {
        item = inboxItemValid(item, id);
        if (seen[item.id]) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned duplicate inbox data.');
        seen[item.id] = true;
        return item;
      });
    }

    async function queueInstances(state) {
      var ids = [];
      var focus = focusedSessionID(state);
      if (state.mode === 'default_chat' && state.selected && sessionID(state.selected.session_id)) ids.push(state.selected.session_id);
      if (sessionID(state.lastSessionID) && ids.indexOf(state.lastSessionID) === -1) ids.push(state.lastSessionID);
      else if (focus && ids.indexOf(focus) === -1) ids.push(focus);
      if (ids.length > 2) ids = ids.slice(0, 2);
      var all = [];
      var seenComposite = Object.create(null);
      var titles = Object.create(null);
      for (var i = 0; i < ids.length; i += 1) {
        var session = await getSession(state, ids[i]);
        if (archived(session)) continue;
        titles[ids[i]] = state.nicknames[ids[i]] || titleOf(session);
        var response = await api(state, sessionPath(ids[i]) + '/inbox');
        if (!response || !Array.isArray(response.data)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid inbox data.');
        if (response.data.length > 200 || all.length + response.data.length > 200) throw makeError('PLUGIN_UNAVAILABLE', 'Too many queued messages to inspect safely.');
        validateInboxList(response.data, ids[i]).forEach(function (item) {
          var key = item.sessionID + ':' + item.id;
          if (seenComposite[key]) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned duplicate inbox data.');
          seenComposite[key] = true;
          var text = item.type === 'user' || item.type === 'synthetic' ? boundedDisplayText(item.payload.text, 4096) :
            item.type === 'compaction' ? 'Compaction' : 'Session moved';
          all.push({ item: item, text: text });
        });
      }
      return { validUntilMs: now() + 20000, instances: all.map(function (entry) {
        var item = entry.item;
        var title = titles[item.sessionID];
        title = typeof title === 'string' && validUnicodeString(title) ? boundedDisplayText(title, 4096) : 'OpenCode session';
        return { instanceId: item.sessionID + ':' + item.id, properties: {
          name: { shortText: { text: unicodePrefix(title, 7) }, longText: { text: title } },
          session_id: { longText: { text: item.sessionID } }, inbox_id: { longText: { text: item.id } },
          kind: { shortText: { text: item.type } }, text: { shortText: { text: unicodePrefix(entry.text, 7) }, longText: { text: entry.text } },
          delivery: { shortText: { text: item.delivery } }, queued_at: { timestamp: { value: Math.floor(item.time.created / 1000) } },
          url: { longText: { text: sessionURL(state.url, item.sessionID) } }
        } };
      }) };
    }

    async function shellInstances(state) {
      var id = focusedSessionID(state);
      var session = id ? await getSession(state, id) : null;
      var directory = scopedLocation(state, session);
      var response;
      try { response = await api(state, '/shell' + locationQuery(directory)); }
      catch (err) { if (err && (err.httpStatus === 404 || err.httpStatus === 405)) throw makeError('PLUGIN_UNAVAILABLE', 'Shell source is not supported by this OpenCode server.'); throw err; }
      var shells = validateLocationResponse(response, directory, 'OpenCode returned invalid shell data.');
      if (shells.length > 200) throw makeError('PLUGIN_UNAVAILABLE', 'Too many shells to inspect safely.');
      var shellIDs = Object.create(null);
      shells.forEach(function (shell) {
        if (!isPlainObject(shell) || !/^sh_[A-Za-z0-9_-]{1,197}$/.test(shell.id) || shellIDs[shell.id] ||
            ['running', 'exited', 'timeout', 'killed'].indexOf(shell.status) === -1 || typeof shell.command !== 'string' || shell.command.length > 65536 || !validUnicodeString(shell.command) ||
            typeof shell.cwd !== 'string' || !validUnicodeString(shell.cwd) || !isPlainObject(shell.time) || typeof shell.time.started !== 'number' ||
            !Number.isFinite(shell.time.started) || shell.time.started < 0 ||
            shell.time.completed !== undefined && (typeof shell.time.completed !== 'number' || !Number.isFinite(shell.time.completed) || shell.time.completed < 0) ||
            shell.exit !== undefined && (typeof shell.exit !== 'number' || !Number.isFinite(shell.exit))) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid shell data.');
        shellIDs[shell.id] = true;
      });
      return { validUntilMs: now() + 20000, instances: shells.filter(function (shell) { return shell && shell.status === 'running'; }).map(function (shell) {
        var props = {
          name: { shortText: { text: unicodePrefix(boundedDisplayText(shell.command, 4096), 7) }, longText: { text: boundedDisplayText(shell.command, 4096) } }, shell_id: { longText: { text: shell.id } },
          command: { longText: { text: boundedDisplayText(shell.command, 4096) } }, directory: { longText: { text: directory } }, cwd: { longText: { text: boundedDisplayText(shell.cwd, 4096) } },
          status: { shortText: { text: 'Running' }, longText: { text: shell.status } }, started: { timestamp: { value: Math.floor(shell.time.started / 1000) } },
          duration: { numericValue: { value: Math.max(0, (now() - shell.time.started) / 1000), min: 0, unit: 's' }, shortText: { text: String(Math.max(0, (now() - shell.time.started) / 1000)) } }
        };
        if (typeof shell.time.completed === 'number') props.completed = { timestamp: { value: Math.floor(shell.time.completed / 1000) } };
        if (typeof shell.exit === 'number') props.exit = { numericValue: { value: shell.exit } };
        return { instanceId: shell.id, properties: props };
      }) };
    }

    async function commandInstances(state) {
      var id = focusedSessionID(state);
      var session = id ? await getSession(state, id) : null;
      var directory = scopedLocation(state, session);
      var response;
      try { response = await api(state, '/command' + locationQuery(directory)); }
      catch (err) { if (err && (err.httpStatus === 404 || err.httpStatus === 405)) throw makeError('PLUGIN_UNAVAILABLE', 'Command source is not supported by this OpenCode server.'); throw err; }
      var commands = validateCommandList(response, directory);
      return { validUntilMs: now() + 300000, instances: commands.map(function (command) {
        var displayName = boundedDisplayText(command.name, 200);
        var props = { name: { shortText: { text: unicodePrefix(displayName, 7) }, longText: { text: displayName } }, command: { longText: { text: displayName } }, directory: { longText: { text: directory } } };
        if (command.description) props.description = { longText: { text: boundedDisplayText(command.description, 4096) } };
        if (id) props.session_id = { longText: { text: id } };
        return { instanceId: command.name, properties: props };
      }) };
    }

    async function inboxAction(state, args, changeDelivery) {
      var allowed = changeDelivery ? ['session_id', 'inbox_id', 'delivery'] : ['session_id', 'inbox_id'];
      if (!isPlainObject(args) || Object.keys(args).length !== allowed.length || Object.keys(args).some(function (key) { return allowed.indexOf(key) === -1; }) ||
          !sessionID(args.session_id) || !/^msg_[A-Za-z0-9_-]{1,196}$/.test(args.inbox_id) || args.inbox_id === '.' || args.inbox_id === '..' ||
          changeDelivery && !validDelivery(args.delivery)) {
        throw makeError('INVALID_ARGS', 'Invalid queued message request.');
      }
      var session = await getSession(state, args.session_id);
      if (archived(session)) throw makeError('INVALID_ARGS', 'Archived sessions cannot change queued messages.');
      var response;
      try { response = await api(state, sessionPath(session.id) + '/inbox'); }
      catch (err) { if (err && err.httpStatus === 404) throw makeError('INVALID_ARGS', 'Queued message not found or already settled. Refresh first.'); throw err; }
      if (!response || !Array.isArray(response.data)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid inbox data.');
      var found = validateInboxList(response.data, session.id).filter(function (item) { return item.id === args.inbox_id; });
      if (found.length !== 1) throw makeError('INVALID_ARGS', 'Queued message not found or already settled. Refresh first.');
      var route = sessionPath(session.id) + '/inbox/' + encodeURIComponent(args.inbox_id);
      await invalidateBeforeMutation(state);
      try {
        if (changeDelivery) await api(state, route, 'PATCH', { delivery: args.delivery }, 204);
        else await api(state, route, 'DELETE', undefined, 204);
      } catch (err) {
        if (err && (err.httpStatus === 404 || err.httpStatus === 409)) throw makeError('INVALID_ARGS', 'Queued message changed or already settled. Refresh first.');
        if (err && (err.code === 'PERMISSION_DENIED' || err.code === 'AUTH_REQUIRED' || err.code === 'RATE_LIMITED')) throw err;
        if (err && err.httpStatus && err.httpStatus < 500) throw err;
        throw makeError('PLUGIN_UNAVAILABLE', 'Queued message change outcome uncertain. Inspect OpenCode before retrying.');
      }
      await invalidateAfterMutation(state);
      return { text: changeDelivery ? 'Queued message delivery updated.' : 'Queued message cancelled.', refreshed: ['opencode/queue', 'opencode/execution', 'opencode/shell', 'opencode/active_session', 'opencode/activity', 'opencode/reply', 'opencode/replies', 'opencode/chat_status', 'opencode/permission', 'opencode/question'] };
    }

    async function stopShellAction(state, args) {
      if (!isPlainObject(args) || Object.keys(args).length !== 2 || !/^sh_[A-Za-z0-9_-]{1,197}$/.test(args.shell_id) || !directoryPath(args.directory)) throw makeError('INVALID_ARGS', 'Invalid shell request.');
      var focusID = focusedSessionID(state);
      var focused = focusID ? await getSession(state, focusID) : null;
      var expected = scopedLocation(state, focused);
      if (args.directory !== expected) throw makeError('INVALID_ARGS', 'Shell location does not match current session location.');
      var route = '/shell/' + encodeURIComponent(args.shell_id) + locationQuery(expected);
      var response;
      try { response = await api(state, route); }
      catch (err) { if (err && err.httpStatus === 404) throw makeError('INVALID_ARGS', 'Shell not found in this location.'); throw err; }
      if (!isPlainObject(response) || !isPlainObject(response.location) || response.location.directory !== expected || !isPlainObject(response.data) ||
          response.data.id !== args.shell_id || !['running', 'exited', 'timeout', 'killed'].includes(response.data.status)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid shell data.');
      if (response.data.status !== 'running') throw makeError('INVALID_ARGS', 'Shell is no longer running.');
      await invalidateBeforeMutation(state);
      try { await api(state, route, 'DELETE', undefined, 204); }
      catch (err) {
        if (err && err.httpStatus === 404) throw makeError('INVALID_ARGS', 'Shell already stopped or removed.');
        if (err && (err.code === 'PERMISSION_DENIED' || err.code === 'AUTH_REQUIRED' || err.code === 'RATE_LIMITED')) throw err;
        if (err && err.httpStatus && err.httpStatus < 500) throw err;
        throw makeError('PLUGIN_UNAVAILABLE', 'Shell stop outcome uncertain. Inspect OpenCode before retrying.');
      }
      await invalidateAfterMutation(state);
      return { text: 'Shell stopped and removed. Removing shell also removes retained output.', refreshed: ['opencode/shell', 'opencode/execution', 'opencode/active_session', 'opencode/activity'] };
    }

    async function runCommandAction(state, args) {
      if (!isPlainObject(args) || Object.keys(args).some(function (key) { return ['session_id', 'command', 'text', 'delivery'].indexOf(key) === -1; }) ||
          !sessionID(args.session_id) || !validCommandName(args.command) ||
          args.text !== undefined && (typeof args.text !== 'string' || args.text.length > 16000 || !validUnicodeString(args.text) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(args.text)) ||
          args.delivery !== undefined && !validDelivery(args.delivery)) throw makeError('INVALID_ARGS', 'Invalid command request.');
      var session = await getSession(state, args.session_id);
      if (archived(session)) throw makeError('INVALID_ARGS', 'Archived sessions cannot run commands.');
      var directory = session.location.directory;
      if (!directoryPath(directory)) throw makeError('INVALID_ARGS', 'Session location is invalid.');
      var response;
      try { response = await api(state, '/command' + locationQuery(directory)); }
      catch (err) { if (err && (err.httpStatus === 404 || err.httpStatus === 405)) throw makeError('PLUGIN_UNAVAILABLE', 'Commands are not supported by this OpenCode server.'); throw err; }
      var commands = validateCommandList(response, directory);
      var match = commands.filter(function (command) { return isPlainObject(command) && command.name === args.command; });
      if (match.length !== 1) throw makeError('INVALID_ARGS', 'Command is no longer available in this session location.');
      await invalidateBeforeMutation(state);
      try {
        await api(state, sessionPath(session.id) + '/command', 'POST', {
          name: args.command, text: args.text === undefined ? '' : args.text,
          delivery: args.delivery === undefined ? state.default_delivery : args.delivery
        }, 204);
      } catch (err) {
        if (err && err.httpStatus === 404) throw makeError('INVALID_ARGS', 'Session or command was not found.');
        if (err && (err.code === 'PERMISSION_DENIED' || err.code === 'AUTH_REQUIRED' || err.code === 'RATE_LIMITED')) throw err;
        if (err && err.httpStatus && err.httpStatus < 500) throw err;
        throw makeError('PLUGIN_UNAVAILABLE', 'Command outcome uncertain. Inspect OpenCode before retrying.');
      }
      await invalidateAfterMutation(state);
      return { text: 'Command invocation sent to OpenCode.', refreshed: ['opencode/execution', 'opencode/queue', 'opencode/shell', 'opencode/active_session', 'opencode/activity', 'opencode/reply', 'opencode/replies', 'opencode/chat_status', 'opencode/permission', 'opencode/question'] };
    }

    function validForm(form, id) {
      if (!isPlainObject(form) || !nonemptyID(form.id) || form.sessionID !== id || typeof form.title !== 'string' ||
          !Array.isArray(form.fields) || form.fields.length < 1 || form.fields.length > 50) {
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid question data.');
      }
      var keys = Object.create(null);
      var external = false;
      var hiddenRequired = false;
      function invalidFields() { throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid question fields.'); }
      function integerBound(value) { return Number.isInteger(value) && value >= 0; }
      function numericBound(value) {
        return typeof value === 'number' && Number.isFinite(value) || value === 'Infinity' || value === '-Infinity';
      }
      function numericValue(value) {
        return typeof value === 'number' && Number.isFinite(value) || value === 'Infinity' || value === '-Infinity';
      }
      function boundNumber(value) { return value === 'Infinity' ? Infinity : value === '-Infinity' ? -Infinity : value; }
      form.fields.forEach(function (field) {
        if (!isPlainObject(field) || !nonemptyID(field.key) || ['__proto__', 'prototype', 'constructor'].indexOf(field.key) !== -1 || keys[field.key] ||
            ['string', 'number', 'integer', 'boolean', 'multiselect', 'external'].indexOf(field.type) === -1 ||
            (field.required !== undefined && typeof field.required !== 'boolean') || (field.hidden !== undefined && typeof field.hidden !== 'boolean') ||
            (field.custom !== undefined && typeof field.custom !== 'boolean') ||
            (field.title !== undefined && typeof field.title !== 'string') || (field.description !== undefined && typeof field.description !== 'string')) invalidFields();
        keys[field.key] = true;
        if (field.type === 'external') {
          external = true;
          if (typeof field.url !== 'string' || !field.url) invalidFields();
        }
        if (field.hidden && field.required) hiddenRequired = true;
        if (field.options !== undefined) {
          if (!Array.isArray(field.options)) invalidFields();
          var optionValues = Object.create(null);
          field.options.forEach(function (option) {
            if (!isPlainObject(option) || typeof option.value !== 'string' || typeof option.label !== 'string' || optionValues[option.value]) invalidFields();
            optionValues[option.value] = true;
          });
        }
        if (field.type === 'multiselect' && !Array.isArray(field.options)) invalidFields();
        if (field.when !== undefined) {
          if (!Array.isArray(field.when)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid question conditions.');
          field.when.forEach(function (when) {
            if (!isPlainObject(when) || !nonemptyID(when.key) || ['__proto__', 'prototype', 'constructor'].indexOf(when.key) !== -1 ||
                ['eq', 'neq'].indexOf(when.op) === -1 ||
                !(typeof when.value === 'string' || typeof when.value === 'number' && Number.isFinite(when.value) || typeof when.value === 'boolean')) {
              throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid question conditions.');
            }
          });
        }
        if (field.type === 'string') {
          if ((field.minLength !== undefined && !integerBound(field.minLength)) || (field.maxLength !== undefined && !integerBound(field.maxLength)) ||
              (field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength) ||
              (field.default !== undefined && typeof field.default !== 'string')) invalidFields();
        } else if (field.type === 'number' || field.type === 'integer') {
          if ((field.minimum !== undefined && !numericBound(field.minimum)) || (field.maximum !== undefined && !numericBound(field.maximum)) ||
              (field.minimum !== undefined && field.maximum !== undefined && boundNumber(field.minimum) > boundNumber(field.maximum)) ||
              (field.default !== undefined && !numericValue(field.default))) invalidFields();
        } else if (field.type === 'boolean') {
          if (field.default !== undefined && typeof field.default !== 'boolean') invalidFields();
        } else if (field.type === 'multiselect') {
          if ((field.minItems !== undefined && !integerBound(field.minItems)) || (field.maxItems !== undefined && !integerBound(field.maxItems)) ||
              (field.minItems !== undefined && field.maxItems !== undefined && field.minItems > field.maxItems) ||
              (field.default !== undefined && (!Array.isArray(field.default) || !field.default.every(function (value) { return typeof value === 'string'; })))) invalidFields();
        } else if (field.default !== undefined) invalidFields();
      });
      form.fields.forEach(function (field) {
        if (field.when && field.when.some(function (when) { return !keys[when.key]; })) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid question conditions.');
      });
      return { form: form, external: external, hiddenRequired: hiddenRequired };
    }

    async function questionInstances(state) {
      var response = await api(state, '/session/active');
      var active = response && response.data;
      if (!isPlainObject(active) || Object.keys(active).length > 100) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid active session data.');
      var ids = Object.keys(active);
      ids.forEach(function (id) {
        if (!sessionID(id) || !isPlainObject(active[id]) || active[id].type !== 'running') throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid active session data.');
      });
      var focus = state.mode === 'default_chat' && state.selected && sessionID(state.selected.session_id) ? state.selected.session_id : state.lastSessionID;
      if (sessionID(focus) && ids.indexOf(focus) === -1) ids.push(focus);
      var limit = createLimiter(4);
      var total = 0;
      var result;
      try {
        result = await Promise.all(ids.map(function (id) {
          return limit(async function () {
            var formsResponse = await api(state, sessionPath(id) + '/form');
            if (!formsResponse || !Array.isArray(formsResponse.data)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid question data.');
            total += formsResponse.data.length;
            if (total > 200) throw makeError('PLUGIN_UNAVAILABLE', 'Too many questions to inspect safely.');
            return formsResponse.data.map(function (form) { return validForm(form, id); });
          });
        }));
      } catch (err) { limit.stop(err); throw err; }
      var forms = [];
      var formIDs = Object.create(null);
      result.forEach(function (list) {
        list.forEach(function (item) {
          var key = item.form.sessionID + '\u0000' + item.form.id;
          if (formIDs[key]) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned duplicate questions.');
          formIDs[key] = true;
          forms.push(item);
        });
      });
      forms.sort(function (a, b) { return a.form.sessionID < b.form.sessionID ? -1 : a.form.sessionID > b.form.sessionID ? 1 : a.form.id < b.form.id ? -1 : a.form.id > b.form.id ? 1 : 0; });
      return forms.map(function (item) {
        var f = item.form;
        var fields = JSON.stringify(f.fields);
        if (fields.length > 16000) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode question fields exceed safe display size.');
        return { instanceId: f.sessionID + ':' + f.id, properties: {
          name: { shortText: { text: unicodePrefix(f.title, 7) }, longText: { text: f.title } },
          session_id: { longText: { text: f.sessionID } }, form_id: { longText: { text: f.id } },
          question: { longText: { text: f.title } }, fields: { longText: { text: fields } },
          answerable: { boolean: { value: !item.external && !item.hiddenRequired } }, url: { longText: { text: sessionURL(state.url, f.sessionID) } }
        }};
      });
    }

    function activityInstance(checkedAt, connected, snapshot, failure) {
      var properties = {
        name: { shortText: { text: 'OpenCode' }, longText: { text: 'OpenCode' } },
        connected: { boolean: { value: connected } },
        checked_at: { timestamp: { value: checkedAt } }
      };
      if (failure) {
        var summary = failure === 'setup' ? ['Setup', 'Connect to an OpenCode server'] :
          failure === 'auth' ? ['Sign in', 'OpenCode authentication required'] :
          failure === 'permission' ? ['Blocked', 'OpenCode network access denied'] :
          ['Unknown', 'Activity unavailable'];
        properties.summary = { shortText: { text: summary[0] }, longText: { text: summary[1] } };
      } else {
        var activeCount = snapshot.roots.length;
        var attentionCount = snapshot.attentionRoots.length;
        var shortSummary = activeCount === 0 ? 'Idle' : String(activeCount) + ' act';
        var longSummary = activeCount === 0 ? 'No active sessions' :
          String(activeCount) + ' active' + (attentionCount ? ', ' + String(attentionCount) + ' needs attention' : '');
        properties.active_count = { numericValue: { value: activeCount, min: 0 }, shortText: { text: String(activeCount) } };
        properties.attention_count = { numericValue: { value: attentionCount, min: 0 }, shortText: { text: String(attentionCount) } };
        properties.summary = { shortText: { text: unicodePrefix(shortSummary, 7) }, longText: { text: longSummary } };
      }
      return { instanceId: 'opencode', properties: properties };
    }

    function directoryPath(value) {
      return typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f\u007f-\u009f]/.test(value) &&
        (/^\/(?:[^\u0000-\u001f\u007f]*)$/.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value));
    }

    async function config(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw makeError('INVALID_REQUEST', 'Invalid configuration request.');
      var state = await load();
      var type = input.type;
      if (type === 'status' || type === undefined) {
        syncReplyAlertsEnabled(!!state.reply_alerts);
        return status(state);
      }

      if (type === 'connect') {
        var url = cleanURL(input.url);
        var username = typeof input.username === 'string' && input.username.trim() ? input.username.trim() : DEFAULT_USERNAME;
        if (/[\u0000-\u001f\u007f:]/.test(username)) throw makeError('INVALID_ARGS', 'Username must not contain colons or control characters.');
        if (typeof input.password !== 'string' || !input.password) throw makeError('INVALID_ARGS', 'Password is required.');
        var candidate = Object.assign({}, state, { url: url, username: username, password: input.password, auth_method: 'password' });
        var info = await api(candidate, '/info');
        var version = info && info.version;
        if (typeof version !== 'string' || !/^2\./.test(version)) throw makeError('INVALID_ARGS', 'OpenCode V2 server required.');
        if (state.url !== url || state.username !== username) {
          candidate.directory = '';
          candidate.selected = null;
          candidate.lastSessionID = null;
          candidate.nicknames = {};
          candidate.last_seen = {};
          candidate.mode = 'default_chat';
        }
        candidate.version = version;
        await invalidateSnapshotCache(candidate);
        await save(candidate);
        if (state.url !== url || state.username !== username) await clearReplyAlertState();
        else clearReplyLaunchRoutes();
        refresh();
        return status(candidate);
      }

      if (type === 'pair') {
        if (typeof input.link !== 'string' || !input.link.trim()) throw makeError('INVALID_ARGS', 'Enter an OpenCode pairing link.');
        var paired = await redeemPairingLink(input.link.trim());
        var pairCandidate = Object.assign({}, state, {
          url: paired.origin, username: DEFAULT_USERNAME, password: paired.token, auth_method: 'pair'
        });
        var pairInfo;
        try { pairInfo = await api(pairCandidate, '/info'); }
        catch (pairError) {
          if (pairError && pairError.code === 'AUTH_REQUIRED') {
            throw makeError('INVALID_ARGS', 'Pairing token was rejected by the server.');
          }
          throw pairError;
        }
        var pairVersion = pairInfo && pairInfo.version;
        if (typeof pairVersion !== 'string' || !/^2\./.test(pairVersion)) throw makeError('INVALID_ARGS', 'OpenCode V2 server required.');
        if (state.url !== paired.origin || state.username !== DEFAULT_USERNAME) {
          pairCandidate.directory = '';
          pairCandidate.selected = null;
          pairCandidate.lastSessionID = null;
          pairCandidate.nicknames = {};
          pairCandidate.last_seen = {};
          pairCandidate.mode = 'default_chat';
        }
        pairCandidate.version = pairVersion;
        await invalidateSnapshotCache(pairCandidate);
        await save(pairCandidate);
        if (state.url !== paired.origin || state.username !== DEFAULT_USERNAME) await clearReplyAlertState();
        else clearReplyLaunchRoutes();
        refresh();
        return status(pairCandidate);
      }

      if (type === 'disconnect') {
        try { await storage.removeItem(STATE_KEY); await storage.removeItem(SNAPSHOT_CACHE_KEY); await storage.removeItem(LEGACY_CACHE_META_KEY); }
        catch (_) { throw makeError('PLUGIN_UNAVAILABLE', 'Secure storage is unavailable.'); }
        await clearReplyAlertState();
        syncReplyAlertsEnabled(false);
        refresh();
        return status(emptyState());
      }

      if (type === 'test') {
        requireConnection(state);
        var tested = await api(state, '/info');
        var testedVersion = tested && tested.version;
        if (typeof testedVersion !== 'string' || !/^2\./.test(testedVersion)) throw makeError('INVALID_ARGS', 'OpenCode V2 server required.');
        if (testedVersion !== state.version) await invalidateSnapshotCache(state);
        state.version = testedVersion;
        await save(state);
        return status(state);
      }

      if (type === 'list') {
        requireConnection(state);
        var list = await chatRows(state, input.cursor);
        return { sessions: list.sessions, next_cursor: list.next_cursor };
      }

      if (type === 'projects') {
        requireConnection(state);
        var projectResponse = await api(state, '/project');
        if (!Array.isArray(projectResponse)) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid projects.');
        return { projects: projectResponse.map(function (project) {
          if (!project || typeof project.id !== 'string' || typeof project.canonical !== 'string') {
            throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid projects.');
          }
          return { id: project.id, name: typeof project.name === 'string' ? project.name : project.canonical, directory: project.canonical };
        }) };
      }

      if (type === 'mode') {
        if (input.mode !== 'default_chat' && input.mode !== 'new_chat') throw makeError('INVALID_ARGS', 'Invalid mode.');
        state.mode = input.mode;
        await invalidateSnapshotCache(state);
        await save(state);
        refresh(['agent/configured', 'opencode/reply', 'opencode/replies', 'opencode/chat_status', 'opencode/question', 'opencode/execution', 'opencode/queue', 'opencode/shell', 'opencode/command']);
        return status(state);
      }

      if (type === 'reply_count') {
        if (!Number.isInteger(input.count) || input.count < 1 || input.count > MAX_REPLY_COUNT) {
          throw makeError('INVALID_ARGS', 'Reply session count must be a whole number from 1 to 20.');
        }
        state.reply_count = input.count;
        await invalidateSnapshotCache(state);
        await save(state);
        refresh(['opencode/replies', 'opencode/chat_status']);
        return status(state);
      }

      if (type === 'default_delivery') {
        if (!validDelivery(input.delivery)) throw makeError('INVALID_ARGS', 'Delivery must be queue or steer.');
        state.default_delivery = input.delivery;
        await save(state);
        return status(state);
      }

      if (type === 'reply_alerts') {
        if (typeof input.enabled !== 'boolean') throw makeError('INVALID_ARGS', 'Reply notification setting must be on or off.');
        if (input.enabled && !notificationsSupported()) {
          throw makeError('PLUGIN_UNAVAILABLE', 'Notifications are not supported on this device.');
        }
        var replyAlertsChanged = state.reply_alerts !== input.enabled;
        if (replyAlertsChanged) {
          state.reply_alerts = input.enabled;
          await save(state);
          if (input.enabled) clearReplyLaunchRoutes();
          else await clearReplyAlertState();
        }
        syncReplyAlertsEnabled(input.enabled);
        return status(state);
      }

      if (type === 'directory') {
        if (!directoryPath(input.directory)) throw makeError('INVALID_ARGS', 'Directory must be an absolute server path.');
        state.directory = input.directory;
        await invalidateSnapshotCache(state);
        await save(state);
        refresh(['agent/configured', 'agent/chats', 'opencode/shell', 'opencode/command']);
        return status(state);
      }

      if (type === 'select') {
        requireConnection(state);
        if (!sessionID(input.session_id)) throw makeError('INVALID_ARGS', 'Invalid session ID.');
        var selected = await getSession(state, input.session_id);
        if (archived(selected)) throw makeError('INVALID_ARGS', 'Archived sessions cannot be selected.');
        state.selected = { session_id: selected.id, title: titleOf(selected) };
        state.mode = 'default_chat';
        await invalidateSnapshotCache(state);
        await save(state);
        refresh(['agent/configured', 'opencode/reply', 'opencode/replies', 'opencode/chat_status', 'opencode/question', 'opencode/execution', 'opencode/queue', 'opencode/shell', 'opencode/command']);
        return status(state);
      }

      if (type === 'save_session') {
        requireConnection(state);
        if (!sessionID(input.session_id) || typeof input.nickname !== 'string') throw makeError('INVALID_ARGS', 'Invalid session nickname.');
        var namedSession = await getSession(state, input.session_id);
        if (archived(namedSession)) throw makeError('INVALID_ARGS', 'Archived sessions cannot be saved.');
        var nickname = input.nickname.trim();
        if (nickname.length > 40 || /^(new|new chat)$/i.test(nickname)) throw makeError('INVALID_ARGS', 'Nickname is reserved or too long.');
        Object.keys(state.nicknames).forEach(function (id) {
          if (id !== input.session_id && nickname && state.nicknames[id].toLowerCase() === nickname.toLowerCase()) {
            throw makeError('INVALID_ARGS', 'Nickname already in use.');
          }
        });
        if (nickname) state.nicknames[input.session_id] = nickname;
        else delete state.nicknames[input.session_id];
        await invalidateSnapshotCache(state);
        await save(state);
        refresh(['agent/chats', 'agent/configured', 'opencode/active_session', 'opencode/reply', 'opencode/replies', 'opencode/chat_status', 'opencode/permission', 'opencode/question', 'opencode/execution', 'opencode/queue']);
        return status(state);
      }

      throw makeError('INVALID_REQUEST', 'Unsupported configuration request.');
    }

    async function source(input) {
      if (!input || typeof input.category !== 'string' || typeof input.item !== 'string') {
        throw makeError('INVALID_REQUEST', 'Unsupported source request.');
      }
      var state = await sourceCacheState(await load());
      if (input.category === 'agent' && input.item === 'configured') {
        var name = state.mode === 'new_chat' ? DEFAULT_TITLE :
          (state.selected ? (state.nicknames[state.selected.session_id] || state.selected.title) : DEFAULT_TITLE);
        var ready = configured(state);
        return { validUntilMs: now() + 60000, instances: [{ instanceId: 'opencode', properties: {
          name: { shortText: { text: name || DEFAULT_TITLE } },
          configured: { boolean: { value: ready }, shortText: { text: ready ? 'Configured' : 'Not configured' } }
        } }] };
      }
      if (input.category === 'agent' && input.item === 'chats') {
        requireConnection(state);
        var page = await chatRows(state, input.cursor);
        var chatInstances = page.sessions.map(function (session) {
          return { instanceId: session.session_id, properties: {
            name: { shortText: { text: session.nickname || session.title } },
            title: { shortText: { text: session.title } },
            url: { longText: { text: session.url } }
          } };
        });
        if (directoryPath(state.directory)) {
          chatInstances.push({ instanceId: 'new', properties: {
            name: { shortText: { text: 'New' } },
            title: { shortText: { text: 'New session' } }
          } });
        }
        return {
          validUntilMs: now() + 900000,
          instances: chatInstances
        };
      }
      if (input.category === 'opencode' && input.item === 'active_session') {
        var active = await activeSnapshot(state);
        return {
          validUntilMs: now() + 20000,
          instances: active.sessions.map(function (detail) { return activeInstance(state, detail); })
        };
      }
      if (input.category === 'opencode' && input.item === 'activity') {
        var checkedAt = Math.floor(now() / 1000);
        var connected = false;
        var summary;
        if (!state.url || !state.username || !state.password || !/^2\./.test(state.version)) {
          summary = 'setup';
        } else {
          try {
            var activity = await activeSnapshot(state, function () { connected = true; });
            return {
              validUntilMs: now() + 20000,
              instances: [activityInstance(checkedAt, true, activity, null)]
            };
          } catch (activityError) {
            if (activityError && activityError.code === 'AUTH_REQUIRED') summary = 'auth';
            else if (activityError && activityError.code === 'PERMISSION_DENIED') summary = 'permission';
            else summary = 'unavailable';
          }
        }
        return {
          validUntilMs: now() + 20000,
          instances: [activityInstance(checkedAt, connected, null, summary)]
        };
      }
      if (input.category === 'opencode' && input.item === 'reply') {
        requireConnection(state);
        var replyID = state.mode === 'default_chat' && state.selected && sessionID(state.selected.session_id) ? state.selected.session_id :
          (sessionID(state.lastSessionID) ? state.lastSessionID : null);
        return { validUntilMs: now() + 20000, instances: replyID ? await replyInstances(state, replyID) : [] };
      }
      if (input.category === 'opencode' && input.item === 'replies') {
        requireConnection(state);
        return await repliesInstances(state);
      }
      if (input.category === 'opencode' && input.item === 'chat_status') {
        requireConnection(state);
        return await chatStatusInstances(state);
      }
      if (input.category === 'opencode' && input.item === 'permission') {
        requireConnection(state);
        return await permissionInstances(state);
      }
      if (input.category === 'opencode' && input.item === 'usage') {
        requireConnection(state);
        return { validUntilMs: now() + 60000, instances: await goUsageInstances(state) };
      }
      if (input.category === 'opencode' && input.item === 'job') {
        requireConnection(state);
        return { validUntilMs: now() + 20000, instances: await jobInstances(state) };
      }
      if (input.category === 'opencode' && input.item === 'execution') {
        requireConnection(state);
        return await executionInstances(state);
      }
      if (input.category === 'opencode' && input.item === 'queue') {
        requireConnection(state);
        return await queueInstances(state);
      }
      if (input.category === 'opencode' && input.item === 'shell') {
        requireConnection(state);
        return await shellInstances(state);
      }
      if (input.category === 'opencode' && input.item === 'command') {
        requireConnection(state);
        return await commandInstances(state);
      }
      if (input.category === 'opencode' && input.item === 'question') {
        requireConnection(state);
        return { validUntilMs: now() + 20000, instances: await questionInstances(state) };
      }
      throw makeError('INVALID_REQUEST', 'Unsupported source request.');
    }

    function makeMessageID() {
      var bytes;
      try {
        if (root.crypto && typeof root.crypto.getRandomValues === 'function') {
          bytes = new Uint8Array(16);
          root.crypto.getRandomValues(bytes);
          var hex = '';
          for (var i = 0; i < bytes.length; i += 1) hex += ('0' + bytes[i].toString(16)).slice(-2);
          return 'msg_' + hex;
        }
      } catch (_) {}
      requestCounter += 1;
      var fallback = String(now()) + '_' + String(random ? random() : Math.random().toString(36).slice(2)) + '_' + requestCounter;
      return 'msg_' + fallback.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);
    }

    function validReceipt(message, id, text, delivery) {
      return !!(message && message.id === id && message.sessionID === text.sessionID &&
        message.type === 'user' && message.payload && message.payload.text === text.text &&
        (delivery === undefined || message.delivery === delivery));
    }

    function receiptShape(message, id, text) {
      return !!(message && message.id === id && message.sessionID === text.sessionID &&
        message.type === 'user' && message.payload && message.payload.text === text.text);
    }

    async function verifyDelivery(state, sessionId, messageId, text, delivery) {
      try {
        var direct = await api(state, sessionPath(sessionId) + '/message/' + encodeURIComponent(messageId));
        var directMessage = direct && direct.data;
        if (directMessage && directMessage.id === messageId && directMessage.type === 'user' && directMessage.text === text &&
            (directMessage.delivery === undefined || directMessage.delivery === delivery)) return true;
      } catch (_) {}
      try {
        var inbox = await api(state, sessionPath(sessionId) + '/inbox');
        var messages = inbox && inbox.data;
        if (Array.isArray(messages)) {
          for (var i = 0; i < messages.length; i += 1) {
            if (validReceipt(messages[i], messageId, { sessionID: sessionId, text: text }, delivery)) return true;
          }
        }
      } catch (_) {}
      return false;
    }

    async function approvePermissionAction(state, args) {
      if (!isPlainObject(args)) throw makeError('INVALID_ARGS', 'Invalid permission response.');
      Object.keys(args).forEach(function (key) {
        if (key !== 'session_id' && key !== 'request_id' && key !== 'decision' && key !== 'message') {
          throw makeError('INVALID_ARGS', 'Unexpected action argument.');
        }
      });
      if (!sessionID(args.session_id) || !nonemptyID(args.request_id)) throw makeError('INVALID_ARGS', 'Invalid permission request.');
      var decision = args.decision === undefined ? 'once' : args.decision;
      if (decision !== 'once' && decision !== 'reject') throw makeError('INVALID_ARGS', 'Decision must be once or reject.');
      if (args.message !== undefined && (typeof args.message !== 'string' || args.message.length > 2000)) {
        throw makeError('INVALID_ARGS', 'Permission message is invalid.');
      }
      var session = await getSession(state, args.session_id);
      if (archived(session)) throw makeError('INVALID_ARGS', 'Archived sessions cannot receive permission responses.');
      var detail;
      try { detail = await api(state, sessionPath(args.session_id) + '/permission/' + encodeURIComponent(args.request_id)); }
      catch (err) {
        if (err && err.httpStatus === 404) throw makeError('INVALID_ARGS', 'Permission request not found or already settled. Refresh first.');
        throw err;
      }
      var request = validPermissionRequest(detail && detail.data);
      if (request.id !== args.request_id || request.sessionID !== args.session_id) {
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned a different permission request.');
      }
      var body = { decision: decision };
      if (args.message) body.message = args.message;
      await invalidateBeforeMutation(state);
      try {
        await api(state, sessionPath(args.session_id) + '/permission/' + encodeURIComponent(args.request_id) + '/reply', 'POST', body, 204);
      } catch (err) {
        if (err && err.httpStatus === 400) throw makeError('INVALID_ARGS', 'OpenCode rejected the permission response.');
        if (err && err.httpStatus === 404) throw makeError('INVALID_ARGS', 'Permission request not found or already settled. Refresh first.');
        if (err && err.httpStatus === 409) throw makeError('INVALID_ARGS', 'Permission request already settled. Refresh first.');
        if (err && (err.code === 'PERMISSION_DENIED' || err.code === 'AUTH_REQUIRED' || err.code === 'RATE_LIMITED')) throw err;
        if (err && err.httpStatus && err.httpStatus < 500) throw err;
        throw makeError('PLUGIN_UNAVAILABLE', 'Permission response uncertain. Inspect OpenCode before retrying.');
      }
      await invalidateAfterMutation(state);
      return {
        text: (decision === 'once' ? 'Permission approved: ' : 'Permission rejected: ') + request.action,
        refreshed: permissionRefreshes
      };
    }

    async function markChatReadAction(state, args) {
      if (!isPlainObject(args)) throw makeError('INVALID_ARGS', 'Invalid read request.');
      Object.keys(args).forEach(function (key) {
        if (key !== 'session_id' && key !== 'message_id') throw makeError('INVALID_ARGS', 'Unexpected action argument.');
      });
      if (!sessionID(args.session_id)) throw makeError('INVALID_ARGS', 'Invalid session ID.');
      if (args.message_id !== undefined && !nonemptyID(args.message_id)) throw makeError('INVALID_ARGS', 'Invalid message ID.');
      var session = await getSession(state, args.session_id);
      var messageID = args.message_id;
      if (!messageID) {
        var reply = await latestAssistantReply(state, session.id);
        if (!reply) return { text: 'Chat has no reply to mark read: ' + titleOf(session), refreshed: ['opencode/chat_status'] };
        messageID = reply.message.id;
      }
      var fresh = await load();
      if (!fresh.last_seen || typeof fresh.last_seen !== 'object' || Array.isArray(fresh.last_seen)) fresh.last_seen = {};
      fresh.last_seen[session.id] = messageID;
      await save(fresh);
      return { text: 'Chat marked read: ' + titleOf(session), refreshed: ['opencode/chat_status'] };
    }

    async function interruptAction(state, args) {
      if (!isPlainObject(args) || Object.keys(args).length !== 1 || !sessionID(args.session_id)) throw makeError('INVALID_ARGS', 'Invalid session ID.');
      var session = await getSession(state, args.session_id);
      if (archived(session)) throw makeError('INVALID_ARGS', 'Archived sessions cannot be interrupted.');
      var response;
      await invalidateBeforeMutation(state);
      try { response = await api(state, sessionPath(session.id) + '/interrupt?resume=false', 'POST'); }
      catch (err) {
        if (err && (err.code === 'PERMISSION_DENIED' || err.code === 'AUTH_REQUIRED' || err.code === 'RATE_LIMITED')) throw err;
        if (err && err.httpStatus && err.httpStatus < 500) throw err;
        throw makeError('PLUGIN_UNAVAILABLE', 'Interrupt outcome uncertain. Inspect OpenCode before retrying.');
      }
      if (!response || typeof response.interrupted !== 'boolean') throw makeError('PLUGIN_UNAVAILABLE', 'Interrupt outcome uncertain. Inspect OpenCode before retrying.');
      await invalidateAfterMutation(state);
      return { text: response.interrupted ? 'Interrupted OpenCode session: ' + titleOf(session) : 'OpenCode session is already idle: ' + titleOf(session), refreshed: interruptRefreshes };
    }

    function answerValue(value) {
      return typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ||
        Array.isArray(value) && value.every(function (entry) { return typeof entry === 'string'; });
    }

    function validateAnswerShape(answer) {
      if (!isPlainObject(answer) || Object.keys(answer).length > 50) throw makeError('INVALID_ARGS', 'Answer must be an object with at most 50 fields.');
      Object.keys(answer).forEach(function (key) {
        if (!nonemptyID(key) || ['__proto__', 'prototype', 'constructor'].indexOf(key) !== -1 || !answerValue(answer[key])) {
          throw makeError('INVALID_ARGS', 'Answer contains an invalid field.');
        }
      });
      var serialized;
      try { serialized = JSON.stringify(answer); } catch (_) { throw makeError('INVALID_ARGS', 'Answer is invalid.'); }
      if (!serialized || serialized.length > 16000) throw makeError('INVALID_ARGS', 'Answer exceeds safe size.');
    }

    function validateAnswer(form, answer) {
      validateAnswerShape(answer);
      var fields = Object.create(null);
      form.fields.forEach(function (field) { fields[field.key] = field; });
      Object.keys(answer).forEach(function (key) {
        if (!nonemptyID(key) || ['__proto__', 'prototype', 'constructor'].indexOf(key) !== -1 ||
            !Object.prototype.hasOwnProperty.call(fields, key) || !answerValue(answer[key])) throw makeError('INVALID_ARGS', 'Answer contains an invalid field.');
        var field = fields[key];
        if (field.hidden || field.type === 'external') throw makeError('INVALID_ARGS', 'Answer contains a hidden or unsupported field.');
      });
      function condition(field, values) {
        if (!field.when) return true;
        return field.when.every(function (when) {
          if (!Object.prototype.hasOwnProperty.call(fields, when.key)) throw makeError('INVALID_ARGS', 'Question has unsupported conditions.');
          var actual = Object.prototype.hasOwnProperty.call(values, when.key) ? values[when.key] : undefined;
          if (actual === undefined) return false;
          var equal = JSON.stringify(actual) === JSON.stringify(when.value);
          return when.op === 'eq' ? equal : when.op === 'neq' ? !equal : false;
        });
      }
      form.fields.forEach(function (field) {
        var supplied = Object.prototype.hasOwnProperty.call(answer, field.key);
        if (supplied && !condition(field, answer)) throw makeError('INVALID_ARGS', 'Answer contains an inactive field.');
        if (!supplied && !field.hidden && condition(field, answer) && field.required) throw makeError('INVALID_ARGS', 'Answer is missing a required field.');
        if (!supplied) return;
        var value = answer[field.key];
        // Format and pattern remain server-validated; avoid running unbounded regexes locally.
        if (field.type === 'string' && (typeof value !== 'string' || field.minLength !== undefined && value.length < field.minLength || field.maxLength !== undefined && value.length > field.maxLength)) {
          throw makeError('INVALID_ARGS', 'Answer does not match question fields.');
        }
        if ((field.type === 'number' || field.type === 'integer') && (typeof value !== 'number' || !Number.isFinite(value) || field.type === 'integer' && !Number.isInteger(value) ||
            field.minimum !== undefined && value < Number(field.minimum) || field.maximum !== undefined && value > Number(field.maximum))) throw makeError('INVALID_ARGS', 'Answer does not match question fields.');
        if (field.type === 'boolean' && typeof value !== 'boolean') throw makeError('INVALID_ARGS', 'Answer does not match question fields.');
        if (field.type === 'multiselect') {
          if (!Array.isArray(value) || !value.every(function (v) { return typeof v === 'string'; }) || new Set(value).size !== value.length ||
              field.minItems !== undefined && value.length < field.minItems || field.maxItems !== undefined && value.length > field.maxItems) throw makeError('INVALID_ARGS', 'Answer does not match question fields.');
        }
        var options = field.options;
        if (options && field.custom !== true) {
          var allowed = options.map(function (option) { return option.value; });
          var choices = Array.isArray(value) ? value : [value];
          choices.forEach(function (choice) { if (allowed.indexOf(choice) === -1) throw makeError('INVALID_ARGS', 'Answer does not match question options.'); });
        }
      });
    }

    async function answerAction(state, args) {
      if (!isPlainObject(args) || Object.keys(args).length !== 3 || !sessionID(args.session_id) || !nonemptyID(args.form_id) || !isPlainObject(args.answer)) {
        throw makeError('INVALID_ARGS', 'Invalid question answer.');
      }
      validateAnswerShape(args.answer);
      var response;
      try { response = await api(state, sessionPath(args.session_id) + '/form/' + encodeURIComponent(args.form_id)); }
      catch (err) {
        if (err && err.httpStatus === 404) throw makeError('INVALID_ARGS', 'Question not found.');
        throw err;
      }
      var checked = validForm(response && response.data, args.session_id);
      var detail = checked.form;
      if (detail.id !== args.form_id) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned a different question.');
      var formStatus = isPlainObject(detail.state) ? detail.state.status : null;
      if (['pending', 'answered', 'cancelled'].indexOf(formStatus) === -1) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode returned invalid question state.');
      if (formStatus !== 'pending') throw makeError('INVALID_ARGS', 'Question already settled. Refresh before answering.');
      if (checked.external) throw makeError('INVALID_ARGS', 'This question requires external interaction and cannot be answered here.');
      if (checked.hiddenRequired) throw makeError('INVALID_ARGS', 'This question requires a hidden field; answer it in OpenCode desktop.');
      validateAnswer(detail, args.answer);
      await invalidateBeforeMutation(state);
      try { await api(state, sessionPath(args.session_id) + '/form/' + encodeURIComponent(args.form_id) + '/reply', 'POST', { answer: args.answer }, 204); }
      catch (err) {
        if (err && err.httpStatus === 400) throw makeError('INVALID_ARGS', 'OpenCode rejected the answer. Refresh the question and check its fields.');
        if (err && err.httpStatus === 409) throw makeError('INVALID_ARGS', 'Question already settled. Refresh before answering.');
        if (err && err.httpStatus === 404) throw makeError('INVALID_ARGS', 'Question not found.');
        if (err && (err.code === 'PERMISSION_DENIED' || err.code === 'AUTH_REQUIRED' || err.code === 'RATE_LIMITED')) throw err;
        if (err && err.httpStatus && err.httpStatus < 500) throw err;
        throw makeError('PLUGIN_UNAVAILABLE', 'Answer outcome uncertain. Inspect OpenCode before retrying.');
      }
      await invalidateAfterMutation(state);
      return { text: 'Answer submitted to OpenCode.', refreshed: questionRefreshes };
    }

    async function action(input) {
      if (input && ['interrupt_session', 'answer_question', 'approve_permission', 'mark_chat_read', 'cancel_queued_message', 'set_queued_delivery', 'stop_shell', 'run_command'].indexOf(input.action) !== -1) {
        if (!input.args || typeof input.args !== 'object' || Array.isArray(input.args)) throw makeError('INVALID_ARGS', 'Invalid action request.');
        var controlState = await load();
        requireConnection(controlState);
        if (input.action === 'interrupt_session') return interruptAction(controlState, input.args);
        if (input.action === 'answer_question') return answerAction(controlState, input.args);
        if (input.action === 'approve_permission') return approvePermissionAction(controlState, input.args);
        if (input.action === 'mark_chat_read') return markChatReadAction(controlState, input.args);
        if (input.action === 'cancel_queued_message') return inboxAction(controlState, input.args, false);
        if (input.action === 'set_queued_delivery') return inboxAction(controlState, input.args, true);
        if (input.action === 'stop_shell') return stopShellAction(controlState, input.args);
        return runCommandAction(controlState, input.args);
      }
      if (!input || typeof input !== 'object' || input.action !== 'send_to_agent' ||
          !input.args || typeof input.args !== 'object' || Array.isArray(input.args)) {
        throw makeError('INVALID_ARGS', 'Invalid action request.');
      }
      var args = input.args;
      Object.keys(args).forEach(function (key) {
        if (key !== 'message' && key !== 'chat_id' && key !== 'delivery') throw makeError('INVALID_ARGS', 'Unexpected action argument.');
      });
      if (args.delivery !== undefined && !validDelivery(args.delivery)) {
        throw makeError('INVALID_ARGS', 'Delivery must be queue or steer.');
      }
      var message = args.message;
      if (typeof message !== 'string' || !message.trim() || message.length > 16000 ||
          (args.chat_id !== undefined && args.chat_id !== null && typeof args.chat_id !== 'string')) {
        throw makeError('INVALID_ARGS', 'Message or chat_id is invalid.');
      }
      var state = await load();
      requireConnection(state);
      var delivery = args.delivery === undefined ? state.default_delivery : args.delivery;
      var target = args.chat_id === undefined || args.chat_id === null || args.chat_id.trim() === '' ? null : args.chat_id.trim();
      if (target === null) {
        if (state.mode === 'new_chat') target = 'new';
        else if (state.selected) target = state.selected.session_id;
        else throw makeError('INVALID_ARGS', 'Choose a default session or new-chat directory first.');
      }
      var create = /^(new|new chat)$/i.test(target);
      var session;
      if (!create) {
        var id = null;
        if (sessionID(target)) id = target;
        else {
          var lower = target.toLowerCase();
          var nicknameIDs = Object.keys(state.nicknames).filter(function (key) {
            return state.nicknames[key].toLowerCase() === lower;
          });
          if (nicknameIDs.length > 1) throw makeError('INVALID_ARGS', 'Chat nickname is ambiguous.');
          if (nicknameIDs.length === 1) id = nicknameIDs[0];
          if (!id) {
            var partialNickIDs = Object.keys(state.nicknames).filter(function (key) {
              return state.nicknames[key].toLowerCase().indexOf(lower) !== -1;
            });
            if (partialNickIDs.length > 1) throw makeError('INVALID_ARGS', 'Chat nickname is ambiguous.');
            if (partialNickIDs.length === 1) id = partialNickIDs[0];
          }
          if (!id) {
            var all = await allSessions(state);
            var titleMatches = all.filter(function (item) { return titleOf(item).toLowerCase().indexOf(lower) !== -1; });
            if (titleMatches.length !== 1) throw makeError('INVALID_ARGS', titleMatches.length ? 'Chat title is ambiguous.' : 'Chat not found.');
            id = titleMatches[0].id;
          }
        }
        if (!sessionID(id)) throw makeError('INVALID_ARGS', 'Invalid session ID.');
        session = await getSession(state, id);
        if (archived(session)) throw makeError('INVALID_ARGS', 'Archived sessions cannot receive messages.');
      } else {
        if (!directoryPath(state.directory)) throw makeError('INVALID_ARGS', 'Set an absolute server directory before creating a session.');
        await invalidateBeforeMutation(state);
        var created = await api(state, '/session', 'POST', { title: 'Pebble', location: { directory: state.directory } });
        session = validSession(created && created.data);
        if (archived(session)) throw makeError('INVALID_ARGS', 'Archived sessions cannot receive messages.');
      }

      var messageID = makeMessageID();
      var receipt;
      var deliveryVerified = false;
      var receiptText = { sessionID: session.id, text: message };
      await invalidateBeforeMutation(state);
      try {
        receipt = await api(state, sessionPath(session.id) + '/prompt', 'POST', {
          id: messageID, text: message, delivery: delivery
        });
      } catch (sendError) {
        if (sendError && (sendError.code === 'PERMISSION_DENIED' || sendError.code === 'AUTH_REQUIRED' || sendError.code === 'RATE_LIMITED')) throw sendError;
        if (sendError && sendError.httpStatus && sendError.httpStatus < 500 && sendError.httpStatus !== 409) throw sendError;
        if (sendError && sendError.httpStatus === 409) throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode reported a conflict; inspect desktop before retrying.');
        if (!await verifyDelivery(state, session.id, messageID, message, delivery)) {
          throw makeError('PLUGIN_UNAVAILABLE', 'Delivery uncertain. Inspect OpenCode desktop before retrying.');
        }
        deliveryVerified = true;
        receipt = null;
      }
      var result = receipt && receipt.data;
      if (receipt && validReceipt(result, messageID, receiptText, delivery)) {
        deliveryVerified = true;
      } else if (receipt && receiptShape(result, messageID, receiptText)) {
        throw makeError('PLUGIN_UNAVAILABLE', 'OpenCode accepted the message with a different delivery mode. Inspect desktop before retrying.');
      }
      if (!deliveryVerified) {
        if (!await verifyDelivery(state, session.id, messageID, message, delivery)) {
          throw makeError('PLUGIN_UNAVAILABLE', 'Delivery uncertain. Inspect OpenCode desktop before retrying.');
        }
        deliveryVerified = true;
      }
      var focusWarning = false;
      try {
        var freshState = await load();
        if (freshState.url !== state.url || freshState.username !== state.username || !freshState.password || !/^2\./.test(freshState.version)) {
          focusWarning = true;
        } else {
          freshState.lastSessionID = session.id;
          await save(freshState);
        }
      } catch (_) { focusWarning = true; }
      await invalidateAfterMutation(state);
      return {
        text: (delivery === 'steer' ? 'Message steered into OpenCode: ' : 'Message queued for OpenCode: ') + titleOf(session) + (focusWarning ? ' Focus not saved.' : ''),
        refreshed: sourceRefreshes()
      };
    }

    return { config: config, source: source, action: action };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createService: createService };

  if (root.Pebble && typeof root.Pebble.registerSourceHandler === 'function' &&
      typeof root.Pebble.registerActionHandler === 'function' && typeof root.Pebble.registerConfigHandler === 'function' &&
      root.Pebble.secureStorage && typeof root.fetch === 'function') {
    var service = createService({ storage: root.Pebble.secureStorage, fetch: root.fetch.bind(root) });
    root.Pebble.registerSourceHandler(function (request, respond) {
      return service.source(request).then(function (data) { respond.data(data); }, function (err) {
        var safe = safeError(err);
        respond.error(safe.code, safe.message);
      });
    });
    root.Pebble.registerActionHandler(function (request, respond) {
      return service.action(request).then(function (result) { respond.ok(result); }, function (err) {
        var safe = safeError(err);
        respond.error(safe.code, safe.message);
      });
    });
    root.Pebble.registerConfigHandler(function (message, respond) {
      return service.config(message).then(function (result) { respond(result); }, function (err) {
        respond({ error: safeError(err) });
      });
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
