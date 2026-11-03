/**
 * 飞书连接设置面板。
 *
 * 面板以 ESM blob 方式加载，不能用相对导入，因此本文件自成一体；配置写入插件
 * 存储（后台模块每秒读取生效），App Secret 通过一次性交接键交给后台写入系统
 * 安全存储（面板本身没有写入密钥的能力）。
 */

/** 与 lib/store.mjs 的 DEFAULT_CONFIG 保持一致。 */
const CONFIG_DEFAULTS = {
  appId: "",
  enabled: true,
  directoryId: "",
  apiProfile: "",
  groupRequireMention: true,
  allowAllDirect: false,
  allowOpenIds: [],
  ignoredOpenIds: [],
  pushMode: "stream",
  followActive: true,
  forwardApprovals: true,
  maxAttachmentMb: 20,
};

const STATE_DEFAULTS = {
  status: "idle",
  detail: "",
  hasSecret: false,
  appId: "",
  connectedAt: 0,
  lastEventAt: 0,
  stats: {},
  pendingUsers: [],
  logs: [],
};

const STATUS_LABELS = {
  idle: "未启动",
  connecting: "连接中",
  online: "已连接",
  reconnecting: "重连中",
  error: "连接失败",
};

const formatTime = (value) => {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  const pad = (input) => String(input).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const formatDateTime = (value) => {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  const pad = (input) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** 飞书官方标识（与 assets/feishu.svg 同一份路径数据），面板标题处内联渲染。 */
const FEISHU_MARK_PATHS = [
  {
    d: "M10 8c0 1 7 3.5 14.745 16.744 0 0 4.184-4.363 6.255-5.744 1.5-1 2.712-1.332 2.712-1.332C33.712 15.156 29.5 8 28 8z",
    fill: "#00d6b9",
  },
  {
    d: "M43.5 18.5c-1-.667-3.65-1.771-6.5-1.5a15 15 0 0 0-3.288.668S32.5 18 31 19c-2.07 1.38-6.255 5.744-6.255 5.744-1.428 1.397-3.05 2.732-5.245 3.756 0 0 7 3 11.5 3 5.063 0 7-3.5 7-3.5 1.5-3.305 3.5-7 5.5-9.5",
    fill: "#163c9a",
  },
  {
    d: "M4 17.5v17c0 1 6 5.5 15 5.5 10 0 17.05-7.705 19-12 0 0-1.937 3.5-7 3.5-4.5 0-11.5-3-11.5-3-5.117-2.239-10.03-6.577-12.906-9.117C4.974 17.953 4 17.093 4 17.5",
    fill: "#3370ff",
  },
];

const feishuMark = (h, size) =>
  h(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 48 48",
      fill: "none",
      "aria-hidden": "true",
    },
    FEISHU_MARK_PATHS.map((path, index) =>
      h("path", { key: index, d: path.d, fill: path.fill }),
    ),
  );

export default function FeishuPanel({ api }) {
  const React = api.ui.React;
  const h = React.createElement;
  const { useCallback, useEffect, useMemo, useState } = React;
  const t = useCallback(
    (key, fallback) => api.t(key, { defaultValue: fallback }),
    [api],
  );

  const [rows, setRows] = useState({});
  const [projects, setProjects] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [draft, setDraft] = useState({ appId: "", appSecret: "" });
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const readAll = useCallback(async () => {
    try {
      const list = await window.snow.getPluginValues(api.id);
      const next = {};
      for (const row of list) {
        next[row.key] = row.value;
      }
      setRows(next);
    } catch (error) {
      api.log("读取插件存储失败，改用面板缓存", error);
      setRows(await api.storage.all());
    }
  }, [api]);

  const parse = useCallback(
    (key, fallback) => {
      try {
        const raw = rows[key];
        if (!raw) {
          return fallback;
        }
        const value = JSON.parse(raw);
        if (value === null || typeof value !== "object") {
          return fallback;
        }
        if (Array.isArray(fallback)) {
          return Array.isArray(value) ? value : fallback;
        }
        return Array.isArray(value) ? fallback : { ...fallback, ...value };
      } catch (error) {
        api.log(`解析 ${key} 失败`, error);
        return fallback;
      }
    },
    [api, rows],
  );

  const config = useMemo(() => parse("config", CONFIG_DEFAULTS), [parse]);
  const state = useMemo(() => parse("state", STATE_DEFAULTS), [parse]);
  const bindings = useMemo(() => parse("bindings", {}), [parse]);

  useEffect(() => {
    void readAll();
    const timer = window.setInterval(() => {
      void readAll();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [readAll]);

  useEffect(() => {
    setDraft((current) =>
      current.appId === "" ? { appId: config.appId ?? "", appSecret: "" } : current,
    );
  }, [config.appId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.metadata.get(["projects", "apiProfiles"]);
        if (cancelled) {
          return;
        }
        setProjects(response?.domains?.projects?.directories ?? []);
        const list = response?.domains?.apiProfiles;
        setProfiles(Array.isArray(list) ? list : []);
      } catch (error) {
        api.log("读取项目 / API 档案失败", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const patchConfig = useCallback(
    async (patch) => {
      setBusy(true);
      try {
        const next = { ...config, ...patch };
        await api.storage.setJson("config", next);
        setRows((current) => ({ ...current, config: JSON.stringify(next) }));
        setNotice(t("feishu.saved", "已保存，后台 1 秒内生效"));
      } catch (error) {
        setNotice(`${t("feishu.saveFailed", "保存失败")}：${error?.message ?? error}`);
      } finally {
        setBusy(false);
      }
    },
    [api, config, t],
  );

  const saveCredentials = useCallback(async () => {
    const appId = String(draft.appId ?? "").trim();
    const appSecret = String(draft.appSecret ?? "").trim();
    if (!appId) {
      setNotice(t("feishu.needAppId", "请先填写 App ID"));
      return;
    }
    setBusy(true);
    try {
      const next = { ...config, appId };
      await api.storage.setJson("config", next);
      setRows((current) => ({ ...current, config: JSON.stringify(next) }));
      if (appSecret) {
        await api.storage.setJson("handoff", {
          appId,
          appSecret,
          at: Date.now(),
        });
        setNotice(t("feishu.secretQueued", "已提交，后台正在写入系统安全存储"));
      } else {
        setNotice(t("feishu.saved", "已保存，后台 1 秒内生效"));
      }
      setDraft({ appId, appSecret: "" });
    } catch (error) {
      setNotice(`${t("feishu.saveFailed", "保存失败")}：${error?.message ?? error}`);
    } finally {
      setBusy(false);
    }
  }, [api, config, draft, t]);

  const clearSecret = useCallback(async () => {
    setBusy(true);
    try {
      await api.storage.setJson("handoff", { clear: true, at: Date.now() });
      setNotice(t("feishu.secretClearing", "已提交，后台正在清除系统安全存储中的密钥"));
    } finally {
      setBusy(false);
    }
  }, [api, t]);

  const icon = useCallback(
    (name, size = 16) => {
      const Component = api.ui.icon(name);
      return Component ? h(Component, { size, strokeWidth: 1.8 }) : null;
    },
    [api, h],
  );

  const status = STATUS_LABELS[state.status] ?? state.status ?? "未启动";
  const statusClass = `feishu-status feishu-status-${state.status ?? "idle"}`;
  const allowOpenIds = config.allowOpenIds ?? [];
  const pendingUsers = (state.pendingUsers ?? []).filter(
    (item) => !allowOpenIds.includes(item.openId),
  );
  const bindingRows = Object.entries(bindings ?? {});

  const row = (label, hint, control) =>
    h(
      "div",
      { className: "feishu-row", key: label },
      h(
        "div",
        { className: "feishu-row-label" },
        h("span", { className: "feishu-row-title" }, label),
        hint ? h("span", { className: "feishu-row-hint" }, hint) : null,
      ),
      h("div", { className: "feishu-row-control" }, control),
    );

  const toggle = (label, hint, checked, onChange) =>
    row(
      label,
      hint,
      h(
        "label",
        { className: "toggle-switch" },
        h("input", {
          type: "checkbox",
          checked: Boolean(checked),
          disabled: busy,
          onChange: (event) => void onChange(event.target.checked),
        }),
        h("span", { className: "toggle-slider" }),
        h("span", { className: "feishu-toggle-text" }, checked ? "开" : "关"),
      ),
    );

  const section = (title, ...children) =>
    h(
      "section",
      { className: "feishu-section" },
      h("h3", { className: "feishu-section-title" }, title),
      ...children,
    );

  return h(
    "div",
    { className: "feishu-panel" },
    h(
      "header",
      { className: "feishu-header" },
      h(
        "div",
        { className: "feishu-header-title" },
        feishuMark(h, 18),
        h("span", null, t("feishu.title", "飞书连接")),
      ),
      h(
        "div",
        { className: "feishu-header-meta" },
        h("span", { className: statusClass }, status),
        h(
          "button",
          {
            className: "nav-item feishu-icon-button",
            type: "button",
            title: t("feishu.refresh", "刷新"),
            onClick: () => void readAll(),
          },
          icon("RefreshCw", 15),
        ),
      ),
    ),
    state.detail
      ? h("div", { className: "feishu-banner" }, state.detail)
      : null,
    notice ? h("div", { className: "feishu-notice" }, notice) : null,

    section(
      t("feishu.section.credentials", "应用凭证"),
      h(
        "div",
        { className: "feishu-credentials" },
        row(
          "App ID",
          t("feishu.appIdHint", "飞书开放平台 → 自建应用 → 凭证与基础信息"),
          h("input", {
            className: "feishu-input",
            type: "text",
            value: draft.appId,
            placeholder: "cli_xxxxxxxxxxxx",
            spellCheck: false,
            disabled: busy,
            onChange: (event) =>
              setDraft((current) => ({ ...current, appId: event.target.value })),
          }),
        ),
        row(
          "App Secret",
          state.hasSecret
            ? t("feishu.secretSaved", "已保存到系统安全存储（留空表示不修改）")
            : t("feishu.secretEmpty", "尚未保存，将写入系统安全存储"),
          h("input", {
            className: "feishu-input",
            type: "password",
            value: draft.appSecret,
            placeholder: state.hasSecret ? "••••••••" : "App Secret",
            spellCheck: false,
            disabled: busy,
            onChange: (event) =>
              setDraft((current) => ({ ...current, appSecret: event.target.value })),
          }),
        ),
        h(
          "div",
          { className: "feishu-actions" },
          h(
            "button",
            {
              className: "feishu-primary",
              type: "button",
              disabled: busy,
              onClick: () => void saveCredentials(),
            },
            t("feishu.save", "保存凭证"),
          ),
          state.hasSecret
            ? h(
                "button",
                {
                  className: "nav-item feishu-secondary",
                  type: "button",
                  disabled: busy,
                  onClick: () => void clearSecret(),
                },
                t("feishu.clearSecret", "清除密钥"),
              )
            : null,
        ),
        h(
          "p",
          { className: "feishu-tip" },
          t(
            "feishu.setupTip",
            "在飞书开放平台创建自建应用后：开启「事件与回调 → 使用长连接接收事件」，订阅 im.message.receive_v1；权限管理里开通 im:message、im:message.p2p_msg:readonly、im:message.group_at_msg:readonly、im:message:send_as_bot、im:resource，然后发布版本。只开 im:message 收不到私聊消息；缺 im:resource 时收得到文字但下载不了图片/文件。",
          ),
        ),
      ),
    ),

    section(
      t("feishu.section.runtime", "运行设置"),
      toggle(
        t("feishu.enabled", "启用飞书入口"),
        t("feishu.enabledHint", "关闭后不建立长连接，也不响应任何消息"),
        config.enabled,
        (value) => void patchConfig({ enabled: value }),
      ),
      row(
        t("feishu.directory", "默认项目"),
        t("feishu.directoryHint", "新会话创建在该项目下"),
        h(
          "select",
          {
            className: "feishu-select",
            value: config.directoryId ?? "",
            disabled: busy,
            onChange: (event) =>
              void patchConfig({ directoryId: event.target.value }),
          },
          h("option", { value: "" }, t("feishu.none", "未选择")),
          projects.map((item) =>
            h(
              "option",
              { key: item.directoryId, value: item.directoryId },
              item.name || item.path || item.directoryId,
            ),
          ),
        ),
      ),
      row(
        t("feishu.apiProfile", "API 档案"),
        t("feishu.apiProfileHint", "新建会话时绑定的档案，留空跟随全局"),
        h(
          "select",
          {
            className: "feishu-select",
            value: config.apiProfile ?? "",
            disabled: busy,
            onChange: (event) =>
              void patchConfig({ apiProfile: event.target.value }),
          },
          h("option", { value: "" }, t("feishu.followGlobal", "跟随全局")),
          profiles.map((item) =>
            h(
              "option",
              { key: item.profileName, value: item.profileName },
              item.profileName,
            ),
          ),
        ),
      ),
      row(
        t("feishu.pushMode", "回复方式"),
        t("feishu.pushModeHint", "流式回推会按 1 秒节流持续编辑同一条消息"),
        h(
          "select",
          {
            className: "feishu-select",
            value: config.pushMode ?? "stream",
            disabled: busy,
            onChange: (event) => void patchConfig({ pushMode: event.target.value }),
          },
          h("option", { value: "stream" }, t("feishu.pushStream", "流式回推")),
          h("option", { value: "final" }, t("feishu.pushFinal", "仅最终结果")),
        ),
      ),
      toggle(
        t("feishu.groupMention", "群聊需 @机器人"),
        t("feishu.groupMentionHint", "未 @机器人 的群消息不响应"),
        config.groupRequireMention,
        (value) => void patchConfig({ groupRequireMention: value }),
      ),
      toggle(
        t("feishu.allowAll", "允许所有私聊"),
        t("feishu.allowAllHint", "关闭时只响应白名单内的用户"),
        config.allowAllDirect,
        (value) => void patchConfig({ allowAllDirect: value }),
      ),
      toggle(
        t("feishu.followActive", "驱动时切换桌面焦点"),
        t("feishu.followActiveHint", "与手机远控一致：把桌面切到该会话，审批回包才可用"),
        config.followActive,
        (value) => void patchConfig({ followActive: value }),
      ),
      toggle(
        t("feishu.forwardApprovals", "转发待审批与提问"),
        t("feishu.forwardApprovalsHint", "把当前激活会话的待授权 / 待答提问推到飞书"),
        config.forwardApprovals,
        (value) => void patchConfig({ forwardApprovals: value }),
      ),
    ),

    section(
      t("feishu.section.allow", "私聊白名单"),
      pendingUsers.length
        ? h(
            "div",
            { className: "feishu-list" },
            pendingUsers.map((item) =>
              h(
                "div",
                { className: "feishu-list-row", key: item.openId },
                h(
                  "div",
                  { className: "feishu-list-main" },
                  h("span", { className: "feishu-list-title" }, item.name || t("feishu.unknownUser", "未知用户")),
                  h("span", { className: "feishu-list-sub" }, item.openId),
                ),
                h(
                  "div",
                  { className: "feishu-list-actions" },
                  h(
                    "button",
                    {
                      className: "nav-item feishu-secondary",
                      type: "button",
                      disabled: busy,
                      onClick: () =>
                        void patchConfig({
                          allowOpenIds: [...new Set([...allowOpenIds, item.openId])],
                        }),
                    },
                    t("feishu.approve", "批准"),
                  ),
                  h(
                    "button",
                    {
                      className: "nav-item feishu-secondary",
                      type: "button",
                      disabled: busy,
                      onClick: () =>
                        void patchConfig({
                          ignoredOpenIds: [
                            ...new Set([...(config.ignoredOpenIds ?? []), item.openId]),
                          ],
                        }),
                    },
                    t("feishu.ignore", "忽略"),
                  ),
                ),
              ),
            ),
          )
        : h(
            "p",
            { className: "feishu-empty" },
            t("feishu.noPending", "暂无待批准的用户"),
          ),
      h(
        "div",
        { className: "feishu-list" },
        allowOpenIds.length
          ? allowOpenIds.map((openId) =>
              h(
                "div",
                { className: "feishu-list-row", key: openId },
                h(
                  "div",
                  { className: "feishu-list-main" },
                  h("span", { className: "feishu-list-title" }, t("feishu.allowed", "已授权")),
                  h("span", { className: "feishu-list-sub" }, openId),
                ),
                h(
                  "button",
                  {
                    className: "nav-item feishu-secondary",
                    type: "button",
                    disabled: busy,
                    onClick: () =>
                      void patchConfig({
                        allowOpenIds: allowOpenIds.filter((id) => id !== openId),
                      }),
                  },
                  t("feishu.remove", "移除"),
                ),
              ),
            )
          : h(
              "p",
              { className: "feishu-empty" },
              config.allowAllDirect
                ? t("feishu.allAllowed", "已允许所有私聊")
                : t("feishu.noAllowed", "白名单为空，私聊消息会被拒绝并在此出现"),
            ),
      ),
      h(
        "p",
        { className: "feishu-tip" },
        t(
          "feishu.directTip",
          "私聊收不到消息？飞书只开通 im:message 时不会推送单聊事件，需要在权限管理里额外开通 im:message.p2p_msg:readonly（群聊对应 im:message.group_at_msg:readonly）。",
        ),
      ),
    ),

    section(
      t("feishu.section.bindings", "会话绑定"),
      bindingRows.length
        ? h(
            "div",
            { className: "feishu-list" },
            bindingRows.map(([chatId, binding]) =>
              h(
                "div",
                { className: "feishu-list-row", key: chatId },
                h(
                  "div",
                  { className: "feishu-list-main" },
                  h(
                    "span",
                    { className: "feishu-list-title" },
                    binding?.title || t("feishu.bound", "已绑定会话"),
                  ),
                  h(
                    "span",
                    { className: "feishu-list-sub" },
                    `${chatId} → ${binding?.conversationId ?? ""}`,
                  ),
                  h(
                    "span",
                    { className: "feishu-list-sub" },
                    formatDateTime(binding?.updatedAt),
                  ),
                ),
                h(
                  "button",
                  {
                    className: "nav-item feishu-secondary",
                    type: "button",
                    disabled: busy,
                    onClick: () => {
                      const next = { ...bindings };
                      delete next[chatId];
                      void api.storage
                        .setJson("bindings", next)
                        .then(() => setNotice(t("feishu.unbound", "已解除绑定")));
                    },
                  },
                  t("feishu.unbind", "解绑"),
                ),
              ),
            ),
          )
        : h(
            "p",
            { className: "feishu-empty" },
            t("feishu.noBindings", "还没有绑定的会话，在飞书里发一条消息即可自动创建"),
          ),
    ),

    section(
      t("feishu.section.status", "运行状态"),
      h(
        "div",
        { className: "feishu-stats" },
        h("span", null, `${t("feishu.stat.received", "收到")} ${state.stats?.received ?? 0}`),
        h("span", null, `${t("feishu.stat.direct", "私聊")} ${state.stats?.receivedDirect ?? 0}`),
        h("span", null, `${t("feishu.stat.group", "群聊")} ${state.stats?.receivedGroup ?? 0}`),
        h("span", null, `${t("feishu.stat.delivered", "投递")} ${state.stats?.delivered ?? 0}`),
        h("span", null, `${t("feishu.stat.denied", "拒绝")} ${state.stats?.denied ?? 0}`),
        h("span", null, `${t("feishu.stat.connectedAt", "连接于")} ${formatTime(state.connectedAt)}`),
        h("span", null, `${t("feishu.stat.lastEvent", "最近事件")} ${formatTime(state.lastEventAt)}`),
      ),
      h(
        "div",
        { className: "feishu-logs" },
        (state.logs ?? []).length
          ? [...(state.logs ?? [])]
              .slice(-20)
              .reverse()
              .map((entry, index) =>
                h(
                  "div",
                  {
                    className: `feishu-log feishu-log-${entry.level ?? "info"}`,
                    key: `${entry.at}-${index}`,
                  },
                  h("span", { className: "feishu-log-time" }, formatTime(entry.at)),
                  h("span", { className: "feishu-log-text" }, entry.text),
                ),
              )
          : h("p", { className: "feishu-empty" }, t("feishu.noLogs", "暂无日志")),
      ),
    ),
  );
}
