/**
 * ============================================================
 * 네이버 쇼핑 순위 조회 (Naver Shopping Rank Checker)
 * ============================================================
 * - 1차: 브라우저 내부 fetch (API 방식) → 빠르고 정확
 * - 2차: Playwright DOM 크롤링 (fallback) → API 실패 시
 * - 가격비교 / 플러스스토어 모두 지원
 * ============================================================
 * 사용법:
 *   node naver-rank-checker.js "여성 파자마" "81782266840"
 *   node naver-rank-checker.js "여성 파자마" "81782266840" --type=plusstore
 * ============================================================
 */

const { chromium } = require('playwright');
const path = require('path');

// ============================================================
// 설정
// ============================================================
const CONFIG = {
  PAGES_TO_SEARCH: 10,        // 최대 탐색 페이지 수
  ITEMS_PER_PAGE: 40,         // 페이지당 상품 수
  MIN_DELAY: 2000,            // 최소 딜레이 (ms)
  MAX_DELAY: 5000,            // 최대 딜레이 (ms)
  TYPING_DELAY: 80,           // 타이핑 딜레이 (ms)
  STORAGE_STATE_PATH: path.join(__dirname, 'naver-session.json'),
  USER_AGENTS: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  ],
};

// ============================================================
// 유틸 함수
// ============================================================

/** 랜덤 딜레이 */
function randomDelay(min = CONFIG.MIN_DELAY, max = CONFIG.MAX_DELAY) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(r => setTimeout(r, ms));
}

/** 랜덤 User-Agent */
function getRandomUA() {
  return CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];
}

/** productId 정규화 (문자열로 통일) */
function normalizeId(id) {
  return String(id).trim().replace(/^0+/, '');
}

/** 상품 목록에서 productId 매칭하여 순위 반환 */
function findRankInItems(items, productId) {
  const targetId = normalizeId(productId);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    // 다양한 ID 필드에서 매칭 시도
    const candidates = [
      item.id,
      item.productId,
      item.nvMid,
      item.nv_mid,
      item.mallProductId,
      item.catalogId,
      item.catalog_id,
      item.crUrl,     // 클릭 URL에 mid 포함
      item.adcrUrl,
    ].filter(Boolean).map(String);

    for (const cand of candidates) {
      if (normalizeId(cand) === targetId) return i;
      // URL 내부에 mid가 포함된 경우
      if (cand.includes(targetId)) return i;
    }
  }
  return -1;
}

// ============================================================
// 1차: API 방식 — page.evaluate 내부에서 fetch
// ============================================================

/**
 * 브라우저 컨텍스트 안에서 네이버 쇼핑 내부 API 호출
 * @param {import('playwright').Page} page - Playwright 페이지
 * @param {string} keyword - 검색 키워드
 * @param {string} productId - 상품 ID (mid)
 * @param {string} searchType - "price" (가격비교) | "plusstore" (플러스스토어)
 * @returns {{ rank: number|null, method: string }}
 */
async function checkRankViaAPI(page, keyword, productId, searchType = 'price') {
  console.log(`[API] 키워드: "${keyword}" | MID: ${productId} | 타입: ${searchType}`);

  // 먼저 네이버 쇼핑 페이지 방문 (쿠키/세션 활성화)
  await page.goto('https://search.shopping.naver.com/search/all?query=' + encodeURIComponent(keyword), {
    waitUntil: 'domcontentloaded',
    timeout: 15000,
  });
  await randomDelay(1500, 3000);

  // page.evaluate 내부에서 fetch 실행 (실제 브라우저 세션 기반)
  const result = await page.evaluate(async ({ keyword, productId, searchType, pages, perPage }) => {
    const targetId = String(productId).trim().replace(/^0+/, '');

    for (let pageIdx = 1; pageIdx <= pages; pageIdx++) {
      const pagingIndex = (pageIdx - 1) * perPage + 1;

      // 네이버 쇼핑 내부 API URL
      let apiUrl;
      if (searchType === 'plusstore') {
        // 플러스스토어 (스마트스토어) 검색
        apiUrl = `https://search.shopping.naver.com/api/search/all?sort=rel&pagingIndex=${pagingIndex}&pagingSize=${perPage}&viewType=list&productSet=smartstore&query=${encodeURIComponent(keyword)}`;
      } else {
        // 가격비교 검색
        apiUrl = `https://search.shopping.naver.com/api/search/all?sort=rel&pagingIndex=${pagingIndex}&pagingSize=${perPage}&viewType=list&productSet=total&query=${encodeURIComponent(keyword)}`;
      }

      try {
        const resp = await fetch(apiUrl, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'Accept': 'application/json',
            'Referer': 'https://search.shopping.naver.com/search/all?query=' + encodeURIComponent(keyword),
          },
        });

        if (!resp.ok) return { rank: null, method: 'api', error: `HTTP ${resp.status}`, page: pageIdx };

        const json = await resp.json();

        // 상품 목록 추출 (API 응답 구조가 버전마다 다름)
        let products = [];
        if (json.shoppingResult && json.shoppingResult.products) {
          products = json.shoppingResult.products;
        } else if (json.products) {
          products = json.products;
        } else if (json.data && json.data.products) {
          products = json.data.products;
        }

        if (!products.length && pageIdx > 1) {
          // 더 이상 결과 없음
          return { rank: null, method: 'api', error: 'no_more_results', page: pageIdx };
        }

        // 순위 검색
        for (let i = 0; i < products.length; i++) {
          const p = products[i];
          const ids = [
            p.id, p.productId, p.nvMid, p.nv_mid,
            p.mallProductId, p.catalogId, p.catalog_id,
            p.adId, p.item && p.item.productId,
            p.crUrl, p.adcrUrl, p.mallPid,
          ].filter(Boolean).map(String);

          for (const cid of ids) {
            const norm = cid.trim().replace(/^0+/, '');
            if (norm === targetId || cid.includes(targetId)) {
              const rank = (pageIdx - 1) * perPage + i + 1;
              return { rank, method: 'api', page: pageIdx, indexInPage: i + 1 };
            }
          }
        }

        // 딜레이 (브라우저 내부)
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 1500) + 500));

      } catch (err) {
        return { rank: null, method: 'api', error: err.message, page: pageIdx };
      }
    }

    return { rank: null, method: 'api', error: 'not_found' };
  }, {
    keyword,
    productId,
    searchType,
    pages: CONFIG.PAGES_TO_SEARCH,
    perPage: CONFIG.ITEMS_PER_PAGE,
  });

  console.log(`[API] 결과:`, result);
  return result;
}

// ============================================================
// 2차: Playwright DOM 크롤링 방식 (fallback)
// ============================================================

/**
 * 실제 브라우저에서 DOM 파싱으로 순위 조회
 * @param {import('playwright').BrowserContext} context
 * @param {string} keyword
 * @param {string} productId
 * @param {string} searchType
 * @returns {{ rank: number|null, method: string }}
 */
async function checkRankViaPlaywright(context, keyword, productId, searchType = 'price') {
  console.log(`[Playwright] 키워드: "${keyword}" | MID: ${productId} | 타입: ${searchType}`);

  const page = await context.newPage();
  const targetId = normalizeId(productId);

  try {
    // 검색 URL 구성
    let searchUrl = `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(keyword)}&sort=rel`;
    if (searchType === 'plusstore') {
      searchUrl += '&productSet=smartstore';
    }

    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 20000 });
    await randomDelay(2000, 4000);

    // 사용자 행동 시뮬레이션: 마우스 이동
    await page.mouse.move(
      Math.floor(Math.random() * 800) + 100,
      Math.floor(Math.random() * 400) + 100
    );

    let globalRank = 0;

    for (let pageNum = 1; pageNum <= CONFIG.PAGES_TO_SEARCH; pageNum++) {
      console.log(`[Playwright] ${pageNum}/${CONFIG.PAGES_TO_SEARCH} 페이지 탐색 중...`);

      // 스크롤 다운 (lazy-load 대응)
      for (let s = 0; s < 5; s++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await randomDelay(300, 800);
      }

      // 상품 요소 수집
      const items = await page.evaluate((tid) => {
        const results = [];
        // 상품 카드 셀렉터 (네이버 쇼핑 구조)
        const selectors = [
          '[class*="product_item"]',
          '[class*="basicList_item"]',
          '[class*="list_basis"]',
          '.shopProduct',
          '[data-shp-contents-type]',
          '[data-nclick]',
        ];

        let elements = [];
        for (const sel of selectors) {
          elements = document.querySelectorAll(sel);
          if (elements.length > 0) break;
        }

        elements.forEach((el, idx) => {
          const links = el.querySelectorAll('a[href]');
          const allHrefs = Array.from(links).map(a => a.href).join(' ');
          const dataNclick = el.getAttribute('data-nclick') || '';
          const dataShp = el.getAttribute('data-shp-contents-id') || '';
          const outerHtml = el.outerHTML.substring(0, 2000);

          // MID 추출 시도
          const mids = [];

          // 1) /catalog/{mid} 패턴
          const catalogMatch = allHrefs.match(/\/catalog\/(\d+)/);
          if (catalogMatch) mids.push(catalogMatch[1]);

          // 2) nvMid= 파라미터
          const nvMidMatch = allHrefs.match(/[?&]nvMid=(\d+)/);
          if (nvMidMatch) mids.push(nvMidMatch[1]);

          // 3) nv_mid= 파라미터
          const nvMid2Match = allHrefs.match(/[?&]nv_mid=(\d+)/);
          if (nvMid2Match) mids.push(nvMid2Match[1]);

          // 4) data-nclick 속성에서 추출
          const nclickMatch = dataNclick.match(/i:(\d+)/);
          if (nclickMatch) mids.push(nclickMatch[1]);

          // 5) data-shp-contents-id
          if (dataShp) mids.push(dataShp);

          // 6) HTML 내부에서 productId 추출
          const pidMatch = outerHtml.match(/productId["\s:=]+["\s]*(\d{8,})/);
          if (pidMatch) mids.push(pidMatch[1]);

          // 7) smartstore URL에서 products/{id} 추출
          const storeMatch = allHrefs.match(/products\/(\d+)/);
          if (storeMatch) mids.push(storeMatch[1]);

          results.push({
            index: idx,
            mids: [...new Set(mids)],
            title: el.textContent?.substring(0, 50)?.trim() || '',
          });
        });

        return results;
      }, targetId);

      // 순위 매칭
      for (const item of items) {
        globalRank++;
        for (const mid of item.mids) {
          const normMid = mid.trim().replace(/^0+/, '');
          if (normMid === targetId || mid.includes(targetId)) {
            console.log(`[Playwright] 찾음! 순위: ${globalRank} (${pageNum}페이지 ${item.index + 1}번째)`);
            await page.close();
            return {
              rank: globalRank,
              method: 'playwright',
              page: pageNum,
              indexInPage: item.index + 1,
            };
          }
        }
      }

      // 다음 페이지 이동
      if (pageNum < CONFIG.PAGES_TO_SEARCH) {
        const nextBtn = await page.$(`a[href*="pagingIndex=${pageNum * CONFIG.ITEMS_PER_PAGE + 1}"]`)
          || await page.$('.pagination_next__')
          || await page.$('a[class*="next"]')
          || await page.$(`button:has-text("${pageNum + 1}")`);

        if (nextBtn) {
          // 마우스를 버튼 위로 자연스럽게 이동
          const box = await nextBtn.boundingBox();
          if (box) {
            await page.mouse.move(
              box.x + box.width / 2 + Math.random() * 10 - 5,
              box.y + box.height / 2 + Math.random() * 5 - 2,
              { steps: Math.floor(Math.random() * 10) + 5 }
            );
            await randomDelay(300, 800);
          }
          await nextBtn.click();
          await randomDelay(2000, 4000);
          // 스크롤 맨 위로
          await page.evaluate(() => window.scrollTo(0, 0));
          await randomDelay(500, 1000);
          globalRank = pageNum * CONFIG.ITEMS_PER_PAGE; // 다음 페이지 기준점 리셋
        } else {
          console.log(`[Playwright] 다음 페이지 버튼 없음. 탐색 종료.`);
          break;
        }
      }
    }

    await page.close();
    return { rank: null, method: 'playwright', error: 'not_found' };

  } catch (err) {
    console.error(`[Playwright] 에러:`, err.message);
    try { await page.close(); } catch (_) {}
    return { rank: null, method: 'playwright', error: err.message };
  }
}

// ============================================================
// 메인 함수: API → Playwright fallback
// ============================================================

/**
 * 네이버 쇼핑 순위 조회 메인 함수
 * @param {string} keyword - 검색 키워드
 * @param {string} productId - 상품 ID (mid)
 * @param {object} options
 * @param {string} options.type - "price" (가격비교) | "plusstore" (플러스스토어) | "both" (둘 다)
 * @param {boolean} options.headless - headless 모드 (기본 true)
 * @returns {Promise<object>}
 */
async function checkRank(keyword, productId, options = {}) {
  const { type = 'both', headless = true } = options;
  const ua = getRandomUA();

  console.log('='.repeat(60));
  console.log(`순위 조회 시작`);
  console.log(`키워드: "${keyword}" | MID: ${productId}`);
  console.log(`타입: ${type} | UA: ${ua.substring(0, 50)}...`);
  console.log('='.repeat(60));

  // 브라우저 실행 — fingerprint 우회 적용
  const browser = await chromium.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1920,1080',
    ],
  });

  // 컨텍스트 생성 — storageState 사용 시도
  let contextOptions = {
    userAgent: ua,
    viewport: { width: 1920, height: 1080 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    geolocation: { longitude: 126.978, latitude: 37.5665 },
    permissions: ['geolocation'],
  };

  // 저장된 세션 파일이 있으면 사용
  try {
    const fs = require('fs');
    if (fs.existsSync(CONFIG.STORAGE_STATE_PATH)) {
      contextOptions.storageState = CONFIG.STORAGE_STATE_PATH;
      console.log('[설정] 저장된 세션 사용');
    }
  } catch (_) {}

  const context = await browser.newContext(contextOptions);

  // navigator.webdriver 우회
  await context.addInitScript(() => {
    // webdriver 속성 제거
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // plugins 위조
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        { name: 'Native Client', filename: 'internal-nacl-plugin' },
      ],
    });
    // languages 설정
    Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
    // chrome 객체 위조
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
    // permissions 쿼리 우회
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    }
  });

  const results = {};

  try {
    // API 페이지 생성 (한 번만)
    const apiPage = await context.newPage();

    // ---- 가격비교 순위 ----
    if (type === 'price' || type === 'both') {
      console.log('\n--- 가격비교 순위 조회 ---');
      const priceResult = await checkRankViaAPI(apiPage, keyword, productId, 'price');

      if (priceResult.rank !== null) {
        results.price = priceResult;
      } else {
        console.log('[API 실패] Playwright fallback 시도...');
        await randomDelay(3000, 5000);
        results.price = await checkRankViaPlaywright(context, keyword, productId, 'price');
      }
    }

    // ---- 플러스스토어 순위 ----
    if (type === 'plusstore' || type === 'both') {
      await randomDelay(3000, 6000); // 연속 요청 방지
      console.log('\n--- 플러스스토어 순위 조회 ---');
      const plusResult = await checkRankViaAPI(apiPage, keyword, productId, 'plusstore');

      if (plusResult.rank !== null) {
        results.plusstore = plusResult;
      } else {
        console.log('[API 실패] Playwright fallback 시도...');
        await randomDelay(3000, 5000);
        results.plusstore = await checkRankViaPlaywright(context, keyword, productId, 'plusstore');
      }
    }

    await apiPage.close();

    // 세션 저장 (다음 실행에 재사용)
    try {
      await context.storageState({ path: CONFIG.STORAGE_STATE_PATH });
      console.log('\n[세션] 저장 완료');
    } catch (_) {}

  } finally {
    await context.close();
    await browser.close();
  }

  // 최종 결과 출력
  console.log('\n' + '='.repeat(60));
  console.log('최종 결과:');
  console.log(JSON.stringify(results, null, 2));
  console.log('='.repeat(60));

  return results;
}

// ============================================================
// Express 서버 (Railway 배포용)
// ============================================================

/**
 * API 서버로 실행 시 사용
 * GET /rank?keyword=여성파자마&mid=81782266840&type=both
 */
function startServer(port = 3000) {
  const express = require('express');
  const cors = require('cors');
  const app = express();

  app.use(cors());
  app.use(express.json());

  // 헬스체크
  app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'naver-rank-checker' });
  });

  // 순위 조회 API
  app.get('/rank', async (req, res) => {
    const { keyword, mid, type = 'both' } = req.query;
    if (!keyword || !mid) {
      return res.status(400).json({ error: 'keyword, mid 필수' });
    }

    try {
      const result = await checkRank(keyword, mid, { type, headless: true });
      res.json({
        keyword,
        mid,
        type,
        timestamp: new Date().toISOString(),
        results: result,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 배치 순위 조회 (여러 키워드 한번에)
  app.post('/rank/batch', async (req, res) => {
    const { items } = req.body;
    // items: [{ keyword, mid, type }]
    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'items 배열 필수' });
    }

    const results = [];
    for (const item of items) {
      try {
        const result = await checkRank(item.keyword, item.mid, {
          type: item.type || 'both',
          headless: true,
        });
        results.push({ ...item, results: result, success: true });
      } catch (err) {
        results.push({ ...item, error: err.message, success: false });
      }
      // 각 조회 사이 딜레이
      await randomDelay(5000, 10000);
    }

    res.json({ timestamp: new Date().toISOString(), results });
  });

  app.listen(port, () => {
    console.log(`🚀 Naver Rank Checker 서버 실행 중: http://localhost:${port}`);
    console.log(`   GET  /rank?keyword=키워드&mid=상품ID&type=both|price|plusstore`);
    console.log(`   POST /rank/batch  body: { items: [{ keyword, mid, type }] }`);
  });
}

// ============================================================
// CLI 실행
// ============================================================

if (require.main === module) {
  const args = process.argv.slice(2);

  // 서버 모드
  if (args.includes('--server')) {
    const port = parseInt(args.find(a => a.startsWith('--port='))?.split('=')[1]) || process.env.PORT || 3000;
    startServer(port);
  }
  // CLI 모드
  else if (args.length >= 2) {
    const keyword = args[0];
    const productId = args[1];
    const typeArg = args.find(a => a.startsWith('--type='));
    const type = typeArg ? typeArg.split('=')[1] : 'both';
    const headless = !args.includes('--head');

    checkRank(keyword, productId, { type, headless })
      .then(result => {
        process.exit(0);
      })
      .catch(err => {
        console.error('에러:', err);
        process.exit(1);
      });
  }
  // 사용법 출력
  else {
    console.log(`
사용법:
  CLI:    node naver-rank-checker.js "키워드" "상품MID" [--type=both|price|plusstore] [--head]
  서버:   node naver-rank-checker.js --server [--port=3000]

예시:
  node naver-rank-checker.js "여성 파자마" "81782266840"
  node naver-rank-checker.js "여성 파자마" "81782266840" --type=plusstore
  node naver-rank-checker.js "여성 파자마" "81782266840" --type=both --head
  node naver-rank-checker.js --server --port=8080
    `);
  }
}

// ============================================================
// 모듈 export (외부에서 require 시 사용)
// ============================================================

module.exports = { checkRank, checkRankViaAPI, checkRankViaPlaywright };
