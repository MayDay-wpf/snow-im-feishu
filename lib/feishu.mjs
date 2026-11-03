/**
 * 飞书开放平台调用封装。
 *
 * 说明：后台模块的 `ctx.net.fetch` 会把响应体按 UTF-8 解码，因此只有 JSON
 * 接口走它（顺带复用应用的代理配置）；图片 / 文件等二进制资源必须走 Node
 * 自己的 TLS 栈下载（后台模块运行在主进程，拥有完整 Node 权限）。
 */

import { request as httpsRequest } from "node:https";

const DEFAULT_DOMAIN = "https://open.feishu.cn";
/** 单条文本消息的分片长度上限（字符）。 */
export const MAX_TEXT_CHARS = 3500;
const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** 下载二进制资源（跟随最多 3 次跳转）。 */
export const downloadBinary = (
  url,
  { headers = {}, maxBytes = DEFAULT_MAX_ATTACHMENT_BYTES, timeoutMs = 60000, redirects = 3 } = {},
) =>
  new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error("资源地址非法"));
      return;
    }
    const request = httpsRequest(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          if (redirects <= 0) {
            reject(new Error("资源重定向次数过多"));
            return;
          }
          downloadBinary(new URL(location, target).href, {
            headers,
            maxBytes,
            timeoutMs,
            redirects: redirects - 1,
          }).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          // 失败响应体是 JSON（如 {"code":234009,"msg":"Lack of necessary permissions."}）：
          // 不读出来就没法判断是权限、资源归属还是大小限制，只能看到「HTTP 400」。
          const chunks = [];
          let size = 0;
          let settled = false;
          const finish = () => {
            if (settled) {
              return;
            }
            settled = true;
            const body = Buffer.concat(chunks).toString("utf8").replace(/\s+/g, " ").trim();
            reject(
              new Error(
                `资源下载失败（HTTP ${status}${body ? `：${body.slice(0, 300)}` : ""}）`,
              ),
            );
          };
          response.on("data", (chunk) => {
            if (size < 2048) {
              chunks.push(chunk);
              size += chunk.length;
            }
          });
          response.on("end", finish);
          response.on("error", finish);
          return;
        }
        const chunks = [];
        let size = 0;
        let settled = false;
        response.on("data", (chunk) => {
          if (settled) {
            return;
          }
          size += chunk.length;
          if (size > maxBytes) {
            settled = true;
            response.destroy();
            reject(new Error("资源超过大小上限"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (!settled) {
            settled = true;
            resolve({
              buffer: Buffer.concat(chunks),
              contentType: String(response.headers["content-type"] ?? ""),
            });
          }
        });
        response.on("error", (error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("资源下载超时"));
    });
    request.end();
  });

/**
 * 按分片长度切分长文本：优先在换行处断开；若断点在代码围栏内则补上闭合并在
 * 下一片重新打开，若断点在 Markdown 表格内则在下一片重复表头。
 */
export const splitMessage = (input, limit = MAX_TEXT_CHARS) => {
  const text = String(input ?? "");
  if (text.length <= limit) {
    return [text];
  }
  const chunks = [];
  let rest = text;
  let carry = "";
  while (rest.length + carry.length > limit) {
    const budget = Math.max(1, limit - carry.length);
    let cut = rest.lastIndexOf("\n", budget);
    if (cut < Math.floor(budget / 2)) {
      cut = budget;
    }
    const body = carry + rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n+/, "");
    const fenceCount = (body.match(/^```/gm) ?? []).length;
    let suffix = "";
    let nextCarry = "";
    if (fenceCount % 2 === 1) {
      suffix = "\n```";
      nextCarry = "```\n";
    } else {
      const tableHeader = openTableHeader(body);
      if (tableHeader) {
        nextCarry = `${tableHeader}\n`;
      }
    }
    chunks.push(body + suffix);
    carry = nextCarry;
  }
  chunks.push(carry + rest);
  return chunks;
};

const TABLE_SEPARATOR = /^\|?[\s:|-]*-[\s|:-]*\|?\s*$/;

/** 正文末尾仍处于 Markdown 表格内时返回该表格的表头两行。 */
const openTableHeader = (text) => {
  const lines = text.split("\n");
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) {
    last -= 1;
  }
  if (last < 0 || !lines[last].trim().startsWith("|")) {
    return "";
  }
  let start = last;
  while (start > 0 && lines[start - 1].trim().startsWith("|")) {
    start -= 1;
  }
  const block = lines.slice(start, last + 1);
  if (block.length < 2 || !TABLE_SEPARATOR.test(block[1])) {
    return "";
  }
  return `${block[0]}\n${block[1]}`;
};

/**
 * 交互式卡片（承载流式正文）。
 *
 * 飞书的「更新消息」接口（`PATCH /open-apis/im/v1/messages/{message_id}`）只能更新
 * 应用自己发送的**卡片**消息：对文本消息调用会返回 `230001 This message is NOT a card`。
 * 因此流式回推必须把正文放进卡片；卡片还要显式声明 `config.update_multi: true`
 * 才是「共享卡片」，否则同样不允许更新。
 */
export const buildCard = (text) => ({
  config: { update_multi: true, wide_screen_mode: true },
  elements: [{ tag: "div", text: { tag: "lark_md", content: String(text ?? "") } }],
});

export const createFeishuApi = ({ fetch, domain = DEFAULT_DOMAIN }) => {
  let token = { value: "", expiresAt: 0 };

  const call = async (path, { method = "GET", body, query, bearer, timeoutMs = 30000 } = {}) => {
    const search = query ? `?${new URLSearchParams(query).toString()}` : "";
    const response = await fetch(`${domain}${path}${search}`, {
      method,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs,
    });
    if (response?.error) {
      throw new Error(`飞书接口请求失败：${response.error}`);
    }
    let parsed = null;
    try {
      parsed = JSON.parse(response?.body || "null");
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed.code === "number" && parsed.code !== 0) {
      throw new Error(`飞书接口返回错误 ${parsed.code}：${parsed.msg || "未知原因"}`);
    }
    if (!response?.ok && !parsed) {
      throw new Error(`飞书接口请求失败（HTTP ${response?.status ?? 0}）`);
    }
    return parsed;
  };

  /** 取租户访问令牌（提前 5 分钟刷新）。 */
  const tenantToken = async (appId, appSecret, { force = false } = {}) => {
    if (!force && token.value && Date.now() < token.expiresAt) {
      return token.value;
    }
    const data = await call("/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      body: { app_id: appId, app_secret: appSecret },
    });
    const value = String(data?.tenant_access_token ?? "");
    if (!value) {
      throw new Error("未能获取 tenant_access_token，请检查 App ID 与 App Secret");
    }
    const expiresIn = Number(data?.expire ?? 7200);
    token = {
      value,
      expiresAt: Date.now() + Math.max(60, expiresIn - 300) * 1000,
    };
    return value;
  };

  const clearToken = () => {
    token = { value: "", expiresAt: 0 };
  };

  const sendText = async ({ bearer, chatId, text }) => {
    const data = await call("/open-apis/im/v1/messages", {
      method: "POST",
      query: { receive_id_type: "chat_id" },
      bearer,
      body: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
    return String(data?.data?.message_id ?? "");
  };

  const sendCard = async ({ bearer, chatId, text }) => {
    const data = await call("/open-apis/im/v1/messages", {
      method: "POST",
      query: { receive_id_type: "chat_id" },
      bearer,
      body: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(buildCard(text)),
      },
    });
    return String(data?.data?.message_id ?? "");
  };

  /** 更新已发送的卡片（文本消息不可更新，见 buildCard 注释）。 */
  const updateCard = async ({ bearer, messageId, text }) => {
    await call(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: "PATCH",
      bearer,
      body: { content: JSON.stringify(buildCard(text)) },
    });
  };

  /** 读取图片 / 文件资源所需的下载地址。 */
  const resourceUrl = ({ messageId, fileKey, type }) =>
    `${domain}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${encodeURIComponent(type)}`;

  return { tenantToken, clearToken, sendText, sendCard, updateCard, resourceUrl };
};
