// ---------- Audio playback engine ----------
const audioEl = document.getElementById('audioEl');
const playerBar = document.getElementById('playerBar');
audioEl.preload = 'auto';
// playsInline helps background/lock-screen playback behave and lets the
// browser fully own buffering while the screen is locked.
audioEl.setAttribute('playsinline', '');

const SPEED_STEPS = [0.75, 1, 1.25, 1.5, 2];

// ---------- Smart auto-scroll / follow-along ----------
// Keeps the visible ayah in sync with what's playing, but thoughtfully:
//  - skips the scroll when the ayah is already comfortably on screen, so
//    a run of short back-to-back ayahs doesn't wobble the page every second
//  - respects prefers-reduced-motion (instant jump instead of smooth scroll)
//  - if the listener manually scrolls away to read elsewhere while tilawat
//    keeps going, we stop yanking the screen back to it — instead a small
//    "বর্তমান আয়াতে যান" button appears so they can rejoin whenever they want
let followAlongEnabled = true;
let isAutoScrolling = false;
let autoScrollResetTimer = null;
let currentPlayingCard = null;
let followBtn = null;

function prefersReducedMotion(){
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

// --header-h / --player-h are the *real* rendered heights of the fixed
// header and player bar (set in app.js / css), so this stays correct
// across themes and screen sizes instead of hardcoding pixel guesses.
function fixedChromeHeights(){
  const cs = getComputedStyle(document.documentElement);
  const headerH = parseFloat(cs.getPropertyValue('--header-h')) || 56;
  const playerH = parseFloat(cs.getPropertyValue('--player-h')) || 72;
  return { headerH, playerH };
}

function isCardComfortablyVisible(card){
  if(!card) return false;
  const { headerH, playerH } = fixedChromeHeights();
  const rect = card.getBoundingClientRect();
  const visibleTop = headerH + 12;
  const visibleBottom = window.innerHeight - playerH - 12;
  const cardCenter = rect.top + rect.height / 2;
  return cardCenter >= visibleTop && cardCenter <= visibleBottom;
}

function scrollToCard(card){
  if(!card) return;
  isAutoScrolling = true;
  card.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
  clearTimeout(autoScrollResetTimer);
  // Rough upper bound for how long a smooth scrollIntoView takes, so we
  // don't mistake our own scroll for the listener scrolling away.
  autoScrollResetTimer = setTimeout(() => { isAutoScrolling = false; }, prefersReducedMotion() ? 60 : 700);
}

function ensureFollowButton(){
  if(followBtn) return followBtn;
  followBtn = document.createElement('button');
  followBtn.type = 'button';
  followBtn.id = 'followAyahBtn';
  followBtn.className = 'follow-ayah-btn';
  followBtn.innerHTML = '<i class="fa-solid fa-arrow-down"></i> বর্তমান আয়াতে যান';
  followBtn.addEventListener('click', () => {
    followAlongEnabled = true;
    hideFollowButton();
    if(currentPlayingCard) scrollToCard(currentPlayingCard);
  });
  document.body.appendChild(followBtn);
  return followBtn;
}
function showFollowButton(){ ensureFollowButton().classList.add('visible'); }
function hideFollowButton(){ if(followBtn) followBtn.classList.remove('visible'); }

// Passive scroll listener: tells manual scrolling apart from our own
// programmatic scrollIntoView calls (guarded by isAutoScrolling).
window.addEventListener('scroll', () => {
  if(isAutoScrolling || !state.isPlaying || !currentPlayingCard) return;
  if(isCardComfortablyVisible(currentPlayingCard)){
    followAlongEnabled = true;
    hideFollowButton();
  } else if(followAlongEnabled){
    followAlongEnabled = false;
    showFollowButton();
  }
}, { passive: true });

// ---------- Expand / collapse the player sheet ----------
// The collapsed row (play button + title + chevron) is always visible once
// a track is loaded. Tapping the title or the chevron reveals the fuller
// panel — seek bar, prev/repeat/sleep-timer/next, speed, reciter, autoplay —
// without permanently eating screen space the rest of the time.
function isPlayerExpanded(){ return playerBar.classList.contains('expanded'); }
function expandPlayer(){
  playerBar.classList.add('expanded');
  const btn = document.getElementById('playerExpandBtn');
  if(btn) btn.setAttribute('aria-expanded', 'true');
}
function collapsePlayer(){
  playerBar.classList.remove('expanded');
  const btn = document.getElementById('playerExpandBtn');
  if(btn) btn.setAttribute('aria-expanded', 'false');
  hideSleepTimerPopover();
}
function togglePlayerExpand(){ isPlayerExpanded() ? collapsePlayer() : expandPlayer(); }

// ---------- Circular progress ring on the collapsed play button ----------
const PC_RING_CIRCUMFERENCE = 2 * Math.PI * 20; // matches r=20 in the SVG markup
function updatePlayRing(){
  const ring = document.getElementById('pcRingFg');
  if(!ring) return;
  const dur = audioEl.duration;
  const frac = (isFinite(dur) && dur > 0) ? Math.min(1, audioEl.currentTime / dur) : 0;
  ring.style.strokeDasharray = String(PC_RING_CIRCUMFERENCE);
  ring.style.strokeDashoffset = String(PC_RING_CIRCUMFERENCE * (1 - frac));
}

// ---------- Repeat mode: off -> এই আয়াত -> এই সূরা -> off ----------
const REPEAT_MODES = ['off', 'ayah', 'surah'];
const REPEAT_LABELS = { off: '', ayah: '১', surah: '∞' };
const REPEAT_TITLES = {
  off: 'পুনরাবৃত্তি মোড: বন্ধ',
  ayah: 'পুনরাবৃত্তি মোড: এই আয়াত বারবার',
  surah: 'পুনরাবৃত্তি মোড: পুরো সূরা বারবার'
};
function updateRepeatUI(){
  const btn = document.getElementById('repeatBtn');
  if(!btn) return;
  btn.classList.remove('mode-ayah', 'mode-surah');
  if(state.repeatMode !== 'off') btn.classList.add(`mode-${state.repeatMode}`);
  btn.title = REPEAT_TITLES[state.repeatMode] || REPEAT_TITLES.off;
  btn.setAttribute('aria-label', btn.title);
  const tag = document.getElementById('repeatTag');
  if(tag) tag.textContent = REPEAT_LABELS[state.repeatMode] || '';
}
function cycleRepeatMode(){
  const idx = REPEAT_MODES.indexOf(state.repeatMode);
  state.repeatMode = REPEAT_MODES[(idx + 1) % REPEAT_MODES.length];
  saveRepeatMode();
  updateRepeatUI();
}

// ---------- Sleep timer ----------
// Lets the listener fall asleep to tilawat without it playing all night —
// pauses playback automatically once the chosen time elapses. Purely a
// convenience timer (in-page), so it only runs while the app is open.
let sleepTimerHandle = null;
let sleepTimerTickHandle = null;
let sleepTimerEndsAt = null;
function clearSleepTimer(){
  if(sleepTimerHandle) clearTimeout(sleepTimerHandle);
  if(sleepTimerTickHandle) clearInterval(sleepTimerTickHandle);
  sleepTimerHandle = null; sleepTimerTickHandle = null; sleepTimerEndsAt = null;
  updateSleepTimerUI();
}
function setSleepTimer(minutes){
  clearSleepTimer();
  if(!minutes) return;
  sleepTimerEndsAt = Date.now() + minutes * 60000;
  sleepTimerHandle = setTimeout(() => { pausePlayback(); clearSleepTimer(); }, minutes * 60000);
  sleepTimerTickHandle = setInterval(updateSleepTimerUI, 1000);
  updateSleepTimerUI();
}
function updateSleepTimerUI(){
  const btn = document.getElementById('sleepTimerBtn');
  const label = document.getElementById('sleepTimerLabel');
  if(!btn || !label) return;
  if(!sleepTimerEndsAt){
    btn.classList.remove('active');
    label.textContent = 'স্লিপ টাইমার';
    return;
  }
  const remaining = Math.max(0, sleepTimerEndsAt - Date.now());
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  btn.classList.add('active');
  label.textContent = `${toBn(mins)}:${toBn(String(secs).padStart(2,'0'))}`;
}
function hideSleepTimerPopover(){
  const pop = document.getElementById('sleepTimerPopover');
  const btn = document.getElementById('sleepTimerBtn');
  if(pop) pop.hidden = true;
  if(btn) btn.setAttribute('aria-expanded', 'false');
}
function toggleSleepTimerPopover(){
  const pop = document.getElementById('sleepTimerPopover');
  const btn = document.getElementById('sleepTimerBtn');
  if(!pop || !btn) return;
  const willShow = pop.hidden;
  pop.hidden = !willShow;
  btn.setAttribute('aria-expanded', String(willShow));
  if(willShow){
    pop.querySelectorAll('button').forEach(b => {
      const isCurrent = sleepTimerEndsAt && Number(b.dataset.min) === Math.ceil((sleepTimerEndsAt - Date.now())/60000);
      b.classList.toggle('active', !!isCurrent && Number(b.dataset.min) !== 0);
    });
  }
}

// ---------- শব্দ-অনুযায়ী (word-by-word) অডিও হাইলাইট ----------
// প্রতিটি আয়াতের অডিও ফাইল সম্পূর্ণ আয়াতের একটি একক mp3 (কোনো word-level
// টাইমস্ট্যাম্প মেটাডেটা এখানে নেই)। তাই যথাযথ karaoke-style সিঙ্ক সম্ভব নয়,
// কিন্তু একটা smart approximation করা যায়: প্রতিটি শব্দের অক্ষরসংখ্যাকে তার
// আনুমানিক উচ্চারণ-সময়ের ওজন (weight) হিসেবে ধরে, audio এর currentTime/duration
// অনুপাত অনুযায়ী কোন শব্দটি এখন "চলছে" তা হিসাব করে হাইলাইট করা হয়। ছোট শব্দ কম
// সময়ে, বড় শব্দ বেশি সময়ে হাইলাইট হবে — ফলে বাস্তব তিলাওয়াতের সাথে মোটামুটি
// স্বাভাবিকভাবেই মিলে যায়, যদিও এটি প্রকৃত timestamp-ভিত্তিক নয়।
let wordHighlightData = null; // { spans, cumFractions }

function clearWordHighlight(){
  if(wordHighlightData){
    wordHighlightData.spans.forEach(s => s.classList.remove('qw-active'));
  }
  wordHighlightData = null;
}

function prepareWordHighlight(item){
  clearWordHighlight();
  const card = document.getElementById(`ayah-${item.key.replace(':','-')}`);
  if(!card) return;
  const arText = card.querySelector('.ar-text');
  if(!arText) return;
  const spans = arText.querySelectorAll('.qw');
  if(!spans.length) return;
  const weights = Array.from(spans).map(s => Math.max(1, s.textContent.trim().length));
  const total = weights.reduce((a,b) => a+b, 0);
  let acc = 0;
  const cumFractions = weights.map(w => { acc += w; return acc/total; });
  wordHighlightData = { spans, cumFractions };
}

function updateWordHighlight(){
  if(!wordHighlightData || !state.isPlaying) return;
  const dur = audioEl.duration;
  if(!isFinite(dur) || dur <= 0) return;
  const frac = audioEl.currentTime / dur;
  const { spans, cumFractions } = wordHighlightData;
  let idx = cumFractions.findIndex(c => frac <= c);
  if(idx === -1) idx = spans.length - 1;
  spans.forEach((s, i) => s.classList.toggle('qw-active', i === idx));
}

function fmtTime(sec){
  if(!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec/60), s = Math.floor(sec%60);
  return toBn(m) + ':' + toBn(String(s).padStart(2,'0'));
}

function currentAudioUrl(item){
  return buildAudioUrl(state.reciter, item.surah, item.globalNumber);
}

// কিছু ক্বারীর (যেমন ইয়াসির আল-দোসারী) অডিও শুধু সম্পূর্ণ সূরা আকারে পাওয়া যায় —
// একটি সূরার সব আয়াতের URL একই mp3 ফাইলে গিয়ে মেলে। এই ক্ষেত্রে পরের/আগের আয়াতে
// গেলে একই ফাইল নতুন করে reload/restart না করে, চলমান তিলাওয়াতটি নির্বিঘ্নে
// চলতে থাকে — শুধু নিচের রেফারেন্স/টাইটেল ও কার্ড-হাইলাইট আপডেট হয়।
function isFullSurahReciter(){
  const r = reciters.find(x => x.id === state.reciter);
  return !!(r && r.audioType === 'surah');
}

// ---------- Smart prefetch: quietly warm the cache for the *next* ayah while
// the current one is playing, so advancing to it (autoplay or manual "next")
// is instant and offline-safe by the time the listener gets there. Runs only
// when online and only if that URL isn't already cached; failures are silent
// since this is a best-effort convenience, not a requirement for playback. ----
async function prefetchNextAudio(idx){
  if(!navigator.onLine || !('caches' in window)) return;
  const nextItem = state.playlist[idx + 1];
  if(!nextItem) return;
  const url = currentAudioUrl(nextItem);
  try{
    const cache = await caches.open(AUDIO_CACHE_NAME);
    const existing = await cache.match(url);
    if(existing) return;
    const res = await fetch(url, { mode: 'no-cors', credentials: 'omit' });
    if(res) await cache.put(url, res.clone());
  }catch(e){ /* best-effort only — a failed prefetch just means no head start */ }
}

function playAtIndex(idx, userInitiated){
  if(idx < 0 || idx >= state.playlist.length) return;
  const item = state.playlist[idx];
  const newUrl = currentAudioUrl(item);
  const prevItem = state.playlist[state.playIndex];
  const sameTrackAlreadyLoaded = isFullSurahReciter() && audioEl.src && audioEl.src === newUrl && prevItem && prevItem.surah === item.surah;
  state.playIndex = idx;
  // অফলাইনে সংরক্ষিত সূরা প্লে হলে তার "সর্বশেষ ব্যবহার" সময় আপডেট — স্মার্ট
  // স্টোরেজ eviction (js/smart-storage.js) এই তথ্যের ওপর ভিত্তি করেই ঠিক করে
  // কোন সূরাগুলো সবচেয়ে কম ব্যবহৃত, তাই জায়গা লাগলে সেগুলোই আগে সরে।
  if(typeof touchOfflineSurah === 'function') touchOfflineSurah(item.surah);
  document.getElementById('playerRef').textContent = `আয়াত ${toBn(item.numberInSurah)}`;
  document.getElementById('playerTitle').textContent = item.title;
  playerBar.classList.add('visible');
  updatePlayRing();
  if(typeof onbMaybeStart === 'function'){
    // The onboarding tour points at controls (reciter, speed, seek bar) that
    // now live inside the expandable panel — open it first so the tour
    // isn't pointing at something invisible. Only the very first time.
    if(typeof onbHasSeen === 'function' && !onbHasSeen('player')) expandPlayer();
    onbMaybeStart('player');
  }
  if(sameTrackAlreadyLoaded){
    // একই সূরার অডিও আগে থেকেই চলছে/লোড হয়ে আছে — নতুন করে শুরু না করে শুধু UI সিঙ্ক করা।
    if(audioEl.paused) audioEl.play().then(()=>{ state.isPlaying = true; syncPlayingUI(); }).catch(()=>{});
    else syncPlayingUI();
  } else {
    playerBar.classList.add('buffering');
    audioEl.src = newUrl;
    audioEl.playbackRate = state.playbackRate;
    audioEl.play().then(()=>{ state.isPlaying = true; syncPlayingUI(); }).catch(()=>{ handlePlaybackFailure(idx); });
  }
  state.lastRead = { surah: item.surah, ayah: item.numberInSurah };
  saveLastRead();
  addHistoryEntry({ surah: item.surah, title: item.title, ayah: item.numberInSurah, reciter: state.reciter, ts: Date.now() });
  trackAudioSurahPlayed(item.surah);
  const libList = document.getElementById('libraryListContainer');
  if(libList && document.getElementById('libTabHistory') && document.getElementById('libTabHistory').classList.contains('active')) renderHistoryList(libList);
  recordActivityToday();
  // Follow-along scroll: an explicit tap always takes the listener there
  // and resumes auto-following (they clearly want to be at that ayah).
  // Auto-advance during continuous playback only scrolls if they haven't
  // manually scrolled away, and skips it entirely when the ayah is already
  // comfortably on screen (see the follow-along engine above).
  const card = document.getElementById(`ayah-${item.key.replace(':','-')}`);
  currentPlayingCard = card;
  if(card){
    if(userInitiated){
      followAlongEnabled = true;
      hideFollowButton();
      scrollToCard(card);
    } else if(followAlongEnabled){
      if(!isCardComfortablyVisible(card)) scrollToCard(card);
    } else {
      showFollowButton();
    }
  }
  updateMediaSessionMetadata(item);
  prepareWordHighlight(item);
  prefetchNextAudio(idx);
}

// Called whenever the current track fails to load/play (404 from the CDN,
// no network, unsupported file, etc). Without this the spinner in the
// player bar would spin forever with no feedback, which looks exactly like
// "it just keeps loading and never plays".
let playbackRetryCount = 0;
function handlePlaybackFailure(idx){
  playerBar.classList.remove('buffering');
  state.isPlaying = false;
  clearWordHighlight();
  syncPlayingUI();
  const autoplayChk = document.getElementById('autoplayChk');
  // If we're auto-advancing through a surah, skip the broken ayah instead of
  // getting stuck, but stop after a couple of consecutive failures so we
  // don't silently loop through an entire offline/broken surah.
  if(autoplayChk && autoplayChk.checked && playbackRetryCount < 2 && idx < state.playlist.length - 1){
    playbackRetryCount++;
    playAtIndex(idx + 1, false);
    return;
  }
  playbackRetryCount = 0;
  document.getElementById('playerRef').textContent = 'এই তিলাওয়াতটি লোড করা যায়নি';
  showPlaybackError();
}

let playbackErrorTimer = null;
function showPlaybackError(){
  const ref = document.getElementById('playerRef');
  if(!ref) return;
  const original = ref.textContent;
  const errorText = navigator.onLine === false
    ? 'ইন্টারনেট সংযোগ নেই — এই আয়াতের অডিও লোড করা যায়নি'
    : 'অডিও লোড করা যায়নি, একটু পরে আবার চেষ্টা করুন বা ক্বারী পরিবর্তন করুন';
  ref.textContent = errorText;
  clearTimeout(playbackErrorTimer);
  // Only revert if we're still showing our own error message — if a new
  // track started in the meantime, playerRef will already show something
  // else and we shouldn't clobber it back to the old stale text.
  playbackErrorTimer = setTimeout(() => {
    if(ref.textContent === errorText) ref.textContent = original;
  }, 4000);
}

function pausePlayback(){
  audioEl.pause();
  state.isPlaying = false;
  syncPlayingUI();
}

function resumePlayback(){
  if(state.playIndex === -1){ if(state.playlist.length){ playAtIndex(0, false); } return; }
  audioEl.play().then(()=>{ state.isPlaying = true; syncPlayingUI(); }).catch(()=>{});
}

function syncPlayingUI(){
  document.querySelectorAll('.ayah-card').forEach(c => c.classList.remove('playing'));
  document.querySelectorAll('.play-toggle').forEach(b => { b.classList.remove('is-playing'); b.innerHTML = '<i class="fa-solid fa-play"></i> শুনুন'; });
  if(state.playIndex >= 0){
    const item = state.playlist[state.playIndex];
    const card = document.querySelector(`.ayah-card[data-key="${item.key}"]`);
    if(card){
      const btn = card.querySelector('.play-toggle');
      if(state.isPlaying){
        card.classList.add('playing');
        if(btn){ btn.classList.add('is-playing'); btn.innerHTML = '<span class="eq-bars"><i></i><i></i><i></i></span> চলছে'; }
      }
    }
  }
  const ppBtn = document.getElementById('playPauseBtn');
  if(ppBtn){
    ppBtn.classList.toggle('is-playing', state.isPlaying);
    ppBtn.setAttribute('aria-label', state.isPlaying ? 'পজ করুন' : 'চালু করুন');
  }
  if('mediaSession' in navigator){
    navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
  }
}

// ---------- Media Session: lock-screen / notification controls so playback
// keeps going and stays controllable when the phone is locked or the app is
// backgrounded. ----------
function updateMediaSessionMetadata(item){
  if(!('mediaSession' in navigator)) return;
  const reciterName = (reciters.find(r => r.id === state.reciter) || {}).name || '';
  navigator.mediaSession.metadata = new MediaMetadata({
    title: `আয়াত ${toBn(item.numberInSurah)} — ${item.title}`,
    artist: reciterName,
    album: 'কুরআন বাংলা',
    artwork: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }
    ]
  });
}

function initMediaSessionHandlers(){
  if(!('mediaSession' in navigator)) return;
  navigator.mediaSession.setActionHandler('play', () => resumePlayback());
  navigator.mediaSession.setActionHandler('pause', () => pausePlayback());
  navigator.mediaSession.setActionHandler('previoustrack', () => {
    if(state.playIndex > 0) playAtIndex(state.playIndex - 1, false);
  });
  navigator.mediaSession.setActionHandler('nexttrack', () => {
    if(state.playIndex < state.playlist.length - 1) playAtIndex(state.playIndex + 1, false);
  });
  try{
    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
      audioEl.currentTime = Math.max(0, audioEl.currentTime - (details.seekOffset || 10));
    });
    navigator.mediaSession.setActionHandler('seekforward', (details) => {
      if(audioEl.duration) audioEl.currentTime = Math.min(audioEl.duration, audioEl.currentTime + (details.seekOffset || 10));
    });
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if(details.seekTime != null && audioEl.duration) audioEl.currentTime = details.seekTime;
    });
    navigator.mediaSession.setActionHandler('stop', () => { pausePlayback(); });
  }catch(e){ /* older browsers may not support every action */ }
}

function updatePositionState(){
  if(!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return;
  if(!audioEl.duration || !isFinite(audioEl.duration)) return;
  try{
    navigator.mediaSession.setPositionState({
      duration: audioEl.duration,
      playbackRate: audioEl.playbackRate,
      position: Math.min(audioEl.currentTime, audioEl.duration)
    });
  }catch(e){}
}

// ---------- Playback speed ----------
function applySpeedLabel(){
  const btn = document.getElementById('speedBtn');
  if(btn) btn.textContent = `${toBn(state.playbackRate)}x`;
}
function cycleSpeed(){
  const idx = SPEED_STEPS.indexOf(state.playbackRate);
  const next = SPEED_STEPS[(idx + 1 + SPEED_STEPS.length) % SPEED_STEPS.length];
  state.playbackRate = next;
  audioEl.playbackRate = next;
  savePlaybackRate();
  applySpeedLabel();
}

// ---------- Offline download of a whole surah/juz's audio ----------
function offlineButtonLabel(done, total){
  if(done == null) return '⬇ অফলাইনে সংরক্ষণ করুন';
  if(done >= total) return '✓ অফলাইনে সংরক্ষিত হয়েছে';
  return `ডাউনলোড হচ্ছে (${toBn(done)}/${toBn(total)})`;
}

async function downloadCurrentAudioForOffline(btn){
  if(!state.playlist.length) return;
  const surahNum = state.playlist[0].surah;
  const isSingleSurah = state.playlist.every(item => item.surah === surahNum);
  const urls = [...new Set(state.playlist.map(item => currentAudioUrl(item)))];
  const reciterAtDownload = state.reciter;
  btn.disabled = true;
  btn.textContent = offlineButtonLabel(0, urls.length);

  // Prefer handing the batch to the service worker so it keeps downloading
  // even if the user navigates to another surah mid-download.
  if('serviceWorker' in navigator && navigator.serviceWorker.controller){
    const requestId = `${surahNum}-${Date.now()}`;
    const onMsg = (event) => {
      const msg = event.data || {};
      if(msg.requestId !== requestId) return;
      if(msg.type === 'CACHE_AUDIO_PROGRESS'){
        btn.textContent = offlineButtonLabel(msg.done, msg.total);
      } else if(msg.type === 'CACHE_AUDIO_DONE'){
        btn.textContent = offlineButtonLabel(msg.total, msg.total);
        btn.classList.add('downloaded');
        if(isSingleSurah) markSurahOffline(surahNum, reciterAtDownload, urls, urls.length);
        navigator.serviceWorker.removeEventListener('message', onMsg);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    navigator.serviceWorker.controller.postMessage({ type: 'CACHE_AUDIO', urls, requestId });
    return;
  }

  // Fallback: cache directly from the page if there's no active service worker.
  if(!('caches' in window)){ btn.textContent = '⬇ এই ব্রাউজারে অফলাইন মোড সমর্থিত নয়'; return; }
  const cache = await caches.open(AUDIO_CACHE_NAME);
  let done = 0;
  for(const url of urls){
    try{
      const existing = await cache.match(url);
      if(!existing){
        const res = await fetch(url, { mode: 'no-cors' });
        if(res) await cache.put(url, res.clone());
      }
    }catch(e){ /* skip and continue */ }
    done++;
    btn.textContent = offlineButtonLabel(done, urls.length);
  }
  btn.textContent = offlineButtonLabel(urls.length, urls.length);
  btn.classList.add('downloaded');
  if(isSingleSurah) markSurahOffline(surahNum, reciterAtDownload, urls, urls.length);
}

let stallTimer = null;
function initPlayer(){
  updateReciterLabels();
  const reciterFieldBtn = document.getElementById('reciterFieldBtn');
  if(reciterFieldBtn) reciterFieldBtn.onclick = openReciterPicker;

  const playPauseBtn = document.getElementById('playPauseBtn');
  playPauseBtn.onclick = () => { state.isPlaying ? pausePlayback() : resumePlayback(); };
  playPauseBtn.addEventListener('pointerdown', () => {
    playPauseBtn.classList.remove('rippling');
    void playPauseBtn.offsetWidth; // restart the animation even on rapid taps
    playPauseBtn.classList.add('rippling');
  });
  document.getElementById('prevBtn').onclick = () => { if(state.playIndex > 0) playAtIndex(state.playIndex - 1, true); };
  document.getElementById('nextBtn').onclick = () => { if(state.playIndex < state.playlist.length - 1) playAtIndex(state.playIndex + 1, true); };

  const expandBtn = document.getElementById('playerExpandBtn');
  if(expandBtn) expandBtn.onclick = togglePlayerExpand;
  const infoTap = document.getElementById('playerInfoTap');
  if(infoTap) infoTap.onclick = togglePlayerExpand;

  const repeatBtn = document.getElementById('repeatBtn');
  if(repeatBtn) repeatBtn.onclick = cycleRepeatMode;
  updateRepeatUI();

  const sleepBtn = document.getElementById('sleepTimerBtn');
  const sleepPopover = document.getElementById('sleepTimerPopover');
  if(sleepBtn && sleepPopover){
    sleepBtn.onclick = (e) => { e.stopPropagation(); toggleSleepTimerPopover(); };
    sleepPopover.querySelectorAll('button').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        setSleepTimer(parseInt(b.dataset.min, 10));
        hideSleepTimerPopover();
      };
    });
    document.addEventListener('click', (e) => {
      if(!sleepPopover.hidden && !sleepPopover.contains(e.target) && e.target !== sleepBtn) hideSleepTimerPopover();
    });
  }

  document.getElementById('playerClose').onclick = () => {
    audioEl.pause(); audioEl.removeAttribute('src');
    state.isPlaying=false; state.playIndex=-1;
    playerBar.classList.remove('visible');
    collapsePlayer();
    clearWordHighlight();
    clearSleepTimer();
    followAlongEnabled = true;
    currentPlayingCard = null;
    hideFollowButton();
    updatePlayRing();
    syncPlayingUI();
  };
  const speedBtn = document.getElementById('speedBtn');
  if(speedBtn){ speedBtn.onclick = cycleSpeed; applySpeedLabel(); }

  audioEl.addEventListener('ended', () => {
    // "এই আয়াত বারবার" (repeat-this-ayah/track) takes priority over
    // everything else — just replay whatever is currently loaded, whether
    // that's a single ayah's file or (for full-surah reciters) the whole
    // surah's file.
    if(state.repeatMode === 'ayah'){
      audioEl.currentTime = 0;
      audioEl.play().catch(()=>{});
      return;
    }

    const autoplayChk = document.getElementById('autoplayChk');
    const shouldAdvance = state.repeatMode === 'surah' || (autoplayChk && autoplayChk.checked);

    if(shouldAdvance && state.playlist.length){
      if(isFullSurahReciter()){
        // পুরো সূরার একটাই mp3 ফাইল শেষ হয়েছে — প্লেলিস্টে পরের ভিন্ন সূরা
        // থাকলে তার প্রথম আয়াতে যায়; "এই সূরা বারবার" চালু থাকলে না পেলে
        // শুরু থেকে আবার চালায়; নাহলে থেমে যায়।
        const curSurah = state.playlist[state.playIndex].surah;
        const nextIdx = state.playlist.findIndex((it, i) => i > state.playIndex && it.surah !== curSurah);
        if(nextIdx !== -1){ playAtIndex(nextIdx, false); return; }
        if(state.repeatMode === 'surah'){ playAtIndex(0, false); return; }
      } else if(state.playIndex < state.playlist.length - 1){
        playAtIndex(state.playIndex + 1, false);
        return;
      } else if(state.repeatMode === 'surah'){
        // শেষ আয়াত পর্যন্ত পৌঁছে গেছে — "এই সূরা বারবার" চালু থাকায় শুরু থেকে
        // আবার চালানো হচ্ছে।
        playAtIndex(0, false);
        return;
      }
    }
    state.isPlaying = false;
    clearWordHighlight();
    syncPlayingUI();
  });
  audioEl.addEventListener('timeupdate', () => {
    document.getElementById('curTime').textContent = fmtTime(audioEl.currentTime);
    if(audioEl.duration){
      document.getElementById('seekBar').value = (audioEl.currentTime / audioEl.duration) * 100;
      document.getElementById('durTime').textContent = fmtTime(audioEl.duration);
    }
    updatePositionState();
    updateWordHighlight();
    updatePlayRing();
  });
  audioEl.addEventListener('pause', () => { if(state.isPlaying){ state.isPlaying=false; syncPlayingUI(); } });
  audioEl.addEventListener('play', () => { if(!state.isPlaying){ state.isPlaying=true; syncPlayingUI(); } });
  audioEl.addEventListener('waiting', () => {
    playerBar.classList.add('buffering');
    // Safety net: if we're still "buffering" 15s later (dead link, CDN
    // outage, stalled connection) treat it as a failure instead of leaving
    // the spinner running indefinitely.
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      if(playerBar.classList.contains('buffering')) handlePlaybackFailure(state.playIndex);
    }, 15000);
  });
  audioEl.addEventListener('playing', () => { playerBar.classList.remove('buffering'); clearTimeout(stallTimer); playbackRetryCount = 0; });
  audioEl.addEventListener('canplay', () => { playerBar.classList.remove('buffering'); clearTimeout(stallTimer); });
  audioEl.addEventListener('error', () => { clearTimeout(stallTimer); handlePlaybackFailure(state.playIndex); });
  audioEl.addEventListener('loadedmetadata', () => updatePositionState());

  document.getElementById('seekBar').addEventListener('input', (e) => {
    if(audioEl.duration) audioEl.currentTime = (e.target.value/100) * audioEl.duration;
  });

  initMediaSessionHandlers();
}
