// ---------- Android app UI · shared pickers ----------
// Reciter, translation, comparison translations, interface language, prayer
// method and colour mode. Used by the reader's settings sheet, the audio player
// and the More > Settings screens, so there is exactly one implementation of each.
// All of them write through the website's own state + save*() helpers, so the
// choice is shared with the website's data model.
(function(){
  'use strict';
  var QRApp = window.QRApp;
  var UI = QRApp.ui, h = QRApp.h, icon = QRApp.icon, T = QRApp.T;
  var pick = QRApp.pick = {};

  function safe(fn){ try{ return fn(); }catch(e){ QRApp.warn(e); } }

  // ---------- reciter ----------
  // The reciter list is the website's (Bangla name, English name, and a Bangla-only style note). With the English
  // interface the English name is shown and the Bangla-only note is left out, so no Bangla text leaks into English.
  pick.reciterLabel = function(id){
    var r = (typeof reciters !== 'undefined') && reciters.find(function(x){ return x.id === (id || state.reciter); });
    if(!r) return id || state.reciter;
    return QRApp.isBn() ? r.bn : (r.name || r.bn);
  };
  pick.reciter = function(){
    var bn = QRApp.isBn();
    var opts = reciters.map(function(r){
      return { id: r.id, label: bn ? (r.bn + ' — ' + r.name) : (r.name || r.bn), sub: bn ? (r.style || '') : '', leading: r.flag || '🎙️' };
    });
    return UI.choiceSheet({
      title: T('ক্বারী নির্বাচন', 'Choose reciter'),
      options: opts, selected: state.reciter, searchable: true
    }).then(function(id){
      if(!id || id === state.reciter) return id;
      state.reciter = id;
      safe(saveReciter);
      safe(function(){ if(typeof updateReciterLabels === 'function') updateReciterLabels(); });
      // switch the voice of what is playing right now, like the website does
      safe(function(){ if(state.playIndex >= 0 && state.isPlaying) playAtIndex(state.playIndex, true); });
      QRApp.emit('reciter', id);
      return id;
    });
  };

  // ---------- translation (primary) ----------
  pick.translationLabel = function(){
    try{ return translationEditionLabel(state.translationEdition); }catch(e){ return state.translationEdition; }
  };
  function editionOptions(editions){
    return editions.map(function(e){
      var lang = e.language ? languageDisplayName(e.language) : '';
      return { id: e.identifier, label: (e.name || e.englishName) + (lang ? ' — ' + lang : ''), sub: e.identifier };
    }).sort(function(a, b){ return a.label.localeCompare(b.label); });
  }
  pick.translation = function(){
    return loadTranslationEditions().then(function(editions){
      if(!editions || !editions.length){
        UI.snack(T('অনুবাদের তালিকা লোড করা যায়নি — ইন্টারনেট সংযোগ দেখুন', 'Could not load the translation list — check your connection'));
        return null;
      }
      return UI.choiceSheet({
        title: T('অনুবাদের ভাষা', 'Translation'),
        options: editionOptions(editions), selected: state.translationEdition, searchable: true
      }).then(function(id){
        if(!id || id === state.translationEdition) return id;
        state.translationEdition = id;
        safe(saveTranslationEdition);
        QRApp.emit('translation', id);
        if(QRApp.reader) QRApp.reader.reload();
        return id;
      });
    });
  };

  // ---------- compare up to three translations ----------
  pick.compareLabel = function(){
    var n = (state.translationEditions || []).length;
    return n ? T(QRApp.N(n) + 'টি নির্বাচিত', n + ' selected') : T('বন্ধ', 'Off');
  };
  pick.compare = function(){
    return loadTranslationEditions().then(function(editions){
      if(!editions || !editions.length){
        UI.snack(T('অনুবাদের তালিকা লোড করা যায়নি — ইন্টারনেট সংযোগ দেখুন', 'Could not load the translation list — check your connection'));
        return;
      }
      var chosen = (state.translationEditions || []).slice();
      var changed = false;
      var all = editionOptions(editions);
      var wrap = h('div', { class: 'qa-stack', style: { gap: '10px' } });
      var hint = h('p', { class: 'qa-sheet-sub', style: { margin: 0 } });
      var input = h('input', { class: 'qa-input', type: 'search', placeholder: T('ভাষা বা অনুবাদক খুঁজুন…', 'Search language or translator…'), autocomplete: 'off' });
      var list = h('div', { class: 'qa-group' });
      wrap.appendChild(hint); wrap.appendChild(input); wrap.appendChild(list);
      function updateHint(){
        hint.textContent = chosen.length
          ? T(QRApp.N(chosen.length) + '/৩ নির্বাচিত — বন্ধ করলে প্রয়োগ হবে', chosen.length + '/3 selected — applied when you close')
          : T('সর্বোচ্চ ৩টি অনুবাদ পাশাপাশি দেখতে পারবেন। কিছু না বাছলে প্রধান অনুবাদই দেখাবে।', 'Pick up to 3 translations to show side by side. With none selected the main translation is used.');
      }
      function render(q){
        list.innerHTML = '';
        var qq = (q || '').trim().toLowerCase();
        all.filter(function(o){ return !qq || o.label.toLowerCase().indexOf(qq) > -1; }).forEach(function(o){
          var on = chosen.indexOf(o.id) > -1;
          var row = UI.row({
            title: o.label, sub: o.sub, chevron: false,
            trail: on ? h('span', { html: icon('check') }) : null,
            onClick: function(){
              var i = chosen.indexOf(o.id);
              if(i > -1) chosen.splice(i, 1);
              else {
                if(chosen.length >= 3){ UI.snack(T('সর্বোচ্চ ৩টি অনুবাদ বাছা যাবে', 'You can pick at most 3')); return; }
                chosen.push(o.id);
              }
              changed = true; updateHint(); render(input.value);
            }
          });
          if(on) row.style.color = 'var(--qa-primary)';
          list.appendChild(row);
        });
        if(!list.childNodes.length) list.appendChild(h('div', { class: 'qa-state-text', style: { padding: '20px', textAlign: 'center' } }, T('কিছু পাওয়া যায়নি', 'Nothing found')));
      }
      input.addEventListener('input', function(){ render(input.value); });
      updateHint(); render('');
      UI.sheet({
        title: T('তুলনামূলক অনুবাদ', 'Compare translations'), body: wrap,
        onClose: function(){
          if(!changed) return;
          state.translationEditions = chosen;
          safe(saveTranslationEditionsSelected);
          if(chosen.length >= 2) safe(markCompareUsed);
          QRApp.emit('translation', chosen);
          if(QRApp.reader) QRApp.reader.reload();
        }
      });
    });
  };

  // ---------- interface language ----------
  pick.languageLabel = function(){
    var m = UI_LANG_META.find(function(x){ return x.code === state.language; });
    return m ? m.label : state.language;
  };
  pick.language = function(){
    return UI.choiceSheet({
      title: T('অ্যাপের ভাষা', 'App language'),
      sub: T('বাংলা ও ইংরেজিতে সম্পূর্ণ অ্যাপ দেখা যায়। অন্য ভাষায় ওয়েবের ফিচারগুলো অনূদিত থাকে।', 'The full app is available in Bangla and English. In other languages the website features are translated.'),
      options: UI_LANG_META.map(function(m){ return { id: m.code, label: m.label }; }),
      selected: state.language, searchable: false
    }).then(function(code){
      if(!code || code === state.language) return code;
      safe(function(){ applyLanguage(code); });
      // the app keeps a left-to-right layout; Arabic / Urdu text itself still renders right-to-left
      document.documentElement.dir = 'ltr';
      QRApp.emit('language', code);
      if(QRApp.nav && QRApp.nav.relocalize) QRApp.nav.relocalize();
      return code;
    });
  };

  // ---------- prayer calculation method ----------
  // the website lists some calculation methods by their Bangla name only: the English interface shows the usual English names
  var METHOD_EN = {
    1: 'University of Islamic Sciences, Karachi', 2: 'ISNA (North America)', 3: 'Muslim World League', 4: 'Umm al-Qura, Makkah',
    5: 'Egyptian General Authority of Survey', 8: 'Gulf Region', 13: 'Diyanet, Turkey', 20: 'KEMENAG, Indonesia'
  };
  function methodName(m){ return QRApp.isBn() ? m.name : (METHOD_EN[m.id] || m.name); }
  pick.prayerMethodLabel = function(){
    var m = PRAYER_METHODS.find(function(x){ return x.id === state.prayerMethod; });
    return m ? methodName(m) : String(state.prayerMethod);
  };
  pick.prayerMethod = function(){
    return UI.choiceSheet({
      title: T('নামাজের সময় গণনার পদ্ধতি', 'Prayer time method'),
      options: PRAYER_METHODS.map(function(m){ return { id: String(m.id), label: methodName(m) }; }),
      selected: String(state.prayerMethod)
    }).then(function(id){
      if(id == null) return id;
      var n = parseInt(id, 10);
      if(n === state.prayerMethod) return id;
      state.prayerMethod = n;
      safe(savePrayerMethod);
      safe(function(){ updatePushLocationIfSubscribed(); });
      QRApp.emit('prayer-method', n);
      return id;
    });
  };

  // ---------- colour mode ----------
  pick.themeLabel = function(){
    var p = QRApp.theme.pref();
    return p === 'light' ? T('লাইট', 'Light') : p === 'dark' ? T('ডার্ক', 'Dark') : T('সিস্টেম অনুযায়ী', 'System default');
  };
  pick.theme = function(){
    return UI.choiceSheet({
      title: T('থিম', 'Theme'),
      options: [
        { id: 'system', label: T('সিস্টেম অনুযায়ী', 'System default'), sub: T('ফোনের সেটিং অনুযায়ী লাইট/ডার্ক', 'Follows your phone setting') },
        { id: 'light', label: T('লাইট', 'Light') },
        { id: 'dark', label: T('ডার্ক', 'Dark') }
      ],
      selected: QRApp.theme.pref()
    }).then(function(id){
      if(id && id !== QRApp.theme.pref()) QRApp.theme.set(id);
      return id;
    });
  };
})();
