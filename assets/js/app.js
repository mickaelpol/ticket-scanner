/* app.js — Scanner de tickets (OpenCV.js + Tesseract.js)
 *
 * ✅ Objectifs :
 *  - Prétraitement robuste d’image (sans fastNlMeansDenoising)
 *  - Deskew (redressement) + binarisation adaptés aux tickets
 *  - OCR (fra+eng) avec Tesseract.js
 *  - Extraction fiable : date, lignes d’articles (intitulé + prix), total
 *
 * 📦 Dépendances attendues dans la page :
 *    <script src="https://docs.opencv.org/4.x/opencv.js"></script>
 *    <script src="https://unpkg.com/tesseract.js@5/dist/tesseract.min.js"></script>
 *
 * ℹ️ Intégration :
 *  - Placez ce fichier tel quel.
 *  - Si votre HTML contient déjà des éléments,
 *    l’app tentera d’utiliser (dans cet ordre) :
 *      input[type=file] avec id #receipt-file, #file, [data-receipt-input]
 *      canvas avec id #preview, #canvas, [data-receipt-canvas]
 *      zone résultat avec id #results, #output, [data-receipt-output]
 *  - Si rien n’est trouvé, une UI minimale est créée automatiquement.
 */

(() => {
  'use strict';

  /*** ------------------------- Utils DOM / Loader -------------------------- ***/

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const firstExisting = (selectors) => {
    for (const s of selectors) {
      const el = $(s);
      if (el) return el;
    }
    return null;
  };

  const createEl = (tag, attrs = {}, parent = null) => {
    const el = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v);
    });
    if (parent) parent.appendChild(el);
    return el;
  };

  const loadScript = (src) =>
    new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });

  const waitForOpenCV = () =>
    new Promise((resolve, reject) => {
      const check = () => {
        if (window.cv && typeof cv.imread === 'function') {
          if (cv['onRuntimeInitialized']) {
            // opencv.js classique expose onRuntimeInitialized
            const prev = cv.onRuntimeInitialized;
            cv.onRuntimeInitialized = () => {
              prev && prev();
              resolve();
            };
          } else {
            resolve();
          }
        } else {
          setTimeout(check, 50);
        }
      };
      check();
      setTimeout(() => reject(new Error('OpenCV not ready')), 20000);
    });

  const ensureDeps = async () => {
    // OpenCV
    if (!window.cv) {
      await loadScript('https://docs.opencv.org/4.x/opencv.js');
    }
    await waitForOpenCV();

    // Tesseract
    if (!window.Tesseract) {
      await loadScript('https://unpkg.com/tesseract.js@5/dist/tesseract.min.js');
    }
    if (!window.Tesseract) {
      throw new Error('Tesseract failed to load');
    }
  };

  /*** --------------------------- Canvas helpers --------------------------- ***/

  const drawImageFit = (img, maxW = 1600, maxH = 1600) => {
    const ratio = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
    const w = Math.round(img.naturalWidth * ratio);
    const h = Math.round(img.naturalHeight * ratio);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return canvas;
  };

  const rotateCanvas = (srcCanvas, angleDeg, bg = '#FFFFFF') => {
    const angle = (angleDeg * Math.PI) / 180;
    const s = Math.sin(angle);
    const c = Math.cos(angle);
    const w = srcCanvas.width;
    const h = srcCanvas.height;
    const newW = Math.abs(w * c) + Math.abs(h * s);
    const newH = Math.abs(w * s) + Math.abs(h * c);
    const out = document.createElement('canvas');
    out.width = Math.ceil(newW);
    out.height = Math.ceil(newH);
    const ctx = out.getContext('2d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(angle);
    ctx.drawImage(srcCanvas, -w / 2, -h / 2);
    return out;
  };

  /*** ------------------------- Image preprocessing ------------------------ ***/

  const withMat = (fn) => {
    // small helper to ensure mats are deleted
    return (...args) => {
      const mats = [];
      const wrap = (m) => (mats.push(m), m);
      try {
        return fn(wrap, ...args);
      } finally {
        mats.forEach((m) => {
          try {
            m && typeof m.delete === 'function' && m.delete();
          } catch (_) {}
        });
      }
    };
  };

  const estimateSkewAngle = withMat((W, srcMat) => {
    // Work on reduced copy to speed up
    const scale = 800 / Math.max(srcMat.cols, srcMat.rows);
    const resized = W(new cv.Mat());
    cv.resize(srcMat, resized, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);

    const gray = W(new cv.Mat());
    cv.cvtColor(resized, gray, cv.COLOR_RGBA2GRAY, 0);

    const blur = W(new cv.Mat());
    cv.GaussianBlur(gray, blur, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);

    const edges = W(new cv.Mat());
    cv.Canny(blur, edges, 50, 150, 3, false);

    const lines = new cv.Mat();
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 100, 100, 20);

    const angles = [];
    for (let i = 0; i < lines.rows; i++) {
      const [x1, y1, x2, y2] = lines.int32Ptr(i);
      const dx = x2 - x1;
      const dy = y2 - y1;
      if (dx === 0 && dy === 0) continue;
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      // near-horizontal lines only
      if (Math.abs(angle) <= 15) {
        angles.push(angle);
      }
    }
    lines.delete();

    if (!angles.length) return 0;

    // median angle is more robust to outliers
    angles.sort((a, b) => a - b);
    const mid = Math.floor(angles.length / 2);
    const median = angles.length % 2 ? angles[mid] : (angles[mid - 1] + angles[mid]) / 2;
    return median;
  });

  const preprocessForOCR = withMat((W, inCanvas) => {
    const src = W(cv.imread(inCanvas));

    // 1) Conversion en niveaux de gris
    const gray = W(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);

    // 2) Lissage léger (évite la perte de détails fine des caractères)
    const denoised = W(new cv.Mat());
    cv.medianBlur(gray, denoised, 3); // ✅ pas de fastNlMeansDenoising

    // 3) Contraste local (CLAHE) pour écriture pâle / photo sombre
    const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
    const enhanced = W(new cv.Mat());
    clahe.apply(denoised, enhanced);
    clahe.delete();

    // 4) Binarisation adaptative (meilleure sur fonds non homogènes)
    const bw = W(new cv.Mat());
    cv.adaptiveThreshold(
      enhanced,
      bw,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY,
      35,
      10
    );

    // 5) Ouverture légère pour retirer les grains
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, 1));
    const opened = W(new cv.Mat());
    cv.morphologyEx(bw, opened, cv.MORPH_OPEN, kernel);

    // 6) Lignes fines -> épaissir très légèrement (fermeture)
    const kernel2 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
    const closed = W(new cv.Mat());
    cv.morphologyEx(opened, closed, cv.MORPH_CLOSE, kernel2);

    // 7) Option : inversion si texte blanc sur noir (rare après adaptiveThreshold)
    // On laisse tel quel : Tesseract gère les deux.

    // 8) Redressement (angle)
    const angle = estimateSkewAngle(src);
    const outCanvas = rotateCanvas(matToCanvas(closed), -angle);

    // 9) Sharpen léger (unsharp mask) pour OCR
    const sharpened = applyUnsharpMask(outCanvas, 0.6, 1);

    return { canvas: sharpened, angle };
  });

  const matToCanvas = (mat) => {
    const canvas = document.createElement('canvas');
    canvas.width = mat.cols;
    canvas.height = mat.rows;
    cv.imshow(canvas, mat);
    return canvas;
  };

  const applyUnsharpMask = (canvas, amount = 0.6, radius = 1) => {
    // Unsharp mask bricolé via 2D context (léger)
    // amount: 0..1
    const w = canvas.width;
    const h = canvas.height;
    const ctx = canvas.getContext('2d');
    const srcData = ctx.getImageData(0, 0, w, h);
    const blurred = blurImageData(srcData, w, h, radius);
    const out = ctx.createImageData(w, h);
    for (let i = 0; i < srcData.data.length; i += 4) {
      out.data[i] = clamp(srcData.data[i] + amount * (srcData.data[i] - blurred.data[i]));
      out.data[i + 1] = clamp(srcData.data[i + 1] + amount * (srcData.data[i + 1] - blurred.data[i + 1]));
      out.data[i + 2] = clamp(srcData.data[i + 2] + amount * (srcData.data[i + 2] - blurred.data[i + 2]));
      out.data[i + 3] = srcData.data[i + 3];
    }
    const outCanvas = document.createElement('canvas');
    outCanvas.width = w;
    outCanvas.height = h;
    outCanvas.getContext('2d').putImageData(out, 0, 0);
    return outCanvas;
  };

  const blurImageData = (imgData, w, h, r) => {
    // box blur très léger (r petit)
    const out = new ImageData(w, h);
    const src = imgData.data;
    const dst = out.data;
    const wh = w * h;
    const weights = [];
    const rs = Math.max(1, r | 0);
    const size = rs * 2 + 1;
    for (let i = -rs; i <= rs; i++) weights.push(1);
    const sum = size;

    const tmp = new Uint8ClampedArray(src.length);

    // horizontal
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let rSum = 0, gSum = 0, bSum = 0, aSum = 0;
        for (let k = -rs; k <= rs; k++) {
          const xx = Math.min(w - 1, Math.max(0, x + k));
          const idx = (y * w + xx) * 4;
          rSum += src[idx];
          gSum += src[idx + 1];
          bSum += src[idx + 2];
          aSum += src[idx + 3];
        }
        const o = (y * w + x) * 4;
        tmp[o] = rSum / sum;
        tmp[o + 1] = gSum / sum;
        tmp[o + 2] = bSum / sum;
        tmp[o + 3] = aSum / sum;
      }
    }

    // vertical
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let rSum = 0, gSum = 0, bSum = 0, aSum = 0;
        for (let k = -rs; k <= rs; k++) {
          const yy = Math.min(h - 1, Math.max(0, y + k));
          const idx = (yy * w + x) * 4;
          rSum += tmp[idx];
          gSum += tmp[idx + 1];
          bSum += tmp[idx + 2];
          aSum += tmp[idx + 3];
        }
        const o = (y * w + x) * 4;
        dst[o] = rSum / sum;
        dst[o + 1] = gSum / sum;
        dst[o + 2] = bSum / sum;
        dst[o + 3] = aSum / sum;
      }
    }

    return out;
  };

  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

  /*** --------------------------- OCR + Parsing ---------------------------- ***/

  const normalizeOCRText = (s) => {
    if (!s) return '';
    // Normalisations usuelles des OCR tickets
    return s
      .replace(/\u00A0/g, ' ')
      .replace(/[|]/g, ' ')
      .replace(/[€\u20AC]/g, ' € ')
      .replace(/[\t]+/g, ' ')
      .replace(/ +/g, ' ')
      .replace(/\s+\n/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  };

  const monthNamesFr = [
    'janv', 'févr', 'fevr', 'mars', 'avr', 'mai', 'juin',
    'juil', 'août', 'aout', 'sept', 'oct', 'nov', 'déc', 'dec'
  ];

  const dateRegexes = [
    // 12/07/2025, 12-07-25, 12.07.2025
    /\b([0-3]?\d)[\/\-.]([01]?\d)[\/\-.]((?:20)?\d{2})\b/gi,
    // 2025-07-12
    /\b(20\d{2})[\/\-.]([01]?\d)[\/\-.]([0-3]?\d)\b/gi,
    // 12 juil 2025 / 12 juillet 2025
    new RegExp(
      `\\b([0-3]?\\d)\\s*(?:${monthNamesFr.join('|')})(?:[a-zéû]+)?\\s*(20\\d{2})\\b`,
      'gi'
    ),
  ];

  const toISODateSafe = (d, m, y) => {
    // d,m,y as strings/numbers — handle yy
    const year = String(y).length === 2 ? Number('20' + y) : Number(y);
    const month = Number(m);
    const day = Number(d);
    if (
      year >= 2000 && year <= 2100 &&
      month >= 1 && month <= 12 &&
      day >= 1 && day <= 31
    ) {
      const pad = (n) => String(n).padStart(2, '0');
      return `${year}-${pad(month)}-${pad(day)}`;
    }
    return null;
  };

  const extractDate = (text) => {
    const lines = text.split('\n');

    // Try all regexes line by line; first valid wins
    for (const line of lines) {
      for (const rx of dateRegexes) {
        rx.lastIndex = 0;
        const m = rx.exec(line.toLowerCase());
        if (!m) continue;

        // Determine pattern type by capturing groups count/meaning
        if (rx === dateRegexes[0]) {
          // dd sep mm sep yyyy|yy
          const iso = toISODateSafe(m[1], m[2], m[3]);
          if (iso) return iso;
        } else if (rx === dateRegexes[1]) {
          // yyyy sep mm sep dd
          const iso = toISODateSafe(m[3], m[2], m[1]);
          if (iso) return iso;
        } else {
          // 12 juil 2025
          const day = m[1];
          const year = m[2];
          // Rough month detection
          const l = line.toLowerCase();
          let month = null;
          const candidates = [
            ['janv', 1], ['févr', 2], ['fevr', 2], ['mars', 3], ['avr', 4],
            ['mai', 5], ['juin', 6], ['juil', 7], ['août', 8], ['aout', 8],
            ['sept', 9], ['oct', 10], ['nov', 11], ['déc', 12], ['dec', 12],
          ];
          for (const [name, num] of candidates) {
            if (l.includes(name)) { month = num; break; }
          }
          if (month) {
            const iso = toISODateSafe(day, month, year);
            if (iso) return iso;
          }
        }
      }
    }
    return null;
  };

  const STOP_WORDS = [
    'total', 'tota1', 'ttc', 'tcc', 'ht', 'tva', 'taxe', 'tax', 'remise',
    'promotion', 'promo', 'sous total', 'sous-total', 'subtotal',
    'net a payer', 'net à payer', 'a regler', 'à regler', 'à régler', 'a régler',
    'rendu', 'monnaie', 'paiement', 'payment', 'cash', 'cb', 'carte',
    'visa', 'mastercard', 'amex', 'ticket', 'merci', 'bonjour', 'au revoir',
    'tel', 'tél', 'telephone', 'téléphone', 'siret', 'sas', 'sarl',
    'facture', 'reçu', 'recu', 'servi', 'serveur', 'vendeur', 'magasin',
    'n°', 'no', 'numéro', 'numero', 'ref', 'réf', 'ref.',
  ];

  const looksLikeMeta = (line) => {
    const l = line.toLowerCase().trim();
    if (!l || l.length < 2) return true;
    if (/^[\W_]+$/.test(l)) return true; // only punctuation
    if (/^\d{1,4}$/.test(l)) return true; // lone numbers
    if (STOP_WORDS.some((w) => l.includes(w))) return true;
    return false;
  };

  const euroToFloat = (s) => {
    if (!s) return null;
    const safe = s
      .replace(/[Oo]/g, '0')    // OCR confusions
      .replace(/[Il]/g, '1')
      .replace(/\s/g, '')
      .replace('€', '')
      .replace(/,/g, '.');
    const m = safe.match(/(\d+(?:\.\d{2})?)/);
    return m ? parseFloat(m[1]) : null;
  };

  const findPriceInLine = (line) => {
    // Cherche prix au format EU : 12,34 ou 12.34 (avec/ sans €)
    const rx = /(\d{1,5}[.,]\d{2})\s*(?:€|eur|e)?\b/i;
    const m = line.match(rx);
    if (!m) return null;

    const priceStr = m[1];
    const price = euroToFloat(priceStr);
    if (price == null) return null;

    const left = line.slice(0, m.index).trim();
    const right = line.slice(m.index + m[0].length).trim();

    // Détecte un éventuel "2 x 3,50" (quand présent)
    const qtyRx = /(\d{1,3})\s*[x×*]\s*(\d{1,4}[.,]\d{2})/i;
    const q = line.match(qtyRx);
    if (q) {
      const qty = parseInt(q[1], 10);
      const unit = euroToFloat(q[2]);
      return {
        price, // prix total sur la ligne (souvent total = qty * unit)
        qty: isFinite(qty) && qty > 0 ? qty : 1,
        unitPrice: unit ?? null,
        desc: (left || right || line).replace(qtyRx, '').replace(rx, '').trim(),
      };
    }

    return {
      price,
      qty: 1,
      unitPrice: null,
      desc: (left || right || line).replace(rx, '').trim(),
    };
  };

  const mergeSplitLines = (lines) => {
    // Certains tickets ont "INTITULÉ" sur une ligne, le prix à droite sur la ligne suivante
    // Heuristique simple : si ligne[i] = texte sans prix && ligne[i+1] = uniquement prix,
    // alors fusionner.
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const a = lines[i].trim();
      if (!a) continue;
      const priceOnly = a.match(/^\s*(\d{1,5}[.,]\d{2})\s*(€|eur|e)?\s*$/i);

      if (!findPriceInLine(a) && !priceOnly && i + 1 < lines.length) {
        const b = lines[i + 1].trim();
        const p = findPriceInLine(b) || (b.match(/^\s*(\d{1,5}[.,]\d{2})\s*(€|eur|e)?\s*$/i) ? { price: euroToFloat(b) } : null);
        if (p) {
          out.push(`${a}  ${b}`);
          i++; // skip next
          continue;
        }
      }
      out.push(a);
    }
    return out;
  };

  const extractTotals = (lines) => {
    let totalTTC = null;
    let totalHT = null;

    const lineHasPrice = (s) => {
      const m = s.match(/(\d{1,5}[.,]\d{2})\s*(€|eur|e)?\b/i);
      return m ? euroToFloat(m[1]) : null;
    };

    for (const raw of lines) {
      const l = raw.toLowerCase();

      if (/(total\s*ttc|ttc\s*total|montant\s*ttc|net\s*(?:a|à)\s*payer)/i.test(l)) {
        const p = lineHasPrice(raw);
        if (p != null) totalTTC = p;
        continue;
      }
      if (/(total\s*ht|ht\s*total)/i.test(l)) {
        const p = lineHasPrice(raw);
        if (p != null) totalHT = p;
        continue;
      }
    }

    // fallback : dernier "total" ou dernière ligne avec prix élevé
    if (totalTTC == null) {
      const totals = lines
        .filter((x) => /total/i.test(x))
        .map((x) => ({ line: x, price: (x.match(/(\d{1,5}[.,]\d{2})/) || [])[1] }))
        .filter((o) => o.price)
        .map((o) => euroToFloat(o.price));
      if (totals.length) totalTTC = totals[totals.length - 1];
    }

    if (totalTTC == null) {
      const withPrices = lines
        .map((x) => (x.match(/(\d{1,5}[.,]\d{2})/) || [])[1])
        .filter(Boolean)
        .map(euroToFloat);
      if (withPrices.length) totalTTC = withPrices[withPrices.length - 1];
    }

    return { totalTTC, totalHT };
  };

  const extractItems = (text) => {
    const rawLines = text
      .split('\n')
      .map((x) => x.replace(/[*•·▪︎◦]/g, ' ').replace(/\s{2,}/g, ' ').trim())
      .filter(Boolean);

    const lines = mergeSplitLines(rawLines);

    const items = [];
    for (const line of lines) {
      if (looksLikeMeta(line)) continue;
      const parsed = findPriceInLine(line);
      if (!parsed) continue;

      // Filtre "TOTAL" & co même s'il y a un prix
      if (looksLikeMeta(parsed.desc)) continue;

      // Nettoyage intitulé
      const desc = parsed.desc
        .replace(/\b(qte|qté|qty)\s*:\s*\d+/i, '')
        .replace(/\b(ref|réf|code)\s*[:\-\w]*/i, '')
        .replace(/[^\p{L}\p{N}\s'.\-]/gu, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();

      items.push({
        description: desc || 'Article',
        quantity: parsed.qty || 1,
        unitPrice: parsed.unitPrice != null ? Number(parsed.unitPrice.toFixed(2)) : null,
        linePrice: Number(parsed.price.toFixed(2)),
        raw: line,
      });
    }

    // Regrouper les doublons évidents (même description + même linePrice & unitPrice)
    const merged = [];
    for (const it of items) {
      const idx = merged.findIndex(
        (x) =>
          x.description === it.description &&
          (x.unitPrice === it.unitPrice || (x.unitPrice == null && it.unitPrice == null)) &&
          x.linePrice === it.linePrice
      );
      if (idx >= 0) {
        merged[idx].quantity += it.quantity;
      } else {
        merged.push({ ...it });
      }
    }

    return merged;
  };

  const runOCR = async (canvas) => {
    const { data } = await Tesseract.recognize(canvas, 'fra+eng', {
      // tips: psm 6 = Assume a single uniform block of text (best for receipts)
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1',
    });
    return normalizeOCRText(data.text || '');
  };

  /*** --------------------------- Orchestration ---------------------------- ***/

  const processImage = async (imgEl, ui) => {
    ui.setStatus('Prétraitement de l’image…');
    const baseCanvas = drawImageFit(imgEl, 1800, 1800);
    const { canvas: preprocessed, angle } = preprocessForOCR(baseCanvas);

    // Preview
    ui.setPreview(preprocessed);

    ui.setStatus(`OCR en cours… (angle corrigé: ${angle.toFixed(2)}°)`);
    const text = await runOCR(preprocessed);

    ui.setStatus('Extraction des données…');

    const date = extractDate(text);
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const { totalTTC, totalHT } = extractTotals(lines);
    const items = extractItems(text);

    // Calcul total (fallback si pas de total détecté)
    const itemsSum = Number(
      items.reduce((acc, it) => acc + (it.linePrice || 0), 0).toFixed(2)
    );
    const finalTotal = totalTTC != null ? totalTTC : (itemsSum > 0 ? itemsSum : null);

    const result = {
      date: date || null,
      currency: 'EUR',
      totalHT: totalHT != null ? Number(totalHT.toFixed(2)) : null,
      totalTTC: finalTotal != null ? Number(finalTotal.toFixed(2)) : null,
      items,
      ocrText: text,
    };

    ui.showResult(result);
    ui.setStatus('Terminé.');
    return result;
  };

  /*** --------------------------- Minimal UI layer ------------------------- ***/

  const buildFallbackUI = () => {
    const container = createEl('div', { id: 'receipt-app', style: 'max-width:980px;margin:20px auto;font-family:system-ui,Segoe UI,Arial,sans-serif;' }, document.body);
    createEl('h2', { text: 'Scanner de tickets' }, container);

    const row = createEl('div', { style: 'display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;' }, container);

    const left = createEl('div', { style: 'flex:1;min-width:260px;' }, row);
    const right = createEl('div', { style: 'flex:1;min-width:260px;' }, row);

    const file = createEl('input', { type: 'file', accept: 'image/*', id: 'receipt-file' }, left);
    const status = createEl('div', { id: 'status', style: 'margin-top:8px;color:#555;' }, left);
    const canvas = createEl('canvas', { id: 'preview', style: 'width:100%;max-width:480px;border:1px solid #ddd;border-radius:8px;background:#fff;' }, left);

    const results = createEl('div', { id: 'results', style: 'font-size:14px;line-height:1.4' }, right);
    results.innerHTML = `
      <div style="margin-bottom:8px;">
        <strong>Date :</strong> <span id="out-date">-</span><br/>
        <strong>Total TTC :</strong> <span id="out-total">-</span>
      </div>
      <div style="max-height:260px;overflow:auto;border:1px solid #eee;border-radius:8px;padding:8px;background:#fafafa;margin-bottom:8px;">
        <table id="items-table" style="width:100%;border-collapse:collapse;">
          <thead>
            <tr>
              <th style="text-align:left;border-bottom:1px solid #ddd;padding:6px;">Intitulé</th>
              <th style="text-align:right;border-bottom:1px solid #ddd;padding:6px;">Qté</th>
              <th style="text-align:right;border-bottom:1px solid #ddd;padding:6px;">Prix ligne (€)</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
      <details>
        <summary>JSON</summary>
        <pre id="json" style="white-space:pre-wrap;"></pre>
      </details>
    `;

    return {
      file,
      canvas,
      status: $('#status'),
      outDate: $('#out-date'),
      outTotal: $('#out-total'),
      itemsTableBody: $('#items-table tbody'),
      json: $('#json'),
      results,
      container,
    };
  };

  const getOrCreateUI = () => {
    const file = firstExisting(['#receipt-file', '#file', '[data-receipt-input]']) || null;
    const canvas = firstExisting(['#preview', '#canvas', '[data-receipt-canvas]']) || null;
    const results = firstExisting(['#results', '#output', '[data-receipt-output]']) || null;

    if (file && canvas && results) {
      // Expect standard sub-elements inside results
      const outDate = $('#out-date') || createEl('span', { id: 'out-date' }, results);
      const outTotal = $('#out-total') || createEl('span', { id: 'out-total' }, results);
      let itemsTableBody = $('#items-table tbody');
      if (!itemsTableBody) {
        const table = createEl('table', { id: 'items-table', style: 'width:100%;border-collapse:collapse;' }, results);
        table.innerHTML = `
          <thead>
            <tr>
              <th style="text-align:left;border-bottom:1px solid #ddd;padding:6px;">Intitulé</th>
              <th style="text-align:right;border-bottom:1px solid #ddd;padding:6px;">Qté</th>
              <th style="text-align:right;border-bottom:1px solid #ddd;padding:6px;">Prix ligne (€)</th>
            </tr>
          </thead>
          <tbody></tbody>`;
        itemsTableBody = table.querySelector('tbody');
      }
      const json = $('#json') || createEl('pre', { id: 'json', style: 'white-space:pre-wrap;' }, results);
      const status = $('#status') || createEl('div', { id: 'status', style: 'margin-top:8px;color:#555;' }, results);

      return { file, canvas, results, outDate, outTotal, itemsTableBody, json, status };
    }

    // Build minimal UI if missing
    return buildFallbackUI();
  };

  const makeUIApi = (ui) => ({
    setStatus(msg) {
      if (ui.status) ui.status.textContent = msg;
    },
    setPreview(canvas) {
      if (!ui.canvas) return;
      const ctx = ui.canvas.getContext('2d');
      ui.canvas.width = canvas.width;
      ui.canvas.height = canvas.height;
      ctx.drawImage(canvas, 0, 0);
    },
    showResult(result) {
      if (ui.outDate) ui.outDate.textContent = result.date || '—';
      if (ui.outTotal)
        ui.outTotal.textContent = result.totalTTC != null ? result.totalTTC.toFixed(2) + ' €' : '—';

      if (ui.itemsTableBody) {
        ui.itemsTableBody.innerHTML = '';
        for (const it of result.items) {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td style="padding:6px;border-bottom:1px solid #f0f0f0;">${escapeHtml(it.description)}</td>
            <td style="padding:6px;border-bottom:1px solid #f0f0f0;text-align:right;">${it.quantity}</td>
            <td style="padding:6px;border-bottom:1px solid #f0f0f0;text-align:right;">${it.linePrice.toFixed(2)}</td>
          `;
          ui.itemsTableBody.appendChild(tr);
        }
      }

      if (ui.json) ui.json.textContent = JSON.stringify(result, null, 2);
      console.log('[Receipt OCR]', result);
    },
  });

  const escapeHtml = (s) =>
    s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  /*** ------------------------------- Init -------------------------------- ***/

  const onFileChange = async (fileInput, uiApi) => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;

    const img = new Image();
    img.onload = async () => {
      try {
        await ensureDeps();
        await processImage(img, uiApi);
      } catch (err) {
        console.error(err);
        uiApi.setStatus('Erreur : ' + (err && err.message ? err.message : String(err)));
      }
    };
    img.onerror = () => uiApi.setStatus('Impossible de lire l’image.');
    img.src = URL.createObjectURL(file);
  };

  document.addEventListener('DOMContentLoaded', async () => {
    const ui = getOrCreateUI();
    const uiApi = makeUIApi(ui);

    if (ui.file) {
      ui.file.addEventListener('change', () => onFileChange(ui.file, uiApi));
    }

    // Optionnel : si un <img id="sample"> existe déjà dans la page, on le traite
    const sample = $('#receipt-sample');
    if (sample && sample.complete && sample.naturalWidth > 0) {
      try {
        await ensureDeps();
        uiApi.setStatus('Analyse de l’exemple…');
        await processImage(sample, uiApi);
      } catch (e) {
        console.error(e);
        uiApi.setStatus('Erreur : ' + (e && e.message ? e.message : String(e)));
      }
    }
  });
})();
