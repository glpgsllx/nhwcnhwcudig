const WORDS = [
  "奶茶",
  "月亮",
  "小狗",
  "火锅",
  "飞机",
  "雨伞",
  "西瓜",
  "耳机",
  "蛋糕",
  "企鹅",
  "玫瑰",
  "电影",
  "城堡",
  "吉他",
  "拖鞋",
  "雪人",
];

const storagePrefix = "draw-and-guess-demo:";
const clientId = randomId();
let roomId = "";
let playerName = "";
let state = null;
let drawing = false;
let lastPoint = null;
let erasing = false;
let roundTicker = null;
let isHost = false;
let peer = null;
let connections = [];
let applyingRemoteState = false;

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
const roleLabel = document.querySelector("#roleLabel");
const wordLabel = document.querySelector("#wordLabel");
const playerList = document.querySelector("#playerList");
const startRound = document.querySelector("#startRound");
const swapRole = document.querySelector("#swapRole");
const clearCanvas = document.querySelector("#clearCanvas");
const colorPicker = document.querySelector("#colorPicker");
const sizePicker = document.querySelector("#sizePicker");
const eraser = document.querySelector("#eraser");
const messages = document.querySelector("#messages");
const guessForm = document.querySelector("#guessForm");
const guessInput = document.querySelector("#guessInput");
const canvas = document.querySelector("#board");
const ctx = canvas.getContext("2d");

ctx.lineCap = "round";
ctx.lineJoin = "round";
if (presetRoom) roomInput.value = sanitizeRoom(presetRoom);

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
  startLocalTimer();
  startPeerMode();
});

window.addEventListener("storage", (event) => {
  if (event.key !== roomKey() || !event.newValue) return;
  state = JSON.parse(event.newValue);
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
  state.word = word;
  state.roundEndsAt = Date.now() + 60_000;
  state.lines = [];
  state.messages = [
    ...state.messages.slice(-30),
    makeMessage("系统", `${playerName} 开始了新一轮`, "system"),
  ];
  saveState();
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
  state.lines = [];
  saveState();
});

eraser.addEventListener("click", () => {
  erasing = !erasing;
  eraser.textContent = erasing ? "画笔" : "橡皮";
});

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
});

canvas.addEventListener("pointermove", (event) => {
  if (!drawing || !isDrawer()) return;
  event.preventDefault();
  const nextPoint = getCanvasPoint(event);
  const line = {
    from: lastPoint,
    to: nextPoint,
    color: erasing ? "#ffffff" : colorPicker.value,
    size: erasing ? Number(sizePicker.value) * 2 : Number(sizePicker.value),
  };
  state.lines.push(line);
  drawLine(line);
  lastPoint = nextPoint;
  throttleSave();
});

canvas.addEventListener("pointerup", () => {
  drawing = false;
  lastPoint = null;
  saveState();
});

canvas.addEventListener("pointercancel", () => {
  drawing = false;
  lastPoint = null;
  saveState();
});

function createState() {
  return {
    updatedAt: Date.now(),
    drawerId: "",
    word: "",
    roundEndsAt: 0,
    players: {},
    lines: [],
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
  ctx.strokeStyle = line.color;
  ctx.lineWidth = line.size;
  ctx.beginPath();
  ctx.moveTo(line.from.x, line.from.y);
  ctx.lineTo(line.to.x, line.to.y);
  ctx.stroke();
}

function getCanvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
}

function makeRoomCode() {
  return Math.random().toString(36).slice(2, 8);
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

function saveState() {
  ensureCurrentPlayer();
  state.updatedAt = Date.now();
  localStorage.setItem(roomKey(), JSON.stringify(state));
  render();
  replayCanvas();
  if (!applyingRemoteState) broadcastState();
}

let pendingSave = null;
function throttleSave() {
  if (pendingSave) return;
  pendingSave = requestAnimationFrame(() => {
    pendingSave = null;
    state.updatedAt = Date.now();
    localStorage.setItem(roomKey(), JSON.stringify(state));
    broadcastState();
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
  if (!window.Peer) {
    addMessage("系统", "联网库未加载，当前是本机双窗口试玩模式", "system");
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
    if (!isHost) connectToHost(hostPeerId);
  });

  peer.on("connection", (connection) => {
    attachConnection(connection);
  });

  peer.on("error", (error) => {
    addMessage("系统", `联机暂不可用：${error.type || error.message}`, "system");
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
    if (isHost) {
      connection.send({ type: "state", state });
    } else {
      connection.send({ type: "join", player: state.players[clientId] });
    }
    addMessage("系统", isHost ? "对方已连接" : "已连接到房间", "system");
  });

  connection.on("data", (data) => {
    if (data?.type === "join" && isHost) {
      handleJoin(data.player);
      return;
    }
    if (data?.type !== "state") return;
    applyingRemoteState = true;
    state = mergeState(data.state, state);
    ensureCurrentPlayer();
    localStorage.setItem(roomKey(), JSON.stringify(state));
    render();
    replayCanvas();
    applyingRemoteState = false;
    broadcastState(connection.peer);
  });

  connection.on("close", () => {
    connections = connections.filter((item) => item !== connection);
    addMessage("系统", "对方已断开", "system");
  });
}

function broadcastState(exceptPeer = "") {
  connections.forEach((connection) => {
    if (connection.peer === exceptPeer || !connection.open) return;
    connection.send({ type: "state", state });
  });
}

function mergeState(remoteState, localState) {
  if (!remoteState) return localState;
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
    lines: remoteState.lines.length >= localState.lines.length ? remoteState.lines : localState.lines,
  };
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

function ensureCurrentPlayer() {
  if (!state || !playerName) return;
  if (!state.players[clientId]) {
    state.players[clientId] = { id: clientId, name: playerName, score: 0, joinedAt: Date.now() };
  }
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
