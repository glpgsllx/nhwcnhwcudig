const WORDS = window.WORDS || ["奶茶", "月亮", "小狗", "火锅"];
const APP_VERSION = "2026.06.27.14";

const storagePrefix = "draw-and-guess-demo:";
const clientIdKey = `${storagePrefix}client-id`;
const lastSessionKey = `${storagePrefix}last-session`;
const clientId = loadClientId();
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
let syncHeartbeatTimer = null;
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
const restoredSession = restoreLastSession();
if (restoredSession) {
  const restoredRoute = routeForPhase() || currentRoute();
  if (currentRoute() === restoredRoute) {
    showRoute(restoredRoute);
  } else {
    navigate(restoredRoute);
  }
} else {
  showRoute(presetRoom ? "join-room" : currentRoute());
}

window.addEventListener("hashchange", () => {
  if (keepRouteInCurrentFlow()) return;
  showRoute(currentRoute());
});

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  enterRoom(nameInput.value, roomInput.value);
  navigate("room");
});

window.addEventListener("resize", () => {
  if (!game.classList.contains("hidden") && zoom <= 1) fitCanvas();
});

window.addEventListener("focus", () => {
  if (!state || !roomId) return;
  announcePresence();
});

window.addEventListener("storage", (event) => {
  if (event.key !== roomKey() || !event.newValue) return;
  const routeBeforeSync = currentRoute();
  state = JSON.parse(event.newValue);
  normalizeState(state);
  ensureCurrentPlayer();
  render();
  replayCanvas();
  syncRouteFromPhase();
  const routeAfterSync = currentRoute();
  if (routeAfterSync === routeBeforeSync && ["room", "select-word"].includes(routeAfterSync)) {
    showRoute(routeAfterSync);
  }
});

window.addEventListener("beforeunload", () => {
  if (!state) return;
  rememberSession();
  state.updatedAt = Date.now();
  localStorage.setItem(roomKey(), JSON.stringify(state));
});

function loadClientId() {
  const existing = sessionStorage.getItem(clientIdKey);
  if (existing) return existing;
  const nextId = randomId();
  sessionStorage.setItem(clientIdKey, nextId);
  return nextId;
}

function rememberSession() {
  if (!roomId || !playerName) return;
  sessionStorage.setItem(
    lastSessionKey,
    JSON.stringify({
      roomId,
      playerName,
      isHost,
      updatedAt: Date.now(),
    }),
  );
}

function readLastSession() {
  try {
    return JSON.parse(sessionStorage.getItem(lastSessionKey) || "null");
  } catch {
    return null;
  }
}

function restoreLastSession() {
  const session = readLastSession();
  if (!session?.roomId || !session?.playerName) return false;
  const savedRoom = sanitizeRoom(session.roomId);
  if (presetRoom && sanitizeRoom(presetRoom) !== savedRoom) return false;
  roomId = savedRoom;
  playerName = session.playerName;
  isHost = Boolean(session.isHost);
  state = loadState();
  if (!state) {
    roomId = "";
    playerName = "";
    isHost = false;
    return false;
  }
  ensureCurrentPlayer();
  copyRoom.textContent = roomId;
  render();
  replayCanvas();
  fitCanvas();
  startLocalTimer();
  startPeerMode();
  return true;
}

function keepRouteInCurrentFlow() {
  const expectedRoute = routeForPhase();
  if (!state || !expectedRoute) return false;
  const route = currentRoute();
  if (route === expectedRoute) return false;
  navigate(expectedRoute);
  return true;
}

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
      <small class="version-label">v${APP_VERSION}</small>
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
      <small class="version-label">v${APP_VERSION}</small>
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
      <small class="version-label">v${APP_VERSION}</small>
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
  const players = roomDisplayPlayers();
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

function roomDisplayPlayers() {
  const players = state ? Object.values(state.players) : [];
  const hasOtherPlayer = players.some((player) => player.id !== clientId);
  if (!isHost && !hasOtherPlayer) {
    return [
      { id: "__host_pending__", name: "房主连接中", score: 0, pending: true },
      ...players,
    ];
  }
  return players;
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
  const currentTurn = state?.roundNumber || 1;
  const totalTurnCount = totalTurns();
  const scoreText = formatScore();
  return `
    <section class="mobile-shell result-shell ${success ? "success" : "failed"}">
      <div class="result-badge">${success ? "✓" : "×"}</div>
      <h1>${success ? "回合成功！" : "回合失败"}</h1>
      <p>正确答案：<strong>${sanitizeHtml(result.word || state?.lastWord || "未知")}</strong></p>
      <div class="shell-card result-stats">
        <p>猜测耗时：${result.timeUsed ?? 60} 秒</p>
        <p>当前进度：${roundProgressText()}</p>
        <p>当前分数：${scoreText}</p>
      </div>
      <div class="shell-actions">
        <button type="button" id="resultPrimary" ${isHost ? "" : "disabled"}>${isHost ? (currentTurn >= totalTurnCount ? "查看最终成绩" : "进入下一轮") : "等待房主继续"}</button>
        <button class="secondary" type="button" data-nav="home">返回首页</button>
      </div>
    </section>
  `;
}

function renderFinalResultPage() {
  const history = state?.history || [];
  const scoreText = formatScore();
  return `
    <section class="mobile-shell result-shell final-shell">
      <div class="result-badge trophy">★</div>
      <h1>游戏结束</h1>
      <p>${scoreText}</p>
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
    if ((state?.roundNumber || 1) >= totalTurns()) {
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
  const joiningExistingRoom = Boolean(enteredRoom);
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
    joinedAt: state.players[clientId]?.joinedAt || Date.now(),
  };
  if (joiningExistingRoom && state.drawerId === clientId && Object.keys(state.players).length <= 1) {
    state.drawerId = "";
  }
  if (!state.drawerId && isHost) state.drawerId = clientId;
  rememberSession();
  saveState({ broadcast: !joiningExistingRoom });
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
  if (!["room", "result"].includes(state.phase)) return;
  if (state.phase === "result") rotateDrawer();
  state.phase = "select-word";
  state.wordOptions = pickWords(4);
  state.roundNumber = (state.roundNumber || 0) + 1;
  state.result = null;
  state.word = "";
  state.roundEndsAt = 0;
  state.lines = [];
  state.strokes = [];
  state.redoStrokes = [];
  state.boardVersion = (state.boardVersion || 0) + 1;
  clearRelayLineQueue();
  replayCanvas();
  saveState({ broadcast: false });
  sendFlowSync({ type: "select", state, boardVersion: state.boardVersion });
  navigate("select-word");
}

function rotateDrawer() {
  const players = Object.values(state.players || {}).sort((a, b) => a.joinedAt - b.joinedAt);
  if (players.length < 2) return;
  const currentIndex = Math.max(0, players.findIndex((player) => player.id === state.drawerId));
  state.drawerId = players[(currentIndex + 1) % players.length].id;
}

function startNewRound(word) {
  requirePlayer();
  if (isDrawer()) return;
  if (state.phase !== "select-word") return;
  state.phase = "game";
  state.roundId = randomId();
  state.word = word;
  state.lastWord = word;
  state.hintVisible = false;
  state.roundEndsAt = Date.now() + roundDurationMs();
  state.lines = [];
  state.strokes = [];
  state.redoStrokes = [];
  state.boardVersion = (state.boardVersion || 0) + 1;
  state.result = null;
  clearRelayLineQueue();
  state.messages = [
    ...state.messages.slice(-30),
    makeMessage("系统", `${playerName} 开始了新一轮`, "system"),
  ];
  replayCanvas();
  saveState({ broadcast: false });
  sendFlowSync({ type: "round", state });
}

function finishRound(success) {
  if (!state || state.phase === "result" || state.phase === "final-result") return;
  if (!success && !isHost) return;
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
  sendFlowSync({ type: "result", state });
  navigate("result");
}

function finishGame() {
  if (!state) return;
  if (!isHost || state.phase !== "result") return;
  state.phase = "final-result";
  saveState({ broadcast: false });
  sendFlowSync({ type: "final", state });
  navigate("final-result");
}

function pickWords(count) {
  const selected = [];
  [2, 3, 4].forEach((length) => {
    const word = pickRandomWord(WORDS.filter((item) => wordLength(item) === length), selected);
    if (word) selected.push(word);
  });

  while (selected.length < count) {
    const word = pickRandomWord(WORDS, selected);
    if (!word) break;
    selected.push(word);
  }

  return shuffle(selected).slice(0, count);
}

function pickRandomWord(words, excluded = []) {
  const excludedSet = new Set(excluded);
  const candidates = words.filter((word) => !excludedSet.has(word));
  if (!candidates.length) return "";
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function shuffle(items) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function formatScore() {
  const players = Object.values(state?.players || {}).sort((a, b) => a.joinedAt - b.joinedAt);
  return players.map((player) => player.score || 0).join(" : ") || "0 : 0";
}

function totalTurns() {
  return (state?.totalRounds || 3) * 2;
}

function roundProgressText() {
  return `${state?.roundNumber || 1} / ${totalTurns()} 次`;
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

function refreshShellRoute() {
  const route = currentRoute();
  if (route === "room" || route === "select-word") showRoute(route);
}

function phaseRank(phase) {
  return {
    room: 0,
    "select-word": 1,
    game: 2,
    result: 3,
    "final-result": 4,
  }[phase] ?? 0;
}

function isAuthorizedDrawerEvent(data) {
  return Boolean(data?.senderId && state?.drawerId && data.senderId === state.drawerId);
}

function shouldAcceptFlowState(remoteState) {
  if (!remoteState) return false;
  normalizeState(remoteState);
  normalizeState(state);
  const remoteRound = remoteState.roundNumber || 0;
  const localRound = state.roundNumber || 0;
  if (remoteRound < localRound) return false;
  if (remoteRound > localRound) return true;
  return phaseRank(remoteState.phase) >= phaseRank(state.phase);
}

copyRoom.addEventListener("click", async () => {
  await navigator.clipboard?.writeText(inviteUrl());
  addMessage("系统", "邀请链接已复制，发给对方打开就能进房间", "system");
});

startRound.addEventListener("click", () => {
  if (!isHost) {
    addMessage("系统", "只有房主可以推进游戏", "system");
    return;
  }
  if (!["room", "result"].includes(state?.phase)) {
    addMessage("系统", "本轮正在进行，不能直接换题", "system");
    return;
  }
  beginWordSelection();
});

swapRole.addEventListener("click", () => {
  requirePlayer();
  if (!isHost || state.phase !== "room") {
    addMessage("系统", "只能由房主在等待房间调整角色", "system");
    return;
  }
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
  state.boardVersion = (state.boardVersion || 0) + 1;
  clearRelayLineQueue();
  replayCanvas();
  saveState({ broadcast: false });
  sendSync({ type: "clear", roundId: state.roundId, boardVersion: state.boardVersion });
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
    state.messages = [
      ...state.messages.slice(-30),
      makeMessage(playerName, text, "message"),
      makeMessage("系统", `${playerName} 猜错了`, "wrong"),
    ];
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
  };
  addDeterministicTexture(line);
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
  const currentWordLength = wordLength(state.word);

  game.dataset.role = drawerMode ? "drawer" : "guesser";
  game.dataset.phase = state.phase || "";
  const compactGame = window.matchMedia("(max-width: 760px)").matches;
  roundTitle.textContent =
    state.phase === "game" && state.word
      ? drawerMode
        ? state.word
        : "？".repeat(Math.max(1, currentWordLength))
      : drawer
        ? `${drawer.name} 正在画`
        : "等待玩家";
  timer.textContent = `${secondsLeft}s`;
  score.textContent = compactGame
    ? `第 ${state.roundNumber || 1}/${totalTurns()} 次`
    : players.map((player) => player.score).join(" : ") || "0 : 0";
  roleLabel.textContent = drawerMode ? "画手" : "猜词";
  wordLabel.textContent = drawerMode
    ? state.word || "点开始/换题"
    : state.word
      ? `${currentWordLength} 个字`
      : "等待新题目";

  playerList.innerHTML = "";
  roomDisplayPlayers().forEach((player) => {
    const item = document.createElement("li");
    item.textContent = player.pending
      ? player.name
      : `${player.name}${player.id === state.drawerId ? " · 画手" : ""} · ${player.score}分`;
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
  const lengthHint = state.word && !drawerMode ? `${currentWordLength}字，` : "";
  guessInput.placeholder = state.hintVisible
    ? `提示：${lengthHint}${hintForCategory(state.category)}，输入答案...`
    : state.word && !drawerMode
      ? `答案 ${currentWordLength} 字，输入答案或聊天`
      : "输入答案或聊天";
}

function wordLength(word) {
  return [...String(word || "")].length;
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
  ctx.globalAlpha = Math.max(0.18, (line.opacity ?? 0.8) * 0.45);
  ctx.lineWidth = Math.max(1, line.size * 0.35);
  const offsets = line.textureOffsets || [-0.18, 0, 0.18];
  offsets.forEach((offsetRatio) => {
    const offset = offsetRatio * line.size;
    ctx.beginPath();
    ctx.moveTo(line.from.x + offset, line.from.y - offset);
    ctx.lineTo(line.to.x + offset, line.to.y - offset);
    ctx.stroke();
  });
}

function addDeterministicTexture(line) {
  if (line.tool !== "crayon") return;
  const random = seededRandom(`${line.strokeId}:${line.id}`);
  line.textureOffsets = [-0.18, 0, 0.18].map((base) => base + (random() - 0.5) * 0.22);
}

function seededRandom(seed) {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return () => {
    hash += 0x6d2b79f5;
    let value = hash;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
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
  state.boardVersion = (state.boardVersion || 0) + 1;
  saveState({ broadcast: false });
  sendSync({ type: "fill", fill, boardVersion: state.boardVersion, state });
  sendCanvasSnapshot("fill");
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

function makeImagePatch(beforeImage, afterImage) {
  if (
    !beforeImage ||
    !afterImage ||
    beforeImage.width !== afterImage.width ||
    beforeImage.height !== afterImage.height
  ) {
    return null;
  }

  const before = beforeImage.data;
  const after = afterImage.data;
  const width = afterImage.width;
  const height = afterImage.height;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let index = 0; index < after.length; index += 4) {
    if (
      before[index] === after[index] &&
      before[index + 1] === after[index + 1] &&
      before[index + 2] === after[index + 2] &&
      before[index + 3] === after[index + 3]
    ) {
      continue;
    }
    const pixel = index / 4;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  if (maxX < minX || maxY < minY) return null;

  const padding = 80;
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(width - 1, maxX + padding);
  maxY = Math.min(height - 1, maxY + padding);

  const patchWidth = maxX - minX + 1;
  const patchHeight = maxY - minY + 1;
  const patchData = new Uint8ClampedArray(patchWidth * patchHeight * 4);
  for (let row = 0; row < patchHeight; row += 1) {
    const sourceStart = ((minY + row) * width + minX) * 4;
    const sourceEnd = sourceStart + patchWidth * 4;
    patchData.set(after.slice(sourceStart, sourceEnd), row * patchWidth * 4);
  }

  return {
    x: minX,
    y: minY,
    width: patchWidth,
    height: patchHeight,
    data: encodeBytes(patchData),
  };
}

function applyImagePatch(patch) {
  if (!patch?.data || !patch.width || !patch.height) return false;
  const x = Math.max(0, Math.round(patch.x || 0));
  const y = Math.max(0, Math.round(patch.y || 0));
  const width = Math.round(patch.width);
  const height = Math.round(patch.height);
  if (width <= 0 || height <= 0 || x >= canvas.width || y >= canvas.height) return false;
  try {
    const bytes = decodeBytes(patch.data);
    if (bytes.length !== width * height * 4) return false;
    ctx.putImageData(new ImageData(bytes, width, height), x, y);
    return true;
  } catch {
    return false;
  }
}

function encodeBytes(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function decodeBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8ClampedArray(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
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
    state.boardVersion = (state.boardVersion || 0) + 1;
    sendSync({ type: "stroke", stroke: currentStroke, state, boardVersion: state.boardVersion });
    sendCanvasSnapshot("stroke");
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
  sendSync({ type: "undo", strokeId: stroke.id, boardVersion: state.boardVersion });
}

function redoLastStroke() {
  const stroke = (state.redoStrokes || []).at(-1);
  if (!stroke) return;
  applyRedo(stroke);
  sendSync({ type: "redo", stroke, boardVersion: state.boardVersion });
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
  state.boardVersion = (state.boardVersion || 0) + 1;
  saveState({ broadcast: false });
}

function applyRedo(stroke) {
  if (!stroke || (stroke.roundId && stroke.roundId !== state.roundId)) return;
  if (stroke.type === "fill") {
    if (!(state.strokes || []).some((item) => item.id === stroke.id)) {
      state.strokes = [...(state.strokes || []), stroke];
    }
    state.redoStrokes = (state.redoStrokes || []).filter((item) => item.id !== stroke.id);
    state.boardVersion = (state.boardVersion || 0) + 1;
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
  state.boardVersion = (state.boardVersion || 0) + 1;
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

function roundDurationMs() {
  const testSeconds = Number(new URLSearchParams(window.location.search).get("roundSeconds"));
  const testHost = ["127.0.0.1", "localhost"].includes(window.location.hostname);
  if (testHost && Number.isFinite(testSeconds) && testSeconds > 0) {
    return Math.max(1, Math.min(60, testSeconds)) * 1000;
  }
  return 60_000;
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
  if (currentRoute() === "room" || currentRoute() === "select-word") {
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
  startSyncHeartbeat();

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

function startSyncHeartbeat() {
  clearInterval(syncHeartbeatTimer);
  syncHeartbeatTimer = setInterval(() => {
    if (!state || !roomId || !playerName) return;
    if (isHost) {
      announcePresence();
    } else {
      announcePresence();
    }
  }, 2500);
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
      sendPeerSnapshot(connection);
      setTimeout(() => sendPeerSnapshot(connection), 700);
      setTimeout(() => sendPeerSnapshot(connection), 1800);
    } else {
      sendPeerJoinRequest(connection);
      setTimeout(() => sendPeerJoinRequest(connection), 700);
      setTimeout(() => sendPeerJoinRequest(connection), 1800);
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

function sendPeerSnapshot(connection) {
  if (!state?.players?.[clientId]) return;
  sendToPeer(connection, {
    type: "presence",
    player: state.players[clientId],
    isHost: true,
    drawerId: state.drawerId || clientId,
    senderId: clientId,
  });
  sendToPeer(connection, {
    type: "state",
    state,
    senderId: clientId,
  });
}

function sendPeerJoinRequest(connection) {
  if (!state?.players?.[clientId]) return;
  sendToPeer(connection, {
    type: "join",
    player: state.players[clientId],
    senderId: clientId,
  });
  sendToPeer(connection, {
    type: "state-request",
    player: state.players[clientId],
    senderId: clientId,
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
  if (options.relay !== false) publishRelay(event, options);
}

function sendFlowSync(payload) {
  sendSync(payload, { forceRelay: true });
  setTimeout(() => sendSync(payload, { forceRelay: true }), 700);
  setTimeout(() => sendSync(payload, { forceRelay: true }), 1800);
}

function sendCanvasSnapshot(reason) {
  if (!state?.roundId) return;
  const snapshot = {
    roundId: state.roundId,
    boardVersion: state.boardVersion || 0,
    width: canvas.width,
    height: canvas.height,
    image: canvas.toDataURL("image/png"),
    reason,
  };
  sendSync({ type: "canvas", snapshot, state, boardVersion: snapshot.boardVersion }, { forceRelay: true });
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

  if (data.type === "presence") {
    applyPresence(data.player, data);
    broadcastPeer(data, exceptPeer);
    return;
  }

  if (data.type === "join" && isHost) {
    handleJoin(data.player);
    return;
  }

  if (data.type === "state-request" && isHost) {
    if (data.player) handleJoin(data.player);
    sendSync({ type: "state", state }, { forceRelay: true });
    return;
  }

  applyingRemoteState = true;
  if (data.type === "state") {
    const remoteGameSameRound =
      state?.phase === "game" &&
      data.state?.phase === "game" &&
      (!state.roundId || !data.state.roundId || state.roundId === data.state.roundId);
    state =
      isHost || (isDrawer() && remoteGameSameRound)
        ? mergePresenceState(data.state, state)
        : adoptFlowState(data.state, { preferRemoteLines: true });
    ensureCurrentPlayer();
    localStorage.setItem(roomKey(), JSON.stringify(state));
    render();
    if (!(isDrawer() && remoteGameSameRound)) replayCanvas();
    syncRouteFromPhase();
    refreshShellRoute();
  }
  if (data.type === "select") {
    if (!shouldAcceptFlowState(data.state)) {
      applyingRemoteState = false;
      return;
    }
    state = adoptFlowState(data.state, { preferRemoteLines: true });
    ensureCurrentPlayer();
    localStorage.setItem(roomKey(), JSON.stringify(state));
    render();
    replayCanvas();
    navigate("select-word");
  }
  if (data.type === "round") {
    if (!shouldAcceptFlowState(data.state)) {
      applyingRemoteState = false;
      return;
    }
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
    if (state?.phase === "result" && state.roundId === data.state?.roundId && state.result?.success && data.state?.result?.success === false) {
      applyingRemoteState = false;
      return;
    }
    if (!shouldAcceptFlowState(data.state)) {
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
    if (!shouldAcceptFlowState(data.state)) {
      applyingRemoteState = false;
      return;
    }
    state = adoptFlowState(data.state, { preferRemoteLines: true });
    ensureCurrentPlayer();
    localStorage.setItem(roomKey(), JSON.stringify(state));
    render();
    replayCanvas();
    navigate("final-result");
  }
  if (data.type === "clear") {
    if (!isAuthorizedDrawerEvent(data)) {
      applyingRemoteState = false;
      return;
    }
    if (!data.roundId || data.roundId === state.roundId) {
      state.lines = [];
      state.strokes = [];
      state.redoStrokes = [];
      state.boardVersion = Math.max(state.boardVersion || 0, data.boardVersion || 0);
      localStorage.setItem(roomKey(), JSON.stringify(state));
      replayCanvas();
    }
  }
  if (data.type === "undo") {
    if (!isAuthorizedDrawerEvent(data)) {
      applyingRemoteState = false;
      return;
    }
    applyUndo(data.strokeId);
    state.boardVersion = Math.max(state.boardVersion || 0, data.boardVersion || 0);
    localStorage.setItem(roomKey(), JSON.stringify(state));
  }
  if (data.type === "redo") {
    if (!isAuthorizedDrawerEvent(data)) {
      applyingRemoteState = false;
      return;
    }
    applyRedo(data.stroke);
    state.boardVersion = Math.max(state.boardVersion || 0, data.boardVersion || 0);
    localStorage.setItem(roomKey(), JSON.stringify(state));
  }
  if (data.type === "line") {
    if (!isAuthorizedDrawerEvent(data)) {
      applyingRemoteState = false;
      return;
    }
    applyRemoteLine(data.line);
  }
  if (data.type === "lines") {
    if (!isAuthorizedDrawerEvent(data)) {
      applyingRemoteState = false;
      return;
    }
    data.lines?.forEach(applyRemoteLine);
  }
  if (data.type === "stroke") {
    adoptDrawingEventState(data);
    if (!isAuthorizedDrawerEvent(data)) {
      applyingRemoteState = false;
      return;
    }
    applyRemoteStroke(data.stroke);
  }
  if (data.type === "fill") {
    adoptDrawingEventState(data);
    if (!isAuthorizedDrawerEvent(data)) {
      applyingRemoteState = false;
      return;
    }
    applyRemoteFill(data.fill);
    state.boardVersion = Math.max(state.boardVersion || 0, data.boardVersion || 0);
    localStorage.setItem(roomKey(), JSON.stringify(state));
  }
  if (data.type === "canvas") {
    adoptDrawingEventState(data);
    if (!isAuthorizedDrawerEvent(data)) {
      applyingRemoteState = false;
      return;
    }
    state.boardVersion = Math.max(state.boardVersion || 0, data.boardVersion || 0);
    localStorage.setItem(roomKey(), JSON.stringify(state));
    applyCanvasSnapshot(data.snapshot);
  }
  applyingRemoteState = false;

  if (["state", "select", "round", "result", "final", "clear", "undo", "redo", "line", "lines", "stroke", "fill", "canvas"].includes(data.type)) {
    broadcastPeer(data, exceptPeer);
  }
}

function applyCanvasSnapshot(snapshot) {
  if (!snapshot?.image || snapshot.roundId !== state.roundId) return;
  const snapshotVersion = snapshot.boardVersion || 0;
  const image = new Image();
  image.onload = () => {
    if (snapshot.roundId !== state.roundId) return;
    if (snapshotVersion < (state.boardVersion || 0)) return;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    ctx.restore();
  };
  image.src = snapshot.image;
}

function applyPresence(player, data = {}) {
  if (!player || !state) return;
  const existing = state.players?.[player.id];
  state.players[player.id] = {
    ...existing,
    ...player,
    score: Math.max(player.score || 0, existing?.score || 0),
    joinedAt: Math.min(player.joinedAt || Date.now(), existing?.joinedAt || Date.now()),
  };
  if (!state.drawerId && data.drawerId) state.drawerId = data.drawerId;
  ensureCurrentPlayer();
  localStorage.setItem(roomKey(), JSON.stringify(state));
  render();
  refreshShellRoute();
}

function adoptDrawingEventState(data) {
  if (isHost || !data?.state || !shouldAcceptFlowState(data.state)) return;
  state = adoptFlowState(data.state, { preferRemoteLines: true });
  ensureCurrentPlayer();
  localStorage.setItem(roomKey(), JSON.stringify(state));
  render();
  replayCanvas();
  syncRouteFromPhase();
}

function applyRemoteLine(line) {
  if (!line || state.lines.some((item) => item.id === line.id)) return;
  if (line.roundId && line.roundId !== state.roundId) return;
  state.lines.push(line);
  ensureStrokeForLine(line);
  localStorage.setItem(roomKey(), JSON.stringify(state));
  drawLine(line);
}

function applyRemoteStroke(stroke) {
  if (!stroke || (stroke.roundId && stroke.roundId !== state.roundId)) return;
  const existingLineIds = new Set(state.lines.map((line) => line.id));
  const missingLines = (stroke.lines || []).filter((line) => !existingLineIds.has(line.id));
  if (!missingLines.length && (state.strokes || []).some((item) => item.id === stroke.id)) return;
  state.lines = [...state.lines, ...missingLines];
  if (!(state.strokes || []).some((item) => item.id === stroke.id)) {
    state.strokes = [...(state.strokes || []), stroke];
  }
  localStorage.setItem(roomKey(), JSON.stringify(state));
  missingLines.forEach(drawLine);
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
    announcePresence();
    if (!isHost) {
      setTimeout(announcePresence, 800);
      setTimeout(announcePresence, 2200);
    }
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

function announcePresence() {
  if (!state?.players?.[clientId]) return;
  sendSync(
    {
      type: "presence",
      player: state.players[clientId],
      isHost,
      drawerId: isHost ? state.drawerId || clientId : "",
    },
    { forceRelay: true },
  );
  if (isHost) {
    sendSync({ type: "state", state }, { relay: true });
    return;
  }
  sendSync({ type: "join", player: state.players[clientId] }, { relay: true });
  sendSync({ type: "state-request", player: state.players[clientId] }, { relay: true });
}

function publishRelay(event, options = {}) {
  if (!relayReady) return;
  const now = Date.now();
  if (event.type === "state" && !options.forceRelay && now - lastRelayPublishAt < 350) return;
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

  const remoteRank = phaseRank(remoteState.phase);
  const localRank = phaseRank(localState.phase);
  const baseState =
    remoteRank > localRank
      ? remoteState
      : remoteRank < localRank
        ? localState
        : remoteState.updatedAt >= (localState.updatedAt || 0)
          ? remoteState
          : localState;

  return {
    ...baseState,
    players: mergedPlayers,
    messages: mergedMessages,
    boardVersion: Math.max(remoteState.boardVersion || 0, localState.boardVersion || 0),
    lines: chooseLines(remoteState, localState, options),
    strokes: chooseStrokes(remoteState, localState, options),
    redoStrokes: baseState.redoStrokes || [],
  };
}

function mergePresenceState(remoteState, localState) {
  if (!remoteState) return localState;
  normalizeState(remoteState);
  normalizeState(localState);
  return {
    ...localState,
    players: mergePlayers(remoteState.players, localState.players),
    messages: [...(remoteState.messages || []), ...(localState.messages || [])]
      .filter((message, index, all) => all.findIndex((item) => item.id === message.id) === index)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-40),
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
    boardVersion: Math.max(remoteState.boardVersion || 0, state.boardVersion || 0),
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
  if ((remoteState.boardVersion || 0) !== (localState.boardVersion || 0)) {
    return (remoteState.boardVersion || 0) > (localState.boardVersion || 0)
      ? remoteState.lines || []
      : localState.lines || [];
  }
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
  if ((remoteState.boardVersion || 0) !== (localState.boardVersion || 0)) {
    return (remoteState.boardVersion || 0) > (localState.boardVersion || 0)
      ? remoteState.strokes || []
      : localState.strokes || [];
  }
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
  saveState({ broadcast: false });
  sendSync({ type: "state", state }, { forceRelay: true });
  setTimeout(() => sendSync({ type: "state", state }, { forceRelay: true }), 700);
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
  } else {
    state.players[clientId] = {
      ...state.players[clientId],
      id: clientId,
      name: playerName,
      joinedAt: state.players[clientId].joinedAt || Date.now(),
    };
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
  targetState.boardVersion ||= 0;
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
