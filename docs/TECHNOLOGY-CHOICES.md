# DICOM Copilot — Technology Choices

This document explains **what** each technology is, **why** it was chosen, the
**trade-offs**, and the **alternatives** — so a future maintainer understands the
reasoning, not just the result.

---

## Summary

| Concern | Choice | One-line reason |
|---------|--------|-----------------|
| Runtime | **Node.js 18+ (ES modules)** | No build step, global `fetch`, matches sibling Database Copilot |
| MCP layer | **`@modelcontextprotocol/sdk`** | Official SDK; stdio + SSE transports out of the box |
| DICOM parsing | **`dicom-parser`** | Battle-tested (Cornerstone), pure-JS, robust low-level reader |
| Tag dictionary | **Curated in-repo table** | Fully offline, dependency-light, covers the tags that matter |
| Input validation | **`zod`** | The schema format MCP tools expect |
| HTTP (SSE) | **`express`** | Minimal, ubiquitous, same as sibling project |
| Config | **`dotenv`** | Simple `.env` parsing |
| PHI free-text | **External local PII service** | Keeps ML detection out-of-process and swappable |

---

## Node.js + ES modules

**Why:** The sibling Database Copilot is Node/ESM, so this stays consistent and
shareable. Node 18+ gives us a global `fetch` (used by the PII client) with no
extra dependency. Pure JavaScript means **no compile step** and instant
`npm install`.

**Trade-off:** No compile-time type checking. Mitigated by JSDoc-style comments,
small focused modules, and a smoke test that exercises the whole pipeline.

**Alternatives considered:** TypeScript (more safety, but adds a build step and
diverges from the sibling project); Python (excellent DICOM libs via `pydicom`,
but the existing MCP tooling here is Node).

---

## `@modelcontextprotocol/sdk`

**What:** The official MCP implementation. Provides `McpServer`, tool/resource
registration, and both `StdioServerTransport` and `SSEServerTransport`.

**Why:** It's the canonical way to speak MCP to VS Code / Copilot / Claude. Using
it guarantees protocol compatibility and gives us stdio (for VS Code) and SSE
(for HTTP clients) for free.

**Version:** `^1.12.0`, matching the Database Copilot to reduce surprises.

---

## `dicom-parser` (the key decision)

**What:** The DICOM Part-10 parser from the **Cornerstone.js** ecosystem — the
same engine behind a large share of web-based DICOM viewers.

**Why it's the right fit for this project:**

- **Battle-tested & widely deployed** — mature, real-world hardened.
- **Pure JavaScript, zero native dependencies** — no node-gyp, no compilation,
  works anywhere Node runs. Clean, fast `npm install` (0 vulnerabilities).
- **Robust low-level parsing** — preamble detection, explicit/implicit VR,
  little/big endian, nested sequences. Exposes element offsets without eagerly
  decoding everything (good for scanning large archives).
- **Error-tolerant** — attaches a partial dataset on recoverable errors, which
  we use to salvage slightly malformed files.

**What it does NOT provide (and how we handled each):**

| Gap | Consequence | Our mitigation |
|-----|-------------|----------------|
| No data dictionary | Raw tags, no names | Curated `dictionary.js` |
| No VR-aware value decoding | Raw bytes/strings | VR reader in `parser.js` (US/UL/SS/SL/FL/FD/strings/binary) |
| Parse-only (no writing) | Can't emit de-identified files | De-id is preview-only (roadmap: add a writer) |
| No pixel decoding | No OCR / image ops | Out of scope; we only flag `BurnedInAnnotation` |
| No DICOM networking | No PACS queries | File/folder only (roadmap: DIMSE adapter) |

**Alternatives considered:**

- **`dcmjs`** — fuller: read **and** write, plus a complete standard dictionary.
  The natural upgrade *when* we need to write de-identified files. We didn't
  start here because it's heavier and we only needed robust reading; the curated
  dictionary keeps us offline and lean.
- **`daikon`** — capable, but less widely used than the Cornerstone stack.
- **DCMTK / dcm4che bindings** — the gold-standard native toolkits, but they
  bring native build/runtime dependencies that conflict with our "pure-JS,
  instant install" goal.

**Verdict:** `dicom-parser` is the correct choice for the current
read/inspect/validate/PHI-detect scope. The upgrade path (add `dcmjs` for
writing/pixel/PACS work) is clear and additive, not a rewrite.

---

## Curated tag dictionary vs. a bundled full dictionary

**Choice:** Ship a **curated** dictionary (`dictionary.js`) of the ~120 tags that
matter for metadata exploration, conformance, and PHI — rather than pulling a
full ~4000-entry dictionary.

**Why:**

- Keeps the server **fully offline** and **dependency-light**.
- Covers every tag the tools actually reason about, including all PHI-bearing
  ones.
- Unknown tags still surface (with raw tag + VR) — an honest, useful fallback.

**Trade-off:** Rare/private tags show without a friendly name. If comprehensive
naming becomes important, swap in `dcmjs`'s dictionary — a localized change.

---

## `zod`

**What:** Schema declaration/validation library. **Why:** MCP tool input schemas
are expressed with `zod`; it gives clear parameter descriptions the AI reads to
call tools correctly.

---

## `express`

**What:** Minimal HTTP framework. **Why:** Powers the SSE transport endpoints
(`/sse`, `/messages`, `/health`). Same choice as the sibling project. Only used
when running in `sse` mode; the default `stdio` path doesn't need it.

---

## `dotenv`

**What:** Loads `.env` into `process.env`. **Why:** Simple, standard config for
transport, DICOM roots, safety flags, and the PII service URL/timeouts.

---

## External PII service (architectural choice, not a library)

**Choice:** Detect free-text PHI by calling an **external, local** PII service
over HTTP rather than embedding an NLP/ML model in-process.

**Why:**

- **Separation of concerns** — the heavy ML model lives in a service you own and
  can scale/update independently.
- **Swappable** — point `PII_SERVICE_URL` at any implementation honoring the
  contract.
- **Compliance-friendly** — defaults to `localhost`; no patient text leaves your
  environment.
- **Graceful degradation** — if it's down, deterministic tag detection still
  works.

**Trade-off:** Requires you to run that service. Mitigated by making it optional
and clearly reporting its status (`pii_service_status`, startup log).

---

## Cross-cutting principles behind these choices

1. **Pure-JS, no native build** — instant, portable install.
2. **Offline by default** — only outbound call is to your own PII service.
3. **Lean but honest** — curated dictionary + clear "not yet" list, rather than
   heavy deps for features we don't use yet.
4. **Additive upgrade paths** — `dcmjs` (writing), DIMSE (PACS), OCR (burned-in)
   all bolt on without a rewrite.
