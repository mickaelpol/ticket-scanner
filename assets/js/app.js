/* =======================
   CONFIG (À RENSEIGNER)
======================= */
const ALLOWED_EMAILS = ['polmickael3@gmail.com','sabrinamedjoub@gmail.com'].map(e=>e.toLowerCase());
const SCRIPT_ID = '1dkuTGVPxWwq5Ib6EK2iLsJt9HjjH1ll1iMbMB8-ebSEUiUsLmsNqNCGh';   // ID du projet Apps Script
const CLIENT_ID = '479308590121-qggjv8oum95edeql478aqtit3lcffgv7.apps.googleusercontent.com';   // ID client OAuth (Application Web)
const API_KEY         = 'VOTRE_API_KEY'; // facultatif si tout passe par OAuth, utile pour discovery
const SPREADSHEET_ID  = '1OgcxX9FQ4VWmWNKWxTqqmA1v-lmqMWB7LmRZHMq7jZI'; // ID du Google Sheet
const DEFAULT_SHEET   = 'Août 2025';            // Onglet sélectionné par défaut
const OCR_LANG        = 'fra+eng+spa'; // français + anglais + espagnol (ton ticket est en ES)

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
const setStatus  = msg => { $('#status').textContent = msg; };
const enableSave = on  => { $('#btnSave').disabled = !on; };

/* =======================
   BOOT
======================= */
document.addEventListener('DOMContentLoaded', () => {
  bindUI();
  bootGoogle(); // charge/initialise gapi + GIS sans dépendre d'attributs onload dans le HTML
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
    try { setStatus('Connexion…'); await ensureConnected(true); await updateAuthUI(); await listSheets(); setStatus('Connecté ✓'); }
    catch(e){ console.error(e); setStatus('Échec connexion'); }
  });
}

function bindChips(containerId, inputId){
  const box = document.getElementById(containerId);
  box.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    document.getElementById(inputId).value = chip.getAttribute('data-v');
  });
}

function resetForm(){
  $('#file').value=''; $('#preview').src='';
  ['merchant','date','total'].forEach(id=>$('#'+id).value='');
  ['merchantCandidates','dateCandidates','totalCandidates'].forEach(id=>$('#'+id).innerHTML='');
  enableSave(false); setStatus('Prêt.');
}

function parseEuroToNumber(s){
  if (!s) return null;
  const n = parseFloat(String(s).replace(/\s+/g,'').replace('€','').replace(',','.'));
  return Number.isFinite(n) ? n : null;
}

/* =======================
   GOOGLE SDK (boot sans onload)
======================= */
async function bootGoogle(){
  // Attendre que les scripts soient chargés
  await waitFor(()=>typeof gapi!=='undefined',150,10000).catch(()=>{});
  await waitFor(()=>window.google && google.accounts && google.accounts.oauth2,150,10000).catch(()=>{});

  // Init gapi
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
      setStatus('Échec init Google API (vérifie CLIENT_ID / origine autorisée).');
      return;
    }
  }

  // Init GIS
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

  // Tentative silencieuse (si déjà consenti & session active)
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
    const resp = await gapi.client.sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      fields: 'sheets(properties(sheetId,title))'
    });
    const props = (resp.result.sheets||[]).map(s=>s.properties);
    sheetNameToId = {};
    const sel = $('#sheetSelect');
    sel.innerHTML = props.map(p => {
      sheetNameToId[p.title] = p.sheetId;
      return `<option ${p.title===DEFAULT_SHEET?'selected':''}>${p.title}</option>`;
    }).join('');
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
   IMAGE → PREPROC → OCR
======================= */
async function handleImageChange(e){
  const file = e.target.files?.[0];
  if (!file) return;
  setStatus('Préparation de l’image…');

  const rawB64 = await fileToBase64(file);
  const b64 = await enhanceForOCR(rawB64).catch(()=>rawB64);
  $('#preview').src = 'data:image/jpeg;base64,' + b64;

  setStatus('Analyse (OCR)…');
  const text = await runOCR(b64);

  const parsed = parseReceipt(text);
  applyCandidates(parsed);
  setStatus('Vérifie / ajuste puis “Enregistrer”.');
  enableSave(true);
}

function fileToBase64(file){
  return new Promise((res,rej)=>{
    const r = new FileReader();
    r.onload = ()=>res(r.result.split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

async function enhanceForOCR(base64){
  if (!window._opencvReady || !window.cv) return base64;
  return new Promise((resolve)=>{
    const img = new Image();
    img.onload = ()=>{
      const c = document.createElement('canvas'), ctx = c.getContext('2d');
      c.width=img.width; c.height=img.height; ctx.drawImage(img,0,0);

      const src = cv.imread(c);
      let gray=new cv.Mat(); cv.cvtColor(src,gray,cv.COLOR_RGBA2GRAY,0);
      let equal=new cv.Mat(); cv.equalizeHist(gray,equal);
      let blur =new cv.Mat(); cv.GaussianBlur(equal,blur,new cv.Size(3,3),0,0,cv.BORDER_DEFAULT);
      let bw   =new cv.Mat();
      cv.adaptiveThreshold(blur,bw,255,cv.ADAPTIVE_THRESH_GAUSSIAN_C,cv.THRESH_BINARY,33,15);

      cv.imshow(c,bw);
      const out = c.toDataURL('image/jpeg',0.95).split(',')[1];
      [src,gray,equal,blur,bw].forEach(m=>m.delete());
      resolve(out);
    };
    img.src = 'data:image/jpeg;base64,'+base64;
  });
}

async function runOCR(base64){
  const { data:{ text } } = await Tesseract.recognize(
    'data:image/jpeg;base64,'+base64, OCR_LANG, { logger:()=>{} }
  );
  return text || '';
}

/* =======================
   PARSING + SUGGESTIONS
======================= */
function parseReceipt(text){
  const lines = (text||'').split(/\r?\n/).map(s=>s.replace(/\s+/g,' ').trim()).filter(Boolean);
  const whole = lines.join('\n');

  const known = /(ASF|VINCI|CARREFOUR|LECLERC|E\.?LECLERC|INTERMARCHÉ|AUCHAN|LIDL|MONOPRIX|CASINO|ALDI|DECATHLON|ACTION|FNAC|DARTY|BOULANGER|PICARD|BIOCOOP|PRIMARK|ZARA|IKEA|H&M|TOTAL(?:\s?ENERGIES)?)/i;
  const bad = /(SIRET|TVA|FACTURE|TICKET|N[°o]|NUMÉRO|CARTE|PAIEMENT|VENTE|CAISSE|CLIENT|TEL|WWW|HTTP|EMAIL|SITE\s+WEB)/i;
  const looksAddr = /(RUE|AVENUE|BD|BOULEVARD|PLACE|CHEMIN|IMPASSE|FRANCE|\b\d{5}\b)/i;

  const merchants = [];
  for (let i=0;i<Math.min(lines.length,15);i++){
    const L = lines[i];
    if (!L || bad.test(L) || looksAddr.test(L)) continue;
    if (known.test(L)) merchants.unshift(L);
    else if (/^[A-ZÀ-ÖØ-Þ0-9\.\- ']{2,40}$/.test(L)) merchants.push(L);
  }

  const dates = [...whole.matchAll(/\b(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4})\b/g)]
    .map(m=>normalizeDate(m[1])).filter(Boolean);

  let totals = [];
  const keyRxs = [
    /TOTAL\s*TT?C?\s*[:\-]?\s*([\d\s]+[.,]\d{2})\s*(?:€|EUR)?/i,
    /TOTAL\s+À\s+PAYER\s*[:\-]?\s*([\d\s]+[.,]\d{2})/i,
    /NET\s+À\s+PAYER\s*[:\-]?\s*([\d\s]+[.,]\d{2})/i,
    /TOTAL\s+CB\s*[:\-]?\s*([\d\s]+[.,]\d{2})/i,
    /IMPORTE\s*[:\-]?\s*([\d\s]+[.,]\d{2})/i
  ];
  for (const rx of keyRxs){ const m=whole.match(rx); if (m){ totals.push(m[1]); break; } }

  const amtRxs = [
    /(\d[\d\s]{0,3}(?:\s?\d{3})*[.,]\d{2})\s*(?:€|EUR)\b/gi,
    /\b(\d[\d\s]{0,3}(?:\s?\d{3})*[.,]\d{2})\b(?!\s*%)/g
  ];
  const amts=[];
  lines.forEach(L=>{
    for (const rx of amtRxs){
      rx.lastIndex=0; let m;
      while((m=rx.exec(L))){
        const v=parseFloat(m[1].replace(/\s/g,'').replace(',','.'));
        if (Number.isFinite(v) && v>=0.2 && v<=10000) amts.push({raw:m[1], val:v});
      }
    }
  });
  amts.sort((a,b)=>b.val-a.val);
  for (const a of amts){
    if (!totals.find(t=>normNum(t)===normNum(a.raw))){
      totals.push(a.raw);
      if (totals.length>=6) break;
    }
  }

  return {
    merchants: unique(merchants).slice(0,6),
    dates: unique(dates).slice(0,6),
    totals: unique(totals).slice(0,6)
  };
}

function applyCandidates(c){
  $('#merchant').value = c.merchants[0] || '';
  $('#merchantCandidates').innerHTML = chipsHTML(c.merchants);

  $('#date').value = c.dates[0] || '';
  $('#dateCandidates').innerHTML = chipsHTML(c.dates);

  $('#total').value = toFrMoney(c.totals[0] || '');
  $('#totalCandidates').innerHTML = chipsHTML(c.totals.map(toFrMoney));
}

const chipsHTML = arr =>
  (arr && arr.length)
    ? arr.map(v=>`<span class="chip" data-v="${escapeHtml(v)}">${escapeHtml(v)}</span>`).join('')
    : `<span class="text-muted small">—</span>`;

function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;" }[m])); }
function unique(arr){ return [...new Set(arr.map(s=>s.trim()).filter(Boolean))]; }
function normNum(s){ return String(s).replace(/\s/g,'').replace(',', '.'); }

function normalizeDate(s){
  const m = String(s||'').match(/^(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{2,4})$/);
  if (!m) return '';
  let [_, d, mo, y]=m; d=+d; mo=+mo; y=+y; if (y<100) y+=2000;
  if (d<1||d>31||mo<1||mo>12) return '';
  return `${String(d).padStart(2,'0')}/${String(mo).padStart(2,'0')}/${y}`;
}
function toFrMoney(s){
  if (!s) return '';
  const n = parseFloat(String(s).replace(/\s/g,'').replace(',', '.'));
  if (!Number.isFinite(n)) return String(s);
  return n.toFixed(2).replace('.', ',');
}

/* =======================
   ENREGISTREMENT SHEETS
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
    const dateStr = normalizeDate($('#date').value);

    // >>> CHANGEMENT : envoyer un NOMBRE (pas une chaîne)
    const totalNum = parseEuroToNumber($('#total').value);
    if (!label || !dateStr || totalNum == null) throw new Error('Champs incomplets');

    setStatus('Recherche de la prochaine ligne libre…');
    const row = await findNextEmptyRow(sheetName, cols.label, 11);

    setStatus('Écriture…');
    // 1) valeurs : USER_ENTERED + nombre pour le total
    await gapi.client.sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!${cols.label}${row}:${cols.total}${row}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[ label, dateStr, totalNum ]] }
    });

    // 2) formats (date + € à DROITE)
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
                // >>> CHANGEMENT : motif personnalisé — symbole € APRÈS le nombre
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
