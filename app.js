(function () {
  "use strict";

  const DT_MS = 200;               // 5 Hz
  const FADE_OUT_MS = 600_000;     // 10 minutes
  const SURF_MODE_SET = new Set(["7", "7.0"]);
  const LOGS_DIR = "logs";

  const TILE_LAYERS = [
    { name: "Streets (OSM)", layer: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }) },
    { name: "Light (CartoDB)", layer: L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      { maxZoom: 20, attribution: '&copy; OpenStreetMap contributors &copy; CARTO' }) },
    { name: "Satellite (Esri)", layer: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 20, attribution: "Tiles &copy; Esri" }) },
  ];

  const PALETTE = [
    "#e41a1c", "#377eb8", "#4daf4a", "#984ea3", "#ff7f00", "#a6cee3", "#b2182b",
    "#2166ac", "#1b7837", "#000000", "#666666", "#762a83", "#f781bf", "#80b1d3",
    "#b3de69", "#fdbf6f"
  ];

  const el = {
    btnPlay: document.getElementById("btnPlay"),
    btnPause: document.getElementById("btnPause"),
    btnFade: document.getElementById("btnFade"),
    selSpeed: document.getElementById("selSpeed"),
    slider: document.getElementById("timeSlider"),
    timeLabel: document.getElementById("timeLabel"),
    logSelect: document.getElementById("logSelect"),
    legendItems: document.getElementById("legendItems"),
    status: document.getElementById("status"),
  };

  function setStatus(msg) { el.status.textContent = msg ? `— ${msg}` : ""; }

  const map = L.map("map", { center: [39.2776, -74.5746], zoom: 13, zoomControl: true });

  const baseLayers = {};
  TILE_LAYERS.forEach((t, i) => { baseLayers[t.name] = t.layer; if (i === 1) t.layer.addTo(map); });
  L.control.layers(baseLayers, null, { collapsed: false }).addTo(map);

  const canvas = document.createElement("canvas");
  canvas.id = "trackCanvas";
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
    currentIdx: 0,
    playing: false,
    accMs: 0,
    lastFrame: null,
    lats: [], lons: [], modes: [],
    startEpochMs: 0,
    modeColors: {}, uniqueModes: [],
    surfEndToDist: {},
  };

  function updateFadeButton() {
    el.btnFade.textContent = state.fadeEnabled ? "Fade: On" : "Fade: Off";
    el.btnFade.style.opacity = state.fadeEnabled ? "1.0" : "0.85";
  }
  updateFadeButton();

  function toRad(x){ return x*Math.PI/180; }
  function haversineM(lat1, lon1, lat2, lon2){
    const R=6371000;
    const dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
    const a=Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return 2*R*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  function alphaFor(i, idx){
    if(!state.fadeEnabled) return 1;
    const age=idx-i;
    if(age<0 || age>=fadeN) return 0;
    return 1 - (age/fadeN);
  }

  function project(i){
    const p=map.latLngToContainerPoint([state.lats[i], state.lons[i]]);
    return [p.x, p.y];
  }

  function clear(){ ctx.clearRect(0,0,canvas.width,canvas.height); }

  function drawSegment(i0,i1,a){
    if(a<=0) return;
    const [x0,y0]=project(i0), [x1,y1]=project(i1);
    const color=state.modeColors[state.modes[i0]] || PALETTE[0];
    ctx.globalAlpha=a;
    ctx.strokeStyle=color; ctx.lineWidth=3; ctx.lineCap="round";
    ctx.beginPath(); ctx.moveTo(x0,y0); ctx.lineTo(x1,y1); ctx.stroke();
  }

  function drawPoint(i,a){
    if(a<=0) return;
    const [x,y]=project(i);
    const color=state.modeColors[state.modes[i]] || PALETTE[0];
    ctx.globalAlpha=a;
    ctx.fillStyle=color; ctx.strokeStyle="#111"; ctx.lineWidth=1;
    ctx.beginPath(); ctx.arc(x,y,3.3,0,Math.PI*2); ctx.fill(); ctx.stroke();
  }

  function drawLabel(i,text,a){
    if(a<=0) return;
    const [x,y]=project(i);
    ctx.globalAlpha=a;
    ctx.font="12px ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial";
    ctx.textBaseline="middle"; ctx.textAlign="left";
    ctx.strokeStyle="rgba(255,255,255,0.9)"; ctx.lineWidth=4;
    ctx.strokeText(text,x+8,y);
    ctx.fillStyle="#111"; ctx.lineWidth=1;
    ctx.fillText(text,x+8,y);
  }

  function formatTimeLabel(idx){
    const elapsed=(idx*DT_MS)/1000.0;
    if(state.startEpochMs && state.startEpochMs>0){
      const t=new Date(state.startEpochMs + idx*DT_MS);
      return `${t.toLocaleTimeString()}  (t+${elapsed.toFixed(1)}s)`;
    }
    return `t=${elapsed.toFixed(1)}s`;
  }

  function redraw(idx){
    clear();
    if(!state.loaded || idx<=0) return;
    const start = state.fadeEnabled ? Math.max(0, idx - fadeN) : 0;

    for(let i=start+1;i<=idx;i++) drawSegment(i-1,i,alphaFor(i,idx));
    for(let i=start;i<=idx;i++) drawPoint(i,alphaFor(i,idx));
    for(let i=start;i<=idx;i++){
      const dist=state.surfEndToDist[i];
      if(dist!==undefined) drawLabel(i, `${Math.round(dist)} m`, alphaFor(i,idx));
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
  window.addEventListener("resize", resizeCanvas);
  map.on("resize", resizeCanvas);
  map.on("move zoom", ()=>redraw(state.currentIdx));

  function normalizeMode(v){
    if(v===null||v===undefined) return "unknown";
    const s=String(v).trim();
    return s ? s : "unknown";
  }

  function parseTimeColumn(times){
    let parsed = times.map(x=>{
      const s=(x===null||x===undefined)?"":String(x).trim();
      if(!s) return NaN;
      const t=Date.parse(s);
      return isNaN(t)?NaN:t;
    });
    const ok=parsed.filter(x=>!isNaN(x)).length;
    if(ok>=Math.max(5, Math.floor(times.length*0.5))) return {parsed, ok:true};

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

  function renderLegend(){
    el.legendItems.innerHTML="";
    for(const mode of state.uniqueModes){
      const item=document.createElement("div");
      item.className="legend-item";
      const sw=document.createElement("span");
      sw.className="swatch";
      sw.style.background=state.modeColors[mode];
      const label=document.createElement("span");
      label.textContent=mode;
      item.appendChild(sw); item.appendChild(label);
      el.legendItems.appendChild(item);
    }
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
      cleaned.push({lat, lon, mode: normalizeMode(r["nav mode"]), time: r["boogie gps time"]});
    }
    if(cleaned.length<2){
      setStatus("Not enough valid GPS points.");
      state.loaded=false; clear(); return;
    }

    const times=cleaned.map(x=>x.time);
    const tp=parseTimeColumn(times);
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
      cleaned.length=0; cleaned.push(...sorted);
      state.startEpochMs = tp.parsed[idxs[0]];
    } else {
      state.startEpochMs = 0;
    }

    state.lats=cleaned.map(x=>Math.round(x.lat*1e6)/1e6);
    state.lons=cleaned.map(x=>Math.round(x.lon*1e6)/1e6);
    state.modes=cleaned.map(x=>x.mode);

    const seen=new Set(); state.uniqueModes=[];
    for(const m of state.modes){ if(!seen.has(m)){ seen.add(m); state.uniqueModes.push(m); } }

    state.modeColors={};
    state.uniqueModes.forEach((m,i)=>{ state.modeColors[m]=PALETTE[i%PALETTE.length]; });

    state.surfEndToDist={};
    let i=0;
    while(i<state.modes.length){
      if(!SURF_MODE_SET.has(state.modes[i])){ i++; continue; }
      const start=i;
      let dist=0;
      i++;
      while(i<state.modes.length && SURF_MODE_SET.has(state.modes[i])){
        dist += haversineM(state.lats[i-1], state.lons[i-1], state.lats[i], state.lons[i]);
        i++;
      }
      const end=i-1;
      if(end>start) state.surfEndToDist[end]=dist;
    }

    renderLegend();
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

    clear(); // blank at start
    setStatus(`Loaded ${state.lats.length.toLocaleString()} points.`);
  }

  function loadCsvText(text){
    Papa.parse(text, {
      header:true,
      skipEmptyLines:true,
      dynamicTyping:false,
      complete:(results)=>{
        if(results.errors && results.errors.length) console.warn("PapaParse errors:", results.errors);
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
    setStatus("Loading logs list…");
    el.logSelect.innerHTML = `<option value="">Loading…</option>`;
    let files=[];
    try {
      files = await listLogsViaGitHubAPI();
    } catch(e){
      console.warn("Failed to list logs via GitHub API:", e);
      el.logSelect.innerHTML = `<option value="">(No logs found)</option>`;
      setStatus("Could not list /logs. Host on GitHub Pages and commit logs.");
      return;
    }

    if(!files.length){
      el.logSelect.innerHTML = `<option value="">(No .csv logs in /logs)</option>`;
      setStatus("No logs found in /logs.");
      return;
    }

    el.logSelect.innerHTML="";
    for(const f of files){
      const opt=document.createElement("option");
      opt.value=f.url;
      opt.textContent=f.name;
      el.logSelect.appendChild(opt);
    }

    const params=new URLSearchParams(window.location.search);
    const wanted=params.get("log");
    if(wanted){
      const idx=files.findIndex(x=>x.name===wanted);
      if(idx>=0) el.logSelect.selectedIndex=idx;
    } else {
      el.logSelect.selectedIndex=0;
    }

    await loadSelectedLog();
  }

  async function loadSelectedLog(){
    const url=el.logSelect.value;
    if(!url) return;
    const name=el.logSelect.options[el.logSelect.selectedIndex]?.textContent || "log";
    setStatus(`Loading ${name}…`);
    try{
      const text=await fetchText(url);
      loadCsvText(text);
    } catch(e){
      console.error("Failed to load log:", e);
      setStatus(`Failed to load ${name}: ${e.message}`);
    }
  }

  // Playback
  function step(ts){
    if(!state.playing) return;
    if(state.lastFrame===null) state.lastFrame=ts;
    const speed=parseFloat(el.selSpeed.value||"1");
    const delta=(ts-state.lastFrame)*speed;
    state.lastFrame=ts;
    state.accMs+=delta;

    while(state.accMs>=DT_MS){
      state.accMs-=DT_MS;
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

  el.slider.addEventListener("input", ()=>{
    if(!state.loaded) return;
    state.currentIdx=parseInt(el.slider.value||"0",10);
    el.timeLabel.textContent=formatTimeLabel(state.currentIdx);
    redraw(state.currentIdx);
  });

  el.logSelect.addEventListener("change", loadSelectedLog);

  // Init
  resizeCanvas();
  clear();
  el.timeLabel.textContent=formatTimeLabel(0);
  populateLogDropdown();
})();