/**
 * Known PHI (Protected Health Information) tags and de-identification actions.
 *
 * Based on the DICOM PS3.15 Annex E "Basic Application Level Confidentiality
 * Profile" plus common real-world PHI hiding spots. This is the DETERMINISTIC
 * layer of PHI detection — it always works, fully offline, even when the
 * external PII service is unavailable.
 *
 * action:
 *   'remove'  — the value must be removed entirely (X in PS3.15)
 *   'replace' — replace with a non-identifying dummy value (D / Z)
 *   'clean'   — free text that may contain PHI; must be inspected/scrubbed (C)
 *   'uid'     — UID that is patient-derived and should be remapped consistently (U)
 */

import { normalizeTag } from './dictionary.js';

export const PHI_TAGS = {
  // Direct identifiers
  '00100010': { label: 'Patient Name', action: 'replace' },
  '00100020': { label: 'Patient ID', action: 'replace' },
  '00100021': { label: 'Issuer of Patient ID', action: 'remove' },
  '00100030': { label: 'Patient Birth Date', action: 'replace' },
  '00100032': { label: 'Patient Birth Time', action: 'remove' },
  '00100040': { label: 'Patient Sex', action: 'replace' },
  '00101000': { label: 'Other Patient IDs', action: 'remove' },
  '00101001': { label: 'Other Patient Names', action: 'remove' },
  '00101010': { label: 'Patient Age', action: 'replace' },
  '00101020': { label: 'Patient Size', action: 'remove' },
  '00101030': { label: 'Patient Weight', action: 'remove' },
  '00101040': { label: 'Patient Address', action: 'remove' },
  '00102150': { label: 'Country of Residence', action: 'remove' },
  '00102154': { label: 'Patient Telephone Numbers', action: 'remove' },
  '00102160': { label: 'Ethnic Group', action: 'remove' },
  '00104000': { label: 'Patient Comments', action: 'clean' },
  '00101021': { label: 'Branch of Service', action: 'remove' },
  '00102180': { label: 'Occupation', action: 'clean' },
  '001021B0': { label: 'Additional Patient History', action: 'clean' },

  // Care providers / institutions
  '00080080': { label: 'Institution Name', action: 'remove' },
  '00080081': { label: 'Institution Address', action: 'remove' },
  '00080090': { label: 'Referring Physician Name', action: 'remove' },
  '00081040': { label: 'Institutional Department Name', action: 'remove' },
  '00081048': { label: 'Physicians of Record', action: 'remove' },
  '00081050': { label: 'Performing Physician Name', action: 'remove' },
  '00081060': { label: 'Physician Reading Study', action: 'remove' },
  '00081070': { label: 'Operators Name', action: 'remove' },
  '00081010': { label: 'Station Name', action: 'remove' },
  '00321032': { label: 'Requesting Physician', action: 'remove' },

  // Order / visit identifiers
  '00080050': { label: 'Accession Number', action: 'replace' },
  '00380010': { label: 'Admission ID', action: 'remove' },
  '00380300': { label: 'Current Patient Location', action: 'remove' },
  '00380400': { label: 'Patient Institution Residence', action: 'remove' },
  '00384000': { label: 'Visit Comments', action: 'clean' },
  '00200010': { label: 'Study ID', action: 'replace' },

  // Free-text descriptions that frequently leak PHI
  '00081030': { label: 'Study Description', action: 'clean' },
  '0008103E': { label: 'Series Description', action: 'clean' },
  '00081080': { label: 'Admitting Diagnoses Description', action: 'clean' },
  '00321060': { label: 'Requested Procedure Description', action: 'clean' },
  '00204000': { label: 'Image Comments', action: 'clean' },

  // Dates/times that enable re-identification
  '00080020': { label: 'Study Date', action: 'replace' },
  '00080021': { label: 'Series Date', action: 'replace' },
  '00080022': { label: 'Acquisition Date', action: 'replace' },
  '00080023': { label: 'Content Date', action: 'replace' },
  '00080012': { label: 'Instance Creation Date', action: 'replace' },

  // Patient-derived / device UIDs
  '00080018': { label: 'SOP Instance UID', action: 'uid' },
  '0020000D': { label: 'Study Instance UID', action: 'uid' },
  '0020000E': { label: 'Series Instance UID', action: 'uid' },
  '00181000': { label: 'Device Serial Number', action: 'remove' },
};

/** Free-text tags whose VALUE should be sent to the PII service for scanning. */
export const FREE_TEXT_TAGS = new Set([
  '00104000', '001021B0', '00384000', '00204000',
  '00081030', '0008103E', '00081080', '00321060',
  '00102180', '00380400',
]);

export function isPhiTag(tag) {
  return Boolean(PHI_TAGS[normalizeTag(tag)]);
}

export function getPhiInfo(tag) {
  return PHI_TAGS[normalizeTag(tag)] || null;
}

export function isFreeTextTag(tag) {
  return FREE_TEXT_TAGS.has(normalizeTag(tag));
}

/**
 * Mask a value so the AI learns its shape/length but not the actual PHI.
 * "John Smith" -> "J********h", "01/15/2026" -> "0********6".
 */
export function maskValue(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.length <= 2) return '*'.repeat(s.length);
  if (s.length <= 4) return s[0] + '*'.repeat(s.length - 1);
  return s[0] + '*'.repeat(s.length - 2) + s[s.length - 1];
}
