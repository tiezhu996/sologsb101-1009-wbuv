# 燃气调压站巡检与泄漏处置台（sologsb101-1009）

面向燃气公司管网运行与调压站巡检人员，按调压站设备点位配置标准值，逐次录入进出口压力、温度与泄漏浓度并判定异常，对超标点派发泄漏处置单并复检闭环。抢修临时开旁通时可登记旁通作业：按临时安全区间判作业期读数、浓度越安全线立即派单、结束核对后入台账。核心动作：建站与设备、配巡检点位标准值、录巡检读数、判异常分级、派处置单复检、跟踪漏检、旁通作业全流程追溯。

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
        ├── components/common/  # AbnormalTag.tsx BasisTag.tsx FilterBar.tsx StatBadge.tsx EmptyPanel.tsx
        ├── hooks/              # usePatrolGap.ts useIdbTable.ts
        ├── pages/              # StationList.tsx PointConfig.tsx PatrolEntry.tsx BypassBoard.tsx AbnormalBoard.tsx LeakBoard.tsx PlanList.tsx
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
| `/bypass` | 旁通作业（抢修临时开旁通） | BypassWork、Reading、Leak、Point | 负责人登记站点/设备/许可起止/浓度安全线与临时安全区间；同设备有未归档作业禁开；现场录数归入同一作业并按临时区间判级，浓度越线立即派单；结束前核对读数↔泄漏单，台账写入失败保留现场批次、重试只补未完成项；历史作业、判级依据、批次轮次与处置结果全程追溯 |
| `/abnormal` | 异常判定与分级 | Reading、Point | 按关键点权重降序排列；勾选批量确认；浓度类点位一键派发泄漏处置单（旁通作业读数按冻结依据展示、不补派） |
| `/leaks` | 泄漏处置单与复检闭环 | Leak、Device、Reading | 派单 → 填写处置措施与处置人 → 录入复检浓度判合格闭环；导出处置台账 CSV |
| `/plans` | 巡检计划与漏检提醒 | Patrol、Station | 按站点批量生成计划；超期未检自动提醒并按超期天数排序；导出读数台账 CSV 与结构版本 |

## 五、数据存储说明

- **IndexedDB 库名**：`gbgaspress`（Dexie 封装，`src/utils/db.ts`）
- **对象表**：`stations`、`devices`、`points`、`patrols`、`readings`、`leaks`、`bypassworks`
- **数据结构版本**：`DB_VERSION = 3`，含 `version(1)` → `version(2)` → `version(3)` 的索引变更与 `upgrade()` 迁移：v2 补齐 `revision`、回填点位与处置单的 `stationId` 冗余列并重算历史读数；v3 新增旁通作业表，读数补 `bypassWorkId` / `measuredAt` / `judgeBasis`（判级依据快照），泄漏单补 `bypassWorkId` / `sourceReadingId`（幂等派单键），历史读数回填平时标准区间依据并冻结
- **首屏自动播种**：`initDatabase()` 中 `if (await db.stations.count() === 0) await seedDatabase()`，播种 2 座调压站 → 5 台设备 → 11 个点位 → 6 次巡检 → 14 条读数（含旁通作业期读数）→ 4 张泄漏处置单 → 2 张旁通作业（1 进行中 + 1 已归档）的完整链条；播种幂等
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

## 七、判定口径

- 偏差率：读数落在标准区间内为 `0`；越限时按越限幅度相对边界值计算百分比
- 分级：关键点偏差率 `> 5%`、普通点 `> 10%` 判「严重超标」，否则「轻微超标」，区间内为「正常」
- 排序权重：严重超标（关键点 50 / 普通点 30）> 轻微超标（关键点 30 / 普通点 20）> 正常（0）
- 泄漏复检合格阈值：`≤ 50 ppm`
- 漏检判定：计划日期早于今天且实际日期为空

### 旁通作业口径

- 负责人登记：站点、设备、抢修事由、负责人/记录人、许可起止时间、浓度安全线与各点位临时安全区间；**同一设备存在未归档作业时不能再开一条**
- 作业期现场读数归到同一作业下（`readings.bypassWorkId`，`patrolId` 为空），测量时刻必须落在许可窗口内；一律按**临时安全区间**判定并冻结判级依据（`judgeBasis`），许可到期前不能改用平时标准，点位标准值变更也不回改作业期读数（旧读数不会补派泄漏单）
- 浓度类读数越过作业安全线时**立即派发**泄漏处置单，以 `leaks.sourceReadingId` 为幂等键，同一读数只派一张
- 结束作业先核对本次读数与泄漏单：存在越安全线但无处置单的读数时阻断归档；核对通过后生成现场批次写台账，写入失败的条目保留在批次中，重试**只补未完成项**，已写入条目与已派泄漏单不重复处理
- 已归档作业、每条读数的判级依据、关联泄漏单、台账写入轮次与处置结果全部可追溯（页面明细 + 旁通作业台账 CSV 导出）
