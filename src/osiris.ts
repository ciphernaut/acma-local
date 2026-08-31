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

    try {
        const res = await axios.post(url, { ...payload, apiKey: key }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000,
        });
        return res.data as IngestResult;
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
}
