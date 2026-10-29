/* X Follow Helper • DimmensCK
 * This function is serialized by chrome.scripting.executeScript into X's MAIN
 * world. Keep every dependency inside the function. Never return credentials.
 */
export async function pageCommand(command) {
  'use strict';
  const fail = (code, message, extra = {}) => ({ ok: false, error: { code, message, ...extra } });
  const supportedTypes = new Set(['context', 'refreshContext', 'prepareRoute', 'invalidateScanTemplate', 'scanPage', 'profile', 'reconcileAction', 'unfollow', 'authorStatus', 'authorFollow', 'cancel']);
  const idPattern = /^\d{1,30}$/;
  const handlePattern = /^[A-Za-z0-9_]{1,15}$/;
  const now = () => Date.now();
  const observer = window.__XMH_OBSERVER;
  if (!command || typeof command !== 'object' || !supportedTypes.has(command.type)) return fail('invalid_command', 'Unsupported command.');
  if (location.protocol !== 'https:' || !['x.com', 'twitter.com'].includes(location.hostname)) return fail('wrong_origin', 'Open X in an HTTPS tab.');

  // STOP may arrive while an unfollow preflight is awaiting a read. This registry
  // only cancels work; it has no account-action executor or message listener.
  function cancellations() {
    if (!Object.prototype.hasOwnProperty.call(window, '__XMH_CANCELLED_ACTIONS')) {
      const entries = new Map();
      let refuseAllUntil = 0;
      const prune = () => { for (const [token, at] of entries) if (now() - at > 30 * 60 * 1000) entries.delete(token); };
      const api = Object.freeze({
        cancel(token) {
          prune();
          if (entries.size >= 256 && !entries.has(token)) refuseAllUntil = now() + 30 * 60 * 1000;
          else entries.set(token, now());
        },
        has(token) { prune(); return now() < refuseAllUntil || entries.has(token); }
      });
      Object.defineProperty(window, '__XMH_CANCELLED_ACTIONS', { value: api, writable: false, configurable: false, enumerable: false });
    }
    return window.__XMH_CANCELLED_ACTIONS;
  }
  if (command.type === 'cancel' || command.type === 'unfollow' || command.type === 'authorFollow') {
    if (typeof command.token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(command.token)) return { status: 'refused', ...fail('invalid_action_token', 'An action cancellation token is required.') };
    if (command.type === 'cancel') {
      cancellations().cancel(command.token);
      return { ok: true, cancelled: true };
    }
  }

  function cookie(name) {
    try {
      const prefix = `${name}=`;
      const part = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
      return part ? decodeURIComponent(part.slice(prefix.length)) : null;
    } catch { return null; }
  }

  function identity() {
    const id = /^u=(\d{1,30})$/.exec(cookie('twid') || '')?.[1] || null;
    if (!id) return null;
    let handle = null;
    try {
      const link = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
      const href = link?.getAttribute('href');
      if (href) {
        const url = new URL(href, location.origin);
        const match = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(url.pathname);
        if (url.origin === location.origin && match) handle = match[1];
      }
    } catch { /* Account ID remains authoritative. */ }
    const observed = observer?.read?.();
    const own = observed?.viewer === id ? observed.ownProfile : null;
    if (own?.id === id && (!handle || handle.toLowerCase() === own.handle.toLowerCase())) handle = own.handle;
    return { id, handle };
  }

  function stable(account) {
    const current = identity();
    return !!current && current.id === account.id && (!account.handle || current.handle?.toLowerCase() === account.handle.toLowerCase());
  }

  function safeText(value, max) { return typeof value === 'string' ? value.slice(0, max) : ''; }
  function safeNumber(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
  function explicitBoolean(...values) {
    const known = values.filter(value => typeof value === 'boolean');
    return known.length && known.every(value => value === known[0]) ? known[0] : null;
  }
  function safeErrorCodes(data) {
    return Array.isArray(data?.errors) ? [...new Set(data.errors.slice(0, 32).map(error => error?.code).filter(code => Number.isSafeInteger(code) && code >= 0 && code <= 1_000_000))].slice(0, 8) : [];
  }

  function normalize(raw, followingList = false) {
    if (raw?.__typename === 'UserWithVisibilityResults') raw = raw.user;
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.rest_id || raw.id_str || '');
    if (!idPattern.test(id)) return null;
    const legacy = raw.legacy || {};
    const core = raw.core || {};
    const relationship = raw.relationship_perspectives || {};
    const counts = raw.relationship_counts || {};
    const handle = core.screen_name || legacy.screen_name || raw.screen_name;
    if (typeof handle !== 'string' || !handlePattern.test(handle)) return null;
    let avatar = raw.avatar?.image_url || legacy.profile_image_url_https || raw.profile_image_url_https || '';
    try {
      const url = new URL(avatar);
      if (url.protocol !== 'https:' || url.hostname !== 'pbs.twimg.com') avatar = '';
    } catch { avatar = ''; }
    const typename = raw.__typename || 'User';
    const interstitial = raw.profile_metadata?.profile_interstitial_type;
    const verificationType = raw.verification?.verified_type ?? legacy.verified_type;
    return {
      id, handle,
      name: safeText(core.name || legacy.name || raw.name || handle, 100),
      avatar: safeText(avatar, 1024),
      bio: safeText(raw.profile_bio?.description || legacy.description || raw.description, 280),
      blue: raw.is_blue_verified === true,
      verificationKnown: raw.is_blue_verified === true || raw.is_blue_verified === false && legacy.verified !== true && raw.verified !== true || ['Business', 'Government', 'Blue'].includes(verificationType),
      verificationType: ['Business', 'Government', 'Blue'].includes(verificationType) ? verificationType : null,
      followers: safeNumber(counts.followers ?? legacy.followers_count ?? raw.followers_count),
      followingCount: safeNumber(counts.following ?? legacy.friends_count ?? raw.friends_count),
      followedBy: explicitBoolean(relationship.followed_by, legacy.followed_by, raw.followed_by),
      following: followingList ? true : explicitBoolean(relationship.following, legacy.following, raw.following),
      followRequested: explicitBoolean(relationship.follow_request_sent, legacy.follow_request_sent, raw.follow_request_sent),
      protected: explicitBoolean(legacy.protected, raw.protected),
      unavailable: typename === 'UserUnavailable' || raw.suspended === true || (typeof interstitial === 'string' && interstitial !== '' && interstitial !== 'None'),
      mutualFollowers: []
    };
  }

  function parseFollowing(data, requestedCursor, kind = 'following') {
    if (!data || typeof data !== 'object' || data.errors?.length) return fail('graphql_error', 'X returned an incomplete or rejected query.');
    let root = data.data?.user?.result;
    if (root?.__typename === 'UserWithVisibilityResults') root = root.user;
    if (root?.rest_id !== undefined && String(root.rest_id) !== account.id) return fail('timeline_account_mismatch', 'X returned a timeline for a different account.');
    const candidates = [root?.timeline?.timeline?.instructions, root?.timeline_v2?.timeline?.instructions, kind === 'followers' ? root?.followers_timeline?.timeline?.instructions : root?.following_timeline?.timeline?.instructions];
    const instructions = candidates.find(Array.isArray);
    if (!instructions) return fail('unsupported_timeline_root', 'The relationship-list response root is not supported.', { legacyCode: 'unsupported_timeline' });
    if (instructions.length > 100) return fail('too_many_instructions', 'The relationship-list response exceeds the instruction limit.', { legacyCode: 'unsupported_timeline' });
    const users = [];
    const unique = new Map();
    const departedIds = new Set();
    let bottom = null;
    let terminated = false;
    let emptyEntries = false;
    let seenEntries = false;
    let malformed = false;
    const addUser = (item, entryId) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) { malformed = true; return; }
      if (item.promotedMetadata || item.promoted_metadata) return;
      let raw = item.user_results?.result;
      if (raw?.__typename === 'UserWithVisibilityResults') raw = raw.user;
      const unavailable = item.itemType === 'TimelineTombstone' || raw?.__typename === 'UserUnavailable' || raw?.__typename === 'UserTombstone';
      const entryUserId = /^user-(\d{1,30})$/.exec(String(entryId || ''))?.[1];
      let user, departed = false;
      if (unavailable && entryUserId) {
        if (raw?.rest_id !== undefined && String(raw.rest_id) !== entryUserId) { malformed = true; return; }
        user = normalize(raw, kind === 'following') || { id: entryUserId, handle: '', name: '', avatar: '', bio: '', blue: false, verificationKnown: false, verificationType: null, followers: null, followingCount: null, followedBy: null, following: kind === 'following' ? true : null, unavailable: true, mutualFollowers: [] };
        user.unavailable = true;
        user.followedBy = null;
      } else {
        if (item.itemType && item.itemType !== 'TimelineUser') { malformed = true; return; }
        if (!raw) { malformed = true; return; }
        // An entry can leave a live list while its cursor is being read. A
        // single explicit false means departure; contradictory fields still
        // reject the page rather than silently becoming membership.
        const membership = kind === 'followers'
          ? [raw.relationship_perspectives?.followed_by, raw.legacy?.followed_by, raw.followed_by]
          : [raw.relationship_perspectives?.following, raw.legacy?.following, raw.following];
        if (membership.includes(false) && membership.includes(true)) { malformed = true; return; }
        departed = membership.includes(false);
        user = normalize(raw, kind === 'following' && !departed);
      }
      if (!user) { malformed = true; return; }
      // Exact full Followers membership proves only the reverse relation.
      // It cannot establish the owner's Following membership or a mutual link.
      if (kind === 'followers' && !departed) user.followedBy = user.unavailable ? null : true;
      if (entryUserId && user.id !== entryUserId) { malformed = true; return; }
      if (unique.has(user.id)) {
        const previous = unique.get(user.id);
        if (departedIds.has(user.id) !== departed || previous.followedBy !== user.followedBy || previous.following !== user.following
          || previous.unavailable !== user.unavailable || previous.handle !== user.handle) malformed = true;
        return;
      }
      unique.set(user.id, user);
      if (departed) departedIds.add(user.id); else users.push(user);
    };
    for (const [instructionIndex, instruction] of instructions.entries()) {
      if (instruction?.type === 'TimelineClearCache') {
        // X can begin a fresh root response by clearing the page's old list.
        // A later reset would invalidate rows accumulated by the caller.
        if (requestedCursor !== null || instructionIndex !== 0) return fail('list_restarted', 'X reset the list after this scan began. Start a fresh scan.');
        if (Object.keys(instruction).length !== 1) return fail('unsupported_timeline_instruction', 'X returned an unsupported cache-reset payload; the scan is incomplete.', { legacyCode: 'unsupported_timeline' });
        continue;
      }
      if (!['TimelineAddEntries', 'TimelineReplaceEntry', 'TimelineTerminateTimeline'].includes(instruction?.type)) return fail('unsupported_timeline_instruction', 'X returned an unsupported timeline instruction; the scan is incomplete.', { legacyCode: 'unsupported_timeline' });
      if (instruction.type === 'TimelineTerminateTimeline') {
        if (!['Top', 'Bottom', 'TopAndBottom'].includes(instruction.direction)) return fail('unsupported_timeline_instruction', 'X returned an invalid timeline termination direction.', { legacyCode: 'unsupported_timeline' });
        if (instruction.direction === 'Bottom' || instruction.direction === 'TopAndBottom') terminated = true;
        continue;
      }
      let entries;
      if (instruction.type === 'TimelineAddEntries') {
        if (!Array.isArray(instruction.entries)) return fail('unsupported_timeline_instruction', 'X returned an invalid entries payload; the scan is incomplete.', { legacyCode: 'unsupported_timeline' });
        entries = instruction.entries;
        seenEntries = true;
        if (entries.length === 0) emptyEntries = true;
      } else {
        if (!instruction.entry || typeof instruction.entry !== 'object' || Array.isArray(instruction.entry) || typeof instruction.entry_id_to_replace !== 'string' || !instruction.entry_id_to_replace || instruction.entry_id_to_replace.length > 512) return fail('unsupported_timeline_instruction', 'X returned an invalid replacement-entry payload; the scan is incomplete.', { legacyCode: 'unsupported_timeline' });
        entries = [instruction.entry];
      }
      if (entries.length > 1000) return fail('page_too_large', 'The response exceeds the page limit.');
      for (const entry of entries) {
        const content = entry?.content;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.entryId !== 'string' || !entry.entryId || entry.entryId.length > 512 || !content || typeof content !== 'object' || Array.isArray(content)) { malformed = true; continue; }
        if (entry.promotedMetadata || content.promotedMetadata || content.promoted_metadata) continue;
        if (String(content.cursorType).toLowerCase() === 'bottom') {
          if (typeof content.value !== 'string' || content.value.length > 4096) malformed = true;
          else if (bottom !== null && bottom !== content.value) malformed = true;
          else bottom = content.value;
          continue;
        }
        if (content.entryType === 'TimelineTimelineCursor' || content.cursorType) continue;
        // A Following timeline's actual user items, never arbitrary graph users.
        if (content.itemContent && (String(entry.entryId || '').startsWith('user-') || content.itemContent.itemType === 'TimelineUser')) addUser(content.itemContent, entry.entryId);
        else if (content.entryType === 'TimelineTimelineModule') {
          // Recommendation modules are not Following membership evidence.
          if (!String(entry.entryId || '').startsWith(`${kind}-`)) continue;
          if (!Array.isArray(content.items)) { malformed = true; continue; }
          for (const child of content.items) addUser(child?.item?.itemContent, child?.entryId);
        } else if (String(entry.entryId || '').startsWith('user-')) malformed = true;
      }
    }
    if (malformed) return fail('incomplete_rows', 'Some list rows were unavailable or conflicting; the previous snapshot is kept.');
    const complete = terminated || (seenEntries && emptyEntries && users.length === 0 && bottom === null);
    if (!complete && bottom === null) return fail('cursor_missing', 'The response does not prove the list ended.');
    if (!complete && bottom === requestedCursor) return fail('cursor_repeated', 'X repeated a cursor; the scan is incomplete.');
    return { ok: true, users, ...(departedIds.size ? { departedIds: [...departedIds] } : {}), cursor: complete ? null : bottom, complete };
  }

  function parseProfile(data) {
    if (!data || typeof data !== 'object' || data.errors?.length) return null;
    let raw = data.data?.user?.result;
    if (raw?.__typename === 'UserWithVisibilityResults') raw = raw.user;
    const user = normalize(raw);
    if (!user) return null;
    const facepile = raw?.unmention_info?.mutual_followers || raw?.relationship_perspectives?.mutual_followers || raw?.legacy?.friends_following;
    if (Array.isArray(facepile)) {
      user.mutualFollowers = facepile.slice(0, 12).map(item => {
        const value = typeof item === 'object' && item ? item : null;
        const handle = value?.screen_name || value?.core?.screen_name || value?.legacy?.screen_name;
        return typeof handle === 'string' && handlePattern.test(handle) ? { handle, name: safeText(value.name || value.core?.name || value.legacy?.name || handle, 100) } : null;
      }).filter(Boolean);
    }
    return user;
  }

  async function boundedBody(response, maxBytes) {
    const body = response.body;
    if (body === null) return { text: '' };
    if (!body || typeof body.getReader !== 'function') return { unreadable: true };
    const reader = body.getReader();
    const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Cancellation must not hide the original result. */ } };
    let storage = new Uint8Array(Math.min(65536, maxBytes));
    let length = 0;
    try {
      const declared = response.headers.get('content-length');
      if (typeof declared === 'string' && /^\d{1,12}$/.test(declared) && Number(declared) > maxBytes) { cancel(); return { oversized: true }; }
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array)) { cancel(); return { unreadable: true }; }
        if (chunk.value.byteLength > maxBytes - length) { cancel(); return { oversized: true }; }
        const needed = length + chunk.value.byteLength;
        if (needed > storage.length) {
          const next = new Uint8Array(Math.min(maxBytes, Math.max(needed, storage.length * 2)));
          next.set(storage.subarray(0, length));
          storage = next;
        }
        storage.set(chunk.value, length);
        length = needed;
      }
      return { text: new TextDecoder().decode(storage.subarray(0, length)) };
    } finally { reader.releaseLock(); }
  }

  function rateLimitFrom(headers, status, observedAt = null) {
    const headerInteger = value => typeof value === 'string' && /^\d{1,12}$/.test(value.trim()) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
    const computedAt = now(), receivedAt = Number.isSafeInteger(observedAt) && observedAt > 0 && observedAt <= computedAt ? observedAt : computedAt;
    const elapsed = computedAt - receivedAt, serverDate = Date.parse(headers.get('date') || '');
    const until = timestamp => Number.isFinite(timestamp) && Number.isSafeInteger(timestamp)
      ? Math.max(0, timestamp - receivedAt, Number.isFinite(serverDate) ? timestamp - serverDate : 0) : null;
    const reset = headerInteger(headers.get('x-rate-limit-reset'));
    const resetWait = reset === null ? null : until(reset * 1000);
    const retry = headers.get('retry-after'), retrySeconds = headerInteger(retry);
    const retryWait = retrySeconds !== null && Number.isSafeInteger(retrySeconds * 1000) ? retrySeconds * 1000
      : typeof retry === 'string' && retry.length <= 128 && /[A-Za-z]/.test(retry) ? until(Date.parse(retry)) : null;
    const remaining = headerInteger(headers.get('x-rate-limit-remaining'));
    const waits = [retryWait, status === 429 || remaining === 0 ? resetWait : null].filter(value => value !== null && Number.isSafeInteger(value));
    return { remaining, limit: headerInteger(headers.get('x-rate-limit-limit')),
      resetAt: resetWait === null ? null : receivedAt + resetWait, retryAfterMs: waits.length ? Math.max(0, ...waits.map(value => value - elapsed)) : null };
  }

  async function request(url, options = {}, deadlineMs = 18000, verifyDispatched = false) {
    const startedAt = now();
    const method = options.method || 'GET';
    // Only the caller's scan loop may retry an identical read, after checking
    // STOP and account/document identity. This function always dispatches once.
    const recoverableRead = command.type === 'scanPage' && method === 'GET';
    const path = new URL(url).pathname;
    const operation = /^\/i\/api\/graphql\/[A-Za-z0-9_-]+\/(Following|Followers|UserByRestId|UserByScreenName)$/.exec(path)?.[1]
      || (path === '/i/api/1.1/friends/following/list.json' ? 'CommonFollowers' : path === '/i/api/1.1/friendships/create.json' ? 'AuthorFollow' : 'Unfollow');
    let status = null, dispatched = false, transactionState = 'unavailable';
    let rateLimit = { remaining: null, limit: null, resetAt: null, retryAfterMs: null };
    const requestInfo = () => ({ operation, attempts: dispatched ? 1 : 0, durationMs: Math.max(0, now() - startedAt), status, transactionState });
    const errorInfo = (retryable = false) => ({ ...requestInfo(), method, retryable, retryAfterMs: rateLimit.retryAfterMs, rateLimit, xCodes: [] });
    const responseCodes = async response => {
      // Keep only bounded numeric error codes. Messages can contain account
      // details and are intentionally never returned or logged.
      if (!/\bjson\b/i.test(response.headers.get('content-type') || '')) {
        try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch { /* No response text is needed. */ }
        return [];
      }
      try {
        const body = await boundedBody(response, 65536);
        if (body.oversized || body.unreadable) return [];
        const data = JSON.parse(body.text);
        return safeErrorCodes(data);
      } catch { return []; }
    };
    let signed;
    try { signed = await window.__XFH_TRANSACTION?.generate?.(method, path); } catch { /* Safe fixed diagnostics below. */ }
    if (!signed?.ok || typeof signed.value !== 'string' || !/^[A-Za-z0-9+/]{20,512}$/.test(signed.value)) return fail('transaction_unavailable', 'The current X page could not prepare fresh request metadata.', {
      ...errorInfo(), beforeDispatch: true, transactionReason: /^transaction_[a-z_]+$/.test(signed?.code || '') ? signed.code : 'transaction_library_unavailable'
    });
    transactionState = 'fresh';
    if (!(verifyDispatched && method === 'GET') && typeof command.token === 'string' && cancellations().has(command.token)) return fail('cancelled', 'This request was stopped before dispatch.', { ...errorInfo(), beforeDispatch: true });
    if (!stable(account)) return fail('account_changed', 'The account changed before dispatch.', { ...errorInfo(), beforeDispatch: true });
    const headers = new Headers(options.headers); headers.set('x-client-transaction-id', signed.value);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), deadlineMs);
    try {
      dispatched = true;
      const response = await fetch(url, { ...options, headers, credentials: 'include', cache: 'no-store', redirect: 'error', signal: controller.signal });
      status = response.status;
      rateLimit = rateLimitFrom(response.headers, status);
      if (!response.ok) {
        const xCodes = await responseCodes(response);
        const retryable = recoverableRead && (status === 429 ? rateLimit.retryAfterMs !== null : [502, 503, 504].includes(status));
        const details = { ...errorInfo(retryable), xCodes };
        if (status === 429) return fail('rate_limited', 'X rate-limited this request. Respect the reported wait before retrying.', details);
        if (status === 401 || status === 403) return fail('access_rejected', 'X rejected access. No alternative request is attempted.', details);
        return fail('http_error', `X returned HTTP ${status}.`, details);
      }
      const body = await boundedBody(response, 4 * 1024 * 1024);
      if (body.oversized || body.text?.length > 2 * 1024 * 1024) return fail('response_too_large', 'X returned more data than expected.', errorInfo());
      if (body.unreadable) return fail('invalid_json', 'X returned an unreadable response.', errorInfo());
      let data;
      try { data = JSON.parse(body.text); } catch { return fail('invalid_json', 'X returned an unreadable response.', errorInfo()); }
      return { ok: true, data, request: requestInfo(), rateLimit };
    } catch (error) {
      return fail(error?.name === 'AbortError' ? 'timeout' : 'network_error', error?.name === 'AbortError' ? 'The request timed out.' : 'The request did not return a usable result.', errorInfo(recoverableRead));
    } finally { clearTimeout(timeout); }
  }

  function template(operation, account) {
    const observed = observer?.read?.();
    const found = observed?.viewer === account.id ? observed.templates?.[operation] : null;
    if (!found || found.accountId !== account.id || now() - found.at > 30 * 60 * 1000) return null;
    try {
      const url = new URL(found.url);
      if (url.origin !== location.origin || !new RegExp(`^/i/api/graphql/[A-Za-z0-9_-]{4,100}/${operation}$`).test(url.pathname)) return null;
      const variables = JSON.parse(url.searchParams.get('variables') || '{}');
      if (!variables || typeof variables !== 'object' || Array.isArray(variables)) return null;
      const authorization = found.headers?.authorization;
      const csrf = cookie('ct0');
      if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9%._~-]{10,2000}$/.test(authorization) || !csrf || csrf.length > 512) return null;
      return { url, variables, generation: Number.isSafeInteger(found.generation) && found.generation > 0 ? found.generation : null, observedAt: found.at, headers: {
        authorization, 'x-csrf-token': csrf, 'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes', 'x-twitter-client-language': /^[a-z-]{2,12}$/i.test(document.documentElement.lang) ? document.documentElement.lang : 'en'
      } };
    } catch { return null; }
  }

  const account = identity();
  if (!account) return fail('not_signed_in', 'Sign in to X and reload this page.');
  if (command.type !== 'context' && (!idPattern.test(String(command.accountId || '')) || account.id !== String(command.accountId))) return fail('account_changed', 'The active X account changed; reconnect before continuing.');
  if (command.type === 'context') {
    const state = observer?.read?.();
    const own = state?.viewer === account.id ? state.ownProfile : null;
    const recent = own?.id === account.id && now() - own.at < 60 * 1000;
    // Legacy injected observers can still identify the viewer and provide native
    // templates, but their unverified first-field counts must not defeat refresh validation.
    const verifiedCounts = recent && own.countEvidenceVersion === 1;
    const scanTemplates = Object.fromEntries([['following', 'Following'], ['followers', 'Followers']].map(([kind, operation]) => {
      const value = template(operation, account);
      return [kind, value?.generation ? { generation: value.generation, observedAt: value.observedAt } : null];
    }));
    const scanPreparation = {};
    for (const [kind, operation] of [['following', 'Following'], ['followers', 'Followers']]) {
      const value = state?.viewer === account.id ? state.scanPreparation?.[operation] : null;
      if (value?.operation === operation && value.method === 'GET' && ['pending', 'complete', 'http_error', 'network_error'].includes(value.state)
        && Number.isSafeInteger(value.startedAt) && value.startedAt > 0 && value.startedAt <= now()
        && (value.finishedAt === null || Number.isSafeInteger(value.finishedAt) && value.finishedAt >= value.startedAt && value.finishedAt <= now())
        && (value.status === null || Number.isInteger(value.status) && value.status >= 100 && value.status <= 599)) {
        scanPreparation[kind] = { operation, method: 'GET', state: value.state, startedAt: value.startedAt, finishedAt: value.finishedAt, status: value.status };
      }
    }
    const ready = operation => {
      const value = template(operation, account);
      const preparation = state?.viewer === account.id ? state.scanPreparation?.[operation] : null;
      // Retain old successful templates for exact invalidation, but never call an
      // older template ready after a newer native request failed or is in flight.
      return !!value && (!preparation || preparation.state === 'complete'
        && Number.isSafeInteger(preparation.generation) && preparation.generation <= value.generation);
    };
    return { ok: true, account, url: location.href, ready: ready('Following'), readyFollowers: ready('Followers'), readyProfile: !!account.handle && !!(template('UserByRestId', account) || template('UserByScreenName', account)), readyProfileById: !!template('UserByRestId', account), profileFresh: !!recent, observerReady: observer?.version === 1, observerBuild: Number.isSafeInteger(observer?.build) && observer.build >= 1 ? observer.build : 0, observerInstance: state?.instanceId || null, scanTemplates, scanPreparation, expectedTotal: verifiedCounts ? safeNumber(own.followingCount) : null, expectedFollowers: verifiedCounts ? safeNumber(own.followersCount) : null };
  }
  if (command.type === 'invalidateScanTemplate') {
    if (!['following', 'followers'].includes(command.kind) || !Number.isSafeInteger(command.generation) || command.generation < 1) return fail('invalid_template_generation', 'A specific relationship-list template generation is required.');
    if (observer?.build < 6 || typeof observer?.invalidate !== 'function') return fail('observer_unavailable', 'Reload X after updating the extension.');
    const operation = command.kind === 'followers' ? 'Followers' : 'Following';
    const invalidated = observer.invalidate(operation, command.generation) === true;
    if (invalidated) window.__XFH_TRANSACTION?.invalidate?.();
    return { ok: true, account, invalidated, generation: command.generation };
  }
  // A missing sidebar during hydration does not erase the signed-in numeric ID.
  // By-ID profile reads can recover its handle, and captured API lists remain
  // bound to that ID. Navigation, scrolling and account actions stay name-gated.
  const idOnlyRead = command.type === 'refreshContext' || command.type === 'scanPage' && (!command.source || command.source === 'api');
  if (!account.handle && !idOnlyRead) return fail('account_handle_unknown', 'Wait for your own profile navigation to finish loading.');

  if (command.type === 'refreshContext') {
    // The passive context intentionally expires counts after one minute. A scan
    // may explicitly refresh only the owner's counts without rereading a list.
    let native = template('UserByRestId', account);
    if (native) {
      native.variables.userId = account.id;
      delete native.variables.screen_name;
    } else {
      if (!account.handle) return fail('account_handle_unknown', 'Wait for your own profile identity to load; a name-based query cannot establish it.');
      native = template('UserByScreenName', account);
      if (!native) return fail('needs_profile_template', 'Open an X profile once so the current profile request can be observed.');
      native.variables.screen_name = account.handle;
      delete native.variables.userId;
    }
    native.url.searchParams.set('variables', JSON.stringify(native.variables));
    const result = await request(native.url.href, { headers: native.headers }, 5000);
    if (!stable(account)) return fail('account_changed', 'The active X account changed while refreshing its counts.');
    if (!result.ok) return result;
    if (result.data?.errors?.length) return fail('graphql_error', 'X returned an incomplete or rejected profile query.', {
      ...result.request, method: 'GET', retryable: false, retryAfterMs: result.rateLimit.retryAfterMs,
      rateLimit: result.rateLimit, xCodes: safeErrorCodes(result.data)
    });
    const user = parseProfile(result.data);
    if (!user || user.id !== account.id || account.handle && user.handle.toLowerCase() !== account.handle.toLowerCase()) return fail('target_identity_mismatch', 'X did not confirm the current owner identity.');
    let raw = result.data?.data?.user?.result;
    if (raw?.__typename === 'UserWithVisibilityResults') raw = raw.user;
    const countEvidence = (...values) => {
      const known = values.filter(value => value !== undefined && value !== null);
      return known.length && known.every(value => safeNumber(value) !== null && value === known[0]) ? known[0] : null;
    };
    const expectedTotal = user.unavailable ? null : countEvidence(raw.relationship_counts?.following, raw.legacy?.friends_count, raw.friends_count);
    const expectedFollowers = user.unavailable ? null : countEvidence(raw.relationship_counts?.followers, raw.legacy?.followers_count, raw.followers_count);
    if (expectedTotal === null && expectedFollowers === null) return fail('profile_counts_unavailable', 'X did not return usable current-owner counts.');
    return { ok: true, account: { id: account.id, handle: user.handle }, expectedTotal, expectedFollowers, countsObservedAt: now(), countsSource: 'native-profile', request: result.request };
  }

  if (command.type === 'prepareRoute') {
    if (!['profile', 'following', 'followers'].includes(command.route)) return fail('invalid_route', 'Choose your own profile, Following, or full Followers page.');
    const targetPath = `/${account.handle}${command.route === 'profile' ? '' : `/${command.route}`}`;
    const normalizedPath = path => path.replace(/\/$/, '').toLowerCase();
    const atTarget = () => normalizedPath(location.pathname) === normalizedPath(targetPath);
    if (atTarget()) return { ok: true, account, route: command.route, readyRoute: true, navigated: false };
    const eligible = (anchor, path) => {
      try {
        if (!anchor || anchor.isConnected !== true || typeof anchor.click !== 'function' || !anchor.getClientRects().length) return false;
        if (typeof anchor.checkVisibility === 'function' && !anchor.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
        const style = window.getComputedStyle(anchor);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
        const target = anchor.getAttribute('target');
        if (target && target.toLowerCase() !== '_self') return false;
        if (anchor.hasAttribute('download')) return false;
        if (anchor.getAttribute('aria-disabled') === 'true') return false;
        const href = anchor.getAttribute('href');
        if (!href) return false;
        const address = new URL(href, location.origin);
        return address.origin === location.origin && normalizedPath(address.pathname) === normalizedPath(path);
      } catch { return false; }
    };
    const candidates = command.route === 'profile'
      ? [...document.querySelectorAll('a[data-testid="AppTabBar_Profile_Link"]')]
      : [...document.querySelectorAll('a[href]')].slice(0, 2000);
    const matches = candidates.filter(anchor => eligible(anchor, targetPath));
    let intermediateRoute = null;
    if (!matches.length && command.route === 'followers') {
      const intermediates = ['verified_followers', 'followers_you_follow'];
      const currentIntermediate = intermediates.find(route => normalizedPath(location.pathname) === normalizedPath(`/${account.handle}/${route}`));
      // X may first show a subset tab. Wait there for the full-list link instead
      // of bouncing back to the profile or misclassifying the subset as complete.
      if (currentIntermediate) return { ok: true, account, route: command.route, intermediateRoute: currentIntermediate, readyRoute: false, navigated: false };
      if (normalizedPath(location.pathname) === normalizedPath(`/${account.handle}`)) {
        for (const route of intermediates) {
          const entry = candidates.find(anchor => eligible(anchor, `/${account.handle}/${route}`));
          if (entry) { matches.push(entry); intermediateRoute = route; break; }
        }
      }
    }
    if (!matches.length || (command.route === 'profile' && matches.length !== 1)) return fail('needs_route_navigation', 'The current page has no unambiguous visible link to this own-account route.');
    if (!stable(account)) return fail('account_changed', 'The active X account changed before navigation.');
    try { matches[0].click(); } catch { return fail('route_navigation_failed', 'The native page could not open the requested route.'); }
    if (!stable(account)) return fail('account_changed', 'The active X account changed during navigation.');
    return { ok: true, account, route: command.route, readyRoute: !intermediateRoute && atTarget(), navigated: true, ...(intermediateRoute ? { intermediateRoute } : {}) };
  }

  async function profile(verifyDispatched = false) {
    const author = command.type === 'authorStatus' || command.type === 'authorFollow';
    const userId = author ? '1671136128953638914' : String(command.userId || '');
    const handle = author ? 'DimmensCK' : String(command.handle || '');
    if (!idPattern.test(userId) || !handlePattern.test(handle)) return fail('invalid_target', 'A stable account ID and handle are required.');
    let native = template('UserByRestId', account);
    const lookupById = !!native;
    if (native) native.variables.userId = userId;
    else {
      native = template('UserByScreenName', account);
      if (!native) return fail('needs_profile_template', 'Open an X profile once so the current profile request can be observed.');
      native.variables.screen_name = handle;
    }
    native.url.searchParams.set('variables', JSON.stringify(native.variables));
    const result = await request(native.url.href, { headers: native.headers }, 18000, verifyDispatched);
    if (!stable(account)) return fail('account_changed', 'The active X account changed.');
    if (!result.ok) return result;
    if (result.data?.errors?.length) return fail('graphql_error', 'X returned an incomplete or rejected profile query.', {
      ...result.request, method: 'GET', retryable: false, retryAfterMs: result.rateLimit.retryAfterMs,
      rateLimit: result.rateLimit, xCodes: safeErrorCodes(result.data)
    });
    const user = parseProfile(result.data);
    if (!user || user.id !== userId || ((!lookupById || author) && user.handle.toLowerCase() !== handle.toLowerCase())) return fail('target_identity_mismatch', 'X did not confirm this account identity. Re-scan before acting.');
    return { ok: true, account, user, observedAt: now() };
  }

  if (command.type === 'reconcileAction' || command.type === 'authorStatus') return profile();
  if (command.type === 'profile') {
    const checked = await profile();
    if (!checked.ok) return checked;
    const source = 'native-common-followers';
    const unknown = error => ({
      ...checked,
      knownFollowers: {
        ok: false, users: [], total: null, source, observedAt: null, error,
        ...(checked.user.mutualFollowers?.length ? { fallback: { source: 'profile', users: checked.user.mutualFollowers, observedAt: checked.observedAt } } : {})
      }
    });
    const native = template('UserByRestId', account) || template('UserByScreenName', account) || template('Following', account);
    if (!native) return unknown({ code: 'profile_context_expired', message: 'The current native request context is unavailable.' });
    const address = new URL('/i/api/1.1/friends/following/list.json', location.origin);
    address.searchParams.set('user_id', checked.user.id);
    address.searchParams.set('count', '3');
    address.searchParams.set('cursor', '-1');
    address.searchParams.set('with_total_count', 'true');
    const result = await request(address.href, { headers: native.headers });
    if (!stable(account)) return fail('account_changed', 'The active X account changed while reading common followers.');
    if (!result.ok) return unknown(result.error);
    const data = result.data;
    if (!data || typeof data !== 'object' || data.errors?.length || !Array.isArray(data.users) || data.users.length > 100) return unknown({ code: 'common_followers_unavailable', message: 'X did not return a usable common-followers response.' });
    const total = safeNumber(data.total_count);
    if (total !== null && total < data.users.length) return unknown({ code: 'common_followers_conflict', message: 'The common-followers count conflicts with the returned users.' });
    const members = [], seen = new Set();
    for (const item of data.users) {
      const id = typeof item?.id_str === 'string' ? item.id_str : '';
      const handle = item?.screen_name;
      if (!idPattern.test(id) || typeof handle !== 'string' || !handlePattern.test(handle) || seen.has(id)) return unknown({ code: 'common_followers_unavailable', message: 'X returned incomplete or duplicate common-followers identities.' });
      seen.add(id);
      if (members.length < 3) members.push({ id, handle, name: safeText(item.name || handle, 100) });
    }
    return { ...checked, knownFollowers: { ok: true, users: members, total, source, observedAt: now() } };
  }

  if (command.type === 'scanPage') {
    if (command.token !== undefined && (typeof command.token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(command.token))) return fail('invalid_scan_token', 'A valid read cancellation token is required.');
    const cancelled = () => typeof command.token === 'string' && cancellations().has(command.token);
    if (cancelled()) return fail('cancelled', 'This scan was stopped.');
    if (command.cursor !== null && command.cursor !== undefined && (typeof command.cursor !== 'string' || command.cursor.length > 4096)) return fail('invalid_cursor', 'Invalid pagination cursor.');
    const cursor = command.cursor ?? null;
    const kind = command.kind || 'following';
    if (!['following', 'followers'].includes(kind)) return fail('invalid_list_kind', 'Choose the full Following or Followers list.');
    const operation = kind === 'followers' ? 'Followers' : 'Following';
    const source = command.source || 'api';
    if (source !== 'api' && source !== 'scroll') return fail('invalid_source', 'Unsupported scan method.');
    if (command.pageSize !== undefined && (!Number.isInteger(command.pageSize) || command.pageSize < 1 || command.pageSize > 100)) return fail('invalid_page_size', 'The page size must be between 1 and 100.');
    let preferredPageSize = command.pageSize ?? 100;
    if (command.nativeRetryAfterGeneration !== undefined && (source !== 'scroll' || !Number.isSafeInteger(command.nativeRetryAfterGeneration) || command.nativeRetryAfterGeneration < 1)) return fail('invalid_native_retry', 'A specific native request generation is required.');
    const afterTime = Number.isSafeInteger(command.afterTime) && command.afterTime > 0 && command.afterTime <= now() ? command.afterTime : null;
    if (command.afterTime !== undefined && afterTime === null) return fail('invalid_observation_time', 'A valid scan start time is required.');
    let parsed;
    let observation;
    let transport;
    if (source === 'api') {
      const native = template(operation, account);
      if (!native) return kind === 'followers' ? fail('needs_followers_page', 'Open your own full Followers page and wait for its list to load. Followers you know is not a complete list.') : fail('needs_following_page', 'Open your own Following page and wait for its list to load.');
      const state = observer?.read?.(), observed = cursor === null && afterTime !== null ? observer?.page?.(null, operation) : null;
      const sequence = state?.sequences?.[operation] ?? (kind === 'following' ? state?.sequence : null);
      const freshRoot = observed && observed.operation === operation && observed.accountId === account.id
        && observed.instanceId === state?.instanceId && observed.epoch === state?.epoch && observed.sequence === sequence
        && observed.at >= afterTime && observed.at <= now() && now() - observed.at < 60_000;
      if (freshRoot) {
        // A successful native response is stronger evidence than replaying the
        // same freshly observed request. Never reuse a root from before this scan.
        parsed = parseFollowing(observed.data, null, kind);
        transport = { request: { operation, attempts: 0, durationMs: 0, status: 200, transport: 'native-observed', templateGeneration: native.generation,
          requestedCount: observed.generation === native.generation && Number.isInteger(native.variables.count)
            && native.variables.count >= 1 && native.variables.count <= 100 ? native.variables.count : null },
          rateLimit: rateLimitFrom({ get: name => observed.responseHeaders?.[name] ?? null }, 200, observed.at), xCodes: safeErrorCodes(observed.data) };
      } else {
        const originalPageSize = Number.isInteger(native.variables.count) && native.variables.count >= 1 && native.variables.count <= 100 ? native.variables.count : null;
        native.variables.userId = account.id;
        if (cursor === null) delete native.variables.cursor;
        else native.variables.cursor = cursor;
        // The same web Following/Followers operations support a bounded 100
        // request size. Keep the native features and cursor; X may return fewer
        // rows, so only its terminal cursor ends this traversal.
        native.variables.count = preferredPageSize;
        native.url.searchParams.set('variables', JSON.stringify(native.variables));
        let result = await request(native.url.href, { headers: native.headers }), pageSizeFallback = false;
        // A 400 may reject the larger count. Retry only this read once with the
        // observed count and the exact same cursor; never use this path for an
        // access rejection, rate limit, server failure, or any account write.
        if (!result.ok && result.error?.status === 400 && !(result.error.retryAfterMs > 0) && !(result.error.rateLimit?.retryAfterMs > 0)
          && result.error.rateLimit?.remaining !== 0 && !result.error.xCodes?.length && originalPageSize !== null && originalPageSize !== preferredPageSize) {
          if (cancelled()) return fail('cancelled', 'This scan was stopped.');
          if (!stable(account)) return fail('account_changed', 'The active X account changed during the scan.');
          preferredPageSize = originalPageSize; pageSizeFallback = true; native.variables.count = preferredPageSize;
          native.url.searchParams.set('variables', JSON.stringify(native.variables));
          result = await request(native.url.href, { headers: native.headers });
        }
        if (cancelled()) return fail('cancelled', 'This scan was stopped.');
        if (!stable(account)) return fail('account_changed', 'The active X account changed during the scan.');
        if (!result.ok) return { ...result, error: { ...result.error, templateGeneration: native.generation, preferredPageSize,
          attempts: (Number.isInteger(result.error?.attempts) ? result.error.attempts : 0) + Number(pageSizeFallback),
          requestedCount: preferredPageSize, pageSizeFallback, fallbackReason: pageSizeFallback ? 'http_400_page_size' : null, transport: 'replay' } };
        transport = { request: { ...result.request, attempts: pageSizeFallback ? 2 : result.request.attempts,
          pageSizeFallback, fallbackReason: pageSizeFallback ? 'http_400_page_size' : null,
          requestedCount: preferredPageSize, transport: 'replay', templateGeneration: native.generation }, rateLimit: result.rateLimit, xCodes: safeErrorCodes(result.data) };
        parsed = parseFollowing(result.data, cursor, kind);
      }
    } else {
      const ownPath = new RegExp(`^/${account.handle}/${kind}/?$`, 'i');
      if (!ownPath.test(location.pathname)) return fail(kind === 'followers' ? 'needs_followers_page' : 'needs_following_page', 'Scroll mode requires the full own-account relationship-list page.');
      if (!observer?.page || !observer?.read) return fail('observer_unavailable', 'Reload X after enabling the extension.');
      const initial = observer.read();
      const listSequence = value => value.sequences?.[operation] ?? (kind === 'following' ? value.sequence : null);
      observation = { instanceId: initial.instanceId, epoch: initial.epoch, sequence: listSequence(initial), kind };
      if (!observation.instanceId) return fail('observer_unavailable', 'Reload X after updating the extension.');
      if (!Number.isSafeInteger(observation.sequence) || (kind === 'followers' && afterTime === null)) return fail('observer_unavailable', 'A fresh full-list observation is required.');
      if (cursor !== null && (!command.observation || command.observation.instanceId !== observation.instanceId || command.observation.epoch !== observation.epoch || command.observation.sequence !== observation.sequence || (command.observation.kind || 'following') !== kind)) return fail('list_restarted', 'The observed list changed between pages. Start a fresh scan.');
      const sequence = observation.sequence;
      let entry = observer.page(cursor, operation);
      if (cursor === null && (!entry || afterTime !== null && entry.at < afterTime)) return fail(kind === 'followers' ? 'needs_followers_reload' : 'needs_following_reload', 'Open a fresh own-account list to observe its beginning.');
      const deadline = now() + 20000, waitStarted = now();
      let nudges = 0, lastNudge = 0, latestRequest = null;
      const matchingRequest = () => {
        const value = observer.request?.(cursor, operation);
        return value?.accountId === account.id && value.instanceId === observation.instanceId && value.epoch === observation.epoch
          && value.sequence === sequence && value.operation === operation && value.cursor === cursor
          && Number.isSafeInteger(value.generation) && value.generation > 0 ? value : null;
      };
      const requestFailure = (value, code, message, retryable = false) => {
        const rateLimit = rateLimitFrom({ get: name => value?.responseHeaders?.[name] ?? null }, value?.status ?? 0, value?.finishedAt);
        return fail(code, message, { operation, method: 'GET', status: value?.status ?? null, attempts: 0,
          transport: 'native-observed', durationMs: Math.max(0, now() - (value?.startedAt || waitStarted)),
          requestState: value?.state || 'not_observed', nativeRequestGeneration: value?.generation ?? null,
          retryable, retryAfterMs: rateLimit.retryAfterMs, rateLimit, xCodes: [] });
      };
      for (;;) {
        if (cancelled()) return fail('cancelled', 'This scan was stopped.');
        if (!stable(account)) return fail('account_changed', 'The active X account changed during the scan.');
        if (!ownPath.test(location.pathname)) return fail(kind === 'followers' ? 'needs_followers_page' : 'needs_following_page', 'The native relationship page changed during the read.');
        const current = observer.read();
        if (current.instanceId !== observation.instanceId || listSequence(current) !== sequence || current.epoch !== observation.epoch) return fail('list_restarted', 'X restarted the list. Start a fresh scan.');
        latestRequest = matchingRequest();
        if (entry && latestRequest?.generation > entry.generation) entry = null;
        if (entry) break;
        let ignoredWaitedFailure = false;
        if (latestRequest?.state === 'http_error') {
          const rate = rateLimitFrom({ get: name => latestRequest.responseHeaders?.[name] ?? null }, latestRequest.status, latestRequest.finishedAt);
          ignoredWaitedFailure = latestRequest.status === 429 && latestRequest.generation === command.nativeRetryAfterGeneration && rate.retryAfterMs === 0;
          if (!ignoredWaitedFailure) return requestFailure(latestRequest, latestRequest.status === 429 ? 'rate_limited' : [401,403].includes(latestRequest.status) ? 'access_rejected' : 'http_error', 'X rejected the native list request.', latestRequest.status === 429 && rate.retryAfterMs !== null);
        } else if (latestRequest?.state === 'network_error') return requestFailure(latestRequest, 'network_error', 'The native list request failed.');
        else if (latestRequest?.state === 'complete') return requestFailure(latestRequest, 'native_response_unusable', 'X completed the native request without a usable matching page.');
        if (now() >= deadline) return requestFailure(latestRequest, latestRequest?.state === 'pending' ? 'native_request_pending' : 'scroll_incomplete', latestRequest?.state === 'pending' ? 'The native list request is still pending.' : 'X has not issued a usable request for the next cursor.');
        if (command.nativeRetryAfterGeneration !== undefined && !latestRequest) return fail('invalid_native_retry', 'The waited native request no longer belongs to this list.');
        // A native request already in flight owns pagination. Do not repeatedly
        // scroll beneath it. If no request starts, re-enter the bottom once.
        if (latestRequest?.state !== 'pending' && (nudges === 0 || nudges < 3 && now() - lastNudge >= (nudges === 1 ? 1000 : 500))) {
          const scrolling = document.scrollingElement || document.documentElement;
          const viewport = Number(scrolling.clientHeight) || Number(window.innerHeight) || 0;
          const bottom = Math.max(0, Number(scrolling.scrollHeight) - viewport);
          const top = nudges === 1 ? Math.max(0, bottom - Math.min(160, viewport || 160)) : bottom;
          if (cancelled()) return fail('cancelled', 'This scan was stopped.');
          window.scrollTo({ top, behavior: 'instant' }); nudges++; lastNudge = now();
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        entry = observer.page(cursor, operation);
      }
      if (entry.accountId !== account.id || entry.instanceId !== observation.instanceId || entry.sequence !== sequence || entry.epoch !== observation.epoch || (entry.operation && entry.operation !== operation) || (afterTime !== null && entry.at < afterTime) || entry.at > now() || now() - entry.at > 30 * 60 * 1000) return fail('stale_observation', 'The observed list no longer belongs to this scan.');
      parsed = parseFollowing(entry.data, cursor, kind);
      transport = { request: { operation, attempts: 0, durationMs: 0, status: 200, transport: 'native-observed', templateGeneration: Number.isSafeInteger(entry.generation) ? entry.generation : null,
        nativeRequestGeneration: Number.isSafeInteger(entry.generation) ? entry.generation : null, requestState: 'complete' }, rateLimit: rateLimitFrom({ get: name => entry.responseHeaders?.[name] ?? null }, 200, entry.at), xCodes: safeErrorCodes(entry.data) };
    }
    if (!parsed.ok) return transport ? { ...parsed, error: { ...parsed.error, ...transport.request, method: 'GET', retryable: false, retryAfterMs: transport.rateLimit.retryAfterMs, rateLimit: transport.rateLimit, xCodes: transport.xCodes } } : parsed;
    if (cancelled()) return fail('cancelled', 'This scan was stopped.');
    if (!stable(account)) return fail('account_changed', 'The active X account changed during the scan.');
    return { ...parsed, account, kind, source, observedAt: now(), ...(observation ? { observation } : {}), ...(source === 'api' ? { preferredPageSize } : {}), ...transport };
  }

  // The only Follow target is the visibly named author. The trusted extension
  // button owns consent and the durable receipt; page links cannot invoke it.
  if (command.type === 'authorFollow') {
    if (cancellations().has(command.token)) return { status: 'refused', ...fail('cancelled', 'This action was stopped before dispatch.') };
    const checked = await profile();
    if (!checked.ok) return { ...checked, status: 'refused' };
    const user = checked.user;
    if (user.id === account.id || user.unavailable) return { status: 'refused', ...fail('relationship_not_eligible', 'The author cannot be followed from this account.') };
    if (user.following === true || user.followRequested === true) return { ok: true, status: 'confirmed', outcome: user.following === true ? 'already_following' : 'requested', account, user, observedAt: now(), notSent: true };
    if (user.following !== false || user.followRequested === null && user.protected !== false) return { status: 'refused', ...fail('relationship_unknown', 'X did not confirm that a new follow can be sent.') };
    const native = template('Following', account) || template('UserByRestId', account) || template('UserByScreenName', account);
    if (!native || !stable(account)) return { status: 'refused', ...fail('account_changed', 'The active account or request context is no longer valid.') };
    if (cancellations().has(command.token)) return { status: 'refused', ...fail('cancelled', 'This action was stopped before dispatch.') };
    const result = await request(`${location.origin}/i/api/1.1/friendships/create.json`, {
      method: 'POST', headers: { ...native.headers, 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ user_id: user.id }).toString()
    });
    if (!result.ok && result.error?.beforeDispatch === true) return { ...result, status: 'refused', account, userId: user.id };
    if (!result.ok || !stable(account)) return { ok: false, status: 'unknown', account, userId: user.id, error: result.error || { code: 'account_changed' } };
    const responseId = String(result.data?.id_str || result.data?.rest_id || '');
    if (result.data?.errors?.length || responseId !== user.id || result.data?.following !== true && result.data?.follow_request_sent !== true) return { ok: false, status: 'unknown', account, userId: user.id, error: { code: 'unconfirmed_response' } };
    const verified = await profile(true);
    if (!verified.ok || verified.user.following !== true && verified.user.followRequested !== true) return { ok: false, status: 'unknown', account, userId: user.id, error: { code: 'verification_unavailable' } };
    return { ok: true, status: 'confirmed', outcome: verified.user.following === true ? 'followed' : 'requested', account, user: verified.user, observedAt: now() };
  }

  // Only the trusted extension page calls this via scripting.executeScript.
  // There is deliberately no page-message or URL-triggered mutation channel.
  if (command.type === 'unfollow') {
    if (cancellations().has(command.token)) return { status: 'refused', ...fail('cancelled', 'This action was stopped before dispatch.') };
    const checked = await profile();
    if (!checked.ok) return { ...checked, status: 'refused' };
    const user = checked.user;
    if (user.id === account.id || user.following !== true || user.unavailable) return { status: 'refused', ...fail('relationship_not_eligible', 'A fresh, explicit following relationship to an available target is required.') };
    const native = template('Following', account) || template('UserByRestId', account) || template('UserByScreenName', account);
    if (!native || !stable(account)) return { status: 'refused', ...fail('account_changed', 'The active account or request context is no longer valid.') };
    if (cancellations().has(command.token)) return { status: 'refused', ...fail('cancelled', 'This action was stopped before dispatch.') };
    const result = await request(`${location.origin}/i/api/1.1/friendships/destroy.json`, {
      method: 'POST', headers: { ...native.headers, 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ user_id: user.id }).toString()
    });
    if (!result.ok && result.error?.beforeDispatch === true) return { ...result, status: 'refused', account, userId: user.id };
    // After dispatch, every unusable result is UNKNOWN. Never try a second route.
    if (!result.ok || !stable(account)) return { ok: false, status: 'unknown', account, userId: user.id, error: result.error || { code: 'account_changed', message: 'The account changed after dispatch.' } };
    const responseId = String(result.data?.id_str || result.data?.rest_id || '');
    if (result.data?.errors?.length || responseId !== user.id || result.data?.following !== false) return { ok: false, status: 'unknown', account, userId: user.id, error: { code: 'unconfirmed_response', message: 'The response did not prove the requested relationship changed.' } };
    const verified = await profile(true);
    if (!verified.ok || verified.user.following !== false) return { ok: false, status: 'unknown', account, userId: user.id, error: { code: 'verification_unavailable', message: 'A fresh read could not verify the result. Do not retry this action.' } };
    return { ok: true, status: 'confirmed', account, user: verified.user, userId: user.id, observedAt: now() };
  }
  return fail('invalid_command', 'Unsupported command.');
}
