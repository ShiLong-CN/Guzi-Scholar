# Web（只读展示站）

仓库当前配置地址：`http://82.156.152.27/`（首页为介绍页，`/library` 进入文献库）。部署前必须重新验证该地址和服务状态，不能仅凭本文档认定线上可用。

## 定位

只读演示：可浏览文献库、阅读正文与已缓存译文、查看公式与图表；**不提供**导入、编辑、标注、AI 翻译与问答——这些留在桌面客户端。

## 部署

```sh
./webseit/deploy.sh              # 同步代码 + 文献数据并重启服务
./webseit/deploy.sh --skip-data  # 只更新代码
```

以上命令从仓库根目录执行。脚本硬编码了目标主机和部署目录，并使用 `rsync --delete/--delete-excluded` 后重启 systemd 服务，具有远端删除语义；执行前必须核对目标、保留回滚备份并获得部署授权。

脚本会：创建远端目录 → 白名单同步代码 → 同步脱敏文献快照 → 安装 systemd 单元 → 等待服务就绪 → 校验 `/api/health` 返回 `readonly:true`。当前排除了凭据、笔记、标注、设置和 `upload.pdf`，但仍会同步等价的 `source.pdf`，服务也可公开该文件。因此不要部署无权公开的原始论文；若要求只发布转换产物，还必须在脚本和服务端同时排除 `source.pdf`。

## 只读保障（多层）

1. 类级守卫：GET/HEAD 之外的所有 HTTP 方法一律 403（新增动词也自动覆盖）
2. 写原语短路：内容目录、清单、译文缓存、设置写入在只读模式下直接返回
3. 不启动转换和元数据 worker，也跳过任务产物迁移；启动仍会写数据锁，并可能规范化 `library.json`
4. 出站 JSON 抹除绝对路径；诊断产物（manifest/日志/校验报告）与账号服务地址不公开
5. systemd `ProtectSystem=strict` 限制系统写入，`ReadWritePaths` 只把可写范围收窄到 data root，并不代表 data root 完全只读

## 本地校验

```sh
curl -sS http://82.156.152.27/api/health
curl -sS -o /dev/null -w '%{http_code}\n' -X PUT http://82.156.152.27/api/settings
node ios/verify-mobile.cjs http://82.156.152.27   # Chromium 视口 smoke，需先装 Playwright
```

第一条应包含 `"readonly":true`，第二条应输出 `403`。这两项仍不能替代移动真机、权限边界和原始文件公开面的验收。

## HTTPS 现状

仓库当前仍配置为 HTTP。历史记录显示，目标节点的域名备案限制曾阻止证书验证；该结论可能随域名、节点和云厂商策略变化，部署时必须重新核实。旧实测记录见 `enable-https.sh` 顶部注释。

影响：Safari 仍可创建普通主屏幕快捷方式，但不能据此宣称完整 PWA；Service Worker、可靠离线能力和安全传输都需要 HTTPS。Capacitor 壳当前通过平台明文例外加载 HTTP，这属于安全债务，不是生产方案。

解法（任选其一，之后从仓库根执行 `./webseit/enable-https.sh <域名>`）：
1. 用已完成 ICP 备案的域名解析到本机
2. 把展示站迁到香港/海外节点（无需备案）
