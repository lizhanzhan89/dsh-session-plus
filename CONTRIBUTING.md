# 贡献指南

感谢你愿意为 dsh-session-plus 出力。

## 开发环境

- Node.js ≥ 20（本项目零运行时依赖，不需要 `npm install`）
- 一个可用的 DSH 安装（用于本地验证插件行为）

## 修改流程

```bash
git clone https://github.com/lizhanzhan89/dsh-session-plus.git
cd dsh-session-plus

# 改 src/ 下的源码
#   src/index.js         host 半（ESM，零依赖）
#   src/client/index.js  client 半（CJS 风格，由构建脚本包 __ModuleLoader__ 头尾）

bash scripts/build.sh          # 产出 lib/index.js 与 lib/client.js
node --check lib/index.js      # 语法校验
node --check lib/client.js

git add -A && git commit -m "..." && git push
```

`lib/` 是入库的构建产物：插件以 `link:` 方式被 DSH profile 引用，入库后可直接 clone 使用。**提交前必须重新构建并一起提交 `lib/`**，否则源码与产物不一致。

## 本地验证

1. 用 `plugin_manager` 的 `install_bundle` 指向本目录安装
2. 在浏览器刷新页面（client bundle 的 `rev` 由文件 mtime/size 计算，刷新即拉新版本）
3. 控制台可用 `window.__dshSessionPlus` 查看状态、`window.__dspHeaderDebug` 查看头部按钮挂载情况

## 代码约定

- 零运行时依赖，不引入构建工具链
- host 半只用 `node:fs` / `node:path` / `node:os` / `node:crypto`
- client 半不打包，直接写 DOM 操作与手写 `h()` 工具
- CSS 类前缀统一 `dsp-`，`dataset` 属性统一 `dsp*`
- 状态写入必须走原子写（`tmp` + `rename`）与 `version` 乐观并发

## 提交信息

用一句话说清改了什么，中英文均可，例如：

```
修复：删除会话后左侧列表未即时消失
新增：分组支持折叠状态持久化
```

## 报告问题

请附上：

- DSH 版本（`dsh --version`）
- 浏览器控制台报错
- 复现步骤
- 涉及分组时，`~/.dsh/profiles/web/session-plus.json` 的相关片段（注意脱敏）

## 许可

提交的代码默认以 MIT 许可发布。
