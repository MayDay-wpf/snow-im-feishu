/**
 * 常驻后台模块：随应用启动（窗口关闭后仍在主进程运行），维护飞书长连接、
 * 配置热更新与消息路由。
 *
 * 与面板的分工：面板负责界面与配置（写入插件存储），本模块负责一切网络、
 * 密钥与路由。App Secret 由面板写入一次性交接键，本模块发现后立即写入
 * `ctx.secrets`（Electron safeStorage）并删除交接键，明文不在存储中留存。
 */

import { createHash } from "node:crypto";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SECRET_NAME = "feishu-app-secret";
const LOOP_INTERVAL_MS = 1000;
const DOMAIN = "https://open.feishu.cn";
const CACHE_ROOT = join(tmpdir(), "snow-im-feishu-lib");

const describe = (error) => (error instanceof Error ? error.message : String(error));

const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * 计算 lib/ 的内容指纹（名称 + 大小 + mtime）。
 *
 * 后台入口每次启动都会被重新读取，但它 import 的 `lib/*.mjs` 会被主进程的 ESM
 * 缓存复用：只重装插件（不彻底退出应用）时，改过的 lib 不会生效，很容易被误认为
 * 「改动没起作用」。这里把 lib 拷到按指纹命名的临时目录后再导入，URL 一变就是新
 * 模块，因此重装即可生效，不需要重启应用。
 */
const fingerprint = async (dir) => {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".mjs")).sort();
  const hash = createHash("sha1");
  for (const name of names) {
    const info = await stat(join(dir, name));
    hash.update(`${name}:${info.size}:${info.mtimeMs}`);
  }
  return hash.digest("hex").slice(0, 16);
};

const loadLibs = async (ctx) => {
  const fallback = async () => ({
    store: await import("./lib/store.mjs"),
    feishu: await import("./lib/feishu.mjs"),
    connection: await import("./lib/connection.mjs"),
    router: await import("./lib/router.mjs"),
  });

  if (!ctx.installPath) {
    return fallback();
  }
  try {
    const source = join(ctx.installPath, "lib");
    const key = await fingerprint(source);
    const target = join(CACHE_ROOT, key, "lib");
    if (!(await exists(join(target, "router.mjs")))) {
      await mkdir(join(CACHE_ROOT, key), { recursive: true });
      await cp(source, target, { recursive: true, force: true });
      // 只保留当前这份拷贝，避免临时目录里堆历史版本。
      for (const name of await readdir(CACHE_ROOT)) {
        if (name !== key) {
          await rm(join(CACHE_ROOT, name), { recursive: true, force: true }).catch(() => {});
        }
      }
    }
    const load = (name) => import(pathToFileURL(join(target, name)).href);
    const [store, feishu, connection, router] = await Promise.all([
      load("store.mjs"),
      load("feishu.mjs"),
      load("connection.mjs"),
      load("router.mjs"),
    ]);
    return { store, feishu, connection, router };
  } catch (error) {
    ctx.log(`版本化加载 lib 失败，回退直接导入：${describe(error)}`);
    return fallback();
  }
};

export async function start(ctx) {
  const libs = await loadLibs(ctx);
  const { createStore } = libs.store;
  const { createFeishuApi } = libs.feishu;
  const { createConnection } = libs.connection;
  const { createRouter } = libs.router;

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
