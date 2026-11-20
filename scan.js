'use strict';
/* ============================================================
   Сканер штрихкодов: камера (BarcodeDetector или ZXing), фото штрихкода, ручной ввод.
   ============================================================ */
const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
const BARCODE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];
let zxingPromise;
function loadZXing() {
  if (window.ZXing) return Promise.resolve();
  if (!zxingPromise) {
    zxingPromise = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = ZXING_URL; s.async = true;
      s.onload = res; s.onerror = () => { zxingPromise = null; rej(new Error('Не удалось загрузить сканер')); };
      document.head.appendChild(s);
    });
  }
  return zxingPromise;
}
async function nativeDetector() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const supported = await window.BarcodeDetector.getSupportedFormats();
    const formats = BARCODE_FORMATS.filter((f) => supported.includes(f));
    return formats.length ? new window.BarcodeDetector({ formats }) : null;
  } catch { return null; }
}
const validCode = (c) => /^\d{6,14}$/.test(String(c || '').trim());

/** Распознаёт штрихкод на фотографии. */
async function decodeImage(file) {
  const url = await resizeImage(file, 1600, 0.92);
  const det = await nativeDetector();
  if (det) {
    try {
      const img = new Image(); img.src = url; await img.decode();
      const r = await det.detect(img);
      const c = r.find((x) => validCode(x.rawValue));
      if (c) return c.rawValue;
    } catch {}
  }
  await loadZXing();
  const reader = new ZXing.BrowserMultiFormatReader();
  const res = await reader.decodeFromImageUrl(url);
  return res && res.getText();
}

function scannerSheet(meal, opts = {}) {
  const st = { status: 'Запускаем камеру…', error: '', stop: null, done: false };
  const found = (code) => {
    if (st.done || !validCode(code)) return;
    st.done = true;
    if (st.stop) st.stop();
    track('scan');
    haptic('success');
    sheets.pop();
    openSheet(barcodeSheet(meal, String(code).trim(), opts));
  };
  async function start(el) {
    const video = el.querySelector('video');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { st.error = 'Камера недоступна на этом устройстве. Сфотографируйте штрихкод или введите цифры.'; return paint(el); }
    try {
      const det = await nativeDetector();
      if (det) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
        video.srcObject = stream; await video.play();
        let alive = true;
        st.stop = () => { alive = false; stream.getTracks().forEach((t) => t.stop()); };
        st.status = 'Наведите камеру на штрихкод'; paint(el);
        const loop = async () => {
          if (!alive) return;
          try { const r = await det.detect(video); const c = r.find((x) => validCode(x.rawValue)); if (c) return found(c.rawValue); } catch {}
          setTimeout(loop, 180);
        };
        loop();
      } else {
        await loadZXing();
        const hints = new Map();
        hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8, ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E, ZXing.BarcodeFormat.CODE_128]);
        const reader = new ZXing.BrowserMultiFormatReader(hints, 250);
        st.stop = () => { try { reader.reset(); } catch {} };
        st.status = 'Наведите камеру на штрихкод'; paint(el);
        await reader.decodeFromConstraints({ video: { facingMode: 'environment' } }, video, (res) => { if (res) found(res.getText()); });
      }
    } catch (e) {
      st.error = /NotAllowed|Permission/i.test(String(e && (e.name || e.message))) ? 'Нет доступа к камере. Разрешите доступ в настройках Telegram или сфотографируйте штрихкод.' : 'Не удалось запустить камеру. Сфотографируйте штрихкод или введите цифры.';
      paint(el);
    }
  }
  function paint(el) {
    const s = el.querySelector('.scan-status');
    if (s) s.innerHTML = st.error ? `<span class="err">⚠️ ${esc(st.error)}</span>` : esc(st.status);
    el.querySelector('.scan-view').classList.toggle('off', !!st.error);
  }
  return {
    title: 'Сканер штрихкода',
    render: () => `<div class="scan-view"><video playsinline muted></video><div class="scan-frame"><i></i></div></div>
      <div class="scan-status">${esc(st.status)}</div>
      <div class="quick">
        <label class="qbtn"><input type="file" accept="image/*" capture="environment" data-bcphoto hidden><span>📸</span>Фото штрихкода<small>если камера не работает</small></label>
        <button data-a="bcManual"><span>⌨️</span>Ввести цифры<small>вручную</small></button>
      </div>`,
    mount(el) {
      start(el);
      el.querySelector('[data-bcphoto]').addEventListener('change', async (e) => {
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        st.status = 'Ищем штрихкод на фото…'; st.error = ''; paint(el);
        try { const code = await decodeImage(f); if (validCode(code)) return found(code); throw new Error(); }
        catch { st.error = 'Не нашли штрихкод на фото. Снимите ближе и ровнее или введите цифры.'; paint(el); }
      });
    },
    unmount() { if (st.stop) st.stop(); },
    actions: { bcManual() { if (st.stop) st.stop(); st.done = true; sheets.pop(); openSheet(barcodeSheet(meal, '', opts)); } },
  };
}
