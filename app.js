(function () {
  "use strict";

  const DT_MS = 200;               // default 5 Hz fallback
  const FADE_OUT_MS = 600_000;     // 10 minutes
  const SURF_MODE_SET = new Set(["7", "7.0"]);
  const TOW_MODE_SET  = new Set(["1", "1.0"]);
  const LOGS_DIR = "logs";

  // boogie overlay style (independent of nav mode)
  const BOOGIE_COLOR = "#ff00aa";

  const TILE_LAYERS = [
    { name: "Streets (OSM)", layer: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }) },
    { name: "Light (CartoDB)", layer: L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      { maxZoom: 20, attribution: '&copy; OpenStreetMap contributors &copy; CARTO' }) },
    { name: "Satellite (Esri)", layer: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 20, attribution: "Tiles &copy; Esri" }) },
  ];

  const PALETTE = [
    "#e41a1c", "#984ea3", "#ff7f00", "#a6cee3", "#b2182b",
    "#2166ac", "#1b7837", "#000000", "#666666", "#762a83", "#f781bf",
    "#80b1d3", "#b3de69", "#fdbf6f"
  ];

  const el = {
    btnPlay: document.getElementById("btnPlay"),
    btnPause: document.getElementById("btnPause"),
    btnFade: document.getElementById("btnFade"),
    btnBoogie: document.getElementById("btnBoogie"),
    selSpeed: document.getElementById("selSpeed"),
    slider: document.getElementById("timeSlider"),
    timeLabel: document.getElementById("timeLabel"),
    logSelect: document.getElementById("logSelect"),
    legend: document.getElementById("legend"),
    legendItems: document.getElementById("legendItems"),
    legendTracks: document.getElementById("legendTracks"),
    insights: document.getElementById("insights"),
    insightsBody: document.getElementById("insightsBody"),
    btnToggleInsights: document.getElementById("btnToggleInsights"),
    btnToggleLegend: document.getElementById("btnToggleLegend"),
    status: document.getElementById("status"),
    toggleInstructions: document.getElementById("toggleInstructions"),
    instructions: document.getElementById("instructions"),
  };

  function setStatus(msg) { el.status.textContent = msg ? msg : ""; }

  const map = L.map("map", { center: [39.2776, -74.5746], zoom: 13, zoomControl: true });
  const baseLayers = {};
  TILE_LAYERS.forEach((t, i) => { baseLayers[t.name] = t.layer; if (i === 1) t.layer.addTo(map); });
  L.control.layers(baseLayers, null, { collapsed: true, position: "topleft" }).addTo(map);

  const canvas = document.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.top = "0";
  canvas.style.left = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.pointerEvents = "none";
  canvas.style.zIndex = "600";
  map.getContainer().appendChild(canvas);

  const ctx = canvas.getContext("2d");
  const fadeN = Math.max(1, Math.round(FADE_OUT_MS / DT_MS));

  const state = {
    loaded: false,
    fadeEnabled: true,
    boogieEnabled: false,
    currentIdx: 0,
    playing: false,
    accMs: 0,
    lastFrame: null,

    // rider/remote track
    lats: [], lons: [], modes: [], speeds: [],

    // boogie track (same sample index, but can be invalid per-row)
    boogieLats: [], boogieLons: [], boogieValid: [],

    timesMs: null,
    startEpochMs: 0,
    dtMs: DT_MS,
    modeColors: {}, uniqueModes: [],
    surfEndToStats: {},
  };

  function updateFadeButton() {
    el.btnFade.textContent = state.fadeEnabled ? "Fade On" : "Fade Off";
    el.btnFade.style.opacity = state.fadeEnabled ? "1.0" : "0.85";
  }
  function updateBoogieButton(){
    el.btnBoogie.textContent = state.boogieEnabled ? "Boogie On" : "Boogie Off";
    el.btnBoogie.style.opacity = state.boogieEnabled ? "1.0" : "0.85";
  }
  updateFadeButton();
  updateBoogieButton();

  function toRad(x){ return x*Math.PI/180; }
  function haversineM(lat1, lon1, lat2, lon2){
    const R=6371000;
    const dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
    const a=Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return 2*R*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }
  function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }

  function fmtMMSS(ms){
    const s = Math.max(0, Math.round(ms/1000));
    const m = Math.floor(s/60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2,"0")}`;
  }
  function fmtHHMMSS(ms){
    const s = Math.max(0, Math.round(ms/1000));
    const h = Math.floor(s/3600);
    const m = Math.floor((s%3600)/60);
    const r = s % 60;
    if (h>0) return `${h}:${String(m).padStart(2,"0")}:${String(r).padStart(2,"0")}`;
    return `${m}:${String(r).padStart(2,"0")}`;
  }

  function alphaFor(i, idx){
    if(!state.fadeEnabled) return 1;
    const age=idx-i;
    if(age<0 || age>=fadeN) return 0;
    return 1 - (age/fadeN);
  }

  function project(lat, lon){
    const p=map.latLngToContainerPoint([lat, lon]);
    return [p.x, p.y];
  }

  function clear(){ ctx.clearRect(0,0,canvas.width,canvas.height); }

  function drawSegment(lat0, lon0, lat1, lon1, color, a, width=3){
    if(a<=0) return;
    const [x0,y0]=project(lat0, lon0), [x1,y1]=project(lat1, lon1);
    ctx.globalAlpha=a;
    ctx.strokeStyle=color; ctx.lineWidth=width; ctx.lineCap="round";
    ctx.beginPath(); ctx.moveTo(x0,y0); ctx.lineTo(x1,y1); ctx.stroke();
  }

  // Points: fill only (no black border) to keep colors readable
  function drawPoint(lat, lon, color, a, r=3.3){
    if(a<=0) return;
    const [x,y]=project(lat, lon);
    ctx.globalAlpha=a;
    ctx.fillStyle=color;
    ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill();
  }

  function drawLabel(lat, lon, text, a){
    if(a<=0) return;
    const [x,y]=project(lat, lon);
    ctx.globalAlpha=a;
    ctx.font="12px ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial";
    ctx.textBaseline="middle"; ctx.textAlign="left";
    ctx.strokeStyle="rgba(255,255,255,0.92)"; ctx.lineWidth=4;
    ctx.strokeText(text,x+8,y);
    ctx.fillStyle="#111"; ctx.lineWidth=1;
    ctx.fillText(text,x+8,y);
  }

  function formatTimeLabel(idx){
    const elapsedMs = idx * state.dtMs;
    if(state.startEpochMs && state.startEpochMs>0){
      const t=new Date(state.startEpochMs + elapsedMs);
      return `${t.toLocaleTimeString()}  (+${(elapsedMs/1000).toFixed(1)}s)`;
    }
    return `t=${(elapsedMs/1000).toFixed(1)}s`;
  }

  function redraw(idx){
    clear();
    if(!state.loaded || idx<=0) return;
    const start = state.fadeEnabled ? Math.max(0, idx - fadeN) : 0;

    // rider segments/points (color-coded by nav mode)
    for(let i=start+1;i<=idx;i++){
      const a = alphaFor(i, idx);
      const color = state.modeColors[state.modes[i-1]] || "#000";
      drawSegment(state.lats[i-1], state.lons[i-1], state.lats[i], state.lons[i], color, a, 3);
    }
    for(let i=start;i<=idx;i++){
      drawPoint(state.lats[i], state.lons[i], state.modeColors[state.modes[i]] || "#000", alphaFor(i, idx), 3.3);
    }

    // boogie overlay (single color)
    if(state.boogieEnabled){
      for(let i=start+1;i<=idx;i++){
        if(!state.boogieValid[i-1] || !state.boogieValid[i]) continue;
        drawSegment(state.boogieLats[i-1], state.boogieLons[i-1], state.boogieLats[i], state.boogieLons[i], BOOGIE_COLOR, alphaFor(i, idx), 2.5);
      }
      for(let i=start;i<=idx;i++){
        if(!state.boogieValid[i]) continue;
        drawPoint(state.boogieLats[i], state.boogieLons[i], BOOGIE_COLOR, alphaFor(i, idx), 2.6);
      }
    }

    // wave labels at nav mode 7 run end
    for(let i=start;i<=idx;i++){
      const st = state.surfEndToStats[i];
      if(st){
        const a = alphaFor(i,idx);
        drawLabel(
          state.lats[i],
          state.lons[i],
          `${Math.round(st.distM)} m • ${fmtMMSS(st.durMs)} • ${st.maxKmh.toFixed(1)} km/h`,
          a
        );
      }
    }
  }

  function resizeCanvas(){
    const rect=map.getContainer().getBoundingClientRect();
    const dpr=window.devicePixelRatio||1;
    canvas.width=Math.round(rect.width*dpr);
    canvas.height=Math.round(rect.height*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
    redraw(state.currentIdx);
  }

  function normalizeMode(v){
    if(v===null||v===undefined) return "unknown";
    const s=String(v).trim();
    return s ? s : "unknown";
  }

  // If timestamp looks like ISO WITHOUT timezone (no Z / +/-),
  // treat it as UTC by appending 'Z' so it displays correctly in local time (Ocean City, NJ).
  function normalizeTimeString(s){
    const t = String(s ?? "").trim();
    if(!t) return "";
    const hasTZ = /[zZ]$|[+-]\d{2}:\d{2}$/.test(t);
    const isoNoTZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(t);
    if(isoNoTZ && !hasTZ) return t + "Z";
    return t;
  }

  function parseTimeColumn(times){
    let parsed = times.map(x=>{
      const s=normalizeTimeString(x);
      if(!s) return NaN;
      const t=Date.parse(s);
      return isNaN(t)?NaN:t;
    });
    const ok=parsed.filter(x=>!isNaN(x)).length;
    if(ok>=Math.max(5, Math.floor(times.length*0.5))) return {parsed, ok:true};

    // numeric fallback
    parsed = times.map(x=>{
      const n=Number(x);
      if(!isFinite(n)) return NaN;
      if(n>1e11) return n;
      if(n>1e9) return n*1000;
      return NaN;
    });
    const ok2=parsed.filter(x=>!isNaN(x)).length;
    if(ok2>=Math.max(5, Math.floor(times.length*0.5))) return {parsed, ok:true};

    return {parsed:null, ok:false};
  }

  function computeMedianDt(timesMs){
    if(!timesMs) return DT_MS;
    const diffs=[];
    for(let i=1;i<timesMs.length;i++){
      const a=timesMs[i-1], b=timesMs[i];
      if(!isFinite(a)||!isFinite(b)) continue;
      const d=b-a;
      if(d>0 && d<5000) diffs.push(d);
    }
    if(diffs.length<10) return DT_MS;
    diffs.sort((x,y)=>x-y);
    const mid = Math.floor(diffs.length/2);
    const med = (diffs.length%2===0) ? (diffs[mid-1]+diffs[mid])/2 : diffs[mid];
    return clamp(med, 50, 1000);
  }

  function assignColors(uniqueModes){
    const colors = {};
    const used = new Set();
    const FORCE = { "7":"#00a000","7.0":"#00a000","1":"#377eb8","1.0":"#377eb8" };
    for(const m of uniqueModes){
      if(FORCE[m]){ colors[m]=FORCE[m]; used.add(FORCE[m]); }
    }
    let pi=0;
    for(const m of uniqueModes){
      if(colors[m]) continue;
      while(pi<PALETTE.length && used.has(PALETTE[pi])) pi++;
      const c = PALETTE[pi % PALETTE.length];
      colors[m]=c; used.add(c); pi++;
    }
    return colors;
  }

  function renderLegend(){
    // Tracks section
    el.legendTracks.innerHTML = "";
    const makeItem = (label, color) => {
      const item=document.createElement("div");
      item.className="legend-item";
      const sw=document.createElement("span");
      sw.className="swatch";
      sw.style.background=color;
      const txt=document.createElement("span");
      txt.textContent=label;
      item.appendChild(sw); item.appendChild(txt);
      return item;
    };
    el.legendTracks.appendChild(makeItem("Rider", "#111"));
    el.legendTracks.appendChild(makeItem("Boogie", BOOGIE_COLOR));

    // Nav modes section
    el.legendItems.innerHTML="";
    for(const mode of state.uniqueModes){
      const item=document.createElement("div");
      item.className="legend-item";
      const sw=document.createElement("span");
      sw.className="swatch";
      sw.style.background=state.modeColors[mode] || "#000";
      const label=document.createElement("span");
      label.textContent=mode;
      item.appendChild(sw); item.appendChild(label);
      el.legendItems.appendChild(item);
    }
  }

  function durationBetweenIdx(startIdx, endIdx){
    if(endIdx<=startIdx) return 0;
    if(state.timesMs && isFinite(state.timesMs[startIdx]) && isFinite(state.timesMs[endIdx])){
      const d = state.timesMs[endIdx] - state.timesMs[startIdx];
      return d>0 ? d : (endIdx-startIdx)*state.dtMs;
    }
    return (endIdx-startIdx)*state.dtMs;
  }

  function segmentRunsByMode(targetSet){
    const runs=[];
    const n=state.modes.length;
    let i=0;
    while(i<n){
      if(!targetSet.has(state.modes[i])){ i++; continue; }
      const start=i;
      let dist=0;
      let maxKmh = -Infinity;
      maxKmh = Math.max(maxKmh, isFinite(state.speeds[i]) ? state.speeds[i] : -Infinity);
      i++;
      while(i<n && targetSet.has(state.modes[i])){
        dist += haversineM(state.lats[i-1], state.lons[i-1], state.lats[i], state.lons[i]);
        if(isFinite(state.speeds[i])) maxKmh = Math.max(maxKmh, state.speeds[i]);
        i++;
      }
      const end=i-1;
      const durMs = durationBetweenIdx(start, end);
      runs.push({startIdx:start, endIdx:end, distM:dist, durMs, maxKmh: isFinite(maxKmh) ? maxKmh : 0});
    }
    return runs;
  }

  function computeInsights(){
    const waveRuns = segmentRunsByMode(SURF_MODE_SET);
    const towRuns  = segmentRunsByMode(TOW_MODE_SET);

    const numWaves = waveRuns.filter(r => r.endIdx > r.startIdx).length;
    const top10 = [...waveRuns].map(r => r.distM).sort((a,b)=>b-a).slice(0,10);

    const totalDistWaves = waveRuns.reduce((a,r)=>a+r.distM,0);

    let totalDistTow = 0;
    for(let i=1;i<state.modes.length;i++){
      if(TOW_MODE_SET.has(state.modes[i-1]) && TOW_MODE_SET.has(state.modes[i])){
        totalDistTow += haversineM(state.lats[i-1], state.lons[i-1], state.lats[i], state.lons[i]);
      }
    }

    const totalTimeWaves = waveRuns.reduce((a,r)=>a+r.durMs,0);
    const totalTimeTow   = towRuns.reduce((a,r)=>a+r.durMs,0);

    let sessionMs = 0;
    if(state.timesMs && state.timesMs.length>=2 && isFinite(state.timesMs[0]) && isFinite(state.timesMs[state.timesMs.length-1])){
      sessionMs = state.timesMs[state.timesMs.length-1] - state.timesMs[0];
      if(sessionMs < 0) sessionMs = 0;
    } else {
      sessionMs = (state.modes.length-1) * state.dtMs;
    }

    // max speed on waves (nav mode 7)
    let maxSpeedWaves = 0;
    for(let i=0;i<state.modes.length;i++){
      if(SURF_MODE_SET.has(state.modes[i]) && isFinite(state.speeds[i])){
        maxSpeedWaves = Math.max(maxSpeedWaves, state.speeds[i]);
      }
    }

    return { numWaves, top10, totalDistWaves, totalDistTow, totalTimeWaves, totalTimeTow, sessionMs, maxSpeedWaves };
  }

  function renderInsights(ins){
    if(!ins){
      el.insightsBody.innerHTML = `<div class="muted">Load a session to see stats.</div>`;
      return;
    }

    const rows = [
      ["No. of waves", String(ins.numWaves)],
      ["Total distance on waves", `${Math.round(ins.totalDistWaves)} m`],
      ["Total time on waves", fmtHHMMSS(ins.totalTimeWaves)],
      ["Max speed on waves", `${ins.maxSpeedWaves.toFixed(1)} km/h`],
      ["Total distance towing", `${Math.round(ins.totalDistTow)} m`],
      ["Total time towing", fmtHHMMSS(ins.totalTimeTow)],
      ["Total session time", fmtHHMMSS(ins.sessionMs)],
    ];

    const topList = ins.top10.length
      ? `<ol class="insights-list">${ins.top10.map(d=>`<li>${Math.round(d)} m</li>`).join("")}</ol>`
      : `<div class="muted">No nav mode 7 runs found.</div>`;

    el.insightsBody.innerHTML =
      rows.map(([k,v]) => `<div class="insights-row"><span>${k}</span><span class="mono">${v}</span></div>`).join("") +
      `<div style="margin-top:10px;"><div style="font-weight:600;">Top 10 waves (distance)</div>${topList}</div>`;
  }

  function ingestRows(rows){
    setStatus("Parsing…");
    const cleaned=[];
    for(const r of rows){
      const lat=Number(r["remote gps lat"]);
      const lon=Number(r["remote gps lon"]);
      if(!isFinite(lat)||!isFinite(lon)) continue;
      if(lat<-90||lat>90||lon<-180||lon>180) continue;
      if(lat===0&&lon===0) continue;

      const mode = normalizeMode(r["nav mode"]);

      // speed (km/h)
      const sp = Number(r["remote gps speed"]);
      const speedKmh = isFinite(sp) ? sp : NaN;

      // boogie
      const blat = Number(r["boogie gps lat"]);
      const blon = Number(r["boogie gps lon"]);
      const bvalid = (isFinite(blat) && isFinite(blon) && blat>=-90 && blat<=90 && blon>=-180 && blon<=180 && !(blat===0 && blon===0));

      cleaned.push({
        lat, lon, mode, time: r["boogie gps time"],
        speedKmh,
        boogieLat: bvalid ? blat : NaN,
        boogieLon: bvalid ? blon : NaN,
        boogieValid: bvalid
      });
    }
    if(cleaned.length<2){
      setStatus("Not enough valid GPS points.");
      state.loaded=false; clear(); return;
    }

    const timesRaw = cleaned.map(x=>x.time);
    const tp=parseTimeColumn(timesRaw);
    let timesMsSorted = null;

    if(tp.ok){
      const idxs=cleaned.map((_,i)=>i);
      idxs.sort((a,b)=>{
        const ta=tp.parsed[a], tb=tp.parsed[b];
        if(isNaN(ta)&&isNaN(tb)) return a-b;
        if(isNaN(ta)) return 1;
        if(isNaN(tb)) return -1;
        return ta-tb;
      });
      const sorted=idxs.map(i=>cleaned[i]);
      timesMsSorted = idxs.map(i=>tp.parsed[i]);
      cleaned.length=0; cleaned.push(...sorted);
      state.startEpochMs = timesMsSorted.find(x=>isFinite(x)) || 0;
    } else {
      state.startEpochMs = 0;
    }

    state.lats=cleaned.map(x=>Math.round(x.lat*1e6)/1e6);
    state.lons=cleaned.map(x=>Math.round(x.lon*1e6)/1e6);
    state.modes=cleaned.map(x=>x.mode);
    state.speeds=cleaned.map(x=>x.speedKmh);

    state.boogieLats=cleaned.map(x=>x.boogieLat);
    state.boogieLons=cleaned.map(x=>x.boogieLon);
    state.boogieValid=cleaned.map(x=>x.boogieValid);

    state.timesMs = timesMsSorted;
    state.dtMs = computeMedianDt(state.timesMs);

    const seen=new Set(); state.uniqueModes=[];
    for(const m of state.modes){ if(!seen.has(m)){ seen.add(m); state.uniqueModes.push(m); } }
    state.modeColors = assignColors(state.uniqueModes);

    // labels at end of nav 7 runs
    state.surfEndToStats = {};
    const waveRuns = segmentRunsByMode(SURF_MODE_SET);
    for(const r of waveRuns){
      if(r.endIdx > r.startIdx){
        state.surfEndToStats[r.endIdx] = {distM: r.distM, durMs: r.durMs, maxKmh: r.maxKmh};
      }
    }

    renderLegend();

    // insights
    const ins = computeInsights();
    renderInsights(ins);

    // fit to rider track
    const latlngs=state.lats.map((lat,k)=>[lat,state.lons[k]]);
    map.fitBounds(L.latLngBounds(latlngs), {padding:[20,20]});

    state.loaded=true;
    state.currentIdx=0;
    state.playing=false;
    state.accMs=0;
    state.lastFrame=null;

    el.slider.max=String(state.lats.length-1);
    el.slider.value="0";
    el.timeLabel.textContent=formatTimeLabel(0);

    clear();
    setStatus(`Loaded ${state.lats.length.toLocaleString()} pts`);
  }

  function loadCsvText(text){
    Papa.parse(text, {
      header:true,
      skipEmptyLines:true,
      dynamicTyping:false,
      complete:(results)=>{
        ingestRows(results.data||[]);
      }
    });
  }

  async function fetchText(url){
    const resp=await fetch(url, {cache:"no-store"});
    if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  }

  function detectOwnerRepo(){
    const host=window.location.hostname;
    const path=window.location.pathname.replace(/\/+$/,"");
    if(host.endsWith(".github.io")){
      const owner=host.split(".")[0];
      const parts=path.split("/").filter(Boolean);
      const repo=parts.length ? parts[0] : `${owner}.github.io`;
      return {owner, repo};
    }
    return null;
  }

  // Improved prettifier: scans for the LAST date/time pattern in the filename
  function prettyLogLabel(filename){
    const base = filename.replace(/\.csv$/i, "");
    const re = /(\d{4})[-_](\d{1,2})[-_](\d{1,2})[T _-](\d{1,2})[:_-](\d{1,2})(?:[:_-](\d{1,2}))?/g;
    let m, best=null;
    while((m = re.exec(base)) !== null){
      const y=+m[1], mo=+m[2]-1, d=+m[3], hh=+m[4], mm=+m[5], ss=+(m[6]||"0");
      if(hh>=0 && hh<24 && mm>=0 && mm<60 && ss>=0 && ss<60){
        best={y,mo,d,hh,mm,ss, idx:m.index};
      }
    }
    if(best){
      const dt = new Date(best.y, best.mo, best.d, best.hh, best.mm, best.ss);
      const datePart = dt.toLocaleDateString(undefined, { year:"numeric", month:"short", day:"numeric" });
      const timePart = dt.toLocaleTimeString(undefined, { hour:"numeric", minute:"2-digit" });
      return `${datePart} ${timePart}`;
    }

    const re2 = /(\d{4})[-_](\d{1,2})[-_](\d{1,2})/g;
    let best2=null;
    while((m = re2.exec(base)) !== null){
      const y=+m[1], mo=+m[2]-1, d=+m[3];
      best2={y,mo,d, idx:m.index};
    }
    if(best2){
      const dt = new Date(best2.y, best2.mo, best2.d);
      return dt.toLocaleDateString(undefined, { year:"numeric", month:"short", day:"numeric" });
    }

    return base.replace(/[_]+/g, " ").replace(/[-]+/g, "-").replace(/\s+/g, " ").trim();
  }

  async function listLogsViaGitHubAPI(){
    const or=detectOwnerRepo();
    if(!or) throw new Error("Not a github.io host");
    const url=`https://api.github.com/repos/${or.owner}/${or.repo}/contents/${LOGS_DIR}`;
    const resp=await fetch(url, {cache:"no-store"});
    if(!resp.ok) throw new Error(`GitHub API HTTP ${resp.status}`);
    const items=await resp.json();
    const files=(items||[])
      .filter(x=>x && x.type==="file" && typeof x.name==="string" && x.name.toLowerCase().endsWith(".csv"))
      .map(x=>({name:x.name, url: x.download_url || `${LOGS_DIR}/${x.name}`}));
    files.sort((a,b)=>b.name.localeCompare(a.name));
    return files;
  }

  async function populateLogDropdown(){
    setStatus("Loading logs…");
    el.logSelect.innerHTML = `<option value="">Loading…</option>`;
    let files=[];
    try {
      files = await listLogsViaGitHubAPI();
    } catch(e){
      el.logSelect.innerHTML = `<option value="">(No logs)</option>`;
      setStatus("Could not list /logs");
      return;
    }

    if(!files.length){
      el.logSelect.innerHTML = `<option value="">(No .csv in /logs)</option>`;
      setStatus("No logs in /logs");
      return;
    }

    el.logSelect.innerHTML="";
    for(const f of files){
      const opt=document.createElement("option");
      opt.value=f.url;
      opt.textContent=prettyLogLabel(f.name);
      opt.dataset.filename = f.name;
      el.logSelect.appendChild(opt);
    }

    el.logSelect.selectedIndex=0;
    await loadSelectedLog();
  }

  async function loadSelectedLog(){
    const url=el.logSelect.value;
    if(!url) return;
    const opt = el.logSelect.options[el.logSelect.selectedIndex];
    const filename = opt?.dataset?.filename || "log";
    setStatus(`Loading ${filename}…`);
    try{
      const text=await fetchText(url);
      loadCsvText(text);
    } catch(e){
      setStatus(`Failed: ${e.message}`);
    }
  }

  function step(ts){
    if(!state.playing) return;
    if(state.lastFrame===null) state.lastFrame=ts;
    const speed=parseFloat(el.selSpeed.value||"1");
    const delta=(ts-state.lastFrame)*speed;
    state.lastFrame=ts;
    state.accMs+=delta;

    while(state.accMs>=state.dtMs){
      state.accMs-=state.dtMs;
      if(state.currentIdx < state.lats.length-1){
        state.currentIdx+=1;
        el.slider.value=String(state.currentIdx);
        el.timeLabel.textContent=formatTimeLabel(state.currentIdx);
        redraw(state.currentIdx);
      } else {
        state.playing=false;
        break;
      }
    }
    if(state.playing) requestAnimationFrame(step);
  }

  el.btnPlay.addEventListener("click", ()=>{
    if(!state.loaded) return;
    if(!state.playing){
      state.playing=true;
      state.lastFrame=null;
      requestAnimationFrame(step);
    }
  });
  el.btnPause.addEventListener("click", ()=>{ state.playing=false; });

  el.btnFade.addEventListener("click", ()=>{
    state.fadeEnabled=!state.fadeEnabled;
    updateFadeButton();
    redraw(state.currentIdx);
  });

  el.btnBoogie.addEventListener("click", ()=>{
    state.boogieEnabled=!state.boogieEnabled;
    updateBoogieButton();
    redraw(state.currentIdx);
  });

  el.slider.addEventListener("input", ()=>{
    if(!state.loaded) return;
    state.currentIdx=parseInt(el.slider.value||"0",10);
    el.timeLabel.textContent=formatTimeLabel(state.currentIdx);
    redraw(state.currentIdx);
  });
  el.logSelect.addEventListener("change", loadSelectedLog);

  el.btnToggleInsights.addEventListener("click", ()=>{
    el.insights.classList.toggle("hidden");
  });
  el.btnToggleLegend.addEventListener("click", ()=>{
    el.legend.classList.toggle("hidden");
  });
  el.toggleInstructions.addEventListener("click", (e)=>{
    e.preventDefault();
    el.instructions.classList.toggle("hidden");
  });

  // defaults requested
  el.instructions.classList.add("hidden");
  el.insights.classList.add("hidden");
  el.legend.classList.add("hidden");

  function init(){
    resizeCanvas();
    clear();
    el.timeLabel.textContent=formatTimeLabel(0);
    renderLegend();
    populateLogDropdown();
  }
  init();

  window.addEventListener("resize", resizeCanvas);
  map.on("resize", resizeCanvas);
  map.on("move zoom", ()=>redraw(state.currentIdx));
})();
