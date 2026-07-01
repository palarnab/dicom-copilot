/**
 * In-memory dataset index. Caches folder scans so that hierarchy / study
 * queries don't have to re-walk the disk every call. Analogous to the Database
 * Copilot's ConnectionManager, but for scanned DICOM roots.
 */

import path from 'node:path';
import { scanFolder } from './scanner.js';

export class DatasetIndex {
  constructor() {
    /** @type {Map<string, object>} rootAbs -> scan result */
    this.scans = new Map();
    this.lastRoot = null;
  }

  scan(rootPath, opts) {
    const result = scanFolder(rootPath, opts);
    this.scans.set(result.root, result);
    this.lastRoot = result.root;
    return result;
  }

  getScan(rootPath) {
    if (!rootPath) {
      return this.lastRoot ? this.scans.get(this.lastRoot) : null;
    }
    return this.scans.get(path.resolve(rootPath)) || null;
  }

  listRoots() {
    return [...this.scans.keys()];
  }

  /** Find a study across all cached scans by (full or partial) Study UID. */
  findStudy(studyUid) {
    for (const scan of this.scans.values()) {
      if (scan.studies.has(studyUid)) {
        return { study: scan.studies.get(studyUid), root: scan.root };
      }
    }
    // partial match fallback
    for (const scan of this.scans.values()) {
      for (const [uid, study] of scan.studies) {
        if (uid.includes(studyUid)) return { study, root: scan.root };
      }
    }
    return null;
  }

  /** Collect every indexed file path across all scans. */
  allFiles() {
    const files = [];
    for (const scan of this.scans.values()) {
      for (const study of scan.studies.values()) {
        for (const series of study.series.values()) {
          for (const inst of series.instances) files.push(inst.file);
        }
      }
    }
    return files;
  }
}
