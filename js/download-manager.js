// ---------- Offline Download Manager (js/download-manager.js) ----------
// A dedicated modal (opened from the drawer, or from Library → Offline) that
// lets the user browse ALL 114 surahs — not just ones already opened — and
// download/delete their tilawat audio for offline use, with a live storage
// summary and per-surah progress. Builds on the existing offline-tracking
// primitives already in js/storage.js (state.offlineSurahs, markSurahOffline,
// removeSurahOffline, isSurahOffline) and the CACHE_AUDIO service-worker
// message already used by the single "Save offline" button in the reader
// (js/player.js) — this just generalizes that flow to any surah number,
// whether or not it has ever been opened.
//
// The modal frames itself as a small "archive": a hero gauge shows how much
// of the 114 surahs are preserved offline, filter chips let the user jump
// straight to what's saved or what's left, and rows use a calmer card style
// with a smoothly animating progress ring while a download is in flight.

// Very rough size estimate only (128kbps audio, ~8s average ayah) — shown
// with an "আনুমানিক" (approximate) label everywhere so it's never presented
// as an exact figure.
const DLM_AVG_MB_PER_AYAH = 0.15;
const DLM_TOTAL_SURAHS = 114;
const DLM_GAUGE_R = 30; // matches the SVG circle radius below
const DLM_GAUGE_C = 2 * Math.PI * DLM_GAUGE_R;

let dlmFilterMode = 'all'; // 'all' | 'saved' | 'unsaved'

function dlmEstimateMB(ayahCount){
  return (ayahCount || 0) * DLM_AVG_MB_PER_AYAH;
}
function dlmFormatMB(mb){
  if(mb < 1) return `${Math.max(1, Math.round(mb*1000))} KB`;
  return `${mb.toFixed(1)} MB`;
}

// Fetches just the global ayah numbers for a surah (used to build audio
// URLs) without going through the full reader/translation pipeline — this
// lets the manager download a surah the user has never opened yet.
async function dlmFetchGlobalNumbers(surahNum){
  const res = await fetch(`${API}/surah/${surahNum}`);
  const data = await res.json();
  if(!data || !data.data || !Array.isArray(data.data.ayahs)) throw new Error('bad-response');
  return data.data.ayahs.map(a => a.number);
}
function dlmAudioUrls(globalNumbers, reciter, surahNum){
  const urls = globalNumbers.map(n => buildAudioUrl(reciter, surahNum, n));
  return [...new Set(urls)]; // পুরো-সূরা-শুধু ক্বারীর ক্ষেত্রে একই ফাইল বারবার না ফেরানোর জন্য
}

// ---------- Storage summary (whole-origin estimate; browsers don't expose
// per-cache size, so this is labelled as the app's total on-device storage,
// not audio-only) ----------
async function dlmStorageEstimate(){
  if(!(navigator.storage && navigator.storage.estimate)) return null;
  try{ return await navigator.storage.estimate(); }catch(e){ return null; }
}
function dlmBytesToMB(bytes){ return bytes / (1024*1024); }

async function dlmRenderSummary(){
  const box = document.getElementById('dlmHero');
  if(!box) return;
  const count = (state.offlineSurahs||[]).length;
  const estimatedMB = (state.offlineSurahs||[]).reduce((sum, o) => sum + dlmEstimateMB(o.ayahCount || 0), 0);
  const pct = Math.min(100, Math.round((count / DLM_TOTAL_SURAHS) * 100));
  const dash = (pct/100) * DLM_GAUGE_C;

  let deviceLine = '';
  const est = await dlmStorageEstimate();
  if(est && est.quota){
    const usedMB = dlmBytesToMB(est.usage||0);
    const quotaMB = dlmBytesToMB(est.quota||1);
    const devicePct = Math.min(100, Math.round((usedMB/quotaMB)*100));
    deviceLine = `<div class="dlm-hero-bar">
        <div class="dlm-hero-bar-track"><div class="dlm-hero-bar-fill" style="width:${devicePct}%"></div></div>
        <span class="dlm-hero-bar-text">${dlmFormatMB(usedMB)} / ${dlmFormatMB(quotaMB)}</span>
      </div>`;
  }

  box.innerHTML = `
    <div class="dlm-gauge">
      <svg viewBox="0 0 72 72">
        <circle class="dlm-gauge-track" cx="36" cy="36" r="${DLM_GAUGE_R}"></circle>
        <circle class="dlm-gauge-fill" cx="36" cy="36" r="${DLM_GAUGE_R}"
          stroke-dasharray="${dash.toFixed(1)} ${DLM_GAUGE_C.toFixed(1)}"></circle>
      </svg>
      <div class="dlm-gauge-label"><b>${toBn(pct)}%</b><span>সংরক্ষিত</span></div>
    </div>
    <div class="dlm-hero-body">
      <div class="dlm-hero-title">${toBn(count)} / ${toBn(DLM_TOTAL_SURAHS)} সূরা অফলাইনে</div>
      <div class="dlm-hero-sub">আনুমানিক ${dlmFormatMB(estimatedMB)} · এই ডিভাইসেই সংরক্ষিত থাকে</div>
      ${deviceLine}
    </div>
    <button class="dlm-clear-btn" id="dlmClearAll" ${count ? '' : 'disabled'}>
      <i class="fa-solid fa-trash-can"></i> সব মুছুন
    </button>`;
  const clearBtn = document.getElementById('dlmClearAll');
  if(clearBtn) clearBtn.onclick = dlmClearAll;

  dlmRenderFilterChips();
}

function dlmRenderFilterChips(){
  const row = document.getElementById('dlmFilterRow');
  if(!row) return;
  const saved = (state.offlineSurahs||[]).length;
  const total = (state.surahList||[]).length || DLM_TOTAL_SURAHS;
  const chips = [
    { key:'all', label:'সব সূরা', count: total },
    { key:'saved', label:'সংরক্ষিত', count: saved },
    { key:'unsaved', label:'বাকি আছে', count: Math.max(0, total - saved) },
  ];
  row.innerHTML = chips.map(c => `
    <button class="dlm-chip${dlmFilterMode===c.key ? ' active' : ''}" data-filter="${c.key}">
      ${c.label} <span class="dlm-chip-count">${toBn(c.count)}</span>
    </button>`).join('');
  row.querySelectorAll('.dlm-chip').forEach(btn => {
    btn.onclick = () => {
      dlmFilterMode = btn.dataset.filter;
      dlmRenderFilterChips();
      dlmRenderList(document.getElementById('dlmSearchInput')?.value);
    };
  });
}

async function dlmClearAll(){
  const entries = [...(state.offlineSurahs||[])];
  if(!entries.length) return;
  const btn = document.getElementById('dlmClearAll');
  if(btn){ btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> মুছে ফেলা হচ্ছে...'; }
  for(const entry of entries){ await removeSurahOffline(entry.surah); }
  await dlmRenderSummary();
  dlmRenderList(document.getElementById('dlmSearchInput')?.value);
  showToast('সব অফলাইন ডাউনলোড মুছে ফেলা হয়েছে');
}

// ---------- Per-row download/delete ----------
async function dlmStartDownload(surahNum, rowEl){
  const actionSlot = rowEl.querySelector('.dlm-row-action');
  const reciter = document.getElementById('dlmReciterSelect')?.value || state.reciter;
  actionSlot.innerHTML = `<div class="dlm-progress-ring" style="--p:0">০%</div>`;
  let globalNumbers;
  try{
    globalNumbers = await dlmFetchGlobalNumbers(surahNum);
  }catch(e){
    showToast('ডাউনলোড শুরু করা যায়নি, আবার চেষ্টা করুন');
    dlmRenderRowAction(actionSlot, surahNum);
    return;
  }
  const urls = dlmAudioUrls(globalNumbers, reciter, surahNum);
  const finish = () => {
    markSurahOffline(surahNum, reciter, urls, urls.length);
    dlmRenderRowAction(actionSlot, surahNum);
    rowEl.classList.add('is-saved');
    dlmRenderSummary();
  };
  const setProgress = (done, total) => {
    const ring = actionSlot.querySelector('.dlm-progress-ring');
    if(!ring) return;
    const pct = total ? Math.round((done/total)*100) : 0;
    ring.style.setProperty('--p', pct);
    ring.textContent = `${toBn(pct)}%`;
  };
  if('serviceWorker' in navigator && navigator.serviceWorker.controller){
    const requestId = `dlm-${surahNum}-${Date.now()}`;
    const onMsg = (event) => {
      const msg = event.data || {};
      if(msg.requestId !== requestId) return;
      if(msg.type === 'CACHE_AUDIO_PROGRESS') setProgress(msg.done, msg.total);
      else if(msg.type === 'CACHE_AUDIO_DONE'){
        navigator.serviceWorker.removeEventListener('message', onMsg);
        finish();
      }
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    navigator.serviceWorker.controller.postMessage({ type: 'CACHE_AUDIO', urls, requestId });
    return;
  }
  // Fallback with no active service worker: cache directly from the page.
  if(!('caches' in window)){ showToast('এই ব্রাউজারে অফলাইন সংরক্ষণ সাপোর্ট নেই'); dlmRenderRowAction(actionSlot, surahNum); return; }
  const cache = await caches.open(AUDIO_CACHE_NAME);
  let done = 0;
  for(const url of urls){
    try{
      const existing = await cache.match(url);
      if(!existing){ const res = await fetch(url, { mode:'no-cors' }); if(res) await cache.put(url, res.clone()); }
    }catch(e){}
    done++; setProgress(done, urls.length);
  }
  finish();
}

async function dlmRemoveDownload(surahNum, rowEl){
  const actionSlot = rowEl.querySelector('.dlm-row-action');
  const btn = actionSlot.querySelector('.dlm-btn');
  if(btn){ btn.disabled = true; btn.classList.add('deleting'); }
  await removeSurahOffline(surahNum);
  rowEl.classList.remove('is-saved');
  dlmRenderRowAction(actionSlot, surahNum);
  dlmRenderSummary();
  // If the current filter is "saved" or "unsaved", this row may no longer
  // belong in the visible list — refresh so the list stays accurate.
  if(dlmFilterMode !== 'all') dlmRenderList(document.getElementById('dlmSearchInput')?.value);
}

function dlmRenderRowAction(actionSlot, surahNum){
  const downloaded = isSurahOffline(surahNum);
  actionSlot.innerHTML = `<button class="dlm-btn${downloaded ? ' saved' : ''}" title="${downloaded ? 'মুছে ফেলুন' : 'ডাউনলোড করুন'}">
    <i class="fa-solid ${downloaded ? 'fa-check' : 'fa-arrow-down'}"></i>
  </button>`;
  const btn = actionSlot.querySelector('.dlm-btn');
  const row = actionSlot.closest('.dlm-row');
  // On the saved state, hovering/tapping reveals the delete intent via CSS
  // (icon + color shift to red) rather than always showing a trash can —
  // calmer at rest, still one tap to remove.
  btn.onmouseenter = () => { if(downloaded) btn.innerHTML = '<i class="fa-solid fa-trash"></i>'; };
  btn.onmouseleave = () => { if(downloaded) btn.innerHTML = '<i class="fa-solid fa-check"></i>'; };
  btn.onclick = () => downloaded ? dlmRemoveDownload(surahNum, row) : dlmStartDownload(surahNum, row);
}

// ---------- List ----------
function dlmRenderList(filterText){
  const container = document.getElementById('dlmList');
  if(!container) return;
  const q = (filterText||'').trim().toLowerCase();
  const list = (state.surahList||[]).filter(s => {
    if(dlmFilterMode === 'saved' && !isSurahOffline(s.number)) return false;
    if(dlmFilterMode === 'unsaved' && isSurahOffline(s.number)) return false;
    if(!q) return true;
    const bnName = surahNamesBn[s.number-1] || '';
    return bnName.toLowerCase().includes(q) || s.englishName.toLowerCase().includes(q) || String(s.number) === q;
  });
  if(!list.length){
    const msg = !state.surahList.length ? 'সূরার তালিকা লোড হচ্ছে...'
      : dlmFilterMode === 'saved' ? 'এখনও কোনো সূরা সংরক্ষিত হয়নি'
      : dlmFilterMode === 'unsaved' ? 'সব সূরাই সংরক্ষিত হয়ে গেছে 🎉'
      : 'কোনো সূরা পাওয়া যায়নি';
    const icon = dlmFilterMode === 'unsaved' && state.surahList.length ? 'fa-circle-check' : 'fa-box-open';
    container.innerHTML = `<div class="dlm-empty-hint"><i class="fa-solid ${icon}"></i>${msg}</div>`;
    return;
  }
  container.innerHTML = '';
  list.forEach(s => {
    const row = document.createElement('div');
    const downloaded = isSurahOffline(s.number);
    row.className = `dlm-row${downloaded ? ' is-saved' : ''}`;
    const sizeMB = dlmEstimateMB(s.numberOfAyahs);
    row.innerHTML = `
      <div class="badge-num">${toBn(s.number)}</div>
      <div class="dlm-row-text">
        <div class="dlm-row-title">${surahNamesBn[s.number-1] || s.englishName}</div>
        <div class="dlm-row-sub">${toBn(s.numberOfAyahs)} আয়াত · আনুমানিক ${dlmFormatMB(sizeMB)}${downloaded ? ' · <span class="dlm-saved-tag"><i class="fa-solid fa-check"></i> সংরক্ষিত</span>' : ''}</div>
      </div>
      <div class="dlm-row-action"></div>`;
    container.appendChild(row);
    dlmRenderRowAction(row.querySelector('.dlm-row-action'), s.number);
  });
}

// ---------- Modal open/build ----------
function openDownloadManager(){
  let modal = document.getElementById('downloadManagerModal');
  if(!modal){
    modal = document.createElement('div');
    modal.className = 'app-modal';
    modal.id = 'downloadManagerModal';
    modal.innerHTML = `
      <div class="app-modal-box dlm-modal-box">
        <div class="app-modal-head">
          <h3><i class="fa-solid fa-box-archive"></i> ডাউনলোড ম্যানেজার</h3>
          <button class="app-modal-close" id="dlmClose">✕</button>
        </div>
        <div class="app-modal-body">
          <div class="dlm-hero" id="dlmHero"></div>
          <div class="dlm-filter-row" id="dlmFilterRow"></div>
          <div class="dlm-controls">
            <div class="dlm-search">
              <i class="fa-solid fa-magnifying-glass"></i>
              <input type="text" id="dlmSearchInput" placeholder="সূরা খুঁজুন...">
            </div>
            <select class="dlm-reciter-select" id="dlmReciterSelect"></select>
          </div>
          <div class="dlm-list" id="dlmList"></div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    wireModalBackdrop('downloadManagerModal');
    document.getElementById('dlmClose').onclick = () => closeModal('downloadManagerModal');
    document.getElementById('dlmSearchInput').oninput = (e) => dlmRenderList(e.target.value);
    const reciterSelect = document.getElementById('dlmReciterSelect');
    reciterSelect.innerHTML = reciters.map(r => `<option value="${r.id}">${r.flag ? r.flag + ' ' : ''}${r.bn || r.name}</option>`).join('');
    reciterSelect.value = state.reciter;
  }
  dlmFilterMode = 'all';
  dlmRenderSummary();
  dlmRenderList(document.getElementById('dlmSearchInput').value);
  openModal('downloadManagerModal');
  if(typeof onbMaybeStart === 'function') onbMaybeStart('downloads');
}
