/* ========= CONFIG ========= */
// Change via console sans rebuild : localStorage.setItem('RECEIPT_API_URL', 'https://…render.com')
const RECEIPT_API_URL = localStorage.getItem('RECEIPT_API_URL') || 'http://localhost:8080/index.php';
const ALLOWED_EMAILS = ['polmickael3@gmail.com','sabrinamedjoub@gmail.com'].map(e=>e.toLowerCase());
const CLIENT_ID      = '479308590121-qggjv8oum95edeql478aqtit3lcffgv7.apps.googleusercontent.com';
const SPREADSHEET_ID = '1OgcxX9FQ4VWmWNKWxTqqmA1v-lmqMWB7LmRZHMq7jZI';
const DEFAULT_SHEET  = 'Août 2025';

// Colonnes selon la personne
const COLUMNS_BY_PERSON = {
  'Sabrina': { label:'K', date:'L', total:'M' },
  'Mickael': { label:'O', date:'P', total:'Q' }
};
// Fallback si pas de sélection
const DEFAULT_COLUMNS = { label:'A', date:'B', total:'C' };

/* ========= STATE ========= */
let accessToken=null, tokenClient=null, gapiReady=false, gisReady=false, currentUserEmail=null, sheetNameToId={};
const $=s=>document.querySelector(s);
const setStatus=msg=>{ const el=$('#status'); if(el) el.textContent=msg; console.log('[Scan]',msg); };
const enableSave=on=>{ const b=$('#btnSave'); if(b) b.disabled=!on; };

document.addEventListener('DOMContentLoaded', ()=>{ bindUI(); bootGoogle(); });

function bindUI(){
  $('#file')?.addEventListener('change', onImagePicked);
  $('#btnSave')?.addEventListener('click', saveToSheet);
  $('#btnAuth')?.addEventListener('click', async ()=>{
    try{ setStatus('Connexion…'); await ensureConnected(true); await updateAuthUI(); await listSheets(); setStatus('Connecté ✓'); }
    catch(e){ console.error(e); setStatus('Échec connexion'); }
  });

  $('#total')?.addEventListener('blur', ()=>{
    const n = parseEuroToNumber($('#total').value);
    if(n!=null) $('#total').value = n.toFixed(2).replace('.',',');
    validateCanSave();
  });
  ['merchant','date','total'].forEach(id=>$('#'+id)?.addEventListener('input', validateCanSave));
}

function resetForm(){
  ['merchant','date','total'].forEach(id=>{ const el=$('#'+id); if(el) el.value=''; });
  enableSave(false); setStatus('Prêt.');
}
function parseEuroToNumber(s){
  if(!s) return null;
  const n=parseFloat(String(s).replace(/\s+/g,'').replace(/[€]/g,'').replace(',','.'));
  return Number.isFinite(n)?n:null;
}
function isoToDDMMYYYY(iso){
  const m=String(iso||'').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m?`${m[3]}/${m[2]}/${m[1]}`:'';
}
function validateCanSave(){
  const label=($('#merchant')?.value||'').trim();
  const dateOk=!!$('#date')?.value;
  const totalOk=parseEuroToNumber($('#total')?.value)!=null;
  const sheetOk=!!$('#sheetSelect')?.value;
  enableSave(!!label && dateOk && totalOk && sheetOk && !!currentUserEmail);
}

/* ========= Google (GIS + gapi) ========= */
async function bootGoogle(){
  await waitFor(()=>typeof gapi!=='undefined',150,10000).catch(()=>{});
  await waitFor(()=>window.google?.accounts?.oauth2,150,10000).catch(()=>{});

  // gapi client (Sheets + OAuth2 discovery)
  if (typeof gapi !== 'undefined') {
    await new Promise(r => gapi.load('client', r));
    await gapi.client.init({
      discoveryDocs: [
        'https://sheets.googleapis.com/$discovery/rest?version=v4',
        'https://www.googleapis.com/discovery/v1/apis/oauth2/v2/rest'
      ]
    });
    gapiReady = true; // ← important
  }

  // Google Identity Services (OAuth token)
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
    gisReady = true; // ← important
  }

  // Ne tente la connexion/liste que si les deux sont prêts
  if (gapiReady && gisReady) {
    try { await ensureConnected(false); } catch(_) {}
    await updateAuthUI();
    await listSheets();
  }
}
function showAuthNeeded(){ const b=$('#btnAuth'); if(b) b.style.display='inline-block'; const s=$('#authStatus'); if(s) s.textContent='Autorisation nécessaire'; }
async function ensureConnected(forceConsent=false){
  if(!gapiReady||!gisReady) throw new Error('SDK Google non init');
  if(accessToken) return;
  await new Promise((resolve,reject)=>{
    tokenClient.callback=(resp)=>{
      if(resp?.error) return reject(resp);
      accessToken=resp.access_token; gapi.client.setToken({access_token:accessToken});
      resolve();
    };
    tokenClient.requestAccessToken({prompt: forceConsent ? 'consent' : ''});
  });
}
async function updateAuthUI(){
  try{
    if(!accessToken){ showAuthNeeded(); return; }
    const me=await gapi.client.oauth2.userinfo.get();
    currentUserEmail=(me.result?.email||'').toLowerCase();
    if(!currentUserEmail){ showAuthNeeded(); return; }
    const el=$('#authStatus');
    if(el) el.innerHTML = `Connecté · <span class="text-success">${currentUserEmail}</span>`;
    const b=$('#btnAuth'); if(b) b.style.display='none';
    validateCanSave();
  }catch(e){ console.warn(e); showAuthNeeded(); }
}
async function listSheets(){
  if(!accessToken) return;
  try{
    const resp=await gapi.client.sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID,
      fields: 'sheets(properties(sheetId,title,index))'
    });
    const props=(resp.result.sheets||[]).map(s=>s.properties).sort((a,b)=>a.index-b.index);
    sheetNameToId={};
    const sel=$('#sheetSelect'); if(!sel) return;
    sel.innerHTML = props.map(p => { sheetNameToId[p.title]=p.sheetId; return `<option>${p.title}</option>`; }).join('');
    const pre = props.find(p=>p.title===DEFAULT_SHEET) || props.at(-1);
    if(pre) sel.value=pre.title;
    validateCanSave();
  }catch(e){ console.warn('listSheets:',e); setStatus('Impossible de lister les feuilles.'); }
}
function waitFor(test,every=100,timeout=10000){
  return new Promise((resolve,reject)=>{
    const t0=Date.now(); (function loop(){ try{ if(test()) return resolve(); }catch(_){}
      if(Date.now()-t0>timeout) return reject(new Error('waitFor timeout')); setTimeout(loop,every); })();
  });
}

/* ========= Image → backend ========= */
async function onImagePicked(e){
  const file = e.target.files?.[0];
  if(!file) return;
  enableSave(false); setStatus('Analyse du ticket…');

  try{
    const b64 = await fileToBase64NoPrefix(file);
    const parsed = await callBackend(b64); // {ok, supplier, dateISO, total}
    if(parsed.supplier) $('#merchant').value = parsed.supplier;
    if(parsed.dateISO)  $('#date').value     = parsed.dateISO;
    if(parsed.total!=null) $('#total').value = Number(parsed.total).toFixed(2).replace('.',',');
    setStatus('Reconnaissance OK. Vérifie puis « Enregistrer ».');
  }catch(err){
    console.error(err); setStatus('Analyse indisponible — complète manuellement.');
  }finally{ validateCanSave(); }
}
function fileToBase64NoPrefix(file){
  return new Promise((resolve,reject)=>{
    const r=new FileReader();
    r.onload=()=>{ const s=String(r.result||''); resolve(s.includes(',')?s.split(',')[1]:s); };
    r.onerror=reject; r.readAsDataURL(file);
  });
}
async function callBackend(imageBase64){
  if(!accessToken) await ensureConnected(false);
  const resp = await fetch(RECEIPT_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Send token Google pour vérification côté back
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({ imageBase64 })
  });
  const text = await resp.text(); let json={}; try{ json=JSON.parse(text); }catch{}
  if(!resp.ok || json.ok===false){
    const msg = json.error ? (typeof json.error==='string'?json.error:JSON.stringify(json.error)) : `HTTP ${resp.status}`;
    throw new Error(msg);
  }
  return json;
}

/* ========= Écriture Sheets ========= */
async function saveToSheet(){
  try{
    await ensureConnected(false);
    const sheetName = $('#sheetSelect')?.value || DEFAULT_SHEET;

    let cols = {...DEFAULT_COLUMNS};
    const who = document.querySelector('input[name="who"]:checked')?.value;
    if (who && COLUMNS_BY_PERSON[who]) cols = COLUMNS_BY_PERSON[who];

    const label = ($('#merchant').value||'').trim();
    const dateISO = $('#date').value;
    const dateStr = isoToDDMMYYYY(dateISO);
    const totalNum = parseEuroToNumber($('#total').value);
    if(!label || !dateStr || totalNum==null) throw new Error('Champs incomplets');

    setStatus('Recherche de la prochaine ligne libre…');
    const row = await findNextEmptyRow(sheetName, cols.label, 2);

    setStatus('Écriture…');
    await gapi.client.sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!${cols.label}${row}:${cols.total}${row}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[label, dateStr, totalNum]] }
    });

    const sid = sheetNameToId[sheetName];
    if (sid!=null) {
      await gapi.client.sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: { requests: [
          { repeatCell:{ range:gridRangeFromA1(sid,`${cols.date}${row}:${cols.date}${row}`),
            cell:{ userEnteredFormat:{ numberFormat:{ type:'DATE', pattern:'dd/mm/yyyy' } } },
            fields:'userEnteredFormat.numberFormat' } },
          { repeatCell:{ range:gridRangeFromA1(sid,`${cols.total}${row}:${cols.total}${row}`),
            cell:{ userEnteredFormat:{ numberFormat:{ type:'NUMBER', pattern:'#,##0.00 "€"' } } },
            fields:'userEnteredFormat.numberFormat' } }
        ] }
      });
    }

    setStatus(`Enregistré ✔ (ligne ${row}${who?`, ${who}`:''}, onglet « ${sheetName} »)`);
    enableSave(false);
  }catch(e){ console.error(e); setStatus('Erreur : '+(e.message||e)); }
}
async function findNextEmptyRow(sheet, col, startRow=2){
  const endRow=startRow+1000;
  const range=`${sheet}!${col}${startRow}:${col}${endRow}`;
  const resp=await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId:SPREADSHEET_ID, range });
  const values=resp.result.values||[];
  for(let i=0;i<values.length;i++){
    const v=(values[i][0]||'').toString().trim();
    if(!v) return startRow+i;
  }
  return startRow+values.length;
}
function gridRangeFromA1(sheetId,a1){
  const m=a1.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i); if(!m) throw new Error('A1 invalide: '+a1);
  const c1=colToIndex(m[1]), r1=+m[2]-1, c2=colToIndex(m[3])+1, r2=+m[4];
  return { sheetId, startRowIndex:r1, endRowIndex:r2, startColumnIndex:c1, endColumnIndex:c2 };
}
function colToIndex(col){ let x=0; for(let i=0;i<col.length;i++){ x=x*26+(col.charCodeAt(i)-64); } return x-1; }
