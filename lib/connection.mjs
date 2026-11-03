/**
 * 飞书事件长连接。
 *
 * 两段式建连：先 POST /callback/ws/endpoint 用 App ID / App Secret 换一个一次性的
 * wss 地址与客户端配置，再连上去收发 protobuf 二进制帧。每次重连都必须重新引导
 * （旧地址会静默失效）。
 *
 * 帧处理与官方 SDK（oapi-sdk-go ws 包）对齐：
 * - 控制帧（method 0）：type=pong 时可携带新的 ClientConfig（心跳间隔等）；
 * - 数据帧（method 1）：type=event 时把 payload 交给上层，并按原帧回一份
 *   `{"code":200}` 回执（处理抛错回 500，平台会重推）；分片（sum>1）按
 *   message_id + seq 重组；card 等其它类型不做响应。
 */

import { decodeFrame, encodeFrame, readHeader } from "./proto.mjs";

const ENDPOINT_PATH = "/callback/ws/endpoint";
const DEFAULT_PING_INTERVAL_MS = 120000;
const MIN_RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 60000;
const PONG_GRACE_MS = 5000;
const FRAGMENT_TTL_MS = 5000;
const WATCHDOG_INTERVAL_MS = 5000;

const describe = (error) => (error instanceof Error ? error.message : String(error));

export const createConnection = ({ ws, fetch, domain, log = () => {}, onEvent, onStatus }) => {
  let link = null;
  let credentials = null;
  let running = false;
  let pingTimer = null;
  let watchdogTimer = null;
  let reconnectTimer = null;
  let pingIntervalMs = DEFAULT_PING_INTERVAL_MS;
  let reconnectNonce = 30;
  let serviceId = 0;
  let attempt = 0;
  let lastInboundAt = 0;
  let generation = 0;
  let status = "idle";
  let statusDetail = "";
  const fragments = new Map();

  const setStatus = (next, detail = "") => {
    status = next;
    statusDetail = detail;
    onStatus?.({ status: next, detail });
  };

  const clearTimers = () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const applyConfig = (config) => {
    const ping = Number(config?.PingInterval ?? 0);
    if (Number.isFinite(ping) && ping > 0) {
      pingIntervalMs = Math.max(10, ping) * 1000;
    }
    const nonce = Number(config?.ReconnectNonce ?? 0);
    if (Number.isFinite(nonce) && nonce > 0) {
      reconnectNonce = nonce;
    }
  };

  const bootstrap = async () => {
    const response = await fetch(`${domain}${ENDPOINT_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", locale: "zh" },
      body: JSON.stringify({
        AppID: credentials.appId,
        AppSecret: credentials.appSecret,
      }),
      timeoutMs: 20000,
    });
    if (response?.error) {
      throw new Error(`长连接引导失败：${response.error}`);
    }
    let parsed = null;
    try {
      parsed = JSON.parse(response?.body || "null");
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.code !== 0 || !parsed?.data?.URL) {
      throw new Error(
        `长连接引导失败：${parsed?.msg || `HTTP ${response?.status ?? 0}`}`,
      );
    }
    return { url: String(parsed.data.URL), config: parsed.data.ClientConfig ?? {} };
  };

  const sendPing = () => {
    if (!link) {
      return;
    }
    const frame = encodeFrame({
      service: serviceId,
      method: 0,
      headers: [{ key: "type", value: "ping" }],
    });
    if (!link.sendBinary(frame.toString("base64"))) {
      log("心跳帧发送失败");
    }
  };

  const startPing = () => {
    if (pingTimer) {
      clearInterval(pingTimer);
    }
    sendPing();
    pingTimer = setInterval(sendPing, pingIntervalMs);
  };

  const ack = (frame, code, startedAt) => {
    if (!link) {
      return;
    }
    const response = encodeFrame({
      seqId: frame.seqId,
      logId: frame.logId,
      service: frame.service,
      method: frame.method,
      headers: [
        ...frame.headers,
        { key: "biz_rt", value: String(Date.now() - startedAt) },
      ],
      payload: Buffer.from(JSON.stringify({ code }), "utf8"),
    });
    if (!link.sendBinary(response.toString("base64"))) {
      log("事件回执发送失败");
    }
  };

  const handleEventFrame = async (frame, payload, startedAt) => {
    let code = 200;
    try {
      const event = JSON.parse(payload.toString("utf8"));
      await onEvent?.(event);
    } catch (error) {
      code = 500;
      log(`事件处理失败：${describe(error)}`);
    }
    ack(frame, code, startedAt);
  };

  const combine = (messageId, sum, seq, payload) => {
    if (!messageId || !Number.isInteger(sum) || !Number.isInteger(seq)) {
      return null;
    }
    const entry = fragments.get(messageId) ?? {
      parts: new Array(sum).fill(null),
      at: Date.now(),
    };
    if (entry.parts.length !== sum) {
      entry.parts = new Array(sum).fill(null);
    }
    entry.parts[seq] = payload;
    entry.at = Date.now();
    fragments.set(messageId, entry);
    if (entry.parts.some((part) => !part)) {
      return null;
    }
    fragments.delete(messageId);
    return Buffer.concat(entry.parts);
  };

  const dispatch = (frame) => {
    if (frame.method === 0) {
      if (readHeader(frame, "type") === "pong" && frame.payload?.length) {
        try {
          applyConfig(JSON.parse(frame.payload.toString("utf8")));
        } catch {
          log("心跳回包解析失败");
        }
      }
      return;
    }
    if (frame.method !== 1) {
      return;
    }
    const type = readHeader(frame, "type");
    const sum = Number(readHeader(frame, "sum") || 1);
    const seq = Number(readHeader(frame, "seq") || 0);
    let payload = frame.payload;
    if (sum > 1) {
      payload = combine(readHeader(frame, "message_id"), sum, seq, payload);
      if (!payload) {
        return;
      }
    }
    if (type !== "event") {
      return;
    }
    const startedAt = Date.now();
    void handleEventFrame(frame, payload, startedAt);
  };

  const scheduleReconnect = (forGeneration) => {
    if (!running || forGeneration !== generation || reconnectTimer) {
      return;
    }
    const base = Math.min(
      MIN_RECONNECT_DELAY_MS * 2 ** Math.min(attempt, 5),
      MAX_RECONNECT_DELAY_MS,
    );
    attempt += 1;
    const jitter = Math.floor(Math.random() * Math.min(reconnectNonce, 10) * 1000);
    const delay = base + jitter;
    log(`${Math.round(delay / 1000)} 秒后重连（第 ${attempt} 次）`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect(forGeneration);
    }, delay);
  };

  const handleClose = (forGeneration, code, reason) => {
    if (forGeneration !== generation) {
      return;
    }
    clearTimers();
    link = null;
    if (!running) {
      setStatus("idle");
      return;
    }
    log(`长连接断开（${code}${reason ? ` ${reason}` : ""}）`);
    setStatus("reconnecting", `连接断开（${code}）`);
    scheduleReconnect(forGeneration);
  };

  const startWatchdog = () => {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
    }
    watchdogTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of fragments) {
        if (now - entry.at > FRAGMENT_TTL_MS) {
          fragments.delete(key);
        }
      }
      if (!link) {
        return;
      }
      if (now - lastInboundAt > pingIntervalMs * 2 + PONG_GRACE_MS) {
        log("长时间未收到服务端数据，主动重连");
        const socket = link;
        link = null;
        clearTimers();
        try {
          socket.close(1000, "read timeout");
        } catch {
          log("关闭超时连接失败");
        }
        setStatus("reconnecting", "读超时");
        scheduleReconnect(generation);
      }
    }, WATCHDOG_INTERVAL_MS);
  };

  const connect = async (forGeneration) => {
    setStatus(attempt === 0 ? "connecting" : "reconnecting");
    try {
      const { url, config } = await bootstrap();
      if (!running || forGeneration !== generation) {
        return;
      }
      applyConfig(config);
      serviceId = Number(new URL(url).searchParams.get("service_id") ?? 0) || 0;
      const socket = ws.connect(url, {
        onOpen: () => {
          if (forGeneration !== generation) {
            return;
          }
          attempt = 0;
          lastInboundAt = Date.now();
          setStatus("online");
          startPing();
          startWatchdog();
        },
        onMessage: (data, binary) => {
          if (forGeneration !== generation) {
            return;
          }
          lastInboundAt = Date.now();
          if (!binary) {
            log("忽略非二进制帧");
            return;
          }
          try {
            dispatch(decodeFrame(Buffer.from(String(data), "base64")));
          } catch (error) {
            log(`帧解析失败：${describe(error)}`);
          }
        },
        onError: (message) => {
          if (forGeneration === generation) {
            log(`长连接错误：${message}`);
          }
        },
        onClose: (code, reason) => handleClose(forGeneration, code, reason),
      });
      if (!running || forGeneration !== generation) {
        try {
          socket.close(1000, "stale connection");
        } catch {
          log("关闭过期连接失败");
        }
        return;
      }
      link = socket;
    } catch (error) {
      if (!running || forGeneration !== generation) {
        return;
      }
      const message = describe(error);
      log(message);
      setStatus("error", message);
      scheduleReconnect(forGeneration);
    }
  };

  const stop = () => {
    running = false;
    generation += 1;
    clearTimers();
    fragments.clear();
    const socket = link;
    link = null;
    if (socket) {
      try {
        socket.close(1000, "plugin stopped");
      } catch {
        log("关闭长连接失败");
      }
    }
    credentials = null;
    setStatus("idle");
  };

  const start = async ({ appId, appSecret }) => {
    const nextAppId = String(appId ?? "").trim();
    const nextSecret = String(appSecret ?? "");
    if (
      running &&
      credentials &&
      credentials.appId === nextAppId &&
      credentials.appSecret === nextSecret
    ) {
      return;
    }
    stop();
    if (!nextAppId || !nextSecret) {
      log("未配置 App ID / App Secret，长连接不启动");
      return;
    }
    credentials = { appId: nextAppId, appSecret: nextSecret };
    running = true;
    attempt = 0;
    generation += 1;
    void connect(generation);
  };

  return { start, stop };
};
