// ---------- Status audio engine: voice-status + background-music-on-status ----------
// Two related but distinct features share every low-level piece in this file:
//
//   1) VOICE STATUS — a status slide whose entire content is a recorded
//      voice clip (mic → MediaRecorder), shown full-screen in the viewer as
//      a flat waveform on a coloured background, tap/hold to pause exactly
//      like every other status item. Up to STATUS_VOICE_MAX_MS long.
//
//   2) BACKGROUND MUSIC — a short (≤ STATUS_MUSIC_MAX_MS) audio clip
//      attached to an existing text or photo slide, WhatsApp-status-style:
//      either recorded live or picked from a file on the phone and trimmed
//      to a 15-second window, then baked in as a small looping/playing clip
//      that plays while that slide is on screen. The slide's own on-screen
//      duration stretches to match the clip (same rule WhatsApp itself
//      uses), instead of the usual fixed STATUS_ITEM_MS.
//
// Neither feature ships any actual music files — that would mean either
// downloading copyrighted tracks or fabricating fake ones, so instead this
// only builds the *mechanism*: record-your-own-voice, or pick-and-trim any
// audio file already on the user's phone (their own recordings, or any
// nasheed/gojol file they've legally downloaded and saved locally).
//
// To make that picking-and-trimming feel like a real "pick a song" flow
// instead of a bare file input every time, every clip that's picked+trimmed
// or recorded for BACKGROUND MUSIC is also kept in a small personal, on-device
// "আমার মিউজিক" library (IndexedDB via IDBKV, see statusMusicLib* below) —
// so the next status reuses it with one tap, with inline play-preview,
// search and delete, instead of re-picking a file from the phone every time.
// Purely a per-device convenience list of the user's own already-trimmed
// clips; still no bundled/streamed catalog of any kind.
//
// Everything is stored the same way images already are in this codebase —
// a compressed clip base64-encoded directly into the Firestore status
// document (see firestore.rules) — so no Firebase Storage bucket is
// required. Clips are re-encoded through MediaRecorder at a low, fixed
// bitrate specifically so that stays small (a full 60s voice status is
// well under 500KB; a 15s music clip is well under 100KB).
//
// Data shape added to a status doc (both features share the same fields —
// which one applies is implied by `type`: type:'voice' means audioData IS
// the content, type:'text'/'image' with audioData means it's background
// music riding along on top of the usual text/imageData):
//   audioData     — base64 data: URL of the compressed clip
//   audioDuration — clip length in ms
//   audioPeaks    — ~40 numbers (0..1), precomputed waveform shape so the
//                   viewer never has to decode audio just to draw bars
//   audioName     — optional short label, background-music slides only
//                   ("রেকর্ড করা অডিও" or a filename-derived title)

const STATUS_VOICE_MAX_MS = 60000;   // standalone voice-status cap: 60s
const STATUS_MUSIC_MAX_MS = 15000;   // background-music cap: 15s, WhatsApp-style
const STATUS_VOICE_BITRATE = 48000;  // the clip IS the content — a bit more headroom
const STATUS_MUSIC_BITRATE = 28000;  // just a backing track — keep it tiny
const STATUS_AUDIO_MAX_BYTES = 750000; // matches firestore.rules' audioData cap
const STATUS_PEAK_BARS = 40;         // resolution of the stored waveform shape
const STATUS_LIVE_BAR_COUNT = 24;    // bars shown while actively recording
const STATUS_MUSIC_LIB_KEY = 'qr_status_music_lib'; // IDBKV key for the personal music library
const STATUS_MUSIC_LIB_MAX = 24;     // how many personal clips to remember (oldest drop off)

function statusVoiceSupported(){
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}
function statusVoiceTrimSupported(){
  // Trim-from-file additionally needs decodeAudioData + a stream destination.
  return statusVoiceSupported() && !!(window.AudioContext || window.webkitAudioContext);
}

function statusPickRecorderMime(){
  const candidates = ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus'];
  for(const c of candidates){
    try{ if(window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c; }catch(e){}
  }
  return '';
}

// ==================================================================
// Personal "আমার মিউজিক" library — a per-device list of previously
// picked+trimmed or recorded background-music clips, so the next status
// reuses one with a single tap instead of re-picking a file from the phone
// every time. Backed by IDBKV (same store the composer draft already uses),
// entries are { id, name, dataUrl, duration, peaks, savedAt }, newest first,
// capped at STATUS_MUSIC_LIB_MAX (oldest quietly drop off).
// ==================================================================
function statusMusicLibLoad(){
  try{
    if(typeof IDBKV === 'undefined') return [];
    const raw = IDBKV.get(STATUS_MUSIC_LIB_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  }catch(e){ return []; }
}
function statusMusicLibSave(list){
  try{ if(typeof IDBKV !== 'undefined') IDBKV.set(STATUS_MUSIC_LIB_KEY, JSON.stringify(list)); }catch(e){}
}
function statusMusicLibAdd(track){
  // track: { name, dataUrl, duration, peaks }
  let list = statusMusicLibLoad();
  list = list.filter(t => !(t.name === track.name && t.duration === track.duration));
  list.unshift({
    id: (typeof statusUid === 'function' ? statusUid() : ('m' + Date.now().toString(36))),
    name: track.name, dataUrl: track.dataUrl, duration: track.duration, peaks: track.peaks,
    savedAt: Date.now()
  });
  if(list.length > STATUS_MUSIC_LIB_MAX) list = list.slice(0, STATUS_MUSIC_LIB_MAX);
  statusMusicLibSave(list);
  return list;
}
function statusMusicLibRemove(id){
  const list = statusMusicLibLoad().filter(t => t.id !== id);
  statusMusicLibSave(list);
  return list;
}

// ==================================================================
// Live microphone recording — used for both features (different maxMs /
// bitrate). Drives a set of live bar elements from an AnalyserNode while
// recording, and auto-stops at maxMs.
// ==================================================================
let statusVoiceSession = null; // { stream, actx, analyser, recorder, chunks, raf, startedAt, maxMs, mimeType, onDone }

function statusVoiceCleanupSession(keepStream){
  const s = statusVoiceSession;
  if(!s) return;
  if(s.raf) cancelAnimationFrame(s.raf);
  try{ if(s.recorder && s.recorder.state !== 'inactive') s.recorder.stop(); }catch(e){}
  if(!keepStream){
    try{ if(s.stream) s.stream.getTracks().forEach(t => t.stop()); }catch(e){}
  }
  try{ if(s.actx && s.actx.state !== 'closed') s.actx.close(); }catch(e){}
  statusVoiceSession = null;
}

// Cancels any in-progress recording without invoking onDone — used when the
// composer/sheet is closed mid-recording.
function statusVoiceCancelActiveRecording(){
  if(statusVoiceSession) statusVoiceSession.cancelled = true;
  statusVoiceCleanupSession(false);
}

// opts: { maxMs, bitrate, barsEl, timerEl, onDone(blob, durationMs), onError(err) }
async function statusVoiceStartRecording(opts){
  if(!statusVoiceSupported()){ if(opts.onError) opts.onError(new Error('unsupported')); return; }
  statusVoiceCleanupSession(false);

  let stream;
  try{
    stream = await navigator.mediaDevices.getUserMedia({ audio:true });
  }catch(e){
    if(opts.onError) opts.onError(e);
    return;
  }

  const mimeType = statusPickRecorderMime();
  const recOpts = {};
  if(mimeType) recOpts.mimeType = mimeType;
  if(opts.bitrate) recOpts.audioBitsPerSecond = opts.bitrate;

  let recorder;
  try{ recorder = new MediaRecorder(stream, recOpts); }
  catch(e){ stream.getTracks().forEach(t => t.stop()); if(opts.onError) opts.onError(e); return; }

  const chunks = [];
  const session = { stream, recorder, chunks, maxMs: opts.maxMs, mimeType, cancelled:false, actx:null, raf:null, startedAt:0 };
  statusVoiceSession = session;

  recorder.ondataavailable = (e) => { if(e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    const durationMs = clamp(Date.now() - session.startedAt, 200, opts.maxMs);
    const wasCancelled = session.cancelled;
    statusVoiceCleanupSession(false);
    if(wasCancelled) return;
    const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
    if(opts.onDone) opts.onDone(blob, durationMs);
  };

  // Live waveform: a lightweight AnalyserNode drives STATUS_LIVE_BAR_COUNT
  // bar heights every animation frame — flat colour bars, no glow.
  let bars = [];
  if(opts.barsEl){
    opts.barsEl.innerHTML = '';
    for(let i=0;i<STATUS_LIVE_BAR_COUNT;i++){
      const b = document.createElement('div');
      b.className = 'status-voice-bar';
      opts.barsEl.appendChild(b);
      bars.push(b);
    }
  }

  try{
    const AC = window.AudioContext || window.webkitAudioContext;
    const actx = new AC();
    session.actx = actx;
    const src = actx.createMediaStreamSource(stream);
    const analyser = actx.createAnalyser();
    analyser.fftSize = 64;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);

    function tick(){
      if(!statusVoiceSession || statusVoiceSession !== session) return;
      analyser.getByteFrequencyData(data);
      if(bars.length){
        const step = Math.max(1, Math.floor(data.length / bars.length));
        for(let i=0;i<bars.length;i++){
          const v = data[i*step] || 0;
          bars[i].style.height = Math.max(10, Math.round((v/255)*100)) + '%';
        }
      }
      const elapsed = Date.now() - session.startedAt;
      if(opts.timerEl) opts.timerEl.textContent = fmtTime(Math.min(elapsed, opts.maxMs)/1000);
      if(elapsed >= opts.maxMs){ statusVoiceStopRecordingManually(); return; }
      session.raf = requestAnimationFrame(tick);
    }
    session.startedAt = Date.now();
    recorder.start();
    tick();
  }catch(e){
    session.startedAt = session.startedAt || Date.now();
    recorder.start();
  }
}

function statusVoiceStopRecordingManually(){
  const s = statusVoiceSession;
  if(!s || !s.recorder || s.recorder.state === 'inactive') return;
  s.recorder.stop();
}

// ==================================================================
// File-pick → decode → waveform peaks → drag-to-trim → re-encode.
// Used only by the background-music "pick from phone" path.
// ==================================================================
async function statusVoiceDecodeFile(file){
  const buf = await file.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const actx = new AC();
  try{
    const audioBuffer = await actx.decodeAudioData(buf.slice(0));
    return audioBuffer;
  } finally {
    try{ actx.close(); }catch(e){}
  }
}

function statusVoiceComputePeaks(audioBuffer, numBars, startSec, durSec){
  const rate = audioBuffer.sampleRate;
  const raw = audioBuffer.getChannelData(0);
  const startSample = Math.floor((startSec||0) * rate);
  const endSample = Math.min(raw.length, startSample + Math.floor((durSec != null ? durSec : audioBuffer.duration) * rate));
  const span = Math.max(1, endSample - startSample);
  const blockSize = Math.max(1, Math.floor(span / numBars));
  const peaks = [];
  for(let i=0;i<numBars;i++){
    let max = 0;
    const from = startSample + i*blockSize;
    const to = Math.min(endSample, from + blockSize);
    for(let j=from;j<to;j++){ const v = Math.abs(raw[j] || 0); if(v > max) max = v; }
    peaks.push(max);
  }
  const maxAll = Math.max.apply(null, peaks.concat([0.05]));
  return peaks.map(p => Math.round(clamp(p / maxAll, 0.08, 1) * 100) / 100);
}

// Renders (a window of) an AudioBuffer to a small compressed Blob by
// playing it through a MediaStreamDestination and capturing that with
// MediaRecorder — this is what actually re-compresses/trims the clip.
// Takes roughly durSec of wall-clock time to resolve.
function statusVoiceRenderClipToBlob(audioBuffer, startSec, durSec, bitrate){
  return new Promise((resolve, reject) => {
    try{
      const AC = window.AudioContext || window.webkitAudioContext;
      const actx = new AC();
      const src = actx.createBufferSource();
      src.buffer = audioBuffer;
      const dest = actx.createMediaStreamDestination();
      src.connect(dest);
      const mimeType = statusPickRecorderMime();
      const recOpts = {};
      if(mimeType) recOpts.mimeType = mimeType;
      if(bitrate) recOpts.audioBitsPerSecond = bitrate;
      const rec = new MediaRecorder(dest.stream, recOpts);
      const chunks = [];
      rec.ondataavailable = (e) => { if(e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = () => { try{ actx.close(); }catch(e){} resolve(new Blob(chunks, { type: mimeType || 'audio/webm' })); };
      rec.onerror = (e) => { try{ actx.close(); }catch(err){} reject(e.error || e); };
      rec.start();
      const safeDur = clamp(durSec, 0.3, audioBuffer.duration - startSec);
      src.start(0, startSec, safeDur);
      src.onended = () => setTimeout(() => { try{ rec.stop(); }catch(e){} }, 80);
    }catch(err){ reject(err); }
  });
}

function statusBlobToDataUrl(blob){
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
function statusEstimateBase64Bytes(dataUrl){
  const comma = dataUrl.indexOf(',');
  const b64 = comma > -1 ? dataUrl.slice(comma+1) : dataUrl;
  return Math.round(b64.length * 0.75);
}

// ==================================================================
// Static waveform rendering + play/pause progress wiring — shared by the
// composer preview, the "pick from file" trim screen, and the main story
// viewer for both voice-status items and the background-music chip.
// ==================================================================
function statusRenderWaveformBars(containerEl, peaks){
  if(!containerEl) return;
  containerEl.innerHTML = (peaks && peaks.length ? peaks : new Array(STATUS_PEAK_BARS).fill(0.15))
    .map(p => `<div class="status-voice-bar" style="height:${Math.round(clamp(p,0.08,1)*100)}%"></div>`).join('');
}

// Wires a hidden <audio> element to a play/pause button + a waveform's
// progress overlay (a second, gold-coloured bar row clipped by width%).
// Returns a small controller so callers can start/stop/reset playback.
function statusWirePlayableAudio({ audioEl, wrapEl, playBtnEl, timeEl, src, durationMs }){
  if(!audioEl || !wrapEl) return null;
  audioEl.src = src;
  audioEl.preload = 'metadata';
  const progressEl = wrapEl.querySelector('.status-voice-progress');
  const durSec = (durationMs || 0) / 1000;

  function setIcon(playing){
    if(!playBtnEl) return;
    const i = playBtnEl.querySelector('i');
    if(i) i.className = playing ? 'fa-solid fa-pause' : 'fa-solid fa-play';
  }
  function onTime(){
    const cur = audioEl.currentTime || 0;
    const frac = durSec > 0 ? clamp(cur/durSec, 0, 1) : 0;
    if(progressEl) progressEl.style.width = (frac*100) + '%';
    if(timeEl) timeEl.textContent = fmtTime(cur) + ' / ' + fmtTime(durSec);
  }
  function onEnded(){ setIcon(false); audioEl.currentTime = 0; onTime(); }

  audioEl.addEventListener('timeupdate', onTime);
  audioEl.addEventListener('ended', onEnded);
  audioEl.addEventListener('play', () => setIcon(true));
  audioEl.addEventListener('pause', () => setIcon(false));
  if(timeEl) timeEl.textContent = fmtTime(0) + ' / ' + fmtTime(durSec);

  if(playBtnEl){
    playBtnEl.onclick = () => {
      if(audioEl.paused) audioEl.play().catch(() => {});
      else audioEl.pause();
    };
  }
  return {
    stop(){ try{ audioEl.pause(); audioEl.currentTime = 0; }catch(e){} },
    destroy(){
      audioEl.removeEventListener('timeupdate', onTime);
      audioEl.removeEventListener('ended', onEnded);
      try{ audioEl.pause(); }catch(e){}
    }
  };
}

function statusFormatRange(startSec, durSec, totalSec){
  return `${fmtTime(startSec)} – ${fmtTime(startSec+durSec)} (মোট ${fmtTime(totalSec)})`;
}

// ==================================================================
// Composer entry points — one shared bottom sheet drives both "record a
// voice status" and "attach background music" through the same
// idle → recording → preview flow; only what happens on confirm differs
// (routed by statusAudioSheetState.kind). Music additionally offers a
// pick-a-file-and-drag-to-trim path that voice status doesn't need — a
// status status is meant to be your own voice, not an uploaded track.
// ==================================================================
let statusAudioSheetState = { kind:null, slide:null };

function ensureStatusAudioSheet(){
  if(document.getElementById('statusAudioSheet')) return;
  const scrim = document.createElement('div');
  scrim.id = 'statusAudioSheetScrim';
  scrim.className = 'status-viewers-sheet-scrim';
  scrim.onclick = closeStatusAudioSheet;
  document.body.appendChild(scrim);

  const sheet = document.createElement('div');
  sheet.id = 'statusAudioSheet';
  sheet.className = 'status-viewers-sheet status-audio-sheet';
  sheet.innerHTML = `
    <div class="status-viewers-sheet-handle"></div>
    <div class="status-viewers-sheet-title" id="statusAudioSheetTitle"></div>
    <div class="status-audio-sheet-body" id="statusAudioSheetBody"></div>`;
  document.body.appendChild(sheet);
}

function openStatusVoiceSheet(){
  if(!statusVoiceSupported()){ showToast('এই ব্রাউজারে ভয়েস রেকর্ডিং সমর্থিত নয়'); return; }
  ensureStatusAudioSheet();
  statusAudioSheetState = { kind:'voice', slide: activeSlide() };
  document.getElementById('statusAudioSheetTitle').textContent = 'ভয়েস স্ট্যাটাস রেকর্ড করুন';
  renderAudioSheetRecorder(STATUS_VOICE_MAX_MS, STATUS_VOICE_BITRATE);
  openStatusAudioSheetEl();
}

function openStatusMusicSheet(){
  if(!statusVoiceTrimSupported()){ showToast('এই ব্রাউজারে মিউজিক যুক্ত করা সমর্থিত নয়'); return; }
  ensureStatusAudioSheet();
  const slide = activeSlide();
  statusAudioSheetState = { kind:'music', slide };
  document.getElementById('statusAudioSheetTitle').textContent = 'স্ট্যাটাসে মিউজিক যুক্ত করুন';
  renderMusicSourcePicker(slide);
  openStatusAudioSheetEl();
}

function openStatusAudioSheetEl(){
  document.getElementById('statusAudioSheet').classList.add('open');
  document.getElementById('statusAudioSheetScrim').classList.add('open');
}

function closeStatusAudioSheet(){
  statusVoiceCancelActiveRecording();
  statusVoicePauseAllComposerAudio();
  const sheet = document.getElementById('statusAudioSheet');
  const scrim = document.getElementById('statusAudioSheetScrim');
  if(sheet) sheet.classList.remove('open');
  if(scrim) scrim.classList.remove('open');
  statusAudioSheetState = { kind:null, slide:null };
  // This sheet also gets reused by the "save to highlight" album-picker
  // (status-highlights.js), which pauses the story viewer while it's open —
  // dismissing the sheet any other way (tapping the scrim) should resume it.
  if(statusViewerState.open && statusViewerState.paused) resumeStatusItemTimer();
}

function reopenAudioSheetEntryScreen(){
  const st = statusAudioSheetState;
  if(!st.kind) return;
  if(st.kind === 'voice') renderAudioSheetRecorder(STATUS_VOICE_MAX_MS, STATUS_VOICE_BITRATE);
  else renderMusicSourcePicker(st.slide);
}

function statusVoicePauseAllComposerAudio(){
  ['statusVoiceStageAudio','statusAudioPreviewAudio','statusTrimPreviewAudio','statusMusicLibPreviewAudio'].forEach(id => {
    const el = document.getElementById(id);
    if(el){ try{ el.pause(); }catch(e){} }
  });
}

// ---------- music: choose a source ----------
function renderMusicSourcePicker(slide){
  const body = document.getElementById('statusAudioSheetBody');
  const current = slide.musicData
    ? `<div class="status-audio-current" id="statusMusicCurrentCard">
         <button type="button" class="status-music-lib-play" data-id="__current__" title="প্রিভিউ শুনুন">
           <i class="fa-solid fa-play"></i>
           <span class="status-music-lib-eq"><i></i><i></i><i></i></span>
         </button>
         <div class="status-audio-current-label">${escapeHtml(slide.musicName || 'যুক্ত করা অডিও')} · ${fmtTime((slide.musicDuration||0)/1000)}</div>
         <button type="button" class="status-sheet-btn danger" id="statusMusicRemoveBtn" title="সরান"><i class="fa-solid fa-trash"></i></button>
       </div>` : '';

  const lib = statusMusicLibLoad();
  const libSection = lib.length ? `
    <div class="status-music-lib-head">
      <div class="status-music-lib-head-title"><i class="fa-solid fa-record-vinyl"></i> আমার মিউজিক <span class="status-music-lib-count">${toBn(lib.length)}</span></div>
      ${lib.length > 6 ? `<div class="status-music-lib-search-wrap"><i class="fa-solid fa-magnifying-glass"></i><input type="text" class="status-music-lib-search" id="statusMusicLibSearch" placeholder="খুঁজুন..."></div>` : ''}
    </div>
    <div class="status-music-lib-list" id="statusMusicLibList">${lib.map(statusMusicLibRowHtml).join('')}</div>
    <div class="status-music-lib-empty" id="statusMusicLibEmpty" style="display:none;">কোনো মিল পাওয়া যায়নি</div>` : '';

  const currentTrack = slide.musicData ? { id:'__current__', dataUrl: slide.musicData, duration: slide.musicDuration } : null;

  body.innerHTML = `
    ${current}
    <div class="status-audio-source-row">
      <button type="button" class="status-audio-source-btn" id="statusMusicRecordBtn">
        <i class="fa-solid fa-microphone"></i><span>রেকর্ড করুন</span>
      </button>
      <label class="status-audio-source-btn" id="statusMusicPickBtn">
        <i class="fa-solid fa-folder-open"></i><span>ফোন থেকে বাছুন</span>
        <input type="file" accept="audio/*" id="statusMusicFileInput" style="display:none;">
      </label>
    </div>
    <div id="statusSharedMusicSection"><p class="status-audio-hint" style="text-align:center;padding:2px 0 4px;"><i class="fa-solid fa-circle-notch fa-spin"></i> সংগ্রহ লোড হচ্ছে...</p></div>
    ${libSection}
    <audio id="statusMusicLibPreviewAudio" style="display:none;"></audio>
    <div class="status-audio-hint">সর্বোচ্চ ${fmtTime(STATUS_MUSIC_MAX_MS/1000)} — লম্বা ফাইল থেকে যেকোনো অংশ বেছে নিতে পারবেন। নিজের ফোনে রাখা যেকোনো গজল/নাশিদ ফাইল ব্যবহার করা যাবে — কপিরাইটেড গান দেওয়া থেকে বিরত থাকুন। একবার যুক্ত করা অডিও "আমার মিউজিক"-এ জমা থাকবে, পরেরবার এক ট্যাপেই বেছে নেওয়া যাবে।</div>`;

  if(current){
    document.getElementById('statusMusicRemoveBtn').onclick = () => {
      pushUndoSnapshot();
      slide.musicData = null; slide.musicDuration = null; slide.musicPeaks = null; slide.musicName = null; slide.musicTrackId = null;
      closeStatusAudioSheet();
      renderComposerStage();
      saveComposerDraft();
      showToast('অডিও সরানো হয়েছে');
    };
  }
  document.getElementById('statusMusicRecordBtn').onclick = () => renderAudioSheetRecorder(STATUS_MUSIC_MAX_MS, STATUS_MUSIC_BITRATE);
  document.getElementById('statusMusicFileInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if(file) handleMusicFilePick(file);
  });

  wireMusicLibraryList(slide, lib, currentTrack, []);
  loadSharedMusicSection(slide, lib, currentTrack);
}

// Admin-curated shared catalog (Firestore `sharedMusic`, managed from the
// admin panel's "মিউজিক" tab) — fetched once per page session and cached,
// since it's the same for every user and only an admin can change it.
let statusSharedMusicCache = null;
async function statusFetchSharedMusic(){
  if(statusSharedMusicCache) return statusSharedMusicCache;
  if(typeof fbDb === 'undefined' || !fbDb) return [];
  try{
    const snap = await fbDb.collection('sharedMusic').orderBy('createdAt','desc').get();
    statusSharedMusicCache = snap.docs.map(d => {
      const v = d.data();
      return { id: 'shared:'+d.id, name: v.title, dataUrl: v.audioData, duration: v.duration, peaks: v.peaks };
    });
  }catch(e){ statusSharedMusicCache = []; }
  return statusSharedMusicCache;
}

async function loadSharedMusicSection(slide, lib, currentTrack){
  const sharedList = await statusFetchSharedMusic();
  const sectionEl = document.getElementById('statusSharedMusicSection');
  if(!sectionEl) return; // sheet was closed/navigated away before this resolved
  if(!sharedList.length){ sectionEl.innerHTML = ''; return; }
  sectionEl.innerHTML = `
    <div class="status-music-lib-head">
      <div class="status-music-lib-head-title"><i class="fa-solid fa-layer-group"></i> সংগ্রহ <span class="status-music-lib-count">${toBn(sharedList.length)}</span></div>
      ${sharedList.length > 6 ? `<div class="status-music-lib-search-wrap"><i class="fa-solid fa-magnifying-glass"></i><input type="text" class="status-music-lib-search" id="statusSharedMusicSearch" placeholder="খুঁজুন..."></div>` : ''}
    </div>
    <div class="status-music-lib-list" id="statusSharedMusicList">${sharedList.map(statusSharedMusicRowHtml).join('')}</div>
    <div class="status-music-lib-empty" id="statusSharedMusicEmpty" style="display:none;">কোনো মিল পাওয়া যায়নি</div>`;
  wireMusicLibraryList(slide, lib, currentTrack, sharedList);
}

function statusSharedMusicRowHtml(t, idx){
  const delay = Math.min((idx || 0) * 35, 300);
  return `<div class="status-music-lib-row" data-id="${t.id}" role="button" tabindex="0" style="animation-delay:${delay}ms">
    <button type="button" class="status-music-lib-play" data-id="${t.id}">
      <i class="fa-solid fa-play"></i>
      <span class="status-music-lib-eq"><i></i><i></i><i></i></span>
    </button>
    <div class="status-music-lib-info">
      <div class="status-music-lib-name">${escapeHtml(t.name || 'অডিও')}</div>
      <div class="status-music-lib-time">${fmtTime((t.duration||0)/1000)}</div>
    </div>
  </div>`;
}

function statusMusicLibRowHtml(t, idx){
  const delay = Math.min((idx || 0) * 35, 300);
  return `<div class="status-music-lib-row" data-id="${t.id}" role="button" tabindex="0" style="animation-delay:${delay}ms">
    <button type="button" class="status-music-lib-play" data-id="${t.id}">
      <i class="fa-solid fa-play"></i>
      <span class="status-music-lib-eq"><i></i><i></i><i></i></span>
    </button>
    <div class="status-music-lib-info">
      <div class="status-music-lib-name">${escapeHtml(t.name || 'অডিও')}</div>
      <div class="status-music-lib-time">${fmtTime((t.duration||0)/1000)}</div>
    </div>
    <button type="button" class="status-music-lib-del" data-id="${t.id}" title="মুছুন"><i class="fa-solid fa-trash"></i></button>
  </div>`;
}

function attachLibTrackToSlide(slide, t){
  pushUndoSnapshot();
  slide.musicData = t.dataUrl; slide.musicDuration = t.duration; slide.musicPeaks = t.peaks; slide.musicName = t.name;
  // স্টোরি মডারেশন: অ্যাডমিন-নির্বাচিত 'সংগ্রহ'-এর ট্র্যাক হলে সার্ভার আইডি দিয়ে মিলিয়ে নেয় (বাইট-ফর-বাইট);
  // নিজের আপলোড/রেকর্ড করা অডিওতে আইডি নেই, তাই সেটা অ্যাডমিন রিভিউয়ে যায়।
  slide.musicTrackId = (t && typeof t.id === 'string' && t.id.indexOf('shared:') === 0) ? t.id : null;
  closeStatusAudioSheet();
  renderComposerStage();
  saveComposerDraft();
  showToast('মিউজিক যুক্ত হয়েছে');
}

// Wires the library list(s) + the "currently attached" card to one shared
// preview <audio> element, so tapping a different play button stops whichever
// clip was previewing before. Toggles a .playing class (button + its row)
// rather than swapping icon classNames by hand — the CSS owns what "playing"
// looks like (equalizer bars, gold accents), this just flags the state.
// sharedList is the admin-curated catalog (may still be loading — an empty
// array here just means its section isn't wired yet, harmless).
function wireMusicLibraryList(slide, lib, currentTrack, sharedList){
  sharedList = sharedList || [];
  const body = document.getElementById('statusAudioSheetBody');
  const audioEl = document.getElementById('statusMusicLibPreviewAudio');
  if(!audioEl || !body) return;

  function stopPreview(){
    try{ audioEl.pause(); }catch(e){}
    audioEl.dataset.playingId = '';
    body.querySelectorAll('.status-music-lib-play.playing').forEach(b => {
      b.classList.remove('playing');
      const row = b.closest('.status-music-lib-row');
      if(row) row.classList.remove('playing');
    });
  }
  audioEl.addEventListener('ended', stopPreview);

  function findTrack(id){
    if(id === '__current__') return currentTrack;
    return lib.find(t => t.id === id) || sharedList.find(t => t.id === id);
  }

  body.querySelectorAll('.status-music-lib-play').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if(audioEl.dataset.playingId === id && !audioEl.paused){ stopPreview(); return; }
      const track = findTrack(id);
      if(!track || !track.dataUrl) return;
      stopPreview();
      audioEl.src = track.dataUrl;
      audioEl.dataset.playingId = id;
      audioEl.play().then(() => {
        btn.classList.add('playing');
        const row = btn.closest('.status-music-lib-row');
        if(row) row.classList.add('playing');
      }).catch(() => {});
    };
  });

  // Personal library rows can be deleted; shared/collection rows can't (no
  // .status-music-lib-del button is ever rendered for them, so that part is
  // simply skipped for those rows) — otherwise both behave identically:
  // tap the row to attach, Enter/Space works too, search filters live.
  [
    { listId: 'statusMusicLibList', searchId: 'statusMusicLibSearch', emptyId: 'statusMusicLibEmpty', source: lib, onDelete: (id) => { statusMusicLibRemove(id); renderMusicSourcePicker(slide); } },
    { listId: 'statusSharedMusicList', searchId: 'statusSharedMusicSearch', emptyId: 'statusSharedMusicEmpty', source: sharedList, onDelete: null }
  ].forEach(cfg => {
    const listEl = document.getElementById(cfg.listId);
    if(!listEl) return;

    listEl.querySelectorAll('.status-music-lib-row').forEach(row => {
      row.onclick = () => {
        const t = cfg.source.find(x => x.id === row.dataset.id);
        if(t) attachLibTrackToSlide(slide, t);
      };
      row.addEventListener('keydown', (e) => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); row.click(); } });
      const delBtn = row.querySelector('.status-music-lib-del');
      if(delBtn && cfg.onDelete){
        delBtn.onclick = (e) => { e.stopPropagation(); cfg.onDelete(row.dataset.id); };
      }
    });

    const searchEl = document.getElementById(cfg.searchId);
    const emptyEl = document.getElementById(cfg.emptyId);
    if(searchEl){
      searchEl.oninput = () => {
        const q = searchEl.value.trim().toLowerCase();
        let visibleCount = 0;
        listEl.querySelectorAll('.status-music-lib-row').forEach(row => {
          const nameEl = row.querySelector('.status-music-lib-name');
          const name = (nameEl ? nameEl.textContent : '').toLowerCase();
          const match = !q || name.includes(q);
          row.style.display = match ? '' : 'none';
          if(match) visibleCount++;
        });
        if(emptyEl) emptyEl.style.display = visibleCount ? 'none' : 'block';
      };
    }
  });
}

async function handleMusicFilePick(file){
  const body = document.getElementById('statusAudioSheetBody');
  body.innerHTML = `<div class="status-audio-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> লোড হচ্ছে...</div>`;
  try{
    const audioBuffer = await statusVoiceDecodeFile(file);
    renderMusicTrimUI(audioBuffer, file.name || 'অডিও');
  }catch(e){
    console.warn('music decode failed:', e);
    showToast('এই অডিও ফাইলটি পড়া যায়নি');
    renderMusicSourcePicker(statusAudioSheetState.slide);
  }
}

function renderMusicTrimUI(audioBuffer, fileName){
  const body = document.getElementById('statusAudioSheetBody');
  const total = audioBuffer.duration;
  const maxSec = Math.min(STATUS_MUSIC_MAX_MS/1000, total);
  let startSec = 0;
  const fullPeaks = statusVoiceComputePeaks(audioBuffer, 90, 0, total);

  body.innerHTML = `
    <div class="status-trim-wrap">
      <div class="status-trim-track" id="statusTrimTrack">
        <div class="status-voice-bars status-trim-bars">${fullPeaks.map(p => `<div class="status-voice-bar" style="height:${Math.round(p*100)}%"></div>`).join('')}</div>
        <div class="status-trim-window" id="statusTrimWindow"></div>
      </div>
      <div class="status-audio-time" id="statusTrimTime"></div>
      <div class="status-audio-actions">
        <button type="button" class="status-sheet-btn" id="statusTrimBackBtn"><i class="fa-solid fa-chevron-right"></i> পেছনে</button>
        <button type="button" class="status-sheet-btn" id="statusTrimPreviewBtn"><i class="fa-solid fa-play"></i> শুনুন</button>
        <button type="button" class="status-sheet-btn primary" id="statusTrimConfirmBtn"><i class="fa-solid fa-check"></i> যুক্ত করুন</button>
      </div>
    </div>`;

  const track = document.getElementById('statusTrimTrack');
  const win = document.getElementById('statusTrimWindow');
  const timeEl = document.getElementById('statusTrimTime');
  win.style.width = (total > 0 ? (maxSec/total*100) : 100) + '%';

  function updateWinPos(){
    win.style.left = (total > 0 ? (startSec/total*100) : 0) + '%';
    timeEl.textContent = statusFormatRange(startSec, maxSec, total);
  }
  updateWinPos();

  let dragging = false, dragStartX = 0, dragStartSec = 0;
  win.addEventListener('pointerdown', (e) => {
    dragging = true; dragStartX = e.clientX; dragStartSec = startSec;
    try{ win.setPointerCapture(e.pointerId); }catch(err){}
  });
  win.addEventListener('pointermove', (e) => {
    if(!dragging) return;
    const trackW = track.getBoundingClientRect().width || 1;
    const deltaSec = ((e.clientX - dragStartX) / trackW) * total;
    startSec = clamp(dragStartSec + deltaSec, 0, Math.max(0, total - maxSec));
    updateWinPos();
  });
  win.addEventListener('pointerup', () => { dragging = false; });
  win.addEventListener('pointercancel', () => { dragging = false; });
  track.addEventListener('pointerdown', (e) => {
    if(e.target === win) return;
    const rect = track.getBoundingClientRect();
    const frac = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    startSec = clamp(frac*total - maxSec/2, 0, Math.max(0, total - maxSec));
    updateWinPos();
  });

  document.getElementById('statusTrimBackBtn').onclick = () => renderMusicSourcePicker(statusAudioSheetState.slide);

  let previewAudioEl = document.getElementById('statusTrimPreviewAudio');
  if(!previewAudioEl){ previewAudioEl = document.createElement('audio'); previewAudioEl.id = 'statusTrimPreviewAudio'; previewAudioEl.style.display = 'none'; document.body.appendChild(previewAudioEl); }
  document.getElementById('statusTrimPreviewBtn').onclick = async () => {
    const btn = document.getElementById('statusTrimPreviewBtn');
    btn.disabled = true;
    try{
      previewAudioEl.pause();
      const blob = await statusVoiceRenderClipToBlob(audioBuffer, startSec, maxSec, STATUS_MUSIC_BITRATE);
      previewAudioEl.src = URL.createObjectURL(blob);
      await previewAudioEl.play();
    }catch(e){ showToast('প্রিভিউ চালানো যায়নি'); }
    btn.disabled = false;
  };

  document.getElementById('statusTrimConfirmBtn').onclick = async () => {
    const btn = document.getElementById('statusTrimConfirmBtn');
    btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> প্রসেস হচ্ছে...';
    try{
      const blob = await statusVoiceRenderClipToBlob(audioBuffer, startSec, maxSec, STATUS_MUSIC_BITRATE);
      const dataUrl = await statusBlobToDataUrl(blob);
      if(statusEstimateBase64Bytes(dataUrl) > STATUS_AUDIO_MAX_BYTES){
        showToast('অডিওটি এখনও বড়, অন্য একটি অংশ বেছে দেখুন');
        btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-check"></i> যুক্ত করুন';
        return;
      }
      const peaks = statusVoiceComputePeaks(audioBuffer, STATUS_PEAK_BARS, startSec, maxSec);
      const slide = statusAudioSheetState.slide;
      const musicName = (fileName || 'অডিও').replace(/\.[a-zA-Z0-9]+$/, '').slice(0, 60);
      pushUndoSnapshot();
      slide.musicData = dataUrl;
      slide.musicTrackId = null;
      slide.musicDuration = Math.round(maxSec*1000);
      slide.musicPeaks = peaks;
      slide.musicName = musicName;
      statusMusicLibAdd({ name: musicName, dataUrl, duration: Math.round(maxSec*1000), peaks });
      closeStatusAudioSheet();
      renderComposerStage();
      saveComposerDraft();
      showToast('মিউজিক যুক্ত হয়েছে');
    }catch(e){
      console.warn('music trim confirm failed:', e);
      showToast('মিউজিক যুক্ত করা যায়নি');
      btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-check"></i> যুক্ত করুন';
    }
  };
}

// ---------- shared idle → recording → preview flow ----------
function renderAudioSheetRecorder(maxMs, bitrate){
  const body = document.getElementById('statusAudioSheetBody');
  body.innerHTML = `
    <div class="status-voice-comp status-voice-comp-idle">
      <button type="button" class="status-voice-record-btn" id="statusAudioRecStartBtn"><i class="fa-solid fa-microphone"></i></button>
      <div class="status-audio-hint">ট্যাপ করে রেকর্ড শুরু করুন — সর্বোচ্চ ${fmtTime(maxMs/1000)}</div>
    </div>`;
  document.getElementById('statusAudioRecStartBtn').onclick = () => {
    body.innerHTML = `
      <div class="status-voice-comp status-voice-comp-recording">
        <div class="status-voice-rec-dot"></div>
        <div class="status-voice-bars status-voice-bars-live" id="statusAudioLiveBars"></div>
        <div class="status-voice-time" id="statusAudioLiveTimer">০:০০</div>
        <button type="button" class="status-voice-stop-btn" id="statusAudioStopBtn"><i class="fa-solid fa-stop"></i></button>
      </div>`;
    document.getElementById('statusAudioStopBtn').onclick = () => statusVoiceStopRecordingManually();
    statusVoiceStartRecording({
      maxMs, bitrate,
      barsEl: document.getElementById('statusAudioLiveBars'),
      timerEl: document.getElementById('statusAudioLiveTimer'),
      onDone: (blob, durationMs) => finishAudioSheetRecording(blob, durationMs),
      onError: (err) => {
        console.warn('recording failed:', err);
        showToast(err && err.name === 'NotAllowedError' ? 'মাইক্রোফোন অনুমতি প্রয়োজন' : 'রেকর্ডিং শুরু করা যায়নি');
        renderAudioSheetRecorder(maxMs, bitrate);
      }
    });
  };
}

async function finishAudioSheetRecording(blob, durationMs){
  const body = document.getElementById('statusAudioSheetBody');
  body.innerHTML = `<div class="status-audio-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> প্রসেস হচ্ছে...</div>`;
  const kind = statusAudioSheetState.kind;
  const maxMs = kind === 'voice' ? STATUS_VOICE_MAX_MS : STATUS_MUSIC_MAX_MS;
  const bitrate = kind === 'voice' ? STATUS_VOICE_BITRATE : STATUS_MUSIC_BITRATE;
  try{
    const dataUrl = await statusBlobToDataUrl(blob);
    if(statusEstimateBase64Bytes(dataUrl) > STATUS_AUDIO_MAX_BYTES){
      showToast('রেকর্ডিং বড় হয়ে গেছে, আবার চেষ্টা করুন');
      renderAudioSheetRecorder(maxMs, bitrate);
      return;
    }
    let peaks;
    try{
      const buf = await blob.arrayBuffer();
      const AC = window.AudioContext || window.webkitAudioContext;
      const actx = new AC();
      const audioBuffer = await actx.decodeAudioData(buf.slice(0));
      peaks = statusVoiceComputePeaks(audioBuffer, STATUS_PEAK_BARS, 0, audioBuffer.duration);
      actx.close();
    }catch(e){ peaks = new Array(STATUS_PEAK_BARS).fill(0.4); }
    renderAudioSheetPreview(dataUrl, durationMs, peaks);
  }catch(e){
    console.warn('recording finalize failed:', e);
    showToast('রেকর্ডিং সংরক্ষণ করা যায়নি');
    reopenAudioSheetEntryScreen();
  }
}

function renderAudioSheetPreview(dataUrl, durationMs, peaks){
  const st = statusAudioSheetState;
  const maxMs = st.kind === 'voice' ? STATUS_VOICE_MAX_MS : STATUS_MUSIC_MAX_MS;
  const bitrate = st.kind === 'voice' ? STATUS_VOICE_BITRATE : STATUS_MUSIC_BITRATE;
  const body = document.getElementById('statusAudioSheetBody');
  body.innerHTML = `
    <div class="status-audio-preview-wrap" id="statusAudioPreviewWrap">
      <button type="button" class="status-voice-play-btn" id="statusAudioPreviewPlay"><i class="fa-solid fa-play"></i></button>
      <div class="status-voice-bars" id="statusAudioPreviewBars"></div>
      <div class="status-voice-progress"></div>
    </div>
    <div class="status-audio-time" id="statusAudioPreviewTime"></div>
    <div class="status-audio-actions">
      <button type="button" class="status-sheet-btn" id="statusAudioRerecordBtn"><i class="fa-solid fa-rotate-left"></i> আবার রেকর্ড</button>
      <button type="button" class="status-sheet-btn primary" id="statusAudioConfirmBtn"><i class="fa-solid fa-check"></i> যুক্ত করুন</button>
    </div>`;
  statusRenderWaveformBars(document.getElementById('statusAudioPreviewBars'), peaks);
  let audioEl = document.getElementById('statusAudioPreviewAudio');
  if(!audioEl){ audioEl = document.createElement('audio'); audioEl.id = 'statusAudioPreviewAudio'; audioEl.style.display = 'none'; document.body.appendChild(audioEl); }
  statusWirePlayableAudio({
    audioEl, wrapEl: document.getElementById('statusAudioPreviewWrap'),
    playBtnEl: document.getElementById('statusAudioPreviewPlay'),
    timeEl: document.getElementById('statusAudioPreviewTime'),
    src: dataUrl, durationMs
  });
  document.getElementById('statusAudioRerecordBtn').onclick = () => { audioEl.pause(); renderAudioSheetRecorder(maxMs, bitrate); };
  document.getElementById('statusAudioConfirmBtn').onclick = () => {
    audioEl.pause();
    const slide = st.slide;
    pushUndoSnapshot();
    if(st.kind === 'voice'){
      slide.mode = 'voice';
      slide.voiceData = dataUrl; slide.voiceDuration = durationMs; slide.voicePeaks = peaks;
    } else {
      slide.musicData = dataUrl; slide.musicDuration = durationMs; slide.musicPeaks = peaks; slide.musicTrackId = null;
      const ordinal = statusMusicLibLoad().length + 1;
      slide.musicName = 'রেকর্ড করা অডিও ' + (typeof toBn === 'function' ? toBn(ordinal) : ordinal);
      statusMusicLibAdd({ name: slide.musicName, dataUrl, duration: durationMs, peaks });
    }
    closeStatusAudioSheet();
    renderComposerStage();
    saveComposerDraft();
    showToast(st.kind === 'voice' ? 'ভয়েস স্ট্যাটাস প্রস্তুত' : 'মিউজিক যুক্ত হয়েছে');
  };
}

// ---------- main composer stage: read-only-ish preview once a voice slide
// is committed (recording itself always happens in the sheet above) ----------
function renderVoiceStage(stage, slide){
  stage.style.background = slide.bg || STATUS_BG_SWATCHES[0];
  stage.innerHTML = `
    <div class="status-voice-comp status-voice-comp-preview">
      <div class="status-voice-comp-icon"><i class="fa-solid fa-microphone"></i></div>
      <div class="status-audio-preview-wrap" id="statusVoiceStageWrap">
        <button type="button" class="status-voice-play-btn" id="statusVoiceStagePlay"><i class="fa-solid fa-play"></i></button>
        <div class="status-voice-bars" id="statusVoiceStageBars"></div>
        <div class="status-voice-progress"></div>
      </div>
      <div class="status-audio-time" id="statusVoiceStageTime"></div>
    </div>`;
  statusRenderWaveformBars(document.getElementById('statusVoiceStageBars'), slide.voicePeaks);
  let audioEl = document.getElementById('statusVoiceStageAudio');
  if(!audioEl){ audioEl = document.createElement('audio'); audioEl.id = 'statusVoiceStageAudio'; audioEl.style.display = 'none'; document.body.appendChild(audioEl); }
  statusWirePlayableAudio({
    audioEl, wrapEl: document.getElementById('statusVoiceStageWrap'),
    playBtnEl: document.getElementById('statusVoiceStagePlay'),
    timeEl: document.getElementById('statusVoiceStageTime'),
    src: slide.voiceData, durationMs: slide.voiceDuration
  });
}

// A small dismissible chip shown on top of a text/image composer stage
// whenever that slide has background music attached.
function renderComposerMusicChip(stage, slide){
  const old = stage.querySelector('.status-music-chip-comp');
  if(old) old.remove();
  if(slide.mode === 'voice' || !slide.musicData) return;
  const chip = document.createElement('div');
  chip.className = 'status-music-chip-comp';
  chip.innerHTML = `<i class="fa-solid fa-music"></i><span>${escapeHtml(slide.musicName || 'অডিও')}</span><button type="button" id="statusCompMusicChipX"><i class="fa-solid fa-xmark"></i></button>`;
  stage.appendChild(chip);
  chip.querySelector('#statusCompMusicChipX').onclick = (e) => {
    e.stopPropagation();
    pushUndoSnapshot();
    slide.musicData = null; slide.musicDuration = null; slide.musicPeaks = null; slide.musicName = null; slide.musicTrackId = null;
    renderComposerStage();
    saveComposerDraft();
  };
}

// ==================================================================
// Main story viewer — voice-status + background-music playback. A single
// shared <audio> element lives in the viewer overlay (added in
// ensureStatusViewerOverlay); which clip is loaded just follows whichever
// item is currently on screen. The segmented progress bar at the top of
// the viewer (already timed to the item's real duration, see status.js
// showStatusViewerItem) is what visually communicates playback position —
// this just keeps the underlying audio itself in lockstep with it.
// ==================================================================
let statusViewerAudioMuted = false;

function statusViewerAudioEl(){ return document.getElementById('statusViewAudioEl'); }

function statusViewerLoadItemAudio(item){
  const el = statusViewerAudioEl();
  if(!el) return;
  try{ el.pause(); }catch(e){}
  if(!item || !item.audioData){ el.removeAttribute('src'); updateStatusMuteBtnVisibility(false); return; }
  el.src = item.audioData;
  el.muted = statusViewerAudioMuted;
  el.currentTime = 0;
  updateStatusMuteBtnVisibility(true, false);
  const playPromise = el.play();
  if(playPromise && playPromise.catch){
    playPromise.catch(() => { updateStatusMuteBtnVisibility(true, true); });
  }
}
function statusViewerPauseAudio(){ const el = statusViewerAudioEl(); if(el && el.src && !el.paused) el.pause(); }
function statusViewerResumeAudio(){ const el = statusViewerAudioEl(); if(el && el.src) el.play().catch(() => { updateStatusMuteBtnVisibility(true, true); }); }
function statusViewerStopAudio(){ const el = statusViewerAudioEl(); if(el){ try{ el.pause(); }catch(e){} el.removeAttribute('src'); } }

function updateStatusMuteBtnVisibility(show, blocked){
  const btn = document.getElementById('statusViewMuteBtn');
  if(!btn) return;
  btn.style.display = show ? 'flex' : 'none';
  const i = btn.querySelector('i');
  if(i) i.className = (statusViewerAudioMuted || blocked) ? 'fa-solid fa-volume-xmark' : 'fa-solid fa-volume-high';
}
function toggleStatusViewerMute(){
  statusViewerAudioMuted = !statusViewerAudioMuted;
  const el = statusViewerAudioEl();
  if(el){
    el.muted = statusViewerAudioMuted;
    if(!statusViewerAudioMuted) el.play().catch(() => {});
  }
  updateStatusMuteBtnVisibility(true, false);
}

// Draws the static waveform for whichever items in the just-rendered group
// carry audio (a full-width waveform for voice-status items).
function statusRenderItemWaveforms(group){
  const itemsHost = document.getElementById('statusViewItems');
  if(!itemsHost) return;
  group.items.forEach((it, i) => {
    if(!it.audioData) return;
    const el = itemsHost.querySelector(`.status-view-item[data-i="${i}"] .status-voice-view-bars`);
    if(el) statusRenderWaveformBars(el, it.audioPeaks);
  });
}
