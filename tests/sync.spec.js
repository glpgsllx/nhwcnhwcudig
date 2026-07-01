const { test, expect } = require("@playwright/test");
const { spawn } = require("node:child_process");

const PORT = 5180;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let server;
test.setTimeout(120_000);

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error("local static server did not start");
}

test.beforeEach(async () => {
  server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
    stdio: "ignore",
  });
  await waitForServer();
});

test.afterEach(() => {
  server?.kill();
  server = undefined;
});

async function nonWhitePixels(page) {
  return page.locator("#board").evaluate((canvas) => {
    const ctx = canvas.getContext("2d");
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] < 250 || data[index + 1] < 250 || data[index + 2] < 250) count += 1;
    }
    return count;
  });
}

async function canvasData(page) {
  return page.locator("#board").evaluate((canvas) => {
    const ctx = canvas.getContext("2d");
    return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  });
}

async function canvasDiff(firstPage, secondPage) {
  const [first, second] = await Promise.all([canvasData(firstPage), canvasData(secondPage)]);
  let changedPixels = 0;
  let totalDelta = 0;
  for (let index = 0; index < first.length; index += 4) {
    const delta =
      Math.abs(first[index] - second[index]) +
      Math.abs(first[index + 1] - second[index + 1]) +
      Math.abs(first[index + 2] - second[index + 2]) +
      Math.abs(first[index + 3] - second[index + 3]);
    if (delta > 20) changedPixels += 1;
    totalDelta += delta;
  }
  return { changedPixels, totalDelta };
}

async function redPixels(page) {
  return page.locator("#board").evaluate((canvas) => {
    const ctx = canvas.getContext("2d");
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] > 190 && data[index + 1] < 110 && data[index + 2] < 110) count += 1;
    }
    return count;
  });
}

async function canvasMetrics(page) {
  return page.locator("#board").evaluate((canvas) => {
    const ctx = canvas.getContext("2d");
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let sumX = 0;
    let sumY = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] < 250 || data[index + 1] < 250 || data[index + 2] < 250) {
        const pixel = index / 4;
        const x = pixel % width;
        const y = Math.floor(pixel / width);
        count += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        sumX += x;
        sumY += y;
      }
    }
    return {
      count,
      minX: count ? minX : 0,
      minY: count ? minY : 0,
      maxX: count ? maxX : 0,
      maxY: count ? maxY : 0,
      centerX: count ? sumX / count : 0,
      centerY: count ? sumY / count : 0,
    };
  });
}

async function drawLineAt(page, { fromX, fromY, toX, toY } = {}) {
  const before = await nonWhitePixels(page);
  const box = await page.locator("#board").boundingBox();
  const startX = box.x + box.width * (fromX ?? 0.35);
  const startY = box.y + box.height * (fromY ?? 0.35);
  const endX = box.x + box.width * (toX ?? 0.65);
  const endY = box.y + box.height * (toY ?? 0.55);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => nonWhitePixels(page), { timeout: 5000 }).toBeGreaterThan(before + 20);
}

async function drawLine(page) {
  await drawLineAt(page);
}

async function drawClosedBoxAndFill(page) {
  const box = await page.locator("#board").boundingBox();
  await page.locator('[data-tool="marker"]').click();
  await page.locator('[data-color="#111827"]').click();
  await page.mouse.move(box.x + box.width * 0.32, box.y + box.height * 0.32);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.68, box.y + box.height * 0.32, { steps: 10 });
  await page.mouse.move(box.x + box.width * 0.68, box.y + box.height * 0.68, { steps: 10 });
  await page.mouse.move(box.x + box.width * 0.32, box.y + box.height * 0.68, { steps: 10 });
  await page.mouse.move(box.x + box.width * 0.32, box.y + box.height * 0.32, { steps: 10 });
  await page.mouse.up();
  await page.locator('[data-color="#ef4444"]').click();
  await page.locator('[data-tool="fill"]').click();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await expect.poll(() => redPixels(page), { timeout: 5000 }).toBeGreaterThan(500);
}

async function selectTool(page, tool) {
  if (!tool || tool === "marker") return;
  await page.locator(`[data-tool="${tool}"]`).click();
  await expect(page.locator(`[data-tool="${tool}"]`)).toHaveClass(/active/);
}

async function completeRound({ host, guest, drawer, guesser, selector, wrongGuess, roundNumber, tool, fillBox }) {
  const drawerPage = drawer === "host" ? host : guest;
  const guesserPage = guesser === "host" ? host : guest;
  const drawerName = drawer === "host" ? "房主" : "访客";
  const guesserName = guesser === "host" ? "房主" : "访客";

  await expect(drawerPage.getByText("等待选词...")).toBeVisible({ timeout: 5000 });
  await expect(selector.getByText("盲选词语")).toBeVisible({ timeout: 5000 });

  await selector.locator("[data-word]").first().click();
  await expect(drawerPage.locator("#game")).toBeVisible({ timeout: 5000 });
  await expect(guesserPage.locator("#game")).toBeVisible({ timeout: 5000 });

  const word = (await drawerPage.locator("#roundTitle").textContent()).trim();
  expect(word).not.toContain("？");
  await expect(guesserPage.locator("#roundTitle")).toContainText("？");
  await expect(drawerPage.locator("#score")).toContainText(`第 ${roundNumber}/6 次`);
  await expect(guesserPage.locator("#score")).toContainText(`第 ${roundNumber}/6 次`);

  await selectTool(drawerPage, tool);
  if (fillBox) {
    await drawClosedBoxAndFill(drawerPage);
    await expect.poll(() => redPixels(guesserPage), { timeout: 5000 }).toBeGreaterThan(500);
    const diff = await canvasDiff(drawerPage, guesserPage);
    expect(diff.changedPixels).toBeLessThan(20);
    expect(diff.totalDelta).toBeLessThan(2000);
  } else {
    await drawLine(drawerPage);
    await expect.poll(() => nonWhitePixels(guesserPage), { timeout: 5000 }).toBeGreaterThan(20);
    await expect
      .poll(async () => {
        const [drawerMetrics, guesserMetrics] = await Promise.all([
          canvasMetrics(drawerPage),
          canvasMetrics(guesserPage),
        ]);
        const countRatio =
          Math.abs(drawerMetrics.count - guesserMetrics.count) / Math.max(1, drawerMetrics.count);
        const centerDistance = Math.hypot(
          drawerMetrics.centerX - guesserMetrics.centerX,
          drawerMetrics.centerY - guesserMetrics.centerY,
        );
        const boxDistance =
          Math.abs(drawerMetrics.minX - guesserMetrics.minX) +
          Math.abs(drawerMetrics.minY - guesserMetrics.minY) +
          Math.abs(drawerMetrics.maxX - guesserMetrics.maxX) +
          Math.abs(drawerMetrics.maxY - guesserMetrics.maxY);
        return countRatio < 0.35 && centerDistance < 30 && boxDistance < 120;
      }, { timeout: 5000 })
      .toBe(true);
  }

  await guesserPage.locator("#guessInput").fill(wrongGuess);
  await guesserPage.getByRole("button", { name: "发送" }).click();
  await expect(drawerPage.getByText(`${guesserName}：${wrongGuess}`)).toBeVisible({ timeout: 5000 });
  await expect(drawerPage.getByText(`系统：${guesserName} 猜错了`).first()).toBeVisible({ timeout: 5000 });
  await expect(guesserPage.getByText(`系统：${guesserName} 猜错了`).first()).toBeVisible({ timeout: 5000 });

  await guesserPage.locator("#guessInput").fill(word);
  await guesserPage.getByRole("button", { name: "发送" }).click();
  await expect(host.getByText("回合成功！")).toBeVisible({ timeout: 5000 });
  await expect(guest.getByText("回合成功！")).toBeVisible({ timeout: 5000 });
  await expect(drawerPage.getByText(`正确答案：${word}`)).toBeVisible();
  await expect(guesserPage.getByText(`正确答案：${word}`)).toBeVisible();

  return { word, drawerName, guesserName };
}

test("host and guest can complete three back-and-forth rounds", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const host = await context.newPage();
  const guest = await context.newPage();

  await host.goto(BASE_URL);
  await host.getByRole("button", { name: "创建房间" }).click();
  await host.locator("#createName").click();
  await host.locator("#createName").fill("房主");
  await expect(host.locator("#createName")).toHaveValue("房主");
  await host.locator("#createRounds").fill("3");
  await host.locator("#createRoomForm button[type='submit']").click();
  await expect(host.getByText("房间等待")).toBeVisible();
  const room = (await host.locator(".room-code-card strong").textContent()).trim();
  expect(room).toMatch(/^\d{4}$/);

  await guest.goto(`${BASE_URL}/#join-room`);
  await guest.locator("#joinRoomCode").fill(room);
  await guest.getByRole("button", { name: "下一步" }).click();
  await guest.locator("#joinName").fill("访客");
  await guest.getByRole("button", { name: "确认进入" }).click();
  await expect(guest.getByText("房间等待")).toBeVisible();
  await expect(host.locator(".shell-list li", { hasText: "访客" }).first()).toBeVisible({
    timeout: 5000,
  });

  await host.getByRole("button", { name: "开始游戏" }).click();

  await completeRound({
    host,
    guest,
    drawer: "host",
    guesser: "guest",
    selector: guest,
    wrongGuess: "香蕉",
    roundNumber: 1,
    tool: "crayon",
  });

  await host.getByRole("button", { name: "进入下一轮" }).click();
  await completeRound({
    host,
    guest,
    drawer: "guest",
    guesser: "host",
    selector: host,
    wrongGuess: "月亮",
    roundNumber: 2,
    fillBox: true,
  });

  await host.getByRole("button", { name: "进入下一轮" }).click();
  await completeRound({
    host,
    guest,
    drawer: "host",
    guesser: "guest",
    selector: guest,
    wrongGuess: "西瓜",
    roundNumber: 3,
  });

  await host.getByRole("button", { name: "进入下一轮" }).click();
  await completeRound({
    host,
    guest,
    drawer: "guest",
    guesser: "host",
    selector: host,
    wrongGuess: "桌子",
    roundNumber: 4,
  });

  await host.getByRole("button", { name: "进入下一轮" }).click();
  await completeRound({
    host,
    guest,
    drawer: "host",
    guesser: "guest",
    selector: guest,
    wrongGuess: "飞机",
    roundNumber: 5,
  });

  await host.getByRole("button", { name: "进入下一轮" }).click();
  await completeRound({
    host,
    guest,
    drawer: "guest",
    guesser: "host",
    selector: host,
    wrongGuess: "小狗",
    roundNumber: 6,
  });

  await host.getByRole("button", { name: "查看最终成绩" }).click();
  await expect(host.getByText("游戏结束")).toBeVisible({ timeout: 5000 });
  await expect(guest.getByText("游戏结束")).toBeVisible({ timeout: 5000 });
  await expect(host.locator(".final-records li")).toHaveCount(6);
  await expect(guest.locator(".final-records li")).toHaveCount(6);
});

test("browser back from game keeps the current room and ongoing sync", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const host = await context.newPage();
  const guest = await context.newPage();

  await host.goto(BASE_URL);
  await host.getByRole("button", { name: "创建房间" }).click();
  await host.locator("#createName").click();
  await host.locator("#createName").fill("房主");
  await expect(host.locator("#createName")).toHaveValue("房主");
  await host.locator("#createRounds").fill("3");
  await host.locator("#createRoomForm button[type='submit']").click();
  await expect(host.getByText("房间等待")).toBeVisible();
  const room = (await host.locator(".room-code-card strong").textContent()).trim();

  await guest.goto(`${BASE_URL}/#join-room`);
  await guest.locator("#joinRoomCode").fill(room);
  await guest.getByRole("button", { name: "下一步" }).click();
  await guest.locator("#joinName").fill("访客");
  await guest.getByRole("button", { name: "确认进入" }).click();
  await expect(guest.getByText("房间等待")).toBeVisible();

  await host.getByRole("button", { name: "开始游戏" }).click();
  await expect(host.getByText("等待选词...")).toBeVisible({ timeout: 5000 });
  await guest.locator("[data-word]").first().click();
  await expect(host.locator("#game")).toBeVisible({ timeout: 5000 });
  await expect(guest.locator("#game")).toBeVisible({ timeout: 5000 });

  const roomBeforeBack = (await host.locator("#copyRoom").textContent()).trim();
  const roundTitleBeforeBack = (await host.locator("#roundTitle").textContent()).trim();
  await expect(host.locator("#roleLabel")).toHaveText("画手");
  await expect(host.locator("#score")).toContainText("第 1/6 次");
  const lineCountBeforeBack = await nonWhitePixels(host);

  await drawLineAt(host, { fromX: 0.25, fromY: 0.28, toX: 0.58, toY: 0.42 });
  await expect.poll(() => nonWhitePixels(guest), { timeout: 5000 }).toBeGreaterThan(20);

  await host.goBack();
  await expect(host.locator("#game")).toBeVisible({ timeout: 5000 });
  await expect(host.locator("#copyRoom")).toHaveText(roomBeforeBack);
  await expect(host.locator("#roundTitle")).toHaveText(roundTitleBeforeBack);
  await expect(host.locator("#roleLabel")).toHaveText("画手");
  await expect(host.locator("#score")).toContainText("第 1/6 次");
  await expect.poll(() => nonWhitePixels(host), { timeout: 5000 }).toBeGreaterThan(lineCountBeforeBack - 20);

  await drawLineAt(host, { fromX: 0.28, fromY: 0.68, toX: 0.68, toY: 0.56 });
  await expect.poll(() => nonWhitePixels(guest), { timeout: 5000 }).toBeGreaterThan(40);
  const diff = await canvasDiff(host, guest);
  expect(diff.changedPixels).toBeLessThan(20);
  expect(diff.totalDelta).toBeLessThan(2000);
});

test("separate devices join the same room and receive host start", async ({ browser }) => {
  const hostContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const guestContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  await host.goto(BASE_URL);
  await host.getByRole("button", { name: "创建房间" }).click();
  await host.locator("#createName").click();
  await host.locator("#createName").fill("房主");
  await expect(host.locator("#createName")).toHaveValue("房主");
  await host.locator("#createRounds").fill("1");
  await host.locator("#createRoomForm button[type='submit']").click();
  await expect(host.getByText("房间等待")).toBeVisible();
  const room = (await host.locator(".room-code-card strong").textContent()).trim();

  await guest.goto(`${BASE_URL}/#join-room`);
  await guest.locator("#joinRoomCode").fill(room);
  await guest.getByRole("button", { name: "下一步" }).click();
  await guest.locator("#joinName").fill("访客");
  await guest.getByRole("button", { name: "确认进入" }).click();
  await expect(guest.getByText("房间等待")).toBeVisible();
  await expect(guest.locator(".shell-list li", { hasText: "房主" }).first()).toBeVisible({
    timeout: 7000,
  });
  await expect(host.locator(".shell-list li", { hasText: "访客" }).first()).toBeVisible({
    timeout: 7000,
  });

  await host.getByRole("button", { name: "开始游戏" }).click();
  await expect(host.getByText("等待选词...")).toBeVisible({ timeout: 5000 });
  await expect(guest.getByText("盲选词语")).toBeVisible({ timeout: 7000 });
  await guest.locator("[data-word]").first().click();
  await expect(host.locator("#game")).toBeVisible({ timeout: 7000 });
  await expect(host.locator("#roleLabel")).toHaveText("画手");
  await expect(guest.locator("#roleLabel")).toHaveText("猜词");

  const word = (await host.locator("#roundTitle").textContent()).trim();
  await guest.locator("#guessInput").fill(word);
  await guest.getByRole("button", { name: "发送" }).click();
  await expect(host.getByText("回合成功！")).toBeVisible({ timeout: 7000 });
  await expect(guest.getByText("回合成功！")).toBeVisible({ timeout: 7000 });
  await host.getByRole("button", { name: "进入下一轮" }).click();
  await expect(host.getByText("盲选词语")).toBeVisible({ timeout: 7000 });
  await expect(guest.getByText("等待选词...")).toBeVisible({ timeout: 9000 });

  await guestContext.close();
  await hostContext.close();
});

test("stale select sync cannot pull third round back from game", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const host = await context.newPage();
  const guest = await context.newPage();

  await host.goto(BASE_URL);
  await host.getByRole("button", { name: "创建房间" }).click();
  await host.locator("#createName").click();
  await host.locator("#createName").fill("房主");
  await expect(host.locator("#createName")).toHaveValue("房主");
  await host.locator("#createRounds").fill("3");
  await host.locator("#createRoomForm button[type='submit']").click();
  await expect(host.getByText("房间等待")).toBeVisible();
  const room = (await host.locator(".room-code-card strong").textContent()).trim();

  await guest.goto(`${BASE_URL}/#join-room`);
  await guest.locator("#joinRoomCode").fill(room);
  await guest.getByRole("button", { name: "下一步" }).click();
  await guest.locator("#joinName").fill("访客");
  await guest.getByRole("button", { name: "确认进入" }).click();
  await expect(guest.getByText("房间等待")).toBeVisible();
  await expect(host.locator(".shell-list li", { hasText: "访客" }).first()).toBeVisible({
    timeout: 5000,
  });

  await host.getByRole("button", { name: "开始游戏" }).click();
  await completeRound({
    host,
    guest,
    drawer: "host",
    guesser: "guest",
    selector: guest,
    wrongGuess: "香蕉",
    roundNumber: 1,
  });

  await host.getByRole("button", { name: "进入下一轮" }).click();
  await completeRound({
    host,
    guest,
    drawer: "guest",
    guesser: "host",
    selector: host,
    wrongGuess: "月亮",
    roundNumber: 2,
  });

  await host.getByRole("button", { name: "进入下一轮" }).click();
  await expect(host.getByText("等待选词...")).toBeVisible({ timeout: 5000 });
  await expect(guest.getByText("盲选词语")).toBeVisible({ timeout: 5000 });
  await guest.locator("[data-word]").first().click();
  await expect(host.locator("#game")).toBeVisible({ timeout: 5000 });
  await expect(guest.locator("#game")).toBeVisible({ timeout: 5000 });

  await host.evaluate((activeRoom) => {
    const key = `draw-and-guess-demo:${activeRoom}`;
    const staleState = JSON.parse(localStorage.getItem(key));
    staleState.phase = "select-word";
    staleState.word = "";
    staleState.roundEndsAt = 0;
    window.handleSyncPayload({
      type: "select",
      state: staleState,
      eventId: `stale-${Date.now()}`,
      senderId: "stale-peer",
      sentAt: Date.now(),
    });
  }, room);

  await expect(host.locator("#game")).toBeVisible({ timeout: 3000 });
  await expect(host.locator("#score")).toContainText("第 3/6 次");
  await expect(host.getByText("盲选词语")).toBeHidden();

  await context.close();
});

test("joining a room ignores stale cached room state", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const guest = await context.newPage();
  const staleRoom = "2468";

  await guest.goto(BASE_URL);
  await guest.evaluate((room) => {
    localStorage.setItem(
      `draw-and-guess-demo:${room}`,
      JSON.stringify({
        updatedAt: Date.now() - 60_000,
        phase: "room",
        category: "默认词库",
        totalRounds: 3,
        roundNumber: 0,
        drawerId: "old-host",
        word: "",
        lastWord: "",
        wordOptions: [],
        result: null,
        history: [],
        roundEndsAt: 0,
        roundId: "old-round",
        players: {
          "old-host": { id: "old-host", name: "上一次房主", score: 0, joinedAt: 1 },
        },
        lines: [],
        strokes: [],
        redoStrokes: [],
        messages: [],
      }),
    );
  }, staleRoom);

  await guest.goto(`${BASE_URL}/#join-room`);
  await guest.locator("#joinRoomCode").fill(staleRoom);
  await guest.getByRole("button", { name: "下一步" }).click();
  await guest.locator("#joinName").fill("访客");
  await guest.getByRole("button", { name: "确认进入" }).click();
  await expect(guest.getByText("房间等待")).toBeVisible();
  await expect(guest.getByText("上一次房主")).toHaveCount(0);
  await expect(guest.locator(".shell-list li", { hasText: "访客" }).first()).toBeVisible();

  await context.close();
});

test.skip("drawer refreshes mid-round and keeps syncing", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const host = await context.newPage();
  const guest = await context.newPage();

  await host.goto(BASE_URL);
  await host.getByRole("button", { name: "创建房间" }).click();
  await host.locator("#createName").click();
  await host.locator("#createName").fill("房主");
  await expect(host.locator("#createName")).toHaveValue("房主");
  await host.locator("#createRounds").fill("1");
  await host.locator("#createRoomForm button[type='submit']").click();
  await expect(host.getByText("房间等待")).toBeVisible();
  const room = (await host.locator(".room-code-card strong").textContent()).trim();

  await guest.goto(`${BASE_URL}/#join-room`);
  await guest.locator("#joinRoomCode").fill(room);
  await guest.getByRole("button", { name: "下一步" }).click();
  await guest.locator("#joinName").fill("访客");
  await guest.getByRole("button", { name: "确认进入" }).click();
  await expect(guest.getByText("房间等待")).toBeVisible();

  await host.getByRole("button", { name: "开始游戏" }).click();
  await expect(guest.getByText("盲选词语")).toBeVisible({ timeout: 5000 });
  await guest.locator("[data-word]").first().click();
  await expect(host.locator("#game")).toBeVisible({ timeout: 5000 });
  await expect(guest.locator("#game")).toBeVisible({ timeout: 5000 });

  const roomBeforeReload = (await host.locator("#copyRoom").textContent()).trim();
  const wordBeforeReload = (await host.locator("#roundTitle").textContent()).trim();
  await drawLineAt(host, { fromX: 0.24, fromY: 0.3, toX: 0.54, toY: 0.45 });
  await expect.poll(() => nonWhitePixels(guest), { timeout: 5000 }).toBeGreaterThan(20);

  await host.reload();
  await expect(host.locator("#game")).toBeVisible({ timeout: 5000 });
  await expect(host.locator("#copyRoom")).toHaveText(roomBeforeReload);
  await expect(host.locator("#roundTitle")).toHaveText(wordBeforeReload);
  await expect(host.locator("#roleLabel")).toHaveText("画手");
  await expect(host.locator("#score")).toContainText("第 1/2 次");
  await expect.poll(() => nonWhitePixels(host), { timeout: 5000 }).toBeGreaterThan(20);
});

test("unanswered round times out for both players", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const host = await context.newPage();
  const guest = await context.newPage();

  await host.goto(`${BASE_URL}/?roundSeconds=2`);
  await host.getByRole("button", { name: "创建房间" }).click();
  await host.locator("#createName").click();
  await host.locator("#createName").fill("房主");
  await expect(host.locator("#createName")).toHaveValue("房主");
  await host.locator("#createRounds").fill("1");
  await host.locator("#createRoomForm button[type='submit']").click();
  await expect(host.getByText("房间等待")).toBeVisible();
  const room = (await host.locator(".room-code-card strong").textContent()).trim();

  await guest.goto(`${BASE_URL}/?roundSeconds=2#/join-room`);
  await guest.locator("#joinRoomCode").fill(room);
  await guest.getByRole("button", { name: "下一步" }).click();
  await guest.locator("#joinName").fill("访客");
  await guest.getByRole("button", { name: "确认进入" }).click();
  await expect(guest.getByText("房间等待")).toBeVisible();

  await host.getByRole("button", { name: "开始游戏" }).click();
  await expect(host.getByText("等待选词...")).toBeVisible();
  await guest.locator("[data-word]").first().click();

  await expect(host.locator("#game")).toBeVisible({ timeout: 5000 });
  await expect(guest.locator("#game")).toBeVisible({ timeout: 5000 });
  await drawLine(host);
  await expect.poll(() => nonWhitePixels(guest), { timeout: 5000 }).toBeGreaterThan(20);

  await expect(host.getByText("回合失败")).toBeVisible({ timeout: 6000 });
  await expect(guest.getByText("回合失败")).toBeVisible({ timeout: 6000 });
  await expect(host.getByText("猜测耗时：2 秒")).toBeVisible();
  await expect(guest.getByText("猜测耗时：2 秒")).toBeVisible();
});
