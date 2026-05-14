/**
 * CLI entry point for spectrum-plan operations.
 *
 * Usage:
 *   npm run import-spectrum-plan -- --reseed [--source <path.sql|path.db>]
 *   npm run import-spectrum-plan -- --patch <path.sql>
 *   npm run dump-spectrum-plan
 *
 * All paths resolved relative to process.cwd().
 */
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { initializeDatabase } from './db.js';
import { applyReseed, applyPatch, dumpSpectrumPlan } from './spectrum_plan.js';
import { DEFAULT_CONFIG } from './sync.js';
import { log } from './logger.js';

const DEFAULT_SEED_PATH = path.resolve('seed/spectrum_plan.sql');

function usage(): never {
    console.error(`Usage:
  tsx src/import_spectrum_plan.ts --reseed [--source <path.sql|path.db>]
  tsx src/import_spectrum_plan.ts --patch <path.sql>
  tsx src/import_spectrum_plan.ts dump [--out <path>]
`);
    process.exit(1);
}

function getArg(argv: string[], flag: string): string | undefined {
    const i = argv.indexOf(flag);
    return i >= 0 && i < argv.length - 1 ? argv[i + 1] : undefined;
}

function main() {
    const argv = process.argv.slice(2);
    const dbPath = process.env.ACMA_DB_PATH || DEFAULT_CONFIG.dbPath;

    // Always ensure the schema exists. initializeDatabase uses CREATE TABLE
    // IF NOT EXISTS, so this is idempotent on existing DBs and adds any
    // tables that landed in later code versions (e.g. spectrum_* added after
    // the DB was first synced under an older schema).
    if (!fs.existsSync(dbPath)) {
        log.info(`Initialising new DB at ${dbPath}`);
    }
    initializeDatabase(dbPath);

    if (argv[0] === 'dump') {
        const outPath = getArg(argv, '--out') ?? DEFAULT_SEED_PATH;
        const outDir = path.dirname(outPath);
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        const db = new Database(dbPath);
        try {
            dumpSpectrumPlan(db, outPath);
        } finally { db.close(); }
        return;
    }

    if (argv.includes('--reseed')) {
        const source = getArg(argv, '--source') ?? DEFAULT_SEED_PATH;
        const db = new Database(dbPath);
        try {
            applyReseed(db, source);
        } finally { db.close(); }
        return;
    }

    if (argv.includes('--patch')) {
        const patchPath = getArg(argv, '--patch');
        if (!patchPath) usage();
        const db = new Database(dbPath);
        try {
            applyPatch(db, patchPath!);
        } finally { db.close(); }
        return;
    }

    usage();
}

main();
