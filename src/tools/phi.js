import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { data as dcmjsData } from 'dcmjs';
import { parseFile } from '../dicom/parser.js';
import { getPhiInfo, isFreeTextTag, maskValue, PHI_TAGS } from '../dicom/phi-tags.js';
import { formatTag } from '../dicom/dictionary.js';
import { truncate } from './format.js';

const { DicomMessage, DicomMetaDictionary } = dcmjsData;

// String VRs whose free-text content is worth sending to the PII service.
const TEXTUAL_VRS = new Set(['LO', 'LT', 'ST', 'UT', 'PN', 'SH']);

function flatten(elements, acc = []) {
  for (const el of elements) {
    if (el.isSequence && Array.isArray(el.items)) {
      for (const item of el.items) flatten(item, acc);
    } else if (!el.isSequence) {
      acc.push(el);
    }
  }
  return acc;
}

function isMeaningful(value) {
  const s = String(value ?? '').trim();
  if (!s || s.startsWith('<binary')) return false;
  return s.length >= 2;
}

async function scanOneFile(file, ctx) {
  const parsed = parseFile(file);
  if (!parsed.ok) return { file, ok: false, error: parsed.error };

  const elements = flatten(parsed.elements);
  const findings = [];

  // 1) Deterministic: known PHI tags.
  for (const el of elements) {
    const phi = getPhiInfo(el.tag);
    if (phi && isMeaningful(el.value)) {
      findings.push({
        tag: el.tag,
        name: el.name || phi.label,
        source: 'known-tag',
        action: phi.action,
        maskedValue: maskValue(String(el.value).split('\\')[0]),
        entities: [],
      });
    }
  }

  // 2) Heuristic: send free-text values to the PII service.
  const known = new Set(findings.map((f) => f.tag));
  const toScan = [];
  for (const el of elements) {
    if (!isMeaningful(el.value)) continue;
    const isTextual = TEXTUAL_VRS.has(el.vr) || isFreeTextTag(el.tag);
    if (!isTextual) continue;
    // Skip pure UIDs.
    if (el.vr === 'UI') continue;
    toScan.push({ el, text: String(el.value) });
  }

  let piiStatus = 'not-used';
  if (toScan.length) {
    const res = await ctx.pii.detect(toScan.map((t) => t.text));
    if (res.ok) {
      piiStatus = 'ok';
      res.perText.forEach((entities, i) => {
        if (!entities.length) return;
        const el = toScan[i].el;
        const types = [...new Set(entities.map((e) => e.type))];
        const existing = findings.find((f) => f.tag === el.tag);
        if (existing) {
          existing.entities = types;
        } else {
          findings.push({
            tag: el.tag,
            name: el.name || el.keyword || 'Free text',
            source: 'pii-service',
            action: 'clean',
            maskedValue: maskValue(String(el.value)),
            entities: types,
          });
        }
      });
    } else {
      piiStatus = `unavailable (${res.error}) — deterministic detection only`;
    }
  }

  const burned = elements.find((e) => e.tag === '00280301' && String(e.value).toUpperCase() === 'YES');

  return { file, ok: true, findings, piiStatus, burnedInAnnotation: !!burned };
}

// ---- De-identification writer (dcmjs) -----------------------------------

const DUMMY_DATE = '19000101';
const DUMMY_TIME = '000000';

/** Extract the first string of a dcmjs element value (handles PN objects). */
function elText(el) {
  if (!el || !Array.isArray(el.Value) || el.Value.length === 0) return '';
  const v = el.Value[0];
  if (v && typeof v === 'object') return v.Alphabetic ?? Object.values(v)[0] ?? '';
  return String(v ?? '');
}

/** Clear an element's content but keep the (now empty) attribute. */
function blankElement(el) {
  el.Value = [];
  delete el._rawValue;
}

/** Choose a non-identifying replacement value for a "replace" tag. */
function dummyValueFor(tag, vr) {
  switch (vr) {
    case 'DA': return [DUMMY_DATE];
    case 'DT': return [`${DUMMY_DATE}000000`];
    case 'TM': return [DUMMY_TIME];
    case 'PN': return [{ Alphabetic: 'ANONYMOUS' }];
    default:
      if (tag === '00100020') return ['ANONYMIZED']; // Patient ID
      if (tag === '00080050') return ['ANONYMIZED']; // Accession Number
      if (tag === '00200010') return ['ANONYMIZED']; // Study ID
      if (tag === '00101010') return ['000Y'];        // Patient Age
      return []; // zero-length (Z-type)
  }
}

/** Map an old UID to a stable new UID, shared across a run for study consistency. */
function remapUid(oldUid, uidMap) {
  const key = oldUid || '';
  if (!uidMap.has(key)) uidMap.set(key, DicomMetaDictionary.uid());
  return uidMap.get(key);
}

function setString(dict, tag, vr, value) {
  dict[tag] = { vr, Value: [value] };
}

/**
 * De-identify one file and write a scrubbed COPY to `outFile`.
 * `uidMap` is shared across files so a study's UIDs remap consistently.
 * Never touches the source file.
 */
export async function deidentifyFileToCopy(srcFile, outFile, ctx, uidMap, options = {}) {
  const cleanFreeText = options.cleanFreeText !== false;
  const result = { srcFile, outFile, ok: false, removed: 0, replaced: 0, uids: 0, cleaned: 0, warnings: [] };

  let ab;
  try {
    const buf = fs.readFileSync(srcFile);
    ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch (e) {
    result.error = `Cannot read: ${e.message}`;
    return result;
  }

  let dd;
  try {
    dd = DicomMessage.readFile(ab, { ignoreErrors: true });
  } catch (e) {
    result.error = `dcmjs cannot parse: ${e.message || e}`;
    return result;
  }
  const dict = dd.dict;

  // 1) Deterministic PHI_TAGS actions (always works, fully offline).
  const cleanTags = [];
  for (const [tag, info] of Object.entries(PHI_TAGS)) {
    const el = dict[tag];
    if (!el) continue;
    switch (info.action) {
      case 'remove':
        delete dict[tag];
        result.removed++;
        break;
      case 'replace':
        el.Value = dummyValueFor(tag, el.vr);
        delete el._rawValue;
        result.replaced++;
        break;
      case 'uid':
        if (el.Value?.[0]) {
          el.Value = [remapUid(el.Value[0], uidMap)];
          delete el._rawValue;
          result.uids++;
        }
        break;
      case 'clean':
        cleanTags.push(tag);
        break;
    }
  }

  // Keep file-meta SOP Instance UID consistent with the remapped dataset UID.
  if (dd.meta['00020003'] && dict['00080018']?.Value?.[0]) {
    dd.meta['00020003'].Value = [...dict['00080018'].Value];
    delete dd.meta['00020003']._rawValue;
  }

  // 2) Free-text cleaning via the PII service.
  if (cleanFreeText) {
    const candidates = [];
    for (const [tag, el] of Object.entries(dict)) {
      if (el.vr === 'UI' || el.vr === 'SQ') continue;
      if (!(TEXTUAL_VRS.has(el.vr) || isFreeTextTag(tag))) continue;
      const text = elText(el);
      if (text && text.length >= 2 && !text.startsWith('<binary')) candidates.push({ el, text });
    }

    let res = { ok: false };
    if (candidates.length) res = await ctx.pii.detect(candidates.map((c) => c.text));

    if (res.ok) {
      res.perText.forEach((entities, i) => {
        if (entities && entities.length) { blankElement(candidates[i].el); result.cleaned++; }
      });
    } else if (cleanTags.length) {
      // Service unavailable: fail safe by blanking the known free-text PHI tags.
      for (const tag of cleanTags) {
        if (dict[tag]) { blankElement(dict[tag]); result.cleaned++; }
      }
      result.warnings.push('PII service unavailable — known free-text PHI tags blanked deterministically (broader free-text not scanned).');
    }
  }

  // 3) Stamp de-identification per DICOM PS3.15.
  setString(dict, '00120062', 'CS', 'YES'); // PatientIdentityRemoved
  setString(dict, '00120063', 'LO', 'DICOM Copilot Basic Profile (remove/replace/clean/uid-remap)'); // DeidentificationMethod

  // 4) Write the scrubbed copy (never the original).
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const out = dd.write();
    fs.writeFileSync(outFile, Buffer.from(out));
    result.ok = true;
  } catch (e) {
    result.error = `Cannot write output: ${e.message}`;
  }
  return result;
}

export function registerPhiTools(server, ctx) {
  server.tool(
    'pii_service_status',
    'Check whether the external PII detection service is reachable.',
    {},
    async () => {
      const h = await ctx.pii.health();
      const text = h.ok
        ? `✅ PII service reachable at ${ctx.pii.baseUrl} (HTTP ${h.status})`
        : `❌ PII service NOT reachable at ${ctx.pii.baseUrl} (${h.error || h.status}). Deterministic known-PHI-tag detection still works without it.`;
      return { content: [{ type: 'text', text }] };
    }
  );

  server.tool(
    'find_phi',
    'Scan a DICOM file (or every DICOM file in a folder) for PHI. Combines built-in known-PHI-tag detection with the external PII service for free-text fields. Reports WHERE PHI is — values are always masked, never echoed to the model.',
    {
      path: z.string().describe('Path to a .dcm file or a folder of DICOM files'),
      maxFiles: z.number().optional().default(50).describe('When path is a folder, max files to scan (default 50)'),
    },
    async ({ path: target, maxFiles }) => {
      let files = [];
      try {
        const stat = fs.statSync(target);
        if (stat.isDirectory()) {
          const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
              if (files.length >= maxFiles) return;
              const full = path.join(dir, e.name);
              if (e.isDirectory() && !e.name.startsWith('.')) walk(full);
              else if (e.isFile()) files.push(full);
            }
          };
          walk(target);
        } else {
          files = [target];
        }
      } catch (e) {
        return { content: [{ type: 'text', text: `Path error: ${e.message}` }], isError: true };
      }

      const results = [];
      for (const f of files) results.push(await scanOneFile(f, ctx));

      const parsed = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);

      // Aggregate by tag across files.
      const byTag = new Map();
      let burnedCount = 0;
      let piiStatus = 'not-used';
      for (const r of parsed) {
        if (r.burnedInAnnotation) burnedCount++;
        if (r.piiStatus && r.piiStatus !== 'not-used') piiStatus = r.piiStatus;
        for (const f of r.findings) {
          if (!byTag.has(f.tag)) byTag.set(f.tag, { ...f, count: 0, files: new Set() });
          const agg = byTag.get(f.tag);
          agg.count++;
          agg.files.add(r.file);
          if (f.entities?.length) agg.entities = [...new Set([...(agg.entities || []), ...f.entities])];
        }
      }

      let out = `## PHI scan\n`;
      out += `- Files scanned: ${parsed.length}${failed.length ? ` (${failed.length} failed to parse)` : ''}\n`;
      out += `- PII service: ${piiStatus}\n`;
      out += `- Distinct PHI-bearing tags: ${byTag.size}\n\n`;

      if (byTag.size) {
        out += `| Tag | Name | Detected by | Entity types | Action | Files | Example (masked) |\n`;
        out += `|-----|------|-------------|--------------|--------|-------|------------------|\n`;
        for (const f of [...byTag.values()].sort((a, b) => b.count - a.count)) {
          out += `| ${formatTag(f.tag)} | ${f.name} | ${f.source} | ${(f.entities || []).join(', ') || '—'} | ${f.action} | ${f.count} | ${truncate(f.maskedValue, 18)} |\n`;
        }
      } else {
        out += `No metadata PHI detected.\n`;
      }

      out += `\n### ⚠ Burned-in pixel PHI\n`;
      if (burnedCount) out += `- ${burnedCount} file(s) have BurnedInAnnotation = YES. Text baked into the image pixels is NOT removable by metadata de-identification.\n`;
      out += `- Note: this tool does NOT perform OCR on pixel data. Burned-in text in files NOT flagged by the tag can still exist and must be checked separately.\n`;

      if (failed.length) {
        out += `\n### Parse failures\n`;
        for (const f of failed.slice(0, 10)) out += `- ${path.basename(f.file)}: ${f.error}\n`;
      }
      return { content: [{ type: 'text', text: out }] };
    }
  );

  server.tool(
    'deidentify_preview',
    'Preview a de-identification plan for a DICOM file: for each PHI tag, the recommended action (remove / replace / clean / uid-remap) per DICOM PS3.15. Does NOT modify files — preview only. Values are masked.',
    {
      file: z.string().describe('Path to a .dcm file'),
    },
    async ({ file }) => {
      const r = await scanOneFile(file, ctx);
      if (!r.ok) return { content: [{ type: 'text', text: `Cannot parse: ${r.error}` }], isError: true };

      const actionLabel = {
        remove: 'Remove (delete value)',
        replace: 'Replace with dummy',
        clean: 'Clean free text (inspect/scrub)',
        uid: 'Remap UID consistently',
      };

      let out = `## De-identification preview: ${path.basename(file)}\n\n`;
      out += `> Preview only — no files are modified.\n\n`;
      if (!r.findings.length) {
        out += `No PHI tags detected to de-identify.\n`;
      } else {
        out += `| Tag | Name | Action | Detected by | Current (masked) |\n`;
        out += `|-----|------|--------|-------------|------------------|\n`;
        for (const f of r.findings) {
          out += `| ${formatTag(f.tag)} | ${f.name} | ${actionLabel[f.action] || f.action} | ${f.source} | ${truncate(f.maskedValue, 18)} |\n`;
        }
      }
      if (r.burnedInAnnotation) {
        out += `\n⚠ BurnedInAnnotation = YES: metadata de-identification will NOT remove PHI baked into the image pixels. Pixel redaction is required separately.\n`;
      }
      return { content: [{ type: 'text', text: out }] };
    }
  );

  server.tool(
    'deidentify_apply',
    'Write de-identified COPIES of DICOM file(s) with dcmjs, applying the deidentify_preview plan (remove / replace / clean / consistent UID remap per DICOM PS3.15). Originals are NEVER modified — copies go to a separate output folder. UID remapping is shared across the whole run, so all files in a study stay internally linked. Metadata only: does NOT remove burned-in pixel PHI.',
    {
      path: z.string().describe('Path to a .dcm file or a folder of DICOM files (process a whole study/folder together to keep UID remapping consistent)'),
      outputDir: z.string().optional().describe('Directory for scrubbed copies. Defaults to a sibling "<name>_deidentified" folder. Must differ from the source.'),
      maxFiles: z.number().optional().default(500).describe('When path is a folder, max files to process (default 500)'),
      cleanFreeText: z.boolean().optional().default(true).describe('Scan textual fields with the PII service and blank detected PHI (default true)'),
      overwrite: z.boolean().optional().default(false).describe('Overwrite existing files in the OUTPUT folder (never affects originals; default false)'),
    },
    async ({ path: target, outputDir, maxFiles, cleanFreeText, overwrite }) => {
      let stat;
      try { stat = fs.statSync(target); }
      catch (e) { return { content: [{ type: 'text', text: `Path error: ${e.message}` }], isError: true }; }

      const isDir = stat.isDirectory();
      const baseDir = isDir ? path.resolve(target) : path.dirname(path.resolve(target));
      const outRoot = path.resolve(
        outputDir || (isDir ? `${path.resolve(target)}_deidentified` : path.join(baseDir, 'deidentified'))
      );

      if (outRoot === baseDir) {
        return { content: [{ type: 'text', text: 'Output directory must differ from the source directory (to never overwrite originals). Specify a different outputDir.' }], isError: true };
      }

      let files = [];
      if (isDir) {
        const walk = (dir) => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (files.length >= maxFiles) return;
            const full = path.join(dir, e.name);
            if (e.isDirectory() && !e.name.startsWith('.')) {
              if (path.resolve(full) === outRoot) continue; // never recurse into the output tree
              walk(full);
            } else if (e.isFile()) {
              files.push(full);
            }
          }
        };
        walk(baseDir);
      } else {
        files = [path.resolve(target)];
      }

      if (!files.length) return { content: [{ type: 'text', text: 'No files found to process.' }] };

      const uidMap = new Map();
      const results = [];
      let skipped = 0;
      for (const f of files) {
        const rel = isDir ? path.relative(baseDir, f) : path.basename(f);
        const outFile = path.join(outRoot, rel);
        if (path.resolve(outFile) === path.resolve(f)) { skipped++; continue; } // never overwrite the original
        if (fs.existsSync(outFile) && !overwrite) {
          results.push({ srcFile: f, outFile, ok: false, error: 'output exists (pass overwrite:true to replace)' });
          continue;
        }
        results.push(await deidentifyFileToCopy(f, outFile, ctx, uidMap, { cleanFreeText }));
      }

      const ok = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      const totals = ok.reduce((a, r) => {
        a.removed += r.removed; a.replaced += r.replaced; a.uids += r.uids; a.cleaned += r.cleaned; return a;
      }, { removed: 0, replaced: 0, uids: 0, cleaned: 0 });

      let out = `## De-identification applied\n`;
      out += `- Source: ${target}\n`;
      out += `- Output: ${outRoot}\n`;
      out += `- Files written: ${ok.length}${failed.length ? ` (${failed.length} not written)` : ''}\n`;
      out += `- Consistent UID remap: ${uidMap.size} distinct UID(s) → new UIDs (shared across all files)\n`;
      out += `- Actions across files: ${totals.removed} removed, ${totals.replaced} replaced, ${totals.uids} UID remaps, ${totals.cleaned} free-text cleaned\n\n`;
      out += `> Originals were NOT modified. Each copy is stamped PatientIdentityRemoved = YES. Always verify before sharing — and note that metadata de-identification does NOT remove burned-in pixel PHI.\n`;

      if (ok.length) {
        out += `\n| Source | Output (rel) | Removed | Replaced | UID | Cleaned |\n`;
        out += `|--------|--------------|---------|----------|-----|---------|\n`;
        for (const r of ok.slice(0, 50)) {
          out += `| ${path.basename(r.srcFile)} | ${path.relative(outRoot, r.outFile)} | ${r.removed} | ${r.replaced} | ${r.uids} | ${r.cleaned} |\n`;
        }
        if (ok.length > 50) out += `| … | (${ok.length - 50} more) | | | | |\n`;
      }

      const warns = [...new Set(ok.flatMap((r) => r.warnings || []))];
      if (warns.length) { out += `\n### Warnings\n`; for (const w of warns) out += `- ${w}\n`; }

      if (failed.length) {
        out += `\n### Not written\n`;
        for (const r of failed.slice(0, 20)) out += `- ${path.basename(r.srcFile)}: ${r.error}\n`;
      }
      if (skipped) out += `\n${skipped} file(s) skipped because the output path equalled the original.\n`;

      return { content: [{ type: 'text', text: out }] };
    }
  );
}
