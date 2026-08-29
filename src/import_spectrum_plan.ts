/**
 * CLI entry point for spectrum-plan operations.
 *
 * Usage:
 *   npm run import-spectrum-plan -- --reseed [--patch <path.yaml>]
 *   npm run import-spectrum-plan -- --patch <path.yaml>
 *
 * --patch <file>   Copy <file> into seed/patches/, then regenerate
 *                  seed/spectrum_plan.sql. Reverted if generation fails.
 * --reseed         Apply the committed seed/spectrum_plan.sql to the runtime DB,
 *                  atomically — a seed that fails to load leaves the existing
 *                  data in place. Does NOT regenerate the seed on its own; run
 *                  `npx tsx scripts/generate-spectrum-seed.ts` for that.
 *
 * Patch-only (--patch without --reseed) just updates the seed file; the new
 * data is picked up the next time the DB is bootstrapped or --reseed is used.
 */
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { initializeDatabase } from './db.js';
import { reseedFromSql } from './spectrum_plan.js';
import { DEFAULT_CONFIG } from './sync.js';
import { log } from './logger.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage(): never {
    console.error(`Usage:
  npm run import-spectrum-plan -- --reseed [--patch <path.yaml>]
  npm run import-spectrum-plan -- --patch <path.yaml>
`);
    process.exit(1);
}

function getArg(argv: string[], flag: string): string | undefined {
    const i = argv.indexOf(flag);
    return i >= 0 && i < argv.length - 1 ? argv[i + 1] : undefined;
}

function main() {
    const argv = process.argv.slice(2);
    if (argv.length === 0) usage();

    const reseed = argv.includes('--reseed');
    const patchArg = getArg(argv, '--patch');

    if (!reseed && !patchArg) usage();

    // A patch is copied into seed/patches/ only if generation then succeeds:
    // a malformed overlay left behind breaks EVERY later generation, including
    // the bootstrap path, until someone deletes it by hand.
    if (patchArg) {
        if (!fs.existsSync(patchArg)) {
            log.error(`Error: patch file not found: ${patchArg}`);
            process.exit(1);
        }
        const patchesDir = path.join(repoRoot, 'seed', 'patches');
        fs.mkdirSync(patchesDir, { recursive: true });
        const dest = path.join(patchesDir, path.basename(patchArg));
        const prior = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
        fs.copyFileSync(patchArg, dest);
        log.info(`Copied patch to ${dest}`);

        try {
            log.info('Regenerating seed/spectrum_plan.sql...');
            execSync('npx tsx scripts/generate-spectrum-seed.ts', { stdio: 'inherit', cwd: repoRoot });
        } catch {
            if (prior !== null) fs.writeFileSync(dest, prior);
            else fs.rmSync(dest, { force: true });
            log.error(`Seed generation failed — reverted ${dest}. seed/spectrum_plan.sql is unchanged.`);
            process.exit(1);
        }
    }

    if (reseed) {
        const seedPath = path.join(repoRoot, 'seed', 'spectrum_plan.sql');
        if (!fs.existsSync(seedPath)) {
            log.error(`Error: no seed at ${seedPath}. Run: npx tsx scripts/generate-spectrum-seed.ts`);
            process.exit(1);
        }
        const sql = fs.readFileSync(seedPath, 'utf-8');

        const dbPath = process.env.ACMA_DB_PATH ?? DEFAULT_CONFIG.dbPath;
        if (!fs.existsSync(dbPath)) {
            log.info(`Initialising new DB at ${dbPath}`);
        }
        initializeDatabase(dbPath);

        const db = new Database(dbPath);
        try {
            reseedFromSql(db, sql);
            const n = (db.prepare('SELECT COUNT(*) AS n FROM spectrum_allocations').get() as { n: number }).n;
            log.info(`[SPECTRUM] Reseeded: ${n} allocation rows loaded.`);
        } finally {
            db.close();
        }
    }
}

main();
