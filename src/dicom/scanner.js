/**
 * Recursive folder scanner. Walks a directory tree, identifies DICOM files and
 * groups them into the canonical Patient → Study → Series → Instance hierarchy.
 *
 * Only lightweight identifying metadata is extracted per file so that scanning
 * large archives stays reasonably fast. Nothing leaves the machine.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseFile, getTagValue } from './parser.js';

const DICOM_EXTENSIONS = new Set(['.dcm', '.dicom', '.ima', '.img']);

function isProbablyDicom(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(132);
    const bytes = fs.readSync(fd, buf, 0, 132, 0);
    fs.closeSync(fd);
    if (bytes >= 132 &&
        buf[128] === 0x44 && buf[129] === 0x49 &&
        buf[130] === 0x43 && buf[131] === 0x4d) {
      return true;
    }
  } catch {
    return false;
  }
  return DICOM_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function walk(root, out, maxFiles) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= maxFiles) return;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, out, maxFiles);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

function firstValue(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).split('\\')[0].trim();
  return s.length ? s : null;
}

/**
 * Scan a folder tree and build a study index.
 * @returns {{ root, fileCount, dicomCount, skipped, patients, studies, errors }}
 */
export function scanFolder(rootPath, { maxFiles = 20000 } = {}) {
  const abs = path.resolve(rootPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Folder does not exist: ${abs}`);
  }

  const allFiles = [];
  walk(abs, allFiles, maxFiles);

  const patients = new Map();
  const studies = new Map();
  let dicomCount = 0;
  let skipped = 0;
  const errors = [];

  for (const file of allFiles) {
    if (!isProbablyDicom(file)) { skipped++; continue; }

    const parsed = parseFile(file);
    if (!parsed.ok) {
      errors.push({ file, error: parsed.error });
      continue;
    }
    dicomCount++;

    const patientId = firstValue(getTagValue(parsed, '00100020')) || 'UNKNOWN_PATIENT';
    const studyUid = firstValue(getTagValue(parsed, '0020000D')) || 'UNKNOWN_STUDY';
    const seriesUid = firstValue(getTagValue(parsed, '0020000E')) || 'UNKNOWN_SERIES';
    const sopUid = firstValue(getTagValue(parsed, '00080018')) || file;

    if (!patients.has(patientId)) {
      patients.set(patientId, {
        patientId,
        studyUids: new Set(),
      });
    }
    patients.get(patientId).studyUids.add(studyUid);

    if (!studies.has(studyUid)) {
      studies.set(studyUid, {
        studyUid,
        patientId,
        studyDate: firstValue(getTagValue(parsed, '00080020')),
        studyDescription: firstValue(getTagValue(parsed, '00081030')),
        accessionNumber: firstValue(getTagValue(parsed, '00080050')),
        modalities: new Set(),
        series: new Map(),
      });
    }
    const study = studies.get(studyUid);
    const modality = firstValue(getTagValue(parsed, '00080060'));
    if (modality) study.modalities.add(modality);

    if (!study.series.has(seriesUid)) {
      study.series.set(seriesUid, {
        seriesUid,
        seriesNumber: firstValue(getTagValue(parsed, '00200011')),
        seriesDescription: firstValue(getTagValue(parsed, '0008103E')),
        modality,
        transferSyntaxes: new Set(),
        instances: [],
      });
    }
    const series = study.series.get(seriesUid);
    if (parsed.meta.transferSyntaxUid) series.transferSyntaxes.add(parsed.meta.transferSyntaxUid);
    series.instances.push({
      sopInstanceUid: sopUid,
      instanceNumber: firstValue(getTagValue(parsed, '00200013')),
      file,
      rows: firstValue(getTagValue(parsed, '00280010')),
      columns: firstValue(getTagValue(parsed, '00280011')),
      burnedInAnnotation: firstValue(getTagValue(parsed, '00280301')),
    });
  }

  return {
    root: abs,
    fileCount: allFiles.length,
    dicomCount,
    skipped,
    patients,
    studies,
    errors,
  };
}
