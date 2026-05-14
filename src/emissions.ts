/**
 * Emission designator decoder — ITU/ACA convention (worldwide since 1982).
 *
 * Designator shape: 4-char bandwidth + 3-char body (modulation/signal/info) +
 * optional 2-char tail (signal-detail + multiplex). Examples:
 *   16K0F3E    → 16 kHz, FM, single-channel analogue, telephony
 *   19M8W7DEW  → 19.8 MHz, combined-mode, multi-channel digital, data,
 *                multi-condition signal element, FDM+TDM
 *
 * CODE_TABLES is the source of truth — seed/emissions.sql is generated from it.
 */

export interface CodeEntry {
    description: string;
    group?: string;  // only modulation has a group
}

export const CODE_TABLES = {
    modulation: {
        N: { description: 'Unmodulated carrier',                                 group: 'unmodulated' },
        A: { description: 'Amplitude modulation, double sideband',               group: 'amplitude' },
        H: { description: 'Single sideband, full carrier',                       group: 'amplitude' },
        R: { description: 'Single sideband, reduced or variable level carrier',  group: 'amplitude' },
        J: { description: 'Single sideband, suppressed carrier',                 group: 'amplitude' },
        B: { description: 'Independent sideband',                                group: 'amplitude' },
        C: { description: 'Vestigial sideband',                                  group: 'amplitude' },
        F: { description: 'Frequency modulation',                                group: 'angle' },
        G: { description: 'Phase modulation',                                    group: 'angle' },
        D: { description: 'Amplitude and angle modulated simultaneously or in sequence', group: 'combined' },
        P: { description: 'Unmodulated sequence of pulses',                      group: 'pulse' },
        K: { description: 'Pulse, amplitude modulated',                          group: 'pulse' },
        L: { description: 'Pulse, width/duration modulated',                     group: 'pulse' },
        M: { description: 'Pulse, position/phase modulated',                     group: 'pulse' },
        Q: { description: 'Pulse with carrier angle-modulated during the pulse', group: 'pulse' },
        V: { description: 'Pulse, combination of the foregoing or other means',  group: 'pulse' },
        W: { description: 'Combination of amplitude, angle and/or pulse',        group: 'combined' },
        X: { description: 'Cases not otherwise covered',                         group: 'other' },
    },
    signal_nature: {
        '0': { description: 'No modulating signal' },
        '1': { description: 'Single channel, quantized/digital, no sub-carrier' },
        '2': { description: 'Single channel, quantized/digital, with modulating sub-carrier' },
        '3': { description: 'Single channel, analogue' },
        '7': { description: 'Two or more channels, quantized/digital' },
        '8': { description: 'Two or more channels, analogue' },
        '9': { description: 'Composite quantized/digital + analogue' },
        X:   { description: 'Cases not otherwise covered' },
    },
    info_type: {
        N: { description: 'No information transmitted' },
        A: { description: 'Telegraphy - aural reception' },
        B: { description: 'Telegraphy - automatic reception' },
        C: { description: 'Facsimile' },
        D: { description: 'Data transmission, telemetry, telecommand' },
        E: { description: 'Telephony (including sound broadcasting)' },
        F: { description: 'Television (video)' },
        W: { description: 'Combination of the above' },
        X: { description: 'Cases not otherwise covered' },
    },
    signal_detail: {
        A: { description: 'Two-condition code, differing element numbers/durations' },
        B: { description: 'Two-condition code, same numbers/duration, no error-correction' },
        C: { description: 'Two-condition code, same numbers/duration, with error-correction' },
        D: { description: 'Four-condition code, each condition = one signal element' },
        E: { description: 'Multi-condition code, each condition = one signal element' },
        F: { description: 'Multi-condition code, each combination = a character' },
        G: { description: 'Sound of broadcasting quality (monophonic)' },
        H: { description: 'Sound of broadcasting quality (stereophonic or quadraphonic)' },
        J: { description: 'Sound of commercial quality' },
        K: { description: 'Sound of commercial quality with frequency inversion or bandsplitting' },
        L: { description: 'Sound of commercial quality with separate FM signals controlling demodulated level' },
        M: { description: 'Monochrome' },
        N: { description: 'Colour' },
        W: { description: 'Combination of the above' },
        X: { description: 'Cases not otherwise covered' },
    },
    multiplex: {
        N: { description: 'None' },
        C: { description: 'Code-division multiplex' },
        F: { description: 'Frequency-division multiplex' },
        T: { description: 'Time-division multiplex' },
        W: { description: 'Combination of frequency-division and time-division multiplex' },
        X: { description: 'Other types of multiplexing' },
    },
} as const;

export type EmissionField = keyof typeof CODE_TABLES;

const UNIT_HZ: Record<string, number> = { H: 1, K: 1_000, M: 1_000_000, G: 1_000_000_000 };

/**
 * Parse the 4-char bandwidth prefix of an emission designator into Hz.
 *
 * Spec rules:
 *  - Format is 3 numerals + 1 unit letter; the letter occupies the decimal point.
 *  - Unit letter is H, K, M, or G.
 *  - First character must be a non-zero numeral (not a unit letter).
 *  - Examples: 100H = 100 Hz, 2K80 = 2.80 kHz, 6M25 = 6.25 MHz, 999G = 999 GHz.
 *
 * Throws on malformed input. Caller should catch and surface as a warning.
 */
export function parseEmissionBandwidth(first4: string): { value_hz: number; display: string } {
    if (first4.length !== 4) {
        throw new Error(`bandwidth must be 4 chars, got ${first4.length}: ${JSON.stringify(first4)}`);
    }
    // First char must be a non-zero numeral.
    const c0 = first4[0]!;
    if (!/^[1-9]$/.test(c0)) {
        throw new Error(`bandwidth first character must be 1-9, got "${c0}" in ${JSON.stringify(first4)}`);
    }
    // Locate the (exactly one) unit letter at position 1, 2, or 3.
    const unitPositions: number[] = [];
    for (let i = 1; i < 4; i++) {
        if (/[HKMG]/.test(first4[i]!)) unitPositions.push(i);
    }
    if (unitPositions.length === 0) {
        throw new Error(`bandwidth missing unit letter (H/K/M/G): ${JSON.stringify(first4)}`);
    }
    if (unitPositions.length > 1) {
        throw new Error(`bandwidth has multiple unit letters: ${JSON.stringify(first4)}`);
    }
    const unitPos = unitPositions[0]!;
    const unitLetter = first4[unitPos]!;
    // Remaining positions must all be digits.
    for (let i = 1; i < 4; i++) {
        if (i === unitPos) continue;
        if (!/^[0-9]$/.test(first4[i]!)) {
            throw new Error(`bandwidth has non-digit at position ${i}: ${JSON.stringify(first4)}`);
        }
    }
    // Construct the numeric value: substitute the unit letter with a decimal point.
    const numericStr = first4.slice(0, unitPos) + '.' + first4.slice(unitPos + 1);
    const numericValue = parseFloat(numericStr);
    const multiplier = UNIT_HZ[unitLetter]!;
    const value_hz = Math.round(numericValue * multiplier);

    // Display: trim trailing zero after the decimal only if the integer part already conveys magnitude.
    // Examples expected: "100 Hz", "2.80 kHz", "16.0 kHz", "320 kHz", "6.25 MHz", "145 MHz", "999 GHz".
    const unitLabel = unitLetter === 'H' ? 'Hz' : `${unitLetter}Hz`.replace('KHz', 'kHz');
    // numericStr looks like "1.00", "2.80", "10.1", "320.", "999."
    const cleanedNumeric = numericStr.endsWith('.') ? numericStr.slice(0, -1) : numericStr;
    const display = `${cleanedNumeric} ${unitLabel}`;

    return { value_hz, display };
}
