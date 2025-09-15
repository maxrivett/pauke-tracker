/* NFL Pool Tracker — public read-only from /picks/{season}.json
   - Data source: ESPN (no API key)
     Primary:  https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard
     Fallback: https://cdn.espn.com/core/nfl/scoreboard?xhr=1
   - Defaults to the latest week present in your JSON (not ESPN’s).
   - URL overrides: ?season=YYYY&week=N
   - Matching order for each pick: pool week → ±1, ±2 → full-season sweep (1..22).
   - Table has 7 columns: Game | Spread | Your Pick | Score | Status | ATS Result | Notes
*/

const STATE = {
    data: { season: null, weeks: {} }, // picks/{season}.json
    currentSeason: null,               // ESPN "current season" (for tabs)
    currentWeekAPI: 1,                 // ESPN "current week" (for tabs)
    weekSelected: 1,
    scoreboardCache: {}                // key: `${season}-${week}` -> { games, byPair }
  };
  
  const $  = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  
  /* ------------------------------ bootstrap ------------------------------ */
  window.addEventListener('DOMContentLoaded', async () => {
    const params = new URLSearchParams(location.search);
    const seasonOverride = params.get('season') ? Number(params.get('season')) : null;
    const weekOverride   = params.get('week')   ? Number(params.get('week'))   : null;
  
    // Detect ESPN current season/week for tab bounds (does not drive selection).
    try {
      const cur = await fetchCurrentScoreboard();
      STATE.currentSeason  = cur.season ?? new Date().getFullYear();
      STATE.currentWeekAPI = cur.week ?? 1;
    } catch {
      const now = new Date();
      STATE.currentSeason  = now.getFullYear();
      STATE.currentWeekAPI = 1;
    }
  
    // Load your season picks file
    const seasonToLoad = seasonOverride || STATE.currentSeason;
    await loadSeasonJSON(seasonToLoad);
  
    // Initial week: override → latest week present in your JSON → 1
    const weeksWithPicks = Object.keys(STATE.data.weeks || {}).map(Number).sort((a,b)=>a-b);
    const latestWeekWithPicks = weeksWithPicks.length ? weeksWithPicks[weeksWithPicks.length-1] : 1;
    const initialWeek = weekOverride || latestWeekWithPicks;
  
    // Tabs span up to max(current ESPN week, latest picks week, initial week)
    const maxTabWeek = Math.max(STATE.currentWeekAPI || 1, latestWeekWithPicks || 1, initialWeek || 1);
    renderTabs({ maxTabWeek, weeksWithPicks });
  
    setWeek(initialWeek);
  
    const refreshBtn = $('#refreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', refresh);
  });
  
  /* ------------------------------ helpers ------------------------------ */
  async function fetchCurrentScoreboard(){
    // Try site.api (usually CORS-open)
    try {
      const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard', { cache:'no-store' });
      if (r.ok) {
        const js = await r.json();
        return {
          season: js?.leagues?.[0]?.season?.year ?? js?.season?.year,
          week:   js?.week?.number
        };
      }
    } catch {}
    // Fallback to CDN wrapper
    try {
      const r = await fetch('https://cdn.espn.com/core/nfl/scoreboard?xhr=1', { cache:'no-store' });
      if (r.ok) {
        const raw = await r.json();
        const js  = raw?.scoreboard || raw;
        return {
          season: js?.leagues?.[0]?.season?.year ?? js?.season?.year,
          week:   js?.week?.number
        };
      }
    } catch {}
    return { season: undefined, week: undefined };
  }
  
  /* ------------------------------ load season file ------------------------------ */
  async function loadSeasonJSON(season){
    try {
      const resp = await fetch(`picks/${season}.json`, { cache: 'no-store' });
      if (!resp.ok) { STATE.data = { season, weeks:{} }; return; }
      const js = await resp.json();
      STATE.data = (js && js.weeks) ? js : { season, weeks:{} };
    } catch {
      STATE.data = { season, weeks:{} };
    }
  }
  
  /* ------------------------------ tabs ------------------------------ */
  function renderTabs({ maxTabWeek, weeksWithPicks }){
    const bar = $('#weekTabs');
    if (!bar) return;
    bar.innerHTML = '';
    for (let w=1; w<=maxTabWeek; w++){
      const b = document.createElement('button');
      b.className = 'tab';
      b.textContent = `Week ${w}`;
      if (weeksWithPicks.includes(w)) b.setAttribute('data-has-picks','1');
      b.addEventListener('click', () => setWeek(w));
      bar.appendChild(b);
    }
  }
  
  async function setWeek(week){
    STATE.weekSelected = week;
    $$('.tab').forEach((el,i)=> el.classList.toggle('active', (i+1)===week));
    await drawWeek();
  }
  
  /* ------------------------------ ESPN scoreboard fetch ------------------------------ */
  /* Primary: site.api; Fallback: CDN wrapper. Results normalized to { games, byPair }. */
  async function getScoreboard(season, week){
    const key = `${season}-${week}`;
    if (STATE.scoreboardCache[key]) return STATE.scoreboardCache[key];
  
    // Primary
    const primary = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=2&week=${week}`;
    // Fallback
    const fallback = `https://cdn.espn.com/core/nfl/scoreboard?xhr=1&dates=${season}&seasontype=2&week=${week}`;
  
    let js = null;
  
    try {
      const r = await fetch(primary, { cache:'no-store' });
      if (r.ok) js = await r.json();
    } catch {}
  
    if (!js || !Array.isArray(js.events)) {
      try {
        const r2 = await fetch(fallback, { cache:'no-store' });
        if (r2.ok) {
          const raw = await r2.json();
          js = raw?.scoreboard || raw;
        }
      } catch {}
    }
  
    if (!js || !Array.isArray(js.events)) {
      const empty = { games: [], byPair: {} };
      STATE.scoreboardCache[key] = empty;
      return empty;
    }
  
    const games = js.events.map(ev => {
      const comp   = ev.competitions?.[0];
      const state  = comp?.status?.type?.state || ev.status?.type?.state || 'pre';
      const teams  = (comp?.competitors || []).map(c => ({
        score: Number(c.score || 0),
        homeAway: c.homeAway,
        abbr: (c.team?.abbreviation || '').toUpperCase(),
        display: c.team?.shortDisplayName || c.team?.name || ''
      }));
      const home = teams.find(x => x.homeAway === 'home');
      const away = teams.find(x => x.homeAway === 'away');
      return {
        status: state,
        completed: state === 'post',
        inprogress: state === 'in',
        home, away
      };
    });
  
    const byPair = {};
    for (const g of games){
      if (!g.home?.abbr || !g.away?.abbr) continue;
      byPair[`${g.home.abbr}|${g.away.abbr}`] = g;
      byPair[`${g.away.abbr}|${g.home.abbr}`] = g;
    }
  
    const pack = { games, byPair };
    STATE.scoreboardCache[key] = pack;
    return pack;
  }
  
  /* ------------------------------ cross-/full-season matching ------------------------------ */
  function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }
  function nearbyWeeks(poolWeek){ return [0, +1, -1, +2, -2].map(d => clamp(poolWeek + d, 1, 22)); }
  
  async function findGameAcrossWeeks(entry, season, poolWeek){
    // 1) Try nearby weeks first
    for (const w of nearbyWeeks(poolWeek)){
      const sb = await getScoreboard(season, w);
      const g  = sb.byPair[`${entry.fav}|${entry.dog}`];
      if (g) return { game:g, week:w };
    }
    // 2) Full-season sweep (cache ensures each week is fetched once)
    for (let w=1; w<=22; w++){
      const sb = await getScoreboard(season, w);
      const g  = sb.byPair[`${entry.fav}|${entry.dog}`];
      if (g) return { game:g, week:w };
    }
    return { game:null, week:null };
  }
  
  /* ------------------------------ ATS evaluation ------------------------------ */
  function evaluateATS(entry, game){
    if (!game) return { result:null, label:'No match', pickMargin:null };
  
    const fav = entry.fav, dog = entry.dog, s = entry.spread;
    const abH = game.home.abbr;
    const scoreFav = (abH===fav ? game.home.score : game.away.score);
    const scoreDog = (abH===dog ? game.home.score : game.away.score);
  
    const margin   = scoreFav - scoreDog;
    const coverFav = margin > s;
    const push     = Math.abs(margin - s) < 1e-9; // safety; you use .5 lines
    const coverDog = margin < s;
  
    let result=null, label='Pre';
    if (game.completed){
      if (push) { result='push'; label='Push'; }
      else if ((entry.pick===fav && coverFav) || (entry.pick===dog && coverDog)) { result='ok'; label='Correct'; }
      else { result='bad'; label='Incorrect'; }
    } else if (game.inprogress) { result='pending'; label='Live'; }
  
    let pickMargin = null;
    if (game.completed){
      const pickIsFav = entry.pick===fav;
      const pickScore = pickIsFav ? scoreFav : scoreDog;
      const oppScore  = pickIsFav ? scoreDog : scoreFav;
      pickMargin = pickScore - oppScore;
    }
    return { result, label, pickMargin };
  }
  
  /* ------------------------------ rendering ------------------------------ */
  async function drawWeek(){
    const w = String(STATE.weekSelected);
    const weekData = STATE.data.weeks[w] || { entries: [], survivor:null, marginator:null, totalPoints:null };
  
    // Warm cache for selected pool week
    await getScoreboard(STATE.data.season || STATE.currentSeason, STATE.weekSelected);
  
    await drawTable(weekData, STATE.data.season || STATE.currentSeason, STATE.weekSelected);
  }
  
  async function drawTable(weekData, season, poolWeek){
    const tbody = $('#resultsBody');
    if (!tbody) return;
    tbody.innerHTML = '';
  
    if (!weekData.entries.length){
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="7" class="muted">No picks saved for Week ${poolWeek} in picks/${STATE.data.season}.json.</td>`;
      tbody.appendChild(tr);
      updateSummaryCounts({ ok:0,bad:0,push:0,prog:0,not:0, survText:'—',margText:'—' });
      return;
    }
  
    const surv = weekData.survivor;
    const marg = weekData.marginator;
  
    let ok=0,bad=0,push=0,prog=0,not=0;
    let survText='—', margText='—';
  
    for (const e of weekData.entries){
      const { game:g } = await findGameAcrossWeeks(e, season, poolWeek);
      const ev = evaluateATS(e, g || null);
  
      if (!g){ not++; }
      else if (g.completed){
        if (ev.result==='ok') ok++;
        else if (ev.result==='bad') bad++;
        else if (ev.result==='push') push++;
      } else if (g.inprogress) { prog++; } else { not++; }
  
      if (surv && (surv===e.fav || surv===e.dog) && g && g.completed){
        survText = (ev.result==='ok') ? 'PASS' : (ev.result==='push' ? 'PUSH' : 'FAIL');
      }
      if (marg && (marg===e.pick) && g && g.completed){
        margText = `Final margin: ${ev.pickMargin}`;
      }
  
      const tr = document.createElement('tr');
      if (ev.result) tr.classList.add(ev.result);
  
      const scoreTxt = g
        ? `${g.away.abbr} ${g.away.score} @ ${g.home.abbr} ${g.home.score}`
        : '—';
  
      const notes = [];
      if (surv && (surv===e.fav || surv===e.dog)) notes.push('<span class="badge surv">Survivor</span>');
      if (marg && (marg===e.fav || marg===e.dog)) {
        const mtxt = (ev.pickMargin!=null) ? `Margin ${ev.pickMargin}` : 'Margin —';
        notes.push(`<span class="badge marg">${mtxt}</span>`);
      }
  
      tr.innerHTML = `
        <td><strong>${e.fav}</strong> (-${e.spread})<div class="muted small">vs <strong>${e.dog}</strong></div></td>
        <td>-${e.spread}</td>
        <td>${e.pick}</td>
        <td>${scoreTxt}</td>
        <td>${g ? (g.completed?'Final':(g.inprogress?'Live':'Pre')) : 'No match'}</td>
        <td>${ev.label}</td>
        <td>${notes.join(' ')}</td>
      `;
      tbody.appendChild(tr);
    }
  
    updateSummaryCounts({ ok,bad,push,prog,not, survText,margText });
  }
  
  function updateSummaryCounts({ ok,bad,push,prog,not, survText,margText }){
    const set = (sel, txt) => { const el = $(sel); if (el) el.textContent = txt; };
    set('#sumCorrect',      `Correct: ${ok}`);
    set('#sumWrong',        `Incorrect: ${bad}`);
    set('#sumPush',         `Push: ${push}`);
    set('#sumProg',         `In Progress: ${prog}`);
    set('#sumNot',          `Not Started: ${not}`);
    set('#survivorChip',    `Survivor: ${survText}`);
    set('#marginatorChip',  `Marginator: ${margText}`);
  }
  
  /* ------------------------------ refresh ------------------------------ */
  async function refresh(){
    const ts = $('#lastUpdated');
    if (ts) ts.textContent = 'Refreshing...';
    const key = `${STATE.data.season || STATE.currentSeason}-${STATE.weekSelected}`;
    delete STATE.scoreboardCache[key]; // force re-fetch for the selected week
    await drawWeek();
    if (ts) ts.textContent = `Last updated ${new Date().toLocaleTimeString()}`;
  }
  