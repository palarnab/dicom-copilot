import { z } from 'zod';
import path from 'node:path';
import { parseFile, getTagValue, transferSyntaxName } from '../dicom/parser.js';
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
}
