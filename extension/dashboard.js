// Original extension UI. Author: DimmensCK. Page content is always rendered as text.
import { selectUsers, countUsers, getUser, getFollowerView, toCSV, constants } from './core.js';
import { translator, errorText, scanErrorText } from './i18n.js';
import { createDemo } from './demo-data.js';
import { exportFileName } from './export-file.js';

const demo = new URLSearchParams(location.search).get('demo') === '1';
const panelInstance = window.name;
const app = document.getElementById('app');
const dialog = document.getElementById('dialog');
const profile = document.getElementById('profile');
const views = ['all', 'mutual', 'notFollowing', 'lost', 'followers', 'followersOnly', 'followersNew', 'followersLost', 'unknown', 'unavailable', 'ignored', 'other'];
const languages = [['zh_CN', '简体中文'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어']];
const PROJECT_URL = 'https://github.com/DimmensCK/X-Follow-Helper';
const AUTHOR_URL = 'https://x.com/DimmensCK';
const model = { data: null, accountId: '', tabId: '', manualTabSelection: false, view: 'all', lastResultsView:'all', dataTab: 'storage', query: '', verificationFilter: 'all', blueOnly: false, sort: 'anomalies', selected: new Set(), requestBusy: false, source: 'auto' };
let settingsReturn = null;
let welcomeShown = false;
let welcomeAcknowledging = false;
const ROW_HEIGHT = 72;
const OVERSCAN = 4;
let listCache;
let accountIndex;
let virtualView;
let resetListPosition = false;
const submittedSelections = new Map();
// The background uses this document-bound port to stop subsequent mutations when the popup closes.
let controllerPort;
function ensureController() {
  if (controllerPort || demo || !globalThis.chrome?.runtime?.connect) return;
  try {
    const port = chrome.runtime.connect({ name: 'xmh-controller' }); controllerPort = port;
    port.onDisconnect.addListener(() => { if (controllerPort === port) controllerPort = null; });
  } catch { controllerPort = null; }
}
ensureController();
const profileCache = new Map();
let profileKey = '';
let profilePinned = false;
let profilePreviewEpoch=0,lastPointerActivityAt=0;
let profileHoverBlocked=false,profileHoverPoint=null,lastPointerPoint=null,lastListInputAt=0;
let hoverTimer;
let hideTimer;
let queryTimer;
let refreshPromise;
let language = 'zh_CN';
let t = translator(language);
let dialogCleanup = () => {};
let restoringFocus = false;
let pressedPointer = null, pressedKey = null, deferredRender = false, deferredProfile = null, interactionFlush;
let renderedState = null, renderedMetadata = '', renderedStructure = '', renderedRequestBusy = null, deferredProgress = false;
const displayStats=data=>model.view==='data'?data.stats:Object.fromEntries(Object.entries(data.stats||{}).filter(([key])=>!key.startsWith('checkpoint')));
const progressStructure=data=>JSON.stringify([data.context,data.tabs,displayStats(data),data.busyElsewhere,data.panelTabId,data.activeTabId]);
const jobLifecycle=job=>JSON.stringify([job?.kind,job?.running,job?.accountId,job?.tabId,job?.startedAt]);
let sharedRevision=null, sharedWriter=null, sharedClaim=null, sharedTimer, sharedInFlight=false, sharedDirty=false, sharedGeneration=0, applyingShared=false, queuedShared=null, requestedAnchor=null,sharedBase=null;
let sharedIntents=[],sharedReconcileAfterClaim=false,sharedSyncWarned=false,activationEpoch=0,initialSharedActivation=false;
function sharedWarning(){if(!document.hidden&&!sharedSyncWarned){sharedSyncWarned=true;notice(t('sharedSyncFailed'));}}
function sharedVisible(){return !demo && !document.hidden && model.data?.sharedView?.schema===1;}
function sharedValue(){const anchor=virtualView?.viewport.isConnected?virtualView.anchor():null;return {accountId:model.accountId||null,view:model.view,lastResultsView:model.lastResultsView,query:model.query,sort:model.sort,verificationFilter:model.verificationFilter,blueOnly:model.verificationFilter==='blue',dataTab:model.dataTab,anchor:anchor?.id?{userId:anchor.id,offset:Math.max(0,Math.min(71,Math.floor(anchor.offset)))}:null,profileUserId:profileKey.split(':')[1]||null};}
function viewScope(value=sharedValue()){return Object.fromEntries(['accountId','view','query','sort','verificationFilter','blueOnly'].map(key=>[key,value[key]]));}
function mergeSharedIntent(base,intents){const value={...base,accountId:base.accountId||model.accountId||null};for(const intent of intents){if(intent.scope&&Object.entries(intent.scope).some(([key,item])=>value[key]!==item))continue;Object.assign(value,intent.patch);}return value;}
function validShared(packet){const value=packet?.value,id=item=>item===null||typeof item==='string'&&/^\d{1,30}$/.test(item);return packet?.schema===1&&typeof packet.revision==='string'&&packet.revision.length<=128&&/^[\w-]+:\d+$/.test(packet.revision)&&value&&id(value.accountId)&&[...views,'data'].includes(value.view)&&views.includes(value.lastResultsView)&&typeof value.query==='string'&&value.query.length<=200&&['anomalies','recent','followersDesc','followersAsc','name','handle'].includes(value.sort)&&typeof value.blueOnly==='boolean'&&(!Object.hasOwn(value,'verificationFilter')||['all','blue','standard'].includes(value.verificationFilter)&&value.blueOnly===(value.verificationFilter==='blue'))&&['storage','settings','unresolved'].includes(value.dataTab)&&id(value.profileUserId)&&(value.anchor===null||value.anchor&&typeof value.anchor.userId==='string'&&/^\d{1,30}$/.test(value.anchor.userId)&&Number.isInteger(value.anchor.offset)&&value.anchor.offset>=0&&value.anchor.offset<=71);}
function newerShared(value){if(!validShared(value))return false;if(value.revision===sharedRevision)return false;const old=sharedRevision?.split(':'),next=value.revision.split(':');return !(old?.length===next.length&&old.slice(0,-1).join(':')===next.slice(0,-1).join(':')&&Number(next.at(-1))<=Number(old.at(-1)));}
function queueShared(value){if(!validShared(value))return;const old=queuedShared?.revision.split(':'),next=value.revision.split(':');if(old?.length===next.length&&old.slice(0,-1).join(':')===next.slice(0,-1).join(':')&&Number(next.at(-1))<Number(old.at(-1)))return;queuedShared=value;}
function applyShared(value){
  if(!newerShared(value))return;
  if(interactionActive()||sharedInFlight){queueShared(value);return;}
  const state=value.value,nextAccount=state.accountId&&model.data.state.accounts[state.accountId]?state.accountId:preferredSharedAccountId();
  const scopeChanged=Object.entries(viewScope({...state,accountId:nextAccount})).some(([key,item])=>viewScope()[key]!==item)||model.view==='data'&&state.dataTab!==model.dataTab;
  const hadPrivate=scopeChanged&&(model.selected.size>0||dialog.open),keepDialog=dialog.open&&!scopeChanged;
  applyingShared=true;sharedRevision=value.revision;sharedBase=value.value;sharedWriter=null;sharedDirty=false;sharedIntents=[];clearTimeout(sharedTimer);
  try{model.accountId=nextAccount;model.view=state.view;model.lastResultsView=state.lastResultsView;model.query=state.query;model.sort=state.sort;model.verificationFilter=state.verificationFilter||(state.blueOnly?'blue':'all');model.blueOnly=model.verificationFilter==='blue';model.dataTab=state.dataTab;if(scopeChanged){model.selected.clear();submittedSelections.clear();if(dialog.open)closeDialog();}if(!keepDialog)hideProfile();resetListPosition=false;requestedAnchor=state.anchor?{accountId:model.accountId,id:state.anchor.userId,offset:state.anchor.offset}:null;render();const local=profileUser(state.profileUserId);if(local&&!keepDialog)showProfile(local,{read:false,share:false});if(hadPrivate)notice(t('sharedChanged'));}finally{applyingShared=false;}
}
async function claimShared(){
  if(!sharedVisible())return false;if(sharedClaim)return sharedClaim;
  sharedWriter=null;
  const epoch=activationEpoch;
  const task=(async()=>{try{const result=await api('CLAIM_SHARED_VIEW',{visible:true});if(epoch!==activationEpoch||!sharedVisible()||!validShared(result.sharedView))return false;if(result.granted&&result.writerToken){if(sharedDirty){sharedReconcileAfterClaim ||= result.sharedView.revision!==sharedRevision;sharedBase=result.sharedView.value;sharedRevision=result.sharedView.revision;}else applyShared(result.sharedView);sharedWriter=result.writerToken;if(!sharedDirty&&result.sharedView.value.accountId===null&&model.accountId)shareView(0,{accountId:model.accountId,anchor:null,profileUserId:null});return true;}sharedDirty=false;sharedIntents=[];sharedRevision=null;applyShared(result.sharedView);return false;}catch{if(epoch===activationEpoch){if(sharedDirty)sharedWarning();sharedDirty=false;sharedIntents=[];}return false;}finally{if(sharedClaim===task)sharedClaim=null;}})();sharedClaim=task;return task;
}
function shareView(delay=0,patch={},scope=null){if(applyingShared||!sharedVisible()||!Object.keys(patch).length)return;sharedDirty=true;sharedGeneration++;for(const intent of sharedIntents)for(const key of Object.keys(patch))delete intent.patch[key];sharedIntents=sharedIntents.filter(intent=>Object.keys(intent.patch).length);sharedIntents.push({generation:sharedGeneration,patch:{...patch},scope});clearTimeout(sharedTimer);sharedTimer=setTimeout(flushShared,delay);}
async function flushShared(){
  if(!sharedDirty||!sharedVisible()||sharedInFlight)return;
  if(!sharedWriter&&!await claimShared())return;
  if(!sharedDirty||!sharedVisible())return;
  const generation=sharedGeneration,epoch=activationEpoch,value=mergeSharedIntent(sharedBase||sharedValue(),sharedIntents),expectedRevision=sharedRevision;sharedInFlight=true;
  try{const result=await api('SET_SHARED_VIEW',{writerToken:sharedWriter,expectedRevision,value,visible:true});if(epoch!==activationEpoch)return;if(!validShared(result.sharedView))throw new Error('PROTOCOL_ERROR');if(result.applied){sharedSyncWarned=false;sharedBase=result.sharedView.value;sharedIntents=sharedIntents.filter(intent=>intent.generation>generation);sharedDirty=sharedIntents.length>0;if(!sharedDirty&&sharedReconcileAfterClaim){sharedReconcileAfterClaim=false;sharedRevision=null;queueShared(result.sharedView);}else sharedRevision=result.sharedView.revision;}else{sharedDirty=false;sharedIntents=[];sharedWriter=null;sharedRevision=null;queueShared(result.sharedView);}}
  catch{sharedWarning();sharedDirty=false;sharedIntents=[];sharedWriter=null;}
  finally{sharedInFlight=false;const queued=queuedShared;queuedShared=null;if(queued)applyShared(queued);if(sharedDirty&&sharedVisible())sharedTimer=setTimeout(flushShared,0);}
}
const importInput = document.createElement('input');
importInput.type='file';importInput.accept='.json,application/json';importInput.hidden=true;importInput.id='data-import-file';
document.body.append(importInput);
function interactionActive() { return pressedPointer!==null || pressedKey!==null; }
function flushInteraction() {
  if (interactionActive()) return;
  const incoming=queuedShared;queuedShared=null;if(incoming)applyShared(incoming);
  if (deferredRender) { deferredRender=false;render(); }
  else if(deferredProgress)updateJobProgress();
  const next=deferredProfile;deferredProfile=null;
  if (next && profileKey===next.key) drawProfile(next.local,next.cached);
}
function finishInteraction() { clearTimeout(interactionFlush);interactionFlush=setTimeout(flushInteraction,0); }
document.addEventListener('pointerdown',event=>{pressedPointer=event.pointerId;},true);
document.addEventListener('pointerup',event=>{if(pressedPointer===event.pointerId)pressedPointer=null;finishInteraction();},true);
document.addEventListener('pointercancel',event=>{if(pressedPointer===event.pointerId)pressedPointer=null;finishInteraction();},true);
function trackPhysicalPointer(event){
  if(!event.isTrusted)return;
  if(event.type==='pointermove')lastPointerActivityAt=performance.timeOrigin+performance.now();
  // Chromium may re-hit an expanded cross-origin frame using its old local coordinates.
  // Keep the right-edge anchor until the physical pointer really moves, including an exit.
  if(!lastPointerPoint||event.screenX!==lastPointerPoint.x||event.screenY!==lastPointerPoint.y){
    lastPointerPoint={x:event.screenX,y:event.screenY,clientX:event.clientX,clientY:event.clientY,width:innerWidth};
    // After a layout-induced leave the browser's target may be the body, so a real exit
    // need not emit another leave on the name. Preserve any newer hover intent.
    if(!profile.hidden&&!profilePinned&&!hoverTimer&&!hideTimer)scheduleHideProfile(500);
  }
}
document.addEventListener('pointermove',trackPhysicalPointer,true);
document.addEventListener('pointerout',trackPhysicalPointer,true);
document.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key))pressedKey=event.key;},true);
document.addEventListener('keyup',event=>{if(pressedKey===event.key)pressedKey=null;finishInteraction();},true);
window.addEventListener('blur',()=>{pressedPointer=pressedKey=null;finishInteraction();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){activationEpoch++;clearTimeout(sharedTimer);sharedDirty=false;sharedIntents=[];sharedWriter=null;sharedClaim=null;sharedGeneration++;}else if(document.hasFocus())claimShared();});
let panelLayoutFrame=0,panelLayoutInFlight=false,panelLayoutDesired=null,panelLayoutSent='';
let profileLayoutPending=false,profileLayoutEpoch=0,profileLayoutAck=null,profileLayoutTimer,profileRevealFrame=0,profileResyncWidth=null;
function queueProfileReveal(){
  if(profileRevealFrame||!profileLayoutPending)return;
  profileRevealFrame=requestAnimationFrame(()=>{profileRevealFrame=requestAnimationFrame(()=>{profileRevealFrame=0;revealProfileWhenReady();});});
}
function revealProfileWhenReady(){
  if(!profileLayoutPending||profile.hidden||!profileLayoutAck)return;
  const ack=profileLayoutAck;
  if(Math.abs(innerWidth-ack.width)>1||Math.abs(innerHeight-ack.height)>1){
    if(profileResyncWidth!==`${innerWidth}:${innerHeight}`){profileResyncWidth=`${innerWidth}:${innerHeight}`;panelLayoutSent='';schedulePanelLayout();}
    return;
  }
  const height=Math.min(Math.ceil(profile.getBoundingClientRect().height),ack.height);
  if(ack.mode==='docked'&&ack.profileHeight!==height){schedulePanelLayout();return;}
  profileLayoutPending=false;clearTimeout(profileLayoutTimer);updateProfileLayout();
}
function schedulePanelLayout() {
  if(demo||window.top===window||panelLayoutFrame)return;
  panelLayoutFrame=requestAnimationFrame(()=>{
    panelLayoutFrame=0;
    const profileOpen=!profile.hidden;
    const profileHeight=profileOpen&&document.body.classList.contains('profile-docked')?Math.max(0,Math.min(2000,Math.ceil(profile.getBoundingClientRect().height))):profileOpen&&profileLayoutPending?1:0;
    panelLayoutDesired={payload:{profileOpen,profileHeight,panelInstance,previewEpoch:profilePreviewEpoch},epoch:profileLayoutEpoch};flushPanelLayout();
  });
}
async function flushPanelLayout() {
  if(panelLayoutInFlight||!panelLayoutDesired)return;
  const {payload,epoch}=panelLayoutDesired,key=JSON.stringify(panelLayoutDesired);if(key===panelLayoutSent)return;
  panelLayoutInFlight=true;panelLayoutSent=key;
  try{
    const ack=await api('PANEL_LAYOUT',payload);
    if(epoch===profileLayoutEpoch&&profileLayoutPending&&payload.profileOpen){
      if(!ack||ack.profileOpen!==true||!['docked','exclusive'].includes(ack.mode)||!Number.isInteger(ack.width)||ack.width<1||ack.width>952||!Number.isInteger(ack.height)||ack.height<1||ack.height>1040||!Number.isInteger(ack.profileHeight)||ack.profileHeight<0||ack.profileHeight>ack.height||(ack.mode==='docked'?ack.width<652:ack.width>620||ack.profileHeight!==0))throw new Error('PANEL_LAYOUT_UNAVAILABLE');
      profileLayoutAck=ack;queueProfileReveal();
    }
  }
  catch(error){if(epoch===profileLayoutEpoch&&payload.profileOpen&&!profile.hidden){hideProfile();if(error.message!=='MOCK_UNSUPPORTED')notice(errorText(error.message,language),true,error.message);}}
  finally{panelLayoutInFlight=false;if(JSON.stringify(panelLayoutDesired)!==panelLayoutSent)flushPanelLayout();}
}
function updateProfileLayout() {
  const open=!profile.hidden, docked=open&&innerWidth>=652,exclusive=open&&!docked&&!profileLayoutPending;
  document.body.classList.toggle('profile-open',open);document.body.classList.toggle('profile-pending',open&&profileLayoutPending);document.body.classList.toggle('profile-docked',docked);document.body.classList.toggle('profile-exclusive',exclusive);
  app.inert=exclusive;app.setAttribute('aria-hidden',String(exclusive));
  schedulePanelLayout();
  if(profileLayoutPending&&profileLayoutAck)queueProfileReveal();
}
function requestPanelLayout() { updateProfileLayout(); }
new ResizeObserver(schedulePanelLayout).observe(profile);
function chooseImport() { if(demo||taskRunning())return;importInput.value='';importInput.click(); }
importInput.addEventListener('change',async()=>{
  const selected=importInput.files?.[0];if(!selected)return;
  if(selected.size>constants.MAX_BACKUP_BYTES){notice(t('fileTooLarge'),true);return;}
  let data;try{data=JSON.parse(await selected.text());}catch{notice(t('invalidJSON'),true);return;}
  const preview=await perform(()=>api('PREVIEW_IMPORT',{data}));if(preview)showImportPreview(preview,selected.name);importInput.value='';
});

const paths = {
  all: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  lost: 'M7 7h10v10M17 7 7 17M3 12v7a2 2 0 0 0 2 2h7',
  notFollowing: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM17 8h6',
  mutual: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z',
  unknown: 'M12 17h.01M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  unavailable: 'M12 3 2 21h20L12 3ZM12 9v4M12 17h.01',
  ignored: 'm3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 4.2A11 11 0 0 1 12 4c7 0 11 8 11 8a18 18 0 0 1-4.1 4.9M6.4 6.4A21 21 0 0 0 1 12s4 8 11 8a11 11 0 0 0 5.6-1.6',
  data: 'M21 6c0 2-4 4-9 4S3 8 3 6s4-4 9-4 9 2 9 4ZM3 6v12c0 2 4 4 9 4s9-2 9-4V6M3 12c0 2 4 4 9 4s9-2 9-4',
  search: 'm21 21-4.3-4.3M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  arrow: 'M7 17 17 7M7 7h10v10',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 8l5-5 5 5M12 3v12',
  scan: 'M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M8 12h8',
  close: 'm6 6 12 12M6 18 18 6',
  refresh: 'M20 7v5h-5M4 17v-5h5M6.1 6.1a8 8 0 0 1 13.2 3M4.7 14.9a8 8 0 0 0 13.2 3',
  lock: 'M5 11h14v10H5V11ZM8 11V7a4 4 0 0 1 8 0v4',
  globe: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM2 12h20M12 2a18 18 0 0 1 0 20 18 18 0 0 1 0-20Z',
  sun: 'M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  info: 'M12 11v6M12 7h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  stop: 'M6 6h12v12H6V6Z',
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.65', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name] || paths.info);
  svg.append(path);
  return svg;
}
function helpFor(label) {
  const groups = [
    ['helpQuickScan', ['quickScan']], ['helpAdvanced', ['scanMode', 'scan']],
    ['helpLanguage', ['language', 'switchLanguage']],
    ['helpConnect', ['connect', 'reconnect', 'tabLabel']], ['helpRefresh', ['refresh']],
    ['helpOpenList', ['openFollowing']], ['helpSnapshot', ['accountLabel']],
    ['helpCSV', ['exportCSV']], ['helpSort', ['sort']], ['helpSelect', ['clearSelection', 'selectPage']],
    ['helpIgnore', ['ignore', 'ignoreSelected', 'restore', 'restoreSelected']],
    ['helpUnfollow', ['unfollow', 'unfollowSelected', 'execute']], ['helpResolve', ['resolve', 'reviewUnresolved']],
    ['helpBackup', ['backup']], ['helpImport', ['importBackup', 'importConfirm']], ['helpRemove', ['removeAccount', 'removeConfirm']],
    ['helpProfile', ['refreshProfile', 'details']], ['helpPagination', ['prev', 'next']], ['stopNote', ['stop', 'stopping']],
  ];
  return t(groups.find(([, keys]) => keys.some((key) => t(key) === label))?.[0] || 'helpControl');
}
let tutorialAnchor;
const tutorial = el('div', { id: 'tutorial', class: 'tutorial', role: 'tooltip', hidden: true });
document.body.append(tutorial);
function hideTutorial() {
  tutorial.hidden = true;
  tutorialAnchor?.removeAttribute('aria-describedby');
  tutorialAnchor = null;
}
function showTutorial(anchor) {
  if (!anchor?.dataset.help) return hideTutorial();
  hideTutorial();
  const surface = dialog.open ? dialog : document.body;
  if (tutorial.parentNode !== surface) surface.append(tutorial);
  tutorialAnchor = anchor;
  tutorial.textContent = anchor.dataset.help;
  tutorial.hidden = false;
  anchor.setAttribute('aria-describedby', 'tutorial');
  const box = anchor.getBoundingClientRect();
  const inProfile=!profile.hidden&&profile.contains(anchor);
  const region=(dialog.open?dialog:inProfile?profile:app).getBoundingClientRect();
  tutorial.style.maxWidth=`${Math.max(0,Math.min(350,region.width-20))}px`;
  const width = tutorial.getBoundingClientRect().width;
  const height = tutorial.getBoundingClientRect().height;
  const top=inProfile||box.bottom+height+10>region.bottom?box.top-height-7:box.bottom+7;
  tutorial.style.left = `${Math.max(region.left+10,Math.min(region.right-width-10,box.left))}px`;
  tutorial.style.top = `${Math.max(region.top+8,Math.min(region.bottom-height-8,top))}px`;
}
document.addEventListener('pointerover', (event) => { const anchor = event.target.closest?.('[data-help]'); if (anchor !== tutorialAnchor) showTutorial(anchor); });
document.addEventListener('pointerout', (event) => { if (tutorialAnchor && !tutorialAnchor.contains(event.relatedTarget)) hideTutorial(); });
document.addEventListener('focusin', (event) => showTutorial(event.target.closest?.('[data-help]')));
document.addEventListener('focusout', hideTutorial);
document.addEventListener('scroll', hideTutorial, true);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideTutorial(); });
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'checked' || key === 'disabled' || key === 'hidden') node[key] = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
function button(label, onClick, { style = '', disabled = false, glyph, title, ...attrs } = {}) {
  return el('button', { type: 'button', class: `button ${style}`, disabled, 'data-help': title || helpFor(label), onclick: onClick, ...attrs }, glyph ? icon(glyph) : null, label);
}
function select(options, value, onChange, label, attrs = {}) {
  const node = el('select', { class: 'select', 'aria-label': label, 'data-help': helpFor(label), onchange: (event) => onChange(event.target.value), ...attrs }, options.map(([id, text]) => el('option', { value: id }, text)));
  node.value = String(value ?? '');
  return node;
}
const account = () => model.data?.state?.accounts?.[model.accountId] || null;
const isFollowerView = (view=model.view) => ['followers','followersOnly','followersNew','followersLost'].includes(view);
const isFollowingView = (view=model.view) => ['all','mutual','notFollowing','lost','unknown','unavailable'].includes(view);
const savedAccountTime = item => Math.max(item?.lastScan?.finishedAt || 0,item?.followers?.observedAt || 0,item?.followerObservation?.observedAt || 0);
const hasSavedAccount = item => Boolean(savedAccountTime(item) || item?.users?.length);
const viewLabel = view => t(view==='followers'?'followersView':view);
function profileUser(id) { return getUser(account(),id); }
function preferredAccountId() {
  const accounts = Object.values(model.data?.state?.accounts || {});
  const saved = accounts.filter(hasSavedAccount).sort((a,b) => savedAccountTime(b) - savedAccountTime(a) || a.id.localeCompare(b.id));
  return saved.find(item => item.id === connectedId())?.id || saved[0]?.id || accounts.find(item => item.id === connectedId())?.id || accounts[0]?.id || connectedId() || '';
}
function preferredSharedAccountId(){return Object.values(model.data?.state?.accounts||{}).sort((a,b)=>Number(hasSavedAccount(b))-Number(hasSavedAccount(a))||savedAccountTime(b)-savedAccountTime(a)||a.id.localeCompare(b.id))[0]?.id||'';}
const contextAccount = () => model.data?.context?.account || (model.data?.context?.accountId ? { id: model.data.context.accountId, handle: model.data.context.handle } : null);
const connectedId = () => String(contextAccount()?.id || '');
const panelTabId = () => Number.isInteger(model.data?.panelTabId) ? model.data.panelTabId : null;
const taskRunning = () => model.data?.job?.running === true;
const ownerMatches = () => Boolean(connectedId() && connectedId() === model.accountId && (panelTabId() === null || model.data?.context?.tabId === panelTabId()));
const isFresh = () => Boolean(account()?.lastScan?.finishedAt && Date.now() - account().lastScan.finishedAt <= 15 * 60 * 1000 && account().lastScan.finishedAt <= Date.now() + 30000);
const locale = () => ({ zh_CN: 'zh-CN', en: 'en-GB', ja: 'ja-JP', ko: 'ko-KR' })[language];
const formatNumber = (number) => number === null || number === undefined ? '—' : new Intl.NumberFormat(locale()).format(number);
function date(value, short = false) {
  if (!value || !Number.isFinite(Number(value))) return '—';
  return new Intl.DateTimeFormat(locale(), { month: 'short', day: 'numeric', ...(short ? {} : { hour: '2-digit', minute: '2-digit', hour12: false }) }).format(new Date(value));
}
const bytes = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${((n || 0) / 1024).toFixed(1)} KB`;
function indexAccount() {
  const a = account();
  if (accountIndex?.account === a && accountIndex.verificationFilter === model.verificationFilter) return accountIndex;
  const ignored = new Set(a?.ignored || []), actions = new Map();
  const counts = countUsers(a, { verificationFilter: model.verificationFilter });
  for (const action of a?.actions || []) {
    if (!['unknown', 'pending'].includes(actions.get(action.userId)?.status)) actions.set(action.userId, action);
  }
  return accountIndex = { verificationFilter: model.verificationFilter, account: a, ignored, actions, counts };
}
function latestAction(userId) { return indexAccount().actions.get(userId); }
function eligible(user) {
  return user.following === true && !user.unavailable && !indexAccount().ignored.has(user.id) && !['pending', 'unknown'].includes(latestAction(user.id)?.status);
}
function actionBlock(user) {
  if (['pending','unknown'].includes(latestAction(user.id)?.status)) return 'reasonUnresolved';
  if (user.unavailable) return 'reasonUnavailable';
  if (user.following === false) return 'reasonNotFollowing';
  if (user.following !== true) return 'reasonFollowingUnknown';
  if (indexAccount().ignored.has(user.id)) return 'reasonIgnored';
  if (model.data?.busyElsewhere) return 'busyElsewhere';
  if (taskRunning()) return 'reasonTaskRunning';
  if (model.requestBusy) return 'reasonRequestPending';
  if (!model.data?.state.settings.enabled) return 'reasonDisabled';
  if (!demo && panelTabId() === null && !model.tabId) return 'reasonNoTab';
  return null;
}
// PREPARE is read-only and re-verifies this panel's account; cached binding and age do not grant a send.
function canAct(user) { return !actionBlock(user); }
async function resolveUser(user) {
  const ownerId=model.accountId;
  return perform(async()=>{
    if (!ownerMatches()) {
      const value=await api('CONNECT',{tabId:panelTabId() ?? Number(model.tabId)});
      if (String(value?.account?.id || value?.accountId || '')!==ownerId) throw new Error('ACCOUNT_MISMATCH');
    }
    return api('RESOLVE_ACTION',{accountId:ownerId,userId:user.id});
  },'resolvedNotice');
}
function showActionHelp(user) {
  const reason=actionBlock(user) || 'reviewBeforeSend';
  const controls=[];
  if (reason==='reasonUnresolved') controls.push(button(t('resolve'),()=>{closeDialog();resolveUser(user);},{style:'primary',disabled:demo||taskRunning()||model.data.busyElsewhere||model.requestBusy}));
  if (reason==='reasonIgnored') controls.push(button(t('restore'),()=>{closeDialog();setIgnored([user.id],false);},{style:'primary',disabled:demo||taskRunning()}));
  if (reason==='reasonFollowingUnknown') controls.push(button(t('checkFollowing'),()=>{closeDialog();requestQuickScan('following');},{style:'primary',disabled:demo||taskRunning()||model.data.busyElsewhere}));
  if (reason==='reasonDisabled') controls.push(button(t('enableActions'),()=>{closeDialog();updateSetting({enabled:true});},{style:'primary',disabled:demo}));
  if (reason==='reasonTaskRunning') controls.push(button(t('stop'),()=>{closeDialog();requestStop();},{disabled:demo||model.data.job.stopRequested}));
  const handle=/^[A-Za-z0-9_]{1,15}$/.test(user.handle||'')?user.handle:null;
  openDialog(t('actionHelpTitle'),[el('div',{class:'dialog-owner'},`@${user.handle||user.id}`),el('p',{class:'action-reason','data-reason':reason},t(reason)),handle&&!demo?el('a',{class:'button small',href:`https://x.com/${handle}`,target:'_blank',rel:'noopener noreferrer'},t('profile'),icon('arrow')):null],controls);
}
function unfollowControl(user, live=user) {
  const blocked=actionBlock(user) || actionBlock(live);
  return blocked ? button(t('actionHelp'),()=>showActionHelp(actionBlock(user)?user:live),{style:'small ghost action-help',title:t(blocked),'data-testid':`action-reason-${user.id}`}) : button(t('unfollow'),()=>prepare([user]),{style:'small danger',title:t('reviewBeforeSend')});
}
function notice(message, error = false, code = '') {
  const item = el('div', { class: `toast${error ? ' error' : ''}`, role: error ? 'alert' : 'status' }, message, code ? el('span', { class: 'toast-code mono' }, code) : null);
  const host = document.getElementById('notices');
  host.append(item);
  while (host.childElementCount > 3) host.firstElementChild.remove();
  setTimeout(() => item.remove(), error ? 12000 : 6000);
}
async function api(type, data = {}) {
  if (demo) throw new Error('DEMO');
  if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('EXTENSION_REQUIRED');
  const result = await chrome.runtime.sendMessage({ type, ...data });
  if (!result || typeof result.ok !== 'boolean') throw new Error('PROTOCOL_ERROR');
  if (!result.ok) throw new Error(typeof result.error === 'string' ? result.error : result.error?.code || 'UNKNOWN_ERROR');
  return result.data;
}
async function perform(work, successMessage) {
  if (model.requestBusy) return;
  model.requestBusy = true;
  try {
    const result = await work();
    if (successMessage) notice(t(successMessage));
    return result;
  } catch (error) {
    notice(error.message === 'DEMO' ? t('demoAction') : errorText(error.message, language), true, error.message);
  } finally { model.requestBusy = false; await refresh(); if(model.data&&renderedRequestBusy!==model.requestBusy)render(); }
}
async function followAuthor(event) {
  if (demo || taskRunning() || model.requestBusy || model.data?.busyElsewhere) return;
  const control = event?.currentTarget;
  if (control) { control.disabled = true; control.setAttribute('aria-busy', 'true'); }
  await perform(async () => {
    const result = await api('AUTHOR_FOLLOW_OPEN');
    const messages = { followed: 'authorFollowed', already_following: 'authorAlreadyFollowing', requested: 'authorFollowRequested', opened_only: 'authorOpenedOnly' };
    if (result?.opened !== true || !Object.hasOwn(messages, result?.outcome)) throw new Error('PROTOCOL_ERROR');
    notice(t(messages[result.outcome]));
  });
}
async function requestStop() {
  const pausing=followersJobStage(model.data?.job);
  try { await api('STOP'); notice(t(pausing?'pauseRequested':'stopRequested')); }
  catch (error) { notice(errorText(error.message, language), true, error.message); }
  finally { await refresh(); }
}
async function requestQuickScan(scope) {
  if (!['following','followers'].includes(scope)) return;
  if (scope === 'followers') return confirmFollowersRead(choice => startQuickScan(scope,choice));
  return startQuickScan(scope);
}
function followerCheckpoint(accountId = connectedId() || model.accountId) {
  const checkpoint=model.data?.followerCheckpoints?.[accountId];
  return checkpoint&&checkpoint.accountId===accountId&&typeof checkpoint.generation==='string'&&checkpoint.generation.length>0&&Number.isSafeInteger(checkpoint.count)&&checkpoint.count>=0?checkpoint:null;
}
async function confirmFollowersRead(start, accountId = null) {
  if (demo || taskRunning() || model.requestBusy || model.data?.busyElsewhere) return;
  if (await refresh()===false || taskRunning() || model.requestBusy || model.data?.busyElsewhere) return;
  const checkpoint=followerCheckpoint(accountId||connectedId()||model.accountId);
  const choice=resume=>({resume,...(checkpoint?{resumeAccountId:checkpoint.accountId,checkpointId:checkpoint.generation}:{})});
  const begin=resume=>{
    if (taskRunning() || model.requestBusy || model.data?.busyElsewhere) return;
    closeDialog(); start(choice(resume));
  };
  const resumable=checkpoint?.resumable===true&&Number.isFinite(checkpoint.expiresAt)&&checkpoint.expiresAt>Date.now();
  const summary=checkpoint?el('div',{class:'checkpoint-summary','data-testid':'checkpoint-summary'},el('strong',{},t('checkpointSaved').replace('{count}',formatNumber(checkpoint.count))),el('span',{},`${t('checkpointSavedAt')} · ${date(checkpoint.savedAt)}`),el('span',{},t(resumable?'checkpointResumeHint':'checkpointExpiredHint')),checkpoint.waitUntil>Date.now()?el('span',{},t('checkpointWaiting').replace('{seconds}',Math.ceil((checkpoint.waitUntil-Date.now())/1000))):null):null;
  openDialog(t('followersReadTitle'), [el('p', {'data-testid':'followers-read-notice'}, t('followersReadNotice')),summary,el('p',{class:'followers-read-hint'},t('followersReadHint'))], checkpoint?
    [button(t('checkpointRestart'),()=>begin(false),{'data-testid':'restart-followers-read'}),button(t('checkpointResume').replace('{count}',formatNumber(checkpoint.count)),()=>begin(true),{style:'primary',disabled:!resumable,'data-testid':'resume-followers-read'})]:
    [button(t('followersReadConfirm'),()=>begin(false),{style:'primary','data-testid':'confirm-followers-read'})]);
  dialog.dataset.kind='followers-read';
}
async function startQuickScan(scope,choice={}) {
  return perform(async () => {
    const job = await api('QUICK_SCAN', { scope, ...choice,...(panelTabId() === null && model.manualTabSelection && model.tabId ? { tabId: Number(model.tabId) } : {}) });
    if (job?.accountId) {
      model.accountId = String(job.accountId);
      const view=scope==='followers'?(isFollowerView()?model.view:'followers'):(isFollowingView()?model.view:'all');
      model.view=view;model.lastResultsView=view;resetFilter();
      shareView(0,{accountId:model.accountId,view,lastResultsView:view,anchor:null,profileUserId:null});
    }
    return job;
  }, 'scanStarted');
}
function applyAppearance() {
  document.documentElement.dataset.theme = 'dark';
  document.documentElement.lang = language === 'zh_CN' ? 'zh-CN' : language;
  document.title = `${t('product')} · DimmensCK`;
}
async function updateSetting(patch) {
  if (demo) {
    Object.assign(model.data.state.settings, patch);
    language = model.data.state.settings.language;
    t = translator(language);
    render();
    return;
  }
  await perform(() => api('SETTINGS', { patch }));
}
async function refresh() {
  if (demo) { render(); return; }
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const knownStateRevision = model.data?.state && typeof model.data.stateRevision === 'string' ? model.data.stateRevision : null;
      const data = await api('GET_STATE', knownStateRevision ? { knownStateRevision } : {});
      if (data?.stateUnchanged === true) {
        if (!knownStateRevision || data.stateRevision !== knownStateRevision || !model.data?.state) throw new Error('PROTOCOL_ERROR');
        data.state = model.data.state;
      }
      if (!data?.state?.accounts || !data.state.settings) throw new Error('PROTOCOL_ERROR');
      const unchanged=data.state===renderedState && model.requestBusy===renderedRequestBusy && JSON.stringify([data.job,data.context,data.tabs,displayStats(data),data.busyElsewhere,data.panelTabId,data.activeTabId])===renderedMetadata;
      const progressOnly=data.state===renderedState&&model.requestBusy===renderedRequestBusy&&progressStructure(data)===renderedStructure&&jobLifecycle(data.job)===jobLifecycle(model.data?.job);
      model.data = data;
      language = languages.some(([key]) => key === data.state.settings.language) ? data.state.settings.language : 'zh_CN';
      t = translator(language);
      const available = new Set([...Object.keys(data.state.accounts), connectedId()]);
      if (!model.accountId || !available.has(model.accountId)) { model.accountId = validShared(data.sharedView)?preferredSharedAccountId():preferredAccountId(); resetFilter(); }
      const tabs = data.tabs || [];
      if (panelTabId() !== null) { model.tabId = String(panelTabId()); model.manualTabSelection = false; }
      else if (!tabs.some((tab) => String(tab.id) === model.tabId)) { model.tabId = String(data.activeTabId || data.context?.tabId || tabs[0]?.id || ''); model.manualTabSelection = false; }
      if(validShared(data.sharedView)&&!sharedDirty&&!sharedInFlight&&data.sharedView.value.accountId&&data.state.accounts[data.sharedView.value.accountId]&&model.accountId!==data.sharedView.value.accountId)sharedRevision=null;
      if(newerShared(data.sharedView))applyShared(data.sharedView);
      else if(!unchanged){if(progressOnly)updateJobProgress();else render();}
      else if(taskRunning())updateJobProgress();
      if(!initialSharedActivation&&validShared(data.sharedView)){initialSharedActivation=true;if(!document.hidden)claimShared();}
      maybeShowWelcome();
      return true;
    } catch (error) {
      if (error.message === 'PROTOCOL_ERROR' && model.data) delete model.data.stateRevision;
      if (!model.data) renderBoot(error.message);
      else notice(errorText(error.message, language), true, error.message);
      return false;
    } finally { refreshPromise = null; }
  })();
  return refreshPromise;
}
function brandIcon() { return el('img', { class: 'brand-icon', src: 'icons/32.png', width: 32, height: 32, alt: '', 'aria-hidden': 'true' }); }
function renderBoot(code = '') {
  app.replaceChildren(el('main', { class: 'boot' }, brandIcon(), el('h1', {}, t('product')), el('p', {}, code ? t('unknownError') : t('loading')), code ? el('p', { class: 'mono' }, code) : null,
    code ? el('div', {}, button(t('refresh'), refresh), ' ', el('a', { class: 'button', href: '?demo=1' }, t('demo'))) : null));
}
function resetFilter() { model.selected.clear(); submittedSelections.clear(); resetListPosition = true; hideProfile(); }
const resultsScopeKey = view => JSON.stringify([model.accountId,view,model.query,model.sort,model.verificationFilter]);
function navigate(view) {
  if (view === 'data' && model.view !== 'data') settingsReturn = {scope:resultsScopeKey(model.view),anchor:virtualView?.viewport.isConnected?virtualView.anchor():null};
  if (view!=='data') model.lastResultsView=view;
  model.view = view; const normalized={};
  if (view==='other') { model.verificationFilter='all';model.blueOnly=false;Object.assign(normalized,{verificationFilter:'all',blueOnly:false}); }
  if(isFollowerView()&&['followersDesc','followersAsc'].includes(model.sort)){model.sort='anomalies';normalized.sort='anomalies';}
  resetFilter();render();shareView(0,{view,lastResultsView:model.lastResultsView,...normalized,anchor:null,profileUserId:null});
}
function toggleDataView() {
  if (model.view !== 'data') return navigate('data');
  const view=views.includes(model.lastResultsView)?model.lastResultsView:'all';
  const anchor=settingsReturn?.scope===resultsScopeKey(view)?settingsReturn.anchor:null;
  model.view=view;model.lastResultsView=view;model.selected.clear();submittedSelections.clear();hideProfile();
  resetListPosition=!anchor;requestedAnchor=anchor;settingsReturn=null;render();
  shareView(0,{view,lastResultsView:view,anchor:anchor?.id?{userId:anchor.id,offset:Math.max(0,Math.min(71,Math.floor(anchor.offset)))}:null,profileUserId:null});
}
function viewUsers() {
  const a = account(), key = JSON.stringify([model.view, model.verificationFilter, model.query, model.sort]);
  if (listCache?.account === a && listCache.key === key) return listCache.users;
  const users = selectUsers(a, { view: model.view, verificationFilter: model.verificationFilter, query: model.query, sort: model.sort });
  listCache = { account: a, key, users }; return users;
}
function render() {
  if (!model.data) return renderBoot();
  if(interactionActive()){deferredRender=true;return;}
  deferredProgress=false;renderedRequestBusy=model.requestBusy;renderedState=model.data.state;renderedStructure=progressStructure(model.data);renderedMetadata=JSON.stringify([model.data.job,model.data.context,model.data.tabs,displayStats(model.data),model.data.busyElsewhere,model.data.panelTabId,model.data.activeTabId]);
  const focused = document.activeElement?.dataset?.focus;
  const cursor = document.activeElement?.selectionStart;
  const anchor = requestedAnchor || (!resetListPosition && virtualView?.viewport.isConnected ? virtualView.anchor() : null);requestedAnchor=null;
  resetListPosition = false;
  applyAppearance();
  hideTutorial();
  app.replaceChildren(el('div', { class: 'app-shell' }, renderSidebar(), renderMain(), renderFooter()));
  if (dialog.open && dialog.dataset.kind === 'advanced') dialog.querySelector('.advanced-body')?.replaceChildren(renderConnection());
  if (virtualView?.viewport.isConnected) virtualView.restore(anchor);
  if (focused) {
    const node = [...app.querySelectorAll('[data-focus]')].find((item) => item.dataset.focus === focused);
    if (node) { restoringFocus=true;try{node.focus({ preventScroll: true }); if (typeof cursor === 'number' && node.setSelectionRange) node.setSelectionRange(cursor, cursor);}finally{restoringFocus=false;} }
  }
  updateProfileLayout();
  if(profileKey){const local=profileKey.startsWith(`${model.accountId}:`)?profileUser(profileKey.split(':')[1]):null;if(local)drawProfile(local,currentProfileCache(local,profileKey));else hideProfile();}
}
function followerObservation(accountValue=account()) {const view=getFollowerView(accountValue);return view?.incomplete?view.snapshot:null;}
function jobObservation(job) {const owner=model.data?.state?.accounts[job?.accountId];if(!owner)return null;const observation=followerObservation(owner);return job?.scanId&&observation?.runId===job.scanId?observation:null;}
function observationTotal(snapshot) {const values=[snapshot?.expectedStart,snapshot?.pageExpected,snapshot?.expectedEnd].filter(Number.isSafeInteger).filter(value=>value>=0);const unique=[...new Set(values)];return unique.length?unique.map(formatNumber).join(' / '):t('totalUnknown');}
function observationMessage(key,snapshot=followerObservation()) {return t(key).replace('{count}',formatNumber(snapshot?.users?.length||0)).replace('{total}',observationTotal(snapshot));}
function listCoverage(owner,scope) {
  const verification=scope==='followers'?owner?.followers?.verification:owner?.lastScan?.verification;
  if(verification?.terminal!==true)return null;
  const count=scope==='followers'?owner.followers.users.length:owner.users.length;
  const totals=[verification[scope==='followers'?'expectedStart':'followingExpectedStart'],verification.pageExpected,verification[scope==='followers'?'expectedEnd':'followingExpectedEnd']].filter(value=>Number.isSafeInteger(value)&&value>=0);
  return {scope,verification,count,totals:[...new Set(totals)],mismatch:totals.some(value=>value!==count)};
}
function coverageMessage(coverage) {
  return t(coverage.totals.length?'terminalCoverageCount':'terminalCoverageUnknown').replace('{count}',formatNumber(coverage.count)).replace('{total}',coverage.totals.map(formatNumber).join(' / '));
}
function jobTerminalEvidence(job) {
  const owner=model.data?.state?.accounts[job?.accountId];
  return ['following','followers'].filter(scope=>job?.[`${scope}Saved`]===true).map(scope=>listCoverage(owner,scope)).filter(item=>item&&job.scanId&&item.verification.runId===job.scanId);
}
function showPendingFollowers() {
  const rows=account()?.followers?.pendingMissing||[],size=20;
  let page=0;
  const list=el('ul',{class:'pending-followers-list','data-testid':'pending-followers-list'}),range=el('span',{class:'pending-page-range','aria-live':'polite'});
  const previous=button(t('prev'),()=>{page--;draw();},{style:'small','data-testid':'pending-previous'}),next=button(t('next'),()=>{page++;draw();},{style:'small','data-testid':'pending-next'});
  function draw(){const start=page*size;list.replaceChildren(...rows.slice(start,start+size).map(row=>el('li',{},el('div',{},el('strong',{},row.name||row.handle||row.id),el('div',{class:'row-meta'},profileLink(row,'',row.handle?`@${row.handle}`:row.id)),el('div',{class:'row-meta'},`${t('followerLastSeen')} · ${date(row.lastSeenAt)}`)),el('span',{class:'relation-chip unknown'},t('pendingFollowerStatus')))));range.textContent=`${start+1}–${Math.min(rows.length,start+size)} / ${formatNumber(rows.length)}`;previous.disabled=page===0;next.disabled=start+size>=rows.length;}
  draw();openDialog(t('pendingFollowersTitle'),[el('p',{},t('pendingFollowersHint')),list,el('div',{class:'pending-pagination'},previous,range,next)],[]);
}
function navigationCount(view,count) {
  const observation=isFollowerView(view)&&followerObservation();
  if(observation){if(['followersNew','followersLost'].includes(view))return t('observationPending');if(count!==null)return t('observationRead').replace('{count}',formatNumber(count));}
  return count===null?t(view==='followersNew'&&account()?.followers&&!Array.isArray(account().followers.addedIds)?'unestablished':'notChecked'):formatNumber(count);
}
function renderSidebar() {
  const counts = indexAccount().counts;
  const nav = el('nav', { 'aria-label': t('workspace') },
    el('div', { class: 'nav-list' }, views.map((view) => el('button', { type: 'button', class: `nav-item${model.view === view ? ' active' : ''}`, 'data-view':view, 'data-help': isFollowerView(view)&&followerObservation()?observationMessage('followersObservationHint'):t(view==='followers'?'followersViewDesc':`${view}Desc`), 'aria-current': model.view === view ? 'page' : null, onclick: () => navigate(view) }, icon(view), el('span', { class: 'nav-label' }, viewLabel(view)), el('span', { class: `nav-count${counts[view]===null?' unestablished':''}`,'data-pending':counts[view]===null&&isFollowerView(view)&&followerObservation()?'true':null,'data-help':counts[view]===null?navigationCount(view,counts[view]):null }, navigationCount(view,counts[view]))))));
  const controls = el('div', { class: 'header-controls' },
    renderLanguageButtons(),
    button('', () => openDialog(t('help'), ['helpStart', 'helpModes', 'helpActions', 'helpData', 'platformRisk'].map(key => el('p', {}, t(key))), [button(t('authorNote'),()=>showWelcome(false),{style:'primary','data-testid':'open-author-note'})]), { style: 'icon ghost', glyph: 'info', 'aria-label': t('help'), title: t('helpStart'),'data-testid':'help' }),
    button('', () => perform(() => api('CLOSE_PANEL')), { style: 'icon ghost panel-close', glyph: 'close', 'aria-label': t('closePanel'), title: t('helpClosePanel'), disabled: demo }));
  return el('header', { class: 'sidebar' }, el('div', { class: 'brand-row' }, el('a', { class: 'brand project-link', href: PROJECT_URL, target: '_blank', rel: 'noopener noreferrer', 'data-testid':'project-info', 'aria-label':t('repositoryInfo'),title:t('repositoryInfo') }, brandIcon(), el('div', {}, el('div', { class: 'brand-name' }, t('product')), el('div', { class: 'brand-by' }, 'DIMMENSCK'))), controls), renderAccountHero(), renderQuickScan(), nav);
}
function renderFooter() {
  return el('div',{class:'app-footer'},button(t('dataTools'),toggleDataView,{style:'settings-entry primary',glyph:'data','data-testid':'settings-entry','aria-pressed':String(model.view==='data'),'aria-current':model.view==='data'?'page':null,title:t(model.view==='data'?'returnToResults':'helpData')}),renderCommunityCard());
}
function renderVerificationFilter() {
  return el('div',{class:'verification-filter',role:'group','aria-label':t('verificationFilter')},['all','blue','standard'].map(value=>button(t(`filter${value[0].toUpperCase()}${value.slice(1)}`),()=>{model.verificationFilter=value;model.blueOnly=value==='blue';resetFilter();render();shareView(0,{verificationFilter:value,blueOnly:model.blueOnly,anchor:null,profileUserId:null});},{style:`small verification-button${model.verificationFilter===value?' active':' ghost'}`,'data-verification':value,'aria-pressed':model.verificationFilter===value,disabled:model.view==='other'&&value!=='all',title:t(model.view==='other'&&value!=='all'?'otherFilterHint':`helpFilter${value[0].toUpperCase()}${value.slice(1)}`)})));
}
function renderLanguageButtons() {
  return el('div', { class: 'language-buttons', role: 'group', 'aria-label': t('language') }, languages.map(([key, label]) => button(({ zh_CN: '中文', en: 'EN' })[key] || label, () => updateSetting({ language: key }), { style: `small language-button${language === key ? ' active' : ' ghost'}`, 'aria-label': label, 'aria-pressed': language === key, 'data-language': key, title: t('helpLanguage') })));
}
function renderCommunityCard() {
  return el('footer', { class: 'community-card', 'data-testid': 'community-card' },
    el('button', {type:'button',class:'community-message','aria-label':t('helpAuthorFollowOpen'),title:demo?t('demoAction'):t('helpAuthorFollowOpen'),'data-help':`${t('communityMessage')} ${demo?t('demoAction'):t('helpAuthorFollowOpen')}`,'data-testid':'community-author',disabled:demo||taskRunning()||model.requestBusy||model.data?.busyElsewhere,onclick:followAuthor},t('communityMessage')));
}
function renderAccountHero() {
  const a = account();
  const accountOptions = Object.values(model.data.state.accounts).map((item) => [item.id, `@${item.handle}`]);
  if (connectedId() && !accountOptions.some(([id]) => id === connectedId())) accountOptions.push([connectedId(), `@${contextAccount().handle || connectedId()} · ${t('never')}`]);
  if (!accountOptions.length) accountOptions.push(['', t('noAccount')]);
  const followingAt=a?.lastScan?.complete?a.lastScan.finishedAt:null,followersAt=a?.followers?.observedAt;
  const followingCoverage=listCoverage(a,'following'),followersCoverage=listCoverage(a,'followers');
  return el('section', { class: 'hero account-hero' }, el('div', { class: 'hero-title' }, el('h1', {}, t('accountInfo')), el('div',{class:'snapshot-dates'},el('span', { class: 'snapshot-date','data-snapshot':'following', 'data-help': followingCoverage?coverageMessage(followingCoverage):t('followingSnapshotHelp'), tabindex: '0' }, `${t('followingShort')} · ${followingAt?date(followingAt):t('notChecked')}`),el('span',{class:'snapshot-date','data-snapshot':'followers','data-help':followerObservation()?`${t('followersSnapshotHelp')} ${observationMessage('followersObservationHint')}`:followersCoverage?coverageMessage(followersCoverage):t('followersSnapshotHelp'),'data-snapshot-quality':followerObservation()?'incomplete':followersCoverage?'terminal':followersAt?'legacy':'none',tabindex:'0'},`${t('followers')} · ${followersAt?date(followersAt):t('notChecked')}`))),
    el('div',{class:'account-controls'},renderVerificationFilter(),el('label', { class: 'snapshot-select' }, el('span', { class: 'field-label' }, t('accountLabel')), select(accountOptions, model.accountId, (id) => { model.accountId = id; resetFilter(); render();shareView(0,{accountId:id,anchor:null,profileUserId:null}); }, t('accountLabel'), { 'data-focus': 'account' }))));
}
function renderMain() {
  const a = account();
  const main = el('main', { class: 'main', 'aria-labelledby':'results-heading' }, demo ? el('div', { class: 'demo-banner', role: 'status' }, el('strong', {}, t('demo')), el('span', {}, t('demoDesc'))) : null, el('h2', { id:'results-heading', class: 'results-heading sr-only' }, model.view === 'data' ? t('dataTools') : viewLabel(model.view)));
  if (model.view === 'data') { main.append(renderData()); return main; }
  if (connectedId() && model.accountId && !ownerMatches()) main.append(inlineNotice('mismatch', true));
  else if (a?.lastScan?.complete && !isFollowerView() && !isFresh()) main.append(inlineNotice('snapshotOld'));
  const unresolved = (a?.actions || []).filter((action) => ['pending', 'unknown'].includes(action.status));
  const unresolvedCount=unresolved.length+Number(['pending','unknown'].includes(a?.authorFollow?.status));
  if (unresolvedCount) main.append(el('div', { class: 'notice-inline warn' }, icon('info'), el('span', {}, `${t('unresolvedActions')} · ${formatNumber(unresolvedCount)}`), button(t('reviewUnresolved'), () => { model.dataTab = 'unresolved'; navigate('data'); }, { style: 'small ghost' })));
  const scopeNote=({lost:'lostScope',followers:'followersScope',followersOnly:'followersOnlyScope',followersNew:'followersNewScope',followersLost:'followersLostScope'})[model.view];
  const observation=isFollowerView()?followerObservation():null;
  if(observation)main.append(el('p',{class:'view-scope-note observation-note','data-testid':'follower-observation-note','data-help':observationMessage('followersObservationHint',observation),tabindex:'0'},icon('info'),observationMessage('followersObservationShort',observation)));
  else if(scopeNote)main.append(el('p',{class:'view-scope-note','data-help':t(model.view==='followers'?'followersViewDesc':`${model.view}Desc`),tabindex:'0'},icon('info'),t(scopeNote)));
  if(model.view==='followersLost'&&a?.followers?.pendingMissing?.length)main.append(el('div',{class:'pending-followers-note','data-testid':'pending-followers-note'},el('span',{},t('pendingFollowersCount').replace('{count}',formatNumber(a.followers.pendingMissing.length))),button(t('viewPendingFollowers'),showPendingFollowers,{style:'small ghost','data-testid':'view-pending-followers',title:t('pendingFollowersHint')})));
  main.append(renderResults());
  return main;
}
function inlineNotice(key, warn = false) { return el('div', { class: `notice-inline${warn ? ' warn' : ''}` }, icon('info'), el('span', {}, t(key))); }
function openAdvanced() { openDialog(t('advanced'), [el('div', { class: 'advanced-body' }, renderConnection())], []); dialog.dataset.kind = 'advanced'; }
function retrySource(job=model.data.job) {
  if(!job||job.kind!=='scan'||job.running||job.phase==='complete')return null;
  const scope=['following','followers'].includes(job.errorDetails?.scope)?job.errorDetails.scope:followersJobStage(job)||pendingFollowersJob(job)?'followers':'following';
  if(scope==='followers'?job.followersSaved===true:job.followingSaved===true)return null;
  return scope==='followers'?'followers':job.source==='scroll'?'scroll':'api';
}
function canRetryJob(job=model.data.job) {return retrySource(job)!==null&&job.accountId===model.accountId&&ownerMatches()&&!demo&&!model.data.busyElsewhere&&!model.requestBusy&&model.data.state.settings.enabled;}
function retryJob() {const job=model.data.job;if(!canRetryJob(job))return;const source=retrySource(job),accountId=job.accountId,tabId=model.data.context.tabId;const start=(choice={})=>perform(()=>api('START_SCAN',{accountId,tabId,source,...choice}),'scanStarted');closeDialog();return source==='followers'?confirmFollowersRead(start,accountId):start();}
function requestAdvancedScan() {
  const source=model.source,tabId=model.data.context.tabId,accountId=model.accountId;
  const start=(choice={})=>perform(()=>api('START_SCAN',{tabId,accountId,source,...choice}),'scanStarted');
  if (['auto','dual','followers'].includes(source)) return confirmFollowersRead(start,accountId);
  closeDialog(); return start();
}
function renderQuickScan() {
  const running=taskRunning(),job=model.data.job,disabled=demo||running||model.requestBusy||model.data.busyElsewhere;
  const activeScope=running&&job.kind==='scan'?(followersJobStage(job)?'followers':'following'):null;
  const checks=[['following','checkFollowing','helpCheckFollowing'],['followers','checkFollowers','helpCheckFollowers']];
  return el('section', { class: 'quick-card split-scan', 'aria-label':t('scanChoices') },
    el('div',{class:'split-scan-actions'},checks.map(([scope,label,help])=>button(t(label),()=>requestQuickScan(scope),{style:'primary quick-button',glyph:'scan',disabled,title:demo?t('demoAction'):model.data.busyElsewhere?t('busyElsewhere'):t(help),'data-testid':`quick-scan-${scope}`,'data-scan-scope':scope,'aria-busy':activeScope===scope}))),
    el('div',{class:'quick-secondary'},model.data.busyElsewhere?el('span',{class:'quick-busy'},t('busyElsewhere')):null,
      canRetryJob(job)?button(t(job.phase==='paused'?'checkpointContinue':'retryScan'),retryJob,{style:'small primary','data-testid':'retry-scan',title:t(job.phase==='paused'?'checkpointResumeHint':'helpRetryScan')}):null,
      button(t('advanced'),openAdvanced,{style:'small ghost',title:t('helpAdvanced'),'data-testid':'advanced'}),
      running&&job.kind!=='author_follow'?button(t(job.stopRequested?'stopping':followersJobStage(job)?'pauseScan':'stop'),requestStop,{style:`small quick-stop${followersJobStage(job)?'':' danger'}`,glyph:'stop',disabled:Boolean(job.stopRequested)||demo,title:t(model.data.busyElsewhere?'jobElsewhere':followersJobStage(job)?'pauseScanHint':'stopNote'),'data-testid':'stop-job'}):null),renderJobProgress());
}
function renderConnection() {
  const tabs = (model.data.tabs || []).filter(tab => panelTabId() === null || tab.id === panelTabId());
  const options = tabs.length ? tabs.map((tab) => [String(tab.id), `${tab.title || 'X'} · #${tab.id}`]) : [['', t('noTabs')]];
  const connectBtn = button(t('connect'), () => perform(async () => { const value = await api('CONNECT', { tabId: Number(model.tabId) }); model.manualTabSelection = true; model.accountId = String(value?.account?.id || value?.accountId || ''); model.selected.clear();shareView(0,{accountId:model.accountId,anchor:null,profileUserId:null}); }, 'connectedNotice'), { disabled: !model.tabId || taskRunning() || demo });
  const card = el('section', { class: 'connection-card', 'aria-label': t('connectedAccount') }, el('div', { class: 'connection-row' }, el('label', { class: 'connection-tab' }, el('span', { class: 'field-label' }, t('tabLabel')), select(options, model.tabId, (id) => { model.tabId = id; model.manualTabSelection = true; }, t('tabLabel'), { 'data-focus': 'tab', disabled: taskRunning() || demo || panelTabId() !== null })), connectBtn,
    button('', refresh, { glyph: 'refresh', style: 'icon ghost', title: t('refresh'), 'aria-label': t('refresh') }), !tabs.length ? el('a', { href: 'https://x.com/home', target: '_blank', rel: 'noopener noreferrer', class: 'button' }, t('openX'), icon('arrow')) : null,
    el('div', { class: 'connection-divider' }), el('div', { class: 'scan-controls' }, select([['auto', t('auto')], ['api', t('api')], ['scroll', t('scroll')],['followers',t('followersMode')]], model.source, (source) => { model.source = source; render(); }, t('scanMode'), { disabled: taskRunning() }),
      button(t('openFollowing'), () => perform(() => api('OPEN_FOLLOWING', { tabId: model.data.context.tabId })), { style: 'ghost', disabled: !ownerMatches() || taskRunning() || demo }),
      button(t('scan'), requestAdvancedScan, { style: 'primary', glyph: 'scan', disabled: taskRunning() || !ownerMatches() || demo || model.requestBusy || !model.data.state.settings.enabled }))),
    el('div', { class: 'connection-foot' }, el('div', { class: 'connection-status' }, el('span', { class: `dot${ownerMatches() ? ' live' : ''}` }), el('span', {}, `${t('latest')} · ${account()?.lastScan ? date(account().lastScan.finishedAt) : t('never')}`)),
      el('label', { class: 'toggle-label', 'data-help': t('enabledHint') }, el('input', { type: 'checkbox', checked: model.data.state.settings.enabled, onchange: (event) => updateSetting({ enabled: event.target.checked }) }), t('enabled'), el('span', {}, t(model.data.state.settings.enabled ? 'enabledOn' : 'enabledOff')))));
  card.append(el('p', { class: 'scan-hint' }, t(model.source === 'auto' ? 'autoHint' : model.source === 'followers'?'followersHint':model.source === 'scroll' ? 'scrollHint' : 'apiHint')));
  if (!model.data.state.settings.enabled) card.append(el('p', { class: 'scan-hint' }, t('enableToScan')));
  return card;
}
const preparationLabel=stage=>({identify_account:'prepIdentifyAccount',open_profile:'prepOpenProfile',open_list:'prepOpenList',wait_navigation:'prepWaitNavigation',wait_response:'prepWaitResponse',reload_list:'prepReloadList'})[stage];
const followersJobStage=job=>job?.kind==='scan'&&(job.source==='followers'||job.progressStage==='followers'||job.errorDetails?.stage==='followers');
const pendingFollowersJob=job=>job?.kind==='scan'&&['auto','dual'].includes(job.source)&&job.followingSaved===true&&job.followersSaved!==true&&job.phase!=='complete';
const jobSavedKey=job=>job.followingSaved&&job.followersSaved?'savedBoth':job.followingSaved?'savedFollowing':job.followersSaved?'savedFollowers':'readNotSaved';
function renderJobProgress() {
  const job = model.data.job;
  const card = el('div', { class: 'job-container' });
  if(job?.kind==='author_follow')return el('div',{class:'job-container'},el('p',{class:'author-follow-progress',role:'status'},t('authorFollowProcessing')));
  if (job?.kind || job?.error) {
    const jobOwner=model.data.state.accounts[job.accountId] || (contextAccount()?.id===job.accountId ? contextAccount() : null);
    const taskKind=`${t(job.kind==='actions'?'jobActions':job.source==='followers'?'jobScanFollowers':['auto','dual'].includes(job.source)?'jobScanAll':'jobScan')}${job.accountId?` · ${jobOwner?.handle?'@'+jobOwner.handle:'ID '+job.accountId}`:''}`;
    card.append(el('div',{class:'task-kind',title:taskKind},taskKind));
    if(model.data.busyElsewhere)card.append(el('div',{class:'task-source'},t('jobElsewhere')));
    const waiting = job.running && Number.isFinite(job.waitUntil) && job.waitUntil > Date.now();
    const readingFollowers=followersJobStage(job);
    const checkingAbsence=job.running&&readingFollowers&&Number.isSafeInteger(job.absenceCheckTotal)&&job.absenceCheckTotal>0;
    const rawTotal = checkingAbsence?job.absenceCheckTotal:readingFollowers?job.followersTotal:job.total;
    const rawDone = checkingAbsence?job.absenceCheckDone:readingFollowers?job.followersDone:job.done;
    const total = Number.isSafeInteger(rawTotal) && rawTotal >= 0 ? rawTotal : null;
    const done = Number.isSafeInteger(rawDone) && rawDone >= 0 ? rawDone : 0;
    // A zero, absent, or contradicted total cannot supply a meaningful percentage.
    const comparableTotal = total !== null && total > 0 && done <= total;
    const percent = comparableTotal ? Math.min(100, done / total * 100) : null;
    const meter = el('div', { class: 'meter-fill' }); meter.style.width = percent === null ? '30%' : `${percent}%`;
    const seconds = job.startedAt ? Math.max(0, Math.floor(((job.finishedAt || (job.running ? Date.now() : job.updatedAt) || Date.now()) - job.startedAt) / 1000)) : 0;
    const stageStart = readingFollowers?job.followersStartedAt:job.startedAt;
    const stageWaitMs = readingFollowers ? job.followersWaitMs : job.followingWaitMs;
    const stageSeconds = Number.isFinite(stageStart) && stageStart > 0 && stageStart <= Date.now() ? Math.max(0, Date.now() - stageStart - (Number.isFinite(stageWaitMs) && stageWaitMs > 0 ? stageWaitMs : 0)) / 1000 : null;
    const remaining = job.running && !checkingAbsence && !waiting && job.kind === 'scan' && comparableTotal && done > 0 && done < total && stageSeconds > 0
      ? Math.ceil(stageSeconds / done * (total - done)) : null;
    const duration = (value) => `${Math.floor(value / 60)}${t('minutes')} ${value % 60}${t('seconds')}`;
    const completeBoth=job.kind==='scan'&&!job.running&&job.phase==='complete'&&job.followingSaved===true&&job.followersSaved===true;
    const terminal=jobTerminalEvidence(job),terminalComplete=job.kind==='scan'&&!job.running&&job.phase==='complete'&&!job.error&&terminal.length>0;
    const countText=checkingAbsence?t('checkingMissingCount').replace('{done}',formatNumber(done)).replace('{total}',formatNumber(total)):completeBoth?t('completedBoth').replace('{following}',formatNumber(job.done)).replace('{followers}',formatNumber(job.followersDone)):terminalComplete?t('terminalSavedCount').replace('{count}',formatNumber(done)):`${formatNumber(done)}${total !== null ? ` / ${formatNumber(total)}` : ` · ${t('totalUnknown')}`}${percent !== null ? ` (${Math.floor(percent)}%)` : ''}`;
    const scanUnfinished = job.kind === 'scan' && (job.running || job.phase !== 'complete' || job.error);
    const jobLabel = job.running && preparationLabel(job.preparation?.stage) ? preparationLabel(job.preparation.stage) : job.running ? (job.phase === 'preparing' ? 'phasePreparing' : job.kind === 'scan' ? job.absenceCheckTotal>0?'checkingMissingFollowers':job.readMethod==='scroll'?'phaseNativeReading':readingFollowers?'scanningFollowers':'scanningFollowing' : 'acting') : terminalComplete?'terminalReadEnd':job.phase==='partial'?'phasePartial':job.error ? (job.kind === 'scan' ? 'scanIncomplete' : 'failed') : ({ paused:'phasePaused', stopped: 'phaseStopped', interrupted: 'phaseInterrupted', complete: 'phaseComplete', failed: 'phaseFailed' })[job.phase] || 'completed';
    card.append(el('div', { class: `task-progress${job.running && percent === null ? ' indeterminate' : ''}` }, el('div', { class: 'task-head' }, el('span', { class: 'task-label', ...(jobLabel==='phaseNativeReading'?{'data-help':t('helpNativeReading'),tabindex:'0'}:{}) }, t(jobLabel)), el('span', { class: 'task-count' }, countText)), job.running ? el('div', { class: 'meter', role: 'progressbar', 'aria-label': t('progress'), ...(percent !== null ? { 'aria-valuenow': Math.floor(percent), 'aria-valuemin': 0, 'aria-valuemax': 100 } : {}) }, meter) : null,
      el('div', { class: 'task-details' }, job.running || job.finishedAt || job.updatedAt ? el('span', { class: 'task-elapsed' }, `${t('elapsed')} ${duration(seconds)}`) : null, remaining !== null && !job.error ? el('span', { class: 'task-eta' }, `${t('estimatedRemaining')} ${duration(remaining)}`) : null,!job.error&&(terminalComplete||job.statusWriteError||job.readStats?.following||job.readStats?.followers||!job.running&&pendingFollowersJob(job))?button(t('errorDetails'),()=>showJobDetails(model.data.job),{style:'small ghost','data-testid':'job-details'}):null,
        job.kind==='scan'&&!job.error&&(scanUnfinished||job.followingSaved||job.followersSaved) ? el('span', { class: 'task-save-state' }, t(jobSavedKey(job))) : null, job.running && !job.error ? el('span', { class: 'task-lifecycle', 'data-help': t(job.kind === 'scan' ? 'scanLifecycle' : 'actionLifecycle'), tabindex: '0' }, t(job.kind === 'scan' ? 'scanLifecycleShort' : 'actionLifecycleShort')) : null), job.error ? el('div', { class: 'task-error' }, el('span', {}, t(job.kind === 'scan' ? job.running ? waiting ? 'readRetrying' : 'readIssueRunning' : jobObservation(job)?'followersObservationSavedShort':job.followingSaved?'partialFollowingSaved':job.followersSaved?'partialFollowersSaved':'scanIncompleteShort' : 'failed')), button(t('errorDetails'), () => showJobDetails(model.data.job), { style:'small ghost', title:t('helpErrorDetails'), 'data-testid':'job-details' })) : null));
    const pendingMissing=job.followersSaved?model.data.state.accounts[job.accountId]?.followers?.pendingMissing?.length||0:0;
    if(terminalComplete&&(terminal.some(item=>item.mismatch)||pendingMissing))card.append(el('p',{class:'task-coverage-note','data-testid':'terminal-count-notice'},terminal.some(item=>item.mismatch)?t('terminalCountNotice'):null,pendingMissing?el('span',{'data-testid':'terminal-pending-count'},` ${t('pendingFollowersCount').replace('{count}',formatNumber(pendingMissing))}`):null));
    if (waiting && !job.error && job.waitReason!=='pacing') card.append(el('div', { class: 'task-wait', 'data-help':job.waitReason==='rate_limit'?t('helpWaitingRateLimit'):null, tabindex:job.waitReason==='rate_limit'?'0':null }, `${t(job.waitReason==='rate_limit'?'waitingRateLimit':'waitingRead')} · ${Math.ceil((job.waitUntil - Date.now()) / 1000)}${t('seconds')}`));
    const checkpoint=followersJobStage(job)&&!job.followersSaved?followerCheckpoint(job.accountId):null;
    if(checkpoint)card.append(el('p',{class:'task-checkpoint','data-testid':'task-checkpoint'},`${t('checkpointSaved').replace('{count}',formatNumber(checkpoint.count))} · ${t('checkpointStorageHint')}`));
  }
  return card;
}
// Only the small progress fragment is reconciled. Keep its animated meter attached;
// never use this helper for account rows, form controls or action confirmation state.
function patchProgressNode(current,next){
  if(current.nodeType===Node.TEXT_NODE){if(current.nodeValue!==next.nodeValue)current.nodeValue=next.nodeValue;return;}
  for(const attr of [...current.attributes])if(!next.hasAttribute(attr.name))current.removeAttribute(attr.name);
  for(const attr of [...next.attributes])if(current.getAttribute(attr.name)!==attr.value)current.setAttribute(attr.name,attr.value);
  const key=node=>node.nodeType===Node.TEXT_NODE?'#text':`${node.nodeName}.${node.classList?.[0]||''}`;
  const available=[...current.childNodes];let position=0;
  for(const child of [...next.childNodes]){
    const index=available.findIndex(node=>key(node)===key(child));
    const found=index>=0?available.splice(index,1)[0]:null;
    if(found){patchProgressNode(found,child);if(current.childNodes[position]!==found)current.insertBefore(found,current.childNodes[position]||null);}
    else current.insertBefore(child,current.childNodes[position]||null);
    position++;
  }
  for(const node of available)node.remove();
}
function updateJobProgress(){
  if(interactionActive()){deferredProgress=true;return;}
  deferredProgress=false;
  const current=app.querySelector('.job-container');if(!current)return render();
  patchProgressNode(current,renderJobProgress());
  const job=model.data.job,stop=app.querySelector('.quick-stop');
  const activeScope=taskRunning()&&job.kind==='scan'?(followersJobStage(job)?'followers':'following'):null;
  for(const control of app.querySelectorAll('[data-scan-scope]'))control.setAttribute('aria-busy',String(control.dataset.scanScope===activeScope));
  if(stop&&taskRunning()){
    const label=t(job.stopRequested?'stopping':followersJobStage(job)?'pauseScan':'stop');if(stop.textContent.trim()!==label)stop.replaceChildren(icon('stop'),label);
    stop.classList.toggle('danger',!followersJobStage(job));
    stop.disabled=Boolean(job.stopRequested)||demo;
  }
  virtualView?.reflow();
  renderedMetadata=JSON.stringify([model.data.job,model.data.context,model.data.tabs,displayStats(model.data),model.data.busyElsewhere,model.data.panelTabId,model.data.activeTabId]);
}
function renderReadStats(job) {
  const integer=value=>Number.isSafeInteger(value)&&value>=0;
  return ['following','followers'].flatMap(scope=>{
    const stats=job.readStats?.[scope];if(!stats||!integer(stats.pages)||!integer(stats.requests))return [];
    const number=value=>integer(value)?formatNumber(value):'—';
    return el('section',{class:'read-statistics','data-read-statistics':scope},el('h3',{},t(scope==='following'?'all':'followersView')),
      el('dl',{},el('dt',{},t('readPages')),el('dd',{},number(stats.pages)),el('dt',{},t('readRequests')),el('dd',{},number(stats.requests)),el('dt',{},t('readReusedPages')),el('dd',{},number(stats.reusedPages)),el('dt',{},t('readPageSize')),el('dd',{'data-page-size':scope},`${number(stats.requestedPageSize)} / ${number(stats.maxActualPageSize)}`)),
      stats.pageSizeFallbacks>0?el('p',{'data-page-fallback':scope},t('readPageFallback').replace('{count}',number(stats.requestedPageSize))):null);
  });
}
function showJobDetails(job) {
  const details = job.errorDetails || {};
  const phaseKey = ({ preparing:'phasePreparing', scanning:'scanning', complete:'phaseComplete',partial:'phasePartial', paused:'phasePaused', stopped:'phaseStopped', interrupted:'phaseInterrupted', failed:'phaseFailed' })[job.phase];
  const scan=job.kind==='scan',readingFollowers=followersJobStage(job),pendingFollowers=pendingFollowersJob(job),a=model.data.state.accounts[job.accountId];
  const saved=scan&&Boolean(readingFollowers||pendingFollowers?a?.followers?.observedAt:a?.lastScan?.complete);
  const unavailableEndpoint=scan&&job.error==='http_error'&&details.method==='GET'&&details.status===404&&['Following','Followers'].includes(details.operation);
  const counts=scan?[['followingRead',job.done,job.followingSaved],['followersRead',job.followersDone,job.followersSaved]].filter(([key,value])=>(key!=='followingRead'||job.source!=='followers')&&(key!=='followersRead'||readingFollowers||job.followersSaved)&&Number.isSafeInteger(value)&&value>=0):[];
  const complete=scan&&!job.running&&job.phase==='complete'&&!job.error;
  const saveMessage=complete?jobSavedKey(job):job.followingSaved&&(readingFollowers||pendingFollowers)?saved?'partialExistingFollowers':'partialFirstFollowers':readingFollowers?saved?'followersNotSavedExisting':'followersNotSavedFirst':saved?'scanNotSavedExisting':'scanNotSavedFirst';
  const retryAvailable=canRetryJob(job);
  const observation=scan&&(readingFollowers||pendingFollowers)?jobObservation(job):null;
  const terminal=jobTerminalEvidence(job);
  const checkpoint=readingFollowers&&!job.followersSaved?followerCheckpoint(job.accountId):null;
  openDialog(t('errorDetails'), [el('p', {class:'error-guidance'}, !job.error&&job.statusWriteError?t('statusWriteWarning'):complete&&terminal.length?t('terminalCoverageHint'):!job.error&&scan&&!job.running?t('scanEndedGuidance'):scan ? job.running ? t('readActiveIssue') : unavailableEndpoint ? t('scanEndpointUnavailable') : scanErrorText(String(job.error), language) : errorText(String(job.error), language)),
    job.error&&job.statusWriteError?el('p',{class:'status-write-warning'},t('statusWriteWarning')):null,
    scan ? el('p', {class:'task-save-state'}, observation?observationMessage('followersObservationHint',observation):t(saveMessage)) : null,
    checkpoint?el('p',{class:'task-checkpoint','data-testid':'checkpoint-detail'},`${t('checkpointSaved').replace('{count}',formatNumber(checkpoint.count))} · ${t('checkpointStorageHint')}`):null,
    terminal.map(item=>el('p',{class:'terminal-coverage','data-coverage-scope':item.scope},`${t(item.scope==='following'?'followingShort':'followers')} · ${coverageMessage(item)}`)),
    complete&&readingFollowers&&a?.followers?.pendingMissing?.length?el('p',{class:'pending-followers-summary'},t('pendingFollowersCount').replace('{count}',formatNumber(a.followers.pendingMissing.length))):null,
    el('dl', {class:'error-facts'}, el('dt',{},t('phase')),el('dd',{},phaseKey ? t(phaseKey) : String(job.phase || '—')),
      ...counts.flatMap(([key,value,committed])=>[el('dt',{},t(key)),el('dd',{'data-read-count':key},`${formatNumber(value)} · ${t(key==='followersRead'&&observation?'observationKept':committed?'saved':'notSaved')}`)]),
      preparationLabel(details.preparationStage||job.preparation?.stage)?[el('dt',{},t('preparationStage')),el('dd',{},t(preparationLabel(details.preparationStage||job.preparation?.stage)))]:null,
      job.error||job.statusWriteError||details.code?[el('dt',{},t('errorCode')),el('dd',{class:'error-code mono'},String(job.error || job.statusWriteError || details.code))]:null,
      Number.isInteger(details.status) ? [el('dt',{},t('serverStatus')),el('dd',{class:'task-http'},`HTTP ${details.status}`)] : null,
      details.operation ? [el('dt',{},t('readOperation')),el('dd',{},String(details.operation))] : null,
      details.method ? [el('dt',{},t('readMethod')),el('dd',{},String(details.method))] : null),
    renderReadStats(job),
    job.running && Number.isFinite(job.waitUntil) && job.waitUntil>Date.now() && job.waitReason!=='pacing' ? el('p',{class:'task-wait','data-help':job.waitReason==='rate_limit'?t('helpWaitingRateLimit'):null,tabindex:job.waitReason==='rate_limit'?'0':null},`${t(job.waitReason==='rate_limit'?'waitingRateLimit':'waitingRead')} · ${Math.ceil((job.waitUntil-Date.now())/1000)}${t('seconds')}`) : null],retryAvailable?[button(t('retryScan'),retryJob,{style:'primary','data-testid':'retry-followers',title:t('helpRetryScan')})]:[]);
}
function renderResults() {
  const a = account();
  const list = viewUsers();
  const filteredIds = new Set(list.map((user) => user.id));
  const submitted = submittedSelections.get(model.accountId);
  if (submitted) for (const [id, previousReceiptId] of submitted) {
    const action = latestAction(id);
    if (!model.selected.has(id)) submitted.delete(id);
    else if (action?.status === 'success' && typeof action.id === 'string' && action.id !== previousReceiptId) { model.selected.delete(id); submitted.delete(id); }
  }
  for (const id of model.selected) if (!filteredIds.has(id)) model.selected.delete(id);
  const search = el('input', { type: 'search', maxlength:200, value: model.query, placeholder: t('search'), 'aria-label': t('search'), 'data-help': t('helpSearch'), 'data-focus': 'search', oninput: (event) => { model.query = event.target.value.slice(0,200); resetFilter(); updateSelection(); clearTimeout(queryTimer); queryTimer = setTimeout(render, 130);shareView(180,{query:model.query,anchor:null,profileUserId:null}); } });
  const toolbar = el('div', { class: 'results-toolbar' }, el('label', { class: 'search-wrap' }, icon('search'), search),
    select((isFollowerView()?['anomalies','recent','name','handle']:['anomalies','recent', 'followersDesc', 'followersAsc', 'name', 'handle']).map((value) => [value, t(value)]), model.sort, (sort) => { model.sort = sort;resetListPosition=true;hideProfile();render();shareView(0,{sort,anchor:null,profileUserId:null}); }, t('sort'), { 'data-focus': 'sort',class:'select results-sort' }),
    button(t('importBackup'), chooseImport, {glyph:'upload',style:'small','data-testid':'toolbar-import',disabled:demo||taskRunning()||model.requestBusy,title:t('helpImport')}),
    button(t('backup'), exportData, {glyph:'download',style:'small','data-testid':'toolbar-export',disabled:demo||taskRunning()||model.requestBusy,title:t('helpBackup')}));
  const selection = el('div', { class: 'selected-controls' });
  selection.append(...selectionControls());
  const card = el('section', { class: 'results-card', 'aria-label': viewLabel(model.view), 'data-result-count': list.length }, toolbar, el('div', { class: `toolbar-count${model.selected.size ? ' has-selection' : ''}` }, el('span', {}, `${formatNumber(list.length)} ${t('results')}`), selection));
  if(isFollowerView()&&!list.length){
    const observation=followerObservation(a),pendingComparison=Boolean(observation&&['followersNew','followersLost'].includes(model.view));
    const unestablished=indexAccount().counts[model.view]===null,needFollowing=model.view==='followersOnly'&&!a?.lastScan?.complete,legacyNew=model.view==='followersNew'&&a?.followers&&!Array.isArray(a.followers.addedIds),firstNew=model.view==='followersNew'&&!model.query&&model.verificationFilter==='all'&&a?.followers?.comparisonAt===null&&Array.isArray(a.followers.addedIds);
    const title=pendingComparison?'followersObservationPendingTitle':unestablished?needFollowing?'followingBaselineNeeded':legacyNew?'followersNewUnavailable':'followersBaselineMissing':firstNew?'followersBaselineReady':'noResults';
    const description=pendingComparison?'followersObservationPendingHint':unestablished?needFollowing?'followingBaselineNeededHint':legacyNew?'followersNewUnavailableHint':'followersBaselineHint':firstNew?'followersFirstBaselineHint':model.query||model.verificationFilter!=='all'?'noResultsDesc':model.view==='followers'?'followersViewDesc':`${model.view}Desc`;
    if(unestablished)card.dataset.resultCount='unknown';
    card.querySelector('.toolbar-count>span').textContent=pendingComparison?t('observationPending'):unestablished?t('unestablished'):`${formatNumber(list.length)} ${t('results')}`;
    card.append(el('div',{class:'empty-state'},el('div',{class:'empty-symbol'},icon('all')),el('h2',{},t(title)),el('p',{class:'baseline-explanation'},t(description)),unestablished?button(t(needFollowing?'checkFollowing':'checkFollowers'),()=>requestQuickScan(needFollowing?'following':'followers'),{style:'primary',disabled:demo||taskRunning()||model.requestBusy||model.data.busyElsewhere}):null));return card;
  }
  if(a&&!a.lastScan?.complete&&isFollowingView()){
    card.querySelector('.toolbar-count>span').textContent=t('notChecked');
    card.dataset.resultCount='unknown';
    card.append(el('div',{class:'empty-state'},el('div',{class:'empty-symbol'},icon('scan')),el('h2',{},t('followingNotChecked')),el('p',{},t('followingNotCheckedHint')),button(t('checkFollowing'),()=>requestQuickScan('following'),{style:'primary',disabled:demo||taskRunning()||model.requestBusy||model.data.busyElsewhere})));return card;
  }
  if (!a || !list.length) {
    const baselineOnly = model.view === 'lost' && a?.baselineAt && a.baselineAt === a.lastScan?.finishedAt;
    const currentLostEmpty=Boolean(a&&model.view==='lost'&&!model.query&&model.verificationFilter==='all');
    const savedElsewhere = !a && Object.values(model.data.state.accounts).some(hasSavedAccount);
    card.append(el('div', { class: 'empty-state' }, el('div', { class: 'empty-symbol' }, icon(!a ? 'scan' : model.view)), el('h2', currentLostEmpty?{'data-help':t('lostStatsHelp'),tabindex:'0'}:{}, t(baselineOnly ? 'baselineReady' : currentLostEmpty?'lostEmptyCurrent':savedElsewhere ? 'accountNoSnapshot' : !a ? 'noData' : 'noResults')), currentLostEmpty&&!baselineOnly?null:el('p', { class: baselineOnly ? 'baseline-explanation' : '' }, t(baselineOnly ? 'firstScan' : savedElsewhere ? 'otherSnapshotsExist' : !a ? 'noDataDesc' : 'noResultsDesc')), baselineOnly ? button(t('viewNotFollowing'), () => navigate('notFollowing'), { style: 'primary', title: t('notFollowingDesc') }) : savedElsewhere ? button(t('viewSavedSnapshot'), () => { model.accountId=preferredAccountId(); navigate('all'); }, {style:'primary',title:t('otherSnapshotsExist'),'data-testid':'view-saved-snapshot'}) : !a ? button(t('importBackup'), chooseImport, {style:'primary',disabled:demo||taskRunning(),title:t('helpImport'),'data-testid':'upgrade-recovery'}) : null));
    return card;
  }
  const allCheck = el('input', { type: 'checkbox', 'aria-label': t('selectAllFiltered'), 'data-help': t('helpSelect'), 'data-focus': 'select-all', checked: model.selected.size === list.length, onchange: (event) => { model.selected = event.target.checked ? new Set(viewUsers().map(user => user.id)) : new Set(); updateSelection(); } });
  allCheck.indeterminate = model.selected.size > 0 && model.selected.size < list.length;
  const head = el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, allCheck), ...['account', 'followers', 'relation', 'detected', 'actions'].map((key) => el('th', { scope: 'col' }, t(key)))));
  const body = el('tbody');
  const viewport = el('div', { class: 'table-wrap', tabindex: '0', 'aria-label': t('continuousList') }, el('table', { 'aria-rowcount': list.length + 1 }, head, body));
  const range = el('span', { class: 'visible-range' });
  card.append(viewport, el('div', { class: 'table-bottom' }, el('span', {}, `${formatNumber(list.length)} ${t('results')}`), range));
  let first = -1, last = -1, frame;
  // Keep overlapping rows attached: scrolling must not manufacture hover/focus transitions.
  const rowNodes=new Map();
  const spacer=()=>el('tr',{class:'virtual-spacer','aria-hidden':'true'},el('td',{colspan:4}));
  const topSpacer=spacer(),bottomSpacer=spacer();body.append(topSpacer,bottomSpacer);
  const sizeSpacer=(node,height)=>{node.style.height=`${height}px`;node.firstElementChild.style.height=`${height}px`;};
  const draw = () => {
    frame = undefined;
    if (!viewport.isConnected) return;
    const visibleStart = Math.max(0, Math.min(list.length - 1, Math.floor(viewport.scrollTop / ROW_HEIGHT)));
    const visibleCount = Math.max(1, Math.ceil(Math.max(1, viewport.clientHeight - 32) / ROW_HEIGHT));
    const start = Math.max(0, visibleStart - OVERSCAN), end = Math.min(list.length, visibleStart + visibleCount + OVERSCAN);
    const rangeText=`${t('visibleRange')} ${formatNumber(visibleStart + 1)}–${formatNumber(Math.min(list.length, visibleStart + visibleCount))}`;
    if(range.textContent!==rangeText)range.textContent=rangeText;
    if (first === start && last === end) return;
    first = start; last = end;
    sizeSpacer(topSpacer,start*ROW_HEIGHT);sizeSpacer(bottomSpacer,(list.length-end)*ROW_HEIGHT);
    const slice=list.slice(start,end),wanted=new Set(slice.map(user=>user.id));
    for(const[id,node]of rowNodes)if(!wanted.has(id)){node.remove();rowNodes.delete(id);}
    let cursor=topSpacer.nextSibling;
    for(let index=0;index<slice.length;index++){
      const user=slice[index];let row=rowNodes.get(user.id);
      if(!row){row=renderRow(user);row.setAttribute('aria-rowindex',start+index+2);rowNodes.set(user.id,row);}
      if(row!==cursor)body.insertBefore(row,cursor);cursor=row.nextSibling;
    }
  };
  const scheduleDraw=()=>{if(frame===undefined)frame=requestAnimationFrame(draw);};
  let scrollIntent=false,scrollIntentTimer;
  const expireScrollIntent=(delay=500)=>{clearTimeout(scrollIntentTimer);scrollIntentTimer=setTimeout(()=>{if(viewport.isConnected&&pressedPointer!==null)expireScrollIntent();else scrollIntent=false;},delay);};
  const markScrollIntent=event=>{if(event.isTrusted){suppressProfileHover(event);scrollIntent=true;expireScrollIntent(1800);}};
  viewport.addEventListener('wheel',markScrollIntent,{passive:true});
  viewport.addEventListener('touchmove',markScrollIntent,{passive:true});
  viewport.addEventListener('pointerdown',event=>{const r=viewport.getBoundingClientRect();if(event.pointerType==='touch'||event.clientX>=r.left+viewport.clientLeft+viewport.clientWidth||event.clientY>=r.top+viewport.clientTop+viewport.clientHeight)markScrollIntent(event);});
  viewport.addEventListener('keydown',event=>{if(!['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)&&['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))markScrollIntent(event);});
  viewport.addEventListener('scrollend',()=>{if(pressedPointer===null){scrollIntent=false;clearTimeout(scrollIntentTimer);}});
  viewport.tabIndex=0;
  viewport.addEventListener('scroll', () => {if(!viewport.isConnected||virtualView?.viewport!==viewport)return;suppressProfileHover();if(scrollIntent){hideProfile();shareView(180,{anchor:sharedValue().anchor},viewScope());expireScrollIntent();}scheduleDraw();});
  const listAccountId = model.accountId;
  virtualView = { viewport, reflow:scheduleDraw,anchor: () => { const index = anchorIndex();return { accountId: listAccountId, id: list[index]?.id, offset: viewport.scrollTop % ROW_HEIGHT }; }, restore: anchor => { const index = anchor?.accountId === listAccountId ? list.findIndex(user => user.id === anchor.id) : -1; draw(); viewport.scrollTop = index < 0 ? 0 : index * ROW_HEIGHT + anchor.offset;draw(); } };
  function anchorIndex(){return Math.min(list.length-1,Math.floor(viewport.scrollTop/ROW_HEIGHT));}
  return card;
}
function selectionControls() {
  if (!model.selected.size) return [];
  const selected = viewUsers().filter(user => model.selected.has(user.id));
  const eligibleCount = selected.reduce((sum, user) => sum + Number(canAct(user)), 0);
  return [el('span', {}, `${t('selected')} ${formatNumber(model.selected.size)}`), button(t('clearSelection'), () => { model.selected.clear(); updateSelection(); }, { style: 'small ghost' }), button(t(model.view === 'ignored' ? 'restoreSelected' : 'ignoreSelected'), () => setIgnored([...model.selected], model.view !== 'ignored'), { style: 'small', disabled: taskRunning() || demo || model.requestBusy }), button(t('reviewNextBatch'), () => {
    const current = viewUsers().filter(user => model.selected.has(user.id)), eligibleUsers = current.filter(canAct);
    prepare(eligibleUsers.slice(0, 20), { selected: current.length, eligible: eligibleUsers.length });
  }, { style: 'small danger', disabled: !eligibleCount, title: t('helpBatch'), 'data-testid': 'review-batch' }), !eligibleCount ? button(t('actionHelp'),()=>showActionHelp(selected[0]),{style:'small ghost',title:t(actionBlock(selected[0])||'reviewBeforeSend'),'data-testid':'batch-action-reason'}) : null].filter(node => node !== null && node !== undefined);
}
function updateSelection() {
  const filtered = viewUsers(), currentIds = new Set(filtered.map(user => user.id));
  for (const id of model.selected) if (!currentIds.has(id)) model.selected.delete(id);
  const submitted = submittedSelections.get(model.accountId);
  if (submitted) for (const id of submitted.keys()) if (!model.selected.has(id)) submitted.delete(id);
  const selection = app.querySelector('.selected-controls');
  if (!selection) return;
  selection.replaceChildren(...selectionControls());
  app.querySelector('.toolbar-count')?.classList.toggle('has-selection', model.selected.size > 0);
  const all = app.querySelector('[data-focus=select-all]'), count = filtered.length;
  if (all) { all.checked = count > 0 && model.selected.size === count; all.indeterminate = model.selected.size > 0 && model.selected.size < count; }
  for (const row of app.querySelectorAll('tr[data-user-id]')) { const checked = model.selected.has(row.dataset.userId); row.classList.toggle('row-selected', checked); const box=row.querySelector('input[type=checkbox]');if(box)box.checked = checked; }
}
function relation(user) {
  if(user.followerStatus==='pending')return ['pendingFollowerStatus','unknown'];
  if (user.unavailable) return ['limited', 'unavailable'];
  if (user.following === false) return [user.followerStatus&&!account()?.users?.some(row=>row.id===user.id)?'youDoNotFollow':'noLongerFollowing', ''];
  if (user.followedBy === null || user.following === null) return ['notKnown', 'unknown'];
  if (user.followedBy === true) return ['followsYou', 'mutual'];
  return [user.lostAt ? 'lost' : 'doesNotFollow', user.lostAt ? 'lost' : 'not-following'];
}
function avatar(user, large = false) {
  const tone = Number(user.id.slice(-2)) % 4;
  const node=el('span', { class: `avatar tone${tone}${large ? ' large' : ''}`, 'aria-hidden': 'true' }, (user.name || user.handle || '?').trim().slice(0, 1).toLocaleUpperCase());
  try {const url=new URL(user.avatar);if(url.protocol==='https:'&&url.hostname==='pbs.twimg.com'&&!url.port&&!url.username&&!url.password&&url.pathname.startsWith('/profile_images/')){
    const img=el('img',{alt:'',crossorigin:'anonymous',referrerpolicy:'no-referrer',loading:'lazy',decoding:'async'});img.addEventListener('error',()=>img.remove(),{once:true});img.src=url.href;node.append(img);
  }}catch{}
  return node;
}
function verificationLabel(user) {
  return ({ Business: t('verifiedBusiness'), Government: t('verifiedGovernment'), Blue: t('blue') })[user.verificationType] || (user.blue ? t('blue') : '');
}
function verificationBadge(user) {
  const label = verificationLabel(user);
  return label ? el('span', { class: `verified ${['Business', 'Government'].includes(user.verificationType) ? 'verified-organization' : 'verified-blue'}`, 'data-help': label, 'aria-label': label }, user.verificationType === 'Business' ? 'B' : user.verificationType === 'Government' ? 'G' : '✓') : null;
}
function profileLink(user, suffix, label, attrs = {}) {
  if (!/^[A-Za-z0-9_]{1,15}$/.test(user.handle || '') || demo) return el('span', attrs, label);
  return el('a', { href: `https://x.com/${user.handle}${suffix}`, target: '_blank', rel: 'noopener noreferrer', 'data-help': t('helpOpenProfile'), ...attrs }, label);
}
function followerRelation(user){return [user.followerStatus==='missing'?(user.followerConfirmedAt?'followerConfirmedLost':'followerMissing'):({present:'followerPresent',pending:'pendingFollowerStatus',unavailable:'followerUnavailable'})[user.followerStatus]||'notKnown',user.followerStatus==='missing'?'lost':user.followerStatus==='unavailable'?'unavailable':user.followerStatus==='pending'?'unknown':''];}
function renderRow(user) {
  const [relationKey, relationStyle] = isFollowerView()?followerRelation(user):relation(user);
  const action = latestAction(user.id);
  const unresolved = action && ['pending', 'unknown'].includes(action.status);
  const name = el('button', { type: 'button', class: 'name-button', 'data-focus': `name-${user.id}`, 'aria-label': `${t('details')} ${user.name || user.handle}`, onclick: () => showProfile(user), onmouseenter: () => scheduleProfile(user), onmouseleave: () => scheduleHideProfile(650), onfocus: () => {if(!restoringFocus)showProfile(user);} }, user.name || user.handle || user.id);
  const rowActions = el('div', { class: 'row-actions' });
  if (unresolved) rowActions.append(button(t('resolve'), () => showActionHelp(user), { style: 'small', title:t('reasonUnresolved') }));
  else rowActions.append(unfollowControl(user));
  rowActions.append(button(t(model.view === 'ignored' ? 'restore' : 'ignore'), () => setIgnored([user.id], model.view !== 'ignored'), { style: 'small ghost', disabled: taskRunning() || demo }));
  const metric=isFollowerView()?`${t(user.followerMissingSince?'followerMissingSince':'followerLastSeen')} · ${date(user.followerMissingSince||user.followerLastSeenAt,true)}`:`${formatNumber(user.followers)} ${t('followers')}`;
  return el('tr', { class: `virtual-row${model.selected.has(user.id) ? ' row-selected' : ''}`, 'data-user-id': user.id }, el('td', {}, el('input', { type: 'checkbox', 'data-focus': `check-${user.id}`, 'aria-label': `${t('selected')} @${user.handle || user.id}`, 'data-help': t('helpSelect'), checked: model.selected.has(user.id), onchange: (event) => { event.target.checked ? model.selected.add(user.id) : model.selected.delete(user.id); updateSelection(); } })),
    el('td', {}, el('div', { class: 'account-cell', onmouseenter: () => scheduleProfile(user), onpointermove:event=>resumeProfileHover(user,event),onmouseleave: () => scheduleHideProfile(650) }, avatar(user), el('div', { class: 'user-main' }, el('div', { class: 'user-name' }, name, verificationBadge(user)), profileLink(user, '', user.handle ? `@${user.handle}` : user.id, { class: 'user-handle' }), el('div', { class: 'user-metrics' }, metric, user.lostAt ? el('span', { class: 'row-detected', 'data-help': `${t('detected')} · ${date(user.lostAt)}` }, ` · ${date(user.lostAt, true)}`) : null)))),
    el('td', { class: 'number-cell' }, formatNumber(user.followers)), el('td', {}, el('span', { class: `relation-chip ${relationStyle}` }, t(relationKey)), unresolved ? el('div', { class: 'row-meta' }, t(action.status === 'pending' ? 'pending' : 'unresolved')) : action?.status === 'failed' ? el('div', { class: 'row-meta' }, t('actionFailed')) : user.followingCount === 0 ? el('div', { class: 'row-meta' }, t('zeroFollowing')) : null), el('td', { class: 'date-cell', title: user.lostAt ? date(user.lostAt) : null }, date(user.lostAt, true)), el('td', {}, rowActions));
}
async function setIgnored(ids, ignored) {
  const currentIds = new Set(viewUsers().map(user => user.id));
  ids = ids.filter(id => currentIds.has(id));
  if (!ids.length) return;
  const ownerId = model.accountId;
  await perform(async () => { await api('IGNORE', { accountId: ownerId, ids, ignored }); if (model.accountId === ownerId) for (const id of ids) model.selected.delete(id); }, 'changed');
}
function download(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = el('a', { href: url, download: name });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
function exportData() { return perform(async () => {
  const data=await api('EXPORT_BACKUP');
  // Zero-member accounts are still real snapshots. Only a truly account-less
  // export is settings-only; do not make it look like a successful data backup.
  if (data?.accounts && Object.keys(data.accounts).length===0) {
    openDialog(t('emptyExportTitle'),[el('p',{'data-testid':'empty-export-guidance'},t('emptyExportBody'))],[button(t('exportSettingsOnly'),()=>{
      closeDialog();download(JSON.stringify(data),exportFileName('data').replace('-data-','-settings-'),'application/json');
    },{style:'primary','data-testid':'export-settings-only'})]);
    return;
  }
  download(JSON.stringify(data),exportFileName('data'),'application/json');
}); }
function acknowledgeWelcome() {
  if (demo || welcomeAcknowledging || model.data?.welcome?.seen !== false) return;
  welcomeAcknowledging = true;
  api('ACK_WELCOME').then(()=>{if(model.data)model.data.welcome={seen:true};}).catch(error=>notice(errorText(error.message,language),true,error.message)).finally(()=>{welcomeAcknowledging=false;});
}
function maybeShowWelcome() {
  if (demo || welcomeShown || dialog.open || taskRunning() || model.data?.welcome?.seen !== false) return;
  showWelcome(true);
}
function dismissWelcome() { acknowledgeWelcome();closeDialog(); }
function showWelcome(firstOpen = false) {
  welcomeShown = true;
  openDialog('嗨，见面啦 ❥(^_-)', [
    el('div',{class:'welcome-profile'},el('img',{src:'assets/author-avatar.jpg',class:'welcome-avatar',width:76,height:76,alt:'DimmensCK 的头像'}),el('div',{},el('strong',{class:'welcome-name'},'鲛鱼二娃（互关）'),el('a',{class:'welcome-handle',href:AUTHOR_URL,target:'_blank',rel:'noopener noreferrer'},'@DimmensCK'),el('span',{class:'welcome-author'},'X 关注小助手 · 作者 DimmensCK'))),
    el('div',{class:'welcome-letter','data-testid':'welcome-letter'},
      el('p',{},'谢谢你把这只小助手装进浏览器！它免费开源，下载、更新和问题反馈都在 ',el('a',{href:PROJECT_URL,target:'_blank',rel:'noopener noreferrer'},'GitHub'),'。'),
      el('p',{},'用着顺手的话，欢迎分享给朋友，记得带上作者 DimmensCK 的名字。也欢迎给仓库点亮一颗 Star，让埋头维护的我抬头看见小星星 ✨'),
      el('p',{},'更多有趣内容都在我的 X 主页 ',el('a',{href:AUTHOR_URL,target:'_blank',rel:'noopener noreferrer'},'@DimmensCK'),'。来关注、聊聊天，遇到喜欢的内容点点赞、收收藏。咱们一起浇个朋友！')),
    el('div',{class:'welcome-links'},el('a',{class:'button small',href:PROJECT_URL,target:'_blank',rel:'noopener noreferrer','data-testid':'welcome-github'},'去 GitHub 点颗星',icon('arrow')),el('a',{class:'button small',href:AUTHOR_URL,target:'_blank',rel:'noopener noreferrer','data-testid':'welcome-x'},'去 X 交朋友',icon('arrow')))
  ],[button('开始使用',dismissWelcome,{style:'primary','data-testid':'welcome-start',autofocus:true,'data-help':''})]);
  dialog.dataset.kind='welcome';
  dialog.dataset.firstOpen=String(firstOpen);
  dialog.setAttribute('lang','zh-CN');
  dialog.querySelector('.dialog-footer > .button:first-child')?.remove();
  const close=dialog.querySelector('.dialog-heading button');
  close?.setAttribute('aria-label','关闭');
  if(close){close.dataset.help='';close.removeEventListener('click',closeDialog);close.addEventListener('click',dismissWelcome);}
}
function closeDialog() { hideTutorial(); dialog.close(); dialog.dataset.kind = '';dialog.removeAttribute('lang');delete dialog.dataset.firstOpen; dialogCleanup(); dialogCleanup = () => {}; dialog.replaceChildren(); }
function openDialog(title, body, footer) {
  if (dialog.open) closeDialog();
  dialog.dataset.kind = '';
  hideProfile(); hideTutorial();
  dialog.replaceChildren(el('div', { class: 'dialog-body' }, el('div', { class: 'dialog-heading' }, el('h2', { id: 'dialog-title' }, title), button('', closeDialog, { glyph: 'close', style: 'icon ghost', title: t('close'), 'aria-label': t('close') })), ...body), el('div', { class: 'dialog-footer' }, button(t('cancel'), closeDialog), ...footer));
  dialog.setAttribute('aria-labelledby', 'dialog-title');
  dialog.showModal();
}
async function prepare(users, batch = null) {
  const currentIds = new Set(viewUsers().map(user => user.id));
  if (!users.length || users.length>20) return notice(t('selectedLimit'),true);
  if (!users.every(user=>currentIds.has(user.id))) return notice(t('selectionChanged'),true);
  const blocked=users.find(user=>!canAct(user));if(blocked)return showActionHelp(blocked);
  // Reconnect only on this explicit user action after a worker restart; never replay a send.
  ensureController();
  const ownerId = model.accountId;
  let prepared;
  if (demo) prepared = { token: 'demo', users, expiresAt: Date.now() + 60000 };
  else prepared = await perform(() => api('PREPARE_ACTION', { accountId: ownerId, ids: users.map((user) => user.id) }));
  if (!prepared?.token || !Array.isArray(prepared.users) || model.accountId !== ownerId) return;
  const owner = account();
  const exactUsers = prepared.users;
  const approved = el('input', { type: 'checkbox' });
  const execute = button(t('execute'), async () => {
    if (demo || !approved.checked || execute.disabled) return;
    ensureController();
    execute.disabled = true;
    const token = prepared.token;
    const receiptBaselines = exactUsers.map(user => [user.id, latestAction(user.id)?.id || null]);
    closeDialog();
    await perform(async () => { await api('EXECUTE_ACTION', { token }); if (!submittedSelections.has(ownerId)) submittedSelections.set(ownerId, new Map()); for (const [id, receiptId] of receiptBaselines) submittedSelections.get(ownerId).set(id, receiptId); }, 'actionStarted');
  }, { style: 'danger', disabled: true });
  const expired = el('p', {}, t('expires'));
  const confirmHint=el('p',{class:'confirm-hint',id:'confirm-hint'});
  execute.setAttribute('aria-describedby','confirm-hint');
  const updateButton = () => {
    const reason=demo?'demoConfirmDisabled':Date.now()>=prepared.expiresAt?'confirmExpired':model.accountId!==ownerId||!ownerMatches()?'confirmAccountChanged':taskRunning()?'reasonTaskRunning':!model.data.state.settings.enabled?'reasonDisabled':!approved.checked?'confirmCheckRequired':null;
    execute.disabled=Boolean(reason);confirmHint.textContent=t(reason||'confirmReady');
  };
  approved.addEventListener('change', updateButton);
  openDialog(t('prepareTitle'), [el('p', {}, t('prepareDescription')), batch ? el('div', { class: 'batch-summary' }, ...[['batchSelected', batch.selected], ['batchEligible', batch.eligible], ['batchNow', exactUsers.length], ['batchRemaining', Math.max(0, batch.selected - exactUsers.length)]].map(([key, count]) => el('div', { 'data-batch': key }, el('span', {}, t(key)), el('strong', {}, formatNumber(count)))), el('p', {}, t('batchManual'))) : null, el('div', { class: 'dialog-owner' }, `${t('prepareOwner')} · @${contextAccount()?.handle || owner?.handle || ownerId}`),
    el('p',{class:'confirm-relationship-note'},t('confirmRelationshipNote')),
    el('ul', { class: 'dialog-users' }, exactUsers.map((user) => el('li', {}, el('strong', {}, user.name || user.handle || user.id), el('span', { class: 'handle' }, `@${user.handle || user.id}`),el('span',{class:'confirm-relation'},t(relation(user)[0]))))),
    el('div', { class: 'risk-note' }, t('platformRisk')), el('p', {}, t('actionSafety')), demo ? el('div', { class: 'notice-inline' }, t('demoConfirmDisabled')) : null,
    el('label', { class: 'acknowledgment' }, approved, el('span', {}, t('acknowledge'))), confirmHint, expired], [execute]);
  updateButton();
  const timer = setInterval(() => { updateButton(); if (Date.now() >= prepared.expiresAt) expired.textContent = errorText('TOKEN_EXPIRED', language); }, 500);
  dialogCleanup = () => clearInterval(timer);
}
function renderData() {
  const stats = model.data.stats || {};
  const max = stats.maxBytes || stats.limitBytes || constants.MAX_BYTES;
  const fill = el('div', { class: 'meter-fill' }); fill.style.width = `${Math.min(100, (stats.bytes || 0) / max * 100)}%`;
  const storage = el('section', { class: 'data-card' }, el('h2', {}, t('privacyTitle')), el('p', {}, t('privacyDesc')), el('div', { class: 'storage-numbers' }, el('span', {}, `${t('used')} ${bytes(stats.bytes)}`), el('span', {}, `/ ${bytes(max)}`)), el('div', { class: 'meter' }, fill),
    stats.checkpointBytes>0?el('p',{class:'checkpoint-storage','data-testid':'checkpoint-storage'},`${t('checkpointStorage')} · ${bytes(stats.checkpointBytes)} / ${bytes(stats.checkpointLimitBytes||33554432)}`,el('span',{},` · ${t('checkpointStorageHint')}`)):null,
    el('div', { class: 'storage-breakdown' }, ...[['accounts', stats.accountCount ?? stats.accounts], ['records', stats.userCount ?? stats.users], ['events', stats.eventCount ?? stats.events]].map(([key, number]) => el('div', {}, el('b', {}, formatNumber(number || 0)), el('span', {}, t(key))))),
    el('div', { class: 'data-actions' }, button(t('backup'), exportData, { glyph: 'download', disabled: demo || taskRunning() }), button(t('importBackup'), chooseImport, { style:'primary',disabled: demo || taskRunning() }),button(t('removeAccount'),confirmRemove,{style:'danger',disabled:!canClearAccount(),'data-testid':'remove-account',title:t('removeText')})),
    el('div',{class:'csv-export'},el('p',{},t('csvSecondaryHint')),el('p',{class:'csv-scope'},`${viewLabel(model.lastResultsView)}${model.query?' · '+model.query:''}${model.verificationFilter!=='all'?' · '+t(model.verificationFilter==='blue'?'filterBlue':'filterStandard'):''}`),button(t('exportCSV'),()=>download(toCSV(selectUsers(account(),{view:model.lastResultsView,verificationFilter:model.verificationFilter,query:model.query,sort:model.sort})),exportFileName('table'),'text/csv;charset=utf-8'),{glyph:'download',style:'small ghost',disabled:!(indexAccount().counts[model.lastResultsView]>0),title:t('helpCSV')})),
    el('section', {class:'upgrade-help'},el('h3',{},t('upgradeTitle')),el('p',{},t('upgradeHelp')),el('p',{},t('upgradeTransfer')),el('div',{class:'instance-id'},el('span',{},t('installationId')),el('code',{},demo ? t('demoInstallation') : globalThis.chrome?.runtime?.id || t('installationUnavailable')))),
    el('div', { class: 'danger-zone' }, el('p', {}, t('removeText'))));
  const settings = el('section', { class: 'data-card' }, el('h2', {}, t('settings')),
      el('div', { class: 'settings-row' }, el('span', {}, t('language')), renderLanguageButtons()),
      el('div', { class: 'settings-row' }, el('span', {}, t('enabledHint')), el('input', { type: 'checkbox', checked: model.data.state.settings.enabled, 'aria-label': t('enabledHint'), 'data-help': t('enabledHint'), onchange: (event) => updateSetting({ enabled: event.target.checked }) })),
      el('div', { class: 'danger-zone' }, el('p', {}, t('author')), el('p', {}, t('version')), el('p', {}, t('notOfficial')), el('p', {}, `${t('baseline')} · ${date(account()?.baselineAt)}`)));
  const tabs = el('div', { class: 'data-tabs', role: 'tablist' }, [['storage', 'localStorage'], ['settings', 'settings'], ['unresolved', 'unresolvedActions']].map(([id, key]) => button(t(key), () => { model.dataTab = id; render();shareView(0,{dataTab:id}); }, { role: 'tab', 'aria-selected': model.dataTab === id, style: `small ${model.dataTab === id ? 'selected-tab' : 'ghost'}`, 'data-testid': `data-${id}`, title: id === 'unresolved' ? t('helpResolve') : id === 'storage' ? t('helpBackup') : t('helpLanguage') })));
  return el('div', { class: 'data-grid' }, tabs, el('div', { class: 'data-content' }, model.dataTab === 'settings' ? settings : model.dataTab === 'unresolved' ? renderUnresolved() : storage));
}
function showImportPreview(preview,filename) {
  const summary=preview.summary || {};
  const conflicts=Array.isArray(summary.conflicts)?summary.conflicts:[];
  const commitAllowed=preview.canCommit===true && typeof preview.token==='string' && preview.revision!==undefined && Number.isFinite(preview.expiresAt) && !conflicts.length;
  const importTime=value=>value?new Intl.DateTimeFormat(locale(),{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value)):'—';
  const commit=button(t('importConfirm'),async()=>{
    if (commit.disabled) return;
    closeDialog();await perform(()=>api('IMPORT_BACKUP',{token:preview.token,revision:preview.revision}),'imported');
  },{style:'primary',disabled:!commitAllowed||demo||taskRunning()});
  const status=el('p',{class:'import-status'},t(!commitAllowed?'importBlocked':'importPreviewExpiry'));
  openDialog(t('importTitle'),[el('p',{},t('importText')),el('p',{class:'mono'},filename),
    el('div',{class:'import-summary'},...['accountsTotal','addedUsers','restoredFollowingBaselines','addedFollowers','restoredFollowerBaselines','addedFollowerMissing','updatedFollowerMissing','preservedFollowerSnapshots','restoredFollowerObservations','preservedFollowerObservations','addedFollowerObservedUsers','addedEvents','addedHistory','updatedHistory','addedIgnored','addedActions','unresolvedCount'].filter(key=>!['restoredFollowingBaselines','addedFollowers','restoredFollowerBaselines','addedFollowerMissing','updatedFollowerMissing','preservedFollowerSnapshots','restoredFollowerObservations','preservedFollowerObservations','addedFollowerObservedUsers'].includes(key)||Number.isSafeInteger(summary[key])).map(key=>el('div',{'data-import-count':key},el('span',{},t(`import_${key}`)),el('strong',{},formatNumber(Number.isSafeInteger(summary[key])?summary[key]:0))))),
    el('p',{class:'import-settings'},t(summary.settings==='restored'?'importSettingsRestored':'importSettingsKept')),
    summary.activationRequired?el('div',{class:'notice-inline'},t('importActivationRequired')):null,
    ...(Array.isArray(summary.addedAccounts)&&summary.addedAccounts.length?[el('h3',{},t('importAddedAccounts')),el('ul',{class:'import-account-list'},summary.addedAccounts.map(item=>el('li',{},`@${item.handle||item.id} · ${formatNumber(item.users)} ${t('records')}`)))]:[]),
    ...(Array.isArray(summary.preservedAccounts)&&summary.preservedAccounts.length?[el('h3',{},t('importPreservedAccounts')),el('ul',{class:'import-account-list'},summary.preservedAccounts.map(item=>el('li',{},el('strong',{},`@${item.handle||item.id} · ${formatNumber(item.users)} ${t('records')}`),el('div',{},`${t('baseline')} · ${importTime(item.baselineBefore)} → ${importTime(item.baselineAfter)}`))))]:[]),
    conflicts.length?el('div',{class:'risk-note'},el('strong',{},t('importBlocked')),el('ul',{},conflicts.map(item=>el('li',{},errorText(String(item.code||'INVALID_BACKUP'),language),el('span',{class:'mono'},` · ${String(item.code||'INVALID_BACKUP')}${item.accountId?' · '+item.accountId:''}${item.userId?' · '+item.userId:''}`))))):null,
    el('p',{},`${t('used')} ${bytes(summary.bytes||0)} / ${bytes(summary.limitBytes||constants.MAX_BYTES)}`),status],[commit]);
  const update=()=>{const expired=Date.now()>=preview.expiresAt;commit.disabled=!commitAllowed||demo||taskRunning()||expired;if(expired)status.textContent=t('importPreviewExpired');};
  const timer=setInterval(update,500);dialogCleanup=()=>clearInterval(timer);update();
}
function renderUnresolved() {
  const a = account();
  const items = (a?.actions || []).filter((action) => ['pending', 'unknown'].includes(action.status));
  const authorPending=['pending','unknown'].includes(a?.authorFollow?.status);
  return el('section', { class: 'data-card unresolved-card' }, el('h2', {}, t('unresolvedActions')),authorPending?el('section',{class:'author-follow-unresolved','data-testid':'author-follow-unresolved'},el('h3',{},t('authorFollowPendingTitle')),el('p',{},t('authorFollowPendingHint')),el('div',{class:'row-meta'},`${t('unresolved')} · ${date(a.authorFollow.updatedAt)}`)):null,items.length?el('p', {}, t('unresolvedHint')):null, items.length ? el('ul', { class: 'unresolved-list' }, items.map((action) => {
    const user = getUser(a,action.userId);
    const handle = user?.handle || action.handle;
    return el('li', {}, el('div', {}, el('strong', {}, user?.name || action.name || (handle ? `@${handle}` : action.userId)), el('div', { class: 'row-meta' }, `${handle ? `@${handle} · ` : ''}ID ${action.userId}`), el('div', { class: 'row-meta' }, `${t(action.status === 'pending' ? 'pending' : 'unresolved')} · ${date(action.updatedAt)}`)), button(t('resolve'), () => resolveUser(user || { id: action.userId, handle }), { style: 'small', disabled: demo || taskRunning() || model.requestBusy || model.data.busyElsewhere, title: t(taskRunning()?'reasonTaskRunning':model.data.busyElsewhere?'busyElsewhere':'reasonUnresolved') }));
  })) : authorPending?null:el('p', {}, t('noUnresolved')));
}
function canClearAccount(){return Boolean(account())&&!demo&&!taskRunning()&&!model.requestBusy&&!model.data?.busyElsewhere&&!['pending','unknown'].includes(account()?.authorFollow?.status)&&!(account()?.actions||[]).some(action=>['pending','unknown'].includes(action.status));}
function confirmRemove() {
  const a = account();
  if (!canClearAccount()) return;
  const id = a.id;
  openDialog(t('removeTitle'), [el('div', { class: 'dialog-owner' }, `@${a.handle}`), el('p', {}, t('removeText'))], [button(t('removeConfirm'), () => { closeDialog(); perform(async () => { await api('REMOVE_ACCOUNT', { accountId: id }); model.accountId = ''; model.selected.clear(); }, 'removed'); }, { style: 'danger','data-testid':'remove-confirm' })]);
}
function clearProfileTimers() { clearTimeout(hideTimer); clearTimeout(hoverTimer); hideTimer = undefined; hoverTimer = undefined; }
function suppressProfileHover(event){clearProfileTimers();profileHoverBlocked=true;if(event?.isTrusted)lastListInputAt=performance.now();profileHoverPoint=Number.isFinite(event?.screenX)?{x:event.screenX,y:event.screenY}:lastPointerPoint;}
function resumeProfileHover(user,event){
  if(!profileHoverBlocked||!event.isTrusted||performance.now()-lastListInputAt<150)return;
  if(profileHoverPoint&&Math.hypot(event.screenX-profileHoverPoint.x,event.screenY-profileHoverPoint.y)<4)return;
  profileHoverBlocked=false;scheduleProfile(user);
}
function scheduleProfile(user) { clearProfileTimers(); if(!profilePinned&&!profileHoverBlocked)hoverTimer = setTimeout(() => {if(!profilePinned&&!profileHoverBlocked)showProfile(user,{pin:false});}, 380); }
function scheduleHideProfile(delay) {
  clearProfileTimers();
  if(!profilePinned)hideTimer=setTimeout(()=>{
    hideTimer=undefined;
    // The source stays fixed on screen while the host grows left; project the last physical point.
    const point=lastPointerPoint;
    const hit=point?document.elementFromPoint(point.clientX+innerWidth-point.width,point.clientY):null;
    const projectedId=hit?.closest('.account-cell')?.closest('[data-user-id]')?.dataset.userId;
    const hoveredId=app.querySelector('.account-cell:hover')?.closest('[data-user-id]')?.dataset.userId;
    const overCurrent=point?hit&&profile.contains(hit)||projectedId&&profileKey===`${model.accountId}:${projectedId}`:profile.matches(':hover')||hoveredId&&profileKey===`${model.accountId}:${hoveredId}`;
    if(profilePinned||overCurrent)return;
    hideProfile();
  },delay);
}
function hideProfile({share=true}={}) { clearProfileTimers();const wasOpen=!profile.hidden;if(wasOpen)profile.hidden = true;profilePreviewEpoch++;profileLayoutEpoch++;profileLayoutPending=false;profileLayoutAck=null;clearTimeout(profileLayoutTimer);profilePinned=false;profileKey = '';deferredProfile=null;if(wasOpen){requestPanelLayout();if(share)shareView(0,{profileUserId:null});} }
function currentProfileCache(user,key){let cached=profileCache.get(key);const receipt=latestAction(user.id);if(cached&&!cached.loading&&(Date.now()-(cached.at||0)>60000||cached.scanAt!==account()?.lastScan?.finishedAt||receipt?.status==='success'&&Number.isFinite(receipt.updatedAt)&&receipt.updatedAt>=(cached.observedAt||cached.requestStartedAt||0))){profileCache.delete(key);cached=null;}return cached;}
function showProfile(user,{read=true,share=true,pin=true}={}) {
  clearProfileTimers();
  profilePreviewEpoch++;
  profilePinned=pin;
  const key = `${model.accountId}:${user.id}`;
  profileKey = key;
  const cached=currentProfileCache(user,key);
  drawProfile(user, cached);
  if (read && !demo && ownerMatches() && !cached && !taskRunning()) loadProfile(user, key);
  if(share)shareView(0,{profileUserId:user.id},viewScope());
}
async function loadProfile(user, key) {
  if (demo || !ownerMatches() || taskRunning()) return;
  const requestStartedAt=Date.now();profileCache.set(key, { loading: true,requestStartedAt });
  try {
    const data = await api('PROFILE', { accountId: model.accountId, userId: user.id });
    const observedAt=Number.isFinite(data.observedAt)&&data.observedAt>=requestStartedAt&&data.observedAt<=Date.now()?data.observedAt:requestStartedAt;
    profileCache.set(key, { data, at: Date.now(),observedAt,requestStartedAt,scanAt: account()?.lastScan?.finishedAt });
  } catch (error) { profileCache.set(key, { failed: true, error: error.message, at: Date.now(), scanAt: account()?.lastScan?.finishedAt }); }
  while (profileCache.size > 80) profileCache.delete(profileCache.keys().next().value);
  if (profileKey === key){const current=profileUser(user.id)||user;drawProfile(current,currentProfileCache(current,key));}
}
function drawProfile(local, cached) {
  if(interactionActive()){deferredProfile={key:profileKey,local,cached};return;}
  local=profileUser(local.id)||local;cached=currentProfileCache(local,profileKey)||(cached?.loading?cached:null);
  const profileFocus=profile.contains(document.activeElement)?[...profile.querySelectorAll('button,a')].indexOf(document.activeElement):-1;
  const data = cached?.data;
  const live = data?.user || data?.profile;
  const user = { ...local, ...(live?.id === local.id ? live : {}) };
  const known = data?.knownFollowers || data?.known;
  const nativeKnown = Array.isArray(data?.user?.mutualFollowers) ? data.user.mutualFollowers : null;
  const restSuccess = known?.ok === true;
  const restUsers = restSuccess && Array.isArray(known.users) ? known.users : [];
  // REST carries a separately reported total. GraphQL names are examples only.
  const knownUsers = (restSuccess ? restUsers : nativeKnown || []).slice(0, 3);
  const exactKnownTotal = restSuccess && Number.isSafeInteger(known.total) && known.total >= 0 && known.total >= restUsers.length ? known.total : null;
  const knownBody = el('div', { class: 'profile-known-body' });
  if (cached?.loading) knownBody.append(t('loading'));
  else if (exactKnownTotal === 0 && knownUsers.length === 0) knownBody.append(el('div', { class: 'profile-known-summary' }, t('knownConfirmedZero')));
  else {
    if (exactKnownTotal !== null) knownBody.append(el('div', { class: 'profile-known-summary' }, `${t('knownTotal')} · ${formatNumber(exactKnownTotal)}`));
    else knownBody.append(el('div', { class: 'profile-known-summary' }, knownUsers.length ? t('knownTotalUnknown') : t('knownUnavailable')));
    if (knownUsers.length) knownBody.append(el('div', { class: 'profile-known-names' }, `${t('knownSamples')} · ${knownUsers.map((item) => item.name || `@${item.handle || item.screen_name || ''}`).join(' · ')}`));
  }
  const safeHandle = /^[A-Za-z0-9_]{1,15}$/.test(user.handle || '') ? user.handle : '';
  profile.replaceChildren(...[el('div', { class: 'profile-head' }, avatar(user, true), button(t('backToList'), hideProfile, { glyph: 'close', style: 'small ghost', title: t('backToList'), 'aria-label': t('backToList') })), el('h3', {}, user.name || user.handle || user.id), el('div', { class: 'profile-handle' }, safeHandle ? `@${safeHandle}` : user.id), el('div', { class: 'profile-bio' }, user.bio || t('bioEmpty')),
    el('div', { class: 'profile-flags' }, verificationBadge(user), el('span', { class: `relation-chip ${relation(local)[1]}` }, t(relation(local)[0]))),
    el('div',{class:'profile-evidence-date','data-evidence':'following'},`${t('followingEvidence')} · ${account()?.lastScan?.complete?date(account().lastScan.finishedAt):t('unestablished')}`),
    local.followerStatus?el('div',{class:'profile-follower-record'},el('span',{class:`relation-chip ${followerRelation(local)[1]}`},t(followerRelation(local)[0])),el('span',{'data-evidence':'followers'},`${t(local.followerObservationIncomplete?'followersObservationEvidence':'followersEvidence')} · ${date(local.followerObservedAt)}`),local.followerStatus==='missing'?el('span',{},`${t('followerMissingSince')} · ${date(local.followerMissingSince)}`):local.followerStatus==='unavailable'&&local.followerLastSeenAt?el('span',{},`${t('followerLastSeen')} · ${date(local.followerLastSeenAt)}`):null):null,
    el('div', { class: 'profile-counts' }, profileLink(user, '/followers', [el('b', {}, formatNumber(user.followers)), t('followers')]), profileLink(user, '/following', [el('b', {}, formatNumber(user.followingCount)), t('followingCount')])),
    Number.isFinite(local.lostAt) && local.lostAt > 0 ? el('div', { class: 'profile-detected' }, el('span', {}, t('detected')), el('time', { datetime: new Date(local.lostAt).toISOString() }, date(local.lostAt)), el('small', {}, t('profileLocal'))) : null,
    el('div', { class: 'profile-known' }, el('strong', {}, t('knownFollowers')), knownBody),
    el('div', { class: 'profile-source' }, cached?.failed ? errorText(cached.error, language) : data ? `${t('profileLive')} · ${date(cached.observedAt)}` : t('profileLocal')),
    el('div', { class: 'profile-controls' }, safeHandle && !demo ? el('a', { href: `https://x.com/${safeHandle}`, target: '_blank', rel: 'noopener noreferrer', class: 'button small' }, t('profile'), icon('arrow')) : null,
      button(t('refreshProfile'), () => { profileCache.delete(profileKey); loadProfile(local, profileKey); drawProfile(local, { loading: true }); }, { style: 'small ghost', disabled: demo || !ownerMatches() || taskRunning() || cached?.loading }),
      unfollowControl(local,user))].filter(node=>node!==null&&node!==undefined));
  const wasOpen=!profile.hidden;
  if(!wasOpen){profileLayoutEpoch++;profileLayoutPending=!demo&&window.top!==window;profileLayoutAck=null;profileResyncWidth=null;clearTimeout(profileLayoutTimer);if(profileLayoutPending){const epoch=profileLayoutEpoch;profileLayoutTimer=setTimeout(()=>{if(profileLayoutPending&&profileLayoutEpoch===epoch){hideProfile();notice(errorText('PANEL_LAYOUT_TIMEOUT',language),true,'PANEL_LAYOUT_TIMEOUT');}},2500);}}
  profile.hidden = false;if(!wasOpen)requestPanelLayout();else updateProfileLayout();
  if(profileFocus>=0)profile.querySelectorAll('button,a')[profileFocus]?.focus({preventScroll:true});
}

dialog.addEventListener('close', () => { dialogCleanup(); dialogCleanup = () => {}; });
dialog.addEventListener('cancel',event=>{if(dialog.dataset.kind==='welcome'){event.preventDefault();dismissWelcome();}});
profile.addEventListener('mouseenter', clearProfileTimers);
profile.addEventListener('mouseleave', () => scheduleHideProfile(500));
profile.addEventListener('focusin', clearProfileTimers);
profile.addEventListener('click', (event) => event.stopPropagation());
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideProfile(); });
document.addEventListener('click', (event) => { if (!profilePinned&&!profile.contains(event.target) && !event.target.closest('.name-button')) hideProfile(); });
if (!demo && globalThis.chrome?.runtime?.onMessage) chrome.runtime.onMessage.addListener((message,sender) => { if(typeof sender?.id!=='string'||!chrome.runtime.id||sender.id!==chrome.runtime.id||sender.tab)return;if (message?.type === 'UPDATE') refresh();if(message?.type==='SHARED_VIEW_CHANGED')applyShared(message.sharedView);if(message?.type==='PANEL_POINTER_OUTSIDE'&&message.panelInstance===panelInstance&&message.previewEpoch===profilePreviewEpoch&&Number.isFinite(message.observedAt)&&Math.abs(Date.now()-message.observedAt)<5000&&message.observedAt>lastPointerActivityAt&&!profile.hidden&&!profilePinned)hideProfile({share:false}); });
window.addEventListener('focus', () => { if(!document.hidden)claimShared();if (!dialog.open) refresh(); });
window.addEventListener('resize', () => { suppressProfileHover();updateProfileLayout();virtualView?.reflow(); });
setInterval(() => { if (!document.hidden && taskRunning()) refresh(); }, 2500);
if (demo) {
  model.data = createDemo(); model.data.state.settings.theme = 'dark'; model.accountId = connectedId(); model.tabId = '1'; language = model.data.state.settings.language; t = translator(language); render();
} else { renderBoot(); refresh(); }
