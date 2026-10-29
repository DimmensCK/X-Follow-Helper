/* X Follow Helper • DimmensCK
 * Passive, page-local request observation. No message listener or account-action API.
 * Only compact, bounded native responses and request templates survive in memory.
 */
(() => {
  'use strict';
  if (Object.prototype.hasOwnProperty.call(window, '__XMH_OBSERVER')) return;
  const allowed = new Set(['Following', 'Followers', 'UserByScreenName', 'UserByRestId']);
  const headerNames = ['authorization', 'x-twitter-auth-type', 'x-twitter-active-user', 'x-twitter-client-language'];
  const maxBytes = 4 * 1024 * 1024;
  const maxPageBytes = 1024 * 1024;
  const templates = new Map();
  const preparations = new Map();
  const requests = new Map();
  const discardedThrough = new Map();
  let requestSerial = 0;
  let pages = [];
  let bytes = 0;
  const sequences = { Following: 0, Followers: 0 };
  const instanceId = crypto.randomUUID();
  let epoch = 0;
  let viewer = null;
  let ownProfile = null;
  let ownProfileSerial = 0;

  function viewerId() {
    try {
      const value = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith('twid='));
      if (!value) return null;
      return /^u=(\d{1,30})$/.exec(decodeURIComponent(value.slice(5)))?.[1] || null;
    } catch { return null; }
  }

  function refreshViewer() {
    const next = viewerId();
    if (next !== viewer) {
      viewer = next;
      templates.clear();
      preparations.clear();
      requests.clear();
      discardedThrough.clear();
      pages = [];
      bytes = 0;
      ownProfile = null;
      ownProfileSerial = 0;
      epoch++;
    }
    return viewer;
  }

  function descriptor(input, init) {
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
      const method = String(init?.method || input?.method || 'GET').toUpperCase();
      const match = /^\/i\/api\/graphql\/([A-Za-z0-9_-]{4,100})\/(Following|Followers|UserByScreenName|UserByRestId)$/.exec(url.pathname);
      if (method !== 'GET' || url.origin !== location.origin || !['x.com', 'twitter.com'].includes(url.hostname) || !match || !allowed.has(match[2])) return null;
      const accountId = refreshViewer();
      if (!accountId) return null;
      const variables = JSON.parse(url.searchParams.get('variables') || '{}');
      if (!variables || typeof variables !== 'object' || Array.isArray(variables)) return null;
      if (['Following', 'Followers'].includes(match[2]) && String(variables.userId) !== accountId) return null;
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      if (init?.headers) new Headers(init.headers).forEach((value, name) => headers.set(name, value));
      const captured = {};
      for (const name of headerNames) {
        const value = headers.get(name);
        if (value && value.length < 2048) captured[name] = value;
      }
      const meta = { operation: match[2], url: url.href, accountId, variables, headers: captured, epoch, at: Date.now(), serial: ++requestSerial };
      if (['Following', 'Followers'].includes(meta.operation)) {
        if (variables.cursor != null && (typeof variables.cursor !== 'string' || variables.cursor.length > 4096)) return null;
        const cursor = variables.cursor ?? null;
        meta.requestKey = JSON.stringify([meta.operation, cursor]);
        const root = pages.find(item => item.operation === meta.operation && item.cursor === null);
        const pendingRoot = requests.get(JSON.stringify([meta.operation, null]));
        // Only the first root can provisionally own an early continuation.
        // Once a root exists, requests stay bound to it until the new one is observed.
        meta.sequence = cursor === null ? sequences[meta.operation] + 1 : root ? root.sequence : pendingRoot?.state === 'pending' ? pendingRoot.sequence : sequences[meta.operation];
        meta.rootGeneration = cursor === null ? meta.serial : root?.generation ?? (pendingRoot?.state === 'pending' ? pendingRoot.generation : null);
        if (cursor === null || root && pendingRoot?.generation === root.generation && meta.rootGeneration === root.generation) {
          preparations.set(meta.operation, { operation: meta.operation, method: 'GET', state: 'pending', startedAt: meta.at,
            finishedAt: null, status: null, generation: meta.serial });
        }
        requests.delete(meta.requestKey);
        requests.set(meta.requestKey, { operation: meta.operation, cursor, accountId, instanceId, epoch, sequence: meta.sequence,
          rootGeneration: meta.rootGeneration, generation: meta.serial, state: 'pending', startedAt: meta.at, finishedAt: null, status: null, responseHeaders: {} });
        while (requests.size > 64) {
          const removable = [...requests].find(([, request]) => request.cursor !== null);
          requests.delete(removable ? removable[0] : requests.keys().next().value);
        }
      }
      return meta;
    } catch { return null; }
  }

  function finishPreparation(meta, status, responseHeaders = {}) {
    if (!meta || refreshViewer() !== meta.accountId || meta.epoch !== epoch || meta.serial <= (discardedThrough.get(meta.operation) || 0)) return;
    const code = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    const current = requests.get(meta.requestKey);
    if (current?.generation === meta.serial) requests.set(meta.requestKey, { ...current,
      state: code === null ? 'network_error' : code === 200 ? 'complete' : 'http_error', finishedAt: Date.now(), status: code, responseHeaders });
    if (current && current.rootGeneration !== requests.get(JSON.stringify([meta.operation, null]))?.generation) return;
    if (preparations.get(meta.operation)?.generation !== meta.serial) return;
    preparations.set(meta.operation, { operation: meta.operation, method: 'GET',
      state: code === null ? 'network_error' : code === 200 ? 'complete' : 'http_error',
      startedAt: meta.at, finishedAt: Date.now(), status: code, generation: meta.serial });
  }

  function accept(meta, status, body, responseHeaders = {}) {
    if (!meta || refreshViewer() !== meta.accountId || meta.epoch !== epoch) return;
    if (status !== 200 || typeof body !== 'string' || body.length > maxPageBytes) return;
    let data;
    try { data = JSON.parse(body); } catch { return; }
    if (!data || typeof data !== 'object' || data.errors?.length) return;
    const previous = templates.get(meta.operation);
    const listRequest = requests.get(meta.requestKey);
    if (meta.requestKey && listRequest?.generation > meta.serial) return;
    const root = pages.find(item => item.operation === meta.operation && item.cursor === null);
    const pendingRoot = requests.get(JSON.stringify([meta.operation, null]));
    const provisional = !root && pendingRoot?.state === 'pending' && listRequest?.rootGeneration === pendingRoot.generation
      && listRequest?.sequence === pendingRoot.sequence && meta.serial > pendingRoot.generation;
    const continuation = typeof meta.variables.cursor === 'string' && listRequest?.generation === meta.serial
      && (listRequest.sequence === sequences[meta.operation] && listRequest.rootGeneration === root?.generation
        && pendingRoot?.generation === root?.generation || provisional);
    const isContinuation = ['Following', 'Followers'].includes(meta.operation) && typeof meta.variables.cursor === 'string';
    if (isContinuation && meta.rootGeneration !== null && !continuation) return;
    const latestRoot = ['Following', 'Followers'].includes(meta.operation) && meta.variables.cursor == null && pendingRoot?.generation === meta.serial;
    // An older response must not replace a newer successful endpoint or revive
    // a template explicitly discarded after a failed read.
    if (meta.serial <= (discardedThrough.get(meta.operation) || 0) || meta.serial < (previous?.generation || 0) && !continuation && !latestRoot) return;
    if (meta.serial >= (previous?.generation || 0)) {
      const headers = { ...(previous?.accountId === meta.accountId ? previous.headers : {}), ...meta.headers };
      templates.set(meta.operation, { url: meta.url, accountId: meta.accountId, headers, at: Date.now(), generation: meta.serial });
    }
    if (meta.operation === 'Following' || meta.operation === 'Followers') {
      const cursor = typeof meta.variables.cursor === 'string' ? meta.variables.cursor : null;
      if (cursor !== null && !continuation) return;
      if (cursor === null) {
        for (const item of pages) if (item.operation === meta.operation && item.rootGeneration !== meta.serial) bytes -= item.bytes;
        pages = pages.filter(item => item.operation !== meta.operation || item.rootGeneration === meta.serial);
        sequences[meta.operation]++;
        for (const [key, request] of requests) if (request.operation === meta.operation) {
          if (request.rootGeneration !== meta.serial) requests.delete(key);
        }
        const latest = [...requests.values()].filter(request => request.operation === meta.operation && request.rootGeneration === meta.serial)
          .sort((a, b) => b.generation - a.generation)[0];
        if (latest && latest.generation > meta.serial) preparations.set(meta.operation, { operation: meta.operation, method: 'GET', state: latest.state,
          startedAt: latest.startedAt, finishedAt: latest.finishedAt, status: latest.status, generation: latest.generation });
      }
      const entry = { operation: meta.operation, cursor, accountId: meta.accountId, instanceId, epoch, sequence: cursor === null ? sequences[meta.operation] : listRequest.sequence,
        rootGeneration: cursor === null ? meta.serial : listRequest.rootGeneration, at: Date.now(), generation: meta.serial, responseHeaders, data, bytes: body.length * 2 };
      const old = pages.findIndex(item => item.cursor === cursor && item.operation === meta.operation);
      if (old >= 0) { bytes -= pages[old].bytes; pages.splice(old, 1); }
      pages.push(entry);
      bytes += entry.bytes;
      while (pages.length > 12 || bytes > maxBytes) {
        // Retain each list's first page while bounded continuations rotate.
        const nonRoot = pages.findIndex(item => item.cursor !== null);
        const index = nonRoot >= 0 ? nonRoot : 0;
        bytes -= pages[index].bytes;
        pages.splice(index, 1);
      }
    } else {
      let user = data.data?.user?.result;
      if (user?.__typename === 'UserWithVisibilityResults') user = user.user;
      if (String(user?.rest_id || user?.id_str || '') === meta.accountId) {
        const handle = user.core?.screen_name || user.legacy?.screen_name || user.screen_name;
        const countEvidence = (...values) => {
          const known = values.filter(value => value !== undefined && value !== null);
          return known.length && known.every(value => Number.isSafeInteger(value) && value >= 0 && value === known[0]) ? known[0] : null;
        };
        const interstitial = user.profile_metadata?.profile_interstitial_type;
        const unavailable = user.__typename === 'UserUnavailable' || user.suspended === true
          || (typeof interstitial === 'string' && interstitial !== '' && interstitial !== 'None');
        const count = unavailable ? null : countEvidence(user.relationship_counts?.following, user.legacy?.friends_count, user.friends_count);
        const followers = unavailable ? null : countEvidence(user.relationship_counts?.followers, user.legacy?.followers_count, user.followers_count);
        // Both profile operations update this shared owner record. A slower
        // older response must not undo a newer name/count from the other one.
        if (typeof handle === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(handle) && meta.serial >= ownProfileSerial) {
          ownProfile = { id: meta.accountId, handle, followingCount: count, followersCount: followers, countEvidenceVersion: 1, at: Date.now() };
          ownProfileSerial = meta.serial;
        }
      }
    }
  }

  function safeResponseHeaders(get) {
    const result = {};
    for (const name of ['date', 'retry-after', 'x-rate-limit-remaining', 'x-rate-limit-limit', 'x-rate-limit-reset']) {
      try { const value = get(name); if (typeof value === 'string' && value.length <= 128) result[name] = value; } catch { /* Optional native headers. */ }
    }
    return result;
  }

  async function observeBody(response, meta) {
    if (!response.body || typeof response.body.getReader !== 'function') return;
    const reader = response.body.getReader();
    // The existing per-page limit is UTF-16 characters. Three UTF-8 bytes per
    // character preserves every previously valid BMP response within that limit.
    const byteLimit = maxPageBytes * 3;
    const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Never affect the native consumer. */ } };
    let storage = new Uint8Array(65536), length = 0;
    try {
      const declared = response.headers.get('content-length');
      if (typeof declared === 'string' && /^\d{1,12}$/.test(declared) && Number(declared) > byteLimit) { cancel(); return; }
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength > byteLimit - length) { cancel(); return; }
        const needed = length + chunk.value.byteLength;
        if (needed > storage.length) {
          const next = new Uint8Array(Math.min(byteLimit, Math.max(needed, storage.length * 2)));
          next.set(storage.subarray(0, length)); storage = next;
        }
        storage.set(chunk.value, length); length = needed;
      }
      accept(meta, response.status, new TextDecoder().decode(storage.subarray(0, length)), safeResponseHeaders(name => response.headers.get(name)));
    } finally { reader.releaseLock(); }
  }

  const nativeFetch = window.fetch;
  window.fetch = async function observedFetch(input, init) {
    let meta;
    try { meta = descriptor(input, init); } catch { /* Observing cannot break X. */ }
    let response;
    try { response = await nativeFetch.apply(this, arguments); }
    catch (error) { finishPreparation(meta, null); throw error; }
    if (meta) {
      if (response.status === 200) {
        try { observeBody(response.clone(), meta).then(() => finishPreparation(meta, response.status, safeResponseHeaders(name => response.headers.get(name))), () => finishPreparation(meta, null)); }
        catch { finishPreparation(meta, response.status, safeResponseHeaders(name => response.headers.get(name))); /* No effect on caller. */ }
      } else finishPreparation(meta, response.status, safeResponseHeaders(name => response.headers.get(name)));
    }
    return response;
  };

  const xhrMeta = new WeakMap();
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeHeader = XMLHttpRequest.prototype.setRequestHeader;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function observedOpen(method, url) {
    xhrMeta.set(this, { method, url, headers: {} });
    return nativeOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function observedHeader(name, value) {
    const info = xhrMeta.get(this);
    if (info && headerNames.includes(String(name).toLowerCase())) info.headers[String(name).toLowerCase()] = String(value);
    return nativeHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function observedSend() {
    const info = xhrMeta.get(this);
    const meta = info ? descriptor(String(info.url), info) : null;
    let settled = false;
    const listeners = [];
    const cleanup = () => {
      if (settled) return false;
      settled = true;
      for (const [event, callback] of listeners) this.removeEventListener?.(event, callback);
      return true;
    };
    const loaded = () => {
      if (!cleanup()) return;
      try {
        const body = this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText;
        accept(meta, this.status, body, safeResponseHeaders(name => this.getResponseHeader(name)));
      } catch { /* Binary/unsupported native responses are ignored. */ }
      finally { finishPreparation(meta, this.status, safeResponseHeaders(name => this.getResponseHeader(name))); }
    };
    const failed = () => { if (cleanup()) finishPreparation(meta, null); };
    if (meta) {
      listeners.push(['load', loaded], ...['error', 'abort', 'timeout'].map(event => [event, failed]));
      for (const [event, callback] of listeners) this.addEventListener(event, callback, { once: true });
    }
    try { return nativeSend.apply(this, arguments); }
    catch (error) { failed(); throw error; }
  };

  const api = Object.freeze({
    version: 1,
    build: 10,
    invalidate(operation, generation) {
      refreshViewer();
      if (!['Following', 'Followers'].includes(operation) || !Number.isSafeInteger(generation) || generation < 1) return false;
      if (templates.get(operation)?.generation !== generation) return false;
      templates.delete(operation);
      preparations.delete(operation);
      for (const [key, request] of requests) if (request.operation === operation) requests.delete(key);
      discardedThrough.set(operation, requestSerial);
      for (const item of pages) if (item.operation === operation) bytes -= item.bytes;
      pages = pages.filter(item => item.operation !== operation);
      return true;
    },
    read() {
      refreshViewer();
      const now = Date.now();
      const result = {};
      for (const [key, value] of templates) {
        if (now - value.at <= 30 * 60 * 1000) result[key] = { ...value, headers: { ...value.headers } };
      }
      const scanPreparation = Object.fromEntries([...preparations].map(([operation, value]) => [operation, { ...value }]));
      return { viewer, instanceId, epoch, sequence: sequences.Following, sequences: { ...sequences }, templates: result, scanPreparation, ownProfile: ownProfile ? { ...ownProfile } : null };
    },
    request(cursor, operation = 'Following') {
      refreshViewer();
      const result = requests.get(JSON.stringify([operation, cursor ?? null]));
      if (!result || Date.now() - (result.finishedAt ?? result.startedAt) > 35 * 60 * 1000) return null;
      return { ...result, responseHeaders: { ...result.responseHeaders } };
    },
    page(cursor, operation = 'Following') {
      refreshViewer();
      if (!['Following', 'Followers'].includes(operation)) return null;
      const page = pages.find(item => item.cursor === cursor && item.operation === operation && item.accountId === viewer && item.epoch === epoch);
      // Clone prevents consumers from changing retained observation evidence.
      return page?.sequence === sequences[operation] ? JSON.parse(JSON.stringify(page)) : null;
    }
  });
  Object.defineProperty(window, '__XMH_OBSERVER', { value: api, writable: false, configurable: false, enumerable: false });
})();
