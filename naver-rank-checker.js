const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

const NAVER_CLIENT_ID = 'BG6nIW70fFABHFIJPEoi';
const NAVER_CLIENT_SECRET = 'TOAgJ637p3';
const SUPABASE_URL = 'https://gsgdizzwmhibvaopilws.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdzZ2Rpenp3bWhpYnZhb3BpbHdzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5MDc2NDAsImV4cCI6MjA5MDQ4MzY0MH0.mzeUN3nlAcu008frnbLNFzqgRAGjSaX-8mUHNBnCWyI';

function norm(id){return String(id).trim().replace(/^0+/,'')}
function wait(ms){return new Promise(r=>setTimeout(r,ms))}
function kstNow(){return new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Seoul'}))}
function fmtDate(d){return d.toISOString().split('T')[0]}

async function searchShopping(keyword,start=1,display=100){
  const url=`https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(keyword)}&display=${display}&start=${start}&sort=sim`;
  const r=await fetch(url,{headers:{'X-Naver-Client-Id':NAVER_CLIENT_ID,'X-Naver-Client-Secret':NAVER_CLIENT_SECRET}});
  if(!r.ok){console.log(`[API] HTTP ${r.status}`);return null}
  return await r.json();
}

async function checkShoppingRank(keyword,mid){
  const target=norm(mid);
  console.log(`[쇼핑] "${keyword}" / MID: ${target}`);
  for(let start=1;start<=1000;start+=100){
    const data=await searchShopping(keyword,start,100);
    if(!data||!data.items||!data.items.length)break;
    for(let i=0;i<data.items.length;i++){
      const p=data.items[i];
      const ids=[p.productId,p.mallProductId].filter(Boolean).map(v=>norm(String(v)));
      if(ids.includes(target)){const rank=start+i;console.log(`  찾음! ${rank}위`);return{rank}}
      if(p.link&&p.link.includes(target)){const rank=start+i;return{rank}}
    }
    await wait(200);
  }
  console.log('  1000위내 없음');
  return{rank:null};
}

async function sbFetch(path,opts={}){
  const url=SUPABASE_URL+'/rest/v1/'+path;
  const r=await fetch(url,{...opts,headers:{'apikey':SUPABASE_KEY,'Authorization':'Bearer '+SUPABASE_KEY,'Content-Type':'application/json','Prefer':'return=representation',...(opts.headers||{})}});
  if(!r.ok){const t=await r.text().catch(()=>'');console.log(`[SB] ${r.status} ${t.substring(0,200)}`);return null}
  return await r.json();
}

async function runScheduledRankCheck(){
  const today=fmtDate(kstNow());
  const h=kstNow().getHours();
  console.log(`\n${'='.repeat(50)}\n[스케줄] 진행중 쇼핑 캠페인 순위 일괄 조회 (${today} ${h}시)\n${'='.repeat(50)}`);

  const campaigns=await sbFetch('stitch_campaigns?status=eq.진행&mode=eq.shopping&select=id,main_keyword,shop_name');
  if(!campaigns||!campaigns.length){console.log('[스케줄] 진행중 쇼핑 캠페인 없음');return}
  console.log(`[스케줄] ${campaigns.length}개 캠페인 조회 시작`);

  for(const c of campaigns){
    try{
      const result=await checkShoppingRank(c.main_keyword,c.shop_name);
      const rank=result.rank||null;
      const existing=await sbFetch(`stitch_ranks?campaign_id=eq.${c.id}&checked_at=eq.${today}&select=id`);
      if(existing&&existing.length>0){
        await sbFetch(`stitch_ranks?id=eq.${existing[0].id}`,{method:'PATCH',body:JSON.stringify({rank_price:rank})});
      }else{
        await sbFetch('stitch_ranks',{method:'POST',body:JSON.stringify({campaign_id:c.id,keyword:c.main_keyword,product_id:c.shop_name,rank_price:rank,checked_at:today})});
      }
      console.log(`  #${c.id} "${c.main_keyword}" → ${rank?rank+'위':'순위권외'}`);
      await wait(500);
    }catch(e){console.error(`  #${c.id} 에러:`,e.message)}
  }
  console.log(`[스케줄] 완료\n`);
}

function startScheduler(){
  console.log('[스케줄] 매일 12시/18시(KST) 자동 순위 조회 활성화');
  let lastRun='';
  setInterval(()=>{
    const now=kstNow();
    const h=now.getHours();
    const m=now.getMinutes();
    const key=fmtDate(now)+'-'+h;
    if((h===12||h===18)&&m<2&&lastRun!==key){
      lastRun=key;
      runScheduledRankCheck().catch(e=>console.error('[스케줄] 에러:',e));
    }
  },30000);
}

app.get('/',(q,r)=>r.json({status:'ok',service:'stitch-rank-checker',schedule:'12:00,18:00 KST'}));

app.get('/rank',async(req,res)=>{
  const{keyword,mid}=req.query;
  if(!keyword||!mid)return res.status(400).json({error:'keyword, mid 필수'});
  console.log(`\n순위조회: "${keyword}" mid:${mid}`);
  try{
    const r=await checkShoppingRank(keyword,mid);
    const results={shopping:{rank:r.rank,method:'naver_api'}};
    console.log('결과:',JSON.stringify(results));
    res.json({keyword,mid,results});
  }catch(e){res.status(500).json({error:e.message})}
});

app.get('/run-schedule',async(req,res)=>{
  runScheduledRankCheck().catch(e=>console.error(e));
  res.json({status:'started',message:'순위 일괄 조회 시작됨'});
});

app.get('/debug',async(req,res)=>{
  const{keyword}=req.query;
  if(!keyword)return res.status(400).json({error:'keyword 필수'});
  try{
    const data=await searchShopping(keyword,1,5);
    if(!data)return res.json({error:'API 실패'});
    const items=(data.items||[]).map((p,i)=>({rank:i+1,title:p.title?.replace(/<[^>]*>/g,''),productId:p.productId,link:p.link,mallName:p.mallName}));
    res.json({keyword,total:data.total,items});
  }catch(e){res.status(500).json({error:e.message})}
});

app.listen(process.env.PORT||3000,()=>{
  console.log('Stitch Rank Checker running');
  startScheduler();
});
