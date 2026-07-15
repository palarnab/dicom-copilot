/**
 * Smoke test — verifies the DICOM Copilot pipeline end to end without needing
 * a real MCP client or real patient data. It:
 *   1. Generates a minimal synthetic DICOM file (Explicit VR Little Endian).
 *   2. Parses it and checks key tags decode correctly.
 *   3. Runs a folder scan and builds the study hierarchy.
 *   4. Exercises PHI detection helpers.
 *   5. Registers every MCP tool to catch schema/wiring errors.
 *   6. Pings the PII service (non-fatal if it's down).
 *
 * Run: npm run test:smoke
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { parseFile, getTagValue, extractElementBytes } from '../src/dicom/parser.js';
import { scanFolder } from '../src/dicom/scanner.js';
import { getPhiInfo } from '../src/dicom/phi-tags.js';
import { DatasetIndex } from '../src/dicom/dataset.js';
import { PiiClient } from '../src/services/pii-client.js';
import { registerExploreTools } from '../src/tools/explore.js';
import { registerValidateTools, compareStudyScans, validateStudyCrossFile, buildTransferSyntaxReport } from '../src/tools/validate.js';import { registerPhiTools, deidentifyFileToCopy } from '../src/tools/phi.js';
import { registerExportTools } from '../src/tools/export.js';
import { registerReportTools, detectReportKind, collectSr } from '../src/tools/report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.resolve(__dirname, '../test-data');
const TEST_FILE = path.join(TEST_DIR, 'synthetic.dcm');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// ---- Minimal DICOM (Explicit VR Little Endian) writer -------------------
const LONG_VRS = new Set(['OB', 'OW', 'OF', 'OD', 'SQ', 'UT', 'UN', 'UC', 'UR']);

function strVal(vr, s) {
  let buf = Buffer.from(s, 'latin1');
  if (buf.length % 2 !== 0) buf = Buffer.concat([buf, Buffer.from([vr === 'UI' ? 0x00 : 0x20])]);
  return buf;
}
function us(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; }
function ul(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; }

function encElem(group, element, vr, valueBuf) {
  if (LONG_VRS.has(vr)) {
    const h = Buffer.alloc(12);
    h.writeUInt16LE(group, 0); h.writeUInt16LE(element, 2);
    h.write(vr, 4, 'ascii'); h.writeUInt32LE(valueBuf.length, 8);
    return Buffer.concat([h, valueBuf]);
  }
  const h = Buffer.alloc(8);
  h.writeUInt16LE(group, 0); h.writeUInt16LE(element, 2);
  h.write(vr, 4, 'ascii'); h.writeUInt16LE(valueBuf.length, 6);
  return Buffer.concat([h, valueBuf]);
}

function buildSyntheticDicom() {
  const ts = '1.2.840.10008.1.2.1'; // Explicit VR LE
  const sopClass = '1.2.840.10008.5.1.4.1.1.2'; // CT Image Storage
  const sopInst = '1.2.3.4.5.6.7.8.9.0';

  // Meta elements (excluding group length), always Explicit VR LE.
  const metaBody = Buffer.concat([
    encElem(0x0002, 0x0002, 'UI', strVal('UI', sopClass)),
    encElem(0x0002, 0x0003, 'UI', strVal('UI', sopInst)),
    encElem(0x0002, 0x0010, 'UI', strVal('UI', ts)),
    encElem(0x0002, 0x0012, 'UI', strVal('UI', '1.2.826.0.1.3680043.9.9999')),
  ]);
  const meta = Buffer.concat([
    encElem(0x0002, 0x0000, 'UL', ul(metaBody.length)),
    metaBody,
  ]);

  const dataset = Buffer.concat([
    encElem(0x0008, 0x0016, 'UI', strVal('UI', sopClass)),
    encElem(0x0008, 0x0018, 'UI', strVal('UI', sopInst)),
    encElem(0x0008, 0x0020, 'DA', strVal('DA', '20260115')),
    encElem(0x0008, 0x0060, 'CS', strVal('CS', 'CT')),
    encElem(0x0008, 0x1030, 'LO', strVal('LO', 'CT CHEST for John Smith')),
    encElem(0x0010, 0x0010, 'PN', strVal('PN', 'SMITH^JOHN')),
    encElem(0x0010, 0x0020, 'LO', strVal('LO', 'MRN123456')),
    encElem(0x0010, 0x0030, 'DA', strVal('DA', '19800101')),
    encElem(0x0020, 0x000D, 'UI', strVal('UI', '1.2.3.4.5')),
    encElem(0x0020, 0x000E, 'UI', strVal('UI', '1.2.3.4.5.6')),
    encElem(0x0020, 0x0010, 'SH', strVal('SH', 'S1')),
    encElem(0x0020, 0x0011, 'IS', strVal('IS', '1')),
    encElem(0x0020, 0x0013, 'IS', strVal('IS', '1')),
    encElem(0x0028, 0x0004, 'CS', strVal('CS', 'MONOCHROME2')),
    encElem(0x0028, 0x0010, 'US', us(512)),
    encElem(0x0028, 0x0011, 'US', us(512)),
    encElem(0x0028, 0x0100, 'US', us(16)),
    encElem(0x0028, 0x0101, 'US', us(12)),
    encElem(0x0028, 0x0102, 'US', us(11)),
    encElem(0x0028, 0x0301, 'CS', strVal('CS', 'NO')),
  ]);

  const preamble = Buffer.concat([Buffer.alloc(128), Buffer.from('DICM', 'ascii')]);
  return Buffer.concat([preamble, meta, dataset]);
}

// ---- Synthetic report builders (SR + encapsulated document) -------------
function seqItem(dataBuf) {
  const h = Buffer.alloc(8);
  h.writeUInt16LE(0xfffe, 0); h.writeUInt16LE(0xe000, 2);
  h.writeUInt32LE(dataBuf.length, 4);
  return Buffer.concat([h, dataBuf]);
}

function codeSeq(group, element, value, scheme, meaning) {
  const itemData = Buffer.concat([
    encElem(0x0008, 0x0100, 'SH', strVal('SH', value)),
    encElem(0x0008, 0x0102, 'SH', strVal('SH', scheme)),
    encElem(0x0008, 0x0104, 'LO', strVal('LO', meaning)),
  ]);
  return encElem(group, element, 'SQ', seqItem(itemData));
}

function buildMeta(sopClass, sopInst) {
  const ts = '1.2.840.10008.1.2.1'; // Explicit VR LE
  const metaBody = Buffer.concat([
    encElem(0x0002, 0x0002, 'UI', strVal('UI', sopClass)),
    encElem(0x0002, 0x0003, 'UI', strVal('UI', sopInst)),
    encElem(0x0002, 0x0010, 'UI', strVal('UI', ts)),
    encElem(0x0002, 0x0012, 'UI', strVal('UI', '1.2.826.0.1.3680043.9.9999')),
  ]);
  const meta = Buffer.concat([
    encElem(0x0002, 0x0000, 'UL', ul(metaBody.length)),
    metaBody,
  ]);
  return Buffer.concat([Buffer.alloc(128), Buffer.from('DICM', 'ascii'), meta]);
}

function buildSyntheticSr(sopClass) {
  const sopInst = '1.2.3.4.5.6.7.8.9.11';
  const textItem = Buffer.concat([
    encElem(0x0040, 0xa010, 'CS', strVal('CS', 'CONTAINS')),
    encElem(0x0040, 0xa040, 'CS', strVal('CS', 'TEXT')),
    codeSeq(0x0040, 0xa043, '121071', 'DCM', 'Finding'),
    encElem(0x0040, 0xa160, 'UT', strVal('UT', 'No acute findings. Patient stable.')),
  ]);
  const dataset = Buffer.concat([
    encElem(0x0008, 0x0016, 'UI', strVal('UI', sopClass)),
    encElem(0x0008, 0x0018, 'UI', strVal('UI', sopInst)),
    encElem(0x0008, 0x0060, 'CS', strVal('CS', 'SR')),
    encElem(0x0040, 0xa040, 'CS', strVal('CS', 'CONTAINER')),
    codeSeq(0x0040, 0xa043, '11528-7', 'LN', 'Radiology Report'),
    encElem(0x0040, 0xa730, 'SQ', seqItem(textItem)),
  ]);
  return Buffer.concat([buildMeta(sopClass, sopInst), dataset]);
}

function buildSyntheticEncapsulated(sopClass, mime, docBytes) {
  const sopInst = '1.2.3.4.5.6.7.8.9.12';
  let payload = docBytes;
  if (payload.length % 2 !== 0) payload = Buffer.concat([payload, Buffer.from([0x00])]);
  const dataset = Buffer.concat([
    encElem(0x0008, 0x0016, 'UI', strVal('UI', sopClass)),
    encElem(0x0008, 0x0018, 'UI', strVal('UI', sopInst)),
    encElem(0x0042, 0x0010, 'ST', strVal('ST', 'Discharge Summary')),
    encElem(0x0042, 0x0011, 'OB', payload),
    encElem(0x0042, 0x0012, 'LO', strVal('LO', mime)),
    encElem(0x0042, 0x0015, 'UL', ul(docBytes.length)),
  ]);
  return Buffer.concat([buildMeta(sopClass, sopInst), dataset]);
}

async function main() {
  console.log('DICOM Copilot smoke test\n');

  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(TEST_FILE, buildSyntheticDicom());
  console.log(`Generated ${TEST_FILE}\n`);

  console.log('Parsing:');
  const parsed = parseFile(TEST_FILE);
  assert(parsed.ok, 'file parses successfully');
  assert(parsed.meta.transferSyntaxName === 'Explicit VR Little Endian', 'transfer syntax recognized');
  assert(String(getTagValue(parsed, '00100010')).includes('SMITH'), 'PatientName decoded');
  assert(String(getTagValue(parsed, '00280010')) === '512', 'Rows (US) decoded as 512');
  assert(getTagValue(parsed, '00080060') === 'CT', 'Modality decoded as CT');

  console.log('\nScanning folder:');
  const scan = scanFolder(TEST_DIR, { maxFiles: 100 });
  assert(scan.dicomCount >= 1, 'at least one DICOM indexed');
  assert(scan.studies.size >= 1, 'at least one study grouped');

  console.log('\nPHI helpers:');
  assert(!!getPhiInfo('00100010'), 'PatientName recognized as PHI');
  assert(getPhiInfo('00280010') === null, 'Rows not flagged as PHI');

  console.log('\nTool registration:');
  try {
    const server = new McpServer({ name: 'dicom-copilot-test', version: '1.0.0' });
    const ctx = {
      config: { dicom: { redactByDefault: true, allowRawPhi: false, maxFiles: 100 }, pii: {} },
      index: new DatasetIndex(),
      pii: new PiiClient({ baseUrl: 'http://localhost:5001' }),
    };
    registerExploreTools(server, ctx);
    registerValidateTools(server, ctx);
    registerPhiTools(server, ctx);
    registerExportTools(server, ctx);
    registerReportTools(server, ctx);
    assert(true, 'all tools registered without error');
  } catch (e) {
    assert(false, `tool registration failed: ${e.message}`);
  }

  console.log('\nReport reader (SR + encapsulated):');
  {
    // (a) Native Structured Report — verify the content tree is walked.
    const srSop = '1.2.840.10008.5.1.4.1.1.88.11'; // Basic Text SR
    const srFile = path.join(TEST_DIR, '_report_sr.dcm');
    fs.writeFileSync(srFile, buildSyntheticSr(srSop));
    const srParsed = parseFile(srFile);
    assert(srParsed.ok, 'SR file parses');
    assert(detectReportKind(srParsed) === 'sr', 'SR detected as structured report');
    const sr = collectSr(srParsed);
    assert(sr.docTitle === 'Radiology Report', 'SR document title decoded');
    assert(sr.entries.some((e) => e.valueType === 'TEXT') && sr.narrative.length >= 1, 'SR TEXT content item collected');
    assert(sr.narrative[0].includes('No acute findings'), 'SR narrative text decoded');

    // (b) Encapsulated CDA/XML — verify the OB payload is extracted verbatim.
    const xmlSop = '1.2.840.10008.5.1.4.1.1.104.2';
    const xmlBody = '<?xml version="1.0"?><ClinicalDocument><text>Impression: normal.</text></ClinicalDocument>';
    const xmlFile = path.join(TEST_DIR, '_report_cda.dcm');
    fs.writeFileSync(xmlFile, buildSyntheticEncapsulated(xmlSop, 'text/xml', Buffer.from(xmlBody, 'utf8')));
    const xmlParsed = parseFile(xmlFile);
    assert(xmlParsed.ok, 'encapsulated CDA parses');
    assert(detectReportKind(xmlParsed) === 'xml', 'encapsulated CDA detected as xml');
    const ex = extractElementBytes(xmlFile, '00420011');
    assert(ex.ok && ex.bytes.toString('utf8') === xmlBody, 'encapsulated XML bytes extracted verbatim');

    // (c) A plain image is not a report.
    assert(detectReportKind(parseFile(TEST_FILE)) === 'none', 'CT image not treated as a report');

    fs.rmSync(srFile, { force: true });
    fs.rmSync(xmlFile, { force: true });
  }

  console.log('\nPII service (optional):');
  const pii = new PiiClient({ baseUrl: process.env.PII_SERVICE_URL || 'http://localhost:5001' });
  const health = await pii.health();
  console.log(health.ok ? `  ✓ reachable (HTTP ${health.status})` : `  ⚠ not reachable (${health.error || health.status}) — non-fatal`);

  console.log('\nDe-identification writer:');
  {
    const outDir = path.join(TEST_DIR, '_deid_out');
    fs.rmSync(outDir, { recursive: true, force: true });
    const ctx = { pii: new PiiClient({ baseUrl: 'http://localhost:5001' }) };
    const uidMap = new Map();
    const outA = path.join(outDir, 'a.dcm');
    const outB = path.join(outDir, 'b.dcm');
    const rA = await deidentifyFileToCopy(TEST_FILE, outA, ctx, uidMap, { cleanFreeText: false });
    await deidentifyFileToCopy(TEST_FILE, outB, ctx, uidMap, { cleanFreeText: false });

    assert(rA.ok && fs.existsSync(outA), 'scrubbed copy written');
    const orig = parseFile(TEST_FILE);
    assert(String(getTagValue(orig, '00100010')).includes('SMITH'), 'original file left untouched');

    const deid = parseFile(outA);
    assert(deid.ok, 'scrubbed copy parses');
    assert(!String(getTagValue(deid, '00100010')).includes('SMITH'), 'PatientName scrubbed in copy');
    assert(getTagValue(deid, '0020000D') !== getTagValue(orig, '0020000D'), 'StudyInstanceUID remapped');
    assert(String(getTagValue(deid, '00120062')) === 'YES', 'PatientIdentityRemoved stamped');

    const deidB = parseFile(outB);
    assert(getTagValue(deid, '0020000D') === getTagValue(deidB, '0020000D'), 'UID remap consistent across files');

    fs.rmSync(outDir, { recursive: true, force: true });
  }

  console.log('\nStudy-level comparison:');
  {
    const cmpA = path.join(TEST_DIR, '_cmp_a');
    const cmpB = path.join(TEST_DIR, '_cmp_b');
    fs.rmSync(cmpA, { recursive: true, force: true });
    fs.rmSync(cmpB, { recursive: true, force: true });
    fs.mkdirSync(cmpA, { recursive: true });
    const srcCopy = path.join(cmpA, 'orig.dcm');
    fs.copyFileSync(TEST_FILE, srcCopy);

    const ctx = { pii: new PiiClient({ baseUrl: 'http://localhost:5001' }) };
    await deidentifyFileToCopy(srcCopy, path.join(cmpB, 'orig.dcm'), ctx, new Map(), { cleanFreeText: false });

    const sA = scanFolder(cmpA, { maxFiles: 100 });
    const sB = scanFolder(cmpB, { maxFiles: 100 });
    const cmp = compareStudyScans(sA, sB);
    assert(cmp.text.includes('Study-level comparison'), 'comparison report generated');
    assert(cmp.structurePreserved, 'structure preserved across de-id round-trip');
    assert(cmp.uidsChanged, 'UID change detected across round-trip');

    fs.rmSync(cmpA, { recursive: true, force: true });
    fs.rmSync(cmpB, { recursive: true, force: true });
  }

  console.log('\nCross-file study validation:');
  {
    // A clean study: 3 consecutive slices, one FoR, uniform 2mm spacing.
    const mkInst = (n, extra = {}) => ({
      sopInstanceUid: `1.2.3.${n}`,
      instanceNumber: String(n),
      frameOfReferenceUid: '1.2.3.FOR',
      sliceThickness: '2.0',
      imagePositionPatient: `0\\0\\${(n - 1) * 2}`,
      ...extra,
    });
    const cleanStudy = {
      studyUid: '1.2.3.CLEAN',
      studyDescription: 'Clean',
      modalities: new Set(['CT']),
      series: new Map([['s1', {
        seriesUid: 's1', seriesNumber: '1', modality: 'CT',
        instances: [mkInst(1), mkInst(2), mkInst(3)],
      }]]),
    };
    const clean = validateStudyCrossFile(cleanStudy);
    assert(clean.issues.length === 0, 'clean study reports no cross-file issues');

    // A broken study: missing slice #3, mixed FoR, duplicate SOP, mixed thickness.
    const brokenStudy = {
      studyUid: '1.2.3.BROKEN',
      studyDescription: 'Broken',
      modalities: new Set(['CT']),
      series: new Map([['s1', {
        seriesUid: 's1', seriesNumber: '1', modality: 'CT',
        instances: [
          mkInst(1),
          mkInst(2, { frameOfReferenceUid: '1.2.3.OTHER', sliceThickness: '5.0' }),
          mkInst(4, { sopInstanceUid: '1.2.3.1' }), // dup SOP with slice 1, gap at 3
        ],
      }]]),
    };
    const broken = validateStudyCrossFile(brokenStudy);
    assert(broken.issues.some((i) => /FrameOfReferenceUID/.test(i)), 'detects inconsistent FrameOfReferenceUID');
    assert(broken.issues.some((i) => /gap.*InstanceNumber/i.test(i)), 'detects InstanceNumber gap');
    assert(broken.issues.some((i) => /duplicate SOP Instance UID/i.test(i)), 'detects duplicate SOP Instance UID');
    assert(broken.issues.some((i) => /SliceThickness/.test(i)), 'detects mixed SliceThickness');

    // An orphaned series: no Series Instance UID.
    const orphanStudy = {
      studyUid: '1.2.3.ORPHAN',
      studyDescription: 'Orphan',
      modalities: new Set(['CT']),
      series: new Map([['UNKNOWN_SERIES', {
        seriesUid: 'UNKNOWN_SERIES', seriesNumber: null, modality: 'CT',
        instances: [mkInst(1)],
      }]]),
    };
    const orphan = validateStudyCrossFile(orphanStudy);
    assert(orphan.issues.some((i) => /orphaned/i.test(i)), 'detects orphaned series (missing Series UID)');
  }

  console.log('\nTransfer syntax report:');
  {
    // A mixed scan: 2 uncompressed, 1 JPEG 2000 (lossy), 1 JPEG Baseline (lossy).
    const mkInst = (sop, ts) => ({ sopInstanceUid: sop, transferSyntaxUid: ts });
    const scan = {
      root: '/fake/mixed',
      studies: new Map([['1.2.3', {
        studyUid: '1.2.3', modalities: new Set(['CT']),
        series: new Map([['s1', {
          seriesUid: 's1', instances: [
            mkInst('a', '1.2.840.10008.1.2.1'),   // Explicit VR LE (uncompressed)
            mkInst('b', '1.2.840.10008.1.2.1'),   // Explicit VR LE (uncompressed)
            mkInst('c', '1.2.840.10008.1.2.4.91'), // JPEG 2000 (lossy)
            mkInst('d', '1.2.840.10008.1.2.4.50'), // JPEG Baseline (lossy)
          ],
        }]]),
      }]]),
      errors: [],
    };

    const rpt = buildTransferSyntaxReport(scan);
    assert(rpt.text.includes('Transfer syntax report'), 'report generated');
    assert(rpt.lossyFiles === 2, 'counts lossy files (JPEG 2000 + JPEG Baseline)');
    assert(rpt.text.includes('JPEG 2000'), 'names JPEG 2000 transfer syntax');
    assert(rpt.text.includes('Uncompressed: 2'), 'counts uncompressed files');

    // With a target PACS that only accepts uncompressed Explicit VR LE.
    const gated = buildTransferSyntaxReport(scan, { accepted: ['1.2.840.10008.1.2.1'] });
    assert(gated.unacceptedFiles === 2, 'flags files the target PACS rejects');
    assert(gated.text.includes('reject'), 'report marks rejected syntaxes');

    // Name-substring acceptance should also work.
    const byName = buildTransferSyntaxReport(scan, { accepted: ['Explicit VR', 'JPEG 2000'] });
    assert(byName.unacceptedFiles === 1, 'name-substring accept-list leaves only JPEG Baseline rejected');
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
