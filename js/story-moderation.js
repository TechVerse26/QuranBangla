/* ============================================================================
   js/story-moderation.js — কুরআন বাংলা ওয়েবসাইটের Story/Status মডারেশন (ক্লায়েন্ট)

   শুধু ওয়েবসাইটে চলে (Android অ্যাপে Story ফিচার নেই — সেখানে এই ফাইল কিছুই করে না)।

   ব্রাউজার আর সরাসরি `statuses` কালেকশনে লিখতে পারে না (firestore.rules)। প্রতিটা স্লাইড
   POST /api/story-submit-এ যায়; সার্ভার যাচাই + AI মডারেশন করে সিদ্ধান্ত জানায়:
     approved         → প্রকাশিত হয়েছে
     rejected         → প্রকাশ হয়নি (কোন নীতিমালা লঙ্ঘিত তা সহ), সম্পাদনা করে আবার জমা দেওয়া যাবে
     review_required  → অ্যাডমিনের অনুমোদনের অপেক্ষায়, ততক্ষণ প্রাইভেট
     pending          → AI এই মুহূর্তে অনুপলব্ধ, কিছুক্ষণ পর আবার চেষ্টা করুন

   এই ফাইল সিদ্ধান্ত নেয় না — শুধু সার্ভারের ফলাফল দেখায়। দেখানো লেখাগুলো সার্ভারের ঠিক করা
   নির্দিষ্ট বার্তা (কাঁচা AI আউটপুট কখনোই আসে না)। সব টেক্সট textContent দিয়ে বসানো হয়, তাই
   কোনো ইনজেকশনের সুযোগ নেই।

   window.StoryModeration:
     requestIdFor(slide) / resetRequestId(slide)  কনটেন্ট-বাঁধা idempotency কী (একই স্লাইড আবার পাঠালে ডুপ্লিকেট হয় না)
     submit(story, requestId, opts) → Promise<result>
     progress.show(text) / progress.hide()
     phaseText(phase, i, n)
     showResults(items, handlers)   ফলাফল শীট
     setSlideNote(slide, out) / renderSlideBanner()
     watchAdd(uid, ids) / watchRemove(uid, id) / checkWatch({onApproved})
   ============================================================================ */
(function(){
  'use strict';

  // Stories are a website-only feature. In the Android app shell this file is inert.
  if (window.QR_PLATFORM && window.QR_PLATFORM.isApp) {
    window.StoryModeration = { disabled: true };
    return;
  }

  var ENDPOINT = '/api/story-submit';
  var REQUEST_TIMEOUT_MS = 45000;
  var MAX_BUSY_POLLS = 8;
  var WATCH_KEY = 'qr_story_watch_v1';
  var WATCH_TTL_MS = 14 * 24 * 60 * 60 * 1000;

  function bn(n){ return (typeof toBn === 'function') ? toBn(n) : String(n); }
  function el(tag, cls, text){
    var e = document.createElement(tag);
    if(cls) e.className = cls;
    if(text != null) e.textContent = text;
    return e;
  }
  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

  // ---------------------------------------------------------------- idempotency keys
  function fnv(str){
    var h = 0x811c9dc5;
    for(var i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(16);
  }
  function newId(){
    var a = new Uint8Array(16);
    if(window.crypto && crypto.getRandomValues) crypto.getRandomValues(a);
    else for(var i = 0; i < 16; i++) a[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(a, function(b){ return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  // Signature of the slide's CONTENT. Same content → same request id (a retry after a network failure is deduplicated by
  // the server); edited content → a fresh id (so an edited, previously rejected story is moderated again).
  function slideSignature(s){
    var big = function(v){ return v ? (String(v).length + ':' + fnv(String(v))) : ''; };
    return fnv(JSON.stringify([
      s.mode, s.textValue || '', s.bg || '', s.fontIndex || 0, s.align || '', s.size || 0, s.textColor || '', !!s.highlight,
      big(s.imageRawDataUrl), s.filterId || '', s.frameAspect || '', JSON.stringify(s.crop || null), JSON.stringify(s.textOverlays || []),
      big(s.voiceData), big(s.musicData), s.musicTrackId || ''
    ]));
  }
  function requestIdFor(slide){
    var sig = slideSignature(slide);
    if(!slide._modReq || slide._modReq.sig !== sig) slide._modReq = { sig: sig, id: newId() };
    return slide._modReq.id;
  }
  function resetRequestId(slide){
    slide._modReq = { sig: slideSignature(slide), id: newId() };
    return slide._modReq.id;
  }

  // ---------------------------------------------------------------- network
  function getIdToken(force){
    try{
      var u = (typeof fbAuth !== 'undefined' && fbAuth) ? fbAuth.currentUser : null;
      if(!u) return Promise.resolve(null);
      return u.getIdToken(!!force).catch(function(){ return null; });
    }catch(e){ return Promise.resolve(null); }
  }

  function postJson(body, token){
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = setTimeout(function(){ if(ctrl) ctrl.abort(); }, REQUEST_TIMEOUT_MS);
    return fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(j){ return { status: r.status, json: j }; });
    }).then(function(x){ clearTimeout(timer); return x; }, function(e){ clearTimeout(timer); throw e; });
  }

  // ---------------------------------------------------------------- result objects (all texts are fixed Bengali strings)
  var FIELD_MSG = {
    text: 'লেখাটি গ্রহণযোগ্য নয় — ৭০০ অক্ষরের মধ্যে লিখুন।',
    imageData: 'ছবিটি গ্রহণযোগ্য নয়। JPEG, PNG বা WebP ছবি ব্যবহার করুন এবং সাইজ ছোট রাখুন।',
    audioData: 'অডিওটি গ্রহণযোগ্য নয়। অন্য একটি অডিও ব্যবহার করুন।',
    audioDuration: 'অডিওর দৈর্ঘ্য সঠিক নয়।',
    type: 'স্টোরির ধরন সঠিক নয়।'
  };
  function res(status, title, message, extra){
    return Object.assign({ status: status, title: title, message: message, guideline: null, retryable: false, fatal: false }, extra || {});
  }
  function waitText(sec){
    if(!sec || sec < 60) return 'কিছুক্ষণ পর';
    var m = Math.ceil(sec / 60);
    return m >= 60 ? 'প্রায় ' + bn(Math.ceil(m / 60)) + ' ঘণ্টা পর' : 'প্রায় ' + bn(m) + ' মিনিট পর';
  }
  var R = {
    network: function(){ return res('error', 'পাঠানো যায়নি', 'ইন্টারনেট সংযোগ পরীক্ষা করে আবার চেষ্টা করুন। আপনার লেখা/ছবি সংরক্ষিত আছে।', { retryable: true, fatal: true }); },
    auth: function(){ return res('error', 'সেশন শেষ হয়ে গেছে', 'অনুগ্রহ করে আবার সাইন ইন করে চেষ্টা করুন।', { fatal: true }); },
    busy: function(){ return res('error', 'যাচাই চলছে', 'স্টোরিটি এখনো যাচাই হচ্ছে। একটু পর আবার চেষ্টা করুন — ডুপ্লিকেট হবে না।', { retryable: true, fatal: true }); },
    blocked: function(){ return res('blocked', 'স্টোরি পোস্ট করা যাচ্ছে না', 'আপনার অ্যাকাউন্টে বর্তমানে স্টোরি পোস্ট করার সুযোগ সীমিত রয়েছে।', { fatal: true }); },
    server: function(){ return res('error', 'এই মুহূর্তে পাঠানো যায়নি', 'সার্ভারে সাময়িক সমস্যা হচ্ছে। কিছুক্ষণ পর আবার চেষ্টা করুন। আপনার লেখা/ছবি সংরক্ষিত আছে।', { retryable: true, fatal: true }); },
    rate: function(j){
      var cool = j && j.reason === 'cooldown';
      var daily = j && j.reason === 'daily';
      var msg = cool ? 'বারবার অননুমোদিত স্টোরি জমা দেওয়ায় সাময়িকভাবে নতুন স্টোরি নেওয়া বন্ধ আছে। ' + waitText(j && j.retryAfterSec) + ' আবার চেষ্টা করুন।'
        : daily ? 'আজকের জন্য স্টোরি জমা দেওয়ার সীমা শেষ হয়েছে। আগামীকাল আবার চেষ্টা করুন।'
        : 'অল্প সময়ে অনেক স্টোরি জমা দেওয়া হয়েছে। ' + waitText(j && j.retryAfterSec) + ' আবার চেষ্টা করুন।';
      return res('rate_limited', 'একটু ধীরে চলুন', msg, { fatal: true });
    },
    invalid: function(j){ return res('invalid', 'স্টোরিটি পাঠানো যায়নি', FIELD_MSG[j && j.field] || 'স্টোরির কনটেন্ট গ্রহণযোগ্য নয়। পরিবর্তন করে আবার চেষ্টা করুন।'); }
  };
  function normalize(j){
    return {
      status: j.status, title: j.title || '', message: j.message || '', guideline: j.guideline || null,
      retryable: !!j.retryable, fatal: false, statusId: j.statusId || null, submissionId: j.submissionId || null
    };
  }

  // ---------------------------------------------------------------- submit one slide
  // story: the payload built by js/status.js (type/text/bg/…/imageData/audioData). The server decides everything.
  async function submit(story, requestId, opts){
    opts = opts || {};
    var id = requestId, busyPolls = 0, refreshed = false, regenerated = false;
    for(;;){
      var token = await getIdToken(refreshed);
      if(!token) return R.auth();
      if(opts.onPhase) opts.onPhase('check');
      var phaseTimer = opts.onPhase ? setTimeout(function(){ opts.onPhase('ai'); }, 900) : null;
      var r;
      try{
        r = await postJson({ action: 'submit', requestId: id, story: story }, token);
      }catch(e){
        clearTimeout(phaseTimer);
        return R.network();
      }
      clearTimeout(phaseTimer);
      var j = r.json || {};
      if(r.status === 200 && j.ok) return normalize(j);
      if(r.status === 401){ if(!refreshed){ refreshed = true; continue; } return R.auth(); }
      if(r.status === 409 && j.error === 'in_progress'){
        if(busyPolls < MAX_BUSY_POLLS){ busyPolls++; await sleep((j.retryAfterSec || 3) * 1000); continue; }
        return R.busy();
      }
      if(r.status === 409 && j.error === 'request_conflict' && !regenerated && opts.regenerate){ regenerated = true; id = opts.regenerate(); continue; }
      if(r.status === 429) return R.rate(j);
      if(r.status === 400) return R.invalid(j);
      if(r.status === 403 && j.error === 'account_blocked') return R.blocked();
      return R.server();
    }
  }

  // ---------------------------------------------------------------- progress pill ("Checking your Story…" → "AI moderation in progress…")
  var progressEl = null;
  function phaseText(phase, i, n){
    var base = phase === 'ai' ? 'AI মডারেশন চলছে...' : 'আপনার স্টোরি যাচাই করা হচ্ছে...';
    return n > 1 ? bn(i + 1) + '/' + bn(n) + ' · ' + base : base;
  }
  function progressShow(text){
    if(!progressEl){
      progressEl = el('div', 'smod-progress');
      progressEl.setAttribute('role', 'status');
      progressEl.setAttribute('aria-live', 'polite');
      var sp = el('span', 'smod-spin'); sp.setAttribute('aria-hidden', 'true');
      progressEl.appendChild(sp);
      progressEl.appendChild(el('span', 'smod-progress-text'));
      document.body.appendChild(progressEl);
    }
    progressEl.querySelector('.smod-progress-text').textContent = text;
    progressEl.classList.add('show');
  }
  function progressHide(){ if(progressEl) progressEl.classList.remove('show'); }

  // ---------------------------------------------------------------- result sheet
  var TONE = {
    approved: { icon: 'fa-circle-check', cls: 'ok' },
    review_required: { icon: 'fa-hourglass-half', cls: 'wait' },
    pending: { icon: 'fa-arrows-rotate', cls: 'wait' },
    rejected: { icon: 'fa-shield-halved', cls: 'bad' },
    rate_limited: { icon: 'fa-clock', cls: 'wait' },
    invalid: { icon: 'fa-circle-exclamation', cls: 'bad' },
    blocked: { icon: 'fa-ban', cls: 'bad' },
    error: { icon: 'fa-wifi', cls: 'wait' }
  };
  var CHIP = {
    approved: 'প্রকাশিত', review_required: 'রিভিউয়ের অপেক্ষায়', pending: 'আবার চেষ্টা করুন', rejected: 'অনুমোদিত হয়নি',
    rate_limited: 'পাঠানো হয়নি', invalid: 'পাঠানো হয়নি', blocked: 'পাঠানো হয়নি', error: 'পাঠানো হয়নি'
  };
  function toneOf(status){ return TONE[status] || TONE.error; }

  var sheetState = null; // { scrim, sheet, prevFocus, onKey, handlers }

  function closeSheet(silent){
    if(!sheetState) return;
    var s = sheetState; sheetState = null;
    document.removeEventListener('keydown', s.onKey, true);
    if(s.scrim.parentNode) s.scrim.parentNode.removeChild(s.scrim);
    if(s.sheet.parentNode) s.sheet.parentNode.removeChild(s.sheet);
    try{ if(s.prevFocus && s.prevFocus.focus) s.prevFocus.focus(); }catch(e){}
    if(!silent && s.handlers && typeof s.handlers.onClose === 'function') s.handlers.onClose();
  }

  function overallStatus(items){
    var order = ['rejected', 'invalid', 'blocked', 'error', 'rate_limited', 'pending', 'review_required', 'approved'];
    for(var i = 0; i < order.length; i++){
      if(items.some(function(it){ return it.out.status === order[i]; })) return order[i];
    }
    return 'error';
  }
  function summaryTitle(items){
    var c = { ok: 0, review: 0, bad: 0, retry: 0 };
    items.forEach(function(it){
      var s = it.out.status;
      if(s === 'approved') c.ok++;
      else if(s === 'review_required') c.review++;
      else if(s === 'rejected') c.bad++;
      else c.retry++;
    });
    var parts = [];
    if(c.ok) parts.push(bn(c.ok) + 'টি প্রকাশিত');
    if(c.review) parts.push(bn(c.review) + 'টি রিভিউয়ের অপেক্ষায়');
    if(c.bad) parts.push(bn(c.bad) + 'টি অনুমোদিত হয়নি');
    if(c.retry) parts.push(bn(c.retry) + 'টি পাঠানো হয়নি');
    return parts.join(' · ');
  }

  // items: [{ index, label, out:{status,title,message,guideline,retryable} }]
  // handlers: { onEdit(index), onRetry(), onClose(), onMine() }
  function showResults(items, handlers){
    closeSheet(true);
    handlers = handlers || {};
    if(!items || !items.length) return;

    var multi = items.length > 1;
    var status = multi ? overallStatus(items) : items[0].out.status;
    var tone = toneOf(status);
    var single = items[0].out;

    var scrim = el('div', 'smod-scrim');
    var sheet = el('div', 'smod-sheet smod-' + tone.cls);
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', 'smodTitle');
    sheet.setAttribute('aria-describedby', 'smodMsg');
    sheet.appendChild(el('div', 'smod-handle'));

    var head = el('div', 'smod-head');
    var ic = el('div', 'smod-ic'); ic.setAttribute('aria-hidden', 'true');
    ic.appendChild(el('i', 'fa-solid ' + tone.icon));
    head.appendChild(ic);
    var tx = el('div', 'smod-head-text');
    var title = el('h2', 'smod-title', multi ? summaryTitle(items) : single.title); title.id = 'smodTitle';
    var msg = el('p', 'smod-msg', multi ? 'প্রতিটি স্লাইডের অবস্থা নিচে দেখুন।' : single.message); msg.id = 'smodMsg';
    tx.appendChild(title); tx.appendChild(msg);
    head.appendChild(tx);
    sheet.appendChild(head);

    if(!multi && single.guideline){
      var g = el('div', 'smod-guideline');
      g.appendChild(el('div', 'smod-guideline-label', 'যে নীতিমালা প্রযোজ্য হয়েছে'));
      g.appendChild(el('div', 'smod-guideline-title', single.guideline));
      sheet.appendChild(g);
    }
    if(!multi && status === 'review_required'){
      var note = el('div', 'smod-note');
      var ni = el('i', 'fa-solid fa-lock'); ni.setAttribute('aria-hidden', 'true');
      note.appendChild(ni);
      note.appendChild(el('span', null, 'অনুমোদনের আগে স্টোরিটি শুধু আপনার কাছে থাকবে, ফিডে দেখা যাবে না।'));
      sheet.appendChild(note);
    }

    if(multi || items[0].label){
      var list = el('ul', 'smod-items');
      items.forEach(function(it){
        var t = toneOf(it.out.status);
        var li = el('li', 'smod-item');
        li.appendChild(el('span', 'smod-chip smod-chip-' + t.cls, CHIP[it.out.status] || 'অবস্থা'));
        var main = el('div', 'smod-item-main');
        main.appendChild(el('div', 'smod-item-title', it.label || ('স্লাইড ' + bn(it.index + 1))));
        var sub = it.out.guideline || (it.out.status === 'approved' ? '' : it.out.title);
        if(sub) main.appendChild(el('div', 'smod-item-sub', sub));
        li.appendChild(main);
        list.appendChild(li);
      });
      sheet.appendChild(list);
    }

    var firstRejected = null, anyRetry = false;
    items.forEach(function(it){
      if(!firstRejected && (it.out.status === 'rejected' || it.out.status === 'invalid')) firstRejected = it;
      if(it.out.retryable && it.out.status !== 'rejected') anyRetry = true;
    });

    var actions = el('div', 'smod-actions');
    var primary = el('button', 'smod-btn smod-btn-primary'); primary.type = 'button';
    var secondary = null;
    if(firstRejected && handlers.onEdit){
      primary.textContent = 'সম্পাদনা করে আবার জমা দিন';
      primary.onclick = function(){ closeSheet(true); handlers.onEdit(firstRejected.index); };
    } else if(anyRetry && handlers.onRetry){
      primary.textContent = 'আবার চেষ্টা করুন';
      primary.onclick = function(){ closeSheet(true); handlers.onRetry(); };
    } else {
      primary.textContent = 'ঠিক আছে';
      primary.onclick = function(){ closeSheet(); };
    }
    actions.appendChild(primary);
    if(primary.textContent !== 'ঠিক আছে'){
      secondary = el('button', 'smod-btn smod-btn-ghost', 'বন্ধ করুন'); secondary.type = 'button';
      secondary.onclick = function(){ closeSheet(); };
      actions.appendChild(secondary);
    }
    sheet.appendChild(actions);

    if(handlers.onMine){
      var link = el('button', 'smod-link', 'আমার সাম্প্রতিক স্টোরির অবস্থা দেখুন'); link.type = 'button';
      link.onclick = function(){ closeSheet(true); handlers.onMine(); };
      sheet.appendChild(link);
    }

    scrim.onclick = function(){ closeSheet(); };
    document.body.appendChild(scrim);
    document.body.appendChild(sheet);

    var focusables = function(){ return Array.prototype.slice.call(sheet.querySelectorAll('button:not([disabled])')); };
    var onKey = function(e){
      if(e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); closeSheet(); return; }
      if(e.key === 'Tab'){
        var f = focusables(); if(!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
        else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
        else if(f.indexOf(document.activeElement) === -1){ e.preventDefault(); first.focus(); }
      }
    };
    sheetState = { scrim: scrim, sheet: sheet, prevFocus: document.activeElement, onKey: onKey, handlers: handlers };
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(function(){ scrim.classList.add('open'); sheet.classList.add('open'); try{ primary.focus(); }catch(e){} });
  }

  // ---------------------------------------------------------------- note on a slide that was not approved (shown inside the composer)
  function setSlideNote(slide, out){
    if(!slide) return;
    if(out && (out.status === 'rejected' || out.status === 'invalid')){
      slide._modNote = { title: out.guideline || out.title, status: out.status };
    } else {
      slide._modNote = null;
    }
  }
  function renderSlideBanner(){
    var old = document.getElementById('storyModBanner');
    if(old && old.parentNode) old.parentNode.removeChild(old);
    var stage = document.getElementById('statusCompStage');
    if(!stage || typeof activeSlide !== 'function') return;
    var slide = activeSlide();
    if(!slide || !slide._modNote) return;
    var b = el('div', 'smod-banner'); b.id = 'storyModBanner'; b.setAttribute('role', 'status');
    var bi = el('i', 'fa-solid fa-triangle-exclamation'); bi.setAttribute('aria-hidden', 'true');
    b.appendChild(bi);
    var t = el('div', 'smod-banner-text');
    t.appendChild(el('strong', null, 'এই স্লাইড অনুমোদিত হয়নি'));
    t.appendChild(el('span', null, slide._modNote.title + ' — সম্পাদনা করে আবার জমা দিন।'));
    b.appendChild(t);
    var x = el('button', 'smod-banner-x'); x.type = 'button'; x.setAttribute('aria-label', 'বার্তাটি বন্ধ করুন');
    x.appendChild(el('i', 'fa-solid fa-xmark'));
    x.onclick = function(){ slide._modNote = null; if(b.parentNode) b.parentNode.removeChild(b); };
    b.appendChild(x);
    stage.appendChild(b);
  }

  // ---------------------------------------------------------------- decisions that arrive later (admin approves / rejects)
  function watchLoad(){
    try{ var o = JSON.parse(localStorage.getItem(WATCH_KEY) || 'null'); return (o && typeof o === 'object') ? o : {}; }catch(e){ return {}; }
  }
  function watchSave(o){ try{ localStorage.setItem(WATCH_KEY, JSON.stringify(o)); }catch(e){} }
  function watchAdd(uid, ids){
    if(!uid || !ids || !ids.length) return;
    var o = watchLoad(), now = Date.now();
    var arr = (o[uid] || []).filter(function(x){ return now - x.at < WATCH_TTL_MS; });
    ids.forEach(function(id){ if(id && !arr.some(function(x){ return x.id === id; })) arr.push({ id: id, at: now }); });
    o[uid] = arr.slice(-30);
    watchSave(o);
  }
  function watchRemove(uid, id){
    var o = watchLoad();
    if(!o[uid]) return;
    o[uid] = o[uid].filter(function(x){ return x.id !== id; });
    watchSave(o);
  }

  var watchChecked = false;
  // Called once per page session (from renderStatusRow). Costs nothing unless this user has stories waiting for review.
  function checkWatch(h){
    if(watchChecked) return;
    var u = (typeof state !== 'undefined' && state && state.user) ? state.user : null;
    if(!u || !u.uid) return;
    var o = watchLoad();
    var now = Date.now();
    var list = (o[u.uid] || []).filter(function(x){ return now - x.at < WATCH_TTL_MS; });
    watchChecked = true;
    if(!list.length) return;
    setTimeout(async function(){
      try{
        var token = await getIdToken(false);
        if(!token) return;
        var r = await postJson({ action: 'mine' }, token);
        if(r.status !== 200 || !r.json || !r.json.items) return;
        var byId = {};
        r.json.items.forEach(function(it){ byId[it.id] = it; });
        var resolved = [], approvedAny = false;
        list.forEach(function(w){
          var it = byId[w.id];
          if(!it) return;
          if(it.status === 'approved' || it.status === 'rejected'){
            resolved.push({
              index: resolved.length,
              label: it.preview ? ('“' + it.preview + (it.preview.length >= 80 ? '…' : '') + '”') : (it.type === 'image' ? 'ছবির স্টোরি' : it.type === 'voice' ? 'ভয়েস স্টোরি' : 'স্টোরি'),
              out: { status: it.status, title: it.title, message: it.message, guideline: it.guideline || null, retryable: false }
            });
            if(it.status === 'approved') approvedAny = true;
            watchRemove(u.uid, w.id);
          }
        });
        if(resolved.length){
          if(approvedAny && h && typeof h.onApproved === 'function') h.onApproved();
          showResults(resolved, {});
        }
      }catch(e){ /* silent — it will be checked again next session */ }
    }, 2500);
  }

  // "আমার সাম্প্রতিক স্টোরির অবস্থা"
  async function openMine(){
    var token = await getIdToken(false);
    if(!token){ if(typeof showToast === 'function') showToast('সাইন ইন করুন'); return; }
    try{
      var r = await postJson({ action: 'mine' }, token);
      var items = (r.json && r.json.items) || [];
      if(r.status !== 200){ if(typeof showToast === 'function') showToast('তালিকা আনা যায়নি, পরে চেষ্টা করুন'); return; }
      if(!items.length){ if(typeof showToast === 'function') showToast('এখনো কোনো স্টোরি জমা দেননি'); return; }
      showResults(items.slice(0, 12).map(function(it, i){
        return {
          index: i,
          label: it.preview ? ('“' + it.preview + (it.preview.length >= 80 ? '…' : '') + '”') : (it.type === 'image' ? 'ছবির স্টোরি' : it.type === 'voice' ? 'ভয়েস স্টোরি' : 'স্টোরি'),
          out: { status: it.status === 'processing' ? 'pending' : it.status, title: it.title, message: it.message, guideline: it.guideline || null, retryable: false }
        };
      }), {});
    }catch(e){
      if(typeof showToast === 'function') showToast('ইন্টারনেট সংযোগ পরীক্ষা করুন');
    }
  }

  window.StoryModeration = {
    requestIdFor: requestIdFor,
    resetRequestId: resetRequestId,
    submit: submit,
    phaseText: phaseText,
    progress: { show: progressShow, hide: progressHide },
    showResults: showResults,
    closeSheet: function(){ closeSheet(true); },
    setSlideNote: setSlideNote,
    renderSlideBanner: renderSlideBanner,
    watchAdd: watchAdd,
    watchRemove: watchRemove,
    checkWatch: checkWatch,
    openMine: openMine
  };
})();
