/* NFL Pool Tracker — public read-only from /picks/{season}.json
   - Defaults to the latest week present in your JSON (not ESPN’s)
   - URL overrides: ?season=YYYY&week=N
   - Cross-week matching: if a pool week includes MNF/stragglers from another NFL week,
     the matcher searches adjacent NFL weeks (+1, -1, +2, -2) to find the game.
*/

const STATE = {
    data: { season: null, weeks: {} },
    currentSeason: null,
    currentWeekAPI: 1,   // ESPN week (for reference only)
    weekSelected: 1,
    scoreboardCache: {}
  };
  
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  
  /* ------------------------------ bootstrap ------------------------------ */
  window.addEventListener('DOMContentLoaded', async () => {
    // URL overrides
    const params = new URLSearchParams(location.search);
    const seasonOverride = params.get('season') ? Number(params.get('season')) : null;
    const weekOverride   = params.get('week')   ? Number(params.get('week'))   : null;
  
    // Get ESPN "current week" (used for tabs/reference only)
    try {
      const js = await fetch('https://site.api.espn.com/apis/v2/sports/football/nfl/scoreboard').then(r=>r.json());
      STATE.currentSeason  = js?.leagues?.[0]?.season?.year ?? js?.season?.year ?? new Date().getFullYear();
      STATE.currentWeekAPI = js?.week?.number || 1;
    } catch {
      const now = new Date();
      STATE.currentSeason = now.getFullYear();
      STATE.currentWeekAPI = 1;
    }
  
    // Load your season file from /picks
    const seasonToLoad = seasonOverride || STATE.currentSeason;
    await loadSeasonJSON(seasonToLoad);
  
    // Decide initial week:
    const weeksWithPicks = Object.keys(STATE.data.weeks || {}).map(Number).sort((a,b)=>a-b);
    const latestWeekWithPicks = weeksWithPicks.length ? weeksWithPicks[weeksWithPicks.length-1] : 1;
    const initialWeek = weekOverride || latestWeekWithPicks;
  
    // Tabs include up to max(ESPN week, latest with picks)
    const maxTabWeek = Math.max(STATE.currentWeekAPI || 1, latestWeekWithPicks || 1);
    renderTabs({ maxTabWeek, weeksWithPicks });
  
    setWeek(initialWeek);
    const refreshBtn = $('#refreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', refresh);
  });
  
  /* ------------------------------ loading ------------------------------ */
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
  
  /* ------------------------------ scoreboard ------------------------------ */
  async function getScoreboard(season, week){
    const key = `${season}-${week}`;
    if (STATE.scoreboardCache[key]) return STATE.scoreboardCache[key];
  
    const url = `https://site.api.espn.com/apis/v2/sports/football/nfl/scoreboard?seasontype=2&week=${week}`;
    let js = null;
    try { js = await fetch(url).then(r => r.json()); } catch {}
    if (!js || !Array.isArray(js.events)) return { games: [], byPair:{} };
  
    const games = js.events.map(ev => {
      const comp = ev.competitions?.[0];
      const status = comp?.status?.type?.state || ev.status?.type?.state || 'pre';
      const competitors = (comp?.competitors || []).map(c=>({
        score: Number(c.score||0),
        homeAway: c.homeAway,
        abbr: (c.team?.abbreviation || '').toUpperCase(),
        display: c.team?.shortDisplayName || c.team?.name || ''
      }));
      const home = competitors.find(x=>x.homeAway==='home');
      const away = competitors.find(x=>x.homeAway==='away');
      return {
        status,
        completed: status === 'post',
        inprogress: status === 'in',
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
  
  /* ------------------------------ cross-week matching ------------------------------ */
  function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }
  function candidateWeeksForPoolWeek(poolWeek){
    // try same week first, then neighbors; covers MNF/TNF bleed
    const tries = [0, +1, -1, +2, -2];
    return tries.map(d => clamp(poolWeek + d, 1, 22)); // generous upper bound
  }
  
  async function findGameAcrossWeeks(entry, season, poolWeek){
    const attempts = candidateWeeksForPoolWeek(poolWeek);
    for (const w of attempts){
      const sb = await getScoreboard(season, w);
      const g = sb.byPair[`${entry.fav}|${entry.dog}`];
      if (g) return { game:g, week:w };
    }
    return { game:null, week:null };
  }
  
  /* ------------------------------ evaluation ------------------------------ */
  function evaluateATS(entry, game){
    if (!game) return { result:null, label:'No match', pickMargin:null };
  
    const fav = entry.fav, dog = entry.dog, s = entry.spread;
    const abH = game.home.abbr; // home abbreviation
    const scoreFav = (abH===fav ? game.home.score : game.away.score);
    const scoreDog = (abH===dog ? game.home.score : game.away.score);
  
    const margin = scoreFav - scoreDog;
    const coverFav = margin > s;
    const push = Math.abs(margin - s) < 1e-9; // safety (shouldn’t occur with .5 spreads)
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
      const oppScore = pickIsFav ? scoreDog : scoreFav;
      pickMargin = pickScore - oppScore;
    }
    return { result, label, pickMargin };
  }
  
  /* ------------------------------ rendering ------------------------------ */
  async function drawWeek(){
    const w = String(STATE.weekSelected);
    const weekData = STATE.data.weeks[w] || { entries: [], survivor:null, marginator:null, totalPoints:null };
  
    // Preload selected week’s scoreboard; matching will search across weeks anyway
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
  
    // recompute summary while rendering
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
    const set = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
    set('#sumCorrect',   `Correct: ${ok}`);
    set('#sumWrong',     `Incorrect: ${bad}`);
    set('#sumPush',      `Push: ${push}`);
    set('#sumProg',      `In Progress: ${prog}`);
    set('#sumNot',       `Not Started: ${not}`);
    set('#survivorChip', `Survivor: ${survText}`);
    set('#marginatorChip', `Marginator: ${margText}`);
  }
  
  /* ------------------------------ refresh ------------------------------ */
  async function refresh(){
    const ts = $('#lastUpdated');
    if (ts) ts.textContent = 'Refreshing...';
    // clear just the selected week cache to force re-pull
    const key = `${STATE.data.season || STATE.currentSeason}-${STATE.weekSelected}`;
    delete STATE.scoreboardCache[key];
    await drawWeek();
    if (ts) ts.textContent = `Last updated ${new Date().toLocaleTimeString()}`;
  }
  