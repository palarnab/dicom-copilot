import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { maskValue } from '../dicom/phi-tags.js';

/** Shorten a UID to its trailing portion so it can identify a row without echoing the full patient-derived UID. */
function shortUid(uid) {
  if (!uid) return '';
  return uid.length > 12 ? `…${uid.slice(-12)}` : uid;
}

/** Human-readable byte size. */
function humanSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** File size in bytes, or 0 if the file can't be stat'd. */
function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

/** Quote a CSV field if it contains a comma, quote, or newline. */
function csvField(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(values) {
  return values.map(csvField).join(',');
}

/**
 * Build a PHI-masked inventory from a scan result.
 * Patient IDs and study dates are masked; UIDs are truncated to trailing digits.
 */
function buildInventory(scan) {
  const studies = [];
  const allModalities = new Set();
  let totalSeries = 0;
  let totalInstances = 0;
  let totalBytes = 0;

  for (const study of scan.studies.values()) {
    const seriesRows = [];
    let studyInstances = 0;
    let studyBytes = 0;

    for (const s of study.series.values()) {
      let seriesBytes = 0;
      for (const inst of s.instances) seriesBytes += fileSize(inst.file);
      seriesRows.push({
        seriesUid: shortUid(s.seriesUid),
        seriesNumber: s.seriesNumber ?? '',
        modality: s.modality || '?',
        instances: s.instances.length,
        bytes: seriesBytes,
      });
      studyInstances += s.instances.length;
      studyBytes += seriesBytes;
    }

    for (const m of study.modalities) allModalities.add(m);
    totalSeries += study.series.size;
    totalInstances += studyInstances;
    totalBytes += studyBytes;

    studies.push({
      patient: maskValue(study.patientId),
      studyUid: shortUid(study.studyUid),
      studyDate: maskValue(study.studyDate || ''),
      modalities: [...study.modalities].sort(),
      seriesCount: study.series.size,
      instanceCount: studyInstances,
      bytes: studyBytes,
      series: seriesRows,
    });
  }

  return {
    root: scan.root,
    generatedAt: new Date().toISOString(),
    phiMasked: true,
    totals: {
      patients: scan.patients.size,
      studies: scan.studies.size,
      series: totalSeries,
      instances: totalInstances,
      bytes: totalBytes,
      modalities: [...allModalities].sort(),
    },
    studies,
  };
}

function toCsv(inv, granularity) {
  const lines = [];
  if (granularity === 'series') {
    lines.push(csvRow(['patient', 'studyUid', 'seriesUid', 'seriesNumber', 'modality', 'instanceCount', 'sizeBytes', 'sizeHuman']));
    for (const st of inv.studies) {
      for (const s of st.series) {
        lines.push(csvRow([st.patient, st.studyUid, s.seriesUid, s.seriesNumber, s.modality, s.instances, s.bytes, humanSize(s.bytes)]));
      }
    }
  } else {
    lines.push(csvRow(['patient', 'studyUid', 'studyDate', 'modalities', 'seriesCount', 'instanceCount', 'sizeBytes', 'sizeHuman']));
    for (const st of inv.studies) {
      lines.push(csvRow([st.patient, st.studyUid, st.studyDate, st.modalities.join('/'), st.seriesCount, st.instanceCount, st.bytes, humanSize(st.bytes)]));
    }
  }
  return lines.join('\n');
}

function toJson(inv, granularity) {
  if (granularity === 'series') return JSON.stringify(inv, null, 2);
  // Study granularity: drop the nested series detail.
  const trimmed = {
    ...inv,
    studies: inv.studies.map(({ series, ...rest }) => rest),
  };
  return JSON.stringify(trimmed, null, 2);
}

export function registerExportTools(server, ctx) {
  const { index } = ctx;

  server.tool(
    'export_manifest',
    'Emit a PHI-masked inventory (CSV or JSON) of a scanned folder for auditing: study/series/instance counts, modalities, and file sizes. Patient IDs and study dates are masked; UIDs are truncated. Returns the manifest inline and optionally writes it to a file.',
    {
      path: z.string().optional().describe('Root folder that was scanned (defaults to the most recent scan)'),
      format: z.enum(['csv', 'json']).optional().default('csv').describe('Output format (default csv)'),
      granularity: z.enum(['study', 'series']).optional().default('study').describe('One row per study (default) or per series'),
      outputFile: z.string().optional().describe('Optional path to write the manifest to. If omitted, the manifest is only returned inline.'),
    },
    async ({ path: folder, format, granularity, outputFile }) => {
      const scan = index.getScan(folder);
      if (!scan) return { content: [{ type: 'text', text: 'No scan available. Run scan_folder first.' }], isError: true };

      const inv = buildInventory(scan);
      const body = format === 'json' ? toJson(inv, granularity) : toCsv(inv, granularity);

      let out = `## Export manifest (PHI masked)\n`;
      out += `- Root: ${inv.root}\n`;
      out += `- Format: ${format} | Granularity: ${granularity}\n`;
      out += `- Patients: ${inv.totals.patients} | Studies: ${inv.totals.studies} | Series: ${inv.totals.series} | Instances: ${inv.totals.instances}\n`;
      out += `- Modalities: ${inv.totals.modalities.join(', ') || '?'}\n`;
      out += `- Total size: ${humanSize(inv.totals.bytes)} (${inv.totals.bytes} bytes)\n`;

      if (outputFile) {
        try {
          const dest = path.resolve(outputFile);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, body);
          out += `- Written to: ${dest}\n`;
        } catch (e) {
          out += `- ⚠ Could not write file: ${e.message}\n`;
        }
      }

      const fence = format === 'json' ? 'json' : 'csv';
      out += `\n\`\`\`${fence}\n${body}\n\`\`\`\n`;
      return { content: [{ type: 'text', text: out }] };
    }
  );
}
