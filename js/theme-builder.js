// ---------- Custom Theme Builder (js/theme-builder.js) ----------
// Lets the user hand-pick their own theme colors instead of choosing from
// the 7 built-in THEMES (js/data.js). Gated behind a 30-day reading streak
// so it functions like an unlockable reward rather than a plain setting.
//
// UNLOCK RULE: uses the user's BEST-EVER streak (state.bestStreak, the same
// number the streak badges in js/stats.js are keyed off), not just today's
// live streak. That means once someone has genuinely read 30 days in a row
// even once, the builder stays unlocked for good — exactly like every other
// milestone badge in this app, which are also kept after a streak resets.
// Re-locking it the moment a streak breaks would take away something the
// user already earned, which felt punitive rather than motivating.
//
// Only 5 colors are asked of the user (background, panel, primary, accent,
// text) — the remaining CSS variables every theme in base.css needs
// (ink-soft, teal-deep, gold-soft, sage, line) are mathematically derived
// from those 5 so a random color choice still looks cohesive instead of
// clashing.
//
// ---- PREMIUM EXTENSIONS (v2 — full app-wide customization) ----
// Beyond the 5 colors, the same unlock/builder now also covers:
//   - font pair (which typefaces the whole app's Bengali UI/heading text use)
//   - background pattern (a subtle full-screen tiled pattern behind everything)
//   - floating decorations: SIX icon types (lantern/star/moon/flower/sparkle/
//     feather), each hand-placed one at a time and dragged to an exact spot
//     on a live mini-preview of the screen, not just an on/off toggle
//   - which home-page sections are shown at all (ayah-of-day card, streak
//     ring, "last read" row, quick links row)
//   - audio player look: gradient/flat/glass style + its own bg/accent/text
//     colors, independent of the 5-color palette
//   - header + bottom nav look: solid/glass style + its own colors
//   - popup/modal look: corner roundness, shadow strength, open animation
// All of these extras are intentionally NOT scoped to body[data-theme="custom"]
// — like the 5 colors' derived neighbours, they're personal ambience/layout
// preferences, so they keep applying no matter which color theme (emerald,
// ocean, custom...) is currently active. Only the 5-color palette itself is
// theme-scoped. Every extension below stays behind the same 30-day unlock.

// ---- Tiny color math (hex <-> rgb, mix, darken, luminance, alpha) ----
function tbHexToRgb(hex){
  hex = String(hex||'#000000').replace('#','');
  if(hex.length === 3) hex = hex.split('').map(c => c+c).join('');
  const num = parseInt(hex, 16) || 0;
  return { r:(num>>16)&255, g:(num>>8)&255, b:num&255 };
}
function tbRgbToHex({r,g,b}){
  const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2,'0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
function tbMix(hexA, hexB, weightA){
  const a = tbHexToRgb(hexA), b = tbHexToRgb(hexB);
  const w = Math.max(0, Math.min(1, weightA));
  return tbRgbToHex({ r:a.r*w+b.r*(1-w), g:a.g*w+b.g*(1-w), b:a.b*w+b.b*(1-w) });
}
function tbDarken(hex, amount){
  const c = tbHexToRgb(hex);
  const f = 1 - amount;
  return tbRgbToHex({ r:c.r*f, g:c.g*f, b:c.b*f });
}
function tbLuminance(hex){
  const {r,g,b} = tbHexToRgb(hex);
  const lin = (v) => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
  return 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b);
}
function tbAlpha(hex, a){
  const {r,g,b} = tbHexToRgb(hex);
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;
}

// ---- Contrast checker (WCAG relative-luminance ratio) ----
// ratio ranges 1 (no contrast) to 21 (black/white). 4.5+ = safe for normal
// text (WCAG AA), 3+ = safe only for large/bold text, below = hard to read.
function tbContrastRatio(hexA, hexB){
  const l1 = tbLuminance(hexA), l2 = tbLuminance(hexB);
  const lighter = Math.max(l1, l2), darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}
function tbContrastBadge(ratio){
  let cls, label, icon;
  if(ratio >= 4.5){ cls = 'good'; icon = 'fa-circle-check'; label = 'চমৎকার'; }
  else if(ratio >= 3){ cls = 'warn'; icon = 'fa-triangle-exclamation'; label = 'মাঝারি, বড় লেখায় ঠিক আছে'; }
  else { cls = 'bad'; icon = 'fa-circle-exclamation'; label = 'কম — পড়তে কষ্ট হতে পারে'; }
  return `<span class="tb-contrast-badge tb-contrast-${cls}"><i class="fa-solid ${icon}"></i> ${ratio.toFixed(1)}:১ ${label}</span>`;
}
function tbContrastRow(label, hexA, hexB){
  return `<div class="tb-contrast-row"><span>${label}</span>${tbContrastBadge(tbContrastRatio(hexA, hexB))}</div>`;
}

// ---- Persistence (own IDBKV key, kept separate from the built-in theme system) ----
// Namespaced per account (by Firebase uid), not just per device. Custom
// theme colors are a gated/earned asset (30-day streak or an admin grant),
// so they belong to the account that unlocked them — without this, signing
// into a second account on the same phone/browser would inherit whatever
// design the first account built, unlocked or not.
const TB_STORAGE_KEY = 'qr_custom_theme';
function tbStorageKey(){
  const uid = (state.user && state.user.uid) || 'guest';
  return TB_STORAGE_KEY + '_' + uid;
}
// One-time migration: earlier versions kept one shared, device-wide config
// under TB_STORAGE_KEY. The first time this runs for whichever account is
// signed in, that legacy config is claimed for the current account and the
// shared key is removed, so it can't also leak into the next account that
// signs in on this device afterwards.
function tbMigrateLegacyStorage(){
  try{
    const key = tbStorageKey();
    if(IDBKV.get(key)) return; // this account already has its own config
    const legacy = IDBKV.get(TB_STORAGE_KEY);
    if(legacy){
      IDBKV.set(key, legacy);
      IDBKV.remove(TB_STORAGE_KEY);
    }
  }catch(e){}
}
function tbLoadRaw(){
  try{ tbMigrateLegacyStorage(); const raw = IDBKV.get(tbStorageKey()); return raw ? JSON.parse(raw) : null; }catch(e){ return null; }
}
function tbSaveRaw(cfg){
  try{ IDBKV.set(tbStorageKey(), JSON.stringify(cfg)); }catch(e){}
}

// ---- Derive the full CSS-variable set from the 5 picked colors ----
function tbDeriveVars(cfg){
  return {
    parchment: cfg.parchment, panel: cfg.panel, ink: cfg.ink,
    inkSoft: tbMix(cfg.ink, cfg.parchment, 0.55),
    teal: cfg.teal, tealDeep: tbDarken(cfg.teal, 0.28),
    gold: cfg.gold, goldSoft: tbMix(cfg.gold, cfg.panel, 0.32),
    sage: tbMix(cfg.panel, cfg.teal, 0.12),
    line: tbMix(cfg.panel, cfg.ink, 0.16),
    radius: cfg.radius || 14
  };
}
function tbApplyCSS(vars){
  let tag = document.getElementById('customThemeStyleTag');
  if(!tag){ tag = document.createElement('style'); tag.id = 'customThemeStyleTag'; document.head.appendChild(tag); }
  tag.textContent = `body[data-theme="custom"]{
    --parchment:${vars.parchment}; --panel:${vars.panel}; --ink:${vars.ink}; --ink-soft:${vars.inkSoft};
    --teal:${vars.teal}; --teal-deep:${vars.tealDeep}; --gold:${vars.gold}; --gold-soft:${vars.goldSoft};
    --sage:${vars.sage}; --line:${vars.line}; --radius:${vars.radius}px; --bg-texture:none;
  }`;
  if(typeof THEME_COLORS !== 'undefined') THEME_COLORS.custom = vars.tealDeep;
}
function tbRegisterInThemesList(cfg){
  const meta = { id:'custom', nameKey:'theme_custom', descKey:'theme_custom_desc', dark: !!cfg.dark, swatch:[cfg.parchment, cfg.teal, cfg.gold] };
  const idx = THEMES.findIndex(th => th.id === 'custom');
  if(idx >= 0) THEMES[idx] = meta; else THEMES.push(meta);
}

// ==== PREMIUM EXTENSION: font pairs ====
const TB_FONT_PAIRS = {
  classic:     { ui:"'Hind Siliguri'",  heading:"'Noto Serif Bengali'", sample:'বাংলা', name:'ক্লাসিক (ডিফল্ট)' },
  round:       { ui:"'Baloo Da 2'",     heading:"'Baloo Da 2'",         sample:'বাংলা', name:'গোলগাল (রাউন্ড)' },
  serif:       { ui:"'Tiro Bangla'",    heading:"'Tiro Bangla'",        sample:'বাংলা', name:'সাবেকি (সেরিফ)' },
  mixedserif:  { ui:"'Hind Siliguri'",  heading:"'Tiro Bangla'",        sample:'বাংলা', name:'মিশ্র (হেডিং সেরিফ)' }
};
function tbApplyFont(pairId){
  const f = TB_FONT_PAIRS[pairId] || TB_FONT_PAIRS.classic;
  document.documentElement.style.setProperty('--font-ui', f.ui);
  document.documentElement.style.setProperty('--font-heading', f.heading);
}

// ==== PREMIUM EXTENSION: background patterns (7 now, up from 3) ====
const TB_PATTERNS = {
  none:     { image:'none', size:'auto', name:'কোনোটিই না' },
  dots:     { image:"radial-gradient(var(--line) 1.4px, transparent 1.4px)", size:'22px 22px', name:'বিন্দু' },
  grid:     { image:"linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px)", size:'26px 26px, 26px 26px', name:'গ্রিড' },
  geo:      { image:"repeating-linear-gradient(45deg, var(--gold) 0 1.5px, transparent 1.5px 26px), repeating-linear-gradient(-45deg, var(--gold) 0 1.5px, transparent 1.5px 26px)", size:'auto', name:'জ্যামিতিক' },
  diagonal: { image:"repeating-linear-gradient(60deg, var(--line) 0 2px, transparent 2px 20px)", size:'auto', name:'তির্যক রেখা' },
  waves:    { image:"radial-gradient(circle at 50% 0%, transparent 9px, var(--line) 10px, transparent 11px)", size:'26px 16px', name:'ঢেউ' },
  honeycomb:{ image:"radial-gradient(circle at 100% 50%, transparent 9px, var(--line) 10px, transparent 11px), radial-gradient(circle at 0% 50%, transparent 9px, var(--line) 10px, transparent 11px)", size:'24px 24px', name:'মৌচাক' },
  confetti: { image:"radial-gradient(var(--gold) 1.6px, transparent 1.6px), radial-gradient(var(--teal) 1.6px, transparent 1.6px)", size:'30px 30px, 30px 30px', name:'কনফেটি' }
};

// ==== PREMIUM EXTENSION v2: hand-placed floating decorations ====
// Twelve icon types, all rendered as real Font Awesome glyphs (<i class="...">)
// instead of emoji characters, so they scale/color/animate consistently with
// the rest of the app's iconography. Each placed instance is
// {id, type, top, left} where top/left are percentages (0-100) positioned by
// the user by dragging on a live mini preview inside the builder — not a
// fixed hard-coded spot list.
const TB_DECOR_TYPES = {
  // -- original six, now coded as FA icons instead of emoji --
  lantern: { icon:'fa-solid fa-lightbulb',           name:'লন্ঠন',     size:22, opacity:.5,  anim:'tbLanternSwing 3.2s ease-in-out infinite', group:'basic' },
  star:    { icon:'fa-solid fa-star',                name:'তারা',      size:15, opacity:.42, anim:'tbStarTwinkle 2.5s ease-in-out infinite',  group:'basic' },
  moon:    { icon:'fa-solid fa-moon',                name:'চাঁদ',      size:20, opacity:.45, anim:'tbMoonFloat 4s ease-in-out infinite',      group:'basic' },
  flower:  { icon:'fa-solid fa-spa',                 name:'ফুল',       size:18, opacity:.4,  anim:'tbFlowerDrift 5s ease-in-out infinite',    group:'basic' },
  sparkle: { icon:'fa-solid fa-wand-magic-sparkles', name:'স্পার্কল',  size:16, opacity:.5,  anim:'tbStarTwinkle 2.1s ease-in-out infinite',  group:'basic' },
  feather: { icon:'fa-solid fa-feather',             name:'পালক',      size:18, opacity:.4,  anim:'tbFeatherSway 4.5s ease-in-out infinite',  group:'basic' },
  // -- new additions --
  sun:      { icon:'fa-solid fa-sun',               name:'সূর্য',       size:19, opacity:.4,  anim:'tbMoonFloat 4.5s ease-in-out infinite',   group:'new' },
  cloud:    { icon:'fa-solid fa-cloud',             name:'মেঘ',         size:20, opacity:.38, anim:'tbFlowerDrift 6s ease-in-out infinite',   group:'new' },
  crescent: { icon:'fa-solid fa-star-and-crescent', name:'চাঁদ-তারা',   size:20, opacity:.46, anim:'tbMoonFloat 4.2s ease-in-out infinite',   group:'new' },
  mosque:   { icon:'fa-solid fa-mosque',            name:'মসজিদ',       size:20, opacity:.4,  anim:'tbFeatherSway 5s ease-in-out infinite',   group:'new' },
  gem:      { icon:'fa-solid fa-gem',               name:'রত্ন',        size:16, opacity:.44, anim:'tbStarTwinkle 2.8s ease-in-out infinite', group:'new' },
  crown:    { icon:'fa-solid fa-crown',             name:'মুকুট',       size:18, opacity:.4,  anim:'tbLanternSwing 3.6s ease-in-out infinite', group:'new' }
};
const TB_DECOR_MAX_PER_TYPE = 6;
const TB_DECOR_MAX_TOTAL = 18;
const TB_LEGACY_LANTERN_SPOTS = [ {top:8,left:6}, {top:24,left:88}, {top:54,left:4}, {top:70,left:91} ];
const TB_LEGACY_STAR_SPOTS = [ {top:14,left:46}, {top:34,left:12}, {top:58,left:80}, {top:80,left:32}, {top:4,left:68} ];
let tbDecorIdSeq = 1;
function tbNewDecorId(){ return 'd' + (tbDecorIdSeq++) + '_' + Date.now().toString(36); }

function tbEnsureAmbientLayers(){
  let pat = document.getElementById('tbBgPatternLayer');
  if(!pat){
    pat = document.createElement('div');
    pat.id = 'tbBgPatternLayer';
    pat.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(pat, document.body.firstChild);
  }
  let dec = document.getElementById('tbDecorLayer');
  if(!dec){
    dec = document.createElement('div');
    dec.id = 'tbDecorLayer';
    dec.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(dec, pat.nextSibling);
  }
  return { pat, dec };
}
function tbApplyAmbient(cfg){
  cfg = cfg || {};
  const { pat, dec } = tbEnsureAmbientLayers();
  const key = cfg.bgPattern || 'none';
  const p = TB_PATTERNS[key] || TB_PATTERNS.none;
  pat.style.backgroundImage = p.image;
  pat.style.backgroundSize = p.size;
  pat.style.opacity = key === 'none' ? 0 : (cfg.bgPatternOpacity != null ? cfg.bgPatternOpacity : 0.25);

  dec.innerHTML = '';
  const list = Array.isArray(cfg.decorations) ? cfg.decorations : [];
  list.forEach((inst, i) => {
    const meta = TB_DECOR_TYPES[inst.type];
    if(!meta) return;
    const span = document.createElement('span');
    span.innerHTML = `<i class="${meta.icon}"></i>`;
    span.style.position = 'absolute';
    span.style.top = inst.top + '%';
    span.style.left = inst.left + '%';
    span.style.fontSize = meta.size + 'px';
    span.style.color = 'var(--gold)';
    span.style.lineHeight = '1';
    span.style.opacity = meta.opacity;
    span.style.animation = meta.anim;
    span.style.animationDelay = (i * 0.3) + 's';
    span.style.transformOrigin = 'top center';
    dec.appendChild(span);
  });
}

// ==== PREMIUM EXTENSION: home-section show/hide ====
function tbApplyHomeSections(cfg){
  cfg = cfg || {};
  const hs = cfg.homeSections || {};
  const set = (id, visible) => {
    const el = document.getElementById(id);
    if(el) el.classList.toggle('tb-hide-section', visible === false);
  };
  set('ayahOfDayCard', hs.ayah !== false);
  set('homeStreakRing', hs.streak !== false);
  set('lastReadTitle', hs.lastread !== false);
  set('lastReadChips', hs.lastread !== false);
  set('quickLinkTitle', hs.quicklinks !== false);
  set('quickLinkChips', hs.quicklinks !== false);
}

// ==== PREMIUM EXTENSION v2: audio player look ====
// variant: 'classic' (default gradient, unchanged look), 'flat' (solid color,
// no gradient), 'glass' (translucent + backdrop blur). Colors only take
// effect once the user turns the "আলাদা রঙ" toggle on — off means every
// --player-* var is cleared so player.css falls back to its original look.
function tbApplyPlayer(cfg){
  cfg = cfg || {};
  const p = cfg.player || {};
  const root = document.documentElement.style;
  if(!p.enabled){
    ['--player-bg','--player-blur','--player-accent-bg','--player-accent-text','--player-text-color']
      .forEach(v => root.removeProperty(v));
    return;
  }
  const variant = p.variant || 'classic';
  const bg1 = p.bg1 || '#0E3B36', bg2 = p.bg2 || '#071E1A';
  const accent = p.accent || '#C0973A', text = p.text || '#CFE0D6';
  let bg, blur = 'none';
  if(variant === 'flat'){ bg = bg1; }
  else if(variant === 'glass'){ bg = tbAlpha(bg1, .5); blur = 'blur(14px)'; }
  else { bg = `linear-gradient(180deg, ${bg1} 0%, ${bg2} 100%)`; }
  root.setProperty('--player-bg', bg);
  root.setProperty('--player-blur', blur);
  root.setProperty('--player-accent-bg', accent);
  root.setProperty('--player-accent-text', tbLuminance(accent) > 0.5 ? '#20261f' : '#ffffff');
  root.setProperty('--player-text-color', text);
}

// ==== PREMIUM EXTENSION v2: header + bottom-nav look ====
function tbApplyNavHeader(cfg){
  cfg = cfg || {};
  const n = cfg.navHeader || {};
  const root = document.documentElement.style;
  if(!n.enabled){
    ['--header-bg','--header-text','--header-blur','--nav-bg','--nav-accent','--nav-blur']
      .forEach(v => root.removeProperty(v));
    return;
  }
  const variant = n.variant || 'solid';
  const bg = n.bg || '#0E3B36', text = n.text || '#DCE6DE', accent = n.accent || '#C0973A';
  const finalBg = variant === 'glass' ? tbAlpha(bg, .68) : bg;
  const blur = variant === 'glass' ? 'blur(12px)' : 'none';
  root.setProperty('--header-bg', finalBg);
  root.setProperty('--header-text', text);
  root.setProperty('--header-blur', blur);
  root.setProperty('--nav-bg', finalBg);
  root.setProperty('--nav-accent', accent);
  root.setProperty('--nav-blur', blur);
}

// ==== PREMIUM EXTENSION v2: popup / modal look ====
// anim: 'none' (default, unchanged), 'fade', 'slide', 'scale'.
function tbApplyModal(cfg){
  cfg = cfg || {};
  const m = cfg.modal || {};
  const root = document.documentElement.style;
  if(m.radius != null) root.setProperty('--modal-radius', m.radius + 'px'); else root.removeProperty('--modal-radius');
  if(m.shadowIntensity != null){
    const s = m.shadowIntensity;
    root.setProperty('--modal-shadow', `0 ${Math.round(10+s*24)}px ${Math.round(40+s*50)}px rgba(0,0,0,${(0.16+s*0.34).toFixed(2)})`);
  } else root.removeProperty('--modal-shadow');
  const anim = m.anim || 'none';
  if(anim === 'none') delete document.body.dataset.modalAnim;
  else document.body.dataset.modalAnim = anim;
}

// ---- Full draft defaults (merges an older saved config missing the newer
// premium fields with sane defaults, so nothing breaks for anyone who saved
// a custom theme before these extensions existed) ----
function tbDefaults(){
  return {
    parchment:'#FBF6EC', panel:'#F3ECDC', teal:'#0E3B36', gold:'#C0973A', ink:'#1E2A26', dark:false, radius:14,
    fontPair:'classic', bgPattern:'none', bgPatternOpacity:0.25,
    decorations: [],
    homeSections:{ ayah:true, streak:true, lastread:true, quicklinks:true },
    player:{ enabled:false, variant:'classic', bg1:'#0E3B36', bg2:'#071E1A', accent:'#C0973A', text:'#CFE0D6' },
    navHeader:{ enabled:false, variant:'solid', bg:'#0E3B36', text:'#DCE6DE', accent:'#C0973A' },
    modal:{ radius:14, shadowIntensity:0.35, anim:'none' }
  };
}
function tbMigrateLegacyDecor(saved){
  // Old boolean decorLantern / decorStars -> instances at their old fixed spots.
  if(saved.decorations) return saved.decorations;
  const out = [];
  if(saved.decorLantern) TB_LEGACY_LANTERN_SPOTS.forEach(s => out.push({ id:tbNewDecorId(), type:'lantern', top:s.top, left:s.left }));
  if(saved.decorStars) TB_LEGACY_STAR_SPOTS.forEach(s => out.push({ id:tbNewDecorId(), type:'star', top:s.top, left:s.left }));
  return out;
}
function tbMergeWithDefaults(saved){
  const d = tbDefaults();
  if(!saved) return d;
  const merged = Object.assign({}, d, saved, {
    homeSections: Object.assign({}, d.homeSections, saved.homeSections || {}),
    player: Object.assign({}, d.player, saved.player || {}),
    navHeader: Object.assign({}, d.navHeader, saved.navHeader || {}),
    modal: Object.assign({}, d.modal, saved.modal || {}),
    decorations: tbMigrateLegacyDecor(saved)
  });
  delete merged.decorLantern; delete merged.decorStars;
  return merged;
}

// Called once at startup (from js/app.js, BEFORE initTheme() paints the
// saved theme) so every premium extra is live from the very first paint.
// Also re-called on every sign-in/sign-out/account-switch (see
// reloadCustomThemeForCurrentUser below) — so when the active account has
// no custom theme of its own, this now resets every premium extra (font
// pair, ambient decorations, home-section toggles, player/nav/modal
// styling) back to defaults instead of silently leaving a previous
// account's choices applied.
function loadCustomTheme(){
  const cfg = tbLoadRaw();
  const full = tbMergeWithDefaults(cfg); // defaults when this account has no custom theme
  tbApplyCSS(tbDeriveVars(full));
  if(cfg){
    tbRegisterInThemesList(full);
  } else {
    const idx = THEMES.findIndex(th => th.id === 'custom');
    if(idx >= 0) THEMES.splice(idx, 1);
  }
  tbApplyFont(full.fontPair);
  tbApplyAmbient(full);
  tbApplyHomeSections(full);
  tbApplyPlayer(full);
  tbApplyNavHeader(full);
  tbApplyModal(full);
}

// Called from js/auth.js right after state.user changes (sign-in, sign-out,
// switching to a different account) so a previously-loaded custom theme
// never carries over to the wrong account.
function reloadCustomThemeForCurrentUser(){
  loadCustomTheme();
  // If the device was actively displaying the custom theme but the account
  // now signed in never designed one of its own, fall back to a built-in
  // theme rather than keep running the previous account's premium design.
  if(state.theme === 'custom' && !tbLoadRaw() && typeof applyTheme === 'function' && typeof THEMES !== 'undefined'){
    applyTheme(THEMES[0].id);
  }
}

// Small Bengali/English label patch so the custom card can use the same
// t(key) lookup pattern as every built-in theme, without editing all 14
// per-language files in js/i18n/.
(function patchI18nForCustomTheme(){
  if(typeof I18N === 'undefined') return;
  Object.keys(I18N).forEach(lang => {
    if(I18N[lang].theme_custom === undefined) I18N[lang].theme_custom = (lang === 'bn') ? 'কাস্টম থিম' : 'Custom theme';
    if(I18N[lang].theme_custom_desc === undefined) I18N[lang].theme_custom_desc = (lang === 'bn') ? 'আপনার নিজের বাছাই করা রঙে তৈরি থিম' : 'A theme built from your own hand-picked colors';
  });
})();

// ---- Unlock gate ----
function tbCurrentStreak(){
  try{
    const s = computeStreak(loadActivity());
    if(s > (state.bestStreak||0) && typeof updateBestStreak === 'function') updateBestStreak(s);
    return Math.max(s, state.bestStreak||0);
  }catch(e){ return state.bestStreak||0; }
}
// এডমিন প্যানেল থেকে যে কাউকে সরাসরি কাস্টম থিম অ্যাক্সেস দেওয়া যায়
// (user.customThemeGranted) — সেটা থাকলে ৩০-দিনের স্ট্রিক শর্ত বাইপাস হয়।
function customThemeUnlocked(){
  return tbCurrentStreak() >= 30 || !!(state.user && state.user.customThemeGranted);
}

// ---- The card appended to the end of the theme-picker grid (see js/app.js openThemePicker) ----
function appendCustomThemeCard(grid, t){
  if(!grid) return;
  const unlocked = customThemeUnlocked();
  const cfg = tbLoadRaw();
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'theme-picker-card theme-picker-card-custom';
  card.setAttribute('data-theme-id', 'custom');

  if(!unlocked){
    const streak = tbCurrentStreak();
    card.classList.add('locked');
    card.innerHTML = `
      <span class="theme-picker-swatch tb-locked-swatch"><i class="fa-solid fa-lock"></i></span>
      <span class="theme-picker-name">${t('theme_custom')}</span>
      <span class="theme-picker-desc">You are not yet eligible for a custom theme. Your progress is (${toBn(streak)}/৩০ day) </span>`;
    card.onclick = () => showToast(` ${toBn(Math.max(0, 30-streak))} Premium customization will be unlocked as the day progresses.`);
  } else if(!cfg){
    card.innerHTML = `
      <span class="theme-picker-swatch tb-add-swatch"><i class="fa-solid fa-palette"></i></span>
      <span class="theme-picker-name">${t('theme_custom')} <i class="fa-solid fa-lock-open"></i></span>
      <span class="theme-picker-desc"> Dear reader, you have access to custom themes with the user.</span>`;
    card.onclick = () => openThemeBuilder();
  } else {
    const active = state.theme === 'custom';
    card.classList.toggle('active', active);
    card.innerHTML = `
      <span class="theme-picker-swatch">${[cfg.parchment, cfg.teal, cfg.gold].map(c => `<span style="background:${c}"></span>`).join('')}</span>
      <span class="theme-picker-name">${t('theme_custom')}${active ? ' <i class="fa-solid fa-circle-check"></i>' : ''} <button type="button" class="tb-edit-btn" title="edit"><i class="fa-solid fa-pen"></i></button></span>
      <span class="theme-picker-desc">${t('theme_custom_desc')}</span>`;
    card.onclick = (e) => { if(e.target.closest('.tb-edit-btn')) return; applyTheme('custom'); };
  }
  grid.appendChild(card);
  const editBtn = card.querySelector('.tb-edit-btn');
  if(editBtn) editBtn.onclick = (e) => { e.stopPropagation(); openThemeBuilder(); };
}

// ---- Builder modal (live preview + save/cancel) ----
let tbPrevThemeId = null;
let tbDraft = null;
let tbSavedFlag = false;

function tbDefaultDraft(){
  return tbMergeWithDefaults(tbLoadRaw());
}
function tbPreview(){
  tbApplyCSS(tbDeriveVars(tbDraft));
  tbRegisterInThemesList(tbDraft);
  document.body.setAttribute('data-theme', 'custom');
  document.body.classList.toggle('theme-dark-accent', !!tbDraft.dark);
  tbApplyFont(tbDraft.fontPair);
  tbApplyAmbient(tbDraft);
  tbApplyHomeSections(tbDraft);
  tbApplyPlayer(tbDraft);
  tbApplyNavHeader(tbDraft);
  tbApplyModal(tbDraft);
}
// Hooked from js/menu.js closeModal() so every close path (✕ button,
// backdrop tap, Escape key) reverts an unsaved preview the same way —
// including every premium extra, not just the color theme.
function tbCancelIfUnsaved(){
  if(tbSavedFlag){ tbSavedFlag = false; return; }
  if(tbPrevThemeId) applyTheme(tbPrevThemeId, { save:false });
  const saved = tbMergeWithDefaults(tbLoadRaw());
  tbApplyFont(saved.fontPair);
  tbApplyAmbient(saved);
  tbApplyHomeSections(saved);
  tbApplyPlayer(saved);
  tbApplyNavHeader(saved);
  tbApplyModal(saved);
}
function tbSave(){
  tbSaveRaw(tbDraft);
  tbRegisterInThemesList(tbDraft);
  tbSavedFlag = true;
  closeModal('themeBuilderModal');
  applyTheme('custom');
  tbApplyFont(tbDraft.fontPair);
  tbApplyAmbient(tbDraft);
  tbApplyHomeSections(tbDraft);
  tbApplyPlayer(tbDraft);
  tbApplyNavHeader(tbDraft);
  tbApplyModal(tbDraft);
  showToast('Your custom theme has been saved. ✓');
}

function tbFieldRow(id, label, value){
  return `<div class="tb-row">
    <label for="${id}">${label}</label>
    <input type="color" id="${id}" value="${value}">
  </div>`;
}
function tbSectionHeader(iconClass, title, resetId){
  return `<div class="tb-section-label">
    ${iconClass ? `<i class="${iconClass}"></i>` : ''}<span class="tb-section-title">${title}</span>
    <button type="button" class="tb-section-reset" id="${resetId}" title="এই অংশ ডিফল্টে ফিরিয়ে নিন"><i class="fa-solid fa-arrow-rotate-left"></i></button>
  </div>`;
}
function tbCheckRow(id, emoji, label, desc, checked){
  return `<label class="tb-check-row" for="${id}">
    <input type="checkbox" id="${id}" ${checked ? 'checked' : ''}>
    <span class="tcr-emoji">${emoji}</span>
    <span><span>${label}</span><span class="tcr-desc">${desc}</span></span>
  </label>`;
}

// ==== Draggable mini-preview for hand-placing decorations ====
// A small phone-shaped box painted with the draft's own colors; each placed
// decoration is a real emoji span the user can drag anywhere inside it.
// Position is stored as a 0-100 percentage so it maps directly onto the
// real full-screen layer via tbApplyAmbient().
// NOTE (bug fix): onMove used to trigger a full tbPreview() on every single
// pointermove — that re-applies CSS vars, re-registers the theme, re-renders
// fonts/patterns/home-sections/player/nav/modal, all just to move one dot.
// On a phone that's heavy enough per-frame that the dot visually lags or
// looks "stuck", which is why dragging felt broken. Now onMove only updates
// the dot's own position (cheap, instant), and the expensive full sync
// (onEnd) runs once when the finger/mouse is lifted.
function tbMakeDraggable(el, container, onMove, onEnd){
  let dragging = false;
  const move = (clientX, clientY) => {
    const rect = container.getBoundingClientRect();
    let left = ((clientX - rect.left) / rect.width) * 100;
    let top = ((clientY - rect.top) / rect.height) * 100;
    left = Math.max(2, Math.min(96, left));
    top = Math.max(2, Math.min(94, top));
    onMove(top, left);
  };
  el.addEventListener('pointerdown', (e) => {
    dragging = true;
    el.setPointerCapture(e.pointerId);
    el.classList.add('tb-dragging');
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if(!dragging) return;
    move(e.clientX, e.clientY);
  });
  const end = (e) => {
    if(!dragging) return;
    dragging = false;
    el.classList.remove('tb-dragging');
    if(onEnd) onEnd();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

function tbRenderDecorChips(groupKey){
  const countsByType = {};
  tbDraft.decorations.forEach(d => { countsByType[d.type] = (countsByType[d.type]||0) + 1; });
  return Object.keys(TB_DECOR_TYPES).filter(type => TB_DECOR_TYPES[type].group === groupKey).map(type => {
    const meta = TB_DECOR_TYPES[type];
    const count = countsByType[type] || 0;
    const full = count >= TB_DECOR_MAX_PER_TYPE;
    return `<div class="tb-decor-chip${full ? ' tb-decor-chip-full' : ''}" data-type="${type}" title="${meta.name}">
      <span class="tdc-emoji"><i class="${meta.icon}"></i></span>
      <span class="tdc-name">${meta.name}</span>
      <span class="tdc-count">${toBn(count)}/${toBn(TB_DECOR_MAX_PER_TYPE)}</span>
      <button type="button" class="tdc-add" data-add="${type}" title="${meta.name} যোগ করুন"><i class="fa-solid fa-plus"></i></button>
    </div>`;
  }).join('');
}

function tbRenderDecorSection(){
  return `
    <div class="tb-decor-group-label">মৌলিক আইকন</div>
    <div class="tb-decor-chip-grid" id="tbDecorChipGridBasic">${tbRenderDecorChips('basic')}</div>
    <div class="tb-decor-group-label">নতুন সংযোজন</div>
    <div class="tb-decor-chip-grid" id="tbDecorChipGridNew">${tbRenderDecorChips('new')}</div>
    <div class="tb-decor-hint"><i class="fa-solid fa-hand-pointer"></i> <span><i class="fa-solid fa-plus"></i> চাপুন আইকন যোগ করতে, তারপর নিচের প্রিভিউতে টেনে জায়গা ঠিক করুন। মুছতে আইটেমের ✕ চাপুন। মোট সর্বোচ্চ ${toBn(TB_DECOR_MAX_TOTAL)}টি, প্রতিটি আইকন সর্বোচ্চ ${toBn(TB_DECOR_MAX_PER_TYPE)}টি।</span></div>
    <div class="tb-decor-preview" id="tbDecorPreview"></div>
  `;
}

// Snap threshold in preview percentage points — how close the drag needs to
// get to a guide value (center, or another icon's position) before it locks on.
const TB_SNAP_THRESHOLD = 2.5;
function tbSnapValue(raw, candidates){
  let best = null, bestDist = TB_SNAP_THRESHOLD;
  candidates.forEach(c => {
    const dist = Math.abs(raw - c);
    if(dist <= bestDist){ bestDist = dist; best = c; }
  });
  return best;
}
function tbRenderDecorPreview(){
  const preview = document.getElementById('tbDecorPreview');
  if(!preview) return;
  preview.style.background = tbDraft.parchment;
  preview.style.borderColor = tbMix(tbDraft.panel, tbDraft.ink, 0.16);
  preview.innerHTML = `<span class="tb-decor-preview-bar" style="background:${tbDraft.teal}"></span>
    <span class="tb-snap-guide-v" id="tbSnapGuideV"></span>
    <span class="tb-snap-guide-h" id="tbSnapGuideH"></span>`;
  const vGuide = document.getElementById('tbSnapGuideV');
  const hGuide = document.getElementById('tbSnapGuideH');

  tbDraft.decorations.forEach(inst => {
    const meta = TB_DECOR_TYPES[inst.type];
    if(!meta) return;
    const dot = document.createElement('div');
    dot.className = 'tb-decor-dot';
    dot.style.top = inst.top + '%';
    dot.style.left = inst.left + '%';
    dot.innerHTML = `<span class="tdd-emoji" style="font-size:${Math.min(meta.size,20)}px"><i class="${meta.icon}"></i></span><button type="button" class="tdd-remove" data-remove="${inst.id}">✕</button>`;
    preview.appendChild(dot);
    // Live move: only touches this dot's own inline position (cheap, instant
    // feedback) plus snap-to-guide checks. The expensive full-app sync
    // (tbApplyAmbient) runs once the drag ends, not on every pointermove —
    // see tbMakeDraggable's note.
    tbMakeDraggable(dot, preview, (top, left) => {
      const others = tbDraft.decorations.filter(d => d.id !== inst.id);
      const snapLeft = tbSnapValue(left, [50, ...others.map(d => d.left)]);
      const snapTop = tbSnapValue(top, [50, ...others.map(d => d.top)]);
      const finalLeft = snapLeft != null ? snapLeft : left;
      const finalTop = snapTop != null ? snapTop : top;
      inst.top = Math.round(finalTop);
      inst.left = Math.round(finalLeft);
      dot.style.top = inst.top + '%';
      dot.style.left = inst.left + '%';
      if(snapLeft != null){ vGuide.style.left = snapLeft + '%'; vGuide.classList.add('tb-snap-active'); }
      else vGuide.classList.remove('tb-snap-active');
      if(snapTop != null){ hGuide.style.top = snapTop + '%'; hGuide.classList.add('tb-snap-active'); }
      else hGuide.classList.remove('tb-snap-active');
    }, () => {
      vGuide.classList.remove('tb-snap-active');
      hGuide.classList.remove('tb-snap-active');
      tbApplyAmbient(tbDraft);
    });
    dot.querySelector('.tdd-remove').onclick = (e) => {
      e.stopPropagation();
      tbDraft.decorations = tbDraft.decorations.filter(d => d.id !== inst.id);
      tbRenderDecorSection2();
      tbApplyAmbient(tbDraft);
    };
  });
}

// Re-renders both the chip grid (counts) and the preview dots together —
// needed after any add/remove since counts and dots must stay in sync.
function tbRenderDecorSection2(){
  const wrap = document.getElementById('tbDecorWrap');
  if(!wrap) return;
  wrap.innerHTML = tbRenderDecorSection();
  tbWireDecorSection();
}
function tbWireDecorSection(){
  document.querySelectorAll('#tbDecorChipGridBasic .tdc-add, #tbDecorChipGridNew .tdc-add').forEach(btn => {
    btn.onclick = () => {
      const type = btn.getAttribute('data-add');
      const countForType = tbDraft.decorations.filter(d => d.type === type).length;
      if(countForType >= TB_DECOR_MAX_PER_TYPE){ showToast(`এই আইটেম সর্বোচ্চ ${toBn(TB_DECOR_MAX_PER_TYPE)}টি বসানো যায়`); return; }
      if(tbDraft.decorations.length >= TB_DECOR_MAX_TOTAL){ showToast(`সর্বোচ্চ ${toBn(TB_DECOR_MAX_TOTAL)}টি ডেকোরেশন বসানো যায়`); return; }
      tbDraft.decorations.push({ id:tbNewDecorId(), type, top: 10 + Math.random()*70, left: 8 + Math.random()*80 });
      tbRenderDecorSection2();
      tbPreview();
    };
  });
  tbRenderDecorPreview();
}

// ==== Style-variant picker cards (used by player + header/nav sections) ====
function tbVariantCard(id, active, label, sampleStyle){
  return `<button type="button" class="tb-style-card${active ? ' active' : ''}" data-variant="${id}">
    <span class="tsc-sample" style="${sampleStyle}"></span>
    <span class="tsc-name">${label}</span>
  </button>`;
}

function openThemeBuilder(){
  if(!customThemeUnlocked()){
    showToast(`৩০ দিনের স্ট্রিক প্রয়োজন (বর্তমানে ${toBn(tbCurrentStreak())} দিন)`);
    return;
  }
  tbPrevThemeId = state.theme;
  tbDraft = tbDefaultDraft();

  let modal = document.getElementById('themeBuilderModal');
  if(!modal){
    modal = document.createElement('div');
    modal.className = 'app-modal';
    modal.id = 'themeBuilderModal';
    modal.innerHTML = `
      <div class="app-modal-box">
        <div class="app-modal-head">
          <h3><i class="fa-solid fa-palette"></i> প্রিমিয়াম কাস্টমাইজেশন</h3>
          <button class="app-modal-close" id="tbClose">✕</button>
        </div>
        <div class="app-modal-body">
          ${tbSectionHeader('fa-solid fa-droplet', 'রঙ', 'tbResetColors')}
          <div class="tb-fields" id="tbFields"></div>
          <div class="tb-contrast-info" id="tbContrastInfo"></div>
          <div class="tb-row tb-row-radius">
            <label for="tbRadius">কোণা গোলাকার (Radius)</label>
            <input type="range" id="tbRadius" min="4" max="26" step="1">
          </div>
          <label class="tb-dark-toggle">
            <input type="checkbox" id="tbDarkChk"> এটি একটি ডার্ক থিম (ব্যাকগ্রাউন্ড অনুযায়ী auto-নির্ধারিত, প্রয়োজনে বদলে দিন)
          </label>

          ${tbSectionHeader('fa-solid fa-font', 'ফন্ট স্টাইল', 'tbResetFont')}
          <div class="tb-font-grid" id="tbFontGrid"></div>

          ${tbSectionHeader('fa-solid fa-brush', 'ব্যাকগ্রাউন্ড প্যাটার্ন', 'tbResetPattern')}
          <div class="tb-pattern-grid" id="tbPatternGrid"></div>
          <div class="tb-row tb-row-opacity" id="tbOpacityRow">
            <label for="tbOpacity">প্যাটার্নের গাঢ়ত্ব</label>
            <input type="range" id="tbOpacity" min="0.1" max="0.6" step="0.05">
          </div>

          ${tbSectionHeader('fa-solid fa-wand-magic-sparkles', 'ডেকোরেটিভ এলিমেন্ট', 'tbResetDecor')}
          <div class="tb-section-hint">কোন আইকন, কয়টি, আর কোথায় বসবে — সবকিছু নিজে ঠিক করুন। মাঝখানে বা অন্য আইকনের বরাবর টানলে সোনালি গাইডলাইন দেখিয়ে সাথে সাথে সোজা করে দেবে।</div>
          <div id="tbDecorWrap"></div>

          ${tbSectionHeader('fa-solid fa-house', 'হোমপেজে যা দেখাবে', 'tbResetHome')}
          <div id="tbHomeChecks"></div>

          ${tbSectionHeader('fa-solid fa-headphones', 'অডিও প্লেয়ার', 'tbResetPlayer')}
          <label class="tb-check-row" for="tbPlayerEnabled" style="border-bottom:none;">
            <input type="checkbox" id="tbPlayerEnabled">
            <span class="tcr-emoji"><i class="fa-solid fa-sliders"></i></span>
            <span><span>প্লেয়ারে আলাদা রঙ/স্টাইল ব্যবহার করুন</span><span class="tcr-desc">বন্ধ থাকলে থিমের ডিফল্ট প্লেয়ার দেখাবে</span></span>
          </label>
          <div id="tbPlayerOptions"></div>

          ${tbSectionHeader('fa-solid fa-window-maximize', 'হেডার ও নিচের ন্যাভ বার', 'tbResetNav')}
          <label class="tb-check-row" for="tbNavEnabled" style="border-bottom:none;">
            <input type="checkbox" id="tbNavEnabled">
            <span class="tcr-emoji"><i class="fa-solid fa-sliders"></i></span>
            <span><span>হেডার/ন্যাভে আলাদা রঙ/স্টাইল ব্যবহার করুন</span><span class="tcr-desc">বন্ধ থাকলে থিমের ডিফল্ট রঙ দেখাবে</span></span>
          </label>
          <div id="tbNavOptions"></div>

          ${tbSectionHeader('fa-solid fa-square', 'পপ-আপ / মোডাল ডিজাইন', 'tbResetModal')}
          <div id="tbModalOptions"></div>

          <div class="tb-preview-note"><i class="fa-solid fa-eye"></i> বদলানোর সাথে সাথে পুরো অ্যাপে লাইভ প্রিভিউ দেখা যাবে</div>
          <div class="input-box-actions" style="margin-top:14px;">
            <button class="tw-cancel-btn" id="tbCancelBtn">বাতিল</button>
            <button class="tw-save-btn" id="tbSaveBtn">সংরক্ষণ করুন</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    wireModalBackdrop('themeBuilderModal');
    document.getElementById('tbClose').onclick = () => closeModal('themeBuilderModal');
    document.getElementById('tbCancelBtn').onclick = () => closeModal('themeBuilderModal');
    document.getElementById('tbSaveBtn').onclick = () => tbSave();
  }

  // ---- Colors ----
  const fields = document.getElementById('tbFields');
  const radiusEl = document.getElementById('tbRadius');
  const darkChk = document.getElementById('tbDarkChk');
  const renderContrastInfo = () => {
    document.getElementById('tbContrastInfo').innerHTML =
      tbContrastRow('লেখা ↔ ব্যাকগ্রাউন্ড', tbDraft.ink, tbDraft.parchment) +
      tbContrastRow('লেখা ↔ প্যানেল/কার্ড', tbDraft.ink, tbDraft.panel);
  };
  const renderColorsSection = () => {
    fields.innerHTML = [
      tbFieldRow('tbParchment', 'ব্যাকগ্রাউন্ড', tbDraft.parchment),
      tbFieldRow('tbPanel', 'প্যানেল / কার্ড', tbDraft.panel),
      tbFieldRow('tbTeal', 'প্রধান রঙ (হেডার)', tbDraft.teal),
      tbFieldRow('tbGold', 'সোনালি অ্যাকসেন্ট', tbDraft.gold),
      tbFieldRow('tbInk', 'লেখার রঙ', tbDraft.ink)
    ].join('');
    const onColorChange = (key, id) => {
      document.getElementById(id).oninput = (e) => {
        tbDraft[key] = e.target.value;
        if(key === 'parchment') tbDraft.dark = tbLuminance(tbDraft.parchment) < 0.35;
        darkChk.checked = !!tbDraft.dark;
        tbPreview();
        tbRenderDecorPreview();
        renderContrastInfo();
      };
    };
    onColorChange('parchment', 'tbParchment');
    onColorChange('panel', 'tbPanel');
    onColorChange('teal', 'tbTeal');
    onColorChange('gold', 'tbGold');
    onColorChange('ink', 'tbInk');
    radiusEl.value = tbDraft.radius;
    darkChk.checked = !!tbDraft.dark;
    renderContrastInfo();
  };
  renderColorsSection();
  radiusEl.oninput = (e) => { tbDraft.radius = parseInt(e.target.value, 10); tbPreview(); };
  darkChk.onchange = (e) => { tbDraft.dark = e.target.checked; tbPreview(); };
  document.getElementById('tbResetColors').onclick = () => {
    const d = tbDefaults();
    Object.assign(tbDraft, { parchment:d.parchment, panel:d.panel, teal:d.teal, gold:d.gold, ink:d.ink, dark:d.dark, radius:d.radius });
    renderColorsSection();
    tbPreview();
    tbRenderDecorPreview();
    showToast('রঙ ডিফল্টে ফেরানো হয়েছে');
  };

  // ---- Font pair ----
  const fontGrid = document.getElementById('tbFontGrid');
  const renderFontGrid = () => {
    fontGrid.innerHTML = Object.keys(TB_FONT_PAIRS).map(id => {
      const f = TB_FONT_PAIRS[id];
      return `<button type="button" class="tb-font-card${tbDraft.fontPair === id ? ' active' : ''}" data-font-id="${id}">
        <span class="tfc-sample" style="font-family:${f.heading}">${f.sample}</span>
        <span class="tfc-name">${f.name}</span>
      </button>`;
    }).join('');
    fontGrid.querySelectorAll('.tb-font-card').forEach(card => {
      card.onclick = () => { tbDraft.fontPair = card.getAttribute('data-font-id'); renderFontGrid(); tbPreview(); };
    });
  };
  renderFontGrid();
  document.getElementById('tbResetFont').onclick = () => {
    tbDraft.fontPair = tbDefaults().fontPair;
    renderFontGrid();
    tbPreview();
    showToast('ফন্ট ডিফল্টে ফেরানো হয়েছে');
  };

  // ---- Background pattern ----
  const patternGrid = document.getElementById('tbPatternGrid');
  const opacityRow = document.getElementById('tbOpacityRow');
  const opacityEl = document.getElementById('tbOpacity');
  const renderPatternGrid = () => {
    patternGrid.innerHTML = Object.keys(TB_PATTERNS).map(id => {
      const p = TB_PATTERNS[id];
      const style = id === 'none' ? '' : `background-image:${p.image};background-size:${p.size};opacity:.7`;
      return `<button type="button" class="tb-pattern-card${tbDraft.bgPattern === id ? ' active' : ''}" data-pattern-id="${id}" style="${style}">
        <span>${p.name}</span>
      </button>`;
    }).join('');
    patternGrid.querySelectorAll('.tb-pattern-card').forEach(card => {
      card.onclick = () => {
        tbDraft.bgPattern = card.getAttribute('data-pattern-id');
        opacityRow.style.display = tbDraft.bgPattern === 'none' ? 'none' : 'flex';
        renderPatternGrid();
        tbPreview();
      };
    });
  };
  renderPatternGrid();
  opacityRow.style.display = tbDraft.bgPattern === 'none' ? 'none' : 'flex';
  opacityEl.value = tbDraft.bgPatternOpacity;
  opacityEl.oninput = (e) => { tbDraft.bgPatternOpacity = parseFloat(e.target.value); tbPreview(); };
  document.getElementById('tbResetPattern').onclick = () => {
    const d = tbDefaults();
    tbDraft.bgPattern = d.bgPattern; tbDraft.bgPatternOpacity = d.bgPatternOpacity;
    renderPatternGrid();
    opacityRow.style.display = tbDraft.bgPattern === 'none' ? 'none' : 'flex';
    opacityEl.value = tbDraft.bgPatternOpacity;
    tbPreview();
    showToast('প্যাটার্ন ডিফল্টে ফেরানো হয়েছে');
  };

  // ---- Decorations (v2: multi-type, hand-placed, draggable) ----
  document.getElementById('tbDecorWrap').innerHTML = tbRenderDecorSection();
  tbWireDecorSection();
  document.getElementById('tbResetDecor').onclick = () => {
    tbDraft.decorations = [];
    tbRenderDecorSection2();
    tbApplyAmbient(tbDraft);
    showToast('সব ডেকোরেশন মুছে ডিফল্টে ফেরানো হয়েছে');
  };

  // ---- Home sections ----
  const homeWrap = document.getElementById('tbHomeChecks');
  const homeMap = { tbHomeAyah:'ayah', tbHomeStreak:'streak', tbHomeLastRead:'lastread', tbHomeQuick:'quicklinks' };
  const renderHomeChecks = () => {
    homeWrap.innerHTML = [
      tbCheckRow('tbHomeAyah', '<i class="fa-solid fa-book-open"></i>', 'আজকের আয়াত কার্ড', 'হোমপেজের উপরে আয়াত কার্ড', tbDraft.homeSections.ayah),
      tbCheckRow('tbHomeStreak', '<i class="fa-solid fa-fire"></i>', 'স্ট্রিক রিং', 'পড়ার ধারাবাহিকতার রিং', tbDraft.homeSections.streak),
      tbCheckRow('tbHomeLastRead', '<i class="fa-solid fa-clock-rotate-left"></i>', 'সর্বশেষ পড়া', '"সর্বশেষ পড়েছিলেন" সারি', tbDraft.homeSections.lastread),
      tbCheckRow('tbHomeQuick', '<i class="fa-solid fa-link"></i>', 'কুইক লিংক', 'কুইক লিংক সারি', tbDraft.homeSections.quicklinks)
    ].join('');
    Object.keys(homeMap).forEach(id => {
      document.getElementById(id).onchange = (e) => { tbDraft.homeSections[homeMap[id]] = e.target.checked; tbPreview(); };
    });
  };
  renderHomeChecks();
  document.getElementById('tbResetHome').onclick = () => {
    tbDraft.homeSections = Object.assign({}, tbDefaults().homeSections);
    renderHomeChecks();
    tbPreview();
    showToast('হোমপেজ সেকশন ডিফল্টে ফেরানো হয়েছে');
  };

  // ---- Audio player look ----
  const playerEnabled = document.getElementById('tbPlayerEnabled');
  const playerOptions = document.getElementById('tbPlayerOptions');
  const renderPlayerOptions = () => {
    if(!tbDraft.player.enabled){ playerOptions.innerHTML = ''; return; }
    playerOptions.innerHTML = `
      <div class="tb-style-grid">
        ${tbVariantCard('classic', tbDraft.player.variant==='classic', 'গ্র্যাডিয়েন্ট', `background:linear-gradient(180deg, ${tbDraft.player.bg1} 0%, ${tbDraft.player.bg2} 100%)`)}
        ${tbVariantCard('flat', tbDraft.player.variant==='flat', 'ফ্ল্যাট', `background:${tbDraft.player.bg1}`)}
        ${tbVariantCard('glass', tbDraft.player.variant==='glass', 'গ্লাস', `background:${tbAlpha(tbDraft.player.bg1,.5)}`)}
      </div>
      <div class="tb-fields">
        ${tbFieldRow('tbPlayerBg1', 'ব্যাকগ্রাউন্ড ১', tbDraft.player.bg1)}
        ${tbDraft.player.variant==='classic' ? tbFieldRow('tbPlayerBg2', 'ব্যাকগ্রাউন্ড ২', tbDraft.player.bg2) : ''}
        ${tbFieldRow('tbPlayerAccent', 'বাটন/অ্যাকসেন্ট রঙ', tbDraft.player.accent)}
        ${tbFieldRow('tbPlayerText', 'লেখার রঙ', tbDraft.player.text)}
      </div>
      <div class="tb-contrast-info">${tbContrastRow('লেখা ↔ ব্যাকগ্রাউন্ড ১', tbDraft.player.text, tbDraft.player.bg1)}</div>`;
    playerOptions.querySelectorAll('.tb-style-card').forEach(card => {
      card.onclick = () => { tbDraft.player.variant = card.getAttribute('data-variant'); renderPlayerOptions(); tbPreview(); };
    });
    const bindColor = (id, key) => { const el = document.getElementById(id); if(el) el.oninput = (e) => { tbDraft.player[key] = e.target.value; tbPreview(); renderPlayerOptions(); }; };
    bindColor('tbPlayerBg1','bg1'); bindColor('tbPlayerBg2','bg2'); bindColor('tbPlayerAccent','accent'); bindColor('tbPlayerText','text');
  };
  playerEnabled.checked = !!tbDraft.player.enabled;
  playerEnabled.onchange = (e) => { tbDraft.player.enabled = e.target.checked; renderPlayerOptions(); tbPreview(); };
  renderPlayerOptions();
  document.getElementById('tbResetPlayer').onclick = () => {
    tbDraft.player = Object.assign({}, tbDefaults().player);
    playerEnabled.checked = !!tbDraft.player.enabled;
    renderPlayerOptions();
    tbPreview();
    showToast('অডিও প্লেয়ার ডিফল্টে ফেরানো হয়েছে');
  };

  // ---- Header + bottom-nav look ----
  const navEnabled = document.getElementById('tbNavEnabled');
  const navOptions = document.getElementById('tbNavOptions');
  const renderNavOptions = () => {
    if(!tbDraft.navHeader.enabled){ navOptions.innerHTML = ''; return; }
    navOptions.innerHTML = `
      <div class="tb-style-grid tb-style-grid-2">
        ${tbVariantCard('solid', tbDraft.navHeader.variant==='solid', 'সলিড', `background:${tbDraft.navHeader.bg}`)}
        ${tbVariantCard('glass', tbDraft.navHeader.variant==='glass', 'গ্লাস', `background:${tbAlpha(tbDraft.navHeader.bg,.68)}`)}
      </div>
      <div class="tb-fields">
        ${tbFieldRow('tbNavBg', 'ব্যাকগ্রাউন্ড', tbDraft.navHeader.bg)}
        ${tbFieldRow('tbNavText', 'লেখা/আইকন রঙ', tbDraft.navHeader.text)}
        ${tbFieldRow('tbNavAccent', 'সক্রিয় (Active) রঙ', tbDraft.navHeader.accent)}
      </div>
      <div class="tb-contrast-info">${tbContrastRow('লেখা ↔ ব্যাকগ্রাউন্ড', tbDraft.navHeader.text, tbDraft.navHeader.bg)}</div>`;
    navOptions.querySelectorAll('.tb-style-card').forEach(card => {
      card.onclick = () => { tbDraft.navHeader.variant = card.getAttribute('data-variant'); renderNavOptions(); tbPreview(); };
    });
    const bindColor = (id, key) => { const el = document.getElementById(id); if(el) el.oninput = (e) => { tbDraft.navHeader[key] = e.target.value; tbPreview(); renderNavOptions(); }; };
    bindColor('tbNavBg','bg'); bindColor('tbNavText','text'); bindColor('tbNavAccent','accent');
  };
  navEnabled.checked = !!tbDraft.navHeader.enabled;
  navEnabled.onchange = (e) => { tbDraft.navHeader.enabled = e.target.checked; renderNavOptions(); tbPreview(); };
  renderNavOptions();
  document.getElementById('tbResetNav').onclick = () => {
    tbDraft.navHeader = Object.assign({}, tbDefaults().navHeader);
    navEnabled.checked = !!tbDraft.navHeader.enabled;
    renderNavOptions();
    tbPreview();
    showToast('হেডার/ন্যাভ ডিফল্টে ফেরানো হয়েছে');
  };

  // ---- Popup / modal look ----
  const modalOptions = document.getElementById('tbModalOptions');
  const TB_MODAL_ANIMS = { none:'কোনোটি না', fade:'ফেড ইন', slide:'নিচ থেকে স্লাইড', scale:'জুম ইন' };
  const renderModalOptions = () => {
    modalOptions.innerHTML = `
      <div class="tb-row">
        <label for="tbModalRadius">পপ-আপের কোণা গোলাকার</label>
        <input type="range" id="tbModalRadius" min="0" max="30" step="1" value="${tbDraft.modal.radius}">
      </div>
      <div class="tb-row">
        <label for="tbModalShadow">ছায়ার গাঢ়ত্ব</label>
        <input type="range" id="tbModalShadow" min="0" max="1" step="0.05" value="${tbDraft.modal.shadowIntensity}">
      </div>
      <div class="tb-section-hint" style="margin-top:6px;">খোলার অ্যানিমেশন</div>
      <div class="tb-anim-grid">
        ${Object.keys(TB_MODAL_ANIMS).map(id => `<button type="button" class="tb-anim-card${tbDraft.modal.anim===id?' active':''}" data-anim="${id}">${TB_MODAL_ANIMS[id]}</button>`).join('')}
      </div>`;
    document.getElementById('tbModalRadius').oninput = (e) => { tbDraft.modal.radius = parseInt(e.target.value,10); tbPreview(); };
    document.getElementById('tbModalShadow').oninput = (e) => { tbDraft.modal.shadowIntensity = parseFloat(e.target.value); tbPreview(); };
    modalOptions.querySelectorAll('.tb-anim-card').forEach(btn => {
      btn.onclick = () => { tbDraft.modal.anim = btn.getAttribute('data-anim'); renderModalOptions(); tbPreview(); };
    });
  };
  renderModalOptions();
  document.getElementById('tbResetModal').onclick = () => {
    tbDraft.modal = Object.assign({}, tbDefaults().modal);
    renderModalOptions();
    tbPreview();
    showToast('পপ-আপ ডিজাইন ডিফল্টে ফেরানো হয়েছে');
  };

  tbPreview();
  openModal('themeBuilderModal');
}
