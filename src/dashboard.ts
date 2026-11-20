export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Circe-Core</title>
<style>
  :root { --bg:#140b1b; --panel:#1e1229; --line:#33204a; --ink:#f3e9ff; --muted:#a893be; --accent:#e070ff; --ok:#57d98b; --bad:#ff6b81; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 "Segoe UI", system-ui, sans-serif; }
  header { display:flex; align-items:baseline; gap:12px; padding:18px 24px; border-bottom:1px solid var(--line); }
  header h1 { margin:0; font-size:20px; letter-spacing:.5px; color:var(--accent); }
  header .sub { color:var(--muted); font-size:12px; }
  #status { margin-left:auto; font-size:12px; padding:2px 10px; border-radius:999px; border:1px solid var(--line); }
  #status.ok { color:var(--ok); border-color:var(--ok); }
  #status.bad { color:var(--bad); border-color:var(--bad); }
  main { display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:16px; padding:20px 24px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; min-width:0; }
  .card h2 { margin:0 0 10px; font-size:12px; text-transform:uppercase; letter-spacing:1.2px; color:var(--muted); }
  .row { display:flex; justify-content:space-between; gap:12px; padding:3px 0; border-bottom:1px dashed rgba(255,255,255,.05); }
  .row:last-child { border-bottom:0; }
  .row span:last-child { color:var(--accent); font-variant-numeric:tabular-nums; }
  .chat { max-height:260px; overflow:auto; }
  .chat .msg { padding:4px 0; }
  .chat .who { color:var(--accent); font-weight:600; }
  form { display:flex; flex-direction:column; gap:8px; }
  textarea, input { background:#120a1a; color:var(--ink); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font:inherit; }
  textarea { resize:vertical; min-height:64px; }
  button { align-self:flex-start; background:var(--accent); color:#1a0b22; border:0; border-radius:8px; padding:8px 16px; font-weight:700; cursor:pointer; }
  button:disabled { opacity:.5; cursor:wait; }
  pre { margin:10px 0 0; padding:10px; background:#120a1a; border:1px solid var(--line); border-radius:8px; font-size:12px; white-space:pre-wrap; word-break:break-word; max-height:180px; overflow:auto; }
  #events { max-height:280px; overflow:auto; font-family:Consolas, monospace; font-size:12px; }
  #events div { padding:2px 0; border-bottom:1px dashed rgba(255,255,255,.05); }
  #events .type { display:inline-block; min-width:110px; color:var(--accent); }
  .hint { color:var(--muted); font-size:12px; }
  footer { padding:0 24px 24px; color:var(--muted); font-size:12px; }
  footer a { color:var(--accent); }
</style>
</head>
<body>
<header>
  <h1>Circe-Core</h1>
  <span class="sub">witch of Aeaea, recompiled</span>
  <span id="status">connecting</span>
</header>
<main>
  <section class="card">
    <h2>Cyber-sorcery</h2>
    <div id="mana" class="hint">sampling...</div>
  </section>

  <section class="card">
    <h2>Live avatars</h2>
    <div id="params" class="hint">no VTube Studio data</div>
  </section>

  <section class="card" id="vision-card" hidden>
    <h2>Stream vision</h2>
    <img id="vision" alt="latest stream frame" style="width:100%;border-radius:8px;border:1px solid var(--line);">
    <div id="vision-meta" class="hint"></div>
  </section>

  <section class="card" id="goals-card" hidden>
    <h2>Active goal</h2>
    <div id="goal-description" style="font-weight:600;margin-bottom:6px;">none</div>
    <div id="goal-plan" style="margin-bottom:8px;"></div>
    <div style="display:flex;gap:8px;align-items:center;">
      <button id="goal-advance-btn" type="button" style="font-size:12px;padding:4px 10px;">Advance step</button>
      <div id="goal-pending" class="hint"></div>
    </div>
  </section>

  <section class="card" id="gamer-card" hidden>
    <h2>Gameplay (talker + gamer)</h2>
    <div id="gamer-log" class="chat hint">waiting for the first tick…</div>
    <div style="display:flex;gap:8px;align-items:center;margin-top:8px;">
      <button id="game-step-btn" type="button" style="font-size:12px;padding:4px 10px;">Step</button>
      <span id="gamer-state" class="hint"></span>
    </div>
  </section>

  <section class="card">
    <h2>Chat</h2>
    <div id="chat" class="chat hint">no messages yet</div>
  </section>

  <section class="card">
    <h2>Make Circe speak</h2>
    <form id="reply-form">
      <textarea id="reply-text" placeholder="*giggles* Something for Master~"></textarea>
      <button type="submit">Send reply</button>
    </form>
    <pre id="reply-out" hidden></pre>
    <div id="voice-chat-status" class="hint" style="margin-top:8px;"></div>
  </section>

  <section class="card">
    <h2>Memory</h2>
    <div id="memory" class="chat hint">no memories yet</div>
    <form id="remember-form">
      <input id="remember-text" placeholder="A fact worth keeping">
      <input id="remember-tags" placeholder="tags (comma separated)">
      <button type="submit">Remember</button>
    </form>
  </section>

  <section class="card" id="viewers-card">
    <h2>Chatters &amp; Relationships</h2>
    <div id="viewers" class="chat hint">no chatters tracked yet</div>
  </section>

  <section class="card">
    <h2>Session recap</h2>
    <p class="hint">Distill this session into memories she keeps for the next stream.</p>
    <button id="recap-btn" type="button">Write recap</button>
    <pre id="recap-out" hidden></pre>
  </section>

  <section class="card">
    <h2>Ask Circe</h2>
    <form id="ask-form">
      <textarea id="ask-message" placeholder="Chat, what shall we brew tonight?"></textarea>
      <label class="hint" style="display:flex;align-items:center;gap:6px;">
        <input type="checkbox" id="ask-reflect"> two-pass reflection (draft → critique → final)
      </label>
      <label class="hint" style="display:flex;align-items:center;gap:6px;">
        <input type="checkbox" id="ask-tools"> tool envelope (query context / mana / memory)
      </label>
      <label class="hint" style="display:flex;align-items:center;gap:6px;">
        <input type="checkbox" id="ask-stream"> stream reply (speak while she thinks)
      </label>
      <button type="submit">Think &amp; speak</button>
    </form>
    <pre id="ask-out" hidden></pre>
  </section>

  <section class="card">
    <h2>Two-hander duet</h2>
    <p class="hint">Circe and Evil Neuro trade lines on one topic.</p>
    <form id="duet-form">
      <input id="duet-topic" placeholder="a midnight tea party">
      <input id="duet-turns" type="number" min="2" max="12" value="4" style="width:72px;">
      <button type="submit">Duet</button>
    </form>
    <div id="duet-out" class="chat" hidden></div>
  </section>

  <section class="card">
    <h2>Inject chat</h2>
    <form id="chat-form">
      <input id="chat-user" placeholder="user" value="Master">
      <input id="chat-message" placeholder="message">
      <button type="submit">Post chat</button>
    </form>
  </section>

  <section class="card">
    <h2>Event stream</h2>
    <div id="events"></div>
  </section>
</main>
<footer>
  Raw JSON: <a href="/?format=json">/?format=json</a> &middot; SSE: <a href="/events">/events</a> &middot; Endpoints: /health /context /mana /params /memory
</footer>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function row(label, value) {
    var r = el("div", "row");
    r.appendChild(el("span", "", label));
    r.appendChild(el("span", "", value));
    return r;
  }

  function renderGameEvent(event) {
    var card = $("gamer-card");
    card.hidden = false;
    var log = $("gamer-log");
    if (log.classList.contains("hint")) {
      log.classList.remove("hint");
      log.textContent = "";
    }
    var line = el("div");
    if (event.type === "game-action") {
      var text = String(event.kind || "action");
      if (event.input) text += " (" + event.input + ")";
      if (event.note) text += " — " + event.note;
      line.textContent = text;
    } else if (event.type === "game-commentary") {
      line.className = "hint";
      line.textContent = '"' + String(event.text || "") + '"';
    } else {
      line.className = "hint";
      line.textContent = String(event.detail || event.type);
    }
    log.appendChild(line);
    while (log.childNodes.length > 30) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  $("game-step-btn").addEventListener("click", async function () {
    var out = $("gamer-state");
    out.textContent = "stepping…";
    try {
      var res = await fetch("/game/step", { method: "POST" });
      var data = await res.json();
      out.textContent = data.ok
        ? (data.action ? "action: " + data.action.kind : "no action")
        : (data.error || "gamer disabled");
    } catch (err) {
      out.textContent = "request failed";
    }
  });

  function renderMana(mana) {
    var host = $("mana");
    host.className = "";
    host.textContent = "";
    if (mana.context) {
      host.appendChild(row("Memory pool", mana.context.used + " / " + mana.context.total + " tokens"));
    } else {
      host.appendChild(row("Memory pool", "unattuned"));
    }
    host.appendChild(row("Spell lattice", Math.round(mana.cpu.load * 100) + "% of " + mana.cpu.cores + " cores"));
    if (mana.gpu) {
      host.appendChild(row("Mana reserves", (mana.gpu.usedMB / 1024).toFixed(1) + " / " + (mana.gpu.totalMB / 1024).toFixed(1) + " GB"));
      host.appendChild(row("Crystal", mana.gpu.name));
    } else {
      host.appendChild(row("Mana reserves", "no NVIDIA crystal"));
    }
    host.appendChild(row("System spirits", (mana.memory.used / 1073741824).toFixed(1) + " / " + (mana.memory.total / 1073741824).toFixed(1) + " GB"));
  }

  function renderParams(live) {
    var host = $("params");
    host.className = "";
    host.textContent = "";
    var names = Object.keys(live.params || {});
    if (names.length === 0 && !live.face) {
      host.className = "hint";
      host.textContent = "no VTube Studio data";
      return;
    }
    names.forEach(function (name) {
      host.appendChild(row(name, Number(live.params[name]).toFixed(3)));
    });
    if (live.face) {
      host.appendChild(row("Face found", live.face.found ? "yes" : "no"));
      if (typeof live.face.mouthOpen === "number") {
        host.appendChild(row("Mouth open", Number(live.face.mouthOpen).toFixed(3)));
      }
    }
  }

  function renderChat(chat) {
    var host = $("chat");
    host.textContent = "";
    if (!chat || chat.length === 0) {
      host.className = "chat hint";
      host.textContent = "no messages yet";
      return;
    }
    host.className = "chat";
    chat.slice(-20).forEach(function (m) {
      var line = el("div", "msg");
      line.appendChild(el("span", "who", m.user + ": "));
      line.appendChild(document.createTextNode(m.message));
      host.appendChild(line);
    });
    host.scrollTop = host.scrollHeight;
  }

  function renderMemory(facts) {
    var host = $("memory");
    host.textContent = "";
    if (!facts || facts.length === 0) {
      host.className = "chat hint";
      host.textContent = "no memories yet";
      return;
    }
    host.className = "chat";
    facts.forEach(function (fact) {
      var line = el("div", "msg");
      line.appendChild(document.createTextNode(fact.text));
      if (fact.tags && fact.tags.length) {
        line.appendChild(el("span", "who", " [" + fact.tags.join(", ") + "]"));
      }
      host.appendChild(line);
    });
  }

  function renderViewers(viewers) {
    var host = $("viewers");
    host.textContent = "";
    if (!viewers || viewers.length === 0) {
      host.className = "chat hint";
      host.textContent = "no chatters tracked yet";
      return;
    }
    host.className = "chat";
    viewers.slice(0, 15).forEach(function (v) {
      var line = el("div", "msg");
      var sign = v.affinity > 0 ? "+" + v.affinity : String(v.affinity);
      var tag = "[" + v.tier + " | " + sign + " | " + v.messageCount + " msgs]";
      line.appendChild(el("span", "who", v.user + " "));
      line.appendChild(el("span", "hint", tag));
      if (v.notes && v.notes.length) {
        line.appendChild(document.createTextNode(" — " + v.notes.join("; ")));
      }
      host.appendChild(line);
    });
  }

  async function refresh() {
    try {
      var health = await (await fetch("/health")).json();
      $("status").textContent = health.ok ? "awake" : "asleep";
      $("status").className = health.ok ? "ok" : "bad";
    } catch (err) {
      $("status").textContent = "unreachable";
      $("status").className = "bad";
      return;
    }
    try { renderMana(await (await fetch("/mana")).json()); } catch (err) {}
    try { renderParams(await (await fetch("/params")).json()); } catch (err) {}
    try { renderMemory((await (await fetch("/memory?limit=8")).json()).facts); } catch (err) {}
    try { renderViewers((await (await fetch("/viewers?sort=messages&limit=15")).json()).viewers); } catch (err) {}
    try { renderChat((await (await fetch("/context")).json()).chat); } catch (err) {}
    try {
      var vc = await (await fetch("/voicechat")).json();
      var vcHost = $("voice-chat-status");
      if (vcHost) vcHost.textContent = vc.ok ? (vc.running ? "voice chat: listening" : "voice chat: paused") : (vc.error ? "voice chat: " + vc.error : "voice chat: paused");
    } catch (err) {}
    renderVision();
    renderGoals();
  }

  function renderGoals() {
    fetch("/goals")
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.ok) return;
        var card = $("goals-card");
        card.hidden = !data.active;
        if (!data.active) return;
        $("goal-description").textContent = data.active.description;
        var planHost = $("goal-plan");
        planHost.innerHTML = "";
        var steps = data.active.steps || [];
        var currentIdx = data.active.stepIndex || 0;
        if (steps.length > 0) {
          steps.forEach(function (step, idx) {
            var row = document.createElement("div");
            row.style.fontSize = "13px";
            row.style.margin = "3px 0";
            if (idx < currentIdx) {
              row.style.opacity = "0.5";
              row.textContent = "✓ Step " + (idx + 1) + ": " + step.description;
            } else if (idx === currentIdx) {
              row.style.fontWeight = "bold";
              row.style.color = "var(--accent)";
              row.textContent = "→ Step " + (idx + 1) + ": " + step.description + (step.tactic ? " (" + step.tactic + ")" : "");
            } else {
              row.style.opacity = "0.7";
              row.textContent = "○ Step " + (idx + 1) + ": " + step.description;
            }
            planHost.appendChild(row);
          });
          $("goal-advance-btn").style.display = currentIdx < steps.length - 1 ? "inline-block" : "none";
        } else {
          $("goal-advance-btn").style.display = "none";
        }
        var pending = (data.pending || []).map(function (goal) { return goal.description; });
        $("goal-pending").textContent =
          pending.length > 0 ? "queued: " + pending.join(" · ") : "";
      })
      .catch(function () {});
  }

  function renderVision() {
    var card = $("vision-card");
    var img = $("vision");
    img.onload = function () {
      card.hidden = false;
    };
    img.onerror = function () {
      card.hidden = true;
    };
    img.src = "/vision?t=" + Date.now();
    fetch("/vision?format=json")
      .then(function (res) { return res.json(); })
      .then(function (meta) {
        if (meta.ok) $("vision-meta").textContent = new Date(meta.ts).toLocaleTimeString();
      })
      .catch(function () {});
  }

  $("remember-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var text = $("remember-text").value.trim();
    if (!text) return;
    var tags = $("remember-tags").value
      .split(",")
      .map(function (tag) { return tag.trim(); })
      .filter(Boolean);
    await fetch("/remember", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: text, tags: tags }),
    });
    $("remember-text").value = "";
    $("remember-tags").value = "";
    refresh();
  });

  $("reply-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var text = $("reply-text").value.trim();
    if (!text) return;
    var button = event.target.querySelector("button");
    button.disabled = true;
    try {
      var res = await fetch("/reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: text }),
      });
      var data = await res.json();
      var out = $("reply-out");
      out.hidden = false;
      out.textContent = JSON.stringify(data, null, 2);
      if (data.ok) $("reply-text").value = "";
    } catch (err) {
      $("reply-out").hidden = false;
      $("reply-out").textContent = String(err);
    } finally {
      button.disabled = false;
    }
  });

  $("recap-btn").addEventListener("click", async function () {
    var button = this;
    button.disabled = true;
    try {
      var res = await fetch("/recap", { method: "POST" });
      var data = await res.json();
      var out = $("recap-out");
      out.hidden = false;
      if (data.ok) {
        var facts = (data.recap && data.recap.facts) || [];
        out.textContent =
          facts.map(function (fact) { return "- " + fact; }).join("\\n") +
          "\\n\\nsource: " + ((data.recap && data.recap.source) || "unknown");
        refresh();
      } else {
        out.textContent = "error: " + (data.error || res.status);
      }
    } catch (err) {
      $("recap-out").hidden = false;
      $("recap-out").textContent = String(err);
    } finally {
      button.disabled = false;
    }
  });

  $("ask-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var message = $("ask-message").value.trim();
    if (!message) return;
    var button = event.target.querySelector("button");
    button.disabled = true;
    try {
      var res = await fetch("/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: message,
          reflect: $("ask-reflect").checked,
          tools: $("ask-tools").checked,
          stream: $("ask-stream").checked,
        }),
      });
      var data = await res.json();
      var out = $("ask-out");
      out.hidden = false;
      if (data.ok) {
        out.textContent =
          "Circe: " + (data.answer || "") +
          (data.processed && data.processed.speech ? "\\nspoken: " + data.processed.speech : "");
        $("ask-message").value = "";
        refresh();
      } else {
        out.textContent = "error: " + (data.error || res.status);
      }
    } catch (err) {
      $("ask-out").hidden = false;
      $("ask-out").textContent = String(err);
    } finally {
      button.disabled = false;
    }
  });

  $("duet-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var topic = $("duet-topic").value.trim();
    if (!topic) return;
    var button = event.target.querySelector("button");
    button.disabled = true;
    var out = $("duet-out");
    out.hidden = false;
    out.textContent = "trading lines…";
    try {
      var res = await fetch("/duet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          topic: topic,
          partner: "evil-neuro",
          turns: Number($("duet-turns").value) || 4,
        }),
      });
      var data = await res.json();
      out.textContent = "";
      if (!data.ok) {
        out.textContent = "error: " + (data.error || res.status);
        return;
      }
      (data.result.lines || []).forEach(function (line) {
        var row = el("div");
        row.appendChild(el("strong", "", line.speaker + ": "));
        row.appendChild(document.createTextNode(String(line.text)));
        out.appendChild(row);
      });
      $("duet-topic").value = "";
    } catch (err) {
      out.textContent = String(err);
    } finally {
      button.disabled = false;
    }
  });

  $("chat-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var message = $("chat-message").value.trim();
    if (!message) return;
    var user = $("chat-user").value.trim() || "anon";
    await fetch("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user: user, message: message }),
    });
    $("chat-message").value = "";
    refresh();
  });

  // Streaming excludes the two-pass and tool-loop options.
  var streamBox = $("ask-stream");
  streamBox.addEventListener("change", function () {
    if (streamBox.checked) {
      $("ask-reflect").checked = false;
      $("ask-tools").checked = false;
    }
    $("ask-reflect").disabled = streamBox.checked;
    $("ask-tools").disabled = streamBox.checked;
  });

  $("goal-advance-btn").addEventListener("click", async function () {
    var btn = $("goal-advance-btn");
    btn.disabled = true;
    try {
      await fetch("/goals/advance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "dashboard click" }),
      });
      renderGoals();
    } catch (err) {}
    finally {
      btn.disabled = false;
    }
  });

  var events = new EventSource("/events");
  events.onmessage = function (message) {
    var host = $("events");
    var event;
    try { event = JSON.parse(message.data); } catch (err) { return; }
    if (event.type === "goal-active" || event.type === "goal-done" || event.type === "goal-step") {
      renderGoals();
    }
    if (event.type === "game") {
      $("gamer-card").hidden = false;
    }
    if (event.type === "game-action" || event.type === "game-commentary" || event.type === "game-error") {
      renderGameEvent(event);
    }
    if (event.type === "viewer-update") {
      fetch("/viewers?sort=messages&limit=15")
        .then(function (r) { return r.json(); })
        .then(function (d) { if (d.ok) renderViewers(d.viewers); })
        .catch(function () {});
    }
    var row = el("div");
    row.appendChild(el("span", "type", String(event.type)));
    var bits = [];
    if (event.user) bits.push(event.user + ": " + event.message);
    if (event.text && event.type !== "expression") bits.push(String(event.text));
    if (event.marker) bits.push("*" + event.marker + "* -> " + event.expression);
    if (event.backend) bits.push("tts " + (event.ok ? "ok" : "failed"));
    if (event.type === "brain-reflect") bits.push("draft -> " + String(event.final || "kept draft") + (event.error ? " (critique failed)" : ""));
    if (event.type === "tool-call") bits.push("tool " + event.tool + " " + JSON.stringify(event.args || {}));
    if (event.type === "tool-result") bits.push("tool " + event.tool + " -> " + JSON.stringify(event.result).slice(0, 60));
    if (event.type === "tool-error") bits.push("tool " + event.tool + " failed: " + event.error);
    if (event.type === "stream-start") bits.push("stream started");
    if (event.type === "stream-end") bits.push("stream ended");
    if (event.type === "goal-step") bits.push("step " + (Number(event.index) + 1) + "/" + event.totalSteps + (event.reason ? " (" + event.reason + ")" : ""));
    if (event.type === "game-action") bits.push(String(event.kind) + (event.input ? " (" + event.input + ")" : "") + (event.note ? " — " + event.note : ""));
    if (event.state) bits.push("state " + event.state);
    if (event.durationMs !== undefined) bits.push(event.durationMs + "ms");
    if (event.name && event.value !== undefined) bits.push(event.name + " = " + event.value);
    row.appendChild(document.createTextNode(bits.join(" | ")));
    host.appendChild(row);
    while (host.childNodes.length > 80) host.removeChild(host.firstChild);
    host.scrollTop = host.scrollHeight;
  };

  refresh();
  setInterval(refresh, 5000);
})();
</script>
</body>
</html>`;
}
