# -*- coding: utf-8 -*-
"""
Windows XP (Win32) Standalone Execution Worker Main Client.
Compatible with Python 2.7, Python 3.4+, and Python 3.8+.
Strictly NO Python 3.6+ f-strings, NO type hints, NO async/await.
Pure HTTP client: listes on NO inbound ports.
"""

import sys
import os
import json
import time
import random
import hashlib
import stat
import re

try:
    import urllib.request as urllib_req
    import urllib.parse as urllib_parse
    import urllib.error as urllib_err
except ImportError:
    import urllib2 as urllib_req
    import urllib as urllib_parse
    import urllib2 as urllib_err

from config_manager_xp import (
    load_worker_config, generate_random_hex, to_unicode, safe_str,
    parse_cli_args, run_diagnose_checks, run_interactive_configure
)
import poa200_protocol_xp as poa200_xp

string_types = (str, unicode) if sys.version_info[0] < 3 else (str,)

from printer_engine_xp import get_installed_printers_xp, is_printer_allowed_xp, print_document_xp
from word_engine_xp import generate_word_document_xp, get_file_sha256

def is_subpath(parent, child):
    try:
        real_parent = os.path.realpath(os.path.abspath(parent))
        real_child = os.path.realpath(os.path.abspath(child))
        return real_child == real_parent or real_child.startswith(real_parent + os.sep)
    except Exception:
        return False

def http_request(url, method="GET", headers=None, body=None, timeout=10):
    if headers is None:
        headers = {}
    
    req_headers = dict(headers)
    req_data = None

    if body is not None:
        if isinstance(body, (dict, list)):
            req_data = json.dumps(body, ensure_ascii=False).encode('utf-8')
            if 'Content-Type' not in req_headers:
                req_headers['Content-Type'] = 'application/json; charset=utf-8'
        elif isinstance(body, (bytes, bytearray)):
            req_data = body
        elif isinstance(body, string_types):
            req_data = to_unicode(body).encode('utf-8')

    try:
        req = urllib_req.Request(url, data=req_data, headers=req_headers, method=method)
    except TypeError:
        req = urllib_req.Request(url, data=req_data, headers=req_headers)
        req.get_method = lambda: method

    try:
        response = urllib_req.urlopen(req, timeout=timeout)
        status_code = response.getcode()
        resp_headers = response.headers if hasattr(response, 'headers') else response.info()
        content = response.read()
        return status_code, resp_headers, content, None
    except urllib_err.HTTPError as e:
        content = e.read() if hasattr(e, 'read') else b""
        return e.code, e.headers if hasattr(e, 'headers') else e.info(), content, e
    except Exception as e:
        return 0, {}, b"", e

class ExecutionWorkerXP(object):
    def __init__(self, cli_args=None):
        self.config = load_worker_config(cli_args)
        self.worker_id = self.config["workerId"]
        self.worker_secret = self.config["workerSecret"]
        self.name = self.config["name"]
        self.server_url = self.config["serverUrl"]
        self.working_dir = self.config["workingDir"]
        self.allowed_printers = self.config["allowedPrinters"] or get_installed_printers_xp()
        self.once = self.config["once"]
        self.interval = self.config["interval"]
        self.enable_test_mock = bool(self.config.get("enableTestMock") or os.environ.get("W610_TEST_MOCK") == "1")

        if not os.path.exists(self.working_dir):
            try:
                os.makedirs(self.working_dir)
            except Exception:
                pass

        self._connected = None

    def auth_headers(self, extra=None):
        h = {
            "x-worker-id": safe_str(self.worker_id),
            "x-worker-token": safe_str(self.worker_secret)
        }
        if extra:
            h.update(extra)
        return h

    def send_heartbeat(self):
        url = self.server_url + "/api/workers/heartbeat"
        payload = {
            "workerId": safe_str(self.worker_id),
            "name": to_unicode(self.name),
            "workingDir": to_unicode(self.working_dir),
            "printers": [to_unicode(p) for p in self.allowed_printers],
            "status": "ONLINE",
            "inboundServices": "none"
        }
        status_code, headers, content, err = http_request(
            url, method="POST", headers=self.auth_headers({"Content-Type": "application/json; charset=utf-8"}), body=payload
        )

        if err and status_code == 0:
            if self._connected is not False:
                sys.stderr.write(safe_str(u"[连接失败] 目标 %s —— %s\n" % (to_unicode(self.server_url), to_unicode(err))))
                self._connected = False
            return None

        if status_code != 200:
            if self._connected is not False:
                sys.stderr.write(safe_str(u"[心跳失败] HTTP %d (目标 %s)\n" % (status_code, to_unicode(self.server_url))))
                self._connected = False
            return None

        try:
            data = json.loads(content.decode('utf-8'))
        except Exception:
            return None

        if data.get("success") is True and data.get("workerId") == self.worker_id:
            if self._connected is not True:
                print(safe_str(u"[成功] 已连接协调服务 (%s)！状态: ONLINE，终端ID: %s" % (to_unicode(self.server_url), to_unicode(self.worker_id))))
                self._connected = True
            return data
        else:
            self._connected = False
            return None

    def fetch_authorizations(self):
        url = self.server_url + "/api/worker/authorizations?workerId=" + urllib_parse.quote(safe_str(self.worker_id))
        status_code, headers, content, err = http_request(url, method="GET", headers=self.auth_headers())
        if status_code != 200 or err:
            return {"ok": False, "reason": "HTTP %d: %s" % (status_code, str(err) if err else "Request failed")}
        try:
            data = json.loads(content.decode('utf-8'))
            return {
                "ok": True,
                "allowedPaths": data.get("allowedPaths") or []
            }
        except Exception as e:
            return {"ok": False, "reason": "JSON decode error: " + str(e)}

    def ensure_write_authorized(self, target_path, root_dir):
        auth = self.fetch_authorizations()
        if not auth["ok"]:
            raise ValueError("无法获取执行端授权路径: %s" % auth["reason"])

        allowed_paths = auth["allowedPaths"]
        write_allowed = [ap for ap in allowed_paths if ap.get("allow_write")]

        if not write_allowed:
            raise ValueError("执行端当前未配置任何允许写入的路径 (E04, WC-08)")

        # Verify target_path is within root_dir
        if not is_subpath(root_dir, target_path):
            raise ValueError("任务目标保存目录超出设定的根目录边界 (DIR-15)")

        # Verify root_dir is within an authorized root
        authorized = any(is_subpath(ap.get("root_path", ""), root_dir) for ap in write_allowed)
        if not authorized:
            raise ValueError("保存目录 [%s] 未在协调端授权列表中 (E04, WC-08)" % root_dir)

    def poll_and_execute_directory_checks(self):
        url = self.server_url + "/api/worker/directory-checks/pending?workerId=" + urllib_parse.quote(safe_str(self.worker_id))
        status_code, headers, content, err = http_request(url, method="GET", headers=self.auth_headers())
        if status_code != 200 or not content:
            return

        try:
            checks = json.loads(content.decode('utf-8'))
        except Exception:
            return

        for check in checks:
            self.execute_directory_check(check)

    def execute_directory_check(self, check):
        root_dir = check.get("root_dir")
        check_type = check.get("check_type", "save_config")
        allow_create = bool(check.get("allow_create", True))
        allow_write = bool(check.get("allow_write", True))

        status = "PASSED"
        message = "检查通过，目录可写"

        if not root_dir or not isinstance(root_dir, string_types):
            status = "FAILED"
            message = "保存路径不能为空"
        else:
            is_abs = os.path.isabs(root_dir) or (len(root_dir) >= 2 and root_dir[1] == ':')
            if not is_abs:
                status = "FAILED"
                message = u"路径不是合法的绝对路径: " + to_unicode(root_dir)
            elif check_type == "save_config":
                auth = self.fetch_authorizations()
                if not auth["ok"]:
                    status = "FAILED"
                    message = u"无法确认执行端当前有效授权（%s），检查不予通过 (4.2, WC-18)" % to_unicode(auth["reason"])
                else:
                    write_roots = [ap for ap in auth["allowedPaths"] if ap.get("allow_write")]
                    if not write_roots:
                        status = "FAILED"
                        message = "执行端当前没有任何允许写入的业务路径，保存目录未获授权 (E04, WC-08)"
                    elif not any(is_subpath(ap.get("root_path", ""), root_dir) for ap in write_roots):
                        status = "FAILED"
                        message = "保存目录未在允许访问的业务路径范围内 (E04, WC-08)"

            if status == "PASSED" and not os.path.exists(root_dir):
                if not allow_create:
                    status = "FAILED"
                    message = u"根目录不存在，且未勾选允许创建: %s (DIR-09, WC-10)" % to_unicode(root_dir)
                else:
                    try:
                        os.makedirs(root_dir)
                    except Exception as mErr:
                        status = "FAILED"
                        message = u"创建根目录失败: %s (DIR-10)" % to_unicode(mErr)

        if status == "PASSED" and allow_write:
            probe_file = os.path.join(root_dir, ".write_probe_%d_%s.tmp" % (int(time.time()), generate_random_hex(6)))
            try:
                if os.path.exists(probe_file):
                    os.remove(probe_file)
                with open(probe_file, "w") as f:
                    f.write("probe")
                with open(probe_file, "r") as f:
                    r_text = f.read()
                if r_text != "probe":
                    raise ValueError("探测文件校验失败")
            except Exception as err:
                status = "FAILED"
                message = u"目录不可写或权限不足: %s (DIR-11)" % to_unicode(err)
            finally:
                if os.path.exists(probe_file):
                    try:
                        os.remove(probe_file)
                    except Exception:
                        pass

        result_url = self.server_url + "/api/worker/directory-checks/result"
        result_payload = {
            "checkId": check.get("id"),
            "workerId": self.worker_id,
            "checkType": check_type,
            "targetId": check.get("target_id") or check.get("config_id"),
            "configId": check.get("config_id") or check.get("target_id"),
            "version": check.get("version"),
            "status": status,
            "message": to_unicode(message)
        }
        http_request(result_url, method="POST", headers=self.auth_headers({"Content-Type": "application/json"}), body=result_payload)

    def fetch_template_for_task(self, model, file_type, template_id=None, template_hash=None, task=None, file_rec=None):
        cache_dir = os.path.join(self.working_dir, "cached_templates")
        if not os.path.exists(cache_dir):
            try:
                os.makedirs(cache_dir)
            except Exception:
                pass

        target_template_id = template_id
        expected_sha = template_hash
        template_url = None

        if file_rec:
            target_template_id = target_template_id or file_rec.get("template_id")
            expected_sha = expected_sha or file_rec.get("template_hash")
            template_url = file_rec.get("template_url")

        # Fallback to /api/templates list if target_template_id is not yet provided
        template_meta = None
        if not target_template_id:
            url = self.server_url + "/api/templates"
            status_code, headers, content, err = http_request(url, method="GET", headers=self.auth_headers())
            if status_code == 200 and content:
                try:
                    tmpls = json.loads(content.decode('utf-8'))
                    for t in tmpls:
                        if str(t.get("model", "")).strip().upper() == str(model or "").strip().upper() and t.get("type") == file_type:
                            template_meta = t
                            target_template_id = t.get("id")
                            expected_sha = expected_sha or t.get("file_hash")
                            break
                    # Strict exact match only - do NOT fallback to substring matching (XP-04, X64-03)
                except Exception:
                    pass

        if not target_template_id:
            raise ValueError("[TEMPLATE_ERROR] 无法确定型号 %s (%s) 对应的模板 ID，且执行端已禁止模糊匹配 (XP-04)" % (str(model), str(file_type)))

        # Use safe ASCII filename (tmpl_id + ext) to avoid XP CP936 path encoding issues
        safe_cache_filename = "%s.doc" % str(target_template_id)
        local_tmpl_path = os.path.join(cache_dir, safe_cache_filename)

        # 1. Cache verification (C04 / XP-05): Check existence, size, non-HTML, and SHA256 integrity
        if os.path.exists(local_tmpl_path):
            file_sz = os.path.getsize(local_tmpl_path)
            is_valid_cache = False
            if file_sz > 0:
                try:
                    with open(local_tmpl_path, "rb") as f_head:
                        head = f_head.read(64)
                    head_clean = head.strip()
                    if not head_clean.startswith(b"<") and not head_clean.startswith(b"{"):
                        if expected_sha:
                            actual_sha = get_file_sha256(local_tmpl_path)
                            if actual_sha == expected_sha:
                                is_valid_cache = True
                            else:
                                sys.stderr.write("[Worker] Cache SHA256 mismatch for %s, invalidating.\n" % safe_cache_filename)
                                try:
                                    os.remove(local_tmpl_path)
                                except Exception:
                                    pass
                        else:
                            is_valid_cache = True
                    else:
                        sys.stderr.write("[Worker] Corrupted HTML/JSON cache detected for %s, deleting.\n" % safe_cache_filename)
                        try:
                            os.remove(local_tmpl_path)
                        except Exception:
                            pass
                except Exception:
                    pass
            else:
                try:
                    os.remove(local_tmpl_path)
                except Exception:
                    pass

            if is_valid_cache:
                return {
                    "id": target_template_id,
                    "filepath": local_tmpl_path,
                    "field_mappings": (template_meta or {}).get("field_mappings") or {}
                }

        # 2. Download from coordinator server (C01 / XP-02 / XP-04): Task-scoped endpoint preferred
        if template_url:
            dl_url = self.server_url + str(template_url)
        elif task and task.get("id"):
            dl_url = self.server_url + "/api/worker/tasks/%s/templates/%s" % (str(task["id"]), str(file_type))
        else:
            dl_url = self.server_url + "/api/templates/%s/download" % str(target_template_id)

        dl_code, dl_headers, dl_content, dl_err = http_request(dl_url, method="GET", headers=self.auth_headers())
        if dl_code != 200:
            sys.stderr.write(safe_str(u"[Worker] Template download failed for %s: HTTP %s (url: %s, err: %s)\n" % (to_unicode(target_template_id), to_unicode(dl_code), to_unicode(dl_url), to_unicode(dl_err))))
            raise RuntimeError("[TEMPLATE_DOWNLOAD_FAILED] HTTP %s downloading template %s from %s (XP-04)" % (str(dl_code), str(target_template_id), str(dl_url)))

        if not dl_content or len(dl_content) == 0:
            raise RuntimeError("[TEMPLATE_DOWNLOAD_FAILED] Downloaded 0 bytes for template %s (XP-04)" % str(target_template_id))

        head_check = dl_content[:64].strip()
        if head_check.startswith(b"<") or head_check.startswith(b"{"):
            raise RuntimeError("[TEMPLATE_DOWNLOAD_FAILED] Downloaded template content is HTML/JSON error page (XP-05)")

        downloaded_sha = hashlib.sha256(dl_content).hexdigest()
        header_sha = dl_headers.get("x-template-hash") or dl_headers.get("x-file-hash")
        final_expected_sha = expected_sha or header_sha
        if final_expected_sha and len(final_expected_sha) == 64 and downloaded_sha != final_expected_sha:
            raise RuntimeError("[TEMPLATE_DOWNLOAD_FAILED] Downloaded template SHA256 mismatch (got %s, expected %s) (XP-05)" % (downloaded_sha, final_expected_sha))

        # Atomic write via temp file
        tmp_path = local_tmpl_path + ".tmp_%d" % int(time.time() * 1000)
        with open(tmp_path, "wb") as f_tmp:
            f_tmp.write(dl_content)

        if os.path.exists(local_tmpl_path):
            try:
                os.remove(local_tmpl_path)
            except Exception:
                pass
        try:
            os.rename(tmp_path, local_tmpl_path)
        except Exception:
            # Fallback for Windows if rename fails over existing
            with open(local_tmpl_path, "wb") as f_out:
                f_out.write(dl_content)
            try:
                os.remove(tmp_path)
            except Exception:
                pass

        return {
            "id": target_template_id,
            "filepath": local_tmpl_path,
            "field_mappings": (template_meta or {}).get("field_mappings") or {}
        }

    def upload_returned_file(self, task_id, file_type, official_filename, file_path, sha256_val):
        url = self.server_url + "/api/worker/tasks/%s/file-returned" % str(task_id)
        
        with open(file_path, "rb") as f:
            file_bytes = f.read()

        boundary = "----XPWorkerBoundary" + generate_random_hex(16)
        body = bytearray()

        fields = [
            ("fileType", file_type),
            ("officialFilename", official_filename),
            ("sha256", sha256_val or get_file_sha256(file_path)),
            ("workerFilePath", file_path)
        ]

        for name, val in fields:
            body.extend(("--" + boundary + "\r\n").encode('utf-8'))
            body.extend(('Content-Disposition: form-data; name="%s"\r\n\r\n' % name).encode('utf-8'))
            body.extend((to_unicode(val) + u"\r\n").encode('utf-8'))

        body.extend(("--" + boundary + "\r\n").encode('utf-8'))
        disp = u'Content-Disposition: form-data; name="wordFile"; filename="%s"\r\n' % to_unicode(official_filename)
        body.extend(disp.encode('utf-8'))
        body.extend(('Content-Type: application/msword\r\n\r\n').encode('utf-8'))
        body.extend(file_bytes)
        body.extend(b"\r\n")
        body.extend(("--" + boundary + "--\r\n").encode('utf-8'))

        headers = self.auth_headers({
            "Content-Type": "multipart/form-data; boundary=" + boundary
        })

        status_code, resp_headers, content, err = http_request(url, method="POST", headers=headers, body=bytes(body))
        return status_code == 200

    def report_file_failed(self, task_id, file_type, error_msg):
        url = self.server_url + "/api/worker/tasks/%s/file-failed" % str(task_id)
        payload = {"fileType": file_type, "errorMsg": to_unicode(error_msg)}
        http_request(url, method="POST", headers=self.auth_headers({"Content-Type": "application/json"}), body=payload)

    def process_task(self, task):
        task_id = task.get("id")
        model = task.get("model")
        device_sn = task.get("device_sn")
        raw_form_data = task.get("form_data")
        if isinstance(raw_form_data, dict):
            form_data = raw_form_data
        else:
            try:
                form_data = json.loads(raw_form_data or "{}")
            except Exception:
                form_data = {}
        files = task.get("files") or []

        for file_rec in files:
            file_type = file_rec.get("file_type")
            try:
                tmpl_obj = self.fetch_template_for_task(model, file_type, file_rec.get("template_id"), file_rec.get("template_hash"), task, file_rec)
                template_path = tmpl_obj.get("filepath")
                raw_fm = file_rec.get("field_mappings") or tmpl_obj.get("field_mappings") or {}
                if isinstance(raw_fm, string_types):
                    try:
                        field_mappings = json.loads(raw_fm)
                    except Exception:
                        field_mappings = {}
                else:
                    field_mappings = raw_fm or {}

                if not template_path or not os.path.exists(template_path):
                    raise ValueError("Template path not found for model %s (%s)" % (model, file_type))

                official_filename = file_rec.get("official_filename")
                target_dir = file_rec.get("target_dir")
                root_dir = file_rec.get("root_dir") or target_dir

                if not target_dir or not str(target_dir).strip():
                    raise ValueError("任务未指定有效保存目标目录，拒绝执行 (WC-21)")

                self.ensure_write_authorized(target_dir, root_dir)

                if not os.path.exists(target_dir):
                    try:
                        os.makedirs(target_dir)
                    except Exception as mErr:
                        raise ValueError("目标目录创建失败 [%s]: %s (DIR-16)" % (target_dir, str(mErr)))

                official_file_path = os.path.join(target_dir, official_filename)

                gen_res = generate_word_document_xp(template_path, official_file_path, {
                    "type": file_type,
                    "formData": form_data,
                    "fieldMappings": field_mappings
                })

                self.upload_returned_file(task_id, file_type, official_filename, official_file_path, gen_res.get("sha256"))

            except Exception as err:
                sys.stderr.write(safe_str(u"Task #%s file %s failed: %s\n" % (to_unicode(task_id), to_unicode(file_type), to_unicode(err))))
                self.report_file_failed(task_id, file_type, err)

    def poll_and_execute_tasks(self):
        url = self.server_url + "/api/worker/tasks/pending?workerId=" + urllib_parse.quote(safe_str(self.worker_id))
        status_code, headers, content, err = http_request(url, method="GET", headers=self.auth_headers())
        if status_code != 200 or not content:
            return

        try:
            tasks = json.loads(content.decode('utf-8'))
        except Exception:
            return

        for task in tasks:
            self.process_task(task)

    def resolve_print_item_path(self, item):
        snapshot_path = item.get("snapshotPath")
        if snapshot_path and os.path.exists(snapshot_path):
            return snapshot_path

        task_id = item.get("taskId")
        file_type = item.get("fileType")
        if task_id and file_type:
            url = self.server_url + "/api/worker/tasks/print-item/%s/file" % str(item.get("id"))
            status_code, headers, content, err = http_request(url, method="GET", headers=self.auth_headers())
            if status_code == 200 and content:
                try:
                    finfo = json.loads(content.decode('utf-8'))
                    direct_path = finfo.get("directPath")
                    if direct_path and os.path.exists(direct_path):
                        return direct_path
                except Exception:
                    pass

            dl_url = self.server_url + "/api/worker/tasks/%s/files/%s/download" % (str(task_id), str(file_type))
            dl_code, dl_headers, dl_content, dl_err = http_request(dl_url, method="GET", headers=self.auth_headers())
            if dl_code == 200 and dl_content:
                copies_dir = os.path.join(self.working_dir, "print_copies")
                if not os.path.exists(copies_dir):
                    try:
                        os.makedirs(copies_dir)
                    except Exception:
                        pass
                dl_path = os.path.join(copies_dir, "%s_%s_%s" % (str(task_id), str(file_type), safe_str(item.get("officialFilename") or "file.doc")))
                with open(dl_path, "wb") as f:
                    f.write(dl_content)
                return dl_path

        return None

    def report_print_item_status(self, job_id, item, status, extra=None):
        if extra is None:
            extra = {}
        url = self.server_url + "/api/print/%s/status" % str(job_id)
        payload = {
            "status": status,
            "fileId": item.get("taskFileId"),
            "fileType": item.get("fileType"),
            "errorMsg": to_unicode(extra.get("errorMsg")),
            "windowsJobId": extra.get("windowsJobId"),
            "printerName": to_unicode(extra.get("printerName"))
        }
        http_request(url, method="POST", headers=self.auth_headers({"Content-Type": "application/json"}), body=payload)

    def process_print_job(self, job):
        printer_name = job.get("printer_name")
        job_id = job.get("id")

        if not is_printer_allowed_xp(printer_name, self.allowed_printers):
            reason = u"打印机 '%s' 未在执行端白名单中" % to_unicode(printer_name)
            for item in job.get("items") or []:
                self.report_print_item_status(job_id, item, "FAILED", {"errorMsg": reason, "printerName": printer_name})
            return

        items = job.get("items") or []
        for item in items:
            self.report_print_item_status(job_id, item, "DISPATCHING", {"printerName": printer_name})
            filePath = self.resolve_print_item_path(item)
            if not filePath:
                self.report_print_item_status(job_id, item, "FAILED", {
                    "errorMsg": u"未找到该任务实际生成的文件 (fileType=%s)" % to_unicode(item.get("fileType")),
                    "printerName": printer_name
                })
                continue

            res = print_document_xp(filePath, printer_name, item.get("copies", 1))
            if res.get("success"):
                w_job_id = res.get("windowsJobIds")[0] if res.get("windowsJobIds") else None
                if res.get("stage") == "SUBMITTED_TO_SPOOLER" and w_job_id:
                    self.report_print_item_status(job_id, item, "SUBMITTED_TO_SPOOLER", {
                        "printerName": printer_name,
                        "windowsJobId": w_job_id
                    })
                else:
                    self.report_print_item_status(job_id, item, "RESULT_UNKNOWN", {
                        "printerName": printer_name,
                        "errorMsg": u"已调用打印能力，但未能取得队列新增证据 (RESULT_UNKNOWN)"
                    })
            else:
                self.report_print_item_status(job_id, item, "FAILED", {
                    "printerName": printer_name,
                    "errorMsg": to_unicode(res.get("error") or "Print failed")
                })

    def poll_and_execute_print_jobs(self):
        url = self.server_url + "/api/print/pending?workerId=" + urllib_parse.quote(safe_str(self.worker_id))
        status_code, headers, content, err = http_request(url, method="GET", headers=self.auth_headers())
        if status_code != 200 or not content:
            return

        try:
            jobs = json.loads(content.decode('utf-8'))
        except Exception:
            return

        for job in jobs:
            self.process_print_job(job)

    def poll_and_execute_w610_tasks(self):
        url = self.server_url + "/api/worker/w610-tasks/pending?workerId=" + urllib_parse.quote(safe_str(self.worker_id))
        status_code, headers, content, err = http_request(url, method="GET", headers=self.auth_headers())
        if status_code != 200 or not content:
            return

        try:
            tasks = json.loads(content.decode('utf-8'))
        except Exception:
            return

        for task in tasks:
            self.process_w610_task(task)

    def process_w610_task(self, task):
        task_id = task.get("id")
        action = task.get("action")
        payload = task.get("payload") or {}
        w610_device = task.get("w610Device") or payload.get("w610Device")

        # COMM-15: Mock mode is ONLY triggered when process-level explicit test switch is ON
        is_mock = bool(self.enable_test_mock or os.environ.get("W610_TEST_MOCK") == "1")

        try:
            if action == "probe":
                devices = payload.get("devices") or []
                fetch_error = None

                if not devices:
                    url = self.server_url + "/api/worker/w610/devices"
                    headers = {"x-worker-id": safe_str(self.worker_id), "x-worker-token": safe_str(self.worker_secret)}
                    sc, h, cnt, e = http_request(url, method="GET", headers=headers)
                    if sc == 200 and cnt:
                        try:
                            devices = json.loads(cnt.decode('utf-8'))
                        except Exception as p_e:
                            fetch_error = "解析 W610 清单失败: " + str(p_e)
                    else:
                        fetch_error = "拉取 W610 清单接口失败: HTTP %d (%s)" % (sc, str(e))

                if fetch_error:
                    self.report_w610_task_result(task_id, "FAILED", None, fetch_error)
                    return

                if not devices:
                    self.report_w610_task_result(task_id, "SUCCESS", {"probeResults": [], "configuredStatus": "UNCONFIGURED", "message": "未配置 W610 设备"})
                    return

                probe_results = []
                for dev in devices:
                    http_ok = False
                    device_ok = False
                    detail = ""

                    if is_mock:
                        http_ok = dev.get("ip") != "0.0.0.0" and dev.get("ip") != "invalid_host"
                        device_ok = http_ok and not dev.get("no_device")
                    else:
                        req_res = poa200_xp.send_w610_request(dev, poa200_xp.CMD_READ_DATA, poa200_xp.ADDR_INFO_DEVICE, timeout_sec=3)
                        if req_res.get("ok"):
                            http_ok = True
                            try:
                                info = poa200_xp.unpack_device_info(req_res.get("dataBuffer"))
                                if info and info.get("SnNo"):
                                    device_ok = True
                                    detail = "真正在线"
                            except Exception:
                                detail = "协议校验失败"
                        else:
                            detail = req_res.get("error") or "网络不通/设备无应答"

                    probe_results.append({
                        "id": dev.get("id"),
                        "name": dev.get("name"),
                        "ip": dev.get("ip"),
                        "port": dev.get("port", 8899),
                        "http_ok": http_ok,
                        "device_ok": device_ok,
                        "status": "ONLINE" if device_ok else ("W610_ONLY" if http_ok else "OFFLINE"),
                        "detail": detail
                    })

                self.report_w610_task_result(task_id, "SUCCESS", {"probeResults": probe_results})
                return

            if not w610_device:
                raise ValueError("缺少目标 W610 设备配置信息")

            if action == "read_device":
                if is_mock:
                    if w610_device.get("ip") == "0.0.0.0" or payload.get("mockFailStage") == "w610_http":
                        raise ValueError("W610 HTTP 连接失败: 无法连接到目标 IP 地址")
                    if payload.get("mockFailStage") == "device_no_response":
                        raise ValueError("W610 后端设备无应答 (超时)")
                    mock_buf = poa200_xp.create_mock_device_info(payload.get("mockDeviceInfo") or {})
                    info = poa200_xp.unpack_device_info(mock_buf)
                else:
                    req_res = poa200_xp.send_w610_request(w610_device, poa200_xp.CMD_READ_DATA, poa200_xp.ADDR_INFO_DEVICE, timeout_sec=5)
                    if not req_res.get("ok"):
                        raise ValueError(req_res.get("error") or "读取设备信息失败")
                    info = poa200_xp.unpack_device_info(req_res.get("dataBuffer"))

                self.report_w610_task_result(task_id, "SUCCESS", {
                    "info": info,
                    "deviceSn": info.get("SnNo"),
                    "outDate": info.get("OutDate")
                })
                return

            if action == "write_and_save":
                new_sn = safe_str(payload.get("deviceSn") or "").strip()
                new_out_date = safe_str(payload.get("outDate") or "").strip()
                root_dir = safe_str(payload.get("rootDir") or "").strip()
                save_mode = payload.get("saveMode") or "direct"

                if not new_sn or not new_out_date:
                    raise ValueError("待写入的序列号与日期不能为空")
                if not root_dir:
                    raise ValueError("未配置设备通信保存根目录 (WC-21)")

                auth = self.fetch_authorizations()
                if not auth.get("ok"):
                    raise ValueError("无法确认执行端有效授权，暂停写入")

                if not os.path.exists(root_dir):
                    try:
                        os.makedirs(root_dir)
                    except Exception as me:
                        raise ValueError("通信保存根目录创建失败 [%s]: %s" % (root_dir, str(me)))

                # P0 Safety Requirement: Re-read complete original 248-byte INFO_DEVICE block before write
                original_buf = None
                original_info = None

                if is_mock:
                    original_buf = poa200_xp.create_mock_device_info(payload.get("mockDeviceInfo") or {})
                    original_info = poa200_xp.unpack_device_info(original_buf)
                else:
                    orig_res = poa200_xp.send_w610_request(w610_device, poa200_xp.CMD_READ_DATA, poa200_xp.ADDR_INFO_DEVICE, timeout_sec=5)
                    if not orig_res.get("ok") or not orig_res.get("dataBuffer") or len(orig_res.get("dataBuffer")) < 248:
                        raise ValueError("写前读取设备原始 INFO_DEVICE 块失败，禁止写入以防数据被破坏: %s" % (orig_res.get("error") or "数据不完整"))
                    original_buf = orig_res.get("dataBuffer")
                    original_info = poa200_xp.unpack_device_info(original_buf)

                # Pack updated device info using original_buf as baseline
                pack_buf = poa200_xp.pack_device_info({"SnNo": new_sn, "OutDate": new_out_date, "ChangeParFlag": 1, "isMock": is_mock}, original_buf)

                # Write SN and OutDate
                self.renew_w610_task_lease(task_id)
                if is_mock:
                    if payload.get("mockFailStage") == "write_timeout":
                        self.report_w610_task_result(task_id, "RESULT_UNKNOWN", {
                            "stage": "WRITE_SENT",
                            "verifiedSn": None
                        }, "写入设备数据超时: W610 无响应 (RESULT_UNKNOWN)")
                        return
                else:
                    write_res = poa200_xp.send_w610_request(w610_device, poa200_xp.CMD_WRITE_DATA, poa200_xp.ADDR_INFO_DEVICE, pack_buf, timeout_sec=5)
                    if not write_res.get("ok"):
                        if write_res.get("stage") == "DEVICE_NO_RESPONSE":
                            self.report_w610_task_result(task_id, "RESULT_UNKNOWN", {
                                "stage": "WRITE_SENT",
                                "verifiedSn": None
                            }, "写入发送后设备超时无响应: %s (RESULT_UNKNOWN)" % str(write_res.get("error")))
                            return
                        raise ValueError("写入设备序列号和日期失败: %s" % write_res.get("error"))
                self.renew_w610_task_lease(task_id)

                # Re-read and verify
                reread_buf = None
                reread_info = None

                if is_mock:
                    if payload.get("mockFailStage") == "reread_mismatch":
                        reread_buf = poa200_xp.create_mock_device_info({"SnNo": "WRONG_SN", "OutDate": new_out_date})
                        reread_info = poa200_xp.unpack_device_info(reread_buf)
                    elif payload.get("mockFailStage") == "reread_timeout":
                        raise ValueError("写入后回读核验超时: 设备未在规定时间内返回数据")
                    else:
                        reread_buf = poa200_xp.pack_device_info({"SnNo": new_sn, "OutDate": new_out_date, "ChangeParFlag": 1, "isMock": True}, original_buf)
                        reread_info = poa200_xp.unpack_device_info(reread_buf)
                else:
                    reread_res = poa200_xp.send_w610_request(w610_device, poa200_xp.CMD_READ_DATA, poa200_xp.ADDR_INFO_DEVICE, timeout_sec=5)
                    if not reread_res.get("ok") or not reread_res.get("dataBuffer") or len(reread_res.get("dataBuffer")) < 248:
                        raise ValueError("写入后回读读取失败: %s" % (reread_res.get("error") or "数据块不完整"))
                    reread_buf = reread_res.get("dataBuffer")
                    reread_info = poa200_xp.unpack_device_info(reread_buf)

                if reread_info.get("SnNo") != new_sn or reread_info.get("OutDate") != new_out_date:
                    raise ValueError("回读核验失败！设备中读取到的序列号/日期与提交值不一致！禁止归档结果！")

                # Verify non-target fields were NOT corrupted
                if reread_info.get("typecode") != original_info.get("typecode") or reread_info.get("typeName") != original_info.get("typeName"):
                    raise ValueError("回读核验失败！设备非目标只读参数 (typecode/typeName) 被修改/破坏！禁止归档结果！")

                # Read full info and O2 calib
                o2_cal_data = None
                o2_read_ok = False
                o2_read_error = None

                if is_mock:
                    if payload.get("mockFailStage") == "o2_read_fail":
                        o2_read_ok = False
                        o2_read_error = "读取 O2 标定数据超时"
                    else:
                        mock_o2 = poa200_xp.create_mock_o2_cal_file()
                        o2_cal_data = poa200_xp.unpack_o2_cal_file(mock_o2)
                        o2_read_ok = True
                else:
                    o2_res = poa200_xp.send_w610_request(w610_device, poa200_xp.CMD_READ_DATA, poa200_xp.ADDR_O2CALFILE, timeout_sec=5)
                    if o2_res.get("ok") and o2_res.get("dataBuffer") and len(o2_res.get("dataBuffer")) >= 204:
                        try:
                            o2_cal_data = poa200_xp.unpack_o2_cal_file(o2_res.get("dataBuffer"))
                            o2_read_ok = True
                        except Exception as o2_e:
                            o2_read_error = "O2 标定解析失败: " + str(o2_e)
                    else:
                        o2_read_error = o2_res.get("error") or "读取 O2 标定数据失败"

                # Save directory
                save_dir = root_dir
                if save_mode == "subfolder":
                    save_dir = os.path.join(root_dir, reread_info.get("SnNo"))
                    if not os.path.exists(save_dir):
                        os.makedirs(save_dir)

                import datetime
                date_str = datetime.datetime.now().strftime("%Y%m%d")
                dev_info_name = "POA200_%s_DeviceInfo_%s.json" % (reread_info.get("SnNo"), date_str)

                if payload.get("mockFailStage") == "save_file_fail":
                    raise ValueError("文件保存失败: 目标磁盘空间不足或无写入权限")

                dev_path = self.save_json_with_conflict_handling(save_dir, dev_info_name, reread_info)
                files_saved = [{"name": dev_info_name, "path": dev_path}]

                # Only save O2 calibration file if O2 read succeeded
                if o2_read_ok and o2_cal_data:
                    o2_calib_name = "POA200_%s_O2Calib_%s.json" % (reread_info.get("SnNo"), date_str)
                    o2_path = self.save_json_with_conflict_handling(save_dir, o2_calib_name, o2_cal_data)
                    files_saved.append({"name": o2_calib_name, "path": o2_path})

                if not o2_read_ok:
                    self.report_w610_task_result(task_id, "FAILED", {
                        "writeOk": True,
                        "rereadOk": True,
                        "o2CalibOk": False,
                        "verifiedSn": reread_info.get("SnNo"),
                        "verifiedOutDate": reread_info.get("OutDate"),
                        "filesSaved": files_saved,
                        "stage": "O2_READ_FAILED"
                    }, "设备修改成功，但读取 O2 标定数据失败: " + str(o2_read_error))
                    return

                self.report_w610_task_result(task_id, "SUCCESS", {
                    "writeOk": True,
                    "rereadOk": True,
                    "o2CalibOk": True,
                    "verifiedSn": reread_info.get("SnNo"),
                    "verifiedOutDate": reread_info.get("OutDate"),
                    "filesSaved": files_saved
                })
                return

            raise ValueError("未知的 W610 任务动作: %s" % action)

        except Exception as e:
            self.report_w610_task_result(task_id, "FAILED", None, str(e))

    def save_json_with_conflict_handling(self, target_dir, filename, data):
        filepath = os.path.join(target_dir, filename)
        if os.path.exists(filepath):
            base_name, ext = os.path.splitext(filename)
            copy_idx = 1
            copy_path = os.path.join(target_dir, "%s-副本(%d)%s" % (base_name, copy_idx, ext))
            while os.path.exists(copy_path):
                copy_idx += 1
                copy_path = os.path.join(target_dir, "%s-副本(%d)%s" % (base_name, copy_idx, ext))
            os.rename(filepath, copy_path)

        content = json.dumps(data, indent=2, ensure_ascii=False)
        if sys.version_info[0] < 3 and isinstance(content, unicode):
            content = content.encode('utf-8')
        elif sys.version_info[0] >= 3:
            content = content.encode('utf-8')

        with open(filepath, 'wb') as f:
            f.write(content)
        return filepath

    def renew_w610_task_lease(self, task_id):
        try:
            url = self.server_url + "/api/worker/w610-tasks/%s/renew-lease" % str(task_id)
            http_request(url, method="POST", headers=self.auth_headers())
        except Exception:
            pass

    def report_w610_task_result(self, task_id, status, result=None, error_msg=None):
        url = self.server_url + "/api/worker/w610-tasks/%s/result" % str(task_id)
        post_body = json.dumps({
            "status": status,
            "result": result or {},
            "errorMsg": error_msg
        }).encode('utf-8')
        http_request(url, method="POST", headers=self.auth_headers({'Content-Type': 'application/json'}), data=post_body)

    def run_cycle(self):
        self.send_heartbeat()
        self.poll_and_execute_directory_checks()
        self.poll_and_execute_w610_tasks()
        self.poll_and_execute_tasks()
        self.poll_and_execute_print_jobs()

    def start(self):
        print("====================================================")
        print(safe_str(u"XP 执行端程序启动成功: %s" % to_unicode(self.name)))
        print("====================================================")
        print(safe_str(u"- 执行端 ID: %s" % to_unicode(self.worker_id)))
        print(safe_str(u"- 协调服务地址: %s" % to_unicode(self.server_url)))
        print(safe_str(u"- 本地工作目录: %s" % to_unicode(self.working_dir)))
        print("- 监听端口: 无（纯客户端模型）")
        print("----------------------------------------------------")

        if self.once:
            self.run_cycle()
            return

        while True:
            try:
                self.run_cycle()
            except Exception as e:
                sys.stderr.write(safe_str(u"Worker cycle error: %s\n" % to_unicode(e)))
            time.sleep(self.interval)

if __name__ == "__main__":
    cli = parse_cli_args()
    if cli.get("diagnose"):
        res = run_diagnose_checks()
        sys.exit(0 if res.get("writeOk") else 1)
    elif cli.get("configure"):
        code = run_interactive_configure()
        sys.exit(code if code is not None else 0)
    else:
        worker = ExecutionWorkerXP()
        worker.start()
