// ---------- Topic-based verse browsing ----------
// This is a starter, hand-picked dataset (a handful of well-known references
// per topic) rather than a full topic-tagged index of all 6,236 ayahs —
// building/verifying a complete tagging set is a much bigger project on its
// own. Each topic can be expanded with more refs over time; the UI and data
// shape already support any number of entries per topic.

// Clean line-style SVG icons (stroke-based, matches modern minimal list UI)
const TOPIC_ICON_SVGS = {
  allah: '<path d="M12 3a9 9 0 1 0 8.9 10.4A6.5 6.5 0 0 1 12 3z"/><path d="M18 3.2l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1z"/>',
  aqidah: '<path d="M12 3l1.3 3.4L16.7 7.7l-3.4 1.3L12 12.4l-1.3-3.4L7.3 7.7l3.4-1.3L12 3z"/><path d="M18.2 14l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6.6-1.6z"/>',
  ibadah: '<circle cx="9" cy="12" r="5"/><circle cx="15" cy="12" r="5"/>',
  akhirah: '<circle cx="12" cy="4" r="1"/><path d="M4 10l8-5.2 8 5.2"/><path d="M4 21h16"/><path d="M6.5 21V10.5M10.5 21V10.5M13.5 21V10.5M17.5 21V10.5"/>',
  etiquette: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.8v4.4l3 2"/>',
  history: '<path d="M6.5 3h11"/><path d="M6.5 21h11"/><path d="M7.5 3c0 4.6 3.3 6.1 4.5 9-1.2 2.9-4.5 4.4-4.5 9"/><path d="M16.5 3c0 4.6-3.3 6.1-4.5 9 1.2 2.9 4.5 4.4 4.5 9"/>',
  muamalat: '<path d="M12 3v18"/><path d="M7.5 21h9"/><path d="M4.5 7h15"/><path d="M4.5 7l-2.3 5.2a2.7 2.7 0 0 0 4.6 0L4.5 7z"/><path d="M19.5 7l-2.3 5.2a2.7 2.7 0 0 0 4.6 0L19.5 7z"/>',
  family: '<circle cx="9" cy="8.3" r="3"/><path d="M4 20.2c0-3.2 2.2-4.9 5-4.9s5 1.7 5 4.9"/><circle cx="17" cy="9.3" r="2.2"/><path d="M15.6 13.4c2 .3 3.4 1.7 3.4 4.2"/>',
  politics: '<path d="M6 21V4"/><path d="M6 4.2h11l-2 3.6 2 3.6H6"/>',
  emotions: '<circle cx="12" cy="12" r="9"/><path d="M12 16.2s-3.8-2.3-3.8-5.2A2.3 2.3 0 0 1 12 9.4a2.3 2.3 0 0 1 3.8 1.6c0 2.9-3.8 5.2-3.8 5.2z"/>'
};
function topicIconSvg(id){
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${TOPIC_ICON_SVGS[id]||''}</svg>`;
}

const TOPICS = [
  { id:'allah', label:'Allah', labelBn:'আল্লাহ', refs:[
    {s:2,a:255,note:'আয়াতুল কুরসী'}, {s:112,a:1,note:'আল-ইখলাস'}, {s:59,a:22,note:'সবচেয়ে সুন্দর নামসমূহ'}, {s:2,a:186,note:'নিকটবর্তী'}
  ]},
  { id:'aqidah', label:"Aqidah (Belief)", labelBn:'আকীদাহ (বিশ্বাস)', refs:[
    {s:2,a:1,note:'গায়েবের প্রতি বিশ্বাস'}, {s:4,a:136,note:'ঈমানের রুকনসমূহ'}, {s:112,a:1,note:'তাওহীদ'}
  ]},
  { id:'ibadah', label:'Ibadah (worship of Allah)', labelBn:'ইবাদাহ (আল্লাহর উপাসনা)', refs:[
    {s:51,a:56,note:'সৃষ্টির উদ্দেশ্য'}, {s:2,a:43,note:'সালাত ও যাকাত'}, {s:2,a:183,note:'সিয়াম'}
  ]},
  { id:'akhirah', label:'Akhirah (Afterlife)', labelBn:'আখিরাহ (পরকাল)', refs:[
    {s:99,a:7,note:'অণু পরিমাণ কর্মও দেখা যাবে'}, {s:75,a:1,note:'কিয়ামতের কসম'}, {s:21,a:47,note:'ন্যায়বিচারের মানদণ্ড'}
  ]},
  { id:'etiquette', label:'Etiquette and manners', labelBn:'শিষ্টাচার ও আদব', refs:[
    {s:49,a:11,note:'উপহাস না করা'}, {s:17,a:23,note:'পিতামাতার সাথে সদাচরণ'}, {s:31,a:19,note:'নম্র কণ্ঠস্বর'}
  ]},
  { id:'history', label:'History & Biographies', labelBn:'ইতিহাস ও জীবনী', refs:[
    {s:12,a:3,note:'সূরা ইউসুফ'}, {s:18,a:9,note:'আসহাবে কাহফ'}, {s:28,a:3,note:'মূসা (আঃ)-এর কাহিনী'}
  ]},
  { id:'muamalat', label:"Mu'amalat (dealings)", labelBn:'মুআমালাত (লেনদেন)', refs:[
    {s:2,a:282,note:'ঋণ লিখে রাখা'}, {s:2,a:275,note:'সুদ হারাম'}, {s:4,a:29,note:'পারস্পরিক সম্মতিতে ব্যবসা'}
  ]},
  { id:'family', label:'Family', labelBn:'পরিবার', refs:[
    {s:30,a:21,note:'দাম্পত্য জীবনে প্রশান্তি'}, {s:4,a:1,note:'একই সত্তা থেকে সৃষ্টি'}, {s:17,a:23,note:'পিতামাতার হক'}
  ]},
  { id:'politics', label:'Politics', labelBn:'রাজনীতি', refs:[
    {s:4,a:58,note:'আমানত ও ন্যায়বিচার'}, {s:4,a:59,note:'কর্তৃপক্ষের আনুগত্য'}, {s:42,a:38,note:'পরামর্শ (শূরা)'}
  ]},
  { id:'emotions', label:'Emotions', labelBn:'অনুভূতি', refs:[
    {s:94,a:5,note:'কষ্টের সাথে স্বস্তি'}, {s:13,a:28,note:'আল্লাহর স্মরণে প্রশান্তি'}, {s:2,a:286,note:'সাধ্যের অতিরিক্ত বোঝা নয়'}
  ]}
];

function renderTopicsList(){
  const listEl = document.getElementById('topicsListContainer');
  const detailEl = document.getElementById('topicDetailContainer');
  detailEl.style.display = 'none';
  listEl.style.display = 'block';
  listEl.innerHTML = '';
  TOPICS.forEach(t => {
    const item = document.createElement('div');
    item.className = 'topic-item';
    item.innerHTML = `<div class="topic-icon-box">${topicIconSvg(t.id)}</div>
      <div class="li-text">
        <div class="li-title">${t.labelBn}</div>
        <div class="topic-sub-en">${t.label}</div>
      </div>
      <svg class="topic-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`;
    item.onclick = () => openTopic(t.id);
    listEl.appendChild(item);
  });
}

function openTopic(id){
  const topic = TOPICS.find(t => t.id === id);
  if(!topic) return;
  trackTopicExplored(id);
  const listEl = document.getElementById('topicsListContainer');
  const detailEl = document.getElementById('topicDetailContainer');
  const body = document.getElementById('topicDetailBody');
  listEl.style.display = 'none';
  detailEl.style.display = 'block';
  body.innerHTML = `<div class="topic-detail-head">
      <div class="topic-icon-box topic-icon-box-lg">${topicIconSvg(topic.id)}</div>
      <div>
        <h2 class="topic-detail-title">${topic.labelBn}</h2>
        <div class="topic-sub-en topic-detail-sub">${topic.label}</div>
      </div>
    </div>`;
  topic.refs.forEach(r => {
    const surahName = surahNamesBn[r.s-1] || ('সূরা ' + r.s);
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `<div class="badge-num">${toBn(r.s)}:${toBn(r.a)}</div>
      <div class="li-text">
        <div class="li-title">${surahName} — আয়াত ${toBn(r.a)}</div>
        <div class="li-sub">${r.note}</div>
      </div>`;
    item.onclick = () => openSurahAndScrollTo(r.s, r.a);
    body.appendChild(item);
  });
}

function initTopics(){
  document.getElementById('topicBackBtn').onclick = () => {
    document.getElementById('topicDetailContainer').style.display = 'none';
    document.getElementById('topicsListContainer').style.display = 'block';
  };
}
