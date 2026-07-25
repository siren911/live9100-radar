// =====================================================================
// Step 2 : 수집 로봇 1호 — Reddit 공개 JSON + 기술매체 RSS
// 실행: node collector/collect.mjs
//
// 지키는 규칙 (spec v2 §37, kickoff §2 Step 2):
//  - 요청 간격 2초, User-Agent 명시, 429(과다요청) 시 백오프 후 1회 재시도
//  - 원문 전문 저장 금지: 발췌 500자 한도
//  - 사용자명(작성자) 저장 금지
//  - URL unique 로 중복 입고 방지 (이미 있으면 건너뜀)
//  - 수집 결과를 collection_runs(출근 기록부)에 기록
// =====================================================================
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileP = promisify(execFile);

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');

// --- .env 로드 (GitHub Actions에서는 환경변수로 직접 주입됨) ---
const env = { ...process.env };
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2].trim();
  }
} catch { /* .env 없으면 환경변수만 사용 (Actions 환경) */ }

const URL_ = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE;
if (!URL_ || !KEY) { console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE 필요'); process.exit(1); }

const UA = '9100-radar-collector/1.0 (public data research; github.com/siren911/9100-radar)';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────
// 검색 설정 (spec v2 §6 키워드 사전)
// ─────────────────────────────────────────────
// 제품 식별: 이 단어들 중 하나가 본문/제목에 있어야만 입고
const PRODUCT_RE = /9100\s*pro|9100pro/i;

// Reddit 검색 쿼리: 제품명 하나로 통합 (rate limit 회피 — 세부 필터링은 로컬에서)
// ※ JSON API는 403으로 차단되어 공개 RSS(search.rss)를 사용 (2026-07 검증)
// ※ 쿼리를 여러 개 연속 요청하면 429가 뜨므로 1개만 사용
const REDDIT_QUERIES = [
  '"9100 pro"',
];

// Samsung Community 공개 검색 (robots.txt: 검색 경로 허용 · Crawl-delay 5 준수)
// ※ 서버 렌더링 HTML을 파싱. RSS(/rss/board)는 빈 피드로 확인되어 미사용 (2026-07 검증)
const SAMSUNG_BASE = 'https://us.community.samsung.com';
const SAMSUNG_QUERIES = ['9100 PRO'];
const SAMSUNG_CRAWL_DELAY = 5000;   // robots.txt Crawl-delay: 5

// 뉴스 검색 (Google News RSS · API 키 불필요)
// ※ 할인·가격 기사가 대부분이라 '문제 중심' 쿼리 + 코드 프리필터로 노이즈 제거
const NEWS_QUERIES = [
  '"9100 PRO" (firmware OR issue OR problem OR failure)',
  '"9100 PRO" SSD (recall OR defect OR bug OR complaint)',
];
// 뉴스 프리필터 (2026-07 실측: 무필터 시 41건 중 이슈 보도 0건 — 전부 리뷰/출시/시세 기사)
// ① 문제 신호가 하나라도 있어야 통과 (없으면 AI에 보내지 않음)
const ISSUE_RE = /\b(firmware|bug|defect|recall|fault|fail|failure|issue|problem|complaint|brick|bricked|vanish|disappear|not detected|undetected|crash|bsod|freeze|throttl|overheat|data loss|corrupt|investigat|warning|glitch|dead|dying|rma)\b/i;
// ② 리뷰·출시·시세 기사는 문제 신호가 있어도 제외 (벤치마크 기사의 'throttling' 등 오탐 방지)
const MARKETING_RE = /\b(review|hands[- ]on|benchmark|launch|launches|announce|announces|unveil|debut|introduc|now available|deal|discount|% off|percent off|sale|price|pricing|cheaper|cheap|prime day|black friday|bargain|coupon|save \$|lowest|best price|drops to|clears out|per gb)\b/i;

// 기술매체 RSS (robots/약관상 공개 피드, 2026-07 접근 검증 완료)
const RSS_FEEDS = [
  { name: 'TechPowerUp',  url: 'https://www.techpowerup.com/rss/news' },
  { name: 'TomsHardware', url: 'https://www.tomshardware.com/feeds/all' },
  { name: 'TechSpot',     url: 'https://www.techspot.com/backend.xml' },
  { name: 'ServeTheHome', url: 'https://www.servethehome.com/feed/' },
  { name: 'Overclock3D',  url: 'https://overclock3d.net/feed/' },
  { name: 'Neowin',       url: 'https://www.neowin.net/news/rss/' },
];

// ─────────────────────────────────────────────
// 공용 도우미
// ─────────────────────────────────────────────
function detectLang(text) {
  if (/[가-힣]/.test(text)) return 'ko';
  if (/[ぁ-んァ-ン]/.test(text)) return 'ja';
  if (/[一-鿿]/.test(text)) return 'zh';
  return 'en';
}
function stripHtml(s) { return (s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim(); }
function excerptOf(s) { return stripHtml(s).slice(0, 500); }               // 발췌 500자 한도
function hashOf(title, body) {
  const norm = (title + ' ' + body).toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(norm).digest('hex').slice(0, 32);
}

// 예의 바른 fetch: UA 명시 + 429/503/403 시 백오프 재시도 (60초 → 120초)
// ※ Reddit은 무인증 요청을 분당 1회 수준으로 제한하므로 넉넉히 기다린다
async function politeFetch(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.status === 429 || res.status === 503 || res.status === 403) {
      if (attempt === 2) return res;                 // 마지막 시도면 그대로 반환
      const wait = 60_000 * (attempt + 1);
      console.log(`  ⏳ ${res.status} 응답 — ${wait / 1000}초 물러났다 재시도`);
      await sleep(wait);
      continue;
    }
    return res;
  }
}

// curl 경유 fetch: Reddit은 Node fetch의 TLS 지문을 차단하므로 curl 사용 (2026-07 검증)
// curl은 Windows 10+ / GitHub Actions 러너에 기본 탑재
async function curlFetch(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { stdout } = await execFileP('curl', [
        '-s', '--compressed', '--max-time', '30',
        '-w', '\n__HTTP_STATUS__%{http_code}',
        '-H', `User-Agent: ${UA}`,
        url,
      ], { maxBuffer: 10 * 1024 * 1024 });
      const idx = stdout.lastIndexOf('\n__HTTP_STATUS__');
      const status = Number(stdout.slice(idx + 16).trim());
      const body = stdout.slice(0, idx);
      if (status === 429 || status === 503 || status === 403) {
        if (attempt === 2) return { ok: false, status, text: async () => body };
        const wait = 60_000 * (attempt + 1);
        console.log(`  ⏳ ${status} 응답 — ${wait / 1000}초 물러났다 재시도`);
        await sleep(wait);
        continue;
      }
      return { ok: status >= 200 && status < 300, status, text: async () => body };
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(10_000);                            // 네트워크 일시 오류 — 10초 후 재시도
    }
  }
}

// Supabase REST 도우미
async function sb(path, opts = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json', ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${path} 실패 (${res.status}): ${await res.text()}`);
  return res;
}

// posts 입고: url 중복이면 조용히 건너뜀, 실제 신규 건수를 반환
async function insertPosts(rows) {
  if (!rows.length) return 0;
  const res = await sb('posts?on_conflict=url', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify(rows),
  });
  return (await res.json()).length;
}

// 출근 기록부
async function recordRun(source, { fetched, added, errors, note }) {
  await sb('collection_runs', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ source, finished: new Date().toISOString(), fetched, new: added, errors, note: note || null }),
  });
}

// ─────────────────────────────────────────────
// 수집기 1 : Reddit 공개 검색 RSS (Atom 형식)
// ─────────────────────────────────────────────
function parseAtom(xml) {
  const items = [];
  for (const m of xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)) {
    const block = m[0];
    const pick = tag => {
      const mm = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return mm ? mm[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
    };
    const link = block.match(/<link[^>]*href="([^"]+)"/i)?.[1] || '';
    const cat  = block.match(/<category[^>]*label="([^"]+)"/i)?.[1] || '';
    items.push({ title: pick('title'), link, pubDate: pick('updated') || pick('published'), desc: pick('content'), cat });
  }
  return items;
}

async function collectReddit() {
  console.log('🤖 [Reddit] 수집 시작 (공개 RSS)');
  let fetched = 0, errors = 0;
  const rows = [];
  for (const q of REDDIT_QUERIES) {
    try {
      const url = `https://www.reddit.com/search.rss?q=${encodeURIComponent(q)}&sort=new&t=month&limit=100`;
      const res = await curlFetch(url);              // Reddit은 curl 경유 (Node fetch 차단)
      if (!res.ok) { console.log(`  ⚠️ "${q}" → HTTP ${res.status}`); errors++; await sleep(2000); continue; }
      const entries = parseAtom(await res.text());
      fetched += entries.length;
      for (const e of entries) {
        const body = stripHtml(e.desc);
        const text = `${stripHtml(e.title)} ${body}`;
        if (!PRODUCT_RE.test(text)) continue;                    // 제품 무관 글 제외
        rows.push({
          url: e.link.split('?')[0],
          source: 'reddit',
          lang: detectLang(text),
          title: stripHtml(e.title).slice(0, 300),
          excerpt: excerptOf(body || e.title),
          posted_at: e.pubDate ? new Date(e.pubDate).toISOString() : null,
          raw_hash: hashOf(e.title, body),
          meta: { subreddit: e.cat || null },                     // 작성자명 저장 안 함
        });
      }
      console.log(`  🔍 "${q}" → ${entries.length}건 중 제품 관련 후보 누적 ${rows.length}건`);
    } catch (e) { console.log(`  ⚠️ "${q}" 실패: ${e.message}`); errors++; }
    await sleep(2000);                                           // 요청 간격 2초
  }
  // URL 기준 중복 제거 후 입고
  const uniq = [...new Map(rows.map(r => [r.url, r])).values()];
  const added = await insertPosts(uniq);
  await recordRun('reddit', { fetched, added, errors });
  console.log(`✅ [Reddit] 조회 ${fetched}건 → 관련 ${uniq.length}건 → 신규 입고 ${added}건 (중복 ${uniq.length - added}건 건너뜀)\n`);
  return { fetched, added, errors };
}

// ─────────────────────────────────────────────
// 수집기 2 : 기술매체 RSS
// ─────────────────────────────────────────────
function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const block = m[0];
    const pick = tag => {
      const mm = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return mm ? mm[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : '';
    };
    items.push({ title: pick('title'), link: pick('link'), pubDate: pick('pubDate'), desc: pick('description') });
  }
  return items;
}

// ─────────────────────────────────────────────
// Samsung Community — 공식 커뮤니티 공개 검색 결과 파싱
// ─────────────────────────────────────────────
function parseSamsung(html) {
  const strip = s => (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();

  const out = [];
  // Khoros 검색 결과 항목 단위로 분할
  for (const chunk of html.split(/<div class="MessageView lia-message-view-message-search-item/).slice(1)) {
    const path = (chunk.match(/href="(\/t5\/[^"]*\/(?:m-p|td-p)\/\d+)/) || [])[1];
    const subjRaw = (chunk.match(/class="message-subject"[\s\S]{0,400}?<a[^>]*>([\s\S]*?)<\/a>/) || [])[1]
                 || (chunk.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) || [])[1];
    if (!path || !subjRaw) continue;
    const bodyRaw = (chunk.match(/class="lia-message-body-content"[^>]*>([\s\S]*?)<\/div>/) || [])[1]
                 || (chunk.match(/class="lia-truncated-body-container"[^>]*>([\s\S]*?)<\/div>/) || [])[1];
    const dateRaw = (chunk.match(/<span class="local-date">([^<]*)/) || [])[1];
    let posted = null;
    if (dateRaw) {                                   // 형식: ‎MM-DD-YYYY
      const d = dateRaw.replace(/[^\d-]/g, '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
      if (d) posted = new Date(`${d[3]}-${d[1]}-${d[2]}T00:00:00Z`).toISOString();
    }
    out.push({
      title: strip(subjRaw),
      link: SAMSUNG_BASE + path.split('?')[0],
      desc: strip(bodyRaw),
      pubDate: posted,
    });
  }
  return out;
}

async function collectSamsung() {
  console.log('🤖 [Samsung Community] 수집 시작 (공개 검색 · Crawl-delay 5s 준수)');
  let fetched = 0, errors = 0;
  const rows = [];
  for (const q of SAMSUNG_QUERIES) {
    try {
      const url = `${SAMSUNG_BASE}/t5/forums/searchpage/tab/message?q=${encodeURIComponent(q)}`;
      const res = await curlFetch(url);   // Node fetch는 403 차단됨 (Reddit과 동일, 2026-07 검증)
      if (!res.ok) { console.log(`  ⚠️ "${q}" → HTTP ${res.status}`); errors++; continue; }
      const items = parseSamsung(await res.text());
      fetched += items.length;
      const hit = items.filter(it => PRODUCT_RE.test(`${it.title} ${it.desc}`));
      console.log(`  🏛 "${q}" → ${items.length}건 중 제품 관련 ${hit.length}건`);
      for (const it of hit) {
        rows.push({
          url: it.link, source: 'samsung_community', lang: detectLang(`${it.title} ${it.desc}`),
          title: it.title.slice(0, 300), excerpt: excerptOf(it.desc),
          posted_at: it.pubDate, raw_hash: hashOf(it.title, it.desc),
          meta: { feed: 'Samsung Community US', query: q },
        });
      }
    } catch (e) { console.log(`  ⚠️ "${q}" 실패: ${e.message}`); errors++; }
    await sleep(SAMSUNG_CRAWL_DELAY);
  }
  const added = await insertPosts(rows);
  await recordRun('samsung_community', { fetched, added, errors, note: `queries=${SAMSUNG_QUERIES.length}` });
  console.log(`✅ [Samsung Community] 조회 ${fetched}건 → 관련 ${rows.length}건 → 신규 입고 ${added}건\n`);
  return { fetched, added, errors };
}

// ─────────────────────────────────────────────
// 뉴스 검색 — Google News RSS (키 불필요)
// ─────────────────────────────────────────────
async function collectNews() {
  console.log('🤖 [News] 수집 시작 (Google News RSS)');
  let fetched = 0, errors = 0, noIssue = 0, marketing = 0;
  const rows = [];
  for (const q of NEWS_QUERIES) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
      const res = await politeFetch(url);
      if (!res.ok) { console.log(`  ⚠️ 쿼리 실패 → HTTP ${res.status}`); errors++; continue; }
      const items = parseRss(await res.text());
      fetched += items.length;
      let kept = 0;
      for (const it of items) {
        const text = `${it.title} ${it.desc}`;
        if (!PRODUCT_RE.test(text)) continue;
        if (!ISSUE_RE.test(text)) { noIssue++; continue; }        // 문제 신호 없음 → 제외
        if (MARKETING_RE.test(text)) { marketing++; continue; }   // 리뷰·출시·시세 기사 → 제외
        kept++;
        rows.push({
          url: it.link, source: 'news', lang: detectLang(text),
          title: it.title.slice(0, 300), excerpt: excerptOf(it.desc),
          posted_at: it.pubDate ? new Date(it.pubDate).toISOString() : null,
          raw_hash: hashOf(it.title, it.desc),
          meta: { feed: 'Google News', query: q },
        });
      }
      console.log(`  📰 "${q.slice(0, 40)}…" → ${items.length}건 중 채택 ${kept}건`);
    } catch (e) { console.log(`  ⚠️ 뉴스 쿼리 실패: ${e.message}`); errors++; }
    await sleep(2000);
  }
  const added = await insertPosts(rows);
  const filtered = noIssue + marketing;
  await recordRun('news', { fetched, added, errors, note: `no_issue=${noIssue} marketing=${marketing}` });
  console.log(`✅ [News] 조회 ${fetched}건 → 채택 ${rows.length}건 (문제신호 없음 ${noIssue} · 리뷰/시세 ${marketing} 제외) → 신규 입고 ${added}건\n`);
  return { fetched, added, errors, filtered };
}

async function collectRss() {
  console.log('🤖 [RSS] 수집 시작');
  let fetched = 0, errors = 0;
  const rows = [];
  for (const feed of RSS_FEEDS) {
    try {
      const res = await politeFetch(feed.url);
      if (!res.ok) { console.log(`  ⚠️ ${feed.name} → HTTP ${res.status}`); errors++; await sleep(2000); continue; }
      const items = parseRss(await res.text());
      fetched += items.length;
      const hit = items.filter(it => PRODUCT_RE.test(`${it.title} ${it.desc}`));
      for (const it of hit) {
        const text = `${it.title} ${it.desc}`;
        rows.push({
          url: it.link,
          source: `rss:${feed.name}`,
          lang: detectLang(text),
          title: stripHtml(it.title).slice(0, 300),
          excerpt: excerptOf(it.desc || it.title),
          posted_at: it.pubDate ? new Date(it.pubDate).toISOString() : null,
          raw_hash: hashOf(it.title, it.desc),
          meta: { feed: feed.name },
        });
      }
      console.log(`  📰 ${feed.name} → ${items.length}건 중 제품 관련 ${hit.length}건`);
    } catch (e) { console.log(`  ⚠️ ${feed.name} 실패: ${e.message}`); errors++; }
    await sleep(2000);                                           // 요청 간격 2초
  }
  const uniq = [...new Map(rows.map(r => [r.url, r])).values()];
  const added = await insertPosts(uniq);
  await recordRun('rss', { fetched, added, errors });
  console.log(`✅ [RSS] 조회 ${fetched}건 → 관련 ${uniq.length}건 → 신규 입고 ${added}건\n`);
  return { fetched, added, errors };
}

// ─────────────────────────────────────────────
// 실행
// ─────────────────────────────────────────────
const t0 = Date.now();
console.log(`\n══════ 9100-radar 수집 로봇 출근 (${new Date().toISOString()}) ══════\n`);
const r1 = await collectReddit();
const r2 = await collectRss();
const r3 = await collectSamsung();
const r4 = await collectNews();
console.log('══════ 수집 요약 ══════');
console.log(`Reddit  : 조회 ${r1.fetched} / 신규 ${r1.added} / 오류 ${r1.errors}`);
console.log(`RSS     : 조회 ${r2.fetched} / 신규 ${r2.added} / 오류 ${r2.errors}`);
console.log(`Samsung : 조회 ${r3.fetched} / 신규 ${r3.added} / 오류 ${r3.errors}`);
console.log(`News    : 조회 ${r4.fetched} / 신규 ${r4.added} / 오류 ${r4.errors} (프리필터 제외 ${r4.filtered}건)`);
console.log(`⏱ 소요 ${((Date.now() - t0) / 1000).toFixed(1)}초 — 퇴근!`);
