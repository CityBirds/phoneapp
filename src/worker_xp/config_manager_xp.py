# -*- coding: utf-8 -*-
"""
Windows XP (Win32) Execution Worker Configuration & Identity Manager.
Compatible with Python 2.7, Python 3.4+, and Python 3.8+.
Strictly NO Python 3.6+ f-strings, NO type hints, NO async/await.
"""

import sys
import os
import json
import random
import string
import shutil
import platform
import struct
import time

def to_unicode(s):
    if s is None:
        return u""
    if sys.version_info[0] < 3:
        if isinstance(s, unicode):
            return s
        try:
            return s.decode('utf-8')
        except Exception:
            try:
                return s.decode('gbk')
            except Exception:
                return s.decode('latin1', 'ignore')
    return str(s)

def safe_str(s):
    """Convert to safe str/bytes for output/stderr without UnicodeEncodeError in Python 2."""
    if s is None:
        return ""
    if sys.version_info[0] < 3:
        if isinstance(s, unicode):
            try:
                enc = sys.stdout.encoding or 'utf-8'
                return s.encode(enc, 'replace')
            except Exception:
                return s.encode('utf-8', 'replace')
        return str(s)
    return str(s)

def generate_random_hex(length):
    chars = "0123456789abcdef"
    return "".join([random.choice(chars) for _ in range(length)])

def _sync_legacy_local_config(old_dir, target_dir):
    old_cfg = os.path.join(old_dir, "worker_config.local.json")
    new_cfg = os.path.join(target_dir, "worker_config.local.json")
    if os.path.exists(old_cfg) and not os.path.exists(new_cfg):
        try:
            shutil.copy2(old_cfg, new_cfg)
        except Exception:
            pass

def get_base_dir():
    env_dir = os.environ.get("PHONEAPP_CONFIG_DIR")
    if env_dir and os.path.exists(env_dir):
        return os.path.abspath(env_dir)

    if getattr(sys, 'frozen', False):
        exe_dir = os.path.dirname(os.path.abspath(sys.executable))
        # Case 1: exe in src/worker_xp/dist inside repository structure
        candidate_repo = os.path.abspath(os.path.join(exe_dir, "..", "..", ".."))
        if os.path.exists(os.path.join(candidate_repo, "src", "worker_xp")) or \
           os.path.exists(os.path.join(candidate_repo, "启动XP执行端.bat")):
            _sync_legacy_local_config(exe_dir, candidate_repo)
            return candidate_repo

        # Case 2: current working directory if it is project root
        cwd = os.path.abspath(os.getcwd())
        if os.path.exists(os.path.join(cwd, "src", "worker_xp")) or \
           os.path.exists(os.path.join(cwd, "启动XP执行端.bat")):
            _sync_legacy_local_config(exe_dir, cwd)
            return cwd

        # Case 3: standalone exe in its own directory
        return exe_dir

    # Source mode: 3 levels up from src/worker_xp/config_manager_xp.py
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

def load_json_file(filepath):
    if not filepath or not os.path.exists(filepath):
        return None
    try:
        with open(filepath, "rb") as f:
            raw = f.read()
        if not raw.strip():
            return None
        text = raw.decode("utf-8")
        return json.loads(text)
    except Exception as e:
        raise ValueError("JSON file %s read or decode error: %s" % (filepath, str(e)))

def save_json_file(filepath, data):
    try:
        dirname = os.path.dirname(filepath)
        if dirname and not os.path.exists(dirname):
            os.makedirs(dirname)
        raw_json = json.dumps(data, indent=2, ensure_ascii=False)
        if sys.version_info[0] < 3:
            if isinstance(raw_json, unicode):
                encoded = raw_json.encode('utf-8')
            else:
                encoded = raw_json
        else:
            encoded = raw_json.encode('utf-8')
        with open(filepath, "wb") as f:
            f.write(encoded)
        return True
    except Exception as e:
        sys.stderr.write("Failed to save config to %s: %s\n" % (filepath, str(e)))
        return False

def parse_cli_args(args=None):
    if args is None:
        args = sys.argv[1:]
    
    parsed = {}
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--server" and i + 1 < len(args):
            parsed["serverUrl"] = args[i + 1]
            i += 2
        elif arg.startswith("--server="):
            parsed["serverUrl"] = arg.split("=", 1)[1]
            i += 1
        elif arg == "--worker-id" and i + 1 < len(args):
            parsed["workerId"] = args[i + 1]
            i += 2
        elif arg.startswith("--worker-id="):
            parsed["workerId"] = arg.split("=", 1)[1]
            i += 1
        elif arg == "--name" and i + 1 < len(args):
            parsed["name"] = args[i + 1]
            i += 2
        elif arg.startswith("--name="):
            parsed["name"] = arg.split("=", 1)[1]
            i += 1
        elif arg == "--working-dir" and i + 1 < len(args):
            parsed["workingDir"] = args[i + 1]
            i += 2
        elif arg.startswith("--working-dir="):
            parsed["workingDir"] = arg.split("=", 1)[1]
            i += 1
        elif arg == "--once":
            parsed["once"] = True
            i += 1
        elif arg == "--diagnose":
            parsed["diagnose"] = True
            i += 1
        elif arg == "--configure":
            parsed["configure"] = True
            i += 1
        elif arg == "--interval" and i + 1 < len(args):
            try:
                parsed["interval"] = float(args[i + 1])
            except ValueError:
                pass
            i += 2
        else:
            i += 1
    return parsed

def load_worker_config(cli_args=None, custom_base_dir=None):
    base_dir = custom_base_dir if custom_base_dir else get_base_dir()
    local_config_path = os.path.join(base_dir, "worker_config.local.json")
    shared_config_path = os.path.join(base_dir, "worker_config.json")
    defaults_config_path = os.path.join(base_dir, "coordinator.defaults.json")

    cli_parsed = parse_cli_args(cli_args) if cli_args is not None else parse_cli_args()

    local_data = None
    if os.path.exists(local_config_path):
        try:
            local_data = load_json_file(local_config_path)
        except Exception as e:
            sys.stderr.write("[配置错误] 本机配置文件已损坏或不可读: %s (%s)\n" % (local_config_path, str(e)))
            raise RuntimeError("本机配置文件损坏或不可读: %s (XP-L06)" % local_config_path)
    if local_data is None:
        local_data = {}

    shared_data = None
    if os.path.exists(shared_config_path):
        try:
            shared_data = load_json_file(shared_config_path)
        except Exception as e:
            sys.stderr.write("[配置警告] 共享配置文件读取异常: %s (%s)\n" % (shared_config_path, str(e)))
            shared_data = {}
    if shared_data is None:
        shared_data = {}

    defaults_data = None
    if os.path.exists(defaults_config_path):
        try:
            defaults_data = load_json_file(defaults_config_path)
        except Exception as e:
            sys.stderr.write("[配置警告] 现场默认配置读取异常: %s (%s)\n" % (defaults_config_path, str(e)))
            defaults_data = {}
    if defaults_data is None:
        defaults_data = {}

    # Safety check (方案§1): coordinator.defaults.json must NOT contain identity credentials
    if defaults_data.get("workerSecret") or defaults_data.get("workerId"):
        sys.stderr.write("[安全警告] coordinator.defaults.json 严禁携带终端身份与密钥，已忽略其携带的凭据信息！(方案§1)\n")
        if "workerSecret" in defaults_data:
            del defaults_data["workerSecret"]
        if "workerId" in defaults_data:
            del defaults_data["workerId"]

    sources = {
        "server": "default",
        "workerId": "generated",
        "workerSecret": "generated",
        "name": "default",
        "workingDir": "default",
        "allowedPrinters": "default"
    }

    # 1. workerId & workerSecret persistence
    saved_on_machine = os.path.exists(local_config_path) and bool(local_data.get("workerId"))
    identity_generated = False

    if cli_parsed.get("workerId"):
        worker_id = cli_parsed["workerId"]
        sources["workerId"] = "cli"
    elif local_data.get("workerId"):
        worker_id = local_data["workerId"]
        sources["workerId"] = "local_file"
    else:
        worker_id = "worker-" + generate_random_hex(8)
        identity_generated = True
        sources["workerId"] = "generated"

    if local_data.get("workerSecret"):
        worker_secret = local_data["workerSecret"]
        sources["workerSecret"] = "local_file"
    else:
        worker_secret = generate_random_hex(32)
        sources["workerSecret"] = "generated"

    # 2. serverUrl priority: CLI > local_file > env > env_port > defaults_file > default (127.0.0.1:3001)
    # REV183 §3.1: shared_config.json's serverUrl is deliberately ignored because it is distributed
    # with installation packages and would cause multiple machines to connect to the wrong host.
    server_url = None
    explicit_remote = False

    if cli_parsed.get("serverUrl"):
        server_url = cli_parsed["serverUrl"]
        sources["server"] = "cli"
        explicit_remote = True
    elif local_data.get("serverUrl"):
        server_url = local_data["serverUrl"]
        sources["server"] = "local_file"
        explicit_remote = True
    else:
        env_server = os.environ.get("PHONEAPP_SERVER") or os.environ.get("COORDINATOR_SERVER") or os.environ.get("SERVER_URL") or os.environ.get("WORKER_SERVER_URL")
        env_port = os.environ.get("WORKER_PORT") or os.environ.get("INTERNAL_PORT")
        if env_server:
            server_url = env_server
            sources["server"] = "env"
            explicit_remote = True
        elif env_port:
            server_url = "http://127.0.0.1:" + str(env_port)
            sources["server"] = "env_port"
        elif defaults_data.get("serverUrl"):
            server_url = defaults_data["serverUrl"]
            sources["server"] = "defaults_file"
            explicit_remote = True
        else:
            server_url = "http://127.0.0.1:3001"
            sources["server"] = "default"

    # Warn if shared config contains serverUrl (REV183 §3.1)
    env_any = os.environ.get("PHONEAPP_SERVER") or os.environ.get("COORDINATOR_SERVER") or os.environ.get("SERVER_URL") or os.environ.get("WORKER_SERVER_URL")
    if shared_data.get("serverUrl") and not local_data.get("serverUrl") and not cli_parsed.get("serverUrl") and not env_any and not defaults_data.get("serverUrl"):
        sys.stderr.write("[配置] 共享配置 %s 里存在 serverUrl，但该文件会随安装包分发，已忽略；请在本机保存连接地址 (REV183 §3.1)。\n" % shared_config_path)

    # Normalize server URL (remove trailing slash)
    if server_url and server_url.endswith("/"):
        server_url = server_url[:-1]

    # 3. Name priority
    if cli_parsed.get("name"):
        name = to_unicode(cli_parsed["name"])
        sources["name"] = "cli"
    elif local_data.get("name"):
        name = to_unicode(local_data["name"])
        sources["name"] = "local_file"
    elif shared_data.get("name"):
        name = to_unicode(shared_data["name"])
        sources["name"] = "shared_file"
    else:
        name = u"XP执行终端 (" + to_unicode(worker_id) + u")"
        sources["name"] = "default"

    # 4. Working Dir priority
    default_working_dir = os.path.join(base_dir, "data", "worker_files")
    if cli_parsed.get("workingDir"):
        working_dir = cli_parsed["workingDir"]
        sources["workingDir"] = "cli"
    elif local_data.get("workingDir"):
        working_dir = local_data["workingDir"]
        sources["workingDir"] = "local_file"
    elif shared_data.get("workingDir"):
        working_dir = shared_data["workingDir"]
        sources["workingDir"] = "shared_file"
    else:
        working_dir = default_working_dir
        sources["workingDir"] = "default"

    working_dir = os.path.abspath(working_dir)

    # 5. Allowed Printers
    allowed_printers = []
    if local_data.get("allowedPrinters"):
        allowed_printers = local_data["allowedPrinters"]
        sources["allowedPrinters"] = "local_file"
    elif shared_data.get("allowedPrinters"):
        allowed_printers = shared_data["allowedPrinters"]
        sources["allowedPrinters"] = "shared_file"

    # Auto-save identity to worker_config.local.json if not present or updated
    needs_save = False
    updated_local_data = dict(local_data)

    if not local_data.get("workerId") or local_data.get("workerId") != worker_id:
        updated_local_data["workerId"] = worker_id
        needs_save = True

    if not local_data.get("workerSecret") or local_data.get("workerSecret") != worker_secret:
        updated_local_data["workerSecret"] = worker_secret
        needs_save = True

    if cli_parsed.get("serverUrl") and local_data.get("serverUrl") != cli_parsed["serverUrl"]:
        updated_local_data["serverUrl"] = cli_parsed["serverUrl"]
        needs_save = True

    if needs_save:
        save_ok = save_json_file(local_config_path, updated_local_data)
        saved_on_machine = bool(save_ok)
        if not save_ok:
            sys.stderr.write("[配置警告] 本机身份未能持久化保存到 %s (只读或权限不足)\n" % local_config_path)

    return {
        "workerId": worker_id,
        "workerSecret": worker_secret,
        "name": name,
        "serverUrl": server_url,
        "workingDir": working_dir,
        "allowedPrinters": allowed_printers,
        "configPaths": {
            "local": local_config_path,
            "shared": shared_config_path
        },
        "sources": sources,
        "identityGenerated": identity_generated,
        "explicitRemote": explicit_remote,
        "diagnose": cli_parsed.get("diagnose", False),
        "configure": cli_parsed.get("configure", False),
        "defaultsPath": defaults_config_path,
        "savedOnThisMachine": saved_on_machine,
        "once": cli_parsed.get("once", False),
        "interval": cli_parsed.get("interval", 3.0)
    }

def check_server_connectivity(url, timeout=3):
    try:
        try:
            import urllib.request as urllib_req
            import urllib.error as urllib_err
        except ImportError:
            import urllib2 as urllib_req
            import urllib2 as urllib_err

        probe_url = url.rstrip('/') + "/api/health"
        req = urllib_req.Request(probe_url)
        t0 = time.time()
        res = urllib_req.urlopen(req, timeout=timeout)
        code = res.getcode()
        duration = round((time.time() - t0) * 1000, 1)
        return True, "HTTP %s (%sms)" % (code, duration)
    except Exception as e:
        return False, str(e)

def run_diagnose_checks(custom_base_dir=None, cli_args=None):
    cfg = load_worker_config(cli_args, custom_base_dir)
    base_dir = custom_base_dir if custom_base_dir else get_base_dir()

    print("====================================================")
    print("  Windows XP (Win32) Worker Diagnostic Check")
    print("  XP 执行端环境只读自检与诊断模式 (方案§4, §7)")
    print("====================================================")

    # 1. OS & Runtime
    is_frozen = getattr(sys, 'frozen', False)
    bits = struct.calcsize("P") * 8
    os_desc = "%s %s (%s)" % (platform.system(), platform.release(), platform.version())
    print("[1] 操作系统与运行环境:")
    print("    - 操作系统: %s" % safe_str(os_desc))
    print("    - 指针位数: %s-bit" % bits)
    print("    - Python版本: %s" % sys.version.split()[0])
    print("    - 打包运行态: %s" % ("Frozen (worker_xp.exe)" if is_frozen else "Source (Python源码)"))
    print("    - 程序路径: %s" % safe_str(sys.executable))

    # 2. Paths & Permissions
    data_dir = os.path.join(base_dir, "data")
    log_dir = os.path.join(base_dir, "logs")
    test_file = os.path.join(data_dir, ".write_test_%s.tmp" % generate_random_hex(4))
    write_ok = False
    write_err = None
    try:
        if not os.path.exists(data_dir):
            os.makedirs(data_dir)
        with open(test_file, "wb") as f:
            f.write(b"OK")
        if os.path.exists(test_file):
            os.remove(test_file)
        write_ok = True
    except Exception as we:
        write_err = str(we)

    print("[2] 目录与读写权限:")
    print("    - 基准目录: %s" % safe_str(base_dir))
    print("    - 数据目录: %s" % safe_str(data_dir))
    print("    - 日志目录: %s" % safe_str(log_dir))
    print("    - 本地数据写权限: %s" % ("OK (可写)" if write_ok else "FAIL: %s" % safe_str(write_err)))

    # 3. Identity & Config (Strictly Desensitized)
    print("[3] 终端身份与配置 (严格脱敏):")
    print("    - 终端 ID: %s" % safe_str(cfg["workerId"]))
    print("    - 密钥状态: %s" % ("[已配置, 长度=%s]" % len(cfg.get("workerSecret", "")) if cfg.get("workerSecret") else "[未配置]"))
    print("    - 协调端地址: %s (来源: %s)" % (safe_str(cfg["serverUrl"]), cfg["sources"].get("server")))
    print("    - 本机配置文件: %s (%s)" % (
        safe_str(cfg["configPaths"]["local"]),
        "已存在且已持久化" if cfg.get("savedOnThisMachine") else "未持久化/内存模式"
    ))
    if os.path.exists(cfg["defaultsPath"]):
        print("    - 现场默认配置: %s (存在)" % safe_str(cfg["defaultsPath"]))
    else:
        print("    - 现场默认配置: %s (不存在，可创建用于预设地址)" % safe_str(cfg["defaultsPath"]))

    # 4. Office / COM Support
    print("[4] 办公组件与 COM 自动化 (生成/打印依赖):")
    com_available = False
    try:
        import win32com.client
        com_available = True
    except ImportError:
        pass

    if not com_available:
        print("    - win32com: 未安装或不可用 (无法使用Word/WPS进行成件生成与打印)")
    else:
        print("    - win32com: 可用")
        for prog_id in ["KWps.Application", "Wps.Application", "Word.Application"]:
            app = None
            try:
                app = win32com.client.Dispatch(prog_id)
                print("    - %s: 探测成功" % prog_id)
            except Exception as ce:
                print("    - %s: 不可用 (%s)" % (prog_id, safe_str(ce)))
            finally:
                if app is not None:
                    try:
                        app.Quit()
                    except Exception:
                        pass

    # 5. Printers
    print("[5] 系统打印机检测:")
    try:
        from printer_engine_xp import get_installed_printers_xp
        printers = get_installed_printers_xp()
        if printers:
            for p in printers:
                print("    - 打印机: %s" % safe_str(p))
        else:
            print("    - (未检测到任何本地或共享打印机)")
    except Exception as pe:
        print("    - 打印机探测异常: %s" % safe_str(pe))

    # 6. Network connectivity
    print("[6] 协调服务连通性测试:")
    print("    - 目标地址: %s" % safe_str(cfg["serverUrl"]))
    conn_ok, conn_msg = check_server_connectivity(cfg["serverUrl"])
    print("    - 连接状态: %s (%s)" % ("ONLINE" if conn_ok else "OFFLINE/UNREACHABLE", safe_str(conn_msg)))
    print("====================================================")
    print("自检完成。如遇故障请将上述信息提供给系统管理员。")
    return {
        "os": os_desc,
        "bits": bits,
        "isFrozen": is_frozen,
        "writeOk": write_ok,
        "workerId": cfg["workerId"],
        "serverUrl": cfg["serverUrl"],
        "serverSource": cfg["sources"].get("server"),
        "connectivity": conn_ok,
        "connectivityMsg": conn_msg
    }

def run_interactive_configure(custom_base_dir=None, cli_args=None, input_prompt_fn=None):
    cfg = load_worker_config(cli_args, custom_base_dir)
    local_cfg_path = cfg["configPaths"]["local"]

    print("====================================================")
    print("  XP 执行端协调服务连接配置 (Configure Mode)")
    print("====================================================")
    current_url = cfg["serverUrl"]
    print("当前已配置的协调服务地址: %s" % safe_str(current_url))

    prompt_msg = "请输入新的协调服务地址 (直接回车保持不变): "
    if input_prompt_fn:
        new_url = input_prompt_fn(prompt_msg)
    else:
        try:
            if sys.version_info[0] < 3:
                new_url = raw_input(prompt_msg)
            else:
                new_url = input(prompt_msg)
        except (KeyboardInterrupt, EOFError):
            print("\n已取消配置。")
            return 1

    new_url = (new_url or "").strip()
    if new_url:
        if not (new_url.startswith("http://") or new_url.startswith("https://")):
            print("[错误] 地址必须以 http:// 或 https:// 开头！")
            return 1
        new_url = new_url.rstrip("/")
        local_data = {}
        if os.path.exists(local_cfg_path):
            try:
                local_data = load_json_file(local_cfg_path) or {}
            except Exception:
                local_data = {}
        local_data["serverUrl"] = new_url
        if not local_data.get("workerId"):
            local_data["workerId"] = cfg["workerId"]
        if not local_data.get("workerSecret"):
            local_data["workerSecret"] = cfg["workerSecret"]

        if save_json_file(local_cfg_path, local_data):
            print("[成功] 协调服务地址已更新并保存到: %s" % safe_str(local_cfg_path))
            print("新的协调服务地址: %s" % safe_str(new_url))
            print("正在测试连接...")
            conn_ok, conn_msg = check_server_connectivity(new_url)
            print("连接测试结果: %s (%s)" % ("成功" if conn_ok else "失败", safe_str(conn_msg)))
            return 0
        else:
            print("[错误] 保存配置文件失败，请检查写入权限！")
            return 1
    else:
        print("保持当前地址不变: %s" % safe_str(current_url))
        return 0

if __name__ == "__main__":
    cli = parse_cli_args()
    if cli.get("diagnose"):
        run_diagnose_checks()
    elif cli.get("configure"):
        run_interactive_configure()
    else:
        cfg = load_worker_config()
        print("Loaded Config:")
        print("  Worker ID: " + safe_str(cfg["workerId"]))
        print("  Server URL: " + safe_str(cfg["serverUrl"]))
        print("  Name: " + safe_str(cfg["name"]))
        print("  Working Dir: " + safe_str(cfg["workingDir"]))
        print("  Local Config Path: " + safe_str(cfg["configPaths"]["local"]))
