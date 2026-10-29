// X Follow Helper — DimmensCK. Independent implementation.
export const constants = Object.freeze({
  SCHEMA: 1, STORAGE_KEY: 'xmhState', MAX_BYTES: 32 * 1024 * 1024,
  MAX_ACCOUNTS: 5, MAX_USERS: 25000, MAX_HISTORY: 25000, MAX_EVENTS: 1000,
  MAX_FOLLOWERS: 100000, MAX_FOLLOWER_MISSING: 25000,
  RETENTION_MS: 90 * 24 * 60 * 60 * 1000, MAX_BACKUP_BYTES: 32 * 1024 * 1024,
});

const ID = /^\d{1,30}$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const tri = (value) => value === true ? true : value === false ? false : null;
const VERIFICATION_TYPES = ['Business', 'Government', 'Blue'];
const verificationKnown = raw => raw.verificationKnown !== false && (raw.verificationKnown === true && typeof raw.blue === 'boolean' || raw.blue === true || VERIFICATION_TYPES.includes(raw.verificationType));
const text = (value, length) => typeof value === 'string' ? value.slice(0, length) : '';
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const time = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;
export const byteSize = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export function requireId(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('INVALID_ID');
  return value;
}
function avatar(value) {
  if (typeof value !== 'string' || value.length > 600) return '';
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'pbs.twimg.com' && !url.username && !url.password && url.pathname.startsWith('/profile_images/')) return url.href;
  } catch { /* Invalid optional image URLs are omitted. */ }
  return '';
}
export function normalizeUser(raw) {
  if (!object(raw)) throw new Error('INVALID_USER');
  const id = requireId(raw.id);
  const handle = typeof raw.handle === 'string' && HANDLE.test(raw.handle) ? raw.handle : '';
  return {
    id, handle, name: text(raw.name, 120), avatar: avatar(raw.avatar), bio: text(raw.bio, 500),
    blue: raw.blue === true,
    verificationType: VERIFICATION_TYPES.includes(raw.verificationType) ? raw.verificationType : null,
    ...(typeof raw.verificationKnown === 'boolean' ? { verificationKnown: verificationKnown(raw) } : {}),
    followers: count(raw.followers), followingCount: count(raw.followingCount),
    followedBy: tri(raw.followedBy), following: tri(raw.following), unavailable: raw.unavailable === true,
  };
}

export function defaultState() {
  return { schema: constants.SCHEMA, settings: { language: 'zh_CN', theme: 'dark', enabled: false, floatY: 0.72 }, accounts: {} };
}

export function cleanSettings(value = {}, previous = defaultState().settings) {
  if (!object(value)) throw new Error('INVALID_SETTINGS');
  const allowed = new Set(['language', 'theme', 'enabled', 'floatY']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('INVALID_SETTING_KEY');
  const result = { ...previous };
  if ('language' in value) {
    if (!['zh_CN', 'en', 'ja', 'ko'].includes(value.language)) throw new Error('INVALID_LANGUAGE');
    result.language = value.language;
  }
  if ('theme' in value) {
    if (!['system', 'light', 'dark'].includes(value.theme)) throw new Error('INVALID_THEME');
    result.theme = value.theme;
  }
  if ('enabled' in value) {
    if (typeof value.enabled !== 'boolean') throw new Error('INVALID_ENABLED');
    result.enabled = value.enabled;
  }
  if ('floatY' in value) {
    if (typeof value.floatY !== 'number' || !Number.isFinite(value.floatY) || value.floatY < 0 || value.floatY > 1) throw new Error('INVALID_POSITION');
    result.floatY = value.floatY;
  }
  return result;
}

export function pruneEvents(events, now) {
  return events.filter((item) => item.at >= now - constants.RETENTION_MS).slice(-constants.MAX_EVENTS);
}
export function pruneActions(actions, now) {
  const unresolved = actions.filter((item) => ['pending', 'unknown'].includes(item.status));
  const resolved = actions.filter((item) => !['pending', 'unknown'].includes(item.status) && item.updatedAt >= now - constants.RETENTION_MS).slice(-constants.MAX_EVENTS);
  return [...resolved, ...unresolved].sort((a, b) => a.createdAt - b.createdAt);
}

// One compact observation per absent stable ID, not a saved profile or daily
// snapshot. Missing and unavailable observations never manufacture a negative.
export function relationshipEvidence(user) {
  const lastExplicitFollowedBy = tri(user?.lastExplicitFollowedBy ?? (user?.unavailable || user?.following !== true ? null : user?.followedBy));
  const lastExplicitAt = time(user?.lastExplicitAt), lostAt = time(user?.lostAt);
  if (lastExplicitFollowedBy === null && lostAt === null) return null;
  return { id: requireId(user.id), lastExplicitFollowedBy, lastExplicitAt, lostAt };
}

// Bounded diagnostics describe what this complete scan checked; they are not
// raw response evidence and never establish account/action authorization.
function scanVerification(value, followingCount) {
  const expectedFields = ['followingExpectedStart', 'followingExpectedEnd', 'followersExpectedStart', 'followersExpectedEnd'];
  const fields = ['version', 'scope', 'followingPages', 'followersPages', 'followersChecked', 'followersCount', ...expectedFields];
  if (object(value) && Object.hasOwn(value, 'runId')) fields.push('runId');
  if (object(value) && Object.hasOwn(value, 'terminal')) fields.push('terminal', 'pageExpected');
  const invalid = () => { throw new Error('INVALID_SCAN_VERIFICATION'); };
  if (!object(value) || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))
    || fields.some(key => !Object.hasOwn(value, key)) || typeof value.version !== 'string' || !/^\d{1,3}\.\d{1,3}$/.test(value.version)
    || !['following', 'following_and_followers'].includes(value.scope) || !Number.isSafeInteger(value.followingPages) || value.followingPages < 1 || value.followingPages > 1000
    || !Number.isSafeInteger(value.followersPages) || value.followersPages < 0 || value.followersPages > 2000
    || typeof value.followersChecked !== 'boolean' || Object.hasOwn(value, 'runId') && (typeof value.runId !== 'string' || value.runId.length !== 36 || !RUN_ID.test(value.runId))) invalid();
  if (value.scope === 'following_and_followers' && !value.followersChecked) invalid();
  for (const key of expectedFields) if (value[key] !== null && (!Number.isSafeInteger(value[key]) || value[key] < 0)) invalid();
  if (Object.hasOwn(value, 'terminal') && (value.terminal !== true || value.pageExpected !== null && count(value.pageExpected) === null)) invalid();
  if (!value.terminal && value.followingExpectedStart !== null && value.followingExpectedStart !== followingCount) invalid();
  if (!value.terminal && value.followingExpectedEnd !== null && value.followingExpectedEnd !== followingCount) invalid();
  if (value.followersChecked) {
    if (value.followersPages < 1 || !Number.isSafeInteger(value.followersCount) || value.followersCount < 0 || value.followersCount > 100000) invalid();
    if (value.followersExpectedStart !== null && value.followersExpectedStart !== value.followersCount) invalid();
    if (value.followersExpectedEnd !== null && value.followersExpectedEnd !== value.followersCount) invalid();
  } else if (value.followersPages !== 0 || value.followersCount !== null) invalid();
  return Object.fromEntries(fields.map(key => [key, value[key]]));
}

function followerIdentity(raw, ownerId, previous = null) {
  if (!object(raw)) throw new Error('INVALID_FOLLOWERS');
  const id = requireId(raw.id), unavailable = raw.unavailable === true;
  if ((raw.unavailable !== undefined && typeof raw.unavailable !== 'boolean') || (!unavailable && raw.followedBy === false)) throw new Error('INVALID_FOLLOWERS');
  if (raw.blue !== undefined && typeof raw.blue !== 'boolean') throw new Error('INVALID_FOLLOWERS');
  if (raw.verificationKnown !== undefined && typeof raw.verificationKnown !== 'boolean') throw new Error('INVALID_FOLLOWERS');
  if (raw.following !== undefined && raw.following !== null && typeof raw.following !== 'boolean') throw new Error('INVALID_FOLLOWERS');
  if (raw.verificationType !== undefined && raw.verificationType !== null && !VERIFICATION_TYPES.includes(raw.verificationType)) throw new Error('INVALID_FOLLOWERS');
  if (id === ownerId) throw new Error('INVALID_FOLLOWERS');
  const handle = typeof raw.handle === 'string' && HANDLE.test(raw.handle) ? raw.handle : '';
  if (!unavailable && !handle) throw new Error('INVALID_FOLLOWERS');
  const badge = unavailable && previous ? previous : raw;
  const verificationType = VERIFICATION_TYPES.includes(badge.verificationType) ? badge.verificationType : null;
  return { id, handle: handle || previous?.handle || '', name: text(raw.name, 120) || previous?.name || '', unavailable,
    ...(typeof raw.following === 'boolean' ? { following: raw.following } : {}),
    ...(typeof badge.blue === 'boolean' ? { blue: badge.blue } : {}),
    ...(typeof badge.verificationKnown === 'boolean' ? { verificationKnown: verificationKnown(badge) } : {}),
    ...(verificationType ? { verificationType } : {}) };
}

function reconcileFollowers(previous, rawUsers, ownerId, observedAt, verifiedCount, preserveFollowing = false) {
  if (!Array.isArray(rawUsers) || rawUsers.length > constants.MAX_FOLLOWERS) throw new Error('FOLLOWERS_LIMIT');
  if (verifiedCount !== rawUsers.length) throw new Error('INVALID_FOLLOWERS');
  if (previous && observedAt < previous.observedAt) throw new Error('STALE_FOLLOWERS_SCAN');
  const old = new Map((previous?.users || []).map(row => [row.id, row]));
  const missing = new Map((previous?.missing || []).map(row => [row.id, row]));
  const seen = new Set();
  const users = rawUsers.map(raw => {
    const prior = old.get(raw?.id) || missing.get(raw?.id), row = followerIdentity(raw, ownerId, prior);
    if (!preserveFollowing) delete row.following;
    if (seen.has(row.id)) throw new Error('DUPLICATE_FOLLOWER');
    seen.add(row.id);
    const lastSeenAt = row.unavailable ? Math.max(time(prior?.lastSeenAt) || 0, time(missing.get(row.id)?.lastSeenAt) || 0) || null : observedAt;
    if (!row.unavailable) missing.delete(row.id);
    return { ...row, lastSeenAt };
  });
  if (previous) for (const prior of previous.users) if (!seen.has(prior.id) && prior.lastSeenAt && !missing.has(prior.id)) {
    missing.set(prior.id, { id: prior.id, handle: prior.handle, name: prior.name, lastSeenAt: prior.lastSeenAt, missingSince: observedAt,
      ...(typeof prior.blue === 'boolean' ? { blue: prior.blue } : {}), ...(prior.verificationType ? { verificationType: prior.verificationType } : {}),
      ...(typeof prior.verificationKnown === 'boolean' ? { verificationKnown: verificationKnown(prior) } : {}) });
  }
  if (missing.size > constants.MAX_FOLLOWER_MISSING) throw new Error('FOLLOWER_HISTORY_LIMIT');
  return { baselineAt: previous?.baselineAt || observedAt, observedAt, users, missing: [...missing.values()] };
}

function followerHistoryIdentity(row) {
  return { id: row.id, handle: row.handle, name: row.name,
    ...(typeof row.blue === 'boolean' ? { blue: row.blue } : {}),
    ...(typeof row.verificationKnown === 'boolean' ? { verificationKnown: row.verificationKnown } : {}),
    ...(row.verificationType ? { verificationType: row.verificationType } : {}) };
}

function validatedPendingFollowers(rows, ownerId, observedAt, present, absent) {
  if (!Array.isArray(rows) || rows.length > constants.MAX_FOLLOWER_MISSING) throw new Error('FOLLOWER_HISTORY_LIMIT');
  const seen = new Set();
  return rows.map(raw => {
    if (!object(raw) || Object.keys(raw).some(key => !['id', 'handle', 'name', 'lastSeenAt', 'firstMissingAt', 'lastCheckedAt', 'blue', 'verificationType', 'verificationKnown'].includes(key))
      || typeof raw.name !== 'string' || raw.name.length > 120 || typeof raw.handle !== 'string' || !HANDLE.test(raw.handle)
      || !time(raw.lastSeenAt) || !time(raw.firstMissingAt) || raw.lastSeenAt > observedAt || raw.firstMissingAt > observedAt
      || raw.lastCheckedAt !== null && (!time(raw.lastCheckedAt) || raw.lastCheckedAt > observedAt)) throw new Error('INVALID_FOLLOWER_PENDING');
    const id = requireId(raw.id);
    if (id === ownerId || present.has(id) || absent.has(id) || seen.has(id)) throw new Error('INVALID_FOLLOWER_PENDING');
    // Reuse badge validation without treating this candidate as a current member.
    const identity = followerIdentity({ ...raw, unavailable: false }, ownerId);
    seen.add(id);
    return { ...followerHistoryIdentity(identity), lastSeenAt: raw.lastSeenAt, firstMissingAt: raw.firstMissingAt, lastCheckedAt: raw.lastCheckedAt };
  });
}

// Cursor exhaustion establishes the end of the available list, not a global,
// atomic account snapshot. Missing IDs require explicit reverse-follow checks.
export function followerComparisonCandidates(account, currentUsers) {
  const current = new Set(currentUsers.map(row => row.id)), known = new Map(), missing = new Map((account?.followers?.missing || []).map(row => [row.id, row]));
  for (const row of [...(account?.followers?.users || []), ...(account?.followers?.pendingMissing || []), ...(account?.followerObservation?.users || [])]) {
    if (row.id === account?.id || current.has(row.id) || !time(row.lastSeenAt) || !HANDLE.test(row.handle || '')) continue;
    const lost = missing.get(row.id);
    if (lost && row.lastSeenAt <= (lost.confirmedAt || lost.missingSince)) continue;
    const prior = known.get(row.id);
    if (!prior || row.lastSeenAt > prior.lastSeenAt) known.set(row.id, { ...row, lastCheckedAt: prior?.lastCheckedAt ?? row.lastCheckedAt ?? null,
      ...(prior?.firstMissingAt ? { firstMissingAt: prior.firstMissingAt } : {}) });
  }
  return [...known.values()];
}

function reconcileTerminalFollowers(previousAccount, scan, ownerId) {
  const previous = previousAccount?.followers;
  const current = reconcileFollowers(null, scan.users, ownerId, scan.finishedAt, scan.users.length, true);
  current.baselineAt = previous?.baselineAt || scan.finishedAt;
  const present = new Map(current.users.map(row => [row.id, row]));
  const missing = new Map((previous?.missing || []).map(row => [row.id, { ...row }]));
  const pending = new Map((previous?.pendingMissing || []).map(row => [row.id, { ...row }]));
  const evidence = new Map();
  for (const row of [...(previous?.users || []), ...(previous?.pendingMissing || []), ...(previous?.missing || []), ...(previousAccount?.followerObservation?.users || [])]) {
    if (!evidence.has(row.id) || (row.lastSeenAt || 0) > (evidence.get(row.id).lastSeenAt || 0)) evidence.set(row.id, row);
  }
  for (const row of previousAccount?.followerObservation?.users || []) {
    const lost = missing.get(row.id);
    if (lost && row.lastSeenAt > (lost.confirmedAt || lost.missingSince)) missing.delete(row.id);
  }
  for (const row of current.users) if (!row.unavailable) { missing.delete(row.id); pending.delete(row.id); }
  for (const row of followerComparisonCandidates(previousAccount, scan.users)) {
    const oldPending = pending.get(row.id);
    pending.set(row.id, { ...followerHistoryIdentity(row), lastSeenAt: Math.max(row.lastSeenAt, oldPending?.lastSeenAt || 0),
      firstMissingAt: oldPending?.firstMissingAt || scan.finishedAt, lastCheckedAt: oldPending?.lastCheckedAt || row.lastCheckedAt || null });
  }
  // An unavailable record cannot confirm absence; retain its positive history.
  for (const row of current.users) if (row.unavailable) {
    const old = evidence.get(row.id);
    row.lastSeenAt = old?.lastSeenAt || null;
    if (old) {
      row.handle ||= old.handle; row.name ||= old.name;
      if (typeof old.blue === 'boolean') row.blue = old.blue;
      if (typeof old.verificationKnown === 'boolean') row.verificationKnown = old.verificationKnown;
      if (old.verificationType) row.verificationType = old.verificationType;
    }
    pending.delete(row.id);
  }
  const checks = scan.absenceChecks || [], checked = new Set();
  if (!Array.isArray(checks) || checks.length > 20) throw new Error('INVALID_ABSENCE_CHECKS');
  for (const check of checks) {
    if (!object(check) || Object.keys(check).some(key => !['id', 'followedBy', 'unavailable', 'checkedAt'].includes(key))
      || ![true, false, null].includes(check.followedBy) || typeof check.unavailable !== 'boolean'
      || !time(check.checkedAt) || check.checkedAt < scan.startedAt || check.checkedAt > scan.finishedAt) throw new Error('INVALID_ABSENCE_CHECKS');
    const id = requireId(check.id), row = pending.get(id);
    if (checked.has(id) || !row || present.has(id)) throw new Error('INVALID_ABSENCE_CHECKS');
    checked.add(id); row.lastCheckedAt = check.checkedAt;
    if (check.unavailable || check.followedBy === null) continue;
    if (check.followedBy === true) { row.lastSeenAt = check.checkedAt; continue; }
    if (check.checkedAt <= row.lastSeenAt) throw new Error('INVALID_ABSENCE_CHECKS');
    missing.set(id, { ...followerHistoryIdentity(row), lastSeenAt: row.lastSeenAt, missingSince: check.checkedAt, confirmedAt: check.checkedAt });
    pending.delete(id);
  }
  if (missing.size + pending.size > constants.MAX_FOLLOWER_MISSING) throw new Error('FOLLOWER_HISTORY_LIMIT');
  current.missing = [...missing.values()]; current.pendingMissing = [...pending.values()];
  return current;
}

function validatedFollowers(value, ownerId) {
  if (!object(value) || Object.keys(value).some(key => !['baselineAt', 'observedAt', 'users', 'missing', 'pendingMissing', 'addedIds', 'comparisonAt', 'verification'].includes(key))
    || !time(value.baselineAt) || !time(value.observedAt) || value.baselineAt > value.observedAt || value.observedAt > Date.now() + 60000) throw new Error('INVALID_FOLLOWERS');
  if (!Array.isArray(value.users) || value.users.length > constants.MAX_FOLLOWERS) throw new Error('FOLLOWERS_LIMIT');
  if (!Array.isArray(value.missing) || value.missing.length > constants.MAX_FOLLOWER_MISSING) throw new Error('FOLLOWER_HISTORY_LIMIT');
  const present = new Map(), absent = new Set();
  const users = value.users.map(raw => {
    if (!object(raw) || Object.keys(raw).some(key => !['id', 'handle', 'name', 'unavailable', 'lastSeenAt', 'blue', 'verificationType', 'verificationKnown', 'following'].includes(key))
      || typeof raw.unavailable !== 'boolean' || typeof raw.name !== 'string' || raw.name.length > 120
      || typeof raw.handle !== 'string' || (raw.handle !== '' && !HANDLE.test(raw.handle))) throw new Error('INVALID_FOLLOWERS');
    const row = followerIdentity(raw, ownerId);
    if (present.has(row.id) || (raw.lastSeenAt !== null && !time(raw.lastSeenAt)) || raw.lastSeenAt > value.observedAt
      || (!row.unavailable && raw.lastSeenAt !== value.observedAt)) throw new Error('INVALID_FOLLOWERS');
    const result = { ...row, lastSeenAt: raw.lastSeenAt }; present.set(row.id, result); return result;
  });
  const missing = value.missing.map(raw => {
    if (!object(raw) || Object.keys(raw).some(key => !['id', 'handle', 'name', 'lastSeenAt', 'missingSince', 'confirmedAt', 'blue', 'verificationType', 'verificationKnown'].includes(key))
      || typeof raw.name !== 'string' || raw.name.length > 120 || typeof raw.handle !== 'string' || (raw.handle !== '' && !HANDLE.test(raw.handle))) throw new Error('INVALID_FOLLOWERS');
    if (raw.blue !== undefined && typeof raw.blue !== 'boolean') throw new Error('INVALID_FOLLOWERS');
    if (raw.verificationKnown !== undefined && typeof raw.verificationKnown !== 'boolean') throw new Error('INVALID_FOLLOWERS');
    if (raw.verificationType !== undefined && raw.verificationType !== null && !VERIFICATION_TYPES.includes(raw.verificationType)) throw new Error('INVALID_FOLLOWERS');
    const id = requireId(raw.id), current = present.get(id);
    if (id === ownerId || absent.has(id) || !time(raw.lastSeenAt) || !time(raw.missingSince) || raw.lastSeenAt >= raw.missingSince
      || raw.missingSince > value.observedAt || (current && (!current.unavailable || (current.lastSeenAt && current.lastSeenAt > raw.lastSeenAt)))) throw new Error('INVALID_FOLLOWERS');
    absent.add(id);
    if (Object.hasOwn(raw, 'confirmedAt') && (!time(raw.confirmedAt) || raw.confirmedAt < raw.missingSince || raw.confirmedAt > value.observedAt)) throw new Error('INVALID_FOLLOWERS');
    return { id, handle: raw.handle, name: raw.name, lastSeenAt: raw.lastSeenAt, missingSince: raw.missingSince,
      ...(raw.confirmedAt ? { confirmedAt: raw.confirmedAt } : {}),
      ...(typeof raw.blue === 'boolean' ? { blue: raw.blue } : {}), ...(raw.verificationType ? { verificationType: raw.verificationType } : {}),
      ...(typeof raw.verificationKnown === 'boolean' ? { verificationKnown: verificationKnown(raw) } : {}) };
  });
  const tracked = Object.hasOwn(value, 'addedIds') || Object.hasOwn(value, 'comparisonAt');
  if (tracked) {
    if (!Array.isArray(value.addedIds) || value.addedIds.length > constants.MAX_FOLLOWERS
      || !Object.hasOwn(value, 'comparisonAt') || (value.comparisonAt !== null && (!time(value.comparisonAt) || value.comparisonAt >= value.observedAt || value.comparisonAt < value.baselineAt))
      || value.comparisonAt === null && value.addedIds.length) throw new Error('INVALID_FOLLOWER_COMPARISON');
    const added = new Set();
    for (const id of value.addedIds) {
      requireId(id);
      if (added.has(id) || !present.has(id) || present.get(id).unavailable) throw new Error('INVALID_FOLLOWER_COMPARISON');
      added.add(id);
    }
  }
  if (Object.hasOwn(value, 'verification')) followerVerification(value.verification, users.length);
  const pendingMissing = Object.hasOwn(value, 'pendingMissing') ? validatedPendingFollowers(value.pendingMissing, ownerId, value.observedAt, present, absent) : null;
  if (missing.length + (pendingMissing?.length || 0) > constants.MAX_FOLLOWER_MISSING) throw new Error('FOLLOWER_HISTORY_LIMIT');
  return { baselineAt: value.baselineAt, observedAt: value.observedAt, users, missing,
    ...(pendingMissing ? { pendingMissing } : {}),
    ...(tracked ? { addedIds: [...value.addedIds], comparisonAt: value.comparisonAt } : {}),
    ...(Object.hasOwn(value, 'verification') ? { verification: { ...value.verification } } : {}) };
}

function followerVerification(value, count) {
  const fields = ['version', 'scope', 'pages', 'expectedStart', 'expectedEnd'];
  if (object(value) && Object.hasOwn(value, 'runId')) fields.push('runId');
  if (object(value) && Object.hasOwn(value, 'terminal')) fields.push('terminal', 'pageExpected');
  if (!object(value) || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))
    || typeof value.version !== 'string' || !/^\d{1,3}\.\d{1,3}$/.test(value.version) || value.scope !== 'followers'
    || !Number.isSafeInteger(value.pages) || value.pages < 1 || value.pages > 2000
    || Object.hasOwn(value, 'runId') && (typeof value.runId !== 'string' || value.runId.length !== 36 || !RUN_ID.test(value.runId))
    || Object.hasOwn(value, 'terminal') && (value.terminal !== true || value.pageExpected !== null && (!Number.isSafeInteger(value.pageExpected) || value.pageExpected < 0))
    || ['expectedStart', 'expectedEnd'].some(field => value[field] !== null && (!Number.isSafeInteger(value[field]) || value[field] < 0 || !value.terminal && value[field] !== count))) {
    throw new Error('INVALID_FOLLOWER_VERIFICATION');
  }
}

// Followers are an independent complete observation. Never rewrite the saved
// Following scan, its relationship history, profile fields, or action receipts.
export function reconcileFollowerScan(previousAccount, scan, now = Date.now()) {
  if (!object(scan) || scan.complete !== true || !object(scan.account)) throw new Error('INCOMPLETE_SCAN');
  const id = requireId(scan.account.id);
  if (previousAccount && previousAccount.id !== id) throw new Error('ACCOUNT_MISMATCH');
  if (!HANDLE.test(scan.account.handle || '')) throw new Error('INVALID_HANDLE');
  if (!Array.isArray(scan.users) || scan.users.length > constants.MAX_FOLLOWERS) throw new Error('FOLLOWERS_LIMIT');
  if (!time(scan.startedAt) || !time(scan.finishedAt) || scan.finishedAt < scan.startedAt || scan.finishedAt > now + 60000) throw new Error('INVALID_SCAN_TIME');
  const previous = previousAccount?.followers;
  if (previous && scan.finishedAt <= previous.observedAt) throw new Error('STALE_FOLLOWERS_SCAN');
  followerVerification(scan.verification, scan.users.length);
  const followers = scan.verification.terminal
    ? reconcileTerminalFollowers(previousAccount, scan, id)
    : reconcileFollowers(previous, scan.users, id, scan.finishedAt, scan.users.length);
  const priorIds = new Set([...(previous?.users || []), ...(previous?.pendingMissing || []), ...(previousAccount?.followerObservation?.users || [])].map(row => row.id));
  followers.comparisonAt = previous?.observedAt || null;
  followers.addedIds = previous ? followers.users.filter(row => !row.unavailable && !priorIds.has(row.id)).map(row => row.id) : [];
  followers.verification = { ...scan.verification };
  const base = previousAccount || { id, handle: scan.account.handle, users: [], events: [], ignored: [], actions: [], lastScan: null, baselineAt: null };
  const result = { ...base, ...(!base.lastScan?.complete ? { handle: scan.account.handle } : {}), followers };
  if (result.followerObservation?.observedAt <= scan.finishedAt) delete result.followerObservation;
  return result;
}

function validatedFollowerObservation(value, ownerId) {
  const fields = ['complete', 'terminal', 'reason', 'startedAt', 'observedAt', 'runId', 'pages', 'expectedStart', 'expectedEnd', 'pageExpected', 'users'];
  if (!object(value) || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))
    || value.complete !== false || value.terminal !== true || value.reason !== 'SCAN_COUNT_MISMATCH'
    || !time(value.startedAt) || !time(value.observedAt) || value.startedAt > value.observedAt || value.observedAt > Date.now() + 60000
    || typeof value.runId !== 'string' || !RUN_ID.test(value.runId) || !Number.isInteger(value.pages) || value.pages < 1 || value.pages > 2000
    || !Array.isArray(value.users) || !value.users.length || value.users.length > constants.MAX_FOLLOWERS
    || ['expectedStart', 'expectedEnd', 'pageExpected'].some(key => value[key] !== null && (!Number.isSafeInteger(value[key]) || value[key] < 0))
    || !['expectedStart', 'expectedEnd', 'pageExpected'].some(key => value[key] !== null && value[key] !== value.users.length)) throw new Error('INVALID_FOLLOWER_OBSERVATION');
  const checked = validatedFollowers({ baselineAt: value.observedAt, observedAt: value.observedAt, users: value.users, missing: [] }, ownerId);
  return { ...value, users: checked.users };
}

// Positive observations are useful even when completeness could not be proved.
// They never become a comparison baseline and cannot create absence events.
export function reconcileFollowerObservation(previousAccount, scan, now = Date.now()) {
  if (!object(scan) || scan.complete !== false || !object(scan.account)) throw new Error('INVALID_FOLLOWER_OBSERVATION');
  const id = requireId(scan.account.id);
  if (previousAccount && previousAccount.id !== id) throw new Error('ACCOUNT_MISMATCH');
  if (!HANDLE.test(scan.account.handle || '')) throw new Error('INVALID_HANDLE');
  if (!time(scan.startedAt) || !time(scan.finishedAt) || scan.finishedAt < scan.startedAt || scan.finishedAt > now + 60000) throw new Error('INVALID_SCAN_TIME');
  if (Math.max(previousAccount?.followers?.observedAt || 0, previousAccount?.followerObservation?.observedAt || 0) >= scan.finishedAt) throw new Error('STALE_FOLLOWERS_SCAN');
  if (!Array.isArray(scan.users) || !scan.users.length || scan.users.length > constants.MAX_FOLLOWERS) throw new Error('INVALID_FOLLOWER_OBSERVATION');
  const previous = previousAccount?.followers, known = new Map([...(previous?.users || []), ...(previous?.missing || [])].map(row => [row.id, row])), seen = new Set();
  const rows = scan.users.map(raw => {
    const prior = known.get(raw?.id), row = followerIdentity(raw, id, prior);
    delete row.following; // v2.4 positive-only records retain their original schema.
    if (seen.has(row.id)) throw new Error('DUPLICATE_FOLLOWER');
    seen.add(row.id);
    return { ...row, lastSeenAt: row.unavailable ? time(prior?.lastSeenAt) : scan.finishedAt };
  });
  const observation = validatedFollowerObservation({ complete: false, terminal: scan.terminal, reason: scan.reason,
    startedAt: scan.startedAt, observedAt: scan.finishedAt, runId: scan.runId, pages: scan.pages,
    expectedStart: scan.expectedStart, expectedEnd: scan.expectedEnd, pageExpected: scan.pageExpected, users: rows }, id);
  const base = previousAccount || { id, handle: scan.account.handle, users: [], events: [], ignored: [], actions: [], lastScan: null, baselineAt: null };
  return { ...base, followerObservation: observation };
}

export function getFollowerView(account) {
  const observation = account?.followerObservation, complete = account?.followers;
  return observation && (!complete || observation.observedAt > complete.observedAt)
    ? { snapshot: observation, incomplete: true } : { snapshot: complete || null, incomplete: false };
}
const followerSources = account => {
  const latest = getFollowerView(account).snapshot;
  return [latest, account?.followers && account.followers !== latest ? account.followers : null].filter(Boolean);
};

export function reconcile(previousAccount, scan, now = Date.now()) {
  if (!object(scan) || scan.complete !== true || !object(scan.account)) throw new Error('INCOMPLETE_SCAN');
  const id = requireId(scan.account.id);
  if (previousAccount && previousAccount.id !== id) throw new Error('ACCOUNT_MISMATCH');
  if (!HANDLE.test(scan.account.handle || '')) throw new Error('INVALID_HANDLE');
  if (!Array.isArray(scan.users) || scan.users.length > constants.MAX_USERS) throw new Error('USER_LIMIT');
  if (!time(scan.startedAt) || !time(scan.finishedAt) || scan.finishedAt < scan.startedAt || scan.finishedAt > now + 60000) throw new Error('INVALID_SCAN_TIME');
  if (previousAccount?.lastScan?.finishedAt > scan.finishedAt) throw new Error('STALE_SCAN');
  const verification = Object.hasOwn(scan, 'verification') ? scanVerification(scan.verification, scan.users.length) : null;
  const old = new Map((previousAccount?.users || []).map((user) => [user.id, user]));
  const history = new Map((previousAccount?.relationshipHistory || []).map(item => [item.id, item]));
  const seen = new Set();
  const events = [...(previousAccount?.events || [])];
  const users = scan.users.map((raw) => {
    const user = normalizeUser(raw);
    if (seen.has(user.id) || user.id === id) throw new Error('DUPLICATE_OR_SELF_USER');
    seen.add(user.id);
    const prior = old.get(user.id) || history.get(user.id);
    history.delete(user.id);
    // Legacy rows may lack the retained explicit observation. An unavailable
    // row's raw relationship is never a substitute for trustworthy history.
    const priorExplicit = tri(prior?.lastExplicitFollowedBy ?? (prior?.unavailable || prior?.following !== true ? null : prior?.followedBy));
    let lastExplicitFollowedBy = priorExplicit;
    let lastExplicitAt = time(prior?.lastExplicitAt);
    let lostAt = time(prior?.lostAt);
    // A restricted profile or unknown relationship cannot prove a transition.
    if (!user.unavailable && user.following === true && user.followedBy !== null) {
      if (user.followedBy === false && priorExplicit === true) {
        lostAt = scan.finishedAt;
        events.push({ type: 'lost', userId: user.id, handle: user.handle, at: scan.finishedAt });
      } else if (user.followedBy === true) {
        if (lostAt) events.push({ type: 'regained', userId: user.id, handle: user.handle, at: scan.finishedAt });
        lostAt = null;
      }
      lastExplicitFollowedBy = user.followedBy;
      lastExplicitAt = scan.finishedAt;
    }
    return { ...user, lastExplicitFollowedBy, lastExplicitAt, lostAt };
  });
  for (const [userId, prior] of old) if (!seen.has(userId)) {
    const evidence = relationshipEvidence(prior);
    if (evidence) history.set(userId, evidence);
  }
  if (history.size > constants.MAX_HISTORY) throw new Error('HISTORY_LIMIT');
  const followers = Object.hasOwn(scan, 'followers')
    ? reconcileFollowers(previousAccount?.followers, scan.followers, id, scan.finishedAt, verification?.followersChecked ? verification.followersCount : null)
    : previousAccount?.followers;
  if (Object.hasOwn(scan, 'followers')) {
    const membership = new Map(followers.users.map(row => [row.id, row]));
    for (const row of users) if (!row.unavailable && row.followedBy !== null) {
      const member = membership.get(row.id);
      if (member?.unavailable || row.followedBy !== Boolean(member)) throw new Error('SCAN_RELATION_CONFLICT');
    }
  }
  return {
    id, handle: scan.account.handle, users,
    ...(history.size ? { relationshipHistory: [...history.values()] } : {}),
    ...(followers ? { followers } : {}),
    ...(previousAccount?.followerObservation && (!followers || previousAccount.followerObservation.observedAt > followers.observedAt)
      ? { followerObservation: previousAccount.followerObservation } : {}),
    events: pruneEvents(events, now), ignored: [...(previousAccount?.ignored || [])],
    actions: pruneActions(previousAccount?.actions || [], now),
    ...(previousAccount?.authorFollow ? { authorFollow: { ...previousAccount.authorFollow } } : {}),
    lastScan: { startedAt: scan.startedAt, finishedAt: scan.finishedAt, source: text(scan.source, 40), count: users.length, complete: true,
      ...(verification ? { verification } : {}) },
    baselineAt: previousAccount?.baselineAt || scan.finishedAt,
  };
}

const userViews = ['all', 'lost', 'notFollowing', 'mutual', 'unknown', 'unavailable', 'ignored'];
const followerViews = ['followers', 'followersOnly', 'followersNew', 'followersLost'];
const hasFollowingBaseline = account => account?.lastScan?.complete === true;
const permitsFollowingAbsence = account => hasFollowingBaseline(account) && !account.lastScan.verification?.terminal
  && !getFollowerView(account).snapshot?.verification?.terminal;
function fanOnly(member, following, hasBaseline) {
  if (member.unavailable || following?.unavailable) return false;
  if (following) return following.following === false;
  if (typeof member.following === 'boolean') return member.following === false;
  return hasBaseline;
}
function matchesView(user, view, isIgnored) {
  // Saved rows remain available for receipts/history; confirmed not-following
  // rows are no longer members of the current Following views.
  if (view === 'ignored') return isIgnored;
  if (user.following === false) return false;
  if (view === 'all') return true;
  if (isIgnored) return false;
  if (['lost', 'notFollowing', 'mutual'].includes(view) && (user.unavailable || user.following !== true)) return false;
  if (view === 'lost') return user.followedBy === false && Boolean(user.lostAt);
  if (view === 'notFollowing') return user.followedBy === false && !user.lostAt;
  if (view === 'mutual') return user.followedBy === true;
  if (view === 'unknown') return !user.unavailable && (user.followedBy === null || user.following === null);
  if (view === 'unavailable') return user.unavailable;
  return false;
}
function selectedVerification(options = {}) {
  if (['all', 'blue', 'standard'].includes(options.verificationFilter)) return options.verificationFilter;
  return options.blueOnly === true ? 'blue' : 'all';
}
function matchesVerification(user, filter) {
  if (filter === 'standard') return !user.unavailable && user.verificationKnown === true && user.blue === false && !user.verificationType;
  if (filter === 'blue') return user.verificationType !== 'Government' && user.verificationType !== 'Business'
    && (user.blue === true || user.verificationType === 'Blue');
  return true;
}
function hasOtherVerification(user) {
  return VERIFICATION_TYPES.includes(user.verificationType) && user.verificationType !== 'Blue';
}
// This view has its own certification scope. Unknown certification is not an
// "other" badge, and historical absence alone is not current membership.
function otherAccounts(account) {
  if (!account) return [];
  const ignored = new Set(account.ignored || []);
  const following = new Map(account.users.map(row => [row.id, row]));
  const rows = new Map(account.users.filter(row => matchesView(row, 'all', false) && hasOtherVerification(row)).map(row => [row.id, row]));
  const { snapshot } = getFollowerView(account);
  if (snapshot) {
    const added = new Set(snapshot.addedIds || []);
    for (const member of snapshot.users) if (!rows.has(member.id) && hasOtherVerification(following.get(member.id) || member)) {
      rows.set(member.id, projectFollower(account, member, following.get(member.id), member, null, added.has(member.id), snapshot));
    }
  }
  return [...rows.values()].filter(row => !ignored.has(row.id) && hasOtherVerification(row));
}
export function countUsers(account, options = {}) {
  const filter = selectedVerification(options);
  const counts = Object.fromEntries(userViews.map(view => [view, 0])), ignored = new Set(account?.ignored || []);
  for (const user of account?.users || []) {
    if (!matchesVerification(user, filter)) continue;
    const isIgnored = ignored.has(user.id);
    for (const view of userViews) if (matchesView(user, view, isIgnored)) counts[view]++;
  }
  if (!hasFollowingBaseline(account)) for (const view of userViews) if (view !== 'ignored') counts[view] = null;
  for (const view of followerViews) counts[view] = null;
  const { snapshot, incomplete } = getFollowerView(account);
  if (snapshot) {
    const following = new Map(account.users.map(row => [row.id, row]));
    const present = new Map(snapshot.users.map(row => [row.id, row]));
    // Use the same saved profile precedence as projected result rows. Filtering
    // never changes membership, relation evidence or either saved observation.
    const visible = row => matchesVerification(following.get(row.id) || row, filter);
    counts.followers = snapshot.users.filter(visible).length;
    counts.followersOnly = hasFollowingBaseline(account) || snapshot.users.some(row => typeof row.following === 'boolean') ? snapshot.users.filter(row => visible(row) && !ignored.has(row.id) && fanOnly(row, following.get(row.id), permitsFollowingAbsence(account))).length : null;
    counts.followersNew = Array.isArray(snapshot.addedIds) ? snapshot.addedIds.filter(id => present.has(id) && visible(present.get(id)) && !present.get(id).unavailable && !ignored.has(id)).length : null;
    // A currently unavailable member cannot prove current absence, even when
    // a prior missing episode remains retained for later reconciliation.
    counts.followersLost = incomplete ? null : snapshot.missing.filter(row => visible(row) && !present.has(row.id) && !ignored.has(row.id)).length;
    const seen = new Set(following.keys());
    for (const source of followerSources(account)) for (const row of [...source.users, ...(source.missing || []), ...(source.pendingMissing || [])]) {
      if (!seen.has(row.id) && ignored.has(row.id) && visible(row)) counts.ignored++;
      seen.add(row.id);
    }
  }
  counts.other = hasFollowingBaseline(account) || snapshot ? otherAccounts(account).length : null;
  return counts;
}

function projectFollower(account, record, following, member, missing, isAdded, snapshot = account.followers, pending = null) {
  const status = member?.unavailable ? 'unavailable' : member ? 'present' : pending ? 'pending' : 'missing';
  const row = following ? { ...following } : { ...normalizeUser({ ...record,
    following: typeof record.following === 'boolean' ? record.following : permitsFollowingAbsence(account) ? false : null,
    followedBy: status === 'present' ? true : null, unavailable: status === 'unavailable' }), lostAt: null };
  // Independent R observations are metadata. Never replace the F row's
  // reverse-follow state, availability, historical loss, or explicit evidence.
  return { ...row, followerStatus: status, followerObservedAt: snapshot.observedAt,
    followerObservationIncomplete: snapshot.complete === false,
    ...(!following ? { verificationKnown: verificationKnown(record) } : {}),
    followerLastSeenAt: missing?.lastSeenAt || member?.lastSeenAt || pending?.lastSeenAt || null,
    ...(pending ? { followerPendingSince: pending.firstMissingAt } : {}),
    followerMissingSince: missing?.missingSince || null,
    followerConfirmedAt: missing?.confirmedAt || null,
    followerAddedAt: isAdded ? snapshot.observedAt : null };
}

export function getUser(account, id) {
  if (!account) return null;
  const following = account.users.find(row => row.id === id);
  for (const snapshot of followerSources(account)) {
    const member = snapshot.users.find(row => row.id === id), missing = snapshot.missing?.find(row => row.id === id);
    const pending = snapshot.pendingMissing?.find(row => row.id === id);
    if (member || missing || pending) return projectFollower(account, member || missing || pending, following, member, missing, snapshot.addedIds?.includes(id) === true, snapshot, pending);
  }
  return following ? { ...following } : null;
}

export function selectUsers(account, options = {}) {
  if (!account) return [];
  const { view = 'lost', query = '', sort = 'anomalies' } = options;
  const filter = selectedVerification(options);
  const isFollowers = followerViews.includes(view), isOther = view === 'other';
  if (!userViews.includes(view) && !isFollowers && !isOther) return [];
  if (!isFollowers && !isOther && view !== 'ignored' && !hasFollowingBaseline(account)) return [];
  const ignored = new Set(account.ignored || []);
  const needle = String(query).trim().toLocaleLowerCase();
  let source = isOther ? otherAccounts(account) : account.users;
  if (!isOther && (isFollowers || view === 'ignored' && getFollowerView(account).snapshot)) {
    const { snapshot, incomplete } = getFollowerView(account);
    if (!snapshot || view === 'followersOnly' && !hasFollowingBaseline(account) && !snapshot.users.some(row => typeof row.following === 'boolean') || view === 'followersNew' && !Array.isArray(snapshot.addedIds)
      || view === 'followersLost' && incomplete) return [];
    const following = new Map(account.users.map(row => [row.id, row])), present = new Map(snapshot.users.map(row => [row.id, row]));
    const missing = new Map((snapshot.missing || []).map(row => [row.id, row])), added = new Set(snapshot.addedIds || []);
    const project = row => projectFollower(account, row, following.get(row.id), present.get(row.id), missing.get(row.id), added.has(row.id), snapshot);
    if (view === 'ignored') {
      const rows = new Map(following);
      for (const saved of followerSources(account)) {
        const savedPresent = new Map(saved.users.map(row => [row.id, row])), savedMissing = new Map((saved.missing || []).map(row => [row.id, row]));
        const savedPending = new Map((saved.pendingMissing || []).map(row => [row.id, row]));
        for (const row of [...saved.users, ...(saved.missing || []), ...(saved.pendingMissing || [])]) if (ignored.has(row.id) && !rows.has(row.id)) {
          rows.set(row.id, projectFollower(account, row, following.get(row.id), savedPresent.get(row.id), savedMissing.get(row.id), saved.addedIds?.includes(row.id), saved, savedPending.get(row.id)));
        }
      }
      source = [...rows.values()];
    } else {
      const members = view === 'followersLost' ? snapshot.missing.filter(row => !present.has(row.id)) : snapshot.users;
      source = members.filter(row => (view !== 'followersOnly' || fanOnly(row, following.get(row.id), permitsFollowingAbsence(account)))
        && (view !== 'followersNew' || added.has(row.id) && !row.unavailable)).map(project);
    }
  }
  const result = source.filter((user) => {
    const isIgnored = ignored.has(user.id);
    if (isOther ? isIgnored : isFollowers ? view !== 'followers' && isIgnored : !matchesView(user, view, isIgnored)) return false;
    if (!isOther && !matchesVerification(user, filter)) return false;
    if (needle && !`${user.handle} ${user.name} ${user.bio}`.toLocaleLowerCase().includes(needle)) return false;
    return true;
  });
  const tie = (a, b) => a.handle.localeCompare(b.handle) || a.id.localeCompare(b.id);
  const username = (a, b) => {
    const left = a.handle.toLowerCase(), right = b.handle.toLowerCase();
    if (!left || !right) return Number(!left) - Number(!right) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return (left < right ? -1 : left > right ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  };
  const anomalyPriority = row => {
    if (!row.unavailable && row.following === true && row.followedBy === false) return row.lostAt ? 0 : 1;
    if (!row.unavailable && row.following === false && (row.followerStatus === 'present' || !row.followerStatus && row.followedBy === true)) return 2;
    if (row.followerStatus === 'missing' && row.followerConfirmedAt) return 3;
    if (row.followerStatus === 'pending' || row.followerStatus === 'missing') return 4;
    if (row.unavailable) return 5;
    if (row.following === null || row.followedBy === null) return 6;
    if (row.followerAddedAt) return 7;
    if (row.following === true && row.followedBy === true) return 8;
    return 9;
  };
  const sorts = {
    anomalies: (a, b) => anomalyPriority(a) - anomalyPriority(b) || username(a, b),
    followersDesc: (a, b) => (b.followers ?? -1) - (a.followers ?? -1) || tie(a, b),
    followersAsc: (a, b) => (a.followers ?? Number.MAX_SAFE_INTEGER) - (b.followers ?? Number.MAX_SAFE_INTEGER) || tie(a, b),
    name: (a, b) => a.name.localeCompare(b.name) || tie(a, b),
    handle: tie,
    recent: (a, b) => (b.followerAddedAt || b.followerMissingSince || b.followerLastSeenAt || b.lostAt || 0) - (a.followerAddedAt || a.followerMissingSince || a.followerLastSeenAt || a.lostAt || 0) || tie(a, b),
  };
  return result.sort(typeof sort === 'string' && Object.hasOwn(sorts, sort) ? sorts[sort] : sorts.anomalies);
}

function csvCell(value) {
  let valueText = value === null || value === undefined ? '' : String(value);
  // Formula prefixes can be hidden behind whitespace, tabs or control characters.
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(valueText)) valueText = `'${valueText}`;
  return `"${valueText.replaceAll('"', '""')}"`;
}
export function toCSV(users) {
  const fields = ['id', 'handle', 'name', 'blue', 'followers', 'followingCount', 'followedBy', 'following', 'unavailable', 'lostAt', 'bio', 'profileUrl', 'detectedAt', 'followerStatus', 'followerLastSeenAt', 'followerMissingSince'];
  return '\uFEFF' + [fields.join(','), ...users.map((user) => {
    const profileUrl = typeof user.handle === 'string' && HANDLE.test(user.handle)
      ? `https://x.com/${user.handle}`
      : typeof user.id === 'string' && ID.test(user.id) ? `https://x.com/i/user/${user.id}` : '';
    const detectedDate = time(user.lostAt) ? new Date(user.lostAt) : null;
    const detectedAt = detectedDate && Number.isFinite(detectedDate.getTime()) ? detectedDate.toISOString() : '';
    const dateText = value => time(value) && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : '';
    const row = { ...user, profileUrl, detectedAt, followerLastSeenAt: dateText(user.followerLastSeenAt), followerMissingSince: dateText(user.followerMissingSince) };
    return fields.map((key) => csvCell(row[key])).join(',');
  })].join('\r\n');
}

function validatedAuthorFollow(value) {
  const fields = ['id', 'status', 'createdAt', 'updatedAt', 'detail'];
  if (!object(value) || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))
    || typeof value.id !== 'string' || !RUN_ID.test(value.id) || !['pending', 'unknown', 'success', 'failed'].includes(value.status)
    || !time(value.createdAt) || !time(value.updatedAt) || value.updatedAt < value.createdAt || value.updatedAt > Date.now() + 60000
    || typeof value.detail !== 'string' || value.detail.length > 300) throw new Error('INVALID_AUTHOR_FOLLOW');
  return { ...value };
}

function validatedAccount(input, key) {
  if (!object(input) || requireId(input.id) !== key || !HANDLE.test(input.handle || '')) throw new Error('INVALID_ACCOUNT');
  if (!Array.isArray(input.users) || input.users.length > constants.MAX_USERS) throw new Error('USER_LIMIT');
  const seen = new Set();
  const users = input.users.map((raw) => {
    const user = normalizeUser(raw);
    if (seen.has(user.id) || user.id === key) throw new Error('DUPLICATE_OR_SELF_USER');
    seen.add(user.id);
    return { ...user, lastExplicitFollowedBy: tri(raw.lastExplicitFollowedBy), lastExplicitAt: time(raw.lastExplicitAt), lostAt: time(raw.lostAt) };
  });
  if (!Array.isArray(input.ignored) || input.ignored.length > constants.MAX_USERS) throw new Error('INVALID_IGNORES');
  const ignored = [...new Set(input.ignored.map(requireId))];
  if (!Array.isArray(input.events) || input.events.length > constants.MAX_EVENTS) throw new Error('EVENT_LIMIT');
  const events = input.events.map((event) => {
    if (!object(event) || !['lost', 'regained', 'unfollowed'].includes(event.type) || !time(event.at)) throw new Error('INVALID_EVENT');
    return { type: event.type, userId: requireId(event.userId), handle: HANDLE.test(event.handle || '') ? event.handle : '', at: event.at };
  });
  if (!Array.isArray(input.actions) || input.actions.length > constants.MAX_USERS + constants.MAX_EVENTS) throw new Error('ACTION_LIMIT');
  const actionIds = new Set();
  const pendingUsers = new Set();
  const actions = input.actions.map((action) => {
    if (!object(action) || typeof action.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(action.id) || actionIds.has(action.id)) throw new Error('INVALID_ACTION_ID');
    actionIds.add(action.id);
    if (!['pending', 'unknown', 'success', 'failed'].includes(action.status) || !time(action.createdAt) || !time(action.updatedAt)) throw new Error('INVALID_ACTION');
    const userId = requireId(action.userId);
    if (['pending', 'unknown'].includes(action.status)) {
      if (pendingUsers.has(userId)) throw new Error('DUPLICATE_PENDING');
      pendingUsers.add(userId);
    }
    return { id: action.id, userId, handle: HANDLE.test(action.handle || '') ? action.handle : '',
      name: text(action.name, 120), status: action.status, createdAt: action.createdAt, updatedAt: action.updatedAt, detail: text(action.detail, 300) };
  });
  let lastScan = null;
  if (input.lastScan !== null) {
    const scan = input.lastScan;
    if (!object(scan) || !time(scan.startedAt) || !time(scan.finishedAt) || scan.finishedAt < scan.startedAt || scan.finishedAt > Date.now() + 60000 || scan.complete !== true || scan.count !== users.length) throw new Error('INVALID_SCAN');
    lastScan = { startedAt: scan.startedAt, finishedAt: scan.finishedAt, source: text(scan.source, 40), count: users.length, complete: true,
      ...(Object.hasOwn(scan, 'verification') ? { verification: scanVerification(scan.verification, users.length) } : {}) };
  }
  const historyIds = new Set();
  if (Object.hasOwn(input, 'relationshipHistory') && (!Array.isArray(input.relationshipHistory) || input.relationshipHistory.length > constants.MAX_HISTORY)) throw new Error('HISTORY_LIMIT');
  const relationshipHistory = (input.relationshipHistory || []).map(item => {
    if (!object(item) || Object.keys(item).some(field => !['id', 'lastExplicitFollowedBy', 'lastExplicitAt', 'lostAt'].includes(field))) throw new Error('INVALID_HISTORY');
    const id = requireId(item.id);
    if (id === key || seen.has(id) || historyIds.has(id)) throw new Error('DUPLICATE_OR_SELF_HISTORY');
    historyIds.add(id);
    if (![true, false, null].includes(item.lastExplicitFollowedBy)
      || (item.lastExplicitAt !== null && !time(item.lastExplicitAt)) || (item.lostAt !== null && !time(item.lostAt))) throw new Error('INVALID_HISTORY');
    if ((item.lastExplicitFollowedBy === null && item.lostAt === null)
      || (item.lastExplicitFollowedBy === true && item.lostAt !== null)
      || (item.lastExplicitAt && item.lostAt && item.lostAt > item.lastExplicitAt)
      || (item.lastExplicitAt && item.lastExplicitAt > (lastScan?.finishedAt || Date.now() + 60000))
      || (item.lostAt && item.lostAt > (lastScan?.finishedAt || Date.now() + 60000))) throw new Error('INVALID_HISTORY');
    return { id, lastExplicitFollowedBy: item.lastExplicitFollowedBy, lastExplicitAt: item.lastExplicitAt, lostAt: item.lostAt };
  });
  const followers = Object.hasOwn(input, 'followers') ? validatedFollowers(input.followers, key) : null;
  const followerObservation = Object.hasOwn(input, 'followerObservation') ? validatedFollowerObservation(input.followerObservation, key) : null;
  const authorFollow = Object.hasOwn(input, 'authorFollow') ? validatedAuthorFollow(input.authorFollow) : null;
  if (followers && followerObservation && followerObservation.observedAt <= followers.observedAt) throw new Error('STALE_FOLLOWER_OBSERVATION');
  if (input.baselineAt === null) {
    // A Followers-first account has no Following evidence or action authority.
    // Older readers reject this explicit null instead of inventing a baseline.
    if (lastScan !== null || users.length || relationshipHistory.length || events.length || actions.length || (!followers && !followerObservation && !authorFollow)) throw new Error('INVALID_BASELINE');
  } else if (!time(input.baselineAt)) throw new Error('INVALID_BASELINE');
  return { id: key, handle: input.handle, users, events, ignored, actions, lastScan, baselineAt: input.baselineAt,
    ...(followers ? { followers } : {}),
    ...(followerObservation ? { followerObservation } : {}),
    ...(authorFollow ? { authorFollow } : {}),
    ...(relationshipHistory.length ? { relationshipHistory } : {}) };
}

export function validateBackup(data) {
  if (!object(data) || byteSize(data) > constants.MAX_BACKUP_BYTES || ![constants.SCHEMA, 2, 3].includes(data.schema) || !object(data.accounts)) throw new Error('INVALID_BACKUP');
  if (Object.keys(data).some((key) => !['schema', 'settings', 'accounts', 'exportedAt'].includes(key))) throw new Error('INVALID_BACKUP_KEY');
  const entries = Object.entries(data.accounts);
  if (entries.length > constants.MAX_ACCOUNTS) throw new Error('ACCOUNT_LIMIT');
  const state = defaultState();
  state.settings = cleanSettings(data.settings);
  for (const [key, value] of entries) state.accounts[requireId(key)] = validatedAccount(value, key);
  if (backupSchema(state) === 3) {
    if (data.schema !== 3) throw new Error('TERMINAL_SCAN_REQUIRES_NEW_READER');
    state.schema = 3;
  } else if (Object.values(state.accounts).some(account => account.followerObservation)) {
    if (data.schema !== 2) throw new Error('OBSERVATION_REQUIRES_NEW_READER');
    state.schema = 2;
  } else if (data.schema !== constants.SCHEMA) throw new Error('INVALID_BACKUP');
  return state;
}

export const backupSchema = state => Object.values(state.accounts).some(account => account.authorFollow || account.lastScan?.verification?.terminal
  || account.followers?.verification?.terminal || account.followers?.pendingMissing || account.followers?.missing.some(row => row.confirmedAt)
  || account.followers?.users.some(row => typeof row.following === 'boolean') || account.followerObservation?.users.some(row => typeof row.following === 'boolean'))
  ? 3 : Object.values(state.accounts).some(account => account.followerObservation) ? 2 : constants.SCHEMA;
