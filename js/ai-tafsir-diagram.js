// js/ai-tafsir-diagram.js
// ============================================================
// AI তাফসীর — ডায়াগ্রাম রেন্ডারার (js/ai-tafsir.js এর সহযোগী ফাইল)
// ============================================================
// api/ai-tafsir.js এখন উত্তরের পাশাপাশি (প্রাসঙ্গিক হলে) একটা structured
// "diagram" অবজেক্টও পাঠায় — এই ফাইল সেটাকে সম্পূর্ণ pure JS দিয়ে DOM
// নোডে রূপান্তর করে। js/ai-tafsir.js এর appendAiTafsirBubble() এটা
// bubble এর ঠিক নিচে বসায়। কোনো এক্সটার্নাল চার্ট/ডায়াগ্রাম লাইব্রেরি
// ব্যবহার করা হয়নি — শুধু DOM + css/ai-tafsir-diagram.css।
//
// নিরাপত্তা: সব টেক্সট .textContent দিয়ে বসানো হয় (innerHTML কোথাও না) —
// তাই AI থেকে আসা টেক্সটে ভুলবশত HTML/স্ক্রিপ্ট থাকলেও তা কখনো এক্সিকিউট
// হবে না।
//
// diagram অবজেক্টের গঠন (api/ai-tafsir.js এর RESPONSE_SCHEMA এর সাথে মিলিয়ে):
//   {
//     type: 'timeline' | 'tree' | 'compare' | 'steps' | 'list',
//     title: string,
//     columns?: [string, string],   // শুধু compare-এ (বাম/ডান শিরোনাম)
//     items: [{ label, desc?, left?, right?, sub?:[string] }]
//   }
// ============================================================

const AIT_DIAGRAM_ICONS = {
  timeline: 'fa-clock-rotate-left',
  tree: 'fa-sitemap',
  compare: 'fa-scale-balanced',
  steps: 'fa-list-ol',
  list: 'fa-list',
};

// ছোট্ট হেল্পার — element বানিয়ে class+textContent বসিয়ে দেয়, innerHTML কখনো না
function aitEl(tag, className, text){
  const el = document.createElement(tag);
  if(className) el.className = className;
  if(text !== undefined && text !== null && text !== '') el.textContent = text;
  return el;
}

// এন্ট্রি পয়েন্ট — js/ai-tafsir.js এর appendAiTafsirBubble() থেকে ডাকা হয়।
// অচেনা type বা খালি items পেলে null ফেরত দেয় (caller null চেক করেই বসায়)।
function renderAiTafsirDiagram(diagram){
  if(!diagram || typeof diagram !== 'object') return null;
  const items = Array.isArray(diagram.items) ? diagram.items.filter(it => it && it.label) : [];
  if(!items.length) return null;

  const builders = {
    timeline: aitBuildTimeline,
    tree: aitBuildTree,
    compare: aitBuildCompare,
    steps: aitBuildSteps,
    list: aitBuildList,
  };
  const build = builders[diagram.type];
  if(!build) return null;

  const wrap = aitEl('div', 'ait-diagram ait-diagram-' + diagram.type);

  const head = aitEl('div', 'ait-diagram-head');
  const icon = document.createElement('i');
  icon.className = 'fa-solid ' + AIT_DIAGRAM_ICONS[diagram.type];
  icon.setAttribute('aria-hidden', 'true');
  head.appendChild(icon);
  head.appendChild(aitEl('span', null, diagram.title || ''));
  wrap.appendChild(head);

  wrap.appendChild(build(items, diagram.columns));
  return wrap;
}

// ঐতিহাসিক ঘটনাক্রম / নাযিলের প্রেক্ষাপট — উপর-নিচে সংযুক্ত ডট-লাইন টাইমলাইন
function aitBuildTimeline(items){
  const list = aitEl('div', 'ait-tl');
  items.forEach(it => {
    const row = aitEl('div', 'ait-tl-item');
    const bodyEl = aitEl('div', 'ait-tl-body');
    bodyEl.appendChild(aitEl('div', 'ait-tl-label', it.label));
    if(it.desc) bodyEl.appendChild(aitEl('div', 'ait-tl-desc', it.desc));
    row.appendChild(bodyEl);
    list.appendChild(row);
  });
  return list;
}

// ইবাদত/আমলের ধারাবাহিক ধাপ — নাম্বার-করা সার্কেল ব্যাজ, বাংলা সংখ্যায় (toBn)
function aitBuildSteps(items){
  const list = aitEl('div', 'ait-steps');
  items.forEach((it, i) => {
    const row = aitEl('div', 'ait-step');
    row.appendChild(aitEl('span', 'ait-step-num', typeof toBn === 'function' ? toBn(i + 1) : String(i + 1)));
    const bodyEl = aitEl('div', 'ait-step-body');
    bodyEl.appendChild(aitEl('div', 'ait-step-label', it.label));
    if(it.desc) bodyEl.appendChild(aitEl('div', 'ait-step-desc', it.desc));
    row.appendChild(bodyEl);
    list.appendChild(row);
  });
  return list;
}

// বংশ/সম্পর্ক/নবীদের ধারাবাহিকতা — মূল নোড কার্ড + (থাকলে) নিচে ইন্ডেন্ট করা
// সন্তান/সম্পর্কিত নামের চিপ-সারি। গভীর নেস্টেড ট্রি না — এক লেভেল, যাতে
// সরু মোবাইল স্ক্রিনেও পরিষ্কার পড়া যায়।
function aitBuildTree(items){
  const wrap = aitEl('div', 'ait-tree');
  items.forEach(it => {
    const node = aitEl('div', 'ait-tree-node');
    node.appendChild(aitEl('div', 'ait-tree-label', it.label));
    if(it.desc) node.appendChild(aitEl('div', 'ait-tree-desc', it.desc));
    wrap.appendChild(node);
    if(Array.isArray(it.sub) && it.sub.length){
      const sub = aitEl('div', 'ait-tree-sub');
      it.sub.forEach(name => sub.appendChild(aitEl('span', 'ait-tree-leaf', name)));
      wrap.appendChild(sub);
    }
  });
  return wrap;
}

// দুইটা বিষয়/মত/ধারণার তুলনা — বাম/ডান দুই-কলাম গ্রিড, ঐচ্ছিক কলাম-হেডার
function aitBuildCompare(items, columns){
  const wrap = aitEl('div', 'ait-compare');
  if(Array.isArray(columns) && columns.length === 2){
    const heads = aitEl('div', 'ait-compare-heads');
    heads.appendChild(aitEl('div', 'ait-compare-head-cell', columns[0]));
    heads.appendChild(aitEl('div', 'ait-compare-head-cell', columns[1]));
    wrap.appendChild(heads);
  }
  items.forEach(it => {
    wrap.appendChild(aitEl('div', 'ait-compare-label', it.label));
    const row = aitEl('div', 'ait-compare-row');
    row.appendChild(aitEl('div', 'ait-compare-cell', it.left || '—'));
    row.appendChild(aitEl('div', 'ait-compare-cell', it.right || '—'));
    wrap.appendChild(row);
  });
  return wrap;
}

// গণনাযোগ্য বিষয়ের তালিকা (রুকন/প্রকারভেদ/নাম) — wrap হওয়া কার্ড-গ্রিড,
// flexbox দিয়ে প্রশস্ত স্ক্রিনে ২টা/সরু স্ক্রিনে ১টা প্রতি সারিতে বসে
function aitBuildList(items){
  const grid = aitEl('div', 'ait-list-grid');
  items.forEach(it => {
    const card = aitEl('div', 'ait-list-card');
    card.appendChild(aitEl('div', 'ait-list-card-label', it.label));
    if(it.desc) card.appendChild(aitEl('div', 'ait-list-card-desc', it.desc));
    grid.appendChild(card);
  });
  return grid;
}
