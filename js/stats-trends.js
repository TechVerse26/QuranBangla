// ---------- Trend stats: week-vs-week, monthly summary, personal records ----------
// Reuses the existing per-day `activity` map (seconds read/listened per date,
// see loadActivity() in js/stats.js) for time-based trends, and adds one new
// lightweight per-day map — ayah counts — so ayah-based trends are possible
// too, without touching the existing ayahsRead dedup map used for badges.

const AYAH_DAILY_LS_KEY = 'qr_ayah_daily';
const BN_MONTHS = ['January','February','March','April','May','Jun','July','August','September','October','November','December'];

function loadAyahDaily(){
  try{
    const raw = IDBKV.get(AYAH_DAILY_LS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return (parsed && typeof parsed === 'object') ? parsed : {};
  }catch(e){ return {}; }
}
function saveAyahDaily(d){
  try{ IDBKV.set(AYAH_DAILY_LS_KEY, JSON.stringify(d)); }catch(e){}
}
// Called from markAyahRead() in js/storage.js every time a *new* ayah is
// dedup-marked as read, so this stays in sync with the real "আয়াত পাঠ" count.
function recordAyahReadToday(){
  const d = loadAyahDaily();
  const key = todayStr();
  d[key] = (d[key] || 0) + 1;
  saveAyahDaily(d);
}

function formatDateBn(key){
  if(!key) return '';
  const parts = key.split('-').map(Number);
  const m = parts[1], d = parts[2];
  if(!m || !d) return key;
  return `${toBn(d)} ${BN_MONTHS[m-1]}`;
}

// Total minutes for the 7-day week (Sun..Sat) that is `weeksAgo` weeks before
// the current week. weeksAgo=0 is this week (partial, up to today).
function weekMinutesTotal(activity, weeksAgo){
  const now = new Date();
  const dow = now.getDay();
  const thisWeekStart = new Date(now); thisWeekStart.setDate(now.getDate() - dow);
  const start = new Date(thisWeekStart); start.setDate(thisWeekStart.getDate() - weeksAgo*7);
  let total = 0;
  for(let i=0;i<7;i++){
    const d = new Date(start); d.setDate(start.getDate()+i);
    if(d > now) break;
    const key = d.toISOString().slice(0,10);
    total += Math.floor((activity[key]||0)/60);
  }
  return total;
}

function monthlySummary(activity, ayahDaily){
  const monthPrefix = todayStr().slice(0,7);
  const monthActivityKeys = Object.keys(activity).filter(k => k.slice(0,7) === monthPrefix);
  const minutes = monthActivityKeys.reduce((s,k) => s + Math.floor((activity[k]||0)/60), 0);
  const activeDays = monthActivityKeys.filter(k => (activity[k]||0) > 0).length;
  const ayahKeys = Object.keys(ayahDaily).filter(k => k.slice(0,7) === monthPrefix);
  const ayahCount = ayahKeys.reduce((s,k) => s + (ayahDaily[k]||0), 0);
  return { minutes, activeDays, ayahCount, monthName: BN_MONTHS[new Date().getMonth()] };
}

function personalRecords(activity, ayahDaily){
  let bestMin = 0, bestMinDate = null;
  Object.entries(activity).forEach(([k,v]) => {
    const m = Math.floor((v||0)/60);
    if(m > bestMin){ bestMin = m; bestMinDate = k; }
  });
  let bestAyah = 0, bestAyahDate = null;
  Object.entries(ayahDaily).forEach(([k,v]) => {
    if((v||0) > bestAyah){ bestAyah = v; bestAyahDate = k; }
  });
  return { bestMin, bestMinDate, bestAyah, bestAyahDate };
}

// ---------- UI ----------
function renderTrendCompareCard(activity){
  const thisWeek = weekMinutesTotal(activity, 0);
  const lastWeek = weekMinutesTotal(activity, 1);
  const delta = thisWeek - lastWeek;
  const pct = lastWeek > 0 ? Math.round((delta/lastWeek)*100) : (thisWeek > 0 ? 100 : 0);
  const up = delta >= 0;
  const icon = up ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down';
  const tone = up ? 'trend-up' : 'trend-down';
  let msg;
  if(lastWeek === 0 && thisWeek === 0) msg = 'এখনই শুরু করুন আপনার পথচলা —';
  else if(up) msg = `গত সপ্তাহের চেয়ে ${toBn(Math.abs(pct))}% বেশি পড়েছেন, চালিয়ে যান!`;
  else msg = `গত সপ্তাহের চেয়ে ${toBn(Math.abs(pct))}% কম — আজ কিছুক্ষণ পড়ে পুষিয়ে নিন।`;

  return `
    <div class="stats-card trend-compare-card">
      <div class="trend-compare-row">
        <div class="trend-compare-col">
          <div class="stats-label">Last week</div>
          <div class="stats-big-sm">${toBn(lastWeek)} min</div>
        </div>
        <div class="trend-compare-arrow ${tone}"><i class="fa-solid ${icon}"></i></div>
        <div class="trend-compare-col" style="text-align:right;">
          <div class="stats-label">This week</div>
          <div class="stats-big-sm">${toBn(thisWeek)} min</div>
        </div>
      </div>
      <div class="trend-compare-msg ${tone}">${msg}</div>
    </div>`;
}

function renderTrendMiniChart(activity){
  const weeks = [3,2,1,0].map(w => weekMinutesTotal(activity, w));
  const max = Math.max(1, ...weeks);
  const labels = ['3 weeks ago','2 weeks ago','Last week','This week'];
  return `
    <div class="stats-card">
      <div class="stats-label" style="margin-bottom:10px;">Trends in the last 4 weeks</div>
      <div class="trend-mini-chart">
        ${weeks.map((m,i) => `
          <div class="trend-mini-col">
            <div class="trend-mini-track"><div class="trend-mini-fill" style="height:${Math.round((m/max)*60)}px"></div></div>
            <div class="trend-mini-val">${toBn(m)}m</div>
          </div>`).join('')}
      </div>
      <div class="trend-mini-labels">${labels.map(l => `<span>${l}</span>`).join('')}</div>
    </div>`;
}

function renderMonthlySummaryCard(activity, ayahDaily){
  const s = monthlySummary(activity, ayahDaily);
  return `
    <div class="section-title-sm">Monthly summary — ${s.monthName}</div>
    <div class="lifetime-grid">
      <div class="lifetime-box">
        <i class="fa-solid fa-bolt"></i>
        <div class="lifetime-val">${toBn(s.ayahCount)}</div>
        <div class="lifetime-label">আয়াত পাঠ</div>
      </div>
      <div class="lifetime-box">
        <i class="fa-regular fa-clock"></i>
        <div class="lifetime-val">${toBn(s.minutes)}m</div>
        <div class="lifetime-label">মোট সময়</div>
      </div>
      <div class="lifetime-box">
        <i class="fa-solid fa-calendar-check"></i>
        <div class="lifetime-val">${toBn(s.activeDays)}</div>
        <div class="lifetime-label">সক্রিয় দিন</div>
      </div>
    </div>`;
}

function renderPersonalRecordsCard(activity, ayahDaily){
  const r = personalRecords(activity, ayahDaily);
  if(!r.bestMin && !r.bestAyah) return '';
  return `
    <div class="stats-card records-card">
      <div class="stats-label" style="margin-bottom:10px;"><i class="fa-solid fa-trophy" style="color:var(--gold);margin-right:6px;"></i>ব্যক্তিগত রেকর্ড</div>
      <div class="records-row">
        <div class="records-col">
          <div class="stats-big-sm">${toBn(r.bestMin)}m</div>
          <div class="stats-label">সেরা দিন (সময়)${r.bestMinDate ? ' · ' + formatDateBn(r.bestMinDate) : ''}</div>
        </div>
        <div class="records-col" style="text-align:right;">
          <div class="stats-big-sm">${toBn(r.bestAyah)}</div>
          <div class="stats-label">সেরা দিন (আয়াত)${r.bestAyahDate ? ' · ' + formatDateBn(r.bestAyahDate) : ''}</div>
        </div>
      </div>
    </div>`;
}

function renderTrendsSection(){
  const activity = loadActivity();
  const ayahDaily = loadAyahDaily();
  return `
    <div class="section-title-sm">Comparative</div>
    ${renderTrendCompareCard(activity)}
    ${renderTrendMiniChart(activity)}
    ${renderMonthlySummaryCard(activity, ayahDaily)}
    ${renderPersonalRecordsCard(activity, ayahDaily)}`;
}
