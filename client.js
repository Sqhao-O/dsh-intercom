/**
 * dsh-intercom Web UI panel (browser half). Hand-written against the dsh
 * client module format — no build step: a CJS factory wrapped in the
 * `window.__ModuleLoader__.load` envelope, exporting the plugin's `inject`
 * and `apply` exactly like the shipped dual-face packages. React arrives
 * through the loader's `require`.
 *
 * One contribution: an "Intercom" page in the Settings panel
 * (`settings.section` list slot) listing the live intercom roster and a send
 * box. Data comes from the plugin's host routes (`/intercom/roster`,
 * `/intercom/send`, see src/panel.ts) via plain same-origin fetch — the panel
 * sends AS a session hosted by this dsh process, never as a pseudo-identity.
 */
function sessionLabel(session) {
  const name = session.name || "(unnamed)";
  return `${name} (${session.prefix})${session.local ? " · local" : ""}`;
}

window.__ModuleLoader__.load({
  id: "dsh-intercom",
  factory: (require) => {
    const module = { exports: {} };
    const React = require("react");
    const { useEffect, useState } = React;
    const h = React.createElement;

    const POLL_MS = 3000;

    const styles = {
      root: {
        display: "flex",
        flexDirection: "column",
        gap: 12,
        maxWidth: 640,
      },
      hint: { opacity: 0.7, fontSize: 13 },
      table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
      th: {
        textAlign: "left",
        opacity: 0.6,
        fontWeight: 500,
        padding: "4px 8px 4px 0",
      },
      td: { padding: "4px 8px 4px 0", verticalAlign: "top" },
      mono: { fontFamily: "monospace", fontSize: 12 },
      form: { display: "flex", flexDirection: "column", gap: 8 },
      row: { display: "flex", gap: 8 },
      select: { flex: 1, minWidth: 0 },
      textarea: { width: "100%", minHeight: 64, boxSizing: "border-box" },
      ok: { color: "#3fb950", fontSize: 13 },
      err: { color: "#f85149", fontSize: 13 },
    };

    function IntercomSection() {
      const [state, setState] = useState({ loading: true });
      const [from, setFrom] = useState("");
      const [to, setTo] = useState("");
      const [message, setMessage] = useState("");
      const [sendState, setSendState] = useState(null);
      const [sending, setSending] = useState(false);

      useEffect(() => {
        let stopped = false;
        async function poll() {
          try {
            const res = await fetch("/intercom/roster");
            const data = await res.json();
            if (!stopped) setState({ loading: false, roster: data });
          } catch (error) {
            if (!stopped) setState({ loading: false, error: String(error) });
          }
        }
        poll();
        const timer = setInterval(poll, POLL_MS);
        return () => {
          stopped = true;
          clearInterval(timer);
        };
      }, []);

      const roster = state.roster;
      const sessions = (roster && roster.sessions) || [];
      const senders = (roster && roster.senders) || [];
      const effectiveFrom = senders.some((s) => s.id === from)
        ? from
        : (senders[0] && senders[0].id) || "";
      const targets = sessions.filter((s) => s.id !== effectiveFrom);
      const effectiveTo = targets.some((s) => s.id === to)
        ? to
        : (targets[0] && targets[0].id) || "";

      async function send() {
        setSending(true);
        setSendState(null);
        try {
          const res = await fetch("/intercom/send", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              from: effectiveFrom,
              to: effectiveTo,
              message,
            }),
          });
          const data = await res.json();
          if (res.ok && data.delivered) {
            setSendState({ ok: true, text: "Delivered." });
            setMessage("");
          } else {
            setSendState({
              ok: false,
              text: data.error || data.reason || "Not delivered.",
            });
          }
        } catch (error) {
          setSendState({ ok: false, text: String(error) });
        } finally {
          setSending(false);
        }
      }

      if (state.loading)
        return h("div", { style: styles.hint }, "Loading intercom roster…");
      if (state.error)
        return h(
          "div",
          { style: styles.err },
          `Intercom roster unavailable: ${state.error}`,
        );
      if (roster && roster.enabled === false)
        return h(
          "div",
          { style: styles.hint },
          "dsh-intercom is disabled (enabled: false in $DSH_HOME/intercom/config.json).",
        );

      return h(
        "div",
        { style: styles.root },
        h(
          "div",
          { style: styles.hint },
          `Transport: ${roster.transport} · ${sessions.length} session(s) on this machine. ` +
            'Name a session from inside it with intercom({ action: "name", alias: "..." }).',
        ),
        sessions.length === 0
          ? h("div", { style: styles.hint }, "No sessions connected yet.")
          : h(
              "table",
              { style: styles.table },
              h(
                "thead",
                null,
                h(
                  "tr",
                  null,
                  h("th", { style: styles.th }, "Session"),
                  h("th", { style: styles.th }, "Status"),
                  h("th", { style: styles.th }, "Directory"),
                ),
              ),
              h(
                "tbody",
                null,
                sessions.map((session) =>
                  h(
                    "tr",
                    { key: session.id },
                    h(
                      "td",
                      { style: styles.td },
                      h("span", null, session.name || "(unnamed)"),
                      " ",
                      h("span", { style: styles.mono }, `(${session.prefix})`),
                      session.local
                        ? h("span", { style: styles.hint }, " · local")
                        : null,
                    ),
                    h("td", { style: styles.td }, session.status),
                    h(
                      "td",
                      { style: { ...styles.td, ...styles.mono } },
                      session.cwd || "",
                    ),
                  ),
                ),
              ),
            ),
        h(
          "div",
          { style: styles.hint },
          "Send a message as one of this host's sessions:",
        ),
        h(
          "div",
          { style: styles.form },
          h(
            "div",
            { style: styles.row },
            h(
              "select",
              {
                style: styles.select,
                value: effectiveFrom,
                onChange: (event) => setFrom(event.target.value),
              },
              senders.length === 0
                ? h("option", { value: "" }, "no local session can send")
                : senders.map((s) =>
                    h(
                      "option",
                      { key: s.id, value: s.id },
                      `from: ${s.name || "(unnamed)"} (${s.id.slice(0, 8)})`,
                    ),
                  ),
            ),
            h(
              "select",
              {
                style: styles.select,
                value: effectiveTo,
                onChange: (event) => setTo(event.target.value),
              },
              targets.length === 0
                ? h("option", { value: "" }, "no target session")
                : targets.map((s) =>
                    h(
                      "option",
                      { key: s.id, value: s.id },
                      `to: ${sessionLabel(s)}`,
                    ),
                  ),
            ),
          ),
          h("textarea", {
            style: styles.textarea,
            value: message,
            placeholder: "Message text…",
            onChange: (event) => setMessage(event.target.value),
          }),
          h(
            "div",
            { style: styles.row },
            h(
              "button",
              {
                disabled:
                  sending || !effectiveFrom || !effectiveTo || !message.trim(),
                onClick: send,
              },
              sending ? "Sending…" : "Send",
            ),
            sendState &&
              h(
                "span",
                { style: sendState.ok ? styles.ok : styles.err },
                sendState.text,
              ),
          ),
        ),
      );
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "intercom",
            order: 90,
            label: "Intercom",
          },
          IntercomSection,
        ),
      );
    }

    module.exports = { name: "dsh-intercom", inject: ["slots"], apply };
    return module.exports;
  },
});
