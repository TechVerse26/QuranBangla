// ---------- WhatsApp-style "Status" feature ----------
// A row of circular avatars sits above the Daily-Ayah card on the home tab —
// your own status (tap the + to post) plus everyone else's active (last
// 24h) statuses. Tapping a circle opens a full-screen story viewer with
// segmented progress bars, tap-to-advance / hold-to-pause, a love-reaction
// (double-tap the middle of the screen, or the heart button) and — for your
// own status only — a "কারা দেখেছে" (who viewed, with a heart mark for
// anyone who also reacted) list with a live count. Both posting AND viewing
// require a completed sign-in/sign-up (js/auth.js openAuthFlow) — there is
// no guest path here.
//
// The composer supports several slides in one sitting (a small "+" queues
// another blank slide, tabs along the top switch between them and every
// slide sends together), an undo stack per slide, and a silently
// auto-saved draft (IDBKV) that's offered back the next time the composer
// opens if it was closed without sending.
//   Text slides:  font cycle, alignment, size, a solid/gradient background
//                 palette, a separate text-colour palette and an optional
//                 solid "highlight" card behind the text.
//   Image slides: pinch-to-zoom + drag-to-pan cropping, a small set of flat
//                 colour-grading filters (no blur/drop-shadow "glow" — just
//                 brightness/contrast/saturation, same restriction as the
//                 rest of this file's visuals), and draggable/resizable text
//                 stickers that get baked into the final image on send.
//
// Firestore layout (see firestore.rules for the matching security rules):
//   statuses/{statusId}                 one doc per posted status/slide
//     uid, name, avatarColor, avatarIcon  — snapshot of the poster
//     type: 'text' | 'image'
//     text        — status text (type:text only; image captions are now
//                   baked directly into imageData, this field is kept
//                   optional purely for backward compatibility with any
//                   still-active status posted by an older cached client)
//     bg          — CSS background value (type:text), one of
//                   STATUS_BG_SWATCHES; bgIndex (legacy, into the old fixed
//                   8-colour array) is still read as a fallback
//     font, align, size, textColor, highlight — text styling (type:text)
//     imageData   — compressed JPEG data URL, crop/filter/stickers baked in
//                   (type:image)
//     createdAt, expiresAt — client epoch-ms (24h TTL; expired ones simply
//                             stop matching the "still active" query below —
//                             no cleanup job needed for them to disappear)
//     viewCount   — denormalized counter, +1 per unique viewer
//     reactCount  — denormalized counter, ±1 as love-reactions toggle
//   statuses/{statusId}/views/{viewerUid}
//     name, avatarColor, avatarIcon, viewedAt
//   statuses/{statusId}/reactions/{reactorUid}
//     name, avatarColor, avatarIcon, reactedAt, type:'love'

const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const STATUS_ITEM_MS = 6000; // how long a single item plays before auto-advancing
const STATUS_ROW_CACHE_MS = 40000;
const STATUS_MAX_SLIDES = 10;
const STATUS_UNDO_LIMIT = 15;
const STATUS_DRAFT_KEY = 'qr_status_draft';
const STATUS_DOUBLE_TAP_MS = 320;

// 16 flat swatches: 8 solid colours (STATUS_BG_COLORS, kept for legacy
// bgIndex look-ups) followed by 8 two-tone diagonal gradients built from the
// same palette — no blur, no glow, just flat colour like everything else.
const STATUS_BG_SWATCHES = [
  '#2E6F5E','#7A2E44','#3D4F8A','#6B3F8A','#8A4A2E','#2E6B8A','#5A6B2E','#3A3A46',
  'linear-gradient(135deg,#2E6F5E,#123B2C)',
  'linear-gradient(135deg,#7A2E44,#3A0F1E)',
  'linear-gradient(135deg,#3D4F8A,#141B3D)',
  'linear-gradient(135deg,#6B3F8A,#24123D)',
  'linear-gradient(135deg,#8A4A2E,#3A2110)',
  'linear-gradient(135deg,#2E6B8A,#0F2A38)',
  'linear-gradient(135deg,#5A6B2E,#22280F)',
  'linear-gradient(135deg,#3A3A46,#16161C)'
];
const STATUS_BG_COLORS = STATUS_BG_SWATCHES.slice(0, 8); // legacy fallback for old bgIndex docs

const STATUS_TEXT_COLORS = ['#FFFFFF','#15151A','#F0C24B','#5FD6B0','#F0879F','#8FC6F0'];

const STATUS_FONTS = [
  { id:'sans',    family:"'Hind Siliguri', sans-serif",           weight:600 },
  { id:'serif',   family:"'Noto Serif Bengali', Georgia, serif",  weight:600 },
  { id:'mono',    family:"'Courier New', monospace",              weight:700 },
  { id:'script',  family:"cursive",                                weight:500 },
  { id:'display', family:"Impact, 'Hind Siliguri', sans-serif",   weight:700, upper:true }
];

// Colour-grading only — brightness/contrast/saturation/hue, never blur() or
// drop-shadow(), so this never turns into the "lighting glow" look.
const STATUS_FILTERS = [
  { id:'normal', label:'নরমাল',    css:'' },
  { id:'vivid',  label:'ভিভিড',    css:'saturate(1.35) contrast(1.1)' },
  { id:'warm',   label:'ওয়ার্ম',   css:'sepia(.22) saturate(1.15) brightness(1.03)' },
  { id:'cool',   label:'কুল',      css:'saturate(1.08) hue-rotate(-6deg) brightness(1.02)' },
  { id:'mono',   label:'সাদাকালো', css:'grayscale(1) contrast(1.06)' },
  { id:'fade',   label:'ফেইড',     css:'brightness(1.08) saturate(.65) contrast(.92)' }
];

let statusGroupsCache = [];  // last fetched groups, {uid,name,avatarColor,avatarIcon,items:[]}[]
let statusRowFetchedAt = 0;
let statusRowLoading = false;

let statusComposerState = { slides: [], activeIndex: 0, sending: false };

let statusViewerState = {
  open:false, groups:[], groupIndex:0, itemIndex:0,
  timer:null, itemStartedAt:0, remainingMs:0, paused:false, currentFill:null,
  mode:'status' // 'status' (live, 24h feed) or 'highlight' (permanent personal album — see status-highlights.js)
};

// ---------- small generic helpers ----------
function clamp(v, min, max){ return Math.max(min, Math.min(max, v)); }
function dist(a, b){ return Math.hypot(a.x - b.x, a.y - b.y); }
function statusUid(){ return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

// ---------- Local (per-device) caches — only drive the ring colour / heart
// state / avoid re-sending duplicate writes; the real counts + viewer list
// always live server-side so they're correct from any device (js/idb.js) ----------
function getSeenStatusIds(){
  try{ return new Set(JSON.parse(IDBKV.get('qr_status_seen') || '[]')); }catch(e){ return new Set(); }
}
function markStatusSeenLocally(id){
  const set = getSeenStatusIds();
  if(set.has(id)) return;
  set.add(id);
  const arr = Array.from(set);
  try{ IDBKV.set('qr_status_seen', JSON.stringify(arr.length > 300 ? arr.slice(arr.length - 300) : arr)); }catch(e){}
}
function getRecordedViewIds(){
  try{ return new Set(JSON.parse(IDBKV.get('qr_status_view_recorded') || '[]')); }catch(e){ return new Set(); }
}
function markViewRecordedLocally(id){
  const set = getRecordedViewIds();
  if(set.has(id)) return;
  set.add(id);
  const arr = Array.from(set);
  try{ IDBKV.set('qr_status_view_recorded', JSON.stringify(arr.length > 500 ? arr.slice(arr.length - 500) : arr)); }catch(e){}
}
function getReactedStatusIds(){
  try{ return new Set(JSON.parse(IDBKV.get('qr_status_reacted') || '[]')); }catch(e){ return new Set(); }
}
function markStatusReactedLocally(id){
  const set = getReactedStatusIds();
  if(set.has(id)) return;
  set.add(id);
  const arr = Array.from(set);
  try{ IDBKV.set('qr_status_reacted', JSON.stringify(arr.length > 500 ? arr.slice(arr.length - 500) : arr)); }catch(e){}
}
function unmarkStatusReactedLocally(id){
  const set = getReactedStatusIds();
  if(!set.has(id)) return;
  set.delete(id);
  try{ IDBKV.set('qr_status_reacted', JSON.stringify(Array.from(set))); }catch(e){}
}

// ==================================================================
// Home-tab row  (unchanged: grouping/ring logic doesn't depend on any of
// the new composer/viewer fields — new fields just ride along inside
// each item's raw data until the viewer reads them)
// ==================================================================
function renderStatusRow(){
  const wrap = document.getElementById('statusRow');
  if(!wrap) return;
  // স্টোরি মডারেশন: অ্যাডমিন-রিভিউয়ের অপেক্ষায় থাকা স্টোরির সিদ্ধান্ত এলে (প্রতি সেশনে একবার) ইউজারকে জানায়।
  if(state.user && window.StoryModeration && typeof window.StoryModeration.checkWatch === 'function'){
    window.StoryModeration.checkWatch({ onApproved: () => { statusRowFetchedAt = 0; renderStatusRow(); } });
  }

  if(!state.user){
    wrap.innerHTML = `
      <button type="button" class="status-locked-bar" id="statusLockedBar">
        <div class="status-locked-ic"><i class="fa-solid fa-circle-user"></i></div>
        <div class="status-locked-text">
          <div class="status-locked-title">স্ট্যাটাস দেখতে সাইন ইন করুন</div>
          <div class="status-locked-sub">অন্যদের স্ট্যাটাস দেখতে ও নিজে স্ট্যাটাস দিতে অ্যাকাউন্ট প্রয়োজন</div>
        </div>
        <i class="fa-solid fa-chevron-left"></i>
      </button>`;
    const bar = document.getElementById('statusLockedBar');
    if(bar) bar.onclick = () => openAuthFlow('choice');
    return;
  }

  if(!document.getElementById('statusRowInner')){
    wrap.innerHTML = `<div class="status-row" id="statusRowInner"></div>`;
  }
  renderStatusRowFromCache();

  const fresh = (Date.now() - statusRowFetchedAt) < STATUS_ROW_CACHE_MS;
  if(!fresh && !statusRowLoading && typeof fbDb !== 'undefined' && firebaseReady){
    statusRowLoading = true;
    fetchAndGroupStatuses().then(groups => {
      statusGroupsCache = groups;
      statusRowFetchedAt = Date.now();
      renderStatusRowFromCache();
    }).finally(() => { statusRowLoading = false; });
  }
}

function fetchAndGroupStatuses(){
  if(!firebaseReady || typeof fbDb === 'undefined' || !fbDb || !state.user) return Promise.resolve(statusGroupsCache);
  const now = Date.now();
  return fbDb.collection('statuses')
    .where('expiresAt', '>', now)
    .orderBy('expiresAt', 'asc')
    .get()
    .then(snap => {
      const byUid = {};
      snap.forEach(docSnap => {
        const d = docSnap.data() || {};
        if(!d.uid || !d.createdAt) return;
        if(!byUid[d.uid]) byUid[d.uid] = { uid:d.uid, name:d.name||'ব্যবহারকারী', avatarColor:d.avatarColor||'', avatarIcon:d.avatarIcon||'', items:[], _latestAt:0 };
        byUid[d.uid].items.push(Object.assign({ id: docSnap.id }, d));
        if(d.createdAt >= byUid[d.uid]._latestAt){
          byUid[d.uid]._latestAt = d.createdAt;
          byUid[d.uid].name = d.name || byUid[d.uid].name;
          byUid[d.uid].avatarColor = d.avatarColor || byUid[d.uid].avatarColor;
          byUid[d.uid].avatarIcon = d.avatarIcon || byUid[d.uid].avatarIcon;
        }
      });
      const groups = Object.values(byUid);
      groups.forEach(g => { g.items.sort((a,b) => a.createdAt - b.createdAt); delete g._latestAt; });
      return groups;
    })
    .catch(err => { console.warn('status row fetch failed:', err); return statusGroupsCache; });
}

function renderStatusRowFromCache(){
  const inner = document.getElementById('statusRowInner');
  if(!inner || !state.user) return;
  const seen = getSeenStatusIds();
  const myUid = state.user.uid;

  function groupHasUnseen(g){ return g.items.some(it => !seen.has(it.id)); }
  function groupLatest(g){ return g.items.length ? g.items[g.items.length - 1].createdAt : 0; }

  const selfGroup = statusGroupsCache.find(g => g.uid === myUid) || null;
  const others = statusGroupsCache.filter(g => g.uid !== myUid);
  const unseenGroups = others.filter(groupHasUnseen).sort((a,b) => groupLatest(b) - groupLatest(a));
  const seenGroups = others.filter(g => !groupHasUnseen(g)).sort((a,b) => groupLatest(b) - groupLatest(a));
  const orderedOthers = unseenGroups.concat(seenGroups);
  const allGroups = (selfGroup ? [selfGroup] : []).concat(orderedOthers);

  let html = '';
  if(selfGroup && selfGroup.items.length){
    const hasUnseen = groupHasUnseen(selfGroup);
    html += `
      <button type="button" class="status-item self ${hasUnseen ? 'has-unseen' : 'all-seen'}" id="statusSelfItem">
        <div class="status-ring"><div class="status-avatar" style="background:${selfGroup.avatarColor || PROFILE_AVATAR_COLORS[0]}">
          ${avatarGlyph({ name: selfGroup.name, avatarIcon: selfGroup.avatarIcon })}
          <span class="status-plus-badge" id="statusSelfPlusBadge"><i class="fa-solid fa-plus"></i></span>
        </div></div>
        <div class="status-label">আমার স্ট্যাটাস</div>
      </button>`;
  } else {
    html += `
      <button type="button" class="status-item self" id="statusSelfItem">
        <div class="status-ring"><div class="status-avatar" style="background:${state.user.avatarColor || PROFILE_AVATAR_COLORS[0]}">
          ${avatarGlyph(state.user)}
          <span class="status-plus-badge" id="statusSelfPlusBadge"><i class="fa-solid fa-plus"></i></span>
        </div></div>
        <div class="status-label">আমার স্ট্যাটাস</div>
      </button>`;
  }

  orderedOthers.forEach(g => {
    const hasUnseen = groupHasUnseen(g);
    const firstName = (g.name || 'ব্যবহারকারী').trim().split(/\s+/)[0];
    html += `
      <button type="button" class="status-item ${hasUnseen ? 'has-unseen' : 'all-seen'}" data-uid="${g.uid}">
        <div class="status-ring"><div class="status-avatar" style="background:${g.avatarColor || PROFILE_AVATAR_COLORS[0]}">
          ${avatarGlyph({ name: g.name, avatarIcon: g.avatarIcon })}
        </div></div>
        <div class="status-label">${escapeHtml(firstName)}</div>
      </button>`;
  });

  inner.innerHTML = html;

  const selfBtn = document.getElementById('statusSelfItem');
  if(selfBtn){
    selfBtn.onclick = () => {
      if(selfGroup && selfGroup.items.length) openStatusViewer(allGroups, 0, 0);
      else openStatusComposer('text');
    };
  }
  const plusBadge = document.getElementById('statusSelfPlusBadge');
  if(plusBadge){
    plusBadge.onclick = (e) => { e.stopPropagation(); openStatusComposer('text'); };
  }
  inner.querySelectorAll('.status-item:not(.self)').forEach(btn => {
    btn.onclick = () => {
      const uid = btn.getAttribute('data-uid');
      const idx = allGroups.findIndex(g => g.uid === uid);
      if(idx === -1) return;
      openStatusViewer(allGroups, idx, 0);
    };
  });
}

// ==================================================================
// Composer — one or more slides (text and/or image), each with its own
// styling/crop/filters/stickers, an undo stack, and a silently
// auto-persisted draft.
// ==================================================================
function makeBlankSlide(){
  return {
    mode: 'text',
    bg: STATUS_BG_SWATCHES[Math.floor(Math.random() * 8)],
    colorPanelTab: 'solid',
    fontIndex: 0,
    align: 'center',
    size: 26,
    textColor: '#ffffff',
    highlight: false,
    textValue: '',
    imageRawDataUrl: null,
    filterId: 'normal',
    frameAspect: 9/16,
    crop: { scale:1, offsetXFrac:0, offsetYFrac:0 },
    textOverlays: [],
    activeOverlayId: null,
    overlayEditMode: null,
    undoStack: [],
    // Standalone voice-status content (slide.mode === 'voice')
    voiceData: null, voiceDuration: null, voicePeaks: null,
    // Background music riding along on a text/image slide (WhatsApp-style,
    // ≤ STATUS_MUSIC_MAX_MS) — independent of mode, so a text OR image
    // slide can carry it
    musicData: null, musicDuration: null, musicPeaks: null, musicName: null, musicTrackId: null
  };
}
function activeSlide(){ return statusComposerState.slides[statusComposerState.activeIndex]; }

function snapshotForUndo(slide){
  return {
    mode: slide.mode, bg: slide.bg, colorPanelTab: slide.colorPanelTab, fontIndex: slide.fontIndex,
    align: slide.align, size: slide.size, textColor: slide.textColor, highlight: slide.highlight,
    textValue: slide.textValue, imageRawDataUrl: slide.imageRawDataUrl, filterId: slide.filterId,
    frameAspect: slide.frameAspect,
    crop: slide.crop ? { ...slide.crop } : { scale:1, offsetXFrac:0, offsetYFrac:0 },
    textOverlays: (slide.textOverlays || []).map(o => ({ ...o }))
  };
}
function pushUndoSnapshot(){
  const slide = activeSlide();
  if(!slide) return;
  slide.undoStack = slide.undoStack || [];
  slide.undoStack.push(snapshotForUndo(slide));
  if(slide.undoStack.length > STATUS_UNDO_LIMIT) slide.undoStack.shift();
  renderComposerChrome();
}
function undoComposerChange(){
  const slide = activeSlide();
  if(!slide || !slide.undoStack || !slide.undoStack.length) return;
  const snap = slide.undoStack.pop();
  Object.assign(slide, snap);
  slide.activeOverlayId = null;
  slide.overlayEditMode = null;
  renderComposerStage();
  saveComposerDraft();
}

function ensureStatusComposerOverlay(){
  let ov = document.getElementById('statusComposerOverlay');
  if(ov) return ov;
  ov = document.createElement('div');
  ov.id = 'statusComposerOverlay';
  ov.className = 'status-overlay';
  ov.innerHTML = `
    <div class="status-comp-topbar">
      <button type="button" class="status-comp-close" id="statusCompClose"><i class="fa-solid fa-xmark"></i></button>
      <div class="status-comp-topbar-right">
        <button type="button" class="status-comp-tool-btn" id="statusCompUndoBtn" title="আনডু"><i class="fa-solid fa-rotate-left"></i></button>
        <button type="button" class="status-comp-tool-btn" id="statusCompTrashBtn" title="মুছুন"><i class="fa-solid fa-trash"></i></button>
        <button type="button" class="status-comp-tool-btn" id="statusCompAddSlideBtn" title="নতুন স্লাইড">
          <i class="fa-solid fa-plus"></i>
          <span class="status-comp-slide-badge" id="statusCompSlideBadge" style="display:none;"></span>
        </button>
      </div>
    </div>
    <div class="status-comp-slidetabs" id="statusCompSlideTabs" style="display:none;"></div>
    <div class="status-comp-stage" id="statusCompStage"></div>
    <div class="status-comp-toolbar" id="statusCompToolbar"></div>
    <div class="status-comp-bottompanel" id="statusCompBottomPanel"></div>
    <div class="status-comp-bottombar">
      <div class="status-comp-counter" id="statusCompCounter"></div>
      <button type="button" class="status-comp-send" id="statusCompSend"><i class="fa-solid fa-check"></i></button>
    </div>`;
  document.body.appendChild(ov);

  document.getElementById('statusCompClose').onclick = closeStatusComposer;
  document.getElementById('statusCompSend').onclick = submitStatus;
  document.getElementById('statusCompUndoBtn').onclick = undoComposerChange;
  document.getElementById('statusCompTrashBtn').onclick = handleComposerTrashTap;
  document.getElementById('statusCompAddSlideBtn').onclick = addComposerSlide;

  return ov;
}

function openStatusComposer(mode){
  if(!state.user){ if(typeof openAuthFlow === 'function') openAuthFlow('choice'); return; }
  ensureStatusComposerOverlay();

  const draft = loadComposerDraft();
  if(draft && draft.slides && draft.slides.length){
    draft.slides.forEach(s => {
      s.undoStack = []; s.activeOverlayId = null; s.overlayEditMode = null; s.textOverlays = s.textOverlays || [];
      s.crop = s.crop || { scale:1, offsetXFrac:0, offsetYFrac:0 };
      if(s.voiceData === undefined) s.voiceData = null;
      if(s.voiceDuration === undefined) s.voiceDuration = null;
      if(s.voicePeaks === undefined) s.voicePeaks = null;
      if(s.musicData === undefined) s.musicData = null;
      if(s.musicDuration === undefined) s.musicDuration = null;
      if(s.musicPeaks === undefined) s.musicPeaks = null;
      if(s.musicName === undefined) s.musicName = null;
      if(s.musicTrackId === undefined) s.musicTrackId = null;
    });
    statusComposerState = { slides: draft.slides, activeIndex: clamp(draft.activeIndex || 0, 0, draft.slides.length - 1), sending: false };
    showToast('খসড়া পুনরুদ্ধার করা হয়েছে');
  } else {
    statusComposerState = { slides: [ makeBlankSlide() ], activeIndex: 0, sending: false };
  }

  renderComposerStage();
  document.getElementById('statusComposerOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  if(mode === 'image'){
    const fi = document.getElementById('statusCompFileInput');
    if(fi) fi.click();
  }
}

function closeStatusComposer(){
  if(statusComposerState.sending) return;
  finalizeActiveOverlayIfAny();
  if(typeof closeStatusAudioSheet === 'function') closeStatusAudioSheet();
  if(typeof statusVoicePauseAllComposerAudio === 'function') statusVoicePauseAllComposerAudio();
  saveComposerDraft();
  const ov = document.getElementById('statusComposerOverlay');
  if(ov) ov.classList.remove('open');
  document.body.style.overflow = '';
}

function finalizeActiveOverlayIfAny(){
  const slide = activeSlide();
  if(slide && slide.activeOverlayId){
    const frame = document.getElementById('statusImgFrame');
    if(frame) finalizeActiveOverlay(slide, frame);
  }
}

// ---------- top chrome: undo/trash enabled state + slide tabs/badge ----------
function renderComposerChrome(){
  const slides = statusComposerState.slides;
  const slide = activeSlide();
  const badge = document.getElementById('statusCompSlideBadge');
  if(badge){
    if(slides.length > 1){ badge.style.display = 'flex'; badge.textContent = toBn(slides.length); }
    else badge.style.display = 'none';
  }
  const undoBtn = document.getElementById('statusCompUndoBtn');
  if(undoBtn) undoBtn.classList.toggle('disabled', !(slide.undoStack && slide.undoStack.length));
  const addBtn = document.getElementById('statusCompAddSlideBtn');
  if(addBtn) addBtn.classList.toggle('disabled', slides.length >= STATUS_MAX_SLIDES);

  const tabsWrap = document.getElementById('statusCompSlideTabs');
  if(tabsWrap){
    if(slides.length <= 1){ tabsWrap.style.display = 'none'; tabsWrap.innerHTML = ''; }
    else {
      tabsWrap.style.display = 'flex';
      tabsWrap.innerHTML = slides.map((s,i) => {
        const active = i === statusComposerState.activeIndex;
        const bgStyle = (s.mode === 'image' && s.imageRawDataUrl)
          ? `background-image:url('${s.imageRawDataUrl}');background-size:cover;background-position:center;`
          : `background:${s.bg || STATUS_BG_SWATCHES[0]};`;
        return `<button type="button" class="status-comp-slide-tab ${active ? 'active' : ''}" data-i="${i}" style="${bgStyle}"></button>`;
      }).join('');
      tabsWrap.querySelectorAll('.status-comp-slide-tab').forEach(btn => {
        btn.onclick = () => switchComposerSlide(parseInt(btn.dataset.i, 10));
      });
    }
  }
}

function switchComposerSlide(idx){
  if(idx === statusComposerState.activeIndex) return;
  finalizeActiveOverlayIfAny();
  if(typeof statusVoicePauseAllComposerAudio === 'function') statusVoicePauseAllComposerAudio();
  statusComposerState.activeIndex = idx;
  renderComposerStage();
}

function addComposerSlide(){
  if(statusComposerState.slides.length >= STATUS_MAX_SLIDES){ showToast(`একটি স্ট্যাটাসে সর্বোচ্চ ${toBn(STATUS_MAX_SLIDES)}টি স্লাইড দেওয়া যায়`); return; }
  finalizeActiveOverlayIfAny();
  statusComposerState.slides.push(makeBlankSlide());
  statusComposerState.activeIndex = statusComposerState.slides.length - 1;
  renderComposerStage();
  saveComposerDraft();
}

function handleComposerTrashTap(){
  const slides = statusComposerState.slides;
  const slide = activeSlide();
  const hasContent = !!(slide.textValue && slide.textValue.trim()) || !!slide.imageRawDataUrl || !!slide.voiceData || !!slide.musicData || (slide.textOverlays && slide.textOverlays.length > 0);
  if(slides.length > 1){
    if(hasContent && !confirm('এই স্লাইডটি মুছে ফেলতে চান?')) return;
    slides.splice(statusComposerState.activeIndex, 1);
    statusComposerState.activeIndex = clamp(statusComposerState.activeIndex, 0, slides.length - 1);
    renderComposerStage();
    saveComposerDraft();
  } else {
    if(!hasContent) return;
    if(!confirm('এই স্লাইডটি খালি করতে চান?')) return;
    statusComposerState.slides[0] = makeBlankSlide();
    renderComposerStage();
    saveComposerDraft();
  }
}

// ---------- main stage render (dispatches to text/image renderer) ----------
function renderComposerStage(){
  const stage = document.getElementById('statusCompStage');
  if(!stage) return;
  const slide = activeSlide();
  if(slide.mode === 'image' && slide.imageRawDataUrl){
    renderImageStage(stage, slide);
  } else if(slide.mode === 'voice' && slide.voiceData){
    renderVoiceStage(stage, slide);
  } else {
    slide.mode = 'text';
    renderTextStage(stage, slide);
  }
  if(typeof renderComposerMusicChip === 'function') renderComposerMusicChip(stage, slide);
  renderComposerToolbar();
  renderComposerBottomPanel();
  renderComposerCounter();
  renderComposerChrome();
  if(window.StoryModeration && typeof window.StoryModeration.renderSlideBanner === 'function') window.StoryModeration.renderSlideBanner();
}

function renderComposerCounter(){
  const el = document.getElementById('statusCompCounter');
  if(!el || statusComposerState.sending) return;
  const slide = activeSlide();
  if(slide.mode === 'text'){
    const len = (slide.textValue || '').length;
    el.textContent = `${toBn(len)}/${toBn(700)}`;
    el.classList.toggle('warn', len > 650);
  } else if(slide.mode === 'voice' && slide.voiceData){
    el.textContent = `🎤 ${fmtTime((slide.voiceDuration||0)/1000)}`;
    el.classList.remove('warn');
  } else {
    el.textContent = '';
    el.classList.remove('warn');
  }
}

// ---------- TEXT slide ----------
function renderTextStage(stage, slide){
  stage.style.background = slide.bg || STATUS_BG_SWATCHES[0];
  stage.innerHTML = `<textarea class="status-comp-textarea" id="statusCompTextarea" maxlength="700" placeholder="একটি স্ট্যাটাস লিখুন..."></textarea>`;
  const ta = document.getElementById('statusCompTextarea');
  ta.value = slide.textValue || '';
  ta.style.textAlign = slide.align || 'center';
  ta.style.fontSize = (slide.size || 26) + 'px';
  ta.style.color = slide.textColor || '#ffffff';
  ta.classList.toggle('highlight', !!slide.highlight);
  applyTextareaFont(ta, slide);
  let dirtyTimer = null;
  ta.oninput = () => {
    slide.textValue = ta.value;
    renderComposerCounter();
    clearTimeout(dirtyTimer);
    dirtyTimer = setTimeout(saveComposerDraft, 500);
  };
  setTimeout(() => { try{ ta.focus(); }catch(e){} }, 60);
}
function applyTextareaFont(ta, slide){
  const f = STATUS_FONTS[slide.fontIndex || 0];
  ta.style.fontFamily = f.family;
  ta.style.fontWeight = f.weight || 600;
  ta.style.textTransform = f.upper ? 'uppercase' : 'none';
}

// ---------- IMAGE slide ----------
function renderImageStage(stage, slide){
  stage.style.background = '#000';
  const filterCss = (STATUS_FILTERS.find(f => f.id === slide.filterId) || STATUS_FILTERS[0]).css;
  stage.innerHTML = `
    <div class="status-img-frame" id="statusImgFrame">
      <div class="status-img-frame-bg" id="statusImgFrameBg" style="background-image:url('${slide.imageRawDataUrl}');filter:blur(32px) brightness(.55)${filterCss ? ' ' + filterCss : ''};"></div>
      <img class="status-crop-img" id="statusCropImg" src="${slide.imageRawDataUrl}" style="filter:${filterCss};">
      <div class="status-overlay-layer" id="statusOverlayLayer"></div>
    </div>`;
  const frame = document.getElementById('statusImgFrame');
  const imgEl = document.getElementById('statusCropImg');
  const setup = () => {
    const r = frame.getBoundingClientRect();
    slide.frameAspect = r.height ? (r.width / r.height) : (9/16);
    applyImageTransform(frame, slide);
    renderOverlaysLayer(slide, frame);
  };
  // imageRawDataUrl is a data: URL so decode is near-instant, but naturalWidth
  // is 0 until it actually finishes — applyImageTransform's contain-scale math
  // needs the real dimensions, so wait for load rather than assuming it's ready.
  if(imgEl.complete && imgEl.naturalWidth) requestAnimationFrame(setup);
  else imgEl.onload = () => requestAnimationFrame(setup);
  attachImageFrameGestures(frame, slide);
}

function applyImageTransform(frameEl, slide){
  const img = frameEl.querySelector('.status-crop-img');
  if(!img || !img.naturalWidth || !img.naturalHeight) return;
  const rect = frameEl.getBoundingClientRect();
  const scale = clamp(slide.crop.scale || 1, 1, 4);
  slide.crop.scale = scale;
  // img is laid out at width:100%/height:100% with object-fit:contain, so at
  // scale=1 the whole photo is already visible, letterboxed on one axis —
  // that's the new default (no forced crop). scale zooms in from there: the
  // CSS transform scales the element's own box, and since object-fit:contain
  // centers the photo inside that box, scaling the box scales the visible
  // photo by the same factor. Pan bounds are computed from the photo's real
  // rendered size at the current zoom, not assumed from a fixed formula, so
  // this works correctly for any photo aspect ratio.
  const containScale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight) || 1;
  const drawW = img.naturalWidth * containScale * scale;
  const drawH = img.naturalHeight * containScale * scale;
  const maxPanXpx = Math.max(0, (drawW - rect.width) / 2);
  const maxPanYpx = Math.max(0, (drawH - rect.height) / 2);
  let txPx = (slide.crop.offsetXFrac || 0) * rect.width;
  let tyPx = (slide.crop.offsetYFrac || 0) * rect.height;
  txPx = clamp(txPx, -maxPanXpx, maxPanXpx);
  tyPx = clamp(tyPx, -maxPanYpx, maxPanYpx);
  slide.crop.offsetXFrac = rect.width ? txPx / rect.width : 0;
  slide.crop.offsetYFrac = rect.height ? tyPx / rect.height : 0;
  img.style.transform = `translate(${txPx}px, ${tyPx}px) scale(${scale})`;
}

// Pinch-to-zoom (two pointers) + drag-to-pan (one pointer) on the photo
// itself. Ignored while a text sticker is selected — that sticker's own
// gestures (attachOverlayGestures) take over until it's deselected.
function attachImageFrameGestures(frameEl, slide){
  const pointers = new Map();
  let mode = null;
  let panStart = null;
  let pinchStart = null;

  frameEl.addEventListener('pointerdown', (e) => {
    if(slide.activeOverlayId){ finalizeActiveOverlay(slide, frameEl); return; }
    try{ frameEl.setPointerCapture(e.pointerId); }catch(err){}
    if(pointers.size === 0) pushUndoSnapshot();
    pointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
    if(pointers.size === 1){
      mode = 'pan';
      const p = pointers.get(e.pointerId);
      panStart = { x:p.x, y:p.y, offX0: slide.crop.offsetXFrac || 0, offY0: slide.crop.offsetYFrac || 0 };
    } else if(pointers.size === 2){
      mode = 'pinch';
      const pts = Array.from(pointers.values());
      pinchStart = { dist0: dist(pts[0], pts[1]) || 1, scale0: slide.crop.scale || 1 };
    }
  });
  frameEl.addEventListener('pointermove', (e) => {
    if(!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
    if(mode === 'pan' && pointers.size === 1 && panStart){
      const rect = frameEl.getBoundingClientRect();
      const p = pointers.get(e.pointerId);
      const dx = (p.x - panStart.x) / rect.width;
      const dy = (p.y - panStart.y) / rect.height;
      slide.crop.offsetXFrac = panStart.offX0 + dx;
      slide.crop.offsetYFrac = panStart.offY0 + dy;
      applyImageTransform(frameEl, slide);
    } else if(mode === 'pinch' && pointers.size === 2 && pinchStart){
      const pts = Array.from(pointers.values());
      const ratio = dist(pts[0], pts[1]) / pinchStart.dist0;
      slide.crop.scale = clamp(pinchStart.scale0 * ratio, 1, 4);
      applyImageTransform(frameEl, slide);
    }
  });
  function endPointer(e){
    pointers.delete(e.pointerId);
    if(pointers.size === 1){
      mode = 'pan';
      const [, p] = Array.from(pointers.entries())[0];
      panStart = { x:p.x, y:p.y, offX0: slide.crop.offsetXFrac || 0, offY0: slide.crop.offsetYFrac || 0 };
    } else if(pointers.size === 0){
      mode = null; panStart = null; pinchStart = null;
      saveComposerDraft();
    }
  }
  frameEl.addEventListener('pointerup', endPointer);
  frameEl.addEventListener('pointercancel', endPointer);
}

function renderOverlaysLayer(slide, frame){
  const layer = document.getElementById('statusOverlayLayer');
  if(!layer) return;
  const rect = frame.getBoundingClientRect();
  layer.innerHTML = '';
  (slide.textOverlays || []).forEach(ov => {
    const el = document.createElement('div');
    el.className = 'status-text-overlay' + (slide.activeOverlayId === ov.id ? ' active' : '') + (!ov.text ? ' placeholder' : '');
    el.dataset.id = ov.id;
    el.style.left = ov.xPct + '%';
    el.style.top = ov.yPct + '%';
    el.style.color = ov.color || '#ffffff';
    el.style.textAlign = ov.align || 'center';
    el.style.fontSize = Math.max(10, (ov.sizeFrac || 0.08) * rect.width) + 'px';
    el.textContent = ov.text || 'টেক্সট লিখুন';
    layer.appendChild(el);
    attachOverlayGestures(el, ov, slide, frame);
    if(slide.activeOverlayId === ov.id && slide.overlayEditMode === 'text'){
      openOverlayTextEditor(el, ov, slide, frame);
    }
  });
}

function addTextOverlayAction(){
  const slide = activeSlide();
  const frame = document.getElementById('statusImgFrame');
  if(!slide.imageRawDataUrl || !frame) return;
  pushUndoSnapshot();
  finalizeActiveOverlay(slide, frame);
  const ov = { id: statusUid(), text:'', xPct:50, yPct:50, sizeFrac:0.08, color:'#ffffff', align:'center' };
  slide.textOverlays = slide.textOverlays || [];
  slide.textOverlays.push(ov);
  slide.activeOverlayId = ov.id;
  slide.overlayEditMode = 'text';
  renderOverlaysLayer(slide, frame);
  renderComposerToolbar();
  renderComposerBottomPanel();
}

// Switching the selected sticker is a small DOM patch (toggle a class,
// tidy up whichever *other* sticker was active) — never a full layer
// rebuild — because a full rebuild would replace the element the current
// pointer gesture is captured on, silently breaking the drag already in
// progress. Only the *previous* element (a different node) gets touched.
function selectOverlay(el, ov, slide, frame){
  const layer = frame.querySelector('.status-overlay-layer');
  if(slide.activeOverlayId && slide.activeOverlayId !== ov.id){
    const prevOv = (slide.textOverlays || []).find(o => o.id === slide.activeOverlayId);
    const prevEl = layer && layer.querySelector(`[data-id="${slide.activeOverlayId}"]`);
    if(prevOv && !(prevOv.text || '').trim()){
      slide.textOverlays = slide.textOverlays.filter(o => o.id !== prevOv.id);
      if(prevEl) prevEl.remove();
    } else if(prevEl){
      prevEl.classList.remove('active');
      if(prevOv) prevEl.textContent = prevOv.text || '';
    }
  }
  slide.activeOverlayId = ov.id;
  slide.overlayEditMode = 'transform';
  el.classList.add('active');
  renderComposerToolbar();
  renderComposerBottomPanel();
}

// A sticker that isn't selected yet gets selected on the very first
// pointerdown (border + toolbar appear) and that same touch can immediately
// turn into a drag if the finger moves — no need to select, release, then
// separately drag. If the finger doesn't move, the sticker is simply left
// selected; a second plain tap on an already-selected sticker (still no
// movement) is what opens the text editor — that's what makes
// repositioning an existing sticker reachable at all, since text-edit mode
// always fully deselects on blur/done.
function attachOverlayGestures(el, ov, slide, frame){
  const pointers = new Map();
  let dragStart = null, pinchStart = null, moved = false, wasAlreadyActive = false;

  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    try{ el.setPointerCapture(e.pointerId); }catch(err){}
    if(pointers.size === 0){
      wasAlreadyActive = (slide.activeOverlayId === ov.id);
      moved = false;
      pushUndoSnapshot();
    }
    pointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
    if(slide.activeOverlayId !== ov.id) selectOverlay(el, ov, slide, frame);
    if(pointers.size === 1){
      const p = pointers.get(e.pointerId);
      dragStart = { x:p.x, y:p.y, xPct0: ov.xPct, yPct0: ov.yPct };
    } else if(pointers.size === 2){
      const pts = Array.from(pointers.values());
      pinchStart = { dist0: dist(pts[0], pts[1]) || 1, size0: ov.sizeFrac || 0.08 };
    }
  });
  el.addEventListener('pointermove', (e) => {
    if(!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x:e.clientX, y:e.clientY });
    const rect = frame.getBoundingClientRect();
    if(pointers.size === 1 && dragStart){
      const p = pointers.get(e.pointerId);
      const dxPct = ((p.x - dragStart.x) / rect.width) * 100;
      const dyPct = ((p.y - dragStart.y) / rect.height) * 100;
      if(Math.abs(dxPct) + Math.abs(dyPct) > 0.4) moved = true;
      ov.xPct = clamp(dragStart.xPct0 + dxPct, 4, 96);
      ov.yPct = clamp(dragStart.yPct0 + dyPct, 4, 96);
      el.style.left = ov.xPct + '%'; el.style.top = ov.yPct + '%';
    } else if(pointers.size === 2 && pinchStart){
      const pts = Array.from(pointers.values());
      const ratio = dist(pts[0], pts[1]) / pinchStart.dist0;
      ov.sizeFrac = clamp(pinchStart.size0 * ratio, 0.03, 0.22);
      el.style.fontSize = Math.max(10, ov.sizeFrac * rect.width) + 'px';
      moved = true;
    }
  });
  function endPointer(e){
    pointers.delete(e.pointerId);
    if(pointers.size === 0){
      dragStart = null; pinchStart = null;
      if(moved){ saveComposerDraft(); }
      else if(wasAlreadyActive && slide.activeOverlayId === ov.id && slide.overlayEditMode !== 'text'){
        slide.overlayEditMode = 'text';
        openOverlayTextEditor(el, ov, slide, frame);
        renderComposerToolbar();
        renderComposerBottomPanel();
      }
      moved = false;
    }
  }
  el.addEventListener('pointerup', endPointer);
  el.addEventListener('pointercancel', endPointer);
}

function openOverlayTextEditor(el, ov, slide, frame){
  el.classList.remove('placeholder');
  el.textContent = '';
  const ta = document.createElement('textarea');
  ta.className = 'status-overlay-textarea';
  ta.value = ov.text || '';
  ta.style.color = ov.color || '#ffffff';
  ta.style.textAlign = ov.align || 'center';
  ta.style.fontSize = el.style.fontSize;
  ta.maxLength = 140;
  el.appendChild(ta);
  requestAnimationFrame(() => { try{ ta.focus(); ta.select(); }catch(e){} });
  ta.oninput = () => { ov.text = ta.value; };
  ta.addEventListener('pointerdown', (e) => e.stopPropagation());
  ta.addEventListener('blur', () => finalizeActiveOverlay(slide, frame));
}

function finalizeActiveOverlay(slide, frame){
  if(!slide.activeOverlayId) return;
  const ov = (slide.textOverlays || []).find(o => o.id === slide.activeOverlayId);
  slide.activeOverlayId = null;
  slide.overlayEditMode = null;
  if(ov && !(ov.text || '').trim()){
    slide.textOverlays = slide.textOverlays.filter(o => o.id !== ov.id);
  }
  renderOverlaysLayer(slide, frame);
  renderComposerToolbar();
  renderComposerBottomPanel();
  saveComposerDraft();
}

function handleStatusImagePick(file){
  if(!file || !file.type || file.type.indexOf('image/') !== 0){ showToast('একটি ছবি বাছুন'); return; }
  compressImageFile(file, 1600, 0.88).then(dataUrl => {
    const slide = activeSlide();
    pushUndoSnapshot();
    slide.mode = 'image';
    slide.imageRawDataUrl = dataUrl;
    slide.filterId = slide.filterId || 'normal';
    slide.crop = { scale:1, offsetXFrac:0, offsetYFrac:0 };
    slide.textOverlays = slide.textOverlays || [];
    slide.activeOverlayId = null;
    slide.overlayEditMode = null;
    renderComposerStage();
    saveComposerDraft();
  }).catch(() => showToast('ছবি লোড করা যায়নি'));
}

// ফোনে তোলা ছবির raw পিক্সেল ডেটা প্রায়ই আসলে কাত/উল্টো থাকে — ক্যামেরা সেন্সর
// যেভাবে ধরা হয়েছিল সেটাই EXIF-এর একটা orientation ট্যাগে (মান ১-৮) লিখে রাখে,
// আর ডিসপ্লে-সফটওয়্যারকে বলে দেয় কীভাবে ঘুরিয়ে দেখাতে হবে। canvas দিয়ে সরাসরি
// drawImage করলে এই ট্যাগ উপেক্ষা হয়ে যায় — তাই এই ফাংশনটা JPEG-এর হেডার থেকে
// সরাসরি (কোনো লাইব্রেরি ছাড়াই) orientation বের করে। কিছু না পেলে/সমস্যা হলে
// নিরাপদভাবে ১ (স্বাভাবিক) রিটার্ন করে — কখনো এরর থ্রো করে না।
function readExifOrientation(arrayBuffer){
  try{
    const view = new DataView(arrayBuffer);
    if(view.byteLength < 4 || view.getUint16(0, false) !== 0xFFD8) return 1; // JPEG নয়
    let offset = 2;
    while(offset + 2 <= view.byteLength){
      const marker = view.getUint16(offset, false);
      offset += 2;
      if(marker === 0xFFE1){ // APP1 — EXIF সাধারণত এখানেই থাকে
        const segLen = view.getUint16(offset, false);
        if(view.getUint32(offset + 2, false) === 0x45786966 && view.getUint16(offset + 6, false) === 0x0000){
          const tiffStart = offset + 8;
          const little = view.getUint16(tiffStart, false) === 0x4949; // 'II' বাইট-অর্ডার
          const dirStart = tiffStart + view.getUint32(tiffStart + 4, little);
          const entries = view.getUint16(dirStart, little);
          for(let i = 0; i < entries; i++){
            const entryOffset = dirStart + 2 + i * 12;
            if(view.getUint16(entryOffset, little) === 0x0112){ // Orientation ট্যাগ
              return view.getUint16(entryOffset + 8, little) || 1;
            }
          }
        }
        offset += segLen;
      } else if(marker >= 0xFFD0 && marker <= 0xFFD9){
        continue; // এই মার্কারগুলোর নিজের কোনো length ফিল্ড নেই
      } else if((marker & 0xFF00) !== 0xFF00 || marker === 0xFFDA){
        break; // অচেনা বাইট বা স্ক্যান-ডেটা শুরু — এর আগে EXIF না পেলে আর নেই
      } else {
        offset += view.getUint16(offset, false);
      }
    }
  }catch(e){ /* কোনো পার্সিং সমস্যা হলে চুপচাপ "স্বাভাবিক" ধরে নেওয়া — কখনো ভাঙবে না */ }
  return 1;
}

// orientation (১-৮, EXIF স্ট্যান্ডার্ড) অনুযায়ী canvas-এ সঠিক rotate/flip
// ম্যাট্রিক্স বসায়, যাতে পরের drawImage() কল রॉ পিক্সেল ডেটা দিয়েই সঠিক
// দিকে আঁকে। rawW/rawH মানে ছবির আসল (ঘোরানোর আগের, decode করা) width/height।
function applyExifTransform(ctx, orientation, rawW, rawH){
  switch(orientation){
    case 2: ctx.transform(-1, 0, 0, 1, rawW, 0); break;          // আনুভূমিক ফ্লিপ
    case 3: ctx.transform(-1, 0, 0, -1, rawW, rawH); break;      // ১৮০°
    case 4: ctx.transform(1, 0, 0, -1, 0, rawH); break;          // উলম্ব ফ্লিপ
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;              // ট্রান্সপোজ
    case 6: ctx.transform(0, 1, -1, 0, rawH, 0); break;          // ৯০° ঘড়ির কাঁটার দিকে
    case 7: ctx.transform(0, -1, -1, 0, rawH, rawW); break;      // ট্রান্সভার্স
    case 8: ctx.transform(0, -1, 1, 0, 0, rawW); break;          // ৯০° উল্টো দিকে
    default: break; // ১ = স্বাভাবিক, কোনো ট্রান্সফর্ম লাগবে না
  }
}

function compressImageFile(file, maxDim, quality){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('read-failed'));
    reader.onload = () => {
      const buffer = reader.result;
      const orientation = readExifOrientation(buffer);
      // base64 data URL-এর বদলে object URL — ~33% ছোট ট্রান্সফার আর দ্রুত ডিকোড,
      // কাজ শেষে finally ব্লকে ঠিকমতো revoke করে মেমোরি ফাঁকা করা হয়।
      const blobUrl = URL.createObjectURL(new Blob([buffer], { type: file.type || 'image/jpeg' }));
      const img = new Image();
      img.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error('image-decode-failed')); };
      img.onload = () => {
        try{
          const rawW = img.naturalWidth, rawH = img.naturalHeight;
          const swapped = orientation >= 5 && orientation <= 8; // এই চারটায় ৯০°-ঘরানার ঘোরা, width/height অদলবদল হয়
          const dispW = swapped ? rawH : rawW;
          const dispH = swapped ? rawW : rawH;

          let outW = dispW, outH = dispH;
          if(dispW > maxDim || dispH > maxDim){
            if(dispW >= dispH){ outH = Math.round(dispH * (maxDim / dispW)); outW = maxDim; }
            else { outW = Math.round(dispW * (maxDim / dispH)); outH = maxDim; }
          }

          const canvas = document.createElement('canvas');
          canvas.width = outW; canvas.height = outH;
          const ctx = canvas.getContext('2d');
          ctx.scale(outW / dispW, outH / dispH); // চূড়ান্ত মাপে ছোট করা
          applyExifTransform(ctx, orientation, rawW, rawH); // এর আগেই সঠিক দিকে ঘোরানো
          ctx.drawImage(img, 0, 0, rawW, rawH);
          resolve(canvas.toDataURL('image/jpeg', quality));
        }catch(e){ reject(e); }
        finally{ URL.revokeObjectURL(blobUrl); }
      };
      img.src = blobUrl;
    };
    reader.readAsArrayBuffer(file);
  });
}

function loadImageEl(src){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image-decode-failed'));
    img.src = src;
  });
}

// Bakes crop/zoom + filter + every text sticker into one final JPEG, at the
// same aspect ratio the user actually edited in — this is why the image
// viewer never needs to know about crop/filters/stickers at all.
async function renderSlideToImageDataUrl(slide){
  if(!slide.imageRawDataUrl) throw new Error('no-image');
  const img = await loadImageEl(slide.imageRawDataUrl);
  if(document.fonts && document.fonts.ready){ try{ await document.fonts.ready; }catch(e){} }

  const MAX_DIM = 1080;
  const aspect = slide.frameAspect || (9/16);
  let outW, outH;
  if(aspect >= 1){ outW = MAX_DIM; outH = Math.round(MAX_DIM / aspect); }
  else { outH = MAX_DIM; outW = Math.round(MAX_DIM * aspect); }

  const canvas = document.createElement('canvas');
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext('2d');

  const filterCss = (STATUS_FILTERS.find(f => f.id === slide.filterId) || STATUS_FILTERS[0]).css;

  // Solid base first (safety net if canvas filter isn't supported below).
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, outW, outH);

  // Blurred, cover-scaled backdrop so a photo whose aspect ratio doesn't match
  // the frame never leaves an empty/black bar — same idea Instagram/Spotify
  // use for stories. Purely cosmetic fill; the sharp photo below is what
  // actually carries the content, uncropped.
  if('filter' in ctx){
    const bgCoverScale = Math.max(outW / img.naturalWidth, outH / img.naturalHeight);
    const bleed = 1.08; // a touch larger so the blur's own soft edge never peeks past the canvas edge
    const bgW = img.naturalWidth * bgCoverScale * bleed, bgH = img.naturalHeight * bgCoverScale * bleed;
    ctx.save();
    ctx.filter = 'blur(24px) brightness(0.55)' + (filterCss ? ' ' + filterCss : '');
    ctx.drawImage(img, (outW - bgW) / 2, (outH - bgH) / 2, bgW, bgH);
    ctx.restore();
  }

  // The sharp photo itself — contained (whole photo, never cropped) at
  // scale=1; only zooms in past that if the user deliberately pinched while
  // editing, matching the live preview's applyImageTransform exactly.
  if(filterCss && 'filter' in ctx) ctx.filter = filterCss;
  const scale = clamp(slide.crop.scale || 1, 1, 4);
  const containScale = Math.min(outW / img.naturalWidth, outH / img.naturalHeight);
  const effScale = containScale * scale;
  const drawW = img.naturalWidth * effScale, drawH = img.naturalHeight * effScale;
  const maxOffX = Math.max(0, (drawW - outW) / 2);
  const maxOffY = Math.max(0, (drawH - outH) / 2);
  const offX = clamp((slide.crop.offsetXFrac || 0) * outW, -maxOffX, maxOffX);
  const offY = clamp((slide.crop.offsetYFrac || 0) * outH, -maxOffY, maxOffY);
  const dx = (outW - drawW) / 2 + offX;
  const dy = (outH - drawH) / 2 + offY;
  ctx.drawImage(img, dx, dy, drawW, drawH);
  ctx.filter = 'none';

  (slide.textOverlays || []).forEach(ov => {
    const text = (ov.text || '').trim();
    if(!text) return;
    const px = (ov.xPct / 100) * outW, py = (ov.yPct / 100) * outH;
    const fontSize = Math.max(10, (ov.sizeFrac || 0.08) * outW);
    ctx.font = `700 ${fontSize}px 'Hind Siliguri', sans-serif`;
    ctx.fillStyle = ov.color || '#ffffff';
    ctx.textAlign = ov.align || 'center';
    ctx.textBaseline = 'middle';
    const lines = text.split('\n');
    const lineH = fontSize * 1.25;
    const startY = py - ((lines.length - 1) * lineH) / 2;
    lines.forEach((line, i) => ctx.fillText(line, px, startY + i * lineH));
  });

  let quality = 0.82;
  let dataUrl = canvas.toDataURL('image/jpeg', quality);
  while(dataUrl.length > 900000 && quality > 0.4){
    quality -= 0.1;
    dataUrl = canvas.toDataURL('image/jpeg', quality);
  }
  if(dataUrl.length > 900000) throw new Error('too-large');
  return dataUrl;
}

// ---------- toolbar (mode/selection-dependent action icons) ----------
function renderComposerToolbar(){
  const bar = document.getElementById('statusCompToolbar');
  if(!bar) return;
  const slide = activeSlide();

  if(slide.mode === 'text'){
    const alignIcon = slide.align === 'left' ? 'align-left' : (slide.align === 'right' ? 'align-right' : 'align-center');
    bar.innerHTML = `
      <button type="button" class="status-comp-tool-btn" id="statusCompFontBtn">Aa</button>
      <button type="button" class="status-comp-tool-btn" id="statusCompAlignBtn"><i class="fa-solid fa-${alignIcon}"></i></button>
      <button type="button" class="status-comp-tool-btn status-comp-size-btn" id="statusCompSizeDown">A−</button>
      <div class="status-comp-size-label">${toBn(Math.round(slide.size || 26))}</div>
      <button type="button" class="status-comp-tool-btn status-comp-size-btn" id="statusCompSizeUp">A+</button>
      <button type="button" class="status-comp-tool-btn ${slide.highlight ? 'active' : ''}" id="statusCompHighlightBtn" title="হাইলাইট"><i class="fa-solid fa-square"></i></button>
      <label class="status-comp-tool-btn" id="statusCompImageBtn">
        <i class="fa-solid fa-image"></i>
        <input type="file" accept="image/*" id="statusCompFileInput" style="display:none;">
      </label>
      <button type="button" class="status-comp-tool-btn" id="statusCompVoiceBtn" title="ভয়েস স্ট্যাটাস"><i class="fa-solid fa-microphone"></i></button>
      <button type="button" class="status-comp-tool-btn ${slide.musicData ? 'active' : ''}" id="statusCompMusicBtn" title="মিউজিক যুক্ত করুন"><i class="fa-solid fa-music"></i></button>`;
    wireFileInput();
    document.getElementById('statusCompVoiceBtn').onclick = () => { if(typeof openStatusVoiceSheet === 'function') openStatusVoiceSheet(); };
    document.getElementById('statusCompMusicBtn').onclick = () => { if(typeof openStatusMusicSheet === 'function') openStatusMusicSheet(); };
    document.getElementById('statusCompFontBtn').onclick = () => {
      pushUndoSnapshot();
      slide.fontIndex = (slide.fontIndex + 1) % STATUS_FONTS.length;
      const ta = document.getElementById('statusCompTextarea'); if(ta) applyTextareaFont(ta, slide);
      saveComposerDraft();
    };
    document.getElementById('statusCompAlignBtn').onclick = () => {
      pushUndoSnapshot();
      slide.align = slide.align === 'left' ? 'center' : (slide.align === 'center' ? 'right' : 'left');
      const ta = document.getElementById('statusCompTextarea'); if(ta) ta.style.textAlign = slide.align;
      renderComposerToolbar();
      saveComposerDraft();
    };
    document.getElementById('statusCompSizeDown').onclick = () => {
      pushUndoSnapshot();
      slide.size = clamp((slide.size || 26) - 2, 16, 44);
      const ta = document.getElementById('statusCompTextarea'); if(ta) ta.style.fontSize = slide.size + 'px';
      renderComposerToolbar();
      saveComposerDraft();
    };
    document.getElementById('statusCompSizeUp').onclick = () => {
      pushUndoSnapshot();
      slide.size = clamp((slide.size || 26) + 2, 16, 44);
      const ta = document.getElementById('statusCompTextarea'); if(ta) ta.style.fontSize = slide.size + 'px';
      renderComposerToolbar();
      saveComposerDraft();
    };
    document.getElementById('statusCompHighlightBtn').onclick = () => {
      pushUndoSnapshot();
      slide.highlight = !slide.highlight;
      const ta = document.getElementById('statusCompTextarea'); if(ta) ta.classList.toggle('highlight', slide.highlight);
      renderComposerToolbar();
      saveComposerDraft();
    };
  } else if(slide.mode === 'voice'){
    bar.innerHTML = `
      <button type="button" class="status-comp-tool-btn" id="statusCompRerecordBtn"><i class="fa-solid fa-rotate-left"></i> আবার রেকর্ড</button>`;
    document.getElementById('statusCompRerecordBtn').onclick = () => { if(typeof openStatusVoiceSheet === 'function') openStatusVoiceSheet(); };
  } else if(slide.activeOverlayId){
    const ov = (slide.textOverlays || []).find(o => o.id === slide.activeOverlayId);
    const alignIcon = ov && ov.align === 'left' ? 'align-left' : (ov && ov.align === 'right' ? 'align-right' : 'align-center');
    bar.innerHTML = `
      <button type="button" class="status-comp-tool-btn" id="statusCompOverlayDoneBtn"><i class="fa-solid fa-check"></i></button>
      <button type="button" class="status-comp-tool-btn" id="statusCompOverlayDeleteBtn"><i class="fa-solid fa-trash"></i></button>
      <button type="button" class="status-comp-tool-btn" id="statusCompOverlayAlignBtn"><i class="fa-solid fa-${alignIcon}"></i></button>`;
    // A sticker's textarea may currently have focus; without this, tapping
    // one of these buttons would blur it first (running the textarea's own
    // blur→finalize cleanup) before the click handler below even runs,
    // racing against — and sometimes cancelling out — the action just
    // tapped. preventDefault() on pointerdown keeps focus put so the click
    // handlers below always see consistent, current state.
    const keepFocusPut = (e) => e.preventDefault();
    ['statusCompOverlayDoneBtn','statusCompOverlayDeleteBtn','statusCompOverlayAlignBtn'].forEach(id => {
      const b = document.getElementById(id);
      if(b) b.addEventListener('pointerdown', keepFocusPut);
    });
    document.getElementById('statusCompOverlayDoneBtn').onclick = () => {
      const frame = document.getElementById('statusImgFrame');
      if(frame) finalizeActiveOverlay(slide, frame);
    };
    document.getElementById('statusCompOverlayDeleteBtn').onclick = () => {
      if(!ov) return;
      pushUndoSnapshot();
      slide.textOverlays = slide.textOverlays.filter(o => o.id !== ov.id);
      slide.activeOverlayId = null; slide.overlayEditMode = null;
      const frame = document.getElementById('statusImgFrame');
      if(frame) renderOverlaysLayer(slide, frame);
      renderComposerToolbar();
      renderComposerBottomPanel();
      saveComposerDraft();
    };
    document.getElementById('statusCompOverlayAlignBtn').onclick = () => {
      if(!ov) return;
      pushUndoSnapshot();
      ov.align = ov.align === 'left' ? 'center' : (ov.align === 'center' ? 'right' : 'left');
      const frame = document.getElementById('statusImgFrame');
      if(frame) renderOverlaysLayer(slide, frame);
      renderComposerToolbar();
      saveComposerDraft();
    };
  } else {
    bar.innerHTML = `
      <button type="button" class="status-comp-tool-btn" id="statusCompAddTextBtn">Aa</button>
      <label class="status-comp-tool-btn" id="statusCompImageBtn">
        <i class="fa-solid fa-image"></i>
        <input type="file" accept="image/*" id="statusCompFileInput" style="display:none;">
      </label>
      <button type="button" class="status-comp-tool-btn ${slide.musicData ? 'active' : ''}" id="statusCompMusicBtn2" title="মিউজিক যুক্ত করুন"><i class="fa-solid fa-music"></i></button>`;
    wireFileInput();
    document.getElementById('statusCompAddTextBtn').onclick = addTextOverlayAction;
    document.getElementById('statusCompMusicBtn2').onclick = () => { if(typeof openStatusMusicSheet === 'function') openStatusMusicSheet(); };
  }
}
function wireFileInput(){
  const fileInput = document.getElementById('statusCompFileInput');
  if(fileInput) fileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if(file) handleStatusImagePick(file);
    e.target.value = '';
  });
}

// ---------- bottom panel (colour/gradient/text-colour tabs, or filter chips) ----------
function renderComposerBottomPanel(){
  const panel = document.getElementById('statusCompBottomPanel');
  if(!panel) return;
  const slide = activeSlide();

  if(slide.mode === 'text'){
    const tab = slide.colorPanelTab || 'solid';
    let swatchArr, currentVal, applyFn;
    if(tab === 'textcolor'){
      swatchArr = STATUS_TEXT_COLORS;
      currentVal = slide.textColor || '#ffffff';
      applyFn = (val) => {
        pushUndoSnapshot(); slide.textColor = val;
        const ta = document.getElementById('statusCompTextarea'); if(ta) ta.style.color = val;
        saveComposerDraft();
      };
    } else if(tab === 'gradient'){
      swatchArr = STATUS_BG_SWATCHES.slice(8);
      currentVal = slide.bg || STATUS_BG_SWATCHES[0];
      applyFn = (val) => {
        pushUndoSnapshot(); slide.bg = val;
        const stage = document.getElementById('statusCompStage'); if(stage) stage.style.background = val;
        saveComposerDraft();
      };
    } else {
      swatchArr = STATUS_BG_SWATCHES.slice(0, 8);
      currentVal = slide.bg || STATUS_BG_SWATCHES[0];
      applyFn = (val) => {
        pushUndoSnapshot(); slide.bg = val;
        const stage = document.getElementById('statusCompStage'); if(stage) stage.style.background = val;
        saveComposerDraft();
      };
    }
    panel.innerHTML = `
      <div class="status-comp-panel-tabs">
        <button type="button" class="status-comp-panel-tab ${tab === 'solid' ? 'active' : ''}" data-tab="solid">সলিড</button>
        <button type="button" class="status-comp-panel-tab ${tab === 'gradient' ? 'active' : ''}" data-tab="gradient">গ্রেডিয়েন্ট</button>
        <button type="button" class="status-comp-panel-tab ${tab === 'textcolor' ? 'active' : ''}" data-tab="textcolor">টেক্সট রঙ</button>
      </div>
      <div class="status-comp-swatch-row">${swatchArr.map(v => `<button type="button" class="status-comp-swatch-dot ${v === currentVal ? 'active' : ''}" data-v="${v}" style="background:${v}"></button>`).join('')}</div>`;
    panel.querySelectorAll('.status-comp-panel-tab').forEach(btn => {
      btn.onclick = () => { slide.colorPanelTab = btn.dataset.tab; renderComposerBottomPanel(); };
    });
    panel.querySelectorAll('.status-comp-swatch-dot').forEach(btn => {
      btn.onclick = () => { applyFn(btn.dataset.v); renderComposerBottomPanel(); };
    });
  } else if(slide.mode === 'voice'){
    const swatchArr = STATUS_BG_SWATCHES.slice(0, 8);
    const currentVal = slide.bg || STATUS_BG_SWATCHES[0];
    panel.innerHTML = `<div class="status-comp-swatch-row">${swatchArr.map(v => `<button type="button" class="status-comp-swatch-dot ${v === currentVal ? 'active' : ''}" data-v="${v}" style="background:${v}"></button>`).join('')}</div>`;
    panel.querySelectorAll('.status-comp-swatch-dot').forEach(btn => {
      btn.onclick = () => {
        slide.bg = btn.dataset.v;
        const stage = document.getElementById('statusCompStage'); if(stage) stage.style.background = slide.bg;
        renderComposerBottomPanel();
        saveComposerDraft();
      };
    });
  } else if(slide.activeOverlayId){
    const ov = (slide.textOverlays || []).find(o => o.id === slide.activeOverlayId);
    panel.innerHTML = `<div class="status-comp-swatch-row">${STATUS_TEXT_COLORS.map(v => `<button type="button" class="status-comp-swatch-dot ${ov && ov.color === v ? 'active' : ''}" data-v="${v}" style="background:${v}"></button>`).join('')}</div>`;
    panel.querySelectorAll('.status-comp-swatch-dot').forEach(btn => {
      btn.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the sticker's textarea focused, see overlay toolbar buttons above
      btn.onclick = () => {
        if(!ov) return;
        pushUndoSnapshot();
        ov.color = btn.dataset.v;
        const frame = document.getElementById('statusImgFrame');
        if(frame) renderOverlaysLayer(slide, frame);
        renderComposerBottomPanel();
        saveComposerDraft();
      };
    });
  } else if(slide.mode === 'image'){
    panel.innerHTML = `<div class="status-comp-filter-row">${STATUS_FILTERS.map(f => `<button type="button" class="status-comp-filter-chip ${slide.filterId === f.id ? 'active' : ''}" data-id="${f.id}">${f.label}</button>`).join('')}</div>`;
    panel.querySelectorAll('.status-comp-filter-chip').forEach(btn => {
      btn.onclick = () => {
        pushUndoSnapshot();
        slide.filterId = btn.dataset.id;
        const filterCss = (STATUS_FILTERS.find(f => f.id === slide.filterId) || STATUS_FILTERS[0]).css;
        const img = document.getElementById('statusCropImg');
        if(img) img.style.filter = filterCss;
        const bg = document.getElementById('statusImgFrameBg');
        if(bg) bg.style.filter = 'blur(32px) brightness(.55)' + (filterCss ? ' ' + filterCss : '');
        renderComposerBottomPanel();
        saveComposerDraft();
      };
    });
  } else {
    panel.innerHTML = '';
  }
}

// ---------- draft persistence (IDBKV) ----------
function saveComposerDraft(){
  try{
    const slides = statusComposerState.slides.map(s => ({
      mode:s.mode, bg:s.bg, colorPanelTab:s.colorPanelTab, fontIndex:s.fontIndex, align:s.align, size:s.size,
      textColor:s.textColor, highlight:s.highlight, textValue:s.textValue,
      imageRawDataUrl:s.imageRawDataUrl, filterId:s.filterId, frameAspect:s.frameAspect, crop:s.crop,
      textOverlays: (s.textOverlays || []).map(o => ({ ...o })),
      voiceData:s.voiceData, voiceDuration:s.voiceDuration, voicePeaks:s.voicePeaks,
      musicData:s.musicData, musicDuration:s.musicDuration, musicPeaks:s.musicPeaks, musicName:s.musicName, musicTrackId:s.musicTrackId,
      _modReq:s._modReq || null
    }));
    const hasContent = slides.some(s => (s.textValue && s.textValue.trim()) || s.imageRawDataUrl || s.voiceData || s.musicData);
    if(!hasContent){ clearComposerDraft(); return; }
    IDBKV.set(STATUS_DRAFT_KEY, JSON.stringify({ slides, activeIndex: statusComposerState.activeIndex }));
  }catch(e){}
}
function loadComposerDraft(){
  try{
    const raw = IDBKV.get(STATUS_DRAFT_KEY);
    if(!raw) return null;
    return JSON.parse(raw);
  }catch(e){ return null; }
}
function clearComposerDraft(){
  try{ IDBKV.remove(STATUS_DRAFT_KEY); }catch(e){}
}

// ---------- send (bakes every image slide, uploads all slides in order) ----------
// ------------------------------------------------------------------------------------------------
// স্টোরি মডারেশন: এখান থেকে আর কখনোই সরাসরি Firestore-এ স্টোরি লেখা হয় না (firestore.rules-এ `statuses`
// create বন্ধ)। প্রতিটা স্লাইড POST /api/story-submit-এ যায়; সার্ভার ভ্যালিডেশন + AI মডারেশন করে, আর শুধু
// APPROVED স্টোরি সার্ভারই প্রকাশ করে। ক্লায়েন্ট শুধু ফলাফল দেখায় — js/story-moderation.js, api/story-submit.js।
// ------------------------------------------------------------------------------------------------
// ক্লায়েন্ট শুধু কনটেন্ট পাঠায়; uid/name/avatar/সময়/কাউন্টার সার্ভার নিজে ঠিক করে।
async function buildStoryPayload(s){
  let payload;
  if(s.mode === 'image'){
    const imageData = await renderSlideToImageDataUrl(s);
    payload = { type:'image', imageData };
    if(s.musicData) Object.assign(payload, { audioData:s.musicData, audioDuration:s.musicDuration, audioPeaks:s.musicPeaks || [], audioName:s.musicName || 'অডিও', musicTrackId:s.musicTrackId || undefined });
  } else if(s.mode === 'voice'){
    payload = {
      type:'voice', bg: s.bg || STATUS_BG_SWATCHES[0],
      audioData: s.voiceData, audioDuration: s.voiceDuration, audioPeaks: s.voicePeaks || []
    };
  } else {
    payload = {
      type:'text', text: (s.textValue || '').trim().slice(0, 700),
      bg: s.bg || STATUS_BG_SWATCHES[0], font: STATUS_FONTS[s.fontIndex || 0].id,
      align: s.align || 'center', size: Math.round(s.size || 26),
      textColor: s.textColor || '#ffffff', highlight: !!s.highlight
    };
    if(s.musicData) Object.assign(payload, { audioData:s.musicData, audioDuration:s.musicDuration, audioPeaks:s.musicPeaks || [], audioName:s.musicName || 'অডিও', musicTrackId:s.musicTrackId || undefined });
  }
  return payload;
}

async function submitStatus(){
  if(!state.user || statusComposerState.sending) return;
  const SM = window.StoryModeration;
  if(!SM || SM.disabled){ showToast('স্টোরি শুধু ওয়েবসাইট থেকে পোস্ট করা যায়'); return; }
  finalizeActiveOverlayIfAny();
  const slides = statusComposerState.slides.slice();
  for(const s of slides){
    if(s.mode === 'image'){ if(!s.imageRawDataUrl){ showToast('একটি ছবি বাছুন'); return; } }
    else if(s.mode === 'voice'){ if(!s.voiceData){ showToast('ভয়েস রেকর্ড করুন'); return; } }
    else if(!(s.textValue || '').trim() && !s.musicData){ showToast('কিছু লিখুন'); return; }
  }

  statusComposerState.sending = true; // ডুপ্লিকেট সাবমিশন ঠেকায়
  const sendBtn = document.getElementById('statusCompSend');
  if(sendBtn){ sendBtn.disabled = true; sendBtn.classList.add('busy'); sendBtn.innerHTML = '<i class="fa-solid fa-circle-notch"></i>'; }
  const counterEl = document.getElementById('statusCompCounter');

  const results = []; // { index, slide, out }
  try{
    for(let i = 0; i < slides.length; i++){
      const s = slides[i];
      // "আপনার স্টোরি যাচাই করা হচ্ছে..." → "AI মডারেশন চলছে..."
      const setPhase = (phase) => {
        const t = SM.phaseText(phase, i, slides.length);
        SM.progress.show(t);
        if(counterEl) counterEl.textContent = t;
      };
      setPhase('check');
      let out;
      try{
        const payload = await buildStoryPayload(s);
        out = await SM.submit(payload, SM.requestIdFor(s), { onPhase:setPhase, regenerate:() => SM.resetRequestId(s) });
      } catch(err){
        console.warn('story slide could not be prepared:', err);
        out = { status:'error', title:'স্লাইড প্রস্তুত করা যায়নি', message:'এই স্লাইডটি প্রস্তুত করা যায়নি। ছবিটি আবার বেছে চেষ্টা করুন।', guideline:null, retryable:false, fatal:false };
      }
      results.push({ index:i, slide:s, out });
      // নেটওয়ার্ক/সেশন/রেট-লিমিট সমস্যা, বা AI বন্ধ থাকলে বাকি স্লাইড পাঠিয়ে লাভ নেই — সেগুলো কম্পোজারে অক্ষত থাকে।
      if(out.fatal || (out.status === 'pending' && out.retryable)) break;
    }
  } finally {
    SM.progress.hide();
  }

  // কোন স্লাইড কম্পোজার থেকে সরবে: যেগুলো প্রকাশিত হয়েছে বা অ্যাডমিন-রিভিউয়ের জন্য নিরাপদে জমা হয়েছে।
  // অনুমোদিত হয়নি / পাঠানো যায়নি এমন স্লাইড থেকে যায়, যাতে সম্পাদনা করে আবার জমা দেওয়া যায়।
  const done = new Set();
  for(const r of results){
    SM.setSlideNote(r.slide, r.out);
    if(r.out.status === 'approved' || r.out.status === 'review_required') done.add(r.slide);
  }
  const uid = state.user.uid;
  SM.watchAdd(uid, results.filter(r => r.out.submissionId && (r.out.status === 'review_required' || (r.out.status === 'pending' && !r.out.retryable))).map(r => r.out.submissionId));
  results.forEach(r => { if(r.out.status === 'approved' && r.out.submissionId) SM.watchRemove(uid, r.out.submissionId); });

  statusComposerState.slides = statusComposerState.slides.filter(s => !done.has(s));
  statusComposerState.sending = false;
  const remaining = statusComposerState.slides;

  if(!remaining.length){
    clearComposerDraft();
    const ov = document.getElementById('statusComposerOverlay');
    if(ov) ov.classList.remove('open');
    document.body.style.overflow = '';
  } else {
    const noteIdx = remaining.findIndex(s => s._modNote);
    statusComposerState.activeIndex = noteIdx >= 0 ? noteIdx : clamp(statusComposerState.activeIndex || 0, 0, remaining.length - 1);
    saveComposerDraft();
    renderComposerStage();
    const btn = document.getElementById('statusCompSend');
    if(btn){ btn.disabled = false; btn.classList.remove('busy'); btn.innerHTML = '<i class="fa-solid fa-check"></i>'; }
    renderComposerCounter();
  }
  if(results.some(r => r.out.status === 'approved')){ statusRowFetchedAt = 0; renderStatusRow(); }

  const allApproved = results.length === slides.length && results.every(r => r.out.status === 'approved');
  if(allApproved){
    // সব প্রকাশিত — ব্লকিং শীট ছাড়াই শুধু নিশ্চিতকরণ
    showToast(slides.length > 1 ? 'আপনার সব স্টোরি অনুমোদিত হয়েছে এবং প্রকাশিত হয়েছে।' : results[0].out.message);
    return;
  }
  SM.showResults(results.map(r => ({ index:r.index, out:r.out })), {
    onEdit: (index) => {
      const r = results.find(x => x.index === index);
      const at = r ? statusComposerState.slides.indexOf(r.slide) : -1;
      if(at >= 0){ statusComposerState.activeIndex = at; renderComposerStage(); }
      setTimeout(() => { const f = document.querySelector('#statusCompStage textarea, #statusCompStage [contenteditable="true"]'); if(f && f.focus) f.focus(); }, 60);
    },
    onRetry: () => { submitStatus(); },
    onMine: () => { SM.openMine(); }
  });
}

// ==================================================================
// Full-screen story viewer
// ==================================================================
function ensureStatusViewerOverlay(){
  let ov = document.getElementById('statusViewerOverlay');
  if(ov) return ov;
  ov = document.createElement('div');
  ov.id = 'statusViewerOverlay';
  ov.className = 'status-overlay';
  ov.innerHTML = `
    <div class="status-view-progress-row" id="statusViewProgressRow"></div>
    <div class="status-view-header">
      <div class="status-view-avatar" id="statusViewAvatar"></div>
      <div class="status-view-who">
        <div class="status-view-name" id="statusViewName"></div>
        <div class="status-view-time" id="statusViewTime"></div>
      </div>
      <button type="button" class="status-view-header-btn" id="statusViewMuteBtn" style="display:none;"><i class="fa-solid fa-volume-high"></i></button>
      <button type="button" class="status-view-header-btn" id="statusViewHighlightBtn" style="display:none;"><i class="fa-regular fa-star"></i></button>
      <button type="button" class="status-view-header-btn" id="statusViewDeleteBtn" style="display:none;"><i class="fa-solid fa-trash"></i></button>
      <button type="button" class="status-view-header-btn" id="statusViewCloseBtn"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="status-view-stage" id="statusViewStage">
      <div class="status-view-tap-zone left" id="statusViewTapLeft"></div>
      <div class="status-view-tap-zone center" id="statusViewTapCenter"></div>
      <div class="status-view-tap-zone right" id="statusViewTapRight"></div>
      <div id="statusViewItems"></div>
      <div id="statusViewHeartPopLayer"></div>
      <audio id="statusViewAudioEl" playsinline style="display:none;"></audio>
    </div>
    <div class="status-view-footer" id="statusViewFooter" style="display:none;">
      <button type="button" class="status-view-viewers-btn" id="statusViewViewersBtn">
        <i class="fa-solid fa-eye"></i><span id="statusViewViewersCount">০</span>&nbsp;জন দেখেছে
      </button>
      <button type="button" class="status-view-react-btn" id="statusViewReactBtn">
        <i class="fa-regular fa-heart"></i><span id="statusViewReactCount"></span>
      </button>
    </div>`;
  document.body.appendChild(ov);

  document.getElementById('statusViewCloseBtn').onclick = closeStatusViewer;
  document.getElementById('statusViewDeleteBtn').onclick = confirmDeleteCurrentStatusItem;
  document.getElementById('statusViewViewersBtn').onclick = openStatusViewersSheet;
  document.getElementById('statusViewReactBtn').onclick = handleReactButtonTap;
  document.getElementById('statusViewMuteBtn').onclick = () => { if(typeof toggleStatusViewerMute === 'function') toggleStatusViewerMute(); };
  document.getElementById('statusViewHighlightBtn').onclick = () => { if(typeof openSaveToHighlightFlow === 'function') openSaveToHighlightFlow(); };

  attachStatusTapZone(document.getElementById('statusViewTapLeft'), goToPrevStatusItem);
  attachStatusTapZone(document.getElementById('statusViewTapRight'), goToNextStatusItem);
  attachStatusCenterZone(document.getElementById('statusViewTapCenter'));

  // Swipe down anywhere on the stage to close, WhatsApp-style.
  const stage = document.getElementById('statusViewStage');
  let touchStartY = null;
  stage.addEventListener('touchstart', (e) => { touchStartY = e.touches[0].clientY; }, { passive:true });
  stage.addEventListener('touchend', (e) => {
    if(touchStartY == null) return;
    const dy = e.changedTouches[0].clientY - touchStartY;
    touchStartY = null;
    if(dy > 90) closeStatusViewer();
  }, { passive:true });

  return ov;
}

// A short press advances; holding the finger/pointer down pauses the
// current item (like a long-press on a WhatsApp status) and a plain
// release afterwards just resumes it without navigating.
function attachStatusTapZone(zone, onTap){
  if(!zone) return;
  let holdTimeout = null, holdActive = false;
  zone.addEventListener('pointerdown', () => {
    holdActive = false;
    clearTimeout(holdTimeout);
    holdTimeout = setTimeout(() => { holdActive = true; pauseStatusItemTimer(); }, 180);
  });
  const release = () => {
    clearTimeout(holdTimeout);
    if(holdActive){ holdActive = false; resumeStatusItemTimer(); }
    else onTap();
  };
  zone.addEventListener('pointerup', release);
  zone.addEventListener('pointercancel', () => { clearTimeout(holdTimeout); if(holdActive){ holdActive = false; resumeStatusItemTimer(); } });
}

// The middle strip between the left/right nav zones never navigated
// anything before, so it's a safe home for "double-tap to love-react",
// WhatsApp/Instagram-style, without touching the existing tap-to-advance
// behaviour at all. A held press here still pauses, same as the sides.
function attachStatusCenterZone(zone){
  if(!zone) return;
  let holdTimeout = null, holdActive = false, lastTapAt = 0;
  zone.addEventListener('pointerdown', () => {
    holdActive = false; clearTimeout(holdTimeout);
    holdTimeout = setTimeout(() => { holdActive = true; pauseStatusItemTimer(); }, 180);
  });
  zone.addEventListener('pointerup', (e) => {
    clearTimeout(holdTimeout);
    if(holdActive){ holdActive = false; resumeStatusItemTimer(); return; }
    const now = Date.now();
    if(now - lastTapAt < STATUS_DOUBLE_TAP_MS){
      lastTapAt = 0;
      spawnHeartPop(e);
      const group = statusViewerState.groups[statusViewerState.groupIndex];
      const item = group && group.items[statusViewerState.itemIndex];
      if(group && item && state.user && group.uid !== state.user.uid && !getReactedStatusIds().has(item.id)){
        toggleStatusReaction(item, group);
      }
    } else {
      lastTapAt = now;
    }
  });
  zone.addEventListener('pointercancel', () => { clearTimeout(holdTimeout); if(holdActive){ holdActive = false; resumeStatusItemTimer(); } });
}

function spawnHeartPop(e){
  const stage = document.getElementById('statusViewStage');
  const layer = document.getElementById('statusViewHeartPopLayer');
  if(!stage || !layer) return;
  const rect = stage.getBoundingClientRect();
  const x = (e.clientX != null ? e.clientX : rect.left + rect.width / 2) - rect.left;
  const y = (e.clientY != null ? e.clientY : rect.top + rect.height / 2) - rect.top;
  const heart = document.createElement('i');
  heart.className = 'fa-solid fa-heart status-heart-pop';
  heart.style.left = x + 'px'; heart.style.top = y + 'px';
  layer.appendChild(heart);
  setTimeout(() => heart.remove(), 700);
}

function openStatusViewer(groups, groupIndex, itemIndex, mode){
  if(!state.user){ if(typeof openAuthFlow === 'function') openAuthFlow('choice'); return; }
  if(!groups || !groups.length) return;
  ensureStatusViewerOverlay();
  statusViewerState.open = true;
  statusViewerState.groups = groups;
  statusViewerState.groupIndex = groupIndex || 0;
  statusViewerState.itemIndex = itemIndex || 0;
  statusViewerState.mode = mode === 'highlight' ? 'highlight' : 'status';
  document.getElementById('statusViewerOverlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  renderStatusViewerGroup();
}

function closeStatusViewer(){
  stopStatusItemTimer();
  statusViewerState.open = false;
  const ov = document.getElementById('statusViewerOverlay');
  if(ov) ov.classList.remove('open');
  document.body.style.overflow = '';
  closeStatusViewersSheet();
  renderStatusRowFromCache(); // reflect newly-seen items in the row's ring colors
}

function renderStatusViewerGroup(){
  const group = statusViewerState.groups[statusViewerState.groupIndex];
  if(!group || !group.items.length){ closeStatusViewer(); return; }

  const avatarEl = document.getElementById('statusViewAvatar');
  avatarEl.style.background = group.avatarColor || PROFILE_AVATAR_COLORS[0];
  avatarEl.innerHTML = avatarGlyph({ name: group.name, avatarIcon: group.avatarIcon });
  const isOwn = group.uid === state.user.uid;
  const isHighlight = statusViewerState.mode === 'highlight';
  document.getElementById('statusViewName').textContent = isHighlight ? (group.name || 'হাইলাইট') : (isOwn ? 'আমার স্ট্যাটাস' : (group.name || 'ব্যবহারকারী'));

  document.getElementById('statusViewProgressRow').innerHTML =
    group.items.map(() => `<div class="status-view-progress-track"><div class="status-view-progress-fill"></div></div>`).join('');

  document.getElementById('statusViewItems').innerHTML = group.items.map((it,i) => statusViewItemHtml(it,i)).join('');
  if(typeof statusRenderItemWaveforms === 'function') statusRenderItemWaveforms(group);

  document.getElementById('statusViewDeleteBtn').style.display = (isOwn || isHighlight) ? 'flex' : 'none';
  document.getElementById('statusViewFooter').style.display = isHighlight ? 'none' : 'flex';

  showStatusViewerItem(statusViewerState.itemIndex);
}

function statusMusicChipHtml(it){
  return it.audioData ? `<div class="status-music-chip"><i class="fa-solid fa-music"></i><span>${escapeHtml(it.audioName || 'অডিও')}</span></div>` : '';
}
function statusViewItemHtml(it, i){
  if(it.type === 'voice'){
    const bg = it.bg || STATUS_BG_SWATCHES[0];
    return `<div class="status-view-item status-view-item-voice" data-i="${i}" style="background:${bg};">
      <div class="status-voice-view-icon"><i class="fa-solid fa-microphone"></i></div>
      <div class="status-voice-view-bars"></div>
    </div>`;
  }
  if(it.type === 'image'){
    const overlay = (it.text || it.audioData) ? `<div class="status-view-bottom-overlay">
        ${it.text ? `<div class="status-view-caption">${escapeHtml(it.text)}</div>` : ''}
        ${statusMusicChipHtml(it)}
      </div>` : '';
    return `<div class="status-view-item status-view-item-image" data-i="${i}">
      <img src="${it.imageData}" alt="">
      ${overlay}
    </div>`;
  }
  const font = STATUS_FONTS.find(f => f.id === it.font) || STATUS_FONTS[0];
  const bg = it.bg || STATUS_BG_SWATCHES[Number.isInteger(it.bgIndex) ? it.bgIndex : 0] || STATUS_BG_SWATCHES[0];
  const align = it.align || 'center';
  const size = (typeof it.size === 'number' && it.size >= 14 && it.size <= 56) ? it.size : 28;
  const color = it.textColor || '#ffffff';
  const textCls = 'status-view-text' + (it.highlight ? ' highlight' : '');
  return `<div class="status-view-item" data-i="${i}" style="background:${bg};">
    <div class="${textCls}" style="font-family:${font.family};font-weight:${font.weight||600};${font.upper?'text-transform:uppercase;':''}text-align:${align};color:${color};font-size:${size}px;">${escapeHtml(it.text||'')}</div>
    ${statusMusicChipHtml(it)}
  </div>`;
}

function showStatusViewerItem(idx){
  const group = statusViewerState.groups[statusViewerState.groupIndex];
  if(!group) return;

  if(idx < 0){
    if(statusViewerState.groupIndex === 0){ idx = 0; }
    else {
      statusViewerState.groupIndex -= 1;
      const prevGroup = statusViewerState.groups[statusViewerState.groupIndex];
      statusViewerState.itemIndex = Math.max(0, prevGroup.items.length - 1);
      renderStatusViewerGroup();
      return;
    }
  }
  if(idx >= group.items.length){
    if(statusViewerState.groupIndex >= statusViewerState.groups.length - 1){ closeStatusViewer(); return; }
    statusViewerState.groupIndex += 1;
    statusViewerState.itemIndex = 0;
    renderStatusViewerGroup();
    return;
  }

  statusViewerState.itemIndex = idx;
  stopStatusItemTimer();

  const tracks = document.querySelectorAll('#statusViewProgressRow .status-view-progress-track');
  tracks.forEach((t,i) => {
    const fill = t.querySelector('.status-view-progress-fill');
    fill.style.transition = 'none';
    if(i < idx){ t.classList.add('done'); fill.style.width = '100%'; }
    else { t.classList.remove('done'); fill.style.width = '0%'; }
  });

  document.querySelectorAll('#statusViewItems .status-view-item').forEach((el,i) => el.classList.toggle('active', i === idx));

  const item = group.items[idx];
  document.getElementById('statusViewTime').textContent = typeof timeAgoBn === 'function' ? timeAgoBn(item.createdAt) : '';

  const isOwn = group.uid === state.user.uid;
  const isHighlight = statusViewerState.mode === 'highlight';
  const viewersBtn = document.getElementById('statusViewViewersBtn');
  const reactBtn = document.getElementById('statusViewReactBtn');
  if(isHighlight){
    viewersBtn.style.display = 'none';
    reactBtn.style.display = 'none';
  } else if(isOwn){
    viewersBtn.style.display = 'flex';
    document.getElementById('statusViewViewersCount').textContent = toBn(item.viewCount || 0);
    reactBtn.style.display = item.reactCount ? 'flex' : 'none';
    reactBtn.classList.remove('reacted');
    reactBtn.querySelector('i').className = 'fa-regular fa-heart';
    document.getElementById('statusViewReactCount').textContent = item.reactCount ? toBn(item.reactCount) : '';
  } else {
    viewersBtn.style.display = 'none';
    reactBtn.style.display = 'flex';
    const reacted = getReactedStatusIds().has(item.id);
    updateReactBtnUI(item, reacted);
  }

  const highlightBtn = document.getElementById('statusViewHighlightBtn');
  if(highlightBtn){
    highlightBtn.style.display = (isOwn && !isHighlight) ? 'flex' : 'none';
    const icon = highlightBtn.querySelector('i');
    if(icon) icon.className = (isOwn && !isHighlight && typeof isStatusHighlighted === 'function' && isStatusHighlighted(item.id)) ? 'fa-solid fa-star' : 'fa-regular fa-star';
  }

  if(!isHighlight){
    markStatusSeenLocally(item.id);
    if(!isOwn) recordStatusView(item);
  }

  if(typeof statusViewerLoadItemAudio === 'function') statusViewerLoadItemAudio(item);
  // A voice-status or music-carrying slide stays on screen for exactly as
  // long as its clip, WhatsApp-style, instead of the usual fixed timing.
  const durationMs = (item.audioData && item.audioDuration) ? clamp(item.audioDuration, 800, 60000) : STATUS_ITEM_MS;
  startStatusItemTimer(idx, durationMs);
}

function startStatusItemTimer(idx, durationMs){
  const tracks = document.querySelectorAll('#statusViewProgressRow .status-view-progress-track');
  const fill = tracks[idx] && tracks[idx].querySelector('.status-view-progress-fill');
  if(!fill) return;
  statusViewerState.currentFill = fill;
  statusViewerState.remainingMs = durationMs;
  statusViewerState.paused = false;
  fill.style.transition = 'none';
  fill.style.width = '0%';
  void fill.offsetHeight; // force reflow so the transition below actually animates
  fill.style.transition = `width ${durationMs}ms linear`;
  fill.style.width = '100%';
  statusViewerState.itemStartedAt = Date.now();
  clearTimeout(statusViewerState.timer);
  statusViewerState.timer = setTimeout(goToNextStatusItem, durationMs);
}

function pauseStatusItemTimer(){
  if(!statusViewerState.open || statusViewerState.paused) return;
  const fill = statusViewerState.currentFill;
  if(fill){
    const w = getComputedStyle(fill).width;
    fill.style.transition = 'none';
    fill.style.width = w;
  }
  clearTimeout(statusViewerState.timer);
  const elapsed = Date.now() - statusViewerState.itemStartedAt;
  statusViewerState.remainingMs = Math.max(200, statusViewerState.remainingMs - elapsed);
  statusViewerState.paused = true;
  if(typeof statusViewerPauseAudio === 'function') statusViewerPauseAudio();
}

function resumeStatusItemTimer(){
  if(!statusViewerState.open || !statusViewerState.paused) return;
  statusViewerState.paused = false;
  const fill = statusViewerState.currentFill;
  if(fill){
    void fill.offsetHeight;
    fill.style.transition = `width ${statusViewerState.remainingMs}ms linear`;
    fill.style.width = '100%';
  }
  statusViewerState.itemStartedAt = Date.now();
  clearTimeout(statusViewerState.timer);
  statusViewerState.timer = setTimeout(goToNextStatusItem, statusViewerState.remainingMs);
  if(typeof statusViewerResumeAudio === 'function') statusViewerResumeAudio();
}

function stopStatusItemTimer(){
  clearTimeout(statusViewerState.timer);
  statusViewerState.timer = null;
  if(typeof statusViewerStopAudio === 'function') statusViewerStopAudio();
}

function goToNextStatusItem(){ showStatusViewerItem(statusViewerState.itemIndex + 1); }
function goToPrevStatusItem(){ showStatusViewerItem(statusViewerState.itemIndex - 1); }

// ---------- View tracking (records to Firestore once per viewer, ever) ----------
function recordStatusView(item){
  if(!state.user || typeof fbDb === 'undefined' || !fbDb) return;
  if(getRecordedViewIds().has(item.id)) return;
  markViewRecordedLocally(item.id);

  const statusRef = fbDb.collection('statuses').doc(item.id);
  const viewRef = statusRef.collection('views').doc(state.user.uid);
  viewRef.get().then(snap => {
    if(snap.exists) return; // already recorded (e.g. from another device) — don't double count
    const viewerDoc = {
      name: state.user.name || 'ব্যবহারকারী',
      avatarColor: state.user.avatarColor || '',
      avatarIcon: state.user.avatarIcon || '',
      viewedAt: Date.now()
    };
    return viewRef.set(viewerDoc).then(() => statusRef.update({ viewCount: firebase.firestore.FieldValue.increment(1) }));
  }).catch(err => console.warn('status view record failed:', err));
}

// ---------- Love reaction (double-tap the middle of the screen, or the heart button) ----------
function toggleStatusReaction(item, group){
  if(!state.user || !item || !group || group.uid === state.user.uid) return;
  if(typeof fbDb === 'undefined' || !fbDb) return;
  const reacted = getReactedStatusIds().has(item.id);
  const statusRef = fbDb.collection('statuses').doc(item.id);
  const reactionRef = statusRef.collection('reactions').doc(state.user.uid);
  if(reacted){
    unmarkStatusReactedLocally(item.id);
    item.reactCount = Math.max(0, (item.reactCount || 0) - 1);
    updateReactBtnUI(item, false);
    reactionRef.delete()
      .then(() => statusRef.update({ reactCount: firebase.firestore.FieldValue.increment(-1) }))
      .catch(err => {
        console.warn('unreact failed:', err);
        markStatusReactedLocally(item.id);
        item.reactCount = (item.reactCount || 0) + 1;
        updateReactBtnUI(item, true);
      });
  } else {
    markStatusReactedLocally(item.id);
    item.reactCount = (item.reactCount || 0) + 1;
    updateReactBtnUI(item, true);
    const doc = { name: state.user.name || 'ব্যবহারকারী', avatarColor: state.user.avatarColor || '', avatarIcon: state.user.avatarIcon || '', reactedAt: Date.now(), type:'love' };
    reactionRef.set(doc)
      .then(() => statusRef.update({ reactCount: firebase.firestore.FieldValue.increment(1) }))
      .catch(err => {
        console.warn('react failed:', err);
        unmarkStatusReactedLocally(item.id);
        item.reactCount = Math.max(0, (item.reactCount || 0) - 1);
        updateReactBtnUI(item, false);
      });
  }
}
function updateReactBtnUI(item, reacted){
  const btn = document.getElementById('statusViewReactBtn');
  if(!btn) return;
  btn.classList.toggle('reacted', reacted);
  const icon = btn.querySelector('i'); if(icon) icon.className = reacted ? 'fa-solid fa-heart' : 'fa-regular fa-heart';
  const countEl = document.getElementById('statusViewReactCount');
  if(countEl) countEl.textContent = item.reactCount ? toBn(item.reactCount) : '';
}
function handleReactButtonTap(){
  const group = statusViewerState.groups[statusViewerState.groupIndex];
  if(!group) return;
  const item = group.items[statusViewerState.itemIndex];
  if(!item) return;
  toggleStatusReaction(item, group);
}

// ---------- "কারা দেখেছে" (who viewed) bottom sheet — own status only,
// each viewer who also reacted gets a small heart mark next to their name ----------
function ensureStatusViewersSheet(){
  if(document.getElementById('statusViewersSheet')) return;
  const scrim = document.createElement('div');
  scrim.id = 'statusViewersScrim';
  scrim.className = 'status-viewers-sheet-scrim';
  scrim.onclick = closeStatusViewersSheet;
  document.body.appendChild(scrim);

  const sheet = document.createElement('div');
  sheet.id = 'statusViewersSheet';
  sheet.className = 'status-viewers-sheet';
  sheet.innerHTML = `
    <div class="status-viewers-sheet-handle"></div>
    <div class="status-viewers-sheet-title">কারা দেখেছে</div>
    <div class="status-viewers-list" id="statusViewersList"></div>`;
  document.body.appendChild(sheet);
}

function openStatusViewersSheet(){
  const group = statusViewerState.groups[statusViewerState.groupIndex];
  if(!group || group.uid !== state.user.uid) return;
  const item = group.items[statusViewerState.itemIndex];
  if(!item) return;
  pauseStatusItemTimer();
  ensureStatusViewersSheet();
  document.getElementById('statusViewersSheet').classList.add('open');
  document.getElementById('statusViewersScrim').classList.add('open');
  const list = document.getElementById('statusViewersList');
  list.innerHTML = `<div class="status-viewers-empty">লোড হচ্ছে...</div>`;

  const statusRef = fbDb.collection('statuses').doc(item.id);
  Promise.all([
    statusRef.collection('views').orderBy('viewedAt','desc').get(),
    statusRef.collection('reactions').get()
  ]).then(([viewsSnap, reactsSnap]) => {
    if(viewsSnap.empty){ list.innerHTML = `<div class="status-viewers-empty">এখনো কেউ দেখেনি</div>`; return; }
    const reactedUids = new Set(reactsSnap.docs.map(d => d.id));
    list.innerHTML = viewsSnap.docs.map(d => {
      const v = d.data();
      const reacted = reactedUids.has(d.id);
      return `<div class="status-viewer-row">
        <div class="status-viewer-avatar" style="background:${v.avatarColor || PROFILE_AVATAR_COLORS[0]}">${avatarGlyph({ name:v.name, avatarIcon:v.avatarIcon })}</div>
        <div class="status-viewer-name">${escapeHtml(v.name || 'ব্যবহারকারী')}</div>
        ${reacted ? '<i class="fa-solid fa-heart status-viewer-heart"></i>' : ''}
        <div class="status-viewer-time">${typeof timeAgoBn === 'function' ? timeAgoBn(v.viewedAt) : ''}</div>
      </div>`;
    }).join('');
  }).catch(() => { list.innerHTML = `<div class="status-viewers-empty">লোড করা যায়নি</div>`; });
}

function closeStatusViewersSheet(){
  const sheet = document.getElementById('statusViewersSheet');
  const scrim = document.getElementById('statusViewersScrim');
  if(sheet) sheet.classList.remove('open');
  if(scrim) scrim.classList.remove('open');
  if(statusViewerState.open) resumeStatusItemTimer();
}

// ---------- Delete own status item ----------
function confirmDeleteCurrentStatusItem(){
  const group = statusViewerState.groups[statusViewerState.groupIndex];
  if(!group || group.uid !== state.user.uid) return;
  const item = group.items[statusViewerState.itemIndex];
  if(!item) return;
  if(statusViewerState.mode === 'highlight'){
    if(typeof confirmRemoveFromHighlight === 'function') confirmRemoveFromHighlight(item, group);
    return;
  }
  pauseStatusItemTimer();
  if(!confirm('এই স্ট্যাটাসটি মুছে ফেলতে চান?')){ resumeStatusItemTimer(); return; }
  deleteStatusItem(item, group);
}

function deleteStatusItem(item, group){
  const statusRef = fbDb.collection('statuses').doc(item.id);
  Promise.all([
    statusRef.collection('views').get(),
    statusRef.collection('reactions').get()
  ]).then(([viewsSnap, reactsSnap]) => {
    const batch = fbDb.batch();
    viewsSnap.forEach(d => batch.delete(d.ref));
    reactsSnap.forEach(d => batch.delete(d.ref));
    batch.delete(statusRef);
    return batch.commit();
  }).then(() => {
    showToast('স্ট্যাটাস মুছে ফেলা হয়েছে');
    const idx = group.items.indexOf(item);
    if(idx > -1) group.items.splice(idx, 1);
    statusGroupsCache = statusGroupsCache.filter(g => g.uid !== group.uid || g.items.length);
    statusRowFetchedAt = 0;

    if(!group.items.length){
      const gi = statusViewerState.groups.indexOf(group);
      if(gi > -1) statusViewerState.groups.splice(gi, 1);
    }
    if(!statusViewerState.groups.length){ closeStatusViewer(); return; }
    if(statusViewerState.groupIndex >= statusViewerState.groups.length) statusViewerState.groupIndex = statusViewerState.groups.length - 1;
    const curGroup = statusViewerState.groups[statusViewerState.groupIndex];
    statusViewerState.itemIndex = Math.min(statusViewerState.itemIndex, Math.max(0, curGroup.items.length - 1));
    renderStatusViewerGroup();
  }).catch(err => {
    console.warn('status delete failed:', err);
    showToast('মুছে ফেলা যায়নি');
    resumeStatusItemTimer();
  });
}
