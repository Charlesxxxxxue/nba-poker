/* ============================================================================
 * NBA Poker · rules.js  ——  纯规则模块（双端复用：浏览器 + Node 服务器）
 *
 * 设计目标：
 *  - 浏览器：挂到 window（含 window.NBAPokerRules 命名空间），供 PLAYABLE 引擎引用，
 *    引擎不再内联这些规则，避免「单文件副本」与「服务端副本」漂移。
 *  - Node：module.exports，供 PvP 权威服务器校验每一手（防作弊）。
 *
 * 仅含「无副作用、不依赖全局 G / DOM」的纯函数与常量。
 * 依赖全局状态的座位级封装（genAllForSeat / genBeatingForSeat / isFoe / isTopRemaining
 * 等）仍保留在引擎内，它们调用本模块暴露的纯函数。
 * ==========================================================================*/
(function (root, factory) {
  const R = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = R;
  } else {
    root.NBAPokerRules = R;
    // 把每个导出直接挂到 window，使引擎内对 parseMove / genBeating 等的裸引用生效
    Object.assign(root, R);
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- 常量 ---------- */
  const SUITS = ["♠", "♥", "♣", "♦"];
  const RED = { "♥": 1, "♦": 1 };
  const SUIT_ORDER = { "♠": 3, "♥": 2, "♣": 1, "♦": 0 };
  const LABEL = { 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10", 11: "J", 12: "Q", 13: "K", 14: "A", 15: "2", 16: "小王", 17: "大王" };
  const V_RANK = { 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2' };
  const SUIT_NAME = { '♠': 'spade', '♥': 'heart', '♣': 'club', '♦': 'diamond' };
  const JORDAN_WILDS = 1;   // 乔丹·神之一手：开局主动指定的万能牌数量（1=原始设计/已验证基线）

  const STARS = {
    jokic: { key: "jokic", name: "约基奇", skill: "移花接木", type: "active", cd: "1局1次", desc: "出牌阶段与任意一名其他玩家互换一张手牌（对手排序打乱呈现）", descFull: "在你的出牌阶段，你可以指定任意一名其他玩家与他互换一张手牌，每局限用一次。" },
    wembanyama: { key: "wembanyama", name: "文班亚马", skill: "遮天蔽日", type: "reactive", cd: "1局1次", desc: "对手打出炸弹时抵消其效果（王炸不可抵消）", descFull: "当对手打出炸弹时，你可以抵消这枚炸弹的效果，但王炸无法被抵消，每局限用一次。" },
    alexander: { key: "alexander", name: "亚历山大", skill: "造犯规", type: "passive+active", cd: "被动常驻；主动每对手1次", desc: "被压牌→压人者+1犯规；犯规达4可抽取其1张手牌（打乱，可选留/弃）", descFull: "当你的牌被对手压住时，压牌的人会累计一次犯规；等他的犯规累计到 4 次，你就可以从他的手牌里盲抽一张，再决定留下还是弃掉。" },
    brunson: { key: "brunson", name: "布伦森", skill: "大心脏", type: "passive", cd: "常驻", desc: "手牌≤5张时点数默认+1级（K→A、A→2、2→王级）", descFull: "当你的手牌剩下 5 张或更少时，你手里每一张牌的点数都会自动提升一级，也就是 K 变 A、A 变 2、2 升为王级。" },
    durant: { key: "durant", name: "杜兰特", skill: "死神降临", type: "active", cd: "1局1次", desc: "打出含手中最大牌的牌型被压时，可弃一张大于10的牌（J/Q/K/A/2）重夺出牌权", descFull: "当你打出的牌型里包含手中最大的那张牌、并且这手牌被对手压住时，你可以弃掉一张大于 10 的牌（J、Q、K、A、2 均可）来重新夺回出牌权，每局限用一次。" },
    harden: { key: "harden", name: "哈登", skill: "and one", type: "active", cd: "1局1次", desc: "出牌后可随即再打出一次相同牌型", descFull: "你出完一手牌之后，可以紧接着再打出一次完全相同的牌型，等于一次行动连出两手，每局限用一次。" },
    doncic: { key: "doncic", name: "东契奇", skill: "luka magic", type: "passive", cd: "1局1次触发", desc: "打出3种以上牌型后复制一张手中最大牌（不含王）", descFull: "当你在同一局里累计打出三种以上不同的牌型后，会自动复制一张你手中最大的牌加入手牌，王牌不参与复制。" },
    kobe: { key: "kobe", name: "科比", skill: "曼巴时刻", type: "passive", cd: "常驻", desc: "恰好剩最后一个牌型时视为最大点数直接获胜", descFull: "当你的手牌恰好只剩最后一个牌型时，这一手牌会被直接判定为最大点数，打出去即可赢下本局。" },
    duncan: { key: "duncan", name: "邓肯", skill: "石佛", type: "passive", cd: "免疫（无上限）", desc: "免疫任何针对自己的技能攻击（夺牌/强制弃牌），无次数上限", descFull: "你免疫所有针对你个人的技能攻击，包括被别人夺走手牌和被强制弃牌，而且这个免疫效果没有次数上限。" },
    oNeal: { key: "oNeal", name: "奥尼尔", skill: "制霸篮下", type: "active", cd: "1局1次", desc: "非王炸炸弹可升为最高级（等同王炸，不可被压）", descFull: "你可以把一手非王炸的炸弹升级为最高等级，让它等同于王炸并且无法被任何牌压住，每局限用一次。" },
    kidd: { key: "kidd", name: "基德", skill: "球场视野", type: "passive", cd: "常驻", desc: "叫分前看底牌；若地主可在加倍后分配3张底牌", descFull: "在叫分开始之前，你可以先查看三张底牌；如果你最后当上了地主，还可以在加倍之后重新分配这三张底牌。" },
    nowitzki: { key: "nowitzki", name: "诺维斯基", skill: "金鸡独立", type: "passive", cd: "常驻(每累计2对触发)", desc: "本局累计打出两个对子后弃一张手牌加速清牌", descFull: "当你在同一局里累计打出两个对子之后，就可以弃掉一张手牌，用这个方式加快清空自己手牌的速度。" },
    curry: { key: "curry", name: "库里", skill: "百步穿杨", type: "active", cd: "1局2次", desc: "对子当作三张打出（重组三连）", descFull: "你可以把手中的一个对子当成三张同点数牌打出去，重组为一个三张牌型，每局可以用两次。" },
    lebron: { key: "lebron", name: "詹姆斯", skill: "加冕", type: "active", cd: "1局1次", desc: "截下一张无人能压的单牌并领出", descFull: "你可以截下一张当前场上谁都压不住的单牌，然后由你重新领出，每局限用一次。" },
    jordan: { key: "jordan", name: "乔丹", skill: "神之一手", type: "active", cd: "每局指定" + JORDAN_WILDS + "张", desc: "开局主动指定" + JORDAN_WILDS + "张手牌为万能牌（可变2–A任意牌，不可当王）", descFull: "开局时你可以主动指定 " + JORDAN_WILDS + " 张手牌当作万能牌，万能牌能变成 2 到 A 之间的任意点数，但不能当作王牌使用。" },
    // ===== 扩库 v1.1 · 已确认 10 人（现役5 + 退役5）=====
    giannis: { key: "giannis", name: "字母哥", skill: "字母轰炸", type: "passive", cd: "常驻", desc: "被动：出牌被对手压→造犯规+1；累计满4点弃掉一张牌并清零", descFull: "当你打出的牌被对手压住时，你会累计一次犯规；等犯规累计满 4 次，你就弃掉一张手牌，然后犯规数清零重新计算。" },
    edwards: { key: "edwards", name: "爱德华兹", skill: "三分暴雨", type: "active", cd: "1局1次", desc: "合成一对打出，对子点数取两张中较小者", descFull: "你可以把手中任意两张牌临时合成一个对子打出去，这个对子的点数以两张里较小的那张为准，每局限用一次。" },
    mitchell: { key: "mitchell", name: "米切尔", skill: "关键先生", type: "active", cd: "1局1次", desc: "对手≤10张时冻结其下一次出牌", descFull: "当某位对手的手牌剩下 10 张或更少时，你可以冻结他的下一次出牌机会，让他这一轮只能过牌，每局限用一次。" },
    cunningham: { key: "cunningham", name: "坎宁安", skill: "组织发动机", type: "passive", cd: "常驻", desc: "场上连续打出4个相同牌型时，可弃掉点数最小的一张牌（弹窗询问，8s倒计时）", descFull: "当场上连续出现四个相同的牌型时，你可以弃掉手中点数最小的那张牌，系统会弹窗询问你，并在 8 秒倒计时结束后自动确认。" },
    leonard: { key: "leonard", name: "伦纳德", skill: "死亡缠绕", type: "passive", cd: "常驻", desc: "对手打出非王炸炸弹时，可选1-3张加入手牌", descFull: "当对手打出不是王炸的炸弹时，你可以从这手炸弹里挑 1 到 3 张牌收进自己的手牌。" },
    kareem: { key: "kareem", name: "贾巴尔", skill: "天勾无解", type: "passive", cd: "常驻", desc: "被动：压牌时你的单张可当作对子使用", descFull: "当轮到你压别人的牌时，你手里的单张可以被当作一个对子来使用，用来压住对方的对子。" },
    magic: { key: "magic", name: "魔术师", skill: "showtime", type: "active", cd: "1局1次", desc: "手牌≤10张时，可选把任意一张手牌送给另两玩家中的0/1/2人", descFull: "当你的手牌剩下 10 张或更少时，你可以选一张手牌送给另外两名玩家中的任意一人、送给两个人，或者谁都不送，每局限用一次。" },
    bird: { key: "bird", name: "伯德", skill: "致命三分", type: "passive", cd: "常驻", desc: "三带牌型可带两张不同点单张（三带二不变）", descFull: "你打出的三带牌型可以带两张点数不同的单张，而原本三带二的规则保持照旧不变。" },
    kg: { key: "kg", name: "加内特", skill: "铁血全能", type: "reactive", cd: "1局2次", desc: "被压时随机获得一张≤K的牌，并选择弃掉一张", descFull: "当你的牌被对手压住时，你会随机拿到一张不大于 K 的牌，然后再选一张手牌弃掉，每局最多触发两次。" },
    wade: { key: "wade", name: "韦德", skill: "闪电突破", type: "passive", cd: "常驻", desc: "点数≤10的单牌默认+1", descFull: "你打出的点数不大于 10 的单张牌，点数会自动加 1，让你更容易压住对手的单牌。" }
  };
  const STAR_IMG = {
    jokic: "star_cards/A_jokic_hearthstone.jpg", wembanyama: "star_cards/A_wembanyama_hearthstone.jpg",
    alexander: "star_cards/A_alexander_hearthstone.jpg", brunson: "star_cards/A_brunson_hearthstone.jpg",
    durant: "star_cards/A_durant_hearthstone.jpg", harden: "star_cards/A_harden_hearthstone.jpg",
    doncic: "star_cards/A_doncic_hearthstone.jpg", kobe: "star_cards/A_kobe_hearthstone.jpg",
    duncan: "star_cards/A_duncan_hearthstone.jpg", oNeal: "star_cards/A_oNeal_hearthstone.jpg",
    kidd: "star_cards/A_kidd_hearthstone.jpg", nowitzki: "star_cards/A_nowitzki_hearthstone.jpg",
    curry: "star_cards/A_curry_hearthstone.jpg", lebron: "star_cards/A_lebron_hearthstone.jpg",
    jordan: "star_cards/A_jordan_hearthstone.jpg",
    giannis: "star_cards/A_giannis_hearthstone.jpg", edwards: "star_cards/A_edwards_hearthstone.jpg",
    mitchell: "star_cards/A_mitchell_hearthstone.jpg", cunningham: "star_cards/A_cunningham_hearthstone.jpg",
    leonard: "star_cards/A_leonard_hearthstone.jpg", kareem: "star_cards/A_kareem_hearthstone.jpg",
    magic: "star_cards/A_magic_hearthstone.jpg", bird: "star_cards/A_bird_hearthstone.jpg",
    kg: "star_cards/A_kg_hearthstone.jpg", wade: "star_cards/A_wade_hearthstone.jpg"
  };

  /* ---------- 牌组 ---------- */
  let CARD_SEQ = 0;
  function buildDeck() {
    const d = [];
    for (let v = 3; v <= 15; v++) for (const s of SUITS) d.push({ id: ++CARD_SEQ, v, s, red: !!RED[s], label: LABEL[v] });
    d.push({ id: ++CARD_SEQ, v: 16, s: "", red: false, label: "小王" });
    d.push({ id: ++CARD_SEQ, v: 17, s: "", red: true, label: "大王" });
    return d;
  }
  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  function sortHand(h) { h.sort((a, b) => b.v - a.v || ((SUIT_ORDER[b.s] ?? -1) - (SUIT_ORDER[a.s] ?? -1))); }
  function groupByVal(hand) { const g = {}; hand.forEach(c => (g[c.v] = g[c.v] || []).push(c)); return g; }
  function anyBomb(hand) { const g = groupByVal(hand); return (g[16] && g[17]) || Object.values(g).some(a => a.length === 4); }

  /* ---------- 走法解析 / 比较 ---------- */
  function isConsec(arr) { for (let i = 1; i < arr.length; i++) if (arr[i] !== arr[i - 1] + 1) return false; return true; }
  function findConsecRun(sorted, m) {
    for (let i = 0; i + m - 1 < sorted.length; i++) {
      let ok = true; for (let j = 0; j < m; j++) if (sorted[i + j] !== sorted[i] + j) { ok = false; break; }
      if (ok) return sorted.slice(i, i + m);
    }
    return null;
  }
  function parseMove(cards) {
    if (!cards || cards.length === 0) return null;
    const vals = cards.map(c => c.v).sort((a, b) => a - b);
    const n = vals.length;
    const counts = {}; vals.forEach(v => counts[v] = (counts[v] || 0) + 1);
    const ranks = Object.keys(counts).map(Number).sort((a, b) => a - b);
    if (n === 2 && counts[16] && counts[17]) return { type: "rocket", rank: 100, len: 1, cards };
    if (n === 4 && ranks.length === 1) return { type: "bomb", rank: ranks[0], len: 1, cards };
    if (n === 1) return { type: "single", rank: vals[0], len: 1, cards };
    if (n === 2 && ranks.length === 1) return { type: "pair", rank: ranks[0], len: 1, cards };
    if (n === 3 && ranks.length === 1) return { type: "triple", rank: ranks[0], len: 1, cards };
    if (n === 4) { const t = ranks.find(r => counts[r] === 3); if (t !== undefined) return { type: "triple1", rank: t, len: 1, cards }; return null; }
    if (n === 5) {
      const t = ranks.find(r => counts[r] === 3);
      if (t !== undefined) {
        const others = ranks.filter(r => r !== t);
        // 伯德·致命三分：三带两单（两张不同点单张，非对子）
        if (others.length === 2 && counts[others[0]] === 1 && counts[others[1]] === 1 && others[0] !== others[1]) return { type: "triple1s", rank: t, len: 1, cards };
        const p = ranks.find(r => counts[r] === 2);
        if (p !== undefined && p !== t) return { type: "triple2", rank: t, len: 1, cards };
      }
    }
    if (n >= 5 && ranks.length === n && isConsec(ranks) && ranks[ranks.length - 1] <= 14) return { type: "straight", rank: ranks[ranks.length - 1], len: n, cards };
    if (n >= 6 && n % 2 === 0 && ranks.length === n / 2 && ranks.every(r => counts[r] === 2) && isConsec(ranks) && ranks[ranks.length - 1] <= 14) return { type: "double", rank: ranks[ranks.length - 1], len: n / 2, cards };
    const tripleRanks = ranks.filter(r => counts[r] >= 3 && r <= 14).sort((a, b) => a - b);
    if (n % 3 === 0) { const m = n / 3; if (tripleRanks.length === m && isConsec(tripleRanks) && ranks.every(r => counts[r] === 3)) return { type: "airplane", rank: tripleRanks[m - 1], len: m, cards }; }
    if (n % 4 === 0) { const m = n / 4; const run = findConsecRun(tripleRanks, m); if (run) { const used = {}; run.forEach(r => used[r] = 3); let rem = 0; vals.forEach(v => { if (used[v] > 0) used[v]--; else rem++; }); if (rem === m) return { type: "airplane1", rank: run[m - 1], len: m, cards }; } }
    if (n % 5 === 0) { const m = n / 5; const run = findConsecRun(tripleRanks, m); if (run) { const used = {}; run.forEach(r => used[r] = 3); const rv = []; vals.forEach(v => { if (used[v] > 0) used[v]--; else rv.push(v); }); if (rv.length === 2 * m) { const rc = {}; rv.forEach(v => rc[v] = (rc[v] || 0) + 1); if (Object.values(rc).every(c => c === 2)) return { type: "airplane2", rank: run[m - 1], len: m, cards }; } } }
    return null;
  }
  function beats(prev, mv) {
    if (!prev) return true;
    if (mv.type === "rocket") return true;
    if (mv.type === "bomb") { if (prev.type === "rocket") return false; if (prev.type === "bomb") return mv.rank > prev.rank; return true; }
    if (prev.type === "bomb" || prev.type === "rocket") return false;
    if (prev.type === "triple1s") { if (mv.type !== "triple1s") return false; return mv.rank > prev.rank; }
    return mv.type === prev.type && mv.len === prev.len && mv.rank > prev.rank;
  }
  // 万能牌解析：给定物理牌（含万能牌）与「每张万能牌→代表点数」映射，返回带替点 rank 的走法；cards 仍是原始物理牌引用
  function parseMoveWithWild(cards, wildMap) {
    if (!cards || !cards.length) return null;
    const tmp = cards.map(c => (wildMap[c.id] !== undefined) ? { ...c, v: wildMap[c.id] } : c);
    const mv = parseMove(tmp);
    if (!mv) return null;
    mv.cards = mv.cards.map(mc => cards.find(x => x.id === mc.id));
    return mv;
  }

  /* ---------- 走子生成（纯函数，不读 G） ---------- */
  function genAllMoves(hand) {
    const moves = []; const g = groupByVal(hand); const vals = Object.keys(g).map(Number).sort((a, b) => a - b);
    vals.forEach(v => moves.push({ type: "single", rank: v, len: 1, cards: [g[v][0]] }));
    vals.forEach(v => { if (g[v].length >= 2) moves.push({ type: "pair", rank: v, len: 1, cards: g[v].slice(0, 2) }); });
    vals.forEach(v => { if (g[v].length >= 3) {
      moves.push({ type: "triple", rank: v, len: 1, cards: g[v].slice(0, 3) });
      const other = vals.find(o => o !== v && g[o].length >= 1); if (other !== undefined) moves.push({ type: "triple1", rank: v, len: 1, cards: g[v].slice(0, 3).concat(g[other][0]) });
      const op = vals.find(o => o !== v && g[o].length >= 2); if (op !== undefined) moves.push({ type: "triple2", rank: v, len: 1, cards: g[v].slice(0, 3).concat(g[op].slice(0, 2)) });
    } });
    vals.forEach(v => { if (g[v].length === 4) moves.push({ type: "bomb", rank: v, len: 1, cards: g[v].slice(0, 4) }); });
    if (g[16] && g[17]) moves.push({ type: "rocket", rank: 100, len: 1, cards: [g[16][0], g[17][0]] });
    for (let len = 5; len <= 12; len++) for (let s = 3; s + len - 1 <= 14; s++) {
      let ok = true; const cs = []; for (let k = 0; k < len; k++) { if (!g[s + k]) { ok = false; break; } cs.push(g[s + k][0]); }
      if (ok) moves.push({ type: "straight", rank: s + len - 1, len, cards: cs });
    }
    for (let len = 3; len <= 10; len++) for (let s = 3; s + len - 1 <= 14; s++) {
      let ok = true; const cs = []; for (let k = 0; k < len; k++) { if (!g[s + k] || g[s + k].length < 2) { ok = false; break; } cs.push(g[s + k][0], g[s + k][1]); }
      if (ok) moves.push({ type: "double", rank: s + len - 1, len, cards: cs });
    }
    return moves;
  }
  function genBeating(hand, prev) {
    if (prev.type === "rocket") return [];
    const out = []; const g = groupByVal(hand); const vals = Object.keys(g).map(Number).sort((a, b) => a - b);
    if (prev.type === "single") { vals.forEach(v => { if (v > prev.rank) out.push({ type: "single", rank: v, len: 1, cards: [g[v][0]] }); }); }
    else if (prev.type === "pair") { vals.forEach(v => { if (v > prev.rank && g[v].length >= 2) out.push({ type: "pair", rank: v, len: 1, cards: g[v].slice(0, 2) }); }); }
    else if (prev.type === "triple") { vals.forEach(v => { if (v > prev.rank && g[v].length >= 3) out.push({ type: "triple", rank: v, len: 1, cards: g[v].slice(0, 3) }); }); }
    else if (prev.type === "triple1") { vals.forEach(v => { if (v > prev.rank && g[v].length >= 3) { const o = vals.find(x => x !== v && g[x].length >= 1); if (o !== undefined) out.push({ type: "triple1", rank: v, len: 1, cards: g[v].slice(0, 3).concat(g[o][0]) }); } }); }
    else if (prev.type === "triple2") { vals.forEach(v => { if (v > prev.rank && g[v].length >= 3) { const o = vals.find(x => x !== v && g[x].length >= 2); if (o !== undefined) out.push({ type: "triple2", rank: v, len: 1, cards: g[v].slice(0, 3).concat(g[o].slice(0, 2)) }); } }); }
    else if (prev.type === "triple1s") { vals.forEach(v => { if (v > prev.rank && g[v].length >= 3) { const rest = vals.filter(o => o !== v); for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) { const o1 = rest[i], o2 = rest[j]; if (o1 !== o2 && g[o1].length >= 1 && g[o2].length >= 1) out.push({ type: "triple1s", rank: v, len: 1, cards: g[v].slice(0, 3).concat([g[o1][0], g[o2][0]]) }); } } }); }
    else if (prev.type === "straight") { for (let s = 3; s + prev.len - 1 <= 14; s++) { if (s + prev.len - 1 <= prev.rank) continue; let ok = true; const cs = []; for (let k = 0; k < prev.len; k++) { if (!g[s + k]) { ok = false; break; } cs.push(g[s + k][0]); } if (ok) out.push({ type: "straight", rank: s + prev.len - 1, len: prev.len, cards: cs }); } }
    else if (prev.type === "double") { for (let s = 3; s + prev.len - 1 <= 14; s++) { if (s + prev.len - 1 <= prev.rank) continue; let ok = true; const cs = []; for (let k = 0; k < prev.len; k++) { if (!g[s + k] || g[s + k].length < 2) { ok = false; break; } cs.push(g[s + k][0], g[s + k][1]); } if (ok) out.push({ type: "double", rank: s + prev.len - 1, len: prev.len, cards: cs }); } }
    else if (prev.type === "airplane" || prev.type === "airplane1" || prev.type === "airplane2") { /* AI 简化：略过飞机跟牌 */ }
    vals.forEach(v => { if (g[v].length === 4) out.push({ type: "bomb", rank: v, len: 1, cards: g[v].slice(0, 4) }); });
    if (g[16] && g[17]) out.push({ type: "rocket", rank: 100, len: 1, cards: [g[16][0], g[17][0]] });
    return out;
  }

  /* ---------- 评估 / 工具 ---------- */
  function handStrength(hand) {
    const g = groupByVal(hand); let s = 0;
    if (g[17]) s += 6;
    if (g[16]) s += 3;
    if (g[15]) s += g[15].length * 2.2;
    Object.values(g).forEach(a => { if (a.length === 4) s += 5; });
    [14, 13, 12, 11].forEach(v => { if (g[v]) s += g[v].length * (v - 10) * 0.4; });
    const vals = Object.keys(g).map(Number).sort((a, b) => a - b);
    let run = 1, maxrun = 1; for (let i = 1; i < vals.length; i++) { if (vals[i] === vals[i - 1] + 1) { run++; maxrun = Math.max(maxrun, run); } else run = 1; }
    if (maxrun >= 5) s += (maxrun - 4) * 1.2;
    return s;
  }
  function countBombs(hand) {
    const g = groupByVal(hand); let n = 0;
    if (g[16] && g[17]) n++;
    Object.values(g).forEach(a => { if (a.length === 4) n++; });
    return n;
  }
  function minTricks(hand) {
    const cnt = {}; hand.forEach(c => { cnt[c.v] = (cnt[c.v] || 0) + 1; });
    let tricks = 0;
    if (cnt[16] && cnt[17]) { tricks++; delete cnt[16]; delete cnt[17]; }
    else { if (cnt[16]) { tricks++; delete cnt[16]; } if (cnt[17]) { tricks++; delete cnt[17]; } }
    for (const v of Object.keys(cnt)) if (cnt[v] === 4) { tricks++; delete cnt[v]; }
    let found = true;
    while (found) { found = false;                       // 顺子 ≥5
      for (let s = 3; s <= 10; s++) { let len = 0; while (s + len <= 14 && cnt[s + len] > 0) len++;
        if (len >= 5) { for (let k = 0; k < len; k++) { cnt[s + k]--; if (!cnt[s + k]) delete cnt[s + k]; } tricks++; found = true; break; } } }
    found = true;
    while (found) { found = false;                       // 连对 ≥3
      for (let s = 3; s <= 12; s++) { let len = 0; while (s + len <= 14 && cnt[s + len] >= 2) len++;
        if (len >= 3) { for (let k = 0; k < len; k++) { cnt[s + k] -= 2; if (!cnt[s + k]) delete cnt[s + k]; } tricks++; found = true; break; } } }
    let triples = 0, pairs = 0, singles = 0;
    for (const v of Object.keys(cnt)) {
      let n = cnt[v];
      if (n >= 3) { triples++; n -= 3; }
      if (n === 2) pairs++; else if (n === 1) singles++;
    }
    let t = triples;
    while (t > 0 && (pairs > 0 || singles > 0)) { if (singles > 0) singles--; else pairs--; t--; tricks++; }  // 三带吸收散牌
    return tricks + t + pairs + singles;
  }
  function oppAll(s) { return [0, 1, 2].filter(x => x !== s); }
  function remapLevel(v) { return v < 15 ? Math.min(16, v + 1) : v; }
  function pickTwoLowest(h) { return h.slice().sort((a, b) => a.v - b.v).slice(0, Math.min(JORDAN_WILDS, h.length)); }

  return {
    SUITS, RED, SUIT_ORDER, LABEL, V_RANK, SUIT_NAME, JORDAN_WILDS, STARS, STAR_IMG,
    buildDeck, shuffle, sortHand, groupByVal, anyBomb,
    isConsec, findConsecRun, parseMove, beats, parseMoveWithWild,
    genAllMoves, genBeating, handStrength, countBombs, minTricks,
    oppAll, remapLevel, pickTwoLowest
  };
});
