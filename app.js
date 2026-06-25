const WORDS = window.WORDS || ["奶茶", "月亮", "小狗", "火锅"];

const storagePrefix = "draw-and-guess-demo:";
const clientId = randomId();
let roomId = "";
let playerName = "";
let state = null;
let drawing = false;
let lastPoint = null;
let currentStroke = null;
let currentTool = "marker";
let currentColor = "#111827";
let currentOpacity = 1;
let brushSize = 7;
let eraserSize = 26;
let zoom = 1;
let roundTicker = null;
let isHost = false;
let peer = null;
let connections = [];
let applyingRemoteState = false;
let relaySource = null;
let relayReady = false;
let peerReady = false;
let lastRelayPublishAt = 0;
let relayLineQueue = [];
let relayLineTimer = null;
const seenSyncEvents = new Set();

const presetRoom = new URLSearchParams(window.location.search).get("room");
const shell = document.querySelector("#shell");
const lobby = document.querySelector("#lobby");
const game = document.querySelector("#game");
const joinForm = document.querySelector("#joinForm");
const nameInput = document.querySelector("#nameInput");
const roomInput = document.querySelector("#roomInput");
const copyRoom = document.querySelector("#copyRoom");
const roundTitle = document.querySelector("#roundTitle");
const timer = document.querySelector("#timer");
const score = document.querySelector("#score");
const syncStatus = document.querySelector("#syncStatus");
const roleLabel = document.querySelector("#roleLabel");
const wordLabel = document.querySelector("#wordLabel");
const playerList = document.querySelector("#playerList");
const startRound = document.querySelector("#startRound");
const swapRole = document.querySelector("#swapRole");
const clearCanvas = document.querySelector("#clearCanvas");
const toolbarClearCanvas = document.querySelector("#toolbarClearCanvas");
const colorPicker = document.querySelector("#colorPicker");
const eraserSizeRange = document.querySelector("#eraserSizeRange");
const eraserSizeLabel = document.querySelector("#eraserSizeLabel");
const opacityRange = document.querySelector("#opacityRange");
const opacityLabel = document.querySelector("#opacityLabel");
const eraser = document.querySelector("#eraser");
const undoStroke = document.querySelector("#undoStroke");
const redoStroke = document.querySelector("#redoStroke");
const zoomLabel = document.querySelector("#zoomLabel");
const canvasViewport = document.querySelector("#canvasViewport");
const eraserPreview = document.querySelector("#eraserPreview");
const messages = document.querySelector("#messages");
const hintButton = document.querySelector("#hintButton");
const guessForm = document.querySelector("#guessForm");
const guessInput = document.querySelector("#guessInput");
const canvas = document.querySelector("#board");
const ctx = canvas.getContext("2d");
const activePointers = new Map();
let pinching = false;
let pinchStartDistance = 0;
let pinchStartZoom = 1;
let pinchLastCenter = null;

ctx.lineCap = "round";
ctx.lineJoin = "round";
if (presetRoom) roomInput.value = sanitizeRoom(presetRoom);
setZoom(1);
showRoute(presetRoom ? "join-room" : currentRoute());

window.addEventListener("hashchange", () => showRoute(currentRoute()));

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  enterRoom(nameInput.value, roomInput.value);
  navigate("room");
});

window.addEventListener("resize", () => {
  if (!game.classList.contains("hidden") && zoom <= 1) fitCanvas();
});

window.addEventListener("storage", (event) => {
  if (event.key !== roomKey() || !event.newValue) return;
  state = JSON.parse(event.newValue);
  normalizeState(state);
  ensureCurrentPlayer();
  render();
  replayCanvas();
  syncRouteFromPhase();
  if (["room", "select-word", "result", "final-result"].includes(currentRoute())) showRoute(currentRoute());
});

window.addEventListener("beforeunload", () => {
  if (!state) return;
  delete state.players[clientId];
  if (state.drawerId === clientId) state.drawerId = Object.keys(state.players)[0] || "";
  saveState();
});

function currentRoute() {
  return window.location.hash.replace(/^#\/?/, "") || "home";
}

function navigate(route) {
  window.location.hash = route;
  showRoute(route);
}

function showRoute(route) {
  const page = route || "home";
  const isGamePage = page === "game";
  shell.classList.toggle("hidden", isGamePage);
  lobby.classList.add("hidden");
  game.classList.toggle("hidden", !isGamePage);
  if (isGamePage) {
    if (state) {
      copyRoom.textContent = roomId;
      render();
      replayCanvas();
      fitCanvas();
    }
    return;
  }
  shell.innerHTML = renderShellPage(page);
  attachShellHandlers(page);
}

function renderShellPage(page) {
  const route = page.split("?")[0];
  if (route === "library") return renderLibraryPage();
  if (route === "create-room") return renderCreateRoomPage();
  if (route === "join-room") return renderJoinRoomPage();
  if (route === "room") return renderRoomPage();
  if (route === "select-word") return renderSelectWordPage();
  if (route === "result") return renderResultPage();
  if (route === "final-result") return renderFinalResultPage();
  return renderHomePage();
}

function shellHeader(title, backRoute = "home") {
  return `
    <header class="shell-header">
      <button class="shell-icon-button" type="button" data-nav="${backRoute}" aria-label="返回">‹</button>
      <strong>${title}</strong>
      <span></span>
    </header>
  `;
}

function renderHomePage() {
  return `
    <section class="mobile-shell home-shell">
      <div class="home-logo">画</div>
      <h1>你画我猜</h1>
      <p>双人互动 · 浏览器联机 · 画板工具箱</p>
      <div class="shell-actions">
        <button type="button" data-nav="create-room">创建房间</button>
        <button class="secondary" type="button" data-nav="join-room">加入房间</button>
        <button class="ghost" type="button" data-nav="library">词库管理</button>
      </div>
    </section>
  `;
}

function renderCreateRoomPage() {
  return `
    <section class="mobile-shell">
      ${shellHeader("创建房间")}
      <form id="createRoomForm" class="shell-form">
        <label>昵称<input id="createName" maxlength="12" placeholder="比如 小陈" required /></label>
        <label>词库分类
          <select id="createCategory">
            <option>默认词库</option>
            <option>日常生活</option>
            <option>情侣专属</option>
          </select>
        </label>
        <label>游戏轮次<input id="createRounds" type="number" min="1" max="9" value="3" /></label>
        <button type="submit">确认创建</button>
      </form>
    </section>
  `;
}

function renderJoinRoomPage() {
  const defaultRoom = presetRoom || roomInput.value || "";
  const isNicknameStep = sessionStorage.getItem("joinRoomCode") || presetRoom;
  const roomCode = isNicknameStep || defaultRoom;
  return `
    <section class="mobile-shell">
      ${shellHeader("加入房间")}
      <div class="join-card">
        <div class="join-icon">↪</div>
        <h1>输入邀请码</h1>
        <p>向房主获取房间号并在此输入</p>
        <form id="joinCodeForm" class="shell-form ${isNicknameStep ? "hidden" : ""}">
          <input id="joinRoomCode" class="room-code-input" maxlength="16" value="${sanitizeHtml(defaultRoom)}" placeholder="例如：8273" required />
          <button type="submit">下一步</button>
        </form>
      </div>
      ${
        isNicknameStep
          ? `<div class="modal-layer">
              <form id="joinRoomForm" class="nickname-modal">
                <button class="modal-close" type="button" id="joinBackToCode">×</button>
                <div class="avatar-large">人</div>
                <h1>设置您的昵称</h1>
                <p>即将加入房间：<strong>${sanitizeHtml(roomCode)}</strong></p>
                <input id="joinName" maxlength="12" placeholder="请输入响亮的昵称..." required />
                <button type="submit">确认进入</button>
              </form>
            </div>`
          : ""
      }
    </section>
  `;
}

function renderRoomPage() {
  const players = state ? Object.values(state.players) : [];
  const totalRounds = state?.totalRounds || 3;
  const category = state?.category || "默认词库";
  return `
    <section class="mobile-shell room-shell">
      ${shellHeader("房间等待")}
      <div class="room-code-card">
        <span>房间号</span>
        <strong>${roomId || "----"}</strong>
        <button type="button" id="shellCopyRoom">邀请好友</button>
      </div>
      <div class="shell-card">
        <h2>玩家</h2>
        <ul class="shell-list">
          ${players.map((player) => `<li>${sanitizeHtml(player.name)}${player.id === state.drawerId ? " · 画手" : ""}</li>`).join("") || "<li>等待玩家加入</li>"}
        </ul>
      </div>
      <div class="shell-card">
        <h2>游戏设置</h2>
        <p>${totalRounds} 轮 · ${sanitizeHtml(category)}</p>
      </div>
      <div class="shell-actions">
        <button type="button" id="roomStartGame" ${isHost ? "" : "disabled"}>${isHost ? "开始游戏" : "等待房主开始"}</button>
        <button class="secondary" type="button" data-nav="home">返回首页</button>
      </div>
    </section>
  `;
}

function renderSelectWordPage() {
  const options = state?.wordOptions?.length ? state.wordOptions : pickWords(4);
  if (isDrawer()) {
    return `
      <section class="mobile-shell select-wait-shell">
        <div class="spinner"></div>
        <h1>等待选词...</h1>
        <p>当前轮到对方盲选词语；选好后你会自动进入画画页面。</p>
      </section>
    `;
  }
  return `
    <section class="mobile-shell">
      <div class="select-intro">
        <h1>盲选词语</h1>
        <p>词语已隐藏，请凭直觉选择 1 张卡片。对方将根据你选中的隐藏词作画。</p>
      </div>
      <div class="select-grid">
        ${options.map((word) => `<button class="mystery-card" type="button" data-word="${sanitizeHtml(word)}"><span>?</span><small>神秘卡片</small></button>`).join("")}
      </div>
    </section>
  `;
}

function renderLibraryPage() {
  return `
    <section class="mobile-shell">
      ${shellHeader("词库管理")}
      <div class="shell-card">
        <h2>默认词库</h2>
        <p>当前使用内置词库，约 ${WORDS.length} 个词。后续可以把分类词库接到这里。</p>
      </div>
      <textarea class="word-preview" readonly>${WORDS.slice(0, 80).join("、")}</textarea>
    </section>
  `;
}

function renderResultPage() {
  const result = state?.result || {};
  const success = result.success !== false;
  const currentRound = state?.roundNumber || 1;
  const totalRounds = state?.totalRounds || 3;
  return `
    <section class="mobile-shell result-shell ${success ? "success" : "failed"}">
      <div class="result-badge">${success ? "✓" : "×"}</div>
      <h1>${success ? "回合成功！" : "回合失败"}</h1>
      <p>正确答案：<strong>${sanitizeHtml(result.word || state?.lastWord || "未知")}</strong></p>
      <div class="shell-card result-stats">
        <p>猜测耗时：${result.timeUsed ?? 60} 秒</p>
        <p>当前进度：${currentRound} / ${totalRounds} 轮</p>
        <p>当前分数：${score.textContent || "0 : 0"}</p>
      </div>
      <div class="shell-actions">
        <button type="button" id="resultPrimary">${currentRound >= totalRounds ? "查看最终成绩" : "进入下一轮"}</button>
        <button class="secondary" type="button" data-nav="home">返回首页</button>
      </div>
    </section>
  `;
}

function renderFinalResultPage() {
  const history = state?.history || [];
  return `
    <section class="mobile-shell result-shell final-shell">
      <div class="result-badge trophy">★</div>
      <h1>游戏结束</h1>
      <p>${score.textContent || "0 : 0"}</p>
      <div class="shell-card final-records">
        <h2>对战记录</h2>
        <ul class="shell-list">
          ${
            history.length
              ? history.map((item) => `<li>第 ${item.round} 轮 · ${sanitizeHtml(item.word)} · ${item.success ? "猜中" : "失败"}</li>`).join("")
              : "<li>暂无记录</li>"
          }
        </ul>
      </div>
      <div class="shell-actions">
        <button type="button" data-nav="create-room">再来一局</button>
        <button class="secondary" type="button" data-nav="home">返回首页</button>
      </div>
    </section>
  `;
}

function attachShellHandlers(page) {
  shell.querySelectorAll("[data-nav]").forEach((button) => {
    button.addEventListener("click", () => navigate(button.dataset.nav));
  });
  shell.querySelector("#createRoomForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    enterRoom(shell.querySelector("#createName").value, "", {
      category: shell.querySelector("#createCategory").value,
      totalRounds: Number(shell.querySelector("#createRounds").value) || 3,
    });
    navigate("room");
  });
  shell.querySelector("#joinRoomForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    enterRoom(shell.querySelector("#joinName").value, sessionStorage.getItem("joinRoomCode") || presetRoom || "");
    sessionStorage.removeItem("joinRoomCode");
    navigate("room");
  });
  shell.querySelector("#joinCodeForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = sanitizeRoom(shell.querySelector("#joinRoomCode").value);
    if (!code) return;
    sessionStorage.setItem("joinRoomCode", code);
    showRoute("join-room");
  });
  shell.querySelector("#joinBackToCode")?.addEventListener("click", () => {
    sessionStorage.removeItem("joinRoomCode");
    showRoute("join-room");
  });
  shell.querySelector("#shellCopyRoom")?.addEventListener("click", async () => {
    await navigator.clipboard?.writeText(inviteUrl());
  });
  shell.querySelector("#roomStartGame")?.addEventListener("click", () => {
    if (!state || !isHost) return;
    beginWordSelection();
  });
  shell.querySelectorAll("[data-word]").forEach((button) => {
    button.addEventListener("click", () => {
      startNewRound(button.dataset.word);
      navigate("game");
    });
  });
  shell.querySelector("#resultPrimary")?.addEventListener("click", () => {
    if (!isHost) return;
    if ((state?.roundNumber || 1) >= (state?.totalRounds || 3)) {
      finishGame();
    } else {
      beginWordSelection();
    }
  });
}

function enterRoom(name, requestedRoom = "", options = {}) {
  playerName = name.trim();
  const enteredRoom = sanitizeRoom(requestedRoom);
  roomId = (enteredRoom || makeRoomCode()).toUpperCase();
  isHost = !enteredRoom;
  if (!playerName) return false;

  state = loadState() || createState();
  if (!enteredRoom) {
    state.phase = "room";
    state.category = options.category || state.category || "默认词库";
    state.totalRounds = options.totalRounds || state.totalRounds || 3;
    state.roundNumber = 0;
    state.history = [];
    state.result = null;
  }
  state.players[clientId] = {
    id: clientId,
    name: playerName,
    score: state.players[clientId]?.score || 0,
    joinedAt: Date.now(),
  };
  if (!state.drawerId) state.drawerId = clientId;
  saveState();
  copyRoom.textContent = roomId;
  render();
  replayCanvas();
  fitCanvas();
  startLocalTimer();
  startPeerMode();
  return true;
}

function beginWordSelection() {
  requirePlayer();
  if (!isHost) return;
  state.phase = "select-word";
  state.wordOptions = pickWords(4);
  state.roundNumber = (state.roundNumber || 0) + 1;
  state.result = null;
  state.word = "";
  state.roundEndsAt = 0;
  state.lines = [];
  state.strokes = [];
  state.redoStrokes = [];
  clearRelayLineQueue();
  replayCanvas();
  saveState({ broadcast: false });
  sendSync({ type: "select", state });
  navigate("select-word");
}

function startNewRound(word) {
  requirePlayer();
  if (isDrawer()) return;
  state.phase = "game";
  state.roundId = randomId();
  state.word = word;
  state.lastWord = word;
  state.hintVisible = false;
  state.roundEndsAt = Date.now() + 60_000;
  state.lines = [];
  state.strokes = [];
  state.redoStrokes = [];
  state.result = null;
  clearRelayLineQueue();
  state.messages = [
    ...state.messages.slice(-30),
    makeMessage("系统", `${playerName} 开始了新一轮`, "system"),
  ];
  replayCanvas();
  saveState({ broadcast: false });
  sendSync({ type: "round", state });
}

function finishRound(success) {
  if (!state || state.phase === "result" || state.phase === "final-result") return;
  const word = state.word || state.lastWord || "";
  const resultId = `${state.roundId}:${success ? "success" : "failed"}`;
  if (state.result?.id === resultId) return;
  const timeUsed = state.roundEndsAt ? Math.min(60, Math.max(0, Math.round((60_000 - (state.roundEndsAt - Date.now())) / 1000))) : 60;
  state.phase = "result";
  state.result = {
    id: resultId,
    success,
    word,
    timeUsed: success ? timeUsed : 60,
    round: state.roundNumber || 1,
  };
  state.history = [
    ...(state.history || []).filter((item) => item.roundId !== state.roundId),
    {
      roundId: state.roundId,
      round: state.roundNumber || 1,
      word,
      success,
      guess: success ? word : "",
    },
  ];
  state.word = "";
  state.roundEndsAt = 0;
  saveState({ broadcast: false });
  sendSync({ type: "result", state });
  navigate("result");
}

function finishGame() {
  if (!state) return;
  state.phase = "final-result";
  saveState({ broadcast: false });
  sendSync({ type: "final", state });
  navigate("final-result");
}

function pickWords(count) {
  return [...WORDS].sort(() => Math.random() - 0.5).slice(0, count);
}

function routeForPhase() {
  if (!state?.phase) return "";
  if (state.phase === "room") return "room";
  if (state.phase === "select-word") return "select-word";
  if (state.phase === "game") return "game";
  if (state.phase === "result") return "result";
  if (state.phase === "final-result") return "final-result";
  return "";
}

function syncRouteFromPhase() {
  const route = routeForPhase();
  if (!route || currentRoute() === route) return;
  navigate(route);
}

copyRoom.addEventListener("click", async () => {
  await navigator.clipboard?.writeText(inviteUrl());
  addMessage("系统", "邀请链接已复制，发给对方打开就能进房间", "system");
});

startRound.addEventListener("click", () => {
  startNewRound(pickWords(1)[0]);
});

swapRole.addEventListener("click", () => {
  requirePlayer();
  const players = Object.keys(state.players);
  if (players.length < 2) {
    addMessage("系统", "至少两个人进入房间后才能交换画手", "system");
    return;
  }
  const currentIndex = Math.max(0, players.indexOf(state.drawerId));
  state.drawerId = players[(currentIndex + 1) % players.length];
  state.messages = [
    ...state.messages.slice(-30),
    makeMessage("系统", `${state.players[state.drawerId].name} 现在是画手`, "system"),
  ];
  saveState();
});

clearCanvas.addEventListener("click", clearBoard);
toolbarClearCanvas.addEventListener("click", clearBoard);

function clearBoard() {
  if (!requireDrawer()) return;
  if (!confirm("确定清空当前画板吗？")) return;
  state.lines = [];
  state.strokes = [];
  state.redoStrokes = [];
  clearRelayLineQueue();
  replayCanvas();
  saveState({ broadcast: false });
  sendSync({ type: "clear", roundId: state.roundId });
}

document.querySelectorAll("[data-tool]").forEach((button) => {
  button.addEventListener("click", () => {
    currentTool = button.dataset.tool;
    setActive("[data-tool]", button);
    if (currentTool !== "eraser") hideEraserPreview();
  });
});

document.querySelectorAll("[data-color]").forEach((button) => {
  button.addEventListener("click", () => {
    currentColor = button.dataset.color;
    colorPicker.value = currentColor;
    setActive("[data-color]", button);
  });
});

colorPicker.addEventListener("input", () => {
  currentColor = colorPicker.value;
  document.querySelectorAll("[data-color]").forEach((button) => button.classList.remove("active"));
});

opacityRange.addEventListener("input", () => {
  currentOpacity = Number(opacityRange.value) / 100;
  opacityLabel.textContent = `${opacityRange.value}%`;
});

eraserSizeRange.addEventListener("input", () => {
  eraserSize = Number(eraserSizeRange.value);
  eraserSizeLabel.textContent = `${eraserSize}`;
  updateEraserPreview();
});

document.querySelectorAll("[data-size]").forEach((button) => {
  button.addEventListener("click", () => {
    brushSize = Number(button.dataset.size);
    setActive("[data-size]", button);
  });
});

undoStroke.addEventListener("click", () => {
  if (!requireDrawer()) return;
  undoLastStroke();
});

redoStroke.addEventListener("click", () => {
  if (!requireDrawer()) return;
  redoLastStroke();
});

hintButton.addEventListener("click", () => {
  if (!state || isDrawer()) return;
  state.hintVisible = true;
  state.messages = [
    ...state.messages.slice(-30),
    makeMessage("系统", `提示：${hintForCategory(state.category)}`, "hint"),
  ];
  saveState();
});

canvasViewport.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    setZoom(zoom * (event.deltaY < 0 ? 1.08 : 0.92));
  },
  { passive: false },
);

guessForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = guessInput.value.trim();
  if (!text || !state) return;
  guessInput.value = "";

  const normalizedGuess = normalize(text);
  const isCorrect = state.word && normalizedGuess === normalize(state.word);
  if (isCorrect && clientId !== state.drawerId) {
    state.players[clientId].score += 1;
    state.messages = [
      ...state.messages.slice(-30),
      makeMessage(playerName, `答对了：${state.word}`, "correct"),
    ];
    finishRound(true);
  } else {
    state.messages = [...state.messages.slice(-30), makeMessage(playerName, text, "message")];
    saveState();
  }
});

canvas.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  trackPointer(event);
  if (event.pointerType === "touch" && activePointers.size >= 2) {
    beginPinch();
    return;
  }
  if (!isDrawer()) return;
  if (pinching) return;
  lastPoint = getCanvasPoint(event);
  if (currentTool === "eyedropper") {
    pickCanvasColor(lastPoint);
    return;
  }
  if (currentTool === "fill") {
    fillAtPoint(lastPoint);
    return;
  }
  if (currentTool === "eraser") {
    showEraserPreview(event);
  }
  drawing = true;
  canvas.setPointerCapture(event.pointerId);
  currentStroke = createStroke();
  state.redoStrokes = [];
});

canvas.addEventListener("pointermove", (event) => {
  if (activePointers.has(event.pointerId)) trackPointer(event);
  if (pinching) {
    event.preventDefault();
    updatePinchZoom();
    return;
  }
  if (!drawing || !isDrawer()) return;
  event.preventDefault();
  if (currentTool === "eraser") {
    showEraserPreview(event);
  }
  const nextPoint = getCanvasPoint(event);
  const style = getBrushStyle();
  const line = {
    id: randomId(),
    roundId: state.roundId,
    strokeId: currentStroke.id,
    from: lastPoint,
    to: nextPoint,
    color: style.color,
    size: style.size,
    tool: style.tool,
    opacity: style.opacity,
    seed: Math.random(),
  };
  state.lines.push(line);
  currentStroke.lines.push(line);
  drawLine(line);
  sendSync({ type: "line", line }, { relay: false });
  queueRelayLine(line);
  lastPoint = nextPoint;
  throttleSave();
});

canvas.addEventListener("pointerup", (event) => {
  activePointers.delete(event.pointerId);
  if (pinching) {
    if (activePointers.size < 2) {
      pinching = false;
      pinchLastCenter = null;
    }
    return;
  }
  if (!drawing && !currentStroke) return;
  drawing = false;
  lastPoint = null;
  hideEraserPreview();
  finishCurrentStroke();
  saveState();
});

canvas.addEventListener("pointercancel", (event) => {
  activePointers.delete(event.pointerId);
  if (pinching && activePointers.size < 2) {
    pinching = false;
    pinchLastCenter = null;
  }
  if (!drawing && !currentStroke) return;
  drawing = false;
  lastPoint = null;
  hideEraserPreview();
  finishCurrentStroke();
  saveState();
});

function createState() {
  return {
    updatedAt: Date.now(),
    phase: "room",
    category: "默认词库",
    totalRounds: 3,
    roundNumber: 0,
    drawerId: "",
    word: "",
    lastWord: "",
    wordOptions: [],
    result: null,
    history: [],
    roundEndsAt: 0,
    roundId: randomId(),
    players: {},
    lines: [],
    strokes: [],
    redoStrokes: [],
    messages: [makeMessage("系统", "房间已创建", "system")],
  };
}

function render() {
  if (!state) return;
  const players = Object.values(state.players);
  const drawer = state.players[state.drawerId];
  const secondsLeft = Math.max(0, Math.ceil((state.roundEndsAt - Date.now()) / 1000));
  const drawerMode = isDrawer();

  game.dataset.role = drawerMode ? "drawer" : "guesser";
  game.dataset.phase = state.phase || "";
  const compactGame = window.matchMedia("(max-width: 760px)").matches;
  roundTitle.textContent =
    state.phase === "game" && state.word
      ? drawerMode
        ? state.word
        : "？".repeat(Math.max(1, state.word.length))
      : drawer
        ? `${drawer.name} 正在画`
        : "等待玩家";
  timer.textContent = `${secondsLeft}s`;
  score.textContent = compactGame
    ? `第 ${state.roundNumber || 1} 轮`
    : players.map((player) => player.score).join(" : ") || "0 : 0";
  roleLabel.textContent = drawerMode ? "画手" : "猜词";
  wordLabel.textContent = drawerMode
    ? state.word || "点开始/换题"
    : state.word
      ? "猜猜画的是什么"
      : "等待新题目";

  playerList.innerHTML = "";
  players.forEach((player) => {
    const item = document.createElement("li");
    item.textContent = `${player.name}${player.id === state.drawerId ? " · 画手" : ""} · ${player.score}分`;
    playerList.append(item);
  });

  messages.innerHTML = "";
  state.messages.forEach((message) => {
    const item = document.createElement("div");
    item.className = `message ${message.type}`;
    item.textContent = `${message.author}：${message.text}`;
    messages.append(item);
  });
  messages.scrollTop = messages.scrollHeight;
  hintButton.classList.toggle("hidden", drawerMode || state.phase !== "game" || state.hintVisible);
  guessInput.placeholder = state.hintVisible
    ? `提示：${hintForCategory(state.category)}，输入答案...`
    : "输入答案或聊天";
}

function replayCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const drawnLineIds = new Set();
  state?.strokes?.forEach((stroke) => {
    if (stroke.type === "fill") {
      applyFillOperation(stroke);
      return;
    }
    stroke.lines?.forEach((line) => {
      drawLine(line);
      drawnLineIds.add(line.id);
    });
  });
  state?.lines
    ?.filter((line) => !drawnLineIds.has(line.id))
    .forEach(drawLine);
}

function drawLine(line) {
  ctx.save();
  ctx.globalAlpha = line.opacity ?? 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = line.color;
  ctx.lineWidth = line.size;
  ctx.lineCap = line.tool === "highlighter" ? "butt" : "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(line.from.x, line.from.y);
  ctx.lineTo(line.to.x, line.to.y);
  ctx.stroke();
  if (line.tool === "crayon") drawCrayonTexture(line);
  ctx.restore();
}

function drawCrayonTexture(line) {
  const jitter = (line.seed || 0.5) - 0.5;
  ctx.globalAlpha = Math.max(0.18, (line.opacity ?? 0.8) * 0.45);
  ctx.lineWidth = Math.max(1, line.size * 0.35);
  for (let index = 0; index < 3; index += 1) {
    const offset = (index - 1) * line.size * 0.18 + jitter * line.size;
    ctx.beginPath();
    ctx.moveTo(line.from.x + offset, line.from.y - offset);
    ctx.lineTo(line.to.x + offset, line.to.y - offset);
    ctx.stroke();
  }
}

function fillAtPoint(point) {
  const fill = {
    id: randomId(),
    type: "fill",
    roundId: state.roundId,
    x: Math.round(point.x),
    y: Math.round(point.y),
    color: currentColor,
    opacity: currentOpacity,
    tolerance: 28,
  };
  const changed = applyFillOperation(fill);
  if (!changed) return;
  state.strokes = [...(state.strokes || []), fill];
  state.redoStrokes = [];
  saveState({ broadcast: false });
  sendSync({ type: "fill", fill });
}

function applyFillOperation(fill) {
  if (!fill || (fill.roundId && fill.roundId !== state.roundId)) return false;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  const width = image.width;
  const height = image.height;
  const x = Math.max(0, Math.min(width - 1, Math.round(fill.x)));
  const y = Math.max(0, Math.min(height - 1, Math.round(fill.y)));
  const targetIndex = (y * width + x) * 4;
  const target = [
    data[targetIndex],
    data[targetIndex + 1],
    data[targetIndex + 2],
    data[targetIndex + 3],
  ];
  const fillColor = hexToRgb(fill.color);
  const alpha = Math.min(1, Math.max(0.05, fill.opacity ?? 1));
  const tolerance = fill.tolerance ?? 28;
  if (colorDistance(target, [...fillColor, 255]) <= 1 && alpha >= 0.98) return false;

  const visited = new Uint8Array(width * height);
  const stack = [y * width + x];
  let changed = 0;

  while (stack.length) {
    const pixel = stack.pop();
    if (visited[pixel]) continue;
    visited[pixel] = 1;

    const index = pixel * 4;
    const current = [data[index], data[index + 1], data[index + 2], data[index + 3]];
    if (colorDistance(current, target) > tolerance) continue;

    data[index] = Math.round(fillColor[0] * alpha + data[index] * (1 - alpha));
    data[index + 1] = Math.round(fillColor[1] * alpha + data[index + 1] * (1 - alpha));
    data[index + 2] = Math.round(fillColor[2] * alpha + data[index + 2] * (1 - alpha));
    data[index + 3] = 255;
    changed += 1;

    const px = pixel % width;
    if (px > 0) stack.push(pixel - 1);
    if (px < width - 1) stack.push(pixel + 1);
    if (pixel >= width) stack.push(pixel - width);
    if (pixel < width * (height - 1)) stack.push(pixel + width);
  }

  if (!changed) return false;
  ctx.putImageData(image, 0, 0);
  return true;
}

function pickCanvasColor(point) {
  const x = Math.max(0, Math.min(canvas.width - 1, Math.round(point.x)));
  const y = Math.max(0, Math.min(canvas.height - 1, Math.round(point.y)));
  const [red, green, blue] = ctx.getImageData(x, y, 1, 1).data;
  currentColor = rgbToHex(red, green, blue);
  colorPicker.value = currentColor;
  document.querySelectorAll("[data-color]").forEach((button) => {
    button.classList.toggle("active", button.dataset.color?.toLowerCase() === currentColor);
  });
}

function createStroke() {
  const style = getBrushStyle();
  return {
    id: randomId(),
    roundId: state.roundId,
    tool: style.tool,
    color: style.color,
    size: style.size,
    opacity: style.opacity,
    lines: [],
  };
}

function finishCurrentStroke() {
  if (!currentStroke) return;
  if (currentStroke.lines.length) {
    state.strokes = [...(state.strokes || []), currentStroke];
    state.redoStrokes = [];
  }
  currentStroke = null;
}

function getBrushStyle() {
  if (currentTool === "eraser") {
    return { tool: "eraser", color: "#ffffff", size: eraserSize, opacity: 1 };
  }
  if (currentTool === "pencil") {
    return {
      tool: "pencil",
      color: currentColor,
      size: Math.max(1, brushSize * 0.75),
      opacity: Math.min(currentOpacity, 0.72),
    };
  }
  if (currentTool === "highlighter") {
    return {
      tool: "highlighter",
      color: currentColor,
      size: Math.max(8, brushSize * 1.9),
      opacity: Math.min(currentOpacity, 0.34),
    };
  }
  if (currentTool === "crayon") {
    return { tool: "crayon", color: currentColor, size: brushSize, opacity: Math.min(currentOpacity, 0.82) };
  }
  return { tool: "marker", color: currentColor, size: brushSize, opacity: currentOpacity };
}

function undoLastStroke() {
  const stroke = (state.strokes || []).at(-1);
  if (!stroke) return;
  applyUndo(stroke.id);
  sendSync({ type: "undo", strokeId: stroke.id });
}

function redoLastStroke() {
  const stroke = (state.redoStrokes || []).at(-1);
  if (!stroke) return;
  applyRedo(stroke);
  sendSync({ type: "redo", stroke });
}

function applyUndo(strokeId) {
  const stroke = (state.strokes || []).find((item) => item.id === strokeId) || {
    id: strokeId,
    roundId: state.roundId,
    lines: state.lines.filter((line) => line.strokeId === strokeId),
  };
  if (stroke.type !== "fill" && !stroke.lines?.length) return;
  if (stroke.type !== "fill") {
    state.lines = state.lines.filter((line) => line.strokeId !== strokeId);
  }
  state.strokes = (state.strokes || []).filter((item) => item.id !== strokeId);
  state.redoStrokes = [...(state.redoStrokes || []).filter((item) => item.id !== strokeId), stroke];
  saveState({ broadcast: false });
}

function applyRedo(stroke) {
  if (!stroke || (stroke.roundId && stroke.roundId !== state.roundId)) return;
  if (stroke.type === "fill") {
    if (!(state.strokes || []).some((item) => item.id === stroke.id)) {
      state.strokes = [...(state.strokes || []), stroke];
    }
    state.redoStrokes = (state.redoStrokes || []).filter((item) => item.id !== stroke.id);
    saveState({ broadcast: false });
    return;
  }
  if (!stroke.lines?.length) return;
  const existingLineIds = new Set(state.lines.map((line) => line.id));
  const missingLines = stroke.lines.filter((line) => !existingLineIds.has(line.id));
  state.lines = [...state.lines, ...missingLines];
  if (!(state.strokes || []).some((item) => item.id === stroke.id)) {
    state.strokes = [...(state.strokes || []), stroke];
  }
  state.redoStrokes = (state.redoStrokes || []).filter((item) => item.id !== stroke.id);
  saveState({ broadcast: false });
}

function ensureStrokeForLine(line) {
  if (!line.strokeId) return;
  let stroke = (state.strokes || []).find((item) => item.id === line.strokeId);
  if (!stroke) {
    stroke = {
      id: line.strokeId,
      roundId: line.roundId || state.roundId,
      tool: line.tool,
      color: line.color,
      size: line.size,
      opacity: line.opacity,
      lines: [],
    };
    state.strokes = [...(state.strokes || []), stroke];
  }
  if (!stroke.lines.some((item) => item.id === line.id)) stroke.lines.push(line);
}

function setActive(selector, activeButton) {
  document.querySelectorAll(selector).forEach((button) => button.classList.remove("active"));
  activeButton.classList.add("active");
}

function setZoom(nextZoom) {
  zoom = Math.min(2.4, Math.max(0.45, nextZoom));
  canvas.style.width = `${canvas.width * zoom}px`;
  canvas.style.height = `${canvas.height * zoom}px`;
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  updateEraserPreview();
}

function fitCanvas() {
  const availableWidth = Math.max(320, canvasViewport.clientWidth - 28);
  setZoom(Math.min(1, availableWidth / canvas.width));
}

function trackPointer(event) {
  activePointers.set(event.pointerId, {
    x: event.clientX,
    y: event.clientY,
  });
}

function beginPinch() {
  if (drawing) {
    drawing = false;
    lastPoint = null;
    finishCurrentStroke();
    saveState();
  }
  const points = [...activePointers.values()];
  pinchStartDistance = getPointDistance(points[0], points[1]);
  pinchStartZoom = zoom;
  pinchLastCenter = getPointCenter(points[0], points[1]);
  pinching = pinchStartDistance > 0;
}

function updatePinchZoom() {
  const points = [...activePointers.values()];
  if (points.length < 2 || !pinchStartDistance) return;
  const distance = getPointDistance(points[0], points[1]);
  const center = getPointCenter(points[0], points[1]);
  if (pinchLastCenter) {
    canvasViewport.scrollLeft -= center.x - pinchLastCenter.x;
    canvasViewport.scrollTop -= center.y - pinchLastCenter.y;
  }
  pinchLastCenter = center;
  setZoom(pinchStartZoom * (distance / pinchStartDistance));
}

function getPointDistance(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function getPointCenter(first, second) {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

function showEraserPreview(event) {
  if (!eraserPreview) return;
  eraserPreview.classList.remove("hidden");
  updateEraserPreview(event);
}

function hideEraserPreview() {
  if (!eraserPreview) return;
  eraserPreview.classList.add("hidden");
}

function updateEraserPreview(event) {
  if (!eraserPreview || currentTool !== "eraser" || eraserPreview.classList.contains("hidden")) return;
  const size = eraserSize * zoom;
  eraserPreview.style.width = `${size}px`;
  eraserPreview.style.height = `${size}px`;
  if (event) {
    const rect = canvasViewport.getBoundingClientRect();
    const x = event.clientX - rect.left + canvasViewport.scrollLeft;
    const y = event.clientY - rect.top + canvasViewport.scrollTop;
    eraserPreview.style.left = `${x - size / 2}px`;
    eraserPreview.style.top = `${y - size / 2}px`;
  }
}

function getCanvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
}

function makeRoomCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function makeMessage(author, text, type) {
  return {
    id: randomId(),
    author,
    text,
    type,
    createdAt: Date.now(),
  };
}

function addMessage(author, text, type) {
  state.messages = [...state.messages.slice(-30), makeMessage(author, text, type)];
  saveState();
}

function roomKey() {
  return `${storagePrefix}${roomId}`;
}

function loadState() {
  const raw = localStorage.getItem(roomKey());
  return raw ? JSON.parse(raw) : null;
}

function saveState(options = {}) {
  ensureCurrentPlayer();
  state.updatedAt = Date.now();
  localStorage.setItem(roomKey(), JSON.stringify(state));
  render();
  replayCanvas();
  if (currentRoute() === "room" || currentRoute() === "select-word" || currentRoute() === "result" || currentRoute() === "final-result") {
    showRoute(currentRoute());
  }
  if (!applyingRemoteState && options.broadcast !== false) sendSync({ type: "state", state });
}

let pendingSave = null;
function throttleSave() {
  if (pendingSave) return;
  pendingSave = requestAnimationFrame(() => {
    pendingSave = null;
    state.updatedAt = Date.now();
    localStorage.setItem(roomKey(), JSON.stringify(state));
    sendSync({ type: "state", state }, { relay: false });
  });
}

function requirePlayer() {
  ensureCurrentPlayer();
}

function requireDrawer() {
  if (isDrawer()) return true;
  addMessage("系统", "只有画手可以操作画板", "system");
  return false;
}

function isDrawer() {
  return state?.drawerId === clientId;
}

function normalize(value) {
  return value.trim().replace(/\s+/g, "").toLowerCase();
}

function hintForCategory(category) {
  if (category === "常见水果") return "一种水果";
  if (category === "动物世界") return "一种动物";
  if (category === "日常用品") return "日常用品";
  if (category === "成语大全") return "一个成语";
  return "看看分类和笔画";
}

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function rgbToHex(red, green, blue) {
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function colorDistance(first, second) {
  return Math.hypot(
    first[0] - second[0],
    first[1] - second[1],
    first[2] - second[2],
    (first[3] ?? 255) - (second[3] ?? 255),
  );
}

function startLocalTimer() {
  clearInterval(roundTicker);
  roundTicker = setInterval(() => {
    render();
    if (state?.phase === "game" && state.roundEndsAt && Date.now() >= state.roundEndsAt) {
      finishRound(false);
    }
  }, 300);
}

function startPeerMode() {
  startRelayMode();

  if (!window.Peer) {
    addMessage("系统", "WebRTC 联网库未加载，已启用 HTTP 中继同步", "system");
    updateSyncStatus();
    return;
  }

  const hostPeerId = peerIdForRoom(roomId);
  peer = isHost ? new Peer(hostPeerId) : new Peer();

  peer.on("open", () => {
    addMessage(
      "系统",
      isHost ? "联机房间已创建，把房间码发给对方" : "正在连接对方的房间",
      "system",
    );
    updateSyncStatus();
    if (!isHost) connectToHost(hostPeerId);
  });

  peer.on("connection", (connection) => {
    attachConnection(connection);
  });

  peer.on("error", (error) => {
    addMessage("系统", `WebRTC 暂不可用，继续使用 HTTP 中继：${error.type || error.message}`, "system");
    updateSyncStatus();
  });
}

function connectToHost(hostPeerId) {
  const connection = peer.connect(hostPeerId, { reliable: true });
  attachConnection(connection);
}

function attachConnection(connection) {
  if (connections.some((item) => item.peer === connection.peer)) return;
  connections.push(connection);

  connection.on("open", () => {
    peerReady = true;
    if (isHost) {
      sendToPeer(connection, { type: "state", state });
    } else {
      sendToPeer(connection, { type: "join", player: state.players[clientId] });
    }
    addMessage("系统", isHost ? "对方已连接" : "已连接到房间", "system");
    updateSyncStatus();
  });

  connection.on("data", (data) => {
    handleSyncPayload(data, connection.peer);
  });

  connection.on("close", () => {
    connections = connections.filter((item) => item !== connection);
    peerReady = connections.some((item) => item.open);
    addMessage("系统", "对方已断开", "system");
    updateSyncStatus();
  });
}

function sendSync(payload, options = {}) {
  const event = {
    ...payload,
    eventId: randomId(),
    senderId: clientId,
    sentAt: Date.now(),
  };
  seenSyncEvents.add(event.eventId);
  broadcastPeer(event, options.exceptPeer);
  if (options.relay !== false) publishRelay(event);
}

function broadcastPeer(event, exceptPeer = "") {
  connections.forEach((connection) => {
    if (connection.peer === exceptPeer || !connection.open) return;
    sendToPeer(connection, event);
  });
}

function sendToPeer(connection, event) {
  try {
    connection.send(event);
  } catch {
    peerReady = false;
    updateSyncStatus();
  }
}

function handleSyncPayload(data, exceptPeer = "") {
  if (!data || data.senderId === clientId || seenSyncEvents.has(data.eventId)) return;
  if (data.eventId) seenSyncEvents.add(data.eventId);

  if (data.type === "join" && isHost) {
    handleJoin(data.player);
    return;
  }

  applyingRemoteState = true;
  if (data.type === "state") {
    state = mergeState(data.state, state);
    ensureCurrentPlayer();
    localStorage.setItem(roomKey(), JSON.stringify(state));
    render();
    replayCanvas();
    syncRouteFromPhase();
  }
  if (data.type === "select") {
    state = adoptFlowState(data.state);
    ensureCurrentPlayer();
    localStorage.setItem(roomKey(), JSON.stringify(state));
    render();
    replayCanvas();
    navigate("select-word");
  }
  if (data.type === "round") {
    state = adoptFlowState(data.state, { preferRemoteLines: true });
    ensureCurrentPlayer();
    localStorage.setItem(roomKey(), JSON.stringify(state));
    render();
    replayCanvas();
    navigate("game");
  }
  if (data.type === "result") {
    if (state?.roundId && data.state?.roundId && state.roundId !== data.state.roundId && state.phase === "game") {
      applyingRemoteState = false;
      return;
    }
    state = adoptFlowState(data.state, { preferRemoteLines: true });
    ensureCurrentPlayer();
    localStorage.setItem(roomKey(), JSON.stringify(state));
    render();
    replayCanvas();
    navigate("result");
  }
  if (data.type === "final") {
    state = adoptFlowState(data.state, { preferRemoteLines: true });
    ensureCurrentPlayer();
    localStorage.setItem(roomKey(), JSON.stringify(state));
    render();
    replayCanvas();
    navigate("final-result");
  }
  if (data.type === "clear") {
    if (!data.roundId || data.roundId === state.roundId) {
      state.lines = [];
      state.strokes = [];
      state.redoStrokes = [];
      localStorage.setItem(roomKey(), JSON.stringify(state));
      replayCanvas();
    }
  }
  if (data.type === "undo") {
    applyUndo(data.strokeId);
  }
  if (data.type === "redo") {
    applyRedo(data.stroke);
  }
  if (data.type === "line") {
    applyRemoteLine(data.line);
  }
  if (data.type === "lines") {
    data.lines?.forEach(applyRemoteLine);
  }
  if (data.type === "fill") {
    applyRemoteFill(data.fill);
  }
  applyingRemoteState = false;

  if (["state", "select", "round", "result", "final", "clear", "undo", "redo", "fill"].includes(data.type)) {
    broadcastPeer(data, exceptPeer);
  }
}

function applyRemoteLine(line) {
  if (!line || state.lines.some((item) => item.id === line.id)) return;
  if (line.roundId && line.roundId !== state.roundId) return;
  state.lines.push(line);
  ensureStrokeForLine(line);
  localStorage.setItem(roomKey(), JSON.stringify(state));
  drawLine(line);
}

function applyRemoteFill(fill) {
  if (!fill || (fill.roundId && fill.roundId !== state.roundId)) return;
  if ((state.strokes || []).some((item) => item.id === fill.id)) return;
  state.strokes = [...(state.strokes || []), fill];
  state.redoStrokes = [];
  localStorage.setItem(roomKey(), JSON.stringify(state));
  replayCanvas();
}

function startRelayMode() {
  if (relaySource) relaySource.close();
  relaySource = new EventSource(`${relayTopicUrl()}/sse?since=1s`);

  relaySource.onopen = () => {
    relayReady = true;
    updateSyncStatus();
    sendSync({ type: "join", player: state.players[clientId] }, { relay: true });
  };

  relaySource.onmessage = (event) => {
    let envelope;
    let payload;
    try {
      envelope = JSON.parse(event.data);
      if (envelope.event !== "message") return;
      payload = JSON.parse(envelope.message);
    } catch {
      return;
    }
    handleSyncPayload(payload);
  };

  relaySource.onerror = () => {
    relayReady = false;
    updateSyncStatus();
  };
}

function publishRelay(event) {
  if (!relayReady) return;
  const now = Date.now();
  if (event.type === "state" && now - lastRelayPublishAt < 350) return;
  lastRelayPublishAt = now;
  fetch(relayTopicUrl(), {
    method: "POST",
    body: JSON.stringify(event),
  }).catch(() => {
    relayReady = false;
    updateSyncStatus();
  });
}

function queueRelayLine(line) {
  relayLineQueue.push(line);
  if (relayLineTimer) return;
  relayLineTimer = setTimeout(flushRelayLines, 90);
}

function flushRelayLines() {
  relayLineTimer = null;
  const lines = relayLineQueue.splice(0, 24);
  if (lines.length) sendSync({ type: "lines", lines });
  if (relayLineQueue.length) relayLineTimer = setTimeout(flushRelayLines, 90);
}

function clearRelayLineQueue() {
  relayLineQueue = [];
  if (relayLineTimer) {
    clearTimeout(relayLineTimer);
    relayLineTimer = null;
  }
}

function relayTopicUrl() {
  return `https://ntfy.sh/drawandguess-${roomId.toLowerCase()}`;
}

function mergeState(remoteState, localState, options = {}) {
  if (!remoteState) return localState;
  normalizeState(remoteState);
  normalizeState(localState);
  const mergedPlayers = mergePlayers(remoteState.players, localState.players);
  const mergedMessages = [...remoteState.messages, ...localState.messages]
    .filter((message, index, all) => all.findIndex((item) => item.id === message.id) === index)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-40);

  const baseState =
    remoteState.updatedAt >= (localState.updatedAt || 0) ? remoteState : localState;

  return {
    ...baseState,
    players: mergedPlayers,
    messages: mergedMessages,
    lines: chooseLines(remoteState, localState, options),
    strokes: chooseStrokes(remoteState, localState, options),
    redoStrokes: baseState.redoStrokes || [],
  };
}

function adoptFlowState(remoteState, options = {}) {
  if (!remoteState) return state;
  normalizeState(remoteState);
  normalizeState(state);
  return {
    ...remoteState,
    players: mergePlayers(remoteState.players, state.players),
    messages: [...(remoteState.messages || []), ...(state.messages || [])]
      .filter((message, index, all) => all.findIndex((item) => item.id === message.id) === index)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-40),
    lines: chooseLines(remoteState, state, options),
    strokes: chooseStrokes(remoteState, state, options),
    redoStrokes: remoteState.redoStrokes || [],
  };
}

function mergePlayers(remotePlayers = {}, localPlayers = {}) {
  const merged = { ...localPlayers };
  Object.entries(remotePlayers).forEach(([id, remotePlayer]) => {
    const localPlayer = merged[id];
    merged[id] = {
      ...localPlayer,
      ...remotePlayer,
      score: Math.max(remotePlayer?.score || 0, localPlayer?.score || 0),
      joinedAt: Math.min(remotePlayer?.joinedAt || Date.now(), localPlayer?.joinedAt || Date.now()),
    };
  });
  return merged;
}

function chooseLines(remoteState, localState, options = {}) {
  if (options.preferRemoteLines) return remoteState.lines || [];
  if (remoteState.roundId && localState.roundId && remoteState.roundId !== localState.roundId) {
    return remoteState.updatedAt >= (localState.updatedAt || 0)
      ? remoteState.lines || []
      : localState.lines || [];
  }
  return (remoteState.lines?.length || 0) >= (localState.lines?.length || 0)
    ? remoteState.lines || []
    : localState.lines || [];
}

function chooseStrokes(remoteState, localState, options = {}) {
  if (options.preferRemoteLines) return remoteState.strokes || [];
  if (remoteState.roundId && localState.roundId && remoteState.roundId !== localState.roundId) {
    return remoteState.updatedAt >= (localState.updatedAt || 0)
      ? remoteState.strokes || []
      : localState.strokes || [];
  }
  return (remoteState.strokes?.length || 0) >= (localState.strokes?.length || 0)
    ? remoteState.strokes || []
    : localState.strokes || [];
}

function handleJoin(player) {
  if (!player) return;
  const existed = Boolean(state.players[player.id]);
  state.players[player.id] = player;
  if (!state.drawerId) state.drawerId = clientId;
  if (!existed) {
    state.messages = [
      ...state.messages.slice(-30),
      makeMessage("系统", `${player.name} 加入了房间`, "system"),
    ];
  }
  saveState();
}

function updateSyncStatus() {
  const parts = [];
  if (peerReady) parts.push("点对点已连接");
  if (relayReady) parts.push("中继已连接");
  syncStatus.textContent = `同步：${parts.join(" + ") || "连接中"}`;
}

function ensureCurrentPlayer() {
  if (!state || !playerName) return;
  normalizeState(state);
  if (!state.players[clientId]) {
    state.players[clientId] = { id: clientId, name: playerName, score: 0, joinedAt: Date.now() };
  }
}

function normalizeState(targetState) {
  targetState.phase ||= "room";
  targetState.category ||= "默认词库";
  targetState.totalRounds ||= 3;
  targetState.roundNumber ||= 0;
  targetState.lastWord ||= targetState.word || "";
  targetState.wordOptions ||= [];
  targetState.hintVisible ||= false;
  targetState.result ||= null;
  targetState.history ||= [];
  targetState.roundId ||= randomId();
  targetState.players ||= {};
  targetState.lines ||= [];
  targetState.strokes ||= [];
  targetState.redoStrokes ||= [];
  targetState.messages ||= [];
}

function peerIdForRoom(value) {
  return `draw-and-guess-${value.toLowerCase()}`;
}

function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function sanitizeRoom(value) {
  return value.trim().replace(/[^a-z0-9]/gi, "").slice(0, 16).toUpperCase();
}

function sanitizeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function inviteUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  return url.toString();
}
