# dsh-session-plus

DSH Web 侧栏会话增强包：彻底删除会话 + 单列表视图下的会话分组。

## 功能

- **删除会话**：会话菜单 / 右键菜单「🗑 删除会话…」，二次确认后删除会话日志与所有记账，不可撤销。
- **会话分组**：仅在「单列表」分组方式下生效。顶部固定一个「未分组」容器，其下为用户分组；拖动会话或走会话菜单「移动到分组」即可归组，拖回「未分组」即移出。分组支持新建、重命名、换色、折叠、删除（删除分组不删会话）。

## 构建与安装

```bash
bash scripts/build.sh
# 然后用 plugin_manager 的 install_bundle 指向本目录
```

安装后刷新浏览器页面。

## API

前缀 `/@dsh-external/dsh-session-plus/api`：`GET /state`、`GET /health`、`GET /status`、`POST /op`（分组操作，乐观并发）、`POST /delete`（删除会话）。

状态文件：`~/.dsh/profiles/web/session-plus.json`。

## 许可

MIT
