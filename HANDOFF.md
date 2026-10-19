# A3 云服务器部署说明（给部署人）

> 这份说明写给帮你部署的人。
>
> 目标：在一台云服务器上把 A3 扑克游戏跑起来，得到一个朋友可以访问的网址。
>
> 不需要懂 Node.js，不需要改代码。按顺序复制命令即可。

---

## 0. 你会收到什么

### 必须收到的文件

一个压缩包：

```text
a3-transfer.zip
```

它已经包含完整游戏、Docker 配置、一键部署脚本和说明文档。

### 需要向项目所有者确认的信息

- [ ] 云服务器公网 IP
- [ ] SSH 端口（通常是 `22`）
- [ ] SSH 用户名（Ubuntu 常见 `ubuntu`，部分厂商是 `root`）
- [ ] 登录方式：密码，或 `.pem` / 私钥文件
- [ ] 是否有 `sudo`（管理员）权限
- [ ] 如果要用域名：域名是什么、DNS 由谁修改
- [ ] 是否已经购买服务器；没有的话先按第 1 步购买

### 不要接收或传播

- 项目所有者当前电脑的 `.ssh`、浏览器缓存、临时隧道地址
- 正在进行的房间/对局数据（游戏房间只存在内存里）
- 任何与本次部署无关的账号密码

服务器密码和私钥请通过加密聊天、临时密码等方式传输，不要发在公开群里。

---

## 1. 创建云服务器

在阿里云、腾讯云、华为云、AWS、Vultr、搬瓦工等平台购买一台服务器即可。

推荐配置：

| 项目 | 推荐值 |
| --- | --- |
| 系统 | Ubuntu 24.04 LTS 或 Debian 12 |
| CPU/内存 | 1 核 1GB 起 |
| 硬盘 | 20GB 起 |
| 网络 | 有公网 IPv4 |
| 登录方式 | SSH 密钥或密码 |

### Ubuntu 和 Debian 是什么

它们都是 **Linux 操作系统**，云服务器常用系统。可以理解为服务器的“Windows”。

- Ubuntu：教程最多，推荐新手选 **Ubuntu 24.04 LTS**
- Debian：更精简稳定，选 **Debian 12** 也可以
- 两者对本游戏没有区别，本文命令都通用
- 1 核 1G 的小服务器足够朋友局

购买时如果让你选“应用镜像/系统镜像”，选 **纯净系统**，不要选带宝塔、WordPress 等预装软件的镜像。

---

## 2. 放行端口

这一步最容易漏。云厂商通常有两层防火墙：

1. 云平台控制台的“安全组 / 防火墙”
2. 服务器系统内部的 UFW

先在云平台控制台添加**入站规则**：

| 端口 | 协议 | 来源 | 用途 |
| --- | --- | --- | --- |
| 22 | TCP | 你的公网 IP（或 0.0.0.0/0） | SSH 登录 |
| 3213 | TCP | 0.0.0.0/0 | 直接访问游戏 |
| 80 | TCP | 0.0.0.0/0 | 域名 HTTPS 证书申请 |
| 443 | TCP | 0.0.0.0/0 | 域名 HTTPS 访问 |

如果暂时不用域名，只放行 `22` 和 `3213` 即可。

> 云厂商控制台的安全组必须放行，脚本无法替你操作云平台控制台。

---

## 3. 登录服务器

### 方法 A：云厂商网页终端（最简单）

大多数云厂商控制台都有「远程连接 / 登录 / Web Terminal」按钮。

1. 打开服务器详情页
2. 点击「远程连接」
3. 输入用户名和密码
4. 看到类似下面的提示符，就成功了：

```text
ubuntu@VM-0-1-ubuntu:~$
```

或：

```text
root@server:~#
```

### 方法 B：Windows 使用 PowerShell

打开 PowerShell，输入（把尖括号内容替换成实际值，不要保留 `< >`）：

```powershell
ssh ubuntu@服务器公网IP
```

如果使用密钥文件：

```powershell
ssh -i C:\path\to\你的密钥.pem ubuntu@服务器公网IP
```

### 方法 C：Mac / Linux

```bash
ssh ubuntu@服务器公网IP
```

使用密钥：

```bash
ssh -i ~/.ssh/你的密钥 ubuntu@服务器公网IP
```

> 不同云厂商用户名可能不同：
>
> - Ubuntu 镜像常用 `ubuntu`
> - Debian / 部分国内厂商常用 `root`
> - AWS 用 `ubuntu`
> - 以购买服务器时控制台显示的用户名为准

---

## 4. 上传 a3-transfer.zip

### 方法 A：WinSCP（推荐给不熟悉命令的人）

1. 下载并打开 WinSCP
2. 新建站点：
   - 文件协议：`SFTP`
   - 主机名：服务器公网 IP
   - 端口号：`22`
   - 用户名：`ubuntu` 或 `root`
   - 密码：服务器密码
   - 如果使用密钥：在「高级 → SSH → 验证」中选择 `.pem` 文件
3. 点击登录
4. 在右侧进入 `/home/ubuntu/`（root 用户是 `/root/`）
5. 把 `a3-transfer.zip` 从左侧拖到右侧
6. 等待上传完成

### 方法 B：Windows PowerShell 使用 scp

```powershell
scp C:\path\to\a3-transfer.zip ubuntu@服务器公网IP:/home/ubuntu/
```

使用密钥：

```powershell
scp -i C:\path\to\你的密钥.pem C:\path\to\a3-transfer.zip ubuntu@服务器公网IP:/home/ubuntu/
```

### 方法 C：Mac / Linux

```bash
scp a3-transfer.zip ubuntu@服务器公网IP:/home/ubuntu/
```

> 如果上传后提示找不到文件，先执行 `pwd` 看一下当前目录，再用 `ls` 确认压缩包位置。

---

## 5. 解压并一键部署

重新登录服务器，依次执行：

```bash
sudo apt update
sudo apt install -y unzip

mkdir -p ~/a3
cd ~/a3
unzip -o ~/a3-transfer.zip
sudo bash deploy-vps.sh
```

如果你的压缩包不在主目录，把 `~/a3-transfer.zip` 换成实际路径。

脚本会自动完成：

1. 安装 Docker
2. 构建游戏镜像
3. 启动 A3 服务
4. 输出访问地址

看到类似下面的内容就表示部署成功：

```text
部署完成：http://服务器公网IP:3213
```

第一次安装 Docker 可能需要 1～3 分钟，请耐心等待。

---

## 6. 验证部署

在服务器上执行：

```bash
curl http://127.0.0.1:3213/healthz
```

正常会返回类似：

```json
{"ok":true,"rooms":0,"uptime":12.3}
```

再用你自己的电脑浏览器打开：

```text
http://服务器公网IP:3213
```

能看到 A3 首页，就说明成功了。

如果打不开，按顺序检查：

1. 云平台安全组是否放行 `3213`
2. 服务器 UFW 是否放行（脚本会尝试自动放行）
3. Docker 容器是否在运行：

```bash
cd ~/a3
docker compose ps
```

4. 查看日志：

```bash
docker compose logs -f
```

---

## 7. 把地址发给朋友

把下面两个东西发给他们：

1. 游戏地址：`http://服务器公网IP:3213`
2. 游戏房间号（他们进入游戏后自己创建/加入）

朋友不需要安装 Node、Docker，也不需要下载任何文件，用浏览器打开即可。

---

## 8. 可选：使用域名和 HTTPS

如果项目所有者提供了域名，例如 `a3.example.com`：

### 第一步：添加 DNS 解析

在域名服务商控制台添加一条 A 记录：

```text
主机记录：a3
记录类型：A
记录值：服务器公网IP
```

最终域名是 `a3.example.com`。

等待 1～10 分钟让 DNS 生效。

> 如果使用 Cloudflare 代理，请先把云朵图标设为 **DNS only（灰色）**，等 HTTPS 证书申请成功后再考虑开启代理。否则证书验证可能失败。

### 第二步：在服务器执行

```bash
cd ~/a3
sudo bash deploy-vps.sh a3.example.com
```

脚本会自动启动 Caddy 并申请 HTTPS 证书。

成功后访问：

```text
https://a3.example.com
```

### 如果 HTTPS 打不开

检查：

1. 域名是否已经解析到服务器 IP
2. 云平台安全组是否放行 `80` 和 `443`
3. 查看 Caddy 日志：

```bash
docker compose -f docker-compose.https.yml logs -f caddy
```

4. 如果刚改 DNS，等待几分钟再试

---

## 9. 更新游戏版本

项目所有者发来新的 `a3-transfer.zip` 后：

1. 上传覆盖旧压缩包
2. 在服务器执行：

```bash
cd ~/a3
unzip -o ~/a3-transfer.zip
sudo bash deploy-vps.sh
```

如果使用域名：

```bash
sudo bash deploy-vps.sh a3.example.com
```

> 更新/重启会清空内存中的房间，请先让当前对局结束。

---

## 10. 停止、重启、查看日志

```bash
cd ~/a3

docker compose ps              # 查看状态
docker compose logs -f         # 实时日志
docker compose restart         # 重启
docker compose down            # 停止
docker compose up -d --build   # 重新构建并启动
```

如果使用域名 HTTPS：

```bash
docker compose -f docker-compose.https.yml logs -f
docker compose -f docker-compose.https.yml restart
docker compose -f docker-compose.https.yml down
```

---

## 11. 常见问题速查

### 问题：`ssh: connect to host ... port 22: Connection timed out`

- 云平台安全组没有放行 22
- 公网 IP 填错
- 服务器还没启动完成

### 问题：`Permission denied (publickey)`

- 用户名错了，试试 `ubuntu` / `root`
- 密钥文件不对，或密钥没有正确配对
- 使用密码登录时，确认服务器允许密码登录

### 问题：`unzip: command not found`

执行：

```bash
sudo apt update
sudo apt install -y unzip
```

### 问题：`docker: command not found`

重新执行部署脚本：

```bash
cd ~/a3
sudo bash deploy-vps.sh
```

如果 Docker 安装失败，检查服务器是否能访问外网，然后重试。

### 问题：浏览器打不开 `http://IP:3213`

按顺序检查：

1. 云平台安全组放行 3213
2. `docker compose ps` 查看容器是否 `Up`
3. `curl http://127.0.0.1:3213/healthz`
4. `docker compose logs -f`

### 问题：打开是 502 / Bad Gateway

通常是容器没起来：

```bash
cd ~/a3
docker compose ps
docker compose logs -f
```

### 问题：域名 HTTPS 证书申请失败

- DNS 没生效
- 80/443 没放行
- Cloudflare 代理处于开启状态（先改 DNS only）
- 域名被其他服务占用

### 问题：提示端口被占用

```bash
sudo lsof -i :3213
```

停止占用端口的旧进程，或修改 `docker-compose.yml` 中的端口映射后重新部署。

---

## 12. 更简单：不买服务器，用 Render

如果不想管理 Linux 服务器，可以让项目所有者把代码放到 GitHub，然后用 Render：

1. 登录 <https://render.com/>
2. 连接 GitHub
3. 点击 **New → Blueprint**
4. 选择包含 `render.yaml` 的仓库
5. 确认创建
6. 等待部署，得到 `https://xxx.onrender.com`

优点：不用买服务器，自动 HTTPS，WebSocket 可用。

缺点：免费实例空闲会休眠，休眠/重启会清空内存中的房间。

---

## 13. 部署完成后请回传

请把下面信息发给项目所有者：

```text
部署完成 ✅

访问地址：
是否 HTTPS：
服务器地区：
房间功能是否测试：
是否已把地址发给朋友：
```

如果出错，请把**完整报错文字**和截图发回，不要只发“打不开”。

---

## 14. 给项目所有者的一句话

```text
你把 a3-transfer.zip 发给我即可；
如果部署到你的服务器，请把服务器 IP、SSH 用户名、登录方式、是否 sudo 权限发我；
如果要域名 HTTPS，请把域名和 DNS 权限发我。
不要发正在运行的临时公网隧道地址，那个不能迁移。
```
