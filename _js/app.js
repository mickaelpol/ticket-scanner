/* ========= CONFIG À REMPLACER ========= */
const SCRIPT_ID = '1dkuTGVPxWwq5Ib6EK2iLsJt9HjjH1ll1iMbMB8-ebSEUiUsLmsNqNCGh';   // ID du projet Apps Script
const CLIENT_ID = '479308590121-qggjv8oum95edeql478aqtit3lcffgv7.apps.googleusercontent.com';   // ID client OAuth (Application Web)
const SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/userinfo.email'
];
/* ===================================== */

let tokenClient;
let accessToken = null;
let tokenExpiry = 0;
let refreshTimer = null;

let base64Image = null;
const $ = s => document.querySelector(s);

/* ===== gapi (Apps Script discovery) ===== */
function gapiLoaded() {
    gapi.load('client', async () => {
        await gapi.client.init({
            discoveryDocs: ['https://script.googleapis.com/$discovery/rest?version=v1']
        });
    });
}

/* ===== Auth silencieuse (GIS) ===== */
function initGIS(loginHint = null) {
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES.join(' '),
        hint: loginHint || undefined,
        callback: (t) => {
            if (!t || !t.access_token) {
                showAuthButton(true);
                setStatus('Connexion requise.');
                return;
            }
            accessToken = t.access_token;
            tokenExpiry = Date.now() + (Math.max(300, (t.expires_in || 3600)) * 1000);
            gapi.client.setToken({access_token: accessToken});
            $('#authStatus').textContent = 'Connecté ✔';
            setStatus('Connecté ✔');
            showAuthButton(false);

            // refresh automatique 5 min avant expiration
            if (refreshTimer) clearTimeout(refreshTimer);
            const delay = Math.max(60_000, (t.expires_in - 300) * 1000);
            refreshTimer = setTimeout(silentRefresh, delay);

            // mémoriser l'email (hint) et charger les onglets
            whoAmI().then(email => {
                if (email) localStorage.setItem('ticketScanner_email', email);
            });
            refreshSheetList();
        }
    });
}

function silentSignin() {
    initGIS(localStorage.getItem('ticketScanner_email'));
    tokenClient.requestAccessToken({prompt: ''});
}

function interactiveSignin() {
    initGIS(localStorage.getItem('ticketScanner_email'));
    tokenClient.requestAccessToken({prompt: 'consent'});
}

function silentRefresh() {
    if (!tokenClient) initGIS(localStorage.getItem('ticketScanner_email'));
    tokenClient.requestAccessToken({prompt: ''});
}

function showAuthButton(show) {
    const b = $('#btnAuth');
    if (b) b.style.display = show ? '' : 'none';
}

/* ===== Execution API wrapper ===== */
async function exec(fn, params) {
    // token valable ?
    if (!accessToken || Date.now() > (tokenExpiry - 60_000)) {
        await new Promise(resolve => {
            if (!tokenClient) initGIS(localStorage.getItem('ticketScanner_email'));
            const prev = tokenClient.callback;
            tokenClient.callback = (...a) => {
                tokenClient.callback = prev || (() => {
                });
                resolve();
            };
            tokenClient.requestAccessToken({prompt: ''});
        });
    }
    const resp = await gapi.client.script.scripts.run({
        scriptId: SCRIPT_ID,
        resource: {function: fn, parameters: params}
    });
    const result = resp.result;
    if (result.error) {
        const det = result.error.details && result.error.details[0];
        const msg = det && det.errorMessage ? det.errorMessage : JSON.stringify(result.error);
        throw new Error(msg);
    }
    return result.response.result;
}

/* ===== Helpers UI ===== */
function setStatus(msg) {
    $('#status').textContent = msg;
}

function enableSave(on) {
    ['#btnSave', '#btnSave_m'].forEach(id => {
        const b = $(id);
        if (b) b.disabled = !on;
    });
}

function chipBtn(v) {
    return `<button type="button" class="btn btn-outline-secondary chip me-2 mb-2" data-v="${v}">${v}</button>`;
}

function chipsHTML(arr) {
    return (arr && arr.length) ? arr.map(chipBtn).join('') : '<span class="text-muted small">—</span>';
}

['merchant', 'date', 'total'].forEach(id => {
    const cont = document.getElementById(id + 'Candidates');
    if (cont) cont.addEventListener('click', e => {
        const btn = e.target.closest('.chip');
        if (!btn) return;
        document.getElementById(id).value = btn.getAttribute('data-v');
    });
});

/* ===== Liste des onglets ===== */
async function refreshSheetList() {
    try {
        const res = await exec('getSheets', []);
        if (!res?.ok) return;
        $('#sheetSelect').innerHTML = res.names.map(n => `<option ${n === res.defaultName ? 'selected' : ''}>${n}</option>`).join('');
    } catch (e) {
        setStatus('Erreur liste onglets : ' + e.message);
    }
}

/* ===== OCR ===== */
async function analyze() {
    try {
        if (!base64Image) {
            const f = $('#file').files?.[0];
            if (!f) {
                setStatus('Choisis une photo de ticket.');
                return;
            }
        }
        setStatus('Analyse (OCR)…');
        const res = await exec('analyzeReceipt', [base64Image, suggestFilename()]);
        if (!res || res.ok === false) {
            setStatus('Erreur analyse : ' + (res?.error || 'inconnue'));
            enableSave(false);
            return;
        }
        $('#merchant').value = res.enseigne || '';
        $('#date').value = res.date || '';
        $('#total').value = (res.total || '').replace(/[€\s]/g, '').replace('.', ',');

        $('#merchantCandidates').innerHTML = chipsHTML(res.candidates?.merchants || []);
        $('#dateCandidates').innerHTML = chipsHTML(res.candidates?.dates || []);
        $('#totalCandidates').innerHTML = chipsHTML((res.candidates?.totals || []).map(x => String(x).replace('.', ',')));

        enableSave(true);
        setStatus('Vérifie/ajuste puis “Enregistrer”.');
    } catch (e) {
        setStatus('Erreur API (analyze): ' + e.message);
    }
}

/* ===== Enregistrer ===== */
async function save() {
    try {
        const who = (document.querySelector('input[name="who"]:checked')?.value || '').trim();
        const payload = {
            who,
            sheetName: $('#sheetSelect').value,
            enseigne: $('#merchant').value,
            date: $('#date').value,
            total: $('#total').value
        };
        setStatus('Enregistrement…');
        const res = await exec('saveToSheet', [payload]);
        if (!res || res.ok === false) {
            setStatus('Erreur enregistrement : ' + (res?.error || 'inconnue'));
            return;
        }
        setStatus(`Enregistré ✔ (ligne ${res.row}, ${res.who}, onglet « ${payload.sheetName} »)`);
        enableSave(false);
    } catch (e) {
        setStatus('Erreur API (save): ' + e.message);
    }
}

/* ===== Reset ===== */
function resetForm() {
    base64Image = null;
    $('#file').value = '';
    $('#preview').src = '';
    ['merchant', 'date', 'total'].forEach(id => $('#' + id).value = '');
    ['merchantCandidates', 'dateCandidates', 'totalCandidates'].forEach(id => $('#' + id).innerHTML = '');
    enableSave(false);
    setStatus('Prêt.');
}

/* ===== Utils ===== */
function suggestFilename() {
    const n = new Date(), p = x => String(x).padStart(2, '0');
    return `ticket_${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}_${p(n.getHours())}-${p(n.getMinutes())}.jpg`;
}

function fileToBase64(file) {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(',')[1]);
        r.onerror = rej;
        r.readAsDataURL(file);
    });
}

/* Prétraitement “scanner” + downscale */
async function enhanceForOCR(base64) {
    const b64 = await downscaleToJpegBase64(base64, 2000, 0.95);
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            const c = document.createElement('canvas'), ctx = c.getContext('2d');
            c.width = img.width;
            c.height = img.height;
            ctx.drawImage(img, 0, 0);
            // Gris
            let d = ctx.getImageData(0, 0, c.width, c.height);
            for (let i = 0; i < d.data.length; i += 4) {
                const r = d.data[i], g = d.data[i + 1], b = d.data[i + 2];
                const y = 0.299 * r + 0.587 * g + 0.114 * b;
                d.data[i] = d.data[i + 1] = d.data[i + 2] = y;
            }
            ctx.putImageData(d, 0, 0);
            // Contraste
            d = ctx.getImageData(0, 0, c.width, c.height);
            const contrast = 1.35, brightness = 8;
            for (let i = 0; i < d.data.length; i += 4) {
                let v = d.data[i] * contrast + brightness;
                v = Math.max(0, Math.min(255, v));
                d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
            }
            ctx.putImageData(d, 0, 0);
            // Sharpen
            convolve(ctx, c, [0, -1, 0, -1, 5, -1, 0, -1, 0], 1);
            // Otsu
            d = ctx.getImageData(0, 0, c.width, c.height);
            const thr = otsuThreshold(d);
            for (let i = 0; i < d.data.length; i += 4) {
                const v = d.data[i] < thr ? 0 : 255;
                d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
            }
            ctx.putImageData(d, 0, 0);
            const out = c.toDataURL('image/jpeg', 0.9).split(',')[1];
            resolve(out);
        };
        img.src = 'data:image/jpeg;base64,' + b64;
    });
}

function otsuThreshold(imgData) {
    const hist = new Array(256).fill(0), data = imgData.data;
    for (let i = 0; i < data.length; i += 4) hist[data[i] | 0]++;
    const total = imgData.width * imgData.height;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, maxVar = 0, thr = 127;
    for (let t = 0; t < 256; t++) {
        wB += hist[t];
        if (!wB) continue;
        const wF = total - wB;
        if (!wF) break;
        sumB += t * hist[t];
        const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
        if (between > maxVar) {
            maxVar = between;
            thr = t;
        }
    }
    return thr;
}

function convolve(ctx, canvas, kernel, divisor = 1) {
    const w = canvas.width, h = canvas.height;
    const src = ctx.getImageData(0, 0, w, h), dst = ctx.createImageData(w, h);
    const k = kernel, half = 1;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let sum = 0;
            for (let ky = -half; ky <= half; ky++) {
                for (let kx = -half; kx <= half; kx++) {
                    const px = Math.min(w - 1, Math.max(0, x + kx));
                    const py = Math.min(h - 1, Math.max(0, y + ky));
                    const idx = (py * w + px) * 4;
                    const kval = k[(ky + half) * 3 + (kx + half)];
                    sum += src.data[idx] * kval;
                }
            }
            const i = (y * w + x) * 4, v = Math.max(0, Math.min(255, sum / divisor));
            dst.data[i] = dst.data[i + 1] = dst.data[i + 2] = v;
            dst.data[i + 3] = 255;
        }
    }
    ctx.putImageData(dst, 0, 0);
}

function downscaleToJpegBase64(base64, maxSide = 2000, quality = 0.95) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            let w = img.width, h = img.height;
            const ratio = Math.min(1, maxSide / Math.max(w, h));
            const cw = Math.round(w * ratio), ch = Math.round(h * ratio);
            const canvas = document.createElement('canvas');
            canvas.width = cw;
            canvas.height = ch;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, cw, ch);
            const out = canvas.toDataURL('image/jpeg', quality).split(',')[1];
            resolve(out);
        };
        img.src = 'data:image/jpeg;base64,' + base64;
    });
}

/* ===== Initialisation page ===== */
window.addEventListener('load', () => {
    // Boutons
    $('#btnAuth').onclick = () => interactiveSignin();
    $('#btnAnalyze').onclick = analyze;
    $('#btnAnalyze_m').onclick = analyze;
    $('#btnSave').onclick = save;
    $('#btnSave_m').onclick = save;
    $('#btnReset').onclick = resetForm;
    $('#btnReset_m').onclick = resetForm;

    // Image → prétraitement + preview + OCR auto
    $('#file').addEventListener('change', async (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        setStatus('Préparation de l’image…');
        const rawB64 = await fileToBase64(f);
        base64Image = await enhanceForOCR(rawB64);
        $('#preview').src = 'data:image/jpeg;base64,' + base64Image;
        await analyze(); // OCR auto
    });

    // Connexion silencieuse
    showAuthButton(false);
    $('#authStatus').textContent = 'Connexion…';
    silentSignin();
});