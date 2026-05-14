import { parseEmissionBandwidth } from '../src/emissions.js';

describe('parseEmissionBandwidth', () => {
    test('100H → 100 Hz', () => {
        expect(parseEmissionBandwidth('100H')).toEqual({ value_hz: 100, display: '100 Hz' });
    });
    test('2K80 → 2.80 kHz = 2800 Hz', () => {
        expect(parseEmissionBandwidth('2K80')).toEqual({ value_hz: 2800, display: '2.80 kHz' });
    });
    test('10K1 → 10.1 kHz = 10100 Hz', () => {
        expect(parseEmissionBandwidth('10K1')).toEqual({ value_hz: 10100, display: '10.1 kHz' });
    });
    test('16K0 → 16 kHz', () => {
        expect(parseEmissionBandwidth('16K0')).toEqual({ value_hz: 16000, display: '16.0 kHz' });
    });
    test('320K → 320 kHz', () => {
        expect(parseEmissionBandwidth('320K')).toEqual({ value_hz: 320_000, display: '320 kHz' });
    });
    test('6M25 → 6.25 MHz', () => {
        expect(parseEmissionBandwidth('6M25')).toEqual({ value_hz: 6_250_000, display: '6.25 MHz' });
    });
    test('145M → 145 MHz', () => {
        expect(parseEmissionBandwidth('145M')).toEqual({ value_hz: 145_000_000, display: '145 MHz' });
    });
    test('999G → 999 GHz', () => {
        expect(parseEmissionBandwidth('999G')).toEqual({ value_hz: 999_000_000_000, display: '999 GHz' });
    });

    test('rejects empty', () => { expect(() => parseEmissionBandwidth('')).toThrow(); });
    test('rejects wrong length', () => { expect(() => parseEmissionBandwidth('10K')).toThrow(); });
    test('rejects no unit letter', () => { expect(() => parseEmissionBandwidth('1234')).toThrow(); });
    test('rejects unit at position 0', () => { expect(() => parseEmissionBandwidth('K100')).toThrow(); });
    test('rejects two unit letters', () => { expect(() => parseEmissionBandwidth('1H2H')).toThrow(); });
    test('rejects non-digit numeral', () => { expect(() => parseEmissionBandwidth('1KA0')).toThrow(); });
    test("rejects first-numeral-zero per spec", () => { expect(() => parseEmissionBandwidth('0K01')).toThrow(); });
});

import { decodeEmissionDesignator } from '../src/emissions.js';

describe('decodeEmissionDesignator', () => {
    test('16K0F3E — classic UHF land-mobile FM telephony', () => {
        const d = decodeEmissionDesignator('16K0F3E');
        expect(d.valid).toBe(true);
        expect(d.bandwidth).toEqual({ value_hz: 16000, display: '16.0 kHz', raw: '16K0' });
        expect(d.modulation?.code).toBe('F');
        expect(d.modulation?.group).toBe('angle');
        expect(d.signal_nature?.code).toBe('3');
        expect(d.info_type?.code).toBe('E');
        expect(d.signal_detail).toBeNull();
        expect(d.multiplex).toBeNull();
        expect(d.warnings).toEqual([]);
    });

    test('10K1F3E — VHF land-mobile FM telephony', () => {
        const d = decodeEmissionDesignator('10K1F3E');
        expect(d.valid).toBe(true);
        expect(d.bandwidth?.value_hz).toBe(10100);
        expect(d.modulation?.code).toBe('F');
        expect(d.info_type?.code).toBe('E');
    });

    test('10M0W7D — common 10 MHz combined-mode multi-channel digital data', () => {
        const d = decodeEmissionDesignator('10M0W7D');
        expect(d.valid).toBe(true);
        expect(d.bandwidth?.value_hz).toBe(10_000_000);
        expect(d.modulation?.code).toBe('W');
        expect(d.signal_nature?.code).toBe('7');
        expect(d.info_type?.code).toBe('D');
    });

    test('19M8W7DEW — 9-char form with signal_detail and multiplex', () => {
        const d = decodeEmissionDesignator('19M8W7DEW');
        expect(d.valid).toBe(true);
        expect(d.bandwidth?.value_hz).toBe(19_800_000);
        expect(d.signal_detail?.code).toBe('E');
        expect(d.multiplex?.code).toBe('W');
    });

    test('145MW7D — 7-char short form (no fractional bandwidth digit)', () => {
        const d = decodeEmissionDesignator('145MW7D');
        expect(d.valid).toBe(true);
        expect(d.bandwidth?.value_hz).toBe(145_000_000);
    });

    test('"16K0F3E  " — trailing whitespace tolerated, warning emitted', () => {
        const d = decodeEmissionDesignator('16K0F3E  ');
        expect(d.valid).toBe(true);
        expect(d.modulation?.code).toBe('F');
        expect(d.warnings.some(w => /whitespace/i.test(w))).toBe(true);
    });

    test('10K1Z3E — unknown modulation letter', () => {
        const d = decodeEmissionDesignator('10K1Z3E');
        expect(d.valid).toBe(false);
        expect(d.modulation).toBeNull();
        expect(d.warnings.length).toBeGreaterThan(0);
    });

    test('10K1F3EZN — unknown signal_detail letter', () => {
        const d = decodeEmissionDesignator('10K1F3EZN');
        expect(d.valid).toBe(true);
        expect(d.signal_detail).toBeNull();
        expect(d.warnings.some(w => /signal.detail/i.test(w))).toBe(true);
    });

    test('empty string — invalid, no fields set', () => {
        const d = decodeEmissionDesignator('');
        expect(d.valid).toBe(false);
        expect(d.bandwidth).toBeNull();
        expect(d.modulation).toBeNull();
        expect(d.warnings.length).toBeGreaterThan(0);
    });

    test('8-char input — invalid (must be 7 or 9)', () => {
        const d = decodeEmissionDesignator('10K1F3EZ');
        expect(d.valid).toBe(false);
        expect(d.warnings.some(w => /length/i.test(w))).toBe(true);
    });

    test('2K80J3E — HF marine SSB suppressed-carrier telephony', () => {
        const d = decodeEmissionDesignator('2K80J3E');
        expect(d.valid).toBe(true);
        expect(d.modulation?.code).toBe('J');
        expect(d.info_type?.code).toBe('E');
    });

    test('6M25C3F — vestigial-sideband analogue TV', () => {
        const d = decodeEmissionDesignator('6M25C3F');
        expect(d.valid).toBe(true);
        expect(d.modulation?.code).toBe('C');
        expect(d.info_type?.code).toBe('F');
    });
});
