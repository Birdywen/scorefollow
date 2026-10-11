import { chromium } from '@playwright/test';
const URL='http://localhost:3000/scorefollow/';
const PDF='/home/user/scorefollow/public/chopin.pdf';
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:1280,height:800}});
await p.goto(URL,{waitUntil:'domcontentloaded'});
await p.waitForSelector('header',{timeout:30000});
const ins=p.locator('input[type="file"]');
for(let i=0;i<await ins.count();i++){const a=(await ins.nth(i).getAttribute('accept'))||'';if(a.includes('pdf')){await ins.nth(i).setInputFiles(PDF);break;}}
await p.waitForSelector('[data-testid="score-load-status"][data-has-score="true"]',{timeout:60000});
await p.waitForTimeout(1200);
await p.keyboard.press('j'); await p.waitForTimeout(400);
const box=await p.locator('#notation').first().boundingBox();
const POP='div[role="dialog"]';
const rows=[];
for(const fy of [0.45,0.6,0.75]) for(const fx of [0.15,0.35,0.55,0.75,0.9]){
  const tx=box.x+box.width*fx, ty=box.y+box.height*fy;
  await p.mouse.click(tx,ty); await p.waitForTimeout(350);
  const pop=p.locator(POP).first();
  const vis=await pop.isVisible().catch(()=>false);
  if(!vis){rows.push({fx,fy,popup:false});continue;}
  const r=await pop.boundingBox();
  const covers=tx>=r.x&&tx<=r.x+r.width&&ty>=r.y&&ty<=r.y+r.height;
  const dx=Math.max(r.x-tx,tx-(r.x+r.width),0), dy=Math.max(r.y-ty,ty-(r.y+r.height),0);
  rows.push({fx,fy,popup:true,px:Math.round(r.x),py:Math.round(r.y),pw:Math.round(r.width),ph:Math.round(r.height),covers,gap:Math.round(Math.hypot(dx,dy)),inView:r.x>=0&&r.y>=0&&r.x+r.width<=1280&&r.y+r.height<=800});
}
const shown=rows.filter(r=>r.popup);
console.log(JSON.stringify(rows));
console.log('popupShown='+shown.length+' covers='+shown.filter(r=>r.covers).length+' offscreen='+shown.filter(r=>!r.inView).length);
await p.screenshot({path:'/tmp/sweep.png'});
await b.close();
