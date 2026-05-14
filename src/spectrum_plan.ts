/**
 * Spectrum-plan helpers (lookup-only dataset alongside the RRL mirror).
 *
 * See docs/superpowers/specs/2026-05-14-spectrum-plan-integration-design.md.
 */

const UNIT_MULTIPLIER: Record<string, number> = {
    'Hz': 1,
    'kHz': 1_000,
    'MHz': 1_000_000,
    'GHz': 1_000_000_000,
    'THz': 1_000_000_000_000,
};

const TOP_OF_SPECTRUM_HZ = 3_000_000_000_000;  // 3 THz sentinel for open-ended bands

/**
 * Parse a frequency-range string + unit into integer Hz bounds.
 *
 * Examples:
 *   parseFrequencyRange('87-88', 'MHz')        → { 87_000_000, 88_000_000 }
 *   parseFrequencyRange('9-14 kHz', 'kHz')     → { 9_000, 14_000 }
 *   parseFrequencyRange('3000-', 'GHz')        → { 3 THz, 3 THz } (open-ended)
 *
 * Accepts en-dash (U+2013) as well as hyphen separator. Trailing unit token
 * inside the range string is stripped before parsing.
 */
export function parseFrequencyRange(rangeText: string, unit: string): { freq_start_hz: number; freq_end_hz: number } {
    const multiplier = UNIT_MULTIPLIER[unit];
    if (multiplier === undefined) {
        throw new Error(`parseFrequencyRange: unknown unit "${unit}"`);
    }

    // Strip a trailing unit token (e.g. "9-14 kHz" → "9-14") and whitespace.
    const stripped = rangeText
        .replace(/\b(Hz|kHz|MHz|GHz|THz)\b/g, '')
        .trim();

    // Normalise en-dash to ASCII hyphen.
    const normalised = stripped.replace(/–/g, '-');

    // Open-ended entry: "3000-" → top-of-spectrum sentinel for both bounds.
    if (/^\d+(\.\d+)?\s*-\s*$/.test(normalised)) {
        return { freq_start_hz: TOP_OF_SPECTRUM_HZ, freq_end_hz: TOP_OF_SPECTRUM_HZ };
    }

    const parts = normalised.split(/\s*-\s*/);
    if (parts.length !== 2) {
        throw new Error(`parseFrequencyRange: malformed range "${rangeText}"`);
    }

    const start = Number(parts[0]);
    const end = Number(parts[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
        throw new Error(`parseFrequencyRange: non-numeric bound in "${rangeText}"`);
    }
    if (end < start) {
        throw new Error(`parseFrequencyRange: end (${end}) < start (${start}) in "${rangeText}"`);
    }

    return {
        freq_start_hz: Math.round(start * multiplier),
        freq_end_hz: Math.round(end * multiplier),
    };
}
