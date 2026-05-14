import { jest } from '@jest/globals';
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
