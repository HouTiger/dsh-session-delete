# 会话删除插件

在 Harness Web 侧栏的会话「...」菜单中增加 **删除会话**，用于**永久删除**一个会话，而不只是归档。

A DSH Web bundle plugin that adds **Delete session** to the sidebar session menu and permanently removes the session log, workspace account, projection cache, and live Client list entry. Tested with DSH 0.2.1-rc.3.

## 安装（GitHub）

要求：DSH `0.2.1-rc.3`（见 `package.json` 的 `engines.dsh`）。

1. 打开 DSH Web → 侧栏 **Plugins** → **Add plugin**；
2. 填入 Git 地址：

   ```text
   git+https://github.com/HouTiger/dsh-session-delete.git
   ```

3. **Install** → **Enable now** → 刷新页面。

CLI profile 也可以：

```bash
dsh plugin --profile <profile> add git+https://github.com/HouTiger/dsh-session-delete.git
```

需要固定提交时：

```text
git+https://github.com/HouTiger/dsh-session-delete.git#<commit>
```

本插件是纯 JavaScript，无构建步骤、无依赖安装脚本。它没有发布到 npm；GitHub 安装不依赖 npm registry。

## 行为

删除会清理：

- 会话日志目录（`<session root>/<project>/<session-id>/`，包括 `session.vN.jsonl.zstd` 和锁文件）；
- `session_projcache` 中该会话的投影缓存记录；
- 工作区注册表中的会话记账、归档集合和置顶集合；
- 所有已连接客户端的会话列表（通过 Host 的 `api-session/removed` 事件）。

侧栏行会在 Host 完成删除后自动消失，无需刷新页面。

## 使用

打开侧栏中某个会话的「...」菜单，选择 **删除会话**，在确认框中再次确认。删除不可撤销。

**「打开中」不等于「运行中」**：一个会话只要在当前 Harness 进程里被打开过，就会驻留在内存中（即使已经停止运行），归档也不会释放它。插件会在删除前主动关闭这种驻留会话：

1. 向 turn、subagent、job、schedule 等活动提供者发送停止请求；
2. 等待会话空闲；
3. 关闭 Agent scope 和日志写入句柄；
4. 从 live session / agent 注册表移除并通知客户端；
5. 删除日志目录、投影缓存和工作区记账。

正在运行的会话也会走同一流程，确认框会提示「会先停止当前工作」。如果某个驻留会话因版本内部结构变化无法安全关闭，Host 会拒绝删除并提示重启 Harness。

## 实现

- Host：`SessionDeleteService`，通过 Typert Remote 暴露 `sessionDelete/delete`，供 Web 客户端调用。
- Client：向 `sidebar.workspaces.session.menu.item` 注册菜单项，向 `shell.overlay` 注册确认对话框；文案通过 Client locale 服务提供中英文。
- 删除逻辑集中在 `lib/delete-session.js`，不依赖 Host 启动即可单独测试。

## 开发

```bash
node --test test/session-delete.test.mjs
```

测试覆盖日志/缓存/工作区清理、驻留会话关闭、停止失败、非法 id 和未物化会话。

## 兼容性

本插件依赖当前 DSH 的内部运行结构（Agent scope、live session/agent 注册表、persistence tracker、workspace entity 的 detach mutation），因此把 `engines.dsh` 固定在 `0.2.1-rc.3`。在别的 DSH 版本上安装会被版本检查拦下；请先实测再放宽范围，不要直接绕过检查。

## 许可证

专有软件，保留所有权利。未经版权所有者事先书面许可，不得使用、复制、修改、合并、发布、分发、再许可或销售本软件的任何部分。详见 [LICENSE](LICENSE)。

License: Proprietary. All rights reserved. No permission is granted to use, copy, modify, distribute, sublicense, or sell this software without prior written permission.

**关于公开仓库**：本仓库是公开的，GitHub 允许用户查看和 fork 公开仓库；许可证限制的是对代码的使用、修改和分发，不能阻止代码被看见。如果需要完全禁止他人访问，请在 GitHub 仓库的 **Settings → General → Danger Zone → Change repository visibility** 将可见性改为 **Private**。改为 Private 后，你的其他电脑通过 Git 安装时需要各自的 GitHub 认证。

## 限制

- 极少数无法关闭的驻留会话需要重启 Harness 后再删除；正常情况下打开中/已停止的会话可以直接删除。
- 子会话（subagent）不会被级联删除；它们有独立的会话日志。
- 会话附件按内容寻址，可能与其他会话共享，因此不随会话删除。
