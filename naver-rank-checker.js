const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

const NAVER_CLIENT_ID = 'BG6nIW70fFABHFIJPEoi';
const NAVER_CLIENT_SECRET = 'TOAgJ637p3';

function norm(id){return String(id).trim().replace(/^0+/,'')}
function wait(ms){return new Promise(r=>setTimeout(r,ms))}

// 쇼핑 검색 API
async function searchShopping(keyword, start=1, display=100){
  const url=`https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(keyword)}&display=${display}&start=${start}&sort=sim`;
  const r=await fetch(url,{headers:{'X-Naver-Client-Id':NAVER_CLIENT_ID,'X-Naver-Client-Secret':NAVER_CLIENT_SECRET}});
  if(!r.ok){console.log(`[쇼핑API] HTTP ${r.status}`);return null}
  return await r.json();
}

// 지역(플레이스) 검색 API
async function searchLocal(keyword, start=1, display=5){
  const url=`https://openapi.naver.com/v1/search/local.json?query=${encodeURIComponent(keyword)}&display=${display}&start=${start}&sort=random`;
  const r=await fetch(url,{headers:{'X-Naver-Client-Id':NAVER_CLIENT_ID,'X-Naver-Client-Secret':NAVER_CLIENT_SECRET}});
  if(!r.ok){console.log(`[플레이스API] HTTP ${r.status}`);return null}
  return await r.json();
}

// 쇼핑 순위 조회
async function checkShoppingRank(keyword, mid){
  const target=norm(mid);
  console.log(`[쇼핑] "${keyword}" / MID: ${target}`);
  for(let start=1;start<=1000;start+=100){
    const data=await searchShopping(keyword,start,100);
    if(!data||!data.items||!data.items.length){break}
    console.log(`  start=${start}: ${data.items.length}개`);
    for(let i=0;i<data.items.length;i++){
      const p=data.items[i];
      const ids=[p.productId,p.mallProductId].filter(Boolean).map(v=>norm(String(v)));
      if(ids.includes(target)){const rank=start+i;console.log(`  찾음! ${rank}위`);return{rank}}
      if(p.link&&p.link.includes(target)){const rank=start+i;console.log(`  URL매칭! ${rank}위`);return{rank}}
    }
    await wait(200);
  }
  console.log('  1000위내 없음');
  return{rank:null};
}

// 플레이스 순위 조회 (업체명 매칭)
async function checkPlaceRank(keyword, shopName){
  const targetName=shopName.trim().toLowerCase().replace(/\s/g,'');
  console.log(`[플레이스] "${keyword}" / 업체: "${shopName}"`);
  for(let start=1;start<=300;start+=5){
    const data=await searchLocal(keyword,start,5);
    if(!data||!data.items||!data.items.length){break}
    console.log(`  start=${start}: ${data.items.length}개`);
    for(let i=0;i<data.items.length;i++){
      const p=data.items[i];
      const title=(p.title||'').replace(/<[^>]*>/g,'').trim().toLowerCase().replace(/\s/g,'');
      if(title===targetName||title.includes(targetName)||targetName.includes(title)){
        const rank=start+i;
        console.log(`  찾음! ${rank}위 "${p.title?.replace(/<[^>]*>/g,'')}"`);
        return{rank,title:p.title?.replace(/<[^>]*>/g,''),address:p.roadAddress||p.address,category:p.category};
      }
    }
    await wait(200);
  }
  console.log('  300위내 없음');
  return{rank:null};
}

app.get('/',(q,r)=>r.json({status:'ok',service:'stitch-rank-checker'}));

// 쇼핑 순위
app.get('/rank',async(req,res)=>{
  const{keyword,mid,type='shopping'}=req.query;
  if(!keyword)return res.status(400).json({error:'keyword 필수'});
  console.log(`\n순위조회: "${keyword}" mid:${mid||'-'} type:${type}`);
  try{
    const results={};
    if(type==='shopping'||type==='both'){
      if(!mid)return res.status(400).json({error:'mid 필수'});
      const r=await checkShoppingRank(keyword,mid);
      results.shopping={rank:r.rank,method:'naver_api'};
    }
    if(type==='place'||type==='both'){
      const shopName=req.query.shopName||'';
      if(!shopName)return res.status(400).json({error:'shopName 필수'});
      const r=await checkPlaceRank(keyword,shopName);
      results.place={rank:r.rank,method:'naver_api',title:r.title,address:r.address,category:r.category};
    }
    console.log('결과:',JSON.stringify(results));
    res.json({keyword,mid,results});
  }catch(e){console.error(e);res.status(500).json({error:e.message})}
});

// 디버그
app.get('/debug',async(req,res)=>{
  const{keyword,type='shopping'}=req.query;
  if(!keyword)return res.status(400).json({error:'keyword 필수'});
  try{
    if(type==='place'){
      const data=await searchLocal(keyword,1,5);
      if(!data)return res.json({error:'API 실패'});
      const items=(data.items||[]).map((p,i)=>({rank:i+1,title:p.title?.replace(/<[^>]*>/g,''),address:p.roadAddress||p.address,category:p.category,link:p.link}));
      return res.json({keyword,type,total:data.total,items});
    }
    const data=await searchShopping(keyword,1,5);
    if(!data)return res.json({error:'API 실패'});
    const items=(data.items||[]).map((p,i)=>({rank:i+1,title:p.title?.replace(/<[^>]*>/g,''),productId:p.productId,link:p.link,mallName:p.mallName}));
    res.json({keyword,type,total:data.total,items});
  }catch(e){res.status(500).json({error:e.message})}
});

app.listen(process.env.PORT||3000,()=>console.log('Stitch Rank Checker (Naver API) running'));
