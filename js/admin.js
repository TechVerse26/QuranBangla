// =============================================================================
// js/admin.js — Admin Panel (JS-driven overlay, কোনো admin.html নেই)
// =============================================================================
// - Main app এর ভেতরে full-screen overlay হিসেবে render হয়
// - Firestore admins/{uid} (isAdmin:true) দিয়ে access control
// - Non-admin / signed-out → overlay বন্ধ হয়
// =============================================================================

const AdminPanel = (() => {

  /* ── state ── */
  let _db = null, _auth = null, _user = null;
  let _unsub = null, _unsubMusic = null, _unsubErrors = null, _overlay = null, _ready = false;
  let _musicPick = null; // { audioBuffer, fileName, totalSec, maxSec, startSec } — in-progress upload draft
  const AP_MUSIC_MAX_BYTES = 150000; // matches firestore.rules' sharedMusic.audioData cap
  let _errFilterUnresolved = true; // monitoring tab: show only unresolved by default (triage view)
  let _lastErrorDocs = []; // last system_errors snapshot, so the filter toggle re-renders without a re-query

  /* ══════════════════════════════════════════════════════
     CSS — scoped under #apOverlay to avoid conflicts
  ══════════════════════════════════════════════════════ */
  const STYLES = `
  #apOverlay {
    position:fixed;inset:0;z-index:9500;
    background:var(--panel,#f6f4ee);
    display:flex;flex-direction:column;
    font-family:'Hind Siliguri',sans-serif;
    color:var(--ink,#1c2b23);
    overflow:hidden;
    opacity:0;transform:translateY(14px);
    transition:opacity .25s ease,transform .25s ease;
  }
  #apOverlay.ap-in { opacity:1; transform:translateY(0); }

  /* topbar */
  #apOverlay .ap-bar {
    display:flex;align-items:center;justify-content:space-between;
    padding:0 16px;height:54px;min-height:54px;flex-shrink:0;
    background:var(--parchment,#fbf9f4);
    border-bottom:1px solid var(--line,#e2ddd0);
  }
  #apOverlay .ap-bar-left {
    display:flex;align-items:center;gap:9px;
    font-size:15px;font-weight:700;color:var(--ink,#1c2b23);
  }
  #apOverlay .ap-bar-left i { color:var(--gold,#b8863b);font-size:16px; }
  #apOverlay .ap-bar-right { display:flex;align-items:center;gap:8px; }

  /* buttons */
  #apOverlay .ap-btn {
    display:inline-flex;align-items:center;gap:6px;
    padding:8px 15px;border-radius:10px;border:none;
    font-family:'Hind Siliguri',sans-serif;font-size:13px;font-weight:600;
    cursor:pointer;transition:filter .15s,background .15s,opacity .15s;
  }
  #apOverlay .ap-btn:disabled { opacity:.45;cursor:not-allowed; }
  #apOverlay .ap-btn-gold {
    background:var(--gold,#b8863b);color:#fff;
    box-shadow:0 4px 14px -6px rgba(184,134,59,.5);
  }
  #apOverlay .ap-btn-gold:hover:not(:disabled) { filter:brightness(1.06); }
  #apOverlay .ap-btn-outline {
    background:none;border:1px solid var(--line,#e2ddd0);
    color:var(--ink-soft,#5c6d64);
  }
  #apOverlay .ap-btn-outline:hover { background:var(--sage,#e7ecdf); }
  #apOverlay .ap-btn-danger {
    background:none;color:#c0392b;border:1px solid #e6c6c1;font-size:13px;
  }
  #apOverlay .ap-btn-danger:hover { background:#fbeceb; }
  #apOverlay .ap-icon-btn {
    width:32px;height:32px;border-radius:9px;
    border:1px solid var(--line,#e2ddd0);background:var(--parchment,#fbf9f4);
    display:flex;align-items:center;justify-content:center;
    cursor:pointer;color:var(--ink-soft,#5c6d64);font-size:13px;
    transition:background .15s,color .15s;
  }
  #apOverlay .ap-icon-btn:hover { background:var(--sage,#e7ecdf);color:var(--ink,#1c2b23); }
  #apOverlay .ap-icon-btn.d { color:#c0392b;border-color:#e6c6c1; }
  #apOverlay .ap-icon-btn.d:hover { background:#fbeceb; }
  #apOverlay .ap-close-btn {
    width:34px;height:34px;border-radius:9px;border:none;background:none;
    display:flex;align-items:center;justify-content:center;
    cursor:pointer;color:var(--ink-soft,#5c6d64);font-size:17px;
    transition:background .15s;
  }
  #apOverlay .ap-close-btn:hover { background:var(--sage,#e7ecdf); }

  /* who */
  #apOverlay .ap-who {
    font-size:12px;color:var(--ink-soft,#5c6d64);
    max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  }

  /* gate */
  #apOverlay .ap-gate {
    flex:1;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:12px;
    color:var(--ink-soft,#5c6d64);font-size:13.5px;
  }
  #apOverlay .ap-spinner {
    width:26px;height:26px;border-radius:50%;
    border:3px solid var(--line,#e2ddd0);
    border-top-color:var(--gold,#b8863b);
    animation:apSpin .8s linear infinite;
  }
  @keyframes apSpin { to { transform:rotate(360deg); } }

  /* body */
  #apOverlay .ap-body {
    flex:1;overflow-y:auto;
    padding:18px 16px 80px;
    display:flex;flex-direction:column;gap:16px;
    max-width:640px;width:100%;margin:0 auto;box-sizing:border-box;
  }

  /* stats */
  #apOverlay .ap-stats {
    display:grid;grid-template-columns:repeat(3,1fr);
    background:var(--parchment,#fbf9f4);
    border:1px solid var(--line,#e2ddd0);border-radius:13px;overflow:hidden;
  }
  #apOverlay .ap-stat {
    padding:12px 8px;text-align:center;
    border-right:1px solid var(--line,#e2ddd0);
  }
  #apOverlay .ap-stat:last-child { border-right:none; }
  #apOverlay .ap-stat-val {
    font-size:22px;font-weight:800;
    color:var(--gold,#b8863b);line-height:1;
  }
  #apOverlay .ap-stat-lbl {
    font-size:10.5px;color:var(--ink-soft,#5c6d64);
    margin-top:4px;font-weight:600;
  }

  /* card */
  #apOverlay .ap-card {
    background:var(--parchment,#fbf9f4);
    border:1px solid var(--line,#e2ddd0);
    border-radius:14px;padding:18px;
  }
  #apOverlay .ap-card-head {
    display:flex;align-items:center;gap:8px;
    font-size:14px;font-weight:700;color:var(--ink,#1c2b23);
    margin:0 0 16px;
  }
  #apOverlay .ap-card-head i { color:var(--gold,#b8863b);font-size:14px; }

  /* form */
  #apOverlay .ap-field { margin-bottom:13px; }
  #apOverlay .ap-field:last-child { margin-bottom:0; }
  #apOverlay .ap-lbl {
    display:block;font-size:12px;font-weight:600;
    color:var(--ink-soft,#5c6d64);margin-bottom:6px;
  }
  #apOverlay .ap-lbl .req { color:#c0392b; }
  #apOverlay .ap-input,
  #apOverlay .ap-ta {
    width:100%;box-sizing:border-box;
    padding:10px 13px;
    background:#fff;border:1px solid var(--line,#e2ddd0);
    border-radius:10px;outline:none;
    font-family:'Hind Siliguri',sans-serif;font-size:14px;
    color:var(--ink,#1c2b23);
    transition:border-color .18s,box-shadow .18s;
  }
  #apOverlay .ap-input::placeholder,
  #apOverlay .ap-ta::placeholder { color:#b5afa2; }
  #apOverlay .ap-input:focus,
  #apOverlay .ap-ta:focus {
    border-color:var(--gold,#b8863b);
    box-shadow:0 0 0 3px rgba(184,134,59,.12);
  }
  #apOverlay .ap-ta { resize:vertical;min-height:66px; }
  #apOverlay .ap-row { display:grid;grid-template-columns:1fr 1fr;gap:12px; }
  #apOverlay .ap-hint {
    font-size:11.5px;color:var(--ink-soft,#5c6d64);
    margin-top:6px;line-height:1.55;
  }
  #apOverlay .ap-hint i { color:var(--gold,#b8863b);margin-right:3px; }
  #apOverlay .ap-actions { display:flex;gap:8px;margin-top:4px;flex-wrap:wrap; }

  /* exam list */
  #apOverlay .ap-list { display:flex;flex-direction:column; }
  #apOverlay .ap-row-item {
    padding:13px 0;border-bottom:1px solid var(--line,#e2ddd0);
  }
  #apOverlay .ap-row-item:last-child { border-bottom:none;padding-bottom:0; }
  #apOverlay .ap-row-item:first-child { padding-top:0; }
  #apOverlay .ap-row-main { display:flex;align-items:flex-start;gap:10px; }
  #apOverlay .ap-row-body { flex:1;min-width:0; }
  #apOverlay .ap-row-num {
    width:24px;height:24px;flex-shrink:0;
    border-radius:7px;background:var(--sage,#e7ecdf);
    color:var(--ink-soft,#5c6d64);font-size:11px;font-weight:700;
    display:flex;align-items:center;justify-content:center;margin-top:1px;
  }
  #apOverlay .ap-ei-title {
    font-size:14.5px;font-weight:700;color:var(--ink,#1c2b23);
    word-break:break-word;line-height:1.4;
  }
  #apOverlay .ap-ei-desc {
    font-size:12.5px;color:var(--ink-soft,#5c6d64);
    margin-top:2px;word-break:break-word;line-height:1.5;
  }
  #apOverlay .ap-ei-link {
    font-size:12px;color:var(--gold,#b8863b);
    margin-top:4px;word-break:break-all;display:block;text-decoration:none;
  }
  #apOverlay .ap-ei-link:hover { text-decoration:underline; }
  #apOverlay .ap-chips { display:flex;flex-wrap:wrap;gap:6px;margin-top:8px; }
  #apOverlay .ap-chip {
    display:inline-flex;align-items:center;gap:5px;
    font-size:11.5px;font-weight:600;color:var(--ink-soft,#5c6d64);
    background:var(--sage,#e7ecdf);border-radius:999px;padding:3px 10px;
  }
  #apOverlay .ap-chip i { color:var(--gold,#b8863b);font-size:10px; }
  #apOverlay .ap-chip.live {
    color:#1a7a40;background:#e3f5ec;
  }
  #apOverlay .ap-chip.live i { color:#1a7a40; }
  #apOverlay .ap-chip.sched {
    color:#7a5200;background:#fff2d0;
  }
  #apOverlay .ap-chip.sched i { color:#7a5200; }
  #apOverlay .ap-row-btns { display:flex;gap:6px;flex-shrink:0; }

  /* inline edit */
  #apOverlay .ap-ie {
    margin-top:12px;padding:14px;
    background:#fff;border:1px solid var(--line,#e2ddd0);
    border-radius:12px;
  }
  #apOverlay .ap-ie-head {
    font-size:12px;font-weight:700;
    color:var(--gold,#b8863b);margin-bottom:13px;
    display:flex;align-items:center;gap:6px;
  }

  /* empty */
  #apOverlay .ap-empty {
    text-align:center;padding:22px 0;
    font-size:13px;color:var(--ink-soft,#5c6d64);
  }
  #apOverlay .ap-empty i {
    display:block;font-size:22px;
    color:var(--line,#e2ddd0);margin-bottom:8px;
  }

  /* toast */
  #apOverlay .ap-toast {
    position:fixed;bottom:22px;left:50%;
    transform:translateX(-50%) translateY(6px);
    background:var(--ink,#1c2b23);color:#fff;
    padding:10px 18px;border-radius:999px;font-size:13px;
    opacity:0;pointer-events:none;
    transition:opacity .22s,transform .22s;
    z-index:9999;white-space:nowrap;max-width:calc(100vw - 32px);
    display:flex;align-items:center;gap:8px;
    box-shadow:0 6px 20px -6px rgba(0,0,0,.4);
  }
  #apOverlay .ap-toast.on { opacity:1;transform:translateX(-50%) translateY(0); }
  #apOverlay .ap-toast .ok { color:#3eb95f; }
  #apOverlay .ap-toast .er { color:#e74c3c; }

  /* status badge */
  #apOverlay .ap-status {
    display:inline-flex;align-items:center;gap:5px;
    font-size:11.5px;font-weight:600;border-radius:999px;
    padding:3px 10px;margin-top:6px;
  }
  #apOverlay .ap-status.live { background:#e3f5ec;color:#1a7a40; }
  #apOverlay .ap-status.sched { background:#fff2d0;color:#7a5200; }

  @media (max-width:420px) {
    #apOverlay .ap-row { grid-template-columns:1fr; }
    #apOverlay .ap-who { display:none; }
  }

  /* section tabs (exam / music) */
  #apOverlay .ap-tabs{
    display:flex;gap:4px;padding:0 16px;background:var(--parchment,#fbf9f4);
    border-bottom:1px solid var(--line,#e2ddd0);flex-shrink:0;overflow-x:auto;
  }
  #apOverlay .ap-tab{
    padding:12px 6px;background:none;border:none;border-bottom:2px solid transparent;
    font-family:'Hind Siliguri',sans-serif;font-size:13.5px;font-weight:600;white-space:nowrap;
    color:var(--ink-soft,#5c6d64);cursor:pointer;display:flex;align-items:center;gap:7px;margin-right:16px;
    transition:color .15s,border-color .15s;
  }
  #apOverlay .ap-tab i{font-size:13px;}
  #apOverlay .ap-tab.active{color:var(--gold,#b8863b);border-bottom-color:var(--gold,#b8863b);}
  #apOverlay .ap-tab-badge{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#C4584B;color:#fff;font-size:10.5px;font-weight:700;line-height:18px;text-align:center;}
  #apOverlay .ap-tab-badge[hidden]{display:none;}

  /* music: file picker + track rows (waveform/trim classes are reused as-is
     from status-extra.css — .status-trim-*, .status-sheet-btn, .status-audio-*
     are already styled for a light panel background, only these two need a
     light-bg override since they default to the dark composer stage) */
  #apOverlay .status-audio-time{color:var(--ink-soft,#5c6d64);}
  #apOverlay .ap-file-btn{
    display:flex;align-items:center;justify-content:center;gap:9px;width:100%;box-sizing:border-box;
    padding:13px;background:#fff;border:1.5px dashed var(--line,#e2ddd0);border-radius:10px;
    color:var(--ink-soft,#5c6d64);font-family:'Hind Siliguri',sans-serif;font-size:13px;cursor:pointer;
  }
  #apOverlay .ap-file-btn i{font-size:16px;color:var(--gold,#b8863b);}
  #apOverlay .ap-music-row{
    display:flex;align-items:center;gap:11px;padding:12px 0;border-bottom:1px solid var(--line,#e2ddd0);
  }
  #apOverlay .ap-music-row:last-child{border-bottom:none;padding-bottom:0;}
  #apOverlay .ap-music-row:first-child{padding-top:0;}
  #apOverlay .ap-music-play{
    width:32px;height:32px;border-radius:9px;border:none;background:var(--gold,#b8863b);color:#fff;
    display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;font-size:12px;
  }
  #apOverlay .ap-music-info{flex:1;min-width:0;}
  #apOverlay .ap-music-title{font-size:14px;font-weight:700;color:var(--ink,#1c2b23);word-break:break-word;}
  #apOverlay .ap-music-time{font-size:11.5px;color:var(--ink-soft,#5c6d64);margin-top:2px;}

  /* monitoring: error log rows */
  #apOverlay .ap-err-filter{
    display:flex;align-items:center;gap:7px;font-size:12px;color:var(--ink-soft,#5c6d64);
    font-family:'Hind Siliguri',sans-serif;cursor:pointer;user-select:none;margin-left:auto;font-weight:500;
  }
  #apOverlay .ap-err-filter input{accent-color:var(--gold,#b8863b);width:15px;height:15px;}
  #apOverlay .ap-err-row{padding:13px 0;border-bottom:1px solid var(--line,#e2ddd0);cursor:pointer;}
  #apOverlay .ap-err-row:last-child{border-bottom:none;padding-bottom:0;}
  #apOverlay .ap-err-row:first-child{padding-top:0;}
  #apOverlay .ap-err-row.resolved{opacity:.5;}
  #apOverlay .ap-err-top{display:flex;align-items:flex-start;gap:10px;}
  #apOverlay .ap-err-dot{width:8px;height:8px;border-radius:50%;margin-top:6px;flex-shrink:0;background:#c0392b;}
  #apOverlay .ap-err-dot.warning{background:#c98a1f;}
  #apOverlay .ap-err-body{flex:1;min-width:0;}
  #apOverlay .ap-err-msg{font-size:13.5px;font-weight:600;color:var(--ink,#1c2b23);word-break:break-word;}
  #apOverlay .ap-err-meta{font-size:11px;color:var(--ink-soft,#5c6d64);margin-top:3px;}
  #apOverlay .ap-err-actions{display:flex;gap:6px;flex-shrink:0;}
  #apOverlay .ap-err-stack{
    margin-top:10px;padding:10px;background:#fff;border:1px solid var(--line,#e2ddd0);border-radius:8px;
    font-family:monospace;font-size:11px;color:var(--ink-soft,#5c6d64);white-space:pre-wrap;word-break:break-word;
    max-height:200px;overflow-y:auto;display:none;
  }
  #apOverlay .ap-err-row.expanded .ap-err-stack{display:block;}
  `;

  /* ── helpers ── */
  function x(s) {
    return String(s == null ? '' : s)
      .replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function toast(msg, ok = true) {
    const t = _overlay && _overlay.querySelector('.ap-toast');
    if (!t) return;
    t.innerHTML = `<i class="fa-solid ${ok ? 'fa-circle-check ok' : 'fa-circle-xmark er'}"></i>${x(msg)}`;
    t.classList.add('on');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove('on'), 2500);
  }

  function tsToInput(ts) {
    if (!ts || typeof ts.toDate !== 'function') return '';
    const d = ts.toDate(), p = n => String(n).padStart(2,'0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function inputToTs(v) {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d) ? false : firebase.firestore.Timestamp.fromDate(d);
  }

  function fmtTs(ts) {
    if (!ts || typeof ts.toDate !== 'function') return '';
    return ts.toDate().toLocaleString('bn-BD',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  }

  function parseNum(v, label) {
    if (!v) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 999) {
      toast(`${label}: ১–৯৯৯ এর মধ্যে সঠিক সংখ্যা দিন`, false);
      return false;
    }
    return n;
  }

  function DEL() { return firebase.firestore.FieldValue.delete(); }

  /* ── inject CSS once ── */
  function injectCSS() {
    if (document.getElementById('apStyles')) return;
    const s = document.createElement('style');
    s.id = 'apStyles';
    s.textContent = STYLES;
    document.head.appendChild(s);
  }

  /* ── chips HTML ── */
  function chipsHtml(d) {
    let h = '';
    if (Number.isFinite(d.durationMinutes))
      h += `<span class="ap-chip"><i class="fa-regular fa-clock"></i>${d.durationMinutes} মিনিট</span>`;
    if (Number.isFinite(d.questionCount))
      h += `<span class="ap-chip"><i class="fa-solid fa-list-ol"></i>${d.questionCount} টি প্রশ্ন</span>`;
    if (d.publishAt && typeof d.publishAt.toDate === 'function') {
      const future = d.publishAt.toDate() > new Date();
      if (future)
        h += `<span class="ap-chip sched"><i class="fa-solid fa-hourglass-half"></i>শিডিউল: ${x(fmtTs(d.publishAt))}</span>`;
      else
        h += `<span class="ap-chip live"><i class="fa-solid fa-circle-check"></i>লাইভ</span>`;
    }
    return h ? `<div class="ap-chips">${h}</div>` : '';
  }

  /* ── render stats ── */
  function updateStats(docs) {
    let live = 0, sched = 0;
    docs.forEach(({data: d}) => {
      if (d.publishAt && typeof d.publishAt.toDate === 'function' && d.publishAt.toDate() > new Date()) sched++;
      else live++;
    });
    const sv = id => { const e = _overlay.querySelector(`#${id}`); if(e) e.textContent = docs.length === 0 ? '০' : String(docs.length); };
    const sv2 = (id,v) => { const e = _overlay.querySelector(`#${id}`); if(e) e.textContent = String(v); };
    sv2('apStatTotal', docs.length);
    sv2('apStatLive', live);
    sv2('apStatSched', sched);
  }

  /* ── form HTML (new exam) ── */
  function addFormHtml() {
    return `
    <div class="ap-card" id="apAddCard">
      <div class="ap-card-head"><i class="fa-solid fa-circle-plus"></i> নতুন পরীক্ষা যোগ করুন</div>

      <div class="ap-field">
        <label class="ap-lbl">পরীক্ষার নাম <span class="req">*</span></label>
        <input class="ap-input" id="apT" type="text" placeholder="যেমন: সূরা আল-বাকারা কুইজ" autocomplete="off">
      </div>
      <div class="ap-field">
        <label class="ap-lbl">সংক্ষিপ্ত বিবরণ</label>
        <textarea class="ap-ta" id="apD" placeholder="এই পরীক্ষা সম্পর্কে সংক্ষেপে লিখুন..."></textarea>
      </div>
      <div class="ap-field">
        <label class="ap-lbl">পরীক্ষার লিংক <span class="req">*</span></label>
        <input class="ap-input" id="apL" type="url" placeholder="https://...">
      </div>
      <div class="ap-row">
        <div class="ap-field">
          <label class="ap-lbl">সময়সীমা (মিনিট)</label>
          <input class="ap-input" id="apDur" type="number" min="1" max="999" placeholder="যেমন: ৩০">
        </div>
        <div class="ap-field">
          <label class="ap-lbl">প্রশ্ন সংখ্যা</label>
          <input class="ap-input" id="apQ" type="number" min="1" max="999" placeholder="যেমন: ২৫">
        </div>
      </div>
      <div class="ap-field">
        <label class="ap-lbl"><i class="fa-regular fa-clock" style="color:var(--gold,#b8863b)"></i> প্রকাশের সময় (ঐচ্ছিক)</label>
        <input class="ap-input" id="apPA" type="datetime-local">
        <p class="ap-hint"><i class="fa-solid fa-circle-info"></i>খালি রাখলে এখনই দেখা যাবে। সময় দিলে countdown দেখাবে ও সময়মতো স্বয়ংক্রিয়ভাবে আনলক হবে।</p>
      </div>
      <div class="ap-actions">
        <button class="ap-btn ap-btn-gold" id="apAddBtn">
          <i class="fa-solid fa-plus"></i> পরীক্ষা যোগ করুন
        </button>
        <button class="ap-btn ap-btn-outline" id="apClearBtn">
          <i class="fa-solid fa-rotate-left"></i> ফর্ম মুছুন
        </button>
      </div>
    </div>`;
  }

  /* ── form HTML (new shared music track) ── */
  function musicAddFormHtml() {
    return `
    <div class="ap-card" id="apMusicAddCard">
      <div class="ap-card-head"><i class="fa-solid fa-circle-plus"></i> নতুন ট্র্যাক যোগ করুন</div>

      <div class="ap-field">
        <label class="ap-lbl">ট্র্যাকের নাম <span class="req">*</span></label>
        <input class="ap-input" id="apMT" type="text" placeholder="যেমন: নাশিদ — পথের আলো" autocomplete="off">
      </div>
      <div class="ap-field">
        <label class="ap-lbl">অডিও ফাইল <span class="req">*</span></label>
        <label class="ap-file-btn" id="apMusicFileBtn">
          <i class="fa-solid fa-file-audio"></i><span id="apMusicFileLabel">ফাইল বাছুন (mp3 / m4a / wav...)</span>
          <input type="file" accept="audio/*" id="apMusicFileInput" style="display:none;">
        </label>
        <p class="ap-hint"><i class="fa-solid fa-circle-info"></i>সর্বোচ্চ ১৫ সেকেন্ড ব্যবহার হবে — ফাইল বড় হলে পরের ধাপে যেকোনো অংশ বেছে নেওয়া যাবে। শুধু ব্যবহারের অনুমতি আছে এমন অডিও দিন (নিজের তৈরি বা রয়্যালটি-ফ্রি/কপিরাইট-মুক্ত সোর্স) — কপিরাইটেড গান দেবেন না।</p>
      </div>
      <div id="apMusicTrimArea"></div>
    </div>`;
  }

  /* ── build full overlay HTML ── */
  function buildOverlay() {
    const el = document.createElement('div');
    el.id = 'apOverlay';
    el.innerHTML = `
      <div class="ap-bar">
        <div class="ap-bar-left">
          <i class="fa-solid fa-user-shield"></i>
          অ্যাডমিন প্যানেল
        </div>
        <div class="ap-bar-right">
          <span class="ap-who" id="apWho"></span>
          <button class="ap-btn ap-btn-outline" id="apLogout" style="display:none;">
            <i class="fa-solid fa-right-from-bracket"></i> লগআউট
          </button>
          <button class="ap-close-btn" id="apClose"><i class="fa-solid fa-xmark"></i></button>
        </div>
      </div>

      <!-- gate -->
      <div class="ap-gate" id="apGate">
        <div class="ap-spinner"></div>
        <span>যাচাই হচ্ছে...</span>
      </div>

      <!-- tabs (shown once verified) -->
      <div class="ap-tabs" id="apTabs" style="display:none;">
        <button type="button" class="ap-tab active" id="apTabExam" data-tab="exam"><i class="fa-solid fa-pen-to-square"></i> পরীক্ষা</button>
        <button type="button" class="ap-tab" id="apTabMusic" data-tab="music"><i class="fa-solid fa-record-vinyl"></i> মিউজিক</button>
        <button type="button" class="ap-tab" id="apTabErrors" data-tab="errors"><i class="fa-solid fa-heart-pulse"></i> মনিটরিং</button>
        <button type="button" class="ap-tab" id="apTabStories" data-tab="stories" style="display:none;"><i class="fa-solid fa-shield-halved"></i> স্টোরি মডারেশন <span class="ap-tab-badge" id="apStoriesBadge" hidden></span></button>
      </div>

      <!-- main body -->
      <div class="ap-body" id="apBody" style="display:none;">

        <div id="apPanelExam" style="display:flex;flex-direction:column;gap:16px;">
          <!-- stats -->
          <div class="ap-stats">
            <div class="ap-stat">
              <div class="ap-stat-val" id="apStatTotal">—</div>
              <div class="ap-stat-lbl">মোট পরীক্ষা</div>
            </div>
            <div class="ap-stat">
              <div class="ap-stat-val" id="apStatLive">—</div>
              <div class="ap-stat-lbl">এখন লাইভ</div>
            </div>
            <div class="ap-stat">
              <div class="ap-stat-val" id="apStatSched">—</div>
              <div class="ap-stat-lbl">শিডিউল</div>
            </div>
          </div>

          ${addFormHtml()}

          <!-- list -->
          <div class="ap-card">
            <div class="ap-card-head"><i class="fa-solid fa-list"></i> সব পরীক্ষার তালিকা</div>
            <div id="apList"><div class="ap-empty"><i class="fa-solid fa-spinner fa-spin"></i>লোড হচ্ছে...</div></div>
          </div>
        </div>

        <div id="apPanelMusic" style="display:none;flex-direction:column;gap:16px;">
          <!-- stats -->
          <div class="ap-stats" style="grid-template-columns:1fr;">
            <div class="ap-stat">
              <div class="ap-stat-val" id="apMusicStatTotal">—</div>
              <div class="ap-stat-lbl">মোট ট্র্যাক (শেয়ার্ড লাইব্রেরি)</div>
            </div>
          </div>

          ${musicAddFormHtml()}

          <!-- list -->
          <div class="ap-card">
            <div class="ap-card-head"><i class="fa-solid fa-list"></i> সব ট্র্যাকের তালিকা</div>
            <div id="apMusicList"><div class="ap-empty"><i class="fa-solid fa-spinner fa-spin"></i>লোড হচ্ছে...</div></div>
          </div>
        </div>

        <div id="apPanelErrors" style="display:none;flex-direction:column;gap:16px;">
          <!-- stats -->
          <div class="ap-stats">
            <div class="ap-stat">
              <div class="ap-stat-val" id="apErrStatTotal">—</div>
              <div class="ap-stat-lbl">মোট লগ</div>
            </div>
            <div class="ap-stat">
              <div class="ap-stat-val" id="apErrStatUnresolved">—</div>
              <div class="ap-stat-lbl">অসমাধানকৃত</div>
            </div>
            <div class="ap-stat">
              <div class="ap-stat-val" id="apErrStatResolved">—</div>
              <div class="ap-stat-lbl">সমাধান হয়েছে</div>
            </div>
          </div>

          <!-- list -->
          <div class="ap-card">
            <div class="ap-card-head">
              <i class="fa-solid fa-list"></i> এরর লগ
              <label class="ap-err-filter">
                <input type="checkbox" id="apErrFilterToggle" checked>
                শুধু অসমাধানকৃত
              </label>
            </div>
            <div id="apErrList"><div class="ap-empty"><i class="fa-solid fa-spinner fa-spin"></i>লোড হচ্ছে...</div></div>
          </div>
        </div>

        <div id="apPanelStories" style="display:none;flex-direction:column;gap:16px;"></div>
      </div>

      <div class="ap-toast" id="apToast"></div>
      <audio id="apMusicPreviewAudio" style="display:none;"></audio>
    `;
    return el;
  }

  /* ── wire events (called once after overlay is appended) ── */
  function wireEvents() {
    _overlay.querySelector('#apClose').onclick = close;

    _overlay.querySelector('#apLogout').onclick = async () => {
      await _auth.signOut();
      close();
    };

    _overlay.querySelector('#apAddBtn').onclick = addExam;

    _overlay.querySelector('#apClearBtn').onclick = () => {
      ['#apT','#apD','#apL','#apDur','#apQ','#apPA'].forEach(sel => {
        const el = _overlay.querySelector(sel);
        if (el) el.value = '';
      });
      _overlay.querySelector('#apT').focus();
    };

    _overlay.querySelector('#apTabExam').onclick = () => switchTab('exam');
    _overlay.querySelector('#apTabMusic').onclick = () => switchTab('music');
    _overlay.querySelector('#apTabErrors').onclick = () => switchTab('errors');
    _overlay.querySelector('#apTabStories').onclick = () => switchTab('stories');

    _overlay.querySelector('#apErrFilterToggle').onchange = (e) => {
      _errFilterUnresolved = e.target.checked;
      renderErrorList(_lastErrorDocs);
    };

    _overlay.querySelector('#apMusicFileInput').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) handleAdminMusicFilePick(file);
    });
  }

  /* ── tab switching ── */
  function switchTab(tab) {
    _overlay.querySelector('#apTabExam').classList.toggle('active', tab === 'exam');
    _overlay.querySelector('#apTabMusic').classList.toggle('active', tab === 'music');
    _overlay.querySelector('#apTabErrors').classList.toggle('active', tab === 'errors');
    _overlay.querySelector('#apTabStories').classList.toggle('active', tab === 'stories');
    _overlay.querySelector('#apPanelExam').style.display   = tab === 'exam'   ? 'flex' : 'none';
    _overlay.querySelector('#apPanelMusic').style.display  = tab === 'music'  ? 'flex' : 'none';
    _overlay.querySelector('#apPanelErrors').style.display = tab === 'errors' ? 'flex' : 'none';
    _overlay.querySelector('#apPanelStories').style.display = tab === 'stories' ? 'flex' : 'none';
    // স্টোরি মডারেশন ট্যাব: প্রতিবার খোলার সময় সার্ভার থেকে টাটকা ডেটা আনে (js/admin-moderation.js)
    if (tab === 'stories' && window.AdminModeration && !window.AdminModeration.isApp) {
      window.AdminModeration.mount(_overlay.querySelector('#apPanelStories'), moderationContext());
    }
  }

  /* ── story moderation tab: website only, data comes from /api/story-admin (server re-verifies admin on every call) ── */
  function moderationContext() {
    return {
      getIdToken: () => (_auth && _auth.currentUser ? _auth.currentUser.getIdToken() : Promise.resolve(null)),
      toast: (msg, ok) => toast(msg, ok !== false),
    };
  }

  /* ── add exam ── */
  async function addExam() {
    const g = id => _overlay.querySelector(`#${id}`);
    const title = g('apT').value.trim();
    const desc  = g('apD').value.trim();
    const link  = g('apL').value.trim();

    if (!title) { toast('পরীক্ষার নাম লিখুন', false); g('apT').focus(); return; }
    if (!link)  { toast('পরীক্ষার লিংক দিন', false); g('apL').focus(); return; }
    try { new URL(link); } catch(e) { toast('সঠিক URL দিন (https://...)', false); g('apL').focus(); return; }

    const durVal = parseNum(g('apDur').value.trim(), 'সময়সীমা');
    if (durVal === false) return;
    const qVal  = parseNum(g('apQ').value.trim(), 'প্রশ্ন সংখ্যা');
    if (qVal === false) return;
    const paVal = inputToTs(g('apPA').value);
    if (paVal === false) { toast('সঠিক তারিখ ও সময় দিন', false); return; }

    const btn = g('apAddBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> সংরক্ষণ হচ্ছে...';

    try {
      const payload = {
        title, description: desc, link,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        createdBy: _user ? _user.uid : null
      };
      if (durVal !== null) payload.durationMinutes = durVal;
      if (qVal   !== null) payload.questionCount   = qVal;
      if (paVal  !== null) payload.publishAt        = paVal;

      await _db.collection('exams').add(payload);

      // reset
      ['#apT','#apD','#apL','#apDur','#apQ','#apPA'].forEach(sel => {
        const el = _overlay.querySelector(sel);
        if (el) el.value = '';
      });
      toast('নতুন পরীক্ষা সফলভাবে যোগ হয়েছে ✓');
    } catch(e) {
      toast('যোগ করা ব্যর্থ হয়েছে: ' + (e.message || ''), false);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-plus"></i> পরীক্ষা যোগ করুন';
    }
  }

  /* ── render list ── */
  function renderList(docs) {
    updateStats(docs);
    const box = _overlay.querySelector('#apList');
    if (!docs.length) {
      box.innerHTML = '<div class="ap-empty"><i class="fa-solid fa-inbox"></i>এখনো কোনো পরীক্ষা যোগ করা হয়নি।</div>';
      return;
    }
    box.innerHTML = '';
    const ul = document.createElement('div');
    ul.className = 'ap-list';
    docs.forEach(({id, data}, i) => ul.appendChild(buildRow(id, data, i + 1)));
    box.appendChild(ul);
  }

  /* ── build one row ── */
  function buildRow(id, data, num) {
    const row = document.createElement('div');
    row.className = 'ap-row-item';
    row.dataset.id = id;
    row.innerHTML = `
      <div class="ap-row-main">
        <div class="ap-row-num">${num}</div>
        <div class="ap-row-body">
          <div class="ap-ei-title">${x(data.title || '(নাম নেই)')}</div>
          ${data.description ? `<div class="ap-ei-desc">${x(data.description)}</div>` : ''}
          <a class="ap-ei-link" href="${x(data.link||'#')}" target="_blank" rel="noopener">
            <i class="fa-solid fa-arrow-up-right-from-square" style="font-size:9px;margin-right:3px"></i>${x(data.link||'')}
          </a>
          ${chipsHtml(data)}
          <div class="ap-ie-wrap"></div>
        </div>
        <div class="ap-row-btns">
          <button class="ap-icon-btn ap-edit-btn" title="সম্পাদনা"><i class="fa-solid fa-pen"></i></button>
          <button class="ap-icon-btn d ap-del-btn" title="মুছুন"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>`;
    row.querySelector('.ap-edit-btn').onclick = () => toggleEdit(id, data, row);
    row.querySelector('.ap-del-btn').onclick  = () => delExam(id, data.title);
    return row;
  }

  /* ── inline edit toggle ── */
  function toggleEdit(id, data, row) {
    const wrap = row.querySelector('.ap-ie-wrap');
    const editBtn = row.querySelector('.ap-edit-btn');

    if (wrap.children.length) {
      wrap.innerHTML = '';
      editBtn.innerHTML = '<i class="fa-solid fa-pen"></i>';
      return;
    }

    // close any other open edit
    _overlay.querySelectorAll('.ap-ie-wrap').forEach(w => {
      if (w !== wrap && w.children.length) {
        w.innerHTML = '';
        const eb = w.closest('.ap-row-item').querySelector('.ap-edit-btn');
        if (eb) eb.innerHTML = '<i class="fa-solid fa-pen"></i>';
      }
    });

    editBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';

    wrap.innerHTML = `
      <div class="ap-ie">
        <div class="ap-ie-head"><i class="fa-solid fa-pen-to-square"></i> সম্পাদনা করুন</div>
        <div class="ap-field">
          <label class="ap-lbl">পরীক্ষার নাম <span class="req">*</span></label>
          <input class="ap-input ie-t" type="text" value="${x(data.title||'')}">
        </div>
        <div class="ap-field">
          <label class="ap-lbl">বিবরণ</label>
          <textarea class="ap-ta ie-d">${x(data.description||'')}</textarea>
        </div>
        <div class="ap-field">
          <label class="ap-lbl">লিংক <span class="req">*</span></label>
          <input class="ap-input ie-l" type="url" value="${x(data.link||'')}">
        </div>
        <div class="ap-row">
          <div class="ap-field">
            <label class="ap-lbl">সময়সীমা (মিনিট)</label>
            <input class="ap-input ie-dur" type="number" min="1" max="999"
              value="${Number.isFinite(data.durationMinutes) ? data.durationMinutes : ''}">
          </div>
          <div class="ap-field">
            <label class="ap-lbl">প্রশ্ন সংখ্যা</label>
            <input class="ap-input ie-q" type="number" min="1" max="999"
              value="${Number.isFinite(data.questionCount) ? data.questionCount : ''}">
          </div>
        </div>
        <div class="ap-field">
          <label class="ap-lbl">প্রকাশের সময়</label>
          <input class="ap-input ie-pa" type="datetime-local" value="${tsToInput(data.publishAt)}">
          <p class="ap-hint">খালি রাখলে এখনই সবাই দেখবে।</p>
        </div>
        <div class="ap-actions">
          <button class="ap-btn ap-btn-gold ie-save"><i class="fa-solid fa-check"></i> সংরক্ষণ করুন</button>
          <button class="ap-btn ap-btn-outline ie-cancel">বাতিল</button>
        </div>
      </div>`;

    const g = sel => wrap.querySelector(sel);

    g('.ie-cancel').onclick = () => {
      wrap.innerHTML = '';
      editBtn.innerHTML = '<i class="fa-solid fa-pen"></i>';
    };

    g('.ie-save').onclick = async () => {
      const title = g('.ie-t').value.trim();
      const link  = g('.ie-l').value.trim();
      if (!title) { toast('পরীক্ষার নাম লিখুন', false); return; }
      if (!link)  { toast('লিংক দিন', false); return; }
      try { new URL(link); } catch(e) { toast('সঠিক URL দিন', false); return; }

      const durVal = parseNum(g('.ie-dur').value.trim(), 'সময়সীমা');
      if (durVal === false) return;
      const qVal  = parseNum(g('.ie-q').value.trim(), 'প্রশ্ন সংখ্যা');
      if (qVal === false) return;
      const paVal = inputToTs(g('.ie-pa').value);
      if (paVal === false) { toast('সঠিক তারিখ দিন', false); return; }

      const upd = {
        title, description: g('.ie-d').value.trim(), link,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        durationMinutes: durVal !== null ? durVal : DEL(),
        questionCount:   qVal   !== null ? qVal   : DEL(),
        publishAt:       paVal  !== null ? paVal  : DEL()
      };

      const saveBtn = g('.ie-save');
      saveBtn.disabled = true;
      saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> সংরক্ষণ হচ্ছে...';

      try {
        await _db.collection('exams').doc(id).update(upd);
        toast('পরিবর্তন সংরক্ষণ হয়েছে ✓');
        // Firestore realtime re-renders the row; wrap is cleared in the snapshot
      } catch(e) {
        toast('সংরক্ষণ ব্যর্থ: ' + (e.message||''), false);
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="fa-solid fa-check"></i> সংরক্ষণ করুন';
      }
    };
  }

  /* ── delete ── */
  async function delExam(id, title) {
    if (!confirm(`"${title || 'এই পরীক্ষাটি'}" মুছে ফেলতে চান?`)) return;
    try {
      await _db.collection('exams').doc(id).delete();
      toast('পরীক্ষাটি মুছে ফেলা হয়েছে');
    } catch(e) {
      toast('মোছা ব্যর্থ হয়েছে', false);
    }
  }

  /* ══════════════════════════════════════════════════════
     MUSIC TAB — admin-curated shared library (sharedMusic
     collection), browsed by everyone in the status composer's
     music picker (js/status-voice.js). Reuses that file's generic
     audio helpers (statusVoiceDecodeFile/ComputePeaks/RenderClipToBlob,
     statusBlobToDataUrl, statusEstimateBase64Bytes, statusFormatRange,
     fmtTime, clamp) — it's loaded before this file, so these are
     already-defined globals here. Every clip is trimmed to at most
     STATUS_MUSIC_MAX_MS (the same 15s cap status backgrounds use) so it
     can be attached to a status as-is with no further trimming needed.
  ══════════════════════════════════════════════════════ */

  /* ── file picked: decode, then show the right next step ── */
  async function handleAdminMusicFilePick(file) {
    const labelEl = _overlay.querySelector('#apMusicFileLabel');
    const areaEl  = _overlay.querySelector('#apMusicTrimArea');
    if (labelEl) labelEl.textContent = file.name || 'অডিও';
    areaEl.innerHTML = `<p class="ap-hint"><i class="fa-solid fa-circle-notch fa-spin"></i> ফাইল পড়া হচ্ছে...</p>`;
    try {
      const audioBuffer = await statusVoiceDecodeFile(file);
      _musicPick = {
        audioBuffer, fileName: file.name || 'অডিও',
        totalSec: audioBuffer.duration,
        maxSec: Math.min(STATUS_MUSIC_MAX_MS/1000, audioBuffer.duration),
        startSec: 0
      };
      renderAdminMusicTrimArea();
    } catch(e) {
      areaEl.innerHTML = `<p class="ap-hint"><i class="fa-solid fa-triangle-exclamation"></i> এই ফাইলটি পড়া যায়নি — অন্য একটি ফাইল বেছে দেখুন।</p>`;
      _musicPick = null;
    }
  }

  /* ── renders either "whole clip is short enough" or the drag-trim window
     (same track/window/drag mechanic as the status composer's own trim
     screen — see js/status-voice.js renderMusicTrimUI, mirrored here with
     its own #apTrim* ids so the two never collide if both happen to be
     open at once) ── */
  function renderAdminMusicTrimArea() {
    const areaEl = _overlay.querySelector('#apMusicTrimArea');
    if (!_musicPick || !areaEl) return;
    const { audioBuffer, totalSec, maxSec } = _musicPick;

    if (totalSec <= maxSec + 0.05) {
      areaEl.innerHTML = `
        <div class="ap-hint" style="margin-top:10px;"><i class="fa-solid fa-circle-check"></i> পুরো ক্লিপটি (${fmtTime(totalSec)}) ব্যবহার হবে।</div>
        <div class="ap-actions" style="margin-top:10px;">
          <button type="button" class="ap-btn ap-btn-gold" id="apMusicAddBtn"><i class="fa-solid fa-plus"></i> ট্র্যাক যোগ করুন</button>
        </div>`;
      _overlay.querySelector('#apMusicAddBtn').onclick = addMusicTrack;
      return;
    }

    const fullPeaks = statusVoiceComputePeaks(audioBuffer, 90, 0, totalSec);
    areaEl.innerHTML = `
      <div class="status-trim-wrap" style="margin-top:12px;">
        <div class="status-trim-track" id="apTrimTrack">
          <div class="status-voice-bars status-trim-bars">${fullPeaks.map(p => `<div class="status-voice-bar" style="height:${Math.round(p*100)}%"></div>`).join('')}</div>
          <div class="status-trim-window" id="apTrimWindow"></div>
        </div>
        <div class="status-audio-time" id="apTrimTime"></div>
        <div class="status-audio-actions">
          <button type="button" class="status-sheet-btn" id="apTrimPreviewBtn"><i class="fa-solid fa-play"></i> শুনুন</button>
          <button type="button" class="status-sheet-btn primary" id="apMusicAddBtn"><i class="fa-solid fa-check"></i> এই অংশ যোগ করুন</button>
        </div>
      </div>`;

    const track = _overlay.querySelector('#apTrimTrack');
    const win   = _overlay.querySelector('#apTrimWindow');
    const timeEl = _overlay.querySelector('#apTrimTime');
    win.style.width = (totalSec > 0 ? (maxSec/totalSec*100) : 100) + '%';

    function updateWinPos() {
      win.style.left = (totalSec > 0 ? (_musicPick.startSec/totalSec*100) : 0) + '%';
      timeEl.textContent = statusFormatRange(_musicPick.startSec, maxSec, totalSec);
    }
    updateWinPos();

    let dragging = false, dragStartX = 0, dragStartSec = 0;
    win.addEventListener('pointerdown', (e) => {
      dragging = true; dragStartX = e.clientX; dragStartSec = _musicPick.startSec;
      try{ win.setPointerCapture(e.pointerId); }catch(err){}
    });
    win.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const trackW = track.getBoundingClientRect().width || 1;
      const deltaSec = ((e.clientX - dragStartX) / trackW) * totalSec;
      _musicPick.startSec = clamp(dragStartSec + deltaSec, 0, Math.max(0, totalSec - maxSec));
      updateWinPos();
    });
    win.addEventListener('pointerup', () => { dragging = false; });
    win.addEventListener('pointercancel', () => { dragging = false; });
    track.addEventListener('pointerdown', (e) => {
      if (e.target === win) return;
      const rect = track.getBoundingClientRect();
      const frac = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      _musicPick.startSec = clamp(frac*totalSec - maxSec/2, 0, Math.max(0, totalSec - maxSec));
      updateWinPos();
    });

    const previewAudioEl = document.getElementById('apMusicPreviewAudio');
    _overlay.querySelector('#apTrimPreviewBtn').onclick = async () => {
      const btn = _overlay.querySelector('#apTrimPreviewBtn');
      btn.disabled = true;
      try {
        previewAudioEl.pause();
        const blob = await statusVoiceRenderClipToBlob(audioBuffer, _musicPick.startSec, maxSec, STATUS_MUSIC_BITRATE);
        previewAudioEl.src = URL.createObjectURL(blob);
        await previewAudioEl.play();
      } catch(e) { toast('প্রিভিউ চালানো যায়নি', false); }
      btn.disabled = false;
    };

    _overlay.querySelector('#apMusicAddBtn').onclick = addMusicTrack;
  }

  /* ── render final clip + upload to sharedMusic ── */
  async function addMusicTrack() {
    const titleEl = _overlay.querySelector('#apMT');
    const title = (titleEl.value || '').trim();
    if (!title) { toast('ট্র্যাকের নাম লিখুন', false); titleEl.focus(); return; }
    if (!_musicPick) { toast('আগে একটি অডিও ফাইল বাছুন', false); return; }

    const btn = _overlay.querySelector('#apMusicAddBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> প্রসেস হচ্ছে...'; }
    try {
      const { audioBuffer, startSec, maxSec } = _musicPick;
      const blob = await statusVoiceRenderClipToBlob(audioBuffer, startSec, maxSec, STATUS_MUSIC_BITRATE);
      const dataUrl = await statusBlobToDataUrl(blob);
      if (statusEstimateBase64Bytes(dataUrl) > AP_MUSIC_MAX_BYTES) {
        toast('ফাইলটি এখনও বড়, ছোট একটি অংশ বেছে আবার চেষ্টা করুন', false);
        renderAdminMusicTrimArea();
        return;
      }
      const peaks = statusVoiceComputePeaks(audioBuffer, STATUS_PEAK_BARS, startSec, maxSec);
      await _db.collection('sharedMusic').add({
        title,
        audioData: dataUrl,
        duration: Math.round(maxSec*1000),
        peaks,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        createdBy: _user.uid
      });
      toast('নতুন ট্র্যাক যোগ হয়েছে ✓');
      clearMusicForm();
    } catch(e) {
      toast('যোগ করা যায়নি: ' + (e.message||''), false);
      renderAdminMusicTrimArea();
    }
  }

  function clearMusicForm() {
    const titleEl = _overlay.querySelector('#apMT');
    if (titleEl) titleEl.value = '';
    const labelEl = _overlay.querySelector('#apMusicFileLabel');
    if (labelEl) labelEl.textContent = 'ফাইল বাছুন (mp3 / m4a / wav...)';
    const fileInput = _overlay.querySelector('#apMusicFileInput');
    if (fileInput) fileInput.value = '';
    const areaEl = _overlay.querySelector('#apMusicTrimArea');
    if (areaEl) areaEl.innerHTML = '';
    _musicPick = null;
  }

  /* ── list row + render ── */
  function musicRowHtml(id, d) {
    return `<div class="ap-music-row" data-id="${id}">
      <button type="button" class="ap-music-play" data-id="${id}" title="প্রিভিউ"><i class="fa-solid fa-play"></i></button>
      <div class="ap-music-info">
        <div class="ap-music-title">${x(d.title || 'ট্র্যাক')}</div>
        <div class="ap-music-time">${fmtTime((d.duration||0)/1000)}</div>
      </div>
      <button class="ap-icon-btn d" data-id="${id}" data-title="${x(d.title||'')}" title="মুছুন"><i class="fa-solid fa-trash"></i></button>
    </div>`;
  }

  function renderMusicList(docs) {
    const box = _overlay && _overlay.querySelector('#apMusicList');
    if (!box) return;
    const sv = _overlay.querySelector('#apMusicStatTotal');
    if (sv) sv.textContent = docs.length === 0 ? '০' : String(docs.length);

    if (!docs.length) {
      box.innerHTML = `<div class="ap-empty"><i class="fa-solid fa-inbox"></i>এখনো কোনো ট্র্যাক যোগ করা হয়নি।</div>`;
      return;
    }
    box.innerHTML = `<div class="ap-list">${docs.map(({id,data}) => musicRowHtml(id,data)).join('')}</div>`;

    const previewAudioEl = document.getElementById('apMusicPreviewAudio');
    let playingId = null;
    box.querySelectorAll('.ap-music-play').forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.id;
        if (playingId === id && !previewAudioEl.paused) { previewAudioEl.pause(); return; }
        const d = docs.find(item => item.id === id);
        if (!d || !d.data.audioData) return;
        box.querySelectorAll('.ap-music-play i').forEach(i => { i.className = 'fa-solid fa-play'; });
        previewAudioEl.src = d.data.audioData;
        previewAudioEl.play().then(() => {
          playingId = id;
          const i = btn.querySelector('i'); if (i) i.className = 'fa-solid fa-pause';
        }).catch(() => {});
      };
    });
    previewAudioEl.onended = () => {
      box.querySelectorAll('.ap-music-play i').forEach(i => { i.className = 'fa-solid fa-play'; });
      playingId = null;
    };

    box.querySelectorAll('.ap-icon-btn.d').forEach(btn => {
      btn.onclick = () => deleteMusicTrack(btn.dataset.id, btn.dataset.title);
    });
  }

  async function deleteMusicTrack(id, title) {
    if (!confirm(`"${title || 'এই ট্র্যাকটি'}" মুছে ফেলতে চান?`)) return;
    try {
      await _db.collection('sharedMusic').doc(id).delete();
      toast('ট্র্যাকটি মুছে ফেলা হয়েছে');
    } catch(e) {
      toast('মোছা ব্যর্থ হয়েছে', false);
    }
  }

  /* ══════════════════════════════════════════════════════
     MONITORING TAB — viewer for the `system_errors` collection.
     That collection was already being populated (js/error-logger.js
     has been catching window 'error'/'unhandledrejection' and writing
     here all along — see its own comment, which literally says "the
     admin panel shows this"), it just never had a viewer here until now.
  ══════════════════════════════════════════════════════ */

  function errorRowHtml(id, d) {
    let ts = Date.now();
    if (d.timestamp) { ts = typeof d.timestamp.toMillis === 'function' ? d.timestamp.toMillis() : (d.timestamp.seconds ? d.timestamp.seconds*1000 : ts); }
    const ago = (typeof timeAgoBn === 'function') ? timeAgoBn(ts) : '';
    const sev = d.severity === 'warning' ? 'warning' : 'error';
    const sevLabel = sev === 'warning' ? 'সতর্কতা' : 'ত্রুটি';
    const stackText = (d.stack ? d.stack : 'কোনো স্ট্যাক ট্রেস নেই') + (d.uid ? ('\n\nuid: ' + d.uid) : '') + (d.userAgent ? ('\n\nbrowser: ' + d.userAgent) : '');
    return `<div class="ap-err-row${d.resolved ? ' resolved' : ''}" data-id="${id}">
      <div class="ap-err-top">
        <div class="ap-err-dot ${sev}"></div>
        <div class="ap-err-body">
          <div class="ap-err-msg">${x(d.message || 'অজানা এরর')}</div>
          <div class="ap-err-meta">${sevLabel} · ${x(d.page || '')} · ${ago}</div>
        </div>
        <div class="ap-err-actions">
          <button class="ap-icon-btn" data-act="resolve" data-id="${id}" data-resolved="${d.resolved ? 1 : 0}" title="${d.resolved ? 'অসমাধিত হিসেবে মার্ক করুন' : 'সমাধান হয়েছে মার্ক করুন'}"><i class="fa-solid ${d.resolved ? 'fa-rotate-left' : 'fa-check'}"></i></button>
          <button class="ap-icon-btn d" data-act="del" data-id="${id}" title="মুছুন"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>
      <div class="ap-err-stack">${x(stackText)}</div>
    </div>`;
  }

  function renderErrorList(docs) {
    const box = _overlay && _overlay.querySelector('#apErrList');
    if (!box) return;
    const total = docs.length;
    const unresolved = docs.filter(({data}) => !data.resolved).length;
    const svT = _overlay.querySelector('#apErrStatTotal');      if (svT) svT.textContent = toBn(total);
    const svU = _overlay.querySelector('#apErrStatUnresolved'); if (svU) svU.textContent = toBn(unresolved);
    const svR = _overlay.querySelector('#apErrStatResolved');   if (svR) svR.textContent = toBn(total - unresolved);

    const shown = _errFilterUnresolved ? docs.filter(({data}) => !data.resolved) : docs;
    if (!shown.length) {
      box.innerHTML = `<div class="ap-empty"><i class="fa-solid fa-heart-pulse"></i>${_errFilterUnresolved ? 'কোনো অসমাধানকৃত এরর নেই — সব ঠিক আছে ✓' : 'এখনো কোনো এরর লগ হয়নি।'}</div>`;
      return;
    }
    box.innerHTML = shown.map(({id,data}) => errorRowHtml(id,data)).join('');

    box.querySelectorAll('.ap-err-row').forEach(row => {
      row.onclick = (e) => {
        if (e.target.closest('.ap-err-actions')) return;
        row.classList.toggle('expanded');
      };
    });
    box.querySelectorAll('[data-act="resolve"]').forEach(btn => {
      btn.onclick = (e) => { e.stopPropagation(); toggleErrorResolved(btn.dataset.id, btn.dataset.resolved === '1'); };
    });
    box.querySelectorAll('[data-act="del"]').forEach(btn => {
      btn.onclick = (e) => { e.stopPropagation(); deleteError(btn.dataset.id); };
    });
  }

  async function toggleErrorResolved(id, currentlyResolved) {
    try {
      await _db.collection('system_errors').doc(id).update({ resolved: !currentlyResolved });
    } catch(e) { toast('আপডেট করা যায়নি', false); }
  }

  async function deleteError(id) {
    try {
      await _db.collection('system_errors').doc(id).delete();
    } catch(e) { toast('মোছা যায়নি', false); }
  }

  /* ── Firestore listener ── */
  function startListener() {
    if (_unsub) { _unsub(); _unsub = null; }
    _unsub = _db.collection('exams').orderBy('createdAt','asc').onSnapshot(
      snap => renderList(snap.docs.map(d => ({id: d.id, data: d.data()}))),
      err  => {
        const b = _overlay && _overlay.querySelector('#apList');
        if (b) b.innerHTML = `<div class="ap-empty"><i class="fa-solid fa-triangle-exclamation"></i>তালিকা লোড হয়নি: ${x(err.message||'')}</div>`;
      }
    );
  }

  function startMusicListener() {
    if (_unsubMusic) { _unsubMusic(); _unsubMusic = null; }
    _unsubMusic = _db.collection('sharedMusic').orderBy('createdAt','desc').onSnapshot(
      snap => renderMusicList(snap.docs.map(d => ({id: d.id, data: d.data()}))),
      err  => {
        const b = _overlay && _overlay.querySelector('#apMusicList');
        if (b) b.innerHTML = `<div class="ap-empty"><i class="fa-solid fa-triangle-exclamation"></i>তালিকা লোড হয়নি: ${x(err.message||'')}</div>`;
      }
    );
  }

  function startErrorListener() {
    if (_unsubErrors) { _unsubErrors(); _unsubErrors = null; }
    _unsubErrors = _db.collection('system_errors').orderBy('timestamp','desc').limit(100).onSnapshot(
      snap => { _lastErrorDocs = snap.docs.map(d => ({id: d.id, data: d.data()})); renderErrorList(_lastErrorDocs); },
      err  => {
        const b = _overlay && _overlay.querySelector('#apErrList');
        if (b) b.innerHTML = `<div class="ap-empty"><i class="fa-solid fa-triangle-exclamation"></i>তালিকা লোড হয়নি: ${x(err.message||'')}</div>`;
      }
    );
  }

  /* ── verify admin then show panel ── */
  async function verify() {
    const user = _auth.currentUser;
    if (!user) { close(); return; }
    _user = user;

    let admin = false;
    try {
      const doc = await _db.collection('admins').doc(user.uid).get();
      admin = doc.exists && doc.data().isAdmin === true;
    } catch(e) { admin = false; }

    if (!admin) { close(); return; }

    _overlay.querySelector('#apGate').style.display = 'none';
    _overlay.querySelector('#apTabs').style.display = 'flex';
    _overlay.querySelector('#apBody').style.display  = 'flex';
    _overlay.querySelector('#apWho').textContent     = user.email || '';
    _overlay.querySelector('#apLogout').style.display = 'inline-flex';

    startListener();
    startMusicListener();
    startErrorListener();

    if (window.AdminModeration && !window.AdminModeration.isApp) {
      _overlay.querySelector('#apTabStories').style.display = 'flex';
      window.AdminModeration.refreshBadge(moderationContext());
    }
  }

  /* ══ PUBLIC ══ */
  function open() {
    if (typeof firebase === 'undefined') return;

    // resolve db / auth (reuse main app's instances when available)
    _auth = (typeof fbAuth !== 'undefined') ? fbAuth : firebase.auth();
    _db   = (typeof fbDb  !== 'undefined') ? fbDb   : firebase.firestore();

    injectCSS();

    if (!_overlay) {
      _overlay = buildOverlay();
      document.body.appendChild(_overlay);
      wireEvents();
    }

    // reset gate/tabs visibility every open, always starting on the exam tab
    _overlay.querySelector('#apGate').style.display = 'flex';
    _overlay.querySelector('#apTabs').style.display = 'none';
    _overlay.querySelector('#apBody').style.display = 'none';
    _overlay.querySelector('#apLogout').style.display = 'none';
    _overlay.querySelector('#apTabStories').style.display = 'none';
    switchTab('exam');

    _overlay.style.display = 'flex';
    requestAnimationFrame(() => _overlay.classList.add('ap-in'));

    verify();
  }

  function close() {
    if (!_overlay) return;
    _overlay.classList.remove('ap-in');
    setTimeout(() => { if (_overlay) _overlay.style.display = 'none'; }, 280);
    if (_unsub) { _unsub(); _unsub = null; }
    if (_unsubMusic) { _unsubMusic(); _unsubMusic = null; }
    if (_unsubErrors) { _unsubErrors(); _unsubErrors = null; }
    if (window.AdminModeration && window.AdminModeration.unmount) window.AdminModeration.unmount();
    const previewEl = _overlay.querySelector('#apMusicPreviewAudio');
    if (previewEl) { try{ previewEl.pause(); }catch(e){} }
    _user = null;
  }

  return { open, close };
})();
