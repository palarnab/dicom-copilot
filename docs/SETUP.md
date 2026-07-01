# DICOM Copilot — Setup Guide

This guide walks you from zero to asking questions about DICOM files inside
VS Code.

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js 18+** | Provides global `fetch`; check with `node --version` |
| **npm** | Ships with Node |
| **VS Code** with GitHub Copilot (or any MCP client) | For the chat experience |
| **A local PII service** (optional) | Enables free-text PHI detection; the server works without it |
| **DICOM files** | A folder of `.dcm` files (the smoke test can generate a synthetic one) |

---

## 1. Install

```powershell
cd c:\git\poc\dicom-copilot
npm install
```

Pure JavaScript — no build step. Install is fast and has no native dependencies.

---

## 2. Configure

Copy the example environment file and edit it:

```powershell
Copy-Item .env.example .env
```

Key settings in `.env`:

```ini
# Transport: stdio for VS Code, sse for HTTP clients
MCP_TRANSPORT=stdio
MCP_PORT=3200

# Optional: folders pre-scanned at startup (comma-separated)
DICOM_ROOT_PATHS=./test-data

# Safety cap for very large archives
DICOM_MAX_FILES=20000

# Your local PII detection service
PII_SERVICE_URL=http://localhost:5001
PII_MIN_SCORE=0.5
PII_TIMEOUT_MS=8000

# PHI safety (recommended defaults)
DICOM_REDACT_BY_DEFAULT=true
DICOM_ALLOW_RAW_PHI=false
```

> **Tip:** Leave `DICOM_REDACT_BY_DEFAULT=true` and `DICOM_ALLOW_RAW_PHI=false`
> unless you fully understand the compliance implications of exposing raw PHI.

---

## 3. Verify the pipeline

Run the smoke test. It generates a synthetic DICOM study in `test-data/`, parses
it, scans the folder, exercises PHI helpers, registers all tools, and pings the
PII service:

```powershell
npm run test:smoke
```

Expected tail:

```
PASS: 10 passed, 0 failed
```

If the PII service isn't running you'll see a non-fatal warning — everything else
still passes.

---

## 4. (Optional) Start the PII service

The server calls an external PII detector honoring this contract:

```
GET  http://localhost:5001/            -> 200 (health)
POST http://localhost:5001/detect_pii  { "texts": ["...", "..."] }
```

Example request/response:

```bash
curl -X POST "http://localhost:5001/detect_pii" \
  -H "Content-Type: application/json" \
  -d '{ "texts": ["Patient John Smith was seen on 01/15/2026"] }'
```

```json
{
  "results": [
    {
      "textindex": 0,
      "originaltext": "Patient John Smith was seen on 01/15/2026",
      "piientities": [
        { "entitytype": "PERSON", "start": 8, "end": 18, "value": "John Smith", "score": 0.92 },
        { "entitytype": "DATE_TIME", "start": 31, "end": 41, "value": "01/15/2026", "score": 0.85 }
      ]
    }
  ]
}
```

Confirm the server can see it:

```powershell
node -e "import('./src/services/pii-client.js').then(async m => { const c = new m.PiiClient({ baseUrl: process.env.PII_SERVICE_URL || 'http://localhost:5001' }); console.log(await c.health()); })"
```

---

## 5. Run the server

**For VS Code (stdio):**

```powershell
npm run start:stdio
```

**As an HTTP/SSE server:**

```powershell
npm start
# SSE endpoint:  http://localhost:3200/sse
# Health check:  http://localhost:3200/health
```

---

## 6. Wire it into VS Code

Create `.vscode/mcp.json` in the workspace where you'll open DICOM files (or add
to your user MCP config):

```json
{
  "servers": {
    "dicom-copilot": {
      "command": "node",
      "args": ["src/index.js", "--transport", "stdio"],
      "cwd": "c:/git/poc/dicom-copilot",
      "env": {
        "PII_SERVICE_URL": "http://localhost:5001",
        "DICOM_REDACT_BY_DEFAULT": "true",
        "DICOM_ALLOW_RAW_PHI": "false"
      }
    }
  }
}
```

Reload VS Code. In Copilot Chat (Agent mode), the `dicom-copilot` tools become
available. Try:

> *Scan `c:/studies/export` and show me the study hierarchy.*

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `PII service NOT reachable` | Service not running / wrong URL | Start it or fix `PII_SERVICE_URL` (detection still runs deterministically) |
| `Not a parseable DICOM file` | File isn't DICOM or is corrupt | Confirm it has a `DICM` preamble; try another file |
| No tags have friendly names | Tag not in curated dictionary | Value still shown with raw tag + VR; extend `dictionary.js` if needed |
| Tools don't appear in VS Code | MCP config not loaded | Check `.vscode/mcp.json` path/`cwd`, reload window |
| Everything masked as `****` | `DICOM_REDACT_BY_DEFAULT=true` | Expected — this is the PHI-safety default |

---

## Next steps

- Read [USAGE.md](USAGE.md) for every tool and prompt recipes.
- Read [PROBLEM-AND-EXAMPLES.md](PROBLEM-AND-EXAMPLES.md) for realistic Q&A.
