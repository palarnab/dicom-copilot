import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from '../dicom/parser.js';
import { getPhiInfo, isFreeTextTag, maskValue } from '../dicom/phi-tags.js';
import { formatTag } from '../dicom/dictionary.js';
import { truncate } from './format.js';

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
}
