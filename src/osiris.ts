/**
 * Outbound push to an OSIRIS instance's Polybolos ingest endpoint.
 *
 * The only egress in this codebase. The ingest key travels in the JSON body —
 * not a header — because that is what OSIRIS validates; see
 * docs/osiris-acma-bridge.md. It is read from the environment and must never
 * reach a tool argument, a tool response, or a log line.
 */
import axios from 'axios';

export interface IngestResult {
    accepted: number;
    rejected: number;
    errors: string[];
}

export async function pushToOsiris(payloadJson: string): Promise<IngestResult> {
    const base = process.env.OSIRIS_URL;
    const key = process.env.OSIRIS_INGEST_KEY;
    if (!base) throw new Error('OSIRIS_URL is not set. Set it to the OSIRIS origin, e.g. http://host:3001');
    if (!key) throw new Error('OSIRIS_INGEST_KEY is not set. It must equal the SDK_INGEST_KEY configured on the OSIRIS side.');

    const payload = JSON.parse(payloadJson) as { source: string; entities: unknown[] };
    const url = `${base.replace(/\/+$/, '')}/api/sdk/ingest`;

    let data: unknown;
    try {
        const res = await axios.post(url, { ...payload, apiKey: key }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000,
            // The ingest key travels in the body, so a redirect would silently
            // re-issue the POST — key included — to whatever the 3xx points at.
            maxRedirects: 0,
            maxContentLength: 10 * 1024 * 1024,
            maxBodyLength: 10 * 1024 * 1024,
        });
        data = res.data;
    } catch (e) {
        const status = (e as { response?: { status?: number } }).response?.status;
        if (status === 503) {
            throw new Error(
                'OSIRIS refused the push: ingestion is disabled there. Set SDK_INGEST_KEY in the OSIRIS environment and restart it.',
            );
        }
        if (status === 401) {
            throw new Error('OSIRIS rejected the key: OSIRIS_INGEST_KEY does not match the SDK_INGEST_KEY configured there.');
        }
        if (status === 400) {
            throw new Error('OSIRIS rejected the payload structure. It requires source, apiKey and an entities array.');
        }
        const reason = e instanceof Error ? e.message : String(e);
        throw new Error(`Could not reach OSIRIS at ${url}: ${reason}`);
    }

    // Validate the shape before trusting it: a 200 serving an HTML page (wrong
    // port, a proxy, a captive portal) yields a string, and a 204 yields
    // undefined — neither should read as a successful ingest. The body is not
    // included in the message below: it is attacker-influenceable and reaches
    // a model context.
    if (
        typeof data !== 'object' || data === null ||
        typeof (data as { accepted?: unknown }).accepted !== 'number' ||
        typeof (data as { rejected?: unknown }).rejected !== 'number'
    ) {
        throw new Error(
            'OSIRIS returned an unexpected response shape; check OSIRIS_URL points at the OSIRIS app rather than a proxy.',
        );
    }
    return data as IngestResult;
}
