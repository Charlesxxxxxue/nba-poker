/* NBA Poker · v1.2 扩库仿真台（10 新球星平衡验证 · 修正对照法）
 * 载入 PLAYABLE_v1.9.html 引擎主脚本，在 vm 沙箱跑确定性对局。
 * 用法：node sim_v11.js <STAR0> <N> [SEED]
 *   STAR0 = 被测新球星 key（giannis/edwards/mitchell/cunningham/leonard/kareem/magic/bird/kg/wade）
 *   N     = 每策略局数（默认 200）
 *   SEED  = 随机种子（默认 20260901）
 * 对照法（v1.2 修正）：skilled 与 naive 均走同一决策引擎 autoPlaySeat，唯一差异为 seat0 是否有星
 *   —— naive 在 renderPickStar 中清空 seat0 球星（仅 aiStrong 强策略、无任何球星效果），作为无星基线；
 *   —— 二者在完全相同发牌+对手下成对可比，胜率差 = 该球星对「普通强策略玩家」的纯粹边际价值。
 *   （v1.1 的旧法 naive 用最小牌策略，混淆了「决策质量」与「球星价值」，已弃用。）
 * 输出：无星基线胜率 / 持星胜率 / 技能触发率 / 球星边际价值(pp) / 平衡结论。
 */
const fs=require('fs'),vm=require('vm');
const FILE='/Users/charlescxue/WorkBuddy/20260524094804/nba-poker/03_playable_proto/PLAYABLE_v1.9.html';
const STAR0=process.argv[2]||'giannis';
const N=Number(process.argv[3]||200);
const SEED=Number(process.argv[4]||20260901);
const code = fs.readFileSync(FILE,'utf8').match(/<script>([\s\S]*?)<\/script>/)[1]
  .replace('const G={','var G={').replace('let selected=new Set();','var selected=new Set();');

function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

function fakeEl(){return new Proxy({style:{},classList:{add(){},remove(){},toggle(){},contains(){return false;}},_t:"",_h:"",
  set textContent(v){this._t=v;},get textContent(){return this._t;},
  set innerHTML(v){this._h=v;},get innerHTML(){return this._h;},
  appendChild(){},append(){},remove(){},focus(){},querySelector(){return fakeEl();},querySelectorAll(){return [];},addEventListener(){},
  set onclick(f){this._click=f;},get onclick(){return this._click;},set className(v){},get className(){return "";}},
  {get(t,p){return p in t?t[p]:undefined;},set(t,p,v){t[p]=v;return true;}});}
const doc={getElementById(){return fakeEl();},createElement(){return fakeEl();},querySelectorAll(){return [];},addEventListener(){}};

function runOnce(policy,seed){
  const rng=mulberry32(seed);
  const seededMath=Object.create(Math); seededMath.random=()=>rng();
  const ctx={document:doc,window:{addEventListener(){},matchMedia:()=>({matches:false}),innerWidth:1280},console,Math:seededMath,alert:()=>{},Set};
  const queue=[];
  ctx.setTimeout=(fn)=>{ queue.push(fn); return 0; };
  ctx.clearTimeout=()=>{}; ctx.setInterval=()=>0; ctx.clearInterval=()=>{};
  vm.createContext(ctx);
  // 先装载纯规则模块 rules.js（提供 STARS / parseMove / genAllMoves 等全局符号）
  const rulesCode=fs.readFileSync('/Users/charlescxue/WorkBuddy/20260524094804/nba-poker/03_playable_proto/rules.js','utf8');
  vm.runInContext(rulesCode,ctx);
  vm.runInContext(code,ctx);
  let skillUsedFlag=false;
  const origStart=ctx.startGame;
  ctx.startGame=function(){ skillUsedFlag=false; return origStart(); };
  const _cm=ctx.commitMove, _am=ctx.applyMove;
  ctx.commitMove=function(s,mv){ if(s===0&&mv&&(mv.type==='bomb'||mv.type==='rocket')) {} return _cm(s,mv); };
  ctx.applyMove =function(s,mv){ if(s===0&&mv&&(mv.type==='bomb'||mv.type==='rocket')) {} return _am(s,mv); };
  ctx.startCountdown=()=>{};
  ctx.SIM_MODE=true;   // v1.9.7：基德分配在无头仿真下自动全留，避免等待真人点击
  /* v1.9.9c 仿真台修复：jordan 选星后引擎会进入「等真人点选万能牌」的 UI，
   * 无头环境既没有可点的按钮、fakeEl 也缺 remove()，导致 sim 在 25 星全量重跑时
   * 对 jordan 直接 CRASH。与 star_health_5g.js 同口径：自动指定两张最小牌为万能牌。 */
  ctx.enterJordanWildSelect=function(){
    const h=ctx.G.players[0].hand;
    ctx.G.ss[0].wildIds=h.length?ctx.pickTwoLowest(h).map(c=>c.id):[];
    ctx.G.jordanSelect=false;
    ctx.stepBid();
  };
  // 选星：seat0 = STAR0，seat1/2 随机旧星（含部分新星也行，保持对手有技能）
  // 控制条件修正：naive 模式让 seat0 = 无球星（清空 star/skillStar），使被动/反应钩子不再触发，
  // 从而得到「纯普通玩家」基线；skilled 模式保留 STAR0 全部技能。两模式仅 seat0 是否有星不同。
  ctx.renderPickStar=function(){ ctx.pickStar(STAR0); if(policy==='naive'){ ctx.G.star[0]=''; ctx.G.skillStar=''; } };
  ctx.renderControls_bid=function(){
    if(policy==='skilled'){ ctx.doBid(0, ctx.aiBid(ctx.G.players[0].hand)); return; }
    ctx.doBid(0, ctx.aiBid(ctx.G.players[0].hand)>=3?3:0);
  };
  ctx.renderControls_rob=function(){ if(ctx.doRob) ctx.doRob(0, ctx.aiRob(ctx.G.players[0].hand)); };
  ctx.renderControls_double=function(){ if(policy==='skilled' && rng()<0.45) ctx.G.mult*=2; ctx.G.doubleDone=true; ctx.startPlay(); };
  ctx.offerImmunity=function(seat,mv){ if(policy==='skilled'){ ctx.G.jordanShield=false; ctx.G.turn=0; ctx.G.lastMove=null; ctx.G.passes=0; ctx.nextTurn(); } else { ctx.commitMove(seat,mv); } };
  // 两种策略共用同一决策引擎 autoPlaySeat：
  //  - skilled：seat0=STAR0（保留全部主动/被动/反应技能）
  //  - naive  ：seat0 已在 renderPickStar 中清空球星（仅用 aiStrong 强策略决策，无任何球星效果）
  // 二者唯一差异 = seat0 是否有星，因此 skilled/naive 在完全相同发牌+对手下成对可比，
  // 胜率差 = 该球星对「普通强策略玩家」的纯粹边际价值。
  ctx.enableHumanTurn=function(){ ctx.autoPlaySeat(0, ctx.G.lastMove); };
  const stats=[]; let total=0;
  ctx.endGame=function(w){
    const landlord=ctx.G.landlord;
    const humanWin=(w===0);
    // 技能触发判定：扫描本局是否用过 STAR0 的关键状态
    const S=ctx.G.ss[0]||{};
    /* v1.9.9：旧版只认 10 个扩库星字段（且把韦德写成不存在的 wadeUsed），
     * 导致 curry / harden / wade / jordan 等「明明已触发」却报 0% 触发率。
     * v1.9.9c：brunson / kobe 已补状态标记（_brunson 走法 / 一手清台），纳入统计。 */
    const USED_FIELDS=['jokicUsed','wembyUsed','durantUsed','hardenUsed','doncicUsed','leonardUsed',
      'kareemUsed','magicUsed','birdUsed','lebronUsed','mitchellUsed','oNealUsed','giannisUsed',
      'kiddSeen','edwardsBoost','cunninghamCount','curryUsed','kgUsed','wadeCount','duncanBlocks',
      'retakeReady','discarded','brunsonUsed','kobeUsed'];
    const used = USED_FIELDS.some(k=>(S[k]||0)>0 || S[k]===true)
      || (S.wildIds && S.wildIds.length>0)
      || Object.keys(S.foul||{}).length>0 || Object.keys(S.drawn||{}).length>0
      || !!ctx.G.kiddAssigned || false;
    stats.push({humanWin, used:!!used, moves:ctx.G.moveCount});
    total++;
    if(total<N) ctx.startGame();
  };
  ctx.startGame();
  let guard=0;
  try {
    while(queue.length && guard<5_000_000){ const fn=queue.shift(); fn(); guard++; }
  } catch(e){
    console.error('CRASH seed='+seed+' policy='+policy+' guard='+guard,
      'turn='+ctx.G.turn,'lastSeat='+ctx.G.lastSeat,'passes='+ctx.G.passes,'lastMove='+(ctx.G.lastMove&&ctx.G.lastMove.type),
      'phase='+ctx.G.phase,'hands='+ctx.G.players.map(p=>p.hand.length));
    throw e;
  }
  return stats;
}

function summarize(stats){
  const n=stats.length;
  const win=stats.filter(s=>s.humanWin).length/n;
  const used=stats.filter(s=>s.used).length/n;
  const moves=stats.reduce((a,s)=>a+s.moves,0)/n;
  return {n,win,used,moves};
}

const sk=summarize(runOnce('skilled',SEED));
const nv=summarize(runOnce('naive',SEED));
const delta=sk.win-nv.win;                 // 球星对强策略玩家的纯粹边际价值（胜率差 pp）
const deltaPP=delta*100;
let verdict, band;
if(deltaPP <= 5)        { verdict='⚠️ 技能近乎失效（触发/价值过低，需重做）'; band='fail'; }
else if(deltaPP <= 15)  { verdict='🟡 温和（可接受下限）'; band='mild'; }
else if(deltaPP <= 35)  { verdict='✅ 平衡合理'; band='ok'; }
else if(deltaPP <= 50)  { verdict='⚠️ 偏强（建议回调）'; band='strong'; }
else                    { verdict='⚠️ 过强（需回调）'; band='op'; }
if(deltaPP < 0)          verdict='⚠️ 技能净减胜率（需检查实现）';
if(sk.win > 0.85)        verdict += ' · 绝对胜率过高(>85%)';
console.log('========================================================');
console.log(`球星 [${STAR0}]  ·  N=${N} 种子=${SEED}`);
console.log('--------------------------------------------------------');
console.log(`无星基线(强策略) 人类胜率 : ${(nv.win*100).toFixed(1)}%`);
console.log(`持星(技能开)     人类胜率 : ${(sk.win*100).toFixed(1)}%   技能触发率 ${(sk.used*100).toFixed(1)}%   均手数 ${sk.moves.toFixed(0)}`);
console.log(`球星边际价值(胜率差)       : ${deltaPP.toFixed(1)}pp`);
console.log(`平衡结论                     : ${verdict}`);
console.log('========================================================');
