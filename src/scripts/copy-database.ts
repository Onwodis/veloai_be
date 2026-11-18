/**
 * Copies every row of every table from one Postgres database to another that
 * already has the same schema (run the migrations on the target first:
 * `prisma migrate deploy` + `pnpm studio:migrate`). Used to move from the
 * Neon project in us-east-2 to the one in eu-central-1, and again for the
 * final sync just before the production switch.
 *
 *   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… pnpm db:copy            target must be empty
 *   SOURCE_DATABASE_URL=… TARGET_DATABASE_URL=… pnpm db:copy --replace  empties the target first
 *
 * Use DIRECT (unpooled) URLs. Rows are streamed with COPY (fast, exact types),
 * tables in foreign-key order (parents first); identity / serial counters are
 * moved past the copied ids; every table's row count is compared at the end.
 * The migration bookkeeping tables are not copied (the target's own runs fill
 * them). Stop writes to the source while it runs (stop the API / worker).
 */
import { pipeline } from 'node:stream/promises';
import postgres from 'postgres';

const SKIP = new Set(['_prisma_migrations', 'studio_migrations']);

function connect(url: string | undefined, name: string) {
  if (!url) throw new Error(`Set ${name} (a direct postgresql:// URL).`);
  return postgres(url, { max: 2, connect_timeout: 30, idle_timeout: 20, onnotice: () => undefined, connection: { statement_timeout: 0 } });
}

/** Tables in foreign-key order: every table after the tables it references. */
function order(tables: string[], edges: { child: string; parent: string }[]): string[] {
  const deps = new Map(tables.map((table) => [table, new Set<string>()]));
  for (const { child, parent } of edges) if (child !== parent && deps.has(child) && deps.has(parent)) deps.get(child)!.add(parent);
  const out: string[] = [];
  const left = new Set(tables);
  while (left.size) {
    const ready = [...left].filter((table) => [...deps.get(table)!].every((parent) => !left.has(parent)));
    if (ready.length === 0) {
      // A cycle (rare): copy the rest as they are; COPY checks each table's keys at its own end.
      console.warn(`foreign-key cycle among: ${[...left].join(', ')}`);
      out.push(...left);
      break;
    }
    for (const table of ready.sort()) {
      out.push(table);
      left.delete(table);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const replace = process.argv.includes('--replace');
  const source = connect(process.env['SOURCE_DATABASE_URL'], 'SOURCE_DATABASE_URL');
  const target = connect(process.env['TARGET_DATABASE_URL'], 'TARGET_DATABASE_URL');
  try {
    const host = (sql: postgres.Sql) => sql`SELECT inet_server_addr()::text AS ip, current_database() AS db, current_setting('server_version') AS v`.then(([row]) => row);
    console.log('source:', await host(source), '\ntarget:', await host(target));

    const listed = (sql: postgres.Sql) =>
      sql<{ name: string }[]>`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition`.then((rows) =>
        rows.map((row) => row.name).filter((name) => !SKIP.has(name)),
      );
    const [fromTables, toTables] = await Promise.all([listed(source), listed(target)]);
    const missing = fromTables.filter((table) => !toTables.includes(table));
    if (missing.length) throw new Error(`The target is missing tables (run its migrations first): ${missing.join(', ')}`);

    const edges = await source<{ child: string; parent: string }[]>`
      SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
      FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE c.contype = 'f' AND n.nspname = 'public'`;
    const strip = (name: string): string => name.replace(/^public\./, '').replace(/^"|"$/g, '');
    const tables = order(fromTables, edges.map((edge) => ({ child: strip(edge.child), parent: strip(edge.parent) })));

    const count = async (sql: postgres.Sql, table: string): Promise<number> => (await sql<{ n: string }[]>`SELECT count(*) AS n FROM ${sql(table)}`)[0]!.n as unknown as number;
    if (replace) {
      await target.unsafe(`TRUNCATE ${tables.map((table) => `"${table.replace(/"/g, '""')}"`).join(', ')} RESTART IDENTITY CASCADE`);
      console.log(`target emptied (${tables.length} tables)`);
    } else {
      const filled: string[] = [];
      for (const table of tables) if (Number(await count(target, table)) > 0) filled.push(table);
      if (filled.length) throw new Error(`The target already has rows in: ${filled.join(', ')}. Use --replace to empty it first.`);
    }

    let rowsTotal = 0;
    for (const [index, table] of tables.entries()) {
      // Generated columns are computed by the target itself.
      const columns = (
        await source<{ name: string }[]>`
          SELECT attname AS name FROM pg_attribute
          WHERE attrelid = ${`public."${table.replace(/"/g, '""')}"`}::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''
          ORDER BY attnum`
      ).map((row) => row.name);
      const started = Date.now();
      const reader = await source`COPY ${source(table)} (${source(columns)}) TO STDOUT`.readable();
      const writer = await target`COPY ${target(table)} (${target(columns)}) FROM STDIN`.writable();
      await pipeline(reader, writer);
      const rows = Number(await count(target, table));
      rowsTotal += rows;
      console.log(`[${String(index + 1).padStart(2)}/${tables.length}] ${table}: ${rows} rows (${Date.now() - started} ms)`);
    }

    // Serial / identity counters continue after the copied ids.
    const counters = await target<{ tbl: string; col: string; seq: string }[]>`
      SELECT c.relname AS tbl, a.attname AS col, pg_get_serial_sequence(format('public.%I', c.relname), a.attname) AS seq
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
        AND pg_get_serial_sequence(format('public.%I', c.relname), a.attname) IS NOT NULL`;
    for (const counter of counters) {
      await target.unsafe(`SELECT setval('${counter.seq.replace(/'/g, "''")}', COALESCE((SELECT max("${counter.col.replace(/"/g, '""')}") FROM "${counter.tbl.replace(/"/g, '""')}"), 0) + 1, false)`);
    }
    console.log(`counters moved on: ${counters.length}`);

    // Verify: the same number of rows on both sides, table by table.
    const mismatched: string[] = [];
    for (const table of tables) {
      const [a, b] = await Promise.all([count(source, table), count(target, table)]);
      if (Number(a) !== Number(b)) mismatched.push(`${table} (source ${a}, target ${b})`);
    }
    if (mismatched.length) throw new Error(`Row counts differ: ${mismatched.join('; ')}`);
    console.log(`done: ${tables.length} tables, ${rowsTotal} rows, every table's count matches.`);
  } finally {
    await Promise.all([source.end(), target.end()]);
  }
}

main().catch((error: unknown) => {
  console.error('copy failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
