/**
 * 插件持久化封装。
 *
 * 面板经 `api.storage` 写入、后台模块经 `ctx.storage` 读取（两者是同一份数据），
 * 因此这里所有读取都直接落库，避免读到面板挂载时的旧缓存。
 *
 * 后台每秒都会「读状态 → 改 → 写回」（日志、统计、状态），并发时朴素读改写会
 * 互相覆盖（例如日志把刚写入的 detail 抹回旧值），所以这里所有读写都过一条串行队列。
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
  /** 串行队列：同一个键的读改写不会交叉，日志与状态不会互相覆盖。 */
  let chain = Promise.resolve();
  const serialize = (task) => {
    const next = chain.then(task, task);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const read = async (key, fallback) => {
    const value = await ctx.storage.getJson(key, fallback);
    return isObject(fallback) && isObject(value) ? { ...fallback, ...value } : value;
  };

  const config = () => read("config", DEFAULT_CONFIG);

  const readState = () => read("state", DEFAULT_STATE);
  const writeState = async (patch) => {
    const current = await readState();
    const next = {
      ...current,
      ...patch,
      stats: { ...current.stats, ...(patch.stats ?? {}) },
    };
    next.updatedAt = Date.now();
    await ctx.storage.setJson("state", next);
    return next;
  };

  const state = () => serialize(readState);
  const patchState = (patch) => serialize(() => writeState(patch));

  /** 追加一行运行日志（保留最近 40 条，供面板展示）。 */
  const log = (level, text) =>
    serialize(async () => {
      const current = await readState();
      const entry = { at: Date.now(), level, text: String(text).slice(0, 500) };
      return writeState({ logs: [...(current.logs ?? []), entry].slice(-40) });
    });

  const bindings = () => read("bindings", {});
  const saveBindings = (map) => serialize(() => ctx.storage.setJson("bindings", map ?? {}));

  const outbox = async () => {
    const value = await ctx.storage.getJson("outbox", []);
    return Array.isArray(value) ? value : [];
  };
  const saveOutbox = (list) => serialize(() => ctx.storage.setJson("outbox", list ?? []));
  const pushOutbox = (entry) =>
    serialize(async () => {
      const list = await outbox();
      await ctx.storage.setJson("outbox", [...list, entry].slice(-20));
    });

  const handoff = () => read("handoff", null);
  const clearHandoff = () => serialize(() => ctx.storage.remove("handoff"));

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
