// ---------- Qibla direction (compass bearing to the Kaaba) ----------
const KAABA_LAT = 21.4225241;
const KAABA_LNG = 39.8261818;

function computeQiblaBearing(lat, lon){
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const phi1 = toRad(lat), phi2 = toRad(KAABA_LAT);
  const dLambda = toRad(KAABA_LNG - lon);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

let qiblaBearing = null;
let qiblaOrientationHandler = null;
let qiblaUsingAbsolute = false;
let qiblaSmoothedHeading = null;
let qiblaAppliedRotation = 0;
let qiblaRotationInit = false;
let qiblaFallbackTimer = null;

function initQiblaModal(){
  wireModalBackdrop('qiblaModal');
  document.getElementById('qiblaClose').onclick = () => { closeModal('qiblaModal'); stopQiblaCompass(); };
}

function openQiblaModal(){
  openModal('qiblaModal');
  if(typeof onbMaybeStart === 'function') onbMaybeStart('qibla');
  const body = document.getElementById('qiblaBody');
  if(state.prayerLocation){
    setupQibla(state.prayerLocation);
    return;
  }
  if(!('geolocation' in navigator)){
    body.innerHTML = `<div class="prayer-error">এই ব্রাউজারে অবস্থান শনাক্তকরণ সমর্থিত নয়।</div>`;
    return;
  }
  body.innerHTML = `<div class="prayer-status"><i class="fa-solid fa-location-crosshairs"></i> অবস্থান শনাক্ত করা হচ্ছে...</div>`;
  navigator.geolocation.getCurrentPosition(
    (pos) => setupQibla({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
    () => {
      body.innerHTML = `<div class="prayer-error">অবস্থানের অনুমতি পাওয়া যায়নি। ব্রাউজারের সেটিংস থেকে লোকেশন অনুমতি দিন, অথবা আগে "সালাতের সময়সূচি"-তে শহর সেট করুন।</div>`;
    },
    { timeout: 10000 }
  );
}

function setupQibla(loc){
  qiblaBearing = computeQiblaBearing(loc.lat, loc.lon);
  markQiblaUsed();
  const body = document.getElementById('qiblaBody');
  body.innerHTML = `
    <div class="qibla-wrap">
      <div class="qibla-compass" id="qiblaCompass">
        <div class="qibla-ring">
          <span class="qibla-tick qibla-tick-n">N</span>
          <span class="qibla-tick qibla-tick-e">E</span>
          <span class="qibla-tick qibla-tick-s">S</span>
          <span class="qibla-tick qibla-tick-w">W</span>
        </div>
        <div class="qibla-needle" id="qiblaNeedle"><i class="fa-solid fa-kaaba"></i></div>
      </div>
      <div class="qibla-deg">কিবলা: ${toBn(Math.round(qiblaBearing))}° (উত্তর থেকে)</div>
      <div class="qibla-hint" id="qiblaHint">ফোনটি সমতলভাবে ধরে ঘুরুন — উপরের কাবা আইকনটি যেদিকে স্থির থাকবে, সেদিকেই কিবলা।</div>
      <button class="settings-btn" id="qiblaEnableCompassBtn"><i class="fa-solid fa-compass"></i> কম্পাস চালু করুন</button>
    </div>`;
  const btn = document.getElementById('qiblaEnableCompassBtn');
  if(btn) btn.onclick = enableQiblaCompass;
}

function enableQiblaCompass(){
  if(typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function'){
    DeviceOrientationEvent.requestPermission().then(res => {
      if(res === 'granted') startQiblaCompass();
      else showToast('কম্পাস ব্যবহারের অনুমতি পাওয়া যায়নি');
    }).catch(() => showToast('এই ডিভাইসে কম্পাস চালু করা যায়নি'));
  } else if('DeviceOrientationEvent' in window){
    startQiblaCompass();
  } else {
    showToast('এই ডিভাইস/ব্রাউজারে কম্পাস সমর্থিত নয়');
  }
}

function getScreenAngle(){
  if(screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  if(typeof window.orientation === 'number') return window.orientation;
  return 0;
}

// shortest angular difference, result in (-180, 180]
function angleDiff(a, b){
  return ((a - b + 540) % 360) - 180;
}

function applyNeedleRotation(rawTargetDeg){
  const needle = document.getElementById('qiblaNeedle');
  if(!needle) return;
  if(!qiblaRotationInit){
    qiblaAppliedRotation = rawTargetDeg;
    qiblaRotationInit = true;
  } else {
    const delta = angleDiff(rawTargetDeg, qiblaAppliedRotation % 360);
    qiblaAppliedRotation += delta;
  }
  needle.style.transform = `translate(-50%,-100%) rotate(${qiblaAppliedRotation}deg)`;
}

function startQiblaCompass(){
  if(qiblaOrientationHandler) return;
  const btn = document.getElementById('qiblaEnableCompassBtn');
  if(btn) btn.style.display = 'none';

  qiblaUsingAbsolute = false;
  qiblaSmoothedHeading = null;
  qiblaRotationInit = false;

  const setHint = (msg) => {
    const hint = document.getElementById('qiblaHint');
    if(hint) hint.textContent = msg;
  };

  qiblaOrientationHandler = (e) => {
    let heading = null;
    let isAbsolute = false;

    if(typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)){
      // iOS: already a true compass heading
      heading = e.webkitCompassHeading;
      isAbsolute = true;
      if(typeof e.webkitCompassAccuracy === 'number' && (e.webkitCompassAccuracy < 0 || e.webkitCompassAccuracy > 30)){
        setHint('কম্পাস সঠিকভাবে ক্যালিব্রেট নেই — ফোনটি ৮-আকৃতিতে কয়েকবার ঘোরান।');
      }
    } else if(e.absolute === true && e.alpha != null){
      heading = 360 - e.alpha;
      isAbsolute = true;
    } else if(e.alpha != null && !qiblaUsingAbsolute){
      // relative fallback only — used until/unless an absolute source shows up
      heading = 360 - e.alpha;
      isAbsolute = false;
    } else {
      return;
    }

    // once we get a real absolute heading, stop listening to relative noise
    if(qiblaUsingAbsolute && !isAbsolute) return;
    if(isAbsolute){
      if(qiblaFallbackTimer){ clearTimeout(qiblaFallbackTimer); qiblaFallbackTimer = null; }
      if(!qiblaUsingAbsolute) setHint('কাবা আইকনটি যেদিকে নির্দেশ করছে, সেদিকেই কিবলা।');
      qiblaUsingAbsolute = true;
    }

    // compensate for device rotation (landscape/portrait) so the needle stays correct
    heading = (heading + getScreenAngle() + 360) % 360;

    // circular smoothing (low-pass filter) to kill sensor jitter
    if(qiblaSmoothedHeading == null){
      qiblaSmoothedHeading = heading;
    } else {
      const diff = angleDiff(heading, qiblaSmoothedHeading);
      qiblaSmoothedHeading = (qiblaSmoothedHeading + diff * 0.15 + 360) % 360;
    }

    if(qiblaBearing != null){
      const target = (qiblaBearing - qiblaSmoothedHeading + 360) % 360;
      applyNeedleRotation(target);
    }
  };

  window.addEventListener('deviceorientationabsolute', qiblaOrientationHandler, true);
  window.addEventListener('deviceorientation', qiblaOrientationHandler, true);

  // if no absolute heading arrives quickly, warn the user the reading may drift
  qiblaFallbackTimer = setTimeout(() => {
    if(!qiblaUsingAbsolute){
      setHint('এই ডিভাইসে সঠিক কম্পাস সেন্সর সীমিত, তাই দিক কিছুটা ভুল হতে পারে। ফোনটি ৮-আকৃতিতে ঘুরিয়ে ক্যালিব্রেট করুন।');
    }
  }, 2500);
}

function stopQiblaCompass(){
  if(qiblaFallbackTimer){ clearTimeout(qiblaFallbackTimer); qiblaFallbackTimer = null; }
  if(!qiblaOrientationHandler) return;
  window.removeEventListener('deviceorientationabsolute', qiblaOrientationHandler, true);
  window.removeEventListener('deviceorientation', qiblaOrientationHandler, true);
  qiblaOrientationHandler = null;
  qiblaUsingAbsolute = false;
  qiblaSmoothedHeading = null;
  qiblaRotationInit = false;
}
