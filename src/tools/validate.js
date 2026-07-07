import { z } from 'zod';
import path from 'node:path';
import { parseFile, getTagValue, transferSyntaxName, transferSyntaxInfo } from '../dicom/parser.js';
import { scanFolder } from '../dicom/scanner.js';
import { formatTag, lookupTag } from '../dicom/dictionary.js';
import { renderTagValue, truncate } from './format.js';

// Type-1 / Type-2 attributes that must be present for a conformant image IOD.
const REQUIRED = [
  { tag: '00080016', name: 'SOP Class UID', type: 1 },
  { tag: '00080018', name: 'SOP Instance UID', type: 1 },
  { tag: '0020000D', name: 'Study Instance UID', type: 1 },
  { tag: '0020000E', name: 'Series Instance UID', type: 1 },
  { tag: '00080060', name: 'Modality', type: 1 },
  { tag: '00100010', name: 'Patient Name', type: 2 },
  { tag: '00100020', name: 'Patient ID', type: 2 },
  { tag: '00080020', name: 'Study Date', type: 2 },
  { tag: '00200010', name: 'Study ID', type: 2 },
  { tag: '00200011', name: 'Series Number', type: 2 },
];

function firstVal(v) {
  return v === null || v === undefined ? null : String(v).split('\\')[0].trim();
}

// ---- Study-level comparison helpers -------------------------------------

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** Roll up a single study's series/image/modality/transfer-syntax totals. */
function studyTotals(study) {
  let images = 0;
  const ts = new Set();
  for (const s of study.series.values()) {
    images += s.instances.length;
    for (const t of s.transferSyntaxes) ts.add(t);
  }
  return { series: study.series.size, images, modalities: new Set(study.modalities), transferSyntaxes: ts };
}

/** Roll up an entire scanned folder (which may hold several studies). */
function scanTotals(scan) {
  let series = 0, images = 0;
  const mods = new Set();
  for (const st of scan.studies.values()) {
    const t = studyTotals(st);
    series += t.series;
    images += t.images;
    for (const m of t.modalities) mods.add(m);
  }
  return { studies: scan.studies.size, series, images, modalities: mods, patients: scan.patients.size };
}

/**
 * Structural similarity score between two studies. UID-independent so it still
 * pairs studies correctly after anonymization (which rewrites every UID).
 */
function studyMatchScore(a, b) {
  const ta = studyTotals(a), tb = studyTotals(b);
  const overlap = [...ta.modalities].filter((m) => tb.modalities.has(m)).length;
  let s = overlap;
  if (setsEqual(ta.modalities, tb.modalities)) s += 3;
  if (ta.series === tb.series) s += 2;
  if (ta.images === tb.images) s += 2;
  return s;
}

/** Greedily pair A-side studies to their best structural match on the B side. */
function pairStudies(studiesA, studiesB) {
  const pairs = [];
  const onlyA = [];
  const remaining = new Set(studiesB);
  for (const a of studiesA) {
    let best = null, bestScore = 0;
    for (const b of remaining) {
      const score = studyMatchScore(a, b);
      if (score > bestScore) { best = b; bestScore = score; }
    }
    if (best) { pairs.push([a, best]); remaining.delete(best); }
    else onlyA.push(a);
  }
  return { pairs, onlyA, onlyB: [...remaining] };
}

/** Aggregate a study's series by a UID-independent key (modality + number). */
function seriesAggregate(study) {
  const m = new Map();
  for (const s of study.series.values()) {
    const key = `${s.modality || '?'}#${s.seriesNumber ?? '?'}`;
    if (!m.has(key)) m.set(key, { seriesCount: 0, images: 0, descriptions: new Set() });
    const e = m.get(key);
    e.seriesCount++;
    e.images += s.instances.length;
    if (s.seriesDescription) e.descriptions.add(s.seriesDescription);
  }
  return m;
}

function shortUid(uid) {
  return uid && uid.length > 16 ? `…${uid.slice(-16)}` : (uid || '(none)');
}

/**
 * Build a study-level diff between two already-scanned folders.
 * Pure (no I/O) so it can be unit/smoke tested directly.
 * @returns {{ text: string, structurePreserved: boolean, uidsChanged: boolean }}
 */
export function compareStudyScans(scanA, scanB) {
  const ta = scanTotals(scanA);
  const tb = scanTotals(scanB);
  const mark = (x, y) => (x === y ? '✓' : '⚠');
  const modsA = [...ta.modalities].sort().join('/') || '?';
  const modsB = [...tb.modalities].sort().join('/') || '?';

  let out = `## Study-level comparison\n`;
  out += `- A: ${scanA.root} — ${ta.studies} study, ${ta.series} series, ${ta.images} images\n`;
  out += `- B: ${scanB.root} — ${tb.studies} study, ${tb.series} series, ${tb.images} images\n`;
  if (scanA.errors.length || scanB.errors.length) {
    out += `- Parse errors: A=${scanA.errors.length}, B=${scanB.errors.length}\n`;
  }

  out += `\n### Aggregate\n| Metric | A | B | |\n|--------|---|---|---|\n`;
  out += `| Studies | ${ta.studies} | ${tb.studies} | ${mark(ta.studies, tb.studies)} |\n`;
  out += `| Series | ${ta.series} | ${tb.series} | ${mark(ta.series, tb.series)} |\n`;
  out += `| Images | ${ta.images} | ${tb.images} | ${mark(ta.images, tb.images)} |\n`;
  out += `| Modalities | ${modsA} | ${modsB} | ${setsEqual(ta.modalities, tb.modalities) ? '✓' : '⚠'} |\n`;
  out += `| Patients | ${ta.patients} | ${tb.patients} | ${mark(ta.patients, tb.patients)} |\n`;

  const modsOnlyA = [...ta.modalities].filter((m) => !tb.modalities.has(m));
  const modsOnlyB = [...tb.modalities].filter((m) => !ta.modalities.has(m));
  if (modsOnlyA.length) out += `\n⚠ Modalities only in A: ${modsOnlyA.join(', ')}\n`;
  if (modsOnlyB.length) out += `⚠ Modalities only in B: ${modsOnlyB.join(', ')}\n`;

  // Pair studies structurally (UID-independent) and diff each pair.
  const { pairs, onlyA, onlyB } = pairStudies([...scanA.studies.values()], [...scanB.studies.values()]);

  let structurePreserved = onlyA.length === 0 && onlyB.length === 0;
  let uidsChanged = false;

  pairs.forEach(([a, b], i) => {
    const pa = studyTotals(a), pb = studyTotals(b);
    const uidSame = a.studyUid === b.studyUid;
    if (!uidSame) uidsChanged = true;
    const seriesMatch = pa.series === pb.series;
    const imagesMatch = pa.images === pb.images;
    const modsMatch = setsEqual(pa.modalities, pb.modalities);
    if (!seriesMatch || !imagesMatch || !modsMatch) structurePreserved = false;

    out += `\n### Study pair ${i + 1}\n`;
    out += `| Attribute | A | B | |\n|-----------|---|---|---|\n`;
    out += `| Study UID | ${shortUid(a.studyUid)} | ${shortUid(b.studyUid)} | ${uidSame ? '✓ same' : '✎ changed'} |\n`;
    out += `| Patient ID | ${a.patientId ? 'set' : '(none)'} | ${b.patientId ? 'set' : '(none)'} | ${a.patientId === b.patientId ? '✓ same' : '✎ changed'} |\n`;
    out += `| Accession | ${a.accessionNumber ? 'set' : '(none)'} | ${b.accessionNumber ? 'set' : '(none)'} | ${a.accessionNumber === b.accessionNumber ? '✓ same' : '✎ changed'} |\n`;
    out += `| Study Date | ${a.studyDate || '(none)'} | ${b.studyDate || '(none)'} | ${a.studyDate === b.studyDate ? '✓' : '✎'} |\n`;
    out += `| Description | ${truncate(a.studyDescription || '(none)', 24)} | ${truncate(b.studyDescription || '(none)', 24)} | ${a.studyDescription === b.studyDescription ? '✓' : '✎'} |\n`;
    out += `| Modalities | ${[...pa.modalities].sort().join('/') || '?'} | ${[...pb.modalities].sort().join('/') || '?'} | ${modsMatch ? '✓' : '⚠'} |\n`;
    out += `| Series | ${pa.series} | ${pb.series} | ${seriesMatch ? '✓' : '⚠'} |\n`;
    out += `| Images | ${pa.images} | ${pb.images} | ${imagesMatch ? '✓' : '⚠'} |\n`;

    // Series-level breakdown, matched by modality + series number.
    const aggA = seriesAggregate(a);
    const aggB = seriesAggregate(b);
    const keys = [...new Set([...aggA.keys(), ...aggB.keys()])].sort();
    const rows = [];
    for (const key of keys) {
      const ea = aggA.get(key);
      const eb = aggB.get(key);
      const imgA = ea?.images ?? 0;
      const imgB = eb?.images ?? 0;
      const flag = !ea ? '＋ only B' : !eb ? '－ only A' : imgA === imgB ? '✓' : `Δ ${imgB - imgA}`;
      rows.push({ key, imgA, imgB, flag });
    }
    const mism = rows.filter((r) => r.flag !== '✓');
    if (mism.length) {
      out += `\n**Series differences (modality#seriesNumber):**\n| Series | A images | B images | |\n|--------|----------|----------|---|\n`;
      for (const r of mism) out += `| ${r.key} | ${r.imgA} | ${r.imgB} | ${r.flag} |\n`;
    } else {
      out += `\nAll ${rows.length} series match by modality/number and image count. ✓\n`;
    }
  });

  if (onlyA.length) {
    out += `\n### Studies only in A (${onlyA.length})\n`;
    for (const st of onlyA) {
      const t = studyTotals(st);
      out += `- [${[...t.modalities].join('/') || '?'}] ${truncate(st.studyDescription || '(none)', 40)} — ${t.series} series, ${t.images} images\n`;
    }
  }
  if (onlyB.length) {
    out += `\n### Studies only in B (${onlyB.length})\n`;
    for (const st of onlyB) {
      const t = studyTotals(st);
      out += `- [${[...t.modalities].join('/') || '?'}] ${truncate(st.studyDescription || '(none)', 40)} — ${t.series} series, ${t.images} images\n`;
    }
  }

  out += `\n### Verdict\n`;
  if (structurePreserved) {
    out += `✅ Structure preserved: same modalities, series, and image counts across all paired studies.\n`;
    out += uidsChanged
      ? `- UIDs were changed (expected for a de-identification/anonymization round-trip).\n`
      : `- UIDs are identical (consistent with a straight copy/migration).\n`;
  } else {
    out += `⚠ Structural differences detected — review the tables above. This may indicate an incomplete migration or unintended data loss during de-identification.\n`;
  }
  out += `\n> Note: this compares metadata structure only. It does NOT compare pixel data or detect burned-in PHI.\n`;

  return { text: out, structurePreserved, uidsChanged };
}

// ---- Transfer syntax / compression report ------------------------------

/**
 * Summarize compression (transfer syntaxes) across a scanned folder and flag
 * any that a target PACS is configured to reject.
 *
 * Pure (no I/O). `accepted` is an optional list of transfer syntax UIDs or
 * friendly-name substrings the target PACS supports (case-insensitive).
 * @returns {{ text: string, unacceptedFiles: number, lossyFiles: number }}
 */
export function buildTransferSyntaxReport(scan, { accepted } = {}) {
  // Normalize the accept-list to lowercase for substring/UID matching.
  const acceptList = (accepted || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const hasAcceptList = acceptList.length > 0;
  const isAccepted = (uid, name) => {
    if (!hasAcceptList) return true;
    const u = (uid || '').toLowerCase();
    const n = (name || '').toLowerCase();
    return acceptList.some((a) => a === u || (n && n.includes(a)));
  };

  // Tally files per transfer syntax UID.
  const counts = new Map(); // uid -> count
  let total = 0;
  for (const study of scan.studies.values()) {
    for (const series of study.series.values()) {
      for (const inst of series.instances) {
        const uid = inst.transferSyntaxUid || '(none)';
        counts.set(uid, (counts.get(uid) || 0) + 1);
        total++;
      }
    }
  }

  const rows = [...counts.entries()].map(([uid, count]) => {
    const info = uid === '(none)'
      ? { uid, name: 'Missing (no meta header)', category: 'unknown', lossy: false }
      : transferSyntaxInfo(uid);
    return { ...info, uid, count, accepted: isAccepted(uid, info.name) };
  }).sort((a, b) => b.count - a.count);

  const pct = (n) => (total ? ((n / total) * 100).toFixed(1) : '0.0');
  const catIcon = { uncompressed: '📦', lossless: '🗜', lossy: '⚠', unknown: '❓' };

  let out = `## Transfer syntax report\n- Folder: ${scan.root}\n- Files analyzed: ${total} across ${scan.studies.size} study(ies)\n`;
  if (scan.errors.length) out += `- Parse errors (excluded): ${scan.errors.length}\n`;

  out += `\n| Transfer syntax | UID | Files | % | Category |${hasAcceptList ? ' Accepted |' : ''}\n`;
  out += `|-----------------|-----|-------|---|----------|${hasAcceptList ? '----------|' : ''}\n`;
  for (const r of rows) {
    const cat = `${catIcon[r.category] || ''} ${r.category}`;
    out += `| ${r.name} | ${r.uid} | ${r.count} | ${pct(r.count)}% | ${cat} |`;
    out += hasAcceptList ? ` ${r.accepted ? '✓' : '❌ reject'} |\n` : `\n`;
  }

  // Compression rollup.
  const sumBy = (cat) => rows.filter((r) => r.category === cat).reduce((s, r) => s + r.count, 0);
  const uncompressed = sumBy('uncompressed');
  const lossless = sumBy('lossless');
  const lossyFiles = sumBy('lossy');
  const unknown = sumBy('unknown');
  out += `\n### Compression breakdown\n`;
  out += `- 📦 Uncompressed: ${uncompressed} (${pct(uncompressed)}%)\n`;
  out += `- 🗜 Compressed lossless: ${lossless} (${pct(lossless)}%)\n`;
  out += `- ⚠ Compressed lossy: ${lossyFiles} (${pct(lossyFiles)}%)\n`;
  if (unknown) out += `- ❓ Unknown/private/missing: ${unknown} (${pct(unknown)}%)\n`;

  if (lossyFiles) {
    out += `\n⚠ ${lossyFiles} file(s) use **lossy** compression — pixel data is irreversibly degraded; confirm this is acceptable for diagnostic/archival use.\n`;
  }

  // PACS acceptance flagging.
  const rejected = rows.filter((r) => !r.accepted);
  const unacceptedFiles = rejected.reduce((s, r) => s + r.count, 0);
  if (hasAcceptList) {
    out += `\n### Target PACS acceptance\n`;
    if (unacceptedFiles === 0) {
      out += `✅ All ${total} file(s) use transfer syntaxes the target PACS accepts.\n`;
    } else {
      out += `❌ ${unacceptedFiles} file(s) use transfer syntaxes the target PACS will **reject** — transcode before sending:\n`;
      for (const r of rejected) out += `- ${r.name} (${r.uid}): ${r.count} file(s)\n`;
    }
  }

  return { text: out, unacceptedFiles, lossyFiles };
}

// ---- Cross-file (study-level) conformance helpers ----------------------

/** Parse a backslash-delimited numeric multi-value (e.g. ImagePositionPatient). */
function numList(v) {
  if (v === null || v === undefined) return [];
  return String(v)
    .split('\\')
    .map((s) => parseFloat(s.trim()))
    .filter((n) => Number.isFinite(n));
}

/** True when every number in the list is within `tol` of the first. */
function nearlyEqualSpacing(deltas, tol) {
  if (deltas.length === 0) return true;
  const ref = deltas[0];
  return deltas.every((d) => Math.abs(d - ref) <= tol);
}

/**
 * Run cross-file conformance checks over a single scanned study. These catch
 * PACS-ingestion failures that a per-file check cannot see: split frames of
 * reference, missing slices, irregular spacing, duplicate/absent identifiers.
 *
 * Pure (no I/O) so it can be unit/smoke tested directly.
 * @returns {{ issues: string[], warnings: string[], info: string[] }}
 */
export function validateStudyCrossFile(study) {
  const issues = [];
  const warnings = [];
  const info = [];

  // Duplicate SOP Instance UIDs across the whole study (all series).
  const sopSeen = new Map(); // sop -> count
  for (const series of study.series.values()) {
    for (const inst of series.instances) {
      const sop = inst.sopInstanceUid;
      if (!sop) continue;
      sopSeen.set(sop, (sopSeen.get(sop) || 0) + 1);
    }
  }
  const dupSops = [...sopSeen.entries()].filter(([, n]) => n > 1);
  if (dupSops.length) {
    issues.push(
      `${dupSops.length} duplicate SOP Instance UID(s) within the study — PACS will reject or silently drop the re-sent instances (e.g. ${shortUid(dupSops[0][0])} appears ${dupSops[0][1]}×).`
    );
  }

  // Frame of Reference UIDs seen across the whole study (for orphan detection).
  const studyForCounts = new Map(); // FoR -> number of series using it
  for (const series of study.series.values()) {
    const seriesFors = new Set(series.instances.map((i) => i.frameOfReferenceUid).filter(Boolean));
    for (const f of seriesFors) studyForCounts.set(f, (studyForCounts.get(f) || 0) + 1);
  }

  for (const series of study.series.values()) {
    const insts = series.instances;
    const label = `Series ${series.seriesNumber ?? '?'} [${series.modality || '?'}]`;

    // Orphaned series: hierarchy identifiers never resolved during ingestion.
    if (series.seriesUid === 'UNKNOWN_SERIES' || !series.seriesUid) {
      issues.push(`${label}: ${insts.length} instance(s) have no Series Instance UID (0020,000E) — orphaned, cannot be grouped by any PACS.`);
    }

    // Inconsistent FrameOfReferenceUID within the series.
    const fors = new Set(insts.map((i) => i.frameOfReferenceUid).filter(Boolean));
    if (fors.size > 1) {
      issues.push(`${label}: inconsistent FrameOfReferenceUID (0020,0052) — ${fors.size} distinct values across ${insts.length} instances, which breaks 3D reconstruction and spatial registration.`);
    } else if (fors.size === 1 && studyForCounts.size > 1 && studyForCounts.get([...fors][0]) === 1) {
      // A series whose FoR is shared by no other series in a multi-frame-of-reference study.
      warnings.push(`${label}: uses a FrameOfReferenceUID not shared by any other series — may be an orphaned/misregistered series if co-registration was expected.`);
    }

    // Gaps and duplicates in InstanceNumber.
    const nums = insts
      .map((i) => parseInt(i.instanceNumber, 10))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    if (nums.length >= 2) {
      const seen = new Set();
      const dupNums = new Set();
      for (const n of nums) {
        if (seen.has(n)) dupNums.add(n);
        seen.add(n);
      }
      const missing = [];
      for (let n = nums[0]; n <= nums[nums.length - 1]; n++) {
        if (!seen.has(n)) missing.push(n);
      }
      if (dupNums.size) {
        issues.push(`${label}: duplicate InstanceNumber(s) ${[...dupNums].slice(0, 8).join(', ')}${dupNums.size > 8 ? '…' : ''} — ordering is ambiguous.`);
      }
      if (missing.length) {
        const preview = missing.slice(0, 8).join(', ');
        issues.push(`${label}: ${missing.length} gap(s) in InstanceNumber (${nums[0]}–${nums[nums.length - 1]}); missing ${preview}${missing.length > 8 ? '…' : ''} — likely dropped slices during transfer.`);
      }
    } else if (insts.length > 1 && nums.length < insts.length) {
      warnings.push(`${label}: ${insts.length - nums.length} instance(s) missing InstanceNumber (0020,0013) — cannot verify ordering completeness.`);
    }

    // Mismatched SliceThickness within the series.
    const thick = new Set(insts.map((i) => i.sliceThickness).filter((v) => v !== null && v !== undefined));
    if (thick.size > 1) {
      issues.push(`${label}: mixed SliceThickness (0018,0050) values ${[...thick].slice(0, 6).join(', ')} — inconsistent acquisition geometry.`);
    }

    // Irregular slice spacing from ImagePositionPatient (z-axis heuristic).
    const zs = insts
      .map((i) => numList(i.imagePositionPatient))
      .filter((p) => p.length === 3)
      .map((p) => p[2])
      .sort((a, b) => a - b);
    if (zs.length >= 3) {
      const deltas = [];
      for (let k = 1; k < zs.length; k++) deltas.push(+(zs[k] - zs[k - 1]).toFixed(4));
      const ref = deltas[0];
      const tol = Math.max(0.01, Math.abs(ref) * 0.1); // 10% or 0.01mm, whichever larger
      if (!nearlyEqualSpacing(deltas, tol)) {
        const minD = Math.min(...deltas), maxD = Math.max(...deltas);
        issues.push(`${label}: irregular slice spacing from ImagePositionPatient (0020,0032) — Δz ranges ${minD}–${maxD} mm; expected uniform spacing (missing slices or non-uniform acquisition).`);
      } else {
        info.push(`${label}: ${zs.length} slices, uniform Δz ≈ ${Math.abs(ref)} mm.`);
      }
    }
  }

  return { issues, warnings, info };
}

/**
 * Format a full cross-file conformance report for one or more studies.
 * Pure; returns { text, issueCount }.
 */
export function formatStudyValidation(studies, header) {
  let out = `## Cross-file conformance report\n${header}\n`;
  let issueCount = 0;

  for (const study of studies) {
    let nInst = 0;
    for (const s of study.series.values()) nInst += s.instances.length;
    const { issues, warnings, info } = validateStudyCrossFile(study);
    issueCount += issues.length;

    out += `\n### Study …${(study.studyUid || '?').slice(-16)} — ${truncate(study.studyDescription || '(no description)', 40)}\n`;
    out += `- ${study.series.size} series, ${nInst} images, modalities: ${[...study.modalities].join('/') || '?'}\n`;

    if (issues.length) {
      out += `\n**❌ ${issues.length} issue(s):**\n`;
      for (const i of issues) out += `- ${i}\n`;
    } else {
      out += `\n**✅ No cross-file issues detected.**\n`;
    }
    if (warnings.length) {
      out += `\n**⚠ ${warnings.length} warning(s):**\n`;
      for (const w of warnings) out += `- ${w}\n`;
    }
    if (info.length) {
      out += `\n<details><summary>Info (${info.length})</summary>\n\n`;
      for (const i of info) out += `- ${i}\n`;
      out += `\n</details>\n`;
    }
  }

  return { text: out, issueCount };
}

export function registerValidateTools(server, ctx) {
  server.tool(
    'validate_conformance',
    'Check a DICOM file for common conformance problems: missing required attributes, unknown/absent transfer syntax, and inconsistent pixel-encoding tags (BitsAllocated/BitsStored/HighBit). Explains WHY a study might fail to load.',
    {
      file: z.string().describe('Path to a .dcm file'),
    },
    async ({ file }) => {
      const parsed = parseFile(file);
      if (!parsed.ok) return { content: [{ type: 'text', text: `Cannot parse: ${parsed.error}` }], isError: true };

      const issues = [];
      const info = [];

      // Transfer syntax
      const ts = parsed.meta.transferSyntaxUid;
      if (!ts) {
        issues.push('No Transfer Syntax UID (0002,0010) — meta header may be missing; many viewers will refuse the file.');
      } else if (transferSyntaxName(ts) === 'Unknown / private') {
        issues.push(`Transfer Syntax ${ts} is unknown/private — viewers without the matching codec cannot decode pixel data.`);
      } else {
        info.push(`Transfer Syntax: ${transferSyntaxName(ts)}`);
      }

      // Required attributes
      for (const req of REQUIRED) {
        const el = parsed.byTag[req.tag];
        const present = !!el;
        const value = present ? firstVal(el.value) : null;
        if (!present) {
          issues.push(`Missing Type-${req.type} attribute ${formatTag(req.tag)} ${req.name}.`);
        } else if (req.type === 1 && !value) {
          issues.push(`Type-1 attribute ${formatTag(req.tag)} ${req.name} is present but empty (Type-1 requires a value).`);
        }
      }

      // Pixel encoding consistency (only if pixel data present)
      const hasPixels = !!parsed.byTag['7FE00010'];
      if (hasPixels) {
        const rows = firstVal(getTagValue(parsed, '00280010'));
        const cols = firstVal(getTagValue(parsed, '00280011'));
        const bitsAlloc = parseInt(firstVal(getTagValue(parsed, '00280100')) ?? 'NaN', 10);
        const bitsStored = parseInt(firstVal(getTagValue(parsed, '00280101')) ?? 'NaN', 10);
        const highBit = parseInt(firstVal(getTagValue(parsed, '00280102')) ?? 'NaN', 10);
        const photometric = firstVal(getTagValue(parsed, '00280004'));

        if (!rows || !cols) issues.push('Pixel Data present but Rows (0028,0010) or Columns (0028,0011) missing.');
        if (!photometric) issues.push('Pixel Data present but Photometric Interpretation (0028,0004) missing.');
        if (!Number.isNaN(bitsAlloc) && !Number.isNaN(bitsStored) && bitsStored > bitsAlloc) {
          issues.push(`Bits Stored (${bitsStored}) exceeds Bits Allocated (${bitsAlloc}) — invalid pixel encoding.`);
        }
        if (!Number.isNaN(bitsStored) && !Number.isNaN(highBit) && highBit !== bitsStored - 1) {
          issues.push(`High Bit (${highBit}) != Bits Stored - 1 (${bitsStored - 1}) — a known vendor quirk that some viewers reject.`);
        }
        if (!Number.isNaN(bitsAlloc) && bitsAlloc !== 8 && bitsAlloc !== 16 && bitsAlloc !== 1) {
          issues.push(`Unusual Bits Allocated (${bitsAlloc}); expected 1, 8, or 16.`);
        }
      }

      let out = `## Conformance report: ${path.basename(file)}\n\n`;
      if (parsed.warnings.length) for (const w of parsed.warnings) out += `- ⚠ ${w}\n`;
      out += issues.length ? `\n### ❌ ${issues.length} issue(s) found\n` : `\n### ✅ No conformance issues detected\n`;
      for (const i of issues) out += `- ${i}\n`;
      if (info.length) { out += `\n### Info\n`; for (const i of info) out += `- ${i}\n`; }
      return { content: [{ type: 'text', text: out }] };
    }
  );

  server.tool(
    'diff_metadata',
    'Compare the metadata of two DICOM files and report tags that were added, removed, or changed. Ideal for diagnosing vendor/scanner differences and integration bugs. PHI values are masked.',
    {
      fileA: z.string().describe('Path to first .dcm file'),
      fileB: z.string().describe('Path to second .dcm file'),
      allowRaw: z.boolean().optional().default(false).describe('Request raw PHI values (only honored if server allows it)'),
    },
    async ({ fileA, fileB, allowRaw }) => {
      const a = parseFile(fileA);
      const b = parseFile(fileB);
      if (!a.ok) return { content: [{ type: 'text', text: `Cannot parse A: ${a.error}` }], isError: true };
      if (!b.ok) return { content: [{ type: 'text', text: `Cannot parse B: ${b.error}` }], isError: true };

      const tags = new Set([...Object.keys(a.byTag), ...Object.keys(b.byTag)]);
      const added = [], removed = [], changed = [];

      for (const tag of [...tags].sort()) {
        const ea = a.byTag[tag];
        const eb = b.byTag[tag];
        const name = lookupTag(tag)?.name || 'Unknown';
        if (ea && !eb) { removed.push({ tag, name }); continue; }
        if (!ea && eb) { added.push({ tag, name }); continue; }
        if (ea.isSequence || eb.isSequence) continue;
        if (String(ea.value) !== String(eb.value)) {
          const va = renderTagValue(ctx, tag, ea.value, { allowRaw });
          const vb = renderTagValue(ctx, tag, eb.value, { allowRaw });
          changed.push({ tag, name, a: va.display, b: vb.display });
        }
      }

      let out = `## Metadata diff\n- A: ${path.basename(fileA)}\n- B: ${path.basename(fileB)}\n\n`;
      out += `Changed: ${changed.length} | Only in A: ${removed.length} | Only in B: ${added.length}\n`;

      if (changed.length) {
        out += `\n### Changed values\n| Tag | Name | A | B |\n|-----|------|---|---|\n`;
        for (const c of changed) out += `| ${formatTag(c.tag)} | ${c.name} | ${truncate(c.a, 30)} | ${truncate(c.b, 30)} |\n`;
      }
      if (removed.length) {
        out += `\n### Only in A\n`;
        for (const r of removed) out += `- ${formatTag(r.tag)} ${r.name}\n`;
      }
      if (added.length) {
        out += `\n### Only in B\n`;
        for (const ad of added) out += `- ${formatTag(ad.tag)} ${ad.name}\n`;
      }
      return { content: [{ type: 'text', text: out }] };
    }
  );

  server.tool(
    'compare_studies',
    'Study-LEVEL diff between two folders (not just two files): compares modalities, series counts, and image counts. Series are matched structurally (modality + series number), so it still works when UIDs were rewritten by anonymization. Ideal for verifying a migration copied everything, or that a de-identification round-trip preserved structure while changing identifiers. PHI identifiers are reported as same/changed only.',
    {
      folderA: z.string().describe('First study folder (e.g. the original / source)'),
      folderB: z.string().describe('Second study folder (e.g. migrated / de-identified output)'),
      maxFiles: z.number().optional().default(5000).describe('Max files to scan per folder (default 5000)'),
    },
    async ({ folderA, folderB, maxFiles }) => {
      let scanA, scanB;
      try { scanA = scanFolder(folderA, { maxFiles }); }
      catch (e) { return { content: [{ type: 'text', text: `Cannot scan A: ${e.message}` }], isError: true }; }
      try { scanB = scanFolder(folderB, { maxFiles }); }
      catch (e) { return { content: [{ type: 'text', text: `Cannot scan B: ${e.message}` }], isError: true }; }

      if (scanA.dicomCount === 0) return { content: [{ type: 'text', text: `No DICOM files found in A: ${scanA.root}` }] };
      if (scanB.dicomCount === 0) return { content: [{ type: 'text', text: `No DICOM files found in B: ${scanB.root}` }] };

      const { text } = compareStudyScans(scanA, scanB);
      return { content: [{ type: 'text', text }] };
    }
  );

  server.tool(
    'validate_study',
    'Cross-file (study-LEVEL) conformance check that catches real-world PACS ingestion failures a single-file check cannot see: inconsistent FrameOfReferenceUID within a series, gaps or duplicates in InstanceNumber, mismatched SliceThickness, irregular slice spacing (from ImagePositionPatient), duplicate SOP Instance UIDs, and orphaned series (missing Series/Study UID). Scans a folder (or validates an already-scanned study by UID).',
    {
      path: z.string().optional().describe('Folder to scan and validate (all studies found). Omit to use a previously scanned study via studyUid.'),
      studyUid: z.string().optional().describe('Validate a single already-scanned study by full or trailing Study Instance UID.'),
      maxFiles: z.number().optional().default(5000).describe('Max files to scan when a folder path is given (default 5000)'),
    },
    async ({ path: folder, studyUid, maxFiles }) => {
      let studies;
      let header;

      if (studyUid) {
        const found = ctx.index.findStudy(studyUid);
        if (!found) return { content: [{ type: 'text', text: `Study not found: ${studyUid}. Run scan_folder or pass a "path".` }], isError: true };
        studies = [found.study];
        header = `- Study: …${found.study.studyUid.slice(-16)} (${found.root})`;
      } else if (folder) {
        let scan;
        try { scan = ctx.index.scan(folder, { maxFiles }); }
        catch (e) { return { content: [{ type: 'text', text: `Cannot scan: ${e.message}` }], isError: true }; }
        if (scan.dicomCount === 0) return { content: [{ type: 'text', text: `No DICOM files found in: ${scan.root}` }] };
        studies = [...scan.studies.values()];
        header = `- Folder: ${scan.root} — ${scan.studies.size} study(ies), ${scan.dicomCount} images${scan.errors.length ? `, ${scan.errors.length} parse error(s)` : ''}`;
      } else {
        return { content: [{ type: 'text', text: 'Provide either "path" (a folder to scan) or "studyUid" (a previously scanned study).' }], isError: true };
      }

      const { text, issueCount } = formatStudyValidation(studies, header);
      const summary = issueCount ? `\n---\n**${issueCount} cross-file issue(s) total.**\n` : `\n---\n**All studies passed cross-file checks.**\n`;
      return { content: [{ type: 'text', text: text + summary }] };
    }
  );

  server.tool(
    'transfer_syntax_report',
    'Summarize compression (transfer syntaxes) across a folder: how many files are uncompressed vs JPEG 2000 / JPEG / RLE, with a lossy-vs-lossless breakdown. Optionally flags files whose transfer syntax a target PACS will not accept, so you know what to transcode before sending.',
    {
      path: z.string().optional().describe('Folder to scan (defaults to the most recent scan).'),
      accepted: z.array(z.string()).optional().describe('Transfer syntaxes the TARGET PACS accepts — UIDs (e.g. 1.2.840.10008.1.2.1) or name substrings (e.g. "JPEG 2000", "Explicit VR"). Files using anything else are flagged for transcoding.'),
      maxFiles: z.number().optional().default(5000).describe('Max files to scan when a folder path is given (default 5000)'),
    },
    async ({ path: folder, accepted, maxFiles }) => {
      let scan;
      if (folder) {
        try { scan = ctx.index.scan(folder, { maxFiles }); }
        catch (e) { return { content: [{ type: 'text', text: `Cannot scan: ${e.message}` }], isError: true }; }
      } else {
        scan = ctx.index.getScan();
        if (!scan) return { content: [{ type: 'text', text: 'No scan available. Provide "path" or run scan_folder first.' }], isError: true };
      }
      if (scan.dicomCount === 0) return { content: [{ type: 'text', text: `No DICOM files found in: ${scan.root}` }] };

      const { text } = buildTransferSyntaxReport(scan, { accepted });
      return { content: [{ type: 'text', text }] };
    }
  );
}