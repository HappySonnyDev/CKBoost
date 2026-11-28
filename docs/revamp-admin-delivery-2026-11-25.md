# Admin 改版工程交付记录（2026-11-25）

## 2026-11-27 实际升级记录

本节记录后续实际执行结果；下方“一”至“七”保留 11 月 25 日交付时的状态，不能把其中“待部署／默认 v3”当成当前状态。四笔交易均由用户使用 Account 1 在 MetaMask 审阅、签名并显式广播；确认工具只读取公开链并生成本地证明。

| 阶段 | 已确认交易 | 区块 | 实际手续费（tCKB） |
| --- | --- | --- | ---: |
| Registry code，46,728 tCKB 代码容量 | `0x3aed91b51165ae831e4422d017fd280bd78e2247bcd4a1410520fecca39968a8` | `0x161f1e3` | 0.00047210 |
| Registry state，386 tCKB 初始容量 | `0xc8113a4525db462182e5260387bb8b392b0c084a8bb2e3eef30f7a48be83ea39` | `0x161f1fc` | 0.00000942 |
| 三代码批次，新增占用 300,176 tCKB | `0xc6acb017d2d77dd7e40e92eceaecd4b3e56320b90b403db543fa66e3509fb35a` | `0x161fbf7` | 0.00485258 |
| 协议配置，仅更新 Tip/Funding 身份与 Unix 秒时间戳 | `0xbdf4775f72c4238db2d7d300abd92aef8ac7b5147caaed2fa51367fb769a8454` | `0x161fd17` | 0.00001553 |

总新增存储占用 **347,290 tCKB**，四笔实际手续费合计 **0.00534963 tCKB**。存储占用与手续费分开计算；原 QA ProtocolLock 的代码容量已计入三代码批次的净增量，没有重复计费。

完整 raw body、实际父交易、TypeID、owner、ELF 字节与 hash、容量、六个输出当前 live、实际协议最小 delta、Indexer 高度和完整旧 Tip/Funding 命名空间检查均通过，才生成 v4。三代码和最终配置的 canonical hash 另由第二官方节点比对；其最终 live 请求超时，不冒充该节点完成了 live 证明。第一节点完整确认已建立该证明。

发布的公开配置为 [ckboost-testnet-admin-v4.json](../dapp/config/qa/ckboost-testnet-admin-v4.json)，profile hash `0x4faf44b759bbcd6218fdb86acb3a27b28c1d41a867c21a60d0b169745563ee06`。`pnpm qa` 使用该固定 v4；原 v3 文件逐字节保留作为验证祖先。QA 协议仍为 `4eac…e034`，新增 Registry 仍为 `97e23…9690`。TipType 为 `bd7ab860…094237`，FundingLock 为 `02d6e493…219707`，QA ProtocolLock 保留原 TypeID `e91b5a78…d28815`。生产配置、共享部署记录和 `.env.local` 没有修改。

升级后再次对当前 live 数据只读核验：原测试活动 `8a05055c…9bad32`、Account 3 的 owner、Account 4 的 Reviewer、Account 2 的原 UserCell 和 **1 Point** 均保留；活动和 UserCell 的原 outpoint/data 未改变。新 Registry 初始 revision=0，阈值 1,000/5,000/10,000 CKB、有效期 30 天、Approver 为 Account 3。Organizer 身份本身不授予 Tip 背书权。

金融签名页 `/revamp/testnet-admin-financial-sign` 将审阅、签名保存、单次显式广播和确认分开。已保存广播尝试后只能查原回执，不重新签发；刷新保留已签字节。当前新能力真实钱包验收仍需逐项执行：手工验证、奖励周期、Tip 首审与指定 Approver 后续背书、资金与支付等。合约确认和只读数据保留通过，不等于这些流程已全部通过。

签名页初版全量 dapp Jest 131 suites / 1,127 tests 通过。最终审查补充广播实际边界的账户、客户端、scope 与完整签名字节校验，保留 CCC 的手续费校验及缓存；相关 4 suites / 81 tests 通过，包含 6 个新增回归场景。发布配置与 QA 工具 85 项 Node tests、最终同一 v4 的 production build 通过；实际启动验证也修复了新版 pnpm 需要明确 Netlify 可执行文件的问题。历史 6 项类型诊断的界限仍见下方第六节。

最终 v4 浏览器路由检查为 **15/15 通过**：五模块分别在 375 Dark、1440 Dark、1920 Light 访问，零 page/console error、零 HTTP 资源失败、零整页横溢出。实际下载 JS 含 4faf profile，捕获的 45 次协议查询全部匹配完整 QA 脚本。独立无钱包 Chromium 的 30 次官方 WebSocket 连接被检查脚本主动阻断；不把该项称为完整网络可用性或已登录 Admin 数据视图验收。所有临时浏览器均已关闭。

### 2026-11-28 手工验证与回执恢复

Account 1 已完成 Account 2 的手工验证，实际交易 `0x305e7396f1801871f080587dcda2d69b638e9c90889a4974ad3e6e7621b782b4` 已确认。Registry revision **0 → 1**，仅追加绑定该用户完整身份、钱包与 UserCell 证据的 manual attestation；新增存储容量 **579 tCKB**，实际手续费 **0.00031460 tCKB**。原 Protocol、Campaign、UserCell 和 Account 2 的 1 Point 均仍 live 且未被消费，Tip 设置和奖励周期保持原样。

后续新建奖励周期时，发现浏览器仍保存着上笔待确认回执。用户详情的只读认证状态已回显，但该读操作不解除写入回执；旧实现又在不同 action 进入确认流程之前直接拦截，造成已上链更新阻止新操作。修复让保存入口先核验旧交易的完整 body hash、Registry 脚本、预期 data hash、协议、确认状态以及当前 live 状态或合法后继，并重新核对 Admin 与当前 scope，再解除该精确回执。未知、未确认、拒绝、数据不匹配或读取失败均不解除。

确认同一个 action 时返回原交易，不重复发送。确认不同 action 的旧回执时，**只解除旧回执并提示当前新变更尚未提交**；用户复核后再次明确点击，才会提交新变更。刷新奖励表单会生成新随机周期 ID，因此不能把恢复旧回执的那次点击直接变成另一次创建。恢复提示保留当前表单和周期 ID，不自动重试。该恢复过程本身不代表奖励周期已经创建、发奖或铸币。

随后实际表单又暴露出加载状态问题：Registry 请求仍在加载或读取失败时，hook 都向表单传递 `available=null` 且丢失实际错误，资产先加载完成又会提前启用提交；表单因此误报存储不可用。现已分别传递 loading/error/明确 unavailable，只有 Registry 和资产均就绪才启用提交，错误保留实际读取原因。配置重试只重新读取 Registry 和资产，不改变 access session key、清空表单或重生周期 ID；真正的账户或权限切换仍遵守原 scope 隔离。

回执修复阶段完整 Jest **131 suites / 1,152 tests** 通过；补充加载和重试修复后，相关 service、hook 与表单 **3 suites / 53 tests** 通过，类型检查没有新增诊断。实际只读恢复探针使用临时合成浏览器回执与真实公共链数据，没有钱包密钥或写入接口；一次运行因公共节点连接超时未完成，故不作为恢复成功或奖励周期已创建的证据。随后用户已完成实际重试和签名，结果如下。

### 已确认奖励周期配置

交易 `0xc3d2d0b40f0bdea0c3ff3f1bf7d6cb5ca2db7fa79231b86a7dc135dede1d63bc` 已核验 committed/current live，实际 Admin 为 Account 1。Registry revision **1 → 2**，只追加 `period-f5949b65c76f2445b6f08049a272f521`；新增容量 **765 tCKB**、实际手续费 **0.00064854 tCKB**。

周期名称为 `QA leaderboard 2026-11-28`，计划资产为完整 QA Points 脚本（`fcb4…` / `4eac…`），数量 100，四档比例 40/25/15/20%，资格为 minimum Points=1、approved quests=1、Manual verified。用户成功截图及链上实际时间均为 **2026-11-29 23:15 → 2026-11-30 23:15，Asia/Shanghai**；这与最初建议的 00:00 不同，核验显式采用最新截图时间，没有把链上读取值自动冒充预期值。

实际父交易 body hash、当前 Registry/code、Account 1 原生输入和净支出已交叉核对；manual attestation、Tip 设置保持原样，Protocol/Campaign/UserCell 仍 live 且未被消费，Account 2 原 Points Cell 及余额 1 保留。本次证明配置已持久化和页面回读完成；尚未计算获奖名单、评估周期资格、支付、领取或铸造 100 Points。

## 11 月 25 日交付时记录（历史）

本记录覆盖新版 Admin 的 Overview、Campaigns、Users、Tipping、Rewards & Recognition 五个模块，以及配套的独立 QA 金融合约候选。五模块页面与数据、操作接口已实现；这不代表所有新能力已经在链上启用，也不代表五模块的每个按钮都经过真实钱包端到端验收。

**本轮新增能力仅面向独立 Testnet QA 协议。** 当前默认 QA v3 不因这份交付记录、构建产物或环境变量自动切换；线上配置、共享部署记录和旧合约代码 Cell 保持原样。本轮金融升级仅完成源码、ELF、离线/VM 测试和公开只读提案，没有签名、广播、部署、激活、PR 或合并。本项目此前已有的 QA 真实交易不属于本轮新增金融能力的通过证据。

## 一、五模块范围与当前可用性

| 模块 | 已实现 | 真实写入与未启用部分 |
| --- | --- | --- |
| Overview | 当前协议概览、期间指标、资金、待办和活动入口；加载、失败、未知与重试状态；响应式页面。注册时间使用 UserType 创建证明，不把最新 UserCell 更新时间当注册时间。资金区分原生容量、完整类型脚本的代币数量；当前状态不伪造成历史事件。 | 以独立、可验证的只读结果展示。无法覆盖的历史或期间指标显示未知；不以假数据补齐图表。待办链接进入相同完整 ID、同协议的详情。 |
| Campaigns | 列表、筛选、详情、Description/Rules、Quest 内容与统计、平台审批预览及状态。完整 Campaign ID 使用 ConnectedTypeID.type_id，不与完整 type-script hash 混用。 | 已接真实协议批准向量更新、实际 Admin 与账户/协议切换保护、精确交易确认及回读。仅 QA 允许新页面写入。Reject 的产品/合约生命周期未定义，按钮明确不可用，不伪造拒绝状态或成功结果。 |
| Users | 当前协议规范 UserCell 列表、用户详情、参与/创建活动、Points、已领取徽章、贡献与奖励记录；注册来源证明、真实角色和验证状态。 | 已接实际协议 Admin/Organizer 角色变更接口，保留已有角色和业务数据。手工验证走独立 AdminRegistry；未部署 Registry 时显示不可用，不在本地伪造验证完成。Telegram 与 Manual 可并存，不相互冒充。 |
| Tipping | Admin 列表、创建、详情、历史、资金存入和设置；独立公开详情允许经验证的 Registry Approver 查看并背书；持久化交易回执与只读确认恢复。 | 旧部署具备的操作仍按实际能力运行。新 UDT 支付、独立 Approver、Never/新阈值与新有效期规则，需要配套 Registry、TipType、FundingLock、QA ProtocolLock、SDK 和 runtime 全部匹配后启用。首个背书必须来自当前 Platform Admin；后续为当前 Admin 或 Registry Approver，Organizer 身份本身不授予 Tip 背书权。非 Admin 不开放创建、存款或设置管理。 |
| Rewards & Recognition | Achievements / Leaderboard Rewards 子页、已发布成就详情、真实 receiver、可证明的 claim 交易来源、New period 表单、Activity bonus 弹窗；未知、空、失败、禁用和重试状态。 | 成就定义保留开发者管理方式，UI 不制造链上定义或资格。Period 使用 Registry 持久化接口，未部署时不可发布。Activity bonus 已接现有 streakConfig 的真实协议更新、QA-only 与 fresh Admin 保护、交易回执、实际交易确认和当前状态回读；必须由用户明确操作签名。 |

页面入口和主要实现：

- [共享 Admin 页面外壳](../dapp/components/revamp/admin-section-shell.tsx)。
- [Overview](../dapp/components/revamp/admin-overview-page.tsx)、[数据模型](../dapp/lib/revamp/admin-overview-model.ts)。
- [Campaigns](../dapp/components/revamp/admin-campaigns-page.tsx)、[平台审批](../dapp/lib/revamp/admin-campaigns-approval.ts)。
- [Users](../dapp/components/revamp/admin-users-page.tsx)、[用户与角色接口](../dapp/lib/revamp/use-admin-users.ts)。
- [Tipping](../dapp/lib/revamp/use-admin-tipping.ts)、[只读回执确认](../dapp/lib/revamp/admin-tipping-confirmation.ts)、[配套代码能力验证](../dapp/lib/revamp/admin-tipping-capability.ts)。
- [Rewards](../dapp/components/revamp/admin-rewards-page.tsx)、[New period](../dapp/components/revamp/admin-rewards-period-form.tsx)、[claim 来源证明](../dapp/lib/revamp/admin-rewards-provenance.ts)、[Activity bonus 写入](../dapp/lib/revamp/admin-rewards-transactions.ts)。

### 统一的数据、权限与确认边界

所有新页面按实际钱包锁、网络、完整协议身份读取和保存状态。写入前重新读取当前协议与角色，不把 Provider 的可编辑布尔值当授权；同一 Signer 对象切账户、协议切换和迟到异步结果不得保留旧 Admin 数据或继续旧操作。金额使用整数基础单位及完整资产脚本，不用浮点数或简写 code hash 决定币种。

签名、发送、提交回执、确认和业务回读是不同阶段。实际发送边界记录精确交易 hash；丢失 ACK、暂未确认或节点读取失败不显示成功，也不自动重新签名/发送。已撤销角色的钱包可以只读核查自己保存的回执，这不恢复写权限。新页面不会自动签名、claim 或发奖。

## 二、Registry 和金融候选的职责

[AdminRegistry](../contracts/admin-registry/README.md) 是新增独立合约，不修改旧 ProtocolData / UserData 布局。状态使用同一个完整自定义脚本作为 type 与 lock，参数绑定唯一 TypeID 和当前协议；创建 revision=0，更新 revision 严格加一。当前 Admin 必须有普通空数据 CKB 输入，并在所有同锁输入/输出（包含 typed 容量）上严格净支出，实际钱包锁仍须执行通过。

Registry 的二进制前缀验证 Tip 的 approvers、阈值和有效期参数；尾部有界 metadata 保存手工验证及奖励周期。**保存 reward period 的计划元数据不等于自动计算获奖名单、托管预算、自动支付或链上发奖。** 前端校验时区、时间、资产、基础单位与分配比例；metadata 本身不是付款合约。未实现的结算流程不显示已支付。

[独立金融候选 workspace](../contracts/admin-tipping/README.md) 包含：

1. 新鲜 QA TipType：首审 Admin、后续 Admin/Registry Approver，支持者只能去重追加且旧前缀不变；精确奖励、Points mint、完整 UDT 脚本与收款人净增量校验。
2. 新鲜 QA FundingLock：严格 Tip 支付，并保留现有 Campaign 资金支路；未知方法拒绝。去掉旧 SSRI/classifier 链接来减小 ELF，没有去掉 Campaign 的角色、奖励和扣款验证。
3. 仅 QA 自有 ProtocolLock 的候选升级：保留原 QA TypeID，接入同一严格金融策略。不会消费或覆盖线上/历史共享 Tip、Funding 代码 Cell。

Tip 状态容量不得下降；池总容量只按真实 CKB 奖励扣减，耗尽 token Cell 的存储容量留回池，新增收款 Cell 存储由操作方承担。拒绝未接受 UDT、重定向、错数量、错 Points mint、无净支出、撤权、伪 Registry、状态容量抽走等。NFT 奖励未支持。

### 有效期不是 VM 可信墙上时钟

V2 SSRI 为 `CKBoostTipping.update_tipping(tx, tippingData, declaredAtMsLE8)`。Recipe 精确包含输出引用和 8 字节毫秒时间声明，作为实际签名交易的一部分；不在 draft 末尾先塞可能因新增 input 而移位的任意 witness。

客户端必须在签名前校验最新 Testnet header 与本机时间的新鲜度；候选合约检查声明格式、创建时间、溢出、截止边界和最终 `granted_at` 一致。`0` 在新候选中明确表示 Never。**这是获授权 Admin/Approver 签名声明的应用策略，不是 trustless VM wall clock，也不保证按实际区块包含时刻强制到期。** CKB `since` 是下界锁，任意 HeaderDep 也不是当前时间预言机。最终签名预览必须保留该说明。

## 三、可复核的 release 身份

候选 release：`ckboost-admin-tipping-v1-registry-97e23b14`。

- 当前独立 QA 协议：`0x4eacaf9b1a120d2bfd99f26fcedfdcfe6ef116484e9b478b0a104a872316e034`。
- 编译绑定的完整 Registry state type hash：`0x97e23b14d33e0445c1eac09f1948e2c3652547bfbb7fb7db56978f48baff9690`。
- Registry code 的计划 Type hash：`0x12a5aa7950a17c8b11d28fdffad7c7cdf699811291437ad87826b422392e39d5`。
- 上述 Registry 身份来自固定两阶段 unsigned 计划，**尚不代表该代码/状态已部署或 live**。输入、输出索引或 raw body 改变后，必须重新审阅 TypeID 谱系及编译锚点，不能替换计划后沿用旧 release。

| ELF | 字节数 | CKB data hash |
| --- | ---: | --- |
| TipType | 162,600 | `0x82dfcecb9d7e2ed2c0407a92fbdb0fc793875b747b05510711a9f4d5ef4f7049` |
| FundingLock | 107,184 | `0x62a328ce7a7d0ff273d7696c4bdc43254dd1cb611fdf94fbc2ec3c71f16cc389` |
| QA ProtocolLock | 214,056 | `0xab9aef1ecc866c6d2cca7957b95930fdc4ec11212279796f49517d65db13b649` |
| AdminRegistry | 46,600 | `0x19e35c5c748321bf99de22275e173cefd81278cd33b76d5be1a84136cf638cc7` |

金融候选身份唯一来源为 [release-pins.mjs](../contracts/admin-tipping/release-pins.mjs)，归档 [release-manifest.json](../contracts/admin-tipping/release-manifest.json) 记录源码输入、SHA256、工具链、构建参数、测试日志 hash 和边界。前端不得凭任意环境标志、相同 code hash 前缀或未验证 JSON 启用新能力。

Rust/Cargo/schema 源码指纹为 `c5690d8f5bf06aea6785670003b3f491dcdb4e6691be15ac7578a340cc10864c`。该指纹只覆盖 manifest 列出的输入，不把派生 manifest/pins 循环计入自身；复核时还须核 pins 文件与 manifest 中的独立 hash。

其中包含工作区原有 dirty 的 `contracts/libs/ckboost-shared/src/generated/ckboost.rs`，SHA256 `12e7b1b3ec773c1eb570ce205a7fd065258d4d443feaae914d299ee235d99a3d`，不要求把该既有生成噪声提交。候选还依赖 repo 外 `ckb_deterministic` 固定 commit 和它的 Molecule 0.9.2 生成输出。两份 schema 的精确命令、输出 hash、外部 dirty 范围与交叉编译条件见 [release-build.md](../contracts/admin-tipping/release-build.md)。必须在隔离 staging checkout 准备，不能覆盖当前用户目录；不能声称 clean HEAD 直接 build 即得到相同 pin。

## 四、后续必须按顺序执行的显式升级

下面是待用户最终审阅的操作顺序，**不是已执行记录或自动运行指令**：

1. **再次只读核验基线。** 固定 QA 协议、当前 Admin、旧 QA ProtocolLock 代码所有权和字节、资金输入、Registry 计划锚点及全部旧命名空间；所有依赖、容量、手续费和 raw body 均须 fresh 验证。
2. **Registry 两阶段。** 先由用户显式签名部署新 Registry code，独立确认 committed/live、TypeID、owner、字节及容量；再基于实际 code 与真实 change 输入构造并签名 Registry state 创建交易，确认完整 state type/lock、协议绑定与初始 data。不能把第一阶段的投影 change 当成已存在资金。
3. **三代码同交易批次。** 用户显式审阅新 TipType、新 FundingLock、QA 自有 ProtocolLock 更新；仅消费 QA 自有旧 ProtocolLock 代码输入及已验证 Admin 普通资金。旧 ProtocolLock TypeID 保留，新 Tip/Funding TypeID 分别从固定 input0 与输出索引 1/2 派生。逐输出检查 owner、容量、reviewed ELF、TypeID，确认后才生成代码部署证据。
4. **再次盘点后更新协议配置。** 旧 Tip 记录、旧协议 Funding 池、每个当前规范 Campaign 的旧 Funding 池必须完整扫描且全空；任何非空、分页未完成或读失败都阻止切换，另做迁移方案，不能销毁/重标旧 Cell。通过后，用户显式签名仅更新协议中 Tip/Funding 两个 code identity 与更新时间，保持所有其它字段，确认实际交易和当前数据回读。
5. **明确、本地激活 v4。** 只有代码、Registry state、协议配置均已 confirmed/live 且 runtime 谱系、SDK ABI 和 capability 完整一致，才生成并显式启动本地 v4。构建、Next 与 functions 使用同一验证过的公开配置和独立 distDir；不得默默切换默认 v3，不写共享部署 JSON、`.env.local` 或线上配置。
6. **新能力真实验收。** 分别验证首个 Admin 背书、非 Admin 指定 Approver 后续背书、撤权、到期/Never、真实 UDT/Points/CKB 支付与资金不足等，再记录实际交易证据。VM fixture 通过不能代替这些真实钱包结果。

升级工具入口为 `/revamp/testnet-admin-upgrade` 和只读 `/revamp/testnet-admin-financial-upgrade`。两者只在上述完整 QA 协议的显式 runtime 可用；技术工具不挂载业务 Protocol/Nostr Provider。三代码实际提交与协议更新之后，使用 [只读确认和显式本地 v4 命令](../dapp/scripts/qa-admin.md) 核验完整 raw transactions、父交易和 live cells，成功才写 ignored 的本地 bundle/profile。没有实际交易时不会生成已确认配置，默认 v3 文件保持原样。

只读构造器见 [三代码提案与最小 ProtocolData delta](../dapp/lib/revamp/testnet-admin-financial-upgrade.ts)；Registry 固定计划见 [admin-registry-upgrade-plan.json](../dapp/config/qa/admin-registry-upgrade-plan.json)。这两个文件中的投影交易不是部署确认回执。

User、Campaign、Points、ClaimablePool 的现有代码身份与业务数据保留；现有 Organizer 授权、活动审批、提交/审核记录、已领取资产不因新增 Registry 重新创建。尤其现有 Points 合约已有消费当前配置 Tip 输入的非 Admin mint 路径；本轮用真实 `fcb4…` ELF 做候选 VM 验证，没有升级共享 Points。

## 五、资金只读投影（不是现在要求充值）

公开取样时间为 2026-11-25 07:22:40 UTC，证据文件为本机工作区 `work/audit/admin-2026-11-25/financial-public-2026-11-25T07-23-03.116Z.json`。该文件属于公开只读审计材料，不是链上交易或付款请求。

| 项目 | tCKB |
| --- | ---: |
| 当时 Admin 普通可用容量 | 95,503.58490782 |
| Registry code 存储占用 | 46,728 |
| 初始 Registry state 存储占用 | 386 |
| 三代码批次相对原 QA ProtocolLock 的新增占用 | 300,176 |
| 该批次预留普通 change | 63 |
| 该批次模型手续费 | 0.00484894 |
| 按该固定计划推算尚缺 | **251,849.42042264** |

缺口包含计划中的 Registry 两阶段开销、三代码新增占用、63 tCKB change 和当时模型手续费，是取样时的**投影**，不是固定收费或自动充值要求；尚未最终构造的后续协议配置交易还需单独评估。资金余额、实际输入/找零、手续费率或计划变化后必须重新计算。该提案明确 `funding-required`、`registryStateIsProjectedNotLive=true`、`financialSwitchReady=false`，不能签发。

## 六、测试与复现边界

已独立核验的合约结果：

| 测试集 | 结果 | 含义 |
| --- | --- | --- |
| 金融候选 native policy | 8 tests 通过 | 时间、阈值、角色、数量等纯规则。 |
| Tip 金融 VM | 9 tests / 23 场景通过 | 首审 Admin、后续独立 Approver、真实 Points ELF、UDT/CKB 精确付款及各类恶意变更。 |
| Campaign Funding VM | 3 tests / 4 场景通过 | 瘦身 Funding 仍与真实 Campaign/ProtocolLock/Points 配合；正确奖励通过，错扣款、错角色、错命名空间被实际脚本拒绝。 |
| 金融候选合计 | **20 tests，27 个 VM 场景** | native tests 不计入 27 个 VM 场景。 |
| Registry | **11 native tests + 14 VM tests 通过** | 创建/更新、唯一性、协议与角色、revision、资金净支出，并包含实际 ACP 锁的反例验证。 |

金融 VM 使用真实已公开校验的 `fcb4…` Points、`9004…` Campaign 及现有相关 ELF。钱包和通用 UDT fixture 有明确的 ALWAYS_SUCCESS 简化；不能声称它们验证了真实钱包签名或每种 UDT 实现。Registry 的真实 ACP 验证是另一个测试集，也不能替代新金融流程的公开链端到端验收。

最终集成验证：全量 dapp Jest **128 suites / 1,087 tests 全部通过**，QA 启动、SSRI 桥接和 Admin 命令 **79 项 Node tests 全部通过**；SDK TypeScript 编译和同一 v3 配置的 Next production build 通过。单独 dapp 类型检查仍有原先的 6 项错误：`profile-data.ts` 的两个 BytesLike/string 类型诊断，以及 Netlify `cache-refresh.ts` 的四个 Context 类型诊断；本轮新增模块无类型诊断，不能把 production build 成功说成整个旧项目类型检查通过。

浏览器验收使用无钱包的临时 Chromium，覆盖实际本地 QA 页面；组件 fixture 的多角色、Light/Dark、桌面与窄屏验收不连接钱包或执行签名。最终实际路由多尺寸检查 **39/39 通过**：13 条业务/工具路由分别在 375 Dark、1440 Dark、1920 Light 返回 200，零页面/console 错误、零 HTTP 资源失败、零整页横溢出。两个技术 operator 的 6 个 case 均无业务导航、无外部 RPC；浏览器未连接钱包，所有临时上下文已关闭。结果见本机 `work/audit/admin-2026-11-25/final-browser/evidence.json`。

构建参数记录：Rust/Cargo 1.89.0，RISC-V target `riscv64imac-unknown-none-elf`，`opt-level=s`、LTO、checked overflow，`+zba,+zbb,+zbc,+zbs,-a`，release 去符号并另留 debug ELF。禁用 A 扩展避免 CKB VM 不支持的原子指令。保留两个独立 workspace 的 Cargo.lock，不覆盖历史生成代码或旧 release 文件。

复现入口为 [Registry README](../contracts/admin-registry/README.md)、[金融候选 README](../contracts/admin-tipping/README.md)、[精确 supporting inputs 与构建说明](../contracts/admin-tipping/release-build.md)、[native tests](../contracts/admin-tipping/policy/tests/policy.rs)、[Tip VM](../contracts/admin-tipping/policy/tests/vm_finance.rs)、[Campaign Funding VM](../contracts/admin-tipping/policy/tests/vm_campaign_funding.rs)。必须使用 manifest 指定的锚点、工具链和 reviewed ELF 重新跑同组测试；缺少工具链、公共测试资产或依赖时明确报缺项，不生成“已验证部署”清单。

本机完整产物归档在 `work/testnet-release/admin-tipping/registry-97e23b14/{stripped,debug}`；测试日志在 `work/audit/admin-2026-11-25/tipping-candidate/actual-anchor-tests.log`，由 repo manifest 的 SHA256 绑定。这些工作区文件并非当然随代码仓库分发。

## 七、仍需明确的验收界限

- 五模块实现完成不等于所有状态、角色和金融流程已在公开链跑完；真实未执行部分保持 pending。
- Reward period 不自动付款；成就资格不可证明时保持 unavailable；无来源证明的 claim 不显示可复制交易或 explorer 成功链接。
- Campaign Reject 未定义，不新增假状态、假合约写入或假成功。
- Registry metadata 只保存有界配置，不能覆盖严格二进制金融规则，也不是通用发奖授权。
- 任何旧 Tip/Funding 状态非空都需要独立迁移设计；当前方案没有无损通用 retype/销毁旁路。
- 本记录不发布 PR、不合并、不部署线上、不执行用户签名，也不切换当前默认 QA v3。
