// ---------- Audio stats: real listening time per reciter ----------
// state.audioSurahsPlayed (js/storage.js) already tracks *which* surahs were
// ever opened for audio, for the "Audio Explorer" badge. This file adds a
// second, complementary signal: actual elapsed *listening time*, attributed
// to whichever reciter was selected while it played — powering the
// "অডিও-সংক্রান্ত" card on the stats page (total time + top reciter).

let audioStatsLastTick = 0;   // audioEl.currentTime at the previous tick
let audioStatsBuffer = 0;     // unsaved seconds accumulated since last IDBKV write

// Small ticks (a couple hundred ms apart from the browser's own 'timeupdate'
// cadence) are summed as real listening time. Anything >= 2s is treated as a
// seek/skip/track-change and ignored, so scrubbing the seek bar or jumping
// between ayahs never gets miscounted as listening time.
function initAudioListenTracking(){
  if(typeof audioEl === 'undefined' || !audioEl) return;

  const resetTick = () => { audioStatsLastTick = audioEl.currentTime || 0; };
  audioEl.addEventListener('play', resetTick);
  audioEl.addEventListener('seeking', resetTick);

  audioEl.addEventListener('timeupdate', () => {
    if(!state.isPlaying) return;
    const now = audioEl.currentTime || 0;
    const delta = now - audioStatsLastTick;
    audioStatsLastTick = now;
    if(delta <= 0 || delta >= 2) return;

    const reciter = state.reciter || 'ar.alafasy';
    state.audioListenSeconds[reciter] = (state.audioListenSeconds[reciter] || 0) + delta;
    audioStatsBuffer += delta;
    if(audioStatsBuffer >= 8){ saveAudioListenSeconds(); audioStatsBuffer = 0; }
  });

  // Persist promptly on pause/end/backgrounding, not just every 8s of buffer,
  // so a short listen (e.g. one ayah then close the tab) isn't lost.
  const flush = () => { if(audioStatsBuffer > 0){ saveAudioListenSeconds(); audioStatsBuffer = 0; } };
  audioEl.addEventListener('pause', flush);
  audioEl.addEventListener('ended', flush);
  document.addEventListener('visibilitychange', () => { if(document.hidden) flush(); });
  window.addEventListener('pagehide', flush);
}

function reciterMeta(id){
  return (typeof reciters !== 'undefined' ? reciters : []).find(r => r.id === id) || null;
}

// ---------- UI: "অডিও-সংক্রান্ত" card ----------
function renderAudioStatsSection(){
  const totalSec = audioListenSecondsTotal();
  const ranked = topReciterByListenTime(); // sorted array or null

  if(!totalSec || !ranked){
    return `
      <div class="section-title-sm">Audio-related</div>
      <div class="stats-card audio-stats-empty">
        <i class="fa-solid fa-headphones-simple"></i>
        <div class="audio-empty-text">No recitation has been heard yet.</div>
      </div>`;
  }

  const top = ranked[0];
  const topMeta = reciterMeta(top.id);
  const topName = topMeta ? topMeta.bn : top.id;
  const topFlag = topMeta ? topMeta.flag : '🎙️';

  const rows = ranked.slice(0, 4).map(r => {
    const meta = reciterMeta(r.id);
    const name = meta ? meta.bn : r.id;
    const flag = meta ? meta.flag : '🎙️';
    const pct = Math.max(4, Math.round((r.seconds / totalSec) * 100));
    return `
      <div class="reciter-rank-row">
        <div class="reciter-rank-flag">${flag}</div>
        <div class="reciter-rank-mid">
          <div class="reciter-rank-name">${escapeHtml(name)}</div>
          <div class="reciter-rank-bar-track"><div class="reciter-rank-bar-fill" style="width:${pct}%"></div></div>
        </div>
        <div class="reciter-rank-time">${formatDurationBn(r.seconds)}</div>
      </div>`;
  }).join('');

  return `
    <div class="section-title-sm">Audio-related</div>
    <div class="stats-card audio-hero-card">
      <div class="audio-hero-ic"><i class="fa-solid fa-headphones-simple"></i></div>
      <div class="audio-hero-mid">
        <div class="stats-label">Total listening time</div>
        <div class="stats-big">${formatDurationBn(totalSec)}</div>
      </div>
    </div>
    <div class="stats-card audio-top-card">
      <div class="audio-top-flag">${topFlag}</div>
      <div class="audio-top-mid">
        <div class="stats-label">Most listened to reciter</div>
        <div class="audio-top-name">${escapeHtml(topName)}</div>
      </div>
      <div class="audio-top-pct">${toBn(Math.round((top.seconds/totalSec)*100))}%</div>
    </div>
    <div class="stats-card">
      <div class="stats-label" style="margin-bottom:12px;">Listening time according to the reciter</div>
      ${rows}
    </div>`;
}

function initAudioStats(){
  initAudioListenTracking();
}
