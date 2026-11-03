/**
 * 插件持久化封装。
 *
 * 面板经 `api.storage` 写入、后台模块经 `ctx.storage` 读取（两者是同一份数据），
 * 因此这里所有读取都直接落库，避免读到面板挂载时的旧缓存。
 */

export const DEFAULT_CONFIG = {
  appId: "",
  enabled: true,
  directoryId: "",
  apiProfile: "",
  groupRequireMention: true,
  allowAllDirect: false,
  allowOpenIds: [],
  pushMode: "stream",
  followActive: true,
  forwardApprovals: true,
  maxAttachmentMb: 20,
};

export const DEFAULT_STATE = {
  status: "idle",
  detail: "",
  hasSecret: false,
  connectedAt: 0,
  lastEventAt: 0,
  updatedAt: 0,
  stats: { received: 0, receivedDirect: 0, receivedGroup: 0, delivered: 0, denied: 0, errors: 0 },
  pendingUsers: [],
  logs: [],
};

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const createStore = (ctx) => {
  const read = async (key, fallback) => {
    const value = await ctx.storage.getJson(key, fallback);
    return isObject(fallback) && isObject(value) ? { ...fallback, ...value } : value;
  };

  const config = () => read("config", DEFAULT_CONFIG);

  const state = () => read("state", DEFAULT_STATE);
  const patchState = async (patch) => {
    const current = await state();
    const next = {
      ...current,
      ...patch,
      stats: { ...current.stats, ...(patch.stats ?? {}) },
    };
    next.updatedAt = Date.now();
    await ctx.storage.setJson("state", next);
    return next;
  };

  /** 追加一行运行日志（保留最近 40 条，供面板展示）。 */
  const log = async (level, text) => {
    const current = await state();
    const entry = { at: Date.now(), level, text: String(text).slice(0, 500) };
    const logs = [...(current.logs ?? []), entry].slice(-40);
    await patchState({ logs });
  };

  const bindings = () => read("bindings", {});
  const saveBindings = (map) => ctx.storage.setJson("bindings", map ?? {});

  const outbox = async () => {
    const value = await ctx.storage.getJson("outbox", []);
    return Array.isArray(value) ? value : [];
  };
  const saveOutbox = (list) => ctx.storage.setJson("outbox", list ?? []);
  const pushOutbox = async (entry) => {
    const list = await outbox();
    await saveOutbox([...list, entry].slice(-20));
  };

  const handoff = () => read("handoff", null);
  const clearHandoff = () => ctx.storage.remove("handoff");

  return {
    config,
    state,
    patchState,
    log,
    bindings,
    saveBindings,
    outbox,
    saveOutbox,
    pushOutbox,
    handoff,
    clearHandoff,
  };
};
