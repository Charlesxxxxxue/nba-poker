/* ============================================================================
 * NBA Poker · 25 星 × 5 局技能体检台（交付前验收）
 * 用法：node star_health_5g.js [每星局数=5]
 *
 * 与 sim_v11.js 的区别：sim_v11 测「胜率边际价值」（统计），本台测「有没有 bug」（断言）。
 * 每局独立 vm 沙箱 + 独立随机种子，逐手 hook commitMove 校验：
 *   1) 压牌合法性 beats(prev, mv)
 *   2) 打出的牌确实还在手里（排除幻影牌）
 *   3) 手牌无重复 id / 无负数 / 总数不失控
 *   4) 技能次数上限不越界（edwards 3 / cunningham 3 / curry 2 / kg 2）
 *   5) 正常走到 endGame，无卡死、无 JS 异常
 * 另外记录每星 5 局的「技能触发证据」，0 触发的标为低频待复核（不等于 bug）。
 * ==========================================================================*/
const fs = require('fs'), vm = require('vm'), path = require('path');
const DIR = __dirname;
const FILE = path.join(DIR, 'PLAYABLE_v1.9.html');
const RULES = path.join(DIR, 'rules.js');
const GAMES = Number(process.argv[2] || 5);
/* auto  = 引擎统一决策路径（AI 座 / 无头仿真 / 平衡台口径）
 * human = 真人手动出牌路径（onPlay：parseMove + beats + applyMove），只生成标准牌型
 * 两者不等价：后者用于检验「玩家在手机上真的能触发技能吗」 */
const MODE = (process.env.BENCH_MODE || 'auto').toLowerCase();
const SEEDS = [20260901, 20260902, 20260903, 20260904, 20260905,
               20260906, 20260907, 20260908, 20260909, 20260910];

const rulesCode = fs.readFileSync(RULES, 'utf8');
const engineCode = fs.readFileSync(FILE, 'utf8')
  .match(/<script>([\s\S]*?)<\/script>/)[1]
  .replace('const G={', 'var G={')
  .replace('let selected=new Set();', 'var selected=new Set();');

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ (t ^ t >>> 14) >>> 0;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function fakeEl() {
  return new Proxy({
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    clientWidth: 360, offsetWidth: 0, scrollHeight: 0, scrollTop: 0,
    _t: '', _h: '', _click: null,
    set textContent(v) { this._t = v; }, get textContent() { return this._t; },
    set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; },
    appendChild() {}, append() {}, remove() {}, focus() {}, select() {}, setSelectionRange() {},
    querySelector() { return fakeEl(); }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
    set onclick(f) { this._click = f; }, get onclick() { return this._click; },
    set className(v) {}, get className() { return ''; },
    set value(v) { this._v = v; }, get value() { return this._v || ''; },
  }, { get(t, p) { return p in t ? t[p] : undefined; }, set(t, p, v) { t[p] = v; return true; } });
}
const doc = {
  getElementById() { return fakeEl(); }, createElement() { return fakeEl(); },
  querySelectorAll() { return []; }, addEventListener() {}, body: fakeEl(),
};

/* 每星「技能确实生效过」的观测口径：终局状态字段 / 日志关键词 / 走法标记 三选一 */
const EVIDENCE = {
  jokic:       (S) => !!S.jokicUsed,
  wembanyama:  (S) => !!S.wembyUsed,
  alexander:   (S) => (S.gFoul > 0) || Object.keys(S.foul || {}).length > 0 || Object.keys(S.drawn || {}).length > 0,
  brunson:     (S, lg, fl) => fl.has('brunson_window'),
  durant:      (S) => !!S.durantUsed || !!S.retakeReady,
  harden:      (S) => !!S.hardenUsed,
  doncic:      (S) => !!S.doncicUsed || (S.types && S.types.size >= 3),
  kobe:        (S, lg, fl) => fl.has('kobe_finish'),
  duncan:      (S) => (S.duncanBlocks || 0) > 0,
  oNeal:       (S) => !!S.oNealUsed,
  kidd:        (S) => !!S.kiddSeen || !!S._kiddAssigned,
  nowitzki:    (S) => (S.discarded || 0) > 0 || (S.pairs || 0) > 0,
  curry:       (S) => (S.curryUsed || 0) > 0,
  lebron:      (S) => !!S.lebronUsed,
  jordan:      (S) => (S.wildIds || []).length > 0,
  giannis:     (S) => (S.gFoul || 0) > 0 || !!S.giannisUsed,
  edwards:     (S) => (S.edwardsBoost || 0) > 0,
  mitchell:    (S) => !!S.mitchellUsed,
  cunningham:  (S) => (S.cunninghamCount || 0) > 0,
  leonard:     (S) => !!S.leonardUsed,
  kareem:      (S) => !!S.kareemUsed,
  magic:       (S) => !!S.magicUsed,
  bird:        (S) => !!S.birdUsed,
  kg:          (S) => (S.kgUsed || 0) > 0,
  wade:        (S) => (S.wadeCount || 0) > 0,
};

function runOne(key, seed) {
  const rng = mulberry32(seed);
  const seededMath = Object.create(Math); seededMath.random = () => rng();
  const queue = []; let tid = 0;
  const ctx = {
    document: doc,
    window: {
      addEventListener() {}, matchMedia: () => ({ matches: false }),
      innerWidth: 390, innerHeight: 844, devicePixelRatio: 2,
      isSecureContext: false, AudioContext: undefined,
    },
    navigator: { userAgent: 'node-headless', vibrate: undefined },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console, Math: seededMath, Set, Promise, Date, JSON, Object, Array,
    alert: () => {},
  };
  ctx.self = undefined;
  ctx.setTimeout = (fn) => { const id = ++tid; queue.push({ id, fn }); return id; };
  ctx.clearTimeout = (id) => { const i = queue.findIndex(x => x.id === id); if (i >= 0) queue.splice(i, 1); };
  ctx.setInterval = () => 0;
  ctx.clearInterval = () => {};
  vm.createContext(ctx);
  vm.runInContext(rulesCode, ctx);
  vm.runInContext(engineCode, ctx);
  ctx.SIM_MODE = true;

  let finished = false, winner = -1, crash = null;
  const violations = [], logs = [], flags = new Set();
  let maxMoves = 0;

  // 真人交互挂起全部改成自动决策
  ctx.renderPickStar = function () { ctx.pickStar(key); };
  ctx.renderControls_bid = function () { ctx.doBid(0, ctx.aiBid(ctx.G.players[0].hand)); };
  ctx.renderControls_double = function () { ctx.G.doubleDone = true; ctx.startPlay(); };
  if (MODE === 'human') {
    // 复刻真实 onPlay()：选牌 → parseMove(标准牌型) → beats() 校验 → applyMove
    // 不调用 genAllForSeat / genBeatingForSeat，也不自动触发 autoPlaySeat 里的领出技能
    ctx.enableHumanTurn = function () {
      const G = ctx.G;
      if (G.phase !== 'play') return;
      const hand = G.players[0].hand, prev = G.lastMove;
      let cand = prev ? ctx.genBeating(hand, prev) : ctx.genAllMoves(hand);
      cand = cand.filter(m => m.type !== 'bomb' && m.type !== 'rocket')
                 .sort((a, b) => a.cards.length - b.cards.length || a.rank - b.rank);
      let mv = cand.length ? ctx.parseMove(cand[0].cards) : null;
      if (!mv && !prev) {                       // 领出不允许「不出」：兜底打最小单张
        const lo = hand.slice().sort((a, b) => a.v - b.v)[0];
        mv = lo ? ctx.parseMove([lo]) : null;
      }
      if (prev && mv && !ctx.beats(prev, mv)) mv = null;
      ctx.applyMove(0, mv);
    };
  } else {
    ctx.enableHumanTurn = function () { ctx.autoPlaySeat(0, ctx.G.lastMove); };
  }
  ctx.startCountdown = function () {};
  ctx.enterJordanWildSelect = function () {
    const h = ctx.G.players[0].hand;
    const ids = h.length ? ctx.pickTwoLowest(h).map(c => c.id) : [];
    ctx.G.ss[0].wildIds = ids;
    ctx.G.jordanSelect = false;
    ctx.stepBid();
  };
  ctx.offerImmunity = function (seat, mv) { ctx.commitMove(seat, mv); };

  // 收集日志文本（技能触发证据之一）
  const origLog = ctx.log;
  ctx.log = function (t, me) { logs.push(String(t)); return origLog(t, me); };

  // 逐手校验
  const origCM = ctx.commitMove;
  ctx.commitMove = function (seat, mv) {
    const G = ctx.G;
    if (mv && mv.cards) {
      const hand = G.players[seat].hand;
      const handLen = hand.length;
      const ids = new Set(hand.map(c => c.id));
      const prev = G.lastMove;
      const selfChain = (G.lastSeat === seat);           // 哈登连击 / 技能重夺：豁免压牌校验
      const kobeFinish = (G.star[seat] === 'kobe' && mv.cards.length === handLen);
      if (prev && !selfChain && !kobeFinish && !ctx.beats(prev, mv)) {
        violations.push(`ILLEGAL_BEAT seat=${seat} prev=${prev.type}(${prev.rank}) mv=${mv.type}(${mv.rank})`);
      }
      const missing = mv.cards.filter(c => !c.phantom && !ids.has(c.id));
      if (missing.length) {
        violations.push(`CARD_NOT_IN_HAND seat=${seat} mv=${mv.type} missing=${missing.length} ids=${missing.slice(0, 3).map(c => c.id).join(',')}`);
      }
      if (seat === 0) {
        if (handLen <= 5) flags.add('brunson_window');
        if (mv.cards.length === handLen) flags.add('kobe_finish');
      }
    }
    const r = origCM(seat, mv);
    maxMoves = Math.max(maxMoves, G.moveCount);
    // 出牌后手牌完整性
    for (let s = 0; s < 3; s++) {
      const h = G.players[s].hand;
      const seen = new Set(); let dup = 0;
      h.forEach(c => { if (seen.has(c.id)) dup++; seen.add(c.id); });
      if (dup) violations.push(`DUP_CARD seat=${s} dup=${dup}`);
      if (h.length > 30) violations.push(`HAND_OVERFLOW seat=${s} n=${h.length}`);
    }
    const total = G.players.reduce((a, p) => a + p.hand.length, 0);
    if (total > 62) violations.push(`TOTAL_OVERFLOW n=${total}`);
    return r;
  };

  ctx.endGame = function (w) {
    finished = true; winner = w;
    ctx.clearTimers();
  };

  try {
    ctx.startGame();
    let guard = 0;
    while (queue.length && !finished && guard < 200000) {
      const t = queue.shift(); t.fn(); guard++;
    }
    if (!finished) violations.push(`STALL guard=${guard} queue=${queue.length} phase=${ctx.G.phase} moves=${ctx.G.moveCount}`);
  } catch (e) {
    crash = e.message + ' | ' + String(e.stack || '').split('\n').slice(0, 2).join(' ');
    violations.push('CRASH ' + crash);
  }

  // 次数上限
  const S = ctx.G.ss[0] || {};
  const CAPS = { edwardsBoost: 3, cunninghamCount: 3, curryUsed: 2, kgUsed: 2 };
  for (const [k, cap] of Object.entries(CAPS)) {
    if ((S[k] || 0) > cap) violations.push(`CAP_OVER ${k}=${S[k]}>${cap}`);
  }
  const triggered = EVIDENCE[key] ? !!EVIDENCE[key](S, logs.join(' '), flags) : null;
  return {
    key, seed, finished, winner: winner === 0 ? 'human' : (winner < 0 ? '-' : 'ai' + winner),
    moves: ctx.G.moveCount, triggered, crash,
    violations: Array.from(new Set(violations)),   // 同类违规每局只记一条明细
    logLines: logs.length,
  };
}

// 从 rules.js 读 25 星清单
const probe = {}; vm.createContext(probe); vm.runInContext(rulesCode, probe);
const KEYS = Object.keys(probe.STARS);
console.log(`体检目标：${KEYS.length} 星 × ${GAMES} 局 = ${KEYS.length * GAMES} 局 · 路径=${MODE}\n`);

const all = [];
for (const key of KEYS) {
  const games = [];
  for (let g = 0; g < GAMES; g++) games.push(runOne(key, SEEDS[g % SEEDS.length]));
  all.push({ key, name: probe.STARS[key].name, skill: probe.STARS[key].skill, games });
}

// 汇总
let totalViolations = 0, totalGames = 0, totalTriggered = 0;
const rows = [];
for (const s of all) {
  const v = s.games.flatMap(g => g.violations);
  const stalled = s.games.filter(g => !g.finished).length;
  const trig = s.games.filter(g => g.triggered).length;
  const moves = Math.round(s.games.reduce((a, g) => a + g.moves, 0) / s.games.length);
  totalViolations += v.length; totalGames += s.games.length; totalTriggered += trig;
  rows.push({
    key: s.key, name: s.name, skill: s.skill,
    finished: `${s.games.length - stalled}/${s.games.length}`,
    trigger: `${trig}/${s.games.length}`, avgMoves: moves,
    violations: v.length, samples: v.slice(0, 3).join(' ; '),
  });
}

console.log('=== 25 星 × 5 局体检汇总 ===');
console.log('星'.padEnd(16) + '技能'.padEnd(14) + '终局'.padEnd(9) + '触发'.padEnd(9) + '均手数'.padEnd(9) + '违规');
for (const r of rows) {
  console.log(
    (r.key + '/' + r.name).padEnd(18) + r.skill.padEnd(16) +
    r.finished.padEnd(9) + r.trigger.padEnd(9) + String(r.avgMoves).padEnd(9) +
    (r.violations ? '❌ ' + r.violations + '  ' + r.samples.slice(0, 90) : '✅ 0')
  );
}
console.log('\n合计：' + totalGames + ' 局，违规 ' + totalViolations + " 条，技能触发观测 " + totalTriggered + '/' + totalGames);
const low = rows.filter(r => r.trigger.startsWith('0/'));
if (low.length) console.log('低频/未观测到触发（不等于 bug）：' + low.map(r => r.key + '/' + r.name).join('、'));

const out = path.join(DIR, MODE === 'human'
  ? '验收_25星5局体检_真人路径_v1.9.9.json'
  : '验收_25星5局体检_v1.9.9.json');
fs.writeFileSync(out, JSON.stringify({ version: 'v1.9.9', build: '20261120b', mode: MODE, gamesPerStar: GAMES, rows, detail: all }, null, 2), 'utf8');
console.log('\nJSON: ' + out);
if (totalViolations > 0) process.exitCode = 1;
