// Minimal ZIP writer - store-only (no deflate). Image files are already
// compressed, so deflate would add almost nothing but a lot of complexity.
(function () {
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      t[i] = c;
    }
    return t;
  })();

  function crc32(data) {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ data[i]) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(d) {
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    return { date, time };
  }

  async function makeZip(entries) {
    // entries: [{ name: string, data: Uint8Array | Blob | ArrayBuffer }]
    const encoder = new TextEncoder();
    const chunks = [];
    const central = [];
    const now = dosDateTime(new Date());
    let offset = 0;

    for (const entry of entries) {
      let bytes;
      if (entry.data instanceof Uint8Array) bytes = entry.data;
      else if (entry.data instanceof ArrayBuffer) bytes = new Uint8Array(entry.data);
      else if (entry.data instanceof Blob) bytes = new Uint8Array(await entry.data.arrayBuffer());
      else throw new Error('unsupported entry data');

      const nameBytes = encoder.encode(entry.name);
      const crc = crc32(bytes);

      const lfh = new ArrayBuffer(30 + nameBytes.length);
      const lv = new DataView(lfh);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // language encoding flag (UTF-8)
      lv.setUint16(8, 0, true); // method = store
      lv.setUint16(10, now.time, true);
      lv.setUint16(12, now.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, bytes.length, true);
      lv.setUint32(22, bytes.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      new Uint8Array(lfh, 30).set(nameBytes);

      chunks.push(lfh, bytes);

      central.push({ nameBytes, crc, size: bytes.length, offset, now });
      offset += lfh.byteLength + bytes.length;
    }

    const cdStart = offset;
    for (const e of central) {
      const cd = new ArrayBuffer(46 + e.nameBytes.length);
      const v = new DataView(cd);
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, 20, true);
      v.setUint16(8, 0x0800, true);
      v.setUint16(10, 0, true);
      v.setUint16(12, e.now.time, true);
      v.setUint16(14, e.now.date, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, e.size, true);
      v.setUint32(24, e.size, true);
      v.setUint16(28, e.nameBytes.length, true);
      v.setUint16(30, 0, true);
      v.setUint16(32, 0, true);
      v.setUint16(34, 0, true);
      v.setUint16(36, 0, true);
      v.setUint32(38, 0, true);
      v.setUint32(42, e.offset, true);
      new Uint8Array(cd, 46).set(e.nameBytes);
      chunks.push(cd);
      offset += cd.byteLength;
    }

    const eocd = new ArrayBuffer(22);
    const v = new DataView(eocd);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(4, 0, true);
    v.setUint16(6, 0, true);
    v.setUint16(8, central.length, true);
    v.setUint16(10, central.length, true);
    v.setUint32(12, offset - cdStart, true);
    v.setUint32(16, cdStart, true);
    v.setUint16(20, 0, true);
    chunks.push(eocd);

    return new Blob(chunks, { type: 'application/zip' });
  }

  window.makeZip = makeZip;
})();
