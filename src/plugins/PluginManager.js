import React from "react";
import {
  getActiveProfileName,
  getEnvironmentConfig,
  loadConfigProfiles,
  savePluginConfig,
} from "../lib/config";
import { useStore } from "../lib/store"; // Assuming useStore can return the store instance

const PLUGIN_STATUSES = Object.freeze({
  REGISTERED: "registered",
  INITIALIZED: "initialized",
  FAILED: "failed",
});

const SAFE_STATE_KEYS = Object.freeze([
  "network",
  "theme",
  "activeTab",
  "connectedAddress",
  "accountData",
  "transactions",
  "operations",
  "networkStats",
  "prices",
  "walletConnected",
  "walletType",
  "walletPublicKey",
  "streamStatus",
  "streamLedgers",
]);

const SAFE_ACTION_KEYS = Object.freeze([
  "setActiveTab",
  "setNetwork",
  "setConnectedAddress",
  "setSearchFilters",
  "addNotification",
  "removeNotification",
]);

function freezePlainObject(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freezePlainObject));

  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, freezePlainObject(entry)])
    )
  );
}

function pickSafeState(state) {
  return freezePlainObject(
    SAFE_STATE_KEYS.reduce((slice, key) => {
      if (state[key] !== undefined) slice[key] = state[key];
      return slice;
    }, {})
  );
}

function normalizePlugin(rawPlugin) {
  const plugin = rawPlugin?.default || rawPlugin;
  if (typeof plugin === "function") return plugin();
  return plugin;
}

function normalizeWidget(widget, pluginRecord, index) {
  if (!widget || typeof widget !== "object") return null;

  const Component = widget.component || widget.Component || widget.render;
  if (!Component) return null;

  return {
    id: String(widget.id || `${pluginRecord.id}:widget:${index}`),
    pluginId: pluginRecord.id,
    pluginName: pluginRecord.name,
    title: widget.title || widget.name || pluginRecord.name,
    placement: widget.placement || "settings",
    order: Number.isFinite(widget.order) ? widget.order : 100,
    props: widget.props || {},
    component: Component,
  };
}

function normalizeDataSource(dataSource, pluginRecord, index) {
  if (!dataSource || typeof dataSource !== "object") return null;
  return {
    id: String(dataSource.id || `${pluginRecord.id}:data-source:${index}`),
    pluginId: pluginRecord.id,
    pluginName: pluginRecord.name,
    name: dataSource.name || dataSource.id || `Data source ${index + 1}`,
    description: dataSource.description || "",
    fetch: typeof dataSource.fetch === "function" ? dataSource.fetch : null,
    subscribe: typeof dataSource.subscribe === "function" ? dataSource.subscribe : null,
    metadata: dataSource.metadata || {},
  };
}

function createFallbackPlugin(plugin, reason) {
  const id = String(plugin?.id || `invalid-plugin-${Date.now()}`);
  const name = String(plugin?.name || id);

  return {
    id,
    name,
    initialize: () => undefined,
    getWidgets: () => [
      {
        id: `${id}:fallback`,
        title: `${name} unavailable`,
        placement: "settings",
        order: 1000,
        component: function PluginFallbackWidget() {
          return React.createElement(
            "div",
            {
              style: {
                color: "var(--red)",
                fontSize: "12px",
                lineHeight: 1.5,
              },
            },
            reason
          );
        },
      },
    ],
    getDataSources: () => [],
  };
}

export class PluginManager {
  constructor({ store = useStore() } = {}) { // useStore() to get the actual store instance
    this.store = store;
    this.plugins = new Map();
    this.listeners = new Set();
    this.initializing = null;
  }

  createDashboardApi(pluginId) {
    const getCurrentState = () => pickSafeState(this.store.getState());

    const actions = SAFE_ACTION_KEYS.reduce((safeActions, key) => {
      const action = this.store.getState()[key];
      if (typeof action === "function") {
        safeActions[key] = (...args) => action(...args);
      }
      return safeActions;
    }, {});

    return Object.freeze({
      pluginId,
      version: "1.0.0",
      getState: getCurrentState,
      getConfig: () =>
        freezePlainObject({
          environment: getEnvironmentConfig(),
          activeProfileName: getActiveProfileName(),
          profiles: loadConfigProfiles(),
        }),
      actions: Object.freeze(actions),
      subscribe: (listener) => {
        if (typeof listener !== "function") return () => {};
        return this.store.subscribe((state) => listener(pickSafeState(state)));
      },
      logger: Object.freeze({
        info: (...args) => console.info(`[plugin:${pluginId}]`, ...args),
        warn: (...args) => console.warn(`[plugin:${pluginId}]`, ...args),
        error: (...args) => console.error(`[plugin:${pluginId}]`, ...args),
      }),
    });
  }

  register(rawPlugin) {
    const plugin = normalizePlugin(rawPlugin);
    const validationError = this.validate(plugin);
    const safePlugin = validationError ? createFallbackPlugin(plugin, validationError) : plugin;
    const id = String(safePlugin.id);

    if (this.plugins.has(id)) {
      throw new Error(`Plugin ID conflict: "${id}" is already registered.`);
    }

    const record = {
      id,
      name: String(safePlugin.name || id),
      plugin: safePlugin,
      status: PLUGIN_STATUSES.REGISTERED,
      error: validationError || null,
      initializedAt: null,
    };

    this.plugins.set(id, record);
    savePluginConfig({
      id,
      name: record.name,
      type: "plugin",
      data: {
        id,
        name: record.name,
        status: record.status,
        registeredAt: new Date().toISOString(),
      },
    }).catch(() => {});
    this.emitChange();
    return record;
  }

  validate(plugin) {
    if (!plugin || typeof plugin !== "object") return "Plugin export must be an object or factory.";
    if (!plugin.id || typeof plugin.id !== "string") return "Plugin is missing a string id.";
    if (!plugin.name || typeof plugin.name !== "string") return "Plugin is missing a string name.";
    if (plugin.initialize && typeof plugin.initialize !== "function") return "Plugin initialize hook must be a function.";
    if (plugin.getWidgets && typeof plugin.getWidgets !== "function") return "Plugin getWidgets hook must be a function.";
    if (plugin.getDataSources && typeof plugin.getDataSources !== "function") return "Plugin getDataSources hook must be a function.";
    return null;
  }

  async initializeAll() {
    if (this.initializing) return this.initializing;

    this.initializing = Promise.all(
      Array.from(this.plugins.values()).map(async (record) => {
        if (record.status === PLUGIN_STATUSES.INITIALIZED) return record;

        try {
          const api = this.createDashboardApi(record.id);
          if (typeof record.plugin.initialize === "function") {
            await record.plugin.initialize(api);
          }
          record.status = PLUGIN_STATUSES.INITIALIZED;
          record.initializedAt = new Date().toISOString();
        } catch (error) {
          record.status = PLUGIN_STATUSES.FAILED;
          record.error = error?.message || String(error);
        }
        this.emitChange();
        return record;
      })
    ).finally(() => {
      this.initializing = null;
    });

    return this.initializing;
  }

  getPluginRecords() {
    return Array.from(this.plugins.values()).map((record) => ({
      id: record.id,
      name: record.name,
      status: record.status,
      error: record.error,
      initializedAt: record.initializedAt,
    }));
  }

  getWidgets({ placement } = {}) {
    return Array.from(this.plugins.values())
      .flatMap((record) => {
        try {
          const widgets =
            typeof record.plugin.getWidgets === "function" ? record.plugin.getWidgets() : [];
          return widgets
            .map((widget, index) => normalizeWidget(widget, record, index))
            .filter(Boolean);
        } catch (error) {
          record.error = error?.message || String(error);
          record.status = PLUGIN_STATUSES.FAILED;
          return [];
        }
      })
      .filter((widget) => !placement || widget.placement === placement)
      .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  }

  getDataSources() {
    return Array.from(this.plugins.values()).flatMap((record) => {
      try {
        const dataSources =
          typeof record.plugin.getDataSources === "function" ? record.plugin.getDataSources() : [];
        return dataSources
          .map((dataSource, index) => normalizeDataSource(dataSource, record, index))
          .filter(Boolean);
      } catch (error) {
        record.error = error?.message || String(error);
        record.status = PLUGIN_STATUSES.FAILED;
        return [];
      }
    });
  }

  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitChange() {
    this.listeners.forEach((listener) => listener(this));
  }
}

export const pluginManager = new PluginManager();
export { PLUGIN_STATUSES };
