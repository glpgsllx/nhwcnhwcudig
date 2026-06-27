const { test, expect } = require("@playwright/test");
const { spawn } = require("node:child_process");

const PORT = 5180;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let server;

test.beforeAll(async () => {
  server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], {
    stdio: "ignore",
  });

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
});

test.afterAll(() => {
  server?.kill();
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

async function drawLine(page) {
  const before = await nonWhitePixels(page);
  const box = await page.locator("#board").boundingBox();
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.55, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => nonWhitePixels(page), { timeout: 5000 }).toBeGreaterThan(before + 20);
}

async function completeRound({ host, guest, drawer, guesser, selector, wrongGuess, roundNumber }) {
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

  await guesserPage.locator("#guessInput").fill(wrongGuess);
  await guesserPage.getByRole("button", { name: "发送" }).click();
  await expect(drawerPage.getByText(`${guesserName}：${wrongGuess}`)).toBeVisible({ timeout: 5000 });

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
  await expect(host.getByText("猜测耗时：60 秒")).toBeVisible();
  await expect(guest.getByText("猜测耗时：60 秒")).toBeVisible();
});
