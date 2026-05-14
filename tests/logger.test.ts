import { jest } from '@jest/globals';

describe('logger', () => {
    let errorSpy: any;

    beforeEach(() => {
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.resetModules();
    });

    afterEach(() => {
        errorSpy.mockRestore();
        delete process.env.LOG_LEVEL;
    });

    test('default level is info — info/warn/error emit, debug does not', async () => {
        delete process.env.LOG_LEVEL;
        const { log } = await import('../src/logger');
        log.error('e');
        log.warn('w');
        log.info('i');
        log.debug('d');
        const calls = errorSpy.mock.calls.map((c: unknown[]) => c[0]);
        expect(calls).toEqual(['e', 'w', 'i']);
    });

    test('LOG_LEVEL=error suppresses warn/info/debug', async () => {
        process.env.LOG_LEVEL = 'error';
        const { log } = await import('../src/logger');
        log.error('e');
        log.warn('w');
        log.info('i');
        log.debug('d');
        const calls = errorSpy.mock.calls.map((c: unknown[]) => c[0]);
        expect(calls).toEqual(['e']);
    });

    test('LOG_LEVEL=debug admits everything', async () => {
        process.env.LOG_LEVEL = 'debug';
        const { log, debugEnabled } = await import('../src/logger');
        log.error('e');
        log.warn('w');
        log.info('i');
        log.debug('d');
        const calls = errorSpy.mock.calls.map((c: unknown[]) => c[0]);
        expect(calls).toEqual(['e', 'w', 'i', 'd']);
        expect(debugEnabled).toBe(true);
    });

    test('unknown LOG_LEVEL falls back to info', async () => {
        process.env.LOG_LEVEL = 'unrecognised';
        const { log } = await import('../src/logger');
        log.error('e');
        log.warn('w');
        log.info('i');
        log.debug('d');
        const calls = errorSpy.mock.calls.map((c: unknown[]) => c[0]);
        expect(calls).toEqual(['e', 'w', 'i']);
    });
});
