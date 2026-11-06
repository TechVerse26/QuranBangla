// ---------- Reading planner ----------
// Plans are simple day-count goals ("finish the Quran in N days") tracked by
// how many days the user has tapped "আজকের পাঠ সম্পন্ন" — kept in
// localStorage so progress survives between visits with no account needed.
const PLANNER_LS_KEY = 'qr_planners';
const PLANNER_SUGGESTIONS = [
  { label: '১ মাসে কুরআন', days: 30 },
  { label: '২ মাসে কুরআন', days: 60 },
  { label: '৪ মাসে কুরআন', days: 120 },
  { label: '৬ মাসে কুরআন', days: 180 },
  { label: '১ বছরে কুরআন', days: 365 }
];

function loadPlanners(){
  try{
    const raw = IDBKV.get(PLANNER_LS_KEY);
    if(raw) return JSON.parse(raw);
  }catch(e){}
  // Seed with one starter plan so the tab isn't empty on first visit.
  const seeded = [{ id: 'p'+Date.now(), title: '৪ মাসে কুরআন', days: 120, completedDays: 0, lastMarkedDate: null, createdTs: Date.now() }];
  savePlanners(seeded);
  return seeded;
}
function savePlanners(list){
  try{ IDBKV.set(PLANNER_LS_KEY, JSON.stringify(list)); }catch(e){}
}

let plannerState = { list: null, activePlanTab: 'mine' };

function todayStr(){ return new Date().toISOString().slice(0,10); }

function renderPlannerView(){
  if(!plannerState.list) plannerState.list = loadPlanners();
  const container = document.getElementById('plannerListContainer');
  if(plannerState.activePlanTab === 'find') return renderPlannerFind(container);
  const list = plannerState.list;
  const filtered = plannerState.activePlanTab === 'done'
    ? list.filter(p => p.completedDays >= p.days)
    : list.filter(p => p.completedDays < p.days);

  container.innerHTML = '';
  if(!filtered.length && plannerState.activePlanTab === 'done'){
    container.innerHTML = `<div class="empty-list-msg">এখনও কোনো প্ল্যানার সম্পন্ন হয়নি।</div>`;
    return;
  }
  filtered.forEach(p => {
    const pct = Math.min(100, Math.round((p.completedDays / p.days) * 100));
    const card = document.createElement('div');
    card.className = 'planner-card';
    card.innerHTML = `
      <div class="planner-thumb">📖</div>
      <div class="planner-body">
        <div class="planner-title">${p.title}</div>
        <div class="planner-progress-row">
          <div class="planner-progress-bar"><div class="planner-progress-fill" style="width:${pct}%"></div></div>
          <span>${toBn(pct)}%</span>
        </div>
        <div class="planner-sub">${toBn(p.completedDays)} / ${toBn(p.days)} দিন</div>
      </div>`;
    if(plannerState.activePlanTab !== 'done'){
      const btn = document.createElement('button');
      btn.className = 'planner-mark-btn';
      const already = p.lastMarkedDate === todayStr();
      btn.textContent = already ? '✓ আজকের পাঠ সম্পন্ন' : 'আজকের পাঠ সম্পন্ন করুন';
      btn.disabled = already;
      btn.onclick = (e) => { e.stopPropagation(); markPlanToday(p.id); };
      card.appendChild(btn);
    }
    container.appendChild(card);
  });

  if(plannerState.activePlanTab === 'mine'){
    const addCard = document.createElement('div');
    addCard.className = 'planner-add-card';
    addCard.innerHTML = `<div class="planner-add-ic">+</div><div>নতুন প্ল্যানার তৈরি করুন</div>`;
    addCard.onclick = () => { plannerState.activePlanTab = 'find'; renderPlannerView(); setPlannerTab('plTabFind'); };
    container.appendChild(addCard);
  }
}

function renderPlannerFind(container){
  container.innerHTML = '';
  const heading = document.createElement('div');
  heading.className = 'section-title';
  heading.textContent = 'একটি সময়সীমা বেছে নিন';
  container.appendChild(heading);
  PLANNER_SUGGESTIONS.forEach(s => {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `<div class="badge-num">${toBn(Math.round(s.days/30)||1)}</div>
      <div class="li-text"><div class="li-title">${s.label}</div><div class="li-sub">${toBn(s.days)} দিনে সম্পূর্ণ কুরআন</div></div>`;
    item.onclick = () => createPlan(s.label, s.days);
    container.appendChild(item);
  });
  const custom = document.createElement('div');
  custom.className = 'list-item';
  custom.innerHTML = `<div class="badge-num">+</div><div class="li-text"><div class="li-title">নিজের মতো দিন সংখ্যা লিখুন</div></div>`;
  custom.onclick = () => {
    showInputBox({
      title: 'কত দিনে সম্পন্ন করতে চান?',
      placeholder: 'যেমন 90',
      inputType: 'number',
      defaultValue: '90',
      confirmLabel: 'তৈরি করুন',
      onConfirm: (val) => {
        const n = parseInt(val, 10);
        if(Number.isInteger(n) && n > 0) createPlan(`${toBn(n)} দিনে কুরআন`, n);
        else showToast('সঠিক সংখ্যা লিখুন');
      }
    });
  };
  container.appendChild(custom);
}

function createPlan(title, days){
  plannerState.list.push({ id:'p'+Date.now(), title, days, completedDays:0, lastMarkedDate:null, createdTs: Date.now() });
  savePlanners(plannerState.list);
  plannerState.activePlanTab = 'mine';
  setPlannerTab('plTabMine');
  renderPlannerView();
  showToast('নতুন প্ল্যানার তৈরি হয়েছে');
}

function markPlanToday(id){
  const plan = plannerState.list.find(p => p.id === id);
  if(!plan) return;
  const today = todayStr();
  if(plan.lastMarkedDate === today) return;
  plan.completedDays = Math.min(plan.days, plan.completedDays + 1);
  plan.lastMarkedDate = today;
  savePlanners(plannerState.list);
  recordActivityToday();
  renderPlannerView();
}

function setPlannerTab(activeId){
  ['plTabMine','plTabFind','plTabDone'].forEach(id => document.getElementById(id).classList.toggle('active', id === activeId));
}

function initPlanner(){
  document.getElementById('plTabMine').onclick = () => { plannerState.activePlanTab='mine'; setPlannerTab('plTabMine'); renderPlannerView(); };
  document.getElementById('plTabFind').onclick = () => { plannerState.activePlanTab='find'; setPlannerTab('plTabFind'); renderPlannerView(); };
  document.getElementById('plTabDone').onclick = () => { plannerState.activePlanTab='done'; setPlannerTab('plTabDone'); renderPlannerView(); };
}
