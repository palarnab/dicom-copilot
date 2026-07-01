/**
 * Shared presentation helpers for tools. Central place for the
 * "redact PHI before it reaches the model" safety rule.
 */

import { getPhiInfo, maskValue } from '../dicom/phi-tags.js';

/**
 * Decide how a tag value should be shown to the AI.
 * @returns {{ display: string, masked: boolean }}
 */
export function renderTagValue(ctx, tag, value, { allowRaw = false } = {}) {
  const phi = getPhiInfo(tag);
  const isBinary = typeof value === 'string' && value.startsWith('<binary');
  if (value === null || value === undefined) return { display: '', masked: false };

  const raw = String(value);
  if (!phi || isBinary) return { display: raw, masked: false };

  // PHI tag. Mask unless raw is explicitly allowed AND permitted by config.
  const permitRaw = allowRaw && ctx.config.dicom.allowRawPhi;
  if (ctx.config.dicom.redactByDefault && !permitRaw) {
    return { display: maskValue(raw), masked: true };
  }
  return { display: raw, masked: false };
}

export function truncate(str, max = 80) {
  const s = String(str ?? '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
