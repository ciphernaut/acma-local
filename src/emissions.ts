/**
 * Emission designator decoder — ITU/ACA convention (worldwide since 1982).
 *
 * Designator shape: 4-char bandwidth + 3-char body (modulation/signal/info) +
 * optional 2-char tail (signal-detail + multiplex). Examples:
 *   16K0F3E    → 16.0 kHz, FM, single-channel analogue, telephony
 *   19M8W7DEW  → 19.8 MHz, combined-mode, multi-channel digital, data,
 *                multi-condition signal element, FDM+TDM
 *
 * CODE_TABLES is the source of truth — seed/emissions.sql is generated from it.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3';
import * as fs from 'fs';
import { log } from './logger.js';

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
        A: { description: 'Telegraphy — aural reception' },
        B: { description: 'Telegraphy — automatic reception' },
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
} as const satisfies {
    modulation: Record<string, { description: string; group: string }>;
    signal_nature: Record<string, { description: string }>;
    info_type: Record<string, { description: string }>;
    signal_detail: Record<string, { description: string }>;
    multiplex: Record<string, { description: string }>;
};

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

export interface DecodedField { code: string; description: string }
export interface DecodedModulation extends DecodedField { group: string }

export interface DecodedEmission {
    input: string;
    normalised: string;
    valid: boolean;
    bandwidth: { value_hz: number; display: string; raw: string } | null;
    modulation: DecodedModulation | null;
    signal_nature: DecodedField | null;
    info_type: DecodedField | null;
    signal_detail: DecodedField | null;
    multiplex: DecodedField | null;
    warnings: string[];
}

function lookupCode<F extends EmissionField>(field: F, code: string): { code: string; description: string; group?: string } | null {
    const table = CODE_TABLES[field] as Record<string, { description: string; group?: string }>;
    const entry = table[code];
    if (!entry) return null;
    return { code, ...entry };
}

export function decodeEmissionDesignator(input: string): DecodedEmission {
    const warnings: string[] = [];
    const trimmed = input.trim();
    if (trimmed !== input && trimmed.length > 0) {
        warnings.push('Input had leading/trailing whitespace, which was trimmed.');
    }
    const normalised = trimmed.toUpperCase();

    const empty: DecodedEmission = {
        input, normalised, valid: false,
        bandwidth: null, modulation: null, signal_nature: null,
        info_type: null, signal_detail: null, multiplex: null,
        warnings,
    };

    if (normalised.length === 0) {
        warnings.push('Empty input.');
        return empty;
    }
    if (normalised.length !== 7 && normalised.length !== 9) {
        warnings.push(`Designator length must be 7 or 9 characters, got ${normalised.length}.`);
        return empty;
    }

    // Bandwidth (positions 0-3).
    let bandwidth: DecodedEmission['bandwidth'] = null;
    const bwRaw = normalised.slice(0, 4);
    try {
        const parsed = parseEmissionBandwidth(bwRaw);
        bandwidth = { ...parsed, raw: bwRaw };
    } catch (e) {
        warnings.push(`Bandwidth parse failed: ${(e as Error).message}`);
        return empty;
    }

    // Required body (positions 4, 5, 6).
    const modulation = lookupCode('modulation', normalised[4]!);
    const signal_nature = lookupCode('signal_nature', normalised[5]!);
    const info_type = lookupCode('info_type', normalised[6]!);
    if (!modulation) warnings.push(`Unknown modulation code "${normalised[4]}".`);
    if (!signal_nature) warnings.push(`Unknown signal-nature code "${normalised[5]}".`);
    if (!info_type) warnings.push(`Unknown info-type code "${normalised[6]}".`);

    const requiredValid = modulation !== null && signal_nature !== null && info_type !== null;

    // Optional tail (positions 7, 8) when length === 9.
    let signal_detail: DecodedField | null = null;
    let multiplex: DecodedField | null = null;
    if (normalised.length === 9) {
        signal_detail = lookupCode('signal_detail', normalised[7]!);
        multiplex = lookupCode('multiplex', normalised[8]!);
        if (!signal_detail) warnings.push(`Unknown signal-detail code "${normalised[7]}".`);
        if (!multiplex) warnings.push(`Unknown multiplex code "${normalised[8]}".`);
    }

    return {
        input, normalised, valid: requiredValid,
        bandwidth,
        modulation: modulation ? (modulation as DecodedModulation) : null,
        signal_nature,
        info_type,
        signal_detail,
        multiplex,
        warnings,
    };
}

const EMISSION_TABLES = [
    'emission_modulation',
    'emission_signal_nature',
    'emission_info_type',
    'emission_signal_detail',
    'emission_multiplex',
] as const;

function sqlString(s: string): string {
    return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * Generate seed/emissions.sql from CODE_TABLES — the source of truth.
 * Format mirrors seed/spectrum_plan.sql: a SAVEPOINT-bounded block of
 * DELETEs + INSERTs, safe for atomic reseed.
 */
export function dumpSeedFromCodeTables(outPath: string): void {
    const lines: string[] = [
        '-- Generated by `npm run dump-emissions` from src/emissions.ts CODE_TABLES.',
        '-- Do not edit by hand. Regenerate after changing CODE_TABLES.',
        '',
        'SAVEPOINT emissions_load;',
    ];
    for (const t of EMISSION_TABLES) {
        lines.push(`DELETE FROM ${t};`);
    }
    lines.push('');

    for (const [code, entry] of Object.entries(CODE_TABLES.modulation)) {
        lines.push(
            `INSERT INTO emission_modulation(code, description, group_name) ` +
            `VALUES(${sqlString(code)}, ${sqlString(entry.description)}, ${sqlString(entry.group)});`
        );
    }
    for (const [code, entry] of Object.entries(CODE_TABLES.signal_nature)) {
        lines.push(`INSERT INTO emission_signal_nature(code, description) VALUES(${sqlString(code)}, ${sqlString(entry.description)});`);
    }
    for (const [code, entry] of Object.entries(CODE_TABLES.info_type)) {
        lines.push(`INSERT INTO emission_info_type(code, description) VALUES(${sqlString(code)}, ${sqlString(entry.description)});`);
    }
    for (const [code, entry] of Object.entries(CODE_TABLES.signal_detail)) {
        lines.push(`INSERT INTO emission_signal_detail(code, description) VALUES(${sqlString(code)}, ${sqlString(entry.description)});`);
    }
    for (const [code, entry] of Object.entries(CODE_TABLES.multiplex)) {
        lines.push(`INSERT INTO emission_multiplex(code, description) VALUES(${sqlString(code)}, ${sqlString(entry.description)});`);
    }

    lines.push('');
    lines.push('RELEASE SAVEPOINT emissions_load;');

    fs.writeFileSync(outPath, lines.join('\n') + '\n');
    const insertCount = lines.filter(l => l.startsWith('INSERT')).length;
    log.info(`[EMISSIONS] Wrote ${outPath} (${insertCount} INSERT statements across 5 tables)`);
}

/**
 * Wipe and apply the seed unconditionally. Used by --reseed CLI.
 * Wrapped in an outer savepoint so a malformed seed leaves the DB unchanged.
 */
export function applyEmissionReseed(db: BetterSqlite3Database, seedPath: string): void {
    if (!fs.existsSync(seedPath)) {
        throw new Error(`applyEmissionReseed: seed not found: ${seedPath}`);
    }
    const sql = fs.readFileSync(seedPath, 'utf-8');
    const savepoint = 'emissions_reseed_outer';
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
        // Defensive wipe before applying the seed. The generated seed file
        // also contains DELETEs at its head, but a hand-crafted seed (used
        // via --source) may not — this loop is what makes applyEmissionReseed
        // a safe "wipe and load" operation regardless of seed file contents.
        for (const t of EMISSION_TABLES) db.exec(`DELETE FROM ${t};`);
        // The seed file declares its own inner SAVEPOINT; savepoints nest fine.
        db.exec(sql);
        db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        const counts = EMISSION_TABLES.map(t => `${t}=${(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n}`).join(', ');
        log.info(`[EMISSIONS] Reseeded: ${counts}`);
    } catch (e) {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
        throw e;
    }
}

const FIELD_TO_TABLE: Record<EmissionField, string> = {
    modulation: 'emission_modulation',
    signal_nature: 'emission_signal_nature',
    info_type: 'emission_info_type',
    signal_detail: 'emission_signal_detail',
    multiplex: 'emission_multiplex',
};

export type ResolveResult =
    | { kind: 'ok'; code: string; description: string }
    | { kind: 'unknown'; input: string }
    | { kind: 'not_found'; input: string }
    | { kind: 'ambiguous'; candidates: Array<{ code: string; description: string }> };

/**
 * Resolve a single user input (either a code letter or a description substring)
 * to one code letter for the given field. Used by search_devices_by_emission.
 *
 *  - Single-char input: looked up directly in CODE_TABLES (DB not needed).
 *    Returns 'ok' on hit, 'unknown' on miss.
 *  - Multi-char input: case-insensitive substring match against the DB
 *    description column. Returns 'ok' on exactly one match, 'not_found' on
 *    zero, 'ambiguous' on >1.
 */
export function resolveEmissionCode(
    db: BetterSqlite3Database,
    field: EmissionField,
    input: string,
): ResolveResult {
    const trimmed = input.trim();
    if (trimmed.length === 0) return { kind: 'not_found', input };

    if (trimmed.length === 1) {
        const code = trimmed.toUpperCase();
        const table = CODE_TABLES[field] as Record<string, { description: string }>;
        if (table[code]) return { kind: 'ok', code, description: table[code]!.description };
        return { kind: 'unknown', input };
    }

    const tableName = FIELD_TO_TABLE[field];
    const rows = db.prepare(
        `SELECT code, description FROM ${tableName} WHERE LOWER(description) LIKE ? ORDER BY code`
    ).all(`%${trimmed.toLowerCase()}%`) as Array<{ code: string; description: string }>;

    if (rows.length === 0) return { kind: 'not_found', input };
    if (rows.length === 1) return { kind: 'ok', code: rows[0]!.code, description: rows[0]!.description };
    return { kind: 'ambiguous', candidates: rows };
}

/**
 * Auto-bootstrap: if ALL five emission tables are empty AND the seed file
 * exists, apply it. Used at the tail of performFullSync so a fresh DB
 * comes up complete. Partial population (one or more table non-empty)
 * is treated as "user intent" and left alone.
 */
export function bootstrapEmissionTables(db: BetterSqlite3Database, seedPath: string): void {
    for (const t of EMISSION_TABLES) {
        const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
        if (n > 0) return;
    }
    if (!fs.existsSync(seedPath)) {
        log.warn(`[EMISSIONS] Bootstrap skipped: no seed at ${seedPath}`);
        return;
    }
    try {
        log.info(`[EMISSIONS] Bootstrapping emission tables from ${seedPath}`);
        applyEmissionReseed(db, seedPath);
    } catch (e) {
        log.error(`[EMISSIONS] Bootstrap failed: ${(e as Error).message}. Emission tables remain empty.`);
    }
}
