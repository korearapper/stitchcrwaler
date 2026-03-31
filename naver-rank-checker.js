const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const SESSION_PATH = path.join(__dirname, 'naver-session.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAGES = 10;
const PP = 40;

function wait(ms){return new Promise(r=>setTimeout(r,ms))}
function norm(id){return String(id).trim().replace(/^0+/,'')}
function rnd(min,max){return Math.floor(Math.random()*(max-min+1))+min}

// 브라우저 싱글톤 (매 요청마다 새로 만들지 않음)
let browser = null;
let context = null;

async function getBrowser(){
  if(browser && browser.isConnected()) return {browser, context};

  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1920,1080',
      '--disable-dev-shm-usage',
    ],
  });

  const ctxOpts = {
    userAgent: UA,
    viewport: {width:1920,height:1080},
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    geolocation: {longitude:126.978,latitude:37.5665},
    permissions: ['geolocation'],
    extraHTTPHeaders: {
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
    },
  };

  // 저장된 세션 있으면 사용
  if(fs.existsSync(SESSION_PATH)){
    try{ctxOpts.storageState = SESSION_PATH; console.log('[세션] 복원')}catch(_){}
  }

  context = await browser.newContext(ctxOpts);

  // navigator.webdriver 우회 + fingerprint
  await context.addInitScript(()=>{
    Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
    Object.defineProperty(navigator,'plugins',{get:()=>[
      {name:'Chrome PDF Plugin',filename:'internal-pdf-viewer'},
      {name:'Chrome PDF Viewer',filename:'mhjfbmdgcfjbbpaeojofohoefgiehjai'},
      {name:'Native Client',filename:'internal-nacl-plugin'},
    ]});
    Object.defineProperty(navigator,'languages',{get:()=>['ko-KR','ko','en-US','en']});
    window.chrome={runtime:{},loadTimes:()=>{},csi:()=>{}};
    const oq=window.navigator.permissions?.query;
    if(oq)window.navigator.permissions.query=(p)=>p.name==='notifications'?Promise.resolve({state:Notification.permission}):oq(p);
  });

  console.log('[브라우저] 시작 완료');
  return {browser, context};
}

// 네이버 쇼핑 페이지 방문 (세션/쿠키 활성화)
async function warmUpPage(page, keyword){
  const url = 'https://search.shopping.naver.com/search/all?query='+encodeURIComponent(keyword);
  await page.goto(url, {waitUntil:'domcontentloaded', timeout:20000});
  // 사람처럼 스크롤
  await page.mouse.move(rnd(200,800), rnd(200,400));
  await wait(rnd(1500,3000));
  await page.evaluate(()=>window.scrollBy(0, 300));
  await wait(rnd(500,1000));
}

// ============================================
// API 방식: page.evaluate 내부 fetch (브라우저 세션)
// ============================================
async function checkRankAPI(page, keyword, mid, productSet){
  const target = norm(mid);
  console.log(`[API/${productSet}] 타겟: ${target}`);

  const result = await page.evaluate(async({keyword, target, productSet, PAGES, PP})=>{
    for(let pg=1; pg<=PAGES; pg++){
      const idx = (pg-1)*PP+1;
      const url = `https://search.shopping.naver.com/api/search/all?sort=rel&pagingIndex=${idx}&pagingSize=${PP}&viewType=list&productSet=${productSet}&query=${encodeURIComponent(keyword)}`;

      try{
        const res = await fetch(url, {
          credentials: 'include',
          headers: {
            'Accept':'application/json, text/plain, */*',
            'Referer':'https://search.shopping.naver.com/search/all?query='+encodeURIComponent(keyword),
          }
        });
        if(!res.ok) return {rank:null, error:'HTTP '+res.status, page:pg};

        const j = await res.json();

        // 상품 목록 추출 (다양한 응답 구조 대응)
        let items = [];
        if(j.shoppingResult?.products) items=j.shoppingResult.products;
        else if(j.products) items=j.products;
        else if(j.data?.products) items=j.data.products;
        else {
          for(const k of Object.keys(j)){
            if(j[k]&&typeof j[k]==='object'&&j[k].products){items=j[k].products;break}
          }
        }

        if(!items.length && pg>1) return {rank:null, error:'no_more', page:pg};

        // 로그: 첫 페이지 첫 상품 ID 필드
        if(pg===1 && items.length>0){
          const p=items[0];
          const ids={};
          for(const k of Object.keys(p)){
            if((typeof p[k]==='string'||typeof p[k]==='number')&&String(p[k]).match(/^\d{5,}$/)){
              ids[k]=String(p[k]);
            }
          }
          console.log('[API] 첫상품 IDs:', JSON.stringify(ids));
        }

        // 매칭
        for(let i=0;i<items.length;i++){
          const p=items[i];
          // 모든 숫자형 필드 스캔
          for(const k of Object.keys(p)){
            const v=p[k];
            if(v&&(typeof v==='string'||typeof v==='number')){
              const s=String(v).trim().replace(/^0+/,'');
              if(s===target) return {rank:(pg-1)*PP+i+1, page:pg, field:k};
              if(String(v).includes(target)) return {rank:(pg-1)*PP+i+1, page:pg, field:k+'(contains)'};
            }
          }
          // 중첩 item
          if(p.item){
            for(const k of Object.keys(p.item)){
              const v=p.item[k];
              if(v&&(typeof v==='string'||typeof v==='number')){
                const s=String(v).trim().replace(/^0+/,'');
                if(s===target||String(v).includes(target)) return {rank:(pg-1)*PP+i+1, page:pg, field:'item.'+k};
              }
            }
          }
          // URL 필드
          const urls=[p.mallProductUrl,p.crUrl,p.adcrUrl,p.productUrl,p.link,p.mobileUrl].filter(Boolean);
          for(const u of urls){
            if(String(u).includes(target)) return {rank:(pg-1)*PP+i+1, page:pg, field:'url'};
          }
        }

        // 페이지 간 딜레이
        await new Promise(r=>setTimeout(r, Math.floor(Math.random()*800)+300));

      }catch(e){
        return {rank:null, error:e.message, page:pg};
      }
    }
    return {rank:null, error:'not_found'};
  }, {keyword, target, productSet, PAGES, PP});

  console.log(`[API/${productSet}] 결과:`, JSON.stringify(result));
  return result;
}

// ============================================
// DOM 방식: Playwright fallback
// ============================================
async function checkRankDOM(page, keyword, mid, productSet){
  const target = norm(mid);
  console.log(`[DOM/${productSet}] fallback 시작`);

  let searchUrl = 'https://search.shopping.naver.com/search/all?query='+encodeURIComponent(keyword)+'&sort=rel';
  if(productSet==='smartstore') searchUrl+='&productSet=smartstore';

  await page.goto(searchUrl, {waitUntil:'networkidle', timeout:20000});
  await wait(rnd(2000,3500));

  let globalRank=0;
  for(let pg=1;pg<=Math.min(PAGES,5);pg++){
    // 스크롤 다운
    for(let s=0;s<6;s++){
      await page.evaluate(()=>window.scrollBy(0,window.innerHeight));
      await wait(rnd(200,500));
    }

    const found = await page.evaluate((tid)=>{
      const results=[];
      const sels=['[class*="product_item"]','[class*="basicList_item"]','[data-shp-contents-type]','[data-nclick]'];
      let els=[];
      for(const s of sels){els=document.querySelectorAll(s);if(els.length>0)break}

      for(let i=0;i<els.length;i++){
        const el=els[i];
        const html=el.outerHTML.substring(0,3000);
        const links=Array.from(el.querySelectorAll('a[href]')).map(a=>a.href).join(' ');
        const mids=[];

        // 다양한 패턴
        const m1=links.match(/\/catalog\/(\d+)/);if(m1)mids.push(m1[1]);
        const m2=links.match(/[?&]nvMid=(\d+)/);if(m2)mids.push(m2[1]);
        const m3=links.match(/[?&]nv_mid=(\d+)/);if(m3)mids.push(m3[1]);
        const m4=(el.getAttribute('data-nclick')||'').match(/i:(\d+)/);if(m4)mids.push(m4[1]);
        const m5=el.getAttribute('data-shp-contents-id');if(m5)mids.push(m5);
        const m6=html.match(/productId["\s:=]+["]*(\d{8,})/);if(m6)mids.push(m6[1]);
        const m7=links.match(/products\/(\d+)/);if(m7)mids.push(m7[1]);
        // nvMid in HTML
        const m8=html.match(/nvMid["\s:=]+["]*(\d{8,})/);if(m8)mids.push(m8[1]);

        results.push({idx:i,mids:[...new Set(mids)]});
      }
      return results;
    }, target);

    for(const item of found){
      globalRank++;
      for(const m of item.mids){
        if(norm(m)===target||m.includes(target)){
          console.log(`[DOM/${productSet}] 찾음! ${globalRank}위`);
          return {rank:globalRank, page:pg, method:'dom'};
        }
      }
    }

    // 다음 페이지
    if(pg<5){
      const next=await page.$('a[class*="next"]')||await page.$(`button:has-text("${pg+1}")`);
      if(next){await next.click();await wait(rnd(2000,3500));globalRank=pg*PP}
      else break;
    }
  }
  console.log(`[DOM/${productSet}] 찾지 못함`);
  return {rank:null};
}

// ============================================
// 메인 순위 조회
// ============================================
async function checkRank(keyword, mid, type='both'){
  const {context} = await getBrowser();
  const page = await context.newPage();
  const results = {};

  try{
    // 웜업: 네이버 쇼핑 방문 (쿠키/세션)
    await warmUpPage(page, keyword);

    // 가격비교
    if(type==='price'||type==='both'){
      console.log('--- 가격비교 ---');
      let r = await checkRankAPI(page, keyword, mid, 'total');
      if(r.rank===null){
        console.log('[가격비교] API 실패 → DOM fallback');
        r = await checkRankDOM(page, keyword, mid, 'total');
        r.method='dom';
      }
      results.price={rank:r.rank, method:r.method||'api'};
    }

    // 플러스스토어
    if(type==='plusstore'||type==='both'){
      await wait(rnd(2000,4000));
      console.log('--- 플러스스토어 ---');
      let r = await checkRankAPI(page, keyword, mid, 'smartstore');
      if(r.rank===null){
        console.log('[플러스스토어] API 실패 → DOM fallback');
        r = await checkRankDOM(page, keyword, mid, 'smartstore');
        r.method='dom';
      }
      results.plusstore={rank:r.rank, method:r.method||'api'};
    }

    // 세션 저장
    try{await context.storageState({path:SESSION_PATH})}catch(_){}

  }catch(e){
    console.error('checkRank 에러:', e.message);
  }finally{
    await page.close().catch(()=>{});
  }

  return results;
}

// ============================================
// Express 서버
// ============================================
app.get('/',(q,r)=>r.json({status:'ok',service:'stitch-rank-checker'}));

app.get('/debug',async(req,res)=>{
  const{keyword}=req.query;
  if(!keyword)return res.status(400).json({error:'keyword 필수'});
  try{
    const{context}=await getBrowser();
    const page=await context.newPage();
    await warmUpPage(page,keyword);
    const data=await page.evaluate(async(kw)=>{
      const url=`https://search.shopping.naver.com/api/search/all?sort=rel&pagingIndex=1&pagingSize=5&viewType=list&productSet=total&query=${encodeURIComponent(kw)}`;
      const r=await fetch(url,{credentials:'include',headers:{'Accept':'application/json'}});
      return await r.json();
    },keyword);
    let items=data.shoppingResult?.products||data.products||[];
    if(!items.length){for(const k of Object.keys(data)){if(data[k]?.products){items=data[k].products;break}}}
    const summary=items.slice(0,5).map((p,i)=>{
      const ids={};
      for(const k of Object.keys(p)){if((typeof p[k]==='string'||typeof p[k]==='number')&&String(p[k]).match(/^\d{5,}$/)){ids[k]=p[k]}}
      return{i:i+1,title:(p.productTitle||p.title||'').substring(0,40),ids};
    });
    await page.close();
    res.json({keyword,keys:Object.keys(data),count:items.length,products:summary});
  }catch(e){res.status(500).json({error:e.message})}
});

app.get('/rank',async(req,res)=>{
  const{keyword,mid,type='both'}=req.query;
  if(!keyword||!mid)return res.status(400).json({error:'keyword, mid 필수'});
  console.log(`\n${'='.repeat(50)}\n순위조회: "${keyword}" mid:${mid} type:${type}\n${'='.repeat(50)}`);
  try{
    const results=await checkRank(keyword,mid,type);
    console.log('최종:', JSON.stringify(results));
    res.json({keyword,mid,results});
  }catch(e){
    console.error('에러:',e);
    res.status(500).json({error:e.message});
  }
});

// 브라우저 정리
process.on('SIGINT',async()=>{if(browser)await browser.close();process.exit()});
process.on('SIGTERM',async()=>{if(browser)await browser.close();process.exit()});

app.listen(process.env.PORT||3000,()=>console.log('Stitch Rank Checker (Playwright) running'));
