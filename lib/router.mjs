/**
 * 飞书消息路由：准入、会话绑定、命令、流式回推、审批回包、附件与断线补发。
 *
 * 数据来源与出口全部走插件元数据 / 写动作：
 * - 读取：`messages`（会话消息）、`runtime`（是否仍在流式）、`interactions`（待授权 / 待答提问）；
 * - 写入：`conversations.sendMessage` / `conversations.create` / `conversations.abort` /
 *   `conversations.activate` / `conversations.setApiProfile`，以及 `interactions.*` 四个回包动作。
 *
 * 说明：`interactions` 域只覆盖「当前激活会话」（与手机远控同源），因此审批回包只在
 * 绑定会话恰好是激活会话时生效；`followActive` 打开时，IM 消息会顺带把桌面切到该会话。
 *
 * 回推方式：飞书只能更新**卡片**消息（文本消息调用更新接口返回 230001），所以「流式回推」
 * 用卡片承载正文并持续更新；「仅最终结果」在回合结束后一次性发送纯文本。绑定会话被删除时
 * 会自动解绑并新建一条会话，不会卡在 `Conversation not found`。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { MAX_TEXT_CHARS, downloadBinary, splitMessage } from "./feishu.mjs";

const DATA_ROOT = join(homedir(), ".snowapp");
/** 非图片附件（pdf / docx / 压缩包…）落到收件箱，标签值用绝对路径。 */
const INBOX_ROOT = join(DATA_ROOT, "feishu-inbox");
const TURN_TIMEOUT_MS = 20 * 60 * 1000;
/** 投递后等待回合开始流式的上限（超过即认为该回合没有输出）。 */
const TURN_START_GRACE_MS = 20000;
const APPROVAL_TTL_MS = 5 * 60 * 1000;
const MAX_SEEN_EVENTS = 500;
const STREAM_TAIL_CHARS = MAX_TEXT_CHARS;
const MIN_UPDATE_INTERVAL_MS = 1000;
const OUTBOX_RETRY_MS = 15000;
const APPROVAL_TICK_INTERVAL = 2;

const APPROVE_PATTERN = /^(批准|同意|允许|可以|通过|确认|yes|y|ok|approve|allow|1)$/i;
const REJECT_PATTERN = /^(拒绝|不同意|不允许|否|no|n|reject|deny|cancel|2)$/i;
/** 宿主报「会话不存在」时的错误文案（删会话、换项目都会命中）。 */
const MISSING_CONVERSATION_PATTERN = /not found|不存在|已删除|已被删除|已移除|no such/i;
/** 只有鉴权类失败才值得刷新令牌重试，其余错误（参数、权限）重试也没用。 */
const TOKEN_ERROR_PATTERN = /token|9999166|授权|unauthorized|401/i;
/** 资源接口 `type` 的候选值：文档只明确 image / file，视频音频口径不一，按序尝试。 */
const RESOURCE_TYPES = {
  image: ["image", "file"],
  file: ["file"],
  media: ["file", "media"],
  audio: ["file", "audio"],
};

const IMAGE_EXTENSIONS = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
};

/** 图片魔数 → data URL 的 MIME（落盘扩展名与 MIME 都以内容嗅探为准）。 */
const IMAGE_MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/** 图片魔数：飞书返回的 content-type 与扩展名都可能不准，落盘前按内容判定。 */
const IMAGE_SIGNATURES = [
  { extension: ".png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { extension: ".jpg", bytes: [0xff, 0xd8, 0xff] },
  { extension: ".gif", bytes: [0x47, 0x49, 0x46] },
  { extension: ".bmp", bytes: [0x42, 0x4d] },
];

const describe = (error) => (error instanceof Error ? error.message : String(error));

/** 当天日期目录（本地时区，与宿主 upload 目录的日期口径一致）。 */
const dateStamp = () => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

/** 按魔数判断真实图片格式；不是受支持的图片时返回空串。 */
const sniffImage = (buffer) => {
  const signature = IMAGE_SIGNATURES.find((item) =>
    item.bytes.every((byte, index) => buffer[index] === byte),
  );
  if (signature) {
    return signature.extension;
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("latin1", 0, 4) === "RIFF" &&
    buffer.toString("latin1", 8, 12) === "WEBP"
  ) {
    return ".webp";
  }
  return "";
};

const sanitizeName = (name) => {
  const base = String(name ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .trim();
  const trimmed = base.slice(0, 80);
  return trimmed || "attachment";
};

/**
 * 拍平飞书富文本（post）：文字按段落拼接，图片 / 视频 / 文件节点单独收集。
 * 图文混排（截图 + 一句话）走的就是 post，媒体节点不收集就会整段丢掉。
 */
const flattenPost = (content) => {
  const lines = [];
  const images = [];
  const files = [];
  if (content?.title) {
    lines.push(String(content.title));
  }
  for (const paragraph of content?.content ?? []) {
    if (!Array.isArray(paragraph)) {
      continue;
    }
    const text = paragraph
      .map((node) => {
        if (!node || typeof node !== "object") {
          return "";
        }
        if (node.tag === "a" && node.href) {
          return `${node.text ?? ""} (${node.href})`;
        }
        if (node.tag === "at" && node.user_id) {
          return `@${node.user_id}`;
        }
        if (node.tag === "img") {
          if (node.image_key) {
            images.push(String(node.image_key));
          }
          return "";
        }
        if (node.tag === "media" || node.tag === "file") {
          if (node.file_key) {
            files.push({
              fileKey: String(node.file_key),
              fileName: String(node.file_name ?? ""),
              type: node.tag === "media" ? "media" : "file",
            });
          }
          return "";
        }
        return String(node.text ?? "");
      })
      .join("");
    if (text.trim()) {
      lines.push(text);
    }
  }
  return { text: lines.join("\n").trim(), images, files };
};

export const createRouter = ({ ctx, store, api, log, credentials }) => {
  const turns = new Map();
  const pending = new Map();
  const seenEvents = new Set();
  const seenOrder = [];
  let tickCount = 0;
  let lastOutboxAttempt = 0;

  /** 事件去重：同一条消息被重推时 event_id 通常不变，个别情况下会换 event_id 但 message_id 不变。 */
  const seen = (keys) => {
    const list = keys.filter(Boolean);
    if (list.length === 0) {
      return false;
    }
    if (list.some((key) => seenEvents.has(key))) {
      return true;
    }
    for (const key of list) {
      seenEvents.add(key);
      seenOrder.push(key);
    }
    while (seenOrder.length > MAX_SEEN_EVENTS) {
      seenEvents.delete(seenOrder.shift());
    }
    return false;
  };

  const bearer = async (force = false) => {
    const current = credentials();
    if (!current?.appId || !current?.appSecret) {
      throw new Error("尚未配置 App ID / App Secret");
    }
    return api.tenantToken(current.appId, current.appSecret, { force });
  };

  /** 令牌过期 / 被吊销时强制刷新一次再试；参数或权限类错误直接抛出。 */
  const withBearer = async (task) => {
    try {
      return await task(await bearer());
    } catch (error) {
      const message = describe(error);
      if (!TOKEN_ERROR_PATTERN.test(message)) {
        throw error;
      }
      api.clearToken();
      log(`飞书令牌可能失效，刷新后重试（${message}）`);
      return await task(await bearer(true));
    }
  };

  const isMissingConversation = (error) => MISSING_CONVERSATION_PATTERN.test(describe(error));

  const reply = async (chatId, text) => {
    const chunks = splitMessage(String(text ?? ""));
    for (const chunk of chunks) {
      try {
        await withBearer((token) => api.sendText({ bearer: token, chatId, text: chunk }));
      } catch (error) {
        log(`回复飞书失败：${describe(error)}`);
        await store.pushOutbox({ chatId, text: chunk, at: Date.now() });
        return false;
      }
    }
    return true;
  };

  /**
   * 下载飞书消息资源（二进制走 Node TLS 栈，ctx.net.fetch 只能读 JSON）。
   * `type` 必须与资源种类匹配（图片 image / 文件 file）；文档对视频音频口径不一，
   * 因此按候选值依次尝试，把最后一次的失败原因上抛（错误信息里带飞书返回的错误码）。
   */
  const downloadResource = async ({ message, fileKey, type, config }) => {
    const maxBytes = Math.max(1, Number(config.maxAttachmentMb) || 20) * 1024 * 1024;
    const token = await bearer();
    const headers = { Authorization: `Bearer ${token}` };
    let lastError = null;
    for (const candidate of RESOURCE_TYPES[type] ?? ["file"]) {
      try {
        return await downloadBinary(
          api.resourceUrl({ messageId: message.message_id, fileKey, type: candidate }),
          { headers, maxBytes },
        );
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("资源下载失败");
  };

  /** 非图片附件：落到收件箱，标签值用绝对路径（模型可按路径自行读取）。 */
  const saveFile = async ({
    message,
    fileKey,
    fileName,
    type = "file",
    config,
    buffer,
    contentType,
  }) => {
    const data = buffer ?? (await downloadResource({ message, fileKey, type, config })).buffer;
    const dir = join(INBOX_ROOT, dateStamp());
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${Date.now()}-${sanitizeName(fileName || "attachment")}`);
    await writeFile(path, data);
    log(
      `已保存附件 ${path}（${data.length} 字节${contentType ? `，${contentType}` : ""}）`,
    );
    return `@@file:${path}@@`;
  };

  /**
   * 图片：下载后以 data URL 交给会话（`@@image:data:<mime>;base64,…@@`）。
   *
   * 宿主自带的输入框与手机远控都是这个形态：渲染层把标签值**原样**当 `<img src>` 用，
   * 只有 data URL 在刚发出去时就能预览；落库时宿主会把 data URL 落盘成
   * `upload/<日期>/<hash>.<ext>` 短标签，所以数据库不会被 base64 撑大。
   * （用 `upload/...` 相对路径时，只有从库里重新加载、宿主还原成 data URL 后才显示，
   *   刚发出那一下渲染层拿到的是原样字符串，预览就是裂的。）
   */
  const saveImage = async ({ message, fileKey, fileName, config }) => {
    const { buffer, contentType } = await downloadResource({
      message,
      fileKey,
      type: "image",
      config,
    });
    const declared = String(contentType ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const extension = sniffImage(buffer) || IMAGE_EXTENSIONS[declared] || "";
    if (!extension) {
      // 不是图片（例如飞书返回了错误页）：按普通文件交出去，不写出坏图。
      log(`资源不是图片，按文件处理（${declared || "未知类型"}）`);
      return saveFile({ message, fileKey, fileName, config, buffer, contentType });
    }
    const mimeType =
      IMAGE_MIME_TYPES[extension] ?? (declared.startsWith("image/") ? declared : "image/png");
    log(`已接收图片 ${extension}（${buffer.length} 字节，以 data URL 交给会话）`);
    return `@@image:data:${mimeType};base64,${buffer.toString("base64")}@@`;
  };

  /**
   * 收集一条消息里的附件：单个附件失败只记一条提示，不影响同一消息的文字与其它附件
   * （否则「图片下载失败」会把整条消息吞掉，用户只看到「处理消息失败」）。
   */
  const collectAttachments = async ({ message, images, files, config }) => {
    const attachments = [];
    const notes = [];
    for (const imageKey of images) {
      try {
        attachments.push(await saveImage({ message, fileKey: imageKey, config }));
      } catch (error) {
        notes.push(`[图片下载失败：${describe(error)}]`);
        await store.log("warn", `图片下载失败：${describe(error)}`);
      }
    }
    for (const file of files) {
      try {
        attachments.push(
          await saveFile({
            message,
            fileKey: file.fileKey,
            fileName: file.fileName,
            type: file.type,
            config,
          }),
        );
      } catch (error) {
        notes.push(`[附件下载失败：${describe(error)}]`);
        await store.log("warn", `附件下载失败：${describe(error)}`);
      }
    }
    return { attachments, notes };
  };

  const parseMessage = async ({ message, config }) => {
    const type = String(message.message_type ?? "");
    let content = {};
    try {
      content = JSON.parse(message.content || "{}");
    } catch {
      content = {};
    }
    if (type === "text") {
      let text = String(content.text ?? "");
      for (const mention of message.mentions ?? []) {
        if (mention?.key) {
          text = text.split(mention.key).join("");
        }
      }
      return { text: text.trim(), attachments: [] };
    }
    if (type === "post") {
      const { text, images, files } = flattenPost(content);
      const { attachments, notes } = await collectAttachments({ message, images, files, config });
      return { text: [text, ...notes].filter(Boolean).join("\n"), attachments };
    }
    if (type === "image" && content.image_key) {
      const { attachments, notes } = await collectAttachments({
        message,
        images: [String(content.image_key)],
        files: [],
        config,
      });
      return { text: notes.join("\n"), attachments };
    }
    if ((type === "file" || type === "media" || type === "audio") && content.file_key) {
      const { attachments, notes } = await collectAttachments({
        message,
        images: [],
        files: [
          {
            fileKey: String(content.file_key),
            fileName: String(content.file_name ?? ""),
            type,
          },
        ],
        config,
      });
      return { text: notes.join("\n"), attachments };
    }
    return { text: "", attachments: [], unsupported: type || "unknown" };
  };

  const activate = async (conversationId) => {
    const result = await ctx.write.run("conversations.activate", { conversationId });
    if (!result.ok) {
      log(`切换焦点会话失败：${result.error ?? "未知原因"}`);
    }
  };

  const bindingFor = async (chatId) => (await store.bindings())[chatId] ?? null;

  const bindingByConversation = async (conversationId) => {
    if (!conversationId) {
      return null;
    }
    const map = await store.bindings();
    for (const [chatId, binding] of Object.entries(map)) {
      if (binding?.conversationId === conversationId) {
        return { chatId, ...binding };
      }
    }
    return null;
  };

  const setBinding = async (chatId, patch) => {
    const map = await store.bindings();
    map[chatId] = { ...(map[chatId] ?? {}), ...patch, updatedAt: Date.now() };
    await store.saveBindings(map);
    return map[chatId];
  };

  const removeBinding = async (chatId) => {
    const map = await store.bindings();
    delete map[chatId];
    await store.saveBindings(map);
  };

  /** 记录一条待批准的私聊用户，并只提示一次。 */
  const denyUnknown = async ({ chatId, openId }) => {
    const state = await store.state();
    const known = (state.pendingUsers ?? []).some((item) => item.openId === openId);
    if (!known) {
      const pendingUsers = [
        ...(state.pendingUsers ?? []).filter((item) => item.openId !== openId),
        { openId, at: Date.now() },
      ].slice(-50);
      await store.patchState({
        pendingUsers,
        stats: { denied: (state.stats?.denied ?? 0) + 1 },
      });
      await store.log("warn", `拒绝未授权私聊：${openId}`);
    }
    await reply(
      chatId,
      [
        "当前账号未获授权，无法驱动 Snow App。",
        `用户标识：${openId}`,
        "请在电脑端的「飞书连接」插件面板中加入白名单（或打开「允许所有私聊」）。",
      ].join("\n"),
    );
  };

  const ensureConversation = async ({ chatId, chatType, config, title, content }) => {
    if (!config.directoryId) {
      await reply(
        chatId,
        "尚未配置默认项目，无法新建会话。请在电脑端的「飞书连接」插件面板中选择项目。",
      );
      return null;
    }
    const created = await ctx.write.run("conversations.create", {
      directoryId: config.directoryId,
      title: title || (chatType === "group" ? "飞书群聊" : "飞书私聊"),
      text: content,
      autoReply: true,
      ...(config.apiProfile ? { apiProfile: config.apiProfile } : {}),
    });
    if (!created.ok) {
      await reply(chatId, `新建会话失败：${created.error ?? "未知原因"}`);
      return null;
    }
    const data = created.data ?? {};
    const binding = await setBinding(chatId, {
      conversationId: String(data.conversationId ?? ""),
      directoryId: String(data.directoryId ?? config.directoryId),
      chatType,
      title: String(data.title ?? title ?? ""),
    });
    await store.log("info", `已为会话 ${chatId} 新建并绑定会话 ${binding.conversationId}`);
    return binding;
  };

  const lastAssistantText = (items, baselineId) => {
    if (!Array.isArray(items)) {
      return "";
    }
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item?.role !== "assistant") {
        continue;
      }
      if (baselineId && item.id === baselineId) {
        return "";
      }
      return String(item.content ?? "");
    }
    return "";
  };

  const readMessages = async (conversationId) => {
    const response = await ctx.metadata.get(["messages", "runtime"], {
      params: { conversationId },
    });
    return {
      items: response?.domains?.messages?.items ?? null,
      streaming: (response?.domains?.runtime?.streamingSessions ?? []).some(
        (session) => session.conversationId === conversationId && session.isStreaming,
      ),
    };
  };

  const renderStreaming = (text) => {
    if (text.length <= STREAM_TAIL_CHARS) {
      return text;
    }
    return `…（已截断前文，完成后补齐）\n${text.slice(text.length - STREAM_TAIL_CHARS)}`;
  };

  const startTurn = (chatId, conversationId, baselineId, finalOnly) => {
    const existing = turns.get(conversationId);
    if (existing) {
      existing.chatId = chatId;
      existing.finalOnly = existing.finalOnly && finalOnly;
      existing.streaming = existing.streaming && !existing.finalOnly;
      return existing;
    }
    const turn = {
      chatId,
      conversationId,
      baselineId,
      finalOnly,
      streaming: !finalOnly,
      messageId: "",
      lastRendered: "",
      lastSource: "",
      cardOk: true,
      sawStreaming: false,
      lastUpdateAt: 0,
      startedAt: Date.now(),
      idleTicks: 0,
    };
    turns.set(conversationId, turn);
    return turn;
  };

  /**
   * 流式回推：正文放进卡片（只有卡片能更新，见 feishu.mjs 的 buildCard）。
   * 卡片不可用（发送或更新失败）时本回合退化为一次性回推，不再逐秒重试。
   */
  const pushStreaming = async (turn, text) => {
    if (!turn.cardOk) {
      turn.lastSource = text;
      return;
    }
    const rendered = renderStreaming(text);
    if (!rendered || rendered === turn.lastRendered) {
      turn.lastSource = text;
      return;
    }
    if (turn.messageId) {
      await withBearer((token) =>
        api.updateCard({ bearer: token, messageId: turn.messageId, text: rendered }),
      );
    } else {
      const messageId = await withBearer((token) =>
        api.sendCard({ bearer: token, chatId: turn.chatId, text: rendered }),
      );
      if (!messageId) {
        throw new Error("飞书未返回 message_id，无法继续流式回推");
      }
      turn.messageId = messageId;
    }
    turn.lastRendered = rendered;
    turn.lastSource = text;
    turn.lastUpdateAt = Date.now();
  };

  /**
   * 收尾：把完整结果补齐一次。
   * - 有卡片：更新为完整首片，其余分片另发文本消息；
   * - 没有卡片（仅最终结果模式，或卡片不可用）：按分片发文本。
   * 结果**不进补发队列**：卡片里已经展示过的内容再补发一遍就是重复回复。
   */
  const finalizeTurn = async (turn, text) => {
    const content = String(text ?? "");
    if (!content.trim()) {
      if (!turn.messageId) {
        await store.log("warn", `回合没有产生任何输出：${turn.conversationId}`);
      }
      return;
    }
    const chunks = splitMessage(content);
    if (!turn.messageId) {
      for (const chunk of chunks) {
        await reply(turn.chatId, chunk);
      }
      return;
    }
    try {
      await withBearer((token) =>
        api.updateCard({ bearer: token, messageId: turn.messageId, text: chunks[0] }),
      );
      turn.lastRendered = chunks[0];
      turn.lastSource = content;
    } catch (error) {
      log(`更新卡片失败：${describe(error)}`);
      // 卡片没能补全（例如缺少更新卡片的权限）时用纯文本补一次，避免丢内容。
      if (turn.lastRendered !== chunks[0]) {
        for (const chunk of chunks) {
          await reply(turn.chatId, chunk);
        }
        return;
      }
    }
    for (const chunk of chunks.slice(1)) {
      await reply(turn.chatId, chunk);
    }
  };

  const pollTurn = async (turn) => {
    const { items, streaming } = await readMessages(turn.conversationId);
    const text = lastAssistantText(items, turn.baselineId);
    const now = Date.now();
    if (now - turn.startedAt > TURN_TIMEOUT_MS) {
      await finalizeTurn(turn, text || turn.lastSource);
      turns.delete(turn.conversationId);
      await store.log(
        "warn",
        `回合超过 ${Math.round(TURN_TIMEOUT_MS / 60000)} 分钟，停止回推：${turn.conversationId}`,
      );
      return;
    }
    if (
      turn.streaming &&
      text &&
      text !== turn.lastSource &&
      (now - turn.lastUpdateAt >= MIN_UPDATE_INTERVAL_MS || !turn.messageId)
    ) {
      try {
        await pushStreaming(turn, text);
      } catch (error) {
        turn.cardOk = false;
        log(`流式回推失败，本回合改为一次性回推：${describe(error)}`);
      }
    }
    if (streaming) {
      turn.sawStreaming = true;
      turn.idleTicks = 0;
      return;
    }
    // 回合还没开始流式且没有输出时不要判定结束：模型可能仍在准备第一个响应。
    if (!turn.sawStreaming && !text) {
      if (now - turn.startedAt > TURN_START_GRACE_MS) {
        turns.delete(turn.conversationId);
        await store.log("warn", `回合在 ${TURN_START_GRACE_MS / 1000} 秒内没有开始：${turn.conversationId}`);
      }
      return;
    }
    turn.idleTicks += 1;
    if (turn.idleTicks < 2) {
      return;
    }
    await finalizeTurn(turn, text || turn.lastSource || turn.lastRendered);
    turns.delete(turn.conversationId);
    const state = await store.state();
    await store.patchState({
      stats: { delivered: (state.stats?.delivered ?? 0) + 1 },
    });
  };

  const tickTurns = async () => {
    for (const turn of [...turns.values()]) {
      try {
        await pollTurn(turn);
      } catch (error) {
        log(`回合轮询失败：${describe(error)}`);
      }
    }
  };

  const promptAuthorization = (item) => {
    const lines = [`【待批准的工具授权】${item.name ?? "未知工具"}`];
    if (item.sensitive) {
      lines.push("该操作属于敏感命令，只能由电脑端确认；回复「拒绝」可以拒绝。");
    }
    if (item.arguments) {
      let preview = "";
      try {
        preview = JSON.stringify(item.arguments);
      } catch {
        preview = "";
      }
      if (preview) {
        lines.push(`参数：${preview.slice(0, 800)}`);
      }
    }
    lines.push("回复「批准」或「拒绝」。");
    return lines.join("\n");
  };

  const promptQuestion = (item) => {
    const options = Array.isArray(item.options) ? item.options : [];
    const lines = ["【待回答的选择题】", String(item.question ?? "")];
    options.forEach((option, index) => {
      lines.push(`${index + 1}. ${option}`);
    });
    lines.push(
      options.length > 1
        ? "单选回序号，多选用逗号分隔（如 1,3）；也可以直接回复自定义答案。"
        : "回复序号或直接回复自定义答案。",
    );
    return lines.join("\n");
  };

  const tickApprovals = async () => {
    const config = await store.config();
    if (!config.forwardApprovals) {
      return;
    }
    const now = Date.now();
    for (const [id, item] of [...pending.entries()]) {
      if (now - item.at > APPROVAL_TTL_MS) {
        pending.delete(id);
        await store.log("warn", `待处理请求已超时（${id}），未在飞书侧结算`);
      }
    }
    const response = await ctx.metadata.get(["interactions", "runtime"]);
    const interactions = response?.domains?.interactions ?? {};
    const activeId = response?.domains?.runtime?.conversation?.conversationId ?? "";
    if (!activeId) {
      return;
    }
    const binding = await bindingByConversation(activeId);
    if (!binding) {
      return;
    }
    const items = [
      ...(interactions.authorizations ?? []).map((item) => ({
        kind: "authorization",
        id: item.authorizationId,
        item,
      })),
      ...(interactions.questions ?? []).map((item) => ({
        kind: "question",
        id: item.questionId,
        item,
      })),
    ];
    for (const entry of items) {
      if (!entry.id || pending.has(entry.id)) {
        continue;
      }
      pending.set(entry.id, {
        kind: entry.kind,
        chatId: binding.chatId,
        conversationId: activeId,
        options: Array.isArray(entry.item?.options) ? entry.item.options : [],
        name: String(entry.item?.name ?? ""),
        at: Date.now(),
      });
      const text =
        entry.kind === "authorization"
          ? promptAuthorization(entry.item)
          : promptQuestion(entry.item);
      await reply(binding.chatId, text);
      await store.log("info", `已推送待处理请求到飞书（${entry.id}）`);
    }
  };

  /** 把飞书回复结算到本机待授权 / 待答提问；返回是否消费了这条消息。 */
  const resolvePending = async ({ chatId, text }) => {
    const entries = [...pending.entries()].filter(([, item]) => item.chatId === chatId);
    if (entries.length === 0) {
      return false;
    }
    const [id, entry] = entries[entries.length - 1];
    const answer = String(text ?? "").trim();
    if (!answer) {
      return false;
    }
    if (entry.kind === "authorization") {
      if (REJECT_PATTERN.test(answer)) {
        const result = await ctx.write.run("interactions.rejectAuthorization", {
          authorizationId: id,
          reason: "在飞书中拒绝",
        });
        pending.delete(id);
        await reply(chatId, result.ok ? "已拒绝该工具授权。" : `拒绝失败：${result.error}`);
        return true;
      }
      if (APPROVE_PATTERN.test(answer)) {
        const result = await ctx.write.run("interactions.approveAuthorization", {
          authorizationId: id,
        });
        if (result.ok) {
          pending.delete(id);
          await reply(chatId, "已批准该工具授权。");
        } else {
          await reply(
            chatId,
            `批准失败：${result.error ?? "未知原因"}（敏感命令只能由电脑端确认，可回复「拒绝」）`,
          );
        }
        return true;
      }
      return false;
    }

    const options = Array.isArray(entry.options) ? entry.options : [];
    const numbers = answer.match(/\d+/g) ?? [];
    const selected = [];
    if (numbers.length > 0 && options.length > 0) {
      for (const raw of numbers) {
        const option = options[Number(raw) - 1];
        if (option) {
          selected.push(option);
        }
      }
    }
    if (selected.length > 0) {
      const result = await ctx.write.run("interactions.answerQuestion", {
        questionId: id,
        selectedOptions: selected,
        customAnswers: [],
      });
      pending.delete(id);
      await reply(chatId, result.ok ? `已提交：${selected.join("、")}` : `提交失败：${result.error}`);
      return true;
    }
    const result = await ctx.write.run("interactions.answerQuestion", {
      questionId: id,
      selectedOptions: [],
      customAnswers: [answer],
    });
    if (result.ok) {
      pending.delete(id);
      await reply(chatId, "已提交自定义答案。");
    } else {
      await reply(chatId, `提交失败：${result.error ?? "未知原因"}`);
    }
    return true;
  };

  const helpText = [
    "可用命令：",
    "/new [标题] 新建会话并绑定本聊天",
    "/stop 中止当前绑定会话的运行",
    "/status 查看连接与绑定状态",
    "/model [档案名] 查看或切换绑定会话的 API 档案",
    "/unbind 解除本聊天与 Snow 会话的绑定",
    "/help 显示本帮助",
    "直接发消息即可下任务；发送图片或文件会交给当前会话。",
  ].join("\n");

  const handleCommand = async ({ chatId, chatType, text, config }) => {
    const [rawCommand, ...rest] = text.split(/\s+/);
    const command = rawCommand.toLowerCase();
    const argument = rest.join(" ").trim();
    const binding = await bindingFor(chatId);
    if (command === "/help") {
      await reply(chatId, helpText);
      return true;
    }
    if (command === "/status") {
      const state = await store.state();
      await reply(
        chatId,
        [
          `长连接：${state.status}${state.detail ? `（${state.detail}）` : ""}`,
          `默认项目：${config.directoryId || "未配置"}`,
          `本聊天绑定会话：${binding?.conversationId || "未绑定"}`,
          `推送方式：${config.pushMode === "stream" ? "流式回推（卡片）" : "仅最终结果"}`,
          `统计：收到 ${state.stats?.received ?? 0}（私聊 ${state.stats?.receivedDirect ?? 0} / 群聊 ${state.stats?.receivedGroup ?? 0}） / 投递 ${state.stats?.delivered ?? 0} / 拒绝 ${state.stats?.denied ?? 0}`,
        ].join("\n"),
      );
      return true;
    }
    if (command === "/unbind") {
      if (!binding) {
        await reply(chatId, "本聊天尚未绑定会话。");
        return true;
      }
      await removeBinding(chatId);
      await reply(chatId, "已解除绑定，下一条消息会新建会话。");
      return true;
    }
    if (command === "/new") {
      if (!config.directoryId) {
        await reply(chatId, "尚未配置默认项目，请先在插件面板中选择项目。");
        return true;
      }
      const created = await ctx.write.run("conversations.create", {
        directoryId: config.directoryId,
        title: argument || (chatType === "group" ? "飞书群聊" : "飞书私聊"),
        autoReply: false,
        ...(config.apiProfile ? { apiProfile: config.apiProfile } : {}),
      });
      if (!created.ok) {
        await reply(chatId, `新建会话失败：${created.error ?? "未知原因"}`);
        return true;
      }
      const data = created.data ?? {};
      await setBinding(chatId, {
        conversationId: String(data.conversationId ?? ""),
        directoryId: String(data.directoryId ?? config.directoryId),
        chatType,
        title: String(data.title ?? ""),
      });
      await reply(
        chatId,
        `已新建并绑定会话：${data.title || data.conversationId}\n下一条消息会投递到该会话。`,
      );
      return true;
    }
    if (command === "/stop") {
      if (!binding) {
        await reply(chatId, "本聊天尚未绑定会话。");
        return true;
      }
      const result = await ctx.write.run("conversations.abort", {
        conversationId: binding.conversationId,
      });
      if (!result.ok && isMissingConversation(result.error)) {
        await removeBinding(chatId);
        await reply(chatId, "原绑定会话已被删除，已解除绑定，下一条消息会新建会话。");
        return true;
      }
      await reply(
        chatId,
        result.ok
          ? result.data?.aborted
            ? "已请求中止当前回合。"
            : "当前没有运行中的回合。"
          : `中止失败：${result.error ?? "未知原因"}`,
      );
      return true;
    }
    if (command === "/model") {
      const profiles = await ctx.metadata.get("apiProfiles");
      const list = profiles?.domains?.apiProfiles ?? [];
      const names = Array.isArray(list)
        ? list.map((item) => String(item?.profileName ?? "")).filter(Boolean)
        : [];
      if (!argument) {
        await reply(
          chatId,
          names.length
            ? `可用 API 档案：\n${names.join("\n")}\n用法：/model <档案名>，传 - 表示跟随全局激活档案。`
            : "没有可用的 API 档案。",
        );
        return true;
      }
      if (!binding) {
        await reply(chatId, "本聊天尚未绑定会话，先发送一条消息或使用 /new。");
        return true;
      }
      const profileName = argument === "-" ? "" : argument;
      if (profileName && !names.includes(profileName)) {
        await reply(chatId, `未知的 API 档案：${profileName}`);
        return true;
      }
      const result = await ctx.write.run("conversations.setApiProfile", {
        conversationId: binding.conversationId,
        apiProfile: profileName,
      });
      if (!result.ok && isMissingConversation(result.error)) {
        await removeBinding(chatId);
        await reply(chatId, "原绑定会话已被删除，已解除绑定，下一条消息会新建会话。");
        return true;
      }
      await reply(
        chatId,
        result.ok
          ? profileName
            ? `已把本会话绑定到档案 ${profileName}。`
            : "已恢复跟随全局激活档案。"
          : `切换失败：${result.error ?? "未知原因"}`,
      );
      return true;
    }
    await reply(chatId, `未知命令：${rawCommand}\n\n${helpText}`);
    return true;
  };

  /** 绑定会话已被删除（或换项目）时解绑并按原内容新建一条会话，保证还能继续用。 */
  const rebuildConversation = async ({ chatId, chatType, config, content }) => {
    await removeBinding(chatId);
    const binding = await ensureConversation({ chatId, chatType, config, title: "", content });
    if (!binding) {
      return null;
    }
    if (config.followActive) {
      await activate(binding.conversationId);
    }
    startTurn(chatId, binding.conversationId, "", config.pushMode !== "stream");
    return binding;
  };

  const deliver = async ({ chatId, chatType, text, attachments, config }) => {
    const content = [text, ...attachments].filter(Boolean).join("\n");
    if (!content.trim()) {
      await reply(chatId, "消息内容为空。");
      return;
    }
    const existing = await bindingFor(chatId);
    const conversationId = existing?.conversationId ?? "";
    if (conversationId) {
      const { items } = await readMessages(conversationId);
      const baselineId = Array.isArray(items)
        ? [...items].reverse().find((item) => item?.role === "assistant")?.id ?? ""
        : "";
      const sent = await ctx.write.run("conversations.sendMessage", {
        conversationId,
        text: content,
      });
      if (!sent.ok) {
        const error = String(sent.error ?? "未知原因");
        if (isMissingConversation(error)) {
          await store.log("warn", `绑定会话已不存在（${conversationId}），改为新建会话`);
          await reply(chatId, "原绑定会话已被删除，正在新建会话并重新绑定。");
          await rebuildConversation({ chatId, chatType, config, content });
          return;
        }
        await reply(chatId, `投递失败：${error}`);
        return;
      }
      if (config.followActive) {
        await activate(conversationId);
      }
      startTurn(chatId, conversationId, baselineId, config.pushMode !== "stream");
      await store.log("info", `已把消息投递到会话 ${conversationId}`);
      return;
    }

    const binding = await ensureConversation({
      chatId,
      chatType,
      config,
      title: "",
      content,
    });
    if (!binding) {
      return;
    }
    if (config.followActive) {
      await activate(binding.conversationId);
    }
    startTurn(chatId, binding.conversationId, "", config.pushMode !== "stream");
  };

  const handleEvent = async (event) => {
    const header = event?.header ?? {};
    if (header.event_type !== "im.message.receive_v1") {
      return;
    }
    const payload = event?.event ?? {};
    const message = payload.message;
    const sender = payload.sender;
    if (!message || !sender) {
      return;
    }
    if (sender.sender_type && sender.sender_type !== "user") {
      return;
    }
    if (seen([String(header.event_id ?? ""), String(message.message_id ?? "")])) {
      return;
    }
    const config = await store.config();
    const state = await store.state();
    const chatId = String(message.chat_id ?? "");
    const chatType = String(message.chat_type ?? "");
    const openId = String(sender.sender_id?.open_id ?? "");
    const isGroup = chatType === "group";
    await store.patchState({
      lastEventAt: Date.now(),
      stats: {
        received: (state.stats?.received ?? 0) + 1,
        ...(isGroup
          ? { receivedGroup: (state.stats?.receivedGroup ?? 0) + 1 }
          : { receivedDirect: (state.stats?.receivedDirect ?? 0) + 1 }),
      },
    });
    if (!config.enabled) {
      return;
    }
    if (!chatId) {
      return;
    }
    if (isGroup) {
      if (config.groupRequireMention && (message.mentions ?? []).length === 0) {
        return;
      }
    } else if (!config.allowAllDirect && !(config.allowOpenIds ?? []).includes(openId)) {
      await denyUnknown({ chatId, openId });
      return;
    }

    let parsed;
    try {
      parsed = await parseMessage({ message, config });
    } catch (error) {
      await store.log("error", `解析消息失败：${describe(error)}`);
      await reply(chatId, `处理消息失败：${describe(error)}`);
      return;
    }
    if (parsed.unsupported) {
      await reply(chatId, `暂不支持的消息类型：${parsed.unsupported}`);
      return;
    }

    const text = parsed.text ?? "";
    if (text.startsWith("/")) {
      await handleCommand({ chatId, chatType, text, config });
      return;
    }
    if (!text && parsed.attachments.length === 0) {
      return;
    }
    if (await resolvePending({ chatId, text })) {
      return;
    }
    await deliver({ chatId, chatType, text, attachments: parsed.attachments, config });
  };

  const flushOutbox = async () => {
    const list = await store.outbox();
    if (list.length === 0) {
      return;
    }
    const now = Date.now();
    if (now - lastOutboxAttempt < OUTBOX_RETRY_MS) {
      return;
    }
    lastOutboxAttempt = now;
    const remaining = [];
    for (const entry of list) {
      try {
        await withBearer((token) =>
          api.sendText({ bearer: token, chatId: entry.chatId, text: entry.text }),
        );
        await store.log("info", `补发已完成（${entry.chatId}）`);
      } catch {
        remaining.push(entry);
      }
    }
    await store.saveOutbox(remaining.slice(-20));
  };

  /** 每秒由后台模块调用：驱动回合回推、审批轮询与补发。 */
  const tick = async () => {
    tickCount += 1;
    await tickTurns();
    if (tickCount % APPROVAL_TICK_INTERVAL === 0) {
      await tickApprovals();
      await flushOutbox();
    }
  };

  const reset = () => {
    turns.clear();
    pending.clear();
  };

  return { handleEvent, tick, reset };
};
