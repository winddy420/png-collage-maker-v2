'use client';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Shuffle, Download, Video, Play, Film, Images } from 'lucide-react';

/******** Utils ********/
const sleep = (ms:number)=>new Promise(r=>setTimeout(r,ms));
function readFileAsDataURL(file:File){return new Promise<string>((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result));r.onerror=rej;r.readAsDataURL(file);});}
function loadImage(src:string){return new Promise<HTMLImageElement>((res,rej)=>{const img=new Image();img.crossOrigin='anonymous';img.onload=()=>res(img);img.onerror=rej;img.src=src;});}
function canvasFromImage(img:HTMLImageElement){const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;c.getContext('2d')!.drawImage(img,0,0);return c;}
function trimTransparent(canvas:HTMLCanvasElement,alpha=1){
  const w=canvas.width,h=canvas.height,ctx=canvas.getContext('2d')!;
  const data=ctx.getImageData(0,0,w,h).data;
  let top=0,left=0,right=w-1,bottom=h-1;
  outer: for(;top<h;top++){ for(let x=0;x<w;x++){ if(data[(top*w+x)*4+3]>alpha) break outer; } }
  outer2: for(;bottom>=top;bottom--){ for(let x=0;x<w;x++){ if(data[(bottom*w+x)*4+3]>alpha) break outer2; } }
  outer3: for(;left<w;left++){ for(let y=top;y<=bottom;y++){ if(data[(y*w+left)*4+3]>alpha) break outer3; } }
  outer4: for(;right>=left;right--){ for(let y=top;y<=bottom;y++){ if(data[(y*w+right)*4+3]>alpha) break outer4; } }
  const tw=Math.max(0,right-left+1), th=Math.max(0,bottom-top+1);
  const out=document.createElement('canvas'); out.width=tw; out.height=th;
  if(tw&&th) out.getContext('2d')!.drawImage(canvas,left,top,tw,th,0,0,tw,th);
  return { canvas: out, width: tw, height: th };
}
function shuffleInPlace<T>(arr:T[],rng=()=>Math.random()){for(let i=arr.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];}}
function seededRng(seed?:number){let x=seed||123456789;return()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return((x>>>0)/0xffffffff);};}
function canvasToBlob(c:HTMLCanvasElement,t='image/png',q?:number){return new Promise<Blob|null>(res=>c.toBlob(res,t,q));}
function slug(name:string){return (name||'image').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');}

/******** Types ********/
interface BundleItem{ id:string; img:HTMLImageElement; name:string; _trim?:{canvas:HTMLCanvasElement;width:number;height:number;} }

/******** Grid layout ********/
function computeGridLayout({items,areaW,areaH,cols,gap}:{items:BundleItem[];areaW:number;areaH:number;cols:number;gap:number;}){
  const n=items.length; if(!n) return [] as {id:string;x:number;y:number;w:number;h:number}[];
  let C = cols && cols>0 ? cols : Math.max(1, Math.round(Math.sqrt(n*(areaW/Math.max(1,areaH)))));
  C = Math.max(1,C); const R = Math.ceil(n/C);
  const cellW = Math.max(1, Math.floor((areaW - gap*(C-1))/C));
  const cellH = Math.max(1, Math.floor((areaH - gap*(R-1))/R));
  const out: {id:string;x:number;y:number;w:number;h:number}[] = [];
  for(let i=0;i<n;i++){
    const r=Math.floor(i/C), c=i%C, x=c*(cellW+gap), y=r*(cellH+gap);
    const it=items[i], iw=it?._trim?.width ?? it.img.naturalWidth ?? 1, ih=it?._trim?.height ?? it.img.naturalHeight ?? 1;
    const scale = Math.min(cellW/Math.max(1,iw), cellH/Math.max(1,ih));
    const w = Math.round(iw*scale), h = Math.round(ih*scale);
    const cx = x + Math.floor((cellW-w)/2), cy = y + Math.floor((cellH-h)/2);
    out.push({ id:it.id, x:cx, y:cy, w, h });
  }
  return out;
}

/******** Animation (renderer + recorder) ********/
const TRANSITIONS = [{id:'fade',name:'Fade'},{id:'slide',name:'Slide'},{id:'scale',name:'Scale'},{id:'wipe',name:'Wipe'}] as const;
type TransitionId = typeof TRANSITIONS[number]['id'];

function createRenderer({canvas,background,collageArea,placements,trimmed,fps,perItemMs,gapMs,transition}:{ canvas:HTMLCanvasElement;background:HTMLImageElement;collageArea:{x:number;y:number;w:number;h:number}; placements:{id:string;x:number;y:number;w:number;h:number}[]; trimmed:{id:string;ref:BundleItem}[]; fps:number; perItemMs:number; gapMs:number; transition:TransitionId; }){
  const ctx=canvas.getContext('2d')!; const W=(canvas.width=background.naturalWidth), H=(canvas.height=background.naturalHeight);
  const items = placements.map(p=>({p, t: trimmed.find(t=>t.id===p.id)})).filter(x=>x.t) as {p:any;t:any}[];
  const perFrames=Math.max(1,Math.round((perItemMs/1000)*fps)), gapFrames=Math.max(0,Math.round((gapMs/1000)*fps));
  const seg=(i:number)=> i===0? perFrames : gapFrames+perFrames;
  const totalFrames = items.reduce((a,_,i)=>a+seg(i),0);

  function drawRevealed(upto:number){
    for(let k=0;k<upto;k++){ const {p,t}=items[k];
      ctx.drawImage(t.ref._trim!.canvas,0,0,t.ref._trim!.width,t.ref._trim!.height, collageArea.x+p.x,collageArea.y+p.y,p.w,p.h);
    }
  }
  function drawCurrent(k:number,progress:number){
    const {p,t}=items[k]; ctx.save();
    if(transition==='fade'){ ctx.globalAlpha=progress; }
    else if(transition==='slide'){ ctx.translate((1-progress)*-p.w,0); }
    else if(transition==='scale'){ const s=0.6+0.4*progress; ctx.translate(collageArea.x+p.x+p.w/2,collageArea.y+p.y+p.h/2); ctx.scale(s,s); ctx.translate(-(collageArea.x+p.x+p.w/2),-(collageArea.y+p.y+p.h/2)); }
    else if(transition==='wipe'){ ctx.beginPath(); ctx.rect(collageArea.x+p.x,collageArea.y+p.y,p.w*progress,p.h); ctx.clip(); }
    ctx.drawImage(t.ref._trim!.canvas,0,0,t.ref._trim!.width,t.ref._trim!.height, collageArea.x+p.x,collageArea.y+p.y,p.w,p.h); ctx.restore();
  }
  function drawFrame(i:number){
    ctx.clearRect(0,0,W,H); ctx.drawImage(background,0,0);
    let cursor=0; for(let k=0;k<items.length;k++){ const S=seg(k), gap=k===0?0:gapFrames, reveal=perFrames;
      if(i < cursor+S){ const off=i-cursor; if(off<gap){ drawRevealed(k); } else { drawRevealed(k); const prog=(off-gap+1)/reveal; drawCurrent(k, Math.min(1,Math.max(0,prog))); } return; }
      cursor += S;
    }
    drawRevealed(items.length);
  }
  return { totalFrames, drawFrame };
}

async function recordCanvasWebM({
  canvas,
  fps = 30,
  totalFrames,
  drawFrame,
}: {
  canvas: HTMLCanvasElement;
  fps?: number;
  totalFrames: number;
  drawFrame: (i: number) => void;
}) {
  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<Blob>((resolve) => (recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }))));

  recorder.start();
  for (let i = 0; i < totalFrames; i++) {
    drawFrame(i);
    await new Promise((r) => setTimeout(r, 1000 / fps));
  }
  recorder.stop();
  return done;
}


/******** drag helpers ********/
function normalizeRect(r:any){ if(!r) return null; const w=Number.isFinite(r.w)?r.w:(Number.isFinite(r.width)?r.width:null); const h=Number.isFinite(r.h)?r.h:(Number.isFinite(r.height)?r.height:null); const x=Number.isFinite(r.x)?r.x:(Number.isFinite(r.left)?r.left:0); const y=Number.isFinite(r.y)?r.y:(Number.isFinite(r.top)?r.top:0); if(!Number.isFinite(w)||!Number.isFinite(h)) return null; return {x,y,w,h}; }
function pointInRect(px:number,py:number,r:any){ const rr=normalizeRect(r); if(!rr) return false; return px>=rr.x && py>=rr.y && px<=rr.x+rr.w && py<=rr.y+rr.h; }
function nearCorner(px:number,py:number,r:any,margin=10){ const rr=normalizeRect(r); if(!rr) return null; const cs=[{id:'nw',x:rr.x,y:rr.y},{id:'ne',x:rr.x+rr.w,y:rr.y},{id:'sw',x:rr.x,y:rr.y+rr.h},{id:'se',x:rr.x+rr.w,y:rr.y+rr.h}]; for(const c of cs){ if(Math.abs(px-c.x)<=margin && Math.abs(py-c.y)<=margin) return c.id; } return null; }

/******** Main component ********/
export default function ArtBundleStudio(){
  const [bg,setBg]=useState<HTMLImageElement|null>(null);
  const [bundle,setBundle]=useState<BundleItem[]>([]);
  const [gap,setGap]=useState(8);
  const [cols,setCols]=useState(0);
  const [seed,setSeed]=useState(()=>Math.floor(Math.random()*1e9));
  const [collageArea,setCollageArea]=useState({x:60,y:60,w:800,h:500});
  const [transition,setTransition]=useState<TransitionId>('fade');
  const [perItemMs,setPerItemMs]=useState(800);
  const [gapMs,setGapMs]=useState(150);
  const [videoBlob,setVideoBlob]=useState<Blob|null>(null);

  // NEW: toggle for exporting all singles
  const [alsoExportSingle,setAlsoExportSingle]=useState<boolean>(true);

  const mainCanvasRef=useRef<HTMLCanvasElement|null>(null);
  const animCanvasRef=useRef<HTMLCanvasElement|null>(null);

  useEffect(()=>{
    const next:BundleItem[]=[];
    for(const it of bundle){
      if(!it._trim){ it._trim = trimTransparent(canvasFromImage(it.img)); }
      next.push(it);
    }
    setBundle([...next]);
  },[bundle.length]);

  const order=useMemo(()=>{ const arr=bundle.map(b=>b.id); const rng=seededRng(seed); shuffleInPlace(arr,rng); return arr; },[bundle,seed]);

  const placements=useMemo(()=>{
    const items=order.map(id=>bundle.find(b=>b.id===id)!).filter(Boolean);
    return computeGridLayout({ items, areaW:Math.max(1,Math.floor(collageArea.w)), areaH:Math.max(1,Math.floor(collageArea.h)), cols, gap });
  },[order,bundle,collageArea.w,collageArea.h,cols,gap]);

  useEffect(()=>{
    const c=mainCanvasRef.current; if(!c||!bg) return;
    c.width=bg.naturalWidth; c.height=bg.naturalHeight;
    const ctx=c.getContext('2d')!; ctx.clearRect(0,0,c.width,c.height); ctx.drawImage(bg,0,0);
    if(placements.length){
      const byId:Record<string,BundleItem>=Object.fromEntries(bundle.map(b=>[b.id,b] as const));
      for(const p of placements){ const t=byId[p.id]?._trim; if(!t) continue;
        ctx.drawImage(t.canvas,0,0,t.width,t.height, collageArea.x+p.x,collageArea.y+p.y,p.w,p.h);
      }
    }
    // boundary (preview only)
    ctx.save(); ctx.strokeStyle='rgba(168,85,247,0.85)'; ctx.lineWidth=2; ctx.strokeRect(collageArea.x,collageArea.y,collageArea.w,collageArea.h); ctx.restore();
  },[bg,bundle,placements,collageArea.x,collageArea.y,collageArea.w,collageArea.h]);

  const addBackground=async(file:File)=>{
    const url=await readFileAsDataURL(file); const img=await loadImage(url); setBg(img);
    const w=img.naturalWidth,h=img.naturalHeight, areaW=Math.round(w*0.7), areaH=Math.round(h*0.5);
    setCollageArea({ x:Math.round((w-areaW)/2), y:Math.round((h-areaH)/2), w:areaW, h:areaH });
  };
  const addBundle=async(files:FileList)=>{
    const next:BundleItem[]=[];
    for(const f of Array.from(files)){ const url=await readFileAsDataURL(f); const img=await loadImage(url); next.push({ id:`${Date.now()}_${Math.random().toString(36).slice(2)}`, img, name:f.name }); }
    setBundle(b=>[...b,...next]);
  };

  const randomize=()=>setSeed(Math.floor(Math.random()*1e9));
  const resetBundle=()=>setBundle([]);

  // export helpers
  function drawCollageBase(ctx:CanvasRenderingContext2D){
    if(!bg) return;
    ctx.clearRect(0,0,bg.naturalWidth,bg.naturalHeight);
    ctx.drawImage(bg,0,0);
  }
  function drawAllPlacements(ctx:CanvasRenderingContext2D){
    const byId:Record<string,BundleItem>=Object.fromEntries(bundle.map(b=>[b.id,b] as const));
    for(const p of placements){
      const t=byId[p.id]?._trim; if(!t) continue;
      ctx.drawImage(t.canvas,0,0,t.width,t.height, collageArea.x+p.x,collageArea.y+p.y,p.w,p.h);
    }
  }
  function drawSingleInFrame(ctx:CanvasRenderingContext2D, it:BundleItem){
    if(!bg || !it._trim) return;
    // place trimmed image inside the FR (collageArea) with "contain"
    const FR = collageArea;
    const r = it._trim.width / Math.max(1, it._trim.height);
    let dw = FR.w, dh = FR.h;
    if(dw / dh > r) dw = Math.round(dh * r); else dh = Math.round(dw / r);
    const dx = Math.round(FR.x + (FR.w - dw)/2);
    const dy = Math.round(FR.y + (FR.h - dh)/2);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(it._trim.canvas, 0,0,it._trim.width,it._trim.height, dx,dy,dw,dh);
  }

  const downloadCollage=async()=>{
    if(!bg) return;
    const { default: saveAs } = await import('file-saver');
    // 1) collage (รวม)
    const off=document.createElement('canvas'); off.width=bg.naturalWidth; off.height=bg.naturalHeight;
    const oc=off.getContext('2d')!; drawCollageBase(oc); drawAllPlacements(oc);
    const blob=await canvasToBlob(off,'image/png'); if(blob) saveAs(blob,'cover_collage.png');

    // 2) ถ้าติ๊กไว้ → export รูปเดี่ยว "ทุกภาพ" ใน bundle
    if(alsoExportSingle){
      const byId:Record<string,BundleItem>=Object.fromEntries(bundle.map(b=>[b.id,b] as const));
      for(let i=0;i<order.length;i++){
        const it = byId[order[i]];
        if(!it || !it._trim) continue;
        const c=document.createElement('canvas'); c.width=bg.naturalWidth; c.height=bg.naturalHeight;
        const cx=c.getContext('2d')!; drawCollageBase(cx); drawSingleInFrame(cx, it);
        const sblob=await canvasToBlob(c,'image/png');
        if(sblob){
          const base = slug(it.name) || `img-${i+1}`;
          saveAs(sblob, `single_${String(i+1).padStart(2,'0')}_${base}.png`);
          // เลี่ยง browser block ดาวน์โหลดซ้อน: หน่วงนิดหน่อย
          await sleep(80);
        }
      }
    }
  };

const renderVideo = async () => {
  if (!bg || placements.length === 0) return;
  const c = animCanvasRef.current!;
  c.width = bg.naturalWidth;
  c.height = bg.naturalHeight;

  const fps = 30;
  const items = order.map((id) => bundle.find((b) => b.id === id)!).filter(Boolean);
  const trimmed = items.map((it) => ({ id: it.id, ref: it })).filter((x) => x.ref?._trim);

  const renderer = createRenderer({
    canvas: c,
    background: bg,
    collageArea,
    placements,
    trimmed,
    fps,
    perItemMs,
    gapMs,
    transition,
  });

  const tailFrames = Math.round(fps * 0.5);
  const totalFrames = renderer.totalFrames + tailFrames;

  const webm = await recordCanvasWebM({
    canvas: c,
    fps,
    totalFrames,
    drawFrame: (i) => {
      const idx = Math.min(i, renderer.totalFrames - 1);
      renderer.drawFrame(idx);
    },
  });

  setVideoBlob(webm);
};

  const downloadVideo=async()=>{
    if(!videoBlob) await renderVideo();
    const { default: saveAs } = await import('file-saver');
    const b=videoBlob; if(b) saveAs(b,'cover_animation.webm');
  };
  const downloadAll=async()=>{
    const [{ default: JSZip }, { default: saveAs }] = await Promise.all([import('jszip'), import('file-saver')]);
    const zip = new JSZip();
    if(bg){
      // collage.png
      const off=document.createElement('canvas'); off.width=bg.naturalWidth; off.height=bg.naturalHeight;
      const oc=off.getContext('2d')!; drawCollageBase(oc); drawAllPlacements(oc);
      const collageBlob=await canvasToBlob(off,'image/png'); if(collageBlob) zip.file('cover_collage.png',collageBlob);

      // singles for ALL images (if toggled)
      if(alsoExportSingle){
        const byId:Record<string,BundleItem>=Object.fromEntries(bundle.map(b=>[b.id,b] as const));
        for(let i=0;i<order.length;i++){
          const it = byId[order[i]]; if(!it || !it._trim) continue;
          const c=document.createElement('canvas'); c.width=bg.naturalWidth; c.height=bg.naturalHeight;
          const cx=c.getContext('2d')!; drawCollageBase(cx); drawSingleInFrame(cx, it);
          const sblob=await canvasToBlob(c,'image/png');
          if(sblob){
            const base = slug(it.name) || `img-${i+1}`;
            zip.file(`single_${String(i+1).padStart(2,'0')}_${base}.png`, sblob);
          }
        }
      }
    }
    if(!videoBlob) await renderVideo();
    if(videoBlob) zip.file('cover_animation.webm', videoBlob);
    const content=await zip.generateAsync({ type:'blob' });
    saveAs(content,'artbundle_export.zip');
  };

  // drag / resize
  const dragState=useRef<null | { startX:number; startY:number; mode:string; startBox:{x:number;y:number;w:number;h:number;} }>(null);
  const onDown=(e:React.MouseEvent<HTMLCanvasElement>)=>{
    if(!bg) return; const c=mainCanvasRef.current!; const rect=c.getBoundingClientRect();
    const sx=c.width/rect.width, sy=c.height/rect.height; const x=(e.clientX-rect.left)*sx, y=(e.clientY-rect.top)*sy;
    const corner=nearCorner(x,y,collageArea,10); const inside=pointInRect(x,y,collageArea);
    if(!corner && !inside) return; dragState.current={ startX:x, startY:y, mode:corner||'move', startBox:{...collageArea} };
  };
  const onMove=(e:React.MouseEvent<HTMLCanvasElement>)=>{
    if(!dragState.current) return; const c=mainCanvasRef.current!; const rect=c.getBoundingClientRect(); const sx=c.width/rect.width, sy=c.height/rect.height; const x=(e.clientX-rect.left)*sx, y=(e.clientY-rect.top)*sy;
    const { mode, startX, startY, startBox } = dragState.current; let { x:bx, y:by, w:bw, h:bh } = startBox; const dx=x-startX, dy=y-startY;
    if(mode==='move'){ bx+=dx; by+=dy; } else { if(mode.includes('w')){ bx+=dx; bw-=dx; } if(mode.includes('e')){ bw+=dx; } if(mode.includes('n')){ by+=dy; bh-=dy; } if(mode.includes('s')){ bh+=dy; } }
    bx=Math.max(0,Math.min(bx,c.width-20)); by=Math.max(0,Math.min(by,c.height-20)); bw=Math.max(20,Math.min(bw,c.width-bx)); bh=Math.max(20,Math.min(bh,c.height-by));
    setCollageArea({ x:Math.round(bx), y:Math.round(by), w:Math.round(bw), h:Math.round(bh) });
  };
  const onUp=()=>{ dragState.current=null; };

  return (
    <div className="min-h-screen bg-[#0f0b1e] text-purple-100">
      <header className="p-4 md:p-6 border-b border-purple-900 bg-[#1a1133] sticky top-0 z-30">
        <div className="max-w-6xl mx-auto flex items-center gap-3">
          <img src="/windsoft-logo.png" alt="Windsoft" className="w-7 h-7" />
          <h1 className="text-xl md:text-2xl font-bold text-purple-200">Windsoft - ArtBundle Studio</h1>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4 md:p-6 space-y-6">
        <div className="bg-[#1c1436] rounded-2xl shadow p-4 md:p-6 border border-purple-900">
          <div className="grid md:grid-cols-3 gap-4">
            <div className="space-y-3">
              <label className="block text-sm font-medium text-purple-200">พื้นหลัง (PNG/JPG)</label>
              <input type="file" accept="image/*" onChange={(e)=> e.target.files?.[0] && addBackground(e.target.files[0])} className="cursor-pointer"/>

              <div className="grid grid-cols-2 gap-3 mt-2">
                <div>
                  <label className="block text-xs text-purple-300">Grid Columns (0 = auto)</label>
                  <input type="number" className="w-full border border-purple-700 bg-[#0f0b1e] text-purple-200 rounded px-2 py-1" value={cols} onChange={(e)=> setCols(Math.max(0, Number(e.target.value)||0))} />
                </div>
                <div>
                  <label className="block text-xs text-purple-300">ช่องไฟ (px)</label>
                  <input type="number" className="w-full border border-purple-700 bg-[#0f0b1e] text-purple-200 rounded px-2 py-1" value={gap} onChange={(e)=> setGap(Math.max(0, Number(e.target.value)||0))} />
                </div>
              </div>

              <div className="mt-2 flex items-center gap-2">
                <input id="alsoSingle" type="checkbox" checked={alsoExportSingle} onChange={(e)=> setAlsoExportSingle(e.target.checked)} />
                <label htmlFor="alsoSingle" className="text-xs text-purple-300">Also export single image in frame (all)</label>
              </div>

              <div className="grid grid-cols-2 gap-3 mt-2">
                <div>
                  <label className="block text-xs text-purple-300">Transition</label>
                  <select className="w-full border border-purple-700 bg-[#0f0b1e] text-purple-200 rounded px-2 py-1" value={transition} onChange={(e)=> setTransition(e.target.value as TransitionId)}>
                    {TRANSITIONS.map(t=> <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-purple-300">ms/ภาพ</label>
                  <input type="number" className="w-full border border-purple-700 bg-[#0f0b1e] text-purple-200 rounded px-2 py-1" value={perItemMs} onChange={(e)=> setPerItemMs(Math.max(100, Number(e.target.value)||800))} />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 mt-2">
                <div>
                  <label className="block text-xs text-purple-300">ช่องว่าง (ms)</label>
                  <input type="number" className="w-full border border-purple-700 bg-[#0f0b1e] text-purple-200 rounded px-2 py-1" value={gapMs} onChange={(e)=> setGapMs(Math.max(0, Number(e.target.value)||150))} />
                </div>
              </div>

              <div className="mt-2 flex gap-2 flex-wrap">
                <button onClick={randomize} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-purple-700 hover:bg-purple-800 bg-[#2a1d4d] text-purple-100"><Shuffle className="w-4 h-4"/> Randomize</button>
                <button onClick={resetBundle} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-red-700 hover:bg-red-800 bg-[#3a1020] text-red-100">Reset Bundle</button>
              </div>

              <div className="mt-4">
                <label className="block text-sm font-medium text-purple-200">เพิ่มไฟล์ bundle (PNG โปร่งใส หลายไฟล์ได้)</label>
                <input multiple type="file" accept="image/png" onChange={(e)=> e.target.files?.length && addBundle(e.target.files)} className="cursor-pointer"/>
                {bundle.length>0 && (<div className="text-xs text-purple-400 mt-1">รวม {bundle.length} ไฟล์</div>)}
              </div>
            </div>

            <div className="md:col-span-2">
              {!bg && (<div className="h-64 rounded-xl border-2 border-dashed border-purple-700 grid place-items-center text-purple-500">อัปโหลดพื้นหลังเพื่อเริ่มตั้งพื้นที่คอลลาจ</div>)}
              {bg && (
                <div className="relative">
                  <canvas ref={mainCanvasRef} className="w-full rounded-xl border border-purple-700" onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} />
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="bg-[#1c1436] rounded-2xl shadow p-4 md:p-6 border border-purple-900">
          <div className="grid md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <button onClick={renderVideo} disabled={!bg || placements.length===0} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-purple-700 hover:bg-purple-800 bg-[#2a1d4d] text-purple-100"><Play className="w-4 h-4"/> Render Video</button>
              {videoBlob && (
                <a className="inline-flex items-center gap-2 text-purple-300 underline" href={URL.createObjectURL(videoBlob)} download={'cover_animation.webm'}>
                  <Video className="w-4 h-4"/> ดาวน์โหลดวิดีโอ (.webm)
                </a>
              )}
              <div className="text-xs text-purple-400">วิดีโอเป็น WebM; ถ้าต้องการ MP4 แนะนำแปลงภายนอก</div>
            </div>
            <div className="md:col-span-2">
              <canvas ref={animCanvasRef} className="w-full rounded-xl border border-purple-700" />
            </div>
          </div>
        </div>

        <div className="bg-[#1c1436] rounded-2xl shadow p-4 md:p-6 border border-purple-900">
          <div className="flex flex-wrap gap-3">
            <button onClick={downloadCollage} disabled={!bg || bundle.length===0} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-purple-700 bg-[#2a1d4d] text-purple-100"><Images className="w-4 h-4"/> Download Collage</button>
            <button onClick={downloadVideo} disabled={!bg || placements.length===0} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-purple-700 bg-[#2a1d4d] text-purple-100"><Film className="w-4 h-4"/> Download Video</button>
            <button onClick={downloadAll} disabled={!bg || bundle.length===0} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-purple-800 text-white hover:bg-purple-700"><Download className="w-4 h-4"/> Download All as ZIP</button>
          </div>
        </div>
      </main>
    </div>
  );
}
