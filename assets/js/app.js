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

  // UX: normalise le total au blur (12,3 -> 12,30)
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
  const n = parseFloat(String(s).replace(/\s+/g,'').replace('€','').replace(',','.'));
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
function setDateInputFromDDMM(str){
  const iso = ddmmyyyyToISO(str);
  const el = $('#date'); if (el) el.value = iso || '';
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
    // On récupère "index" pour sélectionner le dernier onglet créé par défaut
    const resp = await gapi.client.sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      fields: 'sheets(properties(sheetId,title,index))'
    });
    const props = (resp.result.sheets||[]).map(s=>s.properties);

    sheetNameToId = {};
    const sel = $('#sheetSelect');
    sel.innerHTML = props
      .sort((a,b)=>a.index-b.index) // tri par index
      .map(p => {
        sheetNameToId[p.title] = p.sheetId;
        return `<option>${p.title}</option>`;
      }).join('');

    // Pré-sélection : DEFAULT_SHEET si présent, sinon le dernier (index max)
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
   SCAN (jscanify) → PREPROC (OpenCV) → OCR
======================= */
async function handleImageChange(e){
  const file = e.target.files?.[0];
  if (!file) return;
  enableSave(false);
  setStatus('Chargement de la photo…');

  // 0) Lire l’image dans un <img>
  const img = await fileToImage(file);

  // 1) jscanify : détection du document + redressement (canvas)
  setStatus('Détection et redressement…');
  let scannedCanvas;
  try {
    const baseCanvas = drawImageFit(img, 2000);
    const scanner = new jscanify();
    scannedCanvas = scanner.scan(baseCanvas); // canvas recadré/perspective corrigée
  } catch (err) {
    console.warn('jscanify failed, fallback original:', err);
    scannedCanvas = drawImageFit(img, 2000);
  }

  // 2) OpenCV : amélioration pour OCR (binarisation adaptative)
  setStatus('Prétraitement (OpenCV)…');
  const ocrCanvas = await enhanceForOCR_Canvas(scannedCanvas).catch(()=>{
    // fallback si OpenCV indispo
    return scannedCanvas;
  });

  // Preview
  const preview = $('#preview');
  if (preview) preview.src = ocrCanvas.toDataURL('image/jpeg', 0.95);

  // 3) OCR (Tesseract, multipasse)
  setStatus('Lecture OCR…');
  const base64 = ocrCanvas.toDataURL('image/jpeg', 0.95).split(',')[1];
  const { fullText, topText, bottomText } = await runOCRMulti(base64);

  // 4) Parsing (marchand, date, total) + suggestions
  setStatus('Extraction des données…');
  const parsed = parseReceipt({ fullText, topText, bottomText });
  applyCandidates(parsed);

  // Déverrouille si on a tout
  validateCanSave();
  setStatus('Vérifie / ajuste puis “Enregistrer”.');
}

function drawImageFit(img, max = 2000){
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

  // gray -> equalize -> adaptiveThreshold -> invert si besoin
  const src = cv.imread(inCanvas);
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);

  const eq = new cv.Mat();
  cv.equalizeHist(gray, eq);

  const bw = new cv.Mat();
  cv.adaptiveThreshold(eq, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 35, 15);

  // Inversion si majoritairement sombre
  const mean = cv.mean(bw)[0];
  if (mean < 127) cv.bitwise_not(bw, bw);

  const out = document.createElement('canvas');
  out.width = bw.cols; out.height = bw.rows;
  cv.imshow(out, bw);

  [src, gray, eq, bw].forEach(m => { try { m.delete(); } catch(_){} });

  return out;
}

/* ===== OCR multipasse : plein + bande haute + bande basse ===== */
async function runOCRMulti(base64){
  const fullText = await tesseractRecognize(base64);
  const [topB64, bottomB64] = await cutBands(base64, 0.00, 0.25, 0.65, 1.00);
  const [topText, bottomText] = await Promise.all([
    topB64 ? tesseractRecognize(topB64) : Promise.resolve(''),
    bottomB64 ? tesseractRecognize(bottomB64) : Promise.resolve('')
  ]);
  return { fullText, topText, bottomText };
}
async function tesseractRecognize(base64){
  const { data: { text } } = await Tesseract.recognize('data:image/jpeg;base64,' + base64, OCR_LANG, { logger:()=>{} });
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
        return seg.toDataURL('image/jpeg', 0.95).split(',')[1];
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
  const full = (ocr.fullText || '').split(/\r?\n/).map(clean).filter(Boolean);
  const top  = (ocr.topText  || '').split(/\r?\n/).map(clean).filter(Boolean);
  const bot  = (ocr.bottomText|| '').split(/\r?\n/).map(clean).filter(Boolean);
  const whole = [...top, ...full, ...bot].join('\n');

  // ENSEIGNE
  let merchCand = takeMerchantCandidates(top);
  if (merchCand.length < 5) merchCand = unique([...merchCand, ...takeMerchantCandidates(full)]);

  // DATES (support DD/MM/YYYY, YYYY-MM-DD, mois FR en lettres si présents dans OCR global)
  const dateCand = unique([
    ...fromDateKeywords(whole),
    ...strictDateRegex(whole)
  ]).map(normalizeDate).filter(Boolean).slice(0,5);

  // TOTAL
  let totalCand = fromTotalKeywords(bot.join('\n'));
  if (totalCand.length < 5) {
    const more = plausibleAmounts(bot).concat(plausibleAmounts(full));
    for (const r of more) {
      if (!totalCand.find(t => normNum(t) === normNum(r))) totalCand.push(r);
      if (totalCand.length >= 5) break;
    }
  }

  return {
    merchants: merchCand.slice(0,5),
    dates: dateCand.slice(0,5),
    totals: totalCand.slice(0,5)
  };

  function clean(s){ return s.replace(/\s+/g,' ').trim(); }
}

function takeMerchantCandidates(linesArr){
  const known = /(ASF|VINCI|CARREFOUR|LECLERC|E\.?LECLERC|INTERMARCHÉ|AUCHAN|LIDL|MONOPRIX|CASINO|ALDI|DECATHLON|ACTION|FNAC|DARTY|BOULANGER|PICARD|BIOCOOP|PRIMARK|ZARA|IKEA|H&M|TOTAL(?:\s?ENERGIES)?|REDSYS|GASOLINERA|GASOPAS|ES\s+GASOPAS|E\.S\.)/i;
  const bad = /(SIRET|TVA|FACTURE|TICKET|N[°o]|NUMÉRO|CARTE|PAIEMENT|VENTE|CAISSE|CLIENT|TEL|WWW|HTTP|EMAIL|SITE\s+WEB|CIF|NRT|NIF|RCS)/i;
  const looksAddr = /(RUE|AVENUE|AVDA|AV\.|BD|BOULEVARD|PLAZA|PLACE|CHEMIN|IMPASSE|CARRER|CP|\b\d{5}\b|ANDORRA|FRANCE|ESPAÑA|PORTUGAL)/i;

  const out = [];
  for (let i=0;i<Math.min(linesArr.length, 15); i++){
    const L = linesArr[i];
    if (!L || bad.test(L) || looksAddr.test(L)) continue;
    if (known.test(L)) out.unshift(L);
    else if (/^[A-ZÀ-ÖØ-Þ0-9\.\- ']{2,45}$/.test(L)) out.push(L);
  }
  return unique(out);
}

function fromDateKeywords(text){
  // capte "DATE: 12/07/2025", "FECHA 12-07-25", etc.
  const rx = /(?:DATE|FECHA|DATA|D\.|FEC\.?)\s*[:\-]?\s*([0-3]?\d[\/\.\-][01]?\d[\/\.\-]\d{2,4}|20\d{2}[\/\.\-][01]?\d[\/\.\-][0-3]?\d)/ig;
  const out = []; let m; while((m = rx.exec(text))) out.push(m[1]); return out;
}
function strictDateRegex(text){
  // toutes dates plausibles autonomes
  const rx = /\b([0-3]?\d[\/\.\-][01]?\d[\/\.\-]\d{2,4}|20\d{2}[\/\.\-][01]?\d[\/\.\-][0-3]?\d)\b/g;
  const out = []; let m; while((m = rx.exec(text))) out.push(m[1]); return out;
}
function normalizeDate(s){
  // retourne "DD/MM/YYYY" ou "" si invalide
  const a = String(s||'').trim();
  let m = a.match(/^(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{2,4})$/);
  if (m) {
    let d=+m[1], mo=+m[2], y=+m[3]; if (y<100) y+=2000;
    if (d>=1&&d<=31&&mo>=1&&mo<=12) return `${pad2(d)}/${pad2(mo)}/${y}`;
  }
  m = a.match(/^(20\d{2})[\/\.\-]([01]?\d)[\/\.\-]([0-3]?\d)$/);
  if (m) {
    return `${pad2(+m[3])}/${pad2(+m[2])}/${m[1]}`;
  }
  return '';
}

function fromTotalKeywords(text){
  const keys = [
    /TOTAL\s*TT?C?/i, /TOTAL\s+À\s+PAYER/i, /NET\s+À\s+PAYER/i, /TOTAL\s+CB/i,
    /IMPORTE\s+TOTAL/i, /IMPORTE/i, /A\s+PAGAR/i, /PAGADO/i,
    /TOTAL\s+RESERVAT/i, /TOTAL\s+SUMINIST/i, /RESUMIT/i
  ];
  for (const k of keys){
    const m = text.match(new RegExp(k.source + `\\s*[:\\-]?\\s*([\\d\\s]+[\\.,]\\d{2})\\s*(?:€|EUR)?`, k.flags));
    if (m) return [m[1]];
  }
  return [];
}
function plausibleAmounts(linesOrText){
  const lines = Array.isArray(linesOrText) ? linesOrText : String(linesOrText).split(/\r?\n/);
  const rx1 = /(\d[\d\s]{0,3}(?:\s?\d{3})*[.,]\d{2})\s*(?:€|EUR)\b/gi;
  const rx2 = /\b(\d[\d\s]{0,3}(?:\s?\d{3})*[.,]\d{2})\b(?!\s*%)/g;
  const out = [];
  for (const L of lines){
    rx1.lastIndex = 0; rx2.lastIndex = 0; let m;
    while((m = rx1.exec(L))) out.push(m[1]);
    while((m = rx2.exec(L))) out.push(m[1]);
  }
  return unique(out).map(r => ({r, v: parseFloat(r.replace(/\s/g,'').replace(',', '.'))}))
                    .filter(x => Number.isFinite(x.v) && x.v >= 0.2 && x.v <= 20000)
                    .sort((a,b)=>b.v-a.v)
                    .map(x => x.r);
}

function applyCandidates(c){
  // Merchant
  $('#merchant').value = c.merchants[0] || '';
  $('#merchantCandidates').innerHTML = chipsHTML(c.merchants);

  // Date
  if (c.dates[0]) setDateInputSmart(c.dates[0]);
  $('#dateCandidates').innerHTML = chipsHTML(c.dates);

  // Total
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
function normNum(s){ return String(s).replace(/\s/g,'').replace(',', '.'); }
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
    const dateStr = getDateFromInput(); // en DD/MM/YYYY
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
