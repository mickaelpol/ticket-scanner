/* =======================
   CONFIG (À RENSEIGNER)
======================= */
const ALLOWED_EMAILS = ['polmickael3@gmail.com','sabrinamedjoub@gmail.com'].map(e=>e.toLowerCase());
const SCRIPT_ID = '1dkuTGVPxWwq5Ib6EK2iLsJt9HjjH1ll1iMbMB8-ebSEUiUsLmsNqNCGh';   // (non utilisé côté front)
const CLIENT_ID = '479308590121-qggjv8oum95edeql478aqtit3lcffgv7.apps.googleusercontent.com';   // OAuth Web client
const API_KEY         = 'VOTRE_API_KEY'; // optionnel
const SPREADSHEET_ID  = '1OgcxX9FQ4VWmWNKWxTqqmA1v-lmqMWB7LmRZHMq7jZI';
const DEFAULT_SHEET   = 'Août 2025';
const OCR_LANG        = 'eng+fra+spa+cat'; // FR/EN/ES/CAT

/* =======================
   ÉTAT GLOBAL
======================= */
let accessToken = null;
let tokenClient = null;
let gapiReady = false;
let gisReady  = false;
let currentUserEmail = null;
let sheetNameToId = {};

const $ = s => document.querySelector(s);
const setStatus  = msg => { const el=$('#status'); if (el) el.textContent = msg; console.log('[Scan]', msg); };
const enableSave = on  => { const b=$('#btnSave'); if (b) b.disabled = !on; };

/* =======================
   BOOT
======================= */
document.addEventListener('DOMContentLoaded', () => {
  bindUI();
  bootGoogle();
});

/* =======================
   UI
======================= */
function bindUI(){
  bindChips('merchantCandidates','merchant');
  bindChips('dateCandidates','date');
  bindChips('totalCandidates','total');

  $('#file').addEventListener('change', handleImageChange);
  $('#btnSave').addEventListener('click', saveToSheet);
  $('#btnReset').addEventListener('click', resetForm);

  $('#btnAuth').addEventListener('click', async () => {
    try {
      setStatus('Connexion…');
      await ensureConnected(true);
      await updateAuthUI();
      await listSheets();
      setStatus('Connecté ✓');
    } catch(e){
      console.error(e);
      setStatus('Échec connexion');
    }
  });

  // Normalise le total au blur (12,3 -> 12,30)
  const total = $('#total');
  if (total) total.addEventListener('blur', () => {
    if (!total.value) return;
    const n = parseEuroToNumber(total.value);
    if (n != null) total.value = n.toFixed(2).replace('.', ',');
  });
}

function bindChips(containerId, inputId){
  const box = document.getElementById(containerId);
  if (!box) return;
  box.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const val = chip.getAttribute('data-v');
    if (inputId === 'date') setDateInputSmart(val);
    else if (inputId === 'total') $('#total').value = toFrMoney(val);
    else document.getElementById(inputId).value = val;
    validateCanSave();
  });
}

function resetForm(){
  const p = $('#preview'); if (p) p.src='';
  ['merchant','date','total'].forEach(id=>{ const el=$('#'+id); if (el) el.value=''; });
  ['merchantCandidates','dateCandidates','totalCandidates'].forEach(id=>{ const el=$('#'+id); if (el) el.innerHTML=''; });
  enableSave(false); setStatus('Prêt.');
}

function parseEuroToNumber(s){
  if (!s) return null;
  const n = parseFloat(String(s).replace(/\s+/g,'').replace(/[€]/g,'').replace(',','.'));
  return Number.isFinite(n) ? n : null;
}

/* ===== Helpers date pour <input type="date"> ===== */
const pad2 = n => String(n).padStart(2, '0');

function ddmmyyyyToISO(s){
  const m = String(s||'').match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if(!m) return '';
  let d = +m[1], mo = +m[2], y = +m[3];
  if (y < 100) y += 2000;
  if (d<1||d>31||mo<1||mo>12) return '';
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}
function yyyymmddToISO(s){
  const m = String(s||'').match(/^(20\d{2})[\/.\-]([01]?\d)[\/.\-]([0-3]?\d)$/);
  if(!m) return '';
  return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
}
function setDateInputSmart(str){
  const iso = ddmmyyyyToISO(str) || yyyymmddToISO(str);
  const el = $('#date'); if (el) el.value = iso || '';
}
function isoToDDMMYYYY(iso){
  const m = String(iso||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m) return '';
  return `${m[3]}/${m[2]}/${m[1]}`;
}
function getDateFromInput(){
  return isoToDDMMYYYY($('#date').value);
}
function validateCanSave(){
  const label = ($('#merchant').value||'').trim();
  const dateOk = !!$('#date').value;
  const totalOk = parseEuroToNumber($('#total').value) != null;
  enableSave(!!label && dateOk && totalOk && !!($('#sheetSelect').value));
}

/* =======================
   GOOGLE SDK
======================= */
async function bootGoogle(){
  await waitFor(()=>typeof gapi!=='undefined',150,10000).catch(()=>{});
  await waitFor(()=>window.google && google.accounts && google.accounts.oauth2,150,10000).catch(()=>{});

  if (typeof gapi !== 'undefined') {
    await new Promise(resolve => gapi.load('client', resolve));
    const initConfig = {
      discoveryDocs: [
        'https://sheets.googleapis.com/$discovery/rest?version=v4',
        'https://www.googleapis.com/discovery/v1/apis/oauth2/v2/rest'
      ]
    };
    if (API_KEY && !/VOTRE_API_KEY/i.test(API_KEY)) initConfig.apiKey = API_KEY;
    try {
      await gapi.client.init(initConfig);
      gapiReady = true;
    } catch (e) {
      console.error('gapi.init failed:', e);
      setStatus('Échec init Google API (vérifie CLIENT_ID / origines autorisées).');
      return;
    }
  }

  if (window.google?.accounts?.oauth2) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email',
      prompt: '',
      callback: async (resp) => {
        if (resp.error) { showAuthNeeded(); return; }
        accessToken = resp.access_token;
        gapi.client.setToken({ access_token: accessToken });
        await updateAuthUI();
        await listSheets();
      }
    });
    gisReady = true;
  }

  try { await ensureConnected(false); } catch(_) {}
  await updateAuthUI();
  await listSheets();
}

function showAuthNeeded(){
  $('#btnAuth').style.display = 'inline-block';
  $('#authStatus').textContent = 'Autorisation nécessaire';
}
async function ensureConnected(forceConsent=false){
  if (!gapiReady || !gisReady) throw new Error('SDK Google non initialisés');
  if (accessToken) return;
  await new Promise((resolve, reject)=>{
    tokenClient.callback = (resp)=>{
      if (resp?.error) return reject(resp);
      accessToken = resp.access_token;
      gapi.client.setToken({ access_token: accessToken });
      resolve();
    };
    tokenClient.requestAccessToken({ prompt: forceConsent ? 'consent' : '' });
  });
}
async function updateAuthUI(){
  try {
    if (!accessToken) { showAuthNeeded(); return; }
    const me = await gapi.client.oauth2.userinfo.get();
    currentUserEmail = (me.result?.email || '').toLowerCase();
    if (!currentUserEmail) { showAuthNeeded(); return; }
    const ok = ALLOWED_EMAILS.includes(currentUserEmail);
    $('#authStatus').innerHTML = ok
      ? `Connecté · <span class="text-success">${currentUserEmail}</span>`
      : `Connecté · <span class="text-danger">accès refusé</span>`;
    $('#btnAuth').style.display = ok ? 'none' : 'inline-block';
  } catch(e){
    console.warn(e); showAuthNeeded();
  }
}
async function listSheets(){
  if (!accessToken) return;
  try {
    // récupère 'index' pour choisir le dernier onglet si DEFAULT_SHEET absent
    const resp = await gapi.client.sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      fields: 'sheets(properties(sheetId,title,index))'
    });
    const props = (resp.result.sheets||[]).map(s=>s.properties);

    sheetNameToId = {};
    const sel = $('#sheetSelect');
    sel.innerHTML = props
      .sort((a,b)=>a.index-b.index)
      .map(p => { sheetNameToId[p.title]=p.sheetId; return `<option>${p.title}</option>`; })
      .join('');

    let preselect = props.find(p => p.title === DEFAULT_SHEET) || props.at(-1);
    if (preselect) sel.value = preselect.title;
  } catch(e){
    console.warn('listSheets:', e);
  }
}
function waitFor(test, every=100, timeout=10000){
  return new Promise((resolve,reject)=>{
    const t0 = Date.now();
    (function loop(){
      try { if (test()) return resolve(); } catch(_){}
      if (Date.now() - t0 > timeout) return reject(new Error('waitFor timeout'));
      setTimeout(loop, every);
    })();
  });
}

/* =======================
   SCAN (jscanify) → PREPROC (OpenCV) → OCR rapide
======================= */
async function handleImageChange(e){
  const file = e.target.files?.[0];
  if (!file) return;
  enableSave(false);
  setStatus('Chargement de la photo…');

  // 0) Lire l’image dans un <img>
  const img = await fileToImage(file);

  // 1) jscanify : détection + redressement (canvas)
  setStatus('Détection et redressement…');
  let scannedCanvas;
  try {
    const baseCanvas = drawImageFit(img, 1200); // ✔ plus rapide
    const scanner = new jscanify();
    scannedCanvas = scanner.scan(baseCanvas); // canvas recadré/perspective corrigée
  } catch (err) {
    console.warn('jscanify failed, fallback original:', err);
    scannedCanvas = drawImageFit(img, 1200);
  }

  // 2) OpenCV : amélioration légère pour OCR (binarisation adaptative)
  setStatus('Prétraitement (OpenCV)…');
  const ocrCanvas = await enhanceForOCR_Canvas(scannedCanvas).catch(()=>{
    return scannedCanvas; // fallback
  });

  // Preview
  const preview = $('#preview');
  if (preview) preview.src = ocrCanvas.toDataURL('image/jpeg', 0.9);

  // 3) OCR RAPIDE : seulement bande haute & bande basse
  setStatus('Lecture OCR (rapide)…');
  const base64 = ocrCanvas.toDataURL('image/jpeg', 0.9).split(',')[1];
  let { topText, bottomText } = await runOCRBandsOnly(base64);

  // Fallback plein si une info manque
  const needsFull = (!topText || topText.length < 20) || (!bottomText || bottomText.length < 20);
  let fullText = '';
  if (needsFull) {
    setStatus('Lecture OCR (fallback plein)…');
    fullText = await tesseractRecognize(base64);
  }

  // 4) Parsing (marchand, date, total) + suggestions
  setStatus('Extraction des données…');
  const parsed = parseReceipt({ fullText, topText, bottomText });
  applyCandidates(parsed);

  validateCanSave();
  setStatus('Vérifie / ajuste puis “Enregistrer”.');
}

function drawImageFit(img, max = 1200){
  const r = Math.min(max / img.naturalWidth, max / img.naturalHeight, 1);
  const w = Math.round(img.naturalWidth * r);
  const h = Math.round(img.naturalHeight * r);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c;
}

function fileToImage(file){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

/* ===== OpenCV : binarisation adaptative sur canvas ===== */
async function enhanceForOCR_Canvas(inCanvas){
  if (!window._opencvReady || !window.cv) return inCanvas;

  const src = cv.imread(inCanvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);

  const eq = new cv.Mat();
  cv.equalizeHist(gray, eq);

  const bw = new cv.Mat();
  cv.adaptiveThreshold(eq, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 31, 12);

  const mean = cv.mean(bw)[0];
  if (mean < 127) cv.bitwise_not(bw, bw);

  const out = document.createElement('canvas');
  out.width = bw.cols; out.height = bw.rows;
  cv.imshow(out, bw);

  [src, gray, eq, bw].forEach(m => { try { m.delete(); } catch(_){} });

  return out;
}

/* ===== OCR bandes haute/basse ===== */
async function runOCRBandsOnly(base64){
  const [topB64, bottomB64] = await cutBands(base64, 0.00, 0.28, 0.62, 1.00);
  const [topText, bottomText] = await Promise.all([
    topB64 ? tesseractRecognize(topB64) : Promise.resolve(''),
    bottomB64 ? tesseractRecognize(bottomB64) : Promise.resolve('')
  ]);
  return { topText, bottomText };
}
async function tesseractRecognize(base64){
  const { data: { text } } = await Tesseract.recognize('data:image/jpeg;base64,' + base64, OCR_LANG, {
    tessedit_pageseg_mode: '6'
  });
  return text || '';
}
async function cutBands(base64, topStart=0, topEnd=0.25, botStart=0.65, botEnd=1.0){
  return new Promise((resolve)=>{
    const img = new Image();
    img.onload = ()=>{
      const W = img.width, H = img.height;
      const c = document.createElement('canvas'), ctx=c.getContext('2d');
      c.width=W; c.height=H; ctx.drawImage(img,0,0);
      function cut(y0, y1){
        const ch = Math.max(1, Math.round(H*(y1-y0)));
        const cy = Math.round(H*y0);
        const seg = document.createElement('canvas'); seg.width=W; seg.height=ch;
        const sctx = seg.getContext('2d'); sctx.drawImage(c, 0, cy, W, ch, 0, 0, W, ch);
        return seg.toDataURL('image/jpeg', 0.9).split(',')[1];
      }
      resolve([cut(topStart, topEnd), cut(botStart, botEnd)]);
    };
    img.src = 'data:image/jpeg;base64,' + base64;
  });
}

/* =======================
   PARSING + SUGGESTIONS
======================= */
function parseReceipt(ocr){
  const clean = s => String(s||'').replace(/\u00A0/g,' ').replace(/\s+/g,' ').trim();

  const top  = (ocr.topText  || '').split(/\r?\n/).map(clean).filter(Boolean);
  const bot  = (ocr.bottomText|| '').split(/\r?\n/).map(clean).filter(Boolean);
  const full = (ocr.fullText  || '').split(/\r?\n/).map(clean).filter(Boolean);

  // ENSEIGNE : fort au début + mots-clés connus (E.S., GASOPAS, etc.)
  const merchants = merchantCandidates(top, full);

  // DATE : “Date: 07/08/2025 11:36”, “Fecha: 07.08.25”, etc.
  const dates = dateCandidates([...top, ...full]);

  // TOTAL (depuis le bas, privilégie près de "EUR")
  const totals = totalCandidates(bot.length ? bot : full);

  return { merchants, dates, totals };
}

/* --- Marchand --- */
function merchantCandidates(top, full){
  const KNOWN = /(E\.?S\.?|ESTACI[ÓO]N|GASOLINERA|GASOPAS|TOTAL(?:\s?ENERGIES)?|CARREFOUR|LECLERC|AUCHAN|LIDL|ALDI|MONOPRIX|CASINO|INTERMARCH[ÉE]|REDSYS|SHELL|BP|REPSOL)/i;
  const BAD = /(SIRET|TVA|FACTURE|TICKET|N[°o]|NUM[ÉE]RO|CARTE|PAIEMENT|VENTE|CAISSE|CLIENT|TEL|WWW|HTTP|EMAIL|SITE\s+WEB|CIF|NRT|NIF|RCS|CONFIRMACI[ÓO]N|CONFIRMATION)/i;
  const looksAddr = /(RUE|AVENUE|AVDA|AV\.|BD|BOULEVARD|PLAZA|PLACE|CHEMIN|IMPASSE|CARRER|CP|\b\d{5}\b|ANDORRA|FRANCE|ESPAÑA|PORTUGAL)/i;

  const pick = (arr) => {
    const cand = [];
    for (let i=0;i<Math.min(arr.length, 12); i++){
      const L = arr[i];
      if (!L || BAD.test(L) || looksAddr.test(L)) continue;
      const digits = (L.match(/\d/g)||[]).length;
      const letters = (L.match(/\p{L}/gu)||[]).length;
      const upper = (L.match(/[A-ZÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸ]/g)||[]).length;
      const ratio = letters ? upper/letters : 0;

      let score = 0;
      if (KNOWN.test(L)) score += 5;
      score += Math.min(letters,25)/25;
      score += ratio*3;
      score -= Math.min(digits,6)*0.5;

      cand.push({L, score});
    }
    return cand.sort((a,b)=>b.score-a.score).map(x=>x.L);
  };

  const m1 = pick(top);
  const m2 = pick(full);
  const out = unique([...(m1||[]), ...(m2||[])]);
  return out.slice(0,5);
}

/* --- Dates --- */
function dateCandidates(lines){
  const text = lines.join('\n');
  const out = [];

  // "Date: 07/08/2025 11:36" | "Fecha: 07.08.25"
  const kw = /(?:DATE|FECHA|DATA|D\.|FEC\.?)\s*[:\-]?\s*((?:[0-3]?\d[\/.\-][01]?\d[\/.\-]\d{2,4})|(?:20\d{2}[\/.\-][01]?\d[\/.\-][0-3]?\d))/ig;
  let m; while((m = kw.exec(text))) out.push(m[1]);

  // dates isolées
  const any = /\b((?:[0-3]?\d[\/.\-][01]?\d[\/.\-]\d{2,4})|(?:20\d{2}[\/.\-][01]?\d[\/.\-][0-3]?\d))\b/g;
  while((m = any.exec(text))) out.push(m[1]);

  // normalise -> DD/MM/YYYY puis transformera en ISO au clic
  const norm = unique(out.map(normalizeDate).filter(Boolean));
  return norm.slice(0,5);
}
function normalizeDate(s){
  const a = String(s||'').trim();
  let m = a.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (m) {
    let d=+m[1], mo=+m[2], y=+m[3]; if (y<100) y+=2000;
    if (d>=1&&d<=31&&mo>=1&&mo<=12) return `${pad2(d)}/${pad2(mo)}/${y}`;
  }
  m = a.match(/^(20\d{2})[\/.\-]([01]?\d)[\/.\-]([0-3]?\d)/);
  if (m) { return `${pad2(+m[3])}/${pad2(+m[2])}/${m[1]}`; }
  return '';
}

/* --- Totaux --- */
function totalCandidates(lines){
  // Cherche depuis le bas. Priorité : prix suivi/précédé de EUR, puis "TOTAL TTC/NET À PAYER",
  // sinon premier prix rencontré en remontant.
  const rxPrice = /(\d[\d\s]{0,3}(?:\s?\d{3})*[.,]\d{2})/;
  const rxWithEUR = new RegExp(`${rxPrice.source}\\s*(?:€|EUR)\\b`, 'i');
  const rxEURBefore = new RegExp(`\\b(?:€|EUR)\\s*${rxPrice.source}`, 'i');

  const arr = Array.isArray(lines) ? lines : String(lines).split(/\r?\n/);
  const rev = [...arr].reverse();

  // 1) EUR à droite
  for (const L of rev) {
    const m = L.match(rxWithEUR);
    if (m) return [m[1]];
  }
  // 2) EUR à gauche
  for (const L of rev) {
    const m = L.match(rxEURBefore);
    if (m) return [m[1]];
  }
  // 3) Mots-clés "TOTAL"/"NET À PAYER"
  for (const L of rev) {
    if (!/total|à\s*payer|pagar|pagado/i.test(L)) continue;
    const m = L.match(rxPrice);
    if (m) return [m[1]];
  }
  // 4) Fallback : premier prix en remontant (garde les centimes)
  for (const L of rev) {
    const m = L.match(rxPrice);
    if (m) return [m[1]];
  }
  return [];
}

/* =======================
   Rendu candidats -> champs
======================= */
function applyCandidates(c){
  // Merchant
  $('#merchant').value = c.merchants[0] || '';
  $('#merchantCandidates').innerHTML = chipsHTML(c.merchants);

  // Date
  if (c.dates[0]) setDateInputSmart(c.dates[0]);
  $('#dateCandidates').innerHTML = chipsHTML(c.dates);

  // Total (garde les centimes)
  $('#total').value = toFrMoney(c.totals[0] || '');
  $('#totalCandidates').innerHTML = chipsHTML(c.totals.map(toFrMoney));

  validateCanSave();
}

const chipsHTML = arr =>
  (arr && arr.length)
    ? arr.map(v=>`<span class="chip" data-v="${escapeHtml(v)}">${escapeHtml(v)}</span>`).join('')
    : `<span class="text-muted small">—</span>`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
  }[m]));
}
function unique(arr){ return [...new Set(arr.map(s=>String(s).trim()).filter(Boolean))]; }
function toFrMoney(s){
  if (!s) return '';
  const n = parseFloat(String(s).replace(/\s/g,'').replace(',', '.'));
  if (!Number.isFinite(n)) return String(s);
  return n.toFixed(2).replace('.', ',');
}

/* =======================
   ENREGISTREMENT SHEETS (format € à droite)
======================= */
async function saveToSheet(){
  try {
    await ensureConnected(false);
    const me = await gapi.client.oauth2.userinfo.get();
    const email = (me.result?.email || '').toLowerCase();
    if (!ALLOWED_EMAILS.includes(email)) throw new Error('Adresse non autorisée');

    const who = document.querySelector('input[name="who"]:checked')?.value || '';
    const sheetName = $('#sheetSelect').value || DEFAULT_SHEET;

    const cols = (who.toLowerCase().startsWith('sab'))
      ? {label:'K', date:'L', total:'M'}
      : {label:'O', date:'P', total:'Q'};

    const label   = ($('#merchant').value || '').trim();
    const dateStr = getDateFromInput(); // DD/MM/YYYY
    const totalNum = parseEuroToNumber($('#total').value);

    if (!label || !dateStr || totalNum == null) throw new Error('Champs incomplets');

    setStatus('Recherche de la prochaine ligne libre…');
    const row = await findNextEmptyRow(sheetName, cols.label, 11);

    setStatus('Écriture…');
    await gapi.client.sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!${cols.label}${row}:${cols.total}${row}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[ label, dateStr, totalNum ]] }
    });

    const sid = sheetNameToId[sheetName];
    if (sid != null) {
      await gapi.client.sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          requests: [
            {
              repeatCell: {
                range: gridRangeFromA1(sid, `${cols.date}${row}:${cols.date}${row}`),
                cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'dd/mm/yyyy' } } },
                fields: 'userEnteredFormat.numberFormat'
              }
            },
            {
              repeatCell: {
                range: gridRangeFromA1(sid, `${cols.total}${row}:${cols.total}${row}`),
                cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0.00 "€"' } } },
                fields: 'userEnteredFormat.numberFormat'
              }
            }
          ]
        }
      });
    }

    setStatus(`Enregistré ✔ (ligne ${row}, ${who}, onglet « ${sheetName} »)`);
    enableSave(false);
  } catch(e){
    console.error(e);
    setStatus('Erreur : ' + (e.message || e));
  }
}

async function findNextEmptyRow(sheetName, colLetter, startRow=11){
  const endRow = startRow + 1000;
  const range = `${sheetName}!${colLetter}${startRow}:${colLetter}${endRow}`;
  const resp = await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const values = resp.result.values || [];
  for (let i=0;i<values.length;i++){
    const v = (values[i][0] || '').toString().trim();
    if (!v) return startRow + i;
  }
  return startRow + values.length;
}

/* =======================
   A1 → GridRange (avec sheetId)
======================= */
function gridRangeFromA1(sheetId, a1){
  const m = a1.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (!m) throw new Error('A1 invalide: ' + a1);
  const c1 = colToIndex(m[1]), r1 = +m[2]-1;
  const c2 = colToIndex(m[3]) + 1, r2 = +m[4];
  return { sheetId, startRowIndex:r1, endRowIndex:r2, startColumnIndex:c1, endColumnIndex:c2 };
}
function colToIndex(col){
  let x=0; for (let i=0;i<col.length;i++){ x = x*26 + (col.charCodeAt(i)-64); }
  return x-1;
}
