/***********************
 * CONFIG GOOGLE
 ***********************/
const SCRIPT_ID = '1dkuTGVPxWwq5Ib6EK2iLsJt9HjjH1ll1iMbMB8-ebSEUiUsLmsNqNCGh';   // ID du projet Apps Script
const CLIENT_ID = '479308590121-qggjv8oum95edeql478aqtit3lcffgv7.apps.googleusercontent.com';   // ID client OAuth (Application Web)
const SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/script.projects',
  'https://www.googleapis.com/auth/script.external_request',
  'https://www.googleapis.com/auth/spreadsheets'
];

const $ = s => document.querySelector(s);
function setStatus(m){ $('#status').textContent = m; }
function enableSave(on){ $('#btnSave').disabled = !on; }

/***********************
 * AUTH silencieuse (hint mémorisé)
 ***********************/
let tokenClient, accessToken=null, tokenExpiry=0, refreshTimer=null;

window.gapiLoaded = function(){
  gapi.load('client', async ()=>{
    await gapi.client.init({});
    initGIS(localStorage.getItem('ticketScanner_email') || null);
    // login silencieux (si déjà consenti)
    try { tokenClient.requestAccessToken({ prompt: '' }); } catch(_) {}
  });
};

function initGIS(loginHint){
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES.join(' '),
    hint: loginHint || undefined,      // << empêche l’account chooser quand on a déjà choisi un compte
    callback: async (t)=>{
      if (!t || !t.access_token) {
        $('#btnAuth').classList.remove('d-none');
        setStatus('Connexion requise.');
        return;
      }
      accessToken = t.access_token;
      tokenExpiry = Date.now() + (Math.max(300, (t.expires_in || 3600)) * 1000);
      gapi.client.setToken({ access_token: accessToken });
      $('#authStatus').textContent = 'Connecté ✔';
      $('#btnAuth').classList.add('d-none');

      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(()=>tokenClient.requestAccessToken({ prompt: '' }), Math.max(60_000, (t.expires_in-300)*1000));

      const me = await whoAmI().catch(()=>null);
      if (me?.email) localStorage.setItem('ticketScanner_email', me.email);

      refreshSheetList();
    }
  });
  $('#btnAuth').onclick = ()=> tokenClient.requestAccessToken({ prompt:'consent' });
}

async function exec(fn, parameters){
  if (!accessToken || Date.now() > (tokenExpiry - 60_000)) {
    await new Promise(resolve => {
      const prev = tokenClient.callback;
      tokenClient.callback = (...a)=>{ tokenClient.callback = prev || (()=>{}); resolve(); };
      tokenClient.requestAccessToken({ prompt: '' });
    });
  }
  const resp = await gapi.client.request({
    path: `https://script.googleapis.com/v1/scripts/${SCRIPT_ID}:run`,
    method: 'POST',
    body: { function: fn, parameters }
  });
  const result = resp.result;
  if (result.error) {
    const det = result.error.details && result.error.details[0];
    throw new Error(det?.errorMessage || JSON.stringify(result.error));
  }
  return result.response.result;
}
async function whoAmI(){ try{ return await exec('whoAmI', []); }catch(e){ return null; } }
async function refreshSheetList(){
  try{
    const r = await exec('getSheets', []);
    if (!r?.ok) throw new Error(r?.error || 'getSheets failed');
    const sel = $('#sheetSelect');
    sel.innerHTML = r.names.map(n=>`<option ${n===r.defaultName?'selected':''}>${n}</option>`).join('');
  }catch(e){ setStatus('Erreur liste onglets : '+e.message); }
}

/***********************
 * OCR AUTO + prétraitement
 ***********************/
let lastImageBase64 = null;

$('#file').addEventListener('change', async (e)=>{
  const f = e.target.files?.[0]; if (!f) return;
  setStatus('Préparation de l’image…');
  const raw = await fileToBase64(f);
  lastImageBase64 = await enhanceForOCR(raw);
  $('#preview').src = 'data:image/jpeg;base64,'+lastImageBase64;
  runAnalyze(); // << AUTOMATIQUE
});

function chipBtn(v){ return `<span class="chip" data-v="${v}">${v}</span>`; }
function chips(containerId, arr){
  const el = document.getElementById(containerId);
  el.innerHTML = (arr && arr.length) ? arr.map(chipBtn).join('') : '';
  el.onclick = (ev)=>{
    const b = ev.target.closest('.chip'); if (!b) return;
    const v = b.getAttribute('data-v');
    if (containerId==='merchantCandidates') $('#merchant').value = v;
    if (containerId==='dateCandidates')     $('#date').value = v;
    if (containerId==='totalCandidates')    $('#total').value = v;
  };
}

async function runAnalyze(){
  try{
    if (!lastImageBase64) throw new Error('Aucune image');
    setStatus('Analyse (OCR)…'); enableSave(false);

    const { data } = await Tesseract.recognize('data:image/jpeg;base64,'+lastImageBase64, 'fra+eng');
    const text = data?.text || '';
    const parsed = parseReceipt(text);

    $('#merchant').value = parsed.enseigne || '';
    $('#date').value     = parsed.date || '';
    $('#total').value    = (parsed.total||'').replace(/[€\s]/g,'').replace('.',',');

    chips('merchantCandidates', parsed.candidates.merchants);
    chips('dateCandidates',     parsed.candidates.dates);
    chips('totalCandidates',    parsed.candidates.totals.map(x=>x.replace('.',',')));

    enableSave(true);
    setStatus('Vérifie/ajuste puis “Enregistrer”.');
  }catch(e){ console.error(e); setStatus('Erreur OCR : '+(e.message||e)); }
}

/***********************
 * SAUVEGARDE
 ***********************/
$('#btnSave').addEventListener('click', async ()=>{
  try{
    const who = (document.querySelector('input[name="who"]:checked')?.value || '').trim();
    const payload = {
      who,
      sheetName: $('#sheetSelect').value,
      enseigne: $('#merchant').value,
      date:     $('#date').value,
      total:    $('#total').value
    };
    setStatus('Enregistrement…');
    const r = await exec('saveToSheet', [payload]);
    if (!r?.ok) throw new Error(r?.error || 'saveToSheet failed');
    setStatus(`Enregistré ✔ (ligne ${r.row}, ${r.who}, onglet « ${payload.sheetName} »)`);
    enableSave(false);
  }catch(e){ setStatus('Erreur enregistrement : '+(e.message||e)); }
});

$('#btnReset').addEventListener('click', ()=>{
  lastImageBase64=null; $('#file').value=''; $('#preview').src='';
  ['merchant','date','total'].forEach(id=> $('#'+id).value='');
  ['merchantCandidates','dateCandidates','totalCandidates'].forEach(id=> $('#'+id).innerHTML='');
  enableSave(false); setStatus('Prêt.');
});

/***********************
 * Helpers: OCR prep + parsing
 ***********************/
function fileToBase64(file){
  return new Promise((res,rej)=>{
    const r=new FileReader(); r.onload=()=>res(r.result.split(',')[1]); r.onerror=rej; r.readAsDataURL(file);
  });
}
async function enhanceForOCR(base64){
  return new Promise(resolve=>{
    const img=new Image();
    img.onload=()=>{
      const c=document.createElement('canvas'), ctx=c.getContext('2d');
      c.width=img.width; c.height=img.height; ctx.drawImage(img,0,0);
      let d=ctx.getImageData(0,0,c.width,c.height);
      for (let i=0;i<d.data.length;i+=4){
        const y=0.299*d.data[i]+0.587*d.data[i+1]+0.114*d.data[i+2];
        d.data[i]=d.data[i+1]=d.data[i+2]=y;
      }
      ctx.putImageData(d,0,0);
      d=ctx.getImageData(0,0,c.width,c.height);
      const contrast=1.35, brightness=8;
      for (let i=0;i<d.data.length;i+=4){
        let v=d.data[i]*contrast+brightness; v=Math.max(0,Math.min(255,v));
        d.data[i]=d.data[i+1]=d.data[i+2]=v;
      }
      ctx.putImageData(d,0,0);
      d=ctx.getImageData(0,0,c.width,c.height);
      const thr=otsu(d.data);
      for (let i=0;i<d.data.length;i+=4){
        const v=d.data[i]<thr?0:255;
        d.data[i]=d.data[i+1]=d.data[i+2]=v;
      }
      ctx.putImageData(d,0,0);
      const out=c.toDataURL('image/jpeg',0.95).split(',')[1];
      resolve(out);
    };
    img.src='data:image/jpeg;base64,'+base64;
  });
}
function otsu(arr){
  const hist=new Array(256).fill(0);
  for (let i=0;i<arr.length;i+=4) hist[arr[i]|0]++;
  const total=arr.length/4;
  let sum=0; for (let i=0;i<256;i++) sum+=i*hist[i];
  let sumB=0,wB=0,maxVar=0,thr=127;
  for (let t=0;t<256;t++){
    wB+=hist[t]; if(!wB)continue;
    const wF=total-wB; if(!wF)break;
    sumB+=t*hist[t];
    const mB=sumB/wB, mF=(sum-sumB)/wF;
    const between=wB*wF*(mB-mF)*(mB-mF);
    if (between>maxVar){ maxVar=between; thr=t; }
  }
  return thr;
}

/* Parsing avec candidats */
function parseReceipt(text){
  const lines = String(text||'').split(/\r?\n/).map(s=>s.replace(/\s+/g,' ').trim()).filter(Boolean);
  const whole = lines.join('\n');

  const badMerchant = /SIRET|TVA|FACTURE|TICKET|N[°o]|NUMÉRO|CARTE|PAIEMENT|VENTE|CAISSE|CLIENT|TEL|TÉL|WWW|HTTP|HTTPS|EMAIL|SITE\s+WEB/i;
  const looksAddress = /(RUE|AVENUE|BD|BOULEVARD|PLACE|CHEMIN|IMPASSE|FRANCE|\b\d{5}\b)/i;
  const knownMerchants = /(ASF|VINCI|CARREFOUR|LECLERC|E\.?LECLERC|INTERMARCHÉ|AUCHAN|LIDL|MONOPRIX|CASINO|ALDI|DECATHLON|ACTION|FNAC|DARTY|BOULANGER|PICARD|BIOCOOP|U\s?SUPER|SUPER\s?U|HYPER\s?U|TOTAL(?:\s?ENERGIES)?|SHELL|MC\s?DONALD|BURGER\s?KING|KFC|DOMINO'?S|PRIMARK|ZARA|IKEA|H&M)/i;

  const merchants=[];
  for (let i=0;i<Math.min(lines.length,18);i++){
    const L=lines[i]; if (!L || badMerchant.test(L) || looksAddress.test(L)) continue;
    const sigle=L.match(/^\b([A-ZÀ-ÖØ-Þ]{2,8})(?=[\s\-\.]|$)/);
    if (sigle && sigle[1]) merchants.unshift(sigle[1]);
    if (knownMerchants.test(L)) merchants.unshift(L);
    else if (/[A-Za-zÀ-ÖØ-öø-ÿ]{3,}/.test(L)) merchants.push(L);
  }
  const enseigne = merchants[0] || '';
  const merchantCandidates = dedup(merchants).slice(0,6);

  const dateMatches = [...whole.matchAll(/\b(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})\b/g)].map(m=>m[1]);
  const date = dateMatches[0] || '';
  const dateCandidates = dedup(dateMatches).slice(0,6);

  const totalKeyRxs=[
    /TOTAL\s*TT?C?\s*[:\-]?\s*([\d\s]+[.,]\d{2})\s*(?:€|EUR)?/i,
    /TOTAL\s+À\s+PAYER\s*[:\-]?\s*([\d\s]+[.,]\d{2})\s*(?:€|EUR)?/i,
    /NET\s+À\s+PAYER\s*[:\-]?\s*([\d\s]+[.,]\d{2})\s*(?:€|EUR)?/i,
    /TOTAL\s+CB\s*[:\-]?\s*([\d\s]+[.,]\d{2})\s*(?:€|EUR)?/i,
    /MONTANT\s*(?:CB|TTC)?\s*[:\-]?\s*([\d\s]+[.,]\d{2})\s*(?:€|EUR)?/i
  ];
  let total='';
  for (const rx of totalKeyRxs){ const m=whole.match(rx); if (m){ total=m[1]; break; } }

  const labelBad=/(TVA|TAXE|REMISE|REDUC|RÉDUCTION|ECOTAXE|SOUS\-TOTAL|SUBTOTAL)/i;
  const amountRxs=[
    /(\d[\d\s]{0,3}(?:\s?\d{3})*[.,]\d{2})\s*(?:€|EUR)\b/gi,
    /\b(\d[\d\s]{0,3}(?:\s?\d{3})*[.,]\d{2})\b(?!\s*%)/g
  ];
  const amounts=[];
  lines.forEach(L=>{
    if (labelBad.test(L)) return;
    for (const rx of amountRxs){
      rx.lastIndex=0; let m;
      while ((m=rx.exec(L))){
        const val=parseFloat(String(m[1]).replace(/\s/g,'').replace(',','.'));
        if (Number.isFinite(val) && val>=0.2 && val<=10000) amounts.push({val,raw:m[1]});
      }
    }
  });
  amounts.sort((a,b)=>b.val-a.val);
  const totalCands=[];
  if (total) totalCands.push(total);
  for (const a of amounts){
    const key=a.raw.replace(/\s/g,'').replace(',','.');
    if (!totalCands.some(t=>t.replace(/\s/g,'').replace(',','.')===key)) totalCands.push(a.raw);
    if (totalCands.length>=6) break;
  }
  if (!total) total = totalCands[0] || '';

  return {
    enseigne, date, total,
    candidates:{
      merchants: merchantCandidates,
      dates: dateCandidates,
      totals: totalCands
    }
  };
}
function dedup(arr){
  const seen=new Set(), out=[];
  arr.forEach(v=>{
    const k=String(v).toLowerCase().trim();
    if (!seen.has(k)){ seen.add(k); out.push(v); }
  });
  return out;
}
