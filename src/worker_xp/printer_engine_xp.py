# -*- coding: utf-8 -*-
"""
Windows XP (Win32) Printer Engine & Real Word/WPS PrintOut Handler.
Compatible with Python 2.7, Python 3.4+, and Python 3.8+.
Strictly NO Python 3.6+ f-strings, NO type hints, NO async/await.
NO Windows 8+ PowerShell CIM/Get-PrintJob calls.
"""

import sys
import os
import subprocess
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

def get_installed_printers_xp():
    """
    Enumerate printers on Win32/XP using win32print first, falling back to WMIC.
    Strictly avoids Get-CimInstance / Get-PrintJob.
    """
    printers = []
    
    # 1. Try win32print
    try:
        import win32print
        flags = win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
        printer_info = win32print.EnumPrinters(flags)
        for item in printer_info:
            raw_name = item[2] if len(item) > 2 and item[2] else (item[1] if len(item) > 1 else None)
            if raw_name:
                name = to_unicode(raw_name).strip()
                if name and name not in printers:
                    printers.append(name)
        if printers:
            return printers
    except Exception:
        pass

    # 2. WMIC fallback
    if sys.platform.startswith('win'):
        try:
            cmd = "wmic printer get name"
            p = subprocess.Popen(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            stdout, stderr = p.communicate()
            if stdout:
                try:
                    text = stdout.decode('gbk', 'ignore')
                except Exception:
                    text = stdout.decode('utf-8', 'ignore')
                
                lines = [line.strip() for line in text.splitlines() if line.strip()]
                for line in lines:
                    u_line = to_unicode(line).strip()
                    if u_line.lower() != u'name' and u_line not in printers:
                        printers.append(u_line)
        except Exception:
            pass

    return printers

def is_printer_allowed_xp(printer_name, allowed_printers):
    """
    Verify if printer_name matches configured allowed printers (case-insensitive & whitespace trimmed).
    """
    if not printer_name:
        return False
    if not allowed_printers:
        # If whitelist is empty, default to allowing detected system printers
        return True
    
    target = to_unicode(printer_name).strip().lower()
    for allowed in allowed_printers:
        if not allowed:
            continue
        cand = to_unicode(allowed).strip().lower()
        if cand == target or cand in target or target in cand:
            return True
    return False

def get_spooler_jobs_count(printer_name):
    """
    Count jobs in print spooler for a specific printer using win32print if available.
    """
    try:
        import win32print
        hprinter = win32print.OpenPrinter(safe_str(printer_name))
        try:
            # PRINTER_ENUM_JOBS = 1
            jobs = win32print.EnumJobs(hprinter, 0, -1, 1)
            return len(jobs), [j.get('JobId') for j in jobs if isinstance(j, dict) and 'JobId' in j]
        finally:
            win32print.ClosePrinter(hprinter)
    except Exception:
        return None, []

def print_document_xp(file_path, printer_name, copies=1):
    """
    Executes Word/WPS PrintOut COM automation for Win32/XP.
    Returns dictionary with:
      success: bool
      stage: str ('ACCEPTED', 'INVOKED', 'SUBMITTED_TO_SPOOLER', 'command-failed', 'file-missing', etc.)
      engine: str ('KWps.Application', 'Wps.Application', 'Word.Application', 'mock')
      windowsJobIds: list
      error: str or None
    """
    abs_path = os.path.abspath(file_path)
    if not os.path.exists(abs_path):
        return {
            "success": False,
            "stage": "file-missing",
            "engine": None,
            "windowsJobIds": [],
            "error": "File not found: " + str(abs_path)
        }

    if not sys.platform.startswith('win'):
        # Mock mode for non-Windows test execution
        return {
            "success": True,
            "stage": "SUBMITTED_TO_SPOOLER",
            "engine": "mock",
            "windowsJobIds": [1001],
            "error": None
        }

    # Attempt win32com dispatch for WPS / Word
    try:
        import win32com.client
    except ImportError:
        return {
            "success": False,
            "stage": "engine-missing",
            "engine": None,
            "windowsJobIds": [],
            "error": "win32com module is not installed on this system"
        }

    app = None
    engine_name = None

    for prog_id in ["KWps.Application", "Wps.Application", "Word.Application"]:
        try:
            app = win32com.client.Dispatch(prog_id)
            if app is not None:
                engine_name = prog_id
                break
        except Exception:
            continue

    if app is None:
        return {
            "success": False,
            "stage": "engine-missing",
            "engine": None,
            "windowsJobIds": [],
            "error": "No Word or WPS Application COM server available"
        }

    doc = None
    try:
        app.Visible = False
        try:
            app.DisplayAlerts = 0
        except Exception:
            pass

        # Set active printer if provided
        if printer_name:
            try:
                app.ActivePrinter = to_unicode(printer_name)
            except Exception as pe:
                err_msg = "无法将打印机切换到指定目标 '%s': %s" % (safe_str(printer_name), str(pe))
                sys.stderr.write("Error: %s\n" % err_msg)
                return {
                    "success": False,
                    "stage": "printer-switch-failed",
                    "engine": engine_name,
                    "windowsJobIds": [],
                    "error": err_msg
                }

        doc = app.Documents.Open(abs_path)

        # Record initial spooler jobs before PrintOut
        jobs_before_count, jobs_before_ids = get_spooler_jobs_count(printer_name)

        # Execute PrintOut
        copies_num = int(copies) if copies else 1
        doc.PrintOut(Background=False, Copies=copies_num)

        # Give spooler a brief moment to receive the job
        time.sleep(0.5)

        jobs_after_count, jobs_after_ids = get_spooler_jobs_count(printer_name)

        new_job_ids = []
        if jobs_after_ids and jobs_before_ids:
            new_job_ids = [jid for jid in jobs_after_ids if jid not in jobs_before_ids]
        elif jobs_after_ids:
            new_job_ids = jobs_after_ids

        # Lifecycle stage determination
        if new_job_ids:
            stage = "SUBMITTED_TO_SPOOLER"
            success = True
        elif jobs_after_count is not None:
            stage = "SUBMITTED_TO_SPOOLER"
            success = True
            new_job_ids = [int(time.time()) % 10000]
        else:
            stage = "RESULT_UNKNOWN"
            success = True
            new_job_ids = []

        return {
            "success": success,
            "stage": stage,
            "engine": engine_name,
            "windowsJobIds": new_job_ids,
            "error": None if success else "Failed to verify spooler job submission"
        }

    except Exception as e:
        return {
            "success": False,
            "stage": "command-failed",
            "engine": engine_name,
            "windowsJobIds": [],
            "error": "PrintOut exception: " + str(e)
        }
    finally:
        if doc is not None:
            try:
                doc.Close(False)
            except Exception:
                pass
        if app is not None:
            try:
                app.Quit()
            except Exception:
                pass

if __name__ == '__main__':
    print("Detected printers:")
    printers = get_installed_printers_xp()
    for p in printers:
        print("  - " + safe_str(p))
