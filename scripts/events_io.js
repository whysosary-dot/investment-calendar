#!/usr/bin/env node
/*
 * investment-calendar 이벤트 IO 스크립트 — Claude가 index.html을 통째로 읽지 않고
 * 이벤트를 조회/수정/추가/삭제할 수 있게 한다. (스케줄 태스크 토큰 절감, 기능 동일)
 *
 * 사용법 (repo 루트에서):
 *   node scripts/events_io.js list [--from 2026-06-01] [--to 2026-09-30]
 *       → id | date | company | category | important | lastUpdated | title  (컴팩트 목록, memo 제외)
 *   node scripts/events_io.js show 13 27 105
 *       → 해당 id 이벤트 전체 JSON (memo 포함)
 *   node scripts/events_io.js apply ops.json
 *       → 일괄 반영 + DATA_VER 자동 +1 + JS 문법 검증 (실패 시 원본 유지, exit 1)
 *
 * ops.json 형식:
 * {
 *   "update": [ { "id": 13, "date": "2026-07-08", "title": "...", "memo": "📅 일시: ...\n🔥 핵심: ...", "link": "...", "lastUpdated": "2026-07-02" } ],
 *   "add":    [ { "date": "2026-07-20", "title": "...", "company": "...", "category": "...", "icon": "📊", "memo": "...", "link": "...", "important": true, "lastUpdated": "2026-07-02" } ],
 *   "delete": [ 42 ],
 *   "weekly_insight": { "date": "2026-07-02", "items": [ { "badge": "hot", "title": "...", "text": "..." } ] }
 * }
 *
 * 규칙 (SKILL.md와 동일):
 * - add: id 자동 할당 — 1~9999 중 가장 작은 빈 번호. 같은 date+company 존재 시 거부(수정 유도).
 * - id >= 10000 이벤트는 update/delete 모두 거부 (사용자 직접 추가 영역).
 * - memo의 실제 줄바꿈은 JS 문자열 \n 이스케이프로 자동 변환.
 */
const fs = require('fs');
const IDX = process.env.IDX_PATH || 'index.html';
const KEY_ORDER = ['id','date','title','company','category','icon','memo','link','important','lastUpdated'];

function load() { return fs.readFileSync(IDX, 'utf8'); }

function eventsSpan(content) {
  const start = content.indexOf('var DEFAULT_EVENTS=[');
  if (start < 0) throw new Error('DEFAULT_EVENTS 못 찾음');
  const bodyStart = start + 'var DEFAULT_EVENTS=['.length;
  const end = content.indexOf('\n];', bodyStart);
  if (end < 0) throw new Error('DEFAULT_EVENTS 닫는 ]; 못 찾음');
  return [bodyStart, end];
}

function parseEvents(content) {
  const [s, e] = eventsSpan(content);
  return new Function('return [' + content.slice(s, e) + '\n]')();
}

function serialize(ev) {
  const keys = KEY_ORDER.filter(k => ev[k] !== undefined)
    .concat(Object.keys(ev).filter(k => !KEY_ORDER.includes(k) && ev[k] !== undefined));
  return '{' + keys.map(k => k + ':' + JSON.stringify(ev[k])).join(',') + '}';
}

function verify(content) {
  const scripts = [...content.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const biggest = scripts.reduce((a, b) => (b.length > a.length ? b : a), '');
  try { new Function(biggest); return true; }
  catch (err) { console.error('❌ JS 문법 오류:', err.message); return false; }
}

const cmd = process.argv[2] || 'list';
let content = load();

if (cmd === 'list') {
  const from = process.argv.includes('--from') ? process.argv[process.argv.indexOf('--from') + 1] : '0000';
  const to = process.argv.includes('--to') ? process.argv[process.argv.indexOf('--to') + 1] : '9999';
  const evs = parseEvents(content).filter(ev => ev.date >= from && ev.date <= to);
  evs.sort((a, b) => a.date.localeCompare(b.date));
  for (const ev of evs) {
    console.log([ev.id, ev.date, ev.company || '', ev.category || '',
      ev.important ? '★' : '', ev.lastUpdated || '',
      (ev.title || '').slice(0, 70)].join(' | '));
  }
  console.log(`\n총 ${evs.length}건 (memo는 show <id>로 조회)`);
  process.exit(0);
}

if (cmd === 'show') {
  const ids = process.argv.slice(3).map(Number);
  const evs = parseEvents(content).filter(ev => ids.includes(ev.id));
  console.log(JSON.stringify(evs, null, 1));
  process.exit(0);
}

if (cmd === 'apply') {
  const ops = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const evs = parseEvents(content);
  const byId = new Map(evs.map(ev => [ev.id, ev]));
  const summary = [];

  // update
  for (const u of ops.update || []) {
    if (u.id >= 10000) { console.error(`⚠️  id ${u.id} 는 사용자 영역 — update 거부`); continue; }
    const cur = byId.get(u.id);
    if (!cur) { console.error(`⚠️  id ${u.id} 없음 — skip`); continue; }
    const merged = Object.assign({}, cur, u);
    const re = new RegExp('(^|\\n)([ \\t]*)\\{id:' + u.id + ',[^\\n]*');
    if (!re.test(content)) { console.error(`⚠️  id ${u.id} 라인 못 찾음 — skip`); continue; }
    content = content.replace(re, (m, nl, ind) => nl + ind + serialize(merged) + ',');
    summary.push(`~ update ${u.id} ${merged.date} ${String(merged.title).slice(0, 40)}`);
  }

  // delete
  for (const id of ops.delete || []) {
    if (id >= 10000) { console.error(`⚠️  id ${id} 는 사용자 영역 — delete 거부`); continue; }
    const re = new RegExp('\\n[ \\t]*\\{id:' + id + ',[^\\n]*', '');
    if (re.test(content)) { content = content.replace(re, ''); summary.push(`- delete ${id}`); }
  }

  // add
  const used = new Set(parseEvents(content).map(ev => ev.id));
  const existing = parseEvents(content);
  for (const a of ops.add || []) {
    const dup = existing.find(ev => ev.date === a.date && ev.company === a.company);
    if (dup) { console.error(`⚠️  중복 (date+company): ${a.date} ${a.company} → 기존 id ${dup.id} 수정 권장 — add 거부`); continue; }
    const dupTitle = existing.find(ev => ev.title && a.title && ev.title.slice(0, 20) === a.title.slice(0, 20));
    if (dupTitle) { console.error(`⚠️  유사 제목 존재 (id ${dupTitle.id}): ${a.title.slice(0, 30)} — add 거부`); continue; }
    let id = 1; while (used.has(id) && id < 10000) id++;
    if (id >= 10000) { console.error('⚠️  1~9999 빈 id 없음'); continue; }
    used.add(id);
    const ev = Object.assign({ id }, a); ev.id = id;
    const [, e] = eventsSpan(content);
    const before = content.slice(0, e).replace(/\s*$/, '');
    const comma = before.endsWith('}') ? ',' : '';
    content = before + comma + '\n  ' + serialize(ev) + ',' + content.slice(e);
    existing.push(ev);
    summary.push(`+ add ${id} ${ev.date} ${String(ev.title).slice(0, 40)}`);
  }

  // weekly_insight
  if (ops.weekly_insight) {
    const wiStart = content.indexOf('var WEEKLY_INSIGHT={');
    const wiEnd = content.indexOf('\n};', wiStart);
    if (wiStart < 0 || wiEnd < 0) { console.error('⚠️  WEEKLY_INSIGHT 블록 못 찾음'); }
    else {
      const wi = ops.weekly_insight;
      const items = (wi.items || []).map(it =>
        '    {badge:' + JSON.stringify(it.badge) + ',title:' + JSON.stringify(it.title) + ',text:' + JSON.stringify(it.text) + '}'
      ).join(',\n');
      const block = 'var WEEKLY_INSIGHT={\n  date:' + JSON.stringify(wi.date) + ',\n  items:[\n' + items + '\n  ]\n};';
      content = content.slice(0, wiStart) + block + content.slice(wiEnd + 3);
      summary.push(`~ WEEKLY_INSIGHT ${wi.date} (${(wi.items || []).length}개 인사이트)`);
    }
  }

  if (!summary.length) { console.log('변경 없음 — 저장/커밋 불필요'); process.exit(0); }

  // DATA_VER +1
  content = content.replace(/var DATA_VER=(\d+);/, (m, v) => 'var DATA_VER=' + (parseInt(v) + 1) + ';');

  if (!verify(content)) { console.error('원본 유지, exit 1'); process.exit(1); }
  fs.writeFileSync(IDX, content);
  console.log('✅ 저장 완료 (DATA_VER +1, JS 검증 통과)');
  for (const s of summary) console.log(' ', s);
  process.exit(0);
}

console.error('unknown command: ' + cmd);
process.exit(1);
