import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

//#region src/store.ts
/** Monotonic on-disk schema version; a mismatch rebuilds the derived index. */
const SCHEMA_VERSION = 1;
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memories_recent ON memories (updated_at DESC, id DESC);
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(text, tags, content='memories', content_rowid='id');
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts (rowid, text, tags) VALUES (new.id, new.text, new.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
    INSERT INTO memories_fts (rowid, text, tags) VALUES (new.id, new.text, new.tags);
  END;
`;
/**
* Normalize a tag list to the lowercase, deduplicated, space-joined form the
* FTS index stores, so `Foo`, `foo`, and a repeated `foo` all match `foo`.
* @param tags - tags as supplied by the model or config.
* @returns the normalized space-joined list, empty when nothing survives.
*/
function normalizeTags(tags) {
	const seen = /* @__PURE__ */ new Set();
	for (const tag of tags) {
		const normalized = tag.trim().toLowerCase().replaceAll(/\s+/g, "-");
		if (normalized.length > 0) seen.add(normalized);
	}
	return [...seen].join(" ");
}
/**
* Compile a free-text query into an FTS5 MATCH expression. Every token is
* quoted, so FTS5 operators a model happens to type (`OR`, `*`, `-`, `"`) are
* matched literally instead of changing the query's meaning or raising a
* syntax error mid-tool-call.
* @param query - the raw query text.
* @returns the MATCH expression, or undefined when the query has no usable token.
*/
function compileMatch(query) {
	const tokens = query.split(/[^\p{L}\p{N}_]+/u).filter((token) => token.length > 0).map((token) => `"${token}"`);
	return tokens.length > 0 ? tokens.join(" ") : void 0;
}
/** Map one row to the record shape, converting SQLite's integer boolean. */
function toRecord(row) {
	return {
		id: row.id,
		text: row.text,
		tags: row.tags,
		pinned: row.pinned !== 0,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}
/**
* The durable memory store. One instance owns one SQLite connection; `close()`
* is idempotent and runs from the plugin's disposer.
*/
var MemoryStore = class {
	#db;
	#closed = false;
	/**
	* Open (creating if absent) the store at `path`, applying the schema.
	* @param path - database file path, or `:memory:` for an ephemeral store.
	*/
	constructor(path) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.#db = new DatabaseSync(path);
		this.#db.exec("PRAGMA journal_mode = WAL");
		this.#db.exec("PRAGMA foreign_keys = ON");
		this.#db.exec(SCHEMA);
		this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	}
	/**
	* Store one memory.
	* @param text - the fact to remember.
	* @param tags - normalized tag list.
	* @param pinned - whether it always renders in the prompt section.
	* @returns the new record.
	*/
	write(text, tags, pinned) {
		const now = Date.now();
		return toRecord(this.#db.prepare("INSERT INTO memories (text, tags, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING *").get(text, tags, pinned ? 1 : 0, now, now));
	}
	/**
	* Full-text search over memory text and tags, best match first.
	* @param query - free-text query; FTS operators in it are matched literally.
	* @param limit - maximum hits to return.
	* @returns the ranked matches, empty when the query has no usable token.
	*/
	search(query, limit) {
		const match = compileMatch(query);
		if (match === void 0) return [];
		return this.#db.prepare(`
      SELECT m.*, memories_fts.rank AS rank
      FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
      WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?
    `).all(match, limit).map((row) => ({
			...toRecord(row),
			rank: row.rank ?? 0
		}));
	}
	/**
	* The memories the prompt section renders: pinned first, then most recently
	* updated, with no record repeated.
	* @param recentCount - how many unpinned recent memories to include.
	* @returns pinned records followed by recent ones.
	*/
	forPrompt(recentCount) {
		const pinned = this.#db.prepare("SELECT * FROM memories WHERE pinned = 1 ORDER BY updated_at DESC, id DESC").all();
		const recent = this.#db.prepare("SELECT * FROM memories WHERE pinned = 0 ORDER BY updated_at DESC, id DESC LIMIT ?").all(recentCount);
		return [...pinned, ...recent].map(toRecord);
	}
	/**
	* Delete one memory.
	* @param id - the record id.
	* @returns whether a record was deleted.
	*/
	forget(id) {
		return this.#db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
	}
	/**
	* Total stored memories.
	* @returns the row count.
	*/
	count() {
		return this.#db.prepare("SELECT COUNT(*) AS n FROM memories").get().n;
	}
	/** Close the connection; idempotent, so plugin disposal and tests may both call it. */
	close() {
		if (this.#closed) return;
		this.#closed = true;
		this.#db.close();
	}
};

//#endregion
//#region src/index.ts
const name = "memory";
const inject = ["tools", "systemPrompt"];
const Config = z.object({
	path: z.string().required(),
	promptRecentCount: z.number().default(10),
	promptMaxChars: z.number().default(2e3),
	maxTextChars: z.number().default(2e3),
	searchLimitDefault: z.number().default(10),
	searchLimitMax: z.number().default(50),
	promptOrder: z.number().default(50)
});
const WRITE_DESCRIPTION = "Remember one durable fact across sessions: a user preference, a project convention, a decision and its reason, or a hard-won detail about this codebase. Write one self-contained fact per call — it will be read back with no surrounding conversation. Do NOT store transient task state (use the todo list), secrets, or anything the repository already records.";
const SEARCH_DESCRIPTION = "Search stored memories by keyword. Pinned and recent memories already appear in your context, so search when you need something older or more specific than what you can already see.";
const FORGET_DESCRIPTION = "Delete one stored memory by id, for a fact that is now wrong or obsolete. Ids come from memory_search or memory_write.";
/**
* Render one memory as a prompt line.
* @param record - the memory to render.
* @returns a single line carrying the id, tags, and text.
*/
function promptLine(record) {
	const tags = record.tags.length > 0 ? ` [${record.tags}]` : "";
	return `- (#${record.id}${record.pinned ? ", pinned" : ""})${tags} ${record.text}`;
}
/**
* Render the prompt section body under a character budget. Pinned memories are
* emitted first, so a budget too small for everything keeps what the deployment
* explicitly marked as always-relevant.
* @param records - pinned records followed by recent ones.
* @param maxChars - the budget.
* @returns the section text, or an empty string when nothing fits or nothing is stored.
*/
function renderPrompt(records, maxChars) {
	if (records.length === 0) return "";
	const header = "Memories you previously stored (use memory_search for anything not listed):\n";
	const lines = [];
	let used = 76;
	let dropped = 0;
	for (const record of records) {
		const line = promptLine(record);
		if (used + line.length + 1 > maxChars) {
			dropped++;
			continue;
		}
		lines.push(line);
		used += line.length + 1;
	}
	if (lines.length === 0) return "";
	const tail = dropped > 0 ? `\n(${dropped} more memories not shown; use memory_search)` : "";
	return header + lines.join("\n") + tail;
}
/**
* Validate the bounds the schema cannot express, so an unusable configuration
* fails at plugin load rather than at the first tool call.
* @param config - the schema-validated config.
* @throws when a bound is not a positive integer, or the default search limit exceeds its cap.
*/
function validateConfig(config) {
	const bounds = [
		["promptRecentCount", config.promptRecentCount],
		["promptMaxChars", config.promptMaxChars],
		["maxTextChars", config.maxTextChars],
		["searchLimitDefault", config.searchLimitDefault],
		["searchLimitMax", config.searchLimitMax]
	];
	for (const [field, value] of bounds) if (!Number.isInteger(value) || value < 1) throw new Error(`memory: invalid ${field} ${value} — must be an integer >= 1`);
	if (config.searchLimitDefault > config.searchLimitMax) throw new Error(`memory: searchLimitDefault ${config.searchLimitDefault} exceeds searchLimitMax ${config.searchLimitMax}`);
	if (config.path.length === 0) throw new Error("memory: `path` must not be empty");
}
/**
* Open the store, register the three tools, and contribute the recall section.
* @param ctx - plugin context; the store, tools, and section are disposed with it.
* @param config - validated {@link Config}.
*/
function apply(ctx, config) {
	validateConfig(config);
	let store;
	ctx.effect(() => {
		store = new MemoryStore(config.path);
		return () => {
			store?.close();
			store = void 0;
		};
	});
	/**
	* The open store, or a loud failure. Reached only while the fiber is active,
	* so an absent store is a lifecycle bug rather than an expected state.
	* @returns the live store.
	*/
	function open() {
		if (!store) throw new Error("memory: store is not open");
		return store;
	}
	ctx.systemPrompt.section({
		name: "memory:recall",
		order: config.promptOrder,
		text: () => renderPrompt(open().forPrompt(config.promptRecentCount), config.promptMaxChars)
	});
	ctx.tools.register(defineTool({
		name: "memory_write",
		description: WRITE_DESCRIPTION,
		parameters: {
			text: {
				type: "string",
				required: true,
				description: "The self-contained fact to remember."
			},
			tags: {
				type: "array",
				description: "Optional labels for later retrieval, e.g. [\"preference\", \"build\"].",
				items: { type: "string" }
			},
			pinned: {
				type: "boolean",
				description: "Always show this memory in context. Reserve it for facts that matter in every session."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "integer",
						required: true
					},
					tags: {
						type: "string",
						required: true
					},
					pinned: {
						type: "boolean",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Stored memory #${value.id}${value.pinned ? " (pinned)" : ""}.`
			}]
		},
		presentCall: (args) => ({
			card: "generic",
			title: "memory_write",
			kind: "edit",
			rawInput: args
		}),
		async execute(args) {
			const text = args.text.trim();
			if (text.length === 0) throw new Error("memory_write: `text` must not be blank");
			if (text.length > config.maxTextChars) throw new Error(`memory_write: \`text\` is ${text.length} chars, over the ${config.maxTextChars} limit`);
			const record = open().write(text, normalizeTags(args.tags ?? []), args.pinned ?? false);
			return {
				id: record.id,
				tags: record.tags,
				pinned: record.pinned
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "memory_search",
		description: SEARCH_DESCRIPTION,
		parameters: {
			query: {
				type: "string",
				required: true,
				description: "Keywords to look for in memory text and tags."
			},
			limit: {
				type: "number",
				description: `Maximum results. Defaults to ${config.searchLimitDefault}.`
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { matches: {
					type: "array",
					required: true,
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							id: {
								type: "integer",
								required: true
							},
							text: {
								type: "string",
								required: true
							},
							tags: {
								type: "string",
								required: true
							},
							pinned: {
								type: "boolean",
								required: true
							}
						}
					}
				} }
			},
			render: (args, value) => [{
				type: "text",
				text: value.matches.length === 0 ? `No memories match ${JSON.stringify(args.query)}.` : value.matches.map((match) => promptLine({
					...match,
					createdAt: 0,
					updatedAt: 0
				})).join("\n")
			}],
			presentationMeta: (_args, value) => ({ count: value.matches.length })
		},
		presentCall: (args) => ({
			card: "generic",
			title: `memory_search ${args.query}`,
			kind: "search"
		}),
		async execute(args) {
			const requested = args.limit ?? config.searchLimitDefault;
			if (!Number.isInteger(requested) || requested < 1) throw new Error(`memory_search: \`limit\` must be an integer >= 1 (got ${requested})`);
			return { matches: open().search(args.query, Math.min(requested, config.searchLimitMax)).map(({ id, text, tags, pinned }) => ({
				id,
				text,
				tags,
				pinned
			})) };
		}
	}));
	ctx.tools.register(defineTool({
		name: "memory_forget",
		description: FORGET_DESCRIPTION,
		parameters: { id: {
			type: "integer",
			required: true,
			description: "The memory id to delete."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "integer",
						required: true
					},
					forgotten: {
						type: "boolean",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.forgotten ? `Forgot memory #${value.id}.` : `No memory #${value.id} to forget.`
			}]
		},
		async execute(args) {
			return {
				id: args.id,
				forgotten: open().forget(args.id)
			};
		}
	}));
}

//#endregion
export { Config, apply, inject, name };