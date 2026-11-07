/* ============================================================================
   js/admin-moderation.js — অ্যাডমিন প্যানেলের "স্টোরি মডারেশন" ড্যাশবোর্ড (শুধু ওয়েবসাইট)

   js/admin.js এই মডিউলকে নতুন ট্যাবের ভেতরে mount করে। সব ডেটা আসে POST /api/story-admin থেকে —
   যেখানে প্রতিটা কলে Firebase টোকেন + admins/{uid}.isAdmin সার্ভারে যাচাই হয়। মডারেশন কালেকশনগুলো
   Firestore রুলসে ক্লায়েন্টের জন্য বন্ধ, তাই ব্রাউজার থেকে সরাসরি কিছু পড়া/বদলানো যায় না;
   এই ফাইলের বোতাম টিপলেও আসল অনুমতি সার্ভারই দেয়।

   আছে: মোট/অনুমোদিত/প্রত্যাখ্যাত/রিভিউ-বাকি কাউন্ট, AI কার্যক্রম (৭ দিন), সাম্প্রতিক মডারেশন,
   চারটি ট্যাব (সব / অনুমোদিত / প্রত্যাখ্যাত / রিভিউ বাকি), পেজিনেশন, বিস্তারিত শীট (পূর্ণ কনটেন্ট,
   AI সিদ্ধান্ত ও কারণ, ইতিহাস, ব্যবহারকারীর আগের রেকর্ড, বারবার লঙ্ঘনের চিহ্ন) এবং
   অনুমোদন / প্রত্যাখ্যান / প্রকাশিত স্টোরি সরানো / AI দিয়ে আবার যাচাই।

   ডেটা থেকে আসা সব লেখা textContent দিয়ে বসানো হয় (innerHTML-এ কখনো নয়)।
   ============================================================================ */
window.AdminModeration = (function(){
  'use strict';

  const ENDPOINT = '/api/story-admin';
  const PAGE = 15;

  // Stories are website-only; the admin tab is not offered inside the Android app shell.
  const IS_APP = !!(window.QR_PLATFORM && window.QR_PLATFORM.isApp);

  let ctx = null;          // { getIdToken(), toast(msg, ok) }
  let root = null;         // panel element (#apPanelStories)
  let sheetEl = null;      // detail sheet
  let listSeq = 0;         // ignores out-of-date list responses
  let built = false;

  const S = {
    tab: 'pending',        // all | approved | rejected | pending
    stats: null,
    items: [], cursor: null, hasMore: false, loading: false, listError: null,
    busy: {},
    detail: null,          // { id, data, error, loading }
    fold: { activity: false, recent: false },
  };

  // ------------------------------------------------------------------------------------------ tiny helpers
  const bn = (n) => (typeof toBn === 'function' ? toBn(n) : String(n));
  function h(tag, props, kids){
    const e = document.createElement(tag);
    if(props){
      for(const k in props){
        const v = props[k];
        if(v == null || v === false) continue;
        if(k === 'class') e.className = v;
        else if(k === 'text') e.textContent = v;
        else if(k === 'on'){ for(const ev in v) e.addEventListener(ev, v[ev]); }
        else if(k === 'dataset'){ for(const d in v) e.dataset[d] = v[d]; }
        else e.setAttribute(k, v === true ? '' : v);
      }
    }
    (Array.isArray(kids) ? kids : (kids != null ? [kids] : [])).forEach((c) => {
      if(c == null || c === false) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }
  const icon = (cls) => { const i = h('i', { class: 'fa-solid ' + cls }); i.setAttribute('aria-hidden', 'true'); return i; };
  function clear(el){ while(el.firstChild) el.removeChild(el.firstChild); }

  function fmtTime(ms){
    if(!ms) return '—';
    try{ return new Date(ms).toLocaleString('bn-BD', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); }
    catch(e){ return new Date(ms).toLocaleString(); }
  }
  function ago(ms){
    if(!ms) return '';
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if(s < 60) return 'এইমাত্র';
    const m = Math.floor(s / 60); if(m < 60) return bn(m) + ' মিনিট আগে';
    const hr = Math.floor(m / 60); if(hr < 24) return bn(hr) + ' ঘণ্টা আগে';
    return bn(Math.floor(hr / 24)) + ' দিন আগে';
  }
  const shortUid = (u) => (u && u.length > 10) ? u.slice(0, 4) + '…' + u.slice(-4) : (u || '');
  const pct = (c) => (typeof c === 'number' ? bn(Math.round(c * 100)) + '%' : '—');

  const STATUS = {
    approved: { label: 'অনুমোদিত', cls: 'ok' },
    rejected: { label: 'প্রত্যাখ্যাত', cls: 'bad' },
    review_required: { label: 'রিভিউ প্রয়োজন', cls: 'wait' },
    pending: { label: 'AI যাচাই বাকি', cls: 'wait' },
    processing: { label: 'যাচাই চলছে', cls: 'info' },
  };
  const TYPE = { text: ['fa-font', 'লেখা'], image: ['fa-image', 'ছবি'], voice: ['fa-microphone', 'ভয়েস'] };
  const SOURCE = { ai: 'AI', ai_cache: 'AI (ক্যাশ)', system: 'সিস্টেম', admin: 'অ্যাডমিন' };
  const NOTE = {
    low_confidence: 'AI-এর আত্মবিশ্বাস কম',
    inconsistent_ai_output: 'AI-এর উত্তরে অসঙ্গতি ছিল',
    reject_below_threshold: 'প্রত্যাখ্যানের সুপারিশ, কিন্তু আত্মবিশ্বাস কম — মানুষের যাচাই',
    unclassified_rejection: 'প্রত্যাখ্যানের সুপারিশ, কিন্তু কারণ অস্পষ্ট',
    image_nudity: 'ছবিতে নগ্নতা শনাক্ত হয়েছে',
    image_suggestive: 'ছবিটি আপত্তিকর হতে পারে',
    image_violence: 'ছবিতে সহিংসতা শনাক্ত হয়েছে',
    image_text: 'ছবির ভেতরের লেখায় সমস্যা',
    links: 'অজানা লিংক আছে',
    untrusted_audio: 'নিজস্ব অডিও — স্বয়ংক্রিয়ভাবে যাচাই করা যায় না',
    repeat_offender: 'বারবার লঙ্ঘনের ইতিহাস আছে',
  };
  const EVENT = {
    ai_decision: 'AI সিদ্ধান্ত', ai_cache_hit: 'AI সিদ্ধান্ত (ক্যাশ)', ai_error: 'AI ত্রুটি',
    system_review: 'সিস্টেম: রিভিউয়ে পাঠানো', system_approve: 'সিস্টেম: স্বয়ংক্রিয় অনুমোদন',
    admin_approve: 'অ্যাডমিন: অনুমোদন', admin_reject: 'অ্যাডমিন: প্রত্যাখ্যান',
    admin_remove: 'অ্যাডমিন: প্রকাশিত স্টোরি সরানো', admin_recheck: 'অ্যাডমিন: AI দিয়ে আবার যাচাই',
  };
  const REJECT_REASONS = [
    ['admin_decision', 'অ্যাডমিনের সিদ্ধান্ত (সাধারণ)'], ['sexual_content', 'অশালীন/যৌন কনটেন্ট'], ['nudity', 'নগ্নতা/অনুপযুক্ত ছবি'],
    ['profanity_abuse', 'অশ্লীল/আপত্তিকর ভাষা'], ['harassment', 'হয়রানি/অপমান'], ['religious_insult', 'ধর্মীয় অবমাননা'],
    ['harmful_activity', 'ক্ষতিকর/নিষিদ্ধ কর্মকাণ্ড'], ['violence_gore', 'সহিংস/বীভৎস দৃশ্য'], ['spam_scam', 'স্প্যাম/প্রতারণা'],
    ['malicious_link', 'সন্দেহজনক লিংক'], ['image_text_violation', 'ছবির লেখায় আপত্তিকর বিষয়'],
    ['fabricated_religious_text', 'ধর্মীয় উদ্ধৃতি যাচাই করা যায়নি'], ['misleading_religious_claim', 'বিভ্রান্তিকর ধর্মীয় বক্তব্য'],
    ['false_attribution', 'ভুল সূত্রে উদ্ধৃতি'], ['ambiguous_religious_content', 'অস্পষ্ট ধর্মীয় বিষয়'], ['other_violation', 'নীতিমালা লঙ্ঘন (সাধারণ)'],
  ];

  const statusInfo = (it) => {
    if(it.status === 'rejected' && it.removedAfterPublish) return { label: 'প্রকাশের পর সরানো', cls: 'bad' };
    return STATUS[it.status] || { label: it.status, cls: 'info' };
  };
  const chip = (info) => h('span', { class: 'apm-chip apm-chip-' + info.cls, text: info.label });

  // ------------------------------------------------------------------------------------------ server calls
  async function api(body){
    const token = await ctx.getIdToken();
    if(!token){ const e = new Error('unauthenticated'); e.status = 401; throw e; }
    let r;
    try{
      r = await fetch(ENDPOINT, {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify(body),
      });
    }catch(netErr){ const e = new Error('network'); e.status = 0; throw e; }
    const j = await r.json().catch(() => ({}));
    if(!r.ok){ const e = new Error(j.error || ('http_' + r.status)); e.status = r.status; e.payload = j; throw e; }
    return j;
  }
  function errText(e){
    if(!e) return 'অজানা সমস্যা';
    if(e.status === 0) return 'ইন্টারনেট সংযোগ পরীক্ষা করুন';
    if(e.status === 401) return 'সেশন শেষ — আবার সাইন ইন করুন';
    if(e.status === 403) return 'এই কাজের অনুমতি নেই';
    if(e.status === 404) return 'স্টোরিটি খুঁজে পাওয়া যায়নি';
    if(e.status === 409) return 'স্টোরিটির অবস্থা ইতিমধ্যে বদলে গেছে';
    if(e.message === 'not_configured') return 'সার্ভার কনফিগার করা নেই (Vercel env: FIREBASE_SERVICE_ACCOUNT)';
    return 'কাজটি সম্পন্ন করা যায়নি, আবার চেষ্টা করুন';
  }
  const say = (msg, ok) => { if(ctx && ctx.toast) ctx.toast(msg, ok !== false); };

  // ------------------------------------------------------------------------------------------ styles
  const CSS = `
  #apPanelStories{display:flex;flex-direction:column;gap:14px;min-width:0;}
  #apPanelStories *{box-sizing:border-box;}
  #apPanelStories .apm-head{display:flex;align-items:center;gap:8px;justify-content:space-between;}
  #apPanelStories .apm-head h3{margin:0;font-size:15px;font-weight:700;color:var(--ink,#1c2b23);display:flex;align-items:center;gap:8px;}
  #apPanelStories .apm-head h3 i{color:var(--gold,#b8863b);}
  #apPanelStories .apm-icon-btn{width:38px;height:38px;border-radius:10px;border:1px solid var(--line,#e2ddd0);background:var(--parchment,#fbf9f4);color:var(--ink-soft,#5c6d64);cursor:pointer;}
  #apPanelStories .apm-icon-btn:disabled{opacity:.5;cursor:default;}
  #apPanelStories .apm-stats{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;}
  @media (min-width:480px){#apPanelStories .apm-stats{grid-template-columns:repeat(4,1fr);}}
  #apPanelStories .apm-stat{text-align:left;padding:10px 12px;border-radius:13px;border:1px solid var(--line,#e2ddd0);background:var(--parchment,#fbf9f4);cursor:pointer;font-family:inherit;color:var(--ink,#1c2b23);}
  #apPanelStories .apm-stat[aria-pressed="true"]{border-color:var(--gold,#b8863b);box-shadow:0 0 0 1px var(--gold,#b8863b) inset;}
  #apPanelStories .apm-stat-val{font-size:22px;font-weight:800;line-height:1.1;}
  #apPanelStories .apm-stat-lbl{font-size:11.5px;color:var(--ink-soft,#5c6d64);margin-top:5px;font-weight:600;display:flex;align-items:center;gap:6px;}
  #apPanelStories .apm-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;}
  #apPanelStories .apm-stat-sub{font-size:10.5px;color:var(--ink-soft,#5c6d64);margin-top:3px;}
  #apPanelStories .apm-stat-sub:empty{display:none;}
  #apPanelStories .apm-dot.ok,#apmSheet .apm-dot.ok{background:#3E9B73;}
  #apPanelStories .apm-dot.bad,#apmSheet .apm-dot.bad{background:#C4584B;}
  #apPanelStories .apm-dot.wait,#apmSheet .apm-dot.wait{background:#C0973A;}
  #apPanelStories .apm-dot.info,#apmSheet .apm-dot.info{background:#7C8DB0;}
  #apPanelStories .apm-card,#apmSheet .apm-card{background:var(--parchment,#fbf9f4);border:1px solid var(--line,#e2ddd0);border-radius:14px;padding:14px;}
  #apPanelStories details.apm-fold{background:var(--parchment,#fbf9f4);border:1px solid var(--line,#e2ddd0);border-radius:14px;}
  #apPanelStories details.apm-fold > summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:8px;padding:12px 14px;font-size:13.5px;font-weight:700;color:var(--ink,#1c2b23);border-radius:14px;}
  #apPanelStories details.apm-fold > summary::-webkit-details-marker{display:none;}
  #apPanelStories details.apm-fold > summary i.lead{color:var(--gold,#b8863b);}
  #apPanelStories details.apm-fold > summary .sum{font-weight:500;font-size:11.5px;color:var(--ink-soft,#5c6d64);margin-left:auto;text-align:right;}
  #apPanelStories details.apm-fold > summary .chev{transition:transform .15s;color:var(--ink-soft,#5c6d64);font-size:11px;}
  #apPanelStories details.apm-fold[open] > summary .chev{transform:rotate(180deg);}
  #apPanelStories details.apm-fold > summary:focus-visible{outline:2px solid var(--gold,#b8863b);outline-offset:2px;}
  #apPanelStories details.apm-fold > .apm-fold-body{padding:2px 14px 14px;}
  #apPanelStories .apm-card-title{display:flex;align-items:center;gap:8px;margin:0 0 12px;font-size:13.5px;font-weight:700;color:var(--ink,#1c2b23);}
  #apPanelStories .apm-card-title i{color:var(--gold,#b8863b);}
  #apPanelStories .apm-today{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:12px;}
  #apPanelStories .apm-today div{text-align:center;padding:8px 2px;border-radius:10px;background:var(--panel,#f3efe5);}
  #apPanelStories .apm-today b{display:block;font-size:16px;color:var(--ink,#1c2b23);}
  #apPanelStories .apm-today span{display:block;font-size:10px;color:var(--ink-soft,#5c6d64);margin-top:2px;line-height:1.3;}
  #apPanelStories .apm-bars{display:flex;align-items:flex-end;gap:6px;height:84px;}
  #apPanelStories .apm-bar{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;min-width:0;}
  #apPanelStories .apm-bar-stack{width:100%;max-width:34px;display:flex;flex-direction:column-reverse;border-radius:4px 4px 2px 2px;overflow:hidden;background:var(--line,#e2ddd0);min-height:3px;}
  #apPanelStories .apm-seg.ok{background:#3E9B73;} #apPanelStories .apm-seg.wait{background:#C0973A;}
  #apPanelStories .apm-seg.bad{background:#C4584B;} #apPanelStories .apm-seg.info{background:#9AA7BE;}
  #apPanelStories .apm-bar-lbl{font-size:9.5px;color:var(--ink-soft,#5c6d64);margin-top:4px;white-space:nowrap;}
  #apPanelStories .apm-legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:10px;font-size:11px;color:var(--ink-soft,#5c6d64);}
  #apPanelStories .apm-legend span{display:inline-flex;align-items:center;gap:5px;}
  #apPanelStories .apm-recent{display:flex;flex-direction:column;}
  #apPanelStories .apm-rrow{display:flex;gap:9px;align-items:center;padding:9px 0;border-top:1px solid var(--line,#e2ddd0);background:none;border-left:0;border-right:0;border-bottom:0;width:100%;text-align:left;cursor:pointer;font-family:inherit;color:var(--ink,#1c2b23);}
  #apPanelStories .apm-rrow:first-child{border-top:none;}
  #apPanelStories .apm-rrow-main{min-width:0;flex:1;}
  #apPanelStories .apm-rrow-text{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  #apPanelStories .apm-rrow-sub{font-size:11px;color:var(--ink-soft,#5c6d64);margin-top:2px;}
  #apPanelStories .apm-tabs,#apmSheet .apm-tabs{display:flex;gap:4px;padding:4px;border-radius:12px;background:var(--panel,#f3efe5);border:1px solid var(--line,#e2ddd0);}
  #apPanelStories .apm-tab{flex:1;min-width:0;padding:9px 4px;border-radius:9px;border:none;background:transparent;cursor:pointer;font:600 12.5px/1.25 'Hind Siliguri',sans-serif;color:var(--ink-soft,#5c6d64);}
  #apPanelStories .apm-tab[aria-selected="true"]{background:var(--parchment,#fbf9f4);color:var(--ink,#1c2b23);box-shadow:0 1px 3px rgba(0,0,0,.12);}
  #apPanelStories .apm-tab small{display:block;font-weight:700;color:var(--gold,#b8863b);font-size:11px;}
  #apPanelStories .apm-list{display:flex;flex-direction:column;gap:10px;}
  #apPanelStories .apm-story{background:var(--parchment,#fbf9f4);border:1px solid var(--line,#e2ddd0);border-radius:14px;padding:13px;display:flex;flex-direction:column;gap:9px;min-width:0;}
  .apm-story-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
  .apm-type{font-size:11.5px;color:var(--ink-soft,#5c6d64);display:inline-flex;align-items:center;gap:5px;}
  .apm-time{font-size:11.5px;color:var(--ink-soft,#5c6d64);margin-left:auto;}
  #apPanelStories .apm-user{font-size:12.5px;color:var(--ink,#1c2b23);display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
  .apm-uid{font-size:11px;color:var(--ink-soft,#5c6d64);font-family:ui-monospace,monospace;}
  #apPanelStories .apm-text,#apmSheet .apm-text{margin:0;font-size:14px;line-height:1.7;color:var(--ink,#1c2b23);white-space:pre-wrap;overflow-wrap:anywhere;}
  #apPanelStories .apm-text.clamp{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;}
  .apm-meta{display:flex;flex-wrap:wrap;gap:6px;}
  #apPanelStories .apm-tag,#apmSheet .apm-tag{font-size:11px;padding:3px 8px;border-radius:999px;background:var(--panel,#f3efe5);border:1px solid var(--line,#e2ddd0);color:var(--ink,#1c2b23);}
  #apPanelStories .apm-tag.warn,#apmSheet .apm-tag.warn{border-color:#C4584B;}
  #apPanelStories .apm-aireason{margin:0;font-size:12.5px;line-height:1.6;color:var(--ink-soft,#5c6d64);overflow-wrap:anywhere;}
  #apPanelStories .apm-actions,#apmSheet .apm-actions{display:flex;flex-wrap:wrap;gap:8px;}
  .apm-chip{font-size:11.5px;line-height:1;padding:5px 9px;border-radius:999px;border:1px solid var(--line,#e2ddd0);border-left-width:3px;color:var(--ink,#1c2b23);white-space:nowrap;flex:0 0 auto;}
  .apm-chip-ok{background:rgba(62,155,115,.14);border-left-color:#3E9B73;}
  .apm-chip-bad{background:rgba(196,88,75,.14);border-left-color:#C4584B;}
  .apm-chip-wait{background:rgba(192,151,58,.16);border-left-color:#C0973A;}
  .apm-chip-info{background:rgba(124,141,176,.16);border-left-color:#7C8DB0;}
  .apm-badge{font-size:10.5px;font-weight:700;padding:3px 8px;border-radius:999px;white-space:nowrap;}
  .apm-badge-bad{background:#C4584B;color:#fff;}
  .apm-badge-soft{background:var(--panel,#f3efe5);color:var(--ink-soft,#5c6d64);border:1px solid var(--line,#e2ddd0);}
  .apm-btn{min-height:40px;padding:0 14px;border-radius:10px;border:1px solid var(--line,#e2ddd0);background:var(--parchment,#fbf9f4);color:var(--ink,#1c2b23);cursor:pointer;font:600 13px/1.2 'Hind Siliguri',sans-serif;display:inline-flex;align-items:center;justify-content:center;gap:7px;}
  .apm-btn:disabled{opacity:.55;cursor:default;}
  .apm-btn-ok{background:#2F7D5B;border-color:#2F7D5B;color:#fff;}
  .apm-btn-bad{background:#B4453A;border-color:#B4453A;color:#fff;}
  .apm-btn-gold{background:var(--gold,#b8863b);border-color:var(--gold,#b8863b);color:#1E2A26;}
  .apm-btn:focus-visible,.apm-tab:focus-visible,.apm-stat:focus-visible,.apm-rrow:focus-visible,.apm-icon-btn:focus-visible{outline:2px solid var(--gold,#b8863b);outline-offset:2px;}
  #apPanelStories .apm-empty{padding:26px 10px;text-align:center;color:var(--ink-soft,#5c6d64);font-size:13px;line-height:1.7;}
  #apPanelStories .apm-empty i{display:block;font-size:22px;margin-bottom:8px;color:var(--gold,#b8863b);}
  #apPanelStories .apm-skel{height:96px;border-radius:14px;background:var(--panel,#f3efe5);border:1px solid var(--line,#e2ddd0);}
  #apPanelStories .apm-err{padding:14px;border-radius:12px;border:1px solid #C4584B;background:rgba(196,88,75,.08);font-size:13px;line-height:1.7;color:var(--ink,#1c2b23);display:flex;flex-direction:column;gap:10px;}
  /* detail sheet (sits inside #apOverlay so it covers the whole panel) */
  #apmSheet{position:absolute;inset:0;z-index:30;background:rgba(10,20,17,.5);display:flex;align-items:flex-end;justify-content:center;}
  #apmSheet .apm-sheet-card{width:100%;max-width:640px;max-height:94%;overflow-y:auto;overscroll-behavior:contain;background:var(--parchment,#fbf9f4);color:var(--ink,#1c2b23);border-radius:18px 18px 0 0;padding:0 16px calc(24px + env(safe-area-inset-bottom,0px));font-family:'Hind Siliguri',sans-serif;}
  #apmSheet .apm-sheet-bar{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:14px 0 10px;background:var(--parchment,#fbf9f4);border-bottom:1px solid var(--line,#e2ddd0);margin-bottom:12px;}
  #apmSheet .apm-sheet-bar h4{margin:0;font-size:15px;font-weight:700;}
  #apmSheet .apm-icon-btn{width:38px;height:38px;border-radius:10px;border:1px solid var(--line,#e2ddd0);background:var(--parchment,#fbf9f4);color:var(--ink-soft,#5c6d64);cursor:pointer;}
  #apmSheet .apm-sec{margin:0 0 14px;}
  #apmSheet .apm-sec h5{margin:0 0 8px;font-size:12px;font-weight:700;color:var(--ink-soft,#5c6d64);letter-spacing:.02em;}
  #apmSheet .apm-preview{border-radius:12px;padding:22px 16px;min-height:120px;display:flex;align-items:center;justify-content:center;text-align:center;overflow-wrap:anywhere;white-space:pre-wrap;background:#2E6F5E;color:#fff;font-size:20px;line-height:1.6;}
  #apmSheet .apm-media{display:block;max-width:100%;max-height:46vh;margin:0 auto;border-radius:10px;background:#000;object-fit:contain;}
  #apmSheet audio{width:100%;margin-top:8px;}
  #apmSheet .apm-kv{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:13px;}
  #apmSheet .apm-kv dt{color:var(--ink-soft,#5c6d64);margin:0;} #apmSheet .apm-kv dd{margin:0;overflow-wrap:anywhere;}
  #apmSheet .apm-quote{margin:8px 0 0;padding:9px 12px;border-left:3px solid var(--gold,#b8863b);background:var(--panel,#f3efe5);border-radius:8px;font-size:13px;line-height:1.7;overflow-wrap:anywhere;white-space:pre-wrap;}
  #apmSheet .apm-tl{list-style:none;margin:0;padding:0;}
  #apmSheet .apm-tl li{display:flex;gap:10px;padding:8px 0;border-top:1px solid var(--line,#e2ddd0);font-size:12.5px;}
  #apmSheet .apm-tl li:first-child{border-top:none;}
  #apmSheet .apm-tl-main{min-width:0;flex:1;} #apmSheet .apm-tl-sub{color:var(--ink-soft,#5c6d64);font-size:11.5px;margin-top:2px;overflow-wrap:anywhere;}
  #apmSheet .apm-prev{display:flex;gap:9px;align-items:center;width:100%;text-align:left;padding:9px 0;border:none;border-top:1px solid var(--line,#e2ddd0);background:none;cursor:pointer;font-family:inherit;color:var(--ink,#1c2b23);}
  #apmSheet .apm-prev:first-child{border-top:none;}
  #apmSheet .apm-prev span.t{flex:1;min-width:0;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  #apmSheet label{display:block;font-size:12px;font-weight:600;color:var(--ink-soft,#5c6d64);margin:10px 0 5px;}
  #apmSheet select,#apmSheet textarea{width:100%;border:1px solid var(--line,#e2ddd0);border-radius:10px;background:var(--parchment,#fbf9f4);color:var(--ink,#1c2b23);font:14px/1.5 'Hind Siliguri',sans-serif;padding:9px 10px;}
  #apmSheet textarea{min-height:64px;resize:vertical;}
  #apmSheet .apm-decision{border:1px solid var(--line,#e2ddd0);border-radius:14px;padding:12px;background:var(--panel,#f3efe5);}
  #apmSheet .apm-decision-row{display:grid;gap:8px;}
  #apmSheet .apm-note{font-size:12.5px;line-height:1.7;color:var(--ink-soft,#5c6d64);}
  @media (min-width:700px){#apmSheet{align-items:center;} #apmSheet .apm-sheet-card{border-radius:18px;max-height:90%;}}
  @media (prefers-reduced-motion:reduce){#apPanelStories *,#apmSheet *{transition:none!important;animation:none!important;}}
  `;
  function injectCSS(){
    if(document.getElementById('apmStyles')) return;
    const st = document.createElement('style'); st.id = 'apmStyles'; st.textContent = CSS;
    document.head.appendChild(st);
  }

  // ------------------------------------------------------------------------------------------ shell
  function buildShell(){
    clear(root);
    const refreshBtn = h('button', { class: 'apm-icon-btn', type: 'button', id: 'apmRefresh', 'aria-label': 'রিফ্রেশ করুন', title: 'রিফ্রেশ', on: { click: () => refreshAll(true) } }, icon('fa-rotate'));
    root.appendChild(h('div', { class: 'apm-head' }, [
      h('h3', null, [icon('fa-shield-halved'), 'স্টোরি মডারেশন']),
      refreshBtn,
    ]));
    root.appendChild(h('div', { id: 'apmStats', class: 'apm-stats', role: 'group', 'aria-label': 'স্টোরি পরিসংখ্যান' }));
    root.appendChild(h('div', { id: 'apmTabs', class: 'apm-tabs', role: 'tablist', 'aria-label': 'স্টোরি তালিকা' }));
    root.appendChild(h('div', { id: 'apmList', class: 'apm-list', role: 'tabpanel', 'aria-live': 'polite' }));
    root.appendChild(h('div', { id: 'apmMore' }));
    // reference material sits below the work queue, collapsed by default so the queue is what the admin sees first
    root.appendChild(h('div', { id: 'apmActivity' }));
    root.appendChild(h('div', { id: 'apmRecent' }));
    built = true;
  }
  const $ = (id) => root.querySelector('#' + id);

  // ------------------------------------------------------------------------------------------ stats / activity / recent
  const TAB_DEFS = [
    ['pending', 'রিভিউ বাকি', (t) => t.pendingReview],
    ['all', 'সব স্টোরি', (t) => t.total],
    ['approved', 'অনুমোদিত', (t) => t.approved],
    ['rejected', 'প্রত্যাখ্যাত', (t) => t.rejected],
  ];

  function renderStats(){
    const box = $('apmStats'); clear(box);
    const t = S.stats && S.stats.totals;
    const defs = [
      ['all', 'মোট জমা', t && t.total, 'info', t && t.processing ? 'যাচাই চলছে: ' + bn(t.processing) : ''],
      ['approved', 'অনুমোদিত', t && t.approved, 'ok', ''],
      ['rejected', 'প্রত্যাখ্যাত', t && t.rejected, 'bad', ''],
      ['pending', 'রিভিউ বাকি', t && t.pendingReview, 'wait', t ? ('AI ব্যর্থ ' + bn(t.pending) + ' · রিভিউ ' + bn(t.reviewRequired)) : ''],
    ];
    defs.forEach(([tab, label, val, cls, sub]) => {
      box.appendChild(h('button', {
        type: 'button', class: 'apm-stat', 'aria-pressed': S.tab === tab ? 'true' : 'false',
        on: { click: () => setTab(tab) },
      }, [
        h('div', { class: 'apm-stat-val', text: val == null ? '—' : bn(val) }),
        h('div', { class: 'apm-stat-lbl' }, [h('span', { class: 'apm-dot ' + cls }), label]),
        h('div', { class: 'apm-stat-sub', text: sub || '' }),
      ]));
    });
    updateBadge();
  }

  // <details> keeps keyboard + screen-reader semantics for free; the open/closed state survives re-renders
  function fold(key, ic, title, summary, body){
    const d = h('details', { class: 'apm-fold' }, [
      h('summary', null, [icon(ic + ' lead'), title, h('span', { class: 'sum', text: summary }), icon('fa-chevron-down chev')]),
      h('div', { class: 'apm-fold-body' }, body),
    ]);
    if(S.fold[key]) d.open = true;
    d.addEventListener('toggle', () => { S.fold[key] = d.open; });
    return d;
  }

  function renderActivity(){
    const box = $('apmActivity'); clear(box);
    const act = S.stats && S.stats.activity;
    if(!act || !act.length) return;
    const today = act[0];
    const items = [
      ['জমা', today.submitted], ['AI কল', today.ai_calls], ['ক্যাশ থেকে', today.ai_cache_hits], ['AI ব্যর্থ', today.ai_failed],
      ['স্বয়ংক্রিয় অনুমোদন', today.auto_approved], ['স্বয়ংক্রিয় প্রত্যাখ্যান', today.auto_rejected], ['রিভিউয়ে পাঠানো', today.auto_review],
      ['অ্যাডমিন সিদ্ধান্ত', today.admin_approved + today.admin_rejected + today.admin_removed],
    ];
    const days = act.slice().reverse();
    const totals = days.map((d) => d.auto_approved + d.auto_review + d.auto_rejected + d.ai_failed);
    const max = Math.max(1, ...totals);
    const bars = h('div', { class: 'apm-bars', role: 'img', 'aria-label': 'গত ৭ দিনের AI মডারেশন: ' + days.map((d, i) => d.day + ' — ' + totals[i] + 'টি').join('; ') });
    days.forEach((d, i) => {
      const stack = h('div', { class: 'apm-bar-stack', style: 'height:' + Math.max(3, Math.round((totals[i] / max) * 100)) + '%', title: d.day + ': ' + totals[i] });
      [['ok', d.auto_approved], ['wait', d.auto_review], ['bad', d.auto_rejected], ['info', d.ai_failed]].forEach(([cls, n]) => {
        if(n > 0 && totals[i] > 0) stack.appendChild(h('div', { class: 'apm-seg ' + cls, style: 'height:' + ((n / totals[i]) * 100) + '%' }));
      });
      const parts = d.day.split('-');
      bars.appendChild(h('div', { class: 'apm-bar' }, [stack, h('div', { class: 'apm-bar-lbl', text: bn(parts[2]) + '/' + bn(parts[1]) })]));
    });
    box.appendChild(fold('activity', 'fa-wand-magic-sparkles', 'AI মডারেশন কার্যক্রম',
      'আজ: ' + bn(today.submitted || 0) + ' জমা · ' + bn(today.ai_calls || 0) + ' AI কল', [
        h('div', { class: 'apm-today' }, items.map(([l, v]) => h('div', null, [h('b', { text: bn(v || 0) }), h('span', { text: l })]))),
        bars,
        h('div', { class: 'apm-legend' }, [
          h('span', null, [h('span', { class: 'apm-dot ok' }), 'অনুমোদিত']), h('span', null, [h('span', { class: 'apm-dot wait' }), 'রিভিউয়ে']),
          h('span', null, [h('span', { class: 'apm-dot bad' }), 'প্রত্যাখ্যাত']), h('span', null, [h('span', { class: 'apm-dot info' }), 'AI ব্যর্থ']),
        ]),
      ]));
  }

  function snippet(it, n){
    const t = (it.text || '').replace(/\s+/g, ' ').trim();
    if(t) return t.length > n ? t.slice(0, n) + '…' : t;
    return it.type === 'voice' ? '🎙 ভয়েস স্টোরি' : it.type === 'image' ? '🖼 ছবির স্টোরি' : '🎵 শুধু মিউজিক';
  }

  function renderRecent(){
    const box = $('apmRecent'); clear(box);
    const rec = S.stats && S.stats.recent;
    if(!rec || !rec.length) return;
    box.appendChild(fold('recent', 'fa-clock-rotate-left', 'সাম্প্রতিক মডারেশন', bn(Math.min(rec.length, 6)) + 'টি সর্বশেষ সিদ্ধান্ত', [
      h('div', { class: 'apm-recent' }, rec.slice(0, 6).map((it) => h('button', { type: 'button', class: 'apm-rrow', on: { click: () => openDetail(it.id) } }, [
        chip(statusInfo(it)),
        h('div', { class: 'apm-rrow-main' }, [
          h('div', { class: 'apm-rrow-text', text: snippet(it, 70) }),
          h('div', { class: 'apm-rrow-sub', text: (it.userName || 'ব্যবহারকারী') + ' · ' + ago(it.moderatedAt || it.createdAt) + ' · ' + (SOURCE[it.source] || '') }),
        ]),
      ]))),
    ]));
  }

  function updateBadge(){
    const b = document.getElementById('apStoriesBadge');
    if(!b) return;
    const n = S.stats && S.stats.totals ? S.stats.totals.pendingReview : 0;
    b.textContent = n > 99 ? '৯৯+' : bn(n);
    b.hidden = !n;
  }

  // ------------------------------------------------------------------------------------------ tabs + list
  function renderTabs(){
    const box = $('apmTabs'); clear(box);
    const t = S.stats && S.stats.totals;
    TAB_DEFS.forEach(([tab, label, pick]) => {
      box.appendChild(h('button', {
        type: 'button', class: 'apm-tab', role: 'tab', 'aria-selected': S.tab === tab ? 'true' : 'false',
        on: { click: () => setTab(tab) },
      }, [label, h('small', { text: t ? bn(pick(t)) : '' })]));
    });
  }

  function typeTag(it){
    const [ic, label] = TYPE[it.type] || TYPE.text;
    const extras = [];
    if(it.type !== 'voice' && it.hasAudio) extras.push('+ অডিও');
    return h('span', { class: 'apm-type' }, [icon(ic), label + (extras.length ? ' ' + extras.join(' ') : '')]);
  }

  function userLine(it){
    const us = it.userStats;
    const kids = [h('strong', { text: it.userName || 'ব্যবহারকারী' }), h('span', { class: 'apm-uid', text: shortUid(it.userId) })];
    if(us && us.repeat) kids.push(h('span', { class: 'apm-badge apm-badge-bad', title: 'গত ৩০ দিনে একাধিকবার প্রত্যাখ্যাত', text: 'বারবার লঙ্ঘন · ' + bn(us.recentRejections30d) }));
    else if(us && us.rejected > 0) kids.push(h('span', { class: 'apm-badge apm-badge-soft', text: 'আগে প্রত্যাখ্যাত ' + bn(us.rejected) }));
    return h('div', { class: 'apm-user' }, kids);
  }

  function actionButtons(it){
    const busy = !!S.busy[it.id];
    const out = [];
    const canDecide = it.status === 'pending' || it.status === 'review_required' || (it.status === 'processing' && it.stale);
    const hasMedia = it.hasImage || it.hasAudio || it.type !== 'text';
    if(canDecide){
      if(hasMedia){
        out.push(h('button', { type: 'button', class: 'apm-btn apm-btn-gold', on: { click: () => openDetail(it.id) } }, [icon('fa-eye'), 'দেখুন ও সিদ্ধান্ত নিন']));
      } else {
        out.push(h('button', { type: 'button', class: 'apm-btn apm-btn-ok', disabled: busy, on: { click: () => act('approve', it) } }, [icon('fa-check'), 'অনুমোদন']));
        out.push(h('button', { type: 'button', class: 'apm-btn', on: { click: () => openDetail(it.id) } }, [icon('fa-ban'), 'প্রত্যাখ্যান…']));
      }
      if(it.status === 'pending' && it.aiState === 'failed'){
        out.push(h('button', { type: 'button', class: 'apm-btn', disabled: busy, on: { click: () => act('remoderate', it) } }, [icon('fa-arrows-rotate'), 'AI দিয়ে আবার যাচাই']));
      }
    } else if(it.status === 'approved'){
      out.push(h('button', { type: 'button', class: 'apm-btn apm-btn-bad', disabled: busy, on: { click: () => act('remove', it) } }, [icon('fa-trash'), 'সরিয়ে ফেলুন']));
    }
    out.push(h('button', { type: 'button', class: 'apm-btn', on: { click: () => openDetail(it.id) } }, [icon('fa-circle-info'), 'বিস্তারিত']));
    return out;
  }

  function storyCard(it){
    const info = statusInfo(it);
    const meta = [];
    if(it.status !== 'approved' || it.removedAfterPublish){
      if(it.reasonCode && it.reasonCode !== 'none') meta.push(h('span', { class: 'apm-tag' + (it.status === 'rejected' ? ' warn' : ''), text: it.reasonLabel }));
    }
    if(it.confidence != null) meta.push(h('span', { class: 'apm-tag', text: 'AI আত্মবিশ্বাস ' + pct(it.confidence) }));
    if(it.source) meta.push(h('span', { class: 'apm-tag', text: 'উৎস: ' + (SOURCE[it.source] || it.source) }));
    if(it.religiousContent) meta.push(h('span', { class: 'apm-tag', text: 'ধর্মীয় বিষয়' }));
    if(it.linkHosts && it.linkHosts.length) meta.push(h('span', { class: 'apm-tag warn', text: 'লিংক: ' + it.linkHosts.join(', ') }));
    if(it.status === 'pending' && it.aiError) meta.push(h('span', { class: 'apm-tag warn', text: 'ত্রুটি: ' + it.aiError }));

    const kids = [
      h('div', { class: 'apm-story-top' }, [chip(info), typeTag(it), h('span', { class: 'apm-time', title: fmtTime(it.createdAt), text: ago(it.createdAt) })]),
      userLine(it),
      h('p', { class: 'apm-text clamp', text: snippet(it, 600) }),
    ];
    if(meta.length) kids.push(h('div', { class: 'apm-meta' }, meta));
    if(it.aiReason && it.status !== 'approved') kids.push(h('p', { class: 'apm-aireason', text: (it.source === 'system' ? 'সিস্টেম: ' : 'AI: ') + it.aiReason }));
    if(it.adminNote) kids.push(h('p', { class: 'apm-aireason', text: 'অ্যাডমিন নোট: ' + it.adminNote }));
    if(it.reviewedAt) kids.push(h('p', { class: 'apm-aireason', text: 'সিদ্ধান্ত: ' + (it.reviewedByName || 'অ্যাডমিন') + ' · ' + fmtTime(it.reviewedAt) }));
    kids.push(h('div', { class: 'apm-actions' }, actionButtons(it)));
    return h('article', { class: 'apm-story', dataset: { id: it.id } }, kids);
  }

  function renderList(){
    const box = $('apmList'); clear(box);
    const more = $('apmMore'); clear(more);
    if(S.listError){ box.appendChild(errorBox(S.listError, () => loadList(true))); return; }
    if(S.loading && !S.items.length){
      for(let i = 0; i < 3; i++) box.appendChild(h('div', { class: 'apm-skel' }));
      return;
    }
    if(!S.items.length){
      const msgs = { pending: 'রিভিউয়ের জন্য কোনো স্টোরি অপেক্ষায় নেই। 🎉', approved: 'এখনো কোনো স্টোরি অনুমোদিত হয়নি।', rejected: 'কোনো প্রত্যাখ্যাত স্টোরি নেই।', all: 'এখনো কেউ স্টোরি জমা দেয়নি।' };
      box.appendChild(h('div', { class: 'apm-empty' }, [icon('fa-inbox'), msgs[S.tab] || msgs.all]));
      return;
    }
    S.items.forEach((it) => box.appendChild(storyCard(it)));
    if(S.hasMore){
      more.appendChild(h('button', { type: 'button', class: 'apm-btn', style: 'width:100%', disabled: S.loading, on: { click: () => loadList(false) } }, S.loading ? 'লোড হচ্ছে...' : 'আরও দেখুন'));
    }
  }

  function errorBox(e, retry){
    const safeIndexUrl = (typeof e.indexUrl === 'string' && e.indexUrl.indexOf('https://console.firebase.google.com/') === 0) ? e.indexUrl : null;
    const kids = [h('div', null, [icon('fa-triangle-exclamation'), ' ' + (safeIndexUrl ? 'এই তালিকার জন্য Firestore ইনডেক্স দরকার (একবারই তৈরি করতে হবে)।' : errText(e))])];
    if(safeIndexUrl){
      kids.push(h('div', { class: 'apm-note', text: 'নিচের বোতামে ক্লিক করে Firebase কনসোলে "Create index" চাপুন। তৈরি হতে কয়েক মিনিট লাগে, তারপর "আবার চেষ্টা করুন" চাপুন।' }));
      kids.push(h('a', { class: 'apm-btn apm-btn-gold', href: safeIndexUrl, target: '_blank', rel: 'noopener noreferrer' }, [icon('fa-up-right-from-square'), 'ইনডেক্স তৈরি করুন']));
    }
    kids.push(h('button', { type: 'button', class: 'apm-btn', on: { click: retry } }, [icon('fa-rotate'), 'আবার চেষ্টা করুন']));
    return h('div', { class: 'apm-err' }, kids);
  }

  // ------------------------------------------------------------------------------------------ loading
  async function loadStats(){
    try{
      S.stats = await api({ action: 'stats' });
    }catch(e){
      if(!S.stats) S.stats = null;
      S.statsError = e;
      if(e.status !== 0) say(errText(e), false);
    }
    renderStats(); renderActivity(); renderRecent(); renderTabs();
  }

  async function loadList(reset){
    const seq = ++listSeq;
    if(reset){ S.items = []; S.cursor = null; S.hasMore = false; S.listError = null; }
    S.loading = true; renderList();
    try{
      const r = await api({ action: 'list', tab: S.tab, limit: PAGE, cursor: reset ? undefined : S.cursor });
      if(seq !== listSeq) return;
      S.items = reset ? r.items : S.items.concat(r.items);
      S.cursor = r.nextCursor; S.hasMore = !!r.hasMore; S.listError = null;
    }catch(e){
      if(seq !== listSeq) return;
      S.listError = Object.assign({ status: e.status, message: e.message }, e.payload || {});
    }
    S.loading = false;
    if(seq === listSeq) renderList();
  }

  function setTab(tab){
    if(S.tab === tab && S.items.length) return;
    S.tab = tab;
    renderStats(); renderTabs();
    loadList(true);
  }

  async function refreshAll(manual){
    const btn = built ? $('apmRefresh') : null;
    if(btn) btn.disabled = true;
    await Promise.all([loadStats(), loadList(true)]);
    if(btn) btn.disabled = false;
    if(manual) say('আপডেট হয়েছে');
  }

  // ------------------------------------------------------------------------------------------ actions
  const DONE_MSG = {
    approve: 'স্টোরিটি অনুমোদিত ও প্রকাশিত হয়েছে', reject: 'স্টোরিটি প্রত্যাখ্যাত হয়েছে',
    remove: 'প্রকাশিত স্টোরি সরিয়ে ফেলা হয়েছে', remoderate: 'AI আবার যাচাই করেছে',
  };
  async function act(kind, it, extra){
    if(S.busy[it.id]) return null;
    if(kind === 'remove' && !window.confirm('এই প্রকাশিত স্টোরিটি ফিড থেকে সরিয়ে ফেলবেন?\n(ব্যবহারকারীর জমা-রেকর্ডে "প্রত্যাখ্যাত" হিসেবে থাকবে; এটি আর ফেরানো যাবে না।)')) return null;
    S.busy[it.id] = true; renderList(); if(sheetEl) renderSheet();
    try{
      const r = await api(Object.assign({ action: kind, id: it.id }, extra || {}));
      say(DONE_MSG[kind] || 'সম্পন্ন হয়েছে');
      delete S.busy[it.id];
      await Promise.all([loadStats(), loadList(true)]);
      return r;
    }catch(e){
      delete S.busy[it.id];
      say(errText(e), false);
      if(e.status === 409) await Promise.all([loadStats(), loadList(true)]);
      else { renderList(); }
      return null;
    }
  }

  // ------------------------------------------------------------------------------------------ detail sheet
  function closeSheet(){
    if(sheetEl && sheetEl.parentNode) sheetEl.parentNode.removeChild(sheetEl);
    sheetEl = null; S.detail = null;
    document.removeEventListener('keydown', onSheetKey, true);
  }
  function onSheetKey(e){ if(e.key === 'Escape' && sheetEl){ e.preventDefault(); e.stopPropagation(); closeSheet(); } }

  async function openDetail(id){
    S.detail = { id, data: null, error: null, loading: true };
    const host = document.getElementById('apOverlay') || document.body;
    if(!sheetEl){
      sheetEl = h('div', { id: 'apmSheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'স্টোরির বিস্তারিত' });
      sheetEl.addEventListener('click', (ev) => { if(ev.target === sheetEl) closeSheet(); });
      host.appendChild(sheetEl);
      document.addEventListener('keydown', onSheetKey, true);
    }
    renderSheet();
    try{
      const data = await api({ action: 'get', id });
      if(!S.detail || S.detail.id !== id) return;
      S.detail.data = data; S.detail.loading = false;
    }catch(e){
      if(!S.detail || S.detail.id !== id) return;
      S.detail.loading = false; S.detail.error = e;
    }
    renderSheet();
  }

  function kv(pairs){
    const dl = h('dl', { class: 'apm-kv' });
    pairs.forEach(([k, v]) => {
      if(v == null || v === '') return;
      dl.appendChild(h('dt', { text: k })); dl.appendChild(h('dd', null, typeof v === 'string' ? [v] : [v]));
    });
    return dl;
  }

  const SAFE_BG = /^(#[0-9A-Fa-f]{6}|linear-gradient\(135deg,#[0-9A-Fa-f]{6},#[0-9A-Fa-f]{6}\))$/;
  const SAFE_COLOR = /^#[0-9A-Fa-f]{6}$/;

  function previewBlock(d){
    const it = d.item, m = d.media || {};
    const kids = [];
    if(it.type === 'image'){
      if(m.imageData && /^data:image\/(jpeg|png|webp);base64,/.test(m.imageData)) kids.push(h('img', { class: 'apm-media', src: m.imageData, alt: 'স্টোরির ছবি' }));
      else kids.push(h('div', { class: 'apm-note', text: it.hasImage ? 'ছবিটি আর সংরক্ষিত নেই (প্রত্যাখ্যাত/সরানো হয়েছে বা প্রকাশিত কপি মুছে গেছে)।' : 'ছবি নেই।' }));
      if(it.text) kids.push(h('p', { class: 'apm-text', text: it.text }));
    } else {
      const st = it.style || {};
      const box = h('div', { class: 'apm-preview', text: it.text || (it.type === 'voice' ? '🎙 ভয়েস স্টোরি' : '🎵') });
      if(st.bg && SAFE_BG.test(st.bg)) box.style.background = st.bg;
      if(st.textColor && SAFE_COLOR.test(st.textColor)) box.style.color = st.textColor;
      if(['left', 'center', 'right'].includes(st.align)) box.style.textAlign = st.align;
      kids.push(box);
    }
    if(m.audioData && /^data:audio\/[a-z0-9.+-]+(;[a-z0-9.+=_-]+)*;base64,/i.test(m.audioData)){
      kids.push(h('div', { class: 'apm-note', text: (it.type === 'voice' ? 'ভয়েস রেকর্ডিং' : 'ব্যাকগ্রাউন্ড অডিও') + (m.audioName ? ' — ' + m.audioName : '') }));
      const a = h('audio', { controls: true, preload: 'none' }); a.src = m.audioData; kids.push(a);
    } else if(it.hasAudio){
      kids.push(h('div', { class: 'apm-note', text: 'অডিও আর সংরক্ষিত নেই।' }));
    }
    if(d.live === false) kids.push(h('div', { class: 'apm-note', text: 'ফিডে এখন এই স্টোরিটি নেই (ব্যবহারকারী নিজে মুছেছেন বা ২৪ ঘণ্টা পেরিয়েছে)।' }));
    return kids;
  }

  function decisionSection(it){
    const kids = [];
    kids.push(kv([
      ['চূড়ান্ত অবস্থা', chip(statusInfo(it))],
      ['কারণ', it.reasonCode !== 'none' ? it.reasonLabel : 'কোনো সমস্যা পাওয়া যায়নি'],
      ['AI-এর প্রস্তাব', it.decision ? ({ APPROVED: 'অনুমোদন', REJECTED: 'প্রত্যাখ্যান', REVIEW_REQUIRED: 'মানুষের রিভিউ', BLOCKED: 'প্রোভাইডার ব্লক' }[it.decision] || it.decision) : ''],
      ['আত্মবিশ্বাস', it.confidence != null ? pct(it.confidence) : ''],
      ['তীব্রতা', it.severity ? ({ none: 'নেই', low: 'কম', medium: 'মাঝারি', high: 'বেশি' }[it.severity] || it.severity) : ''],
      ['সিদ্ধান্তের উৎস', SOURCE[it.source] || ''],
      ['AI মডেল', it.aiModel || ''],
      ['AI চেষ্টা', it.attempts ? bn(it.attempts) + ' বার' : ''],
      ['ছবি — নগ্নতা/সহিংসতা', it.imageNudity ? (({ none: 'নেই', suggestive: 'সন্দেহজনক', explicit: 'স্পষ্ট' }[it.imageNudity]) + ' / ' + ({ none: 'নেই', mild: 'হালকা', graphic: 'বীভৎস' }[it.imageViolence] || '—')) : ''],
    ]));
    if(it.aiReason) kids.push(h('div', { class: 'apm-quote', text: (it.source === 'system' ? 'সিস্টেমের নোট: ' : 'AI-এর ব্যাখ্যা: ') + it.aiReason }));
    if(it.extractedText) kids.push(h('div', { class: 'apm-quote', text: 'ছবির ভেতরের লেখা (OCR): ' + it.extractedText }));
    if(it.adminNote) kids.push(h('div', { class: 'apm-quote', text: 'অ্যাডমিন নোট: ' + it.adminNote }));
    const notes = (it.systemNotes || []).map((n) => NOTE[n]).filter(Boolean);
    if(it.flags && it.flags.includes('untrusted_audio') && !(it.systemNotes || []).includes('untrusted_audio')) notes.push(NOTE.untrusted_audio);
    if(notes.length) kids.push(h('div', { class: 'apm-meta', style: 'margin-top:8px' }, notes.map((n) => h('span', { class: 'apm-tag warn', text: n }))));
    if(it.status === 'pending' && it.aiError) kids.push(h('div', { class: 'apm-note', style: 'margin-top:8px', text: 'AI ত্রুটির ধরন: ' + it.aiError }));
    return kids;
  }

  function userSection(it){
    const us = it.userStats;
    const kids = [kv([
      ['নাম', it.userName || 'ব্যবহারকারী'],
      ['ইউজার আইডি', h('span', { class: 'apm-uid', text: it.userId })],
      ['এ পর্যন্ত', us ? ('অনুমোদিত ' + bn(us.approved) + ' · প্রত্যাখ্যাত ' + bn(us.rejected) + ' · রিভিউ ' + bn(us.reviewRequired)) : ''],
      ['গত ৩০ দিনে প্রত্যাখ্যাত', us ? bn(us.recentRejections30d) + ' বার' : ''],
    ])];
    if(us && us.repeat) kids.push(h('div', { class: 'apm-meta', style: 'margin-top:8px' }, [h('span', { class: 'apm-badge apm-badge-bad', text: 'বারবার লঙ্ঘনকারী — সতর্কভাবে যাচাই করুন' })]));
    return kids;
  }

  function historySection(d){
    if(!d.history || !d.history.length) return null;
    return h('ul', { class: 'apm-tl' }, d.history.map((ev) => h('li', null, [
      h('span', { class: 'apm-dot ' + ({ approved: 'ok', rejected: 'bad', review_required: 'wait', pending: 'wait', processing: 'info' }[ev.status] || 'info'), style: 'margin-top:6px' }),
      h('div', { class: 'apm-tl-main' }, [
        h('div', { text: (EVENT[ev.event] || ev.event) + (ev.status ? ' → ' + (STATUS[ev.status] ? STATUS[ev.status].label : ev.status) : '') }),
        h('div', { class: 'apm-tl-sub', text: [fmtTime(ev.at), ev.byName || (ev.by && ev.by !== 'ai' && ev.by !== 'system' ? 'অ্যাডমিন' : (SOURCE[ev.by] || '')), ev.reasonCode && ev.reasonCode !== 'none' ? ev.reasonLabel : '', ev.confidence != null ? 'আত্মবিশ্বাস ' + pct(ev.confidence) : '', ev.note].filter(Boolean).join(' · ') }),
      ]),
    ])));
  }

  function previousSection(d){
    const prev = d.previous || [];
    if(!prev.length && !d.previousWarning) return null;
    if(d.previousWarning){
      return h('div', { class: 'apm-note' }, [
        'এই ব্যবহারকারীর আগের রেকর্ড দেখাতে Firestore ইনডেক্স দরকার। ',
        (typeof d.indexUrl === 'string' && d.indexUrl.indexOf('https://console.firebase.google.com/') === 0) ? h('a', { href: d.indexUrl, target: '_blank', rel: 'noopener noreferrer', text: 'ইনডেক্স তৈরি করুন' }) : null,
      ]);
    }
    return h('div', null, prev.map((p) => h('button', { type: 'button', class: 'apm-prev', on: { click: () => openDetail(p.id) } }, [
      chip(statusInfo(p)),
      h('span', { class: 't', text: snippet(p, 60) }),
      h('span', { class: 'apm-tl-sub', text: ago(p.createdAt) }),
    ])));
  }

  function decisionPanel(d){
    const it = d.item;
    const busy = !!S.busy[it.id];
    const canDecide = it.status === 'pending' || it.status === 'review_required' || (it.status === 'processing' && it.stale);
    const wrap = h('div', { class: 'apm-decision' });
    if(canDecide){
      const note = h('textarea', { id: 'apmNote', maxlength: '300', placeholder: 'ঐচ্ছিক নোট (শুধু অ্যাডমিনরা দেখবে)' });
      const sel = h('select', { id: 'apmReason' });
      const dflt = REJECT_REASONS.some(([c]) => c === it.reasonCode) ? it.reasonCode : 'admin_decision';
      REJECT_REASONS.forEach(([c, l]) => { const o = h('option', { value: c, text: l }); if(c === dflt) o.selected = true; sel.appendChild(o); });
      wrap.appendChild(h('div', { class: 'apm-note', text: 'অনুমোদন দিলে স্টোরিটি সঙ্গে সঙ্গে সবার ফিডে প্রকাশিত হবে (২৪ ঘণ্টার মেয়াদ এখন থেকে শুরু)। প্রত্যাখ্যান করলে ব্যবহারকারীকে নির্বাচিত নীতিমালার কারণ সহ জানানো হবে।' }));
      wrap.appendChild(h('label', { for: 'apmNote', text: 'নোট' })); wrap.appendChild(note);
      wrap.appendChild(h('label', { for: 'apmReason', text: 'প্রত্যাখ্যানের কারণ (ব্যবহারকারী দেখবে)' })); wrap.appendChild(sel);
      const row = h('div', { class: 'apm-actions', style: 'margin-top:12px' }, [
        h('button', { type: 'button', class: 'apm-btn apm-btn-ok', disabled: busy, on: { click: () => decide('approve', it) } }, [icon('fa-check'), 'অনুমোদন দিন']),
        h('button', { type: 'button', class: 'apm-btn apm-btn-bad', disabled: busy, on: { click: () => decide('reject', it) } }, [icon('fa-ban'), 'প্রত্যাখ্যান করুন']),
      ]);
      if(it.status === 'pending' || it.stale){
        row.appendChild(h('button', { type: 'button', class: 'apm-btn', disabled: busy, on: { click: () => decide('remoderate', it) } }, [icon('fa-arrows-rotate'), 'AI দিয়ে আবার যাচাই']));
      }
      wrap.appendChild(row);
    } else if(it.status === 'approved'){
      const note = h('textarea', { id: 'apmNote', maxlength: '300', placeholder: 'ঐচ্ছিক নোট (শুধু অ্যাডমিনরা দেখবে)' });
      const sel = h('select', { id: 'apmReason' });
      REJECT_REASONS.forEach(([c, l]) => sel.appendChild(h('option', { value: c, text: l })));
      sel.insertBefore(h('option', { value: 'removed_by_admin', text: 'প্রকাশের পর অ্যাডমিন সরিয়েছেন (সাধারণ)', selected: true }), sel.firstChild);
      wrap.appendChild(h('div', { class: 'apm-note', text: 'এই স্টোরিটি এখন প্রকাশিত। সরালে ফিড থেকে সঙ্গে সঙ্গে চলে যাবে এবং রেকর্ডে "প্রত্যাখ্যাত" হবে।' }));
      wrap.appendChild(h('label', { for: 'apmNote', text: 'নোট' })); wrap.appendChild(note);
      wrap.appendChild(h('label', { for: 'apmReason', text: 'কারণ (ব্যবহারকারী দেখবে)' })); wrap.appendChild(sel);
      wrap.appendChild(h('div', { class: 'apm-actions', style: 'margin-top:12px' }, [
        h('button', { type: 'button', class: 'apm-btn apm-btn-bad', disabled: busy, on: { click: () => decide('remove', it) } }, [icon('fa-trash'), 'প্রকাশিত স্টোরি সরিয়ে ফেলুন']),
      ]));
    } else if(it.status === 'processing'){
      wrap.appendChild(h('div', { class: 'apm-note', text: 'স্টোরিটি এই মুহূর্তে যাচাই হচ্ছে। এক মিনিট পরেও আটকে থাকলে এটি "আটকে যাওয়া" হিসেবে ধরা হবে এবং তখন সিদ্ধান্ত নিতে পারবেন।' }));
    } else {
      wrap.appendChild(h('div', { class: 'apm-note', text: 'প্রত্যাখ্যাত স্টোরির সিদ্ধান্ত বদলানো যায় না। ব্যবহারকারী চাইলে লেখা/ছবি সম্পাদনা করে নতুন করে জমা দিতে পারেন — তখন আবার যাচাই হবে।' }));
    }
    return wrap;
  }

  async function decide(kind, it){
    const noteEl = sheetEl && sheetEl.querySelector('#apmNote');
    const reasonEl = sheetEl && sheetEl.querySelector('#apmReason');
    const extra = {};
    if(noteEl && noteEl.value.trim()) extra.note = noteEl.value.trim().slice(0, 300);
    if(reasonEl && (kind === 'reject' || kind === 'remove')) extra.reasonCode = reasonEl.value;
    const r = await act(kind, it, extra);
    if(r && kind !== 'remoderate') closeSheet();
    else if(r && sheetEl) openDetail(it.id);
  }

  function renderSheet(){
    if(!sheetEl) return;
    const prevScroll = sheetEl.firstChild ? sheetEl.firstChild.scrollTop : 0;
    clear(sheetEl);
    const card = h('div', { class: 'apm-sheet-card' });
    const closeBtn = h('button', { type: 'button', class: 'apm-icon-btn', 'aria-label': 'বন্ধ করুন', on: { click: closeSheet } }, icon('fa-xmark'));
    card.appendChild(h('div', { class: 'apm-sheet-bar' }, [h('h4', { text: 'স্টোরির বিস্তারিত' }), closeBtn]));
    const d = S.detail;
    if(!d || d.loading){
      for(let i = 0; i < 3; i++) card.appendChild(h('div', { class: 'apm-skel', style: 'margin-bottom:10px;height:70px;border-radius:12px;background:var(--panel,#f3efe5)' }));
    } else if(d.error){
      card.appendChild(errorBox(d.error, () => openDetail(d.id)));
    } else {
      const data = d.data, it = data.item;
      const top = h('div', { class: 'apm-sec' }, [
        h('div', { class: 'apm-story-top' }, [chip(statusInfo(it)), typeTag(it), h('span', { class: 'apm-time', text: fmtTime(it.createdAt) })]),
      ]);
      card.appendChild(top);
      card.appendChild(h('div', { class: 'apm-sec' }, previewBlock(data)));
      if(it.text && it.type !== 'text') { /* already shown under the image */ }
      else if(it.text){ card.appendChild(h('div', { class: 'apm-sec' }, [h('h5', { text: 'সম্পূর্ণ লেখা' }), h('p', { class: 'apm-text', text: it.text })])); }
      card.appendChild(h('div', { class: 'apm-sec' }, [h('h5', { text: 'মডারেশন সিদ্ধান্ত' })].concat(decisionSection(it))));
      card.appendChild(h('div', { class: 'apm-sec' }, [h('h5', { text: 'ব্যবহারকারী' })].concat(userSection(it))));
      card.appendChild(h('div', { class: 'apm-sec' }, [h('h5', { text: 'সিদ্ধান্ত নিন' }), decisionPanel(data)]));
      const hist = historySection(data);
      if(hist) card.appendChild(h('div', { class: 'apm-sec' }, [h('h5', { text: 'মডারেশন ইতিহাস' }), hist]));
      const prev = previousSection(data);
      if(prev) card.appendChild(h('div', { class: 'apm-sec' }, [h('h5', { text: 'এই ব্যবহারকারীর আগের রেকর্ড' }), prev]));
    }
    sheetEl.appendChild(card);
    card.scrollTop = prevScroll;
    if(!sheetEl.dataset.focused){ sheetEl.dataset.focused = '1'; try{ closeBtn.focus(); }catch(e){} }
  }

  // ------------------------------------------------------------------------------------------ public
  function mount(container, context){
    if(IS_APP) return;
    ctx = context; root = container;
    injectCSS();
    if(!built || !root.querySelector('#apmStats')) buildShell();
    renderStats(); renderTabs(); renderActivity(); renderRecent(); renderList();
    refreshAll(false);
  }
  function unmount(){
    closeSheet();
    listSeq++;
  }
  // light-weight call used by admin.js right after admin verification, to show the "waiting for review" count on the tab
  async function refreshBadge(context){
    if(IS_APP) return;
    ctx = ctx || context;
    try{
      const token = await context.getIdToken();
      if(!token) return;
      const r = await fetch(ENDPOINT, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ action: 'stats' }) });
      if(!r.ok) return;
      S.stats = await r.json();
      updateBadge();
    }catch(e){ /* the badge is cosmetic */ }
  }

  return { mount, unmount, refreshBadge, isApp: IS_APP };
})();
