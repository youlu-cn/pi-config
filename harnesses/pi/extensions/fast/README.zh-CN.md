# Fast

[English](./README.md) | [简体中文](./README.zh-CN.md)

本扩展为通过 ChatGPT OAuth 登录的 OpenAI / Codex Responses 模型提供 `/fast [on|off|status]`。不带参数时切换状态，状态按 provider 独立保存。默认关闭。

运行仓库根目录的 `./install-harness.sh` 后，在 Pi 中执行 `/reload`，然后使用 `/fast on`。

启用后，扩展只在请求未显式设置 `service_tier` 时添加 `"priority"`，不会修改已有值。不支持 API Key 或其他 provider，也不会改写模型或请求地址。状态栏标记仅表示本地策略已开启；服务端是否接受及其速度、费用取决于模型和账号。

配置文件为 Pi agent 目录下的 `fast.json`（默认 `~/.pi/agent/fast.json`），可设置 `enabled`（默认 `false`）和 `showStatus`（默认 `true`）。手动开关覆盖默认值，保存在 `state/fast.json`。
