# Docker 镜像构建与推送指南 (GHCR)

本指南介绍了如何将 `jimeng-free-api-all` 项目打包为 Docker 镜像并推送到 GitHub Container Registry (GHCR)。

## 1. 前置条件

*   **GitHub PAT**: 您需要一个具有 `write:packages` 权限的 [GitHub Personal Access Token (Classic)](https://github.com/settings/tokens)。
*   **Docker & Buildx**: 确保已安装 Docker。对于多平台构建（如在 Mac M1/M2 上构建 amd64 镜像），需要 Docker Buildx。
*   **仓库权限**: 您需要对 `ningxiaoxiao/jimeng-free-api-all` 仓库有推送权限。

## 2. 登录 GHCR

在终端中运行以下命令进行登录。请将 `YOUR_GITHUB_PAT` 替换为您的实际 Token：

```bash
echo "YOUR_GITHUB_PAT" | docker login ghcr.io -u ningxiaoxiao --password-stdin
```

## 3. 构建并推送镜像

使用 `docker buildx` 可以同时构建多个平台的镜像并直接推送到注册表。

### 构建 linux/amd64 (服务器常用)

如果您只需要在普通的 Linux 服务器上运行：

```bash
docker buildx build --platform linux/amd64 \
  -t ghcr.io/ningxiaoxiao/jimeng-free-api-all:latest \
  -t ghcr.io/ningxiaoxiao/jimeng-free-api-all:sha-<git-sha> \
  -t ghcr.io/ningxiaoxiao/jimeng-free-api-all:0.8.6-<git-sha> \
  --push .
```

推荐至少保留两类标签：

- `latest`：便于直接拉取最新镜像
- `sha-<git-sha>` / `0.8.6-<git-sha>`：便于回溯到具体代码版本

### 构建双平台 (amd64 + arm64)

如果您希望镜像同时支持常规服务器和 ARM 服务器（如甲骨文 ARM 或 Mac）：

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/ningxiaoxiao/jimeng-free-api-all:latest \
  -t ghcr.io/ningxiaoxiao/jimeng-free-api-all:sha-<git-sha> \
  --push .
```

## 4. 运行镜像

推送成功后，可以在任何安装了 Docker 的机器上拉取并运行：

```bash
# 拉取最新镜像
docker pull ghcr.io/ningxiaoxiao/jimeng-free-api-all:latest

# 启动容器
docker run -it -d --init --name jimeng-free-api-all \
  -p 8000:8000 \
  -e TZ=Asia/Shanghai \
  ghcr.io/ningxiaoxiao/jimeng-free-api-all:latest
```

## 5. 常见问题

### 镜像可见性 (Visibility)
默认情况下，推送到 GHCR 的镜像可能是 **Private** (私有) 的。
*   要公开镜像，请访问 GitHub 个人主页 -> **Packages** -> 点击 `jimeng-free-api-all` -> **Package Settings** -> 在页面底部点击 **Change visibility** 改为 **Public**。

### 权限错误 (denied: denied)
如果遇到登录成功但推送失败，请检查：
1. PAT 是否勾选了 `write:packages`。
2. 镜像名称前缀是否与您的 GitHub 用户名一致 (`ghcr.io/ningxiaoxiao/...`)。
