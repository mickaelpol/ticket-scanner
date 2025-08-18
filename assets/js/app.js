// === CONFIG ===
const SCRIPT_ID = '1dkuTGVPxWwq5Ib6EK2iLsJt9HjjH1ll1iMbMB8-ebSEUiUsLmsNqNCGh';   // ID du projet Apps Script
const CLIENT_ID = '479308590121-qggjv8oum95edeql478aqtit3lcffgv7.apps.googleusercontent.com';   // ID client OAuth (Application Web)
const DEFAULT_SHEET   = 'Août 2025';            // Onglet sélectionné par défaut
const ALLOWED_EMAILS  = ['polmickael3@gmail.com', 'sabrinamedjoub@gmail.com']; // accès restreint
const OCR_LANG        = 'fra+eng+spa'; // français + anglais + espagnol (ton ticket est en ES)
const API_KEY = "TA_CLE_API";
const SPREADSHEET_ID = "1OgcxX9FQ4VWmWNKWxTqqmA1v-lmqMWB7LmRZHMq7jZI"; // l’ID du Google Sheet
const SCOPES = "https://www.googleapis.com/auth/spreadsheets";

// === GOOGLE AUTH ===
let tokenClient, gapiInited = false, gisInited = false, accessToken = null;

function gapiLoaded() { gapi.load("client", initializeGapiClient); }
async function initializeGapiClient() {
    await gapi.client.init({ apiKey: API_KEY, discoveryDocs: ["https://sheets.googleapis.com/$discovery/rest?version=v4"] });
    gapiInited = true; maybeEnableAuth();
}
function gisLoaded() {
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: (resp) => {
            if (resp.error) return;
            accessToken = resp.access_token;
            document.getElementById("authStatus").textContent = "Connecté ✅";
            listSheets();
        }
    });
    gisInited = true; maybeEnableAuth();
}
function maybeEnableAuth() {
    if (gapiInited && gisInited) document.getElementById("btnAuth").style.display = "inline-block";
}
document.getElementById("btnAuth").onclick = () => {
    tokenClient.requestAccessToken({ prompt: "" }); // silencieux si déjà accepté
};

// === SHEETS ===
async function listSheets() {
    const res = await gapi.client.sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const select = document.getElementById("sheetSelect");
    select.innerHTML = "";
    res.result.sheets.forEach(s => {
        const opt = document.createElement("option");
        opt.value = s.properties.title;
        opt.textContent = s.properties.title;
        select.appendChild(opt);
    });
}
async function saveToSheet() {
    if (!accessToken) { alert("Non connecté"); return; }
    const who = document.querySelector("input[name='who']:checked").value;
    const merchant = document.getElementById("merchant").value;
    const date = document.getElementById("date").value;
    const total = document.getElementById("total").value;
    const sheet = document.getElementById("sheetSelect").value;

    const values = [[new Date().toLocaleString(), who, merchant, date, total]];
    await gapi.client.sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheet}!A1`,
        valueInputOption: "USER_ENTERED",
        resource: { values }
    });
    document.getElementById("status").textContent = "Enregistré ✅";
}

// === OCR (Tesseract.js) ===
document.getElementById("file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const preview = document.getElementById("preview");
    preview.src = URL.createObjectURL(file);
    document.getElementById("status").textContent = "Analyse en cours…";

    const { createWorker } = Tesseract;
    const worker = await createWorker("fra", 1);
    const { data: { text } } = await worker.recognize(file);
    await worker.terminate();

    analyzeText(text);
});

function analyzeText(text) {
    const merchantMatches = text.match(/(CARREFOUR|LECLERC|AUCHAN|INTERMARCHE|ALDI|LIDL|MONOPRIX)/i);
    const dateMatches = text.match(/\d{2}[\/\-.]\d{2}[\/\-.]\d{4}/g);
    const totalMatches = text.match(/(\d+[.,]\d{2})\s*€?/g);

    setCandidates("merchant", merchantMatches ? [merchantMatches[0]] : []);
    setCandidates("date", dateMatches || []);
    setCandidates("total", totalMatches || []);
}

function setCandidates(field, candidates) {
    const input = document.getElementById(field);
    const container = document.getElementById(field + "Candidates");
    container.innerHTML = "";
    if (candidates.length) {
        candidates.slice(0, 4).forEach(val => {
            const btn = document.createElement("button");
            btn.textContent = val;
            btn.className = "btn btn-sm btn-outline-light me-1 mb-1";
            btn.onclick = () => input.value = val;
            container.appendChild(btn);
        });
        input.value = candidates[0];
    }
}

// === ACTIONS ===
document.getElementById("btnSave_m").onclick = saveToSheet;
document.getElementById("btnReset_m").onclick = () => location.reload();
