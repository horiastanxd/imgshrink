// imgshrink - client-side image compressor.
// Pipeline: File -> createImageBitmap (respects EXIF) -> canvas resize ->
// canvas.toBlob(format, quality). Nothing hits the network.

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif'
};

const DEFAULT_QUALITY = {
  'image/jpeg': 82,
  'image/webp': 80,
  'image/avif': 55,
  'image/png': 100
};

const state = {
  files: [],
  settings: {
    format: 'auto',
    quality: 82,
    maxWidth: null,
    maxHeight: null
  },
  avifSupported: false,
  draining: false
};

const els = {
  drop: document.getElementById('drop'),
  fileInput: document.getElementById('fileInput'),
  pickBtn: document.getElementById('pickBtn'),
  settings: document.getElementById('settings'),
  files: document.getElementById('files'),
  format: document.getElementById('format'),
  avifOption: document.getElementById('avifOption'),
  quality: document.getElementById('quality'),
  qualityLabel: document.getElementById('qualityLabel'),
  qualityField: document.querySelector('.quality-field'),
  maxWidth: document.getElementById('maxWidth'),
  maxHeight: document.getElementById('maxHeight'),
  summary: document.getElementById('summary'),
  reprocess: document.getElementById('reprocess'),
  downloadAll: document.getElementById('downloadAll'),
  clearAll: document.getElementById('clearAll'),
  dialog: document.getElementById('compareDialog'),
  dialogName: document.getElementById('dialogName'),
  dialogClose: document.getElementById('dialogClose'),
  compareArea: document.getElementById('compareArea'),
  compareOriginal: document.getElementById('compareOriginal'),
  compareCompressed: document.getElementById('compareCompressed'),
  compareHandle: document.getElementById('compareHandle')
};

init();

async function init() {
  state.avifSupported = await canEncode('image/avif');
  if (!state.avifSupported) els.avifOption.disabled = true;
  bindUI();
  updateQualityFieldVisibility();
}

function canEncode(type) {
  return new Promise(resolve => {
    const c = document.createElement('canvas');
    c.width = c.height = 2;
    try {
      c.toBlob(b => resolve(!!b), type, 0.5);
    } catch {
      resolve(false);
    }
  });
}

function bindUI() {
  els.pickBtn.addEventListener('click', () => els.fileInput.click());
  els.drop.addEventListener('click', e => {
    if (e.target === els.pickBtn) return;
    els.fileInput.click();
  });
  els.drop.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      els.fileInput.click();
    }
  });

  els.fileInput.addEventListener('change', e => {
    addFiles(Array.from(e.target.files));
    els.fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(evt => {
    els.drop.addEventListener(evt, e => {
      e.preventDefault();
      els.drop.classList.add('active');
    });
  });
  ['dragleave', 'drop'].forEach(evt => {
    els.drop.addEventListener(evt, e => {
      e.preventDefault();
      els.drop.classList.remove('active');
    });
  });
  els.drop.addEventListener('drop', e => {
    const dropped = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (dropped.length) addFiles(dropped);
  });

  els.format.addEventListener('change', () => {
    state.settings.format = els.format.value;
    if (els.format.value !== 'auto' && DEFAULT_QUALITY[els.format.value] != null) {
      els.quality.value = DEFAULT_QUALITY[els.format.value];
      state.settings.quality = Number(els.quality.value);
      els.qualityLabel.textContent = els.quality.value;
    }
    updateQualityFieldVisibility();
  });

  els.quality.addEventListener('input', () => {
    state.settings.quality = Number(els.quality.value);
    els.qualityLabel.textContent = els.quality.value;
  });

  els.maxWidth.addEventListener('change', () => {
    const v = parseInt(els.maxWidth.value, 10);
    state.settings.maxWidth = Number.isFinite(v) && v > 0 ? v : null;
  });
  els.maxHeight.addEventListener('change', () => {
    const v = parseInt(els.maxHeight.value, 10);
    state.settings.maxHeight = Number.isFinite(v) && v > 0 ? v : null;
  });

  els.reprocess.addEventListener('click', () => {
    markAllPendingNonBusy();
    render();
    processAll();
  });
  els.downloadAll.addEventListener('click', downloadAll);
  els.clearAll.addEventListener('click', () => {
    if (!state.files.length) return;
    if (!confirm('Remove all files?')) return;
    state.files.forEach(revokeUrls);
    state.files = [];
    render();
  });

  els.dialogClose.addEventListener('click', () => els.dialog.close());
  els.dialog.addEventListener('click', e => {
    if (e.target === els.dialog) els.dialog.close();
  });
  bindCompareHandle();

  // Allow paste from clipboard anywhere on the page. Chrome/Firefox expose the
  // pasted image via `clipboardData.files`; Safari goes through `items`.
  window.addEventListener('paste', e => {
    const pasted = [];
    for (const f of e.clipboardData?.files || []) {
      if (f.type.startsWith('image/')) pasted.push(f);
    }
    if (!pasted.length) {
      for (const item of e.clipboardData?.items || []) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) pasted.push(f);
        }
      }
    }
    if (pasted.length) addFiles(pasted);
  });
}

function updateQualityFieldVisibility() {
  const fmt = state.settings.format;
  const alwaysLossless = fmt === 'image/png';
  // In 'auto' mode the slider still applies to JPEG/WebP/AVIF inputs, so keep
  // it enabled but dim it to signal that it has no effect on PNG sources.
  els.qualityField.style.opacity = alwaysLossless ? 0.35 : 1;
  els.quality.disabled = alwaysLossless;
}

function sameFile(a, b) {
  return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
}

async function addFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    if (state.files.some(f => sameFile(f.file, file))) continue;
    const id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    const entry = {
      id,
      file,
      name: file.name,
      originalSize: file.size,
      originalType: file.type,
      originalUrl: URL.createObjectURL(file),
      originalW: 0,
      originalH: 0,
      compressedBlob: null,
      compressedSize: 0,
      compressedW: 0,
      compressedH: 0,
      compressedUrl: null,
      outputType: '',
      status: 'pending',
      error: null
    };
    state.files.push(entry);
  }
  els.settings.hidden = false;
  render();
  processAll();
}

async function processAll() {
  if (state.draining) return;
  state.draining = true;
  try {
    while (true) {
      const next = state.files.find(f => f.status === 'pending');
      if (!next) break;
      await processOne(next);
    }
  } finally {
    state.draining = false;
    renderSummary();
  }
}

function markAllPendingNonBusy() {
  for (const entry of state.files) {
    if (entry.status === 'busy') continue;
    entry.status = 'pending';
  }
}

async function processOne(entry) {
  entry.status = 'busy';
  entry.error = null;
  renderRow(entry);

  try {
    const bitmap = await createImageBitmap(entry.file, { imageOrientation: 'from-image' });
    entry.originalW = bitmap.width;
    entry.originalH = bitmap.height;

    const { targetW, targetH } = computeTargetSize(bitmap.width, bitmap.height, state.settings);
    const outputType = pickOutputType(entry);
    const quality = outputType === 'image/png' ? undefined : state.settings.quality / 100;

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d', { alpha: outputType === 'image/png' || outputType === 'image/webp' || outputType === 'image/avif' });
    if (!(outputType === 'image/png' || outputType === 'image/webp' || outputType === 'image/avif')) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, targetW, targetH);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    bitmap.close?.();

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('encode failed')), outputType, quality);
    });

    if (entry.compressedUrl) URL.revokeObjectURL(entry.compressedUrl);
    entry.compressedBlob = blob;
    entry.compressedSize = blob.size;
    entry.compressedW = targetW;
    entry.compressedH = targetH;
    entry.compressedUrl = URL.createObjectURL(blob);
    entry.outputType = outputType;
    entry.status = 'done';
  } catch (err) {
    entry.status = 'error';
    entry.error = err.message || 'processing failed';
  }
  renderRow(entry);
  renderSummary();
}

function computeTargetSize(w, h, s) {
  const maxW = s.maxWidth || Infinity;
  const maxH = s.maxHeight || Infinity;
  if (w <= maxW && h <= maxH) return { targetW: w, targetH: h };
  const scale = Math.min(maxW / w, maxH / h, 1);
  return {
    targetW: Math.max(1, Math.round(w * scale)),
    targetH: Math.max(1, Math.round(h * scale))
  };
}

function pickOutputType(entry) {
  const s = state.settings.format;
  if (s !== 'auto') return s;
  if (entry.originalType === 'image/png') return 'image/png';
  if (entry.originalType === 'image/webp') return 'image/webp';
  if (entry.originalType === 'image/avif' && state.avifSupported) return 'image/avif';
  if (entry.originalType === 'image/gif') return 'image/png';
  return 'image/jpeg';
}

function outputName(entry) {
  const base = entry.name.replace(/\.[^.]+$/, '');
  const ext = MIME_EXT[entry.outputType] || 'bin';
  const currentExt = entry.name.split('.').pop().toLowerCase();
  if (currentExt === ext) return entry.name;
  return base + '.' + ext;
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n / (1024 * 1024)).toFixed(n < 10485760 ? 2 : 1) + ' MB';
}

function render() {
  els.files.innerHTML = '';
  if (!state.files.length) {
    els.settings.hidden = true;
    renderSummary();
    return;
  }
  for (const entry of state.files) {
    const li = document.createElement('li');
    li.className = 'file';
    li.id = 'row-' + entry.id;
    els.files.appendChild(li);
    renderRow(entry);
  }
  renderSummary();
}

function renderRow(entry) {
  const li = document.getElementById('row-' + entry.id);
  if (!li) return;

  let savingsHtml = '';
  let statsHtml = '';

  if (entry.status === 'done') {
    const delta = entry.originalSize - entry.compressedSize;
    const pct = entry.originalSize > 0 ? Math.round((delta / entry.originalSize) * 100) : 0;
    const grew = delta < 0;
    savingsHtml = `<div class="savings ${grew ? 'grew' : ''}">${grew ? '+' : '-'}${Math.abs(pct)}%</div>`;
    statsHtml = `
      <span>${formatBytes(entry.originalSize)}</span>
      <span class="arrow">&rarr;</span>
      <span>${formatBytes(entry.compressedSize)}</span>
      ${grew ? `<span class="grew">larger</span>` : `<span class="saved">${formatBytes(Math.max(0, delta))} saved</span>`}
      <span style="margin-left: 10px; color: var(--muted)">${entry.compressedW}&times;${entry.compressedH}</span>
    `;
  } else if (entry.status === 'busy') {
    savingsHtml = `<div class="savings pending">working...</div>`;
    statsHtml = `<span>${formatBytes(entry.originalSize)}</span>`;
  } else if (entry.status === 'error') {
    savingsHtml = `<div class="savings grew">error</div>`;
    statsHtml = `<span class="error">${entry.error}</span>`;
  } else {
    savingsHtml = `<div class="savings pending">queued</div>`;
    statsHtml = `<span>${formatBytes(entry.originalSize)}</span>`;
  }

  li.innerHTML = `
    <img class="thumb" src="${entry.originalUrl}" alt="" loading="lazy">
    <div class="meta">
      <div class="name" title="${escapeAttr(entry.name)}">${escapeHtml(entry.name)}</div>
      <div class="stats ${entry.status === 'error' ? 'error' : ''}">${statsHtml}</div>
    </div>
    ${savingsHtml}
    <div class="file-actions">
      <button type="button" class="icon-btn" data-act="compare" ${entry.status !== 'done' ? 'disabled' : ''}>Compare</button>
      <button type="button" class="icon-btn" data-act="download" ${entry.status !== 'done' ? 'disabled' : ''}>Download</button>
      <button type="button" class="icon-btn ghost" data-act="remove">Remove</button>
    </div>
  `;

  li.querySelector('.thumb').addEventListener('click', () => openCompare(entry));
  li.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', () => handleRowAction(entry, btn.dataset.act));
  });
}

function handleRowAction(entry, action) {
  if (action === 'compare') openCompare(entry);
  else if (action === 'download') downloadOne(entry);
  else if (action === 'remove') removeEntry(entry);
}

function removeEntry(entry) {
  revokeUrls(entry);
  state.files = state.files.filter(f => f.id !== entry.id);
  render();
}

function revokeUrls(entry) {
  if (entry.originalUrl) URL.revokeObjectURL(entry.originalUrl);
  if (entry.compressedUrl) URL.revokeObjectURL(entry.compressedUrl);
}

function downloadOne(entry) {
  if (!entry.compressedBlob) return;
  triggerDownload(entry.compressedUrl, outputName(entry));
}

async function downloadAll() {
  const ready = state.files.filter(f => f.status === 'done');
  if (!ready.length) return;
  if (ready.length === 1) {
    downloadOne(ready[0]);
    return;
  }
  const seen = new Map();
  const entries = ready.map(entry => {
    let name = outputName(entry);
    const count = (seen.get(name) || 0) + 1;
    seen.set(name, count);
    if (count > 1) {
      const dot = name.lastIndexOf('.');
      name = dot > -1 ? name.slice(0, dot) + `-${count}` + name.slice(dot) : name + `-${count}`;
    }
    return { name, data: entry.compressedBlob };
  });
  const zip = await window.makeZip(entries);
  const url = URL.createObjectURL(zip);
  triggerDownload(url, 'imgshrink.zip');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function triggerDownload(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function renderSummary() {
  const done = state.files.filter(f => f.status === 'done');
  const totalOriginal = state.files.reduce((s, f) => s + f.originalSize, 0);
  const totalCompressed = done.reduce((s, f) => s + f.compressedSize, 0);
  const totalOriginalOfDone = done.reduce((s, f) => s + f.originalSize, 0);
  const saved = totalOriginalOfDone - totalCompressed;
  const pct = totalOriginalOfDone > 0 ? Math.round((saved / totalOriginalOfDone) * 100) : 0;
  const busy = state.files.some(f => f.status === 'busy');

  els.reprocess.disabled = busy || !state.files.length;
  els.downloadAll.disabled = !done.length;

  if (!state.files.length) {
    els.summary.textContent = '';
    return;
  }

  if (busy) {
    els.summary.innerHTML = `<strong>${state.files.length}</strong> file${state.files.length === 1 ? '' : 's'} - processing...`;
    return;
  }

  els.summary.innerHTML = `
    <strong>${done.length}</strong> of <strong>${state.files.length}</strong> ready -
    <strong>${formatBytes(totalOriginal)}</strong> &rarr;
    <strong>${formatBytes(totalCompressed + (totalOriginal - totalOriginalOfDone))}</strong>
    <span class="saved">${pct > 0 ? `(${pct}% smaller, ${formatBytes(saved)} saved)` : ''}</span>
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// Before/after compare slider
function openCompare(entry) {
  if (!entry.compressedUrl) return;
  els.dialogName.textContent = `${entry.name} - ${formatBytes(entry.originalSize)} vs ${formatBytes(entry.compressedSize)}`;
  els.compareOriginal.src = entry.originalUrl;
  els.compareCompressed.src = entry.compressedUrl;
  setHandlePosition(50);
  els.dialog.showModal();
}

function bindCompareHandle() {
  let dragging = false;
  const startDrag = () => { dragging = true; };
  const stopDrag = () => { dragging = false; };
  const move = (clientX) => {
    if (!dragging) return;
    const rect = els.compareArea.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setHandlePosition(Math.max(0, Math.min(100, pct)));
  };

  els.compareHandle.addEventListener('mousedown', startDrag);
  els.compareArea.addEventListener('mousedown', e => {
    if (e.target === els.compareHandle || e.target.parentElement === els.compareHandle) return;
    const rect = els.compareArea.getBoundingClientRect();
    setHandlePosition(((e.clientX - rect.left) / rect.width) * 100);
    startDrag();
  });
  window.addEventListener('mousemove', e => move(e.clientX));
  window.addEventListener('mouseup', stopDrag);

  els.compareArea.addEventListener('touchstart', e => {
    if (!e.touches.length) return;
    const rect = els.compareArea.getBoundingClientRect();
    setHandlePosition(((e.touches[0].clientX - rect.left) / rect.width) * 100);
    startDrag();
    e.preventDefault();
  }, { passive: false });
  window.addEventListener('touchmove', e => {
    if (!dragging || !e.touches.length) return;
    move(e.touches[0].clientX);
  }, { passive: true });
  window.addEventListener('touchend', stopDrag);
  window.addEventListener('touchcancel', stopDrag);
}

function setHandlePosition(pct) {
  els.compareHandle.style.left = pct + '%';
  els.compareCompressed.style.clipPath = `inset(0 0 0 ${pct}%)`;
}
