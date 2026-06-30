import {
  CONFIG_TABLES,
  checkConfigIntegrity,
  createConfigBackup,
  exportConfigToml,
  getConfigRecord,
  importConfigToml,
  migrateLegacyTomlConfig,
  putConfigRecord,
  queryConfigRecords,
  replaceConfigTable,
  restoreConfigBackup,
} from "./configDatabase";

const PROFILE_KEY = "app-config-profiles";
const ACTIVE_PROFILE_KEY = "app-config-active-profile";
const LEGACY_TOML_KEY = "app-config-toml";
const CONFIG_CACHE_KEY = "app-config-sqlite-cache";

export const DEFAULT_CONFIG = {
  refreshIntervalMs: 30000,
  enableRealtime: true,
  enablePricePolling: true,
  maxResults: 50,
  environment: "development",
};

let profilesCache = null;
let activeProfileCache = null;
let hydrationStarted = false;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canUseStorage() {
  return typeof localStorage !== "undefined";
}

function readJson(key, fallback) {
  if (!canUseStorage()) return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  if (!canUseStorage()) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore quota/private-mode failures; IndexedDB remains the primary store.
  }
}

function defaultProfile() {
  return { name: "default", config: getEnvironmentConfig() };
}

function normalizeProfile(profile) {
  return {
    name: String(profile?.name || "default"),
    config: { ...getEnvironmentConfig(), ...(profile?.config || profile?.data || {}) },
  };
}

function cacheProfiles(profiles) {
  profilesCache = profiles.length ? profiles.map(normalizeProfile) : [defaultProfile()];
  writeJson(CONFIG_CACHE_KEY, {
    profiles: profilesCache,
    activeProfileName: activeProfileCache || "default",
    cachedAt: new Date().toISOString(),
  });
  return profilesCache;
}

function readCachedProfiles() {
  if (profilesCache) return profilesCache;
  const cached = readJson(CONFIG_CACHE_KEY, null);
  if (cached?.profiles?.length) {
    activeProfileCache = cached.activeProfileName || "default";
    profilesCache = cached.profiles.map(normalizeProfile);
    return profilesCache;
  }
  const legacy = readJson(PROFILE_KEY, null);
  profilesCache = Array.isArray(legacy) && legacy.length ? legacy.map(normalizeProfile) : [defaultProfile()];
  activeProfileCache = canUseStorage() ? localStorage.getItem(ACTIVE_PROFILE_KEY) || "default" : "default";
  return profilesCache;
}

async function persistProfilesToDatabase(profiles) {
  await replaceConfigTable(
    CONFIG_TABLES.PROFILES,
    profiles.map((profile) => ({
      id: `${CONFIG_TABLES.PROFILES}:${profile.name}`,
      name: profile.name,
      type: "profile",
      data: profile.config,
    }))
  );
}

async function hydrateConfigFromDatabase() {
  const legacyProfiles = readJson(PROFILE_KEY, []);
  const legacyToml = canUseStorage() ? localStorage.getItem(LEGACY_TOML_KEY) : null;

  if (legacyToml) await migrateLegacyTomlConfig(legacyToml);
  if (Array.isArray(legacyProfiles) && legacyProfiles.length) {
    await persistProfilesToDatabase(legacyProfiles.map(normalizeProfile));
  }

  const dbProfiles = await queryConfigRecords({ table: CONFIG_TABLES.PROFILES });
  if (dbProfiles.length) {
    cacheProfiles(dbProfiles.map((record) => ({ name: record.name, config: record.data })));
  } else {
    await persistProfilesToDatabase(readCachedProfiles());
  }
}

function ensureHydrated() {
  if (hydrationStarted || typeof window === "undefined") return;
  hydrationStarted = true;
  hydrateConfigFromDatabase().catch(() => {
    hydrationStarted = false;
  });
}

export function getEnvironmentConfig() {
  const hostname = typeof window !== "undefined" ? window.location.hostname : "";
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";

  return {
    ...DEFAULT_CONFIG,
    environment: isLocal ? "development" : "production",
    refreshIntervalMs: isLocal ? 10000 : 30000,
  };
}

export function loadConfigProfiles() {
  const profiles = readCachedProfiles();
  ensureHydrated();
  return profiles;
}

export async function loadConfigProfilesAsync() {
  await hydrateConfigFromDatabase();
  return loadConfigProfiles();
}

export function saveConfigProfiles(profiles) {
  const next = cacheProfiles(profiles.map(normalizeProfile));
  persistProfilesToDatabase(next).catch(() => {});
  return next;
}

export async function saveConfigProfilesAsync(profiles) {
  const next = cacheProfiles(profiles.map(normalizeProfile));
  await persistProfilesToDatabase(next);
  return next;
}

export function getActiveProfileName() {
  if (activeProfileCache) return activeProfileCache;
  activeProfileCache = canUseStorage() ? localStorage.getItem(ACTIVE_PROFILE_KEY) || "default" : "default";
  ensureHydrated();
  return activeProfileCache;
}

export function setActiveProfileName(name) {
  activeProfileCache = String(name || "default");
  if (canUseStorage()) localStorage.setItem(ACTIVE_PROFILE_KEY, activeProfileCache);
  writeJson(CONFIG_CACHE_KEY, {
    profiles: readCachedProfiles(),
    activeProfileName: activeProfileCache,
    cachedAt: new Date().toISOString(),
  });
  return activeProfileCache;
}

export function upsertProfile(name, config) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) return loadConfigProfiles();

  const profiles = loadConfigProfiles();
  const withoutCurrent = profiles.filter((profile) => profile.name !== normalizedName);
  const next = [{ name: normalizedName, config: clone(config) }, ...withoutCurrent].slice(0, 20);
  saveConfigProfiles(next);
  return next;
}

export async function upsertProfileAsync(name, config) {
  const profiles = upsertProfile(name, config);
  await putConfigRecord(CONFIG_TABLES.PROFILES, {
    id: `${CONFIG_TABLES.PROFILES}:${name}`,
    name,
    type: "profile",
    data: config,
  });
  return profiles;
}

export function removeProfile(name) {
  const profiles = loadConfigProfiles().filter((profile) => profile.name !== name);
  const next = profiles.length ? profiles : [defaultProfile()];
  saveConfigProfiles(next);
  if (!next.some((profile) => profile.name === getActiveProfileName())) {
    setActiveProfileName(next[0].name);
  }
  return next;
}

export async function removeProfileAsync(name) {
  const next = removeProfile(name);
  await persistProfilesToDatabase(next);
  return next;
}

export async function saveWalletConfig(wallet) {
  return putConfigRecord(CONFIG_TABLES.WALLETS, wallet);
}

export async function saveNetworkConfig(network) {
  return putConfigRecord(CONFIG_TABLES.NETWORKS, network);
}

export async function saveTemplateConfig(template) {
  return putConfigRecord(CONFIG_TABLES.TEMPLATES, template);
}

export async function savePluginConfig(plugin) {
  return putConfigRecord(CONFIG_TABLES.PLUGINS, plugin);
}

export async function queryConfig(table, filters = {}) {
  return queryConfigRecords({ table, ...filters });
}

export async function getNamedConfig(table, name) {
  return getConfigRecord(table, name);
}

export async function importTomlConfig(tomlText, options) {
  const result = await importConfigToml(tomlText, options);
  const dbProfiles = await queryConfigRecords({ table: CONFIG_TABLES.PROFILES });
  if (dbProfiles.length) {
    cacheProfiles(dbProfiles.map((record) => ({ name: record.name, config: record.data })));
  }
  return result;
}

export async function exportTomlConfig() {
  return exportConfigToml();
}

export async function backupConfig(label) {
  return createConfigBackup(label);
}

export async function restoreConfig(backup) {
  await restoreConfigBackup(backup);
  const dbProfiles = await queryConfigRecords({ table: CONFIG_TABLES.PROFILES });
  cacheProfiles(dbProfiles.map((record) => ({ name: record.name, config: record.data })));
}

export async function checkConfigDatabaseIntegrity() {
  return checkConfigIntegrity();
}

export { CONFIG_TABLES };
