# Spike：Managed LibreOffice 三平台分发可行性

> ID：CR-X2  
> 状态：Ready for Agent  
> 类型：验证性 Spike，不实施正式下载器  
> 日期：2026-07-21  
> 时间盒：2–3 个工作日

## Question

是否能把 LibreOffice 作为 Finwork 管理组件，以免管理员、可验证、可升级的方式分发到 macOS arm64/x64 与 Windows x64，同时不破坏应用签名、公证、许可证义务和安装体积目标？

未验证前，v1 继续使用系统 LibreOffice + 强 preflight。

## Research Areas

1. 可再分发许可证、notice 和源码提供义务。
2. 官方发行物是否支持无管理员提取/运行。
3. macOS vendor signature、Gatekeeper、quarantine、公证与嵌套 app 行为。
4. Windows portable/installer、Authenticode、DLL 搜索路径和更新占用。
5. 各平台压缩/安装体积与下载时间。
6. headless recalc/render 所需最小文件集，裁剪是否合法且稳定。
7. 独立 UserInstallation、并发与崩溃清理。
8. 更新、回滚、卸载与旧版本并存。
9. 中国大陆下载源、CDN 和 checksum manifest。

## Prototype Requirements

只在临时/隔离目录做原型：

- 固定一个候选 LO 版本。
- 制作三平台候选制品或明确无法制作的平台。
- 记录 URL、SHA-256、可执行相对路径和许可证。
- 安装到模拟 app-data managed runtime 目录。
- 运行真实 formula/named-range/render fixture。
- 两个并发 profile。
- 升级到第二版本或模拟版本切换与回滚。
- 卸载不影响系统 LO。

## Platform Gates

### macOS

- `codesign --verify --deep --strict`。
- Gatekeeper assessment。
- 从带 quarantine 的下载路径首次运行。
- arm64 与 x64 分别验证，不能用 Rosetta 结果代替全部结论。

### Windows

- 无管理员安装/解压。
- 来源签名或制品供应链验证。
- 路径含空格和中文。
- 文件占用下升级/回滚。

## Security and Supply Chain

- manifest 受版本控制并签名或随受信应用更新发布。
- 下载先到临时文件，SHA 验证后原子安装。
- executable 路径由 manifest 决定，不接受模型输入。
- 禁止 LO 更新外链或访问网络。
- third-party notices 可在 About/安装目录查看。

## Decision Criteria

### PASS

所有正式平台通过签名/运行/fixture/升级门，体积与许可可接受。之后另写 `spec-managed-libreoffice-runtime.md`。

### PARTIAL

只对通过的平台立项，其他平台继续系统 LO；产品 UI 明确差异。

### FAIL

保持系统 LO + 安装引导，不建设托管组件。

## Out of Scope

- 正式生产下载器。
- 自动更新实现。
- 修改 CR-S1 系统 LO 主路径。
- 把 LO 嵌入基础安装包。

## Deliverable

新增 `spike-managed-libreoffice-distribution-findings.md`，包含平台矩阵、制品大小、签名/许可证据、风险、结论和后续 Spec 入口条件。

