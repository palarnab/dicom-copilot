/**
 * A curated DICOM data dictionary.
 *
 * Keyed by the 8-hex-digit tag (group + element, uppercase, no separators),
 * e.g. "00100010" for PatientName.
 *
 * This is intentionally a *curated* set covering the attributes that matter for
 * metadata exploration, conformance checking and PHI handling — not the full
 * ~4000-entry standard. Unknown tags are still surfaced (with their raw tag and
 * VR); they simply won't have a friendly name. That is an honest, useful
 * trade-off that keeps the server dependency-light and fully offline.
 *
 * Each entry: { keyword, name, vr }
 *   keyword — DICOM keyword (PascalCase, no spaces)
 *   name    — human friendly label
 *   vr      — default Value Representation (used when a file uses implicit VR)
 */

export const DICTIONARY = {
  // ---- File Meta Information (group 0002) ----
  '00020000': { keyword: 'FileMetaInformationGroupLength', name: 'File Meta Group Length', vr: 'UL' },
  '00020001': { keyword: 'FileMetaInformationVersion', name: 'File Meta Version', vr: 'OB' },
  '00020002': { keyword: 'MediaStorageSOPClassUID', name: 'Media Storage SOP Class UID', vr: 'UI' },
  '00020003': { keyword: 'MediaStorageSOPInstanceUID', name: 'Media Storage SOP Instance UID', vr: 'UI' },
  '00020010': { keyword: 'TransferSyntaxUID', name: 'Transfer Syntax UID', vr: 'UI' },
  '00020012': { keyword: 'ImplementationClassUID', name: 'Implementation Class UID', vr: 'UI' },
  '00020013': { keyword: 'ImplementationVersionName', name: 'Implementation Version Name', vr: 'SH' },
  '00020016': { keyword: 'SourceApplicationEntityTitle', name: 'Source AE Title', vr: 'AE' },

  // ---- Patient (group 0010) ----
  '00100010': { keyword: 'PatientName', name: 'Patient Name', vr: 'PN' },
  '00100020': { keyword: 'PatientID', name: 'Patient ID', vr: 'LO' },
  '00100021': { keyword: 'IssuerOfPatientID', name: 'Issuer of Patient ID', vr: 'LO' },
  '00100030': { keyword: 'PatientBirthDate', name: 'Patient Birth Date', vr: 'DA' },
  '00100032': { keyword: 'PatientBirthTime', name: 'Patient Birth Time', vr: 'TM' },
  '00100040': { keyword: 'PatientSex', name: 'Patient Sex', vr: 'CS' },
  '00101000': { keyword: 'OtherPatientIDs', name: 'Other Patient IDs', vr: 'LO' },
  '00101001': { keyword: 'OtherPatientNames', name: 'Other Patient Names', vr: 'PN' },
  '00101010': { keyword: 'PatientAge', name: 'Patient Age', vr: 'AS' },
  '00101020': { keyword: 'PatientSize', name: 'Patient Size', vr: 'DS' },
  '00101030': { keyword: 'PatientWeight', name: 'Patient Weight', vr: 'DS' },
  '00101040': { keyword: 'PatientAddress', name: 'Patient Address', vr: 'LO' },
  '00102150': { keyword: 'CountryOfResidence', name: 'Country of Residence', vr: 'LO' },
  '00102154': { keyword: 'PatientTelephoneNumbers', name: 'Patient Telephone Numbers', vr: 'SH' },
  '00102160': { keyword: 'EthnicGroup', name: 'Ethnic Group', vr: 'SH' },
  '00104000': { keyword: 'PatientComments', name: 'Patient Comments', vr: 'LT' },

  // ---- General Study (group 0008 / 0020 / 0032) ----
  '00080005': { keyword: 'SpecificCharacterSet', name: 'Specific Character Set', vr: 'CS' },
  '00080008': { keyword: 'ImageType', name: 'Image Type', vr: 'CS' },
  '00080012': { keyword: 'InstanceCreationDate', name: 'Instance Creation Date', vr: 'DA' },
  '00080013': { keyword: 'InstanceCreationTime', name: 'Instance Creation Time', vr: 'TM' },
  '00080016': { keyword: 'SOPClassUID', name: 'SOP Class UID', vr: 'UI' },
  '00080018': { keyword: 'SOPInstanceUID', name: 'SOP Instance UID', vr: 'UI' },
  '00080020': { keyword: 'StudyDate', name: 'Study Date', vr: 'DA' },
  '00080021': { keyword: 'SeriesDate', name: 'Series Date', vr: 'DA' },
  '00080022': { keyword: 'AcquisitionDate', name: 'Acquisition Date', vr: 'DA' },
  '00080023': { keyword: 'ContentDate', name: 'Content Date', vr: 'DA' },
  '00080030': { keyword: 'StudyTime', name: 'Study Time', vr: 'TM' },
  '00080031': { keyword: 'SeriesTime', name: 'Series Time', vr: 'TM' },
  '00080032': { keyword: 'AcquisitionTime', name: 'Acquisition Time', vr: 'TM' },
  '00080033': { keyword: 'ContentTime', name: 'Content Time', vr: 'TM' },
  '00080050': { keyword: 'AccessionNumber', name: 'Accession Number', vr: 'SH' },
  '00080060': { keyword: 'Modality', name: 'Modality', vr: 'CS' },
  '00080064': { keyword: 'ConversionType', name: 'Conversion Type', vr: 'CS' },
  '00080070': { keyword: 'Manufacturer', name: 'Manufacturer', vr: 'LO' },
  '00080080': { keyword: 'InstitutionName', name: 'Institution Name', vr: 'LO' },
  '00080081': { keyword: 'InstitutionAddress', name: 'Institution Address', vr: 'ST' },
  '00080090': { keyword: 'ReferringPhysicianName', name: 'Referring Physician Name', vr: 'PN' },
  '00081010': { keyword: 'StationName', name: 'Station Name', vr: 'SH' },
  '00081030': { keyword: 'StudyDescription', name: 'Study Description', vr: 'LO' },
  '0008103E': { keyword: 'SeriesDescription', name: 'Series Description', vr: 'LO' },
  '00081040': { keyword: 'InstitutionalDepartmentName', name: 'Institutional Department Name', vr: 'LO' },
  '00081048': { keyword: 'PhysiciansOfRecord', name: 'Physicians of Record', vr: 'PN' },
  '00081050': { keyword: 'PerformingPhysicianName', name: 'Performing Physician Name', vr: 'PN' },
  '00081060': { keyword: 'NameOfPhysiciansReadingStudy', name: 'Physician Reading Study', vr: 'PN' },
  '00081070': { keyword: 'OperatorsName', name: 'Operators Name', vr: 'PN' },
  '00081080': { keyword: 'AdmittingDiagnosesDescription', name: 'Admitting Diagnoses Description', vr: 'LO' },
  '00081090': { keyword: 'ManufacturerModelName', name: 'Manufacturer Model Name', vr: 'LO' },
  '00080090DUP': { keyword: '', name: '', vr: '' }, // placeholder guard (never used)

  // ---- Study / Series identifiers (group 0020) ----
  '0020000D': { keyword: 'StudyInstanceUID', name: 'Study Instance UID', vr: 'UI' },
  '0020000E': { keyword: 'SeriesInstanceUID', name: 'Series Instance UID', vr: 'UI' },
  '00200010': { keyword: 'StudyID', name: 'Study ID', vr: 'SH' },
  '00200011': { keyword: 'SeriesNumber', name: 'Series Number', vr: 'IS' },
  '00200012': { keyword: 'AcquisitionNumber', name: 'Acquisition Number', vr: 'IS' },
  '00200013': { keyword: 'InstanceNumber', name: 'Instance Number', vr: 'IS' },
  '00200032': { keyword: 'ImagePositionPatient', name: 'Image Position (Patient)', vr: 'DS' },
  '00200037': { keyword: 'ImageOrientationPatient', name: 'Image Orientation (Patient)', vr: 'DS' },
  '00200052': { keyword: 'FrameOfReferenceUID', name: 'Frame of Reference UID', vr: 'UI' },
  '00201040': { keyword: 'PositionReferenceIndicator', name: 'Position Reference Indicator', vr: 'LO' },
  '00201041': { keyword: 'SliceLocation', name: 'Slice Location', vr: 'DS' },

  // ---- Equipment / acquisition (group 0018) ----
  '00180015': { keyword: 'BodyPartExamined', name: 'Body Part Examined', vr: 'CS' },
  '00180020': { keyword: 'ScanningSequence', name: 'Scanning Sequence', vr: 'CS' },
  '00180021': { keyword: 'SequenceVariant', name: 'Sequence Variant', vr: 'CS' },
  '00180022': { keyword: 'ScanOptions', name: 'Scan Options', vr: 'CS' },
  '00180023': { keyword: 'MRAcquisitionType', name: 'MR Acquisition Type', vr: 'CS' },
  '00180050': { keyword: 'SliceThickness', name: 'Slice Thickness', vr: 'DS' },
  '00180060': { keyword: 'KVP', name: 'KVP', vr: 'DS' },
  '00180080': { keyword: 'RepetitionTime', name: 'Repetition Time (TR)', vr: 'DS' },
  '00180081': { keyword: 'EchoTime', name: 'Echo Time (TE)', vr: 'DS' },
  '00180087': { keyword: 'MagneticFieldStrength', name: 'Magnetic Field Strength', vr: 'DS' },
  '00180088': { keyword: 'SpacingBetweenSlices', name: 'Spacing Between Slices', vr: 'DS' },
  '00181000': { keyword: 'DeviceSerialNumber', name: 'Device Serial Number', vr: 'LO' },
  '00181020': { keyword: 'SoftwareVersions', name: 'Software Versions', vr: 'LO' },
  '00181030': { keyword: 'ProtocolName', name: 'Protocol Name', vr: 'LO' },
  '00181100': { keyword: 'ReconstructionDiameter', name: 'Reconstruction Diameter', vr: 'DS' },
  '00181150': { keyword: 'ExposureTime', name: 'Exposure Time', vr: 'IS' },
  '00181151': { keyword: 'XRayTubeCurrent', name: 'X-Ray Tube Current', vr: 'IS' },
  '00181152': { keyword: 'Exposure', name: 'Exposure', vr: 'IS' },
  '00185100': { keyword: 'PatientPosition', name: 'Patient Position', vr: 'CS' },
  '00180010': { keyword: 'ContrastBolusAgent', name: 'Contrast/Bolus Agent', vr: 'LO' },
  '00181040': { keyword: 'ContrastBolusRoute', name: 'Contrast/Bolus Route', vr: 'LO' },
  '00181049': { keyword: 'ContrastBolusIngredientConcentration', name: 'Contrast/Bolus Ingredient Concentration', vr: 'DS' },

  // ---- Image pixel (group 0028) ----
  '00280002': { keyword: 'SamplesPerPixel', name: 'Samples per Pixel', vr: 'US' },
  '00280004': { keyword: 'PhotometricInterpretation', name: 'Photometric Interpretation', vr: 'CS' },
  '00280010': { keyword: 'Rows', name: 'Rows', vr: 'US' },
  '00280011': { keyword: 'Columns', name: 'Columns', vr: 'US' },
  '00280030': { keyword: 'PixelSpacing', name: 'Pixel Spacing', vr: 'DS' },
  '00280100': { keyword: 'BitsAllocated', name: 'Bits Allocated', vr: 'US' },
  '00280101': { keyword: 'BitsStored', name: 'Bits Stored', vr: 'US' },
  '00280102': { keyword: 'HighBit', name: 'High Bit', vr: 'US' },
  '00280103': { keyword: 'PixelRepresentation', name: 'Pixel Representation', vr: 'US' },
  '00281050': { keyword: 'WindowCenter', name: 'Window Center', vr: 'DS' },
  '00281051': { keyword: 'WindowWidth', name: 'Window Width', vr: 'DS' },
  '00281052': { keyword: 'RescaleIntercept', name: 'Rescale Intercept', vr: 'DS' },
  '00281053': { keyword: 'RescaleSlope', name: 'Rescale Slope', vr: 'DS' },
  '00280301': { keyword: 'BurnedInAnnotation', name: 'Burned In Annotation', vr: 'CS' },
  '7FE00010': { keyword: 'PixelData', name: 'Pixel Data', vr: 'OW' },

  // ---- Free-text / report fields (PHI risk in free text) ----
  '00081080DUP': { keyword: '', name: '', vr: '' },
  '00104000DUP': { keyword: '', name: '', vr: '' },
  '00204000': { keyword: 'ImageComments', name: 'Image Comments', vr: 'LT' },
  '00081084': { keyword: 'AdmittingDiagnosesCodeSequence', name: 'Admitting Diagnoses Code Sequence', vr: 'SQ' },
  '00101021': { keyword: 'BranchOfService', name: 'Branch of Service', vr: 'LO' },
  '00102180': { keyword: 'Occupation', name: 'Occupation', vr: 'SH' },
  '001021B0': { keyword: 'AdditionalPatientHistory', name: 'Additional Patient History', vr: 'LT' },
  '00380010': { keyword: 'AdmissionID', name: 'Admission ID', vr: 'LO' },
  '00380300': { keyword: 'CurrentPatientLocation', name: 'Current Patient Location', vr: 'LO' },
  '00380400': { keyword: 'PatientInstitutionResidence', name: "Patient's Institution Residence", vr: 'LO' },
  '00384000': { keyword: 'VisitComments', name: 'Visit Comments', vr: 'LT' },
  '00321032': { keyword: 'RequestingPhysician', name: 'Requesting Physician', vr: 'PN' },
  '00321060': { keyword: 'RequestedProcedureDescription', name: 'Requested Procedure Description', vr: 'LO' },
  '00400275': { keyword: 'RequestAttributesSequence', name: 'Request Attributes Sequence', vr: 'SQ' },
  '00081032': { keyword: 'ProcedureCodeSequence', name: 'Procedure Code Sequence', vr: 'SQ' },
  '00081140': { keyword: 'ReferencedImageSequence', name: 'Referenced Image Sequence', vr: 'SQ' },
};

// Remove placeholder guard entries.
for (const k of Object.keys(DICTIONARY)) {
  if (!DICTIONARY[k].keyword) delete DICTIONARY[k];
}

/** Normalize a dicom-parser tag ("x00100010") or "(0010,0010)" to "00100010". */
export function normalizeTag(tag) {
  if (!tag) return '';
  let t = String(tag).trim().toUpperCase();
  t = t.replace(/^X/, '');
  t = t.replace(/[(),\s]/g, '');
  return t;
}

/** Look up dictionary metadata for a tag. Returns null if unknown. */
export function lookupTag(tag) {
  return DICTIONARY[normalizeTag(tag)] || null;
}

/** Format a tag as the canonical "(gggg,eeee)" display form. */
export function formatTag(tag) {
  const t = normalizeTag(tag);
  if (t.length !== 8) return `(${t})`;
  return `(${t.slice(0, 4).toLowerCase()},${t.slice(4).toLowerCase()})`;
}
