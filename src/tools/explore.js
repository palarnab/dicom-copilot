import { z } from 'zod';
import path from 'node:path';
import { parseFile } from '../dicom/parser.js';
import { normalizeTag, formatTag, lookupTag } from '../dicom/dictionary.js';
import { getPhiInfo } from '../dicom/phi-tags.js';
import { renderTagValue, truncate } from './format.js';

export function registerExploreTools(server, ctx) {
  const { index, config } = ctx;

  server.tool(
    'scan_folder',
    'Recursively scan a folder for DICOM files and index them into a Patient → Study → Series → Instance hierarchy. Returns a summary. Runs entirely locally.',
    {
      path: z.string().describe('Absolute or relative path to a folder containing DICOM files'),
    },
    async ({ path: folder }) => {
      try {
        const r = index.scan(folder, { maxFiles: config.dicom.maxFiles });
        let out = `## Scan complete: ${r.root}\n\n`;
        out += `- Files walked: ${r.fileCount}\n`;
        out += `- DICOM files indexed: ${r.dicomCount}\n`;
        out += `- Non-DICOM skipped: ${r.skipped}\n`;
        out += `- Patients: ${r.patients.size}\n`;
        out += `- Studies: ${r.studies.size}\n`;
        if (r.errors.length) out += `- Parse errors: ${r.errors.length}\n`;

        if (r.studies.size) {
          out += `\n### Studies\n`;
          for (const study of r.studies.values()) {
            const mods = [...study.modalities].join('/') || '?';
            const nSeries = study.series.size;
            let nInst = 0;
            for (const s of study.series.values()) nInst += s.instances.length;
            out += `- [${mods}] ${truncate(study.studyDescription || 'No description', 40)} — ${nSeries} series, ${nInst} images (StudyUID …${study.studyUid.slice(-12)})\n`;
          }
        }
        if (r.errors.length) {
          out += `\n### Parse errors\n`;
          for (const e of r.errors.slice(0, 10)) out += `- ${path.basename(e.file)}: ${e.error}\n`;
        }
        return { content: [{ type: 'text', text: out }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Scan error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'study_hierarchy',
    'Show the full Patient → Study → Series → Instance tree for a previously scanned folder (or the most recent scan if no path is given).',
    {
      path: z.string().optional().describe('Root folder that was scanned (defaults to most recent scan)'),
    },
    async ({ path: folder }) => {
      const scan = index.getScan(folder);
      if (!scan) return { content: [{ type: 'text', text: 'No scan available. Run scan_folder first.' }], isError: true };

      let out = `## Hierarchy: ${scan.root}\n\n`;
      for (const [patientId, p] of scan.patients) {
        out += `📁 Patient: ${patientId}\n`;
        for (const studyUid of p.studyUids) {
          const study = scan.studies.get(studyUid);
          if (!study) continue;
          const mods = [...study.modalities].join('/') || '?';
          out += `  📂 Study [${mods}] ${truncate(study.studyDescription || '', 40)} (${study.studyDate || 'no date'})\n`;
          for (const series of study.series.values()) {
            out += `      🗂  Series ${series.seriesNumber ?? '?'} [${series.modality || '?'}] ${truncate(series.seriesDescription || '', 36)} — ${series.instances.length} img\n`;
          }
        }
      }
      return { content: [{ type: 'text', text: out }] };
    }
  );

  server.tool(
    'describe_study',
    'Summarize a single study in human-readable terms: modalities, series breakdown, image counts, transfer syntaxes, and any burned-in-annotation flags. PHI values are masked.',
    {
      studyUid: z.string().describe('Study Instance UID (full or trailing portion)'),
    },
    async ({ studyUid }) => {
      const found = index.findStudy(studyUid);
      if (!found) return { content: [{ type: 'text', text: `Study not found: ${studyUid}. Scan a folder first.` }], isError: true };
      const { study } = found;

      let nInst = 0;
      const allTs = new Set();
      let burned = 0;
      for (const s of study.series.values()) {
        nInst += s.instances.length;
        for (const ts of s.transferSyntaxes) allTs.add(ts);
        for (const i of s.instances) if (i.burnedInAnnotation === 'YES') burned++;
      }

      let out = `## Study Summary\n\n`;
      out += `- Study UID: …${study.studyUid.slice(-16)}\n`;
      out += `- Description: ${truncate(study.studyDescription || '(none)', 60)}\n`;
      out += `- Date: ${study.studyDate || '(none)'}\n`;
      out += `- Modalities: ${[...study.modalities].join(', ') || '?'}\n`;
      out += `- Series: ${study.series.size} | Images: ${nInst}\n`;
      out += `- Transfer syntaxes: ${[...allTs].join(', ') || '?'}\n`;
      if (allTs.size > 1) out += `  ⚠ Multiple transfer syntaxes in one study — a common cause of viewer/pipeline issues.\n`;
      if (burned > 0) out += `- ⚠ Burned-in annotation flagged on ${burned} image(s) — pixel-level PHI risk.\n`;

      out += `\n### Series\n`;
      for (const s of study.series.values()) {
        out += `- #${s.seriesNumber ?? '?'} [${s.modality || '?'}] ${truncate(s.seriesDescription || '', 40)} — ${s.instances.length} img`;
        if (s.transferSyntaxes.size > 1) out += ` ⚠ mixed transfer syntax`;
        out += `\n`;
      }
      return { content: [{ type: 'text', text: out }] };
    }
  );

  server.tool(
    'explain_tags',
    'Parse a single DICOM file and translate its tags into plain language (tag, name, VR, value). PHI-bearing values are masked by default. Great for understanding cryptic files.',
    {
      file: z.string().describe('Path to a .dcm file'),
      filter: z.string().optional().describe('Optional case-insensitive substring to filter by tag name/keyword'),
      allowRaw: z.boolean().optional().default(false).describe('Request raw PHI values (only honored if the server is configured to allow it)'),
    },
    async ({ file, filter, allowRaw }) => {
      const parsed = parseFile(file);
      if (!parsed.ok) return { content: [{ type: 'text', text: `Cannot parse: ${parsed.error}` }], isError: true };

      let out = `## ${path.basename(file)}\n`;
      if (parsed.meta.transferSyntaxName) out += `Transfer Syntax: ${parsed.meta.transferSyntaxName} (${parsed.meta.transferSyntaxUid})\n`;
      if (parsed.warnings.length) out += `Warnings: ${parsed.warnings.join('; ')}\n`;
      out += `\n| Tag | Name | VR | Value |\n|-----|------|----|-------|\n`;

      const f = filter?.toLowerCase();
      for (const el of parsed.elements) {
        if (el.isSequence) {
          out += `| ${el.tagDisplay} | ${el.name || 'Sequence'} | SQ | (${el.items?.length || 0} item(s)) |\n`;
          continue;
        }
        const label = el.name || el.keyword || 'Unknown';
        if (f && !(`${label} ${el.keyword || ''} ${el.tag}`.toLowerCase().includes(f))) continue;
        const { display, masked } = renderTagValue(ctx, el.tag, el.value, { allowRaw });
        const phi = getPhiInfo(el.tag) ? ' 🔒' : '';
        out += `| ${el.tagDisplay}${phi} | ${label} | ${el.vr} | ${truncate(display, 50)}${masked ? ' (masked)' : ''} |\n`;
      }
      return { content: [{ type: 'text', text: out }] };
    }
  );

  server.tool(
    'get_tag',
    'Look up one specific tag in a DICOM file by tag number ((gggg,eeee) or ggggeeee) or by keyword. PHI values are masked by default.',
    {
      file: z.string().describe('Path to a .dcm file'),
      tag: z.string().describe('Tag as (0010,0010), 00100010, or keyword like PatientName'),
      allowRaw: z.boolean().optional().default(false).describe('Request raw PHI value (only honored if server allows it)'),
    },
    async ({ file, tag, allowRaw }) => {
      const parsed = parseFile(file);
      if (!parsed.ok) return { content: [{ type: 'text', text: `Cannot parse: ${parsed.error}` }], isError: true };

      // Resolve keyword -> tag if needed.
      let norm = normalizeTag(tag);
      if (norm.length !== 8) {
        const match = parsed.elements.find((e) => e.keyword?.toLowerCase() === tag.toLowerCase());
        if (match) norm = match.tag;
      }
      const el = parsed.byTag[norm];
      const dict = lookupTag(norm);
      if (!el) {
        return { content: [{ type: 'text', text: `Tag ${formatTag(norm)} (${dict?.name || 'unknown'}) is not present in this file.` }] };
      }
      const { display, masked } = renderTagValue(ctx, el.tag, el.value, { allowRaw });
      let out = `${el.tagDisplay} ${el.name || el.keyword || 'Unknown'} [${el.vr}]\n`;
      out += `Value: ${display}${masked ? '  (PHI masked)' : ''}`;
      return { content: [{ type: 'text', text: out }] };
    }
  );
}
