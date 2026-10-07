# 燃气调压站巡检与泄漏处置台（sologsb101-1009）

面向燃气公司管网运行与调压站巡检人员，按调压站设备点位配置标准值，逐次录入进出口压力、温度与泄漏浓度并判定异常，对超标点派发泄漏处置单并复检闭环。另支持调压站抢修**临时开旁通作业**：负责人登记站点、设备、起止时间与临时安全区间，作业期读数归到同一作业并按临时区间判定，浓度越线立即派单，结束先核对台账、写入失败保留现场批次只补未完成部分。核心动作：建站与设备、配巡检点位标准值、录巡检读数、判异常分级、派处置单复检、**旁通作业临时安全区间管控**、跟踪漏检。

> 纯前端单页应用（SPA）：**无后端 / 无数据库服务 / 无 API**，全部数据保存在浏览器本地 IndexedDB。

## 一、Docker 一键启动（推荐）

在项目根目录（本 README 所在目录）执行：

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22809**

常用运维命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并删除容器
docker compose up -d --build      # 改代码后重新构建启动
```

如需更换宿主端口，修改 `.env` 中的 `FRONTEND_PORT` 后重新 `docker compose up -d`。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | React 18.3 | 函数组件 + Hooks |
| 语言 | TypeScript 5.7 | `strict` 严格模式，构建前执行 `tsc --noEmit` |
| UI 组件 | Arco Design 2.66 | 表格、表单、Modal、Tag、Badge、Progress |
| 状态管理 | Zustand 4.5 | `stationStore` / `patrolStore` / `leakStore` / `bypassStore`（模块级 liveQuery 订阅回流） |
| 路由 | React Router 6.28 | `createBrowserRouter`，nginx `try_files` 回退 |
| 本地持久化 | Dexie 4（IndexedDB） | 版本号 + `upgrade` 迁移 + 幂等播种 |
| 构建 | Vite 6 | 输出 `dist/`，按路由自动分包 |
| 运行 | nginx:alpine | 静态托管 + gzip + SPA 回退 |

## 三、目录结构

```
sologsb101-1009/
├── README.md
├── docker-compose.yml          # 不写 version；顶层 name: gbgaspress
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html + gzip
    ├── .dockerignore
    ├── package.json / tsconfig.json / vite.config.ts / index.html
    ├── public/favicon.svg
    └── src/
        ├── types/              # station.ts device.ts point.ts patrol.ts reading.ts leak.ts bypass.ts
        ├── stores/             # stationStore.ts patrolStore.ts leakStore.ts bypassStore.ts
        ├── components/common/  # AbnormalTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
        ├── hooks/              # usePatrolGap.ts useIdbTable.ts
        ├── pages/              # StationList.tsx PointConfig.tsx PatrolEntry.tsx AbnormalBoard.tsx BypassBoard.tsx LeakBoard.tsx PlanList.tsx
        ├── router/index.tsx
        ├── utils/              # range.ts db.ts export.ts
        ├── styles/main.css
        ├── App.tsx
        └── main.tsx
```

## 四、页面与路由

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/stations` | 调压站与设备台账 | Station、Device | 新建/编辑/删除站点与设备；按压力等级与设备类型筛选；卡片回显设备数、待处置泄漏数与漏检次数 |
| `/points` | 巡检点位与标准值配置 | Point、Device | 维护点位上下限/单位/关键点标记（草稿 → 逐条/批量提交并重算历史读数）；按模板批量复制标准值 |
| `/patrols` | 巡检录入 | Patrol、Reading、Point | 选定任务后逐点录入读数，实时偏差率与异常级别；逐点或整批保存；完成巡检、标记漏检、现场备注 |
| `/abnormal` | 异常判定与分级 | Reading、Point | 按关键点权重降序排列；勾选批量确认；浓度类点位一键派发泄漏处置单 |
| `/bypasses` | 旁通作业（抢修临时开旁通） | Bypass、Reading、Leak、Point | 负责人登记站点/设备/起止时间/临时安全区间（同设备未归档互斥）；现场记录人把作业期读数归到同一作业，按临时区间判定、越线立即派单；结束先核对读数与泄漏单，台账失败保留现场批次并只补未完成部分重试 |
| `/leaks` | 泄漏处置单与复检闭环 | Leak、Device、Reading | 派单 → 填写处置措施与处置人 → 录入复检浓度判合格闭环；导出处置台账 CSV |
| `/plans` | 巡检计划与漏检提醒 | Patrol、Station | 按站点批量生成计划；超期未检自动提醒并按超期天数排序；导出读数台账 CSV 与结构版本 |

## 五、数据存储说明

- **IndexedDB 库名**：`gbgaspress`（Dexie 封装，`src/utils/db.ts`）
- **对象表**：`stations`、`devices`、`points`、`patrols`、`readings`、`leaks`、`bypasses`
- **数据结构版本**：`DB_VERSION = 3`，含 `version(1)` → `version(2)` → `version(3)` 的索引变更与 `upgrade()` 迁移：v2 补齐 `revision`、回填点位/处置单 `stationId` 冗余列并按标准区间重算历史读数；v3 新增 `bypasses` 表，读数补作业归属（`bypassId`）、判级依据（`judgeBasis`）、判定区间快照（`judgeMin/judgeMax`）、记录时刻/记录人、台账状态与泄漏单回填（`leakId`），泄漏单补作业来源（`bypassId`）、来源读数（`sourceReadingId`）与判据，历史数据统一按平时标准区间回填
- **首屏自动播种**：`initDatabase()` 中 `if (await db.stations.count() === 0) await seedDatabase()`，播种 2 座调压站 → 5 台设备 → 11 个点位 → 6 次巡检 → 13 条读数（含 2 条旁通作业现场批次）→ 4 张泄漏处置单（含 1 张旁通越线立即派单）→ 1 条已归档旁通作业的完整父子孙链条；播种幂等
- **localStorage 辅助键**：`gbgaspress:db-version`、`gbgaspress:last-backup-at`、`gbgaspress:ui-prefs`
- 应用为**无状态容器**：数据不落容器磁盘、不使用数据库服务、不挂载命名卷

## 六、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22809
npm run build      # tsc --noEmit && vite build（类型检查 + 生产构建）
npm run preview    # 本地预览构建产物
```

旁通作业核心流程（互斥、临时区间判定、越线立即派单、台账失败只补未完成部分重试、幂等不重复派单）可用内存 IndexedDB 跑冒烟断言：

```bash
cd frontend
npx tsx --tsconfig tsconfig.json scripts/bypass.smoke.ts   # 需临时依赖 fake-indexeddb、tsx
```

## 七、判定口径

- 偏差率：读数落在标准区间内为 `0`；越限时按越限幅度相对边界值计算百分比
- 分级：关键点偏差率 `> 5%`、普通点 `> 10%` 判「严重超标」，否则「轻微超标」，区间内为「正常」
- 排序权重：严重超标（关键点 50 / 普通点 30）> 轻微超标（关键点 30 / 普通点 20）> 正常（0）
- 泄漏复检合格阈值：`≤ 50 ppm`
- 漏检判定：计划日期早于今天且实际日期为空

## 八、旁通作业判定口径（抢修临时开旁通）

- **登记与互斥**：负责人登记站点、设备、起止时间、临时安全区间（上下限 + 单位）与现场记录人；同一设备存在「进行中 / 待归档」未归档作业时禁止再开一条
- **作业期判定**：作业窗口（开始 ~ 许可截止）内现场记录人登记的读数归到同一作业，一律按临时安全区间判定，并把判据（`临时安全区间`）与所用上下限快照随读数留存；许可到期前不能改用平时标准，平时标准值变更的批量重算也不会覆盖作业期读数
- **越线立即派单**：作业期浓度高于临时安全线上限即当场派发「待处置」泄漏单，处置单记录来源作业、来源读数与临时区间判据，并把处置单 id 回填读数；作业结束后不会因旧读数再补派
- **结束核对**：结束作业先核对本次作业期读数与泄漏单（条数、异常数、越线数），填写处置结果后写台账
- **台账失败重试（只补未完成）**：写入失败时作业置「待归档」、现场批次读数全部保留；重试仅把仍为「现场批次」的读数补入账、为读数 `leakId` 已不存在处置单的越线读数补派单，已入账/已派单不重复处理；支持重复重试，归档后调用幂等
- **可追溯**：历史作业单、每条读数的判级依据与判定区间、每张泄漏单来源，以及处置结果均可在「旁通作业」页与读数/泄漏/旁通台账 CSV 中追溯
