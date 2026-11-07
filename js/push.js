// ---------- Prayer time push notifications (works even when app is closed) ----------
// Requires: firebase-messaging-compat.js loaded in index.html, and a VAPID key
// from Firebase Console → Project settings → Cloud Messaging → Web Push certificates.
const VAPID_KEY = 'BDxBLc82EJWCGIWR8J5FXW_2ZZZSjIkBm40jssD4ZootWBlLSVmA7qBDohyMHRQgdq3CyDl6yZbXMPh54OjZzrM';

function getDeviceId(){
  let id = IDBKV.get('qr_device_id');
  if(!id){
    id = (crypto.randomUUID ? crypto.randomUUID() : 'dev-' + Date.now() + '-' + Math.random().toString(16).slice(2));
    IDBKV.set('qr_device_id', id);
  }
  return id;
}

function getMessagingSafe(){
  try{
    if(typeof firebase === 'undefined' || !firebase.messaging) return null;
    if(firebase.messaging.isSupported && !firebase.messaging.isSupported()) return null;
    return firebase.messaging();
  }catch(e){ return null; }
}

async function savePushSubscription(token){
  if(!state.prayerLocation || typeof fbDb === 'undefined' || !fbDb) return;
  try{
    await fbDb.collection('push_subscriptions').doc(getDeviceId()).set({
      token,
      lat: state.prayerLocation.lat,
      lon: state.prayerLocation.lon,
      method: state.prayerMethod,
      updatedAt: new Date().toISOString()
    }, { merge: true });
  }catch(e){ console.error('push subscription save failed', e); }
}

// Called when the user turns the "prayer notifications" toggle ON.
// Returns true on success, false if it could not be enabled.
async function enablePrayerPush(){
  if(!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  const messaging = getMessagingSafe();
  if(!messaging) return false;
  try{
    const reg = await navigator.serviceWorker.ready; // sw.js is already registered by initServiceWorker()
    const token = await messaging.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    if(!token) return false;
    await savePushSubscription(token);
    return true;
  }catch(e){
    console.error('enablePrayerPush failed', e);
    return false;
  }
}

// Called when the toggle is turned OFF — stops future server-sent pushes.
async function disablePrayerPush(){
  try{
    if(typeof fbDb !== 'undefined' && fbDb){
      await fbDb.collection('push_subscriptions').doc(getDeviceId()).delete();
    }
  }catch(e){}
}

// Called whenever the prayer location or calculation method changes, so the
// server-side script always checks the right place/method for this device.
function updatePushLocationIfSubscribed(){
  if(!state.prayerNotify) return;
  const messaging = getMessagingSafe();
  if(!messaging) return;
  messaging.getToken({ vapidKey: VAPID_KEY }).then((token) => {
    if(token) savePushSubscription(token);
  }).catch(() => {});
}

// Foreground messages (app open + tab focused): FCM does not auto-show a
// notification in this case, so show one manually.
function initForegroundPush(){
  const messaging = getMessagingSafe();
  if(!messaging) return;
  messaging.onMessage((payload) => {
    const title = (payload.notification && payload.notification.title) || 'নামাজের সময়';
    const body = (payload.notification && payload.notification.body) || 'নামাজের জন্য প্রস্তুত হোন।';
    if('Notification' in window && Notification.permission === 'granted'){
      new Notification(title, { body, icon: 'icons/icon-192.png' });
    }
  });
}
