# Windows XP 执行端离线构建环境指南 (build_kit)

本目录包含在 Windows XP (x86 32位) 环境下编译并生成免安装绿色运行包所需的**全部离线安装包与依赖**。目标机器无需连接互联网，直接运行本目录中的脚本即可。

---

## 一、离线安装包清单

| 文件名 | 大小 | 说明 |
| :--- | :--- | :--- |
| `python-3.4.4.msi` | 24.9 MB | 官方 Python 3.4.4 (32-bit x86) 安装包（支持 Windows XP SP3） |
| `pywin32-221.win32-py3.4.exe` | 8.16 MB | 官方 PyWin32 扩展（提供 `win32com` / `win32print`） |
| `PyInstaller-3.2.1.tar.bz2` | 2.44 MB | PyInstaller 3.2.1 源码包（官方最后一个完整支持 XP 的版本） |
| `pefile-2017.11.5.tar.gz` | 61.8 KB | PE 可执行文件结构分析库（PyInstaller 必需依赖） |
| `future-0.16.0.tar.gz` | 824 KB | Python 2/3 兼容垫片库（pefile 与 PyInstaller 必需依赖） |
| `requirements-xp.txt` | 文本 | 离线 pip 安装依赖声明文件 |
| `SHA256SUMS.txt` | 文本 | 各安装包与源码包的 SHA-256 校验和 |

---

## 二、在 Windows XP 上的安装步骤（3步完成）

### 第一步：安装 Python 3.4.4
- 双击运行本目录下的 `1-安装Python3.4.cmd`（或直接双击 `python-3.4.4.msi`）。
- **注意**：安装向导中选择 **"Install for all users"**，并勾选 **"Add python.exe to Path"**（将其加入系统 PATH）。

### 第二步：安装 PyWin32
- 双击运行本目录下的 `2-安装PyWin32.cmd`（或直接双击 `pywin32-221.win32-py3.4.exe`）。
- 按向导默认点击“下一步”直到完成。

### 第三步：安装 PyInstaller 离线包
- 双击运行本目录下的 `3-离线安装PyInstaller.cmd`。
- 脚本会自动调用本地 `pip`，从当前目录离线安装 `future`、`pefile` 及 `PyInstaller 3.2.1`，**完全不需要连接外网**。

---

## 三、打包生成绿色免安装目录

完成上述三步后：
1. 返回上一级目录（`src\worker_xp\`）。
2. 双击运行 `build_xp.bat`。
3. 脚本执行完毕后，将在 `dist\worker_xp\` 目录生成自包含的 Windows XP 绿色免安装运行文件夹。
4. 将该 `dist\worker_xp\` 文件夹压缩打包，即可拷贝到任何其他**完全没有安装 Python 的 XP 电脑**上，直接双击 `StartWorker.cmd` 即可运行。
