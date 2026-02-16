(function () {
  "use strict";

  const DT_MS = 200;               // default 5 Hz fallback
  const FADE_OUT_MS = 180_000;     // 3 minutes
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
    insightsStats: document.getElementById("insightsStats"),
    top10Body: document.getElementById("top10Body"),
    status: document.getElementById("status"),
    toggleInstructions: document.getElementById("toggleInstructions"),
    instructions: document.getElementById("instructions"),
    youtubeUrl: document.getElementById("youtubeUrl"),
    videoDelay: document.getElementById("videoDelay"),
    btnSaveYt: document.getElementById("btnSaveYt"),
    btnClearYt: document.getElementById("btnClearYt"),
    videoPanel: document.getElementById("videoPanel"),
    videoTitle: document.getElementById("videoTitle"),
    noVideoOverlay: document.getElementById("noVideoOverlay"),
    btnCloseVideo: document.getElementById("btnCloseVideo"),
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
    boogieEnabled: true, // default ON
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

    // Video integration
    top10Rides: [],        // [{startIdx, endIdx, distM, durMs, maxKmh}, ...]
    activeVideoRide: -1,   // currently playing ride rank (1-based), -1 = none
    currentLogFilename: "",
  };

  // ─── YouTube integration ───────────────────────────────────────────

  let ytPlayer = null;
  let ytReady = !!(window.YT && window.YT.Player);

  // The YouTube IFrame API calls this global function when ready
  // (may have already fired before app.js loaded, so we also check above)
  window.onYouTubeIframeAPIReady = function(){
    ytReady = true;
  };

  function getYtStorageKey(){
    return state.currentLogFilename ? `yt_${state.currentLogFilename}` : null;
  }

  function getDelayStorageKey(){
    return state.currentLogFilename ? `ytdelay_${state.currentLogFilename}` : null;
  }

  function extractYouTubeId(input){
    if(!input) return null;
    input = input.trim();
    if(/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
    let m = input.match(/(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  function getVideoDelay(){
    return parseFloat(el.videoDelay.value) || 0;
  }

  // ─── Video config: URL params (shareable) + localStorage (local) ───
  // URL param ?v encodes a compact string: "dateKey:videoId:delay,dateKey2:videoId2:delay2"
  // dateKey is extracted from the log filename (e.g. "2026-2-9") to keep URLs short.

  /** Extract a short date key from a log filename, e.g. "2026-2-9" */
  function logDateKey(filename){
    if(!filename) return "";
    // Match _logs_YYYY_M_D_ pattern
    const m = filename.match(/_logs_(\d{4})_(\d{1,2})_(\d{1,2})_/);
    if(m) return `${m[1]}-${m[2]}-${m[3]}`;
    // Fallback: match YYYY-MM-DD
    const m2 = filename.match(/(\d{4})-(\d{2})-(\d{2})/);
    if(m2) return `${m2[1]}-${parseInt(m2[2])}-${parseInt(m2[3])}`;
    return filename.slice(0, 16);
  }

  /** Decode the ?v= param. Format: "dateKey:videoId:delay,dateKey2:videoId2:delay2" */
  function getVideoConfigFromUrl(){
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("v");
    if(!raw) return {};
    const map = {};
    for(const entry of raw.split(",")){
      const parts = entry.split(":");
      if(parts.length >= 2){
        const key = parts[0];
        const id = parts[1];
        const delay = parts[2] || "";
        if(key && id) map[key] = { id, delay };
      }
    }
    return map;
  }

  /** Encode the config map into the ?v= URL param */
  function pushVideoConfigToUrl(configMap){
    const url = new URL(window.location);
    const entries = Object.entries(configMap);
    if(entries.length > 0){
      const str = entries.map(([k, v]) => {
        return v.delay && v.delay !== "0" ? `${k}:${v.id}:${v.delay}` : `${k}:${v.id}`;
      }).join(",");
      url.searchParams.set("v", str);
    } else {
      url.searchParams.delete("v");
    }
    window.history.replaceState({}, "", url);
  }

  function getFullVideoConfig(){
    return getVideoConfigFromUrl();
  }

  function loadSavedYouTubeUrl(){
    const filename = state.currentLogFilename;
    if(!filename){ el.youtubeUrl.value = ""; el.videoDelay.value = ""; return; }

    // Priority: URL params > localStorage
    const urlConfig = getVideoConfigFromUrl();
    const dateKey = logDateKey(filename);
    if(dateKey && urlConfig[dateKey]){
      el.youtubeUrl.value = urlConfig[dateKey].id || "";
      el.videoDelay.value = urlConfig[dateKey].delay || "";
    } else {
      const key = getYtStorageKey();
      el.youtubeUrl.value = key ? (localStorage.getItem(key) || "") : "";
      const delayKey = getDelayStorageKey();
      el.videoDelay.value = delayKey ? (localStorage.getItem(delayKey) || "") : "";
    }
  }

  function saveYouTubeUrl(){
    const filename = state.currentLogFilename;
    if(!filename) return;
    const vidId = extractYouTubeId(el.youtubeUrl.value);
    const delayVal = el.videoDelay.value.trim();

    // Save to localStorage
    const key = getYtStorageKey();
    if(key){
      if(vidId) localStorage.setItem(key, el.youtubeUrl.value.trim());
      else localStorage.removeItem(key);
    }
    const delayKey = getDelayStorageKey();
    if(delayKey){
      if(delayVal) localStorage.setItem(delayKey, delayVal);
      else localStorage.removeItem(delayKey);
    }

    // Save to URL param (merge with existing config for other sessions)
    const config = getFullVideoConfig();
    const dateKey = logDateKey(filename);
    if(vidId && dateKey){
      config[dateKey] = { id: vidId };
      if(delayVal && delayVal !== "0") config[dateKey].delay = delayVal;
    } else if(dateKey){
      delete config[dateKey];
    }
    pushVideoConfigToUrl(config);
  }

  function clearYouTubeUrl(){
    const filename = state.currentLogFilename;
    const key = getYtStorageKey();
    if(key) localStorage.removeItem(key);
    const delayKey = getDelayStorageKey();
    if(delayKey) localStorage.removeItem(delayKey);
    el.youtubeUrl.value = "";
    el.videoDelay.value = "";
    destroyYtPlayer();

    // Remove from URL config
    const dateKey = logDateKey(filename);
    if(dateKey){
      const config = getFullVideoConfig();
      delete config[dateKey];
      pushVideoConfigToUrl(config);
    }
  }

  function getActiveYouTubeId(){
    return extractYouTubeId(el.youtubeUrl.value);
  }

  function ensureYtPlayer(videoId){
    if(!ytReady) return false;
    if(ytPlayer && ytPlayer._videoId === videoId) return true;
    destroyYtPlayer();
    ytPlayer = new YT.Player("ytPlayer", {
      width: "100%",
      height: "100%",
      videoId: videoId,
      playerVars: {
        autoplay: 0,
        controls: 0,          // hide YouTube controls — unified via app buttons
        modestbranding: 1,
        rel: 0,
        disablekb: 1,         // disable keyboard shortcuts on player
        vq: "hd2160",         // request 4K playback
      },
    });
    ytPlayer._videoId = videoId;
    return true;
  }

  function destroyYtPlayer(){
    if(ytPlayer){
      try { ytPlayer.destroy(); } catch(e){}
      ytPlayer = null;
    }
    // Recreate the container div (YouTube replaces it with an iframe)
    const container = document.getElementById("ytPlayer");
    if(!container){
      const div = document.createElement("div");
      div.id = "ytPlayer";
      const videoContainer = el.videoPanel.querySelector(".video-container");
      if(videoContainer) videoContainer.insertBefore(div, el.noVideoOverlay);
    }
  }

  /** Show/hide the "no video" overlay, with context-aware message */
  function showNoVideoOverlay(show){
    if(show){
      el.noVideoOverlay.classList.remove("hidden");
      if(getActiveYouTubeId()){
        el.noVideoOverlay.textContent = "No video for this section";
      } else {
        el.noVideoOverlay.textContent = "No video — paste a YouTube URL above and click Save";
      }
    } else {
      el.noVideoOverlay.classList.add("hidden");
    }
  }

  /**
   * Compute the start time (in seconds) of a given ride rank (1-based)
   * within the combined YouTube video.
   * Each clip = ride duration + 2*buffer (20s each side = 40s total).
   * Clips are concatenated in rank order 1..10.
   */
  function computeYtSeekTime(rank){
    const BUFFER = 20; // seconds each side
    let cumulative = 0;
    for(let i = 0; i < state.top10Rides.length && i < rank - 1; i++){
      const r = state.top10Rides[i];
      const rideDurSec = r.durMs / 1000;
      cumulative += rideDurSec + 2 * BUFFER;
    }
    // Apply user delay offset
    cumulative += getVideoDelay();
    return Math.max(0, cumulative);
  }

  /** Pause YouTube player */
  function pauseYtPlayer(){
    try { if(ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo(); } catch(e){}
  }

  /** Play YouTube player */
  function playYtPlayer(){
    try { if(ytPlayer && ytPlayer.playVideo) ytPlayer.playVideo(); } catch(e){}
  }

  /**
   * Play a ride.
   * @param {number} rank - 1-based ride rank
   * @param {number} [scrubIdx] - if provided, resume from this scrubber index
   *        instead of seeking the scrubber to the ride start.
   */
  function playRide(rank, scrubIdx){
    const ride = state.top10Rides[rank - 1];
    if(!ride || rank < 1 || rank > state.top10Rides.length) return;

    // Track which ride is active (set before buffer so scrubber doesn't re-trigger)
    state.activeVideoRide = rank;

    if(scrubIdx == null){
      // Clicked from top 10 list — seek scrubber to 20s before ride
      const bufferSamples = Math.round(20000 / state.dtMs);
      const mapIdx = Math.max(0, ride.startIdx - bufferSamples);
      state.currentIdx = mapIdx;
      el.slider.value = String(mapIdx);
      el.timeLabel.textContent = formatTimeLabel(mapIdx);
      redraw(mapIdx);
    }
    // else: scrubbing — scrubber is already at the right position

    // Center map on the ride start position
    const lat = state.lats[ride.startIdx];
    const lon = state.lons[ride.startIdx];
    if(isFinite(lat) && isFinite(lon)){
      map.setView([lat, lon], Math.max(map.getZoom(), 16), {animate: true});
    }

    // Set speed to 1x for real-time sync and start map playback
    el.selSpeed.value = "1";
    state.playing = true;
    state.lastFrame = null;
    state.accMs = 0;
    requestAnimationFrame(step);

    // Play YouTube video if URL is saved
    const videoId = getActiveYouTubeId();
    if(videoId && ensureYtPlayer(videoId)){
      // Compute seek: clip start + offset into clip based on scrubber position
      let seekSec = computeYtSeekTime(rank);
      if(scrubIdx != null){
        const bufferSamples = Math.round(20000 / state.dtMs);
        const clipStartIdx = Math.max(0, ride.startIdx - bufferSamples);
        const offsetSamples = Math.max(0, scrubIdx - clipStartIdx);
        seekSec += offsetSamples * state.dtMs / 1000;
      }
      el.videoTitle.textContent = `Ride #${rank}: ${Math.round(ride.distM)}m`;
      showNoVideoOverlay(false);

      const doSeek = () => {
        try {
          ytPlayer.seekTo(seekSec, true);
          ytPlayer.playVideo();
          try { ytPlayer.setPlaybackQuality("hd2160"); } catch(e){}
        } catch(e){}
      };
      if(ytPlayer.seekTo) doSeek();
      else setTimeout(doSeek, 1000);
    }
  }

  /** Stop both map and video playback */
  function stopPlayback(){
    state.playing = false;
    pauseYtPlayer();
  }

  function closeVideo(){
    state.activeVideoRide = -1;
    pauseYtPlayer();
    showNoVideoOverlay(true);
    el.videoTitle.textContent = "Video";
  }

  /**
   * Check if the current scrubber index is within a top 10 ride (with buffer).
   * Returns ride rank (1-based) or -1 if not in any ride.
   */
  const RIDE_TAIL_MS = 10000; // 10 seconds of playback after nav mode 7 ends

  function rideAtIndex(idx){
    const bufferSamples = Math.round(20000 / state.dtMs);
    const tailSamples = Math.round(RIDE_TAIL_MS / state.dtMs);
    for(let i = 0; i < state.top10Rides.length; i++){
      const r = state.top10Rides[i];
      const zoneStart = Math.max(0, r.startIdx - bufferSamples);
      const zoneEnd = r.endIdx + tailSamples;
      if(idx >= zoneStart && idx <= zoneEnd) return i + 1;
    }
    return -1;
  }

  /**
   * Check if the scrubber has passed the end of the current ride's video zone.
   * The video zone ends at endIdx + tail (10s after ride ends).
   */
  function isPastRideEnd(idx){
    if(state.activeVideoRide < 1) return false;
    const ride = state.top10Rides[state.activeVideoRide - 1];
    if(!ride) return false;
    const tailSamples = Math.round(RIDE_TAIL_MS / state.dtMs);
    return idx > ride.endIdx + tailSamples;
  }

  function checkScrubberVideo(idx){
    if(!getActiveYouTubeId()) return;

    // Stop at end of ride clip
    if(state.activeVideoRide > 0 && isPastRideEnd(idx)){
      stopPlayback();
      state.activeVideoRide = -1;
      showNoVideoOverlay(true);
      el.videoTitle.textContent = "Ride complete";
      return;
    }

    const ride = rideAtIndex(idx);
    if(ride > 0 && ride !== state.activeVideoRide){
      // Entering a new ride zone — seek video to matching position
      playRide(ride, idx);
    } else if(ride < 0 && state.activeVideoRide > 0){
      // Left a ride zone
      state.activeVideoRide = -1;
      pauseYtPlayer();
      showNoVideoOverlay(true);
      el.videoTitle.textContent = "Video";
    } else if(ride < 0){
      // Scrubbing outside any ride
      showNoVideoOverlay(true);
    }
  }

  // ─── End YouTube integration ──────────────────────────────────────

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

  // fill-only points (no black border)
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

    for(let i=start+1;i<=idx;i++){
      const a = alphaFor(i, idx);
      const color = state.modeColors[state.modes[i-1]] || "#000";
      drawSegment(state.lats[i-1], state.lons[i-1], state.lats[i], state.lons[i], color, a, 1.5);
    }
    for(let i=start;i<=idx;i++){
      drawPoint(state.lats[i], state.lons[i], state.modeColors[state.modes[i]] || "#000", alphaFor(i, idx), 3.3);
    }

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

    for(let i=start;i<=idx;i++){
      const st = state.surfEndToStats[i];
      if(st){
        const a = alphaFor(i,idx);
        drawLabel(state.lats[i], state.lons[i], `${Math.round(st.distM)} m • ${fmtMMSS(st.durMs)} • ${st.maxKmh.toFixed(1)} km/h`, a);
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

  const MODE_LABELS = {"7":"Surfing","7.0":"Surfing","1":"Towing","1.0":"Towing"};

  function renderLegend(){
    el.legendTracks.innerHTML = "";
    el.legendItems.innerHTML = "";
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
    // All items in one list for consistent spacing
    el.legendItems.appendChild(makeItem("Boogie", BOOGIE_COLOR));
    for(const mode of state.uniqueModes){
      el.legendItems.appendChild(makeItem(MODE_LABELS[mode] || mode, state.modeColors[mode] || "#000"));
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
    const top10 = [...waveRuns].sort((a,b)=>b.distM-a.distM).slice(0,10);
    state.top10Rides = top10;

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
      el.insightsStats.innerHTML = `<div class="muted">Load a session to see stats.</div>`;
      el.top10Body.innerHTML = `<div class="muted">Load a session.</div>`;
      return;
    }

    const rows = [
      ["Waves", String(ins.numWaves)],
      ["Wave dist", `${Math.round(ins.totalDistWaves)} m`],
      ["Wave time", fmtHHMMSS(ins.totalTimeWaves)],
      ["Max speed", `${ins.maxSpeedWaves.toFixed(1)} km/h`],
      ["Tow dist", `${Math.round(ins.totalDistTow)} m`],
      ["Tow time", fmtHHMMSS(ins.totalTimeTow)],
      ["Session", fmtHHMMSS(ins.sessionMs)],
    ];

    el.insightsStats.innerHTML = rows.map(([k,v]) =>
      `<div class="insights-stat"><span>${k}</span><span class="mono-label">${v}</span></div>`
    ).join("");

    if(ins.top10.length){
      el.top10Body.innerHTML = `<ol class="top10-grid">${
        ins.top10.map((r, i) => {
          // Use same time source as the scrubber so timestamps match
          const elapsedMs = r.startIdx * state.dtMs;
          const timeStr = (state.startEpochMs > 0)
            ? new Date(state.startEpochMs + elapsedMs).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'})
            : "";
          const stats = `${Math.round(r.distM)}m ${fmtMMSS(r.durMs)} ${r.maxKmh.toFixed(1)}km/h`;
          const timeTag = timeStr ? ` <span class="ride-time">${timeStr}</span>` : "";
          return `<li><a href="#" class="ride-link" data-rank="${i+1}">${stats}${timeTag}</a></li>`;
        }).join("")
      }</ol>`;
    } else {
      el.top10Body.innerHTML = `<div class="muted">No nav mode 7 runs found.</div>`;
    }

    // Attach click handlers for ride links
    el.top10Body.querySelectorAll(".ride-link").forEach(link => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const rank = parseInt(link.dataset.rank, 10);
        playRide(rank);
      });
    });
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

      const mode = String(r["nav mode"] ?? "").trim() || "unknown";
      const sp = Number(r["remote gps speed"]);
      const speedKmh = isFinite(sp) ? sp : NaN;

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

    state.surfEndToStats = {};
    const waveRuns = segmentRunsByMode(SURF_MODE_SET);
    for(const r of waveRuns){
      if(r.endIdx > r.startIdx){
        state.surfEndToStats[r.endIdx] = {distM: r.distM, durMs: r.durMs, maxKmh: r.maxKmh};
      }
    }

    renderLegend();

    const ins = computeInsights();
    renderInsights(ins);

    const latlngs=state.lats.map((lat,k)=>[lat,state.lons[k]]);
    const bounds = L.latLngBounds(latlngs);
    map.fitBounds(bounds, {padding:[40,40], maxZoom: 19, animate: false});
    // Zoom in 1 extra level beyond the auto-fit for a closer default view
    map.setZoom(Math.min(map.getZoom() + 1, 19));

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
      complete:(results)=> ingestRows(results.data||[])
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
      const dt = new Date(Date.UTC(best.y, best.mo, best.d, best.hh, best.mm, best.ss));
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

  async function listLogsViaDirectoryListing(){
    const resp = await fetch(`${LOGS_DIR}/`, {cache:"no-store"});
    if(!resp.ok) throw new Error(`Directory listing HTTP ${resp.status}`);
    const html = await resp.text();
    // Parse .csv filenames from href attributes in the directory listing HTML
    const re = /href="([^"]*\.csv)"/gi;
    const files = [];
    let m;
    while((m = re.exec(html)) !== null){
      let name = decodeURIComponent(m[1]);
      // Strip any path prefix, keep just the filename
      name = name.split("/").pop();
      if(name) files.push({name, url: `${LOGS_DIR}/${name}`});
    }
    if(!files.length) throw new Error("No .csv found in directory listing");
    files.sort((a,b)=>b.name.localeCompare(a.name));
    return files;
  }

  async function populateLogDropdown(){
    setStatus("Loading logs…");
    el.logSelect.innerHTML = `<option value="">Loading…</option>`;
    let files=[];
    try { files = await listLogsViaGitHubAPI(); }
    catch(e){
      // Fallback: try parsing a local directory listing (e.g. python http.server)
      try { files = await listLogsViaDirectoryListing(); }
      catch(e2){
        el.logSelect.innerHTML = `<option value="">(No logs)</option>`;
        setStatus("Could not list /logs");
        return;
      }
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
    state.currentLogFilename = filename;
    loadSavedYouTubeUrl();
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
        checkScrubberVideo(state.currentIdx);
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
      // Also resume YouTube if we're in a ride zone
      if(state.activeVideoRide > 0) playYtPlayer();
    }
  });
  el.btnPause.addEventListener("click", ()=>{
    state.playing=false;
    pauseYtPlayer();
  });

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
    checkScrubberVideo(state.currentIdx);
  });
  el.logSelect.addEventListener("change", ()=>{
    state.activeVideoRide = -1;
    closeVideo();
    loadSelectedLog();
  });

  el.toggleInstructions.addEventListener("click", (e)=>{ e.preventDefault(); el.instructions.classList.toggle("hidden"); });


  el.btnSaveYt.addEventListener("click", ()=>{
    saveYouTubeUrl();
    // Re-render insights to update clickable links
    if(state.loaded){
      const ins = computeInsights();
      renderInsights(ins);
    }
  });
  el.btnClearYt.addEventListener("click", ()=>{
    clearYouTubeUrl();
    if(state.loaded){
      const ins = computeInsights();
      renderInsights(ins);
    }
  });
  el.btnCloseVideo.addEventListener("click", closeVideo);

  el.instructions.classList.add("hidden");

  function init(){
    // Map needs to know its container size in the flex layout
    setTimeout(()=> map.invalidateSize(), 100);
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