// Durable unfinished follower reads. These records never become a comparison
// baseline until the caller completes its normal identity and snapshot checks.
import { byteSize, normalizeUser, requireId } from './core.js';

export const checkpointLimits = Object.freeze({
  MAX_BYTES: 32 * 1024 * 1024, MAX_ACCOUNTS: 5, MAX_USERS: 100000,
  MAX_PAGES: 2000, MAX_PAGE_ROWS: 1000, MAX_PAGE_BYTES: 2 * 1024 * 1024,
  MAX_CURSOR_LENGTH: 8192, TTL_MS: 24 * 60 * 60 * 1000,
});
export const checkpointKeys = Object.freeze({ catalog: 'xfhFollowerCheckpointsV1', pagePrefix: 'xfhFollowerCheckpointPageV1:' });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const cursor = value => value === null || typeof value === 'string' && value.length > 0 && value.length <= checkpointLimits.MAX_CURSOR_LENGTH;
const nullableCount = value => value === null || count(value);
const nullableTime = value => value === null || positive(value);
const states = new Set(['collecting', 'paused', 'invalid', 'complete']);
const queues = new WeakMap();
const fail = code => { throw new Error(code); };
const clone = value => structuredClone(value);
const pageKey = (id, generation, index) => `${checkpointKeys.pagePrefix}${id}:${generation}:${index}`;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(value)))))].map(v => v.toString(16).padStart(2, '0')).join('');
}
function serial(area, task) {
  const operation = (queues.get(area) || Promise.resolve()).then(task);
  queues.set(area, operation.catch(() => {}));
  return operation;
}
function checkManifest(m, id) {
  if (!object(m) || m.schema !== 1 || !object(m.account) || m.account.id !== id
    || typeof m.account.handle !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(m.account.handle)
    || !UUID.test(m.generation) || !UUID.test(m.runId) || !HASH.test(m.baseRevision)
    || !positive(m.revision) || !positive(m.startedAt) || !positive(m.savedAt) || m.savedAt < m.startedAt
    || m.expiresAt !== m.startedAt + checkpointLimits.TTL_MS || !states.has(m.status)
    || !count(m.pages) || m.pages > checkpointLimits.MAX_PAGES || !count(m.count) || m.count > checkpointLimits.MAX_USERS
    || !count(m.bytes) || m.bytes > checkpointLimits.MAX_BYTES || !nullableCount(m.expectedStart) || !nullableCount(m.pageExpected)
    || !Number.isInteger(m.pageSize) || m.pageSize < 1 || m.pageSize > 100
    || !cursor(m.nextCursor) || typeof m.complete !== 'boolean' || !nullableTime(m.waitUntil)
    || (m.pages === 0 ? m.lastDigest !== null || m.nextCursor !== null || m.count !== 0 || m.complete : !HASH.test(m.lastDigest))
    || (m.complete && m.nextCursor !== null) || (!m.complete && m.pages > 0 && m.nextCursor === null)) fail('CHECKPOINT_CORRUPT');
  requireId(id);
  return m;
}
function checkCatalog(raw, entries = true) {
  if (!object(raw) || raw.schema !== 1 || !object(raw.accounts) || !Array.isArray(raw.garbage)
    || Object.keys(raw.accounts).length > checkpointLimits.MAX_ACCOUNTS || raw.garbage.length > checkpointLimits.MAX_ACCOUNTS) fail('CHECKPOINT_CORRUPT');
  for (const id of Object.keys(raw.accounts)) {
    requireId(id);
    if (entries) checkManifest(raw.accounts[id], id);
  }
  for (const item of raw.garbage) {
    if (!object(item) || !UUID.test(item.generation) || !positive(item.pages) || item.pages > checkpointLimits.MAX_PAGES + 1 || !count(item.bytes)) fail('CHECKPOINT_CORRUPT');
    requireId(item.accountId);
  }
  return raw;
}
function accountIdentity(value) {
  const id = requireId(value?.id);
  if (typeof value.handle !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(value.handle)) fail('CHECKPOINT_IDENTITY');
  return { id, handle: value.handle };
}
function publicSummary(m, now) {
  const expired = now >= m.expiresAt;
  return { accountId: m.account.id, account: clone(m.account), generation: m.generation, revision: m.revision,
    token: { generation: m.generation, revision: m.revision }, pages: m.pages, count: m.count,
    complete: m.complete, status: m.status, startedAt: m.startedAt, savedAt: m.savedAt,
    expiresAt: m.expiresAt, waitUntil: m.waitUntil, bytes: m.bytes,
    expired, resumable: m.pages > 0 && !expired && m.status !== 'invalid' };
}

export function createCheckpointStore(storageArea = chrome.storage.local, { now = () => Date.now() } = {}) {
  const cache = new Map();
  async function catalog(entries = true) {
    const result = await storageArea.get(checkpointKeys.catalog);
    return Object.hasOwn(result, checkpointKeys.catalog) ? checkCatalog(result[checkpointKeys.catalog], entries) : { schema: 1, accounts: {}, garbage: [] };
  }
  async function saveCatalog(value) { await storageArea.set({ [checkpointKeys.catalog]: value }); }
  function assertToken(m, token) {
    if (!m || !object(token) || token.generation !== m.generation || token.revision !== m.revision) fail('CHECKPOINT_STALE');
  }
  function assertBudget(value, extra = 0) {
    const bytes = byteSize({ [checkpointKeys.catalog]: value }) + extra
      + Object.values(value.accounts).reduce((sum, item) => sum + item.bytes, 0)
      + value.garbage.reduce((sum, item) => sum + item.bytes, 0);
    if (bytes > checkpointLimits.MAX_BYTES) fail('CHECKPOINT_STORAGE_LIMIT');
  }
  async function cleanup(value) {
    // A failed append can leave exactly the next page unreachable. Clearing it
    // before another write keeps the global temporary budget bounded, including
    // failure/restart paths. No referenced page is removed here.
    const keys = Object.values(value.accounts).map(m => pageKey(m.account.id, m.generation, m.pages + 1));
    for (const item of value.garbage) for (let index = 1; index <= item.pages; index++) keys.push(pageKey(item.accountId, item.generation, index));
    if (keys.length) await storageArea.remove(keys);
    if (value.garbage.length) { value.garbage = []; await saveCatalog(value); }
  }
  async function readRows(m) {
    const cached = cache.get(m.account.id);
    if (cached?.generation === m.generation && cached.revision === m.revision) return cached;
    const keys = Array.from({ length: m.pages }, (_, i) => pageKey(m.account.id, m.generation, i + 1));
    const pages = keys.length ? await storageArea.get(keys) : {};
    const users = new Map(), departed = new Set(), cursors = new Set();
    let previousDigest = null, nextCursor = null, bytes = 0;
    for (let index = 1; index <= m.pages; index++) {
      const key = keys[index - 1], page = pages[key];
      if (!object(page) || page.schema !== 1 || page.accountId !== m.account.id || page.generation !== m.generation
        || page.index !== index || page.previousDigest !== previousDigest || page.requestCursor !== nextCursor
        || !cursor(page.nextCursor) || typeof page.complete !== 'boolean'
        || page.complete !== (index === m.pages && m.complete) || !positive(page.observedAt) || page.observedAt < m.startedAt
        || !Array.isArray(page.users) || page.users.length > checkpointLimits.MAX_PAGE_ROWS
        || !Array.isArray(page.departedIds) || page.departedIds.length > checkpointLimits.MAX_PAGE_ROWS
        || !nullableCount(page.expected) || !HASH.test(page.digest)) fail('CHECKPOINT_CORRUPT');
      const { digest: savedDigest, ...payload } = page;
      if (await digest(payload) !== savedDigest) fail('CHECKPOINT_CORRUPT');
      const seen = new Set();
      for (const id of page.departedIds) { requireId(id); if (seen.has(id)) fail('CHECKPOINT_CORRUPT'); seen.add(id); users.delete(id); departed.add(id); }
      for (const raw of page.users) {
        const user = normalizeUser(raw);
        if (seen.has(user.id) || JSON.stringify(canonical(raw)) !== JSON.stringify(canonical(user))) fail('CHECKPOINT_CORRUPT');
        seen.add(user.id); users.set(user.id, user); departed.delete(user.id);
      }
      if (users.size > checkpointLimits.MAX_USERS || departed.size > checkpointLimits.MAX_USERS) fail('CHECKPOINT_CORRUPT');
      if (page.complete) { if (page.nextCursor !== null) fail('CHECKPOINT_CORRUPT'); }
      else { if (!page.nextCursor || cursors.has(page.nextCursor)) fail('CHECKPOINT_CORRUPT'); cursors.add(page.nextCursor); }
      nextCursor = page.nextCursor; previousDigest = savedDigest; bytes += byteSize({ [key]: page });
    }
    if (previousDigest !== m.lastDigest || nextCursor !== m.nextCursor || users.size !== m.count || bytes !== m.bytes) fail('CHECKPOINT_CORRUPT');
    const state = { generation: m.generation, revision: m.revision, users, departed, cursors };
    cache.set(m.account.id, state);
    return state;
  }
  return {
    start(input) {
      return serial(storageArea, async () => {
        const value = await catalog(); await cleanup(value);
        const account = accountIdentity(input?.account), startedAt = input?.startedAt, timestamp = now();
        if (!positive(startedAt) || startedAt > timestamp || timestamp - startedAt >= checkpointLimits.TTL_MS
          || !nullableCount(input.expectedStart) || !Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100
          || !HASH.test(input.baseRevision) || !UUID.test(input.runId)) fail('INVALID_CHECKPOINT');
        if (!value.accounts[account.id] && Object.keys(value.accounts).length >= checkpointLimits.MAX_ACCOUNTS) fail('CHECKPOINT_ACCOUNT_LIMIT');
        const old = value.accounts[account.id];
        const manifest = { schema: 1, account, generation: crypto.randomUUID(), revision: 1, runId: input.runId,
          baseRevision: input.baseRevision, startedAt, savedAt: timestamp, expiresAt: startedAt + checkpointLimits.TTL_MS,
          status: 'collecting', expectedStart: input.expectedStart, pageExpected: null, pageSize: input.pageSize,
          pages: 0, count: 0, nextCursor: null, complete: false, waitUntil: null, bytes: 0, lastDigest: null };
        if (old) value.garbage.push({ accountId: account.id, generation: old.generation, pages: old.pages + 1, bytes: old.bytes });
        value.accounts[account.id] = manifest; assertBudget(value);
        await saveCatalog(value); cache.delete(account.id);
        await cleanup(value);
        return publicSummary(manifest, now());
      });
    },
    append(accountId, token, input) {
      return serial(storageArea, async () => {
        requireId(accountId); const value = await catalog(); await cleanup(value);
        const m = value.accounts[accountId]; assertToken(m, token);
        if (now() >= m.expiresAt) fail('CHECKPOINT_EXPIRED');
        if (m.complete || m.status === 'invalid') fail('CHECKPOINT_NOT_WRITABLE');
        if (m.pages >= checkpointLimits.MAX_PAGES) fail('CHECKPOINT_PAGE_LIMIT');
        if (!object(input) || input.requestCursor !== m.nextCursor || !cursor(input.cursor)
          || typeof input.complete !== 'boolean' || !positive(input.observedAt) || input.observedAt < m.startedAt || input.observedAt > now() + 60000
          || !nullableCount(input.expected) || !Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100
          || input.waitUntil !== undefined && !nullableTime(input.waitUntil)
          || !Array.isArray(input.users) || input.users.length > checkpointLimits.MAX_PAGE_ROWS
          || !Array.isArray(input.departedIds) || input.departedIds.length > checkpointLimits.MAX_PAGE_ROWS) fail('INVALID_CHECKPOINT_PAGE');
        const state = await readRows(m), seen = new Set(), users = input.users.map(normalizeUser);
        for (const id of input.departedIds) { requireId(id); if (seen.has(id)) fail('INVALID_CHECKPOINT_PAGE'); seen.add(id); }
        for (const user of users) { if (seen.has(user.id)) fail('INVALID_CHECKPOINT_PAGE'); seen.add(user.id); }
        if (!input.complete && (!input.cursor || state.cursors.has(input.cursor))) fail('CHECKPOINT_CURSOR_LOOP');
        let size = state.users.size;
        for (const id of input.departedIds) if (state.users.has(id)) size--;
        for (const user of users) if (!state.users.has(user.id)) size++;
        if (size > checkpointLimits.MAX_USERS) fail('CHECKPOINT_USER_LIMIT');
        let departedSize = state.departed.size;
        for (const id of input.departedIds) if (!state.departed.has(id)) departedSize++;
        for (const user of users) if (state.departed.has(user.id)) departedSize--;
        if (departedSize > checkpointLimits.MAX_USERS) fail('CHECKPOINT_USER_LIMIT');
        const page = { schema: 1, accountId, generation: m.generation, index: m.pages + 1,
          previousDigest: m.lastDigest, requestCursor: input.requestCursor, nextCursor: input.complete ? null : input.cursor,
          complete: input.complete, observedAt: input.observedAt, expected: input.expected,
          users, departedIds: [...input.departedIds] };
        page.digest = await digest(page);
        const key = pageKey(accountId, m.generation, page.index), pageBytes = byteSize({ [key]: page });
        if (pageBytes > checkpointLimits.MAX_PAGE_BYTES) fail('CHECKPOINT_PAGE_SIZE');
        const next = { ...m, revision: m.revision + 1, savedAt: now(), pages: page.index, count: size,
          nextCursor: page.nextCursor, complete: page.complete, lastDigest: page.digest, bytes: m.bytes + pageBytes,
          pageExpected: input.expected ?? m.pageExpected, pageSize: input.pageSize,
          status: page.complete ? 'complete' : m.status, waitUntil: page.complete ? null : input.waitUntil ?? null };
        value.accounts[accountId] = next; assertBudget(value);
        await storageArea.set({ [key]: page });
        await saveCatalog(value);
        // Cache advances only after both durable writes succeed.
        for (const id of page.departedIds) { state.users.delete(id); state.departed.add(id); }
        for (const user of users) { state.users.set(user.id, user); state.departed.delete(user.id); }
        if (!page.complete) state.cursors.add(page.nextCursor);
        state.revision = next.revision;
        return publicSummary(next, now());
      });
    },
    update(accountId, token, patch) {
      return serial(storageArea, async () => {
        requireId(accountId); const value = await catalog(); await cleanup(value);
        const m = value.accounts[accountId]; assertToken(m, token);
        if (!object(patch) || Object.keys(patch).some(key => !['status', 'waitUntil'].includes(key))
          || Object.hasOwn(patch, 'status') && !states.has(patch.status)
          || Object.hasOwn(patch, 'waitUntil') && !nullableTime(patch.waitUntil)
          || patch.status === 'complete' && !m.complete || m.status === 'invalid' && patch.status && patch.status !== 'invalid') fail('INVALID_CHECKPOINT_PATCH');
        const next = { ...m, ...patch, savedAt: now(), revision: m.revision + 1 };
        if (m.complete && next.status !== 'invalid') next.status = 'complete';
        value.accounts[accountId] = next; assertBudget(value); await saveCatalog(value);
        const cached = cache.get(accountId); if (cached?.generation === m.generation && cached.revision === m.revision) cached.revision = next.revision;
        return publicSummary(next, now());
      });
    },
    load(accountId) {
      return serial(storageArea, async () => {
        requireId(accountId); const value = await catalog(false), m = value.accounts[accountId];
        if (!m) return null;
        checkManifest(m, accountId); const state = await readRows(m);
        return { ...publicSummary(m, now()), users: clone([...state.users.values()]), departedIds: [...state.departed],
          cursors: [...state.cursors], nextCursor: m.nextCursor, expectedStart: m.expectedStart,
          pageExpected: m.pageExpected, pageSize: m.pageSize, baseRevision: m.baseRevision, runId: m.runId };
      });
    },
    summaries() {
      return serial(storageArea, async () => {
        const value = await catalog(false), result = {};
        for (const [id, m] of Object.entries(value.accounts)) {
          try { checkManifest(m, id); result[id] = publicSummary(m, now()); }
          catch { result[id] = { accountId: id, corrupt: true, resumable: false }; }
        }
        return result;
      });
    },
    clear(accountId, token) {
      return serial(storageArea, async () => {
        requireId(accountId); const value = await catalog(); await cleanup(value);
        const m = value.accounts[accountId];
        if (!m) { if (token) fail('CHECKPOINT_STALE'); return { cleared: false, accountId }; }
        if (token) assertToken(m, token);
        delete value.accounts[accountId];
        value.garbage.push({ accountId, generation: m.generation, pages: m.pages + 1, bytes: m.bytes });
        await saveCatalog(value); cache.delete(accountId);
        await cleanup(value);
        return { cleared: true, accountId };
      });
    },
    stats() {
      return serial(storageArea, async () => {
        const value = await catalog();
        const keys = [checkpointKeys.catalog];
        for (const m of Object.values(value.accounts)) for (let i = 1; i <= m.pages + 1; i++) keys.push(pageKey(m.account.id, m.generation, i));
        for (const item of value.garbage) for (let i = 1; i <= item.pages; i++) keys.push(pageKey(item.accountId, item.generation, i));
        const bytes = typeof storageArea.getBytesInUse === 'function' ? await storageArea.getBytesInUse(keys) : byteSize(await storageArea.get(keys));
        return { bytes, limitBytes: checkpointLimits.MAX_BYTES, accountCount: Object.keys(value.accounts).length,
          pages: Object.values(value.accounts).reduce((sum, m) => sum + m.pages, 0) };
      });
    },
  };
}
