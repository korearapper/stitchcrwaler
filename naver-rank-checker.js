const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

const UA = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];
const PAGES = 10;
const PP = 40;

function getUA(){return UA[Math.floor(Math.random()*UA.length)]}
function wait(ms){return new Promise(r=>setTimeout(r,ms))}
function norm(id){return String(id).trim().replace(/^0+/,'')}

async function checkRank(keyword, mid, productSet){
  const target = norm(mid);
  console.log(`[${productSet}] 타겟MID: "${target}" (원본: "${mid}")`);

  for(let pg=1;pg<=PAGES;pg++){
    const idx=(pg-1)*PP+1;
    const url=`https://search.shopping.naver.com/api/search/all?sort=rel&pagingIndex=${idx}&pagingSize=${PP}&viewType=list&productSet=${productSet}&query=${encodeURIComponent(keyword)}`;
    try{
      const r=await fetch(url,{headers:{
        'User-Agent':getUA(),
        'Accept':'application/json, text/plain, */*',
        'Accept-Language':'ko-KR,ko;q=0.9,en-US;q=0.8',
        'Referer':'https://search.shopping.naver.com/search/all?query='+encodeURIComponent(keyword),
        'sec-ch-ua':'"Google Chrome";v="131", "Chromium";v="131"',
        'sec-ch-ua-mobile':'?0',
        'sec-ch-ua-platform':'"Windows"',
        'sec-fetch-dest':'empty',
        'sec-fetch-mode':'cors',
        'sec-fetch-site':'same-origin',
      }});

      if(!r.ok){
        const txt=await r.text().catch(()=>'');
        console.log(`[${productSet}] pg${pg} HTTP ${r.status} body: ${txt.substring(0,200)}`);
        continue;
      }

      const j=await r.json();

      // 응답 구조 파악
      const keys = Object.keys(j);
      if(pg===1) console.log(`[${productSet}] 응답 키: ${keys.join(', ')}`);

      // 다양한 응답 구조 대응
      let items = [];
      if(j.shoppingResult?.products) items = j.shoppingResult.products;
      else if(j.products) items = j.products;
      else if(j.data?.products) items = j.data.products;
      else if(j.result?.products) items = j.result.products;
      else if(j.catalogResult?.products) items = j.catalogResult.products;
      else {
        // 전체 구조에서 products 배열 찾기
        for(const key of keys){
          if(j[key] && typeof j[key]==='object' && j[key].products){
            items = j[key].products;
            if(pg===1) console.log(`[${productSet}] products를 j.${key}.products에서 찾음`);
            break;
          }
        }
      }

      console.log(`[${productSet}] pg${pg}: ${items.length}개 상품`);
      if(!items.length && pg > 1) break;
      if(!items.length && pg === 1){
        console.log(`[${productSet}] 첫 페이지 응답 구조:`, JSON.stringify(j).substring(0, 500));
        break;
      }

      // 첫 페이지 첫 3개 상품의 ID 필드 로그
      if(pg===1){
        items.slice(0,3).forEach((p,i)=>{
          const allIds = {};
          for(const k of Object.keys(p)){
            if(typeof p[k]==='string' || typeof p[k]==='number'){
              if(String(p[k]).match(/^\d{5,}$/)) allIds[k]=p[k];
            }
          }
          console.log(`  상품${i+1}: ${p.productTitle?.substring(0,30)||p.title?.substring(0,30)||'?'}`);
          console.log(`    숫자ID필드: ${JSON.stringify(allIds)}`);
        });
      }

      for(let i=0;i<items.length;i++){
        const p=items[i];
        // 모든 숫자형 필드에서 매칭 시도
        const ids = [];
        for(const k of Object.keys(p)){
          const v = p[k];
          if(v && (typeof v==='string'||typeof v==='number')){
            const s = String(v);
            if(s.match(/^\d{5,}$/) || s.includes(target)){
              ids.push(norm(s));
            }
          }
        }
        // 중첩 객체 item 필드
        if(p.item){
          for(const k of Object.keys(p.item)){
            const v=p.item[k];
            if(v&&(typeof v==='string'||typeof v==='number')){
              const s=String(v);
              if(s.match(/^\d{5,}$/))ids.push(norm(s));
            }
          }
        }

        if(ids.includes(target)){
          const rank=(pg-1)*PP+i+1;
          console.log(`[${productSet}] 찾음! ${rank}위 (pg${pg} #${i+1})`);
          return{rank,page:pg};
        }

        // URL 내부 매칭
        const urlFields=[p.mallProductUrl,p.crUrl,p.adcrUrl,p.productUrl,p.link,p.mobileUrl].filter(Boolean);
        for(const u of urlFields){
          if(String(u).includes(target)){
            const rank=(pg-1)*PP+i+1;
            console.log(`[${productSet}] URL매칭! ${rank}위`);
            return{rank,page:pg};
          }
        }
      }
      await wait(300+Math.random()*700);
    }catch(e){console.error(`[${productSet}] pg${pg} 에러:`,e.message)}
  }
  console.log(`[${productSet}] ${PAGES}페이지 탐색 완료 - 찾지 못함`);
  return{rank:null};
}

app.get('/',(q,r)=>r.json({status:'ok',service:'stitch-rank-checker'}));

// 디버그용: 첫페이지 상품 목록 확인
app.get('/debug',async(req,res)=>{
  const{keyword,mid}=req.query;
  if(!keyword)return res.status(400).json({error:'keyword 필수'});
  const url=`https://search.shopping.naver.com/api/search/all?sort=rel&pagingIndex=1&pagingSize=5&viewType=list&productSet=total&query=${encodeURIComponent(keyword)}`;
  try{
    const r=await fetch(url,{headers:{'User-Agent':getUA(),'Accept':'application/json','Referer':'https://search.shopping.naver.com/search/all?query='+encodeURIComponent(keyword)}});
    const j=await r.json();
    let items=j.shoppingResult?.products||j.products||[];
    // 전체 키 탐색
    if(!items.length){
      for(const k of Object.keys(j)){
        if(j[k]?.products){items=j[k].products;break}
      }
    }
    const summary=items.slice(0,5).map((p,i)=>{
      const numIds={};
      for(const k of Object.keys(p)){
        if((typeof p[k]==='string'||typeof p[k]==='number')&&String(p[k]).match(/^\d{5,}$/)){
          numIds[k]=p[k];
        }
      }
      return{index:i+1,title:(p.productTitle||p.title||'').substring(0,40),numericIds:numIds};
    });
    res.json({keyword,responseKeys:Object.keys(j),productCount:items.length,first5:summary,rawFirstProduct:items[0]||null});
  }catch(e){res.status(500).json({error:e.message})}
});

app.get('/rank',async(req,res)=>{
  const{keyword,mid,type='both'}=req.query;
  if(!keyword||!mid)return res.status(400).json({error:'keyword, mid 필수'});
  console.log(`\n${'='.repeat(50)}\n순위조회: "${keyword}" mid:${mid} type:${type}\n${'='.repeat(50)}`);
  const results={};
  try{
    if(type==='price'||type==='both'){
      const p=await checkRank(keyword,mid,'total');
      results.price={rank:p.rank,method:'api'};
    }
    if(type==='plusstore'||type==='both'){
      if(type==='both')await wait(1500);
      const p=await checkRank(keyword,mid,'smartstore');
      results.plusstore={rank:p.rank,method:'api'};
    }
    console.log('최종결과:',JSON.stringify(results));
    res.json({keyword,mid,results});
  }catch(e){
    console.error('에러:',e);
    res.status(500).json({error:e.message});
  }
});

app.listen(process.env.PORT||3000,()=>console.log('Stitch Rank Checker running'));
