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
const colorPicker = document.querySelector("#colorPicker");
const eraser = document.querySelector("#eraser");
const undoStroke = document.querySelector("#undoStroke");
const redoStroke = document.querySelector("#redoStroke");
const zoomOut = document.querySelector("#zoomOut");
const zoomIn = document.querySelector("#zoomIn");
const zoomFit = document.querySelector("#zoomFit");
const zoomLabel = document.querySelector("#zoomLabel");
const canvasViewport = document.querySelector("#canvasViewport");
const messages = document.querySelector("#messages");
const guessForm = document.querySelector("#guessForm");
const guessInput = document.querySelector("#guessInput");
const canvas = document.querySelector("#board");
const ctx = canvas.getContext("2d");

ctx.lineCap = "round";
ctx.lineJoin = "round";
if (presetRoom) roomInput.value = sanitizeRoom(presetRoom);
setZoom(1);

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  playerName = nameInput.value.trim();
  const enteredRoom = sanitizeRoom(roomInput.value);
  roomId = (enteredRoom || makeRoomCode()).toUpperCase();
  isHost = !enteredRoom;
  if (!playerName) return;

  state = loadState() || createState();
  state.players[clientId] = {
    id: clientId,
    name: playerName,
    score: state.players[clientId]?.score || 0,
    joinedAt: Date.now(),
  };
  if (!state.drawerId) state.drawerId = clientId;
  saveState();

  lobby.classList.add("hidden");
  game.classList.remove("hidden");
  copyRoom.textContent = roomId;
  render();
  replayCanvas();
  fitCanvas();
  startLocalTimer();
  startPeerMode();
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
});

window.addEventListener("beforeunload", () => {
  if (!state) return;
  delete state.players[clientId];
  if (state.drawerId === clientId) state.drawerId = Object.keys(state.players)[0] || "";
  saveState();
});

copyRoom.addEventListener("click", async () => {
  await navigator.clipboard?.writeText(inviteUrl());
  addMessage("系统", "邀请链接已复制，发给对方打开就能进房间", "system");
});

startRound.addEventListener("click", () => {
  requirePlayer();
  const word = WORDS[Math.floor(Math.random() * WORDS.length)];
  state.roundId = randomId();
  state.word = word;
  state.roundEndsAt = Date.now() + 60_000;
  state.lines = [];
  state.strokes = [];
  state.redoStrokes = [];
  clearRelayLineQueue();
  state.messages = [
    ...state.messages.slice(-30),
    makeMessage("系统", `${playerName} 开始了新一轮`, "system"),
  ];
  replayCanvas();
  saveState({ broadcast: false });
  sendSync({ type: "round", state });
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

clearCanvas.addEventListener("click", () => {
  if (!requireDrawer()) return;
  if (!confirm("确定清空当前画板吗？")) return;
  state.lines = [];
  state.strokes = [];
  state.redoStrokes = [];
  clearRelayLineQueue();
  replayCanvas();
  saveState({ broadcast: false });
  sendSync({ type: "clear", roundId: state.roundId });
});

document.querySelectorAll("[data-tool]").forEach((button) => {
  button.addEventListener("click", () => {
    currentTool = button.dataset.tool;
    setActive("[data-tool]", button);
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

document.querySelectorAll("[data-size]").forEach((button) => {
  button.addEventListener("click", () => {
    brushSize = Number(button.dataset.size);
    setActive("[data-size]", button);
  });
});

document.querySelectorAll("[data-eraser-size]").forEach((button) => {
  button.addEventListener("click", () => {
    eraserSize = Number(button.dataset.eraserSize);
    setActive("[data-eraser-size]", button);
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

zoomOut.addEventListener("click", () => setZoom(zoom - 0.15));
zoomIn.addEventListener("click", () => setZoom(zoom + 0.15));
zoomFit.addEventListener("click", fitCanvas);

guessForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = guessInput.value.trim();
  if (!text) return;
  guessInput.value = "";

  const normalizedGuess = normalize(text);
  const isCorrect = state.word && normalizedGuess === normalize(state.word);
  if (isCorrect && clientId !== state.drawerId) {
    state.players[clientId].score += 1;
    state.messages = [
      ...state.messages.slice(-30),
      makeMessage(playerName, `答对了：${state.word}`, "correct"),
    ];
    state.word = "";
    state.roundEndsAt = 0;
  } else {
    state.messages = [...state.messages.slice(-30), makeMessage(playerName, text, "message")];
  }
  saveState();
});

canvas.addEventListener("pointerdown", (event) => {
  if (!isDrawer()) return;
  event.preventDefault();
  drawing = true;
  canvas.setPointerCapture(event.pointerId);
  lastPoint = getCanvasPoint(event);
  currentStroke = createStroke();
  state.redoStrokes = [];
});

canvas.addEventListener("pointermove", (event) => {
  if (!drawing || !isDrawer()) return;
  event.preventDefault();
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

canvas.addEventListener("pointerup", () => {
  drawing = false;
  lastPoint = null;
  finishCurrentStroke();
  saveState();
});

canvas.addEventListener("pointercancel", () => {
  drawing = false;
  lastPoint = null;
  finishCurrentStroke();
  saveState();
});

function createState() {
  return {
    updatedAt: Date.now(),
    drawerId: "",
    word: "",
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

  roundTitle.textContent = drawer ? `${drawer.name} 正在画` : "等待玩家";
  timer.textContent = `${secondsLeft}s`;
  score.textContent = players.map((player) => player.score).join(" : ") || "0 : 0";
  roleLabel.textContent = isDrawer() ? "画手" : "猜词";
  wordLabel.textContent = isDrawer()
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
}

function replayCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  state?.lines.forEach(drawLine);
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
    return { tool: "pencil", color: currentColor, size: Math.max(1, brushSize * 0.75), opacity: 0.72 };
  }
  if (currentTool === "highlighter") {
    return { tool: "highlighter", color: currentColor, size: Math.max(8, brushSize * 1.9), opacity: 0.34 };
  }
  if (currentTool === "crayon") {
    return { tool: "crayon", color: currentColor, size: brushSize, opacity: 0.82 };
  }
  return { tool: "marker", color: currentColor, size: brushSize, opacity: 1 };
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
  if (!stroke.lines?.length) return;
  state.lines = state.lines.filter((line) => line.strokeId !== strokeId);
  state.strokes = (state.strokes || []).filter((item) => item.id !== strokeId);
  state.redoStrokes = [...(state.redoStrokes || []).filter((item) => item.id !== strokeId), stroke];
  saveState({ broadcast: false });
}

function applyRedo(stroke) {
  if (!stroke?.lines?.length || (stroke.roundId && stroke.roundId !== state.roundId)) return;
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
}

function fitCanvas() {
  const availableWidth = Math.max(320, canvasViewport.clientWidth - 28);
  setZoom(Math.min(1, availableWidth / canvas.width));
}

function getCanvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
}

function makeRoomCode() {
  return Math.random().toString(36).slice(2, 12);
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

function startLocalTimer() {
  clearInterval(roundTicker);
  roundTicker = setInterval(render, 300);
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
  }
  if (data.type === "round") {
    state = mergeState(data.state, state, { preferRemoteLines: true });
    ensureCurrentPlayer();
    localStorage.setItem(roomKey(), JSON.stringify(state));
    render();
    replayCanvas();
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
  applyingRemoteState = false;

  if (["state", "round", "clear", "undo", "redo"].includes(data.type)) {
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
  const mergedPlayers = { ...remoteState.players, ...localState.players };
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

function inviteUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  return url.toString();
}
