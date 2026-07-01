import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import express from 'express';

import { getConfig } from './config.js';
import { DatasetIndex } from './dicom/dataset.js';
import { PiiClient } from './services/pii-client.js';
import { registerExploreTools } from './tools/explore.js';
import { registerValidateTools } from './tools/validate.js';
import { registerPhiTools } from './tools/phi.js';

const VERSION = '1.0.0';

export async function createServer() {
  const config = getConfig();
  const index = new DatasetIndex();
  const pii = new PiiClient(config.pii);

  const ctx = { config, index, pii };

  const server = new McpServer({
    name: 'dicom-copilot',
    version: VERSION,
  });

  registerExploreTools(server, ctx);
  registerValidateTools(server, ctx);
  registerPhiTools(server, ctx);

  // Resource: current dataset / configuration snapshot.
  server.resource(
    'dicom-info',
    'dicom://info',
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify({
          version: VERSION,
          scannedRoots: index.listRoots(),
          redactByDefault: config.dicom.redactByDefault,
          allowRawPhi: config.dicom.allowRawPhi,
          piiService: config.pii.baseUrl,
        }, null, 2),
      }],
    })
  );

  // Pre-scan any configured roots.
  for (const root of config.dicom.rootPaths) {
    try {
      const r = index.scan(root, { maxFiles: config.dicom.maxFiles });
      console.error(`[dicom-copilot] ✓ Indexed ${r.dicomCount} DICOM files in ${r.root}`);
    } catch (e) {
      console.error(`[dicom-copilot] ✗ Failed to scan ${root}: ${e.message}`);
    }
  }

  // Report PII service availability once at startup (non-fatal).
  pii.health().then((h) => {
    if (h.ok) console.error(`[dicom-copilot] ✓ PII service reachable at ${config.pii.baseUrl}`);
    else console.error(`[dicom-copilot] ⚠ PII service NOT reachable at ${config.pii.baseUrl} (${h.error || h.status}) — deterministic PHI detection still works`);
  });

  return { server, index, pii, config };
}

export async function startStdioTransport(server) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[dicom-copilot] MCP server running on stdio');
}

export async function startSSETransport(server, port) {
  const app = express();
  const transports = new Map();

  app.get('/sse', async (req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    transports.set(transport.sessionId, transport);
    res.on('close', () => transports.delete(transport.sessionId));
    await server.connect(transport);
  });

  app.post('/messages', async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = transports.get(sessionId);
    if (!transport) { res.status(404).json({ error: 'Session not found' }); return; }
    await transport.handlePostMessage(req, res);
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: 'dicom-copilot', version: VERSION });
  });

  app.listen(port, () => {
    console.error(`[dicom-copilot] MCP SSE server: http://localhost:${port}`);
    console.error(`[dicom-copilot] SSE endpoint:   http://localhost:${port}/sse`);
    console.error(`[dicom-copilot] Health check:   http://localhost:${port}/health`);
  });
}
