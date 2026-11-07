// ---------- Public policy pages (privacy.html · terms.html · account-deletion.html) ----------
// 1) Language switch. Both languages are in the HTML (so search engines and reviewers see everything); with
//    JavaScript only one is shown at a time. Order of preference: ?lang=bn|en, the last choice, the browser language.
// 2) Contact details come from app-config.js (supportEmail / developerName) so they are entered in ONE place.
//    Values are only ever written with textContent / setAttribute (never as HTML).
(function(){
  'use strict';
  var html = document.documentElement;
  html.classList.add('js');

  function storage(op, key, val){
    try{ return op === 'get' ? window.localStorage.getItem(key) : window.localStorage.setItem(key, val); }catch(e){ return null; }
  }
  function initialLang(){
    var m = /(?:^|[?&])lang=(bn|en)(?:&|$)/.exec(window.location.search || '');
    if(m) return m[1];
    var saved = storage('get', 'qb_legal_lang');
    if(saved === 'bn' || saved === 'en') return saved;
    return /^bn/i.test(navigator.language || '') ? 'bn' : 'en';
  }
  function setLang(lang){
    html.setAttribute('data-show', lang);
    html.setAttribute('lang', lang);
    var buttons = document.querySelectorAll('[data-set-lang]');
    for(var i = 0; i < buttons.length; i++){
      buttons[i].setAttribute('aria-pressed', buttons[i].getAttribute('data-set-lang') === lang ? 'true' : 'false');
    }
    var title = document.documentElement.getAttribute('data-title-' + lang);
    if(title) document.title = title;
    storage('set', 'qb_legal_lang', lang);
  }
  var buttons = document.querySelectorAll('[data-set-lang]');
  for(var i = 0; i < buttons.length; i++){
    buttons[i].addEventListener('click', function(ev){ setLang(ev.currentTarget.getAttribute('data-set-lang')); });
  }
  setLang(initialLang());

  // ---------- contact details ----------
  var cfg = window.QR_APP_CONFIG || {};
  var email = (typeof cfg.supportEmail === 'string') ? cfg.supportEmail.trim() : '';
  var validEmail = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email);
  var dev = (typeof cfg.developerName === 'string') ? cfg.developerName.trim() : '';

  var withMail = document.querySelectorAll('[data-when-email]');
  var withoutMail = document.querySelectorAll('[data-when-no-email]');
  for(var a = 0; a < withMail.length; a++) withMail[a].hidden = !validEmail;
  for(var b = 0; b < withoutMail.length; b++) withoutMail[b].hidden = validEmail;

  var links = document.querySelectorAll('a[data-email-link]');
  for(var c = 0; c < links.length; c++){
    if(!validEmail) continue;
    var subject = links[c].getAttribute('data-subject') || '';
    links[c].setAttribute('href', 'mailto:' + email + (subject ? '?subject=' + encodeURIComponent(subject) : ''));
    links[c].textContent = email;
  }
  var devNodes = document.querySelectorAll('[data-developer]');
  for(var d = 0; d < devNodes.length; d++){
    if(dev){ devNodes[d].textContent = dev; devNodes[d].hidden = false; }
    else devNodes[d].hidden = true;
  }
  var devLines = document.querySelectorAll('[data-when-developer]');
  for(var e = 0; e < devLines.length; e++) devLines[e].hidden = !dev;
})();
