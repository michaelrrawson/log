(function(){
"use strict";
const CFG = window.LOG_CONFIG || {};
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const KINDS = {temple:"Temple & sacred site",backpacking:"Backpacking",highline:"Highline & rope swing",hike:"Hike",trailrun:"Trail run",bike:"Bike ride",mtb:"Mountain bike",climb:"Climbing & canyoneering",water:"Water & river",city:"City & culture",show:"Show & performance",road:"Road trip",other:"Other"};
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
const sb = (CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase) ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey) : null;
let entries=[], selected=null, canEdit=false, source="";
const photoUrl = p => sb ? sb.storage.from("photos").getPublicUrl(p.path).data.publicUrl : (p.url||"");
function norm(r){ return {...r, lat:+r.lat, lng:+r.lng, route:validRoute(r.route), photos:Array.isArray(r.photos)?r.photos:[], notes:r.notes||"", place:r.place||"", kind:KINDS[r.kind]?r.kind:"other"}; }
async function loadEntries(){
  if(sb){
    const {data,error} = await sb.from("entries").select("*").order("start_date");
    if(!error){ entries=data.map(norm); source="live"; return; }
    console.warn("Supabase unavailable, using backup", error);
  }
  try{ const r=await fetch("data/entries.json",{cache:"no-store"}); entries=(await r.json()).map(norm); source=sb?"backup":"file"; }
  catch{ entries=[]; source="none"; }
}
async function refresh(keepView){ await loadEntries(); if(selected && !entries.find(e=>e.id===selected)) selected=null; renderAll(); if(!keepView && !selected) fitAll(false); }

/* ---------- auth: one editor login by email link ---------- */
async function initAuth(){
  if(!sb){ $("#who").textContent = "Read-only copy"; return; }
  $("#authBtn").hidden=false;
  const upd = async session => {
    canEdit=false;
    if(session){ const {data} = await sb.rpc("is_admin"); canEdit = data===true; }
    $("#authBtn").textContent = session ? "Sign out" : "Editor sign in";
    $("#who").textContent = session ? (canEdit ? "Editing" : "Signed in, view only") : "";
    $("#addBtn").hidden=!canEdit; renderAll();
  };
  sb.auth.onAuthStateChange((_ev,session)=>upd(session));
  const {data:{session}} = await sb.auth.getSession(); upd(session);
  $("#authBtn").onclick = async ()=>{
    const {data:{session}} = await sb.auth.getSession();
    if(session){ await sb.auth.signOut(); toast("Signed out"); return; }
    openSignIn();
  };
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
  map.addControl(new mapboxgl.NavigationControl({visualizePitch:true}),"top-right");
  map.addControl(new mapboxgl.ScaleControl({unit:"imperial"}),"bottom-left");
  map.on("style.load", setupStyle);
  map.on("error", e => { if(e && e.error && /401|403|token/i.test(String(e.error.message||e.error.status))){ $("#mapErr").hidden=false; $("#mapErr").textContent="Mapbox refused the token. If it's restricted, check that this site's address is on its URL list."; } });
}
function setupStyle(){
  if(!map.getSource("dem")) map.addSource("dem",{type:"raster-dem",url:"mapbox://mapbox.mapbox-terrain-dem-v1",tileSize:512,maxzoom:14});
  map.setTerrain({source:"dem",exaggeration:1.35});
  map.setFog({range:[1,9],color:"rgb(186,210,235)","high-color":"rgb(36,92,223)","horizon-blend":0.03,"space-color":"rgb(8,10,20)","star-intensity":0.25});
  map.addSource("routes",{type:"geojson",data:routesGeo()});
  map.addSource("replay",{type:"geojson",data:{type:"FeatureCollection",features:[]}});
  map.addLayer({id:"routes-glow",type:"line",source:"routes",layout:{"line-cap":"round","line-join":"round"},paint:{"line-color":"#39ff14","line-width":["case",["get","on"],9,0],"line-opacity":0.25,"line-blur":4}});
  map.addLayer({id:"routes-line",type:"line",source:"routes",layout:{"line-cap":"round","line-join":"round"},paint:{"line-color":"#39ff14","line-width":["case",["get","on"],3,1.6],"line-opacity":["case",["get","on"],1,0.6]}});
  map.addLayer({id:"replay-glow",type:"line",source:"replay",filter:["==",["geometry-type"],"LineString"],layout:{"line-cap":"round","line-join":"round"},paint:{"line-color":"#39ff14","line-width":12,"line-opacity":0.3,"line-blur":5}});
  map.addLayer({id:"replay-line",type:"line",source:"replay",filter:["==",["geometry-type"],"LineString"],layout:{"line-cap":"round","line-join":"round"},paint:{"line-color":"#39ff14","line-width":4}});
  map.addSource("trail",{type:"geojson",lineMetrics:true,data:{type:"Feature",properties:{},geometry:{type:"LineString",coordinates:[[0,0],[0,0]]}}});
  map.addLayer({id:"trail-glow",type:"line",source:"trail",layout:{"line-cap":"round","line-join":"round",visibility:"none"},paint:{"line-color":"#39ff14","line-width":12,"line-opacity":0.3,"line-blur":5,"line-trim-offset":[0,1]}});
  map.addLayer({id:"trail-line",type:"line",source:"trail",layout:{"line-cap":"round","line-join":"round",visibility:"none"},paint:{"line-color":"#39ff14","line-width":4,"line-trim-offset":[0,1]}});
}
function routesGeo(){
  return {type:"FeatureCollection",features:entries.filter(e=>e.route.length>1).map(e=>({type:"Feature",properties:{id:e.id,on:e.id===selected},geometry:{type:"LineString",coordinates:e.route.map(ll)}}))};
}
function drawRoutes(){ if(map && map.getSource("routes")) map.getSource("routes").setData(routesGeo()); }
function drawMarkers(){
  if(!map) return;
  for(const m of Object.values(markers)) m.remove(); markers={};
  for(const e of entries){
    const el=document.createElement("div"); el.className="pinwrap";
    const b=document.createElement("button"); b.type="button"; b.className="pin"+(e.id===selected?" on":""); b.setAttribute("aria-label",e.title);
    b.innerHTML=`<span class="tip">${esc(e.title)}<span class="mono">${esc(fmtRange(e.start_date,e.end_date))}</span></span>`;
    b.addEventListener("click",ev=>{ ev.stopPropagation(); select(e.id,{fly:true}); });
    el.appendChild(b);
    markers[e.id]=new mapboxgl.Marker({element:el,anchor:"bottom"}).setLngLat([e.lng,e.lat]).addTo(map);
  }
}
function boundsOf(pts){ const b=new mapboxgl.LngLatBounds(); pts.forEach(p=>b.extend(ll(p))); return b; }
function flyTo(e){
  if(!map) return;
  const r=e.route, dur=reduce?0:4500;
  if(r.length>1){
    const cam = map.cameraForBounds(boundsOf(r),{padding:90,bearing:-20,pitch:58,maxZoom:13.5}) || {center:[e.lng,e.lat],zoom:12};
    map.flyTo({...cam,bearing:-20,pitch:58,duration:dur,curve:1.6,essential:true});
  } else map.flyTo({center:[e.lng,e.lat],zoom:14.2,pitch:62,bearing:-25,duration:dur,curve:1.6,essential:true});
}
function fitAll(animate=true){
  if(!map || !entries.length) return;
  const pts=entries.flatMap(e=>[[e.lat,e.lng],...e.route]);
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

/* ---------- ledger + sheet ---------- */
const sorted = () => [...entries].sort((a,b)=>String(a.start_date).localeCompare(String(b.start_date)));
function renderTally(){
  $("#nEntries").textContent=entries.length;
  $("#nDays").textContent=entries.reduce((s,e)=>s+days(e.start_date,e.end_date),0);
  $("#nMiles").textContent=Math.round(mi(entries.reduce((s,e)=>s+routeMeters(e.route),0))).toLocaleString();
}
function renderList(){
  const list=$("#list");
  if(!entries.length){ list.innerHTML=`<p class="emptylist">${canEdit?"Nothing logged yet. Choose Add Entry to drop your first pin.":"Nothing logged yet."}</p>`; return; }
  let html="", yr=null;
  for(const e of sorted()){
    const d=parseD(e.start_date), y=d?d.y:"Undated";
    if(y!==yr){ html+=`<div class="year label">${y}</div>`; yr=y; }
    html+=`<button class="entry" type="button" data-id="${esc(e.id)}" aria-current="${e.id===selected}"><span class="d">${d?`${String(d.m).padStart(2,"0")}.${String(d.d).padStart(2,"0")}`:"—"}</span><span><span class="t">${esc(e.title)}</span><span class="m">${esc(e.place||KINDS[e.kind])}</span></span></button>`;
  }
  list.innerHTML=html;
}
function renderAll(){
  renderTally(); renderList(); drawMarkers(); drawRoutes(); renderSheet();
  const e=entries.find(x=>x.id===selected);
  $("#readBtn").hidden=!e; $("#playBtn").hidden=!(e && e.route.length>1);
}
function select(id,{fly=false}={}){
  selected=id; const e=entries.find(x=>x.id===id);
  renderAll(); if(e&&fly) flyTo(e);
  const btn=document.querySelector(`.entry[data-id="${CSS.escape(id)}"]`); if(btn) btn.scrollIntoView({block:"nearest"});
}
$("#list").addEventListener("click",ev=>{ const b=ev.target.closest(".entry"); if(b) select(b.dataset.id,{fly:true}); });
$("#readBtn").onclick=()=>$("#sheet").scrollIntoView({behavior:reduce?"auto":"smooth"});
$("#playBtn").onclick=()=>{ const e=entries.find(x=>x.id===selected); if(e) startReplay(e); };

function renderSheet(){
  const box=$("#sheetIn"), e=entries.find(x=>x.id===selected);
  if(!e){ box.innerHTML=`<div class="intro"><span class="label">Entry</span><h2 class="ttl">Pick an adventure</h2><p>Choose one from the list or click a pin. The map flies to it, and its date, notes and photos show here.${source==="backup"?" (Showing the backup copy: the live database didn't answer.)":""}</p></div>`; return; }
  const nd=days(e.start_date,e.end_date), meters=routeMeters(e.route);
  const gearth=`https://earth.google.com/web/@${e.lat},${e.lng},1500a,3000d,35y,0h,60t,0r`;
  box.innerHTML=`
    <div class="kicker label"><span>${esc(KINDS[e.kind])}</span><span>${esc(fmtRange(e.start_date,e.end_date))}</span></div>
    <h2 class="ttl">${esc(e.title)}</h2>
    <p class="place">${esc(e.place)}</p>
    <dl class="specs">
      <div><dt class="label">Date</dt><dd>${esc(e.start_date)}${e.end_date&&e.end_date!==e.start_date?` → ${esc(e.end_date)}`:""}</dd></div>
      <div><dt class="label">Duration</dt><dd>${nd} day${nd>1?"s":""}</dd></div>
      ${e.route.length>1?`<div><dt class="label">Route</dt><dd>${mi(meters).toFixed(1)} mi · <button type="button" id="playLink">Replay</button></dd></div>`:""}
      <div><dt class="label">Coordinates</dt><dd><span id="dec">${e.lat.toFixed(5)}, ${e.lng.toFixed(5)}</span> · <button type="button" id="copyBtn">Copy</button></dd></div>
      <div><dt class="label">Elsewhere</dt><dd><a href="${gearth}" target="_blank" rel="noopener">Google Earth</a></dd></div>
    </dl>
    <div class="block"><div class="bhead label"><span>Notes</span></div><p class="notes${e.notes?"":" empty"}">${e.notes?esc(e.notes):(canEdit?"No notes yet. Choose Edit to add some.":"No notes.")}</p></div>
    <div class="block"><div class="bhead label"><span>Photos</span><span class="mono">${e.photos.length}</span></div>
      ${e.photos.length||canEdit?`<div class="gallery" id="gallery">${e.photos.map((p,i)=>`<figure class="ph"><img src="${esc(photoUrl(p))}" alt="${esc(p.name||`Photo ${i+1} from ${e.title}`)}" loading="lazy">${canEdit?`<button class="x" type="button" data-del="${i}">Remove</button>`:""}</figure>`).join("")}${canEdit?`<button class="drop" id="drop" type="button"><strong>Add photos</strong><span>Click or drop images</span></button>`:""}</div>`:`<p class="notes empty">No photos.</p>`}
      <input type="file" id="fileIn" accept="image/*" multiple hidden><p class="status" id="upStatus"></p></div>
    ${canEdit?`<div class="acts"><button class="btn solid label" id="editBtn" type="button">Edit</button><span class="sp"></span><span id="delWrap"><button class="del label" id="delBtn" type="button">Delete entry</button></span></div>`:""}`;
  const q=s=>box.querySelector(s);
  q("#copyBtn").onclick=async()=>{ try{ await navigator.clipboard.writeText(q("#dec").textContent); q("#copyBtn").textContent="Copied"; }catch{ q("#copyBtn").textContent="Select and copy"; } };
  if(q("#playLink")) q("#playLink").onclick=()=>startReplay(e);
  if(q("#gallery")) q("#gallery").addEventListener("click",ev=>{ const d=ev.target.closest("[data-del]"); if(d){ removePhoto(e,+d.dataset.del,d); return; } const img=ev.target.closest("img"); if(img) lightbox(img.src,img.alt); });
  const drop=q("#drop");
  if(drop){ drop.onclick=()=>q("#fileIn").click(); q("#fileIn").onchange=ev=>uploadPhotos(e,[...ev.target.files]);
    drop.addEventListener("dragover",ev=>{ev.preventDefault();drop.classList.add("over");}); drop.addEventListener("dragleave",()=>drop.classList.remove("over"));
    drop.addEventListener("drop",ev=>{ev.preventDefault();drop.classList.remove("over");uploadPhotos(e,[...ev.dataTransfer.files].filter(f=>f.type.startsWith("image/")));}); }
  if(q("#editBtn")) q("#editBtn").onclick=()=>openForm(e);
  const dw=q("#delWrap"); if(dw) dw.addEventListener("click",async ev=>{ const a=ev.target.closest("button"); if(!a) return;
    if(a.id==="delBtn"){ dw.innerHTML=`<span>Delete for good?</span> <button class="del" type="button" id="delYes">Delete</button> <button class="link" type="button" id="delNo">Keep</button>`; return; }
    if(a.id==="delNo"){ dw.innerHTML=`<button class="del label" id="delBtn" type="button">Delete entry</button>`; return; }
    if(a.id==="delYes"){ const {error}=await sb.from("entries").delete().eq("id",e.id); if(error){ toast("Couldn't delete: "+error.message); return; }
      if(e.photos.length) await sb.storage.from("photos").remove(e.photos.map(p=>p.path)); selected=null; toast("Deleted"); refresh(true); } });
}
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
function lightbox(src,alt){
  const lb=document.createElement("div"); lb.className="lightbox"; lb.innerHTML=`<img alt=""><button type="button" aria-label="Close">×</button>`;
  lb.querySelector("img").src=src; lb.querySelector("img").alt=alt;
  const close=()=>{ lb.remove(); document.removeEventListener("keydown",k); }; const k=ev=>{ if(ev.key==="Escape") close(); };
  lb.addEventListener("click",ev=>{ if(ev.target===lb||ev.target.tagName==="BUTTON") close(); }); document.addEventListener("keydown",k); document.body.appendChild(lb);
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
  q("form").onsubmit=async ev=>{
    ev.preventDefault(); const err=q("#fErr");
    const title=q("#fTitle").value.trim(), c=parseCoords(q("#fCoords").value), start=q("#fStart").value, end=q("#fEnd").value;
    if(!title){ err.textContent="Add a title."; return; } if(!start){ err.textContent="Add the date it started."; return; }
    if(!c){ err.textContent="Coordinates should look like 37.2690, -112.9480."; return; } if(end&&end<start){ err.textContent="The end date is before the start date."; return; }
    const row={title,kind:q("#fKind").value,place:q("#fPlace").value.trim(),start_date:start,end_date:end||null,lat:+c[0].toFixed(6),lng:+c[1].toFixed(6),route:rpts,notes:q("#fNotes").value};
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
  const headEl=document.createElement("div"); headEl.className="rphead";
  const dot=new mapboxgl.Marker({element:headEl}).setLngLat(ll(route[0])).addTo(map);
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
  replay={ stop(fly){ alive=false; clearTimeout(startTimer); cancelAnimationFrame(st.raf); document.removeEventListener("keydown",onKey); bar.remove(); panel.remove(); title.remove(); dot.remove(); wrap.classList.remove("replay");
    lock.forEach(h=>map[h]&&map[h].enable()); map.setTerrain({source:"dem",exaggeration:prevEx});
    Object.values(markers).forEach(mk=>mk.getElement().style.visibility="");
    map.setLayoutProperty("trail-line","visibility","none"); map.setLayoutProperty("trail-glow","visibility","none");
    map.setPaintProperty("routes-line","line-opacity",["case",["get","on"],1,0.6]); map.setPaintProperty("routes-glow","line-opacity",0.25);
    replay=null; if(fly) flyTo(e); } };
}

/* ---------- start ---------- */
$("#addBtn").onclick=()=>openForm(null);
initMap(); setupMapButtons();
loadEntries().then(()=>{
  renderAll();
  if(map){ if(map.loaded()) { drawRoutes(); setTimeout(()=>fitAll(true),400); } else map.once("load",()=>{ drawRoutes(); setTimeout(()=>fitAll(true),400); }); }
});
initAuth();
})();
