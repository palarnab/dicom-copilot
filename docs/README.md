# DICOM Copilot — Documentation

Welcome to the documentation for **MCP DICOM Copilot**, a local-first, PHI-safe
Model Context Protocol server that lets AI assistants reason about folders of
DICOM medical-imaging files.

## Table of contents

| Document | What's inside |
|----------|---------------|
| [PROBLEM-AND-EXAMPLES.md](PROBLEM-AND-EXAMPLES.md) | **Start here.** The problem it solves and a rich catalog of real questions you can ask inside a VS Code folder of DICOM files — with example answers |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design, components, data flow, and the PHI-safety model |
| [TECHNOLOGY-CHOICES.md](TECHNOLOGY-CHOICES.md) | Why each library/approach was chosen, trade-offs, and alternatives |
| [SETUP.md](SETUP.md) | Install, configure, connect the PII service, and wire it into VS Code |
| [USAGE.md](USAGE.md) | Every tool, its inputs/outputs, and copy-paste prompt recipes |

## 30-second overview

DICOM is the ubiquitous — but cryptic — standard for medical images. Each file
mixes pixel data with hundreds of hex-coded metadata tags, and Protected Health
Information (PHI) hides across dozens of them. This server:

- **Translates** cryptic tags into plain language
- **Maps** a messy folder into a clean Patient → Study → Series → Instance tree
- **Validates** why a study might fail to open
- **Diffs** vendor/scanner differences
- **Finds PHI** using a built-in tag table plus your local PII service — while
  **masking values so raw PHI never reaches the AI model**

It stays firmly in the metadata / conformance / de-identification lane and never
interprets images (which would make it a regulated medical device).

## Golden rules

1. **Local-first** — files never leave your machine.
2. **Redact-before-model** — PHI values are masked before the AI sees them.
3. **No diagnosis** — metadata and workflow only.
