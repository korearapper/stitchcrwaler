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
  for(let pg=1;pg<=PAGES;pg++){
    const idx=(pg-1)*PP+1;
    const url=`https://search.shopping.naver.com/api/search/all?sort=rel&pagingIndex=${idx}&pagingSize=${PP}&viewType=list&productSet=${productSet}&query=${encodeURIComponent(keyword)}`;
    try{
      const r=await fetch(url,{headers:{
        'User-Agent':getUA(),
        'Accept':'application/json',
        'Accept-Language':'ko-KR,ko;q=0.9',
        'Referer':'https://search.shopping.naver.com/search/all?query='+encodeURIComponent(keyword),
        'sec-ch-ua':'"Chrome";v="131"',
        'sec-fetch-dest':'empty','sec-fetch-mode':'cors','sec-fetch-site':'same-origin',
      }});
      if(!r.ok){console.log(`[${productSet}] pg${pg} HTTP ${r.status}`);continue}
      const j=await r.json();
      let items=j.shoppingResult?.products||j.products||[];
      if(!items.length&&pg>1)break;
      for(let i=0;i<items.length;i++){
        const p=items[i];
        const ids=[p.id,p.productId,p.nvMid,p.mallProductId,p.catalogId,p.adId,p.mallPid,p.nid].filter(Boolean).map(v=>norm(String(v)));
        if(ids.includes(target)){return{rank:(pg-1)*PP+i+1,page:pg}}
        const urls=[p.mallProductUrl,p.crUrl,p.adcrUrl,p.productUrl].filter(Boolean).join(' ');
        if(urls.includes(target)){return{rank:(pg-1)*PP+i+1,page:pg}}
      }
      await wait(300+Math.random()*700);
    }catch(e){console.error(`[${productSet}] pg${pg}`,e.message)}
  }
  return{rank:null};
}

app.get('/',(q,r)=>r.json({status:'ok'}));

app.get('/rank',async(req,res)=>{
  const{keyword,mid,type='both'}=req.query;
  if(!keyword||!mid)return res.status(400).json({error:'keyword, mid 필수'});
  console.log(`순위조회: "${keyword}" mid:${mid} type:${type}`);
  const results={};
  try{
    if(type==='price'||type==='both'){
      const p=await checkRank(keyword,mid,'total');
      results.price={rank:p.rank,method:'api'};
    }
    if(type==='plusstore'||type==='both'){
      if(type==='both')await wait(1000);
      const p=await checkRank(keyword,mid,'smartstore');
      results.plusstore={rank:p.rank,method:'api'};
    }
    console.log('결과:',JSON.stringify(results));
    res.json({keyword,mid,results});
  }catch(e){res.status(500).json({error:e.message})}
});

app.listen(process.env.PORT||3000,()=>console.log('Rank Checker OK'));
