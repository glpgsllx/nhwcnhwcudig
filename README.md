# 你画我猜 Demo

这是一个静态网页 demo，用来先验证玩法和界面。

它不用 Firebase。远程联机使用 PeerJS + WebRTC 点对点数据连接；如果 PeerJS 网络库加载失败，会退回到 `localStorage` 本机双窗口试玩。

词库在 `word-bank.js`，当前约 1000 个词。主要来源：

- Google Quick, Draw! Dataset 的官方绘画类别，CC BY 4.0。
- THUOCL 清华大学开放中文词库里的饮食、成语等词表。
- 少量人工补充的情侣、日常、地点、动作、职业等适合两个人玩的词。

构建脚本在 `scripts/build-word-bank.mjs`。如果之后要重新生成，先把源词表下载到 `/tmp`，再运行：

```bash
node scripts/build-word-bank.mjs
```

## 本地运行

直接打开 `index.html`，或者在项目目录启动一个静态服务器：

```bash
python3 -m http.server 5173
```

然后打开：

```text
http://localhost:5173
```

## 怎么试玩

1. 打开两个浏览器窗口。
2. 第一个窗口输入昵称，房间码留空，进入房间。
3. 第二个窗口输入另一个昵称，填同一个房间码。
4. 点“开始/换题”，画手会看到题目，另一个人输入答案。

异地试玩时，把这个网页部署到 GitHub Pages / Netlify / Vercel 后：

1. 一个人房间码留空创建房间。
2. 点顶部房间码复制邀请链接。
3. 另一个人打开链接，输入昵称进入。

注意：WebRTC 在少数严格网络环境下可能连不上。真要做成长期稳定版本，可以再加一个自己的免费 WebSocket/数据库中转。

## 部署到 GitHub Pages

这个项目是纯静态网页，可以直接用 GitHub Pages。

1. 在 GitHub 新建一个 public repository，例如 `drawandguess`。
2. 把本目录里的文件上传到仓库根目录：
   - `index.html`
   - `styles.css`
   - `app.js`
   - `.nojekyll`
   - `README.md`
3. 进入仓库 `Settings` -> `Pages`。
4. `Build and deployment` 选择：
   - Source: `Deploy from a branch`
   - Branch: `main`
   - Folder: `/root`
5. 保存后等一两分钟，GitHub 会给出一个网址，类似：

```text
https://你的用户名.github.io/drawandguess/
```

打开这个网址创建房间，点顶部房间码复制邀请链接，再发给对方。
