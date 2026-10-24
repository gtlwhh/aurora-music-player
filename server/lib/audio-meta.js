'use strict';
/**
 * 音频文件元数据解析
 * 支持：MP3(ID3v2.3 / ID3v2.4) / FLAC(Vorbis Comment + Picture) / MP4-M4A(ilst)
 * 设计原则：扫描时只读必要字节，封面按需单独读取，保证上千首歌也能秒级建库。
 */

const fs = require('fs');
const path = require('path');

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.mp4', '.aac', '.wav', '.ogg', '.opus', '.ape', '.wma']);

function isAudio(file) {
  return AUDIO_EXTS.has(path.extname(file).toLowerCase());
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

/** 读取文件指定区间的字节 */
function readRange(fd, start, length) {
  const buf = Buffer.alloc(length);
  const got = fs.readSync(fd, buf, 0, length, start);
  return got === length ? buf : buf.subarray(0, got);
}

/** ID3v2 的 syncsafe 整数（每字节只用低 7 位） */
function syncSafe(buf, off) {
  return ((buf[off] & 0x7f) << 21) | ((buf[off + 1] & 0x7f) << 14) |
         ((buf[off + 2] & 0x7f) << 7) | (buf[off + 3] & 0x7f);
}

/** 去掉字符串首尾的 \0 和空白 */
function tidy(s) {
  if (!s) return '';
  return s.replace(/\0+$/g, '').replace(/^\0+/, '').trim();
}

/** 按 ID3 编码字节解码文本 */
function decodeText(buf, encoding) {
  let text = '';
  try {
    if (encoding === 0) {
      // ISO-8859-1，实际中文 mp3 多数是 GBK，用 latin1 先解再尝试
      text = buf.toString('latin1');
      // 若出现高位字符，很可能是 GBK 编码的中文，尝试用 GBK 解码
      if (/[\x80-\xff]/.test(text)) {
        try {
          const gbk = new TextDecoder('gbk').decode(buf);
          // GBK 解码后若含中文则优先采用
          if (/[\u4e00-\u9fa5]/.test(gbk)) text = gbk;
        } catch (_) { /* 运行时不支持 gbk 时忽略 */ }
      }
    } else if (encoding === 1) {
      // UTF-16 带 BOM
      if (buf[0] === 0xff && buf[1] === 0xfe) {
        text = buf.subarray(2).toString('utf16le');
      } else if (buf[0] === 0xfe && buf[1] === 0xff) {
        const body = Buffer.from(buf.subarray(2));
        body.swap16();
        text = body.toString('utf16le');
      } else {
        text = buf.toString('utf16le');
      }
    } else if (encoding === 2) {
      // UTF-16BE 无 BOM
      const body = Buffer.from(buf);
      if (body.length % 2 === 1) return '';
      body.swap16();
      text = body.toString('utf16le');
    } else {
      text = buf.toString('utf8');
    }
  } catch (_) {
    text = buf.toString('utf8');
  }
  return tidy(text);
}

/* ------------------------------------------------------------------ */
/* ID3v2 (MP3)                                                         */
/* ------------------------------------------------------------------ */

function parseID3(buffer) {
  if (buffer.length < 10 || buffer.toString('latin1', 0, 3) !== 'ID3') return null;

  const version = buffer[3];
  const flags = buffer[5];
  const tagSize = syncSafe(buffer, 6);
  const isV24 = version >= 4;

  const tag = {
    title: '', artist: '', album: '', albumArtist: '',
    track: '', year: '', hasCover: false
  };

  let pos = 10;
  // 扩展头
  if (flags & 0x40) {
    const extSize = isV24 ? syncSafe(buffer, 10) : buffer.readUInt32BE(10) + 4;
    pos += extSize;
  }

  const end = Math.min(10 + tagSize, buffer.length);

  while (pos + 10 <= end) {
    const frameId = buffer.toString('latin1', pos, pos + 4);
    if (!/^[A-Z0-9]{4}$/.test(frameId)) break;

    let frameSize;
    if (isV24) {
      frameSize = syncSafe(buffer, pos + 4);
    } else {
      frameSize = buffer.readUInt32BE(pos + 4);
    }
    const frameFlags = buffer.readUInt16BE(pos + 8);

    const dataStart = pos + 10;
    const dataEnd = dataStart + frameSize;
    if (frameSize <= 0 || dataEnd > buffer.length) break;

    // v2.4 支持数据长度指示器 / 压缩等标志，简单起见跳过非压缩帧
    const compressed = isV24 ? (frameFlags & 0x0008) : (frameFlags & 0x0080);
    if (!compressed) {
      const data = buffer.subarray(dataStart, dataEnd);
      switch (frameId) {
        case 'TIT2': tag.title = decodeText(data.subarray(1), data[0]); break;
        case 'TPE1': tag.artist = decodeText(data.subarray(1), data[0]); break;
        case 'TPE2': tag.albumArtist = decodeText(data.subarray(1), data[0]); break;
        case 'TALB': tag.album = decodeText(data.subarray(1), data[0]); break;
        case 'TRCK': tag.track = decodeText(data.subarray(1), data[0]); break;
        case 'TYER':
        case 'TDRC': tag.year = decodeText(data.subarray(1), data[0]); break;
        case 'APIC': tag.hasCover = true; break;
      }
    }
    pos = dataEnd;
  }

  tag.rawSize = 10 + tagSize;
  return tag;
}

/** 从 ID3 里提取封面 */
function extractID3Cover(buffer) {
  if (buffer.length < 10 || buffer.toString('latin1', 0, 3) !== 'ID3') return null;

  const version = buffer[3];
  const flags = buffer[5];
  const tagSize = syncSafe(buffer, 6);
  const isV24 = version >= 4;

  let pos = 10;
  if (flags & 0x40) {
    const extSize = isV24 ? syncSafe(buffer, 10) : buffer.readUInt32BE(10) + 4;
    pos += extSize;
  }
  const end = Math.min(10 + tagSize, buffer.length);

  while (pos + 10 <= end) {
    const frameId = buffer.toString('latin1', pos, pos + 4);
    if (!/^[A-Z0-9]{4}$/.test(frameId)) break;
    const frameSize = isV24 ? syncSafe(buffer, pos + 4) : buffer.readUInt32BE(pos + 4);
    const dataStart = pos + 10;
    const dataEnd = dataStart + frameSize;
    if (frameSize <= 0 || dataEnd > buffer.length) break;

    if (frameId === 'APIC') {
      const data = buffer.subarray(dataStart, dataEnd);
      const encoding = data[0];
      let p = 1;
      // MIME 以 \0 结尾
      let mimeEnd = p;
      while (mimeEnd < data.length && data[mimeEnd] !== 0) mimeEnd++;
      const mime = data.toString('latin1', p, mimeEnd) || 'image/jpeg';
      p = mimeEnd + 1;
      p += 1; // picture type
      // description 以编码对应的终止符结尾
      if (encoding === 1 || encoding === 2) {
        while (p + 1 < data.length && !(data[p] === 0 && data[p + 1] === 0)) p += 2;
        p += 2;
      } else {
        while (p < data.length && data[p] !== 0) p++;
        p += 1;
      }
      if (p < data.length) {
        return { mime: mime.split('/')[1] ? mime : 'image/jpeg', data: data.subarray(p) };
      }
    }
    pos = dataEnd;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* FLAC                                                                */
/* ------------------------------------------------------------------ */

function parseFLAC(buffer) {
  if (buffer.length < 4 || buffer.toString('latin1', 0, 4) !== 'fLaC') return null;

  const tag = {
    title: '', artist: '', album: '', albumArtist: '',
    track: '', year: '', hasCover: false
  };

  let pos = 4;
  let last = false;

  while (!last && pos + 4 <= buffer.length) {
    const header = buffer[pos];
    last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const len = (buffer[pos + 1] << 16) | (buffer[pos + 2] << 8) | buffer[pos + 3];
    const dataStart = pos + 4;

    if (type === 4 && dataStart + len <= buffer.length) {
      // VORBIS_COMMENT，小端
      const data = buffer.subarray(dataStart, dataStart + len);
      let p = 0;
      const vendorLen = data.readUInt32LE(p); p += 4 + vendorLen;
      if (p + 4 <= data.length) {
        const count = data.readUInt32LE(p); p += 4;
        for (let i = 0; i < count && p + 4 <= data.length; i++) {
          const l = data.readUInt32LE(p); p += 4;
          if (p + l > data.length) break;
          const entry = data.toString('utf8', p, p + l);
          p += l;
          const eq = entry.indexOf('=');
          if (eq < 0) continue;
          const key = entry.slice(0, eq).toUpperCase();
          const val = entry.slice(eq + 1).trim();
          if (key === 'TITLE') tag.title = val;
          else if (key === 'ARTIST') tag.artist = tag.artist ? tag.artist + ' / ' + val : val;
          else if (key === 'ALBUM') tag.album = val;
          else if (key === 'ALBUMARTIST') tag.albumArtist = val;
          else if (key === 'TRACKNUMBER') tag.track = val;
          else if (key === 'DATE') tag.year = val;
        }
      }
    } else if (type === 6) {
      tag.hasCover = true;
    }

    pos = dataStart + len;
  }
  return tag;
}

function extractFLACCover(buffer) {
  if (buffer.length < 4 || buffer.toString('latin1', 0, 4) !== 'fLaC') return null;
  let pos = 4;
  let last = false;
  while (!last && pos + 4 <= buffer.length) {
    const header = buffer[pos];
    last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const len = (buffer[pos + 1] << 16) | (buffer[pos + 2] << 8) | buffer[pos + 3];
    const dataStart = pos + 4;
    if (type === 6 && dataStart + len <= buffer.length) {
      const data = buffer.subarray(dataStart, dataStart + len);
      let p = 0;
      p += 4;                                  // picture type
      const mimeLen = data.readUInt32BE(p); p += 4;
      const mime = data.toString('latin1', p, p + mimeLen); p += mimeLen;
      const descLen = data.readUInt32BE(p); p += 4 + descLen;
      p += 16;                                 // width/height/depth/colors
      const dataLen = data.readUInt32BE(p); p += 4;
      if (p + dataLen <= data.length) {
        return { mime: mime || 'image/jpeg', data: data.subarray(p, p + dataLen) };
      }
    }
    pos = dataStart + len;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* MP4 / M4A                                                           */
/* ------------------------------------------------------------------ */

function walkAtoms(buf, start, end, cb) {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let headerSize = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      // 64 位长度
      size = Number(buf.readBigUInt64BE(p + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < headerSize) break;
    cb(type, p + headerSize, Math.min(p + size, end));
    p += size;
  }
}

function parseMP4(buffer) {
  const tag = {
    title: '', artist: '', album: '', albumArtist: '',
    track: '', year: '', hasCover: false
  };
  if (buffer.length < 12 || buffer.toString('latin1', 4, 8) !== 'ftyp') return null;

  const readIlst = (start, end) => {
    walkAtoms(buffer, start, end, (type, s, e) => {
      if (type === 'covr') { tag.hasCover = true; return; }
      // data atom 内含实际值
      walkAtoms(buffer, s, e, (t2, s2, e2) => {
        if (t2 !== 'data') return;
        const valueBuf = buffer.subarray(s2 + 8, e2);
        const val = valueBuf.toString('utf8').trim();
        const key = type.replace(/\u00a9/g, '©');
        if (key === '©nam') tag.title = val;
        else if (key === '©ART') tag.artist = val;
        else if (key === 'aART') tag.albumArtist = val;
        else if (key === '©alb') tag.album = val;
        else if (key === '©day') tag.year = val;
        else if (key === 'trkn') tag.track = valueBuf.readUInt16BE(2).toString();
      });
    });
  };

  const scan = (start, end, depth) => {
    if (depth > 6) return;
    walkAtoms(buffer, start, end, (type, s, e) => {
      if (type === 'moov' || type === 'udta' || type === 'trak' || type === 'mdia') {
        scan(s, e, depth + 1);
      } else if (type === 'meta') {
        scan(s + 4, e, depth + 1); // meta 有 4 字节 version/flags
      } else if (type === 'ilst') {
        readIlst(s, e);
      }
    });
  };
  scan(0, buffer.length, 0);
  return tag;
}

function extractMP4Cover(buffer) {
  let result = null;
  const scan = (start, end, depth) => {
    if (depth > 6 || result) return;
    walkAtoms(buffer, start, end, (type, s, e) => {
      if (type === 'moov' || type === 'udta' || type === 'trak' || type === 'mdia') {
        scan(s, e, depth + 1);
      } else if (type === 'meta') {
        scan(s + 4, e, depth + 1);
      } else if (type === 'ilst') {
        walkAtoms(buffer, s, e, (t2, s2, e2) => {
          if (t2 !== 'covr' || result) return;
          walkAtoms(buffer, s2, e2, (t3, s3, e3) => {
            if (t3 !== 'data' || result) return;
            const flag = buffer.readUInt32BE(s3) & 0xffffff;
            const mime = flag === 14 ? 'image/png' : flag === 13 ? 'image/jpeg' : 'image/jpeg';
            result = { mime, data: buffer.subarray(s3 + 8, e3) };
          });
        });
      }
    });
  };
  scan(0, buffer.length, 0);
  return result;
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 读取音频标签（只读文件头，速度快）
 * @returns {{title,artist,album,hasCover,mimeHint}}
 */
function readTags(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    // 标签区通常在前 2MB 内，封面可能更大，读到 4MB 足够
    const maxLen = Math.min(stat.size, 4 * 1024 * 1024);
    const buf = readRange(fd, 0, maxLen);
    const ext = path.extname(filePath).toLowerCase();

    let tag = null;
    if (ext === '.mp3' || ext === '.wav') tag = parseID3(buf);
    else if (ext === '.flac') tag = parseFLAC(buf);
    else if (ext === '.m4a' || ext === '.mp4' || ext === '.aac') tag = parseMP4(buf);

    if (!tag) {
      // 部分 mp3 用 FLAC 头 / m4a 扩展名错位时的兜底
      tag = parseID3(buf) || parseFLAC(buf) || parseMP4(buf);
    }
    return tag;
  } catch (err) {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
}

/** 提取内嵌封面，返回 {mime, data:Buffer} 或 null */
function readCover(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const maxLen = Math.min(stat.size, 20 * 1024 * 1024);
    const buf = readRange(fd, 0, maxLen);
    const ext = path.extname(filePath).toLowerCase();

    let cover = null;
    if (ext === '.mp3' || ext === '.wav') cover = extractID3Cover(buf);
    else if (ext === '.flac') cover = extractFLACCover(buf);
    else if (ext === '.m4a' || ext === '.mp4' || ext === '.aac') cover = extractMP4Cover(buf);

    if (!cover) {
      cover = extractID3Cover(buf) || extractFLACCover(buf) || extractMP4Cover(buf);
    }
    return cover;
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
}

/** 读取同名 .lrc 歌词文件 */
function readSidecarLyric(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const candidates = [
    path.join(dir, base + '.lrc'),
    path.join(dir, base + '.LRC')
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p);
        // 处理 UTF-8 BOM 与 GBK 编码的 lrc
        if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) return raw.toString('utf8', 3);
        const utf8 = raw.toString('utf8');
        if (!/\ufffd/.test(utf8)) return utf8;
        try { return new TextDecoder('gbk').decode(raw); } catch (_) { return utf8; }
      }
    } catch (_) { /* ignore */ }
  }
  return null;
}

/** 读取同名封面图片，或文件夹内的 cover/folder/album 图 */
function readSidecarCover(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const exts = ['.jpg', '.jpeg', '.png', '.webp', '.JPG', '.JPEG', '.PNG'];

  const candidates = [];
  for (const e of exts) candidates.push(path.join(dir, base + e));
  for (const n of ['cover', 'folder', 'album', 'front', 'Cover', 'Folder', 'Album']) {
    for (const e of exts) candidates.push(path.join(dir, n + e));
  }

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        if (stat.size > 0 && stat.size < 12 * 1024 * 1024) {
          const ext = path.extname(p).toLowerCase();
          const mime = ext === '.png' ? 'image/png'
            : ext === '.webp' ? 'image/webp'
            : 'image/jpeg';
          return { mime, data: fs.readFileSync(p) };
        }
      }
    } catch (_) { /* ignore */ }
  }
  return null;
}

/** 只检查是否存在同名封面（不读内容，扫描时用，速度快） */
function hasSidecarCover(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const exts = ['.jpg', '.jpeg', '.png', '.webp'];
  for (const e of exts) {
    try { if (fs.existsSync(path.join(dir, base + e))) return true; } catch (_) {}
  }
  for (const n of ['cover', 'folder', 'album', 'front']) {
    for (const e of exts) {
      try { if (fs.existsSync(path.join(dir, n + e))) return true; } catch (_) {}
    }
  }
  return false;
}

module.exports = { isAudio, readTags, readCover, readSidecarCover, hasSidecarCover, readSidecarLyric, AUDIO_EXTS };
