/**
 * 常驻后台模块：随应用启动（窗口关闭后仍在主进程运行），维护飞书长连接、
 * 配置热更新与消息路由。
 *
 * 与面板的分工：面板负责界面与配置（写入插件存储），本模块负责一切网络、
 * 密钥与路由。App Secret 由面板写入一次性交接键，本模块发现后立即写入
 * `ctx.secrets`（Electron safeStorage）并删除交接键，明文不在存储中留存。
 */

import { createConnection } from "./lib/connection.mjs";
import { createFeishuApi } from "./lib/feishu.mjs";
import { createRouter } from "./lib/router.mjs";
import { createStore } from "./lib/store.mjs";

const SECRET_NAME = "feishu-app-secret";
const LOOP_INTERVAL_MS = 1000;
const DOMAIN = "https://open.feishu.cn";

const describe = (error) => (error instanceof Error ? error.message : String(error));

export async function start(ctx) {
  const store = createStore(ctx);
  const log = (message) => {
    ctx.log(message);
    void store.log("info", message);
  };

  let credentials = null;
  let secretCache = null;
  let lastKey = "";

  const readSecret = async (force = false) => {
    if (!force && secretCache !== null) {
      return secretCache;
    }
    try {
      secretCache = (await ctx.secrets.get(SECRET_NAME)) ?? "";
    } catch (error) {
      log(`读取系统安全存储失败：${describe(error)}`);
      secretCache = "";
    }
    return secretCache;
  };

  const api = createFeishuApi({
    fetch: ctx.net.fetch,
    log: (message) => log(`[飞书接口] ${message}`),
    domain: DOMAIN,
  });

  const router = createRouter({
    ctx,
    store,
    api,
    log,
    credentials: () => credentials,
  });

  const connection = createConnection({
    ws: ctx.ws,
    fetch: ctx.net.fetch,
    domain: DOMAIN,
    log,
    onEvent: (event) => router.handleEvent(event),
    onStatus: ({ status, detail }) => {
      void store.patchState({
        status,
        detail,
        ...(status === "online" ? { connectedAt: Date.now() } : {}),
      });
    },
  });

  const sync = async () => {
    const handoff = await store.handoff();
    if (handoff?.appSecret || handoff?.clear) {
      try {
        if (handoff.clear) {
          await ctx.secrets.remove(SECRET_NAME);
          await readSecret(true);
          await store.log("info", "App Secret 已从系统安全存储清除");
        } else {
          await ctx.secrets.set(SECRET_NAME, String(handoff.appSecret));
          await readSecret(true);
          await store.log("info", "App Secret 已写入系统安全存储");
        }
      } catch (error) {
        await store.log("error", `更新 App Secret 失败：${describe(error)}`);
      }
      await store.clearHandoff();
    }

    const config = await store.config();
    const secret = await readSecret();
    const key = JSON.stringify([
      config.enabled,
      config.appId,
      Boolean(secret),
      config.allowAllDirect,
      config.allowOpenIds ?? [],
      config.ignoredOpenIds ?? [],
    ]);
    if (key === lastKey) {
      return;
    }
    lastKey = key;

    credentials =
      config.enabled && config.appId && secret
        ? { appId: config.appId, appSecret: secret }
        : null;

    const state = await store.state();
    const pendingUsers = (state.pendingUsers ?? []).filter(
      (item) =>
        !config.allowAllDirect &&
        !(config.allowOpenIds ?? []).includes(item.openId) &&
        !(config.ignoredOpenIds ?? []).includes(item.openId),
    );
    await store.patchState({
      hasSecret: Boolean(secret),
      appId: config.appId,
      pendingUsers,
      ...(config.enabled ? {} : { status: "idle", detail: "插件已停用" }),
    });

    if (credentials) {
      await connection.start(credentials);
    } else {
      connection.stop();
      if (!config.enabled) {
        log("插件已停用，长连接不启动");
      } else if (!config.appId) {
        log("未填写 App ID，长连接不启动");
      } else if (!secret) {
        log("未保存 App Secret，长连接不启动");
      }
    }
  };

  let ticking = false;
  const stopTimer = ctx.every(LOOP_INTERVAL_MS, () => {
    if (ticking) {
      return;
    }
    ticking = true;
    void (async () => {
      await sync();
      await router.tick();
    })()
      .catch((error) => {
        log(`后台循环失败：${describe(error)}`);
      })
      .finally(() => {
        ticking = false;
      });
  });

  const abort = () => {
    stopTimer();
    router.reset();
    connection.stop();
  };
  ctx.signal?.addEventListener("abort", abort, { once: true });

  await sync();
  log("飞书连接后台模块已启动");

  return () => {
    ctx.signal?.removeEventListener("abort", abort);
    abort();
  };
}
