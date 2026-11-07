// ---------- Shareable "মাসিক রিপোর্ট কার্ড" ----------
// Draws a story-style (1080x1620) PNG on a <canvas>, entirely client-side —
// no server, no external image library. Colors are pulled live from the
// active theme's CSS variables, so the card always matches whatever theme
// (emerald / dark / violet / etc, see js/app.js THEMES) the user has chosen.

const SHARE_CARD_W = 1080, SHARE_CARD_H = 1620;

function cssVar(name){
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function roundRectPath(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y, x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x, y+h, r);
  ctx.arcTo(x, y+h, x, y, r);
  ctx.arcTo(x, y, x+w, y, r);
  ctx.closePath();
}

function collectShareCardStats(){
  const activity = loadActivity();
  const ayahDaily = (typeof loadAyahDaily === 'function') ? loadAyahDaily() : {};
  const month = (typeof monthlySummary === 'function') ? monthlySummary(activity, ayahDaily) : { minutes:0, ayahCount:0, monthName: BN_MONTHS ? BN_MONTHS[new Date().getMonth()] : '' };
  const streak = computeStreak(activity);
  const best = Math.max(state.bestStreak || 0, streak);
  const ranked = (typeof topReciterByListenTime === 'function') ? topReciterByListenTime() : null;
  const topReciter = ranked ? reciterMeta(ranked[0].id) : null;
  const badgeUnlocked = typeof unlockedBadgesCount === 'function' ? unlockedBadgesCount() : 0;
  const badgeTotal = typeof BADGES !== 'undefined' ? BADGES.length : 0;
  return {
    monthName: month.monthName,
    ayahCount: month.ayahCount,
    minutes: month.minutes,
    streak, best,
    topReciterName: topReciter ? topReciter.bn : null,
    topReciterFlag: topReciter ? topReciter.flag : '',
    badgeUnlocked, badgeTotal
  };
}

async function drawReportCard(canvas){
  canvas.width = SHARE_CARD_W;
  canvas.height = SHARE_CARD_H;
  const ctx = canvas.getContext('2d');

  const teal = cssVar('--teal') || '#0E3B36';
  const tealDeep = cssVar('--teal-deep') || '#092723';
  const gold = cssVar('--gold') || '#C0973A';
  const goldSoft = cssVar('--gold-soft') || '#E8D6A8';
  const parchment = cssVar('--parchment') || '#FBF6EC';

  // Background gradient
  const bg = ctx.createLinearGradient(0, 0, 0, SHARE_CARD_H);
  bg.addColorStop(0, tealDeep);
  bg.addColorStop(1, teal);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SHARE_CARD_W, SHARE_CARD_H);

  // Subtle decorative corner glow
  const glow = ctx.createRadialGradient(SHARE_CARD_W*0.85, 120, 20, SHARE_CARD_W*0.85, 120, 520);
  glow.addColorStop(0, 'rgba(192,151,58,0.25)');
  glow.addColorStop(1, 'rgba(192,151,58,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, SHARE_CARD_W, SHARE_CARD_H);

  // Outer gold frame
  ctx.strokeStyle = goldSoft;
  ctx.lineWidth = 3;
  roundRectPath(ctx, 40, 40, SHARE_CARD_W-80, SHARE_CARD_H-80, 32);
  ctx.stroke();

  // Ensure fonts are actually loaded before measuring/drawing text
  try{
    await Promise.all([
      document.fonts.load('700 64px "Noto Serif Bengali"'),
      document.fonts.load('700 40px "Noto Serif Bengali"'),
      document.fonts.load('600 30px "Hind Siliguri"'),
      document.fonts.load('400 26px "Hind Siliguri"')
    ]);
  }catch(e){}

  const cx = SHARE_CARD_W/2;
  ctx.textAlign = 'center';

  // Header
  ctx.fillStyle = gold;
  ctx.font = '600 30px "Hind Siliguri"';
  ctx.fillText('Al Quran', cx, 150);

  const stats = collectShareCardStats();

  ctx.fillStyle = parchment;
  ctx.font = '700 52px "Noto Serif Bengali"';
  ctx.fillText(`Report ${stats.monthName}`, cx, 225);

  ctx.strokeStyle = goldSoft;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx-90, 258); ctx.lineTo(cx+90, 258);
  ctx.stroke();

  // Stat grid (2 columns x 3 rows)
  const cards = [
    { icon:'📖', val: toBn(stats.ayahCount), label:'আয়াত পাঠ' },
    { icon:'⏱️', val: toBn(stats.minutes) + ' মিনিট', label:'সময় ব্যয়' },
    { icon:'🔥', val: toBn(stats.streak) + ' দিন', label:'বর্তমান স্ট্রিক' },
    { icon:'🏅', val: toBn(stats.best) + ' দিন', label:'সেরা স্ট্রিক' },
    { icon:'🎧', val: stats.topReciterName || '—', label:'বেশি শোনা ক্বারী', small:true },
    { icon:'🏆', val: `${toBn(stats.badgeUnlocked)}/${toBn(stats.badgeTotal)}`, label:'ব্যাজ অর্জিত' }
  ];

  const gridTop = 330, colW = (SHARE_CARD_W-160)/2, rowH = 235, pad = 80;
  cards.forEach((c, i) => {
    const col = i % 2, row = Math.floor(i/2);
    const x = pad + col*colW;
    const y = gridTop + row*rowH;
    const boxW = colW - 30, boxH = rowH - 30;

    ctx.fillStyle = 'rgba(251,246,236,0.06)';
    roundRectPath(ctx, x, y, boxW, boxH, 22);
    ctx.fill();
    ctx.strokeStyle = 'rgba(232,214,168,0.35)';
    ctx.lineWidth = 1.5;
    roundRectPath(ctx, x, y, boxW, boxH, 22);
    ctx.stroke();

    const midX = x + boxW/2;
    ctx.font = '46px sans-serif';
    ctx.fillText(c.icon, midX, y+70);
    ctx.fillStyle = parchment;
    ctx.font = c.small ? '700 30px "Noto Serif Bengali"' : '700 40px "Noto Serif Bengali"';
    ctx.fillText(c.val, midX, y + (c.small ? 128 : 130));
    ctx.fillStyle = goldSoft;
    ctx.font = '400 24px "Hind Siliguri"';
    ctx.fillText(c.label, midX, y+172);
  });

  // Footer
  ctx.fillStyle = goldSoft;
  ctx.font = '400 26px "Hind Siliguri"';
  ctx.fillText('producer - rupsha jonokollan foundation', cx, SHARE_CARD_H-95);
  ctx.font = '400 22px "Hind Siliguri"';
  ctx.fillStyle = 'rgba(251,246,236,0.55)';
  ctx.fillText('Al Quran • all rights reserved. ', cx, SHARE_CARD_H-58);
}

async function shareOrDownloadCanvas(canvas){
  const filename = `quran-report-${todayStr()}.png`;
  canvas.toBlob(async (blob) => {
    if(!blob) return;
    const file = new File([blob], filename, { type: 'image/png' });
    if(navigator.canShare && navigator.canShare({ files: [file] })){
      try{
        await navigator.share({ files: [file], title: 'Quran recitation report' });
        return;
      }catch(e){ /* user cancelled or share failed — fall through to download */ }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('Image downloaded.');
  }, 'image/png');
}

function openShareCardModal(){
  const old = document.getElementById('shareCardModal');
  if(old) old.remove();
  const wrap = document.createElement('div');
  wrap.className = 'app-modal';
  wrap.id = 'shareCardModal';
  wrap.style.display = 'flex';
  wrap.innerHTML = `
    <div class="app-modal-box share-card-box">
      <div class="app-modal-head">
        <h3><i class="fa-solid fa-share-nodes"></i> Monthly report card</h3>
        <button class="app-modal-close" id="shareCardClose">✕</button>
      </div>
      <div class="app-modal-body share-card-body">
        <div class="share-card-canvas-wrap"><canvas id="shareCardCanvas"></canvas></div>
        <div class="share-card-actions">
          <button class="auth-cta-btn" id="shareCardShareBtn"><i class="fa-solid fa-share-nodes"></i> Share</button>
          <button class="settings-btn share-card-download-btn" id="shareCardDownloadBtn"><i class="fa-solid fa-download"></i> Download</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const remove = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if(e.target === wrap) remove(); });
  document.getElementById('shareCardClose').onclick = remove;

  const canvas = document.getElementById('shareCardCanvas');
  drawReportCard(canvas).then(() => {
    document.getElementById('shareCardShareBtn').onclick = () => shareOrDownloadCanvas(canvas);
    document.getElementById('shareCardDownloadBtn').onclick = () => shareOrDownloadCanvas(canvas);
  });
}

const STREAK_BADGE_W = 1080, STREAK_BADGE_H = 1350;

// ---------- শেয়ারযোগ্য "স্ট্রিক ব্যাজ" কার্ড ----------
// মাসিক রিপোর্ট কার্ডের চেয়ে ছোট, একটিমাত্র স্ট্রিক-মাইলফলক উদযাপনের জন্য —
// প্রথমবার কোনো মাইলফলকে পৌঁছালে celebrateStreakMilestone() স্বয়ংক্রিয়ভাবে
// দেখায়, আর স্ট্যাটস পেজ থেকে যেকোনো সময় সেরা স্ট্রিক শেয়ার করা যায়।
async function drawStreakBadgeCard(canvas, days){
  canvas.width = STREAK_BADGE_W;
  canvas.height = STREAK_BADGE_H;
  const ctx = canvas.getContext('2d');

  const teal = cssVar('--teal') || '#0E3B36';
  const tealDeep = cssVar('--teal-deep') || '#092723';
  const gold = cssVar('--gold') || '#C0973A';
  const goldSoft = cssVar('--gold-soft') || '#E8D6A8';
  const parchment = cssVar('--parchment') || '#FBF6EC';

  const bg = ctx.createLinearGradient(0, 0, 0, STREAK_BADGE_H);
  bg.addColorStop(0, tealDeep);
  bg.addColorStop(1, teal);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, STREAK_BADGE_W, STREAK_BADGE_H);

  const glow = ctx.createRadialGradient(STREAK_BADGE_W/2, STREAK_BADGE_H*0.38, 20, STREAK_BADGE_W/2, STREAK_BADGE_H*0.38, 480);
  glow.addColorStop(0, 'rgba(192,151,58,0.30)');
  glow.addColorStop(1, 'rgba(192,151,58,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, STREAK_BADGE_W, STREAK_BADGE_H);

  ctx.strokeStyle = goldSoft;
  ctx.lineWidth = 3;
  roundRectPath(ctx, 40, 40, STREAK_BADGE_W-80, STREAK_BADGE_H-80, 32);
  ctx.stroke();

  try{
    await Promise.all([
      document.fonts.load('600 32px "Hind Siliguri"'),
      document.fonts.load('700 260px "Hind Siliguri"'),
      document.fonts.load('700 46px "Noto Serif Bengali"'),
      document.fonts.load('400 24px "Hind Siliguri"')
    ]);
  }catch(e){}

  const cx = STREAK_BADGE_W/2;
  ctx.textAlign = 'center';

  ctx.fillStyle = gold;
  ctx.font = '600 32px "Hind Siliguri"';
  ctx.fillText('Al Quran', cx, 150);

  ctx.font = '150px sans-serif';
  ctx.fillText('🔥', cx, 420);

  ctx.fillStyle = parchment;
  ctx.font = '700 220px "Hind Siliguri"';
  ctx.fillText(toBn(days), cx, 660);

  ctx.fillStyle = goldSoft;
  ctx.font = '600 34px "Hind Siliguri"';
  ctx.fillText('দিনের স্ট্রিক', cx, 720);

  const idx = (typeof STREAK_MILESTONES !== 'undefined') ? STREAK_MILESTONES.indexOf(days) : -1;
  const tierLabel = (idx !== -1 && typeof STREAK_TIER_LABELS !== 'undefined' && STREAK_TIER_LABELS[idx]) ? STREAK_TIER_LABELS[idx] : 'ধারাবাহিক পাঠ';

  ctx.strokeStyle = goldSoft;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx-110, 790); ctx.lineTo(cx+110, 790);
  ctx.stroke();

  ctx.fillStyle = parchment;
  ctx.font = '700 48px "Noto Serif Bengali"';
  ctx.fillText(tierLabel, cx, 870);

  ctx.fillStyle = 'rgba(251,246,236,0.85)';
  ctx.font = '400 26px "Hind Siliguri"';
  ctx.fillText('প্রতিদিন কুরআন পড়ার অভ্যাস অব্যাহত আছে', cx, 930);

  ctx.fillStyle = goldSoft;
  ctx.font = '400 26px "Hind Siliguri"';
  ctx.fillText('producer - rupsha jonokollan foundation', cx, STREAK_BADGE_H-95);
  ctx.font = '400 22px "Hind Siliguri"';
  ctx.fillStyle = 'rgba(251,246,236,0.55)';
  ctx.fillText('Al Quran • all rights reserved. ', cx, STREAK_BADGE_H-58);
}

function openStreakShareCardModal(days){
  const old = document.getElementById('streakShareCardModal');
  if(old) old.remove();
  const wrap = document.createElement('div');
  wrap.className = 'app-modal';
  wrap.id = 'streakShareCardModal';
  wrap.style.display = 'flex';
  wrap.innerHTML = `
    <div class="app-modal-box share-card-box">
      <div class="app-modal-head">
        <h3><i class="fa-solid fa-fire"></i> Streak badge</h3>
        <button class="app-modal-close" id="streakShareCardClose">✕</button>
      </div>
      <div class="app-modal-body share-card-body">
        <div class="share-card-canvas-wrap"><canvas id="streakShareCardCanvas"></canvas></div>
        <div class="share-card-actions">
          <button class="auth-cta-btn" id="streakShareCardShareBtn"><i class="fa-solid fa-share-nodes"></i> Share</button>
          <button class="settings-btn share-card-download-btn" id="streakShareCardDownloadBtn"><i class="fa-solid fa-download"></i> Download</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const remove = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if(e.target === wrap) remove(); });
  document.getElementById('streakShareCardClose').onclick = remove;

  const canvas = document.getElementById('streakShareCardCanvas');
  drawStreakBadgeCard(canvas, days).then(() => {
    const share = () => { if(typeof incrementShareCount === 'function') incrementShareCount(); shareOrDownloadCanvas(canvas); };
    document.getElementById('streakShareCardShareBtn').onclick = share;
    document.getElementById('streakShareCardDownloadBtn').onclick = share;
  });
}

// ---------- প্রথমবার একটি স্ট্রিক-মাইলফলকে পৌঁছালে সেলিব্রেশন মোডাল ----------
// js/storage.js updateBestStreak() এখান থেকে কল করে, প্রতি মাইলফলকে মাত্র একবার।
function celebrateStreakMilestone(days){
  const old = document.getElementById('streakCelebrateModal');
  if(old) old.remove();
  const idx = (typeof STREAK_MILESTONES !== 'undefined') ? STREAK_MILESTONES.indexOf(days) : -1;
  const tierLabel = (idx !== -1 && typeof STREAK_TIER_LABELS !== 'undefined' && STREAK_TIER_LABELS[idx]) ? STREAK_TIER_LABELS[idx] : 'নতুন মাইলফলক';
  const wrap = document.createElement('div');
  wrap.className = 'app-modal';
  wrap.id = 'streakCelebrateModal';
  wrap.style.display = 'flex';
  wrap.innerHTML = `
    <div class="app-modal-box streak-celebrate-box">
      <div class="streak-celebrate-flame">🔥</div>
      <div class="streak-celebrate-num">${toBn(days)} দিন</div>
      <div class="streak-celebrate-tier">${tierLabel} অর্জিত হয়েছে!</div>
      <div class="streak-celebrate-sub">মাশাআল্লাহ! ধারাবাহিকতা বজায় রাখার জন্য অভিনন্দন। এই মুহূর্তটি বন্ধুদের সাথে শেয়ার করুন।</div>
      <div class="share-card-actions">
        <button class="auth-cta-btn" id="streakCelebrateShareBtn"><i class="fa-solid fa-share-nodes"></i> শেয়ার করুন</button>
        <button class="settings-btn" id="streakCelebrateCloseBtn">পরে করবো</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const remove = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if(e.target === wrap) remove(); });
  document.getElementById('streakCelebrateCloseBtn').onclick = remove;
  document.getElementById('streakCelebrateShareBtn').onclick = () => { remove(); openStreakShareCardModal(days); };
}

// ---------- UI: "সামাজিক / অনুপ্রেরণামূলক" card on the stats page ----------
function renderSocialShareSection(){
  return `
    <div class="section-title-sm">Share</div>
    <div class="stats-card share-cta-card">
      <div class="share-cta-ic"><i class="fa-solid fa-award"></i></div>
      <div class="share-cta-mid">
        <div class="share-cta-title">আপনার মাসিক অগ্রগতি শেয়ার করুন</div>
        <div class="share-cta-sub">আপনার প্রগ্রেস বন্ধুদের মধ্যে শেয়ার করুন — আপনার একটি শেয়ার হতে পারে একটি মানুষের জীবন বদলে দেওয়া কারণ।</div>
      </div>
      <button class="share-cta-btn" id="statsOpenShareCard"><i class="fa-solid fa-chevron-left"></i></button>
    </div>
    <div class="stats-card share-cta-card">
      <div class="share-cta-ic streak-cta-ic"><i class="fa-solid fa-fire"></i></div>
      <div class="share-cta-mid">
        <div class="share-cta-title">স্ট্রিক ব্যাজ শেয়ার করুন</div>
        <div class="share-cta-sub">আপনার সেরা ${toBn(Math.max(state.bestStreak||0, 0))} দিনের স্ট্রিক একটি সুন্দর কার্ড হিসেবে শেয়ার করুন।</div>
      </div>
      <button class="share-cta-btn" id="statsOpenStreakShareCard"><i class="fa-solid fa-chevron-left"></i></button>
    </div>`;
}
