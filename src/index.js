import { createServer, startStdioTransport, startSSETransport } from './server.js';

async function main() {
  try {
    const { server, config } = await createServer();

    if (config.transport === 'stdio') {
      await startStdioTransport(server);
    } else {
      await startSSETransport(server, config.port);
    }

    process.on('SIGINT', () => { console.error('[dicom-copilot] Shutting down...'); process.exit(0); });
    process.on('SIGTERM', () => { console.error('[dicom-copilot] Shutting down...'); process.exit(0); });
  } catch (error) {
    console.error('[dicom-copilot] Fatal error:', error);
    process.exit(1);
  }
}

main();
