const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

const NAVER_CLIENT_ID = 'BG6nIW70fFABHFIJPEoi';
const NAVER_CLIENT_SECRET = 'TOAgJ637p3';

function norm(id){return String(id).trim().replace(/^0+/,'')}
function wait(ms){return new Promise(r=>setTimeout(r,ms))}

async function searchShopping(keyword, start=1, display=100){
  const url=`https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(keyword)}&display=${display}&start=${start}&sort=sim`;
  const r=await fetch(url,{
    headers:{
      'X-Naver-Client-Id':NAVER_CLIENT_ID,
      'X-Naver-Client-Secret':NAVER_CLIENT_SECRET,
    }
  });
  if(!r.ok){
    const t=await r.text().catch(()=>'');
    console.log(`API HTTP ${r.status}: ${t.substring(0,200)}`);
    return null;
  }
  return await r.json();
}

async function checkRank(keyword, mid){
  const target=norm(mid);
  console.log(`[검색] "${keyword}" / MID: ${target}`);

  // 네이버 API: start 최대 1000, display 최대 100
  // 100개씩 10페이지 = 최대 1000위까지 탐색
  for(let start=1;start<=1000;start+=100){
    const data=await searchShopping(keyword, start, 100);
    if(!data||!data.items||!data.items.length){
      console.log(`  start=${start}: 결과 없음`);
      break;
    }
    console.log(`  start=${start}: ${data.items.length}개`);

    for(let i=0;i<data.items.length;i++){
      const p=data.items[i];
      // productId 매칭
      const ids=[p.productId,p.mallProductId].filter(Boolean).map(v=>norm(String(v)));
      if(ids.includes(target)){
        const rank=start+i;
        console.log(`  찾음! ${rank}위 (productId 매칭)`);
        return {rank};
      }
      // link URL에서 매칭
      if(p.link&&p.link.includes(target)){
        const rank=start+i;
        console.log(`  찾음! ${rank}위 (link URL 매칭)`);
        return {rank};
      }
    }
    // 다음 페이지 딜레이
    await wait(200);
  }
  console.log('  1000위 내 없음');
  return {rank:null};
}

app.get('/',(q,r)=>r.json({status:'ok',service:'stitch-rank-checker'}));

app.get('/rank',async(req,res)=>{
  const{keyword,mid,type='both'}=req.query;
  if(!keyword||!mid)return res.status(400).json({error:'keyword, mid 필수'});
  console.log(`\n순위조회: "${keyword}" mid:${mid} type:${type}`);
  try{
    const results={};
    // 네이버 쇼핑 검색 API는 가격비교/플러스스토어 구분이 없음
    // 통합 검색 결과에서 순위 반환
    const r=await checkRank(keyword,mid);
    results.price={rank:r.rank,method:'api'};
    results.plusstore={rank:r.rank,method:'api'};
    console.log('결과:',JSON.stringify(results));
    res.json({keyword,mid,results});
  }catch(e){
    console.error('에러:',e.message);
    res.status(500).json({error:e.message});
  }
});

app.get('/debug',async(req,res)=>{
  const{keyword}=req.query;
  if(!keyword)return res.status(400).json({error:'keyword 필수'});
  try{
    const data=await searchShopping(keyword,1,5);
    if(!data)return res.json({error:'API 호출 실패'});
    const items=(data.items||[]).map((p,i)=>({
      rank:i+1,
      title:p.title?.replace(/<[^>]*>/g,''),
      productId:p.productId,
      mallProductId:p.mallProductId,
      link:p.link,
      mallName:p.mallName,
      lprice:p.lprice,
    }));
    res.json({keyword,total:data.total,items});
  }catch(e){res.status(500).json({error:e.message})}
});

app.listen(process.env.PORT||3000,()=>console.log('Stitch Rank Checker (Naver API) running'));
