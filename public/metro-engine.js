(function(){
function boot(){
  if (window.__sgaMetro) return;
  if (typeof document === 'undefined' || !document.body) { return setTimeout(boot, 200); }
  var host = document.getElementById('notation');
  if (!host) { return setTimeout(boot, 200); }
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  var scroller = host;
  var PAGE_H = 2080;
  var B = [];

  // ===== 配色预设 (蓝绿红黄紫) =====
  var COLORS = {
    blue:   {g1:'0,224,255',  g2:'0,150,255',  glow:'0,200,255',  bd:'120,235,255'},
    green:  {g1:'80,255,140', g2:'0,200,90',   glow:'40,255,120', bd:'140,255,170'},
    red:    {g1:'255,120,120',g2:'255,40,60',  glow:'255,80,90',  bd:'255,160,160'},
    yellow: {g1:'255,230,90', g2:'255,190,0',  glow:'255,210,40', bd:'255,235,150'},
    purple: {g1:'200,140,255',g2:'150,60,255', glow:'180,90,255', bd:'215,170,255'}

  };

  // ===== 节拍器音色预设 (改动1) =====
  var SOUND_PRESETS = {
    wood:    { hi:1760, lo:1100, wave:'triangle', decay:0.09, volHi:0.6,  volLo:0.35 },
    clave:   { hi:2200, lo:1400, wave:'square',   decay:0.06, volHi:0.45, volLo:0.25 },
    beep:    { hi:1200, lo:880,  wave:'sine',     decay:0.12, volHi:0.5,  volLo:0.3 },
    digital: { hi:1500, lo:1000, wave:'sawtooth', decay:0.05, volHi:0.35, volLo:0.2 },
    snare:   { hi:2000, lo:800,  wave:'square',   decay:0.04, volHi:0.4,  volLo:0.25 }

  };

  // ===== i18n 中英双语表 (改动2) =====
  var I18N = {
    en: {
      title:'Practice Metronome', play:'▶ Play', stop:'■ Stop', start:'⏮ Start', gotobar:'Go to bar', end:'End ⏭',
      meter:'Meter', color:'Color', blue:'Blue', green:'Green', red:'Red', yellow:'Yellow', purple:'Purple',
      bg:'Background', normal:'Normal', sepia:'Sepia', softgray:'Soft gray', night:'Night', parch:'Parchment',
      sound:'Sound', wood:'Wood', clave:'Clave', beep:'Beep', digital:'Digital', snare:'Snare',
      barnums:'Bar nums', opacity:'Opacity', followy:'Follow Y', countin:'Count-in', sequence:'Sequence',
      metermap:'Meter map (bar:beats, 变拍号)', skipbars:'Skip bars (误判小节, 填当前显示号)',
      loop:'Loop', frombar:'From bar', tobar:'To bar', repeat:'Repeat', inf:'(0=inf)',
      hint:'L/R: beat · U/D: bar · space: play', ready:'ready',
      seq_ph:'e.g. 1-4, 1-4, 5-12',
      mm_ph:'例 1:4, 17:3, 33:6',
      skip_ph:'例 23 或 23, 41',
      lang_btn:'中'  // 显示对方语言
    },
    zh: {
      title:'练习节拍器', play:'▶ 播放', stop:'■ 停止', start:'⏮ 开始', gotobar:'跳至小节', end:'结束 ⏭',
      meter:'拍号', color:'配色', blue:'蓝', green:'绿', red:'红', yellow:'黄', purple:'紫',
      bg:'背景', normal:'正常', sepia:'怀旧', softgray:'柔灰', night:'夜间', parch:'羊皮纸',
      sound:'音色', wood:'木鱼', clave:'响木', beep:'滴声', digital:'数字', snare:'军鼓',
      barnums:'小节号', opacity:'透明度', followy:'高亮位置', countin:'预备拍', sequence:'序列',
      metermap:'变拍号(小节:拍数)', skipbars:'跳过小节(误判,填显示号)',
      loop:'循环', frombar:'起始', tobar:'结束', repeat:'重复', inf:'(0=无限)',
      hint:'L/R:拍 · U/D:小节 · 空格:播放', ready:'就绪',
      seq_ph:'例 1-4, 1-4, 5-12',
      mm_ph:'例 1:4, 17:3, 33:6',
      skip_ph:'例 23 或 23, 41',
      lang_btn:'EN'
    }
  };
  function L(k){ var t=I18N[st.lang]||I18N.en; return t[k]!==undefined?t[k]:(I18N.en[k]||k); }
  // applyLang: 根据 st.lang 覆盖 panel 各元素文字 (不改 innerHTML 默认英文结构)
  // 统一播放按钮文案(走 i18n, 不再硬编码)
  function setPlayBtn(playing){
    var b=document.getElementById('sgPlay');
    if(b) b.textContent = playing ? L('stop') : L('play');
    // 向 React 走带按钮广播播放状态(挂载时也会触发一次, 顺带宣告可用)
    try{ window.dispatchEvent(new CustomEvent('synpdf:metro-state', { detail: { playing: !!playing } })); }catch(e){}
  }
  function applyLang(){
    var map = {
      'sgTitle':'title','sgStart':'start','sgGotoLbl':'gotobar','sgEnd':'end',
      'sgMeterLbl':'meter','sgColorLbl':'color','sgBgLbl':'bg','sgSoundLbl':'sound','sgBarnumLbl':'barnums',
      'sgOpacLbl':'opacity','sgFollowLbl':'followy','sgCntLbl':'countin','sgSeqLbl':'sequence','sgMeterMapLbl':'metermap',
      'sgSkipLbl':'skipbars','sgLoopLbl':'loop','sgFromLbl':'frombar','sgToLbl':'tobar','sgRepeatLbl':'repeat',
      'sgInfLbl':'inf','sgHint':'hint','sgLangBtn':'lang_btn'
    };
    for(var id in map){
      var el=document.getElementById(id);
      if(el){
        if(id==='sgStart') el.textContent=L('start');
        else if(id==='sgEnd') el.textContent=L('end');
        else if(id==='sgLangBtn') el.textContent=L('lang_btn');
        else if(el.tagName==='SPAN'||el.tagName==='DIV'||el.tagName==='B'||el.tagName==='LABEL') el.textContent=L(map[id]);
      }
    }
    setPlayBtn(st.playing);
    // option 文字 (select)
    var optMap = {
      'sgColor':{blue:'blue',green:'green',red:'red',yellow:'yellow',purple:'purple'},
      'sgBg':{none:'normal',sepia:'sepia',gray:'softgray',night:'night',parch:'parch'},
      'sgSound':{wood:'wood',clave:'clave',beep:'beep',digital:'digital',snare:'snare'}
    };
    for(var sid in optMap){
      var sel=document.getElementById(sid); if(!sel)continue;
      for(var i=0;i<sel.options.length;i++){
        var ov=sel.options[i].value, kv=optMap[sid][ov];
        if(kv) sel.options[i].text=L(kv);
      }
    }
    // placeholder
    var phMap={'sgSeq':'seq_ph','sgMeterMap':'mm_ph','sgSkip':'skip_ph'};
    for(var pid in phMap){ var pe=document.getElementById(pid); if(pe) pe.placeholder=L(phMap[pid]); }
  }

  var st = { raf:null, iSeq:0, playing:false, bpm:66, audio:null,
             loopOn:false, loopFrom:1, loopTo:38, loopN:4, loopLeft:0, s0:0,
             color:'blue', opacity:0.28, followY:0.30, meter:4, countIn:0, seqText:'', meterMap:null, skipBars:null, sound:'wood', showBarnums:true, lang:'en',
             planSlot:1, planSlots:null, planStorageKey:null };
  window.__sgaMetro = st;
  // 返回某小节生效的拍数: 查 meterMap(取<=该小节的最近一次设定), 无则回退全局 st.meter
  function metersFor(measure){
    // 例外语义: map里明写的小节才用指定拍号, 其余全部回退全局 st.meter
    var mm=st.meterMap; if(!mm) return st.meter;
    return (mm[measure]!=null) ? mm[measure] : st.meter;
  }

  function renderedCanvasSize(canvas){
    if(!canvas) return {width:0,height:0};
    var rect=canvas.getBoundingClientRect?canvas.getBoundingClientRect():null;
    return {
      width:(rect&&rect.width)||canvas.offsetWidth||canvas.clientWidth||0,
      height:(rect&&rect.height)||canvas.offsetHeight||canvas.clientHeight||0
    };
  }
  function buildB(MA){
    var pages=MA.slice(1), out=[], measure=0, raw=0;
    var SK=st.skipBars||{};
    var baseWidth=Number(MA[0])>0?Number(MA[0]):0;
    // metric_arr coordinates belong to its saved base width. Map every page to
    // the real CSS canvas size so Metro remains correct during responsive and
    // fullscreen renders, including the short transition before metric refresh.
    var cvs=host.getElementsByTagName('canvas');
    // 权威坐标空间 = #notation 内容坐标系 (与 shade / barnum 的 absolute 定位同源,
    // 也与点击换算同源). 不再假设画布从 0,0 无缝平铺.
    var pageYoff=[], pageXoff=[], pageScale=[], acc=0;
    for(var qi=0;qi<pages.length;qi++){
      var cv=cvs[qi];
      var size=renderedCanvasSize(cv);
      var scale=baseWidth&&size.width?size.width/baseWidth:1;
      pageXoff[qi]=cv?cv.offsetLeft:0;
      pageYoff[qi]=cv?cv.offsetTop:acc;
      pageScale[qi]=scale;
      acc+=size.height||PAGE_H*scale;
    }
    for(var pi=0;pi<pages.length;pi++){
      var pg=pages[pi]; if(!pg||!pg.bxs) continue;
      var yoff=pageYoff[pi], xoff=pageXoff[pi], scale=pageScale[pi], bxs=pg.bxs, cxs=pg.cxs;
      for(var ri=0;ri<bxs.length;ri++){
        var row=bxs[ri], cs=(cxs[ri]&&cxs[ri].cs)||[];
        var yTop=(cs.length?Math.min.apply(null,cs)*scale:0)+yoff;
        var yBot=(cs.length?Math.max.apply(null,cs)*scale:0)+yoff;
        for(var bi=0;bi<row.length-1;bi++){
          var bL=xoff+row[bi]*scale, bR=xoff+row[bi+1]*scale, bw=bR-bL; raw++;
          if(SK[raw]){ continue; }
          measure++;
          var BT=metersFor(measure);
          for(var bt=0;bt<BT;bt++){
            var x=bL+bw*(bt+0.5)/BT;
            out.push([out.length, x, yTop, yBot, measure, bt+1, bL, bR]);
          }
        }
      }
    }
    return out;
  }
  function readMetric(){
    var pre=document.querySelector('#div2 > pre');
    if(!pre) return null;
    var t=pre.textContent;
    var m=t.match(/metric_arr\s*=\s*(\[[\s\S]*?\]);/);
    if(!m) return null;
    try{ return JSON.parse(m[1]); }catch(e){ return null; }
  }
  function loadFromPre(cb){
    // SynPDF generates the current device-scaled metric through #show.
    // Keep that proven path, but suppress and close the Save Preload dialog.
    var btn=document.getElementById('show');
    var dlg=document.getElementById('saveDlg');
    var oldVisibility=dlg?dlg.style.visibility:'';
    var oldPointerEvents=dlg?dlg.style.pointerEvents:'';
    if(dlg){ dlg.style.visibility='hidden'; dlg.style.pointerEvents='none'; }
    if(btn) btn.click();
    var tries=0;
    function restoreDialog(){
      if(!dlg) return;
      dlg.style.display='none';
      dlg.style.visibility=oldVisibility;
      dlg.style.pointerEvents=oldPointerEvents;
    }
    var iv=setInterval(function(){
      tries++;
      var MA=readMetric();
      if(MA){ clearInterval(iv); restoreDialog(); st._lastMA=MA; B=buildB(MA); cb&&cb(true); }
      else if(tries>=50){ clearInterval(iv); restoreDialog(); cb&&cb(false); }
    }, 80);
  }
  // 纯参数调整(skip/meterMap)用这个: 用缓存MA重建, 不点show不弹窗
  function rebuild(){
    var MA=st._lastMA||readMetric();
    if(!MA){ loadFromPre(function(ok){ if(ok) applyData(); }); return; }
    st._lastMA=MA; B=buildB(MA); applyData();
  }

  var sty=document.createElement('style'); sty.id='sga-hide-demaat';
  sty.textContent='.demaat{opacity:0 !important;}';
  document.head.appendChild(sty);
  var sty2=document.createElement('style'); sty2.id='sga-hide-barnum';
  document.head.appendChild(sty2);
  // 修复1: 改用 textContent 动态切换 (不依赖 style.disabled 浏览器兼容性)
  // showBarnums=true -> textContent 空 -> 显示小节号; false -> display:none -> 隐藏
  function applyBarnumStyle(){
    sty2.textContent = st.showBarnums ? '' : '.sga-barnum{display:none !important;}';
  }
  applyBarnumStyle();  // 初始就调一次, 确保默认显示状态生效

  var shade = document.createElement('div'); shade.id='sga-shade';
  shade.style.cssText=['position:absolute','pointer-events:none','z-index:6000','display:none',
    'border-radius:9px',
    'transition:left 110ms ease,top 200ms ease,width 110ms ease,height 200ms ease',
    'mix-blend-mode:multiply'].join(';');
  host.appendChild(shade);
  function ensureShadeMounted(){
    var existing=document.getElementById('sga-shade');
    if(existing&&existing!==shade) existing.remove();
    if(shade.parentNode!==host) host.appendChild(shade);
  }
  // SynPDF empties #notation during every PDF rerender. Observe the
  // authoritative host directly so cursor recovery does not depend on any
  // browser-specific resize/fullscreen event or delayed render callback.
  var shadeObserver=typeof MutationObserver!=='undefined'?new MutationObserver(function(recs){
    if(shade.parentNode!==host) ensureShadeMounted();
    // 只有外部(SynPDF 重渲染)改动才触发重算; 自己插的 shade/barnum 忽略, 否则死循环
    var external=false;
    for(var i=0;i<recs.length&&!external;i++){
      var nodes=[].slice.call(recs[i].addedNodes).concat([].slice.call(recs[i].removedNodes));
      for(var j=0;j<nodes.length;j++){
        var nd=nodes[j];
        if(nd.nodeType!==1) continue;
        if(nd.id==='sga-shade') continue;
        if(nd.className&&String(nd.className).indexOf('sga-barnum')>=0) continue;
        external=true; break;
      }
    }
    if(external) scheduleRelayout();
  }):null;
  if(shadeObserver) shadeObserver.observe(host,{childList:true});
  function applyShadeStyle(){
    var c=COLORS[st.color]||COLORS.blue, op=st.opacity;
    shade.style.background='linear-gradient(180deg,rgba('+c.g1+','+op+'),rgba('+c.g2+','+(op*0.57).toFixed(3)+'))';
    shade.style.boxShadow='0 0 16px 3px rgba('+c.glow+',0.40),inset 0 0 10px rgba(255,255,255,0.22)';
    shade.style.border='1.5px solid rgba('+c.bd+',0.65)';
  }
  applyShadeStyle();

  function renderBarnums(){
    var olds=host.querySelectorAll('.sga-barnum');
    for(var k=0;k<olds.length;k++) olds[k].remove();
    for(var i=0;i<B.length;i++){ var e=B[i]; if(e[5]!==1) continue;
      var lab=document.createElement('div'); lab.className='sga-barnum'; lab.textContent=e[4];
      lab.style.cssText='position:absolute;left:'+(e[6]+2)+'px;top:'+(e[2]-20)+'px;font:600 13px sans-serif;color:#3a7bd5;pointer-events:none;z-index:5999;opacity:0.85';
      host.appendChild(lab);
    }
  }

  var lastShadeTop=null;
  var SHADE_TR='left 110ms ease,top 200ms ease,width 110ms ease,height 200ms ease';
  function place(i){
    var e=B[i]; if(!e) return;
    ensureShadeMounted();
    var pad=4;
    // 大跳(跳房子跨行, top移动>250px) -> 临时关transition瞬间到位; 小移动 -> 保留动画
    var newTop=e[2]-pad;
    var bigJump=(lastShadeTop!=null && Math.abs(newTop-lastShadeTop)>250);
    if(bigJump) shade.style.transition='none';
    shade.style.left=(e[6]-pad)+'px'; shade.style.top=newTop+'px';
    shade.style.width=(e[7]-e[6]+pad*2)+'px'; shade.style.height=(e[3]-e[2]+pad*2)+'px';
    shade.style.display='block';
    lastShadeTop=newTop;
    if(bigJump){ void shade.offsetWidth; requestAnimationFrame(function(){ shade.style.transition=SHADE_TR; }); }
    centerOn(e[2]);
    info.textContent='m'+e[4]+' beat'+e[5];
  }
  // 只摆 shade 不滚屏: metric 刷新(纠错加线/合并/调参/重载)时几何跟新, 阅读位置不动.
  // 滚屏只归 place()(播放跟随/点谱跳转)管.
  function positionShade(idx){
    var e=B[idx]; if(!e) return;
    ensureShadeMounted();
    var pad=4;
    shade.style.transition='none';
    shade.style.left=(e[6]-pad)+'px'; shade.style.top=(e[2]-pad)+'px';
    shade.style.width=(e[7]-e[6]+pad*2)+'px'; shade.style.height=(e[3]-e[2]+pad*2)+'px';
    shade.style.display='block';
    lastShadeTop=e[2]-pad;
    void shade.offsetWidth;
    requestAnimationFrame(function(){ shade.style.transition=SHADE_TR; });
  }

  // ===== 布局重算: 画布尺寸/位置变化后 B 表与叠层必须一起刷新 =====
  var __relayoutT=null;
  function relayout(){
    var MA=st._lastMA; if(!MA) return;
    B=buildB(MA);
    lastRowY=-1; lastShadeTop=null;
    if(typeof renderBarnums==='function') renderBarnums();
    positionShade(st.iSeq);
  }
  function scheduleRelayout(){ clearTimeout(__relayoutT); __relayoutT=setTimeout(relayout,120); }
  if(typeof ResizeObserver!=='undefined'){ try{ new ResizeObserver(scheduleRelayout).observe(host); }catch(e){} }
  window.addEventListener('resize',scheduleRelayout);
  window.addEventListener('orientationchange',scheduleRelayout);

  var lastRowY=-1;
  function centerOn(yTop){
    if(yTop===lastRowY) return; lastRowY=yTop;
    var vh=scroller.clientHeight;
    var target=Math.round(yTop - vh*st.followY);
    var mx=scroller.scrollHeight - vh; if(target>mx)target=mx; if(target<0)target=0;
    // 大跳(跳房子)超过一屏 -> 瞬时到位; 小幅滚动(正常播放) -> 保持丝滑
    var jump=Math.abs(target - scroller.scrollTop) > vh;
    scroller.style.scrollBehavior = jump ? 'auto' : 'smooth';
    scroller.scrollTop=target;
  }

  function click(hi){ var ac=st.audio; if(!ac)return;
    var pr = SOUND_PRESETS[st.sound] || SOUND_PRESETS.wood;
    if(st.lastOsc){ try{ st.lastOsc.stop(); }catch(e){} }
    var o=ac.createOscillator(),g=ac.createGain();
    st.lastOsc=o;
    o.type = pr.wave;
    o.frequency.value = hi ? pr.hi : pr.lo;
    g.gain.setValueAtTime(0.001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(hi ? pr.volHi : pr.volLo, ac.currentTime+0.004);
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + pr.decay);
    o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime + pr.decay + 0.01);
  }

  // ===== 序列解析: "1-4,1-4,5-12" -> [[1,4],[1,4],[5,12]]; 空 -> null =====
  function parseSeq(txt){
    if(!txt||!txt.trim()) return null;
    var segs=[], parts=txt.split(/[,;\n]+/);
    for(var i=0;i<parts.length;i++){
      var p=parts[i].trim(); if(!p) continue;
      var m=p.match(/^(\d+)\s*-\s*(\d+)$/);
      if(m){ segs.push([+m[1],+m[2]]); }
      else if(/^\d+$/.test(p)){ segs.push([+p,+p]); }
    }
    return segs.length? segs : null;
  }
  // 小节号区间 -> B表 index 区间 [s0,s1]
  function barRangeToIdx(from,to){
    var lo=Math.min(from,to), hi=Math.max(from,to), s0=-1,s1=-1;
    for(var i=0;i<B.length;i++){ if(B[i][4]>=lo&&s0<0)s0=i; if(B[i][4]<=hi)s1=i; }
    return [s0,s1];
  }
  function seqRange(){ var from=st.loopOn?st.loopFrom:1,to=st.loopOn?st.loopTo:B[B.length-1][4];
    return barRangeToIdx(from,to); }

  // ===== count-in: 空打 N 拍后调 cb; 重拍跟当前拍号(4/4 打 1+3, 3/4 打 1+2) =====
  function doCountIn(cb){
    var n=st.countIn|0;
    if(n<=0){ cb(); return; }
    var spb=60/st.bpm, i=0, BT=Math.max(1, st.meter|0);
    info.textContent='count-in '+n+'...';
    (function tick(){
      if(!st.playing){ setPlayBtn(false); return; }
      click(i%BT===0);
      i++; info.textContent='count-in '+(n-i+1);
      if(i>=n){ setTimeout(cb, spb*1000); }
      else setTimeout(tick, spb*1000);
    })();
  }

  // ===== 播放: 有序列走序列, 否则走 loop/全曲 =====
  function nowMs(){ return (typeof performance!=='undefined'&&performance.now)?performance.now():Date.now(); }
  function start(){
    // 启动瞬间 300ms 内的再次触发视为误触/连击直接吞掉, 否则首拍响一声就被自己掐停
    if(st.playing){ if(nowMs()-(st._startAt||0)<300) return; stop(); return; }
    if(!st.audio) st.audio=new (window.AudioContext||window.webkitAudioContext)();
    if(st.audio.state==='suspended') st.audio.resume();
    if(!B.length){ info.textContent='no data'; return; }
    st.playing=true;
    st._startAt=nowMs();
    setPlayBtn(true);
    var seq=parseSeq(st.seqText);
    doCountIn(function(){
      if(!st.playing) return;
      // Explicit loop mode overrides any sequence text.
      if(st.loopOn){ st._seq=null; playLoop(); } else if(seq){ playSequence(seq); } else { st._seq=null; playLoop(); }
    });
  }

  // 序列模式: 依次播放每个区间, 每段播一遍, 放完进入下一段.
  // segI0/idx0 用于播放中跳转: 从指定段/指定拍继续, 不打断 playing.
  function playSequence(seq, segI0, idx0){
    var segI=(segI0==null?0:segI0);
    st._seq=seq;
    function playSeg(startIdx){
      if(!st.playing) return;
      if(segI>=seq.length){ finishAt(0); info.textContent='sequence done'; st._seq=null; return; }
      st._segI=segI;
      var rng=barRangeToIdx(seq[segI][0], seq[segI][1]);
      var s0=rng[0], s1=rng[1];
      if(s0<0){ segI++; return playSeg(); }
      var spb=60/st.bpm, t0=performance.now(), nBeats=s1-s0+1;
      var startBeat=(startIdx!=null&&startIdx>=s0&&startIdx<=s1)?startIdx-s0:0;
      var lastBi=startBeat;
      st.iSeq=s0+startBeat; lastRowY=-1; place(st.iSeq); click(B[st.iSeq][5]===1);
      info.textContent='seq '+(segI+1)+'/'+seq.length+' (m'+seq[segI][0]+'-'+seq[segI][1]+')';
      function fr(ts){ if(!st.playing) return;
        var bi=startBeat+Math.floor((ts-t0)/1000/spb);
        if(bi>=nBeats){ segI++; return playSeg(); }
        if(bi!==lastBi){ lastBi=bi; var idx=s0+bi; st.iSeq=idx; place(idx); click(B[idx][5]===1); info.textContent='seq '+(segI+1)+'/'+seq.length+' (m'+seq[segI][0]+'-'+seq[segI][1]+')'; }
        st.raf=requestAnimationFrame(fr);
      }
      st.raf=requestAnimationFrame(fr);
    }
    playSeg(idx0);
  }

  // loop/全曲模式 (原逻辑)
  function playLoop(){
    var rng=seqRange(),s0=rng[0],s1=rng[1];
    if(s0<0){ info.textContent='bad range'; st.playing=false; setPlayBtn(false); return; }
    st.s0=s0; if(st.iSeq<s0||st.iSeq>s1) st.iSeq=s0;
    st.loopLeft=st.loopOn?(st.loopN||999999):1;
    var spb=60/st.bpm,t0=performance.now(),nBeats=s1-s0+1;
    var startBeat=st.iSeq-s0;
    var lastBi=startBeat;
    lastRowY=-1; place(st.iSeq); click(B[st.iSeq][5]===1);
    function fr(ts){ if(!st.playing) return;
      var bi=startBeat+Math.floor((ts-t0)/1000/spb);
      if(bi>=nBeats){ if(st.loopOn){ st.loopLeft--;
          if(st.loopLeft<=0){ finishAt(s0); return; }
          t0=performance.now(); lastBi=0; lastRowY=-1; startBeat=0; st.iSeq=s0; place(s0); click(B[s0][5]===1);
          st.raf=requestAnimationFrame(fr); return;
        } else { finishAt(s0); return; } }
      if(bi!==lastBi){ lastBi=bi; var idx=s0+bi; st.iSeq=idx; place(idx); click(B[idx][5]===1); }
      st.raf=requestAnimationFrame(fr);
    }
    st.raf=requestAnimationFrame(fr);
  }
  function finishAt(s0){ st.playing=false; if(st.raf)cancelAnimationFrame(st.raf);
    setPlayBtn(false); st.iSeq=s0; st._seq=null; lastRowY=-1; place(s0); }
  function stop(){ st.playing=false; if(st.raf)cancelAnimationFrame(st.raf);
    setPlayBtn(false); st._seq=null; info.textContent='stopped'; }

  // 播放中跳转: 方向键/点谱/外部事件调用, 不停 playing, 从目标拍继续
  function jumpTo(idx){
    if(!B.length) return;
    idx=Math.max(0,Math.min(B.length-1,idx));
    if(st.raf) cancelAnimationFrame(st.raf);
    st.iSeq=idx; lastRowY=-1; place(idx); click(B[idx][5]===1);
    if(!st.playing) return;
    if(st._seq){
      var m=B[idx][4], seq=st._seq, si=(st._segI==null?0:st._segI), found=false;
      for(var k=0;k<seq.length;k++){ var lo=Math.min(seq[k][0],seq[k][1]), hi=Math.max(seq[k][0],seq[k][1]); if(m>=lo&&m<=hi){ si=k; found=true; break; } }
      if(!found) si=Math.max(0,Math.min(seq.length-1,si));
      playSequence(seq, si, found?idx:undefined);
    } else {
      var left=st.loopLeft; playLoop(); if(st.loopOn&&left!=null) st.loopLeft=left;
    }
  }

  function barFirst(i){ var m=B[i][4],j=i; while(j>0&&B[j-1][4]===m)j--; return j; }

  // 点小节暖机重起(触屏练习用): 停→定位→走 count-in→从该位置开播.
  // _startAt 清零绕过 300ms 防连击窗, 蓄意重起永远生效.
  // 顶层定义: 控制 API/外部事件/host 点谱共用(面板内 gotoBar 另有作用域).
  function restartFromIdx(idx){
    if(!B.length) return;
    idx=Math.max(0,Math.min(B.length-1,idx));
    st._startAt=0;
    if(st.playing) stop();
    st.iSeq=idx; lastRowY=-1; place(idx);
    start(); // count-in 本身就是起拍提示, 不再多响一声试音
  }
  function restartAtMeasure(m){
    if(!B.length) return;
    var mx=Math.max(1,Math.min(maxM,m||1)), idx=-1;
    for(var i=0;i<B.length;i++){ if(B[i][4]===mx){ idx=barFirst(i); break; } }
    if(idx<0) idx=0;
    restartFromIdx(idx);
  }


  // ===== Four isolated playback plans: Score + three temporary practice plans =====
  var __planReady=false, __planSaveTimer=null;
  function clonePlan(value){ return value==null?null:JSON.parse(JSON.stringify(value)); }
  function capturePlan(){
    return {version:1,bpm:st.bpm,meter:st.meter,countIn:st.countIn,seqText:st.seqText||'',
      meterMap:clonePlan(st.meterMap),skipBars:clonePlan(st.skipBars),loopOn:!!st.loopOn,
      loopFrom:st.loopFrom,loopTo:st.loopTo,loopN:st.loopN,sound:st.sound};
  }
  function planFingerprint(){
    var MA=st._lastMA, parts=[location.pathname,location.search];
    if(MA&&MA.length>1){
      parts.push(MA[0],MA.length);
      for(var p=1;p<MA.length;p++){
        var page=MA[p], rows=page&&page.bxs||[];
        parts.push(rows.length);
        for(var r=0;r<rows.length;r++) parts.push(rows[r].length,rows[r][0],rows[r][rows[r].length-1]);
      }
    }else parts.push(B.length,B.length?B[B.length-1][4]:0);
    var text=parts.join('|'), hash=2166136261;
    for(var i=0;i<text.length;i++){ hash^=text.charCodeAt(i); hash=Math.imul(hash,16777619); }
    return (hash>>>0).toString(36);
  }
  function persistPlans(){
    if(!__planReady||!st.planStorageKey) return;
    try{ localStorage.setItem(st.planStorageKey,JSON.stringify({schema:'sga.playback-plans.v1',slots:st.planSlots})); }catch(e){}
  }
  function saveCurrentPlan(){
    if(!__planReady||!st.planSlots) return;
    st.planSlots[st.planSlot-1]=capturePlan();
    persistPlans();
    renderPlanSlots();
  }
  function schedulePlanSave(){
    if(!__planReady) return;
    if(__planSaveTimer) clearTimeout(__planSaveTimer);
    __planSaveTimer=setTimeout(saveCurrentPlan,120);
  }
  function mapText(map,separator){
    if(!map) return '';
    return Object.keys(map).sort(function(a,b){return a-b;}).map(function(key){return separator?key+':'+map[key]:key;}).join(', ');
  }
  function applyPlan(plan){
    if(!plan) return;
    if(st.playing) stop();
    st.bpm=+plan.bpm||st.bpm;
    st.meter=+plan.meter||st.meter;
    st.countIn=Math.max(0,+plan.countIn||0);
    st.seqText=plan.seqText||'';
    st.meterMap=clonePlan(plan.meterMap);
    st.skipBars=clonePlan(plan.skipBars);
    st.loopOn=!!plan.loopOn;
    st.loopFrom=+plan.loopFrom||1;
    st.loopTo=+plan.loopTo||maxM;
    st.loopN=plan.loopN==null?4:+plan.loopN;
    st.sound=plan.sound||st.sound;
    function set(id,value){var el=document.getElementById(id);if(el)el.value=value;}
    set('sgBpm',st.bpm); var bpmv=document.getElementById('sgBpmV');if(bpmv)bpmv.textContent=st.bpm;
    if(typeof renderTempo==='function'){ try{ renderTempo(); }catch(e){} }
    set('sgMeter',st.meter);set('sgCnt',st.countIn);set('sgSeq',st.seqText);
    set('sgMeterMap',mapText(st.meterMap,true));set('sgSkip',mapText(st.skipBars,false));
    var loop=document.getElementById('sgLoop');if(loop)loop.checked=st.loopOn;
    set('sgFrom',st.loopFrom);set('sgTo',st.loopTo);set('sgN',st.loopN);set('sgSound',st.sound);
    rebuild();
  }
  function renderPlanSlots(){
    var buttons=document.querySelectorAll('.sga-plan-slot');
    for(var i=0;i<buttons.length;i++){
      var active=+(buttons[i].getAttribute('data-slot'))===st.planSlot;
      buttons[i].style.background=active?'#0a84ff':'transparent';
      buttons[i].style.color=active?'#fff':'';
      buttons[i].style.fontWeight=active?'800':'600';
    }
  }
  function selectPlan(slot){
    slot=Math.max(1,Math.min(4,+slot||1));
    if(!__planReady) return;
    saveCurrentPlan();
    if(!st.planSlots[slot-1]) st.planSlots[slot-1]=clonePlan(st.planSlots[0]||capturePlan());
    st.planSlot=slot;
    applyPlan(clonePlan(st.planSlots[slot-1]));
    persistPlans();
    renderPlanSlots();
    if(info) info.textContent=(slot===1?'score plan':'practice plan '+String.fromCharCode(63+slot));
  }
  function bindPlanSlots(){
    var buttons=document.querySelectorAll('.sga-plan-slot');
    for(var i=0;i<buttons.length;i++) buttons[i].onclick=function(){selectPlan(this.getAttribute('data-slot'));};
    renderPlanSlots();
  }
  function initPlanSlots(){
    if(__planReady) return;
    st.planStorageKey='sga_playback_plans_v1:'+planFingerprint();
    var saved=null;
    try{ saved=JSON.parse(localStorage.getItem(st.planStorageKey)||'null'); }catch(e){}
    var scorePlan=capturePlan();
    st.planSlots=[scorePlan,null,null,null];
    if(saved&&saved.schema==='sga.playback-plans.v1'&&Array.isArray(saved.slots)){
      for(var i=1;i<4;i++) st.planSlots[i]=clonePlan(saved.slots[i]||null);
    }
    st.planSlot=1;
    __planReady=true;
    persistPlans();
    bindPlanSlots();
  }

  // ===== 方向键导航 / Metro 独占空格 =====
  // Use window capture: SynPDF owns a body bubble listener, so Metro must stop
  // the event before it can reach SynPDF whenever Metro is loaded.
  // 语义: ←/→ 按小节跳(同行内换小节, 到头顺延) · ↑/↓ 按行跳 ·
  // 播放中跳转不停止, 从目标拍继续; 未播放时只移动头 + 试音.
  function __metroKeydown(ev){
    var target=ev.target, tn=(target&&target.tagName)||'';
    if(['INPUT','SELECT','TEXTAREA','BUTTON'].indexOf(tn)>=0||(target&&target.isContentEditable)) return;
    if(document.querySelector('[data-editing="true"]')) return;  // annotation editing owns arrow keys
    if(!B.length) return;
    var k=ev.key, target=-1, i;
    if(k==='ArrowRight'){ var mR=B[st.iSeq][4]; for(i=st.iSeq+1;i<B.length;i++){ if(B[i][4]>mR){ target=barFirst(i); break; } } if(target<0) target=B.length-1; }
    else if(k==='ArrowLeft'){ var fL=barFirst(st.iSeq); target=(st.iSeq>fL)?fL:((fL>0)?barFirst(fL-1):0); }
    else if(k==='ArrowDown'){ var yD=B[st.iSeq][2]; for(i=st.iSeq+1;i<B.length;i++){ if(B[i][2]>yD+1){ target=barFirst(i); break; } } if(target<0) target=st.iSeq; }
    else if(k==='ArrowUp'){ var yU=B[st.iSeq][2], c=st.iSeq; while(c>0&&Math.abs(B[c-1][2]-yU)<=1) c--; if(c>0){ var yP=B[c-1][2], d=c-1; while(d>0&&Math.abs(B[d-1][2]-yP)<=1) d--; target=barFirst(d); } else target=0; }
    else if(k===' '||k==='Spacebar'){ ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation(); if(!ev.repeat) start(); return; }
    else if(k==='h'||k==='H'){ ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation(); __toggle(); return; }
    else return;
    ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation();
    if(st.playing) jumpTo(target);
    else { st.iSeq=target; lastRowY=-1; place(target); click(B[target][5]===1); }
    if(typeof __bumpIdle==='function')__bumpIdle();
  }
  window.addEventListener('keydown', __metroKeydown, true);

  // ===== 控制面板 =====
  var maxM=(B.length?B[B.length-1][4]:1);
  var THEMES={
    dark:{bg:'linear-gradient(160deg,rgba(27,34,48,0.92),rgba(15,20,29,0.94))',fg:'#e8f4ff',sub:'#8aa0b8',acc:'#5cdfff',bd:'rgba(92,223,255,0.55)',line:'rgba(255,255,255,0.10)',inbg:'#0c1118',inbd:'#2a3852',sel:'#16202e',sh:'0 10px 40px rgba(0,0,0,0.55)'},
    light:{bg:'linear-gradient(160deg,rgba(252,253,255,0.96),rgba(238,243,250,0.97))',fg:'#1a2433',sub:'#5a7088',acc:'#0a84ff',bd:'rgba(10,132,255,0.40)',line:'rgba(20,40,70,0.10)',inbg:'#ffffff',inbd:'#c4d2e2',sel:'#f0f5fc',sh:'0 10px 36px rgba(40,70,120,0.22)'}
  };
  var __theme=(localStorage.getItem('sga_theme')||'dark');
  function TH(){return THEMES[__theme]||THEMES.dark;}
  var __collapsed=true;
  var __idleT=null;
  function __toggle(){__collapsed=!__collapsed;var b=document.getElementById('sgBody'),t=document.getElementById('sgToggle');if(b)b.style.display=__collapsed?'none':'';if(t)t.textContent=__collapsed?'+':'\u2212';}
  var info;
  function mountPanel(){
    var __old=document.getElementById("sga-panel"); if(__old)__old.remove();
    var T=TH();
  var p=document.createElement('div'); p.id='sga-panel';
  // 默认锚右下角: SynPDF 原生菜单 #sync 固定在右上, 两者不再重叠
  function __panelPos(){
    try{
      var q=JSON.parse(localStorage.getItem('sga_panel_pos')||'null');
      if(q&&isFinite(q.left)&&isFinite(q.top))
        return {left:q.left+'px',top:q.top+'px',right:'auto',bottom:'auto'};
    }catch(e){}
    return {left:'auto',top:'auto',right:'14px',bottom:'14px'};
  }
  function panelCss(){var t=TH();var q=__panelPos();return ['position:fixed',
    'left:'+q.left,'top:'+q.top,'right:'+q.right,'bottom:'+q.bottom,'z-index:99999',
    'background:'+t.bg,'color:'+t.fg,'padding:16px 18px','border-radius:18px','min-width:264px',
    'max-height:calc(100vh - 28px)','overflow-y:auto','overscroll-behavior:contain',
    'font:13px -apple-system,BlinkMacSystemFont,sans-serif','backdrop-filter:blur(14px)',
    '-webkit-backdrop-filter:blur(14px)','box-shadow:'+t.sh,'border:1px solid '+t.bd].join(';');}
  p.style.cssText=panelCss();
  var SS='style="width:46px"';
  function ipS(){var t=TH();return 'padding:5px 7px;border-radius:7px;border:1px solid '+t.inbd+';background:'+t.inbg+';color:'+t.fg+';font:inherit';}
  function selS(){var t=TH();return 'padding:5px;border-radius:7px;border:1px solid '+t.inbd+';background:'+t.sel+';color:'+t.acc+';font:inherit;cursor:pointer';}
  p.innerHTML=
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><span id=sgTitle style="font-weight:700;font-size:15px;color:'+T.acc+'">Practice Metronome</span><span style="display:flex;gap:10px;align-items:center"><span id=sgLangBtn style="cursor:pointer;font-size:13px;font-weight:600;color:'+T.acc+';padding:2px 6px;border:1px solid '+T.bd+';border-radius:6px">中</span><span id=sgTheme style="cursor:pointer;font-size:14px" title="\u4eae/\u6697">'+(__theme==='dark'?'\u2600':'\u263d')+'</span><span id=sgToggle style="cursor:pointer;color:'+T.sub+';font-size:18px;line-height:1">\u2212</span></span></div>'+
    '<div id=sgBody>'+
    '<div style="margin-bottom:6px"><div style="display:flex;align-items:center;gap:6px"><span style="width:34px;color:'+T.sub+'">BPM</span><button id=sgBpmM type=button style="width:26px;padding:5px 0;border:1px solid '+T.inbd+';border-radius:7px;background:'+T.sel+';color:'+T.fg+';cursor:pointer;font-weight:700;font-size:14px;line-height:1">\u2212</button><input id=sgBpm type=range min=20 max=300 value=66 style="flex:1;accent-color:'+T.acc+'"><button id=sgBpmP type=button style="width:26px;padding:5px 0;border:1px solid '+T.inbd+';border-radius:7px;background:'+T.sel+';color:'+T.fg+';cursor:pointer;font-weight:700;font-size:14px;line-height:1">+</button><b id=sgBpmV style="font-size:26px;font-weight:800;color:'+T.acc+';min-width:46px;text-align:right;line-height:1">66</b></div></div>'+
    '<div style="display:flex;align-items:center;gap:6px;margin-bottom:12px"><span style="width:34px;color:'+T.sub+'">Tempo</span><select id=sgTempo style="flex:1;'+selS()+'">'+
      '<option value="">自定义</option>'+
      [['Grave',40],['Largo',50],['Adagio',70],['Andante',92],['Moderato',112],['Allegro',132],['Vivace',172],['Presto',184]].map(function(pr){
        return '<option value='+pr[1]+'>'+pr[0]+' '+pr[1]+'</option>';
      }).join('')+
    '</select></div>'+
    '<button id=sgPlay style="width:100%;padding:11px;border:0;border-radius:12px;background:linear-gradient(180deg,#3a9bff,#0a6fff);color:#fff;font-weight:700;font-size:15px;cursor:pointer;box-shadow:0 4px 14px rgba(10,132,255,0.4);margin-bottom:10px">\u25b6 Play</button>'+
    '<div style="display:flex;align-items:center;gap:6px;margin-bottom:12px">'+
      '<button id=sgStart style="flex:1;padding:8px;border:1px solid '+T.inbd+';border-radius:9px;background:'+T.sel+';color:'+T.fg+';cursor:pointer;font-weight:600">\u23ee Start</button>'+
      '<div style="text-align:center"><div id=sgGotoLbl style="font-size:10px;color:'+T.sub+';margin-bottom:2px">Go to bar</div><div style="display:flex;align-items:center;gap:3px"><button id=sgGotoM type=button style="width:22px;padding:4px 0;border:1px solid '+T.inbd+';border-radius:6px;background:'+T.sel+';color:'+T.fg+';cursor:pointer;font-weight:700">\u2212</button><input id=sgGoto type=number min=1 max='+maxM+' value=1 style="width:40px;text-align:center;'+ipS()+'"><button id=sgGotoP type=button style="width:22px;padding:4px 0;border:1px solid '+T.inbd+';border-radius:6px;background:'+T.sel+';color:'+T.fg+';cursor:pointer;font-weight:700">+</button></div></div>'+
      '<button id=sgEnd style="flex:1;padding:8px;border:1px solid '+T.inbd+';border-radius:9px;background:'+T.sel+';color:'+T.fg+';cursor:pointer;font-weight:600">End \u23ed</button></div>'+
    '<div style="display:flex;gap:8px;margin-bottom:10px;font-size:11px">'+
      '<div style="flex:1"><div style="color:'+T.sub+';margin-bottom:3px" id=sgMeterLbl>Meter</div><select id=sgMeter style="width:100%;'+selS()+'"><option value="2">2/4</option><option value="3">3/4</option><option value="4" selected>4/4</option><option value="6">6/8</option></select></div>'+
      '<div style="flex:1"><div style="color:'+T.sub+';margin-bottom:3px" id=sgColorLbl>Color</div><select id=sgColor style="width:100%;'+selS()+'"><option value="blue" selected>Blue</option><option value="green">Green</option><option value="red">Red</option><option value="yellow">Yellow</option><option value="purple">Purple</option></select></div>'+
      '<div style="flex:1"><div style="color:'+T.sub+';margin-bottom:3px" id=sgBgLbl>Background</div><select id=sgBg style="width:100%;'+selS()+'"><option value="none" selected>Normal</option><option value="sepia">Sepia</option><option value="gray">Soft gray</option><option value="night">Night</option><option value="parch">Parchment</option></select></div></div>'+
    '<div style="display:flex;gap:8px;margin-bottom:10px;font-size:11px">'+
      '<div style="flex:1"><div style="color:'+T.sub+';margin-bottom:3px" id=sgSoundLbl>Sound</div><select id=sgSound style="width:100%;'+selS()+'"><option value="wood" selected>Wood</option><option value="clave">Clave</option><option value="beep">Beep</option><option value="digital">Digital</option><option value="snare">Snare</option></select></div>'+
      '<div style="flex:1"><label style="display:flex;align-items:center;gap:6px;padding-top:18px;cursor:pointer"><input id=sgBarnum type=checkbox '+(st.showBarnums?'checked':'')+' style="accent-color:'+T.acc+'"><span style="color:'+T.fg+'" id=sgBarnumLbl>Bar nums</span></label></div></div>'+
    '<div style="display:flex;gap:14px;align-items:center;margin-bottom:12px;font-size:11px">'+
      '<div style="flex:1"><div style="color:'+T.sub+';margin-bottom:3px" id=sgOpacLbl>Opacity</div><div style="display:flex;align-items:center;gap:6px"><input id=sgOpac type=range min=10 max=60 value=28 style="flex:1;accent-color:'+T.acc+'"><b id=sgOpacV style="width:34px;text-align:right;color:'+T.acc+'">.28</b></div></div>'+
      '<div><div style="color:'+T.sub+';margin-bottom:3px" id=sgCntLbl>Count-in</div><input id=sgCnt type=number min=0 max=8 value=0 style="width:48px;text-align:center;'+ipS()+'"></div></div>'+
    '<div style="margin-bottom:12px;font-size:11px"><div style="color:'+T.sub+';margin-bottom:3px" id=sgFollowLbl>Follow Y</div><div style="display:flex;align-items:center;gap:6px"><input id=sgFollow type=range min=10 max=60 value='+Math.round(st.followY*100)+' style="flex:1;accent-color:'+T.acc+'"><b id=sgFollowV style="width:34px;text-align:right;color:'+T.acc+'">'+Math.round(st.followY*100)+'%</b></div></div>'+
    '<div style="border-top:1px solid '+T.line+';padding-top:10px;margin-bottom:10px"><div style="font-size:11px;color:'+T.sub+';margin-bottom:4px" id=sgSeqLbl>Sequence</div>'+
      '<div style="display:flex;align-items:center;gap:5px;margin-bottom:6px"><span style="color:'+T.sub+';margin-right:2px">Plans</span><button type=button class=sga-plan-slot data-slot=1 style="'+selS()+';padding:3px 7px">Score</button><button type=button class=sga-plan-slot data-slot=2 style="'+selS()+';padding:3px 8px">A</button><button type=button class=sga-plan-slot data-slot=3 style="'+selS()+';padding:3px 8px">B</button><button type=button class=sga-plan-slot data-slot=4 style="'+selS()+';padding:3px 8px">C</button></div>'+
      '<input id=sgSeq type=text placeholder="e.g. 1-4, 1-4, 5-12" style="width:100%;box-sizing:border-box;'+ipS()+'"></div>'+
    '<div style="font-size:10px;color:'+T.sub+';margin:6px 0 3px" id=sgMeterMapLbl>Meter map (bar:beats, 变拍号)</div>'+
    '<input id=sgMeterMap type=text placeholder="例 1:4, 17:3, 33:6" style="width:100%;box-sizing:border-box;'+ipS()+'">'+
    '<div style="font-size:10px;color:'+T.sub+';margin:6px 0 3px" id=sgSkipLbl>Skip bars (误判小节, 填当前显示号)</div>'+
    '<input id=sgSkip type=text placeholder="例 23 或 23, 41" style="width:100%;box-sizing:border-box;'+ipS()+'">'+
    '<div style="border-top:1px solid '+T.line+';padding-top:10px;margin-bottom:10px"><label style="display:flex;align-items:center;gap:7px;margin-bottom:7px"><input id=sgLoop type=checkbox style="accent-color:'+T.acc+'"> <span style="font-weight:600">Loop</span></label>'+
      '<div style="display:flex;align-items:center;gap:6px;font-size:11px;margin-bottom:5px"><span style="color:'+T.sub+'">From bar</span><input id=sgFrom type=number min=1 max='+maxM+' value=1 style="width:50px;text-align:center;'+ipS()+'"><span style="color:'+T.sub+'">To bar</span><input id=sgTo type=number min=1 max='+maxM+' value='+maxM+' style="width:50px;text-align:center;'+ipS()+'"></div>'+
      '<div style="display:flex;align-items:center;gap:6px;font-size:11px"><span style="color:'+T.sub+'">Repeat</span><input id=sgN type=number min=0 value=4 style="width:50px;text-align:center;'+ipS()+'"><span style="color:'+T.sub+'">(0=inf)</span></div></div>'+
    '<button id=sgExport style="width:100%;padding:10px;border:1px solid '+T.bd+';border-radius:11px;background:transparent;color:'+T.acc+';font-weight:700;cursor:pointer;margin-bottom:6px" title="\u5bfc\u51fapreload">\u2913 Export</button>'+
    '<div style="font-size:10px;color:'+T.sub+';text-align:center" id=sgHint>\u2190/\u2192: bar \u00b7 \u2191/\u2193: row \u00b7 space: play</div>'+
    '<div id=sgInfo style="margin-top:5px;font-size:11px;color:'+T.acc+';min-height:14px;text-align:center">ready</div>'+'</div>';
  document.body.appendChild(p);
  // 标题栏拖动 + 位置记忆; 双击标题栏复位到右下角
  (function(){
    var tt=document.getElementById('sgTitle'); if(!tt) return;
    var bar=tt.parentNode; if(!bar) return;
    bar.style.cursor='move'; bar.style.userSelect='none';
    var dx=0,dy=0,drag=false;
    function move(ev){
      if(!drag) return;
      var L=Math.max(0,Math.min(window.innerWidth-p.offsetWidth, ev.clientX-dx));
      var T=Math.max(0,Math.min(window.innerHeight-p.offsetHeight, ev.clientY-dy));
      p.style.left=L+'px'; p.style.top=T+'px';
    }
    function up(){
      if(!drag) return; drag=false;
      document.removeEventListener('mousemove',move);
      document.removeEventListener('mouseup',up);
      try{ localStorage.setItem('sga_panel_pos',JSON.stringify({left:parseFloat(p.style.left)||0,top:parseFloat(p.style.top)||0})); }catch(e){}
    }
    bar.addEventListener('mousedown',function(ev){
      if(ev.target!==bar&&ev.target!==tt) return;
      var r=p.getBoundingClientRect();
      drag=true; dx=ev.clientX-r.left; dy=ev.clientY-r.top;
      p.style.right='auto'; p.style.bottom='auto';
      p.style.left=r.left+'px'; p.style.top=r.top+'px';
      document.addEventListener('mousemove',move);
      document.addEventListener('mouseup',up);
      ev.preventDefault();
    });
    bar.addEventListener('dblclick',function(){
      try{ localStorage.removeItem('sga_panel_pos'); }catch(e){}
      p.style.left='auto'; p.style.top='auto'; p.style.right='14px'; p.style.bottom='14px';
    });
  })();
  info=document.getElementById('sgInfo');

  // ===== 面板事件 =====
  function setBpm(v){ v=Math.max(20,Math.min(300,Math.round(+v||66))); st.bpm=v;
    var r=document.getElementById('sgBpm'); if(r) r.value=v;
    var t=document.getElementById('sgBpmV'); if(t) t.textContent=v;
    renderTempo(); }
  function renderTempo(){ var s=document.getElementById('sgTempo'); if(!s) return; var match=false;
    for(var ti=0;ti<s.options.length;ti++){ if(s.options[ti].value!==''&&+s.options[ti].value===st.bpm){ match=true; break; } }
    s.value=match?String(st.bpm):''; }
  function __savePlanSoon(){ if(typeof schedulePlanSave==='function'){ try{ schedulePlanSave(); }catch(e){} } }
  document.getElementById('sgBpm').oninput=function(){ setBpm(this.value); __savePlanSoon(); };
  document.getElementById('sgBpmM').onclick=function(){ setBpm(st.bpm-1); __savePlanSoon(); };
  document.getElementById('sgBpmP').onclick=function(){ setBpm(st.bpm+1); __savePlanSoon(); };
  (function(){ var tp=document.getElementById('sgTempo'); if(tp){ tp.onchange=function(){ if(this.value!==''){ setBpm(+this.value); __savePlanSoon(); } }; } })();
  renderTempo();
  document.getElementById('sgLoop').onchange=function(){ st.loopOn=this.checked; };
  document.getElementById('sgFrom').oninput=function(){ st.loopFrom=Math.max(1,Math.min(maxM,+this.value||1)); };
  document.getElementById('sgTo').oninput=function(){ st.loopTo=Math.max(1,Math.min(maxM,+this.value||maxM)); };
  document.getElementById('sgN').oninput=function(){ st.loopN=Math.max(0,+this.value||0); };
  document.getElementById('sgCnt').oninput=function(){ st.countIn=Math.max(0,Math.min(8,+this.value||0)); };
  document.getElementById('sgSeq').oninput=function(){ st.seqText=this.value; };
  function parseMeterMap(txt){
    txt=(txt||'').trim(); if(!txt) return null;
    var map={}, ok=false;
    txt.split(',').forEach(function(seg){
      var p=seg.split(':'); if(p.length!==2) return;
      var bar=parseInt(p[0],10), beats=parseInt(p[1],10);
      if(bar>=1 && beats>=1 && beats<=16){ map[bar]=beats; ok=true; }
    });
    return ok?map:null;
  }
  document.getElementById('sgMeterMap').oninput=function(){
    st.meterMap=parseMeterMap(this.value);
    rebuild();
  };
  function parseSkip(txt){
    txt=(txt||'').trim(); if(!txt) return null;
    var set={}, ok=false;
    txt.split(',').forEach(function(seg){ var n=parseInt(seg.trim(),10); if(n>=1){ set[n]=true; ok=true; } });
    return ok?set:null;
  }
  document.getElementById('sgSkip').oninput=function(){
    st.skipBars=parseSkip(this.value);
    rebuild();
  };
  document.getElementById('sgColor').onchange=function(){ st.color=this.value; applyShadeStyle(); };
  document.getElementById('sgSound').onchange=function(){ st.sound=this.value; };
  document.getElementById('sgBarnum').onchange=function(){ st.showBarnums=this.checked; applyBarnumStyle(); };
  document.getElementById('sgOpac').oninput=function(){ st.opacity=(+this.value)/100; document.getElementById('sgOpacV').textContent=st.opacity.toFixed(2).replace(/^0/,''); applyShadeStyle(); };
  document.getElementById('sgFollow').oninput=function(){ st.followY=Math.max(0.10,Math.min(0.60,(+this.value)/100)); document.getElementById('sgFollowV').textContent=Math.round(st.followY*100)+'%'; lastRowY=-1; if(B[st.iSeq]) place(st.iSeq); };
  document.getElementById('sgMeter').onchange=function(){
    st.meter=+this.value;
    rebuild();
  };
  document.getElementById('sgPlay').onclick=start;
  // ===== 跳转: Start / End / Go to bar =====
  function gotoBar(m){ m=Math.max(1,Math.min(maxM,m||1)); var idx=-1; for(var i=0;i<B.length;i++){ if(B[i][4]===m){ idx=i; break; } } if(idx<0){ for(var j=0;j<B.length;j++){ if(B[j][4]>=m){ idx=j; break; } } } if(idx<0) idx=B.length-1; if(st.playing){ st.playing=false; if(st.raf)cancelAnimationFrame(st.raf); setPlayBtn(false); } st.iSeq=idx; lastRowY=-1; place(idx); info.textContent='bar '+m; }
  // B 表坐标基于 #notation 内容坐标系 (canvas offsetLeft/offsetTop,
  // 与 shade / barnum 的 absolute 定位同源). 点击换算必须走同一坐标系:
  // host 相对坐标 + 滚动量, 不能再按页高累加 (buildB 已不假设画布从 0,0 无缝平铺).
  function metricPointFromEvent(ev){
    var r=host.getBoundingClientRect();
    return { x: ev.clientX - r.left + host.scrollLeft,
             y: ev.clientY - r.top  + host.scrollTop };
  }
  // Activate the clicked measure without blocking SynPDF's own click handlers.
  // 纠错模式下点线条不碰播放头; 播放中点小节=暖机重起(预备拍后从该小节开播).
  host.addEventListener('click',function(ev){
    if(ev.button!==0||!B.length) return;
    try{ if(window.__sfCorrectMode) return; }catch(e){}
    var point=metricPointFromEvent(ev);
    if(!point) return;
    var x=point.x, y=point.y;
    var measure=0;
    for(var i=0;i<B.length;i++){
      if(x>=B[i][6]&&x<=B[i][7]&&y>=B[i][2]&&y<=B[i][3]){ measure=B[i][4]; break; }
    }
    if(measure) setTimeout(function(){ if(st.playing) restartAtMeasure(measure); else gotoBar(measure); },0);
  },false);

  document.getElementById('sgStart').onclick=function(){ gotoBar(1); };
  document.getElementById('sgEnd').onclick=function(){ gotoBar(maxM); };
  document.getElementById('sgGoto').oninput=function(){ var v=+this.value; if(v>=1) gotoBar(v); };
  function __gostep(d){ var el=document.getElementById('sgGoto'); var v=Math.max(1,Math.min(maxM,(+el.value||1)+d)); el.value=v; gotoBar(v); }
  document.getElementById('sgGotoM').onclick=function(){ __gostep(-1); };
  document.getElementById('sgGotoP').onclick=function(){ __gostep(1); };
  // ===== 背景调色(CSS filter 作用在 canvas) =====
  var BGF={none:'',sepia:'sepia(0.45) brightness(0.96)',gray:'grayscale(0.3) brightness(0.9) contrast(1.05)',night:'invert(0.92) hue-rotate(180deg) brightness(1.05)',parch:'sepia(0.6) saturate(1.3) brightness(0.92)'};
  var BGW={none:'',sepia:'#f4ecd8',gray:'#cfd4da',night:'#0d1016',parch:'#e8dcc0'};
  function applyBg(v){ var cvs=host.getElementsByTagName('canvas'); for(var i=0;i<cvs.length;i++){ cvs[i].style.filter=BGF[v]||''; } host.style.background=BGW[v]||''; try{ localStorage.setItem('sga_bg',v); }catch(e){} }
  document.getElementById('sgBg').onchange=function(){ applyBg(this.value); };
  try{ var __sb=localStorage.getItem('sga_bg'); if(__sb&&BGF[__sb]!=null){ document.getElementById('sgBg').value=__sb; applyBg(__sb); } }catch(e){}
  // ===== 亮/暗主题切换 =====
  document.getElementById('sgTheme').onclick=function(){ __theme=(__theme==='dark'?'light':'dark'); try{ localStorage.setItem('sga_theme',__theme); }catch(e){} mountPanel(); };
  document.getElementById('sgLangBtn').onclick=function(){ st.lang = (st.lang==='en')?'zh':'en'; applyLang(); };
  // 回填当前 st 状态到控件(重建面板时不丢已调参数)
  (function(){ function S(id){return document.getElementById(id);} 
    if(S('sgBpm')){ S('sgBpm').value=st.bpm; S('sgBpmV').textContent=st.bpm; }
    if(S('sgColor')) S('sgColor').value=st.color;
    if(S('sgOpac')){ S('sgOpac').value=Math.round(st.opacity*100); S('sgOpacV').textContent=st.opacity.toFixed(2).replace(/^0/,''); }
    if(S('sgMeter')) S('sgMeter').value=st.meter;
    if(S('sgCnt')) S('sgCnt').value=st.countIn;
    if(S('sgSeq')) S('sgSeq').value=st.seqText||'';
    if(S('sgLoop')) S('sgLoop').checked=!!st.loopOn;
    if(S('sgFrom')) S('sgFrom').value=st.loopFrom;
    if(S('sgTo')) S('sgTo').value=st.loopTo;
    if(S('sgN')) S('sgN').value=st.loopN;
    if(S('sgSound')) S('sgSound').value=st.sound;
    if(S('sgMeterMap')) S('sgMeterMap').value=mapText(st.meterMap,true);
    if(S('sgSkip')) S('sgSkip').value=mapText(st.skipBars,false);
  })();
  if(typeof applyShadeStyle==='function') applyShadeStyle();
    document.getElementById('sgToggle').onclick=function(){__toggle();__bumpIdle();};
    function __setCollapse(v){ if(__collapsed===v)return; __collapsed=v;document.getElementById('sgBody').style.display=v?'none':'';document.getElementById('sgToggle').textContent=v?'+':'\u2212'; }
    var __editing=false;
  function __bumpIdle(){ __setCollapse(false); if(__idleT)clearTimeout(__idleT);
    if(__editing) return;  // 方案A: 编辑中完全不计时, 等 blur
    __idleT=setTimeout(function(){ __setCollapse(true); },2500);
  }
  // 方案A: 文本类 input/textarea focus 时暂停计时, blur 时恢复
  function __bindEditPause(el){
    if(!el) return;
    el.addEventListener('focus',function(){ __editing=true; if(__idleT)clearTimeout(__idleT); __setCollapse(false); });
    el.addEventListener('blur',function(){ __editing=false; __bumpIdle(); });
  }
  p.addEventListener('mousemove',__bumpIdle);p.addEventListener('mousedown',__bumpIdle);p.addEventListener('input',__bumpIdle);
  p.addEventListener('input',schedulePlanSave);p.addEventListener('change',schedulePlanSave);
  bindPlanSlots();
  // 对所有文本类 input/textarea 绑 focus/blur 暂停
  ['sgSeq','sgMeterMap','sgSkip','sgCnt'].forEach(function(id){ __bindEditPause(document.getElementById(id)); });
    if(__collapsed){document.getElementById('sgBody').style.display='none';document.getElementById('sgToggle').textContent='+';} else {__bumpIdle();}
    applyLang();
  var __exb=document.getElementById('sgExport'); if(__exb) __exb.onclick=doExport;
  } // mountPanel end
  mountPanel();

  // 折叠

  // ===== 导出节拍器版: synpdf save拿校对好的.js -> 注入loader annot + SGA_CONFIG -> 下载 =====
  var ENGINE_URL = (function(){
    var s=document.querySelector('script[src*="metro-engine.js"]');
    // 修复2: 去掉 ?v=时间戳, 导出干净 URL
    var raw = (s&&s.src) || 'http://150.136.51.61/public/livescore/viewer/metro-engine.js';
    return raw.split('?')[0];
  })();

  function readFullJs(cb){
    // 触发 synpdf 的 show: 把完整.js填进 #saveDlg pre
    var showBtn=document.getElementById('show');
    if(!showBtn){
      // scorefollow Next.js 版没有原版 #show: 走宿主 builder(异步, 含人工校正)
      try{
        var hook=window.__sfPreloadText;
        if(typeof hook==='function'){
          hook().then(function(txt){ cb(txt && /metric_arr\s*=/.test(txt) ? txt : null); },
                      function(){ cb(null); });
          return;
        }
      }catch(e){}
      cb(null); return;
    }
    showBtn.click();
    var tries=0;
    var iv=setInterval(function(){
      tries++;
      var pre=document.querySelector('#saveDlg pre');
      var txt=pre&&pre.textContent;
      if(txt && /metric_arr\s*=/.test(txt)){
        clearInterval(iv);
        // 关掉对话框
        var dlg=document.getElementById('saveDlg'); if(dlg) dlg.style.display='none';
        cb(txt);
      } else if(tries>=30){ clearInterval(iv); cb(null); }
    }, 80);
  }

  function injectLoaderAndConfig(jsText){
    // === 构造 cfg + loaderTag(含内联config) ===
    var cfg = { bpm:st.bpm, meter:st.meter, color:st.color, opacity:st.opacity,
                countIn:st.countIn, seqText:st.seqText,
                meterMap:st.meterMap, skipBars:st.skipBars,
                loopOn:st.loopOn, loopFrom:st.loopFrom, loopTo:st.loopTo, loopN:st.loopN,
                sound:st.sound, showBarnums:st.showBarnums, followY:st.followY, lang:st.lang };
    var __cfgJson = JSON.stringify(cfg);
    // 导出时本地路径替换成公网地址
    var _exportUrl = ENGINE_URL;
    if(_exportUrl.indexOf('localhost')>=0 || _exportUrl.indexOf('127.0.0.1')>=0 || _exportUrl.indexOf('file://')===0){
      _exportUrl = 'https://ezmusicstore.com/livescore/viewer/metro-engine.js';
    }
    var loaderTag = '<scr'+'ipt>window.sga_config='+__cfgJson+';(function(){if(window.__sgaBoot)return;window.__sgaBoot=1;var s=document.createElement("script");s.src="'+_exportUrl+'";s.async=true;(document.head||document.documentElement).appendChild(s);})();</scr'+'ipt>';

    // === 用 JSON.parse 结构化处理 annots(synpdf输出的是JSON.stringify的合法JSON), 避免正则被 t 里的花括号干扰 ===
    var m = jsText.match(/annots\s*=\s*(\[[\s\S]*?\]);/);
    var annots = [];
    if(m){ try{ annots = JSON.parse(m[1]); }catch(e){ annots = []; } }
    // 找到已有的引擎 annot(含特征 或 t为空), 只替换它的 t, 不新增 -> 避免重复堆叠
    var engIdx = -1;
    for(var ai=0; ai<annots.length; ai++){
      var tt = (annots[ai] && annots[ai].t) || '';
      if(tt.indexOf('__sgaBoot')>=0 || tt.indexOf('metro-engine.js')>=0 || tt.indexOf('__sgaMetro')>=0 || tt.indexOf('sga_config')>=0 || tt===''){ engIdx = ai; break; }
    }
    if(engIdx>=0){ annots[engIdx].t = loaderTag; }
    else { annots.push({x:555,y:99.5,w:1470,c:0,t:loaderTag,d:0}); }
    var annotsLine = 'annots = '+JSON.stringify(annots)+';\n';
    if(m){ jsText = jsText.replace(/annots\s*=\s*\[[\s\S]*?\];\n?/, annotsLine); }
    else {
      var om = jsText.match(/(opt\s*=\s*\{[\s\S]*?\};\n)/);
      if(om){ jsText = jsText.replace(om[1], om[1]+annotsLine); }
      else { jsText += '\n'+annotsLine; }
    }

    // === 修正 opt.fixwd 字符串->数字 ===
    jsText = jsText.replace(/("fixwd":)"(\d+)"/, '$1$2');

    return jsText;
  }

  function doExport(){
    var btn=document.getElementById('sgExport');
    if(btn){ btn.textContent='...'; btn.disabled=true; }
    readFullJs(function(txt){
      if(!txt){ if(btn){btn.textContent='⤓ export'; btn.disabled=false;} alert('导出失败: 读不到校对数据，请先点 synpdf 的 save/show 一次'); return; }
      var out = injectLoaderAndConfig(txt);
      // 文件名: pdf_file 同名.js 或 score.js
      var fn='score';
      var pm=txt.match(/pdf_file\s*=\s*"([^"]*)\.pdf"/);
      if(pm) fn=pm[1];
      fn=fn.replace(/[\\/:*?"<>|]/g,"_").trim()||"score";
      var blob=new Blob(["\ufeff"+out],{type:'application/javascript;charset=utf-8'});
      var url=URL.createObjectURL(blob);
      var a=document.createElement('a');
      a.href=url; a.download=fn+'.js';
      document.body.appendChild(a); a.click();
      setTimeout(function(){ URL.revokeObjectURL(url); a.remove(); },1000);
      if(btn){ btn.textContent='✓ done'; setTimeout(function(){btn.textContent='⤓ export'; btn.disabled=false;},1500); }
    });
  }

  // ===== 应用 SGA_CONFIG(启动恢复 + 外部导入恢复共用): 只设值+刷新面板, 不碰播放头/滚屏 =====
  function applySgaConfig(c){
    if(!c) return;
    function setV(id,v){ var el=document.getElementById(id); if(el!=null&&v!=null) el.value=v; }
    if(c.bpm!=null){ st.bpm=c.bpm; setV('sgBpm',c.bpm); var bv=document.getElementById('sgBpmV'); if(bv)bv.textContent=c.bpm; if(typeof renderTempo==='function'){ try{ renderTempo(); }catch(e){} } }
    if(c.meter!=null){ st.meter=c.meter; var ms=document.getElementById('sgMeter'); if(ms){ms.value=c.meter;} }
    if(c.meterMap!=null){ st.meterMap=c.meterMap; var mmEl=document.getElementById('sgMeterMap'); if(mmEl){ mmEl.value=Object.keys(c.meterMap).sort(function(a,b){return a-b;}).map(function(k){return k+':'+c.meterMap[k];}).join(', '); } }
    if(c.skipBars!=null){ st.skipBars=c.skipBars; var skEl=document.getElementById('sgSkip'); if(skEl){ skEl.value=Object.keys(c.skipBars).sort(function(a,b){return a-b;}).join(', '); } }
    if(c.color!=null){ st.color=c.color; var cs=document.getElementById('sgColor'); if(cs)cs.value=c.color; }
    if(c.opacity!=null){ st.opacity=c.opacity; var op=document.getElementById('sgOpac'); if(op)op.value=Math.round(c.opacity*100); var ov=document.getElementById('sgOpacV'); if(ov)ov.textContent=c.opacity.toFixed(2).replace(/^0/,''); }
    if(c.followY!=null){ st.followY=Math.max(0.10,Math.min(0.60,+c.followY||0.30)); var fy=document.getElementById('sgFollow'); if(fy)fy.value=Math.round(st.followY*100); var fyv=document.getElementById('sgFollowV'); if(fyv)fyv.textContent=Math.round(st.followY*100)+'%'; }
    if(c.countIn!=null){ st.countIn=c.countIn; setV('sgCnt',c.countIn); }
    if(c.seqText!=null){ st.seqText=c.seqText; setV('sgSeq',c.seqText); }
    if(c.loopOn!=null){ st.loopOn=c.loopOn; var lp=document.getElementById('sgLoop'); if(lp)lp.checked=!!c.loopOn; }
    if(c.loopFrom!=null){ st.loopFrom=c.loopFrom; setV('sgFrom',c.loopFrom); }
    if(c.loopTo!=null){ st.loopTo=c.loopTo; setV('sgTo',c.loopTo); }
    if(c.loopN!=null){ st.loopN=c.loopN; setV('sgN',c.loopN); }
    if(c.sound!=null){ st.sound=c.sound; var snEl=document.getElementById('sgSound'); if(snEl)snEl.value=c.sound; }
    if(c.showBarnums!=null){ st.showBarnums=c.showBarnums; var bnEl=document.getElementById('sgBarnum'); if(bnEl)bnEl.checked=!!c.showBarnums; if(typeof applyBarnumStyle==='function')applyBarnumStyle(); }
    if(c.lang!=null){ st.lang=c.lang; if(typeof applyLang==='function')applyLang(); }
    if(typeof applyShadeStyle==='function') applyShadeStyle();
  }
  // ===== 启动读 SGA_CONFIG 恢复上次导出的偏好 =====
  (function(){
    var c = window.sga_config; if(!c) return;
    applySgaConfig(c);
  })();



  // ===== 初始化 / 重载 =====
  function applyData(){
    maxM = B.length? B[B.length-1][4] : 1;
    if(!__planReady) initPlanSlots();
    var ti=document.getElementById('sgTo'), fi=document.getElementById('sgFrom'), gi=document.getElementById('sgGoto');
    if(ti){ ti.max=maxM; if(+ti.value>maxM||+ti.value<1) ti.value=maxM; }
    if(fi){ fi.max=maxM; }
    if(gi){ gi.max=maxM; if(+gi.value>maxM) gi.value=maxM; }
    st.loopTo=Math.min(st.loopTo||maxM,maxM)||maxM;
    renderBarnums();
    if(st.iSeq>=B.length) st.iSeq=0;
    lastRowY=-1; positionShade(st.iSeq); // 只跟新几何, 不滚屏(纠错加线/合并不再跳回开头)
    info.textContent=L('ready')+' - '+maxM+' bars';
  }
  // 加载即读 metric_arr 铺 shade(手动点 load metro 时 metric_arr 已校好)
  loadFromPre(function(ok){
    if(!ok){ info.textContent='metric_arr not found - click save once'; return; }
    applyData();
  });
  var __rzT=null, __renderWaitT=null, __dispatchingResize=false;
  function viewportWidth(){
    var vv=window.visualViewport;
    return Math.round((vv&&vv.width)||document.documentElement.clientWidth||document.body.clientWidth||window.innerWidth||0);
  }
  function runtimeMetric(){
    var rt=window.SynPDFRuntime;
    if(!rt||typeof rt.getMetricArr!=='function') return null;
    try{
      var MA=rt.getMetricArr();
      return Array.isArray(MA)&&MA.length>1?MA:null;
    }catch(e){ return null; }
  }
  function applyResponsiveMetric(MA){
    if(!MA) return false;
    st._lastMA=MA;
    B=buildB(MA);
    applyData();
    return true;
  }
  function waitForSynPDFRender(attempt){
    var rt=window.SynPDFRuntime;
    if(rt&&typeof rt.isRendering==='function'&&rt.isRendering()){
      if(attempt<150) __renderWaitT=setTimeout(function(){ waitForSynPDFRender(attempt+1); },80);
      return;
    }
    var MA=runtimeMetric()||st._lastMA||readMetric();
    if(applyResponsiveMetric(MA)) return;
    if(attempt<25) __renderWaitT=setTimeout(function(){ waitForSynPDFRender(attempt+1); },80);
  }
  function requestResponsiveLayout(reason){
    if(__rzT) clearTimeout(__rzT);
    if(__renderWaitT) clearTimeout(__renderWaitT);
    st.viewportWidth=viewportWidth();
    __rzT=setTimeout(function(){
      // SynPDF already handles a real window resize. Fullscreen, orientation
      // and VisualViewport changes are not reliable resize emitters on every
      // browser, so emit one native resize to reuse SynPDF's authoritative path.
      if(reason!=='resize'){
        __dispatchingResize=true;
        try{ window.dispatchEvent(new Event('resize')); }
        finally{ __dispatchingResize=false; }
      }
      __renderWaitT=setTimeout(function(){ waitForSynPDFRender(0); },280);
    },140);
  }
  function __reload(){
    if(__dispatchingResize) return;
    requestResponsiveLayout('resize');
  }
  function __fullscreen(){ requestResponsiveLayout('fullscreen'); }
  function __orientation(){ requestResponsiveLayout('orientation'); }
  function __visualResize(){ requestResponsiveLayout('visualViewport'); }
  function __metricRendered(event){
    if(__renderWaitT) clearTimeout(__renderWaitT);
    var MA=event&&event.detail&&event.detail.metricArr;
    applyResponsiveMetric(MA||runtimeMetric());
  }
  window.addEventListener('resize', __reload);
  window.addEventListener('orientationchange', __orientation);
  document.addEventListener('fullscreenchange', __fullscreen);
  document.addEventListener('webkitfullscreenchange', __fullscreen);
  document.addEventListener('mozfullscreenchange', __fullscreen);
  window.addEventListener('synpdf:metric-rendered', __metricRendered);
  // 外部点谱跳转(mix 为 1-based 全局小节号): 播放中暖机重起(预备拍后从该小节开播), 未播放只移动头
  window.addEventListener('synpdf:metro-jump', function(ev){
    if(!B.length) return;
    var d=ev&&ev.detail; if(!d||d.measure==null) return;
    if(d.onlyIfPlaying&&!st.playing) return;
    var m=+d.measure, idx=-1;
    for(var i=0;i<B.length;i++){ if(B[i][4]>=m){ idx=barFirst(i); break; } }
    if(idx<0) idx=0;
    if(st.playing) restartFromIdx(idx);
    else { st.iSeq=idx; lastRowY=-1; place(idx); click(B[idx][5]===1); }
  });
  // ===== PracticeSession bridge: one shared firstBeatAt clock =====
  // React owns the session (startMeasure/bpm/count-in/firstBeatAt). Metro only
  // renders clicks + highlight on that clock and emits tick events for the
  // PDF cursor. Recording itself stays a mic-only MediaRecorder in React.
  var __practiceTicker=null, __practiceSession=null;
  function __practiceTickStop(){ if(__practiceTicker){ clearInterval(__practiceTicker); __practiceTicker=null; } }
  function __practiceEmit(firstBeatAt, startMeasure, bpm, beatsPerMeasure){
    var now=performance.now(), elapsed=(now-firstBeatAt)/1000, beatDur=60/bpm;
    var total=Math.max(0, Math.floor(elapsed/beatDur));
    window.dispatchEvent(new CustomEvent('synpdf:practice-tick', { detail: {
      startMeasure: startMeasure, bpm: bpm, beatsPerMeasure: beatsPerMeasure,
      elapsedSec: elapsed, totalBeats: total,
      measure: startMeasure + Math.floor(total/beatsPerMeasure),
      beat: (total%beatsPerMeasure)+1, now: now, firstBeatAt: firstBeatAt } }));
  }
  function __practicePrepare(d){
    if(!d) return false;
    if(d.bpm) st.bpm=Math.min(300, Math.max(20, +d.bpm||st.bpm));
    if(d.beatsPerMeasure) st.meter=Math.min(12, Math.max(2, +d.beatsPerMeasure||st.meter));
    st.countIn=Math.max(0, Math.min(8, +d.countInBeats||0));
    if(B.length && d.startMeasure!=null){
      var m=+d.startMeasure, idx=-1;
      for(var i=0;i<B.length;i++){ if(B[i][4]>=m){ idx=barFirst(i); break; } }
      if(idx<0) idx=0;
      if(st.playing) jumpTo(idx);
      else { st.iSeq=idx; lastRowY=-1; place(idx); }
      try{
        var bpmEl=document.getElementById('sgBpm'); if(bpmEl) bpmEl.value=st.bpm;
        var bpmV=document.getElementById('sgBpmV'); if(bpmV) bpmV.textContent=st.bpm;
        var meterEl=document.getElementById('sgMeter'); if(meterEl) meterEl.value=String(st.meter);
        var cntEl=document.getElementById('sgCnt'); if(cntEl) cntEl.value=String(st.countIn);
      }catch(e){}
    }
    return true;
  }
  function __practiceStart(d){
    if(!d||d.firstBeatAt==null) return false;
    if(st.playing) stop();
    // 无节拍数据直接拒掉: 否则后继 seqRange 取 B 末尾抛错、playing 卡死 true 再也播不响
    if(!B.length){ info.textContent='no data'; return false; }
    st._startAt=nowMs();
    __practicePrepare(d);
    __practiceSession=d;
    if(!st.audio){ try{ st.audio=new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} }
    try{ if(st.audio&&st.audio.state==='suspended') st.audio.resume(); }catch(e){}
    var spb=60/st.bpm, countIn=Math.max(0, +d.countInBeats||0);
    var countStart=d.firstBeatAt-countIn*spb*1000;
    var wait=Math.max(0, countStart-performance.now());
    st.playing=true; setPlayBtn(true);
    __practiceTickStop();
    setTimeout(function(){
      if(!__practiceSession||__practiceSession!==d||!st.playing) return;
      var i=0, BT=Math.max(1, st.meter|0);
      (function tick(){
        if(!st.playing||__practiceSession!==d) return;
        click(i%BT===0);
        i++;
        if(i>=countIn){
          var remain=Math.max(0, d.firstBeatAt-performance.now());
          setTimeout(function(){
            if(!st.playing||__practiceSession!==d) return;
            var seq=parseSeq(st.seqText);
            window.dispatchEvent(new CustomEvent('synpdf:practice-first-beat', { detail: d }));
            if(st.loopOn){ st._seq=null; playLoop(); } else if(seq){ playSequence(seq); } else { st._seq=null; playLoop(); }
            __practiceEmit(d.firstBeatAt, d.startMeasure, st.bpm, st.meter||d.beatsPerMeasure||4);
            __practiceTicker=setInterval(function(){ __practiceEmit(d.firstBeatAt, d.startMeasure, st.bpm, st.meter||d.beatsPerMeasure||4); }, 100);
          }, remain);
        } else setTimeout(tick, spb*1000);
      })();
    }, wait);
    return true;
  }
  function __practiceStop(){
    __practiceSession=null; __practiceTickStop();
    if(st.playing) stop();
    window.dispatchEvent(new CustomEvent('synpdf:practice-stopped', {}));
  }
  // React 常驻走带按钮用: 与面板播放同一套状态机, idle 点播从当前头起播(含预备拍)
  window.__sgaMetroControl={
    play: function(fromM){
      if(st.playing) return false;
      if(fromM!=null){
        if(!B.length) return false;
        gotoBar(fromM);
      }
      start();
      return st.playing;
    },
    stop: function(){ stop(); return true; },
    restartAtMeasure: restartAtMeasure,
    applyConfig: applySgaConfig,
    isPlaying: function(){ return !!st.playing; }
  };
  window.__sgaMetroPractice={
    isAvailable: function(){ return B.length>0; },
    prepare: __practicePrepare, start: __practiceStart, stop: __practiceStop,
    getState: function(){ return { playing: !!st.playing, bpm: st.bpm, meter: st.meter, countIn: st.countIn }; }
  };
  window.addEventListener('synpdf:practice-start', function(ev){ if(ev&&ev.detail) __practiceStart(ev.detail); });
  window.addEventListener('synpdf:practice-stop', function(){ __practiceStop(); });
  if(window.visualViewport) window.visualViewport.addEventListener('resize', __visualResize);
  st.viewportWidth=viewportWidth();
  st.refreshLayout=function(){ requestResponsiveLayout('manual'); };
  st.destroyResponsive=function(){
    if(__rzT) clearTimeout(__rzT);
    if(__renderWaitT) clearTimeout(__renderWaitT);
    if(shadeObserver) shadeObserver.disconnect();
    window.removeEventListener('keydown', __metroKeydown, true);
    window.removeEventListener('resize', __reload);
    window.removeEventListener('orientationchange', __orientation);
    document.removeEventListener('fullscreenchange', __fullscreen);
    document.removeEventListener('webkitfullscreenchange', __fullscreen);
    document.removeEventListener('mozfullscreenchange', __fullscreen);
    window.removeEventListener('synpdf:metric-rendered', __metricRendered);
    if(window.visualViewport) window.visualViewport.removeEventListener('resize', __visualResize);
  };
}
boot();
})();