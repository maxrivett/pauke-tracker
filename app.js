/* NFL Pool Tracker — public read-only from /picks/{season}.json
   - Defaults to latest week in your JSON
   - URL overrides: ?season=YYYY&week=N
*/

const STATE = {
    data: { season: null, weeks: {} },
    currentSeason: null,
    currentWeekAPI: 1,     // ESPN week (for reference)
    weekSelected: null,
    teams: null,
    scoreboardCache: {},
  };
  
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  
  window.addEventListener('DOMContentLoaded', async () => {
    STATE.teams = await fetch('data/teams.json').then(r => r.json());
  
    const p = new URLSearchParams(location.search);
    const seasonOverride = p.get('season') ? Number(p.get('season')) : null;
    const weekOverride   = p.get('week')   ? Number(p.get('week'))   : null;
  
    // Get ESPN "current" week for tabs/reference (don’t rely on it for selection)
    try {
      const js = await fetch('https://site.api.espn.com/apis/v2/sports/football/nfl/scoreboard').then(r=>r.json());
      STATE.currentSeason = js?.leagues?.[0]?.season?.year ?? js?.season?.year;
      STATE.currentWeekAPI = js?.week?.number || 1;
    } catch {
      const now = new Date();
      STATE.currentSeason = now.getFullYear();
      STATE.currentWeekAPI = 1;
    }
  
    // Load your season JSON (prefer URL param; else ESPN season)
    const seasonToLoad = seasonOverride || STATE.currentSeason;
    const ok = await loadSeasonJSON(seasonToLoad);
    if (!ok) {
      // If missing, don’t block UI; just render empty state
      renderTabs({ maxTabWeek: STATE.currentWeekAPI, weeksWithPicks: [] });
      setWeek(weekOverride || 1);
      return;
    }
  
    // Decide which week to show:
    const weeksWithPicks = Object.keys(STATE.data.weeks).map(Number).sort((a,b)=>a-b);
    const latestWeekWithPicks = weeksWithPicks.length ? weeksWithPicks[weeksWithPicks.length-1] : null;
  
    let initialWeek = weekOverride || latestWeekWithPicks || STATE.currentWeekAPI || 1;
  
    // Tabs should include all weeks up to max(ESPN week, latest week present)
    const maxTabWeek = Math.max(STATE.currentWeekAPI || 1, latestWeekWithPicks || 1);
    renderTabs({ maxTabWeek, weeksWithPicks });
  
    setWeek(initialWeek);
    $('#refreshBtn').addEventListener('click', refresh);
  });
  
  async function loadSeasonJSON(season){
    try {
      const resp = await fetch(`picks/${season}.json`, { cache: 'no-store' });
      if (!resp.ok) return false;
      const js = await resp.json();
      if (!js || !js.weeks) return false;
      STATE.data = js;
      return true;
    } catch { return false; }
  }
  
  function renderTabs({ maxTabWeek, weeksWithPicks }){
    const bar = $('#weekTabs');
    bar.innerHTML = '';
    for (let w=1; w<=maxTabWeek; w++){
      const b = document.createElement('button');
      b.className = 'tab';
      b.textContent = `Week ${w}`;
      if (weeksWithPicks.includes(w)) b.setAttribute('data-has-picks','1'); // style cue
      b.addEventListener('click', () => setWeek(w));
      bar.appendChild(b);
    }
  }
  
  async function setWeek(week){
    STATE.weekSelected = week;
    $$('.tab').forEach((el,i)=> el.classList.toggle('active', (i+1)===week));
    await drawWeek();
  }
  
  async function drawWeek(){
    const w = String(STATE.weekSelected);
    const weekData = STATE.data.weeks[w] || { entries: [], survivor:null, marginator:null, totalPoints:null };
    const sb = await getScoreboard(STATE.data.season || STATE.currentSeason, STATE.weekSelected);
    drawTable(weekData, sb);
    updateSummary(weekData, sb);
  }
  
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
      const details = {
        id: ev.id,
        status,
        completed: status === 'post',
        inprogress: status === 'in',
        competitors: (comp?.competitors || []).map(c=>({
          score: Number(c.score||0),
          homeAway: c.homeAway,
          abbr: c.team?.abbreviation,
          display: c.team?.shortDisplayName || c.team?.name
        }))
      };
      const home = details.competitors.find(x=>x.homeAway==='home');
      const away = details.competitors.find(x=>x.homeAway==='away');
      return { ...details, home, away };
    });
  
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
  
  function evaluateATS(entry, game){
    if (!game) return { result:null, label:'No game', pickMargin:null };
  
    const fav = entry.fav, dog = entry.dog, s = entry.spread;
    const abH = game.home.abbr?.toUpperCase();
    const scoreFav = (abH===fav ? game.home.score : game.away.score);
    const scoreDog = (abH===dog ? game.home.score : game.away.score);
  
    const margin = scoreFav - scoreDog;
    const coverFav = margin > s;
    const push = Math.abs(margin - s) < 1e-9; // won’t happen with .5, kept for safety
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
    return { result, label, pickMargin, scoreFav, scoreDog };
  }
  
  function drawTable(weekData, sb){
    const tbody = $('#resultsBody');
    tbody.innerHTML = '';
  
    if (!weekData.entries.length){
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="8" class="muted">No picks saved for Week ${STATE.weekSelected} in picks/${STATE.data.season}.json.</td>`;
      tbody.appendChild(tr);
      return;
    }
  
    const surv = weekData.survivor;
    const marg = weekData.marginator;
  
    weekData.entries.forEach((e, idx) => {
      const g = sb.byPair[`${e.fav}|${e.dog}`];
      const ev = evaluateATS(e, g);
  
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
        <td>${idx+1}</td>
        <td><strong>${e.fav}</strong> (-${e.spread}) vs <strong>${e.dog}</strong></td>
        <td>-${e.spread}</td>
        <td>${e.pick}</td>
        <td>${scoreTxt}</td>
        <td>${g ? (g.completed?'Final':(g.inprogress?'Live':'Pre')) : 'No match'}</td>
        <td>${ev.label}</td>
        <td>${notes.join(' ')}</td>
      `;
      tbody.appendChild(tr);
    });
  }
  
  function updateSummary(weekData, sb){
    let ok=0,bad=0,push=0,prog=0,not=0;
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
  
      if (weekData.survivor && (weekData.survivor===e.fav || weekData.survivor===e.dog) && g.completed){
        survText = (ev.result==='ok') ? 'PASS' : (ev.result==='push' ? 'PUSH' : 'FAIL');
      }
      if (weekData.marginator && (weekData.marginator===e.pick) && g.completed){
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
  
  async function refresh(){
    $('#lastUpdated').textContent = 'Refreshing...';
    await drawWeek();
    $('#lastUpdated').textContent = `Last updated ${new Date().toLocaleTimeString()}`;
  }
  