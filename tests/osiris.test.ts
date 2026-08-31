import { jest } from '@jest/globals';
import axios from 'axios';
import { pushToOsiris } from '../src/osiris.js';

const PAYLOAD = JSON.stringify({ source: 'acma-rrl', entities: [{ id: '1' }] });

describe('pushToOsiris', () => {
    const env = process.env;
    beforeEach(() => {
        process.env = { ...env, OSIRIS_URL: 'http://osiris.test:3001', OSIRIS_INGEST_KEY: 'test-key' };
    });
    afterEach(() => { process.env = env; jest.restoreAllMocks(); });

    it('posts to /api/sdk/ingest with the key injected into the body', async () => {
        const spy = jest.spyOn(axios, 'post').mockResolvedValue({
            status: 200, data: { accepted: 1, rejected: 0, errors: [] },
        } as never);

        await pushToOsiris(PAYLOAD);

        expect(spy).toHaveBeenCalledTimes(1);
        const [url, body] = spy.mock.calls[0]!;
        expect(url).toBe('http://osiris.test:3001/api/sdk/ingest');
        expect((body as any).apiKey).toBe('test-key');
        expect((body as any).source).toBe('acma-rrl');
    });

    it('fails clearly when the key is not configured', async () => {
        delete process.env.OSIRIS_INGEST_KEY;
        await expect(pushToOsiris(PAYLOAD)).rejects.toThrow(/OSIRIS_INGEST_KEY/);
    });

    it('fails clearly when the URL is not configured', async () => {
        delete process.env.OSIRIS_URL;
        await expect(pushToOsiris(PAYLOAD)).rejects.toThrow(/OSIRIS_URL/);
    });

    it('explains a 503 as ingestion being disabled on the OSIRIS side', async () => {
        jest.spyOn(axios, 'post').mockRejectedValue({
            response: { status: 503, data: { errors: ['Ingest endpoint disabled — SDK_INGEST_KEY not configured'] } },
        } as never);
        await expect(pushToOsiris(PAYLOAD)).rejects.toThrow(/SDK_INGEST_KEY/);
    });

    it('explains a 401 as a key mismatch', async () => {
        jest.spyOn(axios, 'post').mockRejectedValue({
            response: { status: 401, data: { errors: ['Invalid API key'] } },
        } as never);
        await expect(pushToOsiris(PAYLOAD)).rejects.toThrow(/does not match/i);
    });

    it('never puts the key in the thrown message', async () => {
        jest.spyOn(axios, 'post').mockRejectedValue({ response: { status: 401, data: {} } } as never);
        await expect(pushToOsiris(PAYLOAD)).rejects.not.toThrow(/test-key/);
    });
});
