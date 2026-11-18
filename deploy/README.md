# 部署：在服务器上用 Paseo 托管 nyan

nyan 通过 `nyan acp`（ACP，Agent Client Protocol）接入 [Paseo](https://github.com/getpaseo/paseo)。服务器上常驻一个 Paseo daemon，每个会话由它启动一个 `nyan acp` 进程；桌面端和手机端都只是连到这个 daemon 的窗口。

本目录的文件：

| 文件 | 用途 |
|---|---|
| `paseo-daemon.service` | systemd 单元，以用户 `paseo` 常驻运行 daemon |
| `paseo.config.example.json` | `~paseo/.paseo/config.json` 模板：只听本机、密码、nyan provider |
| `nyan.settings.example.json` | `~paseo/.nyan/settings.json` 模板：模型网关和默认模型 |
| `install-nyan-acp.sh` | 把本地构建的 nyan 装到服务器，保留上一版并记录来源 |

模板里 `<...>` 的地方要换成实际值。密钥、密码和内网地址不进仓库。

## 布局

| 路径 | 内容 |
|---|---|
| `/opt/paseo` | Paseo CLI（`npm install --prefix`，不装进全局） |
| `/opt/nyan-acp/bin/nyan` | nyan，`nyan.prev` 是上一版，`/opt/nyan-acp/BUILD-INFO` 记录来源提交 |
| `/home/paseo/.paseo` | daemon 状态：配置、密钥对、会话 |
| `/home/paseo/.nyan` | nyan 配置和模型网关的 key（都是 0600） |
| `/home/paseo/work` | 会话的工作目录 |

## 首次部署

以下命令在服务器上用 root 执行。

1. 建用户。agent 以这个用户的权限执行命令，是否给 sudo 按主机的用途决定。

   ```bash
   useradd -m -d /home/paseo -s /bin/bash paseo
   ```

2. 装 Paseo（固定版本）。npm 12 默认不跑依赖的安装脚本；`node-pty` 自带 linux-x64 预编译包，不需要放行。

   ```bash
   mkdir -p /opt/paseo
   npm install --prefix /opt/paseo --no-fund --no-audit @getpaseo/cli@0.16.1
   ```

3. 装 nyan：在开发机上执行 `deploy/install-nyan-acp.sh <服务器>`，见下文。首次之前先在服务器上 `mkdir -p /opt/nyan-acp/bin`。

4. 配 nyan：把 `nyan.settings.example.json` 填好放到 `/home/paseo/.nyan/settings.json`，网关 key 放到 `/home/paseo/.nyan/keys/main`，两个文件都 `chown paseo:paseo` 并 `chmod 600`。`permissions.defaultMode` 保持 `default`，工具调用才会经客户端审批。

   验证：`sudo -iu paseo bash -lc 'cd ~ && /opt/nyan-acp/bin/nyan -p "Reply with exactly: pong"'` 应输出 `pong`。

5. 配 Paseo：生成密码和哈希，明文只留在服务器上。

   ```bash
   install -d -m 700 -o paseo -g paseo /home/paseo/.paseo
   pw=$(head -c 18 /dev/urandom | base64 | tr '+/' 'AB')
   printf '%s\n' "$pw" > /home/paseo/.paseo/daemon-password
   cd /opt/paseo && PW="$pw" node -e "console.log(require('bcryptjs').hashSync(process.env.PW, 12))"
   ```

   把输出的哈希填进 `paseo.config.example.json` 的 `daemon.auth.password`，存为 `/home/paseo/.paseo/config.json`。两个文件都归 `paseo`、权限 0600。

6. 装服务并启动：

   ```bash
   cp paseo-daemon.service /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now paseo-daemon.service
   curl -s http://127.0.0.1:6767/api/health    # {"status":"ok",...}
   ```

## 客户端接入

daemon 只听 `127.0.0.1:6767`，不开放端口。

- 桌面端：设置 → 添加主机 → 远程 SSH，填 `ssh://<服务器>`，再填 daemon 密码。
- 手机端：`paseo daemon run` 默认开启 Paseo 官方中继（端到端加密）。在服务器上执行 `sudo -iu paseo /opt/paseo/node_modules/.bin/paseo daemon pair`，扫二维码，再填 daemon 密码。
- 新建会话时 provider 选 `nyan`，目录选 `/home/paseo/work` 下的仓库。

## 更新 nyan

```bash
cargo build --release --locked --bin nyan
deploy/install-nyan-acp.sh <服务器>
```

新会话用新版本，已在运行的会话保持旧进程。回滚：在服务器上 `mv /opt/nyan-acp/bin/nyan.prev /opt/nyan-acp/bin/nyan`。

构建机的 glibc 不能比服务器新（`objdump -T target/release/nyan | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1` 不超过服务器的 `ldd --version`）。否则用 release 工作流的 musl 构建。

## 排查

- `paseo provider diagnostic nyan`（以 `paseo` 用户、设置 `PASEO_PASSWORD` 执行）逐步检查启动、`initialize`、`session/new`。
- 某次创建会话失败后，daemon 会缓存 provider 的状态。修好之后执行一次 `paseo reload`。
- daemon 日志：`journalctl -u paseo-daemon` 和 `/home/paseo/.paseo/daemon.log`（trace 级，JSON）。
