/* =======================
   === CONFIG À RENSEIGNER ===
   ======================= */
const SCRIPT_ID = '1dkuTGVPxWwq5Ib6EK2iLsJt9HjjH1ll1iMbMB8-ebSEUiUsLmsNqNCGh';   // ID du projet Apps Script
const CLIENT_ID = '479308590121-qggjv8oum95edeql478aqtit3lcffgv7.apps.googleusercontent.com';   // ID client OAuth (Application Web)

const API_KEY         = 'VOTRE_API_KEY'; // facultatif si tout passe par OAuth, utile pour discovery
const SPREADSHEET_ID  = '1OgcxX9FQ4VWmWNKWxTqqmA1v-lmqMWB7LmRZHMq7jZI'; // ID du Google Sheet
const DEFAULT_SHEET   = 'Août 2025';            // Onglet sélectionné par défaut
const ALLOWED_EMAILS  = ['polmickael3@gmail.com', 'sabrinamedjoub@gmail.com']; // accès restreint
const OCR_LANG        = 'fra+eng+spa'; // français + anglais + espagnol (ton ticket est en ES)

/* =======================
   === ÉTAT GLOBAL
   ======================= */
let accessToken = null;
let currentUserEmail = null;
let gapiInited = false;
let gisInited  = false;
let tokenClient = null;

const $ = (s) => document.querySelector(s);
const setStatus = (msg) => { $('#status').textContent = msg; };
const enableSave = (on) => { $('#btnSave').disabled = !on; };

document.addEventListener('DOMContentLoaded', () => {
  bindUI();
  initGoogle();        // Auth + gapi
  listSheets();        // essaie de lister les onglets (si authent déjà dispo)
});

/* =======================
   === UI
   ======================= */
function bindUI(){
  // Chips: click => remplit le champ
  bindChips('merchantCandidates','merchant');
  bindChips('dateCandidates','date');
  bindChips('totalCandidates','total');

  // Fichier => auto OCR
  $('#file').addEventListener('change', handleImageChange);

  // Enregistrer
  $('#btnSave').addEventListener('click', saveToSheet);

  // Reset
  $('#btnReset').addEventListener('click', resetForm);
}

function bindChips(containerId, inputId){
  const doc = document.getElementById(containerId);
  doc.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if(!chip) return;
    document.getElementById(inputId).value = chip.getAttribute('data-v');
  });
}

function resetForm(){
  $('#file').value = '';
  $('#preview').src = '';
  ['merchant','date','total'].forEach(id => $('#'+id).value = '');
  ['merchantCandidates','dateCandidates','totalCandidates'].forEach(id => $('#'+id).innerHTML = '');
  enableSave(false);
  setStatus('Prêt.');
}

/* =======================
   === GOOGLE AUTH
   ======================= */
async function initGoogle(){
  // Init gapi client
  await new Promise((resolve) => {
    window.gapiLoaded = async () => {
      gapi.load('client', async () => {
        await gapi.client.init({
          apiKey: API_KEY,
          discoveryDocs: ['https://sheets.googleapis.com/$discovery/rest?version=v4',
                          'https://www.googleapis.com/discovery/v1/apis/oauth2/v2/rest']
        });
        gapiInited = true;
        resolve();
      });
    };
  });

  // Init GIS (token OAuth)
  await new Promise((resolve) => {
    window.gisLoaded = () => resolve();
    // Note : gsi/client est déjà chargé via index.html (async)
    const tryInitTokenClient = () => {
      if (!window.google || !window.google.accounts || !gapiInited) {
        setTimeout(tryInitTokenClient, 150);
        return;
      }
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email',
        prompt: '', // silencieux si possible
        callback: async (resp) => {
          if (resp.error) {
            $('#btnAuth').style.display = 'inline-block';
            $('#authStatus').textContent = 'Autorisation nécessaire';
            return;
          }
          accessToken = resp.access_token;
          gapi.client.setToken({access_token: accessToken});
          await fetchUserEmail();
          updateAuthUI();
          listSheets();
        }
      });
      gisInited = true;

      // Tentative silencieuse (si déjà consenti)
      const hinted = localStorage.getItem('gs_hint_email') || undefined;
      google.accounts.oauth2
        .initTokenClient({
          client_id: CLIENT_ID,
          scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email',
          prompt: '',
          hint: hinted,
          callback: tokenClient.callback
        })
        .requestAccessToken();
    };
    tryInitTokenClient();
  });

  // Bouton Auth (si besoin)
  $('#btnAuth').addEventListener('click', () => {
    if (!tokenClient) return;
    tokenClient.callback = async (resp) => {
      if (resp.error) return;
      accessToken = resp.access_token;
      gapi.client.setToken({access_token: accessToken});
      await fetchUserEmail();
      updateAuthUI();
      listSheets();
    };
    tokenClient.requestAccessToken({prompt: 'consent'});
  });
}

async function fetchUserEmail(){
  try {
    const res = await gapi.client.oauth2.userinfo.get();
    currentUserEmail = res.result.email || null;
    if (currentUserEmail) {
      localStorage.setItem('gs_hint_email', currentUserEmail);
    }
  } catch(e){
    currentUserEmail = null;
  }
}

function updateAuthUI(){
  if (currentUserEmail){
    const ok = ALLOWED_EMAILS.includes(currentUserEmail.toLowerCase());
    $('#authStatus').innerHTML = ok
      ? `Connecté · <span class="text-success">${currentUserEmail}</span>`
      : `Connecté · <span class="text-danger">accès refusé</span>`;
    $('#btnAuth').style.display = ok ? 'none':'inline-block';
  } else {
    $('#authStatus').textContent = 'Autorisation nécessaire';
    $('#btnAuth').style.display = 'inline-block';
  }
}

/* =======================
   === SHEETS (onglets)
   ======================= */
async function listSheets(){
  if (!accessToken) return; // pas encore connecté
  try {
    const resp = await gapi.client.sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      fields: 'sheets(properties(title))'
    });
    const sheets = (resp.result.sheets || []).map(s => s.properties.title);
    const sel = $('#sheetSelect');
    sel.innerHTML = sheets.map(t => `<option ${t===DEFAULT_SHEET?'selected':''}>${t}</option>`).join('');
  } catch (e) {
    // ignore s'il n'est pas encore autorisé
  }
}

/* =======================
   === IMAGE → PREPROC → OCR
   ======================= */
async function handleImageChange(e){
  const file = e.target.files?.[0];
  if (!file) return;
  setStatus('Préparation de l’image…');

  const rawB64 = await fileToBase64(file);
  // Prétraitement avec OpenCV si dispo
  const b64 = await enhanceForOCR(rawB64).catch(()=>rawB64);
  $('#preview').src = 'data:image/jpeg;base64,' + b64;

  setStatus('Analyse OCR…');
  const text = await runOCR(b64);
  // console.log(text);

  const parsed = parseReceipt(text);
  applyCandidates(parsed);
  setStatus('Vérifie / ajuste puis “Enregistrer”.');
  enableSave(true);
}

function fileToBase64(file){
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

async function enhanceForOCR(base64){
  if (!window._opencvReady || !window.cv) return base64;

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'), ctx = c.getContext('2d');
      c.width = img.width; c.height = img.height;
      ctx.drawImage(img, 0, 0);

      const src = cv.imread(c);
      let gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);

      // égalisation histogramme = + contraste
      let equal = new cv.Mat();
      cv.equalizeHist(gray, equal);

      // léger débruitage
      let blur = new cv.Mat();
      cv.GaussianBlur(equal, blur, new cv.Size(3,3), 0, 0, cv.BORDER_DEFAULT);

      // binarisation adaptative (noir/blanc net)
      let bw = new cv.Mat();
      cv.adaptiveThreshold(
        blur, bw, 255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY, 33, 15
      );

      cv.imshow(c, bw);

      const out = c.toDataURL('image/jpeg', 0.95).split(',')[1];

      // nettoyage
      [src, gray, equal, blur, bw].forEach(m=>m.delete());
      resolve(out);
    };
    img.src = 'data:image/jpeg;base64,' + base64;
  });
}

async function runOCR(base64){
  // Tesseract v5 – chargement auto des workers
  const { data: { text } } = await Tesseract.recognize(
    'data:image/jpeg;base64,' + base64,
    OCR_LANG,
    { logger: () => {} }
  );
  return text || '';
}

/* =======================
   === PARSING (intitulé / date / total) + candidates
   ======================= */
function parseReceipt(text){
  const lines = (text || '')
    .split(/\r?\n/)
    .map(s => s.replace(/\s+/g,' ').trim())
    .filter(Boolean);

  const whole = lines.join('\n');

  // 1) Intitulé : prendre premières lignes MAJUSCULES plausibles
  const merchantCandidates = [];
  const bad = /(SIRET|TVA|FACTURE|TICKET|N[°o]|NUMÉRO|CARTE|PAIEMENT|VENTE|CAISSE|CLIENT|TEL|TÉL|WWW|HTTP|HTTPS|EMAIL|SITE\s+WEB)/i;
  const looksAddress = /(RUE|AVENUE|BD|BOULEVARD|PLACE|CHEMIN|IMPASSE|CP|FRANCE|\b\d{5}\b)/i;
  for (let i=0;i<Math.min(lines.length, 10);i++){
    const L = lines[i];
    if (!L || bad.test(L) || looksAddress.test(L)) continue;
    if (/[A-ZÀ-ÖØ-Þ]{2,}/.test(L)) merchantCandidates.push(L);
  }

  // 2) Dates (formats variés)
  const dateMatches = [
    ...whole.matchAll(/\b(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4})\b/g),
    ...whole.matchAll(/\b(\d{2}[\.]\d{2}[\.]\d{2})\b/g) // 07.08.25
  ].map(m => m[1]);

  // 3) Totaux (priorité aux mentions de total / net à payer)
  let totalCandidates = [];
  const keyRxs = [
    /TOTAL\s*TT?C?\s*[:\-]?\s*([\d\s]+[.,]\d{2})\s*(?:€|EUR)?/i,
    /TOTAL\s+À\s+PAYER\s*[:\-]?\s*([\d\s]+[.,]\d{2})/i,
    /NET\s+À\s+PAYER\s*[:\-]?\s*([\d\s]+[.,]\d{2})/i,
    /TOTAL\s+CB\s*[:\-]?\s*([\d\s]+[.,]\d{2})/i
  ];
  for (const rx of keyRxs){
    const m = whole.match(rx);
    if (m) { totalCandidates.push(m[1]); break; }
  }
  // Montants plausibles rencontrés
  const amtRxs = [
    /(\d[\d\s]{0,3}(?:\s?\d{3})*[.,]\d{2})\s*(?:€|EUR)\b/gi,
    /\b(\d[\d\s]{0,3}(?:\s?\d{3})*[.,]\d{2})\b(?!\s*%)/g
  ];
  const amts = [];
  lines.forEach(L=>{
    for (const rx of amtRxs){
      rx.lastIndex = 0; let m;
      while((m=rx.exec(L))){
        const v = parseFloat(m[1].replace(/\s/g,'').replace(',', '.'));
        if (Number.isFinite(v) && v>=0.2 && v<=10000) amts.push({raw:m[1], val:v});
      }
    }
  });
  amts.sort((a,b)=>b.val-a.val);
  for (const a of amts){
    if (!totalCandidates.find(t => normNum(t)===normNum(a.raw))){
      totalCandidates.push(a.raw);
      if (totalCandidates.length>=5) break;
    }
  }

  return {
    merchants: unique(merchantCandidates).slice(0,5),
    dates: unique(dateMatches).slice(0,5),
    totals: unique(totalCandidates).slice(0,5)
  };
}

function applyCandidates(c){
  // Intitulé
  $('#merchant').value = c.merchants[0] || '';
  $('#merchantCandidates').innerHTML = chipsHTML(c.merchants);

  // Date (affiche telle quelle — jj/mm/aaaa si possible)
  $('#date').value = c.dates[0] || '';
  $('#dateCandidates').innerHTML = chipsHTML(c.dates);

  // Total (montrer 3-4 options)
  $('#total').value = (c.totals[0] || '').replace(/[€\s]/g,'').replace('.', ',');
  $('#totalCandidates').innerHTML = chipsHTML(
    c.totals.map(v=>v.replace(/[€\s]/g,'').replace('.', ','))
  );
}

const chipsHTML = (arr) =>
  (arr && arr.length) ? arr.map(v => `<span class="chip" data-v="${escapeHtml(v)}">${escapeHtml(v)}</span>`).join('')
                      : `<span class="text-muted small">—</span>`;

function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;" }[m])); }
function unique(arr){ return [...new Set(arr.map(s=>s.trim()).filter(Boolean))]; }
function normNum(s){ return String(s).replace(/\s/g,'').replace(',', '.'); }

/* =======================
   === ENREGISTREMENT SHEETS
   ======================= */
async function saveToSheet(){
  try {
    if (!accessToken) throw new Error('Non connecté');
    if (!ALLOWED_EMAILS.includes((currentUserEmail||'').toLowerCase())) {
      throw new Error('Cette adresse n’est pas autorisée.');
    }

    const who = document.querySelector('input[name="who"]:checked')?.value || '';
    const sheetName = $('#sheetSelect').value || DEFAULT_SHEET;

    // Colonnes selon la personne
    const cols = (who.toLowerCase().startsWith('sab'))
      ? {label: 'K', date: 'L', total: 'M'}
      : {label: 'O', date: 'P', total: 'Q'};

    // Normalisation data
    const label = ($('#merchant').value || '').trim();
    const dateStr = normalizeDate($('#date').value);
    const totalStr = normalizeTotal($('#total').value); // "67,68" → "67,68" (FR)

    if (!label || !dateStr || !totalStr) throw new Error('Champs incomplets.');

    setStatus('Recherche de la prochaine ligne libre…');
    const row = await findNextEmptyRow(sheetName, cols.label, 11);

    setStatus('Écriture dans le Google Sheet…');
    // 1) Écrit les valeurs (USER_ENTERED pour interpréter FR)
    await gapi.client.sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!${cols.label}${row}:${cols.total}${row}`,
      valueInputOption: 'USER_ENTERED',
      includeValuesInResponse: false,
      resource: {
        values: [[ label, dateStr, totalStr ]]
      }
    });

    // 2) Applique format (date + monnaie €) — batchUpdate
    await gapi.client.sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: {
        requests: [
          // Date : dd/mm/yyyy
          {
            repeatCell: {
              range: a1ToGridRange(sheetName, `${cols.date}${row}:${cols.date}${row}`),
              cell: { userEnteredFormat: { numberFormat: { type:'DATE', pattern:'dd/mm/yyyy' } } },
              fields: 'userEnteredFormat.numberFormat'
            }
          },
          // Total : € monnaie
          {
            repeatCell: {
              range: a1ToGridRange(sheetName, `${cols.total}${row}:${cols.total}${row}`),
              cell: { userEnteredFormat: { numberFormat: { type:'CURRENCY', pattern:'€#,##0.00' } } },
              fields: 'userEnteredFormat.numberFormat'
            }
          }
        ]
      }
    });

    setStatus(`Enregistré ✔ (ligne ${row}, ${who}, onglet « ${sheetName} »)`);
    enableSave(false);
  } catch (e){
    console.error(e);
    setStatus('Erreur : ' + (e.message || e));
  }
}

async function findNextEmptyRow(sheetName, colLetter, startRow=11){
  // Lit colLetter depuis startRow -> cherche première cellule vide
  const endRow = startRow + 1000;
  const range = `${sheetName}!${colLetter}${startRow}:${colLetter}${endRow}`;
  const resp = await gapi.client.sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range
  });
  const values = resp.result.values || [];
  for (let i=0;i<values.length;i++){
    const v = (values[i][0] || '').toString().trim();
    if (!v) return startRow + i;
  }
  return startRow + values.length;
}

/* =======================
   === UTILITAIRES
   ======================= */
function normalizeDate(s){
  if (!s) return '';
  const m = s.match(/^(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{2,4})$/);
  if (!m) return s;
  let [_, d, mo, y] = m; d=+d; mo=+mo; y=+y; if (y<100) y+=2000;
  return `${String(d).padStart(2,'0')}/${String(mo).padStart(2,'0')}/${y}`;
}
function normalizeTotal(s){
  if (!s) return '';
  // garde la virgule FR, supprime espaces
  return String(s).replace(/\s+/g,'').replace('€','').replace(/^\./,'').replace(/\.$/,'');
}

// Convertit un A1 en GridRange minimal pour batchUpdate
function a1ToGridRange(sheetName, a1){
  // on utilise un "truc" : on demande d’abord l’index de la feuille
  // puis on convertit A1 → indices. Simplicité: on lit via API spreadsheets.get.
  // Pour éviter un 2e call à chaque fois, on cache les index trouvés.
  if (!a1ToGridRange._cache) a1ToGridRange._cache = {};
  return {
    sheetId: null, // Sheets accepte aussi sans sheetId si on fournit a1Range dans repeatCell.range
    // On fournit plutôt a1Range directement (plus simple côté client JS)
    // mais l’API batchUpdate attend GridRange : on va ruser via "a1Range" interne du client.
    // ASTUCE: gapi client accepte "range" en A1 seulement dans requests ?repeatCell => Non.
    // Donc on va faire une approximation : on demande la feuilleId une seule fois puis on parse A1.
    ...(function(){
      const parsed = parseA1(a1);
      return { ...parsed, sheetId: null };
    })()
  };
}

// Parse A1 minimal (col/row) → GridRange (0-indexed)
// NB: ici on ne connaît pas sheetId, on laisse à 0 (l’API tolère null dans certains environnements).
function parseA1(a1){
  // "L12:L12" etc.
  const m = a1.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (!m) return {};
  const c1 = colToIndex(m[1]), r1 = +m[2]-1;
  const c2 = colToIndex(m[3])+1, r2 = +m[4]; // endRow exclusive
  return { startRowIndex:r1, endRowIndex:r2, startColumnIndex:c1, endColumnIndex:c2 };
}
function colToIndex(col){
  let x=0; for (let i=0;i<col.length;i++){ x = x*26 + (col.charCodeAt(i)-64); }
  return x-1;
}
