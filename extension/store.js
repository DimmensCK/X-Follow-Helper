// Atomic, bounded browser-local storage. Author: DimmensCK.
import { constants, defaultState, cleanSettings, requireId, reconcile, reconcileFollowerScan, reconcileFollowerObservation, backupSchema, relationshipEvidence, validateBackup, byteSize, pruneActions, pruneEvents } from './core.js';

async function stateDigest(state) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(state)));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function recoverPending(state, detail) {
  const changed = [];
  for (const account of Object.values(state.accounts)) for (const action of [...account.actions, ...(account.authorFollow ? [account.authorFollow] : [])]) if (action.status === 'pending') {
    changed.push({ action, detail: action.detail, updatedAt: action.updatedAt });
    action.status = 'unknown'; action.detail = detail; action.updatedAt = Date.now();
  }
  if (byteSize({ [constants.STORAGE_KEY]: state }) > constants.MAX_BYTES) {
    for (const previous of changed) { previous.action.detail = previous.detail; previous.action.updatedAt = previous.updatedAt; }
  }
  return changed.length;
}

function mergeRelationshipEvidence(local, incoming) {
  // Equal or missing observation times cannot establish an ordering. Keep the
  // local record in those cases, rather than assigning the import time to it.
  if (!local.lastExplicitAt || !incoming.lastExplicitAt || local.lastExplicitAt === incoming.lastExplicitAt
    || local.lastExplicitFollowedBy === null || incoming.lastExplicitFollowedBy === null) return local;
  const [older, newer] = local.lastExplicitAt < incoming.lastExplicitAt ? [local, incoming] : [incoming, local];
  let lostAt = null;
  if (newer.lastExplicitFollowedBy === false) {
    if (older.lastExplicitFollowedBy === true) {
      lostAt = newer.lostAt && newer.lostAt > older.lastExplicitAt ? newer.lostAt : newer.lastExplicitAt;
    } else {
      // Separate backups may have missed different regain cycles. A continuing
      // false cannot erase the later loss episode already evidenced by either.
      lostAt = Math.max(older.lostAt || 0, newer.lostAt || 0) || null;
    }
  }
  return { ...newer, lostAt };
}

function mergeFollowers(local, incoming, summary) {
  if (!incoming.followers) return;
  if (!local.followers) {
    if (local.followerObservation && incoming.followers.observedAt >= local.followerObservation.observedAt) {
      summary.preservedFollowerObservations++;
      return;
    }
    local.followers = structuredClone(incoming.followers);
    summary.restoredFollowerBaselines++;
    summary.addedFollowers += incoming.followers.users.length;
    summary.addedFollowerMissing += incoming.followers.missing.length;
    return;
  }
  summary.preservedFollowerSnapshots++;
  const current = local.followers, source = incoming.followers;
  // Current membership/observation time never regresses. A newer foreign
  // snapshot requires a fresh local scan, not a blind replacement at import.
  if (source.observedAt > current.observedAt) return;
  current.baselineAt = Math.min(current.baselineAt, source.baselineAt);
  const present = new Map(current.users.map(row => [row.id, row]));
  const missing = new Map(current.missing.map(row => [row.id, row]));
  const localPending = new Map((current.pendingMissing || []).map(row => [row.id, row]));
  for (const evidence of source.missing) {
    const member = present.get(evidence.id);
    if (member && (!member.unavailable || (member.lastSeenAt && member.lastSeenAt > evidence.lastSeenAt))) continue;
    const waiting = localPending.get(evidence.id);
    if (waiting && waiting.lastSeenAt >= evidence.missingSince) continue;
    if (waiting) localPending.delete(evidence.id);
    const previous = missing.get(evidence.id);
    if (!previous) { missing.set(evidence.id, { ...evidence }); summary.addedFollowerMissing++; continue; }
    // A later reliable presence can begin a newer absence episode. An older
    // presence cannot roll a known later episode back across that reappearance.
    if (evidence.lastSeenAt > previous.lastSeenAt
      || (evidence.lastSeenAt === previous.lastSeenAt && evidence.missingSince < previous.missingSince)) {
      missing.set(evidence.id, { ...evidence }); summary.updatedFollowerMissing++;
    }
  }
  current.missing = [...missing.values()];
  if (current.pendingMissing) current.pendingMissing = [...localPending.values()];
  if (source.pendingMissing) {
    const pending = new Map((current.pendingMissing || []).map(row => [row.id, row]));
    for (const row of source.pendingMissing) {
      const member = present.get(row.id), lost = missing.get(row.id), prior = pending.get(row.id);
      if (member && !member.unavailable && member.lastSeenAt >= row.lastSeenAt || lost && lost.missingSince > row.lastSeenAt) continue;
      if (lost) missing.delete(row.id);
      if (member?.unavailable && (member.lastSeenAt || 0) < row.lastSeenAt) {
        member.lastSeenAt = row.lastSeenAt; member.handle ||= row.handle; member.name ||= row.name;
      }
      if (!member && (!prior || prior.lastSeenAt < row.lastSeenAt)) pending.set(row.id, { ...row });
    }
    current.missing = [...missing.values()]; current.pendingMissing = [...pending.values()];
  }
}

function mergeImport(current, data) {
  const incoming = validateBackup(data), candidate = structuredClone(current);
  const empty = Object.keys(current.accounts).length === 0;
  const summary = { accountsTotal: 0, addedAccounts: [], preservedAccounts: [], addedUsers: 0, addedEvents: 0, addedIgnored: 0,
    addedActions: 0, addedHistory: 0, updatedHistory: 0, addedFollowers: 0, restoredFollowerBaselines: 0, restoredFollowingBaselines: 0,
    addedFollowerMissing: 0, updatedFollowerMissing: 0, preservedFollowerSnapshots: 0,
    restoredFollowerObservations: 0, preservedFollowerObservations: 0, addedFollowerObservedUsers: 0,
    unresolvedCount: 0, settings: empty ? 'restored' : 'kept', activationRequired: empty,
    bytes: 0, limitBytes: constants.MAX_BYTES, conflicts: [] };
  const conflict = (code, accountId, userId) => { if (summary.conflicts.length < 20) summary.conflicts.push({ code, ...(accountId ? { accountId } : {}), ...(userId ? { userId } : {}) }); };
  if (empty) candidate.settings = { ...incoming.settings, enabled: false };
  for (const [id, imported] of Object.entries(incoming.accounts)) {
    const local = candidate.accounts[id];
    if (!local) {
      candidate.accounts[id] = imported;
      summary.addedAccounts.push({ id, handle: imported.handle, users: imported.users.length });
      summary.addedUsers += imported.users.length; summary.addedEvents += imported.events.length;
      summary.addedIgnored += imported.ignored.length; summary.addedActions += imported.actions.length;
      summary.addedHistory += imported.relationshipHistory?.length || 0;
      if (imported.followers) {
        summary.restoredFollowerBaselines++; summary.addedFollowers += imported.followers.users.length;
        summary.addedFollowerMissing += imported.followers.missing.length;
      }
      if (imported.followerObservation) {
        summary.restoredFollowerObservations++; summary.addedFollowerObservedUsers += imported.followerObservation.users.length;
      }
      continue;
    }
    const baselineBefore = local.baselineAt;
    let restoredEvents = 0, restoredHistory = 0;
    // Only fill an absent Following scope. Any existing rows, historical
    // evidence or receipts retain the established current-data-priority rule.
    if (!local.lastScan?.complete && !local.users.length && !(local.relationshipHistory?.length) && !local.events.length && !local.actions.length
      && imported.lastScan?.complete === true) {
      local.users = structuredClone(imported.users); local.lastScan = structuredClone(imported.lastScan); local.baselineAt = imported.baselineAt;
      local.events = structuredClone(imported.events); restoredEvents = imported.events.length;
      if (imported.relationshipHistory?.length) { local.relationshipHistory = structuredClone(imported.relationshipHistory); restoredHistory = imported.relationshipHistory.length; }
      summary.restoredFollowingBaselines++; summary.addedUsers += imported.users.length;
    }
    const hadLocalFollowerView = Boolean(local.followers || local.followerObservation);
    mergeFollowers(local, imported, summary);
    if (imported.authorFollow) {
      const unresolvedAuthor = value => value && ['pending', 'unknown'].includes(value.status);
      if (!local.authorFollow || imported.authorFollow.id !== local.authorFollow.id && unresolvedAuthor(imported.authorFollow) && !unresolvedAuthor(local.authorFollow)) local.authorFollow = structuredClone(imported.authorFollow);
      else if (unresolvedAuthor(imported.authorFollow) && unresolvedAuthor(local.authorFollow) && imported.authorFollow.id !== local.authorFollow.id) conflict('AUTHOR_FOLLOW_UNRESOLVED', id);
    }
    if (imported.followerObservation) {
      // Imported positive observations cannot supersede a local observation or
      // local complete snapshot, even when the foreign file has a later date.
      if (hadLocalFollowerView) summary.preservedFollowerObservations++;
      else {
        local.followerObservation = structuredClone(imported.followerObservation);
        summary.restoredFollowerObservations++; summary.addedFollowerObservedUsers += imported.followerObservation.users.length;
      }
    }
    if ((local.followers?.missing.length || 0) > constants.MAX_FOLLOWER_MISSING) conflict('FOLLOWER_HISTORY_LIMIT', id);
    // Existing current rows and lastScan are authoritative. Imported observations
    // never resurrect an old following=true after a newer confirmed local action.
    const receipts = new Map(local.actions.map(action => [action.id, action]));
    const unresolved = new Map(local.actions.filter(action => ['pending', 'unknown'].includes(action.status)).map(action => [action.userId, action]));
    let addedActions = 0;
    for (const action of imported.actions) {
      const same = receipts.get(action.id);
      if (same) { if (same.userId !== action.userId) conflict('ACTION_ID_CONFLICT', id, action.userId); continue; }
      if (['pending', 'unknown'].includes(action.status)) {
        const protectedAction = unresolved.get(action.userId);
        if (protectedAction) conflict('UNRESOLVED_IMPORT_CONFLICT', id, action.userId);
        else unresolved.set(action.userId, action);
      }
      receipts.set(action.id, action); addedActions++;
    }
    const ignored = [...new Set([...local.ignored, ...imported.ignored])];
    const eventKey = event => `${event.type}:${event.userId}:${event.at}`;
    const events = new Map(local.events.map(event => [eventKey(event), event]));
    const olderComplete = imported.lastScan?.complete === true && local.lastScan?.complete === true
      && imported.lastScan.finishedAt <= local.lastScan.finishedAt && imported.baselineAt <= imported.lastScan.finishedAt;
    let addedEvents = restoredEvents;
    if (olderComplete) for (const event of imported.events) {
      if (event.at > imported.lastScan.finishedAt || events.has(eventKey(event))) continue;
      events.set(eventKey(event), event); addedEvents++;
    }
    if (olderComplete) local.baselineAt = Math.min(local.baselineAt, imported.baselineAt);
    const currentIds = new Set(local.users.map(user => user.id));
    const history = new Map((local.relationshipHistory || []).map(item => [item.id, item]));
    let addedHistory = restoredHistory, updatedHistory = 0;
    if (olderComplete) {
      const incomingHistory = [...(imported.relationshipHistory || []), ...imported.users.map(relationshipEvidence).filter(Boolean)];
      for (const evidence of incomingHistory) {
        if (currentIds.has(evidence.id) || !evidence.lastExplicitAt || evidence.lastExplicitAt > imported.lastScan.finishedAt
          || (evidence.lostAt && evidence.lostAt > imported.lastScan.finishedAt)) continue;
        const previous = history.get(evidence.id);
        if (!previous) { history.set(evidence.id, evidence); addedHistory++; }
        else {
          const merged = mergeRelationshipEvidence(previous, evidence);
          if (merged.lastExplicitFollowedBy !== previous.lastExplicitFollowedBy || merged.lastExplicitAt !== previous.lastExplicitAt || merged.lostAt !== previous.lostAt) {
            history.set(evidence.id, merged); updatedHistory++;
          }
        }
      }
    }
    if (history.size) local.relationshipHistory = [...history.values()]; else delete local.relationshipHistory;
    if (history.size > constants.MAX_HISTORY) conflict('HISTORY_LIMIT', id);
    local.events = [...events.values()]; local.ignored = ignored; local.actions = [...receipts.values()];
    if (local.events.length > constants.MAX_EVENTS) conflict('EVENT_LIMIT', id);
    if (local.ignored.length > constants.MAX_USERS) conflict('IGNORE_LIMIT', id);
    if (local.actions.length > constants.MAX_USERS + constants.MAX_EVENTS) conflict('ACTION_LIMIT', id);
    const addedIgnored = ignored.length - current.accounts[id].ignored.length;
    summary.preservedAccounts.push({ id, handle: local.handle, users: local.users.length, baselineBefore, baselineAfter: local.baselineAt, addedEvents, addedIgnored, addedActions, addedHistory, updatedHistory });
    summary.addedEvents += addedEvents; summary.addedIgnored += addedIgnored; summary.addedActions += addedActions;
    summary.addedHistory += addedHistory; summary.updatedHistory += updatedHistory;
  }
  for (const [id, local] of Object.entries(current.accounts)) if (!incoming.accounts[id]) {
    summary.preservedAccounts.push({ id, handle: local.handle, users: local.users.length, baselineBefore: local.baselineAt,
      baselineAfter: local.baselineAt, addedEvents: 0, addedIgnored: 0, addedActions: 0, addedHistory: 0, updatedHistory: 0 });
  }
  summary.accountsTotal = Object.keys(candidate.accounts).length;
  if (summary.accountsTotal > constants.MAX_ACCOUNTS) conflict('ACCOUNT_LIMIT');
  recoverPending(candidate, 'Imported unresolved action');
  summary.unresolvedCount = Object.values(candidate.accounts).reduce((sum, account) => sum + account.actions.filter(action => ['pending', 'unknown'].includes(action.status)).length + (['pending', 'unknown'].includes(account.authorFollow?.status) ? 1 : 0), 0);
  candidate.schema = backupSchema(candidate);
  // Preview and commit share the same semantic validation, so a preview never
  // promises an import whose new/old history combinations cannot be saved.
  try { validateBackup(candidate); } catch (error) { conflict(error.message || 'INVALID_BACKUP'); }
  summary.bytes = byteSize({ [constants.STORAGE_KEY]: candidate });
  if (summary.bytes > constants.MAX_BYTES) conflict('STORAGE_LIMIT');
  return { candidate, summary, canCommit: summary.conflicts.length === 0 };
}

export function createStore(storageArea = chrome.storage.local) {
  let queue = Promise.resolve();
  const clone = (value) => structuredClone(value);
  async function load() {
    const result = await storageArea.get(constants.STORAGE_KEY);
    if (!Object.hasOwn(result, constants.STORAGE_KEY)) return defaultState();
    // Invalid data fails closed, rather than silently resetting baselines or actions.
    return validateBackup(result[constants.STORAGE_KEY]);
  }
  async function save(state) {
    state.schema = backupSchema(state);
    if (byteSize({ [constants.STORAGE_KEY]: state }) > constants.MAX_BYTES) throw new Error('STORAGE_LIMIT');
    const checked = validateBackup(state);
    await storageArea.set({ [constants.STORAGE_KEY]: checked });
  }
  function write(transform) {
    const operation = queue.then(async () => {
      const state = await load();
      const result = await transform(state);
      await save(state);
      return clone(result);
    });
    queue = operation.catch(() => {});
    return operation;
  }
  function getAccount(state, id) {
    requireId(id);
    const account = state.accounts[id];
    if (!account) throw new Error('ACCOUNT_NOT_FOUND');
    return account;
  }
  function detailText(detail) {
    return (typeof detail === 'string' ? detail : typeof detail?.message === 'string' ? detail.message : typeof detail?.reason === 'string' ? detail.reason : '').slice(0, 300);
  }
  return {
    async read() { await queue; return clone(await load()); },
    async account(id) { await queue; const state = await load(); requireId(id); return clone(state.accounts[id] || null); },
    commitScan(scan) {
      return write((state) => {
        const id = requireId(scan?.account?.id);
        if (!state.accounts[id] && Object.keys(state.accounts).length >= constants.MAX_ACCOUNTS) throw new Error('ACCOUNT_LIMIT');
        const account = reconcile(state.accounts[id] || null, scan);
        state.accounts[id] = account;
        return account;
      });
    },
    commitFollowers(scan) {
      return write(state => {
        const id = requireId(scan?.account?.id);
        if (!state.accounts[id] && Object.keys(state.accounts).length >= constants.MAX_ACCOUNTS) throw new Error('ACCOUNT_LIMIT');
        const account = reconcileFollowerScan(state.accounts[id] || null, scan);
        state.accounts[id] = account;
        return account;
      });
    },
    commitFollowerObservation(scan) {
      return write(state => {
        const id = requireId(scan?.account?.id);
        if (!state.accounts[id] && Object.keys(state.accounts).length >= constants.MAX_ACCOUNTS) throw new Error('ACCOUNT_LIMIT');
        const account = reconcileFollowerObservation(state.accounts[id] || null, scan);
        state.accounts[id] = account;
        return account;
      });
    },
    setIgnored(accountId, ids, ignored) {
      return write((state) => {
        const account = getAccount(state, accountId);
        if (!Array.isArray(ids) || ids.length > constants.MAX_USERS || typeof ignored !== 'boolean') throw new Error('INVALID_IGNORES');
        const current = new Set(account.ignored);
        for (const value of ids) { const id = requireId(value); if (ignored) current.add(id); else current.delete(id); }
        if (current.size > constants.MAX_USERS) throw new Error('IGNORE_LIMIT');
        account.ignored = [...current];
        return account;
      });
    },
    updateSettings(patch) {
      return write((state) => { state.settings = cleanSettings(patch, state.settings); return state.settings; });
    },
    beginAuthorFollow(identity, now = Date.now()) {
      return write(state => {
        const id = requireId(identity?.id);
        if (id === '1671136128953638914' || !/^[A-Za-z0-9_]{1,15}$/.test(identity.handle || '')) throw new Error('AUTHOR_FOLLOW_NOT_ELIGIBLE');
        if (!state.accounts[id] && Object.keys(state.accounts).length >= constants.MAX_ACCOUNTS) throw new Error('ACCOUNT_LIMIT');
        const account = state.accounts[id] ||= { id, handle: identity.handle, users: [], events: [], ignored: [], actions: [], lastScan: null, baselineAt: null };
        if (['pending', 'unknown'].includes(account.authorFollow?.status)) throw new Error('AUTHOR_FOLLOW_UNRESOLVED');
        if (!Number.isSafeInteger(now) || now <= 0) throw new Error('INVALID_ACTION_TIME');
        account.authorFollow = { id: crypto.randomUUID(), status: 'pending', createdAt: now, updatedAt: now, detail: '' };
        return account.authorFollow;
      });
    },
    finishAuthorFollow(accountId, status, detail = {}) {
      return write(state => {
        const action = getAccount(state, accountId).authorFollow;
        if (!action || !['pending', 'unknown'].includes(action.status)) throw new Error('ACTION_NOT_PENDING');
        if (!['success', 'failed', 'unknown'].includes(status)) throw new Error('INVALID_ACTION_STATUS');
        if (action.status === 'unknown' && status !== 'unknown' && detail.reconciled !== true) throw new Error('RECONCILIATION_REQUIRED');
        if (status === 'success' && detail.confirmed !== true) throw new Error('CONFIRMATION_REQUIRED');
        if (status === 'failed' && (action.status === 'unknown' || detail.notSent !== true)) throw new Error('NOT_SENT_PROOF_REQUIRED');
        action.status = status; action.updatedAt = Date.now(); action.detail = detailText(detail) || String(detail.code || '').slice(0, 300);
        return action;
      });
    },
    beginAction(accountId, userId, now = Date.now()) {
      return write((state) => {
        const account = getAccount(state, accountId);
        requireId(userId);
        const user = account.users.find((item) => item.id === userId);
        if (!user || user.following !== true || user.unavailable || account.ignored.includes(userId)) throw new Error('ACTION_NOT_ELIGIBLE');
        if (account.actions.some((item) => item.userId === userId && ['pending', 'unknown'].includes(item.status))) throw new Error('ACTION_UNRESOLVED');
        if (!Number.isSafeInteger(now) || now <= 0) throw new Error('INVALID_ACTION_TIME');
        const action = { id: crypto.randomUUID(), userId, handle: user.handle, name: user.name, status: 'pending', createdAt: now, updatedAt: now, detail: '' };
        account.actions = pruneActions([...account.actions, action], now);
        return action;
      });
    },
    finishAction(accountId, userId, status, detail = {}) {
      return write((state) => {
        const account = getAccount(state, accountId);
        requireId(userId);
        if (!['success', 'failed', 'unknown'].includes(status)) throw new Error('INVALID_ACTION_STATUS');
        const action = account.actions.find((item) => item.userId === userId && ['pending', 'unknown'].includes(item.status));
        if (!action) throw new Error('ACTION_NOT_PENDING');
        const wasUnknown = action.status === 'unknown';
        if (wasUnknown && status !== 'unknown' && detail?.reconciled !== true) throw new Error('RECONCILIATION_REQUIRED');
        if (status === 'success' && detail?.confirmed !== true) throw new Error('CONFIRMATION_REQUIRED');
        // A failure is retryable only with proof that no mutation was sent.
        const verifiedFollowing = detail?.reconciled === true && detail?.confirmed === true && detail?.following === true;
        if (status === 'failed' && (wasUnknown ? !verifiedFollowing : detail?.notSent !== true && !verifiedFollowing)) throw new Error('NOT_SENT_PROOF_REQUIRED');
        action.status = status;
        action.updatedAt = Date.now();
        action.detail = detailText(detail);
        if (status === 'success') {
          const user = account.users.find((item) => item.id === userId);
          if (user) user.following = false;
          account.events = pruneEvents([...account.events, { type: 'unfollowed', userId, handle: user?.handle || '', at: action.updatedAt }], action.updatedAt);
        }
        return action;
      });
    },
    recoverActions() {
      return write((state) => ({ recovered: recoverPending(state, 'Interrupted before a confirmed result') }));
    },
    // The compact backup must fit the same byte ceiling as every valid state.
    // Dates belong in the download filename; adding an envelope can exceed it.
    async exportBackup() { await queue; return clone(await load()); },
    async previewImport(data) {
      await queue;
      const current = await load(), revision = await stateDigest(current);
      return { ...mergeImport(current, data), revision };
    },
    commitImport(plan) {
      return write(async state => {
        if (!plan?.canCommit || typeof plan.revision !== 'string') throw new Error('IMPORT_PREVIEW_REQUIRED');
        if (await stateDigest(state) !== plan.revision) throw new Error('IMPORT_CHANGED');
        const checked = validateBackup(plan.candidate);
        state.accounts = checked.accounts; state.settings = checked.settings;
        return { accounts: Object.keys(state.accounts).length, summary: plan.summary };
      });
    },
    importBackup(data) {
      return write((state) => {
        const plan = mergeImport(state, data);
        if (!plan.canCommit) throw new Error(plan.summary.conflicts[0].code);
        state.accounts = plan.candidate.accounts; state.settings = plan.candidate.settings;
        return { accounts: Object.keys(state.accounts).length, summary: plan.summary };
      });
    },
    removeAccount(id) {
      return write((state) => {
        const account = getAccount(state, id);
        if (account.actions.some((item) => ['pending', 'unknown'].includes(item.status)) || ['pending', 'unknown'].includes(account.authorFollow?.status)) throw new Error('UNRESOLVED_ACTIONS_PROTECTED');
        delete state.accounts[id];
        return { removed: id };
      });
    },
    async stats() {
      await queue; const state = await load();
      const accounts = Object.values(state.accounts);
      return { bytes: byteSize({ [constants.STORAGE_KEY]: state }), limitBytes: constants.MAX_BYTES, accountCount: accounts.length,
        userCount: accounts.reduce((sum, account) => sum + account.users.length, 0), eventCount: accounts.reduce((sum, account) => sum + account.events.length, 0),
        unresolvedCount: accounts.reduce((sum, account) => sum + account.actions.filter((item) => ['pending', 'unknown'].includes(item.status)).length + (['pending', 'unknown'].includes(account.authorFollow?.status) ? 1 : 0), 0) };
    },
  };
}
