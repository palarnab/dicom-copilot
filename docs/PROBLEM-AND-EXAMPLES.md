# DICOM Copilot — The Problem & Real Examples

This is the guide to read if you want to understand **what pain this solves** and
**exactly what you can ask** once you've opened a folder of DICOM files in
VS Code. Every example shows a realistic question, which tool answers it, and the
kind of grounded answer you get back.

---

## Part 1 — The problem

### DICOM is everywhere, and it's painful

Every CT, MRI, X-ray, ultrasound, and mammogram in the world is stored as DICOM.
A single `.dcm` file bundles the pixel image with **hundreds of metadata tags** —
and those tags are the source of endless friction:

- **Cryptic** — tags are hex codes like `(0018,0050)`. You need the standard (or
  years of experience) to know that's "Slice Thickness."
- **Vendor-inconsistent** — every scanner vendor populates tags slightly
  differently, and some hide data in private tags. This is the root cause of most
  "it opens in their viewer but not ours" bugs.
- **PHI-riddled** — patient names, MRNs, birth dates, physician names, and free
  text are scattered across dozens of tags. Some PHI is even **burned into the
  image pixels**. De-identifying a dataset correctly is a compliance minefield.
- **Structurally messy** — a folder export can contain thousands of files with no
  obvious grouping; reconstructing which files belong to which study/series is
  tedious.

### Who feels this pain

- **Imaging-AI teams & researchers** preparing datasets (de-identification,
  curation, "which studies will break my training pipeline?").
- **Medical-imaging software developers** building viewers/integrations
  ("why won't this file load?", "what does this vendor put here?").
- **Radiology IT / PACS admins** debugging conformance and migration issues.

### What this server does about it

It makes DICOM's cryptic complexity **conversational**, while keeping patient
data safe:

- Translates tags to plain language.
- Rebuilds the Patient → Study → Series → Instance structure from a raw folder.
- Explains *why* a study is non-conformant or won't open.
- Diffs vendor/scanner differences.
- Locates PHI (metadata **and** free text) and previews de-identification —
  **without ever showing raw PHI to the AI**.

### What it deliberately does NOT do

- **No diagnosis / image interpretation** — that would make it a regulated
  medical device. It stays in the metadata/workflow lane.
- **No OCR** of burned-in pixel text yet — it *flags* the risk but can't read it.
- **No file writing** — de-identification is preview/plan only.

---

## Part 2 — Working inside a VS Code folder of DICOM files

Imagine you've opened a folder like this in VS Code:

```
studies-export/
├── PATIENT_A/
│   ├── CT_CHEST/
│   │   ├── IM000001.dcm
│   │   ├── IM000002.dcm
│   │   └── … (320 slices)
│   └── CT_CHEST_THIN/
│       └── … (640 slices)
├── PATIENT_B/
│   └── MR_BRAIN/
│       └── … (180 images)
└── loose_files/
    ├── unknown1.dcm
    └── scannerB_export.dcm
```

With the `dicom-copilot` MCP server connected (see [SETUP.md](SETUP.md)), you can
ask questions in Copilot Chat (Agent mode) and it will call the right tools. The
examples below are representative — values are illustrative but the shape matches
what the tools return.

---

### Example 1 — "What's in this folder?"

**You ask:**
> Scan `studies-export/` and give me an overview.

**Tool used:** `scan_folder`

**Answer:**
```
## Scan complete: .../studies-export
- Files walked: 1142
- DICOM files indexed: 1140
- Non-DICOM skipped: 2
- Patients: 2
- Studies: 3

### Studies
- [CT] CT CHEST — 2 series, 960 images (StudyUID …8f21c0a4b3)
- [MR] MR BRAIN — 1 series, 180 images (StudyUID …3d90f1e2aa)
- [CT] (No description) — 1 series, 1 image (StudyUID …0000000001)
```

**Why it's useful:** In seconds you know the folder holds 2 patients, 3 studies,
and a stray single-image "study" worth investigating — without opening a viewer.

---

### Example 2 — "Show me the structure."

**You ask:**
> Show the study hierarchy.

**Tool used:** `study_hierarchy`

**Answer:**
```
## Hierarchy: .../studies-export
📁 Patient: PATIENT_A_ID
  📂 Study [CT] CT CHEST (20260114)
      🗂  Series 2 [CT] Axial 5.0mm — 320 img
      🗂  Series 3 [CT] Axial 1.0mm (thin) — 640 img
📁 Patient: PATIENT_B_ID
  📂 Study [MR] MR BRAIN (20260620)
      🗂  Series 1 [MR] T2 FLAIR — 180 img
```

**Why it's useful:** The raw folder is reorganized into the canonical DICOM
hierarchy the way a PACS would see it.

---

### Example 3 — "Why won't this file open in our viewer?"

**You ask:**
> Validate conformance on `loose_files/scannerB_export.dcm` — it fails to open.

**Tool used:** `validate_conformance`

**Answer:**
```
## Conformance report: scannerB_export.dcm

### ❌ 2 issue(s) found
- Transfer Syntax 1.2.840.10008.1.2.4.70 is JPEG Lossless (Process 14, SV1) —
  viewers without the matching codec cannot decode pixel data.
- High Bit (15) != Bits Stored - 1 (11) — a known vendor quirk that some viewers
  reject.

### Info
- Transfer Syntax: JPEG Lossless (Process 14, SV1)
```

**Why it's useful:** It turns a multi-hour support ticket into a precise root
cause — a codec the viewer lacks, plus a non-standard High Bit — with the exact
tags to fix.

---

### Example 4 — "Why do two scanners look different?"

**You ask:**
> Diff `PATIENT_A/CT_CHEST/IM000001.dcm` against
> `loose_files/scannerB_export.dcm`.

**Tool used:** `diff_metadata`

**Answer:**
```
## Metadata diff
- A: IM000001.dcm
- B: scannerB_export.dcm

Changed: 4 | Only in A: 1 | Only in B: 2

### Changed values
| Tag         | Name                | A                | B                |
|-------------|---------------------|------------------|------------------|
| (0008,0070) | Manufacturer        | SIEMENS          | Philips          |
| (0018,0050) | Slice Thickness     | 5.0              | 1.0              |
| (0002,0010) | Transfer Syntax UID | …1.2.1 (Expl LE) | …4.70 (JPEG LL)  |
| (0028,0102) | High Bit            | 11               | 15               |

### Only in B
- (2001,100b) Unknown  ← Philips private tag (slice spacing lives here)
```

**Why it's useful:** It pinpoints that the difference is manufacturer, slice
thickness, compression, and a **private tag** where Philips stores data the
standard tag would normally hold — the exact thing that breaks naive pipelines.

---

### Example 5 — "Translate this cryptic file for me."

**You ask:**
> Explain the tags in `PATIENT_B/MR_BRAIN/IM000001.dcm`, focus on acquisition.

**Tool used:** `explain_tags` (with `filter`)

**Answer (excerpt):**
```
## IM000001.dcm
Transfer Syntax: Explicit VR Little Endian (1.2.840.10008.1.2.1)

| Tag         | Name                | VR | Value        |
|-------------|---------------------|----|--------------|
| (0018,0080) | Repetition Time (TR)| DS | 9000         |
| (0018,0081) | Echo Time (TE)      | DS | 120          |
| (0018,0050) | Slice Thickness     | DS | 5.0          |
| (0018,0087) | Magnetic Field …    | DS | 3.0          |
| (0010,0010) 🔒 | Patient Name     | PN | S********N (masked) |
```

**Why it's useful:** Cryptic codes become readable, and PHI (Patient Name) is
automatically **masked** — the AI helps you understand the scan without ever
seeing the patient's identity.

---

### Example 6 — "Find every trace of PHI before I share this dataset." ⭐

**You ask:**
> Find all PHI in `studies-export/` and tell me what needs de-identifying.

**Tool used:** `find_phi` (deterministic tags + your PII service on free text)

**Answer:**
```
## PHI scan
- Files scanned: 50 (folder cap)
- PII service: ok
- Distinct PHI-bearing tags: 9

| Tag         | Name                | Detected by  | Entity types   | Action  | Files | Example (masked) |
|-------------|---------------------|--------------|----------------|---------|-------|------------------|
| (0010,0010) | Patient Name        | known-tag    | —              | replace | 50    | S********N       |
| (0010,0020) | Patient ID          | known-tag    | —              | replace | 50    | M*******6        |
| (0010,0030) | Patient Birth Date  | known-tag    | —              | replace | 50    | 1******1         |
| (0008,0090) | Referring Physician | known-tag    | —              | remove  | 47    | R******S         |
| (0008,1030) | Study Description   | pii-service  | PERSON         | clean   | 12    | C**************h |
| (0008,0080) | Institution Name    | known-tag    | —              | remove  | 50    | M********l       |

### ⚠ Burned-in pixel PHI
- 12 file(s) have BurnedInAnnotation = YES. Text baked into the image pixels is
  NOT removable by metadata de-identification.
- Note: this tool does NOT perform OCR on pixel data. Burned-in text in files NOT
  flagged by the tag can still exist and must be checked separately.
```

**Why it's the killer feature:** It catches the obvious identifiers **and** PHI
hiding in a free-text Study Description (a patient's name typed into "CT CHEST for
John Smith", flagged by your PII service as a `PERSON`). It also warns that 12
images have **burned-in** annotations that metadata scrubbing won't fix — the #1
way "de-identified" datasets leak PHI. Crucially, **no raw PHI is shown** — only
where it is and how to handle it.

---

### Example 7 — "What would de-identification actually do to this file?"

**You ask:**
> Show me a de-identification plan for `PATIENT_A/CT_CHEST/IM000001.dcm`.

**Tool used:** `deidentify_preview`

**Answer:**
```
## De-identification preview: IM000001.dcm

> Preview only — no files are modified.

| Tag         | Name                | Action                     | Detected by | Current (masked) |
|-------------|---------------------|----------------------------|-------------|------------------|
| (0010,0010) | Patient Name        | Replace with dummy         | known-tag   | S********N       |
| (0010,0020) | Patient ID          | Replace with dummy         | known-tag   | M*******6        |
| (0010,0030) | Patient Birth Date  | Replace with dummy         | known-tag   | 1******1         |
| (0008,0090) | Referring Physician | Remove (delete value)      | known-tag   | R******S         |
| (0020,000D) | Study Instance UID  | Remap UID consistently     | known-tag   | 1**************4 |
| (0008,1030) | Study Description   | Clean free text (inspect)  | pii-service | C**************h |
```

**Why it's useful:** A concrete, per-tag plan aligned to DICOM PS3.15 — remove,
replace, clean, or UID-remap — so you know exactly how a scrubber should treat
each field before you run one.

---

### Example 8 — "Which studies will break my AI pipeline?"

**You ask:**
> I'm about to train on these. Describe the CT CHEST study and flag anything risky.

**Tool used:** `describe_study`

**Answer:**
```
## Study Summary
- Study UID: …8f21c0a4b3
- Description: CT CHEST
- Date: 20260114
- Modalities: CT
- Series: 2 | Images: 960
- Transfer syntaxes: 1.2.840.10008.1.2.1, 1.2.840.10008.1.2.4.70
  ⚠ Multiple transfer syntaxes in one study — a common cause of viewer/pipeline issues.
- ⚠ Burned-in annotation flagged on 4 image(s) — pixel-level PHI risk.

### Series
- #2 [CT] Axial 5.0mm — 320 img
- #3 [CT] Axial 1.0mm (thin) — 640 img ⚠ mixed transfer syntax
```

**Why it's useful:** Before wasting GPU hours, you learn the study mixes an
uncompressed and a JPEG-Lossless transfer syntax (which can break naive loaders)
and has burned-in annotations to exclude or redact.

---

### Example 9 — "Quick lookups."

**You ask:**
> What's the slice thickness and KVP in `IM000001.dcm`?

**Tool used:** `get_tag` (twice)

**Answer:**
```
(0018,0050) Slice Thickness [DS]
Value: 5.0

(0018,0060) KVP [DS]
Value: 120
```

**You ask:**
> Is the PII service running?

**Tool used:** `pii_service_status`

**Answer:**
```
✅ PII service reachable at http://localhost:5001 (HTTP 200)
```

---

## Part 3 — Question patterns you can reuse

| Intent | Ask something like… | Tool |
|--------|---------------------|------|
| Understand a folder | "Scan this folder and summarize it" | `scan_folder` |
| See structure | "Show the study hierarchy" | `study_hierarchy` |
| Summarize a study | "Describe the MR brain study and flag risks" | `describe_study` |
| Decode a file | "Explain the tags in this file" | `explain_tags` |
| One value | "What's the TR / TE / slice thickness here?" | `get_tag` |
| Debug loading | "Why won't this file open? Validate it" | `validate_conformance` |
| Compare | "Diff these two files — what did the scanner change?" | `diff_metadata` |
| Privacy audit | "Find all PHI and what needs scrubbing" | `find_phi` |
| De-id planning | "Show a de-identification plan for this file" | `deidentify_preview` |
| Service check | "Is the PII service up?" | `pii_service_status` |

---

## Part 4 — What makes the answers trustworthy

- **Grounded in real bytes** — every answer cites actual tags `(gggg,eeee)` and
  decoded values from your files, not guesses.
- **Encoded expertise** — it knows Type-1 requirements, transfer syntaxes,
  vendor/private-tag quirks, and PS3.15 PHI rules.
- **Catches what people miss** — mixed transfer syntaxes, private-tag data,
  free-text PHI, burned-in annotations.
- **Honest about uncertainty** — it flags "ambiguous"/"not checked" cases (e.g.
  burned-in text needs OCR it doesn't do) instead of pretending.
- **Safe by construction** — raw PHI is masked before the AI ever sees it.

The unifying idea: the answers to these questions **already exist in the data**,
but they're locked behind expertise and tedium. This server unlocks them — safely
and conversationally — right where you work in VS Code.
