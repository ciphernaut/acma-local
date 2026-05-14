import { parseFrequencyRange } from '../src/spectrum_plan';

describe('parseFrequencyRange', () => {
    test('plain MHz range', () => {
        expect(parseFrequencyRange('87-88', 'MHz')).toEqual({
            freq_start_hz: 87_000_000,
            freq_end_hz: 88_000_000,
        });
    });

    test('plain kHz range', () => {
        expect(parseFrequencyRange('9-14', 'kHz')).toEqual({
            freq_start_hz: 9_000,
            freq_end_hz: 14_000,
        });
    });

    test('plain GHz range', () => {
        expect(parseFrequencyRange('2.4-2.5', 'GHz')).toEqual({
            freq_start_hz: 2_400_000_000,
            freq_end_hz: 2_500_000_000,
        });
    });

    test('plain Hz range', () => {
        expect(parseFrequencyRange('100-300', 'Hz')).toEqual({
            freq_start_hz: 100,
            freq_end_hz: 300,
        });
    });

    test('decimal MHz range', () => {
        expect(parseFrequencyRange('87.5-108', 'MHz')).toEqual({
            freq_start_hz: 87_500_000,
            freq_end_hz: 108_000_000,
        });
    });

    test('range with trailing unit token (unit-in-range)', () => {
        expect(parseFrequencyRange('9-14 kHz', 'kHz')).toEqual({
            freq_start_hz: 9_000,
            freq_end_hz: 14_000,
        });
    });

    test('range with embedded en-dash separator', () => {
        expect(parseFrequencyRange('87–88', 'MHz')).toEqual({
            freq_start_hz: 87_000_000,
            freq_end_hz: 88_000_000,
        });
    });

    test('open-ended top-of-spectrum entry uses 3 THz sentinel', () => {
        expect(parseFrequencyRange('3000-', 'GHz')).toEqual({
            freq_start_hz: 3_000_000_000_000,
            freq_end_hz: 3_000_000_000_000,
        });
    });

    test('throws on unknown unit', () => {
        expect(() => parseFrequencyRange('1-2', 'BogusHz')).toThrow(/unknown unit/i);
    });

    test('throws on malformed range', () => {
        expect(() => parseFrequencyRange('not-a-range', 'MHz')).toThrow();
    });

    test('throws when end < start', () => {
        expect(() => parseFrequencyRange('100-50', 'MHz')).toThrow(/end .* start/i);
    });

    test('whitespace tolerated around tokens', () => {
        expect(parseFrequencyRange('  87  -  88  ', 'MHz')).toEqual({
            freq_start_hz: 87_000_000,
            freq_end_hz: 88_000_000,
        });
    });
});
