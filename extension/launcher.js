(() => {
  const lifecycleKey = '__xmhLauncherLifecycleV04';
  const hostId = 'xmh-launcher-root-v04';
  globalThis[lifecycleKey]?.dispose();
  let host, shadow, button, frame, timer, stopped = false, refreshing = false, panelRevision = 0, profileOpen = false, profileHeight = 0;
  let dragging = false, moved = false, startY = 0, fraction = 0.75, language = 'zh_CN';
  let previewEpoch=0,outsideSent=false;
  const cleanup = [];
  const reported = new Set();
  const labels = {
    zh_CN: ['X 关注小助手', '打开网页右侧关注管理面板。拖动可调整入口位置。'],
    en: ['X Follow Helper', 'Open the follow management panel on this page. Drag to move this button.'],
    ja: ['X フォローアシスタント', 'このページの右側にパネルを開きます。ドラッグで位置を変えられます。'],
    ko: ['X 팔로우 도우미', '이 페이지 오른쪽에 패널을 엽니다. 드래그하여 위치를 바꿀 수 있습니다.'],
  };
  function listen(target, type, callback) { target.addEventListener(type, callback); cleanup.push(() => target.removeEventListener(type, callback)); }
  function closePanel() { frame?.remove(); frame = null; profileOpen = false; profileHeight = 0; outsideSent=false; button?.setAttribute('aria-expanded', 'false'); }
  function dispose() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    for (const remove of cleanup.splice(0)) { try { remove(); } catch { /* A dead extension context needs no further calls. */ } }
    closePanel(); host?.remove(); host = button = shadow = null;
    if (globalThis[lifecycleKey]?.dispose === dispose) delete globalThis[lifecycleKey];
  }
  globalThis[lifecycleKey] = { dispose };
  function reportFailure(error, code) {
    const message = String(error?.message || error);
    if (/extension context invalidated/i.test(message)) { dispose(); return; }
    if (code === 'MESSAGE_FAILED' && /^(Could not establish connection\. Receiving end does not exist\.|The message port closed before a response was received\.)$/.test(message)) return;
    // Fixed codes keep unexpected failures visible without exposing page or response data.
    if (!reported.has(code)) { reported.add(code); console.warn(`[X Follow Helper launcher] ${code}`); }
  }
  async function send(message) {
    if (stopped) return null;
    try {
      if (!globalThis.chrome?.runtime?.id) { dispose(); return null; }
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      reportFailure(error, 'MESSAGE_FAILED');
      return null;
    }
  }
  function position() {
    if (button && !dragging) button.style.top = `${Math.max(8, Math.min(innerHeight - 70, fraction * innerHeight))}px`;
    if (frame) {
      const available = Math.max(1, innerWidth - 32);
      const docked = profileOpen && available >= 652;
      const width = Math.min(docked ? 952 : 620, available);
      frame.style.width = `${width}px`;
      // Clip the unused lower-left region so it cannot intercept the original page.
      // The detail column uses the same 280..320px contract as the dashboard.
      const leftColumn = Math.min(320, Math.max(280, width - 632)) + 12;
      const height = Math.min(profileHeight, Math.max(1, Math.min(1040, innerHeight - 32)));
      frame.style.clipPath = docked && profileHeight > 0
        ? `polygon(0 0, 100% 0, 100% 100%, ${leftColumn}px 100%, ${leftColumn}px ${height}px, 0 ${height}px)`
        : 'none';
      return { profileOpen, mode: !profileOpen ? 'closed' : docked ? 'docked' : 'exclusive', width,
        height: Math.max(1, Math.min(1040, innerHeight - 32)), profileHeight: docked ? height : 0 };
    }
    return null;
  }
  function pointerOutside(event) {
    if(!event.isTrusted||!frame||!profileOpen)return;
    const rect=frame.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;
    const docked=rect.width>=652,left=Math.min(320,Math.max(280,rect.width-632))+12;
    if(x>=0&&x<rect.width&&y>=0&&y<rect.height&&(!docked||x>=left||!profileHeight||y<profileHeight)){outsideSent=false;return;}
    if(outsideSent)return;
    outsideSent=true;
    const marker=frame.name,epoch=previewEpoch;
    void send({type:'PANEL_POINTER_OUTSIDE',panelInstance:marker,previewEpoch:epoch,observedAt:performance.timeOrigin+performance.now()}).then(result=>{
      if(frame?.name===marker&&previewEpoch===epoch&&result?.data!==true)outsideSent=false;
    });
  }
  function ensureHost() {
    if (stopped || host) return;
    const old = document.getElementById(hostId);
    if (old?.getAttribute('data-xmh-extension') === chrome.runtime.id) old.remove();
    host = document.createElement('div'); host.id = hostId;
    host.setAttribute('data-xmh-extension', chrome.runtime.id);
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = ':host{position:fixed;inset:0;z-index:2147483646;display:block;pointer-events:none;color:#fff;font:14px system-ui}button{position:fixed;right:20px;width:56px;height:56px;border:2px solid #3a3a3a;border-radius:20px;background:#242424;color:#fff;font:700 14px system-ui;cursor:pointer;box-shadow:0 6px 24px #0004;touch-action:none;pointer-events:auto}button[data-running=true]{border-color:#3a83f7}button:focus-visible{outline:3px solid #3a83f7;outline-offset:3px}iframe{position:fixed;top:16px;right:16px;width:min(620px,calc(100vw - 32px));height:min(1040px,calc(100vh - 32px));border:0;border-radius:0;background:transparent;pointer-events:auto;color-scheme:dark;z-index:1}';
    button = document.createElement('button'); button.type = 'button';
    button.textContent = '⇄'; button.setAttribute('aria-label', labels.zh_CN[0]);
    button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-expanded', 'false');
    shadow.append(style, button); document.documentElement.append(host);
    listen(button, 'pointerdown', event => { dragging = true; moved = false; startY = event.clientY; button.setPointerCapture(event.pointerId); });
    listen(button, 'pointermove', event => {
      if (!dragging || stopped) return;
      if (Math.abs(event.clientY - startY) > 5) moved = true;
      if (moved) { fraction = Math.max(0.1, Math.min(0.9, event.clientY / innerHeight)); button.style.top = `${Math.max(8, Math.min(innerHeight - 70, fraction * innerHeight))}px`; }
    });
    listen(button, 'pointerup', () => { dragging = false; if (moved) void send({ type: 'FLOAT_POSITION', y: fraction }); });
    listen(button, 'pointercancel', () => { dragging = false; moved = true; });
    listen(button, 'click', () => { if (!moved) void send({ type: 'OPEN_PANEL' }); moved = false; });
    position();
  }
  function openPanel() {
    if (stopped) return;
    ensureHost();
    if (!frame) {
      frame = document.createElement('iframe');
      // An instance marker prevents a late layout message targeting a replacement frame.
      // It is not an authentication secret; sender validation remains mandatory.
      frame.name = `xmh-${crypto.randomUUID()}`;
      frame.addEventListener('pointerenter',event=>{if(event.isTrusted)outsideSent=false;});
      frame.src = chrome.runtime.getURL('dashboard.html');
      frame.title = (labels[language] || labels.zh_CN)[0];
      frame.referrerPolicy = 'no-referrer';
      shadow.append(frame);
    }
    position();
    button.setAttribute('aria-expanded', 'true');
  }
  async function refresh() {
    if (stopped || refreshing) return;
    refreshing = true;
    const revision = panelRevision;
    try {
      const result = await send({ type: 'FLOAT_STATE' });
      if (stopped || result == null) return;
      if (result.ok !== true) { reportFailure(null, result.ok === false ? 'STATUS_REJECTED' : 'INVALID_STATUS'); return; }
      const { settings, lost, job, panelOpen } = result.data;
      language = settings.language; fraction = Number(settings.floatY) || 0.75;
      ensureHost(); position();
      const [label, explanation] = labels[language] || labels.zh_CN;
      button.title = explanation; button.setAttribute('aria-label', label);
      button.setAttribute('data-running', String(job?.running === true));
      button.textContent = job?.running ? (job.total ? `${Math.min(99, Math.round(job.done / job.total * 100))}%` : `${job.done}…`) : lost ? String(Math.min(lost, 999)) : '⇄';
      if (panelOpen && revision === panelRevision) openPanel();
    } catch (error) {
      reportFailure(error, 'REFRESH_FAILED');
    } finally { refreshing = false; }
  }
  const onMessage = (message, sender, respond) => {
    try {
      if (stopped || sender?.id !== chrome.runtime.id || sender.tab || !['OPEN_PANEL', 'CLOSE_PANEL', 'PANEL_LAYOUT'].includes(message?.type)) return false;
      if (message.type === 'PANEL_LAYOUT') {
        if (typeof message.profileOpen !== 'boolean') return false;
        if (!Number.isSafeInteger(message.previewEpoch) || message.previewEpoch < 0) return false;
        if (Object.hasOwn(message, 'profileHeight') && (!Number.isInteger(message.profileHeight) || message.profileHeight < 0 || message.profileHeight > 2000)) return false;
        if (!frame) { respond({ ok: false, error: 'PANEL_LAYOUT_UNAVAILABLE' }); return false; }
        if (message.panelInstance !== frame.name) { respond({ ok: false, error: 'PANEL_LAYOUT_UNAVAILABLE' }); return false; }
        if(previewEpoch!==message.previewEpoch||!message.profileOpen)outsideSent=false;
        previewEpoch=message.previewEpoch;
        profileOpen = message.profileOpen; profileHeight = message.profileOpen ? message.profileHeight ?? 0 : 0;
        respond({ ok: true, layout: position() });
        return false;
      }
      panelRevision++;
      if (message.type === 'OPEN_PANEL') openPanel(); else closePanel();
      respond({ ok: true });
    } catch (error) { reportFailure(error, 'PANEL_FAILED'); dispose(); }
    return false;
  };
  try {
    if (!globalThis.chrome?.runtime?.id) { dispose(); return; }
    chrome.runtime.onMessage.addListener(onMessage);
    cleanup.push(() => chrome.runtime.onMessage.removeListener(onMessage));
    ensureHost();
    listen(document, 'visibilitychange', () => { if (!document.hidden) void refresh(); });
    listen(document, 'pointermove', pointerOutside);
    listen(window, 'resize', position);
    listen(window, 'pagehide', event => { if (!event.persisted) dispose(); });
    timer = setInterval(() => { if (!document.hidden) void refresh(); }, 4000);
    void refresh();
  } catch (error) { reportFailure(error, 'START_FAILED'); dispose(); }
})();
