# MCP DICOM Copilot

A **local-first, PHI-safe** [Model Context Protocol](https://modelcontextprotocol.io) server that connects AI assistants (GitHub Copilot, Claude, etc.) to folders of **DICOM** medical-imaging files. It translates cryptic DICOM tags into plain language, validates conformance, diffs vendor/scanner differences, and locates **PHI** (Protected Health Information) — so the AI reasons about your *actual* studies instead of guessing.

> Think "Database Copilot, but for DICOM." Same philosophy: ground the AI in real data, keep it read-only, and keep sensitive values out of the model.

## Why

DICOM is ubiquitous, ancient, and painful: hex-coded tags like `(0018,0050)`, inconsistent vendor implementations, and PHI scattered across dozens of fields (and sometimes burned into the pixels). This server makes that complexity **conversational** while never leaking patient data to the AI model.

## Safety model (read this first)

- **Local-first.** All DICOM parsing happens on your machine. Files never leave your environment.
- **Redact-before-model.** PHI-bearing tag values are **masked** before being returned to the AI (`John Smith` → `J********h`). The AI learns *where* PHI is, never the raw value.
- **No diagnosis.** This server deliberately stays in the metadata / conformance / de-identification lane. It never interprets images (which would make it a regulated medical device).
- **PII service is optional and local.** Free-text PHI detection uses an external PII service you run yourself (see below). If it's down, deterministic known-PHI-tag detection still works.

## Features

- **Tag explanation** — translate every tag in a file to name + VR + value (`explain_tags`, `get_tag`)
- **Folder intelligence** — recursively scan and build a Patient → Study → Series → Instance tree (`scan_folder`, `study_hierarchy`, `describe_study`)
- **Conformance validation** — catch missing Type-1/2 attributes, unknown transfer syntaxes, inconsistent pixel encoding (`validate_conformance`)
- **Metadata diff** — pinpoint vendor/scanner differences between two files (`diff_metadata`)
- **PHI detection** — deterministic known-PHI tags + free-text scanning via your PII service, with burned-in-annotation warnings (`find_phi`, `deidentify_preview`, `pii_service_status`)

## Supported inputs

| Input | Status |
|-------|--------|
| DICOM Part-10 files (`.dcm`, `.dicom`, `.ima`, extension-less with `DICM` preamble) | ✅ |
| Explicit/Implicit VR, Little/Big Endian, common JPEG/JPEG2000/RLE transfer syntaxes (metadata) | ✅ |
| Burned-in pixel PHI **detection flag** (`BurnedInAnnotation`) | ✅ |
| Burned-in pixel PHI via **OCR** | ⛔ Not yet (roadmap) |

## Quick start

```bash
npm install
cp .env.example .env      # adjust paths / PII service URL
npm run test:smoke        # generates a synthetic study and verifies the pipeline

# Run for VS Code (stdio)
npm run start:stdio

# Or run as an HTTP/SSE server
npm start
```

No build step — pure JavaScript (ES modules), Node 18+.

## Configuration

All settings live in `.env` (see `.env.example`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_TRANSPORT` | `stdio` | `stdio` (VS Code) or `sse` (HTTP) |
| `MCP_PORT` | `3200` | Port for the `sse` transport |
| `DICOM_ROOT_PATHS` | — | Comma-separated folders pre-scanned at startup |
| `DICOM_MAX_FILES` | `20000` | Safety cap per scan |
| `PII_SERVICE_URL` | `http://localhost:5001` | Your local PII detection service |
| `PII_MIN_SCORE` | `0.5` | Minimum confidence to treat an entity as PHI |
| `PII_TIMEOUT_MS` | `8000` | PII request timeout |
| `DICOM_REDACT_BY_DEFAULT` | `true` | Mask PHI values before returning to the AI |
| `DICOM_ALLOW_RAW_PHI` | `false` | Permit tools to return raw PHI when explicitly asked |

### PII service contract

The server calls an external, local PII detection service you provide:

```
GET  {PII_SERVICE_URL}/            -> 200 (health)
POST {PII_SERVICE_URL}/detect_pii  { "texts": ["...", "..."] }
```

Expected response:

```json
{
  "results": [
    {
      "textindex": 0,
      "originaltext": "Patient John Smith was seen on 01/15/2026",
      "piientities": [
        { "entitytype": "PERSON", "start": 8, "end": 18, "value": "John Smith", "score": 0.92 }
      ]
    }
  ]
}
```

## VS Code MCP setup

Add to your VS Code MCP config (e.g. `.vscode/mcp.json`):

```json
{
  "servers": {
    "dicom-copilot": {
      "command": "node",
      "args": ["src/index.js", "--transport", "stdio"],
      "cwd": "c:/git/poc/dicom-copilot",
      "env": {
        "PII_SERVICE_URL": "http://localhost:5001",
        "DICOM_REDACT_BY_DEFAULT": "true"
      }
    }
  }
}
```

Then, in Copilot Chat, point it at a folder and ask questions like:

- *"Scan `./test-data` and show me the study hierarchy."*
- *"Why might this file fail to open? Validate conformance on `series1/img001.dcm`."*
- *"Find all PHI in this folder and tell me which fields need de-identification."*
- *"Diff the metadata of these two files — what did the scanner change?"*

## Tools reference

| Tool | Description |
|------|-------------|
| `scan_folder` | Recursively index a folder into Patient→Study→Series→Instance |
| `study_hierarchy` | Show the tree for a scanned folder |
| `describe_study` | Human summary of one study (modalities, series, transfer syntaxes, burned-in flags) |
| `explain_tags` | Translate all tags in a file to plain language (PHI masked) |
| `get_tag` | Look up one tag by number or keyword (PHI masked) |
| `validate_conformance` | Report missing/invalid attributes and pixel-encoding issues |
| `diff_metadata` | Compare two files' tags (added/removed/changed) |
| `find_phi` | Locate PHI across a file/folder (known tags + PII service) |
| `deidentify_preview` | Show a per-tag de-identification plan (no files modified) |
| `pii_service_status` | Check PII service reachability |

## Project structure

```
src/
  index.js              # entry point / transport selection
  server.js             # MCP server, tool registration, transports
  config.js             # env parsing
  dicom/
    dictionary.js       # curated DICOM tag dictionary
    phi-tags.js         # known PHI tags + de-id actions + masking
    parser.js           # VR-aware DICOM file parser (dicom-parser)
    scanner.js          # recursive folder scan + hierarchy
    dataset.js          # in-memory scan index
  services/
    pii-client.js       # HTTP client for the local PII service
  tools/
    explore.js          # scan/hierarchy/describe/explain/get_tag
    validate.js         # conformance + diff
    phi.js              # find_phi / deidentify_preview / status
    format.js           # PHI-safe value rendering
scripts/
  smoke-test.js         # synthetic DICOM generator + pipeline test
```

## Limitations / roadmap

- **No OCR** for burned-in pixel PHI yet — the server flags `BurnedInAnnotation` but cannot read text baked into images.
- **Curated dictionary** — unknown tags are surfaced with raw tag + VR but no friendly name.
- **No DICOM network (C-FIND/C-MOVE)** — file/folder only for now; a PACS adapter is a natural extension.
- **De-identification is preview-only** — it recommends actions but does not write scrubbed files.

## License

MIT
