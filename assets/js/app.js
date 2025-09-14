/* =======================
   CONFIG
======================= */
const ALLOWED_EMAILS = ['polmickael3@gmail.com','sabrinamedjoub@gmail.com'].map(e=>e.toLowerCase());
const CLIENT_ID      = '479308590121-qggjv8oum95edeql478aqtit3lcffgv7.apps.googleusercontent.com';
const API_KEY        = 'VOTRE_API_KEY'; // optionnel
const SPREADSHEET_ID = '1OgcxX9FQ4VWmWNKWxTqqmA1v-lmqMWB7LmRZHMq7jZI';
const DEFAULT_SHEET  = 'Août 2025';

// <<< Mets ici l’URL Vercel >>>
const RECEIPT_API_URL = "https://receipt-api-mu.vercel.app/api/parse";

/* ======================= */
let accessToken=null, tokenClient=null, gapiReady=false, gisReady=false, currentUserEmail=null, sheetNameToId={};
const $=s=>document.querySelector(s);
const setStatus=msg=>{const el=$('#status'); if(el) el.textContent=msg; console.log('[Scan]',msg);};
const enableSave=on=>{const b=$('#btnSave'); if(b) b.disabled=!on;};

document.addEventListener('DOMContentLoaded',()=>{ bindUI(); bootGoogle(); });

function bindUI(){
  $('#file')?.addEventListener('change', handleImageChange);
  $('#btnSave')?.addEventListener('click', saveToSheet);
  $('#btnReset')?.addEventListener('click', resetForm);
  $('#btnAuth')?.addEventListener('click', async ()=>{ try{ setStatus('Connexion…'); await ensureConnected(true); await updateAuthUI(); await listSheets(); setStatus('Connecté ✓'); }catch(e){ console.error(e); setStatus('Échec connexion'); }});
  const total=$('#total'); total?.addEventListener('blur',()=>{const n=parseEuroToNumber(total.value); if(n!=null) total.value=n.toFixed(2).replace('.',','); validateCanSave();});
  ['merchant','date'].forEach(id=>$('#'+id)?.addEventListener('input', validateCanSave));
}
function resetForm(){ $('#preview')?.removeAttribute('src'); ['merchant','date','total'].forEach(id=>{const el=$('#'+id); if(el) el.value='';}); enableSave(false); setStatus('Prêt.'); }
function parseEuroToNumber(s){ if(!s) return null; const n=parseFloat(String(s).replace(/\s+/g,'').replace(/[€]/g,'').replace(',','.')); return Number.isFinite(n)?n:null; }
function validateCanSave(){ const label=($('#merchant')?.value||'').trim(); const dateOk=!!$('#date')?.value; const totalOk=parseEuroToNumber($('#total')?.value)!=null; const sheetOk=!!$('#sheetSelect')?.value; enableSave(!!label&&dateOk&&totalOk&&sheetOk); }

/* ==== Google SDK ==== */
async function bootGoogle(){
  await waitFor(()=>typeof gapi!=='undefined',150,10000).catch(()=>{});
  await waitFor(()=>window.google&&google.accounts&&google.accounts.oauth2,150,10000).catch(()=>{});
  if(typeof gapi!=='undefined'){ await new Promise(r=>gapi.load('client',r)); const init={ discoveryDocs:['https://sheets.googleapis.com/$discovery/rest?version=v4','https://www.googleapis.com/discovery/v1/apis/oauth2/v2/rest'] }; if(API_KEY&&!/VOTRE_API_KEY/i.test(API_KEY)) init.apiKey=API_KEY; try{ await gapi.client.init(init); gapiReady=true; }catch(e){ console.error('gapi.init failed:',e); setStatus('Échec init Google API'); return; } }
  if(window.google?.accounts?.oauth2){ tokenClient=google.accounts.oauth2.initTokenClient({ client_id:CLIENT_ID, scope:'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email', prompt:'', callback: async(resp)=>{ if(resp.error){ showAuthNeeded(); return; } accessToken=resp.access_token; gapi.client.setToken({access_token:accessToken}); await updateAuthUI(); await listSheets(); } }); gisReady=true; }
  try{ await ensureConnected(false);}catch(_){}
  await updateAuthUI(); await listSheets();
}
function showAuthNeeded(){ $('#btnAuth').style.display='inline-block'; $('#authStatus').textContent='Autorisation nécessaire'; }
async function ensureConnected(forceConsent=false){ if(!gapiReady||!gisReady) throw new Error('SDK Google non initialisés'); if(accessToken) return; await new Promise((resolve,reject)=>{ tokenClient.callback=(resp)=>{ if(resp?.error) return reject(resp); accessToken=resp.access_token; gapi.client.setToken({access_token:accessToken}); resolve(); }; tokenClient.requestAccessToken({prompt:forceConsent?'consent':''}); }); }
async function updateAuthUI(){ try{ if(!accessToken){ showAuthNeeded(); return; } const me=await gapi.client.oauth2.userinfo.get(); currentUserEmail=(me.result?.email||'').toLowerCase(); if(!currentUserEmail){ showAuthNeeded(); return; } const ok=ALLOWED_EMAILS.includes(currentUserEmail); $('#authStatus').innerHTML= ok?`Connecté · <span class="text-success">${currentUserEmail}</span>`:`Connecté · <span class="text-danger">accès refusé</span>`; $('#btnAuth').style.display= ok?'none':'inline-block'; }catch(e){ console.warn(e); showAuthNeeded(); } }
async function listSheets(){ if(!accessToken) return; try{ const resp=await gapi.client.sheets.spreadsheets.get({ spreadsheetId:SPREADSHEET_ID, fields:'sheets(properties(sheetId,title,index))' }); const props=(resp.result.sheets||[]).map(s=>s.properties); sheetNameToId={}; const sel=$('#sheetSelect'); sel.innerHTML=props.sort((a,b)=>a.index-b.index).map(p=>{ sheetNameToId[p.title]=p.sheetId; return `<option>${p.title}</option>`; }).join(''); let pre=props.find(p=>p.title===DEFAULT_SHEET)||props.at(-1); if(pre) sel.value=pre.title; }catch(e){ console.warn('listSheets:',e); setStatus('Impossible de lister les feuilles.'); } }
function waitFor(test,every=100,timeout=10000){ return new Promise((resolve,reject)=>{ const t0=Date.now(); (function loop(){ try{ if(test()) return resolve(); }catch(_){} if(Date.now()-t0>timeout) return reject(new Error('waitFor timeout')); setTimeout(loop,every); })(); }); }

/* ==== Scan + API ==== */
async function handleImageChange(e){
  const file=e.target.files?.[0]; if(!file) return; enableSave(false); setStatus('Chargement de la photo…');
  try{
    const img=await fileToImage(file);
    setStatus('Détection et redressement…');
    let scannedCanvas;
    try{
      if(typeof jscanify==='undefined') throw new Error('jscanify non chargé');
      const base=drawImageFit(img,1400);
      const scanner=new jscanify();
      scannedCanvas=scanner.extractPaper(base, base.width, base.height) || base;
    }catch(err){
      console.warn('jscanify failed, fallback original:',err);
      scannedCanvas=drawImageFit(img,1400);
    }
    $('#preview').src=scannedCanvas.toDataURL('image/jpeg',0.9);

    setStatus('Analyse du ticket…');
    const b64=canvasToBase64Jpeg(scannedCanvas,0.9);
    const parsed=await parseReceiptViaAPI(b64);
    applyParsedToForm(parsed);
    setStatus('Reconnaissance OK. Vérifie puis “Enregistrer”.');
  }catch(e2){
    console.error(e2);
    setStatus('Analyse indisponible — corrige manuellement puis enregistre.');
  }
}
function drawImageFit(img,max=1400){ const r=Math.min(max/img.naturalWidth,max/img.naturalHeight,1); const w=Math.round(img.naturalWidth*r), h=Math.round(img.naturalHeight*r); const c=document.createElement('canvas'); c.width=w; c.height=h; c.getContext('2d').drawImage(img,0,0,w,h); return c; }
function fileToImage(file){ return new Promise((resolve,reject)=>{ const img=new Image(); img.onload=()=>resolve(img); img.onerror=reject; img.src=URL.createObjectURL(file); }); }
function canvasToBase64Jpeg(canvas,q=0.9){ return canvas.toDataURL('image/jpeg',q).split(',')[1]; }
async function parseReceiptViaAPI(imageBase64){
  const resp = await fetch(RECEIPT_API_URL, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ imageBase64 })
  });
  const json = await resp.json().catch(()=> ({}));
  if (!resp.ok || json.error) {
    const msg = typeof json.error === 'object' ? JSON.stringify(json.error) : (json.error || `HTTP ${resp.status}`);
    throw new Error(msg);
  }
  return json; // { supplier, dateISO, total, items }
}
function applyParsedToForm(p){
  if(p.supplier) $('#merchant').value=p.supplier;
  if(p.dateISO)  $('#date').value=p.dateISO; // input type="date"
  if(p.total!=null) $('#total').value=Number(p.total).toFixed(2).replace('.',',');
  validateCanSave();
}

/* ==== Save to Google Sheets ==== */
async function saveToSheet(){
  try{
    await ensureConnected(false);
    const me=await gapi.client.oauth2.userinfo.get();
    const email=(me.result?.email||'').toLowerCase();
    if(!ALLOWED_EMAILS.includes(email)) throw new Error('Adresse non autorisée');

    const who=document.querySelector('input[name="who"]:checked')?.value||'';
    const sheetName=$('#sheetSelect').value||DEFAULT_SHEET;
    const cols=(who.toLowerCase().startsWith('sab'))?{label:'K',date:'L',total:'M'}:{label:'O',date:'P',total:'Q'};

    const label=($('#merchant').value||'').trim();
    const dateISO=$('#date').value;
    const dateStr=isoToDDMMYYYY(dateISO);
    const totalNum=parseEuroToNumber($('#total').value);
    if(!label||!dateStr||totalNum==null) throw new Error('Champs incomplets');

    setStatus('Recherche de la prochaine ligne libre…');
    const row=await findNextEmptyRow(sheetName, cols.label, 11);

    setStatus('Écriture…');
    await gapi.client.sheets.spreadsheets.values.update({
      spreadsheetId:SPREADSHEET_ID,
      range:`${sheetName}!${cols.label}${row}:${cols.total}${row}`,
      valueInputOption:'USER_ENTERED',
      resource:{ values:[[label, dateStr, totalNum]] }
    });

    const sid=sheetNameToId[sheetName];
    if(sid!=null){
      await gapi.client.sheets.spreadsheets.batchUpdate({
        spreadsheetId:SPREADSHEET_ID,
        resource:{ requests:[
          { repeatCell:{ range:gridRangeFromA1(sid,`${cols.date}${row}:${cols.date}${row}`), cell:{ userEnteredFormat:{ numberFormat:{ type:'DATE', pattern:'dd/mm/yyyy' } } }, fields:'userEnteredFormat.numberFormat' } },
          { repeatCell:{ range:gridRangeFromA1(sid,`${cols.total}${row}:${cols.total}${row}`), cell:{ userEnteredFormat:{ numberFormat:{ type:'NUMBER', pattern:'#,##0.00 "€"' } } }, fields:'userEnteredFormat.numberFormat' } }
        ] }
      });
    }

    setStatus(`Enregistré ✔ (ligne ${row}, ${who}, onglet « ${sheetName} »)`);
    enableSave(false);
  }catch(e){ console.error(e); setStatus('Erreur : '+(e.message||e)); }
}
function isoToDDMMYYYY(iso){ const m=String(iso||'').match(/^(\d{4})-(\d{2})-(\d{2})$/); if(!m) return ''; return `${m[3]}/${m[2]}/${m[1]}`; }
async function findNextEmptyRow(sheetName,colLetter,startRow=11){
  const endRow=startRow+1000;
  const range=`${sheetName}!${colLetter}${startRow}:${colLetter}${endRow}`;
  const resp=await gapi.client.sheets.spreadsheets.values.get({ spreadsheetId:SPREADSHEET_ID, range });
  const values=resp.result.values||[];
  for(let i=0;i<values.length;i++){ const v=(values[i][0]||'').toString().trim(); if(!v) return startRow+i; }
  return startRow+values.length;
}
function gridRangeFromA1(sheetId,a1){
  const m=a1.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i); if(!m) throw new Error('A1 invalide: '+a1);
  const c1=colToIndex(m[1]), r1=+m[2]-1, c2=colToIndex(m[3])+1, r2=+m[4];
  return { sheetId, startRowIndex:r1, endRowIndex:r2, startColumnIndex:c1, endColumnIndex:c2 };
}
function colToIndex(col){ let x=0; for(let i=0;i<col.length;i++){ x=x*26+(col.charCodeAt(i)-64); } return x-1; }
