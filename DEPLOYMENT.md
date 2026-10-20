# A3 迁移与部署指南

> 如果要把项目交给另一个人部署，优先发给他这份零基础版：**[HANDOFF.md](HANDOFF.md)**（傻瓜式部署说明）。  
> 本文适合想了解完整迁移、手机运行和部署原理的人。

这份指南回答两件事：

1. 换电脑、换手机继续玩，需要拷贝什么、怎么启动；
2. 想放到公网长期玩，有没有省事的一键部署方式。

## Ubuntu 和 Debian 是什么

它们都是 **Linux 操作系统发行版**，常用于云服务器。云服务器默认通常没有图形桌面，只有一个通过 SSH 登录的命令行。

- **Ubuntu**：更常见、教程多，推荐选 **Ubuntu 22.04 LTS** 或 **Ubuntu 24.04 LTS**。
- **Debian**：更精简、稳定，推荐 **Debian 12**。
- 两者都用 `apt` 安装软件，本文的一键脚本对两者都适用。
- 对本游戏来说，它们没有功能区别；选哪个都能跑。
- 1 核 CPU、1GB 内存的小服务器就足够朋友局使用。

登录后看到类似 `ubuntu@VM-...:~$` 或 `root@...:~#` 的提示符，说明已经进入 Linux 命令行。

## 一、先分清「换玩家设备」和「换服务器」

### 情况 A：服务器还在这台电脑，只用手机加入

**不需要拷贝任何文件，也不需要安装 App。**

- 手机和电脑连同一个 Wi-Fi：手机浏览器打开 `http://电脑局域网IP:3213`，例如 `http://10.18.108.144:3213`。
- 手机用移动数据：打开当前公网隧道地址；首次出现 Serveo 提示页时点击 **Continue to Site**。
- 原来的电脑要一直开机，并且 Node 服务和 SSH 隧道窗口都不能关。

这是最简单的方式。手机在这里只是玩家客户端。

### 情况 B：把服务器搬到另一台电脑

只拷贝下面这些**必需文件**：

```text
server.js
package.json
lib/
public/
```

建议一起拷贝：

```text
README.md
DEPLOYMENT.md
start-a3.cmd
Dockerfile
docker-compose.yml
docker-compose.https.yml
Caddyfile
render.yaml
deploy-vps.sh
```

不需要拷贝：

- `node_modules`：本项目没有任何第三方运行依赖，不需要 `npm install`
- `.edge-profile`、`.edge-shot` 等浏览器测试缓存
- `.tools`、日志、测试截图
- 当前 SSH 隧道进程：它绑在旧电脑上，不能迁移；在新电脑重新开隧道会得到**新的公网地址**
- 房间/对局数据：只保存在服务端内存里，换服务器会清空，需要大家重新建房

也可以直接使用整理好的 [`a3-transfer.zip`](a3-transfer.zip)，解压后就是可运行目录。

### 新电脑启动步骤

1. 安装 **Node.js 18 或更高版本**（推荐 LTS）：<https://nodejs.org/>
2. 把上面的文件放进同一个文件夹，保持 `server.js`、`lib/`、`public/` 的相对位置不变。
3. 在该文件夹打开终端，执行：

```bash
node server.js
```

或者：

```bash
npm start
```

Windows 用户也可以直接双击 `start-a3.cmd`，脚本会检查 Node 并启动服务。

4. 浏览器访问 `http://127.0.0.1:3213`。
5. Windows 首次运行如果弹出防火墙提示，请勾选「专用网络」并允许访问。
6. 终端日志会打印局域网地址，例如：

```text
A3 server listening on http://127.0.0.1:3213
LAN: http://192.168.1.23:3213
```

### 新电脑继续用 SSH 临时公网隧道

Windows 10/11、macOS、Linux 通常自带 OpenSSH 客户端。Windows 如果没有，可在「设置 → 应用 → 可选功能 → 添加功能」中安装 **OpenSSH 客户端**。

在运行游戏服务器的电脑上新开一个终端：

```powershell
ssh -T -o StrictHostKeyChecking=no -R 80:127.0.0.1:3213 serveo.net
```

终端会打印一个新的公网地址：

```text
Forwarding HTTP traffic from https://xxxxx.serveousercontent.com
```

这个地址就是给朋友用的新地址。第一次用浏览器打开可能出现 **Serveo Browser Warning**，点击 **Continue to Site** 即可。

注意事项：

- 这个 SSH 窗口必须保持打开；
- Serveo 免费隧道会在一段时间后过期，并生成新地址；
- 旧的公网地址不能迁移到新电脑；
- 不需要拷贝私钥或浏览器缓存。当前的临时隧道不需要 Serveo 账号。

如果不想每次过期都换地址，可以改用 localtunnel 固定子域名：

```bash
npx localtunnel --port 3213 --subdomain a3-card-happy-9x7
```

终端会输出 `https://a3-card-happy-9x7.loca.lt`。第一次用浏览器打开会要求输入 tunnel password，页面上会显示主机公网 IP，复制填入即可，同一公网 IP 一般 7 天内只需填一次。这个地址在进程存活期间保持不变；进程退出后重新执行同一条命令即可复用同一个子域名。

### 情况 C：把 Android 手机当服务器

技术上可以，但不推荐长期使用。Android 可以用 Termux：

```bash
pkg update
pkg install nodejs openssh
termux-wake-lock
cd ~/a3
node server.js
```

再开一个 Termux 会话：

```bash
ssh -T -o StrictHostKeyChecking=no -R 80:127.0.0.1:3213 serveo.net
```

然后把公网地址发给朋友。手机必须保持充电、亮屏/后台不被杀，并且网络稳定。

iPhone 上运行 Node 服务比较麻烦，建议让电脑做服务器，或者使用下面的公网部署。

## 把项目交给另一台电脑 / 另一个人部署

### 需要传送的内容

最省事：直接发送项目根目录的 [`a3-transfer.zip`](a3-transfer.zip)，里面已经包含：

```text
server.js
package.json
lib/
public/
README.md
DEPLOYMENT.md
start-a3.cmd
Dockerfile
docker-compose.yml
docker-compose.https.yml
Caddyfile
render.yaml
deploy-vps.sh
```

对方不需要：

- 当前电脑的 `.tools`、`.ssh`、浏览器缓存
- 当前电脑正在运行的 Serveo / localtunnel 地址
- 正在进行的房间和对局数据
- `node_modules`

如果对方要部署到云服务器，还需要单独提供：

- 云服务器公网 IP
- SSH 端口（通常 22）
- SSH 用户名（Ubuntu 常见 `ubuntu`，Debian/部分厂商常见 `root`）
- 登录方式：密码，或 `.pem` / 私钥文件
- 是否有 `sudo` 权限
- 如果使用域名：域名，以及把域名 A 记录指向服务器的权限

**安全提醒**：私钥、服务器密码不要直接发在群聊里。使用加密聊天、临时密码或让对方自己创建服务器。部署完成后建议更换临时密码。

### 对方操作步骤（云服务器）

1. 服务器系统选择 **Ubuntu 22.04/24.04 LTS** 或 **Debian 12**，1 核 1G 内存即可。
2. 云厂商安全组放行：
   - SSH：`22`
   - 直连游戏：`3213`
   - 如果使用域名 HTTPS：`80`、`443`
3. 本地上传压缩包：

Windows PowerShell：

```powershell
scp C:\path\to\a3-transfer.zip ubuntu@服务器公网IP:/home/ubuntu/
```

macOS / Linux：

```bash
scp -i ~/.ssh/你的密钥 a3-transfer.zip ubuntu@服务器公网IP:/home/ubuntu/
```

也可以使用 WinSCP、FileZilla 等图形工具上传。

> **WinSCP 只能上传文件，不能执行 `deploy-vps.sh`。** 上传完成后仍需通过 SSH 或云厂商网页终端执行命令。零基础用户请直接看 [HANDOFF.md](HANDOFF.md) 第 5 节的「打开终端」三选一。

4. SSH 登录服务器：

```bash
ssh ubuntu@服务器公网IP
# 或者
ssh -i ~/.ssh/你的密钥 ubuntu@服务器公网IP
```

5. 解压并一键部署：

```bash
sudo apt update
sudo apt install -y unzip
mkdir -p ~/a3
cd ~/a3
unzip ~/a3-transfer.zip
sudo bash deploy-vps.sh
```

脚本会自动安装 Docker、构建并启动 A3，然后输出：

```text
http://服务器公网IP:3213
```

6. 浏览器访问这个地址，发送给朋友即可。

### 使用域名 HTTPS

在域名服务商添加 A 记录，例如：

```text
a3.example.com  →  服务器公网IP
```

等待解析生效后，在服务器执行：

```bash
cd ~/a3
sudo bash deploy-vps.sh a3.example.com
```

脚本会自动启动 Caddy 并申请 HTTPS 证书。成功后访问：

```text
https://a3.example.com
```

### 更新版本

把新的 `a3-transfer.zip` 上传并覆盖解压：

```bash
cd ~/a3
unzip -o ~/a3-transfer.zip
sudo bash deploy-vps.sh
# 如果使用域名 HTTPS：
sudo bash deploy-vps.sh a3.example.com
```

重启/更新会清空内存中的房间，请提前结束当前对局。

### 如果对方不想管理云服务器

把项目放到 GitHub，按下面的 Render 方案部署。对方只需要 GitHub 和 Render 账号，不需要 Linux 运维经验。

## 二、傻瓜式公网部署

### 方案 1：Render 免费 Web Service（最省事，无需服务器）

项目已带 [`render.yaml`](render.yaml)，适合个人朋友局。

1. 把项目上传到 GitHub（私有仓库也可以）。
2. 打开 <https://render.com/>，注册并连接 GitHub。
3. 点击 **New → Blueprint**，选择这个仓库。
4. Render 会读取 `render.yaml`，点击确认创建。
5. 等待构建完成，得到 `https://你的服务名.onrender.com` 地址。

无需另外配置 WebSocket；Render 会自动转发。服务监听 Render 注入的 `PORT`，并绑定 `0.0.0.0`。

注意：

- 免费实例一段时间无访问会休眠，首次唤醒需要等待；
- 休眠或重新部署会清空内存中的房间和对局；
- 免费额度、休眠策略可能会变，以 Render 当前页面为准。

### 方案 2：任意云服务器一键 Docker 部署

项目已带 Docker 配置。准备一台 Ubuntu/Debian 云服务器，开放端口后执行：

```bash
sudo bash deploy-vps.sh
```

脚本会自动安装 Docker、构建镜像、启动服务，并打印：

```text
http://服务器公网IP:3213
```

如果云厂商有安全组，请在控制台放行 TCP `3213`。

常用运维命令：

```bash
docker compose logs -f     # 查看日志
docker compose restart     # 重启
docker compose down        # 停止
docker compose up -d --build  # 更新代码后重建
```

### 方案 3：有域名时的一键 HTTPS 部署

准备一个域名，把 A 记录指向云服务器公网 IP，然后执行：

```bash
sudo bash deploy-vps.sh a3.example.com
```

脚本会自动启动 Caddy，为域名申请 HTTPS 证书，并反向代理到游戏服务。成功后直接访问：

```text
https://a3.example.com
```

WebSocket 会自动升级为 `wss://`，不需要手动改前端配置。

注意：DNS 解析生效可能需要几分钟；服务器安全组需要放行 80 和 443。

## 三、不推荐的平台

- **Vercel / Netlify / Cloudflare Pages**：这类 Serverless 平台不适合长连接 WebSocket 和内存房间状态，本游戏不应直接部署到这些平台。
- **纯静态托管**：`public/` 只是前端，必须同时运行 `server.js`，否则无法建房、发牌和联机。

## 四、最快的选择建议

| 场景 | 推荐方案 |
| --- | --- |
| 手机临时加入，电脑做主机 | 不拷贝文件，手机打开局域网地址或当前公网地址 |
| 换一台电脑继续临时玩 | 拷贝核心文件 + 安装 Node + 重新开 Serveo SSH 隧道 |
| 朋友固定长期玩，不想维护服务器 | Render 免费 Web Service |
| 有云服务器，想完全自己控制 | `sudo bash deploy-vps.sh` |
| 有域名，想要 HTTPS 固定地址 | `sudo bash deploy-vps.sh 你的域名` |

所有房间状态都在内存中。**迁移服务器或重启服务前，请先让当前对局结束**，否则正在进行的牌局会丢失。
