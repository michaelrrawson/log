(function(){
"use strict";
const CFG = window.LOG_CONFIG || {};
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const KINDS = {temple:"Temple & sacred site",backpacking:"Backpacking",highline:"Highline & rope swing",hike:"Hike",trailrun:"Trail run",bike:"Bike ride",mtb:"Mountain bike",ski:"Backcountry ski",climb:"Climbing & canyoneering",water:"Water & river",city:"City & culture",show:"Show & performance",offroad:"4x4",road:"Road trip",other:"Other"};
// Little figures that ride along the route during replay, one per activity kind (stroke drawings on a 24×24 grid).
const _hiker='<circle cx="12.5" cy="4" r="2" class="f"/><path d="M12 7l-1 6M11 13l2 4v4M11 13l-2 4-1 4M12 8l3 3M16 10l2 11"/>';
const _cyclist='<circle cx="6" cy="17" r="3.5"/><circle cx="18" cy="17" r="3.5"/><path d="M6 17l4-5h5l3 5M10 12l2 5"/><circle cx="14.5" cy="4.5" r="2" class="f"/><path d="M10 11l3-4 3 3.5M10 11l2 4"/>';
const REPLAY_FIGS = {
  hike:_hiker,
  backpacking:_hiker+'<rect x="7.5" y="7" width="3.5" height="6" rx="1" class="f"/>',
  trailrun:'<circle cx="15" cy="4" r="2" class="f"/><path d="M13 7l-3 6M12 8l3 2 2-1M12 8l-4 1M10 13l3 3-1 4M10 13l-3 3H4"/>',
  bike:_cyclist, mtb:_cyclist,
  ski:'<circle cx="14" cy="4" r="2" class="f"/><path d="M13 7l-3 5M10 12l2 3-1 3M10 12l-2 3-1 3M3 18.5l13 2.5M12 8l3 3 1 5"/>',
  climb:_hiker,
  water:'<path d="M3 16c3 2 15 2 18 0" /><circle cx="12" cy="7" r="2" class="f"/><path d="M12 10v4M6 8l12 10"/>',
  offroad:'<path d="M2 16v-4l2-1 3-4h9l3 4h2v5zM7 7v4M12 7v4M2 12h20"/><circle cx="6.5" cy="16.5" r="2.5" class="f"/><circle cx="17.5" cy="16.5" r="2.5" class="f"/>',
};
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const STYLES = { satellite:"mapbox://styles/mapbox/satellite-streets-v12", terrain:"mapbox://styles/mapbox/outdoors-v12" };

/* ---------- small helpers ---------- */
const parseD = s => { const [y,m,d] = String(s||"").split("-").map(Number); return y ? {y,m,d} : null; };
function fmtRange(a,b){
  const s=parseD(a), e=parseD(b); if(!s) return "Undated";
  const one = d => `${d.d} ${MON[d.m-1]} ${d.y}`;
  if(!e || b===a) return one(s);
  if(s.y===e.y && s.m===e.m) return `${s.d}–${e.d} ${MON[s.m-1]} ${s.y}`;
  if(s.y===e.y) return `${s.d} ${MON[s.m-1]} – ${e.d} ${MON[e.m-1]} ${s.y}`;
  return `${one(s)} – ${one(e)}`;
}
const days = (a,b) => { const s=Date.parse(a), e=Date.parse(b||a); return isNaN(s)?0:Math.max(1,Math.round((e-s)/864e5)+1); };
const R = 6371000, rad = Math.PI/180;
function hav(a,b){ const dl=(b[0]-a[0])*rad, dn=(b[1]-a[1])*rad; const h=Math.sin(dl/2)**2+Math.cos(a[0]*rad)*Math.cos(b[0]*rad)*Math.sin(dn/2)**2; return 2*R*Math.asin(Math.sqrt(h)); }
function bearingOf(a,b){ const p1=a[0]*rad,p2=b[0]*rad,dl=(b[1]-a[1])*rad; return (Math.atan2(Math.sin(dl)*Math.cos(p2),Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl))/rad+360)%360; }
function destination(p,brg,dist){ const d=dist/R, b=brg*rad, p1=p[0]*rad, l1=p[1]*rad; const p2=Math.asin(Math.sin(p1)*Math.cos(d)+Math.cos(p1)*Math.sin(d)*Math.cos(b)); const l2=l1+Math.atan2(Math.sin(b)*Math.sin(d)*Math.cos(p1),Math.cos(d)-Math.sin(p1)*Math.sin(p2)); return [p2/rad,((l2/rad+540)%360)-180]; }
const validRoute = r => (Array.isArray(r)?r:[]).filter(p=>Array.isArray(p)&&p.length>=2&&isFinite(p[0])&&isFinite(p[1])).map(p=>[+p[0],+p[1]]);
const routeMeters = r => { let d=0; for(let i=1;i<r.length;i++) d+=hav(r[i-1],r[i]); return d; };
const mi = m => m/1609.344;
const ll = p => [p[1],p[0]]; // [lat,lng] -> [lng,lat] for Mapbox
function parseCoords(str){
  const m = String(str||"").match(/(-?\d+(?:\.\d+)?)\s*°?\s*([NS])?\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EW])?/i);
  if(!m) return null; let lat=+m[1], lng=+m[3];
  if(m[2] && /s/i.test(m[2])) lat=-Math.abs(lat);
  if(m[4] && /w/i.test(m[4])) lng=-Math.abs(lng);
  return (Math.abs(lat)>90||Math.abs(lng)>180) ? null : [lat,lng];
}
const parseRoute = str => String(str||"").split(/\n|;/).map(s=>s.trim()).filter(Boolean).map(parseCoords).filter(Boolean);
function simplify(pts,tol){ // Ramer–Douglas–Peucker on lat/lng scaled by cos(lat)
  if(pts.length<3) return pts;
  const k=Math.cos(pts[0][0]*rad), keep=new Uint8Array(pts.length); keep[0]=keep[pts.length-1]=1;
  const stack=[[0,pts.length-1]];
  while(stack.length){ const [a,b]=stack.pop(); let md=0, mi_=-1;
    const ax=pts[a][1]*k, ay=pts[a][0], bx=pts[b][1]*k, by=pts[b][0], dx=bx-ax, dy=by-ay, L=dx*dx+dy*dy||1e-18;
    for(let i=a+1;i<b;i++){ const px=pts[i][1]*k, py=pts[i][0]; let t=((px-ax)*dx+(py-ay)*dy)/L; t=Math.max(0,Math.min(1,t)); const ex=ax+t*dx-px, ey=ay+t*dy-py, d=ex*ex+ey*ey; if(d>md){md=d;mi_=i;} }
    if(mi_>0 && md>tol*tol){ keep[mi_]=1; stack.push([a,mi_],[mi_,b]); } }
  return pts.filter((_,i)=>keep[i]);
}
function parseGPX(text){
  const doc=new DOMParser().parseFromString(text,"application/xml");
  let nodes=[...doc.getElementsByTagName("trkpt")]; if(nodes.length<2) nodes=[...doc.getElementsByTagName("rtept")]; if(nodes.length<2) nodes=[...doc.getElementsByTagName("wpt")];
  let pts=nodes.map(n=>[+n.getAttribute("lat"),+n.getAttribute("lon")]).filter(p=>isFinite(p[0])&&isFinite(p[1]));
  let tol=0.000005; while(pts.length>4000){ pts=simplify(pts,tol); tol*=2; }
  return pts.map(p=>[+p[0].toFixed(6),+p[1].toFixed(6)]);
}
function toast(msg){ const t=$("#toast"); t.textContent=msg; t.hidden=false; clearTimeout(toast.t); toast.t=setTimeout(()=>t.hidden=true,2800); }

/* ---------- data: Supabase, with the JSON backup as fallback ---------- */
const sb = (CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase) ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
  // Supabase's default cross-tab lock can hang forever when another tab of the log holds it,
  // leaving the page stuck on "Loading…". Wait up to 3 s for it, then go ahead without it.
  auth:{ lock: async (name, _t, fn) => {
    if(!navigator.locks) return fn();
    const ctl=new AbortController(); const timer=setTimeout(()=>ctl.abort(),3000);
    try{ return await navigator.locks.request(name,{signal:ctl.signal},async()=>{ clearTimeout(timer); return fn(); }); }
    catch(err){ if(err&&err.name==="AbortError") return fn(); throw err; }
  } }
}) : null;
let entries=[], trips=[], selected=null, selTrip=null, canEdit=false, source="";
// Public reads go through a client that never touches sign-in, so the log always loads
// even if the editor's auth session is stuck in another tab.
const pub = sb ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth:{ persistSession:false, autoRefreshToken:false, detectSessionInUrl:false, storageKey:"sb-log-public" } }) : null;
const photoUrl = p => sb ? sb.storage.from("photos").getPublicUrl(p.path).data.publicUrl : (p.url||"");
function norm(r){ return {...r, lat:+r.lat, lng:+r.lng, route:validRoute(r.route), photos:Array.isArray(r.photos)?r.photos:[], gear:Array.isArray(r.gear)?r.gear.filter(g=>typeof g==="string"&&g.trim()).map(g=>g.trim()):[], stats:(r.stats&&typeof r.stats==="object")?r.stats:{}, peaks:normPeaks(r.peaks), trip_id:r.trip_id||null, notes:r.notes||"", place:r.place||"", kind:KINDS[r.kind]?r.kind:"other"}; }
const normPeaks = a => (Array.isArray(a)?a:[]).filter(p=>p&&typeof p.name==="string"&&p.name.trim()).map(p=>({name:p.name.trim(),elev_m:isFinite(+p.elev_m)&&p.elev_m!==null&&p.elev_m!==""?+p.elev_m:null,...(isFinite(+p.lat)&&isFinite(+p.lng)&&p.lat!=null?{lat:+p.lat,lng:+p.lng}:{})}));
// Trips are switched off for now. The data stays in the database; set this to true to bring them back.
const TRIPS_ON = false;
const normTrip = t => ({id:t.id,title:t.title||"Untitled trip",notes:t.notes||""});
async function loadEntries(){
  if(sb){
    const [a,b] = await Promise.all([pub.from("entries").select("*").order("start_date"), pub.from("trips").select("*")]);
    if(!a.error){ entries=a.data.map(norm); trips=(!TRIPS_ON||b.error?[]:b.data).map(normTrip); source="live"; return; }
    console.warn("Supabase unavailable, using backup", a.error);
  }
  try{ const r=await fetch("data/entries.json",{cache:"no-store"}); entries=(await r.json()).map(norm); source=sb?"backup":"file"; }
  catch{ entries=[]; source="none"; }
  try{ const r=TRIPS_ON&&await fetch("data/trips.json",{cache:"no-store"}); trips=r&&r.ok?(await r.json()).map(normTrip):[]; }catch{ trips=[]; }
}
async function refresh(keepView){ await loadEntries(); if(selected && !entries.find(e=>e.id===selected)){ selected=null; setUrl(null); } if(selTrip && !tripById(selTrip)){ selTrip=null; setUrl(null); } renderAll(); if(!keepView && !selected) fitAll(false); }

/* ---------- auth: one editor login by email link ---------- */
async function initAuth(){
  if(!sb){ $("#who").textContent = "Read-only copy"; return; }
  $("#authBtn").hidden=false;
  const upd = async session => {
    canEdit=false;
    if(session){ const {data} = await sb.rpc("is_admin"); canEdit = data===true; }
    $("#authBtn").textContent = session ? "Sign out" : "Editor sign in";
    $("#who").textContent = session ? (canEdit ? "Editing" : "Signed in, view only") : "";
    $("#addBtn").hidden=!canEdit; renderAll(); stravaStatus();
  };
  sb.auth.onAuthStateChange((_ev,session)=>upd(session));
  const {data:{session}} = await sb.auth.getSession(); upd(session);
  $("#authBtn").onclick = async ()=>{
    const {data:{session}} = await sb.auth.getSession();
    if(session){ await sb.auth.signOut(); toast("Signed out"); return; }
    openSignIn();
  };
}
/* ---------- Strava auto-sync (editors only): the server pulls new activities every 3 hours ---------- */
async function stravaStatus(){
  const box=$("#strava"); if(!box) return;
  if(!canEdit||!sb){ box.hidden=true; return; }
  const {data}=await sb.rpc("strava_status"); box.hidden=false;
  if(!data||!data.connected){ box.innerHTML=`<span>Strava not connected</span><button type="button" class="link" id="stConnect">Connect</button>`; }
  else{ const ago=data.last_sync?Math.round((Date.now()-Date.parse(data.last_sync))/6e4):null;
    const when=ago===null?"not yet":ago<2?"just now":ago<90?`${ago} min ago`:ago<2880?`${Math.round(ago/60)} h ago`:`${Math.round(ago/1440)} d ago`;
    box.innerHTML=`<span title="${esc(data.last_result||"")}">Strava synced ${when}</span><button type="button" class="link" id="stSync">Sync now</button>`; }
  const c=$("#stConnect"); if(c) c.onclick=async()=>{ const {data:n,error}=await sb.rpc("strava_connect_nonce"); if(error){ toast("Couldn't start: "+error.message); return; } location.href=`${CFG.supabaseUrl}/functions/v1/strava-connect?start=1&state=${n}`; };
  const y=$("#stSync"); if(y) y.onclick=async()=>{ y.textContent="Syncing…"; y.disabled=true;
    const {data:r,error}=await sb.functions.invoke("strava-sync",{body:{}});
    if(error||!r||!r.ok) toast("Sync didn't finish: "+((r&&r.error)||(error&&error.message)||"unknown error"));
    else toast(r.added?`Added ${r.added} from Strava`:"Nothing new on Strava");
    if(r&&r.added) await refresh(true); stravaStatus(); };
}
function stravaReturn(){
  const u=new URL(location.href), s=u.searchParams.get("strava"); if(!s) return;
  const msg={connected:"Strava connected. Importing new activities…","missing-keys":"Strava keys aren't set on the server yet.",expired:"That Strava link expired. Try Connect again.",denied:"Strava access wasn't granted.","need-private":"Allow access to all activities (including private) so the sync can read them.",failed:"Strava didn't accept the connection. Try again."}[s]||"Strava: "+s;
  toast(msg); u.searchParams.delete("strava"); history.replaceState(null,"",u);
  if(s==="connected") setTimeout(()=>refresh(true),20000);
}
function openSignIn(){
  const root=document.createElement("div");
  root.innerHTML=`<div class="scrim"></div><form class="side" role="dialog" aria-modal="true" aria-label="Editor sign in">
    <div class="shead"><span class="label">Editor sign in</span><button class="xclose" type="button" aria-label="Close">×</button></div>
    <p class="notes">Enter your editor email. You'll get a link that signs you in on this device.</p>
    <div class="f"><label class="label" for="siEmail">Email</label><input id="siEmail" type="email" required autocomplete="email"></div>
    <p class="formerr" id="siErr"></p>
    <div class="acts"><span class="sp"></span><button class="btn solid label" type="submit">Send link</button></div></form>`;
  document.body.appendChild(root);
  const close=()=>root.remove();
  root.querySelector(".scrim").onclick=close; root.querySelector(".xclose").onclick=close;
  setTimeout(()=>root.querySelector("#siEmail").focus(),40);
  root.querySelector("form").onsubmit=async ev=>{
    ev.preventDefault(); const email=root.querySelector("#siEmail").value.trim();
    const {error}=await sb.auth.signInWithOtp({email,options:{emailRedirectTo:location.origin+location.pathname}});
    if(error){ root.querySelector("#siErr").textContent="Couldn't send the link: "+error.message; return; }
    close(); toast("Check your email for the sign-in link");
  };
}

/* ---------- map ---------- */
let map=null, styleKey="satellite", markers={};
function initMap(){
  if(!window.mapboxgl || !CFG.mapboxToken){ $("#mapErr").hidden=false; $("#mapErr").textContent="The map couldn't load. Check the Mapbox token in config.js."; return; }
  mapboxgl.accessToken = CFG.mapboxToken;
  map = new mapboxgl.Map({container:"map", style:STYLES.satellite, projection:"globe", center:[-40,30], zoom:1.6, pitch:0, attributionControl:true, antialias:true});
  window.__logMap = map; // handy for debugging from the console
  map.addControl(new mapboxgl.NavigationControl({visualizePitch:true}),"top-right");
  map.addControl(new mapboxgl.ScaleControl({unit:"imperial"}),"bottom-left");
  map.on("style.load", setupStyle);
  ["mousedown","touchstart","wheel"].forEach(ev=>map.on(ev,stopCam));  // let the person take over mid-glide
  map.on("error", e => { if(e && e.error && /401|403|token/i.test(String(e.error.message||e.error.status))){ $("#mapErr").hidden=false; $("#mapErr").textContent="Mapbox refused the token. If it's restricted, check that this site's address is on its URL list."; } });
}
function setupStyle(){
  if(!map.getSource("dem")) map.addSource("dem",{type:"raster-dem",url:"mapbox://mapbox.mapbox-terrain-dem-v1",tileSize:512,maxzoom:14});
  map.setTerrain({source:"dem",exaggeration:1.35});
  map.setFog({range:[1,9],color:"rgb(186,210,235)","high-color":"rgb(36,92,223)","horizon-blend":0.03,"space-color":"rgb(8,10,20)","star-intensity":0.25});
  map.addSource("routes",{type:"geojson",data:routesGeo()});
  map.addSource("replay",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
  map.addLayer({id:"routes-glow",type:"line",source:"routes",layout:{"line-cap":"round","line-join":"round"},paint:{"line-color":"#2f9bff","line-width":["case",["get","on"],9,0],"line-opacity":0.25,"line-blur":4}});
  map.addLayer({id:"routes-line",type:"line",source:"routes",layout:{"line-cap":"round","line-join":"round"},paint:{"line-color":"#2f9bff","line-width":["case",["get","on"],3,1.6],"line-opacity":["case",["get","on"],1,0.6]}});
  map.addLayer({id:"replay-glow",type:"line",source:"replay",filter:["==",["geometry-type"],"LineString"],layout:{"line-cap":"round","line-join":"round"},paint:{"line-color":"#2f9bff","line-width":12,"line-opacity":0.3,"line-blur":5}});
  map.addLayer({id:"replay-line",type:"line",source:"replay",filter:["==",["geometry-type"],"LineString"],layout:{"line-cap":"round","line-join":"round"},paint:{"line-color":"#2f9bff","line-width":4}});
  map.addSource("trail",{type:"geojson",lineMetrics:true,data:{type:"Feature",properties:{},geometry:{type:"LineString",coordinates:[[0,0],[0,0]]}}});
  map.addLayer({id:"trail-glow",type:"line",source:"trail",layout:{"line-cap":"round","line-join":"round",visibility:"none"},paint:{"line-color":"#2f9bff","line-width":12,"line-opacity":0.3,"line-blur":5,"line-trim-offset":[0,1]}});
  map.addLayer({id:"trail-line",type:"line",source:"trail",layout:{"line-cap":"round","line-join":"round",visibility:"none"},paint:{"line-color":"#2f9bff","line-width":4,"line-trim-offset":[0,1]}});
  applyVisibility();
}
function routesGeo(){
  return {type:"FeatureCollection",features:entries.filter(e=>e.route.length>1).map(e=>({type:"Feature",properties:{id:e.id,on:isOn(e)},geometry:{type:"LineString",coordinates:e.route.map(ll)}}))};
}
function drawRoutes(){ if(map && map.getSource("routes")){ map.getSource("routes").setData(routesGeo()); applyVisibility(); } }
function applyVisibility(){
  const ids=new Set(shown().map(e=>e.id)), list=["literal",[...ids]];
  for(const [id,m] of Object.entries(markers)) m.getElement().style.display = ids.has(id) ? "" : "none";
  if(!map || !map.getLayer("routes-line")) return;
  const f=["in",["get","id"],list];
  ["routes-line","routes-glow"].forEach(l=>map.setFilter(l,f));
}
function drawMarkers(){
  if(!map) return;
  for(const m of Object.values(markers)) m.remove(); markers={};
  for(const e of entries){
    const el=document.createElement("div"); el.className="pinwrap";
    const b=document.createElement("button"); b.type="button"; b.className="pin"+(isOn(e)?" on":""); b.setAttribute("aria-label",e.title);
    b.innerHTML=`<span class="tip">${esc(e.title)}<span class="mono">${esc(fmtRange(e.start_date,e.end_date))}</span></span>`;
    b.addEventListener("click",ev=>{ ev.stopPropagation(); select(e.id,{fly:true}); });
    el.appendChild(b);
    markers[e.id]=new mapboxgl.Marker({element:el,anchor:"bottom"}).setLngLat([e.lng,e.lat]).addTo(map);
  }
  applyVisibility();
}
const isOn = e => e.id===selected || (!!selTrip && e.trip_id===selTrip);
function boundsOf(pts){ const b=new mapboxgl.LngLatBounds(); pts.forEach(p=>b.extend(ll(p))); return b; }
// Camera move to an entry. Mapbox's own easeTo/flyTo re-aim at the ground under the screen
// center every frame, which makes the camera bob over steep 3D terrain. Instead we capture the
// start and end camera positions in the air and glide straight between them (with a small lift
// for longer hops), so nothing follows the terrain mid-move.
const easeIO = t => t<.5 ? 4*t*t*t : 1-Math.pow(-2*t+2,3)/2;
let camAnim=null;
function stopCam(){ if(camAnim){ cancelAnimationFrame(camAnim.raf); camAnim=null; } }
function slerp(a,b,t){
  let d=a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3]; if(d<0){ b=b.map(v=>-v); d=-d; }
  if(d>0.9995){ const r=a.map((v,i)=>v+(b[i]-v)*t), n=Math.hypot(...r); return r.map(v=>v/n); }
  const th=Math.acos(d), s0=Math.sin((1-t)*th)/Math.sin(th), s1=Math.sin(t*th)/Math.sin(th);
  return a.map((v,i)=>v*s0+b[i]*s1);
}
function glideTo(cam){
  stopCam();
  const from=map.getFreeCameraOptions(), p0=from.position, q0=[...from.orientation];
  map.jumpTo(cam); const to=map.getFreeCameraOptions(), p1=to.position, q1=[...to.orientation];
  map.setFreeCameraOptions(from);
  const d=Math.hypot(p1.x-p0.x,p1.y-p0.y), km=d*40075;
  const dur = km<40 ? Math.min(2400, 1400 + km*25) : Math.min(4500, 2400 + Math.log10(1+km)*650);
  const lift = km<40 ? d*0.12 : d*0.45;
  const t0=performance.now(); camAnim={raf:0};
  const step=now=>{
    const t=Math.min(1,(now-t0)/dur), e=easeIO(t);
    const pos=new mapboxgl.MercatorCoordinate(p0.x+(p1.x-p0.x)*e, p0.y+(p1.y-p0.y)*e, p0.z+(p1.z-p0.z)*e + lift*Math.sin(Math.PI*e));
    const fc=new mapboxgl.FreeCameraOptions(pos, slerp(q0,q1,e)); map.setFreeCameraOptions(fc);
    if(t<1 && camAnim){ camAnim.raf=requestAnimationFrame(step); return; }
    if(!camAnim) return; camAnim=null;
    // settle: if the destination's terrain finished loading mid-glide, line the view up gently
    map.easeTo({...cam,duration:900,easing:t=>1-Math.pow(1-t,3),essential:true});
  };
  camAnim.raf=requestAnimationFrame(step);
}
function flyTo(e){
  if(!map) return;
  const r=e.route;
  const cam = r.length>1
    ? {...(map.cameraForBounds(boundsOf(r),{padding:90,bearing:-20,pitch:58,maxZoom:13.5}) || {center:[e.lng,e.lat],zoom:12}),bearing:-20,pitch:58}
    : {center:[e.lng,e.lat],zoom:14.2,pitch:62,bearing:-25};
  map.stop();
  if(reduce){ stopCam(); map.jumpTo(cam); return; }
  // From far out (the globe view) the built-in flight still looks best
  if(map.getZoom()<6){ stopCam(); map.flyTo({...cam,duration:4200,curve:1.4,easing:easeIO,essential:true}); return; }
  glideTo(cam);
}
function fitAll(animate=true){ fitTo(shown().length?shown():entries,animate); }
function fitTo(list,animate=true){
  if(!map || !list.length) return;
  const pts=list.flatMap(e=>[[e.lat,e.lng],...e.route]);
  if(pts.length===1) map.flyTo({center:ll(pts[0]),zoom:6,pitch:0,bearing:0,duration:animate&&!reduce?2500:0});
  else map.fitBounds(boundsOf(pts),{padding:80,pitch:0,bearing:0,maxZoom:8,duration:animate&&!reduce?2500:0});
}
function setupMapButtons(){
  $("#mapctl").addEventListener("click",ev=>{ const b=ev.target.closest("button"); if(!b||!map) return;
    if(b.dataset.z==="all") fitAll();
    if(b.dataset.z==="globe") map.flyTo({center:map.getCenter(),zoom:1.6,pitch:0,bearing:0,duration:reduce?0:2500,essential:true});
    if(b.dataset.z==="style"){ styleKey = styleKey==="satellite"?"terrain":"satellite"; b.textContent = styleKey==="satellite"?"Terrain":"Satellite"; map.setStyle(STYLES[styleKey]); map.once("style.load",()=>{ drawRoutes(); }); }
  });
}

/* ---------- search and filters: one rule decides what's shown everywhere ---------- */
const filt={q:"",kinds:new Set(),years:new Set()};
const yearOf=e=>String(e.start_date||"").slice(0,4)||"Undated";
const hay=e=>[e.title,e.place,KINDS[e.kind],e.notes,...e.gear,...e.peaks.map(p=>p.name),(tripById(e.trip_id)||{}).title,yearOf(e)].join(" ").toLowerCase();
function matchesFilters(e){
  if(filt.kinds.size && !filt.kinds.has(e.kind)) return false;
  if(filt.years.size && !filt.years.has(yearOf(e))) return false;
  if(filt.q){ const h=hay(e); if(!filt.q.split(/\s+/).every(w=>h.includes(w))) return false; }
  return true;
}
const isShown = matchesFilters;
const shown = () => entries.filter(isShown);
const filtering = () => !!(filt.q||filt.kinds.size||filt.years.size);

function renderFilters(){
  const box=$("#chips"); if(!box) return;
  const kinds=[...new Set(entries.map(e=>e.kind))].sort((a,b)=>KINDS[a].localeCompare(KINDS[b]));
  const years=[...new Set(entries.map(yearOf))].sort().reverse();
  const chip=(t,k,v,on)=>`<button type="button" class="chip${on?" on":""}" data-t="${t}" data-v="${esc(v)}" aria-pressed="${on}">${esc(k)}</button>`;
  box.innerHTML = years.map(y=>chip("y",y,y,filt.years.has(y))).join("") + `<span class="chipsep"></span>` + kinds.map(k=>chip("k",KINDS[k],k,filt.kinds.has(k))).join("")
    + (filtering()?`<button type="button" class="chip clear" data-t="clear">Clear</button>`:"");
  $("#filterBtn").textContent = filtering() ? `Filter · ${filt.kinds.size+filt.years.size+(filt.q?1:0)}` : "Filter";
}
function setupFilters(){
  let t=0;
  $("#q").addEventListener("input",ev=>{ clearTimeout(t); t=setTimeout(()=>{ filt.q=ev.target.value.trim().toLowerCase(); afterFilter(); },120); });
  $("#filterBtn").onclick=()=>{ const c=$("#chips"); c.hidden=!c.hidden; $("#filterBtn").setAttribute("aria-expanded",String(!c.hidden)); };
  $("#chips").addEventListener("click",ev=>{ const b=ev.target.closest(".chip"); if(!b) return;
    if(b.dataset.t==="clear"){ filt.kinds.clear(); filt.years.clear(); filt.q=""; $("#q").value=""; }
    else { const set=b.dataset.t==="k"?filt.kinds:filt.years; set.has(b.dataset.v)?set.delete(b.dataset.v):set.add(b.dataset.v); }
    afterFilter(); });
}
function afterFilter(){
  renderFilters(); applyVisibility(); renderTally(); renderList(); if(!selected) renderSheet();
  const vis=shown(); if(map && vis.length && filtering()) fitTo(vis);
}

/* ---------- ledger + sheet ---------- */
const sorted = () => [...entries].sort((a,b)=>String(a.start_date).localeCompare(String(b.start_date)));
const vert = e => +(e.stats&&e.stats.vertical_m)||0;
const ft = m => m*3.28084;
const entryMeters = e => (+(e.stats&&e.stats.meters)||0) || routeMeters(e.route);
function renderTally(){
  const v=shown();
  $("#nEntries").textContent=v.length;
  $("#nDays").textContent=v.reduce((s,e)=>s+days(e.start_date,e.end_date),0);
  $("#nMiles").textContent=Math.round(mi(v.reduce((s,e)=>s+entryMeters(e),0))).toLocaleString();
}
// tiny line drawing of the route, north up, scaled to fit; cached per route
const shapeCache=new Map();
function shapeSVG(e){
  const r=e.route, key=e.id+":"+r.length;
  if(shapeCache.has(key)) return shapeCache.get(key);
  let out;
  if(r.length<2) out=`<svg class="shape" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="2"/></svg>`;
  else{
    const k=Math.cos(r[0][0]*rad); let pts=r.map(p=>[p[1]*k,-p[0]]);
    const xs=pts.map(p=>p[0]), ys=pts.map(p=>p[1]), x0=Math.min(...xs), y0=Math.min(...ys);
    const span=Math.max(Math.max(...xs)-x0, Math.max(...ys)-y0)||1e-9, pad=3, sc=(32-2*pad)/span;
    const ox=pad+((32-2*pad)-(Math.max(...xs)-x0)*sc)/2, oy=pad+((32-2*pad)-(Math.max(...ys)-y0)*sc)/2;
    pts=pts.map(p=>[+(ox+(p[0]-x0)*sc).toFixed(1),+(oy+(p[1]-y0)*sc).toFixed(1)]);
    const keep=[pts[0]]; for(const p of pts){ const q=keep.at(-1); if(Math.abs(p[0]-q[0])+Math.abs(p[1]-q[1])>=0.8) keep.push(p); }
    keep.push(pts.at(-1));
    out=`<svg class="shape" viewBox="0 0 32 32" aria-hidden="true"><polyline points="${keep.map(p=>p.join(",")).join(" ")}"/></svg>`;
  }
  shapeCache.set(key,out); return out;
}
function renderList(){
  const list=$("#list");
  if(!entries.length){ list.innerHTML=`<p class="emptylist">${canEdit?"Nothing logged yet. Choose Add Entry to drop your first pin.":"Nothing logged yet."}</p>`; return; }
  const vis=sorted().filter(isShown);
  if(!vis.length){ list.innerHTML=`<p class="emptylist">Nothing matches.</p>`; return; }
  let html="", yr=null, cur=null;
  for(const e of vis){
    const d=parseD(e.start_date), y=d?d.y:"Undated";
    if(y!==yr){ html+=`<div class="year label">${y}</div>`; yr=y; cur=null; }
    const t=tripById(e.trip_id);
    if(t && t.id!==cur){ const tm=tripEntries(t.id), r=tripRange(t.id);
      html+=`<button class="triphead" type="button" data-trip="${esc(t.id)}" aria-current="${t.id===selTrip}"><span class="label">Trip</span><span class="t">${esc(t.title)}</span><span class="m mono">${esc(fmtRange(r[0],r[1]))} · ${tm.length}</span></button>`; }
    cur = t ? t.id : null;
    html+=`<button class="entry${t?" intrip":""}" type="button" data-id="${esc(e.id)}" aria-current="${e.id===selected}"><span class="d">${d?`${String(d.m).padStart(2,"0")}.${String(d.d).padStart(2,"0")}`:"—"}</span><span><span class="t">${esc(e.title)}</span><span class="m">${esc(e.place||KINDS[e.kind])}</span></span>${shapeSVG(e)}</button>`;
  }
  list.innerHTML=html;
}
function renderAll(){
  renderFilters(); renderTally(); renderList(); drawMarkers(); drawRoutes(); renderSheet();
  const e=entries.find(x=>x.id===selected);
  $("#readBtn").hidden=!(e||selTrip); $("#readBtn").textContent = e ? "Read entry ↓" : "Read trip ↓"; $("#playBtn").hidden=!(e && e.route.length>1);
}
function select(id,{fly=false}={}){
  if(replay) replay.stop(false); // picking another entry ends the replay and flies there instead
  selected=id; selTrip=null; const e=entries.find(x=>x.id===id);
  setUrl(e?{e:e.id}:null,e&&e.title); renderAll(); if(e&&fly) flyTo(e);
  const btn=document.querySelector(`.entry[data-id="${CSS.escape(id)}"]`); if(btn) btn.scrollIntoView({block:"nearest"});
}
/* ---------- trips: entries grouped into chapters ---------- */
const tripById = id => id ? trips.find(t=>t.id===id) : null;
const tripEntries = id => sorted().filter(e=>e.trip_id===id);
function tripRange(id){ const l=tripEntries(id); if(!l.length) return [null,null]; const end=l.map(e=>e.end_date||e.start_date).sort().at(-1); return [l[0].start_date,end]; }
function selectTrip(id,{fly=true}={}){
  if(replay) replay.stop(false);
  const t=tripById(id); if(!t) return;
  selected=null; selTrip=id; setUrl({t:id},t.title); renderAll();
  if(fly) fitTo(tripEntries(id));
  const b=document.querySelector(`.triphead[data-trip="${CSS.escape(id)}"]`); if(b) b.scrollIntoView({block:"nearest"});
}
$("#list").addEventListener("click",ev=>{ const b=ev.target.closest(".triphead"); if(b) selectTrip(b.dataset.trip); });

/* ---------- share links: ?e=<entry> or ?t=<trip> opens straight to it ---------- */
const linkFor = (key,id) => `${location.origin}${location.pathname}?${key}=${encodeURIComponent(id)}`;
function setUrl(p,title){ try{ const u=new URL(location.href); u.searchParams.delete("e"); u.searchParams.delete("t"); if(p) for(const [k,v] of Object.entries(p)) u.searchParams.set(k,v); history.replaceState(null,"",u); document.title = title ? `${title} · Log` : "Log"; }catch{} }
async function share(key,id,title,sub,btn){
  const url=linkFor(key,id);
  if(navigator.share && matchMedia("(pointer:coarse)").matches){ try{ await navigator.share({title,text:`${title} · ${sub}`,url}); return; }catch(err){ if(err && err.name==="AbortError") return; } }
  try{ await navigator.clipboard.writeText(url); btn.textContent="Link copied"; }catch{ prompt("Copy this link",url); }
  setTimeout(()=>{ if(btn.isConnected) btn.textContent="Copy link"; },2200);
}
$("#list").addEventListener("click",ev=>{ const b=ev.target.closest(".entry"); if(b) select(b.dataset.id,{fly:true}); });
$("#readBtn").onclick=()=>$("#sheet").scrollIntoView({behavior:reduce?"auto":"smooth"});
$("#playBtn").onclick=()=>{ const e=entries.find(x=>x.id===selected); if(e) startReplay(e); };

function renderSheet(){
  const box=$("#sheetIn"), e=entries.find(x=>x.id===selected);
  if(!e && selTrip && tripById(selTrip)){ renderTripSheet(tripById(selTrip)); return; }
  if(!e){ box.innerHTML=totalsHTML(); return; }
  const trip=tripById(e.trip_id);
  const nd=days(e.start_date,e.end_date), meters=entryMeters(e), st=e.stats||{};
  const gearth=`https://earth.google.com/web/@${e.lat},${e.lng},1500a,3000d,35y,0h,60t,0r`;
  box.innerHTML=`
    <div class="kicker label"><span>${esc(KINDS[e.kind])}</span><span>${esc(fmtRange(e.start_date,e.end_date))}</span>${trip?`<button type="button" class="kickerlink" data-opentrip="${esc(trip.id)}">Trip: ${esc(trip.title)} →</button>`:""}</div>
    <h2 class="ttl">${esc(e.title)}</h2>
    <p class="place">${esc(e.place)}</p>
    <dl class="specs">
      <div><dt class="label">Date</dt><dd>${esc(e.start_date)}${e.end_date&&e.end_date!==e.start_date?` → ${esc(e.end_date)}`:""}</dd></div>
      <div><dt class="label">Duration</dt><dd>${nd} day${nd>1?"s":""}</dd></div>
      ${e.route.length>1?`<div><dt class="label">Route</dt><dd>${mi(meters).toFixed(1)} mi · <button type="button" id="playLink">Replay</button></dd></div>`:""}
      ${vert(e)?`<div><dt class="label">Vertical</dt><dd>${Math.round(ft(vert(e))).toLocaleString()} ft</dd></div>`:""}
      ${+st.moving_s?`<div><dt class="label">Moving time</dt><dd>${hm(+st.moving_s)}</dd></div>`:""}
      <div><dt class="label">Coordinates</dt><dd><span id="dec">${e.lat.toFixed(5)}, ${e.lng.toFixed(5)}</span> · <button type="button" id="copyBtn">Copy</button></dd></div>
      <div><dt class="label">Elsewhere</dt><dd><a href="${gearth}" target="_blank" rel="noopener">Google Earth</a>${st.strava_id&&!st.missing?` · <a href="https://www.strava.com/activities/${+st.strava_id}" target="_blank" rel="noopener">Strava</a>`:""}</dd></div>
      <div><dt class="label">Share</dt><dd><button type="button" id="shareBtn">Copy link</button></dd></div>
    </dl>
    ${e.peaks.length?`<div class="block"><div class="bhead label"><span>Summits</span><span class="mono">${e.peaks.length}</span></div><ul class="peaklist">${e.peaks.map(p=>`<li><span>${esc(p.name)}</span><span class="mono">${elevTxt(p)}</span></li>`).join("")}</ul></div>`:""}
    <div class="block"><div class="bhead label"><span>Photos</span><span class="mono">${e.photos.length}</span></div>
      ${e.photos.length||canEdit?`<div class="gallery" id="gallery">${e.photos.map((p,i)=>`<figure class="ph${p.type==="video"?" vid":""}">${p.type==="video"?`<video controls playsinline preload="metadata" src="${esc(photoUrl(p))}"${p.poster?` poster="${esc(photoUrl({path:p.poster}))}"`:""} aria-label="${esc(p.name||`Video ${i+1} from ${e.title}`)}"></video>`:`<img src="${esc(photoUrl(p))}" alt="${esc(p.name||`Photo ${i+1} from ${e.title}`)}" loading="lazy">`}${canEdit?`<button class="x" type="button" data-del="${i}">Remove</button>`:""}</figure>`).join("")}${canEdit?`<button class="drop" id="drop" type="button"><strong>Add photos</strong><span>Click or drop images</span></button>`:""}</div>`:`<p class="notes empty">No photos.</p>`}
      <input type="file" id="fileIn" accept="image/*" multiple hidden><p class="status" id="upStatus"></p></div>
    ${e.gear.length||canEdit?`<div class="block"><div class="bhead label"><span>Gear</span><span class="mono">${e.gear.length}</span></div>${e.gear.length?`<ul class="gear">${e.gear.map(g=>`<li><button type="button" class="gearq" data-g="${esc(g)}" title="Show every entry with this">${esc(g)}</button></li>`).join("")}</ul>`:`<p class="notes empty">No gear listed. Choose Edit to add some.</p>`}</div>`:""}
    <div class="block"><div class="bhead label"><span>Notes</span></div><p class="notes${e.notes?"":" empty"}">${e.notes?esc(e.notes):(canEdit?"No notes yet. Choose Edit to add some.":"No notes.")}</p></div>
    ${canEdit?`<div class="acts"><button class="btn solid label" id="editBtn" type="button">Edit</button><span class="sp"></span><span id="delWrap"><button class="del label" id="delBtn" type="button">Delete entry</button></span></div>`:""}`;
  const q=s=>box.querySelector(s);
  q("#copyBtn").onclick=async()=>{ try{ await navigator.clipboard.writeText(q("#dec").textContent); q("#copyBtn").textContent="Copied"; }catch{ q("#copyBtn").textContent="Select and copy"; } };
  if(q("#playLink")) q("#playLink").onclick=()=>startReplay(e);
  q("#shareBtn").onclick=ev=>share("e",e.id,e.title,fmtRange(e.start_date,e.end_date),ev.target);
  box.querySelectorAll(".gearq").forEach(b=>b.onclick=()=>{ $("#q").value=b.dataset.g; filt.q=b.dataset.g.toLowerCase(); select(null); afterFilter(); $(".ledger").scrollIntoView({block:"nearest"}); });
  // size each tile to its picture's shape so rows line up with nothing cropped
  box.querySelectorAll(".ph img,.ph video").forEach(m=>{ const set=()=>{ const w=m.naturalWidth||m.videoWidth, h=m.naturalHeight||m.videoHeight; if(w&&h) m.closest(".ph").style.setProperty("--ar",(w/h).toFixed(3)); };
    if(m.tagName==="VIDEO"){ if(m.readyState>=1) set(); else m.addEventListener("loadedmetadata",set,{once:true}); } else { if(m.complete) set(); else m.addEventListener("load",set,{once:true}); } });
  if(q("#gallery")) q("#gallery").addEventListener("click",ev=>{ const d=ev.target.closest("[data-del]"); if(d){ removePhoto(e,+d.dataset.del,d); return; } const img=ev.target.closest("img"); if(img){ const figs=[...q("#gallery").querySelectorAll("figure")]; const items=e.photos.map((p,i)=>({src:photoUrl(p),alt:p.name||`${p.type==="video"?"Video":"Photo"} ${i+1} from ${e.title}`,video:p.type==="video",poster:p.poster?photoUrl({path:p.poster}):""})); lightbox(items,Math.max(0,figs.indexOf(img.closest("figure")))); } });
  const drop=q("#drop");
  if(drop){ drop.onclick=()=>q("#fileIn").click(); q("#fileIn").onchange=ev=>uploadPhotos(e,[...ev.target.files]);
    drop.addEventListener("dragover",ev=>{ev.preventDefault();drop.classList.add("over");}); drop.addEventListener("dragleave",()=>drop.classList.remove("over"));
    drop.addEventListener("drop",ev=>{ev.preventDefault();drop.classList.remove("over");uploadPhotos(e,[...ev.dataTransfer.files].filter(f=>f.type.startsWith("image/")));}); }
  if(q("#editBtn")) q("#editBtn").onclick=()=>openForm(e);
  const dw=q("#delWrap"); if(dw) dw.addEventListener("click",async ev=>{ const a=ev.target.closest("button"); if(!a) return;
    if(a.id==="delBtn"){ dw.innerHTML=`<span>Delete for good?</span> <button class="del" type="button" id="delYes">Delete</button> <button class="link" type="button" id="delNo">Keep</button>`; return; }
    if(a.id==="delNo"){ dw.innerHTML=`<button class="del label" id="delBtn" type="button">Delete entry</button>`; return; }
    if(a.id==="delYes"){ const {error}=await sb.from("entries").delete().eq("id",e.id); if(error){ toast("Couldn't delete: "+error.message); return; }
      if(e.photos.length) await sb.storage.from("photos").remove(e.photos.map(p=>p.path)); selected=null; setUrl(null); toast("Deleted"); refresh(true); } });
}
function renderTripSheet(t){
  const box=$("#sheetIn"), l=tripEntries(t.id), [a,b]=tripRange(t.id);
  const miles=mi(l.reduce((s,e)=>s+entryMeters(e),0)), v=l.reduce((s,e)=>s+vert(e),0);
  const places=[...new Set(l.map(e=>placeTail(e)).filter(Boolean))];
  const peaks=l.flatMap(e=>e.peaks);
  box.innerHTML=`
    <div class="kicker label"><span>Trip</span><span>${esc(fmtRange(a,b))}</span></div>
    <h2 class="ttl">${esc(t.title)}</h2>
    <p class="place">${esc(places.join(" · "))}</p>
    <dl class="specs">
      <div><dt class="label">Days</dt><dd>${a?days(a,b):0}</dd></div>
      <div><dt class="label">Entries</dt><dd>${l.length}</dd></div>
      <div><dt class="label">Miles</dt><dd>${miles.toFixed(1)}</dd></div>
      ${v?`<div><dt class="label">Vertical</dt><dd>${Math.round(ft(v)).toLocaleString()} ft</dd></div>`:""}
      ${peaks.length?`<div><dt class="label">Summits</dt><dd>${peaks.length}</dd></div>`:""}
      <div><dt class="label">Share</dt><dd><button type="button" id="shareBtn">Copy link</button></dd></div>
    </dl>
    ${t.notes||canEdit?`<div class="block"><div class="bhead label"><span>Notes</span></div><p class="notes${t.notes?"":" empty"}">${t.notes?esc(t.notes):"No notes yet. Choose Edit trip to add some."}</p></div>`:""}
    <div class="block"><div class="bhead label"><span>Day by day</span><span class="mono">${l.length}</span></div>
      <ol class="daylist">${l.map(e=>`<li><button type="button" data-open="${esc(e.id)}"><span class="mono d">${esc(fmtRange(e.start_date,e.end_date))}</span><span class="t">${esc(e.title)}</span><span class="m">${esc(KINDS[e.kind])}${entryMeters(e)?` · ${mi(entryMeters(e)).toFixed(1)} mi`:""}</span></button></li>`).join("")}</ol></div>
    ${peaks.length?`<div class="block"><div class="bhead label"><span>Summits</span><span class="mono">${peaks.length}</span></div><ul class="peaklist">${peaks.map(p=>`<li><span>${esc(p.name)}</span><span class="mono">${elevTxt(p)}</span></li>`).join("")}</ul></div>`:""}
    ${canEdit?`<div class="acts"><button class="btn solid label" id="editTrip" type="button">Edit trip</button><span class="sp"></span><span id="delWrap"><button class="del label" id="delBtn" type="button">Delete trip</button></span></div>`:""}`;
  const q=s=>box.querySelector(s);
  q("#shareBtn").onclick=ev=>share("t",t.id,t.title,fmtRange(a,b),ev.target);
  if(q("#editTrip")) q("#editTrip").onclick=()=>openTripForm(t);
  const dw=q("#delWrap"); if(dw) dw.addEventListener("click",async ev=>{ const x=ev.target.closest("button"); if(!x) return;
    if(x.id==="delBtn"){ dw.innerHTML=`<span>Delete the trip? Its entries stay.</span> <button class="del" type="button" id="delYes">Delete</button> <button class="link" type="button" id="delNo">Keep</button>`; return; }
    if(x.id==="delNo"){ dw.innerHTML=`<button class="del label" id="delBtn" type="button">Delete trip</button>`; return; }
    if(x.id==="delYes"){ const {error}=await sb.from("trips").delete().eq("id",t.id); if(error){ toast("Couldn't delete: "+error.message); return; } selTrip=null; setUrl(null); toast("Trip deleted"); refresh(true); } });
}
function openTripForm(t){
  const root=document.createElement("div");
  root.innerHTML=`<div class="scrim"></div><form class="side" novalidate role="dialog" aria-modal="true" aria-label="Edit trip">
    <div class="shead"><span class="label">Edit trip</span><button class="xclose" type="button" aria-label="Close">×</button></div>
    <div class="fields">
      <div class="f w"><label class="label" for="tTitle">Title</label><input id="tTitle" value="${esc(t.title)}"></div>
      <div class="f w"><label class="label" for="tNotes">Notes</label><textarea id="tNotes">${esc(t.notes)}</textarea></div>
      <p class="f w hint">To add or remove days, edit an entry and change its Trip.</p>
    </div>
    <p class="formerr" id="tErr"></p>
    <div class="acts"><button class="link" type="button" id="tCancel">Cancel</button><span class="sp"></span><button class="btn solid label" type="submit" id="tSave">Save</button></div></form>`;
  document.body.appendChild(root);
  const q=s=>root.querySelector(s), close=()=>{ root.remove(); document.removeEventListener("keydown",k); }, k=ev=>{ if(ev.key==="Escape") close(); };
  document.addEventListener("keydown",k); q("#tCancel").onclick=close; q(".xclose").onclick=close; q(".scrim").onclick=close;
  setTimeout(()=>q("#tTitle").focus(),40);
  q("form").onsubmit=async ev=>{ ev.preventDefault(); const title=q("#tTitle").value.trim(); if(!title){ q("#tErr").textContent="Add a title."; return; }
    q("#tSave").disabled=true; const {error}=await sb.from("trips").update({title,notes:q("#tNotes").value}).eq("id",t.id);
    if(error){ q("#tErr").textContent="Couldn't save: "+error.message; q("#tSave").disabled=false; return; }
    close(); toast("Saved"); await refresh(true); selectTrip(t.id,{fly:false}); };
}

/* ---------- peaks ---------- */
const elevTxt = p => p.elev_m ? `${Math.round(ft(p.elev_m)).toLocaleString()} ft` : "";
const peakKey = p => (p.lat!=null ? `${p.lat.toFixed(3)},${p.lng.toFixed(3)}` : p.name.toLowerCase());
function peakTally(list){ // unique summits with every visit
  const m=new Map();
  for(const e of list) for(const p of e.peaks){ const k=peakKey(p); if(!m.has(k)) m.set(k,{...p,visits:[]}); m.get(k).visits.push(e); }
  return [...m.values()].sort((a,b)=>(b.elev_m||0)-(a.elev_m||0)||a.name.localeCompare(b.name));
}
// lines like "Lone Peak, 11,076 ft" or "Mt. Rokko 931 m" -> {name, elev_m}
function parsePeakLine(line){
  const m=line.match(/^(.*?)(\s*[,·–—-]\s*|\s+)(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(ft|feet|'|m|meters|metres)?\s*$/i);
  // a bare number after a space with no unit is part of the name ("Peak 6233")
  if(!m || !m[1].trim() || (!m[2].trim() && !m[4])) return {name:line.trim(),elev_m:null};
  const n=+m[3].replace(/,/g,""), unit=(m[4]||"ft").toLowerCase();
  return {name:m[1].trim(),elev_m:Math.round(unit.startsWith("m")?n:n/3.28084)};
}
const peakLine = p => p.elev_m ? `${p.name}, ${Math.round(ft(p.elev_m)).toLocaleString()} ft` : p.name;
// summits the route passes within 120 m of, from Mapbox's map data
async function findPeaks(route){
  if(route.length<2 || !CFG.mapboxToken) return [];
  const samples=[route[0]]; let acc=0;
  for(let i=1;i<route.length;i++){ acc+=hav(route[i-1],route[i]); if(acc>=1200){ samples.push(route[i]); acc=0; } }
  samples.push(route.at(-1));
  const cand=new Map();
  for(let i=0;i<samples.length;i+=8){
    const res=await Promise.all(samples.slice(i,i+8).map(([lat,lng])=>fetch(`https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery/${lng},${lat}.json?radius=900&limit=50&layers=natural_label&access_token=${CFG.mapboxToken}`).then(r=>r.ok?r.json():{features:[]}).catch(()=>({features:[]}))));
    for(const r of res) for(const f of r.features||[]){ const p=f.properties||{}; if(!["mountain","volcano"].includes(p.maki)) continue; const name=p.name_en||p.name; if(!name) continue;
      const [lng,lat]=f.geometry.coordinates; cand.set(`${lat.toFixed(4)},${lng.toFixed(4)}`,{name,elev_m:p.elevation_m??null,lat:+lat.toFixed(5),lng:+lng.toFixed(5)}); }
  }
  return [...cand.values()].filter(c=>Math.min(...route.map(p=>hav(p,[c.lat,c.lng])))<=120);
}

/* ---------- totals: what the sheet shows when no entry is picked ---------- */
const US_STATES=new Set("Alabama Alaska Arizona Arkansas California Colorado Connecticut Delaware Florida Georgia Hawaii Idaho Illinois Indiana Iowa Kansas Kentucky Louisiana Maine Maryland Massachusetts Michigan Minnesota Mississippi Missouri Montana Nebraska Nevada New_Hampshire New_Jersey New_Mexico New_York North_Carolina North_Dakota Ohio Oklahoma Oregon Pennsylvania Rhode_Island South_Carolina South_Dakota Tennessee Texas Utah Vermont Virginia Washington West_Virginia Wisconsin Wyoming".split(" ").map(x=>x.replace(/_/g," ")));
const CHINA_REGIONS=new Set("Anhui Beijing Chongqing Fujian Gansu Guangdong Guangxi Guizhou Hainan Hebei Heilongjiang Henan Hubei Hunan Inner_Mongolia Jiangsu Jiangxi Jilin Liaoning Ningxia Qinghai Shaanxi Shandong Shanghai Shanxi Sichuan Tianjin Tibet Xinjiang Yunnan Zhejiang".split(" ").map(x=>x.replace(/_/g," ")));
const placeTail = e => { const t=(e.place.split(",").pop()||"").trim(); return CHINA_REGIONS.has(t)?"China":/^Hong Kong/.test(t)?"Hong Kong":t; };
const countryOf = e => { const t=placeTail(e); return US_STATES.has(t)?"United States":t; };
const hm = s => { const h=Math.floor(s/3600), m=Math.round((s%3600)/60); return h?`${h}h ${String(m).padStart(2,"0")}m`:`${m}m`; };
function totalsHTML(){
  const v=shown(), all=entries.length;
  const sum=(list,f)=>list.reduce((s,e)=>s+f(e),0);
  const miles=l=>mi(sum(l,entryMeters)), vft=l=>ft(sum(l,vert));
  const withV=v.filter(e=>vert(e)).length, mov=sum(v,e=>+(e.stats&&e.stats.moving_s)||0);
  const scope = filtering() ? `${v.length} of ${all} entries` : "Everything logged";
  const note = source==="backup" ? `<p class="tothint">Showing the backup copy: the live database didn't answer.</p>` : "";
  if(!v.length) return `<div class="intro"><span class="label">Totals</span><h2 class="ttl">Nothing matches</h2><p>Change the search or filters to see totals.</p></div>`;
  const group=(keyf,label)=>{ const m=new Map(); v.forEach(e=>{ const k=keyf(e); (m.get(k)||m.set(k,[]).get(k)).push(e); }); return [...m.entries()].map(([k,l])=>({k,label:label(k),l})); };
  const row=(name,l,extra="")=>`<tr><th scope="row">${name}</th><td>${l.length}</td><td>${Math.round(miles(l)).toLocaleString()}</td>${withV?`<td>${Math.round(vft(l)).toLocaleString()}</td>`:""}${extra}</tr>`;
  const head=first=>`<thead><tr><th scope="col" class="label">${first}</th><th scope="col" class="label">Entries</th><th scope="col" class="label">Miles</th>${withV?`<th scope="col" class="label">Vert ft</th>`:""}</tr></thead>`;
  const byKind=group(e=>e.kind,k=>esc(KINDS[k])).sort((a,b)=>miles(b.l)-miles(a.l)||b.l.length-a.l.length);
  const byYear=group(yearOf,y=>esc(y)).sort((a,b)=>b.k.localeCompare(a.k));
  const gearMap=new Map(); v.forEach(e=>e.gear.forEach(g=>{ (gearMap.get(g)||gearMap.set(g,[]).get(g)).push(e); }));
  const byGear=[...gearMap.entries()].sort((a,b)=>miles(b[1])-miles(a[1])).slice(0,12);
  const longestOf=kinds=>[...v].filter(e=>kinds.includes(e.kind)&&entryMeters(e)).sort((a,b)=>entryMeters(b)-entryMeters(a))[0];
  const longRide=longestOf(["bike","mtb"]), longRun=longestOf(["trailrun"]);
  const spec=(label,e)=>e?`<div><dt class="label">${label}</dt><dd><button type="button" data-open="${esc(e.id)}">${esc(e.title)}</button> · ${mi(entryMeters(e)).toFixed(1)} mi</dd></div>`:"";
  const biggest=withV?[...v].sort((a,b)=>vert(b)-vert(a))[0]:null;
  const states=new Set(v.map(placeTail).filter(t=>US_STATES.has(t)));
  const countries=new Set(v.map(countryOf).filter(Boolean));
  const peaks=peakTally(v);
  const tripRows=trips.map(t=>({t,l:v.filter(e=>e.trip_id===t.id)})).filter(x=>x.l.length).sort((a,b)=>String(b.l[0].start_date).localeCompare(String(a.l[0].start_date)));
  return `<div class="kicker label"><span>Totals</span><span>${esc(scope)}</span></div>
    <h2 class="ttl">${Math.round(miles(v)).toLocaleString()} miles${withV?`, ${Math.round(vft(v)).toLocaleString()} ft up`:""}</h2>
    <p class="place">Pick an entry from the list or a pin to read it.</p>${note}
    ${onThisDayHTML()}
    <dl class="specs">
      <div><dt class="label">Entries</dt><dd>${v.length}</dd></div>
      <div><dt class="label">Days out</dt><dd>${sum(v,e=>days(e.start_date,e.end_date))}</dd></div>
      <div><dt class="label">Miles</dt><dd>${miles(v).toFixed(1)}</dd></div>
      ${withV?`<div><dt class="label">Vertical</dt><dd>${Math.round(vft(v)).toLocaleString()} ft</dd></div>`:""}
      ${mov?`<div><dt class="label">Moving time</dt><dd>${hm(mov)}</dd></div>`:""}
      <div><dt class="label">States</dt><dd>${states.size}</dd></div>
      <div><dt class="label">Countries</dt><dd>${countries.size}</dd></div>
      ${peaks.length?`<div><dt class="label">Summits</dt><dd>${peaks.length}</dd></div>`:""}
      ${spec("Longest ride",longRide)}
      ${spec("Longest trail run",longRun)}
      ${biggest?`<div><dt class="label">Most vertical</dt><dd><button type="button" data-open="${esc(biggest.id)}">${esc(biggest.title)}</button> · ${Math.round(ft(vert(biggest))).toLocaleString()} ft</dd></div>`:""}
    </dl>
    ${withV&&withV<v.length?`<p class="tothint">Vertical and moving time come from Strava and cover ${withV} of these ${v.length} entries.</p>`:""}
    ${tripRows.length?`<div class="block"><div class="bhead label"><span>Trips</span><span class="mono">${tripRows.length}</span></div><div class="tablewrap"><table class="tot"><thead><tr><th scope="col" class="label">Trip</th><th scope="col" class="label">Dates</th><th scope="col" class="label">Days</th><th scope="col" class="label">Miles</th></tr></thead><tbody>${tripRows.map(({t,l})=>{ const [a,b]=tripRange(t.id); return `<tr><th scope="row"><button type="button" data-opentrip="${esc(t.id)}">${esc(t.title)}</button></th><td>${esc(fmtRange(a,b))}</td><td>${days(a,b)}</td><td>${Math.round(miles(l)).toLocaleString()}</td></tr>`; }).join("")}</tbody></table></div></div>`:""}
    ${peaks.length?`<div class="block"><div class="bhead label"><span>Summits</span><span class="mono">${peaks.length} peaks</span></div><div class="tablewrap"><table class="tot"><thead><tr><th scope="col" class="label">Peak</th><th scope="col" class="label">Elevation</th><th scope="col" class="label">Times</th><th scope="col" class="label">Last</th></tr></thead><tbody>${peaks.map(p=>{ const last=p.visits.at(-1); return `<tr><th scope="row">${esc(p.name)}</th><td>${elevTxt(p)||"—"}</td><td>${p.visits.length}</td><td><button type="button" data-open="${esc(last.id)}">${esc(fmtRange(last.start_date))}</button></td></tr>`; }).join("")}</tbody></table></div></div>`:""}
    ${ticklistsHTML(v)}
    ${calendarHTML(v)}
    ${extremesHTML(v)}
    <div class="block"><div class="bhead label"><span>By activity</span></div><div class="tablewrap"><table class="tot">${head("Activity")}<tbody>${byKind.map(g=>row(g.label,g.l)).join("")}</tbody></table></div></div>
    <div class="block"><div class="bhead label"><span>By year</span></div><div class="tablewrap"><table class="tot">${head("Year")}<tbody>${byYear.map(g=>row(g.label,g.l)).join("")}</tbody></table></div></div>
    ${byGear.length?`<div class="block"><div class="bhead label"><span>Gear</span><span class="mono">miles on each</span></div><div class="tablewrap"><table class="tot">${head("Item")}<tbody>${byGear.map(([g,l])=>row(esc(g),l)).join("")}</tbody></table></div></div>`:""}`;
}
// Peak ticklists (lists live in ticklists.js): which peaks on each list you've summited
function ticklistsHTML(v){
  const lists=window.LOG_TICKLISTS||[]; if(!lists.length) return "";
  const climbs=v.flatMap(e=>e.peaks.map(p=>({p,e})));
  const out=lists.map(L=>{
    const rows=[...L.peaks].sort((a,b)=>b.ft-a.ft).map(pk=>{ const hits=pk.match?climbs.filter(c=>pk.match.test(c.p.name.trim())):[]; return {pk,hits}; });
    const done=rows.filter(r=>r.hits.length), ranked=rows.filter(r=>r.pk.ranked), rDone=ranked.filter(r=>r.hits.length);
    const pct=Math.round(done.length/rows.length*100);
    return `<div class="tick">
      <div class="tickhead"><span class="tt">${esc(L.title)}</span><span class="mono">${done.length} / ${rows.length}</span></div>
      <div class="bar" role="img" aria-label="${done.length} of ${rows.length} done"><i style="width:${pct}%"></i></div>
      <p class="ticksub">${rDone.length} of ${ranked.length} ranked · ${esc(L.note||"")} <a href="${esc(L.source)}" target="_blank" rel="noopener">${esc(L.sourceName||"Source")}</a></p>
      <details><summary class="label">Show the list</summary><ol class="ticklist">${rows.map(({pk,hits})=>{ const last=hits.map(h=>h.e).sort((a,b)=>String(b.start_date).localeCompare(String(a.start_date)))[0];
        return `<li class="${hits.length?"done":""}"><span class="box" aria-hidden="true"></span><span class="n">${esc(pk.name)}${pk.ranked?"":` <span class="ur">unranked</span>`}</span><span class="mono">${pk.ft.toLocaleString()} ft</span><span class="when">${last?`<button type="button" data-open="${esc(last.id)}">${esc(fmtRange(last.start_date))}</button>${hits.length>1?` ×${hits.length}`:""}`:""}</span></li>`; }).join("")}</ol></details>
    </div>`;
  }).join("");
  return `<div class="block"><div class="bhead label"><span>Ticklists</span></div>${out}</div>`;
}

// Calendar: one square per day, filled on days you were out
function calendarHTML(v){
  const dayMap=new Map(); // "YYYY-MM-DD" -> [entries]
  for(const e of v){ const s=Date.parse(e.start_date); if(isNaN(s)) continue; const n=days(e.start_date,e.end_date);
    for(let i=0;i<n;i++){ const k=new Date(s+i*864e5).toISOString().slice(0,10); (dayMap.get(k)||dayMap.set(k,[]).get(k)).push(e); } }
  if(!dayMap.size) return "";
  const years=[...new Set([...dayMap.keys()].map(k=>+k.slice(0,4)))].sort((a,b)=>b-a);
  const C=11, G=2, step=C+G, top=14, left=0;
  // longest run of consecutive days out
  const ks=[...dayMap.keys()].sort(); let best=1, run=1;
  for(let i=1;i<ks.length;i++){ run = Date.parse(ks[i])-Date.parse(ks[i-1])===864e5 ? run+1 : 1; best=Math.max(best,run); }
  const svgs=years.map(y=>{
    const jan1=Date.UTC(y,0,1), dow0=new Date(jan1).getUTCDay(), nd=(Date.UTC(y+1,0,1)-jan1)/864e5;
    const weeks=Math.ceil((nd+dow0)/7), W=weeks*step, H=top+7*step;
    let cells="", labels="", count=0;
    for(let m=0;m<12;m++){ const di=(Date.UTC(y,m,1)-jan1)/864e5, w=Math.floor((di+dow0)/7); labels+=`<text x="${left+w*step}" y="10">${MON[m]}</text>`; }
    for(let i=0;i<nd;i++){
      const k=new Date(jan1+i*864e5).toISOString().slice(0,10), w=Math.floor((i+dow0)/7), dd=(i+dow0)%7, hit=dayMap.get(k);
      const x=left+w*step, yy=top+dd*step;
      if(hit){ count++; const mi_=mi(hit.reduce((s,e)=>s+entryMeters(e)/days(e.start_date,e.end_date),0)), lvl=mi_>=15?3:mi_>=6?2:1;
        cells+=`<rect class="on l${lvl}" x="${x}" y="${yy}" width="${C}" height="${C}" data-open="${esc(hit[0].id)}"><title>${esc(fmtRange(k))}: ${esc(hit.map(e=>e.title).join(", "))}</title></rect>`; }
      else cells+=`<rect x="${x}" y="${yy}" width="${C}" height="${C}"/>`;
    }
    return `<div class="calyear"><div class="calhead"><span class="label">${y}</span><span class="mono">${count} day${count===1?"":"s"} out</span></div><svg class="cal" viewBox="0 0 ${W} ${H}" role="img" aria-label="${count} days out in ${y}">${labels}${cells}</svg></div>`;
  }).join("");
  return `<div class="block"><div class="bhead label"><span>Calendar</span><span class="mono">longest streak ${best} day${best===1?"":"s"}</span></div>${svgs}
    <p class="calkey mono"><span>Less</span><i class="l1"></i><i class="l2"></i><i class="l3"></i><span>More miles</span></p></div>`;
}

// Extremes: highest summit, farthest from home, and the compass points
function extremesHTML(v){
  if(!v.length) return "";
  // home = the start point with the most other starts within 15 km
  const starts=entries.map(e=>[e.lat,e.lng]);
  let home=starts[0], bestN=-1;
  for(const a of starts){ const n=starts.filter(b=>hav(a,b)<15000).length; if(n>bestN){ bestN=n; home=a; } }
  const homeEntry=entries.filter(e=>hav([e.lat,e.lng],home)<15000).map(e=>(e.place.split(",")[0]||"").replace(/^near /,"").trim()).filter(Boolean);
  const homeName=homeEntry.sort((a,b)=>homeEntry.filter(x=>x===b).length-homeEntry.filter(x=>x===a).length)[0]||"home";
  const pts=v.flatMap(e=>(e.route.length?e.route:[[e.lat,e.lng]]).map(p=>({p,e})));
  const pick=f=>pts.reduce((a,b)=>f(b)>f(a)?b:a);
  const far=pick(x=>hav(home,x.p)), n=pick(x=>x.p[0]), s_=pick(x=>-x.p[0]), east=pick(x=>x.p[1]), west=pick(x=>-x.p[1]);
  const top=peakTally(v)[0];
  const lat=x=>`${Math.abs(x).toFixed(2)}° ${x>=0?"N":"S"}`, lng=x=>`${Math.abs(x).toFixed(2)}° ${x>=0?"E":"W"}`;
  const row=(label,e,val)=>`<div><dt class="label">${label}</dt><dd>${val}</dd><dd class="via"><button type="button" data-open="${esc(e.id)}">${esc(e.title)}</button></dd></div>`;
  return `<div class="block"><div class="bhead label"><span>Extremes</span></div><dl class="specs ext">
    ${top&&top.elev_m?row("Highest summit",top.visits.at(-1),`${esc(top.name)} · ${elevTxt(top)}`):""}
    ${row(`Farthest from ${esc(homeName)}`,far.e,`${Math.round(mi(hav(home,far.p))).toLocaleString()} mi`)}
    ${row("Northernmost",n.e,lat(n.p[0]))}
    ${row("Southernmost",s_.e,lat(s_.p[0]))}
    ${row("Easternmost",east.e,lng(east.p[1]))}
    ${row("Westernmost",west.e,lng(west.p[1]))}
  </dl></div>`;
}

// On this day: the same date in earlier years, or failing that, the same week
function onThisDayHTML(){
  const now=new Date(), y=now.getFullYear(), md=d=>d.m*100+d.d;
  const today=md({m:now.getMonth()+1,d:now.getDate()});
  const diff=d=>{ const a=Date.UTC(2001,d.m-1,d.d), b=Date.UTC(2001,now.getMonth(),now.getDate()); let x=Math.round((a-b)/864e5); if(x>182) x-=365; if(x<-182) x+=365; return x; };
  const past=entries.map(e=>({e,d:parseD(e.start_date)})).filter(x=>x.d && x.d.y<y);
  let hits=past.filter(x=>md(x.d)===today), label="On this day";
  if(!hits.length){ hits=past.filter(x=>Math.abs(diff(x.d))<=3); label="This week, other years"; }
  if(!hits.length) return "";
  hits.sort((a,b)=>b.d.y-a.d.y||md(a.d)-md(b.d));
  return `<div class="block otd"><div class="bhead label"><span>${label}</span></div><ul class="otdlist">${hits.map(({e,d})=>{ const ago=y-d.y; return `<li><button type="button" data-open="${esc(e.id)}"><span class="mono d">${ago} yr${ago>1?"s":""} ago · ${d.d} ${MON[d.m-1]} ${d.y}</span><span class="t">${esc(e.title)}</span></button></li>`; }).join("")}</ul></div>`;
}
$("#sheetIn").addEventListener("click",ev=>{ const t=ev.target.closest("[data-opentrip]"); if(t){ selectTrip(t.dataset.opentrip); return; } const b=ev.target.closest("[data-open]"); if(b) select(b.dataset.open,{fly:true}); });
function setStatus(m,err){ const s=$("#upStatus"); if(s){ s.textContent=m; s.classList.toggle("err",!!err); } }
async function shrink(file){
  try{ const bmp=await createImageBitmap(file); const sc=Math.min(1,2400/Math.max(bmp.width,bmp.height));
    const c=document.createElement("canvas"); c.width=Math.round(bmp.width*sc); c.height=Math.round(bmp.height*sc); c.getContext("2d").drawImage(bmp,0,0,c.width,c.height);
    return await new Promise(r=>c.toBlob(b=>r(b||file),"image/jpeg",.86)); }catch{ return file; }
}
async function uploadPhotos(e,files){
  if(!files.length||!sb) return; const added=[];
  for(let i=0;i<files.length;i++){
    setStatus(`Uploading ${i+1} of ${files.length}…`);
    const blob=await shrink(files[i]), path=`${e.id}/${Date.now()}-${i}.jpg`;
    const {error}=await sb.storage.from("photos").upload(path,blob,{contentType:"image/jpeg",upsert:false});
    if(error){ setStatus(`${files[i].name}: ${error.message}`,true); continue; }
    added.push({path,name:files[i].name.replace(/\.[^.]+$/,"")});
  }
  if(!added.length) return;
  const {error}=await sb.from("entries").update({photos:[...e.photos,...added]}).eq("id",e.id);
  if(error){ setStatus("Photos uploaded but couldn't be attached: "+error.message,true); return; }
  toast(`Added ${added.length} photo${added.length>1?"s":""}`); refresh(true);
}
async function removePhoto(e,i,btn){
  if(!btn.classList.contains("armed")){ btn.classList.add("armed"); btn.textContent="Remove?"; setTimeout(()=>{ if(btn.isConnected){ btn.classList.remove("armed"); btn.textContent="Remove"; } },3000); return; }
  const photos=[...e.photos]; const [gone]=photos.splice(i,1);
  const {error}=await sb.from("entries").update({photos}).eq("id",e.id);
  if(error){ setStatus("Couldn't remove that photo: "+error.message,true); return; }
  if(gone) await sb.storage.from("photos").remove([gone.path]); refresh(true);
}
// items: [{src, alt, video, poster}]. Left/right arrows, the on-screen arrows or a swipe move through them; Escape closes.
function lightbox(items,start){
  let i=start||0; const many=items.length>1;
  const lb=document.createElement("div"); lb.className="lightbox"; lb.setAttribute("role","dialog"); lb.setAttribute("aria-modal","true");
  lb.innerHTML=`<div class="lbstage"></div><button type="button" class="lbclose" aria-label="Close">×</button>${many?`<button type="button" class="lbnav lbprev" aria-label="Previous">‹</button><button type="button" class="lbnav lbnext" aria-label="Next">›</button><span class="lbcount mono"></span>`:""}`;
  const stage=lb.querySelector(".lbstage");
  const show=()=>{ const it=items[i];
    stage.innerHTML=it.video?`<video controls autoplay playsinline${it.poster?` poster="${esc(it.poster)}"`:""}></video>`:`<img alt="">`;
    const m=stage.firstChild; m.src=it.src; if(it.video) m.setAttribute("aria-label",it.alt); else m.alt=it.alt;
    if(many){ lb.querySelector(".lbcount").textContent=`${i+1} / ${items.length}`;
      [items[(i+1)%items.length],items[(i-1+items.length)%items.length]].forEach(n=>{ if(!n.video){ const pre=new Image(); pre.src=n.src; } }); } };
  const go=d=>{ if(!many) return; i=(i+d+items.length)%items.length; show(); };
  const close=()=>{ lb.remove(); document.removeEventListener("keydown",k,true); };
  const k=ev=>{ if(ev.key==="Escape"){ ev.preventDefault(); close(); } else if(ev.key==="ArrowRight"){ ev.preventDefault(); ev.stopPropagation(); go(1); } else if(ev.key==="ArrowLeft"){ ev.preventDefault(); ev.stopPropagation(); go(-1); } };
  lb.addEventListener("click",ev=>{ const b=ev.target.closest("button"); if(b){ if(b.classList.contains("lbprev")) go(-1); else if(b.classList.contains("lbnext")) go(1); else close(); return; } if(ev.target===lb||ev.target===stage) close(); });
  let sx=null, sy=0; lb.addEventListener("touchstart",ev=>{ if(ev.touches.length===1){ sx=ev.touches[0].clientX; sy=ev.touches[0].clientY; } },{passive:true});
  lb.addEventListener("touchend",ev=>{ if(sx===null) return; const dx=ev.changedTouches[0].clientX-sx, dy=ev.changedTouches[0].clientY-sy; sx=null; if(Math.abs(dx)>50&&Math.abs(dx)>Math.abs(dy)*1.5) go(dx<0?1:-1); });
  document.addEventListener("keydown",k,true); document.body.appendChild(lb); show(); lb.querySelector(".lbclose").focus();
}

/* ---------- add / edit ---------- */
let picking=false;
function openForm(e){
  const isNew=!e; e=e||{kind:"hike",start_date:new Date().toISOString().slice(0,10),route:[]};
  let rpts=validRoute(e.route);
  const root=document.createElement("div");
  root.innerHTML=`<div class="scrim"></div><form class="side" novalidate role="dialog" aria-modal="true" aria-label="${isNew?"Add entry":"Edit entry"}">
    <div class="shead"><span class="label">${isNew?"New entry":"Edit"}</span><button class="xclose" type="button" aria-label="Close">×</button></div>
    <div class="fields">
      <div class="f w"><label class="label" for="fTitle">Title</label><input id="fTitle" value="${esc(e.title||"")}" placeholder="Angels Landing at sunrise"></div>
      <div class="f"><label class="label" for="fKind">Kind</label><select id="fKind">${Object.entries(KINDS).map(([k,v])=>`<option value="${k}"${k===e.kind?" selected":""}>${v}</option>`).join("")}</select></div>
      <div class="f"><label class="label" for="fPlace">Place</label><input id="fPlace" value="${esc(e.place||"")}" placeholder="Zion National Park, Utah"></div>
      <div class="f"><label class="label" for="fStart">Start date</label><input id="fStart" type="date" value="${esc(e.start_date||"")}"></div>
      <div class="f"><label class="label" for="fEnd">End date</label><input id="fEnd" type="date" value="${esc(e.end_date||"")}"></div>
      <div class="f w"><label class="label" for="fCoords">Coordinates</label>
        <div class="coordrow"><input id="fCoords" value="${isFinite(e.lat)?`${e.lat}, ${e.lng}`:""}" placeholder="37.2690, -112.9480"><button class="link label" type="button" id="pickBtn">Pick on map</button></div>
        <span class="hint">Latitude, longitude. Paste from Google Maps: right-click a spot, then click the numbers.</span></div>
      <div class="f w"><span class="label">Route</span>
        <div class="routebar"><span class="mono" id="rSum"></span><span class="sp"></span>
          <button class="link label" type="button" id="rDraw">Draw on map</button>
          <label class="link label" for="rGpx">Import GPX</label><input type="file" id="rGpx" accept=".gpx,application/gpx+xml,application/xml,text/xml" hidden>
          <button class="link label" type="button" id="rText">Edit points</button>
          <button class="del label" type="button" id="rClear">Clear</button></div>
        <textarea id="fRoute" hidden style="min-height:90px;font-family:var(--mono);font-size:12px" placeholder="One “lat, lng” per line, in order"></textarea>
        <span class="hint">Export a GPX from Strava (activity page on the website → ⋯ → Export GPX), Gaia GPS, AllTrails or a Garmin.</span></div>
      <div class="f w"${TRIPS_ON?"":" hidden"}><label class="label" for="fTrip">Trip</label>
        <select id="fTrip"><option value="">None</option>${trips.slice().sort((a,b)=>String((tripRange(b.id)[0])||"").localeCompare(String(tripRange(a.id)[0]||""))).map(t=>`<option value="${esc(t.id)}"${t.id===e.trip_id?" selected":""}>${esc(t.title)}</option>`).join("")}<option value="__new">New trip…</option></select>
        <input id="fTripNew" hidden placeholder="Name of the new trip"></div>
      <div class="f w"><span class="label">Summits</span>
        <div class="routebar"><span class="mono" id="pSum"></span><span class="sp"></span><button class="link label" type="button" id="pFind">Find on route</button></div>
        <textarea id="fPeaks" style="min-height:70px" placeholder="One per line: Lone Peak, 11,076 ft">${esc((e.peaks||[]).map(peakLine).join("\n"))}</textarea>
        <span class="hint">“Find on route” lists named summits the route passes within about 400 ft of.</span></div>
      <div class="f w"><label class="label" for="fGear">Gear</label><textarea id="fGear" style="min-height:80px" placeholder="One item per line">${esc((e.gear||[]).join("\n"))}</textarea><span class="hint">One item per line. Totals add up the miles on each.</span></div>
      <div class="f w"><label class="label" for="fNotes">Notes</label><textarea id="fNotes">${esc(e.notes||"")}</textarea></div>
    </div>
    <p class="formerr" id="fErr"></p>
    <div class="acts"><button class="link" type="button" id="cancelBtn">Cancel</button><span class="sp"></span><button class="btn solid label" type="submit" id="saveBtn">${isNew?"Add Entry":"Save"}</button></div>
  </form>`;
  document.body.appendChild(root);
  const q=s=>root.querySelector(s), ta=q("#fRoute");
  const close=()=>{ root.remove(); document.removeEventListener("keydown",k); }; const k=ev=>{ if(ev.key==="Escape"&&!picking) close(); };
  document.addEventListener("keydown",k); q("#cancelBtn").onclick=close; q(".xclose").onclick=close; q(".scrim").onclick=close;
  setTimeout(()=>q("#fTitle").focus(),40);
  const sum=()=>{ q("#rSum").textContent = rpts.length>1?`${rpts.length} pts · ${mi(routeMeters(rpts)).toFixed(1)} mi`:rpts.length?"1 point":"No route"; };
  const setRoute=pts=>{ rpts=pts; sum(); if(!ta.hidden) ta.value=rpts.map(p=>p.join(", ")).join("\n"); if(pts.length && !parseCoords(q("#fCoords").value)) q("#fCoords").value=`${pts[0][0].toFixed(5)}, ${pts[0][1].toFixed(5)}`; };
  sum();
  q("#rText").onclick=()=>{ ta.hidden=!ta.hidden; q("#rText").textContent=ta.hidden?"Edit points":"Hide points"; if(!ta.hidden) ta.value=rpts.map(p=>p.join(", ")).join("\n"); };
  ta.addEventListener("input",()=>{ rpts=parseRoute(ta.value); sum(); });
  q("#rClear").onclick=()=>setRoute([]);
  q("#rGpx").onchange=async ev=>{ const f=ev.target.files[0]; if(!f) return; try{ const pts=parseGPX(await f.text()); if(pts.length<2) throw 0; setRoute(pts); q("#fErr").textContent=""; }catch{ q("#fErr").textContent="Couldn't read a track from that file. Make sure it's a .gpx export."; } ev.target.value=""; };
  q("#rDraw").onclick=()=>drawOnMap(root,rpts,setRoute);
  q("#pickBtn").onclick=()=>pickOnMap(root,p=>{ q("#fCoords").value=`${p[0].toFixed(5)}, ${p[1].toFixed(5)}`; });
  q("#fTrip").onchange=()=>{ const n=q("#fTrip").value==="__new"; q("#fTripNew").hidden=!n; if(n) q("#fTripNew").focus(); };
  let knownPeaks=[...(e.peaks||[])]; // keeps map positions for peaks found on the route
  q("#pFind").onclick=async()=>{ const b=q("#pFind"); if(rpts.length<2){ q("#pSum").textContent="Add a route first"; return; }
    b.disabled=true; q("#pSum").textContent="Looking…";
    const found=await findPeaks(rpts); b.disabled=false;
    const have=new Set(q("#fPeaks").value.split("\n").map(x=>parsePeakLine(x).name.toLowerCase()).filter(Boolean));
    const add=found.filter(p=>!have.has(p.name.toLowerCase())); knownPeaks.push(...found);
    if(add.length) q("#fPeaks").value=[q("#fPeaks").value.trim(),...add.map(peakLine)].filter(Boolean).join("\n");
    q("#pSum").textContent = found.length ? `Found ${found.length}${add.length<found.length?`, ${found.length-add.length} already listed`:""}` : "None found on this route"; };
  q("form").onsubmit=async ev=>{
    ev.preventDefault(); const err=q("#fErr");
    const title=q("#fTitle").value.trim(), c=parseCoords(q("#fCoords").value), start=q("#fStart").value, end=q("#fEnd").value;
    if(!title){ err.textContent="Add a title."; return; } if(!start){ err.textContent="Add the date it started."; return; }
    if(!c){ err.textContent="Coordinates should look like 37.2690, -112.9480."; return; } if(end&&end<start){ err.textContent="The end date is before the start date."; return; }
    const row={title,kind:q("#fKind").value,place:q("#fPlace").value.trim(),start_date:start,end_date:end||null,lat:+c[0].toFixed(6),lng:+c[1].toFixed(6),route:rpts,notes:q("#fNotes").value,gear:[...new Set(q("#fGear").value.split("\n").map(x=>x.trim()).filter(Boolean))],
      peaks:q("#fPeaks").value.split("\n").map(x=>x.trim()).filter(Boolean).map(parsePeakLine).map(p=>{ const k=knownPeaks.find(x=>x.name.toLowerCase()===p.name.toLowerCase()); return k&&k.lat!=null?{...p,lat:k.lat,lng:k.lng,elev_m:p.elev_m??k.elev_m}:p; })};
    let tripId=q("#fTrip").value;
    if(tripId==="__new"){ const tt=q("#fTripNew").value.trim(); if(!tt){ err.textContent="Name the new trip."; return; }
      const r=await sb.from("trips").insert({title:tt}).select().single(); if(r.error){ err.textContent="Couldn't create the trip: "+r.error.message; return; } tripId=r.data.id; }
    if(TRIPS_ON) row.trip_id=tripId||null; // when trips are off, leave existing assignments alone
    q("#saveBtn").disabled=true;
    const res = isNew ? await sb.from("entries").insert(row).select().single() : await sb.from("entries").update(row).eq("id",e.id).select().single();
    if(res.error){ err.textContent="Couldn't save: "+res.error.message; q("#saveBtn").disabled=false; return; }
    close(); toast(isNew?"Added":"Saved"); selected=res.data.id; await refresh(true); const u=entries.find(x=>x.id===selected); if(u) flyTo(u);
  };
}
function mapMode(root,html){
  picking=true; root.hidden=true; document.body.classList.add("picking");
  const bar=document.createElement("div"); bar.className="pickbar label"; bar.innerHTML=html; $("#chartwrap").appendChild(bar);
  $("#chartwrap").scrollIntoView({block:"nearest"});
  return { bar, end(){ bar.remove(); root.hidden=false; picking=false; document.body.classList.remove("picking"); } };
}
function pickOnMap(root,done){
  if(!map) return; const m=mapMode(root,`<span>Click the map to place the pin</span><button type="button">Cancel</button>`);
  const on=ev=>{ map.off("click",on); m.end(); done([ev.lngLat.lat,ev.lngLat.wrap().lng]); };
  map.on("click",on); m.bar.querySelector("button").onclick=()=>{ map.off("click",on); m.end(); };
}
function drawOnMap(root,start,done){
  if(!map) return; let pts=start.slice();
  const m=mapMode(root,`<span>Click to add points</span><span id="dN" class="mono"></span><button type="button" id="dUndo">Undo</button><button type="button" id="dDone">Done</button><button type="button" id="dCancel">Cancel</button>`);
  const show=()=>{ map.getSource("replay").setData({type:"FeatureCollection",features:pts.length>1?[{type:"Feature",properties:{},geometry:{type:"LineString",coordinates:pts.map(ll)}}]:[]}); m.bar.querySelector("#dN").textContent=`${pts.length} pts${pts.length>1?` · ${mi(routeMeters(pts)).toFixed(1)} mi`:""}`; };
  const on=ev=>{ pts.push([+ev.lngLat.lat.toFixed(6),+ev.lngLat.wrap().lng.toFixed(6)]); show(); };
  const end=ok=>{ map.off("click",on); map.getSource("replay").setData({type:"FeatureCollection",features:[]}); m.end(); if(ok) done(pts); };
  map.on("click",on); show(); if(pts.length>1) map.fitBounds(boundsOf(pts),{padding:70});
  m.bar.querySelector("#dUndo").onclick=()=>{ pts.pop(); show(); };
  m.bar.querySelector("#dDone").onclick=()=>end(true); m.bar.querySelector("#dCancel").onclick=()=>end(false);
}

/* ---------- 3D route replay, modeled on Strava's flyover ----------
   The whole camera path is computed once before playback: the route is resampled, a heavily
   smoothed copy gives the camera's focus point, and the heading comes from a long look-ahead
   that is unwrapped and averaged again. Each frame then just interpolates those arrays and
   calls jumpTo, letting Mapbox keep the camera a steady height above the terrain. */
let replay=null;
function startReplay(e){
  if(!map || e.route.length<2) return; if(replay) replay.stop();
  const route=e.route, cum=[0]; for(let i=1;i<route.length;i++) cum.push(cum[i-1]+hav(route[i-1],route[i]));
  const total=cum.at(-1)||1, miles=mi(total);
  const rawAt=d=>{ d=Math.max(0,Math.min(total,d)); let lo=0,hi=cum.length-1; while(hi-lo>1){ const m=(lo+hi)>>1; if(cum[m]<=d) lo=m; else hi=m; } const f=(d-cum[lo])/((cum[hi]-cum[lo])||1); return [route[lo][0]+(route[hi][0]-route[lo][0])*f, route[lo][1]+(route[hi][1]-route[lo][1])*f]; };

  // 1. resample evenly
  const step=Math.max(3,total/4000), n=Math.ceil(total/step)+1, rs=[];
  for(let k=0;k<n;k++) rs.push(rawAt(Math.min(total,k*step)));
  const avg=(arr,win)=>{ // centered moving average with prefix sums, edges clamped
    const h=Math.max(1,Math.round(win/step)), dims=arr[0].length, pre=Array.from({length:dims},()=>[0]);
    arr.forEach(p=>{ for(let k=0;k<dims;k++) pre[k].push(pre[k].at(-1)+p[k]); });
    return arr.map((_,i)=>{ const a=Math.max(0,i-h), b=Math.min(arr.length-1,i+h), c=b-a+1; return Array.from({length:dims},(_,k)=>(pre[k][b+1]-pre[k][a])/c); });
  };
  // 2. focus path: smooth enough to hide GPS jitter, close enough to stay on the trail
  const focus=avg(avg(rs,Math.max(60,Math.min(400,total*0.012))),Math.max(60,Math.min(400,total*0.012)));
  // 3. heading: long look-ahead, unwrapped, then averaged twice
  const look=Math.max(250,Math.min(1800,total*0.04));
  const lk=Math.max(1,Math.round(look/step));
  let prev=null; const head=focus.map((p,i)=>{ const a=focus[Math.max(0,i-Math.round(lk*0.3))], b=focus[Math.min(n-1,i+lk)]; let h=bearingOf(a,b);
    if(prev!==null){ while(h-prev>180) h-=360; while(h-prev<-180) h+=360; } prev=h; return [h]; });
  const brg=avg(avg(head,look*0.8),look*0.8).map(x=>x[0]);
  const sample=(arr,d)=>{ const x=Math.max(0,Math.min(n-1,d/step)), k=Math.floor(x), f=x-k, a=arr[k], b=arr[Math.min(n-1,k+1)]; return Array.isArray(a)?[a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f]:a+(b-a)*f; };

  // camera framing: closer for short routes, farther back for long ones
  const zoom=Math.max(12.6,Math.min(15.2,15.6-Math.log2(Math.max(1,total/1500))*0.55)), pitch=reduce?0:54;
  const baseDur=Math.min(75,Math.max(22,14+miles*1.6))*1000;

  const wrap=$("#chartwrap"); wrap.classList.add("replay"); wrap.scrollIntoView({block:"nearest"});
  Object.values(markers).forEach(mk=>mk.getElement().style.visibility="hidden");
  map.setPaintProperty("routes-line","line-opacity",["case",["get","on"],0.3,0.2]); map.setPaintProperty("routes-glow","line-opacity",0);
  map.getSource("trail").setData({type:"Feature",properties:{},geometry:{type:"LineString",coordinates:route.map(ll)}});
  const trim=p=>{ const v=[Math.min(.99999,Math.max(0,p)),1]; map.setPaintProperty("trail-line","line-trim-offset",v); map.setPaintProperty("trail-glow","line-trim-offset",v); };
  trim(0); map.setLayoutProperty("trail-line","visibility","visible"); map.setLayoutProperty("trail-glow","visibility","visible");
  const prevEx=1.35; map.setTerrain({source:"dem",exaggeration:1.5});
  const headEl=document.createElement("div"); const fig=REPLAY_FIGS[e.kind];
  headEl.className="rphead"+(fig?" fig":""); if(fig) headEl.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true">${fig}</svg>`;
  const dot=new mapboxgl.Marker({element:headEl}).setLngLat(ll(route[0])).addTo(map);
  // swap the flat marker for a little animated 3D figure once three.js has loaded
  let rider=null;
  if(window.Rider3D && Rider3D.supports(e.kind) && !reduce) Rider3D.load().then(()=>{ if(!replay||replay.e!==e) return;
    try{ rider=Rider3D.create(map,e.kind); headEl.style.visibility="hidden"; }catch(err){ console.warn("3D figure unavailable",err); } }).catch(()=>{});
  const lock=["dragPan","scrollZoom","doubleClickZoom","boxZoom","keyboard","touchZoomRotate","dragRotate","touchPitch"];
  lock.forEach(h=>map[h]&&map[h].disable());

  const title=document.createElement("div"); title.className="replaytitle label"; title.innerHTML=`${esc(KINDS[e.kind])}<b>${esc(e.title)}</b>`; wrap.appendChild(title);
  const bar=document.createElement("div"); bar.className="replaybar";
  bar.innerHTML=`<button type="button" class="label" id="rpPlay">Pause</button><input type="range" id="rpSeek" min="0" max="1000" value="0" aria-label="Position along route"><span class="mono" id="rpRead"></span><button type="button" class="label" id="rpSpeed">1×</button><button type="button" class="label" id="rpView" aria-expanded="false">View</button><button type="button" class="label" id="rpExit">Exit</button>`;
  wrap.appendChild(bar);
  // View panel: zoom and tilt, remembered between replays
  let saved={z:0,p:pitch}; try{ saved={...saved,...JSON.parse(localStorage.getItem("replayView")||"{}")}; }catch{}
  const panel=document.createElement("div"); panel.className="viewpanel"; panel.hidden=true;
  panel.innerHTML=`<label class="label" for="vZoom">Zoom</label><span class="end">Far</span><input type="range" id="vZoom" min="-1.5" max="2" step="0.05" value="${saved.z}"><span class="end">Close</span>
    <label class="label" for="vTilt">Tilt</label><span class="end">Flat</span><input type="range" id="vTilt" min="20" max="72" step="1" value="${saved.p}"><span class="end">Low</span>
    <span></span><button type="button" class="link label" id="vReset">Reset</button><span class="hint">Keys: + − zoom, ↑ ↓ tilt</span>`;
  wrap.appendChild(panel);
  const seekEl=bar.querySelector("#rpSeek"), readEl=bar.querySelector("#rpRead"), playEl=bar.querySelector("#rpPlay");
  const zEl=panel.querySelector("#vZoom"), tEl=panel.querySelector("#vTilt");

  const st={d:0,playing:false,speed:1,last:0,raf:0,uiT:0,v:0, zT:+saved.z, pT:+saved.p, z:+saved.z, p:+saved.p};
  const keep=()=>{ try{ localStorage.setItem("replayView",JSON.stringify({z:st.zT,p:st.pT})); }catch{} };
  const setZ=v=>{ st.zT=Math.max(-1.5,Math.min(2,v)); zEl.value=st.zT; keep(); };
  const setP=v=>{ st.pT=Math.max(20,Math.min(72,v)); tEl.value=st.pT; keep(); };
  zEl.oninput=()=>setZ(+zEl.value); tEl.oninput=()=>setP(+tEl.value);
  panel.querySelector("#vReset").onclick=()=>{ setZ(0); setP(pitch); };
  bar.querySelector("#rpView").onclick=ev=>{ panel.hidden=!panel.hidden; ev.target.setAttribute("aria-expanded",String(!panel.hidden)); };
  const cam=d=>{ const c=sample(focus,d); return {center:[c[1],c[0]],bearing:((sample(brg,d)%360)+360)%360,pitch:reduce?0:st.p,zoom:zoom+st.z}; };
  function frame(now){
    const dt=Math.min(.05,(now-st.last)/1000); st.last=now;
    const cruise=total/(baseDur/1000)*st.speed;
    // ease speed in and out instead of starting and stopping abruptly
    const target = st.playing ? cruise*Math.min(1,0.25+0.75*Math.min(st.d,total-st.d)/Math.max(1,total*0.04)) : 0;
    st.v += (target-st.v)*(1-Math.exp(-3*dt));
    st.d = Math.min(total, st.d + st.v*dt);
    // glide zoom and tilt toward the chosen values so changes never snap
    const k=1-Math.exp(-5*dt); st.z+=(st.zT-st.z)*k; st.p+=(st.pT-st.p)*k;
    if(st.playing && st.d>=total){ st.playing=false; playEl.textContent="Replay"; }
    map.jumpTo(cam(st.d));
    dot.setLngLat(ll(rawAt(st.d))); trim(st.d/total);
    if(rider) rider.update(ll(rawAt(st.d)), bearingOf(rawAt(st.d-15),rawAt(st.d+15)), st.v/(total/(baseDur/1000)));
    if(now-st.uiT>120){ st.uiT=now; seekEl.value=Math.round(st.d/total*1000); readEl.textContent=`${mi(st.d).toFixed(1)} / ${miles.toFixed(1)} mi`; }
    st.raf=requestAnimationFrame(frame);
  }
  let alive=true, started=false;
  const begin=()=>{ if(!alive||started) return; started=true; st.playing=true; st.last=performance.now(); st.raf=requestAnimationFrame(frame); };
  // glide into the opening shot, then start on a timer (camera "moveend" events can fire early here)
  const introMs=reduce?0:2800;
  map.flyTo({...cam(0),duration:introMs,curve:1.4,essential:true});
  const startTimer=setTimeout(begin,introMs+80);

  playEl.onclick=()=>{ if(st.d>=total){ st.d=0; st.v=0; st.playing=true; } else st.playing=!st.playing; playEl.textContent=st.playing?"Pause":"Play"; };
  seekEl.oninput=()=>{ st.d=seekEl.value/1000*total; st.v=0; if(st.d<total && !st.playing) playEl.textContent="Play"; };
  bar.querySelector("#rpSpeed").onclick=ev=>{ st.speed={1:2,2:4,4:.5,.5:1}[st.speed]; ev.target.textContent=(st.speed===.5?"½":st.speed)+"×"; };
  bar.querySelector("#rpExit").onclick=()=>replay.stop(true);
  const onKey=ev=>{
    if(ev.key==="Escape") replay.stop(true);
    if(ev.target!==document.body && ev.target.tagName!=="BUTTON") return;
    if(ev.key===" "){ ev.preventDefault(); playEl.click(); }
    if(ev.key==="+"||ev.key==="="){ ev.preventDefault(); setZ(st.zT+0.25); }
    if(ev.key==="-"||ev.key==="_"){ ev.preventDefault(); setZ(st.zT-0.25); }
    if(ev.key==="ArrowUp"){ ev.preventDefault(); setP(st.pT+3); }
    if(ev.key==="ArrowDown"){ ev.preventDefault(); setP(st.pT-3); }
  };
  document.addEventListener("keydown",onKey);
  replay={ e, stop(fly){ alive=false; if(rider) rider.remove(); clearTimeout(startTimer); cancelAnimationFrame(st.raf); document.removeEventListener("keydown",onKey); bar.remove(); panel.remove(); title.remove(); dot.remove(); wrap.classList.remove("replay");
    lock.forEach(h=>map[h]&&map[h].enable()); map.setTerrain({source:"dem",exaggeration:prevEx});
    Object.values(markers).forEach(mk=>mk.getElement().style.visibility="");
    map.setLayoutProperty("trail-line","visibility","none"); map.setLayoutProperty("trail-glow","visibility","none");
    map.setPaintProperty("routes-line","line-opacity",["case",["get","on"],1,0.6]); map.setPaintProperty("routes-glow","line-opacity",0.25);
    replay=null; if(fly) flyTo(e); } };
}

/* ---------- start ---------- */
$("#addBtn").onclick=()=>openForm(null);
$("#tally").onclick=()=>{ select(null); $("#sheet").scrollIntoView({behavior:reduce?"auto":"smooth"}); };
initMap(); setupMapButtons(); setupFilters(); stravaReturn();
loadEntries().then(()=>{
  const sp=new URL(location.href).searchParams, want=sp.get("e"), wantT=sp.get("t");
  const linked=want&&entries.find(e=>e.id===want), linkedT=!linked&&wantT&&tripById(wantT);
  if(linked) selected=linked.id; else if(linkedT) selTrip=linkedT.id; else if(want||wantT) setUrl(null);
  renderAll();
  const go=()=>{ drawRoutes(); setTimeout(()=>linked?flyTo(linked):linkedT?fitTo(tripEntries(linkedT.id)):fitAll(true),400); };
  if(linkedT){ document.title=`${linkedT.title} · Log`; const b=document.querySelector(`.triphead[data-trip="${CSS.escape(linkedT.id)}"]`); if(b) b.scrollIntoView({block:"center"}); window.scrollTo(0,0); }
  if(map){ if(map.loaded()) go(); else map.once("load",go); }
  if(linked){ document.title=`${linked.title} · Log`; const b=document.querySelector(`.entry[data-id="${CSS.escape(linked.id)}"]`); if(b) b.scrollIntoView({block:"center"}); window.scrollTo(0,0); }
});
initAuth();
})();
