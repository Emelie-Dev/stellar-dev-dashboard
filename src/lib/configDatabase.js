const CONFIG_DB_NAME = "stellar-dev-dashboard-config";
const CONFIG_DB_VERSION = 1;
const RECORD_STORE = "config_records";
const META_STORE = "config_meta";
const SNAPSHOT_STORE = "config_backups";
const TOML_IMPORT_KEY = "stellar-config-toml";

export const CONFIG_SCHEMA_VERSION = 1;

export const CONFIG_TABLES = Object.freeze({
  WALLETS: "wallets",
  NETWORKS: "networks",
  TEMPLATES: "templates",
  PLUGINS: "plugins",
  PROFILES: "profiles",
});

const TABLES = new Set(Object.values(CONFIG_TABLES));

let dbPromise = null;

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeTable(table) {
  const normalized = String(table || "").trim();
  if (!TABLES.has(normalized)) throw new Error(`Unknown config table: ${table}`);
  return normalized;
}

function normalizeRecord(table, input) {
  const normalizedTable = normalizeTable(table);
  const name = String(input?.name || input?.id || "").trim();
  if (!name) throw new Error("Config record name is required");

  const id = String(input?.id || `${normalizedTable}:${name}`);
  const createdAt = input?.createdAt || nowIso();

  return {
    id,
    table: normalizedTable,
    name,
    type: input?.type || normalizedTable.slice(0, -1) || "config",
    category: input?.category || null,
    network: input?.network || input?.data?.network || null,
    data: clone(input?.data ?? input?.config ?? input ?? {}),
    createdAt,
    updatedAt: nowIso(),
  };
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Transaction aborted"));
  });
}

export function openConfigDatabase() {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is not available"));
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(CONFIG_DB_NAME, CONFIG_DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Config database upgrade blocked"));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(RECORD_STORE)) {
        const records = db.createObjectStore(RECORD_STORE, { keyPath: "id" });
        records.createIndex("table", "table", { unique: false });
        records.createIndex("table_name", ["table", "name"], { unique: false });
        records.createIndex("table_network", ["table", "network"], { unique: false });
        records.createIndex("table_category", ["table", "category"], { unique: false });
        records.createIndex("updatedAt", "updatedAt", { unique: false });
      }

      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }

      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        const snapshots = db.createObjectStore(SNAPSHOT_STORE, { keyPath: "id" });
        snapshots.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
  });

  return dbPromise;
}

async function withStore(storeName, mode, fn) {
  const db = await openConfigDatabase();
  const transaction = db.transaction(storeName, mode);
  const store = transaction.objectStore(storeName);
  const done = transactionDone(transaction);
  const result = await fn(store, transaction);
  await done;
  return result;
}

async function getAllFromIndex(index, query) {
  return requestToPromise(query === undefined ? index.getAll() : index.getAll(query));
}

export async function migrateConfigDatabase() {
  await openConfigDatabase();
  await withStore(META_STORE, "readwrite", async (store) => {
    store.put({ key: "schemaVersion", value: CONFIG_SCHEMA_VERSION, updatedAt: nowIso() });
  });
}

export async function putConfigRecord(table, record) {
  await migrateConfigDatabase();
  const normalized = normalizeRecord(table, record);
  await withStore(RECORD_STORE, "readwrite", async (store) => {
    store.put(normalized);
  });
  return normalized;
}

export async function putConfigRecords(table, records) {
  await migrateConfigDatabase();
  const normalized = records.map((record) => normalizeRecord(table, record));
  await withStore(RECORD_STORE, "readwrite", async (store) => {
    normalized.forEach((record) => store.put(record));
  });
  return normalized;
}

export async function deleteConfigRecord(table, idOrName) {
  const records = await queryConfigRecords({ table, name: idOrName });
  const ids = records.length ? records.map((record) => record.id) : [`${table}:${idOrName}`];
  await withStore(RECORD_STORE, "readwrite", async (store) => {
    ids.forEach((id) => store.delete(id));
  });
}

export async function queryConfigRecords({ table, name, network, category, limit } = {}) {
  await migrateConfigDatabase();
  const normalizedTable = table ? normalizeTable(table) : null;

  return withStore(RECORD_STORE, "readonly", async (store) => {
    let records;
    if (normalizedTable && name) {
      records = await getAllFromIndex(store.index("table_name"), IDBKeyRange.only([normalizedTable, name]));
    } else if (normalizedTable && network !== undefined) {
      records = await getAllFromIndex(store.index("table_network"), IDBKeyRange.only([normalizedTable, network]));
    } else if (normalizedTable && category !== undefined) {
      records = await getAllFromIndex(store.index("table_category"), IDBKeyRange.only([normalizedTable, category]));
    } else if (normalizedTable) {
      records = await getAllFromIndex(store.index("table"), IDBKeyRange.only(normalizedTable));
    } else {
      records = await requestToPromise(store.getAll());
    }

    return records
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, limit || records.length);
  });
}

export async function getConfigRecord(table, name) {
  const records = await queryConfigRecords({ table, name, limit: 1 });
  return records[0] || null;
}

export async function replaceConfigTable(table, records) {
  const normalizedTable = normalizeTable(table);
  await migrateConfigDatabase();
  await withStore(RECORD_STORE, "readwrite", async (store) => {
    const existing = await getAllFromIndex(store.index("table"), IDBKeyRange.only(normalizedTable));
    existing.forEach((record) => store.delete(record.id));
    records.map((record) => normalizeRecord(normalizedTable, record)).forEach((record) => store.put(record));
  });
}

export async function createConfigBackup(label = "manual") {
  const [records, meta] = await Promise.all([
    queryConfigRecords(),
    withStore(META_STORE, "readonly", async (store) => requestToPromise(store.getAll())),
  ]);
  const snapshot = {
    id: `backup-${Date.now()}`,
    label,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    records,
    meta,
    createdAt: nowIso(),
  };

  await withStore(SNAPSHOT_STORE, "readwrite", async (store) => {
    store.put(snapshot);
  });
  return snapshot;
}

export async function restoreConfigBackup(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.records)) {
    throw new Error("Invalid config backup payload");
  }

  await migrateConfigDatabase();
  await withStore(RECORD_STORE, "readwrite", async (store) => {
    const existing = await requestToPromise(store.getAll());
    existing.forEach((record) => store.delete(record.id));
    snapshot.records.forEach((record) => store.put(normalizeRecord(record.table, record)));
  });

  await withStore(META_STORE, "readwrite", async (store) => {
    store.put({ key: "restoredAt", value: nowIso(), updatedAt: nowIso() });
  });
}

export async function checkConfigIntegrity() {
  const records = await queryConfigRecords();
  const errors = [];
  const seen = new Set();

  records.forEach((record) => {
    if (!record.id) errors.push("Record is missing id");
    if (!TABLES.has(record.table)) errors.push(`${record.id} has invalid table ${record.table}`);
    if (!record.name) errors.push(`${record.id} is missing name`);
    if (seen.has(record.id)) errors.push(`${record.id} is duplicated`);
    seen.add(record.id);
    if (!record.data || typeof record.data !== "object" || Array.isArray(record.data)) {
      errors.push(`${record.id} has invalid data payload`);
    }
  });

  return {
    ok: errors.length === 0,
    errors,
    recordCount: records.length,
    checkedAt: nowIso(),
  };
}

function parseTomlValue(rawValue) {
  const value = String(rawValue || "").trim();
  if (/^".*"$/.test(value)) return value.slice(1, -1).replace(/\\"/g, '"');
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (/^\[.*\]$/.test(value)) {
    return value
      .slice(1, -1)
      .split(",")
      .map((entry) => parseTomlValue(entry.trim()))
      .filter((entry) => entry !== "");
  }
  return value;
}

export function parseConfigToml(tomlText) {
  const root = {};
  let current = root;

  String(tomlText || "")
    .split(/\r?\n/)
    .forEach((line) => {
      const trimmed = line.replace(/#.*/, "").trim();
      if (!trimmed) return;

      const section = trimmed.match(/^\[([^\]]+)\]$/);
      if (section) {
        current = section[1].split(".").reduce((target, key) => {
          if (!target[key] || typeof target[key] !== "object") target[key] = {};
          return target[key];
        }, root);
        return;
      }

      const pair = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
      if (pair) current[pair[1]] = parseTomlValue(pair[2]);
    });

  return root;
}

function toTomlValue(value) {
  if (typeof value === "string") return `"${value.replace(/"/g, '\\"')}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(toTomlValue).join(", ")}]`;
  return `"${JSON.stringify(value).replace(/"/g, '\\"')}"`;
}

function appendTomlSection(lines, path, value) {
  const scalars = Object.entries(value).filter(([, entry]) => !entry || typeof entry !== "object" || Array.isArray(entry));
  const objects = Object.entries(value).filter(([, entry]) => entry && typeof entry === "object" && !Array.isArray(entry));

  if (path) {
    lines.push(`[${path}]`);
    scalars.forEach(([key, entry]) => lines.push(`${key} = ${toTomlValue(entry)}`));
    lines.push("");
  }

  objects.forEach(([key, entry]) => appendTomlSection(lines, path ? `${path}.${key}` : key, entry));
}

export function stringifyConfigToml(payload) {
  const lines = [];
  appendTomlSection(lines, "", payload);
  return lines.join("\n").trim() + "\n";
}

export async function importConfigToml(tomlText, { mode = "merge" } = {}) {
  const parsed = parseConfigToml(tomlText);
  const imported = [];

  for (const [table, entries] of Object.entries(parsed)) {
    if (!TABLES.has(table) || !entries || typeof entries !== "object") continue;
    if (mode === "replace") await replaceConfigTable(table, []);

    for (const [name, data] of Object.entries(entries)) {
      imported.push(await putConfigRecord(table, { name, data }));
    }
  }

  await withStore(META_STORE, "readwrite", async (store) => {
    store.put({ key: TOML_IMPORT_KEY, value: nowIso(), updatedAt: nowIso() });
  });

  return { imported: imported.length, records: imported };
}

export async function exportConfigToml() {
  const records = await queryConfigRecords();
  const payload = {};

  records.forEach((record) => {
    if (!payload[record.table]) payload[record.table] = {};
    payload[record.table][record.name] = record.data;
  });

  return stringifyConfigToml(payload);
}

export async function migrateLegacyTomlConfig(tomlText) {
  if (!tomlText) return { imported: 0, records: [] };
  return importConfigToml(tomlText, { mode: "merge" });
}
