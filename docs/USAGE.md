# DICOM Copilot — Usage & Tool Reference

Every tool the server exposes, what it takes, what it returns, and copy-paste
prompt recipes for VS Code Copilot Chat.

> All tools are **read-only**. PHI values are **masked** unless explicitly and
> permissibly overridden. `find_phi` never returns raw PHI.

---

## Typical workflow

```
1. scan_folder(path)          → index a folder into a study tree
2. study_hierarchy()          → see Patient → Study → Series → Instance
3. describe_study(studyUid)   → summarize one study
4. explain_tags(file)         → understand a specific file
5. validate_conformance(file) → why won't it open?
6. diff_metadata(a, b)        → why do two files differ?
7. find_phi(path)             → where is PHI?
8. deidentify_preview(file)   → what would de-id do?
```

---

## Explore tools

### `scan_folder`

Recursively scan a folder and index every DICOM file into a
Patient → Study → Series → Instance hierarchy. Runs locally.

| Param | Type | Notes |
|-------|------|-------|
| `path` | string | Absolute or relative folder path |

**Returns:** counts (files walked, DICOM indexed, skipped, patients, studies),
a study list, and any parse errors.

**Prompt:** *"Scan `c:/studies/export` and summarize what's there."*

---

### `study_hierarchy`

Show the full tree for a previously scanned folder (or the most recent scan).

| Param | Type | Notes |
|-------|------|-------|
| `path` | string (optional) | Defaults to the most recent scan |

**Prompt:** *"Show me the study hierarchy."*

---

### `describe_study`

Human-readable summary of one study: modalities, series breakdown, image counts,
transfer syntaxes, mixed-transfer-syntax warnings, and burned-in-annotation
flags. PHI masked.

| Param | Type | Notes |
|-------|------|-------|
| `studyUid` | string | Full Study Instance UID or trailing portion |

**Prompt:** *"Describe the study ending in `…8f21c`."*

---

### `explain_tags`

Parse one file and translate its tags to a table of tag / name / VR / value.
PHI values masked. Sequences summarized by item count.

| Param | Type | Notes |
|-------|------|-------|
| `file` | string | Path to a `.dcm` file |
| `filter` | string (optional) | Case-insensitive substring on tag name/keyword |
| `allowRaw` | boolean (optional) | Request raw PHI (honored only if server allows) |

**Prompt:** *"Explain the tags in `series1/img001.dcm`, filter to 'contrast'."*

---

### `get_tag`

Look up one tag by number (`(0010,0010)` / `00100010`) or keyword
(`PatientName`). PHI masked.

| Param | Type | Notes |
|-------|------|-------|
| `file` | string | Path to a `.dcm` file |
| `tag` | string | Tag number or keyword |
| `allowRaw` | boolean (optional) | Request raw PHI (honored only if server allows) |

**Prompt:** *"What's the SliceThickness in `img001.dcm`?"*

---

## Validate tools

### `validate_conformance`

Check a file for common problems: missing Type-1/Type-2 attributes, unknown or
absent transfer syntax, and inconsistent pixel-encoding tags
(`BitsAllocated` / `BitsStored` / `HighBit`, Rows/Columns, Photometric
Interpretation). Explains **why** a study might fail to load.

| Param | Type | Notes |
|-------|------|-------|
| `file` | string | Path to a `.dcm` file |

**Prompt:** *"Why won't `broken.dcm` open? Validate its conformance."*

---

### `diff_metadata`

Compare two files' tags and report added / removed / changed. Ideal for vendor
or scanner differences and integration bugs. PHI masked.

| Param | Type | Notes |
|-------|------|-------|
| `fileA` | string | First `.dcm` file |
| `fileB` | string | Second `.dcm` file |
| `allowRaw` | boolean (optional) | Request raw PHI (honored only if server allows) |

**Prompt:** *"Diff `scannerA.dcm` and `scannerB.dcm` — what changed?"*

---

## PHI tools

### `find_phi`

Scan a file or an entire folder for PHI. Combines the built-in known-PHI-tag
table with the external PII service for free-text fields. Reports **where** PHI
is — values are always masked. Warns about `BurnedInAnnotation`.

| Param | Type | Notes |
|-------|------|-------|
| `path` | string | A `.dcm` file or a folder |
| `maxFiles` | number (optional) | Cap when scanning a folder (default 50) |

**Returns:** a table grouped by tag (name, detected-by, entity types, de-id
action, file count, masked example) plus a burned-in-pixel-PHI caveat.

**Prompt:** *"Find all PHI in this folder and list which fields need scrubbing."*

---

### `deidentify_preview`

Preview a per-tag de-identification plan (remove / replace / clean / uid-remap
per DICOM PS3.15). **Does not modify files.** PHI masked.

| Param | Type | Notes |
|-------|------|-------|
| `file` | string | Path to a `.dcm` file |

**Prompt:** *"Show me a de-identification plan for `img001.dcm`."*

---

### `pii_service_status`

Check whether the external PII service is reachable.

**Prompt:** *"Is the PII service up?"*

---

## De-identification actions (reference)

| Action | Meaning | Example tags |
|--------|---------|--------------|
| `remove` | Delete the value entirely | Institution Address, Other Patient IDs |
| `replace` | Replace with a non-identifying dummy | Patient Name, Patient ID, Study Date |
| `clean` | Free text — inspect/scrub for embedded PHI | Study Description, Image Comments |
| `uid` | Remap UID consistently across the dataset | Study/Series/SOP Instance UID |

---

## Safety flags recap

| Flag | Default | Effect |
|------|---------|--------|
| `DICOM_REDACT_BY_DEFAULT` | `true` | Mask PHI values before returning to the AI |
| `DICOM_ALLOW_RAW_PHI` | `false` | Allow raw PHI only when a tool's `allowRaw` is set |

Even with both permissive, `find_phi` still masks — its purpose is to locate PHI,
never to surface it.
