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

import { parseFile, getTagValue } from '../src/dicom/parser.js';
import { scanFolder } from '../src/dicom/scanner.js';
import { getPhiInfo } from '../src/dicom/phi-tags.js';
import { DatasetIndex } from '../src/dicom/dataset.js';
import { PiiClient } from '../src/services/pii-client.js';
import { registerExploreTools } from '../src/tools/explore.js';
import { registerValidateTools, compareStudyScans } from '../src/tools/validate.js';
import { registerPhiTools, deidentifyFileToCopy } from '../src/tools/phi.js';
import { registerExportTools } from '../src/tools/export.js';

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
    assert(true, 'all tools registered without error');
  } catch (e) {
    assert(false, `tool registration failed: ${e.message}`);
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

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
