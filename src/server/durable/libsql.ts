import type { SqliteDatabase, SqliteExecutor, SqliteValue } from "@earendil-works/chord/sqlite";
import { createClient, type Client, type InStatement, type ResultSet, type Transaction } from "@libsql/client";

/**
 * pi-durable's SQLite storage over libSQL (DURABLE-PI BRANCH).
 *
 * pi-durable's `SqliteStorage` runs on chord's tiny async `SqliteDatabase`
 * facade, not on a driver. This adapter implements that facade with
 * `@libsql/client`, so the SAME storage schema and code run:
 *   - hosted: against Turso (`libsql://<db>.turso.io` + auth token) — a free
 *     hosted SQLite reachable from serverless functions (Netlify/Vercel);
 *   - locally / in tests: against a plain file (`file:/path/x.sqlite`).
 * The local default stays Node's built-in `node:sqlite` (openNodeSqliteStorage);
 * this adapter exists so a serverless host has somewhere durable to write.
 *
 * Facade contract (chord/sqlite/database.d.ts): every call is async; inside
 * `transaction` all work uses the handle; unrelated operations and other
 * transactions QUEUE until it settles; a rejected callback rolls back and
 * rejects with the same error (a failed rollback rejects with an
 * AggregateError instead, so a caller can't mistake it for a clean rollback).
 */

type Executor = Pick<Client, "execute" | "executeMultiple"> | Pick<Transaction, "execute" | "executeMultiple">;

function toValue(value: unknown): SqliteValue {
	if (value === null || value === undefined) return null;
	if (typeof value === "number" || typeof value === "bigint" || typeof value === "string") return value;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	return String(value);
}

function rowsOf<T extends object>(result: ResultSet): T[] {
	const out: T[] = [];
	for (const row of result.rows) {
		const record: Record<string, SqliteValue> = {};
		result.columns.forEach((column, index) => {
			record[column] = toValue((row as unknown as unknown[])[index]);
		});
		out.push(record as T);
	}
	return out;
}

function statement(sql: string, params: SqliteValue[]): InStatement {
	return { sql, args: params as InStatement extends { args?: infer A } ? A : never };
}

function executor(target: Executor): SqliteExecutor {
	return {
		async exec(sql) {
			await target.executeMultiple(sql);
		},
		async run(sql, ...params) {
			await target.execute(statement(sql, params));
		},
		async runCounted(sql, ...params) {
			const result = await target.execute(statement(sql, params));
			return result.rowsAffected;
		},
		get: (async (sql: string, ...params: SqliteValue[]) => {
			const result = await target.execute(statement(sql, params));
			return rowsOf<object>(result)[0];
		}) as SqliteExecutor["get"],
		all: (async (sql: string, ...params: SqliteValue[]) => rowsOf<object>(await target.execute(statement(sql, params)))) as SqliteExecutor["all"],
	};
}

export class LibsqlDatabase implements SqliteDatabase {
	readonly #client: Client;
	readonly #direct: SqliteExecutor;
	/** The facade's queue: one operation or transaction at a time. */
	#tail: Promise<unknown> = Promise.resolve();
	#closed = false;

	constructor(client: Client) {
		this.#client = client;
		this.#direct = executor(client);
	}

	static open(url: string, authToken?: string): LibsqlDatabase {
		return new LibsqlDatabase(createClient({ url, ...(authToken ? { authToken } : {}), intMode: "number" }));
	}

	#queue<T>(operation: () => Promise<T>): Promise<T> {
		if (this.#closed) return Promise.reject(new Error("LibsqlDatabase is closed"));
		const run = this.#tail.then(operation, operation);
		this.#tail = run.catch(() => undefined);
		return run;
	}

	exec(sql: string) { return this.#queue(() => this.#direct.exec(sql)); }
	run(sql: string, ...params: SqliteValue[]) { return this.#queue(() => this.#direct.run(sql, ...params)); }
	runCounted(sql: string, ...params: SqliteValue[]) { return this.#queue(() => this.#direct.runCounted(sql, ...params)); }
	get<T extends object>(sql: string, ...params: SqliteValue[]) { return this.#queue(() => this.#direct.get<T>(sql, ...params)); }
	all<T extends object>(sql: string, ...params: SqliteValue[]) { return this.#queue(() => this.#direct.all<T>(sql, ...params)); }

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.#queue(async () => {
			const tx = await this.#client.transaction("write");
			let live = true;
			const inner = executor(tx);
			const guarded: SqliteExecutor = {
				exec: (sql) => (live ? inner.exec(sql) : Promise.reject(new Error("transaction handle used after settle"))),
				run: (sql, ...p) => (live ? inner.run(sql, ...p) : Promise.reject(new Error("transaction handle used after settle"))),
				runCounted: (sql, ...p) => (live ? inner.runCounted(sql, ...p) : Promise.reject(new Error("transaction handle used after settle"))),
				get: (sql, ...p) => (live ? inner.get(sql, ...p) : Promise.reject(new Error("transaction handle used after settle"))),
				all: (sql, ...p) => (live ? inner.all(sql, ...p) : Promise.reject(new Error("transaction handle used after settle"))),
			};
			let result: T;
			try {
				result = await callback(guarded);
			} catch (error) {
				live = false;
				try {
					await tx.rollback();
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "transaction failed and its rollback failed");
				} finally {
					tx.close();
				}
				throw error;
			}
			live = false;
			try {
				await tx.commit();
			} finally {
				tx.close();
			}
			return result;
		});
	}

	async close(): Promise<void> {
		await this.#queue(async () => undefined);
		this.#closed = true;
		this.#client.close();
	}
}
