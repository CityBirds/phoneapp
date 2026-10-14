# Windows XP (Win32) 独立执行端程序 (src/worker_xp)

> **版本标识**：phoneApp-20261008-XP  
> **适用系统**：Windows XP SP3 (32位) / Windows 7 / Windows 10 / Windows 11  
> **运行环境**：Python 3.4.4 / Python 2.7 绿色版（或 PyInstaller 打包的单文件可执行程序 `worker_xp.exe`）

---

## 一、系统架构与设计原则

现有执行端运行于 Node.js 18+ 环境，在 Windows XP 32 位系统上无法直接运行 Node 18+。本模块为 Windows XP 独立执行端：

1. **物理隔离**：存放在 `src/worker_xp/`，与 Node.js 64位执行端（`src/worker/`）完全解耦，零代码修改，零回归风险。
2. **纯客户端模型**：XP 执行端不监听任何端口，仅作为 HTTP 客户端主动连接协调服务（3001 端口）。
3. **零运行环境依赖**：支持通过 PyInstaller 打包为单文件 `worker_xp.exe` 绿色免安装程序，自带 Python 运行时与依赖。
4. **语法与组件兼容铁律**：
   - 严禁 Python 3.6+ f-strings（`f"..."`），全量使用 `.format()` 或 `%`；
   - 严禁 PowerShell 8+ 命令（如 `Get-PrintJob`、`Get-CimInstance`）；
   - 打印机枚举使用 `win32print` 或 `wmic printer get name`；
   - Word 自动化调用本机已安装的 Office 2003/2007 或 WPS COM 接口。

---

## 二、目录文件说明

```text
src/worker_xp/
├── worker_xp.py          # XP 执行端主程序（HTTP 轮询、心跳保活、目录检查、任务调度、文件回传）
├── word_engine_xp.py     # XP 专用 Word/WPS COM 生成引擎（证书表格逐格回填、保护行校验）
├── printer_engine_xp.py  # XP 专用打印探测与 PrintOut 调用引擎（wmic / win32print / COM）
├── config_manager_xp.py  # 本机身份与配置持久化（读取/写入 worker_config.local.json）
├── build_xp.bat          # XP 下 PyInstaller 单文件绿化打包批处理脚本
└── README.md             # 本部署与使用指南
```

---

## 三、配置与本机身份持久化

配置文件优先级：
1. 命令行参数（`--server <URL>`）
2. 本机身份文件 `worker_config.local.json`
3. 共享配置文件 `worker_config.json`
4. 环境变量（`SERVER_URL` / `WORKER_SERVER_URL` / `WORKER_PORT`）
5. 默认回环地址 `http://localhost:3001`

**注意**：
- 首次运行程序时，系统会自动在根目录或程序所在目录生成 8 位随机 hex 身份（如 `worker-a1b2c3d4`）与 32 位 hex 密钥，保存于 `worker_config.local.json`。
- **严禁将 `worker_config.local.json` 跨机器复制**，确保每台 XP 电脑具有单机唯一身份。

---

## 四、部署与运行指南

### 1. 源码方式运行（环境需求：Python 3.4+ 或 Python 2.7，及 win32com）
```cmd
python src/worker_xp/worker_xp.py --server http://<协调电脑局域网IP>:3001
```

### 2. 参数说明
- `--server <URL>`：指定协调端服务地址（如 `http://192.168.1.183:3001`）。
- `--worker-id <ID>`：手动指定执行端 ID。
- `--name <NAME>`：指定执行端显示名称。
- `--working-dir <PATH>`：指定本地工作目录。
- `--once`：单次运行轮询后退出（自动化测试模式）。

### 3. 构建免安装独立绿色运行包 (`dist\worker_xp\`)
在 Windows XP 实机（或 Python 3.4 32位环境）下：
1. **安装环境**：双击 `一键配置XP编译环境.cmd`（或进入 `build_kit\` 目录依次运行 `1-安装Python3.4.cmd`、`2-安装PyWin32.cmd`、`3-离线安装PyInstaller.cmd`）。
2. **执行打包**：双击运行 `build_xp.bat`。
3. **获取产物**：打包成功后，将在 `dist\worker_xp\` 目录生成免安装绿色独立运行文件夹。将该文件夹打包压缩，拷到任何其他一台完全没装 Python 的 XP 电脑上，直接双击里面的 `StartWorker.cmd` 即可运行。

---

## 五、协议对齐清单

XP 执行端严格实现协调端协议：
- 心跳上报：`POST /api/workers/heartbeat`（携带 `x-worker-id` 与 `x-worker-token` 头）
- 目录检查：`GET /api/worker/directory-checks/pending` & `POST /api/worker/directory-checks/result`
- 路径授权：`GET /api/worker/authorizations`
- 任务领用与成件回传：`GET /api/worker/tasks/pending` & `POST /api/worker/tasks/:id/file-returned` (Multipart/form-data)
- 错误上报：`POST /api/worker/tasks/:id/file-failed`
- 打印任务领用与状态回报：`GET /api/print/pending` & `POST /api/print/:id/status`
