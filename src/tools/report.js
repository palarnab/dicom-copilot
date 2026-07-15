/**
 * read_report — render the human-readable content of DICOM reports.
 *
 * Handles the three report shapes DICOM uses in the wild:
 *   1. Native Structured Reports (SR)      — content lives in nested
 *      ContentSequence (0040,A730) items; we walk the tree into a readable
 *      outline.
 *   2. Encapsulated PDF   (SOP …104.1)     — PDF bytes in EncapsulatedDocument
 *      (0042,0011); we extract and text-parse them.
 *   3. Encapsulated CDA / XML (SOP …104.2) — XML bytes in the same tag; decoded
 *      as UTF-8 text.
 *
 * PHI safety: narrative free text (SR TEXT/PNAME items, PDF/XML body) can carry
 * PHI that is NOT covered by the deterministic tag list. Before any narrative
 * reaches the model it is run through the PII service and detected spans are
 * redacted. When redaction can't be performed (service down) the narrative is
 * withheld by default rather than leaked — consistent with the rest of the
 * server's PHI-safe posture. Raw narrative is only returned when the caller
 * asks for it AND the server is configured to allow raw PHI.
 */

import { z } from 'zod';
import path from 'node:path';
import { parseFile, getTagValue, extractElementBytes } from '../dicom/parser.js';
import { renderTagValue, truncate } from './format.js';

// --- DICOM tag constants (SR content model + encapsulated documents) --------
const T = {
  contentSeq: '0040A730',
  relationship: '0040A010',
  valueType: '0040A040',
  conceptName: '0040A043',
  conceptCode: '0040A168',
  textValue: '0040A160',
  personName: '0040A123',
  dateTime: '0040A120',
  date: '0040A121',
  time: '0040A122',
  uidRef: '0040A124',
  measuredValueSeq: '0040A300',
  numericValue: '0040A30A',
  unitsSeq: '004008EA',
  codeValue: '00080100',
  codingScheme: '00080102',
  codeMeaning: '00080104',
  // Encapsulated document
  encapsulated: '00420011',
  mimeType: '00420012',
  documentTitle: '00420010',
};

const SOP = {
  encapsulatedPdf: '1.2.840.10008.5.1.4.1.1.104.1',
  encapsulatedCda: '1.2.840.10008.5.1.4.1.1.104.2',
  srPrefix: '1.2.840.10008.5.1.4.1.1.88.',
};

// --- small tree helpers ------------------------------------------------------
function nodeVal(nodes, tag) {
  const n = nodes.find((x) => x.tag === tag);
  return n ? n.value : undefined;
}

function seqItems(nodes, tag) {
  const n = nodes.find((x) => x.tag === tag);
  return n && Array.isArray(n.items) ? n.items : null;
}

/** Read a human code meaning out of a code sequence (e.g. ConceptNameCodeSequence). */
function codeMeaning(nodes, seqTag) {
  const items = seqItems(nodes, seqTag);
  if (!items || !items.length) return '';
  const item = items[0];
  const meaning = nodeVal(item, T.codeMeaning);
  if (meaning) return String(meaning);
  const value = nodeVal(item, T.codeValue);
  const scheme = nodeVal(item, T.codingScheme);
  if (value) return scheme ? `${value} (${scheme})` : String(value);
  return '';
}

/** Format a NUM content item as "value unit". */
function numericValue(nodes) {
  const items = seqItems(nodes, T.measuredValueSeq);
  if (!items || !items.length) return '';
  const item = items[0];
  const value = nodeVal(item, T.numericValue);
  if (value === undefined || value === '') return '';
  const unit = codeMeaning(item, T.unitsSeq);
  return unit ? `${value} ${unit}` : String(value);
}

// --- report kind detection ---------------------------------------------------
export function detectReportKind(parsed) {
  const sop = parsed.meta.sopClassUid || '';
  const hasEncapsulated = Boolean(parsed.byTag[T.encapsulated]);

  if (hasEncapsulated) {
    const mime = String(getTagValue(parsed, T.mimeType) || '').toLowerCase();
    if (sop === SOP.encapsulatedPdf || mime.includes('pdf')) return 'pdf';
    if (
      sop === SOP.encapsulatedCda ||
      mime.includes('xml') || mime.includes('cda') ||
      mime.includes('html') || mime.includes('text')
    ) return 'xml';
    return 'encapsulated-other';
  }

  if (parsed.byTag[T.contentSeq] || sop.startsWith(SOP.srPrefix)) return 'sr';
  return 'none';
}

// --- PHI-safe narrative handling --------------------------------------------
function placeholder(type) {
  return `[${type || 'PHI'} REDACTED]`;
}

/** Redact detected PII spans from a single text string. */
function redactSpans(text, entities) {
  if (!entities || !entities.length) return { text, count: 0 };
  let count = 0;
  let s = text;

  // Offset-based redaction first (most precise), applied right-to-left so
  // earlier offsets stay valid.
  const withOffsets = entities
    .filter((e) => Number.isInteger(e.start) && Number.isInteger(e.end) && e.end > e.start)
    .sort((a, b) => b.start - a.start);
  for (const e of withOffsets) {
    s = s.slice(0, e.start) + placeholder(e.type) + s.slice(e.end);
    count++;
  }

  // Value-based fallback for entities the service reported without offsets.
  for (const e of entities) {
    if (Number.isInteger(e.start) && Number.isInteger(e.end) && e.end > e.start) continue;
    if (e.value && s.includes(e.value)) {
      s = s.split(e.value).join(placeholder(e.type));
      count++;
    }
  }

  return { text: s, count };
}

/**
 * Make an array of narrative strings safe to return to the model.
 * @returns {Promise<{ mode: 'raw'|'ok'|'withheld'|'raw-fallback', texts?: string[], redactions?: number, note?: string, error?: string }>}
 */
async function safeNarrative(ctx, texts, { allowRaw }) {
  const permitRaw = allowRaw && ctx.config.dicom.allowRawPhi;
  if (permitRaw) {
    return { mode: 'raw', texts, note: 'Raw, unredacted narrative returned at caller request (server permits raw PHI).' };
  }

  const indexed = texts.map((t, i) => ({ i, t })).filter((x) => x.t && x.t.trim());
  if (!indexed.length) return { mode: 'ok', texts, redactions: 0 };

  const res = await ctx.pii.detect(indexed.map((x) => x.t));
  if (!res.ok) {
    if (ctx.config.dicom.redactByDefault) {
      return { mode: 'withheld', error: res.error };
    }
    return {
      mode: 'raw-fallback',
      texts,
      note: `PII service unavailable (${res.error}); narrative returned unredacted because DICOM_REDACT_BY_DEFAULT is off.`,
    };
  }

  const out = texts.slice();
  let redactions = 0;
  res.perText.forEach((entities, k) => {
    const { i } = indexed[k];
    const r = redactSpans(texts[i], entities);
    out[i] = r.text;
    redactions += r.count;
  });
  return { mode: 'ok', texts: out, redactions };
}

// --- Structured Report rendering --------------------------------------------
/**
 * Walk the SR content tree into a flat, ordered list of outline entries.
 * TEXT / PNAME values are collected separately so they can be PHI-scrubbed as a
 * batch; each such entry keeps a `narrativeIndex` pointing into that batch.
 */
export function collectSr(parsed) {
  const root = parsed.elements;
  const docTitle = codeMeaning(root, T.conceptName);
  const entries = [];
  const narrative = [];

  const rootItems = seqItems(root, T.contentSeq);

  function walk(itemNodes, depth) {
    const valueType = nodeVal(itemNodes, T.valueType);
    const rel = nodeVal(itemNodes, T.relationship);
    const concept = codeMeaning(itemNodes, T.conceptName);

    const entry = { depth, valueType, rel, concept, value: '', narrativeIndex: -1 };

    switch (valueType) {
      case 'TEXT': {
        entry.narrativeIndex = narrative.push(String(nodeVal(itemNodes, T.textValue) || '')) - 1;
        break;
      }
      case 'PNAME': {
        entry.narrativeIndex = narrative.push(String(nodeVal(itemNodes, T.personName) || '')) - 1;
        break;
      }
      case 'CODE':
        entry.value = codeMeaning(itemNodes, T.conceptCode);
        break;
      case 'NUM':
        entry.value = numericValue(itemNodes);
        break;
      case 'DATETIME':
        entry.value = String(nodeVal(itemNodes, T.dateTime) || '');
        break;
      case 'DATE':
        entry.value = String(nodeVal(itemNodes, T.date) || '');
        break;
      case 'TIME':
        entry.value = String(nodeVal(itemNodes, T.time) || '');
        break;
      case 'UIDREF':
        entry.value = String(nodeVal(itemNodes, T.uidRef) || '');
        break;
      case 'CONTAINER':
        entry.value = '';
        break;
      default:
        entry.value = valueType ? `[${valueType}]` : '';
    }

    entries.push(entry);

    const children = seqItems(itemNodes, T.contentSeq);
    if (children) for (const child of children) walk(child, depth + 1);
  }

  if (rootItems) for (const item of rootItems) walk(item, 0);
  return { docTitle, entries, narrative };
}

async function renderSr(parsed, ctx, { allowRaw, maxChars }) {
  const { docTitle, entries, narrative } = collectSr(parsed);
  const safe = await safeNarrative(ctx, narrative, { allowRaw });

  let out = `### Structured Report\n\n`;
  if (docTitle) out += `**Document:** ${docTitle}\n\n`;

  if (!entries.length) {
    out += `_No SR content items found (empty or non-standard ContentSequence)._\n`;
    return out;
  }

  if (safe.mode === 'withheld') {
    out += `> ⚠ PII service unavailable (${safe.error}) — narrative text withheld to prevent PHI leakage. `;
    out += `Start the PII service, or set \`allowRaw: true\` (only works if the server allows raw PHI). `;
    out += `Structure and coded values are shown below.\n\n`;
  } else if (safe.note) {
    out += `> ${safe.note}\n\n`;
  } else if (safe.redactions) {
    out += `> ${safe.redactions} PHI span(s) redacted from narrative text.\n\n`;
  }

  let used = 0;
  let truncated = false;
  for (const e of entries) {
    const indent = '  '.repeat(e.depth);
    let value = e.value;

    if (e.narrativeIndex >= 0) {
      if (safe.mode === 'withheld') {
        value = '«narrative withheld»';
      } else {
        value = safe.texts[e.narrativeIndex] || '';
        if (used + value.length > maxChars) {
          value = value.slice(0, Math.max(0, maxChars - used)) + '…';
          truncated = true;
        }
        used += value.length;
      }
    }

    const label = e.concept || e.valueType || 'Item';
    if (e.valueType === 'CONTAINER') {
      out += `${indent}- **${label}**\n`;
    } else if (value) {
      const oneLine = String(value).replace(/\s*\r?\n\s*/g, ' ⏎ ');
      out += `${indent}- ${label}: ${oneLine}\n`;
    } else {
      out += `${indent}- ${label}\n`;
    }

    if (truncated) {
      out += `${indent}  _…narrative truncated at ${maxChars} characters._\n`;
      break;
    }
  }

  return out;
}

// --- Encapsulated document rendering ----------------------------------------
async function renderEncapsulated(parsed, file, kind, ctx, { allowRaw, maxChars }) {
  const ex = extractElementBytes(file, T.encapsulated);
  if (!ex.ok) return `Could not extract the encapsulated document: ${ex.error}`;

  let text = '';
  let heading = '';

  if (kind === 'pdf') {
    heading = '### Encapsulated PDF';
    let pdfParse;
    try {
      // Import the library entry point directly to avoid pdf-parse's debug
      // index that tries to read a bundled sample file on load.
      pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
    } catch (e) {
      return `${heading}\n\n> ⚠ PDF text extraction is unavailable (\`pdf-parse\` not installed: ${e.message}). Run \`npm install pdf-parse\`.`;
    }
    try {
      const data = await pdfParse(ex.bytes);
      text = data.text || '';
      heading += ` (${data.numpages || '?'} page(s))`;
    } catch (e) {
      return `${heading}\n\n> ⚠ Failed to parse the embedded PDF: ${e.message}`;
    }
  } else {
    heading = kind === 'xml' ? '### Encapsulated CDA / XML' : '### Encapsulated Document';
    text = ex.bytes.toString('utf8');
  }

  const lines = text.split(/\r?\n/);
  const safe = await safeNarrative(ctx, lines, { allowRaw });

  let out = `${heading}\n\n`;
  if (safe.mode === 'withheld') {
    out += `> ⚠ PII service unavailable (${safe.error}) — document body withheld to prevent PHI leakage. `;
    out += `Start the PII service, or set \`allowRaw: true\` (only works if the server allows raw PHI).\n`;
    return out;
  }
  if (safe.note) out += `> ${safe.note}\n\n`;
  else if (safe.redactions) out += `> ${safe.redactions} PHI span(s) redacted from the document body.\n\n`;

  let body = safe.texts.join('\n').trim();
  if (body.length > maxChars) body = body.slice(0, maxChars) + `\n…_(truncated at ${maxChars} characters)_`;
  if (!body) body = '_(document produced no extractable text)_';

  const fence = kind === 'xml' ? 'xml' : 'text';
  out += `\`\`\`${fence}\n${body}\n\`\`\`\n`;
  return out;
}

// --- tool registration -------------------------------------------------------
export function registerReportTools(server, ctx) {
  server.tool(
    'read_report',
    'Read the human-readable content of a DICOM report file: native Structured Reports (SR), Encapsulated PDF, and Encapsulated CDA/XML documents. Narrative free text is scanned for PHI and redacted by default before it reaches the model.',
    {
      file: z.string().describe('Path to a .dcm file containing an SR or an encapsulated PDF/CDA/XML document'),
      allowRaw: z.boolean().optional().default(false).describe('Return raw, unredacted narrative (only honored if the server is configured to allow raw PHI)'),
      maxChars: z.number().int().positive().optional().default(20000).describe('Maximum characters of narrative/body text to return (default 20000)'),
    },
    async ({ file, allowRaw, maxChars }) => {
      const parsed = parseFile(file);
      if (!parsed.ok) {
        return { content: [{ type: 'text', text: `Cannot parse: ${parsed.error}` }], isError: true };
      }

      const kind = detectReportKind(parsed);

      // Header block common to every report kind (PHI tags auto-masked).
      let header = `## Report: ${path.basename(file)}\n`;
      const titleTag = getTagValue(parsed, T.documentTitle);
      if (titleTag) {
        const { display } = renderTagValue(ctx, T.documentTitle, titleTag, { allowRaw });
        header += `- Title: ${truncate(display, 80)}\n`;
      }
      const studyDesc = getTagValue(parsed, '00081030');
      if (studyDesc) {
        const { display, masked } = renderTagValue(ctx, '00081030', studyDesc, { allowRaw });
        header += `- Study: ${truncate(display, 60)}${masked ? ' (masked)' : ''}\n`;
      }
      const contentDate = getTagValue(parsed, '00080023');
      if (contentDate) {
        const { display } = renderTagValue(ctx, '00080023', contentDate, { allowRaw });
        header += `- Content date: ${display}\n`;
      }
      header += '\n';

      let body;
      switch (kind) {
        case 'sr':
          body = await renderSr(parsed, ctx, { allowRaw, maxChars });
          break;
        case 'pdf':
        case 'xml':
          body = await renderEncapsulated(parsed, file, kind, ctx, { allowRaw, maxChars });
          break;
        case 'encapsulated-other': {
          const mime = getTagValue(parsed, T.mimeType) || 'unknown';
          body = `### Encapsulated Document\n\n> This file embeds a non-text document (MIME: \`${mime}\`) such as STL/OBJ/MTL. Its content isn't renderable as text; use the appropriate viewer.`;
          break;
        }
        default:
          body =
            `This file does not look like a report (no SR ContentSequence and no encapsulated document). ` +
            `Use \`explain_tags\` to inspect its metadata instead.`;
      }

      return { content: [{ type: 'text', text: header + body }] };
    }
  );
}
