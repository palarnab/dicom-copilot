# DICOM Copilot — Questions & Answers Guide

A practical, example-driven catalog of what you can ask **DICOM Copilot** in
VS Code Copilot Chat (Agent mode), which tool answers each question, and the
kind of grounded, PHI-safe response you get back.

> **Read-only & PHI-safe.** Every tool only reads your files. PHI values are
> masked before the AI ever sees them, and `find_phi` never returns raw PHI.

---

## How to use this guide

1. Connect the `dicom-copilot` MCP server (see [SETUP.md](SETUP.md)).
2. Open a folder of `.dcm` files in VS Code.
3. Ask questions in **Copilot Chat → Agent mode** in plain English.
4. Copilot automatically picks the right tool and calls it on your local files.

The answers below are representative — the *shape* matches what the tools return;
values are illustrative.

---

## Feature map at a glance

| Feature | What it does | Tool | Ask it like… |
|---------|--------------|------|--------------|
| Index a folder | Build Patient→Study→Series→Instance tree | `scan_folder` | "Scan this folder" |
| See structure | Show the full tree | `study_hierarchy` | "Show the hierarchy" |
| Summarize a study | Modalities, counts, risks | `describe_study` | "Describe this study" |
| Decode a file | Translate cryptic tags | `explain_tags` | "Explain this file's tags" |
| One value | Look up a single tag | `get_tag` | "What's the KVP?" |
| Debug loading | Find conformance problems | `validate_conformance` | "Why won't this open?" |
| Compare files | Diff two files' tags | `diff_metadata` | "Diff these two files" |
| Privacy audit | Locate all PHI | `find_phi` | "Find all PHI here" |
| De-id planning | Per-tag scrub plan | `deidentify_preview` | "Show a de-id plan" |
| Service check | Is the PII service up? | `pii_service_status` | "Is the PII service up?" |

---

## Part 1 — Exploring & understanding

### Q1. "What's in this folder?"

**Tool:** `scan_folder` — recursively walks the folder locally and indexes every
DICOM file.

**Ask:** *"Scan `c:/studies/export` and give me an overview."*

**Answer:**
```
## Scan complete: c:/studies/export
- Files walked: 1142
- DICOM files indexed: 1140
- Non-DICOM skipped: 2
- Patients: 2
- Studies: 3

### Studies
- [CT] CT CHEST — 2 series, 960 images (StudyUID …8f21c0a4b3)
- [MR] MR BRAIN — 1 series, 180 images (StudyUID …3d90f1e2aa)
- [CT] No description — 1 series, 1 image (StudyUID …0000000001)
```

**Why it helps:** In seconds you know how many patients, studies, and stray
files there are — no viewer needed. (Scanning is capped by `DICOM_MAX_FILES`,
default 20000.)

---

### Q2. "Show me the structure / hierarchy."

**Tool:** `study_hierarchy` — renders the tree from the most recent scan (or a
given root).

**Ask:** *"Show the study hierarchy."*

**Answer:**
```
## Hierarchy: c:/studies/export
📁 Patient: PATIENT_A_ID
  📂 Study [CT] CT CHEST (20260114)
      🗂  Series 2 [CT] Axial 5.0mm — 320 img
      🗂  Series 3 [CT] Axial 1.0mm thin — 640 img
📁 Patient: PATIENT_B_ID
  📂 Study [MR] MR BRAIN (20260620)
      🗂  Series 1 [MR] T2 FLAIR — 180 img
```

**Why it helps:** A raw, messy folder export is reorganized into the canonical
DICOM hierarchy the way a PACS sees it.

> **Tip:** If you get *"No scan available. Run scan_folder first."*, ask Copilot
> to scan the folder before requesting the hierarchy.

---

### Q3. "Summarize this study and flag anything risky."

**Tool:** `describe_study` — accepts a full Study Instance UID **or just the
trailing portion**.

**Ask:** *"Describe the study ending in `…8f21c0a4b3` and flag risks."*

**Answer:**
```
## Study Summary
- Study UID: …a1b2c3d48f21c0a4b3
- Description: CT CHEST
- Date: 20260114
- Modalities: CT
- Series: 2 | Images: 960
- Transfer syntaxes: 1.2.840.10008.1.2.1, 1.2.840.10008.1.2.4.70
  ⚠ Multiple transfer syntaxes in one study — a common cause of viewer/pipeline issues.
- ⚠ Burned-in annotation flagged on 4 image(s) — pixel-level PHI risk.

### Series
- #2 [CT] Axial 5.0mm — 320 img
- #3 [CT] Axial 1.0mm thin — 640 img ⚠ mixed transfer syntax
```

**Why it helps:** Before wasting GPU hours or debugging a viewer, you learn the
study mixes uncompressed + JPEG-Lossless data and has burned-in annotations.

---

### Q4. "Translate this cryptic file for me."

**Tool:** `explain_tags` — parses one file into a tag / name / VR / value table.
Supports a `filter` substring; PHI values are masked and marked with 🔒.

**Ask:** *"Explain the tags in `MR_BRAIN/IM000001.dcm`, filter to acquisition."*

**Answer (excerpt):**
```
## IM000001.dcm
Transfer Syntax: Explicit VR Little Endian (1.2.840.10008.1.2.1)

| Tag         | Name                 | VR | Value               |
|-------------|----------------------|----|---------------------|
| (0018,0080) | Repetition Time (TR) | DS | 9000                |
| (0018,0081) | Echo Time (TE)       | DS | 120                 |
| (0018,0050) | Slice Thickness      | DS | 5.0                 |
| (0010,0010) 🔒 | Patient Name       | PN | S********N (masked) |
```

**Why it helps:** Hex codes become readable names, sequences are summarized by
item count, and PHI is masked automatically.

---

### Q5. "Just give me one value."

**Tool:** `get_tag` — accepts `(0010,0010)`, `00100010`, or a keyword like
`PatientName`.

**Ask:** *"What's the slice thickness and KVP in `IM000001.dcm`?"*

**Answer:**
```
(0018,0050) Slice Thickness [DS]
Value: 5.0

(0018,0060) KVP [DS]
Value: 120
```

If the tag isn't present:
```
Tag (0018,9345) CTDIvol is not present in this file.
```

---

## Part 2 — Validating & comparing

### Q6. "Why won't this file open in our viewer?"

**Tool:** `validate_conformance` — checks Type-1/Type-2 attributes, transfer
syntax, and pixel-encoding consistency (`BitsAllocated`/`BitsStored`/`HighBit`,
Rows/Columns, Photometric Interpretation).

**Ask:** *"Validate conformance on `scannerB_export.dcm` — it fails to open."*

**Answer:**
```
## Conformance report: scannerB_export.dcm

### ❌ 2 issue(s) found
- Transfer Syntax 1.2.840.10008.1.2.4.70 is JPEG Lossless (Process 14, SV1) —
  viewers without the matching codec cannot decode pixel data.
- High Bit (15) != Bits Stored - 1 (11) — a known vendor quirk some viewers reject.

### Info
- Transfer Syntax: JPEG Lossless (Process 14, SV1)
```

**Why it helps:** Turns a multi-hour support ticket into a precise root cause
with the exact tags to fix.

---

### Q7. "Why do two scanners produce different files?"

**Tool:** `diff_metadata` — compares two files and reports added / removed /
changed tags. PHI masked.

**Ask:** *"Diff `siemens/IM000001.dcm` against `philips/export.dcm`."*

**Answer:**
```
## Metadata diff
- A: IM000001.dcm
- B: export.dcm

Changed: 4 | Only in A: 1 | Only in B: 2

### Changed values
| Tag         | Name                | A                | B                |
|-------------|---------------------|------------------|------------------|
| (0008,0070) | Manufacturer        | SIEMENS          | Philips          |
| (0018,0050) | Slice Thickness     | 5.0              | 1.0              |
| (0002,0010) | Transfer Syntax UID | …1.2.1 (Expl LE) | …4.70 (JPEG LL)  |
| (0028,0102) | High Bit            | 11               | 15               |

### Only in B
- (2001,100b) Unknown  ← Philips private tag
```

**Why it helps:** Pinpoints manufacturer, compression, and **private-tag**
differences that break naive pipelines.

---

## Part 3 — PHI & de-identification (the safety core)

### Q8. "Find every trace of PHI before I share this dataset." ⭐

**Tool:** `find_phi` — combines a built-in known-PHI-tag table with your local
PII service for free-text fields. Works on a single file or a whole folder
(capped by `maxFiles`, default 50). **Values are always masked.**

**Ask:** *"Find all PHI in `studies-export/` and tell me what needs scrubbing."*

**Answer:**
```
## PHI scan
- Files scanned: 50 (folder cap)
- PII service: ok
- Distinct PHI-bearing tags: 9

| Tag         | Name                | Detected by | Entity types | Action  | Files | Example (masked) |
|-------------|---------------------|-------------|--------------|---------|-------|------------------|
| (0010,0010) | Patient Name        | known-tag   | —            | replace | 50    | S********N       |
| (0010,0020) | Patient ID          | known-tag   | —            | replace | 50    | M*******6        |
| (0010,0030) | Patient Birth Date  | known-tag   | —            | replace | 50    | 1******1         |
| (0008,0090) | Referring Physician | known-tag   | —            | remove  | 47    | R******S         |
| (0008,1030) | Study Description   | pii-service | PERSON       | clean   | 12    | C**************h |
| (0008,0080) | Institution Name    | known-tag   | —            | remove  | 50    | M********l       |

### ⚠ Burned-in pixel PHI
- 12 file(s) have BurnedInAnnotation = YES. Text baked into image pixels is NOT
  removable by metadata de-identification.
- This tool does NOT perform OCR; burned-in text in files not flagged by the tag
  can still exist and must be checked separately.
```

**Why it's the killer feature:** It catches obvious identifiers **and** PHI
hiding in free text (e.g. a patient name typed into a Study Description, flagged
by the PII service as `PERSON`), and warns about burned-in annotations — the #1
way "de-identified" datasets leak PHI. No raw PHI is ever shown.

---

### Q9. "What would de-identification actually change?"

**Tool:** `deidentify_preview` — produces a per-tag plan aligned to DICOM PS3.15.
**Preview only — never modifies files.**

**Ask:** *"Show a de-identification plan for `CT_CHEST/IM000001.dcm`."*

**Answer:**
```
## De-identification preview: IM000001.dcm

> Preview only — no files are modified.

| Tag         | Name                | Action                    | Detected by | Current (masked) |
|-------------|---------------------|---------------------------|-------------|------------------|
| (0010,0010) | Patient Name        | Replace with dummy        | known-tag   | S********N       |
| (0010,0020) | Patient ID          | Replace with dummy        | known-tag   | M*******6        |
| (0010,0030) | Patient Birth Date  | Replace with dummy        | known-tag   | 1******1         |
| (0008,0090) | Referring Physician | Remove (delete value)     | known-tag   | R******S         |
| (0020,000D) | Study Instance UID  | Remap UID consistently    | known-tag   | 1**************4 |
| (0008,1030) | Study Description   | Clean free text (inspect) | pii-service | C**************h |
```

**De-identification actions:**

| Action | Meaning | Example tags |
|--------|---------|--------------|
| `remove` | Delete the value entirely | Institution Address, Other Patient IDs |
| `replace` | Swap in a non-identifying dummy | Patient Name, Patient ID, Study Date |
| `clean` | Free text — inspect/scrub embedded PHI | Study Description, Image Comments |
| `uid` | Remap UID consistently across the dataset | Study/Series/SOP Instance UID |

---

### Q10. "Is the PII service running?"

**Tool:** `pii_service_status` — pings the external PII service.

**Ask:** *"Is the PII service up?"*

**Answer (up):**
```
✅ PII service reachable at http://localhost:5001 (HTTP 200)
```

**Answer (down):**
```
⚠ PII service NOT reachable at http://localhost:5001 — deterministic
(known-tag) PHI detection still works; free-text scanning is unavailable.
```

**Why it helps:** Deterministic tag-based PHI detection always works; the PII
service only adds free-text detection, so you know exactly which capability is
degraded.

---

## Part 4 — Reusable question patterns

Copy, tweak, and reuse these prompts:

- "Scan `<folder>` and summarize what's there."
- "Show me the study hierarchy."
- "Describe the study ending in `…<uid>` and flag anything that could break a training pipeline."
- "Explain the tags in `<file>`, filter to `contrast`."
- "What's the `<TR / TE / SliceThickness / KVP>` in `<file>`?"
- "Why won't `<file>` open? Validate its conformance."
- "Diff `<fileA>` and `<fileB>` — what did the scanner change?"
- "Find all PHI in `<folder>` and list which fields need scrubbing."
- "Show a de-identification plan for `<file>`."
- "Is the PII service up?"

---

## Part 5 — What DICOM Copilot deliberately does NOT do

- **No diagnosis / image interpretation** — that would make it a regulated
  medical device. It stays in the metadata / conformance / de-id lane.
- **No OCR** of burned-in pixel text — it *flags* the risk but cannot read it.
- **No file writing** — de-identification is preview/plan only.

---

## Part 6 — Safety flags (reference)

| Flag | Default | Effect |
|------|---------|--------|
| `DICOM_REDACT_BY_DEFAULT` | `true` | Mask PHI values before returning to the AI |
| `DICOM_ALLOW_RAW_PHI` | `false` | Allow raw PHI only when a tool's `allowRaw` is set |
| `DICOM_MAX_FILES` | `20000` | Max files indexed per scan |
| `PII_SERVICE_URL` | `http://localhost:5001` | External PII service endpoint |

Even with both PHI flags permissive, `find_phi` **still masks** — its job is to
locate PHI, never to surface it.
