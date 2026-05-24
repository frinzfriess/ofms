const $ = (q) => document.querySelector(q);
const $$ = (q) => [...document.querySelectorAll(q)];

// Same Supabase connection used by the provided Python database.py.
// Replace these values only if your Supabase project changes.
const SUPABASE_URL = 'https://swywgdikzoyflyljocpx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Wm-ZSkHxGJgICYnNn2EaQA_FwpcKywb';
const SESSION_KEY = 'ofms_supabase_session_v1';

const db = window.supabase?.createClient(SUPABASE_URL, SUPABASE_KEY);

let state = {
  currentUser: null,
  userRow: null,
  reports: [],
  logs: [],
  trendFilter: 'all'
};
let importedRows = [];
let importedFileName = '';

function toast(msg){
  const t = $('#toast');
  if(!t) return alert(msg);
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(()=>t.classList.add('hidden'), 2600);
}
function nowISO(){ return new Date().toISOString(); }
function nowDisplay(){ return new Date().toLocaleString(); }
function initials(name){ return (name || 'AD').split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0].toUpperCase()).join('') || 'AD'; }
function currentUser(){ return state.userRow || { username: state.currentUser || '', display_name:'Administrator', office:'Office of the Adjutant', role:'Administrator' }; }
function displayName(u=currentUser()){ return u.display_name || u.displayName || u.username || 'Administrator'; }
function userOffice(u=currentUser()){ return u.office || 'Office of the Adjutant'; }
function userRole(u=currentUser()){ return u.role || u.position || 'Administrator'; }
function saveSession(username){
  if(!username) return;
  localStorage.setItem(SESSION_KEY, JSON.stringify({ username, saved_at: nowISO() }));
}
function readSession(){
  const raw = localStorage.getItem(SESSION_KEY);
  if(!raw) return null;
  try{
    const parsed = JSON.parse(raw);
    return parsed?.username ? parsed : null;
  }catch{
    return raw ? { username: raw } : null;
  }
}
function clearSession(){ localStorage.removeItem(SESSION_KEY); }
function getSummary(r){
  const raw = r?.summary_json;
  if(!raw) return r || {};
  if(typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}
function toUiReport(row){
  const s = getSummary(row);
  return {
    id: row.id,
    title: row.title || s.title || 'Survey Report',
    type: s.type || s.survey_type || detectType([], row.title || ''),
    created: row.uploaded_at || row.created || s.created || nowISO(),
    responses: Number(row.total_responses ?? s.total_responses ?? s.responses ?? 0),
    mean: Number(s.overall_mean ?? s.mean ?? 0),
    satisfaction: Number(s.satisfaction_percentage ?? s.satisfaction ?? 0),
    gender: normalizeCountMap(s.gender_counts || s.gender || {}, classifyGender),
    assignment: normalizeCountMap(s.assignment_counts || s.assignment || {}, classifyStatus),
    years: s.years_service_counts || s.years || {},
    age: s.age_counts || s.age || {},
    customerType: s.customer_type_counts || s.customerType || {},
    region: s.region_counts || s.region || {},
    service: s.service_counts || s.service || {},
    rank: s.rank_counts || s.rank || {},
    living: s.living_counts || s.living || {},
    citizenCharter: s.citizen_charter || {},
    coverage: s.coverage || '',
    date_from: row.date_from || s.date_from || '',
    date_to: row.date_to || s.date_to || '',
    items: (s.items || s.indicators || []).map(x=>({...x, mean:Number(x.mean||0), count:Number(x.count||0)})),
    remarks: s.remarks || [],
    trend: s.trend || [],
    belowBenchmark: s.below_benchmark || [],
    source_file: s.source_file || row.excel_path || ''
  };
}
function setBusy(label='Loading...'){
  document.body.classList.add('busy');
  let box = $('#busyBox');
  if(!box){
    box = document.createElement('div');
    box.id = 'busyBox';
    box.className = 'busy-box';
    box.innerHTML = `<img src="assets/ooa_logo.png" alt="OADJ logo"><div class="spinner"></div><strong></strong>`;
    document.body.appendChild(box);
  }
  box.querySelector('strong').textContent = label;
}
function clearBusy(){ document.body.classList.remove('busy'); }

async function pbkdf2Hex(password, saltHex){
  const enc = new TextEncoder();
  const salt = new Uint8Array(saltHex.match(/.{1,2}/g).map(b=>parseInt(b,16)));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name:'PBKDF2', salt, iterations:120000, hash:'SHA-256'}, key, 256);
  return [...new Uint8Array(bits)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
function randomSaltHex(bytes=16){
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function hashPassword(password){
  const salt = randomSaltHex(16);
  const digest = await pbkdf2Hex(password, salt);
  return `${salt}$${digest}`;
}
async function verifyPassword(password, stored){
  if(!stored || !stored.includes('$')) return password === stored;
  const [salt, digest] = stored.split('$', 2);
  const check = await pbkdf2Hex(password, salt);
  return check === digest;
}

async function supabaseReady(){
  if(!db) throw new Error('Supabase library is not loaded. Please connect to the internet or check the CDN script.');
}
async function fetchUser(username){
  await supabaseReady();
  const { data, error } = await db.from('users').select('*').ilike('username', username.trim()).limit(1);
  if(error) throw error;
  return data?.[0] || null;
}
async function insertUser(username, password){
  const clean = username.trim();
  const password_hash = await hashPassword(password);
  const row = { username: clean, password_hash, created_at: nowISO(), display_name: clean, role: 'Administrator', office: 'Office of the Adjutant' };
  const { data, error } = await db.from('users').insert(row).select().single();
  if(error) throw error;
  return data;
}
async function updateUserProfile(username, display_name, office, role){
  const payload = { display_name: (display_name || username).trim(), office: (office || 'Office of the Adjutant').trim(), role: (role || 'Administrator').trim() };
  const { data, error } = await db.from('users').update(payload).ilike('username', username).select().single();
  if(error) throw error;
  state.userRow = data;
  return data;
}
async function updateUserPassword(username, newPassword){
  const { error } = await db.from('users').update({ password_hash: await hashPassword(newPassword) }).ilike('username', username);
  if(error) throw error;
}
async function updateLastLogin(username){
  const { error } = await db.from('users').update({ last_login: nowISO() }).ilike('username', username);
  if(error) console.warn(error);
}
async function log(action, details='', target_type='SYSTEM', target_id=''){
  try{
    await supabaseReady();
    await db.from('system_logs').insert({
      username: state.currentUser || 'system',
      action,
      target_type,
      target_id: String(target_id || ''),
      details,
      logged_at: nowISO()
    });
    await loadLogs();
  }catch(err){ console.warn('Log failed:', err); }
}
async function loadReports(){
  await supabaseReady();
  const { data, error } = await db.from('reports').select('*').neq('status','Deleted').order('id', { ascending:false });
  if(error) throw error;
  state.reports = (data || []).map(toUiReport);
}
async function loadLogs(){
  await supabaseReady();
  const { data, error } = await db.from('system_logs').select('*').order('id', { ascending:false }).limit(500);
  if(error) throw error;
  state.logs = data || [];
  renderLogs();
}
async function saveReportToSupabase(report){
  const summary = {
    type: report.type,
    title: report.title,
    created: report.created,
    source_file: report.source_file,
    total_responses: report.responses,
    overall_mean: report.mean,
    satisfaction_percentage: report.satisfaction,
    gender_counts: report.gender,
    assignment_counts: report.assignment,
    years_service_counts: report.years,
    age_counts: report.age,
    customer_type_counts: report.customerType,
    region_counts: report.region,
    service_counts: report.service,
    rank_counts: report.rank,
    living_counts: report.living,
    citizen_charter: report.citizenCharter,
    coverage: report.coverage,
    date_from: report.date_from,
    date_to: report.date_to,
    trend: report.trend,
    below_benchmark: report.belowBenchmark,
    items: report.items,
    remarks: report.remarks
  };
  const payload = {
    title: report.title,
    excel_path: report.source_file || importedFileName || '',
    uploaded_by: state.currentUser || 'system',
    uploaded_at: report.created,
    modified_at: nowISO(),
    status: 'Active',
    total_responses: report.responses,
    date_from: report.date_from || null,
    date_to: report.date_to || null,
    remaining_cards: 0,
    backlogs: 0,
    summary_json: JSON.stringify(summary),
    pdf_path: null,
    deleted_at: null
  };
  const { data, error } = await db.from('reports').insert(payload).select().single();
  if(error) throw error;
  return toUiReport(data);
}

function showAuth(which){
  $('#loginForm').classList.toggle('active', which==='login');
  $('#createForm').classList.toggle('active', which==='create');
}
$$('[data-auth]').forEach(b=>b.onclick=()=>showAuth(b.dataset.auth));

$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  const u = $('#loginUsername').value.trim();
  const p = $('#loginPassword').value;
  if(!u || !p) return toast('Please enter username and password.');
  setBusy('Signing in to Supabase...');
  try{
    let found = await fetchUser(u);
    if(!found || !(await verifyPassword(p, found.password_hash))) return toast('Invalid username or password.');
    state.currentUser = found.username;
    state.userRow = found;
    saveSession(found.username);
    await updateLastLogin(found.username);
    await log('LOGIN','User logged in','SESSION');
    await bootApp();
  }catch(err){ toast(err.message || 'Login failed. Check Supabase connection and table schema.'); }
  finally{ clearBusy(); }
};
$('#createForm').onsubmit = async e => {
  e.preventDefault();
  const u=$('#createUsername').value.trim(), p=$('#createPassword').value, c=$('#createConfirm').value;
  if(!u || p.length<4) return toast('Username and at least 4-character password are required.');
  if(p!==c) return toast('Passwords do not match.');
  setBusy('Creating Supabase account...');
  try{
    if(await fetchUser(u)) return toast('Username already exists.');
    const created = await insertUser(u,p);
    state.currentUser = created.username;
    state.userRow = created;
    saveSession(created.username);
    await log('CREATE','Account created','USER', created.username);
    await bootApp();
  }catch(err){ toast(err.message || 'Account creation failed.'); }
  finally{ clearBusy(); }
};
$('#logoutBtn').onclick = async () => {
  await log('LOGOUT','User logged out','SESSION');
  state.currentUser=null; state.userRow=null; clearSession();
  $('#appView').classList.add('hidden'); $('#authView').classList.remove('hidden');
};

async function bootApp(){
  setBusy('Loading OFMS database...');
  try{
    if(state.currentUser && !state.userRow) state.userRow = await fetchUser(state.currentUser);
    if(state.currentUser && !state.userRow){
      clearSession();
      state.currentUser=null;
      throw new Error('Saved session expired. Please log in again.');
    }
    $('#authView').classList.add('hidden'); $('#appView').classList.remove('hidden');
    hydrateUser();
    showPage('dashboard');
    try{
      await loadReports();
    }catch(err){
      console.warn('Report loading failed:', err);
      toast('Signed in, but reports could not be loaded yet.');
    }
    try{
      await loadLogs();
    }catch(err){
      console.warn('Log loading failed:', err);
      state.logs = [];
    }
    renderAll();
  }catch(err){
    toast(err.message || 'Unable to load Supabase data.');
    $('#authView').classList.remove('hidden'); $('#appView').classList.add('hidden');
  }finally{ clearBusy(); }
}
function hydrateUser(){
  const u=currentUser();
  const name=displayName(u), office=userOffice(u), role=userRole(u);
  $('#sideName').textContent=name;
  $('#topName').textContent=name;
  if($('#topRole')) $('#topRole').textContent=`${role} • ${office}`;
  $('#sideOffice').textContent=office;
  if($('#sideRole')) $('#sideRole').textContent=role;
  $('#avatar').textContent=initials(name);
  $('#displayName').value=name;
  $('#officeName').value=office;
  if($('#rolePosition')) $('#rolePosition').value=role;
  $('#usernameReadonly').value=u.username || '';
}

function notificationItems(){
  const items=[];
  const latest=latestReport();
  if(latest){
    items.push({title:'Latest report generated', body:`${latest.title} • ${latest.responses} response(s) • ${latest.mean.toFixed(2)}/5.00`});
  }
  const recentLogs=(state.logs||[]).slice(0,4);
  recentLogs.forEach(l=>items.push({title:l.action || 'System activity', body:`${l.details || 'Activity recorded'} • ${new Date(l.logged_at || Date.now()).toLocaleString()}`}));
  if(!items.length) items.push({title:'No new notifications', body:'System alerts and activity updates will appear here.'});
  return items;
}
function renderNotifications(){
  const list=$('#notifList'), badge=$('#notifBadge');
  if(!list || !badge) return;
  const items=notificationItems();
  const count=Math.max(0, items.filter(x=>x.title!=='No new notifications').length);
  badge.textContent=count;
  badge.style.display=count?'grid':'none';
  list.innerHTML=items.map(x=>`<div class="notif-item"><i></i><div><strong>${escapeHtml(x.title)}</strong><span>${escapeHtml(x.body)}</span></div></div>`).join('');
}
const notifBtn = $('#notifBtn');
const notifPanel = $('#notifPanel');
if(notifBtn && notifPanel){
  let lastNotifTouch = 0;
  const toggleNotifications = (e) => {
    if(e.type === 'click' && Date.now() - lastNotifTouch < 650) return;
    if(e.type === 'touchstart') lastNotifTouch = Date.now();
    e.preventDefault();
    e.stopPropagation();
    renderNotifications();
    notifPanel.classList.toggle('hidden');
  };
  notifBtn.onclick = toggleNotifications;
  notifBtn.ontouchstart = toggleNotifications;
  notifPanel.onclick = (e) => e.stopPropagation();
  notifPanel.ontouchstart = (e) => e.stopPropagation();
  document.addEventListener('click', (e)=>{ if(!notifPanel.contains(e.target) && !notifBtn.contains(e.target)) notifPanel.classList.add('hidden'); });
  document.addEventListener('touchstart', (e)=>{ if(!notifPanel.contains(e.target) && !notifBtn.contains(e.target)) notifPanel.classList.add('hidden'); }, { passive:true });
}
const markReadBtn=$('#markReadBtn');
if(markReadBtn){ markReadBtn.onclick=()=>{ $('#notifBadge').style.display='none'; $('#notifPanel').classList.add('hidden'); toast('Notifications marked as read.'); }; }
function showPage(id){
  $$('.nav').forEach(b=>b.classList.toggle('active', b.dataset.page===id));
  $$('.page').forEach(p=>p.classList.toggle('active-page', p.id===id));
  renderAll();
}
$$('.nav[data-page]').forEach(b=>b.onclick=()=>showPage(b.dataset.page));
setInterval(()=>{ const c=$('#clockText'); if(c) c.textContent = nowDisplay(); },1000);

function renderAll(){ renderDashboard(); renderReports(); renderLogs(); hydrateUser(); renderNotifications(); }
function totalResponses(){ return state.reports.reduce((a,r)=>a+(+r.responses||0),0); }
function latestReport(){ return state.reports[0] || null; }
function dashboardComparisonText(csm, job){
  if(!csm && !job) return {status:'No comparison yet', details:'Generate both CSM and Job Satisfaction reports to compare results.'};
  if(csm && !job) return {status:'CSM available only', details:`CSM mean is ${csm.mean.toFixed(2)}/5.00 with ${csm.satisfaction.toFixed(2)}% satisfaction. Generate a Job Satisfaction report for comparison.`};
  if(!csm && job) return {status:'Job report available only', details:`Job mean is ${job.mean.toFixed(2)}/5.00 with ${job.satisfaction.toFixed(2)}% satisfaction. Generate a CSM report for comparison.`};
  const diff = csm.mean - job.mean;
  const higher = diff>=0 ? 'CSM' : 'Job Satisfaction';
  return {status:`${higher} is higher`, details:`CSM: ${csm.mean.toFixed(2)}/5.00 (${csm.satisfaction.toFixed(2)}%). Job: ${job.mean.toFixed(2)}/5.00 (${job.satisfaction.toFixed(2)}%). Difference: ${Math.abs(diff).toFixed(2)} point(s).`};
}
function dashboardPriorityText(r){
  if(!r) return {status:'No priority detected', details:'Priority indicators will be shown after a survey report is generated.'};
  const low = r.items?.[r.items.length-1];
  const below = (r.belowBenchmark||[]).slice(0,3).map(cleanItemName);
  if(low){
    return {status:`Review ${cleanItemName(low.name)}`, details:`Lowest mean: ${low.mean.toFixed(2)}/5.00. ${below.length?`Below benchmark: ${below.join(', ')}.`:'No additional below-benchmark items detected.'}`};
  }
  return {status:'Check rating indicators', details:'The latest report has no detected rating indicators. Review the imported Excel column format.'};
}
function dashboardActivityText(){
  const l=(state.logs||[])[0];
  if(!l) return {status:'No activity yet', details:'Recent imports, report generation, PDF printing, and account changes will appear here.'};
  return {status:String(l.action||'System Activity'), details:`${l.details || 'Activity recorded'} • ${new Date(l.logged_at || Date.now()).toLocaleString()}`};
}
function setTextIfExists(sel, text){ const el=$(sel); if(el) el.textContent=text; }

function renderDashboard(){
  const r = latestReport();
  $('#metricReports').textContent = state.reports.length;
  $('#metricResponses').textContent = totalResponses();
  $('#metricMean').textContent = r ? r.mean.toFixed(2) : '0.00';
  $('#metricSatisfaction').textContent = r ? Math.round(r.satisfaction)+'%' : '0%';
  $('#genderSub').textContent = r?.type === 'job' && !Object.keys(r.gender||{}).length ? 'No Sex/Gender column detected; see Years in Service profile below.' : 'Actual Sex/Gender data when available';
  renderDonut('#genderChart','#genderLegend', r?.gender || {}, ['#2563eb','#ec4899','#94a3b8']);
  renderDonut('#statusChart','#statusLegend', r?.assignment || {}, ['#f59e0b','#10b981','#94a3b8']);
  renderTrend();
  renderDashboardInsights(r);
}
function renderDashboardInsights(r){
  const latest=$('#latestSurveySummary'), info=$('#excelInfoSummary');
  if(!latest || !info) return;
  if(!r){
    latest.innerHTML='<p class="muted">Import an Excel file to view full survey interpretation and dashboard summary.</p>';
    info.innerHTML='<p class="muted">No Excel data loaded yet.</p>';
    return;
  }
  const top=r.items?.[0], low=r.items?.[r.items.length-1];
  latest.innerHTML = [
    infoLine('Survey Type', surveyLabel(r.type)),
    infoLine('Reporting Coverage', r.coverage || coverageFromReport(r)),
    infoLine('Valid Responses', r.responses),
    infoLine('Overall Result', `${r.mean.toFixed(2)}/5.00 (${r.satisfaction.toFixed(2)}%)`),
    infoLine('Highest Area', top ? `${cleanItemName(top.name)} (${top.mean.toFixed(2)})` : 'No rating items detected'),
    infoLine('Lowest Area', low ? `${cleanItemName(low.name)} (${low.mean.toFixed(2)})` : 'No rating items detected')
  ].join('');
  const profile = r.type==='job' ? strongest(r.years) : strongest(r.gender);
  const secondProfile = r.type==='job' ? strongest(r.rank) : strongest(r.customerType);
  info.innerHTML = [
    infoLine(r.type==='job'?'Years in Service':'Sex/Gender', profile),
    infoLine(r.type==='job'?'Rank/Grade':'Customer Type', secondProfile),
    infoLine(r.type==='job'?'Assignment Status':'Region', r.type==='job'?strongest(r.assignment):strongest(r.region)),
    infoLine(r.type==='job'?'Living Arrangement':'Service Availed', r.type==='job'?strongest(r.living):strongest(r.service)),
    infoLine('Written Remarks', r.remarks?.length || 0)
  ].join('');
}
function infoLine(a,b){ return `<div class="info-line"><span>${escapeHtml(a)}</span><strong>${escapeHtml(b)}</strong></div>`; }
function renderDonut(chartSel, legendSel, data, colors){
  const entries = Object.entries(data || {}).filter(([k,v])=>Number(v)>0);
  const total = entries.reduce((a,[,v])=>a+Number(v),0);
  const chart=$(chartSel), legend=$(legendSel);
  chart.dataset.total = total ? total : 'No data';
  if(!total){ chart.style.background='conic-gradient(#e5e7eb 0 360deg)'; legend.innerHTML='<span>No data available</span>'; return; }
  let deg=0; const parts=[];
  entries.forEach(([label,val],i)=>{ const span=Number(val)/total*360; parts.push(`${colors[i%colors.length]} ${deg}deg ${deg+span}deg`); deg+=span; });
  chart.style.background=`conic-gradient(${parts.join(',')})`;
  legend.innerHTML = entries.map(([label,val],i)=>`<span><i class="dot" style="background:${colors[i%colors.length]}"></i>${escapeHtml(label)}: ${val}</span>`).join('');
}
function filterDateRange(created, filter){
  const d=new Date(created), now=new Date();
  const startOfDay=x=>new Date(x.getFullYear(),x.getMonth(),x.getDate());
  const today=startOfDay(now), yesterday=new Date(today); yesterday.setDate(yesterday.getDate()-1);
  const week=new Date(today); week.setDate(week.getDate()-6);
  const month=new Date(now.getFullYear(),now.getMonth(),1);
  if(filter==='today') return d>=today;
  if(filter==='yesterday') return d>=yesterday && d<today;
  if(filter==='week') return d>=week;
  if(filter==='month') return d>=month;
  return true;
}
function renderTrend(){
  const el=$('#trendChart');
  const filter=state.trendFilter || 'all';
  $$('.trend-filters .chip').forEach(b=>b.classList.toggle('active', b.dataset.trend===filter));
  const rows=state.reports.filter(r=>filterDateRange(r.created, filter)).sort((a,b)=>new Date(a.created)-new Date(b.created));
  const labelMap={all:'all saved reports', today:'today', yesterday:'yesterday', week:'the last 7 days', month:'this month'};
  const sub=$('#trendSub'); if(sub) sub.textContent=`Showing ${rows.length} report(s) for ${labelMap[filter] || 'all saved reports'}.`;
  if(!rows.length){ el.className='trend-empty'; el.innerHTML='<p class="muted">No report trend found for the selected period.</p>'; return; }
  const buckets={};
  rows.forEach(r=>{
    const d=new Date(r.created);
    const key = filter==='today' || filter==='yesterday' ? d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : d.toLocaleDateString([], {month:'short', day:'numeric'});
    if(!buckets[key]) buckets[key]={reports:0, responses:0, meanTotal:0, satisfactionTotal:0, order:d.getTime()};
    buckets[key].reports += 1;
    buckets[key].responses += Number(r.responses||0);
    buckets[key].meanTotal += Number(r.mean||0);
    buckets[key].satisfactionTotal += Number(r.satisfaction||0);
    buckets[key].order=Math.min(buckets[key].order,d.getTime());
  });
  const entries=Object.entries(buckets).sort((a,b)=>a[1].order-b[1].order).slice(-10).map(([label,v])=>({label, value:v.responses || v.reports, reports:v.reports, mean:v.meanTotal/Math.max(v.reports,1), satisfaction:v.satisfactionTotal/Math.max(v.reports,1)}));
  const w=980, h=250, padL=58, padR=34, padT=26, padB=48;
  const max=Math.max(...entries.map(e=>e.value),1), plotW=w-padL-padR, plotH=h-padT-padB;
  const xStep=entries.length>1?plotW/(entries.length-1):0;
  const pts=entries.map((e,i)=>({ ...e, x: entries.length===1 ? padL + plotW/2 : padL+i*xStep, y: h-padB-(e.value/max)*plotH }));
  function smooth(points){ if(points.length===1) return ''; let d=`M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`; for(let i=0;i<points.length-1;i++){ const p=points[i], n=points[i+1], mx=(p.x+n.x)/2; d+=` C ${mx.toFixed(1)} ${p.y.toFixed(1)}, ${mx.toFixed(1)} ${n.y.toFixed(1)}, ${n.x.toFixed(1)} ${n.y.toFixed(1)}`; } return d; }
  const line=smooth(pts);
  const area = pts.length>1 ? `${line} L ${pts.at(-1).x.toFixed(1)} ${h-padB} L ${pts[0].x.toFixed(1)} ${h-padB} Z` : '';
  const grid=[0,.25,.5,.75,1].map(t=>{ const y=padT+t*plotH; const val=Math.round(max*(1-t)); return `<line class="grid" x1="${padL}" x2="${w-padR}" y1="${y}" y2="${y}"/><text class="axis" x="${padL-12}" y="${y+4}" text-anchor="end">${val}</text>`; }).join('');
  const avgMean = entries.reduce((a,e)=>a+e.mean,0)/Math.max(entries.length,1);
  const totalResponses = entries.reduce((a,e)=>a+e.value,0);
  el.className='trend-line-card';
  el.innerHTML=`<div class="trend-stats"><span>Total responses <b>${totalResponses}</b></span><span>Average mean <b>${avgMean.toFixed(2)}/5.00</b></span><span>Periods <b>${entries.length}</b></span></div><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Latest survey trend graph"><defs><linearGradient id="trendAreaSoft" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2563eb" stop-opacity="0.18"/><stop offset="100%" stop-color="#2563eb" stop-opacity="0.01"/></linearGradient></defs>${grid}${area?`<path class="area" d="${area}"/>`:''}<path class="base" d="M ${padL} ${h-padB} L ${w-padR} ${h-padB}"/>${line?`<path class="line" d="${line}"/>`:''}${pts.map(p=>`<g class="trend-point"><circle cx="${p.x}" cy="${p.y}" r="7"><title>${p.label}: ${p.value} response(s)</title></circle><text class="value" x="${p.x}" y="${Math.max(p.y-14,16)}" text-anchor="middle">${p.value}</text><text class="label" x="${p.x}" y="${h-14}" text-anchor="middle">${escapeHtml(p.label)}</text></g>`).join('')}</svg>${entries.length===1?'<p class="muted trend-note">Only one report is available. The graph will become a smooth trend line after another report is generated.</p>':''}`;
}
$$('.trend-filters .chip').forEach(b=>b.onclick=()=>{ state.trendFilter=b.dataset.trend; renderTrend(); });

$('#excelFile').onchange = async (e)=>{
  const file=e.target.files[0]; if(!file) return;
  importedFileName=file.name;
  const ext=file.name.split('.').pop().toLowerCase();
  setBusy('Reading Excel file...');
  try{
    if(ext==='csv') importedRows = parseCSV(await file.text());
    else {
      if(!window.XLSX) throw new Error('Excel parser is not loaded. Connect to internet or upload CSV.');
      const buf=await file.arrayBuffer(); const wb=XLSX.read(buf,{type:'array'}); const ws=wb.Sheets[wb.SheetNames[0]]; importedRows=XLSX.utils.sheet_to_json(ws,{defval:''});
    }
    const type=detectType(importedRows, file.name);
    $('#reportTitle').value = type==='job'?'Job Satisfaction and Work Experience Survey':'Client Satisfaction Measurement Survey';
    $('#surveyType').value = type;
    $('#preview').innerHTML = `<strong>${escapeHtml(file.name)}</strong><br>${importedRows.length} row(s) loaded. Detected: ${type==='job'?'Job Satisfaction':'Client Satisfaction Measurement'}. Data will be saved to Supabase when generated.`;
    await log('IMPORT', `${file.name} imported`, 'FILE', file.name);
  }catch(err){ toast(err.message); }
  finally{ clearBusy(); }
};
function parseCSV(text){
  const rows=text.trim().split(/\r?\n/).map(line=>line.split(',').map(x=>x.trim().replace(/^"|"$/g,'')));
  const headers=rows.shift()||[]; return rows.map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]||''])));
}
function detectType(rows=[], name=''){
  const headers=Object.keys(rows[0]||{}).join(' ').toLowerCase()+ ' ' + name.toLowerCase();
  return /job|work experience|years in service|promotion|supervisor|paperwork|pride/.test(headers) ? 'job' : 'csm';
}
function normKey(k){ return String(k||'').toLowerCase().replace(/[^a-z0-9]+/g,''); }
function findCol(row, patterns){
  const keys=Object.keys(row||{});
  return keys.find(k=>patterns.some(p=>p.test(normKey(k)) || p.test(String(k).toLowerCase()))) || null;
}
function cleanVal(v){ return String(v??'').trim(); }
function normalizeCountMap(obj, classifier=null){
  const out={};
  Object.entries(obj || {}).forEach(([key,val])=>{
    const count=Number(val);
    if(!Number.isFinite(count) || count<=0) return;
    let label=cleanVal(key);
    if(classifier) label=classifier(label);
    if(!label) label='Unspecified';
    out[label]=(out[label]||0)+count;
  });
  return sortCountObj(out);
}
function countBy(rows, col, classifier=null){
  const out={}; if(!col) return out;
  rows.forEach(r=>{ let v=cleanVal(r[col]); if(classifier) v=classifier(v); if(!v) v='Unspecified'; out[v]=(out[v]||0)+1; });
  return sortCountObj(out);
}
function sortCountObj(obj){ return Object.fromEntries(Object.entries(obj||{}).sort((a,b)=>Number(b[1])-Number(a[1]) || String(a[0]).localeCompare(String(b[0])))); }
function classifyGender(v){ const s=cleanVal(v).toLowerCase(); if(/^m(ale)?$/.test(s)||s.includes('male')&&!s.includes('female')) return 'Male'; if(/^f(emale)?$/.test(s)||s.includes('female')) return 'Female'; return s?'Other/Unspecified':''; }
function classifyStatus(v){
  const raw=cleanVal(v);
  const s=raw.toLowerCase().replace(/[^a-z0-9]+/g,'');
  if(['ds','dservice','detached','detachedservice','detachedsvc'].includes(s)||s.includes('detached')) return 'Detached Service (D.S.)';
  if(['org','organic'].includes(s)||s.includes('organic')) return 'Organic';
  return raw||'';
}
function classifyAge(v){ const n=parseInt(cleanVal(v),10); if(!Number.isFinite(n)) return cleanVal(v); if(n<20) return 'Below 20'; if(n<=29) return '20 - 29'; if(n<=39) return '30 - 39'; if(n<=49) return '40 - 49'; if(n<=59) return '50 - 59'; return '60 and above'; }
function parseDateValue(v, preference='auto'){
  if(v instanceof Date && !Number.isNaN(v.getTime())) return v;
  if(typeof v==='number' && Number.isFinite(v)){
    const excelEpoch = new Date(Date.UTC(1899,11,30));
    const d = new Date(excelEpoch.getTime() + v*86400000);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = cleanVal(v);
  if(!s) return null;
  const iso = new Date(s);
  if(/^\d{4}-\d{1,2}-\d{1,2}/.test(s) && !Number.isNaN(iso.getTime())) return iso;
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if(m){
    let a=Number(m[1]), b=Number(m[2]), yr=Number(m[3].length===2?'20'+m[3]:m[3]);
    let day, mon;
    if(a>12){ day=a; mon=b-1; }
    else if(b>12){ day=b; mon=a-1; }
    else if(preference==='dmy'){ day=a; mon=b-1; }
    else if(preference==='mdy'){ day=b; mon=a-1; }
    else { day=a; mon=b-1; } // Philippine-style default for ambiguous dates
    const d=new Date(yr,mon,day);
    if(!Number.isNaN(d.getTime())) return d;
  }
  return Number.isNaN(iso.getTime()) ? null : iso;
}
function inferDatePreference(rows, dateCol){
  if(!dateCol) return 'auto';
  let dmy=0, mdy=0;
  rows.forEach(r=>{
    const s=cleanVal(r[dateCol]);
    const m=s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if(!m) return;
    const a=Number(m[1]), b=Number(m[2]);
    if(a>12) dmy++;
    if(b>12) mdy++;
  });
  if(mdy>dmy) return 'mdy';
  if(dmy>mdy) return 'dmy';
  return 'dmy';
}
function fmtDate(d){
  if(!d) return '';
  const x = d instanceof Date ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? '' : x.toLocaleDateString('en-PH', {day:'2-digit', month:'long', year:'numeric'});
}
function monthLabel(d){ return d ? d.toLocaleDateString('en-PH', {month:'long', year:'numeric'}) : 'No date'; }
function coverageFromDates(rows, dateCol){
  const pref=inferDatePreference(rows,dateCol);
  const dates=(dateCol?rows.map(r=>parseDateValue(r[dateCol], pref)).filter(Boolean):[]).sort((a,b)=>a-b);
  if(!dates.length) return {text:'No date coverage detected', from:'', to:'', dates:[]};
  const first=dates[0], last=dates[dates.length-1];
  const text = first.toDateString()===last.toDateString() ? fmtDate(first) : `${fmtDate(first)} to ${fmtDate(last)}`;
  return {text, from:first.toISOString(), to:last.toISOString(), dates};
}
function coverageFromReport(r){ const from=parseDateValue(r?.date_from), to=parseDateValue(r?.date_to); if(from && to){ return from.toDateString()===to.toDateString()?fmtDate(from):`${fmtDate(from)} to ${fmtDate(to)}`; } return (r?.coverage && !/no date/i.test(r.coverage)) ? r.coverage : 'No date coverage detected'; }
const JOB_LABELS = ['Promotion Opportunities','Supervision','Recognition','Policies and Procedures','Coworker Relations','Meaningfulness of Work','Communication','Work Schedule','Growth Opportunities','Supervisor Fairness','Work Appreciation','Paperwork Reasonableness','Coworker Competence','Nature of Work','Organizational Appreciation','Supervisor Concern','Performance Recognition','Workload','Coworker Relationship','Pride in Work','Physical Working Conditions','Paperwork Load','Rewards','Tools and Resources','Workplace Conflict','Job Enjoyment','Systems and Processes'];
const JOB_REVERSE = new Set([1,3,4,6,8,10,11,13,15,18,22,25]);
const CSM_LABELS = {SQD1:'Responsiveness',SQD2:'Reliability',SQD3:'Access and Facilities',SQD4:'Communication',SQD5:'Costs',SQD6:'Integrity',SQD7:'Assurance',SQD8:'Outcome'};
function surveyLabel(type){ return type==='job'?'Job Satisfaction and Work Experience Survey':'Client Satisfaction Measurement Survey'; }
function interpretationLabel(mean){ if(mean>=4.5) return 'Outstanding'; if(mean>=4.0) return 'Very Satisfactory'; if(mean>=3.0) return 'Satisfactory'; if(mean>=2.0) return 'Needs Improvement'; return mean>0?'Poor':'No rating'; }
function parseRatingValue(v){
  if(typeof v==='number') return v>=1 && v<=5 ? v : null;
  const s=cleanVal(v).toLowerCase();
  if(!s) return null;
  const n=parseFloat(s); if(Number.isFinite(n) && n>=1 && n<=5) return n;
  if(s.includes('strongly agree') || s.includes('lubos na sumasang')) return 5;
  if(s.includes('agree') || s.includes('sumasang-ayon')) return 4;
  if(s.includes('neutral') || s.includes('hindi tiyak') || s.includes('neither')) return 3;
  if(s.includes('strongly disagree') || s.includes('lubos na hindi')) return 1;
  if(s.includes('disagree') || s.includes('hindi sumasang')) return 2;
  if(s.includes('very satisfied')) return 5;
  if(s.includes('satisfied')) return 4;
  if(s.includes('neither')) return 3;
  if(s.includes('dissatisfied')) return 2;
  return null;
}
function itemCodeFromKey(key, type){
  const m=String(key).match(type==='job'?/^\s*(\d{1,2})\s*[\.\)]/:/^\s*(SQD\d+)/i);
  return m ? (type==='job'?`Q${m[1]}`:m[1].toUpperCase()) : null;
}
function cleanItemName(key){
  const raw=String(key||'');
  const q=raw.match(/^\s*(\d{1,2})\s*[\.\)]/); if(q){ const idx=Number(q[1])-1; return JOB_LABELS[idx] || `Q${q[1]}`; }
  const sq=raw.match(/^\s*(SQD\d+)/i); if(sq) return CSM_LABELS[sq[1].toUpperCase()] || sq[1].toUpperCase();
  return raw.split('\n')[0].replace(/^\s*SQD\d+\.\s*/i,'').slice(0,80) || 'Indicator';
}
function detectRatingColumns(sample, type){
  return Object.keys(sample||{}).filter(k=>{
    if(type==='job') return /^\s*\d{1,2}\s*[\.\)]/.test(k);
    return /^\s*SQD\d+/i.test(k);
  });
}
function analyzeItems(rows, type){
  const sample=rows[0]||{}; const cols=detectRatingColumns(sample,type); const items=[];
  cols.forEach(k=>{
    const code=itemCodeFromKey(k,type) || cleanItemName(k);
    const idx=type==='job' ? parseInt(code.replace('Q',''),10) : null;
    let total=0,count=0;
    rows.forEach(row=>{ let val=parseRatingValue(row[k]); if(val==null) return; if(type==='job' && JOB_REVERSE.has(idx)) val=6-val; total+=val; count++; });
    if(count) items.push({code, name:cleanItemName(k), mean:total/count, count});
  });
  return items.sort((a,b)=>b.mean-a.mean);
}
function trendFromRows(rows,dateCol,mean){
  if(!dateCol) return [];
  const pref=inferDatePreference(rows,dateCol);
  const map={}; rows.forEach(r=>{ const d=parseDateValue(r[dateCol], pref); if(!d) return; const key=monthLabel(d); if(!map[key]) map[key]={responses:0, mean:0, order:d.getTime()}; map[key].responses++; map[key].order=Math.min(map[key].order,d.getTime()); });
  return Object.entries(map).sort((a,b)=>a[1].order-b[1].order).map(([month,v])=>({month, responses:v.responses, mean}));
}
function analyzeRows(rows, type, title){
  const sample=rows[0]||{};
  const dateCol=findCol(sample,[/timestamp/,/date/,/submitted/]);
  const coverage=coverageFromDates(rows,dateCol);
  const genderCol=findCol(sample,[/^sex$/, /^sex/, /^gender$/, /sexgender/, /gendersex/, /sex.*gender/, /gender.*sex/, /genderidentity/]);
  const statusCol=findCol(sample,[/assignmentstatus/,/statusofassignment/,/^assignment$/, /organicdetached/, /organic.*detached/, /organic.*ds/, /detachedservice/, /detachedsvc/]);
  const yearsCol=findCol(sample,[/noofyearsinservice/,/yearsinservice/,/lengthofservice/,/serviceyears/,/year.*service/]);
  const rankCol=findCol(sample,[/militaryrankgrade/,/rank/,/grade/]);
  const livingCol=findCol(sample,[/livingarrangement/,/living/]);
  const ageCol=findCol(sample,[/^age$/]);
  const customerTypeCol=findCol(sample,[/customertype/,/customer/]);
  const regionCol=findCol(sample,[/regionofresidence/,/^region$/]);
  const serviceCol=findCol(sample,[/serviceavailed/,/service/]);
  const ccCols=Object.keys(sample).filter(k=>/^\s*CC\d+/i.test(k));
  const remarkCol=findCol(sample,[/remark/,/comment/,/suggestion/,/feedback/]);
  const gender=countBy(rows, genderCol, classifyGender);
  const assignment=countBy(rows, statusCol, classifyStatus);
  const years=countBy(rows, yearsCol);
  const age=countBy(rows, ageCol, classifyAge);
  const customerType=countBy(rows, customerTypeCol);
  const region=countBy(rows, regionCol);
  const service=countBy(rows, serviceCol);
  const rank=countBy(rows, rankCol);
  const living=countBy(rows, livingCol);
  const citizenCharter={}; ccCols.forEach((c,i)=>{ citizenCharter[`CC${i+1}`]=countBy(rows,c); });
  const remarks=remarkCol?rows.map(r=>cleanVal(r[remarkCol])).filter(x=>x && x!=='.').slice(0,80):[];
  const items=analyzeItems(rows,type);
  const mean=items.length?items.reduce((a,x)=>a+x.mean,0)/items.length:0;
  const satisfaction=mean/5*100;
  const belowBenchmark=items.filter(x=>x.mean<4).map(x=>x.name);
  return { id:Date.now(), title, type, created:nowISO(), responses:rows.length, mean, satisfaction, gender, assignment, years, age, customerType, region, service, rank, living, citizenCharter, items, remarks, coverage:coverage.text, date_from:coverage.from, date_to:coverage.to, trend:trendFromRows(rows,dateCol,mean), belowBenchmark, source_file:importedFileName };
}
function escapeHtml(s){ return String(s ?? '').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])); }

$('#generateBtn').onclick = async () => {
  if(!importedRows.length) { toast('Please import an Excel or CSV file before generating a report.'); return; }
  setBusy('Generating complete survey report...');
  try{
    const type=$('#surveyType').value==='auto'?detectType(importedRows, importedFileName):$('#surveyType').value;
    const title=$('#reportTitle').value.trim() || surveyLabel(type);
    const draft=analyzeRows(importedRows, type, title);
    const saved = await saveReportToSupabase(draft);
    await log('CREATE', `${title} generated with ${saved.responses} responses`, 'REPORT', saved.id);
    importedRows=[]; $('#preview').textContent='Report generated and saved to Supabase. You may import another file.';
    await loadReports(); renderAll(); showPage('reports'); openReport(saved.id);
  }catch(err){ toast(err.message || 'Report generation failed.'); }
  finally{ clearBusy(); }
};

function loadDemo(){
  importedRows = Array.from({length:79},(_,i)=>({
    'Assignment Status': i<46?'Organic':'D.S.',
    'Years in Service': i%4===0?'0-5 years':i%4===1?'6-10 years':i%4===2?'11-15 years':'16 years and above',
    'Pride in Work': 4 + (i%3===0?1:0), 'Paperwork Load': 2 + (i%3), 'Communication': 3 + (i%2), 'Policies and Procedures': 3, 'Recognition': 3 + (i%2),
    'Remarks': i%7===0?'Improve workload distribution and communication.':''
  }));
  importedFileName='Demo Job Satisfaction.xlsx'; $('#surveyType').value='job'; $('#reportTitle').value='Job Satisfaction and Work Experience Survey'; $('#preview').textContent='Demo job satisfaction data loaded.';
}
const loadDemoBtn=$('#loadDemoBtn'); if(loadDemoBtn){ loadDemoBtn.onclick=()=>toast('Demo data is disabled. Please import an Excel or CSV file.'); }
const refreshDashBtn=$('#refreshDashBtn');
if(refreshDashBtn){ refreshDashBtn.onclick=async()=>{ setBusy('Refreshing dashboard...'); try{ await loadReports(); await loadLogs(); renderAll(); toast('Dashboard refreshed.'); }catch(err){ toast(err.message || 'Refresh failed.'); }finally{ clearBusy(); } }; }

function renderReports(){
  const el=$('#reportsList');
  if(!state.reports.length){ el.innerHTML='<div class="panel muted">No generated reports yet.</div>'; return; }
  el.innerHTML=state.reports.map(r=>`<article class="report-card"><div><h3>${escapeHtml(r.title)}</h3><p>${r.responses} responses • ${r.mean.toFixed(2)}/5.00 • ${Math.round(r.satisfaction)}% satisfaction • ${new Date(r.created).toLocaleString()}</p></div><button class="primary" onclick="openReport(${r.id})">View Report</button></article>`).join('');
}
$('#clearReportsBtn').onclick=async()=>{
  if(!confirm('Soft-delete all visible reports from Supabase?')) return;
  setBusy('Updating Supabase reports...');
  try{
    for(const r of state.reports){ await db.from('reports').update({status:'Deleted', deleted_at:nowISO(), modified_at:nowISO()}).eq('id', r.id); }
    await log('DELETE','Soft deleted all visible reports','REPORT');
    await loadReports(); renderAll();
  }catch(err){ toast(err.message || 'Unable to clear reports.'); }
  finally{ clearBusy(); }
};
function renderLogs(){
  const rows=$('#logRows'); if(!rows) return;
  rows.innerHTML = (state.logs||[]).slice(0,80).map(l=>`<tr><td>${new Date(l.logged_at || l.time || Date.now()).toLocaleString()}</td><td>${escapeHtml(l.username || l.user || '')}</td><td>${escapeHtml(l.action || '')}</td><td>${escapeHtml(l.details || '')}</td></tr>`).join('') || '<tr><td colspan="4">No logs yet.</td></tr>';
}
function strongest(obj){ const e=Object.entries(obj||{}).sort((a,b)=>Number(b[1])-Number(a[1]))[0]; return e?`${e[0]} (${e[1]})`:'No data'; }
function percentPart(obj){
  const entries=Object.entries(obj||{}).sort((a,b)=>Number(b[1])-Number(a[1]));
  const total=entries.reduce((a,[,v])=>a+Number(v),0);
  if(!entries.length || !total) return 'No profile count was detected in the uploaded Excel file.';
  const [label,count]=entries[0];
  return `${label} recorded the largest count with ${count} respondent(s), representing ${(Number(count)/total*100).toFixed(2)}% of the detected entries.`;
}
function listTop(obj, limit=3){ return Object.entries(obj||{}).slice(0,limit).map(([k,v])=>`${k} (${v})`).join(', ') || 'No data'; }
function topLower(r, n=6){ return [...(r.items||[])].sort((a,b)=>a.mean-b.mean).slice(0,n); }
function topHigher(r, n=4){ return [...(r.items||[])].sort((a,b)=>b.mean-a.mean).slice(0,n); }
function summaryRows(r){
  const top=r.items?.[0], low=r.items?.[r.items.length-1];
  const profileName=r.type==='job'?'Years in Service':'Sex/Gender';
  const profileValue=r.type==='job'?listTop(r.years,3):listTop(r.gender,3);
  return [
    ['Survey Type', surveyLabel(r.type)],
    ['Reporting Coverage', coverageFromReport(r)],
    ['Total Valid Responses', r.responses],
    ['Measured Indicators', r.items?.length || 0],
    ['Overall Weighted Mean', `${r.mean.toFixed(2)}/5.00`],
    ['Satisfaction Percentage', `${r.satisfaction.toFixed(2)}%`],
    ['General Interpretation', interpretationLabel(r.mean)],
    ['Highest-Rated Indicator', top?`${cleanItemName(top.name)} (${top.mean.toFixed(2)}/5.00)`:'No rating items detected'],
    ['Lowest-Rated Indicator', low?`${cleanItemName(low.name)} (${low.mean.toFixed(2)}/5.00)`:'No rating items detected'],
    ['Indicators Below 4.00 Benchmark', r.belowBenchmark?.length?r.belowBenchmark.slice(0,8).join(', '):'No indicator below 4.00'],
    ['Assignment Status', listTop(r.assignment,3)],
    [profileName, profileValue],
    [`${profileName} Interpretation`, r.type==='job'?percentPart(r.years):percentPart(r.gender)],
    ['Written Remarks', r.remarks?.length || 0]
  ];
}
function narrative(r){
  const top=r.items?.[0], low=r.items?.[r.items.length-1];
  const below=topLower(r,6).map(x=>`${cleanItemName(x.name)} (${x.mean.toFixed(2)})`).join(', ') || 'No lower-rated item was detected';
  const strong=topHigher(r,4).map(x=>`${cleanItemName(x.name)} (${x.mean.toFixed(2)})`).join(', ') || 'No high-rated item was detected';
  const profileInterp = r.type==='job' ? percentPart(r.years) : percentPart(r.gender);
  const secondProfile = r.type==='job' ? `Rank/Grade distribution shows ${percentPart(r.rank)} Living arrangement records show ${percentPart(r.living)}` : `Customer type records show ${percentPart(r.customerType)} Region records show ${percentPart(r.region)} Service availed records show ${percentPart(r.service)}`;
  if(r.type==='job'){
    return `This summative report presents the Job Satisfaction and Work Experience Survey for ${coverageFromReport(r)}. The uploaded Excel file contains ${r.responses} valid response(s) and ${r.items.length} measured job-satisfaction indicator(s). The overall weighted mean is ${r.mean.toFixed(2)}/5.00, equivalent to ${r.satisfaction.toFixed(2)}%, with a general interpretation of ${interpretationLabel(r.mean)}. This means that the overall personnel work experience is generally favorable, but the lower-scoring indicators should still be used as guide points for closer review and follow-up action.\n\nThe strongest survey area is ${top?`${cleanItemName(top.name)} with a mean of ${top.mean.toFixed(2)}/5.00`:'not available'}, while the lowest-rated area is ${low?`${cleanItemName(low.name)} with a mean of ${low.mean.toFixed(2)}/5.00`:'not available'}. Stronger areas include ${strong}. Lower areas for review include ${below}. These results should be read together because the overall mean is shaped not only by the best-rated items, but also by the recurring concerns found in workload, recognition, communication, procedure clarity, and other lower-rated dimensions when they appear in the uploaded file.\n\nRespondent composition is also important to the interpretation. Assignment status shows ${percentPart(r.assignment)} For Years in Service, ${profileInterp} ${secondProfile}. Because some categories may have more respondents than others, the report should be interpreted as a weighted picture of the groups most represented in the dataset, while smaller groups remain useful for comparison. The report also includes ${r.remarks.length} written remark(s), which should be checked against the lowest-rated indicators to identify concrete reasons behind the scores.`;
  }
  return `This summative report presents the Client Satisfaction Measurement Survey for ${coverageFromReport(r)}. The uploaded Excel file contains ${r.responses} valid response(s) and ${r.items.length} service-quality indicator(s). The overall weighted mean is ${r.mean.toFixed(2)}/5.00, equivalent to ${r.satisfaction.toFixed(2)}%, with a general interpretation of ${interpretationLabel(r.mean)}. This result summarizes how clients assessed the quality, convenience, responsiveness, reliability, communication, cost, security, assurance, and outcome of the service transaction.\n\nThe strongest service area is ${top?`${cleanItemName(top.name)} with a mean of ${top.mean.toFixed(2)}/5.00`:'not available'}, while the lowest-rated area is ${low?`${cleanItemName(low.name)} with a mean of ${low.mean.toFixed(2)}/5.00`:'not available'}. Stronger areas include ${strong}. Lower areas for review include ${below}. These areas should be used to identify which parts of the client-service process are already performing well and which parts may require improved communication, easier access, shorter processing time, clearer requirements, or better online support.\n\nRespondent profile interpretation shows that ${profileInterp} ${secondProfile}. Citizen’s Charter responses and service-availment entries should be read with the satisfaction scores because they explain whether respondents were aware of service requirements and whether the transaction experience was clear. The report includes ${r.remarks.length} written remark(s), which should be reviewed as qualitative evidence for service improvement and client-experience monitoring.`;
}
function miniTable(obj, empty='No data detected.'){ const entries=Object.entries(obj||{}); return entries.length?entries.map(([a,b])=>`<tr><th>${escapeHtml(a)}</th><td>${escapeHtml(b)}</td></tr>`).join(''):`<tr><td colspan="2">${escapeHtml(empty)}</td></tr>`; }
function reportDoc(r){
  const rows=summaryRows(r);
  const low=topLower(r,4), high=topHigher(r,3);
  const profileObj = r.type==='job' ? r.years : r.gender;
  const profileTitle = r.type==='job' ? 'Years in Service' : 'Sex/Gender Distribution';
  const secondaryTitle = r.type==='job' ? 'Rank/Grade and Living Arrangement' : 'Customer Type, Region, and Service Availed';
  const secondaryTables = r.type==='job' ? `<div class="two-col"><table>${miniTable(r.rank)}</table><table>${miniTable(r.living)}</table></div>` : `<div class="two-col"><table>${miniTable(r.customerType)}</table><table>${miniTable(r.region)}</table></div><table>${miniTable(r.service)}</table>`;
  const trendRows = (r.trend||[]).map(x=>`<tr><td>${escapeHtml(x.month)}</td><td>${x.responses}</td><td>${Number(x.mean||r.mean).toFixed(2)}/5.00</td></tr>`).join('') || '<tr><td colspan="3">Trend data will appear when valid date entries are detected.</td></tr>';
  const remarkRows=(r.remarks||[]).slice(0,8).map((x,i)=>`<p>${i+1}. ${escapeHtml(x)}</p>`).join('') || '<p>No written remarks were provided in the uploaded file.</p>';
  return `<article class="report-doc">
    <div class="pdf-head"><strong>ARMY 2040: WORLD CLASS. MULTI-MISSION READY. CROSS-DOMAIN CAPABLE</strong><b>HEADQUARTERS PHILIPPINE ARMY<br>OFFICE OF THE ADJUTANT<br>Fort Andres Bonifacio, Taguig City</b></div>
    <div class="memo-line"><span>OADJ</span><span>${new Date(r.created).toLocaleDateString('en-PH', {day:'2-digit', month:'long', year:'numeric'})}</span></div>
    <p><strong>SUBJECT:</strong> ${escapeHtml(r.title)}</p><p><strong>TO:</strong> Adjutant, PA<br>Post<br>Attn: Admin</p>
    <h2>1. Summary Report</h2><table class="summary-table"><thead><tr><th>Summary Item</th><th>Result</th></tr></thead><tbody>${rows.map(([a,b])=>`<tr><td>${escapeHtml(a)}</td><td>${escapeHtml(b)}</td></tr>`).join('')}</tbody></table>
    <h2>2. Narrative Interpretation</h2>${narrative(r).split('\n\n').map(x=>`<p>${escapeHtml(x)}</p>`).join('')}
    <div class="kpi-grid"><div><span>Total Responses</span><strong>${r.responses}</strong></div><div><span>Overall Mean</span><strong>${r.mean.toFixed(2)}/5</strong></div><div><span>Weighted Satisfaction</span><strong>${r.satisfaction.toFixed(2)}%</strong></div><div><span>Lowest Area</span><strong>${r.items.at(-1)?cleanItemName(r.items.at(-1).name):'N/A'}</strong></div></div>
    <h2>3. Data Gathering and Analytical Basis</h2><p>Data were gathered from the uploaded Excel worksheet. Each row was treated as one respondent entry. Valid rating responses were converted into a five-point scale. For job satisfaction reports, negative statements were reverse-scored so that higher values consistently represent more favorable results. The analysis uses both scores and response counts to avoid overreading categories with small respondent volume.</p>
    <h2>4. Key Survey Findings and Interpretation</h2><table><thead><tr><th>Finding</th><th>Result</th><th>Interpretation</th></tr></thead><tbody><tr><td>Overall Rating</td><td>${r.mean.toFixed(2)}/5.00 (${r.satisfaction.toFixed(2)}%)</td><td>${interpretationLabel(r.mean)}</td></tr><tr><td>Highest Indicator</td><td>${r.items[0]?cleanItemName(r.items[0].name)+' ('+r.items[0].mean.toFixed(2)+')':'N/A'}</td><td>Strongest area to sustain and monitor in succeeding survey periods.</td></tr><tr><td>Lowest Indicator</td><td>${r.items.at(-1)?cleanItemName(r.items.at(-1).name)+' ('+r.items.at(-1).mean.toFixed(2)+')':'N/A'}</td><td>Primary area for closer review with remarks and profile distribution.</td></tr><tr><td>Improvement Focus</td><td>${low.map(x=>cleanItemName(x.name)).join(', ')}</td><td>Lower-scoring areas that may need management attention and follow-up.</td></tr></tbody></table>
    <h2>5. Month-on-Month Trend Analysis</h2><table><thead><tr><th>Period</th><th>Responses</th><th>Mean</th></tr></thead><tbody>${trendRows}</tbody></table>
    <h2>6. Dashboard Summary by Indicators</h2><table><thead><tr><th>Code</th><th>Dimension</th><th>Mean</th><th>Responses</th></tr></thead><tbody>${r.items.map((x,i)=>`<tr><td>${escapeHtml(x.code||'Q'+(i+1))}</td><td>${escapeHtml(cleanItemName(x.name))}</td><td>${Number(x.mean).toFixed(2)}</td><td>${x.count}</td></tr>`).join('') || '<tr><td colspan="4">No rating indicators detected.</td></tr>'}</tbody></table>
    <h2>7. ${escapeHtml(profileTitle)}</h2><table>${miniTable(profileObj)}</table><p>${escapeHtml(r.type==='job'?percentPart(r.years):percentPart(r.gender))}</p>
    <h2>8. Assignment and Other Profile Details</h2><table>${miniTable(r.assignment)}</table><h3>${escapeHtml(secondaryTitle)}</h3>${secondaryTables}
    <h2>9. Lower and Higher Rated Survey Areas</h2><table><thead><tr><th>Priority Area</th><th>Survey Interpretation</th><th>Expected Survey Focus</th></tr></thead><tbody>${[...low,...high.slice(0,1)].map(x=>`<tr><td>${escapeHtml(cleanItemName(x.name))}<br>Mean: ${x.mean.toFixed(2)}/5.00</td><td>${x.mean<4?'Review this lower-rated area with remarks and respondent profile data.':'Maintain this strong area and observe its consistency in future survey cycles.'}</td><td>${x.mean<4?'Clearer interpretation and possible improvement in the next cycle.':'Sustain high rating and use as a reference point.'}</td></tr>`).join('')}</tbody></table>
    <h2>10. Notable Qualitative Remarks</h2><div class="remarks-list">${remarkRows}</div>
    <div class="sign-row"><div><strong>Prepared By:</strong><br><br><u>Prepared By</u></div><div><strong>Certified By:</strong><br><br><u>Certified By</u></div></div>
    <div class="pdf-foot"><strong>HONOR. PATRIOTISM. DUTY.</strong></div>
  </article>`;
}
window.openReport = (id)=>{ const r=state.reports.find(x=>String(x.id)===String(id)); if(!r) return; try{ $('#reportContent').innerHTML = reportDoc(r); document.body.classList.add('pdf-preview-open'); $('#reportModal').classList.remove('hidden'); }catch(err){ console.error('Report preview error:', err); toast('Report preview failed. Please regenerate the report.'); } };
function closeReportModal(){
  $('#reportModal').classList.add('hidden');
  document.body.classList.remove('pdf-preview-open');
}
$('#closeModal').onclick=closeReportModal;
const reportModalEl = $('#reportModal');
if(reportModalEl){
  reportModalEl.addEventListener('click', (e)=>{ if(e.target === reportModalEl) closeReportModal(); });
}
document.addEventListener('keydown', (e)=>{ if(e.key === 'Escape' && !$('#reportModal')?.classList.contains('hidden')) closeReportModal(); });
$('#printReportBtn').onclick=()=>printCurrentReport();

$('#profileForm').onsubmit=async e=>{
  e.preventDefault();
  setBusy('Saving profile to Supabase...');
  try{
    await updateUserProfile(state.currentUser, $('#displayName').value.trim(), $('#officeName').value.trim(), $('#rolePosition')?.value.trim() || 'Administrator');
    hydrateUser(); await log('EDIT','Updated account information','USER',state.currentUser); toast('Account information saved.');
  }catch(err){ toast(err.message || 'Unable to save account information.'); }
  finally{ clearBusy(); }
};
$('#passwordForm').onsubmit=async e=>{
  e.preventDefault();
  const u=currentUser();
  setBusy('Updating password in Supabase...');
  try{
    if(!(await verifyPassword($('#currentPassword').value, u.password_hash))) return toast('Current password is incorrect.');
    if($('#newPassword').value.length<4) return toast('New password must contain at least 4 characters.');
    if($('#newPassword').value!==$('#confirmPassword').value) return toast('Passwords do not match.');
    await updateUserPassword(state.currentUser, $('#newPassword').value);
    state.userRow = await fetchUser(state.currentUser);
    await log('EDIT','Password updated','USER',state.currentUser);
    e.target.reset(); toast('Password updated.');
  }catch(err){ toast(err.message || 'Unable to update password.'); }
  finally{ clearBusy(); }
};



/* ==========================================================
   OFMS Apple-style dashboard/report upgrades
   ========================================================== */

let lastUnreadCount = Number(sessionStorage.getItem('ofms_last_unread_count') || 0);
let notificationsPrimed = false;
function playNotificationSound(){
  try{
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.10, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.24);
  }catch(e){ /* browser may block sound until user interaction */ }
}

const NOTIF_READ_KEY = 'ofms_notifications_last_read_v2';
const NOTIF_READ_ITEM_KEY = 'ofms_notifications_read_items_v1';
let pendingPrintReportId = null;
let pdfSignatories = { preparedName:'', preparedOffice:'', certifiedName:'', certifiedOffice:'' };
let currentPrintReportId = null;

function cleanPdfFilePart(value){
  return String(value || '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function pdfDocumentTitle(r){
  if(!r) return 'OFMS Survey Report';
  const typeTitle = r.type === 'job'
    ? 'OFMS Job Satisfaction and Work Experience Survey Report'
    : 'OFMS Client Satisfaction Measurement Survey Report';
  const coverage = cleanPdfFilePart(coverageFromReport(r));
  const date = new Date(r.created || Date.now()).toISOString().slice(0,10);
  return [typeTitle, coverage, date].filter(Boolean).join(' - ');
}

function reportDateMs(r){ return new Date(r.created || r.uploaded_at || Date.now()).getTime(); }
function latestReportByType(type){ return state.reports.filter(r=>r.type===type).sort((a,b)=>reportDateMs(b)-reportDateMs(a))[0] || null; }
function hasCountData(obj){ return Object.values(obj || {}).some(v=>Number(v)>0); }
function latestReportWithCount(field, type=null){
  return state.reports
    .filter(r=>(!type || r.type===type) && hasCountData(r?.[field]))
    .sort((a,b)=>reportDateMs(b)-reportDateMs(a))[0] || null;
}
function importantDashboardInfo(r){
  if(!r) return '<p class="muted empty-state">No report generated yet for this survey type.</p>';
  const top = r.items?.[0];
  const low = r.items?.[r.items.length-1];
  const profile = r.type==='job'
    ? `Years: ${strongest(r.years)} • Assignment: ${strongest(r.assignment)}`
    : `Gender: ${strongest(r.gender)} • Service: ${strongest(r.service || r.customerType)}`;
  const below = (r.belowBenchmark||[]).slice(0,4).join(', ') || 'No item below benchmark';
  return [
    infoLine('Report Title', r.title),
    infoLine('Coverage', r.coverage || coverageFromReport(r)),
    infoLine('Valid Responses', r.responses),
    infoLine('Measured Indicators', r.items?.length || 0),
    infoLine('Overall Result', `${r.mean.toFixed(2)}/5.00 • ${r.satisfaction.toFixed(2)}% • ${interpretationLabel(r.mean)}`),
    infoLine('Highest Area', top ? `${cleanItemName(top.name)} (${top.mean.toFixed(2)})` : 'No rating items'),
    infoLine('Lowest Area', low ? `${cleanItemName(low.name)} (${low.mean.toFixed(2)})` : 'No rating items'),
    infoLine('Profile Focus', profile),
    infoLine('Priority Areas', below),
    infoLine('Written Remarks', `${r.remarks?.length || 0} remark(s)`)
  ].join('');
}

function renderDashboard(){
  const latest = latestReport();
  const csm = latestReportByType('csm');
  const job = latestReportByType('job');
  $('#metricReports').textContent = state.reports.length;
  $('#metricResponses').textContent = totalResponses();
  $('#metricCsmMean').textContent = csm ? csm.mean.toFixed(2) : '0.00';
  $('#metricCsmSatisfaction').textContent = csm ? csm.satisfaction.toFixed(2)+'%' : '0%';
  $('#metricJobMean').textContent = job ? job.mean.toFixed(2) : '0.00';
  $('#metricJobSatisfaction').textContent = job ? job.satisfaction.toFixed(2)+'%' : '0%';
  $('#metricLatestType').textContent = latest ? (latest.type === 'job' ? 'Job Satisfaction' : 'Client Satisfaction') : '—';
  const latestTitleEl = $('#metricLatestTitle');
  if(latestTitleEl) latestTitleEl.textContent = latest ? latest.title : 'No survey report available yet.';
  $('#metricCoverage').textContent = latest ? (latest.coverage || coverageFromReport(latest)) : '—';
  const profileBase = latest || csm || job;
  const genderReport = latestReportWithCount('gender') || profileBase;
  const statusReport = latestReportWithCount('assignment','job') || latestReportWithCount('assignment') || job || profileBase;
  const genderData = normalizeCountMap(genderReport?.gender || {}, classifyGender);
  const statusData = normalizeCountMap(statusReport?.assignment || {}, classifyStatus);
  $('#genderSub').textContent = hasCountData(genderData)
    ? `Showing latest Sex/Gender data from ${genderReport?.title || 'saved report'}`
    : 'No Sex/Gender column detected in saved reports.';
  renderDonut('#genderChart','#genderLegend', genderData, ['#007aff','#ff2d55','#8e8e93']);
  renderDonut('#statusChart','#statusLegend', statusData, ['#ff9500','#34c759','#8e8e93']);
  renderTrend();
  renderMiniBars('#meanCompareChart', [
    {label:'CSM', value:csm ? Number(csm.mean||0) : 0, className:'blue'},
    {label:'Job', value:job ? Number(job.mean||0) : 0, className:'purple'}
  ], {max:5, decimals:2, suffix:'/5.00', caption:'Comparison of the latest weighted mean per survey type.'});
  renderMiniBars('#satisfactionCompareChart', [
    {label:'CSM', value:csm ? Number(csm.satisfaction||0) : 0, className:'green'},
    {label:'Job', value:job ? Number(job.satisfaction||0) : 0, className:'orange'}
  ], {max:100, decimals:2, suffix:'%', caption:'Overall satisfaction percentage per survey type.'});
  const csmTotals = typeTotals('csm'), jobTotals = typeTotals('job');
  renderMiniBars('#responseTypeChart', [
    {label:'CSM Responses', value:csmTotals.responses, className:'blue'},
    {label:'Job Responses', value:jobTotals.responses, className:'purple'},
    {label:'CSM Reports', value:csmTotals.reports, className:'green'},
    {label:'Job Reports', value:jobTotals.reports, className:'orange'}
  ], {caption:'Total saved reports and valid responses by survey type.'});
  renderMiniBars('#latestAreaSnapshotChart', latestAreaRows(latest, 5), {max:5, decimals:2, suffix:'/5.00', caption:latest ? `Top survey areas from the latest ${surveyLabel(latest.type)} report.` : 'Generate a report to see the latest survey area snapshot.'});
  renderMiniBars('#latestCsmAreasChart', latestAreaRows(csm, 5), {max:5, decimals:2, suffix:'/5.00', caption:csm ? 'Highest-rated client satisfaction survey areas.' : 'No CSM report has been generated yet.'});
  renderMiniBars('#latestJobAreasChart', latestAreaRows(job, 5), {max:5, decimals:2, suffix:'/5.00', caption:job ? 'Highest-rated job satisfaction survey areas.' : 'No Job Satisfaction report has been generated yet.'});
  renderMiniBars('#latestProfileGraph', profileRows(profileBase, 5), {caption:profileBase ? 'Most visible respondent profile groups in the latest available survey.' : 'Generate a report to see respondent profile groupings.'});
  const health=$('#dataHealthStatus'), healthDetails=$('#dataHealthDetails');
  if(health && healthDetails){
    if(!latest){ health.textContent='Data Health: Waiting'; healthDetails.textContent='Generate a report to view quality checks.'; }
    else {
      const issues=[];
      if(!latest.responses) issues.push('no valid responses');
      if(!latest.items?.length) issues.push('no rating indicators');
      if(!latest.coverage && !(latest.date_from||latest.date_to)) issues.push('no date coverage');
      health.textContent = issues.length ? 'Data Health: Review Needed' : 'Data Health: Ready';
      healthDetails.textContent = issues.length ? `Check ${issues.join(', ')}.` : `${surveyLabel(latest.type)} has ${latest.responses} responses, ${latest.items?.length||0} indicators, and ${latest.remarks?.length||0} remarks.`;
    }
  }

  const cmp=dashboardComparisonText(csm, job);
  setTextIfExists('#compareStatus', cmp.status);
  setTextIfExists('#compareDetails', cmp.details);
  const priority=dashboardPriorityText(latest);
  setTextIfExists('#priorityStatus', priority.status);
  setTextIfExists('#priorityDetails', priority.details);
  const act=dashboardActivityText();
  setTextIfExists('#activityStatus', act.status);
  setTextIfExists('#activityDetails', act.details);
}


function renderMiniBars(sel, rows, opts={}){
  const el=$(sel); if(!el) return;
  const data=(rows||[]).filter(r=>Number(r.value||0)>0);
  if(!data.length){ el.className='mini-graph empty'; el.innerHTML='<div>No chart data available yet.</div>'; return; }
  const max=opts.max || Math.max(...data.map(r=>Number(r.value||0)),1);
  const suffix = opts.suffix || '';
  const decimals = opts.decimals ?? 0;
  const trackClass = opts.trackClass || 'blue';
  el.className='mini-graph';
  el.innerHTML = data.map(r=>{
    const value=Number(r.value||0);
    const pct=Math.max(6,(value/max)*100);
    const display = typeof opts.formatter==='function' ? opts.formatter(value,r) : `${value.toFixed(decimals)}${suffix}`;
    return `<div class="mini-bar-row"><span>${escapeHtml(r.label)}</span><div class="mini-bar-track ${escapeHtml(r.className || trackClass)}"><b style="width:${pct}%"></b></div><em>${escapeHtml(display)}</em></div>`;
  }).join('') + (opts.caption ? `<p class="graph-caption">${escapeHtml(opts.caption)}</p>` : '');
}
function latestAreaRows(report, limit=5){
  if(!report?.items?.length) return [];
  return [...report.items].sort((a,b)=>Number(b.mean||0)-Number(a.mean||0)).slice(0,limit).map((x,i)=>({label: cleanItemName(x.name || x.code || `Area ${i+1}`), value:Number(x.mean||0), className:i===0?'green':'blue'}));
}
function profileRows(report, limit=5){
  if(!report) return [];
  const source = report.type==='job'
    ? (Object.keys(report.years||{}).length ? report.years : (Object.keys(report.assignment||{}).length ? report.assignment : report.rank))
    : (Object.keys(report.customerType||{}).length ? report.customerType : (Object.keys(report.service||{}).length ? report.service : report.region));
  const entries = Object.entries(source || {}).filter(([,v])=>Number(v)>0).sort((a,b)=>Number(b[1])-Number(a[1])).slice(0,limit);
  return entries.map(([label,val],i)=>({label, value:Number(val), className:i%2===0?'purple':'orange'}));
}
function typeTotals(type){
  const rows = state.reports.filter(r=>r.type===type);
  return {
    reports: rows.length,
    responses: rows.reduce((a,r)=>a+Number(r.responses||0),0),
    latest: rows.sort((a,b)=>reportDateMs(b)-reportDateMs(a))[0] || null
  };
}
function notifKey(item){
  return [item.kind || 'note', item.reportId || item.logId || '', item.time || '', item.title || ''].join('|');
}
function readNotifMap(){
  try{return JSON.parse(localStorage.getItem(NOTIF_READ_ITEM_KEY)||'{}') || {};}catch(e){return {};}
}
function markNotificationItemRead(item){
  if(!item || item.title==='No notifications') return;
  const map=readNotifMap();
  map[notifKey(item)] = Date.now();
  localStorage.setItem(NOTIF_READ_ITEM_KEY, JSON.stringify(map));
}

function notificationItems(){
  const items=[];
  const latest=latestReport();
  if(latest) items.push({time:latest.created, kind:'report', reportId:latest.id, title:'New report available', body:`${latest.title} • ${latest.responses} responses • ${latest.mean.toFixed(2)}/5.00`, preview:`Report Type: ${surveyLabel(latest.type)}\nCoverage: ${coverageFromReport(latest)}\nWeighted Mean: ${latest.mean.toFixed(2)}/5.00\nSatisfaction: ${latest.satisfaction.toFixed(2)}%`});
  (state.logs||[]).slice(0,8).forEach(l=>{
    const action = String(l.action || 'System activity').toUpperCase();
    let title = 'System activity';
    if(action==='CREATE') title = 'New item created';
    else if(action==='DELETE') title = 'Report deleted';
    else if(action==='LOGIN') title = 'Login activity';
    else if(action==='EDIT') title = 'Account update';
    else if(action==='PRINT') title = 'PDF generated';
    items.push({time:l.logged_at || nowISO(), kind:'log', logId:l.id, title, body:`${l.details || 'Activity recorded'} • ${new Date(l.logged_at || Date.now()).toLocaleString()}`, preview:`Action: ${l.action || 'System activity'}\nUser: ${l.username || state.currentUser || 'system'}\nTarget: ${l.target_type || 'SYSTEM'} ${l.target_id || ''}\nDetails: ${l.details || 'Activity recorded'}`});
  });
  items.sort((a,b)=>new Date(b.time)-new Date(a.time));
  if(!items.length) items.push({time:nowISO(), kind:'empty', title:'No notifications', body:'New reports, imports, deletes, and account activities will appear here.', preview:'No notification preview is available yet.'});
  return items;
}

function renderNotifications(){
  const list=$('#notifList'), badge=$('#notifBadge');
  if(!list || !badge) return;
  const readAt=Number(localStorage.getItem(NOTIF_READ_KEY)||0);
  const readItems=readNotifMap();
  const items=notificationItems();
  const unread=items.filter(x=>x.title!=='No notifications' && new Date(x.time).getTime()>readAt && !readItems[notifKey(x)]).length;
  if(notificationsPrimed && unread > lastUnreadCount) playNotificationSound();
  notificationsPrimed = true;
  lastUnreadCount = unread;
  sessionStorage.setItem('ofms_last_unread_count', String(unread));
  badge.textContent=unread;
  badge.style.display=unread?'grid':'none';
  list.innerHTML=items.map((x,i)=>{
    const isUnread = x.title!=='No notifications' && new Date(x.time).getTime()>readAt && !readItems[notifKey(x)];
    return `<button type="button" class="notif-item ${isUnread?'unread':'read'}" data-notif-index="${i}"><i></i><div><strong>${escapeHtml(x.title)}</strong><span>${escapeHtml(x.body)}</span></div></button>`;
  }).join('');
  $$('.notif-item[data-notif-index]').forEach(btn=>btn.onclick=()=>{ const item=items[Number(btn.dataset.notifIndex)]; markNotificationItemRead(item); renderNotifications(); showNotificationPreview(item); });
}
const _markReadBtn2=$('#markReadBtn');
if(_markReadBtn2){ _markReadBtn2.onclick=()=>{ localStorage.setItem(NOTIF_READ_KEY, String(Date.now()+1000)); localStorage.setItem(NOTIF_READ_ITEM_KEY, JSON.stringify({})); lastUnreadCount=0; sessionStorage.setItem('ofms_last_unread_count','0'); renderNotifications(); $('#notifPanel').classList.add('hidden'); toast('Notifications marked as read.'); }; }
function showNotificationPreview(item){
  if(!item) return;
  markNotificationItemRead(item);
  renderNotifications();
  const modal=$('#notifPreviewModal');
  if(!modal) return alert(`${item.title}

${item.preview || item.body}`);
  $('#notifPreviewTitle').textContent=item.title || 'Notification';
  $('#notifPreviewTime').textContent=item.time ? new Date(item.time).toLocaleString() : '';
  $('#notifPreviewBody').innerHTML = `<pre>${escapeHtml(item.preview || item.body || '')}</pre>`;
  const openBtn=$('#notifOpenReportBtn');
  if(openBtn){
    openBtn.classList.toggle('hidden', !(item.kind==='report' && item.reportId));
    openBtn.onclick=()=>{ modal.classList.add('hidden'); if(item.reportId) openReport(item.reportId); };
  }
  modal.classList.remove('hidden');
}
['#closeNotifPreview','#notifPreviewCloseBtn'].forEach(sel=>{ const b=$(sel); if(b) b.onclick=()=>$('#notifPreviewModal').classList.add('hidden'); });

async function deleteReport(id){
  if(!confirm('Delete this report? It will be hidden from the Reports page.')) return;
  setBusy('Deleting report from Supabase...');
  try{
    await db.from('reports').update({status:'Deleted', deleted_at:nowISO(), modified_at:nowISO()}).eq('id', id);
    await log('DELETE','Soft deleted report','REPORT',id);
    await loadReports(); renderAll(); toast('Report deleted.');
  }catch(err){ toast(err.message || 'Unable to delete report.'); }
  finally{ clearBusy(); }
}
window.deleteReport = deleteReport;
function filteredReports(){
  const q=($('#reportSearch')?.value || '').trim().toLowerCase();
  if(!q) return state.reports;
  return state.reports.filter(r=>{
    const hay=[r.title, surveyLabel(r.type), r.responses, r.mean?.toFixed?.(2), r.satisfaction?.toFixed?.(2), r.coverage || coverageFromReport(r), new Date(r.created).toLocaleString()].join(' ').toLowerCase();
    return hay.includes(q);
  });
}
function renderReports(){
  const el=$('#reportsList');
  const reports=filteredReports();
  if(!state.reports.length){ el.innerHTML='<div class="panel muted">No generated reports yet.</div>'; return; }
  if(!reports.length){ el.innerHTML='<div class="panel muted">No report matched the current search.</div>'; return; }
  el.innerHTML=reports.map(r=>`<article class="report-card apple-card"><div><h3>${escapeHtml(r.title)}</h3><p>${surveyLabel(r.type)} • ${r.responses} responses • ${r.mean.toFixed(2)}/5.00 • ${r.satisfaction.toFixed(2)}% • ${coverageFromReport(r)} • ${new Date(r.created).toLocaleString()}</p></div><div class="report-actions"><button class="primary" onclick="openReport(${r.id})">View Report</button><button class="ghost" onclick="openSignatoryPrompt(${r.id})">Print PDF</button><button class="danger-btn" onclick="deleteReport(${r.id})">Delete</button></div></article>`).join('');
}
const reportSearch=$('#reportSearch');
if(reportSearch){ reportSearch.oninput=()=>renderReports(); }
function exportReportsCsv(){
  const reports=filteredReports();
  if(!reports.length){ toast('No report rows to export.'); return; }
  const rows=[['Title','Survey Type','Coverage','Responses','Mean','Satisfaction %','Created']];
  reports.forEach(r=>rows.push([r.title, surveyLabel(r.type), coverageFromReport(r), r.responses, r.mean.toFixed(2), r.satisfaction.toFixed(2), new Date(r.created).toLocaleString()]));
  const csv=rows.map(row=>row.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=`OFMS_Report_Summary_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),500);
  toast('Report summary CSV exported.');
}
const exportReportsBtn=$('#exportReportsBtn');
if(exportReportsBtn){ exportReportsBtn.onclick=exportReportsCsv; }

function graphBar(values, title){
  const max=Math.max(...values.map(v=>Number(v.value)||0),1);
  return `<div class="pdf-graph"><h3>${escapeHtml(title)}</h3><div class="pdf-bars">${values.map(v=>`<div class="pdf-bar-row"><span>${escapeHtml(v.label)}</span><b style="width:${Math.max(6,(Number(v.value)/max*100))}%"></b><em>${escapeHtml(v.value)}</em></div>`).join('')}</div></div>`;
}
function graphItems(r){ const title = r.type==='job' ? 'Job Satisfaction Indicators Chart' : 'Client Satisfaction Indicators Chart'; return graphBar((r.items||[]).map((x,i)=>({label:x.code||('Q'+(i+1)), value:Number(x.mean).toFixed(2)})), title); }
function graphCounts(obj,title){ return graphBar(Object.entries(obj||{}).map(([k,v])=>({label:k,value:v})), title); }
function interpretationBlock(title, text){ return `<div class="interpretation"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(text)}</p></div>`; }
function graphInterpretation(obj, label){
  const entries=Object.entries(obj||{}).sort((a,b)=>Number(b[1])-Number(a[1]));
  const total=entries.reduce((a,[,v])=>a+Number(v),0);
  if(!entries.length || !total) return `No ${label.toLowerCase()} entries were detected from the uploaded worksheet.`;
  const [top,count]=entries[0];
  return `${top} recorded the highest count with ${count} response(s), representing ${(Number(count)/total*100).toFixed(2)}% of the detected ${label.toLowerCase()} entries. This distribution should be considered when interpreting the survey results because larger groups influence the overall picture more strongly.`;
}
function trendInterpretation(r){
  if(!r.trend || r.trend.length<2) return 'Trend data is limited because the uploaded worksheet does not contain enough dated entries for period comparison. Future uploads with timestamped responses will strengthen trend interpretation.';
  const a=r.trend[r.trend.length-2], b=r.trend[r.trend.length-1];
  const move=b.responses-a.responses;
  const meanMove = Number((b.mean||r.mean) - (a.mean||r.mean)).toFixed(2); return `Compared with ${a.month}, the latest month ${b.month} ${move>=0?'increased':'decreased'} in response volume to ${b.responses} from ${a.responses}. ${Number(meanMove)>=0?'Satisfaction improved':'Satisfaction declined'} to ${Number(b.mean||r.mean).toFixed(2)}/5.00 from ${Number(a.mean||r.mean).toFixed(2)}/5.00 (${Number(meanMove)>=0?'+':''}${meanMove} points). This ${Number(b.mean||r.mean)>=4?'indicates a strong':'indicates that the current survey result remains'} ${interpretationLabel(Number(b.mean||r.mean)).toLowerCase()}.`;
}
function signatoryHtml(){
  const p=pdfSignatories || {};
  return `<div class="sign-row"><div><strong>Prepared By:</strong><br><br><u>${escapeHtml(p.preparedName || 'Prepared By')}</u><br><span>${escapeHtml(p.preparedOffice || '')}</span></div><div><strong>Certified By:</strong><br><br><u>${escapeHtml(p.certifiedName || 'Certified By')}</u><br><span>${escapeHtml(p.certifiedOffice || '')}</span></div></div>`;
}
function reportDoc(r){
  const rows=summaryRows(r);
  const low=topLower(r,4), high=topHigher(r,3);
  const profileObj = r.type==='job' ? r.years : r.gender;
  const profileTitle = r.type==='job' ? 'Years in Service' : 'Sex/Gender Distribution';
  const profileText = r.type==='job' ? graphInterpretation(r.years,'Years in Service') : graphInterpretation(r.gender,'Sex/Gender');
  const secondaryTitle = r.type==='job' ? 'Assignment Status' : 'Client Classification and Service Details';
  const secondaryObj = r.type==='job' ? r.assignment : (Object.keys(r.service||{}).length?r.service:r.customerType);
  const trendObj = Object.fromEntries((r.trend||[]).map(x=>[x.month,x.responses]));
  const trendRows = (r.trend||[]).map(x=>`<tr><td>${escapeHtml(x.month)}</td><td>${x.responses}</td><td>${Number(x.mean||r.mean).toFixed(2)}/5.00</td></tr>`).join('') || '<tr><td colspan="3">Trend data will appear when valid date entries are detected.</td></tr>';
  const remarkRows=(r.remarks||[]).slice(0,8).filter(x=>String(x).trim() && String(x).trim()!=='.').map((x,i)=>`<p>${i+1}. ${escapeHtml(x)}</p>`).join('') || '<p>No written remarks were provided in the uploaded file.</p>';
  const itemText = r.items?.length ? `The ${r.type==='job'?'job satisfaction':'client satisfaction'} indicators chart shows the comparative performance of each measured indicator. ${r.items[0]?cleanItemName(r.items[0].name):'The highest item'} received the strongest mean score at ${r.items[0]?Number(r.items[0].mean).toFixed(2):'N/A'}/5.00, while ${r.items.at(-1)?cleanItemName(r.items.at(-1).name):'the lowest item'} recorded the lowest mean at ${r.items.at(-1)?Number(r.items.at(-1).mean).toFixed(2):'N/A'}/5.00. The overall score level is interpreted as ${interpretationLabel(r.mean)}; therefore, the graph should be read not only as a ranking, but also as a guide for identifying which areas can be sustained and which areas require process-level improvement.` : 'No rating indicators were detected from the uploaded worksheet.';
  const reportDate = new Date(r.created).toLocaleDateString('en-PH', {day:'2-digit', month:'long', year:'numeric'});
  const narrativeParts = narrative(r).split('\n\n').filter(Boolean);
  const narrativeFirst = narrativeParts.slice(0,2).map(x=>`<p>${escapeHtml(x)}</p>`).join('');
  const narrativeRest = narrativeParts.slice(2).map(x=>`<p>${escapeHtml(x)}</p>`).join('');
  const indicatorRows = r.items.map((x,i)=>`<tr><td>${escapeHtml(x.code||'Q'+(i+1))}</td><td>${escapeHtml(cleanItemName(x.name))}</td><td>${Number(x.mean).toFixed(2)}</td><td>${x.count}</td></tr>`).join('') || '<tr><td colspan="4">No rating indicators detected.</td></tr>';
  const priorityRows = [...low,...high.slice(0,1)].map(x=>`<tr><td>${escapeHtml(cleanItemName(x.name))}<br>Mean: ${x.mean.toFixed(2)}/5.00</td><td>${x.mean<4?'Review this lower-rated area with respondent remarks and profile data to understand the possible source of the lower rating.':'Maintain the condition reflected by this high score and observe whether it remains consistent in future survey periods.'}</td><td>${x.mean<4?'Clearer explanation of the low-rated area and possible improvement in the next survey cycle.':'Continued observation and preservation of strong performance.'}</td></tr>`).join('');
  return `<article class="report-doc pdf-format exact-pdf">
    <section class="pdf-page">
      <div class="pdf-head exact-head"><strong>ARMY 2040: WORLD CLASS. MULTI-MISSION READY. CROSS-DOMAIN CAPABLE</strong><b>HEADQUARTERS PHILIPPINE ARMY<br>OFFICE OF THE ADJUTANT<br>Fort Andres Bonifacio, Taguig City</b></div>
      <div class="memo-line"><span>OADJ</span><span>${reportDate}</span></div>
      <p class="memo-sub"><strong>SUBJECT:</strong> ${escapeHtml(r.title)}</p><p class="memo-sub"><strong>TO:</strong> Adjutant, PA<br>Post<br>Attn: Admin</p>
      <h2>1. Summary Report</h2>
      <table class="summary-table compact-table"><thead><tr><th>Summary Item</th><th>Result</th></tr></thead><tbody>${rows.map(([a,b])=>`<tr><td>${escapeHtml(a)}</td><td>${escapeHtml(b)}</td></tr>`).join('')}</tbody></table>
      <h2>2. Narrative Interpretation</h2>${narrativeFirst}
      ${pdfFooter()}
    </section>

    <section class="pdf-page">
      ${pdfMiniHeader()}
      ${narrativeRest || '<p>The narrative interpretation continues to explain the statistical and qualitative meaning of the report.</p>'}
      ${pdfFooter()}
    </section>

    <section class="pdf-page">
      ${pdfMiniHeader()}
      <div class="kpi-grid"><div><span>Total Responses</span><strong>${r.responses}</strong></div><div><span>Overall Mean</span><strong>${r.mean.toFixed(2)}/5</strong></div><div><span>Weighted Satisfaction</span><strong>${r.satisfaction.toFixed(2)}%</strong></div><div><span>Lowest Area</span><strong>${r.items.at(-1)?cleanItemName(r.items.at(-1).name):'N/A'}</strong></div></div>
      <h2>3. Data Gathering and Analytical Basis</h2><p>Data were gathered from the survey responses contained in the submitted worksheet. Each row was treated as one respondent entry, while the available date field was used to identify the reporting coverage and monthly trend when applicable. Rating items were converted into a five-point scale, incomplete non-rating entries were excluded from mean computation, and reverse-scored job-satisfaction items were adjusted when necessary.</p>
      <p>The interpretation considers both the score and the number of responses supporting each score. This helps prevent overreading of small groups and makes the findings more balanced across the reported categories.</p>
      <h2>4. Key Survey Findings and Interpretation</h2><table><thead><tr><th>Finding</th><th>Result</th><th>Interpretation</th></tr></thead><tbody><tr><td>Overall Rating</td><td>${r.mean.toFixed(2)}/5.00 (${r.satisfaction.toFixed(2)}%)</td><td>${interpretationLabel(r.mean)}</td></tr><tr><td>Highest Indicator</td><td>${r.items[0]?cleanItemName(r.items[0].name)+' ('+r.items[0].mean.toFixed(2)+')':'N/A'}</td><td>Strongest survey result to maintain and use as a reference point for future comparison.</td></tr><tr><td>Lowest Indicator</td><td>${r.items.at(-1)?cleanItemName(r.items.at(-1).name)+' ('+r.items.at(-1).mean.toFixed(2)+')':'N/A'}</td><td>Lowest survey result to review with response count and written remarks.</td></tr><tr><td>Primary Improvement Focus</td><td>${low.map(x=>cleanItemName(x.name)).join(', ') || 'No priority area detected'}</td><td>Survey area that may need closer review in succeeding survey cycles.</td></tr></tbody></table>
      ${pdfFooter()}
    </section>

    <section class="pdf-page">
      ${pdfMiniHeader()}
      <h2>5. Month-on-Month Trend Analysis</h2><table><thead><tr><th>Period</th><th>Responses</th><th>Mean</th></tr></thead><tbody>${trendRows}</tbody></table>
      ${graphCounts(trendObj, 'Month-on-Month Response Volume')}
      <p>${escapeHtml(trendInterpretation(r))}</p>
      ${pdfFooter()}
    </section>

    <section class="pdf-page">
      ${pdfMiniHeader()}
      <h2>6. Dashboard Summary by ${r.type==='job'?'Job Satisfaction':'Client Satisfaction'} Indicators</h2>
      <table class="indicator-table"><thead><tr><th>Code</th><th>Dimension</th><th>Mean</th><th>Responses</th></tr></thead><tbody>${indicatorRows}</tbody></table>
      ${pdfFooter()}
    </section>

    <section class="pdf-page">
      ${pdfMiniHeader()}
      ${graphItems(r)}
      <p>${escapeHtml(itemText)}</p>
      ${pdfFooter()}
    </section>

    <section class="pdf-page">
      ${pdfMiniHeader()}
      <h2>7. ${escapeHtml(secondaryTitle)}</h2><table>${miniTable(secondaryObj)}</table>${graphCounts(secondaryObj, secondaryTitle)}
      <p>${escapeHtml(graphInterpretation(secondaryObj, secondaryTitle))}</p>
      ${pdfFooter()}
    </section>

    <section class="pdf-page">
      ${pdfMiniHeader()}
      <h2>8. ${escapeHtml(profileTitle)}</h2><table>${miniTable(profileObj)}</table>${graphCounts(profileObj, profileTitle)}
      <p>${escapeHtml(profileText)}</p>
      ${pdfFooter()}
    </section>

    <section class="pdf-page">
      ${pdfMiniHeader()}
      <h2>9. Lower and Higher Rated Survey Areas</h2><table><thead><tr><th>Priority Area</th><th>Survey Interpretation</th><th>Expected Survey Focus</th></tr></thead><tbody>${priorityRows}</tbody></table>
      <h2>10. Notable Qualitative Remarks</h2><div class="remarks-list">${remarkRows}</div>
      ${signatoryHtml()}
      ${pdfFooter()}
    </section>
  </article>`;
}
function pdfMiniHeader(){ return `<div class="pdf-mini-head"><strong>ARMY 2040: WORLD CLASS. MULTI-MISSION READY. CROSS-DOMAIN CAPABLE</strong></div>`; }
function pdfFooter(){ return `<div class="pdf-foot"><div class="pdf-logos"><img class="strip" src="assets/pgs_logos.jpg" alt="PGS logos"><strong>HONOR. PATRIOTISM. DUTY.</strong><img class="atr" src="assets/atr_logo.jpg" alt="ATR 2040 logo"></div></div>`; }



function printCurrentReport(){
  const modal = $('#reportModal');
  const content = $('#reportContent')?.innerHTML || '';
  if(!content){ toast('No report preview is open.'); return; }
  try{
    modal.classList.remove('hidden');
    document.body.classList.add('printing-report');
    setTimeout(()=>{
      window.focus();
      window.print();
      setTimeout(()=>document.body.classList.remove('printing-report'), 900);
    }, 120);
  }catch(err){
    console.error('PDF print failed:', err);
    document.body.classList.remove('printing-report');
    toast('PDF export failed. Please reopen the report and try again.');
  }
}


function openSignatoryPrompt(reportId){
  pendingPrintReportId = reportId;
  const m=$('#signatoryModal'); if(m) m.classList.remove('hidden');
}
function closeSignatoryPrompt(){ const m=$('#signatoryModal'); if(m) m.classList.add('hidden'); }
const closeSig=$('#closeSignatoryModal'); if(closeSig) closeSig.onclick=closeSignatoryPrompt;
const cancelSig=$('#cancelSignatoryBtn'); if(cancelSig) cancelSig.onclick=closeSignatoryPrompt;
const savePrint=$('#savePrintPdfBtn'); if(savePrint){ savePrint.onclick=()=>{
  pdfSignatories = {
    preparedName: $('#preparedName')?.value.trim() || '',
    preparedOffice: $('#preparedOffice')?.value.trim() || '',
    certifiedName: $('#certifiedName')?.value.trim() || '',
    certifiedOffice: $('#certifiedOffice')?.value.trim() || ''
  };
  closeSignatoryPrompt();
  if(pendingPrintReportId){ log('PRINT','Generated PDF from report viewer','REPORT',pendingPrintReportId); openReport(pendingPrintReportId); setTimeout(()=>printCurrentReport(), 350); }
};}

$('#generateBtn').onclick = async () => {
  if(!importedRows.length) { toast('Please import an Excel or CSV file before generating a report.'); return; }
  setBusy('Generating complete survey report...');
  try{
    const type=$('#surveyType').value==='auto'?detectType(importedRows, importedFileName):$('#surveyType').value;
    const title=$('#reportTitle').value.trim() || surveyLabel(type);
    const draft=analyzeRows(importedRows, type, title);
    const saved = await saveReportToSupabase(draft);
    await log('CREATE', `${title} generated with ${saved.responses} responses`, 'REPORT', saved.id);
    localStorage.removeItem(NOTIF_READ_KEY);
    importedRows=[]; $('#preview').textContent='Report generated and saved to Supabase. Enter signatories to continue PDF export.';
    await loadReports(); renderAll(); showPage('reports'); openSignatoryPrompt(saved.id);
  }catch(err){ toast(err.message || 'Report generation failed.'); }
  finally{ clearBusy(); }
};


$$('.ux-tile[data-go]').forEach(btn=>{ btn.onclick=()=>showPage(btn.dataset.go); });

(async function init(){
  const remembered = readSession();
  if(remembered?.username){
    state.currentUser = remembered.username;
    await bootApp();
    return;
  }
  $('#authView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
})();


/* Final PDF paging rebuild: removes blank pages and prevents content overlap */
function pdfPage(content, extraClass=''){
  const clean = String(content || '').trim();
  if(!clean) return '';
  return `<section class="pdf-page ${extraClass}">${clean}${pdfFooter()}</section>`;
}
function reportDoc(r){
  const rows=summaryRows(r);
  const low=topLower(r,4), high=topHigher(r,3);
  const profileObj = r.type==='job' ? r.years : r.gender;
  const profileTitle = r.type==='job' ? 'Years in Service' : 'Sex/Gender Distribution';
  const profileText = r.type==='job' ? graphInterpretation(r.years,'Years in Service') : graphInterpretation(r.gender,'Sex/Gender');
  const secondaryTitle = r.type==='job' ? 'Assignment Status' : 'Client Classification and Service Details';
  const secondaryObj = r.type==='job' ? r.assignment : (Object.keys(r.service||{}).length?r.service:r.customerType);
  const trendObj = Object.fromEntries((r.trend||[]).map(x=>[x.month,x.responses]));
  const trendRows = (r.trend||[]).map(x=>`<tr><td>${escapeHtml(x.month)}</td><td>${x.responses}</td><td>${Number(x.mean||r.mean).toFixed(2)}/5.00</td></tr>`).join('') || '<tr><td colspan="3">Trend data will appear when valid date entries are detected.</td></tr>';
  const remarks=(r.remarks||[]).slice(0,8).filter(x=>String(x).trim() && String(x).trim()!=='.');
  const remarkRows=remarks.map((x,i)=>`<p>${i+1}. ${escapeHtml(x)}</p>`).join('') || '<p>No written remarks were provided in the uploaded file.</p>';
  const itemText = r.items?.length ? `The ${r.type==='job'?'job satisfaction':'client satisfaction'} indicators chart shows the comparative performance of each measured indicator. ${r.items[0]?cleanItemName(r.items[0].name):'The highest item'} received the strongest mean score at ${r.items[0]?Number(r.items[0].mean).toFixed(2):'N/A'}/5.00, while ${r.items.at(-1)?cleanItemName(r.items.at(-1).name):'the lowest item'} recorded the lowest mean at ${r.items.at(-1)?Number(r.items.at(-1).mean).toFixed(2):'N/A'}/5.00. The overall score level is interpreted as ${interpretationLabel(r.mean)}; therefore, the graph should be read as a guide for identifying which areas can be sustained and which areas require process-level improvement.` : 'No rating indicators were detected from the uploaded worksheet.';
  const reportDate = new Date(r.created).toLocaleDateString('en-PH', {day:'2-digit', month:'long', year:'numeric'});
  const narrativeParts = narrative(r).split('\n\n').filter(x=>String(x).trim());
  const narrativeFirst = narrativeParts.slice(0,2).map(x=>`<p>${escapeHtml(x)}</p>`).join('');
  const narrativeRest = narrativeParts.slice(2).map(x=>`<p>${escapeHtml(x)}</p>`).join('');
  const indicatorRows = (r.items||[]).map((x,i)=>`<tr><td>${escapeHtml(x.code||'Q'+(i+1))}</td><td>${escapeHtml(cleanItemName(x.name))}</td><td>${Number(x.mean).toFixed(2)}</td><td>${x.count}</td></tr>`).join('') || '<tr><td colspan="4">No rating indicators detected.</td></tr>';
  const priorityRows = [...low,...high.slice(0,1)].map(x=>`<tr><td>${escapeHtml(cleanItemName(x.name))}<br>Mean: ${x.mean.toFixed(2)}/5.00</td><td>${x.mean<4?'Review this lower-rated area with respondent remarks and profile data to understand the possible source of the lower rating.':'Maintain the condition reflected by this high score and observe whether it remains consistent in future survey periods.'}</td><td>${x.mean<4?'Clearer explanation of the low-rated area and possible improvement in the next survey cycle.':'Continued observation and preservation of strong performance.'}</td></tr>`).join('');
  const pages=[];
  pages.push(pdfPage(`
    <div class="pdf-head exact-head"><strong>ARMY 2040: WORLD CLASS. MULTI-MISSION READY. CROSS-DOMAIN CAPABLE</strong><b>HEADQUARTERS PHILIPPINE ARMY<br>OFFICE OF THE ADJUTANT<br>Fort Andres Bonifacio, Taguig City</b></div>
    <div class="memo-line"><span>OADJ</span><span>${reportDate}</span></div>
    <p class="memo-sub"><strong>SUBJECT:</strong> ${escapeHtml(r.title)}</p><p class="memo-sub"><strong>TO:</strong> Adjutant, PA<br>Post<br>Attn: Admin</p>
    <h2>1. Summary Report</h2>
    <table class="summary-table compact-table"><thead><tr><th>Summary Item</th><th>Result</th></tr></thead><tbody>${rows.map(([a,b])=>`<tr><td>${escapeHtml(a)}</td><td>${escapeHtml(b)}</td></tr>`).join('')}</tbody></table>
    <h2>2. Narrative Interpretation</h2>${narrativeFirst}
  `));
  if(narrativeRest){
    pages.push(pdfPage(`${pdfMiniHeader()}${narrativeRest}`));
  }
  pages.push(pdfPage(`
    ${pdfMiniHeader()}
    <div class="kpi-grid"><div><span>Total Responses</span><strong>${r.responses}</strong></div><div><span>Overall Mean</span><strong>${r.mean.toFixed(2)}/5</strong></div><div><span>Weighted Satisfaction</span><strong>${r.satisfaction.toFixed(2)}%</strong></div><div><span>Lowest Area</span><strong>${r.items?.at(-1)?cleanItemName(r.items.at(-1).name):'N/A'}</strong></div></div>
    <h2>3. Data Gathering and Analytical Basis</h2><p>Data were gathered from the survey responses contained in the submitted worksheet. Each row was treated as one respondent entry, while the available date field was used to identify the reporting coverage and monthly trend when applicable. Rating items were converted into a five-point scale, incomplete non-rating entries were excluded from mean computation, and reverse-scored job-satisfaction items were adjusted when necessary.</p>
    <p>The interpretation considers both the score and the number of responses supporting each score. This helps prevent overreading of small groups and makes the findings more balanced across the reported categories.</p>
    <h2>4. Key Survey Findings and Interpretation</h2><table><thead><tr><th>Finding</th><th>Result</th><th>Interpretation</th></tr></thead><tbody><tr><td>Overall Rating</td><td>${r.mean.toFixed(2)}/5.00 (${r.satisfaction.toFixed(2)}%)</td><td>${interpretationLabel(r.mean)}</td></tr><tr><td>Highest Indicator</td><td>${r.items?.[0]?cleanItemName(r.items[0].name)+' ('+r.items[0].mean.toFixed(2)+')':'N/A'}</td><td>Strongest survey result to maintain and use as a reference point for future comparison.</td></tr><tr><td>Lowest Indicator</td><td>${r.items?.at(-1)?cleanItemName(r.items.at(-1).name)+' ('+r.items.at(-1).mean.toFixed(2)+')':'N/A'}</td><td>Lowest survey result to review with response count and written remarks.</td></tr><tr><td>Primary Improvement Focus</td><td>${low.map(x=>cleanItemName(x.name)).join(', ') || 'No priority area detected'}</td><td>Survey area that may need closer review in succeeding survey cycles.</td></tr></tbody></table>
  `));
  pages.push(pdfPage(`${pdfMiniHeader()}<h2>5. Month-on-Month Trend Analysis</h2><table><thead><tr><th>Period</th><th>Responses</th><th>Mean</th></tr></thead><tbody>${trendRows}</tbody></table>${graphCounts(trendObj, 'Month-on-Month Response Volume')}<p>${escapeHtml(trendInterpretation(r))}</p>`));
  pages.push(pdfPage(`${pdfMiniHeader()}<h2>6. Dashboard Summary by ${r.type==='job'?'Job Satisfaction':'Client Satisfaction'} Indicators</h2><table class="indicator-table"><thead><tr><th>Code</th><th>Dimension</th><th>Mean</th><th>Responses</th></tr></thead><tbody>${indicatorRows}</tbody></table>`));
  pages.push(pdfPage(`${pdfMiniHeader()}${graphItems(r)}<p>${escapeHtml(itemText)}</p>`));
  pages.push(pdfPage(`${pdfMiniHeader()}<h2>7. ${escapeHtml(secondaryTitle)}</h2><table>${miniTable(secondaryObj)}</table>${graphCounts(secondaryObj, secondaryTitle)}<p>${escapeHtml(graphInterpretation(secondaryObj, secondaryTitle))}</p>`));
  pages.push(pdfPage(`${pdfMiniHeader()}<h2>8. ${escapeHtml(profileTitle)}</h2><table>${miniTable(profileObj)}</table>${graphCounts(profileObj, profileTitle)}<p>${escapeHtml(profileText)}</p>`));
  pages.push(pdfPage(`${pdfMiniHeader()}<h2>9. Lower and Higher Rated Survey Areas</h2><table><thead><tr><th>Priority Area</th><th>Survey Interpretation</th><th>Expected Survey Focus</th></tr></thead><tbody>${priorityRows}</tbody></table>`));
  pages.push(pdfPage(`${pdfMiniHeader()}<h2>10. Notable Qualitative Remarks</h2><div class="remarks-list">${remarkRows}</div>${signatoryHtml()}`));
  return `<article class="report-doc pdf-format exact-pdf">${pages.join('')}</article>`;
}

/* FINAL PDF REPORT FIX: continuous report, graph-only content, no blank manual pages */
function summaryCardsHtml(r){
  const top=r.items?.[0], low=r.items?.[r.items.length-1];
  const profileName=r.type==='job'?'Years in Service':'Sex/Gender';
  const profileValue=r.type==='job'?listTop(r.years,3):listTop(r.gender,3);
  const cards=[
    ['Survey Type', surveyLabel(r.type)],
    ['Reporting Coverage', coverageFromReport(r)],
    ['Total Valid Responses', r.responses],
    ['Measured Indicators', r.items?.length || 0],
    ['Overall Weighted Mean', `${r.mean.toFixed(2)}/5.00`],
    ['Satisfaction Percentage', `${r.satisfaction.toFixed(2)}%`],
    ['General Interpretation', interpretationLabel(r.mean)],
    ['Highest-Rated Indicator', top?`${cleanItemName(top.name)} (${top.mean.toFixed(2)}/5.00)`:'No rating items detected'],
    ['Lowest-Rated Indicator', low?`${cleanItemName(low.name)} (${low.mean.toFixed(2)}/5.00)`:'No rating items detected'],
    ['Below 4.00 Benchmark', r.belowBenchmark?.length?r.belowBenchmark.slice(0,6).join(', '):'No indicator below 4.00'],
    ['Assignment Status', listTop(r.assignment,3)],
    [profileName, profileValue]
  ];
  return `<div class="summary-card-grid">${cards.map(([a,b])=>`<div class="summary-card"><span>${escapeHtml(a)}</span><strong>${escapeHtml(String(b))}</strong></div>`).join('')}</div>`;
}
function priorityGraphHtml(r){
  const low = topLower(r,4), high = topHigher(r,2);
  const items = [...low, ...high].filter(Boolean);
  if(!items.length) return '<p>No priority areas were detected because no rating indicators were found.</p>';
  return `<div class="priority-grid">${items.map(x=>{
    const score = Math.max(0, Math.min(5, Number(x.mean)||0));
    return `<div class="priority-card"><b>${escapeHtml(cleanItemName(x.name))}</b><span>Mean Score: ${score.toFixed(2)}/5.00 - ${score < 4 ? 'For closer review' : 'Strength to sustain'}</span><div class="priority-meter"><i style="width:${(score/5*100).toFixed(1)}%"></i></div></div>`;
  }).join('')}</div>`;
}
function shortNarrative(r){
  const top=r.items?.[0], low=r.items?.[r.items.length-1];
  const profile = r.type==='job' ? percentPart(r.years) : percentPart(r.gender);
  const typeText = r.type==='job' ? 'job satisfaction and work experience' : 'client satisfaction measurement';
  const focus = topLower(r,5).map(x=>cleanItemName(x.name)).join(', ') || 'no lower-rated indicator detected';
  return [
    `This summative report presents the ${typeText} survey for ${coverageFromReport(r)}. The dataset contains ${r.responses} valid response(s) and ${r.items?.length || 0} measured indicator(s). The overall weighted mean is ${r.mean.toFixed(2)}/5.00, equivalent to ${r.satisfaction.toFixed(2)}%, and is interpreted as ${interpretationLabel(r.mean)}.`,
    `The strongest area is ${top?`${cleanItemName(top.name)} with ${top.mean.toFixed(2)}/5.00`:'not available'}, while the lowest-rated area is ${low?`${cleanItemName(low.name)} with ${low.mean.toFixed(2)}/5.00`:'not available'}. The main improvement focus includes ${focus}.`,
    `Respondent composition provides context for the scores. ${profile} The graphs below summarize the response volume, indicator performance, respondent profile, and priority areas without repeating tabular data.`
  ];
}
function reportDoc(r){
  const reportDate = new Date(r.created).toLocaleDateString('en-PH', {day:'2-digit', month:'long', year:'numeric'});
  const trendObj = Object.fromEntries((r.trend||[]).map(x=>[x.month,x.responses]));
  const trendGraph = Object.keys(trendObj).length ? graphCounts(trendObj, 'Month-on-Month Response Volume') : graphCounts({'Current Report': r.responses}, 'Current Response Volume');
  const profileObj = r.type==='job' ? r.years : r.gender;
  const profileTitle = r.type==='job' ? 'Years in Service' : 'Sex/Gender Distribution';
  const secondaryTitle = r.type==='job' ? 'Assignment Status' : 'Client Classification and Service Details';
  const secondaryObj = r.type==='job' ? r.assignment : (Object.keys(r.service||{}).length?r.service:r.customerType);
  const narrativeBlocks = shortNarrative(r).map(x=>`<p>${escapeHtml(x)}</p>`).join('');
  const profileText = r.type==='job' ? graphInterpretation(r.years,'Years in Service') : graphInterpretation(r.gender,'Sex/Gender');
  const secondaryText = graphInterpretation(secondaryObj, secondaryTitle);
  const itemText = r.items?.length ? `The indicator graph compares every measured item using its mean score. ${r.items[0]?cleanItemName(r.items[0].name):'The highest item'} recorded the highest result, while ${r.items.at(-1)?cleanItemName(r.items.at(-1).name):'the lowest item'} recorded the lowest result. This layout highlights the gap between strengths and priority areas without adding duplicate tables.` : 'No rating indicators were detected from the uploaded worksheet.';
  return `<article class="report-doc final-flow-pdf exact-pdf">
    <div class="pdf-screen-head"><strong>ARMY 2040: WORLD CLASS. MULTI-MISSION READY. CROSS-DOMAIN CAPABLE</strong><b>HEADQUARTERS PHILIPPINE ARMY<br>OFFICE OF THE ADJUTANT<br>Fort Andres Bonifacio, Taguig City</b></div>
    <div class="pdf-report-body">
      <section class="pdf-section keep-together">
        <div class="memo-line"><span>OADJ</span><span>${reportDate}</span></div>
        <p class="memo-sub"><strong>SUBJECT:</strong> ${escapeHtml(r.title)}</p>
        <p class="memo-sub"><strong>TO:</strong> Adjutant, PA<br>Post<br>Attn: Admin</p>
      </section>
      <section class="pdf-section">
        <h2>1. Summary Report</h2>
        ${summaryCardsHtml(r)}
      </section>
      <section class="pdf-section">
        <h2>2. Narrative Interpretation</h2>
        ${narrativeBlocks}
      </section>
      <section class="pdf-section keep-together">
        <div class="kpi-grid"><div><span>Total Responses</span><strong>${r.responses}</strong></div><div><span>Overall Mean</span><strong>${r.mean.toFixed(2)}/5</strong></div><div><span>Satisfaction</span><strong>${r.satisfaction.toFixed(2)}%</strong></div><div><span>Lowest Area</span><strong>${r.items?.at(-1)?escapeHtml(cleanItemName(r.items.at(-1).name)):'N/A'}</strong></div></div>
      </section>
      <section class="pdf-section">
        <h2>3. Data Gathering and Analytical Basis</h2>
        <p>Each row in the uploaded worksheet was treated as one respondent entry. Valid rating responses were converted into a five-point scale. For job satisfaction reports, negative statements were reverse-scored when applicable so that higher values consistently represent more favorable results.</p>
      </section>
      <section class="pdf-section keep-together">
        <h2>4. Survey Trend Analysis</h2>
        ${trendGraph}
        ${interpretationBlock('Trend Interpretation', trendInterpretation(r))}
      </section>
      <section class="pdf-section">
        <h2>5. Indicator Performance Graph</h2>
        ${graphItems(r)}
        ${interpretationBlock('Indicator Interpretation', itemText)}
      </section>
      <section class="pdf-section keep-together">
        <h2>6. ${escapeHtml(secondaryTitle)}</h2>
        ${graphCounts(secondaryObj, secondaryTitle)}
        ${interpretationBlock(`${secondaryTitle} Interpretation`, secondaryText)}
      </section>
      <section class="pdf-section keep-together">
        <h2>7. ${escapeHtml(profileTitle)}</h2>
        ${graphCounts(profileObj, profileTitle)}
        ${interpretationBlock(`${profileTitle} Interpretation`, profileText)}
      </section>
      <section class="pdf-section keep-together">
        <h2>8. Lower and Higher Rated Survey Areas</h2>
        ${priorityGraphHtml(r)}
        <p>The priority graph separates lower-scoring areas from stronger areas. Lower values indicate items that need closer review, while higher values show areas that may be sustained as positive survey findings.</p>
      </section>
      <section class="pdf-section keep-together">
        ${signatoryHtml()}
      </section>
    </div>
    <div class="pdf-screen-footer"><div class="pdf-logos"><img class="strip" src="assets/pgs_logos.jpg" alt="PGS logos"><strong>HONOR. PATRIOTISM. DUTY.</strong><img class="atr" src="assets/atr_logo.jpg" alt="ATR 2040 logo"></div></div>
  </article>`;
}

/* FINAL A4 PDF PAGING FIX: static header/footer per page, graph-only, no overlap */
function compactBarGraph(values, title, opts={}){
  const clean = (values||[]).filter(v=>v && v.label!==undefined && v.value!==undefined);
  if(!clean.length) return `<div class="pdf-compact-graph"><h3>${escapeHtml(title)}</h3><p class="pdf-empty-note">No graph data detected.</p></div>`;
  const max = Math.max(...clean.map(v=>Number(v.value)||0), 1);
  const row = v => `<div class="pdf-compact-row"><span>${escapeHtml(String(v.label))}</span><b><i style="width:${Math.max(4, (Number(v.value)||0)/max*100).toFixed(1)}%"></i></b><em>${escapeHtml(String(v.value))}</em></div>`;
  if(opts.split){
    const half = Math.ceil(clean.length/2);
    return `<div class="pdf-compact-graph indicator-graph"><h3>${escapeHtml(title)}</h3><div class="pdf-compact-split"><div>${clean.slice(0,half).map(row).join('')}</div><div>${clean.slice(half).map(row).join('')}</div></div></div>`;
  }
  return `<div class="pdf-compact-graph"><h3>${escapeHtml(title)}</h3><div class="pdf-compact-list">${clean.map(row).join('')}</div></div>`;
}
function graphItems(r){
  const title = r.type==='job' ? 'Job Satisfaction Indicators Chart' : 'Client Satisfaction Indicators Chart';
  const vals = (r.items||[]).map((x,i)=>({label:x.code||('Q'+(i+1)), value:Number(x.mean).toFixed(2)}));
  return compactBarGraph(vals, title, {split: vals.length>14});
}
function graphCounts(obj,title){
  return compactBarGraph(Object.entries(obj||{}).map(([k,v])=>({label:k,value:v})), title);
}
function trendGraphHtml(r){
  const trend = (r.trend||[]).map(x=>({label:x.month, value:x.responses}));
  if(trend.length >= 2) return compactBarGraph(trend, 'Month-on-Month Response Volume');
  return compactBarGraph([{label:'Current Report', value:r.responses}], 'Current Response Volume');
}
function a4Page(inner, extra=''){
  return `<section class="pdf-a4-page ${extra}">
    <header class="pdf-a4-header"><strong>ARMY 2040: WORLD CLASS. MULTI-MISSION READY. CROSS-DOMAIN CAPABLE</strong></header>
    <main class="pdf-a4-body">${inner}</main>
    <footer class="pdf-a4-footer"><div class="pdf-logos"><img class="strip" src="assets/pgs_logos.jpg" alt="PGS logos"><strong>HONOR. PATRIOTISM. DUTY.</strong><img class="atr" src="assets/atr_logo.jpg" alt="ATR 2040 logo"></div></footer>
  </section>`;
}
function reportDoc(r){
  const reportDate = new Date(r.created).toLocaleDateString('en-PH', {day:'2-digit', month:'long', year:'numeric'});
  const profileObj = r.type==='job' ? r.years : r.gender;
  const profileTitle = r.type==='job' ? 'Years in Service' : 'Sex/Gender Distribution';
  const secondaryTitle = r.type==='job' ? 'Assignment Status' : 'Client Classification and Service Details';
  const secondaryObj = r.type==='job' ? r.assignment : (Object.keys(r.service||{}).length ? r.service : r.customerType);
  const profileText = r.type==='job' ? graphInterpretation(r.years,'Years in Service') : graphInterpretation(r.gender,'Sex/Gender');
  const secondaryText = graphInterpretation(secondaryObj, secondaryTitle);
  const narrativeParts = shortNarrative(r).filter(Boolean);
  const p = txt => `<p>${escapeHtml(txt)}</p>`;
  const itemText = r.items?.length ? `The indicator graph compares every measured item using its mean score. ${r.items[0]?cleanItemName(r.items[0].name):'The highest item'} recorded the highest result, while ${r.items.at(-1)?cleanItemName(r.items.at(-1).name):'the lowest item'} recorded the lowest result. This graph helps identify strengths and priority areas without adding duplicate tables.` : 'No rating indicators were detected from the uploaded worksheet.';
  const pages = [];
  pages.push(a4Page(`
    <div class="pdf-command-head"><b>HEADQUARTERS PHILIPPINE ARMY<br>OFFICE OF THE ADJUTANT<br>Fort Andres Bonifacio, Taguig City</b></div>
    <div class="memo-line"><span>OADJ</span><span>${reportDate}</span></div>
    <p class="memo-sub"><strong>SUBJECT:</strong> ${escapeHtml(r.title)}</p>
    <p class="memo-sub"><strong>TO:</strong> Adjutant, PA<br>Post<br>Attn: Admin</p>
    <h2>1. Summary Report</h2>
    ${summaryCardsHtml(r)}
    <h2>2. Narrative Interpretation</h2>
    ${narrativeParts.slice(0,2).map(p).join('')}
  `));
  pages.push(a4Page(`
    <h2>2. Narrative Interpretation</h2>
    ${narrativeParts.slice(2).map(p).join('') || '<p>The summary should be read together with the graphs presented in the following sections.</p>'}
    <div class="kpi-grid"><div><span>Total Responses</span><strong>${r.responses}</strong></div><div><span>Overall Mean</span><strong>${r.mean.toFixed(2)}/5</strong></div><div><span>Satisfaction</span><strong>${r.satisfaction.toFixed(2)}%</strong></div><div><span>Lowest Area</span><strong>${r.items?.at(-1)?escapeHtml(cleanItemName(r.items.at(-1).name)):'N/A'}</strong></div></div>
    <h2>3. Data Gathering and Analytical Basis</h2>
    <p>Each row in the uploaded worksheet was treated as one respondent entry. Valid rating responses were converted into a five-point scale. For job satisfaction reports, negative statements were reverse-scored when applicable so that higher values consistently represent more favorable results.</p>
    <p>The interpretation considers both the score and the number of responses supporting each score. This helps prevent overreading of small groups and makes the findings more balanced across the reported categories.</p>
  `));
  pages.push(a4Page(`
    <h2>4. Survey Trend Analysis</h2>
    ${trendGraphHtml(r)}
    ${interpretationBlock('Trend Interpretation', trendInterpretation(r))}
    <h2>5. ${escapeHtml(secondaryTitle)}</h2>
    ${graphCounts(secondaryObj, secondaryTitle)}
    ${interpretationBlock(`${secondaryTitle} Interpretation`, secondaryText)}
  `));
  pages.push(a4Page(`
    <h2>6. Indicator Performance Graph</h2>
    ${graphItems(r)}
    ${interpretationBlock('Indicator Interpretation', itemText)}
  `, 'indicator-page'));
  pages.push(a4Page(`
    <h2>7. ${escapeHtml(profileTitle)}</h2>
    ${graphCounts(profileObj, profileTitle)}
    ${interpretationBlock(`${profileTitle} Interpretation`, profileText)}
    <h2>8. Lower and Higher Rated Survey Areas</h2>
    ${priorityGraphHtml(r)}
    <p>The priority graph separates lower-scoring areas from stronger areas. Lower values indicate items that need closer review, while higher values show areas that may be sustained as positive survey findings.</p>
    ${signatoryHtml()}
  `));
  return `<article class="report-doc final-flow-pdf a4-fixed-pdf exact-pdf">${pages.join('')}</article>`;
}

/* FINAL PDF REFINEMENT: continuous A4 layout, less blank space, professional expandable interpretation */
function percentSummary(obj, label){
  const entries = Object.entries(obj || {}).filter(([,v]) => Number(v) > 0).sort((a,b)=>Number(b[1])-Number(a[1]));
  const total = entries.reduce((s,[,v])=>s+Number(v),0);
  if(!entries.length || !total) return `No ${label.toLowerCase()} data was detected from the uploaded worksheet.`;
  const [top, count] = entries[0];
  const topPct = (Number(count)/total*100).toFixed(2);
  const rest = entries.slice(1,3).map(([k,v])=>`${k} (${v})`).join(', ');
  return `${label} is concentrated in ${top} with ${count} response(s), equivalent to ${topPct}% of the detected entries${rest ? `. Other notable groups include ${rest}` : ''}.`;
}
function professionalNarrative(r){
  const top = r.items?.[0];
  const low = r.items?.[r.items.length-1];
  const lower = topLower(r,6).map(x=>cleanItemName(x.name));
  const higher = topHigher(r,4).map(x=>cleanItemName(x.name));
  const surveyKind = r.type === 'job' ? 'job satisfaction and work experience' : 'client satisfaction measurement';
  const scope = r.type === 'job'
    ? 'workplace conditions, supervision, recognition, communication, workload, resources, and overall work experience'
    : 'service delivery, responsiveness, reliability, accessibility, courtesy, communication, and overall client experience';
  const respondentContext = r.type === 'job'
    ? `${percentSummary(r.assignment, 'Assignment status')} ${percentSummary(r.years, 'Years in service')}`
    : `${percentSummary(r.gender, 'Sex/Gender profile')} ${percentSummary(Object.keys(r.service||{}).length ? r.service : r.customerType, 'Client/service profile')}`;
  const benchmark = lower.length ? `The lower-performing indicators below the 4.00 benchmark include ${lower.join(', ')}. These items should be treated as priority reading points because they show where respondent ratings were less favorable than the rest of the instrument.` : 'No measured indicator fell below the 4.00 benchmark, which suggests that the current ratings are generally stable across the measured areas.';
  const strengths = higher.length ? `The stronger areas include ${higher.join(', ')}. These results may be used as reference points for sustaining good practices and comparing future survey periods.` : 'No separate higher-rated cluster was detected because the survey did not contain enough rating indicators for comparison.';
  return [
    `This summative report presents the ${surveyKind} survey for ${coverageFromReport(r)}. The dataset contains ${r.responses} valid response(s) and ${r.items?.length || 0} measured indicator(s). The overall weighted mean is ${r.mean.toFixed(2)}/5.00, equivalent to ${r.satisfaction.toFixed(2)}%, and is interpreted as ${interpretationLabel(r.mean)}. This result gives the general condition of the survey while the succeeding graphs explain the areas that shaped the overall rating.`,
    `The survey instrument covers ${scope}. The interpretation is based on the pattern of scores, the number of responses behind the scores, respondent profile distribution, trend movement when available, and written feedback when present. This approach prevents the report from relying only on a single average and provides a more balanced reading of the uploaded Excel data.`,
    `The highest-rated indicator is ${top ? `${cleanItemName(top.name)} with a mean of ${top.mean.toFixed(2)}/5.00` : 'not available'}, while the lowest-rated indicator is ${low ? `${cleanItemName(low.name)} with a mean of ${low.mean.toFixed(2)}/5.00` : 'not available'}. The distance between the strongest and lowest areas helps identify both the practices that may be sustained and the issues that may require closer review.`,
    `${strengths} ${benchmark}`,
    `Respondent composition is important in reading the results. ${respondentContext} Larger respondent groups have greater influence on the overall picture, while smaller groups should be read as supporting evidence rather than as standalone conclusions.`,
    `Overall, the report should be used as an interpretative survey summary. It identifies the satisfaction level, the respondent groups represented in the data, the strongest and weakest indicators, and the priority areas that may be considered in monitoring, follow-up discussion, and future comparison.`
  ];
}
function compactBarGraph(values, title, opts={}){
  const clean = (values||[]).filter(v=>v && v.label!==undefined && v.value!==undefined && String(v.label).trim() !== '');
  if(!clean.length) return `<div class="pdf-compact-graph"><h3>${escapeHtml(title)}</h3><p class="pdf-empty-note">No graph data detected.</p></div>`;
  const max = Math.max(...clean.map(v=>Number(v.value)||0), 1);
  const row = v => `<div class="pdf-compact-row"><span>${escapeHtml(String(v.label))}</span><b><i style="width:${Math.max(4, (Number(v.value)||0)/max*100).toFixed(1)}%"></i></b><em>${escapeHtml(String(v.value))}</em></div>`;
  if(opts.split){
    const half = Math.ceil(clean.length/2);
    return `<div class="pdf-compact-graph indicator-graph"><h3>${escapeHtml(title)}</h3><div class="pdf-compact-split"><div>${clean.slice(0,half).map(row).join('')}</div><div>${clean.slice(half).map(row).join('')}</div></div></div>`;
  }
  return `<div class="pdf-compact-graph"><h3>${escapeHtml(title)}</h3><div class="pdf-compact-list">${clean.map(row).join('')}</div></div>`;
}
function graphItems(r){
  const title = r.type === 'job' ? 'Job Satisfaction Indicators Chart' : 'Client Satisfaction Indicators Chart';
  const vals = (r.items || []).map((x,i)=>({label:x.code || ('Q'+(i+1)), value:Number(x.mean).toFixed(2)}));
  return compactBarGraph(vals, title, {split: vals.length > 12});
}
function graphCounts(obj,title){
  return compactBarGraph(Object.entries(obj || {}).map(([k,v])=>({label:k,value:v})), title);
}
function trendGraphHtml(r){
  const trend = (r.trend || []).map(x=>({label:x.month, value:x.responses}));
  if(trend.length >= 2) return compactBarGraph(trend, 'Month-on-Month Response Volume');
  return compactBarGraph([{label:'Current Report', value:r.responses}], 'Current Response Volume');
}
function professionalInsightCards(r){
  const top = r.items?.[0];
  const low = r.items?.[r.items.length-1];
  const focus = topLower(r,4).map(x=>cleanItemName(x.name)).join(', ') || 'No lower-rated indicator detected';
  const profile = r.type === 'job' ? strongest(r.assignment) : strongest(Object.keys(r.service||{}).length ? r.service : r.customerType);
  return `<div class="insight-grid">
    <div><span>Result Reading</span><strong>${interpretationLabel(r.mean)}</strong><p>${r.mean.toFixed(2)}/5.00 weighted mean and ${r.satisfaction.toFixed(2)}% satisfaction.</p></div>
    <div><span>Strongest Area</span><strong>${escapeHtml(top ? cleanItemName(top.name) : 'N/A')}</strong><p>${top ? `Highest score at ${top.mean.toFixed(2)}/5.00.` : 'No rating item detected.'}</p></div>
    <div><span>Priority Focus</span><strong>${escapeHtml(low ? cleanItemName(low.name) : 'N/A')}</strong><p>${escapeHtml(focus)}</p></div>
    <div><span>Main Respondent Group</span><strong>${escapeHtml(profile)}</strong><p>Used as context when reading overall results.</p></div>
  </div>`;
}
function reportDoc(r){
  const reportDate = new Date(r.created).toLocaleDateString('en-PH', {day:'2-digit', month:'long', year:'numeric'});
  const profileObj = r.type === 'job' ? r.years : r.gender;
  const profileTitle = r.type === 'job' ? 'Years in Service' : 'Sex/Gender Distribution';
  const secondaryTitle = r.type === 'job' ? 'Assignment Status' : 'Client Classification and Service Details';
  const secondaryObj = r.type === 'job' ? r.assignment : (Object.keys(r.service || {}).length ? r.service : r.customerType);
  const profileText = r.type === 'job' ? graphInterpretation(r.years,'Years in Service') : graphInterpretation(r.gender,'Sex/Gender');
  const secondaryText = graphInterpretation(secondaryObj, secondaryTitle);
  const top = r.items?.[0];
  const low = r.items?.[r.items.length-1];
  const itemText = r.items?.length ? `The indicator graph compares each measured item using the computed mean score. ${cleanItemName(top.name)} is the strongest area at ${Number(top.mean).toFixed(2)}/5.00, while ${cleanItemName(low.name)} is the lowest area at ${Number(low.mean).toFixed(2)}/5.00. The graph should be read as a ranking of strengths and priority areas rather than as a replacement for follow-up review.` : 'No rating indicators were detected from the uploaded worksheet.';
  const narrative = professionalNarrative(r).map(x=>`<p>${escapeHtml(x)}</p>`).join('');
  return `<article class="report-doc final-flow-pdf compact-continuous-pdf exact-pdf">
    <div class="pdf-fixed-head"><strong>ARMY 2040: WORLD CLASS. MULTI-MISSION READY. CROSS-DOMAIN CAPABLE</strong></div>
    <div class="pdf-fixed-foot"><div class="pdf-logos"><img class="strip" src="assets/pgs_logos.jpg" alt="PGS logos"><strong>HONOR. PATRIOTISM. DUTY.</strong><img class="atr" src="assets/atr_logo.jpg" alt="ATR 2040 logo"></div></div>
    <div class="pdf-report-body">
      <section class="pdf-section pdf-cover-block">
        <div class="pdf-command-head"><b>HEADQUARTERS PHILIPPINE ARMY<br>OFFICE OF THE ADJUTANT<br>Fort Andres Bonifacio, Taguig City</b></div>
        <div class="memo-line"><span>OADJ</span><span>${reportDate}</span></div>
        <p class="memo-sub"><strong>SUBJECT:</strong> ${escapeHtml(r.title)}</p>
        <p class="memo-sub"><strong>TO:</strong> Adjutant, PA<br>Post<br>Attn: Admin</p>
      </section>
      <section class="pdf-section">
        <h2>1. Executive Summary</h2>
        ${summaryCardsHtml(r)}
        ${professionalInsightCards(r)}
      </section>
      <section class="pdf-section">
        <h2>2. Narrative Interpretation</h2>
        ${narrative}
      </section>
      <section class="pdf-section keep-together">
        <h2>3. Survey Trend Analysis</h2>
        ${trendGraphHtml(r)}
        ${interpretationBlock('Trend Interpretation', trendInterpretation(r))}
      </section>
      <section class="pdf-section indicator-section">
        <h2>4. Indicator Performance Graph</h2>
        ${graphItems(r)}
        ${interpretationBlock('Indicator Interpretation', itemText)}
      </section>
      <section class="pdf-section keep-together">
        <h2>5. ${escapeHtml(secondaryTitle)}</h2>
        ${graphCounts(secondaryObj, secondaryTitle)}
        ${interpretationBlock(`${secondaryTitle} Interpretation`, secondaryText)}
      </section>
      <section class="pdf-section keep-together">
        <h2>6. ${escapeHtml(profileTitle)}</h2>
        ${graphCounts(profileObj, profileTitle)}
        ${interpretationBlock(`${profileTitle} Interpretation`, profileText)}
      </section>
      <section class="pdf-section keep-together">
        <h2>7. Lower and Higher Rated Survey Areas</h2>
        ${priorityGraphHtml(r)}
        <p>The priority graph expands the interpretation by separating lower-scoring areas from stronger areas. Lower values indicate survey items that should be reviewed together with respondent context, while higher values identify strengths that may be sustained and monitored in succeeding survey periods.</p>
      </section>
      <section class="pdf-section signatory-section keep-together">
        ${signatoryHtml()}
      </section>
    </div>
  </article>`;
}


/* FINAL PDF PAGING FIX 2026-05-24: A4 static page header/footer, no fixed overlap, graph-only */
function ofmsGraph(values, title, opts={}){
  const clean=(values||[]).filter(v=>v && v.label!==undefined && v.value!==undefined && String(v.label).trim()!=='');
  if(!clean.length) return `<div class="ofms-pdf-graph"><h3>${escapeHtml(title)}</h3><p class="ofms-empty">No graph data detected.</p></div>`;
  const max=Math.max(...clean.map(v=>Number(v.value)||0),1);
  const row=v=>`<div class="ofms-graph-row"><span>${escapeHtml(String(v.label))}</span><b><i style="width:${Math.max(5,(Number(v.value)||0)/max*100).toFixed(1)}%"></i></b><em>${escapeHtml(String(v.value))}</em></div>`;
  if(opts.split){
    const half=Math.ceil(clean.length/2);
    return `<div class="ofms-pdf-graph ofms-indicator-graph"><h3>${escapeHtml(title)}</h3><div class="ofms-graph-split"><div>${clean.slice(0,half).map(row).join('')}</div><div>${clean.slice(half).map(row).join('')}</div></div></div>`;
  }
  return `<div class="ofms-pdf-graph"><h3>${escapeHtml(title)}</h3><div class="ofms-graph-list">${clean.map(row).join('')}</div></div>`;
}
function graphItems(r){
  const title=r.type==='job'?'Job Satisfaction Indicators Chart':'Client Satisfaction Indicators Chart';
  const vals=(r.items||[]).map((x,i)=>({label:x.code||('Q'+(i+1)), value:Number(x.mean).toFixed(2)}));
  return ofmsGraph(vals,title,{split:vals.length>12});
}
function graphCounts(obj,title){ return ofmsGraph(Object.entries(obj||{}).map(([k,v])=>({label:k,value:v})), title); }
function trendGraphHtml(r){
  const trend=(r.trend||[]).map(x=>({label:x.month,value:x.responses}));
  return ofmsGraph(trend.length>=2?trend:[{label:'Current Report',value:r.responses}], trend.length>=2?'Month-on-Month Response Volume':'Current Response Volume');
}
function ofmsPage(inner, cls=''){
  return `<section class="ofms-pdf-page ${cls}">
    <header class="ofms-pdf-header"><strong>ARMY 2040: WORLD CLASS. MULTI-MISSION READY. CROSS-DOMAIN CAPABLE</strong></header>
    <main class="ofms-pdf-body">${inner}</main>
    <footer class="ofms-pdf-footer"><div class="ofms-pdf-logos"><img class="strip" src="assets/pgs_logos.jpg" alt="PGS logos"><strong>HONOR. PATRIOTISM. DUTY.</strong><img class="atr" src="assets/atr_logo.jpg" alt="ATR 2040 logo"></div></footer>
  </section>`;
}
function summaryCardsGraphOnly(r){
  const top=r.items?.[0], low=r.items?.[r.items.length-1];
  const cards=[
    ['Survey Type',surveyLabel(r.type)],
    ['Reporting Coverage',coverageFromReport(r)],
    ['Valid Responses',String(r.responses)],
    ['Indicators',String(r.items?.length||0)],
    ['Weighted Mean',`${r.mean.toFixed(2)}/5.00`],
    ['Satisfaction',`${r.satisfaction.toFixed(2)}%`],
    ['Interpretation',interpretationLabel(r.mean)],
    ['Highest Area',top?`${cleanItemName(top.name)} (${Number(top.mean).toFixed(2)})`:'N/A'],
    ['Lowest Area',low?`${cleanItemName(low.name)} (${Number(low.mean).toFixed(2)})`:'N/A']
  ];
  return `<div class="ofms-summary-cards">${cards.map(([k,v])=>`<div><span>${escapeHtml(k)}</span><strong>${escapeHtml(v)}</strong></div>`).join('')}</div>`;
}
function compactNarrative(r){
  const parts=professionalNarrative(r).filter(Boolean);
  return parts.map(x=>`<p>${escapeHtml(x)}</p>`).join('');
}
function reportDoc(r){
  const reportDate=new Date(r.created).toLocaleDateString('en-PH',{day:'2-digit',month:'long',year:'numeric'});
  const profileObj=r.type==='job'?r.years:r.gender;
  const profileTitle=r.type==='job'?'Years in Service':'Sex/Gender Distribution';
  const secondaryTitle=r.type==='job'?'Assignment Status':'Client Classification and Service Details';
  const secondaryObj=r.type==='job'?r.assignment:(Object.keys(r.service||{}).length?r.service:r.customerType);
  const profileText=r.type==='job'?graphInterpretation(r.years,'Years in Service'):graphInterpretation(r.gender,'Sex/Gender');
  const secondaryText=graphInterpretation(secondaryObj,secondaryTitle);
  const top=r.items?.[0]; const low=r.items?.[r.items.length-1];
  const itemText=r.items?.length?`The indicator graph compares each measured item using the computed mean score. ${cleanItemName(top.name)} is the strongest area at ${Number(top.mean).toFixed(2)}/5.00, while ${cleanItemName(low.name)} is the lowest area at ${Number(low.mean).toFixed(2)}/5.00. This graph is intended to show the relative spread of strengths and priority areas without duplicating the same information in table form.`:'No rating indicators were detected from the uploaded worksheet.';
  const pages=[];
  pages.push(ofmsPage(`
    <div class="ofms-command-head"><b>HEADQUARTERS PHILIPPINE ARMY<br>OFFICE OF THE ADJUTANT<br>Fort Andres Bonifacio, Taguig City</b></div>
    <div class="ofms-memo-line"><span>OADJ</span><span>${reportDate}</span></div>
    <p class="ofms-memo"><strong>SUBJECT:</strong> ${escapeHtml(r.title)}</p>
    <p class="ofms-memo"><strong>TO:</strong> Adjutant, PA<br>Post<br>Attn: Admin</p>
    <h2>1. Executive Summary</h2>
    ${summaryCardsGraphOnly(r)}
    <h2>2. Narrative Interpretation</h2>
    ${compactNarrative(r)}
  `,'intro-page'));
  pages.push(ofmsPage(`
    <h2>3. Survey Trend Analysis</h2>
    ${trendGraphHtml(r)}
    ${interpretationBlock('Trend Interpretation',trendInterpretation(r))}
    <h2>4. ${escapeHtml(secondaryTitle)}</h2>
    ${graphCounts(secondaryObj,secondaryTitle)}
    ${interpretationBlock(`${secondaryTitle} Interpretation`,secondaryText)}
    <h2>5. ${escapeHtml(profileTitle)}</h2>
    ${graphCounts(profileObj,profileTitle)}
    ${interpretationBlock(`${profileTitle} Interpretation`,profileText)}
  `,'graphs-page'));
  pages.push(ofmsPage(`
    <h2>6. Indicator Performance Graph</h2>
    ${graphItems(r)}
    ${interpretationBlock('Indicator Interpretation',itemText)}
    <h2>7. Lower and Higher Rated Survey Areas</h2>
    ${priorityGraphHtml(r)}
    <p>The priority graph separates lower-scoring areas from stronger areas. Lower values indicate survey items that need closer review with respondent context, while higher values identify strengths that may be sustained and monitored in succeeding survey periods.</p>
    ${signatoryHtml()}
  `,'indicator-page'));
  return `<article class="report-doc ofms-a4-pdf exact-pdf">${pages.join('')}</article>`;
}

(function(){
  const oldPrint=printCurrentReport;
  printCurrentReport=function(){
    const title=document.title;
    const currentReport = state.reports.find(x=>String(x.id)===String(currentPrintReportId || pendingPrintReportId || ''));
    try{
      document.title=pdfDocumentTitle(currentReport);
      document.body.classList.add('printing-report');
      setTimeout(()=>{ window.print(); setTimeout(()=>{ document.body.classList.remove('printing-report'); document.title=title; }, 900); }, 180);
    }catch(err){
      console.error('PDF print failed:',err);
      document.body.classList.remove('printing-report');
      document.title=title;
      if(typeof oldPrint==='function') oldPrint();
    }
  };
})();


/* FINAL SURVEY-ONLY PDF + IMPROVED PREVIEW 2026-05-24 */
function surveyAreaLabel(){ return 'Survey Area'; }
function graphInterpretation(obj, label){
  const entries=Object.entries(obj||{}).sort((a,b)=>Number(b[1])-Number(a[1]));
  const total=entries.reduce((a,[,v])=>a+Number(v),0);
  if(!entries.length || !total) return `No ${label.toLowerCase()} data was detected for this survey report.`;
  const [top,count]=entries[0];
  return `${top} has the highest response count with ${count} response(s), equivalent to ${(Number(count)/total*100).toFixed(2)}% of the detected ${label.toLowerCase()} entries. This distribution gives context to the survey result because larger respondent groups have greater influence on the overall findings.`;
}
function surveyOnlyNarrative(r){
  const top=r.items?.[0];
  const low=r.items?.[r.items.length-1];
  const lower=(r.items||[]).filter(x=>Number(x.mean)<4).slice(0,7).map(x=>cleanItemName(x.name));
  const strong=(r.items||[]).filter(x=>Number(x.mean)>=4).slice(0,7).map(x=>cleanItemName(x.name));
  const surveyKind=r.type==='job'?'job satisfaction and work experience':'client satisfaction measurement';
  const scope=r.type==='job'
    ? 'workplace experience, recognition, communication, supervision, workload, procedures, resources, and overall work conditions'
    : 'service quality, timeliness, responsiveness, accessibility, communication, requirements, assurance, and overall client experience';
  const profile=r.type==='job'
    ? `For assignment status, ${percentPart(r.assignment)} For years in service, ${percentPart(r.years)}`
    : `For respondent profile, ${percentPart(Object.keys(r.gender||{}).length?r.gender:r.customerType)} ${Object.keys(r.service||{}).length?`For service availed, ${percentPart(r.service)}`:''}`;
  return [
    `This report presents the ${surveyKind} results for ${coverageFromReport(r)}. It is based on ${r.responses} valid response(s) and ${r.items?.length || 0} measured survey area(s). The overall weighted mean is ${r.mean.toFixed(2)}/5.00, equivalent to ${r.satisfaction.toFixed(2)}%, with an interpretation of ${interpretationLabel(r.mean)}. This result summarizes the general level of satisfaction shown by the respondents during the covered period.`,
    `The survey covers ${scope}. The interpretation considers the mean score, the number of responses supporting the score, the profile of respondents, trend movement when available, and written feedback when present. This makes the reading more balanced because the overall result is not based on one score alone.`,
    top && low ? `The highest-rated survey area is ${cleanItemName(top.name)} with a mean of ${Number(top.mean).toFixed(2)}/5.00, while the lowest-rated survey area is ${cleanItemName(low.name)} with a mean of ${Number(low.mean).toFixed(2)}/5.00. The difference between these areas shows which part of the survey may be sustained and which part may need closer review.` : `No individual survey area ranking was detected, so the report focuses mainly on the overall satisfaction result and respondent distribution.`,
    lower.length ? `The lower-rated survey areas include ${lower.join(', ')}. These areas should be reviewed together with respondent comments and profile distribution to determine whether the concern is broad, group-specific, or related to a particular service or workplace condition.` : `No survey area fell below the 4.00 benchmark. This suggests that the reported satisfaction level is generally stable across the measured areas, although future results should still be monitored for changes.`,
    strong.length ? `The stronger survey areas include ${strong.join(', ')}. These areas may be treated as positive findings and can serve as reference points for maintaining effective practices in future survey periods.` : `No separate high-rating cluster was detected because the available survey areas were limited or closely grouped in score.`,
    `Respondent composition helps explain the overall result. ${profile} These groups show where most of the survey responses came from and should be considered when comparing the findings with future reports.`,
    `Overall, the survey result provides a structured view of satisfaction level, strongest areas, lower-rated areas, respondent profile, and trend movement. The findings may be used as a basis for monitoring, follow-up discussion, and comparison with succeeding survey periods.`
  ].filter(Boolean);
}
function summaryCardsGraphOnly(r){
  const top=r.items?.[0], low=r.items?.[r.items.length-1];
  const cards=[
    ['Survey Type',surveyLabel(r.type)],
    ['Reporting Coverage',coverageFromReport(r)],
    ['Valid Responses',String(r.responses)],
    ['Survey Areas',String(r.items?.length||0)],
    ['Weighted Mean',`${r.mean.toFixed(2)}/5.00`],
    ['Satisfaction',`${r.satisfaction.toFixed(2)}%`],
    ['Interpretation',interpretationLabel(r.mean)],
    ['Highest Area',top?`${cleanItemName(top.name)} (${Number(top.mean).toFixed(2)})`:'N/A'],
    ['Lowest Area',low?`${cleanItemName(low.name)} (${Number(low.mean).toFixed(2)})`:'N/A']
  ];
  return `<div class="ofms-summary-cards">${cards.map(([k,v])=>`<div><span>${escapeHtml(k)}</span><strong>${escapeHtml(v)}</strong></div>`).join('')}</div>`;
}
function reportDoc(r){
  const reportDate=new Date(r.created).toLocaleDateString('en-PH',{day:'2-digit',month:'long',year:'numeric'});
  const profileObj=r.type==='job'?r.years:r.gender;
  const profileTitle=r.type==='job'?'Years in Service':'Sex/Gender Distribution';
  const secondaryTitle=r.type==='job'?'Assignment Status':'Client Classification and Service Details';
  const secondaryObj=r.type==='job'?r.assignment:(Object.keys(r.service||{}).length?r.service:r.customerType);
  const profileText=r.type==='job'?graphInterpretation(r.years,'Years in Service'):graphInterpretation(r.gender,'Sex/Gender');
  const secondaryText=graphInterpretation(secondaryObj,secondaryTitle);
  const top=r.items?.[0]; const low=r.items?.[r.items.length-1];
  const itemText=r.items?.length?`The survey area graph compares each measured item using the computed mean score. ${cleanItemName(top.name)} is the strongest area at ${Number(top.mean).toFixed(2)}/5.00, while ${cleanItemName(low.name)} is the lowest area at ${Number(low.mean).toFixed(2)}/5.00. This graph shows the spread of strengths and priority areas without repeating the same data in table form.`:'No rating survey areas were detected for this report.';
  const narrative=surveyOnlyNarrative(r).map(x=>`<p>${escapeHtml(x)}</p>`).join('');
  const pages=[];
  pages.push(ofmsPage(`
    <div class="ofms-command-head"><b>HEADQUARTERS PHILIPPINE ARMY<br>OFFICE OF THE ADJUTANT<br>Fort Andres Bonifacio, Taguig City</b></div>
    <div class="ofms-memo-line"><span>OADJ</span><span>${reportDate}</span></div>
    <p class="ofms-memo"><strong>SUBJECT:</strong> ${escapeHtml(r.title)}</p>
    <p class="ofms-memo"><strong>TO:</strong> Adjutant, PA<br>Post<br>Attn: Admin</p>
    <h2>1. Executive Summary</h2>
    ${summaryCardsGraphOnly(r)}
    <h2>2. Survey Result Interpretation</h2>
    ${narrative}
  `,'intro-page'));
  pages.push(ofmsPage(`
    <h2>3. Survey Trend Analysis</h2>
    ${trendGraphHtml(r)}
    ${interpretationBlock('Trend Interpretation',trendInterpretation(r))}
    <h2>4. ${escapeHtml(secondaryTitle)}</h2>
    ${graphCounts(secondaryObj,secondaryTitle)}
    ${interpretationBlock(`${secondaryTitle} Interpretation`,secondaryText)}
    <h2>5. ${escapeHtml(profileTitle)}</h2>
    ${graphCounts(profileObj,profileTitle)}
    ${interpretationBlock(`${profileTitle} Interpretation`,profileText)}
  `,'graphs-page'));
  pages.push(ofmsPage(`
    <h2>6. Survey Area Performance Graph</h2>
    ${graphItems(r)}
    ${interpretationBlock('Survey Area Interpretation',itemText)}
    <h2>7. Lower and Higher Rated Survey Areas</h2>
    ${priorityGraphHtml(r)}
    <p>The priority graph separates lower-scoring areas from stronger areas. Lower values identify items that need closer survey review, while higher values identify strengths that may be sustained and monitored in succeeding survey periods.</p>
    ${signatoryHtml()}
  `,'indicator-page'));
  return `<article class="report-doc ofms-a4-pdf exact-pdf">${pages.join('')}</article>`;
}
window.openReport = (id)=>{
  const r=state.reports.find(x=>String(x.id)===String(id));
  if(!r) return;
  try{
    $('#reportContent').innerHTML = reportDoc(r);
    $('#reportModal').classList.remove('hidden');
    $('#reportModal').classList.add('preview-polished');
  }catch(err){ console.error('Report preview error:', err); toast('Report preview failed. Please regenerate the report.'); }
};


/* ==========================================================
   FINAL PATCH: survey-only professional PDF + notable remarks
   ========================================================== */
function surveyOnlyNarrative(r){
  const top = r.items?.[0] || null;
  const low = r.items?.[r.items.length - 1] || null;
  const lower = (r.items || []).filter(x => Number(x.mean) < 4).slice(0, 8);
  const strong = (r.items || []).filter(x => Number(x.mean) >= 4).slice(0, 8);
  const surveyName = r.type === 'job'
    ? 'Job Satisfaction and Work Experience Survey'
    : 'Client Satisfaction Measurement Survey';
  const scope = r.type === 'job'
    ? 'work satisfaction, workload, communication, recognition, supervision, working conditions, resources, work appreciation, and related personnel experience areas'
    : 'service accessibility, responsiveness, timeliness, communication, quality of assistance, client requirements, satisfaction with service delivery, and overall client experience';
  const profileText = r.type === 'job'
    ? `The respondent profile is mainly described through assignment status and years in service. ${percentPart(r.assignment)} ${percentPart(r.years)}`
    : `The respondent profile is described through the available client and service categories. ${percentPart(Object.keys(r.gender || {}).length ? r.gender : r.customerType)} ${Object.keys(r.service || {}).length ? percentPart(r.service) : ''}`;
  const trendText = trendInterpretation(r);
  const remarkCount = (r.remarks || []).filter(x => String(x || '').trim() && String(x).trim() !== '.').length;

  return [
    `This summative report presents the results of the ${surveyName} for ${coverageFromReport(r)}. The survey recorded ${r.responses} valid response(s) across ${r.items?.length || 0} measured survey area(s). The overall weighted mean is ${r.mean.toFixed(2)}/5.00, equivalent to ${r.satisfaction.toFixed(2)}%, and is interpreted as ${interpretationLabel(r.mean)}. This result provides the general satisfaction level reflected by the respondents during the covered period.`,

    `The survey result should be read as a combined picture of numerical ratings, respondent distribution, trend movement, and written remarks. The measured areas cover ${scope}. Because the report uses both mean scores and response counts, the interpretation gives attention not only to the rating level but also to the number of responses supporting the result.`,

    top && low
      ? `The highest-rated survey area is ${cleanItemName(top.name)}, with a mean score of ${Number(top.mean).toFixed(2)}/5.00. This area represents the strongest positive finding in the current survey cycle and may be treated as a point to sustain. The lowest-rated survey area is ${cleanItemName(low.name)}, with a mean score of ${Number(low.mean).toFixed(2)}/5.00. This area should be examined more closely because it contributed most clearly to lowering the overall result.`
      : `The available data did not provide a complete ranking of survey areas, so the interpretation focuses on the overall rating, respondent composition, and written feedback.`,

    strong.length
      ? `The stronger survey areas include ${strong.map(x => `${cleanItemName(x.name)} (${Number(x.mean).toFixed(2)})`).join(', ')}. These results show the areas where respondents expressed more favorable evaluation. Maintaining these strengths is important because they help support the general satisfaction level of the survey.`
      : `No separate high-rated survey area cluster was identified from the available responses.`,

    lower.length
      ? `The lower-rated survey areas include ${lower.map(x => `${cleanItemName(x.name)} (${Number(x.mean).toFixed(2)})`).join(', ')}. These areas should be considered priority reading points because they may reveal recurring concerns, service gaps, workload issues, or satisfaction factors that need closer review in the next survey cycle.`
      : `No survey area fell below the review benchmark. This suggests that the measured areas were generally stable for the current reporting period, although continued monitoring remains necessary.`,

    `${profileText} This distribution is important because groups with more responses have greater influence on the overall survey picture. Smaller groups should still be considered as supporting evidence, especially when comparing succeeding survey periods.`,

    `${trendText} The trend result should be interpreted together with the total response count and the overall weighted mean so that changes in satisfaction are not overstated when response volume is limited.`,

    remarkCount
      ? `The survey includes ${remarkCount} usable written remark(s). These remarks are important because they may explain the reasons behind high and low ratings, identify specific experiences, and provide context that is not fully visible from numerical scores alone. The remarks should be read together with the lowest-rated survey areas to identify possible follow-up points.`
      : `No usable written remarks were detected for this report. The interpretation therefore relies mainly on the rating scores, profile distribution, and trend movement.`
  ];
}

function notableRemarksHtml(r, providedRemarks=null, startIndex=0){
  const usable = Array.isArray(providedRemarks)
    ? providedRemarks
    : (r.remarks || [])
      .map(x => String(x || '').trim())
      .filter(x => x && x !== '.' && x !== '-' && x.toLowerCase() !== 'n/a')
      .slice(0, 10);

  if(!usable.length){
    return `<div class="notable-box"><p>No usable written remarks were provided for this survey period.</p></div>`;
  }

  return `<div class="notable-box">${usable.map((x, i) => `
    <div class="notable-item">
      <span>${startIndex + i + 1}</span>
      <p>${escapeHtml(x)}</p>
    </div>
  `).join('')}</div>`;
}

function surveyAreaSummaryHtml(r){
  const top = r.items?.[0];
  const low = r.items?.[r.items.length - 1];
  const lower = topLower(r, 5).map(x => cleanItemName(x.name)).join(', ') || 'No lower-rated survey area detected';
  return `<div class="survey-summary-strip">
    <div><span>Strongest Area</span><strong>${top ? escapeHtml(cleanItemName(top.name)) : 'N/A'}</strong><em>${top ? Number(top.mean).toFixed(2) + '/5.00' : ''}</em></div>
    <div><span>Lowest Area</span><strong>${low ? escapeHtml(cleanItemName(low.name)) : 'N/A'}</strong><em>${low ? Number(low.mean).toFixed(2) + '/5.00' : ''}</em></div>
    <div><span>Priority Reading Points</span><strong>${escapeHtml(lower)}</strong></div>
  </div>`;
}

function ofmsPage(inner, cls=''){
  return `<section class="ofms-pdf-page ${cls}">
    <header class="ofms-pdf-header">
      <strong>ARMY 2040: WORLD CLASS. MULTI-MISSION READY. CROSS-DOMAIN CAPABLE</strong>
    </header>
    <main class="ofms-pdf-body">${inner}</main>
    <footer class="ofms-pdf-footer">
      <div class="ofms-pdf-logos">
        <img class="strip" src="assets/pgs_logos.jpg" alt="PGS logos">
        <strong>HONOR. PATRIOTISM. DUTY.</strong>
        <img class="atr" src="assets/atr_logo.jpg" alt="ATR 2040 logo">
      </div>
    </footer>
  </section>`;
}

function reportDoc(r){
  const reportDate = new Date(r.created).toLocaleDateString('en-PH', {day:'2-digit', month:'long', year:'numeric'});
  const profileObj = r.type === 'job' ? r.years : r.gender;
  const profileTitle = r.type === 'job' ? 'Years in Service' : 'Sex/Gender Distribution';
  const secondaryTitle = r.type === 'job' ? 'Assignment Status' : 'Client Classification and Service Details';
  const secondaryObj = r.type === 'job' ? r.assignment : (Object.keys(r.service || {}).length ? r.service : r.customerType);
  const profileText = r.type === 'job' ? graphInterpretation(r.years, 'Years in Service') : graphInterpretation(r.gender, 'Sex/Gender');
  const secondaryText = graphInterpretation(secondaryObj, secondaryTitle);
  const top = r.items?.[0];
  const low = r.items?.[r.items.length - 1];
  const itemText = r.items?.length
    ? `The survey area graph compares the mean score of each measured item. ${cleanItemName(top.name)} received the strongest mean score at ${Number(top.mean).toFixed(2)}/5.00, while ${cleanItemName(low.name)} recorded the lowest mean score at ${Number(low.mean).toFixed(2)}/5.00. This comparison shows which areas may be sustained and which areas require closer survey review.`
    : `No rating survey areas were detected for this report.`;
  const narrativeParts = surveyOnlyNarrative(r);
  const pages = [];

  pages.push(ofmsPage(`
    <div class="ofms-command-head">
      <b>HEADQUARTERS PHILIPPINE ARMY<br>OFFICE OF THE ADJUTANT<br>Fort Andres Bonifacio, Taguig City</b>
    </div>
    <div class="ofms-memo-line"><span>OADJ</span><span>${reportDate}</span></div>
    <p class="ofms-memo"><strong>SUBJECT:</strong> ${escapeHtml(r.title)}</p>
    <p class="ofms-memo"><strong>TO:</strong> Adjutant, PA<br>Post<br>Attn: Admin</p>
    <h2>1. Executive Summary</h2>
    ${summaryCardsGraphOnly(r)}
    <h2>2. Summative Survey Interpretation</h2>
    ${narrativeParts.slice(0, 3).map(x => `<p>${escapeHtml(x)}</p>`).join('')}
  `,'intro-page'));

  pages.push(ofmsPage(`
    <h2>3. Expanded Survey Analysis</h2>
    ${narrativeParts.slice(3).map(x => `<p>${escapeHtml(x)}</p>`).join('')}
    <h2>4. Key Survey Reading Points</h2>
    ${surveyAreaSummaryHtml(r)}
  `,'analysis-page'));

  pages.push(ofmsPage(`
    <h2>5. Survey Trend Analysis</h2>
    ${trendGraphHtml(r)}
    ${interpretationBlock('Trend Interpretation', trendInterpretation(r))}
    <h2>6. ${escapeHtml(secondaryTitle)}</h2>
    ${graphCounts(secondaryObj, secondaryTitle)}
    ${interpretationBlock(`${secondaryTitle} Interpretation`, secondaryText)}
  `,'trend-profile-page'));

  pages.push(ofmsPage(`
    <h2>7. ${escapeHtml(profileTitle)}</h2>
    ${graphCounts(profileObj, profileTitle)}
    ${interpretationBlock(`${profileTitle} Interpretation`, profileText)}
    <h2>8. Survey Area Performance Graph</h2>
    ${graphItems(r)}
    ${interpretationBlock('Survey Area Interpretation', itemText)}
  `,'area-performance-page'));

  pages.push(ofmsPage(`
    <h2>9. Lower and Higher Rated Survey Areas</h2>
    ${priorityGraphHtml(r)}
    <p>The priority graph identifies which survey areas require closer review and which areas may be sustained. Lower-rated areas should be compared with the written remarks and respondent profile, while higher-rated areas may serve as positive reference points for future survey cycles.</p>
    <h2>10. Notable Qualitative Remarks</h2>
    ${notableRemarksHtml(r)}
    ${signatoryHtml()}
  `,'remarks-page'));

  return `<article class="report-doc ofms-a4-pdf exact-pdf">${pages.join('')}</article>`;
}

window.openReport = (id)=>{
  const r = state.reports.find(x => String(x.id) === String(id));
  if(!r) return;
  try{
    currentPrintReportId = r.id;
    const content = $('#reportContent');
    content.innerHTML = `
      <div class="preview-titlebar">
        <div>
          <strong>${escapeHtml(pdfDocumentTitle(r))}</strong>
          <span>${surveyLabel(r.type)} • ${r.responses} response(s) • ${r.mean.toFixed(2)}/5.00</span>
        </div>
        <button class="preview-mini-print" onclick="printCurrentReport()">Print / Save PDF</button>
      </div>
      <div class="preview-scroll-paper">${reportDoc(r)}</div>
    `;
    $('#reportModal').classList.remove('hidden');
    $('#reportModal').classList.add('preview-polished','preview-readable');
    document.body.classList.add('pdf-preview-open');
    requestAnimationFrame(()=>{
      $('#reportModal')?.scrollTo?.(0, 0);
      $('.preview-scroll-paper')?.scrollTo?.(0, 0);
    });
  }catch(err){
    console.error('Report preview error:', err);
    toast('Report preview failed. Please regenerate the report.');
  }
};


/* ==========================================================
   FINAL REQUEST PATCH: richer survey-only reports + UI/UX cards
   ========================================================== */
function surveyPercentText(obj, label){
  const entries=Object.entries(obj||{}).filter(([,v])=>Number(v)>0).sort((a,b)=>Number(b[1])-Number(a[1]));
  const total=entries.reduce((s,[,v])=>s+Number(v),0);
  if(!entries.length || !total) return `No ${label.toLowerCase()} distribution was available.`;
  return entries.slice(0,3).map(([k,v])=>`${k}: ${v} (${(Number(v)/total*100).toFixed(2)}%)`).join('; ');
}
function satisfactionBand(mean){
  const m=Number(mean)||0;
  if(m>=4.5) return 'Very Strong Satisfaction';
  if(m>=4.0) return 'Strong Satisfaction';
  if(m>=3.0) return 'Satisfactory';
  if(m>=2.0) return 'Needs Attention';
  return 'Critical Review Needed';
}
function topListText(items, limit=5){
  return (items||[]).slice(0,limit).map(x=>`${cleanItemName(x.name)} (${Number(x.mean).toFixed(2)})`).join(', ') || 'Not available';
}
function reportFocusNote(r){
  const lower=(r.items||[]).filter(x=>Number(x.mean)<4);
  const top=r.items?.[0], low=r.items?.[r.items.length-1];
  const focus = r.type==='job'
    ? 'The reading focuses on personnel satisfaction, workplace experience, support conditions, workload, communication, recognition, and assignment profile.'
    : 'The reading focuses on client satisfaction, service quality, access to assistance, responsiveness, clarity of requirements, service outcome, and client profile.';
  const priority = lower.length
    ? `Priority attention should be given to ${topListText(lower,5)} because these areas are below the 4.00 review benchmark.`
    : `No survey area fell below the 4.00 review benchmark; the main focus is to sustain the current satisfaction level and continue monitoring future movement.`;
  return `<div class="survey-focus-note"><strong>Survey Reading Focus</strong><p>${escapeHtml(focus)}</p><p>${escapeHtml(priority)}</p>${top&&low?`<p>${escapeHtml(`The strongest area is ${cleanItemName(top.name)} (${Number(top.mean).toFixed(2)}/5.00), while the lowest area is ${cleanItemName(low.name)} (${Number(low.mean).toFixed(2)}/5.00).`)}</p>`:''}</div>`;
}
function surveyOnlyNarrative(r){
  const top=r.items?.[0]||null;
  const low=r.items?.[r.items.length-1]||null;
  const lower=(r.items||[]).filter(x=>Number(x.mean)<4).slice(0,8);
  const strong=(r.items||[]).filter(x=>Number(x.mean)>=4).slice(0,8);
  const remarkCount=(r.remarks||[]).map(x=>String(x||'').trim()).filter(x=>x && x!=='.' && x!=='-' && x.toLowerCase()!=='n/a').length;
  const band=satisfactionBand(r.mean);
  if(r.type==='job'){
    return [
      `This summative report presents the Job Satisfaction and Work Experience Survey for ${coverageFromReport(r)}. The survey contains ${r.responses} valid response(s) across ${r.items?.length||0} measured survey area(s). The overall weighted mean is ${r.mean.toFixed(2)}/5.00, equivalent to ${r.satisfaction.toFixed(2)}% satisfaction, and is interpreted as ${interpretationLabel(r.mean)}. In practical terms, the result falls under ${band}, which means the personnel experience is generally acceptable while still requiring attention to the lower-rated areas that may affect morale, workload balance, and work support.`,
      `For job satisfaction, the result should be read through four main lenses: overall satisfaction level, workplace strengths, priority concerns, and respondent composition. The survey areas reflect the respondents’ views on work appreciation, recognition, communication, supervision, working conditions, workload, procedures, resources, and related experience factors. This makes the report useful for understanding not only the general rating but also the specific parts of the work environment that shape the rating.`,
      top&&low?`The highest-rated survey area is ${cleanItemName(top.name)} with a mean of ${Number(top.mean).toFixed(2)}/5.00. This area is the strongest positive finding and may be sustained as a good practice. The lowest-rated survey area is ${cleanItemName(low.name)} with a mean of ${Number(low.mean).toFixed(2)}/5.00. This area is the clearest priority for review because it has the strongest downward effect on the satisfaction result.`:`No complete survey-area ranking was available; therefore, the interpretation focuses on the overall satisfaction level and respondent distribution.`,
      strong.length?`Stronger job-satisfaction areas include ${topListText(strong,6)}. These results point to workplace conditions or experiences that respondents rated more favorably. Maintaining these areas is important because they support the overall satisfaction level and can serve as reference points when comparing future survey periods.`:`No distinct high-rated group of job-satisfaction areas was identified.`,
      lower.length?`Lower-rated job-satisfaction areas include ${topListText(lower,6)}. These areas should be treated as priority reading points because they may indicate concerns related to workload, recognition, communication, policy clarity, promotion opportunities, resources, or other workplace conditions. These findings should be read together with written remarks to understand the possible reasons behind the scores.`:`No job-satisfaction area fell below the 4.00 benchmark. This suggests that the measured areas are generally stable, although continued monitoring is still necessary.`,
      `The respondent profile provides context for the overall result. Assignment status distribution shows ${surveyPercentText(r.assignment,'Assignment Status')}. Years in service distribution shows ${surveyPercentText(r.years,'Years in Service')}. These profiles help explain whose work experiences are most represented in the survey and should be considered when interpreting satisfaction levels.`,
      `${trendInterpretation(r)} The trend should be treated as supporting evidence for satisfaction monitoring. A change in response volume can affect the strength of interpretation, so the satisfaction movement should be read together with the number of valid responses.`,
      remarkCount?`The survey includes ${remarkCount} usable written remark(s). These qualitative responses are important because they can explain the reasons behind the numerical ratings and may identify specific work-related concerns or positive experiences that are not fully visible in the mean scores.`:`No usable written remarks were available for this report. The interpretation therefore relies mainly on the rating scores, respondent profile, and trend movement.`
    ].filter(Boolean);
  }
  return [
    `This summative report presents the Client Satisfaction Measurement Survey for ${coverageFromReport(r)}. The survey contains ${r.responses} valid response(s) across ${r.items?.length||0} measured service area(s). The overall weighted mean is ${r.mean.toFixed(2)}/5.00, equivalent to ${r.satisfaction.toFixed(2)}% satisfaction, and is interpreted as ${interpretationLabel(r.mean)}. In practical terms, the result falls under ${band}, which reflects how clients evaluated the quality of service received during the covered period.`,
    `For client satisfaction, the result should be read through service-delivery factors such as accessibility, timeliness, responsiveness, clarity of requirements, communication, courtesy, assurance, reliability, and overall service outcome. Unlike the job-satisfaction report, this report focuses on the client experience and the quality of assistance delivered to respondents.`,
    top&&low?`The highest-rated service area is ${cleanItemName(top.name)} with a mean of ${Number(top.mean).toFixed(2)}/5.00. This area represents the strongest service-delivery finding and may be sustained as a positive practice. The lowest-rated service area is ${cleanItemName(low.name)} with a mean of ${Number(low.mean).toFixed(2)}/5.00. This area should be reviewed because it indicates where the client experience may need the most attention.`:`No complete service-area ranking was available; therefore, the interpretation focuses on the overall satisfaction level and respondent profile.`,
    strong.length?`Stronger client-satisfaction areas include ${topListText(strong,6)}. These areas show which parts of the service experience were rated more favorably by clients and may be used as standards for consistency in succeeding service transactions.`:`No distinct high-rated group of client-satisfaction areas was identified.`,
    lower.length?`Lower-rated client-satisfaction areas include ${topListText(lower,6)}. These areas may point to concerns involving processing time, communication, clarity of requirements, online access, staff responsiveness, or other service-delivery factors. They should be reviewed as possible improvement points for future client transactions.`:`No client-satisfaction area fell below the 4.00 benchmark. This suggests that the service experience was generally stable during the reporting period, while continued monitoring remains necessary.`,
    `The respondent and service profile gives context to the satisfaction result. Client or respondent distribution shows ${surveyPercentText(Object.keys(r.gender||{}).length?r.gender:r.customerType,'Respondent Profile')}. Service-related distribution shows ${surveyPercentText(Object.keys(r.service||{}).length?r.service:r.customerType,'Service Availed')}. This helps identify which client groups or services most strongly shaped the overall satisfaction result.`,
    `${trendInterpretation(r)} The trend result should be interpreted together with response volume because client-satisfaction movement is more reliable when supported by a sufficient number of responses.`,
    remarkCount?`The survey includes ${remarkCount} usable written remark(s). These comments provide qualitative evidence that may explain client concerns, service strengths, or specific transaction experiences that are not fully shown by numerical ratings alone.`:`No usable written remarks were available for this report. The interpretation therefore relies mainly on the rating scores, respondent profile, and trend movement.`
  ].filter(Boolean);
}
function graphInterpretation(obj, label){
  const entries=Object.entries(obj||{}).filter(([,v])=>Number(v)>0).sort((a,b)=>Number(b[1])-Number(a[1]));
  const total=entries.reduce((a,[,v])=>a+Number(v),0);
  if(!entries.length || !total) return `No ${label.toLowerCase()} count was available for this survey report.`;
  const [top,count]=entries[0];
  return `${top} recorded the highest count with ${count} response(s), equivalent to ${(Number(count)/total*100).toFixed(2)}% of the ${label.toLowerCase()} distribution. This profile is relevant because the largest group has the strongest influence on the overall satisfaction reading.`;
}
function summaryCardsGraphOnly(r){
  const top=r.items?.[0], low=r.items?.[r.items.length-1];
  const below=(r.items||[]).filter(x=>Number(x.mean)<4).length;
  const cards=[
    ['Survey Type',surveyLabel(r.type)],['Coverage',coverageFromReport(r)],['Valid Responses',String(r.responses)],
    [r.type==='job'?'Job Areas':'Service Areas',String(r.items?.length||0)],['Weighted Mean',`${r.mean.toFixed(2)}/5.00`],['Satisfaction',`${r.satisfaction.toFixed(2)}%`],
    ['Interpretation',interpretationLabel(r.mean)],['Highest Area',top?`${cleanItemName(top.name)} (${Number(top.mean).toFixed(2)})`:'N/A'],['Lowest Area',low?`${cleanItemName(low.name)} (${Number(low.mean).toFixed(2)})`:'N/A'],
    ['Below 4.00',String(below)],['Written Remarks',String((r.remarks||[]).filter(x=>String(x||'').trim() && String(x).trim()!=='.').length)],['Reading Focus',r.type==='job'?'Personnel experience':'Client experience']
  ];
  return `<div class="ofms-summary-cards">${cards.map(([k,v])=>`<div><span>${escapeHtml(k)}</span><strong>${escapeHtml(v)}</strong></div>`).join('')}</div>`;
}
function reportDoc(r){
  const reportDate=new Date(r.created).toLocaleDateString('en-PH',{day:'2-digit',month:'long',year:'numeric'});
  const pdfTitle = pdfDocumentTitle(r);
  const profileObj=r.type==='job'?r.years:(Object.keys(r.gender||{}).length?r.gender:r.customerType);
  const profileTitle=r.type==='job'?'Years in Service':'Respondent Profile Distribution';
  const secondaryTitle=r.type==='job'?'Assignment Status':'Service Distribution';
  const secondaryObj=r.type==='job'?r.assignment:(Object.keys(r.service||{}).length?r.service:r.customerType);
  const top=r.items?.[0], low=r.items?.[r.items.length-1];
  const itemText=r.items?.length?`The survey area graph presents the comparative mean score of each measured ${r.type==='job'?'job-satisfaction area':'client-service area'}. ${cleanItemName(top.name)} received the highest score at ${Number(top.mean).toFixed(2)}/5.00, while ${cleanItemName(low.name)} received the lowest score at ${Number(low.mean).toFixed(2)}/5.00. This graph identifies the strongest point to sustain and the lowest point to review.`:'No rating survey areas were available for this report.';
  const narrativeParts=surveyOnlyNarrative(r);
  const pages=[];
  pages.push(ofmsPage(`
    <div class="ofms-command-head"><b>HEADQUARTERS PHILIPPINE ARMY<br>OFFICE OF THE ADJUTANT<br>Fort Andres Bonifacio, Taguig City</b></div>
    <div class="ofms-memo-line"><span>OADJ</span><span>${reportDate}</span></div>
    <p class="ofms-memo"><strong>SUBJECT:</strong> ${escapeHtml(pdfTitle)}</p>
    <p class="ofms-memo"><strong>TO:</strong> Adjutant, PA<br>Post<br>Attn: Admin</p>
    <h2>1. Executive Summary</h2>${summaryCardsGraphOnly(r)}${reportFocusNote(r)}
    <h2>2. ${r.type==='job'?'Summative Job Satisfaction Interpretation':'Summative Client Satisfaction Interpretation'}</h2>
    ${narrativeParts.slice(0,4).map(x=>`<p>${escapeHtml(x)}</p>`).join('')}
  `,'intro-page'));
  pages.push(ofmsPage(`
    <h2>3. Expanded Satisfaction Analysis</h2>
    ${narrativeParts.slice(4).map(x=>`<p>${escapeHtml(x)}</p>`).join('')}
    <h2>4. Key Survey Reading Points</h2>${surveyAreaSummaryHtml(r)}
  `,'analysis-page'));
  pages.push(ofmsPage(`
    <h2>5. Survey Trend and Respondent Composition</h2>${trendGraphHtml(r)}${interpretationBlock('Trend Interpretation',trendInterpretation(r))}
    <h2>6. ${escapeHtml(secondaryTitle)}</h2>${graphCounts(secondaryObj,secondaryTitle)}${interpretationBlock(`${secondaryTitle} Interpretation`,graphInterpretation(secondaryObj,secondaryTitle))}
    <h2>7. ${escapeHtml(profileTitle)}</h2>${graphCounts(profileObj,profileTitle)}${interpretationBlock(`${profileTitle} Interpretation`,graphInterpretation(profileObj,profileTitle))}
  `,'trend-profile-page'));
  pages.push(ofmsPage(`
    <h2>8. ${r.type==='job'?'Job Satisfaction Area Performance':'Client Satisfaction Area Performance'}</h2>${graphItems(r)}${interpretationBlock('Survey Area Interpretation',itemText)}
    <h2>9. Priority and Strength Areas</h2>${priorityGraphHtml(r)}
    <p>The priority graph separates lower-scoring areas from stronger areas. Lower-rated areas should be read as improvement points, while stronger areas may be sustained and used as reference points for future survey periods.</p>
  `,'area-performance-page'));
  pages.push(ofmsPage(`
    <h2>10. Notable Qualitative Remarks</h2>${notableRemarksHtml(r)}${signatoryHtml()}
  `,'remarks-page'));
  return `<article class="report-doc ofms-a4-pdf exact-pdf">${pages.join('')}</article>`;
}
function renderAdvancedUxCards(){
  const latest=latestReport();
  const lensTitle=$('#satisfactionLensTitle'), lensDetails=$('#satisfactionLensDetails'), lensBar=$('#satisfactionLensBar i');
  const followTitle=$('#followupTitle'), followDetails=$('#followupDetails');
  const benchTitle=$('#benchmarkTitle'), benchDetails=$('#benchmarkDetails');
  if(!latest){
    if(lensTitle) lensTitle.textContent='No survey selected'; if(lensDetails) lensDetails.textContent='Generate a report to view satisfaction interpretation.'; if(lensBar) lensBar.style.width='0%';
    if(followTitle) followTitle.textContent='Waiting for results'; if(followDetails) followDetails.textContent='Follow-up recommendations will appear after the latest report is generated.';
    if(benchTitle) benchTitle.textContent='No benchmark reading'; if(benchDetails) benchDetails.textContent='Below-4.00 and strong areas will appear here.';
    return;
  }
  const low=latest.items?.[latest.items.length-1], top=latest.items?.[0];
  const below=(latest.items||[]).filter(x=>Number(x.mean)<4);
  if(lensTitle) lensTitle.textContent=`${satisfactionBand(latest.mean)} • ${latest.satisfaction.toFixed(2)}%`;
  if(lensDetails) lensDetails.textContent=`Latest ${surveyLabel(latest.type)}: ${latest.mean.toFixed(2)}/5.00 across ${latest.items?.length||0} survey area(s) and ${latest.responses} response(s).`;
  if(lensBar) lensBar.style.width=Math.max(0,Math.min(100,latest.satisfaction)).toFixed(1)+'%';
  if(followTitle) followTitle.textContent=low?`Review: ${cleanItemName(low.name)}`:'No priority area';
  if(followDetails) followDetails.textContent=below.length?`Focus on ${topListText(below,3)} because these are below the 4.00 benchmark.`:'Sustain results and continue monitoring future survey cycles.';
  if(benchTitle) benchTitle.textContent=below.length?`${below.length} area(s) below 4.00`:'All detected areas met benchmark';
  if(benchDetails) benchDetails.textContent=top?`Strongest area: ${cleanItemName(top.name)} (${Number(top.mean).toFixed(2)}/5.00).`:'Generate more survey area data for benchmark reading.';
}
(function(){
  const previousRenderDashboard=renderDashboard;
  renderDashboard=function(){
    previousRenderDashboard();
    renderAdvancedUxCards();
    const info=$('#excelInfoSummary');
    if(info && info.innerHTML.includes('Excel')) info.innerHTML=info.innerHTML.replace(/Excel Profile Details/g,'Survey Profile Details').replace(/No Excel data loaded yet\./g,'No survey profile data available yet.');
  };
})();


/* ==========================================================
   FINAL PATCH: richer survey-only PDF + additional UI/UX insights
   ========================================================== */
function cleanRemarksForReport(r, limit=7){
  return (r.remarks||[]).map(x=>String(x||'').trim()).filter(x=>x && x!=='.' && x!=='-' && x.toLowerCase()!=='n/a').slice(0,limit);
}
function surveySpread(r){
  if(!r.items || r.items.length<2) return 0;
  return Number(r.items[0].mean)-Number(r.items[r.items.length-1].mean);
}
function satisfactionMeaning(r){
  const mean=Number(r.mean)||0;
  if(r.type==='job'){
    if(mean>=4.0) return 'The personnel response indicates a favorable work experience. The main reporting value is to sustain the strongest workplace areas while checking whether lower-rated areas may become future risks.';
    if(mean>=3.0) return 'The personnel response indicates an acceptable but watchlisted work experience. The report should be read for specific areas that may affect morale, workload balance, recognition, or communication.';
    return 'The personnel response indicates that several work-experience areas may require closer review. Priority should be placed on the lowest-rated areas and supporting remarks.';
  }
  if(mean>=4.0) return 'The client response indicates a favorable service experience. The main reporting value is to sustain service practices that respondents rated highly while monitoring weaker service points.';
  if(mean>=3.0) return 'The client response indicates an acceptable but watchlisted service experience. The report should be read for areas that may affect timeliness, clarity, responsiveness, or overall client confidence.';
  return 'The client response indicates that service experience may require closer review. Priority should be placed on the lowest-rated areas and supporting remarks.';
}
function satisfactionDataSummary(r){
  const top=r.items?.[0];
  const low=r.items?.[r.items.length-1];
  const below=(r.items||[]).filter(x=>Number(x.mean)<4);
  const strong=(r.items||[]).filter(x=>Number(x.mean)>=4);
  return `<div class="ofms-stat-strip">
    <div><span>Overall Mean</span><b>${r.mean.toFixed(2)}/5.00</b></div>
    <div><span>Satisfaction</span><b>${r.satisfaction.toFixed(2)}%</b></div>
    <div><span>Strong Areas</span><b>${strong.length}</b></div>
    <div><span>Review Areas</span><b>${below.length}</b></div>
  </div>
  <div class="ofms-report-note"><strong>Satisfaction Reading</strong><p>${escapeHtml(satisfactionMeaning(r))}</p>${top&&low?`<p>${escapeHtml(`The score spread between the strongest and lowest survey area is ${surveySpread(r).toFixed(2)} point(s), from ${cleanItemName(top.name)} (${Number(top.mean).toFixed(2)}) to ${cleanItemName(low.name)} (${Number(low.mean).toFixed(2)}).`)}</p>`:''}</div>`;
}
function distinctSurveyBasis(r){
  if(r.type==='job'){
    return `<div class="ofms-report-note"><strong>Job Satisfaction Report Basis</strong><p>This report is interpreted as an internal personnel experience survey. The reading focuses on work environment, supervision, recognition, communication, workload, role experience, resources, and personnel profile. The assignment and years-in-service distributions are used to understand whose workplace experiences are most represented.</p></div>`;
  }
  return `<div class="ofms-report-note"><strong>Client Satisfaction Report Basis</strong><p>This report is interpreted as a client service experience survey. The reading focuses on service access, responsiveness, timeliness, communication, clarity of assistance, courtesy, reliability, and client/service profile. The profile and service distributions are used to understand which client groups or service areas shaped the satisfaction result.</p></div>`;
}
function expandedSurveyOnlyNarrative(r){
  const base=surveyOnlyNarrative(r).filter(x=>!/(worksheet|excel|xlsx|uploaded|system)/i.test(x));
  const top=r.items?.[0], low=r.items?.[r.items.length-1];
  const below=(r.items||[]).filter(x=>Number(x.mean)<4);
  const strong=(r.items||[]).filter(x=>Number(x.mean)>=4);
  const extra=[];
  extra.push(`The satisfaction percentage of ${r.satisfaction.toFixed(2)}% should be read together with the weighted mean of ${r.mean.toFixed(2)}/5.00. The percentage gives a quick view of the satisfaction level, while the mean score gives a more exact rating position across the five-point scale.`);
  if(top&&low) extra.push(`The strongest-to-lowest score gap is ${surveySpread(r).toFixed(2)} point(s). A small gap means the survey areas are relatively consistent, while a wider gap means the overall result is shaped by a clearer difference between strong areas and review areas.`);
  if(strong.length) extra.push(`${r.type==='job'?'Workplace':'Service'} strengths are visible in ${topListText(strong,5)}. These areas should be monitored as positive reference points because they support the overall satisfaction rating.`);
  if(below.length) extra.push(`Areas below the 4.00 review benchmark are ${topListText(below,7)}. These areas are important because they show where the satisfaction result may be improved in the next reporting cycle.`);
  extra.push(r.type==='job'
    ? `For job satisfaction, the report should be used to understand the connection between personnel experience, assignment context, length of service, and the specific workplace areas that respondents rated higher or lower.`
    : `For client satisfaction, the report should be used to understand the connection between client profile, service type, service delivery experience, and the specific service areas that respondents rated higher or lower.`);
  return [...base, ...extra];
}
function reportDoc(r){
  const reportDate=new Date(r.created).toLocaleDateString('en-PH',{day:'2-digit',month:'long',year:'numeric'});
  const pdfTitle=pdfDocumentTitle(r);
  const profileObj=r.type==='job'?r.years:(Object.keys(r.gender||{}).length?r.gender:r.customerType);
  const profileTitle=r.type==='job'?'Years in Service':'Respondent Profile Distribution';
  const secondaryTitle=r.type==='job'?'Assignment Status':'Service Distribution';
  const secondaryObj=r.type==='job'?r.assignment:(Object.keys(r.service||{}).length?r.service:r.customerType);
  const top=r.items?.[0], low=r.items?.[r.items.length-1];
  const itemText=r.items?.length?`The survey area graph presents the comparative mean score of each measured ${r.type==='job'?'job-satisfaction area':'client-service area'}. ${cleanItemName(top.name)} received the highest score at ${Number(top.mean).toFixed(2)}/5.00, while ${cleanItemName(low.name)} received the lowest score at ${Number(low.mean).toFixed(2)}/5.00. This graph identifies the strongest area to sustain and the lowest area to review.`:'No rating survey areas were available for this report.';
  const narrativeParts=expandedSurveyOnlyNarrative(r).filter(x=>!/(worksheet|excel|xlsx|uploaded|system)/i.test(x));
  const usableRemarks=(r.remarks||[])
    .map(x=>String(x||'').trim())
    .filter(x=>x && x!=='.' && x!=='-' && x.toLowerCase()!=='n/a')
    .slice(0,10);
  const remarkChunks=usableRemarks.length
    ? usableRemarks.reduce((chunks, remark, index)=>{
        if(index % 4 === 0) chunks.push([]);
        chunks[chunks.length-1].push(remark);
        return chunks;
      },[])
    : [[]];
  const pages=[];
  const summativeTitle = r.type==='job'?'Summative Job Satisfaction Interpretation':'Summative Client Satisfaction Interpretation';
  pages.push(ofmsPage(`
    <div class="ofms-command-head"><b>HEADQUARTERS PHILIPPINE ARMY<br>OFFICE OF THE ADJUTANT<br>Fort Andres Bonifacio, Taguig City</b></div>
    <div class="ofms-memo-line"><span>OADJ</span><span>${reportDate}</span></div>
    <p class="ofms-memo"><strong>SUBJECT:</strong> ${escapeHtml(pdfTitle)}</p>
    <p class="ofms-memo"><strong>TO:</strong> Adjutant, PA<br>Post<br>Attn: Admin</p>
    <h2>1. Executive Summary</h2>
    ${summaryCardsGraphOnly(r)}
    ${satisfactionDataSummary(r)}
    ${distinctSurveyBasis(r)}
  `,'intro-page'));
  pages.push(ofmsPage(`
    <h2>2. ${summativeTitle}</h2>
    ${narrativeParts.slice(0,2).map(x=>`<p>${escapeHtml(x)}</p>`).join('')}
    ${reportFocusNote(r)}
  `,'summative-page'));
  pages.push(ofmsPage(`
    <h2>3. Expanded Satisfaction Analysis</h2>
    ${narrativeParts.slice(2,6).map(x=>`<p>${escapeHtml(x)}</p>`).join('')}
  `,'analysis-page'));
  pages.push(ofmsPage(`
    <h2>4. Key Survey Reading Points</h2>
    ${surveyAreaSummaryHtml(r)}
    ${narrativeParts.slice(6,9).map(x=>`<p>${escapeHtml(x)}</p>`).join('')}
  `,'reading-points-page'));
  pages.push(ofmsPage(`
    <h2>5. Survey Trend Analysis</h2>
    ${trendGraphHtml(r)}
    ${interpretationBlock('Trend Interpretation',trendInterpretation(r).replace(/uploaded worksheet|worksheet|excel|xlsx/gi,'survey data'))}
  `,'trend-page'));
  pages.push(ofmsPage(`
    <h2>6. ${escapeHtml(secondaryTitle)}</h2>
    ${graphCounts(secondaryObj,secondaryTitle)}
    ${interpretationBlock(`${secondaryTitle} Interpretation`,graphInterpretation(secondaryObj,secondaryTitle))}
  `,'secondary-profile-page'));
  pages.push(ofmsPage(`
    <h2>7. ${escapeHtml(profileTitle)}</h2>
    ${graphCounts(profileObj,profileTitle)}
    ${interpretationBlock(`${profileTitle} Interpretation`,graphInterpretation(profileObj,profileTitle))}
  `,'profile-page'));
  pages.push(ofmsPage(`
    <h2>8. ${r.type==='job'?'Job Satisfaction Area Performance':'Client Satisfaction Area Performance'}</h2>
    ${graphItems(r)}
    ${interpretationBlock('Survey Area Interpretation',itemText)}
  `,'area-performance-page'));
  pages.push(ofmsPage(`
    <h2>9. Priority and Strength Areas</h2>
    ${priorityGraphHtml(r)}
    <p>The priority graph separates lower-scoring areas from stronger areas. Lower-rated areas should be read as improvement points, while stronger areas may be sustained and used as reference points for future survey periods.</p>
  `,'priority-page'));
  remarkChunks.forEach((chunk, index)=>{
    pages.push(ofmsPage(`
      <h2>${index?'10. Notable Qualitative Remarks (continued)':'10. Notable Qualitative Remarks'}</h2>
      ${notableRemarksHtml(r, chunk, index*4)}
    `,'remarks-page'));
  });
  pages.push(ofmsPage(`
    <h2>Prepared and Certified By</h2>
    <p class="memo-note">This page contains the signatory confirmation section for the survey result report.</p>
    ${signatoryHtml()}
  `,'signatory-only-page'));
  return `<article class="report-doc ofms-a4-pdf exact-pdf">${pages.join('')}</article>`;
}
function renderMoreInsightCards(){
  const latest=latestReport();
  const set=(id,t)=>{const e=document.querySelector(id); if(e) e.textContent=t;};
  if(!latest){
    set('#completenessTitle','No active survey'); set('#completenessDetails','Completeness reading will appear after a report is generated.');
    set('#gapTitle','No gap reading'); set('#gapDetails','Highest and lowest survey area gap will be shown here.');
    set('#remarksSignalTitle','No remarks detected'); set('#remarksSignalDetails','Qualitative remark volume and reading value will appear here.');
    set('#directionTitle','Waiting for report'); set('#directionDetails','Suggested reading direction will appear based on survey type and score.'); return;
  }
  const remarks=cleanRemarksForReport(latest,99).length;
  const top=latest.items?.[0], low=latest.items?.[latest.items.length-1];
  const below=(latest.items||[]).filter(x=>Number(x.mean)<4);
  set('#completenessTitle',`${latest.responses} responses • ${latest.items?.length||0} areas`);
  set('#completenessDetails',`Coverage: ${coverageFromReport(latest)}. Report includes satisfaction score, profile distribution, trend, graph readings, and remarks when available.`);
  set('#gapTitle',`${surveySpread(latest).toFixed(2)} point gap`);
  set('#gapDetails',top&&low?`From ${cleanItemName(top.name)} (${Number(top.mean).toFixed(2)}) to ${cleanItemName(low.name)} (${Number(low.mean).toFixed(2)}).`:'Gap reading requires at least two survey areas.');
  set('#remarksSignalTitle',`${remarks} usable remark(s)`);
  set('#remarksSignalDetails',remarks?'Remarks can support the interpretation of high and low satisfaction areas.':'No usable remarks were detected, so interpretation relies on scores and profile distribution.');
  set('#directionTitle',latest.type==='job'?'Personnel experience focus':'Client service focus');
  set('#directionDetails',below.length?`Review ${topListText(below,3)} while sustaining higher-rated areas.`:'Sustain current satisfaction level and continue monitoring future survey movement.');
}
(function(){
  const oldRender=renderDashboard;
  renderDashboard=function(){ oldRender(); renderMoreInsightCards(); };
})();

function signatoryPage(signatories){
  return `<section class="pdf-page signatory-only-page">${pdfMiniHeader()}<h2>Prepared and Certified By</h2><p class="memo-note">This page contains the signatory confirmation section for the survey result report.</p>${signRow(signatories)}${pdfFooter()}</section>`;
}
