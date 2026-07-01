/**
 * Client for the external local PII detection service.
 *
 * Contract (as provided):
 *   GET  {baseUrl}/            -> 200 when healthy
 *   POST {baseUrl}/detect_pii  body: { "texts": ["...", "..."] }
 *   response: {
 *     "results": [
 *       { "textindex": 0, "originaltext": "...",
 *         "piientities": [ { "entitytype": "PERSON", "start": 8, "end": 18,
 *                            "value": "John Smith", "score": 0.92 } ] }
 *     ]
 *   }
 *
 * The client is defensive: if the service is down or slow, detection degrades
 * gracefully (the caller falls back to the deterministic known-PHI-tag layer).
 * It also tolerates both "piientities"/"entitytype" and snake_case variants.
 */

export class PiiClient {
  constructor({ baseUrl, minScore = 0.5, timeoutMs = 8000 } = {}) {
    this.baseUrl = (baseUrl || 'http://localhost:5001').replace(/\/+$/, '');
    this.minScore = minScore;
    this.timeoutMs = timeoutMs;
  }

  async _fetch(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** @returns {Promise<{ ok: boolean, status?: number, error?: string }>} */
  async health() {
    try {
      const res = await this._fetch(`${this.baseUrl}/`, { method: 'GET' });
      return { ok: res.ok, status: res.status };
    } catch (e) {
      return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message };
    }
  }

  /**
   * Detect PII across a batch of texts.
   * @param {string[]} texts
   * @returns {Promise<{ ok: boolean, perText: Array<Array<{type,value,start,end,score}>>, error?: string }>}
   *          perText[i] is the list of entities found in texts[i] (>= minScore).
   */
  async detect(texts) {
    const perText = texts.map(() => []);
    if (!texts.length) return { ok: true, perText };

    let res;
    try {
      res = await this._fetch(`${this.baseUrl}/detect_pii`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }),
      });
    } catch (e) {
      return { ok: false, perText, error: e.name === 'AbortError' ? 'timeout' : e.message };
    }

    if (!res.ok) {
      return { ok: false, perText, error: `HTTP ${res.status}` };
    }

    let body;
    try {
      body = await res.json();
    } catch (e) {
      return { ok: false, perText, error: `Invalid JSON: ${e.message}` };
    }

    const results = body.results || body.Results || [];
    for (const r of results) {
      const idx = r.textindex ?? r.text_index ?? r.index;
      if (idx === undefined || idx < 0 || idx >= perText.length) continue;
      const entities = r.piientities ?? r.pii_entities ?? r.entities ?? [];
      for (const e of entities) {
        const score = e.score ?? e.confidence ?? 1;
        if (score < this.minScore) continue;
        perText[idx].push({
          type: e.entitytype ?? e.entity_type ?? e.type ?? 'UNKNOWN',
          value: e.value ?? '',
          start: e.start ?? null,
          end: e.end ?? null,
          score,
        });
      }
    }
    return { ok: true, perText };
  }
}
