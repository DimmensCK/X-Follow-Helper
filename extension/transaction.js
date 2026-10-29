/* X Follow Helper • DimmensCK
 * Local protocol implementation adapted from MIT-licensed XClientTransaction
 * and twscrape. Copyright notices and licenses: THIRD-PARTY-NOTICES.txt.
 * Public static assets are parsed as data; downloaded JavaScript is never run.
 */
(() => {
  'use strict';
  if (Object.prototype.hasOwnProperty.call(window, '__XFH_TRANSACTION')) return;
  const EPOCH = 1682924400, MAX_ASSET_BYTES = 3 * 1024 * 1024;
  const nativeFetch = window.fetch.bind(window);
  let material = null, pending = null, generation = 0, failure = null, failedUntil = 0, captured = null;
  const error = code => { const value = new Error(code); value.code = code; throw value; };
  const byte = value => Number.isInteger(value) && value >= 0 && value <= 255;
  const signingName = value => /(?:^|\/)(?:ondemand\.s|sign\.o)[\w.-]*\.js$/.test(new URL(value).pathname);
  const entryName = value => /(?:^|\/)(?:entry-client|main)(?:[.-][\w.-]+)?\.js$/.test(new URL(value).pathname);
  function assetURL(value, base = location.href) {
    try {
      const url = new URL(value, base);
      return url.protocol === 'https:' && url.hostname === 'abs.twimg.com' && !url.port && !url.username && !url.password && !url.search && !url.hash
        && /^\/(?:responsive-web\/client-web|x-web)\/[A-Za-z0-9_./-]+\.js$/.test(url.pathname) ? url.href : null;
    } catch { return null; }
  }
  function parseIndices(text) {
    if (typeof text !== 'string' || text.length > MAX_ASSET_BYTES) error('transaction_indices_unavailable');
    const indices = [...text.matchAll(/\(\w\[(\d{1,2})\],\s*16\)/g)].map(match => Number(match[1]));
    if (indices.length < 2 || indices.length > 8) error('transaction_indices_unavailable');
    return indices;
  }
  function cubic(curves, time) {
    const [a,b,c,d] = curves;
    if (time <= 0) return (a > 0 ? b/a : b === 0 && c > 0 ? d/c : 0) * time;
    if (time >= 1) return 1 + (c < 1 ? (d-1)/(c-1) : c === 1 && a < 1 ? (b-1)/(a-1) : 0) * (time-1);
    const calculate = (x,y,m) => 3*x*(1-m)*(1-m)*m + 3*y*(1-m)*m*m + m*m*m;
    let start=0,end=1,mid=0;
    for(let i=0;i<64&&start<end;i++) { mid=(start+end)/2;const x=calculate(a,c,mid);if(Math.abs(time-x)<0.00001)break;if(x<time)start=mid;else end=mid; }
    return calculate(b,d,mid);
  }
  function roundEven(value) {
    const lower=Math.floor(value),fraction=value-lower;
    return fraction === 0.5 ? lower%2 === 0 ? lower : lower+1 : Math.round(value);
  }
  function animationKey(keyBytes, framePaths, indices) {
    if (!Array.isArray(keyBytes) || keyBytes.length < 16 || keyBytes.length > 128 || !keyBytes.every(byte)
      || !Array.isArray(indices) || indices.length < 2 || indices.length > 8 || !indices.every(i=>Number.isInteger(i)&&i>=0&&i<keyBytes.length)
      || !Array.isArray(framePaths) || !framePaths.length || framePaths.length > 16) error('transaction_data_unavailable');
    const path=framePaths[keyBytes[5]%framePaths.length];
    if(typeof path!=='string'||path.length>32768)error('transaction_data_unavailable');
    const rows=path.trim().slice(9).split('C').map(part=>(part.match(/\d+/g)||[]).map(Number));
    const row=rows[keyBytes[indices[0]]%16];
    if(!row||row.length!==11||!row.every(byte))error('transaction_data_unavailable');
    const frameTime=Math.round(indices.slice(1).reduce((time,index)=>time*(keyBytes[index]%16),1)/10)*10;
    const curves=row.slice(7).map((value,i)=>{const min=i%2?-1:0;return Math.round((value*(1-min)/255+min)*100)/100;});
    const progress=cubic(curves,frameTime/4096);
    const color=row.slice(0,3).map((value,i)=>roundEven(Math.max(0,Math.min(255,value*(1-progress)+row[i+3]*progress))).toString(16));
    const angle=Math.floor(row[6]*300/255+60)*progress*Math.PI/180;
    const matrix=[Math.cos(angle),-Math.sin(angle),Math.sin(angle),Math.cos(angle)].map(value=>Math.abs(Math.round(value*100)/100).toString(16));
    return [...color,...matrix,'0','0'].join('').replace(/[.-]/g,'');
  }
  async function encode(keyBytes, key, method, pathname, epochSeconds, nonce) {
    if (!Array.isArray(keyBytes) || keyBytes.length < 16 || keyBytes.length > 128 || !keyBytes.every(byte)
      || typeof key !== 'string' || !/^[a-fA-F0-9]{1,256}$/.test(key)
      || typeof method !== 'string' || !/^(GET|POST)$/i.test(method) || typeof pathname !== 'string'
      || !/^\/i\/api\/[A-Za-z0-9_./-]{1,500}$/.test(pathname)
      || !Number.isSafeInteger(epochSeconds) || epochSeconds < EPOCH || epochSeconds - EPOCH > 0xffffffff || !byte(nonce)) error('transaction_input_invalid');
    const time=epochSeconds-EPOCH;
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${method.toUpperCase()}!${pathname}!${time}obfiowerehiring${key}`)));
    const payload=[...keyBytes,...Array.from({length:4},(_,i)=>(time>>>(i*8))&255),...digest.slice(0,16),3];
    return btoa(String.fromCharCode(nonce,...payload.map(value=>value^nonce))).replace(/=+$/,'');
  }
  function capturePublicData() {
    const encoded=document.querySelector('meta[name="twitter-site-verification"]')?.getAttribute('content');
    const framePaths=[...document.querySelectorAll('svg[id^="loading-x-anim"] g:first-child path:nth-child(2)')].slice(0,17).map(node=>node.getAttribute('d'));
    // The supported native animation has four frames. A partially parsed DOM
    // must not silently change the modulo base and produce a plausible bad ID.
    if(typeof encoded==='string'&&encoded.length<=256&&framePaths.length===4&&framePaths.every(value=>typeof value==='string'&&value.length<=32768)){
      if(!captured||captured.encoded!==encoded){failure=null;failedUntil=0;}
      captured={encoded,framePaths};return captured;
    }
    if(captured&&(!encoded||encoded===captured.encoded))return captured;
    error('transaction_data_unavailable');
  }
  function publicInputs() {
    const {encoded,framePaths}=capturePublicData();
    if(typeof encoded!=='string'||encoded.length>256||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))error('transaction_data_unavailable');
    let keyBytes;try{keyBytes=Array.from(atob(encoded),value=>value.charCodeAt(0));}catch{error('transaction_data_unavailable');}
    const urls=[];
    const add=value=>{const url=assetURL(value);if(url&&!urls.includes(url)&&urls.length<96)urls.push(url);};
    for(const item of (performance.getEntriesByType?.('resource')||[]).slice(-512).reverse())add(item.name);
    for(const node of [...document.querySelectorAll('script[src], link[rel="modulepreload"][href], link[rel="preload"][as="script"][href]')].slice(0,128))add(node.getAttribute('src')||node.getAttribute('href'));
    // Legacy webpack exposes its static name/hash maps inline. Read only enough
    // to locate ondemand.s; do not execute a bootstrap or inspect account state.
    for(const node of [...document.querySelectorAll('script:not([src])')].slice(0,24)){
      const text=node.textContent;if(typeof text!=='string'||text.length>1024*1024||!text.includes('ondemand.s'))continue;
      const name=/(\d+):"ondemand\.s"/.exec(text);
      if(name){const hash=new RegExp(`${name[1]}:"([0-9a-f]{7}|[0-9a-f]{16})"`).exec(text);if(hash)add(`https://abs.twimg.com/responsive-web/client-web/ondemand.s.${hash[1]}a.js`);}
    }
    if(!urls.length)error('transaction_assets_unavailable');
    return {encoded,keyBytes,framePaths,urls};
  }
  async function loadAsset(url, signal) {
    if(!assetURL(url))error('transaction_asset_rejected');
    const response=await nativeFetch(url,{method:'GET',credentials:'omit',cache:'force-cache',redirect:'error',referrerPolicy:'no-referrer',signal});
    if(!response.ok)error('transaction_assets_unavailable');
    if(Number(response.headers.get('content-length'))>MAX_ASSET_BYTES)error('transaction_asset_too_large');
    const reader=response.body?.getReader();if(!reader)error('transaction_assets_unavailable');
    const chunks=[];let size=0;
    try{for(;;){const{done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_ASSET_BYTES){void reader.cancel().catch(()=>{});error('transaction_asset_too_large');}chunks.push(value);}}
    finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const value of chunks){bytes.set(value,offset);offset+=value.length;}return new TextDecoder().decode(bytes);
  }
  async function prepare(inputs) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    try{
      // Resource timing is newest-first. Unrelated late chunks must not evict
      // the observed entry bundle that imports the not-yet-loaded sign module.
      const direct=inputs.urls.filter(signingName),entries=inputs.urls.filter(url=>!signingName(url)&&entryName(url)),others=inputs.urls.filter(url=>!signingName(url)&&!entryName(url));
      const candidates=[...direct,...entries,...others].slice(0,12);
      let fetches=0;
      for(const url of candidates){
        if(++fetches>12)break;
        let text;try{text=await loadAsset(url,controller.signal);}catch(cause){if(controller.signal.aborted)throw cause;continue;}
        if(signingName(url)){const indices=parseIndices(text);return {encoded:inputs.encoded,keyBytes:inputs.keyBytes,key:animationKey(inputs.keyBytes,inputs.framePaths,indices)};}
        const match=/(?:\.{0,2}\/)?[\w./-]*?\b(?:ondemand\.s|sign\.o)[\w.-]*\.js/.exec(text);
        const sign=match&&assetURL(match[0],url);
        if(sign&&++fetches<=12){const body=await loadAsset(sign,controller.signal),indices=parseIndices(body);return {encoded:inputs.encoded,keyBytes:inputs.keyBytes,key:animationKey(inputs.keyBytes,inputs.framePaths,indices)};}
      }
      error('transaction_indices_unavailable');
    }finally{clearTimeout(timer);}
  }
  async function generate(method, pathname) {
    const owner=generation;
    try{
      const encoded=document.querySelector('meta[name="twitter-site-verification"]')?.getAttribute('content')||captured?.encoded;
      if(material?.encoded!==encoded)material=null;
      if(!material){
        if(Date.now()<failedUntil)return {ok:false,code:failure||'transaction_data_unavailable'};
        if(!pending){pending=prepare(publicInputs()).then(value=>{if(owner!==generation)error('transaction_context_changed');material=value;failure=null;failedUntil=0;return value;}).finally(()=>{if(owner===generation)pending=null;});}
        await pending;
      }
      if(owner!==generation||!material)error('transaction_context_changed');
      const current=material;
      const nonce=crypto.getRandomValues(new Uint8Array(1))[0];
      const value=await encode(current.keyBytes,current.key,method,pathname,Math.floor(Date.now()/1000),nonce);
      if(owner!==generation)error('transaction_context_changed');
      return {ok:true,value};
    }catch(cause){const code=/^transaction_[a-z_]+$/.test(cause?.code||'')?cause.code:'transaction_assets_unavailable';if(owner===generation){failure=code;failedUntil=Date.now()+60000;}return {ok:false,code};}
  }
  const api=Object.freeze({build:1,generate,animationKey,encode,parseIndices,assetURL,
    invalidate(){generation++;material=null;pending=null;failure=null;failedUntil=0;},
    status(){return {build:1,state:material?'ready':pending?'preparing':failure?'unavailable':'idle',reason:failure};}});
  Object.defineProperty(window,'__XFH_TRANSACTION',{value:api,writable:false,configurable:false,enumerable:false});
  // The site's startup animation may disappear after hydration. Preserve only
  // these public signing inputs in this document, with a bounded startup watch.
  try{capturePublicData();}catch{
    if(typeof MutationObserver==='function'){
      let timer;const watch=new MutationObserver(()=>{try{capturePublicData();watch.disconnect();clearTimeout(timer);}catch{}});
      watch.observe(document,{childList:true,subtree:true});timer=setTimeout(()=>watch.disconnect(),30000);
    }
  }
})();
