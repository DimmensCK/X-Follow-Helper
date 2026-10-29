import { createStore } from './store.js';
import { pageCommand } from './adapter.js';
import { byteSize, constants, getUser, followerComparisonCandidates } from './core.js';
import { createCheckpointStore, checkpointLimits } from './checkpoints.js';

const store = createStore();
const checkpoints = createCheckpointStore();
const WELCOME_KEY = 'xfhWelcomeV1';
let welcomeSeen = false;
let checkpointStartupError = null;
const committedCheckpointGenerations = new Set();
const MAX_BATCH = 20, CONFIRM_MS = 60_000, IMPORT_MS = 5 * 60_000;
let connection = null, job = null;
let commandQueue = Promise.resolve();
let runtimeWriteQueue = Promise.resolve();
let sharedViewQueue = Promise.resolve(), sharedView = null, sharedWriter = null;
const SHARED_VIEW_KEY = 'xmhSharedView';
const RESULT_VIEWS = ['all', 'lost', 'notFollowing', 'mutual', 'followers', 'followersOnly', 'followersNew', 'followersLost', 'unknown', 'unavailable', 'ignored', 'other'];
let viewCache = null;
let viewRevision = 0, viewPromise = null;
const viewEpoch = crypto.randomUUID();
let stopRevision = 0;
const controllerDocuments = new Map();
const panelTabs = new Set();
const panelLayouts = new Map();
function invalidateView() { viewRevision++; viewCache = null; }
const proposals = new Map();
const importProposals = new Map();
const documentAuthorizations = new Map();
const isX = value => { try { const u = new URL(value); return u.protocol === 'https:' && ['x.com', 'twitter.com'].includes(u.hostname); } catch { return false; } };
const trustedDashboard = sender => sender?.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('dashboard.html') && (!sender.origin || sender.origin === chrome.runtime.getURL('').replace(/\/$/, ''));
const embeddedTab = sender => Number.isInteger(sender?.tab?.id) && sender.frameId > 0 ? sender.tab.id : null;
const fail = code => { throw new Error(code); };
function authorizationScope(documentId) {
  if (!documentId) return null;
  if (!documentAuthorizations.has(documentId)) documentAuthorizations.set(documentId, {});
  return documentAuthorizations.get(documentId);
}
function verifyAuthorizationScope(documentId, scope) {
  if (scope && documentAuthorizations.get(documentId) !== scope) fail('CONTROLLER_CLOSED');
}
function revokeDocumentAuthorizations(documentId) {
  if (!documentId) return;
  documentAuthorizations.delete(documentId);
  for(const [tabId,layout] of panelLayouts)if(layout.documentId===documentId)panelLayouts.delete(tabId);
  for (const [token, proposal] of proposals) if (proposal.uiDocumentId === documentId) proposals.delete(token);
  for (const [token, proposal] of importProposals) if (proposal.uiDocumentId === documentId) importProposals.delete(token);
  if (sharedWriter?.documentId === documentId) sharedWriter = null;
}
function cleanSharedValue(value) {
  const object = input => input && typeof input === 'object' && !Array.isArray(input);
  const id = input => typeof input === 'string' && /^\d{1,30}$/.test(input);
  const keys = ['accountId', 'view', 'query', 'sort', 'blueOnly', 'dataTab', 'lastResultsView', 'anchor', 'profileUserId'];
  const hasFilter = object(value) && Object.hasOwn(value, 'verificationFilter');
  if (!object(value) || Object.keys(value).length !== keys.length + Number(hasFilter) || keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !keys.includes(key) && key !== 'verificationFilter')) fail('INVALID_SHARED_VIEW');
  if (hasFilter && (!['all', 'blue', 'standard'].includes(value.verificationFilter) || value.blueOnly !== (value.verificationFilter === 'blue'))) fail('INVALID_SHARED_VIEW');
  if (!(value.accountId === null || id(value.accountId)) || ![...RESULT_VIEWS, 'data'].includes(value.view)
    || typeof value.query !== 'string' || value.query.length > 200 || typeof value.blueOnly !== 'boolean'
    || !['anomalies', 'recent', 'followersDesc', 'followersAsc', 'name', 'handle'].includes(value.sort)
    || !['storage', 'settings', 'unresolved'].includes(value.dataTab) || !RESULT_VIEWS.includes(value.lastResultsView)
    || !(value.profileUserId === null || id(value.profileUserId))) fail('INVALID_SHARED_VIEW');
  if (value.anchor !== null && (!object(value.anchor) || Object.keys(value.anchor).length !== 2 || !id(value.anchor.userId)
    || !Number.isInteger(value.anchor.offset) || value.anchor.offset < 0 || value.anchor.offset >= 72)) fail('INVALID_SHARED_VIEW');
  if (value.accountId === null && (value.anchor !== null || value.profileUserId !== null)) fail('INVALID_SHARED_VIEW');
  const clean = structuredClone(value);
  clean.verificationFilter = hasFilter ? value.verificationFilter : value.blueOnly ? 'blue' : 'all';
  if (clean.view === 'other' || (clean.view === 'data' && clean.lastResultsView === 'other')) {
    clean.verificationFilter = 'all'; clean.blueOnly = false;
  }
  if ((['followers', 'followersOnly', 'followersNew', 'followersLost'].includes(clean.view)
    || (clean.view === 'data' && ['followers', 'followersOnly', 'followersNew', 'followersLost'].includes(clean.lastResultsView)))
    && ['followersDesc', 'followersAsc'].includes(clean.sort)) clean.sort = 'anomalies';
  return clean;
}
function newSharedView() {
  return { schema: 1, revision: `${crypto.randomUUID()}:0`, value: { accountId: null, view: 'all', query: '', sort: 'anomalies', blueOnly: false, verificationFilter: 'all',
    dataTab: 'storage', lastResultsView: 'all', anchor: null, profileUserId: null } };
}
function restoreSharedView(saved) {
  try {
    if (saved?.schema !== 1 || typeof saved.revision !== 'string' || !/^[a-f0-9-]{36}:\d{1,12}$/.test(saved.revision)) return newSharedView();
    return { schema: 1, revision: saved.revision, value: cleanSharedValue(saved.value) };
  } catch { return newSharedView(); }
}
const sharedSnapshot = () => structuredClone(sharedView);
async function activeSharedWriter(message, sender) {
  if (message.visible !== true || !sender.documentId) return false;
  // An embedded host must actually be the active tab. Visibility of the trusted
  // extension document is supplied by its UI; polling never requests a lease.
  if (Number.isInteger(sender.tab?.id)) return (await chrome.tabs.get(sender.tab.id)).active === true;
  return true;
}
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  welcomeSeen = (await chrome.storage.local.get(WELCOME_KEY))[WELCOME_KEY]?.seen === true;
  const saved = await chrome.storage.session.get(['connection', 'job', 'panelTabs', SHARED_VIEW_KEY]);
  sharedView = restoreSharedView(saved[SHARED_VIEW_KEY]);
  await chrome.storage.session.set({ [SHARED_VIEW_KEY]: sharedView });
  if (Array.isArray(saved.panelTabs) && saved.panelTabs.length) {
    const existing = new Set((await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] })).map(tab => tab.id));
    for (const id of saved.panelTabs.slice(-20)) if (Number.isInteger(id) && existing.has(id)) panelTabs.add(id);
  }
  if (saved.job?.commandToken && Number.isInteger(saved.job.tabId)) {
    try { await call(saved.job.tabId, { type: 'cancel', token: saved.job.commandToken }); } catch { /* The receipt remains unresolved. */ }
  }
  await store.recoverActions();
  // A crash after committing the complete list must not offer that old traversal again.
  const checkpointIndex = await checkpoints.summaries().catch(() => ({}));
  for (const [id, item] of Object.entries(checkpointIndex)) {
    if (item.corrupt) continue;
    const account = await store.account(id);
    const savedCheckpoint = await checkpoints.load(id).catch(() => null);
    if (savedCheckpoint && account?.followers?.verification?.runId === savedCheckpoint.runId) {
      committedCheckpointGenerations.add(savedCheckpoint.generation);
      try { await checkpoints.clear(id, savedCheckpoint.token); }
      catch { checkpointStartupError = 'CHECKPOINT_CLEANUP_FAILED'; }
    }
  }
  connection = saved.connection || null;
  job = saved.job ? { ...saved.job, running: false, phase: saved.job.running ? 'interrupted' : saved.job.phase } : null;
  if (job?.kind === 'scan' && saved.job.running && typeof job.scanId === 'string') {
    job.followingSaved = false; job.followersSaved = false;
    delete job.followingSavedAt; delete job.followersSavedAt;
    const account = await store.account(job.accountId);
    if (account?.lastScan?.verification?.runId === job.scanId) {
      job.followingSaved = true; job.followingSavedAt = account.lastScan.finishedAt; job.done = job.total = account.lastScan.count;
    }
    if (account?.followers?.verification?.runId === (job.checkpointRunId || job.scanId)) {
      job.followersSaved = true; job.followersSavedAt = account.followers.observedAt; job.followersDone = job.followersTotal = account.followers.users.length;
    }
    if (scanScopesSaved(job)) { job.phase = 'complete'; job.finishedAt = Math.max(job.followingSavedAt || 0, job.followersSavedAt || 0); delete job.error; delete job.errorDetails; }
  }
  await saveRuntime();
})().catch(error => { console.error('Initialization failed', error.message); throw error; });

function saveRuntime() {
  // Capture when this write runs, so an older delayed save cannot overwrite
  // newer panel/job intent after it has already been persisted.
  const saving = runtimeWriteQueue.then(() => chrome.storage.session.set({ connection, job, panelTabs: [...panelTabs] }));
  runtimeWriteQueue = saving.catch(() => {});
  return saving;
}
async function view() {
  if (viewCache) return viewCache;
  if (viewPromise) return viewPromise;
  viewPromise = (async () => {
    for (;;) {
      const revision = viewRevision;
      const state = await store.read(), accounts = Object.values(state.accounts);
      if (revision !== viewRevision) continue;
      const stats = { bytes: byteSize({ [constants.STORAGE_KEY]: state }), limitBytes: constants.MAX_BYTES, accountCount: accounts.length,
        userCount: accounts.reduce((n, a) => n + a.users.length, 0), eventCount: accounts.reduce((n, a) => n + a.events.length, 0),
        followerCount: accounts.reduce((n, a) => n + (a.followers?.users.length || 0), 0), followerMissingCount: accounts.reduce((n, a) => n + (a.followers?.missing.length || 0), 0),
        unresolvedCount: accounts.reduce((n, a) => n + a.actions.filter(x => ['pending', 'unknown'].includes(x.status)).length
          + (['pending', 'unknown'].includes(a.authorFollow?.status) ? 1 : 0), 0) };
      viewCache = { state, stats, stateRevision: `${viewEpoch}:${revision}` };
      return viewCache;
    }
  })();
  try { return await viewPromise; } finally { viewPromise = null; }
}
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[constants.STORAGE_KEY]) invalidateView();
  if (changes[WELCOME_KEY]) welcomeSeen = changes[WELCOME_KEY].newValue?.seen === true;
});
async function publish() {
  try { await saveRuntime(); } catch { fail('SESSION_STATE_WRITE_FAILED'); }
  chrome.runtime.sendMessage({ type: 'UPDATE' }).catch(() => {});
}
function noteStatusWriteFailure() { if (job) job.statusWriteError = 'SESSION_STATE_WRITE_FAILED'; }
async function stopCurrent() {
  stopRevision++;
  proposals.clear();
  importProposals.clear();
  if (!job?.running) return job;
  if (job.kind === 'scan' && job.progressStage === 'followers') job.pauseRequested = true;
  job.stopRequested = true; job.phase = 'stopping';
  if (job.commandToken) void call(job.tabId, { type: 'cancel', token: job.commandToken }).catch(() => {});
  else if (job.kind === 'scan' && job.scanId) void call(job.tabId, { type: 'cancel', token: job.scanId }).catch(() => {});
  await publish();
  return job;
}
async function call(tabId, command, run = null) {
  if (!Number.isInteger(tabId)) fail('NO_X_TAB');
  const tab = await chrome.tabs.get(tabId);
  if (!isX(tab.url)) fail('NOT_X_TAB');
  if (run?.stopRequested) { const error = new Error('STOPPED_BEFORE_SEND'); error.beforeDispatch = true; throw error; }
  // Pin a collected page to its established document before dispatch. A new
  // document must not receive a cursor belonging to the old list.
  const documentId = ['scanPage', 'reconcileAction'].includes(command.type) ? run?.scanDocumentId : null;
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [0] }, world: 'MAIN', func: pageCommand, args: [command] });
  } catch (cause) {
    if (!/(?:Frame with ID 0 was removed|No frame with id 0|No document with (?:id|ID)|The frame was removed)/i.test(String(cause?.message || cause))) throw cause;
    // This says nothing about a command's side effects. Only context reads are
    // retried by readContext below; list reads and actions are never replayed.
    const error = new Error(documentId ? 'SCAN_DOCUMENT_CHANGED' : 'PAGE_LOADING');
    error.details = { requestState: 'frame_unavailable' }; throw error;
  }
  const frame = results.find(x => x.frameId === 0);
  const result = frame?.result;
  if (!result) fail('PAGE_NO_RESULT');
  if (result.ok === false && !['unfollow', 'authorFollow'].includes(command.type)) {
    const error = new Error(result.error?.code || (typeof result.error === 'string' ? result.error : 'PAGE_ERROR'));
    const source = result.error || {};
    error.details = {
      status: Number.isInteger(source.status) && source.status >= 100 && source.status <= 599 ? source.status : null,
      operation: ['Following', 'Followers', 'UserByRestId', 'UserByScreenName'].includes(source.operation) ? source.operation : null,
      method: source.method === 'GET' ? 'GET' : null, retryable: source.retryable === true,
      transactionState: ['fresh', 'unavailable'].includes(source.transactionState) ? source.transactionState : null,
      transactionReason: /^transaction_[a-z_]+$/.test(source.transactionReason || '') ? source.transactionReason : null,
      templateGeneration: Number.isSafeInteger(source.templateGeneration) && source.templateGeneration > 0 ? source.templateGeneration : null,
      nativeRequestGeneration: Number.isSafeInteger(source.nativeRequestGeneration) && source.nativeRequestGeneration > 0 ? source.nativeRequestGeneration : null,
      preferredPageSize: Number.isInteger(source.preferredPageSize) && source.preferredPageSize >= 1 && source.preferredPageSize <= 100 ? source.preferredPageSize : null,
      attempts: Number.isInteger(source.attempts) && source.attempts >= 0 && source.attempts <= 2 ? source.attempts : 0,
      requestedCount: Number.isInteger(source.requestedCount) && source.requestedCount >= 1 && source.requestedCount <= 100 ? source.requestedCount : null,
      pageSizeFallback: source.pageSizeFallback === true,
      fallbackReason: source.fallbackReason === 'http_400_page_size' ? source.fallbackReason : null,
      transport: source.transport === 'native-observed' ? source.transport : 'replay',
      retryAfterMs: Number.isFinite(source.retryAfterMs) && source.retryAfterMs >= 0 ? source.retryAfterMs : null,
      rateLimit: cleanRateLimit(source.rateLimit), xCodes: Array.isArray(source.xCodes) ? source.xCodes.filter(n => Number.isSafeInteger(n) && n >= 0).slice(0, 8) : [],
    };
    throw error;
  }
  return { ...result, _documentId: frame.documentId || null };
}
async function connect(tabId) {
  if (job?.running) fail('BUSY');
  const result = await readContext(tabId);
  idle();
  if (!result.account?.id) fail('ACCOUNT_UNKNOWN');
  connection = { ...result, tabId };
  proposals.clear();
  await publish();
  return connection;
}
async function readContext(tabId, run = null) {
  const deadline = Date.now() + 5000, startedAtStopRevision = stopRevision;
  for (;;) {
    if (run?.stopRequested || stopRevision !== startedAtStopRevision) fail('STOPPED_BEFORE_SEND');
    try { return await call(tabId, { type: 'context' }, run); }
    catch (error) {
      if (error.message !== 'PAGE_LOADING' || Date.now() >= deadline) throw error;
      // A reload can temporarily remove frame 0. Waiting for this local,
      // side-effect-free identity read does not repeat navigation or HTTP.
      await nap(200, run);
    }
  }
}
async function verify(tabId, accountId) {
  const run = job?.running && job.tabId === tabId ? job : null;
  const result = await readContext(tabId, run);
  if (result.account?.id !== accountId) fail('ACCOUNT_CHANGED');
  return result;
}
function idle() { if (job?.running) fail('BUSY'); }
const scanIdentityReads = new WeakMap();
async function ensureScanIdentity(run, context, deadline = Date.now() + 20000) {
  const known = value => /^[A-Za-z0-9_]{1,15}$/.test(value?.account?.handle || '');
  const documentId = context._documentId;
  let attempted = scanIdentityReads.get(run);
  if (!attempted) { attempted = new Set(); scanIdentityReads.set(run, attempted); }
  while (!run.stopRequested && Date.now() < deadline) {
    if (context.account?.id !== run.accountId) fail('ACCOUNT_CHANGED');
    if (documentId && context._documentId !== documentId) fail('SCAN_DOCUMENT_CHANGED');
    if (known(context)) return context;
    if (run.preparation?.stage !== 'identify_account') {
      run.preparation = { kind: run.progressStage || (run.source === 'followers' ? 'followers' : 'following'), stage: 'identify_account', startedAt: Date.now() };
      await publish();
    }
    const key = context._documentId || context.observerInstance || 'current-document';
    if (context.readyProfileById === true && !attempted.has(key)) {
      attempted.add(key);
      // Only a template already observed in this account's native page can
      // recover its name. Imported names and the URL are never identity proof.
      try {
        const refreshed = await call(run.tabId, { type: 'refreshContext', accountId: run.accountId }, run);
        if (refreshed.account?.id !== run.accountId) fail('ACCOUNT_CHANGED');
        if (documentId && refreshed._documentId !== documentId) fail('SCAN_DOCUMENT_CHANGED');
      } catch (error) {
        // A valid profile can omit its counts; wait for its observed identity.
        // Permission, HTTP, network, and rate-limit errors retain their cause.
        if (!['needs_profile_template', 'profile_counts_unavailable'].includes(error.message)) throw error;
      }
    }
    await nap(250, run);
    if (!run.stopRequested) context = await verify(run.tabId, run.accountId);
  }
  fail(run.stopRequested ? 'STOPPED_BEFORE_SEND' : 'account_handle_unknown');
}
function bound(accountId) {
  if (!connection || connection.account?.id !== accountId) fail('ACCOUNT_NOT_CONNECTED');
  return connection.tabId;
}
async function eligibility(accountId, ids) {
  const account = await store.account(accountId);
  if (!account) fail('NO_BASELINE');
  const scanned = account.lastScan?.finishedAt;
  if (!Number.isFinite(scanned) || account.lastScan?.complete !== true || scanned > Date.now() + 30_000) fail('NO_BASELINE');
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_BATCH || new Set(ids).size !== ids.length) fail('BATCH_SIZE');
  return ids.map(id => {
    const user = account.users.find(u => u.id === id);
    if (!user || user.following !== true || user.unavailable || account.ignored.includes(id)) fail('INELIGIBLE_TARGET');
    if (account.actions.some(a => a.userId === id && ['pending', 'unknown'].includes(a.status))) fail('ACTION_UNRESOLVED');
    return user;
  });
}
async function nap(ms, run = job) {
  const until = Date.now() + ms;
  while (Date.now() < until && !run?.stopRequested) await new Promise(resolve => setTimeout(resolve, Math.min(200, until - Date.now())));
}
function cleanRateLimit(value) {
  const number = key => Number.isSafeInteger(value?.[key]) && value[key] >= 0 ? value[key] : null;
  return { remaining: number('remaining'), limit: number('limit'), resetAt: number('resetAt'), retryAfterMs: number('retryAfterMs') };
}
function recordScanFailure(run, error) {
  run.readCount = run.progressStage === 'followers' ? (run.followersDone || 0) : (run.done || 0);
  run.error = error.message;
  run.errorDetails = { ...(error.details || {}), code: error.message, phase: run.phase, readCount: run.readCount,
    scope: run.progressStage === 'followers' ? 'followers' : 'following', source: run.source, readMethod: run.readMethod || null };
  run.phase = run.stopRequested ? (run.pauseRequested ? 'paused' : 'stopped') : 'failed';
}
async function waitFor(run, probe, timeout = 20000) {
  const until = Date.now() + timeout;
  while (!run.stopRequested && Date.now() < until) {
    if (await probe()) return true;
    await nap(250, run);
  }
  return false;
}
async function prepareActionContext(run) {
  let documentId = null, context;
  const checked = async () => {
    const next = await verify(run.tabId, run.accountId);
    if (run.stopRequested) fail('STOPPED_BEFORE_SEND');
    if (documentId && next._documentId !== documentId) fail('PAGE_CHANGED');
    documentId ||= next._documentId;
    context = next; return next;
  };
  await checked();
  // The live adapter's final per-target read remains mandatory. This preparation
  // captures only a native profile template and never scans the whole account.
  if (context.readyProfile === false) {
    const ownProfilePath = `/${context.account?.handle || ''}`.toLowerCase();
    const pathOf = value => { try { return new URL(value).pathname.replace(/\/$/, '').toLowerCase(); } catch { return ''; } };
    let routePhase = pathOf(context.url) === ownProfilePath ? 'leave' : 'profile';
    const prepared = await waitFor(run, async () => {
      await checked();
      if (context.readyProfile) return true;
      // Clicking a profile already on screen causes no fresh native request.
      // Leave once via its own Following link and return, without scanPage or reload.
      if (routePhase === 'outside') {
        if (pathOf(context.url) === ownProfilePath) return false;
        routePhase = 'profile';
      }
      if (routePhase === 'capture') return false;
      try {
        const next = await call(run.tabId, { type: 'prepareRoute', accountId: run.accountId, route: routePhase === 'leave' ? 'following' : 'profile' }, run);
        if (next.navigated || next.readyRoute) routePhase = routePhase === 'leave' ? 'outside' : 'capture';
      }
      catch (error) { if (!['needs_route_navigation', 'account_handle_unknown'].includes(error.message)) throw error; }
      return false;
    });
    if (!prepared) fail(run.stopRequested ? 'STOPPED_BEFORE_SEND' : 'preparation_timeout');
  }
  if (run.stopRequested) fail('STOPPED_BEFORE_SEND');
  connection = { ...context, tabId: run.tabId };
}
// Route clicks and native responses happen at different times. A successful
// click is an outstanding navigation, not permission to click again next poll.
async function prepareList(run, kind, { forceFresh = false, revisit = false, afterTime = Date.now(), documentId = null } = {}) {
  const beganAt = Date.now(), deadline = beganAt + 20000;
  let navigation = null, reloaded = false, pageSince = beganAt, previousPage = null;
  let context, pageKind = 'other', triedProfile = false, needProfile = revisit, reloadFrom = null;
  const routeKind = value => {
    const pathname = new URL(value.url).pathname.toLowerCase().replace(/\/$/, '');
    const base = `/${value.account.handle}`.toLowerCase();
    if (pathname === base) return 'profile';
    for (const suffix of ['following', 'followers', 'verified_followers', 'followers_you_follow']) if (pathname === `${base}/${suffix}`) return suffix;
    return 'other';
  };
  const stage = async value => {
    if (run.preparation?.kind === kind && run.preparation.stage === value) return;
    run.preparation = { kind, stage: value, startedAt: beganAt }; await publish();
  };
  const failure = (code, request = null) => {
    const error = new Error(code);
    error.details = { operation: kind === 'followers' ? 'Followers' : 'Following', ...(request?.method === 'GET' ? { method: 'GET' } : {}),
      preparationStage: run.preparation?.stage || 'open_list', pageKind,
      requestState: request?.state || 'not_observed', observerBuild: context?.observerBuild ?? null,
      ...(Number.isInteger(request?.status) ? { status: request.status } : {}) };
    throw error;
  };
  while (!run.stopRequested && Date.now() < deadline) {
    context = await verify(run.tabId, run.accountId);
    if (run.stopRequested) break;
    if (reloadFrom && context._documentId === reloadFrom) { await nap(250, run); continue; }
    if (reloadFrom) { if (documentId) documentId = context._documentId; reloadFrom = null; }
    if (documentId && context._documentId !== documentId) fail('SCAN_DOCUMENT_CHANGED');
    context = await ensureScanIdentity(run, context, deadline);
    pageKind = routeKind({ ...context, url: context.url || (await chrome.tabs.get(run.tabId)).url });
    const now = Date.now();
    if (previousPage !== pageKind) { previousPage = pageKind; pageSince = now; }
    const request = context.scanPreparation?.[kind];
    const freshResponse = Number.isFinite(request?.finishedAt) && request.finishedAt >= beganAt;
    // Preserve the real native failure. A denied or rate-limited request is
    // never converted to a navigation retry or an alternative transport.
    if (freshResponse && request.state === 'http_error') failure('http_error', request);
    if (freshResponse && request.state === 'network_error') failure('preparation_network_error', request);
    const template = context.scanTemplates?.[kind];
    const readyList = kind === 'followers' ? context.readyFollowers : context.ready;
    if (!needProfile && readyList && (!forceFresh || template?.observedAt >= afterTime)) {
      delete run.preparation; return { context, reloaded, afterTime };
    }
    if (navigation) {
      if (pageKind === navigation.target) {
        navigation = null; pageSince = now;
        if (pageKind === 'profile') needProfile = false;
      } else {
        if (now - navigation.at >= 8000) failure('preparation_navigation_timeout', request);
        await stage('wait_navigation'); await nap(250, run); continue;
      }
    }
    if (freshResponse && request.state === 'complete' && !readyList && now - request.finishedAt >= 500) {
      failure('preparation_response_unusable', request);
    }
    if (pageKind === kind && !needProfile) {
      await stage('wait_response');
      const pending = request?.state === 'pending';
      // Give the original request time to finish. Reload only a cached page
      // with no request in flight, and at most once in this preparation.
      if (!pending && !reloaded && (now - pageSince >= 4000 || forceFresh && readyList)) {
        await stage('reload_list');
        if (run.stopRequested) break;
        reloaded = true; reloadFrom = context._documentId || null; afterTime = Date.now(); await chrome.tabs.reload(run.tabId);
        pageSince = Date.now();
      }
      await nap(250, run); continue;
    }
    const intermediate = kind === 'followers' && ['verified_followers', 'followers_you_follow'].includes(pageKind);
    const route = needProfile || pageKind === 'other' ? 'profile' : kind;
    await stage(route === 'profile' ? 'open_profile' : 'open_list');
    try {
      const result = await call(run.tabId, { type: 'prepareRoute', accountId: run.accountId, route }, run);
      if (result.navigated || result.readyRoute) {
        const target = result.intermediateRoute || route;
        if (route === 'profile') triedProfile = true;
        if (result.readyRoute && route === 'profile') needProfile = false;
        if (target !== pageKind) navigation = { target, at: Date.now() };
        if (result.readyRoute) continue;
      }
    } catch (error) {
      if (error.message !== 'needs_route_navigation') throw error;
      // The list tabs may mount after the intermediate/profile route. Wait
      // there; returning to profile repeatedly would cancel that mounting.
      if (!intermediate && pageKind !== 'profile' && route !== 'profile' && !triedProfile) needProfile = true;
    }
    await nap(250, run);
  }
  if (run.stopRequested) fail('STOPPED_BEFORE_SEND');
  failure(navigation ? 'preparation_navigation_timeout' : pageKind === kind ? 'preparation_response_timeout' : 'preparation_link_missing', context?.scanPreparation?.[kind]);
}
async function prepareFollowers(run) { return prepareList(run, 'followers'); }
async function followerBaseRevision(accountId) {
  const account = await store.account(accountId);
  const bytes = new TextEncoder().encode(JSON.stringify([accountId, account?.followers || null, account?.followerObservation || null]));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}
async function scanRecoveryChoice(message, accountId, source) {
  if (!['followers', 'auto', 'dual'].includes(source)) {
    if (message.resume === true) fail('BAD_SCAN');
    return {};
  }
  if (message.resume !== undefined && typeof message.resume !== 'boolean') fail('BAD_SCAN');
  if (message.resumeAccountId !== undefined && message.resumeAccountId !== accountId) fail('CHECKPOINT_ACCOUNT_CHANGED');
  const summary = (await checkpoints.summaries())[accountId];
  if (summary && committedCheckpointGenerations.has(summary.generation) && message.resume !== true) {
    return { resumeFollowers: false, checkpointId: summary.generation };
  }
  const saved = message.resume ? await checkpoints.load(accountId) : summary;
  if (!saved) {
    if (message.resume || message.checkpointId) fail('CHECKPOINT_NOT_FOUND');
    return { resumeFollowers: false };
  }
  if (typeof message.resume !== 'boolean') fail('CHECKPOINT_CHOICE_REQUIRED');
  if (message.checkpointId !== saved.generation || message.resumeAccountId !== accountId) fail('CHECKPOINT_CHANGED');
  if (message.resume) {
    if (committedCheckpointGenerations.has(saved.generation)) fail('CHECKPOINT_ALREADY_SAVED');
    if (saved.expired) fail('CHECKPOINT_EXPIRED');
    if (!saved.resumable) fail('CHECKPOINT_INVALID');
    if (saved.baseRevision !== await followerBaseRevision(accountId)) fail('CHECKPOINT_BASE_CHANGED');
  }
  return { resumeFollowers: message.resume, checkpointId: saved.generation };
}
async function persistReadWait(run, waitUntil) {
  if (run.progressStage !== 'followers' || !run.checkpointToken) return;
  const saved = await checkpoints.update(run.accountId, run.checkpointToken, { waitUntil, status: run.stopRequested ? 'paused' : 'collecting' });
  run.checkpointToken = saved.token; run.checkpointSavedAt = saved.savedAt;
}
async function readPause(run, duration, reason) {
  if (run.stopRequested) fail('STOPPED_BEFORE_SEND');
  // Respect a server's reset without discarding a partially read list. These
  // bounds reject malformed/unbounded waits, not ordinary rate-limit windows.
  const serverWait = reason === 'rate_limit';
  if (!Number.isFinite(duration) || duration < 0 || duration > (serverWait ? 30 * 60_000 : 30_000)
    || serverWait && !run.checkpointToken && (run.serverWaitMs || 0) + duration > 60 * 60_000) {
    const error = new Error('SCAN_WAIT_TOO_LONG');
    error.details = { retryAfterMs: Number.isFinite(duration) ? duration : null, waitReason: reason,
      operation: run.progressStage === 'followers' ? 'Followers' : 'Following' }; throw error;
  }
  if (serverWait) run.serverWaitMs = (run.serverWaitMs || 0) + duration;
  const waitStartedAt = Date.now();
  run.waitUntil = waitStartedAt + duration; run.waitReason = reason;
  if (serverWait) await persistReadWait(run, run.waitUntil);
  await publish();
  try {
    while (!run.stopRequested && Date.now() < run.waitUntil) {
      await nap(Math.min(10_000, run.waitUntil - Date.now()), run);
      if (run.stopRequested) break;
      // Local identity checks keep this active MV3 job alive without making
      // another list request. They also catch account/document changes while
      // the panel is closed or the server asks for a long wait.
      if (serverWait) {
        const context = await verify(run.tabId, run.accountId);
        if (run.scanDocumentId && context._documentId !== run.scanDocumentId) fail('SCAN_DOCUMENT_CHANGED');
        if (!run.stopRequested) await publish();
      }
    }
  } finally {
    if (serverWait) {
      const field = run.progressStage === 'followers' ? 'followersWaitMs' : 'followingWaitMs';
      run[field] = (run[field] || 0) + Math.max(0, Date.now() - waitStartedAt);
      // Pausing does not cancel the server's deadline. A reopened browser still waits.
      await persistReadWait(run, run.waitUntil > Date.now() ? run.waitUntil : null);
    }
    run.waitUntil = null; run.waitReason = null;
  }
  if (run.stopRequested) fail('STOPPED_BEFORE_SEND');
}
function recordReadStats(run, command, request, data = null) {
  if (!['following', 'followers'].includes(command.kind)) return;
  run.readStats ||= {};
  const stats = run.readStats[command.kind] ||= { pages: 0, requests: 0, reusedPages: 0, scrollPages: 0,
    pageSizeFallbacks: 0, requestedPageSize: null, actualPageSize: null, minActualPageSize: null, maxActualPageSize: null, fallbackReason: null };
  // Bounded job diagnostics only: no response bodies, IDs, cursors or headers.
  // Native-observed pages are reused responses, not new requests by the helper.
  if (request?.transport !== 'native-observed' && Number.isInteger(request?.attempts) && request.attempts >= 0 && request.attempts <= 2) stats.requests += request.attempts;
  stats.requestedPageSize = Number.isInteger(request?.requestedCount) && request.requestedCount >= 1 && request.requestedCount <= 100 ? request.requestedCount : null;
  if (request?.pageSizeFallback === true) { stats.pageSizeFallbacks++; stats.fallbackReason = 'http_400_page_size'; }
  if (!data || !Array.isArray(data.users)) return;
  stats.pages++;
  if (command.source === 'scroll') stats.scrollPages++;
  else if (request?.transport === 'native-observed') stats.reusedPages++;
  const size = data.users.length + (Array.isArray(data.departedIds) ? data.departedIds.length : 0);
  stats.actualPageSize = size;
  stats.minActualPageSize = stats.minActualPageSize === null ? size : Math.min(stats.minActualPageSize, size);
  stats.maxActualPageSize = stats.maxActualPageSize === null ? size : Math.max(stats.maxActualPageSize, size);
}
async function readPage(run, command) {
  command = { ...command, token: run.scanId };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const data = await call(run.tabId, command, run);
      recordReadStats(run, command, data.request, data);
      run.lastRequest = data.request ? { operation: command.kind === 'followers' ? 'Followers' : 'Following', status: data.request.status, durationMs: data.request.durationMs,
        attempts: data.request.transport === 'native-observed' ? 0 : attempt, transport: data.request.transport || 'replay' } : null;
      return data;
    } catch (error) {
      const details = error.details;
      recordReadStats(run, command, details);
      if (run.stopRequested) throw error;
      if (Number.isInteger(details?.preferredPageSize) && details.preferredPageSize >= 1 && details.preferredPageSize <= 100) command.pageSize = details.preferredPageSize;
      const recoverableStatus = details && ([502, 503, 504].includes(details.status) || (details.status === 429 && details.retryAfterMs !== null) || ([null, 200].includes(details.status) && ['timeout', 'network_error'].includes(error.message)));
      const nativeRateRetry = command.source === 'scroll' && details?.status === 429
        && Number.isSafeInteger(details.nativeRequestGeneration) && details.nativeRequestGeneration > 0
        && Number.isFinite(details.retryAfterMs) && details.retryAfterMs >= 0;
      if (command.source === 'scroll' && !nativeRateRetry || !details?.retryable || !recoverableStatus || details.method !== 'GET' || attempt === 3) throw error;
      // The page adapter marks only scan GET failures retryable; never replay mutations here.
      const delay = details.retryAfterMs ?? (500 * attempt);
      const serverWait = details.status === 429 || details.retryAfterMs > 0;
      if (!serverWait && (delay > 30_000 || (run.retryWaitMs || 0) + delay > 60_000)) throw error;
      run.retryCount = (run.retryCount || 0) + 1; run.retryWaitMs = (run.retryWaitMs || 0) + delay;
      run.lastReadError = { ...details, code: error.message };
      try { await readPause(run, delay, serverWait ? 'rate_limit' : 'retry'); }
      catch (waitingError) { waitingError.details = { ...details, ...(waitingError.details || {}) }; throw waitingError; }
      if (nativeRateRetry) command.nativeRetryAfterGeneration = details.nativeRequestGeneration;
    }
  }
}
async function paceRead(run, data) {
  const rate = cleanRateLimit(data.rateLimit);
  const exhaustedDelay = rate.remaining === 0 && rate.resetAt > Date.now() ? rate.resetAt - Date.now() : 0;
  const requiredDelay = Math.max(rate.retryAfterMs || 0, exhaustedDelay);
  const elapsed = Number.isFinite(data.request?.durationMs) && data.request.durationMs >= 0 ? data.request.durationMs : 0;
  const interval = data.request?.transport === 'native-observed' ? 0 : Math.max(0, 100 - elapsed);
  const delay = Math.max(interval, requiredDelay);
  if (delay) {
    try { await readPause(run, delay, requiredDelay ? 'rate_limit' : 'pacing'); }
    catch (error) { error.details = { operation: run.progressStage === 'followers' ? 'Followers' : 'Following',
      method: 'GET', status: data.request?.status ?? null, rateLimit: rate, ...(error.details || {}) }; throw error; }
  }
}
// Recover only failed list GETs. Each list gets one fresh replay, then one
// native-observation fallback. A changed account/document or denied access is
// never a reason to try another transport. Restart only the affected list so
// rows/cursors from different native generations cannot be combined.
async function recoverListRead(run, kind, error, source, recoveries, documentId) {
  const details = error.details;
  const operation = kind === 'followers' ? 'Followers' : 'Following';
  if (run.stopRequested || source === 'scroll' || recoveries >= 2 || error.message !== 'http_error'
    || details?.method !== 'GET' || details.status !== 404 || details.operation !== operation
    || !Number.isSafeInteger(details.templateGeneration) || details.templateGeneration <= 0) throw error;
  const afterTime = Date.now();
  run.readRecovery = { kind, attempt: recoveries + 1, transport: recoveries ? 'native-observed' : 'replay', status: 404 };
  run.lastReadError = { ...details, code: error.message }; await publish();
  const current = await verify(run.tabId, run.accountId);
  if (documentId && current._documentId !== documentId) fail('SCAN_DOCUMENT_CHANGED');
  await call(run.tabId, { type: 'invalidateScanTemplate', accountId: run.accountId, kind, generation: details.templateGeneration }, run);
  const prepared = await prepareList(run, kind, { forceFresh: true, revisit: true, afterTime, documentId });
  if (prepared.reloaded) {
    const counts = await refreshScanCounts(run, prepared.context);
    run.readRecovery.transport = 'native-observed'; run.readRecovery.reloaded = true;
    return { source: 'scroll', afterTime: prepared.afterTime, context: prepared.context,
      expectedStart: kind === 'followers' ? counts.expectedFollowers : counts.expectedTotal };
  }
  return { source: recoveries ? 'scroll' : 'api', afterTime };

}
async function refreshScanCounts(run, context) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  // Keep a still-fresh count for progress. Counts are not an atomic inventory
  // and cannot turn a terminal cursor into a failed scan.
  const fallback = { expectedTotal: context.profileFresh === true ? count(context.expectedTotal) : null,
    expectedFollowers: context.profileFresh === true ? count(context.expectedFollowers) : null };
  if (run.countReadCooldownUntil > Date.now()) return fallback;
  try {
    const result = await call(run.tabId, { type: 'refreshContext', accountId: run.accountId }, run);
    if (result.account?.id !== run.accountId) fail('ACCOUNT_CHANGED');
    if (context._documentId && result._documentId !== context._documentId) fail('SCAN_DOCUMENT_CHANGED');
    if (result.countsSource !== 'native-profile' || !Number.isFinite(result.countsObservedAt)
      || Math.abs(Date.now() - result.countsObservedAt) > 30_000) fail('SCAN_COUNTS_INVALID');
    return { expectedTotal: count(result.expectedTotal) ?? fallback.expectedTotal,
      expectedFollowers: count(result.expectedFollowers) ?? fallback.expectedFollowers };
  } catch (error) {
    // A profile count is advisory, not proof of list coverage. A failed count
    // GET must not discard an independently completed cursor traversal. Do not
    // retry this endpoint during its cooldown; account/document checks remain.
    if (!['needs_profile_template', 'profile_counts_unavailable', 'network_error', 'timeout', 'http_error', 'rate_limited', 'access_rejected', 'graphql_error', 'invalid_json', 'response_too_large', 'transaction_unavailable'].includes(error.message)) throw error;
    if (run.stopRequested) throw error;
    const current = await verify(run.tabId, run.accountId);
    if (context._documentId && current._documentId !== context._documentId) fail('SCAN_DOCUMENT_CHANGED');
    run.countReadError = { code: error.message, status: error.details?.status ?? null };
    const wait = Math.max(error.details?.retryAfterMs || 0, error.details?.rateLimit?.retryAfterMs || 0);
    if (wait > 0) run.countReadCooldownUntil = Date.now() + wait;
    if (error.message === 'access_rejected' || error.message === 'rate_limited' && wait === 0
      || error.details?.rateLimit?.remaining === 0 && wait === 0) run.countReadCooldownUntil = Number.MAX_SAFE_INTEGER;
    return fallback;
  }
}
async function prepareAndScan(run) {
  try {
    let context = await verify(run.tabId, run.accountId);
    let observerReloaded = false;
    if ((context.observerReady === false || (Number.isInteger(context.observerBuild) && context.observerBuild < 10)) && !run.stopRequested) {
      await chrome.tabs.reload(run.tabId); observerReloaded = true;
      const observed = await waitFor(run, async () => {
        context = await verify(run.tabId, run.accountId);
        return context.observerReady === true && (!Number.isInteger(context.observerBuild) || context.observerBuild >= 10);
      });
      if (!observed && !run.stopRequested) fail('preparation_timeout');
    }
    context = await ensureScanIdentity(run, context);
    if (run.source === 'followers') { await scan(run); return; }
    if (!context.ready || run.source === 'scroll') {
      await prepareList(run, 'following', { forceFresh: run.source === 'scroll', afterTime: run.startedAt });
    }
    if (run.stopRequested) { run.phase = 'stopped'; await finishScan(run); return; }
    run.phase = 'starting'; await publish();
    await scan(run);
  } catch (error) {
    recordScanFailure(run, error);
    await finishScan(run);
  }
}
async function collectList(run, kind, source, afterTime) {
  const isFollowers = kind === 'followers';
  const startingContext = await verify(run.tabId, run.accountId);
  let documentId = startingContext._documentId;
  run.scanDocumentId = documentId;
  const startCounts = await refreshScanCounts(run, startingContext);
  let expectedStart = isFollowers ? startCounts.expectedFollowers : startCounts.expectedTotal;
  const users = new Map(), cursors = new Set();
  let cursor = null, observation = null, pageExpected = null, pages = 0, complete = false, recoveries = 0, pageSize = 100;
  if (isFollowers) {
    const previous = run.resumeFollowers ? await checkpoints.load(run.accountId) : (await checkpoints.summaries())[run.accountId];
    if (run.resumeFollowers) {
      if (!previous || previous.token.generation !== run.checkpointId) fail('CHECKPOINT_CHANGED');
      if (previous.expired) fail('CHECKPOINT_EXPIRED');
      if (!previous.resumable) fail('CHECKPOINT_INVALID');
      if (previous.baseRevision !== await followerBaseRevision(run.accountId)) fail('CHECKPOINT_BASE_CHANGED');
      for (const user of previous.users) users.set(user.id, user);
      for (const value of previous.cursors) cursors.add(value);
      cursor = previous.nextCursor; pages = previous.pages; complete = previous.complete;
      expectedStart = previous.expectedStart; pageExpected = previous.pageExpected; pageSize = previous.pageSize;
      run.followersStartedAt = previous.startedAt; run.checkpointToken = previous.token;
      run.checkpointBaseRevision = previous.baseRevision; run.checkpointSavedAt = previous.savedAt;
      run.checkpointRunId = previous.runId;
      run.resumedFollowers = true;
    } else {
      if (previous && previous.generation !== run.checkpointId) fail('CHECKPOINT_CHANGED');
      run.checkpointBaseRevision = await followerBaseRevision(run.accountId);
      const created = await checkpoints.start({ account: startingContext.account, startedAt: run.followersStartedAt || Date.now(),
        expectedStart, pageSize, baseRevision: run.checkpointBaseRevision, runId: run.scanId });
      run.checkpointToken = created.token; run.checkpointSavedAt = created.savedAt; run.checkpointRunId = run.scanId;
    }
  }
  run.progressStage = kind; run.phase = isFollowers ? 'followers' : 'scanning';
  run.readMethod = source;
  if (isFollowers) { run.followersTotal = pageExpected ?? startCounts.expectedFollowers ?? expectedStart; run.followersDone = users.size; }
  else { run.total = expectedStart; run.done = 0; }
  await publish();
  for (let page = pages; !complete && page < (isFollowers ? 2000 : 1000) && !run.stopRequested; page++) {
    if (isFollowers && Date.now() - run.followersStartedAt >= checkpointLimits.TTL_MS) fail('CHECKPOINT_EXPIRED');
    let data;
    try { data = await readPage(run, { type: 'scanPage', kind, accountId: run.accountId, cursor, source, observation, afterTime, pageSize }); }
    catch (error) {
      if (pageExpected !== null) expectedStart ??= pageExpected;
      if (isFollowers && cursor && error.message === 'http_error' && error.details?.status === 400) {
        const saved = await checkpoints.update(run.accountId, run.checkpointToken, { status: 'invalid' }); run.checkpointToken = saved.token;
        fail('CHECKPOINT_CURSOR_INVALID');
      }
      const recovered = await recoverListRead(run, kind, error, source, recoveries, documentId);
      // A refreshed request template can reuse the saved API cursor. Native scroll
      // generations cannot, so never silently discard a persisted traversal.
      if (isFollowers && pages > 0) {
        if (recovered.source !== 'api' || recovered.context) {
          const saved = await checkpoints.update(run.accountId, run.checkpointToken, { status: 'invalid' }); run.checkpointToken = saved.token;
          fail('CHECKPOINT_CURSOR_INVALID');
        }
        recoveries++; source = recovered.source; afterTime = recovered.afterTime; page--; continue;
      }
      recoveries++; source = recovered.source; afterTime = recovered.afterTime;
      run.readMethod = source;
      if (recovered.context) {
        documentId = recovered.context._documentId; run.scanDocumentId = documentId;
        // A new traversal gets the latest advisory total. The old number may
        // have changed while X was serving pages.
        expectedStart = recovered.expectedStart ?? expectedStart;
        if (isFollowers) run.followersTotal = expectedStart; else run.total = expectedStart;
      }
      users.clear(); cursors.clear(); cursor = null; observation = null; pages = 0; pageExpected = null; run.readCount = 0;
      if (isFollowers) run.followersDone = 0; else run.done = 0;
      page = -1; continue;
    }
    if (documentId && data._documentId !== documentId) fail('SCAN_DOCUMENT_CHANGED');
    if (source === 'scroll') {
      if (!data.observation || (observation && (observation.instanceId !== data.observation.instanceId || observation.epoch !== data.observation.epoch || observation.sequence !== data.observation.sequence))) fail('SCAN_GENERATION_CHANGED');
      observation = data.observation;
    }
    if (data.account?.id !== run.accountId || !Array.isArray(data.users)) fail('SCAN_IDENTITY');
    if (Number.isInteger(data.preferredPageSize) && data.preferredPageSize >= 1 && data.preferredPageSize <= 100) pageSize = data.preferredPageSize;
    pages++;
    if (data.departedIds !== undefined && (!Array.isArray(data.departedIds) || data.departedIds.length > 1000
      || data.departedIds.some(id => typeof id !== 'string' || !/^\d{1,30}$/.test(id))
      || new Set(data.departedIds).size !== data.departedIds.length || data.users.some(user => data.departedIds.includes(user.id)))) fail('SCAN_CONFLICT');
    for (const id of data.departedIds || []) users.delete(id);
    for (const user of data.users) {
      // A cursor traversal is not an atomic snapshot. For an overlapping ID,
      // retain the later observation; conflicting rows inside one response are
      // still rejected by the adapter before reaching this loop.
      users.set(user.id, user);
    }
    if (users.size > (isFollowers ? 100_000 : 25_000)) fail(isFollowers ? 'FOLLOWERS_SCAN_LIMIT' : 'SCAN_LIMIT');
    run.readCount = users.size;
    if (isFollowers) run.followersDone = users.size; else run.done = users.size;
    if (Number.isSafeInteger(data.expectedTotal) && data.expectedTotal >= 0) {
      pageExpected = data.expectedTotal;
      if (isFollowers) run.followersTotal = data.expectedTotal; else run.total = data.expectedTotal;
    }
    if (data.complete !== true && (!data.cursor || cursors.has(data.cursor))) fail('SCAN_INCOMPLETE');
    if (isFollowers) {
      const rate = cleanRateLimit(data.rateLimit);
      const delay = Math.max(rate.retryAfterMs || 0, rate.remaining === 0 && rate.resetAt > Date.now() ? rate.resetAt - Date.now() : 0);
      const saved = await checkpoints.append(run.accountId, run.checkpointToken, { users: data.users, departedIds: data.departedIds || [],
        requestCursor: cursor, cursor: data.cursor || null, complete: data.complete === true, observedAt: Date.now(),
        expected: data.expectedTotal ?? null, pageSize, waitUntil: data.complete === true || !delay ? null : Date.now() + delay });
      run.checkpointToken = saved.token; run.checkpointSavedAt = saved.savedAt;
    }
    await publish();
    if (run.stopRequested) break;
    if (data.complete === true) { complete = true; break; }
    cursors.add(data.cursor); cursor = data.cursor;
    await paceRead(run, data);
  }
  if (run.stopRequested) fail('STOPPED_BEFORE_SEND');
  if (!complete) fail('SCAN_INCOMPLETE');
  const finalContext = await ensureScanIdentity(run, await verify(run.tabId, run.accountId));
  if (documentId && finalContext._documentId !== documentId) fail('SCAN_DOCUMENT_CHANGED');
  const endCounts = await refreshScanCounts(run, finalContext);
  const expectedEnd = isFollowers ? endCounts.expectedFollowers : endCounts.expectedTotal;
  if (run.stopRequested) fail('STOPPED_BEFORE_SEND');
  if (!finalContext.account.handle) fail('ACCOUNT_HANDLE_UNKNOWN');
  const countNotice = [expectedStart, pageExpected, expectedEnd].some(count => count !== null && count !== users.size);
  if (isFollowers) run.followersCountNotice = countNotice; else run.followingCountNotice = countNotice;
  return { users: [...users.values()], pages, expectedStart, expectedEnd, pageExpected, terminal: true, countNotice, context: finalContext };
}

async function verifyMissingFollowers(run, result) {
  const account = await store.account(run.accountId);
  if (!account?.followers && !account?.followerObservation) return [];
  if (run.countReadCooldownUntil > Date.now()) {
    run.absenceCheckError = { ...(run.countReadError || { code: 'rate_limited', status: 429 }) };
    return [];
  }
  // Use the same positive-evidence merge as storage, including older v2.4
  // observations. Candidate selection and reconciliation must not diverge.
  const selected = followerComparisonCandidates(account, result.users)
    .sort((a, b) => (a.lastCheckedAt || 0) - (b.lastCheckedAt || 0) || (a.lastSeenAt || 0) - (b.lastSeenAt || 0)).slice(0, 20);
  const checks = [];
  run.absenceCheckTotal = selected.length; run.absenceCheckDone = 0;
  const showCheckProgress = async () => { try { await publish(); } catch { run.statusWriteError = 'SESSION_STATE_WRITE_FAILED'; } };
  if (selected.length) await showCheckProgress();
  for (const user of selected) {
    if (run.stopRequested) fail('STOPPED_BEFORE_SEND');
    const context = await verify(run.tabId, run.accountId);
    if (run.scanDocumentId && context._documentId !== run.scanDocumentId) fail('SCAN_DOCUMENT_CHANGED');
    let stopChecking = false;
    try {
      // This adapter command is a read-only profile lookup, without the extra
      // common-follower query used by the interactive profile card.
      const checked = await call(run.tabId, { type: 'reconcileAction', accountId: run.accountId, userId: user.id, handle: user.handle, token: run.scanId }, run);
      if (checked.account?.id !== run.accountId || checked.user?.id !== user.id) fail('SCAN_IDENTITY');
      if (run.scanDocumentId && checked._documentId !== run.scanDocumentId) fail('SCAN_DOCUMENT_CHANGED');
      checks.push({ id: user.id, followedBy: typeof checked.user.followedBy === 'boolean' ? checked.user.followedBy : null,
        unavailable: checked.user.unavailable === true, checkedAt: Date.now() });
      run.absenceCheckDone = checks.length;
      if (checked.user.unavailable || typeof checked.user.followedBy !== 'boolean') stopChecking = true;
    } catch (error) {
      if (run.stopRequested || ['ACCOUNT_CHANGED', 'account_changed', 'SCAN_IDENTITY', 'SCAN_DOCUMENT_CHANGED'].includes(error.message)) throw error;
      checks.push({ id: user.id, followedBy: null, unavailable: false, checkedAt: Date.now() });
      run.absenceCheckDone = checks.length;
      run.absenceCheckError = { code: error.message, status: error.details?.status ?? null };
      stopChecking = true;
    }
    await showCheckProgress();
    if (stopChecking) break;
  }
  return checks;
}
async function scan(run) {
  try {
    if (run.source !== 'followers') {
      const result = await collectList(run, 'following', run.source === 'scroll' ? 'scroll' : 'api', run.startedAt);
      const finishedAt = Date.now();
      const verification = { version: chrome.runtime.getManifest?.().version || '2.61', runId: run.scanId, scope: 'following', followingPages: result.pages, followersPages: 0,
        followersChecked: false, followersCount: null, followingExpectedStart: result.expectedStart, followingExpectedEnd: result.expectedEnd,
        followersExpectedStart: null, followersExpectedEnd: null, terminal: true, pageExpected: result.pageExpected };
      if (run.stopRequested) fail('STOPPED_BEFORE_SEND');
      await store.commitScan({ account: { id: run.accountId, handle: result.context.account.handle }, users: result.users, complete: true,
        startedAt: run.startedAt, finishedAt, source: run.source, verification });
      run.followingSaved = true; run.followingSavedAt = finishedAt; run.total = result.users.length;
      connection = { ...result.context, tabId: run.tabId }; invalidateView(); await publish();
    }
    if (['auto', 'dual', 'followers'].includes(run.source) && !run.stopRequested) {
      run.followersStartedAt = Date.now(); run.progressStage = 'followers'; run.phase = 'followers'; run.followersDone = 0;
      let terminalCheckpoint = false;
      if (run.resumeFollowers) {
        const saved = await checkpoints.load(run.accountId);
        if (!saved || saved.token.generation !== run.checkpointId) fail('CHECKPOINT_CHANGED');
        if (saved.expired) fail('CHECKPOINT_EXPIRED');
        if (!saved.resumable) fail('CHECKPOINT_INVALID');
        run.checkpointToken = saved.token; run.checkpointSavedAt = saved.savedAt;
        run.followersStartedAt = saved.startedAt; run.followersDone = saved.count; run.followersTotal = saved.pageExpected ?? saved.expectedStart;
        terminalCheckpoint = saved.complete;
        if (saved.waitUntil > Date.now()) await readPause(run, saved.waitUntil - Date.now(), 'rate_limit');
      }
      await publish(); if (!terminalCheckpoint) await prepareFollowers(run);
      const result = await collectList(run, 'followers', 'api', run.followersStartedAt);
      const absenceChecks = await verifyMissingFollowers(run, result);
      const finalContext = await verify(run.tabId, run.accountId);
      if (run.scanDocumentId && finalContext._documentId !== run.scanDocumentId) fail('SCAN_DOCUMENT_CHANGED');
      const finishedAt = Date.now();
      if (run.stopRequested) fail('STOPPED_BEFORE_SEND');
      if (Date.now() - run.followersStartedAt >= checkpointLimits.TTL_MS) fail('CHECKPOINT_EXPIRED');
      if (run.checkpointBaseRevision !== await followerBaseRevision(run.accountId)) fail('CHECKPOINT_BASE_CHANGED');
      await store.commitFollowers({ account: { id: run.accountId, handle: result.context.account.handle }, users: result.users, complete: true,
        startedAt: run.followersStartedAt, finishedAt, absenceChecks, verification: { version: chrome.runtime.getManifest?.().version || '2.61', runId: run.checkpointRunId || run.scanId, scope: 'followers',
          pages: result.pages, expectedStart: result.expectedStart, expectedEnd: result.expectedEnd, terminal: true, pageExpected: result.pageExpected } });
      run.followersSaved = true; run.followersSavedAt = finishedAt; run.followersTotal = result.users.length;
      try { await checkpoints.clear(run.accountId, run.checkpointToken); delete run.checkpointToken; }
      catch { committedCheckpointGenerations.add(run.checkpointToken.generation); run.checkpointCleanupError = 'CHECKPOINT_CLEANUP_FAILED'; }
      run.pendingMissingCount = (await store.account(run.accountId))?.followers?.pendingMissing?.length || 0;
      connection = { ...result.context, tabId: run.tabId }; invalidateView(); await publish();
    }
    run.phase = run.stopRequested ? (run.pauseRequested ? 'paused' : 'stopped') : 'complete';
  } catch (error) {
    recordScanFailure(run, error);
    run.errorDetails = { ...run.errorDetails, stage: run.progressStage || 'following' };
    if (scanScopesSaved(run)) { run.phase = 'complete'; run.statusWriteError = 'SESSION_STATE_WRITE_FAILED'; delete run.error; delete run.errorDetails; }
    else if (!run.stopRequested && run.followingSaved) run.phase = 'partial';
  } finally { await finishScan(run); }
}
function scanScopesSaved(run) {
  return run.source === 'followers' ? run.followersSaved === true : run.followingSaved === true
    && (!['auto', 'dual'].includes(run.source) || run.followersSaved === true);
}
async function finishScan(run) {
  if (run.checkpointToken && !run.followersSaved) {
    try {
      const saved = await checkpoints.update(run.accountId, run.checkpointToken, {
        status: ['CHECKPOINT_CURSOR_INVALID', 'CHECKPOINT_BASE_CHANGED', 'CHECKPOINT_INVALID'].includes(run.error) ? 'invalid' : 'paused',
      });
      run.checkpointToken = saved.token; run.checkpointSavedAt = saved.savedAt;
    } catch (error) { run.checkpointError = error.message; }
  }
  run.running = false; run.finishedAt = Date.now();
  try { await publish(); } catch { run.statusWriteError = 'SESSION_STATE_WRITE_FAILED'; }
}
async function launchScan(run) {
  try { await publish(); }
  catch { run.running = false; run.phase = 'failed'; run.error = 'SESSION_STATE_WRITE_FAILED'; fail(run.error); }
  void prepareAndScan(run); return run;
}
async function execute(run, selected) {
  try {
    for (const user of selected) {
      if (run.stopRequested) break;
      await verify(run.tabId, run.accountId);
      await eligibility(run.accountId, [user.id]);
      if (run.stopRequested) break;
      await store.beginAction(run.accountId, user.id, Date.now());
      if (run.stopRequested) {
        await store.finishAction(run.accountId, user.id, 'failed', { notSent: true, reason: 'STOPPED_BEFORE_SEND' });
        break;
      }
      let result;
      run.commandToken = crypto.randomUUID();
      await saveRuntime();
      if (run.stopRequested) {
        await store.finishAction(run.accountId, user.id, 'failed', { notSent: true, reason: 'STOPPED_BEFORE_SEND' });
        delete run.commandToken;
        break;
      }
      try { result = await call(run.tabId, { type: 'unfollow', token: run.commandToken, accountId: run.accountId, userId: user.id, handle: user.handle }, run); }
      catch (error) {
        if (error.beforeDispatch === true) {
          await store.finishAction(run.accountId, user.id, 'failed', { notSent: true, reason: 'STOPPED_BEFORE_SEND' });
          delete run.commandToken;
          break;
        }
        result = { status: 'unknown', error: 'TRANSPORT_UNKNOWN' };
      }
      delete run.commandToken;
      if (result.status === 'confirmed') {
        await store.finishAction(run.accountId, user.id, 'success', { confirmed: true });
        run.done++;
      } else if (result.status === 'refused') {
        await store.finishAction(run.accountId, user.id, 'failed', { notSent: true, reason: result.error?.code || result.error || 'REFUSED' });
        fail(result.error?.code || result.error || 'ACTION_REFUSED');
      } else {
        await store.finishAction(run.accountId, user.id, 'unknown', { reason: result.error?.code || result.error || 'RESULT_UNKNOWN' });
        fail('ACTION_UNKNOWN');
      }
      await publish();
      if (run.done < selected.length) await nap(10_000);
    }
    run.phase = run.stopRequested ? 'stopped' : 'complete';
  } catch (error) {
    if (error.message === 'SESSION_STATE_WRITE_FAILED' && (run.stopRequested || run.done === selected.length)) {
      run.phase = run.stopRequested ? 'stopped' : 'complete'; run.statusWriteError = 'SESSION_STATE_WRITE_FAILED';
    } else { run.phase = 'failed'; run.error = error.message; }
  }
  finally {
    try { await store.recoverActions(); } catch { run.error = 'ACTION_RECEIPT_STORAGE_FAILED'; run.phase = 'failed'; }
    invalidateView(); run.running = false; run.finishedAt = Date.now();
    try { await publish(); } catch { run.statusWriteError = 'SESSION_STATE_WRITE_FAILED'; }
  }
}
async function followAuthor(sender, panelTabId) {
  if (!(await store.read()).settings.enabled) fail('DISABLED');
  idle();
  const authorization = authorizationScope(sender.documentId), startedAtStopRevision = stopRevision;
  const active = panelTabId !== null ? await chrome.tabs.get(panelTabId)
    : (await chrome.tabs.query({ active: true, currentWindow: true })).find(tab => isX(tab.url));
  if (!active || !isX(active.url)) fail('NO_ACTIVE_X_TAB');
  const connected = await connect(active.id), actor = connected.account;
  const open = async outcome => {
    try { await chrome.tabs.create({ url: 'https://x.com/DimmensCK', active: true }); }
    catch { fail('AUTHOR_PROFILE_OPEN_FAILED'); }
    return { outcome, opened: true };
  };
  if (actor.id === '1671136128953638914') return open('opened_only');
  const previousJob = job;
  const run = { kind: 'author_follow', accountId: actor.id, tabId: active.id, uiTabId: sender.tab?.id,
    uiDocumentId: sender.documentId || null, running: true, done: 0, total: 1, phase: 'preparing', stopRequested: false, startedAt: Date.now() };
  job = run;
  let receiptStarted = false, dispatched = false;
  try {
    await publish(); await prepareActionContext(run);
    const checked = await call(run.tabId, { type: 'authorStatus', accountId: actor.id }, run);
    if (checked.account?.id !== actor.id || checked.user?.id !== '1671136128953638914'
      || checked.user.handle?.toLowerCase() !== 'dimmensck' || checked.user.unavailable) fail('AUTHOR_IDENTITY_UNCONFIRMED');
    verifyAuthorizationScope(sender.documentId, authorization);
    if (run.stopRequested || stopRevision !== startedAtStopRevision) fail('STOPPED_BEFORE_SEND');
    const previousReceipt = (await store.account(actor.id))?.authorFollow;
    const unresolved = ['pending', 'unknown'].includes(previousReceipt?.status);
    if (checked.user.following === true || checked.user.followRequested === true) {
      const requested = checked.user.following !== true;
      if (unresolved) await store.finishAuthorFollow(actor.id, 'success', { confirmed: true, reconciled: true, requested });
      return open(requested ? 'requested' : 'already_following');
    }
    if (unresolved) fail('AUTHOR_FOLLOW_UNRESOLVED');
    if (checked.user.following !== false || checked.user.followRequested === null && checked.user.protected !== false) fail('AUTHOR_RELATIONSHIP_UNKNOWN');
    await store.beginAuthorFollow(actor); receiptStarted = true;
    run.commandToken = crypto.randomUUID(); run.phase = 'processing';
    await publish();
    verifyAuthorizationScope(sender.documentId, authorization);
    if (run.stopRequested || stopRevision !== startedAtStopRevision) fail('STOPPED_BEFORE_SEND');
    let result;
    try { dispatched = true; result = await call(run.tabId, { type: 'authorFollow', accountId: actor.id, token: run.commandToken }, run); }
    catch (error) {
      if (error.beforeDispatch === true) { dispatched = false; throw error; }
      result = { status: 'unknown', error: { code: 'TRANSPORT_UNKNOWN' } };
    }
    delete run.commandToken;
    if (result.status === 'confirmed') {
      await store.finishAuthorFollow(actor.id, 'success', { confirmed: true, requested: result.outcome === 'requested' });
      receiptStarted = false; run.done = 1;
      return open(result.outcome === 'requested' ? 'requested' : result.outcome === 'already_following' ? 'already_following' : 'followed');
    }
    if (result.status === 'refused') {
      await store.finishAuthorFollow(actor.id, 'failed', { notSent: true, code: result.error?.code || 'AUTHOR_FOLLOW_REFUSED' });
      receiptStarted = false; fail(result.error?.code || 'AUTHOR_FOLLOW_REFUSED');
    }
    await store.finishAuthorFollow(actor.id, 'unknown', { code: result.error?.code || 'AUTHOR_FOLLOW_UNKNOWN' });
    receiptStarted = false; fail('AUTHOR_FOLLOW_UNKNOWN');
  } catch (error) {
    if (receiptStarted) {
      await store.finishAuthorFollow(actor.id, dispatched ? 'unknown' : 'failed',
        dispatched ? { code: error.message } : { notSent: true, code: error.message });
    }
    throw error;
  } finally {
    run.running = false;
    if (job === run) job = previousJob;
    invalidateView();
    try { await publish(); } catch { run.statusWriteError = 'SESSION_STATE_WRITE_FAILED'; }
  }
}
async function showPanel(tabId) {
  if (!panelTabs.has(tabId)) return;
  try { await chrome.tabs.sendMessage(tabId, { type: 'OPEN_PANEL' }, { frameId: 0 }); return; } catch { /* Old pages may not contain the new launcher yet. */ }
  if (!panelTabs.has(tabId)) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', files: ['launcher.js'] });
    if (!panelTabs.has(tabId)) return;
    await chrome.tabs.sendMessage(tabId, { type: 'OPEN_PANEL' }, { frameId: 0 });
  } catch { /* A loading page restores the panel from session when its launcher starts. */ }
}
async function openDashboard(tabId, createX = false) {
  let tab = Number.isInteger(tabId) ? await chrome.tabs.get(tabId) : null;
  if (!tab || !isX(tab.url)) {
    if (!createX) fail('NOT_X_TAB');
    tab = await chrome.tabs.create({ url: 'https://x.com/home', active: true });
  }
  if (!Number.isInteger(tab?.id)) fail('NO_X_TAB');
  panelTabs.delete(tab.id); panelTabs.add(tab.id);
  while (panelTabs.size > 20) panelTabs.delete(panelTabs.values().next().value);
  await saveRuntime(); await showPanel(tab.id);
  return { tabId: tab.id };
}
async function floatState(tabId) {
  const { state } = await view();
  let currentId = null;
  if (state.settings.enabled) { try { currentId = (await call(tabId, { type: 'context' })).account?.id; } catch {} }
  const a = state.accounts[currentId];
  const ignored = new Set(a?.ignored || []);
  const lost = a ? a.users.filter(u => u.lostAt && u.followedBy === false && u.following === true && !u.unavailable && !ignored.has(u.id)).length : 0;
  const followersStage = job?.progressStage === 'followers';
  return { settings: state.settings, panelOpen: panelTabs.has(tabId), lost, job: job?.accountId === currentId && job?.tabId === tabId ? { running: job.running, done: followersStage ? job.followersDone : job.done, total: followersStage ? job.followersTotal : job.total } : null };
}
async function handle(message, sender) {
  const layoutAuthorization = message?.type === 'PANEL_LAYOUT' && trustedDashboard(sender) ? authorizationScope(sender.documentId) : null;
  await ready;
  const type = message?.type;
  if (!['GET_STATE', 'FLOAT_STATE', 'PROFILE', 'CLAIM_SHARED_VIEW', 'SET_SHARED_VIEW', 'PANEL_LAYOUT','PANEL_POINTER_OUTSIDE'].includes(type)) invalidateView();
  const dashboard = trustedDashboard(sender);
  const content = sender.id === chrome.runtime.id && sender.tab && sender.frameId === 0 && isX(sender.url);
  if (!dashboard) {
    if (!content || !['FLOAT_STATE', 'OPEN_DASHBOARD', 'OPEN_PANEL', 'PANEL_STATUS', 'FLOAT_POSITION','PANEL_POINTER_OUTSIDE'].includes(type)) fail('UNTRUSTED_SENDER');
    if(type==='PANEL_POINTER_OUTSIDE'){
      const tabId=sender.tab.id,layout=panelLayouts.get(tabId);
      if(!panelTabs.has(tabId)||!layout?.profileOpen||message.panelInstance!==layout.panelInstance||message.previewEpoch!==layout.previewEpoch||!Number.isFinite(message.observedAt)||Math.abs(Date.now()-message.observedAt)>5000)return false;
      const tab=await chrome.tabs.get(tabId);
      if(!tab.active||!isX(tab.url)||!panelTabs.has(tabId)||panelLayouts.get(tabId)!==layout)return false;
      await chrome.runtime.sendMessage({type:'PANEL_POINTER_OUTSIDE',panelInstance:layout.panelInstance,previewEpoch:layout.previewEpoch,observedAt:message.observedAt}).catch(()=>{});
      return true;
    }
    if (type === 'FLOAT_STATE') return floatState(sender.tab.id);
    if (type === 'OPEN_DASHBOARD' || type === 'OPEN_PANEL') return openDashboard(sender.tab.id);
    if (type === 'PANEL_STATUS') return { open: panelTabs.has(sender.tab.id) };
    if (type === 'FLOAT_POSITION') { await store.updateSettings({ floatY: Math.max(0.1, Math.min(0.9, Number(message.y) || 0.75)) }); return true; }
  }
  const panelTabId = embeddedTab(sender);
  if (panelTabId !== null && (!sender.documentId || !isX((await chrome.tabs.get(panelTabId)).url))) fail('UNTRUSTED_SENDER');
  const panelBound = tabId => { if (panelTabId !== null && tabId !== panelTabId) fail('PANEL_TAB_MISMATCH'); return tabId; };
  switch (type) {
    case 'PANEL_LAYOUT': {
      if (panelTabId === null) fail('PANEL_REQUIRED');
      if (typeof message.profileOpen !== 'boolean') fail('INVALID_PANEL_LAYOUT');
      if (typeof message.panelInstance !== 'string' || !/^xmh-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(message.panelInstance)) fail('INVALID_PANEL_LAYOUT');
      if (!Number.isSafeInteger(message.previewEpoch) || message.previewEpoch < 0) fail('INVALID_PANEL_LAYOUT');
      const hasHeight = Object.hasOwn(message, 'profileHeight');
      if (hasHeight && (!Number.isInteger(message.profileHeight) || message.profileHeight < 0 || message.profileHeight > 2000)) fail('INVALID_PANEL_LAYOUT');
      verifyAuthorizationScope(sender.documentId, layoutAuthorization);
      const result = await chrome.tabs.sendMessage(panelTabId, { type: 'PANEL_LAYOUT', panelInstance: message.panelInstance, previewEpoch:message.previewEpoch, profileOpen: message.profileOpen,
        ...(hasHeight ? { profileHeight: message.profileHeight } : {}) }, { frameId: 0 });
      verifyAuthorizationScope(sender.documentId, layoutAuthorization);
      const layout = result?.layout;
      if (result?.ok !== true || !layout || layout.profileOpen !== message.profileOpen
        || !Number.isInteger(layout.width) || layout.width < 1 || layout.width > 952
        || !Number.isInteger(layout.height) || layout.height < 1 || layout.height > 1040
        || !Number.isInteger(layout.profileHeight) || layout.profileHeight < 0 || layout.profileHeight > layout.height
        || (message.profileOpen ? !['docked', 'exclusive'].includes(layout.mode) : layout.mode !== 'closed')
        || (layout.mode === 'docked' ? layout.width < 652 : layout.width > 620)
        || (layout.mode !== 'docked' && layout.profileHeight !== 0)) fail('PANEL_LAYOUT_UNAVAILABLE');
      panelLayouts.set(panelTabId,{documentId:sender.documentId,panelInstance:message.panelInstance,previewEpoch:message.previewEpoch,profileOpen:message.profileOpen});
      return { profileOpen: layout.profileOpen, mode: layout.mode, width: layout.width,
        height: layout.height, profileHeight: layout.profileHeight };
    }
    case 'CLAIM_SHARED_VIEW': {
      if (!await activeSharedWriter(message, sender)) return { granted: false, reason: 'VIEW_NOT_ACTIVE', sharedView: sharedSnapshot() };
      sharedWriter = { token: crypto.randomUUID(), documentId: sender.documentId, tabId: sender.tab?.id ?? null };
      return { granted: true, writerToken: sharedWriter.token, sharedView: sharedSnapshot() };
    }
    case 'SET_SHARED_VIEW': {
      const writer = sharedWriter;
      if (!writer || writer.token !== message.writerToken || writer.documentId !== sender.documentId || writer.tabId !== (sender.tab?.id ?? null)) {
        return { applied: false, reason: 'VIEW_WRITER_EXPIRED', sharedView: sharedSnapshot() };
      }
      if (!await activeSharedWriter(message, sender)) return { applied: false, reason: 'VIEW_NOT_ACTIVE', sharedView: sharedSnapshot() };
      if (sharedWriter !== writer) return { applied: false, reason: 'VIEW_WRITER_EXPIRED', sharedView: sharedSnapshot() };
      if (message.expectedRevision !== sharedView.revision) return { applied: false, reason: 'VIEW_CONFLICT', sharedView: sharedSnapshot() };
      const value = cleanSharedValue(message.value);
      if (JSON.stringify(value) === JSON.stringify(sharedView.value)) return { applied: true, sharedView: sharedSnapshot() };
      const [epoch, sequence] = sharedView.revision.split(':');
      const next = { schema: 1, revision: Number(sequence) >= 999999999999 ? `${crypto.randomUUID()}:0` : `${epoch}:${Number(sequence) + 1}`, value };
      await chrome.storage.session.set({ [SHARED_VIEW_KEY]: next });
      sharedView = next;
      chrome.runtime.sendMessage({ type: 'SHARED_VIEW_CHANGED', sharedView: sharedSnapshot() }).catch(() => {});
      return { applied: true, sharedView: sharedSnapshot() };
    }
    case 'GET_STATE': {
      const [tabs, activeTabs] = await Promise.all([
        chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] }),
        chrome.tabs.query({ active: true, currentWindow: true })
      ]);
      const snapshot = await view();
      let followerCheckpoints = {}, checkpointError = checkpointStartupError;
      try { followerCheckpoints = await checkpoints.summaries(); }
      catch (error) { checkpointError = error.message; }
      for (const [id, item] of Object.entries(followerCheckpoints)) if (committedCheckpointGenerations.has(item.generation)) delete followerCheckpoints[id];
      const checkpointBytes = Object.values(followerCheckpoints).reduce((sum, item) => sum + (item.bytes || 0), 0);
      const stateUnchanged = message.knownStateRevision === snapshot.stateRevision;
      const payload = stateUnchanged ? { stats: snapshot.stats, stateRevision: snapshot.stateRevision } : snapshot;
      return { ...payload, stats: { ...snapshot.stats, checkpointBytes, checkpointLimitBytes: checkpointLimits.MAX_BYTES },
        stateUnchanged, sharedView: sharedSnapshot(), job, welcome: { seen: welcomeSeen }, followerCheckpoints, checkpointError,
        context: panelTabId === null || connection?.tabId === panelTabId ? connection : null, panelTabId,
        busyElsewhere: panelTabId !== null && !!job?.running && job.tabId !== panelTabId,
        activeTabId: panelTabId ?? activeTabs.find(t => isX(t.url))?.id ?? null,
        tabs: tabs.filter(t => panelTabId === null || t.id === panelTabId).map(t => ({ id: t.id, title: t.title, url: t.url })) };
    }
    case 'ACK_WELCOME': {
      await chrome.storage.local.set({ [WELCOME_KEY]: { seen: true } }); welcomeSeen = true;
      await publish(); return { seen: true };
    }
    case 'CLOSE_PANEL': {
      if (panelTabId === null) fail('PANEL_REQUIRED');
      panelTabs.delete(panelTabId);
      revokeDocumentAuthorizations(sender.documentId);
      if (job?.running && ['actions', 'author_follow'].includes(job.kind) && job.uiDocumentId === sender.documentId) await stopCurrent();
      await saveRuntime();
      if (!panelTabs.has(panelTabId)) {
        try { await chrome.tabs.sendMessage(panelTabId, { type: 'CLOSE_PANEL' }, { frameId: 0 }); } catch { /* The host may have navigated away already. */ }
      }
      return true;
    }
    case 'CONNECT': return connect(panelBound(message.tabId));
    case 'AUTHOR_FOLLOW_OPEN': {
      if (Object.keys(message).some(key => key !== 'type')) fail('INVALID_AUTHOR_ACTION');
      if (!sender.documentId || !controllerDocuments.has(`doc:${sender.documentId}`)) fail('CONTROLLER_CLOSED');
      return followAuthor(sender, panelTabId);
    }
    case 'QUICK_SCAN': {
      idle();
      if (message.scope !== undefined && !['following', 'followers', 'all'].includes(message.scope)) fail('BAD_SCAN');
      const source = message.scope === 'following' ? 'api' : message.scope === 'followers' ? 'followers' : 'auto';
      const startedAtStopRevision = stopRevision;
      const selectedTab = Number.isInteger(message.tabId) ? panelBound(message.tabId) : panelTabId;
      const active = Number.isInteger(selectedTab) ? await chrome.tabs.get(selectedTab) : (await chrome.tabs.query({ active: true, currentWindow: true })).find(t => isX(t.url));
      if (!active || !isX(active.url)) fail('NO_ACTIVE_X_TAB');
      const connected = await connect(active.id);
      const recovery = await scanRecoveryChoice(message, connected.account.id, source);
      await store.updateSettings({ enabled: true }); invalidateView(); await updateBadge();
      if (stopRevision !== startedAtStopRevision) fail('STOPPED_BEFORE_START');
      job = { kind: 'scan', scanId: crypto.randomUUID(), accountId: connected.account.id, tabId: active.id, uiTabId: sender.tab?.id, uiDocumentId: sender.documentId || null, source, ...recovery, progressStage: source === 'followers' ? 'followers' : 'following', startedAt: Date.now(), running: true, done: 0, total: null, phase: 'preparing', stopRequested: false };
      return launchScan(job);
    }
    case 'START_SCAN': {
      const startedAtStopRevision = stopRevision;
      if (!(await store.read()).settings.enabled) fail('DISABLED');
      idle();
      const tabId = panelBound(bound(message.accountId));
      if (message.tabId !== tabId || !['auto', 'api', 'scroll', 'dual', 'followers'].includes(message.source)) fail('BAD_SCAN');
      const recovery = await scanRecoveryChoice(message, message.accountId, message.source);
      if (stopRevision !== startedAtStopRevision) fail('STOPPED_BEFORE_START');
      job = { kind: 'scan', scanId: crypto.randomUUID(), accountId: message.accountId, tabId, uiTabId: sender.tab?.id, source: message.source === 'dual' ? 'auto' : message.source, ...recovery, progressStage: message.source === 'followers' ? 'followers' : 'following', startedAt: Date.now(), running: true, done: 0, total: null, phase: 'preparing', stopRequested: false };
      return launchScan(job);
    }
    // A deliberate stop from any trusted control panel applies to this extension's
    // one global task; it grants no ability to start or move account operations.
    case 'STOP': return stopCurrent();
    case 'PREPARE_ACTION': {
      const startedAtStopRevision = stopRevision;
      const authorization = authorizationScope(sender.documentId);
      if (!(await store.read()).settings.enabled) fail('DISABLED');
      idle(); const tabId = panelTabId ?? bound(message.accountId);
      const users = await eligibility(message.accountId, message.ids);
      verifyAuthorizationScope(sender.documentId, authorization);
      if (stopRevision !== startedAtStopRevision) fail('STOPPED_BEFORE_SEND');
      const previousJob = job;
      const preparing = { kind: 'actions', accountId: message.accountId, tabId, uiTabId: sender.tab?.id, uiDocumentId: sender.documentId || null,
        running: true, done: 0, total: users.length, phase: 'preparing', stopRequested: false, startedAt: Date.now() };
      job = preparing;
      try {
        await publish();
        await prepareActionContext(preparing);
        verifyAuthorizationScope(sender.documentId, authorization);
        if (preparing.stopRequested || stopRevision !== startedAtStopRevision) fail('STOPPED_BEFORE_SEND');
        proposals.clear();
        const token = crypto.randomUUID(), expiresAt = Date.now() + CONFIRM_MS;
        proposals.set(token, { accountId: message.accountId, tabId, users, expiresAt, uiDocumentId: sender.documentId || null });
        return { token, users, expiresAt };
      } finally { if (job === preparing) job = previousJob; await publish(); }
    }
    case 'EXECUTE_ACTION': {
      if (!(await store.read()).settings.enabled) fail('DISABLED');
      if (sender.documentId && !controllerDocuments.has(`doc:${sender.documentId}`)) fail('CONTROLLER_CLOSED');
      idle(); const proposal = proposals.get(message.token);
      if (!proposal || proposal.expiresAt < Date.now()) fail('CONFIRM_EXPIRED');
      if (proposal.uiDocumentId !== (sender.documentId || null)) fail('CONFIRM_DOCUMENT_MISMATCH');
      const tabId = panelBound(bound(proposal.accountId));
      if (tabId !== proposal.tabId) fail('CONNECTION_CHANGED');
      proposals.delete(message.token);
      job = { kind: 'actions', accountId: proposal.accountId, tabId, uiTabId: sender.tab?.id, uiDocumentId: sender.documentId || null, running: true, done: 0, total: proposal.users.length, phase: 'processing', stopRequested: false, startedAt: Date.now() };
      try { await publish(); }
      catch { job.running = false; job.phase = 'failed'; job.error = 'SESSION_STATE_WRITE_FAILED'; fail(job.error); }
      void execute(job, proposal.users); return job;
    }
    case 'IGNORE': idle(); proposals.clear(); return store.setIgnored(message.accountId, message.ids, message.ignored);
    case 'SETTINGS': {
      const settings = await store.updateSettings(message.patch);
      if (message.patch?.enabled === false) await stopCurrent();
      await updateBadge(); await publish(); return settings;
    }
    case 'EXPORT_BACKUP': return store.exportBackup();
    case 'PREVIEW_IMPORT': {
      idle(); proposals.clear(); importProposals.clear();
      const authorization = authorizationScope(sender.documentId), startedAtStopRevision = stopRevision;
      const plan = await store.previewImport(message.data);
      verifyAuthorizationScope(sender.documentId, authorization);
      if (stopRevision !== startedAtStopRevision) fail('IMPORT_PREVIEW_REQUIRED');
      const expiresAt = Date.now() + IMPORT_MS;
      if (!plan.canCommit) return { canCommit: false, revision: plan.revision, expiresAt, summary: plan.summary };
      const token = crypto.randomUUID();
      importProposals.set(token, { plan, expiresAt, uiDocumentId: sender.documentId || null, panelTabId });
      return { canCommit: true, token, revision: plan.revision, expiresAt, summary: plan.summary };
    }
    case 'IMPORT_BACKUP': {
      idle(); proposals.clear(); const proposal = importProposals.get(message.token);
      if (!proposal) fail('IMPORT_PREVIEW_REQUIRED');
      if (proposal.expiresAt < Date.now()) { importProposals.delete(message.token); fail('IMPORT_EXPIRED'); }
      if (proposal.uiDocumentId !== (sender.documentId || null) || proposal.panelTabId !== panelTabId) fail('CONFIRM_DOCUMENT_MISMATCH');
      if (message.revision !== proposal.plan.revision) fail('IMPORT_CHANGED');
      importProposals.delete(message.token);
      const result = await store.commitImport(proposal.plan);
      invalidateView(); await updateBadge(); await publish(); return result;
    }
    case 'REMOVE_ACCOUNT': {
      idle(); proposals.clear();
      const account = await store.account(message.accountId);
      if (account?.actions.some(item => ['pending', 'unknown'].includes(item.status)) || ['pending', 'unknown'].includes(account?.authorFollow?.status)) fail('UNRESOLVED_ACTIONS_PROTECTED');
      // Invalidate incomplete work first; a crash must not resurrect a cleared baseline.
      await checkpoints.clear(message.accountId);
      const result = account ? await store.removeAccount(message.accountId) : { removed: message.accountId };
      invalidateView(); await publish(); return result;
    }
    case 'OPEN_FOLLOWING':
    case 'OPEN_FOLLOWERS': {
      idle(); const tabId = panelBound(connection?.tabId);
      if (!tabId || message.tabId !== tabId) fail('NO_X_TAB');
      const context = await verify(tabId, connection.account.id);
      if (!/^[A-Za-z0-9_]{1,15}$/.test(context.account.handle || '')) fail('ACCOUNT_HANDLE_UNKNOWN');
      const section = type === 'OPEN_FOLLOWERS' ? 'followers' : 'following';
      // Navigate through X's own link so an SPA route can retain observed templates.
      const destination = `https://x.com/${context.account.handle}/${section}`;
      await chrome.scripting.executeScript({ target: { tabId }, func: target => {
        const path = new URL(target).pathname;
        const link = [...document.querySelectorAll('a[href]')].find(a => { try { return new URL(a.href).origin === location.origin && new URL(a.href).pathname === path; } catch { return false; } });
        if (link) link.click(); else location.assign(target);
      }, args: [destination] });
      await chrome.tabs.update(tabId, { active: true }); return true;
    }
    case 'PROFILE': {
      const tabId = panelBound(bound(message.accountId));
      const user = getUser(await store.account(message.accountId), message.userId);
      if (!user) fail('USER_NOT_FOUND');
      return call(tabId, { type: 'profile', accountId: message.accountId, userId: user.id, handle: user.handle });
    }
    case 'RESOLVE_ACTION': {
      idle(); const tabId = panelBound(bound(message.accountId));
      const account = await store.account(message.accountId);
      const action = account?.actions.find(a => a.userId === message.userId && ['pending', 'unknown'].includes(a.status));
      const user = account?.users.find(u => u.id === message.userId) || (action?.handle ? { id: action.userId, handle: action.handle } : null);
      if (!user || !action) fail('NO_UNRESOLVED_ACTION');
      const result = await call(tabId, { type: 'reconcileAction', accountId: account.id, userId: user.id, handle: user.handle });
      const current = result.user;
      if (result.account?.id !== account.id || current?.id !== user.id || typeof current.following !== 'boolean') fail('STILL_UNKNOWN');
      await store.finishAction(account.id, user.id, current.following ? 'failed' : 'success', { confirmed: true, reconciled: true, following: current.following });
      return { following: current.following };
    }
    default: fail('UNKNOWN_COMMAND');
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (['UPDATE', 'SHARED_VIEW_CHANGED'].includes(message?.type)) return false;
  // Serialize control mutations. STOP and reads stay responsive during page reads.
  const shared = ['CLAIM_SHARED_VIEW', 'SET_SHARED_VIEW'].includes(message?.type);
  const immediate = ['STOP', 'GET_STATE', 'FLOAT_STATE', 'PANEL_STATUS', 'CLOSE_PANEL', 'PANEL_LAYOUT','PANEL_POINTER_OUTSIDE'].includes(message?.type);
  const operation = shared ? sharedViewQueue.then(() => handle(message, sender)) : immediate ? handle(message, sender) : commandQueue.then(() => handle(message, sender));
  if (shared) sharedViewQueue = operation.catch(() => {});
  else if (!immediate) commandQueue = operation.catch(() => {});
  operation.then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message || 'ERROR' }));
  return true;
});
async function updateBadge() {
  const { settings } = await store.read();
  await chrome.action.setBadgeText({ text: settings.enabled ? 'ON' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#3A83F7' });
  await chrome.action.setBadgeTextColor?.({ color: '#181818' });
}
chrome.runtime.onConnect?.addListener(port => {
  const sender = port.sender;
  if (port.name !== 'xmh-controller' || !trustedDashboard(sender) || (embeddedTab(sender) !== null && !sender.documentId)) { port.disconnect(); return; }
  const controllerKey = sender.documentId ? `doc:${sender.documentId}` : Number.isInteger(sender.tab?.id) ? `tab:${sender.tab.id}` : null;
  if (controllerKey) controllerDocuments.set(controllerKey, (controllerDocuments.get(controllerKey) || 0) + 1);
  let disconnected = false;
  port.onDisconnect.addListener(() => {
    if (disconnected) return;
    disconnected = true;
    if (controllerKey) {
      const remaining = (controllerDocuments.get(controllerKey) || 1) - 1;
      if (remaining > 0) { controllerDocuments.set(controllerKey, remaining); return; }
      controllerDocuments.delete(controllerKey);
    }
    revokeDocumentAuthorizations(sender.documentId);
    if (!job?.running || !['actions', 'author_follow'].includes(job.kind)) return;
    const matchesDocument = !!sender.documentId && job.uiDocumentId === sender.documentId;
    const matchesTabFallback = !sender.documentId && Number.isInteger(sender.tab?.id) && job.uiTabId === sender.tab.id;
    if (matchesDocument || matchesTabFallback) void stopCurrent().catch(noteStatusWriteFailure);
  });
});
chrome.tabs.onRemoved.addListener(tabId => { panelTabs.delete(tabId);panelLayouts.delete(tabId); if (job?.running && [job.tabId, job.uiTabId].includes(tabId)) void stopCurrent().catch(noteStatusWriteFailure); if (connection?.tabId === tabId) { connection = null; proposals.clear(); } void saveRuntime().catch(noteStatusWriteFailure); });
chrome.tabs.onUpdated?.addListener((tabId, info, tab) => { if (info.status === 'complete' && panelTabs.has(tabId) && isX(tab.url)) void ready.then(() => showPanel(tabId)).catch(() => {}); });
chrome.action.onClicked?.addListener(tab => { void ready.then(() => openDashboard(tab?.id, true)).catch(error => console.warn('Panel unavailable', error.message)); });
void ready.then(updateBadge).catch(() => {});
