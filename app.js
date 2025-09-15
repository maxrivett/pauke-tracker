/* NFL Pool Tracker — vanilla JS, no build, GitHub Pages friendly */

const STORAGE_KEY = 'poolPicks-v1';
const STATE = {
  data: { season: null, weeks: {} },    // your saved picks
  currentSeason: null,
  currentWeek: null,
  teams: null,
  weekSelected: null,
  scoreboardCache: {}                   // cache by "season-week"
};

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

/* ---------- bootstrap ---------- */
window.addEventListener('DOMContentLoaded', async () => {
  loadSaved();
  STATE.teams = await fetch('data/teams.json').then(r => r.json());
  await initSeasonWeek();
  renderTabs();
  setWeek(STATE.currentWeek);

  $('#parseBtn').addEventListener('click', onParse);
  $('#clearPasteBtn').addEventListener('click', () => { $('#pasteInput').value=''; $('#preview').textContent=''; $('#parseErrors').textContent=''; });
  $('#saveWeekBtn').addEventListener('click', saveParsedToWeek);
  $('#refreshBtn').addEventListener('click', refresh);
  $('#exportBtn').addEventListener('click', onExport);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', onImportFile);
});

/* ---------- storage ---------- */
function loadSaved(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    STATE.data = raw ? JSON.parse(raw) : { season: null, weeks: {} };
  } catch { STATE.data = { season: null, weeks: {} }; }
}
function saveAll(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(STATE.data));
}

/* ---------- ESPN week detection ---------- */
async function initSeasonWeek(){
  const url = 'https://site.api.espn.com/apis/v2/sports/football/nfl/scoreboard';
  const js = await fetch(url).then(r => r.json());
  const week = js?.week?.number;
  const season = js?.leagues?.[0]?.season?.year ?? js?.season?.year;
  STATE.currentSeason = season;
  STATE.currentWeek = week || 1;
  if (!STATE.data.season) STATE.data.season = season;
}

/* ---------- tabs ---------- */
function renderTabs(){
  const maxWeek = STATE.currentWeek;
  const bar = $('#weekTabs');
  bar.innerHTML = '';
  for (let w=1; w<=maxWeek; w++){
    const b = document.createElement('button');
    b.className = 'tab' + (w===STATE.currentWeek?' active':'');
    b.textContent = `Week ${w}`;
    b.addEventListener('click', () => setWeek(w));
    bar.appendChild(b);
  }
}

/* ---------- set week ---------- */
async function setWeek(week){
  STATE.weekSelected = week;
  $$('.tab').forEach((el,i)=> el.classList.toggle('active', (i+1)===week));
  await drawWeek();
}

/* ---------- draw current week ---------- */
async function drawWeek(){
  const wkey = String(STATE.weekSelected);
  const weekData = STATE.data.weeks[wkey] || { entries: [], survivor:null, marginator:null, totalPoints:null };
  const sb = await getScoreboard(STATE.currentSeason, STATE.weekSelected);
  drawTable(weekData, sb);
  updateSummary(weekData, sb);
}

/* ---------- fetch scoreboard ---------- */
async function getScoreboard(season, week){
  const key = `${season}-${week}`;
  if (STATE.scoreboardCache[key]) return STATE.scoreboardCache[key];

  const url = `https://site.api.espn.com/apis/v2/sports/football/nfl/scoreboard?seasontype=2&week=${week}`;
  const js = await fetch(url).then(r => r.json()).catch(()=>null);
  if (!js || !Array.isArray(js.events)) return { games: [], byPair:{} };

  const games = js.events.map(ev => {
    const comp = ev.competitions?.[0];
    const status = comp?.status?.type?.state || ev.status?.type?.state || 'pre';
    const details = {
      id: ev.id,
      date: ev.date,
      status,
      completed: status === 'post',
      inprogress: status === 'in',
      neutral: comp?.neutralSite || false,
      competitors: (comp?.competitors || []).map(c=>({
        id: c.id, score: Number(c.score||0),
        homeAway: c.homeAway,
        abbr: c.team?.abbreviation,
        display: c.team?.shortDisplayName || c.team?.name
      }))
    };
    const home = details.competitors.find(x=>x.homeAway==='home');
    const away = details.competitors.find(x=>x.homeAway==='away');
    return { ...details, home, away };
  });

  // map by pair of abbreviations for quick lookup
  const byPair = {};
  for (const g of games){
    if (!g.home?.abbr || !g.away?.abbr) continue;
    const a = g.home.abbr.toUpperCase(), b = g.away.abbr.toUpperCase();
    byPair[`${a}|${b}`] = g;
    byPair[`${b}|${a}`] = g;
  }

  const pack = { games, byPair };
  STATE.scoreboardCache[key] = pack;
  return pack;
}

/* ---------- parsing ---------- */
function normTeamToken(tok){
  if (!tok) return null;
  const t = tok.trim().toUpperCase();
  const aliases = STATE.teams.aliases;
  for (const canon in aliases){
    if (aliases[canon].includes(t)) return canon;
  }
  return null;
}

function parsePicks(text){
  const lines = text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);

  // remove known headings if present
  const drop = new Set(['THE SPREADS','YOUR','FAV','DOG','PICK']);
  const L = lines.filter(x => !drop.has(x.toUpperCase()));

  const entries = [];
  const errors = [];
  let i = 0;

  // read 4-line blocks until keywords
  const isFooterKey = (s)=>/^TOTAL POINTS$|^SURVIVOR$|^MARGINATOR$/.test(s.toUpperCase());
  while (i < L.length){
    if (isFooterKey(L[i].toUpperCase())) break;
    const favRaw = L[i++]; if (i>L.length) break;
    const spreadRaw = L[i++]; if (i>L.length) break;
    const dogRaw = L[i++]; if (i>L.length) break;
    const pickRaw = L[i++]; if (i>L.length) break;

    const fav = normTeamToken(favRaw);
    const dog = normTeamToken(dogRaw);
    const pick = normTeamToken(pickRaw);
    const spread = parseFloat(String(spreadRaw).replace(/[^\d.-]/g,''));

    if (!fav || !dog || !pick || Number.isNaN(spread)){
      errors.push(`Could not parse block starting with "${favRaw}"`);
      continue;
    }
    if (pick !== fav && pick !== dog){
      errors.push(`Pick must be one of FAV/DOG. Block: ${favRaw} ${spreadRaw} ${dogRaw} / Pick=${pickRaw}`);
      continue;
    }
    // enforce .5 rule
    if (Math.abs(spread*2 - Math.round(spread*2)) > 1e-6 || (Math.round(spread*2) % 2 === 0)){
      // If not X.5, warn but allow
      // (Your note says they are always .5; we won't block.)
    }
    entries.push({ fav, dog, spread: Math.abs(spread), pick });
  }

  // footer
  let survivor=null, marginator=null, totalPoints=null;
  while (i < L.length){
    const k = L[i++].toUpperCase();
    const v = L[i++];
    if (k === 'SURVIVOR') survivor = normTeamToken(v);
    else if (k === 'MARGINATOR') marginator = normTeamToken(v);
    else if (k === 'TOTAL POINTS') totalPoints = parseFloat(String(v).replace(/[^\d.-]/g,''));
    else { /* ignore stray */ }
  }

  return { entries, survivor, marginator, totalPoints, errors };
}

/* ---------- UI: parse preview ---------- */
let _lastParsed = null;

function onParse(){
  const raw = $('#pasteInput').value || '';
  const res = parsePicks(raw);
  _lastParsed = res;

  $('#parseErrors').textContent = res.errors.join('\n');
  const prev = res.entries.map((e,idx)=>`${idx+1}. ${e.fav} -${e.spread} vs ${e.dog} | Pick: ${e.pick}`).join('\n');
  const meta = [
    `Total Points: ${res.totalPoints ?? '—'}`,
    `Survivor: ${res.survivor ?? '—'}`,
    `Marginator: ${res.marginator ?? '—'}`
  ].join('\n');
  $('#preview').textContent = (prev || 'No games parsed.') + '\n\n' + meta;
}

function saveParsedToWeek(){
  if (!_lastParsed) return;
  const wkey = String(STATE.weekSelected);
  STATE.data.weeks[wkey] = {
    entries: _lastParsed.entries,
    survivor: _lastParsed.survivor || null,
    marginator: _lastParsed.marginator || null,
    totalPoints: _lastParsed.totalPoints ?? null
  };
  saveAll();
  drawWeek();
}

/* ---------- compute ATS ---------- */
function evaluateATS(entry, game){
  if (!game) return { state:'unmatched', text:'Unmatched', result:null };

  const fav = entry.fav, dog = entry.dog, s = entry.spread;
  // Determine which side is home/away in this game
  const abH = game.home.abbr.toUpperCase();
  const abA = game.away.abbr.toUpperCase();

  // scores
  const scoreFav = (abH===fav ? game.home.score : game.away.score);
  const scoreDog = (abH===dog ? game.home.score : game.away.score);

  const margin = scoreFav - scoreDog; // favorite margin
  const coverFav = margin > s;
  const push = Math.abs(margin - s) < 1e-9; // shouldn't happen with .5 lines
  const coverDog = margin < s;

  let result=null, label='—';
  if (game.completed){
    if (push) { result='push'; label='Push'; }
    else if ((entry.pick===fav && coverFav) || (entry.pick===dog && coverDog)) { result='ok'; label='Correct'; }
    else { result='bad'; label='Incorrect'; }
  } else if (game.inprogress) { result='pending'; label='Live'; }
  else { result=null; label='Not started'; }

  // For Marginator: margin for picked team when final
  let pickMargin = null;
  if (game.completed){
    const pickIsFav = entry.pick===fav;
    const pickScore = pickIsFav ? scoreFav : scoreDog;
    const oppScore = pickIsFav ? scoreDog : scoreFav;
    pickMargin = pickScore - oppScore;
  }

  return { result, label, pickMargin,
           scoreFav, scoreDog,
           fav, dog,
           favCover: coverFav, dogCover: coverDog,
           push };
}

/* ---------- table ---------- */
function drawTable(weekData, sb){
  const tbody = $('#resultsBody');
  tbody.innerHTML = '';
  const surv = weekData.survivor;
  const marg = weekData.marginator;

  weekData.entries.forEach((e, idx) => {
    const g = sb.byPair[`${e.fav}|${e.dog}`]; // match by abbreviations
    const evaln = evaluateATS(e, g);

    const tr = document.createElement('tr');
    if (evaln.result) tr.classList.add(evaln.result);

    const scoreTxt = g
      ? `${g.away.abbr} ${g.away.score} @ ${g.home.abbr} ${g.home.score}`
      : '—';

    const notes = [];
    if (surv && (surv===e.fav || surv===e.dog)) notes.push('<span class="badge surv">Survivor</span>');
    if (marg && (marg===e.fav || marg===e.dog)) {
      const mtxt = (evaln.pickMargin!=null) ? `Margin ${evaln.pickMargin}` : 'Margin —';
      notes.push(`<span class="badge marg">${mtxt}</span>`);
    }

    tr.innerHTML = `
      <td>${idx+1}</td>
      <td>${e.fav} (-${e.spread}) vs ${e.dog}</td>
      <td>-${e.spread}</td>
      <td>${e.pick}</td>
      <td>${scoreTxt}</td>
      <td>${g ? (g.completed?'Final':(g.inprogress?'Live':'Pre')) : 'No match'}</td>
      <td>${evaln.label}</td>
      <td>${notes.join(' ')}</td>
    `;
    tbody.appendChild(tr);
  });
}

/* ---------- summary ---------- */
function updateSummary(weekData, sb){
  let ok=0,bad=0,push=0,prog=0,not=0;
  const survTeam = weekData.survivor;
  const margTeam = weekData.marginator;
  let survText='—', margText='—';

  for (const e of weekData.entries){
    const g = sb.byPair[`${e.fav}|${e.dog}`];
    if (!g){ not++; continue; }
    const ev = evaluateATS(e,g);
    if (g.completed){
      if (ev.result==='ok') ok++;
      else if (ev.result==='bad') bad++;
      else if (ev.result==='push') push++;
    } else if (g.inprogress) prog++; else not++;

    if (survTeam && (survTeam===e.fav || survTeam===e.dog) && g.completed){
      survText = (ev.result==='ok') ? 'PASS' : (ev.result==='push' ? 'PUSH' : 'FAIL');
    }
    if (margTeam && (margTeam===e.pick) && g.completed){
      margText = `Final margin: ${ev.pickMargin}`;
    }
  }
  $('#sumCorrect').textContent = `Correct: ${ok}`;
  $('#sumWrong').textContent = `Incorrect: ${bad}`;
  $('#sumPush').textContent = `Push: ${push}`;
  $('#sumProg').textContent = `In Progress: ${prog}`;
  $('#sumNot').textContent = `Not Started: ${not}`;
  $('#survivorChip').textContent = `Survivor: ${survText}`;
  $('#marginatorChip').textContent = `Marginator: ${margText}`;
}

/* ---------- refresh ---------- */
async function refresh(){
  $('#lastUpdated').textContent = 'Refreshing...';
  await drawWeek();
  $('#lastUpdated').textContent = `Last updated ${new Date().toLocaleTimeString()}`;
}

/* ---------- import/export ---------- */
function onExport(){
  const blob = new Blob([JSON.stringify(STATE.data,null,2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'pool-picks.json';
  a.click();
  URL.revokeObjectURL(a.href);
}
function onImportFile(e){
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const js = JSON.parse(reader.result);
      if (!js || typeof js!=='object' || !js.weeks) throw new Error('Invalid file');
      STATE.data = js;
      saveAll();
      drawWeek();
    } catch(err){
      alert('Import failed: ' + err.message);
    }
    e.target.value='';
  };
  reader.readAsText(file);
}
