'use strict';
/* =====================================================================
   Estável — app.js
   Estabiliza texto e vídeo usando o acelerômetro: o conteúdo é movido
   para o lado OPOSTO ao balanço do celular, então parece parado para
   os seus olhos.

   Fluxo do sinal (resumo):
     sensor (m/s²) → eixos da tela → tira a referência (calibrar)
       → FILTRO PASSA-ALTA (só tremida rápida passa)
       → ZONA MORTA (corta ruído do sensor)
       → MOLA + AMORTECEDOR (vira deslocamento, sempre voltando ao centro)
       → LIMITE suave (nunca passa da folga)
       → transform: translate3d() no #stage
   ===================================================================== */

const $ = (sel) => document.querySelector(sel);

/* ---------- armazenamento (localStorage pode falhar: modo privado, cota cheia) ---------- */
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('estavel.' + key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('estavel.' + key, JSON.stringify(value)); return true; }
    catch { return false; }
  },
};

/* =====================================================================
   CONFIGURAÇÕES (os sliders da tela de Ajustes)
   ===================================================================== */
const DEFAULTS = Object.freeze({
  intensity: 1.0,  // multiplicador da compensação
  spring: 30,      // k: força da mola (1/s²)
  damping: 0.8,    // ζ: amortecimento (0,7–1,0 = volta sem quicar)
  cutoff: 1.0,     // Hz: abaixo disso o movimento é ignorado
  deadzone: 0.04,  // m/s²: ruído ignorado
  gyro: 0,         // ganho do giroscópio (0 = desligado)
  margin: 40,      // px de folga em cada lado da moldura
  invert: false,   // inverte o sentido da compensação
});

const SLIDERS = [
  { key: 'intensity', label: 'Intensidade', min: 0, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) + '×',
    help: 'Quanto o conteúdo anda para compensar. Efeito fraco → aumente.' },
  { key: 'spring', label: 'Força da mola', min: 2, max: 150, step: 1, fmt: (v) => v.toFixed(0),
    help: 'Puxa o conteúdo de volta ao centro. Alto = volta rápido, mas compensa menos.' },
  { key: 'damping', label: 'Amortecimento', min: 0.1, max: 2, step: 0.05, fmt: (v) => v.toFixed(2),
    help: 'Freio da mola. Baixo = "elástico", quica. 0,7–1,0 = volta sem quicar.' },
  { key: 'cutoff', label: 'Frequência de corte', min: 0.1, max: 5, step: 0.1, fmt: (v) => v.toFixed(1) + ' Hz',
    help: 'Movimentos mais lentos que isso são ignorados (curvas, freadas, seu braço).' },
  { key: 'deadzone', label: 'Zona morta', min: 0, max: 0.5, step: 0.01, fmt: (v) => v.toFixed(2) + ' m/s²',
    help: 'Ignora o ruído do sensor. Se o texto "flutua" parado, aumente um pouco.' },
  { key: 'gyro', label: 'Giroscópio (experimental)', min: -2, max: 2, step: 0.1, fmt: (v) => v.toFixed(1),
    help: 'Compensa também a inclinação. 0 = desligado; negativo inverte o sentido.' },
  { key: 'margin', label: 'Folga da moldura', min: 10, max: 80, step: 2, fmt: (v) => v.toFixed(0) + ' px',
    help: 'Quanto o conteúdo pode andar no máximo (e o tamanho da borda).' },
];

let cfg = { ...DEFAULTS, ...store.get('cfg', {}) };
let saveTimer = 0;
function saveCfgSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(() => store.set('cfg', cfg), 300); }
function applyCfg() { document.documentElement.style.setProperty('--margin', cfg.margin + 'px'); }

/* =====================================================================
   PROCESSAMENTO DO SINAL
   ===================================================================== */

// Conversão metro → pixel CSS. Celulares têm ~150–160 px CSS por polegada,
// o que dá ~6000 px por metro. Se o conteúdo andar 1 mm, movemos ~6 px.
const PX_PER_METER = 6000;
// Giroscópio: girar o pulso desloca a tela uns ~15 cm × ângulo → 0,15 m × 6000.
const GYRO_PX_PER_RAD = 900;
const DEG = Math.PI / 180;

const sig = {
  prev: { x: 0, y: 0 },  // amostra anterior (entrada do passa-alta)
  hp:   { x: 0, y: 0 },  // saída do passa-alta: só a parte rápida da aceleração
  bias: { x: 0, y: 0 },  // referência "parado", definida no Calibrar
  tilt: { x: 0, y: 0 },  // inclinação acumulada (rad), vinda do giroscópio
  raw:  { x: 0, y: 0 },  // última leitura nos eixos da tela (para o medidor)
  prime: true,           // true = a próxima amostra só "arma" o filtro (evita pulo)
  lastT: 0,
  count: 0,
  rateHz: 0,
  calib: null,           // acumulador durante a calibração
};

// Estado físico do conteúdo (em px e px/s), relativo ao centro da moldura.
const phys = { x: 0, y: 0, vx: 0, vy: 0 };

let enabled = store.get('enabled', true);
let sensorState = 'idle'; // idle | waiting | on | none | denied | off

/* Ângulo atual da tela (0, 90, 180, 270/-90) para girar os eixos do sensor. */
function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  return typeof window.orientation === 'number' ? window.orientation : 0;
}

/* O sensor mede nos eixos do APARELHO (x = direita, y = topo em retrato).
   Aqui convertemos para os eixos da TELA como você a vê (x = direita, y = para BAIXO),
   para funcionar em retrato e paisagem. */
function toScreen(dx, dy) {
  const a = screenAngle() * DEG, c = Math.cos(a), s = Math.sin(a);
  return { x: dx * c - dy * s, y: -(dx * s + dy * c) };
}

/* Zona morta "suave": valores pequenos viram 0 e o resto é deslocado,
   assim não há degrau quando o sinal cruza o limite. */
function deadzone(v) {
  const d = cfg.deadzone;
  return Math.abs(v) <= d ? 0 : v - Math.sign(v) * d;
}

/* Chamado a cada leitura do sensor (~60 vezes/s). */
function onMotion(e) {
  // Preferimos "acceleration" (já sem gravidade). Alguns aparelhos só dão
  // "accelerationIncludingGravity" — tudo bem, o passa-alta remove a gravidade
  // porque ela é praticamente constante (frequência ~0).
  const a = (e.acceleration && e.acceleration.x != null) ? e.acceleration : e.accelerationIncludingGravity;
  if (!a || a.x == null) return;

  if (sensorState === 'waiting') setSensor('on');

  // dt = tempo desde a última amostra, em segundos (limitado para não explodir).
  const now = performance.now();
  let dt = sig.lastT ? (now - sig.lastT) / 1000 : 1 / 60;
  sig.lastT = now;
  dt = Math.min(Math.max(dt, 0.004), 0.1);
  sig.count++;
  sig.rateHz += (1 / dt - sig.rateHz) * 0.05;

  const s = toScreen(a.x || 0, a.y || 0);
  sig.raw = s;
  if (sig.calib) { sig.calib.x += s.x; sig.calib.y += s.y; sig.calib.n++; }

  // Tira a referência de "parado" (definida ao calibrar).
  const x = s.x - sig.bias.x;
  const y = s.y - sig.bias.y;

  // Primeira amostra (ou após girar a tela/calibrar): só arma o filtro.
  // Sem isso, a diferença entre 0 e a leitura atual viraria um "tranco".
  if (sig.prime) {
    sig.prev.x = x; sig.prev.y = y;
    sig.hp.x = 0; sig.hp.y = 0;
    sig.prime = false;
    return;
  }

  /* ---------------- FILTRO PASSA-ALTA (1ª ordem) ----------------
     Ideia: só deixa passar MUDANÇAS rápidas. Movimento lento ou constante
     (gravidade, curva longa, freada, você abaixando o braço) é "esquecido".

       saída = α · (saída_anterior + entrada − entrada_anterior)

     • (entrada − entrada_anterior) = quanto o sinal mudou agora.
     • α (entre 0 e 1) diz quanto a saída "lembra" do passado.
       Se o sinal parar de mudar, a saída decai para zero.
     • α vem da frequência de corte fc:  RC = 1 / (2π·fc),  α = RC / (RC + dt)
       fc maior → α menor → esquece mais rápido → só tremida bem rápida passa.
       fc menor → mais movimento passa (inclusive balanço lento) → mais drift. */
  const rc = 1 / (2 * Math.PI * cfg.cutoff);
  const alpha = rc / (rc + dt);
  sig.hp.x = alpha * (sig.hp.x + x - sig.prev.x);
  sig.hp.y = alpha * (sig.hp.y + y - sig.prev.y);
  sig.prev.x = x; sig.prev.y = y;

  /* ---------------- GIROSCÓPIO (opcional) ----------------
     rotationRate vem em graus/s. Integramos para ter o ângulo de inclinação,
     mas com "vazamento" (leak): a cada amostra o ângulo encolhe um pouco.
     Isso é um passa-alta de novo — inclinações lentas e duradouras somem
     sozinhas e o ângulo não fica acumulando erro (drift). */
  const r = e.rotationRate;
  const leak = Math.exp(-2 * Math.PI * cfg.cutoff * dt);
  if (cfg.gyro !== 0 && r && r.beta != null) {
    // girar em torno do eixo Y (gamma) desloca na horizontal; do eixo X (beta), na vertical
    const g = toScreen(r.gamma || 0, r.beta || 0);
    sig.tilt.x = (sig.tilt.x + g.x * DEG * dt) * leak;
    sig.tilt.y = (sig.tilt.y + g.y * DEG * dt) * leak;
  } else {
    sig.tilt.x *= leak; sig.tilt.y *= leak;
  }
}

/* =====================================================================
   ANIMAÇÃO (requestAnimationFrame, sincronizado com a tela)
   ===================================================================== */
const stage = $('#stage');
let lastFrame = 0;
let shownX = NaN, shownY = NaN;
let meterTick = 0;

function frame(now) {
  // dt da animação em segundos (limitado: se a aba ficou parada, não dá salto).
  const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.05) : 1 / 60;
  lastFrame = now;

  if (enabled && sensorState === 'on') {
    /* ---------------- MOLA + AMORTECEDOR ----------------
       Pense no conteúdo preso ao centro da moldura por uma mola,
       mergulhado em "mel" (amortecedor). A cada frame somamos 3 forças:

       1) Compensação:  −aceleração_do_celular × ganho
          Se o celular acelera para a direita, empurramos o conteúdo
          para a esquerda na mesma medida → para os olhos, ele fica parado.
       2) Mola:  −k · posição
          Quanto mais longe do centro, mais forte puxa de volta.
          É isso que impede o drift: nada fica "perdido" num canto.
       3) Amortecedor:  −c · velocidade
          Freia o movimento para não ficar quicando.
          c = 2·ζ·√k  → com ζ = 1 ("amortecimento crítico") a volta é a
          mais rápida possível sem passar do centro. ζ < 1 quica um pouco;
          ζ > 1 volta devagar, "mole".

       Frequência natural da mola ≈ √k / (2π) Hz. Com k = 30 → ~0,9 Hz:
       movimentos mais rápidos que isso são compensados; mais lentos, a mola
       vence e o conteúdo acompanha o celular (que é o que você quer em curvas). */
    const k = cfg.spring;
    const c = 2 * cfg.damping * Math.sqrt(k);
    const gain = cfg.intensity * PX_PER_METER * (cfg.invert ? -1 : 1);

    const ax = -deadzone(sig.hp.x) * gain - k * phys.x - c * phys.vx; // px/s²
    const ay = -deadzone(sig.hp.y) * gain - k * phys.y - c * phys.vy;

    // Integração "Euler semi-implícita": atualiza a velocidade primeiro e
    // usa a velocidade NOVA para a posição. É simples e bem mais estável
    // que a versão ingênua para molas.
    phys.vx += ax * dt; phys.vy += ay * dt;
    phys.x += phys.vx * dt; phys.y += phys.vy * dt;

    // Trava de segurança no estado físico (evita acumular valores absurdos).
    const lim = cfg.margin * 2;
    if (Math.abs(phys.x) > lim) { phys.x = Math.sign(phys.x) * lim; phys.vx = 0; }
    if (Math.abs(phys.y) > lim) { phys.y = Math.sign(phys.y) * lim; phys.vy = 0; }
  } else {
    // Desligado: desliza suavemente de volta ao centro.
    phys.x *= 0.85; phys.y *= 0.85; phys.vx = 0; phys.vy = 0;
  }

  // Giroscópio: o conteúdo vai contra a inclinação acumulada.
  const gk = (enabled && sensorState === 'on') ? cfg.gyro * GYRO_PX_PER_RAD : 0;
  let tx = phys.x - sig.tilt.x * gk;
  let ty = phys.y - sig.tilt.y * gk;

  /* ---------------- LIMITE (clamp) SUAVE ----------------
     m · tanh(v / m): para valores pequenos é quase igual a v (não muda nada);
     perto da borda "freia" e NUNCA passa de m. Sem batida seca na borda. */
  const m = cfg.margin;
  tx = m * Math.tanh(tx / m);
  ty = m * Math.tanh(ty / m);

  // Só mexe no DOM se mudou o bastante (economiza bateria).
  if (Math.abs(tx - shownX) > 0.05 || Math.abs(ty - shownY) > 0.05 || Number.isNaN(shownX)) {
    stage.style.transform = `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0)`;
    shownX = tx; shownY = ty;
  }

  // Medidor ao vivo na tela de Ajustes (atualiza ~10x/s).
  if (dlgSettings.open && now - meterTick > 100) {
    meterTick = now;
    const mag = Math.hypot(sig.hp.x, sig.hp.y);
    $('#meterText').textContent = sensorState === 'on'
      ? `Tremida: ${mag.toFixed(2)} m/s² · ${Math.round(sig.rateHz)} leituras/s · desloc.: ${tx.toFixed(0)}, ${ty.toFixed(0)} px`
      : 'Sensores inativos.';
    $('#meterDot').style.transform = `translate(${(tx / m) * 27}px, ${(ty / m) * 27}px)`;
  }

  requestAnimationFrame(frame);
}

/* Zera filtros e posição (usado no Calibrar e ao girar a tela). */
function resetMotion() {
  sig.prime = true;
  sig.hp.x = sig.hp.y = 0;
  sig.tilt.x = sig.tilt.y = 0;
  phys.x = phys.y = phys.vx = phys.vy = 0;
}

/* =====================================================================
   SENSORES E PERMISSÕES
   ===================================================================== */
const needsPermission = typeof DeviceMotionEvent !== 'undefined' &&
  typeof DeviceMotionEvent.requestPermission === 'function'; // iPhone/iPad

async function startSensors() {
  if (typeof DeviceMotionEvent === 'undefined' || !window.isSecureContext) {
    setSensor('none'); return;
  }
  if (needsPermission) {
    // Tem que ser chamado dentro de um toque do usuário (iOS exige).
    try {
      const res = await DeviceMotionEvent.requestPermission();
      if (res !== 'granted') { setSensor('denied'); return; }
    } catch { setSensor('denied'); return; }
  }
  window.addEventListener('devicemotion', onMotion);
  setSensor('waiting');
  // Se em 2 s nenhuma leitura chegou, o aparelho não tem sensor (ex.: PC).
  setTimeout(() => { if (sig.count === 0) setSensor('none'); }, 2000);
}

function setSensor(state) {
  sensorState = state;
  const warn = $('#warn');
  if (state === 'none') {
    $('#warnText').textContent = 'Este aparelho/navegador não fornece sensores de movimento. O app funciona normalmente, só sem estabilização.';
    warn.hidden = false;
  } else if (state === 'denied') {
    $('#warnText').textContent = 'Permissão de movimento negada. O app funciona sem estabilização. Para tentar de novo, feche e reabra o app e toque em "Ativar sensores".';
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
  updateStatus();
}

function updateStatus() {
  const st = $('#status');
  st.className = 'status';
  if (sensorState === 'on' && enabled) { st.textContent = '● estável'; st.classList.add('on'); }
  else if (sensorState === 'none' || sensorState === 'denied') { st.textContent = 'sem sensores'; st.classList.add('bad'); }
  else if (sensorState === 'waiting') st.textContent = 'aguardando sensor…';
  else if (sensorState === 'off') st.textContent = 'sem estabilização';
  else st.textContent = 'desligado';
  $('#btnToggle').classList.toggle('on', enabled);
}

function calibrate() {
  if (sensorState !== 'on') { toast('Sensores não estão ativos.'); return; }
  toast('Segure o celular parado…', 1100);
  sig.calib = { x: 0, y: 0, n: 0 };
  setTimeout(() => {
    const c = sig.calib; sig.calib = null;
    if (c && c.n > 0) { sig.bias.x = c.x / c.n; sig.bias.y = c.y / c.n; }
    resetMotion();
    toast('Calibrado ✓');
  }, 1000);
}

// Girar a tela muda os eixos: re-arma o filtro para não dar tranco.
function onOrientation() { sig.bias.x = sig.bias.y = 0; resetMotion(); }
if (screen.orientation) screen.orientation.addEventListener('change', onOrientation);
window.addEventListener('orientationchange', onOrientation);

/* ---------- manter a tela acesa ---------- */
let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* sem suporte ou bateria fraca: tudo bem */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { keepAwake(); resetMotion(); }
});

/* ---------- tela cheia + travar orientação ---------- */
async function toggleFullscreen() {
  const el = document.documentElement;
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      return;
    }
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) throw new Error('sem suporte');
    await req.call(el, { navigationUI: 'hide' });
    // Só funciona em tela cheia, e nem todo navegador deixa.
    try { await screen.orientation.lock(screen.orientation.type); toast('Tela cheia · orientação travada'); }
    catch { toast('Tela cheia'); }
  } catch {
    toast('Este navegador não permite tela cheia aqui. No iPhone, instale na tela inicial.', 3000);
  }
}

/* =====================================================================
   LEITOR DE TEXTO
   ===================================================================== */
const readerEl = $('#reader');
const contentEl = $('#readerContent');
const THEMES = ['dark', 'black', 'sepia', 'light'];
const SPACINGS = [1.4, 1.6, 1.85, 2.1];

let rprefs = { font: 20, lh: 1.6, theme: 'dark', ...store.get('readerPrefs', {}) };
let doc = store.get('doc', null); // { id, title, blocks: [['p'|'h', texto], ...] }
let positions = store.get('positions', {}); // { idDoDocumento: índiceDoParágrafo }

function applyReaderPrefs() {
  contentEl.style.setProperty('--font', rprefs.font + 'px');
  contentEl.style.setProperty('--lh', rprefs.lh);
  stage.dataset.theme = rprefs.theme;
  store.set('readerPrefs', rprefs);
}

// Muda o estilo mantendo o mesmo parágrafo no topo.
function changeReader(fn) {
  const idx = currentBlockIndex();
  fn();
  applyReaderPrefs();
  scrollToBlock(idx);
}

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function textToBlocks(text) {
  text = text.replace(/\r\n?/g, '\n').trim();
  let parts = text.split(/\n\s*\n+/);                                     // parágrafos separados por linha em branco
  if (parts.length < 3 && text.split('\n').length > 6) parts = text.split('\n'); // ou um por linha
  return parts.map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean).map((t) => ['p', t]);
}

function setDoc(title, blocks) {
  if (!blocks.length) { toast('Não encontrei texto nesse arquivo.'); return; }
  const sample = blocks.slice(0, 40).map((b) => b[1]).join('\n');
  doc = { id: hash(title + '|' + blocks.length + '|' + sample), title, blocks };
  if (!store.set('doc', doc)) toast('Texto grande demais para guardar offline; a leitura funciona agora.', 3500);
  setMode('text');
  renderDoc();
}

function renderDoc() {
  contentEl.textContent = '';
  const frag = document.createDocumentFragment();
  if (!doc) {
    const intro = [
      ['h', 'Bem-vindo ao Estável'],
      ['p', 'Toque em "Abrir" para escolher um .txt ou .epub, ou em "Colar" para colar um texto.'],
      ['p', 'Segure o celular parado e toque em "Calibrar". Depois é só ler: o texto anda para o lado contrário do balanço.'],
      ['p', 'Se o efeito estiver fraco ou "elástico", abra Ajustes ⚙ — o pontinho verde mostra o deslocamento ao vivo.'],
    ];
    for (const [t, s] of intro) {
      const n = document.createElement(t === 'h' ? 'h2' : 'p');
      n.textContent = s; if (t === 'p') n.className = 'hint';
      frag.appendChild(n);
    }
    contentEl.appendChild(frag);
    return;
  }
  for (const [t, s] of doc.blocks) {
    const n = document.createElement(t === 'h' ? 'h2' : 'p');
    n.textContent = s; // textContent: nunca interpreta HTML (seguro)
    frag.appendChild(n);
  }
  contentEl.appendChild(frag);
  requestAnimationFrame(() => scrollToBlock(positions[doc.id] || 0));
}

// Primeiro parágrafo visível (busca binária: rápido mesmo com livro inteiro).
function currentBlockIndex() {
  const kids = contentEl.children;
  const top = readerEl.scrollTop + 4;
  let lo = 0, hi = kids.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = kids[mid];
    if (k.offsetTop + k.offsetHeight > top) { ans = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return ans;
}
function scrollToBlock(i) {
  const k = contentEl.children[i];
  readerEl.scrollTop = k ? Math.max(0, k.offsetTop - 12) : 0;
}

let posTimer = 0;
readerEl.addEventListener('scroll', () => {
  if (!doc) return;
  clearTimeout(posTimer);
  posTimer = setTimeout(() => {
    positions[doc.id] = currentBlockIndex();
    const keys = Object.keys(positions);
    if (keys.length > 30) delete positions[keys[0]]; // guarda só os 30 últimos
    store.set('positions', positions);
  }, 400);
}, { passive: true });

/* Decodifica .txt: tenta UTF-8; se falhar, usa Windows-1252 (comum em .txt brasileiros). */
async function readTxt(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1252').decode(buf); }
}

/* ---------- EPUB simples ----------
   EPUB = arquivo ZIP com páginas XHTML. Lemos o ZIP na mão e descompactamos
   com DecompressionStream (nativo do navegador). Pegamos só o texto. */
async function openZip(buf) {
  const dv = new DataView(buf);
  let eocd = -1; // "End of central directory": fica no fim do arquivo
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP inválido');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = new Map();
  for (let i = 0; i < count && dv.getUint32(p, true) === 0x02014b50; i++) {
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    entries.set(dec.decode(new Uint8Array(buf, p + 46, nlen)), { method, size, off });
    p += 46 + nlen + elen + clen;
  }
  return async (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const start = e.off + 30 + dv.getUint16(e.off + 26, true) + dv.getUint16(e.off + 28, true);
    const data = new Uint8Array(buf, start, e.size);
    if (e.method === 0) return dec.decode(data);
    if (e.method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream).text();
    }
    throw new Error('Compressão não suportada');
  };
}

function resolvePath(base, href) {
  const out = [];
  for (const part of (base + href).split('/')) {
    if (part === '..') out.pop(); else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

async function readEpub(file) {
  if (typeof DecompressionStream === 'undefined') throw new Error('Navegador antigo: atualize para abrir EPUB.');
  const get = await openZip(await file.arrayBuffer());
  const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');

  const container = xml(await get('META-INF/container.xml'));
  const opfPath = container.getElementsByTagNameNS('*', 'rootfile')[0].getAttribute('full-path');
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = xml(await get(opfPath));

  const title = (opf.getElementsByTagNameNS('*', 'title')[0]?.textContent || file.name).trim();
  const manifest = {};
  for (const it of opf.getElementsByTagNameNS('*', 'item')) manifest[it.getAttribute('id')] = it.getAttribute('href');

  const blocks = [];
  for (const ref of opf.getElementsByTagNameNS('*', 'itemref')) {
    const href = manifest[ref.getAttribute('idref')];
    if (!href) continue;
    const src = await get(resolvePath(base, decodeURIComponent(href.split('#')[0])));
    if (!src) continue;
    let page = new DOMParser().parseFromString(src, 'application/xhtml+xml');
    if (page.getElementsByTagName('parsererror').length) page = new DOMParser().parseFromString(src, 'text/html');
    const body = page.body || page.getElementsByTagNameNS('*', 'body')[0];
    if (!body) continue;
    const sel = 'h1,h2,h3,h4,h5,h6,p,li';
    const nodes = body.querySelectorAll(sel);
    if (!nodes.length) { blocks.push(...textToBlocks(body.textContent || '')); continue; }
    for (const n of nodes) {
      if (n.parentElement && n.parentElement.closest(sel)) continue; // evita duplicar aninhados
      const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) blocks.push([/^h\d$/i.test(n.localName) ? 'h' : 'p', t]);
    }
  }
  return { title, blocks };
}

async function openTextFile(file) {
  try {
    if (/\.epub$/i.test(file.name) || file.type === 'application/epub+zip') {
      toast('Abrindo EPUB…');
      const { title, blocks } = await readEpub(file);
      setDoc(title, blocks);
    } else {
      setDoc(file.name.replace(/\.txt$/i, ''), textToBlocks(await readTxt(file)));
    }
  } catch (err) {
    toast('Não consegui abrir: ' + (err.message || 'erro'), 3500);
  }
}

/* =====================================================================
   PLAYER DE VÍDEO
   ===================================================================== */
const video = $('#video');
const yt = $('#yt');
let videoURL = null;

function showVideoFile(file) {
  if (videoURL) URL.revokeObjectURL(videoURL);
  videoURL = URL.createObjectURL(file);
  yt.src = 'about:blank'; yt.hidden = true;
  video.src = videoURL; video.hidden = false;
  $('#videoEmpty').hidden = true;
  video.play().catch(() => {});
}

function youtubeId(url) {
  url = url.trim();
  const m = url.match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/|v\/))([\w-]{11})/);
  if (m) return m[1];
  return /^[\w-]{11}$/.test(url) ? url : null;
}

function showYouTube(id) {
  video.pause(); video.removeAttribute('src'); video.load(); video.hidden = true;
  yt.src = `https://www.youtube-nocookie.com/embed/${id}?playsinline=1&rel=0&enablejsapi=1`;
  yt.hidden = false;
  $('#videoEmpty').hidden = true;
  store.set('lastYt', id);
}

function pauseVideos() {
  video.pause();
  try { yt.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }), '*'); } catch {}
}

/* =====================================================================
   INTERFACE
   ===================================================================== */
const dlgSettings = $('#dlgSettings');
let mode = 'text';

function setMode(m) {
  mode = m;
  store.set('mode', m);
  stage.dataset.mode = m;
  $('#reader').hidden = m !== 'text';
  $('#player').hidden = m !== 'video';
  $('#bar-text').hidden = m !== 'text';
  $('#bar-video').hidden = m !== 'video';
  document.querySelectorAll('.tab[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  if (m !== 'video') pauseVideos();
}

let toastTimer = 0;
function toast(msg, ms = 1800) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function buildSettings() {
  const box = $('#sliders');
  box.textContent = '';
  for (const s of SLIDERS) {
    const wrap = document.createElement('label');
    wrap.className = 'slider';
    wrap.innerHTML = `<div class="srow"><span></span><output></output></div>
      <input type="range" min="${s.min}" max="${s.max}" step="${s.step}"><small></small>`;
    wrap.querySelector('span').textContent = s.label;
    wrap.querySelector('small').textContent = s.help;
    const input = wrap.querySelector('input');
    const out = wrap.querySelector('output');
    input.value = cfg[s.key];
    out.textContent = s.fmt(cfg[s.key]);
    input.addEventListener('input', () => {
      cfg[s.key] = parseFloat(input.value);
      out.textContent = s.fmt(cfg[s.key]);
      applyCfg(); saveCfgSoon();
    });
    box.appendChild(wrap);
  }
  $('#chkInvert').checked = cfg.invert;
}

/* ---------- eventos ---------- */
document.querySelectorAll('.tab[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

$('#btnToggle').addEventListener('click', () => {
  enabled = !enabled;
  store.set('enabled', enabled);
  if (enabled) resetMotion();
  updateStatus();
  toast(enabled ? 'Estabilização ligada' : 'Estabilização desligada');
});
$('#btnCalib').addEventListener('click', calibrate);
$('#btnSettings').addEventListener('click', () => dlgSettings.showModal());
$('#btnFull').addEventListener('click', toggleFullscreen);
$('#warnClose').addEventListener('click', () => { $('#warn').hidden = true; });

$('#btnReset').addEventListener('click', () => {
  cfg = { ...DEFAULTS };
  store.set('cfg', cfg);
  applyCfg(); buildSettings(); resetMotion();
  toast('Padrões restaurados');
});
$('#chkInvert').addEventListener('change', (e) => { cfg.invert = e.target.checked; saveCfgSoon(); resetMotion(); });

// Fecha diálogos pelos botões [data-close] e tocando fora.
document.querySelectorAll('dialog').forEach((d) => {
  d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()));
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
});

// Texto
$('#btnOpen').addEventListener('click', () => $('#fileText').click());
$('#fileText').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) openTextFile(f); e.target.value = ''; });
$('#btnPaste').addEventListener('click', () => { $('#pasteArea').value = ''; $('#dlgPaste').showModal(); });
$('#btnClipboard').addEventListener('click', async () => {
  try { $('#pasteArea').value = await navigator.clipboard.readText(); }
  catch { toast('Sem acesso à área de transferência — segure no campo e cole.', 3000); }
});
$('#btnPasteOk').addEventListener('click', () => {
  const text = $('#pasteArea').value;
  if (!text.trim()) { toast('Cole algum texto primeiro.'); return; }
  const title = text.trim().split('\n')[0].slice(0, 60);
  $('#dlgPaste').close();
  setDoc(title, textToBlocks(text));
});
$('#btnFontDown').addEventListener('click', () => changeReader(() => { rprefs.font = Math.max(12, rprefs.font - 2); }));
$('#btnFontUp').addEventListener('click', () => changeReader(() => { rprefs.font = Math.min(44, rprefs.font + 2); }));
$('#btnSpacing').addEventListener('click', () => changeReader(() => {
  const i = SPACINGS.indexOf(rprefs.lh);
  rprefs.lh = SPACINGS[(i + 1) % SPACINGS.length];
  toast('Espaçamento ' + rprefs.lh);
}));
$('#btnTheme').addEventListener('click', () => changeReader(() => {
  rprefs.theme = THEMES[(THEMES.indexOf(rprefs.theme) + 1) % THEMES.length];
  toast({ dark: 'Escuro', black: 'Preto (OLED)', sepia: 'Sépia', light: 'Claro' }[rprefs.theme]);
}));

// Vídeo
$('#btnVideoFile').addEventListener('click', () => $('#fileVideo').click());
$('#fileVideo').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) showVideoFile(f); e.target.value = ''; });
$('#btnYoutube').addEventListener('click', () => {
  const last = store.get('lastYt', '');
  $('#ytInput').value = last ? 'https://youtu.be/' + last : '';
  $('#dlgYt').showModal();
});
$('#btnYtOk').addEventListener('click', () => {
  const id = youtubeId($('#ytInput').value);
  if (!id) { toast('Link do YouTube não reconhecido.'); return; }
  if (!navigator.onLine) toast('Sem internet: o YouTube precisa de conexão.', 3000);
  $('#dlgYt').close();
  showYouTube(id);
});

// Permissão (primeira abertura no iPhone)
$('#btnPerm').addEventListener('click', async () => {
  $('#permOverlay').hidden = true;
  await startSensors();
  keepAwake();
});
$('#btnNoPerm').addEventListener('click', () => {
  $('#permOverlay').hidden = true;
  setSensor('off');
  toast('Sem estabilização. Reabra o app para ativar depois.', 3000);
});

// Qualquer toque tenta manter a tela acesa (o navegador exige um gesto).
document.addEventListener('pointerdown', keepAwake, { once: true });

/* ---------- início ---------- */
applyCfg();
buildSettings();
applyReaderPrefs();
renderDoc();
setMode(store.get('mode', 'text'));
updateStatus();
requestAnimationFrame(frame);

if (needsPermission) $('#permOverlay').hidden = false; // iPhone: precisa de toque
else startSensors();                                   // Android: liga direto

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
