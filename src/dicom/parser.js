/**
 * DICOM file parser — a thin, defensive wrapper around `dicom-parser`.
 *
 * Produces a normalized, VR-aware view of a DICOM dataset: a flat-ish list of
 * elements (with nested sequence items) where each element carries its tag,
 * friendly name, VR and a decoded value. Binary blobs (pixel data etc.) are
 * never decoded — only summarized — so this stays fast and memory-light.
 */

import fs from 'node:fs';
import dicomParser from 'dicom-parser';
import { lookupTag, normalizeTag, formatTag } from './dictionary.js';

const STRING_VRS = new Set([
  'AE', 'AS', 'CS', 'DA', 'DS', 'DT', 'IS', 'LO', 'LT',
  'PN', 'SH', 'ST', 'TM', 'UI', 'UT', 'UC', 'UR',
]);

const TRANSFER_SYNTAXES = {
  '1.2.840.10008.1.2': 'Implicit VR Little Endian',
  '1.2.840.10008.1.2.1': 'Explicit VR Little Endian',
  '1.2.840.10008.1.2.1.99': 'Deflated Explicit VR Little Endian',
  '1.2.840.10008.1.2.2': 'Explicit VR Big Endian',
  '1.2.840.10008.1.2.4.50': 'JPEG Baseline (Process 1)',
  '1.2.840.10008.1.2.4.51': 'JPEG Extended (Process 2 & 4)',
  '1.2.840.10008.1.2.4.57': 'JPEG Lossless (Process 14)',
  '1.2.840.10008.1.2.4.70': 'JPEG Lossless (Process 14, SV1)',
  '1.2.840.10008.1.2.4.80': 'JPEG-LS Lossless',
  '1.2.840.10008.1.2.4.81': 'JPEG-LS Lossy',
  '1.2.840.10008.1.2.4.90': 'JPEG 2000 Lossless',
  '1.2.840.10008.1.2.4.91': 'JPEG 2000',
  '1.2.840.10008.1.2.5': 'RLE Lossless',
};

export function transferSyntaxName(uid) {
  return TRANSFER_SYNTAXES[uid] || 'Unknown / private';
}

function readNumbers(dataSet, tag, length, size, method) {
  const count = Math.min(Math.floor(length / size), 32);
  const out = [];
  for (let i = 0; i < count; i++) {
    const v = dataSet[method](tag, i);
    if (v === undefined) break;
    out.push(v);
  }
  return out.join('\\');
}

function readValue(dataSet, element) {
  const tag = element.tag;
  const vr = element.vr || lookupTag(tag)?.vr || 'UN';
  const len = element.length;
  if (len === 0) return '';

  try {
    if (STRING_VRS.has(vr)) {
      const s = dataSet.string(tag);
      return s === undefined || s === null ? '' : s;
    }
    switch (vr) {
      case 'US': return readNumbers(dataSet, tag, len, 2, 'uint16');
      case 'SS': return readNumbers(dataSet, tag, len, 2, 'int16');
      case 'UL': return readNumbers(dataSet, tag, len, 4, 'uint32');
      case 'SL': return readNumbers(dataSet, tag, len, 4, 'int32');
      case 'FL': return readNumbers(dataSet, tag, len, 4, 'float');
      case 'FD': return readNumbers(dataSet, tag, len, 8, 'double');
      case 'AT': return '<attribute tag>';
      case 'SQ': return null;
      case 'OB': case 'OW': case 'OF': case 'OD': case 'UN':
        return `<binary, ${len} bytes>`;
      default: {
        const s = dataSet.string(tag);
        return s === undefined || s === null ? `<${vr}, ${len} bytes>` : s;
      }
    }
  } catch {
    return `<unreadable ${vr}>`;
  }
}

function enumerate(dataSet, depth = 0) {
  const elements = [];
  if (!dataSet || !dataSet.elements) return elements;

  const tags = Object.keys(dataSet.elements).sort();
  for (const key of tags) {
    const element = dataSet.elements[key];
    const norm = normalizeTag(element.tag);
    const dict = lookupTag(norm);
    const vr = element.vr || dict?.vr || 'UN';
    const isSequence = vr === 'SQ' || Array.isArray(element.items);

    const node = {
      tag: norm,
      tagDisplay: formatTag(norm),
      keyword: dict?.keyword || null,
      name: dict?.name || null,
      vr,
      length: element.length,
      depth,
      isSequence,
      value: isSequence ? null : readValue(dataSet, element),
      items: undefined,
    };

    if (isSequence && Array.isArray(element.items)) {
      node.items = element.items.map((item) => enumerate(item.dataSet, depth + 1));
    }
    elements.push(node);
  }
  return elements;
}

/**
 * Parse a DICOM file from disk.
 * @returns {{ filePath, ok, meta, elements, byTag, warnings, error? }}
 */
export function parseFile(filePath) {
  const result = {
    filePath,
    ok: false,
    meta: {},
    elements: [],
    byTag: {},
    warnings: [],
  };

  let byteArray;
  try {
    byteArray = new Uint8Array(fs.readFileSync(filePath));
  } catch (e) {
    result.error = `Cannot read file: ${e.message}`;
    return result;
  }

  // Detect the DICM magic at offset 128 (part-10 preamble).
  const hasPreamble =
    byteArray.length > 132 &&
    byteArray[128] === 0x44 && byteArray[129] === 0x49 &&
    byteArray[130] === 0x43 && byteArray[131] === 0x4d;
  if (!hasPreamble) {
    result.warnings.push('No DICM preamble found — file may be a raw/implicit dataset.');
  }

  let dataSet;
  try {
    dataSet = dicomParser.parseDicom(byteArray);
  } catch (e) {
    // dicom-parser attaches a partial dataSet to some errors.
    if (e && e.dataSet) {
      dataSet = e.dataSet;
      result.warnings.push(`Parsed with recoverable error: ${e.message}`);
    } else {
      result.error = `Not a parseable DICOM file: ${e.message || e}`;
      return result;
    }
  }

  result.elements = enumerate(dataSet);
  for (const el of result.elements) result.byTag[el.tag] = el;

  const tsUid = dataSet.string('x00020010');
  result.meta = {
    transferSyntaxUid: tsUid || null,
    transferSyntaxName: tsUid ? transferSyntaxName(tsUid) : null,
    sopClassUid: dataSet.string('x00080016') || dataSet.string('x00020002') || null,
    sopInstanceUid: dataSet.string('x00080018') || null,
    hasPreamble,
  };
  result.ok = true;
  return result;
}

/** Convenience: decoded value for a single tag from an already-parsed file. */
export function getTagValue(parsed, tag) {
  const el = parsed.byTag?.[normalizeTag(tag)];
  return el ? el.value : null;
}
