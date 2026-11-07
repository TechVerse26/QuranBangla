// ==== status-highlights.js — permanent, personal "Highlights" shelf ====
// A regular status disappears after STATUS_TTL_MS (24h). This feature lets
// the signed-in user save any of their OWN status items — text, photo, or
// voice, background music included — into a small permanent album that
// lives under the status row on the home tab, Instagram-Highlights-style.
// A saved item is a full copy, independent of the original: deleting the
// original 24h status later doesn't touch anything already saved here.
//
// Data lives at users/{uid}/highlights/{highlightId} (see firestore.rules)
// — owner-read/owner-write only, so this is a private shelf for now, not a
// public profile the way Instagram's version is. Each doc carries an
// `album` name (free text the person picks when saving, defaulting to
// "সংরক্ষিত"); the row (rendered into #statusHighlightsRow, which lives on
// the প্রোফাইল page — see js/profile-view.js — right under the bio card,
// Instagram-Highlights-style) groups saved items by that name into one
// bubble per album, and tapping a bubble reopens the exact same
// full-screen viewer used for live statuses (see openStatusViewer(..., 'highlight') and the
// mode-aware branches in js/status.js) — same progress bars, same
// tap-to-advance/hold-to-pause, same audio engine, just no view/react
// tracking and "delete" here means "remove from this album" only.

const STATUS_HIGHLIGHT_DEFAULT_ALBUM = 'সংরক্ষিত';
const STATUS_HIGHLIGHT_CACHE_MS = 60000;

let statusHighlightsCache = null;      // raw docs, [{id, ...data}]
let statusHighlightsCachedAt = 0;
let statusHighlightsLoading = false;

// ---------- local cache: which status IDs are already saved (any album) —
// lets the viewer's star icon fill in instantly without a Firestore round trip ----------
function getHighlightedSourceIds(){
  try{ return new Set(JSON.parse(IDBKV.get('qr_status_highlighted_ids') || '[]')); }catch(e){ return new Set(); }
}
function markSourceHighlightedLocally(sourceId, highlightId){
  try{
    const map = JSON.parse(IDBKV.get('qr_status_highlighted_map') || '{}');
    map[sourceId] = highlightId;
    IDBKV.set('qr_status_highlighted_map', JSON.stringify(map));
    IDBKV.set('qr_status_highlighted_ids', JSON.stringify(Object.keys(map)));
  }catch(e){}
}
function unmarkSourceHighlightedLocally(sourceId){
  try{
    const map = JSON.parse(IDBKV.get('qr_status_highlighted_map') || '{}');
    delete map[sourceId];
    IDBKV.set('qr_status_highlighted_map', JSON.stringify(map));
    IDBKV.set('qr_status_highlighted_ids', JSON.stringify(Object.keys(map)));
  }catch(e){}
}
function highlightIdForSource(sourceId){
  try{ const map = JSON.parse(IDBKV.get('qr_status_highlighted_map') || '{}'); return map[sourceId] || null; }catch(e){ return null; }
}
function isStatusHighlighted(sourceId){ return getHighlightedSourceIds().has(sourceId); }

// ==================================================================
// Save flow — the viewer's star button opens this sheet
// ==================================================================
function openSaveToHighlightFlow(){
  const group = statusViewerState.groups[statusViewerState.groupIndex];
  if(!group || group.uid !== state.user.uid) return;
  const item = group.items[statusViewerState.itemIndex];
  if(!item) return;

  if(isStatusHighlighted(item.id)){
    pauseStatusItemTimer();
    if(!confirm('হাইলাইট থেকে সরিয়ে ফেলতে চান?')){ resumeStatusItemTimer(); return; }
    removeHighlightBySourceId(item.id).then(() => {
      resumeStatusItemTimer();
      const btn = document.getElementById('statusViewHighlightBtn');
      if(btn){ const i = btn.querySelector('i'); if(i) i.className = 'fa-regular fa-star'; }
      showToast('হাইলাইট থেকে সরানো হয়েছে');
    });
    return;
  }

  pauseStatusItemTimer();
  ensureStatusAudioSheet(); // reuse the same bottom-sheet shell as the audio flows
  statusAudioSheetState = { kind:null, slide:null }; // not an audio-sheet flow — just borrowing its DOM/CSS
  document.getElementById('statusAudioSheetTitle').textContent = 'কোন হাইলাইটে যুক্ত করবেন?';
  renderHighlightAlbumPicker(item, group);
  openStatusAudioSheetEl();
}

async function renderHighlightAlbumPicker(item, group){
  const body = document.getElementById('statusAudioSheetBody');
  body.innerHTML = `<div class="status-audio-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> লোড হচ্ছে...</div>`;
  const albums = await fetchStatusHighlightAlbumNames();
  body.innerHTML = `
    ${albums.length ? `<div class="status-highlight-album-row">${albums.map(a => `<button type="button" class="status-highlight-album-chip" data-a="${escapeHtml(a)}">${escapeHtml(a)}</button>`).join('')}</div>` : ''}
    <div class="status-highlight-new-row">
      <input type="text" class="status-highlight-name-input" id="statusHighlightNameInput" placeholder="${escapeHtml(STATUS_HIGHLIGHT_DEFAULT_ALBUM)}" maxlength="60">
      <button type="button" class="status-sheet-btn primary" id="statusHighlightSaveBtn"><i class="fa-solid fa-star"></i> যুক্ত করুন</button>
    </div>`;
  body.querySelectorAll('.status-highlight-album-chip').forEach(chip => {
    chip.onclick = () => { document.getElementById('statusHighlightNameInput').value = chip.dataset.a; };
  });
  document.getElementById('statusHighlightSaveBtn').onclick = () => {
    const name = (document.getElementById('statusHighlightNameInput').value || '').trim().slice(0,60) || STATUS_HIGHLIGHT_DEFAULT_ALBUM;
    saveStatusItemToHighlight(item, name);
  };
}

async function fetchStatusHighlightAlbumNames(){
  const docs = await fetchOwnHighlights();
  const names = new Set(docs.map(d => d.album || STATUS_HIGHLIGHT_DEFAULT_ALBUM));
  return Array.from(names);
}

async function saveStatusItemToHighlight(item, album){
  const btn = document.getElementById('statusHighlightSaveBtn');
  if(btn){ btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>'; }
  try{
    const doc = {
      uid: state.user.uid, name: state.user.name || 'ব্যবহারকারী',
      avatarColor: state.user.avatarColor || '', avatarIcon: state.user.avatarIcon || '',
      type: item.type, album, savedAt: Date.now(), sourceStatusId: item.id
    };
    if(item.type === 'image'){ doc.imageData = item.imageData; if(item.text) doc.text = item.text; }
    else if(item.type === 'voice'){ doc.bg = item.bg; }
    else { doc.text = item.text || ''; doc.bg = item.bg; doc.font = item.font; doc.align = item.align; doc.size = item.size; doc.textColor = item.textColor; doc.highlight = !!item.highlight; }
    if(item.audioData){ doc.audioData = item.audioData; doc.audioDuration = item.audioDuration; doc.audioPeaks = item.audioPeaks || []; if(item.audioName) doc.audioName = item.audioName; }

    const ref = await fbDb.collection('users').doc(state.user.uid).collection('highlights').add(doc);
    markSourceHighlightedLocally(item.id, ref.id);
    statusHighlightsCachedAt = 0; // force a fresh fetch next time the row/sheet needs it
    closeStatusAudioSheet(); // also resumes the paused viewer, see closeStatusAudioSheet()
    const starBtn = document.getElementById('statusViewHighlightBtn');
    if(starBtn){ const i = starBtn.querySelector('i'); if(i) i.className = 'fa-solid fa-star'; }
    showToast('হাইলাইটে যুক্ত হয়েছে');
    renderStatusHighlightsRow();
  }catch(e){
    console.warn('save to highlight failed:', e);
    showToast('হাইলাইটে যুক্ত করা যায়নি');
    if(btn){ btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-star"></i> যুক্ত করুন'; }
  }
}

async function removeHighlightBySourceId(sourceId){
  const highlightId = highlightIdForSource(sourceId);
  unmarkSourceHighlightedLocally(sourceId);
  statusHighlightsCachedAt = 0;
  if(!highlightId) return;
  try{
    await fbDb.collection('users').doc(state.user.uid).collection('highlights').doc(highlightId).delete();
    renderStatusHighlightsRow();
  }catch(e){ console.warn('highlight delete failed:', e); }
}

// Delete button inside the highlight viewer itself (browsing an album,
// not the live-status viewer) — "delete" here just means "take this one
// item out of the album", never touches the original 24h status.
function confirmRemoveFromHighlight(item, group){
  pauseStatusItemTimer();
  if(!confirm('এই আইটেমটি হাইলাইট থেকে সরিয়ে ফেলতে চান?')){ resumeStatusItemTimer(); return; }
  fbDb.collection('users').doc(state.user.uid).collection('highlights').doc(item.id).delete().then(() => {
    if(item.sourceStatusId) unmarkSourceHighlightedLocally(item.sourceStatusId);
    statusHighlightsCachedAt = 0;
    showToast('হাইলাইট থেকে সরানো হয়েছে');
    const idx = group.items.indexOf(item);
    if(idx > -1) group.items.splice(idx, 1);
    if(!group.items.length){ closeStatusViewer(); renderStatusHighlightsRow(); return; }
    statusViewerState.itemIndex = Math.min(statusViewerState.itemIndex, group.items.length - 1);
    renderStatusViewerGroup();
    renderStatusHighlightsRow();
  }).catch(err => {
    console.warn('highlight remove failed:', err);
    showToast('সরানো যায়নি');
    resumeStatusItemTimer();
  });
}

// ==================================================================
// Fetch (cached) + the home-tab row + the highlight viewer
// ==================================================================
async function fetchOwnHighlights(force){
  if(!state.user || typeof fbDb === 'undefined' || !fbDb) return [];
  if(!force && statusHighlightsCache && (Date.now() - statusHighlightsCachedAt) < STATUS_HIGHLIGHT_CACHE_MS) return statusHighlightsCache;
  if(statusHighlightsLoading) return statusHighlightsCache || [];
  statusHighlightsLoading = true;
  try{
    const snap = await fbDb.collection('users').doc(state.user.uid).collection('highlights').orderBy('savedAt','desc').get();
    statusHighlightsCache = snap.docs.map(d => Object.assign({ id:d.id }, d.data()));
    statusHighlightsCachedAt = Date.now();
    return statusHighlightsCache;
  }catch(e){
    console.warn('fetch highlights failed:', e);
    return statusHighlightsCache || [];
  } finally {
    statusHighlightsLoading = false;
  }
}

function highlightAlbumCoverHtml(album){
  const cover = album.items[0];
  if(cover.type === 'image' && cover.imageData){
    return `<div class="status-avatar status-highlight-cover" style="background-image:url('${cover.imageData}');background-size:cover;background-position:center;"></div>`;
  }
  if(cover.type === 'voice'){
    return `<div class="status-avatar status-highlight-cover" style="background:${cover.bg || STATUS_BG_SWATCHES[0]};"><i class="fa-solid fa-microphone"></i></div>`;
  }
  return `<div class="status-avatar status-highlight-cover" style="background:${cover.bg || STATUS_BG_SWATCHES[0]};"><i class="fa-solid fa-star"></i></div>`;
}

async function renderStatusHighlightsRow(){
  const host = document.getElementById('statusHighlightsRow');
  if(!host) return;
  if(!state.user){ host.innerHTML = ''; return; }
  const docs = await fetchOwnHighlights();
  if(!docs.length){ host.innerHTML = ''; return; }

  const albumsMap = {};
  docs.forEach(d => {
    const name = d.album || STATUS_HIGHLIGHT_DEFAULT_ALBUM;
    (albumsMap[name] = albumsMap[name] || []).push(d);
  });
  const albums = Object.keys(albumsMap).map(name => ({ name, items: albumsMap[name] }));

  host.innerHTML = `<div class="status-row status-highlights-inner">${albums.map((a,ai) => `
    <button type="button" class="status-item status-highlight-item" data-ai="${ai}">
      ${highlightAlbumCoverHtml(a)}
      <div class="status-label">${escapeHtml(a.name)}</div>
    </button>`).join('')}</div>`;

  host.querySelectorAll('.status-highlight-item').forEach(btn => {
    btn.onclick = () => {
      const album = albums[parseInt(btn.dataset.ai, 10)];
      openHighlightViewer(album);
    };
  });
}

function openHighlightViewer(album){
  const items = album.items.map(d => Object.assign({}, d)); // items already carry their own id
  const syntheticGroup = {
    uid: state.user.uid, name: album.name,
    avatarColor: state.user.avatarColor || '', avatarIcon: state.user.avatarIcon || '',
    items
  };
  openStatusViewer([syntheticGroup], 0, 0, 'highlight');
}
