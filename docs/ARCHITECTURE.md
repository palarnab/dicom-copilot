# DICOM Copilot — Architecture

**Document version:** 1.0
**Date:** July 2026

---

## Table of contents

1. [Overview](#overview)
2. [High-level diagram](#high-level-diagram)
3. [Component breakdown](#component-breakdown)
4. [Request / data flow](#request--data-flow)
5. [PHI safety model](#phi-safety-model)
6. [PII service integration](#pii-service-integration)
7. [Transports](#transports)
8. [Extensibility](#extensibility)
9. [Design principles](#design-principles)

---

## Overview

DICOM Copilot is a **Model Context Protocol (MCP)** server. An AI assistant
(GitHub Copilot, Claude, etc.) connects to it and calls **tools** — small,
well-described functions — to explore, validate, and de-risk folders of DICOM
files. The server parses files locally, keeps sensitive values away from the
model, and returns concise, grounded Markdown answers.

It intentionally mirrors the sibling **Database Copilot** design: a thin MCP
layer over purpose-built domain tools, read-only by default, with safety baked
into the presentation layer.

---

## High-level diagram

```
┌──────────────────┐        MCP Protocol          ┌────────────────────────┐
│   GitHub Copilot │ ◄──────────────────────────► │     dicom-copilot      │
│    (Agent / AI)  │     (stdio or SSE/HTTP)       │       MCP Server       │
└──────────────────┘                               └───────────┬────────────┘
                                                                │
                     ┌──────────────────────────────────────────┤
                     │                                          │
             ┌───────▼────────┐                        ┌────────▼─────────┐
             │  Tool Layer    │                        │  Resources       │
             │  explore/      │                        │  dicom://info    │
             │  validate/ phi │                        └──────────────────┘
             └───────┬────────┘
                     │
      ┌──────────────┼───────────────┬──────────────────┐
      ▼              ▼               ▼                  ▼
┌───────────┐  ┌───────────┐  ┌────────────┐   ┌────────────────┐
│  Parser   │  │  Scanner  │  │ DatasetIdx │   │  PII Client    │
│(dicom-    │  │(recursive │  │(in-memory  │   │ (HTTP → local  │
│ parser)   │  │ walk)     │  │ study tree)│   │ PII service)   │
└─────┬─────┘  └─────┬─────┘  └────────────┘   └───────┬────────┘
      │              │                                 │
      ▼              ▼                                 ▼
┌─────────────────────────────┐            ┌─────────────────────────┐
│  Dictionary + PHI tag tables │            │  http://localhost:5001  │
│  (curated, offline)          │            │  /detect_pii  (your svc)│
└─────────────────────────────┘            └─────────────────────────┘
                     │
                     ▼
             ┌───────────────┐
             │  DICOM files  │  (local disk, never leave the machine)
             └───────────────┘
```

---

## Component breakdown

| Layer | File | Responsibility |
|-------|------|----------------|
| **Entry point** | `src/index.js` | Boot, pick transport, handle signals |
| **Server** | `src/server.js` | Create `McpServer`, register tools + resource, wire transports, pre-scan configured roots, report PII health |
| **Config** | `src/config.js` | Parse env (transport, roots, PII service, safety flags) |
| **Parser** | `src/dicom/parser.js` | VR-aware decode of a single file → normalized element list + meta |
| **Scanner** | `src/dicom/scanner.js` | Recursive folder walk, DICOM sniffing, build Patient→Study→Series→Instance |
| **Dataset index** | `src/dicom/dataset.js` | Cache scans in memory; look up studies/files |
| **Dictionary** | `src/dicom/dictionary.js` | Curated tag → {keyword, name, VR}; tag normalization/formatting |
| **PHI tables** | `src/dicom/phi-tags.js` | Known PHI tags + de-id actions, free-text tag set, value masking |
| **PII client** | `src/services/pii-client.js` | Defensive HTTP client for the external PII service |
| **Tools: explore** | `src/tools/explore.js` | `scan_folder`, `study_hierarchy`, `describe_study`, `explain_tags`, `get_tag` |
| **Tools: validate** | `src/tools/validate.js` | `validate_conformance`, `diff_metadata` |
| **Tools: phi** | `src/tools/phi.js` | `find_phi`, `deidentify_preview`, `pii_service_status` |
| **Format** | `src/tools/format.js` | The single choke point for redact-before-model rendering |

---

## Request / data flow

Example: *"Find all PHI in this folder."*

```
AI ──tools/call find_phi(path)──► Server
                                    │
                                    ├─ walk folder → candidate files
                                    │
                                    ├─ for each file:
                                    │     Parser.parseFile() ─► elements (VR-decoded)
                                    │       │
                                    │       ├─ deterministic: match against PHI_TAGS
                                    │       └─ collect free-text values
                                    │
                                    ├─ PiiClient.detect([...free text...]) ──► localhost:5001
                                    │       ◄── entities per text (>= minScore)
                                    │
                                    ├─ aggregate findings by tag
                                    ├─ MASK every value (format layer)
                                    │
                                    └─► Markdown report (locations only, no raw PHI)
AI ◄────────────────────────────────┘
```

Key point: raw PHI values are **decoded** internally (needed to detect them) but
are **masked** before crossing back to the AI. The mask happens in exactly one
place — `format.js` / `phi-tags.maskValue` — so the guarantee is easy to audit.

---

## PHI safety model

Three independent guarantees:

1. **Local-first execution.** Parsing and scanning happen in-process on the
   user's machine. The only outbound network call is to the *user's own* PII
   service (configurable, defaults to `localhost`).

2. **Redact-before-model.** Any tag classified as PHI is masked
   (`SMITH^JOHN` → `S********N`) before being returned. Controlled by
   `DICOM_REDACT_BY_DEFAULT` (default `true`). Raw values are only ever emitted
   if **both** `DICOM_ALLOW_RAW_PHI=true` **and** the caller explicitly opts in —
   and `find_phi` never emits raw values at all.

3. **Two-layer detection.** A deterministic known-PHI-tag table always works
   offline; the PII service adds free-text coverage. If the service is down,
   detection degrades gracefully rather than failing.

### What it deliberately does NOT do

- No image interpretation / diagnosis (would be a regulated medical device).
- No OCR of burned-in pixel text (only flags `BurnedInAnnotation`).
- No writing of modified files (de-identification is preview-only).

---

## PII service integration

The server treats PHI detection as two cooperating layers:

| Layer | Source | Always available? | Catches |
|-------|--------|-------------------|---------|
| Deterministic | `PHI_TAGS` table (PS3.15) | ✅ Yes, offline | Known identifier tags (name, MRN, dates, physicians…) |
| Heuristic | External PII service | Only if reachable | PHI hiding in **free-text** fields (descriptions, comments) |

Contract:

```
GET  {PII_SERVICE_URL}/            -> 200 (health)
POST {PII_SERVICE_URL}/detect_pii  { "texts": [...] }
   -> { "results": [ { "textindex", "piientities": [ {entitytype,start,end,value,score} ] } ] }
```

The client (`pii-client.js`) is defensive: timeouts via `AbortController`,
tolerates snake_case variants, filters by `PII_MIN_SCORE`, and never throws into
the tool layer.

---

## Transports

| Transport | Use case | How |
|-----------|----------|-----|
| **stdio** | VS Code direct integration | `--transport stdio` or `MCP_TRANSPORT=stdio` |
| **SSE/HTTP** | HTTP-based MCP clients | default; serves `/sse`, `/messages`, `/health` on `MCP_PORT` |

Both are provided by the official `@modelcontextprotocol/sdk`.

---

## Extensibility

The design makes several extensions straightforward:

- **New tools** — add a `registerXxxTools(server, ctx)` and call it in `server.js`.
- **Fuller dictionary** — extend `dictionary.js` or swap in `dcmjs`'s dictionary.
- **De-identified file writing** — add a writer (e.g. `dcmjs`) behind a new tool.
- **PACS networking** — add a DIMSE adapter (C-FIND/C-MOVE) as a new source.
- **Burned-in PHI OCR** — add a pixel decoder + OCR pass feeding `find_phi`.

---

## Design principles

1. **Ground the AI in real data** — every answer cites actual tags/values.
2. **Safety in one place** — all redaction flows through the format layer.
3. **Degrade gracefully** — missing PII service, malformed files, unknown tags
   all produce useful partial results instead of hard failures.
4. **Dependency-light & offline** — pure JS, curated dictionary, no native build.
5. **Honest scope** — do the metadata layer excellently; clearly flag what's out
   of scope (diagnosis, OCR, writing).
