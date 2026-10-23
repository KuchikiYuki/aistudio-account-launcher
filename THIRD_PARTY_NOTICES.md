# 第三方代码与公开发布检查

## Catiecli Playground Executor

- 文件：vendor/catiecli-playground.user.js。
- 原作者署名：catiecli（保留脚本中的作者和命名空间）。
- 来源：https://catiecli.sukaka.top/api/pg/script.user.js。
- 当前文件是本地修改版本，包含后台适配、自动激活、本地化运行按钮识别、续推调度和状态上报，不等同于上游原始脚本。
- 所检查的本地脚本头部没有声明 @license；本仓库未附加或假定上游再分发许可。仓库公开可见不代表第三方代码已获得开源授权，使用、修改或再次分发前应向原作者确认相应许可。
- 本说明只记录来源，不代表已获得授权，也不替作者选择整个工程的开源许可证。

## Playwright Core

- 通过 npm 安装，未将依赖目录复制进源码。
- 本地依赖元数据标注 Apache-2.0；安装后保留其原有声明。

## 服务端地址

保留的 catiecli 服务域名及 AI Studio 地址是公开功能依赖，不是个人 Key 或私人服务器凭证。此工程不隶属于 Google、Chrome、Microsoft 或 catiecli 官方。
