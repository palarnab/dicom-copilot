import dotenv from 'dotenv';
dotenv.config();

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function getConfig() {
  const args = process.argv.slice(2);
  let transport = process.env.MCP_TRANSPORT || 'stdio';

  const transportIdx = args.indexOf('--transport');
  if (transportIdx !== -1 && args[transportIdx + 1]) {
    transport = args[transportIdx + 1];
  }

  const rootPaths = (process.env.DICOM_ROOT_PATHS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    transport,
    port: parseInt(process.env.MCP_PORT || '3200', 10),
    dicom: {
      rootPaths,
      maxFiles: parseInt(process.env.DICOM_MAX_FILES || '20000', 10),
      redactByDefault: parseBool(process.env.DICOM_REDACT_BY_DEFAULT, true),
      allowRawPhi: parseBool(process.env.DICOM_ALLOW_RAW_PHI, false),
    },
    pii: {
      baseUrl: process.env.PII_SERVICE_URL || 'http://localhost:5001',
      minScore: parseFloat(process.env.PII_MIN_SCORE || '0.5'),
      timeoutMs: parseInt(process.env.PII_TIMEOUT_MS || '8000', 10),
    },
  };
}
