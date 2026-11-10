// Little animated 3D figures that ride along the route during replay.
// Built from simple shapes with three.js (loaded only when a replay starts), drawn into the map
// as a Mapbox custom layer so they stand on the 3D terrain and face along the route.
// Model units are meters, origin at the feet, facing +Z, up +Y.
(function(){
  const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.149.0/build/three.min.js";
  const KINDS = { hike:"hiker", climb:"hiker", backpacking:"backpacker", trailrun:"runner", bike:"cyclist", mtb:"cyclist", ski:"skier", water:"paddler", offroad:"4runner" };
  const ACCENT = 0x2f9bff, SCREEN_PX = 46; // figure height on screen, in pixels
  // Outfits for the figure. Pick one with replayOutfit in config.js.
  const OUTFITS = {
    classic: { top:ACCENT, pants:0x23262c, shoe:0x121212, skin:0xf0c6a2, hood:false, tie:null, helmet:true },
    // After Bob Dylan's Vatican visit with Pope Leo (Nov 2026): dark coat over a black hoodie with the hood up,
    // black cap under the hood, loosely knotted polka-dot tie, black leather gloves, hook-handled umbrella for a walking stick
    dylan:   { top:0x26272b, hoodie:0x0d0d0f, pants:0x2c2d31, shoe:0x0e0e0e, skin:0xf0c6a2, hood:true, cap:true,
               tie:0x2a3550, dots:0xe9e6dc, gloves:0x0b0b0c, umbrella:true, helmet:false },
  };
  const outfit = () => OUTFITS[(window.LOG_CONFIG||{}).replayOutfit] || OUTFITS.classic;
  let loading = null;

  function load(){
    if(window.THREE) return Promise.resolve();
    if(!loading) loading = new Promise((res, rej) => { const s=document.createElement("script"); s.src=THREE_URL; s.onload=res; s.onerror=rej; document.head.appendChild(s); });
    return loading;
  }

  // ---- the generated 4Runner (scripts/4runner/build.py -> assets/4runner): one packed binary + three textures, loaded once
  const RUNNER_DIR = "assets/4runner/", RUNNER_VER = "3";
  let runnerP = null;
  function loadRunner(){
    if(runnerP) return runnerP;
    const T = window.THREE, tl = new T.TextureLoader();
    const tex = f => new Promise((res, rej) => tl.load(RUNNER_DIR + f + "?v=" + RUNNER_VER, t => { t.anisotropy = 8; res(t); }, undefined, rej));
    runnerP = Promise.all([
      fetch(RUNNER_DIR + "model.bin?v=" + RUNNER_VER).then(r => { if(!r.ok) throw new Error("model.bin " + r.status); return r.arrayBuffer(); }),
      tex("body.jpg"), tex("body_spec.jpg"), tex("wheel.jpg")
    ]).then(([buf, atlas, spec, wheelTex]) => {
      const Ph = o => new T.MeshPhongMaterial(o);
      const silver = Ph({ color:0x8e949a, specular:0x9aa0a6, shininess:60 }), dark = Ph({ color:0x17181b, specular:0x1a1a1a, shininess:6 });
      const mats = {
        body:  [Ph({ map:atlas, specularMap:spec, specular:0x9aa1a9, shininess:55 }), dark, silver],
        wheel: [Ph({ map:wheelTex, specular:0x161616, shininess:5, side:T.DoubleSide }),
                Ph({ color:0xc9ced4, specular:0xffffff, shininess:110, side:T.DoubleSide }), Ph({ color:0x1b1c1f, side:T.DoubleSide })],
      };
      return { geo: parseRunner(T, buf), mats };
    });
    runnerP.catch(() => { runnerP = null; });
    return runnerP;
  }
  function parseRunner(T, buf){
    const dv = new DataView(buf), n = dv.getUint32(4, true);
    const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, n))), base = 8 + n, out = {};
    for(const m of head.meshes){
      const g = new T.BufferGeometry(), q = new Int16Array(buf, base + m.pos, m.count * 3), p = new Float32Array(m.count * 3), k = m.scale / 32767;
      for(let i = 0; i < p.length; i++) p[i] = q[i] * k;
      g.setAttribute("position", new T.BufferAttribute(p, 3));
      g.setAttribute("normal", new T.BufferAttribute(new Int8Array(buf, base + m.nrm, m.count * 3), 3, true));
      if(m.uv != null) g.setAttribute("uv", new T.BufferAttribute(new Uint16Array(buf, base + m.uv, m.count * 2), 2, true));
      g.setIndex(new T.BufferAttribute(m.indexType === 32 ? new Uint32Array(buf, base + m.index, m.indexCount) : new Uint16Array(buf, base + m.index, m.indexCount), 1));
      for(const [start, count, mat] of m.groups) g.addGroup(start, count, mat);
      out[m.name] = g;
    }
    return out;
  }
  function assembleRunner(R, body, car, wheels){
    const T = window.THREE, mk = k => { const o = new T.Mesh(R.geo[k], R.mats[k]); o.frustumCulled = false; return o; };
    body.add(mk("body"));
    const WX = .80, AXLE_R = .4015, FA = 1.5165, RA = -1.2775;      // 63 in track, 265/70R17, 110 in wheelbase
    for(const x of [1, -1]) for(const z of [FA, RA]){
      const w = new T.Group(); w.position.set(x * WX, AXLE_R, z); if(x < 0) w.rotation.y = Math.PI;   // lettering faces out
      w.add(mk("wheel")); car.add(w); wheels.push(w);
    }
  }

  function build(type){
    const T = window.THREE;
    const mat = c => new T.MeshLambertMaterial({ color:c });
    const O = outfit();
    const M = { skin:mat(O.skin), shirt:mat(O.top), accent:mat(ACCENT), pants:mat(O.pants), shoe:mat(O.shoe), dark:mat(0x1b1d21), tire:mat(0x0c0c0c), metal:mat(0xa7adb3), pack:mat(0x44525f), helmet:mat(0xf4f4f4) };
    const mesh = (g,m) => new T.Mesh(g,m);
    // a limb hanging down from a pivot: rotation.x < 0 swings it forward
    const limb = (len, r, m) => { const p=new T.Group(), c=mesh(new T.CapsuleGeometry(r, Math.max(.01,len-2*r), 4, 8), m); c.position.y=-len/2; p.add(c); p.len=len; return p; };
    const tube = (a, b, r, m) => { const A=new T.Vector3(...a), B=new T.Vector3(...b), d=B.clone().sub(A), c=mesh(new T.CylinderGeometry(r,r,d.length(),8), m);
      c.position.copy(A).add(B).multiplyScalar(.5); c.quaternion.setFromUnitVectors(new T.Vector3(0,1,0), d.normalize()); return c; };

    function human({ legs=true }={}){
      const root=new T.Group(), pelvis=new T.Group(); root.add(pelvis);
      const torso=new T.Group(); pelvis.add(torso);
      const body=mesh(new T.CapsuleGeometry(.15,.3,4,10), M.shirt); body.position.y=.3; body.scale.set(1.15,1,.8); torso.add(body);
      const head=mesh(new T.SphereGeometry(.115,14,10), M.skin); head.position.y=.72; torso.add(head);
      const H = { root, pelvis, torso, head };
      if(O.hood){ // hood up: a shell around the head, open at the face (+Z)
        const open=.82, hood=mesh(new T.SphereGeometry(.145,16,12, Math.PI/2+open, Math.PI*2-2*open, 0, Math.PI*.66), new T.MeshPhongMaterial({ color:O.hoodie??O.top, side:T.DoubleSide, shininess:4 }));
        hood.position.set(0,.012,-.012); head.add(hood);
        if(O.cap){ const brim=mesh(new T.CylinderGeometry(.07,.07,.008,16,1,false,-Math.PI/2,Math.PI), mat(0x0a0a0b));
          brim.scale.set(1,1,1.1); brim.position.set(0,.098,.07); brim.rotation.x=-.12; head.add(brim);  // cap brim peeking out of the hood
          const crown=mesh(new T.SphereGeometry(.12,14,8,0,Math.PI*2,0,Math.PI*.3), mat(0x0a0a0b)); crown.position.y=.03; head.add(crown); }
        // black hoodie front showing between the coat lapels
        const bib=mesh(new T.BoxGeometry(.14,.2,.01), mat(O.hoodie??O.top)); bib.position.set(0,.47,.112); torso.add(bib);
        const drape=mesh(new T.CapsuleGeometry(.07,.06,4,8), mat(O.hoodie??O.top)); drape.rotation.x=Math.PI/2; drape.position.set(0,.6,-.09); torso.add(drape);
      }
      if(O.tie!=null){ // a loosened tie: knot pulled down below an open collar, blade hanging a little askew
        let tieM=mat(O.tie);
        if(O.dots!=null){ const cv=document.createElement("canvas"); cv.width=32; cv.height=128; const g=cv.getContext("2d");
          g.fillStyle="#"+O.tie.toString(16).padStart(6,"0"); g.fillRect(0,0,32,128); g.fillStyle="#"+O.dots.toString(16).padStart(6,"0");
          for(let y=6,r=0;y<128;y+=12,r++) for(let x=(r%2?4:10);x<32;x+=12){ g.beginPath(); g.arc(x,y,2.6,0,7); g.fill(); }
          const tx=new T.CanvasTexture(cv); tx.magFilter=T.NearestFilter; tieM=new T.MeshLambertMaterial({ map:tx }); }
        const collar=mesh(new T.BoxGeometry(.1,.035,.01), mat(0xeeeeea)); collar.position.set(0,.585,.118); torso.add(collar);
        const knot=mesh(new T.BoxGeometry(.045,.045,.025), tieM); knot.position.set(.004,.545,.124); knot.rotation.z=.15; torso.add(knot);
        const blade=mesh(new T.BoxGeometry(.055,.25,.012), tieM); blade.position.set(.018,.4,.126); blade.rotation.set(-.08,0,.1); torso.add(blade);
      }
      for(const [side,x] of [["l",.21],["r",-.21]]){
        const arm=limb(.3,.05,M.shirt); arm.position.set(x,.56,0); torso.add(arm);
        const fore=limb(.28,.045,O.hood?M.shirt:M.skin); fore.position.y=-.3; arm.add(fore);
        if(O.hood){ const hand=mesh(new T.SphereGeometry(.048,10,8), O.gloves!=null?new T.MeshPhongMaterial({ color:O.gloves, shininess:60, specular:0x555555 }):M.skin); hand.position.y=-.29; fore.add(hand); } // long sleeves
        H[side+"Arm"]=arm; H[side+"Fore"]=fore;
        if(legs){
          const thigh=limb(.45,.07,M.pants); thigh.position.set(x*.5,0,0); pelvis.add(thigh);
          const shin=limb(.45,.06,M.pants); shin.position.y=-.45; thigh.add(shin);
          const foot=mesh(new T.BoxGeometry(.1,.07,.24), M.shoe); foot.position.set(0,-.44,.06); shin.add(foot);
          H[side+"Thigh"]=thigh; H[side+"Shin"]=shin; H[side+"Foot"]=foot;
        }
      }
      pelvis.position.y = legs ? .93 : 0;
      return H;
    }
    // two-link leg reaching from the hip to a target (y,z) given in the pelvis frame; knee points forward
    function reach(thigh, shin, ty, tz){
      const L1=thigh.len, L2=shin.len, d=Math.min(L1+L2-1e-3, Math.max(.05, Math.hypot(ty,tz)));
      const base=Math.atan2(-tz,-ty), a=Math.acos((L1*L1+d*d-L2*L2)/(2*L1*d)), k=Math.acos((L1*L1+L2*L2-d*d)/(2*L1*L2));
      thigh.rotation.x = base - a; shin.rotation.x = Math.PI - k;
    }

    const root=new T.Group(); let tick;
    if(type==="runner" || type==="hiker" || type==="backpacker"){
      const H=human(); root.add(H.root);
      const run = type==="runner";
      const legAmp = run?.75:.38, armAmp = run?.7:.32, lean = run?.2:.08, cadence = run?2.6:1.7;
      if(!run && O.umbrella){ // a furled black umbrella with a hook handle, used as a walking stick
        const u=new T.Group(); u.position.y=-.29; H.rFore.add(u); const blk=mat(0x0c0c0d), tip=[0,-1.0,.12];
        u.add(tube([0,.06,0],tip,.01,M.metal));
        const furl=mesh(new T.ConeGeometry(.045,.62,10), blk); furl.position.set(0,-.62,.074);
        furl.quaternion.setFromUnitVectors(new T.Vector3(0,-1,0), new T.Vector3(...tip).normalize()); u.add(furl);
        const hook=mesh(new T.TorusGeometry(.055,.014,6,14,Math.PI), mat(0x3b2a1e)); hook.position.set(0,.06,-.055); hook.rotation.y=Math.PI/2; u.add(hook);
      } else if(!run){ // trekking pole in the right hand
        const pole=tube([0,0,0],[0,-1.05,.12],.012,M.metal); pole.position.y=-.26; H.rFore.add(pole);
      }
      if(type==="backpacker"){ const pack=mesh(new T.BoxGeometry(.36,.52,.22), M.pack); pack.position.set(0,.36,-.21); H.torso.add(pack);
        const roll=mesh(new T.CylinderGeometry(.08,.08,.38,10), M.accent); roll.rotation.z=Math.PI/2; roll.position.set(0,.66,-.21); H.torso.add(roll); }
      H.torso.rotation.x = lean;
      let p=0;
      tick=(dt,m)=>{ p += dt*cadence*2*Math.PI*Math.min(1.6,m); const s=Math.sin(p), c=Math.cos(p), w=Math.min(1,m*1.5);
        H.lThigh.rotation.x = -legAmp*s*w; H.rThigh.rotation.x = legAmp*s*w;
        H.lShin.rotation.x = (run?.25:.08) + w*(run?1.2:.55)*Math.max(0, c);
        H.rShin.rotation.x = (run?.25:.08) + w*(run?1.2:.55)*Math.max(0,-c);
        H.lArm.rotation.x = armAmp*s*w; H.rArm.rotation.x = -armAmp*s*w*(run?1:.6) - (run?0:.25);
        H.lFore.rotation.x = run?-1.4:-.35; H.rFore.rotation.x = run?-1.4:-.5;
        H.pelvis.position.y = .93 - (run?.06:.02)*w*(1-Math.abs(c)) - (run?.05:0);
      };
    }
    else if(type==="skier"){
      const H=human(); root.add(H.root); H.torso.rotation.x=.25;
      for(const s of ["l","r"]){
        const ski=mesh(new T.BoxGeometry(.09,.025,1.7), M.dark); ski.position.set(0,-.48,.18); H[s+"Shin"].add(ski); H[s+"Ski"]=ski;
        const pole=tube([0,0,0],[0,-1.0,-.25],.011,M.metal); pole.position.y=-.26; H[s+"Fore"].add(pole);
      }
      let p=0;
      tick=(dt,m)=>{ p += dt*1.5*2*Math.PI*Math.min(1.6,m); const s=Math.sin(p), w=Math.min(1,m*1.5);
        H.lThigh.rotation.x = -.15-.32*s*w; H.rThigh.rotation.x = -.15+.32*s*w; H.lShin.rotation.x = .45; H.rShin.rotation.x = .45;
        for(const k of ["l","r"]) H[k+"Ski"].rotation.x = -(H[k+"Thigh"].rotation.x + H[k+"Shin"].rotation.x); // keep skis flat on the snow
        H.lArm.rotation.x = .4*s*w-.2; H.rArm.rotation.x = -.4*s*w-.2; H.lFore.rotation.x = H.rFore.rotation.x = -.5;
        H.pelvis.position.y = .84;
      };
    }
    else if(type==="cyclist"){
      const bike=new T.Group(); root.add(bike);
      const R=.34, rear=[0,R,-.52], front=[0,R,.55], bb=[0,.3,-.02], seat=[0,.92,-.2], bar=[0,1.0,.42];
      const wheel=z=>{ const g=new T.Group(); g.position.set(0,R,z);
        g.add(mesh(new T.TorusGeometry(R,.035,8,28), M.tire)); const rim=mesh(new T.TorusGeometry(R-.04,.012,6,24), M.metal); g.add(rim);
        for(let i=0;i<4;i++){ const sp=tube([0,0,0],[0,R-.05,0],.006,M.metal); sp.rotation.z=i*Math.PI/2; g.add(sp); }
        g.rotation.y=Math.PI/2; bike.add(g); return g; };
      const wr=wheel(rear[2]), wf=wheel(front[2]);
      const fm=M.accent; // frame in the accent color
      bike.add(tube(rear,bb,.025,fm), tube(bb,seat,.028,fm), tube(seat,[0,.93,.36],.028,fm), tube([0,.93,.36],bb,.03,fm), tube(rear,seat,.02,fm), tube([0,.93,.36],front,.025,fm));
      bike.add(tube([0,.92,.36],bar,.022,M.dark), tube([-.22,1.0,.44],[.22,1.0,.44],.018,M.dark));
      const saddle=mesh(new T.BoxGeometry(.1,.04,.24), M.dark); saddle.position.set(0,.95,-.2); bike.add(saddle);
      const crank=new T.Group(); crank.position.set(...bb); bike.add(crank);
      const CL=.17; crank.add(tube([.07,0,0],[.07,-CL,0],.015,M.dark), tube([-.07,0,0],[-.07,CL,0],.015,M.dark));
      const H=human(); bike.add(H.root); H.pelvis.position.set(0,.98,-.2); H.torso.rotation.x=.95;
      if(O.helmet && !O.hood){ const helmet=mesh(new T.SphereGeometry(.13,14,8,0,Math.PI*2,0,Math.PI/2), M.helmet); helmet.position.y=.74; H.torso.add(helmet); }
      H.lArm.rotation.x = H.rArm.rotation.x = -.62; H.lFore.rotation.x = H.rFore.rotation.x = -.25;
      H.head.position.z=.05;
      let a=0;
      tick=(dt,m)=>{ const v=Math.min(2,m);
        wr.rotateZ(-dt*v*7); wf.rotateZ(-dt*v*7);
        a += dt*2*Math.PI*1.3*v; crank.rotation.x = a;   // pedals go forward over the top
        const hy=.98, hz=-.2, c=Math.cos(a)*CL, sn=Math.sin(a)*CL;
        const feet = { l:[bb[1]-c, bb[2]-sn], r:[bb[1]+c, bb[2]+sn] };
        for(const k of ["l","r"]){ reach(H[k+"Thigh"], H[k+"Shin"], feet[k][0]-hy, feet[k][1]-hz);
          H[k+"Foot"].rotation.x = -(H[k+"Thigh"].rotation.x+H[k+"Shin"].rotation.x); }
      };
    }
    else if(type==="4runner"){ // 2012 Toyota 4Runner SR5 Premium, Magnetic Gray, on BFGoodrich KO3s.
      // The model is generated offline (scripts/4runner/build.py) from a side-on reference photo and the published dimensions,
      // and loaded from assets/4runner. Car faces +Z; +X is the driver's (left) side. Built at true size, then shrunk.
      const car=new T.Group(); car.scale.setScalar(.37); root.add(car);
      const body=new T.Group(); car.add(body); const wheels=[];
      loadRunner().then(R=>assembleRunner(R, body, car, wheels)).catch(err=>{
        console.warn("4Runner model unavailable, using the simple one", err); legacyRunner(body, wheels); });
      function legacyRunner(car, wheels){
      const P=new T.MeshPhongMaterial({ color:0x5a5e64, shininess:60, specular:0x80868d });   // Magnetic Gray metallic
      const S=new T.MeshPhongMaterial({ color:0xd4d8dd, shininess:110, specular:0xffffff });  // silver / chrome
      const G=new T.MeshPhongMaterial({ color:0x14191e, shininess:100, specular:0x8f9aa4, side:T.DoubleSide, transparent:true, opacity:.8 }); // tinted glass
      const D=mat(0x26282c), RED=new T.MeshPhongMaterial({ color:0xb01019, shininess:80 }), AMB=mat(0xe39a2a);
      const LENS=new T.MeshPhongMaterial({ color:0xe4ebf1, shininess:120, specular:0xffffff });
      const add=o=>{ car.add(o); return o; };
      const box=(w,h,l,m,x,y,z)=>{ const b=mesh(new T.BoxGeometry(w,h,l),m); b.position.set(x,y,z); return add(b); };
      // extrude a side-view outline (pts as [z,y]) across the car, centred, `width` wide
      const side=(pts, width, m, bev=0)=>{ const s=new T.Shape(); s.moveTo(...pts[0]); for(const p of pts.slice(1)) Array.isArray(p)?s.lineTo(...p):p(s);
        const g=new T.ExtrudeGeometry(s,{ depth:width-2*bev, bevelEnabled:bev>0, bevelThickness:bev, bevelSize:bev*.8, bevelSegments:2, curveSegments:10 });
        g.translate(0,0,-(width-2*bev)/2); const o=mesh(g,m); o.rotation.y=-Math.PI/2; return add(o); };
      const FA=1.58, RA=-1.36, R=.41, AR=.5, AY=.45;   // axles, tire radius, wheel-arch radius and height
      const arch=c=>s=>{ s.lineTo(c+AR,AY); s.absarc(c,AY,AR,0,Math.PI,false); };
      // lower body up to the beltline, with hood, blunt nose and arch cut-outs
      side([[2.3,.42],arch(FA),[FA-AR-.06,.38],[RA+AR+.06,.38],arch(RA),[-2.38,.42],[-2.43,.55],[-2.43,.78],[-2.3,1.37],[1.16,1.31],[1.38,1.29],[2.25,1.24],[2.42,1.19],[2.43,.62]], 1.82, P, .045);
      // greenhouse: narrower than the body, upright windshield, nearly vertical tailgate
      side([[-2.28,1.33],[-2.14,1.76],[-2.06,1.82],[.66,1.83],[1.36,1.26],[1.16,1.29]], 1.7, P, .035);
      // side glass: one blacked-out band (black pillars, like the real thing) with the rear quarter window kicking up over the rear wheel
      side([[1.16,1.35],[.62,1.79],[-1.94,1.79],[-2.02,1.72],[-2.07,1.56],[-2.03,1.48],[-1.55,1.41]], 1.79, G);
      const BLK=mat(0x0c0d0f);
      const ws=mesh(new T.PlaneGeometry(1.5,.86), G); ws.position.set(0,1.57,1.045); ws.rotation.x=-.89; add(ws);   // windshield
      const rw=mesh(new T.PlaneGeometry(1.36,.44), G); rw.position.set(0,1.56,-2.255); rw.rotation.set(.31,Math.PI,0); add(rw);  // rear glass
      box(1.6,.2,4,D, 0,.36,0);   // dark underbody, so the arches don't look hollow
      for(const x of [1,-1]){
        for(const c of [FA,RA]){ // squared-off fender flares
          const f=mesh(new T.TorusGeometry(AR+.03,.055,4,14,Math.PI), P); f.scale.set(1,1,1.4); f.rotation.y=Math.PI/2; f.position.set(x*.93,AY,c); add(f); }
        box(.04,.04,2.3,S, x*.82,1.89,-.8);   // silver roof rails
        for(const z of [-1.9,.3]) box(.05,.06,.08,S, x*.82,1.86,z);
        box(.16,.05,1.82,S, x*.98,.34,.11);                // silver running boards
        box(.2,.14,.09,P, x*.95,1.42,1.14);   // body-colour mirrors
        for(const z of [.05,-.95]) box(.02,.035,.15,S, x*.92,1.18,z);   // chrome door handles
        box(.02,.42,.1,BLK, x*.9,1.56,-.55); { const c=box(.02,.46,.2,P, x*.9,1.6,-1.4); c.rotation.x=-.28; }   // black B pillar, wide body-colour C pillar
        box(.03,.035,1.82,S, x*.92,.47,.11);                 // chrome strip along the bottom of the doors
        // tall taillights at the rear corners, wrapping onto the sides
        box(.22,.38,.07,RED, x*.8,1.14,-2.39).rotation.x=.175; box(.03,.34,.2,RED, x*.91,1.14,-2.25);
        // big headlights, upswept toward the fenders, amber at the outer end
        const hl=new T.Group(); hl.position.set(x*.69,1.05,2.44); hl.rotation.set(0,x*.38,x*.12); add(hl);
        hl.add(mesh(new T.BoxGeometry(.44,.19,.08), LENS));
        const am=mesh(new T.BoxGeometry(.08,.11,.085), AMB); am.position.x=x*.19; hl.add(am);
        for(const o of [-.07,.07]){ const pr=mesh(new T.CylinderGeometry(.045,.045,.09,12), S); pr.rotation.x=Math.PI/2; pr.position.x=x*o-x*.03; hl.add(pr); }
        // rectangular fog lights at the bumper corners: clear lamp inside, amber outside
        box(.32,.11,.03,D, x*.66,.66,2.465); box(.11,.075,.035,LENS, x*.59,.66,2.47); box(.12,.065,.035,AMB, x*.72,.66,2.47);
      }
      // upper grille: dark mesh, tapering down, with one wide chrome bar across the top carrying the Toyota emblem
      const trap=(tw,bw,top,bot)=>{ const s=new T.Shape(); s.moveTo(-tw/2,top); s.lineTo(tw/2,top); s.lineTo(bw/2,bot); s.lineTo(-bw/2,bot); s.closePath(); return s; };
      const gD=mesh(new T.ExtrudeGeometry(trap(1.0,.8,1.14,.83),{depth:.06,bevelEnabled:false}), D); gD.position.z=2.42; add(gD);
      box(.98,.05,.03,S, 0,1.08,2.49);
      const emb=new T.Group(); emb.position.set(0,1.08,2.51); add(emb);
      for(const [rx,ry,t,y] of [[.12,.08,.12,0],[.043,.068,.18,0],[.084,.035,.2,.035]]){ const o=mesh(new T.TorusGeometry(1,t,6,24), S); o.scale.set(rx,ry,.03); o.position.y=y; emb.add(o); }
      // body-colour bumper framing a wide lower mesh intake, thin chrome strip along the bottom
      box(1.9,.36,.24,P, 0,.66,2.34);
      box(.82,.16,.03,D, 0,.67,2.47);
      box(1.5,.03,.03,S, 0,.52,2.465);
      box(1.7,.1,.2,D, 0,.43,2.3);
      // rear: roof spoiler, bumper with a chrome strip, chrome tailgate garnish with 4RUNNER on it and the emblem above
      box(1.5,.05,.26,P, 0,1.86,-2.14).rotation.x=-.08;
      box(1.9,.26,.22,P, 0,.62,-2.36); box(1.6,.03,.03,S, 0,.74,-2.475); box(1.6,.1,.2,D, 0,.46,-2.3);
      box(.96,.11,.04,S, 0,1.13,-2.405).rotation.x=.175;
      { const cv=document.createElement("canvas"); cv.width=256; cv.height=40; const g=cv.getContext("2d");
        g.fillStyle="#4a4d52"; g.font="bold 30px Arial, sans-serif"; g.textAlign="center"; g.textBaseline="middle"; g.fillText("4RUNNER",128,22);
        const name=mesh(new T.PlaneGeometry(.8,.1), new T.MeshBasicMaterial({ map:new T.CanvasTexture(cv), transparent:true }));
        name.position.set(0,1.13,-2.428); name.rotation.set(.175,Math.PI,0); add(name);
        const emR=new T.Group(); emR.position.set(0,1.3,-2.38); emR.rotation.set(.175,Math.PI,0); add(emR);
        for(const [rx,ry,t,y] of [[.08,.054,.12,0],[.029,.045,.18,0],[.056,.024,.2,.024]]){ const o=mesh(new T.TorusGeometry(1,t,6,24), S); o.scale.set(rx,ry,.03); o.position.y=y; emR.add(o); } }
      // wheels: street tires with silver six split-spoke alloys
      const RIM=mat(0x34373b);
      for(const x of [.8,-.8]) for(const z of [FA,RA]){ const w=new T.Group(); w.position.set(x,R,z); add(w);
        const t=mesh(new T.CylinderGeometry(R,R,.27,24), M.tire); t.rotation.z=Math.PI/2; w.add(t);
        const sd=Math.sign(x), face=mesh(new T.CylinderGeometry(R*.68,R*.68,.02,24), RIM); face.rotation.z=Math.PI/2; face.position.x=sd*.136; w.add(face);
        const lip=mesh(new T.TorusGeometry(R*.68,.014,6,24), S); lip.rotation.y=Math.PI/2; lip.position.x=sd*.145; w.add(lip);
        for(let i=0;i<6;i++) for(const o of [-.13,.13]){ const piv=new T.Group(); piv.rotation.x=i*Math.PI/3+o; piv.position.x=sd*.148; w.add(piv);
          const sp=mesh(new T.BoxGeometry(.02,.04,R*.58), S); sp.position.z=R*.36; piv.add(sp); }
        const cap=mesh(new T.CylinderGeometry(.06,.06,.03,12), S); cap.rotation.z=Math.PI/2; cap.position.x=sd*.155; w.add(cap);
        wheels.push(w); }
      
      }
      let p=0;
      tick=(dt,m)=>{ const v=Math.min(2,m); p += dt*v;
        for(const w of wheels) w.rotation.x += dt*v*6;
        body.position.y = .02*Math.sin(p*9)*Math.min(1,v); body.rotation.z = .02*Math.sin(p*5.3)*Math.min(1,v); body.rotation.x = .012*Math.sin(p*7.1)*Math.min(1,v); }; // rough road
    }
    else if(type==="paddler"){
      const kayak=mesh(new T.SphereGeometry(1,20,12), M.accent); kayak.scale.set(.32,.16,2.2); kayak.position.y=.12; root.add(kayak);
      const H=human({legs:false}); root.add(H.root); H.pelvis.position.y=.14;
      const paddle=new T.Group(); paddle.position.set(0,.62,.28); H.torso.add(paddle);
      paddle.add(tube([-1.05,0,0],[1.05,0,0],.016,M.dark));
      for(const x of [-1.05,1.05]){ const b=mesh(new T.BoxGeometry(.03,.36,.16), M.dark); b.position.x=x; paddle.add(b); }
      H.lArm.rotation.x = H.rArm.rotation.x = -1.2; H.lFore.rotation.x = H.rFore.rotation.x = -.3;
      let p=0;
      tick=(dt,m)=>{ p += dt*1.1*2*Math.PI*Math.min(1.6,m); const s=Math.sin(p)*Math.min(1,m*1.5);
        paddle.rotation.z = .55*s; paddle.rotation.y = .35*s; H.torso.rotation.y = .3*s; };
    }
    root.traverse(o=>{ if(o.isMesh) o.frustumCulled=false; });
    return { root, tick: tick || (()=>{}) };
  }

  function create(map, kind){
    const T = window.THREE, type = KINDS[kind];
    const camera=new T.Camera(), scene=new T.Scene();
    scene.add(new T.HemisphereLight(0xffffff, 0x445066, 1.0));
    const sun=new T.DirectionalLight(0xffffff, .8); sun.position.set(.5,1,.7); scene.add(sun);
    const fig=build(type); scene.add(fig.root);
    const st={ lngLat:null, heading:null, moving:0, last:performance.now() };
    const id="rider3d-"+Math.random().toString(36).slice(2,7);
    let renderer;
    map.addLayer({ id, type:"custom", renderingMode:"3d",
      onAdd(m, gl){ renderer=new T.WebGLRenderer({ canvas:m.getCanvas(), context:gl, antialias:true }); renderer.autoClear=false; },
      render(gl, matrix){
        if(!st.lngLat) return;
        const now=performance.now(), dt=Math.min(.05,(now-st.last)/1000); st.last=now;
        fig.tick(dt, st.moving);
        const elev = map.queryTerrainElevation(st.lngLat, { exaggerated:true }) || 0;
        const mc = mapboxgl.MercatorCoordinate.fromLngLat(st.lngLat, elev);
        const lat = st.lngLat[1]*Math.PI/180, mpp = 40075016.686*Math.cos(lat)/(512*Math.pow(2, map.getZoom()));
        const s = mc.meterInMercatorCoordinateUnits() * (SCREEN_PX*mpp/1.8);
        const l = new T.Matrix4().makeTranslation(mc.x, mc.y, mc.z)
          .scale(new T.Vector3(s, -s, s))
          .multiply(new T.Matrix4().makeRotationX(Math.PI/2))
          .multiply(new T.Matrix4().makeRotationY(Math.PI - (st.heading||0)*Math.PI/180));
        camera.projectionMatrix = new T.Matrix4().fromArray(matrix).multiply(l);
        renderer.resetState(); renderer.render(scene, camera);
        if(st.moving>0.01) map.triggerRepaint();
      }
    });
    return {
      // lngLat [lng,lat]; heading in degrees clockwise from north; moving: 0 = stopped, 1 = normal pace
      update(lngLat, heading, moving){
        st.lngLat=lngLat; st.moving=moving;
        if(st.heading==null) st.heading=heading;
        else { let d=((heading-st.heading+540)%360)-180; st.heading=(st.heading+d*.15+360)%360; }
      },
      remove(){ if(map.getLayer(id)) map.removeLayer(id); }
    };
  }

  window.Rider3D = { supports: k => !!KINDS[k], load, create };
})();
