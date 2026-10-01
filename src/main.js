const STORE = 'takken-sprint-v2';
const SESSION = 'takken-run-session';
const RETENTION_DUE = 0.82;
const MIN10 = 10 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const STEPS = [MIN10, DAY, 3 * DAY, 7 * DAY];

const session = loadSession();
let audioCtx = null;

function defaultState() {
  return {
    xp: 0,
    bestCombo: 0,
    streak: 0,
    lastDay: '',
    cards: {},
    daily: blankDaily(localDate()),
    settings: { sound: true },
    log: {}
  };
}

function blankDaily(date) {
  return {
    date,
    answered: 0,
    newCount: 0,
    reviewDone: 0,
    xp: 0,
    comboMax: 0,
    missions: { reviews: false, volume: false, combo: false }
  };
}

function loadSession() {
  const base = { combo: 0, xp: 0, answered: 0, started: Date.now(), queue: [], revisit: [], untilRevisit: 0, lastId: null, retryId: null, showing: null, deal: null, currentId: null, advanceAt: 0 };
  try {
    const raw = sessionStorage.getItem(SESSION);
    if (!raw) return base;
    return { ...base, ...JSON.parse(raw), showing: null, deal: null };
  } catch (_) {
    return base;
  }
}

function persistSession() {
  sessionStorage.setItem(SESSION, JSON.stringify({
    combo: session.combo,
    xp: session.xp,
    answered: session.answered,
    started: session.started,
    queue: session.queue,
    revisit: session.revisit,
    untilRevisit: session.untilRevisit,
    lastId: session.lastId,
    retryId: session.retryId
  }));
}

function migrate() {
  const raw = localStorage.getItem(STORE);
  if (raw) {
    const parsed = JSON.parse(raw);
    parsed.cards ||= {};
    parsed.settings ||= { sound: true };
    parsed.log ||= {};
    if (!parsed.daily || parsed.daily.date !== localDate()) parsed.daily = blankDaily(localDate());
    return parsed;
  }
  const state = defaultState();
  const v1 = localStorage.getItem('takken-sprint-v1');
  if (!v1) return state;
  try {
    const old = JSON.parse(v1);
    state.xp = old.xp || 0;
    state.streak = old.streak || 0;
    state.lastDay = old.lastDay || '';
  } catch (_) {}
  return state;
}

const state = migrate();

function save() {
  localStorage.setItem(STORE, JSON.stringify(state));
  persistSession();
}

function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function examDate() {
  const [y, m, d] = EXAM.date.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function daysLeft() {
  return Math.max(0, Math.round((startOfDay(examDate()) - startOfDay(new Date())) / DAY));
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function cardOf(id) {
  return state.cards[id];
}

function stabilityMs(card) {
  return Math.max(MIN10, card?.stability || MIN10);
}

function retentionOf(card, now = Date.now()) {
  if (!card || !card.last) return 0;
  const S = stabilityMs(card) / -Math.log(RETENTION_DUE);
  return Math.exp(-(now - card.last) / S);
}

function isDue(card, now = Date.now()) {
  if (!card) return false;
  return (card.due || 0) <= now || retentionOf(card, now) < RETENTION_DUE;
}

function dueCards() {
  return QUESTIONS.filter(q => isDue(cardOf(q.id))).sort((a, b) => {
    const ca = cardOf(a.id);
    const cb = cardOf(b.id);
    if ((cb?.lapses || 0) !== (ca?.lapses || 0)) return (cb?.lapses || 0) - (ca?.lapses || 0);
    return retentionOf(ca) - retentionOf(cb);
  });
}

function decayingSoon() {
  const now = Date.now();
  return QUESTIONS.filter(q => {
    const c = cardOf(q.id);
    if (!c || isDue(c, now)) return false;
    return retentionOf(c, now) < 0.92;
  }).sort((a, b) => retentionOf(cardOf(a.id)) - retentionOf(cardOf(b.id)));
}

function unseen() {
  return QUESTIONS.filter(q => !cardOf(q.id));
}

function areaMastery(area) {
  const qs = QUESTIONS.filter(q => q.area === area);
  const seen = qs.filter(q => cardOf(q.id));
  if (!seen.length) return 0;
  const proven = seen.reduce((acc, q) => {
    const c = cardOf(q.id);
    const accu = c.reps / Math.max(1, c.reps + c.lapses);
    return acc + retentionOf(c) * (0.4 + 0.6 * accu);
  }, 0) / seen.length;
  return (seen.length / (seen.length + 4)) * proven;
}

function predictedScore() {
  let total = 0;
  for (const [area, weight] of Object.entries(AREA_WEIGHT)) {
    total += weight * Math.min(0.96, 0.2 + areaMastery(area) * 0.85);
  }
  return Math.round(total);
}

function currentPhase() {
  const left = daysLeft();
  return PHASES.find(p => left >= p.untilDay) || PHASES[PHASES.length - 1];
}

function dailyTarget() {
  const left = Math.max(1, daysLeft());
  return Math.max(10, Math.min(16, Math.ceil(unseen().length / left) + 6));
}

function nextNew() {
  const phase = currentPhase();
  return unseen().slice().sort((a, b) => {
    const af = phase.focus.includes(a.area) ? 3 : 1;
    const bf = phase.focus.includes(b.area) ? 3 : 1;
    const aw = (AREA_WEIGHT[a.area] / 20) * a.y * af * (1.2 - areaMastery(a.area));
    const bw = (AREA_WEIGHT[b.area] / 20) * b.y * bf * (1.2 - areaMastery(b.area));
    return bw - aw;
  })[0] || null;
}

function weakest() {
  return QUESTIONS.filter(q => cardOf(q.id)).sort((a, b) => {
    const ca = cardOf(a.id);
    const cb = cardOf(b.id);
    return (retentionOf(ca) - ca.lapses * 0.08) - (retentionOf(cb) - cb.lapses * 0.08);
  })[0] || null;
}

function questionById(id) {
  return QUESTIONS.find(item => item.id === id) || null;
}

function currentQuestion() {
  if (session.showing?.id) {
    const shown = questionById(session.showing.id);
    if (shown) return shown;
  }
  const pin = Number(new URLSearchParams(location.hash.split('?')[1] || '').get('id'));
  if (pin) {
    const pinned = questionById(pin);
    if (pinned) {
      session.currentId = pinned.id;
      return pinned;
    }
  }
  if (session.currentId) {
    const current = questionById(session.currentId);
    if (current) return current;
  }
  const q = pickNext();
  session.currentId = q ? q.id : null;
  return q;
}

function pickNext() {
  const avoid = session.lastId;
  session.revisit = session.revisit || [];
  if (session.revisit.length && !(session.untilRevisit > 0)) {
    const id = session.revisit.shift();
    const again = questionById(id);
    if (again && again.id !== avoid) {
      session.untilRevisit = 3;
      session.retryId = again.id;
      return again;
    }
  }
  if (session.untilRevisit > 0) session.untilRevisit -= 1;
  session.retryId = null;
  return dueCards().find(q => q.id !== avoid)
    || nextNew()
    || weakest()
    || questionById(avoid);
}

function deal(q) {
  if (session.deal && session.deal.id === q.id) return session.deal;
  const idxs = [0, 1, 2, 3];
  for (let i = idxs.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [idxs[i], idxs[j]] = [idxs[j], idxs[i]];
  }
  session.deal = {
    id: q.id,
    order: idxs,
    a: idxs.map(i => q.a[i]),
    correct: idxs.indexOf(q.correct)
  };
  return session.deal;
}

function schedule(id, correct) {
  const now = Date.now();
  const prev = cardOf(id) || { ease: 2.3, reps: 0, lapses: 0, stability: 0, last: 0, due: now, stage: 0 };
  if (correct) {
    prev.reps += 1;
    const step = STEPS[Math.min(prev.reps, STEPS.length) - 1];
    if (prev.reps <= STEPS.length) {
      prev.stability = step;
      prev.stage = prev.reps;
    } else {
      prev.ease = Math.min(2.8, prev.ease + 0.08);
      prev.stability = Math.min(DAY * 16, Math.round(prev.stability * prev.ease));
      prev.stage = Math.min(8, prev.stage + 1);
    }
  } else {
    prev.lapses += 1;
    prev.reps = 0;
    prev.ease = Math.max(1.3, prev.ease - 0.2);
    prev.stability = MIN10;
    prev.stage = 0;
  }
  prev.last = now;
  prev.due = now + prev.stability;
  state.cards[id] = prev;
}

function overtime() {
  return Object.values(state.daily.missions).every(Boolean);
}

function xpFor(ok) {
  const base = ok ? 12 : 4;
  const comboBonus = ok ? Math.min(24, session.combo * 2) : 0;
  return Math.round((base + comboBonus) * (overtime() ? 2 : 1));
}

function bumpStreak() {
  const today = localDate();
  if (state.lastDay === today) return;
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (state.lastDay === localDate(y)) state.streak += 1;
  else state.streak = 1;
  state.lastDay = today;
}

function updateMissions() {
  const d = state.daily;
  d.missions.reviews = dueCards().length === 0;
  d.missions.volume = d.answered >= dailyTarget();
  d.missions.combo = d.comboMax >= 5;
}

function ensureDaily() {
  const today = localDate();
  if (state.daily.date !== today) state.daily = blankDaily(today);
}

function beep(ok, combo) {
  if (!state.settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g);
    g.connect(audioCtx.destination);
    if (ok) {
      o.type = 'square';
      const start = combo >= 5 ? 880 : 660;
      o.frequency.setValueAtTime(start, audioCtx.currentTime);
      o.frequency.exponentialRampToValueAtTime(start * 1.5, audioCtx.currentTime + 0.09);
      g.gain.setValueAtTime(0.05, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.18);
      o.start();
      o.stop(audioCtx.currentTime + 0.18);
    } else {
      o.type = 'sawtooth';
      o.frequency.value = 140;
      g.gain.setValueAtTime(0.06, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.28);
      o.start();
      o.stop(audioCtx.currentTime + 0.28);
    }
  } catch (_) {}
}

function vibrate(ok) {
  try {
    if (navigator.vibrate) navigator.vibrate(ok ? [10, 20, 10] : [50, 40, 90]);
  } catch (_) {}
}

function burst(ok) {
  const root = document.getElementById('burst');
  if (!root) return;
  root.innerHTML = '';
  const n = ok ? 20 : 8;
  for (let i = 0; i < n; i += 1) {
    const s = document.createElement('i');
    const angle = (Math.PI * 2 * i) / n;
    const dist = 80 + Math.random() * 100;
    s.style.setProperty('--x', `${Math.cos(angle) * dist}px`);
    s.style.setProperty('--y', `${Math.sin(angle) * dist}px`);
    s.className = ok ? 'go' : 'no';
    root.appendChild(s);
  }
  setTimeout(() => { root.innerHTML = ''; }, 800);
}

function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 1600);
}

function comboLabel(n) {
  return `連続${n}`;
}

function fmtRemain(ms) {
  if (ms <= 0) return '今';
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60 ? pad(s % 60) + '秒' : ''}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間${m % 60}分`;
  return `${Math.floor(h / 24)}日`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function nextDueMs() {
  const times = Object.values(state.cards).map(c => c.due).filter(Boolean).sort((a, b) => a - b);
  if (!times.length) return null;
  return times[0] - Date.now();
}

function header(view) {
  const due = dueCards().length;
  const soon = decayingSoon().length;
  return `
    <header>
      <a class="brand" href="#/">宅建<span>学習</span></a>
      <div class="hud">
        <button class="icon-btn" data-sound title="音">${state.settings.sound ? '音' : '静'}</button>
        <div class="xp" id="hud-score">予測 ${predictedScore()}点</div>
        <div class="xp" id="hud-xp">${state.xp} XP</div>
        <div class="combo-mini ${session.combo >= 3 ? 'hot' : ''}" id="hud-combo">連続 ${session.combo}</div>
      </div>
    </header>
    <nav>
      ${[
        ['/', 'ホーム', ''],
        ['/play', '問題', due ? String(due) : ''],
        ['/memory', '復習', soon ? String(soon) : ''],
        ['/plan', '計画', ''],
        ['/guide', '論点', ''],
        ['/stats', '統計', '']
      ].map(([p, n, badge]) => `
        <a class="${view === p ? 'active' : ''}" href="#${p}">${n}${badge ? `<em>${badge}</em>` : ''}</a>
      `).join('')}
    </nav>
  `;
}

function missionItem(done, title, sub) {
  return `<li class="${done ? 'done' : ''}"><i></i><div><b>${title}</b><span>${sub}</span></div></li>`;
}

function dueChip() {
  const hook = nextDueMs();
  if (hook === null) return '';
  const due = dueCards().length;
  const cls = hook <= 0 || due ? 'hot' : hook <= MIN10 ? 'soon' : '';
  const label = due ? `今の復習 ${due}問` : `次の復習まで ${fmtRemain(hook)}`;
  return `<a class="due-chip ${cls}" id="due-chip" href="#/play">${label}</a>`;
}

function dashboard() {
  ensureDaily();
  updateMissions();
  const left = daysLeft();
  const score = predictedScore();
  const due = dueCards();
  const soon = decayingSoon();
  const d = state.daily;
  const target = dailyTarget();
  const pct = Math.min(100, Math.round((d.answered / target) * 100));
  const phase = currentPhase();
  const hook = nextDueMs();
  const missionsDone = Object.values(d.missions).filter(Boolean).length;
  const cta = due.length ? '復習を始める' : unseen().length ? '問題を解く' : 'もう一度解く';
  const passGap = EXAM.passLine - score;
  const learned = Object.keys(state.cards).length;

  return `${header('/')}
    <main>
      ${dueChip()}
      <section class="hero">
        <p class="eyebrow">2026年10月18日 13:00｜自分用</p>
        <div class="hero-grid">
          <div>
            <p class="kicker">試験まで</p>
            <h1><em>${left}</em><small>日</small></h1>
            <p class="lead">${left === 0 ? '今日が試験日です。新しい範囲は増やさない。' : '短い問題を繰り返して、忘れにくい状態にする。'}</p>
          </div>
          <div class="score-orb ${score >= EXAM.passLine ? 'safe' : ''}">
            <span>予測得点</span>
            <b>${score}</b>
            <small>${passGap > 0 ? `合格線 ${EXAM.passLine} まであと ${passGap} 点` : `合格線 ${EXAM.passLine} 点を超えています`}</small>
          </div>
        </div>
        <a class="primary fat" href="#/play">${cta}</a>
        <a class="stat-entry" href="#/stats">統計の数字を入れる</a>
      </section>

      <section class="grid three">
        <article>
          <b>${d.answered}<small>/${target}</small></b>
          <span>今日解いた数</span>
          <i><u style="width:${pct}%"></u></i>
        </article>
        <article>
          <b>${state.streak}日</b>
          <span>連続日数</span>
          <small>${state.streak ? '今日も続けています' : '今日から始められます'}</small>
        </article>
        <article class="${due.length ? 'alert' : ''}">
          <b>${due.length}</b>
          <span>今の復習</span>
          <small>${soon.length ? `まもなく ${soon.length} 問` : '今はなし'}</small>
        </article>
      </section>

      <section class="panel">
        <div class="section-head">
          <h2>今日の課題</h2>
          <span>${missionsDone}/3 ${missionsDone === 3 ? '・達成（経験値2倍）' : ''}</span>
        </div>
        <ul class="missions">
          ${missionItem(d.missions.reviews, '期限の来た復習を終わらせる', due.length ? `残り ${due.length} 問` : '完了')}
          ${missionItem(d.missions.volume, `${target}問解く`, `${d.answered}/${target}`)}
          ${missionItem(d.missions.combo, '連続正解を5まで伸ばす', `今日の最大 ${d.comboMax}`)}
        </ul>
      </section>

      <section class="panel hook ${hook !== null && hook <= MIN10 ? 'pulse' : ''}">
        <div class="section-head">
          <h2>忘却曲線</h2>
          <span>記憶が8割を切る前に復習する</span>
        </div>
        <p class="curve-copy">覚えた直後の20分で、かなり忘れます。なので正解しても <b>10分後にもう一度</b>出します。間違えた問題はすぐ再出題します。そのあと 1日、3日、7日と間隔を空けます。</p>
        <div class="curve" aria-hidden="true">
          ${[0, 0.2, 1, 9, 24, 48, 72].map(h => `<span style="height:${Math.max(8, Math.exp(-h / 18) * 100)}%"></span>`).join('')}
        </div>
        <div class="hook-row">
          <div>
            <b id="hook-time">${hook === null ? 'まだ始めていません' : hook <= 0 ? '今が復習のタイミングです' : `次の復習まで ${fmtRemain(hook)}`}</b>
            <p>学習済み ${learned}/${QUESTIONS.length}問</p>
          </div>
          <a class="primary small" href="#/play">復習する</a>
        </div>
      </section>

      <section class="panel">
        <div class="section-head">
          <h2>科目の定着</h2>
          <span>本試験の配点で表示</span>
        </div>
        <div class="areas">
          ${Object.entries(AREA_WEIGHT).map(([area, w]) => {
            const m = Math.round(areaMastery(area) * 100);
            return `<div><div class="row"><b>${area}</b><span>${w}問 · ${m}%</span></div><i><u style="width:${m}%"></u></i></div>`;
          }).join('')}
        </div>
        <p class="phase">今の方針：${esc(phase.title)}。${esc(phase.hint)}</p>
      </section>
    </main>`;
}

function play() {
  const q = currentQuestion();
  if (!q) {
    return `${header('/play')}<main><div class="empty">
      <h2>出題できる問題がありません</h2>
      <a class="primary" href="#/">ホームへ</a>
    </div></main>`;
  }
  const shown = session.showing;
  const isCard = Boolean(q.ans);
  const revealed = isCard && Boolean(shown || session.revealed === q.id);
  const pack = isCard ? null : (shown || deal(q));
  const card = cardOf(q.id);
  const kind = shown?.kind || (
    session.retryId === q.id ? 'やり直し' : card ? '復習' : '新しい問題'
  );
  const target = dailyTarget();
  const heat = Math.min(100, session.combo * 12);
  const ret = card ? Math.round(retentionOf(card) * 100) : null;
  const remain = Math.max(0, target - state.daily.answered);
  const answers = isCard
    ? (!revealed
      ? `<button type="button" class="primary fat" id="reveal-q">答えを見る</button>`
      : `<div class="card-answer">
          <b>${esc(q.ans)}</b>
          <p>${esc(q.why)}</p>
        </div>
        ${shown ? '' : `<div class="self-grade">
          <button type="button" data-i="0" class="grade-ok"><strong>1</strong>覚えていた</button>
          <button type="button" data-i="1" class="grade-ng"><strong>2</strong>忘れていた</button>
        </div>`}`)
    : pack.a.map((a, i) => {
      const cls = shown ? (i === pack.correct ? 'correct' : (i === shown.picked && !shown.ok ? 'wrong' : '')) : '';
      return `<button type="button" data-i="${i}" ${shown ? 'disabled' : ''} class="${cls}"><strong>${i + 1}</strong>${esc(a)}</button>`;
    }).join('');

  let feedback = '';
  if (shown) {
    const extra = shown.ok && session.combo >= 3 ? `<em class="pop">${comboLabel(session.combo)}</em>` : '';
    const scoreLine = shown.prevScore === shown.newScore
      ? `予測 ${shown.newScore}点`
      : `予測 ${shown.prevScore}点 → <b>${shown.newScore}点</b>`;
    const nextLabel = shown.ok
      ? (remain ? `次の問題（残り${remain}問）` : '課題は達成。続けて解く')
      : 'もう一度解く';
    feedback = `
      <div class="feedback ${shown.ok ? 'good' : 'bad'}">
        <div class="fb-top">
          <b>${isCard ? (shown.ok ? '覚えていた' : '忘れていた') : (shown.ok ? '正解' : '不正解')} · +${shown.gain} XP${overtime() && shown.ok ? '（2倍）' : ''}</b>
          ${extra}
        </div>
        ${isCard ? '' : `<p>${esc(q.why)}</p>`}
        <p class="next-due">${intervalCopy(cardOf(q.id), shown.ok)}</p>
        <p class="score-delta">${scoreLine}</p>
        <button type="button" class="primary fat" id="next-q">${nextLabel}</button>
      </div>`;
  }

  return `${header('/play')}
    <main class="quiz-wrap ${shown && !shown.ok ? 'shake' : ''}">
      ${dueChip()}
      <div class="battle-top">
        <p class="eyebrow">${overtime() ? '経験値2倍 · ' : ''}${kind} · ${esc(q.area)} / ${esc(q.tag)}</p>
        <div class="heat"><s style="width:${heat}%"></s></div>
        <div class="meta-row">
          <span id="battle-today">今日 ${state.daily.answered}/${target}</span>
          <span class="combo-big ${session.combo >= 3 ? 'hot' : ''}" id="battle-combo">連続 ${session.combo}</span>
          ${ret !== null ? `<span>定着 ${ret}%</span>` : '<span>初見</span>'}
        </div>
      </div>
      <h1>${esc(q.q)}</h1>
      <div id="answers" class="${isCard ? 'card-wrap' : 'answers'}">${answers}</div>
      <div id="feedback">${feedback}</div>
      <p class="hint">${isCard
        ? '答えを思い浮かべてから開きます。Enterで答えを表示、1で覚えていた、2で忘れていた。'
        : 'キーボードの1〜4でも選べます。Enterで次へ進みます。'}</p>
    </main>`;
}

function intervalCopy(card, ok) {
  if (!ok) return 'ほかの問題を3問はさんで、もう一度出します。10分後にも出ます。';
  if (!card) return '記録しました。';
  if (card.stability <= MIN10) return '10分後にもう一度出します。忘れやすい時間帯です。';
  if (card.stability <= DAY) return '明日もう一度出します。';
  const days = Math.round(card.stability / DAY);
  return `${days}日後に再出題します。間隔を空けています。`;
}

function answer(i) {
  const q = currentQuestion();
  if (!q || session.showing) return;
  if (q.ans) {
    if (session.revealed !== q.id || i > 1) return;
    grade(q, i === 0, { picked: i });
    return;
  }
  const pack = deal(q);
  grade(q, i === pack.correct, { ...pack, picked: i });
}

function grade(q, ok, pack) {
  session.currentId = q.id;
  session.advanceAt = Date.now() + 700;
  const wasNew = !cardOf(q.id);
  const kind = session.retryId === q.id ? 'やり直し' : wasNew ? '新しい問題' : '復習';
  const prevScore = predictedScore();
  session.lastId = q.id;
  session.revisit = (session.revisit || []).filter(id => id !== q.id);
  session.queue = (session.queue || []).filter(id => id !== q.id);
  if (ok) {
    session.combo += 1;
  } else {
    session.combo = 0;
    session.revisit.push(q.id);
    if (!(session.untilRevisit > 0)) session.untilRevisit = 3;
  }
  const gain = xpFor(ok);
  session.xp += gain;
  session.answered += 1;
  state.xp += gain;
  state.bestCombo = Math.max(state.bestCombo, session.combo);
  bumpStreak();
  ensureDaily();
  state.daily.answered += 1;
  state.daily.xp += gain;
  state.daily.comboMax = Math.max(state.daily.comboMax, session.combo);
  if (wasNew) state.daily.newCount += 1;
  else state.daily.reviewDone += 1;
  schedule(q.id, ok);
  updateMissions();
  state.log[localDate()] = (state.log[localDate()] || 0) + 1;
  const newScore = predictedScore();
  session.showing = {
    ...pack,
    id: q.id,
    ok,
    gain,
    prevScore,
    newScore,
    kind,
    wasNew
  };
  save();
  beep(ok, session.combo);
  vibrate(ok);
  burst(ok);
  if (ok && [3, 5, 8, 12].includes(session.combo)) toast(`連続 ${session.combo}`);
  else if (!ok) toast('連続が途切れました');
  mount();
}

function goNext(fromClick) {
  if (fromClick && Date.now() < session.advanceAt) return;
  session.showing = null;
  session.deal = null;
  session.revealed = null;
  session.currentId = null;
  if ((location.hash.split('?')[0] || '') !== '#/play') {
    location.hash = '#/play';
    return;
  }
  if (location.hash.includes('?')) {
    location.hash = '#/play';
    return;
  }
  mount();
}

function bindQuiz() {
  if (session.showing) {
    const next = document.getElementById('next-q');
    if (next) next.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      goNext(true);
    };
    window.__pick = null;
    window.__reveal = null;
    return;
  }
  const reveal = document.getElementById('reveal-q');
  if (reveal) {
    window.__reveal = () => {
      const q = currentQuestion();
      if (!q) return;
      session.revealed = q.id;
      mount();
    };
    reveal.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.__reveal();
    };
    window.__pick = null;
    return;
  }
  window.__reveal = null;
  document.querySelectorAll('#answers button[data-i]').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      answer(+btn.dataset.i);
    };
  });
  window.__pick = answer;
}

function onKey(e) {
  if ((location.hash.slice(1) || '/').split('?')[0] !== '/play') return;
  if (e.key === 'Enter' && document.getElementById('next-q')) {
    e.preventDefault();
    goNext();
    return;
  }
  if ((e.key === 'Enter' || e.key === ' ') && window.__reveal) {
    e.preventDefault();
    window.__reveal();
    return;
  }
  const map = { '1': 0, '2': 1, '3': 2, '4': 3, a: 0, b: 1, c: 2, d: 3, A: 0, B: 1, C: 2, D: 3 };
  if (map[e.key] !== undefined && window.__pick) window.__pick(map[e.key]);
}

function memory() {
  const due = dueCards();
  const soon = decayingSoon();
  const learned = QUESTIONS.filter(q => cardOf(q.id));
  const avg = learned.length
    ? Math.round(learned.reduce((s, q) => s + retentionOf(cardOf(q.id)), 0) / learned.length * 100)
    : 0;
  const row = (q, label) => {
    const c = cardOf(q.id);
    const r = Math.round(retentionOf(c) * 100);
    const wait = fmtRemain((c.due || 0) - Date.now());
    return `<a href="#/play?id=${q.id}" class="review-item">
      <span>${esc(q.area)}</span>
      <b>${esc(q.tag)}</b>
      <em class="ret ${r < 70 ? 'low' : ''}">${r}%</em>
      <i>${label} ${wait === '今' ? '' : wait}</i>
    </a>`;
  };
  return `${header('/memory')}
    <main>
      ${dueChip()}
      <section class="page-title">
        <p class="eyebrow">定着 ${avg}% · 学習済み ${learned.length}/${QUESTIONS.length}</p>
        <h1>復習</h1>
        <p>忘れてからではなく、忘れかける前に出します。間違えた問題は、ほかの問題を3問はさんだあとと、10分後に出ます。</p>
      </section>
      ${due.length ? `<h3 class="list-h">今やる · ${due.length}</h3><div class="review-list">${due.map(q => row(q, '復習する')).join('')}</div>` : ''}
      ${soon.length ? `<h3 class="list-h">まもなく · ${soon.length}</h3><div class="review-list">${soon.map(q => row(q, '先にやる')).join('')}</div>` : ''}
      ${!due.length && !soon.length ? `<div class="empty"><h2>今の復習はありません</h2><p>新しい問題を解くと、10分後に復習が出ます。</p><a class="primary" href="#/play">問題を解く</a></div>` : ''}
    </main>`;
}

function plan() {
  const left = daysLeft();
  const phase = currentPhase();
  const start = new Date();
  const days = [];
  for (let i = 0; i < Math.min(28, left + 1); i += 1) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    days.push({ date: localDate(d), count: state.log[localDate(d)] || 0 });
  }
  return `${header('/plan')}
    <main>
      <section class="page-title">
        <p class="eyebrow">配点 × 残り${left}日 × 復習</p>
        <h1>学習計画</h1>
        <p>権利関係に時間をかけすぎない。宅建業法の20点を土台にして、法令と税を積み、権利関係は頻出だけにする。目標は ${EXAM.passLine}/50 点。</p>
      </section>
      <div class="plan">
        ${PHASES.map(p => `<article class="week ${p.id === phase.id ? 'current' : ''}">
          <div>
            <span>${p.untilDay === 0 ? '直前' : `残り${p.untilDay}日〜`}</span>
            <h2>${esc(p.title)}</h2>
            <p>${esc(p.hint)}</p>
          </div>
          <b>${p.id === phase.id ? 'いまここ' : ''}</b>
        </article>`).join('')}
      </div>
      <div class="cal">
        ${days.slice(0, 14).map(d => `<div class="cal-d ${d.date === localDate() ? 'today' : ''}"><b>${d.date.slice(5)}</b><span>${d.count || '·'}</span></div>`).join('')}
      </div>
      <aside class="notice">
        <b>試験メモ</b>
        <p>${EXAM.date} ${EXAM.start}–${EXAM.end} · 50問の四肢択一 · 法令は ${EXAM.lawDate} 施行分が基準です。試験前に公式と最新法令で確認してください。</p>
        <a href="https://www.retio.or.jp/exam/exam_detail/" target="_blank" rel="noreferrer">試験の公式概要</a>
      </aside>
    </main>`;
}

function bindGlobal() {
  document.querySelectorAll('[data-sound]').forEach(btn => {
    btn.onclick = () => {
      state.settings.sound = !state.settings.sound;
      save();
      mount();
    };
  });
}

function statCanon(value) {
  let text = String(value ?? '')
    .normalize('NFKC')
    .replace(/[,\s]/g, '')
    .replace(/約/g, '')
    .replace(/[％%]/g, '')
    .replace(/[ので]/g, '');
  let previous;
  do {
    previous = text;
    text = text.replace(/(兆|億|万|円)$/g, '');
  } while (text !== previous);
  return text;
}

function statMatch(field, raw) {
  const got = statCanon(raw);
  if (!got) return false;
  return field.accept.some(answer => statCanon(answer) === got);
}

function statBlanks(group) {
  return group.sentences.flatMap(sentence => sentence.parts.filter(part => part && part.id));
}

const STAT_GROUPS = [
  {
    id: 'build',
    title: '建築着工統計（令和8年1月公表）',
    sentences: [
      { parts: ['令和7年の新設住宅着工戸数は約', { id: 'b1', accept: ['74'], show: '74' }, '万戸であり、前年比では', { id: 'b2', accept: ['6.5'], show: '6.5' }, '％減となり、', { id: 'b3', accept: ['3'], show: '3' }, '年連続の減少。'] },
      { parts: ['令和7年の新設住宅着工床面積は', { id: 'b4', accept: ['56885'], show: '56,885' }, '千㎡であり、前年比では', { id: 'b5', accept: ['6.6'], show: '6.6' }, '％減となり、', { id: 'b6', accept: ['4'], show: '4' }, '年連続の減少。'] }
    ]
  },
  {
    id: 'price',
    title: '地価公示（令和8年3月公表）',
    sentences: [
      { parts: ['全国平均では、全用途平均・住宅地・商業地のいずれも', { id: 'p1', accept: ['5'], show: '5' }, '年連続で上昇し、全用途平均・商業地は上昇幅が拡大したが、住宅地は前年と同じ上昇幅となった。'] },
      { parts: ['三大都市圏平均では、全用途平均・住宅地・商業地のいずれも', { id: 'p2', accept: ['5'], show: '5' }, '年連続で上昇し、上昇率が拡大した。東京圏、大阪圏では全用途平均・住宅地・商業地のいずれも上昇幅が拡大した。名古屋圏ではいずれも上昇幅が縮小した。'] },
      { parts: ['地方圏平均では、全用途平均・住宅地・商業地のいずれも', { id: 'p3', accept: ['5'], show: '5' }, '年連続で上昇し、全用途平均・住宅地は上昇幅が縮小したが、商業地は前年と同じ上昇幅となった。地方四市（札幌市・仙台市・広島市・福岡市）では全用途平均・住宅地・商業地のいずれも上昇幅が縮小した。その他の地域では全用途平均・住宅地は前年と同じ上昇幅となったが、商業地は上昇幅が拡大した。'] }
    ]
  },
  {
    id: 'land',
    title: '土地白書',
    sentences: [
      { parts: ['令和7年における土地の売買による所有権の移転登記の件数は、法務省「登記統計月報」によると、全国では約', { id: 'l1', accept: ['130'], show: '130' }, '万件であり、ほぼ横ばいで推移している。'] },
      { parts: ['令和5年における住宅地、工業用地等の宅地は、全国で約', { id: 'l3', accept: ['199'], show: '199' }, '万ヘクタールある。国土面積に占める割合は森林（約2,501万ha）が最も多く、次いで農地（約430万ha）、宅地、道路（約141万ha）、水面・河川・水路（約135万ha）、原野（約30万ha）の順で多くなっている。'] }
    ]
  },
  {
    id: 'corp',
    title: '法人企業統計（令和6年度）',
    sentences: [
      { parts: ['令和6年度における不動産業の売上高は約', { id: 'c1', accept: ['58'], show: '58' }, '兆', { id: 'c1b', accept: ['8000'], show: '8,000' }, '億円と対前年度比で', { id: 'c2', accept: ['4.2'], show: '4.2' }, '％増加し、', { id: 'c3', accept: ['2'], show: '2' }, '年連続で増加した。全産業の売上高の約', { id: 'c4', accept: ['3.5'], show: '3.5' }, '％を占めている。'] },
      { parts: ['令和6年度における不動産業の経常利益は約', { id: 'c5', accept: ['7.9'], show: '7.9' }, '兆円と対前年度比で', { id: 'c6', accept: ['8.7'], show: '8.7' }, '％増加し、', { id: 'c7', accept: ['2'], show: '2' }, '年連続で増加した。'] }
    ]
  },
  {
    id: 'gyosha',
    title: '宅建業者数（令和7年3月末）',
    sentences: [
      { parts: ['令和7年3月末における宅地建物取引業者の全事業者数は', { id: 'g1', accept: ['132291'], show: '132,291' }, '業者であり、前年3月時点に比べ1.3％増加している（', { id: 'g2', accept: ['11'], show: '11' }, '年連続で増加）。'] }
    ]
  }
];

const STAT_EXAM = [
  {
    q: '令和7年の新設住宅着工について、正しいものはどれですか。',
    choices: [
      '着工戸数は約74万戸で、3年ぶりの増加です。',
      '着工戸数は約74万戸で、前年比6.5%減、3年連続の減少です。',
      '着工床面積は増加に転じました。',
      '持家、貸家、分譲住宅のうち、貸家だけが増加しました。'
    ],
    correct: 1,
    why: '戸数は740,667戸で6.5%減、3年連続の減少です。床面積は6.6%減で4年連続の減少です。持家、貸家、分譲住宅はいずれも減少しています。'
  },
  {
    q: '令和8年地価公示の全国平均について、正しいものはどれですか。',
    choices: [
      '住宅地と商業地は5年連続で下落しました。',
      '工業地は5年連続の上昇です。',
      '住宅地と商業地は5年連続で上昇し、工業地は10年連続で上昇しました。',
      '三大都市圏は下落に転じました。'
    ],
    correct: 2,
    why: '全国は全用途・住宅地・商業地が5年連続の上昇です。工業地は10年連続です。5年連続とする肢が引っかけです。三大都市圏も上昇が続いています。'
  },
  {
    q: '土地の売買による所有権移転登記の件数について、正しいものはどれですか。',
    choices: [
      '令和7年は約130万件で、5年連続の増加です。',
      '令和7年は約130万件で、ほぼ横ばいです。',
      '令和7年は約200万件で、大幅に減少しました。',
      '令和7年は約90万件で、3年連続の減少です。'
    ],
    correct: 1,
    why: '約130万件で、ほぼ横ばいです。増えた、減った、とする肢は誤りです。約199万ヘクタールは宅地面積であって、取引件数ではありません。'
  },
  {
    q: '令和6年度の不動産業の法人企業統計について、正しいものはどれですか。',
    choices: [
      '営業利益は約7.1兆円で、前年度を下回りました。',
      '営業利益は約8兆円を超えましたが、前年度を下回りました。',
      '営業利益は約7.1兆円で、前年度比12.9%増、2年連続の増加です。',
      '売上高は前年度より減少しました。'
    ],
    correct: 2,
    why: '営業利益は約7.1兆円で12.9%増、経常利益は約7.9兆円で8.7%増です。どちらも2年連続の増加です。売上高も4.2%増です。'
  },
  {
    q: '地価の上昇幅について、正しいものはどれですか。',
    choices: [
      '全国の住宅地は、上昇幅が拡大しました。',
      '全国の住宅地は前年と同じ上昇幅で、商業地は上昇幅が拡大しました。',
      '名古屋圏は、上昇幅が拡大しました。',
      '地方四市（札幌、仙台、広島、福岡）は、上昇幅が拡大しました。'
    ],
    correct: 1,
    why: '全国は、全用途と商業地が拡大、住宅地は前年と同じです。名古屋圏と地方四市は縮小です。東京圏と大阪圏は拡大です。'
  },
  {
    q: '令和7年3月末の宅建業者数について、正しいものはどれですか。',
    choices: [
      '約13.2万業者で、11年連続の減少です。',
      '132,291業者で、前年比1.3%増、11年連続の増加です。',
      '宅建士の総登録者数は約50万人です。',
      '業者数は前年3月末より減りました。'
    ],
    correct: 1,
    why: '132,291業者、1.3%増、11年連続の増加です。宅建士の総登録者数は約121万人です。'
  }
];

function statSentence(sentence) {
  return `<p class="stat-sentence">${sentence.parts.map(part => {
    if (typeof part === 'string') return part;
    const width = Math.max(4, part.show.length + 1);
    return `<input data-stat="${part.id}" autocomplete="off" style="width:${width}em"/>`;
  }).join('')}</p>`;
}

function statsPage() {
  const groups = STAT_GROUPS.map(group => `
    <section class="panel stat-group">
      <h2>${group.title}</h2>
      ${group.sentences.map(statSentence).join('')}
      <button type="button" class="primary" data-stat-grade="${group.id}">この節を採点する</button>
      <p class="stat-score" data-score="${group.id}"></p>
    </section>
  `).join('');
  const exam = STAT_EXAM.map((item, index) => `
    <fieldset class="stat-exam">
      <legend>${index + 1}. ${item.q}</legend>
      ${item.choices.map((choice, choiceIndex) => `
        <label><input type="radio" name="exam-${index}" value="${choiceIndex}"/> ${choiceIndex + 1}. ${choice}</label>
      `).join('')}
      <p class="stat-why" data-why="${index}"></p>
    </fieldset>
  `).join('');
  return `${header('/stats')}
    <main class="stat-main">
      <h1>統計の暗記</h1>
      <p>需給統計の文です。空欄に数字を入れて、節ごとに採点します。間違えた欄にだけ正解を出します。</p>
      ${groups}
      <details class="panel">
        <summary>本番と同じ四択を解く</summary>
        <p>4つのうち、正しいものは1つです。</p>
        ${exam}
        <button type="button" class="primary" id="stat-exam-grade">四択を採点する</button>
        <p class="stat-score" id="stat-exam-score"></p>
      </details>
    </main>`;
}

function bindStats() {
  document.querySelectorAll('[data-stat-grade]').forEach(button => {
    button.onclick = () => {
      const group = STAT_GROUPS.find(item => item.id === button.dataset.statGrade);
      const fields = statBlanks(group);
      let ok = 0;
      fields.forEach(field => {
        const input = document.querySelector(`[data-stat="${field.id}"]`);
        const good = statMatch(field, input.value);
        input.classList.toggle('stat-good', good);
        input.classList.toggle('stat-bad', !good);
        if (!good || statCanon(input.value) === statCanon(field.show) && input.value !== field.show) input.value = field.show;
        if (good) ok += 1;
      });
      document.querySelector(`[data-score="${group.id}"]`).textContent = `${ok} / ${fields.length} です。`;
    };
  });
  const examButton = document.getElementById('stat-exam-grade');
  if (!examButton) return;
  examButton.onclick = () => {
    let ok = 0;
    STAT_EXAM.forEach((item, index) => {
      const picked = document.querySelector(`input[name="exam-${index}"]:checked`);
      const why = document.querySelector(`[data-why="${index}"]`);
      const good = picked && Number(picked.value) === item.correct;
      if (good) ok += 1;
      why.textContent = good
        ? '合っています。'
        : `正解は${item.correct + 1}です。${item.why}`;
    });
    document.getElementById('stat-exam-score').textContent = `${ok} / ${STAT_EXAM.length} です。`;
  };
}

function guide() {
  const html = window.TAKKEN_GUIDE || '';
  if (!html) {
    return `${header('/guide')}<main class="wrap"><p>論点を読み込めませんでした。</p></main>`;
  }
  if (guide._url) URL.revokeObjectURL(guide._url);
  guide._url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  return `${header('/guide')}<iframe class="guide-frame" src="${guide._url}" title="論点整理"></iframe>`;
}

function tick() {
  const hook = nextDueMs();
  const due = dueCards().length;
  const label = hook === null ? '' : due ? `今の復習 ${due}問` : `次の復習まで ${fmtRemain(hook)}`;
  document.querySelectorAll('#due-chip').forEach(el => {
    if (!label) return;
    el.textContent = label;
    el.classList.toggle('hot', due > 0 || (hook !== null && hook <= 0));
    el.classList.toggle('soon', !due && hook !== null && hook > 0 && hook <= MIN10);
  });
  const time = document.getElementById('hook-time');
  if (time && hook !== null) {
    time.textContent = hook <= 0 ? '今が復習のタイミングです' : `次の復習まで ${fmtRemain(hook)}`;
  }
  if (due > 0 && !tick._pinged) {
    tick._pinged = true;
    toast('復習の時間です');
  }
  if (!due) tick._pinged = false;
}

function mount() {
  ensureDaily();
  const path = (location.hash.slice(1) || '/').split('?')[0];
  document.querySelector('#app').innerHTML = path === '/' ? dashboard()
    : path === '/play' ? play()
    : path === '/memory' ? memory()
    : path === '/guide' ? guide()
    : path === '/stats' ? statsPage()
    : plan();
  if (path === '/play' && currentQuestion()) bindQuiz();
  if (path === '/stats') bindStats();
  bindGlobal();
}

window.addEventListener('hashchange', () => {
  if (session.showing && !(location.hash.slice(1) || '/').startsWith('/play')) session.showing = null;
  mount();
});
window.addEventListener('keydown', onKey);
window.mount = mount;
mount();
setInterval(tick, 1000);
save();
